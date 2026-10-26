// The sidebar button (and Ctrl+J, which sends the same event) on a tab where a chat is running opens the sidebar on THAT chat, live
// (main.js chat:sidebar-target liveOnly, app.js toggleSidebarByHand). Fake slow model, invisible windows (LUMEN_TEST_BACKGROUND=1):
//   a run streaming on tab A, sidebar closed, user on tab A: the button shows chat A (not a new chat), still working, its words there;
//   "Sidebar button starts a new chat" on (the default) or off: the running chat wins either way;
//   the sidebar already showing that chat: the button closes it as before; Ctrl+J opens it on the same chat again;
//   tab B with no run: today's behaviour (a new empty chat); the run in tab A is not touched;
//   the run has finished unread while the sidebar was closed: a new chat (the reply is in History), as before.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(80); } return v; };

// "slow": streams "Reply", waits for global.__release(), then finishes "Reply to slow".
const fakeModel = (app) => app.evaluate(() => {
  global.__gate = null;
  global.__release = () => { global.__gate?.(); };
  global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
    const first = params.messages.find((m) => m.role === 'user');
    const asked = JSON.stringify(first?.content || '');
    const last = params.messages.at(-1);
    const usage = { input_tokens: 10, output_tokens: 5 };
    const slow = /slow/.test(asked) && last.role === 'user';
    const text = /slow/.test(asked) ? 'Reply to slow' : 'Reply to x';
    const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage };
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reply' } };
        if (slow) await new Promise((r) => { global.__gate = r; });
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(5) } };
      },
      finalMessage: async () => message,
    };
  } } } });
});

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Page</title><body><h1>PAGE</h1></body>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sidebarrun-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await fakeModel(app);
    await app.evaluate(() => global.__settings.backend.set('oneChatPerTab', true)); // (a new tab starts its own chat: the default has it keep showing the chat you are in, which is then this chat too)
    await app.evaluate(({ webContents }, u) => { const t = global.__windows.list()[0].tabs[0]; webContents.fromId(t.contentsId).loadURL(u); }, `${base}/a`);
    await waitFor(() => app.evaluate(() => /\/a$/.test(global.__windows.list()[0].tabs[0].url)));

    const pressed = () => ui.evaluate(() => document.getElementById('toggle-sidebar').getAttribute('aria-pressed') === 'true');
    const settled = () => ui.evaluate(() => !document.body.classList.contains('sidebar-moving'));
    const waitState = (want) => waitFor(async () => (await pressed()) === want && (await settled()));
    const button = () => ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    const shortcut = () => app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.send('toggle-sidebar'); }); // what Ctrl+J / the menu send (main.js toggleSidebarFromKeys)
    const active = () => app.evaluate(() => global.__windows.list().find((w) => w.current)?.activeId ?? global.__windows.list()[0].activeId);
    const show = async (id) => { await app.evaluate((_e, i) => global.__agent.browser.switchTab(i), id); await waitFor(async () => (await active()) === id); await sleep(250); };
    const userMsgs = () => ui.evaluate(() => [...document.querySelectorAll('.msg.user')].map((e) => e.textContent.trim()));
    const shownText = () => ui.evaluate(() => document.getElementById('messages').innerText);
    const emptyShown = () => ui.evaluate(() => !document.getElementById('empty').hidden);
    const chatId = () => app.evaluate(() => global.__tabChats.chatId());
    const working = () => ui.evaluate(() => document.getElementById('send').classList.contains('stop'));
    const live = (id) => app.evaluate((_e, i) => global.__tabChats.runs().some((r) => r.chatId === i && r.live), id);
    const gated = () => waitFor(() => app.evaluate(() => typeof global.__gate === 'function'));
    const idle = () => waitFor(() => app.evaluate(() => global.__tabChats.runs().every((r) => !r.live)), 10000);
    // (a sidebar is open or closed tab by tab: close this tab's through its button, and wait for it)
    const closeIt = async () => { if (await pressed()) await button(); return waitState(false); };

    const tabA = await active();
    // 1. a chat runs in tab A; the sidebar is closed
    await button();
    check('sidebar opens on tab A', await waitState(true), 'closed');
    await ui.fill('#prompt', 'slow please');
    await ui.press('#prompt', 'Enter');
    await gated();
    const chatA = await chatId();
    check('chat A is working in tab A', await waitFor(() => working()), 'not working');

    // 2. tab B has no run: the button does what it did (a new empty chat); the run in tab A is untouched
    await ui.click('#new-tab'); // (the user's own new tab, not one the running chat opened)
    await waitFor(async () => { const id = await active(); return id !== tabA ? id : null; });
    await sleep(300);
    check('tab B has a chat of its own (one chat per tab)', await app.evaluate(() => new Set([...global.__tabChats.bindings.entries()].map((e) => e[1])).size) === 2, '');
    await closeIt();
    await button();
    check('tab B: the button opens the sidebar', await waitState(true), 'closed');
    const chatB = await chatId();
    check('tab B, no run there: a new empty chat, not chat A', chatB !== chatA && await emptyShown() && (await userMsgs()).length === 0, `${chatB} ${chatA} ${await userMsgs()}`);
    check('tab B: the run in tab A is untouched', await live(chatA), 'not live');
    await closeIt();

    // 3. back on tab A: the button shows the running chat, live (the setting is on by default: it still wins)
    check('the setting "Sidebar button starts a new chat" is on', await app.evaluate(() => global.__settings.backend.prefs?.().sidebarNewChat ?? true) !== false, 'off');
    await show(tabA);
    await closeIt();
    check('the run goes on with the sidebar closed', await live(chatA), 'not live');
    await button();
    check('tab A: the button opens the sidebar', await waitState(true), 'closed');
    check('tab A: it shows chat A, not a new chat', (await chatId()) === chatA && !(await emptyShown()) && (await userMsgs()).some((t) => /slow/.test(t)), `${await chatId()} ${chatA} ${await userMsgs()}`);
    check('tab A: chat A is live in the sidebar (working, its streamed words there)', await waitFor(async () => (await working()) && /Reply/.test(await shownText())), await shownText());
    check('tab A: no new chat was added', await app.evaluate(() => global.__tabChats.runs().length) === 1, '');

    // 4. the sidebar already shows that chat: the button closes it; the shortcut opens it on the same chat again
    await button();
    check('the sidebar already showing the chat: the button closes it', await waitState(false), 'open');
    check('closing keeps the run going', await live(chatA), 'not live');
    await shortcut();
    check('Ctrl+J opens it too', await waitState(true), 'closed');
    check('Ctrl+J shows the running chat, live', (await chatId()) === chatA && !(await emptyShown()) && await waitFor(() => working()), `${await chatId()} ${await userMsgs()}`);
    await shortcut();
    check('Ctrl+J closes it again', await waitState(false), 'open');

    // 5. with the setting off the running chat shows too
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
    await sleep(300);
    await button();
    check('setting off: the button shows the running chat', await waitState(true) && (await chatId()) === chatA && !(await emptyShown()), `${await chatId()}`);
    await closeIt();
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', true));
    await sleep(300);

    // 6. the run finishes while the sidebar is closed: unread, not "running": a new chat opens (the reply is in History)
    await app.evaluate(() => { global.__release(); global.__gate = null; });
    await idle();
    await button();
    check('a finished, unread reply does not hold the button: a new empty chat', await waitState(true) && (await chatId()) !== chatA && await emptyShown(), `${await chatId()}`);

    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
