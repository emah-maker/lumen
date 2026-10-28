// [memory log] features/memory-log.js: Lumen's own memory to diagnostics/memory.jsonl every few minutes, kept small, a heap near its limit
// said once, and the newest sample as words for the "how the last run ended" line. Plain Node: no Electron.
const fs = require('fs');
const os = require('os');
const path = require('path');
const ml = require('../../src/features/memory-log');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memlog-units-'));
const diag = path.join(dir, 'diagnostics');
let t = Date.parse('2026-10-28T03:00:00Z');
let heap = 300;
const high = [];
const timers = [];
const log = ml.createMemoryLog({
  dir: () => diag, version: '0.5.80', now: () => t, startedAt: t,
  sample: () => ({ heapMb: heap, heapLimitMb: 4096, rssMb: heap + 120, extMb: 20, abMb: 5 }),
  onHigh: (text) => high.push(text),
  setInterval: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }, clearInterval: () => {},
});
log.start();
const file = path.join(diag, ml.FILE);
const lines = () => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
check('start: one sample at once, in a folder it makes, then every 5 minutes', fs.existsSync(file) && lines().length === 1 && timers.length === 1 && timers[0].ms === 5 * 60e3, JSON.stringify(timers));
const first = lines()[0];
check('sample: time, version, run age, heap and its limit, RSS, external and ArrayBuffer memory', first.t === '2026-10-28T03:00:00.000Z' && first.v === '0.5.80' && first.upMin === 0 && first.heapMb === 300 && first.heapLimitMb === 4096 && first.rssMb === 420 && first.extMb === 20 && first.abMb === 5, JSON.stringify(first));
log.start();
check('start twice: still one timer', timers.length === 1);
t += 60 * 60e3; heap = 2000; timers[0].fn();
check('a later sample says how long the run has been going', lines()[1].upMin === 60 && lines()[1].heapMb === 2000);
check('below 70% of the limit: nothing said', high.length === 0);
t += 60 * 60e3; heap = 3000; timers[0].fn();
t += 60 * 60e3; heap = 3500; timers[0].fn();
check('past 70% of the heap limit: said once, with the numbers', high.length === 1 && /JS heap 3000 MB of its 4096 MB limit after 120 min/.test(high[0]), JSON.stringify(high));
check('lastLine: the newest sample as words', ml.lastLine(diag) === ' The last memory sample (2026-10-28T06:00:00.000Z): JS heap 3500 MB of 4096 MB, RSS 3620 MB, after 180 min.', ml.lastLine(diag));
check('lastLine: no file, or a broken last line, is nothing', ml.lastLine(path.join(dir, 'none')) === '' && (() => { const d2 = path.join(dir, 'broken'); fs.mkdirSync(d2); fs.writeFileSync(path.join(d2, ml.FILE), '{"heapMb":1}\n{oops'); return ml.lastLine(d2) === ''; })());

// the file stays small: past MAX_BYTES its newest half is kept
for (let i = 0; i < 3000; i++) { t += 60e3; timers[0].fn(); }
const size = fs.statSync(file).size;
const kept = lines();
check('the file never grows past its limit, and keeps the newest samples', size <= ml.MAX_BYTES && kept.length > 100 && kept[kept.length - 1].t === new Date(t).toISOString(), `${size} ${kept.length}`);

// a failing sample or a folder that can't be written never throws out of the timer
const bad = ml.createMemoryLog({ dir: () => { throw new Error('no folder'); }, sample: () => { throw new Error('x'); }, setInterval: () => ({}) });
check('a failure is swallowed (diagnostics only)', bad.record() === null);

// the real reading has every field as a whole number of MB, and a limit
const real = ml.readSample();
check('readSample: real numbers from this process', ['heapMb', 'heapLimitMb', 'rssMb', 'extMb', 'abMb'].every((k) => Number.isInteger(real[k])) && real.heapLimitMb > 100 && real.rssMb > 0, JSON.stringify(real));

// main.js: started after the window, loaded lazily, high heap logged, the last-run line carries the sample
const main = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
check('main: started at launch, loaded a minute later (not a startup module), high heap to main-errors.log', /startMemoryLog\(\);\r?\n  createWindow\(\);/.test(main) && /require\('\.\/features\/memory-log'\)\.createMemoryLog\(\{[^}]*onHigh: \(text\) => logMainError\('memory-high', text\)/.test(main) && /: 60e3\);/.test(main));
check('main: the "how the last run ended" line ends with the last memory sample', /end\.text \+ require\('\.\/features\/memory-log'\)\.lastLine\(/.test(main));

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
