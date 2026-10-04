// A provider's own Auto ("Grok Build · Auto", "OpenAI · Auto", docs/auto-model.md), plain Node: no Electron, no network, no CLI.
// Covers: the ids and how every place that parses a model id reads them, the router limited to one provider (fast vs strong pick,
// out-of-usage models skipped, one model only, /think and /fast hints, what the "Auto may use" settings do), the picker rows, the
// agent turn (the pick is kept, the concrete model runs, escalation stays inside the provider, nothing left falls back like a
// picked model), the warm processes (a pick that is not routed yet asks for no model; another model is another process) and the
// background-task model list.
const { Agent } = require('../src/ai/agent');
const fallback = require('../src/ai/fallback');
const A = require('../src/ai/auto-model');
const providers = require('../src/ai/providers');
const claude = require('../src/ai/claude-code');
const grok = require('../src/ai/grok-build');
const bgAgents = require('../src/features/background-agents');
const TC = require('../src/features/tab-chats');
const { engineModel } = require('../src/ai/cli-utils');
const { claudeCodeOptions, grokBuildOptions, antigravityOptions } = require('../src/features/ai-agents');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const J = JSON.stringify;
const HEAVY = ['Refactor the checkout flow across the codebase and debug why the cart total is wrong after a coupon is applied.', '1. Investigate the root cause in cart.js and pricing.js', '2. Design a fix that handles concurrent updates', '3. Write tests, then migrate the old orders', '4. Also make sure the API docs stay accurate'].join('\n');
const QUICK = { prompt: 'what time is it in Tokyo' };

// ---- the picker's options, as main.js builds them
const claudeApi = [{ id: 'claude-opus-5-5', label: 'Opus 5.5', name: 'Opus 5.5', provider: 'Claude', group: 'Claude' }, { id: 'claude-sonnet-5', label: 'Sonnet 5', name: 'Sonnet 5', provider: 'Claude', group: 'Claude' }, { id: 'claude-haiku-4-5', label: 'Haiku 4.5', name: 'Haiku 4.5', provider: 'Claude', group: 'Claude' }];
const openai = [{ id: 'openai:gpt-5.6', label: 'GPT-5.6', name: 'GPT-5.6', provider: 'OpenAI', group: 'OpenAI' }, { id: 'openai:gpt-5.6-mini', label: 'GPT-5.6 mini', name: 'GPT-5.6 mini', provider: 'OpenAI', group: 'OpenAI' }];
const xai = [{ id: 'xai:grok-4', label: 'Grok 4', name: 'Grok 4', provider: 'Grok', group: 'Grok' }];
const gemini = [{ id: 'gemini:gemini-2.5-pro', label: 'Gemini 2.5 Pro', name: 'Gemini 2.5 Pro', provider: 'Gemini', group: 'Gemini' }, { id: 'gemini:gemini-2.5-flash', label: 'Gemini 2.5 Flash', name: 'Gemini 2.5 Flash', provider: 'Gemini', group: 'Gemini' }];
const openrouter = [{ id: 'openrouter:anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'OpenRouter', group: 'OpenRouter' }, { id: 'openrouter:google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'OpenRouter', group: 'OpenRouter' }, { id: 'openrouter:openai/gpt-5.6', label: 'GPT-5.6', provider: 'OpenRouter', group: 'OpenRouter' }, { id: 'openrouter:__more', label: 'More models…', provider: 'OpenRouter', group: 'OpenRouter', more: true }];
const cc = claudeCodeOptions({ signedIn: true });
const gb = grokBuildOptions({ signedIn: true, models: ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6'] });
const ag = antigravityOptions({ signedIn: true, models: ['gemini-3.1-pro-high', 'gemini-3-flash'], names: {} });
const ALL = [...claudeApi, ...gemini, ...openai, ...openrouter, ...xai, ...cc, ...gb, ...ag];
const scoped = (scope, options, request, extra = {}) => A.route({ options, request, scope, ...extra });
const providerOf = fallback.providerOf;

// ---- 1) ids
check('scopeOf: the global pick is null, a provider pick is its key, anything else is undefined', A.scopeOf('auto') === null && A.scopeOf('grokbuild:auto') === 'grokbuild' && A.scopeOf('claudecode:auto') === 'claudecode' && A.scopeOf('openai:auto') === 'openai' && A.scopeOf('xai:auto') === 'xai' && A.scopeOf('gemini:auto') === 'gemini' && A.scopeOf('openrouter:auto') === 'openrouter' && A.scopeOf('anthropic:auto') === 'anthropic' && A.scopeOf('antigravity:auto') === 'antigravity', 'ids');
check('scopeOf: a model is never an Auto pick', ['claudecode:default', 'grokbuild:grok-4.7', 'openai:gpt-5.6', 'openrouter:openrouter/auto', 'claude-opus-5-5', 'nope:auto', 'auto:auto', '', null, undefined].every((id) => A.scopeOf(id) === undefined), 'ids');
check('isAuto: true for both kinds of pick', A.isAuto('auto') && A.isAuto('grokbuild:auto') && !A.isAuto('grokbuild:default') && !A.isAuto('openai:gpt-5.6'));
check('autoIdOf / scopeName round-trip', A.SCOPES.every((s) => A.scopeOf(A.autoIdOf(s)) === s && A.scopeName(s).length > 0) && A.autoIdOf(null) === 'auto', J(A.SCOPES));
check('engineModel: an engine\'s Auto asks the CLI for no model (never "auto" after --model)', engineModel('grokbuild:auto') === 'default' && engineModel('claudecode:auto') === 'default' && engineModel('antigravity:auto') === 'default' && engineModel('claudecode:opus') === 'opus' && engineModel('grokbuild:grok-4.7') === 'grok-4.7');
check('argv: an engine\'s Auto picked and not yet routed puts no --model on the command line', !claude.buildArgs({ mcpConfig: 'm', sessionId: 's', resume: false, systemPrompt: 'p', model: engineModel('claudecode:auto') }).includes('--model') && !grok.buildArgs({ promptFile: 'f', sessionId: 's', resume: false, systemPrompt: 'p', cwd: 'c', model: engineModel('grokbuild:auto') }).includes('--model'));
check('slotKind: an engine\'s Auto is a CLI chat, an API provider\'s Auto an API chat', TC.slotKind('claudecode:auto') === 'cli' && TC.slotKind('grokbuild:auto') === 'cli' && TC.slotKind('antigravity:auto') === 'cli' && TC.slotKind('openai:auto') === 'api' && TC.slotKind('anthropic:auto') === 'api' && TC.slotKind('auto') === 'api');
check('providerOf: a provider\'s Auto belongs to that provider', ['anthropic', 'claudecode', 'grokbuild', 'antigravity', 'openai', 'xai', 'gemini', 'openrouter'].every((p) => providerOf(`${p}:auto`) === p) && fallback.isEngine('grokbuild:auto') && !fallback.isEngine('openai:auto'));
check('fallback.resolve: a provider\'s Auto is never "unavailable" (it is chosen per message)', ['auto', 'openai:auto', 'grokbuild:auto'].every((id) => { const c = fallback.createCooldowns(); c.mark(id, { kind: 'limit', scope: 'model', resetsAt: Date.now() + 600000 }); return fallback.resolve({ preferred: id, options: ALL, cooldowns: c }).from === null; }));
check('providers.splitModel still reads the id by its provider (the pick is never sent to an API)', providers.splitModel('openai:auto').provider === 'openai' && providers.splitModel('xai:auto').provider === 'xai' && providers.splitModel('anthropic:auto').provider === 'anthropic');
check('background tasks: engineOfModel reads an engine\'s Auto as that engine', bgAgents.engineOfModel('claudecode:auto') === 'claudecode' && bgAgents.engineOfModel('grokbuild:auto') === 'grokbuild' && bgAgents.engineOfModel('openai:auto') === 'api' && bgAgents.isCliModel('grokbuild:auto'));

// ---- 2) the router, per provider: a quick message goes to the small model, a hard one to a strong one
const only = (id, options, request) => { const d = scoped(id, options, request); return d.id; };
check('Claude Code Auto: quick -> haiku, typical -> sonnet, hard -> opus or fable', only('claudecode', ALL, QUICK) === 'claudecode:haiku' && only('claudecode', ALL, { prompt: 'find the cheapest flight from Boston to Denver next month on this site' }) === 'claudecode:sonnet' && ['claudecode:opus', 'claudecode:fable'].includes(only('claudecode', ALL, { prompt: HEAVY })));
check('Claude Code Auto never picks its own default while it lists models', !['claudecode:default'].includes(only('claudecode', ALL, QUICK)));
check('Grok Build Auto: quick -> the fast build model, hard -> a strong grok', only('grokbuild', ALL, QUICK) === 'grokbuild:grok-4.7-build-fast' && /^grokbuild:grok-4\.[67]$/.test(only('grokbuild', ALL, { prompt: HEAVY })), J([only('grokbuild', ALL, QUICK), only('grokbuild', ALL, { prompt: HEAVY })]));
check('Antigravity Auto: quick -> flash, hard -> pro', only('antigravity', ALL, QUICK) === 'antigravity:gemini-3-flash' && only('antigravity', ALL, { prompt: HEAVY }) === 'antigravity:gemini-3.1-pro-high');
check('Anthropic (Claude API) Auto: quick -> Haiku, hard -> Opus', only('anthropic', ALL, QUICK) === 'claude-haiku-4-5' && only('anthropic', ALL, { prompt: HEAVY }) === 'claude-opus-5-5');
check('OpenAI Auto: quick -> mini, hard -> the flagship', only('openai', ALL, QUICK) === 'openai:gpt-5.6-mini' && only('openai', ALL, { prompt: HEAVY }) === 'openai:gpt-5.6');
check('Gemini Auto: quick -> flash, hard -> pro', only('gemini', ALL, QUICK) === 'gemini:gemini-2.5-flash' && only('gemini', ALL, { prompt: HEAVY }) === 'gemini:gemini-2.5-pro');
check('OpenRouter Auto: stays on OpenRouter models (never its "More models" row), quick -> flash, hard -> a strong one', only('openrouter', ALL, QUICK) === 'openrouter:google/gemini-2.5-flash' && /^openrouter:/.test(only('openrouter', ALL, { prompt: HEAVY })) && !only('openrouter', ALL, { prompt: HEAVY }).endsWith('__more'));
check('every provider\'s Auto answers inside its own provider, whatever the message', A.SCOPES.every((s) => ['hi', HEAVY, 'continue'].every((text) => { const id = only(s, ALL, { prompt: text }); return id && providerOf(id) === s; })), J(A.SCOPES.map((s) => only(s, ALL, { prompt: 'hi' }))));
check('the global Auto still chooses among every provider (unchanged)', new Set(['hi', HEAVY, 'a typical request that needs a few steps'].map((t) => providerOf(A.route({ options: ALL, request: { prompt: t } }).id))).size >= 1 && A.route({ options: ALL, request: QUICK }).scope === null);
const decision = scoped('grokbuild', ALL, QUICK);
check('the decision names the provider: scope, label and reason ("Auto (Grok Build): …")', decision.scope === 'grokbuild' && /^Auto · /.test(decision.label) && /^Auto \(Grok Build\): .+ for /.test(decision.reason), J(decision));

// ---- 3) /think, /deep, /fast inside a provider
check('/think within a provider: its strongest model, quick message or not', only('openai', ALL, { prompt: 'hi', hint: 'think' }) === 'openai:gpt-5.6' && ['claudecode:opus', 'claudecode:fable'].includes(only('claudecode', ALL, { prompt: 'hi', hint: 'think' })) && only('gemini', ALL, { prompt: 'hi', hint: 'deep' }) === 'gemini:gemini-2.5-pro');
check('/fast within a provider: its quickest model, hard message or not', only('openai', ALL, { prompt: HEAVY, hint: 'fast' }) === 'openai:gpt-5.6-mini' && only('claudecode', ALL, { prompt: HEAVY, hint: 'fast' }) === 'claudecode:haiku' && only('grokbuild', ALL, { prompt: HEAVY, hint: 'fast' }) === 'grokbuild:grok-4.7-build-fast');
check('the hint reason says so, with the provider', /^Auto \(OpenAI\): .+ for extra thinking/.test(scoped('openai', ALL, { prompt: 'hi', hint: 'think' }).reason) && /for a quick answer/.test(scoped('openai', ALL, { prompt: HEAVY, hint: 'fast' }).reason));

// ---- 4) out of usage / not usable: skipped; none left
{
  const cool = (...ids) => { const c = fallback.createCooldowns(); for (const id of ids) c.mark(id, { kind: 'limit', scope: 'model', resetsAt: Date.now() + 600000 }); return c; };
  check('a model out of usage is skipped: quick message, mini limited -> the flagship', only('openai', ALL, QUICK) === 'openai:gpt-5.6-mini' && scoped('openai', ALL, QUICK, { cooldowns: cool('openai:gpt-5.6-mini') }).id === 'openai:gpt-5.6');
  check('a whole provider cooling (scope "provider") leaves it with nothing, and the reason names it', (() => { const c = fallback.createCooldowns(); c.mark('openai:gpt-5.6', { kind: 'limit', scope: 'provider', resetsAt: Date.now() + 600000 }); const d = scoped('openai', ALL, QUICK, { cooldowns: c }); return d.id === null && /no OpenAI model/.test(d.reason); })());
  check('Claude Code: Haiku out of usage -> the next one up, not another provider', providerOf(scoped('claudecode', ALL, QUICK, { cooldowns: cool('claudecode:haiku') }).id) === 'claudecode' && scoped('claudecode', ALL, QUICK, { cooldowns: cool('claudecode:haiku') }).id === 'claudecode:sonnet');
  check('every model of the provider out of usage: no decision (the fallback decides)', scoped('openai', ALL, QUICK, { cooldowns: cool('openai:gpt-5.6', 'openai:gpt-5.6-mini') }).id === null);
  check('a model refused for this account (denied) is skipped', scoped('openai', ALL, QUICK, { denied: new Set(['openai:gpt-5.6-mini']) }).id === 'openai:gpt-5.6');
  check('chat-only models are skipped when the message needs tools', scoped('openai', [{ ...openai[0] }, { ...openai[1], badges: ['chat only'] }], QUICK).id === 'openai:gpt-5.6');
  check('a model that cannot see images is skipped when the message has one', scoped('openrouter', [{ ...openrouter[0], vision: false }, openrouter[1]], { prompt: 'what is this', imageCount: 1 }).id === 'openrouter:google/gemini-2.5-flash');
  check('a signed-out engine has nothing to choose', scoped('grokbuild', grokBuildOptions({ signedIn: false, models: ['grok-4.7', 'grok-4.6'] }), QUICK).id === null);
  const off = (decision, withFallback) => A.routeOrFallBack({ options: ALL, request: QUICK, scope: 'openai', cooldowns: cool('openai:gpt-5.6', 'openai:gpt-5.6-mini') }, { fallbackOn: withFallback, related: fallback.relatedOf('openai') });
  check('nothing left + "Switch models automatically" on: another provider answers, marked and said', (() => { const d = off(null, true); return Boolean(d.id) && providerOf(d.id) !== 'openai' && d.outOfScope === true && d.scope === 'openai' && /^OpenAI is unavailable right now, so Auto uses /.test(d.reason); })(), J(off(null, true).reason));
  check('nothing left + the setting off: no decision, like a picked model with no fallback', off(null, false).id === null);
  check('nothing left for an engine: the same vendor\'s other route is tried first (Grok Build -> Grok API)', (() => { const d = A.routeOrFallBack({ options: ALL, request: QUICK, scope: 'grokbuild', cooldowns: cool('grokbuild:grok-4.7', 'grokbuild:grok-4.7-build-fast', 'grokbuild:grok-4.6') }, { fallbackOn: true, related: fallback.relatedOf('grokbuild') }); return d.id === 'xai:grok-4' && d.outOfScope; })());
  check('strict (a background run that can only use that CLI): never leaves the provider', A.routeOrFallBack({ options: ALL, request: QUICK, scope: 'grokbuild', cooldowns: cool('grokbuild:grok-4.7', 'grokbuild:grok-4.7-build-fast', 'grokbuild:grok-4.6') }, { fallbackOn: true, strict: true }).id === null);
  check('a provider with models left is never "out of scope"', A.routeOrFallBack({ options: ALL, request: QUICK, scope: 'openai' }, { fallbackOn: true }).outOfScope === undefined);
}

// ---- 5) one model only: its Auto just uses it
{
  const one = scoped('xai', ALL, QUICK);
  check('a provider with one model: its Auto uses it (xAI)', one.id === 'xai:grok-4' && scoped('xai', ALL, { prompt: HEAVY }).id === 'xai:grok-4' && scoped('xai', ALL, { prompt: 'hi', hint: 'fast' }).id === 'xai:grok-4');
  const none = grokBuildOptions({ signedIn: true, models: [] });
  check('an engine that lists no models: its Auto defers to the CLI\'s own default (no --model)', scoped('grokbuild', none, QUICK).id === 'grokbuild:default' && engineModel(scoped('grokbuild', none, QUICK).id) === 'default');
  check('routableOf: counts the models Auto could choose (an engine\'s own default does not count)', A.routableOf(ALL, 'openai').length === 2 && A.routableOf(ALL, 'xai').length === 1 && A.routableOf(ALL, 'claudecode').length === 4 && A.routableOf(none, 'grokbuild').length === 0 && A.routableOf(ALL, 'openrouter').length === 3);
}

// ---- 6) the settings: "Auto may use"
{
  check('a provider turned off for Auto is still chosen by its own Auto (asking for it by name)', scoped('openai', ALL, QUICK, { exclude: ['openai'] }).id === 'openai:gpt-5.6-mini' && A.route({ options: ALL, request: QUICK, exclude: ['openai'] }).id && providerOf(A.route({ options: ALL, request: QUICK, exclude: ['openai'] }).id) !== 'openai');
  check('...but a single model turned off for Auto stays off, inside its provider too', scoped('openai', ALL, QUICK, { exclude: ['openai:gpt-5.6-mini'] }).id === 'openai:gpt-5.6' && scoped('claudecode', ALL, QUICK, { exclude: ['claudecode:haiku'] }).id === 'claudecode:sonnet');
  check('a provider\'s Auto never reaches another provider because of an exclude list', scoped('openai', ALL, QUICK, { exclude: ['openai:gpt-5.6', 'openai:gpt-5.6-mini'] }).id === null);
}

// ---- 7) escalation stays inside the provider
{
  const e = A.escalate({ options: ALL, current: 'openai:gpt-5.6-mini', failure: { kind: 'refused' }, request: QUICK, scope: 'openai' });
  check('refused on the cheap model: a stronger model of the same provider', e?.id === 'openai:gpt-5.6' && e.escalated && /^Auto \(OpenAI\): /.test(e.reason), J(e));
  const g = A.escalate({ options: ALL, current: 'grokbuild:grok-4.7-build-fast', failure: { kind: 'context', chars: 900000 }, request: QUICK, scope: 'grokbuild' });
  check('too long: still a Grok Build model (or nothing), never another provider', g === null || providerOf(g.id) === 'grokbuild', J(g));
  check('nothing stronger in the provider: no escalation (the error stands)', A.escalate({ options: ALL, current: 'xai:grok-4', failure: { kind: 'refused' }, request: QUICK, scope: 'xai' }) === null);
}

// ---- 8) the picker's rows
{
  const rows = A.withProviderAutos(ALL, {});
  const autos = rows.filter((r) => r.auto);
  check('each provider with two or more models gets its Auto', J(autos.map((r) => r.id).sort()) === J(['anthropic:auto', 'antigravity:auto', 'claudecode:auto', 'gemini:auto', 'grokbuild:auto', 'openai:auto', 'openrouter:auto'].sort()), J(autos.map((r) => r.id)));
  check('a provider with one model (xAI) gets none: there is nothing to choose between', !autos.some((r) => r.id === 'xai:auto'));
  check('the Auto row leads its provider\'s group and carries its heading and the auto flag', ['claudecode', 'grokbuild', 'openai', 'gemini', 'anthropic'].every((p) => { const i = rows.findIndex((r) => r.id === `${p}:auto`); return i >= 0 && providerOf(rows[i + 1].id) === p && rows[i].group === rows[i + 1].group && rows[i].auto === true && rows[i].autoScope === p; }));
  check('the list is the same models in the same order, with the Autos in between', J(rows.filter((r) => !r.auto).map((r) => r.id)) === J(ALL.map((o) => o.id)));
  const g = rows.find((r) => r.id === 'grokbuild:auto');
  check('an engine\'s row reads "Grok Build · Auto" with an explanation; an API provider\'s row is plain "Auto" under its heading', g.label === 'Grok Build · Auto' && g.name === 'Auto' && /Grok Build/.test(g.detail) && rows.find((r) => r.id === 'openai:auto').label === 'Auto', J([g, rows.find((r) => r.id === 'openai:auto')]));
  const picked = A.withProviderAutos([...ALL.filter((o) => o.id !== 'openai:gpt-5.6-mini')], { pick: 'openai:auto', last: { label: 'Auto · GPT-5.6', reason: 'Auto (OpenAI): GPT-5.6 for a typical request', scope: 'openai' } });
  check('the chat\'s own Auto row stays even when the provider shrank to one model, and says what it chose last', picked.some((r) => r.id === 'openai:auto' && r.name === 'Auto · GPT-5.6' && /Auto \(OpenAI\)/.test(r.detail)), J(picked.filter((r) => r.auto).map((r) => r.id)));
  check('another provider\'s row does not show this chat\'s last choice', A.withProviderAutos(ALL, { pick: 'openai:auto', last: { label: 'Auto · GPT-5.6', reason: 'x', scope: 'openai' } }).find((r) => r.id === 'gemini:auto').name === 'Auto');
  check('a signed-out engine group has no Auto (nothing to choose)', !A.withProviderAutos(grokBuildOptions({ signedIn: false, models: ['grok-4.7', 'grok-4.6'] }), {}).some((r) => r.auto));
  check('the Autos are never candidates themselves', A.route({ options: rows, request: QUICK }).id && !A.isAuto(A.route({ options: rows, request: QUICK }).id) && !A.isAuto(scoped('openai', rows, QUICK).id));
}

// ---- 9) the agent's turn
const OPTS = [...claudeApi, ...openai, ...cc.filter((o) => o.id !== 'claudecode:default'), ...gb.filter((o) => o.id !== 'grokbuild:default')];
function makeAgent({ options = OPTS, scripts = {}, fallbackOn = true } = {}) {
  const log = { turns: [], events: [], ran: [], routed: [], escalated: [], denied: [] };
  const denied = A.createDenied();
  const browser = {
    fallbackOptions: () => options, autoFallback: () => fallbackOn, maxSteps: () => 0, onFallback() {}, aiOff: () => false, noTabReason: () => 'x', effectiveModel: (m) => m, activeTab: () => null,
    autoRoute: ({ request, last, allowEngines, scope = null }) => { const d = A.routeOrFallBack({ options, request, last, prefer: A.preferFrom({ lastId: last }), denied: denied.set(), cooldowns: fallback.shared, allowEngines, scope }, { fallbackOn, related: scope ? fallback.relatedOf(scope) : [] }); log.routed.push({ scope, id: d.id }); return d; },
    autoEscalate: ({ current, failure, request, tried, allowEngines, scope = null }) => { const d = A.escalate({ options, current, failure, request, tried, denied: denied.set(), cooldowns: fallback.shared, allowEngines, scope }); log.escalated.push({ scope, id: d?.id || null }); return d; },
    autoDeny: (id) => { log.denied.push(id); denied.add(id); },
    onAuto() {},
  };
  const agent = Object.assign(Object.create(Agent.prototype), {
    scopes: new Set(), runs: new Map(), approvedHosts: new Set(), browser, engines: { claudecode: { warm() {}, release() {} } },
    isExternalTool: () => false, async describeStep() { return 'step'; }, async ensureAllowed() {}, closeSignedInTabs() {}, guardRedirects: () => null,
    async pageContextFor() { return ''; }, newActionLog: () => ({}), undoSummary: () => null,
    async claudeTurn(messages) { return this.scripted(messages.settings.model); },
    async otherTurn(messages) { return this.scripted(messages.settings.model); },
    async scripted(model) {
      log.turns.push(model);
      const step = (scripts[model] || []).shift();
      if (step instanceof Error) throw step;
      if (step) return { ...step, model };
      return { content: [{ type: 'text', text: `${model} answers` }], stop_reason: 'end_turn', model };
    },
    async claudeCodeTurn(messages) { log.turns.push(messages.settings.model); },
    async grokBuildTurn(messages) { log.turns.push(messages.settings.model); },
  });
  agent.engines.grokbuild = {};
  agent.inTask = async (_tab, _signal, fn) => fn();
  agent.runTask = async function (messages, tab, userText, images, controller, emit) { log.ran.push({ model: messages.settings.model, text: userText, autoFrom: messages.settings.autoFrom }); await Agent.prototype.runTask.call(this, messages, tab, userText, images, controller, emit, {}); };
  return { agent, log };
}
const fresh = (model) => { const m = []; m.settings = { model, adhdMode: false }; return m; };
const once = async (agent, messages, text, log) => { await agent.runOnce(text, (e) => log.events.push(e), [], {}, null, messages); return messages; };
const notices = (log) => log.events.filter((e) => e.type === 'notice').map((e) => e.text);

(async () => {
  {
    fallback.shared.clear();
    const { agent, log } = makeAgent();
    const messages = fresh('openai:auto');
    await once(agent, messages, 'hi', log);
    check('OpenAI Auto, a quick message: the mini model runs (concrete, never "auto")', log.ran[0].model === 'openai:gpt-5.6-mini' && log.turns[0] === 'openai:gpt-5.6-mini', J(log.ran));
    check('the chat keeps the provider\'s Auto as its pick (autoFrom), with the reason and the provider recorded', messages.settings.autoFrom === 'openai:auto' && messages.settings.autoLast.scope === 'openai' && /^Auto \(OpenAI\): /.test(messages.settings.autoLast.reason), J(messages.settings));
    check('the router was asked for that provider only', log.routed[0].scope === 'openai', J(log.routed));
    check('an event names the model and why; done carries it', log.events.some((e) => e.type === 'auto' && e.model === 'openai:gpt-5.6-mini' && /^Auto \(OpenAI\): /.test(e.reason)) && log.events.find((e) => e.type === 'done')?.auto?.reason, J(log.events.map((e) => e.type)));
    await once(agent, messages, HEAVY, log);
    check('the next message is routed afresh, still inside the provider: the flagship', log.ran[1].model === 'openai:gpt-5.6' && messages.settings.autoFrom === 'openai:auto' && log.routed[1].scope === 'openai', J(log.ran));
  }
  {
    fallback.shared.clear();
    const { agent, log } = makeAgent();
    const messages = fresh('openai:auto');
    await once(agent, messages, '/think hello', log);
    await once(agent, messages, '/fast ' + HEAVY, log);
    check('/think and /fast inside a provider\'s Auto: its strongest and its quickest, command stripped', log.ran[0].model === 'openai:gpt-5.6' && log.ran[0].text === 'hello' && log.ran[1].model === 'openai:gpt-5.6-mini' && !log.ran[1].text.startsWith('/fast'), J(log.ran.map((r) => [r.model, r.text.slice(0, 12)])));
  }
  {
    fallback.shared.clear();
    const { agent, log } = makeAgent();
    const messages = fresh('claudecode:auto');
    await once(agent, messages, 'hi', log);
    check('Claude Code Auto, a quick message: a Claude Code model runs (haiku), the chat is on claudecode:auto', log.ran[0].model === 'claudecode:haiku' && messages.settings.autoFrom === 'claudecode:auto', J(log.ran));
    const g = fresh('grokbuild:auto');
    await once(agent, g, 'hi', log);
    check('Grok Build Auto: a Grok Build model runs', log.ran[1].model === 'grokbuild:grok-4.7-build-fast' && g.settings.autoFrom === 'grokbuild:auto', J(log.ran));
  }
  {
    // a picked model and the global Auto are untouched
    fallback.shared.clear();
    const { agent, log } = makeAgent();
    const pickedM = fresh('openai:gpt-5.6');
    await once(agent, pickedM, 'hi', log);
    const global = fresh('auto');
    await once(agent, global, 'hi', log);
    check('a picked model is used as picked; the global Auto still has no scope', log.ran[0].model === 'openai:gpt-5.6' && !pickedM.settings.autoFrom && global.settings.autoFrom === 'auto' && log.routed.length === 1 && log.routed[0].scope === null, J({ ran: log.ran, routed: log.routed }));
  }
  {
    fallback.shared.clear();
    const denied = Object.assign(new Error('The model `gpt-5.6` does not exist or you do not have access to it.'), { status: 404 });
    const { agent, log } = makeAgent({ options: [...openai, ...claudeApi], scripts: { 'openai:gpt-5.6': [denied] } });
    const messages = fresh('openai:auto');
    await once(agent, messages, HEAVY, log);
    check('escalation: a refused flagship goes on another OpenAI model (the same provider), once', log.turns[0] === 'openai:gpt-5.6' && log.turns[1] === 'openai:gpt-5.6-mini' && log.escalated[0]?.scope === 'openai', J({ turns: log.turns, esc: log.escalated }));
    check('...the chat keeps the provider\'s Auto and the picker is told', messages.settings.autoFrom === 'openai:auto' && messages.settings.autoLast.scope === 'openai', J(messages.settings));
  }
  {
    // all of a provider's models are limited: it behaves like a picked model out of usage
    fallback.shared.clear();
    fallback.shared.mark('openai:gpt-5.6', { kind: 'limit', scope: 'model', resetsAt: Date.now() + 600000 });
    fallback.shared.mark('openai:gpt-5.6-mini', { kind: 'limit', scope: 'model', resetsAt: Date.now() + 600000 });
    const { agent, log } = makeAgent();
    const messages = fresh('openai:auto');
    await once(agent, messages, 'hi', log);
    check('every OpenAI model out of usage, fallback on: another provider answers and the chat says so', providerOf(log.ran[0].model) !== 'openai' && notices(log).some((t) => /^OpenAI is unavailable right now, so Auto uses /.test(t)) && messages.settings.autoFrom === 'openai:auto', J({ ran: log.ran, notices: notices(log) }));
    await once(agent, messages, 'hi again', log);
    fallback.shared.clear();
    await once(agent, messages, 'hi again', log);
    check('...and when the limit resets the next message is back on the provider', log.ran[2].model === 'openai:gpt-5.6-mini', J(log.ran));
    fallback.shared.mark('openai:gpt-5.6', { kind: 'limit', scope: 'model', resetsAt: Date.now() + 600000 });
    fallback.shared.mark('openai:gpt-5.6-mini', { kind: 'limit', scope: 'model', resetsAt: Date.now() + 600000 });
    const off = makeAgent({ fallbackOn: false });
    const m2 = fresh('openai:auto');
    await once(off.agent, m2, 'hi', off.log);
    const err = off.log.events.find((e) => e.type === 'error');
    check('fallback off: a plain error that names the provider, nothing ran', Boolean(err) && /OpenAI/.test(err.text || err.message || J(err)) && off.log.ran.length === 0, J(off.log.events));
    fallback.shared.clear();
  }

  // ---- 10) warm processes: a pick that is not routed yet asks for no model, and another model is another process
  {
    const settings = { model: 'claudecode:auto', adhdMode: false };
    const messages = []; messages.settings = settings;
    const agent = Object.assign(Object.create(Agent.prototype), { browser: { autoModel: () => true, claudeCodeFullAccess: () => false, maxSteps: () => 0 }, prewarmed: null });
    const plan = agent.claudeCodePlan(messages, 'hi', 0, 0);
    check('Claude Code: prewarming a chat on claudecode:auto guesses a real model (never "auto")', plan.spawn.model !== 'auto' && ['haiku', 'sonnet', 'opus', 'default'].includes(plan.spawn.model), J(plan.spawn.model));
    const argv = (model) => claude.buildArgs({ mcpConfig: 'm', sessionId: 's', resume: false, systemPrompt: 'p', model });
    check('Claude Code: its argv never carries "auto"', !argv(plan.spawn.model).includes('auto'));
    const key = (model) => claude.procKey({ bin: 'claude', sessionId: 's1', systemPrompt: 'p', model });
    check('Claude Code: a warm process is kept only for the model it was started with (the key has the model: haiku != sonnet != opus)', key('haiku') !== key('sonnet') && key('sonnet') !== key('opus') && key('haiku') === key('haiku'));
    const warm = (model) => { const m = []; m.settings = { model, adhdMode: false, ccSession: 'cc-1', autoFrom: 'claudecode:auto', autoTier: 'heavy' }; return agent.claudeCodePlan(m, 'hi', 0, 0).spawn; };
    check('Claude Code: the plan for the model Auto chose carries exactly that alias (so a different choice is a different process)', warm('claudecode:haiku').model === 'haiku' && warm('claudecode:opus').model === 'opus' && claude.procKey({ bin: 'c', ...warm('claudecode:haiku') }) !== claude.procKey({ bin: 'c', ...warm('claudecode:opus') }));
    const gbAgent = Object.assign(Object.create(Agent.prototype), { messages: [], browser: { grokBuildFullAccess: () => false }, runs: new Map(), engines: { grokbuild: { statusCache: {} } } });
    gbAgent.messages.settings = { model: 'grokbuild:auto', adhdMode: false };
    const spec = gbAgent.grokWarmSpec();
    check('Grok Build: a kept process for a chat on grokbuild:auto is started on Grok\'s default (never a model called "auto"), with no session to resume', spec && spec.model === 'default' && spec.sessionId === null, J(spec));
    gbAgent.messages.settings = { model: 'grokbuild:grok-4.7', adhdMode: false, gbSession: 'sess-1', gbModel: 'grokbuild:grok-4.7', autoFrom: 'grokbuild:auto' };
    check('Grok Build: after a turn on grok-4.7 the kept process is for that model and its session', gbAgent.grokWarmSpec()?.model === 'grok-4.7' && gbAgent.grokWarmSpec()?.sessionId === 'sess-1');
    gbAgent.messages.settings.model = 'grokbuild:grok-4.7-build-fast'; // Auto chose another model for the next message: its own session
    check('Grok Build: a session started on another model is not resumed for the model Auto chose now', gbAgent.grokWarmSpec()?.sessionId === null && gbAgent.grokWarmSpec()?.model === 'grok-4.7-build-fast');
  }

  // ---- 11) background tasks: the model list
  {
    const list = bgAgents.taskModels([...claudeApi, ...openai, ...xai, ...cc, ...gb]);
    const ids = list.map((m) => m.id);
    check('background tasks: a provider\'s Auto leads its group (API providers and the two CLIs), after the global Auto', ids[0] === 'auto' && ids.indexOf('openai:auto') === ids.indexOf('openai:gpt-5.6') - 1 && ids.indexOf('claudecode:auto') === ids.indexOf('claudecode:default') - 1 && ids.indexOf('grokbuild:auto') === ids.indexOf('grokbuild:default') - 1 && ids.includes('anthropic:auto'), J(ids));
    check('background tasks: none for a one-model provider (xAI) or Antigravity; each is available and reads as its engine', !ids.includes('xai:auto') && !ids.includes('antigravity:auto') && list.filter((m) => m.id.endsWith(':auto')).every((m) => m.available && m.label === 'Auto' && m.engine === bgAgents.engineOfModel(m.id)), J(list.filter((m) => m.id.endsWith(':auto'))));
  }

  console.log(failures ? `\n${failures} provider-auto check(s) failed` : '\nall provider-auto checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
