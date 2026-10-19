// Moving chats between projects (features/chat-store.js moveToProject / restoreProjects), and the selection rules of
// renderer/chat-project-drag.js (Ctrl+click toggles, Shift+click selects a range, platform pinned). Plain Node; every folder is a temp folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createChatStore } = require('../src/features/chat-store');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-project-drag-'));
const enc = (t) => Buffer.from(t).toString('base64');
const dec = (b) => Buffer.from(b, 'base64').toString();
const snap = (text) => ({ settings: {}, messages: [{ role: 'user', content: [{ type: 'text', text }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] });
let clock = 1000;
const mk = (dir) => createChatStore({ dir, encrypt: enc, decrypt: dec, now: () => ++clock });
const readIndexFile = (dir) => JSON.parse(dec(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).enc));
const entry = (store, id) => store.list().find((c) => c.id === id);

{
  const dir = path.join(root, 'store');
  const store = mk(dir);
  const ids = ['a', 'b', 'c', 'd'].map((n) => { const id = store.newId(); store.save(id, snap(`chat ${n}`)); return id; });
  const [a, b, c, d] = ids;
  const zoo = store.saveProject({ name: 'Zoo' });
  const art = store.saveProject({ name: 'Art' });
  const order = () => store.list().map((x) => x.id).join();
  const stamps = () => JSON.stringify(store.list().map((x) => [x.id, x.updated]));
  const orderBefore = order();
  const stampsBefore = stamps();

  const one = store.moveToProject([a], zoo.id);
  check('move: one chat goes into the project and the answer names where it came from', one.length === 1 && one[0].id === a && one[0].from === null && entry(store, a).project === zoo.id, JSON.stringify(one));
  check('move: moving is not activity (order and updated times are unchanged)', order() === orderBefore && stamps() === stampsBefore, `${order()} vs ${orderBefore}`);

  const many = store.moveToProject([b, c, a, 'nope', b], zoo.id);
  check('multi-move: every chat that was not already there moves, once each; unknown ids and chats already in it are left out', many.map((m) => m.id).sort().join() === [b, c].sort().join() && ids.slice(0, 3).every((id) => entry(store, id).project === zoo.id) && entry(store, d).project === undefined, JSON.stringify(many));
  check('multi-move: one write for all of them (the index on disk has all three)', readIndexFile(dir).chats.filter((x) => x.project === zoo.id).length === 3);
  check('dropping on its own project does nothing', store.moveToProject([a], zoo.id).length === 0);

  const across = store.moveToProject([a, d], art.id);
  check('moving between projects remembers each chat\'s earlier project', across.find((m) => m.id === a).from === zoo.id && across.find((m) => m.id === d).from === null, JSON.stringify(across));

  const out = store.moveToProject([a, b, d], null);
  check('remove from project: chats leave their projects (those in none are left out)', out.length === 3 && [a, b, d].every((id) => entry(store, id).project === undefined) && entry(store, c).project === zoo.id, JSON.stringify(out));
  check('remove from project: the field is gone from the index, not just empty', readIndexFile(dir).chats.filter((x) => x.id === a).every((x) => !('project' in x)));

  store.moveToProject([a, b], zoo.id);
  const undoable = store.moveToProject([a, b, d], art.id);
  check('undo: every chat goes back to the project it came from', store.restoreProjects(undoable) === 3 && entry(store, a).project === zoo.id && entry(store, b).project === zoo.id && entry(store, d).project === undefined, JSON.stringify(store.list().map((x) => x.project)));
  check('undo: to a project that was deleted meanwhile leaves the chat in none', (() => { const m = store.moveToProject([a], art.id); store.removeProject(zoo.id); store.restoreProjects(m); return entry(store, a).project === undefined; })());
  check('recency: after all of it, the order and every updated time are as they were', order() === orderBefore && stamps() === stampsBefore, `${order()} vs ${orderBefore}`);

  check('an unknown project and a trashed chat are refused or skipped', store.moveToProject([c], 'f'.repeat(16)) === null && (() => { store.trash(c); const r = store.moveToProject([c], art.id); store.restore(c); return r.length === 0; })());
  check('it persists: a new store reads the moves back', (() => { store.moveToProject([c], art.id); const again = mk(dir); return again.projectOf(c)?.name === 'Art'; })());
}

// ---- the selection rules, with a small fake DOM (renderer/chat-project-drag.js)
{
  const listeners = { items: {}, document: {} };
  const rows = ['r1', 'r2', 'r3', 'r4'].map((id) => ({ dataset: { id }, classList: { set: new Set(), toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); } } }));
  const items = {
    addEventListener(type, fn) { listeners.items[type] = fn; },
    querySelectorAll() { return rows; },
    classList: { toggle() {} },
    contains: () => false,
  };
  const platform = { mac: false };
  global.window = { chatTr: (k, en) => en, matchMedia: () => ({ matches: false }), addEventListener() {} };
  global.document = {
    documentElement: { classList: { contains: () => platform.mac } },
    body: { classList: { add() {}, remove() {} } },
    addEventListener(type, fn) { listeners.document[type] = fn; },
    querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), elementFromPoint: () => null,
  };
  require('../src/renderer/chat-project-drag.js');
  const said = [];
  const chats = rows.map((r) => ({ id: r.dataset.id }));
  const drag = window.chatProjectDrag.create({ items, host: { querySelectorAll: () => [], querySelector: () => null, append() {} }, chats: () => chats, projects: () => [], isExpanded: () => false, expand() {}, announce: (t) => said.push(t), move() {} });
  const click = (row, mods = {}) => {
    const ev = { target: { closest: (sel) => (sel === '.chat-item[data-id]' ? { dataset: row.dataset } : sel === '.chat-open' ? {} : null) }, ctrlKey: false, metaKey: false, shiftKey: false, ...mods, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    listeners.items.click(ev);
    return ev;
  };
  const ids = () => drag.selection.ids().join();
  let ev = click(rows[1], { ctrlKey: true });
  check('Ctrl+click picks a row and does not also open it', ids() === 'r2' && ev.prevented && ev.stopped && rows[1].classList.set.has('selected'));
  click(rows[3], { ctrlKey: true });
  check('Ctrl+click on another row adds it', ids() === 'r2,r4', ids());
  click(rows[1], { ctrlKey: true });
  check('Ctrl+click on a picked row drops it', ids() === 'r4' && !rows[1].classList.set.has('selected'), ids());
  click(rows[0], { ctrlKey: true });
  click(rows[2], { shiftKey: true });
  check('Shift+click picks the rows between the last pick and this one', ids() === 'r1,r3,r4' || ids() === 'r1,r2,r3,r4', ids());
  check('a selection is announced', said.length > 0 && /selected/.test(said.at(-1)), said.join('|'));
  ev = click(rows[2]);
  check('a plain click clears the selection and is left to open the chat', ids() === '' && !ev.prevented && !ev.stopped, ids());
  platform.mac = true;
  click(rows[1], { ctrlKey: true });
  check('on a Mac, Ctrl+click is not a pick (it is the context menu)', ids() === '', ids());
  click(rows[1], { metaKey: true });
  check('on a Mac, Cmd+click is', ids() === 'r2', ids());
  platform.mac = false;
  drag.selection.clear();
  check('clear empties it', ids() === '' && !rows[1].classList.set.has('selected'));
}

try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
