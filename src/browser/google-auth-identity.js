// Google's sign-in pages refuse a Chrome-shaped Electron ("Couldn't sign you in - This browser or app may not be
// secure"), whatever the brands and client hints say. The one identity that gets through (as in Ferdium, nativefier
// and stablyai/orca) is Firefox, which has no client hints and no window.chrome to get wrong. A Firefox
// identity on every other site would trip anti-fraud checks, so it is scoped to Google's sign-in hosts:
//  - requests to those hosts: a Firefox User-Agent and no Sec-CH-UA* / Sec-CH-Prefers-* headers,
//  - pages on those hosts: navigator.userAgent, appVersion, platform, vendor, productSub, oscpu as Firefox has them,
//    navigator.userAgentData and window.chrome absent, navigator.webdriver false.
// Pure (no Electron): test/google-auth-identity-units.js. main.js applies it (applyChromeIdentity,
// setupHeaders in settings-backend.js, the private-window session).
/* global window, location */ // the patch functions are serialized into pages and run there

// accounts.google.com and its country forms (accounts.google.co.uk, accounts.google.com.au, accounts.google.de),
// the YouTube sign-in hop, and Google's verification (passkey / 2-step) host.
const HOST_SOURCE = '^(?:accounts\\.google\\.(?:com?\\.)?[a-z]{2,3}|accounts\\.youtube\\.com|gds\\.google\\.com)$'; // (\\. in a string: a literal dot in the RegExp)
const HOST_RE = new RegExp(HOST_SOURCE, 'i');
const isAuthHost = (host) => HOST_RE.test(String(host || ''));
function isAuthUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'wss:') && isAuthHost(u.hostname);
  } catch {
    return false;
  }
}

// Firefox ships every 4 weeks (Firefox 143: 2025-09-16). The version is worked out from the date so it does
// not go stale, one release behind the calculation: an old version is always real, a newer one may not exist yet.
const FIREFOX_BASE = { version: 143, released: Date.UTC(2025, 8, 16) };
const FOUR_WEEKS = 28 * 24 * 3600 * 1000;
function firefoxVersion(now = Date.now()) {
  const releases = Math.floor((now - FIREFOX_BASE.released) / FOUR_WEEKS);
  return Math.max(FIREFOX_BASE.version, FIREFOX_BASE.version + releases - 1);
}

// The same tokens Firefox itself reports (rv is the version; Windows and Linux say nothing of the architecture
// beyond x64 / x86_64, a Mac always says 10.15).
const PLATFORMS = {
  win32: { token: 'Windows NT 10.0; Win64; x64', appVersion: '5.0 (Windows)', platform: 'Win32', oscpu: 'Windows NT 10.0; Win64; x64' },
  darwin: { token: 'Macintosh; Intel Mac OS X 10.15', appVersion: '5.0 (Macintosh)', platform: 'MacIntel', oscpu: 'Intel Mac OS X 10.15' },
  linux: { token: 'X11; Linux x86_64', appVersion: '5.0 (X11)', platform: 'Linux x86_64', oscpu: 'Linux x86_64' },
};
function firefoxProfile(platform = process.platform, now = Date.now()) {
  const p = PLATFORMS[platform] || PLATFORMS.linux;
  const v = firefoxVersion(now);
  return {
    userAgent: `Mozilla/5.0 (${p.token}; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`,
    appVersion: p.appVersion, platform: p.platform, oscpu: p.oscpu,
    vendor: '', productSub: '20100101', buildID: '20181001000000',
  };
}

// `headers` (Electron's requestHeaders) as Firefox sends them to an auth host: its User-Agent, and none of the
// client hints Chrome sends (Firefox sends no Sec-CH-UA*, and Lumen adds Sec-CH-Prefers-Color-Scheme for Google).
function firefoxRequestHeaders(headers, profile) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (/^sec-ch-/i.test(name) || /^user-agent$/i.test(name)) continue;
    out[name] = value;
  }
  out['User-Agent'] = profile.userAgent;
  return out;
}

// Runs at document start in the page's main world; must stand alone (it is turned into source text). Does nothing
// off the auth hosts. Patched getters answer toString() like native ones.
function firefoxPatch(profile, hostSource) {
  try {
    if (!new RegExp(hostSource, 'i').test(location.hostname)) return;
    const shown = new WeakMap();
    const native = (fn) => { shown.set(fn, `function ${fn.name}() { [native code] }`); return fn; };
    const toString = Function.prototype.toString;
    const patched = new Proxy(toString, { apply: (target, self, args) => (shown.has(self) ? shown.get(self) : Reflect.apply(target, self, args)) });
    shown.set(patched, 'function toString() { [native code] }');
    Object.defineProperty(Function.prototype, 'toString', { value: patched, writable: true, configurable: true, enumerable: false });
    const proto = Navigator.prototype;
    const getter = (key, value) => {
      const get = Object.getOwnPropertyDescriptor({ get [key]() { return value; } }, key).get;
      Object.defineProperty(proto, key, { get: native(get), set: undefined, enumerable: true, configurable: true });
    };
    getter('userAgent', profile.userAgent);
    getter('appVersion', profile.appVersion);
    getter('platform', profile.platform);
    getter('vendor', profile.vendor);
    getter('productSub', profile.productSub);
    getter('oscpu', profile.oscpu);
    getter('buildID', profile.buildID);
    getter('webdriver', false);
    delete proto.userAgentData; // Firefox has no client hints object at all
    try { delete window.chrome; } catch { /* not configurable: left */ }
  } catch {
    // A page that locked something down: it keeps what it has.
  }
}
const firefoxScript = (profile) => `(${firefoxPatch})(${JSON.stringify(profile)}, ${JSON.stringify(HOST_SOURCE)});`;

module.exports = { HOST_SOURCE, isAuthHost, isAuthUrl, firefoxVersion, firefoxProfile, firefoxRequestHeaders, firefoxScript, firefoxPatch };
