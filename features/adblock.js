// ---------- ad blocker (built into the browser, uBlock Origin-compatible lists) ----------
//
// Runs in the main process, so there is no extension for sites to fingerprint. Cosmetic rules go
// in as user-origin CSS (invisible to document.styleSheets), and uBlock's scriptlets neutralize
// known anti-adblock scripts. Blocked requests are cancelled: Chromium refuses redirects to data:
// stand-ins, so a determined site can still notice a failed ad request.
const fs = require('fs');
const path = require('path');

const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
};

// deps: { app, session, readSettings, writeSettings, activeContents, realUrl, isWebUrl, onResponseHeaders }
function createAdblock(deps) {
  let blocker = null;
  const blockedCount = new Map(); // webContents id -> requests blocked on the current page

  function settings() {
    const { adblock = true, adblockAllow = [] } = deps.readSettings();
    return { enabled: adblock, allow: new Set(adblockAllow) };
  }

  function on(pageUrl) {
    const { enabled, allow } = settings();
    return enabled && !allow.has(hostOf(pageUrl));
  }

  async function setup() {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    blocker = await ElectronBlocker.fromPrebuiltFull(fetch, {
      path: path.join(deps.app.getPath('userData'), 'adblock-engine.bin'),
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
    const match = blocker.onBeforeRequest;
    blocker.onBeforeRequest = (details, callback) => {
      const page = details.webContents?.getURL() || details.referrer || '';
      if (!on(page)) return callback({});
      match(details, (result) => {
        if (!result.cancel && !result.redirectURL) return callback(result);
        const id = details.webContents?.id;
        if (id !== undefined) blockedCount.set(id, (blockedCount.get(id) || 0) + 1);
        callback(result);
      });
    };
    const cosmetics = blocker.onInjectCosmeticFilters;
    blocker.onInjectCosmeticFilters = async (event, url, msg) => (on(url) ? cosmetics(event, url, msg) : undefined);
    const headers = blocker.onHeadersReceived;
    blocker.onHeadersReceived = (details, callback) => {
      deps.onResponseHeaders(details); // [settings] sites asking for the color-scheme hint
      return on(details.webContents?.getURL() || details.url) ? headers(details, callback) : callback({});
    };
    blocker.enableBlockingInSession(deps.session.defaultSession);
  }

  function menu() {
    const wc = deps.activeContents();
    const host = wc ? hostOf(deps.realUrl(wc)) : '';
    const { enabled, allow } = settings();
    const save = (patch) => {
      deps.writeSettings({ ...deps.readSettings(), ...patch });
      wc?.reload();
    };
    const count = wc ? blockedCount.get(wc.id) || 0 : 0;
    return [
      { label: blocker ? `${count} blocked on this page` : 'Loading filter lists…', enabled: false },
      { type: 'separator' },
      { label: 'Block Ads and Trackers', type: 'checkbox', checked: enabled, click: () => save({ adblock: !enabled }) },
      ...(host && deps.isWebUrl(deps.realUrl(wc))
        ? [{
            label: `Allow Ads on ${host}`,
            type: 'checkbox',
            checked: allow.has(host),
            enabled,
            click: () => {
              if (allow.has(host)) allow.delete(host);
              else allow.add(host);
              save({ adblockAllow: [...allow] });
            },
          }]
        : []),
    ];
  }

  return {
    setup,
    menu,
    ready: () => blocker !== null,
    blocked: (id) => blockedCount.get(id) || 0,
    resetCount: (id) => blockedCount.set(id, 0), // a new page starts at zero
    total: () => [...blockedCount.values()].reduce((sum, n) => sum + n, 0), // on open tabs
  };
}

module.exports = { createAdblock, hostOf };
