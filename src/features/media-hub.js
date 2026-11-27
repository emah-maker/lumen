// Media controls: the toolbar's media button and its pop-up (renderer/media-hub.js), and the keyboard's media keys.
// Every web frame runs preload/media-hub-preload.js, which reports what its <audio>/<video> elements and the page's Media
// Session (navigator.mediaSession: title, artist, artwork, the previous/next handlers it set) are doing. This keeps one
// record per page (webContents), merges its frames, and lists the tabs with something playing or paused mid-way, the
// last one to start playing first. A tab that only makes sound some other way (Web Audio: a game) is listed too, with
// mute and "go to tab" only. Play/pause, previous and next go back to the frame that can do them; mute is the tab's own
// (features/tab-tools.js), the same as the speaker on the tab.
// The media keys (play/pause, next, previous, stop) are Lumen's while something is listed and go to the last-played
// page, a tab or not (the Spotify card's hidden player counts). Chromium's own media-key handling is off (main.js) so a key
// press is never handled twice.

const ACTIONS = ['play', 'pause', 'previoustrack', 'nexttrack', 'stop'];
const KEYS = { MediaPlayPause: 'playpause', MediaNextTrack: 'nexttrack', MediaPreviousTrack: 'previoustrack', MediaStop: 'stop' };

const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
const imageUrl = (v) => (typeof v === 'string' && v.length <= 2048 && /^(https?:|data:image\/)/i.test(v) ? v : '');

// A frame's report (a JSON string from a page: untrusted), reduced to what the pop-up shows.
function parseReport(json) {
  let r;
  try { r = typeof json === 'string' && json.length <= 16384 ? JSON.parse(json) : null; } catch { r = null; }
  if (!r || typeof r !== 'object') return null;
  const meta = r.meta && typeof r.meta === 'object' ? r.meta : {};
  return {
    playing: r.playing === true,
    resumable: r.resumable === true,
    title: str(meta.title).trim(),
    artist: str(meta.artist).trim(),
    album: str(meta.album).trim(),
    artwork: imageUrl(meta.artwork),
    actions: Array.isArray(r.actions) ? ACTIONS.filter((a) => r.actions.includes(a)) : [],
  };
}

// One page's frames merged: playing if any frame plays; the page's (top frame's) metadata first, else a frame that has some.
function merge(frames) {
  const list = [...frames.values()];
  if (!list.length) return null;
  const top = list.find((f) => f.top) || null;
  const withMeta = (top && top.s.title ? top : null) || list.find((f) => f.s.title) || null;
  const actions = new Set(list.flatMap((f) => f.s.actions));
  return {
    playing: list.some((f) => f.s.playing),
    resumable: list.some((f) => f.s.resumable),
    title: withMeta?.s.title || '',
    artist: withMeta?.s.artist || '',
    album: withMeta?.s.album || '',
    artwork: withMeta?.s.artwork || list.find((f) => f.s.artwork)?.s.artwork || '',
    canPrev: actions.has('previoustrack'),
    canNext: actions.has('nexttrack'),
  };
}

// The frames a command goes to. Previous/next: the frames whose page set that handler. Pause/stop: every playing frame.
// Play: the frame that played last.
function targets(frames, action) {
  const list = [...frames.values()];
  if (action === 'previoustrack' || action === 'nexttrack') return list.filter((f) => f.s.actions.includes(action)).slice(0, 1);
  if (action === 'pause' || action === 'stop') return list.filter((f) => f.s.playing);
  if (action === 'play') {
    const ready = list.filter((f) => f.s.resumable || f.s.actions.includes('play')).sort((a, b) => b.playedAt - a.playedAt);
    return ready.slice(0, 1);
  }
  return [];
}

function create({ tabOf, tabFields, setMuted, show, audibleTabs = () => [], onList = () => {}, keys = null, now = () => Date.now() }) {
  const pages = new Map(); // webContents -> { frames: Map(key -> { frame, top, s, playedAt }), playedAt }
  let pushTimer = null;
  let keysOn = false;

  function forget(wc) { if (pages.delete(wc)) changed(); }

  function pageOf(wc) {
    let page = pages.get(wc);
    if (page) return page;
    page = { frames: new Map(), playedAt: 0 };
    pages.set(wc, page);
    wc.once('destroyed', () => forget(wc));
    // A new page in the tab starts with nothing; a frame that went somewhere else drops its own report (its new page sends a new one).
    wc.on('did-navigate', () => { const p = pages.get(wc); if (p) { p.frames.clear(); changed(); } });
    wc.on('did-frame-navigate', (_e, _url, _code, _status, isMainFrame, processId, routingId) => {
      const p = pages.get(wc);
      if (!isMainFrame && p?.frames.delete(`${processId}:${routingId}`)) changed();
    });
    return page;
  }

  // From a frame's preload ('media-hub:report').
  function report(event, json) {
    const wc = event?.sender;
    const frame = event?.senderFrame;
    if (!wc || wc.isDestroyed?.() || !frame) return;
    const s = parseReport(json);
    if (!s) return;
    const page = pageOf(wc);
    const key = `${frame.processId}:${frame.routingId}`;
    const before = page.frames.get(key);
    const entry = { frame, top: frame === wc.mainFrame, s, playedAt: before?.playedAt || 0 };
    if (s.playing && !before?.s.playing) { entry.playedAt = now(); page.playedAt = entry.playedAt; }
    if (!s.playing && !s.resumable && !s.actions.length) page.frames.delete(key);
    else page.frames.set(key, entry);
    if (!page.frames.size && !page.playedAt) pages.delete(wc);
    changed();
  }

  // The pop-up's list: tabs only (the Spotify card's hidden player has no tab to show), the last to start playing first.
  function list() {
    const out = [];
    const seen = new Set();
    for (const [wc, page] of pages) {
      const tab = wc.isDestroyed?.() ? null : tabOf(wc);
      const m = merge(page.frames);
      if (!tab || !m || !(m.playing || m.resumable)) continue;
      const f = tabFields(tab);
      seen.add(f.id);
      out.push({ id: f.id, title: m.title || f.title, artist: m.artist, album: m.album, pageTitle: f.title, artwork: m.artwork, favicon: f.favicon || '', playing: m.playing, canPlay: true, canPrev: m.canPrev, canNext: m.canNext, muted: Boolean(f.muted), playedAt: page.playedAt });
    }
    for (const tab of audibleTabs()) { // sound with no media element behind it (Web Audio): mute and go-to only
      const f = tabFields(tab);
      if (seen.has(f.id)) continue;
      out.push({ id: f.id, title: f.title, artist: '', album: '', pageTitle: f.title, artwork: '', favicon: f.favicon || '', playing: true, canPlay: false, canPrev: false, canNext: false, muted: Boolean(f.muted), playedAt: 0 });
    }
    return out.sort((a, b) => b.playedAt - a.playedAt);
  }

  // The page a media key goes to: the last to start playing that can still play or pause (a tab or not).
  function lastPlayed() {
    let best = null;
    for (const [wc, page] of pages) {
      if (wc.isDestroyed?.()) continue;
      const m = merge(page.frames);
      if (!m || !(m.playing || m.resumable)) continue;
      if (!best || page.playedAt > best.page.playedAt) best = { wc, page, m };
    }
    return best;
  }

  function send(page, action) {
    let sent = 0;
    for (const f of targets(page.frames, action)) {
      try { if (!f.frame.isDestroyed?.()) { f.frame.send('media-hub:act', action); sent++; } } catch { /* the frame is gone */ }
    }
    return sent > 0;
  }

  function command(page, m, action) {
    if (action === 'playpause') action = m.playing ? 'pause' : 'play';
    return send(page, action);
  }

  // From the pop-up ('media:act'): { id, action } where action is play, pause, playpause, previoustrack, nexttrack, mute or show.
  function act(id, action) {
    const entry = [...pages].find(([wc]) => { const t = wc.isDestroyed?.() ? null : tabOf(wc); return Boolean(t) && tabFields(t).id === id; });
    const tab = entry ? tabOf(entry[0]) : audibleTabs().find((t) => tabFields(t).id === id);
    if (!tab) return false;
    if (action === 'mute') { setMuted(tab, !tabFields(tab).muted); return true; }
    if (action === 'show') { show(tab); return true; }
    if (!entry || ![...ACTIONS, 'playpause'].includes(action)) return false;
    const m = merge(entry[1].frames);
    return m ? command(entry[1], m, action) : false;
  }

  function mediaKey(name) {
    const action = KEYS[name];
    const best = action ? lastPlayed() : null;
    return best ? command(best.page, best.m, action) : false;
  }

  // The media keys are held only while something can be played or paused, so another app gets them the rest of the time.
  function syncKeys() {
    if (!keys) return;
    const want = Boolean(lastPlayed());
    if (want === keysOn) return;
    keysOn = want;
    for (const name of Object.keys(KEYS)) {
      try { if (want) keys.register(name, () => mediaKey(name)); else keys.unregister(name); } catch { /* taken by another app */ }
    }
  }

  function changed() {
    if (pushTimer) return;
    pushTimer = setTimeout(() => { pushTimer = null; syncKeys(); onList(list()); }, 60);
    pushTimer.unref?.();
  }

  return { report, list, act, mediaKey, refresh: changed, keysHeld: () => keysOn };
}

module.exports = { create, parseReport, merge, targets, ACTIONS, KEYS };
