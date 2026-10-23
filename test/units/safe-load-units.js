// A store file that can't be read must never be treated as empty and then saved over, or used to delete things.
// "No file" (ENOENT) is a fresh start; anything else keeps the file as it is, with a copy set aside (<file>.corrupt-<time>).
// Covers settings-file.readStoreFile, the task, skill and macro stores, MCP servers and the chat store's trusted() guard.
// Plain Node; every folder is a temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const bg = require('../../src/features/background-agents');
const skills = require('../../src/features/skills');
const macros = require('../../src/features/macros');
const mcp = require('../../src/features/mcp-client');
const { readStoreFile } = require('../../src/settings/settings-file');
const { createChatStore } = require('../../src/features/chat-store');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-safeload-'));
const asides = (file) => fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(`${path.basename(file)}.corrupt-`));
const quiet = (fn) => { const e = console.error; console.error = () => {}; try { return fn(); } finally { console.error = e; } };
const GARBAGE = '{ not json, half writ';
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

// ---- the shared reader
{
  const d = tmp(); const f = path.join(d, 's.json');
  check('readStoreFile: no file is { missing }, with nothing set aside', (() => { const r = readStoreFile(f); return r.missing === true && !r.failed && asides(f).length === 0; })());
  fs.writeFileSync(f, '{"a":1}');
  check('readStoreFile: a good file is parsed', readStoreFile(f).data?.a === 1);
  fs.writeFileSync(f, GARBAGE);
  const r = quiet(() => readStoreFile(f));
  check('readStoreFile: garbage fails, the original stays and a copy is set aside', r.failed === true && fs.readFileSync(f, 'utf8') === GARBAGE && asides(f).length === 1 && fs.readFileSync(path.join(d, asides(f)[0]), 'utf8') === GARBAGE);
  const g = path.join(d, 'enc.json'); fs.writeFileSync(g, '{"enc":"x"}');
  check('readStoreFile: a parse step that throws (undecryptable) fails the same way', quiet(() => readStoreFile(g, (t) => { JSON.parse(t); throw new Error('cannot decrypt'); })).failed === true && asides(g).length === 1);
}

// ---- background tasks (background-agents.js createTaskStore; background-runner init() saves what load() returned)
{
  const d = tmp(); const file = path.join(d, 'background-tasks.json');
  const enc = (s) => Buffer.from(s).reverse().toString('base64');
  const dec = (s) => Buffer.from(s, 'base64').reverse().toString();
  const task = bg.makeTask({ prompt: 'check the score', model: 'm' });
  const fresh = bg.createTaskStore({ file, encrypt: enc, decrypt: dec });
  check('tasks: no file loads as empty and a save works (fresh start)', fresh.load().length === 0 && fresh.save([task]) === true && fs.existsSync(file));
  // Undecryptable here (another keychain): the file must survive the runner's init() -> saveNow().
  const wrongKey = bg.createTaskStore({ file, encrypt: enc, decrypt: () => { throw new Error('keychain changed'); } });
  const before = fs.readFileSync(file, 'utf8');
  const got = quiet(() => wrongKey.load());
  check('tasks: an undecryptable file loads as empty but sets a copy aside', got.length === 0 && asides(file).length === 1);
  check('tasks: a start-up save (no user change) is refused and the original is untouched', wrongKey.save([]) === false && fs.readFileSync(file, 'utf8') === before);
  check('tasks: a second load of the same file makes no second copy', (() => { quiet(() => bg.createTaskStore({ file, encrypt: enc, decrypt: () => { throw new Error('keychain changed'); } }).load()); return asides(file).length === 1; })());
  check('tasks: no keychain at all still means no write, even for a user change', bg.createTaskStore({ file, encrypt: enc, decrypt: dec, available: () => false }).save([task], { deliberate: true }) === false && fs.readFileSync(file, 'utf8') === before);
  const asideName = path.join(d, asides(file)[0]);
  check('tasks: a user change then saves, and the old bytes are still in the copy', wrongKey.save([task, bg.makeTask({ prompt: 'another', model: 'm' })], { deliberate: true }) === true && fs.readFileSync(asideName, 'utf8') === before && fs.readFileSync(file, 'utf8') !== before);
  check('tasks: after that write the store saves normally again', wrongKey.save([task]) === true);
  const back = bg.createTaskStore({ file, encrypt: enc, decrypt: dec });
  check('tasks: with the keychain back the new task is read', bg.createTaskStore({ file, encrypt: enc, decrypt: dec }).load().length === 1);
  fs.writeFileSync(file, GARBAGE);
  const bad = bg.createTaskStore({ file, encrypt: enc, decrypt: dec });
  quiet(() => bad.load());
  check('tasks: an unparseable file is not overwritten by a start-up save', bad.save([task]) === false && fs.readFileSync(file, 'utf8') === GARBAGE);
}

// ---- skills (skills.js createStore)
{
  const d = tmp(); const file = path.join(d, 'skills.json');
  const s1 = skills.createStore({ file });
  check('skills: no file starts from the built-ins and writes the file', s1.list().length > 0 && fs.existsSync(file));
  const saved = s1.save({ name: 'my-skill', title: 'Mine', description: 'd', prompt: 'Do the thing.' });
  check('skills: a user skill saves and survives a reload', saved.ok === true && skills.createStore({ file }).list().some((s) => s.name === 'my-skill'), JSON.stringify(saved));
  const good = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, GARBAGE);
  const s2 = skills.createStore({ file });
  quiet(() => s2.list());
  check('skills: an unreadable file is not overwritten by the built-ins, and a copy is set aside', fs.readFileSync(file, 'utf8') === GARBAGE && asides(file).length === 1);
  check('skills: a second load of the same file makes no second copy', (() => { const x = skills.createStore({ file }); quiet(() => x.list()); return asides(file).length === 1; })());
  const added = s2.save({ name: 'other', title: 'Other', description: 'd', prompt: 'x' });
  check('skills: a user save then writes, and the old bytes are in the copy', added.ok === true && fs.readFileSync(path.join(d, asides(file)[0]), 'utf8') === GARBAGE && skills.createStore({ file }).list().some((s) => s.name === 'other'), JSON.stringify(added));

  check('skills: the kept copy of a good file can be put back', (() => { fs.writeFileSync(file, good); return skills.createStore({ file }).list().some((s) => s.name === 'my-skill'); })());
}

// ---- macros (macros.js createStore)
{
  const d = tmp(); const file = path.join(d, 'macros.json');
  const m1 = macros.createStore({ file, platform: 'win32' });
  const made = m1.save({ name: 'hello', steps: [{ type: 'wait', seconds: 1 }] });
  check('macros: no file starts empty and a save works', m1.list().length === 1 && made.ok === true && fs.existsSync(file), JSON.stringify(made));
  fs.writeFileSync(file, GARBAGE);
  const m2 = macros.createStore({ file, platform: 'win32' });
  check('macros: an unreadable file loads empty and a copy is set aside', quiet(() => m2.list()).length === 0 && asides(file).length === 1);
  check('macros: a second load of the same file makes no second copy', (() => { quiet(() => macros.createStore({ file, platform: 'win32' }).list()); return asides(file).length === 1; })());
  check('macros: the file was not written by loading it', fs.readFileSync(file, 'utf8') === GARBAGE);
  const again = m2.save({ name: 'again', steps: [{ type: 'wait', seconds: 1 }] });
  check('macros: a user save then writes, and the old bytes are in the copy', again.ok === true && fs.readFileSync(path.join(d, asides(file)[0]), 'utf8') === GARBAGE && macros.createStore({ file, platform: 'win32' }).list().length === 1, JSON.stringify(again));
}

// ---- MCP servers (mcp-client.js; the write is atomic now too)
{
  const d = tmp(); const file = path.join(d, 'mcp-servers.json');
  const secrets = { available: () => true, encrypt: (v) => v, decrypt: (v) => v };
  const add = (c) => c.save({ name: 'docs', type: 'http', url: 'https://example.com/mcp' });
  const c1 = mcp.create({ userData: d, version: '1', secrets });
  check('mcp: no file lists no servers', c1.list().length === 0);
  add(c1);
  check('mcp: a server saves, and the write leaves no temp file behind', fs.existsSync(file) && fs.readdirSync(d).every((n) => !n.endsWith('.tmp')));
  check('mcp: the saved server survives a reload', mcp.create({ userData: d, version: '1', secrets }).list().length === 1);
  fs.writeFileSync(file, GARBAGE);
  const c2 = quiet(() => mcp.create({ userData: d, version: '1', secrets }));
  check('mcp: an unreadable file lists nothing and a copy is set aside', c2.list().length === 0 && asides(file).length === 1);
  check('mcp: loading did not write the file, and a second load makes no second copy', fs.readFileSync(file, 'utf8') === GARBAGE && (quiet(() => mcp.create({ userData: d, version: '1', secrets })), asides(file).length === 1));
  add(c2);
  check('mcp: adding a server then writes, and the old bytes are in the copy', fs.readFileSync(path.join(d, asides(file)[0]), 'utf8') === GARBAGE && mcp.create({ userData: d, version: '1', secrets }).list().length === 1);
}

// ---- chat store: trusted() says whether the list may decide what gets deleted (images, uploads, project folders)
{
  const enc = (s) => Buffer.from(s, 'utf8').toString('base64');
  const dec = (s) => Buffer.from(s, 'base64').toString('utf8');
  const snap = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }, { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] };
  const open = (dir, decrypt = dec) => createChatStore({ dir, encrypt: enc, decrypt });
  const d1 = tmp();
  check('chat store: a brand-new profile is trusted (nothing to lose)', open(d1).trusted() === true);
  const s = open(d1); s.save(s.newId(), snap); s.saveProject({ name: 'Thesis' }); s.flush?.();
  const healthy = open(d1);
  check('chat store: a healthy index is trusted', healthy.trusted() === true && healthy.projects().length === 1 && healthy.list().length === 1);
  // The index can't be decrypted: set aside and rebuilt from the chat files, which loses the projects.
  const broken = open(d1, () => { throw new Error('keychain'); });
  const r = quiet(() => ({ trusted: broken.trusted(), projects: broken.projects().length }));
  check('chat store: a rebuilt index is not trusted, so no purge runs on its empty projects list', r.trusted === false && r.projects === 0, JSON.stringify(r));
  check('chat store: the bad index was set aside, not deleted', fs.readdirSync(d1).some((n) => n.startsWith('index.json.corrupt-')));
  // Index missing while chat files exist: also a rebuild.
  const d2 = tmp(); const s2 = open(d2); s2.save(s2.newId(), snap); s2.flush?.();
  fs.rmSync(path.join(d2, 'index.json'), { force: true });
  check('chat store: chat files without an index are rebuilt and not trusted', open(d2).trusted() === false);
  // Index unreadable right now (a folder in its place): degraded, not trusted.
  const d3 = tmp(); fs.mkdirSync(path.join(d3, 'index.json'));
  check('chat store: an unreadable index is degraded and not trusted', open(d3).trusted() === false);
}

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
