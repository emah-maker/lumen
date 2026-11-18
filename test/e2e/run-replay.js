// [run replay] A sidebar chat left while its reply runs, then opened again, shows everything the reply had shown (features/run-replay.js,
// chat-core.js resumeLive), the way the user saw it go wrong (2026-11-17): they switched tabs mid-reply, came back, and the reply's card
// was gone, only their message and the working line were left, as if the chat had lost what it was doing.
//  - a reply takes two steps and is held after them (in a window this fresh its first steps draw as plain rows: the card code loads with them)
//  - the user goes to another tab (its own chat) and back: the steps are there again, once each, in the reply's card, while it still runs
//    (before the fix: none of them, only the user's message, the words before the steps and the working line)
//  - the reply ends: the card is still there once, with the reply's words
// A stubbed provider (no network, no key). Hidden: LUMEN_TEST_BACKGROUND=1, a temp profile.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-runreplay-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' } });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    // The model reads the page once, then its answer waits while global.__hold is set.
    await app.evaluate(() => {
      global.__hold = new Promise((r) => { global.__release = r; });
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
        const usage = { input_tokens: 100, output_tokens: 20 };
        const afterTool = params.messages[params.messages.length - 1]?.content?.some?.((b) => b.type === 'tool_result');
        if (!afterTool) {
          const text = 'Reading the course page first.';
          return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; }, finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'text', text }, { type: 'tool_use', id: 'tu-1', name: 'read_page', input: {} }, { type: 'tool_use', id: 'tu-2', name: 'list_tabs', input: {} }], usage }) };
        }
        const text = 'Here is the cheat sheet.';
        return { async *[Symbol.asyncIterator]() { if (global.__hold) await global.__hold; yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; }, finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage }) };
      } } } });
    });
    const tabIds = () => ui.evaluate(() => [...document.querySelectorAll('.tab')].map((t) => Number(t.dataset.id)));
    const firstTab = (await tabIds())[0];
    await app.evaluate(() => { global.__settings.backend.set('sidebarNewChat', false); global.__settings.backend.set('oneChatPerTab', true); }); // (the other tab gets its own chat, as the user's did)
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    const sidebar = await waitFor(() => ui.evaluate(() => Boolean(document.getElementById('prompt')?.offsetParent)), 20000);
    check('the sidebar chat is there', sidebar, 'no #prompt');
    const state = () => ui.evaluate(() => ({
      cards: document.querySelectorAll('#messages .act-card').length,
      steps: document.querySelectorAll('#messages .step').length,
      user: [...document.querySelectorAll('#messages .msg.user')].map((m) => m.textContent.trim()).join(' | '),
      working: Boolean(document.querySelector('#messages .working')),
      text: [...document.querySelectorAll('#messages .msg, #messages .act-card, #messages .notice, #messages .error')].map((m) => m.textContent.trim()).join(' | '),
      running: document.getElementById('send')?.classList.contains('stop') || false,
      kids: [...document.getElementById('messages').children].map((c) => c.className).join(' / '),
    }));
    await ui.evaluate(() => { const p = document.getElementById('prompt'); p.value = 'make a cheat sheet from the course page'; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); });
    const before = await waitFor(async () => { const s = await state(); return s.steps >= 1 && s.running ? s : null; }, 20000);
    check('the reply took its step: its steps show, still running', before && before.steps >= 2, JSON.stringify(before || await state()));

    // Another tab (its own chat), then back.
    const other = await app.evaluate(async () => global.__agent.browser.openTab('about:blank')?.id ?? null);
    const otherId = other ?? (await tabIds()).find((id) => id !== firstTab);
    await app.evaluate((_e, id) => global.__chatPage.switchTab(id), otherId);
    const away = await waitFor(async () => { const s = await state(); return !/cheat sheet from the course page/.test(s.user) ? s : null; }, 8000);
    check('another tab shows its own chat (the running one is left)', Boolean(away), JSON.stringify(await state()));
    await app.evaluate((_e, id) => global.__chatPage.switchTab(id), firstTab);
    const back = await waitFor(async () => { const s = await state(); return /cheat sheet from the course page/.test(s.user) && s.working ? s : null; }, 8000);
    await sleep(600);
    const shown = await state();
    check('back on the tab mid-reply: its steps are drawn again, once each, in one card, with the working line', back && shown.cards === 1 && shown.steps === before?.steps && shown.working && shown.running, JSON.stringify(shown));
    check('back on the tab mid-reply: its words before the step are there too, once', (shown.text.match(/Reading the course page first\./g) || []).length === 1, shown.text.slice(0, 400));

    await app.evaluate(() => { global.__release?.(); global.__hold = null; });
    const done = await waitFor(async () => { const s = await state(); return !s.running && /Here is the cheat sheet\./.test(s.text) ? s : null; }, 20000);
    check('the reply ends in the same card: the same card and steps, once, its answer shown', done && done.cards === 1 && done.steps === before?.steps, JSON.stringify(done || await state()));
  } catch (err) {
    failures++;
    console.log('FAIL  threw', err && err.stack);
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* busy */ }
  }
  console.log(failures ? `\n${failures} failed` : '\nall run-replay checks passed');
  process.exit(failures ? 1 : 0);
})();
