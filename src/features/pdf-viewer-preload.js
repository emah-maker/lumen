// Keeps electron-chrome-extensions out of Chromium's built-in PDF viewer. The library's preload
// runs in every chrome-extension:// page and swaps in its own chrome.tabs and friends (then freezes
// `chrome`). The PDF viewer is a component extension that needs Chromium's real APIs to fetch the
// document, so with the library's versions it stayed on "loading" with 0 pages: every PDF opened
// as a blank grey tab. Chrome never gives its own viewer third-party extension APIs either.
// The library exposes a main-world `electron` object before injecting anything; taking that name
// first makes its contextBridge call throw, and the library skips this page (it logs one
// "injectExtensionAPIs error" to the viewer's console and nothing else happens).
// Registered session-wide as a 'frame' preload before the library's (main.js setupExtensions).
const { contextBridge } = require('electron');

const PDF_VIEWER = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai';

if (location.origin === PDF_VIEWER) {
  contextBridge.exposeInMainWorld('electron', Object.freeze({}));
}
