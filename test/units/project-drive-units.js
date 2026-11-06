// [project drive] Save to Drive (features/project-drive.js) against a fake Google Drive: the Lumen/Projects folder made once, a project's
// files written, then only the changed ones; a renamed project renames its folder; a folder or file deleted in Drive is made again; the
// readable files (no Sources/); a saved project read back for Import; the Drive v3 requests driveClient sends; and the wiring (the
// connector's own sign-in, off by default, temporary projects refused, the channels, the page). Plain Node, no network.
const fs = require('fs');
const path = require('path');
const D = require('../../src/features/project-drive');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const src = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

// A Drive in memory: folders and files by id, with a log of the writes.
function fakeDrive() {
  let n = 0;
  const items = new Map(); // id -> { id, name, parent, folder, text, modified }
  const log = [];
  const id = () => `id${++n}`;
  return {
    items, log,
    async findFolder(name, parent) { return [...items.values()].find((x) => x.folder && x.name === name && x.parent === (parent || 'root'))?.id || null; },
    async makeFolder(name, parent) { const x = { id: id(), name, parent: parent || 'root', folder: true, modified: ++n }; items.set(x.id, x); log.push(['folder', name]); return x.id; },
    async listFolders(parent) { return [...items.values()].filter((x) => x.folder && x.parent === (parent || 'root')).map((x) => ({ id: x.id, name: x.name, modified: x.modified })); },
    async listFiles(parent) { return [...items.values()].filter((x) => !x.folder && x.parent === parent).map((x) => ({ id: x.id, name: x.name })); },
    async rename(fid, name) { items.get(fid).name = name; log.push(['rename', name]); },
    async writeFile({ id: fid, parent, name, text }) {
      if (fid && !items.has(fid)) throw Object.assign(new Error('gone'), { status: 404 });
      const x = fid ? items.get(fid) : { id: id(), parent, folder: false };
      Object.assign(x, { name, text, modified: ++n });
      items.set(x.id, x);
      log.push(['write', name]);
      return x.id;
    },
    async readFile(fid) { return items.get(fid).text; },
  };
}
const memState = () => { const m = new Map(); return { get: (k) => m.get(k) || null, set: (k, v) => { if (v) m.set(k, v); else m.delete(k); }, m }; };
const PID = 'aaaaaaaaaaaaaaaa';

(async () => {
  // ---- the files
  {
    const files = D.filesFor({ project: { name: 'Thesis', description: 'Birds', defaults: { plan: true } }, notes: [{ text: 'Deadline is May 3', pinned: true }, { text: 'Advisor: Dr. Lee' }], places: [{ label: 'Draft', kind: 'doc', loc: 'C:\\t\\draft.docx', pinned: true }], chats: [{ name: 'First chat.md', text: '# First chat' }], instructions: 'Be brief.\n', sources: '- https://x.org\n' });
    const names = files.map((f) => f.name);
    check('files: readable Markdown and JSON, the chats under Chats/', ['README.md', 'INSTRUCTIONS.md', 'project.json', 'sources.md', 'Memory.md', 'memory.json', 'Key documents.md', 'key-documents.json', 'Chats/First chat.md'].every((x) => names.includes(x)), names.join());
    check('files: never Sources/ (the files added to the project)', !names.some((x) => x.startsWith('Sources/')));
    check('files: Memory.md lists the notes, pinned marked', /- \(pinned\) Deadline is May 3/.test(files.find((f) => f.name === 'Memory.md').text));
    const back = D.parseSaved(Object.fromEntries(files.map((f) => [f.name, f.text])));
    check('parse: a saved project reads back (name, goal, defaults, instructions, notes with pins, key documents)', back.name === 'Thesis' && back.description === 'Birds' && back.defaults.plan === true && back.instructions === 'Be brief.' && back.notes.length === 2 && back.notes[0].pinned && back.places[0].loc === 'C:\\t\\draft.docx' && back.places[0].pinned, JSON.stringify(back));
    const old = D.parseSaved({ 'Memory.md': '# Memory\n\n- (pinned) One\n- Two\n' });
    check('parse: without memory.json, Memory.md\'s bullets are the notes', old.notes.length === 2 && old.notes[0].text === 'One' && old.notes[0].pinned);
  }
  // ---- saving
  {
    const drive = fakeDrive();
    const state = memState();
    const svc = D.createProjectDrive({ client: () => drive, state, now: () => 1000 });
    const files = [{ name: 'README.md', text: 'a' }, { name: 'Memory.md', text: 'b' }, { name: 'Chats/One.md', text: 'c' }];
    const first = await svc.save(PID, 'Thesis', files);
    const folders = [...drive.items.values()].filter((x) => x.folder).map((x) => x.name);
    check('save: Lumen/Projects/<name> and Chats/ are made, every file written', JSON.stringify(folders) === JSON.stringify(['Lumen', 'Projects', 'Thesis', 'Chats']) && first.written === 3, JSON.stringify([folders, first]));
    check('save: the state keeps the folder, file ids and the time', state.get(PID).folder === first.folder && state.get(PID).saved === 1000 && Object.keys(state.get(PID).files).length === 3);
    drive.log.length = 0;
    const second = await svc.save(PID, 'Thesis', [{ name: 'README.md', text: 'a' }, { name: 'Memory.md', text: 'b2' }, { name: 'Chats/One.md', text: 'c' }]);
    check('save again: only the changed file is sent, into the same file', second.written === 1 && second.kept === 2 && JSON.stringify(drive.log) === JSON.stringify([['write', 'Memory.md']]) && [...drive.items.values()].filter((x) => x.name === 'Memory.md').length === 1, JSON.stringify(drive.log));
    drive.log.length = 0;
    await svc.save(PID, 'Thesis 2026', [{ name: 'README.md', text: 'a' }]);
    check('a renamed project renames its folder', drive.log.some((x) => x[0] === 'rename' && x[1] === 'Thesis 2026'));
    const fileId = state.get(PID).files['README.md'].id;
    drive.items.delete(fileId);
    await svc.save(PID, 'Thesis 2026', [{ name: 'README.md', text: 'a changed' }]);
    check('a file deleted in Drive is made again', [...drive.items.values()].some((x) => x.name === 'README.md' && x.text === 'a changed'));
    drive.items.delete(state.get(PID).folder);
    const again = await svc.save(PID, 'Thesis 2026', [{ name: 'README.md', text: 'a changed' }]);
    check('a project folder deleted in Drive is made again, with everything in it', again.written === 1 && drive.items.has(again.folder));
    const saved = await svc.listSaved();
    check('listSaved: the folders in Lumen/Projects', saved.some((x) => x.name === 'Thesis 2026'));
    const read = await svc.read(again.folder);
    check('read: the top-level Markdown and JSON of a saved project', read['README.md'] === 'a changed');
    const off = D.createProjectDrive({ client: () => { throw Object.assign(new Error('Connect Google Drive first'), { code: 'connect' }); }, state: memState() });
    let why = '';
    try { await off.save(PID, 'x', files); } catch (err) { why = err.code; }
    check('without a Drive sign-in, a save fails with code connect (nothing else is tried)', why === 'connect');
  }
  // ---- the Drive v3 requests
  {
    const calls = [];
    const http = async (target, opts = {}) => {
      calls.push({ target, ...opts });
      if (opts.method === 'POST' && target === '/files') return { ok: true, status: 200, text: '{"id":"F1"}' };
      if (/upload/.test(target)) return { ok: true, status: 200, text: '{"id":"U1"}' };
      if (target === '/files') return { ok: true, status: 200, text: JSON.stringify({ files: [{ id: 'X', name: 'Lumen', modifiedTime: '2026-11-01T00:00:00Z' }] }) };
      return { ok: false, status: 404, text: '' };
    };
    const c = D.driveClient(http);
    check('client: a folder is looked up by name and parent, never in the Trash', (await c.findFolder("Bob's", null)) === 'X' && /name = 'Bob\\'s' and mimeType = 'application\/vnd\.google-apps\.folder' and 'root' in parents and trashed = false/.test(calls[0].query.q), calls[0].query.q);
    check('client: makeFolder posts the folder type and its parent', (await c.makeFolder('Projects', 'X')) === 'F1' && calls[1].json.mimeType === 'application/vnd.google-apps.folder' && calls[1].json.parents[0] === 'X');
    const fid = await c.writeFile({ parent: 'P', name: 'Memory.md', text: 'hi' });
    const up = calls[2];
    check('client: a new file is one multipart upload to the upload address, with its parent', fid === 'U1' && up.target === 'https://www.googleapis.com/upload/drive/v3/files' && up.method === 'POST' && up.query.uploadType === 'multipart' && /"parents":\["P"\]/.test(up.body.toString()) && /multipart\/related; boundary=/.test(up.headers['Content-Type']));
    await c.writeFile({ id: 'U1', parent: 'P', name: 'Memory.md', text: 'hi again' });
    check('client: new content for a file Lumen made is a PATCH of that file', calls[3].method === 'PATCH' && calls[3].target.endsWith('/files/U1'));
    let status = 0;
    try { await c.readFile('nope'); } catch (err) { status = /404/.test(err.message); }
    check('client: an error says what Drive answered', status === true);
  }
  // ---- wiring
  {
    const main = src('src/main.js');
    const svc = src('src/features/connectors/service.js');
    check('service: driveRequest uses the Drive card\'s sign-in, null while not connected', /function driveRequest\(\)[\s\S]{0,200}connected\.drive;\s+if \(!entry\) return null;/.test(svc) && /driveRequest, forgetAll/.test(svc));
    check('main: off until turned on per project; a temporary project and a missing sign-in are refused', /if \(p\.temporary\) return \{ \.\.\.driveView\(p\.id\), error: 'temporary' \}/.test(main) && /if \(!driveConnected\(\)\) return \{ \.\.\.driveView\(p\.id\), error: 'connect' \}/.test(main) && /if \(!id \|\| !driveStore\.get\(id\)\?\.on\) return;/.test(main));
    check('main: saved again after a change (project edits and chat saves), debounced', /driveSoonAll\(\); \}; \/\/ \(\[project drive\]/.test(main) && /driveSoon\(projectIdOf\(chatId\)\)/.test(main) && /driveSoon\(projectIdOf\(id\)\)/.test(main) && /DEBOUNCE_MS/.test(main));
    check('main: the files never include Sources/', /never Sources\//i.test(main) && /filesFor\(\{ project: p, notes, places: kept, chats: chatFiles/.test(main));
    check('main: deleting a project stops its saves', /if \(driveStore\.get\(id\)\) driveStore\.set\(id, null\);/.test(main));
    check('channels: served, on both channel lists (not a handler line), in the preload', /ipcMain\.handle\('chats:project-drive', async \(_e, id, change\) =>/.test(main) && /ipcMain\.handle\('chats:drive-list', async \(\) =>/.test(main) && /ipcMain\.handle\('chats:drive-import', async \(_e, folderId\) =>/.test(main) && /'chats:project-flag', 'chats:project-drive', 'chats:drive-list', 'chats:drive-import',/.test(src('src/features/chat-page.js')) && /driveImport: \(folderId\) => ipcRenderer\.invoke\('chats:drive-import', folderId\)/.test(src('src/features/chat-preload.js')));
    check('page: Settings has Save to Drive / Save now; cards have the Drive badge, the menu item and Import from Drive', /function driveLine/.test(src('src/renderer/chat-project-page.js')) && /pja-drive/.test(src('src/renderer/chat-projects-all.js')) && /importBox/.test(src('src/renderer/chat-projects-all.js')));
    check('privacy: PRIVACY.md says what goes to Drive and where', /Lumen\/Projects/.test(src('PRIVACY.md')) && /Save to Drive/.test(src('PRIVACY.md')));
  }

  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
