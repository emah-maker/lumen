// Automatic model fallback: when the model a chat uses is out of usage or can't be reached, the same
// turn goes on another model the user has set up, and the unavailable one is left alone for a while.
// Pure: no Electron, no network, no settings. agent.js and main.js hand it errors and the picker's
// option list, and ask it what to do (classify, mark, pick, resolve, noticeFor).
//
//   classify(error)   what kind of failure it is:
//                       limit        usage, rate or quota (with the reset time when the error names one)
//                       unreachable  network, DNS, a timeout, a 5xx or "overloaded"
//                       auth         not signed in, or a rejected or missing key
//                       other        anything else (a bad request, a content refusal, a stop)
//                     Only `limit` and `unreachable` ever lead to a switch.
//   cooldowns         which models are being left alone, and until when (in memory, shared by every
//                     chat and AI feature: one chat finding Opus limited steers the others too)
//   order / pick      the next usable model: same provider first (Opus -> Sonnet -> Haiku), then the
//                     same vendor's other route (Claude API <-> Claude Code, Grok API <-> Grok Build),
//                     then every other connected provider. Never a model that isn't in `options`.
//   resolve           at the start of a turn: the user's pick, or its stand-in while it cools down
//   noticeFor         the one quiet line the chat shows

const { limitOf, parseResetTime } = require('../features/grok-limit');

const MINUTE = 60e3;
const COOLDOWN = {
  unreachable: 15 * MINUTE, // network, timeout, 5xx, overloaded
  rate: 10 * MINUTE, // an API 429 that names no reset time (these clear within minutes)
  plan: 30 * MINUTE, // "usage limit reached" text that names no reset time (a plan window, hours long)
  min: 30e3, // a reset time that is nearly now still leaves the model alone this long
  max: 8 * 24 * 60 * MINUTE, // a weekly limit can be days away; a misread date is never trusted further than this
};
const MAX_HOPS = 3; // switches within one turn

// ---------- classification ----------

const NET_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EPIPE', 'ENETUNREACH', 'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN', 'ERR_NETWORK', 'ERR_NETWORK_CHANGED', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_ABORTED', 'ERR_SOCKET_CONNECTION_TIMEOUT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED']);
const CONTEXT_RE = /prompt is too long|context (length|window)|maximum context|too many tokens|reduce the length|exceeds the (maximum|max) (number of )?(input )?tokens/i;
const TEXT_LIMIT_RE = /usage limit|limit reached|reached (your|the) (\w+ )?limit|hit your (\w+ )?limit|rate.?limit|out of (extra )?usage|\bquota\b|insufficient[_ ]quota|resource[_ ]exhausted|credit balance is too low|credits? (have )?(run|ran) out|out of credits|insufficient (credits|funds|balance)|weekly limit|monthly (spend|usage)? ?limit|spend limit|billing/i;
const TEXT_AUTH_RE = /not (signed|logged)[ -]?in|sign(ed)?[ -]?in (has )?expired|please (run|sign) ?in|\/login|run `?grok login|add your [\w ]*api key|no api key|invalid (x-)?api[ -]?key|api key (was )?(rejected|invalid|not valid|missing)|no api key|unauthori[sz]ed|authentication[_ ]error|invalid[_ ]authentication|permission[_ ]error|oauth token (has )?expired|credentials/i;
const TEXT_NET_RE = /fetch failed|connection error|network (error|is unreachable|request failed)|socket hang up|timed? ?out|timeout|ENOTFOUND|getaddrinfo|ECONN(RESET|REFUSED|ABORTED)|EAI_AGAIN|ENETUNREACH|ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_\w+|NETWORK_\w+|TIMED_OUT|PROXY_\w+|EMPTY_RESPONSE)|overloaded|service unavailable|bad gateway|gateway time-?out|temporarily unavailable|stopped responding|(could not|couldn.t|can.t|cannot|unable to) (reach|connect)|no (internet|network) connection|offline|server (error|is having trouble)|internal server error|at capacity/i;
const STATUS_NO_FALLBACK = new Set([400, 404, 405, 409, 413, 415, 422]); // a bad request is the request's fault: another model gets the same answer

const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' && v !== true && v !== false ? Number(v) : null);

// One header from an SDK error (a Headers object, or a plain object with any casing).
function headerOf(err, name) {
  const h = err?.headers ?? err?.response?.headers;
  if (!h) return null;
  try {
    if (typeof h.get === 'function') return h.get(name);
    const key = Object.keys(h).find((k) => k.toLowerCase() === name);
    return key ? h[key] : null;
  } catch { return null; }
}

// "Retry-After": seconds, or an HTTP date. Also Anthropic's unified reset (epoch seconds). -> epoch ms | null
function resetFromHeaders(err, at) {
  const retry = headerOf(err, 'retry-after');
  if (retry != null && String(retry).trim() !== '') {
    const secs = num(retry);
    if (secs !== null) return at + secs * 1000;
    const date = Date.parse(retry);
    if (!Number.isNaN(date)) return date;
  }
  const unified = num(headerOf(err, 'anthropic-ratelimit-unified-reset'));
  if (unified !== null) return unified > 1e12 ? unified : unified * 1000;
  const retryMs = num(headerOf(err, 'retry-after-ms'));
  return retryMs !== null ? at + retryMs : null;
}

// Everything an error carries that could name its kind: HTTP status, system code, API error type and
// every message in the chain (SDK message, API body message, `cause`).
function facts(input) {
  if (typeof input === 'string') return { status: null, codes: [], types: [], text: input, name: '' };
  const err = input && typeof input === 'object' ? input : {};
  const body = err.error && typeof err.error === 'object' ? err.error : {};
  const inner = body.error && typeof body.error === 'object' ? body.error : {};
  const cause = err.cause && typeof err.cause === 'object' ? err.cause : {};
  const status = num(err.status ?? err.statusCode ?? err.response?.status ?? body.status ?? inner.status);
  const codes = [err.code, cause.code, cause.cause?.code, err.errno, body.code, inner.code].filter((c) => typeof c === 'string');
  const types = [err.type, body.type, inner.type, body.code, inner.code, err.code].filter((c) => typeof c === 'string').map((s) => s.toLowerCase());
  // The SDKs repeat the API's message inside their own ("429 <message>"): each text once, so a "6m0s" is not counted twice.
  const parts = [err.name, err.message, body.message, inner.message, cause.message, cause.cause?.message, typeof err.error === 'string' ? err.error : ''].filter((p) => typeof p === 'string' && p);
  const text = [...new Set(parts)].sort((a, b) => b.length - a.length).reduce((all, p) => (all.some((q) => q.includes(p)) ? all : [...all, p]), []).join(' | ');
  return { status, codes, types, text, name: String(err.name || '') };
}

// What kind of failure this is. `input` is an Error (an SDK's, a fetch's, a CLI's) or just its text.
// { kind, scope, resetsAt, status, detail }: scope is how widely it applies, 'model' (this model only: a
// per-model rate limit) or 'provider' (everything behind the same account or network path).
function classify(input, { now = Date.now(), model = '' } = {}) {
  const f = facts(input);
  const { status, codes, types, text, name } = f;
  const out = (kind, extra = {}) => ({ kind, scope: 'provider', resetsAt: null, status, detail: text.split('\n')[0].slice(0, 200), ...extra });

  if (name === 'AbortError' || name === 'APIUserAbortError' || /request was aborted/i.test(text)) return out('other');
  if (CONTEXT_RE.test(text)) return out('other');

  const reset = () => {
    const header = typeof input === 'object' ? resetFromHeaders(input, now) : null;
    const epoch = /limit reached\|(\d{10})/i.exec(text); // Claude's older "Claude AI usage limit reached|1790640600"
    const parsed = header ?? (epoch ? Number(epoch[1]) * 1000 : null) ?? limitOf(text, now)?.resetsAt ?? parseResetTime(text, now);
    return parsed && parsed > now ? Math.min(parsed, now + COOLDOWN.max) : null;
  };
  const named = /\b(fable|opus|sonnet|haiku)\b/i.exec(text)?.[1]?.toLowerCase() || null; // "Opus limit reached": that family only
  const limit = (api) => {
    const resetsAt = reset();
    const until = resetsAt ?? now + (api ? COOLDOWN.rate : COOLDOWN.plan);
    // An API 429 is per model (each model has its own limits); a plan's usage limit is the whole account's, unless it names a family.
    return out('limit', { scope: api || named ? 'model' : 'provider', family: named, resetsAt: Math.max(until, now + COOLDOWN.min), exact: Boolean(resetsAt) });
  };

  // Strong limit signals: status, API error type, billing text.
  const creditText = /credit balance is too low|insufficient[_ ]quota|exceeded your current quota|credits? (have )?(run|ran) out|out of credits|insufficient (credits|funds|balance)/i.test(text) || types.some((t) => /insufficient_quota|billing|resource_exhausted/.test(t)) || codes.some((c) => /insufficient_quota|resource_exhausted/i.test(c));
  if (status === 429 || status === 402 || types.some((t) => /rate_limit|ratelimit|rate-limit|too_many_requests/.test(t)) || creditText) return limit(status !== null || types.length > 0);

  if (status === 401 || status === 403 || types.some((t) => /authentication_error|permission_error|invalid_api_key|invalid_x-api-key|unauthorized|forbidden/.test(t))) return out('auth');

  // Network and server trouble, from a status, a system code or an API error type.
  const netType = types.some((t) => /overloaded|api_error|timeout|unavailable|internal_server_error|server_error/.test(t));
  const netCode = codes.some((c) => NET_CODES.has(c));
  const netName = /^(APIConnectionError|APIConnectionTimeoutError|FetchError|ConnectionError|TimeoutError)$/.test(name);
  if ((status !== null && (status >= 500 || status === 408)) || netType || netCode || netName) {
    return out('unreachable', { scope: status === 529 || types.includes('overloaded_error') ? 'model' : 'provider', resetsAt: now + COOLDOWN.unreachable });
  }

  // A bad request (400, 404, ...) is not a limit even if its message says "limit" (max_tokens limit, ...).
  if (status !== null && STATUS_NO_FALLBACK.has(status)) return out('other');

  // No status: a CLI's text. (Claude Code and Grok Build describe every failure as a sentence.)
  if (TEXT_AUTH_RE.test(text) && !TEXT_LIMIT_RE.test(text)) return out('auth');
  if (TEXT_LIMIT_RE.test(text)) return limit(false);
  if (TEXT_AUTH_RE.test(text)) return out('auth');
  if (TEXT_NET_RE.test(text)) return out('unreachable', { resetsAt: now + COOLDOWN.unreachable });
  return out('other');
}

// ---------- model ids ----------

// The provider behind a picker id: 'anthropic' (a bare Claude id), 'claudecode', 'grokbuild', 'openai', 'xai', ...
function providerOf(id) {
  const m = /^([a-z][a-z0-9]*):/.exec(String(id || ''));
  return m ? m[1] : 'anthropic';
}
const isEngine = (id) => /^(claudecode|grokbuild):/.test(String(id || ''));
const TIERS = ['fable', 'opus', 'sonnet', 'haiku']; // most capable first
const familyOf = (id) => /fable|opus|sonnet|haiku/i.exec(String(id || '').replace(/^[a-z][a-z0-9]*:/, ''))?.[0]?.toLowerCase() || null;
const isDefaultEngineModel = (id) => /^(claudecode|grokbuild):default$/.test(String(id || ''));
const RELATED = { anthropic: ['claudecode'], claudecode: ['anthropic'], xai: ['grokbuild'], grokbuild: ['xai'] };

// Models a turn can be handed to: connected (the picker only lists those), signed in, and able to use tools.
function usable(options) {
  return (options || []).filter((o) => o?.id && !String(o.id).endsWith(':__more') && !o.more && o.signedIn !== false && !(o.badges || []).includes('sign in') && !(o.badges || []).includes('chat only'));
}

// ---------- cooldowns ----------

function createCooldowns() {
  const entries = new Map(); // 'm:<id>' | 'p:<provider>' -> { until, kind, scope }
  const live = (key, at) => {
    const e = entries.get(key);
    if (!e) return null;
    if (e.until <= at) { entries.delete(key); return null; }
    return e;
  };
  return {
    // Leave `model` alone until the failure's reset time (info from classify). Only limit and unreachable cool a model.
    mark(model, info, at = Date.now()) {
      if (!info || (info.kind !== 'limit' && info.kind !== 'unreachable')) return null;
      const until = Math.max(info.resetsAt || 0, at + COOLDOWN.min);
      const e = { until, kind: info.kind, scope: info.scope, exact: Boolean(info.exact) };
      const keep = (key) => { const old = entries.get(key); entries.set(key, old && old.until > until && old.until > at ? old : e); };
      if (info.scope === 'provider') keep(`p:${providerOf(model)}`); else keep(`m:${model}`);
      // "Opus limit reached" on Claude Code's default model (or any one that may be Opus): the explicit alias is limited too.
      if (info.family && isEngine(model)) keep(`m:${providerOf(model)}:${info.family}`);
      return e;
    },
    // The entry keeping `model` out of use at `at`, or null: its own, or its provider's.
    entry(model, at = Date.now()) {
      const own = live(`m:${model}`, at);
      const wide = live(`p:${providerOf(model)}`, at);
      if (own && wide) return own.until >= wide.until ? own : wide;
      return own || wide;
    },
    cooling(model, at = Date.now()) { return Boolean(this.entry(model, at)); },
    until(model, at = Date.now()) { return this.entry(model, at)?.until || 0; },
    clear(model) { if (model == null) entries.clear(); else { entries.delete(`m:${model}`); entries.delete(`p:${providerOf(model)}`); } },
    size(at = Date.now()) { for (const key of [...entries.keys()]) live(key, at); return entries.size; },
  };
}

// ---------- choosing the next model ----------

// How near `candidate` is to `current` within one vendor's line-up: cheaper first (Opus -> Sonnet -> Haiku), then
// another version of the same family, then the more capable. An unnamed default counts as between Opus and Sonnet:
// its own family is likely the one that failed.
function distance(current, candidate) {
  const fc = familyOf(current);
  const fk = familyOf(candidate);
  if (!fk) return 500;
  const ci = isDefaultEngineModel(current) || !fc ? 1.5 : TIERS.indexOf(fc);
  const ki = TIERS.indexOf(fk);
  if (fc && fk === fc && !isDefaultEngineModel(current)) return 50; // another version of the same family: after the cheaper ones (it may share the limit)
  return ki > ci ? ki - ci : 100 + (ci - ki);
}

// Every model `current` could hand over to, best first (no cooldown applied: see pick).
// allowEngines false: Claude Code and Grok Build are left out (a turn that already ran tools can't move to
// them, since they can't continue an API tool loop).
function order({ current, options, allowEngines = true }) {
  const list = usable(options).filter((o) => o.id !== current && (allowEngines || !isEngine(o.id)));
  const here = providerOf(current);
  const byProvider = new Map();
  for (const o of list) {
    const p = providerOf(o.id);
    if (!byProvider.has(p)) byProvider.set(p, []);
    byProvider.get(p).push(o.id);
  }
  const rank = (ids, cap) => ids.map((id, i) => ({ id, i, d: distance(current, id) })).sort((a, b) => a.d - b.d || a.i - b.i).slice(0, cap).map((x) => x.id);
  const result = [];
  if (byProvider.has(here)) result.push(...rank(byProvider.get(here), 4)); // Opus -> Sonnet -> Haiku; OpenAI's next model; ...
  const related = (RELATED[here] || []).filter((p) => byProvider.has(p));
  for (const p of related) result.push(...rank(byProvider.get(p), 2));
  for (const p of byProvider.keys()) if (p !== here && !related.includes(p)) result.push(...byProvider.get(p).slice(0, 2));
  return result;
}

// The model to move to now, or null: the first of order() that isn't cooling down or already tried this turn.
function pick({ current, options, cooldowns, at = Date.now(), allowEngines = true, tried = [] }) {
  const skip = new Set([current, ...tried]);
  return order({ current, options, allowEngines }).find((id) => !skip.has(id) && !cooldowns?.cooling(id, at)) || null;
}

// What a turn starts on. `preferred` is the model the user picked; while it cools down, its stand-in.
// { model, from: preferred | null, until }. With the setting off, or nothing else to use, the pick as is.
function resolve({ preferred, options, cooldowns, at = Date.now(), enabled = true, allowEngines = true }) {
  if (!enabled || !preferred || !cooldowns?.cooling(preferred, at)) return { model: preferred, from: null, until: 0 };
  const next = pick({ current: preferred, options, cooldowns, at, allowEngines });
  return next ? { model: next, from: preferred, until: cooldowns.until(preferred, at) } : { model: preferred, from: null, until: 0 };
}

// ---------- the chat's line ----------

const PROVIDER_NAMES = { anthropic: 'Anthropic', claudecode: 'Claude Code', grokbuild: 'Grok Build', openai: 'OpenAI', xai: 'xAI', gemini: 'Gemini', openrouter: 'OpenRouter' };

// A model as a person reads it, like the reply label: "Claude Opus 5.5", "OpenAI GPT-5.6", "Claude Code · Sonnet".
function nameOf(id, options = []) {
  const o = (options || []).find((x) => x.id === id);
  if (!o) return String(id).replace(/^[a-z][a-z0-9]*:/, '') || String(id);
  const label = o.name || o.label || id;
  if (isEngine(id)) return o.label || label;
  const group = o.group || o.provider;
  return group === 'Claude' ? `Claude ${label}` : group ? `${group} ${label}` : label;
}
const providerName = (id, options = []) => {
  const p = providerOf(id);
  return p === 'anthropic' ? 'Anthropic' : PROVIDER_NAMES[p] || (options.find((x) => x.id === id)?.provider) || p;
};

// The notice for a switch. kind: 'limit' | 'unreachable' (it just happened) | 'still' (a new turn starts on the
// stand-in) | 'back' (the cooldown ended). `when` formats a time ("3:40 PM"); by default the local clock.
function noticeFor({ kind, from, to, resetsAt = 0, exact = false }, options = [], { when, now = Date.now() } = {}) {
  const a = nameOf(from, options);
  const b = nameOf(to, options);
  const clock = when || ((ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  // A reset time is named only when the error gave one (not a guess) and it is within a day.
  const back = exact && resetsAt > now && resetsAt - now < 24 * 60 * MINUTE ? ` Back on ${a} at ${clock(resetsAt)}.` : '';
  if (kind === 'limit') return `${a} hit its usage limit, switched to ${b}.${back}`;
  if (kind === 'unreachable') return `Couldn’t reach ${providerName(from, options)}, switched to ${b}.`;
  if (kind === 'still') return `${a} is still unavailable, using ${b} for now.${back}`;
  if (kind === 'back') return `Back on ${a}.`;
  return `Switched to ${b}.`;
}

const shared = createCooldowns(); // the app's one set of cooldowns

module.exports = { classify, createCooldowns, shared, order, pick, resolve, usable, nameOf, providerName, noticeFor, providerOf, familyOf, isEngine, COOLDOWN, MAX_HOPS };
