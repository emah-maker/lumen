// "Claude · your account (Claude Code)": the sidebar engine that runs the user's own `claude` CLI
// headless for each message and lets it drive Lumen through Lumen's MCP server.
//
// Lumen never sees claude.ai credentials: the CLI uses its own login. The CLI is spawned with an
// argv array and shell:false (the message goes in on stdin), so user text never reaches a shell.
// It gets only Lumen's tools: built-in tools are disabled (--tools ""), only mcp__lumen is allowed,
// and --permission-mode dontAsk refuses anything else instead of prompting. Lumen's own approval
// card still gates acting tools, because every call goes through the MCP server's callTool.

const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exists, lookup, killTree, validModel, usageOf, perTurnResult } = require('./cli-utils');
const { turnLimitHit } = require('./loop-guard');

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

// Turns a CLI failure into what the user should do about it.
function describeFailure(text, code) {
  const t = String(text || '').trim();
  if (/not logged in|please run \/login|\/login|invalid api key|oauth|authenticat|credentials/i.test(t)) {
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

// "Let CLI agents use this computer" (ai/cli-access.js) on: Claude Code keeps its own built-in tools (no
// --tools "" and no dontAsk) and works in the chosen folder; only Lumen's MCP server is loaded still
// (--strict-mcp-config), so the user's other MCP servers are not. Ask before running commands (the default)
// is Claude Code's own permission flow: --permission-mode default, with every request that isn't
// pre-approved sent to Lumen's approval_prompt tool (--permission-prompt-tool, see mcp.js APPROVAL_TOOL), which
// shows the same approval card as any Lumen action. Off: --permission-mode bypassPermissions, no prompts at all.
function accessArgs(access) {
  return [
    '-p',
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--input-format', 'stream-json',
    '--strict-mcp-config',
    '--allowedTools', 'mcp__lumen',
    ...(access.askBefore ? ['--permission-mode', 'default', '--permission-prompt-tool', 'mcp__lumen__approval_prompt'] : ['--permission-mode', 'bypassPermissions']),
  ];
}

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
function buildArgs({ mcpConfig, sessionId, resume, systemPrompt, model = 'default', maxTurns = 0, access = null }) {
  return [
    ...(access?.enabled ? accessArgs(access) : ARGS_BASE),
    ...(maxTurns > 0 ? ['--max-turns', String(maxTurns)] : []), // unset: no cap
    ...(model !== 'default' && validModel(model) ? ['--model', model] : []),
    '--mcp-config', mcpConfig, '--system-prompt', systemPrompt, resume ? '--resume' : '--session-id', sessionId,
  ];
}

// A CLI kept for the chat's next message is stopped after this long without one.
const IDLE_MS = 10 * 60 * 1000;
// A process pre-warmed on composer focus (agent.js prewarm) that no message has taken is released after this long.
const PREWARM_IDLE_MS = 3 * 60 * 1000;
// After a pre-warmed process dies unused (a broken CLI, no sign-in), pre-warming pauses this long, doubling per
// repeat up to the max; a successful turn resets it.
const WARM_BACKOFF_MS = 5 * 60 * 1000;
const WARM_BACKOFF_MAX_MS = 30 * 60 * 1000;
// A message whose process says nothing (no stdout line, no Lumen tool call in flight) for this long
// is ended with an error; the next message starts the process again with --resume.
const WATCHDOG_MS = 90 * 1000;
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
const accessKey = (access) => (access?.enabled ? [1, access.askBefore ? 1 : 0, access.folder || ''] : 0);
const procKey = ({ bin, sessionId, systemPrompt, model = 'default', maxTurns = 0, access = null }) => JSON.stringify([bin, sessionId, model, maxTurns, accessKey(access), crypto.createHash('sha256').update(String(systemPrompt).replace(/Today's date is \d{4}-\d\d-\d\d\./g, "Today's date is (today).")).digest('hex')]);

// A step row shown while the model is still writing a tool call's input (a long fill_form or batch):
// it appears after EARLY_STEP_MS, and Lumen's MCP side takes it over when the call arrives
// (claimStep, features/ai-agents.js mcpCallTool). A call that arrives sooner gets its usual row.
const EARLY_STEP_MS = 300;
const EARLY_LABELS = { navigate: 'Opening a page', open_tab: 'Opening a tab', click: 'Clicking', click_at: 'Clicking', type_text: 'Typing', press_key: 'Pressing a key', fill_form: 'Filling in a form', batch: 'Running steps', read_page: 'Reading the page', find: 'Searching the page', web_search: 'Searching the web', read_urls: 'Reading pages', screenshot: 'Taking a screenshot', run_script: 'Running a script on the page' };
const earlyLabel = (name) => EARLY_LABELS[name] || `Using ${String(name).replace(/_/g, ' ')}`;

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
  constructor({ userData, mcpCommand, ensureServer, gate = null, keepAlive = true, idleMs = IDLE_MS, watchdogMs = WATCHDOG_MS, interruptMs = INTERRUPT_MS, onFresh = null, prewarmIdleMs = PREWARM_IDLE_MS, warmBackoffMs = WARM_BACKOFF_MS, warmBackoffMaxMs = WARM_BACKOFF_MAX_MS, spawn: spawnChild = spawn, kill = killTree }) {
    this.kind = 'claudecode';
    this.prewarmIdleMs = prewarmIdleMs;
    this.warmBackoffMs = warmBackoffMs;
    this.warmBackoffMaxMs = warmBackoffMaxMs;
    this.warmBlock = { until: 0, delay: 0 }; // pre-warm pause after unused warm processes died (warmFailed)
    this.watchdogMs = watchdogMs;
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
  async spawnProc({ bin, key, sessionId, resume, systemPrompt, model, maxTurns, access = null }) {
    const tag = crypto.randomBytes(18).toString('hex');
    let http = null;
    if (this.gate) {
      try { const server = await this.gate(); if (server) http = { server, ...server.open(tag) }; } catch {} // no HTTP server: the stdio bridge
    }
    if (!http) this.ensureServer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cc-'));
    const mcpConfig = path.join(dir, 'mcp.json');
    fs.writeFileSync(mcpConfig, JSON.stringify(mcpConfigFor({ http, bridge: http ? null : this.mcpCommand(), userData: this.userData, tag })), { mode: 0o600 });
    const argv = buildArgs({ mcpConfig, sessionId, resume, systemPrompt, model, maxTurns, access });
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    // single: takes one message, then stdin closes. A turn cap (--max-turns) may count across a
    // process's messages, so a capped chat gets a fresh (pre-started) process per message instead.
    // usage: perTurnResult's state (cumulative-or-per-turn totals); drain: set while an interrupted turn's
    // leftover output is being read off (take() waits for it).
    const proc = { key, tag, http, dir, child: null, single: !this.keepAlive || maxTurns > 0, spent: false, turns: 0, exited: false, code: null, stderr: '', turn: null, idle: null, usage: { last: null, perTurn: false }, drain: null };
    proc.fresh = { sessionId, resume }; // onFresh's args, run when a message takes this process (turn)
    // The CLI may name the session it continues differently from the id it was started with (a
    // resumed session forked): the process is then kept for the id the chat saves.
    proc.rekey = (id) => { proc.key = procKey({ bin, sessionId: id, systemPrompt, model, maxTurns, access }); };
    const finish = (code) => {
      if (proc.exited) return;
      proc.exited = true;
      proc.code = code;
      clearTimeout(proc.idle);
      if (this.proc === proc) this.proc = null;
      if (proc.warmed && !proc.turns && !proc.disposed) this.warmFailed(); // a pre-warmed process died on its own, unused
      try { http?.server.close(tag); } catch {}
      fs.rm(dir, { recursive: true, force: true }, () => {});
      proc.turn?.exit(code);
    };
    try {
      proc.child = this.spawn(bin, argv, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: childEnv, cwd: access?.enabled ? this.accessDir(access) : dir }); // an empty folder (no project settings or files), or the folder the user chose for full access
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
      const key = procKey({ bin, ...opts });
      let p = this.proc;
      if (p?.drain) { emit?.({ type: 'status', text: 'Finishing the stopped step…' }); await p.drain; p = this.proc; } // a stopped turn's leftover lines are read off first (said on screen: up to interruptMs)
      if (!fresh && p && !p.exited && !p.spent && !p.turn && p.key === key) { clearTimeout(p.idle); return p; }
      if (p && !p.turn) this.dispose(p);
      const proc = await this.spawnProc({ bin, key, ...opts });
      if (!proc.exited) this.proc = proc;
      return proc;
    });
    this.starting = next;
    return next;
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

  // The working folder of a full-access process: the chosen folder when it still exists, else the home folder.
  accessDir(access) {
    const { workingFolder } = require('./cli-access');
    const dir = workingFolder(access);
    try { if (fs.statSync(dir).isDirectory()) return dir; } catch { /* gone: the home folder */ }
    return os.homedir();
  }

  async turn({ prompt, images = [], sessionId, resume, systemPrompt, model = 'default', maxTurns = 0, access = null, signal, emit, runAgent = null, quietExpired = false, lateUsage = null, prestart = true }, { fresh = false } = {}) {
    const notInstalled = () => {
      emit({ type: 'error', text: `Claude Code isn't installed. ${INSTALL_HINT}` });
      return { text: '', sessionId: null, failed: true };
    };
    if (!await this.ensureBin()) return notInstalled();
    const proc = await this.take({ sessionId, resume, systemPrompt, model, maxTurns, access }, { fresh, emit });
    if (!proc) return notInstalled();
    // The read cache is reset for a process only once a message uses it (spawnProc kept the args): a
    // pre-started one that no message takes must not wipe the chat's reads.
    if (proc.fresh) { const f = proc.fresh; proc.fresh = null; try { this.onFresh?.(f); } catch {} }
    const reused = proc.turns > 0;
    if (!reused) emit({ type: 'status', text: 'Starting Claude Code…' }); // (its first message: the working line says why it waits)
    proc.turns++;
    const { tag } = proc;
    // tools: Lumen tool calls this message made (callBegin); inflight: those still running; dog/arm: the watchdog.
    const active = { tag, emit, signal, child: proc.child, agent: runAgent, tools: 0, inflight: 0, dog: null, arm: null };
    this.active = active;

    let text = '';
    let finalText = '';
    let result = null;
    let newSession = sessionId;
    let rateLimit = null; // the plan's limits as of this turn (rate_limit_event), for the Usage panel
    let settle;
    const ended = new Promise((resolve) => { settle = resolve; });
    let sent = false; // the message went into stdin
    let over = false; // the turn has ended (the watchdog stays off)
    let stalled = false;
    // Watchdog: any line from the CLI restarts it; it is off while a Lumen tool call runs (an approval card
    // can wait on the user). A CLI that says nothing for watchdogMs is hung: end it and say so.
    active.arm = () => {
      clearTimeout(active.dog);
      if (!this.watchdogMs || over || active.inflight > 0) return;
      active.dog = setTimeout(() => { stalled = true; this.dispose(proc); settle({ code: null }); }, this.watchdogMs);
    };
    const handle = (msg) => {
      active.arm();
      if (msg.type === 'rate_limit_event' && msg.rate_limit_info) {
        rateLimit = msg.rate_limit_info;
        emit({ type: 'rate_limit', info: rateLimit });
      } else if (msg.type === 'system' && msg.subtype === 'init') {
        newSession = msg.session_id || newSession;
        const lumen = (msg.mcp_servers || []).find((s) => s.name === 'lumen');
        if (lumen && lumen.status !== 'connected') emit({ type: 'notice', text: `Claude Code could not connect to Lumen (${lumen.status}).` });
      } else if (msg.type === 'stream_event') {
        const e = msg.event || {};
        // Each text block (one per turn around a tool call) starts a new paragraph, on screen and in
        // the saved reply alike; joined bare they ran together ("I'll check.The price is…").
        if (e.type === 'content_block_start' && e.content_block?.type === 'text') { if (text && !/\n\n$/.test(text)) text += '\n\n'; emit({ type: 'text_block' }); }
        else if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') this.earlyStep(e.content_block, emit);
        else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') { text += e.delta.text; emit({ type: 'text', text: e.delta.text }); }
        else if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') emit({ type: 'thinking', text: e.delta.thinking });
      } else if (msg.type === 'assistant') {
        const t = (msg.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
        if (t) finalText = t;
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
      // Only when the caller knows the next message will want the same process (prestart: a picked model, or
      // an auto-routed top tier that can't go higher); otherwise it would start for a key that may not match.
      const next = { sessionId: newSession, resume: true, systemPrompt, model, maxTurns, access };
      const go = () => setImmediate(() => this.warm(next));
      if (proc.exited) go(); else proc.child.once('close', go);
    }

    if (signal.aborted) return { text: text || finalText, sessionId: newSession, stopped: true };
    if (code === 'ENOENT') { this.bin = null; return notInstalled(); }
    if (stalled) {
      emit({ type: 'error', text: `Claude Code stopped responding for ${Math.round(this.watchdogMs / 1000)} seconds, so Lumen ended it. Send your message again to pick up where it left off.` });
      return { text, sessionId: newSession, failed: true, rateLimit };
    }
    // Sent again on a fresh process only when nothing ran: a turn that called a tool may have acted already.
    if (!result && reused && !fresh && !text && !finalText && active.tools === 0) return { retry: true };
    // What this message cost, not the process's running total (perTurnResult in cli-utils.js).
    const counted = result ? perTurnResult(result, proc.usage) : null;
    const usage = usageOf(counted);
    // The turn cap is not a failure: keep the session so "continue" resumes it (agent.js shows the notice).
    if (turnLimitHit(result)) return { text: text || finalText, sessionId: newSession, limit: true, cost: counted.total_cost_usd, usage, rateLimit };
    if (!ok) {
      // A resumed session that no longer exists: forget it so the next message starts fresh.
      const expired = /no conversation found|session.*not found/i.test(`${result?.result || ''}${(result?.errors || []).join('\n')}${proc.stderr}`);
      if (expired && resume && quietExpired && !text) return { text: '', sessionId: null, failed: true, expired: true, usage, rateLimit };
      emit({ type: 'error', ...describeFailure(result?.result || (result?.errors || []).join('\n') || proc.stderr, code) });
      return { text, sessionId: expired ? null : newSession, failed: true, usage, rateLimit };
    }
    return { text: text || finalText || String(result.result || ''), sessionId: newSession, cost: counted.total_cost_usd, usage, rateLimit };
  }
}

module.exports = { ClaudeCodeEngine, findClaude, buildArgs, accessArgs, MODELS, stdinMessage, describeFailure, killTree, INSTALL_HINT, parseAuthStatus, mcpConfigFor, procKey, lineReader, earlyLabel, IDLE_MS, EARLY_STEP_MS };
