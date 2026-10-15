// Other apps (Claude Desktop, Cursor, VS Code, Claude Code, outside Lumen) using Lumen: Settings > AI > "Let other apps use Lumen".
// The pure registry behind it. ai-agents.js wires it to the MCP server through three small hooks (automation/mcp.js): `identify` (who
// is this connection), `onInitialize` (may it start) and the call wrapper in mcpCallTool (may this call run, and can it be stopped).
//
//  - Apps: one record per app, a name and a token of its own ("Add app"). The token is kept encrypted (safeStorage) in
//    <userData>/external-apps.json and shown once, when it is made. The bridge proves it knows it (automation/client-token.js).
//    Revoke deletes the record: its connections are cut at once and its token never works again.
//    The token also lives in a file of its own (user-only), <userData>/external-app-tokens/<id>.token, so a config names the file
//    (LUMEN_CLIENT_TOKEN_FILE) and never holds the secret: nothing to commit by mistake.
//  - Token-less clients (an older setup, or any program that knows the shared mcp-token) are "unverified": the name they give is only a
//    label. With "Require a token for every app" on they are refused. Otherwise each connection waits for the user's Allow, which lasts
//    that session only, is never stored, and always asks before it acts. A name that is a token app's or a built-in app's is refused.
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
const MAX_PROMPTS = 3; // open "wants to use Lumen" prompts: a program that tries new names cannot flood the window
const RUN_QUIET_MS = 4000; // an app's run is over once it has made no call for this long
const PROMPT_WAIT_MS = 90000; // an unanswered "wants to use Lumen" is a Deny (not remembered)
const DENY_MEMORY_MS = 10 * 60 * 1000; // a Deny holds for this long, so an app that retries does not ask again and again
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

function createExternalApps({ file, tokenDir = path.join(path.dirname(file), 'external-app-tokens'), safeStorage = null, now = Date.now, onChange = () => {}, onPrompt = () => {}, onFinished = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let records = [];
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(saved?.apps)) records = saved.apps.filter((r) => r && typeof r.id === 'string' && typeof r.name === 'string');
  } catch {}
  const temp = []; // unverified clients the user allowed for their session (never saved)
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
  const byId = (id) => records.find((r) => r.id === id) || temp.find((r) => r.id === id) || null;
  const pub = (r) => {
    const l = live.get(r.id);
    return { id: r.id, name: r.name, app: r.app || 'other', kind: r.secret ? 'token' : 'session', unverified: !r.secret, createdAt: r.createdAt, lastUsed: r.lastUsed || null, ask: r.ask === true, connected: l ? l.sessions.size : 0, busy: l ? l.busy > 0 : false, paused: Boolean(l?.paused) };
  };
  // (Linux's basic_text backend only obfuscates: that is no keychain)
  const encryptionOk = () => Boolean(safeStorage?.isEncryptionAvailable?.()) && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  const tokenFileOf = (id) => path.join(tokenDir, `${id}.token`);
  const secretOf = (r) => {
    if (!r.secret || !encryptionOk()) return null;
    try { return safeStorage.decryptString(Buffer.from(r.secret, 'base64')); } catch { return null; }
  };

  // ---- apps
  function add({ name, app = 'other', ask = true } = {}) {
    const label = cleanName(name) || APPS[app] || APPS.other;
    if (!encryptionOk()) throw new Error('This computer has no system keychain to keep the token in, so Lumen can’t make one safely.');
    if (records.some((r) => r.name.toLowerCase() === label.toLowerCase() && r.secret)) throw new Error(`There is already an app called “${label}”. Pick another name, or revoke that one first.`);
    const { id, token } = clientToken.make();
    const rec = { id, name: label, app: APPS[app] ? app : 'other', secret: safeStorage.encryptString(token).toString('base64'), createdAt: now(), lastUsed: null, ask: ask !== false };
    const tokenFile = tokenFileOf(id);
    try { writeTokenFile(tokenFile, token); } catch (err) { throw new Error(`Lumen couldn’t write the token file: ${err.message}`); }
    records.push(rec);
    save();
    onChange();
    return { app: pub(rec), token, tokenFile }; // the token itself is not shown anywhere: the config names the file
  }
  // A token-less client the user said Allow to, for this connection only. Its name is only what it calls itself.
  function temporary(name) {
    const rec = { id: clientToken.make().id, name: cleanName(name) || 'An AI agent', app: 'other', secret: null, createdAt: now(), lastUsed: null, ask: true };
    temp.push(rec);
    return rec;
  }
  // A name a token-less client may not use: it would pass for an app the user set up (or for one they know).
  const claimed = (name) => { const n = cleanName(name).toLowerCase(); return n && (Object.entries(APPS).some(([k, l]) => k !== 'other' && l.toLowerCase() === n) || records.some((r) => r.secret && r.name.toLowerCase() === n)); };
  function revoke(id) {
    const rec = byId(id);
    if (!rec) return false;
    if (rec.secret) { records = records.filter((r) => r !== rec); save(); try { fs.rmSync(tokenFileOf(id), { force: true }); } catch {} } else temp.splice(temp.indexOf(rec), 1);
    cut(id);
    live.delete(id);
    onChange();
    return true;
  }
  function setAsk(id, on) { const rec = byId(id); if (!rec) return false; rec.ask = on === true; save(); onChange(); return true; }
  const list = () => [...records, ...temp].map(pub);
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
    if (l && l.sessions.delete(session)) {
      const rec = byId(id);
      if (rec && !rec.secret && !l.sessions.size) { temp.splice(temp.indexOf(rec), 1); live.delete(id); } // an unverified client's Allow ends with its session
      onChange();
    }
  }

  // The `onInitialize` hook: null to let the session start, or the words it is refused with.
  async function admit(session, info = {}) {
    if (session.engine) return null; // Lumen's own engines are not other apps (the server serves an engine tag only to a live run of its own: ai-agents.js enabled())
    if (session.externalId) return null; // a second initialize on a session already admitted
    if (session.client) { // it proved a token (identify)
      if (!attach(session, session.client)) return 'This app’s access to Lumen was revoked. Add it again in Lumen: Settings, AI, Let other apps use Lumen.';
      return null;
    }
    // No token: unverified. 'open' is for tests only (ai-agents tests that predate this); 'require' refuses; otherwise the user is asked.
    const policy = prefs.policy();
    if (policy === 'open') return null;
    if (policy === 'require') return NEEDS_TOKEN;
    if (claimed(session.clientName)) return `An app without a token can’t call itself “${cleanName(session.clientName)}”: that is the name of an app set up in Lumen. Give it its own token in Lumen: Settings, AI, Let other apps use Lumen.`;
    if (prompts.size >= MAX_PROMPTS && ![...prompts.values()].some((p) => p.key === cleanName(session.clientName).toLowerCase())) return 'Too many apps are waiting for the user’s answer in Lumen. Try again later.';
    const answer = await askUser(session.clientName);
    if (answer.decision !== 'allow') return `${cleanName(session.clientName) || 'The app'} was not allowed to use Lumen. Give it a token in Lumen: Settings, AI, Let other apps use Lumen.`;
    attach(session, temporary(session.clientName).id);
    return null;
  }
  const NEEDS_TOKEN = 'Lumen needs a token for every app. Add this app in Lumen: Settings, AI, Let other apps use Lumen, and put its token file in the app’s config.';
  const prefs = { policy: () => 'ask' };

  // ---- "Unverified app X wants to use Lumen": Allow (this session) / Deny
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
    const d = decision === 'allow' ? 'allow' : 'deny';
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
    const unmanaged = { signal: null, ask: false, end() {} };
    if (!session || session.engine) return unmanaged;
    // A client that skipped `initialize` (so was never admitted) gets no way round it.
    if (!session.externalId) {
      if (session.client) { if (!attach(session, session.client)) return { refuse: 'This app’s access to Lumen was revoked.' }; }
      else { const policy = prefs.policy(); return policy === 'open' ? unmanaged : policy === 'require' ? { refuse: NEEDS_TOKEN } : { refuse: 'This app has not been allowed to use Lumen. Connect it again and answer the prompt in Lumen.' }; }
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
    active: [...records, ...temp].map(pub).filter((a) => a.busy || a.paused),
    prompts: pendingPrompts(),
  });
  const connectedCount = () => [...records, ...temp].filter((r) => (live.get(r.id)?.sessions.size || 0) > 0).length;
  // Revoke-all (the master switch went off): every app is cut; the approvals stay.
  function disconnectAll() { for (const id of [...live.keys()]) { cut(id); runtimeDone(id); } onChange(); }
  // "Require a token for every app" went on: unverified clients are cut now.
  function disconnectUnverified() { for (const r of [...temp]) revoke(r.id); }
  function flush() { if (saveTimer) save(); }

  return { add, revoke, setAsk, list, get, identify, attach, detach, admit, answer, pendingPrompts, beginCall, stop, takeOver, resume, state, connectedCount, disconnectAll, disconnectUnverified, tokenFileOf, sessionsOf: (id) => [...(live.get(id)?.sessions || [])], flush, setPolicy: (fn) => { prefs.policy = fn; }, raw: () => records };
}

// A file for the token with the user's access only (0600; on Windows the inherited rights are dropped and only this user is granted).
function writeTokenFile(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  if (process.platform === 'win32') {
    const who = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
    try { require('child_process').execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${who}:(F)`], { stdio: 'ignore', windowsHide: true }); } catch {}
  }
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
const FILE_PLACEHOLDER = 'PATH-OF-THE-TOKEN-FILE-FROM-ADD-APP';
// The bridge reads the token from the file named in LUMEN_CLIENT_TOKEN_FILE (the text holds a path, not the secret); `token` (the secret
// itself, LUMEN_CLIENT_TOKEN) is only for a caller that insists. Neither: a placeholder stands in and the text is still valid.
function setupFor({ command, args, tokenFile = null, token = null, name = 'lumen', platform = process.platform } = {}) {
  const key = token && !tokenFile ? 'LUMEN_CLIENT_TOKEN' : 'LUMEN_CLIENT_TOKEN_FILE';
  const value = token && !tokenFile ? token : tokenFile || FILE_PLACEHOLDER;
  const env = { ELECTRON_RUN_AS_NODE: '1', [key]: value };
  const quoted = [command, ...args].map((a) => (platform === 'win32' || /\s/.test(a) ? `"${a}"` : a)).join(' ');
  const json = (o) => JSON.stringify(o, null, 2);
  return {
    'claude-desktop': { label: 'Claude Desktop', file: 'claude_desktop_config.json', where: 'Settings, Developer, Edit Config, then merge this in', text: json({ mcpServers: { [name]: { command, args, env } } }) },
    cursor: { label: 'Cursor', file: '.cursor/mcp.json', where: '~/.cursor/mcp.json, your user-level config', warning: 'Don’t commit this file. Use the user-level config (~/.cursor/mcp.json), not .cursor/mcp.json inside a project.', text: json({ mcpServers: { [name]: { command, args, env } } }) },
    vscode: { label: 'VS Code', file: 'mcp.json', where: 'Command Palette, MCP: Open User Configuration (Copilot, Continue and other extensions read it too)', warning: 'Don’t commit this file. Use the user configuration, not .vscode/mcp.json inside a project.', text: json({ servers: { [name]: { type: 'stdio', command, args, env } } }) },
    'claude-code': { label: 'Claude Code', file: null, where: 'run it in a terminal', warning: 'Keep --scope user: --scope project writes .mcp.json into the project, which gets committed.', text: `${platform === 'win32' ? 'claude.cmd' : 'claude'} mcp add ${name} --scope user -e ELECTRON_RUN_AS_NODE=1 -e "${key}=${value}" -- ${quoted}` },
  };
}

module.exports = { createExternalApps, configPath, setupFor, APPS, TOKEN_PLACEHOLDER, FILE_PLACEHOLDER, RUN_QUIET_MS, PROMPT_WAIT_MS, MAX_PROMPTS, cleanName };
