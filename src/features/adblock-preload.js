// Ad blocker scriptlets at document start (features/adblock.js). Anti-adblock scripts run early, so
// uBlock's scriptlets (set-constant, abort-on-property-read, ...) must be in place before the
// page's first script: the rules are fetched synchronously and run in the page's world here,
// instead of after an async round trip. Nothing is left on window or in the DOM.
const { ipcRenderer, webFrame } = require('electron');

// Each scriptlet brings its own copy of shared helpers (safeSelf, proxyApplyFn...) as function
// declarations, so each runs in its own function scope, as Ghostery's injector does. At global
// scope a second proxyApplyFn scriptlet re-wraps Function.prototype.toString around the first
// one's proxy, both then resolve the global helper, and every toString() overflows the stack:
// YouTube never boots. The scope also keeps the helpers off window. They all get one
// scriptletGlobals object (uBlock's own arrangement: safeSelf's snapshot of the natives is then shared and
// taken before any scriptlet has patched them, see adblock-youtube.js shareSafeSelf) and a throw in one
// doesn't stop the others.
const wrap = (code) => `try{(function(scriptletGlobals){\n${code}\n})(shared)}catch{}`;

if (/^https?:$/.test(location.protocol)) {
  try {
    const scripts = ipcRenderer.sendSync('lumen-adblock:scriptlets', location.href) || [];
    if (scripts.length) {
      // One call for all of them (one hop into the page's world instead of one per scriptlet).
      webFrame.executeJavaScript(`(function () {\nconst shared = {};\n${scripts.map(wrap).join('\n')}\n})();`).catch((err) => {
        // Only a scriptlet that doesn't even parse rejects the whole script (nothing ran yet): then one by one.
        if (!/SyntaxError/.test(String((err && err.name) || err))) return;
        for (const code of scripts) webFrame.executeJavaScript(`(function () {\nconst shared = {};\n${wrap(code)}\n})();`).catch(() => {});
      });
    }
  } catch {
    // The main process isn't answering (shutting down): the page loads unfiltered.
  }
}
