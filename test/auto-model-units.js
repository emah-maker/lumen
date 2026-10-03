// Auto model (ai/auto-model.js): tiers, what a request needs, candidate filtering (connected, cooling, plan-gated,
// tools / vision / context), the choice, escalation and determinism. Plain Node: no Electron, no CLI, no network.
const A = require('../src/ai/auto-model');
const fallback = require('../src/ai/fallback');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

const claude = [
  { id: 'claude-opus-5', label: 'Opus', name: 'Opus', group: 'Claude' },
  { id: 'claude-sonnet-5', label: 'Sonnet', name: 'Sonnet', group: 'Claude' },
  { id: 'claude-haiku-4-5', label: 'Haiku', name: 'Haiku', group: 'Claude' },
];
const openai = [
  { id: 'openai:gpt-5.6', label: 'GPT-5.6', name: 'GPT-5.6', group: 'OpenAI' },
  { id: 'openai:gpt-5.6-mini', label: 'GPT-5.6 mini', name: 'GPT-5.6 mini', group: 'OpenAI' },
];
const cc = [
  { id: 'claudecode:default', label: 'Claude Code', name: 'Claude Code', group: 'Your Claude account', signedIn: true },
  { id: 'claudecode:opus', label: 'Claude Code · Opus', name: 'Opus', group: 'Your Claude account', signedIn: true },
  { id: 'claudecode:sonnet', label: 'Claude Code · Sonnet', name: 'Sonnet', group: 'Your Claude account', signedIn: true },
  { id: 'claudecode:haiku', label: 'Claude Code · Haiku', name: 'Haiku', group: 'Your Claude account', signedIn: true },
];
const all = [...claude, ...openai, ...cc];
const heavyBrief = ['Refactor the checkout flow across the codebase and debug why the cart total is wrong after a coupon is applied.', '1. Investigate the root cause in cart.js and pricing.js', '2. Design a fix that handles concurrent updates', '3. Write tests, then migrate the old orders', '4. Also make sure the API docs stay accurate'].join('\n');

// ---- tiers
const tiers = { 'claude-haiku-4-5': 'fast', 'claude-sonnet-5': 'balanced', 'claude-opus-5': 'strong', 'openai:gpt-5.6-mini': 'fast', 'openai:gpt-5.6': 'strong', 'o4-mini': 'balanced', 'o3': 'strong', 'gpt-4o': 'balanced', 'gemini-2.5-flash': 'fast', 'gemini-2.5-pro': 'strong', 'grok-code-fast-1': 'fast', 'grok-4': 'strong', 'grok-3': 'balanced', 'claudecode:default': 'balanced', 'claudecode:haiku': 'fast', 'antigravity:default': 'balanced', 'openrouter:anthropic/claude-opus-5.5': 'strong' };
for (const [id, tier] of Object.entries(tiers)) check(`tier of ${id} is ${tier}`, A.tierOf(id) === tier, A.tierOf(id));
check('an option may carry its own tier', A.tierOf({ id: 'openai:gpt-5-codex-mini', tier: 'balanced' }) === 'balanced');
check('a wrong tier value is ignored', A.tierOf({ id: 'claude-haiku-4-5', tier: 'bogus' }) === 'fast');

// ---- what a request needs
const need = (r) => A.needFor(r);
check('quick kinds are fast', ['quick', 'lookup', 'translation', 'classification', 'title', 'summary'].every((kind) => need({ kind }).tier === 'fast'));
check('a summary of a long page is balanced', need({ kind: 'summary', attachmentChars: 90_000 }).tier === 'balanced');
check('reasoning is strong, code is balanced', need({ kind: 'reasoning' }).tier === 'strong' && need({ kind: 'code' }).tier === 'balanced');
check('a greeting is fast', need({ prompt: 'hi' }).tier === 'fast');
check('a normal request is balanced', need({ prompt: 'find the cheapest flight from Boston to Denver next month on this site' }).tier === 'balanced');
check('a multi-step debugging brief is strong', need({ prompt: heavyBrief }).tier === 'strong');
check('/think asks for the strongest', need({ prompt: 'hi', hint: 'think' }).tier === 'strong');
check('deep research asks for the strongest', need({ prompt: 'x', hint: 'deep' }).tier === 'strong' && /deep research/.test(need({ prompt: 'x', hint: 'deep' }).why));
check('a fast hint wins over a hard-looking prompt', need({ prompt: heavyBrief, hint: 'fast' }).tier === 'fast');
check('a long conversation lifts fast to balanced', need({ prompt: 'ok', historyChars: 80_000 }).tier === 'balanced');
check('a huge conversation lifts to strong', need({ prompt: 'ok', historyChars: 300_000 }).tier === 'strong');
check('images set vision, chats and agent tasks need tools', need({ prompt: 'what is this', imageCount: 1 }).vision && need({ prompt: 'hi' }).tools && !need({ kind: 'translation' }).tools);
check('a follow-up keeps the previous tier', need({ prompt: 'continue', previousTier: 'strong', turns: 2 }).tier === 'strong');

// ---- the choice
const r = (request, o = {}) => A.route({ options: all, request, ...o });
check('a quick question picks a fast model', A.tierOf(r({ prompt: 'what time is it in Tokyo' }).id) === 'fast');
check('a hard brief picks a strong model', A.tierOf(r({ prompt: heavyBrief }).id) === 'strong');
check('Auto never picks the Auto row, an engine default with models, or "more models"', ![...Array(40).keys()].some((i) => ['auto', 'claudecode:default', 'openai:__more'].includes(r({ prompt: 'x'.repeat(i * 40) }, { options: [...all, { id: 'auto' }, { id: 'openai:__more', more: true }] }).id)));
check('the reason says which model and why', /^Auto: .+ for .+/.test(r({ prompt: 'hi' }).reason) && /^Auto · /.test(r({ prompt: 'hi' }).label), r({ prompt: 'hi' }).reason);
check('the label reads "Auto · Haiku" for a Claude Code haiku', A.label({ id: 'claudecode:haiku', name: 'Haiku' }) === 'Auto · Haiku');
check('stays with the provider already answering', r({ prompt: 'what time is it in Tokyo' }, { prefer: ['claudecode'] }).id === 'claudecode:haiku' && r({ prompt: 'what time is it in Tokyo' }, { prefer: ['openai'] }).id === 'openai:gpt-5.6-mini');
check('the provider the user was on before is preferred', r({ prompt: heavyBrief }, { prefer: A.preferFrom({ home: 'openai:gpt-5.6-mini' }) }).id === 'openai:gpt-5.6');
check('deterministic: the same inputs, the same answer', JSON.stringify(r({ prompt: heavyBrief })) === JSON.stringify(r({ prompt: heavyBrief })));
check('picker order breaks a tie, not randomness', r({ prompt: 'hi' }, { options: [...openai].reverse() }).id === 'openai:gpt-5.6-mini');
check('only one tier available: the nearest is used (a stronger one before a weaker one)', r({ prompt: 'what time is it' }, { options: [claude[0]] }).id === 'claude-opus-5' && r({ prompt: heavyBrief }, { options: [claude[2]] }).id === 'claude-haiku-4-5');
check('prefers a stronger model to a weaker one when the exact tier is missing', r({ prompt: 'find the cheapest flight from Boston to Denver next month' }, { options: [claude[0], claude[2]] }).id === 'claude-opus-5');
check('nothing connected: no model, said plainly', (() => { const x = r({ prompt: 'hi' }, { options: [] }); return x.id === null && /no model/.test(x.reason); })());

// ---- availability
const q = { prompt: 'what time is it in Tokyo' };
check('a model the user turned off for Auto is skipped', r(q, { exclude: ['claude-haiku-4-5'], options: claude }).id !== 'claude-haiku-4-5');
check('a provider turned off for Auto is skipped as a whole', !/^claudecode/.test(r(q, { exclude: ['claudecode'] }).id) && !/^claudecode/.test(r({ prompt: heavyBrief }, { exclude: ['claudecode'] }).id));
check('an engine signed out is never chosen', r(q, { options: cc.map((o) => ({ ...o, signedIn: false })).concat(openai) }).id.startsWith('openai:'));
check('a sign-in badge counts as signed out', r(q, { options: [{ ...cc[3], badges: ['sign in'] }, ...openai] }).id.startsWith('openai:'));
check('a plan-gated model (gated: true) is never chosen', r({ prompt: heavyBrief }, { options: [{ ...claude[0], gated: true }, claude[1]] }).id === 'claude-sonnet-5');
check('a model refused for this account (denied) is skipped', r({ prompt: heavyBrief }, { options: claude, denied: new Set(['claude-opus-5']) }).id === 'claude-sonnet-5');
check('a model that is cooling down (rate limited) is skipped', (() => {
  const cd = fallback.createCooldowns();
  cd.mark('claude-haiku-4-5', { kind: 'limit', scope: 'model', resetsAt: Date.now() + 600e3 });
  return r(q, { options: claude, cooldowns: cd }).id === 'claude-sonnet-5';
})());
check('a provider cooling down takes all its models out', (() => {
  const cd = fallback.createCooldowns();
  cd.mark('claudecode:sonnet', { kind: 'limit', scope: 'provider', resetsAt: Date.now() + 600e3 });
  return !r(q, { cooldowns: cd }).id.startsWith('claudecode:') && !r({ prompt: heavyBrief }, { cooldowns: cd }).id.startsWith('claudecode:');
})());
check('everything cooling: no model, said plainly', (() => { const cd = fallback.createCooldowns(); cd.mark('claude-haiku-4-5', { kind: 'limit', scope: 'provider', resetsAt: Date.now() + 1e6 }); const x = r(q, { options: claude, cooldowns: cd }); return x.id === null && /no model/.test(x.reason); })());
check('CLI engines left out when another chat is running', !r(q, { allowEngines: false }).id.startsWith('claudecode:') && !r({ prompt: heavyBrief }, { allowEngines: false }).id.startsWith('claudecode:'));
check('scope keeps Auto inside one provider', r(q, { scope: 'openai' }).id === 'openai:gpt-5.6-mini' && r({ prompt: heavyBrief }, { scope: 'claudecode' }).id === 'claudecode:opus');

// ---- capabilities
const chatOnly = { id: 'openrouter:vendor/text-only', label: 'Text only', badges: ['chat only'], group: 'OpenRouter' };
check('a chat-only model is skipped when tools are needed', r({ prompt: 'what time is it' }, { options: [chatOnly, claude[1]] }).id === 'claude-sonnet-5');
check('a chat-only model may translate (no tools needed)', r({ kind: 'translation' }, { options: [chatOnly, claude[1]] }).id === chatOnly.id);
check('a text-only model is skipped when the request has images', r({ prompt: 'what is this', imageCount: 1 }, { options: [{ id: 'openrouter:vendor/blind', label: 'Blind', vision: false }, claude[1]] }).id === 'claude-sonnet-5');
check('a model whose window is too small is skipped', r({ prompt: 'ok', historyChars: 70_000 }, { options: [{ id: 'openai:gpt-4', label: 'GPT-4' }, claude[1]] }).id === 'claude-sonnet-5');
check('claudecode default is used when that engine lists no models', r(q, { options: [cc[0]] }).id === 'claudecode:default');
check('...and left to the CLI (native default) only then', !r(q, { options: cc }).id.endsWith(':default'));
check('Grok Build / Antigravity defaults likewise defer', r(q, { options: [{ id: 'grokbuild:default', label: 'Grok Build', signedIn: true }, { id: 'antigravity:default', label: 'Antigravity', signedIn: true }] }).id === 'grokbuild:default');

// ---- escalation
const esc = (failure, o = {}) => A.escalate({ options: all, current: o.current || 'claude-haiku-4-5', failure: { kind: failure }, request: o.request || { prompt: 'hi' }, ...o });
check('a refusal on a cheap model moves up a tier', A.tierOf(esc('refused').id) !== 'fast' && esc('refused').escalated === true);
check('the strongest model has nothing to escalate to', esc('refused', { current: 'claude-opus-5' }) === null);
check('an empty answer escalates like a refusal', esc('empty').id !== null);
check('context: a model with a larger window', (() => { const x = A.escalate({ options: [{ id: 'openai:gpt-4', label: 'GPT-4' }, { id: 'gemini-2.5-flash', label: 'Gemini Flash' }], current: 'openai:gpt-4', failure: { kind: 'context' }, request: { prompt: 'hi' } }); return x?.id === 'gemini-2.5-flash'; })());
check('context: never the same model, never one already tried', (() => { const x = esc('context', { tried: ['claude-sonnet-5'] }); return x && x.id !== 'claude-haiku-4-5' && x.id !== 'claude-sonnet-5'; })());
check('tools: a model that can use them', (() => { const x = A.escalate({ options: [chatOnly, claude[1]], current: chatOnly.id, failure: { kind: 'tools' }, request: { prompt: 'hi' } }); return x?.id === 'claude-sonnet-5'; })());
check('denied: another model at the same tier, not a stronger one', (() => { const x = A.escalate({ options: [claude[0], { id: 'openai:gpt-5.6', label: 'GPT' }, claude[2]], current: 'claude-opus-5', failure: { kind: 'denied' }, request: { prompt: heavyBrief } }); return x?.id === 'openai:gpt-5.6'; })());
check('escalation respects cooldowns and exclusions', (() => { const cd = fallback.createCooldowns(); cd.mark('claude-sonnet-5', { kind: 'limit', scope: 'model', resetsAt: Date.now() + 1e6 }); const x = esc('refused', { options: claude, cooldowns: cd }); return x?.id === 'claude-opus-5' && esc('refused', { options: claude, exclude: ['claude-opus-5', 'claude-sonnet-5'] }) === null; })());
check('escalation says why', /second try|longer|tools|account/.test(esc('refused').reason) && /^Auto: /.test(esc('refused').reason), esc('refused').reason);
check('no stronger model left: null, never a loop', esc('refused', { options: [claude[2]] }) === null);

// ---- recognising failures
check('failureOf: context', A.failureOf(new Error('prompt is too long: 250000 tokens > 200000 maximum'))?.kind === 'context');
check('failureOf: tools', A.failureOf(Object.assign(new Error('No endpoints found that support tool use'), { status: 404 }))?.kind === 'tools' && A.failureOf({ status: 400, message: 'This model does not support tools' })?.kind === 'tools');
check('failureOf: denied', A.failureOf(Object.assign(new Error('The model `claude-opus-5` does not exist or you do not have access to it.'), { status: 404 }))?.kind === 'denied');
check('failureOf: a plan message', A.failureOf('Opus is not available on your plan. Upgrade your plan to use it.')?.kind === 'denied');
check('failureOf: a usage limit or outage is not one (fallback handles it)', A.failureOf(Object.assign(new Error('rate limit exceeded'), { status: 429 })) === null && A.failureOf(Object.assign(new Error('overloaded'), { status: 529 })) === null);
check('failureOf: anything else is null', A.failureOf(new Error('boom')) === null && A.failureOf(null) === null);

// ---- denied memory
check('denied memory forgets after its time', (() => { const d = A.createDenied(1000); d.add('x', 0); return d.set(500).has('x') && !d.set(2000).has('x'); })());

// ---- the picker's row
check('the picker row: Auto first-class, a label that follows the last choice', (() => {
  const base = A.pickerEntry({});
  const used = A.pickerEntry({ last: { label: 'Auto · Haiku', reason: 'Auto: Haiku for a quick lookup' } });
  return base.id === 'auto' && base.name === 'Auto' && base.group === 'Auto' && used.name === 'Auto · Haiku' && /quick lookup/.test(used.detail);
})());

if (failures) { console.log(`\n${failures} auto-model check(s) failed`); process.exit(1); }
console.log('\nAll auto-model checks passed');
