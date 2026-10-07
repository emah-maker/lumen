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
const SEARCH_MS = 20e3; // a search with no answer this long after it was asked ends as "no answer" (the page's own wait is shorter; this is for a page that went away)
const QUEUE_MS = 20e3; // a button pressed (or a search typed) while the page is still starting is sent when its bridge is ready, if that is this soon

// deps: { bridge (the service's bridge module), name ('Apple Music'), signInTitle, player (features/web-player.js), native? (a desktop-app source),
//         fetchBytes(url) -> Buffer|null, resizeArt(bytes) -> bytes|null, BrowserWindow?, (the sign-in
//         window is its own top-level window, never owned by the browser window), onChange() (what the card shows may differ), hasCard()? (is a card of this service configured), isAuthorized()?
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
  let results = { rid: 0, term: '', items: [], at: 0, pending: false, why: '', detail: '' };
  let searchCmd = null; // { cmd, at, gen }: the search asked last, kept until it is answered, so a new document of the page (a full navigation) is asked again
  const arts = new Map(); // address -> data: URL ('' when it has none), the last few
  const thumbs = new Map(); // search result picture address -> data: URL
  let lastSource = 'engine';
  let playerMissingSince = 0;
  let lastFlag = false; // the page-changed self-test, as the card last heard it
  let pending = null; // { cmd, before, effect(m), timer, late }: a button pressed whose effect has not shown yet
  let readyGen = -1; // the page document (player.generation()) whose bridge said ready
  let queued = { control: null, search: null }; // { cmd, at }: what was asked before the bridge was ready (the latest of each kind)

  const changed = () => { try { deps.onChange?.(); } catch { /* the card keeps what it shows */ } };
  const touch = () => { lastActivity = now(); };
  const caps = bridge.CAPS || {};
  // Signed in or out: the page's own word wins when it has one (a Log in button on the page: the session ended, whatever the cookie says), then the service's
  // other way of knowing (Spotify's cookie), then the page's account claim.
  const authState = () => (msg && msg.signedOut === true ? false : deps.isAuthorized ? deps.isAuthorized() : (msg ? msg.auth : null));

  // ---- the page ----
  // A command goes to the page as a DOM event run by executeJavaScript with a user gesture, so the click or play() the bridge does
  // inside it has user activation (the way the service's autoplay and "press play first" checks want it; an event relayed from
  // another world has none). The text is the validated command JSON (bridge.cleanCommand), put into the call as a string literal.
  // Is the bridge that said ready still the one in the page? A reload or a sign-in round trip makes a new document, with a new bridge to wait for.
  const bridgeUp = () => {
    if (ready && player.generation && player.generation() !== readyGen) ready = false;
    return ready;
  };
  const send = (cmd) => {
    const wc = player.webContents();
    const json = bridge.cleanCommand(cmd);
    if (!wc || !bridgeUp() || !json) return false;
    try {
      const done = wc.executeJavaScript(`document.dispatchEvent(new CustomEvent('lumen-engine-in', { detail: ${JSON.stringify(json)} }))`, true);
      done?.catch?.(() => {});
      if (cmd.cmd === 'search' && searchCmd && searchCmd.cmd.rid === cmd.rid) searchCmd.gen = player.generation ? player.generation() : 0;
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
  // A command that can't go yet (the page is loading: after an idle unload, a reload or a sign-in): kept, the latest of its kind, and sent
  // when the bridge says ready. Returns whether it was sent or kept (false: not a command, or nothing to send it to).
  function sendOrQueue(cmd, kind) {
    if (send(cmd)) return true;
    if (!bridge.cleanCommand(cmd)) return false;
    wake(); // (an engine unloaded after an idle: its page starts again)
    if (!player.webContents()) return false;
    queued[kind] = { cmd, at: now() };
    return true;
  }
  function flushQueue() {
    expireQueue();
    const q = queued;
    queued = { control: null, search: null };
    for (const kind of ['search', 'control']) if (q[kind]) send(q[kind].cmd); // (a search first: playing an item navigates last, so it wins)
  }
  // A search asked of a page document that has since been replaced (a full navigation, a reload, a sign-in round trip) is asked again of the new one.
  function resumeSearch() {
    if (!results.pending || !searchCmd || searchCmd.cmd.rid !== results.rid || now() - searchCmd.at > SEARCH_MS) return;
    if (searchCmd.gen === readyGen) return; // (the document it was asked of is this one: it is on it)
    send(searchCmd.cmd);
  }
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
    expireQueue();
    if (!timer) {
      timer = (deps.setInterval || setInterval)(unloadIfIdle, 60e3);
      timer.unref?.();
    }
  }
  // A search kept for a page that never became ready, or asked and never answered, says so (the card stops saying "Searching…"); a kept button just goes.
  function expireQueue() {
    if (results.pending && searchCmd && results.rid === searchCmd.cmd.rid && now() - searchCmd.at > SEARCH_MS) { results = { ...results, pending: false, ok: false, why: 'timeout', detail: 'no answer from the page' }; searchCmd = null; changed(); }
    for (const kind of ['search', 'control']) {
      const item = queued[kind];
      if (!item || now() - item.at <= QUEUE_MS) continue;
      queued[kind] = null;
      if (kind === 'search' && results.rid === item.cmd.rid && results.pending) { results = { ...results, pending: false, ok: false, why: 'timeout', detail: 'the page was not ready' }; changed(); }
    }
  }
  const playing = () => Boolean(msg && bridge.playbackKind(msg.state) === 'playing' && msg.item);
  function unload() {
    ready = false; msg = null; lists.recent = lists.playlists = null; listsAskedAt = 0; results = { rid: 0, term: '', items: [], at: 0, pending: false, why: '', detail: '' }; searchCmd = null; playerMissingSince = 0; pending = null;
    queued = { control: null, search: null };
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
    if (m.t === 'ready') { ready = true; readyGen = player.generation ? player.generation() : 0; flushQueue(); resumeSearch(); changed(); return; }
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
      if (m.signedOut === false && was && was.signedOut === true) { closeSignIn(); askLists(true); } // (the page itself shows the player instead of Log in: signed in again)
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
        results = { ...results, items: m.items, at: now(), pending: false, ok: m.ok, why: m.ok ? '' : (m.why || 'page'), detail: m.ok ? '' : (m.detail || '') };
        if (m.ok === false || m.items.length) searchCmd = null;
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
      searchWhy: results.ok === false ? results.why || '' : '',
      searchDetail: results.ok === false ? results.detail || '' : '',
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
  // `wake: false`: look at what is already known without starting the hidden page (a page nobody can see asked: main.js).
  async function read({ app = true, wake: start = true } = {}) {
    if (start) wake();
    else app = false;
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
    return sendOrQueue({ cmd: action }, 'control');
  }
  function seek(sec) { touch(); return Boolean(caps.seek) && lastSource === 'engine' && sendOrQueue({ cmd: 'seek', sec }, 'control'); }
  function playItem(kind, id) { touch(); lastSource = 'engine'; return sendOrQueue({ cmd: 'playItem', kind, id }, 'control'); }
  const queueItem = (cmd, kind, id) => { touch(); return Boolean(caps.queue) && send({ cmd, kind, id }); };
  function search(term) {
    touch();
    if (!caps.search) return false;
    const clean = bridge.clip(term, 80);
    if (!clean) { queued.search = null; searchCmd = null; results = { rid: ++rid, term: '', items: [], at: 0, pending: false, why: '', detail: '' }; changed(); return true; }
    results = { rid: ++rid, term: clean, items: [], at: 0, pending: true, why: '', detail: '' };
    const cmd = { cmd: 'search', term: clean, rid: results.rid };
    searchCmd = { cmd, at: now(), gen: -1 };
    const ok = sendOrQueue(cmd, 'search'); // (a page still loading gets it once its bridge is ready)
    if (!ok) { searchCmd = null; results = { rid: results.rid, term: clean, items: [], at: now(), pending: false, ok: false, why: 'page', detail: '' }; } // nothing to ask: the card says the search got no answer, not "Searching…" for ever
    changed(); // the card shows "Searching…" for this term now, not only once the answer comes
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
    const win = new deps.BrowserWindow({ ...SIGNIN_SIZE, title, autoHideMenuBar: true, show: true }); // (no `parent`: an owned window stays above the browser window on Windows; this one is a window of its own, as a sign-in popup is in Chrome)
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
