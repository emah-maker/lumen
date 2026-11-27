// Media controls (features/media-hub.js): what this frame's <audio> and <video> elements and the page's Media Session are
// doing, for the toolbar's media pop-up and the media keys, and the play/pause/previous/next it sends back.
// install() runs in the page's own world (contextBridge.executeInMainWorld): it sees the elements a page plays without
// putting them in the document (new Audio()), and the handlers the page gives navigator.mediaSession.setActionHandler,
// which nothing else can read or call. It hands back only a function to call, and reports through one passed in; the
// page sees no new global, event or message.
const { contextBridge, ipcRenderer } = require('electron');

const web = typeof location !== 'undefined' && /^(https?|file):$/.test(location.protocol);

// Runs in the main world. report(json) sends the frame's state when it changes; the returned function takes an action.
function install(report) {
  const ACTIONS = ['play', 'pause', 'previoustrack', 'nexttrack', 'stop'];
  const handlers = new Map();
  const elements = new Set();
  let lastPlayed = null;
  let timer = 0;
  const ms = navigator.mediaSession || null;
  const MS = typeof MediaSession === 'function' ? MediaSession.prototype : null;
  // Patched functions read as native code, with the toString wrapper Lumen's other page patches share (preload/activity-preload.js).
  let shown = null;
  try { const m = Function.prototype.toString.call(Symbol.for('lumen.nativeTexts')); if (m instanceof WeakMap) shown = m; } catch { /* not wrapped: left as is */ }
  const looksNative = (name, fn) => { try { shown?.set(fn, `function ${name}() { [native code] }`); } catch { /* ignore */ } return fn; };

  // Sound a person would hear: not muted, some volume, and a video that has decoded no audio after a second has none.
  const sounding = (el) => !el.muted && el.volume > 0 && !(el instanceof HTMLVideoElement && el.currentTime > 1 && el.webkitAudioDecodedByteCount === 0);
  const playingEl = (el) => !el.paused && !el.ended && sounding(el);

  function state() {
    let playing = false;
    for (const el of elements) {
      if (!el.isConnected && el.paused) { if (el !== lastPlayed) elements.delete(el); continue; }
      if (playingEl(el)) playing = true;
    }
    const resumable = Boolean(!playing && lastPlayed && lastPlayed.paused && !lastPlayed.ended && lastPlayed.currentTime > 0 && sounding(lastPlayed));
    const md = ms && ms.metadata;
    let artwork;
    try {
      const art = md && Array.from(md.artwork || []);
      const best = art && art.length ? art.slice().sort((a, b) => (parseInt(b.sizes, 10) || 0) - (parseInt(a.sizes, 10) || 0))[0] : null;
      artwork = best ? new URL(best.src, location.href).href : '';
    } catch { artwork = ''; }
    return JSON.stringify({
      playing,
      resumable: resumable || Boolean(!playing && ms && ms.playbackState === 'paused' && handlers.has('play') && lastPlayed),
      meta: md ? { title: String(md.title || ''), artist: String(md.artist || ''), album: String(md.album || ''), artwork } : {},
      actions: [...handlers.keys()],
    });
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = 0; try { report(state()); } catch { /* the frame is going */ } }, 120);
  }

  function track(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    elements.add(el);
    if (!el.paused) lastPlayed = el;
    schedule();
  }

  // Events on elements in the document (they don't bubble, so in the capture phase), and play() on any element.
  for (const type of ['play', 'playing', 'pause', 'ended', 'volumechange', 'emptied', 'timeupdate']) {
    window.addEventListener(type, (e) => { if (type === 'timeupdate' && !elements.has(e.target)) return; track(e.target); }, { capture: true, passive: true });
  }
  try {
    const P = HTMLMediaElement.prototype;
    const realPlay = P.play;
    const play = { play() {
      const el = this;
      if (el instanceof HTMLMediaElement && !elements.has(el)) {
        for (const type of ['playing', 'pause', 'ended', 'volumechange']) el.addEventListener(type, () => track(el), { passive: true });
        lastPlayed = el;
      }
      const out = Reflect.apply(realPlay, el, arguments);
      track(el);
      return out;
    } }.play;
    Object.defineProperty(P, 'play', { value: looksNative('play', play), writable: true, enumerable: true, configurable: true });
  } catch { /* elements in the document still count */ }

  if (MS && ms) {
    try {
      const realSet = MS.setActionHandler;
      const setActionHandler = { setActionHandler(action, handler) {
        const out = Reflect.apply(realSet, this, arguments); // (throws for an unknown action, as before)
        if (this === ms && ACTIONS.includes(action)) { if (typeof handler === 'function') handlers.set(action, handler); else handlers.delete(action); schedule(); }
        return out;
      } }.setActionHandler;
      Object.defineProperty(MS, 'setActionHandler', { value: looksNative('setActionHandler', setActionHandler), writable: true, enumerable: true, configurable: true });
      for (const key of ['metadata', 'playbackState']) {
        const d = Object.getOwnPropertyDescriptor(MS, key);
        if (!d || !d.set) continue;
        const set = looksNative(`set ${key}`, Object.getOwnPropertyDescriptor({ set [key](v) { d.set.call(this, v); schedule(); } }, key).set);
        Object.defineProperty(MS, key, { get: d.get, set, enumerable: d.enumerable, configurable: true });
      }
    } catch { /* no Media Session: element controls only */ }
  }

  // A command from the pop-up or a media key. The page's own handler when it set one (a music site's queue), else the elements.
  return function act(action) {
    action = String(action);
    const handler = handlers.get(action);
    if (handler) { try { handler({ action }); } catch { /* the page's error */ } schedule(); return; }
    if (action === 'pause' || action === 'stop') { for (const el of elements) if (!el.paused) el.pause(); }
    else if (action === 'play' && lastPlayed) { try { const p = lastPlayed.play(); if (p && p.catch) p.catch(() => {}); } catch { /* not allowed */ } }
    schedule();
  };
}

if (web) {
  let last = '';
  const report = (json) => {
    if (typeof json !== 'string' || json === last) return;
    if (!last && json === '{"playing":false,"resumable":false,"meta":{},"actions":[]}') return; // nothing to tell yet
    last = json;
    ipcRenderer.send('media-hub:report', json);
  };
  let act = null;
  try { act = contextBridge.executeInMainWorld({ func: install, args: [report] }); } catch (err) { console.error('media-hub: could not install:', err.message); }
  ipcRenderer.on('media-hub:act', (_e, action) => { try { if (typeof act === 'function') act(String(action)); } catch { /* the frame is going */ } });
}
