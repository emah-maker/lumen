// "Grok · your account (Grok Build)": the sidebar engine that runs the user's own `grok` CLI
// headless for each message and lets it drive Lumen through Lumen's MCP server. Mirrors
// claude-code.js as closely as Grok Build's own CLI allows; see the divergences called out below.
//
// Lumen never sees x.ai/grok.com credentials: the CLI uses its own login (`grok login`, SuperGrok or
// X Premium+). The CLI is spawned with an argv array and shell:false (the prompt goes in as an argv
// element -- see "no stdin channel" below), so user text never reaches a shell.
//
// ---------------------------------------------------------------------------------------------
// ISOLATION: what this engine can and cannot lock down, and why (verified on grok 1.0.41, 2026-09-27)
// ---------------------------------------------------------------------------------------------
// Claude Code's engine gets near-total isolation from three things working together: an empty temp
// cwd, `--strict-mcp-config` (ignore every other MCP source, use only the one per-run mcp.json this
// file writes), and `--tools ""` (no built-in tools at all). Grok Build has no equivalents for the
// first two:
//
//  - No `--mcp-config` / `--strict-mcp-config` flag exists at all. The *only* way to add a
//    still-unknown-to-grok MCP server for one run is a project-scoped `./.grok/config.toml`
//    (`grok mcp add --scope project`) -- but `grok mcp doctor` reports project-scoped servers as
//    unhealthy ("repo-local (project-scoped) server not started for an untrusted folder") until the
//    folder is trusted, and the only way to trust a folder is `--trust`, which permanently records
//    that folder's path in the user's own ~/.grok/trusted_folders.toml (confirmed by inspection: a
//    brand-new file appears there after one `--trust` run, one entry per unique path, and it is never
//    cleaned up by grok itself). Because this engine uses a fresh mkdtemp'd, then-deleted, cwd for
//    every single message (mirroring claude-code.js), using --trust here would leave one permanent,
//    never-cleaned entry in that file per message ever sent -- unacceptable. So this engine mints NO
//    MCP server of its own and never passes --trust.
//
//    Instead it reuses the *pre-existing*, user-configured `lumen` server in ~/.grok/config.toml
//    (added once, out of band, e.g. via the "Add to Grok Build" button in Settings -> You and AI,
//    which runs `grok mcp add lumen -- <Lumen --mcp bridge>`; see features/ai-agents.js AGENTS.grok
//    and mcpCommandNoEnv). That entry is user-scope, so it starts without any trust prompt. This file
//    never edits ~/.grok/config.toml and never runs `grok mcp add/remove/enable/disable`.
//
//  - Because there is no compat-disabling flag or project-scope override for it either (`[compat.claude]`
//    is a *user*-scope-only config.toml section per docs.x.ai/build/settings/reference -- project scope
//    is limited to [mcp_servers], [plugins], [permission] -- so it can't be turned off per run without
//    editing ~/.grok/config.toml, which we must not do), Grok Build ALWAYS imports the user's Claude
//    setup on top of whatever this engine asks for: `grok inspect --json` in a brand-new empty temp
//    dir showed ~/.claude/CLAUDE.md and rule files as "project instructions", ~/.claude's skills and
//    agent defs, ~/.claude/settings.local.json permission rules, and (most importantly) all 6 MCP
//    servers from ~/.claude.json (ruflo, playwright, context7, fraim, claude-code-docs, expo) --
//    *plus* the pre-existing user-scope `lumen` entry above, i.e. 7 extra MCP servers this engine did
//    not ask for and cannot turn off, on every single run. This is a real leak (those tools are
//    "known" to the model even though our --disallowed-tools/--deny below try to keep it from acting
//    on any of it) that we could not close within this task's constraints (no editing
//    ~/.grok/config.toml, no --trust, no GROK_HOME).
//
//  - Worse than a privacy leak: those 7 MCP servers connecting concurrently appears to starve the
//    model's very first turn of a ready tool list. In every live test run here, the system/init
//    event's `mcp_servers` array showed every server (ours included) stuck at status "pending" for
//    the whole run, with no later event ever resolving it, and a prompt that told the model "if a
//    tool with 'lumen' and 'ping' in its name isn't in your list, just say NOT_READY" got back
//    exactly "NOT_READY" every time -- i.e. Lumen's own tools were not visible to the model within a
//    single headless turn. We could not get a real MCP tool call to Lumen to succeed in this task's
//    run budget. This means, in practice, the first message of a new Grok Build sidebar conversation
//    may frequently answer without ever touching Lumen's tools. There is no known workaround short of
//    the (forbidden) config edits above.
//
//  - `--tools ''` (empty) did NOT shrink the advertised built-in tool list on its own (the system/init
//    event still listed every built-in). Listing them by their literal internal names in
//    --disallowed-tools (see BUILTIN_TOOLS) did shrink it -- except `run_terminal_command`, which
//    stayed listed and was actually invoked (and executed: a plain `echo` came back with real output)
//    on one run despite being named in --disallowed-tools and covered by a `--deny Bash` rule; an
//    apparently-identical second call in the same run was then denied ("User cancelled the
//    execution"). We could not explain the inconsistency in this task's budget. Treat
//    --disallowed-tools/--deny here as defense in depth, not a proven boundary the way Claude Code's
//    `--tools ""` + `--strict-mcp-config` combination is.
//
//  - There is no stdin channel for the prompt (unlike Claude Code's --input-format stream-json),
//    and -p / --prompt-json put the whole message on the command line, which overflowed Windows'
//    ~32,767-character limit once the page's content was in it (spawn ENAMETOOLONG). --prompt-file
//    takes the same JSON content blocks, images included, so the message goes in a file instead
//    (see buildArgs / promptBlocks) with the same ~8 MB image budget as claude-code.js.
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
//     -- same shape family as Claude Code's system/init, but (a) `mcp_servers[].status` was always
//        "pending" with no later update in every run we captured (see above -- do NOT treat this as
//        Claude Code's engine does, i.e. as a connection-failure signal: it would fire on every run),
//        and (b) `tools` never included any MCP-derived tool names, only built-ins.
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
//     -- when a tool call is denied under --permission-mode dontAsk, the *whole run* ends in this
//        error result rather than the agent continuing on to produce a text reply -- unlike Claude
//        Code, where a denied tool just becomes one failed step and the turn continues. So a denied
//        built-in tool here reliably means this engine's run() reports `failed: true` with no text.
//
//   Tool naming for Lumen's own MCP tools: NOT independently confirmed. We could never get the model
//   to actually call our test server's tool (see the "pending" MCP race above), across every attempt
//   in this task's budget, so the `<server>__<tool>` convention this engine's system prompt mentions
//   is stated as one of two plausible forms, not asserted as fact (see GROK_BUILD_NOTE in agent.js).
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
// real run showed it: "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\n...". Never
// reads ~/.grok/auth.json.
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
// `--tools ''` alone -- is what actually shrinks it, and why even so it is not a proven boundary.
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
// MCP tools are deferred behind search_tool / use_tool (Lumen's are lumen__<tool>), so those two stay
// and are allowed along with lumen__*; dontAsk refuses everything else.
const DENIED = ['run_terminal_command', 'spawn_subagent', 'kill_command_or_subagent', 'get_command_or_subagent_output'];
const ARGS_BASE = [
  '--output-format', 'streaming-messages-json', '--include-partial-messages',
  '--disallowed-tools', BUILTIN_TOOLS,
  ...DENIED.flatMap((t) => ['--deny', t]),
  '--allow', 'lumen__*', '--allow', 'search_tool', '--allow', 'use_tool',
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
  // mcpCommand(): accepted for structural parity with ClaudeCodeEngine (and in case a future Grok
  // Build adds a real per-run MCP config flag), but currently unused -- see the file header: this
  // engine cannot mint its own per-run MCP server without either persisting global trust state or
  // editing ~/.grok/config.toml, so it relies entirely on the pre-existing user-scope `lumen` entry.
  // ensureServer(): still essential -- it starts Lumen's own MCP acceptor so that pre-existing entry
  // has something to connect to.
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
    this.ensureServer(); // Lumen's MCP acceptor must be listening for the pre-existing `lumen` entry to reach
    const tag = crypto.randomBytes(18).toString('hex');
    // One fixed, empty folder in Lumen's data is both the working folder and the child's home
    // (USERPROFILE/HOME): Grok then finds no project files and none of the user's Claude setup (it
    // imports ~/.claude instructions, skills, permissions and ~/.claude.json MCP servers from the home
    // folder), while GROK_HOME keeps the user's real ~/.grok, so their own sign-in and the user-scope
    // `lumen` server are used as they are. Nothing in ~/.grok is read or written by Lumen. Fixed (not
    // per message) so --resume finds the session again.
    const dir = path.join(this.userData, 'grok-sidebar');
    fs.mkdirSync(dir, { recursive: true });
    const promptFile = path.join(dir, `prompt-${tag}.json`);
    fs.writeFileSync(promptFile, promptBlocks(prompt, capImages(images, emit)), { mode: 0o600 });
    const argv = buildArgs({ promptFile, sessionId, resume, systemPrompt, cwd: dir });
    // LUMEN_ENGINE/LUMEN_USERDATA ride on the *grok* child's own env, not a per-server config
    // override (there is none we can use -- see file header): this assumes grok inherits its own
    // process environment into the stdio MCP servers it spawns (standard behavior for MCP stdio
    // clients, and the only channel available), which we could not independently confirm against the
    // real Lumen bridge without either launching the Electron app or editing ~/.grok/config.toml,
    // both out of bounds for this task.
    const childEnv = { ...process.env, LUMEN_ENGINE: tag, LUMEN_USERDATA: this.userData, GROK_HOME: process.env.GROK_HOME || path.join(os.homedir(), '.grok'), USERPROFILE: dir, HOME: dir };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const child = spawn(bin, argv, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv, cwd: dir });
    this.active = { tag, emit, signal, child };
    // Best-effort, mirroring claude-code.js. Grok Build centers on a persistent background "leader"
    // process (`grok leader list/kill`, `~/.grok/leader.sock`); a `grok -p` invocation may just be a
    // thin client for it. We could not verify within this task's budget whether killing our child
    // process here also stops an in-flight turn/tool call inside that leader, or only detaches our
    // view of it -- this kills what we can reach: our own spawned process tree.
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
        // No connection-status notice here: see file header -- mcp_servers[].status was "pending"
        // in every run captured, with no later resolving event, so treating that as a failure signal
        // (the way claude-code.js does) would misfire on effectively every run.
      } else if (msg.type === 'stream_event') {
        const e = msg.event || {};
        if (e.type === 'content_block_start' && e.content_block?.type === 'text') emit({ type: 'text_block' });
        else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') { text += e.delta.text; emit({ type: 'text', text: e.delta.text }); }
        else if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') emit({ type: 'thinking', text: e.delta.thinking });
        // tool_use blocks are not shown here: Lumen's MCP side emits one step row per call.
      } else if (msg.type === 'assistant') {
        const t = (msg.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
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

    if (signal.aborted) return { text: text || finalText, sessionId: newSession, stopped: true };
    if (code === 'ENOENT') {
      this.bin = null;
      emit({ type: 'error', text: `Grok Build isn't installed. ${INSTALL_HINT}` });
      return { text: '', sessionId: null, failed: true };
    }
    if (!result || result.is_error || result.subtype !== 'success') {
      // A denied tool call ends the whole run in error here (unlike Claude Code, where it's one
      // failed step and the turn continues) -- see file header.
      const failText = (result?.errors || []).join('\n') || result?.result || stderr;
      emit({ type: 'error', ...describeFailure(failText, code) });
      return { text, sessionId: /no conversation found|session.*not found|unknown session/i.test(`${failText}\n${stderr}`) ? null : newSession, failed: true };
    }
    return { text: text || finalText || String(result.result || ''), sessionId: newSession, cost: result.total_cost_usd };
  }
}

module.exports = { GrokBuildEngine, findGrok, buildArgs, promptBlocks, describeFailure, killTree, INSTALL_HINT, parseGrokModels, capImages };
