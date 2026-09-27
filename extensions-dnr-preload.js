// Extension API gaps (Electron and electron-chrome-extensions): `browser` as an alias of `chrome`,
// and chrome.declarativeNetRequest (Electron has none). Many extensions that aren't
// content blockers (password managers, for example) call it for small things and fail when it's
// missing. This keeps their rules in memory and reports success; the rules are not applied to
// requests (Lumen's ad blocker does the blocking). Content blockers that rely on static rulesets
// are refused at install time instead (see isContentBlocker in main.js).
// Registered before electron-chrome-extensions' preload, which freezes `chrome` afterwards.
const { contextBridge, webFrame } = require('electron');

function dnrShim() {
  const chrome = globalThis.chrome;
  if (!chrome) return;
  // Chromium also exposes a native `browser` namespace, but the extension library fills in only
  // `chrome` (windows, tabs, action…), so extensions using `browser.windows` broke (1Password did).
  // Point `browser` at the same, completed `chrome` object.
  if (globalThis.browser !== chrome) {
    // A setter too: pages that assign their own `browser` (webextension-polyfill) keep theirs.
    let own;
    try { Object.defineProperty(globalThis, 'browser', { get: () => own ?? globalThis.chrome, set: (v) => { own = v; }, configurable: true }); } catch {}
  }
  if (chrome.declarativeNetRequest) return;
  const manifest = chrome.runtime?.getManifest?.() || {};
  const rulesets = manifest.declarative_net_request?.rule_resources || [];
  const enabled = new Set(rulesets.filter((r) => r.enabled).map((r) => r.id));
  const stores = { dynamic: new Map(), session: new Map() };
  const done = (cb, value) => { if (typeof cb === 'function') cb(value); return Promise.resolve(value); };
  const update = (store) => (options = {}, cb) => {
    for (const id of options.removeRuleIds || []) store.delete(id);
    for (const rule of options.addRules || []) store.set(rule.id, rule);
    return done(cb);
  };
  const list = (store) => (filter, cb) => {
    if (typeof filter === 'function') [cb, filter] = [filter, undefined];
    const rules = [...store.values()].filter((r) => !filter?.ruleIds || filter.ruleIds.includes(r.id));
    return done(cb, rules);
  };
  const event = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
  const api = {
    MAX_NUMBER_OF_RULES: 330000,
    GUARANTEED_MINIMUM_STATIC_RULES: 30000,
    MAX_NUMBER_OF_DYNAMIC_RULES: 30000,
    MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
    MAX_NUMBER_OF_SESSION_RULES: 5000,
    MAX_NUMBER_OF_UNSAFE_SESSION_RULES: 5000,
    MAX_NUMBER_OF_REGEX_RULES: 1000,
    MAX_NUMBER_OF_STATIC_RULESETS: 100,
    MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
    DYNAMIC_RULESET_ID: '_dynamic',
    SESSION_RULESET_ID: '_session',
    RuleActionType: { BLOCK: 'block', REDIRECT: 'redirect', ALLOW: 'allow', UPGRADE_SCHEME: 'upgradeScheme', MODIFY_HEADERS: 'modifyHeaders', ALLOW_ALL_REQUESTS: 'allowAllRequests' },
    ResourceType: { MAIN_FRAME: 'main_frame', SUB_FRAME: 'sub_frame', STYLESHEET: 'stylesheet', SCRIPT: 'script', IMAGE: 'image', FONT: 'font', OBJECT: 'object', XMLHTTPREQUEST: 'xmlhttprequest', PING: 'ping', CSP_REPORT: 'csp_report', MEDIA: 'media', WEBSOCKET: 'websocket', WEBTRANSPORT: 'webtransport', WEBBUNDLE: 'webbundle', OTHER: 'other' },
    HeaderOperation: { APPEND: 'append', SET: 'set', REMOVE: 'remove' },
    DomainType: { FIRST_PARTY: 'firstParty', THIRD_PARTY: 'thirdParty' },
    RequestMethod: { CONNECT: 'connect', DELETE: 'delete', GET: 'get', HEAD: 'head', OPTIONS: 'options', PATCH: 'patch', POST: 'post', PUT: 'put', OTHER: 'other' },
    UnsupportedRegexReason: { SYNTAX_ERROR: 'syntaxError', MEMORY_LIMIT_EXCEEDED: 'memoryLimitExceeded' },
    updateDynamicRules: update(stores.dynamic),
    updateSessionRules: update(stores.session),
    getDynamicRules: list(stores.dynamic),
    getSessionRules: list(stores.session),
    getEnabledRulesets: (cb) => done(cb, [...enabled]),
    updateEnabledRulesets: (options = {}, cb) => {
      for (const id of options.disableRulesetIds || []) enabled.delete(id);
      for (const id of options.enableRulesetIds || []) enabled.add(id);
      return done(cb);
    },
    updateStaticRules: (_options, cb) => done(cb),
    getDisabledRuleIds: (_options, cb) => done(cb, []),
    getAvailableStaticRuleCount: (cb) => done(cb, 30000),
    isRegexSupported: (_options, cb) => done(cb, { isSupported: true }),
    setExtensionActionOptions: (_options, cb) => done(cb),
    getMatchedRules: (_filter, cb) => done(typeof _filter === 'function' ? _filter : cb, { rulesMatchedInfo: [] }),
    testMatchOutcome: (_request, cb) => done(cb, { matchedRules: [] }),
    onRuleMatchedDebug: event(),
  };
  Object.defineProperty(chrome, 'declarativeNetRequest', { value: api, enumerable: true, configurable: true });
}

if (process.type === 'service-worker' || globalThis.location?.href.startsWith('chrome-extension://')) {
  try {
    if ('executeInMainWorld' in contextBridge) contextBridge.executeInMainWorld({ func: dnrShim });
    else webFrame.executeJavaScript(`(${dnrShim}());`);
  } catch (err) {
    console.error('declarativeNetRequest shim:', err);
  }
}
