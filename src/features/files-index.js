// The Files indexer, main-thread side: a handle on files-index-worker.js. It posts a job and awaits a short answer; the walking,
// the ranking and the stat calls all happen in the worker thread. Each pinned folder is indexed when it is pinned (and when Lumen
// starts, a few seconds after the window is up) and again every 10 minutes while Lumen is open: depth 4, at most 20,000 files a pin.
//
//   createIndexer({ Worker, workerFile, every })
//   .setRoots(folders)       the pinned folders: new ones are indexed now, gone ones dropped, the timer runs while there are any
//   .index(root)             -> Promise<{ count, truncated }>
//   .search(query, opts)     -> Promise<[{ path, name, root, size, mtime }]>   (fuzzy over what is indexed)
//   .find({ path, size })    -> Promise<[{ path, name, size, mtime }]>          (candidates for a moved file)
//   .scan({ roots, query })  -> Promise<hits>                                   (the slow, fresh walk; counted in .stats)
//   .stats                   { index, search, find, scan }: how many of each job ran (tests assert the slow path was not taken)
//   .close()
// The worker is started on the first job and ends after a minute without one unless folders are pinned (then it keeps the index).
const path = require('path');

const EVERY = 10 * 60 * 1000;
const IDLE = 60 * 1000;

function createIndexer({ Worker = require('worker_threads').Worker, workerFile = path.join(__dirname, 'files-index-worker.js'), every = EVERY, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let worker = null;
  let nextId = 1;
  const waiting = new Map();
  let roots = new Set();
  let timer = null;
  let idle = null;
  let started = false;
  const stats = { index: 0, search: 0, find: 0, scan: 0 };

  function fail(error) { for (const w of waiting.values()) w.reject(new Error(error)); waiting.clear(); }
  function start() {
    if (worker) return worker;
    const w = new Worker(workerFile);
    worker = w;
    w.on('message', (m) => {
      const p = waiting.get(m.id);
      if (!p) return;
      waiting.delete(m.id);
      if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
      armIdle();
    });
    w.on('error', (err) => { if (worker === w) worker = null; fail(String(err?.message || err)); });
    w.on('exit', () => { if (worker === w) { worker = null; fail('the indexer stopped'); } });
    w.unref?.();
    const again = started;
    started = true;
    // A worker started again after one ended knows nothing: the pinned folders are indexed again in the background.
    if (again && roots.size) setImmediate(() => { for (const r of roots) call('index', { root: r, depth: 4, cap: 20000 }).catch(() => {}); });
    return w;
  }
  function armIdle() {
    clearTimeout(idle);
    if (roots.size || waiting.size) return;
    idle = setTimeout(() => { if (!roots.size && !waiting.size) close(); }, IDLE);
    idle.unref?.();
  }
  function call(type, payload) {
    stats[type]++;
    return new Promise((resolve, reject) => {
      let w;
      try { w = start(); } catch (err) { reject(err); return; }
      const id = nextId++;
      waiting.set(id, { resolve, reject });
      w.postMessage({ id, type, ...payload });
    });
  }
  function close() {
    clearTimeout(idle);
    if (timer) { clearTimer(timer); timer = null; }
    const w = worker;
    worker = null;
    fail('the indexer was closed');
    if (w) w.terminate().catch?.(() => {});
  }

  return {
    stats,
    index: (root) => call('index', { root, depth: 4, cap: 20000 }),
    setRoots(folders) {
      const next = new Set(folders);
      for (const r of roots) if (!next.has(r) && worker) call('drop', { root: r }).catch(() => {});
      const fresh = [...next].filter((r) => !roots.has(r));
      roots = next;
      for (const r of fresh) call('index', { root: r, depth: 4, cap: 20000 }).catch(() => {});
      if (roots.size && !timer) { timer = setTimer(() => { for (const r of roots) call('index', { root: r, depth: 4, cap: 20000 }).catch(() => {}); }, every); timer.unref?.(); }
      if (!roots.size && timer) { clearTimer(timer); timer = null; armIdle(); }
    },
    search: (query, { limit = 30, loose = false } = {}) => (roots.size ? call('search', { query, limit, loose }) : Promise.resolve([])),
    find: ({ path: p, size }) => call('find', { dir: path.dirname(p), name: path.basename(p), size: size || 0 }),
    scan: ({ roots: dirs, query, ...rest }) => call('scan', { roots: dirs, query, ...rest }),
    close,
  };
}

module.exports = { createIndexer, EVERY };
