// Auto by situation (features/model-route.js situationOf / tierFor, ai/auto-model.js needFor / route): realistic prompts -> the kind of
// request -> the model each engine and provider gets, plus availability, fallback and pinning. Plain Node: no Electron, no CLI, no network.
// The reasoning behind each row is in docs/auto-model.md ("Research" and "By situation").
const R = require('../src/features/model-route');
const A = require('../src/ai/auto-model');
const fallback = require('../src/ai/fallback');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

// ---- 1. prompt -> situation -> tier (the CLI tiers light / standard / heavy)
const long = (s, n) => Array.from({ length: n }, () => s).join(' ');
const prompts = [
  // [prompt, signals, kind, tier]
  ['thanks!', {}, 'quick', 'light'],
  ['great, thank you so much', {}, 'quick', 'light'],
  ['hi there', {}, 'chat', 'light'],
  ['what time is it in Tokyo', {}, 'chat', 'light'],
  ['explain how photosynthesis works', {}, 'chat', 'light'],
  ['what does this page say about refunds?', { page: true }, 'page', 'light'],
  ['summarize this article', {}, 'page', 'light'],
  ['what is the author arguing here?', { page: true }, 'page', 'light'],
  ['translate this paragraph into French', {}, 'rewrite', 'light'],
  ['proofread my email and make it sound friendlier', {}, 'rewrite', 'light'],
  [`translate the following contract into plain English: ${long('The party of the first part shall indemnify the party of the second part.', 30)}`, {}, 'rewrite', 'standard'],
  ['open youtube', {}, 'browse', 'light'],
  ['search for pizza near me', {}, 'browse', 'light'],
  ['scroll down and click the pricing link', {}, 'browse', 'standard'], // two actions: a chain of steps
  ['go to amazon, search for a usb-c cable and add the cheapest one to my cart', {}, 'browse', 'standard'],
  ['log in to my bank and download last month statement', {}, 'browse', 'standard'],
  ['fill out the form on this page with my details', {}, 'browse', 'standard'],
  ['compare these tabs and tell me which laptop is best', { tabCount: 4 }, 'research', 'standard'],
  ['find sources on intermittent fasting and cite them', {}, 'research', 'standard'],
  ['research the best noise cancelling headphones under $300', {}, 'research', 'standard'],
  ['can you double check the tables', {}, 'research', 'standard'], // a steam table (0.08 bar hf / hfg) the AI had given from memory: it has to find the source and compare
  ['verify the 0.08 bar values', {}, 'research', 'standard'],
  ['check the tables', {}, 'research', 'standard'],
  ['is this right?', {}, 'research', 'standard'],
  ['look it up', {}, 'research', 'standard'],
  ['confirm the values in table 15.3.1', {}, 'research', 'standard'],
  ['find the source for that number', {}, 'research', 'standard'],
  ['what does the literature say about spaced repetition?', {}, 'research', 'standard'],
  ['fix the bug in this function', {}, 'code', 'standard'],
  ['why does my regex not match?', {}, 'code', 'standard'],
  ['Why does this crash?\n```js\nfoo.bar()\n```\nTypeError: x\n    at run (app.js:10:5)\n    at main (app.js:20:1)', {}, 'code', 'heavy'],
  ['prove that the square root of 2 is irrational', {}, 'reasoning', 'heavy'],
  ['solve for x: 3x + 5 = 20', {}, 'reasoning', 'standard'],
  ['what is in this screenshot?', { imageCount: 1 }, 'vision', 'light'],
  ['extract the numbers from this invoice', { imageCount: 1 }, 'vision', 'standard'],
  ['what does this chart show?', { imageCount: 1 }, 'vision', 'standard'],
  // writing new text: short pieces small, long-form or high-stakes mid-size, deep long-form the strongest
  ['write a cover letter for a barista job', {}, 'writing', 'standard'],
  ['draft an email to my landlord about the broken heater, firm but polite', {}, 'writing', 'light'],
  ['write a 1500 word essay on the french revolution', {}, 'writing', 'standard'],
  ['write a short bio for my website', {}, 'writing', 'light'],
  ['write a linkedin post about our launch', {}, 'writing', 'light'],
  ['compose a 2 page report on our Q3 results', {}, 'writing', 'standard'],
  ['write a speech for my sister\'s wedding', {}, 'writing', 'standard'],
  ['write a thorough, in-depth essay on the causes of the french revolution', {}, 'writing', 'heavy'],
  ['write a 200 word email declining the invitation', {}, 'writing', 'light'],
  ['rewrite this email to sound friendlier', {}, 'rewrite', 'light'], // editing given text stays a rewrite
  ['compare these three laptops', {}, 'compare', 'standard'],
  ['which phone should I buy, the pixel or the iphone?', {}, 'compare', 'standard'],
  ['pros and cons of renting versus buying a house', {}, 'compare', 'standard'],
  ['draw a logo for my coffee shop', {}, 'imagegen', 'light'],
  ['generate an image of a cat in space', {}, 'imagegen', 'light'],
];
for (const [prompt, sig, kind, tier] of prompts) {
  const t = R.tierFor(prompt, sig);
  check(`${kind}/${tier}: ${prompt.split('\n')[0].slice(0, 70)}`, t.kind === kind && t.tier === tier, `${t.kind}/${t.tier} (score ${t.score})`);
}
check('every situation named in the table is one the router knows', prompts.every(([, , k]) => R.SITUATIONS.includes(k)));
check('code about a page stays code, not browsing', R.tierFor('open the console and fix the error on this page', {}).kind === 'code');
check('a browse verb inside a long brief is scored, not capped', R.tierFor(`${long('Please analyze the architecture and design of this system in depth.', 8)} then open the docs`, {}).tier === 'heavy');
check('the reason names the situation', R.tierFor('go to amazon, search for a usb-c cable and add it to my cart').why === 'a multi-step browsing task' && R.tierFor('thanks!').why === 'a quick reply' && R.tierFor('research the best headphones').why === 'research across sources');

// ---- 2. follow-ups and pinning
const prev = { tier: 'standard', turns: 2, kind: 'browse' };
check('"continue" keeps the situation and the tier', (() => { const t = R.tierFor('continue', { previous: prev }); return t.kind === 'browse' && t.tier === 'standard' && t.followUp; })());
check('a sign-off ends a hard task cheaply when not pinned', R.tierFor('thanks!', { previous: { tier: 'heavy', turns: 3, kind: 'code' } }).tier === 'light');
check('a pinned CLI session is never lowered, whatever the message', R.tierFor('thanks!', { previous: { tier: 'heavy', turns: 3, kind: 'code' }, pinned: true }).tier === 'heavy' && R.tierFor('open youtube', { previous: { tier: 'standard', turns: 1 }, pinned: true }).tier === 'standard');
check('a pinned session can still go up', R.tierFor('prove that the square root of 2 is irrational', { previous: { tier: 'light', turns: 1 }, pinned: true }).tier === 'heavy');
check('Claude Code with no model picked: browsing multi-step -> Sonnet, one step -> Haiku, proof -> Opus', (() => {
  const m = (prompt, extra = {}) => R.route({ engine: 'claudecode', picked: 'default', prompt, ...extra }).model;
  return m('open youtube') === 'haiku' && m('go to amazon, search for a usb-c cable and add the cheapest one to my cart') === 'sonnet' && m('prove that the square root of 2 is irrational') === 'opus' && m('thanks!') === 'haiku';
})());
check('Claude Code resumed session: the tier is pinned, the model follows it', R.route({ engine: 'claudecode', picked: 'default', prompt: 'thanks, what time is it', previous: { tier: 'heavy', turns: 2 }, pinned: true }).model === 'opus');
check('a model the user picked is never touched', R.route({ engine: 'claudecode', picked: 'opus', prompt: 'thanks!' }).auto === false);

// ---- 3. what each engine and provider receives
const cc = ['default', 'fable', 'opus', 'sonnet', 'haiku'].map((m) => ({ id: `claudecode:${m}`, name: m, signedIn: true }));
const claudeApi = [{ id: 'claude-haiku-5-5', name: 'Haiku 5.5' }, { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' }, { id: 'claude-opus-5-5', name: 'Opus 5.5' }];
const codex = [{ id: 'codex:gpt-6-luna', tier: 'fast' }, { id: 'codex:gpt-6.1-sol', tier: 'balanced' }, { id: 'codex:gpt-6-astra', tier: 'strong' }].map((o) => ({ ...o, signedIn: true }));
const openai = [{ id: 'openai:gpt-6-luna' }, { id: 'openai:gpt-6.1-sol' }, { id: 'openai:gpt-6-astra' }];
const gemini = [{ id: 'gemini:gemini-3.5-flash-lite' }, { id: 'gemini:gemini-3.8-flash' }, { id: 'gemini:gemini-3.1-pro-preview' }];
const xai = [{ id: 'xai:grok-4.7-build-fast' }, { id: 'xai:grok-4.7' }];
const engines = { 'Claude Code': [cc, 'claudecode'], 'Claude API': [claudeApi, null], 'Codex': [codex, 'codex'], 'OpenAI': [openai, 'openai'], 'Gemini': [gemini, 'gemini'], 'Grok API': [xai, 'xai'] };
// situation prompt -> the model each engine should get (the ids' last part)
const want = {
  'thanks!': { 'Claude Code': 'haiku', 'Claude API': 'claude-haiku-5-5', Codex: 'gpt-6-luna', OpenAI: 'gpt-6-luna', Gemini: 'gemini-3.5-flash-lite', 'Grok API': 'grok-4.7-build-fast' },
  'write a cover letter for a barista job': { 'Claude Code': 'sonnet', 'Claude API': 'claude-sonnet-5-5', Codex: 'gpt-6.1-sol', OpenAI: 'gpt-6.1-sol', Gemini: 'gemini-3.8-flash' },
  'draft an email to my landlord about the broken heater, firm but polite': { 'Claude Code': 'haiku', 'Claude API': 'claude-haiku-5-5', Codex: 'gpt-6-luna', OpenAI: 'gpt-6-luna', Gemini: 'gemini-3.5-flash-lite' },
  'compare these three laptops': { 'Claude Code': 'sonnet', 'Claude API': 'claude-sonnet-5-5', Codex: 'gpt-6.1-sol', OpenAI: 'gpt-6.1-sol', Gemini: 'gemini-3.8-flash' },
  'summarize this article': { 'Claude Code': 'haiku', 'Claude API': 'claude-haiku-5-5', Codex: 'gpt-6-luna', OpenAI: 'gpt-6-luna', Gemini: 'gemini-3.5-flash-lite', 'Grok API': 'grok-4.7-build-fast' },
  'translate this paragraph into French': { 'Claude Code': 'haiku', 'Claude API': 'claude-haiku-5-5', Codex: 'gpt-6-luna', OpenAI: 'gpt-6-luna', Gemini: 'gemini-3.5-flash-lite' },
  // one-step browsing: Haiku 5.5 is a reliable actor; the other small models are not (docs: OSWorld), so they step up one tier
  'open youtube': { 'Claude Code': 'haiku', 'Claude API': 'claude-haiku-5-5', Codex: 'gpt-6.1-sol', OpenAI: 'gpt-6.1-sol', Gemini: 'gemini-3.8-flash', },
  'go to amazon, search for a usb-c cable and add the cheapest one to my cart': { 'Claude Code': 'sonnet', 'Claude API': 'claude-sonnet-5-5', Codex: 'gpt-6.1-sol', OpenAI: 'gpt-6.1-sol', Gemini: 'gemini-3.8-flash' },
  'find sources on intermittent fasting and cite them': { 'Claude Code': 'sonnet', 'Claude API': 'claude-sonnet-5-5', Codex: 'gpt-6.1-sol', OpenAI: 'gpt-6.1-sol', Gemini: 'gemini-3.8-flash' },
  'fix the bug in this function': { 'Claude Code': 'sonnet', 'Claude API': 'claude-sonnet-5-5', Codex: 'gpt-6.1-sol', OpenAI: 'gpt-6.1-sol', Gemini: 'gemini-3.8-flash' },
  'prove that the square root of 2 is irrational': { 'Claude Code': 'opus', 'Claude API': 'claude-opus-5-5', Codex: 'gpt-6-astra', OpenAI: 'gpt-6-astra', Gemini: 'gemini-3.1-pro-preview' },
  'extract the numbers from this invoice': { 'Claude Code': 'sonnet', 'Claude API': 'claude-sonnet-5-5', Codex: 'gpt-6.1-sol', OpenAI: 'gpt-6.1-sol', Gemini: 'gemini-3.8-flash' },
  'draw a logo for my coffee shop': { 'Claude Code': 'haiku', 'Claude API': 'claude-haiku-5-5', OpenAI: 'gpt-6-luna' },
};
for (const [prompt, byEngine] of Object.entries(want)) {
  for (const [name, expected] of Object.entries(byEngine)) {
    const [options, scope] = engines[name];
    const image = /invoice/.test(prompt) ? 1 : 0;
    const d = A.route({ options, request: { prompt, imageCount: image, page: /article/.test(prompt) }, scope });
    check(`${name}: "${prompt.slice(0, 48)}" -> ${expected}`, String(d.id || '').replace(/^[a-z]+:/, '') === expected, `${d.id} (${d.reason})`);
  }
}
check('the reason says what and why: "Auto: Sonnet 5.5 for a multi-step browsing task"', A.route({ options: claudeApi, request: { prompt: 'go to amazon, search for a usb-c cable and add the cheapest one to my cart' } }).reason === 'Auto: Sonnet 5.5 for a multi-step browsing task');
check('the decision carries the situation', A.route({ options: claudeApi, request: { prompt: 'research the best headphones' } }).situation === 'research');

// ---- 4. mixed providers: the cheapest model that is reliably good enough, across providers
const mixed = [...claudeApi, ...openai, ...gemini];
check('quick chat across providers goes to a small model', A.tierOf(A.route({ options: mixed, request: { prompt: 'what time is it in Tokyo' } }).option) === 'fast');
check('one-step browsing across providers goes to Haiku (the small model that is reliable at it), not a cheaper small one', A.route({ options: mixed, request: { prompt: 'open youtube' } }).id === 'claude-haiku-5-5');
check('with no Haiku, a small model is passed over for browsing', A.tierOf(A.route({ options: [...openai, ...gemini], request: { prompt: 'open youtube' } }).option) === 'balanced');
check('a small model still answers browsing when it is all there is', A.route({ options: [openai[0]], request: { prompt: 'open youtube' } }).id === 'openai:gpt-6-luna');
check('browsing is not held back for a model that does not need it: Claude Code Haiku', A.route({ options: cc, request: { prompt: 'search for pizza near me' }, scope: 'claudecode' }).id === 'claudecode:haiku');
check('research: among equals the larger window wins', (() => {
  const a = { id: 'gemini:gemini-3.8-flash', context: 1_000_000 }; const b = { id: 'gemini:gemini-3.7-flash', context: 200_000 };
  return A.route({ options: [b, a], request: { prompt: 'find sources on intermittent fasting' } }).id === 'gemini:gemini-3.8-flash' && A.route({ options: [b, a], request: { prompt: 'what time is it in Tokyo' } }).id === 'gemini:gemini-3.7-flash';
})());
check('named kinds still hold: a translation job stays fast, a classification stays fast', A.needFor({ kind: 'translation' }).tier === 'fast' && A.needFor({ kind: 'classification' }).tier === 'fast');
check('a background task (agentic) is never the smallest model', A.needFor({ kind: 'agentic', prompt: 'check the price of the flight every morning' }).tier !== 'fast' && A.needFor({ kind: 'agentic', prompt: 'hi' }).tier === 'balanced');
check('a background task has agentic needs, a translation has none', A.needFor({ kind: 'agentic', prompt: 'x' }).agentic === true && A.needFor({ kind: 'translation' }).agentic === false);
check('a follow-up keeps the browsing situation across turns', (() => { const n = A.needFor({ prompt: 'continue', previousTier: 'balanced', previousKind: 'browse', turns: 2 }); return n.situation === 'browse' && n.tier === 'balanced'; })());
check('a very long page lifts a page question off the smallest model', A.needFor({ prompt: 'summarize this', page: true, attachmentChars: 100_000 }).tier === 'balanced' && A.needFor({ prompt: 'summarize this', page: true, attachmentChars: 5_000 }).tier === 'fast');
check('/think and /deep still win over the situation', A.needFor({ prompt: 'thanks!', hint: 'think' }).tier === 'strong' && A.needFor({ prompt: 'open youtube', hint: 'fast' }).tier === 'fast');
check('a live CLI session floors the tier (the prompt cache is kept)', A.needFor({ prompt: 'open youtube', floorTier: 'strong' }).tier === 'strong');

// ---- 5. availability, the user's choices and fallback order
const cooldownOn = (ids) => { const cd = fallback.createCooldowns(); for (const id of ids) cd.mark(id, { kind: 'limit', scope: 'model', resetsAt: Date.now() + 600e3 }); return cd; };
const browse = 'go to amazon, search for a usb-c cable and add the cheapest one to my cart';
check('Sonnet out of usage: the next best balanced model answers, then a stronger one', (() => {
  const d = A.route({ options: claudeApi, request: { prompt: browse }, cooldowns: cooldownOn(['claude-sonnet-5-5']) });
  const d2 = A.route({ options: claudeApi.filter((o) => o.id !== 'claude-sonnet-5-5'), request: { prompt: browse }, cooldowns: cooldownOn(['claude-haiku-5-5']) });
  return d.id === 'claude-opus-5-5' && d2.id === 'claude-opus-5-5' && d.candidates.includes('claude-haiku-5-5');
})());
check('Claude out of usage: the other providers answer, and the notice says so', (() => {
  const d = A.route({ options: mixed, request: { prompt: browse }, cooldowns: cooldownOn(claudeApi.map((o) => o.id)) });
  return /gpt-6\.1-sol|gemini-3\.8-flash/.test(d.id) && /skipped: out of usage/.test(d.reason);
})());
check('a provider the user turned off for Auto is not used', A.route({ options: mixed, request: { prompt: browse }, exclude: ['anthropic', 'openai'] }).id === 'gemini:gemini-3.8-flash');
check('a model refused for the account (not on the plan) is left out', A.route({ options: claudeApi, request: { prompt: 'prove that the square root of 2 is irrational' }, denied: new Set(['claude-opus-5-5']) }).id === 'claude-sonnet-5-5');
check('a provider\'s own Auto uses only that provider, even for a task another does better', A.route({ options: mixed, request: { prompt: 'open youtube' }, scope: 'openai' }).id === 'openai:gpt-6.1-sol');
check('a chat-only model is not chosen for browsing but may rewrite', (() => {
  const chatOnly = { id: 'openrouter:vendor/chatty', badges: ['chat only'] };
  return A.route({ options: [chatOnly, claudeApi[0]], request: { prompt: 'open youtube' } }).id === 'claude-haiku-5-5' && A.route({ options: [chatOnly], request: { kind: 'translation' } }).id === chatOnly.id;
})());
check('a text-only model is not chosen for an image', A.route({ options: [{ id: 'xai:grok-3' }, claudeApi[0]], request: { prompt: 'what is in this screenshot?', imageCount: 1 } }).id === 'claude-haiku-5-5');
check('the provider already answering the chat keeps it (no restart of its cache) when tiers match', A.route({ options: mixed, request: { prompt: browse }, prefer: ['openai'] }).id === 'openai:gpt-6.1-sol');
check('the same inputs always give the same answer', JSON.stringify(A.route({ options: mixed, request: { prompt: browse } }).candidates) === JSON.stringify(A.route({ options: mixed.slice().reverse().reverse(), request: { prompt: browse } }).candidates));
check('escalation after a refusal goes one situation-independent tier up', A.escalate({ options: claudeApi, current: 'claude-haiku-5-5', failure: { kind: 'refused' }, request: { prompt: 'open youtube' } })?.id === 'claude-sonnet-5-5');

// ---- 6. the new model names the router must size
for (const [id, tier] of Object.entries({ 'gpt-6-luna': 'fast', 'gpt-6.1-sol': 'balanced', 'gpt-6-astra': 'strong', 'gemini-3.5-flash-lite': 'fast', 'gemini-3.1-flash-lite': 'fast', 'gemini-3.5-flash': 'fast', 'gemini-3.7-flash': 'balanced', 'gemini-3.8-flash': 'balanced', 'gemini-3.1-pro-preview': 'strong', 'claude-haiku-5-5': 'fast', 'claude-sonnet-5-5': 'balanced', 'claude-opus-5-5': 'strong', 'claude-fable-5-1': 'strong' })) check(`tier of ${id} is ${tier}`, A.tierOf(id) === tier, A.tierOf(id));
check('GPT-6 and Grok 4.3+ are known to hold their windows (they were "unknown size" before)', fallback.capsOf('openai:gpt-6-luna').context === 1_050_000 && fallback.capsOf('xai:grok-4.7').context === 500_000);

// ---- 7. each engine's own Default row ("Pick the model for me"): the same router, limited to that engine's models
const { Agent } = require('../src/ai/agent');
const grokOpts = ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6'].map((m) => ({ id: `grokbuild:${m}`, signedIn: true })).concat([{ id: 'grokbuild:default', signedIn: true }]);
const agyOpts = ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.1-pro-high', 'claude-sonnet-4-6'].map((m) => ({ id: `antigravity:${m}`, signedIn: true })).concat([{ id: 'antigravity:default', signedIn: true }]);
const codexOpts = codex.concat([{ id: 'codex:default', signedIn: true }]);
const everything = [...cc, ...claudeApi, ...codexOpts, ...grokOpts, ...agyOpts, ...openai, ...gemini];
function engineRoute(model, text, { on = true, options = everything, settings = {}, imageCount = 0, outOfUsage = [] } = {}) {
  const cd = cooldownOn(outOfUsage);
  const browser = {
    autoModel: () => on,
    autoRoute: ({ request, last, scope }) => A.routeOrFallBack({ options, request, last, scope, cooldowns: cd, allowEngines: true }, { fallbackOn: true, related: [] }),
  };
  const agent = Object.assign(Object.create(Agent.prototype), { browser, aboutCurrentPage: () => false });
  const messages = []; messages.settings = { model, ...settings };
  const events = [];
  agent.routeAuto(messages, { text, images: new Array(imageCount).fill('x'), tabs: [], hint: '', skill: null }, (e) => events.push(e));
  return { model: messages.settings.model, from: messages.settings.autoFrom, tier: messages.settings.autoTier, reason: messages.settings.autoLast?.reason, events };
}
const defaults = {
  Codex: ['codex:default', { 'thanks!': 'gpt-6-luna', 'open youtube': 'gpt-6.1-sol', [browse]: 'gpt-6.1-sol', 'find sources on intermittent fasting and cite them': 'gpt-6.1-sol', 'prove that the square root of 2 is irrational': 'gpt-6-astra' }],
  'Grok Build': ['grokbuild:default', { 'thanks!': 'grok-4.7-build-fast', 'summarize this article': 'grok-4.7-build-fast', 'prove that the square root of 2 is irrational': 'grok-4.7' }],
};
for (const [name, [model, rows]] of Object.entries(defaults)) {
  for (const [prompt, expected] of Object.entries(rows)) {
    const r = engineRoute(model, prompt);
    check(`${name} Default: "${prompt.slice(0, 44)}" -> ${expected}`, r.model.replace(/^[a-z]+:/, '') === expected && r.from === model, JSON.stringify(r));
  }
}
check('Antigravity Default: a hard proof goes to Pro, a sign-off never does', engineRoute('antigravity:default', 'prove that the square root of 2 is irrational').model === 'antigravity:gemini-3.1-pro-high' && engineRoute('antigravity:default', 'thanks!').model !== 'antigravity:gemini-3.1-pro-high');
check('an engine Default never leaves its engine', ['codex:default', 'grokbuild:default', 'antigravity:default'].every((m) => engineRoute(m, 'open youtube').model.split(':')[0] === m.split(':')[0]));
check('Settings > "Pick the model for me" off: the engine\'s Default is left to the CLI', ['codex:default', 'grokbuild:default', 'antigravity:default'].every((m) => engineRoute(m, 'prove that the square root of 2 is irrational', { on: false }).model === m));
check('an engine that lists no models is left on its own Default', engineRoute('codex:default', 'thanks!', { options: [{ id: 'codex:default', signedIn: true }] }).model === 'codex:default');
check('an engine out of usage is left on its Default (the usual fallback then handles it), not sent to another provider', engineRoute('codex:default', 'thanks!', { outOfUsage: codex.map((o) => o.id) }).model === 'codex:default');
check('a model the user picked is never routed', engineRoute('codex:gpt-6-luna', 'prove that the square root of 2 is irrational').model === 'codex:gpt-6-luna' && engineRoute('claudecode:haiku', 'prove that the square root of 2 is irrational').model === 'claudecode:haiku');
check('a live CLI session is pinned: the tier is not lowered by a sign-off (Codex Default)', (() => {
  const r = engineRoute('codex:default', 'thanks!', { settings: { cxSession: 'sess', autoTier: 'strong' } });
  return r.model === 'codex:gpt-6-astra';
})());
check('the reason says which situation (Codex Default, multi-step browsing)', /^Auto \(Codex\): .*for a multi-step browsing task$/.test(engineRoute('codex:default', browse).reason || ''), engineRoute('codex:default', browse).reason);
// Claude Code's own Default (model-route.js TABLE), the same classifier
for (const [prompt, model] of [['thanks!', 'haiku'], ['open youtube', 'haiku'], [browse, 'sonnet'], ['find sources on intermittent fasting and cite them', 'sonnet'], ['fix the bug in this function', 'sonnet'], ['prove that the square root of 2 is irrational', 'opus']]) {
  check(`Claude Code Default: "${prompt.slice(0, 44)}" -> ${model}`, R.route({ engine: 'claudecode', picked: 'default', prompt }).model === model);
}
check('the Claude API, OpenAI, Gemini and Grok API have no Default row: their own Auto is the way (scope tests above)', ['anthropic', 'openai', 'gemini', 'xai'].every((p) => A.ownDefaultScope(`${p}:default`) === null) && A.ownDefaultScope('codex:default') === 'codex');

console.log(failures ? `\n${failures} FAILED` : '\nAll auto-situations checks passed');
process.exit(failures ? 1 : 0);
