// [desktop apps] macOS: the same call(cmd, args) the Windows helper client answers (client.js), made from system tools only:
//   - osascript -l JavaScript (mac-helper.jxa) for the window list, the UI tree, clicks, typing and keys, through System Events;
//   - screencapture -l <window id> for pictures, resized with sips;
//   - open -a for open_app, on an app this file found itself in the Applications folders.
// Every program is started with an argument array through ai/cli-utils.js (no shell). The script is the fixed file passed with -e; the
// command and its data (which can hold text the AI wrote) are separate arguments, as JSON, never part of the script.
// macOS asks the user for Accessibility (System Events) and Screen Recording (screencapture). Lumen never grants either itself: a missing
// one is reported as an error with `permission` and `settingsUrl`, which index.js turns into a card with a button to the right pane.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { toNodes } = require('./mac-tree');

const SCRIPT = path.join(__dirname, 'mac-helper.jxa');
const CALL_MS = 20e3;
const PANE = 'x-apple.systempreferences:com.apple.preference.security?';
const PERMISSIONS = {
  accessibility: {
    url: `${PANE}Privacy_Accessibility`,
    text: 'Lumen needs the macOS Accessibility permission to read and operate other apps. Ask the user to open System Settings > Privacy & Security > Accessibility, turn on Lumen, and then try again.',
  },
  screen: {
    url: `${PANE}Privacy_ScreenCapture`,
    text: 'Lumen needs the macOS Screen Recording permission to take a picture of another app. Ask the user to open System Settings > Privacy & Security > Screen & System Audio Recording, turn on Lumen, then quit and reopen Lumen. read_app still works without it.',
  },
  automation: {
    url: `${PANE}Privacy_Automation`,
    text: 'Lumen is not allowed to control System Events, which it needs to operate other apps. Ask the user to open System Settings > Privacy & Security > Automation and turn on System Events under Lumen, then try again.',
  },
};
// Folders open_app looks in (it starts only an app it found here, never a path the AI wrote).
const APP_DIRS = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', path.join(os.homedir(), 'Applications')];

// Each found app's bundle id, from its Contents/Info.plist (plutil, a system tool), so the never list sees a renamed app for what it is.
// An app whose id cannot be read keeps bundle '' and is not started.
const plistArgs = (app) => ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.posix.join(app, 'Contents', 'Info.plist')];

const permissionError = (kind) => Object.assign(new Error(PERMISSIONS[kind].text), { permission: kind, settingsUrl: PERMISSIONS[kind].url });
// What osascript or System Events said -> which permission is missing ('' when it is not about permission).
function permissionOf(text, code = 0) {
  const s = `${text || ''} ${code || ''}`;
  if (/-25211\b|assistive access|accessibility (access|permission)/i.test(s)) return 'accessibility'; // (not -1719 alone: that is "invalid index", an item that went away)
  if (/-1743\b|not authori[sz]ed to send apple events/i.test(s)) return 'automation';
  return '';
}

// The osascript argument array for one command: the script, then the command, then its data as one JSON argument.
const jxaArgs = (source, cmd, data = {}) => ['-l', 'JavaScript', '-e', source, String(cmd), JSON.stringify(data)];
const captureArgs = (id, file) => ['-x', '-o', '-t', 'jpg', '-l', String(Math.trunc(Number(id))), file];
const sipsArgs = (file, out, w, q) => ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(Math.max(10, Math.min(95, Math.round(Number(q) || 60)))), '--resampleWidth', String(Math.max(80, Math.min(2400, Math.round(Number(w) || 1000)))), file, '--out', out];

// The apps open_app can start, by name: [{ name, exe, key, exact }] (key is the app's full path). The bundle id is added by the client (bundleIds).
function findApps(name, { readdir = (d) => fs.readdirSync(d), dirs = APP_DIRS } = {}) {
  const want = String(name || '').trim().toLowerCase().replace(/\.app$/, '');
  if (!want) return [];
  const out = [];
  for (const dir of dirs) {
    let list;
    try { list = readdir(dir); } catch { continue; }
    for (const f of list) {
      if (!/\.app$/i.test(f)) continue;
      const base = f.slice(0, -4);
      const low = base.toLowerCase();
      if (low === want || low.includes(want)) out.push({ name: base, exe: path.posix.join(dir, f), key: path.posix.join(dir, f), exact: low === want });
    }
  }
  return out.slice(0, 20);
}

// deps (tests pass fakes): execFile(file, args, opts, cb), source(), access { accessibility(), screen() } (Electron's checks, which never prompt),
// resize(buffer, w, q) -> base64 JPEG (Electron's nativeImage; sips when absent), fs { readFile, unlink, mkdir }, readdir, tmp, now
function createMacClient(deps = {}) {
  const execFile = deps.execFile || ((...a) => require('../ai/cli-utils').execFile(...a));
  const now = deps.now || Date.now;
  const tmp = deps.tmp || path.join(os.tmpdir(), 'lumen-desktop');
  const files = deps.fs || { readFile: (p) => fs.promises.readFile(p), unlink: (p) => fs.promises.unlink(p), mkdir: (p) => fs.promises.mkdir(p, { recursive: true, mode: 0o700 }) };
  const access = deps.access || null;
  let source = null;
  const getSource = () => (source ??= (deps.source || (() => fs.readFileSync(SCRIPT, 'utf8')))());
  const running = new Set();
  let refs = null; // { hwnd, map } from the latest read_app
  let resolved = new Map(); // path -> bundle id, from the latest resolve: the only apps launch starts
  const frames = new Map(); // window id -> hash of the last picture the live card got
  let destroyed = false;
  let lastMs = 0;

  function run(file, args, timeoutMs) {
    if (destroyed) return Promise.reject(new Error('The app helper is shut down.'));
    return new Promise((resolve, reject) => {
      let child = null;
      const done = (err, stdout, stderr) => {
        running.delete(child);
        if (child?.lumenAborted) { reject(Object.assign(new Error(child.lumenAborted), { aborted: true })); return; }
        if (err) {
          const kind = permissionOf(`${stderr || ''} ${err.message || ''}`);
          if (kind) { reject(permissionError(kind)); return; }
          if (err.killed || err.signal === 'SIGTERM') { reject(Object.assign(new Error(`The app did not answer in time (${path.basename(file)}). It may be busy or showing a dialog.`), { timeout: true })); return; }
          reject(Object.assign(new Error(String(stderr || err.message || 'failed').trim().slice(0, 300)), { code: err.code }));
          return;
        }
        resolve(String(stdout || ''));
      };
      try { child = execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, done); } catch (err) { reject(err); return; }
      if (child) running.add(child);
    });
  }

  // One helper command; its { ok: false } answer becomes an error (a permission one when it is about permission).
  async function jxa(cmd, data, timeoutMs) {
    if (access && cmd !== 'check' && access.accessibility?.() === false) throw permissionError('accessibility');
    const t0 = now();
    const out = await run('osascript', jxaArgs(getSource(), cmd, data), timeoutMs);
    lastMs = now() - t0;
    let r;
    try { r = JSON.parse(out.trim().split('\n').pop()); } catch { throw new Error('The app helper gave an answer Lumen could not read.'); }
    if (!r || r.ok !== true) {
      const kind = r?.mine ? '' : permissionOf(r?.error, r?.code);
      if (kind) throw permissionError(kind);
      throw Object.assign(new Error(r?.error || 'The app helper failed.'), { fromHelper: true });
    }
    return r;
  }

  // (title: the one Lumen approved, which tells two windows at the same place and size apart)
  const target = (a) => ({ hwnd: Number(a.hwnd) || 0, pid: Number(a.pid) || 0, start: Number(a.start) || 0, title: typeof a.title === 'string' ? a.title : '' });

  // A picture of one window as base64 JPEG ('' when it cannot be captured).
  async function capture(id, w, q, timeoutMs) {
    if (access && access.screen?.() === false) throw permissionError('screen');
    await files.mkdir(tmp);
    const stem = path.join(tmp, `shot-${crypto.randomBytes(6).toString('hex')}`);
    const raw = `${stem}.jpg`;
    const small = `${stem}-s.jpg`;
    try {
      try { await run('screencapture', captureArgs(id, raw), timeoutMs); } catch (err) { if (err.permission || err.aborted) throw err; throw permissionError('screen'); }
      let buf;
      try { buf = await files.readFile(raw); } catch { buf = null; }
      if (!buf || !buf.length) throw permissionError('screen'); // (macOS writes nothing when Screen Recording is off)
      if (deps.resize) return deps.resize(buf, w, q);
      await run('sips', sipsArgs(raw, small, w, q), timeoutMs);
      return (await files.readFile(small)).toString('base64');
    } finally {
      for (const f of [raw, small]) { try { await files.unlink(f); } catch { /* not made */ } }
    }
  }

  async function call(cmd, args = {}, { timeoutMs = CALL_MS } = {}) {
    switch (cmd) {
      case 'apps': return jxa('apps', {}, timeoutMs);
      case 'focus': return jxa('focus', target(args), timeoutMs);
      case 'tree': {
        const r = await jxa('tree', { ...target(args), max: Number(args.max) || 700 }, timeoutMs);
        const { tree, refs: map } = toNodes(r.tree);
        refs = { hwnd: Number(args.hwnd), map };
        return { ok: true, tree, truncated: r.truncated === true };
      }
      case 'invoke': case 'settext': {
        const ref = refs && refs.hwnd === Number(args.hwnd) ? refs.map.get(String(args.el)) : null;
        if (!ref) throw Object.assign(new Error('Read the app first (read_app): ids come from the latest read.'), { fromHelper: true });
        const data = { ...target(args), path: ref.path, role: ref.role, name: ref.name, desc: ref.desc };
        if (cmd === 'settext') Object.assign(data, { text: String(args.text ?? ''), append: args.append === true, submit: args.submit === true });
        return jxa(cmd, data, timeoutMs);
      }
      case 'keys': return jxa('keys', { ...target(args), chords: Array.isArray(args.chords) ? args.chords : [] }, timeoutMs);
      case 'shot': {
        const c = await jxa('check', target(args), timeoutMs);
        if (!c.onscreen) return { ok: true };
        return { ok: true, image: await capture(args.hwnd, args.w, args.q, timeoutMs) };
      }
      case 'frame': { // the card's live picture (live.js): skip, retitle, same or a new picture
        const t0 = now();
        if (access && access.screen?.() === false) return { ok: true, skip: true };
        const c = await jxa('check', target(args), timeoutMs);
        if (!c.onscreen) return { ok: true, skip: true };
        if (args.title !== null && args.title !== undefined && c.title && c.title !== args.title) return { ok: true, retitle: c.title };
        const image = await capture(args.hwnd, args.w, args.q, timeoutMs);
        const sig = crypto.createHash('md5').update(image).digest('hex');
        const key = Number(args.hwnd);
        if (!args.reset && frames.get(key) === sig) return { ok: true, same: true, ms: now() - t0 };
        frames.set(key, sig);
        while (frames.size > 20) frames.delete(frames.keys().next().value);
        return { ok: true, image, ms: now() - t0 };
      }
      case 'resolve': {
        const found = findApps(args.name, { readdir: deps.readdir, dirs: deps.dirs });
        for (const f of found) {
          try { const id = (await run('plutil', plistArgs(f.exe), 5000)).trim(); f.bundle = /^[A-Za-z0-9.-]{1,200}$/.test(id) ? id : ''; } catch { f.bundle = ''; }
        }
        resolved = new Map(found.map((f) => [f.key, f.bundle]));
        return { ok: true, found };
      }
      case 'launch': {
        const key = String(args.key || '');
        if (!resolved.has(key) || !/^\/[^\0]+\.app$/.test(key)) throw new Error('Only an app open_app found can be started.');
        if (!resolved.get(key)) throw new Error('That app could not be checked before it starts (its bundle id could not be read), so the AI does not start it. The user can open it, and the AI can then use it.');
        await run('open', ['-a', key], timeoutMs);
        return { ok: true };
      }
      default: throw new Error(`Unknown helper command ${cmd}.`);
    }
  }

  // Stop now: every running osascript / screencapture is killed, so a click or typing in progress ends with it.
  function abort(why = 'The app helper was stopped.') {
    for (const c of running) { c.lumenAborted = why; try { c.kill(); } catch { /* gone */ } }
  }

  return {
    call, abort,
    stop: () => abort('The app helper stopped.'),
    start: () => Promise.resolve(),
    alive: () => running.size > 0,
    startMs: () => lastMs,
    pid: () => 0,
    destroy() { abort('The app helper is shut down.'); destroyed = true; },
  };
}

module.exports = { createMacClient, permissionOf, permissionError, jxaArgs, captureArgs, sipsArgs, plistArgs, findApps, PERMISSIONS, SCRIPT, APP_DIRS };
