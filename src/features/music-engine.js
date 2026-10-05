// A music service's player as an engine for its new-tab card: the service's own web player (Apple's MusicKit page, Spotify's web
// player) running in one hidden view per Lumen process (features/web-player.js makes and keeps the view, in the user's normal
// session), and a fixed bridge script in it (a bridge module such as features/apple-music-bridge.js: the script, the checks on every
// message it sends and every command main sends). The music plays inside Lumen, so it keeps playing when the new-tab page is left
// and the operating system shows Chromium's media session for it. This file keeps what the card shows (what is playing, search
// results, recent plays and playlists where the service has them, whether the user is signed in) and presses its buttons.
//
// The engine is only loaded when a card asks for its state, and unloaded after a long idle while nothing plays. A desktop app source
// (features/apple-music-native.js) may be a fallback: shown, with its own buttons, when the engine is not playing but the app is.
'use strict';

const AMV = require('./apple-music-view'); // the now-playing card's shared helpers (the card's unavailable shape, art checks, button names)

const UNLOAD_MS = 15 * 60e3; // idle (no card read, nothing pressed, nothing playing) this long: the hidden page is closed
const NO_CARD_UNLOAD_MS = 2 * 60e3; // the same, when no card of this service exists any more
const LISTS_FRESH_MS = 60e3;
const APP_WAIT_MS = 2500; // how long a read waits for the desktop app's answer
const MAX_ART_BYTES = 400e3;
const MAX_THUMBS = 12; // search results with a small picture
const PLAYER_MISSING_MS = 25e3; // signed in but the player's controls never showed up: the service changed its page
const SIGNIN_SIZE = { width: 560, height: 780 };
const RESPOND_MS = 3500; // a button pressed and nothing changed this long after: the player did not respond
const TRACKED = ['play', 'pause', 'next', 'previous', 'playItem']; // the commands whose effect can be told from the state

// deps: { bridge (the service's bridge module), name ('Apple Music'), signInTitle, player (features/web-player.js), native? (a desktop-app source),
//         fetchBytes(url) -> Buffer|null, resizeArt(bytes) -> bytes|null, BrowserWindow?, getParent()? (the browser window, for the sign-in
//         window), onChange() (what the card shows may differ), hasCard()? (is a card of this service configured), isAuthorized()?
//         (true | false | null when the service says so another way than the page, e.g. a cookie), playerMissingMs()? (tests only: a shorter wait
//         before "the service changed its page"), now?, setInterval? }
function createMusicEngine(deps) {
  const now = deps.now || Date.now;
  const { player, bridge } = deps;
  let ready = false; // the page's bridge found the service's player
  let msg = null; // the last state message
  let lastActivity = 0;
  let timer = null;
  let signInWin = null;
  let rid = 0;
  let error = null; // { message, at }: the player's last error, shown for a few seconds
  const lists = { recent: null, playlists: null }; // { items, at, signedOut }
  let listsAskedAt = 0;
  let results = { rid: 0, term: '', items: [], at: 0, pending: false };
  const arts = new Map(); // address -> data: URL ('' when it has none), the last few
  const thumbs = new Map(); // search result picture address -> data: URL
  let lastSource = 'engine';
  let playerMissingSince = 0;
  let lastFlag = false; // the page-changed self-test, as the card last heard it
  let pending = null; // { cmd, before, effect(m), timer, late }: a button pressed whose effect has not shown yet

  const changed = () => { try { deps.onChange?.(); } catch { /* the card keeps what it shows */ } };
  const touch = () => { lastActivity = now(); };
  const caps = bridge.CAPS || {};
  const authState = () => (deps.isAuthorized ? deps.isAuthorized() : (msg ? msg.auth : null));

  // ---- the page ----
  // A command goes to the page as a DOM event run by executeJavaScript with a user gesture, so the click or play() the bridge does
  // inside it has user activation (the way the service's autoplay and "press play first" checks want it; an event relayed from
  // another world has none). The text is the validated command JSON (bridge.cleanCommand), put into the call as a string literal.
  const send = (cmd) => {
    const wc = player.webContents();
    const json = bridge.cleanCommand(cmd);
    if (!wc || !ready || !json) return false;
    try {
      const done = wc.executeJavaScript(`document.dispatchEvent(new CustomEvent('lumen-engine-in', { detail: ${JSON.stringify(json)} }))`, true);
      done?.catch?.(() => {});
      expectEffect(cmd);
      return true;
    } catch { return false; }
  };
  // What a button should change, so that a player that ignores it is noticed: the card then says so (and can show the player).
  function expectEffect(cmd) {
    if (!TRACKED.includes(cmd.cmd)) return;
    const before = msg ? { state: bridge.playbackKind(msg.state), title: msg.item?.title || '', pos: msg.pos || 0 } : { state: 'idle', title: '', pos: 0 };
    const effect = {
      play: (m) => bridge.playbackKind(m.state) === 'playing',
      pause: (m) => bridge.playbackKind(m.state) !== 'playing',
      next: (m) => (m.item?.title || '') !== before.title,
      previous: (m) => (m.item?.title || '') !== before.title || (m.pos || 0) + 3 < before.pos,
      playItem: (m) => bridge.playbackKind(m.state) === 'playing' && ((m.item?.title || '') !== before.title || before.state !== 'playing'),
    }[cmd.cmd];
    if (cmd.cmd === 'play' && before.state === 'playing') return;
    if (cmd.cmd === 'pause' && before.state !== 'playing') return;
    if (pending?.timer) clearTimeout(pending.timer);
    pending = { cmd: cmd.cmd, effect, late: false, timer: null };
    const p = pending;
    p.timer = (deps.setTimeout || setTimeout)(() => { if (pending === p) { p.late = true; changed(); } }, deps.respondMs?.() || RESPOND_MS);
    p.timer.unref?.();
  }
  const unresponsive = () => Boolean(pending && pending.late);
  function askLists(force = false) {
    if (!caps.lists || !ready || (!force && now() - listsAskedAt < LISTS_FRESH_MS)) return;
    listsAskedAt = now();
    send({ cmd: 'list', kind: 'recent', rid: ++rid });
    send({ cmd: 'list', kind: 'playlists', rid: ++rid });
  }
  let page = null; // the web contents the state belongs to: a new page (made again after a crash or an unload) starts from nothing
  function wake() {
    touch();
    player.ensure();
    const wc = player.webContents();
    if (wc !== page) { page = wc; ready = false; msg = null; lists.recent = lists.playlists = null; listsAskedAt = 0; playerMissingSince = 0; pending = null; }
    if (!timer) {
      timer = (deps.setInterval || setInterval)(unloadIfIdle, 60e3);
      timer.unref?.();
    }
  }
  const playing = () => Boolean(msg && bridge.playbackKind(msg.state) === 'playing' && msg.item);
  function unload() {
    ready = false; msg = null; lists.recent = lists.playlists = null; listsAskedAt = 0; results = { rid: 0, term: '', items: [], at: 0, pending: false }; playerMissingSince = 0; pending = null;
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
  // Main.js checks the sender is the engine's own page before this is called.
  function onMessage(raw) {
    const m = bridge.parseMessage(raw);
    if (!m) return;
    if (m.t === 'ready') { ready = true; changed(); return; }
    if (m.t === 'error') { error = { message: m.message, at: now() }; changed(); return; }
    if (m.t === 'state') {
      if (bridge.playbackKind(m.state) === 'seeking') return; // a seek in progress: the card keeps what it shows until the playhead lands
      const was = msg;
      msg = m;
      touch();
      if (pending && pending.effect(m)) { const wasLate = pending.late; clearTimeout(pending.timer); pending = null; if (wasLate) changed(); }
      if (m.player === false && authState() === true) playerMissingSince ||= now(); else playerMissingSince = 0;
      if (m.item?.art && !arts.has(m.item.art)) fetchArt(m.item.art);
      if (m.auth && (!was || !was.auth)) { askLists(true); closeSignIn(); }
      if (!was) askLists(true);
      const flag = pageChanged();
      const flagMoved = flag !== lastFlag;
      lastFlag = flag;
      if (!was || was.auth !== m.auth || was.state !== m.state || was.item?.id !== m.item?.id || was.item?.title !== m.item?.title || was.device !== m.device || was.player !== m.player || flagMoved || Math.abs((was.pos || 0) - m.pos) > 2.5 + (playing() ? 5 : 0)) changed();
      return;
    }
    if (m.t === 'list') {
      if (m.kind === 'search') {
        if (m.rid !== results.rid) return; // an older search
        results = { ...results, items: m.items, at: now(), pending: false, ok: m.ok };
        fetchThumbs(m.items, results.rid);
      } else {
        lists[m.kind] = { items: m.items, at: now(), signedOut: m.signedOut };
      }
      changed();
    }
  }
  const pageChanged = () => Boolean(playerMissingSince && now() - playerMissingSince > (deps.playerMissingMs?.() || PLAYER_MISSING_MS));
  const toData = async (url) => {
    const bytes = await deps.fetchBytes(url);
    if (!bytes || bytes.length > MAX_ART_BYTES) return '';
    const small = deps.resizeArt ? deps.resizeArt(bytes) : bytes;
    return (small && AMV.dataUrl(small)) || '';
  };
  function fetchArt(url) {
    arts.set(url, ''); // asked: not again, whatever comes
    while (arts.size > 8) arts.delete(arts.keys().next().value);
    toData(url).then((data) => { if (data) { arts.set(url, data); changed(); } }).catch(() => {});
  }
  // The small pictures beside search results: asked together (the first few only), then the card is told once.
  function fetchThumbs(items, forRid) {
    const wanted = [...new Set(items.map((i) => i.art).filter((u) => u && !thumbs.has(u)))].slice(0, MAX_THUMBS);
    if (!wanted.length) return;
    for (const u of wanted) thumbs.set(u, '');
    while (thumbs.size > 80) thumbs.delete(thumbs.keys().next().value);
    Promise.all(wanted.map((u) => toData(u).then((d) => { thumbs.set(u, d); }, () => {}))).then(() => { if (forRid === results.rid) changed(); });
  }

  // ---- the card's data ----
  const listCard = (l) => (l ? l.items.slice(0, 8).map((i) => ({ id: i.id, kind: i.kind, title: i.title, sub: i.sub })) : []);
  const resultCard = (items) => items.slice(0, 32).map((i) => ({ id: i.id, kind: i.kind, title: i.title, sub: i.sub, ms: i.ms || 0, thumb: i.art ? thumbs.get(i.art) || '' : '' }));
  function extras(d) {
    const st = player.status();
    const auth = authState();
    return {
      ...d,
      signedIn: auth,
      engine: st.state,
      drm: st.drm,
      can: { search: Boolean(caps.search), lists: Boolean(caps.lists), seek: Boolean(caps.seek), queue: Boolean(caps.queue) },
      recent: listCard(lists.recent),
      playlists: listCard(lists.playlists),
      results: resultCard(results.items),
      searchOk: results.ok !== false,
      query: results.term,
      searching: results.pending,
      error: error && now() - error.at < 8000 ? error.message : '',
      pageChanged: pageChanged(),
      unresponsive: unresponsive(),
    };
  }
  function engineCard() {
    if (!msg) return null;
    const art = msg.item?.art ? arts.get(msg.item.art) || '' : '';
    return bridge.toCard(msg, now(), art);
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
    if (ready && authState() === true) askLists();
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
  function seek(sec) { touch(); return caps.seek && lastSource === 'engine' && send({ cmd: 'seek', sec }); }
  function playItem(kind, id) { touch(); lastSource = 'engine'; return send({ cmd: 'playItem', kind, id }); }
  const queueItem = (cmd, kind, id) => { touch(); return Boolean(caps.queue) && send({ cmd, kind, id }); };
  function search(term) {
    touch();
    if (!caps.search) return false;
    const clean = bridge.clip(term, 80);
    if (!clean) { results = { rid: ++rid, term: '', items: [], at: 0, pending: false }; changed(); return true; }
    const prev = results;
    results = { rid: ++rid, term: clean, items: [], at: 0, pending: true };
    const ok = send({ cmd: 'search', term: clean, rid: results.rid });
    if (!ok) results = prev; // not ready: nothing was asked, the card keeps what it had
    return ok;
  }
  function refreshLists() { touch(); askLists(true); }

  // ---- signing in ----
  // The engine's own page in a window of its own: the user signs in on the service's page, as on any site, and the window closes by
  // itself once the service says it is signed in. Lumen never sees the account's password.
  function openWindow(title) {
    wake();
    if (signInWin && !signInWin.isDestroyed()) { signInWin.focus(); return true; }
    if (!deps.BrowserWindow) return false;
    const parent = deps.getParent?.();
    const win = new deps.BrowserWindow({ ...SIGNIN_SIZE, title, autoHideMenuBar: true, show: true, ...(parent && !parent.isDestroyed() ? { parent } : {}) });
    signInWin = win;
    try { win.removeMenu?.(); } catch { /* no menu to remove */ }
    const fit = () => { if (win.isDestroyed()) return; const [width, height] = win.getContentSize(); player.showIn(win, { x: 0, y: 0, width, height }); };
    fit();
    win.on('resize', fit);
    win.on('close', () => { player.release(); if (signInWin === win) signInWin = null; changed(); });
    return true;
  }
  const signIn = () => openWindow(deps.signInTitle || 'Sign in');
  // The player itself in a small window (when a button did nothing): the user can press its own controls, which also gives it the
  // activation a service may want before it plays. It closes like the sign-in window, and the card hears about it.
  function showPlayer() { pending = null; const ok = openWindow(`${deps.name || 'Music'} player`); changed(); return ok; }
  function closeSignIn() {
    const win = signInWin;
    if (win && !win.isDestroyed()) win.close();
  }
  // The service said (not through the page: a cookie) that the user is signed in or out now.
  function authChanged() {
    if (authState() === true) { closeSignIn(); askLists(true); }
    changed();
  }

  return {
    read, control, seek, playItem, playNext: (kind, id) => queueItem('playNext', kind, id), playLater: (kind, id) => queueItem('playLater', kind, id),
    search, signIn, showPlayer, refreshLists, onMessage, wake, unload, authChanged,
    status: () => ({ ...player.status(), ready, signedIn: authState(), playing: playing() }),
    signedIn: authState,
    isPlaying: playing,
    destroy() { closeSignIn(); clearInterval(timer); timer = null; player.destroy(); },
    reload() { player.ensure(); player.reload(); },
    signInOpen: () => Boolean(signInWin && !signInWin.isDestroyed()),
  };
}

module.exports = { createMusicEngine, UNLOAD_MS };
