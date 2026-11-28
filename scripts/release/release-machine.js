// The machine for a release's checks (docs/releasing.md, "The machine-wide Electron lock"). release.js waits here, with a progress line,
// instead of stopping when another session's Electron run is under the e2e lock:
//   1. with --hold-lock (the default) it reserves the machine (scripts/test/e2e-lock.js reserve): from then on every other acquirer waits,
//      so a session running npm test (which takes the lock per suite) cannot keep slipping back in between its suites;
//   2. it waits for the e2e lock itself and takes it (exact: stale the moment this pid dies), holding both until the checks end.
// With --share-machine there is no reservation; the lock is only waited for here and taken per Electron suite later.
const e2eLock = require('../test/e2e-lock');
const { Stop, sleep } = require('./ship-common');

// -> { waited: true when something was in the way }. Throws Stop after waitMs.
async function holdMachine({ owner, holdLock = true, waitMs = 4 * 3600000, pollMs = 5000, progressMs = 5 * 60000, log = () => {}, lock = e2eLock } = {}) {
  const t0 = Date.now();
  let waited = false;
  if (holdLock) {
    let saidAt = -Infinity;
    for (;;) {
      const r = lock.reserve(owner);
      if (r === true) break;
      waited = true;
      if (Date.now() - t0 >= waitMs) throw new Stop(`the machine is still reserved by ${r ? `${r.name} (pid ${r.pid})` : 'another release'} after ${Math.round(waitMs / 60000)} min`);
      if (Date.now() - saidAt >= progressMs) { log(`waiting for ${r ? `${r.name} (pid ${r.pid})` : 'another release'} to finish… (it reserved the machine for its checks)`); saidAt = Date.now(); }
      await sleep(pollMs);
    }
  }
  try {
    await lock.acquire({ owner, exact: true, waitMs: Math.max(0, waitMs - (Date.now() - t0)), pollMs, progressMs, onWait: (i) => { waited = true; log(i.line); } });
  } catch (err) { lock.unreserve(); throw new Stop(err.message); }
  return { waited };
}

// Ends the hold: the e2e lock and the reservation. Never throws.
function freeMachine(lock = e2eLock) { lock.release(); lock.unreserve(); }

module.exports = { holdMachine, freeMachine };
