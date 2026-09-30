// Ad blocker scriptlets at document start (features/adblock.js). Anti-adblock scripts run early, so
// uBlock's scriptlets (set-constant, abort-on-property-read, ...) must be in place before the
// page's first script: the rules are fetched synchronously and run in the page's world here,
// instead of after an async round trip. Nothing is left on window or in the DOM.
const { ipcRenderer, webFrame } = require('electron');

if (/^https?:$/.test(location.protocol)) {
  try {
    // Each scriptlet brings its own copy of shared helpers (safeSelf, proxyApplyFn...) as function
    // declarations, so each runs in its own function scope, as Ghostery's injector does. At global
    // scope a second proxyApplyFn scriptlet re-wraps Function.prototype.toString around the first
    // one's proxy, both then resolve the global helper, and every toString() overflows the stack:
    // YouTube never boots. The scope also keeps the helpers off window.
    for (const code of ipcRenderer.sendSync('lumen-adblock:scriptlets', location.href) || []) {
      webFrame.executeJavaScript(`(function () {\n${code}\n})();`).catch(() => {});
    }
  } catch {
    // The main process isn't answering (shutting down): the page loads unfiltered.
  }
}
