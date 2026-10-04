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
  const looksNative = (name, fn) => {
    Object.defineProperty(fn, 'toString', { value: () => `function ${name}() { [native code] }`, configurable: true, enumerable: false, writable: true });
    return fn;
  };
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

  // navigator.permissions.query: the real PermissionStatus, with `state` answered from the decisions.
  try {
    const Perms = window.Permissions && window.Permissions.prototype;
    const origQuery = Perms && Perms.query;
    if (typeof origQuery === 'function') {
      const query = function query(descriptor) {
        const p = origQuery.apply(this, arguments);
        let name;
        try { name = descriptor && typeof descriptor === 'object' ? descriptor.name : undefined; } catch { name = undefined; }
        if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(NAMES, name)) return p;
        return p.then((status) => {
          try {
            Object.defineProperty(status, 'state', { get: looksNative('get state', function () { return stateOf(name); }), enumerable: true, configurable: true });
            live.add({ ref: new WeakRef(status), name, last: stateOf(name) });
          } catch { /* leave the status as it is */ }
          return status;
        });
      };
      Object.defineProperty(Perms, 'query', { value: looksNative('query', query), configurable: true, enumerable: true, writable: true });
    }
  } catch { /* keep Electron's answers */ }

  // Notification.permission / requestPermission.
  try {
    const N = window.Notification;
    if (N) {
      Object.defineProperty(N, 'permission', { get: looksNative('get permission', function () { const s = states.notifications; return s === 'granted' || s === 'denied' ? s : 'default'; }), enumerable: true, configurable: true });
      const origRequest = N.requestPermission;
      if (typeof origRequest === 'function') {
        const requestPermission = function requestPermission() {
          const p = origRequest.apply(this, arguments);
          Promise.resolve(p).then((result) => {
            if (result === 'granted' || result === 'denied') states.notifications = result; else delete states.notifications;
            update();
          }, () => {});
          return p;
        };
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
