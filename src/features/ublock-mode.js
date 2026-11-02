// [uBlock mode] Settings → Privacy and security → Ad blocker: Lumen's built-in blocker, or uBlock Origin Lite or uBlock Origin installed as the user's own extension.
//
// uBlock Origin Lite filters with Chromium's declarativeNetRequest, which Electron applies only while a session has no
// session.webRequest listener at all: one listener, of any event, turns every extension's request rules off for that session
// (tested on Electron 44: an onBeforeSendHeaders listener alone was enough). So in uBlock mode the main session carries none:
// Lumen's blocker, the page gate (Focus mode, Safe Browsing) and the request-headers step (Chrome hints, Do Not Track, GPC,
// third-party cookies) step aside there. Private windows and the research tabs have their own sessions, where no extension
// runs: Lumen's blocker stays on in those.
// uBlock Origin itself (Manifest V2) blocks with chrome.webRequest, which Electron likewise gives an extension only on a session with no
// session.webRequest listener. The Chrome Web Store no longer serves it: it comes from its GitHub releases (features/ublock-origin.js).
// Lumen adds none of uBlock's filters to its own engine: the extension does its own filtering.
// uBlock Origin Lite on the Chrome Web Store. (test/e2e/ublock-mode.js stands a small fixture in for it, served by its stand-in store:
// LUMEN_TEST_UBOL_ID counts only in a test run that has that stand-in, LUMEN_TEST_WEBSTORE_ORIGIN, see test-mode.js.)
const TEST_ID = process.env.CLAUDE_BROWSER_TEST && process.env.LUMEN_TEST_WEBSTORE_ORIGIN && /^[a-p]{32}$/.test(process.env.LUMEN_TEST_UBOL_ID || '') ? process.env.LUMEN_TEST_UBOL_ID : '';
const UBOL_ID = TEST_ID || 'ddkjiahejlhfcafbddmgiahcphecmpfh';
const MODES = ['lumen', 'ublock', 'ublock-origin'];
// The extension each extension mode runs, and its name in messages.
const EXTENSIONS = { ublock: UBOL_ID, 'ublock-origin': require('./ublock-origin').UBO_ID };
const NAMES = { ublock: 'uBlock Origin Lite', 'ublock-origin': 'uBlock Origin' };
// Every session.webRequest event: in uBlock mode the main session has a listener for none of them.
const EVENTS = ['onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onResponseStarted', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred'];

const modeOf = (settings) => (settings && EXTENSIONS[settings.adBlocker] ? settings.adBlocker : 'lumen');
// The extension that blocks in this mode (none for Lumen's own blocker).
const extensionOf = (mode) => EXTENSIONS[mode] || null;

function clearListeners(ses) {
  for (const event of EVENTS) {
    try { ses.webRequest[event](null); } catch { /* the session is gone */ }
  }
}

// The switch, in the order that never leaves a gap with no blocker, and never runs both:
// to an extension: installed (and its worker started) first, then Lumen steps aside; back: Lumen's hooks first, then the extension goes.
// From one extension to the other: the new one first, then the old one goes (both run for that moment, never neither).
// deps: { extensions (session.extensions), install(id), uninstall(id), startWorker(id), pin(id), readSettings, writeSettings, applyHooks(), reloadPages() }
async function switchTo(mode, deps) {
  if (!MODES.includes(mode)) throw new Error('Invalid value for adBlocker');
  const id = extensionOf(mode);
  if (id) {
    let ext = deps.extensions.getExtension(id);
    if (!ext) {
      try { ext = await deps.install(id); } catch (err) { throw new Error(`Couldn’t install ${NAMES[mode]}: ${err?.message || err}`); }
    }
    if (!ext) throw new Error(`Couldn’t install ${NAMES[mode]}.`);
    if (mode === 'ublock') await Promise.resolve(deps.startWorker(id)).catch(() => {}); // (its worker turns its filter lists on; uBlock Origin has a background page)
    await Promise.resolve(deps.pin(id)).catch(() => {}); // its button in the toolbar: pause on a site, its popup
  }
  deps.writeSettings({ ...deps.readSettings(), adBlocker: mode });
  await deps.applyHooks(); // (Lumen's own request rules too, before pages reload)
  // (A removal that fails leaves an extension whose rules don't apply in Lumen's mode: Lumen's hooks are back on the session.)
  for (const [other, otherId] of Object.entries(EXTENSIONS)) {
    if (other === mode || !deps.extensions.getExtension(otherId)) continue;
    await Promise.resolve(deps.uninstall(otherId)).catch((err) => console.error(`[lumen] ${NAMES[other]} removal failed:`, err?.message || err));
  }
  deps.reloadPages();
}

module.exports = { UBOL_ID, MODES, NAMES, EXTENSIONS, EVENTS, modeOf, extensionOf, clearListeners, switchTo };
