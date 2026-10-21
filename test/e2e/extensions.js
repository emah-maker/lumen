// Extensions, with no network: a tiny MV3 fixture extension (test/fixtures/extensions/popup-ext: a toolbar popup of a known size,
// 320 by 240, and a content script that marks the page) is packed into a signed CRX3 on the spot and served from 127.0.0.1 in place of
// the Chrome Web Store's download address (a test-only switch, LUMEN_TEST_WEBSTORE_ORIGIN, honoured by src/test-mode.js, which also
// refuses every other non-loopback fetch in the main process). Covers: the "Add extension?" permission lines, install through the same installer the store button uses, the
// content script on a page, the toolbar button, the popup (shown, at the size the page asked for), the declarativeNetRequest gate
// and shim, and removal (gone from the session, the folder and the toolbar, and the content script no longer runs).
// Lumen has no enable/disable switch for an extension (an extension is installed or removed), so that is not tested.
// Not covered here, because it needs the real store page: the store's own "Add to Lumen" button.
// Run alone: LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1 node test/e2e/extensions.js (a throwaway profile; no window shows)
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { buildCrx } = require('../fixtures/extensions/build-crx');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn().catch(() => null); if (v) return v; await sleep(100); } return v; };

  // The stand-in server: a page for the content script, and the fixture's CRX where the store's download would be.
  const fixtureDir = path.join(__dirname, '..', 'fixtures', 'extensions', 'popup-ext');
  const { id: extId, crx } = buildCrx(fixtureDir);
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url.startsWith('/crx')) { res.setHeader('Content-Type', 'application/x-chrome-extension'); res.end(crx); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Extension test page</title><body><p>hello</p></body>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-extensions-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_WEBSTORE_ORIGIN: origin } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  try {
    await ui.waitForSelector('.tab');

    // ---- the "Add extension?" dialog lists what it asks for
    const { extensionPermissionLines } = require('../../src/browser/extension-permissions');
    const broad = extensionPermissionLines({ permissions: ['tabs', 'storage', 'cookies'], host_permissions: ['<all_urls>'] });
    check('install prompt: all-sites access is listed first', broad[0] === 'Read and change all your data on all websites', JSON.stringify(broad));
    check('install prompt: tabs and cookies are listed, storage is not', broad.includes('Read your browsing history') && broad.some((l) => /cookies/.test(l)) && broad.length === 3, JSON.stringify(broad));
    const narrow = extensionPermissionLines({ content_scripts: [{ matches: ['https://*.github.com/*', 'https://example.com/*'] }] });
    check('install prompt: specific sites are named', narrow.length === 1 && narrow[0].includes('github.com') && narrow[0].includes('example.com'), JSON.stringify(narrow));
    check('install prompt: nothing special says so', extensionPermissionLines({ permissions: ['storage'] }).length === 0, 'expected no lines');
    check('install prompt: the fixture asks for the one site its content script runs on', extensionPermissionLines(JSON.parse(fs.readFileSync(path.join(fixtureDir, 'manifest.json'), 'utf8'))).length === 1, 'fixture manifest');
    check('main.js uses no private Electron preload getter', !/_getPreloadScript/.test(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8')), '_getPreloadScript found');

    // ---- no real network: the store's download address goes to the stand-in and everything else is refused
    const outside = await app.evaluate(() => fetch('https://example.com/').then(() => 'reached', (e) => String(e.message)));
    check('a fetch to the real network is refused in test mode', /no network/.test(outside), outside);

    // ---- install through the installer the store button uses
    const installed = await app.evaluate(async (_e, id) => {
      try { const ext = await global.__installExtension(id); return { ok: true, name: ext.name, id: ext.id }; } catch (err) { return { ok: false, error: err.message }; }
    }, extId).catch((e) => ({ ok: false, error: e.message }));
    check('install the fixture extension from the stand-in download', installed.ok && installed.name === 'Lumen test extension' && installed.id === extId, JSON.stringify(installed));
    check('the download came from the stand-in (one CRX request, to the store address\'s path)', requests.filter((u) => u.startsWith('/crx')).length === 1 && requests.every((u) => u.startsWith('/crx') || u === '/'), JSON.stringify(requests));
    const extDir = path.join(profile, 'Extensions', extId);
    check('it is unpacked into the profile\'s Extensions folder', fs.existsSync(extDir), extDir);

    // ---- the content script runs on a page it matches
    await app.evaluate((_e, url) => global.__agent.execute('navigate', { url }), `${origin}/`);
    const marked = await waitFor(() => app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript("document.documentElement.getAttribute('data-lumen-fixture')")).then((v) => v === 'ran'), 10000);
    check('extension content script runs on pages', marked, 'the page was not marked');

    // ---- the toolbar button
    const visible = await waitFor(() => ui.evaluate(() => document.getElementById('extension-actions').getBoundingClientRect().width > 0), 8000);
    check('extension toolbar is visible', visible, 'zero width');
    const buttonCount = () => ui.evaluate(() => { const list = document.getElementById('extension-actions'); return list ? list.shadowRoot?.querySelectorAll('.action').length ?? -1 : -2; });
    check('extension button appears in toolbar', Boolean(await waitFor(async () => (await buttonCount()) === 1)), `count=${await buttonCount()}`);

    // ---- the popup: shown, at the size its page asked for
    await ui.evaluate(() => document.getElementById('extension-actions').shadowRoot.querySelector('.action').click());
    const popupWindow = () => app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith('chrome-extension://'));
      return w ? { visible: w.isVisible(), bounds: w.getBounds(), url: w.webContents.getURL() } : null;
    });
    const popup = await waitFor(async () => { const p = await popupWindow(); return p?.visible ? p : null; }, 10000);
    check('extension popup opens visible', Boolean(popup?.visible) && popup.url.startsWith(`chrome-extension://${extId}/popup.html`), JSON.stringify(popup));
    // (The window's frame adds 2 to 3 DIPs around the page; the fallback when a page reports no size is 360 by 480.)
    check('extension popup is the size its page asks for (320 by 240 DIPs, give or take 4)', Boolean(popup) && Math.abs(popup.bounds.width - 320) <= 4 && Math.abs(popup.bounds.height - 240) <= 4, JSON.stringify(popup));

    // ---- declarativeNetRequest: only content blockers with static rulesets are refused; others install
    // and get a working (in-memory) chrome.declarativeNetRequest.
    const gate = await app.evaluate(() => ({
      helper: global.__isContentBlocker({ name: '1Password', permissions: ['declarativeNetRequest'] }, '1Password – Password Manager'),
      helperWithRules: global.__isContentBlocker({ name: 'Password helper', description: 'Fills passwords', declarative_net_request: { rule_resources: [{ id: 'r', enabled: true, path: 'r.json' }] } }),
      blocker: global.__isContentBlocker({ name: 'Super Ad Blocker', description: 'Blocks ads and trackers', declarative_net_request: { rule_resources: [{ id: 'ads', enabled: true, path: 'ads.json' }] } }),
    }));
    check('DNR gate: an extension asking for DNR without rulesets installs', gate.helper === false && gate.helperWithRules === false, JSON.stringify(gate));
    check('DNR gate: a blocker with static rulesets is still refused', gate.blocker === true, JSON.stringify(gate));
    const dnr = await app.evaluate(async ({ session }, dir) => {
      const ext = await session.defaultSession.extensions.loadExtension(dir);
      const t = global.__agent.browser.openTab(`chrome-extension://${ext.id}/page.html`);
      await new Promise((r) => t.webContents.once('did-finish-load', r));
      return t.webContents.executeJavaScript('window.dnrResult');
    }, path.join(__dirname, '..', 'fixtures', 'dnr-ext'));
    check('chrome.declarativeNetRequest works in extension pages (rules kept, no throw)', dnr.present && JSON.stringify(dnr.added) === '[7]' && dnr.after === 0 && dnr.block === 'block' && dnr.regex === true, JSON.stringify(dnr));
    check('extension pages get `browser` as chrome, and can still set their own', dnr.alias === true && dnr.ownKept === true, JSON.stringify(dnr));

    // ---- remove: gone from the session, the folder and the toolbar, and its content script no longer runs
    await app.evaluate((_e, id) => global.__uninstallExtension(id), extId);
    const inSession = () => app.evaluate(({ session }, id) => Boolean(session.defaultSession.extensions.getExtension(id)), extId);
    check('removed: the extension is gone from the session', (await waitFor(async () => !(await inSession()))) === true, 'still loaded');
    check('removed: its folder is deleted from the profile', !fs.existsSync(extDir), extDir);
    check('removed: its toolbar button is gone', Boolean(await waitFor(async () => (await buttonCount()) === 0)), `count=${await buttonCount()}`);
    await app.evaluate((_e, url) => global.__agent.execute('navigate', { url }), `${origin}/after-removal`);
    await sleep(1500);
    const stillMarked = await app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript("document.documentElement.getAttribute('data-lumen-fixture')"));
    check('removed: the content script no longer runs on a new page', stillMarked === null, String(stillMarked));
    check('the whole run touched only 127.0.0.1', requests.length > 0, 'no requests');
    check('no UI errors', errors.length === 0, errors.join('; '));
  } finally {
    await app.close().catch(() => {});
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch {} // (Electron may still hold the folder briefly)
  }
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
