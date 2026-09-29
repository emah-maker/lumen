// Outside AI agents driving Lumen, split out of main.js:
//  - MCP (Claude Code, Codex CLI, Gemini CLI, Cursor…) through mcp.js,
//  - automation tools over the Chrome DevTools Protocol (automation.js, opt-in),
//  - the sidebar's "Claude · your account" engine: the user's own Claude Code CLI (claude-code.js),
//  - the sidebar's "Grok · your account" engine: the user's own Grok Build CLI (grok-build.js),
//  - the "Using: <page>" setting.
// automation.js, claude-code.js and grok-build.js load only when first needed.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { exists, lookup: which, validModel } = require('../cli-utils');
const launcher = require('../launcher');
// `electron` is only there in the main process; units.js loads this file in plain Node.
const webContents = { getAllWebContents: () => require('electron').webContents.getAllWebContents() };

const MAIN_DIR = path.join(__dirname, '..');
const DEFAULT_AUTOMATION_PORT = 9222;
const validPort = (port) => (Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_AUTOMATION_PORT);
// Anthropic's terms let a user sign in to the unmodified Claude Code binary with their own
// subscription; they just don't let a third-party app offer claude.ai sign-in to other people (see
// https://code.claude.com/docs/en/legal-and-compliance). So sharing Lumen means each person brings
// their own login: their own API key, or connecting Lumen as an MCP server to their own CLI.
const CLAUDE_CODE_NOTE = 'Claude Code';
// Same idea, for a user's own Grok Build CLI (xAI's terms: a SuperGrok/X Premium+ account signs in
// to the unmodified `grok` binary; sharing Lumen still means each person brings their own login).
const GROK_BUILD_NOTE = 'Grok Build';

// The secret at the start of every automation proxy URL (automation.js). Kept in the profile so a
// saved Playwright MCP config keeps working across restarts; turning the setting off deletes it,
// so turning it back on gives a new address.
const automationTokenPath = (userData) => path.join(userData, 'automation-token');
function automationToken(userData) {
  try {
    const saved = fs.readFileSync(automationTokenPath(userData), 'utf8').trim();
    if (/^[0-9a-f]{48}$/.test(saved)) return saved;
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(automationTokenPath(userData), token, { mode: 0o600 });
  return token;
}

// Called at startup, before the app is ready: the debugging switches only work if set this early.
// { relaunch: true }: this process should hand over to launcher.js (main.js does). Otherwise the
// proxy's plan, with Chromium's DevTools on the launcher's pipe (pipeFd) or, in test runs under
// Playwright, on a localhost port (file: where Chromium says which).
// In-process backend (cdp-inproc.js): no Chromium port, no pipe, no launcher. Always on macOS, where
// a launcher would lose the open-url/open-file events LaunchServices sends to the process it started;
// LUMEN_AUTOMATION_INPROC=1 forces it elsewhere (how the tests run it on Windows and Linux).
const inProcessAutomation = (platform = process.platform, env = process.env) => platform === 'darwin' || env.LUMEN_AUTOMATION_INPROC === '1';

function prepareAutomation(app, settings, { platform = process.platform, env = process.env } = {}) {
  const launched = launcher.isLaunched();
  if (!settings.automationEnabled) return null;
  const inproc = inProcessAutomation(platform, env);
  if (!inproc && !launched && launcher.available()) return { relaunch: true };
  const plan = { port: validPort(settings.automationPort), token: automationToken(app.getPath('userData')) };
  // Debugging makes Chromium set navigator.webdriver = true on every page, which Cloudflare's
  // "Verify you are human" and Google sign-in treat as a bot: the checkbox spins and resets forever.
  app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
  if (inproc) return { ...plan, inproc: true }; // never a debugging switch: nothing outside Lumen can reach Chromium's DevTools
  if (launched) {
    app.commandLine.appendSwitch('remote-debugging-pipe');
    return { ...plan, pipeFd: launcher.LUMEN_FD };
  }
  // Chromium's port has no authentication; automation.js hides it as well as it can (see there).
  const file = path.join(app.getPath('userData'), 'DevToolsActivePort');
  try { fs.rmSync(file, { force: true }); } catch {}
  app.commandLine.appendSwitch('remote-debugging-port', '0');
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  return { ...plan, file };
}

// Settles as soon as `signal` aborts, so Stop answers the agent at once even mid-tool.
const abortable = (promise, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new Error('Stopped by the user.')); return; }
  const onAbort = () => reject(new Error('Stopped by the user.'));
  signal.addEventListener('abort', onAbort, { once: true });
  promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
});

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
  // Off until the user turns it on (Settings, or an "Add to <agent>" button): nothing outside Lumen
  // can drive the browser by default. Lumen's own engines (ownsSession) work either way.
  const mcpEnabled = () => readSettings().mcpEnabled === true;

  // ---------- Claude Code engine (created on first use) ----------

  let claudeCode = null;
  let claudeCodeFound = false;
  let claudeCodeSignedIn = 'unknown'; // true | false | 'unknown' — mirrors claudeCode.status().signedIn
  let claudeCodeDetail = null; // subscription label (e.g. 'enterprise'), when known
  const claudeCodeModule = () => require('../claude-code');
  const claudeCodeEngine = () => {
    if (!claudeCode) {
      const { ClaudeCodeEngine } = claudeCodeModule();
      claudeCode = new ClaudeCodeEngine({ userData: app.getPath('userData'), mcpCommand, ensureServer: () => startMcp(true) });
    }
    return claudeCode;
  };

  // ---------- Grok Build engine (created on first use) ----------
  // Runs grok with Lumen's own GROK_HOME, whose config has only the `lumen` MCP server (see
  // grok-build.js's file header); only the user's sign-in is shared with their ~/.grok.

  let grokBuild = null;
  let grokBuildFound = false;
  let grokBuildSignedIn = 'unknown'; // true | false | 'unknown' — mirrors grokBuild.status().signedIn
  let grokBuildDetail = null; // the default model sidebar runs get (asked in Lumen's GROK_HOME), when known
  let grokBuildModels = []; // the model ids `grok models` lists, when known
  const grokBuildModule = () => require('../grok-build');
  // Grok Build in the sidebar is experimental (see grok-build.js's header: Grok asks Lumen's gate
  // before every tool call and only Lumen's tools are allowed, on top of Grok's own rules).
  // It is offered only once the user has connected Lumen to Grok Build ("Add to Grok Build" in
  // Settings), or with LUMEN_GROK_SIDEBAR=1.
  const grokSidebar = () => process.env.LUMEN_GROK_SIDEBAR === '1' || (process.env.LUMEN_GROK_SIDEBAR !== '0' && readSettings().grokSidebar === true);
  const grokBuildEngine = () => {
    if (!grokBuild) {
      const { GrokBuildEngine } = grokBuildModule();
      // Grok reaches Lumen's tools, and asks Lumen before each tool call, over local HTTP
      // (mcp-http.js), started on the first Grok Build message. Its sessions are Lumen's own.
      grokBuild = new GrokBuildEngine({ userData: app.getPath('userData'), gate: startGrokGate });
    }
    return grokBuild;
  };

  // Grok's PreToolUse hook (mcp-http.js terminalDecision) asks this before letting a
  // run_terminal_command call through: the same approval card as an MCP tool's (renderer/app.js
  // showToolApproval, action 'terminal'), on the chat the command came from. 'deny' if that chat's
  // run already ended (a stray call after Lumen's timeout, or a mismatched tag) or was stopped.
  async function onTerminalApproval(tag, command) {
    const engineRun = grokBuild?.owns(tag) ? grokBuild.active : null;
    if (!engineRun) return 'deny';
    let args = String(command || '');
    if (args.length > 4000) args = `${args.slice(0, 4000)}\n…`;
    try {
      const answer = await agent.askApproval('run_terminal_command', engineRun.emit, engineRun.signal, {
        action: 'terminal',
        title: 'Grok wants to run a terminal command',
        args,
      });
      return answer === 'always' ? 'always' : answer ? 'once' : 'deny';
    } catch {
      return 'deny'; // the user hit Stop while the card was up
    }
  }

  let grokGate = null;
  function startGrokGate() {
    grokGate ||= require('../mcp-http').startHttp({ tools: deps.tools, callTool: mcpCallTool, enabled: ownsSession, onEvent: mcpEvent, onTerminalApproval })
      .catch((err) => { grokGate = null; throw err; });
    return grokGate;
  }

  // Which engine (if any) a bridge's LUMEN_ENGINE tag belongs to.
  const engineForSession = (session) => (claudeCode?.owns(session?.engine) ? claudeCode : grokBuild?.owns(session?.engine) ? grokBuild : null);
  const ownsSession = (session) => Boolean(engineForSession(session));
  agent.engines = { get claudecode() { return claudeCodeEngine(); }, get grokbuild() { return grokBuildEngine(); } };
  if (require('../test-mode').isTest()) Object.defineProperty(global, '__claudeCode', { get: claudeCodeEngine, configurable: true });

  // Runs one browser tool for an external agent, with the same per-site approval as the sidebar,
  // and shows each call as a step in the sidebar.
  async function mcpCallTool(name, args, session) {
    const problem = deps.validateToolInput(name, args);
    if (problem) return { content: [{ type: 'text', text: `Invalid input: ${problem}` }], isError: true };
    session.approvedHosts ||= new Set();
    const stepId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const label = await agent.describeStep(name, args).catch(() => null);
    // A call from the sidebar's own Claude Code or Grok Build run shows as a step of that reply and
    // uses the chat's approvals; anything else is an external agent.
    const owner = engineForSession(session);
    const engineRun = owner ? owner.active : null;
    const toUi = engineRun ? engineRun.emit : mcpEvent;
    const signal = engineRun ? engineRun.signal : session.controller.signal;
    const scope = engineRun && agent.engineScope();
    // `run` carries the "has read page content" taint (agent.ensureAllowed): the engine's message
    // scope for the sidebar's own engine (its chat holds the taint until New chat, and the attached
    // page text counts), the MCP session for an outside agent (every call in the session shares it).
    const allow = engineRun
      ? { hosts: agent.approvedHosts, who: owner === grokBuild ? 'Grok' : 'Claude', input: args, run: scope || engineRun }
      : { hosts: session.approvedHosts, who: session.clientName, external: true, input: args, run: session }; // outside agents always ask
    toUi({ type: 'tool', id: stepId, name, input: args, label, clientName: session.clientName });
    const emit = (event) => toUi({ ...event, clientName: session.clientName });
    // The sidebar's own engine run keeps working in the tab its message started in (agent.engineScope);
    // an outside agent's call is pinned to the tab in front when it arrives, so the approval card and
    // the action it allows are about the same tab. Stop ends a long wait at once, either way.
    const work = async () => {
      await agent.ensureAllowed(name, emit, signal, allow);
      return abortable(agent.execute(name, args), signal);
    };
    try {
      const result = await (scope ? agent.inScope(scope, work) : agent.inTask(agent.browser.activeTab()?.id, signal, work));
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
    const win = process.platform === 'win32';
    const json = JSON.stringify({ mcpServers: { lumen: { command, args, env } } }, null, 2);
    return {
      enabled: mcpEnabled(),
      snippets: [
        // On Windows these use the .cmd shim (not the .ps1 one): PowerShell's claude.ps1 swallows
        // `--`, but claude.cmd and quoted paths work in both PowerShell and cmd.exe.
        { id: 'claude', label: 'Claude Code', hint: 'One click, or run this in a terminal', text: `${win ? 'claude.cmd' : 'claude'} mcp add lumen --scope user -e ELECTRON_RUN_AS_NODE=1 -- ${quoted}`, addButton: 'claude' },
        { id: 'codex', label: 'Codex CLI', hint: 'One click, or run this in a terminal', text: `${win ? 'codex.cmd' : 'codex'} mcp add lumen --env ELECTRON_RUN_AS_NODE=1 -- ${quoted}`, addButton: 'codex', secondary: 'Or add a [mcp_servers.lumen] entry to ~/.codex/config.toml.' },
        { id: 'grok', label: 'Grok Build', hint: 'One click, or run this in a terminal (needs SuperGrok or X Premium+)', text: `grok mcp add lumen -e ELECTRON_RUN_AS_NODE=1 -- ${quoted}`, addButton: 'grok', secondary: 'Or add a [mcp_servers.lumen] entry to ~/.grok/config.toml.' },
        { id: 'gemini', label: 'Gemini CLI', hint: 'One click, or run this in a terminal', text: `${win ? 'gemini.cmd' : 'gemini'} mcp add -s user -e ELECTRON_RUN_AS_NODE=1 lumen ${quoted}`, addButton: 'gemini', secondary: 'Or add to ~/.gemini/settings.json directly.' },
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

  // ---------- One-click "Add to <agent>" for Claude Code, Codex CLI, Grok Build and Gemini CLI ----------
  // Every add runs the target CLI with an argv array and shell:false (never a shell string), so
  // user-controlled paths never reach a shell and PowerShell can't eat `--`.

  // A Windows npm shim (name.cmd) runs node_modules/<pkg>/<bin file>; read the real entry out of
  // the package's own package.json instead of guessing the path, then run it with `node`. (The .cmd
  // itself can't be run: Node refuses .cmd/.bat without a shell since CVE-2024-27980.) With no
  // `node` on PATH, Lumen's own Electron runs it in Node mode (ELECTRON_RUN_AS_NODE).
  async function resolveNpmShim(cmdPath, pkgName) {
    try {
      const pkgDir = path.join(path.dirname(cmdPath), 'node_modules', ...pkgName.split('/'));
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
      const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin || {})[0];
      const entry = bin && path.join(pkgDir, bin);
      if (!entry || !exists(entry)) return null;
      const node = (await which('node')).find((p) => /\.exe$/i.test(p) && exists(p));
      return node ? { command: node, args: [entry] } : { command: process.execPath, args: [entry], env: { ELECTRON_RUN_AS_NODE: '1' } };
    } catch { return null; }
  }
  // { command, args } to run `name` (a real .exe if one exists, else its npm shim resolved to node).
  // `extra`: install folders to try when it isn't on PATH (a GUI app may not see a fresh PATH).
  async function findCli(name, pkgName, extra = []) {
    const fallback = () => {
      const hit = extra.map((d) => path.join(d, process.platform === 'win32' ? `${name}.exe` : name)).find(exists);
      return hit ? { command: hit, args: [] } : null;
    };
    if (process.platform === 'win32') {
      for (const hit of await which(name)) {
        if (/\.exe$/i.test(hit) && exists(hit)) return { command: hit, args: [] };
        if (/\.cmd$/i.test(hit)) {
          const shim = pkgName && await resolveNpmShim(hit, pkgName);
          if (shim) return shim;
        }
      }
      return fallback();
    }
    const [hit] = await which(name);
    return hit && exists(hit) ? { command: hit, args: [] } : fallback();
  }
  const execArgv = (command, argv, env) => new Promise((resolve) => {
    execFile(command, argv, { shell: false, windowsHide: true, timeout: 60000, cwd: os.homedir(), ...(env ? { env: { ...process.env, ...env } } : {}) }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout || ''}${stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, '').trim() });
    });
  });

  const AGENTS = {
    claude: {
      label: 'Claude Code',
      find: async () => { const bin = await claudeCodeEngine().detect(true); return bin ? { command: bin, args: [] } : null; },
      installHint: () => `Claude Code isn't installed. ${claudeCodeModule().INSTALL_HINT}`,
      check: (run) => run(['mcp', 'get', 'lumen']),
      add: (run, argv) => run(['mcp', 'add', 'lumen', '--scope', 'user', '-e', 'ELECTRON_RUN_AS_NODE=1', '--', ...argv]),
    },
    codex: {
      label: 'Codex CLI',
      find: () => findCli('codex', '@openai/codex'),
      installHint: () => "Codex CLI isn't installed. Install it with: npm install -g @openai/codex",
      // `codex mcp get` may not exist on older builds; `codex mcp list` is the reliable fallback.
      check: async (run) => {
        const got = await run(['mcp', 'get', 'lumen']);
        if (got.ok) return { ok: true };
        const list = await run(['mcp', 'list']);
        return { ok: list.ok && list.out.includes('lumen') };
      },
      add: (run, argv) => run(['mcp', 'add', 'lumen', '--env', 'ELECTRON_RUN_AS_NODE=1', '--', ...argv]),
    },
    gemini: {
      label: 'Gemini CLI',
      find: () => findCli('gemini', '@google/gemini-cli'),
      installHint: () => "Gemini CLI isn't installed. Install it with: npm install -g @google/gemini-cli",
      check: async (run) => { const list = await run(['mcp', 'list']); return { ok: list.ok && list.out.includes('lumen') }; },
      add: (run, argv) => run(['mcp', 'add', '-s', 'user', '-e', 'ELECTRON_RUN_AS_NODE=1', 'lumen', ...argv]),
    },
    // xAI's Grok Build (native installer, signs in with the user's own SuperGrok / X Premium+ account).
    // Node-mode bridge like the others (`grok mcp add -e`): it connects at once, where the env-free
    // `Lumen --mcp` bridge boots all of Electron and was still "pending" when a headless run began.
    grok: {
      label: 'Grok Build',
      find: () => findCli('grok', null, [path.join(os.homedir(), '.grok', 'bin'), path.join(os.homedir(), '.local', 'bin')]),
      installHint: () => `Grok Build isn't installed. Install it with: ${process.platform === 'win32' ? 'irm https://x.ai/cli/install.ps1 | iex  (in PowerShell)' : 'curl -fsSL https://x.ai/cli/install.sh | bash'}, then run grok once to sign in (needs SuperGrok or X Premium+).`,
      check: async (run) => { const list = await run(['mcp', 'list']); return { ok: list.ok && /lumen/.test(list.out) }; },
      add: (run, argv) => run(['mcp', 'add', 'lumen', '-e', 'ELECTRON_RUN_AS_NODE=1', '--', ...argv]),
    },
  };

  // Connecting an agent is the user asking for agents to connect, so it also turns on "Allow AI agents
  // to connect" (off by default). Grok Build connected this way is also offered in the sidebar.
  function connected(id) {
    const settings = readSettings();
    writeSettings({ ...settings, mcpEnabled: true, ...(id === 'grok' ? { grokSidebar: true } : {}) });
    startMcp();
    if (id === 'grok') refreshGrokBuildStatus(true).catch(() => {});
  }
  async function addToAgent(id) {
    const key = AGENTS[id] ? id : 'claude';
    const agent = AGENTS[key];
    const found = await agent.find();
    if (!found) return { ok: false, text: agent.installHint() };
    const run = (argv) => execArgv(found.command, [...found.args, ...argv], found.env);
    if ((await agent.check(run)).ok) { connected(key); return { ok: true, already: true, text: 'Already connected' }; }
    const { command, args } = mcpCommand();
    const added = await agent.add(run, [command, ...args]);
    if (added.ok) connected(key);
    return added.ok
      ? { ok: true, text: `Added. Start a new ${agent.label} session to use Lumen.` }
      : { ok: false, text: added.out.split('\n').slice(-2).join(' ') || `${agent.label} could not add Lumen.` };
  }
  ipcMain.handle('mcp:add-to-agent', (_e, id) => addToAgent(id));

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
        // In-process backend only: every web contents, now and as they appear, so a tab's iframes are tracked from the start.
        onContents: (cb) => {
          for (const wc of webContents.getAllWebContents()) cb(wc);
          app.on('web-contents-created', (_e, wc) => cb(wc));
        },
        userAgent: () => deps.userTabs()[0]?.webContents.getUserAgent() || '',
        onSession: ({ active, remaining }) => mcpEvent({ type: 'session', active: Boolean(active), remaining, clientName: 'Playwright (CDP)' }),
      },
    });
  }
  ipcMain.handle('automation:info', () => {
    const settings = readSettings();
    return {
      enabled: Boolean(settings.automationEnabled),
      port: validPort(settings.automationPort),
      // The address is http://127.0.0.1:<port>/<token>; the token of the next launch while it's on.
      token: automationProxy ? deps.automationPlan.token : settings.automationEnabled ? automationToken(app.getPath('userData')) : null,
      running: automationProxy ? { port: automationProxy.state.port, listening: automationProxy.state.listening, error: automationProxy.state.error, clients: automationProxy.clients() } : null,
      internalPort: !deps.automationPlan?.inproc && !launcher.available(), // Chromium's own port is open too (test runs: see launcher.js)
    };
  });
  ipcMain.handle('automation:set', (_e, { enabled, port } = {}) => {
    const settings = readSettings();
    writeSettings({ ...settings, automationEnabled: Boolean(enabled), automationPort: validPort(Number(port)) });
    if (!enabled && automationProxy) { automationProxy.close(); automationProxy = null; } // off takes effect now; on needs a restart
    if (!enabled) try { fs.rmSync(automationTokenPath(app.getPath('userData')), { force: true }); } catch {}
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

  // Refreshes the cached found/signed-in state that modelOptions() reads synchronously, and tells
  // the picker to redraw. Shared by startup detection and the renderer's "Check again".
  function refreshClaudeCodeStatus(refresh) {
    return claudeCodeEngine().status(refresh).then((s) => {
      claudeCodeFound = s.installed;
      claudeCodeSignedIn = s.signedIn;
      claudeCodeDetail = s.detail;
      if (s.installed) ui()?.send('models-updated');
      return s;
    });
  }
  ipcMain.handle('claudecode:status', (_e, refresh) => refreshClaudeCodeStatus(Boolean(refresh)));

  // Same shape as refreshClaudeCodeStatus, for the Grok Build engine (grok-build.js).
  function refreshGrokBuildStatus(refresh) {
    return grokBuildEngine().status(refresh).then((s) => {
      grokBuildFound = s.installed;
      grokBuildSignedIn = s.signedIn;
      grokBuildDetail = s.detail;
      grokBuildModels = s.models || [];
      if (s.installed) ui()?.send('models-updated');
      return s;
    });
  }

  // Until the first look for the CLIs has finished, a saved "Claude Code" / "Grok Build" pick is kept
  // as it is (see effectiveModel in main.js) instead of looking like it isn't set up.
  let detecting = true;

  return {
    start() {
      // Always listening (token-authenticated, profile-local), so an agent run while the setting is off
      // gets "turned off in Lumen settings" instead of its bridge deciding Lumen isn't running and
      // trying to launch it. Sessions are refused while it's off (enabled() below).
      startMcp(true);
      startAutomation();
      // Looking for the CLIs (and loading claude-code.js/grok-build.js) waits until the window is up.
      setTimeout(() => {
        Promise.allSettled([refreshClaudeCodeStatus(false), grokSidebar() ? refreshGrokBuildStatus(false) : null])
          .then(() => { detecting = false; ui()?.send('models-updated'); });
      }, 300);
    },
    // Is a local engine pick ('claudecode:…' / 'grokbuild:…') still being looked for?
    engineDetecting: (id) => detecting && /^(claudecode|grokbuild):/.test(String(id)),
    mcpServer: () => mcpServer,
    // Local agent engines, once each CLI has been found. Listed even when not signed in
    // (signedIn: false) so the setup card can steer the user to sign in instead of the option just
    // silently failing on the first message. Alphabetical, after modelOptions() sorts everything
    // else: Claude Code before Grok Build, same as any other equally-treated pair of entries.
    modelOptions: () => [
      ...(claudeCodeFound ? claudeCodeOptions({ signedIn: claudeCodeSignedIn, accountDetail: claudeCodeDetail }) : []),
      ...(grokSidebar() && grokBuildFound ? grokBuildOptions({ signedIn: grokBuildSignedIn, accountDetail: grokBuildDetail, models: grokBuildModels, saved: readSettings().model }) : []),
    ],
  };
}

// The picker entries for the user's own Claude Code CLI, one per choice in claude-code.js's MODELS.
// The CLI's own default comes first and keeps its id and plain "Claude Code" label, so a saved
// 'claudecode:default' pick (and its replies' labels) stay as they were before there was a choice.
function claudeCodeOptions({ signedIn = 'unknown', accountDetail = null } = {}) {
  return require('../claude-code').MODELS.map((m) => ({
    id: `claudecode:${m.id}`,
    label: m.id === 'default' ? 'Claude Code' : `Claude Code · ${m.label}`,
    detail: signedIn === false
      ? 'Not signed in: open a terminal, run claude, then type /login'
      : m.id === 'default' ? `${CLAUDE_CODE_NOTE} · the model set in Claude Code` : `${CLAUDE_CODE_NOTE} · ${m.label} (the latest ${m.label} model)`,
    group: 'Your Claude account',
    signedIn,
    accountDetail,
  }));
}

// The picker entries for the user's own Grok Build CLI: its default (the saved 'grokbuild:default'
// pick, as before), then each model `grok models` lists. accountDetail is the default it reports.
// A saved pick the CLI didn't list this time (`grok models` timed out, say) stays offered, as a
// saved OpenRouter model does in main.js, instead of the picker quietly moving to another AI.
function grokBuildOptions({ signedIn = 'unknown', accountDetail = null, models = [], saved = null } = {}) {
  const list = models.filter((m) => m !== 'default' && validModel(m));
  const pick = /^grokbuild:(.+)$/.exec(String(saved || ''))?.[1];
  if (pick && pick !== 'default' && validModel(pick) && !list.includes(pick)) list.push(pick);
  const note = 'experimental: Grok asks Lumen before every tool call, and only Lumen’s browser tools are allowed';
  return ['default', ...list].map((model) => ({
    id: `grokbuild:${model}`,
    label: model === 'default' ? 'Grok Build (experimental)' : `Grok Build · ${model} (experimental)`,
    detail: signedIn === false
      ? 'Not signed in: open a terminal, run grok, then run grok login'
      : `${GROK_BUILD_NOTE} · ${model === 'default' ? `Grok’s default model${accountDetail ? ` (${accountDetail})` : ''}` : model} · ${note}`,
    group: 'Your Grok account',
    signedIn,
    accountDetail,
  }));
}

module.exports = { setupAiAgents, prepareAutomation, inProcessAutomation, validPort, DEFAULT_AUTOMATION_PORT, claudeCodeOptions, grokBuildOptions };
