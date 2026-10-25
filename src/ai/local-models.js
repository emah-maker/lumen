// Local AI: models that run on this computer under Ollama or LM Studio (Settings → AI and agents → AI providers → Local).
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

module.exports = { FLAVORS, DEFAULT_URLS, LABELS, isLoopbackHost, normalizeUrl, clean, allowed, baseURL, rootOf, detect, isNoToolsError };
