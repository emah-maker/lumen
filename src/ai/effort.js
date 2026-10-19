// Reasoning effort per AI: the one place that knows which levels each engine or provider takes and how each is passed.
// Settings → AI → "AI providers" keeps one choice per provider in the `aiEffort` setting ({ claudecode: 'high', openai: 'low', … }).
// '' (or no entry) means "the provider's own default": nothing is passed and nothing changes. Pure: no I/O.
//
// How each one takes it (flag names checked offline against `--help`, no model call made):
//   claudecode   claude --effort <low|medium|high|xhigh|max>                        (claude 2.1.288)
//   grokbuild    grok --reasoning-effort <level> (alias --effort); the help names no list, the common three are offered (grok 1.0.46)
//   antigravity  agy --effort <low|medium|high|xhigh|max>                           (agy 1.2.16)
//   codex        codex exec -c model_reasoning_effort=<level>; `codex debug models` lists low..max per model (codex-cli 0.160.0)
//   anthropic    output_config.effort on the Messages API (only models Lumen already sends an effort to)
//   openai       reasoning_effort on Chat Completions (reasoning models: o-series, gpt-5)
//   xai          reasoning_effort (grok-3-mini only: the other Grok models reject it)
//   gemini       reasoning_effort on the OpenAI-compatible endpoint (Gemini 2.5 and newer)
//   openrouter   reasoning: { effort } (a model that doesn't reason ignores it)

const LEVELS = {
  claudecode: ['low', 'medium', 'high', 'xhigh', 'max'],
  grokbuild: ['low', 'medium', 'high'],
  antigravity: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max'],
  anthropic: ['low', 'medium', 'high'],
  openai: ['minimal', 'low', 'medium', 'high'],
  xai: ['low', 'high'],
  gemini: ['low', 'medium', 'high'],
  openrouter: ['low', 'medium', 'high'],
};
const KEYS = Object.keys(LEVELS);

// A saved value for one provider, or '' when it is not one of that provider's levels.
const clean = (key, value) => (LEVELS[key] && LEVELS[key].includes(String(value || '').toLowerCase()) ? String(value).toLowerCase() : '');

// The whole setting from anything a settings file or page could hold: { key: level } with only valid, non-default entries.
function cleanAll(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const key of KEYS) { const v = clean(key, value[key]); if (v) out[key] = v; }
  return out;
}

// [anthropic] Models whose requests Lumen already sends an effort to (agent.js MODELS[id].effort) take the choice.
const API_MODELS = {
  openai: /^(o\d|gpt-5)/i,
  xai: /grok-3-mini/i,
  gemini: /^gemini-(2\.5|[3-9])/i,
};

// The extra fields for a Chat Completions request on `provider` / `model` (the bare id), or {} when nothing applies.
function chatParams(provider, model, level) {
  const v = clean(provider, level);
  if (!v) return {};
  if (provider === 'openrouter') return { reasoning: { effort: v } };
  const only = API_MODELS[provider];
  return only && only.test(String(model || '')) ? { reasoning_effort: v } : {};
}

// The effort for a Messages API request: only for a model that already carries one (agent.js MODELS[id].effort); else null.
const anthropicEffort = (level, modelHasEffort) => (modelHasEffort ? clean('anthropic', level) || null : null);

// The argv for each CLI ([] for the default).
function cliArgs(engine, level) {
  const v = clean(engine, level);
  if (!v) return [];
  if (engine === 'claudecode' || engine === 'antigravity') return ['--effort', v];
  if (engine === 'grokbuild') return ['--reasoning-effort', v];
  if (engine === 'codex') return ['-c', `model_reasoning_effort=${v}`]; // not valid TOML on its own: Codex then takes the text as it is (codex exec --help), and there is no quote for a .cmd shim to mangle
  return [];
}

const LABELS = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum' };

module.exports = { LEVELS, KEYS, LABELS, clean, cleanAll, chatParams, anthropicEffort, cliArgs };
