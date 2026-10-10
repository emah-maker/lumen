// "Sidebar button starts a new chat" (Settings > AI, renderer/sidebar-open.js, app.js toggleSidebarByHand), with a fake model and
// invisible windows (LUMEN_TEST_BACKGROUND=1): the AI button opens the sidebar on an empty chat and the old chat is in History;
// an empty chat is reused; a reply still being written is not lost when the sidebar closes; with the setting off the old chat
// comes back; History opens a chat from another tab in this tab's sidebar without switching tabs.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(80); } return v; };

// Every reply is "Reply to: <last user text>"; a message that says SLOW waits for global.__release() first.
const fakeModel = (app) => app.evaluate(() => {
  global.__gate = null;
  global.__release = () => { global.__gate?.(); };
  global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
    const last = params.messages.at(-1);
    const asked = (JSON.stringify(last.content).match(/(say one|slow please)/) || [''])[0];
    const text = `Reply to ${/(one|slow)/.exec(asked)?.[1] || 'x'}`;
    const slow = /slow/.test(asked);
    const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } };
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sidebarnew-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await fakeModel(app);

    const pressed = () => ui.evaluate(() => document.getElementById('toggle-sidebar').getAttribute('aria-pressed') === 'true');
    const settled = () => ui.evaluate(() => !document.body.classList.contains('sidebar-moving'));
    const waitState = (want) => waitFor(async () => (await pressed()) === want && (await settled()));
    const toggle = () => ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    const userMsgs = () => ui.evaluate(() => [...document.querySelectorAll('.msg.user')].map((e) => e.textContent.trim()));
    const emptyShown = () => ui.evaluate(() => !document.getElementById('empty').hidden);
    const stored = () => app.evaluate(() => global.__chats.store().list().length);
    const ask = async (text) => { await ui.fill('#prompt', text); await ui.press('#prompt', 'Enter'); };
    const finished = () => waitFor(() => ui.evaluate(() => !document.body.classList.contains('running') && document.querySelectorAll('.msg.assistant').length > 0 && !document.querySelector('#send.stop, #send[data-state="stop"]')), 10000);
    const historyTitles = async () => {
      await ui.click('#chat-history');
      await waitFor(() => ui.evaluate(() => !document.getElementById('chat-list').hidden));
      const titles = await ui.evaluate(() => [...document.querySelectorAll('#chat-list .chat-item .chat-title')].map((e) => e.textContent.trim()));
      return titles;
    };
    const readable = () => waitFor(() => app.evaluate(() => global.__chats.store().list().every((c) => Boolean(global.__chats.store().load(c.id)))), 10000); // (a saved chat is read back before History opens it)
    const closeHistory = () => ui.evaluate(() => { if (!document.getElementById('chat-list').hidden) document.getElementById('chat-history').click(); });

    // 1. default on: the first open is on an empty chat; send a message
    check('the setting is on by default', await app.evaluate(() => global.__settings.backend.prefs?.().sidebarNewChat ?? true) !== false, 'off');
    await toggle();
    check('opening shows an empty chat', await waitState(true) && await emptyShown(), 'not empty');
    await ask('say one');
    check('a reply arrives in the first chat', await waitFor(async () => (await userMsgs()).length === 1 && await ui.evaluate(() => document.querySelectorAll('.msg.assistant').length > 0)), JSON.stringify(await userMsgs()));
    await sleep(600);
    check('the chat is saved', (await stored()) === 1, await stored());

    // 2. close and open with the button: new empty chat, old one in History
    await toggle();
    check('the button closes the sidebar', await waitState(false), 'still open');
    await toggle();
    check('the button opens it again on a new, empty chat', await waitState(true) && await emptyShown() && (await userMsgs()).length === 0, JSON.stringify(await userMsgs()));
    let titles = await historyTitles();
    check('the earlier chat is in History', titles.some((t) => /say one/.test(t)), JSON.stringify(titles));
    await closeHistory();

    // 3. an empty chat is reused: closing and opening again piles up nothing
    await toggle(); await waitState(false);
    await toggle(); await waitState(true);
    await toggle(); await waitState(false);
    await toggle(); await waitState(true);
    check('empty chats are not piled up (still one saved chat, view empty)', (await stored()) === 1 && await emptyShown(), `${await stored()}`);

    // 4. History opens the old chat; with the setting off the sidebar reopens it
    await readable();
    titles = await historyTitles();
    await ui.evaluate(() => [...document.querySelectorAll('#chat-list .chat-item .chat-open')].find((b) => /say one/.test(b.textContent)).click());
    check('History opens the earlier chat', await waitFor(async () => (await userMsgs()).some((t) => /say one/.test(t))), JSON.stringify(await userMsgs()));
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
    await sleep(300);
    await toggle(); await waitState(false);
    await toggle(); await waitState(true);
    check('setting off: the sidebar reopens on the chat it had', (await userMsgs()).some((t) => /say one/.test(t)) && !(await emptyShown()), JSON.stringify(await userMsgs()));
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', true));
    await sleep(300);

    // 5. closing while a reply is being written does not cancel it, and the chat stays in History
    await ui.click('#new-chat');
    await ask('slow please');
    await waitFor(() => app.evaluate(() => typeof global.__gate === 'function'));
    await toggle();
    check('closing the sidebar while it writes', await waitState(false), 'open');
    await toggle();
    check('opening again shows a new empty chat while the first still works', await waitState(true) && await emptyShown(), JSON.stringify(await userMsgs()));
    await app.evaluate(() => global.__release());
    await sleep(800);
    await readable();
    titles = await historyTitles();
    check('the working chat finished and is in History', titles.some((t) => /^slow/.test(t)), JSON.stringify(titles));
    await ui.evaluate(() => [...document.querySelectorAll('#chat-list .chat-item .chat-open')].find((b) => /slow please/.test(b.textContent)).click());
    const kept = await waitFor(() => ui.evaluate(() => [...document.querySelectorAll('.msg.assistant')].some((e) => /Reply to slow/.test(e.textContent))));
    check('its whole reply was kept (closing did not cancel it)', kept === true, kept);
    await closeHistory();

    // 6. History from another tab: attach to a chat that lives in another tab, without leaving this one
    await app.evaluate(() => global.__settings.backend.set('oneChatPerTab', true));
    const tabB = await app.evaluate((_e, u) => global.__agent.browser.openTab(u).id, base);
    await app.evaluate((_e, i) => global.__agent.browser.switchTab(i), tabB);
    await waitFor(() => ui.evaluate((i) => document.querySelector('#tabs .tab.active')?.dataset.id === String(i), tabB));
    await sleep(300);
    const activeBefore = await app.evaluate(() => global.__windows.list().find((w) => w.current)?.activeId ?? global.__windows.list()[0].activeId);
    if (!(await pressed())) { await toggle(); await waitState(true); }
    await readable();
    titles = await historyTitles();
    check('History in another tab lists the first tab\'s chats', titles.some((t) => /say one/.test(t)), JSON.stringify(titles));
    await ui.evaluate(() => [...document.querySelectorAll('#chat-list .chat-item .chat-open')].find((b) => /say one/.test(b.textContent)).click());
    check('clicking it opens that chat in this tab\'s sidebar', await waitFor(async () => (await userMsgs()).some((t) => /say one/.test(t))), JSON.stringify(await userMsgs()));
    const activeAfter = await app.evaluate(() => global.__windows.list().find((w) => w.current)?.activeId ?? global.__windows.list()[0].activeId);
    check('...and stays on this tab', activeBefore === tabB && activeAfter === tabB, `${activeBefore} ${activeAfter}`);

    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
