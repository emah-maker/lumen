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
//  - Gmail sending is a second, separate switch (setSending, Settings → Gmail → Allow sending), off by default and only with drafts allowed:
//    gmail.compose already covers it, so no new Google permission is ever asked for. The agent decides how each send is allowed
//    (card or the user's typed permission, features/gmail-send.js); call() refuses a send nobody allowed, over 10 an hour, and logs each.
//  - Google Drive and Google Sheets (kind 'google') share ONE Google sign-in (google-auth.js): its refresh token is sealed into
//    connectors.json like any other secret ('google'), asked for in the user's own browser only when Connect is pressed, with each
//    connector's own scopes (incremental). Every request gets a fresh access token; the last Google connector to be disconnected
//    gives the grant back to Google.
//  - Answers are cached for 30 seconds in memory only, so asking twice in a row is one request.
//  - Presets (kind 'mcp'): a service's official MCP server, added to the MCP client (features/mcp-client.js) by its card (none ships today: see the
//    note in registry.js). Whether a card is connected is read from that server (tagged `preset`), never kept here.
//  - `shared`: a connector whose token is kept elsewhere (GitHub signed in once on its new-tab card, features/github-auth.js) has an
//    entry with config.shared and no secret of its own; the token is read from its owner at each request, so a revoked or replaced
//    sign-in applies here at once, and nothing is copied. syncShared() makes the entry match the owner's sign-in.
'use strict';
const path = require('path');
const registry = require('./registry');
const { readStoreFile, writeJsonAtomic } = require('../../settings/settings-file'); // (a file that can't be read is kept aside, never overwritten)
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
  drive: 'https://www.googleapis.com/drive/v3',
  sheets: 'https://sheets.googleapis.com/v4',
};
const GOOGLE_SIGN_IN = 'https://accounts.google.com/ServiceLogin?service=mail&continue=https%3A%2F%2Fmail.google.com%2Fmail%2F';
const provider = (id) => require(`./providers/${id}`); // loaded when a connector is first used (not at startup)

function create({
  userData, secrets, fetch = globalThis.fetch, sessionFetch = null, endpoints = () => ({}), detectHosts = async () => [],
  google = null, workspace = {}, mcp = null, openSignIn = () => {}, now = Date.now, onChange = () => {}, testLoopback = false, shared = {},
}) {
  const file = path.join(userData, FILE);
  let googleSealed = ''; // the shared Google sign-in (Drive, Sheets), sealed
  let unreadable = false; // connectors.json exists but could not be read: a copy was kept, and only the user's own change may replace it
  let connected = load();
  const runtime = new Map(); // id -> 'ok' | 'needs-signin' | 'bad-token' (what the last request found)
  const cache = new Map(); // key -> { at, text }

  function load() {
    const r = readStoreFile(file); // no file yet: nothing connected
    if (r.failed) { unreadable = true; return {}; }
    try {
      const data = r.data;
      const out = {};
      for (const [id, e] of Object.entries(data?.connected || {})) if (registry.get(id) && e && typeof e === 'object') out[id] = e;
      googleSealed = typeof data?.google?.secret === 'string' ? data.google.secret : '';
      return out;
    } catch { return {}; }
  }
  // `deliberate`: the user's own change (connect, disconnect, a switch). A background update (the account name found after a
  // connect) never writes over a file that could not be read.
  function persist(deliberate = true) {
    if (unreadable && !deliberate) return;
    writeJsonAtomic(file, { version: 1, connected, ...(googleSealed ? { google: { secret: googleSealed } } : {}) }, 2, 0o600); // (tmp + rename: never a half-written file)
    unreadable = false; // (a copy of the old file was set aside when it failed)
  }
  // Gmail sending: the switch is on, with the full sign-in and drafts still allowed (take the permission back at Google and it is off).
  function sendingOn() {
    try { return Boolean(connected.gmail?.config?.sending && connected.gmail.config.mode === 'oauth' && google?.drafts?.() && google?.send); } catch { return false; }
  }
  let sendLogStore = null;
  const sendLog = () => (sendLogStore ||= require('../gmail-send').createLog({ file: path.join(userData, 'gmail-send-log.json'), now, secrets })); // (loaded on the first send)
  function changed() {
    registry.setUnlocked(sendingOn() ? ['gmail.send'] : []);
    registry.setConnected(Object.keys(connected).filter((id) => registry.get(id).kind !== 'mcp'));
    try { onChange(); } catch { /* the page looks again next time */ }
  }
  const seal = (value) => {
    if (!secrets?.available()) throw new Error('This computer’s secure storage isn’t available, so Lumen can’t keep a token safely.');
    return secrets.encrypt(String(value));
  };
  const open = (sealed) => { try { return sealed ? secrets.decrypt(sealed) : ''; } catch { return ''; } };
  changed();
  // The shared Google sign-in, made on first use. A test hands in its own as workspace.auth.
  let authStore = null;
  const googleAuth = () => (authStore ||= workspace.auth || require('./google-auth').create({
    getBlob: () => open(googleSealed),
    setBlob: (value) => { googleSealed = value ? seal(value) : ''; persist(); },
    fetch, endpoints, now, ...workspace,
  }));
  const googleIds = () => Object.keys(connected).filter((id) => registry.get(id)?.kind === 'google');

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
    const secret = entry.config?.shared ? String(shared[def.id]?.info?.()?.token || '') : open(entry.secret);
    const state = (s) => { if (runtime.get(def.id) !== s) { runtime.set(def.id, s); try { onChange(); } catch { /* ignore */ } } };
    const authFail = () => {
      const signIn = def.kind === 'session' || def.id === 'gmail' || def.kind === 'google';
      state(signIn ? 'needs-signin' : 'bad-token');
      return new ConnectorError(def.kind === 'google'
        ? `Google ended the ${def.name} sign-in (it was revoked or ran out). Ask the user to connect ${def.name} again in Settings → AI and agents → Connectors.`
        : signIn
        ? `${def.name} isn’t signed in. Ask the user to sign in to ${def.name} in a Lumen tab (Settings → AI and agents → Connectors has a button), then try again.`
        : entry.config?.shared ? `${def.name} signed Lumen out (the sign-in was revoked or ran out). Ask the user to sign in to ${def.name} again, from its card on the new-tab page or in Settings → AI and agents → Connectors.`
        : `${def.name} refused the saved token. Ask the user to connect ${def.name} again with a new one.`, 'auth');
    };
    const ctx = {
      id: def.id, base, config: entry.config || {}, secret, signal, now, authError: authFail, // (a provider that finds its sign-in ended says so: the card turns to Needs sign-in)
      google: def.id === 'gmail' ? google : null,
      email: def.kind === 'google' ? entry.account || '' : '', // (the account a Google connector is signed in as)
      async http(target, { method = 'GET', query, json, body, headers = {}, accept = 'application/json', max = MAX_BODY, allowAuth = false, timeout = TIMEOUT_MS } = {}) {
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
        const timer = setTimeout(() => controller.abort(), timeout);
        const onAbort = () => controller.abort();
        signal?.addEventListener?.('abort', onAbort, { once: true });
        let res;
        let text = '';
        let redirected = false;
        try {
          const payload = json !== undefined ? JSON.stringify(json) : body;
          const send = () => (def.kind === 'session' ? sessionFetch || fetch : fetch)(url.href, { method, headers: h, body: payload, redirect: 'manual', signal: controller.signal });
          if (def.kind === 'google') { // a Google connector: the shared sign-in's access token; one 401 (the token was refused: nothing was done) is tried again with a new one
            const auth = googleAuth();
            for (let attempt = 0; ; attempt++) {
              try { h.Authorization = `Bearer ${await auth.access({ force: attempt > 0 })}`; } catch (err) {
                if (err?.reconnect) throw authFail();
                throw new ConnectorError(String(err?.message || err), 'other');
              }
              res = await send();
              if (res.status === 401 && attempt === 0) { auth.invalidate(); try { await res.arrayBuffer(); } catch { /* unused */ } continue; }
              break;
            }
          } else {
            res = await send();
          }
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
        if (!allowAuth && (def.kind === 'token' || def.kind === 'google') && status === 401) throw authFail();
        if (status >= 200 && status < 300) state('ok');
        return { status, ok: status >= 200 && status < 300, headers: res.headers, text };
      },
    };
    return ctx;
  }

  // ---- what Settings shows
  const STATUS_TEXT = { off: 'Not connected', 'needs-signin': 'Needs sign-in', 'bad-token': 'Token refused' };
  const serverOf = (def) => { try { return mcp?.list().find((x) => x.preset === def.id) || null; } catch { return null; } };
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  function mcpCard(def) {
    const srv = serverOf(def);
    let status = 'off';
    if (srv) status = srv.authRefused ? 'bad-token' : srv.needsAuth ? 'needs-signin' : srv.state === 'error' ? 'error' : 'connected';
    const text = status === 'connected' ? `Connected${srv.state === 'ready' ? ` · ${plural(srv.tools.length, 'tool')}` : ''}` : status === 'error' ? `Couldn’t connect: ${srv.error}` : STATUS_TEXT[status];
    return {
      id: def.id, name: def.name, category: def.category, icon: def.icon, summary: def.summary, kind: def.kind, note: def.sessionNote || '',
      status, statusText: text, source: def.mcp?.source || '',
      fields: def.fields.map(({ id, label, placeholder, secret, help }) => ({ id, label, placeholder, secret: Boolean(secret), help: help || '' })),
      config: {}, reads: def.reads, does: def.does, drafts: null, sending: null, actions: [],
      oauth: def.mcp?.auth === 'oauth',
      mcp: srv ? { id: srv.id, name: srv.name, state: srv.state, tools: srv.tools.map((t) => ({ name: t.name, description: t.description, always: srv.alwaysAllow.includes(t.name), auto: Boolean(t.readOnly) })) } : null,
    };
  }

  function card(def) {
    if (def.kind === 'mcp') return mcpCard(def);
    const entry = connected[def.id];
    let status = entry ? 'connected' : 'off';
    const live = status === 'connected' ? runtime.get(def.id) : null;
    if (live === 'needs-signin' || live === 'bad-token') status = live;
    const e = connected[def.id];
    const account = e?.account || '';
    // Gmail with the full sign-in: whether drafts are allowed ('on'), or the card offers Allow drafts ('off'). null elsewhere.
    let drafts = null;
    if (def.id === 'gmail' && status === 'connected' && e?.config?.mode === 'oauth' && google?.drafts) { try { drafts = google.drafts() ? 'on' : 'off'; } catch { drafts = 'off'; } }
    const sending = drafts === 'on' && google?.send ? (sendingOn() ? 'on' : 'off') : null; // Allow sending, under Allow drafts
    return {
      id: def.id, name: def.name, category: def.category, icon: def.icon, summary: def.summary, kind: def.kind, note: def.sessionNote || '',
      status, statusText: status === 'connected' ? `Connected${account ? ` · ${account}` : ''}${e?.config?.mode === 'session' ? ' (unread only)' : ''}${e?.config?.shared ? ' (signed in)' : ''}` : STATUS_TEXT[status],
      fields: def.fields.map(({ id, label, placeholder, secret, help }) => ({ id, label, placeholder, secret: Boolean(secret), help: help || '' })),
      config: def.id === 'canvas' ? { domain: e?.config?.domain || '' } : {},
      reads: def.reads, does: def.id === 'gmail' && sending === 'on' ? [...def.does, 'Send an email from your Gmail, only after you press Send on a card that shows all of it (or you said in this chat that it may send)'] : def.does, drafts, sending,
      actions: Object.entries(def.actions).filter(([, a]) => !a.gated || sending === 'on').map(([name, a]) => ({ name, label: a.label, write: Boolean(a.write) })),
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
    if (!def) throw new Error('That service isn’t known.');
    if (def.kind === 'mcp') return connectMcp(def, input);
    if (def.id === 'gmail') return connectGmail(def);
    if (def.kind === 'google') return connectGoogle(def);
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

  // Drive and Sheets: the shared Google sign-in, with this connector's scopes. When the grant already covers them (another Google
  // connector asked for the same) the browser isn't opened again. Then one request proves it works (Drive's "about"; Sheets has none).
  async function connectGoogle(def) {
    const auth = googleAuth();
    const scopes = def.google.scopes;
    if (!auth.has(scopes)) await auth.signIn(scopes);
    const entry = { at: now(), account: flat(auth.status().email, 80), config: {} };
    const ctx = makeCtx(def, entry, null);
    let probe;
    // (a sign-in that was just made but then failed the check isn't left behind when no other Google connector uses it)
    const giveBack = async () => { if (!googleIds().length) { try { await auth.revoke(); } catch { /* forgotten here either way */ } } };
    try { probe = await provider(def.id).verify({ ...ctx, http: (t, o) => ctx.http(t, { ...o, allowAuth: true }) }); } catch (err) { await giveBack(); throw new Error(err.message); }
    if (probe.status === 401 || probe.status === 403) { await giveBack(); throw new Error(probe.message || `Google refused the request for ${def.name}. Press Connect again and allow everything it asks.`); }
    if (probe.status !== 200) { await giveBack(); throw new Error(`${def.name} answered ${probe.status}. Try again in a moment.`); }
    connected[def.id] = entry;
    runtime.set(def.id, 'ok');
    cache.clear();
    persist();
    changed();
    return list();
  }

  // A preset: the service's official MCP server, added (or, for a card that already has one, signed in again or given a new token), started and
  // checked. A first connect that fails leaves nothing behind. A first connect that fails leaves nothing behind; the old built-in connector's saved secret is dropped only once this works.
  async function connectMcp(def, input) {
    if (!mcp) throw new Error('MCP servers aren’t available here.');
    const cfg = { ...def.mcp, url: String(endpoints()?.[def.id] || def.mcp.url || '') }; // (a test points a preset at 127.0.0.1)
    const existing = serverOf(def);
    if (!existing && mcp.list().some((x) => x.name === cfg.name)) throw new Error(`There is already an MCP server called ${cfg.name} under Custom MCP servers. Remove or rename it there first.`);
    let token = '';
    const env = [];
    for (const f of def.fields) {
      const typed = String(input[f.id] ?? input.secret ?? '').trim();
      const r = registry.checkField(f, typed);
      if (r.error) throw new Error(r.error);
      if (cfg.type === 'http') token = r.value; else env.push({ name: f.id, value: r.value });
    }
    const body = cfg.type === 'http'
      ? { id: existing?.id, name: cfg.name, type: 'http', url: cfg.url, preset: def.id, ...(cfg.auth === 'oauth' ? { auth: 'oauth' } : { header: { name: cfg.header.name, value: `${cfg.header.prefix || ''}${token}` } }), ...(cfg.fixedHeaders ? { fixedHeaders: cfg.fixedHeaders } : {}) }
      : { id: existing?.id, name: cfg.name, type: 'stdio', command: cfg.command, args: cfg.args, env, preset: def.id };
    const made = mcp.save(body).find((x) => x.name === cfg.name);
    const undo = () => { if (!existing && made) { try { mcp.remove(made.id); } catch { /* already gone */ } } };
    try {
      if (cfg.auth === 'oauth') await mcp.signIn(made.id); else await mcp.refresh(made.id);
    } catch (err) { undo(); throw err; }
    const now1 = mcp.list().find((x) => x.id === made.id);
    if (now1?.state !== 'ready') {
      const refused = now1?.authRefused || now1?.needsAuth;
      undo();
      throw new Error(refused && cfg.type === 'http' && cfg.auth !== 'oauth' ? `${def.name} refused that token. Check it and try again.` : refused ? `${def.name} didn’t accept the sign-in. Try again.` : `Couldn’t connect to ${def.name}: ${now1?.error || 'it didn’t answer'}`);
    }
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

  // Settings' Allow sending switch (Gmail card, under Allow drafts). Only the user's click turns it on; the AI can't.
  function setSending(id, on) {
    const entry = connected[id];
    if (id !== 'gmail' || !entry) throw new Error('Connect Gmail first.');
    if (on && (entry.config?.mode !== 'oauth' || !google?.drafts?.() || !google?.send)) throw new Error('Allow drafts first: sending is offered only once drafts are allowed.');
    entry.config = { ...entry.config, sending: Boolean(on) };
    persist();
    cache.clear();
    changed();
    return list();
  }

  async function disconnect(id) {
    const def = registry.get(id);
    const entry = connected[id];
    if (def?.kind === 'mcp') { // the preset's server goes, with its sign-in
      const srv = serverOf(def);
      if (srv) { try { mcp.remove(srv.id); } catch { /* already gone */ } }
      changed();
      return list();
    }
    if (!def || !entry) return list();
    delete connected[id];
    runtime.delete(id);
    for (const key of [...cache.keys()]) if (key.startsWith(`${id}:`)) cache.delete(key);
    persist();
    if (entry.config?.shared) { try { shared[id]?.signOut?.(); } catch { /* the sign-in stays until the card signs out */ } } // one sign-in: disconnecting here signs the card out too
    if (def.id === 'gmail' && entry.config?.owned) { try { await google?.disconnect(); } catch { /* the sign-in stays until Google's side forgets it */ } }
    if (def.kind === 'google' && !googleIds().length) { try { await googleAuth().revoke(); } catch { /* the sign-in is forgotten here either way */ } } // the last Google connector: the grant goes back to Google
    changed();
    return list();
  }

  // Make a shared connector's entry match its owner's sign-in: signed in -> connected (as that account); signed out -> gone.
  // A connector connected with its own token is left alone either way.
  function syncShared(id) {
    const def = registry.get(id);
    const src = shared[id];
    if (!def || !src) return list();
    if (connected[id] && !connected[id].config?.shared) return list(); // connected with its own token: it keeps it (never swapped for the card's broader sign-in)
    const info = src.info();
    if (info) connected[id] = { at: now(), account: flat(info.account, 60), config: { shared: true } };
    else if (connected[id]?.config?.shared) delete connected[id];
    else return list();
    runtime.delete(id);
    for (const key of [...cache.keys()]) if (key.startsWith(`${id}:`)) cache.delete(key);
    persist();
    changed();
    if (info && !info.account) { // a pasted token knows no name: ask the service who it is, once
      const entry = connected[id];
      const ctx = makeCtx(def, entry, null);
      provider(id).verify({ ...ctx, http: (t, o) => ctx.http(t, { ...o, allowAuth: true }) }).then((probe) => {
        if (connected[id] === entry && probe.status === 200 && probe.account) { entry.account = probe.account; persist(false); changed(); }
      }).catch(() => {});
    }
    return list();
  }
  const usesShared = (id) => connected[id]?.config?.shared === true;

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
  async function describeWrite(input, { signal, file = null } = {}) { // signal: the run's, so Stop also stops the title lookup; file: the local file an upload sends ({ name, size, type })
    const def = registry.get(input.app);
    const args = input.args || {};
    const p = provider(def.id);
    const entry = connected[def.id];
    if (entry && p.beforeCard) { // a write that can't happen yet says why, and no card is shown for it
      try { await p.beforeCard(makeCtx(def, entry, signal), input.action, args); } catch (err) { if (err instanceof ConnectorError) { const e = new Error(err.message); e.kind = err.kind; throw e; } throw err; }
    }
    let names = {};
    if (entry && p.cardNames) { try { names = (await p.cardNames(makeCtx(def, entry, signal), input.action, args)) || {}; } catch { names = {}; } }
    if (file) names = { ...names, file: { name: flat(file.name, 200), size: Number(file.size) || 0, type: flat(file.type, 100) } };
    if (input.action === 'send') { try { sendLog().room(); } catch (err) { const e = new Error(err.message); e.kind = 'other'; throw e; } } // (a send that can't go gets no card)
    const text = p.describeWrite?.(input.action, args, names);
    const fields = registry.editable(input);
    return {
      title: `Use ${def.name}: ${def.actions[input.action].label}`,
      detail: text || JSON.stringify(args, null, 2),
      fixed: p.describeWhere?.(input.action, args, names) || '',
      fields,
      names,
    };
  }

  const wrap = (source, text) => {
    const body = String(text).length > RESULT_CHARS ? `${String(text).slice(0, RESULT_CHARS)}\n[… cut]` : String(text);
    return `<untrusted_page_content source="${source}">\n${body.replace(/<(\/?)untrusted_page_content/gi, '‹$1untrusted_page_content')}\n</untrusted_page_content>`;
  };

  // A write's provider answers { text, link?, done }: `done` and `link` go to onWritten (the chat's step: "Gmail · Draft created", with
  // the link), the text to the AI. readOnly (a background task or routine) refuses a write before anything is sent.
  async function call(input, { signal, readOnly = false, onWritten = null, sendVia = '', file = null } = {}) {
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
    const sending = def.id === 'gmail' && input.action === 'send';
    if (sending) { // allowed by a card click or the user's typed permission (agent.js passes how), the switch is on, under 10 an hour
      if (!sendVia) throw new Error('A send needs the user’s approval first. Nothing was sent.');
      if (!sendingOn()) throw new Error('Sending is off (Settings → AI and agents → Connectors → Gmail → Allow sending). Nothing was sent.');
      try { sendLog().room(); } catch (err) { throw new Error(err.message); }
    }
    const hit = !write && cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.text;
    let text;
    try {
      const ctx = makeCtx(def, entry, signal);
      if (file) ctx.file = file; // (a Drive upload: the file the user allowed on the card, already checked by the agent)
      if (sending) ctx.beforeSend =({ to, subject }) => sendLog().record({ to, subject, via: sendVia }); // (written just before the request: a send with no answer still counts)
      text = await provider(def.id).actions[input.action](ctx, args);
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

  const isSend = (input) => input?.app === 'gmail' && input?.action === 'send';
  return { setSending, sendingOn, sendLog: () => sendLog().list(), isSend, list, detect, connect, disconnect, allowDrafts, syncShared, usesShared, signInUrl, defs, validate, label, isWrite, hasAny, connectedIds, describeWrite, call, forgetAll: () => { cache.clear(); } };
}

module.exports = { create };
