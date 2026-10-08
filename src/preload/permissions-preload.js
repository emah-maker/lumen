// What a page reads about its permissions, as Chrome shows it. Electron's permission check can only say allowed or
// not, so before the user decides, Notification.permission and navigator.permissions.query() read 'denied' where
// Chrome says 'default' / 'prompt', and sites then never ask. Here, for the permissions Lumen prompts for
// (geolocation, notifications, camera, microphone, clipboard-read), the page sees 'prompt' until a decision exists at
// its origin, then the real answer; PermissionStatus 'change' events fire when the decision comes. The decisions come
// from the main process (browser/site-permissions.js): one synchronous lookup when the frame starts and again when
// the window regains focus (a decision revoked in Settings), plus a push on every change.
// Also hides SpeechRecognition (Electron has no speech service, so it always fails with 'not-allowed' and sites do not
// get to their fallback). Registered as a 'frame' preload in every tab session.
const { contextBridge, ipcRenderer } = require('electron');

const KEY = '__lumenPermissionBridge_7c2e91';
const web = (location.protocol === 'http:' || location.protocol === 'https:') && location.origin !== 'null';
const skip = /(^|\.)accounts\.google\.com$/.test(location.hostname); // Google's sign-in pages check the browser closely: untouched there

function fetchStates() {
  try { const s = ipcRenderer.sendSync('site-permissions:states'); return s && typeof s === 'object' ? s : {}; } catch { return {}; }
}

if (web && !skip) {
  let listener = null;
  ipcRenderer.on('site-permissions:changed', () => { if (listener) { try { listener(); } catch { /* page side gone */ } } });
  contextBridge.exposeInMainWorld(KEY, {
    get: () => fetchStates(),
    onChange: (fn) => { listener = fn; },
  });
}

// Runs in the main world.
function install(bridgeKey) {
  const bridge = window[bridgeKey];
  delete window[bridgeKey];
  if (!bridge) return;
  // One WeakMap (function -> the text toString() gives for it) shared by everything Lumen patches into a page's main
  // world (this script and the preloads), found by asking the toString wrapper for it (toString.call(symbol): the native throws, ours answers; no property of its own), whichever of them runs first.
  // toString is wrapped by a plain method, not a Proxy (a Proxy gives itself away to the cyclic-prototype and stack-depth
  // probes that "tampered function" checks run). A TypeError from toString.call(notAFunction) is raised inside the
  // wrapper, so its stack would carry a frame of ours ("at Object.toString (<anonymous>:L:C)") that no native toString
  // has: it is cut out. (The same helper is in preload/permissions-preload.js and page-dialogs-preload.js.)
  const nativeTexts = () => {
    const key = Symbol.for('lumen.nativeTexts');
    const current = Function.prototype.toString;
    try { const found = current.call(key); if (found instanceof WeakMap) return found; } catch { /* the native one: not wrapped yet */ }
    const shown = new WeakMap();
    const wrapper = {
      toString() {
        'use strict'; // (a sloppy method would box the symbol it is asked with)
        if (this === key) return shown;
        if (shown.has(this)) return shown.get(this);
        try {
          return Reflect.apply(current, this, arguments);
        } catch (err) {
          try { if (err && typeof err.stack === 'string') err.stack = err.stack.split('\n').filter((line) => !/^\s+at (?:\S+\.)?(?:toString|apply) \([^)]*<anonymous>:\d+:\d+\)$/.test(line)).join('\n'); } catch { /* frozen error: left */ }
          throw err;
        }
      },
    }.toString;
    shown.set(wrapper, 'function toString() { [native code] }');
    Object.defineProperty(Function.prototype, 'toString', { value: wrapper, writable: true, configurable: true, enumerable: false });
    return shown;
  };
  const shown = nativeTexts();
  const looksNative = (name, fn) => { shown.set(fn, `function ${name}() { [native code] }`); return fn; };
  const getter = (name, key, fn) => looksNative(`get ${key}`, Object.getOwnPropertyDescriptor({ get [key]() { return fn.call(this); } }, key).get);
  let states = {};
  try { states = Object.assign({}, bridge.get()); } catch { /* stay with Electron's answers */ }
  const NAMES = { geolocation: 'geolocation', notifications: 'notifications', camera: 'media', microphone: 'media', 'clipboard-read': 'clipboard-read' };
  const live = new Set(); // { ref: WeakRef(PermissionStatus), name, last }
  const stateOf = (name) => states[NAMES[name]] || 'prompt';

  const update = () => {
    for (const entry of live) {
      const status = entry.ref.deref();
      if (!status) { live.delete(entry); continue; }
      const now = stateOf(entry.name);
      if (now !== entry.last) { entry.last = now; try { status.dispatchEvent(new Event('change')); } catch { /* ignore */ } }
    }
  };
  const refresh = () => {
    try { states = Object.assign({}, bridge.get()); } catch { return; }
    update();
  };
  try { bridge.onChange(() => refresh()); } catch { /* no push: focus still refreshes */ }
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });

  // navigator.permissions.query: the real PermissionStatus, with `state` answered from the decisions. Built the way the
  // natives are (a method, so no prototype and not constructible; `state` a getter on PermissionStatus.prototype, not an
  // own property of each status), so none of it shows to a "tampered function" or property-descriptor check.
  try {
    const Perms = window.Permissions && window.Permissions.prototype;
    const origQuery = Perms && Perms.query;
    const Status = window.PermissionStatus && window.PermissionStatus.prototype;
    const stateDescriptor = Status && Object.getOwnPropertyDescriptor(Status, 'state');
    if (typeof origQuery === 'function' && stateDescriptor && stateDescriptor.get) {
      const names = new WeakMap(); // PermissionStatus -> the permission it was asked about
      const origState = stateDescriptor.get;
      Object.defineProperty(Status, 'state', { get: getter('get state', 'state', function () { const name = names.get(this); return name ? stateOf(name) : origState.call(this); }), set: undefined, enumerable: stateDescriptor.enumerable, configurable: true });
      const query = {
        query(descriptor) {
          const p = origQuery.apply(this, arguments);
          let name;
          try { name = descriptor && typeof descriptor === 'object' ? descriptor.name : undefined; } catch { name = undefined; }
          if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(NAMES, name)) return p;
          return p.then((status) => {
            try {
              names.set(status, name);
              live.add({ ref: new WeakRef(status), name, last: stateOf(name) });
            } catch { /* leave the status as it is */ }
            return status;
          });
        },
      }.query;
      Object.defineProperty(Perms, 'query', { value: looksNative('query', query), configurable: true, enumerable: true, writable: true });
    }
  } catch { /* keep Electron's answers */ }

  // Notification.permission / requestPermission.
  try {
    const N = window.Notification;
    if (N) {
      Object.defineProperty(N, 'permission', { get: getter('get permission', 'permission', function () { const s = states.notifications; return s === 'granted' || s === 'denied' ? s : 'default'; }), set: undefined, enumerable: true, configurable: true });
      const origRequest = N.requestPermission;
      if (typeof origRequest === 'function') {
        const requestPermission = {
          requestPermission() {
            const p = origRequest.apply(this, arguments);
            Promise.resolve(p).then((result) => {
              if (result === 'granted' || result === 'denied') states.notifications = result; else delete states.notifications;
              update();
            }, () => {});
            return p;
          },
        }.requestPermission;
        Object.defineProperty(N, 'requestPermission', { value: looksNative('requestPermission', requestPermission), configurable: true, enumerable: true, writable: true });
      }
    }
  } catch { /* keep Electron's answer */ }
}

try {
  if (web && !skip) contextBridge.executeInMainWorld({ func: install, args: [KEY] });
} catch (err) {
  console.error('permissions: could not install the permission state shim:', err.message);
}

// Speech recognition always fails with 'not-allowed' here: hide it so sites use their own fallback.
try {
  contextBridge.executeInMainWorld({ func: () => { for (const name of ['SpeechRecognition', 'webkitSpeechRecognition']) { try { delete window[name]; } catch { /* not removable */ } } } });
} catch { /* nothing to hide */ }

// Lumen's PDF viewer page (features/pdf-viewer.js, lumen-pdf://app) may ask for the print preview, and nothing else.
if (location.origin === 'lumen-pdf://app') {
  contextBridge.exposeInMainWorld('lumenPdfHost', Object.freeze({ print: () => ipcRenderer.send('pdf:print') }));
}
