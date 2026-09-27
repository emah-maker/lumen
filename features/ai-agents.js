// Outside AI agents driving Lumen, split out of main.js:
//  - MCP (Claude Code, Codex CLI, Gemini CLI, Cursor…) through mcp.js,
//  - automation tools over the Chrome DevTools Protocol (automation.js, opt-in),
//  - the sidebar's "Claude · your account" engine: the user's own Claude Code CLI (claude-code.js),
//  - the "Using: <page>" setting.
// automation.js and claude-code.js load only when first needed.
const fs = require('fs');
const path = require('path');

const MAIN_DIR = path.join(__dirname, '..');
const DEFAULT_AUTOMATION_PORT = 9222;
const validPort = (port) => (Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_AUTOMATION_PORT);
const CLAUDE_CODE_NOTE = "Uses your Claude Code login. For personal use; apps offered to others need Anthropic's approval to use claude.ai logins.";

// Called at startup, before the app is ready: the debugging switch only works if set this early.
function prepareAutomation(app, settings) {
  if (!settings.automationEnabled) return null;
  const file = path.join(app.getPath('userData'), 'DevToolsActivePort');
  try { fs.rmSync(file, { force: true }); } catch {}
  app.commandLine.appendSwitch('remote-debugging-port', '0');
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  return { port: validPort(settings.automationPort), file };
}

const toMcpContent = (result) => (typeof result === 'string'
  ? [{ type: 'text', text: result }]
  : result.map((b) => (b.type === 'image' ? { type: 'image', data: b.source.data, mimeType: b.source.media_type } : { type: 'text', text: b.text ?? '' })));

// deps: { app, ipcMain, agent, tools, validateToolInput, readSettings, writeSettings, ui,
//         automationPlan, userTabs, openTab, closeTab, switchTab, isWebUrl }
function setupAiAgents(deps) {
  const { app, ipcMain, agent, readSettings, writeSettings, ui } = deps;

  // ---------- MCP ----------

  let mcpServer = null;
  // Sessions opened by the sidebar's own Claude Code engine (event.engine) are not "external agents".
  const mcpEvent = (event) => { if (!event.engine) ui()?.send('mcp:event', event); };
  const mcpEnabled = () => readSettings().mcpEnabled !== false;

  // ---------- Claude Code engine (created on first use) ----------

  let claudeCode = null;
  let claudeCodeFound = false;
  const claudeCodeModule = () => require('../claude-code');
  const claudeCodeEngine = () => {
    if (!claudeCode) {
      const { ClaudeCodeEngine } = claudeCodeModule();
      claudeCode = new ClaudeCodeEngine({ userData: app.getPath('userData'), mcpCommand, ensureServer: () => startMcp(true) });
    }
    return claudeCode;
  };
  const ownsSession = (session) => Boolean(claudeCode?.owns(session?.engine));
  agent.engines = { get claudecode() { return claudeCodeEngine(); } };
  if (process.env.CLAUDE_BROWSER_TEST) Object.defineProperty(global, '__claudeCode', { get: claudeCodeEngine, configurable: true });

  // Runs one browser tool for an external agent, with the same per-site approval as the sidebar,
  // and shows each call as a step in the sidebar.
  async function mcpCallTool(name, args, session) {
    const problem = deps.validateToolInput(name, args);
    if (problem) return { content: [{ type: 'text', text: `Invalid input: ${problem}` }], isError: true };
    session.approvedHosts ||= new Set();
    const stepId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const label = await agent.describeStep(name, args).catch(() => null);
    // A call from the sidebar's own Claude Code run shows as a step of that reply and uses the
    // chat's approvals; anything else is an external agent.
    const engineRun = ownsSession(session) ? claudeCode.active : null;
    const toUi = engineRun ? engineRun.emit : mcpEvent;
    const signal = engineRun ? engineRun.signal : session.controller.signal;
    const allow = engineRun ? { hosts: agent.approvedHosts, who: 'Claude' } : { hosts: session.approvedHosts, who: session.clientName };
    toUi({ type: 'tool', id: stepId, name, input: args, label, clientName: session.clientName });
    const emit = (event) => toUi({ ...event, clientName: session.clientName });
    try {
      await agent.ensureAllowed(name, emit, signal, allow);
      const result = await agent.execute(name, args);
      toUi({ type: 'tool_done', id: stepId, ok: true });
      return { content: toMcpContent(result), isError: false };
    } catch (err) {
      const message = signal.aborted ? 'Stopped by the user.' : String(err?.message || err);
      toUi({ type: 'tool_done', id: stepId, ok: false, error: message.split('\n')[0] });
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  }

  // Only listens while "Allow AI agents to connect" is on (it is by default); turning it on later
  // starts the server on demand.
  // The sidebar's Claude Code engine starts it too (force), and its own sessions are always allowed.
  function startMcp(force = false) {
    if (mcpServer || (!force && !mcpEnabled())) return;
    mcpServer = require('../mcp').startServer({
      userData: app.getPath('userData'),
      tools: deps.tools,
      callTool: mcpCallTool,
      enabled: (session) => mcpEnabled() || ownsSession(session),
      onEvent: mcpEvent,
    });
  }

  // The command an agent should run: Lumen's own executable in Node mode on mcp.js (clean stdio,
  // no window machinery). Works for the installed app and for development alike.
  function mcpCommand() {
    return { command: process.execPath, args: [path.join(MAIN_DIR, 'mcp.js')], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }

  ipcMain.handle('mcp:info', () => {
    const { command, args, env } = mcpCommand();
    const quoted = [command, ...args].map((a) => (process.platform === 'win32' || /\s/.test(a) ? `"${a}"` : a)).join(' ');
    const json = JSON.stringify({ mcpServers: { lumen: { command, args, env } } }, null, 2);
    const tomlArgs = args.map((a) => `'${a}'`).join(', ');
    return {
      enabled: mcpEnabled(),
      snippets: [
        { id: 'claude', label: 'Claude Code', hint: 'Run in a terminal, or use Add to Claude Code', text: `${process.platform === 'win32' ? 'claude.cmd' : 'claude'} mcp add lumen --scope user -e ELECTRON_RUN_AS_NODE=1 -- ${quoted}`, addButton: true },
        { id: 'codex', label: 'Codex CLI', hint: 'Add to ~/.codex/config.toml', text: `[mcp_servers.lumen]\ncommand = '${command}'\nargs = [${tomlArgs}]\nenv = { ELECTRON_RUN_AS_NODE = "1" }` },
        { id: 'gemini', label: 'Gemini CLI', hint: 'Add to ~/.gemini/settings.json', text: json },
        { id: 'json', label: 'Other MCP clients', hint: 'Cursor, Claude Desktop, etc.', text: json },
      ],
    };
  });
  ipcMain.handle('mcp:set-enabled', (_e, on) => {
    writeSettings({ ...readSettings(), mcpEnabled: Boolean(on) });
    if (!on) mcpServer?.disconnectAll();
    else startMcp();
    return true;
  });

  // One click "Add to Claude Code": runs the CLI with an argv array (no shell, so no PowerShell
  // shim eating `--`). Checks `claude mcp get lumen` first.
  ipcMain.handle('mcp:add-to-claude', async () => {
    const bin = await claudeCodeEngine().detect(true);
    if (!bin) return { ok: false, text: `Claude Code isn't installed. ${claudeCodeModule().INSTALL_HINT}` };
    const run = (argv) => new Promise((resolve) => {
      require('child_process').execFile(bin, argv, { shell: false, windowsHide: true, timeout: 60000, cwd: require('os').homedir() }, (err, stdout, stderr) => {
        resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, '').trim() });
      });
    });
    if ((await run(['mcp', 'get', 'lumen'])).ok) return { ok: true, already: true, text: 'Already connected' };
    const { command, args } = mcpCommand();
    const added = await run(['mcp', 'add', 'lumen', '--scope', 'user', '-e', 'ELECTRON_RUN_AS_NODE=1', '--', command, ...args]);
    return added.ok
      ? { ok: true, text: 'Added. Start a new Claude Code session to use Lumen.' }
      : { ok: false, text: added.out.split('\n').slice(-2).join(' ') || 'Claude Code could not add Lumen.' };
  });

  // ---------- automation tools over CDP: Playwright / CDP clients see only the user's tabs ----------

  let automationProxy = null;
  function startAutomation() {
    if (!deps.automationPlan) return;
    automationProxy = require('../automation').start({
      ...deps.automationPlan,
      hooks: {
        tabs: deps.userTabs,
        openTab: (url, options = {}) => deps.openTab(deps.isWebUrl(url) || url === 'about:blank' ? url : 'about:blank', options),
        closeTab: (id) => deps.closeTab(id),
        switchTab: (id) => deps.switchTab(id),
        onSession: ({ active, remaining }) => mcpEvent({ type: 'session', active: Boolean(active), remaining, clientName: 'Playwright (CDP)' }),
      },
    });
  }
  ipcMain.handle('automation:info', () => {
    const settings = readSettings();
    return {
      enabled: Boolean(settings.automationEnabled),
      port: validPort(settings.automationPort),
      running: automationProxy ? { port: automationProxy.state.port, listening: automationProxy.state.listening, error: automationProxy.state.error, clients: automationProxy.clients() } : null,
    };
  });
  ipcMain.handle('automation:set', (_e, { enabled, port } = {}) => {
    const settings = readSettings();
    writeSettings({ ...settings, automationEnabled: Boolean(enabled), automationPort: validPort(Number(port)) });
    if (!enabled && automationProxy) { automationProxy.close(); automationProxy = null; } // off takes effect now; on needs a restart
    return true;
  });

  ipcMain.on('mcp:stop', () => {
    mcpServer?.disconnectAll();
    automationProxy?.disconnectAll();
  });

  // ---------- "Using: <page>": include the current tab with each message (default on) ----------

  ipcMain.handle('pagecontext:set', (_e, on) => {
    writeSettings({ ...readSettings(), pageContext: Boolean(on) });
    return true;
  });
  ipcMain.handle('pagecontext:get', () => readSettings().pageContext !== false);
  const baseOptions = agent.getOptions;
  agent.getOptions = () => ({ ...baseOptions(), pageContext: readSettings().pageContext !== false });

  return {
    start() {
      startMcp();
      startAutomation();
      // Looking for the CLI (and loading claude-code.js) waits until the window is up.
      setTimeout(() => {
        claudeCodeEngine().detect().then((bin) => { claudeCodeFound = Boolean(bin); if (bin) ui()?.send('models-updated'); });
      }, 800);
    },
    mcpServer: () => mcpServer,
    // "Your Claude account" in the model picker, once the CLI has been found.
    modelOptions: () => (claudeCodeFound ? [{ id: 'claudecode:default', label: 'Claude · your account (Claude Code)', detail: CLAUDE_CODE_NOTE, group: 'Your Claude account' }] : []),
  };
}

module.exports = { setupAiAgents, prepareAutomation, validPort, DEFAULT_AUTOMATION_PORT };
