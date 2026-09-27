// Recovery and tab-modal dialogs: a crashed tab shows "This page crashed" with Reload, a page that
// stops responding can be closed, a frozen tab still closes, the browser UI reloads after a crash
// with its tabs intact, a background tab's alert waits (with a badge) instead of switching tabs,
// and a link handed over by a second copy opens in a tab.
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url.startsWith('/alert')) return res.end('<title>Alerter</title><script>setTimeout(() => alert("hello from the background"), 600)</script>');
    res.end(`<title>Page ${req.url}</title><p>fixture</p>`);
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-recovery-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile };
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  const open = (url, background = false) => app.evaluate(async (_e, [u, bg]) => {
    const t = global.__agent.browser.openTab(u, { background: bg });
    await new Promise((r) => t.webContents.once('did-stop-loading', r));
    return t.id;
  }, [url, background]);
  const urlOf = (id) => app.evaluate((_e, i) => global.__agent.browser.listTabs().find((t) => t.id === i)?.url || null, id);
  const rawUrl = () => app.evaluate(() => global.__agent.browser.activeTab()?.webContents.getURL() || '');
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };

  // ---- a tab crashes
  const crashId = await open(`${base}/crash`);
  await app.evaluate(() => global.__agent.browser.activeTab().webContents.forcefullyCrashRenderer());
  check('a crashed tab shows "This page crashed"', await waitFor(async () => (await rawUrl()).includes('error.html') && (await rawUrl()).includes('kind=crashed')), await rawUrl());
  const heading = await app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript("document.querySelector('h1').textContent + '|' + document.getElementById('retry').textContent"));
  check('the crash page offers Reload', heading === 'This page crashed|Reload', heading);
  check('the address bar still shows the page that crashed', (await urlOf(crashId)) === `${base}/crash`, await urlOf(crashId));
  await app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript("document.getElementById('retry').click()"));
  check('Reload brings the page back', await waitFor(async () => (await rawUrl()) === `${base}/crash`), await rawUrl());

  // ---- a frozen tab still closes
  const frozenId = await open(`${base}/frozen`);
  await app.evaluate(() => {
    const wc = global.__agent.browser.activeTab().webContents;
    wc.executeJavaScript('window.onbeforeunload = () => {}; setTimeout(() => { for (;;) {} }, 50); 1').catch(() => {});
  });
  await sleep(400);
  await app.evaluate((_e, id) => global.__closeTabInteractive(id), frozenId);
  check('a frozen tab closes within a few seconds', await waitFor(async () => (await urlOf(frozenId)) === null, 6000), 'still open');

  // ---- a background tab's alert waits for its tab
  const frontId = await open(`${base}/front`);
  const alertId = await open(`${base}/alert`, true);
  await sleep(1500);
  const active = await app.evaluate(() => global.__agent.browser.activeTab().id);
  check("a background tab's alert doesn't switch tabs", active === frontId, `active ${active}`);
  const badge = await ui.evaluate(() => document.querySelectorAll('.tab.alert').length);
  check('the background tab shows a badge', badge === 1, badge);
  const overlayShown = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.some((v) => v.getVisible?.() && v.webContents?.getURL().includes('dialog.html')));
  check('no dialog covers the tab in front', !(await overlayShown()), 'overlay visible');
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), alertId);
  check('switching to the tab shows its alert', await waitFor(overlayShown, 3000), 'no overlay');
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), frontId);
  check('switching away hides it again', await waitFor(async () => !(await overlayShown()), 3000), 'overlay still visible');
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), alertId);
  await waitFor(overlayShown, 3000);
  await app.evaluate(({ ipcMain }) => { const d = global.__dialogs; d.respond({ id: d.currentId(), response: 0 }); });
  check('answering it clears the badge', await waitFor(async () => (await ui.evaluate(() => document.querySelectorAll('.tab.alert').length)) === 0, 3000), 'badge stays');

  // ---- the browser UI crashes and comes back with its tabs
  const before = await app.evaluate(() => global.__agent.browser.listTabs().length);
  // Playwright can't survive its own page crashing, so the crash is signalled rather than real;
  // what's tested is Lumen's response: reload the UI and send it the tabs again.
  await app.evaluate(({ BrowserWindow }) => { const wc = BrowserWindow.getAllWindows()[0].webContents; wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 }); });
  await sleep(500);
  let tabsBack = false;
  try {
    tabsBack = await waitFor(async () => (await ui.evaluate(() => document.querySelectorAll('.tab').length).catch(() => 0)) === before, 10000);
  } catch {}
  check('the browser UI reloads after a crash, with every tab', tabsBack, `expected ${before} tabs`);

  // ---- a link from another app (a second copy) opens in a tab
  const electronPath = require('electron');
  const second = require('child_process').spawn(electronPath, [path.join(__dirname, '..'), `${base}/from-another-app`], { env });
  await new Promise((resolve) => second.on('exit', resolve));
  check('a link handed over by a second copy opens in a tab', await waitFor(async () => (await rawUrl()) === `${base}/from-another-app`), await rawUrl());

  check('no UI errors', errors.length === 0, errors.join('; '));
  await app.close();
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
