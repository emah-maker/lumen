// A chat page tab keeps the chat it was left on (features/chat-page.js broadcast + features/tab-chats.js bindings): a sync or a run
// of another chat, started in the sidebar or another tab, never replaces what the page shows. Pure node.
const assert = require('assert');
const { create } = require('../src/features/chat-page');
const { createBindings } = require('../src/features/tab-chats');

let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${e.message}`); } };

const world = () => {
  const bind = createBindings();
  const sent = [];
  const mk = (id) => ({ id, managerPage: 'chat', closing: false, view: { webContents: { isDestroyed: () => false, send: (ch, p) => sent.push({ to: `page${id}`, ch, p }) } } });
  const pages = [mk(10), mk(11)];
  const ui = { isDestroyed: () => false, send: (ch, p) => sent.push({ to: 'ui', ch, p }) };
  const rt = create({ ipcMain: { on() {}, handle() {} }, tabs: () => pages, allTabs: () => pages, alive: () => true, ui: () => ui, chatOf: (id) => bind.chatOf(id) });
  return { bind, sent, rt };
};
const got = (sent, to, ch) => sent.filter((m) => m.to === to && m.ch === ch);

test('a page bound to chat A ignores a sync of chat B and takes one of A', () => {
  const { bind, sent, rt } = world();
  bind.bind(10, 'A');
  rt.broadcast('chat:sync', { view: { id: 'B' } });
  assert.strictEqual(got(sent, 'page10', 'chat:sync').length, 0);
  assert.strictEqual(got(sent, 'ui', 'chat:sync').length, 1);
  rt.broadcast('chat:sync', { view: { id: 'A' } });
  assert.strictEqual(got(sent, 'page10', 'chat:sync').length, 1);
});

test('each page gets only its own chat', () => {
  const { bind, sent, rt } = world();
  bind.bind(10, 'A'); bind.bind(11, 'B');
  rt.broadcast('chat:sync', { view: { id: 'B' } });
  assert.strictEqual(got(sent, 'page10', 'chat:sync').length, 0);
  assert.strictEqual(got(sent, 'page11', 'chat:sync').length, 1);
});

test('a page with no chat of its own takes every sync, and so does a sync with no chat id', () => {
  const { bind, sent, rt } = world();
  rt.broadcast('chat:sync', { view: { id: 'B' } });
  assert.strictEqual(got(sent, 'page10', 'chat:sync').length, 1);
  bind.bind(10, 'A');
  rt.broadcast('chat:sync', { view: null });
  assert.strictEqual(got(sent, 'page10', 'chat:sync').length, 2);
});

test('a run of another chat does not start a turn in a page showing a different chat', () => {
  const { bind, sent, rt } = world();
  bind.bind(10, 'A');
  rt.broadcast('chat:run-start', { text: 'hi', chatId: 'B' });
  assert.strictEqual(got(sent, 'page10', 'chat:run-start').length, 0);
  rt.broadcast('chat:run-start', { text: 'hi', chatId: 'A' });
  assert.strictEqual(got(sent, 'page10', 'chat:run-start').length, 1);
});

test('other channels still reach every page', () => {
  const { bind, sent, rt } = world();
  bind.bind(10, 'A');
  rt.broadcast('chats:changed', null);
  assert.strictEqual(got(sent, 'page10', 'chats:changed').length, 1);
});

if (failures) { console.log(`${failures} failed`); process.exit(1); }
