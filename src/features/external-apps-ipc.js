// Wires features/external-apps.js into Lumen: the Settings > AI > "Let other apps use Lumen" calls, the toolbar pill and the
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
    for (const a of state.active) {
      for (const s of ext.sessionsOf(a.id)) {
        const rec = deps.agentWindows?.windows.get(s);
        const wc = rec?.win?.webContents;
        if (wc && wc !== deps.userWc()) send(wc, { active: [a], prompts: [] });
      }
    }
  }
  ext = externalApps.createExternalApps({
    file: path.join(app.getPath('userData'), 'external-apps.json'),
    safeStorage: isTest && global.__externalAppsSafeStorage ? global.__externalAppsSafeStorage : electron().safeStorage,
    onChange: broadcast,
    onPrompt: (e) => { if (e.type === 'open') notify('Lumen', `${e.prompt.name} wants to use Lumen. Open Lumen to allow or deny it.`, { silent: false, onClick: () => { try { deps.userWc()?.focus(); } catch {} } }); },
    onFinished: (a) => notify('Lumen', `${a.name} finished in Lumen`),
  });
  ext.setPrompting(() => readSettings().externalAppsPrompt === true);

  const enabled = () => readSettings().mcpEnabled === true;
  const setup = (token = null) => externalApps.setupFor({ ...deps.mcpCommand(), token });
  const paths = () => Object.fromEntries(['claude-desktop', 'cursor', 'vscode'].map((k) => [k, externalApps.configPath(k)]));
  const info = () => ({ enabled: enabled(), prompt: readSettings().externalAppsPrompt === true, connected: ext.connectedCount(), apps: ext.list(), setup: setup(), paths: paths(), platform: process.platform });

  invoke.info = () => info();
  // The master switch. Turning it on from here also turns on "ask when an unknown app connects" (an older setup that already had
  // agent connections on keeps its behaviour: the setting stays unset).
  invoke.enable = (on) => {
    const s = readSettings();
    writeSettings({ ...s, mcpEnabled: Boolean(on), ...(on && !s.mcpEnabled && s.externalAppsPrompt === undefined ? { externalAppsPrompt: true } : {}) });
    if (!on) { deps.mcpServer()?.disconnectAll(); deps.agentWindows?.windows.releaseAll(); ext.disconnectAll(); } else deps.startMcp();
    return info();
  };
  invoke['prompt-setting'] = (on) => { writeSettings({ ...readSettings(), externalAppsPrompt: Boolean(on) }); return info(); };
  invoke.add = ({ name, app: kind, ask } = {}) => {
    try {
      const made = ext.add({ name, app: kind, ask });
      return { ok: true, app: made.app, token: made.token, setup: setup(made.token), info: info() };
    } catch (err) { return { ok: false, error: String(err?.message || err) }; }
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
    for (const s of ext.sessionsOf(String(id))) { try { deps.showAgentWindow?.(deps.agentWindows?.windows.get(s)); } catch {} } // (its window comes forward: now it is the user's to use)
  };
  send_.resume = (id) => { ext.resume(String(id)); };
  invoke.state = () => ext.state();

  return { ext, invoke, send: send_, test: { ext, notes, info, answer: (id, d) => ext.answer(id, d) } };
}

module.exports = { setupExternalApps };
