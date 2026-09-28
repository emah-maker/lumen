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
// ---------------------------------------------------------------------------------------------
// WHO ENFORCES WHAT (grok 1.0.41, measured 2026-09-28)
// ---------------------------------------------------------------------------------------------
// Enforced by Grok (its own flags and config, which have changed between CLI versions): which MCP
// servers load (GROK_HOME's config.toml), which built-ins exist (--disallowed-tools, --deny), and
// whether a call may run (--allow lumen__* / search_tool, [permission], --permission-mode dontAsk).
// These are the only things that keep a non-Lumen tool from running.
//
// Enforced by Lumen, whatever Grok's rules say:
//  - Tool calls are watched (toolWatch): the first one that isn't Lumen's (isLumenTool: lumen__*,
//    search_tool, or use_tool naming lumen__*) kills the grok process tree and ends the message
//    with an error; the chat's Grok session is dropped. This is DETECTION, not prevention: Grok
//    starts a tool as it reports it. With a second MCP server allowed on purpose, its tools/call
//    reached that server 1 ms after the use_tool event in one run, and 1 ms BEFORE it in another,
//    killed at once with child.kill(); a terminal command's file appeared ~490 ms after its
//    tool_use event (spawning the shell), and taskkill /T took ~300 ms. So Lumen can cut a run
//    short, not stop a call Grok's own rules let through. That is why the picker still says unsafe.
//  - The environment (buildEnv / ENV_KEEP): only what a process needs to start and reach the
//    network; no API keys, tokens or the user's own GROK_* settings.
//  - The working folder is a Lumen-owned empty folder (also the child's HOME), stdin is closed and
//    only stdout/stderr pipes are shared. Calls to Lumen's own tools still go through Lumen's
//    site approvals (features/ai-agents.js mcpCallTool), as for any agent.
//
// Grok Build is offered as unsafe and experimental for those reasons.
//
// ---------------------------------------------------------------------------------------------
// LUMEN'S TOOLS ON THE FIRST MESSAGE (grok 1.0.41, measured 2026-09-28)
// ---------------------------------------------------------------------------------------------
// Grok starts MCP servers with the session and gives them a short grace before the first model
// call ("strategy: Blocking"; --debug logs `wait_for_mcp_handshakes_until ... DeadlineExpired
// elapsed_ms=2007`), then goes on without whatever is still connecting. search_tool then answers
// `"status": "partial", "note": "Some MCP servers are still connecting"` with no results, and the
// model replies without Lumen's tools. Lumen's bridge is Lumen's own executable in Node mode, and
// its first start after a while took ~2.5 s here (later ones ~50 ms), so a chat's first message
// could lose that race. No flag or documented key waits longer: startup_timeout_sec /
// GROK_MCP_STARTUP_TIMEOUT_SECS bound the handshake itself (with the latter at 60 the grace was
// still 2 s), and mcp_servers[].status in system/init is taken before the grace. Nor is "lumen
// connected by the first model event" enough: the model was told lumen was still connecting when
// the grace ran out, and in one run said so ("Lumen is still connecting...") after the bridge had
// come up during its thinking. So on a chat's first message run() holds back what Grok streams and:
//  - reads Grok's own log line for that wait (RUST_LOG narrowed to it, on stderr; mcpWait), which
//    comes before the model call and names the servers connected by then. lumen among them: go
//    on. lumen not among them: that grok is stopped unseen and the message is sent once more, as a
//    new session, by which time the bridge starts warm;
//  - should that line never come (another CLI version), falls back to Lumen's own view: held
//    output is let through once Lumen's MCP server has listed its tools to this run's bridge
//    (lumenReady, by run tag), and a reply or tool call that starts before that means a retry.
// Later messages resume a session and are not held: their bridge starts warm (and a retry would
// repeat the message in that session).
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
const { exists, lookup, killTree, validModel } = require('./cli-utils');

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
// real run showed it: "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\n...", and
// signed out "You are not authenticated.\n\nDefault model: grok-4.6". Lumen never parses auth.json.
// The same output lists the models the account can use, which the picker offers (`-m <id>`):
// "Available models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6".
function parseGrokModels(stdout) {
  const t = String(stdout || '');
  if (/you are logged in/i.test(t)) {
    const m = /Default model:\s*(\S+)/i.exec(t);
    const list = t.split(/Available models:/i)[1] || '';
    const models = [...new Set([...list.matchAll(/^\s*[*-]\s+(\S+)/gm)].map((x) => x[1]).filter(validModel))];
    return { signedIn: true, detail: m ? m[1] : null, models };
  }
  if (/not logged in|not authenticated|please (sign|log) in|run `grok login`/i.test(t)) return { signedIn: false, detail: null, models: [] };
  return { signedIn: 'unknown', detail: null, models: [] };
}
// Runs `grok models` the way a sidebar run starts grok (GrokBuildEngine.status): Lumen's GROK_HOME
// with the user's auth.json linked in, buildEnv's environment and the sidebar folder as cwd, so the
// default model it reports is the one runs get. The user's own ~/.grok (config.toml, GROK_DEFAULT_MODEL
// in their environment, ...) can name another default, which runs never see. `grok models` doesn't
// start MCP servers; it writes only to that GROK_HOME (its first-run files, the first time: ~2 s).
function checkAuthStatus(bin, { env, cwd, exec = execFile }) {
  return new Promise((resolve) => {
    exec(bin, ['models'], { shell: false, windowsHide: true, timeout: 20000, cwd, env }, (err, stdout) => {
      resolve(err ? { signedIn: 'unknown', detail: null, models: [] } : parseGrokModels(stdout));
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
// model: one of `grok models`' ids, or 'default' (no -m: the CLI's own default model).
function buildArgs({ promptFile, sessionId, resume, systemPrompt, cwd, model = 'default' }) {
  return [
    ...ARGS_BASE,
    ...(model !== 'default' && validModel(model) ? ['--model', model] : []),
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

// The only variables of Lumen's own environment the grok child gets: what a process needs to start
// and reach the network on each OS (system folders, temp, locale, proxies and CA files), nothing
// else. API keys, tokens and the rest of the user's shell environment stay behind, and so do the
// user's own GROK_* settings (a GROK_SANDBOX=off, say). Grok signs in from auth.json in its home, so
// it needs no secret here (XAI_API_KEY, which Grok would fall back to, is dropped too). The lumen
// bridge inherits this environment plus config.toml's [mcp_servers.lumen.env]. Case-insensitive:
// Windows spells them Path, SystemRoot, etc.
const ENV_KEEP = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|TEMP|TMP|TMPDIR|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|COMMONPROGRAMFILES\(X86\)|COMMONPROGRAMW6432|OS|PROCESSOR_ARCHITECTURE|PROCESSOR_IDENTIFIER|NUMBER_OF_PROCESSORS|USERNAME|USERDOMAIN|COMPUTERNAME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TZ|TERM|XDG_RUNTIME_DIR|__CF_USER_TEXT_ENCODING|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/i;

// The grok child's environment (see ENV_KEEP). Nothing Lumen-specific rides here: the tag goes to
// the bridge through config.toml's [mcp_servers.lumen.env], as claude-code.js does through its mcp.json.
function buildEnv({ userData, base = process.env }) {
  const home = sidebarDirFor(userData);
  const kept = Object.fromEntries(Object.entries(base).filter(([k]) => ENV_KEEP.test(k)));
  return { ...kept, ...COMPAT_ENV, GROK_HOME: grokHomeFor(userData), USERPROFILE: home, HOME: home, GROK_DISABLE_AUTOUPDATER: '1', RUST_LOG: GROK_LOG, NO_COLOR: '1' };
}

// Headless grok logs nothing to stderr by default; this turns on the one log line Lumen reads (the
// MCP wait before a model call, see mcpWait and the file header) and nothing else.
const GROK_LOG = 'off,xai_grok_shell::session::acp_session::mcp_snapshot=info';
// That line (grok 1.0.41): `wait_for_mcp_handshakes_until: done session_id=... outcome=Complete
// elapsed_ms=2 final_initializing_names=[] final_client_names=["lumen"]`, or outcome=DeadlineExpired
// with final_initializing_names=["lumen"] when the bridge was late. Returns { lumen }, whether lumen
// was connected, or null for any other line.
function mcpWait(line) {
  const m = /wait_for_mcp_handshakes_until: done\b.*\bfinal_client_names=\[([^\]]*)\]/.exec(String(line).replace(/\x1b\[[0-9;]*m/g, '')); // (colour codes, should NO_COLOR be ignored)
  return m ? { lumen: /"lumen"/.test(m[1]) } : null;
}

// Lumen's own check on every tool call Grok reports (see the file header): Lumen's tools are
// lumen__<tool>, search_tool (a search of the tool catalog, which holds only what config.toml
// connects) and use_tool naming a lumen__ tool. Anything else -- a built-in (run_terminal_command,
// edit_file, ...), a hosted server tool, another server's tool -- is not.
const LUMEN_TOOL = /^lumen__[\w-]+$/;
function isLumenTool(name, input) {
  const n = String(name || '');
  if (LUMEN_TOOL.test(n) || n === 'search_tool') return true;
  if (n === 'use_tool') return LUMEN_TOOL.test(String(input?.tool_name ?? ''));
  return false;
}
// Reads the event stream and returns a label for the first tool call that isn't Lumen's, else null.
// A plain tool is judged at content_block_start (its name is all it takes); use_tool once its input
// is known: Grok sends a tool's whole input as one input_json_delta, then content_block_stop, and a
// use_tool whose input never parses counts as not Lumen's. The finished `assistant` message is
// checked again, for a block the partial events missed.
function toolWatch() {
  const open = new Map(); // content block index -> { json } for a use_tool still being streamed
  const judge = (name, input) => (isLumenTool(name, input) ? null : name === 'use_tool' ? `use_tool ${String(input?.tool_name || '(unreadable)').slice(0, 80)}` : String(name || 'unnamed tool').slice(0, 80));
  const parse = (json) => { try { return JSON.parse(json); } catch { return undefined; } };
  return (msg) => {
    if (msg.type === 'stream_event') {
      const e = msg.event || {};
      const b = e.content_block;
      if (e.type === 'message_start') open.clear();
      else if (e.type === 'content_block_start' && /tool_use$/.test(b?.type || '')) {
        if (b.type !== 'tool_use') return judge(b.name || b.type);
        if (b.name !== 'use_tool') return judge(b.name);
        if (b.input?.tool_name) return judge('use_tool', b.input);
        open.set(e.index, { json: '' });
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta' && open.has(e.index)) {
        const block = open.get(e.index);
        block.json += e.delta.partial_json || '';
        const input = parse(block.json);
        if (input !== undefined) { open.delete(e.index); return judge('use_tool', input); }
      } else if (e.type === 'content_block_stop' && open.has(e.index)) {
        open.delete(e.index);
        return judge('use_tool', null);
      }
    } else if (msg.type === 'assistant') {
      for (const b of msg.message?.content || []) {
        if (/tool_use$/.test(b?.type || '')) { const bad = b.type === 'tool_use' ? judge(b.name, b.input) : judge(b.name || b.type); if (bad) return bad; }
      }
    }
    return null;
  };
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
  // config.toml before each message. ensureServer(): starts the MCP server. lumenReady(tag): true
  // once Lumen's MCP server has listed its tools to the bridge carrying that run tag (optional:
  // without it, the first message doesn't wait). spawn / kill / exec: the child_process spawn,
  // cli-utils killTree and child_process execFile (for status), swappable for tests.
  constructor({ userData, mcpCommand, ensureServer, lumenReady = null, spawn: spawnChild = spawn, kill = killTree, exec = execFile }) {
    this.userData = userData;
    this.mcpCommand = mcpCommand;
    this.ensureServer = ensureServer;
    this.lumenReady = lumenReady;
    this.spawn = spawnChild;
    this.kill = kill;
    this.exec = exec;
    this.bin = undefined; // undefined: not looked up yet; null: not installed
    this.active = null; // { tag, emit, signal, child } for the run in progress
    this.statusCache = null;
  }

  async detect(refresh = false) {
    if (this.bin === undefined || refresh) this.bin = await findGrok();
    return this.bin;
  }

  // { installed, signedIn: true|false|'unknown', detail, models } -- detail is the default model a
  // sidebar run gets (asked in Lumen's own GROK_HOME, see checkAuthStatus), when known (there is no
  // account-type distinction to report here, unlike Claude Code), and models the ids `grok models`
  // lists ([] when unknown).
  async status(refresh = false) {
    const bin = await this.detect(refresh);
    if (!bin) { this.statusCache = null; return { installed: false, signedIn: false, detail: null, models: [] }; }
    if (!refresh && this.statusCache && Date.now() - this.statusCache.at < 30000) return { installed: true, ...this.statusCache.value };
    const home = grokHomeFor(this.userData);
    const dir = sidebarDirFor(this.userData);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { recursive: true });
    // The sign-in is shared the way run() shares it, except during a run, whose own link stays put
    // (re-linking then could drop a token Grok just refreshed, before settleAuth copies it back).
    const userHome = userGrokHome();
    const link = !this.active;
    let authBefore = null;
    if (link) try { authBefore = linkAuth(userHome, home); } catch {}
    const value = await checkAuthStatus(bin, { env: buildEnv({ userData: this.userData }), cwd: dir, exec: this.exec });
    if (link && !this.active) try { settleAuth(userHome, home, authBefore); } catch {}
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
      emit({ type: 'error', text: `Grok Build isn't installed. ${INSTALL_HINT}` });
      return { text: '', sessionId: null, failed: true };
    }
    this.ensureServer();
    // Lumen's own GROK_HOME (see the file header): config.toml names only the `lumen` server, and
    // the user's auth.json is linked in so their sign-in works. The working folder is a separate,
    // fixed, empty folder that is also the child's HOME, so Grok finds no project files there.
    const home = grokHomeFor(this.userData);
    const dir = sidebarDirFor(this.userData);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { recursive: true });
    const promptFile = path.join(dir, `prompt-${crypto.randomBytes(9).toString('hex')}.json`);
    fs.writeFileSync(promptFile, promptBlocks(prompt, capImages(images, emit)), { mode: 0o600 });
    const args = { bin, home, dir, promptFile, resume, systemPrompt, model, signal, emit };
    try {
      // A chat's first message waits for Lumen's tools (see "LUMEN'S TOOLS ON THE FIRST MESSAGE" in
      // the file header): if the model starts answering before the lumen bridge is connected, that
      // try is stopped unseen and the message goes once more, as a new session.
      const out = await this.attempt({ ...args, sessionId, waitForLumen: !resume && Boolean(this.lumenReady) });
      return out.retry ? await this.attempt({ ...args, sessionId: crypto.randomUUID(), waitForLumen: false }) : out;
    } finally {
      try { fs.rmSync(promptFile, { force: true }); } catch {} // (dir itself is kept: the fixed sidebar folder, see above)
    }
  }

  // One grok process for run(). With waitForLumen, what it streams is held back until Grok's log
  // says lumen was connected for the model call (or, lacking that line, until lumenReady); if it
  // wasn't, or the model starts a reply or a tool call first, the process is stopped and
  // { retry: true } comes back instead.
  async attempt({ bin, home, dir, promptFile, sessionId, resume, systemPrompt, model, signal, emit, waitForLumen }) {
    const tag = crypto.randomBytes(18).toString('hex');
    const mcp = this.mcpCommand();
    fs.writeFileSync(path.join(home, 'config.toml'), grokConfig({ ...mcp, env: { ...mcp.env, LUMEN_USERDATA: this.userData, LUMEN_ENGINE: tag } }), { mode: 0o600 });
    const userHome = userGrokHome();
    let authBefore = null;
    try { authBefore = linkAuth(userHome, home); } catch {} // no login shared: the run reports "not signed in"
    const argv = buildArgs({ promptFile, sessionId, resume, systemPrompt, cwd: dir, model });
    // stdio: no stdin, and nothing of Lumen's is inherited beyond the two pipes (Node opens its own
    // handles non-inheritable). The environment is buildEnv's short list, not Lumen's own.
    const child = this.spawn(bin, argv, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: buildEnv({ userData: this.userData }), cwd: dir });
    this.active = { tag, emit, signal, child };
    // Best-effort, mirroring claude-code.js: kills our own spawned process tree. (Grok's background
    // "leader" process, `grok leader list/kill`, did not show up in Lumen's GROK_HOME in testing.)
    const onAbort = () => this.kill(child);
    signal.addEventListener('abort', onAbort, { once: true });

    let text = '';
    let finalText = '';
    let result = null;
    let newSession = sessionId;
    let stderr = '';
    let buffer = '';
    // Lumen's own tool check (see the file header): the first tool call that isn't Lumen's ends the
    // run and the process tree at once, and nothing after it reaches the sidebar.
    const watch = toolWatch();
    let offTool = null;
    // Sidebar events held back while waiting for Lumen's tools (null: not waiting, or no longer).
    let held = waitForLumen ? [] : null;
    let early = false; // the model went ahead without Lumen's tools: stopped, to be sent again
    const show = (event) => (held ? held.push(event) : emit(event));
    // Settles the wait: Lumen's tools are up (show what was held) or the model went without them.
    const lumenUp = (up) => {
      if (!held || early || offTool) return;
      if (up) { for (const event of held) emit(event); held = null; } else { early = true; this.kill(child); }
    };
    const handle = (msg) => {
      if (offTool || early) return;
      offTool = watch(msg);
      if (offTool) { this.kill(child); return; }
      if (held && this.lumenReady(tag)) lumenUp(true);
      if (held) {
        // Thinking may go on meanwhile; a reply, a tool call or the end of the turn may not.
        const block = msg.type === 'stream_event' && msg.event?.type === 'content_block_start' ? msg.event.content_block?.type : '';
        if (/^(text|tool_use|server_tool_use)$/.test(block || '') || msg.type === 'assistant' || (msg.type === 'result' && !msg.is_error)) { early = true; this.kill(child); return; }
      }
      if (msg.type === 'system' && msg.subtype === 'init') {
        newSession = msg.session_id || newSession;
        // No connection-status notice here: see file header -- mcp_servers[].status is "pending"
        // at init even when the lumen server then works, so treating that as a failure signal (the
        // way claude-code.js does) would misfire on every run.
      } else if (msg.type === 'stream_event') {
        const e = msg.event || {};
        // A new text block starts a new paragraph in the saved reply too (see claude-code.js).
        if (e.type === 'content_block_start' && e.content_block?.type === 'text') { if (text && !/\n\n$/.test(text)) text += '\n\n'; show({ type: 'text_block' }); }
        else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') { text += e.delta.text; show({ type: 'text', text: e.delta.text }); }
        else if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') show({ type: 'thinking', text: e.delta.thinking });
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
    // stderr carries Grok's own log line about its MCP wait (see buildEnv's RUST_LOG), which says
    // exactly whether lumen was connected when the model was called; it is not kept as error text.
    let errBuffer = '';
    let waitSeen = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      errBuffer += chunk;
      let i;
      while ((i = errBuffer.indexOf('\n')) >= 0) {
        const line = errBuffer.slice(0, i + 1);
        errBuffer = errBuffer.slice(i + 1);
        const wait = mcpWait(line);
        if (!wait) { stderr = (stderr + line).slice(-4000); continue; }
        if (!waitSeen) { waitSeen = true; lumenUp(wait.lumen); }
      }
      if (errBuffer.length > 4000) { stderr = (stderr + errBuffer).slice(-4000); errBuffer = ''; }
    });

    const code = await new Promise((resolve) => {
      child.on('error', (err) => { stderr += `\n${err.message}`; resolve(err.code === 'ENOENT' ? 'ENOENT' : -1); });
      child.on('close', (c) => resolve(c));
    });
    signal.removeEventListener('abort', onAbort);
    if (this.active?.tag === tag) this.active = null;
    try { settleAuth(userHome, home, authBefore); } catch {}
    stderr = (stderr + errBuffer).slice(-4000);

    if (offTool) {
      // The session is dropped (sessionId null) so the next message starts a new one instead of
      // resuming a conversation that just reached for another tool.
      emit({ type: 'error', text: `Lumen stopped Grok Build: it called a tool that isn't one of Lumen's (${offTool}). Grok reports a tool call as it starts running it, so that tool may already have run. Grok Build should only use Lumen's tools; if this keeps happening, pick another AI in the model picker.` });
      return { text, sessionId: null, failed: true };
    }
    if (signal.aborted) return { text: text || finalText, sessionId: newSession, stopped: true };
    if (early) return { retry: true };
    if (held) for (const event of held) emit(event); // ended (a failure, say) before Lumen's tools came up
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

module.exports = { GrokBuildEngine, findGrok, buildArgs, buildEnv, isLumenTool, toolWatch, mcpWait, grokConfig, grokHomeFor, linkAuth, settleAuth, promptBlocks, describeFailure, killTree, INSTALL_HINT, parseGrokModels, capImages };
