// Local AI: models that run on this computer under Ollama or LM Studio (Settings → AI → AI providers → Local).
// Both servers speak the OpenAI Chat Completions protocol, so chat goes through ai/providers.js like any other provider;
// this file holds what is specific to them: the server address (and the rule that it stays on this computer unless the
// user says otherwise), finding the installed models, and which of them can use tools. No key, and nothing leaves the machine.
// Loaded on first use (ai/providers.js and the settings handlers); never at startup.

const FLAVORS = ['ollama', 'lmstudio'];
const DEFAULT_URLS = { ollama: 'http://127.0.0.1:11434', lmstudio: 'http://127.0.0.1:1234/v1' };
const LABELS = { ollama: 'Ollama', lmstudio: 'LM Studio' };
const DETECT_TIMEOUT_MS = 4000;
const MAX_MODELS = 200;

// localhost, 127.0.0.1 and ::1 (and anything.localhost): the machine itself.
function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}

// What the user typed -> a clean address for this server, or why not.
// Ollama keeps its root ("http://127.0.0.1:11434"; a trailing /v1 is dropped), LM Studio keeps its /v1.
// { ok: true, url, host, local } | { ok: false, error }
function normalizeUrl(flavor, raw) {
  const kind = FLAVORS.includes(flavor) ? flavor : 'ollama';
  let text = String(raw ?? '').trim();
  if (!text) text = DEFAULT_URLS[kind];
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let u;
  try { u = new URL(text); } catch { return { ok: false, error: 'That doesn’t look like an address. Try http://127.0.0.1:11434.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'The address must start with http:// or https://.' };
  if (u.username || u.password) return { ok: false, error: 'Leave the user name and password out of the address.' };
  let path = u.pathname.replace(/\/+$/, '');
  if (kind === 'ollama') path = path.replace(/\/v1$/, '');
  else if (!/\/v1$/.test(path)) path += '/v1';
  return { ok: true, url: `${u.protocol}//${u.host}${path}`, host: u.host, local: isLoopbackHost(u.hostname) };
}

// The saved settings (settings.localAI), cleaned. The address is kept only when it is valid.
// confirmedHost: the one non-local host:port the user said yes to (anything else must be local).
function clean(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const flavor = FLAVORS.includes(r.flavor) ? r.flavor : 'ollama';
  const n = normalizeUrl(flavor, r.url);
  const models = (Array.isArray(r.models) ? r.models : []).map((m) => (typeof m === 'string' ? { id: m, tools: null } : m))
    .filter((m) => m && typeof m.id === 'string' && /^[^\s\u0000-\u001f]{1,200}$/.test(m.id))
    .map((m) => ({ id: m.id, tools: typeof m.tools === 'boolean' ? m.tools : null })).slice(0, MAX_MODELS);
  return {
    enabled: r.enabled === true,
    flavor,
    url: n.ok ? n.url : DEFAULT_URLS[flavor],
    confirmedHost: typeof r.confirmedHost === 'string' ? r.confirmedHost.slice(0, 200) : '',
    models,
  };
}

// May Lumen talk to this address? Local always; another host only after the user confirmed exactly that host.
function allowed(cfg) {
  const n = normalizeUrl(cfg?.flavor, cfg?.url);
  if (!n.ok) return false;
  return n.local || (Boolean(cfg.confirmedHost) && cfg.confirmedHost === n.host);
}

// The base URL the OpenAI client wants (".../v1" for both).
function baseURL(cfg) {
  const n = normalizeUrl(cfg?.flavor, cfg?.url);
  const url = n.ok ? n.url : DEFAULT_URLS.ollama;
  return cfg?.flavor === 'lmstudio' ? url : `${url}/v1`;
}
// The server's own root, for its native endpoints (Ollama /api/tags, LM Studio /api/v0/models).
const rootOf = (cfg) => normalizeUrl(cfg?.flavor, cfg?.url).url.replace(/\/v1$/, '');

async function getJson(fetchImpl, url, init = {}, timeoutMs = DETECT_TIMEOUT_MS) {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

const looksLikeEmbedder = (id) => /(^|[-_/:.])(embed|embedding|rerank)/i.test(id);

// Ollama: /api/tags lists them; /api/show says what each can do ("capabilities": ["completion", "tools", ...] on recent versions).
async function detectOllama(cfg, fetchImpl) {
  const root = rootOf(cfg);
  const tags = await getJson(fetchImpl, `${root}/api/tags`);
  const names = (tags?.models || []).map((m) => m?.model || m?.name).filter((n) => typeof n === 'string' && n).slice(0, MAX_MODELS);
  const out = [];
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const id = names[next++];
      let tools = null;
      let skip = looksLikeEmbedder(id);
      try {
        const show = await getJson(fetchImpl, `${root}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: id }) }, 3000);
        if (Array.isArray(show?.capabilities)) {
          tools = show.capabilities.includes('tools');
          skip = !show.capabilities.includes('completion');
        }
      } catch { /* an older Ollama has no capabilities: tools stay unknown (tried on the first message) */ }
      if (!skip) out.push({ id, tools });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return names.map((id) => out.find((m) => m.id === id)).filter(Boolean);
}

// LM Studio: /v1/models lists them; its own /api/v0/models adds the type and capabilities ("tool_use") on recent versions.
async function detectLmStudio(cfg, fetchImpl) {
  const list = await getJson(fetchImpl, `${baseURL(cfg)}/models`);
  const ids = (list?.data || []).map((m) => m?.id).filter((n) => typeof n === 'string' && n).slice(0, MAX_MODELS);
  let rich = new Map();
  try {
    const v0 = await getJson(fetchImpl, `${rootOf(cfg)}/api/v0/models`, {}, 3000);
    rich = new Map((v0?.data || []).filter((m) => m?.id).map((m) => [m.id, m]));
  } catch { /* an older LM Studio: tools stay unknown */ }
  return ids.filter((id) => (rich.has(id) ? !/embed/i.test(String(rich.get(id).type || '')) : !looksLikeEmbedder(id)))
    .map((id) => {
      const caps = rich.get(id)?.capabilities;
      return { id, tools: Array.isArray(caps) ? caps.includes('tool_use') : null };
    });
}

// { ok: true, models: [{ id, tools }] } | { ok: false, error } (plain words; never throws).
async function detect(cfg, { fetchImpl = globalThis.fetch } = {}) {
  const c = clean(cfg);
  if (!allowed(c)) return { ok: false, error: 'That address isn’t on this computer. Confirm it first if you mean to use it.' };
  const name = LABELS[c.flavor];
  try {
    const models = c.flavor === 'lmstudio' ? await detectLmStudio(c, fetchImpl) : await detectOllama(c, fetchImpl);
    if (!models.length) return { ok: true, models: [], note: `${name} is running but has no models yet. ${c.flavor === 'ollama' ? 'Run “ollama pull llama3.2” in a terminal' : 'Download one in LM Studio'}, then press Detect again.` };
    return { ok: true, models };
  } catch (err) {
    if (err?.status) return { ok: false, error: `${name} at ${c.url} answered with an error (${err.status}). Check the address and the server type.` };
    return { ok: false, error: `Couldn’t reach ${name} at ${c.url}. Is it running${c.flavor === 'lmstudio' ? ' (turn on its local server)' : ''}?` };
  }
}

// An error from a server that doesn't take tools for this model ("does not support tools"): the caller retries as plain chat.
function isNoToolsError(err) {
  if (!err || (err.status && err.status !== 400 && err.status !== 422 && err.status !== 500)) return false;
  return /tool|function.?call/i.test(String(err.message || err.error?.message || '')) && /(support|capab|not (available|allowed|enabled)|invalid|unknown|unsupported)/i.test(String(err.message || err.error?.message || ''));
}

// ---- Auto-detect: which server is running on this computer at its usual address ----
// Both default addresses are tried at once (loopback only, short timeout). The one with models wins; LM Studio before
// Ollama when both answer, unless `prefer` names the other. { ok: true, flavor, url, models } | { ok: false, error }.
const AUTO_TIMEOUT_MS = 1500;
async function autoDetect({ prefer = 'lmstudio', fetchImpl = globalThis.fetch } = {}) {
  const quick = (url, init = {}) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(AUTO_TIMEOUT_MS) });
  const order = prefer === 'ollama' ? ['ollama', 'lmstudio'] : ['lmstudio', 'ollama'];
  const results = await Promise.all(order.map((flavor) => detect({ flavor, url: DEFAULT_URLS[flavor] }, { fetchImpl: quick }).then((r) => ({ flavor, ...r }))));
  const running = results.filter((r) => r.ok);
  const pick = running.find((r) => r.models.length) || running[0];
  if (!pick) return { ok: false, error: 'Neither LM Studio nor Ollama is running at its usual address. Start one (in LM Studio, turn on its local server), then press Detect.' };
  return { ok: true, flavor: pick.flavor, url: DEFAULT_URLS[pick.flavor], models: pick.models, ...(pick.note ? { note: pick.note } : {}) };
}

// ---- LM Studio: model loader and the stats it reports ----
// /api/v0/models has every downloaded model with its state; /api/v1/models/load and /unload (LM Studio 0.4+) load and
// free one; a short /api/v0/chat/completions returns LM Studio's own speed stats. Only for an allowed LM Studio address.
const LOAD_TIMEOUT_MS = 180000;
const BENCH_TIMEOUT_MS = 120000;
const MODEL_ID = /^[^\s\u0000-\u001f]{1,200}$/;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v ? v.slice(0, 200) : null);
function lmGuard(cfg) {
  const c = clean(cfg);
  if (c.flavor !== 'lmstudio') return { error: 'This works with LM Studio only.' };
  if (!allowed(c)) return { error: 'That address isn’t on this computer. Confirm it first if you mean to use it.' };
  return { c, root: rootOf(c) };
}
const lmError = (err, what) => {
  if (err?.status === 404 || err?.status === 405) return `This LM Studio can’t ${what} from other apps. Update LM Studio to 0.4 or newer, or do it in LM Studio.`;
  if (err?.status) return `LM Studio answered with an error (${err.status}) when asked to ${what}.`;
  if (err?.name === 'TimeoutError') return `LM Studio took too long to ${what}.`;
  return 'Couldn’t reach LM Studio. Is its local server on?';
};
const post = (fetchImpl, url, body, timeoutMs) => getJson(fetchImpl, url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs);

// Every downloaded model and what LM Studio says about it.
// { ok: true, models: [{ id, type, state, loaded, arch, quant, format, publisher, context, tools }] } | { ok: false, error }
async function lmStudioStatus(cfg, { fetchImpl = globalThis.fetch } = {}) {
  const g = lmGuard(cfg);
  if (g.error) return { ok: false, error: g.error };
  try {
    const v0 = await getJson(fetchImpl, `${g.root}/api/v0/models`);
    const models = (v0?.data || []).filter((m) => typeof m?.id === 'string' && MODEL_ID.test(m.id)).slice(0, MAX_MODELS).map((m) => ({
      id: m.id,
      type: str(m.type),
      state: str(m.state),
      loaded: m.state === 'loaded',
      arch: str(m.arch),
      quant: str(m.quantization),
      format: str(m.compatibility_type),
      publisher: str(m.publisher),
      context: num(m.max_context_length),
      tools: Array.isArray(m.capabilities) ? m.capabilities.includes('tool_use') : null,
    }));
    return { ok: true, models };
  } catch (err) { return { ok: false, error: lmError(err, 'list its models') }; }
}

// Load one model into memory. contextLength is optional (LM Studio's own default otherwise).
async function lmStudioLoad(cfg, model, { contextLength, fetchImpl = globalThis.fetch } = {}) {
  const g = lmGuard(cfg);
  if (g.error) return { ok: false, error: g.error };
  if (typeof model !== 'string' || !MODEL_ID.test(model)) return { ok: false, error: 'Pick a model to load.' };
  const body = { model, echo_load_config: true };
  if (Number.isInteger(contextLength) && contextLength >= 512 && contextLength <= 4194304) body.context_length = contextLength;
  try {
    const r = await post(fetchImpl, `${g.root}/api/v1/models/load`, body, LOAD_TIMEOUT_MS);
    return { ok: true, instanceId: str(r?.instance_id) || model, seconds: num(r?.load_time_seconds), context: num(r?.load_config?.context_length) };
  } catch (err) { return { ok: false, error: lmError(err, 'load models') }; }
}

// Free one loaded model (its instance id is the model id unless it was loaded twice).
async function lmStudioUnload(cfg, instanceId, { fetchImpl = globalThis.fetch } = {}) {
  const g = lmGuard(cfg);
  if (g.error) return { ok: false, error: g.error };
  if (typeof instanceId !== 'string' || !MODEL_ID.test(instanceId)) return { ok: false, error: 'Pick a model to unload.' };
  try {
    await post(fetchImpl, `${g.root}/api/v1/models/unload`, { instance_id: instanceId }, 30000);
    return { ok: true };
  } catch (err) { return { ok: false, error: lmError(err, 'unload models') }; }
}

// A short reply, for the stats LM Studio reports with it: speed, time to first token, and the runtime it used.
// (LM Studio loads a model that isn't loaded yet first, so a test right after can be slow.)
async function lmStudioBenchmark(cfg, model, { fetchImpl = globalThis.fetch } = {}) {
  const g = lmGuard(cfg);
  if (g.error) return { ok: false, error: g.error };
  if (typeof model !== 'string' || !MODEL_ID.test(model)) return { ok: false, error: 'Pick a model to test.' };
  try {
    const r = await post(fetchImpl, `${g.root}/api/v0/chat/completions`, { model, messages: [{ role: 'user', content: 'Count from 1 to 20, separated by spaces.' }], max_tokens: 64, temperature: 0, stream: false }, BENCH_TIMEOUT_MS);
    const s = r?.stats || {};
    return {
      ok: true,
      stats: {
        tokensPerSecond: num(s.tokens_per_second),
        firstTokenSeconds: num(s.time_to_first_token),
        generationSeconds: num(s.generation_time),
        stopReason: str(s.stop_reason),
        promptTokens: num(r?.usage?.prompt_tokens),
        completionTokens: num(r?.usage?.completion_tokens),
        arch: str(r?.model_info?.arch),
        quant: str(r?.model_info?.quant),
        format: str(r?.model_info?.format),
        context: num(r?.model_info?.context_length),
        runtime: str(r?.runtime?.name),
        runtimeVersion: str(r?.runtime?.version),
      },
    };
  } catch (err) { return { ok: false, error: lmError(err, 'run a test reply') }; }
}

module.exports = { FLAVORS, DEFAULT_URLS, LABELS, isLoopbackHost, normalizeUrl, clean, allowed, baseURL, rootOf, detect, isNoToolsError, autoDetect, lmStudioStatus, lmStudioLoad, lmStudioUnload, lmStudioBenchmark };
