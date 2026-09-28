// "Grok · your account (Grok Build)": the sidebar engine that runs the user's own `grok` CLI
// headless for each message and lets it drive Lumen through Lumen's MCP server. Mirrors
// claude-code.js as closely as Grok Build's own CLI allows; see the divergences called out below.
//
// Lumen never sees x.ai/grok.com credentials: the CLI uses its own login (`grok login`, SuperGrok or
// X Premium+). The CLI is spawned with an argv array and shell:false (the message goes in a file,
// --prompt-file -- see "no stdin channel" below), so user text never reaches a shell.
//
// ---------------------------------------------------------------------------------------------
// ISOLATION (verified on grok 1.0.41, 2026-09-27)
// ---------------------------------------------------------------------------------------------
// Claude Code's engine is locked down with --tools "", --strict-mcp-config and --allowedTools
// mcp__lumen. Grok Build has no --mcp-config / --strict-mcp-config flag, so the same result comes
// from GROK_HOME instead:
//
//  - GROK_HOME points at a Lumen-owned folder (<userData>/grok-home), never the user's ~/.grok. Its
//    config.toml is written by Lumen before every message (grokConfig) and names exactly one MCP
//    server, `lumen` (Lumen's own bridge, with this run's LUMEN_ENGINE tag), and turns off every
//    [compat.claude] / [compat.cursor] import, so none of the user's ~/.claude.json or Cursor MCP
//    servers, CLAUDE.md, skills, rules or hooks are loaded. The same compat switches are also set
//    in the child's environment (buildEnv), since an env var beats config.toml. `grok inspect
//    --json` with this home listed one MCP server (lumen), no hooks, skills or project instructions.
//    The user's ~/.grok/config.toml, their other MCP servers, trusted folders and sessions are not
//    read or written, and --trust is never passed.
//
//  - Sign-in lives in GROK_HOME too (auth.json). linkAuth() hard-links the user's ~/.grok/auth.json
//    into Lumen's home (a copy if the link fails, e.g. across drives), so `grok login` in a terminal
//    keeps working and nothing else of ~/.grok is shared. If Grok replaced the file during a run
//    (a token refresh) and the user's own copy hasn't changed since, the new one is copied back so
//    a rotated refresh token isn't lost. Lumen never parses the file.
//
//  - Built-in tools: --tools '' alone did NOT shrink the advertised list; naming them in
//    --disallowed-tools does, except four Grok keeps registered (DENIED), which --deny covers. Under
//    --permission-mode dontAsk, anything not allowed is refused: a run told to `echo hi > file`
//    through run_terminal_command was cancelled and wrote nothing. config.toml adds [permission]
//    deny rules (Bash, Edit, Write, WebFetch, WebSearch) as a second layer; with them the same call
//    is refused by policy and the turn goes on to a text reply. Not Read: it also gates search_tool.
//
//  - MCP tools are deferred behind search_tool / use_tool and are named <server>__<tool>. The only
//    MCP allow is lumen__* (not use_tool itself), so use_tool runs only for Lumen's tools: with a
//    second test server configured, use_tool lumen__ping ran and use_tool other__ping was refused.
//
//  - There is no stdin channel for the prompt (unlike Claude Code's --input-format stream-json),
//    and -p / --prompt-json put the whole message on the command line, which overflowed Windows'
//    ~32,767-character limit once the page's content was in it (spawn ENAMETOOLONG). --prompt-file
//    takes the same JSON content blocks, images included, so the message goes in a file instead
//    (see buildArgs / promptBlocks) with the same ~8 MB image budget as claude-code.js.
//
// Grok Build is still offered as experimental: these are Grok's own flags and config, not a
// boundary Lumen enforces, and they have changed between CLI versions.
//
// ---------------------------------------------------------------------------------------------
// VERIFIED EVENT SHAPES (--output-format streaming-messages-json --include-partial-messages, grok
// 1.0.41, captured from real headless runs against a throwaway fake MCP server in an isolated temp
// dir on 2026-09-27):
//
//   {"type":"system","subtype":"init","session_id":"<uuid>","apiKeySource":"oauth","model":"grok-4.7",
//    "cwd":"...","permissionMode":"dontAsk","tools":["run_terminal_command",...],
//    "slash_commands":[...],"mcp_servers":[{"name":"lumen","status":"pending"},...],
//    "skills":[...],"uuid":"..."}
//     -- same shape family as Claude Code's system/init, but (a) `mcp_servers[].status` is a
//        snapshot taken before the servers finish connecting: it said "pending" in every run, with
//        no later update, including runs whose lumen__ calls then succeeded (so do NOT treat it as
//        Claude Code's engine does, i.e. as a connection-failure signal), and (b) `tools` lists
//        only built-ins plus search_tool / use_tool, never the MCP tool names themselves.
//   {"type":"stream_event","event":{"type":"message_start","message":{...}}}
//   {"type":"stream_event","event":{"type":"content_block_start","index":0,
//    "content_block":{"type":"thinking","thinking":"","signature":""}}}
//   {"type":"stream_event","event":{"type":"content_block_delta","index":0,
//    "delta":{"type":"thinking_delta","thinking":"..."}}}
//   {"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text",...}}}
//   {"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"..."}}}
//   {"type":"stream_event","event":{"type":"content_block_start",...,"content_block":{"type":"tool_use","id":"call-...","name":"run_terminal_command","input":{}}}}
//    then "input_json_delta" deltas fill in `input` (Anthropic wire format's usual partial-JSON tool input streaming).
//   {"type":"assistant","message":{"id":"msg_0","role":"assistant","model":"grok-4.7",
//    "content":[{"type":"thinking",...},{"type":"text","text":"..."},{"type":"tool_use",...}],
//    "stop_reason":"tool_use"|"end_turn",...}}
//   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call-...",
//    "content":"<json-or-plain-string>","is_error":false|true}]}}
//     -- a denied/cancelled tool shows up here as is_error:true with content
//        `[{"type":"content","content":{"type":"text","text":"User cancelled the execution for tool ..."}}]`
//   {"type":"result","subtype":"success","is_error":false,"duration_ms":...,"num_turns":...,
//    "stop_reason":"end_turn","result":"<final text>","total_cost_usd":0.007...,"usage":{...},
//    "session_id":"<uuid>"}
//   {"type":"result","subtype":"error_during_execution","is_error":true,"stop_reason":"cancelled",
//    "errors":["cancelled"],"total_cost_usd":...,"session_id":"<uuid>"}
//     -- when a tool call matches no allow rule under --permission-mode dontAsk (e.g. use_tool on
//        another server), the *whole run* ends in this error result rather than the agent going on
//        to a text reply -- unlike Claude Code, where a denied tool is one failed step. run() then
//        reports `failed: true`. A call hitting a config.toml deny rule instead comes back as
//        "Tool `...` was not executed: Denied by permission policy" and the turn continues.
//
//   A Lumen tool call: search_tool finds `lumen__<tool>`, then
//   {"type":"tool_use","name":"use_tool","input":{"tool_name":"lumen__ping","tool_input":{}}} and its
//   tool_result content `{"type":"MCP","tool_name":"ping","server_name":"lumen","output":{"OkayOutput":"..."}}`.
//
//   Images via --prompt-json: confirmed working with a flat ACP-style block --
//   `{"type":"image","data":"<base64>","mimeType":"image/png"}` (same shape as this codebase's own
//   MCP `toMcpContent()`, not Anthropic's nested `source` shape) -- a tiny 1x1 PNG round-tripped
//   through a real `grok --prompt-json` call and the model engaged with the image question.
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exists, lookup, killTree } = require('./cli-utils');

const INSTALL_HINT = process.platform === 'win32'
  ? 'Install it in PowerShell with: irm https://x.ai/cli/install.ps1 | iex, then run `grok` once to sign in (needs SuperGrok or X Premium+).'
  : 'Install it with: curl -fsSL https://x.ai/cli/install.sh | bash, then run `grok` once to sign in (needs SuperGrok or X Premium+).';

// grok.exe/grok is a real executable (not an npm shim), so unlike findClaude() there is no shim to
// resolve -- just PATH, then the installer's own well-known folders.
async function findGrok() {
  if (process.env.LUMEN_GROK_BIN) return exists(process.env.LUMEN_GROK_BIN) ? process.env.LUMEN_GROK_BIN : null;
  const home = os.homedir();
  if (process.platform === 'win32') {
    for (const hit of await lookup('grok')) {
      if (/\.exe$/i.test(hit) && exists(hit)) return hit;
    }
    for (const dir of [path.join(home, '.grok', 'bin'), path.join(home, '.local', 'bin')]) {
      const exe = path.join(dir, 'grok.exe');
      if (exists(exe)) return exe;
    }
    return null;
  }
  const [hit] = await lookup('grok');
  if (hit && exists(hit)) return hit;
  for (const p of [path.join(home, '.grok', 'bin', 'grok'), path.join(home, '.local', 'bin', 'grok'), '/opt/homebrew/bin/grok', '/usr/local/bin/grok']) {
    if (exists(p)) return p;
  }
  return null;
}

// Turns a CLI failure into what the user should do about it. `text` is already the best failure
// string run() could find (result.errors, result.result, or stderr, in that order).
function describeFailure(text, code) {
  const t = String(text || '').trim();
  if (/not logged in|please (run|sign) in|run `grok login`|log ?in|oauth|authenticat/i.test(t)) {
    return { text: 'Grok Build is not signed in. Open a terminal, run `grok login`, and sign in with your SuperGrok or X Premium+ account. Lumen never sees your Grok login.' };
  }
  if (/usage limit|limit reached|rate.?limit|out of (extra )?usage|resets? (at|in)|quota/i.test(t)) {
    return { text: `Your Grok plan's usage limit is reached. ${t.split('\n')[0].slice(0, 200)}` };
  }
  return { text: `Grok Build stopped${code !== null && code !== undefined ? ` (exit ${code})` : ''}: ${t.split('\n').slice(0, 3).join(' ').slice(0, 300) || 'no output'}` };
}

// `grok models`: there is no `grok auth status --json` (no `auth`/`whoami` subcommand exists at all
// in 1.0.41 -- see `grok help`), so this is the least-bad signed-in check available, exactly as a
// real run showed it: "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\n...". Runs
// against the user's own GROK_HOME (the login linkAuth shares), and never parses auth.json itself.
function parseGrokModels(stdout) {
  const t = String(stdout || '');
  if (/you are logged in/i.test(t)) {
    const m = /Default model:\s*(\S+)/i.exec(t);
    return { signedIn: true, detail: m ? m[1] : null };
  }
  if (/not logged in|please (sign|log) in|run `grok login`/i.test(t)) return { signedIn: false, detail: null };
  return { signedIn: 'unknown', detail: null };
}
function checkAuthStatus(bin) {
  return new Promise((resolve) => {
    // cwd: os.tmpdir(), not the app's own folder -- a plain status check shouldn't pick up any
    // project-scoped .grok/config.toml that might happen to sit above Lumen's own install/dev folder.
    execFile(bin, ['models'], { shell: false, windowsHide: true, timeout: 20000, cwd: os.tmpdir() }, (err, stdout) => {
      resolve(err ? { signedIn: 'unknown', detail: null } : parseGrokModels(stdout));
    });
  });
}

// Every built-in tool name Grok Build was observed to register for a headless run (system/init
// event's `tools` array, grok 1.0.41, 2026-09-27). See the file header for why this list -- not
// `--tools ''` alone -- is what actually shrinks it.
const BUILTIN_TOOLS = [
  'run_terminal_command', 'read_file', 'search_replace', 'list_dir', 'write',
  'kill_command_or_subagent', 'todo_write', 'get_command_or_subagent_output', 'spawn_subagent',
  'scheduler_create', 'scheduler_delete', 'scheduler_list', 'monitor',
  'workflow', 'enter_plan_mode', 'exit_plan_mode', 'ask_user_question', 'send_feedback',
  'image_gen', 'image_edit', 'image_to_video', 'reference_to_video', 'grep',
].join(',');

// Verified 2026-09-27 (grok 1.0.41) with headless runs told to write a file through the terminal:
// --disallowed-tools removes every built-in except run_terminal_command, spawn_subagent and the two
// command-output helpers, which Grok keeps registered; --deny with Grok's own tool names (not Claude's
// "Bash"/"Edit", which is why an earlier run still executed a command) cancels them, and under
// dontAsk a cancelled call ends the whole run with an error: nothing ran, no file was written.
// MCP tools are deferred behind search_tool / use_tool (Lumen's are lumen__<tool>). use_tool itself is
// NOT allowed: Grok checks each use_tool call against the tool it names, so `lumen__*` lets through
// Lumen's tools and dontAsk refuses any other server's (verified: other__ping was cancelled).
const DENIED = ['run_terminal_command', 'spawn_subagent', 'kill_command_or_subagent', 'get_command_or_subagent_output'];
const ARGS_BASE = [
  '--output-format', 'streaming-messages-json', '--include-partial-messages',
  '--disallowed-tools', BUILTIN_TOOLS,
  ...DENIED.flatMap((t) => ['--deny', t]),
  '--allow', 'lumen__*', '--allow', 'search_tool',
  '--permission-mode', 'dontAsk',
  '--no-subagents', '--no-plan', '--disable-web-search',
  '--max-turns', '20',
];

// The argv for one message (exported for tests and the report; never joined into a shell string).
// The message itself goes in a file (--prompt-file), not on the command line: with the page's
// content in it, -p/--prompt-json overflowed Windows' ~32,767-character command line (spawn
// ENAMETOOLONG). --prompt-file takes the same JSON content blocks as --prompt-json, images included
// (flat ACP blocks: { type: 'image', data, mimeType }; verified 2026-09-27, a red test image came back
// "Red"). The system prompt (~4 KB) stays on the command line: there is no file form of it.
function buildArgs({ promptFile, sessionId, resume, systemPrompt, cwd }) {
  return [
    ...ARGS_BASE,
    '--cwd', cwd,
    '--system-prompt-override', systemPrompt, // full replace: Grok Build has no --append-system-prompt
    resume ? '--resume' : '--session-id', sessionId,
    '--prompt-file', promptFile,
  ];
}

// Lumen's own GROK_HOME, and the fixed empty folder that is each run's working folder and the
// child's HOME/USERPROFILE (fixed, not per message, so --resume finds the session again).
const grokHomeFor = (userData) => path.join(userData, 'grok-home');
const sidebarDirFor = (userData) => path.join(userData, 'grok-sidebar');
// The user's own Grok home, where `grok login` keeps auth.json.
const userGrokHome = () => process.env.GROK_HOME || path.join(os.homedir(), '.grok');

// Grok's imports of the user's Claude Code and Cursor setups. Off in config.toml and, because an env
// var beats config.toml, in the child's environment too.
const COMPAT_SURFACES = ['skills', 'rules', 'agents', 'mcps', 'hooks'];
const COMPAT_ENV = Object.fromEntries(['CLAUDE', 'CURSOR'].flatMap((v) => COMPAT_SURFACES.map((s) => [`GROK_${v}_${s.toUpperCase()}_ENABLED`, '0'])));

// config.toml for Lumen's GROK_HOME: only the `lumen` MCP server (mcp is mcpCommand() plus this run's
// LUMEN_ENGINE tag and LUMEN_USERDATA in env). JSON string escapes are valid TOML basic strings.
// The [marketplace] markers are the ones Grok writes after its first-run setup; set up front, Grok
// doesn't add its official plugin marketplace to this home.
function grokConfig({ command, args = [], env = {} }) {
  const str = (s) => JSON.stringify(String(s));
  const off = COMPAT_SURFACES.map((s) => `${s} = false`);
  return [
    '# Written by Lumen before every Grok Build sidebar message (grok-build.js). Edits are overwritten.',
    '[mcp_servers.lumen]',
    `command = ${str(command)}`,
    `args = [${args.map(str).join(', ')}]`,
    'enabled = true',
    '',
    '[mcp_servers.lumen.env]',
    ...Object.entries(env).map(([k, v]) => `${str(k)} = ${str(v)}`),
    '',
    '[compat.claude]', ...off, '',
    '[compat.cursor]', ...off, '',
    '[permission]',
    'allow = ["MCPTool(lumen__*)"]',
    'deny = ["Bash", "Edit", "Write", "WebFetch", "WebSearch"]',
    '',
    '[ui]', 'remember_tool_approvals = false', '',
    '[cli]', 'auto_update = false', '',
    '[marketplace]', 'default_skills_installs_purged = true', 'official_marketplace_auto_installed = true', '',
  ].join('\n');
}

// The grok child's environment. Nothing Lumen-specific rides here: the tag goes to the bridge
// through config.toml's [mcp_servers.lumen.env], as claude-code.js does through its mcp.json.
function buildEnv({ userData, base = process.env }) {
  const home = sidebarDirFor(userData);
  const env = { ...base, ...COMPAT_ENV, GROK_HOME: grokHomeFor(userData), USERPROFILE: home, HOME: home, GROK_DISABLE_AUTOUPDATER: '1' };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'GROK_CONFIG', 'GROK_CONFIG_PATH', 'LUMEN_ENGINE']) delete env[k];
  return env;
}

// Shares the user's sign-in, and only that, with Lumen's GROK_HOME (see the file header): a hard
// link to their auth.json, or a copy where linking fails. Returns what the user's file looked like,
// for settleAuth after the run.
const statOf = (p) => { try { return fs.statSync(p, { bigint: true }); } catch { return null; } };
const sameFile = (a, b) => Boolean(a && b && a.ino === b.ino && a.dev === b.dev);
function linkAuth(userHome, home) {
  const real = path.join(userHome, 'auth.json');
  const own = path.join(home, 'auth.json');
  const before = statOf(real);
  if (sameFile(before, statOf(own))) return before;
  fs.rmSync(own, { force: true });
  if (!before) return null; // signed out: the run itself reports "not signed in"
  try { fs.linkSync(real, own); } catch { fs.copyFileSync(real, own); fs.chmodSync(own, 0o600); }
  return before;
}
// After a run: if Grok replaced Lumen's auth.json (a token refresh) and the user's own file is
// untouched since linkAuth, the newer one goes back so a rotated refresh token isn't lost.
function settleAuth(userHome, home, before) {
  const real = path.join(userHome, 'auth.json');
  const own = path.join(home, 'auth.json');
  const now = statOf(real);
  const mine = statOf(own);
  if (!before || !now || !mine || sameFile(now, mine)) return false;
  if (now.mtimeNs !== before.mtimeNs || now.size !== before.size) return false; // the user signed in again meanwhile
  if (fs.readFileSync(own).equals(fs.readFileSync(real))) return false;
  fs.copyFileSync(own, real);
  return true;
}

// The --prompt-file contents: the text, then any images.
function promptBlocks(prompt, images = []) {
  return JSON.stringify([
    { type: 'text', text: prompt },
    ...images.map((img) => ({ type: 'image', data: img.data, mimeType: img.media_type })),
  ]);
}

// Images ride in the prompt file, so the budget is the model request's, like claude-code.js: keeps
// the newest images first (mirrors capHistoryImages in agent.js) and drops the oldest past ~8 MB.
const GB_IMAGE_BUDGET = 8 * 1024 * 1024; // base64 chars, combined
function capImages(images, emit) {
  let used = 0;
  const kept = [];
  let dropped = 0;
  for (let i = images.length - 1; i >= 0; i--) {
    const img = images[i];
    if (used + img.data.length > GB_IMAGE_BUDGET) { dropped++; continue; }
    used += img.data.length;
    kept.unshift(img);
  }
  if (dropped) emit({ type: 'notice', text: `Left out ${dropped} older image${dropped === 1 ? '' : 's'}: too much to send at once.` });
  return kept;
}

class GrokBuildEngine {
  // mcpCommand(): { command, args, env } for Lumen's bridge, written into Lumen's own GROK_HOME
  // config.toml before each message. ensureServer(): starts the MCP server.
  constructor({ userData, mcpCommand, ensureServer }) {
    this.userData = userData;
    this.mcpCommand = mcpCommand;
    this.ensureServer = ensureServer;
    this.bin = undefined; // undefined: not looked up yet; null: not installed
    this.active = null; // { tag, emit, signal, child } for the run in progress
    this.statusCache = null;
  }

  async detect(refresh = false) {
    if (this.bin === undefined || refresh) this.bin = await findGrok();
    return this.bin;
  }

  // { installed, signedIn: true|false|'unknown', detail } -- detail is the CLI's reported default
  // model, when known (there is no account-type distinction to report here, unlike Claude Code).
  async status(refresh = false) {
    const bin = await this.detect(refresh);
    if (!bin) { this.statusCache = null; return { installed: false, signedIn: false, detail: null }; }
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
  async run({ prompt, images = [], sessionId, resume, systemPrompt, signal, emit }) {
    const bin = await this.detect(true);
    if (!bin) {
      emit({ type: 'error', text: `Grok Build isn't installed. ${INSTALL_HINT}` });
      return { text: '', sessionId: null, failed: true };
    }
    this.ensureServer();
    const tag = crypto.randomBytes(18).toString('hex');
    // Lumen's own GROK_HOME (see the file header): config.toml names only the `lumen` server, and
    // the user's auth.json is linked in so their sign-in works. The working folder is a separate,
    // fixed, empty folder that is also the child's HOME, so Grok finds no project files there.
    const home = grokHomeFor(this.userData);
    const dir = sidebarDirFor(this.userData);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { recursive: true });
    const mcp = this.mcpCommand();
    fs.writeFileSync(path.join(home, 'config.toml'), grokConfig({ ...mcp, env: { ...mcp.env, LUMEN_USERDATA: this.userData, LUMEN_ENGINE: tag } }), { mode: 0o600 });
    const userHome = userGrokHome();
    let authBefore = null;
    try { authBefore = linkAuth(userHome, home); } catch {} // no login shared: the run reports "not signed in"
    const promptFile = path.join(dir, `prompt-${tag}.json`);
    fs.writeFileSync(promptFile, promptBlocks(prompt, capImages(images, emit)), { mode: 0o600 });
    const argv = buildArgs({ promptFile, sessionId, resume, systemPrompt, cwd: dir });
    const child = spawn(bin, argv, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: buildEnv({ userData: this.userData }), cwd: dir });
    this.active = { tag, emit, signal, child };
    // Best-effort, mirroring claude-code.js: kills our own spawned process tree. (Grok's background
    // "leader" process, `grok leader list/kill`, did not show up in Lumen's GROK_HOME in testing.)
    const onAbort = () => killTree(child);
    signal.addEventListener('abort', onAbort, { once: true });

    let text = '';
    let finalText = '';
    let result = null;
    let newSession = sessionId;
    let stderr = '';
    let buffer = '';
    const handle = (msg) => {
      if (msg.type === 'system' && msg.subtype === 'init') {
        newSession = msg.session_id || newSession;
        // No connection-status notice here: see file header -- mcp_servers[].status is "pending"
        // at init even when the lumen server then works, so treating that as a failure signal (the
        // way claude-code.js does) would misfire on every run.
      } else if (msg.type === 'stream_event') {
        const e = msg.event || {};
        // A new text block starts a new paragraph in the saved reply too (see claude-code.js).
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
        if (process.env.LUMEN_GB_DEBUG) fs.appendFileSync(process.env.LUMEN_GB_DEBUG, `${line}\n`);
        try { handle(JSON.parse(line)); } catch {}
      }
    });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });

    const code = await new Promise((resolve) => {
      child.on('error', (err) => { stderr += `\n${err.message}`; resolve(err.code === 'ENOENT' ? 'ENOENT' : -1); });
      child.on('close', (c) => resolve(c));
    });
    signal.removeEventListener('abort', onAbort);
    if (this.active?.tag === tag) this.active = null;
    try { fs.rmSync(promptFile, { force: true }); } catch {} // (dir itself is kept: the fixed sidebar folder, see above)
    try { settleAuth(userHome, home, authBefore); } catch {}

    if (signal.aborted) return { text: text || finalText, sessionId: newSession, stopped: true };
    if (code === 'ENOENT') {
      this.bin = null;
      emit({ type: 'error', text: `Grok Build isn't installed. ${INSTALL_HINT}` });
      return { text: '', sessionId: null, failed: true };
    }
    if (!result || result.is_error || result.subtype !== 'success') {
      // A tool call outside the allow rules ends the whole run in error here (unlike Claude Code,
      // where it's one failed step and the turn continues) -- see file header.
      const failText = (result?.errors || []).join('\n') || result?.result || stderr;
      emit({ type: 'error', ...describeFailure(failText, code) });
      return { text, sessionId: /no conversation found|session.*not found|unknown session/i.test(`${failText}\n${stderr}`) ? null : newSession, failed: true };
    }
    return { text: text || finalText || String(result.result || ''), sessionId: newSession, cost: result.total_cost_usd };
  }
}

module.exports = { GrokBuildEngine, findGrok, buildArgs, buildEnv, grokConfig, grokHomeFor, linkAuth, settleAuth, promptBlocks, describeFailure, killTree, INSTALL_HINT, parseGrokModels, capImages };
