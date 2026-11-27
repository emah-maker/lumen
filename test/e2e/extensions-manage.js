// Settings → Extensions: the on/off switch and Developer mode's Load unpacked, with no network. Two tiny MV3 fixtures: popup-ext (packed into a
// signed CRX on the spot and installed from a 127.0.0.1 stand-in for the store, as test/e2e/extensions.js does) and unpacked-ext (loaded from a
// copy of its folder in a temp dir, so the test can edit it). Covers:
//  - the install prompt and the unpacked prompt list optional_host_permissions (an audit finding: they were left out)
//  - manifest checks: no manifest, bad JSON, a bad version, a file it names that is missing
//  - off: unloaded from the session, still installed (its folder stays), listed as Off, its content script no longer runs, and still off after
//    a restart; on again: loaded, the script runs
//  - Developer mode: Load unpacked is hidden until it is on; the folder's permissions are shown before it loads; the user's folder is not
//    written to; Reload picks up an edit; a restart loads it again; Remove forgets it and leaves the folder
//  - [uBlock mode] the ad blocker's switch is refused (Settings → Ad blocker owns it)
// Run alone: LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1 node scripts/test/e2e-lock.js run --owner extensions-manage -- node test/e2e/extensions-manage.js (a throwaway profile; no window shows)
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { buildCrx } = require('../fixtures/extensions/build-crx');
const { openSettingsTab } = require('../helpers/settings-tab');
const { extensionPermissionLines } = require('../../src/browser/extension-permissions');
const { validateManifest, createManager } = require('../../src/browser/extension-manage');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn().catch(() => null); if (v) return v; await sleep(100); } return v; };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ext-manage-'));

  // ---- the prompts list optional_host_permissions
  const optional = extensionPermissionLines({ optional_host_permissions: ['https://optional.example.org/*'] });
  check('install prompt: optional_host_permissions are listed', optional.length === 1 && optional[0].includes('optional.example.org'), JSON.stringify(optional));
  check('install prompt: optional all-sites access is listed as all sites', extensionPermissionLines({ optional_host_permissions: ['<all_urls>'] })[0] === 'Read and change all your data on all websites');

  // ---- manifest checks
  const fixture = path.join(__dirname, '..', 'fixtures', 'extensions', 'unpacked-ext');
  const good = validateManifest(fixture);
  check('the fixture folder is a valid extension, with its name and version', good.ok && good.name === 'Lumen unpacked test' && good.version === '1.0.0', JSON.stringify(good));
  check('...and what it asks for includes tabs and its optional site', good.ok && good.lines.includes('Read your browsing history') && good.lines.some((l) => l.includes('optional.example.org')), JSON.stringify(good.lines));
  const bad = (name, files) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(d, f), text); return validateManifest(d); };
  check('a folder without manifest.json is refused', /no manifest\.json/.test(bad('none', { 'a.js': '' }).error || ''));
  check('bad JSON is refused', /isn’t valid JSON/.test(bad('json', { 'manifest.json': '{ nope' }).error || ''));
  check('a bad version is refused', /version/.test(bad('version', { 'manifest.json': JSON.stringify({ manifest_version: 3, name: 'x', version: '1.x' }) }).error || ''));
  check('manifest_version 1 is refused', /manifest_version/.test(bad('mv1', { 'manifest.json': JSON.stringify({ manifest_version: 1, name: 'x', version: '1' }) }).error || ''));
  check('a missing file it names is refused, by name', /missing\.js/.test(bad('missing', { 'manifest.json': JSON.stringify({ manifest_version: 3, name: 'x', version: '1', background: { service_worker: 'missing.js' } }) }).error || ''));

  // ---- [uBlock mode] the blocker's switch is refused
  const fakeSes = { extensions: { getExtension: () => ({ id: 'x', name: 'x', version: '1', manifest: {}, path: tmp }), removeExtension: () => { throw new Error('removed'); } } };
  const locked = await createManager({ ses: () => fakeSes, userData: tmp, readSettings: () => ({}), writeSettings: () => {}, isLocked: () => true }).setEnabled('x', false).then(() => 'allowed', (e) => e.message);
  check('the ad blocker extension can’t be switched off here', /Ad blocker/.test(locked), locked);

  // The stand-in server: a page for the content scripts, and popup-ext's CRX where the store's download would be.
  const { id: storeId, crx } = buildCrx(path.join(__dirname, '..', 'fixtures', 'extensions', 'popup-ext'));
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/crx')) { res.setHeader('Content-Type', 'application/x-chrome-extension'); res.end(crx); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Extension test page</title><body><p>hello</p></body>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  // The user's extension folder: a copy of the fixture the test can edit.
  const source = path.join(tmp, 'my-extension');
  fs.cpSync(fixture, source, { recursive: true });
  const sourceManifest = fs.readFileSync(path.join(source, 'manifest.json'), 'utf8');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ext-manage-profile-'));
  const launch = () => electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_WEBSTORE_ORIGIN: origin } });
  let app = await launch();
  let ui = await app.firstWindow();
  const errors = [];
  const watch = () => ui.on('pageerror', (e) => errors.push(e.message));
  watch();
  // The page's mark from each fixture's content script, in a hidden window on the main session (not a tab: nothing shows).
  const marks = () => app.evaluate(async ({ BrowserWindow }, url) => {
    const w = new BrowserWindow({ show: false });
    try {
      await w.loadURL(url);
      for (let i = 0; i < 30; i++) {
        const m = await w.webContents.executeJavaScript("({ store: document.documentElement.getAttribute('data-lumen-fixture'), unpacked: document.documentElement.getAttribute('data-lumen-unpacked') })");
        if (m.store || m.unpacked) return m;
        await new Promise((r) => setTimeout(r, 100));
      }
      return { store: null, unpacked: null };
    } finally { w.destroy(); }
  }, `${origin}/`);
  const loaded = () => app.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().map((e) => e.name));
  try {
    await ui.waitForSelector('.tab');
    const installed = await app.evaluate(async (_e, id) => { try { const ext = await global.__installExtension(id); return ext.id; } catch (err) { return `ERR ${err.message}`; } }, storeId);
    check('install the store fixture', installed === storeId, installed);
    check('its content script runs', (await waitFor(async () => (await marks()).store === 'ran', 10000)) === true);

    let inSettings = await openSettingsTab(app, 'extensions');
    const row = (id) => `document.querySelector('#extensions-list [data-ext="${id}"]')`;
    await waitFor(async () => (await inSettings(`Boolean(${row(storeId)})`)) === true, 10000);
    check('Settings → Extensions: the extension has an on switch, on', (await inSettings(`${row(storeId)}.querySelector('input.ext-on').checked`)) === true);

    // ---- off: unloaded, still installed
    await inSettings(`${row(storeId)}.querySelector('input.ext-on').click()`);
    check('off: it is unloaded from the session', Boolean(await waitFor(async () => !(await loaded()).includes('Lumen test extension'))), JSON.stringify(await loaded()));
    check('...its folder is kept (still installed)', fs.existsSync(path.join(profile, 'Extensions', storeId)));
    check('...the page lists it as Off, with the switch off', Boolean(await waitFor(async () => (await inSettings(`${row(storeId)}?.classList.contains('ext-off') && !${row(storeId)}.querySelector('input.ext-on').checked && /Off/.test(${row(storeId)}.textContent)`)) === true)));
    check('...and its content script no longer runs', (await marks()).store === null);

    // ---- Developer mode → Load unpacked
    check('Load unpacked is hidden while Developer mode is off', (await inSettings("document.getElementById('ext-load-unpacked').hidden")) === true);
    await inSettings("document.getElementById('pref-extensionsDevMode').click()");
    check('Developer mode on shows Load unpacked', Boolean(await waitFor(async () => (await inSettings("document.getElementById('ext-load-unpacked').hidden")) === false)));
    // A folder that isn't an extension: the reason, and no prompt.
    await inSettings(`window.__lumenTestUnpackedDir = ${JSON.stringify(path.join(tmp, 'json'))}; document.getElementById('ext-load-unpacked').click()`);
    const refused = await waitFor(async () => { const t = await inSettings("document.getElementById('extensions-status').textContent"); return /valid JSON/.test(t) && t; });
    check('an invalid folder is refused with the reason, and no prompt opens', Boolean(refused) && (await inSettings("!document.getElementById('unpacked-confirm')")) === true, refused);
    // The real folder: its permissions first.
    await inSettings(`window.__lumenTestUnpackedDir = ${JSON.stringify(source)}; document.getElementById('ext-load-unpacked').click()`);
    const prompt = await waitFor(async () => inSettings("document.getElementById('unpacked-confirm')?.open && document.getElementById('unpacked-confirm').textContent"));
    check('the prompt names it and lists what it asks for, optional sites included', /Lumen unpacked test/.test(prompt || '') && /browsing history/.test(prompt || '') && /optional\.example\.org/.test(prompt || ''), prompt);
    await inSettings("document.getElementById('unpacked-confirm-go').click()");
    const unpackedId = await waitFor(() => app.evaluate(({ session }) => session.defaultSession.extensions.getAllExtensions().find((e) => e.name === 'Lumen unpacked test')?.id));
    check('Load extension: it is loaded', Boolean(unpackedId), JSON.stringify(await loaded()));
    check('...listed as Unpacked, with its folder and a Reload button', Boolean(await waitFor(async () => (await inSettings(`Boolean(${row(unpackedId)}?.querySelector('.ext-reload')) && /Unpacked/.test(${row(unpackedId)}.textContent) && ${row(unpackedId)}.textContent.includes(${JSON.stringify(source)})`)) === true)));
    check('...its content script runs', (await waitFor(async () => (await marks()).unpacked === 'build-1', 10000)) === true);
    check('...and the user’s folder was not written to', fs.readFileSync(path.join(source, 'manifest.json'), 'utf8') === sourceManifest && fs.readdirSync(source).sort().join() === 'content.js,manifest.json', fs.readdirSync(source).join());

    // ---- Reload picks up an edit
    fs.writeFileSync(path.join(source, 'content.js'), "document.documentElement.setAttribute('data-lumen-unpacked', 'build-2');\n");
    await inSettings(`${row(unpackedId)}.querySelector('.ext-reload').click()`);
    check('Reload: the edited script runs', (await waitFor(async () => (await marks()).unpacked === 'build-2', 10000)) === true);
    check('...with the same id', (await app.evaluate(({ session }, id) => Boolean(session.defaultSession.extensions.getExtension(id)), unpackedId)) === true);

    // ---- a restart keeps both
    await app.evaluate(() => global.__settingsFlush?.());
    await app.close();
    app = await launch();
    ui = await app.firstWindow();
    watch();
    await ui.waitForSelector('.tab');
    await waitFor(async () => (await loaded()).includes('Lumen unpacked test'), 20000);
    const after = await loaded();
    check('after a restart: the off one stays off, the unpacked one loads', !after.includes('Lumen test extension') && after.includes('Lumen unpacked test'), JSON.stringify(after));
    check('...and runs its last build', (await waitFor(async () => (await marks()).unpacked === 'build-2', 10000)) === true);
    inSettings = await openSettingsTab(app, 'extensions');
    await waitFor(async () => (await inSettings(`Boolean(${row(storeId)})`)) === true, 10000);
    check('...the page still lists the off one', (await inSettings(`!${row(storeId)}.querySelector('input.ext-on').checked`)) === true);

    // ---- on again
    await inSettings(`${row(storeId)}.querySelector('input.ext-on').click()`);
    check('on again: it is loaded', Boolean(await waitFor(async () => (await loaded()).includes('Lumen test extension'))));
    check('...and its content script runs', (await waitFor(async () => (await marks()).store === 'ran', 10000)) === true);

    // ---- Remove an unpacked one: forgotten, the folder stays
    await inSettings(`[...${row(unpackedId)}.querySelectorAll('button')].find((b) => b.textContent === 'Remove').click()`);
    check('Remove: the unpacked one is unloaded and gone from the list', Boolean(await waitFor(async () => !(await loaded()).includes('Lumen unpacked test') && (await inSettings(`!${row(unpackedId)}`)) === true)));
    check('...the user’s folder stays', fs.existsSync(path.join(source, 'manifest.json')));
    check('...and Lumen’s copy is gone', !fs.existsSync(path.join(profile, 'Unpacked Extensions')) || fs.readdirSync(path.join(profile, 'Unpacked Extensions')).length === 0);
    check('no page errors in the window', errors.length === 0, errors.join(' | '));
  } catch (err) {
    check('the suite ran to the end', false, err.stack || err.message);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
