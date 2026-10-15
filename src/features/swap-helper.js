// ---------- the Windows update swap, run by a copy of the signed Lumen.exe in Node mode ----------
// features/zip-update.js copies Lumen.exe (byte-identical, so its signature and Windows Smart App
// Control's trust are kept) plus the few data files Electron needs to start into a temp folder, and
// starts that copy with ELECTRON_RUN_AS_NODE=1 running this file. No .cmd/.ps1/.vbs helper is ever
// written, and no script host is involved. This file is self-contained (it is copied next to that exe
// and must not require anything from the install folder it is about to replace).
//
// It waits for Lumen (pid) to exit, renames the install folder to `old`, renames the staged folder
// into its place, starts the new exe and deletes `old`. If the first rename keeps failing (something
// has files open) the old version stays, is started again, and `errFile` explains for Settings. If the
// second rename fails the old folder is put back. Whole folders only: no file from the release is
// modified, renamed or patched.
//
// `relaunch: false` is the quit-apply case (the user quit Lumen, so nothing is started afterwards, not
// even the old version after a failure). Then a missing staged folder (already swapped, or cleaned up)
// is a quiet no-op instead of an error.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MIN_EXE_BYTES = 10 * 1024 * 1024;
// Only a short cause: Settings and the pill put it in their own sentence ("Couldn’t install Lumen X: <cause>. …").
const MESSAGE = 'files were in use';

// null when `file` looks like a real Windows executable, else why not.
function checkExe(file, minBytes = MIN_EXE_BYTES) {
  try {
    const size = fs.statSync(file).size;
    if (size < minBytes) return `${path.basename(file)} is too small (${size} bytes)`;
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(2);
      fs.readSync(fd, head, 0, 2, 0);
      if (head.toString('latin1') !== 'MZ') return `${path.basename(file)} isn't a Windows executable`;
    } finally {
      fs.closeSync(fd);
    }
    return null;
  } catch (err) {
    return `${path.basename(file)} is missing (${err.code || err.message})`;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// Every wait in this file is a short poll against a deadline, never one long sleep: the user is looking at
// a closed window the whole time, so a poll that is late by its own length is time they can see.
const POLL_MS = 50;
const RETRY_MS = 100;
const LOCK_WAIT_MS = 10e3; // how long a rename may keep failing (something still has files open) before the old version stays

// fn() until it stops throwing, retrying every delayMs for at most totalMs.
async function retry(fn, totalMs, delayMs) {
  const end = Date.now() + totalMs;
  for (;;) {
    try { return fn(); } catch (err) {
      if (Date.now() + delayMs > end) throw err;
      await sleep(delayMs);
    }
  }
}

const rmQuick = (p) => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} };

// A leftover `old` folder (from an update that could not finish deleting it) is renamed out of the way, which takes
// no time, instead of deleted before the swap, which takes seconds for a whole install. Returns the name it was
// moved to (deleted after Lumen has started) or ''.
function moveAside(old) {
  if (!fs.existsSync(old)) return '';
  const aside = `${old}.stale-${process.pid}`;
  try { fs.renameSync(old, aside); return aside; } catch { rmQuick(old); return ''; }
}

// The swap itself. `o`: { pid, dir, root, old, staging, exe, exeArgs, errFile, relaunch (default true), waitMs, lockMs, retryMs, minBytes }.
// Returns 'swapped', 'kept' or (relaunch false only) 'noop'. `start` launches an exe (injectable for tests).
// Order matters for how long the user waits: nothing slow runs between Lumen exiting and the new Lumen starting
// (the two renames are instant); deleting the old install (thousands of files, scanned by antivirus) comes after.
async function swap(o, start = launch) {
  const waitMs = o.waitMs ?? 60e3;
  const lockMs = o.lockMs ?? LOCK_WAIT_MS;
  const retryMs = o.retryMs ?? RETRY_MS;
  const relaunch = o.relaunch !== false;
  const fail = (why) => {
    try { fs.writeFileSync(o.errFile, `${why || MESSAGE}\n`); } catch {}
    if (relaunch) start(o.exe, o.exeArgs);
    return 'kept';
  };
  for (const end = Date.now() + waitMs; alive(o.pid); await sleep(POLL_MS)) {
    if (Date.now() >= end) return fail('Lumen didn’t quit in time');
  }
  if (!relaunch && !fs.existsSync(o.root)) return 'noop';
  const bad = checkExe(path.join(o.root, path.basename(o.exe)), o.minBytes);
  if (bad) return fail(`the update looked incomplete (${bad})`);
  const aside = moveAside(o.old);
  try {
    await retry(() => fs.renameSync(o.dir, o.old), lockMs, retryMs);
  } catch {
    if (aside) rmQuick(aside);
    return fail();
  }
  try {
    await retry(() => fs.renameSync(o.root, o.dir), Math.min(lockMs, 2e3), retryMs);
  } catch {
    try { fs.renameSync(o.old, o.dir); } catch {}
    if (aside) rmQuick(aside);
    return fail();
  }
  rmQuick(o.staging); // (what is left of it is small: the folder was renamed out)
  if (relaunch) start(o.exe, o.exeArgs);
  // The new Lumen is starting; the old install goes now, in this helper (detached, nobody waits for it).
  rmQuick(o.old);
  if (aside) rmQuick(aside);
  return 'swapped';
}

// Start an exe detached, as a normal Lumen (Node mode is only for this helper). Not from this
// helper's temp folder: Windows locks a process's working directory, so a Lumen started there would
// keep the next update from clearing it.
function launch(exe, args = []) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(exe, args, { detached: true, stdio: 'ignore', env, cwd: require('os').homedir() }).unref();
}

if (require.main === module) {
  let opts;
  try { opts = JSON.parse(process.argv[2]); } catch { process.exit(2); }
  swap(opts).then(() => process.exit(0), () => process.exit(1));
}

module.exports = { swap, checkExe, MIN_EXE_BYTES, MESSAGE, POLL_MS, RETRY_MS, LOCK_WAIT_MS };
