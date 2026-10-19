// Voice input for the chat box (renderer/dictation.js): the recording is turned into text by one of
// the user's own API providers. Chromium's SpeechRecognition can't work in Electron (it needs
// Google's private speech key; preload/permissions-preload.js hides it from sites for that reason),
// so the audio goes, once, to the provider chosen here and to nothing else. Nothing is written to disk.
//
// Pure: main.js passes the key and the fetch, so test/dictation-units.js runs it without Electron.
// Keys stay in the main process; the renderer only learns which provider is used.

const PROVIDERS = ['openai', 'gemini']; // the order "auto" tries them in
const SETTINGS = ['auto', 'openai', 'gemini', 'off'];
const LABELS = { openai: 'OpenAI', gemini: 'Google Gemini' };
const MAX_SECONDS = 120;
const MAX_BYTES = 8 * 1024 * 1024; // 2 minutes of 16 kHz WAV is 3.8 MB; WebM/Opus far less
// What each provider is sent: OpenAI takes the recorder's WebM/Opus as it is; Gemini's documented audio
// types don't include WebM, so the page turns the recording into 16 kHz mono WAV first.
const FORMATS = { openai: 'webm', gemini: 'wav' };
const MIME = { webm: 'audio/webm', wav: 'audio/wav' };
const OPENAI_MODELS = ['gpt-4o-mini-transcribe', 'whisper-1']; // the second when the key can't use the first
const GEMINI_FALLBACK = 'gemini-2.5-flash';
const PROMPT = 'Transcribe this audio verbatim. Reply with the transcript only: no notes, no quotation marks, no timestamps. If nothing is said, reply with nothing.';
const TIMEOUT_MS = 60000;

const cleanSetting = (value) => (SETTINGS.includes(value) ? value : 'auto');

// setting: dictationProvider; has(provider) -> is a key set. Returns { provider } or { provider: null, reason, need }.
// reason 'off': turned off in Settings; 'no-key': the provider asked for (or any, for auto) has no key.
function choose(setting, has) {
  const s = cleanSetting(setting);
  if (s === 'off') return { provider: null, reason: 'off', need: [] };
  const order = s === 'auto' ? PROVIDERS : [s];
  const provider = order.find((p) => has(p)) || null;
  return provider ? { provider } : { provider: null, reason: 'no-key', need: order };
}

// The message for a mic button with nothing to send the audio to: { key, params } for t().
function unavailableMessage(choice) {
  if (!choice || choice.provider) return null;
  if (choice.reason === 'off') return { key: 'dictation.off', params: {} };
  if (choice.need.length === 1) return { key: 'dictation.needKey', params: { provider: LABELS[choice.need[0]] } };
  return { key: 'dictation.needAnyKey', params: { providers: choice.need.map((p) => LABELS[p]).join(' or ') } };
}

// Gemini: a fast Flash model the key lists, else a known one.
function geminiModel(models) {
  const list = Array.isArray(models) ? models : [];
  return list.find((m) => /flash/i.test(m) && !/(lite|image|tts|live|audio|thinking)/i.test(m)) || GEMINI_FALLBACK;
}

// A multipart/form-data body built by hand (Electron's net.fetch and Node's fetch both take a Buffer the same way).
function multipart(fields, file, boundary) {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

// { provider, key, audio (Buffer), format ('webm'|'wav'), model?, language? } -> { url, init }
function buildRequest({ provider, key, audio, format, model, language = '', boundary }) {
  const type = MIME[format] || MIME.webm;
  if (provider === 'openai') {
    const b = boundary || `----lumen${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
    const fields = { model: model || OPENAI_MODELS[0], response_format: 'json' };
    if (/^[a-z]{2}$/.test(language)) fields.language = language;
    return {
      url: 'https://api.openai.com/v1/audio/transcriptions',
      init: { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': `multipart/form-data; boundary=${b}` }, body: multipart(fields, { name: `speech.${format === 'wav' ? 'wav' : 'webm'}`, type, data: audio }, b) },
    };
  }
  if (provider === 'gemini') {
    const id = model || GEMINI_FALLBACK;
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(id)}:generateContent`,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: PROMPT }, { inline_data: { mime_type: type, data: audio.toString('base64') } }] }],
          generationConfig: { temperature: 0 },
        }),
      },
    };
  }
  throw new Error(`No transcription for ${provider}`);
}

// The provider's answer -> the text ('' when nothing was said).
function parseResponse(provider, json) {
  if (provider === 'openai') return String(json?.text || '').trim();
  const parts = json?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
}

// An HTTP failure -> { key, params } for t(). body: the parsed error JSON, if any.
function mapError(provider, status, body) {
  const params = { provider: LABELS[provider] || provider };
  const text = String(body?.error?.message || body?.error?.status || body?.error?.code || '');
  if (status === 401 || status === 403 || /api key|API_KEY_INVALID|PERMISSION_DENIED|invalid_api_key/i.test(text)) return { key: 'dictation.error.key', params };
  if (status === 429 || /quota|rate limit|RESOURCE_EXHAUSTED|insufficient_quota/i.test(text)) return { key: 'dictation.error.quota', params };
  if (status === 413) return { key: 'dictation.error.tooLong', params };
  if (status === 400) return { key: 'dictation.error.audio', params };
  if (status >= 500) return { key: 'dictation.error.unavailable', params };
  return { key: 'dictation.error.other', params: { ...params, status: String(status) } };
}

// A key without the transcription model (an OpenAI project limited to some models, or a model id retired).
const modelMissing = (status, body) => status === 404 || (status === 403 && /model/i.test(String(body?.error?.message || ''))) || body?.error?.code === 'model_not_found';

// The one call. Returns { text } or { error: { key, params } }; never throws for an HTTP or network failure.
async function transcribe({ provider, key, audio, format, models, language = '', fetchImpl, signal, timeoutMs = TIMEOUT_MS }) {
  if (!Buffer.isBuffer(audio) || !audio.length) return { error: { key: 'dictation.error.empty', params: {} } };
  if (audio.length > MAX_BYTES) return { error: { key: 'dictation.error.tooLong', params: { provider: LABELS[provider] } } };
  const tries = provider === 'openai' ? OPENAI_MODELS : [geminiModel(models)];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener?.('abort', onAbort);
  try {
    for (let i = 0; i < tries.length; i++) {
      const { url, init } = buildRequest({ provider, key, audio, format, model: tries[i], language });
      let res;
      try {
        res = await fetchImpl(url, { ...init, signal: ctrl.signal });
      } catch (err) {
        if (signal?.aborted) return { error: { key: 'dictation.error.cancelled', params: {} } };
        if (ctrl.signal.aborted) return { error: { key: 'dictation.error.timeout', params: { provider: LABELS[provider] } } };
        return { error: { key: 'dictation.error.network', params: { provider: LABELS[provider], detail: String(err?.message || err).slice(0, 120) } } };
      }
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (res.ok) return { text: parseResponse(provider, body) };
      if (i < tries.length - 1 && modelMissing(res.status, body)) continue;
      return { error: mapError(provider, res.status, body) };
    }
    return { error: { key: 'dictation.error.other', params: { provider: LABELS[provider], status: '?' } } };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

// The permission rule for Lumen's own pages: the sidebar's window (renderer/index.html) and the chat page (lumen://chat) may
// use the microphone, for this and nothing else: audio only, from the page's top frame, never a frame inside it and never a
// web page (web pages keep the per-site prompt in main.js). isOwnPage(url) says whether a file URL is one of those pages
// and isOwnView whether the asking view is the one Lumen made for it.
function ownPageMic({ permission, mediaTypes, requestingUrl, pageUrl, isMainFrame, isOwnView, isOwnPage }) {
  if (permission !== 'media' || !isOwnView) return false;
  if (isMainFrame === false) return false;
  const types = Array.isArray(mediaTypes) ? mediaTypes : [];
  if (types.length !== 1 || types[0] !== 'audio') return false;
  return Boolean(isOwnPage(requestingUrl) && isOwnPage(pageUrl));
}

module.exports = { ownPageMic, PROVIDERS, SETTINGS, LABELS, FORMATS, MAX_SECONDS, MAX_BYTES, OPENAI_MODELS, PROMPT, cleanSetting, choose, unavailableMessage, geminiModel, buildRequest, parseResponse, mapError, transcribe };
