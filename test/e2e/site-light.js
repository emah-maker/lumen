// A site with a half-built dark mode (Glassdoor) is told the system is light in a dark theme, and gets one whole light page;
// any other site still sees the dark theme (features/site-light.js). The hosts are mapped to a local server.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end("<title>scheme</title><style>body{background:#fff}@media (prefers-color-scheme: dark){body{background:#000}}</style><p>page</p>");
  }).listen(0);
  const port = server.address().port;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-site-light-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..'), `--host-resolver-rules=MAP www.glassdoor.com 127.0.0.1:${port}, MAP www.example.com 127.0.0.1:${port}`],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile }, timeout: 30000,
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const open = (url) => app.evaluate(async (_e, u) => {
    const t = global.__agent.browser.openTab(u);
    await new Promise((r) => t.webContents.once('did-finish-load', r));
    return t.id;
  }, url);
  // Playwright emulates a light color scheme on every page it attaches to (its own default); its page for the tab is told to drop that,
  // so what the tab sees is Lumen's theme and Lumen's override only.
  const freed = new Set();
  const look = async (url) => {
    await app.evaluate(async (_e, u) => {
      const wc = global.__agent.browser.activeTab().webContents;
      if (wc.getURL() !== u) await wc.loadURL(u).catch(() => {});
    }, url);
    for (const p of app.context().pages()) if (p.url().includes(`:${port}/`) && !freed.has(p)) { freed.add(p); await p.emulateMedia({ colorScheme: null }).catch(() => {}); }
    return app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript("({ url: location.href, dark: matchMedia('(prefers-color-scheme: dark)').matches, bg: getComputedStyle(document.body).backgroundColor })"));
  };

  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
  await sleep(300);
  await open(`http://www.example.com:${port}/`);
  let st = await look(`http://www.example.com:${port}/`);
  check('dark theme: another site sees dark', st.dark === true && st.bg === 'rgb(0, 0, 0)', JSON.stringify(st));
  st = await look(`http://www.glassdoor.com:${port}/Reviews/index.htm`);
  check('dark theme: Glassdoor is told light and draws its light page', st.url.includes('glassdoor') && st.dark === false && st.bg === 'rgb(255, 255, 255)', JSON.stringify(st));
  st = await look(`http://www.example.com:${port}/back`);
  check('leaving Glassdoor in the same tab: the dark theme again', st.dark === true, JSON.stringify(st));
  st = await look(`http://www.glassdoor.com:${port}/Job/index.htm`);
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light'; });
  await sleep(500);
  st = await look(`http://www.glassdoor.com:${port}/Job/index.htm`);
  check('light theme: Glassdoor is light, as the theme says', st.dark === false, JSON.stringify(st));
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
  await sleep(500);
  st = await look(`http://www.glassdoor.com:${port}/Job/index.htm`);
  check('the theme turned dark with Glassdoor open: still told light', st.dark === false, JSON.stringify(st));

  await app.close();
  server.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
