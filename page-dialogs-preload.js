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

contextBridge.exposeInMainWorld(BRIDGE_KEY, {
  request: (kind, message, defaultValue) => ipcRenderer.sendSync('page-dialog', { kind, message, defaultValue }),
});

// Runs in the main world (contextBridge.executeInMainWorld): installs alert/confirm/prompt that
// look and behave like the real, native ones.
function installOverrides(bridgeKey) {
  const bridge = window[bridgeKey];
  delete window[bridgeKey];

  const looksNative = (name, fn) => {
    Object.defineProperty(fn, 'toString', { value: () => `function ${name}() { [native code] }`, configurable: true, enumerable: false, writable: true });
    return fn;
  };
  const define = (name, fn) => Object.defineProperty(window, name, { value: looksNative(name, fn), writable: true, configurable: true, enumerable: false });

  define('alert', function alert(message) {
    bridge.request('alert', message === undefined ? '' : String(message));
  });
  define('confirm', function confirm(message) {
    return Boolean(bridge.request('confirm', message === undefined ? '' : String(message)));
  });
  define('prompt', function prompt(message, defaultValue) {
    return bridge.request('prompt', message === undefined ? '' : String(message), defaultValue === undefined ? '' : String(defaultValue));
  });
}

try {
  contextBridge.executeInMainWorld({ func: installOverrides, args: [BRIDGE_KEY] });
} catch (err) {
  console.error('page dialogs: could not install alert/confirm/prompt overrides:', err.message);
}
