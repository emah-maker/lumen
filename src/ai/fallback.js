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
//   capsOf            what a model can take: its context size and whether it sees images (a small table of known
//                     models, the catalog's own numbers for OpenRouter's); pick/choose skip a model that can't hold
//                     the conversation or its images, and only when nothing capable is left move to one anyway
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
const CONTEXT_RE = /prompt is too long|context (length|window)|maximum context|too many tokens|reduce the length|exceeds the (maximum|max) (number of )?(input )?tokens|token limit|tokens? (limit|quota) (for|of|per) (this|the) (request|message|prompt)|exceeded the model limit|input length exceeds/i;
// Text only (a CLI's sentence, no status): anchored phrases that name a plan, usage or billing limit. A bare "limit",
// "quota", "rate limit" or "reset" shows up in tool and page messages ("request rate limit of tool calls per page").
const TEXT_LIMIT_RE = /\busage limit|\brate[ _-]?limit(ed)? (exceeded|reached)|\bbeen rate[ -]limited|quota exceeded|exceeded (your|the) (current )?quota|insufficient[_ ]quota|\bcredit balance\b|resource[_ ]exhausted|credits? (have )?(run|ran) out|out of credits|insufficient (credits|funds|balance)|out of (extra )?usage|(hit|reached) your (\w+ )?limit|your (weekly|monthly|5-hour|daily) limit|monthly (spend )?limit|spend limit (reached|exceeded)/i;
const TEXT_RESET_RE = /\bresets?\s+(at|in|on|today|tomorrow|\d|[a-z]{3,9}\.?\s+\d|mon|tue|wed|thu|fri|sat|sun)/i; // "resets 5pm", "resets Oct 5": with a limit word
const TEXT_LIMIT_WORD_RE = /limit|usage|quota|plan|credits?/i;
const textLimit = (text) => TEXT_LIMIT_RE.test(text) || (TEXT_RESET_RE.test(text) && TEXT_LIMIT_WORD_RE.test(text));
const TEXT_AUTH_RE = /not (signed|logged)[ -]?in|sign(ed)?[ -]?in (has )?expired|please (run|sign) ?in|\/login|run `?grok login|add your [\w ]*api key|no api key|invalid (x-)?api[ -]?key|api key (was )?(rejected|invalid|not valid|missing)|no api key|unauthori[sz]ed|authentication[_ ]error|invalid[_ ]authentication|permission[_ ]error|oauth token (has )?expired|(invalid|bad|missing|no|wrong) credentials|credentials (are |is |were )?(invalid|missing|expired|incorrect|rejected)/i;
const TEXT_NET_RE = /fetch failed|connection (error|failed|refused|reset|closed|lost|timed out|timeout)|(lost|no|failed|dropped) (internet |network )?connection|network (error|is unreachable|request failed|failure|changed|unreachable)|socket hang up|(request|connect|connection|read|gateway|stream) (timed? ?out|timeout)|ETIMEDOUT|ENOTFOUND|getaddrinfo|ECONN(RESET|REFUSED|ABORTED)|EAI_AGAIN|ENETUNREACH|ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_\w+|NETWORK_\w+|TIMED_OUT|PROXY_\w+|EMPTY_RESPONSE)|overloaded|service unavailable|bad gateway|gateway time-?out|temporarily unavailable|stopped responding|(could not|couldn.t|can.t|cannot|unable to) (reach|connect)|no (internet|network) connection|server (error|is having trouble)|internal server error|at capacity/i;
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

// RetryInfo's "54s" / "1.5s" / "250ms" from a Gemini error's details array -> ms | null
function retryDelayOf(details) {
  for (const d of Array.isArray(details) ? details : []) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s)\s*$/i.exec(String(d?.retryDelay ?? ''));
    if (m) return Math.round(Number(m[1]) * (m[2].toLowerCase() === 'ms' ? 1 : 1000));
  }
  return null;
}

// OpenRouter's metadata.raw (the upstream provider's own answer, JSON or text): a 429 or 5xx in it -> that status.
function upstreamStatus(meta) {
  const raw = meta && typeof meta === 'object' ? meta.raw : null;
  if (raw == null || raw === '') return null;
  const ok = (v) => { const n = num(v); return n !== null && Number.isInteger(n) && (n === 429 || (n >= 500 && n <= 599)) ? n : null; };
  let obj = raw;
  if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch { obj = null; } }
  if (obj && typeof obj === 'object') return ok(obj.status) ?? ok(obj.code) ?? ok(obj.error?.code) ?? ok(obj.error?.status) ?? ok(obj.statusCode) ?? null;
  const m = /\b(429|5\d\d)\b/.exec(String(raw));
  return m ? Number(m[1]) : null;
}

// Everything an error carries that could name its kind: HTTP status, system code, API error type and
// every message in the chain (SDK message, API body message, `cause`).
function facts(input) {
  if (typeof input === 'string') return withTextFacts({ status: null, codes: [], types: [], text: input, name: '' });
  const err = input && typeof input === 'object' ? input : {};
  const body = err.error && typeof err.error === 'object' ? err.error : {};
  const inner = body.error && typeof body.error === 'object' ? body.error : {};
  const cause = err.cause && typeof err.cause === 'object' ? err.cause : {};
  // OpenRouter (and some gateways) put the HTTP status in a numeric `code` of the body: { error: { code: 429, message } }.
  const httpCode = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 400 && v <= 599 ? v : null);
  let status = num(err.status ?? err.statusCode ?? err.response?.status ?? body.status ?? inner.status) ?? httpCode(body.code) ?? httpCode(inner.code) ?? httpCode(err.code);
  // OpenRouter answers 400 when the upstream provider failed: its own status (429, 5xx) is in `metadata.raw`.
  if (status === 400) status = upstreamStatus(body.metadata ?? inner.metadata ?? err.metadata) ?? status;
  // Gemini: error.details[] holds a RetryInfo { retryDelay: "54s" } on a 429.
  const retryDelayMs = retryDelayOf(inner.details ?? body.details ?? err.details);
  const codes = [err.code, cause.code, cause.cause?.code, err.errno, cause.errno, body.code, inner.code].filter((c) => typeof c === 'string');
  const types = [err.type, body.type, inner.type, body.code, inner.code, err.code].filter((c) => typeof c === 'string').map((s) => s.toLowerCase());
  // The SDKs repeat the API's message inside their own ("429 <message>"): each text once, so a "6m0s" is not counted twice.
  const parts = [err.name, err.message, body.message, inner.message, cause.message, cause.cause?.message, typeof err.error === 'string' ? err.error : ''].filter((p) => typeof p === 'string' && p);
  const text = [...new Set(parts)].sort((a, b) => b.length - a.length).reduce((all, p) => (all.some((q) => q.includes(p)) ? all : [...all, p]), []).join(' | ');
  return withTextFacts({ status, codes, types, text, name: String(err.name || ''), retryDelayMs });
}

// Claude Code (and other CLIs) report an API failure as a sentence with the status and the body inside it:
//   API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"..."}}
// With no structured status or type, take them from the text.
function withTextFacts(f) {
  const out = { ...f };
  if (out.status === null) {
    const m = /\bAPI Error:?\s*\(?(\d{3})\b/i.exec(out.text);
    if (m) out.status = Number(m[1]);
  }
  const types = [...out.text.matchAll(/\\?"type\\?"\s*:\s*\\?"([a-z_]+_error)\\?"/gi)].map((m) => m[1].toLowerCase());
  if (types.length) out.types = [...out.types, ...types.filter((t) => !out.types.includes(t))];
  return out;
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
  // A bad argument (Node's ERR_INVALID_URL, ERR_INVALID_ARG_TYPE, ...) is the request's fault, not the network's.
  if (codes.some((c) => /^ERR_INVALID_/i.test(c))) return out('other');
  // undici's bare "terminated" (the connection closed mid-stream, no cause). A user Stop is an AbortError, handled above
  // (and agent.js never asks while the turn's signal is aborted).
  if (status === null && !codes.length && !(typeof input === 'object' && input?.cause) && /^terminated$/i.test(String(typeof input === 'string' ? input : input?.message || '').trim())) return out('unreachable', { resetsAt: now + COOLDOWN.unreachable });

  const reset = () => {
    const header = typeof input === 'object' ? resetFromHeaders(input, now) : null;
    const epoch = /limit reached\|(\d{10})/i.exec(text); // Claude's older "Claude AI usage limit reached|1790640600"
    const parsed = header ?? (f.retryDelayMs != null ? now + f.retryDelayMs : null) ?? (epoch ? Number(epoch[1]) * 1000 : null) ?? limitOf(text, now)?.resetsAt ?? parseResetTime(text, now);
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
  const creditText = /credit balance is too low|insufficient[_ ]quota|exceeded your current quota|credits? (have )?(run|ran) out|out of credits|insufficient (credits|funds|balance)|used all (of )?(its |your |the )?(available )?credits|(reached|exceeded|hit) (its|your|the) (monthly )?(spend(ing)? |credit )?limit|(reached|exceeded|hit|used)( up)? (the |your |its )?(monthly|spend(ing)?|credit) (spend(ing)? )?limit|(monthly|spend(ing)?|credit) (spend(ing)? )?limit (has been |was |is |got )?(reached|exceeded|hit|used)/i.test(text) || types.some((t) => /insufficient_quota|billing|resource_exhausted/.test(t)) || codes.some((c) => /insufficient_quota|resource_exhausted/i.test(c));
  // Out of credit is the account's, whatever the status says (xAI answers it with a 403, Anthropic with a 400): it comes
  // before the auth branch, and no model of that provider will do until it is topped up.
  const rated = types.some((t) => /rate_limit|ratelimit|rate-limit|too_many_requests/.test(t));
  if (creditText && !rated) return limit(false);
  if (status === 429 || status === 402 || rated) return limit(status !== null || types.length > 0);

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

  // No status: a CLI's text. (Claude Code, Grok Build and Antigravity describe every failure as a sentence.)
  if (TEXT_AUTH_RE.test(text) && !textLimit(text)) return out('auth');
  if (textLimit(text)) return limit(false);
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
const isEngine = (id) => /^(claudecode|grokbuild|antigravity):/.test(String(id || ''));
const TIERS = ['fable', 'opus', 'sonnet', 'haiku']; // most capable first
const familyOf = (id) => /fable|opus|sonnet|haiku/i.exec(String(id || '').replace(/^[a-z][a-z0-9]*:/, ''))?.[0]?.toLowerCase() || null;
const isDefaultEngineModel = (id) => /^(claudecode|grokbuild|antigravity):default$/.test(String(id || ''));
// Antigravity runs Google's models (and Claude through Google), so the Gemini API key is its same-vendor route.
const RELATED = { anthropic: ['claudecode'], claudecode: ['anthropic'], xai: ['grokbuild'], grokbuild: ['xai'], gemini: ['antigravity'], antigravity: ['gemini'] };

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

// ---------- what a model can take ----------

// Context size (tokens) and image input of the models Lumen offers, by id. Only what the picker's list doesn't carry:
// an OpenRouter row has the catalog's own `context` (and `vision`), which win. vision null: unknown, treated as able
// (a model is passed over only when it is known to be text-only). Engines (Claude Code, Grok Build) compact their own
// history, so only their vision counts.
const CAPS = [
  [/^claude|^anthropic\//, { context: 200_000, vision: true }],
  [/^o1-(mini|preview)/, { context: 128_000, vision: false }],
  [/^o3-mini/, { context: 200_000, vision: false }],
  [/^o[134](-|$)/, { context: 200_000, vision: true }], // o1, o1-pro, o3, o3-pro, o4-mini
  [/^gpt-5-chat/, { context: 128_000, vision: true }],
  [/^gpt-5/, { context: 400_000, vision: true }],
  [/^gpt-4\.1/, { context: 1_000_000, vision: true }],
  [/^gpt-4o|^chatgpt-4o|^gpt-4\.5|^gpt-4-turbo|^gpt-4-vision/, { context: 128_000, vision: true }],
  [/^gpt-4-32k/, { context: 32_768, vision: false }],
  [/^gpt-4(-0314|-0613)?$/, { context: 8_192, vision: false }],
  [/^gpt-3/, { context: 16_000, vision: false }],
  [/^grok-4-fast|^grok-4\.1-fast/, { context: 2_000_000, vision: true }],
  [/^grok-code/, { context: 256_000, vision: false }],
  [/^grok-4/, { context: 256_000, vision: true }],
  [/^grok-3/, { context: 131_072, vision: false }],
  [/^grok-2-vision/, { context: 32_768, vision: true }],
  [/^grok-2|^grok-beta/, { context: 131_072, vision: false }],
  [/^gemini-1\.5-pro/, { context: 2_000_000, vision: true }],
  [/^gemini-(1\.0-pro|pro$)/, { context: 32_768, vision: false }],
  [/^gemini/, { context: 1_000_000, vision: true }], // 1.5 Flash, 2.x, 3
  [/llama-4-scout/, { context: 10_000_000, vision: true }],
  [/llama-4-maverick/, { context: 1_000_000, vision: true }],
  [/llama-3\.2-(11|90)b-vision/, { context: 128_000, vision: true }],
  [/llama-3\.[1-3]/, { context: 128_000, vision: false }],
  [/llama-?3(-|$)/, { context: 8_192, vision: false }],
  [/pixtral/, { context: 128_000, vision: true }],
  [/codestral/, { context: 256_000, vision: false }],
  [/mistral-(large|medium|small)|ministral/, { context: 128_000, vision: null }],
  [/mixtral|mistral-7b|open-mistral|mistral-nemo/, { context: 32_768, vision: false }],
  [/deepseek|gpt-oss/, { context: 128_000, vision: false }],
];
const DEFAULT_CAPS = { context: 0, vision: null }; // unknown size: the old flat budget (see contextChars)
const CHARS_PER_TOKEN = 3; // a request's characters per context token (English runs nearer 4: the rest is slack for the reply)
const HEADROOM = 0.85; // of the window the history may take: the system prompt and tool definitions use the other ~15%
const UNKNOWN_CHARS = 320_000; // the flat budget for a model nobody knows the size of
const MAX_CHARS = 1_200_000; // however large the window, the request itself stays this size

// { context (tokens, 0 unknown), vision (true | false | null), engine } for a picker id. `options` is the picker's list.
function capsOf(id, options = []) {
  const o = (options || []).find((x) => x?.id === id) || {};
  const bare = String(id || '').replace(/^[a-z][a-z0-9]*:/, '');
  const row = CAPS.find(([re]) => re.test(bare))?.[1] || DEFAULT_CAPS;
  const engine = isEngine(id);
  return {
    context: engine ? 0 : Number(o.context) > 0 ? Number(o.context) : row.context,
    vision: typeof o.vision === 'boolean' ? o.vision : engine ? (providerOf(id) === 'claudecode' ? true : null) : row.vision,
    engine,
  };
}

// How many characters of history a request to this model may carry (agent.js trims to it with fitContext).
function contextChars(id, options = []) {
  const { context, engine } = capsOf(id, options);
  if (engine) return Infinity;
  return context > 0 ? Math.min(Math.round(context * CHARS_PER_TOKEN * HEADROOM), MAX_CHARS) : UNKNOWN_CHARS;
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

// The model to move to now: the first of order() that isn't cooling down or already tried this turn and can take the
// conversation (`need`: { chars, images }, how big it is and whether it holds images). When no such model is left,
// the first one that isn't cooling anyway, marked: the history is then trimmed to its window (`trim`) and images are
// left out when it is text-only (`noImages`). { id, trim, noImages } | null.
function choose({ current, options, cooldowns, at = Date.now(), allowEngines = true, tried = [], need = null }) {
  const skip = new Set([current, ...tried]);
  const open = order({ current, options, allowEngines }).filter((id) => !skip.has(id) && !cooldowns?.cooling(id, at));
  const verdict = (id) => ({ id, trim: Boolean(need?.chars) && need.chars > contextChars(id, options), noImages: Boolean(need?.images) && capsOf(id, options).vision === false });
  const all = open.map(verdict);
  return all.find((v) => !v.trim && !v.noImages) || all[0] || null;
}
function pick(args) { return choose(args)?.id || null; }

// What a turn starts on. `preferred` is the model the user picked; while it cools down, its stand-in.
// { model, from: preferred | null, until }. With the setting off, or nothing else to use, the pick as is.
function resolve({ preferred, options, cooldowns, at = Date.now(), enabled = true, allowEngines = true, need = null }) {
  if (!enabled || !preferred || !cooldowns?.cooling(preferred, at)) return { model: preferred, from: null, until: 0 };
  const next = choose({ current: preferred, options, cooldowns, at, allowEngines, need });
  return next ? { model: next.id, from: preferred, until: cooldowns.until(preferred, at), trim: next.trim, noImages: next.noImages } : { model: preferred, from: null, until: 0 };
}

// ---------- the chat's line ----------

const PROVIDER_NAMES = { anthropic: 'Anthropic', claudecode: 'Claude Code', grokbuild: 'Grok Build', antigravity: 'Antigravity', openai: 'OpenAI', xai: 'xAI', gemini: 'Gemini', openrouter: 'OpenRouter' };

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
// restart: the reply had started and its text is dropped, so the notice says it starts over. trim / noImages: the
// new model can't hold all of the conversation, or can't see images (see choose).
function noticeFor({ kind, from, to, resetsAt = 0, exact = false, restart = false, trim = false, noImages = false }, options = [], { when, now = Date.now() } = {}) {
  const a = nameOf(from, options);
  const b = nameOf(to, options);
  const clock = when || ((ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  // A reset time is named only when the error gave one (not a guess) and it is within a day.
  const back = exact && resetsAt > now && resetsAt - now < 24 * 60 * MINUTE ? ` Back on ${a} at ${clock(resetsAt)}.` : '';
  const extra = `${trim ? ' Its context window is smaller, so the oldest messages are left out.' : ''}${noImages ? ' It can’t see images, so the ones in this chat are left out.' : ''}`;
  if (restart && (kind === 'limit' || kind === 'unreachable')) {
    const head = kind === 'limit' ? `${a} hit its limit` : `Couldn’t reach ${providerName(from, options)}`;
    return `${head} — restarting the reply on ${b}.${back}${extra}`;
  }
  if (kind === 'limit') return `${a} hit its usage limit, switched to ${b}.${back}${extra}`;
  if (kind === 'unreachable') return `Couldn’t reach ${providerName(from, options)}, switched to ${b}.${extra}`;
  if (kind === 'still') return `${a} is still unavailable, using ${b} for now.${back}${extra}`;
  if (kind === 'back') return `Back on ${a}.`;
  return `Switched to ${b}.`;
}

// Which run of the app a stand-in was made in. A chat saved with a stand-in (settings.fallbackFrom) and opened after a
// restart has no cooldown to go with it: it returns to its own model without a word (agent.settleStandIn).
const SESSION = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

const shared = createCooldowns(); // the app's one set of cooldowns

module.exports = { classify, createCooldowns, shared, order, pick, choose, resolve, capsOf, contextChars, SESSION, usable, nameOf, providerName, noticeFor, providerOf, familyOf, isEngine, COOLDOWN, MAX_HOPS };
