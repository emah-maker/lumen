// [hang recorder] Names what the main process was doing when it stopped answering ("Lumen is not responding").
//
// Why: the installed Lumen freezes for up to 34 s while the main process sits in Wait and no Lumen process uses CPU. So the main
// thread is blocked on something (a sync call, a lock, a child process) and nothing outside can say which; a debugger cannot be attached
// to a user's copy. This records enough, at almost no cost, that the freeze names itself in <userData>/diagnostics/hangs.jsonl.
//
// How:
//   - Breadcrumbs. The main process writes begin and end times of the things that can block it (every ipcMain handler, the window and
//     app focus/blur/resize listeners, and mark(label, fn) around hot paths such as layout() and sendTabs()) into a ring of 64 slots in
//     a SharedArrayBuffer. A slot is four numbers (sequence, label id, begin, end); end 0 means "not finished". The label strings live
//     in the same buffer (a table of 1024 fixed slots, filled when a label is first met, never per call), so the watchdog thread can
//     name an id while main is stuck. No allocation per call: an int lookup and four stores.
//   - Watchdog. A worker thread (hang-recorder-worker.js) watches a heartbeat that main bumps every 100 ms. Once it has not moved for
//     1 s, the freeze is under way: the worker reads the ring, and the breadcrumbs that have begun and not ended name the culprit (an
//     outer one and the inner one it was inside). At 3 s it writes a provisional line, so a freeze that ends in a kill still leaves
//     one; when main answers again, the final line (same id) replaces it. The worker writes with fs itself: it works while main is stuck.
//   - A line holds only the time, how long, the app version, fixed labels (channel names, never a URL, title or user data), the labels
//     open during the freeze, the 15 breadcrumbs before it and any that took 500 ms or more. The file keeps its last 200 lines.
//
// The watchdog ignores a stretch in which its own thread did not run on time (a sleeping laptop, a stepped clock): that is not a hang.
// This file loads no Electron module and the worker uses its pure parts, so tests can drive all of it without an app.

const RING = 64; // slots (a power of two: slot = seq & 63)
const SLOT = 4; // numbers per slot: seq, id, begin, end
const LABELS = 1024; // label slots (main has some 500 ipc channels); 0 is "?", the last is "other" (what a label past the 1022nd becomes)
const LABEL_BYTES = 64; // a length byte, then up to 63 characters
const RING_AT = 16; // index (Float64) where the ring starts: the 128-byte header comes first
const LABEL_AT = RING_AT * 8 + RING * SLOT * 8; // byte offset of the label table
const SIZE = LABEL_AT + LABELS * LABEL_BYTES;
const F_BEAT_AT = 8; // header: wall time of main's last beat (Float64 index; the beat count is Int32 index 0)
const BEAT_MS = 100;
const POLL_MS = 200;
const HANG_MS = 1000;
const PROVISIONAL_MS = 3000;
const STALL_MS = 1500; // the worker's own gap between two looks: more than this and it was not running (sleep), so it saw nothing
const SLOW_MS = 500;
const RECENT = 15;
const MAX_LINES = 200;

// Labels are fixed strings; this keeps one that is not (a channel with an id in it, a mistaken URL) from carrying user data out.
function safeLabel(name) {
  const s = String(name);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /\bhttps?:/i.test(s)) return 'redacted';
  return s.replace(/[^\w:.\-/ ]/g, '_').slice(0, LABEL_BYTES - 1) || '?';
}

function view(sab) { return { i32: new Int32Array(sab), f64: new Float64Array(sab), u8: new Uint8Array(sab) }; }

function labelOf(u8, id) {
  const o = LABEL_AT + (id & (LABELS - 1)) * LABEL_BYTES;
  const n = Math.min(u8[o], LABEL_BYTES - 1);
  if (!n) return '?';
  let s = '';
  for (let i = 1; i <= n; i++) s += String.fromCharCode(u8[o + i]);
  return s;
}

// The ring as an array of { seq, id, begin, end }, oldest first. (Read while main may be writing: a torn slot at worst names one wrong.)
function readRing(f64) {
  const out = [];
  for (let s = 0; s < RING; s++) {
    const b = RING_AT + s * SLOT;
    const seq = f64[b];
    if (seq > 0) out.push({ seq, id: f64[b + 1], begin: f64[b + 2], end: f64[b + 3] });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

// open: labels begun and not ended, outermost first. recent: the last n breadcrumbs { l, ms } (ms -1: not finished).
function analyze(entries, nameOf, n = RECENT) {
  const open = entries.filter((e) => e.begin > 0 && e.end === 0).map((e) => nameOf(e.id));
  const recent = entries.slice(-n).map((e) => ({ l: nameOf(e.id), ms: e.end === 0 ? -1 : Math.max(0, Math.round(e.end - e.begin)) }));
  return { open, recent };
}

// Breadcrumbs that finished but took long: the freeze's cause when it ended before anyone looked.
function slowOf(entries, nameOf, since, slowMs = SLOW_MS) {
  return entries.filter((e) => e.end > 0 && e.end - e.begin >= slowMs && e.end >= since).map((e) => ({ l: nameOf(e.id), ms: Math.round(e.end - e.begin) }));
}

// The file's text after adding `entry`: its last `max` lines. A final line removes the provisional one with the same id.
function nextFile(text, entry, max = MAX_LINES) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  const kept = entry.provisional ? lines : lines.filter((l) => { try { const o = JSON.parse(l); return !(o.provisional && o.id === entry.id); } catch { return false; } });
  kept.push(JSON.stringify(entry));
  return kept.slice(-max).join('\n') + '\n';
}
const countHangs = (text) => String(text || '').split(/\r?\n/).filter(Boolean).length;

// The recorder main writes. now: wall clock in ms (Date.now); the buffer may be passed in so a test can look at it.
function create({ sab = new SharedArrayBuffer(SIZE), now = Date.now } = {}) {
  const { i32, f64, u8 } = view(sab);
  const ids = new Map();
  let used = 1;
  let head = 0;
  function put(id, s) { // the string in the table: bytes first, then the length byte that makes it visible
    const o = LABEL_AT + id * LABEL_BYTES;
    for (let i = 0; i < s.length; i++) u8[o + 1 + i] = s.charCodeAt(i);
    u8[o] = s.length;
  }
  put(LABELS - 1, 'other');
  function label(name) {
    let id = ids.get(name);
    if (id !== undefined) return id;
    const s = safeLabel(name);
    id = ids.get(s);
    if (id === undefined) {
      if (used >= LABELS - 1) return LABELS - 1; // table full: the rest are "other" (and not remembered, so the map cannot grow)
      id = used++;
      put(id, s);
      ids.set(s, id);
    }
    if (name !== s) ids.set(name, id);
    return id;
  }
  function begin(id) {
    const seq = ++head;
    const b = RING_AT + (seq & (RING - 1)) * SLOT;
    f64[b + 3] = 0; f64[b + 2] = now(); f64[b + 1] = id; f64[b] = seq; // seq last: a slot is whole once it shows its new sequence
    return seq;
  }
  function end(seq) {
    const b = RING_AT + (seq & (RING - 1)) * SLOT;
    if (f64[b] === seq) f64[b + 3] = now(); // (a slot since reused by a newer breadcrumb is not touched)
  }
  // mark('label', fn, a, b): fn(a, b) with its time recorded, and its result returned. Two arguments, no rest array: nothing allocated.
  function mark(name, fn, a, b) {
    const seq = begin(typeof name === 'number' ? name : label(name));
    try { return fn(a, b); } finally { end(seq); }
  }
  function beat() { Atomics.add(i32, 0, 1); f64[F_BEAT_AT] = now(); }
  // A listener that records itself: for ipcMain and window events. (.listener lets removeListener find the original.)
  function tag(name, listener) {
    const id = label(name);
    function recorded() { const seq = begin(id); try { return listener.apply(this, arguments); } finally { end(seq); } }
    recorded.listener = listener;
    return recorded;
  }
  const nameOf = (id) => labelOf(u8, id);
  return { sab, label, begin, end, mark, beat, tag, nameOf, snapshot: () => analyze(readRing(f64), nameOf), entries: () => readRing(f64) };
}

// Wrap ipcMain.handle/handleOnce/on/once once, before any module registers: begin and end of each handler's synchronous part (for an
// async handler that is where a block would be; what follows an await is not covered). Channel names are fixed strings.
function wrapIpc(ipcMain, rec) {
  for (const m of ['handle', 'handleOnce', 'on', 'once']) {
    const orig = ipcMain[m];
    if (typeof orig !== 'function') continue;
    ipcMain[m] = function (channel, listener, ...rest) {
      return orig.call(this, channel, typeof listener === 'function' ? rec.tag(`ipc:${channel}`, listener) : listener, ...rest);
    };
  }
}

// Wrap `on` of an emitter for the named events only (the app's window focus and blur, a window's focus, blur, show, resize...).
function wrapEvents(emitter, names, prefix, rec) {
  const set = new Set(names);
  const orig = emitter.on;
  emitter.on = function (name, listener) {
    return orig.call(this, name, set.has(name) && typeof listener === 'function' ? rec.tag(`${prefix}${name}`, listener) : listener);
  };
}

const WINDOW_EVENTS = ['focus', 'blur', 'show', 'hide', 'resize', 'resized', 'move', 'moved', 'minimize', 'restore', 'maximize', 'unmaximize'];
const APP_EVENTS = ['browser-window-focus', 'browser-window-blur'];

// Everything main does, in one call, before the first handler is registered. The heartbeat and the worker start once the first window
// has loaded (a thread start is about 10 ms: not on the way to the first window); start() is idempotent.
function install({ app, ipcMain, BrowserWindow, file, version }) {
  const rec = create();
  wrapIpc(ipcMain, rec);
  if (app) wrapEvents(app, APP_EVENTS, 'app:', rec);
  if (BrowserWindow) wrapEvents(BrowserWindow.prototype, WINDOW_EVENTS, 'win:', rec);
  let started = null;
  rec.start = () => {
    if (started) return started;
    started = { stop() {} };
    try {
      const path = require('path');
      const { Worker } = require('worker_threads');
      const where = file || (() => path.join(app.getPath('userData'), 'diagnostics', 'hangs.jsonl'));
      const worker = new Worker(path.join(__dirname, 'hang-recorder-worker.js'), {
        workerData: { sab: rec.sab, file: typeof where === 'function' ? where() : where, version: version || (app && app.getVersion()) || '' },
        resourceLimits: { maxOldGenerationSizeMb: 24 },
      });
      worker.unref();
      worker.on('error', () => {}); // a recorder that fails is a recorder that is off, never a crash
      rec.beat();
      const timer = setInterval(rec.beat, BEAT_MS);
      timer.unref();
      started = { worker, stop() { clearInterval(timer); worker.terminate(); } };
    } catch { /* no recorder */ }
    return started;
  };
  rec.stop = () => started?.stop();
  if (app) {
    app.once('browser-window-created', (_e, w) => w.webContents.once('did-finish-load', rec.start));
    setTimeout(rec.start, 5000).unref(); // (a window that never finishes loading is the freeze to catch)
  }
  return rec;
}

// The watchdog, as a pure state machine the worker calls every POLL_MS with its two clocks: tick(mono, wall). sink(entry) writes a line.
function createWatchdog({ sab, sink, version = '', hangMs = HANG_MS, provisionalMs = PROVISIONAL_MS, stallMs = STALL_MS, slowMs = SLOW_MS }) {
  const { i32, f64, u8 } = view(sab);
  const nameOf = (id) => labelOf(u8, id);
  let lastMono = null; let lastWall = 0; let count = 0; let changedAt = 0;
  let ep = null; // the freeze under way: { id, wall, open, recent, provisional }
  let voided = false; // the worker itself was not running: nothing seen until main's next beat means anything
  const line = (durationMs, provisional) => {
    const e = { time: new Date(ep.wall).toISOString(), id: ep.id, durationMs: Math.round(durationMs), v: version, open: ep.open, recent: ep.recent };
    if (provisional) e.provisional = true; else if (ep.slow) e.slow = ep.slow;
    return e;
  };
  function capture() {
    const a = analyze(readRing(f64), nameOf);
    for (const l of a.open) if (!ep.open.includes(l)) ep.open.push(l);
    if (!ep.recent) ep.recent = a.recent; // what ran before the freeze: later looks only see the same stuck ring
  }
  function tick(mono, wall) {
    if (lastMono === null) { lastMono = mono; lastWall = wall; count = Atomics.load(i32, 0); changedAt = mono; return; }
    const gap = mono - lastMono; const wallGap = wall - lastWall;
    lastMono = mono; lastWall = wall;
    if (gap > stallMs || Math.abs(wallGap - gap) > 1000) voided = true; // slept, starved or the clock stepped
    const c = Atomics.load(i32, 0);
    if (c !== count) { // main answered
      count = c;
      if (ep && !voided) {
        ep.slow = slowOf(readRing(f64), nameOf, ep.wall - 500, slowMs);
        sink(line(mono - changedAt, false));
      }
      ep = null; voided = false; changedAt = mono;
      return;
    }
    if (voided) return;
    const stalled = mono - changedAt;
    if (stalled <= hangMs) return;
    if (!ep) { const w = wall - stalled; ep = { id: Math.round(w), wall: w, open: [], recent: null, provisional: false }; }
    capture();
    if (!ep.provisional && stalled > provisionalMs) { ep.provisional = true; sink(line(stalled, true)); }
  }
  return { tick, state: () => ({ ep, voided }) };
}

module.exports = {
  RING, LABELS, SIZE, BEAT_MS, POLL_MS, HANG_MS, MAX_LINES,
  safeLabel, labelOf, readRing, analyze, slowOf, nextFile, countHangs, create, wrapIpc, wrapEvents, install, createWatchdog, view,
};
