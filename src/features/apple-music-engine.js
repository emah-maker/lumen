// The Apple Music widget's engine: Apple's own MusicKit JS, running in one hidden music.apple.com view (features/web-player.js
// makes and keeps the view, in the user's normal session; features/apple-music-bridge.js is the script that reports MusicKit's
// state and the checks on every message). The music plays inside Lumen, so it keeps playing when the new-tab page is left, the
// OS shows Chromium's media session for it, and no Apple Music app is needed. This file keeps what the card shows: what is
// playing, "recently played", the user's playlists, search results, whether the user is signed in; and presses its buttons.
//
// The engine is only loaded when an Apple Music card asks for its state, and unloaded after a long idle while nothing plays.
// The desktop Apple Music app (features/apple-music-native.js, Windows media sessions or the Music app on a Mac) is a
// fallback: shown, with its own buttons, when the engine is not playing but the app is.
'use strict';

const AMB = require('./apple-music-bridge');
const AMV = require('./apple-music-view');

const UNLOAD_MS = 15 * 60e3; // idle (no card read, nothing pressed, nothing playing) this long: the hidden page is closed
const NO_CARD_UNLOAD_MS = 2 * 60e3; // the same, when no Apple Music card exists any more
const LISTS_FRESH_MS = 60e3;
const APP_WAIT_MS = 2500; // how long a read waits for the desktop app's answer
const MAX_ART_BYTES = 400e3;
const SIGNIN_SIZE = { width: 560, height: 780 };

// deps: { player (features/web-player.js), native? (features/apple-music-native.js), fetchBytes(url) -> Buffer|null, resizeArt(bytes) -> bytes|null,
//         BrowserWindow?, getParent()? (the browser window, for the sign-in window), onChange() (what the card shows may differ),
//         hasCard()? (is an Apple Music card configured), now?, setInterval? }
function createEngine(deps) {
  const now = deps.now || Date.now;
  const { player } = deps;
  let ready = false; // MusicKit's instance was found
  let msg = null; // the last state message
  let lastActivity = 0;
  let timer = null;
  let signInWin = null;
  let rid = 0;
  let error = null; // { message, at }: MusicKit's last playback error, shown for a few seconds
  const lists = { recent: null, playlists: null }; // { items, at, signedOut }
  let listsAskedAt = 0;
  let results = { rid: 0, term: '', items: [], at: 0, pending: false };
  const arts = new Map(); // address -> data: URL ('' when it has none), the last few
  let lastSource = 'engine';

  const changed = () => { try { deps.onChange?.(); } catch { /* the card keeps what it shows */ } };
  const touch = () => { lastActivity = now(); };

  // ---- the page ----
  const send = (cmd) => {
    const wc = player.webContents();
    const json = AMB.cleanCommand(cmd);
    if (!wc || !ready || !json) return false;
    try { wc.send('amusic:cmd', json); return true; } catch { return false; }
  };
  function askLists(force = false) {
    if (!ready || (!force && now() - listsAskedAt < LISTS_FRESH_MS)) return;
    listsAskedAt = now();
    send({ cmd: 'list', kind: 'recent', rid: ++rid });
    send({ cmd: 'list', kind: 'playlists', rid: ++rid });
  }
  let page = null; // the web contents the state belongs to: a new page (made again after a crash or an unload) starts from nothing
  function wake() {
    touch();
    player.ensure();
    const wc = player.webContents();
    if (wc !== page) { page = wc; ready = false; msg = null; lists.recent = lists.playlists = null; listsAskedAt = 0; }
    if (!timer) {
      timer = (deps.setInterval || setInterval)(unloadIfIdle, 60e3);
      timer.unref?.();
    }
  }
  const playing = () => Boolean(msg && AMB.playbackKind(msg.state) === 'playing' && msg.item);
  function unload() {
    ready = false; msg = null; lists.recent = lists.playlists = null; listsAskedAt = 0; results = { rid: 0, term: '', items: [], at: 0, pending: false };
    player.destroy();
    clearInterval(timer);
    timer = null;
  }
  function unloadIfIdle() {
    if (!player.webContents() || playing() || signInWin) return;
    const idle = now() - lastActivity;
    if (idle > UNLOAD_MS || (deps.hasCard && !deps.hasCard() && idle > NO_CARD_UNLOAD_MS)) unload();
  }

  // ---- what the page tells us ----
  // `sender`: the engine's own web contents, checked by main.js before this is called.
  function onMessage(raw) {
    const m = AMB.parseMessage(raw);
    if (!m) return;
    if (m.t === 'ready') { ready = true; changed(); return; }
    if (m.t === 'error') { error = { message: m.message, at: now() }; changed(); return; }
    if (m.t === 'state') {
      if (AMB.playbackKind(m.state) === 'seeking') return; // a seek in progress: the card keeps what it shows until the playhead lands
      const was = msg;
      msg = m;
      touch();
      if (m.item?.art && !arts.has(m.item.art)) fetchArt(m.item.art);
      if (m.auth && (!was || !was.auth)) { askLists(true); closeSignIn(); }
      if (!was) askLists(true);
      if (!was || was.auth !== m.auth || was.state !== m.state || was.item?.id !== m.item?.id || was.item?.title !== m.item?.title || Math.abs((was.pos || 0) - m.pos) > 2.5 + (playing() ? 5 : 0)) changed();
      return;
    }
    if (m.t === 'list') {
      if (m.kind === 'search') {
        if (m.rid !== results.rid) return; // an older search
        results = { ...results, items: m.items, at: now(), pending: false };
      } else {
        lists[m.kind] = { items: m.items, at: now(), signedOut: m.signedOut };
      }
      changed();
    }
  }
  function fetchArt(url) {
    arts.set(url, ''); // asked: not again, whatever comes
    while (arts.size > 8) arts.delete(arts.keys().next().value);
    Promise.resolve().then(() => deps.fetchBytes(url)).then((bytes) => {
      if (!bytes || bytes.length > MAX_ART_BYTES) return;
      const small = deps.resizeArt ? deps.resizeArt(bytes) : bytes;
      const data = small ? AMV.dataUrl(small) : null;
      if (data) { arts.set(url, data); changed(); }
    }).catch(() => {});
  }

  // ---- the card's data ----
  const listCard = (l) => (l ? l.items.slice(0, 8).map((i) => ({ id: i.id, kind: i.kind, title: i.title, sub: i.sub })) : []);
  function extras(d) {
    const st = player.status();
    return {
      ...d,
      signedIn: msg ? msg.auth : null,
      engine: st.state,
      drm: st.drm,
      recent: listCard(lists.recent),
      playlists: listCard(lists.playlists),
      results: listCard({ items: results.items }),
      query: results.term,
      searching: results.pending,
      error: error && now() - error.at < 8000 ? error.message : '',
    };
  }
  function engineCard() {
    if (!msg) return null;
    const art = msg.item?.art ? arts.get(msg.item.art) || '' : '';
    return AMB.toCard(msg, now(), art);
  }
  // What the card shows now: the engine when it is playing (or paused on something), else the desktop app when it is playing,
  // else the idle card with the lists and the search.
  async function read({ app = true } = {}) {
    wake();
    const st = player.status();
    const e = engineCard();
    if (e && (e.state === 'playing' || e.state === 'paused')) { lastSource = 'engine'; return extras(e); }
    let appCard = null;
    if (app && deps.native) {
      appCard = await Promise.race([deps.native.read().catch(() => null), new Promise((r) => setTimeout(() => r(null), APP_WAIT_MS))]);
      if (appCard && (appCard.state === 'playing' || appCard.state === 'paused')) { lastSource = 'app'; return { ...extras(appCard), source: 'app' }; }
    }
    lastSource = 'engine';
    if (!msg && (st.state === 'offline' || st.state === 'failed')) return AMV.unavailable(st.state, now());
    if (ready && deps.freshLists !== false && msg?.auth) askLists();
    return { ...extras({ mode: 'status', state: 'idle', title: '', artist: '', album: '', progressMs: 0, durationMs: 0, at: 0, source: 'engine', kind: 'none', reason: ready ? '' : 'loading', art: '' }), appDenied: appCard?.reason === 'denied' };
  }

  // ---- the card's buttons ----
  // Press play, pause, next or previous on whatever the card is showing (the engine, or the desktop app when it was the one shown).
  async function control(name) {
    const action = AMV.actionOf(name);
    if (!action) return false;
    touch();
    if (lastSource === 'app' && deps.native) return deps.native.control(action);
    return send({ cmd: action });
  }
  function seek(sec) { touch(); return lastSource === 'engine' && send({ cmd: 'seek', sec }); }
  function playItem(kind, id) { touch(); lastSource = 'engine'; return send({ cmd: 'playItem', kind, id }); }
  function search(term) {
    touch();
    const clean = AMB.clip(term, 80);
    if (!clean) { results = { rid: ++rid, term: '', items: [], at: 0, pending: false }; changed(); return true; }
    const prev = results;
    results = { rid: ++rid, term: clean, items: [], at: 0, pending: true };
    const ok = send({ cmd: 'search', term: clean, rid: results.rid });
    if (!ok) results = prev; // not ready: nothing was asked, the card keeps what it had
    return ok;
  }
  function refreshLists() { touch(); askLists(true); }

  // ---- signing in ----
  // The engine's own page in a window of its own: the user clicks Apple's Sign in on it, as on any site, and the window closes by
  // itself once MusicKit says it is authorized (authorizationStatusDidChange). Lumen never sees the Apple ID or its password.
  function signIn() {
    wake();
    if (signInWin && !signInWin.isDestroyed()) { signInWin.focus(); return true; }
    if (!deps.BrowserWindow) return false;
    const parent = deps.getParent?.();
    const win = new deps.BrowserWindow({ ...SIGNIN_SIZE, title: 'Sign in to Apple Music', autoHideMenuBar: true, show: true, ...(parent && !parent.isDestroyed() ? { parent } : {}) });
    signInWin = win;
    try { win.removeMenu?.(); } catch { /* no menu to remove */ }
    const fit = () => { if (win.isDestroyed()) return; const [width, height] = win.getContentSize(); player.showIn(win, { x: 0, y: 0, width, height }); };
    fit();
    win.on('resize', fit);
    win.on('close', () => { player.release(); if (signInWin === win) signInWin = null; changed(); });
    return true;
  }
  function closeSignIn() {
    const win = signInWin;
    if (win && !win.isDestroyed()) win.close();
  }

  return {
    read, control, seek, playItem, search, signIn, refreshLists, onMessage, wake, unload,
    status: () => ({ ...player.status(), ready, signedIn: msg ? msg.auth : null, playing: playing() }),
    signedIn: () => (msg ? msg.auth : null),
    isPlaying: playing,
    destroy() { closeSignIn(); clearInterval(timer); timer = null; player.destroy(); },
    reload() { player.ensure(); player.reload(); },
    signInOpen: () => Boolean(signInWin && !signInWin.isDestroyed()),
  };
}

module.exports = { createEngine, UNLOAD_MS };
