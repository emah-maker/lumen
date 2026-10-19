// Screen recording, for class demos and bug reports: the current tab, or a whole screen or one window, to a .webm video in the Downloads folder.
// Loaded the first time someone records (main.js screenRecorder()); nothing here runs before that.
//
//   - The recording happens in a small window of Lumen's own (renderer/recorder.html): MediaRecorder, VP9 video and Opus sound, WebM. It is also the
//     bar with the timer, Pause and Stop, and afterwards "Saved ... Show in folder". WebM is the default; MP4 (H.264) only when asked for and when MediaRecorder can write it (main.js checks once).
//   - What is recorded: a tab is handed to the recorder straight from main (the display-media handler in main.js asks takeDisplay); a screen or
//     window goes through the same picker menu as screen sharing. The microphone is only used when the person switched "Include the microphone" on:
//     allowsPermission lets the recorder window, and only it, use the microphone for the few seconds a recording takes to start.
//   - The pieces the page produces are written to "<name>.webm.part" as they arrive (so a long recording never sits in memory) and renamed when
//     the recording ends. The finished file is added to the Downloads list.
//   - Nothing leaves the computer: the file is only ever written to the Downloads folder.
'use strict';

const fs = require('fs');
const path = require('path');

const WIDTH = 440;
const HEIGHT = 44;
const SAVED_MS = 15000; // how long "Saved ... Show in folder" stays on screen
const START_MS = 120000; // a screen picker left open this long is given up on

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
// Letters, digits and a few marks only: a page's host or title never makes a path that Windows refuses.
const safe = (s, max = 40) => String(s || '').normalize('NFKD').replace(/[^\w .-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();

// "Lumen tab recording - example.com - 2026-10-19 14-32-05" (no extension). A screen: "Lumen screen recording 2026-10-19 14-32-05".
function recordingName({ kind, host = '', title = '', date = new Date() }) {
  const what = kind === 'tab' ? 'tab' : 'screen';
  const about = kind === 'tab' ? safe(host.replace(/^www\./, ''), 40) || safe(title, 40) : '';
  return `Lumen ${what} recording${about ? ` - ${about}` : ''}${about ? ' - ' : ' '}${stamp(date)}`;
}

// The first free "<base>.webm", then "<base> (1).webm", ... in `dir`.
function freeFile(dir, base, ext = '.webm') {
  let target = path.join(dir, base + ext);
  for (let n = 1; fs.existsSync(target) || fs.existsSync(`${target}.part`); n++) target = path.join(dir, `${base} (${n})${ext}`);
  return target;
}

// Where the pieces go. finish() renames the .part file to its name and returns the path (null when nothing was written); abort() throws it away.
function createSink(dir, base, ext = '.webm') {
  fs.mkdirSync(dir, { recursive: true });
  const file = freeFile(dir, base, ext);
  const part = `${file}.part`;
  let fd = fs.openSync(part, 'w');
  let bytes = 0;
  const close = () => { if (fd !== null) { try { fs.closeSync(fd); } catch { /* closed */ } fd = null; } };
  return {
    file,
    write(chunk) {
      if (fd === null || !chunk) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      fs.writeSync(fd, buffer);
      bytes += buffer.length;
    },
    bytes: () => bytes,
    finish() {
      close();
      if (!bytes) { try { fs.unlinkSync(part); } catch { /* gone */ } return null; }
      fs.renameSync(part, file);
      return file;
    },
    abort() { close(); try { fs.unlinkSync(part); } catch { /* gone */ } },
  };
}

// deps: electron { BrowserWindow, screen, ipcMain, shell }, preload (path), page (path of recorder.html), downloadDir() -> folder,
//   addDownload(file) (puts the file on the Downloads list), anchor() -> the browser window the bar goes over, t(key, vars), toast(text),
//   hidden (tests: the bar is never shown on screen), now().
function createScreenRecorder(deps) {
  const { BrowserWindow, screen, ipcMain, shell } = deps.electron;
  const now = deps.now || (() => new Date());
  let win = null;
  let loaded = null;
  let phase = 'idle'; // idle | starting | recording | paused | saved
  let session = null; // { kind, sink, name, mic, sound, frame, mime, startedAt }
  let savedFile = '';
  let savedTimer = null;
  let stopWaiters = [];
  let micOpen = false; // the recorder window may use the microphone: only while a recording that asked for it is starting
  let listening = false;

  const alive = () => Boolean(win) && !win.isDestroyed();
  const fromBar = (event) => alive() && event.sender === win.webContents;
  const labels = () => ({ pause: deps.t('record.pause'), resume: deps.t('record.resume'), stop: deps.t('record.stop'), show: deps.t('record.show'), close: deps.t('record.close') });
  const push = (mode, text = '') => { if (alive() && !win.webContents.isDestroyed()) win.webContents.send('screen-rec:view', { mode, text, labels: labels() }); };
  const run = (code) => win.webContents.executeJavaScript(code, true);

  function listen() {
    if (listening) return;
    listening = true;
    ipcMain.on('screen-rec:chunk', (event, chunk) => { if (fromBar(event) && session?.sink && (phase === 'recording' || phase === 'paused')) { try { session.sink.write(chunk); } catch (err) { console.error('[lumen] could not write the recording:', err.message); } } });
    ipcMain.on('screen-rec:done', (event) => { if (fromBar(event)) finish(); });
    ipcMain.on('screen-rec:ctl', (event, what) => {
      if (!fromBar(event)) return;
      if (what === 'pause') api.pause();
      else if (what === 'resume') api.resume();
      else if (what === 'stop') api.stop();
      else if (what === 'show') api.showInFolder();
      else if (what === 'close') close();
    });
  }

  function ensure() {
    if (alive()) return loaded;
    listen();
    win = new BrowserWindow({
      width: WIDTH, height: HEIGHT, show: false, frame: false, transparent: true, resizable: false, minimizable: false, maximizable: false,
      fullscreenable: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, title: 'Lumen recorder',
      webPreferences: { preload: deps.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, spellcheck: false, backgroundThrottling: false },
    });
    const wc = win.webContents;
    win.setAlwaysOnTop(true, 'screen-saver');
    try { win.setContentProtection(true); } catch { /* not everywhere */ } // the bar is for the person recording: a screen recording does not film it
    wc.on('will-navigate', (event) => event.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => { win = null; loaded = null; if (phase === 'recording' || phase === 'paused' || phase === 'starting') finish(); });
    loaded = win.loadFile(deps.page).catch(() => {});
    return loaded;
  }

  function place() {
    try {
      const anchor = deps.anchor?.();
      const display = anchor && !anchor.isDestroyed() ? screen.getDisplayMatching(anchor.getBounds()) : screen.getPrimaryDisplay();
      const area = display.workArea;
      win.setBounds({ x: Math.round(area.x + (area.width - WIDTH) / 2), y: area.y + 8, width: WIDTH, height: HEIGHT }, false);
    } catch { /* the window keeps where it is */ }
  }

  function reveal() {
    if (deps.hidden) { win.setOpacity(0); win.setIgnoreMouseEvents(true); win.setPosition(-5000, -5000); } else place();
    if (!win.isVisible()) win.showInactive();
  }

  function close() {
    clearTimeout(savedTimer);
    savedTimer = null;
    if (phase === 'saved') phase = 'idle';
    if (phase === 'idle' && alive()) { try { win.destroy(); } catch { /* gone */ } win = null; loaded = null; }
  }

  // The recording is over (Stop, the tab closed, the shared window went away, or the recorder window was closed): keep what was written.
  function finish() {
    if (!session) return;
    const s = session;
    session = null;
    let file = null;
    try { file = s.sink ? s.sink.finish() : null; } catch (err) { console.error('[lumen] could not save the recording:', err.message); }
    const waiters = stopWaiters;
    stopWaiters = [];
    if (file) {
      phase = 'saved';
      savedFile = file;
      try { deps.addDownload(file); } catch (err) { console.error('[lumen] could not list the recording:', err.message); }
      if (alive()) { push('saved', deps.t('record.saved', { name: path.basename(file) })); clearTimeout(savedTimer); savedTimer = setTimeout(close, SAVED_MS); }
      else deps.toast?.(deps.t('record.saved', { name: path.basename(file) }));
    } else {
      phase = 'idle';
      deps.toast?.(deps.t('record.empty'));
      close();
    }
    for (const done of waiters) done({ ok: Boolean(file), file });
  }

  const api = {
    state: () => ({ phase, kind: session?.kind || null, name: session?.sink ? path.basename(session.sink.file) : null, file: savedFile || null, mic: session?.mic || false, sound: session?.sound || false, mime: session?.mime || null }),
    active: () => phase === 'starting' || phase === 'recording' || phase === 'paused',

    // kind 'tab': `wc` is the page to record. kind 'screen': the picker menu asks which screen or window. -> { ok } | { ok: false, error }
    async start({ kind, wc = null, mic = false, sound = true, format = 'webm' } = {}) {
      if (api.active()) return { ok: false, error: 'busy' };
      if (kind !== 'tab' && kind !== 'screen') return { ok: false, error: 'kind' };
      if (kind === 'tab' && (!wc || wc.isDestroyed())) return { ok: false, error: 'no-tab' };
      const dir = deps.downloadDir();
      if (!dir) return { ok: false, error: 'no-folder' };
      clearTimeout(savedTimer);
      if (phase === 'saved') { phase = 'idle'; savedFile = ''; }
      let host = '';
      let title = '';
      if (kind === 'tab') { try { host = new URL(wc.getURL()).host; } catch { /* no address */ } try { title = wc.getTitle(); } catch { /* none */ } }
      const base = recordingName({ kind, host, title, date: now() });
      try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); } catch (err) { return { ok: false, error: 'no-folder', detail: err.message }; }
      phase = 'starting';
      session = { kind, sink: null, mic: mic === true, sound: sound !== false, frame: kind === 'tab' ? wc.mainFrame : null, mime: '', startedAt: Date.now() };
      micOpen = mic === true;
      const session0 = session;
      const abandon = (error, detail) => { micOpen = false; session = null; phase = 'idle'; try { session0?.sink?.abort(); } catch { /* gone */ } close(); return { ok: false, error, detail }; };
      try {
        await ensure();
        if (!alive()) return abandon('failed');
        push('starting');
        let result;
        let giveUp;
        try {
          result = await Promise.race([run(`window.__rec.start(${JSON.stringify({ mic: session.mic, sound: session.sound, format: format === 'mp4' ? 'mp4' : 'webm' })})`), new Promise((resolve) => { giveUp = setTimeout(() => resolve({ ok: false, error: 'timeout' }), START_MS); })]);
        } finally { clearTimeout(giveUp); }
        micOpen = false;
        if (!result?.ok) { try { if (alive()) await run('window.__rec.stop()'); } catch { /* gone */ } return abandon(result?.error || 'failed', result?.name); }
        if (!session) return { ok: false, error: 'closed' };
        session.mime = result.mime || '';
        try { session.sink = createSink(dir, base, /mp4/.test(session.mime) ? '.mp4' : '.webm'); } catch (err) { return abandon('no-folder', err.message); }
        session.startedAt = Date.now();
        phase = 'recording';
        reveal();
        push('recording', kind === 'tab' ? (host || title || deps.t('record.thisTab')) : deps.t('record.screen'));
        return { ok: true, file: session.sink.file, mime: session.mime };
      } catch (err) {
        return abandon('failed', err.message);
      }
    },

    async pause() {
      if (phase !== 'recording' || !alive()) return false;
      if (!(await run('window.__rec.pause()'))) return false;
      phase = 'paused';
      push('paused', deps.t('record.pausedText'));
      return true;
    },
    async resume() {
      if (phase !== 'paused' || !alive()) return false;
      if (!(await run('window.__rec.resume()'))) return false;
      phase = 'recording';
      push('recording', session?.kind === 'tab' ? '' : deps.t('record.screen'));
      return true;
    },
    // Stops the recording and resolves once the file is written: { ok, file }.
    stop() {
      if (!api.active() || phase === 'starting') return Promise.resolve({ ok: false });
      return new Promise((resolve) => {
        stopWaiters.push(resolve);
        if (!alive()) { finish(); return; }
        run('window.__rec.stop()').then((stopped) => { if (!stopped) finish(); }).catch(() => finish());
      });
    },
    showInFolder() { if (savedFile && fs.existsSync(savedFile)) { shell.showItemInFolder(savedFile); return true; } return false; },

    // The display-media handler's question, for a request from the recorder window: the streams to hand it, or null (a screen or window: the
    // picker menu answers). `request.frame` belongs to the recorder window; the tab is the one the recording was started for.
    takeDisplay(request, fromContents) {
      if (!alive() || fromContents !== win.webContents || !session || phase !== 'starting') return null;
      if (session.kind !== 'tab') return null;
      const frame = session.frame;
      if (!frame || frame.isDestroyed?.()) return {};
      return { video: frame, ...(session.sound ? { audio: frame } : {}) };
    },
    // The permission handlers' question: may `wc` capture right now? Only the recorder window, only while a recording is starting, and the
    // microphone only when the person switched it on.
    allowsPermission(wc, permission, details) {
      if (!alive() || wc !== win.webContents || phase !== 'starting' || details?.isMainFrame === false) return false;
      const types = Array.isArray(details?.mediaTypes) ? details.mediaTypes : details?.mediaType ? [details.mediaType] : [];
      if (permission === 'display-capture') return true;
      if (permission !== 'media') return false;
      if (types.length === 0) return true; // getDisplayMedia asks as 'media' with no type
      return micOpen && types.length === 1 && types[0] === 'audio';
    },
    owns: (wc) => alive() && wc === win.webContents,
    // Quitting: what was recorded so far is kept.
    shutdown() {
      micOpen = false;
      if (session) finish();
      clearTimeout(savedTimer);
      try { if (alive()) win.destroy(); } catch { /* gone */ }
      win = null;
      loaded = null;
    },
    // A test presses a button of the bar (the window itself is never on screen in a test run).
    press(what) { if (what === 'pause') return api.pause(); if (what === 'resume') return api.resume(); if (what === 'stop') return api.stop(); if (what === 'show') return api.showInFolder(); if (what === 'close') { close(); return true; } return false; },
    contents: () => (alive() ? win.webContents : null),
  };
  return api;
}

module.exports = { createScreenRecorder, createSink, recordingName, freeFile, safe, WIDTH, HEIGHT };
