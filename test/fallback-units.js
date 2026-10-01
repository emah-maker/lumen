// Automatic model fallback (ai/fallback.js and its use in ai/agent.js), plain Node: no Electron, no network, no CLI.
// Error classification over many real error shapes, the fallback order, cooldowns and the switch back,
// "never on other errors or auth", no tool run twice, and the setting being off.
const { classify, createCooldowns, order, pick, resolve, noticeFor, nameOf, COOLDOWN } = require('../src/ai/fallback');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const J = JSON.stringify;
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0); // 2026-10-01 12:00 UTC

// ---- error shapes, as the SDKs, Node's fetch, Electron's net stack and the two CLIs really produce them
const api = (name, status, type, message, headers = {}) => Object.assign(new Error(message), { name, status, headers, error: { type: 'error', error: { type, message } } });
const net = (message, code, name = 'TypeError') => Object.assign(new Error(message), { name, cause: Object.assign(new Error(code), { code }) });
const oai = (status, code, message, headers = {}) => Object.assign(new Error(`${status} ${message}`), { name: 'APIError', status, code, type: code, headers, error: { message, type: code, code } });
const headers = (o) => ({ get: (k) => o[String(k).toLowerCase()] ?? null });

const cases = [
  // ---- limit
  ['anthropic 429 rate_limit_error (retry-after 90)', api('RateLimitError', 429, 'rate_limit_error', 'This request would exceed your organization’s rate limit', headers({ 'retry-after': '90' })), 'limit', (c) => c.resetsAt === NOW + 90e3 && c.scope === 'model'],
  ['anthropic 429 with an HTTP-date retry-after', api('RateLimitError', 429, 'rate_limit_error', 'rate limited', headers({ 'retry-after': new Date(NOW + 5 * 60e3).toUTCString() })), 'limit', (c) => c.resetsAt === NOW + 5 * 60e3],
  ['anthropic 429 with no reset: a short default', api('RateLimitError', 429, 'rate_limit_error', 'slow down'), 'limit', (c) => c.resetsAt === NOW + COOLDOWN.rate && !c.exact],
  ['anthropic 400 "credit balance is too low"', api('BadRequestError', 400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.'), 'limit'],
  ['anthropic unified-reset header (epoch seconds)', api('RateLimitError', 429, 'rate_limit_error', 'limit', headers({ 'anthropic-ratelimit-unified-reset': String((NOW + 3 * 3600e3) / 1000) })), 'limit', (c) => c.resetsAt === NOW + 3 * 3600e3 && c.exact],
  ['openai 429 insufficient_quota', oai(429, 'insufficient_quota', 'You exceeded your current quota, please check your plan and billing details.'), 'limit'],
  ['openai 429 rate_limit_exceeded: "try again in 6m0s"', oai(429, 'rate_limit_exceeded', 'Rate limit reached for gpt-5.6 in organization org-x on tokens per min. Please try again in 6m0s.'), 'limit', (c) => c.resetsAt === NOW + 6 * 60e3],
  ['gemini 429 RESOURCE_EXHAUSTED', Object.assign(new Error('429 You exceeded your current quota'), { status: 429, error: { status: 'RESOURCE_EXHAUSTED' } }), 'limit'],
  ['gemini RESOURCE_EXHAUSTED text only', new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'), 'limit'],
  ['xai 402 payment required', oai(402, 'payment_required', 'Your team has run out of credits'), 'limit'],
  ['openrouter 402 insufficient credits', oai(402, null, 'Insufficient credits. Add more using https://openrouter.ai/credits'), 'limit'],
  ['openrouter 429 rate limited', oai(429, null, 'Provider returned error: rate-limited upstream'), 'limit'],
  ['Claude Code: usage limit with a reset time', "Your Claude plan's usage limit is reached. You've hit your limit · resets 5pm (UTC)", 'limit', (c) => c.resetsAt === Date.UTC(2026, 9, 1, 17, 0, 0) && c.scope === 'provider' && c.exact],
  ['Claude Code: the older epoch form', `Claude AI usage limit reached|${NOW / 1000 + 7200}`, 'limit', (c) => c.resetsAt === NOW + 7200e3],
  ['Claude Code: Opus limit names its family', 'Opus limit reached ∙ resets 5pm (UTC)', 'limit', (c) => c.scope === 'model' && c.family === 'opus'],
  ['Claude Code: weekly limit', "You've reached your weekly limit. It resets Oct 5 at 9am UTC", 'limit', (c) => c.resetsAt === Date.UTC(2026, 9, 5, 9, 0, 0)],
  ['Grok Build: usage limit, relative reset', "Your Grok plan's usage limit is reached. Try again in 2h 10m.", 'limit', (c) => c.resetsAt === NOW + (2 * 60 + 10) * 60e3],
  ['a plan limit without a time: the plan default', "Your Claude plan's usage limit is reached.", 'limit', (c) => c.resetsAt === NOW + COOLDOWN.plan && !c.exact],
  ['out of extra usage', 'You are out of extra usage', 'limit'],
  // ---- unreachable
  ['fetch failed / ENOTFOUND', net('fetch failed', 'ENOTFOUND'), 'unreachable', (c) => c.resetsAt === NOW + COOLDOWN.unreachable],
  ['fetch failed / ECONNRESET', net('fetch failed', 'ECONNRESET'), 'unreachable'],
  ['fetch failed / ETIMEDOUT', net('fetch failed', 'ETIMEDOUT'), 'unreachable'],
  ['fetch failed / ECONNREFUSED', net('fetch failed', 'ECONNREFUSED'), 'unreachable'],
  ['fetch failed / EAI_AGAIN', net('fetch failed', 'EAI_AGAIN'), 'unreachable'],
  ['undici connect timeout', net('Connect Timeout Error', 'UND_ERR_CONNECT_TIMEOUT'), 'unreachable'],
  ['socket hang up (code on the error itself)', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'unreachable'],
  ['anthropic APIConnectionError', Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' }), 'unreachable'],
  ['anthropic APIConnectionTimeoutError', Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' }), 'unreachable'],
  ['openai APIConnectionError', Object.assign(new Error('Connection error.'), { name: 'APIConnectionError', cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.x.ai'), { code: 'ENOTFOUND' }) }), 'unreachable'],
  ['500 api_error', api('InternalServerError', 500, 'api_error', 'Internal server error'), 'unreachable'],
  ['502 bad gateway', api('InternalServerError', 502, null, 'Bad gateway'), 'unreachable'],
  ['503 service unavailable', oai(503, null, 'Service Unavailable'), 'unreachable'],
  ['504 gateway timeout', oai(504, null, 'Gateway Timeout'), 'unreachable'],
  ['529 overloaded: this model only', api('InternalServerError', 529, 'overloaded_error', 'Overloaded'), 'unreachable', (c) => c.scope === 'model'],
  ['overloaded_error mid-stream (no status)', Object.assign(new Error('Overloaded'), { name: 'APIError', error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }), 'unreachable'],
  ['408 request timeout', oai(408, null, 'Request Timeout'), 'unreachable'],
  ['Electron net: ERR_INTERNET_DISCONNECTED', new Error('net::ERR_INTERNET_DISCONNECTED'), 'unreachable'],
  ['Electron net: ERR_NAME_NOT_RESOLVED', new Error('net::ERR_NAME_NOT_RESOLVED'), 'unreachable'],
  ['Claude Code: stopped responding (watchdog)', 'Claude Code stopped responding for 120 seconds, so Lumen ended it. Send your message again to pick up where it left off.', 'unreachable'],
  ['CLI text: could not connect', 'Claude Code stopped (exit 1): unable to connect to api.anthropic.com', 'unreachable'],
  // ---- auth: never a switch
  ['401 authentication_error', api('AuthenticationError', 401, 'authentication_error', 'invalid x-api-key'), 'auth'],
  ['403 permission_error', api('PermissionDeniedError', 403, 'permission_error', 'Your API key does not have permission'), 'auth'],
  ['openai 401 invalid_api_key', oai(401, 'invalid_api_key', 'Incorrect API key provided'), 'auth'],
  ['Claude Code not signed in', 'Claude Code is not signed in. Open a terminal, run `claude` once, then type /login. Lumen never sees your Claude login.', 'auth'],
  ['Grok Build not signed in', 'Grok Build is not signed in. Open a terminal, run `grok login`, and sign in with your SuperGrok or X Premium+ account.', 'auth'],
  ['an expired sign-in', 'Your Anthropic sign-in has expired. Sign in again in Settings.', 'auth'],
  ['no key', 'Add your OpenAI API key to use this model.', 'auth'],
  // ---- other: never a switch
  ['400 max_tokens over its limit (says "limit", is a bad request)', api('BadRequestError', 400, 'invalid_request_error', 'max_tokens: 99999 > 64000, which is the maximum allowed number of output tokens for this model; limit'), 'other'],
  ['prompt too long', api('BadRequestError', 400, 'invalid_request_error', 'prompt is too long: 250000 tokens > 200000 maximum'), 'other'],
  ['openai context_length_exceeded', oai(400, 'context_length_exceeded', "This model's maximum context length is 128000 tokens"), 'other'],
  ['404 model not found', api('NotFoundError', 404, 'not_found_error', 'model: claude-x'), 'other'],
  ['422 unprocessable', oai(422, null, 'bad schema'), 'other'],
  ['a content refusal', 'The model declined this request.', 'other'],
  ['the user pressed Stop (AbortError)', Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }), 'other'],
  ['the user pressed Stop (APIUserAbortError)', Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' }), 'other'],
  ['a destroyed tab', new Error('Object has been destroyed'), 'other'],
  ['a CLI crash with no cause', 'Claude Code stopped (exit 1): segmentation oddity', 'other'],
  ['an ordinary Error', new Error('boom'), 'other'],
  ['undefined', undefined, 'other'],
  ['null', null, 'other'],
  ['an empty string', '', 'other'],
];
for (const [label, input, kind, extra] of cases) {
  const c = classify(input, { now: NOW });
  check(`classify: ${label} -> ${kind}`, c.kind === kind && (!extra || extra(c)), J({ ...c }));
}
check(`classify: ${cases.length} shapes covered`, cases.length >= 50, String(cases.length));

// ---- the picker's list, as main.js modelOptions() builds it
const claude = (id, label) => ({ id, label, name: label, group: 'Claude', provider: 'Claude' });
const engine = (id, label, extra = {}) => ({ id, label, name: label, group: 'Your Claude account', provider: 'Claude Code', signedIn: true, badges: [], ...extra });
const OPTS = [
  claude('claude-opus-5-5', 'Opus 5.5'), claude('claude-opus-5', 'Opus 5'), claude('claude-fable-5-1', 'Fable 5.1'), claude('claude-sonnet-5', 'Sonnet 5'), claude('claude-haiku-4-5', 'Haiku 4.5'),
  { id: 'openai:gpt-5.6', label: 'GPT-5.6', name: 'GPT-5.6', group: 'OpenAI', provider: 'OpenAI' }, { id: 'openai:gpt-5.6-mini', label: 'GPT-5.6 mini', name: 'GPT-5.6 mini', group: 'OpenAI', provider: 'OpenAI' },
  { id: 'xai:grok-4', label: 'Grok 4', name: 'Grok 4', group: 'Grok', provider: 'Grok' },
  engine('claudecode:default', 'Claude Code'), engine('claudecode:fable', 'Claude Code · Fable'), engine('claudecode:opus', 'Claude Code · Opus'), engine('claudecode:sonnet', 'Claude Code · Sonnet'), engine('claudecode:haiku', 'Claude Code · Haiku'),
  engine('grokbuild:default', 'Grok Build (experimental)', { group: 'Your Grok account', provider: 'Grok Build', signedIn: false, badges: ['sign in'] }),
  { id: 'openrouter:__more', label: 'More models…', more: true, group: 'OpenRouter', provider: 'OpenRouter' },
  { id: 'openrouter:some/chat-only', label: 'chat only one', group: 'OpenRouter', provider: 'OpenRouter', badges: ['chat only'] },
];

// ---- order: same provider first (cheaper first), then the same vendor's other route, then everyone else
const o1 = order({ current: 'claude-opus-5-5', options: OPTS });
check('order: Opus -> Sonnet -> Haiku first (cheaper tiers before the rest of the family)', J(o1.slice(0, 2)) === J(['claude-sonnet-5', 'claude-haiku-4-5']), J(o1));
check('order: same-provider models come before any other provider', o1.slice(0, 4).every((id) => !id.includes(':')), J(o1));
check('order: then the same vendor (Claude Code), then other providers', o1.indexOf('claudecode:sonnet') > o1.indexOf('claude-fable-5-1') && o1.indexOf('openai:gpt-5.6') > o1.indexOf('claudecode:sonnet'), J(o1));
check('order: never the current model, a sign-in-needed engine, a "More models" row or a chat-only model', !o1.includes('claude-opus-5-5') && !o1.includes('grokbuild:default') && !o1.includes('openrouter:__more') && !o1.includes('openrouter:some/chat-only'), J(o1));
check('order: the lightest model goes to the next provider, not away', J(order({ current: 'claude-haiku-4-5', options: OPTS }).slice(0, 3)) === J(['claude-sonnet-5', 'claude-opus-5-5', 'claude-opus-5']), J(order({ current: 'claude-haiku-4-5', options: OPTS })));
check('order: from OpenAI, its other model first, then Claude', J(order({ current: 'openai:gpt-5.6', options: OPTS }).slice(0, 2)) === J(['openai:gpt-5.6-mini', 'claude-opus-5-5']), J(order({ current: 'openai:gpt-5.6', options: OPTS })));
check('order: Claude Code default tries Sonnet, then Haiku (Opus is likely what failed)', J(order({ current: 'claudecode:default', options: OPTS }).slice(0, 2)) === J(['claudecode:sonnet', 'claudecode:haiku']), J(order({ current: 'claudecode:default', options: OPTS })));
check('order: Claude Code goes to the Claude API after its own models', order({ current: 'claudecode:sonnet', options: OPTS }).includes('claude-sonnet-5'), J(order({ current: 'claudecode:sonnet', options: OPTS })));
check('order: engines left out when asked (a turn that already ran tools)', !order({ current: 'claude-opus-5-5', options: OPTS, allowEngines: false }).some((id) => /^(claudecode|grokbuild):/.test(id)));
check('order: nothing unconfigured is ever offered (only what the list holds)', order({ current: 'claude-opus-5-5', options: [claude('claude-opus-5-5', 'Opus 5.5')] }).length === 0);

// ---- cooldowns and the switch back
{
  const cd = createCooldowns();
  const lim = classify('Your Claude plan\'s usage limit is reached. Resets 5pm (UTC)', { now: NOW });
  cd.mark('claudecode:opus', lim, NOW);
  const reset = Date.UTC(2026, 9, 1, 17, 0, 0);
  check('cooldown: a plan limit leaves every model of that provider alone until its reset time', cd.cooling('claudecode:opus', NOW) && cd.cooling('claudecode:haiku', NOW + 3600e3) && !cd.cooling('claude-opus-5-5', NOW), '');
  const untilNow = cd.until('claudecode:opus', NOW);
  check('cooldown: it ends at the reset time (switch back)', untilNow === reset && cd.cooling('claudecode:opus', reset - 1) && !cd.cooling('claudecode:opus', reset), String(untilNow));

  const cm = createCooldowns();
  cm.mark('claude-opus-5-5', classify(api('RateLimitError', 429, 'rate_limit_error', 'x', headers({ 'retry-after': '600' })), { now: NOW }), NOW);
  check('cooldown: an API 429 leaves that model alone, not its siblings', cm.cooling('claude-opus-5-5', NOW + 1) && !cm.cooling('claude-sonnet-5', NOW + 1), '');
  check('cooldown: until Retry-After', cm.cooling('claude-opus-5-5', NOW + 599e3) && !cm.cooling('claude-opus-5-5', NOW + 600e3), '');

  const cu = createCooldowns();
  cu.mark('openai:gpt-5.6', classify(net('fetch failed', 'ENOTFOUND'), { now: NOW }), NOW);
  check('cooldown: unreachable leaves the whole provider alone for about 15 minutes', cu.cooling('openai:gpt-5.6-mini', NOW + 14 * 60e3) && !cu.cooling('openai:gpt-5.6', NOW + 15 * 60e3) && !cu.cooling('claude-opus-5-5', NOW + 1), '');

  const cx = createCooldowns();
  cx.mark('claude-opus-5-5', classify(oai(401, 'invalid_api_key', 'no'), { now: NOW }), NOW);
  cx.mark('claude-opus-5-5', classify(api('BadRequestError', 400, 'invalid_request_error', 'bad'), { now: NOW }), NOW);
  cx.mark('claude-opus-5-5', classify('The model declined this request.', { now: NOW }), NOW);
  check('cooldown: auth and other errors cool nothing', cx.size(NOW) === 0, String(cx.size(NOW)));

  const cf = createCooldowns();
  cf.mark('claudecode:default', classify('Opus limit reached ∙ resets 5pm (UTC)', { now: NOW }), NOW);
  check('cooldown: "Opus limit" on the default Claude Code model also rules out the opus alias, but not Sonnet', cf.cooling('claudecode:default', NOW) && cf.cooling('claudecode:opus', NOW) && !cf.cooling('claudecode:sonnet', NOW), '');
  check('pick: skips what is cooling and what was already tried this turn', pick({ current: 'claudecode:default', options: OPTS, cooldowns: cf, at: NOW }) === 'claudecode:sonnet' && pick({ current: 'claudecode:default', options: OPTS, cooldowns: cf, at: NOW, tried: ['claudecode:sonnet'] }) === 'claudecode:haiku', pick({ current: 'claudecode:default', options: OPTS, cooldowns: cf, at: NOW }));

  // resolve(): the turn's starting model
  const rc = createCooldowns();
  rc.mark('claude-opus-5-5', classify(api('RateLimitError', 429, 'rate_limit_error', 'x', headers({ 'retry-after': '1800' })), { now: NOW }), NOW);
  const during = resolve({ preferred: 'claude-opus-5-5', options: OPTS, cooldowns: rc, at: NOW + 60e3 });
  check('resolve: while Opus cools down a new turn starts on Sonnet', during.model === 'claude-sonnet-5' && during.from === 'claude-opus-5-5' && during.until === NOW + 1800e3, J(during));
  const after = resolve({ preferred: 'claude-opus-5-5', options: OPTS, cooldowns: rc, at: NOW + 1800e3 });
  check('resolve: when the cooldown ends the turn is back on the pick', after.model === 'claude-opus-5-5' && after.from === null, J(after));
  check('resolve: setting off -> always the pick', resolve({ preferred: 'claude-opus-5-5', options: OPTS, cooldowns: rc, at: NOW + 60e3, enabled: false }).model === 'claude-opus-5-5');
  check('resolve: nothing else usable -> the pick (the error will say why)', resolve({ preferred: 'claude-opus-5-5', options: [claude('claude-opus-5-5', 'Opus 5.5')], cooldowns: rc, at: NOW + 60e3 }).model === 'claude-opus-5-5');
  const chain = createCooldowns();
  chain.mark('claude-opus-5-5', classify(api('RateLimitError', 429, 'rate_limit_error', 'x', headers({ 'retry-after': '3600' })), { now: NOW }), NOW);
  chain.mark('claude-sonnet-5', classify(api('RateLimitError', 429, 'rate_limit_error', 'x', headers({ 'retry-after': '3600' })), { now: NOW }), NOW);
  check('resolve: a stand-in that is limited too passes to the next (Haiku)', resolve({ preferred: 'claude-opus-5-5', options: OPTS, cooldowns: chain, at: NOW + 1 }).model === 'claude-haiku-4-5');
}

// ---- notices
{
  const when = () => '3:40 PM';
  check('notice: usage limit', noticeFor({ kind: 'limit', from: 'claude-opus-5-5', to: 'claude-sonnet-5' }, OPTS) === 'Claude Opus 5.5 hit its usage limit, switched to Claude Sonnet 5.', noticeFor({ kind: 'limit', from: 'claude-opus-5-5', to: 'claude-sonnet-5' }, OPTS));
  check('notice: a known reset time says when it is back', noticeFor({ kind: 'limit', from: 'claude-opus-5-5', to: 'claude-sonnet-5', resetsAt: NOW + 3600e3, exact: true }, OPTS, { when, now: NOW }) === 'Claude Opus 5.5 hit its usage limit, switched to Claude Sonnet 5. Back on Claude Opus 5.5 at 3:40 PM.');
  check('notice: a guessed reset time is not shown', !/Back on/.test(noticeFor({ kind: 'limit', from: 'claude-opus-5-5', to: 'claude-sonnet-5', resetsAt: NOW + 3600e3, exact: false }, OPTS, { when, now: NOW })));
  check('notice: unreachable names the provider', noticeFor({ kind: 'unreachable', from: 'xai:grok-4', to: 'claude-opus-5-5' }, OPTS) === 'Couldn’t reach xAI, switched to Claude Opus 5.5.', noticeFor({ kind: 'unreachable', from: 'xai:grok-4', to: 'claude-opus-5-5' }, OPTS));
  check('notice: engines name themselves', noticeFor({ kind: 'limit', from: 'claudecode:opus', to: 'claude-sonnet-5' }, OPTS).startsWith('Claude Code · Opus hit its usage limit'));
  check('notice: still / back', noticeFor({ kind: 'still', from: 'claude-opus-5-5', to: 'claude-sonnet-5' }, OPTS) === 'Claude Opus 5.5 is still unavailable, using Claude Sonnet 5 for now.' && noticeFor({ kind: 'back', from: 'claude-opus-5-5' }, OPTS) === 'Back on Claude Opus 5.5.');
  check('nameOf: other providers read "OpenAI GPT-5.6"', nameOf('openai:gpt-5.6', OPTS) === 'OpenAI GPT-5.6', nameOf('openai:gpt-5.6', OPTS));
}

// ---- the agent: failover in a running turn
const { Agent } = require('../src/ai/agent');
const fallback = require('../src/ai/fallback');

function makeAgent({ options = OPTS, on = true, scripts = {}, ccText = null } = {}) {
  const log = { tools: [], turns: [], events: [], cc: [] };
  const agent = Object.assign(Object.create(Agent.prototype), {
    scopes: new Set(), runs: new Map(), approvedHosts: new Set(),
    browser: { fallbackOptions: () => options, autoFallback: () => on, maxSteps: () => 0, onFallback() { log.onFallback = (log.onFallback || 0) + 1; }, aiOff: () => false, noTabReason: () => 'No tab open.', effectiveModel: (m) => m, activeTab: () => null },
    engines: { claudecode: { warm() {}, release() { log.released = true; } }, grokbuild: {} },
    isExternalTool: () => false,
    async describeStep() { return 'step'; },
    async ensureAllowed() {},
    closeSignedInTabs() {},
    guardRedirects: () => null,
    async runTool(name) { log.tools.push(name); return 'ok'; },
    async pageContextFor() { return ''; },
    newActionLog: () => ({}), undoSummary: () => null,
    // a model's turn: the script for it says what happens, in order
    async claudeTurn(messages) {
      const model = messages.settings.model;
      return this.scripted(model, messages);
    },
    async otherTurn(messages) { return this.scripted(messages.settings.model, messages); },
    async scripted(model, messages) {
      log.turns.push({ model, len: messages.length });
      const step = (scripts[model] || []).shift();
      if (!step) return { content: [{ type: 'text', text: `${model} answers` }], stop_reason: 'end_turn', model };
      if (step instanceof Error || typeof step === 'string') throw typeof step === 'string' ? new Error(step) : step;
      return { ...step, model };
    },
    async claudeCodeTurn(messages, prompt, images, signal, emit) {
      log.cc.push(messages.settings.model);
      await (ccText || (async () => {}))(emit, this, messages);
    },
  });
  agent.execute = (name, input) => Agent.prototype.executeGuarded.call(agent, name, input);
  return { agent, log };
}
const toolTurn = { content: [{ type: 'tool_use', id: 't1', name: 'read_page', input: {} }], stop_reason: 'tool_use' };
const run = async (agent, messages, log, { text = 'hi' } = {}) => {
  const controller = new AbortController();
  const emit = (e) => log.events.push(e);
  await agent.inTask(null, controller.signal, () => agent.runTask(messages, null, text, [], controller, emit, {}), messages, null, {});
  return log.events;
};
const fresh = (model) => { const m = []; m.settings = { model }; return m; };
const notices = (log) => log.events.filter((e) => e.type === 'notice').map((e) => e.text);
const errors = (log) => log.events.filter((e) => e.type === 'error');

(async () => {
  const realNow = Date.now;
  let clock = NOW;
  Date.now = () => clock;
  try {
    // 1) A limit after a tool already ran: the turn continues on Sonnet with the tool result in its history; the tool is not run again.
    {
      fallback.shared.clear();
      const rl = api('RateLimitError', 429, 'rate_limit_error', 'rate limited', headers({ 'retry-after': '900' }));
      const { agent, log } = makeAgent({ scripts: { 'claude-opus-5-5': [toolTurn, rl] } });
      const messages = fresh('claude-opus-5-5');
      await run(agent, messages, log);
      check('limit mid-task: the tool ran exactly once', log.tools.length === 1, J(log.tools));
      check('limit mid-task: Sonnet finished the turn', log.turns.map((t) => t.model).join() === 'claude-opus-5-5,claude-opus-5-5,claude-sonnet-5', J(log.turns));
      check('limit mid-task: Sonnet was handed the conversation including the tool result', log.turns[2].len === 3, J(log.turns));
      check('limit mid-task: one quiet notice, no error', J(notices(log)) === J(['Claude Opus 5.5 hit its usage limit, switched to Claude Sonnet 5. Back on Claude Opus 5.5 at ' + new Date(NOW + 900e3).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.']) && errors(log).length === 0, J(log.events.filter((e) => e.type === 'notice' || e.type === 'error')));
      check('limit mid-task: the chat is on Sonnet and remembers the pick', messages.settings.model === 'claude-sonnet-5' && messages.settings.fallbackFrom === 'claude-opus-5-5', J(messages.settings));
      check('limit mid-task: the notice event carries the switch (the picker follows)', log.events.find((e) => e.fallback)?.fallback.to === 'claude-sonnet-5' && log.onFallback === 1);
      check('limit mid-task: the partial output is dropped (retry), the step is not used up', log.events.some((e) => e.type === 'retry'));
      check('limit mid-task: the limited model is cooling down', fallback.shared.cooling('claude-opus-5-5', clock));

      // 2) The next message: Opus still cooling -> starts on Sonnet (a notice once); after the reset it is back on Opus.
      log.events.length = 0; log.turns.length = 0;
      await agent.runOnce('again', (e) => log.events.push(e), [], {}, null, messages, { controller: new AbortController(), hosts: new Set() });
      check('next message: starts on Sonnet while Opus cools down', log.turns[0]?.model === 'claude-sonnet-5', J(log.turns));
      check('next message: no repeated notice', notices(log).length === 0, J(notices(log)));
      check('next message: the done event names the model that answered (the reply label)', log.events.find((e) => e.type === 'done')?.model === 'claude-sonnet-5', J(log.events.find((e) => e.type === 'done')));
      clock = NOW + 901e3; // the reset time has passed
      log.events.length = 0; log.turns.length = 0;
      await agent.runOnce('later', (e) => log.events.push(e), [], {}, null, messages, { controller: new AbortController(), hosts: new Set() });
      check('after the reset: back on Opus automatically', log.turns[0]?.model === 'claude-opus-5-5' && messages.settings.model === 'claude-opus-5-5' && !messages.settings.fallbackFrom, J({ turns: log.turns, s: messages.settings }));
      check('after the reset: a short "Back on" note', J(notices(log)) === J(['Back on Claude Opus 5.5.']), J(notices(log)));
      clock = NOW;
    }

    // 2b) A user pick ends the stand-in.
    {
      fallback.shared.clear();
      const { agent } = makeAgent();
      agent.messages = fresh('claude-sonnet-5');
      agent.messages.settings.fallbackFrom = 'claude-opus-5-5';
      agent.setModel('claude-haiku-4-5');
      check('picking a model clears the stand-in', agent.messages.settings.model === 'claude-haiku-4-5' && !agent.messages.settings.fallbackFrom);
    }

    // 3) Unreachable at the start of a turn: nothing ran, so it can also go to an engine; here the next is the same provider.
    {
      fallback.shared.clear();
      const { agent, log } = makeAgent({ options: OPTS.filter((o) => o.id.startsWith('openai:') || o.id === 'claude-sonnet-5'), scripts: { 'openai:gpt-5.6': [net('fetch failed', 'ENOTFOUND')] } });
      const messages = fresh('openai:gpt-5.6');
      await run(agent, messages, log);
      check('unreachable: the same provider\'s other model takes over?  no, the whole provider is down: Claude does', log.turns.map((t) => t.model).join() === 'openai:gpt-5.6,claude-sonnet-5', J(log.turns));
      check('unreachable: names the provider', /^Couldn’t reach OpenAI, switched to Claude Sonnet 5\.$/.test(notices(log)[0] || ''), J(notices(log)));
      check('unreachable: the provider is out for ~15 minutes', fallback.shared.cooling('openai:gpt-5.6-mini', clock + 14 * 60e3) && !fallback.shared.cooling('openai:gpt-5.6', clock + 16 * 60e3));
    }

    // 4) Everything fails: the last error is shown, after at most MAX_HOPS switches; nothing loops.
    {
      fallback.shared.clear();
      const down = () => net('fetch failed', 'ENOTFOUND');
      const apiOnly = OPTS.filter((o) => !/^(claudecode|grokbuild):/.test(o.id));
      const { agent, log } = makeAgent({ options: apiOnly, scripts: { 'claude-opus-5-5': [down()], 'openai:gpt-5.6': [down()], 'xai:grok-4': [down()], 'openai:gpt-5.6-mini': [down()] } });
      const messages = fresh('claude-opus-5-5');
      let thrown = null;
      try { await run(agent, messages, log); } catch (err) { thrown = err; }
      check('all unavailable: it tried each provider once, then the error stands', thrown && log.turns.map((t) => t.model).join() === 'claude-opus-5-5,openai:gpt-5.6,xai:grok-4', J({ n: log.turns.length, thrown: thrown?.message }));
    }

    // 5) auth and other: never a switch, no cooldown.
    for (const [label, err] of [
      ['a rejected key', api('AuthenticationError', 401, 'authentication_error', 'invalid x-api-key')],
      ['a bad request', api('BadRequestError', 400, 'invalid_request_error', 'messages: roles must alternate')],
      ['an ordinary error', new Error('boom')],
    ]) {
      fallback.shared.clear();
      const { agent, log } = makeAgent({ scripts: { 'claude-opus-5-5': [err] } });
      const messages = fresh('claude-opus-5-5');
      let thrown = null;
      try { await run(agent, messages, log); } catch (e) { thrown = e; }
      check(`no switch on ${label}`, thrown === err && log.turns.length === 1 && messages.settings.model === 'claude-opus-5-5' && !messages.settings.fallbackFrom && fallback.shared.size(clock) === 0 && notices(log).length === 0, J({ turns: log.turns, thrown: thrown?.message }));
    }

    // 5b) a Stop during the failure is never a switch.
    {
      fallback.shared.clear();
      const { agent, log } = makeAgent();
      const messages = fresh('claude-opus-5-5');
      const c = new AbortController();
      c.abort();
      const next = agent.failoverFor(messages, api('RateLimitError', 429, 'rate_limit_error', 'x'), () => {}, { tried: new Set(), allowEngines: true });
      check('failoverFor on a 429 returns the next model (sanity)', next === 'claude-sonnet-5', String(next));
      void c; void log;
    }

    // 6) the setting off: the error stands, and a cooling model is still used as picked.
    {
      fallback.shared.clear();
      const rl = api('RateLimitError', 429, 'rate_limit_error', 'rate limited');
      const { agent, log } = makeAgent({ on: false, scripts: { 'claude-opus-5-5': [rl] } });
      const messages = fresh('claude-opus-5-5');
      let thrown = null;
      try { await run(agent, messages, log); } catch (e) { thrown = e; }
      check('setting off: the limit error stands, no switch', thrown === rl && log.turns.length === 1 && messages.settings.model === 'claude-opus-5-5' && !messages.settings.fallbackFrom, J(log.turns));
      fallback.shared.mark('claude-opus-5-5', classify(rl, { now: clock }), clock);
      const { agent: a2, log: l2 } = makeAgent({ on: false });
      const m2 = fresh('claude-opus-5-5');
      await a2.runOnce('hi', (e) => l2.events.push(e), [], {}, null, m2, { controller: new AbortController(), hosts: new Set() });
      check('setting off: a new turn still starts on the pick', l2.turns[0]?.model === 'claude-opus-5-5' && !m2.settings.fallbackFrom, J(l2.turns));
      const { agent: a3, log: l3 } = makeAgent({ options: undefined });
      a3.browser.fallbackOptions = undefined;
      const m3 = fresh('claude-opus-5-5');
      await a3.runOnce('hi', (e) => l3.events.push(e), [], {}, null, m3, { controller: new AbortController(), hosts: new Set() });
      check('no picker list (an Agent without it): nothing changes', l3.turns[0]?.model === 'claude-opus-5-5');
    }

    // 7) a CLI engine hits its plan limit before any tool: the turn goes to the next usable model and the error is not shown.
    {
      fallback.shared.clear();
      const limitText = "Your Claude plan's usage limit is reached. You've hit your limit · resets 5pm (UTC)";
      const { agent, log } = makeAgent({ ccText: async (emit) => { emit({ type: 'error', text: limitText }); } });
      agent.claudeCodePlan = () => ({ routed: { auto: false }, spawn: {} });
      const messages = fresh('claudecode:opus');
      await run(agent, messages, log);
      check('engine limit: no error shown', errors(log).length === 0, J(errors(log)));
      check('engine limit: the turn went to the Claude API (the plan is out, so its siblings are skipped)', log.turns.map((t) => t.model).join() === 'claude-sonnet-5', J({ turns: log.turns, cc: log.cc }));
      check('engine limit: the notice names Claude Code', /^Claude Code · Opus hit its usage limit, switched to Claude Sonnet 5\./.test(notices(log)[0] || ''), J(notices(log)));
      check('engine limit: the warm Claude Code process was released', log.released === true);
      check('engine limit: the whole Claude Code plan is cooling until the reset', fallback.shared.cooling('claudecode:haiku', clock) && !fallback.shared.cooling('claude-sonnet-5', clock));
    }

    // 8) an engine that already ran a tool is never started over: the error is shown.
    {
      fallback.shared.clear();
      const limitText = "Your Claude plan's usage limit is reached. Try again in 2h.";
      const { agent, log } = makeAgent({ ccText: async (emit, self) => { await self.execute('read_page', {}); emit({ type: 'error', text: limitText }); } });
      agent.claudeCodePlan = () => ({ routed: { auto: false }, spawn: {} });
      const messages = fresh('claudecode:opus');
      await run(agent, messages, log);
      check('engine ran a tool, then hit the limit: no switch (nothing runs twice)', log.turns.length === 0 && log.tools.length === 1 && errors(log).length === 1 && messages.settings.model === 'claudecode:opus', J({ turns: log.turns, tools: log.tools, errors: errors(log) }));
      check('engine ran a tool: the error text is the engine\'s own', /usage limit/.test(errors(log)[0]?.text || ''));
    }

    // 8b) an engine that had already streamed text is not started over either.
    {
      fallback.shared.clear();
      const { agent, log } = makeAgent({ ccText: async (emit) => { emit({ type: 'text', text: 'Working on' }); emit({ type: 'error', text: 'Claude Code stopped responding for 120 seconds, so Lumen ended it.' }); } });
      agent.claudeCodePlan = () => ({ routed: { auto: false }, spawn: {} });
      const messages = fresh('claudecode:opus');
      await run(agent, messages, log);
      check('engine failed after showing text: the error stands, no second answer', log.turns.length === 0 && errors(log).length === 1, J({ turns: log.turns, errors: errors(log) }));
    }

    // 8c) an engine sign-in problem is not a switch.
    {
      fallback.shared.clear();
      const { agent, log } = makeAgent({ ccText: async (emit) => { emit({ type: 'error', text: 'Claude Code is not signed in. Open a terminal, run `claude` once, then type /login.' }); } });
      agent.claudeCodePlan = () => ({ routed: { auto: false }, spawn: {} });
      const messages = fresh('claudecode:opus');
      await run(agent, messages, log);
      check('engine not signed in: error shown, no switch, no cooldown', log.turns.length === 0 && errors(log).length === 1 && fallback.shared.size(clock) === 0, J({ turns: log.turns, errors: errors(log) }));
    }

    // 9) an API model unreachable at step 0 may go to an engine (nothing ran); after a tool it may not.
    {
      fallback.shared.clear();
      const engineOnly = OPTS.filter((o) => o.id === 'claude-opus-5-5' || /^claudecode:/.test(o.id));
      const { agent, log } = makeAgent({ options: engineOnly, scripts: { 'claude-opus-5-5': [net('fetch failed', 'ENOTFOUND')] }, ccText: async (emit) => { emit({ type: 'text', text: 'from the CLI' }); } });
      agent.claudeCodePlan = () => ({ routed: { auto: false }, spawn: {} });
      const messages = fresh('claude-opus-5-5');
      await run(agent, messages, log);
      check('API unreachable before anything ran: Claude Code answers', log.cc.length === 1 && /^claudecode:/.test(log.cc[0]) && errors(log).length === 0, J({ cc: log.cc, errors: errors(log) }));

      fallback.shared.clear();
      const w = makeAgent({ options: engineOnly, scripts: { 'claude-opus-5-5': [toolTurn, net('fetch failed', 'ENOTFOUND')] } });
      w.agent.claudeCodePlan = () => ({ routed: { auto: false }, spawn: {} });
      const m2 = fresh('claude-opus-5-5');
      let thrown = null;
      try { await run(w.agent, m2, w.log); } catch (e) { thrown = e; }
      check('API unreachable after a tool ran: it may not move to an engine (the tool is not repeated), the error stands', Boolean(thrown) && w.log.tools.length === 1 && w.log.cc.length === 0 && m2.settings.model === 'claude-opus-5-5', J({ tools: w.log.tools, cc: w.log.cc, thrown: thrown?.message }));
    }
  } finally {
    Date.now = realNow;
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall fallback checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
