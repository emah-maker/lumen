// The machine-wide Electron lock (scripts/test/e2e-lock.js). Plain Node, no Electron: a temp lock dir through LUMEN_E2E_LOCK_DIR.
// Covers acquire/release, a second acquirer waiting, a stale lock (old and a dead owner pid) taken over, a live owner never robbed
// even when old, `run --` releasing after a failing command, the progress line while waiting, an exact owner (stale once its pid dies),
// and the release reservation: it blocks other acquirers but not the release or its children, and goes on exit or once its pid is dead.
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
delete process.env.LUMEN_E2E_RESERVED; // (run from a release's checks, this process would otherwise count as the release's child)
const lock = require('../../scripts/test/e2e-lock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const old = () => { const t = new Date(Date.now() - 3 * 3600000); fs.utimesSync(LOCK, t, t); };
const plant = (pid) => { fs.mkdirSync(LOCK); fs.writeFileSync(path.join(LOCK, 'owner'), `${pid} someone ${Math.floor(Date.now() / 1000)}\n`); };
const clear = () => fs.rmSync(LOCK, { recursive: true, force: true });
const lineFrom = (p) => new Promise((r) => p.stdout.once('data', (d) => r(String(d).trim())));
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

  // ---- an exact owner (release.js: its pid is the holder) is stale the moment that pid dies, however young the lock
  fs.mkdirSync(LOCK); fs.writeFileSync(path.join(LOCK, 'owner'), `${deadPid()} release-9.9.9 ${Math.floor(Date.now() / 1000)} exact\n`);
  check('isStale: a young lock whose exact owner pid is dead is stale', lock.isStale(20 * 60000) && lock.readOwner().exact === true);
  await lock.acquire({ owner: 'unit-exact', waitMs: 2000, pollMs: 50, onWait: null });
  check('...and is taken over at once', lock.readOwner().name === 'unit-exact' && lock.readOwner().exact === false);
  lock.release();
  await lock.acquire({ owner: 'unit-exact2', exact: true, waitMs: 2000, pollMs: 50 });
  check('acquire({ exact: true }) writes the exact marker in the owner file', /^\d+ unit-exact2 \d+ exact\n$/.test(fs.readFileSync(path.join(LOCK, 'owner'), 'utf8')) && lock.holds());
  lock.release();

  // ---- the progress line: onWait runs on the first failed try, names who holds the lock, then only every progressMs
  const holder2 = spawn(process.execPath, [path.join(__dirname, '..', 'helpers', '_e2e-lock-child.js'), 'hold', 'suite-run'], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, LUMEN_E2E_LOCK_DIR: LOCK } });
  await lineFrom(holder2);
  const seen = [];
  const w2 = lock.acquire({ owner: 'unit-wait', waitMs: 30000, pollMs: 50, progressMs: 60000, onWait: (i) => seen.push(i) });
  await sleep(500);
  check('waiting for a held lock reports "waiting for <owner> (pid) to finish…" once, not on every poll', seen.length === 1 && seen[0].name === 'suite-run' && seen[0].pid === holder2.pid && seen[0].release === false && /^waiting for suite-run \(pid \d+\) to finish…/.test(seen[0].line), JSON.stringify(seen));
  holder2.stdin.write('release\n');
  await w2;
  check('...and takes the lock once its holder releases it', lock.readOwner().name === 'unit-wait');
  lock.release();
  holder2.stdin.write('exit\n');
  const errs = [];
  const origErr = console.error; console.error = (m) => errs.push(String(m));
  plant(process.pid); // held by hand: the default reporter writes the line on stderr
  try { await lock.acquire({ owner: 'unit-default', waitMs: 150, pollMs: 50 }); } catch { /* expected */ }
  console.error = origErr;
  check('without onWait, a waiter says so on stderr ("[e2e-lock] waiting for someone ...")', errs.length === 1 && /^\[e2e-lock\] waiting for someone \(pid \d+\) to finish…/.test(errs[0]), errs.join(' | '));
  clear();

  // ---- the release reservation
  const RES = lock.reservationFile();
  check('the reservation file sits beside the lock dir (<lock dir>-release)', RES === `${LOCK}-release`);
  const reserver = spawn(process.execPath, [path.join(__dirname, '..', 'helpers', '_e2e-lock-child.js'), 'reserve', 'release-1.2.3'], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, LUMEN_E2E_LOCK_DIR: LOCK } });
  const ask = async (cmd) => { const p = lineFrom(reserver); reserver.stdin.write(`${cmd}\n`); return p; };
  const first = await lineFrom(reserver);
  const res = lock.readReservation();
  check('reserve() writes "<pid> <name> <epoch>" to the reservation file and returns true', first === 'true' && res && res.pid === reserver.pid && res.name === 'release-1.2.3', `${first} ${JSON.stringify(res)}`);
  const other = lock.reserve('release-2.0.0');
  check('a second release cannot reserve while the first one\'s pid lives: reserve() returns the holder', other && other.pid === reserver.pid && other.name === 'release-1.2.3', JSON.stringify(other));
  const blockedSeen = [];
  let blocked = false;
  try { await lock.acquire({ owner: 'other-session', waitMs: 300, pollMs: 50, onWait: (i) => blockedSeen.push(i) }); } catch (e) { blocked = /still reserved/.test(e.message) && /release-1\.2\.3/.test(e.message); }
  check('the reservation blocks other acquirers even with the lock itself free (they wait, then time out naming it)', blocked && !fs.existsSync(LOCK));
  check('...and their progress line says a release is in its checks', blockedSeen.length >= 1 && blockedSeen[0].release === true && /waiting for release-1\.2\.3 \(pid \d+\) to finish… \(a release is in its checks/.test(blockedSeen[0].line), JSON.stringify(blockedSeen));
  let syncBlocked = false;
  try { lock.acquireSync({ owner: 'other-sync', waitMs: 200, pollMs: 50, onWait: null }); } catch { syncBlocked = true; }
  check('acquireSync (npm test, per suite) honours the reservation too', syncBlocked && !fs.existsSync(LOCK));
  check('the reserving release itself may take the lock (no deadlock)', (await ask('self')) === 'self-ok');
  check('a child process of the release (LUMEN_E2E_RESERVED) may take the lock: its suites run', (await ask('child')) === 'child-ok');
  let gotAfter = false;
  const queued = lock.acquire({ owner: 'queued-session', waitMs: 30000, pollMs: 50, onWait: null }).then(() => { gotAfter = true; });
  await sleep(300);
  check('a waiter queued behind the reservation is still waiting while it lasts', !gotAfter);
  check('unreserve() removes the reservation file', (await ask('free')) === 'freed' && !fs.existsSync(RES));
  await queued;
  check('...and the queued waiter then takes the lock', gotAfter && lock.readOwner().name === 'queued-session');
  lock.release();
  reserver.stdin.write('exit\n');
  await new Promise((r) => reserver.once('exit', r));

  // a release that exits (a Stop, an error) without unreserving: the exit handler removes the file
  const quitter = spawnSync(process.execPath, [path.join(__dirname, '..', 'helpers', '_e2e-lock-child.js'), 'reserve-and-quit', 'release-quit'], { encoding: 'utf8', env: { ...process.env, LUMEN_E2E_LOCK_DIR: LOCK } });
  check('a release process that exits while holding the reservation removes it on exit', quitter.status === 3 && !fs.existsSync(RES), `${quitter.status} ${quitter.stderr}`);
  // a crashed release (killed hard): the file stays, but its dead pid makes the next reader remove it
  fs.writeFileSync(RES, `${deadPid()} release-crashed ${Math.floor(Date.now() / 1000)}\n`);
  check('a reservation whose pid is dead counts for nothing and is removed by the next reader', lock.readReservation() === null && !fs.existsSync(RES));
  fs.writeFileSync(RES, `${deadPid()} release-crashed ${Math.floor(Date.now() / 1000)}\n`);
  await lock.acquire({ owner: 'after-crash', waitMs: 2000, pollMs: 50, onWait: null });
  check('an acquirer is not blocked by a crashed release\'s reservation, and cleans it up', lock.readOwner().name === 'after-crash' && !fs.existsSync(RES));
  lock.release();
  fs.writeFileSync(RES, `${process.pid} release-ancient ${Math.floor(Date.now() / 1000) - 13 * 3600}\n`);
  check('a reservation older than 12 h is ignored even when its pid is alive (a reused pid), and removed', lock.readReservation() === null && !fs.existsSync(RES));
  fs.writeFileSync(RES, `${deadPid()} release-crashed ${Math.floor(Date.now() / 1000)}\n`);
  check('reserve() takes over a dead release\'s reservation', lock.reserve('release-next') === true && lock.readReservation().name === 'release-next' && process.env.LUMEN_E2E_RESERVED === String(process.pid));
  lock.unreserve();
  check('unreserve() removes the file and the env mark', !fs.existsSync(RES) && !process.env.LUMEN_E2E_RESERVED);

  const counts = () => ['exit', 'SIGINT', 'SIGTERM'].map((e) => process.listenerCount(e)).join(',');
  const before = counts();
  for (let i = 0; i < 25; i++) lock.withLockSync(() => {}, { owner: 'unit-many' });
  check('taking and releasing the lock 25 times leaves no exit or signal listeners behind (test-all takes it once per suite)', counts() === before && !fs.existsSync(LOCK), `${before} -> ${counts()}`);

  fs.rmSync(base, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
