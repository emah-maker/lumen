// Close Lumen and start it again at once with the same profile (hidden). A user who quits and reopens right away must get a window,
// never a second copy that quits silently because the first was still shutting down.
//   LUMEN_RELAUNCH_CYCLES (default 3)   how many close/relaunch rounds
//   LUMEN_RELAUNCH_LOAD   (default 0)   busy node loops to run during the rounds (they are killed at the end)
//   LUMEN_RELAUNCH_STALL_MS (default 2500) the closing Lumen blocks its main thread this long while quitting (a slow shutdown)
//   LUMEN_RELAUNCH_MODE   'overlap' (default: ask the app to quit and launch the next one without waiting for its exit)
//                         or 'after' (wait for the exit first, then launch)
// Prints one RESULT line with the close->exit times and how many relaunches got no window within 30 s.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CYCLES = Number(process.env.LUMEN_RELAUNCH_CYCLES) || 3;
const LOAD = Number(process.env.LUMEN_RELAUNCH_LOAD) || 0;
const MODE = process.env.LUMEN_RELAUNCH_MODE === 'after' ? 'after' : 'overlap';
const STALL = process.env.LUMEN_RELAUNCH_STALL_MS === undefined ? 2500 : Number(process.env.LUMEN_RELAUNCH_STALL_MS);
const WINDOW_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-relaunch-'));
  const busy = [];
  const started = new Set(); // every Electron main process this suite started (killed at the end if it is still alive)
  const procs = [];
  for (let i = 0; i < LOAD; i++) busy.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true }));

  const launch = async () => {
    const app = await electron.launch({
      args: [path.join(__dirname, '..', '..')],
      env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' },
      timeout: WINDOW_MS,
    });
    const proc = app.process();
    started.add(proc.pid);
    procs.push(proc);
    const handle = { app, proc, exitedAt: null };
    handle.exited = new Promise((resolve) => { if (proc.exitCode !== null || proc.signalCode) { handle.exitedAt = Date.now(); resolve(); } else proc.once('exit', () => { handle.exitedAt = Date.now(); resolve(); }); });
    return handle;
  };
  const killTree = (pid) => { try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* gone */ } };

  const closeToExit = [];
  let noWindow = 0;
  let current = await launch();
  let ui = await current.app.firstWindow({ timeout: WINDOW_MS });
  await ui.waitForSelector('.tab', { timeout: WINDOW_MS });

  for (let i = 0; i < CYCLES; i++) {
    if (STALL > 0) await current.app.evaluate(({ app }, ms) => { app.on('before-quit', () => { const end = Date.now() + ms; while (Date.now() < end); }); }, STALL);
    const t0 = Date.now();
    // The user closes the window: the app quits itself (window-all-closed). Not Playwright's close(), which waits for the exit.
    current.app.evaluate(({ app }) => app.quit()).catch(() => {});
    if (MODE === 'after') await Promise.race([current.exited, sleep(60000)]);
    const old = current;
    let next = null;
    let gotWindow = false;
    let detail = '';
    try {
      next = await launch();
      ui = await next.app.firstWindow({ timeout: WINDOW_MS });
      await ui.waitForSelector('.tab', { timeout: WINDOW_MS });
      gotWindow = true;
    } catch (err) { detail = err.message; }
    await Promise.race([old.exited, sleep(60000)]);
    const exitedIn = old.exitedAt === null ? null : old.exitedAt - t0;
    closeToExit.push(exitedIn);
    if (!gotWindow) { noWindow++; console.log(`cycle ${i + 1}: no window in ${WINDOW_MS / 1000}s (${detail.split('\n')[0]})`); }
    else console.log(`cycle ${i + 1}: old process exited ${exitedIn === null ? 'NEVER' : `after ${exitedIn} ms`}, relaunch has a window`);
    if (exitedIn === null) killTree(old.proc.pid);
    if (!next) { // the launch itself failed: start over so later rounds still run
      try { next = await launch(); ui = await next.app.firstWindow({ timeout: WINDOW_MS }); } catch { break; }
    }
    current = next;
  }

  const sorted = closeToExit.filter((n) => n !== null).sort((a, b) => a - b);
  const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
  console.log(`RESULT ${JSON.stringify({ mode: MODE, load: LOAD, cycles: CYCLES, stallMs: STALL, noWindow, neverExited: closeToExit.filter((n) => n === null).length, exitMs: { min: sorted[0] ?? null, median: pct(0.5), p90: pct(0.9), max: sorted[sorted.length - 1] ?? null } })}`);

  check('every relaunch got a window within 30 s', noWindow === 0, `${noWindow} of ${CYCLES} had none`);
  // (Under load Playwright's own inspector connection adds ~30 s to every exit, 'Waiting for the debugger to disconnect': not Lumen's)
  const limit = LOAD ? 60000 : 15000;
  check(`every closed Lumen exited within ${limit / 1000} s`, closeToExit.every((n) => n !== null && n < limit), JSON.stringify(closeToExit));

  try { await current.app.close(); } catch { killTree(current.proc.pid); }
  for (const p of procs) { if (p !== current.proc && p.exitCode === null && !p.signalCode) killTree(p.pid); } // (only ones still running: a finished one's PID may be reused)
  for (const b of busy) { try { b.kill(); } catch { /* already gone */ } }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
