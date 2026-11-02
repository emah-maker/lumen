// [uBlock mode] uBlock Origin from its GitHub releases (src/features/ublock-origin.js) and the CRX check it relies on (src/features/crx.js):
// a signed package installs where the store's extensions live with its key kept; a changed, unsigned or other publisher's package is refused;
// the daily update looks once a day and installs only a newer release. Plain Node: the stand-in fixture packed on the spot, a fake fetch.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildCrx } = require('../fixtures/extensions/build-crx');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'extensions', 'ublock-origin-standin');
const signed = buildCrx(FIXTURE);
// (The stand-in's key counts as uBlock Origin's only in a test run that also names its own release list: ublock-origin.js.)
Object.assign(process.env, { CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_UBO_RELEASES: 'http://127.0.0.1:9/releases', LUMEN_TEST_UBO_ID: signed.id });
const UO = require('../../src/features/ublock-origin');
const { readCrx, idFromKey } = require('../../src/features/crx');
const U = require('../../src/features/ublock-mode');

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail ?? ''}`}`); if (!ok) failures++; };
const rejects = async (fn, pattern) => { try { await fn(); return false; } catch (err) { return pattern.test(err.message) || err.message; } };

// A fetch that serves the release list and the package from memory.
const fakeFetch = (files) => async (url) => {
  const body = files[url];
  if (body === undefined) return { ok: false, status: 404 };
  return { ok: true, status: 200, json: async () => body, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
};
const release = (version, name = `uBlock0_${version}.chromium.crx`) => ({ tag_name: version, assets: [{ name: `uBlock0_${version}.chromium.zip`, browser_download_url: 'https://x/zip' }, { name, browser_download_url: `https://x/${name}` }] });

(async () => {
  // ---- crx.js
  const crx = readCrx(signed.crx);
  check('readCrx: a signed package gives the id its key makes, the key, and the zip', crx.id === signed.id && idFromKey(Buffer.from(crx.publicKey, 'base64')) === signed.id && crx.zip.length > 100, crx.id);
  const tampered = Buffer.from(signed.crx); tampered[tampered.length - 40] ^= 1;
  check('readCrx: a package changed after signing is refused', await rejects(() => readCrx(tampered), /signature is invalid/));
  check('readCrx: something that is not a package is refused', await rejects(() => readCrx(Buffer.from('<html>Not Found</html>')), /Not a Chrome extension package/));
  const crx2 = Buffer.from(signed.crx); crx2.writeUInt32LE(2, 4);
  check('readCrx: an old CRX2 package is refused', await rejects(() => readCrx(crx2), /Unsupported/));

  // ---- ublock-origin.js
  check('the real id is gorhill\'s release key (outside tests)', require('child_process').execFileSync(process.execPath, ['-e', "process.stdout.write(require('./src/features/ublock-origin').UBO_ID)"], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, CLAUDE_BROWSER_TEST: '', LUMEN_TEST_UBO_ID: '' } }).toString() === 'fkgkibajhfbepljeaefdnfnegdcjomkh');
  check('the release list is GitHub\'s latest full release (outside tests)', require('child_process').execFileSync(process.execPath, ['-e', "process.stdout.write(require('./src/features/ublock-origin').RELEASES)"], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, CLAUDE_BROWSER_TEST: '' } }).toString() === 'https://api.github.com/repos/gorhill/uBlock/releases/latest');
  check('newer: by number, part by part', UO.newer('1.75.2', '1.75.0') && UO.newer('1.76.0', '1.75.9') && UO.newer('2.0', '1.99.99') && !UO.newer('1.75.0', '1.75.0') && !UO.newer('1.74.9', '1.75.0'));

  const latest = await UO.latestRelease(fakeFetch({ [UO.RELEASES]: release('1.75.2') }));
  check('latestRelease: the Chromium CRX of the latest release (not the zip)', latest.version === '1.75.2' && latest.url === 'https://x/uBlock0_1.75.2.chromium.crx', JSON.stringify(latest));
  check('latestRelease: a release with no Chromium package is an error', await rejects(() => UO.latestRelease(fakeFetch({ [UO.RELEASES]: { tag_name: '9', assets: [] } })), /no Chromium package/));
  check('latestRelease: GitHub refusing (rate limit) is an error', await rejects(() => UO.latestRelease(fakeFetch({})), /GitHub answered 404/));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ubo-units-'));
  try {
    const at = await UO.install('https://x/a.crx', dir, fakeFetch({ 'https://x/a.crx': signed.crx }));
    const manifest = JSON.parse(fs.readFileSync(path.join(at, 'manifest.json'), 'utf8'));
    check('install: unpacked where the store keeps extensions (Extensions/<id>/<version>_0)', at === path.join(dir, signed.id, '1.0.0_0') && fs.existsSync(path.join(at, 'background.js')), at);
    check('install: manifest.key set, so it keeps its id when loaded from disk', manifest.key === crx.publicKey && idFromKey(Buffer.from(manifest.key, 'base64')) === signed.id);
    check('install: no download folder left behind', fs.readdirSync(path.join(dir, signed.id)).join() === '1.0.0_0', fs.readdirSync(path.join(dir, signed.id)).join());

    const other = buildCrx(FIXTURE); // (same files, another key: someone else's build)
    check('install: a package signed by another key is refused', await rejects(() => UO.install('https://x/b.crx', dir, fakeFetch({ 'https://x/b.crx': other.crx })), /not signed by uBlock Origin/));
    check('install: a changed package is refused', await rejects(() => UO.install('https://x/c.crx', dir, fakeFetch({ 'https://x/c.crx': tampered })), /signature is invalid/));
    check('install: a failed download is an error', await rejects(() => UO.install('https://x/missing.crx', dir, fakeFetch({})), /download failed/));
    check('install: the installed version is untouched by the refusals', fs.readdirSync(path.join(dir, signed.id)).join() === '1.0.0_0');

    fs.mkdirSync(path.join(dir, signed.id, '0.9.0_0'));
    UO.prune(dir, at);
    check('prune: other versions\' folders go, the loaded one stays', fs.readdirSync(path.join(dir, signed.id)).join() === '1.0.0_0');

    // checkForUpdate: once a day, and only for a newer release
    let stamped = 0;
    const stamp = { read: () => stamped, write: (ms) => { stamped = ms; } };
    const files = { [UO.RELEASES]: release('1.0.0', 'uBlock0_1.0.0.chromium.crx'), 'https://x/uBlock0_1.0.0.chromium.crx': signed.crx };
    let looked = 0;
    const counting = (f) => async (url) => { if (url === UO.RELEASES) looked++; return fakeFetch(f)(url); };
    check('checkForUpdate: the same version installs nothing', (await UO.checkForUpdate('1.0.0', dir, { stamp, fetchImpl: counting(files), now: 1e12 })) === null && looked === 1 && stamped === 1e12);
    check('checkForUpdate: within a day it doesn\'t look again', (await UO.checkForUpdate('0.1.0', dir, { stamp, fetchImpl: counting(files), now: 1e12 + 3600e3 })) === null && looked === 1);
    const updated = await UO.checkForUpdate('0.1.0', dir, { stamp, fetchImpl: counting(files), now: 1e12 + 25 * 3600e3 });
    check('checkForUpdate: a day later, a newer release is installed and its folder returned', updated === path.join(dir, signed.id, '1.0.0_0') && looked === 2, `${updated} ${looked}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- ublock-mode.js with uBlock Origin
  check('modes: Lumen\'s, uBlock Origin Lite, uBlock Origin', U.MODES.join() === 'lumen,ublock,ublock-origin');
  check('modeOf / extensionOf: uBlock Origin is its own mode, with its own extension', U.modeOf({ adBlocker: 'ublock-origin' }) === 'ublock-origin' && U.extensionOf('ublock-origin') === UO.UBO_ID && U.extensionOf('ublock') === U.UBOL_ID && U.extensionOf('lumen') === null);
  const world = (start, loaded) => {
    const log = [];
    let settings = { adBlocker: start };
    const have = new Set(loaded);
    const name = (id) => (id === U.UBOL_ID ? 'lite' : id === UO.UBO_ID ? 'origin' : id);
    return {
      log, have, settings: () => settings,
      deps: {
        extensions: { getExtension: (id) => (have.has(id) ? { id } : null) },
        install: async (id) => { log.push(`install ${name(id)}`); have.add(id); return { id }; },
        uninstall: async (id) => { log.push(`uninstall ${name(id)}`); have.delete(id); },
        startWorker: async (id) => { log.push(`worker ${name(id)}`); },
        pin: async (id) => { log.push(`pin ${name(id)}`); },
        readSettings: () => settings,
        writeSettings: (s) => { settings = s; log.push(`write ${s.adBlocker}`); },
        applyHooks: () => { log.push('hooks'); },
        reloadPages: () => { log.push('reload'); },
      },
    };
  };
  {
    const w = world('lumen', []);
    await U.switchTo('ublock-origin', w.deps);
    check('to uBlock Origin: installed and pinned (no worker: it has a background page) before Lumen steps aside', w.log.join(',') === 'install origin,pin origin,write ublock-origin,hooks,reload', w.log.join(','));
  }
  {
    const w = world('ublock', [U.UBOL_ID]);
    await U.switchTo('ublock-origin', w.deps);
    check('from Lite to uBlock Origin: the new one in place first, then Lite removed (never neither)', w.log.join(',') === 'install origin,pin origin,write ublock-origin,hooks,uninstall lite,reload' && !w.have.has(U.UBOL_ID), w.log.join(','));
  }
  {
    const w = world('ublock-origin', [UO.UBO_ID]);
    await U.switchTo('lumen', w.deps);
    check('back to Lumen from uBlock Origin: Lumen\'s hooks first, then it is removed', w.log.join(',') === 'write lumen,hooks,uninstall origin,reload', w.log.join(','));
  }
  {
    const w = world('lumen', []);
    w.deps.install = async () => { throw new Error('GitHub answered 403'); };
    check('install fails: says which, and nothing switched', await rejects(() => U.switchTo('ublock-origin', w.deps), /Couldn.t install uBlock Origin: GitHub answered 403/) && w.settings().adBlocker === 'lumen');
  }
  const SB = require('../../src/settings/settings-backend');
  {
    // main.js and settings-backend.js name the modes themselves (ublock-mode.js isn't loaded at start-up): the same list.
    const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8').match(/const blockerModeOf = [^\n]*/)?.[0] || '';
    const named = [...new Set([...main.matchAll(/adBlocker === '([\w-]+)'/g)].map((m) => m[1]))];
    check('main.js blockerModeOf knows every extension mode', named.join() === U.MODES.filter((m) => m !== 'lumen').join(), main);
  }
  check('settings: every mode is a valid value, and nothing else', U.MODES.every((m) => SB.validate('adBlocker', m) === m) && SB.validate('adBlocker', 'adguard') === null);

  console.log(failures ? `\n${failures} FAILED` : '\nAll uBlock Origin checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
