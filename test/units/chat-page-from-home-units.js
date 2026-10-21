// features/chat-page.js fromHome: the new-tab page's Ask AI. The tab turns into the chat page (or a new tab opens), and text
// typed in the new-tab box is handed to that chat page once, through its first chatpage:state call: as a draft, or (send) to be asked.
const assert = require('assert');
const chatPage = require('../../src/features/chat-page');

const handlers = {};
const ipcMain = { on: (c, f) => { handlers[c] = f; }, handle: (c, f) => { handlers[c] = f; } };
const tabs = [];
const sent = [];
const wcOf = (id) => ({ id, send: () => {}, isDestroyed: () => false });
const addChatTab = (id) => { const t = { id, managerPage: 'chat', view: { webContents: wcOf(id) } }; tabs.push(t); return t; };
const calls = [];
const rt = chatPage.create({
  ipcMain, tabs: () => tabs, alive: () => true, ui: () => ({ send: (...a) => sent.push(a), isDestroyed: () => false }),
  openTab: (url, opts) => { calls.push(['openTab', url, opts]); return addChatTab(50); },
  goChat: (id) => { calls.push(['goChat', id]); addChatTab(60); return 60; },
  chatView: () => ({ id: 'c1' }), switchTab: () => {}, requestCloseTab: () => {}, goHome: () => {}, managersOpen: () => 1, isPrivateSender: () => false, tabInfo: () => null, agentOffLimits: () => false,
});
rt.register();
const stateFor = (id) => handlers['chatpage:state']({ sender: tabs.find((t) => t.id === id).view.webContents });

// In place: the tab itself becomes the chat; the draft waits for that page's first state call, once.
assert.strictEqual(rt.fromHome(7, { draft: 'plan a trip' }), 60);
assert.deepStrictEqual(calls[0], ['goChat', 7]);
assert.deepStrictEqual(sent[0], ['chat:sidebar', false], 'the sidebar folds away, as when the page opens from it');
assert.strictEqual(stateFor(60).draft, 'plan a trip');
assert.strictEqual(stateFor(60).draft, '', 'handed over once');

// Nothing typed: no draft. Whitespace only counts as nothing.
rt.fromHome(8, { draft: '   ' });
assert.strictEqual(stateFor(60).draft, '');

// A new tab (Ctrl/middle-click): opened as a chat tab; the draft goes to that one.
assert.strictEqual(rt.fromHome(9, { draft: 'second', inNewTab: true }), 50);
assert.strictEqual(calls[calls.length - 1][0], 'openTab');
assert.strictEqual(calls[calls.length - 1][1], chatPage.CHAT_URL);
assert.deepStrictEqual(calls[calls.length - 1][2], { managerPage: 'chat' });
assert.strictEqual(stateFor(50).draft, 'second');

// Enter in Ask AI: the same hand-over, flagged to be asked (once); an empty one is nothing to ask.
assert.strictEqual(stateFor(60).send, false);
rt.fromHome(11, { draft: 'what is 2+2', send: true });
assert.deepStrictEqual([stateFor(60).draft, stateFor(60).send], ['what is 2+2', false], 'taken once: the second read is empty');
rt.fromHome(11, { draft: 'again', send: true });
const once = stateFor(60);
assert.strictEqual(once.draft, 'again');
assert.strictEqual(once.send, true);
rt.fromHome(11, { draft: '  ', send: true });
assert.strictEqual(stateFor(60).send, false);

// A very long draft is cut, not refused.
rt.fromHome(9, { draft: 'x'.repeat(30000), inNewTab: true });
assert.strictEqual(stateFor(50).draft.length, 20000);

// Pictures from the box (already checked by main) ride with the draft, once, and an Ask with only pictures still carries them.
const img = (n) => ({ type: 'image/png', name: n, data: Buffer.from([1, 2, 3]) });
rt.fromHome(12, { draft: 'look', images: [img('a.png'), img('b.png')], send: true });
const withPics = stateFor(60);
assert.deepStrictEqual([withPics.draft, withPics.send, withPics.images.map((i) => i.name)], ['look', true, ['a.png', 'b.png']]);
assert.deepStrictEqual(stateFor(60).images, [], 'taken once');
rt.fromHome(12, { draft: '', images: [img('c.png')], send: true });
assert.strictEqual(stateFor(60).images.length, 1, 'pictures alone are something to ask');
rt.fromHome(12, { draft: '' });
assert.deepStrictEqual(stateFor(60).images, []);

// Plain Ask AI (nothing typed): the page opens on a NEW chat (the page asks main's state, sees fresh, and presses New chat), once.
rt.fromHome(13, {});
assert.strictEqual(stateFor(60).fresh, true, 'nothing typed: open on a new chat');
assert.strictEqual(stateFor(60).fresh, false, 'asked for once');
rt.fromHome(13, { draft: 'plan a trip' });
assert.strictEqual(stateFor(60).fresh, false, 'text typed: asked in its own new chat instead');
rt.fromHome(13, { draft: '', images: [img('d.png')], send: true });
assert.strictEqual(stateFor(60).fresh, false, 'pictures only: they start their own new chat');

console.log('PASS  chat-page-from-home-units');
