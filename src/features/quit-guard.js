// Quitting must finish. Once the app starts to quit, a deadline runs: at graceMs whatever is left (a stuck engine, a child process
// that will not close, a window that never answers) is ended and Lumen exits; a watchdog process backs that up (the main thread
// may be stuck in a blocking call, or the process may be hanging in its own teardown), so it is gone a moment later in any case.
// Without this a Lumen that did not exit kept the profile's lock, and opening Lumen again straight after quitting showed nothing.
const DEFAULTS = { graceMs: 4000, backstopMs: 1500 };

// Ends this process and everything it started (taskkill /T follows the parent links, so detached CLI engines and their
// MCP bridges go too).
function killOwnTree({ platform = process.platform, pid = process.pid, spawnSync = require('child_process').spawnSync, kill = process.kill.bind(process) } = {}) {
  if (platform === 'win32') {
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 3000 }); } catch { /* fall through to the plain kill */ }
  }
  try { kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

// The watchdog's script, as text (it runs under ELECTRON_RUN_AS_NODE): polls until Lumen is gone (then leaves) or the deadline.
function backstopScript({ pid, ms, platform }) {
  return [
    'const { spawnSync } = require("child_process");',
    `const pid = ${Number(pid)}, end = Date.now() + ${Number(ms)};`,
    'const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };',
    'const timer = setInterval(() => {',
    '  if (!alive()) process.exit(0);',
    '  if (Date.now() < end) return;',
    '  clearInterval(timer);',
    `  if (${JSON.stringify(platform)} === "win32") { try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 }); } catch {} }`,
    '  try { process.kill(pid, "SIGKILL"); } catch {}',
    '  process.exit(0);',
    '}, 250);',
  ].join('\n');
}

// A separate process that does nothing until the deadline and then ends this process tree. It has to be a process: under load
// Windows can spend 30 s tearing Lumen down after the 'quit' event, long after the event loop (and any timer or worker thread
// of ours) has stopped. It leaves as soon as Lumen is gone.
function startBackstop(ms, { pid = process.pid, platform = process.platform, spawn = require('child_process').spawn, execPath = process.execPath } = {}) {
  try {
    const child = spawn(execPath, ['-e', backstopScript({ pid, ms, platform })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return child;
  } catch { return null; }
}

// arm() starts the clock (once; later calls do nothing). The deps are injectable for the unit tests.
function createQuitGuard({ graceMs = DEFAULTS.graceMs, backstopMs = DEFAULTS.backstopMs, exit, kill = killOwnTree, backstop = startBackstop, setTimer = setTimeout, log = (m) => console.error(m) } = {}) {
  let armed = false;
  let timer = null;
  const fire = () => {
    log(`[lumen] still quitting after ${graceMs} ms: ending what is left and exiting`);
    try { kill(); } catch { /* the exit below still happens */ }
    try { exit(0); } catch { /* the backstop ends it */ }
  };
  return {
    arm() {
      if (armed) return false;
      armed = true;
      backstop(graceMs + backstopMs);
      timer = setTimer(fire, graceMs);
      timer?.unref?.();
      return true;
    },
    armed: () => armed,
    fire,
  };
}

module.exports = { createQuitGuard, killOwnTree, startBackstop, backstopScript, DEFAULTS };
