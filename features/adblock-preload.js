// Ad blocker scriptlets at document start (features/adblock.js). Anti-adblock scripts run early, so
// uBlock's scriptlets (set-constant, abort-on-property-read, ...) must be in place before the
// page's first script: the rules are fetched synchronously and run in the page's world here,
// instead of after an async round trip. Nothing is left on window or in the DOM.
const { ipcRenderer, webFrame } = require('electron');

if (/^https?:$/.test(location.protocol)) {
  try {
    for (const code of ipcRenderer.sendSync('lumen-adblock:scriptlets', location.href) || []) {
      webFrame.executeJavaScript(code).catch(() => {});
    }
  } catch {
    // The main process isn't answering (shutting down): the page loads unfiltered.
  }
}
