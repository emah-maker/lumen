// What an extension that runs everywhere costs Lumen, and the "Site access" setting that holds it to the sites listed. A tiny MV3 fixture
// (test/fixtures/extensions/everywhere-ext: a content script and webRequest listeners on <all_urls>, like BetterCampus's 5 MB one) is
// installed through the store installer (a stand-in CRX served from 127.0.0.1), then:
//   - page loads are timed with no extension, with it on all sites, and with it held to one other site: Lumen's own part of an
//     extension's cost (its shims, per-navigation work, tab registration) must stay inside a budget (the extension's own script is the
//     rest of what BetterCampus costs, and is not Lumen's to remove, which is what Site access is for);
//   - on all sites: the content script marks a page on any site;
//   - on "only these sites": it marks that site's pages and no other;
// (chrome.webRequest listeners are never called in Lumen, whose ad blocker uses Electron's webRequest, so they are no cost to measure.)
//   - back to all sites: the saved manifest is restored to what the extension shipped.
// The budget was set from this machine's runs with margin (see BUDGET_MS). Never loosen it: find what got slower.
// Run alone: LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1 node test/e2e/extension-perf.js (a throwaway profile; no window shows)
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { buildCrx } = require('../fixtures/extensions/build-crx');
const { openSettingsTab } = require('../helpers/settings-tab');

const REPS = 15; // loads per block (the first of each is dropped: it warms the connection)
const BUDGET_MS = 25; // median extra load time over no extension, on the same page
const SITE_BUDGET_MS = 25; // the same, with the extension held to a site the page is not on

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
    res.end(`<!doctype html><title>Perf page</title><body>${Array.from({ length: 200 }, (_, i) => `<p>Paragraph ${i} lorem ipsum dolor sit amet</p>`).join('')}</body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const plain = `http://127.0.0.1:${port}`; // a site the extension is held away from
  const canvas = `http://canvas.instructure.localhost:${port}`; // a site it is listed for ("instructure.localhost" covers it)

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-extperf-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_WEBSTORE_ORIGIN: plain } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  const load = (url) => app.evaluate(async (_e, u) => {
    const wc = global.__agent.browser.activeTab().webContents;
    const done = new Promise((res) => wc.once('did-finish-load', res));
    wc.loadURL(u);
    await done;
    await new Promise((r) => setTimeout(r, 150));
    return wc.executeJavaScript("(() => { const n = performance.getEntriesByType('navigation')[0]; return { load: n.loadEventEnd - n.startTime, ran: document.documentElement.getAttribute('data-lumen-everywhere') }; })()");
  }, url);
  const median = (v) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  let n = 0;
  const timeBlock = async (base) => { const loads = []; for (let i = 0; i <= REPS; i++) { const r = await load(`${base}/p?n=${n++}`); if (i) loads.push(r.load); } return median(loads); };
  const marked = async (base) => (await load(`${base}/m?n=${n++}`)).ran === 'ran';
  const extFolder = () => path.join(profile, 'Extensions', extId, fs.readdirSync(path.join(profile, 'Extensions', extId))[0]);
  const manifestOf = () => JSON.parse(fs.readFileSync(path.join(extFolder(), 'manifest.json'), 'utf8'));
  try {
    await ui.waitForSelector('.tab');

    const none = await timeBlock(plain);
    const installed = await app.evaluate((_e, id) => global.__installExtension(id).then((e) => e.name, (err) => `ERR ${err.message}`), extId);
    check('the fixture installs', installed === 'Lumen everywhere test extension', installed);
    await sleep(1500); // its worker starts
    check('on all sites: the content script runs on a plain page and on the listed one', Boolean(await waitFor(() => marked(plain), 8000)) && await marked(canvas), 'not marked');
    await load(`${canvas}/w`);
    const all = await timeBlock(plain);
    console.log(`INFO  median load: no extension ${none.toFixed(1)} ms, on all sites ${all.toFixed(1)} ms (delta ${(all - none).toFixed(1)}, budget ${BUDGET_MS})`);
    check(`Lumen's overhead for an everywhere extension stays under ${BUDGET_MS} ms a page`, all - none <= BUDGET_MS, `${(all - none).toFixed(1)} ms`);

    // ---- only these sites
    // ...through Settings → Extensions: the row appears for an extension that asks for every site, with "On all sites" chosen
    const inSettings = await openSettingsTab(app, 'extensions');
    await waitFor(async () => (await inSettings("document.querySelectorAll('#extensions-list .ext-sites-row').length")) === 1, 10000);
    const row = () => inSettings("(() => { const r = document.querySelector('#extensions-list .ext-sites-row'); return r ? { mode: r.querySelector('select').value, shown: !r.querySelector('input').hidden, sites: r.querySelector('input').value } : null; })()");
    check('Settings → Extensions: a Site access row, on all sites to begin with', JSON.stringify(await row()) === JSON.stringify({ mode: 'all', shown: false, sites: '' }), JSON.stringify(await row()));
    await inSettings("(() => { const s = document.querySelector('#extensions-list .ext-sites-row select'); s.value = 'some'; s.dispatchEvent(new Event('change')); })()");
    check('choosing "Only on these sites" shows the sites box', (await row())?.shown === true, JSON.stringify(await row()));
    await inSettings("(() => { const i = document.querySelector('#extensions-list .ext-sites-row input'); i.value = 'instructure.localhost'; i.dispatchEvent(new Event('change')); })()");
    await sleep(2500);
    check('typing a site saves it and the row keeps it', JSON.stringify(await row()) === JSON.stringify({ mode: 'some', shown: true, sites: 'instructure.localhost' }), JSON.stringify(await row()));
    await app.evaluate((_e, sid) => global.__closeTabInteractive(sid), inSettings.id); // back to the page tab the timings use
    const m = manifestOf();
    check('only these sites: the content script and host access are narrowed to the sites, the rest untouched', JSON.stringify(m.content_scripts[0].matches) === '["*://*.instructure.localhost/*"]' && JSON.stringify(m.host_permissions) === '["*://*.instructure.localhost/*"]' && m.permissions.includes('webRequest'), JSON.stringify(m));
    check('only these sites: it still runs on the listed site', Boolean(await waitFor(() => marked(canvas), 8000)), 'not marked');
    check('only these sites: it does not run on any other site', !(await marked(plain)), 'marked');
    const some = await timeBlock(plain);
    console.log(`INFO  median load held to another site: ${some.toFixed(1)} ms (delta ${(some - none).toFixed(1)}, budget ${SITE_BUDGET_MS})`);
    check(`held to another site, the extension costs a page under ${SITE_BUDGET_MS} ms`, some - none <= SITE_BUDGET_MS, `${(some - none).toFixed(1)} ms`);

    // ---- back to all sites: exactly what it shipped
    await app.evaluate((_e, id) => global.__setExtensionSites(id, []), extId);
    await sleep(1500);
    const back = manifestOf();
    const shipped = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'manifest.json'), 'utf8'));
    check('all sites again: the manifest is what the extension shipped, and no copy is left', JSON.stringify(back.content_scripts) === JSON.stringify(shipped.content_scripts) && JSON.stringify(back.host_permissions) === JSON.stringify(shipped.host_permissions) && !fs.readdirSync(extFolder()).includes('manifest.lumen-original.json'), JSON.stringify(back));
    check('all sites again: it runs on the plain page', Boolean(await waitFor(() => marked(plain), 8000)), 'not marked');
    check('no UI errors', errors.length === 0, errors.join('; '));
  } finally {
    await app.close().catch(() => {});
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch {}
  }
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
