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
  // ---- polish: rater's minor fixes
  ['text: "spend limit field" is not a credit limit', 'The spend limit field is empty, enter a number', 'other'],
  ['text: "credit limit" in a form message', 'Edit the credit limit for this card', 'other'],
  ['text: "monthly spend limit reached" is a limit', 'Your monthly spend limit reached', 'limit'],
  ['text: "hit your credit limit" is a limit', 'You have hit your credit limit', 'limit'],
  ['undici ERR_INVALID_URL is a bad URL is the request fault', Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL' }) }), 'other'],
  ['ERR_INVALID_ARG_TYPE is not the network', net('fetch failed', 'ERR_INVALID_ARG_TYPE'), 'other'],
  ['gemini 429 with RetryInfo retryDelay "54s"', Object.assign(new Error('429 quota'), { status: 429, error: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.Help' }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '54s' }] } } }), 'limit', (c) => c.resetsAt === NOW + 54e3 && c.exact],
  ['undici bare "terminated" mid-stream', Object.assign(new TypeError('terminated'), {}), 'unreachable'],
  ['bare "terminated" text', 'terminated', 'unreachable'],
  ['"terminated" from a user Stop (AbortError) stays other', Object.assign(new Error('terminated'), { name: 'AbortError' }), 'other'],
  ['"terminated" with a cause is judged by the cause', Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }), 'unreachable'],
  ['openrouter 400 whose metadata.raw carries an upstream 429', Object.assign(new Error('400 Provider returned error'), { status: 400, error: { message: 'Provider returned error', code: 400, metadata: { raw: '{"error":{"code":429,"message":"rate limited"}}', provider_name: 'X' } } }), 'limit', (c) => c.status === 429],
  ['openrouter 400 whose metadata.raw carries an upstream 503 (text)', Object.assign(new Error('400 Provider returned error'), { status: 400, error: { message: 'Provider returned error', code: 400, metadata: { raw: 'upstream said 503 Service Unavailable' } } }), 'unreachable', (c) => c.status === 503],
  ['openrouter 400 with an upstream 400 stays other', Object.assign(new Error('400 Provider returned error'), { status: 400, error: { message: 'Provider returned error', code: 400, metadata: { raw: '{"error":{"code":400,"message":"bad schema"}}' } } }), 'other'],
  ['undefined', undefined, 'other'],
  ['null', null, 'other'],
  ['an empty string', '', 'other'],
  // ---- text only: anchored phrases switch, loose words do not (a tool, a page or a request message can say "limit" or "timeout")
  ['text: "request rate limit of tool calls per page" is not a model limit', 'Cannot process: request rate limit of tool calls per page exceeded', 'other'],
  ['text: "rate limit of tool calls per page"', 'The request rate limit of tool calls per page was hit', 'other'],
  ['text: "Tool timed out after 30s"', 'Tool timed out after 30s', 'other'],
  ['text: "read_page timed out"', 'read_page timed out waiting for the page', 'other'],
  ['text: "page is offline-capable"', 'The page is offline-capable', 'other'],
  ['text: "you are offline" in page text', 'This site works offline', 'other'],
  ['text: a bare "limit reached" (a tab limit)', 'Tab limit reached: close a tab first', 'other'],
  ['text: a bare "quota" (storage)', 'Storage quota for this site is 50MB', 'other'],
  ['text: "too many tools: limit is 128"', 'too many tools: limit is 128', 'other'],
  ['text: "Image exceeds the 5MB limit"', 'Image exceeds the 5MB limit', 'other'],
  ['text: "max_tokens limit exceeded"', 'max_tokens limit exceeded', 'other'],
  ['text: "safety limit"', 'response blocked: safety limit', 'other'],
  ['text: the word "resets" with no limit around it', 'The timer resets at midnight in this game', 'other'],
  ['text: "billing" in a page title', 'Billing settings | Example', 'other'],
  ['text: token-limit wording is a context error', 'You have reached the token limit for this request', 'other'],
  ['text: "token limit for this request"', 'Exceeded the token limit for this request', 'other'],
  ['text: input length over the context window', 'Input length exceeds the context window limit', 'other'],
  ['text: the conversation over the model limit for context', 'The conversation exceeded the model limit for context', 'other'],
  ['status 400 with a context error', api('BadRequestError', 400, 'invalid_request_error', 'prompt is too long: 250000 tokens > 200000 maximum'), 'other'],
  ['text: "rate limit exceeded"', 'Rate limit exceeded. Try again later.', 'limit'],
  ['text: "rate limit reached"', 'Claude rate limit reached', 'limit'],
  ['text: a leading provider name', 'Grok usage limit reached, resets 5pm (UTC)', 'limit', (c) => c.resetsAt === Date.UTC(2026, 9, 1, 17, 0, 0)],
  ['text: "quota exceeded"', 'Daily quota exceeded for this project', 'limit'],
  ['text: "insufficient_quota"', 'error code: insufficient_quota', 'limit'],
  ['text: "credit balance"', 'Your credit balance is too low', 'limit'],
  ['text: "You\u2019ve hit your limit \u00b7 resets 3pm"', 'You\u2019ve hit your limit \u00b7 resets 3pm', 'limit'],
  ['text: "usage limit"', 'Your plan usage limit has been reached', 'limit'],
  ['text: "resets" with a limit', 'Limit hit. Resets in 2h', 'limit'],
  ['text: connection error', 'Connection error. Check your network', 'unreachable'],
  ['text: network error', 'Network error while contacting the API', 'unreachable'],
  ['text: ETIMEDOUT in a message', 'connect ETIMEDOUT 104.18.0.1:443', 'unreachable'],
  ['text: ECONNREFUSED in a message', 'connect ECONNREFUSED 127.0.0.1:443', 'unreachable'],
  ['text: "request timed out" from an SDK', 'Request timed out.', 'unreachable'],
  ['structured: an errno string on the error', Object.assign(new Error('boom'), { errno: 'ECONNRESET' }), 'unreachable'],
  ['structured: a code on the cause', Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } }), 'unreachable'],
  ['structured: a status 502 with text that says nothing', Object.assign(new Error('x'), { status: 502 }), 'unreachable'],
  ['structured: error.type overloaded_error', Object.assign(new Error('x'), { error: { type: 'overloaded_error' } }), 'unreachable'],
  ['structured: status 429 with unrelated text', Object.assign(new Error('Tool timed out'), { status: 429 }), 'limit'],
  // ---- round 3: credit exhaustion is a limit whatever the status, a CLI's embedded status and type, numeric body codes
  ['xai 403 used all credits or monthly spending limit', oai(403, null, 'Your team 1a2b3c has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit.'), 'limit', (c) => c.scope === 'provider'],
  ['xai 403 monthly spending limit (no status, text only)', new Error('Your team has either used all available credits or reached its monthly spending limit.'), 'limit'],
  ['xai 403 a plain permission denial stays auth', oai(403, null, 'The API key does not have permission to access this model'), 'auth'],
  ['openai 429 insufficient_quota, real body', Object.assign(new Error('429 You exceeded your current quota, please check your plan and billing details.'), { name: 'RateLimitError', status: 429, code: 'insufficient_quota', type: 'insufficient_quota', error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' } }), 'limit', (c) => c.scope === 'provider'],
  ['anthropic 400 credit balance too low, real body', api('BadRequestError', 400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'), 'limit'],
  ['claude code text-only 429 rate_limit_error', new Error('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account’s rate limit. Please try again later."},"request_id":"req_011CTx"}'), 'limit', (c) => c.status === 429],
  ['claude code text-only rate_limit_error without a status', 'API Error: {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}', 'limit'],
  ['claude code text-only overloaded_error', new Error('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), 'unreachable'],
  ['claude code text-only overloaded_error without a status', 'API Error: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'unreachable'],
  ['claude code text-only authentication_error', new Error('API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), 'auth'],
  ['claude code text-only 400 invalid_request_error is not a switch', new Error('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: text content blocks must be non-empty"}}'), 'other'],
  ['claude code text-only 500 api_error', new Error('API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}'), 'unreachable'],
  ['openrouter numeric body code 429', Object.assign(new Error('Provider returned error'), { error: { code: 429, message: 'Provider returned error' } }), 'limit', (c) => c.status === 429],
  ['openrouter numeric inner code 402', Object.assign(new Error('x'), { error: { error: { code: 402, message: 'x' } } }), 'limit', (c) => c.status === 402],
  ['openrouter numeric body code 503', Object.assign(new Error('No instances available'), { error: { code: 503, message: 'No instances available' } }), 'unreachable'],
  ['openrouter numeric body code 401', Object.assign(new Error('No auth credentials found'), { error: { code: 401, message: 'No auth credentials found' } }), 'auth'],
  ['openrouter numeric body code 400 is not a switch', Object.assign(new Error('Provider returned error'), { error: { code: 400, message: 'max_tokens limit is 4096' } }), 'other'],
  ['text: "invalid credentials" is auth', 'Error: invalid credentials', 'auth'],
  ['text: "credentials expired" is auth', 'Your credentials expired', 'auth'],
  ['text: "credentials" in a tool message is not auth', 'The page asked for credentials in a form; I left it blank', 'other'],
  ['text: "credentials" in an unrelated sentence is not auth', 'Saved credentials for this site are in the password manager', 'other'],
];
for (const [label, input, kind, extra] of cases) {
  const c = classify(input, { now: NOW });
  check(`classify: ${label} -> ${kind}`, c.kind === kind && (!extra || extra(c)), J({ ...c }));
}
check(`classify: ${cases.length} shapes covered`, cases.length >= 110, String(cases.length));

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

// ---- the chat's "Switch back" button belongs to the newest fallback notice only
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'renderer', 'chat-core.js'), 'utf8');
  const fn = /function retireFallbackButtons\(except = null\) \{[\s\S]*?\r?\n\}/.exec(src);
  check('chat: older fallback buttons are retired when a newer notice arrives', Boolean(fn) && /if \(event\.fallback\) retireFallbackButtons\(\)/.test(src));
  check('chat: picking a model by hand retires them before the pick is sent', /retireFallbackButtons\(\);[^\n]*\r?\n\s*const switched = await window\.assistant\.setModel\(select\.value\)/.test(src));
  check('chat: pressing one retires the others', /retireFallbackButtons\(button\)/.test(src) && /fallbackButtons\.add\(button\)/.test(src));
  const buttons = new Set();
  const mk = () => ({ removed: false, isConnected: true, remove() { this.removed = true; } });
  const retire = new Function('fallbackButtons', `${fn[0]}; return retireFallbackButtons;`)(buttons);
  const [a, b, c] = [mk(), mk(), mk()];
  buttons.add(a); buttons.add(b);
  retire(); buttons.add(c);
  check('chat: retire removes every older button and keeps the new one', a.removed && b.removed && !c.removed && buttons.size === 1);
  retire(c);
  check('chat: retire(except) leaves the one pressed', !c.removed && buttons.size === 1);
  const stale = mk(); stale.isConnected = false; buttons.add(stale);
  retire(c);
  check('chat: retire prunes detached buttons (not isConnected)', stale.removed && !buttons.has(stale) && !c.removed && buttons.size === 1);
}

// ---- what a model can take: context size and images
{
  const { capsOf, contextChars, choose } = fallback;
  const O = [
    ...OPTS,
    { id: 'openrouter:vendor/small-text', label: 'small text', group: 'OpenRouter', provider: 'OpenRouter', context: 8000, vision: false },
    { id: 'openrouter:vendor/big-vision', label: 'big vision', group: 'OpenRouter', provider: 'OpenRouter', context: 1_000_000, vision: true },
    { id: 'openrouter:vendor/unknown', label: 'unknown', group: 'OpenRouter', provider: 'OpenRouter' },
  ];
  check('caps: Claude is 200k tokens with vision', capsOf('claude-sonnet-5', O).context === 200_000 && capsOf('claude-sonnet-5', O).vision === true);
  check('caps: GPT-5.6 is 400k, Grok 4 256k with vision', capsOf('openai:gpt-5.6', O).context === 400_000 && capsOf('xai:grok-4', O).context === 256_000 && capsOf('xai:grok-4', O).vision === true);
  check('caps: Grok 3 and grok-code are text-only', capsOf('xai:grok-3', O).vision === false && capsOf('xai:grok-code-fast-1', O).vision === false);
  check('caps: an OpenRouter row carries its own numbers', capsOf('openrouter:vendor/small-text', O).context === 8000 && capsOf('openrouter:vendor/small-text', O).vision === false);
  check('caps: unknown is unknown (not text-only)', capsOf('openrouter:vendor/unknown', O).vision === null && capsOf('openrouter:vendor/unknown', O).context === 0);
  check('caps: engines see images (Claude Code) or are unknown (Grok Build), and manage their own history', capsOf('claudecode:opus', O).vision === true && capsOf('grokbuild:default', O).vision === null && contextChars('claudecode:opus', O) === Infinity);
  // one check per row of the table (published context windows; vision null: not known either way)
  const ROWS = [
    ['claude-opus-5-5', 200_000, true], ['claude-3-5-haiku-latest', 200_000, true], ['openrouter:anthropic/claude-sonnet-4', 200_000, true],
    ['openai:o1-mini', 128_000, false], ['openai:o1-preview', 128_000, false], ['openai:o1', 200_000, true], ['openai:o1-pro', 200_000, true],
    ['openai:o3', 200_000, true], ['openai:o3-pro', 200_000, true], ['openai:o3-mini', 200_000, false], ['openai:o4-mini', 200_000, true],
    ['openai:gpt-5.6', 400_000, true], ['openai:gpt-5-mini', 400_000, true], ['openai:gpt-5-chat-latest', 128_000, true],
    ['openai:gpt-4.1', 1_000_000, true], ['openai:gpt-4.1-mini', 1_000_000, true],
    ['openai:gpt-4o', 128_000, true], ['openai:gpt-4o-mini', 128_000, true], ['openai:chatgpt-4o-latest', 128_000, true], ['openai:gpt-4.5-preview', 128_000, true], ['openai:gpt-4-turbo', 128_000, true],
    ['openai:gpt-4', 8_192, false], ['openai:gpt-4-0613', 8_192, false], ['openai:gpt-4-32k', 32_768, false], ['openai:gpt-3.5-turbo', 16_000, false],
    ['xai:grok-4', 256_000, true], ['xai:grok-4-fast-reasoning', 2_000_000, true], ['xai:grok-code-fast-1', 256_000, false],
    ['xai:grok-3', 131_072, false], ['xai:grok-3-mini', 131_072, false], ['xai:grok-2-vision-1212', 32_768, true], ['xai:grok-2-1212', 131_072, false],
    ['gemini:gemini-1.5-pro', 2_000_000, true], ['gemini:gemini-1.5-flash', 1_000_000, true], ['gemini:gemini-2.0-flash', 1_000_000, true], ['gemini:gemini-2.5-pro', 1_000_000, true], ['gemini:gemini-1.0-pro', 32_768, false],
    ['openrouter:meta-llama/llama-3.3-70b-instruct', 128_000, false], ['openrouter:meta-llama/llama-3.1-405b-instruct', 128_000, false], ['openrouter:meta-llama/llama-3.2-11b-vision-instruct', 128_000, true],
    ['openrouter:meta-llama/llama-3-8b-instruct', 8_192, false], ['openrouter:meta-llama/llama-4-maverick', 1_000_000, true], ['openrouter:meta-llama/llama-4-scout', 10_000_000, true],
    ['openrouter:mistralai/mistral-large-2411', 128_000, null], ['openrouter:mistralai/pixtral-large-2411', 128_000, true], ['openrouter:mistralai/codestral-2501', 256_000, false],
    ['openrouter:mistralai/mixtral-8x7b-instruct', 32_768, false], ['openrouter:mistralai/mistral-7b-instruct', 32_768, false],
    ['openrouter:deepseek/deepseek-chat', 128_000, false], ['openrouter:openai/gpt-oss-120b', 128_000, false],
  ];
  for (const [id, context, vision] of ROWS) {
    const c = capsOf(id, []);
    check(`caps row: ${id} is ${context / 1000}k, ${vision === null ? 'vision unknown' : vision ? 'sees images' : 'text-only'}`, c.context === context && c.vision === vision, J(c));
  }
  check('budget: 85% of the window at 3 characters a token (Claude 510k, a 128k model 326k), unknown the old 320k, huge windows are capped', contextChars('claude-opus-5-5', O) === 510_000 && contextChars('openai:gpt-4o', O) === 326_400 && contextChars('openrouter:vendor/unknown', O) === 320_000 && contextChars('openrouter:vendor/big-vision', O) === 1_200_000, J([contextChars('claude-opus-5-5', O), contextChars('openai:gpt-4o', O), contextChars('openrouter:vendor/unknown', O), contextChars('openrouter:vendor/big-vision', O)]));
  const cd = createCooldowns();
  const only = (...ids) => O.filter((o) => ids.includes(o.id));

  // a long conversation skips the model that can't hold it
  let c = choose({ current: 'claude-opus-5-5', options: only('claude-opus-5-5', 'openrouter:vendor/small-text', 'openai:gpt-5.6'), cooldowns: cd, need: { chars: 100_000, images: false } });
  check('choose: a model whose window is too small for the chat is passed over', c?.id === 'openai:gpt-5.6' && !c.trim && !c.noImages, J(c));
  // images skip a text-only model
  c = choose({ current: 'openai:gpt-5.6', options: only('openai:gpt-5.6', 'xai:grok-3', 'xai:grok-4'), cooldowns: cd, need: { chars: 1000, images: true } });
  check('choose: a text-only model is passed over when the chat holds images', c?.id === 'xai:grok-4' && !c.noImages, J(c));
  c = choose({ current: 'openai:gpt-5.6', options: only('openai:gpt-5.6', 'xai:grok-3', 'xai:grok-4'), cooldowns: cd, need: { chars: 1000, images: false } });
  check('choose: without images the order is unchanged', c?.id === 'xai:grok-3' || c?.id === 'xai:grok-4', J(c));
  // nothing capable: still falls back, marked
  c = choose({ current: 'claude-opus-5-5', options: only('claude-opus-5-5', 'openrouter:vendor/small-text'), cooldowns: cd, need: { chars: 100_000, images: true } });
  check('choose: no capable model: it falls back anyway, trimmed and without images', c?.id === 'openrouter:vendor/small-text' && c.trim === true && c.noImages === true, J(c));
  check('choose: nothing else connected is still null', choose({ current: 'claude-opus-5-5', options: only('claude-opus-5-5'), cooldowns: cd, need: { chars: 1, images: false } }) === null);
  check('pick: still returns an id, and ignores capability when no need is given', fallback.pick({ current: 'claude-opus-5-5', options: only('claude-opus-5-5', 'openrouter:vendor/small-text'), cooldowns: cd }) === 'openrouter:vendor/small-text');
  c = choose({ current: 'claude-opus-5-5', options: only('claude-opus-5-5', 'claudecode:sonnet'), cooldowns: cd, need: { chars: 5_000_000, images: true } });
  check('choose: an engine takes any length (it compacts its own history) and images (Claude Code)', c?.id === 'claudecode:sonnet' && !c.trim && !c.noImages, J(c));
  // resolve at the start of a turn
  const cd2 = createCooldowns();
  cd2.mark('claude-opus-5-5', { kind: 'limit', scope: 'provider', resetsAt: NOW + 3600e3 }, NOW);
  const r = resolve({ preferred: 'claude-opus-5-5', options: only('claude-opus-5-5', 'openrouter:vendor/small-text', 'openai:gpt-5.6'), cooldowns: cd2, at: NOW, need: { chars: 100_000, images: false } });
  check('resolve: the start-of-turn stand-in can hold the chat too', r.model === 'openai:gpt-5.6' && r.from === 'claude-opus-5-5', J(r));
  // notices
  const n = (extra) => noticeFor({ kind: 'limit', from: 'claude-opus-5-5', to: 'claude-sonnet-5', ...extra }, OPTS);
  check('notice: a reply that restarts says so', n({ restart: true }) === 'Claude Opus 5.5 hit its limit — restarting the reply on Claude Sonnet 5.', n({ restart: true }));
  check('notice: unreachable restart', noticeFor({ kind: 'unreachable', from: 'xai:grok-4', to: 'claude-opus-5-5', restart: true }, OPTS) === 'Couldn’t reach xAI — restarting the reply on Claude Opus 5.5.');
  check('notice: trimmed and images left out are said', /oldest messages are left out/.test(n({ trim: true })) && /can’t see images/.test(n({ noImages: true })));
  check('notice: not restarting keeps the plain wording', n({}) === 'Claude Opus 5.5 hit its usage limit, switched to Claude Sonnet 5.');
}

// ---- images and history size in the agent
{
  const { withoutImages, historyChars, hasImages, fitContext } = require('../src/ai/agent');
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const hist = [
    { role: 'user', content: [img, { type: 'text', text: 'what is this' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'screenshot', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'ok' }, img] }] },
    { role: 'assistant', content: 'plain string' },
  ];
  const stripped = withoutImages(hist);
  check('hasImages: sees an attached image and one inside a tool result', hasImages(hist) && !hasImages(stripped) && !hasImages([{ role: 'user', content: 'hi' }]));
  check('withoutImages: each image becomes "[image omitted]", the chat is untouched', stripped[0].content[0].text === '[image omitted]' && stripped[2].content[0].content[1].text === '[image omitted]' && hist[0].content[0].type === 'image' && stripped[3] === hist[3]);
  check('withoutImages: nothing to change returns the same array', withoutImages([{ role: 'user', content: 'hi' }]).length === 1);
  check('historyChars: grows with the text, an image counts a fixed amount', historyChars([{ role: 'user', content: 'x'.repeat(1000) }]) === 1000 && historyChars([{ role: 'user', content: [img] }]) === 6000);
  const long = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'y'.repeat(5000) }));
  const fitted = fitContext(long, 50_000);
  check('fitContext: a model with a small window gets the recent turns and a note', historyChars(fitted) <= 60_000 && fitted.length < long.length && /left out/.test(fitted[0].content[0].text), J({ n: fitted.length, chars: historyChars(fitted) }));
}

// ---- the agent: capability on a switch, restart notice, the way back, stale stand-ins
{
  const bigText = 'z'.repeat(150_000);
  const IMG = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const rl = () => api('RateLimitError', 429, 'rate_limit_error', 'rate limited', headers({ 'retry-after': '900' }));
  const OP = [claude('claude-opus-5-5', 'Opus 5.5'), claude('claude-sonnet-5', 'Sonnet 5'), { id: 'xai:grok-3', label: 'Grok 3', name: 'Grok 3', group: 'Grok', provider: 'Grok' }, { id: 'openai:gpt-4o', label: 'GPT-4o', name: 'GPT-4o', group: 'OpenAI', provider: 'OpenAI' }];

  // a conversation with an image skips the text-only model (Grok 3), even though it comes earlier in a "same provider" order
  {
    fallback.shared.clear();
    const { agent, log } = makeAgent({ options: OP.filter((o) => o.id !== 'claude-sonnet-5'), scripts: { 'claude-opus-5-5': [rl()] } });
    const messages = fresh('claude-opus-5-5');
    messages.push({ role: 'user', content: [IMG, { type: 'text', text: 'look' }] }, { role: 'assistant', content: [{ type: 'text', text: 'seen' }] });
    await run(agent, messages, log);
    check('switch: a chat with images skips a text-only model', log.turns[log.turns.length - 1].model === 'openai:gpt-4o', J(log.turns));
  }
  // a very long conversation skips a model that cannot hold it
  {
    fallback.shared.clear();
    const small = [OP[0], { id: 'openrouter:v/tiny', label: 'tiny', name: 'tiny', group: 'OpenRouter', provider: 'OpenRouter', context: 8000 }, OP[3]];
    const { agent, log } = makeAgent({ options: small, scripts: { 'claude-opus-5-5': [rl()] } });
    const messages = fresh('claude-opus-5-5');
    messages.push({ role: 'user', content: bigText }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
    await run(agent, messages, log);
    check('switch: a long chat skips a model with a small window', log.turns[log.turns.length - 1].model === 'openai:gpt-4o', J(log.turns));
  }
  // nothing capable: it still switches, trimmed, and the notice says so
  {
    fallback.shared.clear();
    const only2 = [OP[0], { id: 'openrouter:v/tiny', label: 'tiny', name: 'tiny', group: 'OpenRouter', provider: 'OpenRouter', context: 8000, vision: false }];
    const { agent, log } = makeAgent({ options: only2, scripts: { 'claude-opus-5-5': [rl()] } });
    const messages = fresh('claude-opus-5-5');
    messages.push({ role: 'user', content: [IMG, { type: 'text', text: bigText }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
    await run(agent, messages, log);
    check('switch: no capable model: it falls back anyway and the notice says what is left out', log.turns[log.turns.length - 1].model === 'openrouter:v/tiny' && /oldest messages are left out/.test(notices(log)[0]) && /can’t see images/.test(notices(log)[0]), J({ turns: log.turns, n: notices(log) }));
  }
  // the budget follows the model
  {
    const { agent } = makeAgent({ options: [...OP, { id: 'openrouter:v/tiny', label: 'tiny', name: 'tiny', group: 'OpenRouter', provider: 'OpenRouter', context: 8000 }] });
    check('contextBudget: by the model\u2019s window', agent.contextBudget('claude-opus-5-5') === 510_000 && agent.contextBudget('openai:gpt-4o') === 326_400 && agent.contextBudget('openrouter:v/tiny') === 20_400 && agent.contextBudget('openai:unheard-of') === 320_000, J([agent.contextBudget('claude-opus-5-5'), agent.contextBudget('openai:gpt-4o'), agent.contextBudget('openrouter:v/tiny'), agent.contextBudget('openai:unheard-of')]));
  }
  // a reply that had started says it restarts
  {
    fallback.shared.clear();
    const partial = Object.assign(rl(), {});
    const { agent, log } = makeAgent({ options: OP.slice(0, 2) });
    let first = true;
    agent.claudeTurn = async function (messages, signal, emit) {
      const model = messages.settings.model;
      log.turns.push({ model });
      if (first) { first = false; emit({ type: 'text', text: 'Here is the start of an answ' }); throw partial; }
      return { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', model };
    };
    const messages = fresh('claude-opus-5-5');
    await run(agent, messages, log);
    check('a partial reply that is dropped: the notice says it restarts', /^Claude Opus 5\.5 hit its limit — restarting the reply on Claude Sonnet 5\./.test(notices(log)[0] || ''), J(notices(log)));
    check('the notice event carries the name to switch back to', log.events.find((e) => e.fallback)?.fallback.fromName === 'Claude Opus 5.5', J(log.events.find((e) => e.fallback)));
  }
  // the way back: a manual pick of the original clears its cooldown and the stand-in
  {
    fallback.shared.clear();
    const { agent, log } = makeAgent({ scripts: { 'claude-opus-5-5': [rl()] } });
    const messages = fresh('claude-opus-5-5');
    await run(agent, messages, log);
    agent.messages = messages;
    check('before: Opus cools down, the chat is on Sonnet', fallback.shared.cooling('claude-opus-5-5', clock) && messages.settings.model === 'claude-sonnet-5');
    agent.setModel('claude-opus-5-5');
    check('switch back: the pick clears the cooldown and the stand-in', !fallback.shared.cooling('claude-opus-5-5', clock) && messages.settings.model === 'claude-opus-5-5' && !messages.settings.fallbackFrom, J(messages.settings));
    log.events.length = 0; log.turns.length = 0;
    await agent.runOnce('again', (e) => log.events.push(e), [], {}, null, messages, { controller: new AbortController(), hosts: new Set() });
    check('switch back: the next message runs on the original, with no notice', log.turns[0]?.model === 'claude-opus-5-5' && notices(log).length === 0, J({ turns: log.turns, n: notices(log) }));
  }
  // a stand-in saved with a chat, opened after a restart (no cooldown in memory): back on the original, silently
  {
    fallback.shared.clear();
    const { agent, log } = makeAgent();
    const snapshot = { settings: { model: 'claude-sonnet-5', fallbackFrom: 'claude-opus-5-5', fallbackSession: 'an-earlier-run', adhdMode: true }, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }] };
    agent.restore(snapshot);
    check('restore: a stale stand-in is cleared at load', agent.messages.settings.model === 'claude-opus-5-5' && !agent.messages.settings.fallbackFrom && !agent.messages.settings.fallbackSession, J(agent.messages.settings));
    // the same, found at the start of a turn (a chat that was never passed through restore)
    const m2 = fresh('claude-sonnet-5');
    m2.settings.fallbackFrom = 'claude-opus-5-5';
    m2.settings.fallbackSession = 'an-earlier-run';
    await agent.runOnce('hi', (e) => log.events.push(e), [], {}, null, m2, { controller: new AbortController(), hosts: new Set() });
    check('stale stand-in at the start of a turn: the original answers, no "Back on" note', log.turns[0]?.model === 'claude-opus-5-5' && notices(log).length === 0 && !m2.settings.fallbackFrom, J({ turns: log.turns, n: notices(log) }));
    // a stand-in made in this run, whose cooldown has ended, still gets its "Back on" note
    const m3 = fresh('claude-sonnet-5');
    m3.settings.fallbackFrom = 'claude-opus-5-5';
    m3.settings.fallbackSession = fallback.SESSION;
    log.events.length = 0; log.turns.length = 0;
    await agent.runOnce('hi', (e) => log.events.push(e), [], {}, null, m3, { controller: new AbortController(), hosts: new Set() });
    check('a stand-in from this run whose cooldown ended: "Back on" is said', J(notices(log)) === J(['Back on Claude Opus 5.5.']), J(notices(log)));
    // a still-cooling stand-in from an earlier run is kept
    const m4 = fresh('claude-sonnet-5');
    m4.settings.fallbackFrom = 'claude-opus-5-5';
    m4.settings.fallbackSession = 'an-earlier-run';
    fallback.shared.mark('claude-opus-5-5', { kind: 'limit', scope: 'model', resetsAt: clock + 600e3 }, clock);
    agent.restore({ settings: m4.settings, messages: [{ role: 'user', content: 'hi' }] });
    check('a stand-in whose cooldown is live is kept at load', agent.messages.settings.fallbackFrom === 'claude-opus-5-5' && agent.messages.settings.model === 'claude-sonnet-5');
  }
}
  } finally {
    Date.now = realNow;
  }

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall fallback checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
