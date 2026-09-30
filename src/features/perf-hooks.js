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

  const api = {
    mark,
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
