// Tears a helper down after it has sat unused: a hidden window or view that costs a renderer's memory
// (the tab-drag card, say) is made when it is first needed and closed `ms` after its last use. `touch()` is called on
// every use (and restarts the wait); `busy()` says the helper is in use right now (the check is repeated later rather
// than closing it); `onIdle()` closes it. Timers are injectable so the logic is tested without waiting.
function createIdleReaper({ ms, onIdle, busy = () => false, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  const arm = () => {
    timer = setTimer(() => {
      timer = null;
      if (busy()) { arm(); return; }
      onIdle();
    }, ms);
    timer?.unref?.();
  };
  return {
    touch() { if (timer) clearTimer(timer); arm(); },
    cancel() { if (timer) clearTimer(timer); timer = null; },
    pending: () => timer !== null,
  };
}

module.exports = { createIdleReaper };
