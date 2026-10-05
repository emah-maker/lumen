// The sidebar chat follows you across tabs (features/tab-chats.js followPlan, main.js followTabChat), with a fake
// Claude client: no network, no key. Chat in tab A, open a new tab B: the same chat is shown with its history,
// a message sent in B goes to that chat and the AI works in B; a tab C with a chat of its own still shows it;
// closing a tab never takes a chat other tabs show; "One chat per tab" on gives the old behaviour (every tab starts empty).
// LUMEN_SHOTS=<dir> also saves screenshots of the sidebar.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(100); } return v; };
const launch = (profile) => electron.launch({
  args: [path.join(__dirname, '..')],
  env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
});

// A message asks for the page (read_page); once the tool answered, the reply says which page it read.
const fakeModel = (app) => app.evaluate(() => {
  global.__seen = [];
  global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
    const last = params.messages.at(-1);
    const usage = { input_tokens: 100, output_tokens: 20 };
    if (last.role === 'user' && Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result')) {
      const page = /PAGE-(\w+)/.exec(JSON.stringify(last.content))?.[1] || 'none';
      global.__seen.push(page);
      const text = `I read ${page}`;
      return {
        async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; },
        finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage }),
      };
    }
    return {
      async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading' } }; },
      finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Reading' }, { type: 'tool_use', id: `tu-${global.__seen.length}`, name: 'read_page', input: {} }], usage }),
    };
  } } } });
});

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const server = http.createServer((req, res) => {
    const name = (req.url || '/').replace(/^\//, '').toUpperCase() || 'HOME';
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Page ${name}</title><body><h1>PAGE-${name}</h1></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-tabfollow-'));
  const shots = process.env.LUMEN_SHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  const app = await launch(profile);
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await fakeModel(app);

  const tc = (fn, arg) => app.evaluate(fn, arg);
  const openTab = (url) => tc((_e, u) => { const id = global.__agent.browser.openTab(u).id; global.__tabChats.setSidebar(id, true); return id; }, url);
  const showTab = (id) => tc((_e, i) => global.__agent.browser.switchTab(i), id);
  const active = () => tc(() => global.__windows.list().find((w) => w.current)?.activeId ?? global.__windows.list()[0].activeId);
  const chatOfTab = (id) => tc((_e, i) => global.__tabChats.bindings.chatOf(i), id);
  const homeOf = (c) => tc((_e, x) => global.__tabChats.bindings.homeOf(x), c);
  const messagesText = () => ui.evaluate(() => document.getElementById('messages').innerText);
  const bubbles = () => ui.evaluate(() => [...document.querySelectorAll('#messages .msg.user')].map((e) => e.textContent.trim().replace(/Edit$/, '').trim()));
  const send = async (text) => { await ui.fill('#prompt', text); await ui.press('#prompt', 'Enter'); };
  const idle = () => tc(() => global.__tabChats.runs().every((r) => !r.live));
  const shot = async (name) => { if (shots) await ui.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const showsChat = (id) => waitFor(() => tc((_e, c) => global.__tabChats.chatId() === c && global.__tabChats.shown() === c, id));

  // ---- 1. A chat in tab A.
  const tabA = await active();
  await tc(({ webContents }, u) => { const t = global.__windows.list()[0].tabs[0]; webContents.fromId(t.contentsId).loadURL(u); }, `${base}/alpha`);
  await waitFor(() => tc(() => /alpha/i.test(global.__windows.list()[0].tabs[0].url)));
  await ui.evaluate(() => { if (document.body.classList.contains('sidebar-hidden')) document.getElementById('toggle-sidebar').click(); });
  await send('first question');
  check('chat A answers in its own tab', await waitFor(async () => /I read ALPHA/.test(await messagesText())), await messagesText());
  await waitFor(idle);
  const chatA = await chatOfTab(tabA);
  check('tab A is bound to chat A', Boolean(chatA), chatA);

  // ---- 2. A new tab B: the same chat, with its history.
  const tabB = await openTab(`${base}/beta`);
  await waitFor(async () => (await active()) === tabB);
  check('the new tab shows the chat you were in', await showsChat(chatA), JSON.stringify(await tc(() => ({ open: global.__tabChats.chatId(), shown: global.__tabChats.shown() }))));
  await waitFor(async () => /first question/.test(await messagesText()));
  check('... with its history, not an empty chat', (await bubbles()).includes('first question') && /I read ALPHA/.test(await messagesText()), await messagesText());
  check('... and the tab is bound to it (tab A keeps it too)', (await chatOfTab(tabB)) === chatA && (await chatOfTab(tabA)) === chatA);
  await shot('after-new-tab-same-chat');

  // ---- 3. A message sent in B goes to the same chat, and the AI works in B.
  await send('second question');
  check('the reply is in the same chat', await waitFor(async () => /I read BETA/.test(await messagesText())), await messagesText());
  await waitFor(idle);
  check('... the AI read the tab in front (B), not A', (await tc(() => global.__seen)).join() === 'ALPHA,BETA', JSON.stringify(await tc(() => global.__seen)));
  check('... B is now the chat\'s working tab', (await homeOf(chatA)) === tabB, await homeOf(chatA));
  check('... one chat, two questions in it', (await bubbles()).join('|') === 'first question|second question', JSON.stringify(await bubbles()));
  check('no chat was added for the new tab', (await tc(() => global.__chats.store().list().length)) === 1, await tc(() => global.__chats.store().list().length));

  // ---- 4. A tab with a chat of its own still shows that chat; New chat starts a fresh one bound to the tab.
  const tabC = await openTab(`${base}/gamma`);
  await waitFor(async () => (await active()) === tabC);
  await showsChat(chatA);
  await ui.evaluate(() => document.getElementById('new-chat').click());
  await waitFor(async () => (await bubbles()).length === 0);
  await send('third question about C');
  check('C: its own chat answers', await waitFor(async () => /I read GAMMA/.test(await messagesText())), await messagesText());
  await waitFor(idle);
  const chatC = await chatOfTab(tabC);
  check('C has a chat of its own, not chat A', Boolean(chatC) && chatC !== chatA, `${chatC} ${chatA}`);
  check('chat A stays in tabs A and B', (await chatOfTab(tabA)) === chatA && (await chatOfTab(tabB)) === chatA);
  await showTab(tabA);
  check('back on A: chat A with both questions', await showsChat(chatA) && (await waitFor(async () => (await bubbles()).length === 2)), JSON.stringify(await bubbles()));
  await showTab(tabC);
  check('back on C: chat C, not the chat that was open', (await showsChat(chatC)) && (await waitFor(async () => (await bubbles()).join() === 'third question about C')), JSON.stringify(await bubbles()));
  await shot('tab-with-own-chat');
  const tabD = await openTab(`${base}/delta`);
  await waitFor(async () => (await active()) === tabD);
  check('a new tab opened from C carries chat C on (the chat you were in)', await showsChat(chatC) && (await chatOfTab(tabD)) === chatC);

  // ---- 5. Closing a tab never deletes a chat other tabs show.
  await tc((_e, i) => global.__closeTabInteractive(i), tabD);
  await sleep(300);
  check('closing the tab that carried chat C leaves C in its own tab', (await chatOfTab(tabC)) === chatC && (await tc((_e, c) => global.__chats.store().list().some((x) => x.id === c), chatC)));
  await tc((_e, i) => global.__closeTabInteractive(i), tabB);
  await sleep(300);
  check('closing B (A\'s other tab) keeps chat A in tab A, with its history', (await chatOfTab(tabA)) === chatA && (await tc((_e, c) => global.__chats.store().list().some((x) => x.id === c), chatA)));
  check('... and A is its home again', (await homeOf(chatA)) === tabA, await homeOf(chatA));

  // ---- 6. One chat per tab: the old behaviour.
  await tc(() => global.__settings.backend.set('oneChatPerTab', true));
  await showTab(tabA);
  await showsChat(chatA);
  const tabE = await openTab(`${base}/echo`);
  await waitFor(async () => (await active()) === tabE);
  const emptyNow = async () => (await bubbles()).length === 0 && !/I read/.test(await messagesText());
  await sleep(500);
  check('One chat per tab on: a new tab starts with an empty chat', await waitFor(emptyNow, 4000), await messagesText());
  const chatE = await chatOfTab(tabE);
  check('... bound to a chat of its own', Boolean(chatE) && chatE !== chatA && chatE !== chatC, `${chatE}`);
  await shot('one-chat-per-tab-on');
  await showTab(tabA);
  check('... and tab A still shows its chat', (await showsChat(chatA)) && (await waitFor(async () => (await bubbles()).length === 2)));
  await tc(() => global.__settings.backend.set('oneChatPerTab', false));
  const setting = await tc(() => global.__settings.backend.prefs?.().oneChatPerTab ?? null).catch(() => null);
  check('the setting is off by default (turned back off here)', setting === false || setting === null, setting);

  check('no page errors in the sidebar', errors.length === 0, errors.join(' | '));
  await app.evaluate(() => global.__settingsFlush && global.__settingsFlush());
  await app.close();
  server.close();
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
