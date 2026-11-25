// [linked folders] features/project-linked-folders.js and the project_files tool's folder_list / folder_read (ai/project-context.js): the list a
// project keeps (local folders and Drive folders), the context block's index, listing and reading only inside the folder the user linked (no
// "..", no hidden files, no link out of it), and the chat store keeping the list. Plain Node; every folder is a temp folder.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../../src/features/project-linked-folders');
const ctx = require('../../src/ai/project-context');
const { createChatStore } = require('../../src/features/chat-store');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const J = JSON.stringify;

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-linked-folders-'));
  const root = path.join(dir, 'Résumés');
  fs.mkdirSync(path.join(root, 'Old'), { recursive: true });
  fs.writeFileSync(path.join(root, 'notes.txt'), 'Base résumé notes: SolidWorks.');
  fs.writeFileSync(path.join(root, 'Old', 'v1.md'), '# Version 1');
  fs.writeFileSync(path.join(root, '.secret'), 'hidden');
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'outside');
  let linked = false;
  try { fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(root, 'escape.txt')); linked = true; } catch { /* no symlinks here (Windows without the right): that check is skipped */ }

  // ---- the list
  const list = L.clean([{ kind: 'local', path: root }, { kind: 'local', path: root }, { kind: 'local', path: 'relative/x' }, { kind: 'drive', driveId: 'https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOp?usp=sharing', name: 'Job docs' }, { kind: 'drive', driveId: 'nope' }]);
  check('the list: absolute local folders and Drive folders, no repeats, ids given', list.length === 2 && list[0].kind === 'local' && list[0].name === 'Résumés' && list[1].kind === 'drive' && list[1].driveId === '1AbCdEfGhIjKlMnOp' && list.every((f) => /^[a-f0-9]{6,16}$/.test(f.id)), J(list));
  check('at most 12', L.clean(Array.from({ length: 20 }, (_, i) => ({ kind: 'local', path: path.join(dir, `f${i}`) }))).length === L.MAX);
  check('a Drive folder id from its address', L.driveFolderId('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQr') === '1AbCdEfGhIjKlMnOpQr' && L.driveFolderId('https://example.com') === '');
  const idx = L.index(list);
  check('the index: each folder and how to read it', /1\. Résumés \(folder on this computer: project_files folder_list/.test(idx) && /2\. Job docs \(Google Drive folder 1AbCdEfGhIjKlMnOp: connector drive files folder_id 1AbCdEfGhIjKlMnOp/.test(idx) && /never change them/.test(idx), idx);
  check('pick: by number, by name, the only local one when none named', L.pick(list, '2').kind === 'drive' && L.pick(list, 'résumés').kind === 'local' && L.pick(list, '').kind === 'local' && L.pick(list, 'nothing') === null);

  // ---- listing and reading inside it only
  const f = list[0];
  const listed = await L.list(f);
  check('folder_list: folders first, then files; hidden files left out', /Old\//.test(listed) && /notes\.txt/.test(listed) && !/\.secret/.test(listed) && listed.indexOf('Old/') < listed.indexOf('notes.txt'), listed);
  check('folder_list in a sub-folder, with a filter', /v1\.md/.test(await L.list(f, { sub: 'Old', match: '*.md' })) && /nothing matches/.test(await L.list(f, { match: '*.pdf' })));
  const extract = (name, bytes) => require('../../src/features/project-files').extract(name, bytes);
  const read = await L.read(f, 'notes.txt', { extract });
  check('folder_read: the text through Lumen\'s readers', read.name === 'notes.txt' && /SolidWorks/.test(read.text), J(read));
  for (const [label, rel] of [['".." out of it', '../outside.txt'], ['a hidden file', '.secret'], ['an absolute path climbing out', '../../etc/passwd']]) {
    let err = '';
    try { await L.read(f, rel, { extract }); } catch (e) { err = e.message; }
    check(`folder_read refuses ${label}`, Boolean(err), err);
  }
  if (linked) { let err = ''; try { await L.read(f, 'escape.txt', { extract }); } catch (e) { err = e.message; } check('folder_read refuses a link that points out of the folder', /outside the linked folder/.test(err), err); }
  let gone = '';
  try { await L.list({ ...f, path: path.join(dir, 'missing') }); } catch (e) { gone = e.message; }
  check('a folder that is gone says so', /isn’t there any more/.test(gone), gone);

  // ---- through the project_files tool
  let tainted = 0;
  const deps = { files: [], links: [], folders: list, extract, tainted: () => { tainted++; } };
  const t1 = await ctx.runTool({ action: 'folder_list', folder: '1' }, deps);
  check('the tool lists a linked folder', /notes\.txt/.test(t1), t1);
  const t2 = await ctx.runTool({ action: 'folder_read', folder: 'Résumés', path: 'notes.txt' }, deps);
  check('the tool reads a file as untrusted content and marks the chat', /untrusted/i.test(t2) && /SolidWorks/.test(t2) && tainted === 1, t2);
  const t3 = await ctx.runTool({ action: 'folder_list', folder: '2' }, deps);
  check('a Drive folder points to the Drive connector', /connector drive files with folder_id 1AbCdEfGhIjKlMnOp/.test(t3), t3);
  check('no linked folders: says how to link one', /Link a folder/.test(await ctx.runTool({ action: 'folder_list' }, { files: [], links: [] })));
  check('the step label names it', /linked folder/.test(ctx.stepLabel({ action: 'folder_read', path: 'notes.txt' })));

  // ---- kept by the chat store
  const enc = (s) => Buffer.from(s).toString('base64');
  const dec = (s) => Buffer.from(s, 'base64').toString();
  const store = createChatStore({ dir: path.join(dir, 'store'), encrypt: enc, decrypt: dec, now: () => 1_800_000_000_000 });
  const p = store.saveProject({ name: 'Co-op', folders: [...list, { kind: 'local', path: 'nope' }] });
  check('the store keeps the folders, cleaned', J(p.folders) === J(list), J(p.folders));
  check('…and an empty list takes them off', !('folders' in store.saveProject({ id: p.id, name: p.name, folders: [] })));

  if (failures) { console.log(`\n${failures} linked folder check(s) failed.`); process.exit(1); }
  console.log('\nAll linked folder checks passed.');
})().catch((err) => { console.error(err); process.exit(1); });
