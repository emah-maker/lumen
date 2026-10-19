// Local AI (Ollama / LM Studio): address rules, Detect, a streamed chat turn through the OpenAI-compatible endpoint, tool
// support and the plain-chat fallback, and the rules that keep a local chat on this computer. Plain Node: the "servers" are
// node http servers on 127.0.0.1 (no real network, no Electron).
const http = require('http');
const lm = require('../src/ai/local-models');
const providers = require('../src/ai/providers');
const fallback = require('../src/ai/fallback');
const autoModel = require('../src/ai/auto-model');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };

// ---- fake servers ----
const seen = [];
const sse = (res, chunks) => {
  res.setHeader('Content-Type', 'text/event-stream');
  for (const c of chunks) res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: c.delta || {}, finish_reason: c.finish || null }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};
const json = (res, obj, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { let parsed = null; try { parsed = body ? JSON.parse(body) : null; } catch {} seen.push({ method: req.method, url: req.url, body: parsed, auth: req.headers.authorization }); handler(req, res, parsed); });
    }).listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
// Chat handler shared by both: "toolless" refuses tools the way Ollama does; "chatty" answers in text; otherwise a tool call, then text.
const chat = (req, res, body) => {
  if (body.model === 'missing') return json(res, { error: { message: 'model "missing" not found, try pulling it first' } }, 404);
  if (body.model === 'toolless' && body.tools) return json(res, { error: { message: 'registry.ollama.ai/library/toolless:latest does not support tools', type: 'api_error' } }, 400);
  if (body.tools && !body.messages.some((m) => m.role === 'tool') && body.model !== 'chatty') {
    return sse(res, [
      { delta: { role: 'assistant', content: 'Looking. ' } },
      { delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_page', arguments: '' } }] } },
      { delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } },
      { finish: 'tool_calls' },
    ]);
  }
  return sse(res, [{ delta: { role: 'assistant', content: 'Hello ' } }, { delta: { content: 'from local.' } }, { finish: 'stop' }]);
};

(async () => {
  const ollama = await serve((req, res, body) => {
    if (req.url === '/api/tags') return json(res, { models: [{ name: 'llama3.2:latest', model: 'llama3.2:latest' }, { name: 'toolless:latest', model: 'toolless:latest' }, { name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest' }, { name: 'chatty', model: 'chatty' }] });
    if (req.url === '/api/show') {
      const caps = { 'llama3.2:latest': ['completion', 'tools'], 'toolless:latest': ['completion'], 'nomic-embed-text:latest': ['embedding'] }[body.model];
      return caps ? json(res, { capabilities: caps }) : json(res, {}); // "chatty": an old server that doesn't say
    }
    if (req.url === '/v1/chat/completions') return chat(req, res, body);
    json(res, { error: 'not found' }, 404);
  });
  const lmstudio = await serve((req, res, body) => {
    if (req.url === '/v1/models') return json(res, { data: [{ id: 'qwen2.5-7b-instruct' }, { id: 'text-embedding-nomic' }, { id: 'old-model' }] });
    if (req.url === '/api/v0/models') return json(res, { data: [{ id: 'qwen2.5-7b-instruct', type: 'llm', capabilities: ['tool_use'] }, { id: 'text-embedding-nomic', type: 'embeddings' }, { id: 'old-model', type: 'llm', capabilities: [] }] });
    if (req.url === '/v1/chat/completions') return chat(req, res, body);
    json(res, {}, 404);
  });
  const ollamaUrl = `http://127.0.0.1:${ollama.port}`;
  const lmUrl = `http://127.0.0.1:${lmstudio.port}/v1`;

  // ---- addresses ----
  check('Ollama and LM Studio default addresses', lm.DEFAULT_URLS.ollama === 'http://127.0.0.1:11434' && lm.DEFAULT_URLS.lmstudio === 'http://127.0.0.1:1234/v1');
  check('an empty address is the default for the server', lm.normalizeUrl('ollama', '').url === 'http://127.0.0.1:11434' && lm.normalizeUrl('lmstudio', '  ').url === 'http://127.0.0.1:1234/v1');
  check('Ollama keeps its root (a /v1 or trailing slash is dropped); LM Studio gets /v1', lm.normalizeUrl('ollama', 'http://127.0.0.1:11434/v1/').url === 'http://127.0.0.1:11434' && lm.normalizeUrl('lmstudio', 'localhost:1234').url === 'http://localhost:1234/v1');
  check('localhost, 127.0.0.1 and ::1 are local', ['http://localhost:1', 'http://127.0.0.1:1', 'http://[::1]:1', 'http://ollama.localhost:1'].every((u) => lm.normalizeUrl('ollama', u).local === true));
  check('another host is not local', lm.normalizeUrl('ollama', 'http://192.168.1.20:11434').local === false && lm.normalizeUrl('ollama', 'http://localhost.evil.com:11434').local === false && lm.normalizeUrl('ollama', 'http://127.0.0.1.evil.com').local === false);
  check('bad addresses are refused in plain words', !lm.normalizeUrl('ollama', 'ftp://x').ok && !lm.normalizeUrl('ollama', 'http://user:pw@127.0.0.1').ok && !lm.normalizeUrl('ollama', 'http://').ok, JSON.stringify(lm.normalizeUrl('ollama', 'ftp://x')));
  const remote = { flavor: 'ollama', url: 'http://192.168.1.20:11434' };
  check('a non-local address is not allowed until its host is confirmed', lm.allowed({ flavor: 'ollama', url: 'http://127.0.0.1:11434' }) && !lm.allowed(remote) && !lm.allowed({ ...remote, confirmedHost: '192.168.1.99:11434' }) && lm.allowed({ ...remote, confirmedHost: '192.168.1.20:11434' }));
  check('clean() keeps only valid models and a valid server', JSON.stringify(lm.clean({ enabled: 1, flavor: 'x', models: ['a', { id: 'b', tools: true }, { id: '' }, 5] })) === JSON.stringify({ enabled: false, flavor: 'ollama', url: 'http://127.0.0.1:11434', confirmedHost: '', models: [{ id: 'a', tools: null }, { id: 'b', tools: true }] }), JSON.stringify(lm.clean({ enabled: 1, flavor: 'x', models: ['a'] })));
  check('base URLs end in /v1 for both servers', lm.baseURL({ flavor: 'ollama', url: ollamaUrl }) === `${ollamaUrl}/v1` && lm.baseURL({ flavor: 'lmstudio', url: lmUrl }) === lmUrl);

  // ---- Detect ----
  const found = await lm.detect({ flavor: 'ollama', url: ollamaUrl });
  check('Ollama Detect lists chat models with what each can do, and skips embedding models', found.ok && JSON.stringify(found.models) === JSON.stringify([{ id: 'llama3.2:latest', tools: true }, { id: 'toolless:latest', tools: false }, { id: 'chatty', tools: null }]), JSON.stringify(found));
  check('Ollama Detect asked /api/tags (not a remote host) and sent no key', seen.some((r) => r.url === '/api/tags') && seen.every((r) => !r.auth));
  const foundLm = await lm.detect({ flavor: 'lmstudio', url: lmUrl });
  check('LM Studio Detect lists models from /v1/models with tool support from /api/v0/models, without embedders', foundLm.ok && JSON.stringify(foundLm.models) === JSON.stringify([{ id: 'qwen2.5-7b-instruct', tools: true }, { id: 'old-model', tools: false }]), JSON.stringify(foundLm));
  const closed = await serve(() => {});
  const deadPort = closed.port;
  await new Promise((r) => closed.server.close(r));
  const dead = await lm.detect({ flavor: 'ollama', url: `http://127.0.0.1:${deadPort}` });
  check('Detect with nothing listening says so plainly', dead.ok === false && /Couldn’t reach Ollama/.test(dead.error), JSON.stringify(dead));
  const deadLm = await lm.detect({ flavor: 'lmstudio', url: `http://127.0.0.1:${deadPort}/v1` });
  check('LM Studio\'s message mentions its local server', deadLm.ok === false && /LM Studio/.test(deadLm.error) && /local server/.test(deadLm.error), JSON.stringify(deadLm));
  const before = seen.length;
  const refused = await lm.detect({ ...remote, fetchImpl: undefined });
  check('Detect refuses an unconfirmed remote address without any request', refused.ok === false && seen.length === before, JSON.stringify(refused));
  const empty = await serve((req, res) => json(res, req.url === '/api/tags' ? { models: [] } : {}));
  const none = await lm.detect({ flavor: 'ollama', url: `http://127.0.0.1:${empty.port}` });
  check('a server with no models says what to do', none.ok && none.models.length === 0 && /ollama pull/.test(none.note), JSON.stringify(none));
  empty.server.close();

  // ---- the provider ----
  let cfg = { enabled: true, flavor: 'ollama', url: ollamaUrl, confirmedHost: '', models: found.models };
  const marked = [];
  providers.setLocalSource({ get: () => cfg, chatOnly: (m) => marked.push(m) });
  check('Local is a provider with no default models and no key', providers.PROVIDERS.local && providers.PROVIDERS.local.label === 'Local' && providers.PROVIDERS.local.defaults.length === 0);
  check('the provider id splits like the others', JSON.stringify(providers.splitModel('local:llama3.2:latest')) === JSON.stringify({ provider: 'local', model: 'llama3.2:latest' }));
  check('listModels is the last Detect (no request)', JSON.stringify(await providers.listModels('local', 'local')) === JSON.stringify(['llama3.2:latest', 'toolless:latest', 'chatty']));
  check('tool support follows what Detect saw (unknown counts as able)', providers.canUseTools('local', 'llama3.2:latest') && !providers.canUseTools('local', 'toolless:latest') && providers.canUseTools('local', 'chatty') && providers.canUseTools('local', 'never-seen'));

  const events = [];
  const tools = [{ name: 'read_page', description: 'Read the page', input_schema: { type: 'object', properties: {} } }];
  const turn = await providers.streamTurn({ provider: 'local', model: 'llama3.2:latest', apiKey: 'local', system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools, emit: (e) => events.push(e) });
  check('a streamed tool call comes back as a tool_use turn', turn.stop_reason === 'tool_use' && turn.content.some((b) => b.type === 'tool_use' && b.id === 'call_1' && b.name === 'read_page') && turn.model === 'local:llama3.2:latest', JSON.stringify(turn));
  const sent = seen.filter((r) => r.url === '/v1/chat/completions').pop();
  check('the request goes to the local /v1/chat/completions, streamed, with the tool, and no key', sent.body.stream === true && sent.body.tools[0].function.name === 'read_page' && sent.body.model === 'llama3.2:latest' && (!sent.auth || /^Bearer local$/.test(sent.auth)), JSON.stringify(sent).slice(0, 300));
  events.length = 0;
  const chatTurn = await providers.streamTurn({ provider: 'local', model: 'chatty', apiKey: 'local', system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools, emit: (e) => events.push(e) });
  check('streamed text arrives piece by piece', chatTurn.stop_reason === 'end_turn' && chatTurn.content[0].text === 'Hello from local.' && events.filter((e) => e.type === 'text').map((e) => e.text).join('') === 'Hello from local.', JSON.stringify(chatTurn));

  // A server that refuses tools: the turn is answered as plain chat, the model is marked, and the user is told.
  events.length = 0;
  const plain = await providers.streamTurn({ provider: 'local', model: 'toolless', apiKey: 'local', system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools, emit: (e) => events.push(e) });
  const attempts = seen.filter((r) => r.url === '/v1/chat/completions' && r.body.model === 'toolless');
  check('a refused tool request is retried as plain chat', plain.content[0]?.text === 'Hello from local.' && attempts.length === 2 && Boolean(attempts[0].body.tools) && !attempts[1].body.tools, JSON.stringify(attempts.map((a) => Boolean(a.body.tools))));
  check('the model is marked chat only and the chat says so', marked.join() === 'toolless' && events.some((e) => e.type === 'notice' && /plain chat/.test(e.text) && /tool/.test(e.text)), JSON.stringify([marked, events.filter((e) => e.type === 'notice')]));
  check('isNoToolsError matches the servers\' wording and not other errors', lm.isNoToolsError({ status: 400, message: '400 registry.ollama.ai/library/x does not support tools' }) && lm.isNoToolsError({ status: 400, message: 'Model does not support tool use' }) && !lm.isNoToolsError({ status: 400, message: 'context length exceeded' }) && !lm.isNoToolsError({ status: 401, message: 'tools not supported' }));
  const mark0 = marked.length;
  const before404 = seen.filter((r) => r.url === '/v1/chat/completions').length;
  let missingErr = null;
  try { await providers.streamTurn({ provider: 'local', model: 'missing', apiKey: 'local', system: 's', messages: [{ role: 'user', content: 'x' }], tools, emit: () => {} }); } catch (e) { missingErr = e; }
  check('a missing model is one request, not retried, and explained', missingErr && missingErr.status === 404 && seen.filter((r) => r.url === '/v1/chat/completions').length === before404 + 1 && marked.length === mark0 && /Detect/.test(providers.describeProviderError(missingErr, 'local').text), missingErr && missingErr.message);

  // LM Studio answers through the same code.
  cfg = { enabled: true, flavor: 'lmstudio', url: lmUrl, confirmedHost: '', models: foundLm.models };
  const viaLm = await providers.streamTurn({ provider: 'local', model: 'qwen2.5-7b-instruct', apiKey: 'local', system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools, emit: () => {} });
  check('LM Studio chat goes to its /v1/chat/completions', viaLm.stop_reason === 'tool_use' && seen.some((r) => r.url === '/v1/chat/completions' && r.body.model === 'qwen2.5-7b-instruct'));

  // JSON jobs (tab grouping and the like): no response_format (LM Studio refuses json_object); a fenced reply still parses.
  const jsonServer = await serve((req, res, body) => json(res, { choices: [{ message: { role: 'assistant', content: `Here you go:\n\`\`\`json\n{"groups":[1]}\n\`\`\`` } }], _asked: body.response_format || null }));
  cfg = { enabled: true, flavor: 'lmstudio', url: `http://127.0.0.1:${jsonServer.port}/v1`, confirmedHost: '', models: [] };
  const parsed = await providers.completeJSON({ provider: 'local', model: 'm', apiKey: 'local', system: 'Group tabs.', user: '[]' });
  const jsonReq = seen.filter((r) => r.url === '/v1/chat/completions').pop().body;
  check('completeJSON on a local model sends no response_format and reads a fenced JSON reply', JSON.stringify(parsed) === '{"groups":[1]}' && !('response_format' in jsonReq) && /JSON object/.test(jsonReq.messages[0].content), JSON.stringify([parsed, jsonReq]).slice(0, 300));
  jsonServer.server.close();

  // ---- it stays on this computer ----
  cfg = { enabled: true, flavor: 'ollama', url: 'http://192.0.2.7:11434', confirmedHost: '', models: [] };
  const before2 = seen.length;
  let refusedErr = null;
  try { await providers.streamTurn({ provider: 'local', model: 'x', apiKey: 'local', system: 's', messages: [{ role: 'user', content: 'x' }], tools: [], emit: () => {} }); } catch (e) { refusedErr = e; }
  check('a chat to an unconfirmed remote address is refused before any request', refusedErr && /isn’t on this computer/.test(refusedErr.message) && seen.length === before2, refusedErr && refusedErr.message);
  check('the error for a stopped server explains itself', await (async () => {
    cfg = { enabled: true, flavor: 'ollama', url: `http://127.0.0.1:${deadPort}`, confirmedHost: '', models: [] };
    try { await providers.streamTurn({ provider: 'local', model: 'x', apiKey: 'local', system: 's', messages: [{ role: 'user', content: 'x' }], tools: [], emit: () => {} }); } catch (e) { const d = providers.describeProviderError(e, 'local'); return Boolean(d) && /Start Ollama or LM Studio/.test(d.text) && !/internet/i.test(d.text); }
    return false;
  })());

  const options = [{ id: 'local:llama3.2:latest', name: 'llama3.2' }, { id: 'openai:gpt-5.6', name: 'GPT' }, { id: 'xai:grok-4', name: 'Grok' }];
  check('a failing local model has no stand-in (never handed to a cloud model)', fallback.pick({ current: 'local:llama3.2:latest', options, cooldowns: fallback.shared }) === null && fallback.order({ current: 'local:llama3.2:latest', options }).length === 0);
  check('a local model is never offered as another model\'s stand-in', !fallback.order({ current: 'openai:gpt-5.6', options }).includes('local:llama3.2:latest'));
  const route = autoModel.candidatesOf(options, { chars: 100, vision: false, tools: false }, {});
  check('Auto never picks a local model', route.length > 0 && !route.some((o) => o.id.startsWith('local:')), JSON.stringify(route.map((o) => o.id)));

  for (const s of [ollama, lmstudio]) s.server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
