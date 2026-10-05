// The sidebar's chat history (features/chat-store.js, renderer/chats.js) and the usage line
// (features/chat-usage.js), with a fake Claude client: no network, no key needed.
// Covers: moving the old single chat.json into the list, New chat keeping the old chat, reopening
// one, rename, export, delete, token/cost totals, and approved sites staying with their chat.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 6000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(100); } return v; };

// A fake Claude key keeps the picker, and so the agent, on the Claude API even when this machine
// has Claude Code installed; the client itself is swapped for a fake below.
const launch = (profile) => electron.launch({
  args: [path.join(__dirname, '..')],
  env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
});

// Every reply is "Reply N." and reports 1000 input + 200 output tokens (claude-opus-5: $0.01).
const fakeClient = (app) => app.evaluate(() => {
  let n = 0;
  global.__agent.getClient = () => ({ beta: { messages: { stream: () => {
    const text = `Reply ${++n}.`;
    const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 200 } };
    return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; }, finalMessage: async () => message };
  } } } });
});

(async () => {
  // A chat row's buttons show, and take clicks, while the row is hovered (#130), as a mouse does.
  const rowAction = async (id, cls) => { await ui.hover(`.chat-item[data-id="${id}"]`); await new Promise((r) => setTimeout(r, 200)); await ui.click(`.chat-item[data-id="${id}"] ${cls}`); };
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-chats-'));

  // ---- 1. A chat saved by an older Lumen (chat.json) becomes the first entry in the list.
  let app = await launch(profile);
  let ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const snapshot = { settings: { model: 'claude-opus-5' }, messages: [
    { role: 'user', content: [{ type: 'text', text: '<browser_state>\nActive tab id: 1\n</browser_state>\n\nlegacy question about tides' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Legacy answer.' }] },
  ] };
  const legacy = await app.evaluate(({ app: electronApp, safeStorage }, text) => ({
    userData: electronApp.getPath('userData'),
    available: safeStorage.isEncryptionAvailable(),
    enc: safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text).toString('base64') : null,
  }), JSON.stringify(snapshot));
  check('OS encryption is available for this test', legacy.available, 'safeStorage unavailable');
  await app.close();
  legacy.file = path.join(legacy.userData, 'chat.json');
  fs.writeFileSync(legacy.file, JSON.stringify({ enc: legacy.enc }));

  app = await launch(profile);
  ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  const chatsDir = path.join(userData, 'chats');
  const restored = await waitFor(() => ui.evaluate(() => [...document.querySelectorAll('.msg.user')].map((e) => e.textContent).join('|')));
  check('the old chat.json is shown after the update', /legacy question about tides/.test(restored || ''), restored);
  check('chat.json is gone after moving into the list', !fs.existsSync(legacy.file), legacy.file);
  let list = await app.evaluate(() => global.__chats.store().list());
  check('the old chat is the first entry, titled from its first message', list.length === 1 && list[0].title === 'legacy question about tides', JSON.stringify(list));
  const legacyId = list[0]?.id;
  const onDisk = fs.readdirSync(chatsDir).map((f) => fs.readFileSync(path.join(chatsDir, f), 'utf8')).join('\n');
  check('chats and the index are encrypted on disk', onDisk.includes('"enc"') && !/tides|Legacy answer/.test(onDisk), onDisk.slice(0, 200));
  check('a restored chat counts as having read content', await app.evaluate(() => global.__agent.messages.tainted === true), 'not tainted');

  // ---- 2. Usage: each reply adds its tokens and estimated cost to the chat's line.
  await fakeClient(app);
  await app.evaluate(() => global.__agent.approvedHosts.add('approved-in-legacy.test'));
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.fill('#prompt', 'first follow-up about the tides');
  await ui.press('#prompt', 'Enter');
  await waitFor(() => ui.evaluate(() => /Reply 1\./.test(document.getElementById('messages').textContent)));
  let usage = await waitFor(() => ui.evaluate(() => { const el = document.getElementById('chat-usage'); return !el.hidden && el.textContent; }));
  check('usage line shows tokens and cost after a reply', usage === '1.2k tokens · ~$0.01', usage);
  await ui.fill('#prompt', 'second follow-up');
  await ui.press('#prompt', 'Enter');
  await waitFor(() => ui.evaluate(() => /Reply 2\./.test(document.getElementById('messages').textContent)));
  usage = await waitFor(() => ui.evaluate(() => { const t = document.getElementById('chat-usage').textContent; return /2\.4k/.test(t) && t; }));
  check('usage adds up across replies', usage === '2.4k tokens · ~$0.02', usage);
  // [context] The ring left of Send: the last request's input against the model's window.
  const ring = () => ui.evaluate(() => { const el = document.getElementById('context-meter'); return el ? { hidden: el.hidden, label: el.getAttribute('aria-label'), title: el.title } : null; });
  const ringShown = await waitFor(async () => { const r = await ring(); return r && !r.hidden && r; });
  check('context ring shows after a reply, with its numbers', ringShown && /^Context \d+% used$/.test(ringShown.label) && /\(1\.0k of 200\.0k tokens\)/.test(ringShown.title), JSON.stringify(ringShown));
  check('context strip: above the textbox, reads "Context 1k / 200k" with a bar', await ui.evaluate(() => { const el = document.getElementById('context-meter'); const strip = document.getElementById('meter-strip'); return el.textContent === 'Context 1k / 200k' && el.querySelector('[role=progressbar]') && !strip.hidden && strip.parentElement === document.getElementById('composer') && Boolean(strip.compareDocumentPosition(document.getElementById('prompt')) & Node.DOCUMENT_POSITION_FOLLOWING); }), await ui.evaluate(() => `${document.getElementById('context-meter').textContent} | next=${document.getElementById('meter-strip').nextElementSibling?.id}`));
  // [usage bars] A chat on a Claude API key has the context ring and the tokens line but no plan bar: there are no plan numbers to show.
  check('usage bars: an API-key chat shows its context ring and tokens, and no made-up plan bar', await ui.evaluate(() => { const m = document.getElementById('usage-meter'); return (!m || m.hidden) && document.querySelectorAll('.model-picker .ubar, #composer .ubar').length === 0; }), 'a plan bar is showing');
  const saved = await app.evaluate((_e, id) => global.__chats.store().load(id)?.settings?.usage, legacyId);
  check('usage is saved with the chat', saved?.input === 2000 && saved?.output === 400 && saved?.turns === 2, JSON.stringify(saved));

  // ---- 3. New chat keeps the old one in the list; an empty chat adds nothing.
  await ui.click('#new-chat');
  check('New chat empties the sidebar', await waitFor(() => ui.evaluate(() => !document.querySelector('.msg') && document.getElementById('chat-usage').hidden)), 'still shows messages');
  check('New chat hides the context ring', await waitFor(async () => (await ring())?.hidden === true), JSON.stringify(await ring()));
  check('New chat starts with no approved sites', await app.evaluate(() => global.__agent.approvedHosts.size === 0), 'hosts carried over');
  await ui.click('#new-chat');
  list = await app.evaluate(() => global.__chats.store().list());
  check('the previous chat stays in the list; empty chats are not listed', list.length === 1 && list[0].id === legacyId, JSON.stringify(list.map((c) => c.title)));
  await ui.fill('#prompt', 'a brand new topic');
  await ui.press('#prompt', 'Enter');
  await waitFor(() => ui.evaluate(() => /Reply 3\./.test(document.getElementById('messages').textContent)));
  await app.evaluate(() => global.__agent.approvedHosts.add('approved-in-new.test'));
  list = await waitFor(async () => { const l = await app.evaluate(() => global.__chats.store().list()); return l.length === 2 && l; });
  check('the new chat is listed first after its first reply', list && list[0].title === 'a brand new topic' && list[1].id === legacyId, JSON.stringify((list || []).map((c) => c.title)));
  const newId = list?.[0]?.id;

  // ---- 4. The list in the sidebar: open the older chat.
  await ui.click('#chat-history');
  await ui.waitForSelector('#chat-list:not([hidden]) .chat-item');
  const shown = await ui.evaluate(() => [...document.querySelectorAll('.chat-item')].map((li) => ({ title: li.querySelector('.chat-title').textContent, meta: li.querySelector('.chat-meta').textContent, current: li.classList.contains('current') })));
  check('the list shows both chats, newest first, the open one marked', shown.length === 2 && shown[0].title === 'a brand new topic' && shown[0].current && !shown[1].current, JSON.stringify(shown));
  check('each entry shows its usage', /2\.4k tokens · ~\$0\.02/.test(shown[1]?.meta || ''), shown[1]?.meta);
  // The model menu opened over the history list is on top of it, not painted under it.
  await ui.click('.sidebar-head .picker-button');
  await ui.waitForSelector('.sidebar-head .picker-menu:not([hidden])');
  const menuOnTop = await ui.evaluate(() => {
    const menu = document.querySelector('.sidebar-head .picker-menu');
    const r = menu.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 30));
    return Boolean(hit && menu.contains(hit));
  });
  check('the model menu opened over the chat list is not covered by it', menuOnTop === true, 'covered by the list');
  await ui.evaluate(() => document.querySelector('.sidebar-head .picker-button').click()); // closes the menu again
  await ui.waitForSelector('.sidebar-head .picker-menu[hidden]', { state: 'attached' });
  await ui.waitForSelector('#chat-list:not([hidden]) .chat-item');
  await rowAction(legacyId, '.chat-open');
  const reopened = await waitFor(() => ui.evaluate(() => document.getElementById('chat-list').hidden && document.getElementById('messages').textContent));
  check('opening a chat shows its messages', /legacy question about tides/.test(reopened || '') && /Reply 2\./.test(reopened || '') && !/brand new topic/.test(reopened || ''), (reopened || '').slice(0, 200));
  check('opening a chat shows its usage', await ui.evaluate(() => document.getElementById('chat-usage').textContent) === '2.4k tokens · ~$0.02', 'usage line');
  check('opening a chat shows its context ring', await waitFor(async () => { const r = await ring(); return r && !r.hidden && /1\.0k of 200\.0k/.test(r.title); }), JSON.stringify(await ring()));
  const hostsBack = await app.evaluate(() => [...global.__agent.approvedHosts]);
  check('approved sites come back with their chat', hostsBack.includes('approved-in-legacy.test') && !hostsBack.includes('approved-in-new.test'), JSON.stringify(hostsBack));
  check('a reopened chat counts as having read content', await app.evaluate(() => global.__agent.messages.tainted === true), 'not tainted');
  check('the store remembers the open chat', await app.evaluate((_e, id) => global.__chats.store().current() === id && global.__chats.id() === id, legacyId), 'current id');

  // A reply in the reopened chat continues it (and lands in its usage).
  await ui.fill('#prompt', 'back again');
  await ui.press('#prompt', 'Enter');
  await waitFor(() => ui.evaluate(() => /Reply 4\./.test(document.getElementById('messages').textContent)));
  const continued = await waitFor(async () => { const s = await app.evaluate((_e, id) => global.__chats.store().load(id), legacyId); return s?.settings?.usage?.turns === 3 && s; });
  check('a reopened chat continues where it was', continued && continued.messages.length === 8 && continued.messages[6].content[0].text.endsWith('back again'), `${continued?.messages?.length} ${JSON.stringify(continued?.settings?.usage)}`);

  // ---- 5. Rename.
  await ui.click('#chat-history');
  await ui.waitForSelector(`#chat-list:not([hidden]) .chat-item[data-id="${newId}"]`);
  await rowAction(newId, '.chat-rename');
  await ui.fill('.chat-item input.chat-rename-input', 'Trip planning');
  await ui.press('.chat-item input.chat-rename-input', 'Enter');
  const renamed = await waitFor(() => ui.evaluate((id) => document.querySelector(`.chat-item[data-id="${id}"] .chat-title`)?.textContent === 'Trip planning', newId));
  check('rename updates the list', renamed, 'title unchanged');
  check('a renamed title sticks after more messages', await app.evaluate((_e, id) => global.__chats.store().list().find((c) => c.id === id)?.renamed === true, newId), 'not marked renamed');

  // ---- 6. Export (the save dialog is answered by the test).
  const exportPath = path.join(profile, 'exported.md');
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, exportPath);
  await rowAction(legacyId, '.chat-export');
  const md = await waitFor(() => fs.existsSync(exportPath) && fs.readFileSync(exportPath, 'utf8'));
  check('export writes Markdown with title, turns and usage', md && md.startsWith('# legacy question about tides\n') && /## You\n\nlegacy question about tides/.test(md) && /## Assistant\n\nReply 2\./.test(md) && /Usage: 3\.6k tokens · ~\$0\.03/.test(md), (md || '').slice(0, 300));
  check('export leaves out Lumen\'s browser state', md && !/browser_state|Active tab id/.test(md), 'leaked');
  await app.evaluate(({ dialog }) => { dialog.showSaveDialog = async () => ({ canceled: true }); });
  const cancelled = await ui.evaluate((id) => window.assistant.chats.exportChat(id), newId);
  check('a cancelled export writes nothing', cancelled && cancelled.ok === false && cancelled.reason === 'canceled', JSON.stringify(cancelled));

  // ---- 7. Delete: two clicks; deleting another chat leaves the open one alone.
  const del = `.chat-item[data-id="${newId}"] .chat-delete`;
  await rowAction(newId, '.chat-delete');
  check('the first delete click only asks', (await app.evaluate(() => global.__chats.store().list().length)) === 2, 'deleted on first click');
  await rowAction(newId, '.chat-delete');
  list = await waitFor(async () => { const l = await app.evaluate(() => global.__chats.store().list()); return l.length === 1 && l; });
  check('the second click deletes the chat and its file', list && list[0].id === legacyId && !fs.existsSync(path.join(chatsDir, `${newId}.json`)), JSON.stringify(list));
  check('deleting another chat keeps the open one on screen', /back again/.test(await ui.evaluate(() => document.getElementById('messages').textContent)), 'view cleared');
  // Deleting the open chat empties the sidebar.
  const delOpen = `.chat-item[data-id="${legacyId}"] .chat-delete`;
  await rowAction(legacyId, '.chat-delete');
  await rowAction(legacyId, '.chat-delete');
  const cleared = await waitFor(() => ui.evaluate(() => !document.querySelector('.msg') && document.getElementById('chat-usage').hidden));
  check('deleting the open chat empties the sidebar', cleared, 'still shows messages');
  check('…and leaves no chats', (await app.evaluate(() => global.__chats.store().list().length)) === 0 && (await app.evaluate(() => global.__agent.messages.length)) === 0, 'left over');
  check('the list says it is empty', await waitFor(() => ui.evaluate(() => Boolean(document.querySelector('.chat-list-empty')))), 'no empty note');

  // ---- 7b. [context] The chat's "/" commands: listed in the menu, /help, /context and /compact.
  await ui.fill('#prompt', '/');
  await ui.waitForSelector('#slash-menu:not([hidden])');
  const names = await ui.evaluate(() => [...document.querySelectorAll('#slash-menu .slash-name')].map((e) => e.textContent));
  check('the "/" menu lists the chat commands', ['/clear', '/compact', '/context', '/cost', '/usage', '/model', '/help'].every((n) => names.includes(n)), names.join(' '));
  await ui.fill('#prompt', '/help');
  await ui.press('#prompt', 'Enter');
  const help = await waitFor(() => ui.evaluate(() => document.querySelector('.notice.slash-help')?.textContent));
  check('/help lists every command', help && /\/compact/.test(help) && /\/context/.test(help) && /\/summarize/.test(help), help);
  await ui.fill('#prompt', 'one more about tides');
  await ui.press('#prompt', 'Enter');
  await waitFor(() => ui.evaluate(() => !document.body.classList.contains('agent-active') && /Reply \d+\./.test(document.getElementById('messages').textContent)));
  await ui.fill('#prompt', 'and the moon');
  await ui.press('#prompt', 'Enter');
  await waitFor(async () => (await app.evaluate(() => global.__agent.messages.length)) === 4);
  await waitFor(() => ui.evaluate(() => !document.body.classList.contains('agent-active')));
  await ui.fill('#prompt', '/context');
  await ui.press('#prompt', 'Enter');
  const report = await waitFor(() => ui.evaluate(() => [...document.querySelectorAll('.msg.assistant')].map((e) => e.textContent).find((t) => /Tokens:/.test(t))));
  check('/context answers in the chat with the figure', report && /Tokens: 1\.0k \/ 200\.0k/.test(report), report);
  await waitFor(() => ui.evaluate(() => !document.body.classList.contains('agent-active')));
  await ui.fill('#prompt', '/compact');
  await ui.press('#prompt', 'Enter');
  const compacted = await waitFor(() => ui.evaluate(() => [...document.querySelectorAll('.notice')].map((e) => e.textContent).find((t) => /^Compacted: about/.test(t))));
  check('/compact summarizes the older turns and says so', Boolean(compacted) && await app.evaluate(() => global.__agent.messages.length === 2 && JSON.stringify(global.__agent.messages[0]).includes('earlier_conversation_summary')), compacted);

  // ---- 8. Only Lumen's own UI can use the chat channels.
  const gated = await app.evaluate(() => ['chats:list', 'chats:open', 'chats:rename', 'chats:delete', 'chats:export'].every((c) => global.__ipcGate.uiOnly.has(c)));
  check('chat channels answer only the browser UI', gated, 'not in UI_ONLY_IPC');
  await app.close();

  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
