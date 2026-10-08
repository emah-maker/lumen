// Auto -> what each engine really receives (docs/auto-model.md). "auto" is never a model name: Auto's choice is a concrete picker
// id, and each engine turns it into its own argument at spawn time:
//   Claude Code  claude --model <alias>        (claude --help: --model <model>; 'default' passes no flag)
//   Grok Build   grok --model <id> (-m)         (grok --help: -m, --model <MODEL>; `grok models` lists them)
//   Antigravity  agy --model <slug>             (agy --help: --model; `agy models` lists them)
//   API          provider + model id in the request body (providers.splitModel; Anthropic's ids bare)
// The CLIs and providers are not run: this reads the argv / request fields the engines build.
const A = require('../src/ai/auto-model');
const providers = require('../src/ai/providers');
const { engineModel } = require('../src/ai/cli-utils');
const claude = require('../src/ai/claude-code');
const grok = require('../src/ai/grok-build');
const agy = require('../src/ai/antigravity');
const cliJson = require('../src/ai/cli-json');
const { claudeCodeOptions, grokBuildOptions, antigravityOptions } = require('../src/features/ai-agents');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const after = (argv, flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };
const HEAVY = ['Refactor the checkout flow across the codebase and debug why the cart total is wrong.', '1. Investigate the root cause in cart.js and pricing.js', '2. Design a fix that handles concurrent updates', '3. Write tests, then migrate the old orders', '4. Also make sure the API docs stay accurate'].join('\n');
const FAST = { prompt: 'what time is it in Tokyo' };
const route = (options, request) => A.route({ options, request });

// ---- Claude Code
const cc = claudeCodeOptions({ signedIn: true });
const ccArgs = (id) => claude.buildArgs({ mcpConfig: 'm', sessionId: 's', resume: false, systemPrompt: 'p', model: engineModel(id) });
let pick = route(cc, FAST);
check('Claude Code, quick: haiku, as `--model haiku`', pick.id === 'claudecode:haiku' && after(ccArgs(pick.id), '--model') === 'haiku', JSON.stringify([pick.id, ccArgs(pick.id)]));
pick = route(cc, { prompt: 'find the cheapest flight from Boston to Denver next month on this site' });
check('Claude Code, an everyday browsing task: haiku (Haiku 5.5 is capable enough)', pick.id === 'claudecode:haiku', pick.id);
pick = route(cc, { prompt: 'fix the login bug on this page' });
check('Claude Code, code: sonnet', pick.id === 'claudecode:sonnet' && after(ccArgs(pick.id), '--model') === 'sonnet', pick.id);
pick = route(cc, { prompt: HEAVY });
check('Claude Code, hard: a strong model (opus or fable), never "auto"', ['claudecode:opus', 'claudecode:fable'].includes(pick.id) && !ccArgs(pick.id).includes('auto'), pick.id);
check('Claude Code with only its own default: no --model flag (the CLI chooses: native auto)', (() => { const only = [cc.find((o) => o.id === 'claudecode:default')]; const p = route(only, FAST); return p.id === 'claudecode:default' && after(ccArgs(p.id), '--model') === null; })());
check('the argv never has "auto" in it, whatever the choice', ['hi', 'x'.repeat(5000), HEAVY].every((t) => !ccArgs(route(cc, { prompt: t }).id).includes('auto')));
check('a CLI-run background job (cli-json) gets the same alias', cliJson.claudeArgs({ system: 's', schema: {}, model: engineModel(route(cc, { kind: 'classification', tools: false }).id) }).includes('haiku'));

// ---- Grok Build (models as `grok models` lists them, grok 1.0.x)
const gb = grokBuildOptions({ signedIn: true, models: ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6'] });
const gbArgs = (id) => grok.buildArgs({ promptFile: 'f', sessionId: 's', resume: false, systemPrompt: 'p', cwd: 'c', model: engineModel(id) });
pick = route(gb, FAST);
check('Grok Build, quick: the fast build model, as `--model grok-4.7-build-fast`', pick.id === 'grokbuild:grok-4.7-build-fast' && after(gbArgs(pick.id), '--model') === 'grok-4.7-build-fast', JSON.stringify([pick.id, after(gbArgs(pick.id), '--model')]));
pick = route(gb, { prompt: HEAVY });
check('Grok Build, hard: a strong model, passed with --model', pick.id.startsWith('grokbuild:grok-4') && after(gbArgs(pick.id), '--model') === engineModel(pick.id) && !gbArgs(pick.id).includes('auto'), pick.id);
check('Grok Build with no models listed: its default, no --model flag (native default)', (() => { const only = grokBuildOptions({ signedIn: true, models: [] }).filter((o) => o.id === 'grokbuild:default'); const p = route(only, FAST); return p.id === 'grokbuild:default' && after(gbArgs(p.id), '--model') === null; })());

// ---- Antigravity
const ag = antigravityOptions({ signedIn: true, models: ['gemini-3.1-pro-high', 'gemini-3-flash'], names: {} });
const agArgs = (id) => agy.buildArgs({ prompt: 'p', model: engineModel(id) });
pick = route(ag, FAST);
check('Antigravity, quick: the flash model, as `--model gemini-3-flash`', pick.id === 'antigravity:gemini-3-flash' && after(agArgs(pick.id), '--model') === 'gemini-3-flash', pick.id);
pick = route(ag, { prompt: HEAVY });
check('Antigravity, hard: the pro model', pick.id === 'antigravity:gemini-3.1-pro-high' && after(agArgs(pick.id), '--model') === 'gemini-3.1-pro-high', pick.id);
check('Antigravity with no models listed: its default, no --model flag', (() => { const only = antigravityOptions({ signedIn: true, models: [] }).filter((o) => o.id === 'antigravity:default'); const p = route(only, FAST); return p.id === 'antigravity:default' && after(agArgs(p.id), '--model') === null; })());

// ---- API providers: the request carries the provider and the concrete model
const api = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', group: 'Claude' }, { id: 'claude-sonnet-5', label: 'Sonnet 5', group: 'Claude' }, { id: 'claude-haiku-5-5', label: 'Haiku 5.5', group: 'Claude' },
  { id: 'openai:gpt-5.6', label: 'GPT-5.6', group: 'OpenAI' }, { id: 'openai:gpt-5.6-mini', label: 'GPT-5.6 mini', group: 'OpenAI' },
  { id: 'xai:grok-4', label: 'Grok 4', group: 'Grok' }, { id: 'gemini:gemini-2.5-pro', label: 'Gemini 2.5 Pro', group: 'Gemini' }, { id: 'gemini:gemini-2.5-flash', label: 'Gemini 2.5 Flash', group: 'Gemini' },
  { id: 'openrouter:anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', group: 'OpenRouter' }, { id: 'openrouter:openai/gpt-5.6', label: 'GPT-5.6', group: 'OpenRouter' }, { id: 'openrouter:google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', group: 'OpenRouter' },
];
for (const [scope, fast, strong] of [['anthropic', 'claude-haiku-5-5', 'claude-opus-5-5'], ['openai', 'gpt-5.6-mini', 'gpt-5.6'], ['gemini', 'gemini-2.5-flash', 'gemini-2.5-pro'], ['openrouter', 'google/gemini-2.5-flash', null]]) {
  const f = A.route({ options: api, request: FAST, scope });
  const s = A.route({ options: api, request: { prompt: HEAVY }, scope });
  const fs = providers.splitModel(f.id);
  check(`${scope}: quick -> ${fast} (provider and model split cleanly, no "auto")`, fs.provider === scope && fs.model === fast, JSON.stringify([f.id, fs]));
  if (strong) check(`${scope}: hard -> ${strong}`, providers.splitModel(s.id).model === strong, s.id);
}
check('Grok (xAI) with one model: that model for everything', ['xai:grok-4'].every((id) => A.route({ options: api, request: FAST, scope: 'xai' }).id === id));
check('OpenRouter: the picked row\'s own vendor/model id is passed through untouched', providers.splitModel(A.route({ options: api, request: { prompt: 'x' }, scope: 'openrouter' }).id).model.includes('/'));
check('local models (Ollama through OpenRouter-style ids) are routed like any other option', A.route({ options: [{ id: 'openrouter:meta-llama/llama-3.3-70b-instruct', label: 'Llama 3.3 70B' }, { id: 'openrouter:meta-llama/llama-3.1-8b-instruct', label: 'Llama 3.1 8B' }], request: FAST }).id.endsWith('8b-instruct'));

// ---- usage and cost: a decision is always a real model id
const everything = [...cc, ...gb, ...ag, ...api];
check('no decision, for any request, is ever "auto" or an engine default while the engine lists models', ['hi', HEAVY, '/think x'.slice(7), 'x'.repeat(100_000)].every((t) => { const d = route(everything, { prompt: t }); return d.id && d.id !== 'auto' && !/:default$/.test(d.id); }));

if (failures) { console.log(`\n${failures} auto-engines check(s) failed`); process.exit(1); }
console.log('\nAll auto-engines checks passed');
