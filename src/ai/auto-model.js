// "Auto" model: Lumen chooses the model for each request instead of the user pinning one. Pure and local: no
// Electron, no network, no extra model call, and nothing about a page is read or logged here. main.js builds the
// picker's option list, agent.js and the background features hand this module what a request looks like, and ask
// it which of the options should answer (route), what to try when that one fails (escalate) and what to call it
// (the decision's label and reason).
//
//   pick id           'auto' is the one picker id (first in every picker). It is never sent to a provider or a CLI:
//                     it is turned into a concrete option id ('claudecode:sonnet', 'openai:gpt-5-mini') per request.
//   tiers             every option has a capability tier: 'fast' (small, cheap, quick), 'balanced', 'strong'
//                     (flagship / reasoning). tierOf() reads it from the option (`tier`, set by an engine that
//                     knows better) or from its id ('haiku', 'mini', 'flash' -> fast; 'opus', 'pro', 'o3' -> strong).
//   need              what a request asks for (needFor): the task kind or how hard the prompt looks (the same scoring
//                     as features/model-route.js, which Claude Code's own default pick already used), raised by a
//                     /think or deep-research hint, a long conversation or a large attachment, and held down for
//                     a quick lookup, a summary, a translation or a classification.
//   candidates        options that are connected and signed in, not turned off for Auto (`exclude`), not cooling down
//                     after a usage limit or an outage (ai/fallback.js cooldowns), not refused for this account
//                     (denied: a plan that doesn't include the model), able to use tools when the request needs
//                     them, able to see images when it holds some, and able to hold the conversation.
//   choice            the candidate whose tier is nearest the need (a stronger model before a weaker one, which may
//                     not manage), staying with the provider already answering (a cache stays warm, the style stays
//                     the same) or the one the user was on before choosing Auto; then the cheaper, then the
//                     picker's own order. Deterministic: the same inputs always give the same answer.
//   escalate          a model that fails in a way a stronger one may not (the request is too long for it, it can't use
//                     tools) is replaced once by the next candidate: one with a larger context window when the
//                     request was too long, else a stronger tier, or the same tier on another model for an
//                     "not available on your plan" refusal.
//   native default    an engine's own 'default' row (Claude Code's, Grok Build's, Antigravity's) is left to the CLI
//                     when the engine lists no models to choose from: Auto then defers to what the CLI picks.

const fallback = require('./fallback');
const modelRoute = require('../features/model-route');

const AUTO = 'auto';
const TIERS = ['fast', 'balanced', 'strong'];
const isAuto = (id) => id === AUTO;

// Task kinds a caller may name. Each is held to a tier ('chat' and 'agentic' are scored from the prompt).
const KIND_TIER = { quick: 'fast', lookup: 'fast', summary: 'fast', translation: 'fast', classification: 'fast', title: 'fast', code: 'balanced', reasoning: 'strong' };
const KINDS = ['chat', 'agentic', ...Object.keys(KIND_TIER)];

// ---------- what a model is ----------

const bareOf = (id) => String(id || '').replace(/^[a-z][a-z0-9]*:/, '').split('/').pop().toLowerCase();
const word = (re, s) => re.test(s);

// The tier of an option. An engine or provider that knows its own tiers sets `tier` on the option; otherwise it
// is read from the model's name, the way the vendors name their lines (Haiku/Sonnet/Opus, mini/base/pro, Flash/Pro).
function tierOf(option) {
  const id = typeof option === 'string' ? option : option?.id;
  if (option?.tier && TIERS.includes(option.tier)) return option.tier;
  const s = bareOf(id);
  if (!s || s === 'default' || s === 'auto') return 'balanced'; // an engine's own default: whatever the CLI picks, in the middle
  if (/(^|[-_. ])(haiku|nano|lite|mini|flash|small|fast|instant|tiny|light|8b|7b|3b|1b)(?=$|[-_. ])/.test(s) && !/(^|[-_. ])pro(?=$|[-_. ])/.test(s)) {
    return /^o\d.*mini|^o\d.*-mini/.test(s) ? 'balanced' : 'fast'; // o3-mini / o4-mini reason: balanced, not fast
  }
  if (/(^|[-_. ])(opus|fable|ultra|max|pro|reasoner|reasoning|thinking|405b|large|heavy|xhigh)(?=$|[-_. ])/.test(s) && !/non-reasoning/.test(s)) return 'strong';
  if (/^o\d/.test(s)) return 'strong'; // o1, o3, o3-pro
  if (/^gpt-5(?:[.-]\d+)*(?:-(?:codex|chat))?$/.test(s) || /^gpt-5(?:\.\d+)?$/.test(s)) return 'strong'; // the GPT-5 flagship
  if (/^grok-4(?:[.-]\d+)*$/.test(s)) return 'strong';
  if (/(^|[-_. ])(sonnet|codex|medium|70b|turbo|chat)(?=$|[-_. ])/.test(s)) return 'balanced';
  return 'balanced';
}

// Cost class for a tie-break: the catalog's price per million input tokens when known, else by tier.
function costOf(option) {
  if (Number.isFinite(option?.price) && option.price >= 0) return option.price;
  return { fast: 0.5, balanced: 3, strong: 15 }[tierOf(option)];
}

const providerOf = fallback.providerOf;

// ---------- what a request needs ----------

const TOOL_KINDS = new Set(['chat', 'agentic', 'code']);
const LONG_HISTORY_CHARS = 60_000; // a long conversation is not left to the smallest model
const HUGE_HISTORY_CHARS = 240_000;
const BIG_ATTACHMENT_CHARS = 40_000; // page text, a PDF, a pasted file: summarising it is no quick lookup

// The tier the request wants and what a model must be able to do for it.
// request: {
//   prompt, kind ('chat' by default), imageCount, tabCount, attachmentChars, historyChars, turns,
//   tools (boolean: tool use is needed; default for chat/agentic/code), hint ('think' | 'deep' | 'fast' | ''),
//   previousTier ('fast'|'balanced'|'strong': the last Auto turn of this chat), followUp tiers see model-route
// }
function needFor(request = {}) {
  const kind = KINDS.includes(request.kind) ? request.kind : 'chat';
  const imageCount = Math.max(0, Number(request.imageCount) || 0);
  const history = Math.max(0, Number(request.historyChars) || 0);
  const attachment = Math.max(0, Number(request.attachmentChars) || 0);
  const hint = String(request.hint || '').toLowerCase();
  const tools = typeof request.tools === 'boolean' ? request.tools : TOOL_KINDS.has(kind);
  let tier;
  let why;
  if (kind in KIND_TIER) {
    tier = KIND_TIER[kind];
    why = { quick: 'a quick lookup', lookup: 'a quick lookup', summary: 'a summary', translation: 'a translation', classification: 'a quick classification', title: 'a short title', code: 'code', reasoning: 'a hard problem' }[kind];
    if (kind === 'summary' && attachment > BIG_ATTACHMENT_CHARS) { tier = 'balanced'; why = 'a long summary'; }
  } else {
    const prev = TIERS.includes(request.previousTier) ? { light: 'light', balanced: 'standard', fast: 'light', strong: 'heavy' }[request.previousTier] : null;
    const t = modelRoute.tierFor(request.prompt || '', { imageCount, tabCount: request.tabCount || 0, previous: prev ? { tier: prev, turns: Math.max(1, request.turns || 1) } : null, pinned: false });
    tier = { light: 'fast', standard: 'balanced', heavy: 'strong' }[t.tier];
    why = t.tier === 'light' ? (tools ? 'a quick task' : 'a quick question') : t.tier === 'heavy' ? (/```|debug|refactor|fix|code|implement/i.test(request.prompt || '') ? 'a coding task' : 'a demanding task') : 'a typical request';
    if (t.followUp && prev && tier === { light: 'fast', standard: 'balanced', heavy: 'strong' }[prev]) why = 'a follow-up';
  }
  // The user's own hint wins over the guess: /think and deep research ask for the strongest model, "fast" for the quickest.
  if (hint === 'think' || hint === 'deep' || hint === 'strong') { tier = 'strong'; why = hint === 'deep' ? 'deep research' : 'extra thinking'; }
  else if (hint === 'fast' && kind !== 'reasoning') { tier = 'fast'; why = 'a quick answer'; }
  else {
    // A long conversation or a big attachment lifts the floor: the smallest model loses the thread.
    if (history + attachment > HUGE_HISTORY_CHARS && tier !== 'strong') { tier = 'strong'; why = 'a very long conversation'; }
    else if (history + attachment > LONG_HISTORY_CHARS && tier === 'fast') { tier = 'balanced'; why = 'a long conversation'; }
  }
  return { tier, why, tools, vision: imageCount > 0, chars: history + attachment, kind };
}

// ---------- candidates ----------

// Models the request could go to. Never: a "more models" row, an engine signed out, a model the user turned off for
// Auto, one cooling down, one refused for this account, or one that can't do what the request needs.
// exclude: ids or provider keys ('openai', 'claudecode') the user turned off for Auto. denied: a Set of ids this account was refused.
function candidatesOf(options, need, { exclude = [], denied = null, cooldowns = null, at = Date.now(), allowEngines = true, scope = null } = {}) {
  const off = new Set((exclude || []).map(String));
  // (fallback.usable also drops chat-only models; whether tools are needed is this request's own question, asked below)
  const list = (options || []).filter((o) => o?.id && !isAuto(o.id) && !String(o.id).endsWith(':__more') && !o.more && o.signedIn !== false && !(o.badges || []).includes('sign in'));
  const onlyDefault = new Set(); // engines that list nothing but their own default
  for (const engine of ['claudecode', 'grokbuild', 'antigravity']) {
    if (!list.some((o) => providerOf(o.id) === engine && !/:default$/.test(o.id))) onlyDefault.add(engine);
  }
  return list.filter((o) => {
    const p = providerOf(o.id);
    if (off.has(o.id) || off.has(p) || (denied && denied.has(o.id)) || o.gated === true || o.available === false) return false;
    if (scope && p !== scope) return false;
    if (cooldowns?.cooling(o.id, at)) return false;
    const engine = fallback.isEngine(o.id);
    if (engine && !allowEngines) return false;
    // An engine's own default is the "defer to the CLI" choice: used only when the engine has no models to choose from.
    if (/:default$/.test(o.id) && engine && !onlyDefault.has(p)) return false;
    const caps = fallback.capsOf(o.id, options);
    if (need.vision && caps.vision === false) return false;
    if (need.tools && (o.badges || []).includes('chat only')) return false;
    if (!engine && caps.context > 0 && need.chars > fallback.contextChars(o.id, options)) return false;
    return true;
  });
}

// ---------- the choice ----------

const label = (option) => {
  if (!option) return 'Auto';
  const raw = option.name || option.label || bareOf(option.id);
  return `Auto · ${String(raw).replace(/^Claude Code · /, '').replace(/^Claude\s+/, '')}`;
};
const reasonOf = (name, why) => `Auto: ${name} for ${why}`;
const shortName = (option) => String(option?.name || option?.label || bareOf(option?.id)).replace(/^Claude Code · /, '').replace(/^Claude\s+/, '');

// How far a candidate's tier is from the need. Stronger than needed costs a little, weaker than needed costs more:
// a model that can't manage is worse than one that is only dearer.
const tierCost = (have, want) => { const d = TIERS.indexOf(have) - TIERS.indexOf(want); return d === 0 ? 0 : d > 0 ? 6 * d : 10 * -d; };

// route({ options, request, ... }) -> { id, tier, need, why, label, reason, option, candidates } | { id: null, reason }
// options: the picker's list. prefer: provider keys to stay with, best first (the chat's last Auto provider, then the
// one the user was on before). previous: { id, tier } of the chat's last Auto turn.
function route({ options = [], request = {}, prefer = [], exclude = [], denied = null, cooldowns = null, at = Date.now(), allowEngines = true, scope = null, need = null } = {}) {
  need = need || needFor(request);
  const list = candidatesOf(options, need, { exclude, denied, cooldowns, at, allowEngines, scope });
  if (!list.length) return { id: null, tier: need.tier, need, why: need.why, label: 'Auto', reason: 'Auto: no model is available right now', candidates: [] };
  const home = (prefer || []).filter(Boolean);
  const score = (o, index) => {
    const p = providerOf(o.id);
    const at0 = home.indexOf(p);
    const stay = at0 === 0 ? 0 : at0 > 0 ? 2 : home.length ? 4 : 0;
    return tierCost(tierOf(o), need.tier) + stay + Math.min(0.9, Math.log10(1 + costOf(o)) / 10) + index / 10000;
  };
  const ranked = list.map((o, i) => ({ o, s: score(o, i) })).sort((a, b) => a.s - b.s).map((x) => x.o);
  const best = ranked[0];
  return { id: best.id, tier: tierOf(best), need, why: need.why, label: label(best), reason: reasonOf(shortName(best), need.why), option: best, candidates: ranked.map((o) => o.id) };
}

// What to try when `current` failed in a way another model may get past. failure: { kind: 'context' | 'tools' | 'denied' | 'refused' }.
// Returns the next route() decision (never `current`, never one already tried) or null when there is nothing better:
//   context  a larger context window (a model that holds what the request holds), else a stronger one
//   refused / empty a stronger tier
//   tools    a model that can use tools
//   denied   another model at the same tier (the account can't use this one); the id is remembered by the caller
function escalate({ options = [], current, failure = {}, request = {}, tried = [], prefer = [], exclude = [], denied = null, cooldowns = null, at = Date.now(), allowEngines = true, scope = null } = {}) {
  const kind = failure.kind || 'refused';
  const base = needFor(request);
  const here = (options || []).find((o) => o.id === current);
  const haveTier = here ? tierOf(here) : base.tier;
  const skip = new Set([current, ...tried]);
  let need = { ...base };
  if (kind === 'context') need = { ...base, chars: Math.max(base.chars, Number(failure.chars) || 0) + 1 };
  if (kind === 'tools') need = { ...base, tools: true };
  if (kind === 'refused' || kind === 'empty') need = { ...base, tier: TIERS[Math.min(TIERS.length - 1, TIERS.indexOf(haveTier) + 1)] };
  if (kind === 'context') need.tier = TIERS[Math.min(TIERS.length - 1, TIERS.indexOf(haveTier) + 1)];
  if (kind === 'denied') need.tier = haveTier;
  if ((kind === 'refused' || kind === 'empty') && TIERS.indexOf(haveTier) === TIERS.length - 1) return null; // already the strongest
  const list = candidatesOf(options, need, { exclude, denied, cooldowns, at, allowEngines, scope }).filter((o) => !skip.has(o.id));
  // Context: a window larger than the failed model's, when both are known.
  const windowOf = (o) => fallback.capsOf(o.id, options).context;
  const had = windowOf(here || { id: current });
  const fit = kind === 'context' && had > 0 ? list.filter((o) => windowOf(o) === 0 || windowOf(o) > had) : list;
  const pool = fit.length ? fit : kind === 'context' ? [] : list;
  if (!pool.length) return null;
  const stronger = (kind === 'refused' || kind === 'empty' || kind === 'context') ? pool.filter((o) => TIERS.indexOf(tierOf(o)) > TIERS.indexOf(haveTier) || kind === 'context') : pool;
  const use = stronger.length ? stronger : pool;
  const decision = route({ options: use, request, prefer: [providerOf(current), ...prefer], exclude, denied, cooldowns, at, allowEngines, scope, need });
  if (!decision.id) return null;
  const why = { context: 'a longer conversation than the last model could take', tools: 'a model that can use tools', denied: 'a model your account can use', refused: 'a second try on a stronger model', empty: 'a second try on a stronger model' }[kind] || 'a second try';
  return { ...decision, escalated: true, why, reason: reasonOf(shortName(decision.option), why), label: label(decision.option) };
}

// What kind of failure an error is, for escalate(): 'context' (the request is too long for the model), 'tools' (the
// model takes no tools), 'denied' (the account can't use the model, e.g. a plan without it) or null (not one for a
// stronger model: a usage limit or an outage goes through ai/fallback.js instead).
const CONTEXT = /prompt is too long|context (length|window)|maximum context|too many tokens|reduce the length|exceeds the (maximum|max)|token limit|input length exceeds/i;
const TOOLS = /does(?: not|n't) support (tool|function)|tools? (?:are |is )?not supported|no endpoints found that support tool|function calling is not (supported|enabled)/i;
const DENIED = /not available (for|on) your|does not exist or you do not have access|do(?:es)? not have access to (the )?model|model .{0,40}(is )?not (available|found|supported) (for|on|in) your (plan|account|subscription)|requires? (a )?(pro|max|plus|team|paid|higher)\b|upgrade your (plan|subscription)|not included in your (plan|subscription)|no access to (this )?model/i;
function failureOf(err) {
  const text = typeof err === 'string' ? err : [err?.message, err?.error?.message, err?.error?.error?.message].filter(Boolean).join(' ');
  const status = Number(err?.status ?? err?.statusCode) || null;
  if (CONTEXT.test(text)) return { kind: 'context' };
  if ((status === 400 || status === 404 || status === 422 || status === null) && TOOLS.test(text)) return { kind: 'tools' };
  if ((status === 403 || status === 404 || status === 400 || status === null) && DENIED.test(text)) return { kind: 'denied' };
  return null;
}

// Models this account was refused (for the rest of the session): Auto leaves them out, as a plan that doesn't
// include them would. `deny(id)` / `denied()` are kept in memory only, never saved.
function createDenied(ttlMs = 6 * 3600e3) {
  const map = new Map();
  return {
    add(id, at = Date.now()) { if (id) map.set(String(id), at + ttlMs); },
    set(at = Date.now()) { for (const [k, v] of map) if (v <= at) map.delete(k); return new Set(map.keys()); },
    clear() { map.clear(); },
  };
}

// The id the picker's own "Auto" row carries, and what it says. `last` is the chat's latest decision ({ label, reason }).
function pickerEntry({ last = null, describe = '' } = {}) {
  return {
    id: AUTO,
    label: last?.label || 'Auto',
    name: last?.label || 'Auto',
    provider: 'Auto',
    group: 'Auto',
    auto: true,
    detail: last?.reason || describe || 'Lumen picks the model for each message',
    title: last?.reason || describe || 'Lumen picks the model for each message',
  };
}

// The provider keys Auto may stay with, from the chat's last Auto choice and the pick the user made before Auto.
const preferFrom = ({ lastId = null, home = null } = {}) => [lastId ? providerOf(lastId) : null, home ? providerOf(home) : null].filter(Boolean);

module.exports = { AUTO, TIERS, KINDS, KIND_TIER, isAuto, tierOf, costOf, needFor, candidatesOf, route, escalate, failureOf, createDenied, pickerEntry, preferFrom, label, reasonOf };
