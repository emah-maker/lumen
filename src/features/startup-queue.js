// Work that is not needed to show the first page, run in order once the first tab has loaded: one task at a time,
// a short gap between them so none of it piles onto the main process in one burst (each used to start on its own
// timer, and several landed in the same 100 ms while the first page was still painting). Lower `priority` runs first;
// equal priorities keep the order they were added in. A task that throws or runs past `taskCapMs` does not hold up
// the rest. Timers are injectable so the ordering is tested without waiting.
function createStartupQueue({ gapMs = 60, taskCapMs = 3000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const pending = [];
  const done = [];
  let seq = 0;
  let released = false;
  let running = false;

  function next() {
    if (!released || running || !pending.length) return;
    pending.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    const task = pending.shift();
    running = true;
    let finished = false;
    let cap = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimer(cap);
      done.push(task.name);
      setTimer(() => { running = false; next(); }, gapMs).unref?.();
    };
    cap = setTimer(finish, taskCapMs);
    cap?.unref?.();
    try { Promise.resolve(task.fn()).then(finish, finish); } catch { finish(); }
  }

  return {
    add(name, fn, { priority = 5 } = {}) { pending.push({ name, fn, priority, seq: seq++ }); next(); },
    release() { released = true; next(); },
    pendingNames: () => pending.slice().sort((a, b) => a.priority - b.priority || a.seq - b.seq).map((t) => t.name),
    ran: () => done.slice(),
  };
}

module.exports = { createStartupQueue };
