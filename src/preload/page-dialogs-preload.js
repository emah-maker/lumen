// Replaces window.alert/confirm/prompt on every page with versions that show Lumen's own dialog
// (features/dialogs.js) instead of Chromium's native one — prompt() doesn't work in Electron at
// all otherwise. Registered session-wide as a 'frame' preload, the same idiom as the
// declarativeNetRequest shim (see extensions-dnr-preload.js, registered as 'lumen-dnr-frame').
//
// This preload itself is sandboxed: it only has require('electron'). The bridge it exposes calls
// ipcMain synchronously (ipcRenderer.sendSync), so the page stays blocked until the main process
// answers — exactly alert()/confirm()/prompt() semantics — and main.js sets `event.returnValue`.
const { contextBridge, ipcRenderer } = require('electron');

// An obscure key: real pages should never see or collide with this while overrides install.
const BRIDGE_KEY = '__lumenPageDialogBridge_a1f3c2';

// Not on Google's account pages at all (they check the browser closely and never use prompt()): no bridge is even
// exposed there.
const onGoogleAccounts = /(^|\.)accounts\.google\.com$/.test(location.hostname);
if (!onGoogleAccounts) contextBridge.exposeInMainWorld(BRIDGE_KEY, {
  request: (kind, message, defaultValue) => ipcRenderer.sendSync('page-dialog', { kind, message, defaultValue }),
});

// Runs in the main world (contextBridge.executeInMainWorld): installs alert/confirm/prompt that
// look and behave like the real, native ones.
function installOverrides(bridgeKey) {
  const bridge = window[bridgeKey];
  delete window[bridgeKey];

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
  const define = (name, fn) => Object.defineProperty(window, name, { value: looksNative(name, fn), writable: true, configurable: true, enumerable: false });

  // (methods, like the natives: no prototype property, not constructible)
  define('alert', { alert(message) {
    bridge.request('alert', message === undefined ? '' : String(message));
  } }.alert);
  define('confirm', { confirm(message) {
    return Boolean(bridge.request('confirm', message === undefined ? '' : String(message)));
  } }.confirm);
  define('prompt', { prompt(message, defaultValue) {
    return bridge.request('prompt', message === undefined ? '' : String(message), defaultValue === undefined ? '' : String(defaultValue));
  } }.prompt);
}

try {
  if (!onGoogleAccounts) contextBridge.executeInMainWorld({ func: installOverrides, args: [BRIDGE_KEY] });
} catch (err) {
  console.error('page dialogs: could not install alert/confirm/prompt overrides:', err.message);
}

// A site's notification clicked (Gmail, Slack, a calendar): Chrome brings that site's tab to the front, Electron only tells the
// page. Each `new Notification` gets a click listener that asks main to show this tab. Only a real click counts (isTrusted): a page
// dispatching its own 'click' can't pull its tab forward. The page's own onclick still runs as before.
const NOTIFY_KEY = '__lumenNotifyBridge_7c2e91';
if (!onGoogleAccounts) contextBridge.exposeInMainWorld(NOTIFY_KEY, { clicked: () => ipcRenderer.send('page-notification:click') });
function wrapNotifications(bridgeKey) {
  const bridge = window[bridgeKey];
  delete window[bridgeKey];
  const Native = window.Notification;
  if (typeof Native !== 'function' || !bridge) return;
  const Wrapped = new Proxy(Native, {
    construct(target, args, newTarget) {
      const n = Reflect.construct(target, args, newTarget === Wrapped ? target : newTarget);
      n.addEventListener('click', (e) => { if (e.isTrusted) bridge.clicked(); });
      return n;
    },
  });
  Object.defineProperty(window, 'Notification', { value: Wrapped, writable: true, configurable: true, enumerable: false });
}
try {
  if (!onGoogleAccounts) contextBridge.executeInMainWorld({ func: wrapNotifications, args: [NOTIFY_KEY] });
} catch { /* the page keeps the plain Notification */ }

// FedCM: Electron has none, so a page that sees its API (IdentityCredential) waits for a sign-in prompt that never
// comes. main.js turns the feature off; if a Chromium version ever ignores that switch, the API is removed here too,
// and Google's sign-in scripts use their iframe prompt instead.
try {
  contextBridge.executeInMainWorld({ func: () => { try { if ('IdentityCredential' in window) delete window.IdentityCredential; } catch { /* not removable */ } } });
} catch { /* nothing to remove */ }
