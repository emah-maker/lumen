// Pure unit test for browser/chrome-identity.js (the one Chrome identity every page, popup and frame gets: UA string,
// navigator.userAgentData, Sec-CH-UA* headers, window.chrome) and for the switches the automation launcher and
// prepareAutomation give the relaunched browser. No Electron, no window.
const assert = require('assert');
const vm = require('vm');
const { spawnSync } = require('child_process');
const path = require('path');
const id = require('../src/browser/chrome-identity');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const brandName = (b) => b.brand;

// ---- brands: built as Chromium builds them, for any major
{
  const show = (major, full = false) => id.chromeBrands(`${major}.0.7559.60`, full).map((b) => `${b.brand}/${b.version}`).join(', ');
  check('brands: Chrome 144', show(144) === 'Not(A:Brand/8, Chromium/144, Google Chrome/144', show(144));
  check('brands: Chrome 138 (the well-known Not)A;Brand)', show(138) === 'Not)A;Brand/8, Chromium/138, Google Chrome/138', show(138));
  check('brands: Chrome 141', show(141) === 'Chromium/141, Not?A_Brand/24, Google Chrome/141' || /Not\?A_Brand/.test(show(141)), show(141));
  check('brands: Chrome 152 (Chromium, Not?A_Brand/24, Google Chrome)', show(152) === 'Chromium/152, Not?A_Brand/24, Google Chrome/152', show(152));
  check('brands: full list carries the dotted version', show(144, true) === 'Not(A:Brand/8.0.0.0, Chromium/144.0.7559.60, Google Chrome/144.0.7559.60', show(144, true));
  let bad = '';
  for (let major = 100; major <= 220 && !bad; major++) {
    for (const full of [false, true]) {
      const list = id.chromeBrands(`${major}.0.1.2`, full);
      const names = list.map(brandName);
      const greased = list.filter((b) => /^Not.A.Brand$/.test(b.brand));
      if (list.length !== 3 || !names.includes('Chromium') || !names.includes('Google Chrome') || greased.length !== 1 || list.some((b) => b.version.split('.')[0] === '' )) bad = `${major} ${full} ${names}`;
      if (!full && list.some((b) => b.brand !== greased[0].brand && b.version !== String(major))) bad = `${major} versions`;
    }
  }
  check('brands: every major 100-220 has Chromium, Google Chrome and exactly one GREASE brand', !bad, bad);
}

// ---- UA string and metadata agree (UA, Sec-CH-UA, userAgentData)
{
  const chromeVersion = '144.0.7559.60';
  for (const [platform, arch, release, sys, uaToken, chPlatform, pv] of [
    ['win32', 'x64', '10.0.26200', '', 'Windows NT 10.0; Win64; x64', 'Windows', '19.0.0'],
    ['win32', 'x64', '10.0.22631', '', 'Windows NT 10.0; Win64; x64', 'Windows', '15.0.0'],
    ['win32', 'x64', '10.0.19045', '', 'Windows NT 10.0; Win64; x64', 'Windows', '10.0.0'],
    ['darwin', 'arm64', '', '26.0.0', 'Macintosh; Intel Mac OS X 10_15_7', 'macOS', '26.0.0'],
    ['linux', 'x64', '', '', 'X11; Linux x86_64', 'Linux', ''],
  ]) {
    const ua = id.userAgent(platform, chromeVersion);
    const meta = id.uaMetadata({ chromeVersion, platform, arch, release, systemVersion: sys });
    const headers = id.lowEntropyHeaders(meta);
    const uaMajor = /Chrome\/(\d+)\.0\.0\.0 Safari\/537\.36$/.exec(ua)?.[1];
    check(`identity ${platform}: UA is stock Chrome (${uaToken}), no Electron token`, ua.includes(`(${uaToken})`) && uaMajor === '144' && !/Electron|Lumen|HeadlessChrome/i.test(ua), ua);
    check(`identity ${platform}: userAgentData brands and Sec-CH-UA name the UA's major`, meta.brands.filter((b) => /Chrom/.test(b.brand)).every((b) => b.version === uaMajor) && headers['Sec-CH-UA'] === meta.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', '), headers['Sec-CH-UA']);
    check(`identity ${platform}: full version list ends in the real Chromium version`, meta.fullVersionList.filter((b) => /Chrom/.test(b.brand)).every((b) => b.version === chromeVersion), JSON.stringify(meta.fullVersionList));
    check(`identity ${platform}: platform ${chPlatform}, platformVersion ${pv || '(empty)'}, not mobile`, meta.platform === chPlatform && meta.platformVersion === pv && meta.mobile === false && headers['Sec-CH-UA-Platform'] === `"${chPlatform}"` && headers['Sec-CH-UA-Mobile'] === '?0', JSON.stringify([meta.platform, meta.platformVersion, headers]));
    check(`identity ${platform}: architecture ${arch === 'arm64' ? 'arm' : 'x86'}, 64-bit`, meta.architecture === (arch === 'arm64' ? 'arm' : 'x86') && meta.bitness === '64', JSON.stringify(meta));
    // What DevTools' Emulation.setUserAgentOverride requires of userAgentMetadata
    check(`identity ${platform}: metadata has every field DevTools requires`, ['brands', 'platform', 'platformVersion', 'architecture', 'model', 'mobile'].every((k) => k in meta), Object.keys(meta).join());
  }
  check('windows platformVersion thresholds', id.windowsPlatformVersion('10.0.26100') === '19.0.0' && id.windowsPlatformVersion('10.0.22621') === '15.0.0' && id.windowsPlatformVersion('10.0.22000') === '14.0.0' && id.windowsPlatformVersion('10.0.19045') === '10.0.0' && id.windowsPlatformVersion('') === '10.0.0', 'versions');
}

// ---- high-entropy hints follow Accept-CH, as Chrome's do
{
  const meta = id.uaMetadata({ chromeVersion: '144.0.7559.60', platform: 'win32', arch: 'x64', release: '10.0.26200' });
  const asked = id.requestedHints('Sec-CH-UA-Arch, Sec-CH-UA-Bitness, sec-ch-ua-full-version-list ,Sec-CH-UA-Model, Sec-CH-UA-Platform-Version, Sec-CH-UA-WoW64, Sec-CH-UA-Form-Factors, Sec-CH-Prefers-Color-Scheme, Foo');
  check('accept-ch: only user-agent hints are taken from it', asked.length === 7 && !asked.includes('sec-ch-prefers-color-scheme') && id.requestedHints('').length === 0 && id.requestedHints(undefined).length === 0, asked.join());
  const h = id.highEntropyHeaders(meta, asked);
  check('high entropy: values are what navigator.userAgentData.getHighEntropyValues gives',
    h['Sec-CH-UA-Arch'] === '"x86"' && h['Sec-CH-UA-Bitness'] === '"64"' && h['Sec-CH-UA-Model'] === '""' && h['Sec-CH-UA-Platform-Version'] === '"19.0.0"'
    && h['Sec-CH-UA-WoW64'] === '?0' && h['Sec-CH-UA-Form-Factors'] === '"Desktop"'
    && h['Sec-CH-UA-Full-Version-List'] === meta.fullVersionList.map((b) => `"${b.brand}";v="${b.version}"`).join(', '), JSON.stringify(h));
  check('high entropy: the full version header is Chrome\'s own', id.highEntropyHeaders(meta, ['sec-ch-ua-full-version'])['Sec-CH-UA-Full-Version'] === '"144.0.7559.60"', 'full');
  check('high entropy: an unknown name adds nothing (and cannot reach Object.prototype)', Object.keys(id.highEntropyHeaders(meta, ['x', '__proto__', 'constructor'])).length === 0, 'unknown');
}

// ---- header order and replacement
{
  const low = id.lowEntropyHeaders(id.uaMetadata({ chromeVersion: '144.0.1.2', platform: 'win32', arch: 'x64', release: '10.0.26200' }));
  const electron = { 'Upgrade-Insecure-Requests': '1', 'User-Agent': 'UA', Accept: '*/*', 'sec-ch-ua': '"Chromium";v="144"', 'Sec-CH-UA-Mobile': '?0', 'Sec-CH-UA-Platform': '"Windows"', 'Sec-CH-UA-Full-Version-List': 'old', 'Accept-Language': 'en' };
  const out = id.withHints(electron, low);
  const keys = Object.keys(out);
  check('headers: Sec-CH-UA* come first, in Chrome\'s order, before User-Agent', keys.slice(0, 3).join() === 'Sec-CH-UA,Sec-CH-UA-Mobile,Sec-CH-UA-Platform' && keys.indexOf('User-Agent') > 2, keys.join());
  check('headers: Electron\'s own hints (any case, any kind) are gone, the rest kept in order', out['Sec-CH-UA'] === low['Sec-CH-UA'] && !('sec-ch-ua' in out) && !('Sec-CH-UA-Full-Version-List' in out) && keys.slice(3).join() === 'Upgrade-Insecure-Requests,User-Agent,Accept,Accept-Language', keys.join());
  check('headers: the input object is not modified', electron['sec-ch-ua'] === '"Chromium";v="144"', 'mutated');
}

// ---- the document-start patch, run against a stand-in page
{
  const page = (extra = '') => {
    const ctx = vm.createContext({ setTimeout });
    vm.runInContext(`
      globalThis.window = globalThis;
      function Navigator() {}
      Object.defineProperty(Navigator.prototype, 'webdriver', { get() { return true; }, configurable: true, enumerable: true });
      globalThis.Navigator = Navigator; globalThis.navigator = new Navigator();
      globalThis.location = { protocol: 'https:' };
      globalThis.performance = { timing: { navigationStart: 1000, responseStart: 1100, requestStart: 1050, domContentLoadedEventEnd: 1500, loadEventEnd: 1600 },
        getEntriesByType: () => [{ nextHopProtocol: 'h2' }], getEntriesByName: () => [{ startTime: 200 }] };
      ${extra}`, ctx);
    return ctx;
  };
  const run = (ctx) => vm.runInContext(id.IDENTITY_SCRIPT, ctx);
  const ctx = page();
  run(ctx);
  const get = (code) => vm.runInContext(code, ctx);
  check('patch: navigator.webdriver is false (getter on Navigator.prototype, not an own property)', get('navigator.webdriver') === false && get('Object.getOwnPropertyNames(navigator).length') === 0 && get('Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver").enumerable') === true, 'webdriver');
  check('patch: window.chrome exists with app, csi and loadTimes', get('typeof chrome') === 'object' && get('chrome.app.isInstalled') === false && get('chrome.app.getIsInstalled()') === false && get('chrome.app.InstallState.INSTALLED') === 'installed' && get('typeof chrome.csi') === 'function' && get('typeof chrome.loadTimes') === 'function', 'chrome');
  check('patch: chrome.runtime is not invented (a page without an extension has none)', get('chrome.runtime') === undefined, 'runtime');
  check('patch: chrome.csi() and loadTimes() answer like Chrome\'s', get('chrome.csi().tran') === 15 && get('chrome.csi().startE') === 1000 && get('chrome.loadTimes().connectionInfo') === 'h2' && get('chrome.loadTimes().wasFetchedViaSpdy') === true && get('chrome.loadTimes().requestTime') === 1.05 && get('chrome.loadTimes().firstPaintTime') === 1.2, JSON.stringify(get('chrome.loadTimes()')));
  check('patch: the added functions look native to toString', get('String(chrome.loadTimes)') === 'function loadTimes() { [native code] }' && get('String(chrome.csi)') === 'function csi() { [native code] }' && get('String(Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver").get)') === 'function get webdriver() { [native code] }' && get('String(Function.prototype.toString)') === 'function toString() { [native code] }', get('String(chrome.loadTimes)'));
  check('patch: ordinary functions still print their source, and they are not constructible natives', get('String(function plain() { return 1; })').includes('return 1') && get('(() => { try { new chrome.loadTimes(); return false; } catch { return true; } })()') === true, 'toString');
  check('patch: window.chrome is a window property like Chrome\'s (writable, enumerable, not configurable)', JSON.stringify(get('(({ writable, enumerable, configurable }) => ({ writable, enumerable, configurable }))(Object.getOwnPropertyDescriptor(window, "chrome"))')) === '{"writable":true,"enumerable":true,"configurable":false}', 'descriptor');
  // Running it twice (a frame that navigates, a second injection) changes nothing and throws nothing.
  const before = get('chrome');
  run(ctx);
  check('patch: a second run leaves the same objects', get('chrome') === before && get('navigator.webdriver') === false, 'idempotent');

  // A page that already has window.chrome (an extension's, say) keeps it; only what is missing is added.
  const own = page('globalThis.chrome = { runtime: { id: "x" }, csi() { return "mine"; } };');
  run(own);
  check('patch: an existing window.chrome is kept, only missing parts added', vm.runInContext('chrome.runtime.id', own) === 'x' && vm.runInContext('chrome.csi()', own) === 'mine' && vm.runInContext('typeof chrome.loadTimes', own) === 'function' && vm.runInContext('chrome.app.isInstalled', own) === false, 'existing');

  // Lumen's own pages and file: documents are not touched.
  const local = page('location.protocol = "file:";');
  run(local);
  check('patch: file: and lumen: pages are left alone', vm.runInContext('typeof chrome', local) === 'undefined' && vm.runInContext('navigator.webdriver', local) === true, 'local');

  // A page where webdriver is already false does not get its prototype touched.
  const clean = page('Object.defineProperty(Navigator.prototype, "webdriver", { get() { return false; }, configurable: true, enumerable: true }); globalThis.__g = Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver").get;');
  run(clean);
  check('patch: webdriver already false means no change to it', vm.runInContext('Object.getOwnPropertyDescriptor(Navigator.prototype, "webdriver").get === __g', clean), 'untouched');

  // A page that froze Function.prototype or Navigator.prototype must not make the script throw into the page.
  const locked = page('Object.freeze(Navigator.prototype);');
  let threw = false;
  try { run(locked); } catch { threw = true; }
  check('patch: a locked-down page does not make it throw', !threw, 'threw');
}

// ---- the relaunched browser's switches
{
  const launcher = require('../src/automation/launcher');
  const argv = ['C:\\Program Files\\Lumen\\Lumen.exe', 'C:\\Users\\x\\AppData\\Local\\Lumen\\app\\src\\automation\\launcher.js', 'https://example.com/', '--new-window'];
  const args = launcher.browserArgs(argv);
  check('launcher: the browser gets the first process\'s arguments untouched', args.slice(0, 2).join() === 'https://example.com/,--new-window', args.join(' '));
  check('launcher: --disable-blink-features=AutomationControlled is passed explicitly (not inherited from the first process)', args.includes('--disable-blink-features=AutomationControlled'), args.join(' '));
  check('launcher: --disable-features=FedCm is passed explicitly', args.includes('--disable-features=FedCm'), args.join(' '));
  check('launcher: no debugging switch on its command line (prepareAutomation adds the pipe inside the browser)', !args.some((a) => /remote-debugging/.test(a)), args.join(' '));
  const first = ['Lumen.exe', 'app-dir', 'https://a.example/'];
  check('launcher: what the first process passes on is the launcher script plus its arguments', launcher.launcherArgs(first, ['https://l.example/']).join() === [require.resolve('../src/automation/launcher'), 'app-dir', 'https://a.example/', 'https://l.example/'].join(), launcher.launcherArgs(first).join());

  // prepareAutomation inside the launched browser (LUMEN_AUTOMATION_PIPE=1, as launcher.js sets it) and in the first process.
  const probe = (launched) => {
    const script = `
      const os = require('os'), fs = require('fs'), path = require('path');
      const { prepareAutomation } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'features', 'ai-agents'))});
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-id-'));
      const switches = [];
      const app = { getPath: () => dir, commandLine: { appendSwitch: (k, v) => switches.push(v === undefined ? k : k + '=' + v) } };
      const plan = prepareAutomation(app, { automationEnabled: true, automationPort: 9339 }, { platform: 'win32', env: {} });
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
      process.stdout.write(JSON.stringify({ plan: { relaunch: plan.relaunch, pipeFd: plan.pipeFd }, switches }));`;
    const env = { ...process.env };
    delete env.CLAUDE_BROWSER_TEST; delete env.LUMEN_TEST_LAUNCHER; delete env.LUMEN_AUTOMATION_INPROC;
    if (launched) env.LUMEN_AUTOMATION_PIPE = '1'; else delete env.LUMEN_AUTOMATION_PIPE;
    const r = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
    return r.status === 0 ? JSON.parse(r.stdout) : { error: r.stderr };
  };
  const child = probe(true);
  check('prepareAutomation in the launched browser: AutomationControlled off, then the debugging pipe', !child.error && child.switches.includes('disable-blink-features=AutomationControlled') && child.switches.includes('remote-debugging-pipe') && child.plan.pipeFd === launcher.LUMEN_FD && !child.plan.relaunch, JSON.stringify(child));
  const firstProc = probe(false);
  check('prepareAutomation in the first process: hands over and sets nothing (the relaunched browser decides for itself)', !firstProc.error && firstProc.plan.relaunch === true && firstProc.switches.length === 0, JSON.stringify(firstProc));
}

assert.strictEqual(failures, 0, `${failures} chrome-identity check(s) failed`);
console.log('chrome-identity units: all passed');
