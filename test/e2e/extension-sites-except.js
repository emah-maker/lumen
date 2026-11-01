// Site access "On all sites except these" (browser/extension-sites.js): an extension keeps running everywhere but the sites listed,
// which get none of its content scripts (BetterCampus's full-page layer once locked a Microsoft sign-in page). The fixture
// test/fixtures/extensions/everywhere-ext (a content script on <all_urls> that marks the page) is installed through the store installer
// (a stand-in CRX served from 127.0.0.1), then, through Settings → Extensions:
//   - "On all sites except these" with one site typed: the script runs on a plain site and another, not on the listed one or its subdomain;
//   - moving to "Only on these sites" empties the box (the same sites would mean the opposite), and nothing changes until sites are typed;
//   - "only these" and back to "all except" rewrite the manifest from the saved original each time, the extension loaded again;
//   - "On all sites": the manifest is what the extension shipped, and no copy is left.
// Run alone: LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1 node test/e2e/extension-sites-except.js (a throwaway profile; no window shows)
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { buildCrx } = require('../fixtures/extensions/build-crx');
const { openSettingsTab } = require('../helpers/settings-tab');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn().catch(() => null); if (v) return v; await sleep(100); } return v; };

  const fixtureDir = path.join(__dirname, '..', 'fixtures', 'extensions', 'everywhere-ext');
  const { id: extId, crx } = buildCrx(fixtureDir);
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/crx')) { res.setHeader('Content-Type', 'application/x-chrome-extension'); res.end(crx); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Sites page</title><body><p>A page</p></body>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const plain = `http://127.0.0.1:${port}`;
  const canvas = `http://canvas.instructure.localhost:${port}`;
  const login = `http://login.signin.localhost:${port}`; // the site kept off ("signin.localhost" is typed: it and its subdomains)
  const loginWww = `http://www.signin.localhost:${port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-extexcept-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_WEBSTORE_ORIGIN: plain } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  let n = 0;
  // Loads the page in the first tab (the Settings tab stays open beside it) and says whether the content script marked it.
  let pageTab = null;
  const marked = (base) => app.evaluate(async (_e, [u, tab]) => {
    const wc = (tab != null && global.__agent.browser.tabById(tab)) ? global.__agent.browser.tabById(tab).webContents : global.__agent.browser.activeTab().webContents;
    const done = new Promise((res) => wc.once('did-finish-load', res));
    wc.loadURL(u);
    await done;
    await new Promise((r) => setTimeout(r, 200));
    return (await wc.executeJavaScript("document.documentElement.getAttribute('data-lumen-everywhere')")) === 'ran';
  }, [`${base}/m?n=${n++}`, pageTab]);
  const sweep = async () => { const out = {}; for (const b of [plain, canvas, login, loginWww]) out[b.replace('http://', '').replace(/:\d+$/, '')] = await marked(b); return out; };
  const extFolder = () => path.join(profile, 'Extensions', extId, fs.readdirSync(path.join(profile, 'Extensions', extId))[0]);
  const manifestOf = () => JSON.parse(fs.readFileSync(path.join(extFolder(), 'manifest.json'), 'utf8'));
  const shipped = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'manifest.json'), 'utf8'));
  try {
    await ui.waitForSelector('.tab');
    pageTab = await app.evaluate(() => global.__agent.browser.activeTab().id);
    const installed = await app.evaluate((_e, id) => global.__installExtension(id).then((e) => e.name, (err) => `ERR ${err.message}`), extId);
    check('the fixture installs', installed === 'Lumen everywhere test extension', installed);
    await sleep(1500); // its worker starts
    check('on all sites: the content script runs on every site, the sign-in one too', Boolean(await waitFor(() => marked(plain), 8000)) && await marked(login), 'not marked');

    // ---- all sites except, through Settings → Extensions
    const inSettings = await openSettingsTab(app, 'extensions');
    await waitFor(async () => (await inSettings("document.querySelectorAll('#extensions-list .ext-sites-row').length")) === 1, 10000);
    const row = () => inSettings("(() => { const r = document.querySelector('#extensions-list .ext-sites-row'); if (!r) return null; const i = r.querySelector('input'); return { mode: r.querySelector('select').value, options: [...r.querySelectorAll('option')].map((o) => o.textContent), shown: !i.hidden, sites: i.value, label: i.getAttribute('aria-label') }; })()");
    const first = await row();
    check('Settings → Extensions: the Site access menu has the third choice', JSON.stringify(first?.options) === JSON.stringify(['On all sites', 'Only on these sites', 'On all sites except these']) && first.mode === 'all' && !first.shown, JSON.stringify(first));
    const pick = (value) => inSettings(`(() => { const s = document.querySelector('#extensions-list .ext-sites-row select'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); })()`);
    const type = (text) => inSettings(`(() => { const i = document.querySelector('#extensions-list .ext-sites-row input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('change')); })()`);
    await pick('except');
    const picked = await row();
    check('choosing "On all sites except these" shows the box, labelled for the sites it stays off', picked?.shown === true && /stays off/.test(picked.label || ''), JSON.stringify(picked));
    await type('signin.localhost');
    await sleep(2500);
    check('typing a site saves it as an exception and the row keeps it', JSON.stringify(await row()).includes('"mode":"except"') && (await row())?.sites === 'signin.localhost', JSON.stringify(await row()));
    const ex = manifestOf();
    check('all except: the manifest keeps <all_urls> and excludes the site from the content script', JSON.stringify(ex.content_scripts.find((c) => c.js.includes('content.js'))) === JSON.stringify({ ...shipped.content_scripts[0], exclude_matches: ['*://*.signin.localhost/*'] }) && JSON.stringify(ex.host_permissions) === '["<all_urls>"]' && fs.readdirSync(extFolder()).includes('manifest.lumen-original.json'), JSON.stringify(ex.content_scripts));
    await waitFor(() => marked(plain), 8000);
    const exceptRuns = await sweep();
    check('all except: it runs on the plain site and another, and on neither the listed site\'s subdomain nor its www',
      JSON.stringify(exceptRuns) === JSON.stringify({ '127.0.0.1': true, 'canvas.instructure.localhost': true, 'login.signin.localhost': false, 'www.signin.localhost': false }), JSON.stringify(exceptRuns));

    // ---- switching lists empties the box; nothing changes until sites are typed
    await pick('some');
    const switched = await row();
    check('moving to "Only on these sites" empties the box (the same sites would mean the opposite)', switched?.mode === 'some' && switched.shown && switched.sites === '' && /can run on/.test(switched.label || ''), JSON.stringify(switched));
    check('...and the extension is not changed until sites are typed', JSON.stringify(manifestOf().content_scripts) === JSON.stringify(ex.content_scripts), JSON.stringify(manifestOf().content_scripts));
    await type('instructure.localhost');
    await sleep(2500);
    const only = manifestOf();
    check('only these: rewritten from the original, narrowed and with no exclusion left', JSON.stringify(only.content_scripts.find((c) => c.js.includes('content.js')).matches) === '["*://*.instructure.localhost/*"]' && !only.content_scripts.some((c) => c.js.includes('content.js') && c.exclude_matches), JSON.stringify(only.content_scripts));
    await waitFor(() => marked(canvas), 8000);
    const onlyRuns = await sweep();
    check('only these: it runs on the listed site alone', JSON.stringify(onlyRuns) === JSON.stringify({ '127.0.0.1': false, 'canvas.instructure.localhost': true, 'login.signin.localhost': false, 'www.signin.localhost': false }), JSON.stringify(onlyRuns));

    // ---- back to all except, then all sites
    await pick('except');
    await type('signin.localhost');
    await sleep(2500);
    await waitFor(() => marked(plain), 8000);
    const againRuns = await sweep();
    check('all except again: everywhere but the listed site', JSON.stringify(againRuns) === JSON.stringify(exceptRuns), JSON.stringify(againRuns));
    await pick('all');
    await sleep(2500);
    const back = manifestOf();
    check('all sites again: the manifest is what the extension shipped, and no copy is left', JSON.stringify(back.content_scripts.filter((c) => c.js.includes('content.js'))) === JSON.stringify(shipped.content_scripts) && JSON.stringify(back.host_permissions) === JSON.stringify(shipped.host_permissions) && !fs.readdirSync(extFolder()).includes('manifest.lumen-original.json'), JSON.stringify(back));
    check('all sites again: the row says so', (await row())?.mode === 'all' && !(await row())?.shown, JSON.stringify(await row()));
    await waitFor(() => marked(login), 8000);
    check('all sites again: it runs on the sign-in site', await marked(login), 'not marked');
    check('no UI errors', errors.length === 0, errors.join('; '));
  } finally {
    await app.close().catch(() => {});
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch {}
  }
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
