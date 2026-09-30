// Keeps the Chrome Web Store page on electron-chrome-web-store's stand-ins for
// chrome.webstorePrivate and chrome.management (its preload exposes them as electronWebstore and
// electronManagement). Electron 44 before 44.4.0 (electron/electron#53776) also gives the store
// page Chromium's native webstorePrivate, which has no browser-side delegate in Electron: any call
// to it crashes the main process. The library swaps the native objects out once at page load, but
// Chromium puts them back whenever an extension loads, so the store's refresh right after
// "Add to Lumen" called the native getExtensionStatus and took Lumen down.
// Registered session-wide as a 'frame' preload (main.js setupExtensions). It can go once the
// castlabs Electron is 44.4.0 or later.
const { contextBridge } = require('electron');

function pinStoreApis() {
  const native = globalThis.chrome;
  if (!native) return;
  // Looked up on every access: the library's preload may expose its stand-ins after this runs.
  const overlay = (name, standIn) => new Proxy(native[name] || {}, {
    get(target, key) {
      const own = globalThis[standIn];
      if (own && key in own) return own[key];
      return Reflect.get(native[name] || target, key);
    },
  });
  const management = overlay('management', 'electronManagement');
  const runtime = overlay('runtime', 'electronRuntime');
  const chrome = new Proxy(native, {
    get(target, key) {
      if (key === 'webstorePrivate') return globalThis.electronWebstore; // never the native one
      if (key === 'management') return management;
      if (key === 'runtime') return runtime;
      return Reflect.get(target, key);
    },
  });
  Object.defineProperty(globalThis, 'chrome', { value: chrome, configurable: false, writable: false });
}

if (location.origin === 'https://chromewebstore.google.com') {
  contextBridge.executeInMainWorld({ func: pinStoreApis });
}
