// features/chat-page.js fromHome: the new-tab page's Chat button. The tab turns into the chat page (or a new tab opens), and text
// typed in the new-tab box is handed to that chat page once, as a draft, through its first chatpage:state call.
const assert = require('assert');
const chatPage = require('../src/features/chat-page');

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

// A very long draft is cut, not refused.
rt.fromHome(9, { draft: 'x'.repeat(30000), inNewTab: true });
assert.strictEqual(stateFor(50).draft.length, 20000);

console.log('PASS  chat-page-from-home-units');
