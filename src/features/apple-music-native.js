// The Apple Music widget's Status mode, the process part: reads what the Apple Music app is playing and presses its
// buttons (features/apple-music-view.js is the pure part: the scripts, the parsing, the card's data).
//   Windows: one long-lived PowerShell helper over System Media Transport Controls, JSON lines both ways. It starts on
//            the first read and ends by itself when nothing has asked for a while (the card is off screen), or at quit.
//   macOS:   osascript against the Music app, polled every few seconds while something has asked recently.
// Nothing here puts a track title, a page's text or any other input into a script: the scripts are constants, a session
// id sent to the helper is one the helper itself reported, and a button is picked from a fixed list.
'use strict';

const os = require('os');
const path = require('path');
const AMV = require('./apple-music-view');

const IDLE_MS = 150e3; // no read for this long: the helper (or the macOS poll) stops
const FIRST_MS = 6e3; // how long a read waits for the helper's first picture
const ACK_MS = 3e3;
const MAC_POLL_MS = 3e3;
const MAC_TIMEOUT_MS = 8e3;
const MIN_RESTART_MS = 30e3; // a helper that keeps dying is not started again for this long

// deps (all optional, tests pass fakes): platform, spawn, execFile, resizeArt(bytes) -> bytes|null, now, any (tests only: every
// media session, not just Apple's), onChange() (the card's state changed on its own), readFile(path), rm(path), setTimeout...
function createNowPlaying(deps = {}) {
  const platform = deps.platform || process.platform;
  const now = deps.now || Date.now;
  const spawn = deps.spawn || ((...a) => require('child_process').spawn(...a));
  const execFile = deps.execFile || ((...a) => require('child_process').execFile(...a));
  const any = deps.any === true;
  const fsp = () => require('fs').promises;
  const artPath = path.join(os.tmpdir(), `lumen-apple-music-art-${process.pid}.bin`);

  let helper = null;
  let started = 0;
  let deaths = 0;
  let sessions = null; // the helper's latest list, null before its first picture
  let hello = null; // { installed, launchId }
  let waiters = [];
  let acks = [];
  let lastTouch = 0;
  let idleTimer = null;
  let macTimer = null;
  let signature = '';
  const arts = new Map(); // track key -> data: URL ('' when it has none), the last few
  let destroyed = false;

  const touch = () => {
    lastTouch = now();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(stop, IDLE_MS + 1000);
    idleTimer.unref?.();
  };
  function stop() {
    clearTimeout(idleTimer);
    clearInterval(macTimer);
    macTimer = null;
    const h = helper;
    helper = null;
    sessions = null;
    hello = null;
    signature = '';
    if (h) { try { h.stdin.end(); } catch { /* it is gone */ } try { h.kill(); } catch { /* already gone */ } }
    for (const w of waiters.splice(0)) w();
  }

  // ---- art ----
  const cacheArt = (key, url) => { arts.set(key, url); while (arts.size > 8) arts.delete(arts.keys().next().value); return url; };
  const toArt = (bytes) => {
    try {
      const small = deps.resizeArt ? deps.resizeArt(bytes) : bytes;
      return (small && AMV.dataUrl(small)) || '';
    } catch { return ''; }
  };

  // ---- Windows ----
  function startHelper() {
    if (helper || destroyed) return;
    if (started && deaths >= 3 && now() - started < MIN_RESTART_MS) return;
    started = now();
    const env = { ...process.env, ...(any ? { LUMEN_AM_ANY: '1' } : {}) };
    let h;
    try { h = spawn('powershell.exe', AMV.windowsHelperArgs(), { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env }); } catch { return; }
    helper = h;
    let buf = '';
    h.stdout.setEncoding('utf8');
    h.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); onLine(AMV.parseHelperLine(line)); }
      if (buf.length > 4e6) buf = '';
    });
    h.on('error', () => {});
    h.stdin.on('error', () => {});
    h.on('exit', () => {
      if (helper === h) { deaths = now() - started < 5e3 ? deaths + 1 : 0; helper = null; sessions = null; for (const w of waiters.splice(0)) w(); }
    });
  }
  function onLine(m) {
    if (!m) return;
    if (m.t === 'hello') { hello = { installed: m.installed, launchId: m.launchId }; changed(); return; }
    if (m.t === 'ack') { for (const a of acks.splice(0)) a(m.ok); return; }
    if (m.t === 'sessions') {
      for (const s of m.list) { if (s.thumb) cacheArt(`${s.id}|${s.title}|${s.album}`, toArt(Buffer.from(s.thumb, 'base64'))); }
      sessions = m.list;
      for (const w of waiters.splice(0)) w();
      changed();
    }
  }
  function windowsCard() {
    const pick = AMV.pickSession(sessions, { any });
    const art = pick ? arts.get(`${pick.id}|${pick.title}|${pick.album}`) || '' : '';
    return AMV.fromWindows({ sessions, installed: hello ? hello.installed : null, launchId: hello?.launchId }, now(), { any, art });
  }
  function changed() {
    if (!deps.onChange) return;
    const d = platform === 'win32' ? windowsCard() : null;
    if (!d) return;
    const sig = AMV.signature(d);
    if (sig !== signature) { signature = sig; try { deps.onChange(); } catch { /* the card keeps what it shows */ } }
  }

  // ---- macOS ----
  const osascript = (args, timeout = MAC_TIMEOUT_MS) => new Promise((resolve) => {
    try {
      execFile('osascript', args, { timeout, windowsHide: true, maxBuffer: 1e6 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    } catch { resolve({ ok: false, stdout: '', stderr: 'spawn failed' }); }
  });
  async function macCard() {
    const r = await osascript(['-l', 'JavaScript', '-e', AMV.MAC_READ]);
    if (!r.ok && AMV.isDenied(r.stderr)) return AMV.fromMac('', now(), { denied: true });
    let d = AMV.fromMac(r.stdout, now(), { failed: !r.ok });
    if (d.state === 'playing' || d.state === 'paused') {
      const key = AMV.trackKey(d);
      if (!arts.has(key)) cacheArt(key, await macArt());
      d = { ...d, art: arts.get(key) || '' };
    }
    return d;
  }
  async function macArt() {
    const args = [];
    for (const line of AMV.MAC_ARTWORK) args.push('-e', line);
    args.push(artPath);
    const r = await osascript(args);
    if (!r.ok || r.stdout.trim() !== 'ok') return '';
    try {
      const bytes = await (deps.readFile ? deps.readFile(artPath) : fsp().readFile(artPath));
      return toArt(bytes);
    } catch { return ''; } finally { try { await (deps.rm ? deps.rm(artPath) : fsp().rm(artPath, { force: true })); } catch { /* a temp file */ } }
  }
  function startMacPoll() {
    if (macTimer || destroyed) return;
    macTimer = setInterval(async () => {
      if (now() - lastTouch > IDLE_MS) { stop(); return; }
      const d = await macCard();
      const sig = AMV.signature(d);
      if (sig !== signature) { signature = sig; try { deps.onChange?.(); } catch { /* the card keeps what it shows */ } }
    }, MAC_POLL_MS);
    macTimer.unref?.();
  }

  // ---- the interface ----
  // The card's data now: { mode: 'status', state: 'playing' | 'paused' | 'idle' | 'unavailable', ... }.
  async function read() {
    touch();
    if (platform === 'darwin') {
      const d = await macCard();
      signature = AMV.signature(d);
      startMacPoll();
      return d;
    }
    if (platform !== 'win32') return AMV.unavailable('unsupported', now());
    startHelper();
    if (!helper && sessions === null) return AMV.unavailable('error', now());
    // The first picture, and (when no Apple session is playing) the helper's word on whether the app is installed at all.
    const deadline = now() + FIRST_MS;
    const ready = () => sessions !== null && (hello !== null || Boolean(AMV.pickSession(sessions, { any })));
    while (!ready() && helper && now() < deadline) {
      await new Promise((resolve) => { const t = setTimeout(resolve, Math.max(1, deadline - now())); waiters.push(() => { clearTimeout(t); resolve(); }); });
    }
    if (sessions === null) return AMV.unavailable('error', now());
    return windowsCard();
  }

  // Press a button: 'play' | 'pause' | 'next' | 'previous'. Resolves true when the app took it.
  async function control(name) {
    const action = AMV.actionOf(name);
    if (!action) return false;
    touch();
    if (platform === 'darwin') {
      const r = await osascript(['-l', 'JavaScript', '-e', AMV.MAC_CONTROL[action]]);
      if (!r.ok && AMV.isDenied(r.stderr)) throw new Error('Lumen isn’t allowed to control Music. Allow it in System Settings > Privacy & Security > Automation.');
      return r.ok && r.stdout.trim() === 'ok';
    }
    if (platform !== 'win32') return false;
    startHelper();
    const pick = AMV.pickSession(sessions, { any });
    if (!helper || !pick) return false;
    const ack = new Promise((resolve) => { const t = setTimeout(() => resolve(false), ACK_MS); acks.push((ok) => { clearTimeout(t); resolve(ok); }); });
    try { helper.stdin.write(`${JSON.stringify({ cmd: action, id: pick.id })}\n`); } catch { return false; }
    return ack;
  }

  function destroy() { destroyed = true; stop(); }
  return { read, control, stop, destroy, running: () => Boolean(helper) || Boolean(macTimer) };
}

module.exports = { createNowPlaying, IDLE_MS };
