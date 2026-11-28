#!/usr/bin/env node
// The machine-wide Electron test lock. Several agents run hidden Electron tests on one laptop; only ONE may run at a time.
// The lock is the directory %LOCALAPPDATA%\Temp\lumen-e2e-lock (override: LUMEN_E2E_LOCK_DIR), made with mkdir (atomic: it fails when
// the lock is held) and holding an `owner` file: "<pid> <name> <epoch-seconds>", the same format the shell recipe writes.
//   node scripts/test/e2e-lock.js run [--owner name] [--wait-min n] -- <cmd...>   run a command under the lock; always released
// As a module: acquire / acquireSync / release / withLock / withLockSync, readOwner, isStale, reserve / unreserve / readReservation.
// A lock is stale when its directory is older than staleMs (20 min) AND the owner pid is no longer alive: it is then removed and taken.
// An owner taken with { exact: true } (release.js: its pid IS the holder) is stale as soon as that pid is dead, however young.
// A live owner is never robbed, however old the lock is.
// The release reservation: the file "<lock dir>-release" ("<pid> <name> <epoch>"), written by release.js from its preflight to the end of its
// checks. While its pid lives every other acquirer waits (saying so), also between the release's own suites; the release itself and its child
// processes (LUMEN_E2E_RESERVED carries its pid) are exempt. A reservation whose pid is dead (or older than 12 h) is removed by the next one
// to look. Docs: docs/releasing.md.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const STALE_MS = 20 * 60000;
const POLL_MS = 5000;
const WAIT_MS = 4 * 3600000; // the default wait: long enough to sit out a whole release's checks
const PROGRESS_MS = 5 * 60000; // how often a waiter says it is still waiting
const RESERVATION_MAX_MS = 12 * 3600000; // a reservation older than this is removed even if its pid looks alive (a reused pid)
const HELD_ENV = 'LUMEN_E2E_LOCK_HELD'; // the pid of the process holding the lock, inherited by its children so a nested taker does not deadlock
const RESERVED_ENV = 'LUMEN_E2E_RESERVED'; // the pid of the release that reserved the machine, inherited by its children (they may take the lock)

const lockDir = () => process.env.LUMEN_E2E_LOCK_DIR || path.join(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : os.tmpdir(), 'lumen-e2e-lock');
const ownerFile = () => path.join(lockDir(), 'owner');
const reservationFile = () => `${lockDir()}-release`;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

const parseLine = (text) => {
  const m = String(text).trim().match(/^(\d+)\s+(\S+)\s+(\d+)(\s+exact)?/);
  return m ? { pid: Number(m[1]), name: m[2], epoch: Number(m[3]), exact: Boolean(m[4]) } : null;
};

// { pid, name, epoch, exact } from the owner file, or null when it is missing or unreadable.
function readOwner() {
  try { return parseLine(fs.readFileSync(ownerFile(), 'utf8')); } catch { return null; }
}

function isStale(staleMs) {
  let age;
  try { age = Date.now() - fs.statSync(lockDir()).mtimeMs; } catch { return false; } // gone already: the next mkdir wins
  const o = readOwner();
  if (o && o.exact && !pidAlive(o.pid)) return true; // that pid was the holder itself: dead means gone, however young the lock
  if (age < staleMs) return false;
  return !(o && pidAlive(o.pid));
}

// ------------------------------------------------------------------------------------------------ the release reservation

let reserved = false; // true while this process holds the reservation

// { pid, name, epoch } of a live reservation, or null. A dead or too-old one is removed here, by whoever looks first.
function readReservation() {
  let text;
  try { text = fs.readFileSync(reservationFile(), 'utf8'); } catch { return null; }
  const r = parseLine(text);
  if (r && pidAlive(r.pid) && Date.now() - r.epoch * 1000 < RESERVATION_MAX_MS) return r;
  try { if (fs.readFileSync(reservationFile(), 'utf8') === text) fs.rmSync(reservationFile(), { force: true }); } catch { /* raced: someone else cleaned it */ }
  return null;
}

// May this process take the lock despite reservation r? Only the reserving release and its children.
const exemptFrom = (r) => r.pid === process.pid || Number(process.env[RESERVED_ENV]) === r.pid;

function dropReservationOnExit() { try { unreserve(); } catch { /* best effort */ } }
function onResSignal(sig) { dropReservationOnExit(); try { release(); } catch { /* best effort */ } process.kill(process.pid, sig); }
const onResInt = () => onResSignal('SIGINT');
const onResTerm = () => onResSignal('SIGTERM');

// reserve(name): holds the machine for a release. true when the reservation is ours; another live process's reservation { pid, name, epoch }
// when it got there first. Removed by unreserve(), on exit, SIGINT or SIGTERM; a hard crash leaves a file whose dead pid gets it removed.
function reserve(name = 'release') {
  if (reserved) return true;
  const line = `${process.pid} ${String(name).replace(/\s+/g, '-')} ${Math.floor(Date.now() / 1000)}\n`;
  fs.mkdirSync(path.dirname(reservationFile()), { recursive: true });
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(reservationFile(), line, { flag: 'wx' });
      reserved = true;
      process.env[RESERVED_ENV] = String(process.pid);
      process.once('exit', dropReservationOnExit);
      process.once('SIGINT', onResInt);
      process.once('SIGTERM', onResTerm);
      return true;
    } catch (err) { if (err.code !== 'EEXIST') throw err; }
    const other = readReservation(); // removes a dead one, so the next try can win
    if (other) return other;
  }
  return readReservation() || false;
}

// Ends this process's reservation, so others may take the lock again. Never throws.
function unreserve() {
  if (!reserved) return;
  reserved = false;
  process.removeListener('exit', dropReservationOnExit); process.removeListener('SIGINT', onResInt); process.removeListener('SIGTERM', onResTerm);
  delete process.env[RESERVED_ENV];
  try { const r = parseLine(fs.readFileSync(reservationFile(), 'utf8')); if (r && r.pid === process.pid) fs.rmSync(reservationFile(), { force: true }); } catch { /* gone */ }
}

// ------------------------------------------------------------------------------------------------------------- the lock

let held = null; // { owner } while this process holds the lock

function cleanupOnExit() { try { release(); } catch { /* best effort */ } }
function onSignal(sig) { cleanupOnExit(); process.kill(process.pid, sig); }
const onInt = () => onSignal('SIGINT');
const onTerm = () => onSignal('SIGTERM');
// The handlers go with the lock: a runner taking it once per suite (test-all, ~300 suites) used to add three listeners each time and
// never remove them (MaxListenersExceededWarning, and every old handler still ran on exit).
function unhook() { process.removeListener('exit', cleanupOnExit); process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm); }

// One attempt: true when the lock is now ours.
function tryTake(owner, staleMs, exact = false) {
  if (held) return true;
  const hp = Number(process.env[HELD_ENV]);
  if (hp && hp !== process.pid && pidAlive(hp)) { const o = readOwner(); if (o && o.pid === hp) { held = { owner, nested: true }; return true; } }
  const r = readReservation();
  if (r && !exemptFrom(r)) return false; // a release holds the machine: wait until its checks end
  try { fs.mkdirSync(lockDir()); } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    if (!isStale(staleMs)) return false;
    fs.rmSync(lockDir(), { recursive: true, force: true });
    try { fs.mkdirSync(lockDir()); } catch (e2) { if (e2.code === 'EEXIST') return false; throw e2; }
  }
  fs.writeFileSync(ownerFile(), `${process.pid} ${String(owner).replace(/\s+/g, '-')} ${Math.floor(Date.now() / 1000)}${exact ? ' exact' : ''}\n`);
  held = { owner };
  process.env[HELD_ENV] = String(process.pid);
  process.once('exit', cleanupOnExit);
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  return true;
}

// Who is in the way right now: { name, pid, release } (release: a release reservation is what blocks), or null.
function blocker() {
  const r = readReservation();
  if (r && !exemptFrom(r)) return { name: r.name, pid: r.pid, release: true };
  const o = readOwner();
  return o ? { name: o.name, pid: o.pid, release: false } : null;
}
const waitLine = (b, waitedMs) => `waiting for ${b ? `${b.name} (pid ${b.pid})` : 'the e2e lock'} to finish…${b && b.release ? ' (a release is in its checks; other Electron runs wait until they end)' : ''}${waitedMs >= 60000 ? ` ${Math.round(waitedMs / 60000)} min so far` : ''}`;
const defaultOnWait = (info) => console.error(`[e2e-lock] ${info.line}`);

function timeoutError(waitMs) {
  const b = blocker();
  return new Error(`e2e lock still ${b && b.release ? 'reserved' : 'held'} after ${Math.round(waitMs / 1000)}s${b ? ` by ${b.name} (pid ${b.pid})` : ''}: ${lockDir()}`);
}

// The progress report shared by acquire and acquireSync: onWait({ name, pid, release, waitedMs, line }) runs on the first failed try, then
// every progressMs (default 5 min), and at once whenever who is in the way changes. onWait: null says nothing.
function waiter({ onWait = defaultOnWait, progressMs = PROGRESS_MS } = {}) {
  const t0 = Date.now();
  let lastAt = -Infinity;
  let lastWho = null;
  return () => {
    if (!onWait) return;
    const b = blocker();
    const who = b ? `${b.pid}:${b.release}` : '';
    const now = Date.now();
    if (who === lastWho && now - lastAt < progressMs) return;
    lastAt = now; lastWho = who;
    try { onWait({ ...(b || {}), waitedMs: now - t0, line: waitLine(b, now - t0) }); } catch { /* a logger must not break the wait */ }
  };
}

// acquire({ owner, waitMs, staleMs, pollMs, exact, onWait, progressMs }): resolves once the lock is ours; rejects after waitMs (default 4 h).
// exact: this pid is the holder itself, so the lock is stale the moment it dies (release.js). onWait: see waiter (default: a line on stderr).
async function acquire({ owner = 'lumen', waitMs = WAIT_MS, staleMs = STALE_MS, pollMs = POLL_MS, exact = false, ...rest } = {}) {
  const t0 = Date.now();
  const tell = waiter(rest);
  while (!tryTake(owner, staleMs, exact)) {
    if (Date.now() - t0 >= waitMs) throw timeoutError(waitMs);
    tell();
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// The same, blocking (for scripts built on spawnSync).
function acquireSync({ owner = 'lumen', waitMs = WAIT_MS, staleMs = STALE_MS, pollMs = POLL_MS, exact = false, ...rest } = {}) {
  const t0 = Date.now();
  const tell = waiter(rest);
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (!tryTake(owner, staleMs, exact)) {
    if (Date.now() - t0 >= waitMs) throw timeoutError(waitMs);
    tell();
    Atomics.wait(cell, 0, 0, pollMs);
  }
}

// Releases the lock if this process holds it (a nested taker's release does nothing). Never throws.
function release() {
  if (!held) return;
  const h = held;
  held = null;
  if (h.nested) return;
  unhook();
  delete process.env[HELD_ENV];
  const o = readOwner();
  if (o && o.pid !== process.pid) return; // not ours any more (taken over as stale): leave it
  try { fs.rmSync(lockDir(), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* the stale rule cleans up */ }
}

// True while this process holds the lock itself (not as a nested taker).
const holds = () => Boolean(held && !held.nested);

async function withLock(fn, opts) {
  await acquire(opts);
  try { return await fn(); } finally { release(); }
}

function withLockSync(fn, opts) {
  acquireSync(opts);
  try { return fn(); } finally { release(); }
}

// CLI: run a command under the lock; its exit code is ours; released on success, failure and SIGINT/SIGTERM.
async function cli(argv) {
  const dash = argv.indexOf('--');
  const head = dash === -1 ? argv : argv.slice(0, dash);
  const cmd = dash === -1 ? [] : argv.slice(dash + 1);
  if (head[0] !== 'run' || !cmd.length) { console.error('usage: node scripts/test/e2e-lock.js run [--owner name] [--wait-min n] -- <cmd...>'); return 2; }
  const opts = { owner: 'lumen-run' };
  for (let i = 1; i < head.length; i++) {
    if (head[i] === '--owner') opts.owner = head[++i];
    else if (head[i] === '--wait-min') opts.waitMs = Number(head[++i]) * 60000;
    else { console.error(`unknown argument: ${head[i]}`); return 2; }
  }
  try { await acquire(opts); } catch (err) { console.error(err.message); return 1; }
  return new Promise((resolve) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' && !/\.exe$/i.test(cmd[0]) && !/^node(\.exe)?$/i.test(cmd[0]) });
    const stop = (sig) => () => { try { child.kill(sig); } catch { /* gone */ } release(); resolve(sig === 'SIGINT' ? 130 : 143); };
    process.removeAllListeners('SIGINT'); process.removeAllListeners('SIGTERM');
    process.on('SIGINT', stop('SIGINT')); process.on('SIGTERM', stop('SIGTERM'));
    child.on('error', (err) => { console.error(err.message); release(); resolve(127); });
    child.on('close', (code, sig) => { release(); resolve(code === null ? (sig ? 1 : 1) : code); });
  });
}

module.exports = {
  acquire, acquireSync, release, holds, withLock, withLockSync, readOwner, isStale, pidAlive, lockDir,
  reserve, unreserve, readReservation, reservationFile, blocker, waitLine, STALE_MS, WAIT_MS, HELD_ENV, RESERVED_ENV,
};

if (require.main === module) cli(process.argv.slice(2)).then((code) => process.exit(code));
