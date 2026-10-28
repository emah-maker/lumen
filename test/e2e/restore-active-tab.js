// A restart brings the tab that was in front back loaded: its address, title and page, not a blank tab stuck
// loading. Checked after a clean quit and after the main process is killed (an unclean exit), on one profile; and while a slow page
// (a sign-in page that takes seconds to answer) is still on its way, the tab shows its saved title and the address bar its address.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const { execFileSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-restore-active-'));
  const launch = () => electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile }, timeout: 30000 });
  let slowMs = 0; // (the last relaunch: the front page's first answer takes this long)
  const server = http.createServer((req, res) => {
    const name = (req.url.match(/^\/(\w+)/) || [])[1] || 'root';
    res.setHeader('Content-Type', 'text/html');
    setTimeout(() => res.end(`<title>Page ${name}</title><h1>${name}</h1>`), name === 'first' ? slowMs : 0);
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // The tab in front, as main and the window's own tab strip and address bar see it, once it has had time to load.
  const front = async (app, ui) => {
    const deadline = Date.now() + 15000;
    let st = null;
    while (Date.now() < deadline) {
      st = await app.evaluate(() => {
        const wc = global.__agent.browser.activeTab()?.webContents;
        return wc ? { url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading() } : null;
      });
      if (st && !st.loading && st.title.startsWith('Page')) break;
      await sleep(250);
    }
    const strip = await ui.evaluate(() => {
      const tab = document.querySelector('.tab.active');
      const addr = document.getElementById('address');
      return { title: tab?.textContent.trim() || '', loading: document.body.classList.contains('tab-loading'), address: addr?.value || '' };
    });
    return { ...st, strip };
  };

  let app = await launch();
  let ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await app.evaluate((_e, u) => global.__agent.execute('navigate', { url: u }), `${base}/first`);
  for (const n of ['second', 'third', 'fourth']) await app.evaluate((_e, u) => global.__passkeys.openBackground(u), `${base}/${n}`);
  await sleep(1500);
  const firstId = await app.evaluate(() => { const t = global.__tabSleep.state()[0]; global.__aiTabs.switchTo(t.id); return t.id; });
  await sleep(500);
  const seen = await front(app, ui);
  check('before the restart the first tab is in front', seen.url === `${base}/first`, JSON.stringify(seen) + ' id ' + firstId);

  // 1) A clean quit, then a start on the same profile.
  await app.close();
  app = await launch();
  ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  let st = await front(app, ui);
  console.log('      after a clean quit:', JSON.stringify(st));
  check('clean quit: the front tab comes back with its address', st.url === `${base}/first`, JSON.stringify(st));
  check('clean quit: the front tab finishes loading with its title', st.loading === false && st.title === 'Page first', JSON.stringify(st));
  check('clean quit: the tab strip shows its title, not a spinner', st.strip.title.includes('Page first') && !st.strip.loading, JSON.stringify(st.strip));
  check('clean quit: the address bar shows its address', st.strip.address.includes('/first'), JSON.stringify(st.strip));

  // 2) An unclean exit: the main process is killed (its children are left behind, as in a crash).
  await sleep(3500); // (the session is saved in the background)
  const launcher = app.process().pid;
  const mainPid = await app.evaluate(() => process.pid);
  execFileSync('taskkill', ['/F', '/PID', String(mainPid)]);
  if (launcher !== mainPid) { try { process.kill(launcher, 'SIGKILL'); } catch { /* gone */ } }
  await sleep(1500);
  app = await launch();
  ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  st = await front(app, ui);
  console.log('      after an unclean exit:', JSON.stringify(st));
  check('unclean exit: the front tab comes back with its address', st.url === `${base}/first`, JSON.stringify(st));
  check('unclean exit: the front tab finishes loading with its title', st.loading === false && st.title === 'Page first', JSON.stringify(st));
  check('unclean exit: the tab strip shows its title, not a spinner', st.strip.title.includes('Page first') && !st.strip.loading, JSON.stringify(st.strip));
  check('unclean exit: the address bar shows its address', st.strip.address.includes('/first'), JSON.stringify(st.strip));

  // 3) A slow first answer: before it arrives the tab is not a blank "New Tab" with an empty address bar.
  await sleep(3500);
  await app.close();
  slowMs = 8000;
  app = await launch();
  ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await sleep(1500);
  const waiting = await ui.evaluate(() => ({ title: document.querySelector('.tab.active')?.textContent.trim() || '', address: document.getElementById('address')?.value || '' }));
  const stillLoading = await app.evaluate(() => global.__agent.browser.activeTab()?.webContents.isLoading());
  console.log('      while the slow page loads:', JSON.stringify(waiting), 'loading', stillLoading);
  check('slow page: still on its way when looked at', stillLoading === true, stillLoading);
  check('slow page: the tab shows its saved title, not New Tab', waiting.title.includes('Page first'), JSON.stringify(waiting));
  check('slow page: the address bar shows the address it is loading', waiting.address.includes('/first'), JSON.stringify(waiting));
  st = await front(app, ui);
  check('slow page: it then loads with its own title', st.loading === false && st.title === 'Page first' && st.url === `${base}/first`, JSON.stringify(st));

  await app.close();
  server.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
