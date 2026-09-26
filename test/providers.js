// OpenAI / Grok / Gemini: key entry, model list, a full agent turn against a local fake
// OpenAI-compatible server (streamed text + a streamed tool call), and switching back to Claude.
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

  // Fake OpenAI-compatible API: /models and streaming /chat/completions.
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.endsWith('/models')) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.6', object: 'model' }, { id: 'gpt-5.6-mini', object: 'model' }, { id: 'text-embedding-3', object: 'model' }] }));
      }
      if (req.headers.authorization !== 'Bearer sk-test-123') { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: 'bad key' } })); }
      const parsed = JSON.parse(body);
      requests.push(parsed);
      res.setHeader('Content-Type', 'text/event-stream');
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const chunk = (delta, finish = null) => send({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }] });
      const hasToolResult = parsed.messages.some((m) => m.role === 'tool');
      if (!hasToolResult) {
        chunk({ role: 'assistant', content: 'Let me look. ' });
        chunk({ tool_calls: [{ index: 0, id: 'call_abc123', type: 'function', function: { name: 'read_page', arguments: '' } }] });
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] });
        chunk({}, 'tool_calls');
      } else {
        chunk({ role: 'assistant', content: 'The page is **Example Domain**.' });
        chunk({}, 'stop');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}/v1`;

  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await app.evaluate((_e, url) => { global.__providers.PROVIDERS.openai.baseURL = url; }, base);
  await app.evaluate(() => global.__agent.execute('navigate', { url: 'https://example.com' }));

  // Settings: a row per provider; saving a key loads its models into the picker.
  await ui.evaluate(() => { document.getElementById('toggle-sidebar').click(); });
  await ui.waitForTimeout(600);
  await ui.evaluate(() => { document.getElementById('open-settings').click(); document.querySelectorAll('.settings-section').forEach((d) => { d.open = true; }); });
  await ui.waitForTimeout(300);
  const rows = await ui.$$eval('.provider-row .provider-name', (els) => els.map((e) => e.textContent));
  check('settings list OpenAI, Grok and Gemini', JSON.stringify(rows) === '["OpenAI","Grok","Gemini"]', JSON.stringify(rows));
  await ui.fill('#key-openai', 'sk-test-123');
  await ui.press('#key-openai', 'Enter');
  await ui.waitForTimeout(1200);
  const groups = await ui.$$eval('#model optgroup', (gs) => gs.map((g) => `${g.label}:${[...g.children].map((o) => o.value).join('|')}`));
  check('OpenAI models appear in the picker (from the key)', groups.some((g) => g === 'OpenAI:openai:gpt-5.6-mini|openai:gpt-5.6'), JSON.stringify(groups));
  check('non-chat models are filtered out', !groups.join().includes('embedding'), JSON.stringify(groups));
  const saved = await ui.evaluate(async () => (await window.assistant.getSettings()).providerKeys.openai.stored);
  check('key is stored (encrypted)', saved === true, saved);

  // A full turn on OpenAI: streamed text, a streamed tool call that really runs, the final reply.
  await ui.selectOption('#model', 'openai:gpt-5.6');
  await ui.waitForTimeout(300);
  check('composer names the selected model', (await ui.getAttribute('#prompt', 'placeholder')) === 'Ask gpt-5.6…', await ui.getAttribute('#prompt', 'placeholder'));
  await ui.evaluate(() => document.getElementById('settings').hidden = true);
  await ui.fill('#prompt', 'What is this page?');
  await ui.press('#prompt', 'Enter');
  await ui.waitForFunction(() => !document.getElementById('send').classList.contains('stop'), null, { timeout: 15000 }).catch(() => {});
  const reply = await ui.evaluate(() => [...document.querySelectorAll('.msg.assistant')].map((e) => e.innerHTML).join(' | '));
  check('reply streams into the sidebar', reply.includes('<strong>Example Domain</strong>'), reply);
  check('tool step shown', (await ui.locator('.step').count()) >= 1, await ui.locator('.step').count());
  const second = requests[1];
  const tool = second?.messages.find((m) => m.role === 'tool');
  check('tool result sent back as a tool message', tool?.tool_call_id === 'call_abc123' && tool.content.includes('Example Domain'), JSON.stringify(tool).slice(0, 200));
  check('system prompt is not Claude-branded for other models', second?.messages[0].role === 'system' && !second.messages[0].content.startsWith('You are Claude'), second?.messages[0].content.slice(0, 80));
  check('tools sent as functions, including a client-side web_search', second?.tools.every((t) => t.type === 'function') && second.tools.some((t) => t.function.name === 'web_search' && t.function.parameters.required?.includes('query')), JSON.stringify(second?.tools.map((t) => t.function?.name)));

  // Switch back to Claude mid-chat: the OpenAI turns arrive in Claude's format.
  await app.evaluate(() => {
    global.__claudeParams = null;
    global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
      global.__claudeParams = JSON.parse(JSON.stringify(params.messages));
      const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Claude here.' }] };
      return { async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Claude here.' } }; }, finalMessage: async () => message };
    } } } });
  });
  await ui.selectOption('#model', 'claude-opus-5');
  await ui.waitForTimeout(300);
  await ui.fill('#prompt', 'and you?');
  await ui.press('#prompt', 'Enter');
  await ui.waitForFunction(() => !document.getElementById('send').classList.contains('stop'), null, { timeout: 10000 }).catch(() => {});
  const claudeHistory = await app.evaluate(() => global.__claudeParams);
  const roles = (claudeHistory || []).map((m) => m.role).join(',');
  const toolUse = (claudeHistory || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === 'tool_use');
  check('Claude sees the OpenAI turns (text + tool call) in its own format', roles === 'user,assistant,user,assistant,user' && toolUse?.id === 'call_abc123', `${roles} ${JSON.stringify(toolUse)}`);

  // Bad key: a clear error with the settings action.
  await app.evaluate(() => { global.__agent.reset(); });
  await ui.evaluate(() => document.getElementById('new-chat').click());
  await ui.evaluate(async () => window.assistant.setProviderKey('openai', 'sk-wrong'));
  await ui.waitForTimeout(800);
  await ui.selectOption('#model', 'openai:gpt-5.6');
  await ui.fill('#prompt', 'hi');
  await ui.press('#prompt', 'Enter');
  await ui.waitForSelector('.error', { timeout: 10000 }).catch(() => {});
  const err = await ui.locator('.error').last().innerText().catch(() => '');
  check('rejected key explains itself', /OpenAI API key was rejected/.test(err), err);

  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
