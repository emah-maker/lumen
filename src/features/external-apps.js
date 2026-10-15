// Other apps (Claude Desktop, Cursor, VS Code, Claude Code, outside Lumen) using Lumen: Settings > AI > "Let other apps use Lumen".
// The pure registry behind it. ai-agents.js wires it to the MCP server through three small hooks (automation/mcp.js): `identify` (who
// is this connection), `onInitialize` (may it start) and the call wrapper in mcpCallTool (may this call run, and can it be stopped).
//
//  - Apps: one record per app, a name and a token of its own ("Add app"). The token is kept encrypted (safeStorage) in
//    <userData>/external-apps.json and shown once, when it is made. The bridge proves it knows it (automation/client-token.js).
//    Revoke deletes the record: its connections are cut at once and its token never works again.
//  - Unmanaged agents (no token: Claude Code added the old way, Codex...) keep working as before, unless the user turned on "Ask when an
//    unknown app connects": then the first connection from a new name waits for Allow / Deny, and Allow is remembered by name.
//  - Visibility: `state()` lists the apps working now (a call is running) or paused, for the toolbar pill. Stop ends the app's
//    calls and connections; Take over pauses it (its calls are refused, with the reason) until Resume.
//  - "Finished" notice: once an app's calls have stopped for RUN_QUIET_MS after it worked, `onFinished(app)` fires once.
//
// deps: { file, safeStorage { isEncryptionAvailable, encryptString, decryptString }, now, onChange(), onPrompt(prompt) (a prompt
//         to show, or the list changed), onFinished(app), setTimer, clearTimer }
const fs = require('fs');
const path = require('path');
const clientToken = require('../automation/client-token');

const APPS = {
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  vscode: 'VS Code',
  'claude-code': 'Claude Code',
  other: 'Another app',
};
const RUN_QUIET_MS = 4000; // an app's run is over once it has made no call for this long
const PROMPT_WAIT_MS = 90000; // an unanswered "wants to use Lumen" is a Deny (not remembered)
const DENY_MEMORY_MS = 10 * 60 * 1000; // a Deny holds for this long, so an app that retries does not ask again and again
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

function createExternalApps({ file, safeStorage = null, now = Date.now, onChange = () => {}, onPrompt = () => {}, onFinished = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let records = [];
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(saved?.apps)) records = saved.apps.filter((r) => r && typeof r.id === 'string' && typeof r.name === 'string');
  } catch {}
  const live = new Map(); // id -> { sessions: Set, busy, controller, paused, ranAt, timer }
  const prompts = new Map(); // prompt id -> { id, name, resolve, timer }
  const denied = new Map(); // lower-cased name -> time it was denied
  let promptSeq = 0;
  let saveTimer = null;

  const save = () => {
    clearTimer(saveTimer);
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ version: 1, apps: records }, null, 2), { mode: 0o600 });
    } catch (err) { console.error('external apps:', err.message); }
  };
  const saveSoon = () => { if (!saveTimer) { saveTimer = setTimer(save, 3000); saveTimer.unref?.(); } }; // (a last-used time is not worth a write per call)
  const runtime = (id) => { let l = live.get(id); if (!l) { l = { sessions: new Set(), busy: 0, controller: new AbortController(), paused: false, ranAt: 0, timer: null }; live.set(id, l); } return l; };
  const byId = (id) => records.find((r) => r.id === id) || null;
  const pub = (r) => {
    const l = live.get(r.id);
    return { id: r.id, name: r.name, app: r.app || 'other', kind: r.secret ? 'token' : 'name', createdAt: r.createdAt, lastUsed: r.lastUsed || null, ask: r.ask === true, connected: l ? l.sessions.size : 0, busy: l ? l.busy > 0 : false, paused: Boolean(l?.paused) };
  };
  const secretOf = (r) => {
    if (!r.secret || !safeStorage?.isEncryptionAvailable?.()) return null;
    try { return safeStorage.decryptString(Buffer.from(r.secret, 'base64')); } catch { return null; }
  };

  // ---- apps
  function add({ name, app = 'other', ask = false } = {}) {
    const label = cleanName(name) || APPS[app] || APPS.other;
    if (!safeStorage?.isEncryptionAvailable?.()) throw new Error('This computer has no system keychain to keep the token in, so Lumen can’t make one safely.');
    if (records.some((r) => r.name.toLowerCase() === label.toLowerCase() && r.secret)) throw new Error(`There is already an app called “${label}”. Pick another name, or revoke that one first.`);
    const { id, token } = clientToken.make();
    const rec = { id, name: label, app: APPS[app] ? app : 'other', secret: safeStorage.encryptString(token).toString('base64'), createdAt: now(), lastUsed: null, ask: ask === true };
    records.push(rec);
    save();
    onChange();
    return { app: pub(rec), token }; // the only time the token is returned
  }
  // An unmanaged agent the user said Allow to: remembered by the name it gave, which is only a label (anything local can claim it).
  function remember(name, ask = false) {
    const label = cleanName(name) || 'An AI agent';
    let rec = records.find((r) => !r.secret && r.name.toLowerCase() === label.toLowerCase());
    if (!rec) { rec = { id: clientToken.make().id, name: label, app: 'other', secret: null, createdAt: now(), lastUsed: null, ask: false }; records.push(rec); }
    rec.ask = ask === true;
    save();
    onChange();
    return pub(rec);
  }
  const findByName = (name) => records.find((r) => !r.secret && r.name.toLowerCase() === cleanName(name).toLowerCase()) || null;
  function revoke(id) {
    const rec = byId(id);
    if (!rec) return false;
    records = records.filter((r) => r !== rec);
    save();
    cut(id);
    live.delete(id);
    onChange();
    return true;
  }
  function setAsk(id, on) { const rec = byId(id); if (!rec) return false; rec.ask = on === true; save(); onChange(); return true; }
  const list = () => records.map(pub);
  const get = (id) => { const r = byId(id); return r ? pub(r) : null; };

  // ---- who is connecting (the `identify` hook): a managed app proves its token; no token is an unmanaged agent (null); a token that
  // is unknown, revoked or wrong is refused (false).
  function identify({ client, proof, nonce } = {}) {
    if (client === undefined || client === null || client === '') return null;
    const rec = byId(String(client));
    const secret = rec && secretOf(rec);
    if (!secret || !clientToken.verify(secret, String(nonce || ''), proof)) return false;
    return { client: rec.id };
  }

  // ---- a session's life
  function attach(session, id) {
    const rec = byId(id);
    if (!rec) return false;
    session.externalId = id;
    session.clientName = rec.name;
    runtime(id).sessions.add(session);
    onChange();
    return true;
  }
  function detach(session) {
    const id = session?.externalId;
    const l = id && live.get(id);
    if (l && l.sessions.delete(session)) onChange();
  }

  // The `onInitialize` hook: null to let the session start, or the words it is refused with.
  async function admit(session, info = {}) {
    if (session.engine) return null; // Lumen's own engines are not other apps
    if (session.client) { // it proved a token (identify)
      if (!attach(session, session.client)) return 'This app’s access to Lumen was revoked. Add it again in Lumen: Settings, AI, Let other apps use Lumen.';
      return null;
    }
    if (!prefs.ask()) return null; // unmanaged, and the user has not asked to be asked: as before
    const known = findByName(session.clientName);
    if (known) { attach(session, known.id); return null; }
    const answer = await askUser(session.clientName);
    if (answer.decision === 'deny') return `${session.clientName} was not allowed to use Lumen. The user can change that in Lumen: Settings, AI, Let other apps use Lumen.`;
    const rec = remember(session.clientName, answer.decision === 'allow-ask');
    attach(session, rec.id);
    return null;
  }
  const prefs = { ask: () => false };

  // ---- "X wants to use Lumen": Allow / Allow and ask before it acts / Deny
  function askUser(name) {
    const key = cleanName(name).toLowerCase();
    if (now() - (denied.get(key) || -Infinity) < DENY_MEMORY_MS) return Promise.resolve({ decision: 'deny' });
    const existing = [...prompts.values()].find((p) => p.key === key);
    if (existing) return existing.promise;
    const p = { id: `p${++promptSeq}`, key, name: cleanName(name) || 'An AI agent' };
    p.promise = new Promise((resolve) => {
      p.resolve = resolve;
      p.timer = setTimer(() => answer(p.id, 'deny', true), PROMPT_WAIT_MS);
      p.timer?.unref?.();
    });
    prompts.set(p.id, p);
    try { onPrompt({ type: 'open', prompt: { id: p.id, name: p.name } }); } catch {}
    onChange();
    return p.promise;
  }
  function answer(id, decision, timedOut = false) {
    const p = prompts.get(id);
    if (!p) return false;
    const d = decision === 'allow' || decision === 'allow-ask' ? decision : 'deny';
    prompts.delete(id);
    clearTimer(p.timer);
    if (d === 'deny' && !timedOut) denied.set(p.key, now());
    p.resolve({ decision: d });
    try { onPrompt({ type: 'close', id }); } catch {}
    onChange();
    return true;
  }
  const pendingPrompts = () => [...prompts.values()].map((p) => ({ id: p.id, name: p.name }));

  // ---- one call (the wrapper in mcpCallTool): { refuse } with the reason, or { signal, ask, end() }. Not for Lumen's own engines.
  function beginCall(session) {
    const unmanaged = { signal: null, ask: false, end() {} }; // as before
    if (!session || session.engine) return unmanaged;
    // A client that skipped `initialize` (so was never admitted) gets no way round it.
    if (!session.externalId) {
      if (session.client) { if (!attach(session, session.client)) return { refuse: 'This app’s access to Lumen was revoked.' }; }
      else return prefs.ask() ? { refuse: 'This app has not been allowed to use Lumen. Connect it again and answer the prompt in Lumen.' } : unmanaged;
    }
    const id = session.externalId;
    const rec = byId(id);
    if (!rec) return { refuse: 'This app’s access to Lumen was revoked.' };
    const l = runtime(id);
    if (l.paused) return { refuse: 'The user took over Lumen and paused this app. Stop and wait: the user can resume it from the toolbar.' };
    rec.lastUsed = now();
    saveSoon();
    if (l.timer) { clearTimer(l.timer); l.timer = null; }
    l.busy++;
    l.ranAt = now();
    onChange();
    const controller = l.controller;
    let ended = false;
    return {
      signal: controller.signal,
      ask: rec.ask === true,
      end() {
        if (ended) return;
        ended = true;
        const cur = live.get(id);
        if (!cur) return;
        cur.busy = Math.max(0, cur.busy - 1);
        if (cur.busy === 0) {
          clearTimer(cur.timer);
          cur.timer = setTimer(() => { cur.timer = null; const r = byId(id); if (r && cur.busy === 0 && !cur.paused) { try { onFinished(pub(r)); } catch {} } }, RUN_QUIET_MS);
          cur.timer?.unref?.();
        }
        onChange();
      },
    };
  }

  // Ends the app's calls in flight (their signal), keeping the connection when `keep`.
  function cut(id, keep = false) {
    const l = live.get(id);
    if (!l) return;
    l.controller.abort();
    l.controller = new AbortController();
    if (!keep) for (const s of [...l.sessions]) { l.sessions.delete(s); try { s.disconnect?.(); } catch {} try { s.controller.abort(); } catch {} }
  }
  // Stop: its calls end now and its connections are closed; the app can connect again (it is still approved).
  function stop(id) { if (!byId(id)) return false; cut(id); runtimeDone(id); onChange(); return true; }
  // Take over: its calls end now and further ones are refused until resume().
  function takeOver(id) { if (!byId(id)) return false; const l = runtime(id); l.paused = true; cut(id, true); onChange(); return true; }
  function resume(id) { const l = live.get(id); if (!l || !byId(id)) return false; l.paused = false; onChange(); return true; }
  function runtimeDone(id) { const l = live.get(id); if (l) { clearTimer(l.timer); l.timer = null; l.busy = 0; } }

  // ---- what the toolbar shows: apps working now or paused
  const state = () => ({
    active: records.map(pub).filter((a) => a.busy || a.paused),
    prompts: pendingPrompts(),
  });
  const connectedCount = () => records.filter((r) => (live.get(r.id)?.sessions.size || 0) > 0).length;
  // Revoke-all (the master switch went off): every app is cut; the approvals stay.
  function disconnectAll() { for (const id of [...live.keys()]) { cut(id); runtimeDone(id); } onChange(); }
  function flush() { if (saveTimer) save(); }

  return { add, remember, revoke, setAsk, list, get, identify, attach, detach, admit, answer, pendingPrompts, beginCall, stop, takeOver, resume, state, connectedCount, disconnectAll, sessionsOf: (id) => [...(live.get(id)?.sessions || [])], flush, setPrompting: (fn) => { prefs.ask = fn; }, raw: () => records };
}

// Where each app keeps its MCP config, when that is a standard place (null: no file to open, e.g. Claude Code's is a command).
function configPath(app, { platform = process.platform, env = process.env, home = require('os').homedir() } = {}) {
  const j = path.join;
  const appData = env.APPDATA || j(home, 'AppData', 'Roaming');
  if (app === 'claude-desktop') return platform === 'win32' ? j(appData, 'Claude', 'claude_desktop_config.json') : platform === 'darwin' ? j(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') : j(env.XDG_CONFIG_HOME || j(home, '.config'), 'Claude', 'claude_desktop_config.json');
  if (app === 'cursor') return j(home, '.cursor', 'mcp.json');
  if (app === 'vscode') return platform === 'win32' ? j(appData, 'Code', 'User', 'mcp.json') : platform === 'darwin' ? j(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json') : j(env.XDG_CONFIG_HOME || j(home, '.config'), 'Code', 'User', 'mcp.json');
  return null;
}

// The ready-to-paste setup for each app. `command` / `args` are how to run the bridge (ai-agents.js mcpCommand); `token` is the app's
// token, or null where it is not known any more (shown once): a placeholder stands in and the text is still valid.
const TOKEN_PLACEHOLDER = 'PASTE-THE-TOKEN-FROM-ADD-APP';
function setupFor({ command, args, token = null, name = 'lumen', platform = process.platform } = {}) {
  const env = { ELECTRON_RUN_AS_NODE: '1', LUMEN_CLIENT_TOKEN: token || TOKEN_PLACEHOLDER };
  const quoted = [command, ...args].map((a) => (platform === 'win32' || /\s/.test(a) ? `"${a}"` : a)).join(' ');
  const json = (o) => JSON.stringify(o, null, 2);
  return {
    'claude-desktop': { label: 'Claude Desktop', file: 'claude_desktop_config.json', where: 'Settings, Developer, Edit Config, then merge this in', text: json({ mcpServers: { [name]: { command, args, env } } }) },
    cursor: { label: 'Cursor', file: '.cursor/mcp.json', where: '~/.cursor/mcp.json (all projects) or .cursor/mcp.json in a project', text: json({ mcpServers: { [name]: { command, args, env } } }) },
    vscode: { label: 'VS Code', file: 'mcp.json', where: 'Command Palette, MCP: Open User Configuration (Copilot, Continue and other extensions read it too)', text: json({ servers: { [name]: { type: 'stdio', command, args, env } } }) },
    'claude-code': { label: 'Claude Code', file: null, where: 'run it in a terminal', text: `${platform === 'win32' ? 'claude.cmd' : 'claude'} mcp add ${name} --scope user -e ELECTRON_RUN_AS_NODE=1 -e LUMEN_CLIENT_TOKEN=${token || TOKEN_PLACEHOLDER} -- ${quoted}` },
  };
}

module.exports = { createExternalApps, configPath, setupFor, APPS, TOKEN_PLACEHOLDER, RUN_QUIET_MS, PROMPT_WAIT_MS, cleanName };
