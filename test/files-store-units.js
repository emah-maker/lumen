// Files list (features/files-store.js), plain Node: pin and unpin, recent order, the cap of 500, missing files, relocate, the
// encrypted round trip on disk, and that nothing but names, sizes, times and paths is ever stored (never a file's contents).
require('./_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { create, FIELDS } = require('../src/features/files-store');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-files-store-'));
const file = path.join(dir, 'files.json');
let t = 1000;
const now = () => ++t;
// A stand-in keychain: reversible, and visibly not the plain text.
const encrypt = (text) => Buffer.from(text, 'utf8').toString('base64').split('').reverse().join('');
const decrypt = (enc) => Buffer.from(enc.split('').reverse().join(''), 'base64').toString('utf8');
const mk = (opts = {}) => create({ file, encrypt, decrypt, now, delay: 5, ...opts });
const docs = path.join(dir, 'Documents');

(async () => {
  // ---- pin and unpin
  const s = mk({ file: path.join(dir, 'pins.json') }); // its own file: its debounced save must not race the round-trip checks below
  await s.load();
  const folder = s.pin(path.join(docs, 'Course'), 'folder');
  const slides = s.pin(path.join(docs, 'Chapter 4 slides.pptx'), 'file');
  check('pin: a file and a folder, in the order pinned', JSON.stringify(s.list().pinned.map((e) => e.name)) === JSON.stringify(['Course', 'Chapter 4 slides.pptx']), JSON.stringify(s.list().pinned));
  check('pin: the entry has the contract shape', FIELDS.every((f) => f in slides || f === 'pinnedAt') && slides.kind === 'file' && folder.kind === 'folder' && slides.pinned === true && slides.missing === false && slides.source === 'pin', JSON.stringify(slides));
  check('pin: pinning again does not duplicate', s.pin(path.join(docs, 'Course'), 'folder').id === folder.id && s.all().length === 2, String(s.all().length));
  check('unpin: a pin that was never opened leaves the list', s.unpin(folder.id) && s.all().length === 1 && s.list().pinned.length === 1, JSON.stringify(s.all()));

  // ---- recent
  const a = path.join(docs, 'a.pdf');
  const b = path.join(docs, 'b.docx');
  s.touch(a, { source: 'tab', size: 10, mtime: 5 });
  s.touch(b, { source: 'download' });
  s.touch(a, { source: 'ai' });
  let r = s.list().recent;
  check('recent: newest first, an open moves the file to the top', r.map((e) => e.name).join() === 'a.pdf,b.docx', JSON.stringify(r.map((e) => e.name)));
  check('recent: the source and the size are kept, the last source wins', r[0].source === 'ai' && r[0].size === 10 && r[1].source === 'download', JSON.stringify(r));
  s.touch(slides.path, { source: 'tab' });
  check('recent: a pinned file stays in Pinned, not in Recent too', s.list().recent.every((e) => e.path !== slides.path) && s.list().pinned[0].openedAt > 0, JSON.stringify(s.list()));
  check('recent: the limit', s.list({ recentLimit: 1 }).recent.length === 1, '');
  check('touch: an unknown source becomes "tab", a bad path is refused', s.touch(path.join(docs, 'c.txt'), { source: 'hax' }).source === 'tab' && s.touch('', {}) === null && s.touch(null) === null, '');
  check('unpin: a pinned file that was opened stays in Recent', s.unpin(slides.id) && s.list().recent.some((e) => e.path === slides.path), JSON.stringify(s.list()));
  check('remove and clear', s.remove(s.byPath(b).id) && !s.byPath(b) && s.clear() && s.all().length === 0 && s.list().recent.length === 0, '');
  // ---- restore (Undo of unpin and remove): a store with no file of its own
  const rs = create({ now });
  const rp = rs.pin(path.join(docs, 'undo.pdf'), 'file');
  const before = rs.get(rp.id);
  rs.unpin(rp.id);
  check('restore: an unpinned pin that was never opened comes back pinned, in its place', !rs.get(rp.id) && rs.restore(before)?.pinned === true && rs.list().pinned.some((e) => e.id === rp.id), JSON.stringify(rs.all()));
  rs.touch(path.join(docs, 'undo.pdf'), { source: 'tab' });
  const opened = rs.get(rp.id);
  rs.remove(rp.id);
  const restored = rs.restore(opened);
  check('restore: a removed entry returns with its pin and its time in Recent', restored?.id === rp.id && restored.pinned === true && restored.openedAt === opened.openedAt && rs.restore(null) === null && rs.restore({ path: '' }) === null, JSON.stringify(restored));
  rs.clear();

  // ---- the cap
  const capped = create({ file: null, now, cap: 500 });
  const pins = [capped.pin(path.join(docs, 'keep-1.pdf')), capped.pin(path.join(docs, 'keep-2.pdf'))];
  for (let i = 0; i < 600; i++) capped.touch(path.join(docs, `file-${i}.txt`), { source: 'tab' });
  const all = capped.all();
  check('cap: never more than 500 entries', all.length === 500, String(all.length));
  check('cap: the oldest recent files go first, newest stay', !capped.byPath(path.join(docs, 'file-0.txt')) && Boolean(capped.byPath(path.join(docs, 'file-599.txt'))) && Boolean(capped.byPath(path.join(docs, 'file-102.txt'))), '');
  check('cap: pins survive it', pins.every((p) => capped.get(p.id)?.pinned), '');
  const allPinned = create({ file: null, now, cap: 3 });
  for (let i = 0; i < 5; i++) allPinned.pin(path.join(docs, `p${i}`));
  check('cap: with only pins, the oldest pin goes', allPinned.all().length === 3 && !allPinned.byPath(path.join(docs, 'p0')) && Boolean(allPinned.byPath(path.join(docs, 'p4'))), '');

  // ---- missing files
  const m = mk({ file: null });
  const f = m.touch(path.join(docs, 'gone.pdf'), { source: 'tab' });
  check('missing: setMissing marks and reports a change only when it changed', m.setMissing(f.id, true) === true && m.get(f.id).missing === true && m.setMissing(f.id, true) === false && m.setMissing('nope', true) === false, '');
  check('missing: opening it again clears the mark', m.touch(f.path, { source: 'tab' }).missing === false, '');
  m.setMissing(f.id, true);
  const found = path.join(dir, 'Elsewhere', 'gone.pdf');
  const moved = m.relocate(f.id, found);
  check('relocate: the entry keeps its id and follows the new path', moved.id === f.id && moved.path === found && moved.missing === false && moved.source === 'found' && m.byPath(found).id === f.id && !m.byPath(f.path), JSON.stringify(moved));
  const pinnedThere = m.pin(path.join(dir, 'Else', 'x.pdf'));
  const unpinnedHere = m.touch(path.join(dir, 'Old', 'x.pdf'));
  const merged = m.relocate(unpinnedHere.id, pinnedThere.path);
  check('relocate: onto a path already in the list folds the two and keeps the pin', merged.pinned === true && m.all().filter((e) => e.path === pinnedThere.path).length === 1, JSON.stringify(m.all()));
  check('relocate: an unknown id or empty path is refused', m.relocate('nope', found) === null && m.relocate(f.id, '') === null, '');

  // ---- the disk: encrypted, debounced, round trip
  const w = mk();
  await w.load();
  w.pin(path.join(docs, 'Chapter 4 slides.pptx'), 'file');
  w.touch(path.join(docs, 'Budget 2026.xlsx'), { source: 'download', size: 2048, mtime: 1234 });
  check('save: debounced, so nothing is written yet', w.pending() === true && !fs.existsSync(file), '');
  await w.flush();
  const raw = fs.readFileSync(file, 'utf8');
  check('save: the file holds only encrypted text', /"enc"/.test(raw) && !/Chapter|Budget|pptx|Documents/.test(raw), raw.slice(0, 200));
  check('save: not pending once written', w.pending() === false, '');
  const back = mk();
  await back.load();
  const bl = back.list();
  check('round trip: pins, recents, source, size and time come back', bl.pinned.length === 1 && bl.pinned[0].name === 'Chapter 4 slides.pptx' && bl.recent[0].name === 'Budget 2026.xlsx' && bl.recent[0].size === 2048 && bl.recent[0].mtime === 1234 && bl.recent[0].source === 'download', JSON.stringify(bl));
  check('round trip: the ids are the same', back.byPath(path.join(docs, 'Budget 2026.xlsx')).id === w.byPath(path.join(docs, 'Budget 2026.xlsx')).id, '');
  const noKeychain = mk({ file: path.join(dir, 'nokey.json'), available: () => false });
  noKeychain.touch(path.join(docs, 'secret.pdf'), {});
  await noKeychain.flush();
  check('no keychain: nothing is written in plain text', !fs.existsSync(path.join(dir, 'nokey.json')), '');
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
  const bad = mk({ file: path.join(dir, 'bad.json') });
  await bad.load();
  check('a damaged file is an empty list, not an error', bad.all().length === 0, '');

  // ---- never contents
  const c = mk({ file: path.join(dir, 'contents.json'), encrypt: (x) => x });
  const e = c.touch(path.join(docs, 'letter.txt'), { source: 'tab', size: 20, content: 'DEAR JOHN, THE PASSWORD IS HUNTER2', text: 'HUNTER2', data: Buffer.from('HUNTER2') });
  c.pin(path.join(docs, 'letter.txt'));
  const written = c.serialize();
  check('never contents: an unknown field passed to touch is not stored', !/HUNTER2|DEAR JOHN/.test(written) && !('content' in e) && !('text' in e), written);
  check('never contents: only the listed fields reach the disk', JSON.parse(written).entries.every((x) => Object.keys(x).every((k) => FIELDS.includes(k))), written);
  await c.flush();
  check('never contents: the file on disk has none either', !/HUNTER2|DEAR JOHN/.test(fs.readFileSync(path.join(dir, 'contents.json'), 'utf8')), '');

  const changes = [];
  const n = mk({ file: null });
  n.onChange(() => changes.push(1));
  n.pin(path.join(docs, 'x'));
  n.touch(path.join(docs, 'y'));
  check('onChange fires for each change', changes.length === 2, String(changes.length));

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
