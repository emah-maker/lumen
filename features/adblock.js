// ---------- ad blocker (built into the browser, uBlock Origin-compatible lists) ----------
//
// Built so anti-adblock scripts see nothing:
//  - it runs in the main process: no extension, globals or DOM nodes for a site to fingerprint;
//  - cosmetic rules go in as user-origin CSS (invisible to document.styleSheets);
//  - uBlock's scriptlets run at document start, before the page's own scripts (adblock-preload.js);
//  - a blocked script, image, XHR/fetch or frame gets a harmless stand-in (uBlock's noop.js,
//    1x1.gif, or the list's $redirect resource, e.g. a fake adsbygoogle) instead of a network
//    error, so "did the ad script load?" checks see it load. Chromium refuses webRequest redirects
//    to data: URLs, so stand-ins are served from a private scheme that skips page CSP.
// What can still tell: a CORS fetch's response.url shows the stand-in scheme, and ads that never
// render (a site measuring its ad slot after the ad should have filled it).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const electron = require('electron');

// Must be registered before the app is ready, and Electron keeps only the last call's list:
// electron-chrome-extensions registers crx (it loads earlier in main.js), so it is repeated here.
const STUB = 'lumen-res';
if (electron.protocol?.registerSchemesAsPrivileged && !electron.app.isReady()) {
  electron.protocol.registerSchemesAsPrivileged([
    { scheme: 'crx', privileges: { bypassCSP: true } },
    { scheme: STUB, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } },
  ]);
}

// A blocked request with no $redirect in the lists: the stand-in that makes it "succeed" quietly.
// Other types (media, websockets, pings, fonts…) are cancelled; pages rarely watch those.
const STAND_IN = { script: 'noop.js', image: '1x1.gif', xhr: 'noop.txt', subFrame: 'noop.html' };
// Ad libraries whose absence anti-adblock checks look for: stand-ins that define their API.
const LIBRARIES = [
  [/\/\/pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js/, 'googlesyndication_adsbygoogle.js'],
  [/\/\/(securepubads\.g\.doubleclick\.net|www\.googletagservices\.com)\/tag\/js\/gpt\.js/, 'googletagservices_gpt.js'],
  [/\/\/www\.google-analytics\.com\/analytics\.js/, 'google-analytics_analytics.js'],
  [/\/\/www\.googletagmanager\.com\/gtm\.js/, 'googletagmanager_gtm.js'],
];

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

  // Stand-in bodies by key: a few dozen at most (one per resource used).
  const stubs = new Map();
  function stubUrl(resource) {
    const key = crypto.createHash('sha1').update(resource.contentType).update(resource.body).digest('hex').slice(0, 16);
    if (!stubs.has(key)) {
      const base64 = /;base64/.test(resource.contentType);
      stubs.set(key, { type: resource.contentType.split(';')[0], body: Buffer.from(resource.body, base64 ? 'base64' : 'utf8') });
    }
    return `${STUB}://r/${key}${path.extname(resource.filename || '')}`;
  }
  function serveStubs(ses) {
    ses.protocol.handle(STUB, (req) => {
      const stub = stubs.get(path.basename(new URL(req.url).pathname).replace(/\.[^.]*$/, ''));
      if (!stub) return new Response(null, { status: 404 });
      // A CORS fetch that was redirected here needs its origin echoed back (credentials allowed).
      const origin = req.headers.get('origin');
      return new Response(stub.body, {
        headers: {
          'content-type': stub.type,
          'cache-control': 'max-age=86400',
          ...(origin ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' } : {}),
        },
      });
    });
  }

  async function setup() {
    const { ElectronBlocker, fromElectronDetails } = require('@ghostery/adblocker-electron');
    blocker = await ElectronBlocker.fromPrebuiltFull(fetch, {
      path: path.join(deps.app.getPath('userData'), 'adblock-engine.bin'),
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
    if (process.env.CLAUDE_BROWSER_TEST) global.__adblockEngine = blocker;
    blocker.onBeforeRequest = (details, callback) => {
      const page = details.webContents?.getURL() || details.referrer || '';
      if (!on(page) || details.resourceType === 'mainFrame') return callback({});
      const request = fromElectronDetails(details);
      if (request.type === 'other') request.guessTypeOfRequest();
      const { redirect, match } = blocker.match(request);
      if (!redirect && !match) return callback({});
      const id = details.webContents?.id;
      if (id !== undefined) blockedCount.set(id, (blockedCount.get(id) || 0) + 1);
      if (redirect) return callback({ redirectURL: stubUrl(redirect) });
      const library = details.resourceType === 'script' && LIBRARIES.find(([re]) => re.test(details.url));
      const name = library ? library[1] : STAND_IN[details.resourceType];
      callback(name ? { redirectURL: stubUrl(blocker.resources.getResource(name)) } : { cancel: true });
    };
    // Scriptlets for a frame, asked for synchronously by adblock-preload.js at document start.
    const { parse } = require('tldts-experimental');
    // (The first assignment to returnValue sends the reply, so it is assigned exactly once.)
    const scriptletsFor = (event, url) => {
      if (typeof url !== 'string' || !on(url)) return [];
      const { hostname, domain } = parse(url);
      try {
        return blocker.getCosmeticsFilters({
          url, hostname: hostname || '', domain: domain || '',
          getBaseRules: false, getInjectionRules: true, getExtendedRules: false, getRulesFromHostname: true, getRulesFromDOM: false,
          callerContext: { frameId: event.frameId, processId: event.processId },
        }).scripts;
      } catch {
        return [];
      }
    };
    electron.ipcMain.on('lumen-adblock:scriptlets', (event, url) => { event.returnValue = scriptletsFor(event, url); });
    // Ghostery's own preload still brings the CSS (and DOM-based updates); its scripts are dropped
    // here because adblock-preload.js already ran them, earlier.
    const cosmetics = blocker.onInjectCosmeticFilters;
    blocker.onInjectCosmeticFilters = async (event, url, msg) => {
      if (!on(url)) return undefined;
      const sender = { insertCSS: (css, options) => event.sender.insertCSS(css, options), executeJavaScript: () => Promise.resolve() };
      return cosmetics({ frameId: event.frameId, processId: event.processId, sender }, url, msg);
    };
    const headers = blocker.onHeadersReceived;
    blocker.onHeadersReceived = (details, callback) => {
      deps.onResponseHeaders(details); // [settings] sites asking for the color-scheme hint
      return on(details.webContents?.getURL() || details.url) ? headers(details, callback) : callback({});
    };
    serveStubs(deps.session.defaultSession);
    blocker.enableBlockingInSession(deps.session.defaultSession);
    deps.session.defaultSession.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'adblock-preload.js') });
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
    forget: (id) => blockedCount.delete(id), // a closed tab no longer counts toward total()
    total: () => [...blockedCount.values()].reduce((sum, n) => sum + n, 0), // on open tabs
  };
}

module.exports = { createAdblock, hostOf };
