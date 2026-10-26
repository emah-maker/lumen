// Wires features/external-apps.js into Lumen: the Settings → AI → "Let other apps use Lumen" calls, the toolbar pill and the
// "wants to use Lumen" prompt (sent to the windows as `external:state`), and the OS notifications. ai-agents.js calls this once and
// hands the result to the MCP server's hooks (identify, onInitialize, onClose) and to mcpCallTool (beginCall).
//
// Returns { ext, invoke: { <name>: fn }, send: { <name>: fn } }: ai-agents.js registers them as mcp:external-<name> on first use (nothing here loads at
// start-up: most people never use it). deps: { app, readSettings, writeSettings, userWc(), mcpCommand(), mcpServer(), startMcp(), agentWindows, showAgentWindow(rec) }
const path = require('path');
const fs = require('fs');
const externalApps = require('./external-apps');

function setupExternalApps(deps) {
  const { app, readSettings, writeSettings } = deps;
  const invoke = {};
  const send_ = {};
  const isTest = require('../test-mode').isTest();
  const notes = []; // (tests read what would have been shown as an OS notification)
  const electron = () => require('electron');
  const notify = (title, body, { silent = true, onClick = null } = {}) => {
    notes.push({ title, body });
    if (isTest) return;
    try {
      const { Notification } = electron();
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body, silent });
      if (onClick) n.on('click', onClick);
      n.show();
    } catch {}
  };
  const send = (wc, payload) => { try { if (wc && !wc.isDestroyed()) wc.send('external:state', payload); } catch {} };

  let ext = null;
  // The user's window gets everything (the pills of every app, the prompt); an app's own window only its own pill.
  function broadcast() {
    if (!ext) return;
    const state = ext.state();
    send(deps.userWc(), state);
    // (every app with a window gets its state, an empty one too: when an app goes idle or is resumed its own window's pill must go, not stay "paused")
    for (const known of ext.list()) {
      const mine = state.active.find((x) => x.id === known.id);
      for (const s of ext.sessionsOf(known.id)) {
        const rec = deps.agentWindows?.windows.get(s);
        const wc = rec?.win?.webContents;
        if (wc && wc !== deps.userWc()) send(wc, { active: mine ? [mine] : [], prompts: [] });
      }
    }
  }
  ext = externalApps.createExternalApps({
    file: path.join(app.getPath('userData'), 'external-apps.json'),
    safeStorage: isTest && global.__externalAppsSafeStorage ? global.__externalAppsSafeStorage : electron().safeStorage,
    onChange: broadcast,
    onPrompt: (e) => { if (e.type === 'open') notify('Lumen', `Unverified app “${e.prompt.name}” wants to use Lumen. Open Lumen to allow or deny it.`, { silent: false, onClick: () => { try { deps.userWc()?.focus(); } catch {} } }); },
    onFinished: (a) => notify('Lumen', `${a.name} finished in Lumen`),
  });
  // Token required for every app (new users), or token-less clients asked one by one ('ask'). 'open' (no checks) exists only so the older tests, which
  // drive Lumen through token-less sessions (and the unit tests, outside Electron, with fake sessions), keep running; test/e2e/external-apps.js turns it off (global.__externalStrict).
  ext.setPolicy(() => (readSettings().externalAppsRequireToken === true ? 'require' : (isTest && !global.__externalStrict) || !process.versions.electron ? 'open' : 'ask'));

  const enabled = () => readSettings().mcpEnabled === true;
  const setup = (tokenFile = null) => externalApps.setupFor({ ...deps.mcpCommand(), tokenFile });
  const paths = () => Object.fromEntries(['claude-desktop', 'cursor', 'vscode'].map((k) => [k, externalApps.configPath(k)]));
  const info = () => ({ enabled: enabled(), requireToken: readSettings().externalAppsRequireToken === true, connected: ext.connectedCount(), apps: ext.list(), setup: setup(), paths: paths(), platform: process.platform });

  invoke.info = () => info();
  // The master switch. Turning it on from here (it was off) also requires a token for every app. Someone who already had agent connections on keeps
  // token-less clients working, each asked about (Settings shows a warning and a one-click switch to require tokens).
  invoke.enable = (on) => {
    const s = readSettings();
    writeSettings({ ...s, mcpEnabled: Boolean(on), ...(on && !s.mcpEnabled && s.externalAppsRequireToken === undefined ? { externalAppsRequireToken: true } : {}) });
    if (!on) { deps.mcpServer()?.disconnectAll(); deps.agentWindows?.windows.releaseAll(); ext.disconnectAll(); } else deps.startMcp();
    return info();
  };
  invoke['require-token'] = (on) => { writeSettings({ ...readSettings(), externalAppsRequireToken: Boolean(on) }); if (on) ext.disconnectUnverified(); return info(); };
  invoke.setup = (id) => { const a = ext.list().find((x) => x.id === String(id) && x.kind === 'token'); return a ? { ok: true, app: a, setup: setup(ext.tokenFileOf(a.id)) } : { ok: false }; };
  invoke.add = ({ name, app: kind, ask } = {}) => {
    try {
      const made = ext.add({ name, app: kind, ask });
      return { ok: true, app: made.app, setup: setup(made.tokenFile), info: info() }; // (the token itself stays in its file: it is shown nowhere)
    } catch (err) { return { ok: false, error: String(err?.message || err) }; }
  };
  // "Connect <app>": its token app + its own config, in one click (external-apps-connect.js). Tests never touch a real config or CLI: they hand in stand-ins.
  const runCli = (found, argv) => new Promise((resolve) => {
    require('../ai/cli-utils').execFile(found.command, [...(found.args || []), ...argv], { shell: false, windowsHide: true, timeout: 60000, cwd: require('os').homedir(), ...(found.env ? { env: { ...process.env, ...found.env } } : {}) }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, '').trim() });
    });
  });
  invoke.connect = async (kind) => {
    kind = String(kind);
    const connect = require('./external-apps-connect');
    if (kind !== 'claude-code' && !connect.JSON_APPS[kind]) return { ok: false, error: 'Lumen can’t set that app up by itself yet. Copy the text below instead.' };
    const seams = (isTest && global.__externalConnectSeams) || {};
    const { command, args } = deps.mcpCommand();
    let r;
    try {
      if (kind === 'claude-code') r = await connect.connectClaudeCode({ ext, command, args, find: seams.claude ? async () => seams.claude : deps.findClaude, run: runCli });
      else r = connect.connectJsonApp(kind, { ext, command, args, file: isTest ? seams.configPath?.(kind) : externalApps.configPath(kind) });
    } catch (err) { r = { ok: false, error: String(err?.message || err) }; }
    if (r.ok && !enabled()) invoke.enable(true); // (asking to connect an app is asking for apps to connect; a first-time switch-on also requires tokens)
    return { ...r, app: r.app || null, setup: r.tokenFile ? setup(r.tokenFile) : null, info: info() };
  };
  invoke.revoke = (id) => ({ ok: ext.revoke(String(id)), info: info() });
  invoke.ask = (id, on) => ({ ok: ext.setAsk(String(id), on === true), info: info() });
  invoke['open-config'] = (kind) => {
    const file = externalApps.configPath(String(kind));
    if (!file) return { ok: false, path: null };
    if (isTest) return { ok: true, path: file, test: true }; // (never opens the user's real file)
    const { shell } = electron();
    if (fs.existsSync(file)) { shell.showItemInFolder(file); return { ok: true, path: file }; }
    const dir = path.dirname(file);
    if (fs.existsSync(dir)) { shell.openPath(dir); return { ok: true, path: file, missing: true }; }
    return { ok: false, path: file, missing: true };
  };
  // The prompt and the pill (the toolbar of any window).
  invoke.answer = (id, decision) => ext.answer(String(id), String(decision));
  send_.stop = (id) => { ext.stop(String(id)); };
  send_.takeover = (id) => {
    ext.takeOver(String(id));
    for (const s of ext.sessionsOf(String(id))) { const w = deps.agentWindows?.windows.get(s); try { deps.handAgentWindow?.(w, 'user'); deps.showAgentWindow?.(w); } catch {} } // (its window comes forward: now it is the user's to use, and stays theirs when the session ends)
  };
  send_.resume = (id) => { ext.resume(String(id)); for (const s of ext.sessionsOf(String(id))) { try { deps.handAgentWindow?.(deps.agentWindows?.windows.get(s), 'agent'); } catch {} } }; // (the tabs the user held go back to the agent)
  invoke.state = () => ext.state();

  return { ext, invoke, send: send_, test: { ext, notes, info, answer: (id, d) => ext.answer(id, d), tokenFile: (id) => ext.tokenFileOf(id) } };
}

module.exports = { setupExternalApps };
