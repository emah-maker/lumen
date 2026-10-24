// The Windows update swap's journal and crash recovery (features/swap-helper.js). Plain Node, realpath'd temp folders only; nothing real is swapped.
// A "crash" is real: a child process runs the swap and ends itself (process.exit) at a chosen rename, exactly as Windows ending the
// detached helper at logoff would, and recover() then has only what that left on disk.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });

const helperPath = path.join(__dirname, '..', '..', 'src', 'features', 'swap-helper.js');
const H = require(helperPath);

// realpath: the CI runners' temp folders are 8.3 (RUNNER~1) or /private/var symlinks, and the journal compares paths as written
const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-journal-unit-')));
const at = (...p) => path.join(d, ...p);
const mk = (rel, text) => { fs.mkdirSync(path.dirname(at(rel)), { recursive: true }); fs.writeFileSync(at(rel), text); };
const read = (rel) => { try { return fs.readFileSync(at(rel), 'utf8'); } catch { return null; } };
const fixture = () => {
  rm(d); fs.mkdirSync(d, { recursive: true });
  mk('Lumen/Lumen.exe', 'MZ old'); mk('Lumen/resources/a.bin', 'old');
  mk('Lumen.update/files/Lumen.exe', 'MZ new'); mk('Lumen.update/files/resources/a.bin', 'new'); mk('Lumen.update/staged.json', '{}');
};
const opts = (extra = {}) => ({ pid: 2 ** 22 + 1, dir: at('Lumen'), root: at('Lumen.update', 'files'), old: at('Lumen.old'), staging: at('Lumen.update'), exe: at('Lumen', 'Lumen.exe'), errFile: at('err.txt'), minBytes: 1, waitMs: 2000, lockMs: 1500, ...extra });
const JOURNAL = at('Lumen.swap.journal');
const journal = () => { try { return JSON.parse(fs.readFileSync(JOURNAL, 'utf8')); } catch { return null; } };

// Runs the swap in a child that ends itself when `crashOn` (a path) is renamed FROM; `lock` (a path) makes renames of that path fail
// as if something had files open in it (so the swap goes entry by entry).
const CHILD = `
const fs = require('fs');
const [helper, optsJson, crashOn, lock] = process.argv.slice(2);
const real = fs.renameSync;
fs.renameSync = (a, b) => {
  if (lock && a === lock) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
  if (crashOn && a === crashOn) process.exit(137);
  return real(a, b);
};
require(helper).swap(JSON.parse(optsJson), () => {}).then((r) => { console.log(r); process.exit(0); });
`;
const crashedSwap = (crashOn, lock = '', extra = {}) => {
  const script = at('..', `child-${path.basename(d)}.js`);
  fs.writeFileSync(script, CHILD);
  try {
    const r = spawnSync(process.execPath, [script, helperPath, JSON.stringify(opts(extra)), crashOn || '', lock || ''], { encoding: 'utf8', timeout: 20000 });
    return r.status;
  } finally { rm(script); }
};
const dead = () => false; // no helper is running

(async () => {
  // ---- the journal exists before the first rename, and is gone after a swap that completes
  fixture();
  {
    const real = fs.renameSync;
    let seen = null;
    fs.renameSync = (a, b) => { if (a === at('Lumen') && seen === null) seen = journal(); return real(a, b); };
    let r;
    try { r = await H.swap(opts(), () => {}); } finally { fs.renameSync = real; }
    check('swap: the journal is written before the first rename (phase, paths)', seen && seen.phase === 'folder-old' && seen.dir === at('Lumen') && seen.root === at('Lumen.update', 'files') && seen.old === at('Lumen.old') && seen.helperPid === process.pid, JSON.stringify(seen));
    check('swap: a finished swap deletes the journal (and leaves no temp file)', r === 'swapped' && read('Lumen/Lumen.exe') === 'MZ new' && !fs.existsSync(JOURNAL) && !fs.existsSync(`${JOURNAL}.tmp`), `${r} ${fs.readdirSync(d)}`);
  }
  check('journalPath: next to the install, named after it (main.js builds the same name)', H.journalPath(at('Lumen')) === JOURNAL && /basename\(dir\) \+ '\.swap\.journal'/.test(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8')), H.journalPath(at('Lumen')));

  // ---- a swap that keeps the old version (the new folder can't move in) leaves no journal either
  fixture();
  {
    const real = fs.renameSync;
    fs.renameSync = (a, b) => { if (a === at('Lumen.update', 'files')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return real(a, b); };
    let r;
    try { r = await H.swap(opts({ lockMs: 400 }), () => {}); } finally { fs.renameSync = real; }
    check('swap: the new folder can\'t move in -> old install back, the error written, journal deleted', r === 'kept' && read('Lumen/Lumen.exe') === 'MZ old' && fs.existsSync(at('err.txt')) && !fs.existsSync(JOURNAL), `${r} ${fs.readdirSync(d)}`);
  }

  // ---- killed between the two renames: no install folder; the staged update is complete, so recovery finishes the swap
  fixture();
  {
    const status = crashedSwap(at('Lumen.update', 'files'));
    const j = journal();
    check('crash between the renames: the install folder is gone and the journal says so', status === 137 && !fs.existsSync(at('Lumen')) && fs.existsSync(at('Lumen.old', 'Lumen.exe')) && j && j.phase === 'folder-new', `${status} ${fs.readdirSync(d)} ${JSON.stringify(j)}`);
    check('recover: while the helper is alive it does nothing (busy)', H.recover(JOURNAL, { isAlive: () => true }) === 'busy' && !fs.existsSync(at('Lumen')), '');
    check('recover: a journal older than 5 minutes is not a running helper, even if its pid is alive', (() => { const r = H.recover(JOURNAL, { isAlive: () => true, now: Date.now() + 6 * 60e3 }); return r === 'finished'; })(), '');
    check('recover: staging complete -> finished forward: the new version is the install, the journal is gone', read('Lumen/Lumen.exe') === 'MZ new' && read('Lumen/resources/a.bin') === 'new' && !fs.existsSync(JOURNAL) && !fs.existsSync(at('err.txt')), fs.readdirSync(d).join());
  }

  // ---- killed between the renames with the staged exe missing/too small: roll back from .old
  fixture();
  {
    crashedSwap(at('Lumen.update', 'files'));
    fs.writeFileSync(at('Lumen.update', 'files', 'Lumen.exe'), ''); // (minBytes is 1: an empty exe is an incomplete one)
    const r = H.recover(JOURNAL, { isAlive: dead });
    check('recover: staging incomplete -> rolled back from .old, with the reason in the error file for Settings', r === 'rolled-back' && read('Lumen/Lumen.exe') === 'MZ old' && read('Lumen/resources/a.bin') === 'old' && !fs.existsSync(JOURNAL) && read('err.txt').trim() === H.MESSAGE_INTERRUPTED, `${r} ${fs.readdirSync(d)}`);
  }
  fixture();
  {
    crashedSwap(at('Lumen.update', 'files'));
    rm(at('Lumen.update')); // (staging was cleaned up as well)
    const r = H.recover(JOURNAL, { isAlive: dead });
    check('recover: staging gone -> rolled back from .old', r === 'rolled-back' && read('Lumen/Lumen.exe') === 'MZ old', `${r} ${fs.readdirSync(d)}`);
  }
  fixture();
  {
    crashedSwap(at('Lumen.update', 'files'));
    rm(at('Lumen.update')); rm(at('Lumen.old'));
    check('recover: nothing left to restore from -> "lost", the journal is kept', H.recover(JOURNAL, { isAlive: dead }) === 'lost' && fs.existsSync(JOURNAL), '');
  }

  // ---- killed before the first rename: the install is untouched, so the journal is just removed
  fixture();
  {
    const status = crashedSwap(at('Lumen'));
    check('crash before any rename: the journal is there, the install untouched', status === 137 && journal()?.phase === 'folder-old' && read('Lumen/Lumen.exe') === 'MZ old', `${status} ${fs.readdirSync(d)}`);
    check('recover: the install is in place -> stale, journal removed, nothing changed', H.recover(JOURNAL, { isAlive: dead }) === 'stale' && !fs.existsSync(JOURNAL) && read('Lumen/Lumen.exe') === 'MZ old' && fs.existsSync(at('Lumen.update', 'files', 'Lumen.exe')), '');
  }

  // ---- the entry-by-entry path (the install folder is locked) is journaled and finishes cleanly
  fixture();
  {
    const status = crashedSwap('', at('Lumen'));
    check('entries: a locked install folder is swapped entry by entry, and the journal is deleted when it is done', status === 0 && read('Lumen/Lumen.exe') === 'MZ new' && read('Lumen/resources/a.bin') === 'new' && read('Lumen.old/Lumen.exe') === null && !fs.existsSync(JOURNAL), `${status} ${fs.readdirSync(d)}`);
  }

  // ---- entries, killed while the old entries are moving out: staging is complete, so recovery goes forward
  fixture();
  {
    const status = crashedSwap(at('Lumen', 'resources'), at('Lumen'));
    const j = journal();
    check('entries crash while moving out: the journal has the phase, the mode and the moves so far', status === 137 && j && j.mode === 'entries' && j.phase === 'to-old' && j.moves.some(([, to]) => to === at('Lumen.old', 'Lumen.exe')), `${status} ${JSON.stringify(j)}`);
    const r = H.recover(JOURNAL, { isAlive: dead });
    check('recover (entries, moving out, staging complete): finished forward', r === 'finished' && read('Lumen/Lumen.exe') === 'MZ new' && read('Lumen/resources/a.bin') === 'new' && !fs.existsSync(JOURNAL), `${r} ${fs.readdirSync(d)}`);
  }

  // ---- ...with the staged exe missing: rolled back, every entry where it was
  fixture();
  {
    crashedSwap(at('Lumen', 'resources'), at('Lumen'));
    fs.writeFileSync(at('Lumen.update', 'files', 'Lumen.exe'), '');
    const r = H.recover(JOURNAL, { isAlive: dead });
    check('recover (entries, moving out, staging incomplete): every entry put back, the error file written', r === 'rolled-back' && read('Lumen/Lumen.exe') === 'MZ old' && read('Lumen/resources/a.bin') === 'old' && fs.existsSync(at('err.txt')) && !fs.existsSync(JOURNAL), `${r} ${fs.readdirSync(d)} ${read('Lumen/Lumen.exe')}`);
  }

  // ---- entries, killed while the new entries are moving in: always forward
  fixture();
  {
    const status = crashedSwap(at('Lumen.update', 'files', 'resources'), at('Lumen'));
    const j = journal();
    check('entries crash while moving in: phase to-new, the install holds only some of the new entries', status === 137 && j?.phase === 'to-new' && read('Lumen/Lumen.exe') === 'MZ new' && read('Lumen/resources/a.bin') === null, `${status} ${JSON.stringify(j)}`);
    const r = H.recover(JOURNAL, { isAlive: dead });
    check('recover (entries, moving in): finished forward', r === 'finished' && read('Lumen/resources/a.bin') === 'new' && !fs.existsSync(JOURNAL), `${r} ${fs.readdirSync(d)}`);
  }

  // ---- a damaged journal is dropped, not trusted
  fixture();
  fs.writeFileSync(JOURNAL, '{"version":1,"dir":');
  check('recover: an unreadable journal is deleted and nothing is touched', H.recover(JOURNAL, { isAlive: dead }) === 'none' && !fs.existsSync(JOURNAL) && read('Lumen/Lumen.exe') === 'MZ old', '');
  check('recover: no journal -> none', H.recover(JOURNAL) === 'none', '');

  // ---- by hand: node swap-helper.js recover <journal>
  fixture();
  crashedSwap(at('Lumen.update', 'files'));
  {
    const r = spawnSync(process.execPath, [helperPath, 'recover', JOURNAL], { encoding: 'utf8', timeout: 20000 });
    check('recover by hand (swap-helper.js recover <journal>): exits 0 and prints the result', r.status === 0 && r.stdout.trim() === 'finished' && read('Lumen/Lumen.exe') === 'MZ new', `${r.status} ${r.stdout} ${r.stderr}`);
  }

  rm(d);
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
