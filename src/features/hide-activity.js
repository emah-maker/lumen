// "Hide when you leave the tab", "Hide your window size", "Protect against fingerprinting" and Global Privacy
// Control's script side (Settings → Privacy and security). The hiding itself is
// install() in preload/activity-preload.js, which reaches a page two ways:
//  - that preload, in every tab session: it asks 'hide-activity:config' (here) when a frame starts;
//  - a DevTools document-start script in every frame, other sites' frames included (preloads don't run in those):
//    main.js applyChromeIdentity hands each DevTools session to frameScripts.add(). The settings are written into the
//    script, so a change replaces it in every page Lumen has a session for (refresh()).
// Either way a change applies to pages loaded after it (a reload, or the next page).
const path = require('path');

const PRELOAD = path.join(__dirname, '..', 'preload', 'activity-preload.js');

// The fingerprint noise's secret: new each time Lumen starts, so a site's print changes between runs too.
const SEED = require('crypto').randomBytes(16).toString('hex');
const configOf = (p) => ({ tab: Boolean(p.hideTabActivity), size: Boolean(p.hideWindowSize), fp: Boolean(p.fingerprintProtection), gpc: Boolean(p.sendGpc), seed: SEED });
const anyOn = (c) => c.tab || c.size || c.fp || c.gpc;

// prefs(): the settings (settings-backend's prefs()).
function installIpc(ipcMain, prefs) {
  ipcMain.on('hide-activity:config', (event) => {
    try {
      event.returnValue = configOf(prefs());
    } catch {
      event.returnValue = {};
    }
  });
}

// The script's text for one setting state; it skips the pages the preload skips too.
function scriptSource(config) {
  const { install } = require(PRELOAD);
  return `(() => { try { if ((/^https?:$/.test(location.protocol) || location.protocol === 'about:') && !/(^|\\.)accounts\\.google\\.com$/.test(location.hostname)) (${install})(${JSON.stringify(config)}); } catch {} })();`;
}

function createFrameScripts(prefs) {
  // webContents -> { send, sessions: Map(sessionId ('' = the page's own) -> script identifier, or null while all are off) }
  const pages = new Map();

  async function put(page, key) {
    const config = configOf(prefs());
    if (!anyOn(config)) { page.sessions.set(key, null); return; }
    try {
      const { identifier } = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: scriptSource(config), runImmediately: true }, key || undefined);
      page.sessions.set(key, identifier || null);
    } catch {
      page.sessions.delete(key); // the frame went away (the preload still covers its page)
    }
  }

  // A DevTools session of `wc` (sessionId undefined: the page's own) whose Page domain is on. Kept even while all
  // the settings are off, so turning one on reaches the pages already open.
  function add(wc, send, sessionId) {
    let page = pages.get(wc);
    if (!page) {
      for (const old of pages.keys()) if (old.isDestroyed()) pages.delete(old); // (swept here, not by a 'destroyed' listener on every page)
      page = { send, sessions: new Map() };
      pages.set(wc, page);
    }
    return put(page, sessionId || '');
  }

  // The settings changed: every session's script is replaced (or removed: all off).
  async function refresh() {
    for (const [wc, page] of [...pages]) {
      if (wc.isDestroyed()) { pages.delete(wc); continue; }
      for (const [key, identifier] of [...page.sessions]) {
        if (identifier) await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, key || undefined).catch(() => {});
        await put(page, key);
      }
    }
  }

  return { add, refresh };
}

module.exports = { installIpc, createFrameScripts, scriptSource, PRELOAD };
