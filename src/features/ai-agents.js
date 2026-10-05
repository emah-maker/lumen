// Outside AI agents driving Lumen, split out of main.js:
//  - MCP (Claude Code, Codex CLI, Grok Build, Antigravity, Cursor…) through mcp.js,
//  - automation tools over the Chrome DevTools Protocol (automation.js, opt-in),
//  - the sidebar's "Claude · your account" engine: the user's own Claude Code CLI (claude-code.js),
//  - the sidebar's "Grok · your account" engine: the user's own Grok Build CLI (grok-build.js),
//  - the sidebar's "Antigravity · your account" engine: the user's own Antigravity CLI, `agy` (antigravity.js),
//  - the "Using: <page>" setting.
// automation.js, claude-code.js and grok-build.js load only when first needed.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { exists, lookup: which, validModel } = require('../ai/cli-utils');
const launcher = require('../automation/launcher');
// `electron` is only there in the main process; units.js loads this file in plain Node.
const webContents = { getAllWebContents: () => require('electron').webContents.getAllWebContents() };

const APP_DIR = path.join(__dirname, '..', '..'); // the app's root: package.json and the mcp.js agents are given
const DEFAULT_AUTOMATION_PORT = 9222;
const validPort = (port) => (Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_AUTOMATION_PORT);

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
  // The picked or connected models changed: main tells every window, chat page, Settings and new-tab page (deps.modelsChanged).
  const modelsChanged = () => (deps.modelsChanged ? deps.modelsChanged() : ui()?.send('models-updated'));

  // ---------- MCP ----------

  let mcpServer = null;
  // Sessions opened by the sidebar's own Claude Code engine (event.engine) are not "external agents".
  // The steps, the "driven by" pill and the approval cards go to the window the user is in, not to the agent's own window.
  const mcpEvent = (event) => { if (!event.engine) (deps.userUi?.() || ui())?.send('mcp:event', event); };
  // Off until the user turns it on (Settings, or an "Add to <agent>" button): nothing outside Lumen
  // can drive the browser by default. Lumen's own engines (ownsSession) work either way.
  const mcpEnabled = () => readSettings().mcpEnabled === true;
  // Settings → AI → "Agents in their own window don't ask" (on by default): an outside agent's calls in its own Lumen window run
  // without approval cards (agent.js autoAllows); AI-off sites, kept-off tabs and hands-off mode still apply. Off: every new site asks.
  const agentsNoAsk = () => readSettings().agentsNoAsk !== false;

  // Engines made for background tasks, one per run (backgroundEngine below): never the sidebar's own, so
  // each has its own `active` run (and its own MCP tag), and can run beside a sidebar chat.
  const bgEngines = new Set();
  // [parallel CLI chats] Sidebar chats on the same CLI engine run side by side. The sidebar's own engine (kept process,
  // pre-warm) goes to one chat at a time (leased); another chat that wants that engine meanwhile gets an engine of its
  // own for that message (sideEngines: own process, own MCP tag and token, own `active` run), freed when the message
  // ends (leaseEngine's release). Every tool call finds its run by the tag of the connection it came in on, never by a
  // shared pin: the run's `active` carries its own task scope (tab, approvals, signal).
  const sideEngines = new Set();
  const leased = new Set(); // the sidebar's shared engines now lent to a message
  // Tests run the CLIs as a fake process (test/fixtures/fake-cli.js): its `spawn` stands in for both engines'.
  const cliSpawn = () => (require('../test-mode').isTest() && process.env.LUMEN_TEST_CLI_SPAWN ? require(process.env.LUMEN_TEST_CLI_SPAWN).spawn : undefined);
  // The fake CLI (test/fixtures/fake-cli.js) speaks only the stdio bridge and reads one message to
  // the end of stdin: under it Claude Code runs one process per message over the bridge, as before.
  const oneShotClaude = () => Boolean(cliSpawn());

  // ---------- Claude Code engine (created on first use) ----------
  // Its MCP connection is Lumen's local HTTP server (startHttpGate, as Grok's), with a token per CLI
  // process, else the stdio bridge; the sidebar's CLI stays running between a chat's messages.

  let claudeCode = null;
  let claudeCodeFound = false;
  let claudeCodeSignedIn = 'unknown'; // true | false | 'unknown' — mirrors claudeCode.status().signedIn
  let claudeCodeDetail = null; // subscription label (e.g. 'enterprise'), when known
  const claudeCodeModule = () => require('../ai/claude-code');
  const newClaudeCode = (extra = {}) => new (claudeCodeModule().ClaudeCodeEngine)({
    userData: app.getPath('userData'), mcpCommand, ensureServer: () => startMcp(true), gate: oneShotClaude() ? null : startHttpGate, keepAlive: !oneShotClaude(), spawn: cliSpawn(), onFresh: freshReads, ...extra,
  });
  // A new CLI process or session: the model no longer has its earlier page reads, so "unchanged since your
  // last read" would point at nothing (snapshot.js ReadCache); the cache is keyed by the new session too.
  function freshReads({ sessionId } = {}) { try { require('../ai/snapshot').reads.reset(sessionId); } catch {} }
  const claudeCodeEngine = () => {
    claudeCode ||= newClaudeCode();
    return claudeCode;
  };
  // [warm per chat] Each tab chat's own Claude Code engine, whose process stays warm between that chat's messages
  // (features/warm-chats.js): its own process and MCP token. Freed on chat delete / last tab closed (chatGone), after
  // the idle time (deps.warmIdleMs: Settings > AI, the same choice as a kept Grok Build's, Infinity for never; else
  // claude-code.js IDLE_MS; the engine's own idle timeout is the same), past the idle cap (Performance mode: fewer
  // on a slow PC; the least recently used idle one goes), and on quit. Active runs are never capped.
  const ccIdleMs = () => { let ms = null; try { ms = deps.warmIdleMs?.(); } catch {} return ms === Infinity || (Number.isFinite(ms) && ms > 0) ? ms : claudeCodeModule().IDLE_MS; };
  const warmChats = require('./warm-chats').createWarmChats({
    make: () => newClaudeCode({ idleMs: ccIdleMs() }),
    maxIdle: () => { try { const n = deps.maxWarmChats?.(); return Number.isFinite(n) && n >= 0 ? n : 4; } catch { return 4; } },
    idleMs: ccIdleMs,
  });
  // A chat's engine borrows what the sidebar's engine already looked up (the binary, the sign-in check).
  const chatClaudeCode = (engine) => {
    const shared = claudeCodeEngine();
    if (engine.bin === undefined && shared.bin !== undefined) engine.bin = shared.bin;
    if (!engine.statusCache || (shared.statusCache && shared.statusCache.at > engine.statusCache.at)) engine.statusCache = shared.statusCache;
    return engine;
  };
  // A chat switched, cleared or rewound (agent.js): the sidebar's idle Claude Code process ends. (the read cache too: the
  // chat's CLI session is gone.) [warm per chat] A chat's own warm process stays when the user only switches away; on a
  // rewind (its session is dropped) it goes.
  agent.onEngineReset = (why) => {
    freshReads();
    claudeCode?.release();
    if (why === 'rewind') warmChats.releaseIdle(agent.chatKey?.(agent.messages));
  };
  // The composer was focused or typed in (renderer/chat-core.js): Claude Code's process starts ahead of the
  // message (agent.prewarm: a no-op for any other engine, and cheap when repeated).
  // text: what is already typed (routed for the model guess); the preload passes it through.
  // (Also Grok Build's setup when its warm-up is on and it is the chosen model: this is what lets the setting
  // take effect without a restart. Cheap when repeated.)
  // (And, with Keep Grok Build connected on, the chat's own Grok Build process: warmGrokChat.)
  ipcMain.on('agent:prewarm', (_e, text) => { try { agent.prewarm(text); } catch {} try { grokWarmup?.warm(); } catch {} try { warmGrokChat(); } catch {} try { warmCodexChat(); } catch {} });
  // Every Claude Code engine: the sidebar's, each chat's own, the background and side ones.
  const ccEngines = () => [claudeCode, codex, ...warmChats.engines(), ...bgEngines, ...sideEngines].filter((e) => e && typeof e.purgeDirs === 'function');
  app.on?.('will-quit', () => {
    const engines = ccEngines(); // (before disposeAll forgets the chats' engines)
    claudeCode?.dispose(); codex?.dispose(); warmChats.disposeAll(); for (const e of [...bgEngines, ...sideEngines]) e.dispose?.(); grokBuild?.keepWarm?.disposeAll({ now: true }); codex?.keepWarm?.disposeAll({ now: true });
    for (const e of engines) { try { e.purgeDirs(); } catch {} } // their temp folders (each holds an MCP token) go before the app does
  });
  // Folders (lumen-cc-*) that a crash or a forced quit left behind, a day old or more: swept once, well after start-up.
  if (!process.env.CLAUDE_BROWSER_PROFILE) {
    const sweep = setTimeout(() => {
      const live = new Set(); for (const e of ccEngines()) for (const d of e.workDirs || []) live.add(d);
      require('../ai/temp-dirs').sweepStale({ live }).catch(() => {});
    }, 45000);
    sweep.unref?.();
  }

  // ---------- Grok Build engine (created on first use) ----------
  // Runs grok with Lumen's own GROK_HOME, whose config has only the `lumen` MCP server (see
  // grok-build.js's file header); only the user's sign-in is shared with their ~/.grok.

  let grokBuild = null;
  let grokBuildFound = false;
  let grokBuildSignedIn = 'unknown'; // true | false | 'unknown' — mirrors grokBuild.status().signedIn
  let grokBuildDetail = null; // the default model sidebar runs get (asked in Lumen's GROK_HOME), when known
  let grokBuildModels = []; // the model ids `grok models` lists, when known
  const grokBuildModule = () => require('../ai/grok-build');
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
      grokBuild = new GrokBuildEngine({ userData: app.getPath('userData'), gate: startGrokGate, spawn: cliSpawn(), onFresh: freshReads });
      // [keep connected] Settings > AI > Keep Grok Build connected (grokKeepConnected, off by default): each chat's own
      // long-lived `grok agent stdio` process (features/grok-warm.js). Read live: turning it off ends them at the next look.
      grokBuild.keepWarm = require('./grok-warm').createGrokWarm({
        engine: grokBuild,
        enabled: grokKeepOn,
        idleMs: () => { const m = Number(readSettings().grokKeepIdleMinutes); return Number.isFinite(m) && m >= 0 ? m * 60000 : 15 * 60000; },
      });
    }
    return grokBuild;
  };
  const grokKeepOn = () => readSettings().grokKeepConnected === true && grokSidebar();
  // The open chat's Grok Build process, started ahead of its message (composer focus, startup): only with the setting on,
  // Grok Build found, and the chat on Grok Build (agent.grokWarmSpec). With the setting off, any kept process ends.
  function warmGrokChat() {
    if (!grokBuild?.keepWarm && !grokKeepOn()) return;
    if (!grokKeepOn()) { grokBuild.keepWarm.disposeAll(); return; }
    if (!grokBuildFound) return;
    const spec = agent.grokWarmSpec?.();
    if (spec) grokBuildEngine().keepWarm.prewarm(spec);
  }

  // "Warm up Grok Build when Lumen starts" (grokWarmup, default on; features/grok-warmup.js): the setup a message
  // starts with (binary, HTTP gate, config, sign-in link) is done in the background once the first tab has loaded
  // and Lumen has looked for the CLIs. Only for someone who uses Grok Build (connected it, or picked it), and
  // read live, so the toggle needs no restart.
  const grokInUse = () => grokSidebar() || String(readSettings().model || '').startsWith('grokbuild:');
  const grokWarmup = require('./grok-warmup').createGrokWarmup({
    enabled: () => readSettings().grokWarmup !== false && grokInUse(),
    engine: grokBuildEngine,
    found: () => grokBuildFound,
    powerMonitor: { on: (ev, cb) => { try { require('electron').powerMonitor.on(ev, cb); } catch { /* not ready / tests */ } } },
  });

  // ---------- Antigravity engine (created on first use) ----------
  // Runs agy with Lumen's own home folder, whose .gemini/ names only the `lumen` MCP server and the permission rules for this
  // run (see antigravity.js's file header). Replaces the Gemini CLI as the sidebar's Google engine.

  let antigravity = null;
  let antigravityFound = false;
  let antigravitySignedIn = 'unknown'; // true | false | 'unknown' — mirrors antigravity.status().signedIn
  let antigravityModels = []; // the slugs `agy models` lists, when known
  let antigravityNames = {}; // and their display names ("Gemini 3.1 Pro (High)")
  const antigravityModule = () => require('../ai/antigravity');
  // Offered in the sidebar once the user has chosen it (the setup card, Settings → AI), or with LUMEN_AGY_SIDEBAR=1.
  const antigravitySidebar = () => process.env.LUMEN_AGY_SIDEBAR === '1' || (process.env.LUMEN_AGY_SIDEBAR !== '0' && readSettings().antigravitySidebar === true);
  // [parallel Antigravity chats] Each chat runs agy in a home folder of its own (antigravity.js chatHomeFor), so a message's
  // own engine (leaseEngine) can run beside the sidebar's with its own MCP token file, and the chat still resumes there.
  const newAntigravity = () => new (antigravityModule().AntigravityEngine)({ userData: app.getPath('userData'), gate: startGrokGate, bridge: mcpCommand, ensureServer: () => startMcp(true), spawn: cliSpawn(), onFresh: freshReads });
  const antigravityEngine = () => {
    antigravity ||= newAntigravity();
    return antigravity;
  };

  // ---------- Codex engine (created on first use) ----------
  // Runs `codex exec` with a Codex home of Lumen's own per chat, whose config.toml names only the `lumen` MCP server (this run's URL; its
  // token goes by environment variable): see codex.js's file header. "Add to Codex CLI" (codex-connect.js) is the other direction,
  // Codex driving Lumen from a terminal; this one is Lumen using the user's Codex sign-in to answer in the sidebar.
  let codex = null;
  let codexFound = false;
  let codexSignedIn = 'unknown'; // true | false | 'unknown' — mirrors codex.status().signedIn
  let codexModels = []; // [{ id, name, tier }]: the account's cached list, else the documented ids
  const codexModule = () => require('../ai/codex');
  // Offered in the sidebar once Codex is found and signed in, unless the user turned it off (Settings > AI), or LUMEN_CODEX_SIDEBAR=0/1.
  const codexSidebar = () => process.env.LUMEN_CODEX_SIDEBAR === '1' || (process.env.LUMEN_CODEX_SIDEBAR !== '0' && readSettings().codexSidebar !== false);
  const newCodex = () => new (codexModule().CodexEngine)({ userData: app.getPath('userData'), gate: startGrokGate, locate: (refresh) => (deps.codexLocate ? deps.codexLocate() : codexConnect.find(Boolean(refresh))), bridge: mcpCommand, ensureServer: () => startMcp(true), spawn: cliSpawn(), onFresh: freshReads });
  const codexEngine = () => {
    if (!codex) {
      codex = newCodex();
      // [keep connected] Settings > AI > Keep Codex connected (codexKeepConnected, on by default): each chat's own long-lived
      // `codex app-server` process (features/codex-warm.js), idle time as for a kept Grok Build. Read live: turning it off ends them.
      codex.keepWarm = require('./codex-warm').createCodexWarm({
        engine: codex,
        enabled: codexKeepOn,
        idleMs: () => { const m = Number(readSettings().grokKeepIdleMinutes); return Number.isFinite(m) && m >= 0 ? m * 60000 : 15 * 60000; },
      });
    }
    return codex;
  };
  const codexKeepOn = () => process.env.LUMEN_CODEX_WARM !== '0' && readSettings().codexKeepConnected !== false && codexSidebar();
  // The open chat's Codex process, started ahead of its message (composer focus, startup): only with the setting on, Codex found,
  // and the chat on Codex (agent.codexWarmSpec). With the setting off, any kept process ends.
  function warmCodexChat() {
    if (!codex?.keepWarm && !codexKeepOn()) return;
    if (!codexKeepOn()) { codex.keepWarm.disposeAll(); return; }
    if (!codexFound) return;
    const spec = agent.codexWarmSpec?.();
    if (spec) codexEngine().keepWarm.prewarm(spec);
  }

  // Grok's PreToolUse hook (mcp-http.js terminalDecision) asks this before letting a
  // run_terminal_command call through: the same approval card as an MCP tool's (renderer/app.js
  // showToolApproval, action 'terminal'), on the chat the command came from. 'deny' if that chat's
  // run already ended (a stray call after Lumen's timeout, or a mismatched tag) or was stopped.
  async function onTerminalApproval(tag, command) {
    const owner = grokBuild?.owns(tag) ? grokBuild : grokBuild?.keepWarm?.owner(tag) || [...sideEngines, ...bgEngines].find((e) => e.kind === 'grokbuild' && e.owns(tag)); // (a kept Grok process: its own turn)
    const engineRun = owner ? owner.active : null;
    if (!engineRun || owner.background) return 'deny'; // a background task's Grok never gets a terminal (nobody could answer)
    let args = String(command || '');
    if (args.length > 4000) args = `${args.slice(0, 4000)}\n…`;
    owner.callBegin?.(engineRun); // the card can wait on the user: the inactivity watchdog waits too
    let answer = false;
    try {
      answer = await agent.askApproval('run_terminal_command', engineRun.emit, engineRun.signal, {
        action: 'terminal',
        title: 'Grok wants to run a terminal command',
        args,
      });
      return answer === 'always' ? 'always' : answer ? 'once' : 'deny';
    } catch {
      return 'deny'; // the user hit Stop while the card was up
    } finally {
      // An allowed command may run silently for a long time, so the watchdog stays off for the rest of this run.
      if (!answer) owner.callEnd?.(engineRun);
    }
  }

  // Lumen's local HTTP MCP server (mcp-http.js): Grok's tools and gate, and Claude Code's tools.
  // Only Lumen's own live engine runs are served (a token per run or CLI process).
  let grokGate = null;
  function startGrokGate() {
    grokGate ||= require('../automation/mcp-http').startHttp({ tools: deps.tools, callTool: mcpCallTool, enabled: ownsSession, onEvent: mcpEvent, onTerminalApproval })
      .catch((err) => { grokGate = null; throw err; });
    return grokGate;
  }
  const startHttpGate = startGrokGate;

  // Which engine (if any) a bridge's LUMEN_ENGINE tag belongs to.
  const testEngine = () => (require('../test-mode').isTest() ? global.__fakeEngine : null); // tests stand in for an engine's run
  const engineForSession = (session) => (testEngine()?.owns(session?.engine) ? testEngine() : claudeCode?.owns(session?.engine) ? claudeCode : grokBuild?.owns(session?.engine) ? grokBuild : antigravity?.owns(session?.engine) ? antigravity : codex?.owns(session?.engine) ? codex : codex?.keepWarm?.owner(session?.engine) || warmChats.owner(session?.engine) || grokBuild?.keepWarm?.owner(session?.engine) || [...sideEngines, ...bgEngines].find((e) => e.owns(session?.engine)) || null);
  const ownsSession = (session) => Boolean(engineForSession(session));
  // An engine for one sidebar message of `kind`: { engine, release } (agent.js engineFor). The shared one when no other
  // message holds it, else a side engine made for this message (Antigravity too: each chat runs in a home folder of its
  // own, so its MCP token file is never another chat's).
  // release() frees everything the message held: a side engine's process (and with it its MCP token) is ended.
  // [warm per chat] key: the message's tab chat (agent.js engineFor). Claude Code then uses that chat's own engine, kept
  // warm between its messages (warmChats); without a key (or under the one-shot test CLI) it is leased as above.
  function leaseEngine(kind, key = null) {
    if (kind === 'claudecode' && key != null && !oneShotClaude()) {
      const lease = warmChats.lease(key);
      chatClaudeCode(lease.engine);
      return lease;
    }
    const shared = kind === 'claudecode' ? claudeCodeEngine() : kind === 'grokbuild' ? grokBuildEngine() : kind === 'antigravity' ? antigravityEngine() : kind === 'codex' ? codexEngine() : null;
    if (!shared) return null;
    let done = false;
    if (!leased.has(shared)) {
      leased.add(shared);
      return { engine: shared, shared: true, release: () => { if (!done) { done = true; leased.delete(shared); } } };
    }
    const engine = kind === 'claudecode'
      ? newClaudeCode({ keepAlive: false }) // one message, then its process ends
      : kind === 'antigravity'
      ? newAntigravity() // the chat's own home folder: its conversation resumes there
      : kind === 'codex'
      ? newCodex() // the chat's own Codex home folder: its thread resumes there
      : new (grokBuildModule().GrokBuildEngine)({ userData: app.getPath('userData'), gate: startGrokGate, spawn: cliSpawn(), onFresh: freshReads }); // the sidebar's GROK_HOME: the chat's session resumes there
    engine.bin = shared.bin;
    engine.statusCache = shared.statusCache;
    // [keep connected] likewise a Codex message's own engine: the same kept processes, one per chat.
    if (kind === 'codex') engine.keepWarm = shared.keepWarm;
    // [keep connected] A Grok Build message's own engine uses the same kept processes (one per chat, keyed by its Grok
    // session): each its own tag, token and turn, so chats on Grok Build run side by side through them too.
    if (kind === 'grokbuild') engine.keepWarm = shared.keepWarm;
    sideEngines.add(engine);
    return {
      engine,
      shared: false,
      release: () => {
        if (done) return;
        done = true;
        sideEngines.delete(engine);
        try { engine.dispose?.(); } catch { /* already gone */ }
      },
    };
  }
  agent.engines = { get claudecode() { return claudeCodeEngine(); }, get grokbuild() { return grokBuildEngine(); }, get antigravity() { return antigravityEngine(); }, get codex() { return codexEngine(); }, lease: leaseEngine, leased: (kind) => [...leased].some((e) => e.kind === kind), sideCount: () => sideEngines.size,
    // [warm per chat] The chat's own engine outside a message (agent.js prewarm), and whether a message of that chat holds it.
    warmFor: (kind, key) => (kind === 'claudecode' && key != null && !oneShotClaude() ? chatClaudeCode(warmChats.peek(key)) : null),
    warmed: () => warmChats.warmed(),
    busyFor: (kind, key) => kind === 'claudecode' && key != null && warmChats.busy(key),
    warmChats };
  if (require('../test-mode').isTest()) {
    Object.defineProperty(global, '__claudeCode', { get: claudeCodeEngine, configurable: true });
    global.__mcpCallTool = (name, args, session) => mcpCallTool(name, args, session);
    global.__bgEngineCount = () => bgEngines.size;
  }

  // Runs one browser tool for an external agent, with the same per-site approval as the sidebar,
  // and shows each call as a step in the sidebar.
  const LABEL_FIRST = new Set(['click', 'type_text', 'fill_form', 'press_key']); // their labels are read from the page before the action runs
  const LABEL_WAIT_MS = 150;
  const OUTSIDE_LABEL_WAIT_MS = 1500; // outside agents (no early row): the label goes in the first event, for up to this long
  async function mcpCallTool(name, args, session) {
    session.approvedHosts ||= new Set();
    // A call from the sidebar's own Claude Code or Grok Build run shows as a step of that reply and
    // uses the chat's approvals; anything else is an external agent.
    const owner = engineForSession(session);
    const engineRun = owner ? owner.active : null;
    // A kept Claude Code process between messages owns its session, but no message is running to act for.
    if (owner && !engineRun) return { content: [{ type: 'text', text: 'No message is in progress in Lumen for this call.' }], isError: true };
    // Claude Code may already show this call's row, from while its input was still streaming (claude-code.js claimStep).
    // Claimed before anything can refuse the call: the rows are matched to calls first-in-first-out, and a
    // refused call must not leave its early row spinning.
    const early = engineRun ? owner.claimStep?.(name) || null : null;
    const refuse = (text) => {
      if (early) engineRun.emit({ type: 'tool_done', id: early, ok: false, error: text });
      return { content: [{ type: 'text', text }], isError: true };
    };
    // read_page with no mode gives an MCP client the compact outline (about a third of a full read's size), as the sidebar's models
    // are told to start with; "full" and extract stay one argument away.
    if (name === 'read_page' && !args.mode && !args.extract && !args.since_last && !args.elements && !args.text_offset && !args.element_offset) args = { ...args, mode: 'compact' };
    const problem = deps.validateToolInput(name, args);
    if (problem) return refuse(`Invalid input: ${problem}`);
    // An outside agent works in a window of its own, made on its first call that needs a tab (features/agent-windows.js):
    // its tools see that window's tabs and nothing else, so it cannot touch the user's tabs or the sidebar AI's.
    const windows = !engineRun && !(global.__mcpSharedWindow && require('../test-mode').isTest()) ? deps.agentWindows : null; // (tests can turn it off, to show what sharing the user's window did)
    let agentRec = null;
    if (windows) {
      agentRec = windows.windows.get(session);
      if (!agentRec && !require('./agent-windows').needsWindow(name)) {
        if (name === 'list_tabs') return { content: [{ type: 'text', text: '[]' }], isError: false }; // no window yet: no tabs of its own
      } else if (!agentRec) {
        if (session.controller.signal.aborted) return refuse('The agent session ended.'); // (a call finishing after its bridge went: no window for a session nobody will end)
        try { agentRec = await windows.windows.ensure(session, session.clientName); } catch (err) { return refuse(`Lumen could not open a window for ${session.clientName}: ${err.message}`); }
      }
    }
    const stepId = early || `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    // A background task's CLI run brings its own Agent (work tab, approved sites, taint, approval cards
    // for the Tasks panel): each of its calls runs there, never in the sidebar's Agent or the user's tab.
    const runAgent = engineRun?.agent || agent;
    const toUi = engineRun ? engineRun.emit : mcpEvent;
    const signal = engineRun ? engineRun.signal : session.controller.signal;
    const scope = engineRun && (engineRun.scope || runAgent.engineScope()); // [parallel CLI chats] the run's own scope, carried by its connection
    if (engineRun?.agent && !scope) return refuse('This background task is not running any more.');
    if (engineRun && !scope) return refuse('No message is in progress in Lumen for this call.'); // (never the tab in front: a sidebar run always brings its own scope)
    // `run` carries the "has read page content" taint (agent.ensureAllowed): the engine's message
    // scope for the sidebar's own engine (its chat holds the taint until New chat, and the attached
    // page text counts), the MCP session for an outside agent (every call in the session shares it).
    const allow = engineRun
      ? { hosts: scope?.hosts || runAgent.approvedHosts, who: owner.kind === 'grokbuild' ? 'Grok' : owner.kind === 'antigravity' ? 'Antigravity' : owner.kind === 'codex' ? 'Codex' : 'Claude', input: args, run: scope || engineRun }
      : { hosts: session.approvedHosts, who: session.clientName, external: true, noAsk: Boolean(agentRec) && agentsNoAsk(), input: args, run: session }; // outside agents ask, unless they work in their own window and the setting says not to
    // The step's label is worked out in the same tab the call will act on (a click's label names the
    // element in that tab), not in whichever tab is in front while the user looks elsewhere.
    // An outside agent's own window: the tab in front THERE (not the user's, not the sidebar run's).
    const front = scope ? null : windows ? (agentRec ? windows.activeTabId(agentRec) : null) : agent.browser.activeTab()?.id;
    const inPin = (fn) => (scope ? runAgent.inScope(scope, fn) : agent.inTask(front, signal, fn, null, null, windows ? { rec: agentRec, mcp: true } : null));
    // The row shows at once with its generic label; describeStep's specific one follows as a tool_update
    // (renderer) and never holds the call up. Only a label that reads the page as it is before the call
    // acts (a click or type names its element) is waited for, for at most LABEL_WAIT_MS, then the call goes on.
    // acting: the call's action has begun, so a page-reading label (click/type) arriving now would name the
    // element from the page AFTER the action: it is dropped (a wrong name is worse than the generic one).
    let finished = false;
    let acting = false;
    const labelled = inPin(() => runAgent.describeStep(name, args)).catch(() => null);
    const named = (label) => { if (label && !finished && !(acting && LABEL_FIRST.has(name))) toUi({ type: 'tool_update', id: stepId, name, input: args, label, clientName: session.clientName }); };
    let first = null;
    // An outside agent has no early row to rename later: its first 'tool' event carries the specific label
    // (waited for up to OUTSIDE_LABEL_WAIT_MS); the sidebar's own engine shows its row at once.
    const waitMs = engineRun ? (LABEL_FIRST.has(name) ? LABEL_WAIT_MS : 0) : OUTSIDE_LABEL_WAIT_MS;
    if (waitMs) {
      let timer;
      first = await Promise.race([labelled, new Promise((resolve) => { timer = setTimeout(resolve, waitMs, null); })]);
      clearTimeout(timer);
    }
    // A new row carries the label when it is known by now (else the generic one); an early row is named in place.
    if (!early) toUi({ type: 'tool', id: stepId, name, input: args, label: first, clientName: session.clientName });
    else named(first);
    labelled.then((label) => { if (label !== first) named(label); });
    const emit = (event) => toUi({ ...event, clientName: session.clientName, ...(engineRun ? {} : { quiet: true }) }); // (quiet: an outside agent's approval card never opens the user's sidebar)
    // The sidebar's own engine run keeps working in the tab its message started in (agent.engineScope);
    // an outside agent's call is pinned to the tab in front when it arrives, so the approval card and
    // the action it allows are about the same tab. Stop ends a long wait at once, either way.
    const work = async () => {
      await runAgent.ensureAllowed(name, emit, signal, allow);
      acting = true;
      return abortable(runAgent.execute(name, args), signal);
    };
    // The engine counts this call (a message that ran a tool is never re-sent silently) and pauses its
    // inactivity watchdog while it runs, approval card included (claude-code.js callBegin).
    if (engineRun) owner.callBegin?.(engineRun);
    try {
      const result = await inPin(work);
      toUi({ type: 'tool_done', id: stepId, ok: true });
      return { content: toMcpContent(result), isError: false };
    } catch (err) {
      const message = signal.aborted ? 'Stopped by the user.' : String(err?.message || err);
      toUi({ type: 'tool_done', id: stepId, ok: false, error: message.split('\n')[0] });
      return { content: [{ type: 'text', text: message }], isError: true };
    } finally {
      finished = true; // a label still being worked out is dropped: the row is done
      if (engineRun) owner.callEnd?.(engineRun);
    }
  }

  // Only listens while "Allow AI agents to connect" is on (it is by default); turning it on later
  // starts the server on demand.
  // The sidebar's Claude Code engine starts it too (force), and its own sessions are always allowed.
  function startMcp(force = false) {
    if (mcpServer || (!force && !mcpEnabled())) return;
    mcpServer = require('../automation/mcp').startServer({
      userData: app.getPath('userData'),
      tools: deps.tools,
      callTool: mcpCallTool,
      // A bridge that names a run (LUMEN_ENGINE) is served only while that run is live: a stale or foreign
      // tag is refused, never treated as an outside agent.
      enabled: (session) => (session.engine ? ownsSession(session) : mcpEnabled()),
      onEvent: mcpEvent,
      // An outside agent's own window is made as it lists the tools, so its first navigate does not pay for it (~1 s).
      // Behind the user's window (agent-windows open), only while agents may connect; the sidebar's engines use the user's tabs.
      onListed: (session) => {
        if (session.engine || !mcpEnabled() || session.controller.signal.aborted) return;
        if (global.__mcpSharedWindow && require('../test-mode').isTest()) return;
        deps.agentWindows?.windows.ensure(session, session.clientName).catch(() => {});
      },
      onClose: (session) => { if (!session.engine) deps.agentWindows?.windows.release(session); }, // its window closes after a grace period
    });
  }

  // The command an agent should run: Lumen's own executable in Node mode on mcp.js (clean stdio,
  // no window machinery). Works for the installed app and for development alike.
  function mcpCommand() {
    return { command: process.execPath, args: [path.join(APP_DIR, 'mcp.js')], env: { ELECTRON_RUN_AS_NODE: '1' } };
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
        { id: 'codex', label: 'Codex CLI', hint: 'One click, or run this in a terminal', text: `codex mcp add lumen --env ELECTRON_RUN_AS_NODE=1 -- ${quoted}`, addButton: 'codex', secondary: `Or add a [mcp_servers.lumen] entry to ~/.codex/config.toml.${win ? ' (If Codex was installed with npm and PowerShell swallows the --, run codex.cmd instead of codex.)' : ''}` },
        { id: 'grok', label: 'Grok Build', hint: 'One click, or run this in a terminal (needs SuperGrok or X Premium+)', text: `grok mcp add lumen -e ELECTRON_RUN_AS_NODE=1 -- ${quoted}`, addButton: 'grok', secondary: 'Or add a [mcp_servers.lumen] entry to ~/.grok/config.toml.' },
        // Antigravity (agy) keeps its MCP servers in ~/.gemini/config/mcp_config.json; the one click runs `agy mcp add`, which writes that file.
        { id: 'antigravity', label: 'Antigravity', hint: 'One click, or run this in a terminal (replaces Gemini CLI)', text: `agy mcp add -e ELECTRON_RUN_AS_NODE=1 lumen -- ${quoted}`, addButton: 'antigravity', secondary: 'Or add the JSON of Other MCP clients (below) under mcpServers in ~/.gemini/config/mcp_config.json.' },
        { id: 'json', label: 'Other MCP clients', hint: 'Cursor, Claude Desktop, etc.', text: json },
      ],
    };
  });
  ipcMain.handle('mcp:set-enabled', (_e, on) => {
    writeSettings({ ...readSettings(), mcpEnabled: Boolean(on) });
    if (!on) { mcpServer?.disconnectAll(); deps.agentWindows?.windows.releaseAll(); }
    else startMcp();
    return true;
  });

  // ---------- One-click "Add to <agent>" for Claude Code, Codex CLI, Grok Build and Antigravity ----------
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
    // Codex CLI has its own flow (codex-connect.js): found however it was installed, config.toml entry merged.
    // Google Antigravity's CLI (`agy`), which replaces Gemini CLI: `agy mcp add [flags] <name> <commandOrUrl> [args...]` (flags before the name;
    // checked against agy 1.2.14's own --help). On Windows agy is installed to %LOCALAPPDATA%\agy\bin, which is not on PATH: findAgy looks there.
    antigravity: {
      label: 'Antigravity',
      find: async () => { const bin = await antigravityEngine().detect(true); return bin ? { command: bin, args: [] } : null; },
      installHint: () => `Antigravity isn't installed. ${antigravityModule().INSTALL_HINT}`,
      check: async (run) => { const list = await run(['mcp', 'list']); return { ok: list.ok && /\blumen\b/.test(list.out) }; },
      add: (run, argv) => run(['mcp', 'add', '-e', 'ELECTRON_RUN_AS_NODE=1', 'lumen', '--', ...argv]),
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
    if (id === 'codex') return codexConnect.add();
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
  const codexConnect = require('./codex-connect').createCodexConnect({ ipcMain, readSettings, writeSettings, mcpCommand, connected, isSettingsSender: deps.isSettingsSender, pickFile: deps.pickCodexFile, onStatus: () => { const before = `${codexFound}|${codexSignedIn}`; refreshCodexStatus(false).then(() => { if (before !== `${codexFound}|${codexSignedIn}`) modelsChanged(); }).catch(() => {}); }, seams: require('../test-mode').isTest() ? global.__codexSeams : undefined });
  ipcMain.handle('mcp:add-to-agent', (_e, id) => addToAgent(id));

  // ---------- automation tools over CDP: Playwright / CDP clients see only the user's tabs ----------

  let automationProxy = null;
  function startAutomation() {
    if (!deps.automationPlan) return;
    automationProxy = require('../automation/automation').start({
      ...deps.automationPlan,
      hooks: {
        tabs: deps.userTabs,
        openTab: (url, options = {}) => deps.openTab(deps.isWebUrl(url) || url === 'about:blank' ? url : 'about:blank', { ...options, openedBy: {} }), // [ai manners] a tab an outside agent opens is the AI's to work in (and to close again)
        handsOffVerdict: (method, tabId) => require('./ai-manners').automationVerdict({ method, handsOff: readSettings().aiHandsOff === true, ownTab: Boolean(deps.isAiTab?.(tabId)), offTab: Boolean(deps.tabOff?.(tabId)) }), // [ai manners] hands-off covers this server too; [ai off-tab] a tab the user keeps the AI off refuses everything
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
      if (s.installed) modelsChanged();
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
      if (s.installed) modelsChanged();
      return s;
    });
  }

  // Same shape again, for the Antigravity engine (antigravity.js).
  function refreshAntigravityStatus(refresh) {
    return antigravityEngine().status(refresh).then((s) => {
      antigravityFound = s.installed;
      antigravitySignedIn = s.signedIn;
      antigravityModels = s.models || [];
      antigravityNames = s.names || {};
      if (s.installed) modelsChanged();
      return s;
    });
  }
  // Same shape again, for the Codex engine (codex.js). It shares the binary lookup with "Add to Codex CLI" (codexConnect.find).
  function refreshCodexStatus(refresh) {
    return codexEngine().status(refresh).then((s) => {
      codexFound = s.installed;
      codexSignedIn = s.signedIn;
      codexModels = s.models || [];
      return s;
    });
  }

  // Settings → AI: where Antigravity stands, and the install command for this OS (shown to the user; run only by the click below).
  ipcMain.handle('antigravity:status', async (_e, refresh) => {
    const s = await refreshAntigravityStatus(Boolean(refresh)).catch(() => ({ installed: false, signedIn: false }));
    return { installed: Boolean(s.installed), signedIn: s.signedIn, enabled: antigravitySidebar(), installCommand: antigravityModule().installCommand(), signInHint: antigravityModule().SIGN_IN_HINT };
  });
  // The user clicked "Install" (Settings → AI) after seeing the command: runs Google's official installer for this OS.
  // Only from the settings page; never from a page, an agent or the sidebar.
  let installing = null;
  ipcMain.handle('antigravity:install', async (e) => {
    if (!deps.isSettingsSender?.(e)) throw new Error('Not allowed');
    installing ||= antigravityEngine().install().finally(() => { installing = null; });
    const out = await installing;
    const s = await refreshAntigravityStatus(true).catch(() => ({ installed: false }));
    return { ok: out.ok && Boolean(s.installed), installed: Boolean(s.installed), output: out.output };
  });

  // `<bin> --version` once per binary (a local command: no sign-in, no model). The first dotted number in what it prints.
  const versions = new Map();
  function binVersion(bin) {
    if (!bin) return Promise.resolve(null);
    if (!versions.has(bin)) {
      versions.set(bin, new Promise((resolve) => {
        try {
          execFile(bin, ['--version'], { shell: false, windowsHide: true, timeout: 8000, cwd: os.homedir() }, (err, stdout) => resolve(err ? null : (/(\d+\.\d+\.\d+[\w.+-]*)/.exec(String(stdout)) || [])[1] || null));
        } catch { resolve(null); }
      }).then((v) => { if (!v) versions.delete(bin); return v; })); // (a failure is tried again next time)
    }
    return versions.get(bin);
  }
  const claudePlan = (s) => (s.signedIn !== true ? null : s.accountType === 'apiKey' ? 'API key (billed per token)' : s.detail ? `${String(s.detail).replace(/^./, (c) => c.toUpperCase())} plan` : s.accountType === 'subscription' ? 'Claude subscription' : null);
  async function cliInfo() {
    const safe = (p) => Promise.resolve(p).catch(() => null);
    const [cc, gb, ag, cx] = await Promise.all([safe(claudeCodeEngine().status(false)), safe(grokBuildEngine().status(false)), safe(antigravityEngine().status(false)), safe(codexEngine().status(false))]);
    const s = readSettings();
    const row = (id, name, st, extra) => ({ id, name, installed: Boolean(st?.installed), signedIn: st?.installed ? st.signedIn ?? 'unknown' : false, ...extra });
    const [ccV, gbV, agV] = await Promise.all([binVersion(claudeCodeEngine().bin), binVersion(grokBuildEngine().bin), binVersion(antigravityEngine().bin)]);
    return [
      row('claudecode', 'Claude Code', cc, { path: claudeCodeEngine().bin || null, version: ccV, account: cc ? claudePlan(cc) : null, offered: s.claudeCodeSidebar !== false }),
      row('grokbuild', 'Grok Build', gb, { path: grokBuildEngine().bin || null, version: gbV, account: gb?.account || null, offered: grokSidebar() }),
      row('codex', 'Codex CLI', cx, { path: codexEngine().spec?.path || null, version: cx?.version || null, account: cx?.signedIn === true ? (cx.method === 'chatgpt' ? 'ChatGPT account' : cx.method === 'apikey' ? 'API key' : 'Signed in') : null, offered: codexSidebar() }),
      row('antigravity', 'Antigravity', ag, { path: antigravityEngine().bin || null, version: agV, account: null, offered: antigravitySidebar() }), // agy has no sign-in or account command: the state stays unknown until a message runs
    ];
  }

  // Until the first look for the CLIs has finished, a saved "Claude Code" / "Grok Build" pick is kept
  // as it is (see effectiveModel in main.js) instead of looking like it isn't set up.
  let detecting = true;

  return {
    automationClients: () => automationProxy?.clients() || 0, // [passwords] CDP clients connected now (no filling while one is)
    start({ after = null } = {}) {
      // Always listening (token-authenticated, profile-local), so an agent run while the setting is off
      // gets "turned off in Lumen settings" instead of its bridge deciding Lumen isn't running and
      // trying to launch it. Sessions are refused while it's off (enabled() below).
      startMcp(true);
      startAutomation();
      // Looking for the CLIs (several processes, and loading claude-code.js/grok-build.js) waits until the first tab
      // has loaded, not while it does.
      const look = () => {
        // (Grok Build is looked for even while it's off in the sidebar: the setup card offers it once it's found.)
        Promise.allSettled([refreshClaudeCodeStatus(false), refreshGrokBuildStatus(false), refreshAntigravityStatus(false), codexConnect.status(false).then(() => refreshCodexStatus(false))])
          .then(() => { detecting = false; modelsChanged(); grokWarmup.afterLook(); try { warmGrokChat(); } catch {} try { warmCodexChat(); } catch {} });
        grokWarmup.watchResume();
      };
      if (after) after.then(() => setTimeout(look, 300)); else setTimeout(look, 2500);
    },
    // Is a local engine pick ('claudecode:…' / 'grokbuild:…') still being looked for?
    engineDetecting: (id) => detecting && /^(claudecode|grokbuild|antigravity|codex):/.test(String(id)),
    mcpServer: () => mcpServer,
    // [warm per chat] A chat was deleted, or its last tab closed: its own warm Claude Code process (and MCP token) ends,
    // now or when its message in flight ends.
    chatGone: (chatId) => { if (chatId != null) { warmChats.drop(String(chatId)); try { codex?.keepWarm?.dropChat(chatId); } catch {} } },
    // [keep connected] A chat left Lumen's tabs or was deleted: its kept Grok Build process ends. sessionOf() is asked only
    // when a process is kept (it may read the chat from disk).
    grokChatGone(sessionOf) {
      if (!grokBuild?.keepWarm?.count()) return;
      try { grokBuild.keepWarm.drop(sessionOf()); } catch {}
    },
    // The setup card's "Use your own Grok Build": on in the sidebar, looked for again (just installed or signed in).
    async useGrokBuild() {
      if (readSettings().grokSidebar !== true) writeSettings({ ...readSettings(), grokSidebar: true });
      const s = await refreshGrokBuildStatus(true).catch(() => ({ installed: false, signedIn: false }));
      modelsChanged();
      return { installed: Boolean(s.installed), signedIn: s.signedIn !== false };
    },
    // The setup card's "Use your own Antigravity": on in the sidebar, looked for again (just installed or signed in).
    async useAntigravity() {
      if (readSettings().antigravitySidebar !== true) writeSettings({ ...readSettings(), antigravitySidebar: true });
      const s = await refreshAntigravityStatus(true).catch(() => ({ installed: false, signedIn: false }));
      modelsChanged();
      return { installed: Boolean(s.installed), signedIn: s.signedIn !== false };
    },
    // The setup card's "Use your own Codex": on in the sidebar, looked for again (just installed or signed in).
    async useCodex() {
      if (readSettings().codexSidebar === false) writeSettings({ ...readSettings(), codexSidebar: true });
      await codexConnect.status(true).catch(() => null);
      const s = await refreshCodexStatus(true).catch(() => ({ installed: false, signedIn: false }));
      modelsChanged();
      return { installed: Boolean(s.installed), signedIn: s.signedIn !== false };
    },
    // Settings → AI → AI providers: one row of facts per CLI, the same layout for each: installed, where, which version, signed in as
    // what, offered in the menu. Only local, free commands (`--version`, the status checks the engines already cache for 30 s).
    cliInfo,
    // Are the local CLIs there, and signed in (background tasks list them, or say why not).
    cliStatus: () => ({
      claudecode: { installed: claudeCodeFound, signedIn: claudeCodeSignedIn },
      grokbuild: { installed: grokBuildFound, signedIn: grokBuildSignedIn, enabled: grokSidebar() },
      antigravity: { installed: antigravityFound, signedIn: antigravitySignedIn, enabled: antigravitySidebar() }, // (sidebar chats only: not offered to background tasks)
      codex: { installed: codexFound || codexConnect.state().installed, signedIn: codexSignedIn, enabled: codexSidebar() }, // (sidebar chats only: not offered to background tasks)
    }),
    // A fresh engine for one background run: { engine, release }. It shares nothing live with the
    // sidebar's engine (its own child, MCP tag and `active` run; Grok also its own GROK_HOME and folder,
    // both removed by release()), only the CLI's location and the user's sign-in.
    async backgroundEngine(kind) {
      const userData = app.getPath('userData');
      if (kind === 'claudecode') {
        const engine = newClaudeCode({ keepAlive: false }); // one message, then its process ends
        engine.bin = await claudeCodeEngine().detect();
        bgEngines.add(engine);
        return { engine, release: () => { engine.release(); bgEngines.delete(engine); } };
      }
      if (kind === 'grokbuild') {
        const root = path.join(userData, 'grok-bg', crypto.randomBytes(6).toString('hex'));
        const engine = new (grokBuildModule().GrokBuildEngine)({ userData, gate: startGrokGate, background: true, home: path.join(root, 'home'), dir: path.join(root, 'dir'), spawn: cliSpawn() });
        engine.bin = await grokBuildEngine().detect();
        bgEngines.add(engine);
        return { engine, release: () => { bgEngines.delete(engine); fs.rm(root, { recursive: true, force: true }, () => {}); } };
      }
      return null;
    },
    // Local agent engines, once each CLI has been found. Listed even when not signed in
    // (signedIn: false) so the setup card can steer the user to sign in instead of the option just
    // silently failing on the first message. Alphabetical, after modelOptions() sorts everything
    // else: Claude Code before Grok Build, same as any other equally-treated pair of entries.
    modelOptions: () => [
      ...(claudeCodeFound && readSettings().claudeCodeSidebar !== false ? claudeCodeOptions({ signedIn: claudeCodeSignedIn, accountDetail: claudeCodeDetail }) : []),
      ...(grokSidebar() && grokBuildFound ? grokBuildOptions({ signedIn: grokBuildSignedIn, accountDetail: grokBuildDetail, models: grokBuildModels, saved: readSettings().model }) : []),
      ...(codexSidebar() && codexFound ? codexOptions({ signedIn: codexSignedIn, models: codexModels, saved: readSettings().model }) : []),
      ...(antigravitySidebar() && antigravityFound ? antigravityOptions({ signedIn: antigravitySignedIn, models: antigravityModels, names: antigravityNames, saved: readSettings().model }) : []),
    ],
  };
}

// The picker entries for the user's own Claude Code CLI, one per choice in claude-code.js's MODELS.
// The CLI's own default comes first and keeps its id and plain "Claude Code" label, so a saved
// 'claudecode:default' pick (and its replies' labels) stay as they were before there was a choice.
function claudeCodeOptions({ signedIn = 'unknown', accountDetail = null } = {}) {
  return require('../ai/claude-code').MODELS.map((m) => ({
    id: `claudecode:${m.id}`,
    label: m.id === 'default' ? 'Claude Code' : `Claude Code · ${m.label}`,
    name: m.id === 'default' ? 'Claude Code' : m.label, // the picker's row, under its "Your Claude account" heading
    provider: 'Claude Code', // the picker button's tag
    badges: signedIn === false ? ['sign in'] : [],
    detail: signedIn === false
      ? 'Not signed in: open a terminal, run claude, then type /login'
      : m.id === 'default' ? 'Lumen picks Haiku, Sonnet or Opus for each message (Settings → AI: Pick the Claude Code model for me), else the model set in Claude Code' : '', // the heading says Claude Code; the name says which model
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
    name: model === 'default' ? 'Grok Build' : require('./model-names').prettyModel(model) || model,
    provider: 'Grok Build',
    badges: [...(signedIn === false ? ['sign in'] : []), ...(model === 'default' ? ['experimental'] : [])], // once, on the group's first row
    detail: signedIn === false
      ? 'Not signed in: open a terminal, run grok, then run grok login'
      : model === 'default' ? `Grok’s default model${accountDetail ? ` (${accountDetail})` : ''}. ${note.charAt(0).toUpperCase()}${note.slice(1)}` : '', // the note once, on the group's first row
    group: 'Your Grok account',
    signedIn,
    accountDetail,
  }));
}

// The picker entries for the user's own Antigravity CLI (agy, which replaces Gemini CLI): its default, then each model `agy models`
// lists. A saved pick the CLI didn't list this time stays offered, as for Grok Build.
function antigravityOptions({ signedIn = 'unknown', models = [], names = {}, saved = null } = {}) {
  const list = models.filter((m) => m !== 'default' && validModel(m));
  const pick = /^antigravity:(.+)$/.exec(String(saved || ''))?.[1];
  if (pick && pick !== 'default' && validModel(pick) && !list.includes(pick)) list.push(pick);
  const note = 'experimental: only Lumen’s browser tools are allowed';
  return ['default', ...list].map((model) => ({
    id: `antigravity:${model}`,
    label: model === 'default' ? 'Antigravity (experimental)' : `Antigravity · ${model} (experimental)`,
    name: model === 'default' ? 'Antigravity' : names[model] || require('./model-names').prettyModel(model) || model,
    provider: 'Antigravity',
    badges: [...(signedIn === false ? ['sign in'] : []), ...(model === 'default' ? ['experimental'] : [])],
    detail: signedIn === false
      ? 'Not signed in: open a terminal, run agy, and sign in with your Google account'
      : model === 'default' ? `Antigravity’s default model. ${note.charAt(0).toUpperCase()}${note.slice(1)}` : '',
    group: 'Your Google account',
    signedIn,
    accountDetail: null,
  }));
}

// The picker entries for the user's own Codex CLI: its default (no -m: Codex's own choice for the account), then each model it lists.
// Each carries a tier (fast / balanced / strong) for Auto. A saved pick Codex didn't list this time stays offered, as for Grok Build.
function codexOptions({ signedIn = 'unknown', models = [], saved = null } = {}) {
  const list = models.filter((m) => m && m.id && m.id !== 'default' && validModel(m.id));
  const pick = /^codex:(.+)$/.exec(String(saved || ''))?.[1];
  if (pick && pick !== 'default' && validModel(pick) && !list.some((m) => m.id === pick)) list.push({ id: pick, name: require('../ai/codex').pretty(pick), tier: require('../ai/codex').tierFor(pick) });
  const note = 'experimental: only Lumen’s browser tools are allowed (no shell, no file writes)';
  return [{ id: 'default', name: 'Codex', tier: 'balanced' }, ...list].map((m) => ({
    id: `codex:${m.id}`,
    label: m.id === 'default' ? 'Codex (experimental)' : `Codex · ${m.name} (experimental)`,
    name: m.id === 'default' ? 'Codex' : m.name,
    provider: 'Codex',
    tier: m.tier,
    badges: [...(signedIn === false ? ['sign in'] : []), ...(m.id === 'default' ? ['experimental'] : [])],
    detail: signedIn === false
      ? 'Not signed in: open a terminal, run codex login'
      : m.id === 'default' ? `Codex’s default model for your account. ${note.charAt(0).toUpperCase()}${note.slice(1)}` : '',
    group: 'Your OpenAI account',
    signedIn,
    accountDetail: null,
  }));
}

module.exports = { setupAiAgents, prepareAutomation, inProcessAutomation, validPort, DEFAULT_AUTOMATION_PORT, claudeCodeOptions, grokBuildOptions, antigravityOptions, codexOptions };
