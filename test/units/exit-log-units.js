// exit-log: why Lumen closed by itself (features/exit-log.js) and the crash marker's start time (features/crash-recovery.js). Plain Node.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { goneText, listDumps, prune, lastRunEnd } = require('../../src/features/exit-log');
const CR = require('../../src/features/crash-recovery');
let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-exitlog-'));
const dumps = path.join(root, 'crashes');
const dump = (name, mtimeMs) => {
  const f = path.join(dumps, 'reports', name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'MDMP');
  fs.utimesSync(f, mtimeMs / 1000, mtimeMs / 1000);
  return f;
};

// one line per process that ended
check('a GPU process lost to a driver reset reads as such', goneText({ type: 'GPU', reason: 'crashed', exitCode: 34 }) === 'GPU crashed, exit 34', goneText({ type: 'GPU', reason: 'crashed', exitCode: 34 }));
check('a page process (no type) is a renderer', goneText({ reason: 'oom', exitCode: -536870904 }) === 'renderer oom, exit -536870904', goneText({ reason: 'oom', exitCode: -536870904 }));
check('a utility process says which one', goneText({ type: 'Utility', name: 'Network Service', reason: 'crashed', exitCode: 1 }) === 'Utility (Network Service) crashed, exit 1', '');
check('missing details do not throw', goneText(undefined) === 'renderer unknown, exit ?' && goneText({ exitCode: NaN }) === 'renderer unknown, exit ?', goneText(undefined));

// how the last run ended
const now = Date.UTC(2026, 9, 27, 12, 0, 0);
const began = now - 3 * 3600e3; // that run began three hours ago
{
  const r = lastRunEnd({ startedAtMs: began, dir: dumps, now, uptimeSec: 3600 }); // the computer started an hour ago: after that run began
  check('a computer that restarted under Lumen is told apart from a Lumen crash', r.kind === 'system-restart' && /computer restarted/.test(r.text), JSON.stringify(r));
}
{
  const r = lastRunEnd({ startedAtMs: began, dir: dumps, now, uptimeSec: 86400 }); // up all day, no report
  check('no restart and no report: ended without quitting', r.kind === 'ended' && r.dumps === 0, JSON.stringify(r));
}
dump('old.dmp', began - 60e3); // from a run before
{
  const r = lastRunEnd({ startedAtMs: began, dir: dumps, now, uptimeSec: 86400 });
  check('a report older than that run does not count', r.kind === 'ended' && r.dumps === 0, JSON.stringify(r));
}
dump('new.dmp', began + 60e3);
{
  const r = lastRunEnd({ startedAtMs: began, dir: dumps, now, uptimeSec: 86400 });
  check('a report written during that run: Lumen crashed', r.kind === 'lumen-crashed' && r.dumps === 1 && /1 crash report/.test(r.text), JSON.stringify(r));
}
check('an unknown start time does not throw', lastRunEnd({ startedAtMs: null, dir: dumps, now, uptimeSec: 10 }).kind === 'ended', '');

// the folder stays small
for (let i = 0; i < 14; i++) dump(`n${i}.dmp`, now - i * 1000);
check('reports are listed newest first', listDumps(dumps)[0].file.endsWith('n0.dmp'), listDumps(dumps).map((d) => path.basename(d.file)).join(','));
const removed = prune(dumps, { keep: 10 });
const left = listDumps(dumps).map((d) => path.basename(d.file));
check('prune keeps the newest ten and removes the rest', removed === 6 && left.length === 10 && left.includes('n0.dmp') && !left.includes('old.dmp'), `${removed} ${left.join(',')}`);
check('a missing folder is fine', prune(path.join(root, 'none')) === 0 && listDumps(path.join(root, 'none')).length === 0, '');

// the crash marker gives the start time of the run that left it
{
  const file = path.join(root, 'running');
  const settings = { session: { urls: ['https://a.example/'] } };
  const first = CR.createCrashRecovery({ file: () => file, readSettings: () => settings });
  first.begin({ mode: 'last' });
  check('a first start has no last start time', first.lastStart() === null, String(first.lastStart()));
  fs.utimesSync(file, began / 1000, began / 1000); // that run began then and never quit
  const second = CR.createCrashRecovery({ file: () => file, readSettings: () => settings });
  second.begin({ mode: 'last' });
  check('after a run that never quit, its start time is the marker time', second.crashed() && Math.abs(second.lastStart() - began) < 2000, String(second.lastStart()));
}

fs.rmSync(root, { recursive: true, force: true });
if (failures) { console.log(`${failures} failed`); process.exit(1); }
console.log('all passed');
