// Plain Node checks (no Electron) of the hang recorder (features/hang-recorder.js): the label table, the ring and its wraparound, the
// breadcrumbs left open by a block, the watchdog's state machine on a fake clock, the 200-line file cap, and the recorder's cost.
const hr = require('../../src/features/hang-recorder');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const clock = () => { let t = 1e6; const f = () => t; f.add = (d) => { t += d; }; return f; };

// ---- labels: ids are small ints, the same name is the same id, names are safe, a full table falls back to "other"
{
  const rec = hr.create({ now: clock() });
  const a = rec.label('ipc:view:freeze'); const b = rec.label('layout');
  check('labels: distinct names get distinct ids, the same name the same id', a !== b && rec.label('ipc:view:freeze') === a, `${a} ${b}`);
  check('labels: the worker side reads them back from the shared table', rec.nameOf(a) === 'ipc:view:freeze' && hr.labelOf(new Uint8Array(rec.sab), b) === 'layout', rec.nameOf(a));
  check('labels: a URL is never kept', hr.safeLabel('https://example.com/a?b=1') === 'redacted' && hr.safeLabel('ftp://x') === 'redacted', hr.safeLabel('https://example.com'));
  check('labels: odd characters are replaced and the length is bounded', !/[^\w:.\-/ ]/.test(hr.safeLabel('a<b>"cé')) && hr.safeLabel('x'.repeat(200)).length === 63, hr.safeLabel('a<b>"c'));
  const r2 = hr.create({ now: clock() });
  let last = 0;
  for (let i = 0; i < 1500; i++) last = r2.label(`l${i}`);
  check('labels: past the table they become "other" and the id stays in range', r2.nameOf(last) === 'other' && last === hr.LABELS - 1 && r2.nameOf(r2.label('l0')) === 'l0', r2.nameOf(last));
}

// ---- the ring: begin/end, nesting, wraparound
{
  const now = clock(); const rec = hr.create({ now });
  const outer = rec.begin(rec.label('outer')); now.add(5); const inner = rec.begin(rec.label('inner'));
  let a = rec.snapshot();
  check('ring: two begun breadcrumbs are both open, outermost first', JSON.stringify(a.open) === '["outer","inner"]', JSON.stringify(a.open));
  now.add(7); rec.end(inner); now.add(3); rec.end(outer);
  a = rec.snapshot();
  check('ring: ended breadcrumbs are not open and carry their length', a.open.length === 0 && a.recent.find((e) => e.l === 'inner').ms === 7 && a.recent.find((e) => e.l === 'outer').ms === 15, JSON.stringify(a));
  const id = rec.label('x'); let stuck;
  for (let i = 0; i < 200; i++) { const s = rec.begin(id); if (i === 3) stuck = s; else rec.end(s); } // one never ends, then the ring fills past it
  check('ring: wraparound keeps the newest 64 and drops the old open one', rec.entries().length === hr.RING && rec.snapshot().open.length === 0 && rec.entries()[0].seq === 202 - hr.RING + 1, JSON.stringify(rec.snapshot().open));
  rec.end(stuck); // its slot belongs to a newer breadcrumb now: must not mark that one ended
  const open = rec.begin(rec.label('late'));
  const openNow = rec.snapshot().open.join();
  rec.end(open);
  check('ring: a late end for an overwritten slot changes nothing', openNow === 'late' && rec.snapshot().open.length === 0, openNow);
}

// ---- mark: returns the result, ends on a throw, and a block shows as open from outside
{
  const rec = hr.create({ now: clock() });
  check('mark: returns the result and passes both arguments', rec.mark('m', (a, b) => a + b, 2, 3) === 5, '');
  let threw = false; try { rec.mark('boom', () => { throw new Error('x'); }); } catch { threw = true; }
  check('mark: a throw still ends the breadcrumb', threw && rec.snapshot().open.length === 0, JSON.stringify(rec.snapshot()));
  let during; rec.mark('block', () => { during = rec.snapshot().open.slice(); });
  check('mark: while the function runs the label is open', during.join() === 'block', during);
}

// ---- ipc wrapping: the listener records itself, passes arguments, and removeListener still finds the original
{
  const rec = hr.create({ now: clock() });
  const EventEmitter = require('events');
  const ipc = new EventEmitter(); const handlers = new Map();
  ipc.handle = (c, l) => handlers.set(c, l);
  hr.wrapIpc(ipc, rec);
  let seen;
  const l = (e, x) => { seen = [e, x, rec.snapshot().open.join()]; return 7; };
  ipc.on('a:b', l); ipc.handle('c:d', l);
  ipc.emit('a:b', 'ev', 9);
  check('ipcMain.on: the listener runs with its arguments and shows open while it runs', seen[0] === 'ev' && seen[1] === 9 && seen[2] === 'ipc:a:b', JSON.stringify(seen));
  const r = handlers.get('c:d')('ev', 1);
  check('ipcMain.handle: the result is returned and the channel is the label', r === 7 && seen[2] === 'ipc:c:d', JSON.stringify(seen));
  ipc.removeListener('a:b', l);
  check('ipcMain: removeListener with the original still works', ipc.listenerCount('a:b') === 0, ipc.listenerCount('a:b'));
}

// ---- the watchdog on a fake clock: a hang is named, a provisional line at 3 s, one final line, no line for quick stalls
{
  const now = clock(); const rec = hr.create({ now }); const lines = [];
  const dog = hr.createWatchdog({ sab: rec.sab, sink: (e) => lines.push(e), version: '9.9.9' });
  let mono = 0; const wallOf = () => 5e11 + mono;
  const look = () => { mono += 200; dog.tick(mono, wallOf()); };
  const step = (ms) => { for (let t = 0; t < ms; t += 200) look(); }; // main silent
  const heart = (ms) => { for (let t = 0; t < ms; t += 200) { rec.beat(); look(); } }; // main beating
  dog.tick(mono, wallOf());
  heart(2000); rec.mark('fine', () => 1);
  check('watchdog: a beating main writes nothing', lines.length === 0, JSON.stringify(lines));
  step(800); rec.beat(); look();
  check('watchdog: a stall under a second writes nothing', lines.length === 0, JSON.stringify(lines));
  rec.beat(); look();
  const s = rec.begin(rec.label('ipc:test:block')); const s2 = rec.begin(rec.label('layout'));
  step(2000);
  check('watchdog: nothing is written before 3 s', lines.length === 0, JSON.stringify(lines));
  step(1400);
  check('watchdog: one provisional line at 3 s, naming the open breadcrumbs', lines.length === 1 && lines[0].provisional === true && lines[0].open.join() === 'ipc:test:block,layout' && lines[0].durationMs >= 3000 && lines[0].v === '9.9.9', JSON.stringify(lines));
  step(1000);
  check('watchdog: still only one provisional line', lines.length === 1, lines.length);
  rec.end(s2); rec.end(s); rec.beat(); look();
  const fin = lines[1] || {};
  check('watchdog: main answering writes the final line with the same id, the duration and the labels', lines.length === 2 && !fin.provisional && fin.id === lines[0].id && fin.durationMs >= 4400 && fin.open.join() === 'ipc:test:block,layout', JSON.stringify(lines));
  check('watchdog: the line holds only time, labels and the version', Object.keys(fin).sort().join() === 'durationMs,id,open,recent,slow,time,v' && fin.recent.every((e) => /^[\w:.\- /]+$/.test(e.l)), Object.keys(fin));
  const before = lines.length; heart(2000);
  check('watchdog: back to quiet after the hang', lines.length === before, lines.length);
}
{ // a hang over before 3 s gives one final line and no provisional one; a slow breadcrumb that ended is named
  const now = clock(); const rec = hr.create({ now }); const lines = [];
  const dog = hr.createWatchdog({ sab: rec.sab, sink: (e) => lines.push(e) });
  let mono = 0; const wallOf = () => now() + mono * 0; // (the ring's clock and the watchdog's wall clock are the same one)
  const look = () => { mono += 200; now.add(200); dog.tick(mono, wallOf()); };
  dog.tick(mono, wallOf()); rec.beat(); look();
  const s = rec.begin(rec.label('slowone'));
  for (let i = 0; i < 8; i++) look(); // 1.6 s stuck
  rec.end(s); rec.beat(); look();
  check('watchdog: a 1.6 s hang gives one final line, no provisional one', lines.length === 1 && !lines[0].provisional && lines[0].durationMs >= 1400 && lines[0].open.join() === 'slowone', JSON.stringify(lines));
  check('watchdog: the breadcrumb that took long is named in slow', lines[0] && lines[0].slow.some((e) => e.l === 'slowone' && e.ms >= 1500), JSON.stringify(lines[0] && lines[0].slow));
}
{ // the watchdog's own thread not running (sleep, a stepped clock) is not a hang
  const rec = hr.create({ now: clock() }); const lines = [];
  const dog = hr.createWatchdog({ sab: rec.sab, sink: (e) => lines.push(e) });
  dog.tick(0, 1e12); rec.beat(); dog.tick(200, 1e12 + 200);
  dog.tick(60200, 1e12 + 60200); // a minute passes between two looks
  dog.tick(60400, 1e12 + 60400); dog.tick(61800, 1e12 + 61800);
  rec.beat(); dog.tick(62000, 1e12 + 62000);
  check('watchdog: a gap in the worker\'s own looks (sleep) writes nothing', lines.length === 0, JSON.stringify(lines));
  const dog2 = hr.createWatchdog({ sab: rec.sab, sink: (e) => lines.push(e) });
  dog2.tick(0, 1e12); dog2.tick(200, 1e12 + 200 + 3600e3); dog2.tick(400, 1e12 + 400 + 3600e3); dog2.tick(1600, 1e12 + 1600 + 3600e3);
  rec.beat(); dog2.tick(1800, 1e12 + 1800 + 3600e3);
  check('watchdog: a wall clock that jumped is not a hang either', lines.length === 0, JSON.stringify(lines));
}

// ---- the file: the last 200 lines, a final line replaces its provisional one
{
  let text = '';
  for (let i = 0; i < 250; i++) text = hr.nextFile(text, { id: i, durationMs: 1000 + i, open: [], recent: [] });
  const lines = text.trim().split('\n');
  check('file: capped to the last 200 lines', lines.length === 200 && JSON.parse(lines[0]).id === 50 && JSON.parse(lines[199]).id === 249 && hr.countHangs(text) === 200, lines.length);
  let t = hr.nextFile('', { id: 7, provisional: true, durationMs: 3100, open: ['a'], recent: [] });
  t = hr.nextFile(t, { id: 8, provisional: true, durationMs: 3100, open: [], recent: [] });
  t = hr.nextFile(t, { id: 7, durationMs: 5000, open: ['a'], recent: [] });
  const ids = t.trim().split('\n').map((l) => JSON.parse(l));
  check('file: the final line replaces the provisional one with its id and leaves others', ids.length === 2 && ids[0].id === 8 && ids[1].id === 7 && !ids[1].provisional, JSON.stringify(ids));
  check('file: a damaged line is dropped when a final line is added, not fatal', hr.nextFile('{bad\n', { id: 1, durationMs: 1 }).trim().split('\n').length === 1, '');
  check('file: lines end with \\n only', t.endsWith('\n') && !t.includes('\r'), JSON.stringify(t.slice(-3)));
}

// ---- cost: reported; the check is only a very generous bound, so a noisy machine does not fail it
{
  const rec = hr.create(); const id = rec.label('bench');
  const N = 2e6; const fn = (a) => a + 1;
  let x = 0;
  for (let i = 0; i < 2e5; i++) { const s = rec.begin(id); x = fn(x); rec.end(s); x = rec.mark('bench', fn, x); } // warm up
  let t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) x = fn(x);
  const base = Number(process.hrtime.bigint() - t0) / N;
  t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) { const s = rec.begin(id); x = fn(x); rec.end(s); }
  const withBc = Number(process.hrtime.bigint() - t0) / N;
  t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) x = rec.mark('bench', fn, x);
  const withMark = Number(process.hrtime.bigint() - t0) / N;
  console.log(`INFO  overhead per breadcrumb: begin+end ${Math.max(0, withBc - base).toFixed(0)} ns, mark() with a name lookup ${Math.max(0, withMark - base).toFixed(0)} ns (a bare call ${base.toFixed(1)} ns)`);
  check('cost: a breadcrumb is far below a microsecond', withBc - base < 1000 && withMark - base < 1000, `${withBc - base} ${withMark - base}`);
}

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nall passed');
