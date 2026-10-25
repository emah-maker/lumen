// IME Enter, end to end (hidden window, a fake Claude client: no network, no key): the Enter that confirms a Japanese / Chinese / Korean
// composition must not send the chat message or run the address bar's action. Chromium marks that keydown isComposing / keyCode 229; a
// Safari-style engine sends it right after compositionend with both cleared. A plain Enter afterwards still sends (the positive control).
// Run it with LUMEN_TEST_BACKGROUND=1 so no window shows. IME_APP_DIR runs another checkout; IME_SHOT=<png path> saves the sidebar.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(100); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ime-'));
  const env = { ...process.env, LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' };
  const app = await electron.launch({ args: [process.env.IME_APP_DIR || path.join(__dirname, '..', '..')], env });
  try {
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate(() => {
      let n = 0;
      global.__sent = [];
      global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
        const last = params.messages[params.messages.length - 1];
        global.__sent.push(Array.isArray(last.content) ? last.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : String(last.content));
        const text = `Reply ${++n}.`;
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } };
        return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }; }, finalMessage: async () => message };
      } } } });
    });
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await ui.waitForSelector('#prompt', { state: 'visible' });
    const sent = () => app.evaluate(() => global.__sent.length);
    // A keydown on an element, the way an IME's confirming Enter arrives (init = KeyboardEvent fields).
    const key = (sel, init) => ui.evaluate(([s, i]) => { const el = document.querySelector(s); el.focus(); return el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...i })); }, [sel, init]);
    const value = (sel) => ui.evaluate((s) => document.querySelector(s).value, sel);

    // ---- the chat box
    await ui.fill('#prompt', 'こんにちは');
    await key('#prompt', { isComposing: true });
    await key('#prompt', { keyCode: 229 });
    await ui.evaluate(() => document.getElementById('prompt').dispatchEvent(new CompositionEvent('compositionend', { data: 'こんにちは', bubbles: true })));
    await key('#prompt', { keyCode: 13 }); // Safari: the confirming Enter lands just after compositionend
    await sleep(500);
    check('chat box: a composing Enter (isComposing, keyCode 229, right after compositionend) sends nothing', (await sent()) === 0, await sent());
    check('chat box: the typed text stays in the box', (await value('#prompt')) === 'こんにちは', await value('#prompt'));
    if (process.env.IME_SHOT) fs.writeFileSync(process.env.IME_SHOT, await ui.screenshot());
    await sleep(150);
    await key('#prompt', { keyCode: 13 });
    check('chat box: a plain Enter later still sends', await waitFor(async () => (await sent()) === 1), await sent());
    await waitFor(() => ui.evaluate(() => !document.getElementById('send').classList.contains('stop')));

    // ---- the address bar (Alt+Enter asks the AI about what is typed; a plain Enter navigates through the form)
    const before = await sent();
    await ui.fill('#address', 'にほんご');
    await key('#address', { isComposing: true, altKey: true });
    await key('#address', { keyCode: 229, altKey: true });
    await sleep(500);
    check('address bar: a composing Alt+Enter asks nothing', (await sent()) === before, await sent());
    check('address bar: the typed text stays in the field (no navigation or reset)', (await value('#address')) === 'にほんご', await value('#address'));
    await key('#address', { altKey: true });
    check('address bar: a plain Alt+Enter afterwards still asks the AI', await waitFor(async () => (await sent()) === before + 1), await sent());
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
