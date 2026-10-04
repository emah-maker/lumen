// Token and cost totals per chat, shown in the sidebar and the chat history list.
// Pure functions: the agent calls addUsage() after each model turn with the provider's own usage
// numbers; nothing here makes a request. Costs are estimates from the table below (list prices, per
// million tokens). A model not in the table still counts tokens; its cost shows as unknown. OpenRouter
// and the CLI engines report their own cost, which is used as is.

// $ per 1M tokens: input, output, cache write, cache read.
const PRICES = {
  'claude-fable-5-1': { in: 10, out: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'claude-opus-5-5': { in: 4, out: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-opus-5': { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5': { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-4-5': { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'xai:grok-4': { in: 3, out: 15 },
  'gemini:gemini-2.5-pro': { in: 1.25, out: 10 },
  'gemini:gemini-2.5-flash': { in: 0.3, out: 2.5 },
};

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unpriced: 0, turns: 0 });

const num = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : 0);

// One turn's usage in a common shape, from an Anthropic message's `usage` or a Chat Completions
// chunk's `usage` (prompt/completion tokens; OpenRouter adds `cost`).
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if ('input_tokens' in raw || 'output_tokens' in raw) {
    return {
      input: num(raw.input_tokens),
      output: num(raw.output_tokens),
      cacheWrite: num(raw.cache_creation_input_tokens),
      cacheRead: num(raw.cache_read_input_tokens),
      cost: null,
    };
  }
  if ('prompt_tokens' in raw || 'completion_tokens' in raw) {
    const cached = num(raw.prompt_tokens_details?.cached_tokens);
    return {
      input: Math.max(0, num(raw.prompt_tokens) - cached),
      output: num(raw.completion_tokens),
      cacheWrite: 0,
      cacheRead: cached,
      cost: raw.cost === undefined ? null : num(raw.cost),
    };
  }
  return null;
}

// Estimated $ for one turn on `model` (a picker id: 'claude-opus-5', 'xai:grok-4', …), or null.
function priceTurn(model, turn) {
  const p = PRICES[model];
  if (!p) return null;
  const cacheRead = p.cacheRead ?? p.in * 0.1;
  const cacheWrite = p.cacheWrite ?? p.in;
  return (turn.input * p.in + turn.output * p.out + turn.cacheRead * cacheRead + turn.cacheWrite * cacheWrite) / 1e6;
}

// `total` plus one turn, as a new object. `entry` is { model, usage } (the provider's raw usage)
// and/or { cost } (a total the engine reported itself, in $: OpenRouter, Claude Code, Grok Build).
function addUsage(total, { model, usage, cost } = {}) {
  const t = { ...emptyUsage(), ...(total && typeof total === 'object' ? total : {}) };
  const turn = usage ? normalize(usage) : null;
  if (turn) {
    t.input += turn.input;
    t.output += turn.output;
    t.cacheRead += turn.cacheRead;
    t.cacheWrite += turn.cacheWrite;
  }
  const reported = typeof cost === 'number' && Number.isFinite(cost) ? cost : turn?.cost ?? null;
  const priced = reported !== null ? reported : turn ? priceTurn(String(model || ''), turn) : null;
  if (priced === null) t.unpriced += 1;
  else t.cost += priced;
  t.turns += 1;
  return t;
}

const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

// "12.3k tokens · ~$0.04", "~$0.01 (Claude Code)", or '' for a chat with no turns yet.
function describeUsage(u) {
  if (!u || !u.turns) return '';
  const tokens = u.input + u.output + u.cacheRead + u.cacheWrite;
  const parts = [];
  if (tokens) parts.push(`${compact(tokens)} tokens`);
  if (u.cost > 0) parts.push(`~$${u.cost < 0.01 ? u.cost.toFixed(4) : u.cost.toFixed(2)}${u.unpriced ? '+' : ''}`);
  else if (u.unpriced) parts.push('cost n/a');
  return parts.join(' · ');
}

// ---------- context: how full the chat's context window is ----------
// A chat's settings.context is { tokens, window, at, estimated? }: what the model had in view on the chat's last
// request (its whole input: fresh, cache reads and cache writes; not the turn's summed input, which counts a tool
// loop's context once per call), and the window of the model that answered. `estimated`: worked out by Lumen (after
// a /compact, before the next request reports the real figure). The meter under the composer shows it; /context
// shows it in words.
const DEFAULT_WINDOW = 200_000;

// Tokens in context for one request, from its raw usage (an Anthropic message's or a Chat Completions chunk's).
function contextTokensOf(raw) {
  const t = normalize(raw);
  return t ? t.input + t.cacheRead + t.cacheWrite : 0;
}

// The window to measure against: what the engine reported (Claude Code's modelUsage, Grok's catalog, the
// fallback table for API models), else 1M for a `[1m]` model id, the engine's usual one, and 200k for anything else.
// Codex's exec stream and Antigravity give tokens but no window: Codex's own session logs name 272k for its GPT-5
// models, Gemini's models take 1M, and Grok Build's catalog reports its own (256k only before it has).
const ENGINE_WINDOWS = { 'codex:': 272_000, 'antigravity:': 1_000_000, 'grokbuild:': 256_000 };
function windowFor(model, reported) {
  if (Number(reported) > 0) return Number(reported);
  if (/\[1m\]/i.test(String(model || ''))) return 1_000_000;
  const prefix = Object.keys(ENGINE_WINDOWS).find((p) => String(model || '').startsWith(p));
  return prefix ? ENGINE_WINDOWS[prefix] : DEFAULT_WINDOW;
}

// Records the chat's context on its settings; returns it (null when there is nothing real to record).
function setContext(settings, { tokens, window, model, estimated = false, now = Date.now() } = {}) {
  if (!settings || !(Number(tokens) >= 0) || !Number.isFinite(Number(tokens))) return null;
  settings.context = { tokens: Math.round(Number(tokens)), window: windowFor(model, window), at: now, ...(estimated ? { estimated: true } : {}) };
  return settings.context;
}

// What the renderer gets for a chat: { tokens, window, percent (0 to 100), estimated }, or null when unknown.
function contextView(ctx) {
  if (!ctx || !(ctx.window > 0) || !Number.isFinite(ctx.tokens)) return null;
  return { tokens: ctx.tokens, window: ctx.window, percent: Math.max(0, Math.min(100, (ctx.tokens / ctx.window) * 100)), estimated: Boolean(ctx.estimated) };
}

// "18.1k" -> 18100, "1M" -> 1000000, "2,048" -> 2048.
function parseCount(text) {
  const m = /^([\d.,]+)\s*([kKmM]?)$/.exec(String(text || '').trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * (/k/i.test(m[2]) ? 1e3 : /m/i.test(m[2]) ? 1e6 : 1)) : null;
}

// Claude Code's /context report ("**Tokens:** 18.1k / 200k (9%)", checked against 2.1.287): { tokens, window } or null.
function parseContextReport(text) {
  const m = /Tokens:?\**:?\s*([\d.,]+\s*[kKmM]?)\s*\/\s*([\d.,]+\s*[kKmM]?)/.exec(String(text || ''));
  if (!m) return null;
  const tokens = parseCount(m[1]);
  const window = parseCount(m[2]);
  return tokens != null && window > 0 ? { tokens, window } : null;
}

module.exports = { PRICES, addUsage, describeUsage, normalize, priceTurn, emptyUsage, contextTokensOf, windowFor, setContext, contextView, parseCount, parseContextReport, shortCount: compact, DEFAULT_WINDOW, ENGINE_WINDOWS };
