#!/usr/bin/env node
// The machine-wide Electron test lock. Several agents run hidden Electron tests on one laptop; only ONE may run at a time.
// The lock is the directory %LOCALAPPDATA%\Temp\lumen-e2e-lock (override: LUMEN_E2E_LOCK_DIR), made with mkdir (atomic: it fails when
// the lock is held) and holding an `owner` file: "<pid> <name> <epoch-seconds>", the same format the shell recipe writes.
//   node scripts/e2e-lock.js run [--owner name] [--wait-min n] -- <cmd...>   run a command under the lock; always released
// As a module: acquire / acquireSync / release / withLock / withLockSync, readOwner, isStale.
// A lock is stale when its directory is older than staleMs (20 min) AND the owner pid is no longer alive: it is then removed and taken.
// A live owner is never robbed, however old the lock is. Docs: docs/releasing.md.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const STALE_MS = 20 * 60000;
const POLL_MS = 5000;
const HELD_ENV = 'LUMEN_E2E_LOCK_HELD'; // the pid of the process holding the lock, inherited by its children so a nested taker does not deadlock

const lockDir = () => process.env.LUMEN_E2E_LOCK_DIR || path.join(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : os.tmpdir(), 'lumen-e2e-lock');
const ownerFile = () => path.join(lockDir(), 'owner');

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// { pid, name, epoch } from the owner file, or null when it is missing or unreadable.
function readOwner() {
  try {
    const m = fs.readFileSync(ownerFile(), 'utf8').trim().match(/^(\d+)\s+(\S+)\s+(\d+)/);
    return m ? { pid: Number(m[1]), name: m[2], epoch: Number(m[3]) } : null;
  } catch { return null; }
}

function isStale(staleMs) {
  let age;
  try { age = Date.now() - fs.statSync(lockDir()).mtimeMs; } catch { return false; } // gone already: the next mkdir wins
  if (age < staleMs) return false;
  const o = readOwner();
  return !(o && pidAlive(o.pid));
}

let held = null; // { owner } while this process holds the lock

function cleanupOnExit() { try { release(); } catch { /* best effort */ } }
function onSignal(sig) { cleanupOnExit(); process.kill(process.pid, sig); }

// One attempt: true when the lock is now ours.
function tryTake(owner, staleMs) {
  if (held) return true;
  const hp = Number(process.env[HELD_ENV]);
  if (hp && hp !== process.pid && pidAlive(hp)) { const o = readOwner(); if (o && o.pid === hp) { held = { owner, nested: true }; return true; } }
  try { fs.mkdirSync(lockDir()); } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    if (!isStale(staleMs)) return false;
    fs.rmSync(lockDir(), { recursive: true, force: true });
    try { fs.mkdirSync(lockDir()); } catch (e2) { if (e2.code === 'EEXIST') return false; throw e2; }
  }
  fs.writeFileSync(ownerFile(), `${process.pid} ${String(owner).replace(/\s+/g, '-')} ${Math.floor(Date.now() / 1000)}\n`);
  held = { owner };
  process.env[HELD_ENV] = String(process.pid);
  process.once('exit', cleanupOnExit);
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  return true;
}

function timeoutError(owner, waitMs) {
  const o = readOwner();
  return new Error(`e2e lock still held after ${Math.round(waitMs / 1000)}s${o ? ` by ${o.name} (pid ${o.pid})` : ''}: ${lockDir()}`);
}

// acquire({ owner, waitMs, staleMs, pollMs }): resolves once the lock is ours; rejects after waitMs (default 60 min).
async function acquire({ owner = 'lumen', waitMs = 60 * 60000, staleMs = STALE_MS, pollMs = POLL_MS } = {}) {
  const t0 = Date.now();
  while (!tryTake(owner, staleMs)) {
    if (Date.now() - t0 >= waitMs) throw timeoutError(owner, waitMs);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// The same, blocking (for scripts built on spawnSync).
function acquireSync({ owner = 'lumen', waitMs = 60 * 60000, staleMs = STALE_MS, pollMs = POLL_MS } = {}) {
  const t0 = Date.now();
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (!tryTake(owner, staleMs)) {
    if (Date.now() - t0 >= waitMs) throw timeoutError(owner, waitMs);
    Atomics.wait(cell, 0, 0, pollMs);
  }
}

// Releases the lock if this process holds it (a nested taker's release does nothing). Never throws.
function release() {
  if (!held) return;
  const h = held;
  held = null;
  if (h.nested) return;
  delete process.env[HELD_ENV];
  const o = readOwner();
  if (o && o.pid !== process.pid) return; // not ours any more (taken over as stale): leave it
  try { fs.rmSync(lockDir(), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* the stale rule cleans up */ }
}

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
  if (head[0] !== 'run' || !cmd.length) { console.error('usage: node scripts/e2e-lock.js run [--owner name] [--wait-min n] -- <cmd...>'); return 2; }
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

module.exports = { acquire, acquireSync, release, withLock, withLockSync, readOwner, isStale, pidAlive, lockDir, STALE_MS, HELD_ENV };

if (require.main === module) cli(process.argv.slice(2)).then((code) => process.exit(code));
