// With automation tools on, Lumen talks to Chromium's DevTools over a private pipe, not a port.
//
// Chromium serves DevTools on a pipe (--remote-debugging-pipe) only over file descriptors 3 and 4
// that its parent process handed it at launch; in a Lumen started the usual way those hold
// Electron's own .asar archives by the time main.js runs. So the first Lumen process (main.js,
// before anything else) starts this file in Node mode and leaves, and this starts the real browser
// with three pipes: 3 and 4 for Chromium, 5 for Lumen's main process (automation.js), and relays
// between them without reading anything. Nothing listens anywhere: only this process holds the other
// ends. Lumen exits → this exits with its code; this is killed → the pipes close and Chromium quits
// Lumen (an ordinary quit: will-quit runs).
//
// macOS no longer uses this for automation (features/ai-agents.js inProcessAutomation): a link opened
// while Lumen runs goes to the process LaunchServices started, which here is the first process that
// has already left, so it would be lost. cdp-inproc.js needs no launcher. The handling below stays
// for a macOS copy that is started through here anyway.
// On macOS a link that launches Lumen arrives as an 'open-url' event for the first process, after
// it starts and before 'ready'. So there the first process waits for 'ready', collecting those links,
// and passes them on as arguments (handOver).
// Not in test runs, unless LUMEN_TEST_LAUNCHER is set: Playwright's _electron.launch attaches to the
// process it starts.
const { spawn } = require('child_process');

const CHILD_ENV = 'LUMEN_AUTOMATION_PIPE'; // set for the browser this starts
const LUMEN_FD = 5; // Lumen's end of the relay (3 and 4 are Chromium's)

const available = () => !require('./test-mode').isTest() || process.env.LUMEN_TEST_LAUNCHER === '1';

// Is this the browser the launcher started? Asked once: the variable isn't passed on to programs
// Lumen runs (or to a Lumen restarted with app.relaunch, which goes through the launcher again).
let launched = null;
function isLaunched() {
  if (launched === null) {
    launched = process.env[CHILD_ENV] === '1';
    delete process.env[CHILD_ENV];
  }
  return launched;
}

// On Windows, Node puts every child it doesn't detach in a job that ends it (and whatever it
// opens, like a downloaded file's app) when the parent exits. Detached, a Lumen started from a
// terminal no longer prints there.
const DETACHED = process.platform === 'win32';

// This file, then the first process's arguments (the app folder included, in development), then
// links it was sent as events (macOS).
const launcherArgs = (argv, links = []) => [__filename, ...argv.slice(1), ...links];

// From the first Lumen process: run this file with the same arguments. The caller exits right after.
function relaunch(links = []) {
  spawn(process.execPath, launcherArgs(process.argv, links), {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    detached: DETACHED,
  });
}

// From the first Lumen process, at startup: hand over to the launcher if this copy may run
// (acquireLock), and quit. On macOS only once 'ready': the links that launched Lumen come before it.
function handOver(app, acquireLock, { platform = process.platform, start = relaunch } = {}) {
  const go = (links) => {
    if (acquireLock()) {
      app.releaseSingleInstanceLock();
      start(links);
    }
    app.exit(0);
  };
  if (platform !== 'darwin') { go([]); return; }
  const links = [];
  app.on('open-url', (event, url) => { event.preventDefault(); links.push(url); });
  app.whenReady().then(() => go(links));
}

// ---------------------------------------------------------------- the launcher itself (Node mode)

function run() {
  const env = { ...process.env, [CHILD_ENV]: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  // Windows: Lumen's end is overlapped, so its reads don't block its writes on the same handle.
  const child = spawn(process.execPath, process.argv.slice(2), { env, stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe', 'overlapped'], detached: DETACHED });
  const [,,, toChromium, fromChromium, lumen] = child.stdio;
  for (const stream of [toChromium, fromChromium, lumen]) stream.on('error', () => {});
  fromChromium.pipe(lumen);
  lumen.pipe(toChromium);
  child.on('error', () => process.exit(1));
  child.on('exit', (code) => process.exit(code ?? 1));
  // Ctrl-C reaches Lumen itself too; this waits for it to exit. A plain kill is passed on.
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

if (require.main === module) run();

module.exports = { available, isLaunched, relaunch, handOver, launcherArgs, LUMEN_FD };
