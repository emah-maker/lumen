// OpenAI-compatible providers (OpenAI, xAI Grok, Google Gemini, OpenRouter) for the agent loop.
//
// The conversation is stored in Anthropic's message format (content blocks). For these providers
// it is converted to Chat Completions messages on every request, and each reply is converted
// back, so a chat can move between Claude and any of these models.
// The OpenAI SDK (also used for Grok and Gemini) loads only when one of them is first used.
let OpenAIModule = null;
const OpenAISDK = () => (OpenAIModule ||= require('openai'));
const { netFetch } = require('./net-fetch');

const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    baseURL: undefined,
    defaults: ['gpt-5.6', 'gpt-5.6-mini'],
    include: (id) => /^(gpt-|o\d)/.test(id) && !/(audio|realtime|tts|transcribe|image|search|embedding|instruct|moderation|codex)/.test(id),
  },
  xai: {
    label: 'Grok',
    baseURL: 'https://api.x.ai/v1',
    defaults: ['grok-4'],
    include: (id) => /^grok/.test(id) && !/image/.test(id),
  },
  gemini: {
    label: 'Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    defaults: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    include: (id) => /^gemini/.test(id) && !/(embedding|image|tts|aqa|live)/.test(id),
  },
  // One key for many companies' models. Ids look like "anthropic/claude-opus-5.5".
  openrouter: {
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    headers: { 'HTTP-Referer': 'https://github.com/emah-maker/lumen', 'X-Title': 'Lumen' },
    defaults: ['anthropic/claude-sonnet-5', 'openai/gpt-5.6', 'google/gemini-2.5-flash'],
    include: () => true,
  },
};

// ---------- OpenRouter's model catalog (GET /models, kept for 24 hours) ----------

const CATALOG_TTL = 24 * 60 * 60 * 1000;
const CURATED = [/^anthropic\/claude/, /^openai\/gpt/, /^google\/gemini/, /^meta-llama\/llama/, /^deepseek\/deepseek/, /^x-ai\/grok/];
let catalog = null; // { fetchedAt, models: [{ id, name, tools, created }] }

async function openRouterCatalog({ cacheFile, fetchImpl = netFetch() } = {}) {
  const fs = require('fs');
  if (!catalog && cacheFile) { try { catalog = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {} }
  if (catalog && Date.now() - catalog.fetchedAt < CATALOG_TTL) return catalog;
  const res = await fetchImpl(`${PROVIDERS.openrouter.baseURL}/models`, { headers: PROVIDERS.openrouter.headers });
  if (!res.ok) throw new Error(`OpenRouter models: HTTP ${res.status}`);
  catalog = { fetchedAt: Date.now(), models: parseOpenRouterModels(await res.json()) };
  if (cacheFile) { try { fs.writeFileSync(cacheFile, JSON.stringify(catalog)); } catch {} }
  return catalog;
}

// The API's list -> text models, with whether they can call tools (needed to act in tabs).
function parseOpenRouterModels(json) {
  return (json?.data || [])
    .filter((m) => m?.id && !String(m.id).includes(':') && /text/.test(m.architecture?.output_modalities?.join(' ') || 'text'))
    .map((m) => ({ id: m.id, name: m.name || m.id, tools: Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools'), created: m.created || 0 }));
}

// A short list for the picker: the newest tool-capable model of a few families.
function curatedOpenRouter(models) {
  const picks = [];
  for (const family of CURATED) {
    const best = models.filter((m) => family.test(m.id) && m.tools).sort((a, b) => b.created - a.created)[0];
    if (best) picks.push(best.id);
  }
  return picks.length ? picks : PROVIDERS.openrouter.defaults;
}

// Can this model use tools (click, type, read pages)? Unknown models are assumed to.
function canUseTools(provider, model) {
  if (provider !== 'openrouter' || !catalog) return true;
  const entry = catalog.models.find((m) => m.id === model);
  return entry ? entry.tools : true;
}

// Model ids for these providers are namespaced: "openai:gpt-5.6", "xai:grok-4", "gemini:gemini-2.5-pro",
// "openrouter:anthropic/claude-opus-5.5".
function splitModel(id) {
  const i = id.indexOf(':');
  return i > 0 && PROVIDERS[id.slice(0, i)] ? { provider: id.slice(0, i), model: id.slice(i + 1) } : { provider: 'anthropic', model: id };
}

function clientFor(provider, apiKey) {
  const OpenAI = OpenAISDK();
  return new OpenAI({ apiKey, baseURL: PROVIDERS[provider].baseURL, defaultHeaders: PROVIDERS[provider].headers, maxRetries: 2, fetch: netFetch() });
}

// Does the provider accept this key? { ok: true }, { ok: false, message } when it's rejected, or
// { ok: null } when it couldn't be checked (offline, or the provider having trouble).
async function checkKey(provider, apiKey, { fetchImpl = netFetch() } = {}) {
  const rejected = { ok: false, message: `${PROVIDERS[provider].label} didn't accept that key. Check it and try again.` };
  try {
    if (provider === 'openrouter') {
      const res = await fetchImpl(`${PROVIDERS.openrouter.baseURL}/key`, { headers: { Authorization: `Bearer ${apiKey}`, ...PROVIDERS.openrouter.headers }, signal: AbortSignal.timeout(10000) });
      if (res.status === 401 || res.status === 403) return rejected;
      return { ok: res.ok ? true : null };
    }
    const OpenAI = OpenAISDK();
    const client = new OpenAI({ apiKey, baseURL: PROVIDERS[provider].baseURL, defaultHeaders: PROVIDERS[provider].headers, maxRetries: 0, timeout: 10000, fetch: netFetch() });
    await client.models.list();
    return { ok: true };
  } catch (err) {
    // Gemini answers a bad key with 400 (API_KEY_INVALID) rather than 401.
    if (err?.status === 401 || err?.status === 403 || (provider === 'gemini' && err?.status === 400)) return rejected;
    return { ok: null };
  }
}

// Lists chat models the key can use (newest-looking first); falls back to defaults on error.
async function listModels(provider, apiKey, { cacheFile } = {}) {
  try {
    if (provider === 'openrouter') return curatedOpenRouter((await openRouterCatalog({ cacheFile })).models);
    const page = await clientFor(provider, apiKey).models.list();
    const ids = [];
    for await (const m of page) ids.push(String(m.id).replace(/^models\//, ''));
    // Newest families first and no dated duplicates (an alphabetical cut used to drop every gpt-* model behind o-series ids).
    const chat = require('./features/model-names').rankModels(ids.filter(PROVIDERS[provider].include), 16);
    return chat.length ? chat : PROVIDERS[provider].defaults;
  } catch {
    return PROVIDERS[provider].defaults;
  }
}

// Gemini's OpenAI-compatible endpoint has rejected object schemas with no properties, so
// parameterless tools get one harmless optional field there.
const toolSchema = (tools, provider) => tools.map((t) => {
  const empty = !Object.keys(t.input_schema.properties || {}).length;
  const parameters = empty && provider === 'gemini'
    ? { ...t.input_schema, properties: { note: { type: 'string', description: 'Optional; leave empty.' } } }
    : t.input_schema;
  return { type: 'function', function: { name: t.name, description: t.description, parameters } };
});

const imageUrl = (source) => (source?.type === 'base64' ? `data:${source.media_type};base64,${source.data}` : source?.url);

// Unlike Claude (context_management's clear_tool_uses_20250919, server-side), these providers get
// no automatic history trimming: every tool result and every screenshot would otherwise be resent,
// full size, on every future turn. Cap it here instead: only the most recent user turn (the one
// just answered) keeps its tool-result text at full size and its screenshots at all; every earlier
// turn is shrunk once, the first time it stops being "most recent", and then stays shrunk (stable
// bytes from then on, so OpenAI/Grok/Gemini's own prefix caching still hits on every later turn —
// only the one transition request pays a cache-miss on that turn).
const OLD_TOOL_TEXT_CAP = 2000; // chars; generous enough to keep a compact read_page/find result whole

// Anthropic-format history -> Chat Completions messages.
function toChatMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  const lastUserIdx = messages.reduce((last, m, i) => (m.role === 'user' ? i : last), -1);
  messages.forEach((m, mi) => {
    const stale = mi < lastUserIdx; // an older turn's tool results/screenshots are no longer actionable
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      out.push({ role: 'assistant', content: text || (calls.length ? null : '(no reply)'), ...(calls.length ? { tool_calls: calls } : {}) });
      return;
    }
    // User turn: tool results become `tool` messages (text only); images they carried, and
    // any text/images the user sent, follow in one user message.
    const parts = [];
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const content = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
        let text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') || (content.some((c) => c.type === 'image') ? 'Screenshot attached in the next message.' : '(empty)');
        if (stale && text.length > OLD_TOOL_TEXT_CAP) text = `${text.slice(0, OLD_TOOL_TEXT_CAP)}\n[older tool result trimmed to save tokens; call the tool again for the current page]`;
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${text}` : text });
        for (const c of content) {
          if (c.type !== 'image') continue;
          if (stale) parts.push({ type: 'text', text: '[earlier screenshot omitted to save tokens; take a new one if you need it]' });
          else parts.push({ type: 'image_url', image_url: { url: imageUrl(c.source) } });
        }
      } else if (b.type === 'text') {
        parts.push({ type: 'text', text: b.text });
      } else if (b.type === 'image') {
        parts.push(stale ? { type: 'text', text: '[earlier screenshot omitted to save tokens]' } : { type: 'image_url', image_url: { url: imageUrl(b.source) } });
      }
    }
    if (parts.length) out.push({ role: 'user', content: parts });
  });
  return out;
}

// Token counts for the chat's usage line (features/chat-usage.js): OpenAI and xAI send them in a final
// chunk when asked; OpenRouter also reports the request's cost. Gemini sends usage without asking.
function usageOptions(provider) {
  if (provider === 'openrouter') return { stream_options: { include_usage: true }, usage: { include: true } };
  if (provider === 'openai' || provider === 'xai') return { stream_options: { include_usage: true } };
  return {};
}

const safeId = (id) => (id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : `call_${Math.random().toString(36).slice(2, 12)}`);

// One streamed turn. Returns an Anthropic-shaped message: { content, stop_reason, model }.
async function streamTurn({ provider, model, apiKey, system, messages, tools, signal, emit, noTools = false }) {
  const stream = await clientFor(provider, apiKey).chat.completions.create(
    { model, messages: toChatMessages(system, messages), ...(tools.length ? { tools: toolSchema(tools, provider), ...(noTools ? { tool_choice: 'none' } : {}) } : {}), stream: true, ...usageOptions(provider) },
    { signal },
  );
  let text = '';
  let finish = null;
  const calls = [];
  let usage = null;
  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage; // the last chunk, when the provider sends token counts
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.content) {
      if (!text) emit({ type: 'text_block' });
      text += delta.content;
      emit({ type: 'text', text: delta.content });
    }
    for (const tc of delta.tool_calls || []) {
      const index = Number.isInteger(tc.index) ? tc.index : calls.length;
      const slot = calls[index] || (calls[index] = { id: '', name: '', args: '' });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name && !slot.name) slot.name = tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const call of calls.filter(Boolean)) {
    let input;
    try {
      input = call.args ? JSON.parse(call.args) : {};
    } catch {
      input = {}; // unparseable arguments; the tool validator reports the missing fields
    }
    content.push({ type: 'tool_use', id: safeId(call.id), name: call.name, input });
  }
  if (!content.length) content.push({ type: 'text', text: '(no reply)' });
  const stopReason = calls.length ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : 'end_turn';
  return { content, stop_reason: stopReason, model: `${provider}:${model}`, usage };
}

// One non-streaming request that must answer with a JSON object.
async function completeJSON({ provider, model, apiKey, system, user, maxTokens, temperature, signal }) {
  const res = await clientFor(provider, apiKey).chat.completions.create({
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_object' },
    ...(maxTokens ? { max_completion_tokens: maxTokens } : {}),
    ...(temperature != null ? { temperature } : {}),
  }, signal ? { signal } : undefined);
  return JSON.parse(res.choices?.[0]?.message?.content || '{}');
}

function describeProviderError(err, provider) {
  if (!OpenAIModule || !(err instanceof OpenAIModule.APIError)) return null;
  const label = PROVIDERS[provider]?.label || provider;
  // Offline, DNS, a timeout: there is no HTTP status to report.
  if (err instanceof OpenAIModule.APIConnectionError) {
    const why = String(err.cause?.code || err.cause?.message || '').split('\n')[0].slice(0, 80);
    return { text: `Could not reach ${label}${why ? ` (${why})` : ''}. Check your internet connection and try again.` };
  }
  if (/context length|maximum context|too many tokens|reduce the length/i.test(String(err.message || ''))) return { text: 'This chat has grown too long for the model. Start a new chat (the + at the top of the sidebar) to keep going.' };
  if (err.status === 401 || err.status === 403) return { text: `That ${label} API key was rejected. Add a valid key to continue.`, action: 'settings' };
  if (err.status === 402) return { text: provider === 'openrouter' ? 'Your OpenRouter credits have run out. Add credits at openrouter.ai/settings/credits, or pick a free model.' : `${label} says payment is required. Check your ${label} billing.` };
  if (err.status === 404) return { text: `This ${label} model isn't available for your key. Pick another model.` };
  if (err.status === 429) return { text: provider === 'openrouter' ? 'OpenRouter is rate limiting this model. Wait a moment, or pick another model.' : `${label} rate limit or quota reached. Wait a moment, or check your ${label} billing.` };
  if (err.status >= 500) return { text: `${label} is having trouble right now (error ${err.status}). Try again in a minute, or pick another model.` };
  return { text: err.status ? `${label} error ${err.status}: ${err.message}` : `${label} error: ${err.message}` };
}

module.exports = { PROVIDERS, splitModel, listModels, checkKey, streamTurn, completeJSON, describeProviderError, toChatMessages, openRouterCatalog, parseOpenRouterModels, curatedOpenRouter, canUseTools, resetCatalog: () => { catalog = null; } };
