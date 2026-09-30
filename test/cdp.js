// Automation over CDP: Playwright's connectOverCDP sees only the user's tabs, newPage opens a real
// Lumen tab, disconnecting never quits Lumen, and with the setting off no port listens. Every proxy
// URL needs the token Settings shows, and Chromium's DevToolsActivePort file doesn't stay around.
// Parts 1 and 2 run under Playwright's _electron (Chromium's port, as on macOS); part 3 starts Lumen
// the way a user does, through launcher.js: Chromium on a private pipe, no debugging port at all.
const { _electron: electron, chromium } = require('playwright-core');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const PORT = 9339;
// The in-process backend (cdp-inproc.js): always on macOS, LUMEN_AUTOMATION_INPROC=1 elsewhere.
// Parts 1 and 2 run the same checks against it; part 3 (the launcher) doesn't apply.
const INPROC = process.platform === 'darwin' || process.env.LUMEN_AUTOMATION_INPROC === '1';
const APP_DIR = path.join(__dirname, '..');
const until = async (fn, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 250))) {
    try { const value = await fn(); if (value) return value; } catch {}
  }
  return null;
};
// [{ pid, ppid, cmd }] for every process.
function processes() {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return JSON.parse(out).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, cmd: p.CommandLine || '' }));
  }
  return execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }).trim().split('\n').map((line) => {
    const [, pid, ppid, cmd] = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return { pid: Number(pid), ppid: Number(ppid), cmd };
  });
}
// The process started by `parentPid` running launcher.js, the browser it started, and every process under that.
// The launcher a launch started. The first process hands over and exits; Windows keeps its pid as
// the launcher's parent, but macOS and Linux re-parent the orphan to pid 1, so a launcher that is
// new since the launch (`before`) and now belongs to pid 1 counts too.
const launcherPids = () => new Set(processes().filter((p) => /launcher\.js/.test(p.cmd)).map((p) => p.pid));
function launchedTree(parentPid, before = new Set()) {
  const all = processes();
  const launcher = all.find((p) => /launcher\.js/.test(p.cmd) && (p.ppid === parentPid || (p.ppid === 1 && !before.has(p.pid))));
  const browser = launcher && all.find((p) => p.ppid === launcher.pid && !/--type=/.test(p.cmd));
  const tree = new Set(browser ? [browser.pid] : []);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of all) if (tree.has(p.ppid) && !tree.has(p.pid)) { tree.add(p.pid); grew = true; }
  }
  return { launcher, browser, tree };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// TCP ports listened on by these processes (Windows: netstat; elsewhere lsof).
function listeners(pids) {
  if (process.platform !== 'win32') {
    let out = '';
    try { out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8' }); } catch {} // exits 1 when nothing listens
    const found = [];
    let pid = 0;
    for (const line of out.split('\n')) {
      if (line[0] === 'p') pid = Number(line.slice(1));
      else if (line[0] === 'n' && pids.has(pid)) found.push({ address: line.slice(1), port: Number(line.split(':').pop()), pid });
    }
    return found;
  }
  return execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true }).split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((f) => f[0] === 'TCP' && f[3] === 'LISTENING' && pids.has(Number(f[4])))
    .map((f) => ({ address: f[1], port: Number(f[1].split(':').pop()), pid: Number(f[4]) }));
}
// Closes Lumen the way closing its window does (Windows: WM_CLOSE; elsewhere SIGTERM).
function quit(pid) {
  if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid)], { stdio: 'ignore' });
  else process.kill(pid, 'SIGTERM');
}
const forceKill = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch {} };
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

  // The address Settings shows: http://127.0.0.1:<port>/<token>, the token kept in the profile.
  const info = await ui.evaluate(() => window.assistant.automationInfo());
  const { token } = info;
  const root = `http://127.0.0.1:${PORT}/${token}`;
  check('Lumen reports the token it listens with', /^[0-9a-f]{48}$/.test(token) && fs.readFileSync(path.join(profile, 'automation-token'), 'utf8').trim() === token && info.running?.listening, JSON.stringify(info));
  const statusOf = (url) => fetch(url).then((r) => r.status, () => 0);
  const bare = await statusOf(`http://127.0.0.1:${PORT}/json/version`);
  check('proxy without the token is refused', bare === 401 && (await statusOf(`http://127.0.0.1:${PORT}/json/list`)) === 401, bare);
  check('proxy with a wrong token is refused', (await statusOf(`http://127.0.0.1:${PORT}/${'0'.repeat(48)}/json/version`)) === 401 && (await statusOf(`${root}x/json/version`)) === 401, 'accepted');
  const bareWs = await wsStatus(`ws://127.0.0.1:${PORT}/devtools/browser`);
  check('WebSocket without the token is refused', bareWs === 401, bareWs);
  const noToken = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`).then((b) => { b.close(); return 'connected'; }, (err) => err.message);
  check('connectOverCDP without the token fails', /401/.test(noToken), noToken);
  // (Not with the in-process backend: it never reads Chromium's port, which here is Playwright's own.)
  if (!INPROC) check('DevToolsActivePort is gone once read', !fs.existsSync(path.join(profile, 'DevToolsActivePort')), 'still there');

  const version = await fetch(`${root}/json/version`).then((r) => r.json());
  check('/json/version points at the proxy, token included', version.webSocketDebuggerUrl === `ws://127.0.0.1:${PORT}/${token}/devtools/browser`, JSON.stringify(version));
  const list = await fetch(`${root}/json/list`).then((r) => r.json());
  check('/json/list: only user tabs', list.length === await lumenTabs() && list.every((t) => !t.url.includes('src/renderer/index.html') && t.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${PORT}/${token}/devtools/page/`)), JSON.stringify(list.map((t) => t.url)));
  const blocked = await fetch(`${root}/json/list`, { headers: { Origin: 'https://evil.example' } }).then((r) => r.status);
  check('web pages (Origin header) are refused', blocked === 403, blocked);

  // The UI's own target is not reachable through the proxy.
  const uiTarget = await app.evaluate(async ({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    wc.debugger.attach('1.3');
    const { targetInfo } = await wc.debugger.sendCommand('Target.getTargetInfo');
    wc.debugger.detach();
    return targetInfo.targetId;
  });
  check('UI target cannot be attached', uiTarget && (await wsStatus(`ws://127.0.0.1:${PORT}/${token}/devtools/page/${uiTarget}`)) === 404, uiTarget);
  check('a tab with the token can be attached', (await wsStatus(list[0].webSocketDebuggerUrl)) === 101, list[0]?.webSocketDebuggerUrl);
  check('a tab without the token is refused',(await wsStatus(list[0].webSocketDebuggerUrl.replace(`/${token}`, ''))) === 401, list[0]?.webSocketDebuggerUrl);

  const browser = await chromium.connectOverCDP(root);
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
  await ui.waitForTimeout(2000); // the pill holds for 1.5 s after the last client leaves (renderer MCP_PILL_HOLD_MS)
  check('disconnecting leaves Lumen running', (await lumenTabs()) >= 1, 'no tabs');
  check('pill clears after disconnect', !(await ui.evaluate(() => document.body.classList.contains('mcp-active'))), 'still active');

  // Turning the setting off closes the port right away.
  await ui.evaluate(() => window.assistant.setAutomation({ enabled: false, port: 9339 }));
  await ui.waitForTimeout(200);
  check('turning off closes the port', !(await portOpen(PORT)), 'still open');
  check('turning off forgets the token', !fs.existsSync(path.join(profile, 'automation-token')), 'still there');
  const again = await ui.evaluate(() => window.assistant.setAutomation({ enabled: true, port: 9339 }).then(() => window.assistant.automationInfo()));
  check('turning it back on makes a new address', /^[0-9a-f]{48}$/.test(again.token) && again.token !== token, again.token);

  await app.close();

  // 3. Started the way a user starts it: through launcher.js, Chromium on a private pipe. (macOS and
  // LUMEN_AUTOMATION_INPROC=1 have no launcher: test/cdp-inproc.js covers those.)
  if (INPROC) console.log('SKIP  launcher part (the in-process backend has no launcher; see test/cdp-inproc.js)');
  else {
    const pipeProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cdp-pipe-'));
    fs.writeFileSync(path.join(pipeProfile, 'settings.json'), JSON.stringify({ automationEnabled: true, automationPort: PORT }));
    const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: pipeProfile, LUMEN_TEST_LAUNCHER: '1' };
    let log = '';
    const launch = (args = []) => {
      const before = launcherPids();
      const child = spawn(require('electron'), [APP_DIR, ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.on('data', (d) => { log += d; });
      return { child, before, exited: new Promise((resolve) => child.on('exit', resolve)) };
    };
    const first = launch();
    const tokenFile = path.join(pipeProfile, 'automation-token');
    const pipeToken = await until(() => fs.existsSync(tokenFile) && fs.readFileSync(tokenFile, 'utf8').trim());
    const pipeRoot = `http://127.0.0.1:${PORT}/${pipeToken}`;
    const pipeList = () => fetch(`${pipeRoot}/json/list`).then((r) => r.json());
    const up = await until(async () => (await pipeList()).length >= 1);
    check('pipe: the proxy answers with the token', up, log.slice(-500));
    check('pipe: the first process hands over and exits', (await Promise.race([first.exited, new Promise((r) => setTimeout(() => r('running'), 5000))])) === 0, 'still running');
    const { launcher, browser, tree } = launchedTree(first.child.pid, first.before);
    check('pipe: Lumen runs under launcher.js, without a debugging port switch', launcher && browser && !/remote-debugging/.test(browser.cmd), JSON.stringify({ launcher, browser }));
    check('pipe: no DevToolsActivePort file', !fs.existsSync(path.join(pipeProfile, 'DevToolsActivePort')), 'written');
    if (process.platform === 'win32' && browser) {
      const open = listeners(new Set([...tree, launcher.pid]));
      check('pipe: the only listening port in Lumen\'s processes is the proxy', open.length >= 1 && open.every((l) => l.port === PORT && l.pid === browser.pid), JSON.stringify(open));
    } else {
      console.log('SKIP  listening-port check (Windows only)');
    }
    check('pipe: no token is refused', (await statusOf(`http://127.0.0.1:${PORT}/json/version`)) === 401 && (await wsStatus(`ws://127.0.0.1:${PORT}/devtools/browser`)) === 401, 'accepted');

    const pipeVersion = await fetch(`${pipeRoot}/json/version`).then((r) => r.json());
    check('pipe: /json/version from the pipe', /^Lumen\/\d/.test(pipeVersion.Browser) && pipeVersion.webSocketDebuggerUrl === `ws://127.0.0.1:${PORT}/${pipeToken}/devtools/browser`, JSON.stringify(pipeVersion));
    const pipeBrowser = await chromium.connectOverCDP(pipeRoot);
    const pipeContext = pipeBrowser.contexts()[0];
    const tabsBefore = pipeContext.pages();
    check('pipe: connectOverCDP lists the user tabs only', tabsBefore.length >= 1 && tabsBefore.length === (await pipeList()).length && !tabsBefore.some((p) => p.url().includes('src/renderer/index.html')), tabsBefore.map((p) => p.url()).join(', '));
    const piped = await pipeContext.newPage();
    await piped.goto(`${site}/piped`);
    check('pipe: newPage opens a tab and navigates', (await piped.title()) === 'Fixture /piped' && (await pipeList()).length === tabsBefore.length + 1, await piped.title());
    check('pipe: evaluate in a tab', (await piped.evaluate(() => 6 * 7)) === 42, 'wrong result');
    await piped.click('button');
    check('pipe: click in a tab', (await piped.title()) === 'clicked', await piped.title());
    // A page endpoint is its own session on the same pipe.
    const pageUrl = (await pipeList()).find((t) => t.url.endsWith('/piped'))?.webSocketDebuggerUrl;
    const evaluated = await new Promise((resolve) => {
      const ws = new WebSocket(pageUrl);
      ws.onopen = () => ws.send(JSON.stringify({ id: 7, method: 'Runtime.evaluate', params: { expression: 'document.title' } }));
      ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.id === 7) { ws.close(); resolve(msg.result?.result?.value); } };
      ws.onerror = () => resolve('error');
      setTimeout(() => resolve('timeout'), 10000);
    });
    check('pipe: a page endpoint works', evaluated === 'clicked', evaluated);
    await pipeBrowser.close();

    // Opening Lumen again while it runs hands the link over; no second launcher.
    const second = launch([`${site}/forwarded`]);
    const secondCode = await Promise.race([second.exited, new Promise((r) => setTimeout(() => r('running'), 15000))]);
    const forwarded = await until(async () => (await pipeList()).some((t) => t.url.endsWith('/forwarded')), 10000);
    check('pipe: a second launch passes its link to the running Lumen', secondCode === 0 && forwarded && !launchedTree(second.child.pid, second.before).launcher, `exit ${secondCode}`);

    // Quitting Lumen ends the launcher too.
    if (browser) quit(browser.pid);
    const bothGone = await until(() => !alive(browser?.pid) && !alive(launcher?.pid), 20000);
    check('pipe: quitting Lumen ends the launcher too', bothGone, `browser ${alive(browser?.pid)}, launcher ${alive(launcher?.pid)}`);
    if (!bothGone) { forceKill(browser?.pid); forceKill(launcher?.pid); }

    // And the other way round: the launcher going away closes the pipe, and Chromium quits.
    const third = launch();
    await until(async () => (await pipeList()).length >= 1);
    const again3 = launchedTree(third.child.pid, third.before);
    if (again3.launcher) forceKill(again3.launcher.pid);
    const browserGone = await until(() => again3.browser && !alive(again3.browser.pid), 20000);
    check('pipe: Lumen quits when the launcher is killed', browserGone, JSON.stringify(again3.browser));
    if (!browserGone) forceKill(again3.browser?.pid);
  }

  server.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
