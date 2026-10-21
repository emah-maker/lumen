// The sidebar button (Ask AI) opens on a NEW chat, never the tab's last one (main.js chat:sidebar-target, app.js toggleSidebarByHand), with a
// fake slow model and invisible windows (LUMEN_TEST_BACKGROUND=1). With "Sidebar button starts a new chat" ON (the default):
//   a run streaming on this tab, sidebar closed: opening shows a new empty chat; the run keeps going and is listed as working;
//   a reply that finished while the sidebar was closed: opening shows a new empty chat too (the reply is in History);
//   an empty chat open already: it is reused (no pile of empty chats);
//   a run waiting for an OK: opening shows its approval card (a question waiting for the user is never hidden);
//   New chat pressed inside the sidebar during a run: a new chat starts; the old one keeps working and is listed as working.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(80); } return v; };

// "slow": streams "Reply", then waits for global.__release(), then finishes "Reply to slow".
// "approve": tries to click on the page, which asks for an OK first (the site is not allowed yet).
const fakeModel = (app, other) => app.evaluate((_e, otherUrl) => {
  global.__gate = null;
  global.__agent.browser.autoApprove = () => false; // (tests auto-allow by default: this suite wants the real card)
  global.__release = () => { global.__gate?.(); };
  global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
    const first = params.messages.find((m) => m.role === 'user');
    const asked = JSON.stringify(first?.content || '');
    const last = params.messages.at(-1);
    const tools = params.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')).length;
    const usage = { input_tokens: 10, output_tokens: 5 };
    const done = (content, stop_reason) => ({ role: 'assistant', model: 'claude-opus-5', stop_reason, content, usage });
    if (/approve/.test(asked)) {
      const step = tools === 0 ? { name: 'click', input: { text: 'PAGE' } } : null;
      if (step) {
        const msg = done([{ type: 'text', text: 'Going' }, { type: 'tool_use', id: `tu-${tools}`, ...step }], 'tool_use');
        return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Going' } }; }, finalMessage: async () => msg };
      }
    }
    const slow = /slow/.test(asked) && last.role === 'user';
    const text = /slow/.test(asked) ? 'Reply to slow' : 'Reply to x';
    const message = done([{ type: 'text', text }], 'end_turn');
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reply' } };
        if (slow) await new Promise((r) => { global.__gate = r; });
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(5) } };
      },
      finalMessage: async () => message,
    };
  } } } });
}, other);

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Page</title><body><h1>PAGE</h1></body>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const other = `http://localhost:${server.address().port}/b`; // another host than 127.0.0.1
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sidebarkeeps-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await fakeModel(app, other);
    await app.evaluate(({ webContents }, u) => { const t = global.__windows.list()[0].tabs[0]; webContents.fromId(t.contentsId).loadURL(u); }, `${base}/a`);
    await waitFor(() => app.evaluate(() => /\/a$/.test(global.__windows.list()[0].tabs[0].url)));

    const pressed = () => ui.evaluate(() => document.getElementById('toggle-sidebar').getAttribute('aria-pressed') === 'true');
    const settled = () => ui.evaluate(() => !document.body.classList.contains('sidebar-moving'));
    const waitState = (want) => waitFor(async () => (await pressed()) === want && (await settled()));
    const toggle = () => ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    const open = async () => { if (await pressed()) { await toggle(); await waitState(false); } await toggle(); return waitState(true); };
    const close = async () => { if (await pressed()) await toggle(); return waitState(false); };
    const userMsgs = () => ui.evaluate(() => [...document.querySelectorAll('.msg.user')].map((e) => e.textContent.trim()));
    const emptyShown = () => ui.evaluate(() => !document.getElementById('empty').hidden);
    const chatId = () => app.evaluate(() => global.__tabChats.chatId());
    const attention = () => ui.evaluate(() => document.getElementById('toggle-sidebar').dataset.attention || '');
    const working = () => ui.evaluate(() => document.getElementById('send').classList.contains('stop'));
    const ask = async (text) => { await ui.fill('#prompt', text); await ui.press('#prompt', 'Enter'); };
    const gated = () => waitFor(() => app.evaluate(() => typeof global.__gate === 'function'));
    const release = async () => { await app.evaluate(() => { global.__release(); global.__gate = null; }); };
    const idle = () => waitFor(() => app.evaluate(() => global.__tabChats.runs().every((r) => !r.live)), 10000);

    check('the setting is on by default', await app.evaluate(() => global.__settings.backend.prefs?.().sidebarNewChat ?? true) !== false, 'off');

    // 1. a run streaming on this tab, sidebar closed: opening shows a new empty chat; the run goes on
    await open();
    await ask('slow please');
    await gated();
    const chatA = await chatId();
    check('chat A is working', await waitFor(() => working()), 'not working');
    await close();
    check('the run goes on with the sidebar closed', await app.evaluate(() => global.__tabChats.runs().some((r) => r.live)), 'not live');
    await open();
    const chatNew = await chatId();
    check('opening shows a NEW empty chat, not the last chat of this tab', chatNew !== chatA && await emptyShown() && (await userMsgs()).length === 0, `${chatNew} ${await userMsgs()}`);
    check('the running chat keeps going in the background and is listed as working', await app.evaluate((_e, id) => global.__tabChats.runs().some((r) => r.chatId === id && r.live), chatA), 'not live');
    await release();
    check('the old chat finishes its reply', await waitFor(() => app.evaluate((_e, id) => global.__tabChats.runs().every((r) => r.chatId !== id || !r.live), chatA)), 'still live');
    await idle();

    // 2. a reply that finished while the sidebar was closed: a new empty chat too (the finished one is in History)
    await ask('slow again please');
    await gated();
    const chatB2 = await chatId();
    await close();
    await release();
    await idle();
    check('the finished reply is unread on the closed sidebar button', await waitFor(async () => (await attention()) === 'unread'), await attention());
    await open();
    check('opening shows a new empty chat, not the one with the finished reply', (await chatId()) !== chatB2 && await emptyShown() && (await userMsgs()).length === 0, `${await chatId()} ${await userMsgs()}`);

    // 3. an empty chat is open: reuse it (no duplicate empty chats)
    const chatEmpty = await chatId();
    await close();
    await open();
    const chatB = await chatId();
    check('an empty chat open already is reused', chatB === chatEmpty && chatB !== chatA && await emptyShown() && (await userMsgs()).length === 0, `${chatB} ${chatEmpty}`);

    // 4. a run waiting for an OK: opening shows its approval card
    await ask('approve please');
    const card = () => ui.evaluate(() => Boolean(document.querySelector('#messages .approval')));
    check('the run asks for an OK', await waitFor(card, 10000), await ui.evaluate(() => document.getElementById('messages').innerText.slice(-300)));
    const chatC = await chatId();
    await close();
    check('the run still waits with the sidebar closed', await app.evaluate(() => global.__tabChats.runs().some((r) => r.live)), 'not live');
    // (a new chat view in between would lose the card: open something else first)
    await open();
    check('opening shows the same chat with its approval card', (await chatId()) === chatC && await card(), `${await chatId()} ${await card()}`);
    await ui.evaluate(() => [...document.querySelectorAll('#messages .approval button')].pop().click()); // Don't allow
    await idle();

    // 5. New chat pressed inside the sidebar during a run: a new chat; the old one keeps working and is listed
    await close();
    await open(); // (the run before ended: this is a new chat)
    await ask('slow please');
    await gated();
    const chatD = await chatId();
    await ui.click('#new-chat');
    check('New chat inside the sidebar starts a new chat', await waitFor(async () => (await chatId()) !== chatD && await emptyShown()), `${await chatId()}`);
    check('the old chat keeps working in the background', await app.evaluate((_e, id) => global.__tabChats.runs().some((r) => r.chatId === id && r.live), chatD), 'not live');
    await ui.click('#chat-history');
    await waitFor(() => ui.evaluate(() => !document.getElementById('chat-list').hidden));
    const badge = await waitFor(() => ui.evaluate(() => [...document.querySelectorAll('#chat-list .chat-item')].some((li) => /slow/.test(li.textContent) && li.classList.contains('has-running'))));
    check('it is listed with its working badge', badge === true, badge);
    await ui.evaluate(() => { if (!document.getElementById('chat-list').hidden) document.getElementById('chat-history').click(); });
    await release();
    await idle();

    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
