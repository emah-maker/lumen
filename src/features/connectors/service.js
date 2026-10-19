// Connectors, the running part (see registry.js for what they are): what the user connected, the secrets kept
// encrypted, the requests to each service, and the one `connector` tool the AI uses.
//
// Where things go:
//  - userData/connectors.json: which connectors are on, the account shown on the card and non-secret settings (a school's
//    Canvas address). A token or secret address is sealed with the OS's own encryption (safeStorage, as passwords.js and
//    mcp-client.js do) before it is written; the page never gets it back, only whether one is saved.
//  - A request goes only to the connector's own service (its fixed address; a school's own Canvas address), over https,
//    with no redirect followed. A 'session' connector sends the user's signed-in Lumen cookies there and nowhere else; the
//    others send their token there. Tests point a connector at 127.0.0.1 through `endpoints` (main.js allows that only in test mode).
//  - Disconnecting forgets the entry and the sealed secret and drops cached answers.
//  - Gmail's drafts need Google's gmail.compose permission on the shared Google sign-in: allowDrafts() asks for it, only when the
//    user presses Allow drafts on the card (google.allowDrafts, widgets.js gmailAllowDrafts).
//  - Answers are cached for 30 seconds in memory only, so asking twice in a row is one request.
'use strict';
const fs = require('fs');
const path = require('path');
const registry = require('./registry');
const { ConnectorError, flat } = require('./util');

const FILE = 'connectors.json';
const CACHE_MS = 30e3;
const TIMEOUT_MS = 20e3;
const MAX_BODY = 3e6;
const RESULT_CHARS = 40000;
const BASES = {
  github: 'https://api.github.com',
  todoist: 'https://api.todoist.com/api/v1',
  notion: 'https://api.notion.com/v1',
};
const GOOGLE_SIGN_IN = 'https://accounts.google.com/ServiceLogin?service=mail&continue=https%3A%2F%2Fmail.google.com%2Fmail%2F';
const provider = (id) => require(`./providers/${id}`); // loaded when a connector is first used (not at startup)

function create({
  userData, secrets, fetch = globalThis.fetch, sessionFetch = null, endpoints = () => ({}), detectHosts = async () => [],
  google = null, mcp = null, openSignIn = () => {}, now = Date.now, onChange = () => {}, testLoopback = false,
}) {
  const file = path.join(userData, FILE);
  let connected = load();
  const runtime = new Map(); // id -> 'ok' | 'needs-signin' | 'bad-token' (what the last request found)
  const cache = new Map(); // key -> { at, text }

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const out = {};
      for (const [id, e] of Object.entries(data?.connected || {})) if (registry.get(id) && e && typeof e === 'object') out[id] = e;
      return out;
    } catch { return {}; }
  }
  function persist() {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, connected }, null, 2), { mode: 0o600 });
  }
  function changed() {
    registry.setConnected(Object.keys(connected).filter((id) => registry.get(id).kind !== 'mcp'));
    try { onChange(); } catch { /* the page looks again next time */ }
  }
  const seal = (value) => {
    if (!secrets?.available()) throw new Error('This computer’s secure storage isn’t available, so Lumen can’t keep a token safely.');
    return secrets.encrypt(String(value));
  };
  const open = (sealed) => { try { return sealed ? secrets.decrypt(sealed) : ''; } catch { return ''; } };
  changed();

  // ---- requests
  const baseOf = (def, entry) => {
    const override = endpoints()?.[def.id];
    if (override) return String(override).replace(/\/+$/, '');
    if (def.id === 'canvas') return `https://${entry.config?.domain || ''}`;
    return BASES[def.id] || '';
  };
  const loopback = (u) => testLoopback && u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname);

  function makeCtx(def, entry, signal) {
    const base = baseOf(def, entry);
    const secret = open(entry.secret);
    const state = (s) => { if (runtime.get(def.id) !== s) { runtime.set(def.id, s); try { onChange(); } catch { /* ignore */ } } };
    const authFail = () => {
      const signIn = def.kind === 'session' || def.id === 'gmail';
      state(signIn ? 'needs-signin' : 'bad-token');
      return new ConnectorError(signIn
        ? `${def.name} isn’t signed in. Ask the user to sign in to ${def.name} in a Lumen tab (Settings → You and AI → Connectors has a button), then try again.`
        : `${def.name} refused the saved token. Ask the user to connect ${def.name} again with a new one.`, 'auth');
    };
    const ctx = {
      id: def.id, config: entry.config || {}, secret, signal, now, authError: authFail, // (a provider that finds its sign-in ended says so: the card turns to Needs sign-in)
      google: def.id === 'gmail' ? google : null,
      async http(target, { method = 'GET', query, json, headers = {}, accept = 'application/json', max = MAX_BODY, allowAuth = false } = {}) {
        let url;
        try { url = /^https?:\/\//i.test(target) ? new URL(target) : new URL(`${base}${target}`); } catch { throw new ConnectorError('That address isn’t valid.', 'args'); }
        const own = def.id === 'gcal' ? new URL(secret).origin : new URL(base).origin; // the calendar's address is its own service
        if (url.origin !== own) throw new ConnectorError(`${def.name} sent Lumen to another address, which it won’t follow.`, 'other');
        if (url.protocol !== 'https:' && !loopback(url)) throw new ConnectorError(`${def.name} needs an https:// address.`, 'other');
        for (const [k, v] of Object.entries(query || {})) for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
        const h = { Accept: accept, ...headers };
        if (def.kind === 'token' && def.id !== 'gcal') h.Authorization = `Bearer ${secret}`;
        if (json !== undefined) h['Content-Type'] = 'application/json';
        if (signal?.aborted) throw new ConnectorError('Stopped.', 'other'); // (stopped before it began: nothing is sent)
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        const onAbort = () => controller.abort();
        signal?.addEventListener?.('abort', onAbort, { once: true });
        let res;
        let text = '';
        let redirected = false;
        try {
          res = await (def.kind === 'session' ? sessionFetch || fetch : fetch)(url.href, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : undefined, redirect: 'manual', signal: controller.signal });
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > max) throw new ConnectorError(`${def.name} sent more than Lumen reads.`, 'other');
          text = buf.toString('utf8');
        } catch (err) {
          if (err instanceof ConnectorError) throw err;
          if (/redirect/i.test(String(err?.message))) redirected = true; // Electron's fetch throws when a redirect is refused (a sign-in page)
          else if (signal?.aborted) throw new ConnectorError('Stopped.', 'other');
          else throw new ConnectorError(controller.signal.aborted ? `${def.name} took too long to answer.` : `Couldn’t reach ${def.name}. Check the connection.`, 'other');
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
        }
        if (redirected) res = { status: 302, headers: new Headers() };
        const status = res.type === 'opaqueredirect' ? 302 : res.status;
        if (def.kind === 'session' && !allowAuth && (status === 401 || status === 0 || (status >= 300 && status < 400))) throw authFail();
        if (!allowAuth && def.kind === 'token' && status === 401) throw authFail();
        if (status >= 200 && status < 300) state('ok');
        return { status, ok: status >= 200 && status < 300, headers: res.headers, text };
      },
    };
    return ctx;
  }

  // ---- what Settings shows
  const STATUS_TEXT = { off: 'Not connected', soon: 'Coming soon', 'needs-signin': 'Needs sign-in', 'bad-token': 'Token refused' };
  function card(def) {
    const entry = connected[def.id];
    let status = def.kind === 'soon' ? 'soon' : entry ? 'connected' : 'off';
    if (entry && def.kind === 'mcp' && mcp && !mcp.list().some((s) => s.id === entry.config?.mcpId)) { // removed in Tools from MCP servers
      delete connected[def.id];
      persist();
      status = 'off';
    }
    const live = status === 'connected' ? runtime.get(def.id) : null;
    if (live === 'needs-signin' || live === 'bad-token') status = live;
    const e = connected[def.id];
    const account = e?.account || '';
    // Gmail with the full sign-in: whether drafts are allowed ('on'), or the card offers Allow drafts ('off'). null elsewhere.
    let drafts = null;
    if (def.id === 'gmail' && status === 'connected' && e?.config?.mode === 'oauth' && google?.drafts) { try { drafts = google.drafts() ? 'on' : 'off'; } catch { drafts = 'off'; } }
    return {
      id: def.id, name: def.name, category: def.category, icon: def.icon, summary: def.summary, kind: def.kind, note: def.sessionNote || '',
      status, statusText: status === 'connected' ? `Connected${account ? ` · ${account}` : ''}${e?.config?.mode === 'session' ? ' (unread only)' : ''}` : STATUS_TEXT[status],
      fields: def.fields.map(({ id, label, placeholder, secret, help }) => ({ id, label, placeholder, secret: Boolean(secret), help: help || '' })),
      config: def.id === 'canvas' ? { domain: e?.config?.domain || '' } : {},
      reads: def.reads, does: def.does, drafts,
      actions: Object.entries(def.actions).map(([name, a]) => ({ name, label: a.label, write: Boolean(a.write) })),
    };
  }
  const list = () => ({ categories: registry.CATEGORIES, connectors: registry.CONNECTORS.map(card) });

  async function detect(id) {
    const def = registry.get(id);
    if (id !== 'canvas' || !def) return [];
    const hosts = new Set();
    for (const h of await detectHosts().catch(() => [])) if (registry.looksLikeCanvas(String(h))) hosts.add(String(h).toLowerCase());
    return [...hosts].slice(0, 5);
  }

  // ---- connect / disconnect
  async function connect(id, input = {}) {
    const def = registry.get(id);
    if (!def || def.kind === 'soon') throw new Error('That one isn’t available yet.');
    if (def.kind === 'mcp') return connectMcp(def, input);
    if (def.id === 'gmail') return connectGmail(def);
    let entry;
    if (def.kind === 'session') {
      let domain = registry.cleanDomain(input.domain);
      if (!domain && !String(input.domain || '').trim()) { const found = await detect(def.id); if (found.length === 1) [domain] = found; }
      if (!domain) throw new Error(def.id === 'canvas' ? 'Enter your school’s Canvas address, for example school.instructure.com.' : 'Enter the address.');
      entry = { at: now(), account: '', config: { domain } };
    } else {
      const field = def.fields[0];
      let r = registry.checkField(field, input[field.id] ?? input.secret);
      const given = String(input[field.id] ?? input.secret ?? '').trim();
      if (r.error && testLoopback && field.pattern === 'url' && /^http:\/\/127\.0\.0\.1[:/]/.test(given)) r = { value: given };
      if (r.error) throw new Error(r.error);
      entry = { at: now(), account: '', config: {}, secret: seal(r.value) };
    }
    const ctx = makeCtx(def, entry, null);
    let probe;
    try { probe = await provider(def.id).verify({ ...ctx, http: (t, o) => ctx.http(t, { ...o, allowAuth: true }) }); } catch (err) { throw new Error(err.message); }
    if (probe.status === 200) { entry.account = probe.account || ''; runtime.set(def.id, 'ok'); } else if (def.kind === 'session' && (probe.status === 401 || probe.status === 0 || (probe.status >= 300 && probe.status < 400))) {
      runtime.set(def.id, 'needs-signin'); // saved anyway: the user signs in, then asks
    } else if (probe.status === 401 || probe.status === 403) {
      throw new Error(def.kind === 'token' ? `${def.name} refused that token. Check it and try again.` : `${def.name} refused the request.`);
    } else if (probe.status === 404 && def.id === 'canvas') {
      throw new Error('That address doesn’t look like a Canvas site.');
    } else {
      throw new Error(`${def.name} answered ${probe.status}. Try again in a moment.`);
    }
    connected[def.id] = entry;
    cache.clear();
    persist();
    changed();
    return list();
  }

  async function connectGmail(def) {
    if (!google) throw new Error('Gmail isn’t available here.');
    let st = await google.status();
    let owned = false;
    if (!st.oauth && st.oneClick) {
      try {
        await google.connect();
        st = await google.status();
        owned = st.oauth;
      } catch (err) {
        if (!st.session) throw err;
      }
    }
    let mode;
    if (st.oauth) mode = 'oauth';
    else if (st.session) mode = 'session';
    else {
      try { openSignIn(GOOGLE_SIGN_IN); } catch { /* the message says what to do */ }
      throw new Error('Sign in to Google in the tab that just opened, then press Connect again. (Or add a Google client in Settings → Home → Widgets for the full sign-in.)');
    }
    connected[def.id] = { at: now(), account: flat(st.email, 80), config: { mode, owned } };
    runtime.set(def.id, 'ok');
    cache.clear();
    persist();
    changed();
    return list();
  }

  async function connectMcp(def, input) {
    if (!mcp) throw new Error('MCP servers aren’t available here.');
    const env = [];
    for (const f of def.fields) {
      const r = registry.checkField(f, input[f.id]);
      if (r.error) throw new Error(r.error);
      env.push({ name: f.id, value: r.value });
    }
    const existing = mcp.list().find((s) => s.name === def.mcp.name);
    if (existing) throw new Error(`There is already an MCP server called ${def.mcp.name} in Tools from MCP servers. Remove it there first.`);
    const servers = mcp.save({ name: def.mcp.name, type: 'stdio', command: def.mcp.command, args: def.mcp.args, env });
    const made = servers.find((s) => s.name === def.mcp.name);
    connected[def.id] = { at: now(), account: '', config: { mcpId: made?.id } };
    persist();
    changed();
    return list();
  }

  // Settings' Allow drafts on the Gmail card: the Google sign-in again, asking Google to add gmail.compose (to make drafts; Lumen never
  // sends). Only for a Gmail connected with the full sign-in; never started by the AI.
  async function allowDrafts(id) {
    const entry = connected[id];
    if (id !== 'gmail' || !entry) throw new Error('Connect Gmail first.');
    if (entry.config?.mode !== 'oauth' || !google?.allowDrafts) throw new Error('Drafts need the full Google sign-in. Disconnect Gmail, then connect it again and finish the Google sign-in.');
    await google.allowDrafts();
    runtime.set(id, 'ok');
    cache.clear();
    changed();
    return list();
  }

  async function disconnect(id) {
    const def = registry.get(id);
    const entry = connected[id];
    if (!def || !entry) return list();
    delete connected[id];
    runtime.delete(id);
    for (const key of [...cache.keys()]) if (key.startsWith(`${id}:`)) cache.delete(key);
    persist();
    if (def.kind === 'mcp' && entry.config?.mcpId) { try { mcp?.remove(entry.config.mcpId); } catch { /* already gone */ } }
    if (def.id === 'gmail' && entry.config?.owned) { try { await google?.disconnect(); } catch { /* the sign-in stays until Google's side forgets it */ } }
    changed();
    return list();
  }

  // ---- the AI's tool
  const defs = ({ readOnly = false } = {}) => { const d = registry.toolDef({ readOnly }); return d ? [d] : []; }; // readOnly: background tasks and routines
  const validate = (input) => registry.validate(input);
  const label = (input) => registry.stepLabel(input);
  const isWrite = (input) => Boolean(registry.get(input?.app)?.actions?.[input?.action]?.write);
  const hasAny = () => registry.connectedIds().length > 0;
  const connectedIds = () => registry.connectedIds();

  // What the confirm card says before a write: `detail` is everything it will send, `fixed` the part the user can't change
  // (where it goes) and `fields` the text the user can edit there (registry.editable). A provider may look up a name for
  // the card (Notion: the page's title), which is a read; when that fails the card shows the id instead.
  async function describeWrite(input, { signal } = {}) { // signal: the run's, so Stop also stops the title lookup
    const def = registry.get(input.app);
    const args = input.args || {};
    const p = provider(def.id);
    const entry = connected[def.id];
    if (entry && p.beforeCard) { // a write that can't happen yet says why, and no card is shown for it
      try { await p.beforeCard(makeCtx(def, entry, signal), input.action, args); } catch (err) { if (err instanceof ConnectorError) { const e = new Error(err.message); e.kind = err.kind; throw e; } throw err; }
    }
    let names = {};
    if (entry && p.cardNames) { try { names = (await p.cardNames(makeCtx(def, entry, signal), input.action, args)) || {}; } catch { names = {}; } }
    const text = p.describeWrite?.(input.action, args, names);
    const fields = registry.editable(input);
    return {
      title: `Use ${def.name}: ${def.actions[input.action].label}`,
      detail: text || JSON.stringify(args, null, 2),
      fixed: p.describeWhere?.(input.action, args, names) || '',
      fields,
    };
  }

  const wrap = (source, text) => {
    const body = String(text).length > RESULT_CHARS ? `${String(text).slice(0, RESULT_CHARS)}\n[… cut]` : String(text);
    return `<untrusted_page_content source="${source}">\n${body.replace(/<(\/?)untrusted_page_content/gi, '‹$1untrusted_page_content')}\n</untrusted_page_content>`;
  };

  // A write's provider answers { text, link?, done }: `done` and `link` go to onWritten (the chat's step: "Gmail · Draft created", with
  // the link), the text to the AI. readOnly (a background task or routine) refuses a write before anything is sent.
  async function call(input, { signal, readOnly = false, onWritten = null } = {}) {
    const problem = validate(input);
    if (problem) throw new Error(problem);
    const def = registry.get(input.app);
    if (input.action === 'help') return wrap(`connector:${def.id}/help`, registry.help(def.id));
    const entry = connected[def.id];
    if (!entry) throw new Error(`${def.name} isn’t connected.`);
    const args = input.args || {};
    const key = `${def.id}:${input.action}:${JSON.stringify(args)}`;
    const write = def.actions[input.action].write === true;
    if (write && readOnly) throw new Error(`Background tasks and routines can only read from ${def.name}. Tell the user what you would have changed.`);
    const hit = !write && cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.text;
    let text;
    try {
      text = await provider(def.id).actions[input.action](makeCtx(def, entry, signal), args);
    } catch (err) {
      if (err instanceof ConnectorError) { const e = new Error(err.message); e.kind = err.kind; throw e; }
      throw err;
    }
    if (text && typeof text === 'object') {
      const link = /^https:\/\//.test(String(text.link || '')) ? String(text.link) : '';
      if (write && onWritten) { try { onWritten({ label: `${def.name} · ${flat(text.done || def.actions[input.action].label, 80)}`, link }); } catch { /* the step is extra; the result still goes back */ } }
      text = `${text.text}${link ? `\nLink: ${link}` : ''}`;
    }
    const out = wrap(`connector:${def.id}/${input.action}`, text);
    if (write) { for (const k of [...cache.keys()]) if (k.startsWith(`${def.id}:`)) cache.delete(k); } else cache.set(key, { at: now(), text: out });
    return out;
  }

  // Where "Sign in" on a card sends the user: the service's own sign-in page, opened as a normal tab (null when there is none).
  function signInUrl(id) {
    if (id === 'gmail') return GOOGLE_SIGN_IN;
    const domain = connected[id]?.config?.domain;
    return id === 'canvas' && domain ? `https://${domain}/` : null;
  }

  return { list, detect, connect, disconnect, allowDrafts, signInUrl, defs, validate, label, isWrite, hasAny, connectedIds, describeWrite, call, forgetAll: () => { cache.clear(); } };
}

module.exports = { create };
