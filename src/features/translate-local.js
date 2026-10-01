// On-device translation, the main-process side: ties the model store (translate-models.js) to the
// translator process (translate-worker.js). Nothing here runs at startup: the process is started on the
// first translation (or when a page is offered and its language pack is already on disk), and it is shut
// down again after a couple of idle minutes. Page text goes to that process over a pipe and nowhere else.
//
// translate.js talks to the interface returned by createLocal():
//   plan(sourceCode, targetCode)  -> { route, steps, missing, total } | null    (registry codes; null: no model path)
//   ensure(route, { onProgress, signal })                                       download what is missing
//   translate(route, texts, { signal }) -> string[]                             same order and length
//   warm(route)  /  supports(src, tgt) -> true | false | null                   null: registry not read yet
const path = require('path');
const M = require('./translate-models');

const WORKER = path.join(__dirname, 'translate-worker.js');
const IDLE_MS = 2 * 60 * 1000;
const MAX_PAIRS = 4; // models kept loaded in one process; past this the process is replaced (the wasm heap never shrinks)
const REQUEST_MS = 90 * 1000;

class Cancelled extends Error {
  constructor() { super('cancelled'); this.name = 'Cancelled'; this.code = 'cancelled'; }
}

// How the worker is started. Electron: a utility process. Plain Node (tests): a child process.
// Both give { send, onMessage, onExit, kill }.
function electronFork(utilityProcess) {
  return () => {
    const child = utilityProcess.fork(WORKER, [], { serviceName: 'Lumen translation', stdio: 'ignore' });
    return { send: (m) => child.postMessage(m), onMessage: (cb) => child.on('message', cb), onExit: (cb) => child.once('exit', cb), kill: () => { try { child.kill(); } catch { /* gone */ } } };
  };
}
function nodeFork(childProcess) {
  return () => {
    const child = childProcess.fork(WORKER, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    return { send: (m) => child.send(m), onMessage: (cb) => child.on('message', cb), onExit: (cb) => child.once('exit', cb), kill: () => { try { child.kill(); } catch { /* gone */ } } };
  };
}

// deps: { store, fork, idleMs?, maxPairs? }
function createLocal({ store, fork, idleMs = IDLE_MS, maxPairs = MAX_PAIRS }) {
  let child = null;
  let nextId = 1;
  let idleTimer = null;
  const pending = new Map(); // id -> { resolve, reject, timer }
  const loaded = new Set(); // pair keys loaded in the current process
  const stats = { starts: 0, last: null };

  function failAll(err) {
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(err); pending.delete(id); }
  }
  function ensureChild() {
    if (child) return child;
    const mine = fork();
    child = mine;
    stats.starts++;
    mine.onMessage((msg) => {
      if (child !== mine || !msg) return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.type === 'result' || msg.type === 'ready') p.resolve(msg);
      else if (msg.type === 'cancelled') p.reject(new Cancelled());
      else p.reject(new Error(msg.message || 'The translation engine failed.'));
    });
    mine.onExit(() => {
      if (child === mine) { child = null; loaded.clear(); }
      failAll(new Error('The translation engine stopped.'));
    });
    return mine;
  }
  function stop() {
    clearTimeout(idleTimer);
    idleTimer = null;
    const old = child;
    child = null;
    loaded.clear();
    if (old) old.kill();
    failAll(new Error('The translation engine stopped.'));
  }
  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!pending.size) stop(); else touch(); }, idleMs);
    idleTimer.unref?.();
  }
  function request(msg, { signal, timeoutMs = REQUEST_MS } = {}) {
    if (signal?.aborted) return Promise.reject(new Cancelled());
    const mine = ensureChild();
    const id = nextId++;
    touch();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); stop(); reject(new Error('The translation engine took too long.')); }, timeoutMs);
      timer.unref?.();
      const done = (fn) => (v) => { signal?.removeEventListener?.('abort', onAbort); touch(); fn(v); };
      const onAbort = () => { if (pending.delete(id)) { clearTimeout(timer); mine.send({ type: 'cancel', id }); reject(new Cancelled()); } };
      pending.set(id, { resolve: done(resolve), reject: done(reject), timer });
      signal?.addEventListener?.('abort', onAbort, { once: true });
      mine.send({ ...msg, id });
    });
  }

  const supports = (from, to) => {
    const index = store.indexNow();
    return index ? Boolean(M.planRoute(from, to, index)) : null;
  };

  async function plan(from, to) {
    const index = await store.loadIndex();
    const route = M.planRoute(from, to, index);
    if (!route) return null;
    const have = store.installedSet();
    return {
      route,
      missing: M.missingBytes(route, index, have),
      total: route.reduce((n, [a, b]) => n + (index[M.pairKey(a, b)]?.bytes || 0), 0),
    };
  }

  // Download the pairs of `route` that aren't on disk. onProgress(fraction 0..1, receivedBytes, totalBytes).
  async function ensure(route, { onProgress, signal } = {}) {
    const index = await store.loadIndex();
    const todo = route.filter(([a, b]) => !store.isInstalled(a, b));
    if (!todo.length) return;
    const total = todo.reduce((n, [a, b]) => n + (index[M.pairKey(a, b)]?.bytes || 0), 0);
    const got = new Map();
    const report = () => { const r = [...got.values()].reduce((n, v) => n + v, 0); onProgress?.(total ? Math.min(1, r / total) : 1, r, total); };
    try {
      await Promise.all(todo.map(([a, b]) => store.download(a, b, { signal, onProgress: ({ received }) => { got.set(M.pairKey(a, b), received); report(); } })));
    } catch (err) {
      if (err instanceof M.DownloadCancelled || signal?.aborted) throw new Cancelled();
      throw err;
    }
  }

  function stepsFor(route) {
    return route.map(([from, to]) => {
      const files = store.filesOf(from, to);
      if (!files) throw new Error(`The ${from} to ${to} language pack is not installed.`);
      const { version, ...paths } = files;
      return { from, to, version, files: paths };
    });
  }
  function reserve(route) {
    const keys = route.map(([a, b]) => M.pairKey(a, b));
    if (child && [...new Set([...loaded, ...keys])].length > maxPairs) stop(); // too many models resident: start over
    for (const k of keys) loaded.add(k);
  }

  async function translate(route, texts, { signal } = {}) {
    if (!texts.length) return [];
    if (!route.length) return texts.slice();
    const steps = stepsFor(route);
    reserve(route);
    const res = await request({ type: 'translate', steps, texts }, { signal });
    stats.last = { loadMs: res.loadMs, inferMs: res.inferMs, texts: texts.length, chars: texts.reduce((n, t) => n + t.length, 0) };
    return res.texts;
  }
  // The route if every pair of it is on disk, judged without the network; else null.
  function readyRoute(from, to) {
    const index = store.indexNow();
    const route = index ? M.planRoute(from, to, index) : null;
    return route?.length && route.every(([a, b]) => store.isInstalled(a, b)) ? route : null;
  }
  // Start the engine (and load the models of `route`) before the first request, so it answers at once.
  async function warm(route) {
    let steps = [];
    if (route?.length) { try { steps = stepsFor(route); } catch { return; } reserve(route); }
    try { await request({ type: 'warm', steps }); } catch { /* it starts on first use anyway */ }
  }

  // ---- the settings page: what is installed, what could be (codes here are Lumen's, 'zh-CN' not 'zh-Hans') ----
  // `codes`: the languages the page offers. A language's packs are its two halves with English, so any pair
  // of installed languages works through English.
  const halves = (code, index) => {
    const m = M.modelCode(code);
    return [[m, M.PIVOT], [M.PIVOT, m]].filter(([a, b]) => index?.[M.pairKey(a, b)]);
  };
  async function overview(codes) {
    let index = null;
    let error = '';
    try { index = await store.loadIndex(); } catch (err) { index = store.indexNow(); error = String(err?.message || err).slice(0, 160); }
    const have = store.installedSet();
    const languages = [];
    for (const code of codes) {
      if (code === M.PIVOT) continue;
      const pairs = halves(code, index);
      if (!pairs.length) continue;
      languages.push({
        code,
        bytes: pairs.reduce((n, [a, b]) => n + index[M.pairKey(a, b)].bytes, 0),
        missing: pairs.reduce((n, [a, b]) => n + (have.has(M.pairKey(a, b)) ? 0 : index[M.pairKey(a, b)].bytes), 0),
      });
    }
    return {
      installed: store.installed().map((p) => ({ from: M.lumenCode(p.from), to: M.lumenCode(p.to), bytes: p.bytes, version: p.version })),
      used: store.usedBytes(),
      languages,
      error,
      downloading: store.downloading(),
    };
  }
  async function downloadLanguage(code, options) {
    const index = await store.loadIndex();
    const pairs = halves(code, index);
    if (!pairs.length) throw new Error(`No language pack for ${code}.`);
    await ensure(pairs, options);
  }
  const removePair = (from, to) => store.remove(M.modelCode(from), M.modelCode(to));
  const cancelDownloads = () => { for (const key of store.downloading()) { const [a, b] = key.split('>'); store.cancel(a, b); } };

  return { plan, ensure, translate, warm, readyRoute, supports, overview, downloadLanguage, removePair, removeAll: () => store.removeAll(), cancelDownloads, stop, stats: () => ({ ...stats, running: Boolean(child) }), store, Cancelled };
}

module.exports = { createLocal, electronFork, nodeFork, Cancelled, WORKER };
