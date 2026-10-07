// Test-mode instrumentation for the performance budget (test/perf-budget.js, scripts/measure-perf.js):
// startup marks, how long each top-level require of main.js took, and which setInterval timers are
// still running. Installed by main.js only when CLAUDE_BROWSER_TEST is set on a development run, so a
// real Lumen never loads it.
const Module = require('module');
const path = require('path');

function install(mainFile) {
  const origin = typeof process.getCreationTime === 'function' ? process.getCreationTime() : Date.now() - process.uptime() * 1000;
  const marks = {};
  const mark = (name) => { marks[name] = Math.round(Date.now() - origin); };
  const requires = []; // { name, ms } for each require main.js makes itself (inclusive of what that module loads)
  const intervals = new Map(); // handle -> { ms, at }

  const realRequire = Module.prototype.require;
  let depth = 0;
  Module.prototype.require = function tracked(id) {
    if (this.filename !== mainFile || depth > 0) return realRequire.apply(this, arguments);
    depth++;
    const start = process.hrtime.bigint();
    try { return realRequire.apply(this, arguments); } finally {
      depth--;
      requires.push({ name: id, ms: Number(process.hrtime.bigint() - start) / 1e6 });
    }
  };

  const realSet = global.setInterval;
  const realClear = global.clearInterval;
  global.setInterval = function trackedInterval(fn, ms, ...rest) {
    const handle = realSet.call(this, fn, ms, ...rest);
    intervals.set(handle, { ms, at: (new Error().stack || '').split('\n')[2]?.trim() || '' });
    return handle;
  };
  global.clearInterval = function trackedClear(handle) {
    intervals.delete(handle);
    return realClear.call(this, handle);
  };

  // Event-loop delay of the main process (how long it stalled), and when each page's load events fired.
  const { monitorEventLoopDelay } = require('perf_hooks');
  const loop = monitorEventLoopDelay({ resolution: 5 });
  loop.enable();
  const loads = []; // { url, start, dom, finish } in ms since process creation, in creation order
  try {
    const { app } = require('electron');
    app.on('web-contents-created', (_e, wc) => {
      const rec = { id: wc.id, url: '', created: Math.round(Date.now() - origin) };
      loads.push(rec);
      const at = () => Math.round(Date.now() - origin);
      wc.on('did-start-navigation', (details) => { if (details.isMainFrame && /^https?:/.test(details.url)) { rec.url = details.url; rec.start ??= at(); } });
      wc.once('dom-ready', () => { rec.dom = at(); });
      wc.once('did-finish-load', () => { rec.finish = at(); });
    });
  } catch { /* not the main process */ }

  // LUMEN_CPU_PROFILE=1: a V8 CPU profile of the main process from the first line (stopProfile writes it).
  let inspectorSession = null;
  if (process.env.LUMEN_CPU_PROFILE) {
    try {
      inspectorSession = new (require('inspector').Session)();
      inspectorSession.connect();
      inspectorSession.post('Profiler.enable');
      inspectorSession.post('Profiler.setSamplingInterval', { interval: 500 });
      inspectorSession.post('Profiler.start');
    } catch { inspectorSession = null; }
  }

  const api = {
    mark,
    stopProfile: (file) => new Promise((resolve) => {
      if (!inspectorSession) { resolve(false); return; }
      inspectorSession.post('Profiler.stop', (err, { profile } = {}) => {
        if (!err) require('fs').writeFileSync(file, JSON.stringify(profile));
        resolve(!err);
      });
    }),
    loads: () => loads.map((l) => ({ ...l })),
    origin: () => origin,
    loopDelay: (reset = false) => { const r = { meanMs: Math.round(loop.mean / 1e5) / 10, p99Ms: Math.round(loop.percentile(99) / 1e5) / 10, maxMs: Math.round(loop.max / 1e5) / 10 }; if (reset) loop.reset(); return r; },
    marks: () => ({ ...marks }),
    requires: () => requires.map((r) => ({ ...r, ms: Math.round(r.ms * 10) / 10 })),
    requireTotalMs: () => Math.round(requires.reduce((s, r) => s + r.ms, 0)),
    // Modules loaded from this project (or its node_modules), as paths relative to `root`.
    modules: (root = path.join(__dirname, '..')) => {
      const base = `${root.replace(/\\/g, '/')}/`;
      return Object.keys(require.cache).map((f) => f.replace(/\\/g, '/')).filter((f) => f.startsWith(base) || f.includes('/node_modules/')).map((f) => (f.startsWith(base) ? f.slice(base.length) : f.slice(f.indexOf('/node_modules/') + 1)));
    },
    intervals: () => [...intervals.values()],
  };
  mark('mainStart');
  return api;
}

module.exports = { install };
