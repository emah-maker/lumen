// OpenAI-compatible providers (OpenAI, xAI Grok, Google Gemini, OpenRouter) for the agent loop.
//
// The conversation is stored in Anthropic's message format (content blocks). For these providers
// it is converted to Chat Completions messages on every request, and each reply is converted
// back, so a chat can move between Claude and any of these models.
// The OpenAI SDK (also used for Grok and Gemini) loads only when one of them is first used.
let OpenAIModule = null;
const OpenAISDK = () => (OpenAIModule ||= require('openai'));

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

async function openRouterCatalog({ cacheFile, fetchImpl = fetch } = {}) {
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
  return new OpenAI({ apiKey, baseURL: PROVIDERS[provider].baseURL, defaultHeaders: PROVIDERS[provider].headers, maxRetries: 2 });
}

// Lists chat models the key can use (newest-looking first); falls back to defaults on error.
async function listModels(provider, apiKey, { cacheFile } = {}) {
  try {
    if (provider === 'openrouter') return curatedOpenRouter((await openRouterCatalog({ cacheFile })).models);
    const page = await clientFor(provider, apiKey).models.list();
    const ids = [];
    for await (const m of page) ids.push(String(m.id).replace(/^models\//, ''));
    const chat = ids.filter(PROVIDERS[provider].include).sort().reverse();
    return chat.length ? chat.slice(0, 12) : PROVIDERS[provider].defaults;
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

// Anthropic-format history -> Chat Completions messages.
function toChatMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      out.push({ role: 'assistant', content: text || (calls.length ? null : '(no reply)'), ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // User turn: tool results become `tool` messages (text only); images they carried, and
    // any text/images the user sent, follow in one user message.
    const parts = [];
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const content = Array.isArray(b.content) ? b.content : [{ type: 'text', text: String(b.content ?? '') }];
        const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') || (content.some((c) => c.type === 'image') ? 'Screenshot attached in the next message.' : '(empty)');
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${text}` : text });
        for (const c of content) if (c.type === 'image') parts.push({ type: 'image_url', image_url: { url: imageUrl(c.source) } });
      } else if (b.type === 'text') {
        parts.push({ type: 'text', text: b.text });
      } else if (b.type === 'image') {
        parts.push({ type: 'image_url', image_url: { url: imageUrl(b.source) } });
      }
    }
    if (parts.length) out.push({ role: 'user', content: parts });
  }
  return out;
}

const safeId = (id) => (id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : `call_${Math.random().toString(36).slice(2, 12)}`);

// One streamed turn. Returns an Anthropic-shaped message: { content, stop_reason, model }.
async function streamTurn({ provider, model, apiKey, system, messages, tools, signal, emit }) {
  const stream = await clientFor(provider, apiKey).chat.completions.create(
    { model, messages: toChatMessages(system, messages), ...(tools.length ? { tools: toolSchema(tools, provider) } : {}), stream: true },
    { signal },
  );
  let text = '';
  let finish = null;
  const calls = [];
  for await (const chunk of stream) {
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
  return { content, stop_reason: stopReason, model: `${provider}:${model}` };
}

// One non-streaming request that must answer with a JSON object.
async function completeJSON({ provider, model, apiKey, system, user }) {
  const res = await clientFor(provider, apiKey).chat.completions.create({
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_object' },
  });
  return JSON.parse(res.choices?.[0]?.message?.content || '{}');
}

function describeProviderError(err, provider) {
  if (!OpenAIModule || !(err instanceof OpenAIModule.APIError)) return null;
  const label = PROVIDERS[provider]?.label || provider;
  if (err.status === 401 || err.status === 403) return { text: `That ${label} API key was rejected. Add a valid key to continue.`, action: 'settings' };
  if (err.status === 402) return { text: provider === 'openrouter' ? 'Your OpenRouter credits have run out. Add credits at openrouter.ai/settings/credits, or pick a free model.' : `${label} says payment is required. Check your ${label} billing.` };
  if (err.status === 404) return { text: `This ${label} model isn't available for your key. Pick another model.` };
  if (err.status === 429) return { text: provider === 'openrouter' ? 'OpenRouter is rate limiting this model. Wait a moment, or pick another model.' : `${label} rate limit or quota reached. Wait a moment, or check your ${label} billing.` };
  return { text: `${label} error ${err.status ?? ''}: ${err.message}`.trim() };
}

module.exports = { PROVIDERS, splitModel, listModels, streamTurn, completeJSON, describeProviderError, toChatMessages, openRouterCatalog, parseOpenRouterModels, curatedOpenRouter, canUseTools, resetCatalog: () => { catalog = null; } };
