// Manifest V2 extension pages (uBlock Origin's background page: features/ublock-mode.js), registered after electron-chrome-extensions'
// preload. What it still adds (measured on castlabs 45.2.1+wvcus with test/e2e/ublock-origin.js, each part turned off in turn, 2026-11-27):
//  - The page runs without context isolation, so the library completes `chrome` (browserAction, contextMenus, webNavigation, windows…)
//    in place, but Chromium's own `browser` namespace stays bare, and uBlock Origin uses `browser` when there is one: it starts with no
//    browserAction and stops at once (all 10 of that test's uBlock checks fail without it). Both names now give the completed object. The
//    library also swaps webRequest.onHeadersReceived for an event of its own that nothing sends; Chromium's (uBlock's csp= and media
//    filters) comes back. Both are the library's gaps, not Electron's.
//  - The library's chrome.tabs has no removeCSS (uBlock Origin takes its element-hiding rules back with it): it is added here, answered in
//    main.js with the frame-aware insertCSS (browser/extension-css.js).
//  - chrome.storage.managed is kept empty and read-only ([managed storage] below; Electron adds its own in 45.3, not yet in a castlabs build).
// Electron 45.1 fixed webRequest's tabId of -1 (electron/electron#55155), so the tab-filling code that was here is gone.
// Pages with context isolation (Manifest V3, uBlock Origin Lite) are left alone: the library's preload covers them.
(() => {
  if (process.contextIsolated || !globalThis.location?.href.startsWith('chrome-extension://')) return;
  const completed = globalThis.chrome;
  if (!completed?.runtime?.getManifest || completed.runtime.getManifest().manifest_version !== 2) return;
  const native = globalThis.browser && globalThis.browser !== completed ? globalThis.browser : null;

  const base = completed.webRequest;
  const replaced = {};
  if (base) {
    const webRequest = { ...base };
    if (native?.webRequest?.onHeadersReceived) webRequest.onHeadersReceived = native.webRequest.onHeadersReceived;
    replaced.webRequest = webRequest;
  }
  if (completed.tabs && typeof completed.tabs.removeCSS !== 'function') {
    const { ipcRenderer } = require('electron');
    const id = completed.runtime.id;
    const removeCSS = (tabId, details, callback) => {
      const done = ipcRenderer.invoke('crx-msg', id, 'tabs.removeCSS', tabId, details).then(() => undefined, () => undefined);
      if (typeof callback === 'function') { done.then(() => callback()); return undefined; }
      return done;
    };
    replaced.tabs = { ...completed.tabs, removeCSS };
  }
  // [managed storage] Electron answers chrome.storage.managed (admin policy settings) with the extension's own local storage. uBlock Origin
  // caches what managed.get returns in local storage under `cachedManagedStorage` at every start, so each start saved a copy of all its
  // storage, the previous copy included: it doubled until a ~1 GB value ran Lumen out of memory at startup, a minute after every launch
  // (2026-11-17). No policy is ever set in Lumen, so managed is empty and read-only here; a copy left from before is dropped (a no-op otherwise).
  if (completed.storage) {
    const reply = (value, args) => {
      const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      const done = Promise.resolve(value);
      if (callback) { done.then((v) => callback(v)); return undefined; }
      return done;
    };
    const readOnly = (...args) => {
      const callback = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
      if (callback) { setTimeout(() => callback()); return undefined; }
      return Promise.reject(new Error('This is a read-only store.'));
    };
    const noEvent = { addListener() {}, removeListener() {}, hasListener: () => false, hasListeners: () => false };
    const managed = Object.freeze({
      get: (...args) => reply({}, args), getBytesInUse: (...args) => reply(0, args),
      set: readOnly, remove: readOnly, clear: readOnly, setAccessLevel: readOnly, onChanged: noEvent,
    });
    // (Each area read off the real object: Chromium's lazy binding getters reject any other receiver.)
    const names = new Set(['local', 'sync', 'session', 'onChanged', ...Object.getOwnPropertyNames(completed.storage)]);
    for (const k in completed.storage) names.add(k);
    const storage = {};
    for (const k of names) { try { const v = completed.storage[k]; if (v !== undefined) storage[k] = v; } catch { /* not on this build */ } }
    storage.managed = managed;
    replaced.storage = Object.freeze(storage);
    try { completed.storage.local?.remove?.('cachedManagedStorage')?.catch?.(() => {}); } catch { /* no local storage */ }
  }
  const api = Object.keys(replaced).length
    ? Object.freeze(Object.assign(Object.create(Object.getPrototypeOf(completed)), Object.fromEntries(Object.keys(completed).map((k) => [k, completed[k]])), replaced))
    : completed;
  // `chrome` and `browser` both give it; a page assigning one to the other (uBlock's vapi.js) changes nothing.
  for (const name of ['chrome', 'browser']) {
    try { Object.defineProperty(globalThis, name, { get: () => api, set: () => {}, enumerable: true, configurable: false }); } catch (err) { console.error(`[lumen] MV2 ${name}:`, err); }
  }
})();
