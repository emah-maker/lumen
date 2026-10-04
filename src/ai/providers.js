// OpenAI-compatible providers (OpenAI, xAI Grok, Google Gemini, OpenRouter) for the agent loop.
//
// The conversation is stored in Anthropic's message format (content blocks). For these providers
// it is converted to Chat Completions messages on every request, and each reply is converted
// back, so a chat can move between Claude and any of these models.
// The OpenAI SDK (also used for Grok and Gemini) loads only when one of them is first used.
let OpenAIModule = null;
const OpenAISDK = () => (OpenAIModule ||= require('openai'));
const { netFetch } = require('../browser/net-fetch');
const genImages = require('../features/gen-images');
const effortLib = require('./effort');
const providerUsage = require('../features/provider-usage');

const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    baseURL: undefined,
    defaults: ['gpt-5.6', 'gpt-5.6-mini'],
    include: (id) => /^(gpt-|o\d)/.test(id) && !/(audio|realtime|tts|transcribe|image|search|embedding|instruct|moderation|codex|deep-research|computer-use)/.test(id) && !/-pro(-|$)/.test(id), // -pro: Responses API only
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
    include: (id) => /^gemini/.test(id) && !/(embedding|image|tts|aqa|live|audio|computer-use|robotics)/.test(id),
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
const CATALOG_TIMEOUT_MS = 10000;
const CURATED = [/^anthropic\/claude/, /^openai\/gpt/, /^google\/gemini/, /^meta-llama\/llama/, /^deepseek\/deepseek/, /^x-ai\/grok/];
let catalog = null; // { fetchedAt, models: [{ id, name, tools, created }] }
let refreshing = null; // the background refresh under way, if any

// onRefresh: an old copy is returned at once and a fresh one fetched behind it; this runs when it has arrived.
async function openRouterCatalog({ cacheFile, fetchImpl = netFetch(), onRefresh = null } = {}) {
  const fs = require('fs');
  if (!catalog && cacheFile) { try { catalog = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {} }
  if (catalog && Date.now() - catalog.fetchedAt < CATALOG_TTL) return catalog;
  // A copy over a day old: shown at once, and a fresh one fetched behind it (onRefresh runs when it has arrived).
  if (catalog?.models?.length && onRefresh) {
    if (!refreshing) {
      refreshing = fetchCatalog({ cacheFile, fetchImpl }).then(onRefresh, () => {}).finally(() => { refreshing = null; });
    }
    return catalog;
  }
  try { return await fetchCatalog({ cacheFile, fetchImpl }); } catch (err) {
    if (catalog?.models?.length) return catalog; // offline, slow or failing: the last copy (however old) rather than no list
    throw err;
  }
}
// GET /models (giving up after 10 s), kept in memory and in cacheFile.
async function fetchCatalog({ cacheFile, fetchImpl }) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl && setTimeout(() => ctrl.abort(), CATALOG_TIMEOUT_MS);
  let fresh;
  try {
    const res = await fetchImpl(`${PROVIDERS.openrouter.baseURL}/models`, { headers: PROVIDERS.openrouter.headers, ...(ctrl ? { signal: ctrl.signal } : {}) });
    if (!res.ok) throw new Error(`OpenRouter models: HTTP ${res.status}`);
    fresh = parseOpenRouterModels(await res.json());
  } finally { clearTimeout(timer); }
  catalog = { fetchedAt: Date.now(), models: fresh };
  if (cacheFile) { try { require('fs').writeFileSync(cacheFile, JSON.stringify(catalog)); } catch {} }
  return catalog;
}

// The API's list -> text models, with whether they can call tools (needed to act in tabs).
function parseOpenRouterModels(json) {
  return (json?.data || [])
    // Plain ids, and OpenRouter's ":free" variants (one of the things people look for most there).
    .filter((m) => m?.id && (!String(m.id).includes(':') || /:free$/.test(String(m.id))) && /text/.test(m.architecture?.output_modalities?.join(' ') || 'text'))
    .map((m) => ({
      id: m.id, name: m.name || m.id, tools: Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools'), created: m.created || 0,
      ...(Array.isArray(m.architecture?.output_modalities) && m.architecture.output_modalities.includes('image') ? { imageOut: true } : {}), // makes pictures: asked for them (streamTurn), shown in the chat
      ...(Array.isArray(m.architecture?.input_modalities) ? { vision: m.architecture.input_modalities.includes('image') } : {}), // images in: a text-only model is passed over when a chat holds some (ai/fallback.js)
      context: Number(m.context_length) || 0, // for the picker's detail line
      free: /:free$/.test(String(m.id)),
      pricePerM: Number.isFinite(Number(m.pricing?.prompt)) ? Number(m.pricing.prompt) * 1e6 : undefined, // $ per million input tokens
    }));
}

// A short list for the picker: the newest tool-capable model of a few families. A ":free" variant
// (rate-limited, often queued) is picked only when a family has nothing else; the rest stay in More models.
function curatedOpenRouter(models) {
  const picks = [];
  for (const family of CURATED) {
    const best = models.filter((m) => family.test(m.id) && m.tools).sort((a, b) => (a.free === b.free ? b.created - a.created : a.free ? 1 : -1))[0];
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
async function listModels(provider, apiKey, { cacheFile, onRefresh = null } = {}) {
  try {
    if (provider === 'openrouter') return curatedOpenRouter((await openRouterCatalog({ cacheFile, onRefresh })).models); // (a day-old copy at once, refreshed behind)
    const page = await clientFor(provider, apiKey).models.list();
    const ids = [];
    for await (const m of page) ids.push(String(m.id).replace(/^models\//, ''));
    // Newest families first and no dated duplicates (an alphabetical cut used to drop every gpt-* model behind o-series ids).
    const chat = require('../features/model-names').rankModels(ids.filter(PROVIDERS[provider].include), 16);
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
        // A picture the user attached stays in every later request (a follow-up asks about it); only screenshots a tool returned age out (above).
        parts.push({ type: 'image_url', image_url: { url: imageUrl(b.source) } });
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
// effort: the user's reasoning-effort choice for this provider ('' = its default; ai/effort.js decides whether this model takes it).
async function streamTurn({ provider, model, apiKey, system, messages, tools, signal, emit, noTools = false, client = null, effort = '' }) {
  const request = (client || clientFor(provider, apiKey)).chat.completions.create(
    { model, messages: toChatMessages(system, messages), ...(provider === 'openrouter' && openRouterInfo(model)?.imageOut ? { modalities: ['image', 'text'] } : {}), ...(tools.length ? { tools: toolSchema(tools, provider), ...(noTools ? { tool_choice: 'none' } : {}) } : {}), stream: true, ...usageOptions(provider), ...effortLib.chatParams(provider, model, effort) },
    { signal },
  );
  // The response's rate-limit headers come with the same request (no extra call): x-ratelimit-* for OpenAI, xAI and OpenRouter.
  let rate = null;
  let stream;
  if (typeof request.withResponse === 'function') {
    const got = await request.withResponse();
    stream = got.data;
    try { rate = providerUsage.parseRateLimitHeaders(provider, got.response?.headers); } catch { rate = null; }
  } else stream = await request;
  let text = '';
  let finish = null;
  const calls = [];
  let usage = null;
  const pictures = []; // pictures the model made (OpenRouter image models: delta.images), shown in the chat by agent.js
  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage; // the last chunk, when the provider sends token counts
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.images) pictures.push(...genImages.extractImages({ choices: [{ delta }] }));
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
  if (!content.length && !pictures.length) content.push({ type: 'text', text: '(no reply)' });
  const stopReason = calls.length ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : 'end_turn';
  return { content, stop_reason: stopReason, model: `${provider}:${model}`, usage, ...(rate ? { rate } : {}), ...(pictures.length ? { pictures } : {}) };
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

// ---------- making a picture on purpose ("draw a cat") ----------
// Which providers have an images API Lumen calls, and the model used when the account lists none better.
const IMAGE_MODELS = {
  openai: { fallback: 'gpt-image-1', pick: /^gpt-image/ },
  xai: { fallback: 'grok-2-image', pick: /image|imagine/, skip: /video|edit/ },
  gemini: { fallback: 'gemini-2.5-flash-image', pick: /flash-image|pro-image|image-preview/, skip: /imagen|live|tts/ },
};
// Can this model make pictures when asked? (OpenAI, Grok and Gemini: through their image models; OpenRouter: only
// the models its catalog lists as making images, which answer in the chat itself.)
function canGenerateImages(provider, model) {
  if (provider === 'openrouter') return Boolean(openRouterInfo(model)?.imageOut);
  return Boolean(IMAGE_MODELS[provider]);
}
async function imageModelFor(provider, apiKey) {
  const cfg = IMAGE_MODELS[provider];
  try {
    const page = await clientFor(provider, apiKey).models.list();
    const ids = [];
    for await (const m of page) ids.push(String(m.id).replace(/^models\//, ''));
    const found = ids.filter((id) => cfg.pick.test(id) && !(cfg.skip && cfg.skip.test(id))).sort().reverse()[0];
    if (found) return found;
  } catch { /* the default below */ }
  return cfg.fallback;
}

// One picture for `prompt`: { images: [{ data (base64) | url, alt }], model, said } (see features/gen-images.js extractImages),
// from the images API of OpenAI or xAI, or Gemini's generateContent. `fetchImpl` / `client` let tests pass fakes.
// source: { buffer, mime } to edit a picture instead of making one (OpenAI, Gemini and OpenRouter take it; Grok's API does not here).
// Errors carry `policy: true` when the provider refused the content (never a reason to ask another provider), see ai/image-router.js.
const SAFETY_FINISH = /SAFETY|PROHIBITED|BLOCKLIST|SPII/i;
const POLICY_TEXT = /content[_ ]policy|moderation[_ ]blocked|safety system|violat\w* .{0,30}polic|policy violation|not allowed by|prohibited content|rejected by the safety/i;
const canEditImages = (provider) => provider === 'openai' || provider === 'gemini' || provider === 'openrouter';
async function generateImage({ provider, apiKey, prompt, model = null, signal, fetchImpl = netFetch(), client = null, source = null }) {
  if (provider === 'openrouter') return generateOpenRouterImage({ apiKey, prompt, model, signal, client, source });
  const cfg = IMAGE_MODELS[provider];
  if (!cfg) throw new Error(`${PROVIDERS[provider]?.label || provider} has no image model Lumen can ask.`);
  if (source && !canEditImages(provider)) throw Object.assign(new Error(`${PROVIDERS[provider].label} can't edit pictures here.`), { imageApi: true });
  const id = model || await imageModelFor(provider, apiKey);
  if (provider === 'gemini') {
    const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(id)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, ...(source ? [{ inlineData: { mimeType: source.mime, data: source.buffer.toString('base64') } }] : [])] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
      credentials: 'omit',
      ...(signal ? { signal } : {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json?.error?.message || `Gemini error ${res.status}`), { status: res.status, imageApi: true, ...(POLICY_TEXT.test(String(json?.error?.message || '')) ? { policy: true } : {}) });
    const parts = json?.candidates?.[0]?.content?.parts || [];
    const said = parts.filter((p) => typeof p?.text === 'string').map((p) => p.text).join(' ').trim();
    const found = genImages.extractImages(json).map((i) => ({ ...i, alt: i.alt || said.slice(0, 300) }));
    if (!found.length) {
      const blocked = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason;
      throw Object.assign(new Error(said || `Gemini made no picture${blocked ? ` (${blocked})` : ''}.`), { imageApi: true, ...(json?.promptFeedback?.blockReason || SAFETY_FINISH.test(String(json?.candidates?.[0]?.finishReason || '')) ? { policy: true } : {}) });
    }
    return { images: found, model: id, said };
  }
  const api = client || clientFor(provider, apiKey);
  const body = { model: id, prompt, n: 1, ...(/^dall-e|^grok/.test(id) ? { response_format: 'b64_json' } : {}) };
  let res;
  try {
    res = source
      ? await api.images.edit({ model: id, prompt, n: 1, image: await OpenAISDK().toFile(source.buffer, `picture.${source.mime === 'image/jpeg' ? 'jpg' : source.mime.split('/')[1]}`, { type: source.mime }) }, signal ? { signal } : undefined)
      : await api.images.generate(body, signal ? { signal } : undefined);
  } catch (err) {
    if (isPolicyError(err)) err.policy = true;
    throw err;
  }
  const found = genImages.extractImages(res);
  if (!found.length) throw Object.assign(new Error(`${PROVIDERS[provider].label} made no picture.`), { imageApi: true });
  return { images: found.map((i) => ({ ...i, alt: i.alt || prompt.slice(0, 300) })), model: id, said: '' };
}

// Did the provider refuse the picture itself (its content policy), as opposed to being down, limited or misconfigured?
function isPolicyError(err) {
  if (err?.policy === true) return true;
  const code = String(err?.code || err?.error?.code || err?.error?.error?.code || '');
  return /content_policy|moderation_blocked/i.test(code) || (POLICY_TEXT.test(String(err?.message || '')) && (!err?.status || err.status === 400 || err.status === 403));
}

// OpenRouter makes pictures through its chat endpoint: a model that lists image output, asked with modalities.
function openRouterImageModel(preferred = null) {
  if (preferred && openRouterInfo(preferred)?.imageOut) return preferred;
  const list = (catalog?.models || []).filter((m) => m.imageOut);
  return [...list].sort((a, b) => (a.pricePerM ?? 1e9) - (b.pricePerM ?? 1e9))[0]?.id || null;
}
async function generateOpenRouterImage({ apiKey, prompt, model, signal, client, source }) {
  const id = model || openRouterImageModel();
  if (!id) throw Object.assign(new Error('OpenRouter lists no picture model for this key.'), { imageApi: true });
  const api = client || clientFor('openrouter', apiKey);
  const content = source ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:${source.mime};base64,${source.buffer.toString('base64')}` } }] : prompt;
  let res;
  try { res = await api.chat.completions.create({ model: id, messages: [{ role: 'user', content }], modalities: ['image', 'text'] }, signal ? { signal } : undefined); } catch (err) { if (isPolicyError(err)) err.policy = true; throw err; }
  const found = genImages.extractImages(res);
  const said = String(res?.choices?.[0]?.message?.content || '').trim();
  if (!found.length) throw Object.assign(new Error(said || 'OpenRouter made no picture.'), { imageApi: true, ...(res?.choices?.[0]?.finish_reason === 'content_filter' ? { policy: true } : {}) });
  return { images: found.map((i) => ({ ...i, alt: i.alt || prompt.slice(0, 300) })), model: id, said: '' };
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
  // A model that takes no images, given a chat that holds some (a catalog can be wrong or silent about it).
  if ([400, 404, 415, 422].includes(err.status) && /image|vision|multimodal|modalit/i.test(String(err.message || ''))) return { text: `This ${label} model can't read images. Remove the image from the chat (start a new chat) or pick a model that can see images.` };
  if (err.status === 401 || err.status === 403) return { text: `That ${label} API key was rejected. Add a valid key to continue.`, action: 'settings' };
  if (err.status === 402) return { text: provider === 'openrouter' ? 'Your OpenRouter credits have run out. Add credits at openrouter.ai/settings/credits, or pick a free model.' : `${label} says payment is required. Check your ${label} billing.` };
  if (err.status === 404) return { text: `This ${label} model isn't available for your key. Pick another model.` };
  if (err.status === 429) return { text: provider === 'openrouter' ? 'OpenRouter is rate limiting this model. Wait a moment, or pick another model.' : `${label} rate limit or quota reached. Wait a moment, or check your ${label} billing.` };
  if (err.status >= 500) return { text: `${label} is having trouble right now (error ${err.status}). Try again in a minute, or pick another model.` };
  return { text: err.status ? `${label} error ${err.status}: ${err.message}` : `${label} error: ${err.message}` };
}

// OpenRouter's own name for a model, without its vendor ("Anthropic: Claude Opus 5.5" -> "Claude Opus 5.5"), if known.
// What the catalog knows of a model: its context size, price per million input tokens and whether it is free.
function openRouterInfo(model) {
  const m = catalog?.models?.find((x) => x.id === model);
  return m ? { context: m.context || 0, pricePerM: m.pricePerM, free: Boolean(m.free), ...(m.imageOut ? { imageOut: true } : {}), ...(typeof m.vision === 'boolean' ? { vision: m.vision } : {}) } : null;
}
function openRouterName(model) {
  const m = catalog?.models?.find((x) => x.id === model);
  if (!m?.name) return null;
  const bare = String(m.name).includes(':') ? String(m.name).split(':').slice(1).join(':').trim() : String(m.name);
  return bare.replace(/\s*\(free\)\s*$/i, '').trim() || bare;
}

module.exports = { imageUrl, clientFor, canGenerateImages, canEditImages, isPolicyError, openRouterImageModel, generateImage, imageModelFor, IMAGE_MODELS, PROVIDERS, openRouterName, openRouterInfo, splitModel, listModels, checkKey, streamTurn, completeJSON, describeProviderError, toChatMessages, openRouterCatalog, parseOpenRouterModels, curatedOpenRouter, canUseTools, resetCatalog: () => { catalog = null; } };
