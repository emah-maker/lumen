// Every test suite requires this first (`require('./_tmp-cleanup')`): the folders it makes straight under the temp folder
// with fs.mkdtemp* (throwaway Lumen profiles, fake CLI homes, ...) are removed when the process exits, whether the suite passed,
// failed (process.exit) or threw. Without it a failing or interrupted run left them behind, and each profile's grok-home held
// another hard link to the user's real ~/.grok/auth.json until NTFS's 1023-link limit broke Lumen's sign-in linking.
// A killed suite (timeout) can't run this: scripts/test-tmp.js gives every suite its own TEMP folder and removes it afterwards.
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!global.__lumenTmpCleanup) {
  global.__lumenTmpCleanup = true;
  const made = new Set();
  const root = path.resolve(os.tmpdir());
  const track = (dir) => { const r = path.resolve(String(dir)); if (path.dirname(r) === root) made.add(r); return dir; };

  const sync = fs.mkdtempSync;
  fs.mkdtempSync = function mkdtempSync(...args) { return track(sync.apply(this, args)); };
  const cb = fs.mkdtemp;
  fs.mkdtemp = function mkdtemp(...args) {
    const done = args[args.length - 1];
    if (typeof done === 'function') args[args.length - 1] = (err, dir) => { if (!err) track(dir); done(err, dir); };
    return cb.apply(this, args);
  };
  const promise = fs.promises.mkdtemp;
  fs.promises.mkdtemp = async function mkdtemp(...args) { return track(await promise.apply(this, args)); };

  process.on('exit', () => {
    for (const dir of made) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* still in use: the runner's per-suite TEMP folder sweeps it */ }
    }
  });
  // Ctrl+C / a terminated run still goes through the exit handler above.
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));
}
