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
const { t } = require('./i18n');
const lists = require('./adblock-lists');
const youtube = require('./adblock-youtube');

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
  // Added to every engine (patched in once, then kept): the sign-in exceptions and YouTube's extra hiding rules.
  const ENGINE_PATCH = [...SIGN_IN_EXCEPTIONS, ...youtube.YOUTUBE_FILTERS];
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
    const inWorker = (refresh) => new Promise((resolve) => {
      let worker;
      try {
        worker = new (require('worker_threads').Worker)(path.join(__dirname, 'adblock-worker.js'), { workerData: { base, patched, exceptions: ENGINE_PATCH, patch: PATCH, refresh, sourceFile } });
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
      if (saved) blocker = saved;
      else {
        const built = await lists.buildEngineOrFallback(ElectronBlocker, fetch);
        blocker = built.engine;
        fs.promises.writeFile(base, blocker.serialize()).then(() => fs.promises.writeFile(sourceFile, built.source)).catch(() => {});
      }
      // Patched after the window is up (the network check below lets sign-in through meanwhile), then kept. Off the
      // main thread; only if a worker can't run is it patched here, in the idle time a few seconds in.
      setTimeout(async () => {
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
      if (details.resourceType === 'mainFrame' && deps.mainFrameGate) return deps.mainFrameGate(details, callback); // Safe Browsing
      const page = details.webContents?.getURL() || details.referrer || '';
      if (!on(page) || details.resourceType === 'mainFrame' || SIGN_IN.test(details.url)) return callback({});
      const request = fromElectronDetails(details);
      if (request.type === 'other') request.guessTypeOfRequest();
      const { redirect, match } = engine.match(request);
      if (!redirect && !match) return callback({});
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
      if (typeof url !== 'string' || !on(url)) return [];
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
        const scripts = youtube.withFallback(out, hostname);
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
      if (!on(url)) return undefined;
      const sender = { insertCSS: (css, options) => event.sender.insertCSS(css, options), executeJavaScript: () => Promise.resolve() };
      return cosmetics({ frameId: event.frameId, processId: event.processId, sender }, url, msg);
    };
    let headers = blocker.onHeadersReceived;
    blocker.onHeadersReceived = (details, callback) => {
      deps.onResponseHeaders(details); // [settings] sites asking for the color-scheme hint
      return on(details.webContents?.getURL() || details.url) ? headers(details, callback) : callback({});
    };
    serveStubs(deps.session.defaultSession);
    blocker.enableBlockingInSession(deps.session.defaultSession);
    deps.session.defaultSession.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, 'adblock-preload.js') });
    for (const ses of extraSessions) enableIn(ses);
  }

  // Another session that should be filtered like the default one (the research tabs' isolated session).
  // Before the engine has loaded it waits in the list; setup() then attaches it.
  const extraSessions = new Set();
  function enableIn(ses) {
    serveStubs(ses);
    // Not blocker.enableBlockingInSession(): a second call registers the library's ipcMain handlers again (they are
    // global, and already answer every session), which throws. The session-level parts are wired here instead.
    ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => blocker.onHeadersReceived(details, callback));
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => blocker.onBeforeRequest(details, callback));
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
    menu,
    ready: () => blocker !== null,
    blocked: (id) => blockedCount.get(id) || 0,
    resetCount: (id) => blockedCount.set(id, 0), // a new page starts at zero
    forget: (id) => blockedCount.delete(id), // the tab closed: its count leaves the total
    total: () => [...blockedCount.values()].reduce((sum, n) => sum + n, 0), // on open tabs
  };
}

module.exports = { createAdblock, hostOf };
