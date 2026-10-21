// Model picker: each model gets a request shape it accepts, and a chat stays on one model.
const { _electron: electron } = require('playwright-core');
const path = require('path');

(async () => {
  // This test is about each Claude model's request shape, not connectivity, so give Anthropic a
  // (fake) key: the picker now only lists a provider's models once it's actually connected.
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

  await app.evaluate(() => {
    global.__params = [];
    global.__agent.getClient = () => ({
      beta: { messages: { stream: (params) => {
        global.__params.push(JSON.parse(JSON.stringify({ ...params, system: undefined })));
        const message = { role: 'assistant', model: params.model, stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 10 }, content: [
          { type: 'thinking', thinking: 'secret-' + params.model, signature: 'sig' },
          { type: 'text', text: 'reply from ' + params.model },
        ] };
        return {
          async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }; },
          finalMessage: async () => message,
        };
      } } },
    });
  });
  const lastParams = () => app.evaluate(() => global.__params[global.__params.length - 1]);
  const sendFromUi = async (text) => {
    await ui.fill('#prompt', text);
    await ui.press('#prompt', 'Enter');
    await ui.waitForFunction(() => !document.getElementById('send').classList.contains('stop'), null, { timeout: 5000 });
  };

  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.waitForTimeout(500);
  const options = await ui.$$eval('#model option', (os) => os.map((o) => o.value));
  // Claude API models, connected via ANTHROPIC_API_KEY above; 'claudecode:default' is added
  // separately when the Claude Code CLI is installed (test/e2e/claudecode.js).
  check('picker lists Auto and 5 models (a single Auto, no per-provider one, with one provider)', options.filter((o) => !o.startsWith('claudecode:') && o !== 'anthropic:auto').length === 6 && options[0] === 'auto' && !options.includes('anthropic:auto'), JSON.stringify(options));
  check('Auto is the default on a fresh profile (more than one model is connected)', (await ui.inputValue('#model')) === 'auto', await ui.inputValue('#model'));

  // [usage bars] A Claude API key has no plan window: its group in the picker carries no bar, and opening it asks for nothing new.
  // Opened up to three times: right after start-up something may close it again before it is read (seen about once in seven
  // runs on a busy machine, never caught in 30+ traced runs); a menu that won't stay open at all still fails, with its state.
  let opened = false;
  for (let i = 0; i < 3 && !opened; i++) {
    await ui.evaluate(() => modelPicker.open());
    opened = await ui.waitForSelector('.picker-menu:not([hidden]) .picker-group', { state: 'attached', timeout: 5000 }).then(() => true, () => false);
  }
  if (!opened) console.log('picker state: ' + JSON.stringify(await ui.evaluate(() => ({ menus: [...document.querySelectorAll('.picker-menu')].map((m) => ({ hidden: m.hidden, kids: m.children.length })), options: document.querySelectorAll('#model option').length }))));
  check('the model menu opens (and stays open to be read)', opened, 'never opened in 3 tries');
  const apiBars = await ui.evaluate(() => document.querySelectorAll('.picker-menu:not([hidden]) .ubar').length);
  await ui.evaluate(() => modelPicker.close(false));
  check('usage bars: a provider with no usage numbers (an API key) shows no bar in the model picker', apiBars === 0, String(apiBars));

  // The rest starts from Opus 5 and switches away and back, so pick it first.
  await ui.selectOption('#model', 'claude-opus-5');
  await ui.waitForTimeout(300);
  await sendFromUi('hello');
  let p = await lastParams();
  check('Opus 5: adaptive thinking + fallbacks + new web search', p.model === 'claude-opus-5' && p.thinking.type === 'adaptive' && p.fallbacks === 'default' && p.betas.includes('server-side-fallback-2026-07-01') && p.tools.some((t) => t.type === 'web_search_20260209'), JSON.stringify({ ...p, messages: undefined }).slice(0, 300));

  // Switching mid-chat starts a new chat.
  await ui.selectOption('#model', 'claude-haiku-5-5');
  await ui.waitForTimeout(400);
  check('switching model keeps the chat', (await ui.locator('.msg.user').count()) === 1 && (await ui.locator('.notice').last().innerText()).includes('Haiku 5.5'), await ui.locator('.msg.user').count());
  await sendFromUi('hi haiku');
  p = await lastParams();
  const haikuHistory = JSON.stringify(p.messages);
  check('new model sees the earlier messages', haikuHistory.includes('hello') && haikuHistory.includes('reply from claude-opus-5'), haikuHistory.slice(0, 300));
  check("previous model's thinking is not sent to the new model", !haikuHistory.includes('secret-claude-opus-5'), haikuHistory.slice(0, 300));
  check('Haiku 5.5: adaptive thinking, new web search, no fallbacks', p.model === 'claude-haiku-5-5' && p.thinking.type === 'adaptive' && !('fallbacks' in p) && p.tools.some((t) => t.type === 'web_search_20260209') && !p.betas.includes('server-side-fallback-2026-07-01'), JSON.stringify({ ...p, messages: undefined }).slice(0, 300));

  // The chat stays on its model even if the stored setting changes behind it.
  await ui.selectOption('#model', 'claude-opus-5');
  await ui.waitForTimeout(300);
  await sendFromUi('back to opus');
  p = await lastParams();
  const backHistory = JSON.stringify(p.messages);
  check('switching back: Opus 5 gets its own thinking back, not Haiku thinking', p.model === 'claude-opus-5' && backHistory.includes('secret-claude-opus-5') && !backHistory.includes('secret-claude-haiku-5-5') && backHistory.includes('reply from claude-haiku-5-5'), backHistory.slice(0, 400));
  const roles = p.messages.map((m) => m.role).join(',');
  check('history alternates user/assistant', roles === 'user,assistant,user,assistant,user', roles);

  await ui.selectOption('#model', 'claude-opus-5-5');
  await ui.waitForTimeout(300);
  await sendFromUi('summarize this page for me');
  p = await lastParams();
  check('Opus 5.5: adaptive + effort high + fallbacks', p.model === 'claude-opus-5-5' && p.thinking.type === 'adaptive' && p.output_config?.effort === 'high' && p.fallbacks === 'default', JSON.stringify({ ...p, messages: undefined }).slice(0, 300));
  await sendFromUi('what is the capital of France');
  p = await lastParams();
  check('Opus 5.5: a short plain question uses low effort and a small cap', p.model === 'claude-opus-5-5' && p.output_config?.effort === 'low' && p.max_tokens === 8000, JSON.stringify({ ...p, messages: undefined }).slice(0, 300));

  // Settings → AI → AI providers: the user's effort for the Claude API replaces the built-in one, only for a model that already takes one.
  await app.evaluate(() => global.__patchSettings({ aiEffort: { anthropic: 'medium' } }));
  await sendFromUi('what is the capital of Spain');
  p = await lastParams();
  check('Opus 5.5: the effort chosen in Settings → AI providers is sent (medium), over the built-in low', p.output_config?.effort === 'medium', JSON.stringify(p.output_config));
  const apiUse = await app.evaluate(() => global.__usage.summary({ cached: true }).then((s) => s.providers.anthropic));
  check('the Claude API turns are logged per provider with an estimated cost from the price table', apiUse && apiUse.week.turns >= 1 && apiUse.week.tokens >= 110 && apiUse.week.costUSD > 0 && /claude-opus-5-5/.test(apiUse.lastModel || ''), JSON.stringify(apiUse));
  await ui.selectOption('#model', 'claude-sonnet-5-5');
  await ui.waitForTimeout(300);
  await sendFromUi('sonnet');
  p = await lastParams();
  check('Sonnet 5.5: adaptive, no fallbacks', p.model === 'claude-sonnet-5-5' && p.thinking.type === 'adaptive' && !('fallbacks' in p), JSON.stringify({ ...p, messages: undefined }).slice(0, 300));

  await ui.selectOption('#model', 'claude-fable-5-1');
  await ui.waitForTimeout(300);
  await sendFromUi('fable');
  p = await lastParams();
  check('Fable 5.1: adaptive + fallbacks, no forced tool_choice', p.model === 'claude-fable-5-1' && p.thinking.type === 'adaptive' && p.fallbacks === 'default' && !('tool_choice' in p), JSON.stringify({ ...p, messages: undefined }).slice(0, 300));

  // The choice persists.
  check('choice is saved', (await ui.evaluate(() => window.assistant.getSettings())).model === 'claude-fable-5-1', 'not saved');

  // ---- Settings → AI → Model: the sidebar's own menu and the sidebar's own choice ----
  const sid = await app.evaluate(() => global.__settings.open('ai'));
  const inSettings = (code) => app.evaluate(async (_e, [i, c]) => { try { return await global.__settings.contents(i).executeJavaScript(c, true); } catch (err) { return 'ERROR ' + (err?.message || err); } }, [sid, code]);
  const until = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); } return v; };
  await until(() => inSettings('document.body?.dataset.ready === "1" && Boolean(document.querySelector("#ai-model"))'));
  // A real key press in the Settings tab (the page is not a Playwright page): Chromium input events through the DevTools protocol.
  const KEYS = { Down: ['ArrowDown', 40], Escape: ['Escape', 27], Return: ['Enter', 13] };
  const press = (name) => app.evaluate(async (_e, [i, [key, code]]) => { const wc = global.__settings.contents(i); if (!wc.debugger.isAttached()) wc.debugger.attach('1.3'); for (const type of ['rawKeyDown', 'keyUp']) await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code }); await new Promise((r) => setTimeout(r, 150)); }, [sid, KEYS[name]]);
  const btn = '.picker-host > .picker-button';
  const sideValue = () => ui.inputValue('#model');
  const setValue = () => inSettings('document.querySelector("#ai-model").value');
  const expanded = () => inSettings(`document.querySelector('${btn}').getAttribute('aria-expanded')`);
  const setText = () => inSettings(`(() => { const b = document.querySelector('${btn}'); return [...b.querySelectorAll('.picker-text, .picker-last:not([hidden])')].map((e) => e.textContent).join(' | '); })()`);
  const sideText = () => ui.evaluate(() => [...document.querySelectorAll('.model-picker .picker-button .picker-text, .model-picker .picker-button .picker-last:not([hidden])')].map((e) => e.textContent).join(' | '));
  const sideSet = (v) => ui.evaluate((value) => { const s = document.getElementById('model'); s.value = value; s.dispatchEvent(new Event('change', { bubbles: true })); }, v); // (the sidebar is behind the Settings tab: no Playwright click)

  const sideIds = await ui.$$eval('#model option', (os) => os.map((o) => o.value));
  const setIds = JSON.parse(await inSettings('JSON.stringify([...document.querySelectorAll("#ai-model option")].map((o) => o.value))'));
  check('Settings lists the same models as the sidebar, Auto first', JSON.stringify(setIds) === JSON.stringify(sideIds) && setIds[0] === 'auto', JSON.stringify([setIds, sideIds]));
  check('only connected models are listed (the Claude key is the only one: no OpenAI, Grok, Gemini or OpenRouter rows)', setIds.length > 2 && !setIds.some((id) => /^(openai|xai|gemini|openrouter):/.test(id)), JSON.stringify(setIds));
  check('Settings and the sidebar show the same selected model', (await setValue()) === (await sideValue()), `${await setValue()} vs ${await sideValue()}`);

  // Sidebar -> Settings
  await sideSet('claude-sonnet-5-5');
  check('picking in the sidebar changes Settings', Boolean(await until(async () => (await setValue()) === 'claude-sonnet-5-5')), await setValue());
  check('...and its button names that model', /Sonnet 5\.5/.test(await setText()), await setText());

  // Settings -> sidebar, by keyboard only: Down opens the menu, Down moves, Enter picks, Escape closes.
  await inSettings(`document.querySelector('${btn}').focus(), 1`);
  await press('Down');
  check('Arrow Down opens the menu (aria-expanded true, a listbox on screen)', Boolean(await until(async () => (await expanded()) === 'true' && (await inSettings("Boolean(document.querySelector('.picker-menu:not([hidden]) [role=listbox]'))")) === true)), await inSettings(`document.querySelector('${btn}').outerHTML.slice(0, 200)`));
  await press('Escape');
  check('Escape closes it again and keeps the choice', Boolean(await until(async () => (await expanded()) === 'false')) && (await setValue()) === 'claude-sonnet-5-5', `${await expanded()} ${await setValue()}`);
  await inSettings(`document.querySelector('${btn}').focus(), 1`);
  await press('Down');
  await until(async () => (await expanded()) === 'true');
  await press('Down');
  await press('Return');
  const picked = await until(async () => { const v = await setValue(); return v !== 'claude-sonnet-5-5' ? v : null; });
  check('Down, Down, Enter in Settings picks another model', Boolean(picked), String(picked));
  check('...and the sidebar follows', Boolean(await until(async () => (await sideValue()) === picked)), `${await sideValue()} vs ${picked}`);
  check('...and the choice is saved', (await ui.evaluate(() => window.assistant.getSettings())).model === picked, String(picked));
  check('the button has an accessible name (Model) and a listbox popup', (await inSettings(`(() => { const b = document.querySelector('${btn}'); return /^Model/.test(b.getAttribute('aria-label') || '') && b.getAttribute('aria-haspopup') === 'listbox'; })()`)) === true, await inSettings(`document.querySelector('${btn}').getAttribute('aria-label')`));

  // Auto says what it is, and only names a model as "last used".
  await sideSet('auto');
  await until(async () => (await setValue()) === 'auto');
  await app.evaluate(() => { const m = global.__agent.messages; if (m) { m.settings ||= {}; delete m.settings.autoLast; } global.__modelsChanged(); });
  check('Auto with nothing chosen yet reads just "Auto" (no model name), in Settings and the sidebar', Boolean(await until(async () => (await setText()) === 'Auto' && (await sideText()) === 'Auto')), `${await setText()} / ${await sideText()}`);
  const autoRow = await ui.evaluate(() => window.assistant.getSettings().then((s) => s.models[0]));
  check('the Auto row explains itself and is not a model name', autoRow.id === 'auto' && autoRow.label === 'Auto' && /best connected model for each message/.test(autoRow.detail) && !autoRow.lastUsed, JSON.stringify(autoRow));
  await app.evaluate(() => { const m = global.__agent.messages; m.settings ||= {}; m.settings.autoLast = { id: 'claude-opus-5', label: 'Auto · Opus 5', reason: 'Auto: Opus 5 for hard code' }; global.__modelsChanged(); });
  check('after Auto chose a model, both say "Auto" plus "last used: <that model>"', Boolean(await until(async () => /^Auto \| last used: Opus 5$/.test(await setText()) && /^Auto | last used: Opus 5$/.test(await sideText()))), `${await setText()} / ${await sideText()}`);
  await app.evaluate(() => { global.__agent.messages.settings.autoLast = { id: 'openai:gpt-gone', label: 'Auto · GPT Gone', reason: 'Auto: GPT Gone for chat' }; global.__modelsChanged(); });
  check('a last choice that is no longer connected is not shown', Boolean(await until(async () => (await setText()) === 'Auto')), await setText());
  await app.evaluate(() => { delete global.__agent.messages.settings.autoLast; global.__modelsChanged(); });

  // Looks: one centre line, the other dropdowns' size and radius, theme tokens in light and dark.
  const geometry = () => inSettings(`(() => { const b = document.querySelector('${btn}'); const c = (e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; }; const sel = [...document.querySelectorAll('select')].find((s) => s.offsetParent && !s.classList.contains('picker-native')); const cs = getComputedStyle(b); const ss = getComputedStyle(sel); return { text: c(b.querySelector('.picker-text')), chevron: c(b.querySelector('.picker-chevron')), button: c(b), h: b.getBoundingClientRect().height, sh: sel.getBoundingClientRect().height, r: cs.borderRadius, sr: ss.borderRadius, bg: cs.backgroundColor, sbg: ss.backgroundColor }; })()`);
  for (const scheme of ['light', 'dark']) {
    await app.evaluate(({ nativeTheme }, s) => { nativeTheme.themeSource = s; }, scheme);
    await until(async () => (await inSettings(`matchMedia('(prefers-color-scheme: ${scheme})').matches`)) === true, 3000);
    const g = await geometry();
    check(`${scheme}: the label and the chevron share one centre line (within 2px)`, Math.abs(g.text - g.chevron) <= 2 && Math.abs(g.text - g.button) <= 2, JSON.stringify(g));
    check(`${scheme}: same height, radius and background as the other Settings dropdowns`, g.h === g.sh && g.r === g.sr && g.bg === g.sbg, JSON.stringify(g));
  }
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system'; });

  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
