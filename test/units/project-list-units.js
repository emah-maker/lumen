// [project list] Many projects: the store's pinned / archived flags (features/chat-store.js setProjectFlag), the rail's order and
// filter (renderer/chat-projects.js arrange: pinned first, Recent or A–Z, a query on the name and goal, a compact list with the open
// project always in it, archived ones apart), and the wiring (the IPC channel, the preload, the chat page, the tab menu). Plain Node.
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createChatStore } = require('../../src/features/chat-store');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const src = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');

// the renderer file in a bare context: only arrange() is used, which touches no DOM
const sandbox = { window: {}, document: {}, localStorage: { getItem: () => null, setItem() {} } };
vm.runInNewContext(src('src/renderer/chat-projects.js'), sandbox);
const { arrange } = sandbox.window.chatProjects;

// ---- the store
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-project-list-'));
  let clock = 1000;
  const enc = (t) => Buffer.from(t).toString('base64');
  const store = createChatStore({ dir, encrypt: enc, decrypt: (b) => Buffer.from(b, 'base64').toString(), now: () => ++clock });
  const a = store.saveProject({ name: 'Alpha' });
  const before = store.projects()[0].updated;
  check('flag: pin a project', store.setProjectFlag(a.id, 'pinned', true) && store.projects()[0].pinned === true);
  check('flag: pinning is not a change to the project (Recent keeps its place)', store.projects()[0].updated === before);
  check('flag: archiving takes the pin off', store.setProjectFlag(a.id, 'archived', true) && store.projects()[0].archived === true && !store.projects()[0].pinned);
  check('flag: and back', store.setProjectFlag(a.id, 'archived', false) && !store.projects()[0].archived);
  check('flag: an unknown flag or project is refused', !store.setProjectFlag(a.id, 'name', true) && !store.setProjectFlag('ffffffffffffffff', 'pinned', true));
  store.setProjectFlag(a.id, 'pinned', true);
  store.flush?.();
  const again = createChatStore({ dir, encrypt: enc, decrypt: (b) => Buffer.from(b, 'base64').toString(), now: () => ++clock });
  check('flag: kept on disk', again.projects()[0].pinned === true);
}

// ---- the rail's order
{
  const P = (id, name, updated, extra = {}) => ({ id, name, updated, created: 1, ...extra });
  const projects = [P('a', 'Zebra study', 10), P('b', 'apple orchard', 50), P('c', 'Mango', 30, { pinned: true }), P('d', 'Old thing', 99, { archived: true }), P('e', 'Kiwi', 20, { description: 'thesis on birds' })];
  const chats = [{ id: 'x', project: 'a', updated: 100 }];
  const names = (r) => r.list.map((p) => p.name).join(',');
  check('order: pinned first, then the most recently used (a project\'s newest chat counts)', names(arrange(projects, chats)) === 'Mango,Zebra study,apple orchard,Kiwi', names(arrange(projects, chats)));
  check('order: A–Z ignores case, pinned still first', names(arrange(projects, chats, { sort: 'name' })) === 'Mango,apple orchard,Kiwi,Zebra study', names(arrange(projects, chats, { sort: 'name' })));
  check('archived: out of the list, counted apart, and listed on their own', !names(arrange(projects, chats)).includes('Old') && arrange(projects, chats).archived === 1 && names(arrange(projects, chats, { archived: true })) === 'Old thing');
  check('find: matches the name or the goal line, any case', names(arrange(projects, chats, { query: 'BIRDS' })) === 'Kiwi' && names(arrange(projects, chats, { query: 'apple' })) === 'apple orchard');
  const many = Array.from({ length: 14 }, (_, i) => P(`p${i}`, `Project ${i}`, i));
  many[0].pinned = true;
  const short = arrange(many, []);
  check('compact: 8 shown, the rest behind "Show N more", a pin kept even when old', short.list.length === 8 && short.hidden === 6 && short.list[0].id === 'p0', JSON.stringify([short.list.length, short.hidden]));
  const keep = arrange(many, [], { keep: 'p1' });
  check('compact: the open project is shown even when it would be cut', keep.list.some((p) => p.id === 'p1') && keep.hidden === 5);
  check('compact: Show all and a query list everything', arrange(many, [], { all: true }).list.length === 14 && arrange(many, [], { query: 'project' }).list.length === 14);
}

// ---- wiring
{
  const main = src('src/main.js');
  check('main: chats:project-flag is served and on the UI channel list', /ipcMain\.handle\('chats:project-flag'/.test(main) && /'chats:project-defaults', 'chats:project-flag',/.test(main));
  check('chat page: the channel is allowed and the preload has projectFlag', /'chats:project-flag'/.test(src('src/features/chat-page.js')) && /projectFlag: \(id, key, on\) => ipcRenderer\.invoke\('chats:project-flag'/.test(src('src/features/chat-preload.js')));
  check('chat page: the rail gets onFlag and archiving offers Undo', /onFlag: \(p, key, on\) => flagProject/.test(src('src/renderer/chat-page.js')) && /projectws\.list\.archivedToast/.test(src('src/renderer/chat-page.js')));
  check('tab menu: Add to project leaves archived projects out, pinned first', /filter\(\(p\) => !p\.archived\)\.sort\(\(a, b\) => Number\(Boolean\(b\.pinned\)\)/.test(main));
  const rail = src('src/renderer/chat-projects.js');
  check('rail: the ⋯ menu has Pin to top / Unpin and Archive / Move out of archive', ['projectws.list.pin', 'projectws.list.unpin', 'projectws.list.archive', 'projectws.list.unarchive'].every((k) => rail.includes(k)));
  check('picker: archived projects are left out and a filter shows when there are many', /p\.archived \|\| p\.id === chat\.project/.test(rail) && /cp-pj-pick-find/.test(rail));
  const en = JSON.parse(src('src/locales/en.json'));
  check('strings: the list\'s text is in en.json', ['projectws.list.find', 'projectws.list.more', 'projectws.list.archived', 'projectws.list.sortRecent', 'projectws.list.sortName'].every((k) => typeof en[k] === 'string'));
}

console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
process.exit(failures ? 1 : 0);
