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
const { parse: parseSite } = require('tldts-experimental');
const path = require('path');
const crypto = require('crypto');
const electron = require('electron');
const { t } = require('./i18n');
const lists = require('./adblock-lists');
const youtube = require('./adblock-youtube');
const googleAuth = require('../browser/google-auth-identity');
const pdfViewer = require('./pdf-viewer');

// Must be registered before the app is ready, and Electron keeps only the last call's list:
// electron-chrome-extensions registers crx (it loads earlier in main.js), so it is repeated here.
const STUB = 'lumen-res';
if (electron.protocol?.registerSchemesAsPrivileged && !electron.app.isReady()) {
  electron.protocol.registerSchemesAsPrivileged([
    { scheme: 'crx', privileges: { bypassCSP: true } },
    { scheme: STUB, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } },
    { scheme: 'lumen-dialog', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } }, // extensions' dialogs (browser/extension-dialogs.js SCHEME)
    { scheme: pdfViewer.SCHEME, privileges: pdfViewer.PRIVILEGES }, // Lumen's PDF viewer (features/pdf-viewer.js)
    { scheme: 'lumen-asr', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }, // Meeting helper on-device ASR
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

// What the network hook is asked about. Every request that reaches a main-process webRequest listener costs
// ~0.06 ms of IPC, so the loopback server a developer is working on never does (nothing there is an ad), and the
// private schemes (lumen-res:, extensions, data:, file:) are left out of the include list.
const REQUEST_URLS = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'];
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
const NOT_LOOPBACK = ['http', 'https', 'ws', 'wss'].flatMap((scheme) => LOOPBACK.map((host) => `${scheme}://${host}/*`));
// Ad blocker on: every web request. Off: only pages (Safe Browsing's check), the one thing left that needs them.
const FILTER_ALL = { urls: REQUEST_URLS, excludeUrls: NOT_LOOPBACK };
const FILTER_PAGES = { urls: ['http://*/*', 'https://*/*'], types: ['mainFrame'], excludeUrls: NOT_LOOPBACK };
// Response headers matter on documents only: the CSP rules and the Accept-CH hints a page asks for.
const FILTER_DOCUMENTS = { urls: REQUEST_URLS, types: ['mainFrame', 'subFrame'] };

// Web apps that rebuild thousands of nodes while scrolling and have no DOM-driven (generic class/id) ad rules worth the cost.
const CHURNY_APPS = /^https:\/\/open\.spotify\.com(?:[/?#]|$)/i;

const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
};

// `decide(pageUrl)` remembered per page URL (a page's many requests share one answer: no URL parsing for each). Bounded.
function pageMemo(decide, limit = 64) {
  const known = new Map();
  const get = (pageUrl) => {
    if (known.has(pageUrl)) return known.get(pageUrl);
    const out = decide(pageUrl);
    if (known.size >= limit) known.delete(known.keys().next().value);
    known.set(pageUrl, out);
    return out;
  };
  get.clear = () => known.clear();
  return get;
}

// deps: { app, session, readSettings, writeSettings, activeContents, realUrl, isWebUrl, onResponseHeaders, stepsAside(ses) }
// stepsAside(ses): true for a session where another blocker runs (uBlock mode's main session, features/ublock-mode.js): no listener and no filtering there.
function createAdblock(deps) {
  let blocker = null;
  const blockedCount = new Map(); // webContents id -> requests blocked on the current page

  // Asked on every request: the allow list's Set is rebuilt only when the setting changes.
  let memo = null;
  const NO_HOSTS = Object.freeze([]);
  function settings() {
    const s = (deps.peekSettings || deps.readSettings)();
    const { adblock = true, adblockAllow = NO_HOSTS } = s;
    if (memo && memo.adblock === adblock && memo.list === adblockAllow) return memo.out;
    memo = { adblock, list: adblockAllow, out: { enabled: adblock, allow: new Set(adblockAllow) } };
    return memo.out;
  }

  function on(pageUrl, ses) {
    const { enabled, allow } = settings();
    return enabled && !allow.has(hostOf(pageUrl)) && !(ses && deps.stepsAside?.(ses));
  }
  const senderSession = (event) => { try { return event.sender?.session; } catch { return undefined; } };
  // Whether requests from this page are filtered at all (on, and not a Google sign-in page): answered once per page URL
  // and settings state, not by parsing the page's URL for each of its requests.
  const pageDecisions = pageMemo((page) => on(page) && !googleAuth.isAuthUrl(page));
  let decidedFor = null;
  function filtersPage(page) {
    const state = settings();
    if (decidedFor !== state) { decidedFor = state; pageDecisions.clear(); }
    return pageDecisions(page);
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

  // Google sign-in on other sites: its One Tap iframe and container, and the scripts that draw the button.
  const SIGN_IN = /^https:\/\/(accounts\.google\.com\/gsi\/|apis\.google\.com\/js\/(platform|api|client)[.:])/;
  const SIGN_IN_EXCEPTIONS = [
    '@@||accounts.google.com/gsi/^',
    '@@||apis.google.com/js/platform.js^',
    '@@||apis.google.com/js/api.js^',
    '@@||apis.google.com/js/client.js^',
    '#@##credential_picker_container',
    '#@##credential_picker_iframe',
    '#@#iframe[src^="https://accounts.google.com/gsi/"]',
  ];
  // Added to every engine (patched in once, then kept): the sign-in exceptions, the human checks' and site fixes (adblock-lists.js) and YouTube's extra hiding rules.
  const ENGINE_PATCH = [...SIGN_IN_EXCEPTIONS, ...lists.HUMAN_CHECK_EXCEPTIONS, ...lists.SITE_FIXES, ...youtube.YOUTUBE_FILTERS];
  const LISTS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  async function setup() {
    const { ElectronBlocker, fromElectronDetails } = require('@ghostery/adblocker-electron');
    const base = path.join(deps.app.getPath('userData'), 'adblock-engine.bin');
    const patched = path.join(deps.app.getPath('userData'), 'adblock-engine-signin.bin');
    const PATCH = `2|${ENGINE_PATCH.join('|')}`;
    // Annoyance lists hide Google's One Tap prompt and block its sign-in script; signing in with Google on a site
    // must keep working, so those are always let through. Patching the engine takes ~0.4 s, so the patched engine
    // is kept (tagged with the lists it was built from) and a launch just loads it.
    try {
      const meta = JSON.parse(await fs.promises.readFile(`${patched}.json`, 'utf8'));
      const baseStat = await fs.promises.stat(base);
      if (meta.patch === PATCH && meta.baseMtime === baseStat.mtimeMs && meta.baseSize === baseStat.size) blocker = ElectronBlocker.deserialize(new Uint8Array(await fs.promises.readFile(patched)));
    } catch { blocker = null; }
    const isTest = require('../test-mode').isTest();
    // `blocker` is wired into the sessions once; `engine` is what matches requests and pages, and is swapped for a
    // freshly built one (patched, or from new lists) without re-wiring anything.
    // The swap's deserialize takes ~30-80 ms on the main thread: done when the user has been idle a couple of seconds.
    const whenIdle = () => new Promise((resolve) => {
      if (isTest) { resolve(); return; } // (tests don't wait for the machine to be idle)
      const started = Date.now();
      const check = () => {
        let idle;
        try { idle = electron.powerMonitor.getSystemIdleTime(); } catch { idle = 99; }
        if (idle >= 2 || Date.now() - started > 120000) resolve(); else setTimeout(check, 3000).unref?.();
      };
      check();
    });
    const loadPatched = async () => {
      await whenIdle();
      const fresh = ElectronBlocker.deserialize(new Uint8Array(await fs.promises.readFile(patched)));
      engine = fresh;
      cosmetics = fresh.onInjectCosmeticFilters;
      headers = fresh.onHeadersReceived;
      // The wired-in instance keeps only its handlers and config: its lists now point at the new engine's, so
      // the old engine's ~18 MB is freed instead of kept for the session.
      for (const key of Object.keys(blocker)) if (typeof blocker[key] !== 'function' && key !== 'config' && key !== 'contexts' && key in fresh) blocker[key] = fresh[key];
      if (isTest) global.__adblockEngine = fresh;
    };
    // The slow jobs run in a worker thread (features/adblock-worker.js); `refresh` fetches new lists first.
    const inWorker = (refresh, build = false) => new Promise((resolve) => {
      let worker;
      try {
        worker = new (require('worker_threads').Worker)(path.join(__dirname, 'adblock-worker.js'), { workerData: { base, patched, exceptions: ENGINE_PATCH, patch: PATCH, refresh, build, sourceFile } });
      } catch { resolve(false); return; }
      worker.once('message', (m) => { if (!m?.ok) console.error('[lumen] ad-block worker:', m?.error); resolve(Boolean(m?.ok)); });
      worker.once('error', (err) => { console.error('[lumen] ad-block worker failed:', err?.message || err); resolve(false); });
      worker.once('exit', () => resolve(false));
      worker.unref();
    });
    // Which lists the saved engine came from (adblock-lists.js): one from the library's old snapshot is replaced soon.
    const sourceFile = `${base}.src`;
    const sourceOf = () => fs.promises.readFile(sourceFile, 'utf8').then((s) => s.trim(), () => '');
    if (!blocker) {
      let saved = null;
      try { saved = ElectronBlocker.deserialize(new Uint8Array(await fs.promises.readFile(base))); } catch { /* none yet, or unreadable */ }
      let builtHere = false;
      if (saved) blocker = saved;
      else {
        // A first start: the lists are parsed into an engine (~0.7 s of work) in the worker, which saves it already patched, and main
        // loads that file (~50 ms). Only if the worker can't run is it built here (a freeze of the main process, once).
        if (await inWorker(false, true)) {
          try { blocker = ElectronBlocker.deserialize(new Uint8Array(await fs.promises.readFile(patched))); builtHere = true; } catch { blocker = null; }
        }
        if (!blocker) {
          const built = await lists.buildEngineOrFallback(ElectronBlocker, fetch);
          blocker = built.engine;
          fs.promises.writeFile(base, blocker.serialize()).then(() => fs.promises.writeFile(sourceFile, built.source)).catch(() => {});
        }
      }
      // Patched after the window is up (the network check below lets sign-in through meanwhile), then kept. Off the
      // main thread; only if a worker can't run is it patched here, in the idle time a few seconds in.
      if (!builtHere) setTimeout(async () => {
        if (await inWorker(false)) { await loadPatched().catch(() => {}); return; }
        try { engine.updateFromDiff({ added: ENGINE_PATCH }); } catch { return; }
        fs.promises.stat(base).then((st) => fs.promises.writeFile(patched, engine.serialize())
          .then(() => fs.promises.writeFile(`${patched}.json`, JSON.stringify({ patch: PATCH, baseMtime: st.mtimeMs, baseSize: st.size }))))
          .catch(() => {});
      }, 3000).unref?.();
    }
    // Lists a day old: new ones are fetched and built in the background (a minute in, then checked every few
    // hours while Lumen stays open), and used from then on.
    const refreshIfOld = async () => {
      const st = await fs.promises.stat(base).catch(() => null);
      const old = st && Date.now() - st.mtimeMs > LISTS_MAX_AGE_MS;
      if (st && (old || (await sourceOf()) !== lists.SOURCE) && (await inWorker(true))) await loadPatched().catch(() => {});
    };
    if (!isTest) {
      setTimeout(refreshIfOld, 60000).unref?.();
      setInterval(refreshIfOld, 6 * 60 * 60 * 1000).unref?.();
    }
    let engine = blocker;
    if (isTest) global.__adblockEngine = blocker;
    blocker.onBeforeRequest = (details, callback) => {
      const prefs = (deps.peekSettings || deps.readSettings)();
      // [tracking] utm_*, fbclid, gclid… off the address: the page loads at the clean one (which comes back through here).
      if (details.resourceType === 'mainFrame' && prefs.stripTrackingParams !== false && details.method === 'GET') {
        const clean = details.url.includes('?') ? require('./tracking-params').strip(details.url) : details.url; // (loaded at the first address with a query)
        if (clean !== details.url) return callback({ redirectURL: clean });
      }
      if (details.resourceType === 'mainFrame' && deps.mainFrameGate) return deps.mainFrameGate(details, callback); // Safe Browsing
      // [tracking] <a ping> and sendBeacon reports (type 'ping'), on every site, the allowed ones too.
      if (details.resourceType === 'ping' && prefs.blockTrackingPings !== false) return callback({ cancel: true });
      const page = details.webContents?.getURL() || details.referrer || '';
      // Google's own sign-in pages (accounts.google.com…) load everything they ask for: their risk check reads the
      // logging and script traffic a blocked list entry (play.google.com/log) would have removed.
      // So do the captcha and sign-in providers, on every site (challengeFor): a list entry for one of them leaves a blank frame, a
      // script that never ran or a request that dies, and the form behind the check fails.
      if (!filtersPage(page) || details.resourceType === 'mainFrame' || SIGN_IN.test(details.url) || challengeFor(page, details.url, details.resourceType) || spotifyOwn(details.url, details.resourceType, Boolean(details.webContents))) return callback({});
      // A form posted into a frame is the person's submission, never an ad: a stand-in would swallow it.
      if (details.resourceType === 'subFrame' && details.method === 'POST') return callback({});
      const request = fromElectronDetails(details);
      if (request.type === 'other') request.guessTypeOfRequest();
      const { redirect, match } = engine.match(request);
      if (!redirect && !match) return callback({});
      // Whatever a captcha or sign-in frame itself loads (its worker, its proof script, its POSTs) goes through too.
      if (fromProviderFrame(details, page)) return callback({});
      const id = details.webContents?.id;
      if (id !== undefined) blockedCount.set(id, (blockedCount.get(id) || 0) + 1);
      if (redirect) return callback({ redirectURL: stubUrl(redirect) });
      const library = details.resourceType === 'script' && LIBRARIES.find(([re]) => re.test(details.url));
      const name = library ? library[1] : STAND_IN[details.resourceType];
      callback(name ? { redirectURL: stubUrl(engine.resources.getResource(name)) } : { cancel: true });
    };
    // Scriptlets for a frame, asked for synchronously by adblock-preload.js at document start.
    const { parse } = require('tldts-experimental');
    // (The first assignment to returnValue sends the reply, so it is assigned exactly once.)
    const scriptletsFor = (event, url) => {
      if (typeof url !== 'string' || !on(url, senderSession(event)) || isProviderUrl(url, true)) return [];
      const { hostname, domain } = parse(url);
      // (Scriptlets are chosen by host: remembered per host for this engine, so a page's many frames answer at once.)
      if (scriptletCache.engine !== engine) { scriptletCache.engine = engine; scriptletCache.map.clear(); }
      const cached = scriptletCache.map.get(hostname || '');
      if (cached) return cached;
      try {
        const out = engine.getCosmeticsFilters({
          url, hostname: hostname || '', domain: domain || '',
          getBaseRules: false, getInjectionRules: true, getExtendedRules: false, getRulesFromHostname: true, getRulesFromDOM: false,
          callerContext: { frameId: event.frameId, processId: event.processId },
        }).scripts;
        const scripts = youtube.withFallback(youtube.dedupe(out.map(youtube.prepareScriptlet)), hostname);
        if (scriptletCache.map.size > 300) scriptletCache.map.clear();
        scriptletCache.map.set(hostname || '', scripts);
        return scripts;
      } catch {
        return [];
      }
    };
    const scriptletCache = { engine: null, map: new Map() };
    electron.ipcMain.on('lumen-adblock:scriptlets', (event, url) => { event.returnValue = scriptletsFor(event, url); });
    // Ghostery's own preload still brings the CSS (and DOM-based updates); its scripts are dropped
    // here because adblock-preload.js already ran them, earlier.
    let cosmetics = blocker.onInjectCosmeticFilters;
    blocker.onInjectCosmeticFilters = async (event, url, msg) => {
      if (!on(url, senderSession(event)) || isProviderUrl(url, true)) return undefined;
      const sender = { insertCSS: (css, options) => event.sender.insertCSS(css, options), executeJavaScript: () => Promise.resolve() };
      return cosmetics({ frameId: event.frameId, processId: event.processId, sender }, url, msg);
    };
    // Ghostery's page script watches the whole DOM (class/id/href changes, subtree) to find new elements to hide, and scans every
    // added subtree on the page's main thread. A page where the blocker is off or that is allow-listed has nothing to hide, and a
    // virtualized web app (Spotify's player rebuilds its rows on every scroll) only pays for it as scroll jank: those pages get the
    // CSS from the first call (hostname rules) and no observer.
    const watchDom = blocker.onIsMutationObserverEnabled;
    blocker.onIsMutationObserverEnabled = async (event) => {
      let url = '';
      try { url = event.senderFrame?.url || event.sender?.getURL?.() || ''; } catch { /* a frame that is already gone */ }
      if (!on(url, senderSession(event)) || isProviderUrl(url, true) || CHURNY_APPS.test(url)) return false;
      return watchDom(event);
    };
    let headers = blocker.onHeadersReceived;
    blocker.onHeadersReceived = (details, callback) => {
      deps.onResponseHeaders(details); // [settings] sites asking for the color-scheme hint
      return on(details.webContents?.getURL() || details.url) && !challengeFor(details.webContents?.getURL() || '', details.url, details.resourceType) ? headers(details, callback) : callback({});
    };
    serveStubs(deps.session.defaultSession);
    blocker.enableBlockingInSession(deps.session.defaultSession);
    wireRequests(deps.session.defaultSession); // (replaces the library's all-URLs listeners with the narrow ones)
    deps.session.defaultSession.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'adblock-preload.js') });
    for (const ses of extraSessions) enableIn(ses);
  }

  // Another session that should be filtered like the default one (the research tabs' isolated session).
  // Before the engine has loaded it waits in the list; setup() then attaches it.
  const extraSessions = new Set();
  // The two network listeners of a session (Electron keeps one per event, so they are replaced, not added to).
  // Requests: all of them while the blocker is on, only pages while it is off. Response headers: documents.
  // A session where another blocker runs gets neither (removed: Electron would turn that blocker's rules off).
  let requestsOn = null; // what wireRequests last set up (on, and whether the main session steps aside)
  const wiring = () => `${settings().enabled}|${Boolean(deps.stepsAside?.(deps.session.defaultSession))}`;
  function wireRequests(ses) {
    const enabled = settings().enabled;
    requestsOn = wiring();
    if (deps.stepsAside?.(ses)) {
      ses.webRequest.onHeadersReceived(null);
      ses.webRequest.onBeforeRequest(null);
      return;
    }
    ses.webRequest.onHeadersReceived(FILTER_DOCUMENTS, (details, callback) => blocker.onHeadersReceived(details, callback));
    ses.webRequest.onBeforeRequest(enabled ? FILTER_ALL : FILTER_PAGES, (details, callback) => blocker.onBeforeRequest(details, callback));
  }
  // The blocker was switched on or off, or uBlock mode changed: the listeners follow (called when settings are written).
  function sync() {
    if (!blocker || requestsOn === wiring()) return;
    for (const ses of [deps.session.defaultSession, ...extraSessions]) wireRequests(ses);
  }
  function enableIn(ses) {
    serveStubs(ses);
    // Not blocker.enableBlockingInSession(): a second call registers the library's ipcMain handlers again (they are
    // global, and already answer every session), which throws. The session-level parts are wired here instead.
    wireRequests(ses);
    try { ses.registerPreloadScript({ type: 'frame', filePath: require.resolve('@ghostery/adblocker-electron-preload') }); } catch { /* cosmetic CSS only */ }
    ses.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'adblock-preload.js') });
  }
  function attachSession(ses) {
    if (extraSessions.has(ses)) return;
    extraSessions.add(ses);
    if (blocker) enableIn(ses);
  }
  // A private window's session, as that window closes: no longer kept in the list.
  function detachSession(ses) {
    extraSessions.delete(ses);
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
      { label: blocker ? t('adblock.count', { count }) : t('adblock.loading'), enabled: false },
      { type: 'separator' },
      { label: t('adblock.toggle'), type: 'checkbox', checked: enabled, click: () => save({ adblock: !enabled }) },
      ...(host && deps.isWebUrl(deps.realUrl(wc))
        ? [{
            label: t('adblock.allowOn', { host }),
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
    attachSession,
    detachSession,
    sync,
    menu,
    ready: () => blocker !== null,
    probe: (details) => new Promise((resolve) => blocker.onBeforeRequest(details, resolve)), // (tests: what the request hook says about a request: {}, { cancel } or { redirectURL })
    blocked: (id) => blockedCount.get(id) || 0,
    resetCount: (id) => blockedCount.set(id, 0), // a new page starts at zero
    forget: (id) => blockedCount.delete(id), // the tab closed: its count leaves the total
    total: () => [...blockedCount.values()].reduce((sum, n) => sum + n, 0), // on open tabs
  };
}

// The captcha and sign-in providers other sites embed (hCaptcha, reCAPTCHA, Cloudflare Turnstile, Arkose / FunCaptcha, GeeTest, DataDome's
// check, Friendly Captcha, MTCaptcha; Microsoft, Apple, Okta, Auth0, Azure AD B2C, OneLogin, Duo and Ping sign-in; any sso. / login. / auth. /
// accounts. host) are never filtered, on every site. A filter list entry for one of them leaves the person with a blank frame they cannot
// click, a proof-of-work script that never ran or a request that dies, and the form behind the check fails. Chrome with a blocker loads them
// the same way; this does not depend on the lists being current.
const PROVIDER_DOMAINS = ['hcaptcha.com', 'recaptcha.net', 'arkoselabs.com', 'funcaptcha.com', 'geetest.com', 'friendlycaptcha.com', 'friendlycaptcha.eu', 'mtcaptcha.com',
  'captcha-delivery.com', 'challenges.cloudflare.com', 'login.microsoftonline.com', 'login.live.com', 'appleid.apple.com', 'idmsa.apple.com', 'okta.com', 'oktapreview.com',
  'auth0.com', 'b2clogin.com', 'onelogin.com', 'duosecurity.com', 'pingone.com'];
const SIGN_IN_LABELS = ['sso', 'login', 'signin', 'sign-in', 'auth', 'accounts', 'idp', 'identity', 'oauth'];
const dotted = (list) => list.map((d) => d.replace(/\./g, '[.]')).join('|');
// The named providers: always.
const PROVIDER_URL = new RegExp('^https?://(?:'
  + '(?:[a-z0-9-]+[.])*(?:' + dotted(PROVIDER_DOMAINS) + ')(?=[:/?#]|$)'
  + '|(?:www[.])?(?:google|gstatic)[.]com(?::[0-9]+)?/recaptcha(?:/|$))', 'i');
// Any sso. / login. / auth. / accounts. host: a tracker could be served from one (auth.tracker.example), so it counts only as a page
// (a frame or navigation), or when it is the same site as the page that asked (sso.garmin.com on connect.garmin.com).
const SIGN_IN_HOST = new RegExp('^https?://(?:' + SIGN_IN_LABELS.join('|') + ')[.][a-z0-9.-]+(?=[:/?#]|$)', 'i');
const CHALLENGE_PATH = /\/cdn-cgi\/challenge-platform\//; // Cloudflare's check runs from the site's own address
// Spotify's own pictures and its API are never filtered: a card's cover art (a picture on scdn.co or spotifycdn.com) turned into the ad blocker's 1x1 stand-in shows as a
// blank square, and the cards' own requests (made by Lumen itself, with no page behind them) match third-party rules like a tracker would. Pictures on any page, and the
// API and picture requests of the cards (no page); nothing else of Spotify's (ads and logging) is let through.
const SPOTIFY_PICTURES = /^https:\/\/(?:[a-z0-9-]+[.])*(?:scdn[.]co|spotifycdn[.]com)\//i;
const SPOTIFY_API = /^https:\/\/(?:api|accounts)[.]spotify[.]com\//i;
const spotifyOwn = (url, type, hasPage) => (SPOTIFY_PICTURES.test(url) && (type === 'image' || !hasPage)) || (!hasPage && SPOTIFY_API.test(url));
const siteOf = (url) => { try { return parseSite(url).domain || ''; } catch { return ''; } };
const sameSite = (a, b) => { const x = siteOf(a); return Boolean(x) && x === siteOf(b); };
const isNavigation = (type) => type === 'mainFrame' || type === 'subFrame';
// url alone: the named providers, and (asDocument) a sign-in host as a page.
const isProviderUrl = (url, asDocument = false) => PROVIDER_URL.test(url) || CHALLENGE_PATH.test(url) || (asDocument && SIGN_IN_HOST.test(url));
const challengeFor = (page, url, type = 'other') => isProviderUrl(url) || (SIGN_IN_HOST.test(url) && (isNavigation(type) || sameSite(page, url)));
// The frame that sent a request (webRequest details name it): a named provider's page, or a sign-in page of the same site as the top page.
const fromProviderFrame = (details, page) => {
  try { const frameUrl = details.frame?.url; return Boolean(frameUrl) && (PROVIDER_URL.test(frameUrl) || (SIGN_IN_HOST.test(frameUrl) && sameSite(page, frameUrl))); } catch { return false; }
};

module.exports = { createAdblock, CHURNY_APPS, hostOf, pageMemo, challengeFor, isProviderUrl, spotifyOwn };
