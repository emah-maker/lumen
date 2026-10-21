// The chat's reasoning effort in the composer's model menu: an "Effort" row (only for models that take one), a quiet suffix on the
// picker button, per chat (saved with it, new chats start on Auto), the choice reaching the request, and the same on lumen://chat.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-effort-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return v; };

  // A stand-in for the Claude API: records each request, answers at once.
  await app.evaluate(() => {
    global.__params = [];
    global.__agent.getClient = () => ({
      beta: { messages: { stream: (params) => {
        global.__params.push(JSON.parse(JSON.stringify({ ...params, system: undefined })));
        const message = { role: 'assistant', model: params.model, stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: 'text', text: 'reply' }] };
        return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'reply' } }; }, finalMessage: async () => message };
      } } },
    });
  });
  const lastParams = () => app.evaluate(() => global.__params[global.__params.length - 1]);
  const send = async (text) => {
    await ui.fill('#prompt', text);
    await ui.press('#prompt', 'Enter');
    await ui.waitForFunction(() => !document.getElementById('send').classList.contains('stop') && document.querySelectorAll('.msg').length > 0, null, { timeout: 8000 });
    await ui.waitForTimeout(300);
  };
  const button = '.composer-bar .picker-button';
  const open = async () => { await ui.click(button); await ui.waitForSelector('.composer-bar .picker-menu:not([hidden])'); };
  const close = async () => { await ui.keyboard.press('Escape'); await ui.waitForSelector('.composer-bar .picker-menu[hidden]', { state: 'attached' }); };
  const row = () => ui.evaluate(() => {
    const r = document.querySelector('.composer-bar .picker-effort');
    return r && !r.hidden ? { opts: [...r.querySelectorAll('.picker-effort-opt')].map((b) => b.textContent), on: r.querySelector('.picker-effort-opt.on')?.textContent, hint: r.querySelector('.picker-effort-hint').textContent } : null;
  });
  const tag = () => ui.evaluate(() => { const t = document.querySelector('.composer-bar .picker-effort-tag'); return t && !t.hidden ? t.textContent : ''; });
  const chatEffort = () => ui.evaluate(() => window.assistant.getSettings().then((s) => s.effort));

  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.waitForTimeout(500);

  // ---- Opus 5.5 takes an effort (low, medium, high); Auto is the default
  await ui.selectOption('#model', 'claude-opus-5-5');
  await ui.waitForTimeout(300);
  check('a new chat starts on Auto: no suffix on the button', (await tag()) === '' && (await chatEffort()) === '', await tag());
  await open();
  let r = await row();
  check('the menu has an Effort row: Auto, Low, Med, High (Opus 5.5)', r && r.opts.join() === 'Auto,Low,Med,High' && r.on === 'Auto', JSON.stringify(r));
  const sized = await ui.evaluate(() => { const b = document.querySelector('.composer-bar .picker-button').getBoundingClientRect(); return { w: b.width, h: b.height }; });
  // Arrow keys: Tab from the search field reaches the control, Right chooses Low then Med, Left goes back.
  await ui.keyboard.press('Tab');
  check('Tab from the search field lands on the effort control', await ui.evaluate(() => document.activeElement?.classList.contains('picker-effort-opt')), 'not focused');
  await ui.keyboard.press('ArrowRight');
  await ui.keyboard.press('ArrowRight');
  r = await row();
  check('Right arrow twice chooses Med, and the hint says what it trades', r?.on === 'Med' && /balanced/i.test(r.hint), JSON.stringify(r));
  await ui.keyboard.press('ArrowLeft');
  r = await row();
  check('Left arrow goes back to Low', r?.on === 'Low', JSON.stringify(r));
  await ui.keyboard.press('ArrowRight');
  await ui.waitForTimeout(200);
  check('the choice is the chat’s (main has Medium) and shows as a quiet suffix', (await chatEffort()) === 'medium' && (await tag()) === '· Med', `${await chatEffort()} ${await tag()}`);
  await close();
  const after = await ui.evaluate(() => { const b = document.querySelector('.composer-bar .picker-button').getBoundingClientRect(); return { w: b.width, h: b.height }; });
  check('the picker button grows by its suffix only (same height, no new element in the toolbar)', after.h === sized.h && after.w - sized.w < 60 && (await ui.evaluate(() => document.querySelectorAll('.composer-bar .picker-effort-tag').length)) === 1, JSON.stringify({ sized, after }));

  // ---- it reaches the request
  await send('what is the capital of France');
  let p = await lastParams();
  check('Medium reaches the request as output_config.effort (over the built-in low for a short question)', p.model === 'claude-opus-5-5' && p.output_config?.effort === 'medium', JSON.stringify(p.output_config));
  await open();
  await ui.click('.composer-bar .picker-effort-opt[data-level="high"]');
  await close();
  await send('and Spain');
  p = await lastParams();
  check('High reaches the next request', p.output_config?.effort === 'high', JSON.stringify(p.output_config));

  // ---- saved with the chat
  const chatId = await app.evaluate(() => global.__chats.id());
  const saved = await waitFor(() => app.evaluate((_e, id) => global.__chats.store().load(id)?.settings?.effort, chatId));
  check('the effort is saved with the chat', saved === 'high', String(saved));

  // ---- a new chat starts on Auto; the old one keeps its own
  await ui.click('#new-chat');
  await waitFor(() => ui.evaluate(() => !document.querySelector('.msg')));
  check('a new chat is back on Auto (no suffix)', (await chatEffort()) === '' && (await tag()) === '', `${await chatEffort()} ${await tag()}`);
  await send('a new topic');
  p = await lastParams();
  check('a new chat sends the built-in effort again (Auto: nothing changed)', p.output_config?.effort !== 'high', JSON.stringify(p.output_config));
  await ui.click('#chat-history');
  await ui.waitForSelector('#chat-list:not([hidden]) .chat-item');
  await ui.evaluate(() => [...document.querySelectorAll('.chat-item')].find((li) => !li.classList.contains('current')).querySelector('.chat-open').click());
  await waitFor(async () => (await chatEffort()) === 'high');
  if (await ui.evaluate(() => !document.getElementById('chat-list').hidden)) await ui.click('#chat-history');
  await ui.waitForSelector('#chat-list', { state: 'hidden' });
  check('opening the older chat brings its High back', (await chatEffort()) === 'high' && (await tag()) === '· High', `${await chatEffort()} ${await tag()}`);

  // ---- a model with no effort control: no row
  await ui.selectOption('#model', 'claude-haiku-5-5');
  await ui.waitForTimeout(300);
  await open();
  check('a model with no effort control (Haiku 5.5) has no Effort row, and no suffix', (await row()) === null && (await tag()) === '', JSON.stringify(await row()));
  await close();
  await ui.selectOption('#model', 'auto');
  await ui.waitForTimeout(300);
  await open();
  check('Auto (the model) has no Effort row either', (await row()) === null, JSON.stringify(await row()));
  await close();

  // ---- lumen://chat
  await ui.selectOption('#model', 'claude-opus-5-5');
  await ui.waitForTimeout(300);
  await ui.evaluate(() => document.getElementById('open-chat-page').click());
  const pageTab = await waitFor(async () => (await app.evaluate(() => global.__chatPage.tabs())).find((t) => t.chat && /chat-page\.html$/.test(t.url)));
  const inPage = (code) => app.evaluate(async (_e, [id, c]) => { try { return await global.__chatPage.contents(id).executeJavaScript(c, true); } catch (err) { return 'ERROR ' + (err?.message || err); } }, [pageTab?.id, code]);
  await waitFor(async () => (await inPage("document.readyState === 'complete' && Boolean(document.querySelector('.picker-button'))")) === true);
  check('lumen://chat shows the same suffix for the chat', (await waitFor(async () => (await inPage("document.querySelector('.composer-bar .picker-effort-tag:not([hidden])')?.textContent || ''")) === '· High')) === true, await inPage("document.querySelector('.composer-bar .picker-effort-tag')?.textContent"));
  await inPage("document.querySelector('.composer-bar .picker-button').click()");
  const pageRow = await waitFor(async () => inPage("[...document.querySelectorAll('.composer-bar .picker-effort:not([hidden]) .picker-effort-opt')].map((b) => b.textContent).join()"));
  check('lumen://chat has the Effort row in its model menu', pageRow === 'Auto,Low,Med,High', String(pageRow));
  await inPage("document.querySelector('.composer-bar .picker-effort-opt[data-level=\"low\"]').click()");
  await waitFor(async () => (await chatEffort()) === 'low');
  check('a pick made on the page is the chat’s everywhere (the sidebar follows)', (await chatEffort()) === 'low' && (await waitFor(async () => (await tag()) === '· Low')) === true, `${await chatEffort()} ${await tag()}`);

  check('no page errors', errors.length === 0, errors.join(' | '));
  await app.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
