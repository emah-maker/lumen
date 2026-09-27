// AI web panels: claude.ai / ChatGPT / Gemini / Grok docked in the sidebar with the user's own account.
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Share me</title><h1>Shared page body</h1><p>Some readable text for the clipboard.</p>');
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const panel = (service) => app.evaluate((_e, s) => {
    const v = global.__webPanels.get(s);
    return v ? { id: v.webContents.id, url: v.webContents.getURL(), visible: v.getVisible(), bounds: v.getBounds() } : null;
  }, service);
  const hostRect = () => ui.evaluate(() => {
    const r = document.getElementById('webai-host').getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  });

  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await sleep(1000);
  const labels = await ui.$$eval('#ai-switch button', (bs) => bs.map((b) => b.textContent).join(','));
  check('switch shows Agent, Claude, ChatGPT, Gemini, Grok', labels === 'Agent,Claude,ChatGPT,Gemini,Grok', labels);

  await ui.click('#ai-switch [data-mode="claude"]');
  let p = null;
  for (let i = 0; i < 40 && !(p && /claude\.ai|anthropic\.com/.test(p.url)); i++) { await sleep(500); p = await panel('claude'); }
  check('Claude mode loads claude.ai in a docked view', p && /^https:\/\/([a-z0-9-]+\.)*(claude\.ai|anthropic\.com)\//.test(p.url) && p.visible, JSON.stringify(p));
  await sleep(400);
  const r1 = await hostRect();
  p = await panel('claude');
  const near = (a, b) => Math.abs(a - b) <= 1;
  check('panel covers the sidebar content area', near(p.bounds.x, r1.x) && near(p.bounds.y, r1.y) && near(p.bounds.width, r1.width) && near(p.bounds.height, r1.height), `${JSON.stringify(p.bounds)} vs ${JSON.stringify(r1)}`);
  check('chat UI hidden and Share page shown in web mode', (await ui.isHidden('#composer')) && (await ui.isVisible('#share-page')), 'visibility');
  check('toolbar mark follows the panel (Claude)', (await ui.getAttribute('#toggle-sidebar', 'data-assistant')) === 'Claude', await ui.getAttribute('#toggle-sidebar', 'data-assistant'));

  // Resize the sidebar: the panel follows.
  await ui.evaluate(() => { document.documentElement.style.setProperty('--sidebar-width', '480px'); });
  await sleep(500);
  const r2 = await hostRect();
  p = await panel('claude');
  check('panel follows a sidebar resize', near(p.bounds.width, r2.width) && r2.width > r1.width, `${JSON.stringify(p.bounds)} vs ${JSON.stringify(r2)}`);

  // Close and reopen: the same page (no reload), hidden while closed. During the spring the host
  // shows a snapshot of the panel instead of going blank.
  const id = p.id;
  const watchSpring = () => ui.evaluate(() => new Promise((resolve) => {
    let seen = false;
    const host = document.getElementById('webai-host');
    const t0 = performance.now();
    document.getElementById('toggle-sidebar').click();
    const tick = () => {
      const img = host.querySelector('.webai-snapshot');
      if (img && img.naturalWidth > 0) seen = true;
      if (performance.now() - t0 < 1400) requestAnimationFrame(tick);
      else resolve({ seen, left: Boolean(host.querySelector('.webai-snapshot')) });
    };
    requestAnimationFrame(tick);
  }));
  const closing = await watchSpring();
  check('panel snapshot shows while the sidebar closes', closing.seen && !closing.left, JSON.stringify(closing));
  check('panel hidden while the sidebar is closed', (await panel('claude')).visible === false, 'still visible');
  const opening = await watchSpring();
  check('panel snapshot shows while the sidebar opens, then the live panel', opening.seen && !opening.left, JSON.stringify(opening));
  p = await panel('claude');
  check('panel survives close/open without reloading', p.id === id && p.visible, JSON.stringify(p));

  // Other services, then back to Agent.
  await ui.click('#ai-switch [data-mode="chatgpt"]');
  await sleep(600);
  check('ChatGPT mode: its own view, Claude view hidden', (await panel('chatgpt'))?.visible && !(await panel('claude')).visible, 'visibility');
  check('toolbar mark follows (ChatGPT)', (await ui.getAttribute('#toggle-sidebar', 'data-assistant')) === 'ChatGPT', await ui.getAttribute('#toggle-sidebar', 'data-assistant'));
  await ui.click('#ai-switch [data-mode="agent"]');
  await sleep(400);
  check('Agent mode hides every panel and shows the chat', !(await panel('chatgpt')).visible && !(await panel('claude')).visible && (await ui.isVisible('#composer')), 'visibility');

  // Share page: title, URL and text on the clipboard.
  await app.evaluate((_e, u) => global.__agent.execute('navigate', { url: u }), base + '/');
  await ui.click('#ai-switch [data-mode="claude"]');
  await sleep(400);
  await ui.click('#share-page');
  await sleep(500);
  const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
  check('Share page copies title, URL and text', clip.includes('Share me') && clip.includes(base) && clip.includes('Shared page body'), clip.slice(0, 200));
  check('toast confirms the copy', /Page copied/.test(await ui.textContent('#webai-toast')), await ui.textContent('#webai-toast'));

  // Popups from a panel keep window.opener (SSO sign-in windows).
  const popup = await app.evaluate(async ({ BrowserWindow }, u) => {
    const wc = global.__webPanels.get('claude').webContents;
    const before = BrowserWindow.getAllWindows().length;
    await wc.executeJavaScript(`window.__p = window.open(${JSON.stringify(u)}, 'sso', 'width=400,height=400'); !!window.__p`, true);
    await new Promise((r) => setTimeout(r, 1500));
    const wins = BrowserWindow.getAllWindows();
    const child = wins.find((w) => w.webContents.getURL().startsWith(u));
    const hasOpener = child ? await child.webContents.executeJavaScript('!!window.opener', true) : null;
    child?.close();
    return { opened: wins.length === before + 1, hasOpener };
  }, base + '/popup').catch((e) => ({ error: e.message }));
  check('window.open from a panel opens a popup with an opener', popup.opened && popup.hasOpener === true, JSON.stringify(popup));

  // Keyboard: Ctrl+Shift+4 selects Gemini (sent through the same channel main uses).
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/renderer/index.html')).webContents.send('webai:switch', 3));
  await sleep(500);
  check('Ctrl+Shift+N picks a mode', (await ui.getAttribute('#ai-switch [data-mode="gemini"]', 'aria-selected')) === 'true', 'not selected');
  check('last mode is remembered', (await ui.evaluate(() => window.browser.webAiState())).mode === 'gemini', 'not saved');

  // Panels hidden for over 10 minutes are unloaded (default session: logins stay) and reload on demand.
  await app.evaluate(() => global.__unloadIdleWebPanels(Date.now() + 11 * 60 * 1000));
  check('idle panels are unloaded', !(await panel('claude')) && !(await panel('chatgpt')), 'still loaded');
  await ui.click('#ai-switch [data-mode="claude"]');
  let back = null;
  for (let i = 0; i < 30 && !(back && back.visible && back.url); i++) { await sleep(300); back = await panel('claude'); }
  check('an unloaded panel comes back when picked', back && back.visible && /claude\.ai|anthropic\.com/.test(back.url), JSON.stringify(back));

  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
