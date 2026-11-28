// AI speed, plain Node (no Electron, no network): LUMEN_TURN_TIMING's per-request and per-task lines (ai/turn-timing.js), the
// Chat Completions stream reporting to them (providers.js), the provider prompt-cache hints (OpenAI prompt_cache_key, xAI
// x-grok-conv-id, a cache_control mark for Claude through OpenRouter), the composer's API preconnect (ai/api-preconnect.js) and
// the size and cache-mark budget of the Claude request.
const turnTiming = require('../../src/ai/turn-timing');
const providers = require('../../src/ai/providers');
const { createPreconnect, originFor, AGAIN_MS } = require('../../src/ai/api-preconnect');
const { requestFor, DEFAULT_MODEL } = require('../../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

(async () => {
  // 1) Off by default: nothing is made or measured.
  delete process.env.LUMEN_TURN_TIMING;
  check('turn timing: off without LUMEN_TURN_TIMING=1', turnTiming.taskTimer('x') === null && turnTiming.requestOf(null, 'a', 'b') === turnTiming.NOOP_REQUEST);

  // 2) An API task: two model requests with a tool between them, on a fake clock.
  process.env.LUMEN_TURN_TIMING = '1';
  {
    let t = 1000;
    const lines = [];
    const timer = turnTiming.taskTimer('anthropic:claude-opus-5-5', { now: () => t, log: (l) => lines.push(l) });
    t += 40; // reading the page before the first request
    let r = timer.request('anthropic', 'claude-opus-5-5', { chars: 24900 });
    t += 400; r.mark('byte'); t += 200; r.mark('token'); t += 1200; r.mark('tool'); r.mark('tool'); t += 60;
    r.done({ input_tokens: 800, cache_read_input_tokens: 5100, cache_creation_input_tokens: 200, output_tokens: 90 });
    timer.event({ type: 'tool', id: 'a' }); t += 240; timer.event({ type: 'tool_done', id: 'a', ms: 238 });
    t += 5;
    r = timer.request('anthropic', 'claude-opus-5-5');
    t += 300; r.mark('byte'); t += 100; r.mark('token'); t += 500;
    r.done({ input_tokens: 300, cache_read_input_tokens: 6000, cache_creation_input_tokens: 0, output_tokens: 40 });
    const s = timer.finish();
    check('turn timing: one line per request with prep, first byte, first token, tool call and end', /^\[lumen\] turn anthropic claude-opus-5-5 #1: prep 40 ms · first byte 400 ms · first token 600 ms · tool call 1800 ms · end 1860 ms · in 800 \(cache read 5100, write 200\) out 90 · 24\.9k chars$/.test(lines[0]), lines[0]);
    check('turn timing: prep counts from the last tool\'s end', /#2: prep 5 ms · first byte 300 ms · first token 400 ms · end 900 ms/.test(lines[1]), lines[1]);
    check('turn timing: the task line sums model time, tools, Lumen\'s own time and tokens', /^\[lumen\] task anthropic:claude-opus-5-5: 2 model calls 2\.8 s \(first byte avg 350 ms\) · tools 238 ms · Lumen 45 ms · total 3\.0 s · in 1\.1k \(cached 11\.1k\) out 130$/.test(lines[2]), lines[2]);
    check('turn timing: stats', s.requests === 2 && s.toolMs === 238 && s.cacheRead === 11100 && s.total === 3045, JSON.stringify(s));
  }

  // 3) A CLI engine: rounds are read from the chat's events (no requests of its own).
  {
    let t = 0;
    const lines = [];
    const timer = turnTiming.taskTimer('claudecode:sonnet', { now: () => t, log: (l) => lines.push(l) });
    t += 1300; timer.event({ type: 'text', text: 'Opening' }); timer.event({ type: 'tool', id: 'a' }); timer.event({ type: 'tool', id: 'b' });
    t += 100; timer.event({ type: 'tool_done', id: 'a', ms: 90 }); t += 150; timer.event({ type: 'tool_done', id: 'b', ms: 140 });
    t += 900; timer.event({ type: 'text', text: 'Done.' });
    timer.finish();
    check('turn timing (CLI): a round is the model\'s time to its tool calls, then their time', lines[0] === '[lumen] turn claudecode round 1: model 1300 ms · tools 230 ms', lines[0]);
    check('turn timing (CLI): the closing answer is a round too, and the task line counts rounds', lines[1] === '[lumen] turn claudecode round 2: model 900 ms · tools 0 ms' && /^\[lumen\] task claudecode:sonnet: 2 model rounds 2\.2 s · tools 230 ms · total 2\.5 s$/.test(lines[2]), lines.join(' | '));
  }

  // 4) Token counts from either API shape.
  check('tokensOf: Chat Completions counts, cached part apart', JSON.stringify(turnTiming.tokensOf({ prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 700 } })) === JSON.stringify({ input: 300, cacheRead: 700, cacheWrite: 0, output: 20 }));
  check('tokensOf: nothing usable is null', turnTiming.tokensOf(null) === null && turnTiming.tokensOf({}) === null);

  // 5) The Chat Completions stream reports to the timer, and sends the cache hints (a fake client: no network).
  {
    let t = 0;
    const lines = [];
    const timer = turnTiming.taskTimer('openai:gpt-6', { now: () => t, log: (l) => lines.push(l) });
    let sent = null;
    const chunks = [
      { choices: [{ delta: { content: 'Hi' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'find', arguments: '{"query":"x"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 4000, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 3500 } } },
    ];
    const client = { chat: { completions: { create: (body, opts) => { sent = { body, opts }; return { async *[Symbol.asyncIterator]() { for (const c of chunks) { t += 100; yield c; } } }; } } } };
    const turn = await providers.streamTurn({ provider: 'openai', model: 'gpt-6', apiKey: 'k', system: 'SYS', messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'find', description: 'd', input_schema: { type: 'object', properties: {} } }], signal: undefined, emit: () => {}, client, timer, chatKey: 'chat-7' });
    check('stream: the turn still parses (text and tool call)', turn.content[0].text === 'Hi' && turn.content[1].name === 'find' && turn.stop_reason === 'tool_use');
    check('stream: the request line has first byte, token, tool call and the cached share', /^\[lumen\] turn openai gpt-6 #1: prep 0 ms · first byte 100 ms · first token 100 ms · tool call 200 ms · end 300 ms · in 500 \(cache read 3500, write 0\) out 12 · /.test(lines[0] || ''), lines[0]);
    check('cache: OpenAI gets a prompt_cache_key per chat (hashed, not the chat id)', /^lumen-[0-9a-f]{24}$/.test(sent.body.prompt_cache_key) && !sent.body.prompt_cache_key.includes('chat-7') && !sent.opts.headers, JSON.stringify(sent.body.prompt_cache_key));
  }
  {
    const a = providers.cacheHints('xai', 'grok-5', 'c1');
    const b = providers.cacheHints('xai', 'grok-5', 'c1');
    const c = providers.cacheHints('xai', 'grok-5', 'c2');
    check('cache: xAI gets x-grok-conv-id, the same for one chat and another for the next', a.headers['x-grok-conv-id'] === b.headers['x-grok-conv-id'] && a.headers['x-grok-conv-id'] !== c.headers['x-grok-conv-id'] && !a.body.prompt_cache_key);
    check('cache: no chat, no key or header', !providers.cacheHints('openai', 'gpt-6', null).body.prompt_cache_key && !providers.cacheHints('xai', 'g', '').headers);
    check('cache: Gemini, local and other OpenRouter models get nothing', ['gemini', 'local'].every((p) => !providers.cacheHints(p, 'm', 'c').markSystem && !providers.cacheHints(p, 'm', 'c').headers && !Object.keys(providers.cacheHints(p, 'm', 'c').body).length) && !providers.cacheHints('openrouter', 'openai/gpt-6', 'c').markSystem);
    check('cache: a Claude model through OpenRouter marks the system message', providers.cacheHints('openrouter', 'anthropic/claude-sonnet-5.5', 'c').markSystem === true);
    const marked = providers.markedSystem(providers.toChatMessages('SYSTEM TEXT', [{ role: 'user', content: 'hi' }]));
    check('cache: the marked system message keeps its text, with one ephemeral mark', marked[0].role === 'system' && marked[0].content[0].text === 'SYSTEM TEXT' && marked[0].content[0].cache_control.type === 'ephemeral' && marked[1].role === 'user', JSON.stringify(marked[0]));
  }

  // 6) The composer's preconnect: where each model's requests go, at most every few seconds, never for a CLI or a local model.
  {
    check('preconnect: Claude (plain id or auto) goes to api.anthropic.com', originFor('claude-opus-5-5', {}) === 'https://api.anthropic.com' && originFor('auto', {}) === 'https://api.anthropic.com');
    check('preconnect: each API provider\'s own host', originFor('openai:gpt-6', {}) === 'https://api.openai.com' && originFor('xai:grok-5', {}) === 'https://api.x.ai' && originFor('gemini:gemini-3', {}) === 'https://generativelanguage.googleapis.com' && originFor('openrouter:anthropic/claude', {}) === 'https://openrouter.ai');
    check('preconnect: none for CLI engines, local models or no model', [originFor('claudecode:sonnet', {}), originFor('codex:gpt', {}), originFor('grokbuild:x', {}), originFor('antigravity:x', {}), originFor('local:llama', {}), originFor('', {})].every((o) => o === null));
    check('preconnect: a base URL override moves it', originFor('claude-opus-5-5', { ANTHROPIC_BASE_URL: 'https://proxy.example:8443/v1' }) === 'https://proxy.example:8443');
    let t = 0;
    const opened = [];
    const pc = createPreconnect({ session: { preconnect: (o) => opened.push(o) }, hasKey: (p) => p !== 'gemini', now: () => t, env: {} });
    pc.warm('claude-opus-5-5'); t += 1000; pc.warm('claude-opus-5-5');
    check('preconnect: one socket, not again within a few seconds', opened.length === 1 && opened[0].url === 'https://api.anthropic.com' && opened[0].numSockets === 1);
    t += AGAIN_MS; pc.warm('claude-opus-5-5');
    check('preconnect: again once an unused one would have closed', opened.length === 2);
    pc.warm('gemini:gemini-3'); pc.warm('claudecode:sonnet');
    check('preconnect: no key for the provider, or a CLI engine: nothing', opened.length === 2 && pc.stats.skipped === 3, JSON.stringify(pc.stats));
    const throwing = createPreconnect({ session: { preconnect: () => { throw new Error('gone'); } }, env: {} });
    check('preconnect: a failing session never throws', throwing.warm('claude-opus-5-5') === false);
  }

  // 7) The Claude request: what every turn repeats stays within its size, and within the API's four cache marks.
  {
    const m = Object.assign([{ role: 'user', content: 'hi' }], { settings: { model: DEFAULT_MODEL, adhdMode: true } });
    const req = requestFor(m.settings, m);
    const stable = JSON.stringify(req.system).length + JSON.stringify(req.tools).length;
    const marks = (JSON.stringify(req).match(/"cache_control"/g) || []).length;
    check(`request: system + tools at most 20,900 characters (${stable}; ~${Math.round(stable / 4)} tokens, cached after the first turn)`, stable <= 20900, String(stable));
    check(`request: at most 4 cache marks (the API's limit; ${marks})`, marks <= 4, String(marks));
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
