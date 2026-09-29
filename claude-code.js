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
  '--input-format', 'stream-json', // one JSONL user message on stdin, so it can carry image blocks
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

// The argv for one message (exported for tests and the report; never joined into a shell string).
// A resumed session takes --model too: it applies to the rest of the session, as /model does.
function buildArgs({ mcpConfig, sessionId, resume, systemPrompt, model = 'default' }) {
  return [
    ...ARGS_BASE,
    ...(model !== 'default' && validModel(model) ? ['--model', model] : []),
    '--mcp-config', mcpConfig, '--append-system-prompt', systemPrompt, resume ? '--resume' : '--session-id', sessionId,
  ];
}

// The one stream-json line written to stdin for a turn: text first, then any images, in the same
// Anthropic image-block shape the API engines use (see agent.js runOnce). The CLI reads exactly one
// user turn per run (-p), so there's no need for more than one JSONL line before closing stdin.
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
    execFile(bin, ['auth', 'status', '--json'], { shell: false, windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(err ? { signedIn: 'unknown', accountType: null, detail: null } : parseAuthStatus(stdout));
    });
  });
}

class ClaudeCodeEngine {
  // mcpCommand(): { command, args, env } for Lumen's bridge. ensureServer(): starts the MCP server.
  constructor({ userData, mcpCommand, ensureServer }) {
    this.userData = userData;
    this.mcpCommand = mcpCommand;
    this.ensureServer = ensureServer;
    this.bin = undefined; // undefined: not looked up yet; null: not installed
    this.active = null; // { tag, emit, signal } for the run in progress
    this.statusCache = null; // { at, value } from checkAuthStatus; a 30s TTL avoids a CLI spawn per render
  }

  async detect(refresh = false) {
    if (this.bin === undefined || refresh) this.bin = await findClaude();
    return this.bin;
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

  // True when an MCP session belongs to the run in progress (its bridge carries our tag).
  owns(tag) {
    return Boolean(tag && this.active && tag.length === this.active.tag.length && crypto.timingSafeEqual(Buffer.from(tag), Buffer.from(this.active.tag)));
  }

  // One message. Resolves { text, sessionId }; errors are emitted, not thrown.
  async run({ prompt, images = [], sessionId, resume, systemPrompt, model = 'default', signal, emit }) {
    const bin = await this.detect(true);
    if (!bin) {
      emit({ type: 'error', text: `Claude Code isn't installed. ${INSTALL_HINT}` });
      return { text: '', sessionId: null, failed: true };
    }
    this.ensureServer();
    const tag = crypto.randomBytes(18).toString('hex');
    const { command, args, env } = this.mcpCommand();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cc-'));
    const mcpConfig = path.join(dir, 'mcp.json');
    fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { lumen: { command, args, env: { ...env, LUMEN_USERDATA: this.userData, LUMEN_ENGINE: tag } } } }), { mode: 0o600 });

    const argv = buildArgs({ mcpConfig, sessionId, resume, systemPrompt, model });
    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(bin, argv, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: childEnv, cwd: dir }); // an empty folder: no project settings or files
    this.active = { tag, emit, signal, child };
    const onAbort = () => killTree(child); // the CLI starts the MCP bridge as a child, so end the whole tree
    signal.addEventListener('abort', onAbort, { once: true });

    let text = '';
    let finalText = '';
    let result = null;
    let newSession = sessionId;
    let stderr = '';
    let buffer = '';
    let rateLimit = null; // the plan's limits as of this turn (rate_limit_event), for the Usage panel
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
        else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') { text += e.delta.text; emit({ type: 'text', text: e.delta.text }); }
        else if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') emit({ type: 'thinking', text: e.delta.thinking });
        // tool_use blocks are not shown here: Lumen's MCP side emits one step row per call.
      } else if (msg.type === 'assistant') {
        const t = (msg.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
        if (t) finalText = t;
      } else if (msg.type === 'result') {
        result = msg;
        newSession = msg.session_id || newSession;
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        if (process.env.LUMEN_CC_DEBUG) fs.appendFileSync(process.env.LUMEN_CC_DEBUG, `${line}\n`);
        try { handle(JSON.parse(line)); } catch {}
      }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.stdin.on('error', () => {});
    child.stdin.end(`${JSON.stringify(stdinMessage(prompt, images))}\n`);

    const code = await new Promise((resolve) => {
      child.on('error', (err) => { stderr += `\n${err.message}`; resolve(err.code === 'ENOENT' ? 'ENOENT' : -1); });
      child.on('close', (c) => resolve(c));
    });
    signal.removeEventListener('abort', onAbort);
    if (this.active?.tag === tag) this.active = null;
    fs.rm(dir, { recursive: true, force: true }, () => {});

    if (signal.aborted) return { text: text || finalText, sessionId: newSession, stopped: true };
    if (code === 'ENOENT') {
      this.bin = null;
      emit({ type: 'error', text: `Claude Code isn't installed. ${INSTALL_HINT}` });
      return { text: '', sessionId: null, failed: true };
    }
    const usage = usageOf(result);
    if (!result || result.is_error || result.subtype !== 'success') {
      emit({ type: 'error', ...describeFailure(result?.result || (result?.errors || []).join('\n') || stderr, code) });
      // A resumed session that no longer exists: forget it so the next message starts fresh.
      return { text, sessionId: /no conversation found|session.*not found/i.test(`${result?.result || ''}${stderr}`) ? null : newSession, failed: true, usage, rateLimit };
    }
    return { text: text || finalText || String(result.result || ''), sessionId: newSession, cost: result.total_cost_usd, usage, rateLimit };
  }
}

module.exports = { ClaudeCodeEngine, findClaude, buildArgs, MODELS, stdinMessage, describeFailure, killTree, INSTALL_HINT, parseAuthStatus };
