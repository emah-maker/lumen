// [desktop apps] The process side of the UI Automation helper (uia-helper.ps1): one hidden PowerShell, started on the first call, kept
// while the AI is using other apps, ended by itself when nothing has asked for a while, at quit, or when it hangs. JSON lines both
// ways; every call has an id and a timeout. Started through ai/cli-utils.js like every other program Lumen runs (hidden, no shell).
// Nothing the AI wrote is ever put into the script or the command line: a call sends a command name and data over stdin.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, 'uia-helper.ps1');
const IDLE_MS = 90e3; // no call for this long: the helper ends
const START_MS = 8e3; // how long the first call waits for the helper's hello
const CALL_MS = 20e3;

// The script as a real file in the temp folder (a .ps1 inside the packaged app cannot be run in place, and -EncodedCommand has a
// length limit this script is over). Named by its content, so an update writes a new file and a running helper is never changed.
function scriptFile({ read = (p) => fs.readFileSync(p), write = fs.writeFileSync, mkdir = fs.mkdirSync, exists = fs.existsSync, tmp = os.tmpdir(), script = SCRIPT, name = 'uia' } = {}) { // (script/name: another helper, e.g. src/word)
  const body = read(script);
  const hash = require('crypto').createHash('sha1').update(body).digest('hex').slice(0, 10);
  const dir = path.join(tmp, 'lumen-desktop');
  const file = path.join(dir, `${name}-${hash}.ps1`);
  // An existing file is reused only when its content is exactly the script (a planted or damaged file is written over, never run).
  let same = false;
  if (exists(file)) { try { same = Buffer.compare(Buffer.from(read(file)), Buffer.from(body)) === 0; } catch { same = false; } }
  if (!same) { mkdir(dir, { recursive: true }); write(file, body); }
  return file;
}
const helperArgs = (file) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file];

// deps (tests pass fakes): platform, spawn(file, args, opts), scriptFile(), now(), setTimeout / clearTimeout.
function createClient(deps = {}) {
  const platform = deps.platform || process.platform;
  const spawn = deps.spawn || ((...a) => require('../ai/cli-utils').spawn(...a));
  const now = deps.now || Date.now;
  const idleMs = deps.idleMs || IDLE_MS;
  let child = null;
  let ready = null; // Promise<void> for the child's hello
  let seq = 0;
  const waiting = new Map(); // id -> { resolve, reject, timer }
  let idleTimer = null;
  let startedAt = 0;
  let lastStartMs = 0;
  let destroyed = false;

  const fail = (err) => { for (const [, w] of waiting) { clearTimeout(w.timer); w.reject(err); } waiting.clear(); };
  const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(stop, idleMs); idleTimer.unref?.(); };

  function stop() {
    clearTimeout(idleTimer);
    idleTimer = null;
    const c = child;
    child = null;
    ready = null;
    if (c) {
      try { c.stdin.write('{"id":0,"cmd":"quit"}\n'); c.stdin.end(); } catch { /* it is gone */ }
      setTimeout(() => { try { c.kill(); } catch { /* already gone */ } }, 300).unref?.();
    }
    fail(new Error('The app helper stopped.'));
  }

  // Stop now: the helper is killed this instant (whatever it was typing or clicking ends with it), every waiting call is rejected, and a
  // fresh one is started on the next call.
  function abort(why = 'The app helper was stopped.') {
    clearTimeout(idleTimer);
    idleTimer = null;
    const c = child;
    child = null;
    ready = null;
    if (c) { try { c.kill(); } catch { /* already gone */ } }
    fail(Object.assign(new Error(why), { aborted: true }));
  }

  function start() {
    if (platform !== 'win32') return Promise.reject(Object.assign(new Error('Not available on this platform.'), { unavailable: true }));
    if (destroyed) return Promise.reject(new Error('The app helper is shut down.'));
    if (ready) return ready;
    startedAt = now();
    let file;
    try { file = (deps.scriptFile || scriptFile)(); } catch (err) { return Promise.reject(new Error(`The app helper could not be prepared: ${err.message}`)); }
    let c;
    // (A development test run tells the helper so, which turns on its test seam; a packaged Lumen never does.)
    const testRun = deps.testRun ?? (() => { try { return require('../test-mode').isTest(); } catch { return false; } })()
    try { c = spawn('powershell.exe', helperArgs(file), { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], ...(testRun ? { env: { ...process.env, LUMEN_DESKTOP_TEST: '1' } } : {}) }); } catch (err) { return Promise.reject(new Error(`The app helper could not start: ${err.message}`)); }
    child = c;
    let buf = '';
    let helloSeen = null;
    ready = new Promise((resolve, reject) => {
      helloSeen = { resolve, reject };
      const timer = setTimeout(() => { reject(new Error('The app helper did not start in time.')); if (child === c) stop(); }, deps.startMs || START_MS);
      timer.unref?.();
      helloSeen.timer = timer;
    });
    ready.catch(() => {});
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.t === 'hello') { lastStartMs = now() - startedAt; clearTimeout(helloSeen.timer); helloSeen.resolve(); continue; }
        const w = waiting.get(m.id);
        if (!w) continue;
        waiting.delete(m.id);
        clearTimeout(w.timer);
        if (m.ok) w.resolve(m); else w.reject(Object.assign(new Error(m.error || 'The app helper failed.'), { fromHelper: true }));
      }
      if (buf.length > 8e6) buf = '';
    });
    c.on('error', (err) => { if (child === c) { child = null; ready = null; } clearTimeout(helloSeen.timer); helloSeen.reject(err); fail(err); });
    c.stdin.on('error', () => {});
    c.on('exit', () => {
      clearTimeout(helloSeen.timer);
      if (child === c) { child = null; ready = null; }
      helloSeen.reject(new Error('The app helper ended.'));
      fail(new Error('The app helper ended.'));
    });
    return ready;
  }

  // call('tree', { hwnd: 123 }) -> the helper's answer object ({ ok: true, ... }); rejects with its error text.
  async function call(cmd, args = {}, { timeoutMs = CALL_MS } = {}) {
    await start();
    const c = child;
    if (!c) throw new Error('The app helper is not running.');
    touch();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(Object.assign(new Error(`The app did not answer in time (${cmd}). It may be busy or showing a dialog.`), { timeout: true }));
        if (child === c) stop(); // a helper stuck on one call is replaced, not waited for
      }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      try { c.stdin.write(`${JSON.stringify({ ...args, id, cmd })}\n`); } catch (err) { waiting.delete(id); clearTimeout(timer); reject(err); }
    });
  }

  return {
    call, stop, start, abort,
    alive: () => Boolean(child),
    startMs: () => lastStartMs,
    pid: () => child?.pid || 0,
    destroy() { destroyed = true; stop(); },
  };
}

module.exports = { createClient, scriptFile, helperArgs, SCRIPT, IDLE_MS };
