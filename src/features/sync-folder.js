'use strict';
// Sync through a folder, the part wired into Lumen (docs/sync.md): Settings → General → Sync. Off by default, and while it is off
// this file is not even loaded (main.js requires it when the setting is on, after the window is up, or when the person turns it on).
//
// The person picks a folder their own cloud drive syncs and a sync passphrase. The passphrase is kept on this computer only, encrypted
// with the OS keychain (safeStorage), in sync-secret.bin; it is never in settings.json and never leaves this computer. Everything put in
// the folder is encrypted with a key made from it (features/sync-core.js). Nothing is sent anywhere else.
//
// When does it work? A first pass shortly after start (once the window is up), a pass a few seconds after something changes here (longer
// for history, which changes with every page), a pass shortly after a file in the folder changes (fs.watch, debounced), and a pass every
// few minutes as a safety net. Passes never overlap.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const core = require('./sync-core');
const providersLib = require('./sync-providers');

const KINDS = ['bookmarks', 'history', 'chats', 'widgets', 'settings'];
const DEFAULT_KINDS = { bookmarks: true, history: true, chats: true, widgets: true, settings: true };
const STATE_FILE = 'sync-state.json';
const SECRET_FILE = 'sync-secret.bin';

// Which kinds of data a write of settings.json changed (references compared: a write that carries the same bookmarks, cards and preferences
// along, like the session being saved every few seconds, changes none of them).
const KIND_KEYS = {
  bookmarks: ['bookmarks'],
  widgets: ['homeWidgets', 'homeWidgetSizes', 'weatherPlaces'],
  settings: [...providersLib.SETTING_KEYS, ...Object.keys(providersLib.DIRECT_SETTINGS)],
};
function kindsChanged(prev, next) {
  return Object.keys(KIND_KEYS).filter((kind) => KIND_KEYS[kind].some((k) => prev?.[k] !== next?.[k]));
}

const cleanKinds = (k) => Object.fromEntries(KINDS.map((name) => [name, k && typeof k === 'object' ? k[name] !== false : DEFAULT_KINDS[name]]));

// deps: { userData, readSettings, writeSettings, cipher: { available(), encrypt(text) -> Buffer, decrypt(Buffer) -> text },
//         makeProvider(kind) -> provider (sync-providers.js) wired to the real stores, onApplied(kinds), onStatus(), appVersion, deviceName?,
//         timing?: { local, history, watch, periodic } (ms), now? }
function createSyncService(deps) {
  const now = deps.now || (() => Date.now());
  const timing = { local: 4000, history: 30000, watch: 2500, periodic: 5 * 60 * 1000, poll: 10000, first: 1500, ...(deps.timing || {}) };
  const stateFile = path.join(deps.userData, STATE_FILE);
  const secretFile = path.join(deps.userData, SECRET_FILE);

  let started = false;
  let engine = null;
  let kinds = cleanKinds();
  let withPasswords = false;
  let root = '';
  let timer = null;
  let timerDue = 0;
  let periodic = null;
  let watchers = [];
  let poller = null;
  let lastFp = null;
  let watchRetry = 0;
  // fs.watch where it is harmless; on Windows a watched folder stops its parents being renamed or moved (a cloud client, or the person,
  // moving the folder would be told it is in use), so there a light look at the file list every few seconds does the same job.
  const watchMode = deps.watchMode || (process.platform === 'win32' ? 'poll' : 'watch');
  let running = null;
  let again = null; // a pass was asked for while one ran: { force }
  let last = { at: 0, ok: null, error: null, result: null };
  let devices = [];
  let stateObj = null;
  let applying = false;

  const config = () => {
    const c = deps.readSettings().syncFolder;
    return c && typeof c === 'object' ? c : null;
  };
  const saveConfig = (patch) => {
    const settings = deps.readSettings();
    if (patch === null) { delete settings.syncFolder; deps.writeSettings(settings); return; }
    deps.writeSettings({ ...settings, syncFolder: { ...(config() || {}), ...patch } });
  };

  // ---- the passphrase, kept only on this computer ----
  const keychainOk = () => { try { return deps.cipher.available(); } catch { return false; } };
  function storePassphrase(text) { fs.writeFileSync(secretFile, deps.cipher.encrypt(text), { mode: 0o600 }); }
  function loadPassphrase() {
    try { return deps.cipher.decrypt(fs.readFileSync(secretFile)); } catch { return null; }
  }
  const hasPassphrase = () => fs.existsSync(secretFile);

  // ---- local state (what this computer has applied) ----
  function loadState() {
    if (stateObj) return stateObj;
    try { stateObj = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { stateObj = null; }
    if (!stateObj || typeof stateObj !== 'object' || typeof stateObj.deviceId !== 'string' || !/^[0-9a-f]{12}$/.test(stateObj.deviceId)) stateObj = { deviceId: core.newDeviceId() };
    return stateObj;
  }
  async function saveState(state) {
    if (!started) return; // (turned off while a pass was running: the state file stays gone)
    const tmp = `${stateFile}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await fsp.rename(tmp, stateFile);
  }

  // ---- providers ----
  function providers() {
    const list = KINDS.filter((k) => kinds[k]).map((k) => deps.makeProvider(k));
    if (kinds.chats) list.push(deps.makeProvider('projects'), deps.makeProvider('project-files')); // [project workspace] chats travel with their projects
    if (withPasswords) list.push(deps.makeProvider('passwords'));
    return list.filter(Boolean);
  }
  const wanted = (kind) => (kind === 'passwords' ? withPasswords : kinds[kind] === true);

  // ---- scheduling ----
  function schedule(ms) {
    if (!started) return;
    const due = now() + ms;
    if (timer && timerDue <= due) return;
    clearTimeout(timer);
    timerDue = due;
    timer = setTimeout(() => { timer = null; timerDue = 0; request().catch(() => {}); }, ms);
    timer.unref?.();
  }
  // A write of settings.json (main.js): only a change to bookmarks, cards or a synced preference starts a pass.
  function touchSettings(prev, next) {
    if (!started) return;
    for (const kind of kindsChanged(prev, next)) touch(kind);
  }
  // Something changed in a store here (main.js calls this from the places that save).
  function touch(kind) {
    if (!started || !wanted(kind)) return;
    if (applying) { again = again || { force: false }; return; } // (a change made while a pass runs, or by the pass itself: looked at once more after it)
    schedule(kind === 'history' ? timing.history : timing.local);
  }

  function stopWatching() {
    for (const w of watchers) { try { w.close(); } catch { /* already closed */ } }
    watchers = [];
    clearInterval(poller); poller = null;
  }
  function watch() {
    stopWatching();
    if (!engine || !root) return;
    if (watchMode === 'poll') {
      const eng = engine;
      eng.fingerprint().then((fp) => { lastFp = fp; }, () => {});
      poller = setInterval(async () => {
        if (running || engine !== eng) return;
        try { const fp = await eng.fingerprint(); if (lastFp !== null && fp !== lastFp) { lastFp = fp; schedule(timing.watch); } else lastFp = fp; } catch { /* the folder is not reachable: the periodic pass reports it */ }
      }, timing.poll);
      poller.unref?.();
      return;
    }
    const own = stateObj.deviceId;
    const dirs = core.dirsOf(root);
    const onEvent = (_type, name) => {
      const n = String(name || '');
      if (n && (n.includes(`.${own}.`) || n.startsWith(`${own}.`) || n.includes('.tmp-') || n === 'sync.json')) return; // our own writes
      schedule(timing.watch);
    };
    for (const dir of [dirs.data, dirs.devices]) {
      try { const w = fs.watch(dir, { persistent: false }, onEvent); w.on('error', () => { watchRetry = 1; }); watchers.push(w); } catch { watchRetry = 1; /* the folder is not there now: the periodic pass looks again */ }
    }
  }

  // ---- one pass ----
  // A pass asked for by a timer or a change: one already running will be followed by one more, not by a queue of them.
  function request() {
    if (!started) return Promise.resolve(null);
    if (running) { again = again || { force: false }; return running; }
    return pass(false);
  }
  // A pass the person asked for (Sync now): it starts after the one running, so it sees everything that is there now.
  function pass(force = false) {
    if (!started) return Promise.resolve(null);
    if (running) return running.then(() => pass(force));
    running = (async () => {
      let result = null;
      try {
        if (!engine) await connect();
        applying = true;
        const fpBefore = poller ? await engine.fingerprint().catch(() => null) : null; // (what the other files were before this pass: a change during it is seen by the next look)
        result = await engine.sync({ force });
        applying = false;
        const touched = result.kinds || [];
        last = { at: now(), ok: true, error: null, result };
        stateObj.lastAt = last.at;
        devices = await engine.devices().catch(() => devices);
        if (watchRetry || (!watchers.length && !poller)) { watchRetry = 0; watch(); } else if (poller && fpBefore) lastFp = fpBefore;
        if (touched.length) { try { deps.onApplied?.(touched, result); } catch { /* the UI is not there */ } }
      } catch (err) {
        applying = false;
        last = { at: now(), ok: false, error: { code: err?.code || 'error', message: err?.message || String(err) }, result: null };
        if (['no-folder', 'not-writable', 'unreadable'].includes(err?.code)) engine = null; // opened again on the next pass
      } finally {
        running = null;
        try { deps.onStatus?.(); } catch { /* nobody is looking */ }
        if (again) { again = null; schedule(500); }
      }
      return result;
    })();
    return running;
  }

  // Opens the folder with the stored passphrase and makes the engine.
  async function connect() {
    const secret = loadPassphrase();
    if (!secret) throw new core.SyncError('no-passphrase', 'The sync passphrase is not on this computer');
    const opened = await core.openFolder(root, secret, { create: false }); // (enable made or joined the set: a set gone since is reported, not made again)
    const state = loadState();
    engine = core.createEngine({
      dirs: opened.dirs, key: opened.key, deviceId: state.deviceId, deviceName: deps.deviceName || os.hostname(), platform: process.platform, appVersion: deps.appVersion || '',
      state, saveState, providers: providers(), now,
    });
    watch();
  }

  // ---- public ----
  // After the window is up: start working if the person turned it on.
  function start() {
    const c = config();
    if (started || !c?.on || !c.path) return false;
    kinds = cleanKinds(c.kinds);
    withPasswords = c.passwords === true;
    root = c.path;
    started = true;
    loadState();
    periodic = setInterval(() => { request().catch(() => {}); }, timing.periodic);
    periodic.unref?.();
    schedule(timing.first);
    return true;
  }
  function stop() {
    started = false;
    clearTimeout(timer); timer = null; timerDue = 0;
    clearInterval(periodic); periodic = null;
    stopWatching();
    engine = null;
  }

  const insideProfile = (dir) => {
    const rel = path.relative(path.resolve(deps.userData), path.resolve(dir));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };

  // Turn it on (or move it to another folder / passphrase): checks the folder and the passphrase first, so that a wrong one changes nothing.
  async function enable({ folder, passphrase, kinds: wantKinds, passwords: wantPasswords } = {}) {
    if (!keychainOk()) throw new core.SyncError('no-keychain', 'This computer has no keychain to keep the passphrase in');
    folder = typeof folder === 'string' ? folder.trim() : '';
    if (!folder || !path.isAbsolute(folder)) throw new core.SyncError('no-folder', 'Choose a folder first');
    if (insideProfile(folder)) throw new core.SyncError('bad-folder', 'Choose a folder outside Lumen\'s own data');
    if (typeof passphrase !== 'string' || !passphrase) throw new core.SyncError('short-passphrase', 'Type the sync passphrase');
    const opened = await core.openFolder(folder, passphrase); // throws: no-folder, not-writable, wrong-passphrase, short-passphrase, bad-meta, newer
    const wasOn = started;
    stop();
    storePassphrase(passphrase);
    const oldPath = config()?.path;
    saveConfig({ on: true, path: folder, kinds: cleanKinds(wantKinds ?? config()?.kinds), passwords: wantPasswords === true });
    if (wasOn && oldPath !== folder) { stateObj = { deviceId: core.newDeviceId() }; try { fs.rmSync(stateFile, { force: true }); } catch { /* not there */ } } // (a different folder: a first pass again)
    start();
    last = { at: 0, ok: null, error: null, result: null };
    await pass(true);
    return { created: opened.created };
  }

  // The "what syncs" switches. Passwords need `passwords: true` to be asked for out loud.
  async function configure({ kinds: wantKinds, passwords: wantPasswords } = {}) {
    if (!config()?.on) throw new core.SyncError('off', 'Sync is off');
    const patch = {};
    if (wantKinds) patch.kinds = cleanKinds({ ...kinds, ...wantKinds });
    if (typeof wantPasswords === 'boolean') patch.passwords = wantPasswords;
    saveConfig(patch);
    if (patch.kinds) kinds = patch.kinds;
    if (typeof patch.passwords === 'boolean') withPasswords = patch.passwords;
    engine = null; // rebuilt with the new list on the next pass
    if (started) await pass(true);
    return true;
  }

  const syncNow = () => pass(true);

  // Turn it off: this computer stops, forgets the passphrase and what it applied. The folder's files are left alone (other computers keep
  // using them); the person can delete the "Lumen Sync" folder themselves.
  async function disable() {
    const folder = config()?.path;
    const id = loadState().deviceId;
    stop();
    if (running) await running.catch(() => {}); // (a pass in flight finishes first, so it cannot write after the files are removed)
    if (folder && path.isAbsolute(folder)) { try { await fsp.rm(path.join(core.dirsOf(folder).devices, `${id}${core.EXT}`), { force: true }); } catch { /* the folder is not reachable: nothing to tidy */ } }
    for (const f of [secretFile, stateFile, `${stateFile}.tmp`]) { try { fs.rmSync(f, { force: true }); } catch { /* not there */ } }
    stateObj = null;
    last = { at: 0, ok: null, error: null, result: null };
    devices = [];
    saveConfig(null);
    try { deps.onStatus?.(); } catch { /* nobody is looking */ }
  }

  function status() {
    const c = config();
    const result = last.result;
    return {
      on: Boolean(c?.on),
      running: Boolean(running),
      path: c?.path || '',
      folderName: c?.path ? path.join(c.path, core.DIR_NAME) : '',
      kinds: cleanKinds(c?.kinds),
      passwords: c?.passwords === true,
      keychain: keychainOk(),
      hasPassphrase: c?.on ? hasPassphrase() : false,
      lastSynced: last.ok ? last.at : (stateObj?.lastAt || 0),
      error: last.ok === false ? last.error : null,
      devices,
      deviceName: deps.deviceName || os.hostname(),
      damaged: result?.bad || 0,
      newer: result?.newer || 0,
      skipped: result?.skipped || [],
      problems: result?.errors?.length || 0,
    };
  }

  return { start, stop, touch, touchSettings, pass, syncNow, enable, configure, disable, status, isStarted: () => started, kinds: KINDS, wanted };
}

module.exports = { createSyncService, kindsChanged, KINDS, DEFAULT_KINDS, STATE_FILE, SECRET_FILE, cleanKinds, providers: providersLib };
