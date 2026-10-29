// A site whose dark mode is half built (dark sections over cards left white, light text on some of them: what Glassdoor showed) is found by measuring
// the page, told the system is light, and remembered; a whole dark page, a page with no dark mode, and a page whose light version is no better keep
// the theme (browser/half-dark.js, browser/chrome-identity.js watcher). No list of sites: the hosts are made up and mapped to a local server.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { halfDark } = require('../../src/browser/half-dark');

const words = 'Reviews from people who work here, salaries, interviews and the benefits they get. ';
const para = (n) => `<p>${words.repeat(n)}</p>`;
const cards = (n) => Array.from({ length: n }, (_, i) => `<div class="card"><h3>Card ${i + 1}</h3>${para(2)}</div>`).join('');
const page = (css, body) => `<!doctype html><title>scheme</title><style>body{margin:0;font:16px sans-serif}${css}</style>${body}`;
const PAGES = {
  // dark mode turns the page and its sections dark and the text light, but the cards keep a fixed white background: light text on white
  half: page(`body{background:#fff;color:#222}.side{background:#f4f4f4}.card{background:#fff;border:1px solid #ddd;margin:8px;padding:8px}
    @media (prefers-color-scheme: dark){body{background:#121212;color:#eee}.side{background:#1e1e1e}}`,
  `<div class="side">${para(6)}</div><div class="main">${cards(6)}</div>`),
  // a whole dark mode: everything changes
  full: page(`body{background:#fff;color:#222}.card{background:#fafafa;margin:8px;padding:8px}
    @media (prefers-color-scheme: dark){body{background:#121212;color:#eee}.card{background:#1e1e1e}}`,
  `${para(6)}${cards(6)}`),
  // no dark mode at all
  light: page('body{background:#fff;color:#222}.card{background:#fafafa;margin:8px;padding:8px}', `${para(6)}${cards(6)}`),
  // half dark whatever it is told: the light page is no better, so it is not kept
  same: page('body{background:#121212;color:#eee}.card{background:#fff;margin:8px;padding:8px}', `${para(6)}${cards(6)}`),
};

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const server = http.createServer((req, res) => {
    const kind = (req.headers.host || '').split('.')[0];
    res.setHeader('Content-Type', 'text/html');
    res.end(PAGES[kind] || PAGES.light);
  }).listen(0);
  const port = server.address().port;
  const host = (k) => `${k}.sites.test`;
  const url = (k, p = '/') => `http://${host(k)}:${port}${p}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-site-light-'));
  const rules = Object.keys(PAGES).map((k) => `MAP ${host(k)} 127.0.0.1:${port}`).join(', ');
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..'), `--host-resolver-rules=${rules}`],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile }, timeout: 30000,
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
  await sleep(300);

  // Playwright emulates a light color scheme on every page it attaches to (its own default): its page for the tab is told to drop that, and the tab
  // is loaded again, so what the page sees and what it is measured in is Lumen's theme and Lumen's override only.
  const freed = new Set();
  const state = () => app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript("({ url: location.href, dark: matchMedia('(prefers-color-scheme: dark)').matches, bg: getComputedStyle(document.body).backgroundColor })"));
  const visit = async (u, waitMs = 5600) => {
    await app.evaluate(async (_e, x) => {
      const t = global.__agent.browser.openTab(x);
      await new Promise((r) => t.webContents.once('did-finish-load', r));
    }, u);
    for (const p of app.context().pages()) if (p.url().includes(`:${port}/`) && !freed.has(p)) { freed.add(p); await p.emulateMedia({ colorScheme: null }).catch(() => {}); }
    await app.evaluate(async () => {
      global.__halfDarkLog = [];
      const wc = global.__agent.browser.activeTab().webContents;
      wc.reload();
      await new Promise((r) => wc.once('did-finish-load', r));
    });
    await sleep(waitMs); // (measured 1.2 s after the load and again at 4.5 s; the light page is measured 0.7 s after it is asked for)
    return { ...(await state()), log: await app.evaluate(() => global.__halfDarkLog), kept: await app.evaluate(() => global.__halfDark.store().hosts()) };
  };

  let st = await visit(url('half', '/Reviews'));
  check('a half-built dark mode is measured as one', st.log.some((x) => x.before && x.before.dark && halfDark(x.before)), JSON.stringify(st.log));
  check('...told light, and draws its light page', st.dark === false && st.bg === 'rgb(255, 255, 255)', JSON.stringify(st));
  check('...and its host is kept', st.kept.includes(host('half')), JSON.stringify(st.kept));
  const saved = path.join(profile, 'half-dark-sites.json');
  await sleep(300);
  check('...saved in the profile', fs.existsSync(saved) && JSON.parse(fs.readFileSync(saved, 'utf8')).hosts.includes(host('half')), fs.existsSync(saved) ? fs.readFileSync(saved, 'utf8') : 'no file');

  st = await visit(url('full'));
  check('a whole dark mode keeps the dark theme', st.dark === true && st.bg === 'rgb(18, 18, 18)' && !st.kept.includes(host('full')), JSON.stringify(st));
  st = await visit(url('light'));
  check('a page with no dark mode is left as it is', st.dark === true && st.bg === 'rgb(255, 255, 255)' && !st.kept.includes(host('light')), JSON.stringify(st));
  st = await visit(url('same'));
  check('a page that looks half dark either way is tried, and its light page found no better', st.log.some((x) => x.after) && !st.kept.includes(host('same')), JSON.stringify(st.log));
  check('...so it keeps the dark theme', st.dark === true, JSON.stringify(st));

  // the kept site is light from the start of its next visit, follows the theme, and other sites still see dark in the same tab
  st = await visit(url('half', '/Jobs'), 400);
  check('the kept site is light from the start of its next visit', st.dark === false, JSON.stringify(st));
  await app.evaluate(async (_e, u) => { const wc = global.__agent.browser.activeTab().webContents; await wc.loadURL(u).catch(() => {}); }, url('full', '/back'));
  st = await state();
  check('leaving it in the same tab: the dark theme again', st.dark === true, JSON.stringify(st));
  await app.evaluate(async (_e, u) => { const wc = global.__agent.browser.activeTab().webContents; await wc.loadURL(u).catch(() => {}); }, url('half', '/Jobs'));
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light'; });
  await sleep(500);
  st = await state();
  check('light theme: the kept site is light, as the theme says', st.dark === false, JSON.stringify(st));
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
  await sleep(500);
  st = await state();
  check('the theme turned dark with the kept site open: still told light', st.dark === false, JSON.stringify(st));

  await app.close();
  server.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });

