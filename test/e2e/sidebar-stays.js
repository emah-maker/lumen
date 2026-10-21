// The sidebar stays on the chat of the tab you are looking at (main.js followTabChat, switchTab, openedBy tabs), with a fake Claude
// client: no network, no key. Tab A has a chat the user is asking a question in (an unsent follow-up sits in the box); tab B has a
// chat of its own that works for a long time: it opens tabs (show:true), navigates, switches to a tab it opened, saves after every
// step, and finishes. Through all of it the sidebar must keep showing tab A's chat (id, messages, the typed text) and the window must
// stay on tab A. Run twice: with the default (a new tab carries the chat, "New chat" gives it one of its own) and with "One chat per
// tab". Hidden: LUMEN_TEST_BACKGROUND=1 (the runner sets it).
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(100); } return v; };

const launch = async (profile) => {
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
  return app;
};

// "chat-A" answers at once. "chat-B" is the long run: open_tab (shown), navigate, open_tab (shown), switch_tab (shown) to the tab it
// opened, then read_page steps with a pause each (so its events and saves keep coming) until the test lets it finish.
const fakeModel = (app, base) => app.evaluate((_e, b) => {
  global.__base = b;
  global.__long = { steps: 0, finish: false, opened: [], aHold: false, aSeen: 0, page: false };
  global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
    const who = /chat-(\w+)/.exec(JSON.stringify(params.messages[0]))?.[1] || '?';
    (global.__whoLog ||= []).push(`${who}:${JSON.stringify(params.messages[0]).slice(0, 160)}`);
    const results = params.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result'));
    const usage = { input_tokens: 100, output_tokens: 20 };
    const answer = (text) => ({
      async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; },
      finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage }),
    });
    if (who === 'A' && global.__long.aHold && !results.length) { // A's question is still being answered (held) until the test lets it go
      global.__long.aSeen++;
      return {
        async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A is thinking' } }; while (global.__long.aHold) await new Promise((r) => setTimeout(r, 100)); },
        finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'A answered' }], usage }),
      };
    }
    if (who !== 'B') return answer(`${who} answered`);
    const n = results.length;
    if (global.__long.finish) return answer('B finished');
    global.__long.steps = n + 1;
    const lastText = n ? JSON.stringify(results.at(-1).content) : '';
    const opened = /tab_id\D+(\d+)/.exec(lastText)?.[1] || /tab (\d+)/i.exec(lastText)?.[1];
    if (opened) global.__long.opened.push(Number(opened));
    const tool = global.__long.page ? (n === 0 ? { name: 'open_tab', input: { url: `${b}/b1` } } : { name: 'read_page', input: {} })
      : n === 0 ? { name: 'open_tab', input: { url: `${b}/b1`, show: true } }
      : n === 1 ? { name: 'navigate', input: { url: `${b}/b2` } }
      : n === 2 ? { name: 'open_tab', input: { url: `${b}/b3`, show: true } }
      : n === 3 ? { name: 'switch_tab', input: { tab_id: global.__long.opened.at(-1) ?? 1, show: true } }
      : { name: 'read_page', input: {} };
    const text = `B step ${n}`;
    return {
      async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; await new Promise((r) => setTimeout(r, 150)); },
      finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'text', text }, { type: 'tool_use', id: `tu-${n}`, ...tool }], usage }),
    };
  } } } });
}, base);

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const server = http.createServer((req, res) => {
    const name = (req.url || '/').replace(/^\//, '').toUpperCase() || 'HOME';
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Page ${name}</title><body><h1>PAGE-${name}</h1></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const [oneChatPerTab, aRunning, aEmpty, viaPage] of [[false, false, false, false], [false, false, false, true], [false, true, false, true]].filter((_v, i) => process.env.SBSTAY_ONLY === undefined || Number(process.env.SBSTAY_ONLY) === i)) {
    const mode = `${oneChatPerTab ? 'one chat per tab' : 'default'}${aRunning ? ', A still answering' : ''}${aEmpty ? ', A has no message yet' : ''}${viaPage ? ', B is a full-page chat in the background' : ''}`;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sbstay-'));
    const app = await launch(profile);
    if (process.env.SBSTAY_VERBOSE) { app.process().stderr.on('data', (d) => process.stdout.write(`[err] ${d}`)); app.process().stdout.on('data', (d) => process.stdout.write(`[out] ${d}`)); }
    await app.evaluate((_e, v) => global.__settings.backend.set('oneChatPerTab', v), oneChatPerTab);
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await fakeModel(app, base);
    if (process.env.SBSTAY_VERBOSE) await app.evaluate(({ webContents, ipcMain }) => { // log what main tells the sidebar (channels that change what it shows)
      const w = webContents.fromId(global.__windows.list()[0].uiContentsId);
      const orig = w.send.bind(w);
      global.__sendLog = [];
      ipcMain.prependListener('agent:ask', (e, t) => global.__sendLog.push(`ASK from ${e.sender.getURL().slice(-18)}: ${String(t).slice(0, 30)}`));
      { const rt = global.__chatPage.rt; const o = rt.emit; rt.emit = (snd, ch, p) => { if (ch === 'agent:event' && p.type !== 'text') global.__sendLog.push(`EV ${p.type} ${String(p.text || p.error || '').slice(0, 80)} ${p.chatId || ''}`); return o(snd, ch, p); }; }
      ipcMain.prependListener('agent:reset', (e) => global.__sendLog.push(`RESET from ${e.sender.getURL().slice(-18)}`));
      w.send = (ch, ...args) => { if (/^(chat:sync|chat:run-start|agent:history|chat:sidebar)$/.test(ch)) global.__sendLog.push(`${Date.now() % 100000} ${ch} ${JSON.stringify(args[0]?.view ? { id: args[0].view.id, live: Boolean(args[0].view.live), n: args[0].view.items?.length } : args[0]?.chatId || args[0]).slice(0, 120)}`); return orig(ch, ...args); };
    });

    const tc = (fn, arg) => app.evaluate(fn, arg);
    const active = () => tc(() => global.__windows.list().find((w) => w.current)?.activeId ?? global.__windows.list()[0].activeId);
    const messagesText = () => ui.evaluate(() => document.getElementById('messages').innerText);
    const send = async (text) => { await ui.fill('#prompt', text); await ui.press('#prompt', 'Enter'); };

    // Tab A: a question asked and answered; the user is in the middle of the next one.
    const tabA = await active();
    await tc(({ webContents }, u) => { const t = global.__windows.list()[0].tabs[0]; webContents.fromId(t.contentsId).loadURL(u); }, `${base}/alpha`);
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    if (aRunning) await tc(() => { global.__long.aHold = true; });
    if (!aEmpty) { await send('chat-A: my first question'); await waitFor(async () => /A answered|A is thinking/.test(await messagesText())); }
    const chatA = await tc(() => global.__tabChats.chatId());

    // Tab B: a chat of its own, working.
    let tabB;
    if (viaPage) { // the new-tab page's Ask AI: a tab that is the full-page chat (it acts from the background below)
      await tc(() => { global.__long.page = true; });
      tabB = await tc(() => global.__chatPage.fromHome(null, { inNewTab: true }));
      await waitFor(async () => (await active()) === tabB);
      await waitFor(() => tc((_e, id) => /chat-page.html/.test(global.__chatPage.contents(id)?.getURL() || ''), tabB));
    } else {
      tabB = await tc(() => { const id = global.__agent.browser.openTab('about:blank').id; global.__tabChats.setSidebar(id, true); return id; });
      await waitFor(async () => (await active()) === tabB);
      await waitFor(() => tc(() => global.__tabChats.shown() === global.__tabChats.chatId()));
      if (!oneChatPerTab) { await ui.evaluate(() => document.getElementById('new-chat').click()); await waitFor(async () => (await tc(() => global.__tabChats.chatId())) !== chatA); }
      await send('chat-B: do a long job');
    }
    if (!viaPage) await waitFor(() => tc(() => global.__long.steps >= 1));

    // The user goes back to tab A and starts typing the next question.
    await tc((_e, id) => global.__agent.browser.switchTab(id), tabA);
    await waitFor(async () => (await active()) === tabA);
    await waitFor(async () => (aEmpty || /my first question/.test(await messagesText())) && !/chat-B/.test(await messagesText()));
    const draft = 'chat-A: and what about the second question';
    await ui.fill('#prompt', draft);
    if (aRunning) await ui.evaluate(() => { document.getElementById('prompt').blur(); }).then(() => ui.focus('#prompt'));
    if (viaPage) { // the full-page chat, in a tab nobody is looking at, starts a new chat and sends a long job (its calls reach main like any page's)
      const inPage = (code) => tc((_e, [id, c]) => global.__chatPage.contents(id).executeJavaScript(c, true), [tabB, code]);
      await sleep(1500); // (the page is still starting up)
      await inPage('window.assistant.reset()'); // its New chat
      await sleep(500);
      await inPage('window.assistant.reset()'); // (twice: each is a new chat the page tells everyone about)
      await sleep(500);
    }
    const chatB = await tc((_e, id) => global.__tabChats.bindings.chatOf(id), tabB);
    check(`[${mode}] the two tabs have two chats`, chatA && chatB && chatA !== chatB, `${chatA} ${chatB}`);

    // B keeps working for a while (opens tabs, navigates, switches, saves); sample everything the user could see.
    const bad = [];
    const VERBOSE = process.env.SBSTAY_VERBOSE;
    const sample = async (when) => {
      const s = await tc(() => ({ open: global.__tabChats.chatId(), shown: global.__tabChats.shown(), cur: global.__chatStore?.current?.() ?? null }));
      const view = await ui.evaluate(() => ({ text: document.getElementById('messages').innerText, box: document.getElementById('prompt').value }));
      const front = await active();
      if (VERBOSE) console.log(when, JSON.stringify({ ...s, front, box: view.box.slice(0, 20), text: view.text.slice(0, 60).split(String.fromCharCode(10)).join('|') }));
      if (!viaPage && s.open !== chatA) bad.push(`${when}: open chat ${s.open}`);
      if (s.shown !== chatA) bad.push(`${when}: shown chat ${s.shown}`);
      if (/chat-B|B step|B finished/.test(view.text) || (!aEmpty && !/my first question/.test(view.text))) bad.push(`${when}: messages ${view.text.slice(0, 80)}`);
      if (view.box !== draft) bad.push(`${when}: composer ${JSON.stringify(view.box)}`);
      if (front !== tabA) bad.push(`${when}: front tab ${front}`);
    };
    const start = Date.now();
    while (Date.now() - start < 5000) { await sample(`+${Date.now() - start}ms`); await sleep(100); }
    const steps = await tc(() => global.__long.steps);
    check(`[${mode}] the long run kept working meanwhile (${steps} steps, tabs opened)`, viaPage || steps >= 6 && (await tc(() => global.__windows.list()[0].tabs.length)) >= 3, steps);
    check(`[${mode}] the sidebar, its messages, the typed text and the front tab stayed on tab A while B worked`, bad.length === 0, [...new Set(bad.map((b) => b.replace(/^\+\d+ms: /, '')))].slice(0, 4).join(' | '));

    // B finishes (a saved reply, a done mark, maybe a notification): still nothing moves.
    await tc(() => { global.__long.finish = true; });
    if (aRunning) { await sleep(500); await sample('B done, A answering'); await tc(() => { global.__long.aHold = false; }); await waitFor(async () => /A answered/.test(await messagesText())); }
    await waitFor(() => tc(() => global.__tabChats.runs().length === 0), 15000);
    for (let i = 0; i < 10; i++) { await sample('after the end'); await sleep(100); }
    check(`[${mode}] B ending did not pull the sidebar or the window either`, bad.length === 0, [...new Set(bad)].slice(0, 4).join(' | '));

    // The follow-up goes to chat A.
    await ui.press('#prompt', 'Enter');
    await waitFor(async () => (await messagesText()).includes('second question'));
    await sleep(600);
    check(`[${mode}] the follow-up typed in A is sent in chat A`, (await tc(() => global.__tabChats.chatId())) === chatA && (await messagesText()).includes('second question'), await messagesText());
    if (process.env.SBSTAY_VERBOSE) console.log((await tc(() => global.__sendLog)).join(String.fromCharCode(10)));
    check(`[${mode}] no page errors`, errors.length === 0, errors.join('; '));
    await app.close().catch(() => {});
  }
  server.close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
