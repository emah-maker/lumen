// Pure unit test for browser/google-auth-identity.js: the Firefox identity Google's sign-in hosts get (host list,
// date-derived Firefox version, User-Agent per platform, request-header rewrite, document-start patch run in vm).
// No Electron, no window.
const assert = require('assert');
const vm = require('vm');
const ga = require('../src/browser/google-auth-identity');
const chromeId = require('../src/browser/chrome-identity');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

// ---- hosts
for (const url of ['https://accounts.google.com/v3/signin/identifier', 'https://accounts.google.co.uk/', 'https://accounts.google.com.au/x', 'https://accounts.google.de/', 'https://accounts.youtube.com/accounts/CheckConnection', 'https://gds.google.com/']) {
  check(`host: ${url} is a sign-in host`, ga.isAuthUrl(url), url);
}
for (const url of ['https://www.google.com/', 'https://mail.google.com/', 'https://accounts.google.com.evil.com/', 'https://evilaccounts.google.com/', 'https://accounts.google.com@evil.com/', 'http://accounts.google.com/', 'https://notaccounts.youtube.com/', 'https://www.youtube.com/', 'about:blank', '', 'not a url']) {
  check(`host: ${JSON.stringify(url)} is not`, !ga.isAuthUrl(url), url);
}

// ---- Firefox version from the date: a real release, never ahead, never stale
{
  const v = (iso) => ga.firefoxVersion(Date.parse(iso));
  check('version: never below the base (143)', v('2025-01-01') === 143 && v('2025-09-16') === 143, `${v('2025-01-01')}`);
  check('version: one release behind the 4-week schedule', v('2025-10-14') === 143 && v('2025-11-11') === 144, `${v('2025-10-14')} ${v('2025-11-11')}`);
  check('version: 2026-09-30 is 155', v('2026-09-30') === 155, `${v('2026-09-30')}`);
  check('version: grows with the date', v('2030-06-01') > v('2028-01-01') && v('2028-01-01') > v('2026-09-30'), 'growth');
}

// ---- profile per platform
{
  const now = Date.parse('2026-09-30');
  const win = ga.firefoxProfile('win32', now);
  const mac = ga.firefoxProfile('darwin', now);
  const lin = ga.firefoxProfile('linux', now);
  check('ua: Windows', win.userAgent === 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0', win.userAgent);
  check('ua: macOS', mac.userAgent === 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:155.0) Gecko/20100101 Firefox/155.0', mac.userAgent);
  check('ua: Linux', lin.userAgent === 'Mozilla/5.0 (X11; Linux x86_64; rv:155.0) Gecko/20100101 Firefox/155.0', lin.userAgent);
  check('ua: no Chrome, Chromium, Electron, AppleWebKit or Safari token anywhere', [win, mac, lin].every((p) => !/chrome|chromium|electron|applewebkit|safari/i.test(JSON.stringify(p))), JSON.stringify(win));
  check('profile: platform, oscpu, appVersion as Firefox reports them', win.platform === 'Win32' && win.oscpu === 'Windows NT 10.0; Win64; x64' && win.appVersion === '5.0 (Windows)' && mac.platform === 'MacIntel' && mac.oscpu === 'Intel Mac OS X 10.15' && lin.platform === 'Linux x86_64' && win.vendor === '' && win.productSub === '20100101', JSON.stringify(mac));
}

// ---- request headers
{
  const profile = ga.firefoxProfile('win32', Date.parse('2026-09-30'));
  const input = {
    'sec-ch-ua': '"Chromium";v="1"', 'Sec-CH-UA-Mobile': '?0', 'Sec-CH-UA-Platform': '"Windows"', 'Sec-CH-UA-Full-Version-List': 'x',
    'Sec-CH-Prefers-Color-Scheme': '"dark"', 'user-agent': 'Chrome UA', Accept: '*/*', 'Accept-Language': 'en-US', Cookie: 'a=b',
  };
  const out = ga.firefoxRequestHeaders(input, profile);
  check('headers: Firefox User-Agent, once', out['User-Agent'] === profile.userAgent && Object.keys(out).filter((k) => /^user-agent$/i.test(k)).length === 1, JSON.stringify(out));
  check('headers: every Sec-CH-* removed, in any case', !Object.keys(out).some((k) => /^sec-ch-/i.test(k)), JSON.stringify(out));
  check('headers: the rest kept', out.Accept === '*/*' && out['Accept-Language'] === 'en-US' && out.Cookie === 'a=b', JSON.stringify(out));
  check('headers: the input is not modified', input['user-agent'] === 'Chrome UA' && 'sec-ch-ua' in input, 'mutated');
}

// ---- the document-start patch
{
  const profile = ga.firefoxProfile('win32', Date.parse('2026-09-30'));
  const page = (hostname, extra = '') => {
    const ctx = vm.createContext({});
    vm.runInContext(`
      globalThis.window = globalThis;
      function Navigator() {}
      const def = (k, v) => Object.defineProperty(Navigator.prototype, k, { get() { return v; }, configurable: true, enumerable: true });
      def('userAgent', 'Mozilla/5.0 Chrome/144.0.0.0 Safari/537.36'); def('appVersion', '5.0 Chrome'); def('platform', 'Win32'); def('vendor', 'Google Inc.');
      def('productSub', '20030107'); def('webdriver', true); def('userAgentData', { brands: [{ brand: 'Chromium', version: '144' }] });
      globalThis.Navigator = Navigator; globalThis.navigator = new Navigator();
      globalThis.location = { protocol: 'https:', hostname: ${JSON.stringify(hostname)} };
      globalThis.chrome = { runtime: {} };
      ${extra}`, ctx);
    return ctx;
  };
  const run = (ctx) => vm.runInContext(ga.firefoxScript(profile), ctx);
  const ctx = page('accounts.google.com');
  run(ctx);
  const get = (code) => vm.runInContext(code, ctx);
  check('patch: userAgent, appVersion, platform, vendor, productSub, oscpu are Firefox\'s', get('navigator.userAgent') === profile.userAgent && get('navigator.appVersion') === '5.0 (Windows)' && get('navigator.platform') === 'Win32' && get('navigator.vendor') === '' && get('navigator.productSub') === '20100101' && get('navigator.oscpu') === profile.oscpu, get('navigator.userAgent'));
  check('patch: userAgentData is undefined and not even "in" navigator', get('navigator.userAgentData') === undefined && get('"userAgentData" in navigator') === false, 'uad');
  check('patch: window.chrome is gone', get('typeof chrome') === 'undefined' && get('"chrome" in window') === false, 'chrome');
  check('patch: webdriver false', get('navigator.webdriver') === false, 'webdriver');
  check('patch: getters look native', get('String(Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent").get)') === 'function get userAgent() { [native code] }' && get('String(Function.prototype.toString)') === 'function toString() { [native code] }', get('String(Object.getOwnPropertyDescriptor(Navigator.prototype, "userAgent").get)'));
  check('patch: no own properties on navigator (all on the prototype, as in a browser)', get('Object.getOwnPropertyNames(navigator).length') === 0, 'own');
  run(ctx);
  check('patch: a second run changes nothing and throws nothing', get('navigator.userAgent') === profile.userAgent, 'twice');

  for (const host of ['accounts.youtube.com', 'accounts.google.co.uk']) {
    const c = page(host); run(c);
    check(`patch: runs on ${host}`, vm.runInContext('navigator.userAgent', c) === profile.userAgent, host);
  }
  for (const host of ['www.google.com', 'example.com', 'accounts.google.com.evil.com']) {
    const c = page(host); run(c);
    check(`patch: does nothing on ${host}`, vm.runInContext('navigator.userAgent', c).includes('Chrome') && vm.runInContext('typeof chrome', c) === 'object' && vm.runInContext('navigator.webdriver', c) === true, host);
  }

  // A locked-down page must not make it throw.
  const locked = page('accounts.google.com', 'Object.freeze(Navigator.prototype);');
  let threw = false;
  try { run(locked); } catch { threw = true; }
  check('patch: a locked-down page does not make it throw', !threw, 'threw');

  // The Chrome identity script leaves the same hosts alone (no window.chrome for them to find).
  const chromeCtx = page('accounts.google.com', 'delete globalThis.chrome;');
  vm.runInContext(chromeId.IDENTITY_SCRIPT, chromeCtx);
  check('chrome identity script: skips Google sign-in hosts (no window.chrome added, webdriver untouched)', vm.runInContext('typeof chrome', chromeCtx) === 'undefined' && vm.runInContext('navigator.webdriver', chromeCtx) === true, 'skipped');
  const other = page('example.com', 'delete globalThis.chrome; globalThis.performance = { timing: {}, getEntriesByType: () => [], getEntriesByName: () => [] };');
  vm.runInContext(chromeId.IDENTITY_SCRIPT, other);
  check('chrome identity script: still runs elsewhere', vm.runInContext('typeof chrome', other) === 'object' && vm.runInContext('navigator.webdriver', other) === false, 'elsewhere');
}

{
  const g = require('../src/browser/google-auth-identity');
  check('auth hosts: the dots are literal (a look-alike host is not an auth host)', g.isAuthHost('accounts.google.com') && g.isAuthHost('accounts.google.co.uk') && !g.isAuthHost('accountsxgoogle.com') && !g.isAuthHost('accounts-google.com') && !g.isAuthHost('gdsxgoogle.com') && !new RegExp(g.HOST_SOURCE, 'i').test('accountsXyoutube.com'), g.HOST_SOURCE);
}

assert.strictEqual(failures, 0, `${failures} google-auth-identity check(s) failed`);
console.log('google-auth-identity units: all passed');
