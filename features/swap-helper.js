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
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MIN_EXE_BYTES = 10 * 1024 * 1024;
const MESSAGE = 'Lumen couldn’t replace its files (is another program using the Lumen folder?). The old version was kept.';

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

async function retry(fn, tries, delayMs) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return fn(); } catch (err) { last = err; if (i < tries - 1) await sleep(delayMs); }
  }
  throw last;
}

// The swap itself. `o`: { pid, dir, root, old, staging, exe, exeArgs, errFile, waitMs, retryMs, minBytes }.
// Returns 'swapped' or 'kept'. `start` launches an exe (injectable for tests).
async function swap(o, start = launch) {
  const waitMs = o.waitMs ?? 60e3;
  const retryMs = o.retryMs ?? 1000;
  const fail = (why) => {
    try { fs.writeFileSync(o.errFile, `${why || MESSAGE}\n`); } catch {}
    start(o.exe, o.exeArgs);
    return 'kept';
  };
  for (let waited = 0; alive(o.pid); waited += 250) {
    if (waited >= waitMs) return fail();
    await sleep(250);
  }
  const bad = checkExe(path.join(o.root, path.basename(o.exe)), o.minBytes);
  if (bad) return fail(`The update wasn't applied: ${bad}. The old version was kept.`);
  try { fs.rmSync(o.old, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  try {
    await retry(() => fs.renameSync(o.dir, o.old), 10, retryMs);
  } catch {
    return fail();
  }
  try {
    fs.renameSync(o.root, o.dir);
  } catch {
    try { fs.renameSync(o.old, o.dir); } catch {}
    return fail();
  }
  try { fs.rmSync(o.old, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  try { fs.rmSync(o.staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  start(o.exe, o.exeArgs);
  return 'swapped';
}

// Start an exe detached, as a normal Lumen (Node mode is only for this helper).
function launch(exe, args = []) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(exe, args, { detached: true, stdio: 'ignore', env }).unref();
}

if (require.main === module) {
  let opts;
  try { opts = JSON.parse(process.argv[2]); } catch { process.exit(2); }
  swap(opts).then(() => process.exit(0), () => process.exit(1));
}

module.exports = { swap, checkExe, MIN_EXE_BYTES, MESSAGE };
