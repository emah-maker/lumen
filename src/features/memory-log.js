// How much memory Lumen's own process used over a run, so a close that left no trace (no quit, no crash report) can be read afterwards:
// a heap that climbed to its limit (Electron's V8 heap cage is about 4 GB) shows as a rising line, a machine that went away does not.
// - One sample every few minutes to <userData>/diagnostics/memory.jsonl: the JS heap, its limit, RSS, external and ArrayBuffer memory,
//   the run's age. Cheap (process.memoryUsage and v8 heap statistics: no getAppMetrics, no disk read).
// - The file stays small: past MAX_BYTES only its newest half is kept.
// - A heap past HIGH_SHARE of its limit is said once per run in main-errors.log (main.js onHigh), while there is still time to see it.
// - lastLine(): the newest sample, for the "how the last run ended" line (features/exit-log.js lastRunEnd, main.js).
// Started a minute after the window is up and loaded then, not at startup (test/e2e/perf-budget.js counts startup modules).
'use strict';

const nodeFs = require('fs');
const path = require('path');

const FILE = 'memory.jsonl';
const INTERVAL_MS = 5 * 60e3;
const MAX_BYTES = 256 * 1024;
const HIGH_SHARE = 0.7;
const MB = 1024 * 1024;

const mb = (n) => Math.round((Number(n) || 0) / MB);

// One sample from what the process reports: { heapMb, heapLimitMb, rssMb, extMb, abMb }.
function readSample({ memoryUsage = () => process.memoryUsage(), heapStats = () => require('v8').getHeapStatistics() } = {}) {
  const m = memoryUsage();
  const h = heapStats();
  return { heapMb: mb(m.heapUsed), heapLimitMb: mb(h.heap_size_limit), rssMb: mb(m.rss), extMb: mb(m.external), abMb: mb(m.arrayBuffers) };
}

// deps: dir() (the diagnostics folder), version, now, startedAt, sample() (readSample), onHigh(text), fs, setInterval, clearInterval
function createMemoryLog(deps = {}) {
  const fs = deps.fs || nodeFs;
  const now = deps.now || Date.now;
  const startedAt = deps.startedAt ?? now();
  const sample = deps.sample || (() => readSample());
  const every = deps.setInterval || setInterval;
  const stopEvery = deps.clearInterval || clearInterval;
  let timer = null;
  let warned = false;

  const fileOf = () => path.join(deps.dir(), FILE);
  function keepSmall(file) {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size <= MAX_BYTES) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(file, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`); // (the newest half)
  }
  function record() {
    try {
      const s = sample();
      const line = { t: new Date(now()).toISOString(), v: String(deps.version || ''), upMin: Math.round((now() - startedAt) / 60e3), ...s };
      const dir = deps.dir();
      fs.mkdirSync(dir, { recursive: true });
      const file = fileOf();
      fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
      keepSmall(file);
      if (!warned && s.heapLimitMb > 0 && s.heapMb >= s.heapLimitMb * HIGH_SHARE) {
        warned = true;
        deps.onHigh?.(`Lumen's memory is high: JS heap ${s.heapMb} MB of its ${s.heapLimitMb} MB limit after ${line.upMin} min (RSS ${s.rssMb} MB)`);
      }
      return line;
    } catch { return null; } // (diagnostics only: never an error out of a timer)
  }
  return {
    record,
    start() {
      if (timer) return;
      record();
      timer = every(record, deps.intervalMs || INTERVAL_MS);
      timer?.unref?.();
    },
    stop() { if (timer) stopEvery(timer); timer = null; },
  };
}

// The newest sample in the folder, as words: " The last memory sample (…): JS heap 3900 MB of 4096 MB, RSS 4300 MB, after 560 min." or ''.
function lastLine(dir, fs = nodeFs) {
  try {
    const text = fs.readFileSync(path.join(dir, FILE), 'utf8');
    const last = text.trimEnd().split('\n').pop();
    const s = JSON.parse(last);
    if (!Number.isFinite(s.heapMb)) return '';
    return ` The last memory sample (${s.t}): JS heap ${s.heapMb} MB of ${s.heapLimitMb} MB, RSS ${s.rssMb} MB, after ${s.upMin} min.`;
  } catch { return ''; }
}

module.exports = { createMemoryLog, readSample, lastLine, FILE, INTERVAL_MS, MAX_BYTES, HIGH_SHARE };
