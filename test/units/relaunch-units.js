// Quitting and opening Lumen again at once (features/instance.js takeOverLock / listenForSecondInstances, features/quit-guard.js), plain Node.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const I = require('../../src/features/instance');
const { createQuitGuard } = require('../../src/features/quit-guard');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8').replace(/\r\n/g, '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A clock the fake wait() advances, so the loop's time budget runs without real waiting.
const world = ({ lockFreeAt = Infinity, answers = ['none'], budgetMs } = {}) => {
  let t = 0; let pings = 0; let reclaims = 0; let tries = 0;
  const out = I.takeOverLock({
    tryLock: () => { tries++; return t >= lockFreeAt; },
    ping: () => answers[Math.min(pings++, answers.length - 1)],
    reclaim: () => { reclaims++; },
    wait: (ms) => { t += ms; },
    now: () => t,
    budgetMs,
  });
  return { out, t, pings, reclaims, tries };
};

// ---- the lock hand-over
{
  check('lock: free at once means acquired, no ping', (() => { const w = world({ lockFreeAt: 0 }); return w.out === 'acquired' && w.pings === 0; })());
  check('lock: a live instance that answers is handed off to (it focused itself)', world({ answers: ['live'] }).out === 'handed-off');
  const q = world({ lockFreeAt: 2500, answers: ['quitting'] });
  check('lock: an instance that is quitting is waited for, then taken over (never a silent exit)', q.out === 'acquired' && q.t >= 2500 && q.t < 3000, JSON.stringify(q));
  check('lock: waiting on a quitting instance does not run the orphan cleanup', q.reclaims === 0);
  const n = world({ lockFreeAt: 5000, answers: ['none'] });
  check('lock: nobody answers but the lock is held (leftover children): they are reclaimed, and it is taken over', n.out === 'acquired' && n.reclaims >= 1 && n.reclaims <= 3, JSON.stringify(n));
  check('lock: the instance that quits turns out to be live again later: handed off', world({ answers: ['quitting', 'quitting', 'live'] }).out === 'handed-off');
  const stuck = world({ answers: ['none'], budgetMs: 4000 });
  check('lock: still held at the deadline reports a timeout (the caller says so), after the full budget', stuck.out === 'timeout' && stuck.t >= 4000, JSON.stringify(stuck));
  const busy = world({ lockFreeAt: 3000, answers: ['busy'] });
  check('lock: an instance that takes the ping but is silent (stuck while it quits) is retried and taken over once it exits', busy.out === 'acquired' && busy.pings >= 2, JSON.stringify(busy));
  check('lock: one that stays silent and keeps the lock is treated as running (it got the ping), not as a failure', world({ answers: ['busy'], budgetMs: 3000 }).out === 'handed-off');
  check('lock: the default patience covers a slow shutdown under load (15 s)', world({ lockFreeAt: 14000, answers: ['quitting'] }).out === 'acquired');
}

// ---- the ping's answer
check('ping: the exit codes of the probe map to live / busy / quitting / none', I.pingResult(0) === 'live' && I.pingResult(3) === 'busy' && I.pingResult(2) === 'quitting' && I.pingResult(1) === 'none' && I.pingResult(null) === 'none');

// ---- the quit deadline
{
  const calls = [];
  const timers = [];
  const guard = createQuitGuard({ graceMs: 4000, backstopMs: 1500, exit: (c) => calls.push(['exit', c]), kill: () => calls.push(['kill']), backstop: (ms) => calls.push(['backstop', ms]), setTimer: (fn, ms) => { timers.push([fn, ms]); return { unref() {} }; }, log: () => {} });
  check('quit: nothing is scheduled until quitting starts', calls.length === 0 && timers.length === 0 && !guard.armed());
  check('quit: arming starts a watchdog and one timer at the grace period', guard.arm() === true && timers.length === 1 && timers[0][1] === 4000 && JSON.stringify(calls) === '[["backstop",5500]]');
  check('quit: arming twice does nothing more', guard.arm() === false && timers.length === 1);
  timers[0][0]();
  check('quit: at the deadline the process exits, then (if it is still there) is ended', JSON.stringify(calls.slice(1)) === '[["exit",0],["kill"]]', JSON.stringify(calls));
  const broken = createQuitGuard({ exit: () => calls.push(['exit2']), kill: () => { throw new Error('taskkill missing'); }, backstop: () => {}, setTimer: (fn) => { fn(); return null; }, log: () => {} });
  broken.arm();
  check('quit: a failing kill still exits', calls.some((c) => c[0] === 'exit2'));
}

// ---- the watchdog process really ends a process that will not quit (a victim this test started), and leaves when it is gone
const { startBackstop, backstopScript } = require('../../src/features/quit-guard');
check('watchdog: its script is valid JavaScript', (() => { try { new (require('vm').Script)(backstopScript({ pid: 1, ms: 1 })); return true; } catch { return false; } })());

// ---- the kill set: Lumen's own PID, never its children (the update installer started at will-quit is one)
{
  const { killSelf } = require('../../src/features/quit-guard');
  const killed = [];
  const INSTALLER = 424242;
  killSelf({ pid: 1111, kill: (pid, sig) => killed.push([pid, sig]) });
  check('kill set: only Lumen\'s own PID is signalled, and the installer\'s never is', JSON.stringify(killed) === '[[1111,"SIGKILL"]]' && !killed.some(([pid]) => pid === INSTALLER));
  const script = backstopScript({ pid: 1111, ms: 100 });
  check('kill set: the watchdog has no tree kill (no taskkill, no /T) and signals one PID', !/taskkill|\/T|spawn/i.test(script) && (script.match(/process\.kill\(pid, "SIGKILL"\)/g) || []).length === 1);
  check('kill set: the guard module has no tree kill either', !/taskkill/.test(read('src/features/quit-guard.js').replace(/^\/\/.*$/gm, '')));
}

// ---- a link from another app opens once (the second launch asks for the lock more than once)
// Electron hands the running Lumen a failed requestSingleInstanceLock()'s arguments on every call: a sign-in or "verify"
// page another program opened in Lumen came up in two identical tabs.
{
  const opened = [];
  const running = I.launchFilter();
  const onSecondInstance = (argv, launch) => { if (running.firstTime(launch)) opened.push(...argv.filter((a) => /^https:/.test(a))); };
  let calls = 0;
  const tags = [];
  // The second launch, while Lumen runs: the lock is held, and every failed ask reaches the running Lumen, as Electron does
  // (checked on Electron 44: two asks, two 'second-instance' events). The running Lumen then answers the pipe's ping.
  const app = { requestSingleInstanceLock: (tag) => { tags.push(tag); calls++; onSecondInstance(['lumen.exe', 'https://accounts.example.com/verify?code=1'], tag); return false; } };
  const prevArgv = process.argv;
  process.argv = [process.argv[0], 'lumen.exe'];
  let got;
  try { got = I.acquireInstanceLock(app, { launchId: 'launch-1', ping: () => 'live' }); } finally { process.argv = prevArgv; }
  check('launch: the lock is asked for more than once (what made the second tab)', calls >= 2, String(calls));
  check('launch: every ask of one launch carries the same id', tags.every((t) => t && t.lumenLaunch === 'launch-1'), JSON.stringify(tags));
  check('launch: a link handed over twice by one launch opens in one tab', opened.length === 1, JSON.stringify(opened));
  check('launch: this copy hands off and leaves', got === false);
  // Two launches (the same link clicked twice) are two tabs; asks without an id (an older Lumen, a test) always act.
  const f = I.launchFilter();
  check('launch: another launch with the same link opens again', f.firstTime({ lumenLaunch: 'a' }) && f.firstTime({ lumenLaunch: 'b' }) && !f.firstTime({ lumenLaunch: 'a' }));
  check('launch: an ask without an id is never dropped', f.firstTime(undefined) && f.firstTime(undefined) && f.firstTime({}) && f.firstTime(null));
  const small = I.launchFilter({ max: 2 });
  small.firstTime({ lumenLaunch: 'x' }); small.firstTime({ lumenLaunch: 'y' }); small.firstTime({ lumenLaunch: 'z' });
  check('launch: only the most recent ids are kept', small.firstTime({ lumenLaunch: 'x' }) && !small.firstTime({ lumenLaunch: 'z' }));
}

// ---- wiring in main.js
{
  const main = read('src/main.js');
  const inst = read('src/features/instance.js');
  check('wiring: the deadline is armed by the last before-quit handler, after the ones that write', /createQuitGuard\(\{ exit: \(code\) => app\.exit\(code\) \}\)/.test(main) && main.lastIndexOf("app.on('before-quit'") === main.indexOf("app.on('before-quit', () => quitGuard.arm());") && main.indexOf("app.on('before-quit', () => quitGuard.arm());") > main.indexOf('usage.flush();'));
  check('wiring: the lists that save a moment after a change (downloads, usage) are flushed at quit, before the deadline', /downloads\.flush\(\);[^\n]*\n\s*usage\.flush\(\);\n\s*quitting = true;/.test(main));
  check('wiring: the second-instance pipe answers "bye" while quitting', /listenForSecondInstances\(app, \(\) => \{[^\n]*\}, \{ isQuitting: \(\) => quitting \}\)/.test(main));
  check('wiring: focusWindow shows a hidden window and makes a new one when none is left', /const focusWindow = \(\) => \{[\s\S]{0,400}createWindow\(\)[\s\S]{0,300}isVisible\(\)\) win\.show\(\)/.test(main));
  check('wiring: second-instance acts once per launch, before it opens anything', /app\.on\('second-instance', \(_e, argv, _cwd, launch\) => \{\n\s*if \(!secondLaunches\.firstTime\(launch\)\) return;/.test(main) && /const secondLaunches = instance\.launchFilter\(\);/.test(main));
  check("wiring: every lock ask carries this launch's id", /requestSingleInstanceLock\(tag\)\) return true;/.test(inst) && /tryLock: \(\) => app\.requestSingleInstanceLock\(tag\)/.test(inst) && !/requestSingleInstanceLock\(\)/.test(inst));
  check('wiring: the lock waits instead of leaving silently; a timeout is announced', /takeOverLock\(\{/.test(inst) && /outcome === 'timeout'\) tellStuck\(\)/.test(inst));
}

async function watchdog() {
  // The installer (a child of Lumen) must survive the watchdog ending Lumen: a "Lumen" that has an "installer" child, both real processes here.
  {
    const { spawn } = require('child_process');
    const lumen = spawn(process.execPath, ['-e', 'const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true }); console.log(c.pid); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const installerPid = await new Promise((resolve) => { lumen.stdout.once('data', (d) => resolve(Number(String(d).trim()))); setTimeout(() => resolve(0), 8000); });
    let lumenGone = false;
    lumen.on('exit', () => { lumenGone = true; });
    startBackstop(500, { pid: lumen.pid });
    for (let i = 0; i < 80 && !lumenGone; i++) await sleep(100);
    await sleep(500);
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    check('watchdog: ending Lumen leaves the installer process it started running', installerPid > 0 && lumenGone && alive(installerPid), `installer ${installerPid} lumenGone=${lumenGone}`);
    if (installerPid > 0) { try { process.kill(installerPid); } catch { /* gone */ } }
    if (!lumenGone) lumen.kill();
  }
  const { spawn } = require('child_process');
  const victim = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  let victimGone = false;
  victim.on('exit', () => { victimGone = true; });
  const t0 = Date.now();
  const dog = startBackstop(600, { pid: victim.pid });
  for (let i = 0; i < 80 && !victimGone; i++) await sleep(100);
  check('watchdog: a process still running at the deadline is ended (and not before it)', victimGone && Date.now() - t0 >= 500 && Date.now() - t0 < 8000, `gone=${victimGone} after ${Date.now() - t0} ms`);
  if (!victimGone) victim.kill();
  const quick = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 100)'], { stdio: 'ignore', windowsHide: true });
  let dogGone = false;
  const dog2 = startBackstop(60000, { pid: quick.pid });
  dog2.on('exit', () => { dogGone = true; });
  for (let i = 0; i < 40 && !dogGone; i++) await sleep(100);
  check('watchdog: it leaves by itself once the process it watches is gone', dogGone);
  if (!dogGone) dog2.kill();
  void dog;
}

// ---- the pipe (Windows named pipe; elsewhere the listener is not used)
(async () => {
  await watchdog();
  if (process.platform === 'win32') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-relaunch-units-'));
    const app = { getPath: () => dir };
    const pipe = `\\\\.\\pipe\\lumen-${require('crypto').createHash('sha1').update(dir).digest('hex').slice(0, 12)}`;
    const ask = () => new Promise((resolve) => {
      const s = net.connect(pipe);
      let got = '';
      s.on('connect', () => s.write('focus'));
      s.on('data', (d) => { got += d; });
      s.on('close', () => resolve(got));
      s.on('error', () => resolve('error'));
    });
    let focused = 0; let quitting = false;
    const server = I.listenForSecondInstances(app, () => { focused++; }, { isQuitting: () => quitting });
    await sleep(100);
    check('pipe: a ping focuses the window and is answered "ok"', (await ask()) === 'ok' && focused === 1);
    quitting = true;
    check('pipe: while quitting the answer is "bye" and nothing is focused', (await ask()) === 'bye' && focused === 1);
    server.close();
    await sleep(100);

    // The pipe still held by the instance that is exiting: the new one keeps trying until it is free.
    const holder = net.createServer().listen(pipe);
    await sleep(100);
    let focused2 = 0;
    const server2 = I.listenForSecondInstances(app, () => { focused2++; }, { retryMs: 5000 });
    await sleep(500);
    holder.close();
    await sleep(800);
    check('pipe: a pipe still held by the dying instance is listened on as soon as it lets go', (await ask()) === 'ok' && focused2 === 1);
    server2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})();
