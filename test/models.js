// Model picker: each model gets a request shape it accepts, and a chat stays on one model.
const { _electron: electron } = require('playwright-core');
const path = require('path');

(async () => {
  // This test is about each Claude model's request shape, not connectivity, so give Anthropic a
  // (fake) key: the picker now only lists a provider's models once it's actually connected.
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
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
        const message = { role: 'assistant', model: params.model, stop_reason: 'end_turn', content: [
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
  // separately when the Claude Code CLI is installed (test/claudecode.js).
  check('picker lists Auto and 5 models', options.filter((o) => !o.startsWith('claudecode:')).length === 6 && options[0] === 'auto', JSON.stringify(options));
  check('Auto is the default on a fresh profile (more than one model is connected)', (await ui.inputValue('#model')) === 'auto', await ui.inputValue('#model'));

  // The rest starts from Opus 5 and switches away and back, so pick it first.
  await ui.selectOption('#model', 'claude-opus-5');
  await ui.waitForTimeout(300);
  await sendFromUi('hello');
  let p = await lastParams();
  check('Opus 5: adaptive thinking + fallbacks + new web search', p.model === 'claude-opus-5' && p.thinking.type === 'adaptive' && p.fallbacks === 'default' && p.betas.includes('server-side-fallback-2026-07-01') && p.tools.some((t) => t.type === 'web_search_20260209'), JSON.stringify({ ...p, messages: undefined }).slice(0, 300));

  // Switching mid-chat starts a new chat.
  await ui.selectOption('#model', 'claude-haiku-4-5');
  await ui.waitForTimeout(400);
  check('switching model keeps the chat', (await ui.locator('.msg.user').count()) === 1 && (await ui.locator('.notice').last().innerText()).includes('Haiku 4.5'), await ui.locator('.msg.user').count());
  await sendFromUi('hi haiku');
  p = await lastParams();
  const haikuHistory = JSON.stringify(p.messages);
  check('new model sees the earlier messages', haikuHistory.includes('hello') && haikuHistory.includes('reply from claude-opus-5'), haikuHistory.slice(0, 300));
  check("previous model's thinking is not sent to the new model", !haikuHistory.includes('secret-claude-opus-5'), haikuHistory.slice(0, 300));
  check('Haiku 4.5: budget thinking, basic web search, no fallbacks/effort', p.model === 'claude-haiku-4-5' && p.thinking.type === 'enabled' && p.thinking.budget_tokens < p.max_tokens && !('fallbacks' in p) && !('output_config' in p) && p.tools.some((t) => t.type === 'web_search_20250305') && !p.betas.includes('server-side-fallback-2026-07-01'), JSON.stringify({ ...p, messages: undefined }).slice(0, 300));

  // The chat stays on its model even if the stored setting changes behind it.
  await ui.selectOption('#model', 'claude-opus-5');
  await ui.waitForTimeout(300);
  await sendFromUi('back to opus');
  p = await lastParams();
  const backHistory = JSON.stringify(p.messages);
  check('switching back: Opus 5 gets its own thinking back, not Haiku thinking', p.model === 'claude-opus-5' && backHistory.includes('secret-claude-opus-5') && !backHistory.includes('secret-claude-haiku-4-5') && backHistory.includes('reply from claude-haiku-4-5'), backHistory.slice(0, 400));
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

  await ui.selectOption('#model', 'claude-sonnet-5');
  await ui.waitForTimeout(300);
  await sendFromUi('sonnet');
  p = await lastParams();
  check('Sonnet 5: adaptive, no fallbacks', p.model === 'claude-sonnet-5' && p.thinking.type === 'adaptive' && !('fallbacks' in p), JSON.stringify({ ...p, messages: undefined }).slice(0, 300));

  await ui.selectOption('#model', 'claude-fable-5-1');
  await ui.waitForTimeout(300);
  await sendFromUi('fable');
  p = await lastParams();
  check('Fable 5.1: adaptive + fallbacks, no forced tool_choice', p.model === 'claude-fable-5-1' && p.thinking.type === 'adaptive' && p.fallbacks === 'default' && !('tool_choice' in p), JSON.stringify({ ...p, messages: undefined }).slice(0, 300));

  // The choice persists.
  check('choice is saved', (await ui.evaluate(() => window.assistant.getSettings())).model === 'claude-fable-5-1', 'not saved');

  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
