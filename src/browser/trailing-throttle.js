// Runs `fn` at once, then at most once every `ms` while calls keep coming; the last call is never lost (it runs when
// the wait is over). `.now()` runs it immediately and drops anything waiting (a state change that must not lag);
// `.cancel()` drops it. `clock` / `timers` are for tests.
function trailingThrottle(fn, ms, { clock = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let last = -Infinity;
  let timer = null;
  const run = () => { timer = null; last = clock(); fn(); };
  const call = () => {
    if (timer) return; // one is already waiting: it will carry this update too
    const wait = last + ms - clock();
    if (wait <= 0) run();
    else timer = setTimer(run, wait);
  };
  call.now = () => { if (timer) { clearTimer(timer); timer = null; } last = clock(); fn(); };
  call.cancel = () => { if (timer) { clearTimer(timer); timer = null; } };
  return call;
}

module.exports = { trailingThrottle };
