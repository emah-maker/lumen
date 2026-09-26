// Hard-kill the app, relaunch on the same profile: it must open (orphaned child processes from
// the killed instance used to hold the profile lock). Also: a risky download isn't saved while
// its warning is unanswered.
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-crash-'));
  const launch = () => electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile }, timeout: 30000 });

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/tool.exe')) {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="cb-risky-test.exe"');
      return res.end(Buffer.alloc(50000, 1));
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Crash fixture</title><a id="dl" href="/tool.exe">get</a>');
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  let app = await launch();
  let ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await app.evaluate((_e, u) => global.__agent.execute('navigate', { url: u }), base + '/');

  // Risky download: warning shown, nothing written while unanswered.
  const dlDir = await app.evaluate(({ app: a }) => a.getPath('downloads'));
  const before = new Set(fs.readdirSync(dlDir));
  await app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript("document.getElementById('dl').click()"));
  await ui.waitForTimeout(2500);
  const added = fs.readdirSync(dlDir).filter((f) => !before.has(f) && f.startsWith('cb-risky-test'));
  check('risky .exe is not saved while the warning is unanswered', added.length === 0, added.join(','));
  for (const f of added) fs.unlinkSync(path.join(dlDir, f));

  // Hard kill the main process (children are left behind, as in a crash).
  await ui.waitForTimeout(3500); // let the session save
  // The launched process can be a launcher whose child is the real browser process; kill the
  // browser's main process only, leaving its GPU/network/renderer children orphaned, as in a crash.
  const launcher = app.process().pid;
  const mainPid = await app.evaluate(() => process.pid);
  const { execFileSync } = require('child_process');
  execFileSync('taskkill', ['/F', '/PID', String(mainPid)]);
  if (launcher !== mainPid) { try { process.kill(launcher, 'SIGKILL'); } catch {} }
  await new Promise((r) => setTimeout(r, 1500));

  let reopened = false;
  const started = Date.now();
  try {
    app = await launch();
    ui = await app.firstWindow();
    await ui.waitForSelector('.tab', { timeout: 20000 });
    reopened = true;
  } catch (err) {
    check('relaunch after a hard kill', false, err.message);
  }
  if (reopened) {
    check('relaunch after a hard kill opens the browser', true);
    console.log(`      reopened in ${Date.now() - started} ms`);
    await ui.waitForTimeout(800);
    // A second copy on the same profile hands off to this one and exits quickly.
    const electronPath = require('electron');
    const t0 = Date.now();
    const second = require('child_process').spawn(electronPath, [path.join(__dirname, '..')], { env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile } });
    const code = await new Promise((resolve) => second.on('exit', resolve));
    const handoff = Date.now() - t0;
    console.log(`      second copy exited in ${handoff} ms`);
    check('a second copy hands off quickly', handoff < 1200, `${handoff} ms, exit ${code}`);
    const tabs = JSON.parse(await app.evaluate(async () => global.__agent.execute('list_tabs', {})));
    check('tabs restored after the crash', tabs.some((t) => t.url.startsWith(base)), JSON.stringify(tabs.map((t) => t.url)));
    await app.close();
  }
  server.close();
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
