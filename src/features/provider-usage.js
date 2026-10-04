// Usage for every AI, not just Claude Code: the pieces that read what a provider tells us for free and count what Lumen did.
// Pure (no Electron, no network, no settings): features/usage.js keeps the log and the readings, Settings → Usage and the
// AI status card draw them, test/provider-usage-units.js runs all of it.
//
//   PROVIDERS                 every AI Lumen can use: key, name, kind ('cli' | 'api') and what its plan data can be
//   parseRateLimitHeaders()   x-ratelimit-* (OpenAI, xAI, OpenRouter) / anthropic-ratelimit-* response headers -> buckets
//   mergeRate / rateView      the newest reading per provider, and what a panel shows from it
//   antigravityLimit()        Antigravity's quota text ("Resets in 110h") -> { text, resetsAt, model }
//   totalsByProvider()        what Lumen itself counted per provider: today, 7 days, per day, per model, last use
//   costOf()                  estimated list-price cost of an API turn from features/chat-usage.js PRICES (null: unknown)
//
// Nothing here is a made-up number: a provider with no plan API has no plan percentage, only Lumen's own counts.
const chatUsage = require('./chat-usage');
const { limitOf, isLimitText, parseResetTime } = require('./grok-limit');

const DAY = 24 * 60 * 60 * 1000;

// plan: what the provider lets Lumen read about its limits.
//   'windows'   5-hour / weekly windows with a percent and a reset (Claude Code; Codex from its session logs)
//   'message'   only the limit-reached text and its reset time, when a run hits it (Grok Build, Antigravity)
//   'headers'   rate-limit headers on the responses Lumen already gets (OpenAI, Anthropic, xAI, OpenRouter): per-minute
//               request / token limits, not a plan balance
//   'none'      nothing at all (Gemini's OpenAI-compatible endpoint sends no limit headers)
const PROVIDERS = [
  { key: 'claudecode', name: 'Claude Code', kind: 'cli', plan: 'windows' },
  { key: 'grokbuild', name: 'Grok Build', kind: 'cli', plan: 'message' },
  { key: 'codex', name: 'Codex CLI', kind: 'cli', plan: 'windows' },
  { key: 'antigravity', name: 'Antigravity', kind: 'cli', plan: 'message' },
  { key: 'anthropic', name: 'Claude (API key)', kind: 'api', plan: 'headers' },
  { key: 'openai', name: 'OpenAI', kind: 'api', plan: 'headers' },
  { key: 'xai', name: 'Grok (API key)', kind: 'api', plan: 'headers' },
  { key: 'gemini', name: 'Gemini', kind: 'api', plan: 'none' },
  { key: 'openrouter', name: 'OpenRouter', kind: 'api', plan: 'headers' },
];
const KEYS = PROVIDERS.map((p) => p.key);
const nameOf = (key) => (PROVIDERS.find((p) => p.key === key) || {}).name || key;

// Why a provider has no plan numbers, in the words the panel uses.
function noPlanText(key) {
  const p = PROVIDERS.find((x) => x.key === key);
  if (!p || p.plan === 'windows') return ''; // (Claude Code and Codex publish windows: nothing to explain)
  if (key === 'grokbuild') return 'Grok Build publishes no plan limits: no command or field carries them. Lumen shows its own counts, and the limit message with its reset time if Grok reports one.';
  if (key === 'antigravity') return 'Antigravity publishes no plan limits. Lumen shows its own counts, and the quota message with its reset time (for example “Resets in 110h”) when a run hits the limit.';
  if (p.plan === 'headers') return `Plan limits are not available from ${p.name}: an API key has no plan balance Lumen can read. It shows its own counts, and ${p.name}’s per-minute rate limits when a reply carried them.`;
  return `Plan limits are not available from ${p.name}. Lumen shows what it counted itself.`;
}

// ---------- rate-limit response headers ----------
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const header = (h, name) => {
  if (!h) return null;
  if (typeof h.get === 'function') return h.get(name);
  const lower = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === lower) return Array.isArray(h[k]) ? h[k][0] : h[k];
  return null;
};

// "1s", "6m0s", "20ms", "1h2m3.5s", "1.5s", "45" (seconds) -> ms, or null.
function parseDuration(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (/^\d+(?:\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|d|h|m|s)/g;
  let total = 0;
  let used = 0;
  for (const m of s.matchAll(re)) { total += Number(m[1]) * { ms: 1, s: 1e3, m: 6e4, h: 36e5, d: DAY }[m[2]]; used += m[0].length; }
  return used === s.replace(/\s+/g, '').length && used > 0 ? Math.round(total) : null;
}

const BUCKETS = [
  // [kind, OpenAI-style suffix, Anthropic-style prefix]
  ['requests', 'requests', 'requests'],
  ['tokens', 'tokens', 'tokens'],
  ['inputTokens', null, 'input-tokens'],
  ['outputTokens', null, 'output-tokens'],
];

// The rate-limit buckets one response carried: { provider, at, buckets: [{ kind, limit, remaining, resetsAt, percent }], retryAfter } or null.
// headers: a fetch Headers (get) or a plain object. OpenAI, xAI and OpenRouter name them x-ratelimit-<limit|remaining|reset>-<requests|tokens>
// (reset is a duration: "6m0s"); Anthropic names them anthropic-ratelimit-<requests|tokens|input-tokens|output-tokens>-<limit|remaining|reset>
// (reset is an RFC 3339 time). Gemini's compatible endpoint sends none.
function parseRateLimitHeaders(provider, headers, now = Date.now()) {
  const buckets = [];
  for (const [kind, openaiName, anthropicName] of BUCKETS) {
    let limit; let remaining; let reset;
    if (provider === 'anthropic') {
      if (!anthropicName) continue;
      limit = num(header(headers, `anthropic-ratelimit-${anthropicName}-limit`));
      remaining = num(header(headers, `anthropic-ratelimit-${anthropicName}-remaining`));
      const at = header(headers, `anthropic-ratelimit-${anthropicName}-reset`);
      reset = at && Number.isFinite(Date.parse(at)) ? Date.parse(at) : null;
    } else {
      if (!openaiName) continue;
      limit = num(header(headers, `x-ratelimit-limit-${openaiName}`));
      remaining = num(header(headers, `x-ratelimit-remaining-${openaiName}`));
      const d = parseDuration(header(headers, `x-ratelimit-reset-${openaiName}`));
      reset = d == null ? null : now + d;
    }
    if (limit == null || !(limit > 0) || remaining == null) continue;
    const used = Math.max(0, Math.min(limit, limit - remaining));
    buckets.push({ kind, limit, remaining: Math.max(0, remaining), resetsAt: reset, percent: (used / limit) * 100 });
  }
  const retry = header(headers, 'retry-after');
  const retryAfter = parseDuration(retry);
  if (!buckets.length && retryAfter == null) return null;
  return { provider, at: now, buckets, ...(retryAfter != null ? { retryAfter } : {}) };
}

// The newest reading wins per bucket kind (a later response may carry fewer buckets); numbers only.
function mergeRate(prev, next) {
  if (!next) return prev || null;
  if (!prev) return next;
  const by = new Map((prev.buckets || []).map((b) => [b.kind, b]));
  for (const b of next.buckets || []) by.set(b.kind, b);
  return { ...next, buckets: [...by.values()] };
}

// What a panel shows from a reading: each bucket with a label, percent used, and `expired` once its reset has passed.
const BUCKET_LABELS = { requests: 'Requests per minute', tokens: 'Tokens per minute', inputTokens: 'Input tokens per minute', outputTokens: 'Output tokens per minute' };
function rateView(reading, now = Date.now()) {
  if (!reading || !Array.isArray(reading.buckets) || !reading.buckets.length) return null;
  const buckets = reading.buckets.map((b) => ({
    kind: b.kind, label: BUCKET_LABELS[b.kind] || b.kind, limit: b.limit, remaining: b.remaining, percent: Math.max(0, Math.min(100, b.percent)),
    resetsAt: b.resetsAt ?? null, expired: b.resetsAt != null && b.resetsAt <= now,
  }));
  return { at: reading.at, buckets, tightest: buckets.filter((b) => !b.expired).reduce((a, b) => (!a || b.percent > a.percent ? b : a), null) };
}

// ---------- Antigravity: the quota message ----------
const AGY_LIMIT = /resource[_ ]exhausted|out of credits|credits? (have )?(run|ran) out|insufficient credits|quota/i;
// "RESOURCE_EXHAUSTED: Quota exceeded for gemini-3.1-pro. Resets in 110h" -> { text, resetsAt (ms | null), model | null }, or null when the text isn't a limit.
function antigravityLimit(text, now = Date.now()) {
  const t = String(text || '');
  const base = limitOf(t, now) || (AGY_LIMIT.test(t) ? { text: t.trim().split('\n')[0].slice(0, 200), resetsAt: parseResetTime(t, now) } : null);
  if (!base) return null;
  const model = /\b((?:gemini|claude|gpt|grok)[\w.-]*(?:\s*\((?:low|medium|high)\))?)/i.exec(t);
  return { ...base, model: model ? model[1].trim().slice(0, 60) : null };
}

// ---------- what Lumen counted ----------
const recTokens = (r) => (r.inputTokens || 0) + (r.outputTokens || 0) + (r.cacheReadTokens || 0) + (r.cacheWriteTokens || 0);
const blank = () => ({ turns: 0, tokens: 0, costUSD: 0, unpriced: 0 });
const add = (a, r) => { a.turns++; a.tokens += recTokens(r); a.costUSD += r.costUSD || 0; if (r.unpriced) a.unpriced++; return a; };
const dayStart = (ms) => new Date(ms).setHours(0, 0, 0, 0);

// The estimated list-price cost of one API turn, or null when the model isn't in the price table (and the provider reported none).
// usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }; `model`: the id the table uses ('claude-opus-5-5', 'xai:grok-4').
function costOf(model, usage) {
  if (!usage) return null;
  const turn = { input: usage.inputTokens || 0, output: usage.outputTokens || 0, cacheRead: usage.cacheReadTokens || 0, cacheWrite: usage.cacheWriteTokens || 0 };
  return chatUsage.priceTurn(String(model || ''), turn);
}

// One API turn's usage in the log's shape, from the provider's raw `usage` (an Anthropic message's or a Chat Completions chunk's):
// { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUSD (null: no price known), models }. null without usage.
// The cost is what the provider reported (OpenRouter), else the list-price estimate for the model, else null: never invented.
function turnUsage(model, raw) {
  const t = chatUsage.normalize(raw);
  if (!t) return null;
  const costUSD = t.cost !== null && t.cost !== undefined ? t.cost : chatUsage.priceTurn(String(model || ''), t);
  return { inputTokens: t.input, outputTokens: t.output, cacheReadTokens: t.cacheRead, cacheWriteTokens: t.cacheWrite, costUSD, models: model ? [String(model)] : [] };
}

// Per provider (the log's `engine`): { today, week, days: [7 x { start, turns, tokens, costUSD }] oldest first, models: [{ model, turns, tokens, costUSD }] (week, busiest first),
// lastAt, lastModel }. Providers with no record in the last 7 days are left out.
function totalsByProvider(records, now = Date.now()) {
  const todayStart = dayStart(now);
  const weekStart = todayStart - 6 * DAY;
  const out = {};
  for (const r of records || []) {
    if (!r || !Number.isFinite(r.at) || r.at < weekStart || r.at > now + 60e3) continue;
    const e = (out[r.engine] ||= { today: blank(), week: blank(), days: Array.from({ length: 7 }, (_, i) => ({ start: weekStart + i * DAY, ...blank() })), models: new Map(), lastAt: 0, lastModel: null });
    add(e.week, r);
    if (r.at >= todayStart) add(e.today, r);
    add(e.days[Math.min(6, Math.max(0, Math.floor((dayStart(r.at) - weekStart) / DAY)))], r);
    const m = e.models.get(r.model || 'unknown') || { model: r.model || null, ...blank() };
    add(m, r);
    e.models.set(r.model || 'unknown', m);
    if (r.at >= e.lastAt) { e.lastAt = r.at; e.lastModel = r.model || null; }
  }
  for (const e of Object.values(out)) e.models = [...e.models.values()].sort((a, b) => b.tokens - a.tokens || b.turns - a.turns).slice(0, 8);
  return out;
}

module.exports = { PROVIDERS, KEYS, nameOf, noPlanText, parseDuration, parseRateLimitHeaders, mergeRate, rateView, antigravityLimit, totalsByProvider, costOf, turnUsage, recTokens, isLimitText };
