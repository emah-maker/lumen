// Quitting must finish. Once the app starts to quit (and every before-quit handler has written what it keeps), a deadline runs: at
// graceMs Lumen exits; a watchdog process backs that up (the main thread may be stuck in a blocking call, or the process may be
// hanging in its own teardown), so it is gone a moment later in any case. Without this a Lumen that did not exit kept the
// profile's lock, and opening Lumen again straight after quitting showed nothing.
//
// Only Lumen's own process is ever ended, never its tree: a quit can start the update installer (updates.applyOnQuit at will-quit,
// a child of Lumen) and killing that mid-install would leave a broken install. Chromium's own processes follow Lumen out, and the
// engines and MCP servers were already told to stop at will-quit.
const DEFAULTS = { graceMs: 4000, backstopMs: 1500 };

// Ends this process, and only this one.
function killSelf({ pid = process.pid, kill = process.kill.bind(process) } = {}) {
  try { kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

// The watchdog's script, as text (it runs under ELECTRON_RUN_AS_NODE): polls until Lumen is gone (then leaves) or the deadline,
// and then ends that one process.
function backstopScript({ pid, ms }) {
  return [
    `const pid = ${Number(pid)}, end = Date.now() + ${Number(ms)};`,
    'const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };',
    'const timer = setInterval(() => {',
    '  if (!alive()) process.exit(0);',
    '  if (Date.now() < end) return;',
    '  clearInterval(timer);',
    '  try { process.kill(pid, "SIGKILL"); } catch {}',
    '  process.exit(0);',
    '}, 250);',
  ].join('\n');
}

// A separate process that does nothing until the deadline and then ends Lumen. It has to be a process: under load Windows can
// spend 30 s tearing Lumen down after the 'quit' event, long after the event loop (and any timer or worker thread of ours) has
// stopped. It leaves as soon as Lumen is gone.
function startBackstop(ms, { pid = process.pid, spawn = require('child_process').spawn, execPath = process.execPath } = {}) {
  try {
    const child = spawn(execPath, ['-e', backstopScript({ pid, ms })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return child;
  } catch { return null; }
}

// arm() starts the clock (once; later calls do nothing). The deps are injectable for the unit tests.
function createQuitGuard({ graceMs = DEFAULTS.graceMs, backstopMs = DEFAULTS.backstopMs, exit, kill = killSelf, backstop = startBackstop, setTimer = setTimeout, log = (m) => console.error(m) } = {}) {
  let armed = false;
  let timer = null;
  const fire = () => {
    log(`[lumen] still quitting after ${graceMs} ms: exiting now`);
    try { exit(0); } catch { /* ended below */ }
    try { kill(); } catch { /* the backstop ends it */ }
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

module.exports = { createQuitGuard, killSelf, startBackstop, backstopScript, DEFAULTS };
