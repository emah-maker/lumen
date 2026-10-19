// One MCP session working in several tabs: calls on DIFFERENT tabs run side by side, calls on the SAME tab run one after another
// (a click never overlaps another click or a type there). One queue per session (ai-agents.js mcpCallTool); a key is a tab id.
//   run(key, fn, signal) -> fn's result. key null: no queue, fn runs now. A call still waiting when `signal` aborts (the user
//   pressed Stop, the session ended) is dropped at once and never runs; a call that fails does not hold up the next one.
function createTabQueue() {
  const tails = new Map(); // key -> the promise of the last call queued on it
  function run(key, fn, signal = null) {
    if (key == null) return Promise.resolve().then(fn);
    const prev = tails.get(key) || Promise.resolve();
    let dropped = false;
    let onAbort = null;
    const result = new Promise((resolve, reject) => {
      if (signal?.aborted) { dropped = true; reject(new Error('Stopped by the user.')); return; }
      onAbort = () => { dropped = true; reject(new Error('Stopped by the user.')); };
      signal?.addEventListener('abort', onAbort, { once: true });
      prev.then(() => {
        signal?.removeEventListener('abort', onAbort);
        if (dropped) return;
        Promise.resolve().then(fn).then(resolve, reject);
      });
    });
    const tail = prev.then(() => result.catch(() => {}));
    tails.set(key, tail);
    tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return result;
  }
  return { run, size: () => tails.size };
}

module.exports = { createTabQueue };
