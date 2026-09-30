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
const { exists, lookup, killTree, validModel, usageOf } = require('./cli-utils');
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
function buildArgs({ mcpConfig, sessionId, resume, systemPrompt, model = 'default', maxTurns = 0 }) {
  return [
    ...ARGS_BASE,
    ...(maxTurns > 0 ? ['--max-turns', String(maxTurns)] : []), // unset: no cap
    ...(model !== 'default' && validModel(model) ? ['--model', model] : []),
    '--mcp-config', mcpConfig, '--system-prompt', systemPrompt, resume ? '--resume' : '--session-id', sessionId,
  ];
}

// A CLI kept for the chat's next message is stopped after this long without one.
const IDLE_MS = 10 * 60 * 1000;

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
// turn cap and system prompt (a new chat, a model or settings change starts another one).
const procKey = ({ bin, sessionId, systemPrompt, model = 'default', maxTurns = 0 }) => JSON.stringify([bin, sessionId, model, maxTurns, crypto.createHash('sha256').update(String(systemPrompt)).digest('hex')]);

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
  constructor({ userData, mcpCommand, ensureServer, gate = null, keepAlive = true, idleMs = IDLE_MS, spawn: spawnChild = spawn, kill = killTree }) {
    this.kind = 'claudecode';
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
  async spawnProc({ bin, key, sessionId, resume, systemPrompt, model, maxTurns }) {
    const tag = crypto.randomBytes(18).toString('hex');
    let http = null;
    if (this.gate) {
      try { const server = await this.gate(); if (server) http = { server, ...server.open(tag) }; } catch {} // no HTTP server: the stdio bridge
    }
    if (!http) this.ensureServer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cc-'));
    const mcpConfig = path.join(dir, 'mcp.json');
    fs.writeFileSync(mcpConfig, JSON.stringify(mcpConfigFor({ http, bridge: http ? null : this.mcpCommand(), userData: this.userData, tag })), { mode: 0o600 });
    const argv = buildArgs({ mcpConfig, sessionId, resume, systemPrompt, model, maxTurns });
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    // single: takes one message, then stdin closes. A turn cap (--max-turns) may count across a
    // process's messages, so a capped chat gets a fresh (pre-started) process per message instead.
    const proc = { key, tag, http, dir, child: null, single: !this.keepAlive || maxTurns > 0, spent: false, turns: 0, exited: false, code: null, stderr: '', turn: null, idle: null };
    // The CLI may name the session it continues differently from the id it was started with (a
    // resumed session forked): the process is then kept for the id the chat saves.
    proc.rekey = (id) => { proc.key = procKey({ bin, sessionId: id, systemPrompt, model, maxTurns }); };
    const finish = (code) => {
      if (proc.exited) return;
      proc.exited = true;
      proc.code = code;
      clearTimeout(proc.idle);
      if (this.proc === proc) this.proc = null;
      try { http?.server.close(tag); } catch {}
      fs.rm(dir, { recursive: true, force: true }, () => {});
      proc.turn?.exit(code);
    };
    try {
      proc.child = this.spawn(bin, argv, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: childEnv, cwd: dir }); // an empty folder: no project settings or files
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
  take(opts, { fresh = false } = {}) {
    const next = (this.starting || Promise.resolve()).catch(() => {}).then(async () => {
      const bin = await this.ensureBin();
      if (!bin) return null;
      const key = procKey({ bin, ...opts });
      const p = this.proc;
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
  warm(opts) {
    if (this.busy || this.active || !this.keepAlive) return;
    this.take(opts).then((p) => { if (p && !p.exited && !p.turn) this.idleLater(p); }).catch(() => {});
  }

  idleLater(proc) {
    clearTimeout(proc.idle);
    proc.idle = setTimeout(() => this.dispose(proc), this.idleMs);
    proc.idle.unref?.();
  }

  // Ends a process (default: the kept one) with its whole tree (the stdio bridge is its child); its
  // MCP token stops working at once.
  dispose(proc = this.proc) {
    if (!proc) return;
    clearTimeout(proc.idle);
    if (this.proc === proc) this.proc = null;
    try { proc.http?.server.close(proc.tag); } catch {}
    if (!proc.exited && proc.child) this.kill(proc.child);
  }

  // The chat was switched, cleared or rewound (agent.js onEngineReset), or a background task ended:
  // an idle kept CLI goes. One mid-message stays, and one that took its last message ends by itself.
  release() {
    if (this.proc && !this.proc.turn && !this.proc.spent) this.dispose();
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

  async turn({ prompt, images = [], sessionId, resume, systemPrompt, model = 'default', maxTurns = 0, signal, emit, runAgent = null, quietExpired = false }, { fresh = false } = {}) {
    const notInstalled = () => {
      emit({ type: 'error', text: `Claude Code isn't installed. ${INSTALL_HINT}` });
      return { text: '', sessionId: null, failed: true };
    };
    if (!await this.ensureBin()) return notInstalled();
    const proc = await this.take({ sessionId, resume, systemPrompt, model, maxTurns }, { fresh });
    if (!proc) return notInstalled();
    const reused = proc.turns > 0;
    if (!reused) emit({ type: 'status', text: 'Starting Claude Code…' }); // (its first message: the working line says why it waits)
    proc.turns++;
    const { tag } = proc;
    this.active = { tag, emit, signal, child: proc.child, agent: runAgent };

    let text = '';
    let finalText = '';
    let result = null;
    let newSession = sessionId;
    let rateLimit = null; // the plan's limits as of this turn (rate_limit_event), for the Usage panel
    let settle;
    const ended = new Promise((resolve) => { settle = resolve; });
    const handle = (msg) => {
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
    proc.turn = { handle, exit: (code) => settle({ code }) };
    if (proc.exited) settle({ code: proc.code });
    // Stop: the whole tree goes (the stdio bridge is the CLI's child), and the reply ends now.
    const onAbort = () => { this.dispose(proc); settle({ code: null }); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    if (!proc.exited && !signal.aborted) {
      proc.child.stdin.write(`${JSON.stringify(stdinMessage(prompt, images))}\n`);
      if (proc.single) { proc.spent = true; proc.child.stdin.end(); }
    }

    const { code } = await ended;
    signal.removeEventListener('abort', onAbort);
    proc.turn = null;
    this.clearEarly(emit);
    if (this.active?.tag === tag) this.active = null;
    const ok = Boolean(result && !result.is_error && result.subtype === 'success');
    if (!proc.single) {
      if (ok && !signal.aborted && !proc.exited) { if (newSession) proc.rekey(newSession); this.idleLater(proc); } // kept for the chat's next message
      else this.dispose(proc); // a failed or capped turn: the next message starts clean (--resume)
    } else if (ok && this.keepAlive && !signal.aborted) {
      // A capped chat: its next message's process starts now, resuming this session, once this one has ended.
      const next = { sessionId: newSession, resume: true, systemPrompt, model, maxTurns };
      const go = () => setImmediate(() => this.warm(next));
      if (proc.exited) go(); else proc.child.once('close', go);
    }

    if (signal.aborted) return { text: text || finalText, sessionId: newSession, stopped: true };
    if (code === 'ENOENT') { this.bin = null; return notInstalled(); }
    if (!result && reused && !fresh && !text && !finalText) return { retry: true };
    const usage = usageOf(result);
    // The turn cap is not a failure: keep the session so "continue" resumes it (agent.js shows the notice).
    if (turnLimitHit(result)) return { text: text || finalText, sessionId: newSession, limit: true, cost: result.total_cost_usd, usage, rateLimit };
    if (!ok) {
      // A resumed session that no longer exists: forget it so the next message starts fresh.
      const expired = /no conversation found|session.*not found/i.test(`${result?.result || ''}${(result?.errors || []).join('\n')}${proc.stderr}`);
      if (expired && resume && quietExpired && !text) return { text: '', sessionId: null, failed: true, expired: true, usage, rateLimit };
      emit({ type: 'error', ...describeFailure(result?.result || (result?.errors || []).join('\n') || proc.stderr, code) });
      return { text, sessionId: expired ? null : newSession, failed: true, usage, rateLimit };
    }
    return { text: text || finalText || String(result.result || ''), sessionId: newSession, cost: result.total_cost_usd, usage, rateLimit };
  }
}

module.exports = { ClaudeCodeEngine, findClaude, buildArgs, MODELS, stdinMessage, describeFailure, killTree, INSTALL_HINT, parseAuthStatus, mcpConfigFor, procKey, lineReader, earlyLabel, IDLE_MS, EARLY_STEP_MS };
