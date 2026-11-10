// Manifest V2 extension pages (uBlock Origin's background page: features/ublock-mode.js), registered after electron-chrome-extensions'
// preload. Two Electron 44 gaps there, both fixed in Electron 45.1 (electron/electron#55155), which castlabs' Widevine builds don't have yet:
//  - The page runs without context isolation, so the library completes `chrome` (browserAction, contextMenus, webNavigation, windows…)
//    in place, but Chromium's own `browser` namespace stays bare, and uBlock Origin uses `browser` when there is one: it started with no
//    browserAction and stopped at once. Both names now give the completed object. The library also swaps webRequest.onHeadersReceived for
//    an event of its own that nothing sends; Chromium's (uBlock's csp= and media filters) comes back.
//  - chrome.webRequest gives every request tabId -1 ("no tab"), so uBlock took each as a background request and blocked nothing. The tab
//    is filled in from what the extension sees anyway: its content scripts' messages (the document and its tab), the tab's navigations
//    (webNavigation, from the library), and a page's own requests (its document, after the tab committed that origin).
//  - The library's chrome.tabs has no removeCSS (uBlock Origin takes its element-hiding rules back with it): it is added here, answered in
//    main.js with the frame-aware insertCSS (browser/extension-css.js).
// Pages with context isolation (Manifest V3, uBlock Origin Lite) are left alone: the library's preload covers them.
(() => {
  if (process.contextIsolated || !globalThis.location?.href.startsWith('chrome-extension://')) return;
  const completed = globalThis.chrome;
  if (!completed?.runtime?.getManifest || completed.runtime.getManifest().manifest_version !== 2) return;
  const native = globalThis.browser && globalThis.browser !== completed ? globalThis.browser : null;

  // ---- which tab a request belongs to
  const docTab = new Map(); // documentId -> tabId (the newest 2000)
  const remember = (documentId, tabId) => {
    if (!documentId || !(tabId >= 0)) return;
    docTab.delete(documentId);
    docTab.set(documentId, tabId);
    if (docTab.size > 2000) docTab.delete(docTab.keys().next().value);
  };
  const starting = []; // { tabId, url, at }: top-level navigations not yet requested
  const committed = new Map(); // tabId -> { origin, at, known }: the page each tab shows, and whether its document is known
  const originOf = (url) => { try { return new URL(url).origin; } catch { return ''; } };
  const tabFor = (d) => {
    if (d.type === 'main_frame') {
      const i = starting.findIndex((s) => s.url === d.url);
      if (i < 0) return -1;
      const [nav] = starting.splice(i, 1);
      return nav.tabId;
    }
    if (docTab.has(d.documentId)) return docTab.get(d.documentId);
    if (docTab.has(d.parentDocumentId)) { remember(d.documentId, docTab.get(d.parentDocumentId)); return docTab.get(d.documentId); }
    // A page's first requests can come before its content script has said which tab it is in: the tab that most recently committed a
    // page of the requester's origin, and whose document isn't known yet.
    if (d.frameType === 'outermost_frame' && d.documentId && d.initiator) {
      let best = null;
      for (const [tabId, c] of committed) if (!c.known && c.origin === d.initiator && (!best || c.at > best.at)) best = { tabId, at: c.at };
      if (best) { committed.get(best.tabId).known = true; remember(d.documentId, best.tabId); return best.tabId; }
    }
    return -1;
  };
  const learnFrom = (sender) => {
    if (!sender?.tab || !(sender.tab.id >= 0)) return;
    remember(sender.documentId, sender.tab.id);
    const c = committed.get(sender.tab.id);
    if (c && sender.frameId === 0) c.known = true;
  };
  try {
    completed.runtime.onMessage.addListener((_m, sender) => { learnFrom(sender); });
    completed.runtime.onConnect.addListener((port) => learnFrom(port.sender));
    const nav = completed.webNavigation;
    nav?.onBeforeNavigate?.addListener((n) => {
      if (n.frameId !== 0) return;
      starting.push({ tabId: n.tabId, url: n.url, at: Date.now() });
      while (starting.length > 50 || (starting.length && Date.now() - starting[0].at > 60000)) starting.shift();
    });
    nav?.onCommitted?.addListener((n) => { if (n.frameId === 0) committed.set(n.tabId, { origin: originOf(n.url), at: Date.now(), known: false }); });
    completed.tabs?.onRemoved?.addListener((tabId) => committed.delete(tabId));
  } catch (err) {
    console.error('[lumen] MV2 tab ids:', err);
  }

  const withTab = (listener) => function (details, ...rest) {
    if (details && details.tabId === -1) {
      const tabId = tabFor(details);
      if (tabId >= 0) details = { ...details, tabId };
    }
    return listener.call(this, details, ...rest);
  };
  const wrapped = new WeakMap(); // the extension's listener -> the one registered
  const event = (source) => source && {
    addListener(listener, ...rest) { if (!wrapped.has(listener)) wrapped.set(listener, withTab(listener)); source.addListener(wrapped.get(listener), ...rest); },
    removeListener(listener) { if (wrapped.has(listener)) source.removeListener(wrapped.get(listener)); },
    hasListener: (listener) => wrapped.has(listener) && source.hasListener(wrapped.get(listener)),
    hasListeners: () => source.hasListeners(),
  };
  const base = completed.webRequest;
  const replaced = {};
  if (base) {
    const webRequest = { ...base };
    if (native?.webRequest?.onHeadersReceived) webRequest.onHeadersReceived = native.webRequest.onHeadersReceived;
    for (const name of Object.keys(webRequest)) if (/^on[A-Z]/.test(name) && webRequest[name]?.addListener) webRequest[name] = event(webRequest[name]);
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
  const api = Object.keys(replaced).length
    ? Object.freeze(Object.assign(Object.create(Object.getPrototypeOf(completed)), Object.fromEntries(Object.keys(completed).map((k) => [k, completed[k]])), replaced))
    : completed;
  // `chrome` and `browser` both give it; a page assigning one to the other (uBlock's vapi.js) changes nothing.
  for (const name of ['chrome', 'browser']) {
    try { Object.defineProperty(globalThis, name, { get: () => api, set: () => {}, enumerable: true, configurable: false }); } catch (err) { console.error(`[lumen] MV2 ${name}:`, err); }
  }
})();
