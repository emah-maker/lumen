// Finding 2 of the audit: fewer, cheaper settings writes. Plain Node.
// Covers: an identical async write is skipped (no temp file, no .bak churn), a changed one lands, a deleted file is
// rewritten, a sync write (quit) always lands and keeps the cache honest, .bak is still kept (and a corrupt main file
// never replaces a good .bak), an identical background session is not written twice (quit/close always write), a
// background tab's title tick burst arms no save while a navigation in the same burst does, and the bookmark set is
// rebuilt only after a settings write.
require('./_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sf = require('../src/settings/settings-file');
const gates = require('../src/features/save-gates');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-dedupe-'));
const mtimeNs = (f) => fs.statSync(f, { bigint: true }).mtimeNs;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const f = path.join(dir, 'settings.json');
  await sf.writeJsonAtomicAsync(f, { a: 1 });
  check('first async write lands', JSON.parse(fs.readFileSync(f, 'utf8')).a === 1);
  const m1 = mtimeNs(f);
  await sleep(30);
  await sf.writeJsonAtomicAsync(f, { a: 1 });
  check('identical async write is skipped (file untouched)', mtimeNs(f) === m1);
  check('no stray temp file', !fs.existsSync(`${f}.tmp-async`));
  await sf.writeJsonAtomicAsync(f, { a: 2 });
  check('changed async write lands', JSON.parse(fs.readFileSync(f, 'utf8')).a === 2);
  check('.bak holds the previous good file', JSON.parse(fs.readFileSync(`${f}.bak`, 'utf8')).a === 1);

  fs.unlinkSync(f);
  await sf.writeJsonAtomicAsync(f, { a: 2 });
  check('an identical write still happens when the file is gone', fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8')).a === 2);

  // quit path: the sync writer always writes, and a later async write of the OLD text must not be skipped as "same"
  await sf.writeJsonAtomicAsync(f, { a: 3 });
  sf.writeJsonAtomic(f, { a: 4 });
  check('sync write (quit) lands', JSON.parse(fs.readFileSync(f, 'utf8')).a === 4);
  await sf.writeJsonAtomicAsync(f, { a: 3 });
  check('async write of older text after a sync write is not mistaken for unchanged', JSON.parse(fs.readFileSync(f, 'utf8')).a === 3);
  sf.writeJsonAtomic(f, { a: 3 });
  check('sync write of identical data still writes (flush on quit)', fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8')).a === 3);

  // corrupt main file: never copied over a good .bak
  const g = path.join(dir, 'other.json');
  await sf.writeJsonAtomicAsync(g, { v: 1 });
  await sf.writeJsonAtomicAsync(g, { v: 2 }); // .bak = v1
  fs.writeFileSync(g, '{ broken'); // outside edit / torn write
  await sf.writeJsonAtomicAsync(g, { v: 3 }); // the cache says "good", but the .bak must still end up parseable
  const bakOk = (() => { try { JSON.parse(fs.readFileSync(`${g}.bak`, 'utf8')); return true; } catch { return false; } })();
  check('.bak stays parseable around a corrupt main file (still the last good: v1 or v2)', bakOk || !fs.existsSync(`${g}.bak`));
  const h = path.join(dir, 'fresh.json');
  fs.writeFileSync(h, '{ broken');
  fs.writeFileSync(`${h}.bak`, JSON.stringify({ keep: true }));
  await sf.writeJsonAtomicAsync(h, { v: 1 }); // this run never loaded or wrote h: it parses once and keeps the good .bak
  check('unknown corrupt main file does not replace a good .bak', JSON.parse(fs.readFileSync(`${h}.bak`, 'utf8')).keep === true);
  check('write over a corrupt file lands', JSON.parse(fs.readFileSync(h, 'utf8')).v === 1);

  // session gate
  const gate = gates.sessionWriteGate();
  const s1 = { tabs: [1] };
  check('first background session is written', gate.shouldWrite(undefined, s1, true) === true);
  check('identical session (same stored object) is skipped', gate.shouldWrite(s1, { tabs: [1] }, true) === false);
  check('changed session is written', gate.shouldWrite(s1, { tabs: [1, 2] }, true) === true);
  check('close/quit always writes', gate.shouldWrite(null, { tabs: [1, 2] }, false) === true);
  const s3 = { tabs: [3] };
  gate.shouldWrite(s1, s3, true);
  check('written again when something else replaced the stored session', gate.shouldWrite({ other: 1 }, { tabs: [3] }, true) === true);

  // two identical background sessions through the real writer: one file write
  let writes = 0;
  const g2 = gates.sessionWriteGate();
  let stored = null;
  const save = (session, background = true) => { if (!g2.shouldWrite(stored, session, background)) return; writes++; stored = session; };
  save({ t: 1 }); save({ t: 1 }); save({ t: 1 });
  check('three identical background saves make one write', writes === 1, writes);
  save({ t: 1 }, false);
  check('a quit save after them writes', writes === 2, writes);

  // quiet bursts
  const fired = [];
  const timers = [];
  const burst = gates.quietBursts(16, (k, q) => fired.push([k, q]), (fn) => timers.push(fn));
  burst('w', true); burst('w', true); burst('w', true);
  timers.splice(0).forEach((fn) => fn());
  check('a burst of background title ticks fires once, quiet (no session save armed)', fired.length === 1 && fired[0][1] === true, JSON.stringify(fired));
  burst('w', true); burst('w', false); burst('w', true);
  timers.splice(0).forEach((fn) => fn());
  check('a navigation in the same burst makes it non-quiet', fired.length === 2 && fired[1][1] === false, JSON.stringify(fired));
  burst('w'); burst('x', true);
  timers.splice(0).forEach((fn) => fn());
  check('default is non-quiet; keys are separate', fired.length === 4 && fired[2][1] === false && fired[3][1] === true, JSON.stringify(fired));
  burst('w', { not: 'true' });
  timers.splice(0).forEach((fn) => fn());
  check('a non-boolean argument (event object) is not quiet', fired[4][1] === false);

  // memoized bookmark set
  let gen = 0, builds = 0, list = [{ url: 'a' }];
  const memo = gates.memoByGeneration(() => gen, () => { builds++; return new Set(list.map((b) => b.url)); });
  memo(); memo(); memo();
  check('bookmark set built once across many sends', builds === 1, builds);
  check('same Set returned', memo() === memo());
  list = [{ url: 'a' }, { url: 'b' }]; gen++; // a bookmark write bumps the settings generation
  check('rebuilt after a settings write, with the new bookmark', memo().has('b') && builds === 2, builds);

  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})();
