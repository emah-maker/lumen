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
//    server, `lumen` (served by Lumen itself over local HTTP, mcp-http.js), and turns off every
//    [compat.claude] / [compat.cursor] import, so none of the user's ~/.claude.json or Cursor MCP
//    servers, CLAUDE.md, skills, rules or hooks are loaded. The same compat switches are also set
//    in the child's environment (buildEnv), since an env var beats config.toml. `grok inspect
//    --json` with this home lists one MCP server (lumen, http), Lumen's two gate hooks and no
//    skills or project instructions.
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
// 1. Lumen's gate, before any tool runs. config.toml gives Grok two command hooks (gateScript, a
//    one-line curl) that post UserPromptSubmit and every PreToolUse to Lumen (mcp-http.js). Grok
//    runs PreToolUse hooks before its own permission checks and before the tool, and blocks on a
//    deny; MCP calls show under their real name (lumen__navigate), not as use_tool. Lumen allows
//    search_tool and lumen__<one of its tools>, and denies everything else.
//    - Grok's hooks fail open (a crashed or timed-out hook allows), so the script exits 2, Grok's
//      deny, when it can't reach Lumen, and an unknown or expired run token gets a deny.
//    - Grok's HTTP hooks refuse http:// URLs ("SSRF protection"), hence the curl script.
//    - A Grok that didn't load the hooks at all is stopped by Lumen: the gate must have seen this
//      turn's UserPromptSubmit (which comes before the model call) before the model's first
//      output, or the process tree is killed before a tool call can even be streamed.
//    Measured with Grok's own rules taken away (always-approve, no --deny, Lumen's stream check
//    off; test/grokgate.js): a run told to write a file with run_terminal_command got "Hook denied"
//    and wrote nothing. The same run with the gate unreachable through a script without the exit 2
//    DID write the file, which is what the exit 2 and the UserPromptSubmit check are for.
// 2. Grok's own rules, as before: which MCP servers load (GROK_HOME's config.toml), which built-ins
//    exist (--disallowed-tools, --deny), and whether a call may run (--allow lumen__* / search_tool,
//    [permission], --permission-mode dontAsk).
// 3. Lumen's stream check (toolWatch), as a last line: the first reported tool call that isn't
//    Lumen's (isLumenTool) kills the grok process tree and ends the message with an error; the
//    chat's Grok session is dropped. On its own this is detection, not prevention: Grok starts a
//    tool as it reports it (a file appeared ~490 ms after its tool_use event; taskkill took ~300 ms).
// Also: the environment (buildEnv / ENV_KEEP) is only what a process needs to start and reach the
// network, plus XAI_API_KEY and this run's gate URL and MCP token; the working folder is a
// Lumen-owned empty folder (also the child's HOME), stdin is closed and only stdout/stderr pipes are
// shared. Calls to Lumen's own tools still go through Lumen's site approvals
// (features/ai-agents.js mcpCallTool), as for any agent.
//
// What is left: the gate is enforced inside Grok's process (Grok runs the hook and honours its
// answer), so a Grok that skipped its own hooks AND its own permission rules could still run a tool
// before Lumen's stream check stops it. That is why the engine stays "experimental". Grok's OS
// sandbox (--sandbox) would add a kernel-level layer on macOS and Linux; it isn't used yet (untested
// here), and Grok has none on Windows.
//
// ---------------------------------------------------------------------------------------------
// LUMEN'S TOOLS ON THE FIRST MESSAGE (grok 1.0.41, measured 2026-09-28)
// ---------------------------------------------------------------------------------------------
// Grok starts MCP servers with the session and gives them a short grace before the first model
// call ("strategy: Blocking"; --debug logs `wait_for_mcp_handshakes_until ... DeadlineExpired
// elapsed_ms=2007`), then goes on without whatever is still connecting; search_tool then finds
// nothing and the model replies without Lumen's tools. No flag or documented key waits longer.
// Lumen used to be reached through a bridge (Lumen's own executable in Node mode), whose cold start
// took ~2.5 s and lost that race. Now Lumen serves MCP itself over local HTTP (mcp-http.js), which
// is already listening: Grok's tools/list was answered ~2.4 s after spawn, before UserPromptSubmit
// and ~1 s before the first model event. The gate also holds its UserPromptSubmit answer (up to
// 8 s) until this run has listed Lumen's tools. As a fallback, a chat's first message still holds
// back what Grok streams and:
//  - reads Grok's own log line for that wait (RUST_LOG narrowed to it, on stderr; mcpWait), which
//    comes before the model call and names the servers connected by then. lumen among them: go
//    on. lumen not among them: that grok is stopped unseen and the message is sent once more, as a
//    new session;
//  - should that line never come (another CLI version), falls back to Lumen's own view: held
//    output is let through once Lumen has listed its tools to this run (lumenReady, by run tag),
//    and a reply or tool call that starts before that means a retry.
// Later messages resume a session and are not held (a retry would repeat the message there).
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
// ---------------------------------------------------------------------------------------------
// FULL ACCESS (Settings > AI > "Give Grok Build full access to this computer", grokBuildFullAccess, off by default)
// ---------------------------------------------------------------------------------------------
// The user's own opt-in to run Grok Build in the sidebar the way it runs in a terminal. Everything above describes the
// default (off); with it on a sidebar run differs in exactly these ways, and nothing else of the default changes:
//  - argv (ARGS_FULL): --always-approve and --permission-mode bypassPermissions, and none of --disallowed-tools, --deny,
//    --allow, --no-subagents, --no-plan, --disable-web-search. Both flags and the mode value are listed by `grok --help`
//    (1.0.44: "--always-approve  Auto-approve all tool executions"; "--permission-mode ... [possible values: default,
//    acceptEdits, auto, dontAsk, bypassPermissions, plan]"). VERIFIED from the help text only: no model call was made with
//    them. Not passed: --sandbox (its profile names are not in --help; Grok's own default, or the user's GROK_SANDBOX, applies).
//    If a Grok build rejects one, grok exits with a usage error before doing anything and the run says so plainly
//    (cli-utils.js fullAccessRejected); it never carries on without the flags.
//  - config.toml (grokConfig({ fullAccess })) has no [permission] deny rules; the gate hooks are still written.
//  - the gate (mcp-http.js fullGateDecision) lets Grok's own tools through without Lumen's approval card, but still denies
//    any `lumen__*` name that is not one of Lumen's tools, and the UserPromptSubmit check still stops a run whose hooks did
//    not load. Lumen's own tools are unchanged: they go through the MCP server (callTool), so site approvals, the approval
//    card and "Don't let the AI act on my pages" apply to them exactly as before.
//  - the stream check (toolWatch) is off (Grok's own tools are expected), the working folder and HOME are the user's home
//    folder, and the child gets the user's whole environment instead of ENV_KEEP's short list. GROK_HOME stays Lumen's, so
//    the user's own ~/.grok config, MCP servers and skills are still not loaded; their sign-in is linked as before.
//  - the inactivity watchdog allows FULL_WATCHDOG_MS: a long shell command prints nothing while it runs.
//  - the system prompt (replaced, as always) says so in agent.js's GROK_BUILD_FULL_NOTE.
// A background task never gets full access (nobody is there to watch it): the engine ignores the setting when `background`.

const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exists, lookup, killTree, validModel, usageOf, fullAccessRejected } = require('./cli-utils');
const { turnLimitHit } = require('./loop-guard');
const effortLib = require('./effort'); // Settings → AI → AI providers: reasoning effort per AI
const { isLimitText, limitOf } = require('../features/grok-limit');

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
function describeFailure(text, code, { fullAccess = false } = {}) {
  const t = String(text || '').trim();
  if (fullAccess) { const rejected = fullAccessRejected(t, { name: 'Grok Build', setting: 'Give Grok Build full access to this computer' }); if (rejected) return rejected; }
  if (/not logged in|please (run|sign) in|run `grok login`|log ?in|oauth|authenticat/i.test(t)) {
    return { text: 'Grok Build is not signed in. Open a terminal, run `grok login`, and sign in with your SuperGrok or X Premium+ account. Lumen never sees your Grok login.' };
  }
  if (isLimitText(t)) {
    return { text: `Your Grok plan's usage limit is reached. ${t.split('\n')[0].slice(0, 200)}` };
  }
  return { text: `Grok Build stopped${code !== null && code !== undefined ? ` (exit ${code})` : ''}: ${t.split('\n').slice(0, 3).join(' ').slice(0, 300) || 'no output'}` };
}

// The model's real context window and auto-compaction threshold. Grok's streaming result names the
// window only "when known" (its docs) and a real 1.0.41 run did not: `modelUsage` had no
// contextWindow. The catalog Grok keeps in its home does: models_cache.json, { models: { <id>: {
// info: { context_window, auto_compact_threshold_percent } } } }. The result names the model
// "grok-4.7-build" where the catalog says "grok-4.7", so a trailing "-build" is tried without.
function modelInfoFrom(cache, ids) {
  const models = cache?.models || {};
  for (const id of ids) {
    for (const key of [id, String(id || '').replace(/-build$/, '')]) {
      const info = models[key]?.info;
      const contextWindow = Number(info?.context_window);
      if (contextWindow > 0) {
        const compact = Number(info.auto_compact_threshold_percent);
        return { contextWindow, compactPercent: compact > 0 && compact <= 100 ? compact : null };
      }
    }
  }
  return null;
}
function readModelInfo(home, ids) {
  try { return modelInfoFrom(JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8')), ids); } catch { return null; }
}
// What Lumen logs for one Grok turn (see cli-utils usageOf). `lastCall` is the usage of the turn's
// last model call (the final `assistant` message): the context window's fill after the turn is
// that call's whole input, not the turn's summed input, which counts a long tool loop's context
// once per call. Reasoning tokens are part of output_tokens (`grok usage`: total = input + output).
function grokUsage(result, { lastCall = null, info = null } = {}) {
  const usage = usageOf(result);
  if (!usage) return null;
  if (!usage.contextWindow && info?.contextWindow) usage.contextWindow = info.contextWindow;
  if (info?.compactPercent) usage.compactPercent = info.compactPercent;
  if (lastCall && typeof lastCall === 'object') {
    usage.contextTokens = (Number(lastCall.input_tokens) || 0) + (Number(lastCall.cache_read_input_tokens) || 0) + (Number(lastCall.cache_creation_input_tokens) || 0);
  }
  return usage;
}

// `grok models`: there is no `grok auth status --json` (no `auth`/`whoami` subcommand exists at all
// in 1.0.41 -- see `grok help`), so this is the least-bad signed-in check available, exactly as a
// real run showed it: "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\n...", and
// signed out "You are not authenticated.\n\nDefault model: grok-4.6". Lumen never parses auth.json.
// The same output lists the models the account can use, which the picker offers (`-m <id>`):
// "Available models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6".
function parseGrokModels(stdout) {
  const t = String(stdout || '');
  if (/you are logged in|you are using XAI_API_KEY/i.test(t)) {
    const m = /Default model:\s*(\S+)/i.exec(t);
    const list = t.split(/Available models:/i)[1] || '';
    const models = [...new Set([...list.matchAll(/^\s*[*-]\s+(\S+)/gm)].map((x) => x[1]).filter(validModel))];
    return { signedIn: true, detail: m ? m[1] : null, models };
  }
  if (/not logged in|not authenticated|please (sign|log) in|run `grok login`/i.test(t)) return { signedIn: false, detail: null, models: [] };
  return { signedIn: 'unknown', detail: null, models: [] };
}
// When `grok models` gives no list (it timed out, an older CLI printed another layout, ...) while the
// account isn't known to be signed out, the picker still offers models: the last list this engine
// got, else the ids of Grok's own catalog in Lumen's GROK_HOME (models_cache.json, see
// modelInfoFrom), else these, the ones a real `grok models` listed (1.0.41). A pick the account
// can't use fails with Grok's own error, as any other unavailable model would.
const FALLBACK_MODELS = ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6'];
function modelsFallback({ last = [], home = null } = {}) {
  if (last.length) return last;
  let catalog = [];
  try { catalog = Object.keys(JSON.parse(fs.readFileSync(path.join(home, 'models_cache.json'), 'utf8'))?.models || {}).filter(validModel); } catch {}
  return catalog.length ? catalog : FALLBACK_MODELS;
}
// The model a run actually used, as Grok reports it: the init event's `model` (the resolved name,
// even when the pick was the default or an alias), else the reply's own assistant message's, else
// the one model the result's modelUsage names. Null when the stream named none.
function servedModel({ init = null, assistant = null, result = null } = {}) {
  const usage = Object.keys(result?.modelUsage || {});
  const m = init || assistant || (usage.length === 1 ? usage[0] : null);
  return m && validModel(m) ? m : null;
}
// The notice a reply starts with when the model answering is not the one the chat last showed, the
// way Claude Code's auto-picked model is shown ("Auto · Sonnet", features/model-route.js):
// "Default · grok-4.7" on Grok's default, "<pick> · <served>" when a picked alias resolved to another
// name. Nothing when the served model is the picked one or was already shown in this chat.
function modelNotice({ picked = 'default', served = null, shown = null } = {}) {
  if (!served || served === shown) return null;
  if (picked !== 'default' && picked === served) return null;
  return `${picked === 'default' ? 'Default' : picked} · ${served}`;
}
// Runs `grok models` the way a sidebar run starts grok (GrokBuildEngine.status): Lumen's GROK_HOME
// with the user's auth.json linked in, buildEnv's environment and the sidebar folder as cwd, so the
// default model it reports is the one runs get. The user's own ~/.grok (config.toml, GROK_DEFAULT_MODEL
// in their environment, ...) can name another default, which runs never see. `grok models` doesn't
// start MCP servers; it writes only to that GROK_HOME (its first-run files, the first time: ~2 s).
// Who `grok models` says is signed in: "You are logged in with grok.com." -> 'grok.com'; "You are using XAI_API_KEY." -> 'XAI_API_KEY'. null otherwise.
function grokAccountOf(stdout) {
  const m = /you are logged in with ([^\n.]+)|you are using (XAI_API_KEY)/i.exec(String(stdout || ''));
  return m ? (m[1] || m[2]).trim().slice(0, 60) : null;
}
function checkAuthStatus(bin, { env, cwd, exec = execFile }) {
  return new Promise((resolve) => {
    try {
      exec(bin, ['models'], { shell: false, windowsHide: true, timeout: 20000, cwd, env }, (err, stdout) => {
        resolve(err ? { signedIn: 'unknown', detail: null, models: [] } : { ...parseGrokModels(stdout), account: grokAccountOf(stdout) });
      });
    } catch { resolve({ signedIn: 'unknown', detail: null, models: [] }); } // a file that can't be executed at all (spawn EFTYPE)
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
// run_terminal_command is not in DENIED: Lumen's PreToolUse gate (mcp-http.js terminalDecision) asks
// the user for it per call instead of refusing it outright, so it needs an --allow rule here too (layer
// 2 -- Grok's own dontAsk -- still runs after the gate's allow, and refuses anything --allow doesn't
// name). The other three stay hard-denied: no approval flow exists for them.
const DENIED = ['spawn_subagent', 'kill_command_or_subagent', 'get_command_or_subagent_output'];
// Grok always gets a cap (a headless run must end); this is it when Max steps per task is Unlimited.
const DEFAULT_MAX_TURNS = 100;
// A Grok process silent on stdout this long, with no Lumen tool call running, is hung (claude-code.js WATCHDOG_MS).
const WATCHDOG_MS = 90 * 1000;
// Before a chat's first message's first stdout line, Grok may legitimately wait for Lumen's MCP tools (its own wait,
// logged on stderr): the pre-output phase gets this much on top of the watchdog.
const FIRST_WAIT_EXTRA_MS = 60 * 1000;
// A background task's grok (features/background-runner.js) has nobody to ask in the moment and gets no
// shell at all: run_terminal_command is denied like the other three, and not allowed.
const argsBase = (background = false) => [
  '--output-format', 'streaming-messages-json', '--include-partial-messages',
  '--disallowed-tools', BUILTIN_TOOLS,
  ...(background ? [...DENIED, 'run_terminal_command'] : DENIED).flatMap((t) => ['--deny', t]),
  '--allow', 'lumen__*', '--allow', 'search_tool', ...(background ? [] : ['--allow', 'run_terminal_command']),
  '--permission-mode', 'dontAsk',
  '--no-subagents', '--no-plan', '--disable-web-search',
];
const ARGS_BASE = argsBase(false);
// [full access] See "FULL ACCESS" in the file header: Grok Build's own tools, approved without asking.
const ARGS_FULL = [
  '--output-format', 'streaming-messages-json', '--include-partial-messages',
  '--always-approve',
  '--permission-mode', 'bypassPermissions',
];
// A silent shell command (a build, an install) prints nothing for a long time: with full access the watchdog waits this long.
const FULL_WATCHDOG_MS = 15 * 60 * 1000;

// The argv for one message (exported for tests and the report; never joined into a shell string).
// The message itself goes in a file (--prompt-file), not on the command line: with the page's
// content in it, -p/--prompt-json overflowed Windows' ~32,767-character command line (spawn
// ENAMETOOLONG). --prompt-file takes the same JSON content blocks as --prompt-json, images included
// (flat ACP blocks: { type: 'image', data, mimeType }; verified 2026-09-27, a red test image came back
// "Red"). The system prompt (~2-3 KB) stays on the command line: there is no file form of it.
// model: one of `grok models`' ids, or 'default' (no -m: the CLI's own default model).
// fullAccess: [full access] ARGS_FULL instead of the lockdown (never for a background task).
function buildArgs({ promptFile, sessionId, resume, systemPrompt, cwd, model = 'default', maxTurns = 0, background = false, fullAccess = false, effort = '' }) {
  return [
    ...(background ? argsBase(true) : fullAccess ? ARGS_FULL : ARGS_BASE),
    '--max-turns', String(maxTurns > 0 ? maxTurns : DEFAULT_MAX_TURNS), // hitting it ends in a "continue" notice (turnLimitHit), not an error
    ...(model !== 'default' && validModel(model) ? ['--model', model] : []),
    ...effortLib.cliArgs('grokbuild', effort), // Settings → AI → AI providers: --reasoning-effort (none: Grok's own default)
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

// config.toml for Lumen's GROK_HOME: only the `lumen` MCP server, served by Lumen itself over local
// HTTP (mcp-http.js), and Lumen's tool gate as UserPromptSubmit and PreToolUse hooks (gateScript).
// The URLs and tokens are this run's and live only in the child's environment (buildEnv), which
// Grok expands in the url, headers and the hook's command; nothing secret is written here. JSON
// string escapes are valid TOML basic strings. The [marketplace] markers are the ones Grok writes
// after its first-run setup; set up front, Grok doesn't add its official plugin marketplace.
// [full access] fullAccess: no [permission] deny rules (Grok's own tools are the user's to run); the hooks stay.
function grokConfig({ gate, fullAccess = false }) {
  const str = (s) => JSON.stringify(String(s));
  const off = COMPAT_SURFACES.map((s) => `${s} = false`);
  const hook = `hooks = [{ type = "command", command = ${str(gate)}, timeout = 30 }]`;
  return [
    '# Written by Lumen before every Grok Build sidebar message (grok-build.js). Edits are overwritten.',
    '[mcp_servers.lumen]',
    'url = "${LUMEN_MCP_URL}"',
    'headers = { "Authorization" = "Bearer ${LUMEN_MCP_TOKEN}" }',
    'enabled = true',
    '',
    '[[hooks.UserPromptSubmit]]', hook, '',
    '[[hooks.PreToolUse]]', hook, '',
    '[compat.claude]', ...off, '',
    '[compat.cursor]', ...off, '',
    '[permission]',
    'allow = ["MCPTool(lumen__*)"]',
    ...(fullAccess ? [] : ['deny = ["Bash", "Edit", "Write", "WebFetch", "WebSearch"]']),
    '',
    '[ui]', 'remember_tool_approvals = false', '',
    '[cli]', 'auto_update = false', '',
    '[marketplace]', 'default_skills_installs_purged = true', 'official_marketplace_auto_installed = true', '',
  ].join('\n');
}

// The only variables of Lumen's own environment the grok child gets: what a process needs to start
// and reach the network on each OS (system folders, temp, locale, proxies and CA files), nothing
// else. API keys, tokens and the rest of the user's shell environment stay behind, and so do the
// user's own GROK_* settings (a GROK_SANDBOX=off, say). The one secret kept is XAI_API_KEY, Grok's
// own sign-in for API-key users (Grok prefers auth.json's session when both exist); with the tool
// gate, Grok has no tool that could read it back. Case-insensitive:
// Windows spells them Path, SystemRoot, etc.
const ENV_KEEP = /^(XAI_API_KEY|PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|TEMP|TMP|TMPDIR|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|COMMONPROGRAMFILES\(X86\)|COMMONPROGRAMW6432|OS|PROCESSOR_ARCHITECTURE|PROCESSOR_IDENTIFIER|NUMBER_OF_PROCESSORS|USERNAME|USERDOMAIN|COMPUTERNAME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TZ|TERM|XDG_RUNTIME_DIR|__CF_USER_TEXT_ENCODING|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/i;

// The grok child's environment (see ENV_KEEP). `run`: this run's { mcpUrl, mcpToken, hookUrl } from
// Lumen's HTTP gate (mcp-http.js), which config.toml and the gate script read from here.
// home / dir: a background run's own GROK_HOME and working folder (default: the sidebar's).
// [full access] fullAccess: the user's whole environment (as in a terminal, minus Electron's own switch) and their real
// home folder as HOME; GROK_HOME stays Lumen's (the user's ~/.grok config is not loaded).
function buildEnv({ userData, base = process.env, run = null, home: grokHome = grokHomeFor(userData), dir: workDir = sidebarDirFor(userData), fullAccess = false }) {
  const home = fullAccess ? os.homedir() : workDir;
  const kept = fullAccess ? Object.fromEntries(Object.entries(base).filter(([k, v]) => k !== 'ELECTRON_RUN_AS_NODE' && typeof v === 'string')) : Object.fromEntries(Object.entries(base).filter(([k]) => ENV_KEEP.test(k)));
  const gate = run ? { LUMEN_MCP_URL: run.mcpUrl, LUMEN_MCP_TOKEN: run.mcpToken, LUMEN_HOOK_URL: run.hookUrl } : {};
  return { ...kept, ...COMPAT_ENV, ...gate, GROK_HOME: grokHome, USERPROFILE: home, HOME: home, GROK_DISABLE_AUTOUPDATER: '1', RUST_LOG: GROK_LOG, NO_COLOR: '1' };
}

// The hook command Grok runs for UserPromptSubmit and PreToolUse: hands the event (stdin) to
// Lumen's gate and prints Lumen's answer. Grok treats a failed hook as "allow", so a gate that
// can't be reached exits 2, which Grok treats as a deny (curl -f: any non-2xx fails too). Grok's
// HTTP hooks accept https:// only, hence curl (in Windows since 10 1803, macOS and most Linux);
// without it the run is never armed and grok-build.js stops it before the model's first output.
const GATE_FILE = process.platform === 'win32' ? 'lumen-gate.cmd' : 'lumen-gate.sh';
function gateScript(platform = process.platform) {
  return platform === 'win32'
    ? '@"%SystemRoot%\\System32\\curl.exe" -s -f --max-time 25 -H "Content-Type: application/json" --data-binary @- "%LUMEN_HOOK_URL%" || exit /b 2\r\n'
    : '#!/bin/sh\ncurl -s -f --max-time 25 -H "Content-Type: application/json" --data-binary @- "$LUMEN_HOOK_URL" || exit 2\n';
}

// Headless grok logs nothing to stderr by default; this turns on the one log line Lumen reads (the
// MCP wait before a model call, see mcpWait and the file header) and nothing else.
const GROK_LOG = 'off,xai_grok_shell::session::acp_session::mcp_snapshot=info';
// That line (grok 1.0.41): `wait_for_mcp_handshakes_until: done session_id=... outcome=Complete
// elapsed_ms=2 final_initializing_names=[] final_client_names=["lumen"]`, or outcome=DeadlineExpired
// with final_initializing_names=["lumen"] when Lumen was late. Returns { lumen }, whether lumen
// was connected, or null for any other line.
function mcpWait(line) {
  const m = /wait_for_mcp_handshakes_until: done\b.*\bfinal_client_names=\[([^\]]*)\]/.exec(String(line).replace(/\x1b\[[0-9;]*m/g, '')); // (colour codes, should NO_COLOR be ignored)
  return m ? { lumen: /"lumen"/.test(m[1]) } : null;
}

// Lumen's own check on every tool call Grok reports (see the file header): Lumen's tools are
// lumen__<tool>, search_tool (a search of the tool catalog, which holds only what config.toml
// connects) and use_tool naming a lumen__ tool. run_terminal_command is also let through here: it's
// gated per call by the PreToolUse hook (mcp-http.js terminalDecision), which the user has already
// answered by the time Grok reports it in the stream -- either it ran with their approval, or the
// hook already denied it and nothing happened; this check no longer needs to kill the run over it.
// Anything else -- a built-in (edit_file, ...), a hosted server tool, another server's tool -- is not.
const LUMEN_TOOL = /^lumen__[\w-]+$/;
// terminal: whether run_terminal_command counts (false for a background run, which never gets one).
function isLumenTool(name, input, terminal = true) {
  const n = String(name || '');
  if (LUMEN_TOOL.test(n) || n === 'search_tool' || (terminal && n === 'run_terminal_command')) return true;
  if (n === 'use_tool') return LUMEN_TOOL.test(String(input?.tool_name ?? ''));
  return false;
}
// Reads the event stream and returns a label for the first tool call that isn't Lumen's, else null.
// A plain tool is judged at content_block_start (its name is all it takes); use_tool once its input
// is known: Grok sends a tool's whole input as one input_json_delta, then content_block_stop, and a
// use_tool whose input never parses counts as not Lumen's. The finished `assistant` message is
// checked again, for a block the partial events missed.
function toolWatch({ terminal = true } = {}) {
  const open = new Map(); // content block index -> { json } for a use_tool still being streamed
  const judge = (name, input) => (isLumenTool(name, input, terminal) ? null : name === 'use_tool' ? `use_tool ${String(input?.tool_name || '(unreadable)').slice(0, 80)}` : String(name || 'unnamed tool').slice(0, 80));
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

// The same two, off the main thread (run() prepares them while the page is being read). Same result.
async function linkAuthAsync(userHome, home) {
  const fsp = fs.promises;
  const stat = (p) => fsp.stat(p, { bigint: true }).catch(() => null);
  const real = path.join(userHome, 'auth.json');
  const own = path.join(home, 'auth.json');
  const before = await stat(real);
  if (sameFile(before, await stat(own))) return before;
  await fsp.rm(own, { force: true });
  if (!before) return null;
  try { await fsp.link(real, own); } catch { await fsp.copyFile(real, own); await fsp.chmod(own, 0o600); }
  return before;
}
async function settleAuthAsync(userHome, home, before) {
  const fsp = fs.promises;
  const stat = (p) => fsp.stat(p, { bigint: true }).catch(() => null);
  const real = path.join(userHome, 'auth.json');
  const own = path.join(home, 'auth.json');
  const [now, mine] = [await stat(real), await stat(own)];
  if (!before || !now || !mine || sameFile(now, mine)) return false;
  if (now.mtimeNs !== before.mtimeNs || now.size !== before.size) return false;
  const [a, b] = await Promise.all([fsp.readFile(own), fsp.readFile(real)]);
  if (a.equals(b)) return false;
  await fsp.copyFile(own, real);
  return true;
}

// [sign-in lock] Sidebar chats run Grok Build side by side (parallel CLI chats), every run in the same GROK_HOME with
// the same auth.json link. Linking again while another run is in flight could put the user's older file back over a
// token that run's Grok just refreshed (and rotated), and two copy-backs could cross. So per home there is one shared
// sign-in state: shareAuth() hands every run the same in-flight link while any run there is going (one link, not one per
// run), holdAuth() counts the runs, and only when the last one ends is the token copied back, once (settleAuthAsync).
// Background tasks have homes of their own, so they never share this.
const authShares = new Map(); // path.resolve(home) -> { runs, link, pending, before, settling, links }
function authShareOf(home) {
  const key = path.resolve(home);
  let s = authShares.get(key);
  if (!s) { s = { runs: 0, link: null, pending: false, before: null, settling: Promise.resolve(), links: 0 }; authShares.set(key, s); }
  return s;
}
// The sign-in link for a run in `home`: the one already made while runs are in flight there (or one being made now),
// else a new one, made after the last copy-back finished. Resolves what the user's file looked like (linkAuth).
function shareAuth(userHome, home) {
  const s = authShareOf(home);
  if (s.link && (s.runs > 0 || s.pending)) return s.link;
  s.pending = true;
  s.links++;
  const p = (async () => {
    await s.settling; // the last copy-back first: it may carry a refreshed token
    const before = await linkAuthAsync(userHome, home).catch(() => null); // no login shared: the run reports "not signed in"
    if (s.link === p) s.before = before;
    return before;
  })();
  s.link = p;
  p.finally(() => { if (s.link === p) s.pending = false; }).catch(() => {});
  return p;
}
// A run in `home` starts: no new link is made until it ends. The returned release() (once) ends it; the last run's end
// copies a refreshed token back to the user's file. After Lumen copies it back the user's file is Lumen's own write, so
// it becomes the new "before" (a later run's refresh is copied back too, not taken for a new sign-in).
// release.settle(): the copy-back alone, the hold kept. A kept Grok process (features/grok-warm.js) holds the sign-in
// for its whole life and copies a refreshed token back after each of its turns; copy-backs are chained, never crossed.
function holdAuth(userHome, home) {
  const s = authShareOf(home);
  s.runs++;
  let done = false;
  const copyBack = () => {
    const before = s.before;
    s.settling = s.settling.then(() => settleAuthAsync(userHome, home, before)).then(async (copied) => {
      if (copied && s.before === before) s.before = await fs.promises.stat(path.join(userHome, 'auth.json'), { bigint: true }).catch(() => before);
    }).catch(() => {});
    return s.settling;
  };
  const release = () => {
    if (done) return s.settling;
    done = true;
    s.runs = Math.max(0, s.runs - 1);
    if (s.runs > 0) return s.settling;
    return copyBack();
  };
  release.settle = () => (done ? s.settling : copyBack());
  return release;
}
const authStats = (home) => { const s = authShares.get(path.resolve(home)); return s ? { runs: s.runs, links: s.links, pending: s.pending } : { runs: 0, links: 0, pending: false }; };

// Writes a file only when its content differs (config.toml and the gate script are the same for every
// message: rewriting them cost a disk write, and on Windows a virus-scan, per message).
async function writeIfChanged(file, content, mode) {
  try { if (await fs.promises.readFile(file, 'utf8') === content) return false; } catch {}
  await fs.promises.writeFile(file, content, { mode });
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
  // gate(): resolves Lumen's HTTP MCP server and tool gate (mcp-http.js startHttp), started on
  // first use. lumenReady(tag): true once Lumen's tools have been listed to that run (default: the
  // gate's own record). spawn / kill / exec: the child_process spawn, cli-utils killTree and
  // child_process execFile (for status), swappable for tests. argsFor and watch exist for
  // test/grokgate.js only, which loosens Grok's own rules to show the gate alone stops a call.
  // background: an engine made for one background task (features/ai-agents.js backgroundEngine): its own
  // GROK_HOME (home) and working folder (dir), no terminal command at all, and its own `active` run.
  // onFresh({ sessionId, resume }): a new grok process starts (one per message), so the page reads the
  // model saw before no longer count (snapshot.js's repeat-read cache, features/ai-agents.js).
  // watchdogMs: a run whose stdout is silent this long (no Lumen tool call in flight) is hung and is ended (0: off).
  constructor({ userData, gate, lumenReady = null, onFresh = null, watchdogMs = WATCHDOG_MS, firstWaitExtraMs = FIRST_WAIT_EXTRA_MS, spawn: spawnChild = spawn, kill = killTree, exec = execFile, argsFor = buildArgs, watch = true, background = false, home = grokHomeFor(userData), dir = sidebarDirFor(userData) }) {
    this.firstWaitExtraMs = firstWaitExtraMs;
    this.kind = 'grokbuild';
    this.watchdogMs = watchdogMs;
    this.onFresh = onFresh;
    this.prep = null; // { at, promise } from prepare(): the setup a message's run() takes over
    this.settling = null; // the last run's settleAuthAsync, awaited before the next link
    this.background = background;
    this.home = home;
    this.dir = dir;
    this.userData = userData;
    this.gate = gate;
    this.lumenReady = lumenReady;
    this.argsFor = argsFor;
    this.watch = watch;
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

  // The binary for a run: the one found earlier while it is still on disk (a `where`/`which` spawn per
  // message cost tens to hundreds of ms before the first token), else a fresh look.
  async ensureBin() {
    if (this.bin && exists(this.bin)) return this.bin;
    return this.detect(true);
  }

  // { installed, signedIn: true|false|'unknown', detail, models } -- detail is the default model a
  // sidebar run gets (asked in Lumen's own GROK_HOME, see checkAuthStatus), when known (there is no
  // account-type distinction to report here, unlike Claude Code), and models the ids `grok models`
  // lists ([] when unknown).
  async status(refresh = false) {
    const bin = await this.detect(refresh);
    if (!bin) { this.statusCache = null; return { installed: false, signedIn: false, detail: null, models: [] }; }
    if (!refresh && this.statusCache && Date.now() - this.statusCache.at < 30000) return { installed: true, ...this.statusCache.value };
    const home = this.home;
    const dir = this.dir;
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { recursive: true });
    // The sign-in is shared the way run() shares it, except during a run, whose own link stays put
    // (re-linking then could drop a token Grok just refreshed, before settleAuth copies it back).
    const userHome = userGrokHome();
    const share = authShareOf(home);
    const link = !this.active && share.runs === 0 && !share.pending; // [sign-in lock] never under a run in flight
    let authBefore = null;
    if (link) try { authBefore = linkAuth(userHome, home); } catch {}
    const value = await checkAuthStatus(bin, { env: buildEnv({ userData: this.userData, home, dir }), cwd: dir, exec: this.exec });
    if (link && !this.active && share.runs === 0 && !share.pending) try { settleAuth(userHome, home, authBefore); } catch {}
    if (value.models.length) this.lastModels = value.models;
    else if (value.signedIn !== false) value.models = modelsFallback({ last: this.lastModels || [], home });
    this.statusCache = { at: Date.now(), value };
    return { installed: true, ...value };
  }

  // True when an MCP session belongs to the run in progress (its run tag is ours).
  owns(tag) {
    return Boolean(tag && this.active && tag.length === this.active.tag.length && crypto.timingSafeEqual(Buffer.from(tag), Buffer.from(this.active.tag)));
  }

  // A Lumen tool call (or a terminal-command approval) of the run starts / ends (features/ai-agents.js):
  // the watchdog waits for it (an approval card can wait on the user as long as it likes). `a`: the
  // call's own active object (see claude-code.js callBegin).
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

  // One message. Resolves { text, sessionId }; errors are emitted, not thrown.
  // runAgent: the Agent whose gate, approvals and tab this run's MCP calls use (a background task's own).
  // shownModel: the model this chat last showed (see modelNotice); the result's `model` is the one
  // Grok reports it used (servedModel), null when it named none.
  // The part of a message's setup that doesn't need the message: the binary, Lumen's HTTP gate, the
  // folders, config.toml and the gate script (written only when their content changed) and the link to
  // the user's sign-in. agent.js runTask starts it while the page is read; run() takes it over.
  // Grok has no stdin for the prompt (it is read from --prompt-file at spawn), so unlike Claude Code's
  // warm() the process itself can't start before the message is known.
  // Lumen's own GROK_HOME (see the file header): config.toml names only the `lumen` server, and the
  // user's auth.json is linked in so their sign-in works. The working folder is a separate, fixed,
  // empty folder that is also the child's HOME, so Grok finds no project files there.
  // [full access] fullAccess: config.toml without the deny rules (grokConfig); a background engine never has it.
  prepare({ fullAccess = false } = {}) {
    fullAccess = fullAccess === true && !this.background;
    if (this.prep && this.prep.fullAccess === fullAccess && Date.now() - this.prep.at < 30000) return this.prep.promise;
    const promise = (async () => {
      const bin = await this.ensureBin();
      if (!bin) return { bin: null };
      const gate = await this.gate();
      const { home, dir } = this;
      const gateFile = path.join(home, GATE_FILE);
      await Promise.all([fs.promises.mkdir(home, { recursive: true, mode: 0o700 }), fs.promises.mkdir(dir, { recursive: true })]);
      const authBefore = (await Promise.all([
        writeIfChanged(gateFile, gateScript(), 0o700),
        writeIfChanged(path.join(home, 'config.toml'), grokConfig({ gate: gateFile, fullAccess }), 0o600),
        shareAuth(userGrokHome(), home), // [sign-in lock] after the last copy-back; shared while other runs are in flight
      ]))[2];
      return { bin, gate, authBefore };
    })();
    this.prep = { at: Date.now(), promise, fullAccess };
    promise.catch(() => { if (this.prep?.promise === promise) this.prep = null; });
    return promise;
  }

  async run({ prompt, images = [], sessionId, resume, systemPrompt, model = 'default', maxTurns = 0, signal, emit, runAgent = null, scope = null, shownModel = null, fullAccess = false, quietExpired = false, effort = '' }) {
    fullAccess = fullAccess === true && !this.background; // [full access] never for a background task
    // [keep connected] Settings > AI > Keep Grok Build connected (features/grok-warm.js, off by default): the chat's own
    // long-lived `grok agent stdio` process answers. It returns null when it can't take this message (setting off, images,
    // full access, a start that failed before anything was sent): then the one-process-per-message run below does.
    if (this.keepWarm) {
      // (a chosen effort is a flag of the one-process run: a kept `grok agent stdio` keeps the effort it started with)
      const warm = fullAccess || this.background || effortLib.clean('grokbuild', effort) ? null : await this.keepWarm.run({ prompt, images, sessionId, resume, systemPrompt, model, maxTurns, signal, emit, runAgent, scope, shownModel, quietExpired });
      if (warm) return warm;
      this.keepWarm.drop(sessionId); // a kept process must not hold a stale copy of a session this run is about to extend
    }
    const prepared = this.prepare({ fullAccess }); // (the one runTask started, if it is recent)
    this.prep = null; // each message prepares afresh
    const ready = await prepared;
    // [sign-in lock] From its link on, this message counts as a run in its home (no re-link under it) until its process
    // ends; the last run there to end copies a refreshed token back.
    const releaseAuth = holdAuth(userGrokHome(), this.home);
    try {
      return await this.runReady(ready, { prompt, images, sessionId, resume, systemPrompt, model, maxTurns, signal, emit, runAgent, scope, shownModel, fullAccess, quietExpired, effort });
    } finally {
      this.settling = releaseAuth(); // not awaited: the reply doesn't wait on it (the next link does)
    }
  }

  async runReady({ bin, gate }, { prompt, images = [], sessionId, resume, systemPrompt, model = 'default', maxTurns = 0, signal, emit, runAgent = null, scope = null, shownModel = null, fullAccess = false, quietExpired = false, effort = '' }) {
    if (!bin) {
      emit({ type: 'error', text: `Grok Build isn't installed. ${INSTALL_HINT}` });
      return { text: '', sessionId: null, failed: true };
    }
    // Stop during the setup: nothing is started (attempt checks again, for a Stop during the prompt write).
    if (signal.aborted) return { text: '', sessionId, stopped: true };
    const { home, dir } = this;
    const promptFile = path.join(dir, `prompt-${crypto.randomBytes(9).toString('hex')}.json`);
    await fs.promises.writeFile(promptFile, promptBlocks(prompt, capImages(images, emit)), { mode: 0o600 });
    const args = { bin, gate, home, dir, promptFile, resume, systemPrompt, model, maxTurns, signal, emit, runAgent, scope, shownModel, fullAccess, quietExpired, effort };
    try {
      // A chat's first message waits for Lumen's tools (see "LUMEN'S TOOLS ON THE FIRST MESSAGE" in
      // the file header): if the model starts answering before Lumen's tools are connected, that
      // try is stopped unseen and the message goes once more, as a new session.
      const out = await this.attempt({ ...args, sessionId, waitForLumen: !resume });
      return out.retry ? await this.attempt({ ...args, sessionId: crypto.randomUUID(), waitForLumen: false }) : out;
    } finally {
      fs.promises.rm(promptFile, { force: true }).catch(() => {}); // (dir itself is kept: the fixed sidebar folder, see above)
    }
  }

  // One grok process for run(). With waitForLumen, what it streams is held back until Grok's log
  // says lumen was connected for the model call (or, lacking that line, until lumenReady); if it
  // wasn't, or the model starts a reply or a tool call first, the process is stopped and
  // { retry: true } comes back instead.
  async attempt({ bin, gate, home, dir, promptFile, sessionId, resume, systemPrompt, model, maxTurns, signal, emit, waitForLumen, runAgent = null, scope = null, shownModel = null, fullAccess = false, quietExpired = false, effort = '' }) {
    if (signal.aborted) return { text: '', sessionId, stopped: true }; // Stop came before the spawn: Grok never runs
    const tag = crypto.randomBytes(18).toString('hex');
    const lumenReady = this.lumenReady || ((t) => gate.listed(t));
    // This run's MCP token and gate URL (mcp-http.js), handed to Grok in its environment only.
    // sessionId is Grok's own conversation id (settings.gbSession): stable across every message in
    // this chat, so a run_terminal_command "allow for this chat" (mcp-http.js terminalDecision) can
    // outlive this one message's tag, which is fresh every time.
    const gateRun = gate.open(tag, sessionId, { fullAccess });
    try { this.onFresh?.({ sessionId, resume }); } catch {}
    const workDir = fullAccess ? os.homedir() : dir; // [full access] the home folder, as in a terminal
    const argv = this.argsFor({ promptFile, sessionId, resume, systemPrompt, cwd: workDir, model, maxTurns, background: this.background, fullAccess, effort });
    // stdio: no stdin, and nothing of Lumen's is inherited beyond the two pipes (Node opens its own
    // handles non-inheritable). The environment is buildEnv's short list, not Lumen's own.
    emit({ type: 'status', text: 'Starting Grok Build…' }); // the working line says why it waits (the renderer clears it on the first output)
    const child = this.spawn(bin, argv, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: buildEnv({ userData: this.userData, run: gateRun, home, dir, fullAccess }), cwd: workDir });
    // tools / inflight / dog / arm: the inactivity watchdog, as in claude-code.js (callBegin / callEnd pause it).
    const active = { tag, emit, signal, child, agent: runAgent, scope, tools: 0, inflight: 0, dog: null, arm: null };
    this.active = active;
    const watchdogMs = fullAccess && this.watchdogMs ? Math.max(this.watchdogMs, FULL_WATCHDOG_MS) : this.watchdogMs; // [full access] a silent shell command is not a hang
    let over = false; // the process has ended (the watchdog stays off)
    let stalled = false;
    // started: Grok has printed its first stdout line. Until then (process start, and on a chat's first message
    // its wait for Lumen's tools) the allowance is watchdogMs + firstWaitExtraMs, so a slow start isn't called hung.
    let started = false;
    active.arm = () => {
      clearTimeout(active.dog);
      if (!watchdogMs || over || active.inflight > 0) return;
      const ms = watchdogMs + (started || !waitForLumen ? 0 : this.firstWaitExtraMs);
      active.dog = setTimeout(() => { stalled = true; this.kill(child); }, ms);
    };
    // Best-effort, mirroring claude-code.js: kills our own spawned process tree. (Grok's background
    // "leader" process, `grok leader list/kill`, did not show up in Lumen's GROK_HOME in testing.)
    const onAbort = () => this.kill(child);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort(); // Stop landed while the process was being set up
    active.arm();

    let text = '';
    let finalText = '';
    let result = null;
    let newSession = sessionId;
    let initModel = null;
    let replyModel = null; // the assistant message's own model field
    let lastCall = null; // usage of the last model call this turn (the assistant message's)
    let stderr = '';
    let buffer = '';
    // Lumen's own tool check (see the file header): the first tool call that isn't Lumen's ends the
    // run and the process tree at once, and nothing after it reaches the sidebar.
    const watch = this.watch && !fullAccess ? toolWatch({ terminal: !this.background }) : () => null; // [full access] Grok's own tools are expected
    let offTool = null;
    // Lumen's gate must have seen this turn's UserPromptSubmit before the model says anything: that
    // proves Grok loaded the hooks, so every tool call of the turn goes through Lumen first. A Grok
    // that answers without it (hooks not loaded, curl missing, another CLI version) is stopped
    // before the model can call a tool.
    let armed = false;
    let unguarded = false;
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
      if (offTool || early || unguarded) return;
      if (!armed && /^(stream_event|assistant|user)$/.test(msg.type)) {
        armed = gate.armed(tag);
        if (!armed) { unguarded = true; this.kill(child); return; }
      }
      offTool = watch(msg);
      if (offTool) { this.kill(child); return; }
      if (held && lumenReady(tag)) lumenUp(true);
      if (held) {
        // Thinking may go on meanwhile; a reply, a tool call or the end of the turn may not.
        const block = msg.type === 'stream_event' && msg.event?.type === 'content_block_start' ? msg.event.content_block?.type : '';
        if (/^(text|tool_use|server_tool_use)$/.test(block || '') || msg.type === 'assistant' || (msg.type === 'result' && !msg.is_error)) { early = true; this.kill(child); return; }
      }
      if (msg.type === 'system' && msg.subtype === 'init') {
        newSession = msg.session_id || newSession;
        initModel = msg.model || initModel;
        // Which model is answering, at the top of the reply (held with the rest while Lumen's tools come up).
        const note = modelNotice({ picked: model, served: servedModel({ init: initModel }), shown: shownModel });
        if (note) show({ type: 'notice', text: note });
        // No connection-status notice here: see file header -- mcp_servers[].status is "pending"
        // at init even when the lumen server then works, so treating that as a failure signal (the
        // way claude-code.js does) would misfire on every run.
      } else if (msg.type === 'stream_event') {
        const e = msg.event || {};
        // A new text block starts a new paragraph in the saved reply too (see claude-code.js).
        if (e.type === 'content_block_start' && e.content_block?.type === 'text') { if (text && !/\n\n$/.test(text)) text += '\n\n'; show({ type: 'text_block' }); }
        else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') { text += e.delta.text; show({ type: 'text', text: e.delta.text }); }
        // Held like the rest on a chat's first message only (later ones aren't held): a stopped try's thinking must not reach the sidebar (test/units.js).
        else if (e.type === 'content_block_delta' && e.delta?.type === 'thinking_delta') show({ type: 'thinking', text: e.delta.thinking });
        // tool_use blocks are not shown here: Lumen's MCP side emits one step row per call.
      } else if (msg.type === 'assistant') {
        const t = (msg.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
        if (t) finalText = t;
        if (msg.message?.usage) lastCall = msg.message.usage;
        replyModel = msg.message?.model || replyModel;
      } else if (msg.type === 'result') {
        result = msg;
        newSession = msg.session_id || newSession;
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      started = true;
      active.arm(); // any output restarts the watchdog
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
    over = true;
    clearTimeout(active.dog);
    signal.removeEventListener('abort', onAbort);
    if (this.active?.tag === tag) this.active = null;
    // A turn Grok ended without Lumen's gate ever seeing it (its prompt hook blocked, say) is no reply.
    if (!armed && !gate.armed(tag) && result && !result.is_error) unguarded = true;
    gate.close(tag);
    // (The token copy-back happens once the last run in this home ends: run()'s holdAuth.)
    stderr = (stderr + errBuffer).slice(-4000);

    if (offTool) {
      // The session is dropped (sessionId null) so the next message starts a new one instead of
      // resuming a conversation that just reached for another tool.
      emit({ type: 'error', text: `Lumen stopped Grok Build: it called a tool that isn't one of Lumen's (${offTool}). Grok reports a tool call as it starts running it, so that tool may already have run. Grok Build should only use Lumen's tools; if this keeps happening, pick another AI in the model picker.` });
      return { text, sessionId: null, failed: true };
    }
    if (unguarded) {
      emit({ type: 'error', text: 'Lumen stopped Grok Build before it could act: Lumen couldn\'t confirm its check on Grok\'s tool calls was running. Make sure curl is installed and Grok Build is up to date, or pick another AI in the model picker.' });
      return { text: '', sessionId: null, failed: true };
    }
    const served = servedModel({ init: initModel, assistant: replyModel, result });
    if (signal.aborted) return { text: text || finalText, sessionId: newSession, stopped: true, model: served };
    if (early) return { retry: true };
    if (held) for (const event of held) emit(event); // ended (a failure, say) before Lumen's tools came up
    if (stalled) {
      emit({ type: 'error', text: `Grok Build stopped responding for ${Math.round(watchdogMs / 1000)} seconds, so Lumen ended it. Send your message again to pick up where it left off.` });
      return { text, sessionId: newSession, failed: true };
    }
    if (code === 'ENOENT') {
      this.bin = null;
      emit({ type: 'error', text: `Grok Build isn't installed. ${INSTALL_HINT}` });
      return { text: '', sessionId: null, failed: true };
    }
    const usage = result ? grokUsage(result, { lastCall, info: readModelInfo(home, [initModel, ...Object.keys(result.modelUsage || {})].filter(Boolean)) }) : null;
    if (turnLimitHit(result)) return { text: text || finalText, sessionId: newSession, limit: true, cost: result.total_cost_usd, usage, model: served }; // see claude-code.js
    if (!result || result.is_error || result.subtype !== 'success') {
      // A tool call outside the allow rules ends the whole run in error here (unlike Claude Code,
      // where it's one failed step and the turn continues) -- see file header.
      const failText = (result?.errors || []).join('\n') || result?.result || stderr;
      // quietExpired: a resumed session Grok no longer has resolves { expired: true } without an error, so the caller can
      // start a new session with the conversation handed over (agent.js grokBuildTurn), as claude-code.js does.
      if (quietExpired && resume && !text && /no conversation found|session.*not found|unknown session/i.test(`${failText}\n${stderr}`)) return { text: '', sessionId: null, failed: true, expired: true, usage, model: served };
      emit({ type: 'error', ...describeFailure(failText || stderr, code, { fullAccess }) });
      // planLimit: the plan's usage limit was hit, with the reset time when the message names one.
      return { text, sessionId: /no conversation found|session.*not found|unknown session/i.test(`${failText}\n${stderr}`) ? null : newSession, failed: true, usage, planLimit: limitOf(failText), model: served };
    }
    return { text: text || finalText || String(result.result || ''), sessionId: newSession, cost: result.total_cost_usd, usage, model: served };
  }
}

GrokBuildEngine.prototype.imageRoots = function imageRoots() { return this.dir ? [this.dir] : []; };

module.exports = { grokAccountOf, shareAuth, holdAuth, authStats, GrokBuildEngine, findGrok, buildArgs, argsBase, buildEnv, gateScript, GATE_FILE, ARGS_BASE, BUILTIN_TOOLS, DENIED, DEFAULT_MAX_TURNS, userGrokHome, ARGS_FULL, FULL_WATCHDOG_MS, isLumenTool, toolWatch, mcpWait, grokConfig, grokHomeFor, linkAuth, settleAuth, linkAuthAsync, settleAuthAsync, writeIfChanged, promptBlocks, describeFailure, killTree, INSTALL_HINT, parseGrokModels, FALLBACK_MODELS, modelsFallback, servedModel, modelNotice, capImages, modelInfoFrom, readModelInfo, grokUsage };
