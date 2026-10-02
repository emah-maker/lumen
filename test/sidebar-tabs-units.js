// The per-tab sidebar state (features/sidebar-tabs.js): open and close, tabs that share a chat, a new tab, the saved
// session, and a closed tab. Pure node.
const assert = require('assert');
const { create } = require('../src/features/sidebar-tabs');
const { createBindings } = require('../src/features/tab-chats');

let failures = 0;
const test = (name, fn) => { try { fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${e.message}`); } };

// The sharers of a tab, as main.js asks it of the chat bindings.
const world = () => {
  const bind = createBindings();
  const st = create();
  const sharers = (id) => { const c = bind.chatOf(id); return c ? bind.tabsOf(c).filter((t) => t !== id) : []; };
  return { bind, st, sharers, open: (id) => st.isOpen(id, sharers(id)), set: (id, v) => st.set(id, v, sharers(id)) };
};

test('a tab nobody opened the sidebar in starts closed', () => {
  const { open } = world();
  assert.strictEqual(open(1), false);
});

test('opening in tab A leaves tab B as it was', () => {
  const { open, set, bind } = world();
  bind.bind(1, 'chatA'); bind.bind(2, 'chatB');
  set(1, true);
  assert.strictEqual(open(1), true);
  assert.strictEqual(open(2), false);
  set(2, true); set(1, false);
  assert.strictEqual(open(1), false);
  assert.strictEqual(open(2), true);
});

test('tabs bound to the same chat share the state, both ways', () => {
  const { open, set, bind } = world();
  bind.bind(1, 'chat'); bind.bind(2, 'chat'); bind.bind(3, 'other');
  const written = set(1, true);
  assert.deepStrictEqual(written.sort(), [1, 2]);
  assert.strictEqual(open(2), true);
  assert.strictEqual(open(3), false);
  set(2, false);
  assert.strictEqual(open(1), false);
  assert.strictEqual(open(2), false);
});

test('a tab that joins a chat takes the state the chat has', () => {
  const { open, set, bind } = world();
  bind.bind(1, 'chat');
  set(1, true);
  bind.bind(2, 'chat'); // "Also show in this tab"
  assert.strictEqual(open(2), true);
  set(2, false);
  assert.strictEqual(open(1), false);
});

test('a tab that leaves a shared chat keeps what it showed', () => {
  const { open, set, bind } = world();
  bind.bind(1, 'chat'); bind.bind(2, 'chat');
  set(1, true);
  bind.bind(2, 'fresh'); // tab 2 starts a new chat
  assert.strictEqual(open(1), true);
  assert.strictEqual(open(2), true);
  set(2, false); // now on its own
  assert.strictEqual(open(1), true);
  assert.strictEqual(open(2), false);
});

test('a newer answer on a tab wins over an older one on a tab it shares with', () => {
  const { st } = world();
  st.set(1, true); // written while alone
  st.set(2, false); // a separate tab 2 that later joins tab 1's chat
  assert.strictEqual(st.isOpen(1, [2]), false);
  assert.strictEqual(st.isOpen(2, [1]), false);
});

test('defaultOpen makes tabs without an answer start open, and an answer still wins', () => {
  const st = create({ defaultOpen: true });
  assert.strictEqual(st.isOpen(5), true);
  st.set(5, false);
  assert.strictEqual(st.isOpen(5), false);
  assert.strictEqual(st.isOpen(6), true);
});

test('closing a tab forgets it; a new tab with another id starts closed', () => {
  const { st, set, open } = world();
  set(1, true);
  assert.strictEqual(st.size(), 1);
  st.forget(1);
  assert.strictEqual(st.size(), 0);
  assert.strictEqual(open(1), false);
  assert.strictEqual(open(2), false);
});

test('a closed sharer does not hold the state of the others', () => {
  const { st, bind, set, open } = world();
  bind.bind(1, 'chat'); bind.bind(2, 'chat');
  set(1, true);
  st.forget(1); bind.unbindTab(1);
  assert.strictEqual(open(2), true);
  set(2, false);
  assert.strictEqual(open(2), false);
});

test('snapshot and restore: one flag per tab, in order, new tab ids', () => {
  const { st, bind, set, sharers } = world();
  bind.bind(1, 'a'); bind.bind(2, 'b'); bind.bind(3, 'a');
  set(1, true); // tab 3 shares chat a
  const saved = st.snapshot([1, 2, 3], sharers);
  assert.deepStrictEqual(saved, [true, false, true]);
  const fresh = create();
  fresh.restore([10, 11, 12], JSON.parse(JSON.stringify(saved)));
  assert.deepStrictEqual([10, 11, 12].map((id) => fresh.isOpen(id)), [true, false, true]);
});

test('restore ignores junk', () => {
  const st = create();
  st.restore([1, 2, 3], ['yes', 1, null]);
  st.restore(null, null);
  st.restore([4], undefined);
  assert.deepStrictEqual([1, 2, 3, 4].map((id) => st.isOpen(id)), [false, false, false, false]);
});

test('set with no tab does nothing', () => {
  const st = create();
  assert.deepStrictEqual(st.set(null, true), []);
  assert.strictEqual(st.size(), 0);
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
