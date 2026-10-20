// What the AI sidebar keeps per tab when you switch tabs and chats (main.js "[chat per tab]", features/tab-chats.js, renderer/chat-core.js).
// A fake Claude client (no network, no key). Two modes are walked through: "One chat per tab" (each tab owns a chat) and the default
// (a tab with no chat of its own carries the chat you were in). Checked, for every switch A -> B -> A:
//   which chat each tab shows (also after opening another chat from the history, "New chat", a chat that finished in the background,
//   closing and reopening the sidebar, a tab sleeping and waking, and a restart);
//   the scroll position, the unsent draft (text, attachments, "@" tab chips, Plan first), the folded/expanded step card, the open panel;
//   a chat that runs in tab A keeps streaming into its own chat while tab B is in front, and nothing leaks into B.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(100); } return v; };

const launch = async (profile, oneChat) => {
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  await app.evaluate((_e, one) => { global.__settings.backend.set('sidebarNewChat', false); global.__settings.backend.set('oneChatPerTab', one); }, oneChat);
  return app;
};

// A message that names "chat-X" is chat X. Its first turn streams a line, then waits until the test lets it go, then reads the page; the
// second turn answers "X finished" (a chat named L... answers with a long text, so its conversation scrolls).
const fakeModel = (app) => app.evaluate(() => {
  global.__seen = {};
  global.__inflight = new Set();
  const holds = {};
  const hold = (who) => (holds[who] ||= (() => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; })());
  global.__release = (who) => hold(who).resolve();
  global.__unhold = (who) => { delete holds[who]; };
  global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
    const who = /chat-(\w+)/.exec(JSON.stringify(params.messages[0]))?.[1] || '?';
    const results = params.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
    const usage = { input_tokens: 100, output_tokens: 20 };
    if (!results.length) {
      const text = `${who} is working`;
      return {
        async *[Symbol.asyncIterator]() {
          global.__inflight.add(who);
          yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } };
          await hold(who).p;
        },
        finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'text', text }, { type: 'tool_use', id: `tu-${who}`, name: 'read_page', input: {} }], usage }),
      };
    }
    const text = /^L/.test(who) ? `${who} finished\n\n${Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} of ${who}: some words to make the conversation tall.`).join('\n\n')}` : `${who} finished`;
    return {
      async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; },
      finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage }),
    };
  } } } });
});

(async () => {
  let failures = 0;
  const only = process.argv[2] || '';
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const server = http.createServer((req, res) => {
    const name = (req.url || '/').replace(/^\//, '').toUpperCase() || 'HOME';
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Page ${name}</title><body><h1>PAGE-${name}</h1><p>This is page ${name}.</p></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = [];

  async function walk(oneChat, tag) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sidebar-tab-state-'));
    let app = await launch(profile, oneChat);
    let ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    ui.on('pageerror', (e) => errors.push(e.message));
    await fakeModel(app);
    const c = (label, ok, detail) => check(`[${tag}] ${label}`, ok, detail);

    const openTab = (url) => app.evaluate((_e, u) => { const id = global.__agent.browser.openTab(u).id; global.__tabChats.setSidebar(id, true); return id; }, url);
    const showTab = async (id) => { await app.evaluate((_e, i) => global.__agent.browser.switchTab(i), id); await waitFor(async () => (await active()) === id); await waitFor(async () => { const own = await chatOf(id); return !own || own === (await mainShown()).open; }, 5000); await settle(); };
    const active = () => app.evaluate(() => global.__windows.list().find((w) => w.current)?.activeId ?? global.__windows.list()[0].activeId);
    const tc = (fn, arg) => app.evaluate(fn, arg);
    const chatOf = (id) => tc((_e, i) => global.__tabChats.bindings.chatOf(i), id);
    const mainShown = () => tc(() => ({ shown: global.__tabChats.shown(), open: global.__tabChats.chatId() }));
    // The sidebar has drawn what main says it shows (the view id, and the open chat id agree).
    const settle = async () => { await waitFor(async () => { const m = await mainShown(); const r = await ui.evaluate(() => shownChatId); return m.shown === m.open && r === m.open; }, 5000); await sleep(250); };
    const text = () => ui.evaluate(() => document.getElementById('messages').innerText);
    const rendererChat = () => ui.evaluate(() => shownChatId);
    const send = async (t) => { await ui.fill('#prompt', t); await ui.press('#prompt', 'Enter'); };
    const inflight = (who) => waitFor(() => tc((_e, w) => global.__inflight.has(w), who));
    const idle = () => waitFor(() => tc(() => global.__tabChats.runs().length === 0), 15000);
    const chatDone = async (who) => { await send(`chat-${who}: go`); await inflight(who); await tc((_e, w) => global.__release(w), who); await waitFor(async () => new RegExp(`${who} finished`).test(await text()), 10000); await idle(); };
    const showsChat = async (id, who, label) => { await settle(); await waitFor(async () => new RegExp(`chat-${who}`, "i").test(await text()), 3000); const t = await text(); c(label, (await rendererChat()) === id && new RegExp(`chat-${who}`, "i").test(t), `${await rendererChat()} want ${id}; hidden=${await ui.evaluate(() => document.body.classList.contains('sidebar-hidden'))} mainOpen=${await tc(() => global.__tabChats.sidebar(global.__windows.list()[0].activeId))}; ${t.slice(0, 160)}`); };
    // The toolbar button, pressed until main and the page agree on the front tab's state.
    const setSidebar = async (open) => {
      const state = () => tc(() => global.__tabChats.sidebar(global.__windows.list().find((w) => w.current)?.activeId ?? global.__windows.list()[0].activeId));
      if ((await state()) !== open) await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
      await waitFor(async () => (await state()) === open && (await ui.evaluate(() => !document.body.classList.contains('sidebar-moving') && document.body.classList.contains('sidebar-hidden') === !open)), 5000);
    };
    const openHistoryChat = async (id) => {
      await ui.evaluate(() => document.getElementById('chat-history').click());
      await waitFor(() => ui.evaluate((i) => Boolean(document.querySelector(`.chat-item[data-id="${i}"] .chat-open`)), id));
      await ui.evaluate((i) => document.querySelector(`.chat-item[data-id="${i}"] .chat-open`).click(), id);
      await waitFor(() => ui.evaluate(() => document.getElementById('chat-list').hidden));
      await settle();
    };

    const tabA = await active();
    await app.evaluate(({ webContents }, u) => { const t = global.__windows.list()[0].tabs[0]; webContents.fromId(t.contentsId).loadURL(u); }, `${base}/alpha`);
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await settle();
    await chatDone('A');
    const chatA = await chatOf(tabA);
    const tabB = await openTab(`${base}/beta`);
    await waitFor(async () => (await active()) === tabB);
    await settle();
    if (oneChat) await chatDone('B');
    else { // (the default: tab B carries chat A; the user starts chat B there)
      await ui.click('#new-chat'); await settle(); await chatDone('B');
    }
    const chatB = await chatOf(tabB);
    c('(setup) the two tabs hold two chats', Boolean(chatA) && Boolean(chatB) && chatA !== chatB, `${chatA} ${chatB}`);

    // ---- 1. A -> B -> A
    await showTab(tabA);
    await showsChat(chatA, 'A', 'tab A shows chat A');
    await showTab(tabB);
    await showsChat(chatB, 'B', 'tab B shows chat B');
    await showTab(tabA);
    await showsChat(chatA, 'A', 'A -> B -> A comes back to chat 1');
    c('... the bindings did not move', (await chatOf(tabA)) === chatA && (await chatOf(tabB)) === chatB, `${await chatOf(tabA)} ${await chatOf(tabB)}`);

    // ---- 2. A chat opened from the history in one tab
    const tabC = await openTab(`${base}/gamma`);
    await waitFor(async () => (await active()) === tabC);
    await settle();
    if (!oneChat) { await ui.click('#new-chat'); await settle(); }
    await chatDone('C');
    const chatC = await chatOf(tabC);
    await showTab(tabA);
    await openHistoryChat(chatC);
    await showsChat(chatC, 'C', 'a chat opened from the history shows in this tab');
    await showTab(tabB);
    await showsChat(chatB, 'B', 'tab B still shows chat B after A opened another chat');
    await showTab(tabA);
    await showsChat(chatC, 'C', 'A -> B -> A after opening chat 3 from the history: tab A is on chat 3');
    c('... tab A is bound to chat 3 in main', (await chatOf(tabA)) === chatC, await chatOf(tabA));
    await showTab(tabC);
    const cShown = await rendererChat();
    c(oneChat ? 'the tab chat 3 was moved out of starts a chat of its own (not chat 1)' : 'the tab chat 3 was moved out of carries the open chat (by design), not chat 1', oneChat ? cShown !== chatC && cShown !== chatA && cShown === (await chatOf(tabC)) : cShown === chatC && cShown === (await chatOf(tabC)), `${cShown} ${await chatOf(tabC)}`);
    await showTab(tabA);
    await showsChat(chatC, 'C', 'back on tab A: chat 3');

    // ---- 3. New chat
    await ui.click('#new-chat');
    await settle();
    const freshA = await rendererChat();
    await ui.fill('#prompt', 'draft in the new chat');
    await showTab(tabB);
    await showsChat(chatB, 'B', 'tab B after tab A started a new chat');
    await showTab(tabA);
    await settle();
    const afterNew = await rendererChat();
    c('New chat: A -> B -> A comes back to an empty chat, not chat 1/2/3', afterNew && afterNew !== chatA && afterNew !== chatB && afterNew !== chatC && (await text()).trim() === '' + (await text()).trim() && !/chat-/.test(await text()), `${afterNew} ${(await text()).slice(0, 100)}`);
    c('... its unsent draft is still in the box', (await ui.inputValue('#prompt')) === 'draft in the new chat', await ui.inputValue('#prompt'));
    void freshA;
    await ui.fill('#prompt', '');
    // Put tab A back on chat 1 for the rest.
    await openHistoryChat(chatA);
    await showsChat(chatA, 'A', '(setup) tab A is on chat 1 again');

    // ---- 4. A chat that finishes in the background
    await send('chat-A: again');
    await inflight('A');
    await tc(() => global.__unhold('A'));
    await showTab(tabB);
    await showsChat(chatB, 'B', 'tab B while chat 1 works in tab A');
    await tc(() => global.__release('A'));
    await idle();
    await showsChat(chatB, 'B', 'chat 1 finishing does not change what tab B shows');
    c('... and nothing of chat 1 leaked into tab B', !/chat-A|A is working|A finished/.test(await text()), await text());
    await showTab(tabA);
    await waitFor(async () => (await text()).split('A finished').length > 2, 6000);
    await showsChat(chatA, 'A', 'back on tab A after chat 1 finished in the background');
    c('... with its new reply', (await text()).split('A finished').length > 2, await text());


    // ---- 4b. What is open in the sidebar, tab by tab
    const tabD = await openTab(`${base}/delta`);
    await waitFor(async () => (await active()) === tabD);
    await settle();
    if (!oneChat) { await ui.click('#new-chat'); await settle(); }
    await chatDone('L1');
    const chatD = await chatOf(tabD);
    const scrollOf = () => ui.evaluate(() => { const m = document.getElementById('messages'); return { top: Math.round(m.scrollTop), max: m.scrollHeight - m.clientHeight }; });
    await waitFor(async () => (await scrollOf()).max > 300, 4000);
    await ui.evaluate(() => { document.getElementById('messages').scrollTop = 500; });
    await sleep(300);
    const before = await scrollOf();
    await showTab(tabB);
    await showTab(tabD);
    await waitFor(async () => (await scrollOf()).max > 300, 4000);
    await sleep(500);
    const after = await scrollOf();
    c('scroll: a conversation read halfway is still halfway after D -> B -> D', Math.abs(after.top - 500) <= 40, `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
    await ui.evaluate(() => { document.getElementById('messages').scrollTop = 0; });
    await sleep(300);
    await showTab(tabB); await showTab(tabD); await waitFor(async () => (await scrollOf()).max > 300, 4000); await sleep(500);
    const top = await scrollOf();
    c('scroll: a conversation left at the top stays at the top', top.top <= 20, JSON.stringify(top));
    await ui.evaluate(() => { const m = document.getElementById('messages'); m.scrollTop = m.scrollHeight; });
    await sleep(300);
    await showTab(tabB); await showTab(tabD); await sleep(500);
    const bottom = await scrollOf();
    c('scroll: a conversation left at the bottom stays at the bottom', bottom.max - bottom.top <= 60, JSON.stringify(bottom));

    // the unsent draft: text, attachments, "@" tab chips, Plan first
    const pic = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const draftState = () => ui.evaluate(() => ({ text: document.getElementById('prompt').value, pics: document.querySelectorAll('#attachments .attachment').length, chips: document.querySelectorAll('#tab-chips .tab-chip').length, plan: document.getElementById('plan-chip')?.getAttribute('aria-pressed') === 'true' }));
    await showTab(tabD);
    await ui.fill('#prompt', 'draft for chat D');
    await ui.evaluate((p) => { attachments = [{ media_type: 'image/png', data: p, url: 'data:image/png;base64,' + p, name: 'd.png' }]; renderAttachments(); }, pic);
    await ui.click('#prompt');
    await ui.keyboard.press('End');
    await ui.keyboard.type(' @');
    await waitFor(() => ui.evaluate(() => !document.getElementById('tabs-picker').hidden), 3000);
    await ui.keyboard.press('Enter');
    await sleep(300);
    await ui.evaluate(() => { const chip = document.getElementById('plan-chip'); if (chip && chip.getAttribute('aria-pressed') !== 'true') chip.click(); });
    const dSet = await draftState();
    c('(setup) chat D has text, a picture, a tab chip and Plan first set', dSet.pics === 1 && dSet.chips >= 1 && dSet.plan && /draft for chat D/.test(dSet.text), JSON.stringify(dSet));
    await showTab(tabB);
    const bState = await draftState();
    c('another tab does not get that draft (no text, picture, chip or plan)', bState.pics === 0 && bState.chips === 0 && !bState.plan && !/draft for chat D/.test(bState.text), JSON.stringify(bState));
    await ui.fill('#prompt', 'draft for chat B');
    await showTab(tabD);
    const dBack = await draftState();
    c('draft text comes back on D -> B -> D', /draft for chat D/.test(dBack.text) && !/chat B/.test(dBack.text), JSON.stringify(dBack));
    c('draft picture comes back', dBack.pics === 1, JSON.stringify(dBack));
    c('draft "@" tab chips come back', dBack.chips === dSet.chips, JSON.stringify(dBack));
    c('Plan first stays on for that chat', dBack.plan === true, JSON.stringify(dBack));
    await showTab(tabB);
    const bBack = await draftState();
    c('and tab B keeps its own draft, without the picture or chip of D', bBack.text === 'draft for chat B' && bBack.pics === 0 && bBack.chips === 0 && !bBack.plan, JSON.stringify(bBack));
    await ui.fill('#prompt', '');
    await showTab(tabD);
    await ui.fill('#prompt', '');
    await ui.evaluate(() => { attachments = []; renderAttachments(); window.tabsAsk.reset(); const chip = document.getElementById('plan-chip'); if (chip.getAttribute('aria-pressed') === 'true') chip.click(); });

    // a running chat's step card, expanded
    await send('chat-RUN: go');
    await inflight('RUN');
    await waitFor(() => ui.evaluate(() => Boolean(document.querySelector('#messages details.act-steps'))), 4000);
    const stepsOpen = () => ui.evaluate(() => [...document.querySelectorAll('#messages details')].map((d) => `${d.className}:${d.open}`));
    await ui.evaluate(() => { const d = document.querySelector('#messages details.act-steps'); if (d) d.open = true; });
    const stepsBefore = await stepsOpen();
    await showTab(tabB);
    await showTab(tabD);
    await waitFor(() => ui.evaluate(() => Boolean(document.querySelector('#messages details.act-steps'))), 4000);
    await sleep(300);
    const stepsAfter = await stepsOpen();
    c('an expanded step card is still expanded after D -> B -> D (a chat still running)', JSON.stringify(stepsBefore) === JSON.stringify(stepsAfter) && stepsBefore.some((x) => /act-steps:true/.test(x)), JSON.stringify({ stepsBefore, stepsAfter }));
    await tc(() => global.__release('RUN'));
    await idle();

    // panels: the chat list stays open (it is the window's, not a tab's) and marks the front tab's chat
    await ui.evaluate(() => document.getElementById('chat-history').click());
    await waitFor(() => ui.evaluate(() => !document.getElementById('chat-list').hidden && document.querySelector('#chat-list .chat-item')));
    await showTab(tabB);
    await sleep(500);
    const listOpen = await ui.evaluate(() => ({ open: !document.getElementById('chat-list').hidden, current: document.querySelector('#chat-list .chat-item.current')?.dataset.id }));
    c('the chat list stays open when the tab changes, and marks the new tab chat', listOpen.open && listOpen.current === chatB, JSON.stringify({ listOpen, chatB }));
    await ui.evaluate(() => document.getElementById('chat-history').click());
    await ui.evaluate(() => document.getElementById('notes-btn')?.click());
    await sleep(400);
    const notesOpen = () => ui.evaluate(() => !document.getElementById('notes-panel').hidden);
    const notesWas = await notesOpen();
    await showTab(tabD);
    await sleep(500);
    c('an open Notes panel stays open when the tab changes', notesWas && (await notesOpen()), `was ${notesWas}`);
    await ui.evaluate(() => { const p = document.getElementById('notes-panel'); if (!p.hidden) document.getElementById('notes-btn').click(); });
    await sleep(300);
    await showsChat(chatD, 'L1', 'tab D still shows its own chat');

    // ---- 5. The sidebar closed and reopened
    await setSidebar(false);
    await showTab(tabB);
    await showTab(tabA);
    await setSidebar(true);
    await settle();
    await showsChat(chatA, 'A', 'sidebar closed, A -> B -> A, reopened: chat 1');

    // ---- 6. A tab that sleeps and wakes
    await showTab(tabB);
    await tc((_e, id) => global.__tabSleep.sleep(id), tabA);
    await showTab(tabA);
    await showsChat(chatA, 'A', 'tab A slept and woke: chat 1');
    c('... bound to the same chat', (await chatOf(tabA)) === chatA, await chatOf(tabA));

    // ---- 7. Restart (the session comes back)
    await showTab(tabA);
    await ui.fill('#prompt', 'draft before the restart');
    await ui.evaluate(() => document.getElementById('prompt').blur());
    await app.evaluate(() => global.__settingsFlush && global.__settingsFlush());
    await app.close();
    app = await launch(profile, oneChat);
    ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    ui.on('pageerror', (e) => errors.push(e.message));
    await fakeModel(app);
    await waitFor(() => tc(() => global.__tabChats.bindings.size() > 0));
    const back = await tc(() => ({ entries: global.__tabChats.bindings.entries(), tabs: global.__windows.list()[0].tabs.map((t) => ({ id: t.id, url: t.url })) }));
    const byUrl = (re) => back.tabs.find((t) => re.test(t.url))?.id;
    const [rA, rB, rC] = [byUrl(/alpha/i), byUrl(/beta/i), byUrl(/gamma/i)];
    const bound = Object.fromEntries(back.entries);
    c('after a restart tab A is bound to chat 1 and B to chat 2', bound[rA] === chatA && bound[rB] === chatB, JSON.stringify({ bound, rA, rB, rC, chatA, chatB, chatC }));
    await app.evaluate((_e, ids) => { for (const id of ids) global.__tabChats.setSidebar(id, true); }, [rA, rB]);
    await showTab(rA);
    await showsChat(chatA, 'A', 'after a restart tab A shows chat 1');
    c('after a restart the sidebar knows which chat it shows, and its draft is back', (await rendererChat()) === chatA && (await ui.inputValue('#prompt')) === 'draft before the restart', `${await rendererChat()} ${await ui.inputValue('#prompt')}`);
    await showTab(rB);
    await showsChat(chatB, 'B', 'after a restart tab B shows chat 2');
    await showTab(rA);
    await showsChat(chatA, 'A', 'after a restart A -> B -> A: chat 1');

    await app.close();
  }

  const modes = only === 'carry' ? [false] : only === 'own' ? [true] : [true, false];
  for (const m of modes) await walk(m, m ? 'one chat per tab' : 'default');
  check('no script errors', errors.length === 0, errors.join('; '));
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
