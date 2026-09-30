// The one identity Lumen gives every page: a stock Chrome of this Chromium's major version. The User-Agent
// string, navigator.userAgentData (brands, getHighEntropyValues), the Sec-CH-UA* request headers and the
// window.chrome object a Chrome page has all come from here, so they cannot disagree. Google's sign-in
// ("This browser or app may not be secure") compares them. Pure (no Electron): test/chrome-identity-units.js.

// Chrome's brand list, built the way Chromium builds it (GenerateBrandVersionList): the made-up
// "Not?A_Brand" entry and the order of the three both follow from the major version, so a hard-coded list
// gives Lumen away as soon as Chromium moves on. Chrome 144 gives Not(A:Brand/8, Chromium, Google Chrome.
const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
const GREASE_VERSIONS = ['8', '99', '24'];
const ORDERS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const majorOf = (chromeVersion) => String(chromeVersion).split('.')[0];

// full: the full-version list (every brand with its dotted version) instead of the major-only one.
function chromeBrands(chromeVersion, full) {
  const major = majorOf(chromeVersion);
  const seed = Number(major);
  const grease = GREASE_VERSIONS[seed % 3];
  const list = [
    { brand: `Not${GREASE_CHARS[seed % GREASE_CHARS.length]}A${GREASE_CHARS[(seed + 1) % GREASE_CHARS.length]}Brand`, version: full ? `${grease}.0.0.0` : grease },
    { brand: 'Chromium', version: full ? chromeVersion : major },
    { brand: 'Google Chrome', version: full ? chromeVersion : major },
  ];
  const order = ORDERS[seed % 6];
  const shuffled = [];
  list.forEach((b, i) => { shuffled[order[i]] = b; });
  return shuffled;
}

// Chrome's (reduced) User-Agent: the platform token and the major version; minor parts are always 0.
const UA_PLATFORM = { win32: 'Windows NT 10.0; Win64; x64', darwin: 'Macintosh; Intel Mac OS X 10_15_7' };
const userAgent = (platform, chromeVersion) =>
  `Mozilla/5.0 (${UA_PLATFORM[platform] || 'X11; Linux x86_64'}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorOf(chromeVersion)}.0.0.0 Safari/537.36`;

// What Chrome reports as Windows' platformVersion (the UniversalApiContract version, not "10.0"): 10.0.0 or lower on
// Windows 10, 13-14 on Windows 11 21H2, 15 on 22H2/23H2, 19 on 24H2 and later. Read from the build number.
function windowsPlatformVersion(release) {
  const build = Number(String(release).split('.')[2]) || 0;
  return build >= 26100 ? '19.0.0' : build >= 22621 ? '15.0.0' : build >= 22000 ? '14.0.0' : '10.0.0';
}

// navigator.userAgentData, in the shape DevTools' Emulation.setUserAgentOverride takes.
// { chromeVersion, platform (process.platform), arch (process.arch), release (os.release()), systemVersion (macOS) }
function uaMetadata({ chromeVersion, platform, arch, release = '', systemVersion = '' }) {
  return {
    brands: chromeBrands(chromeVersion, false),
    fullVersionList: chromeBrands(chromeVersion, true),
    platform: { win32: 'Windows', darwin: 'macOS' }[platform] || 'Linux',
    // Chrome on a Mac reports the real macOS version (26.0.0), not an empty string.
    platformVersion: platform === 'win32' ? windowsPlatformVersion(release) : platform === 'darwin' ? systemVersion : '',
    architecture: arch === 'arm64' ? 'arm' : 'x86', // Chrome on Apple Silicon says "arm"
    bitness: '64',
    model: '',
    mobile: false,
    wow64: false,
    formFactors: ['Desktop'],
  };
}

// ---------------------------------------------------------------- request headers

const brandList = (brands) => brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
const quoted = (s) => `"${s}"`;
const flag = (b) => (b ? '?1' : '?0');

// The three hints Chrome sends on every request to a secure origin, unasked.
function lowEntropyHeaders(meta) {
  return { 'Sec-CH-UA': brandList(meta.brands), 'Sec-CH-UA-Mobile': flag(meta.mobile), 'Sec-CH-UA-Platform': quoted(meta.platform) };
}

// The rest, sent only to an origin whose response asked for them (Accept-CH), as Chrome does. Electron has no
// client-hints store, so Chromium never sends any of these itself; Google asks for all of them.
const HIGH_ENTROPY = {
  'sec-ch-ua-arch': (m) => ['Sec-CH-UA-Arch', quoted(m.architecture)],
  'sec-ch-ua-bitness': (m) => ['Sec-CH-UA-Bitness', quoted(m.bitness)],
  'sec-ch-ua-full-version': (m) => ['Sec-CH-UA-Full-Version', quoted(m.fullVersionList.find((b) => b.brand === 'Google Chrome').version)],
  'sec-ch-ua-full-version-list': (m) => ['Sec-CH-UA-Full-Version-List', brandList(m.fullVersionList)],
  'sec-ch-ua-model': (m) => ['Sec-CH-UA-Model', quoted(m.model)],
  'sec-ch-ua-platform-version': (m) => ['Sec-CH-UA-Platform-Version', quoted(m.platformVersion)],
  'sec-ch-ua-wow64': (m) => ['Sec-CH-UA-WoW64', flag(m.wow64)],
  'sec-ch-ua-form-factors': (m) => ['Sec-CH-UA-Form-Factors', m.formFactors.map(quoted).join(', ')],
};
// The hint names in an Accept-CH / Critical-CH header value that are user-agent hints we can answer.
function requestedHints(value) {
  return String(value || '').toLowerCase().split(',').map((s) => s.trim()).filter((s) => Object.hasOwn(HIGH_ENTROPY, s));
}
function highEntropyHeaders(meta, hints) {
  const out = {};
  for (const name of hints) if (Object.hasOwn(HIGH_ENTROPY, name)) { const [key, value] = HIGH_ENTROPY[name](meta); out[key] = value; }
  return out;
}

// `headers` with every Sec-CH-UA* hint replaced by `hints` and put first, where Chrome puts them (before
// Upgrade-Insecure-Requests and User-Agent); appended at the end they are an order no Chrome produces.
function withHints(headers, hints) {
  const out = { ...hints };
  for (const [name, value] of Object.entries(headers)) if (!/^sec-ch-ua(-[a-z0-9-]+)?$/i.test(name)) out[name] = value;
  return out;
}

// ---------------------------------------------------------------- what the page's own JavaScript sees

// Runs at document start in every frame's main world (DevTools' Page.addScriptToEvaluateOnNewDocument), after
// being turned into source text: it must stand alone. Gives a page what Chrome has and Electron lacks, and
// nothing else; every step checks first, so a page that already has it is left alone.
//  - navigator.webdriver false (remote debugging makes it true unless --disable-blink-features=AutomationControlled
//    took effect in that renderer),
//  - window.chrome with app, csi and loadTimes (Electron pages have no window.chrome; Google looks for it),
//  - the functions it adds answer toString() like native ones.
function identityPatch(skipHostSource) {
  try {
    if (/^(file|lumen|chrome-extension|chrome|devtools):$/.test(location.protocol)) return;
    if (new RegExp(skipHostSource, 'i').test(location.hostname)) return; // Google's sign-in hosts get a Firefox identity instead (google-auth-identity.js)
    const shown = new WeakMap(); // function -> the text toString() gives for it
    const native = (fn) => { shown.set(fn, `function ${fn.name}() { [native code] }`); return fn; };
    const toString = Function.prototype.toString;
    const patched = new Proxy(toString, { apply: (target, self, args) => (shown.has(self) ? shown.get(self) : Reflect.apply(target, self, args)) });
    shown.set(patched, 'function toString() { [native code] }');
    Object.defineProperty(Function.prototype, 'toString', { value: patched, writable: true, configurable: true, enumerable: false });
    const define = (object, key, value) => Object.defineProperty(object, key, { value, writable: true, enumerable: true, configurable: true });

    if (navigator.webdriver) {
      const get = Object.getOwnPropertyDescriptor({ get webdriver() { return false; } }, 'webdriver').get;
      Object.defineProperty(Navigator.prototype, 'webdriver', { get: native(get), set: undefined, enumerable: true, configurable: true });
    }

    if (!window.chrome) Object.defineProperty(window, 'chrome', { value: {}, writable: true, enumerable: true, configurable: false });
    const chrome = window.chrome;
    if (chrome && typeof chrome === 'object') {
      if (!chrome.app) {
        define(chrome, 'app', {
          isInstalled: false,
          InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
          RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
          ...{
            getDetails() { return null; },
            getIsInstalled() { return false; },
            installState(callback) { if (typeof callback === 'function') setTimeout(() => callback('not_installed'), 0); },
            runningState() { return 'cannot_run'; },
          },
        });
        for (const key of ['getDetails', 'getIsInstalled', 'installState', 'runningState']) native(chrome.app[key]);
      }
      if (!chrome.csi) {
        define(chrome, 'csi', native({
          csi() {
            const t = performance.timing;
            return { startE: t.navigationStart, onloadT: t.domContentLoadedEventEnd, pageT: Date.now() - t.navigationStart, tran: 15 };
          },
        }.csi));
      }
      if (!chrome.loadTimes) {
        define(chrome, 'loadTimes', native({
          loadTimes() {
            const t = performance.timing;
            const nav = performance.getEntriesByType('navigation')[0];
            const paint = performance.getEntriesByName('first-paint')[0];
            const protocol = (nav && nav.nextHopProtocol) || 'h2';
            const spdy = protocol === 'h2' || protocol === 'h3';
            const s = (ms) => ms / 1000;
            return {
              commitLoadTime: s(t.responseStart), connectionInfo: protocol, finishDocumentLoadTime: s(t.domContentLoadedEventEnd),
              finishLoadTime: s(t.loadEventEnd), firstPaintAfterLoadTime: 0, firstPaintTime: paint ? s(t.navigationStart + paint.startTime) : 0,
              navigationType: 'Other', npnNegotiatedProtocol: protocol, requestTime: s(t.requestStart), startLoadTime: s(t.requestStart),
              wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: spdy, wasNpnNegotiated: spdy,
            };
          },
        }.loadTimes));
      }
    }
  } catch {
    // A page that locked something down: it keeps what it has.
  }
}
const IDENTITY_SCRIPT = `(${identityPatch})(${JSON.stringify(require('./google-auth-identity').HOST_SOURCE)});`;

module.exports = {
  chromeBrands, userAgent, windowsPlatformVersion, uaMetadata,
  lowEntropyHeaders, highEntropyHeaders, requestedHints, withHints, HIGH_ENTROPY,
  IDENTITY_SCRIPT,
};
