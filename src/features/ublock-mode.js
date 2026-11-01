// [uBlock mode] Settings → Privacy and security → Ad blocker: Lumen's built-in blocker, or uBlock Origin Lite installed as the user's own extension.
//
// uBlock Origin Lite filters with Chromium's declarativeNetRequest, which Electron applies only while a session has no
// session.webRequest listener at all: one listener, of any event, turns every extension's request rules off for that session
// (tested on Electron 44: an onBeforeSendHeaders listener alone was enough). So in uBlock mode the main session carries none:
// Lumen's blocker, the page gate (Focus mode, Safe Browsing) and the request-headers step (Chrome hints, Do Not Track, GPC,
// third-party cookies) step aside there. Private windows and the research tabs have their own sessions, where no extension
// runs: Lumen's blocker stays on in those.
// uBlock Origin itself (Manifest V2) is no longer served by the Chrome Web Store, and its background page fails in Electron.
// Lumen adds none of uBlock's filters to its own engine: the extension does its own filtering.
// uBlock Origin Lite on the Chrome Web Store. (test/e2e/ublock-mode.js stands a small fixture in for it, served by its stand-in store:
// LUMEN_TEST_UBOL_ID counts only in a test run that has that stand-in, LUMEN_TEST_WEBSTORE_ORIGIN, see test-mode.js.)
const TEST_ID = process.env.CLAUDE_BROWSER_TEST && process.env.LUMEN_TEST_WEBSTORE_ORIGIN && /^[a-p]{32}$/.test(process.env.LUMEN_TEST_UBOL_ID || '') ? process.env.LUMEN_TEST_UBOL_ID : '';
const UBOL_ID = TEST_ID || 'ddkjiahejlhfcafbddmgiahcphecmpfh';
const MODES = ['lumen', 'ublock'];
// Every session.webRequest event: in uBlock mode the main session has a listener for none of them.
const EVENTS = ['onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onResponseStarted', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred'];

const modeOf = (settings) => (settings && settings.adBlocker === 'ublock' ? 'ublock' : 'lumen');

function clearListeners(ses) {
  for (const event of EVENTS) {
    try { ses.webRequest[event](null); } catch { /* the session is gone */ }
  }
}

// The switch, in the order that never leaves a gap with no blocker, and never runs both:
// to uBlock: installed (and its worker started) first, then Lumen steps aside; back: Lumen's hooks first, then the extension goes.
// deps: { extensions (session.extensions), install(id), uninstall(id), startWorker(id), pin(id), readSettings, writeSettings, applyHooks(), reloadPages() }
async function switchTo(mode, deps) {
  if (!MODES.includes(mode)) throw new Error('Invalid value for adBlocker');
  if (mode === 'ublock') {
    let ext = deps.extensions.getExtension(UBOL_ID);
    if (!ext) {
      try { ext = await deps.install(UBOL_ID); } catch (err) { throw new Error(`Couldn’t install uBlock Origin Lite: ${err?.message || err}`); }
    }
    if (!ext) throw new Error('Couldn’t install uBlock Origin Lite.');
    await Promise.resolve(deps.startWorker(UBOL_ID)).catch(() => {}); // (its worker turns its filter lists on)
    await Promise.resolve(deps.pin(UBOL_ID)).catch(() => {}); // its button in the toolbar: pause on a site, its popup
  }
  deps.writeSettings({ ...deps.readSettings(), adBlocker: mode });
  await deps.applyHooks(); // (Lumen's own request rules too, before pages reload)
  // (A removal that fails leaves an extension whose rules don't apply: Lumen's hooks are back on the session.)
  if (mode === 'lumen' && deps.extensions.getExtension(UBOL_ID)) await Promise.resolve(deps.uninstall(UBOL_ID)).catch((err) => console.error('[lumen] uBlock Origin Lite removal failed:', err?.message || err));
  deps.reloadPages();
}

module.exports = { UBOL_ID, MODES, EVENTS, modeOf, clearListeners, switchTo };
