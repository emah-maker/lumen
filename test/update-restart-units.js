// "Restart to update" must not keep the user waiting (plain Node, temp folders only, nothing real is swapped).
// The wait between Lumen exiting and the new Lumen starting is the swap helper's: it polls the old pid in short steps,
// retries a locked rename in short steps for a bounded time, runs nothing slow (deleting the old install) before the new
// Lumen starts, and the helper copy of the exe is ready (and re-made if a temp cleaner took it) before the click.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });

const helperPath = path.join(__dirname, '..', 'src', 'features', 'swap-helper.js');
const H = require(helperPath);
const Z = require('../src/features/zip-update');
const swap = (o, start) => H.swap(o, start);

(async () => {
  // ---- no long fixed waits: every sleep in the helper is a short poll
  const src = fs.readFileSync(helperPath, 'utf8').replace(/\/\/.*$/gm, '');
  const literalSleeps = [...src.matchAll(/sleep\((\d[\d_.e]*)\)/g)].map((m) => Number(m[1]));
  check('swap helper: no sleep with a fixed length over 250 ms', literalSleeps.every((n) => n <= 250), JSON.stringify(literalSleeps));
  check('swap helper: the pid poll and the lock retry steps are 250 ms or less', H.POLL_MS <= 250 && H.RETRY_MS <= 250 && H.POLL_MS <= 100, `${H.POLL_MS} ${H.RETRY_MS}`);
  check('swap helper: the total a locked folder can cost is bounded (10 s) and the wait for Lumen to quit too (60 s)', H.LOCK_WAIT_MS <= 10e3 && /waitMs \?\? 60e3/.test(src), String(H.LOCK_WAIT_MS));

  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-restart-unit-'));
  const mk = (rel, text) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); };
  const fixture = () => { rm(d); fs.mkdirSync(d, { recursive: true }); mk('Lumen/Lumen.exe', 'MZ old'); mk('Lumen/resources/a.bin', 'old'); mk('Lumen.update/files/Lumen.exe', 'MZ new'); mk('Lumen.update/staged.json', '{}'); };
  const opts = (pid, extra = {}) => ({ pid, dir: path.join(d, 'Lumen'), root: path.join(d, 'Lumen.update', 'files'), old: path.join(d, 'Lumen.old'), staging: path.join(d, 'Lumen.update'), exe: path.join(d, 'Lumen', 'Lumen.exe'), errFile: path.join(d, 'err.txt'), minBytes: 1, waitMs: 5000, lockMs: 2000, ...extra });

  // ---- from the old Lumen exiting to the new one starting: well under a second, and the old install is still there at that moment
  fixture();
  {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)'], { stdio: 'ignore' });
    const exited = new Promise((r) => child.once('exit', () => r(Date.now())));
    let startedAt = 0, oldThere = null;
    const done = swap(opts(child.pid), () => { startedAt = Date.now(); oldThere = fs.existsSync(path.join(d, 'Lumen.old')); });
    const r = await done;
    const exitAt = await exited;
    check('swap: it swaps once the old process is gone', r === 'swapped' && fs.readFileSync(path.join(d, 'Lumen', 'Lumen.exe'), 'utf8') === 'MZ new', r);
    check('swap: the new Lumen starts within 400 ms of the old one exiting (the poll is not a long sleep)', startedAt - exitAt < 400 && startedAt > 0, `${startedAt - exitAt} ms`);
    check('swap: the new Lumen starts before the old install is deleted (cleanup is not on the user\'s clock)', oldThere === true, String(oldThere));
    check('swap: ...and the old install and the staging folder are gone afterwards', !fs.existsSync(path.join(d, 'Lumen.old')) && !fs.existsSync(path.join(d, 'Lumen.update')), fs.readdirSync(d).join());
  }

  // ---- a stale Lumen.old left by an earlier update no longer costs a delete before the swap
  fixture();
  mk('Lumen.old/Lumen.exe', 'MZ ancient'); mk('Lumen.old/resources/x.bin', 'ancient');
  {
    let oldAtStart = null;
    const r = await swap(opts(2 ** 22 + 1), () => { oldAtStart = fs.existsSync(path.join(d, 'Lumen.old')) && fs.readFileSync(path.join(d, 'Lumen.old', 'Lumen.exe'), 'utf8'); });
    check('swap: a stale Lumen.old is moved aside, the swap still works, and nothing is left behind', r === 'swapped' && oldAtStart === 'MZ old' && fs.readdirSync(d).join() === 'Lumen', `${r} ${oldAtStart} ${fs.readdirSync(d).join()}`);
  }

  // ---- a locked install folder (a child process still has files open): short retries, so the swap goes ahead right after it lets go
  const realRename = fs.renameSync;
  const lockedUntil = (ms, onlyFrom) => { const end = Date.now() + ms; fs.renameSync = (a, b) => { if ((a === onlyFrom || String(a).startsWith(onlyFrom + path.sep)) && Date.now() < end) { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; } return realRename(a, b); }; return end; };
  try {
    fixture();
    const end = lockedUntil(1300, path.join(d, 'Lumen'));
    let startedAt = 0;
    const r = await swap(opts(2 ** 22 + 1), () => { startedAt = Date.now(); });
    check('swap: a folder locked for 1.3 s is swapped within 250 ms of being released', r === 'swapped' && startedAt >= end - 5 && startedAt - end < 250, `${r} ${startedAt - end} ms after release`);

    fixture();
    lockedUntil(60e3, path.join(d, 'Lumen'));
    const t0 = Date.now();
    let started = 0;
    const r2 = await swap(opts(2 ** 22 + 1, { lockMs: 800 }), () => { started++; });
    const took = Date.now() - t0;
    check('swap: a folder that stays locked gives up after the bound (not 10 retries of a second), keeps the old version, relaunches it and writes the error', r2 === 'kept' && took >= 700 && took < 1300 && started === 1 && fs.readFileSync(path.join(d, 'Lumen', 'Lumen.exe'), 'utf8') === 'MZ old' && /files were in use/.test(fs.readFileSync(path.join(d, 'err.txt'), 'utf8')), `${r2} ${took} ms ${started}`);
    fs.rmSync(path.join(d, 'err.txt'), { force: true });

    // rollback: the staged folder can't move in, so the old install is put back
    fixture();
    fs.renameSync = (a, b) => { if (a === path.join(d, 'Lumen.update', 'files')) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; } return realRename(a, b); };
    started = 0;
    const t1 = Date.now();
    const r3 = await swap(opts(2 ** 22 + 1, { lockMs: 600 }), () => { started++; });
    check('swap: if the new folder can\'t move in, the old install is put back, relaunched, with the error file', r3 === 'kept' && fs.readFileSync(path.join(d, 'Lumen', 'Lumen.exe'), 'utf8') === 'MZ old' && fs.existsSync(path.join(d, 'err.txt')) && started === 1 && Date.now() - t1 < 2500, `${r3} ${Date.now() - t1} ms`);
  } finally { fs.renameSync = realRename; }

  // ---- the helper copy of the exe is ready before the click, and re-made when it has gone
  {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-helperready-unit-'));
    const exe = path.join(base, 'Lumen.exe');
    fs.writeFileSync(exe, 'MZ');
    const a = await Z.prepareHelperAsync(exe, base);
    check('helper: the exe copy and the script are made without blocking (async), in their own folder', fs.existsSync(a.exe) && fs.existsSync(a.script) && path.dirname(a.exe) === a.dir, JSON.stringify(a));
    check('helper: helperReady says yes for a prepared copy and no once a temp cleaner removed it', Z.helperReady(a) === true && (rm(a.dir), Z.helperReady(a)) === false && Z.helperReady(null) === false, '');
    const spawned = [];
    Z.launchSwap({ staged: { dir: path.join(base, 'Lumen'), root: path.join(base, 'n'), old: path.join(base, 'o'), staging: path.join(base, 's'), helper: Z.helperReady(a) ? a : undefined }, execPath: exe, errFile: 'e', platform: 'win32', pid: 1, spawnFn: (...x) => { spawned.push(x); return { unref() {} }; } });
    const used = spawned[0] && spawned[0][2].cwd;
    check('helper: a launch with no (or a vanished) helper copy makes a fresh one instead of starting a missing exe', spawned.length === 1 && used && fs.existsSync(path.join(used, 'Lumen.exe')) && fs.existsSync(path.join(used, 'swap-helper.js')), JSON.stringify(spawned[0]));
    if (used) rm(used);
    rm(base);
  }
  const zsrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'zip-update.js'), 'utf8');
  check('helper: it is prepared when the update is staged (before any click), off the main thread', /helper: await prepareHelperAsync\(execPath\)/.test(zsrc), '');

  const usrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'updates.js'), 'utf8');
  check('helper: applyOnQuit drops a helper copy that has vanished before launching', usrc.includes('!z.helperReady(staged.helper)) staged.helper = null'), '');

  rm(d);
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
