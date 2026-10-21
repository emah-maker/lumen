// The machine-wide Electron lock (scripts/test/e2e-lock.js). Plain Node, no Electron: a temp lock dir through LUMEN_E2E_LOCK_DIR.
// Covers acquire/release, a second acquirer waiting, a stale lock (old and a dead owner pid) taken over, a live owner never robbed
// even when old, and `run --` releasing after a failing command.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-e2e-lock-test-'));
const LOCK = path.join(base, 'lock');
process.env.LUMEN_E2E_LOCK_DIR = LOCK;
delete process.env.LUMEN_E2E_LOCK_HELD;
const lock = require('../../scripts/test/e2e-lock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const old = () => { const t = new Date(Date.now() - 3 * 3600000); fs.utimesSync(LOCK, t, t); };
const plant = (pid) => { fs.mkdirSync(LOCK); fs.writeFileSync(path.join(LOCK, 'owner'), `${pid} someone ${Math.floor(Date.now() / 1000)}\n`); };
const clear = () => fs.rmSync(LOCK, { recursive: true, force: true });
const deadPid = () => { const r = spawnSync(process.execPath, ['-e', '0']); return r.pid; };

(async () => {
  // acquire, then release
  await lock.acquire({ owner: 'unit-a', waitMs: 2000, pollMs: 50 });
  const o = lock.readOwner();
  check('acquire creates the lock dir with an owner file "<pid> <name> <epoch>"', fs.existsSync(LOCK) && o && o.pid === process.pid && o.name === 'unit-a' && Math.abs(o.epoch - Date.now() / 1000) < 60, JSON.stringify(o));
  lock.release();
  check('release removes the lock dir', !fs.existsSync(LOCK));
  lock.release();
  check('a second release is harmless', !fs.existsSync(LOCK));

  // a second acquirer waits until the first releases (the holder is a live child process)
  const holder = spawn(process.execPath, ['-e', `process.env.LUMEN_E2E_LOCK_DIR=${JSON.stringify(LOCK)};const l=require(${JSON.stringify(path.join(__dirname, '..', '..', 'scripts', 'test', 'e2e-lock.js'))});l.acquire({owner:'holder',pollMs:50}).then(()=>{console.log('held');process.stdin.on('data',()=>{l.release();process.exit(0);});});`], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise((r) => holder.stdout.once('data', r));
  let got = false;
  const waiter = lock.acquire({ owner: 'unit-b', waitMs: 30000, pollMs: 50 }).then(() => { got = true; });
  await sleep(400);
  check('a second acquirer waits while the lock is held', !got && lock.readOwner().name === 'holder');
  holder.stdin.write('go\n');
  await waiter;
  check('...and takes it once the holder releases', got && lock.readOwner().name === 'unit-b');
  lock.release();
  let timedOut = false;
  plant(process.pid + 0); // held by a live process (this one, planted by hand): a waiter with a short waitMs gives up
  try { await lock.acquire({ owner: 'unit-c', waitMs: 200, pollMs: 50 }); } catch (e) { timedOut = /still held/.test(e.message); }
  check('waiting past waitMs rejects instead of taking the lock', timedOut);
  clear();

  // stale: old dir AND dead pid
  plant(deadPid()); old();
  check('isStale: old dir + dead owner pid', lock.isStale(20 * 60000));
  await lock.acquire({ owner: 'unit-d', waitMs: 2000, pollMs: 50 });
  check('a stale lock with a dead pid is taken over', lock.readOwner().pid === process.pid && lock.readOwner().name === 'unit-d', JSON.stringify(lock.readOwner()));
  lock.release();

  // a fresh lock with a dead pid is not stale yet (younger than staleMs)
  plant(deadPid());
  let stolen = false;
  try { await lock.acquire({ owner: 'unit-e', waitMs: 200, pollMs: 50 }); stolen = true; } catch { /* expected */ }
  check('a young lock is not taken even when its pid is dead', !stolen && lock.readOwner().name === 'someone');
  clear();

  // live pid, old dir: never stolen
  const live = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
  plant(live.pid); old();
  let robbed = false;
  try { await lock.acquire({ owner: 'unit-f', waitMs: 300, pollMs: 50 }); robbed = true; } catch { /* expected */ }
  check('a lock whose owner pid is alive is never stolen, even when old', !robbed && !lock.isStale(20 * 60000) && lock.readOwner().pid === live.pid);
  live.kill();
  clear();

  // the sync flavour and withLock
  lock.withLockSync(() => check('withLockSync holds the lock while the function runs', lock.readOwner().pid === process.pid), { waitMs: 1000, pollMs: 50 });
  check('withLockSync releases afterwards', !fs.existsSync(LOCK));
  let threw = false;
  try { await lock.withLock(async () => { throw new Error('boom'); }, { waitMs: 1000, pollMs: 50 }); } catch { threw = true; }
  check('withLock releases when the function throws', threw && !fs.existsSync(LOCK));

  // CLI: run -- releases after a failing command, and returns its exit code; the child sees the lock held
  const cli = path.join(__dirname, '..', '..', 'scripts', 'test', 'e2e-lock.js');
  const env = { ...process.env, LUMEN_E2E_LOCK_DIR: LOCK };
  const probe = `const fs=require('fs');process.exit(fs.existsSync(process.env.LUMEN_E2E_LOCK_DIR+'/owner')?7:9)`;
  const r1 = spawnSync(process.execPath, [cli, 'run', '--owner', 'unit-cli', '--', process.execPath, '-e', probe], { env, encoding: 'utf8' });
  check('run -- holds the lock during the command and passes its exit code on', r1.status === 7, `${r1.status} ${r1.stderr}`);
  check('run -- released the lock after a failing command', !fs.existsSync(LOCK));
  const r2 = spawnSync(process.execPath, [cli, 'run', '--', process.execPath, '-e', 'process.exit(0)'], { env, encoding: 'utf8' });
  check('run -- releases after a passing command too', r2.status === 0 && !fs.existsSync(LOCK), `${r2.status} ${r2.stderr}`);
  const r3 = spawnSync(process.execPath, [cli, 'run'], { env, encoding: 'utf8' });
  check('run without a command is a usage error and takes no lock', r3.status === 2 && !fs.existsSync(LOCK));

  fs.rmSync(base, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
