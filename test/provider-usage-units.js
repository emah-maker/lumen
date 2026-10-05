// Usage and settings parity for every AI (pure node: no window, no network, no real CLI):
//  - rate-limit response headers (OpenAI / xAI / OpenRouter x-ratelimit-*, Anthropic anthropic-ratelimit-*), merged and aged out;
//  - Antigravity's quota text ("Resets in 110h") and Grok's plan-limit message, with the reset time;
//  - per-provider totals Lumen counted (today, 7 days, per day, per model, last use) and the price estimate of an API turn;
//  - the usage log taking API and Antigravity turns, a budget per provider, the bars and the status card;
//  - reasoning effort per AI: validation, the flag or request field each engine gets.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const PU = require('../src/features/provider-usage');
const effort = require('../src/ai/effort');
const usageLib = require('../src/features/usage');
const AS = require('../src/features/aistatus-view');
const grokLimit = require('../src/features/grok-limit');
const settingsBackend = require('../src/settings/settings-backend');

module.exports = async function providerUsageUnits(check) {
  const NOW = new Date(2026, 9, 4, 12, 0, 0).getTime();
  const H = 3600e3;

  // ---- durations and headers
  check('duration: "6m0s", "20ms", "1h2m3.5s", plain seconds, junk', PU.parseDuration('6m0s') === 360000 && PU.parseDuration('20ms') === 20 && PU.parseDuration('1h2m3.5s') === 3723500 && PU.parseDuration('45') === 45000 && PU.parseDuration('soon') === null && PU.parseDuration('') === null);
  const oa = PU.parseRateLimitHeaders('openai', { 'x-ratelimit-limit-requests': '500', 'x-ratelimit-remaining-requests': '450', 'x-ratelimit-reset-requests': '1s', 'x-ratelimit-limit-tokens': '30000', 'x-ratelimit-remaining-tokens': '3000', 'x-ratelimit-reset-tokens': '6m0s' }, NOW);
  const req = oa.buckets.find((b) => b.kind === 'requests');
  const tok = oa.buckets.find((b) => b.kind === 'tokens');
  check('openai headers: requests and tokens with percent used and reset time', req.percent === 10 && req.resetsAt === NOW + 1000 && tok.percent === 90 && tok.resetsAt === NOW + 360000 && tok.remaining === 3000, JSON.stringify(oa));
  const headers = new Map([['x-ratelimit-limit-requests', '60'], ['x-ratelimit-remaining-requests', '60'], ['x-ratelimit-reset-requests', '30s']]);
  check('xai / openrouter headers: a Headers-like object with get() reads the same names', PU.parseRateLimitHeaders('xai', { get: (n) => headers.get(n) ?? null }, NOW).buckets[0].percent === 0 && PU.parseRateLimitHeaders('openrouter', { get: (n) => headers.get(n) ?? null }, NOW).buckets.length === 1);
  const an = PU.parseRateLimitHeaders('anthropic', {
    'anthropic-ratelimit-requests-limit': '50', 'anthropic-ratelimit-requests-remaining': '49', 'anthropic-ratelimit-requests-reset': '2026-10-04T16:00:30Z',
    'anthropic-ratelimit-input-tokens-limit': '40000', 'anthropic-ratelimit-input-tokens-remaining': '10000', 'anthropic-ratelimit-input-tokens-reset': '2026-10-04T16:01:00Z',
    'anthropic-ratelimit-output-tokens-limit': '8000', 'anthropic-ratelimit-output-tokens-remaining': '8000',
  }, NOW);
  const inp = an.buckets.find((b) => b.kind === 'inputTokens');
  check('anthropic headers: requests, input and output tokens; reset is an RFC 3339 time', an.buckets.length === 3 && inp.percent === 75 && inp.resetsAt === Date.parse('2026-10-04T16:01:00Z') && an.buckets.find((b) => b.kind === 'requests').percent === 2, JSON.stringify(an));
  check('headers: none, zero limits and non-numbers give nothing; a retry-after alone is kept', PU.parseRateLimitHeaders('openai', {}, NOW) === null && PU.parseRateLimitHeaders('gemini', { 'content-type': 'x' }, NOW) === null && PU.parseRateLimitHeaders('openai', { 'x-ratelimit-limit-requests': '0', 'x-ratelimit-remaining-requests': '0' }, NOW) === null && PU.parseRateLimitHeaders('openai', { 'retry-after': '20' }, NOW).retryAfter === 20000);
  // merged readings and ageing
  const merged = PU.mergeRate(oa, { provider: 'openai', at: NOW + 1000, buckets: [{ kind: 'requests', limit: 500, remaining: 100, resetsAt: NOW + 2000, percent: 80 }] });
  check('rate merge: the newest reading wins per bucket, the others stay', merged.buckets.length === 2 && merged.buckets.find((b) => b.kind === 'requests').percent === 80 && merged.buckets.find((b) => b.kind === 'tokens').percent === 90);
  const view = PU.rateView(merged, NOW + 10 * 1000);
  check('rate view: a bucket past its reset is expired and not "tightest"', view.buckets.find((b) => b.kind === 'requests').expired && view.tightest.kind === 'tokens' && PU.rateView(null, NOW) === null);

  // ---- Antigravity quota text, Grok plan limit
  const agy = PU.antigravityLimit('RESOURCE_EXHAUSTED: Quota exceeded for gemini-3.1-pro (high). Resets in 110h', NOW);
  check('antigravity quota: "Resets in 110h" gives the reset time and the model', agy && Math.abs(agy.resetsAt - (NOW + 110 * H)) < 1000 && /gemini-3\.1-pro/.test(agy.model), JSON.stringify(agy));
  check('antigravity quota: days, hours and minutes; credits; and text that is no limit', Math.abs(PU.antigravityLimit('Quota will reset in 2d 3h 30m', NOW).resetsAt - (NOW + (51.5 * H))) < 1000 && PU.antigravityLimit('You are out of credits', NOW).resetsAt === null && PU.antigravityLimit('Hello there', NOW) === null && PU.antigravityLimit('', NOW) === null);
  const g = grokLimit.limitOf("You've hit your usage limit. Resets at 3:40pm.", NOW);
  const g2 = grokLimit.limitOf('Usage limit reached. Try again in 2h 10m.', NOW);
  check('grok plan limit: a clock time and a relative time both give a reset', g && g.resetsAt > NOW && g.resetsAt <= NOW + 24 * H && Math.abs(g2.resetsAt - (NOW + 130 * 60e3)) < 1000 && grokLimit.limitOf('Something else broke', NOW) === null, JSON.stringify([g, g2]));

  // ---- what Lumen counted
  const day = (n, h = 10) => new Date(2026, 9, 4 - n, h, 0, 0).getTime();
  const rec = (at, engine, model, tokens, cost, extra = {}) => ({ at, engine, model, inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: cost, ...extra });
  const records = [rec(day(0), 'openai', 'openai:gpt-5.6', 1000, 0.02), rec(day(0, 11), 'openai', 'openai:gpt-5.6', 500, 0, { unpriced: true }), rec(day(2), 'openai', 'openai:gpt-5.6-mini', 3000, 0.01), rec(day(9), 'openai', 'x', 99, 1), rec(day(1), 'antigravity', 'gemini-3.1-pro', 700, 0, { unpriced: true }), rec(day(0), 'claudecode', 'sonnet', 10, 0.5)];
  const tot = PU.totalsByProvider(records, NOW);
  check('totals: today, 7 days (the 9-day-old turn is out), per day, per model, last use', tot.openai.today.turns === 2 && tot.openai.today.tokens === 1500 && tot.openai.week.turns === 3 && tot.openai.week.tokens === 4500 && tot.openai.days.length === 7 && tot.openai.days[6].turns === 2 && tot.openai.days[4].turns === 1 && tot.openai.models[0].model === 'openai:gpt-5.6-mini' && tot.openai.lastModel === 'openai:gpt-5.6' && tot.openai.week.unpriced === 1, JSON.stringify(tot.openai));
  check('totals: each provider apart, none for a provider never used', tot.antigravity.week.tokens === 700 && tot.claudecode.week.costUSD === 0.5 && !tot.gemini);
  // price estimates
  const t1 = PU.turnUsage('claude-opus-5-5', { input_tokens: 1000000, output_tokens: 100000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  check('turn usage: an Anthropic message is priced from the table (4 + 2 dollars)', Math.abs(t1.costUSD - 6) < 1e-9 && t1.inputTokens === 1000000 && t1.models[0] === 'claude-opus-5-5', JSON.stringify(t1));
  const t2 = PU.turnUsage('xai:grok-4', { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 200 } });
  check('turn usage: a Chat Completions chunk, cached tokens split out, grok-4 from the table', t2.inputTokens === 800 && t2.cacheReadTokens === 200 && t2.costUSD > 0, JSON.stringify(t2));
  check('turn usage: OpenRouter\'s own cost wins; an unknown model has no price (null), never a guess; no usage gives null', PU.turnUsage('openrouter:x/y', { prompt_tokens: 10, completion_tokens: 1, cost: 0.0042 }).costUSD === 0.0042 && PU.turnUsage('openai:gpt-9', { prompt_tokens: 10, completion_tokens: 1 }).costUSD === null && PU.turnUsage('m', null) === null);
  check('providers: every AI is listed once with its plan data kind', PU.KEYS.length === 9 && new Set(PU.KEYS).size === 9 && /not available from OpenAI/.test(PU.noPlanText('openai')) && PU.noPlanText('claudecode') === '' && /Resets in 110h/.test(PU.noPlanText('antigravity')));

  // ---- the usage log
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-pu-'));
  let clockNow = NOW;
  const usage = usageLib.createUsage({ app: { getPath: () => dir, on: () => {} }, now: () => clockNow, otherActivity: async () => false, claudeBin: async () => null });
  const apiTurn = (tokens, costUSD) => ({ usage: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD, models: ['openai:gpt-5.6'] }, model: 'openai:gpt-5.6' });
  usage.record('openai', { ...apiTurn(1000, 0.02), rate: oa });
  usage.record('openai', apiTurn(500, null));
  usage.record('antigravity', { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: null, models: ['gemini-3.1-pro'] }, model: 'gemini-3.1-pro', ok: true });
  let s = await usage.summary({ cached: true });
  check('usage log: an API turn is kept per provider with its estimated cost; an unpriced turn is flagged', s.providers.openai.week.turns === 2 && Math.abs(s.providers.openai.week.costUSD - 0.02) < 1e-9 && s.providers.openai.week.unpriced === 1 && s.lumen.byEngine.openai.turns === 2, JSON.stringify(s.providers.openai));
  check('usage log: the rate-limit headers of a reply are kept per provider and shown with the tightest bucket', s.rate.openai.tightest.kind === 'tokens' && Math.round(s.rate.openai.tightest.percent) === 90 && !s.rate.anthropic, JSON.stringify(s.rate));
  check('usage log: Antigravity turns count (tokens, no price) and its summary carries the explanation of missing plan numbers', s.providers.antigravity.week.tokens === 12 && /Resets in 110h/.test(s.notes.antigravity) && !s.notes.claudecode);
  check('bars: an API provider with no budget and no limit has no plan bar; context-only bars show tokens and the rate reading', s.bars.openai.kind === 'context' && s.bars.openai.tokens === 1500 && s.bars.openai.rate.label === 'Tokens per minute' && s.bars.gemini === null && s.bars.antigravity.tokens === 12, JSON.stringify([s.bars.openai, s.bars.gemini]));
  // Antigravity's quota message
  usage.record('antigravity', { limit: { text: 'Quota exceeded. Resets in 110h', resetsAt: NOW + 110 * H, model: 'gemini-3.1-pro' }, ok: false });
  s = await usage.summary({ cached: true });
  check('antigravity limit: the bar is "limit" with the reset time and the model; the status card says it', s.bars.antigravity.kind === 'limit' && s.bars.antigravity.resetsAt === NOW + 110 * H && s.limits.antigravity.model === 'gemini-3.1-pro');
  const card = AS.shape({ apis: ['openai'], engines: { antigravity: { installed: true, signedIn: 'unknown', enabled: true } }, agyLimit: usage.glance(NOW).agyLimit, today: usage.glance(NOW).today, rate: { openai: { percent: 90, label: 'Tokens per minute', resetsAt: NOW + 3e5 } }, effort: { openai: 'low' } }, NOW);
  const agyRow = card.ais.find((a) => a.id === 'antigravity');
  const oaRow = card.ais.find((a) => a.id === 'openai');
  check('status card: Antigravity at its limit with the reset day; an API row shows tokens, a tight rate limit and the effort chosen', agyRow.state === 'limited' && /Resets/.test(agyRow.note) && /\$0\.02 today/.test(oaRow.note) && /Tokens per minute 90% used/.test(oaRow.note) && /Effort: low/.test(oaRow.note), JSON.stringify([agyRow.note, oaRow.note]));
  usage.record('antigravity', { usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: null, models: [] }, ok: true });
  s = await usage.summary({ cached: true });
  check('antigravity limit: the next turn that works clears it', !s.limits.antigravity && s.bars.antigravity.kind !== 'limit');
  // budgets per provider
  usage.setBudget({ unit: 'tokens', daily: 2000, weekly: 0 }, 'openai');
  check('budget: set per provider (Grok\'s stays apart), saved normalised, unknown providers refused', usage.budget('openai').daily === 2000 && usage.budget('grokbuild').daily === 0 && usage.setBudget({ daily: 5 }, 'nope') === null);
  const n1 = usage.record('openai', apiTurn(600, 0));
  s = await usage.summary({ cached: true });
  check('budget: 1500 + 600 of 2000 tokens is 105%: one notice naming the provider, a budget bar, and no second notice', /reached your daily OpenAI budget/.test(n1?.notice || '') && s.bars.openai.kind === 'budget' && Math.round(s.bars.openai.percent) === 100 && usage.record('openai', apiTurn(1, 0)) === null, JSON.stringify([n1, s.bars.openai]));
  const nb = usageLib.budgetStatus(records, { unit: 'usd', daily: 0.04, weekly: 0 }, NOW, 'openai');
  check('budget status: counts only that provider\'s turns today', nb.periods[0].used === 0.02 && Math.round(nb.periods[0].percent) === 50);
  await new Promise((r) => setTimeout(r, 700)); // saved half a second after a change
  const again = usageLib.createUsage({ app: { getPath: () => dir, on: () => {} }, now: () => clockNow, claudeBin: async () => null });
  again.load();
  const s2 = await again.summary({ cached: true });
  check('usage log: records, rate readings and budgets survive a restart', s2.providers.openai.week.turns === 4 && s2.rate.openai && again.budget('openai').daily === 2000, JSON.stringify([s2.providers.openai.week, s2.rate]));
  clockNow = NOW + 6 * 60e3;
  const s3 = await again.summary({ cached: true });
  check('rate readings age out by their own reset time (nothing stale is shown as current)', !s3.rate.openai || s3.rate.openai.buckets.every((b) => b.expired === (b.resetsAt <= clockNow)));
  again.clear();
  check('clear: forgets the counts and the rate readings', Object.keys((await again.summary({ cached: true })).providers).length === 0 && !Object.keys((await again.summary({ cached: true })).rate).length);
  fs.rmSync(dir, { recursive: true, force: true });

  // ---- effort
  check('effort: levels are per AI; a value that is not one of them is cleaned away', effort.clean('openai', 'HIGH') === 'high' && effort.clean('openai', 'max') === '' && effort.clean('claudecode', 'max') === 'max' && effort.clean('nope', 'low') === '' && effort.clean('xai', 'medium') === '');
  check('effort: the whole setting keeps only valid entries, drops the rest, refuses non-objects', JSON.stringify(effort.cleanAll({ openai: 'low', codex: 'bogus', nope: 'high', gemini: '' })) === '{"openai":"low"}' && effort.cleanAll('x') === null && effort.cleanAll([]) === null && JSON.stringify(effort.cleanAll({})) === '{}');
  check('settings: aiEffort is validated by the settings backend; the model-menu switches are plain booleans', JSON.stringify(settingsBackend.validate('aiEffort', { claudecode: 'xhigh', openai: 'zzz' })) === '{"claudecode":"xhigh"}' && settingsBackend.validate('aiEffort', 5) === null && settingsBackend.validate('claudeCodeSidebar', false) === false && settingsBackend.validate('grokSidebar', 'yes') === null && settingsBackend.DEFAULTS.claudeCodeSidebar === true && settingsBackend.DEFAULTS.grokSidebar === false);
  check('effort: CLI flags (checked against --help): claude --effort, grok --reasoning-effort, agy --effort, codex -c model_reasoning_effort', JSON.stringify(effort.cliArgs('claudecode', 'high')) === '["--effort","high"]' && JSON.stringify(effort.cliArgs('grokbuild', 'low')) === '["--reasoning-effort","low"]' && JSON.stringify(effort.cliArgs('antigravity', 'xhigh')) === '["--effort","xhigh"]' && JSON.stringify(effort.cliArgs('codex', 'max')) === '["-c","model_reasoning_effort=max"]' && effort.cliArgs('codex', '').length === 0 && effort.cliArgs('openai', 'low').length === 0);
  check('effort: API fields only for the models that take them', JSON.stringify(effort.chatParams('openai', 'gpt-5.6', 'low')) === '{"reasoning_effort":"low"}' && JSON.stringify(effort.chatParams('openai', 'gpt-4o', 'low')) === '{}' && JSON.stringify(effort.chatParams('xai', 'grok-3-mini', 'high')) === '{"reasoning_effort":"high"}' && JSON.stringify(effort.chatParams('xai', 'grok-4', 'high')) === '{}' && JSON.stringify(effort.chatParams('gemini', 'gemini-2.5-pro', 'medium')) === '{"reasoning_effort":"medium"}' && JSON.stringify(effort.chatParams('gemini', 'gemini-1.5-pro', 'medium')) === '{}' && JSON.stringify(effort.chatParams('openrouter', 'a/b', 'low')) === '{"reasoning":{"effort":"low"}}' && JSON.stringify(effort.chatParams('openai', 'gpt-5.6', '')) === '{}');
  check('effort: Anthropic only for a model that already carries one', effort.anthropicEffort('low', true) === 'low' && effort.anthropicEffort('low', false) === null && effort.anthropicEffort('', true) === null);
  const cc = require('../src/ai/claude-code');
  const base = { mcpConfig: 'm.json', sessionId: 's', systemPrompt: 'x' };
  check('claude code: --effort only when chosen, and a different effort is a different process key', !cc.buildArgs(base).includes('--effort') && cc.buildArgs({ ...base, effort: 'high' }).join(' ').includes('--effort high') && cc.procKey({ bin: 'b', sessionId: 's', systemPrompt: 'x', effort: 'low' }) !== cc.procKey({ bin: 'b', sessionId: 's', systemPrompt: 'x', effort: 'high' }) && cc.procKey({ bin: 'b', sessionId: 's', systemPrompt: 'x' }) === cc.procKey({ bin: 'b', sessionId: 's', systemPrompt: 'x', effort: '' }));
  const gb = require('../src/ai/grok-build');
  const gbArgs = gb.buildArgs({ promptFile: 'p', sessionId: 's', systemPrompt: 'x', cwd: 'c', effort: 'medium' });
  check('grok build: --reasoning-effort only when chosen', gbArgs.join(' ').includes('--reasoning-effort medium') && !gb.buildArgs({ promptFile: 'p', sessionId: 's', systemPrompt: 'x', cwd: 'c' }).includes('--reasoning-effort'));
  check('grok build: who `grok models` says is signed in', gb.grokAccountOf('You are logged in with grok.com.\n\nDefault model: grok-4.7') === 'grok.com' && gb.grokAccountOf('You are using XAI_API_KEY.') === 'XAI_API_KEY' && gb.grokAccountOf('Not logged in') === null);
  const cx = require('../src/ai/codex');
  check('codex: -c model_reasoning_effort goes before the resume subcommand and the "-" prompt', (() => { const a = cx.buildArgs({ model: 'gpt-6-luna', conversation: '0199aaaa-bbbb-cccc-dddd-eeeeeeeeeeee', effort: 'high' }); return a.indexOf('-c') > -1 && a.indexOf('-c') < a.indexOf('resume') && a[a.indexOf('-c') + 1] === 'model_reasoning_effort=high' && a[a.length - 1] === '-'; })() && !cx.buildArgs({}).includes('-c'));
  const ag = require('../src/ai/antigravity');
  check('antigravity: --effort only when chosen, and the sandbox flag stays', ag.buildArgs({ prompt: 'hi', effort: 'low' }).join(' ').includes('--effort low') && !ag.buildArgs({ prompt: 'hi' }).includes('--effort') && ag.buildArgs({ prompt: 'hi', effort: 'low' }).includes('--sandbox'));
  check('antigravity: a failed run\'s quota text becomes a plan limit with its reset time', (() => { const l = PU.antigravityLimit(ag.describeFailure('RESOURCE_EXHAUSTED: quota exceeded. Resets in 110h', 1).text, NOW); return l && l.resetsAt > NOW + 100 * H; })());

  // ---- API requests: effort and rate headers ride the one request
  const providers = require('../src/ai/providers');
  let sent = null;
  const chunk = (o) => o;
  const fakeClient = (hdrs) => ({ chat: { completions: { create: (body) => { sent = body; const p = Promise.resolve((async function* () { yield chunk({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }); yield chunk({ usage: { prompt_tokens: 10, completion_tokens: 2 } }); })()); p.withResponse = async () => ({ data: await p, response: { headers: hdrs } }); return p; } } } });
  const out = await providers.streamTurn({ provider: 'openai', model: 'gpt-5.6', apiKey: 'k', system: 's', messages: [{ role: 'user', content: 'x' }], tools: [], signal: new AbortController().signal, emit: () => {}, client: fakeClient({ get: (n) => ({ 'x-ratelimit-limit-requests': '10', 'x-ratelimit-remaining-requests': '5', 'x-ratelimit-reset-requests': '2s' })[n] ?? null }), effort: 'low' });
  check('openai request: reasoning_effort is in the body and the response headers came back as a rate reading (no second request)', sent.reasoning_effort === 'low' && out.rate.buckets[0].percent === 50 && out.usage.prompt_tokens === 10, JSON.stringify([sent.reasoning_effort, out.rate]));
  const plain = { chat: { completions: { create: async () => (async function* () { yield chunk({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }); })() } } };
  const out2 = await providers.streamTurn({ provider: 'gemini', model: 'gemini-2.5-pro', apiKey: 'k', system: 's', messages: [{ role: 'user', content: 'x' }], tools: [], signal: new AbortController().signal, emit: () => {}, client: plain });
  check('a client without withResponse (a test fake) still works and reports no rate', out2.rate === undefined && out2.content[0].text === 'ok');
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); if (!ok) failed++; })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
