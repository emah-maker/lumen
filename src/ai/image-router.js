// Image generation routing: any chat engine can ask for a picture (the generate_image tool, or "draw a cat"), and Lumen hands the
// request to a provider the user has already connected that makes pictures. Pure: no Electron, no network, no settings. agent.js
// supplies what is connected and how each provider is called (backends); this module decides who is asked, in what order, and what a
// failure means.
//
//   setting           Settings > AI > Image generation (imageGen): 'auto' (default), 'off', or one provider.
//   providers         grokbuild (Grok Build's image_gen / image_edit, through the user's own sign-in), xai (Grok API), gemini, openai, openrouter.
//                     Never a key the user has not set: only connected providers are ever asked, and a provider that is not connected
//                     is never offered a request.
//   order (auto)      the chat's own provider first when it can make pictures (a Grok Build or OpenAI chat), then the others: Grok Build
//                     (a plan, no per-picture charge), then the API keys (Grok, Gemini, OpenAI, OpenRouter). Providers that are out of
//                     usage right now (ai/fallback.js cooldowns) go last, those the user turned off for Auto (autoExclude) are left out
//                     unless it is the chat's own provider. A single chosen provider is the only one asked (and ignores autoExclude).
//   failures          a provider that is out of usage, unreachable, rejected the key or just failed hands the request to the next one.
//                     A provider that REFUSED the picture (its content policy) does not: its refusal is the answer, never retried elsewhere.
//   editing           "edit the last picture" only goes to providers that edit (OpenAI, Gemini, OpenRouter, Grok Build).
//
// route() returns { images, provider, label, model, credit, tried } or throws an Error with `code`: 'off' | 'none' | 'refused' |
// 'failed' | 'aborted'. The message is written for the user (and the model that called the tool).

const LABELS = { grokbuild: 'Grok Build', xai: 'Grok', gemini: 'Gemini', openai: 'OpenAI', openrouter: 'OpenRouter' };
const ORDER = ['grokbuild', 'xai', 'gemini', 'openai', 'openrouter'];
const CAN_EDIT = { grokbuild: true, xai: false, gemini: true, openai: true, openrouter: true };
const SETTINGS = ['auto', 'off', ...ORDER];

const cleanSetting = (v) => (SETTINGS.includes(v) ? v : 'auto');

// The chat's own provider as an image provider: 'openai:gpt-5.6' -> 'openai', 'grokbuild:default' -> 'grokbuild'; Claude, Claude Code,
// Antigravity and Codex make no pictures of their own here (null).
function ownProviderOf(model) {
  const key = /^([a-z][a-z0-9]*):/.exec(String(model || ''))?.[1] || (/^claude/.test(String(model || '')) ? 'anthropic' : null);
  return ORDER.includes(key) ? key : null;
}

const labelOf = (key) => LABELS[key] || key;

// Who to ask, in order. connected: { [key]: boolean }, cooling(key) -> boolean, exclude: provider keys turned off for Auto.
function plan({ setting = 'auto', current = null, connected = {}, cooling = () => false, exclude = [], edit = false } = {}) {
  const mode = cleanSetting(setting);
  if (mode === 'off') return { order: [], mode, missing: null };
  const usable = (key) => connected[key] === true && (!edit || CAN_EDIT[key]);
  if (mode !== 'auto') return { order: usable(mode) ? [mode] : [], mode, missing: usable(mode) ? null : mode };
  const own = ownProviderOf(current);
  const skip = new Set((exclude || []).map(String));
  const ranked = [...(own ? [own] : []), ...ORDER.filter((k) => k !== own && !skip.has(k))].filter(usable);
  const ready = ranked.filter((k) => !cooling(k));
  return { order: [...ready, ...ranked.filter((k) => cooling(k))], mode, missing: null, own: own && usable(own) ? own : null };
}

// What a failure means for the next step. 'refused': the provider declined the picture itself. 'aborted': the user stopped it.
// Everything else (usage, network, key, a model that is not there, no picture came back) is a reason to try the next provider.
function judge(err, { isPolicy, classify }) {
  if (err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || err?.aborted === true) return { kind: 'aborted' };
  if (isPolicy(err)) return { kind: 'refused' };
  const info = classify ? classify(err) : { kind: 'other' };
  return { kind: info.kind || 'other', detail: info.detail || String(err?.message || err || '') };
}

const WHY = { limit: 'out of usage', unreachable: 'unreachable', auth: 'not signed in or key rejected', other: 'failed' };
const oneLine = (s, n = 160) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function fail(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }

// deps: {
//   setting, current (the chat's model id), edit (boolean), prompt, source ({ buffer, mime } | null), signal,
//   connected: () => Promise<{[key]: boolean}> | {...},  cooling(key), exclude: [],
//   backends: { [key]: async ({ prompt, source, signal }) => ({ images: [{ data|url, alt }], model, said }) },
//   isPolicy(err), classify(err), onTry(key) (optional, "Making it with X")
// }
async function route(deps) {
  const { prompt, source = null, signal, backends = {}, isPolicy = () => false, classify = null, onTry = null } = deps;
  const connected = typeof deps.connected === 'function' ? await deps.connected() : (deps.connected || {});
  const edit = Boolean(source);
  const p = plan({ setting: deps.setting, current: deps.current, connected, cooling: deps.cooling || (() => false), exclude: deps.exclude, edit });
  if (p.mode === 'off') throw fail('off', 'Picture making is turned off in Settings > AI > Image generation. Tell the user, and describe the picture in words instead.');
  if (!p.order.length) {
    if (p.missing) throw fail('none', `${labelOf(p.missing)} is chosen for pictures in Settings > AI > Image generation, but ${p.missing === 'grokbuild' ? 'Grok Build is not installed or signed in' : 'it is not connected'}${edit && !CAN_EDIT[p.missing] ? ' (or it cannot edit pictures)' : ''}. Tell the user; do not ask them for a key in the chat.`, { missing: p.missing, userMessage: `${labelOf(p.missing)} is chosen for pictures (Settings > AI > Image generation) but ${p.missing === 'grokbuild' ? 'Grok Build is not installed or signed in' : 'it is not connected'}. Pick another provider there, or Automatic.` });
    throw fail('none', `No connected AI can ${edit ? 'edit' : 'make'} pictures. The user can connect an OpenAI, Grok or Gemini key, or OpenRouter (Settings > AI), or sign in to Grok Build. Tell them that; do not ask for a key in the chat.`);
  }
  const tried = [];
  for (const key of p.order) {
    if (signal?.aborted) throw fail('aborted', 'Stopped by the user.');
    const backend = backends[key];
    if (typeof backend !== 'function') { tried.push({ provider: key, why: 'not available' }); continue; }
    if (onTry) { try { onTry(key); } catch { /* cosmetic */ } }
    try {
      const made = await backend({ prompt, source, signal });
      if (made?.images?.length) {
        const label = labelOf(key);
        return { images: made.images, provider: key, label, model: made.model || null, said: made.said || '', credit: made.model ? `${label} · ${made.model}` : label, tried };
      }
      tried.push({ provider: key, why: 'made no picture' });
    } catch (err) {
      const verdict = judge(err, { isPolicy, classify });
      if (verdict.kind === 'aborted') throw fail('aborted', 'Stopped by the user.');
      if (verdict.kind === 'refused') {
        throw fail('refused', `${labelOf(key)} declined this picture: ${oneLine(err?.message, 300) || 'it did not say why'}. This is ${labelOf(key)}'s content policy, so it was not tried elsewhere. Tell the user what ${labelOf(key)} said and offer to change the request.`, { provider: key, label: labelOf(key), userMessage: `${labelOf(key)} declined this picture: ${oneLine(err?.message, 300) || 'it did not say why'}`, tried });
      }
      tried.push({ provider: key, why: WHY[verdict.kind] || 'failed', detail: oneLine(verdict.detail) });
    }
  }
  const list = tried.map((t) => `${labelOf(t.provider)} (${t.why}${t.detail && t.why === 'failed' ? `: ${t.detail}` : ''})`).join('; ');
  throw fail('failed', `No picture could be made: ${list}. Tell the user, and describe the picture in words instead.`, { tried, userMessage: `Couldn't make the picture: ${list}.` });
}

// ---------- the tool ----------
// One short tool for every engine (the API tool list and Lumen's MCP tools): prompt budget test/acceptance/chat-prompt-budget.js.
const TOOL = {
  name: 'generate_image',
  description: 'Make or edit a picture; it shows in the chat.',
  input_schema: { type: 'object', properties: { prompt: { type: 'string' }, edit: { type: 'boolean' } }, required: ['prompt'] },
};
// Adds the tool to agent.js's TOOLS (before the derived lists are built), like snapshot.js's.
function extendTools(TOOLS) { TOOLS.push({ ...TOOL, eager_input_streaming: true }); }

// What the model is told after a picture was made (the picture itself is shown in the chat, never sent back to it).
const toolResult = (r) => `Picture made with ${r.credit} and shown to the user in the chat. Do not repeat it or describe it at length.`;

module.exports = { LABELS, ORDER, CAN_EDIT, SETTINGS, TOOL, cleanSetting, ownProviderOf, labelOf, plan, judge, route, extendTools, toolResult };
