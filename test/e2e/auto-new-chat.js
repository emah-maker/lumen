// Settings → AI → "Start a new chat for a new topic" (autoNewChat), with a fake model and invisible windows
// (LUMEN_TEST_BACKGROUND=1): on (the default), a typed message about something else moves to a new chat with the
// "Keep in last chat" notice; off, the same kind of message stays in the chat that is open.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(80); } return v; };

// Every reply is "Done." (only stopwords, so the reply never ties a new message to the chat).
const fakeModel = (app) => app.evaluate(() => {
  global.__agent.getClient = () => ({ beta: { messages: { stream: () => {
    const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 10, output_tokens: 2 } };
    return {
      async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } }; },
      finalMessage: async () => message,
    };
  } } } });
});

const FIRST = 'Explain photosynthesis in green plants';
const OTHER = 'Recommend banana bread recipes for baking'; // nothing in common with FIRST (renderer/chat-topic.js)

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-autonewchat-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await fakeModel(app);

    const userMsgs = () => ui.evaluate(() => [...document.querySelectorAll('.msg.user')].map((e) => e.textContent.trim()));
    const replies = () => ui.evaluate(() => document.querySelectorAll('.msg.assistant:not(.streaming)').length);
    const splits = () => ui.evaluate(() => document.querySelectorAll('.notice.topic-split').length);
    const current = () => ui.evaluate(() => window.assistant.chats.list().then((r) => r.current));
    const ask = async (text) => { await ui.fill('#prompt', text); await ui.press('#prompt', 'Enter'); };
    const askAndWait = async (text, wantReplies) => { await ask(text); return waitFor(async () => (await replies()) >= wantReplies && (await userMsgs()).includes(text)); };

    if (await ui.evaluate(() => document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true')) await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await waitFor(() => ui.evaluate(() => document.getElementById('toggle-sidebar').getAttribute('aria-pressed') === 'true'));

    // 1. on (the default): a message about something else moves to a new chat
    check('the setting is on by default', await app.evaluate(() => global.__settings.backend.prefs?.().autoNewChat ?? true) === true && await ui.evaluate(() => window.lumenAutoNewChat !== false), 'off');
    check('the first message gets a reply', await askAndWait(FIRST, 1), JSON.stringify(await userMsgs()));
    const chatA = await current();
    check('on: the message about something else gets a reply', await askAndWait(OTHER, 1), JSON.stringify(await userMsgs()));
    const chatB = await current();
    check('on: it moved to a new chat, with the notice', chatB && chatB !== chatA && (await splits()) === 1 && !(await userMsgs()).includes(FIRST), JSON.stringify({ chatA, chatB, splits: await splits(), msgs: await userMsgs() }));

    // 2. off: the same kind of message stays in the chat that is open
    await app.evaluate(() => global.__settings.backend.set('autoNewChat', false));
    check('off: the switch reaches the sidebar', await waitFor(() => ui.evaluate(() => window.lumenAutoNewChat === false)), 'still on');
    await ui.click('#new-chat');
    await waitFor(async () => (await userMsgs()).length === 0);
    check('off: the first message gets a reply', await askAndWait(FIRST, 1), JSON.stringify(await userMsgs()));
    const chatC = await current();
    check('off: the message about something else gets a reply', await askAndWait(OTHER, 2), JSON.stringify(await userMsgs()));
    await sleep(400);
    const msgs = await userMsgs();
    check('off: it stayed in the same chat, with no notice', (await current()) === chatC && (await splits()) === 0 && msgs.length === 2 && msgs[0] === FIRST && msgs[1] === OTHER, JSON.stringify({ chatC, now: await current(), splits: await splits(), msgs }));

    // 3. on again: it splits again (the switch is read each time, not once)
    await app.evaluate(() => global.__settings.backend.set('autoNewChat', true));
    await waitFor(() => ui.evaluate(() => window.lumenAutoNewChat === true));
    await ask('Compare mountain bikes gravel tires');
    check('on again: a new topic moves to a new chat', await waitFor(async () => (await current()) !== chatC && (await splits()) === 1), JSON.stringify({ chatC, now: await current(), splits: await splits() }));

    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (e) {
    failures++;
    console.log(`FAIL  threw: ${e.stack || e}`);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
