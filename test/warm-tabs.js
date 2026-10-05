// The warm view (main.js makeWarmTab): a hidden about:blank page whose renderer is already running, which the next
// web page a tab opens, wakes in or is typed into the new-tab page loads in. Checks that such a page is a normal tab:
// no about:blank in its back list, Chrome's identity from its first request, its title and address in the strip; that
// an address typed into the new-tab page lands in the same tab (Back returns to a new-tab page), a load that never
// commits leaves the new-tab page as it was, and a restored tab wakes in it.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(50); } return false; };

  const hints = {}; // Sec-CH-UA as the server got it, by path
  const server = http.createServer((req, res) => {
    hints[req.url] = req.headers['sec-ch-ua'] || '';
    if (req.url === '/nothing') { res.writeHead(204); return res.end(); } // never commits
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>Warm ${req.url}</title><p>${req.url}</p><script>window.brands = JSON.stringify(navigator.userAgentData?.brands || []);</script>`);
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-warm-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  check('off in tests unless asked: no warm view at start', !(await app.evaluate(({ webContents }) => webContents.getAllWebContents().some((w) => w.getURL() === 'about:blank'))), 'an about:blank view exists');
  const warmUp = async () => {
    await app.evaluate(() => global.__warmTabs.enable());
    return waitFor(() => app.evaluate(() => global.__warmTabs.ready()), 8000);
  };
  const warmId = () => app.evaluate(() => global.__warmTabs.contentsId());
  const active = () => app.evaluate(() => { const t = global.__agent.browser.activeTab(); const n = t.webContents.navigationHistory; return { id: t.id, contentsId: t.webContents.id, url: t.webContents.getURL(), title: t.webContents.getTitle(), entries: n.getAllEntries().map((e) => e.url), loading: t.webContents.isLoading() }; });
  const stripActive = () => ui.evaluate(() => ({ label: document.querySelector('#tabs .tab.active')?.getAttribute('aria-label'), address: document.getElementById('address').value, back: !document.getElementById('back').disabled, tabs: document.querySelectorAll('#tabs .tab').length }));

  // ---- 1. a web page opened in a new tab loads in the warm view ----
  check('(setup) the warm view is ready', await warmUp(), 'not ready');
  let warm = await warmId();
  await app.evaluate(async (_e, url) => { const t = global.__agent.browser.openTab(url); await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); }); }, `${base}/one`);
  let a = await active();
  check('a link opened in a new tab loads in the warm view', a.contentsId === warm && a.url === `${base}/one`, JSON.stringify({ warm, a }));
  check('...with no about:blank in its back list', a.entries.length === 1 && a.entries[0] === `${base}/one`, JSON.stringify(a.entries));
  check('...presenting itself as Chrome from its first request', /Google Chrome/.test(hints['/one'] || ''), hints['/one']);
  const brands = await app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript('window.brands'));
  check('...and to its scripts', /Google Chrome/.test(brands), brands);
  await waitFor(async () => (await stripActive()).label === 'Warm /one');
  let s = await stripActive();
  check('...its title and address in the strip, and no Back', s.label === 'Warm /one' && s.address === `${base}/one` && !s.back, JSON.stringify(s));
  check('another warm view is made for the next page', await waitFor(() => app.evaluate(() => global.__warmTabs.ready()), 8000) && (await warmId()) !== warm, String(await warmId()));

  // ---- 2. an address typed into the new-tab page ----
  await ui.click('#new-tab');
  await waitFor(async () => /newtab\.html/.test((await active()).url));
  const nt = await active();
  warm = await warmId();
  await ui.fill('#address', `${base}/typed`);
  await ui.press('#address', 'Enter');
  await waitFor(async () => (await active()).url === `${base}/typed` && !(await active()).loading);
  a = await active();
  check('an address typed into a new tab loads in the warm view, in the same tab', a.id === nt.id && a.contentsId === warm && a.url === `${base}/typed`, JSON.stringify({ nt, warm, a }));
  check('...the new-tab page’s own view is gone once the page has drawn', await waitFor(() => app.evaluate(({ webContents }, id) => !webContents.fromId(id) || webContents.fromId(id).isDestroyed(), nt.contentsId), 3000), 'still there');
  await waitFor(async () => (await stripActive()).label === 'Warm /typed');
  s = await stripActive();
  check('...no tab added, the page’s title in the strip, and Back on', s.label === 'Warm /typed' && s.back && s.tabs === 3, JSON.stringify(s)); // (the first tab, /one and this one)
  await ui.click('#back');
  check('Back returns to a new-tab page', await waitFor(async () => /newtab\.html/.test((await active()).url)), (await active()).url);
  check('...in the same tab', (await active()).id === nt.id, JSON.stringify(await active()));

  // ---- 3. a load that never commits leaves the new-tab page as it was ----
  await waitFor(() => app.evaluate(() => global.__warmTabs.ready()), 8000);
  const before = await active();
  await ui.fill('#address', `${base}/nothing`);
  await ui.press('#address', 'Enter');
  await sleep(1200);
  a = await active();
  check('a 204 from the new-tab page: the new-tab page stays, in its own view', a.contentsId === before.contentsId && /newtab\.html/.test(a.url), JSON.stringify({ before, a }));

  // ---- 4. a tile or search on the new-tab page (the page navigates itself) ----
  await waitFor(() => app.evaluate(() => global.__warmTabs.ready()), 8000);
  warm = await warmId();
  await app.evaluate((_e, url) => global.__agent.browser.activeTab().webContents.executeJavaScript(`location.href = ${JSON.stringify(url)}; 1`), `${base}/tile`);
  await waitFor(async () => (await active()).url === `${base}/tile`);
  a = await active();
  check('a link followed on the new-tab page loads in the warm view, same tab', a.id === before.id && a.contentsId === warm, JSON.stringify({ warm, a }));

  // ---- 5. a restored (sleeping, no history) tab wakes in the warm view ----
  await waitFor(() => app.evaluate(() => global.__warmTabs.ready()), 8000);
  const sleeper = await app.evaluate((_e, url) => { const t = global.__agent.browser.openTab(url, { background: true }); return t.id; }, `${base}/sleeper`);
  await sleep(800);
  await app.evaluate((_e, id) => global.__tabSleep.sleep(id), sleeper);
  await waitFor(() => app.evaluate(() => global.__warmTabs.ready()), 8000);
  warm = await warmId();
  const woke = await app.evaluate(async (_e, id) => {
    const tab = global.__warmTabs.forgetHistory(id); // (put to sleep after a load it has a back list to restore; a tab restored from the last session has none)
    global.__agent.browser.switchTab(id);
    const wc = global.__agent.browser.activeTab().webContents;
    await new Promise((r) => { wc.once('did-stop-loading', r); setTimeout(r, 5000); });
    return { had: tab, contentsId: wc.id, url: wc.getURL(), entries: wc.navigationHistory.length() };
  }, sleeper);
  check('a restored tab wakes in the warm view', woke.contentsId === warm && woke.url === `${base}/sleeper` && woke.entries === 1, JSON.stringify({ warm, woke }));

  check('no page errors in the browser UI', errors.length === 0, errors.join(' | '));
  await app.close();
  server.close();
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch {}
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
