// OpenAI / Grok / Gemini / OpenRouter: key entry, model list, a full agent turn against a local fake
// OpenAI-compatible server (streamed text + a streamed tool call), and switching back to Claude.
const { _electron: electron } = require('playwright-core');
const { openSettingsTab } = require('./settings-tab');
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

  // A (fake) Claude key too: the chat switches back to Claude partway through.
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await app.evaluate((_e, url) => { global.__providers.PROVIDERS.openai.baseURL = url; }, base);
  await app.evaluate(() => global.__agent.execute('navigate', { url: 'https://example.com' }));

  // Settings: a row per provider; saving a key loads its models into the picker.
  const inSettings = await openSettingsTab(app);
  const rows = await inSettings("[...document.querySelectorAll('#ai-keys .item.key')].map((e) => e.dataset.provider)");
  check('settings list a key row per provider', ['anthropic', 'openai', 'xai', 'gemini'].every((p) => rows.includes(p)), JSON.stringify(rows));
  await inSettings("document.querySelector('[data-provider=openai] button').click()");
  await inSettings("{ const i = document.querySelector('[data-provider=openai] input'); i.value = 'sk-test-123'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }");
  await ui.waitForTimeout(1500);
  check('the key row shows Saved', (await inSettings("document.querySelector('[data-provider=openai] .key-state')?.textContent")) === 'Saved', await inSettings("document.querySelector('[data-provider=openai]').textContent"));
  await app.evaluate((_e, sid) => global.__agent.browser.closeTab(sid), inSettings.id);
  await ui.evaluate(() => { document.getElementById('toggle-sidebar').click(); });
  await ui.waitForTimeout(600);
  const groups = await ui.$$eval('#model optgroup', (gs) => gs.map((g) => `${g.label}:${[...g.children].map((o) => o.value).join('|')}`));
  check('OpenAI models appear in the picker (from the key)', groups.some((g) => g === 'OpenAI:openai:gpt-5.6|openai:gpt-5.6-mini'), JSON.stringify(groups));
  check('non-chat models are filtered out', !groups.join().includes('embedding'), JSON.stringify(groups));
  const saved = await ui.evaluate(async () => (await window.assistant.getSettings()).providerKeys.openai.stored);
  check('key is stored (encrypted)', saved === true, saved);

  // A full turn on OpenAI: streamed text, a streamed tool call that really runs, the final reply.
  await ui.selectOption('#model', 'openai:gpt-5.6');
  await ui.waitForTimeout(300);
  check('composer names the selected model', (await ui.getAttribute('#prompt', 'placeholder')) === 'Ask GPT-5.6…', await ui.getAttribute('#prompt', 'placeholder'));
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

  // ---- OpenRouter: a local stand-in for openrouter.ai/api/v1 (models list, streaming, a tool call,
  // a chat-only model, and "no credits").
  const orRequests = [];
  const orServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.endsWith('/models')) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ data: [
          { id: 'anthropic/claude-test-9', name: 'Anthropic: Claude Test 9', created: 200, supported_parameters: ['tools', 'temperature'], architecture: { output_modalities: ['text'] } },
          { id: 'acme/chat-1', name: 'Acme Chat 1', created: 150, supported_parameters: ['temperature'], architecture: { output_modalities: ['text'] } },
          { id: 'anthropic/claude-test-9:free', name: 'variant', created: 201, supported_parameters: ['tools'] },
          { id: 'acme/broke', name: 'Acme Broke', created: 100, supported_parameters: ['tools'] },
        ] }));
      }
      if (req.headers.authorization !== 'Bearer sk-or-test') { res.statusCode = 401; return res.end(JSON.stringify({ error: { message: 'bad key' } })); }
      if (req.url.endsWith('/key')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: { label: 'test' } })); } // the key check before saving
      const parsed = JSON.parse(body);
      orRequests.push({ body: parsed, referer: req.headers['http-referer'], title: req.headers['x-title'] });
      if (parsed.model === 'acme/broke') { res.statusCode = 402; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ error: { message: 'Insufficient credits', code: 402 } })); }
      res.setHeader('Content-Type', 'text/event-stream');
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const chunk = (delta, finish = null) => send({ id: 'o1', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }] });
      if (parsed.tools && !parsed.messages.some((m) => m.role === 'tool')) {
        chunk({ role: 'assistant', content: 'Checking. ' });
        chunk({ tool_calls: [{ index: 0, id: 'call_or1', type: 'function', function: { name: 'read_page', arguments: '{}' } }] });
        chunk({}, 'tool_calls');
      } else {
        chunk({ role: 'assistant', content: parsed.tools ? 'Done via OpenRouter.' : 'Chat-only answer.' });
        chunk({}, 'stop');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  }).listen(0);
  await app.evaluate((_e, url) => { global.__providers.PROVIDERS.openrouter.baseURL = url; global.__providers.resetCatalog(); }, `http://127.0.0.1:${orServer.address().port}/api/v1`);
  const parsedList = await app.evaluate(() => global.__providers.parseOpenRouterModels({ data: [{ id: 'a/b', supported_parameters: ['tools'] }, { id: 'a/b:free' }, { id: 'c/d' }] }));
  check('openrouter: models list parse (tools flag, :free variants kept and flagged)', JSON.stringify(parsedList.map((m) => [m.id, m.tools, m.free])) === '[["a/b",true,false],["a/b:free",false,true],["c/d",false,false]]', JSON.stringify(parsedList));
  await app.evaluate(() => global.__agent.reset());
  await ui.evaluate(() => document.getElementById('new-chat').click());
  const badKey = await ui.evaluate(() => window.assistant.setProviderKey('openrouter', 'sk-or-nope').then(() => 'saved', (e) => e.message));
  check('a rejected key is refused when saving, not on the first message', /didn't accept that key/.test(badKey), badKey);
  await ui.evaluate(async () => window.assistant.setProviderKey('openrouter', 'sk-or-test'));
  await ui.waitForTimeout(800);
  const orOptions = await ui.$$eval('#model optgroup[label="OpenRouter"] option', (os) => os.map((o) => [o.value, o.textContent]));
  check('openrouter: picker has the curated model and "More models…"', orOptions.some(([v]) => v === 'openrouter:anthropic/claude-test-9') && orOptions.some(([v]) => v === 'openrouter:__more'), JSON.stringify(orOptions));
  const allModels = await ui.evaluate(() => window.assistant.openRouterModels());
  check('openrouter: "More models…" lists every model, chat-only flagged', allModels.some((m) => m.id === 'acme/chat-1' && !m.tools) && allModels.some((m) => m.id === 'anthropic/claude-test-9' && m.tools), JSON.stringify(allModels));
  // Streaming + a tool call that really runs.
  await ui.selectOption('#model', 'openrouter:anthropic/claude-test-9');
  await ui.waitForTimeout(300);
  await ui.fill('#prompt', 'What is here?');
  await ui.press('#prompt', 'Enter');
  await ui.waitForFunction(() => !document.getElementById('send').classList.contains('stop'), null, { timeout: 15000 }).catch(() => {});
  const orReply = await ui.locator('.msg.assistant').last().innerText().catch(() => '');
  check('openrouter: streamed reply after a tool call', /Done via OpenRouter/.test(orReply) && orRequests.length === 2 && orRequests[1].body.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_or1'), `${orReply} ${orRequests.length}`);
  check('openrouter: attribution headers sent', orRequests[0]?.referer?.includes('lumen') && orRequests[0]?.title === 'Lumen', JSON.stringify(orRequests[0] && { r: orRequests[0].referer, t: orRequests[0].title }));
  // A chat-only model: no tools offered, and the user is told why it can't act.
  await ui.evaluate(async () => window.assistant.setModel('openrouter:acme/chat-1'));
  await app.evaluate(() => global.__agent.setModel('openrouter:acme/chat-1'));
  const events = await app.evaluate(() => new Promise((resolve) => { const seen = []; global.__agent.run('click the button', (e) => { seen.push(e); if (e.type === 'done') resolve(seen); }); }));
  const last = orRequests[orRequests.length - 1];
  check('openrouter: chat-only model gets no tools', last.body.model === 'acme/chat-1' && !last.body.tools, JSON.stringify(last.body).slice(0, 200));
  check('openrouter: chat-only model says it cannot act', events.some((e) => e.type === 'notice' && /chat only/.test(e.text)), JSON.stringify(events.filter((e) => e.type === 'notice')));
  // 402: no credits.
  await app.evaluate(() => global.__agent.setModel('openrouter:acme/broke'));
  const failed = await app.evaluate(() => new Promise((resolve) => { const seen = []; global.__agent.run('hi', (e) => { seen.push(e); if (e.type === 'done') resolve(seen); }); }));
  const errText = failed.find((e) => e.type === 'error')?.text || '';
  check('openrouter: 402 explains the credits', /credits have run out/.test(errText), errText);
  orServer.close();

  check('no UI errors', errors.length === 0, errors.join('; '));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  await app.close();
  server.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
