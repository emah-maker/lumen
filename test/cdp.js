// Automation over CDP: Playwright's connectOverCDP sees only the user's tabs, newPage opens a real
// Lumen tab, disconnecting never quits Lumen, and with the setting off no port listens.
const { _electron: electron, chromium } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const PORT = 9339;
const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.on('connect', () => { s.destroy(); resolve(true); });
  s.on('error', () => resolve(false));
});
const wsStatus = (url, headers = {}) => new Promise((resolve) => {
  const u = new URL(url);
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
  req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
  req.on('response', (res) => resolve(res.statusCode));
  req.on('error', () => resolve(0));
  req.end();
});

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>Fixture ${req.url}</title><button onclick="document.title='clicked'">Go</button>`);
  }).listen(0);
  const site = `http://127.0.0.1:${server.address().port}`;

  // 1. Setting off (a fresh profile): nothing listens.
  const offProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cdp-off-'));
  let app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: offProfile } });
  await (await app.firstWindow()).waitForSelector('.tab');
  check('setting off: configured port closed', !(await portOpen(PORT)), 'port open');
  const offInfo = await (await app.firstWindow()).evaluate(() => window.assistant.automationInfo());
  check('setting off by default', offInfo.enabled === false && offInfo.running === null, JSON.stringify(offInfo));
  await app.close();

  // 2. Setting on.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cdp-on-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ automationEnabled: true, automationPort: PORT }));
  app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const lumenTabs = () => app.evaluate(() => global.__agent.browser.listTabs().length);
  await app.evaluate((_e, url) => global.__agent.execute('navigate', { url }), `${site}/first`);

  const version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json());
  check('/json/version points at the proxy', version.webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${PORT}/devtools/browser/`), JSON.stringify(version));
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
  check('/json/list: only user tabs', list.length === await lumenTabs() && list.every((t) => !t.url.includes('renderer/index.html')), JSON.stringify(list.map((t) => t.url)));
  const blocked = await fetch(`http://127.0.0.1:${PORT}/json/list`, { headers: { Origin: 'https://evil.example' } }).then((r) => r.status);
  check('web pages (Origin header) are refused', blocked === 403, blocked);

  // The UI's own target is not reachable through the proxy.
  const [internalPort] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n');
  const all = await fetch(`http://127.0.0.1:${internalPort}/json/list`).then((r) => r.json());
  const uiTarget = all.find((t) => t.url.includes('renderer/index.html'));
  check('UI target cannot be attached', uiTarget && (await wsStatus(`ws://127.0.0.1:${PORT}/devtools/page/${uiTarget.id}`)) === 404, uiTarget?.id);

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const context = browser.contexts()[0];
  const pages = context.pages();
  check('connectOverCDP sees the user tabs only', pages.length === await lumenTabs() && pages.some((p) => p.url().includes('/first')) && !pages.some((p) => p.url().startsWith('file:')), pages.map((p) => p.url()).join(', '));
  const first = pages.find((p) => p.url().includes('/first'));
  await first.click('button');
  check('drive a tab: click', (await first.title()) === 'clicked', await first.title());
  await ui.waitForTimeout(300);
  check('pill shows the automation client', await ui.evaluate(() => document.body.classList.contains('mcp-active') && document.getElementById('agent-pill').textContent.includes('Playwright')), await ui.evaluate(() => document.getElementById('agent-pill')?.textContent));

  const before = await lumenTabs();
  const page = await context.newPage();
  await page.goto(`${site}/second`);
  check('newPage opens a real Lumen tab', (await lumenTabs()) === before + 1 && (await page.title()) === 'Fixture /second', `${await lumenTabs()} tabs`);
  const active = await app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL());
  check('new page is the active tab', active.endsWith('/second'), active);
  await page.close();
  await ui.waitForTimeout(300);
  check('page.close closes the Lumen tab', (await lumenTabs()) === before, await lumenTabs());

  // The sidebar agent still works while a CDP client is attached (applyChromeIdentity's debugger too).
  const read = await app.evaluate(() => global.__agent.execute('read_page', { mode: 'compact' }));
  check('agent tools work alongside CDP', read.includes('[1] button "Go"'), read);

  await browser.close();
  await ui.waitForTimeout(500);
  check('disconnecting leaves Lumen running', (await lumenTabs()) >= 1, 'no tabs');
  check('pill clears after disconnect', !(await ui.evaluate(() => document.body.classList.contains('mcp-active'))), 'still active');

  // Turning the setting off closes the port right away.
  await ui.evaluate(() => window.assistant.setAutomation({ enabled: false, port: 9339 }));
  await ui.waitForTimeout(200);
  check('turning off closes the port', !(await portOpen(PORT)), 'still open');

  await app.close();
  server.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
