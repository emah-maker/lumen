// Automation over CDP with the in-process backend (cdp-inproc.js): what macOS runs, and what
// LUMEN_AUTOMATION_INPROC=1 runs anywhere. No debugging port, no pipe, no launcher: Chromium's DevTools
// is reachable only through Lumen's own token proxy, and a link opened from another app (macOS
// 'open-url') still reaches the one process that owns it.
// Part 1 starts Lumen the way a user does (a plain process, no Playwright attached) and checks nothing
// but the proxy listens, then drives it with Playwright's connectOverCDP. Part 2 runs under Playwright's
// _electron (which adds its own debugging switches, so no port check there) for open-url and quitting.
const { _electron: electron, chromium } = require('playwright-core');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const PORT = 9340;
const APP_DIR = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    try { const value = await fn(); if (value) return value; } catch {}
  }
  return null;
};
const within = (promise, ms, label) => Promise.race([promise, sleep(ms).then(() => { throw new Error(`${label} timed out`); })]);
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
function treeOf(rootPid, all = processes()) {
  const tree = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of all) if (tree.has(p.ppid) && !tree.has(p.pid)) { tree.add(p.pid); grew = true; }
  }
  return tree;
}
function listeners(pids) {
  if (process.platform !== 'win32') {
    let out = '';
    try { out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { encoding: 'utf8' }); } catch {}
    const found = [];
    let pid = 0;
    for (const line of out.split('\n')) {
      if (line[0] === 'p') pid = Number(line.slice(1));
      else if (line[0] === 'n' && pids.has(pid)) found.push({ port: Number(line.split(':').pop()), pid });
    }
    return found;
  }
  return execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true }).split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((f) => f[0] === 'TCP' && f[3] === 'LISTENING' && pids.has(Number(f[4])))
    .map((f) => ({ port: Number(f[1].split(':').pop()), pid: Number(f[4]) }));
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function quit(pid) {
  if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid)], { stdio: 'ignore' });
  else process.kill(pid, 'SIGTERM');
}

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const listen = (s) => new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve(s)));
  const other = await listen(http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Other origin</title><p id="o">other</p>'); }));
  const server = await listen(http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/host') {
      res.end(`<title>Host</title><iframe id="same" src="/inner"></iframe><iframe id="cross" src="http://localhost:${other.address().port}/inner"></iframe>
<script>window.worker = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' })));</script>`);
    } else res.end(`<title>Fixture ${req.url}</title><p id="in">inner</p><button onclick="document.title='clicked'">Go</button>`);
  }));
  const site = `http://127.0.0.1:${server.address().port}`;
  const statusOf = (url) => fetch(url).then((r) => r.status, () => 0);
  const env = (profile) => ({ ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', LUMEN_AUTOMATION_INPROC: '1' });
  const makeProfile = () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cdp-inproc-'));
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ automationEnabled: true, automationPort: PORT }));
    return profile;
  };

  // ---- 1. A plain process: nothing but the proxy listens
  {
    const profile = makeProfile();
    let log = '';
    const child = spawn(require('electron'), [APP_DIR], { env: env(profile), stdio: ['ignore', 'ignore', 'pipe'] });
    // A hang is a failure, not a stuck run (and never leaves Lumen behind).
    setTimeout(() => { console.error('FAIL  timed out'); try { execFileSync(process.platform === 'win32' ? 'taskkill' : 'kill', process.platform === 'win32' ? ['/PID', String(child.pid), '/T', '/F'] : ['-9', String(child.pid)], { stdio: 'ignore' }); } catch {} process.exit(1); }, 420000).unref();
    child.stderr.on('data', (d) => { log += d; });
    const tokenFile = path.join(profile, 'automation-token');
    const token = await until(() => fs.existsSync(tokenFile) && fs.readFileSync(tokenFile, 'utf8').trim());
    const root = `http://127.0.0.1:${PORT}/${token}`;
    const list = () => fetch(`${root}/json/list`).then((r) => r.json());
    const up = await until(async () => (await list()).length >= 1);
    check('inproc: the proxy answers with the token', up, log.slice(-500));
    const all = processes();
    const browser = all.find((p) => p.pid === child.pid);
    const tree = treeOf(child.pid, all);
    check('inproc: Lumen runs as the process that was started (no launcher, no hand-over)', alive(child.pid) && !all.some((p) => /launcher\.js/.test(p.cmd) && tree.has(p.ppid)), JSON.stringify(browser));
    check('inproc: no debugging switch on any Lumen process', ![...tree].some((pid) => /remote-debugging/.test(all.find((p) => p.pid === pid)?.cmd || '')), 'switch found');
    check('inproc: no DevToolsActivePort file', !fs.existsSync(path.join(profile, 'DevToolsActivePort')), 'written');
    const open = listeners(tree);
    check('inproc: the only listening port in Lumen\'s processes is the proxy', open.length >= 1 && open.every((l) => l.port === PORT), JSON.stringify(open));
    check('inproc: no token is refused', (await statusOf(`http://127.0.0.1:${PORT}/json/version`)) === 401, 'accepted');

    const version = await fetch(`${root}/json/version`).then((r) => r.json());
    check('inproc: /json/version answered in-process', /^Lumen\/\d/.test(version.Browser) && version.webSocketDebuggerUrl === `ws://127.0.0.1:${PORT}/${token}/devtools/browser` && version['Protocol-Version'] === '1.3', JSON.stringify(version));

    const browserCdp = await chromium.connectOverCDP(root);
    const context = browserCdp.contexts()[0];
    check('inproc: connectOverCDP reports the version', /^\d+\./.test(browserCdp.version()), browserCdp.version());
    const first = context.pages();
    check('inproc: connectOverCDP lists the user tabs only', first.length >= 1 && first.length === (await list()).length && !first.some((p) => /renderer[\\/]index\.html/.test(p.url())), first.map((p) => p.url()).join(', '));
    const pageA = await context.newPage();
    await pageA.goto(`${site}/a`);
    check('inproc: newPage opens a tab and navigates', (await pageA.title()) === 'Fixture /a' && (await list()).length === first.length + 1, await pageA.title());
    check('inproc: evaluate', (await pageA.evaluate(() => 6 * 7)) === 42, 'wrong');
    await pageA.click('button');
    check('inproc: click', (await pageA.title()) === 'clicked', await pageA.title());
    await pageA.fill('body', '').catch(() => {});
    const shot = await pageA.screenshot();
    check('inproc: screenshot is a PNG', shot.length > 500 && shot.subarray(1, 4).toString() === 'PNG', shot.length);
    check('inproc: locator + text', (await pageA.locator('#in').textContent()) === 'inner', 'no text');

    const pageB = await context.newPage();
    await pageB.goto(`${site}/b`);
    const [tA, tB] = await Promise.all([pageA.evaluate(() => document.title), pageB.evaluate(() => document.title)]);
    check('inproc: multiple tabs, each its own session', tA === 'clicked' && tB === 'Fixture /b' && context.pages().length === first.length + 2, `${tA} / ${tB}`);
    await pageA.bringToFront();
    const activeUrl = await pageA.evaluate(() => location.pathname);
    check('inproc: bringToFront', activeUrl === '/a', activeUrl);

    const host = await context.newPage();
    await host.goto(`${site}/host`);
    await until(async () => host.frames().length >= 3 && host.frames().every((f) => f.url() !== ''), 10000);
    const frameTexts = await Promise.all(host.frames().filter((f) => f !== host.mainFrame()).map((f) => f.locator('p').first().textContent({ timeout: 10000 }).catch((e) => `err ${e.message}`)));
    check('inproc: iframes (same-origin and cross-origin) are reachable', frameTexts.length === 2 && frameTexts.sort().join() === 'inner,other', frameTexts.join());
    const workerSeen = await until(() => host.workers().length >= 1, 10000);
    check('inproc: a web worker is seen', workerSeen, host.workers().length);

    // The undo when the last client leaves: an init script and a viewport override don't outlive it.
    await pageB.addInitScript(() => { window.__marker = 'set'; });
    await pageB.setViewportSize({ width: 500, height: 400 });
    await pageB.goto(`${site}/b2`);
    check('inproc: init script runs for the client that added it', (await pageB.evaluate(() => window.__marker)) === 'set', 'not set');

    // A second client at the same time.
    const second = await chromium.connectOverCDP(root);
    const secondPages = second.contexts()[0].pages();
    const sameTab = secondPages.find((p) => p.url().endsWith('/b2'));
    check('inproc: a second client sees the same tabs and drives them', secondPages.length === (await list()).length && (await sameTab?.evaluate(() => document.title)) === 'Fixture /b2', secondPages.map((p) => p.url()).join());
    await second.close();
    check('inproc: the first client keeps working after the second leaves', (await pageA.evaluate(() => 1 + 1)) === 2, 'broken');

    // What can't be done answers with an error at once, never a hang.
    const grant = await within(context.grantPermissions(['geolocation']), 8000, 'grantPermissions').then(() => 'ok', (e) => e.message);
    check('inproc: an unsupported command is a clear error, not a hang', /not available in Lumen/.test(grant), grant);
    const newContext = await within(browserCdp.newContext(), 8000, 'newContext').then(() => 'ok', (e) => e.message);
    check('inproc: a new browser context is refused', /not available in Lumen|Protocol error/.test(newContext), newContext);
    // A page endpoint is one tab's session: what reaches past the tab is refused.
    const pageUrl = (await list()).find((t) => t.url.endsWith('/a'))?.webSocketDebuggerUrl;
    const raw = (method, params = {}) => new Promise((resolve) => {
      const ws = new WebSocket(pageUrl);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
      ws.onmessage = (e) => { const msg = JSON.parse(e.data); if (msg.id === 1) { ws.close(); resolve(msg.error?.message || 'ok'); } };
      ws.onerror = () => resolve('error');
      setTimeout(() => resolve('timeout'), 8000);
    });
    const closeTry = await raw('Page.close');
    check('inproc: Page.close inside a tab is refused (tabs close through Lumen)', /not available in Lumen/.test(closeTry) && (await list()).length === context.pages().length, closeTry);
    const targetTry = await raw('Target.createTarget', { url: 'about:blank' });
    check('inproc: Target commands from inside a tab are refused', /not available in Lumen/.test(targetTry), targetTry);
    check('inproc: an ordinary command on a page endpoint works', (await raw('Runtime.evaluate', { expression: '1' })) === 'ok', 'failed');

    await pageB.close();
    await pageA.close();
    await host.close();
    await sleep(500);
    check('inproc: page.close closes the Lumen tabs', (await list()).length === first.length, (await list()).length);
    await browserCdp.close();
    await sleep(500);
    check('inproc: disconnecting leaves Lumen running', alive(child.pid) && (await list()).length >= 1, 'gone');

    // The client left: its init script and viewport override are undone.
    const again = await chromium.connectOverCDP(root);
    const tab = again.contexts()[0].pages()[0];
    await tab.goto(`${site}/c`);
    const marker = await tab.evaluate(() => window.__marker);
    check('inproc: what a client added to a tab is undone when it leaves', marker === undefined, marker);
    await again.close();

    quit(child.pid);
    check('inproc: quitting Lumen ends it', await until(() => !alive(child.pid), 20000), 'still running');
    if (alive(child.pid)) { try { process.kill(child.pid, 'SIGKILL'); } catch {} }
  }

  // ---- 2. Under Playwright's _electron: open-url and open-file reach the process that owns them
  {
    const profile = makeProfile();
    const app = await electron.launch({ args: [APP_DIR], env: env(profile) });
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const { token } = await ui.evaluate(() => window.assistant.automationInfo());
    const info = await ui.evaluate(() => window.assistant.automationInfo());
    check('inproc: Lumen says no internal debugging port is open', info.internalPort === false && info.running?.listening, JSON.stringify(info));
    const root = `http://127.0.0.1:${PORT}/${token}`;
    const list = () => fetch(`${root}/json/list`).then((r) => r.json());
    const before = (await list()).length;
    // What LaunchServices sends a running macOS app when a link is opened with it.
    await app.evaluate(({ app: electronApp }, url) => electronApp.emit('open-url', { preventDefault() {} }, url), `${site}/from-outside`);
    const opened = await until(async () => (await list()).some((t) => t.url.endsWith('/from-outside')), 10000);
    check('open-url opens a tab (the process that gets the event is the one running Lumen)', opened && (await list()).length === before + 1, JSON.stringify((await list()).map((t) => t.url)));
    const browserCdp = await chromium.connectOverCDP(root);
    const page = browserCdp.contexts()[0].pages().find((p) => p.url().endsWith('/from-outside'));
    check('open-url tab is drivable through the proxy', (await page?.title()) === 'Fixture /from-outside', await page?.title());
    await browserCdp.close();
    await app.close();
  }

  server.close();
  other.close();
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
