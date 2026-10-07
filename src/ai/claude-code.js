// "Claude · your account (Claude Code)": the sidebar engine that runs the user's own `claude` CLI
// headless for each message and lets it drive Lumen through Lumen's MCP server.
//
// Lumen never sees claude.ai credentials: the CLI uses its own login. The CLI is spawned with an
// argv array and shell:false (the message goes in on stdin), so user text never reaches a shell.
// It gets only Lumen's tools: built-in tools are disabled (--tools ""), only mcp__lumen is allowed,
// and --permission-mode dontAsk refuses anything else instead of prompting. Lumen's own approval
// card still gates acting tools, because every call goes through the MCP server's callTool.
//
// [full access] Settings > AI > "Give Claude Code full access to this computer" (claudeCodeFullAccess,
// off by default) runs the CLI the way it runs in a terminal instead: all its built-in tools (Bash,
// file reads and edits), the user's own MCP servers, skills and slash commands, Claude Code's own
// system prompt (Lumen's is appended), the home folder as its working directory, and no permission
// prompts (bypassPermissions). Lumen's browser tools still go through the MCP server and its approval card.

const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { removeDir, removeDirSync } = require('./temp-dirs');
const { exists, lookup, killTree, validModel, usageOf, perTurnResult } = require('./cli-utils');
const { turnLimitHit } = require('./loop-guard');
const { isSignedOutText } = require('./auth-sync');
const effortLib = require('./effort'); // Settings → AI → AI providers: reasoning effort per AI
const { toolImagePaths } = require('../features/gen-images');

const INSTALL_HINT = process.platform === 'win32'
  ? 'Install it in PowerShell with: irm https://claude.ai/install.ps1 | iex  (or: npm install -g @anthropic-ai/claude-code), then run `claude` once and type /login.'
  : 'Install it with: curl -fsSL https://claude.ai/install.sh | bash  (or: npm install -g @anthropic-ai/claude-code), then run `claude` once and type /login.';

// The real executable. On Windows the npm shim (claude.cmd / claude.ps1) runs
// node_modules/@anthropic-ai/claude-code/bin/claude.exe next to it; spawning the .exe directly
// avoids cmd.exe and PowerShell argument parsing altogether.
async function findClaude() {
  if (process.env.LUMEN_CLAUDE_BIN) return exists(process.env.LUMEN_CLAUDE_BIN) ? process.env.LUMEN_CLAUDE_BIN : null;
  const home = os.homedir();
  if (process.platform === 'win32') {
    for (const hit of await lookup('claude')) {
      if (/\.exe$/i.test(hit) && exists(hit)) return hit;
      const exe = path.join(path.dirname(hit), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (exists(exe)) return exe;
    }
    const native = path.join(home, '.local', 'bin', 'claude.exe');
    return exists(native) ? native : null;
  }
  const [hit] = await lookup('claude');
  if (hit && exists(hit)) return hit;
  // GUI apps on macOS don't inherit the shell's PATH.
  for (const p of [path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    if (exists(p)) return p;
  }
  return null;
}

// A failure that is likely gone in a moment: a spawn that failed (EBUSY / EPERM / EAGAIN while the machine is busy), an
// overloaded or rate-limited API (429 / 5xx / 529), a connection reset, or a CLI that exited at once with nothing to say.
// A plan's usage limit, a sign-in problem and a vanished session are not (they would say the same thing again).
const PERMANENT_FAILURE = /usage limit|limit reached|out of (extra )?usage|quota|credit balance|not logged in|\/login|invalid api key|unauthori[sz]ed|oauth|no conversation found|session.*not found|isn't installed/i;
const TRANSIENT_FAILURE = /overloaded|\b(429|500|502|503|504|529)\b|EBUSY|EPERM|EAGAIN|EMFILE|ENFILE|ETIMEDOUT|ECONNRESET|EPIPE|temporarily unavailable|try again|server error|rate.?limit|at capacity/i;
function transientFailure(text, code) {
  const t = String(text || '').trim();
  if (PERMANENT_FAILURE.test(t)) return false;
  if (code === -1) return true; // the spawn itself failed
  if (TRANSIENT_FAILURE.test(t)) return true;
  return !t && typeof code === 'number' && code !== 0; // exited at once, silent
}

// Turns a CLI failure into what the user should do about it.
function describeFailure(text, code) {
  const t = String(text || '').trim();
  if (isSignedOutText(t, /not logged in|please run \/login|\/login|invalid api key|b401b|token (has )?(expired|been revoked)/i, /oauth|authenticat|credentials/i)) {
    return { text: 'Claude Code is not signed in. Open a terminal, run `claude` once, then type /login. Lumen never sees your Claude login.' };
  }
  if (/usage limit|limit reached|rate.?limit|out of (extra )?usage|resets? (at|in)|quota/i.test(t)) {
    return { text: `Your Claude plan's usage limit is reached. ${t.split('\n')[0].slice(0, 200)}` };
  }
  return { text: `Claude Code stopped${code !== null && code !== undefined ? ` (exit ${code})` : ''}: ${t.split('\n').slice(0, 3).join(' ').slice(0, 300) || 'no output'}` };
}

const ARGS_BASE = [
  '-p',
  '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
  '--input-format', 'stream-json', // JSONL user messages on stdin (image blocks too), one per chat message
  '--tools', '', // no built-in tools: no Bash, no file reads or edits
  '--strict-mcp-config',
  '--allowedTools', 'mcp__lumen',
  '--permission-mode', 'dontAsk',
];
// [full access] The same stream-json session with everything Claude Code has in a terminal, unprompted.
// --mcp-config's `lumen` replaces a user-scope server of that name (checked against the CLI, 2.1.287).
const ARGS_FULL = [
  '-p',
  '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
  '--input-format', 'stream-json',
  '--permission-mode', 'bypassPermissions',
];

const SETTING_SOURCES_PROJECT = ['--setting-sources', 'project'];

// The picker's Claude Code choices (the part after 'claudecode:'). 'default' passes no --model, so
// the CLI's own choice applies (its /model setting, else the plan's default); the rest are the family
// aliases `claude --model` accepts (claude --help, 2.1.283), each following that family's latest model.
const MODELS = [
  { id: 'default', label: 'Default' },
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

// The argv for one CLI process (exported for tests and the report; never joined into a shell string).
// A resumed session takes --model too: it applies to the rest of the session, as /model does.
// --system-prompt replaces Claude Code's own (coding) system prompt, as cli-json.js does: Lumen's
// prompt plus CLAUDE_CODE_NOTE (agent.js) names the mcp__lumen__ tools. Tool use itself needs no
// prompt: the tool definitions come from the MCP server.
// [full access] Claude Code keeps its own system prompt (its tools, CLAUDE.md, skills): Lumen's is appended.
// [cc settings] userSettings (Settings > AI > "Use my Claude Code settings in Lumen chats", off by default): off, the CLI loads
// only project settings (--setting-sources project; the cwd is an empty folder, so none), which skips the user's CLAUDE.md, rules,
// memory and hooks (about 1.9k tokens and a few hundred ms of SessionStart hooks per chat) while the OAuth login still works.
// [full access] always loads them: it runs as in a terminal.
function buildArgs({ mcpConfig, sessionId, resume, systemPrompt, model = 'default', maxTurns = 0, fullAccess = false, userSettings = false, effort = '' }) {
  return [
    ...(fullAccess ? ARGS_FULL : ARGS_BASE),
    ...(!fullAccess && !userSettings ? SETTING_SOURCES_PROJECT : []),
    ...(maxTurns > 0 ? ['--max-turns', String(maxTurns)] : []), // unset: no cap
    ...(model !== 'default' && validModel(model) ? ['--model', model] : []),
    ...effortLib.cliArgs('claudecode', effort), // Settings → AI → AI providers: --effort (none: the CLI's own default)
    '--mcp-config', mcpConfig, fullAccess ? '--append-system-prompt' : '--system-prompt', systemPrompt, resume ? '--resume' : '--session-id', sessionId,
  ];
}

// A CLI kept for the chat's next message is stopped after this long without one.
const IDLE_MS = 10 * 60 * 1000;
// A process pre-warmed on composer focus (agent.js prewarm) that no message has taken is released after this long.
const PREWARM_IDLE_MS = 10 * 60 * 1000;
// The first turn's wait for the user's own MCP servers under full access (see spawnProc).
// (Lumen's own server is local HTTP and answers in well under a second. Measured 2026-10-05 with the user's real setup, full access,
// cold start to the first model output: uncapped 37.8 s, 3 s cap 15.9 s, 1 s cap 14.8 s; the floor with only Lumen's server is 10.6 s.)
const MCP_STARTUP_WAIT_MS = 1000;
// After a pre-warmed process dies unused (a broken CLI, no sign-in), pre-warming pauses this long, doubling per
// repeat up to the max; a successful turn resets it.
const WARM_BACKOFF_MS = 5 * 60 * 1000;
const WARM_BACKOFF_MAX_MS = 30 * 60 * 1000;
// A message whose process says nothing (no stdout line, no Lumen tool call in flight) for this long
// is ended with an error; the next message starts the process again with --resume.
const WATCHDOG_MS = 90 * 1000;
// A fresh process that has not printed its first line yet is only starting (the CLI loads its settings and connects its MCP
// servers, slowly on a machine busy with other Claude Code sessions), so it gets this much longer before it counts as hung.
// Slowness alone is never a failure, and never a reason to hand the message to another model.
const STARTUP_WATCHDOG_MS = 5 * 60 * 1000;
// A start still silent after this long says so on screen, instead of looking stuck.
const SLOW_START_MS = 12 * 1000;
// A transient failure (a spawn error, an overloaded or rate-limited API, a CLI that died at once) is tried once more after this
// pause before anything is reported or any other model is asked.
const RETRY_DELAY_MS = 2500;
// Stop first asks the kept CLI to interrupt (a stream-json control_request); it is kept when the
// interrupted turn's `result` comes within this long, else the process tree is killed as before.
const INTERRUPT_MS = 1500;

// The --mcp-config for one CLI process. Preferred: Lumen's already-listening local HTTP MCP server
// (mcp-http.js, as Grok Build uses) with this process's own bearer token: no bridge process, pipe or
// challenge per message, so Lumen's tools are there at once. Fallback: the stdio bridge (mcp.js),
// named by its LUMEN_ENGINE tag.
function mcpConfigFor({ http = null, bridge = null, userData, tag }) {
  if (http) return { mcpServers: { lumen: { type: 'http', url: http.mcpUrl, headers: { Authorization: `Bearer ${http.mcpToken}` } } } };
  const { command, args, env } = bridge;
  return { mcpServers: { lumen: { command, args, env: { ...env, LUMEN_USERDATA: userData, LUMEN_ENGINE: tag } } } };
}

// A kept CLI serves the next message only if that message wants the same binary, session, model,
// turn cap and system prompt (a new chat, a model or settings change starts another one). Today's date
// (agent.js claudeCodeNote) is left out of the key: a kept CLI serves on past midnight with the date it
// started with rather than respawning, and a warm start made before midnight stays usable after it.
// [cc settings] userSettings is part of the key too (last, so warmModel's index holds): changing the setting ends a warm process.
const procKey = ({ bin, sessionId, systemPrompt, model = 'default', maxTurns = 0, fullAccess = false, userSettings = false, effort = '' }) => JSON.stringify([bin, sessionId, model, maxTurns, Boolean(fullAccess), crypto.createHash('sha256').update(String(systemPrompt).replace(/Today's date is \d{4}-\d\d-\d\d\./g, "Today's date is (today).")).digest('hex'), Boolean(userSettings), effortLib.clean('claudecode', effort)]); // (effort last too, so warmModel's index holds)

// [model switch] The model is the one part of a key a live CLI can change without a restart: a stream-json
// `set_model` control request (checked against the CLI, 2.1.288) applies to the process's next message, even before
// its first. Auto routing (claudecode:auto, the tier routing of 'default') picks the model per message, after the
// composer-focus warm-up chose a guess, so a model-only mismatch switches the warm process instead of cold-starting one.
const keyParts = (key) => { try { return JSON.parse(key); } catch { return null; } };
const switchableModel = (m) => Boolean(m) && m !== 'default' && validModel(m);
// True when `from` (a kept process's key) differs from `to` only by a model, both named (a CLI started on its own default has no model to switch from).
function modelOnlyDiff(from, to) {
  const a = keyParts(from);
  const b = keyParts(to);
  if (!a || !b || a.length !== b.length || a[2] === b[2] || !switchableModel(a[2]) || !switchableModel(b[2])) return false;
  return a.every((v, i) => i === 2 || v === b[i]);
}

// [cc settings] A failure that loading ~/.claude/settings.json may cure: a sign-in, credential, proxy or certificate error
// (apiKeyHelper, ANTHROPIC_* / proxy env in the user's settings) in a CLI that ran without those settings.
const SETTINGS_FAILURE = /not logged in|\/login|api key|oauth|authenticat|credential|unauthori[sz]ed|\b40[17]\b|proxy|certificate|ECONNREFUSED|ENOTFOUND|unable to connect|could not connect/i;
const settingsRetryable = (text) => SETTINGS_FAILURE.test(String(text || ''));
let settingsNoticeShown = false; // the suggestion is shown once per Lumen run

// A step row shown while the model is still writing a tool call's input (a long fill_form or batch):
// it appears after EARLY_STEP_MS, and Lumen's MCP side takes it over when the call arrives
// (claimStep, features/ai-agents.js mcpCallTool). A call that arrives sooner gets its usual row.
const EARLY_STEP_MS = 300;
const EARLY_LABELS = { navigate: 'Opening a page', open_tab: 'Opening a tab', click: 'Clicking', click_at: 'Clicking', type_text: 'Typing', press_key: 'Pressing a key', fill_form: 'Filling in a form', batch: 'Running steps', read_page: 'Reading the page', find: 'Searching the page', web_search: 'Searching the web', read_urls: 'Reading pages', screenshot: 'Taking a screenshot', video_overview: 'Looking over the video', video_frames: 'Looking at video frames', run_script: 'Running a script on the page', get_console: 'Reading the console', get_network: 'Reading requests', handle_dialog: 'Answering a dialog', wait_for: 'Waiting', analyze_posts: 'Comparing posts' };
const earlyLabel = (name) => EARLY_LABELS[name] || `Using ${String(name).replace(/_/g, ' ')}`;

// [full access] A step row for one of the CLI's own tools (Bash, file edits, another MCP server's tool).
// They run inside the CLI, not through Lumen's MCP server, so their rows come from the stream instead.
const clip = (v, n = 80) => { const t = String(v ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const fileName = (p) => clip(path.basename(String(p || '')) || p, 60);
function builtinLabel(name, input = {}) {
  const n = String(name);
  if (n === 'Bash') return input.description ? clip(input.description) : `Running ${clip(input.command)}`;
  if (n === 'Read') return `Reading ${fileName(input.file_path)}`;
  if (n === 'Edit' || n === 'MultiEdit' || n === 'NotebookEdit') return `Editing ${fileName(input.file_path || input.notebook_path)}`;
  if (n === 'Write') return `Writing ${fileName(input.file_path)}`;
  if (n === 'Glob' || n === 'Grep') return `Searching files for ${clip(input.pattern, 60)}`;
  if (n === 'WebFetch') return `Fetching ${clip(input.url, 60)}`;
  if (n === 'WebSearch') return `Searching the web for ${clip(input.query, 60)}`;
  if (n === 'Task' || n === 'Agent') return input.description ? `Subagent: ${clip(input.description, 60)}` : 'Running a subagent';
  if (n === 'Skill') return `Using the ${clip(input.skill || input.command, 40)} skill`;
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(n);
  if (mcp) return `Using ${mcp[1]}: ${mcp[2].replace(/_/g, ' ')}`;
  return `Using ${n}`;
}
const isLumenTool = (name) => /^mcp__lumen__/.test(String(name || ''));
// [full access] The message as typed when it is a slash command ("/goal ship it", "/context"), else null.
const slashCommand = (text) => (typeof text === 'string' && /^\/[A-Za-z][\w:.-]*(\s|$)/.test(text.trim()) ? text.trim() : null);

// Newline-delimited JSON from a stream, one line at a time.
function lineReader(onLine) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) onLine(line);
    }
  };
}

// One stream-json line written to stdin per message: text first, then any images, in the same
// Anthropic image-block shape the API engines use (see agent.js runOnce). With --input-format
// stream-json the CLI keeps reading stdin, so a kept process takes the chat's next message as
// another line; each message's turn ends with a `result` event.
function stdinMessage(prompt, images = []) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } })),
      ],
    },
    parent_tool_use_id: null,
  };
}

// Maps `claude auth status --json` output to what the picker needs, never anything from
// credentials/tokens themselves: just whether it's logged in and a coarse account-type label.
// Anything that doesn't parse as the expected shape (old CLI, a stray warning line before the
// JSON, a future field rename) comes back 'unknown' so the option stays listed and the existing
// first-message error ("Claude Code is not signed in...") still covers it.
function parseAuthStatus(stdout) {
  let json;
  try { json = JSON.parse(String(stdout).trim()); } catch { return { signedIn: 'unknown', accountType: null, detail: null }; }
  if (!json || typeof json.loggedIn !== 'boolean') return { signedIn: 'unknown', accountType: null, detail: null };
  if (!json.loggedIn) return { signedIn: false, accountType: null, detail: null };
  // authMethod 'claude.ai' is an OAuth subscription session; anything else (apiKey, bedrock, vertex…) pays per token.
  const accountType = json.authMethod === 'claude.ai' ? 'subscription' : 'apiKey';
  return { signedIn: true, accountType, detail: accountType === 'subscription' ? (json.subscriptionType || null) : null };
}

// `claude auth status --json`: the CLI's own sign-in check, so Lumen itself never reads claude.ai
// credentials or tokens (Anthropic's terms bar apps from collecting or intermediating those). Old
// CLIs without `auth status`, and any failure (timeout, non-zero exit, ENOENT), resolve 'unknown'.
function checkAuthStatus(bin) {
  return new Promise((resolve) => {
    try {
      execFile(bin, ['auth', 'status', '--json'], { shell: false, windowsHide: true, timeout: 5000 }, (err, stdout) => {
        resolve(err ? { signedIn: 'unknown', accountType: null, detail: null } : parseAuthStatus(stdout));
      });
    } catch { resolve({ signedIn: 'unknown', accountType: null, detail: null }); } // a file that can't be executed at all (spawn EFTYPE)
  });
}

class ClaudeCodeEngine {
  // mcpCommand(): { command, args, env } for Lumen's stdio bridge. ensureServer(): starts the stdio
  // MCP server. gate(): resolves Lumen's local HTTP MCP server (mcp-http.js startHttp); none, or a
  // failure, falls back to the stdio bridge. keepAlive: keep the CLI running between the chat's
  // messages (the sidebar's engine); off, each process takes one message and ends (background tasks).
  // spawn / kill: child_process.spawn and cli-utils killTree, swappable for tests. A background task
  // makes its own instance per run (features/ai-agents.js backgroundEngine), so `active`, the kept
  // process and the bin cache are never shared with the sidebar's.
  // watchdogMs / interruptMs: see WATCHDOG_MS / INTERRUPT_MS (0 turns the watchdog off). onFresh({ sessionId,
  // resume }): a new CLI process starts, so anything the model saw through the old one (snapshot.js's
  // repeat-read cache) no longer counts (features/ai-agents.js).
  constructor({ userData, mcpCommand, ensureServer, gate = null, keepAlive = true, idleMs = IDLE_MS, watchdogMs = WATCHDOG_MS, startupWatchdogMs = watchdogMs === WATCHDOG_MS ? STARTUP_WATCHDOG_MS : watchdogMs, slowStartMs = SLOW_START_MS, retryDelayMs = RETRY_DELAY_MS, interruptMs = INTERRUPT_MS, onFresh = null, prewarmIdleMs = PREWARM_IDLE_MS, warmBackoffMs = WARM_BACKOFF_MS, warmBackoffMaxMs = WARM_BACKOFF_MAX_MS, spawn: spawnChild = spawn, kill = killTree }) {
    this.kind = 'claudecode';
    this.prewarmIdleMs = prewarmIdleMs;
    this.warmBackoffMs = warmBackoffMs;
    this.warmBackoffMaxMs = warmBackoffMaxMs;
    this.warmBlock = { until: 0, delay: 0 }; // pre-warm pause after unused warm processes died (warmFailed)
    this.watchdogMs = watchdogMs;
    this.startupWatchdogMs = startupWatchdogMs;
    this.slowStartMs = slowStartMs;
    this.retryDelayMs = retryDelayMs;
    this.interruptMs = interruptMs;
    this.onFresh = onFresh;
    this.gen = 0; // bumped by release(): a warm() started before it disposes its process when it lands
    this.spawn = spawnChild;
    this.kill = kill;
    this.userData = userData;
    this.mcpCommand = mcpCommand;
    this.ensureServer = ensureServer;
    this.gate = gate;
    this.keepAlive = keepAlive;
    this.idleMs = idleMs;
    this.bin = undefined; // undefined: not looked up yet; null: not installed
    this.active = null; // { tag, emit, signal, child, agent } for the message in progress
    this.proc = null; // the CLI process, kept between messages (keepAlive) with stdin open
    this.starting = null; // the take() in flight, so warm() and run() share one spawn
    this.busy = false; // a run() is under way (warm() waits for the next message)
    this.warming = 0; // warm() starts not yet landed
    this.early = []; // step rows shown while a tool call's input streams: { name, id, timer, shown }
    this.statusCache = null; // { at, value } from checkAuthStatus; a 30s TTL avoids a CLI spawn per render
  }

  async detect(refresh = false) {
    if (this.bin === undefined || refresh) this.bin = await findClaude();
    return this.bin;
  }

  // The binary for a run: the one found earlier while it is still on disk (a `where`/`which` spawn per
  // message cost tens to hundreds of ms before the first token), else a fresh look.
  async ensureBin() {
    if (this.bin && exists(this.bin)) return this.bin;
    return this.detect(true);
  }

  // { installed, signedIn: true|false|'unknown', accountType: 'subscription'|'apiKey'|null, detail }.
  // refresh: re-detect the binary and re-run the CLI's own auth check instead of the 30s cache.
  async status(refresh = false) {
    const bin = await this.detect(refresh);
    if (!bin) { this.statusCache = null; return { installed: false, signedIn: false, accountType: null, detail: null }; }
    if (!refresh && this.statusCache && Date.now() - this.statusCache.at < 30000) return { installed: true, ...this.statusCache.value };
    const value = await checkAuthStatus(bin);
    this.statusCache = { at: Date.now(), value };
    return { installed: true, ...value };
  }

  // True when an MCP session belongs to this engine's live CLI (its token or bridge carries our tag).
  // A kept process owns its tag between messages too, so its MCP handshake is accepted before the
  // message starts; tool calls still need a message in progress (mcpCallTool refuses them otherwise).
  owns(tag) {
    const live = this.active?.tag || (this.proc && !this.proc.exited ? this.proc.tag : null);
    return Boolean(tag && live && tag.length === live.length && crypto.timingSafeEqual(Buffer.from(tag), Buffer.from(live)));
  }

  // Starts one CLI process: its own tag, its own MCP token (revoked when it ends), its own empty folder.
  async spawnProc({ bin, key, sessionId, resume, systemPrompt, model, maxTurns, fullAccess = false, userSettings = false, effort = '' }) {
    const tag = crypto.randomBytes(18).toString('hex');
    let http = null;
    if (this.gate) {
      try { const server = await this.gate(); if (server) http = { server, ...server.open(tag) }; } catch {} // no HTTP server: the stdio bridge
    }
    if (!http) this.ensureServer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cc-'));
    (this.workDirs ||= new Set()).add(dir); // (imageRoots)
    const mcpConfig = path.join(dir, 'mcp.json');
    try {
      fs.writeFileSync(mcpConfig, JSON.stringify(mcpConfigFor({ http, bridge: http ? null : this.mcpCommand(), userData: this.userData, tag })), { mode: 0o600 });
    } catch (err) { // nothing owns the folder yet: it and the token go with the failure
      try { http?.server.close(tag); } catch {}
      removeDirSync(dir);
      this.workDirs.delete(dir);
      throw err;
    }
    const argv = buildArgs({ mcpConfig, sessionId, resume, systemPrompt, model, maxTurns, fullAccess, userSettings, effort });
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    // [full access] The CLI loads the user's own MCP servers too, and its first turn waits for every one of them to connect (up to
    // MCP_TIMEOUT, 30 s): measured with six of them, a cold start took 8 to 20 s before the first token, against 2.5 s with Lumen's
    // alone. Capped (CLAUDE_CODE_MCP_STARTUP_WAIT_MS, CLI 2.1.274+): Lumen's own server connects within a second, and slower ones keep
    // connecting in the background. A value the user set themselves is left alone. (Without full access --strict-mcp-config leaves
    // Lumen's server as the only one, so there is nothing slow to wait for and no cap.)
    if (fullAccess && !childEnv.CLAUDE_CODE_MCP_STARTUP_WAIT_MS) childEnv.CLAUDE_CODE_MCP_STARTUP_WAIT_MS = String(MCP_STARTUP_WAIT_MS);
    // single: takes one message, then stdin closes. A turn cap (--max-turns) may count across a
    // process's messages, so a capped chat gets a fresh (pre-started) process per message instead.
    // usage: perTurnResult's state (cumulative-or-per-turn totals); drain: set while an interrupted turn's
    // leftover output is being read off (take() waits for it).
    const proc = { key, tag, http, dir, child: null, single: !this.keepAlive || maxTurns > 0, spent: false, turns: 0, exited: false, code: null, stderr: '', turn: null, idle: null, usage: { last: null, perTurn: false }, drain: null };
    proc.fresh = { sessionId, resume }; // onFresh's args, run when a message takes this process (turn)
    proc.fullAccess = Boolean(fullAccess); // [full access] its own tools run (turn: their step rows, the watchdog)
    // The CLI may name the session it continues differently from the id it was started with (a
    // resumed session forked): the process is then kept for the id the chat saves.
    proc.model = model; // (set_model changes it: switchModel)
    proc.rekey = (id) => { proc.key = procKey({ bin, sessionId: id, systemPrompt, model: proc.model, maxTurns, fullAccess, userSettings, effort }); };
    const finish = (code) => {
      if (proc.exited) return;
      proc.exited = true;
      proc.code = code;
      clearTimeout(proc.idle);
      if (this.proc === proc) this.proc = null;
      if (proc.warmed && !proc.turns && !proc.disposed) this.warmFailed(); // a pre-warmed process died on its own, unused
      try { http?.server.close(tag); } catch {}
      removeDir(dir, () => this.workDirs?.delete(dir)); // (its mcp.json holds the token; the folder is its cwd, so it can only go once the process has)
      proc.turn?.exit(code);
    };
    try {
      proc.child = this.spawn(bin, argv, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: childEnv, cwd: fullAccess ? os.homedir() : dir }); // an empty folder: no project settings or files ([full access]: the home folder, as in a terminal)
    } catch (err) {
      proc.stderr = err.message;
      finish(err.code === 'ENOENT' ? 'ENOENT' : -1);
      return proc;
    }
    const { child } = proc;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', lineReader((line) => {
      if (process.env.LUMEN_CC_DEBUG) fs.appendFileSync(process.env.LUMEN_CC_DEBUG, `${line}\n`);
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      proc.turn?.handle(msg); // between messages there is no turn: nothing to show it on
    }));
    child.stderr.on('data', (d) => { proc.stderr = (proc.stderr + d).slice(-4000); });
    child.stdin.on('error', () => {}); // the CLI exiting early closes the pipe
    child.on('error', (err) => { proc.stderr += `\n${err.message}`; finish(err.code === 'ENOENT' ? 'ENOENT' : -1); });
    child.on('close', (c) => finish(c));
    return proc;
  }

  // The process for a message: the kept one when it was started for the same session, model, turn
  // cap and prompt, else a new one (with --resume when the chat already has a session, so a kept
  // process that was stopped, timed out or crashed is picked up again transparently).
  take(opts, { fresh = false, emit = null } = {}) {
    const next = (this.starting || Promise.resolve()).catch(() => {}).then(async () => {
      const bin = await this.ensureBin();
      if (!bin) return null;
      if (this.needUserSettings && !opts.userSettings) opts = { ...opts, userSettings: true }; // [cc settings] this engine's CLI needed them (turn's fallback)
      const key = procKey({ bin, ...opts });
      let p = this.proc;
      if (p?.drain) { emit?.({ type: 'status', text: 'Finishing the stopped step…' }); await p.drain; p = this.proc; } // a stopped turn's leftover lines are read off first (said on screen: up to interruptMs)
      if (!fresh && p && !p.exited && !p.spent && !p.turn && p.key === key) { clearTimeout(p.idle); return p; }
      if (!fresh && p && !p.exited && !p.spent && !p.turn && modelOnlyDiff(p.key, key) && this.switchModel(p, opts.model, key)) { clearTimeout(p.idle); return p; } // [model switch]
      if (p && !p.turn) this.dispose(p);
      const proc = await this.spawnProc({ bin, key, ...opts });
      if (!proc.exited) this.proc = proc;
      return proc;
    });
    this.starting = next;
    return next;
  }

  // [model switch] Asks a kept CLI to answer its next message with `model` and re-keys it. False when its stdin is gone
  // (it is then replaced as before). A refusal comes back as a control_response error, which nothing waits for: the
  // process keeps its old model and the message still gets answered.
  switchModel(proc, model, key) {
    try {
      proc.child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: `lumen-model-${crypto.randomBytes(6).toString('hex')}`, request: { subtype: 'set_model', model } })}
`);
    } catch { return false; }
    proc.model = model;
    proc.key = key;
    return true;
  }

  // Starts (or keeps) the CLI for the chat's next message ahead of time, so the process start and
  // its MCP connection overlap with reading the page (agent.js runTask). Never mid-message.
  // speculative (agent.js prewarm, before any message exists): released after prewarmIdleMs unused, not idleMs.
  warm(opts, { speculative = false } = {}) {
    if (this.busy || this.active || !this.keepAlive) return;
    const gen = this.gen;
    this.warming++;
    this.take(opts).then((p) => {
      if (!p || (p.exited && !p.turns)) { this.warmFailed(); return; } // no CLI, or it died at spawn
      if (p.exited || p.turn) return;
      p.warmed = true;
      if (gen !== this.gen) this.dispose(p); // release() came while it was starting: nobody wants this one
      else this.idleLater(p, speculative && !p.turns ? this.prewarmIdleMs : this.idleMs);
    }).catch(() => {}).finally(() => { this.warming--; });
  }

  // Pre-warming backs off: 5 min after an unused warm process died, doubling to 30 min (reset by a successful turn).
  warmFailed() {
    const delay = this.warmBlock.delay ? Math.min(this.warmBlock.delay * 2, this.warmBackoffMaxMs) : this.warmBackoffMs;
    this.warmBlock = { until: Date.now() + delay, delay };
  }

  // Whether a speculative start is worth it now: not in backoff, and the CLI's last sign-in check wasn't "signed out".
  canPrewarm() {
    // (A "signed out" older than the status TTL counts as unknown: the user may have signed in since.)
    const fresh = this.statusCache && Date.now() - this.statusCache.at < 30000;
    return Date.now() >= this.warmBlock.until && !(fresh && this.statusCache.value?.signedIn === false);
  }

  // The kept process runs this model (agent.js prewarm: typed words that route elsewhere replace a guess).
  warmModel() {
    const p = this.proc;
    if (!p || p.exited || p.turn || this.warming > 0) return null;
    try { return JSON.parse(p.key)[2]; } catch { return null; }
  }

  // A process is kept or being started (agent.js prewarm starts none on top of it).
  isWarm() {
    return this.warming > 0 || Boolean(this.proc && !this.proc.exited);
  }

  idleLater(proc, ms = this.idleMs) {
    clearTimeout(proc.idle);
    proc.idle = null;
    if (ms === Infinity) return; // never idle out (Settings: a chat's warm process kept until its chat goes)
    proc.idle = setTimeout(() => this.dispose(proc), ms);
    proc.idle.unref?.();
  }

  // Ends a process (default: the kept one) with its whole tree (the stdio bridge is its child); its
  // MCP token stops working at once.
  dispose(proc = this.proc) {
    if (!proc) return;
    clearTimeout(proc.idle);
    proc.disposed = true; // ended by us: not a warm failure
    if (this.proc === proc) this.proc = null;
    try { proc.http?.server.close(proc.tag); } catch {}
    if (!proc.exited && proc.child) this.kill(proc.child);
  }

  // Lumen quits: the folders of every process started here go now (their processes were just killed; the async
  // removal in finish() would not run before the app exits). Whatever is still busy is swept at the next start.
  purgeDirs() {
    for (const dir of [...(this.workDirs || [])]) { removeDirSync(dir); this.workDirs.delete(dir); }
  }

  // The chat was switched, cleared or rewound (agent.js onEngineReset), or a background task ended:
  // an idle kept CLI goes. One mid-message stays, and one that took its last message ends by itself.
  // Also called when a message failed or was stopped before it reached the CLI (agent.js runTask), so
  // the process warm() started for it doesn't idle for the full timeout.
  release() {
    this.gen++;
    if (this.proc && !this.proc.turn && !this.proc.spent) this.dispose();
  }

  // A Lumen tool call from this CLI starts / ends (features/ai-agents.js mcpCallTool): counted for the
  // message (a message that ran a tool is never sent again silently), and the watchdog waits for it
  // (an approval card can wait on the user for as long as it likes).
  // `a`: the call's own active object (mcpCallTool holds it), so a call that outlives its message
  // can't end on the next message's counters.
  callBegin(a = this.active) {
    if (!a) return;
    a.tools++;
    a.inflight++;
    clearTimeout(a.dog);
  }

  callEnd(a = this.active) {
    if (!a) return;
    a.inflight = Math.max(0, a.inflight - 1);
    a.arm?.();
  }

  // Stop on a kept process: ask the CLI to interrupt and read off the rest of the turn (up to its
  // `result`), so the next message can use the same process. The turn itself has already been
  // resolved as stopped by the caller; this runs on in the background. A process that doesn't
  // answer the control_request with a result in interruptMs is killed, as Stop always did.
  // lateUsage(result): the interrupted turn's own usage (per-turn delta), reported when its result
  // arrives -- the stopped turn already returned without it (agent.js claudeCodeTurn records it).
  interrupt(proc, lateUsage = null) {
    let finish;
    const drained = new Promise((resolve) => { finish = resolve; });
    let over = false;
    let acked = false;
    let timer = null;
    const end = (kept) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      proc.drain = null;
      proc.turn = null;
      if (kept && !proc.exited) this.idleLater(proc); else this.dispose(proc);
      finish();
    };
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => end(false), this.interruptMs); };
    proc.drain = drained;
    proc.turn = {
      handle: (msg) => {
        if (msg.type === 'result') { // the interrupted turn's own result: the line is clean again
          // perTurnResult also records it as the process's last result, so the next turn's delta isn't counted twice.
          const counted = perTurnResult(msg, proc.usage);
          try { if (lateUsage && counted) lateUsage({ usage: usageOf(counted), cost: Number(counted.total_cost_usd) || 0 }); } catch {}
          end(true);
        }
        else if (msg.type === 'control_response' && !acked) { acked = true; arm(); } // accepted: the result should follow shortly
      },
      exit: () => end(false),
    };
    arm();
    try { proc.child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: `lumen-stop-${crypto.randomBytes(6).toString('hex')}`, request: { subtype: 'interrupt' } })}\n`); } catch { end(false); }
  }

  // Early step rows (EARLY_STEP_MS): one per mcp__lumen__ tool_use block as it starts streaming.
  earlyStep(block, emit) {
    const name = /^mcp__lumen__([\w-]+)$/.exec(String(block?.name || ''))?.[1];
    if (!name) return;
    const step = { name, id: `cc-${String(block.id || crypto.randomBytes(6).toString('hex')).replace(/[^\w-]/g, '').slice(0, 60)}`, shown: false, timer: null };
    step.timer = setTimeout(() => { step.shown = true; emit({ type: 'tool', id: step.id, name, input: {}, label: earlyLabel(name) }); }, EARLY_STEP_MS);
    step.timer.unref?.();
    this.early.push(step);
  }

  // The MCP call for `name` has arrived: the id of the early row already on screen for it (the call
  // reports into that row), or null (none was shown yet: the call shows its own, labelled row).
  claimStep(name) {
    const i = this.early.findIndex((s) => s.name === name);
    if (i < 0) return null;
    const [step] = this.early.splice(i, 1);
    clearTimeout(step.timer);
    return step.shown ? step.id : null;
  }

  // The early row `id` (claimStep) now has its call: its real input and describeStep's specific label
  // replace the generic one (the renderer's tool_update sets the step's label text and title).
  updateStep(id, name, input, label) {
    if (label) this.active?.emit({ type: 'tool_update', id, name, input, label });
  }

  // End of a message: rows for tool calls that never reached Lumen are marked stopped.
  clearEarly(emit) {
    for (const s of this.early.splice(0)) {
      clearTimeout(s.timer);
      if (s.shown) emit({ type: 'tool_done', id: s.id, ok: false, stopped: true });
    }
  }

  // One message. Resolves { text, sessionId }; errors are emitted, not thrown.
  // runAgent: the Agent whose gate, approvals and tab this run's MCP calls use (a background task's own;
  // null: the sidebar's, see mcpCallTool in features/ai-agents.js).
  // quietExpired: a resumed session the CLI no longer has resolves { expired: true } without an error,
  // so the caller can start a new session with the conversation handed over (agent.js claudeCodeTurn).
  async run(opts) {
    this.busy = true;
    try {
      const out = await this.turn(opts);
      // A kept process that died between messages (and said nothing this time) is started again once.
      if (out.retry) return await this.turn(opts, { fresh: true });
      return out;
    } finally {
      this.busy = false;
    }
  }

  async turn({ prompt, images = [], sessionId, resume, systemPrompt, model = 'default', maxTurns = 0, fullAccess = false, signal, emit, runAgent = null, scope = null, quietExpired = false, lateUsage = null, prestart = true, userSettings = false, effort = '' }, { fresh = false, attempt = 0 } = {}) {
    const notInstalled = () => {
      emit({ type: 'error', text: `Claude Code isn't installed. ${INSTALL_HINT}` });
      return { text: '', sessionId: null, failed: true };
    };
    if (!await this.ensureBin()) return notInstalled();
    userSettings = userSettings || Boolean(this.needUserSettings);
    const proc = await this.take({ sessionId, resume, systemPrompt, model, maxTurns, fullAccess, userSettings, effort }, { fresh, emit });
    if (!proc) return notInstalled();
    // The read cache is reset for a process only once a message uses it (spawnProc kept the args): a
    // pre-started one that no message takes must not wipe the chat's reads.
    if (proc.fresh) { const f = proc.fresh; proc.fresh = null; try { this.onFresh?.(f); } catch {} }
    const reused = proc.turns > 0;
    this.runDirs = new Set(); // folders this message's shell commands were pointed at (freshRoots)
    this.runImagePaths = []; // image files this message's tools reported (enginePictures checks each)
    if (!reused) emit({ type: 'status', text: 'Starting Claude Code…' }); // (its first message: the working line says why it waits)
    proc.turns++;
    const { tag } = proc;
    // tools: Lumen tool calls this message made (callBegin); inflight: those still running; dog/arm: the watchdog.
    // builtin: [full access] the CLI's own tool calls still running (each also counts in inflight: a long
    // shell command prints nothing until it ends, and must not look hung).
    const active = { tag, emit, signal, child: proc.child, agent: runAgent, scope, tools: 0, inflight: 0, dog: null, arm: null, builtin: new Set() };
    this.active = active;

    let text = '';
    let finalText = '';
    let result = null;
    let newSession = sessionId;
    let rateLimit = null; // the plan's limits as of this turn (rate_limit_event), for the Usage panel
    // [context] The usage of the turn's last model call (its whole input is the context in use), and a
    // compaction the CLI ran during the turn (/compact, or its own near the limit): { trigger, pre, post }.
    let lastCall = null;
    let compacted = null;
    let compacting = false;
    let settle;
    const ended = new Promise((resolve) => { settle = resolve; });
    let sent = false; // the message went into stdin
    let over = false; // the turn has ended (the watchdog stays off)
    let stalled = false;
    // Watchdog: any line from the CLI restarts it; it is off while a Lumen tool call runs (an approval card
    // can wait on the user). A CLI that says nothing for watchdogMs is hung: end it and say so.
    // A fresh process that has said nothing yet is starting, not hung: it gets the longer startup allowance, and a note on
    // screen when it is slow (heard: its first line has come).
    let heard = reused;
    let slow = null;
    const waitMs = () => (heard ? this.watchdogMs : Math.max(this.watchdogMs, this.startupWatchdogMs));
    active.arm = () => {
      clearTimeout(active.dog);
      if (!this.watchdogMs || over || active.inflight > 0) return;
      active.dog = setTimeout(() => { stalled = true; this.dispose(proc); settle({ code: null }); }, waitMs());
    };
    if (!reused && this.slowStartMs) { slow = setTimeout(() => { if (!heard && !over) emit({ type: 'status', text: 'Claude Code is still starting (this computer is busy)…' }); }, this.slowStartMs); slow.unref?.(); }
    // "Reply complete" (once per message): the screen clears its working state and takes the next message now. This run
    // goes on to `result` for its cost, usage and session id (`done`), and a message sent meanwhile waits for it
    // (agent.js run: a run that is settling is waited for, not aborted). Never while a tool call is in flight, in a
    // subagent's own turn, or while compacting.
    let early = false;
    const replyComplete = (msg) => {
      if (early || msg.parent_tool_use_id || active.inflight > 0 || active.builtin.size || compacting || over || signal.aborted) return;
      early = true;
      emit({ type: 'reply_complete' });
    };
    const handle = (msg) => {
      heard = true;
      clearTimeout(slow);
      active.arm();
      if (msg.type === 'rate_limit_event' && msg.rate_limit_info) {
        rateLimit = msg.rate_limit_info;
        emit({ type: 'rate_limit', info: rateLimit });
      } else if (msg.type === 'system' && msg.subtype === 'init') {
        newSession = msg.session_id || newSession;
        const lumen = (msg.mcp_servers || []).find((s) => s.name === 'lumen');
        if (lumen && lumen.status !== 'connected') emit({ type: 'notice', text: `Claude Code could not connect to Lumen (${lumen.status}).` });
      } else if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
        const meta = msg.compact_metadata || {};
        compacted = { trigger: meta.trigger || null, pre: Number(meta.pre_tokens) || 0, post: Number(meta.post_tokens) || 0 };
        lastCall = null; // what came before the boundary is no longer in context
      } else if (msg.type === 'system' && msg.subtype === 'status' && (msg.status === 'compacting' || compacting)) {
        compacting = msg.status === 'compacting';
        emit({ type: 'status', text: compacting ? 'Compacting the conversation…' : '' });
      } else if (msg.type === 'stream_event') {
        const e = msg.event || {};
        // The reply's last model call ended its turn (message_delta end_turn, no tool call of this turn still running): the
        // text is complete. `result` follows 0.8-1.1 s later (post_turn_summary in between); the screen need not wait for it.
        if (e.type === 'message_delta' && e.delta?.stop_reason === 'end_turn') replyComplete(msg);
        // Each text block (one per turn around a tool call) starts a new paragraph, on screen and in
        // the saved reply alike; joined bare they ran together ("I'll check.The price is…").
        if (e.type === 'content_block_start' && e.content_block?.type === 'text') { if (text && !/\n\n$/.test(text)) text += '\n\n'; emit({ type: 'text_block' }); }
        else if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') this.earlyStep(e.content_block, emit);
        else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') { text += e.delta.text; emit({ type: 'text', text: e.delta.text }); }
        else if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') emit({ type: 'thinking', text: e.delta.thinking });
      } else if (msg.type === 'assistant') {
        const t = (msg.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
        if (t) finalText = t;
        if (msg.message?.stop_reason === 'end_turn') replyComplete(msg); // (a CLI that puts it on the message itself)
        if (msg.message?.usage && !msg.parent_tool_use_id && msg.message.model !== '<synthetic>') lastCall = msg.message.usage;
        for (const b of msg.message?.content || []) {
          if (!proc.fullAccess || b.type !== 'tool_use' || isLumenTool(b.name) || !b.id || active.builtin.has(b.id) || msg.parent_tool_use_id) continue;
          active.builtin.add(b.id);
          if (b.name === 'Bash') for (const d of dirsInCommand(b.input?.command)) this.runDirs.add(d); // (freshRoots)
          active.inflight++;
          emit({ type: 'tool', id: `cc-${String(b.id).replace(/[^\w-]/g, '').slice(0, 60)}`, name: String(b.name), input: b.input || {}, label: builtinLabel(b.name, b.input || {}) });
        }
        active.arm();
      } else if (msg.type === 'user' && active.builtin.size) {
        for (const b of Array.isArray(msg.message?.content) ? msg.message.content : []) {
          if (b.type !== 'tool_result' || !active.builtin.delete(b.tool_use_id)) continue;
          active.inflight = Math.max(0, active.inflight - 1);
          for (const p of toolImagePaths(b.content, { home: os.homedir() })) if (this.runImagePaths.length < 20 && !this.runImagePaths.includes(p)) this.runImagePaths.push(p);
          const err = b.is_error ? clip(Array.isArray(b.content) ? b.content.map((c) => c.text || '').join(' ') : b.content, 200) : '';
          emit({ type: 'tool_done', id: `cc-${String(b.tool_use_id).replace(/[^\w-]/g, '').slice(0, 60)}`, ok: !b.is_error, ...(err ? { error: err } : {}) });
        }
        active.arm();
      } else if (msg.type === 'result') { // the end of this message's turn; a kept process then waits for the next line
        result = msg;
        newSession = msg.session_id || newSession;
        settle({ code: null });
      }
    };
    const current = { handle, exit: (code) => settle({ code }) };
    proc.turn = current;
    if (proc.exited) settle({ code: proc.code });
    // Stop: the reply ends now. A kept process that has the message is asked to interrupt and keeps
    // running if it answers in time (interrupt); any other (one-shot, nothing sent yet) goes with its
    // whole tree (the stdio bridge is the CLI's child).
    const onAbort = () => {
      settle({ code: null });
      if (proc.exited) return;
      if (proc.single || !sent) this.dispose(proc); else this.interrupt(proc, lateUsage);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    if (!proc.exited && !signal.aborted) {
      sent = true;
      proc.child.stdin.write(`${JSON.stringify(stdinMessage(prompt, images))}\n`);
      if (proc.single) { proc.spent = true; proc.child.stdin.end(); }
      active.arm();
    }

    const { code } = await ended;
    over = true;
    clearTimeout(active.dog);
    clearTimeout(slow);
    signal.removeEventListener('abort', onAbort);
    if (proc.turn === current) proc.turn = null; // (not an interrupt's drain, which clears itself)
    this.clearEarly(emit);
    if (this.active?.tag === tag) this.active = null;
    const ok = Boolean(result && !result.is_error && result.subtype === 'success');
    if (ok) this.warmBlock = { until: 0, delay: 0 }; // a working CLI: pre-warming is worth trying again
    if (!proc.single) {
      if (ok && !signal.aborted && !proc.exited) { if (newSession) proc.rekey(newSession); this.idleLater(proc); } // kept for the chat's next message
      else if (!proc.drain) this.dispose(proc); // a failed, stalled or capped turn: the next message starts clean (--resume); a stopped one is draining
    } else if (ok && this.keepAlive && !signal.aborted && prestart) {
      // A capped chat: its next message's process starts now, resuming this session, once this one has ended.
      // Its model may not be the next message's (Auto, routing): take() switches a model-only mismatch in place.
      const next = { sessionId: newSession, resume: true, systemPrompt, model, maxTurns, fullAccess, userSettings, effort };
      const go = () => setImmediate(() => this.warm(next));
      if (proc.exited) go(); else proc.child.once('close', go);
    }

    if (signal.aborted) return { text: text || finalText, sessionId: newSession, stopped: true };
    if (code === 'ENOENT') { this.bin = null; return notInstalled(); }
    if (stalled) {
      // noFallback: slowness alone never hands the message to another model (agent.js runTask).
      emit({ type: 'error', noFallback: true, text: `Claude Code stopped responding for ${Math.round(waitMs() / 1000)} seconds, so Lumen ended it. Send your message again to pick up where it left off.` });
      return { text, sessionId: newSession, failed: true, rateLimit };
    }
    // Sent again on a fresh process only when nothing ran: a turn that called a tool may have acted already.
    if (!result && reused && !fresh && !text && !finalText && active.tools === 0) return { retry: true };
    // What this message cost, not the process's running total (perTurnResult in cli-utils.js).
    const counted = result ? perTurnResult(result, proc.usage) : null;
    const usage = usageOf(counted);
    // [context] Like Grok's (grok-build.js grokUsage): the last call's whole input, for the Usage log and the chat's meter.
    if (usage && lastCall) usage.contextTokens = (Number(lastCall.input_tokens) || 0) + (Number(lastCall.cache_read_input_tokens) || 0) + (Number(lastCall.cache_creation_input_tokens) || 0);
    const context = lastCall ? { tokens: usage?.contextTokens || 0, window: usage?.contextWindow || 0 } : null;
    // The turn cap is not a failure: keep the session so "continue" resumes it (agent.js shows the notice).
    if (turnLimitHit(result)) return { text: text || finalText, sessionId: newSession, limit: true, cost: counted.total_cost_usd, usage, rateLimit, context, compacted };
    if (!ok) {
      // A resumed session that no longer exists: forget it so the next message starts fresh.
      const expired = /no conversation found|session.*not found/i.test(`${result?.result || ''}${(result?.errors || []).join('\n')}${proc.stderr}`);
      if (expired && resume && quietExpired && !text) return { text: '', sessionId: null, failed: true, expired: true, usage, rateLimit };
      const failure = result?.result || (result?.errors || []).join('\n') || proc.stderr;
      // [cc settings] Nothing ran, and the CLI had none of the user's settings: they may hold the credentials or proxy it needs.
      // Retried once with them; this engine keeps them from then on (needUserSettings), and the user is told which setting that is.
      if (!userSettings && !fullAccess && !expired && !text && !finalText && active.tools === 0 && settingsRetryable(failure)) {
        this.needUserSettings = true;
        const again = await this.turn({ prompt, images, sessionId, resume, systemPrompt, model, maxTurns, fullAccess, signal, emit, runAgent, scope, quietExpired, lateUsage, prestart, userSettings: true }, { fresh: true });
        if (again.failed) this.needUserSettings = false; // it did not help: the next message tries the lean start again
        else if (!settingsNoticeShown) {
          settingsNoticeShown = true;
          emit({ type: 'notice', text: 'Claude Code needed your own Claude Code settings (~/.claude/settings.json) to connect, so Lumen loaded them for this chat. To always load them, turn on Settings → AI → Use my Claude Code settings in Lumen chats.' });
        }
        return again;
      }
      // A transient failure (see transientFailure) with nothing run and nothing shown: once more on a fresh process after a short pause.
      if (!attempt && !expired && !text && !finalText && active.tools === 0 && !signal.aborted && transientFailure(failure, code)) {
        emit({ type: 'status', text: 'Claude Code is busy, trying again…' });
        await new Promise((resolve) => { const t = setTimeout(resolve, this.retryDelayMs); signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); });
        if (!signal.aborted) return this.turn({ prompt, images, sessionId, resume, systemPrompt, model, maxTurns, fullAccess, signal, emit, runAgent, scope, quietExpired, lateUsage, prestart, userSettings, effort }, { fresh: true, attempt: 1 });
      }
      emit({ type: 'error', ...describeFailure(failure, code) });
      return { text, sessionId: expired ? null : newSession, failed: true, usage, rateLimit, context, compacted };
    }
    return { text: text || finalText || String(result.result || ''), sessionId: newSession, cost: counted.total_cost_usd, usage, rateLimit, context, compacted, window: usage?.contextWindow || 0, imagePaths: [...(this.runImagePaths || [])] };
  }
}

ClaudeCodeEngine.prototype.imageRoots = function imageRoots() { return [...(this.workDirs || [])]; };

// [full access] Where a picture the CLI made with its own tools may lie (agent.js enginePictures, which also requires the file
// to be written during the run): the home folder it runs in, and the folders its shell commands named with --cwd / --add-dir
// (a CLI told to write elsewhere, e.g. a temp folder outside home). Never a drive or filesystem root.
ClaudeCodeEngine.prototype.freshRoots = function freshRoots() {
  const home = os.homedir();
  const ok = (d) => { try { return path.isAbsolute(d) && path.parse(d).root !== path.resolve(d) && fs.statSync(d).isDirectory(); } catch { return false; } };
  return [home, ...[...(this.runDirs || [])].filter(ok)];
};

// Absolute folders named by `--cwd <dir>`, `--cwd=<dir>` or `--add-dir <dir>` in a shell command (quoted or not).
function dirsInCommand(command) {
  const out = [];
  const re = /--(?:cwd|add-dir)(?:=|\s+)(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"']+))/g;
  for (const m of String(command || '').matchAll(re)) {
    const d = m[1] || m[2] || m[3];
    if (d && out.length < 8) out.push(d);
  }
  return out;
}

module.exports = { transientFailure, STARTUP_WATCHDOG_MS, MCP_STARTUP_WAIT_MS, PREWARM_IDLE_MS, modelOnlyDiff, ClaudeCodeEngine, findClaude, buildArgs, settingsRetryable, SETTING_SOURCES_PROJECT, builtinLabel, slashCommand, MODELS, stdinMessage, describeFailure, killTree, INSTALL_HINT, parseAuthStatus, mcpConfigFor, procKey, lineReader, earlyLabel, dirsInCommand, IDLE_MS, EARLY_STEP_MS };
