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
//
// Crash recovery: Windows can end this detached helper (logoff, shutdown) between the two renames, which leaves no
// install folder at all. So a small `<install>.swap.journal` (JSON: phase, paths, the entry moves made so far) is
// written before the first rename, updated at every step and deleted when the swap is done or undone. recover() reads
// it and finishes the swap if the staged update is complete, else puts the old install back. It runs at the next Lumen
// start (main.js), and by hand with `Lumen.exe swap-helper.js recover <journal>` in Node mode (docs/install.md).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MIN_EXE_BYTES = 10 * 1024 * 1024;
// Only a short cause: Settings and the pill put it in their own sentence ("Couldn’t install Lumen X: <cause>. …").
const MESSAGE = 'files were in use (close any other program that runs Lumen, such as an AI assistant’s Lumen connection, then try again)';

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

const JOURNAL_VERSION = 1;
const STALE_BUSY_MS = 5 * 60e3; // a journal this old is never a swap still running (the helper finishes in seconds)
const MESSAGE_INTERRUPTED = 'the update was interrupted, so the old version was put back';

// Where the journal for an install folder lives: next to it, so it is found without knowing anything else.
const journalPath = (dir) => path.join(path.dirname(dir), `${path.basename(dir)}.swap.journal`);

// A journal writer. Writes are best effort (a journal that can't be written must not stop an update) and atomic (a temp file,
// renamed over), so a reader never sees half a file. `state` is the JSON; set() merges into it and saves.
function openJournal(file, state) {
  const save = () => {
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
      fs.renameSync(`${file}.tmp`, file);
    } catch {}
  };
  return {
    state,
    set(patch) { Object.assign(state, patch); save(); },
    save,
    clear() { try { fs.rmSync(file, { force: true }); fs.rmSync(`${file}.tmp`, { force: true }); } catch {} },
  };
}

function readJournal(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ok = j && j.version === JOURNAL_VERSION && ['dir', 'root', 'old', 'staging', 'exe'].every((k) => typeof j[k] === 'string' && j[k]) && Array.isArray(j.moves);
    return ok ? j : null;
  } catch {
    return null;
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

// Renaming the whole install folder fails on Windows while ANY file inside it is in use, and one always is: an AI
// assistant (Claude Code, Codex, ...) set up with "Let other apps use Lumen" keeps a copy of Lumen.exe running from the
// install folder as long as it is open. A running exe can be renamed though (not overwritten), and so can a folder none
// of whose files is open. So when the folder itself won't move, the install is swapped entry by entry: every entry goes
// into `old` (a locked folder is split into its entries, one level at a time), then every entry of the new version goes
// into place. Whatever moved is journaled, so a failure puts everything back. Files are only ever renamed.
function moveTree(from, to, journal, merge, persist = () => {}) {
  const st = fs.lstatSync(from);
  if (!fs.existsSync(to)) {
    // the move is written down BEFORE it happens: a crash in between leaves a pair whose `to` isn't there, which undo skips
    const pair = [from, to];
    journal.push(pair);
    persist();
    try { fs.renameSync(from, to); return; } catch (err) { journal.splice(journal.indexOf(pair), 1); persist(); if (!st.isDirectory()) throw err; }
  } else if (!(merge && st.isDirectory() && fs.lstatSync(to).isDirectory())) {
    throw Object.assign(new Error(`${to} exists`), { code: 'EEXIST' });
  }
  // a folder that won't move whole (or one already in place, whose entries are merged in): its entries go one by one
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from)) moveTree(path.join(from, e), path.join(to, e), journal, merge, persist);
  try { fs.rmdirSync(from); } catch {}
}

// Puts every journaled move back (newest first). True when nothing is left out of place.
function undo(journal) {
  let ok = true;
  for (const [from, to] of [...journal].reverse()) {
    if (!fs.existsSync(to) || fs.existsSync(from)) continue; // never happened, or already back
    try { fs.mkdirSync(path.dirname(from), { recursive: true }); fs.renameSync(to, from); } catch { ok = false; }
  }
  if (ok) journal.length = 0;
  return ok;
}

// null when the install was swapped, else the error (everything is back where it was; err.undone says so). `jr` is the
// journal (see openJournal): its phase is 'to-old' while the install's entries move into `old`, then 'to-new'. `merge`
// is for a resumed swap, where a folder may already be half moved.
function swapEntries(o, old, jr, merge = false) {
  const moves = jr.state.moves || (jr.state.moves = []);
  try {
    fs.mkdirSync(old, { recursive: true });
    if (jr.state.phase !== 'to-new') {
      for (const e of fs.readdirSync(o.dir)) moveTree(path.join(o.dir, e), path.join(old, e), moves, merge, jr.save);
      jr.set({ phase: 'to-new' });
    }
    for (const e of fs.readdirSync(o.root)) moveTree(path.join(o.root, e), path.join(o.dir, e), moves, true, jr.save);
    return null;
  } catch (err) {
    const undone = undo(moves);
    jr.set({ phase: 'to-old', moves });
    return Object.assign(err, { undone });
  }
}

// Finishes or undoes a swap that was cut short, from its journal. Synchronous (Lumen runs it before anything else starts).
// Returns 'none' (no journal), 'busy' (the helper is still at work), 'stale' (the install is in place: nothing was lost),
// 'finished' (the staged update was complete and is now the install), 'rolled-back' (the old install was put back, and
// `errFile` says so for Settings), 'lost' / 'failed' (nothing could be done: the journal stays for a later try).
function recover(file, { isAlive = alive, now = Date.now() } = {}) {
  if (!fs.existsSync(file)) return 'none';
  const j = readJournal(file);
  const jr = openJournal(file, j || {});
  if (!j) { jr.clear(); return 'none'; }
  let age = 0;
  try { age = now - fs.statSync(file).mtimeMs; } catch {}
  if (j.helperPid && j.helperPid !== process.pid && age < STALE_BUSY_MS && isAlive(j.helperPid)) return 'busy';
  const has = (p) => fs.existsSync(p);
  const staged = () => has(j.root) && !checkExe(path.join(j.root, path.basename(j.exe)), j.minBytes);
  const done = (result) => { jr.clear(); return result; };
  const noteRollback = () => { if (j.errFile) try { fs.writeFileSync(j.errFile, `${MESSAGE_INTERRUPTED}\n`); } catch {} return done('rolled-back'); };

  if (j.mode !== 'entries') {
    if (has(j.dir)) return done('stale'); // the install is there (the swap never began, finished, or was reinstalled over)
    if (staged()) {
      try { fs.renameSync(j.root, j.dir); return done('finished'); } catch {}
    }
    if (has(j.old)) {
      try { fs.renameSync(j.old, j.dir); return noteRollback(); } catch { return 'failed'; }
    }
    return 'lost';
  }

  // entry by entry: forward when the new entries are all still to come or already coming, else back
  if (j.phase === 'to-new' || staged()) {
    const o = { dir: j.dir, root: j.root };
    if (!swapEntries(o, j.old, jr, true)) return done('finished');
    if (jr.state.moves.length) return 'failed'; // some moves could not be undone either: keep the journal
    return noteRollback();
  }
  return undo(j.moves) ? noteRollback() : 'failed';
}

// Folders from earlier entry-by-entry swaps whose running exe could not be deleted then (older Windows).
function sweepLeftovers(old) {
  try {
    const dir = path.dirname(old);
    for (const n of fs.readdirSync(dir)) if (n.startsWith(`${path.basename(old)}-`)) rmQuick(path.join(dir, n));
  } catch {}
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
  let old = o.old;
  let moved = false;
  const jr = openJournal(o.journal || journalPath(o.dir), { version: JOURNAL_VERSION, helperPid: process.pid, mode: 'folder', phase: 'folder-old', dir: o.dir, root: o.root, old, staging: o.staging, exe: o.exe, errFile: o.errFile, minBytes: o.minBytes, moves: [] });
  jr.save(); // before the first rename
  const deadline = Date.now() + lockMs; // (one bound for both ways of swapping)
  try {
    // (a virus scan holding a file lets go within moments; a running exe never does)
    await retry(() => fs.renameSync(o.dir, o.old), Math.min(lockMs, 1500), retryMs);
    moved = true;
  } catch {}
  if (moved) {
    jr.set({ phase: 'folder-new' }); // the install is out of the way: from here a crash leaves no install folder
    try {
      await retry(() => fs.renameSync(o.root, o.dir), Math.min(lockMs, 2e3), retryMs);
    } catch {
      try { fs.renameSync(o.old, o.dir); jr.clear(); } catch {} // (the journal stays when the old install could not be put back)
      if (aside) rmQuick(aside);
      return fail();
    }
  } else {
    // something has files open in the install: swap it entry by entry (see swapEntries)
    if (fs.existsSync(old)) old = `${o.old}-${process.pid}`; // (a leftover that could not be deleted)
    jr.set({ mode: 'entries', phase: 'to-old', old, moves: [] });
    for (let err; (err = swapEntries(o, old, jr)); await sleep(retryMs)) {
      if (Date.now() + retryMs > deadline) {
        if (err.undone) jr.clear();
        if (aside) rmQuick(aside);
        return fail();
      }
    }
  }
  jr.clear(); // the swap is complete
  rmQuick(o.staging); // (what is left of it is small: the folder was renamed out)
  if (relaunch) start(o.exe, o.exeArgs);
  // The new Lumen is starting; the old install goes now, in this helper (detached, nobody waits for it).
  rmQuick(old);
  if (aside) rmQuick(aside);
  sweepLeftovers(o.old);
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

if (require.main === module && process.argv[2] === 'recover') {
  const result = recover(process.argv[3]);
  console.log(result);
  process.exit(['none', 'stale', 'finished', 'rolled-back'].includes(result) ? 0 : 1);
} else if (require.main === module) {
  let opts;
  try { opts = JSON.parse(process.argv[2]); } catch { process.exit(2); }
  swap(opts).then(() => process.exit(0), () => process.exit(1));
}

module.exports = { swap, recover, journalPath, readJournal, MESSAGE_INTERRUPTED, checkExe, MIN_EXE_BYTES, MESSAGE, POLL_MS, RETRY_MS, LOCK_WAIT_MS };
