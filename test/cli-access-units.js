// "Let CLI agents use this computer" and the Antigravity engine, plain Node (no Electron, no real CLI):
//  - the setting's reading (cli-access.js),
//  - each engine's launch arguments with the setting off and on (Claude Code, Grok Build, Antigravity), and
//    with "Ask before running commands" on and off,
//  - Lumen's gate for Grok's tools (mcp-http.js) and Claude Code's permission prompt tool (mcp.js),
//  - Antigravity run against a fake `agy` process: stream parsing, MCP wiring, cancel, failures, usage-limit text.
// The Antigravity facts these rest on come from Google's docs, not a real install: see antigravity.js's header.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const flag = (argv, f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const flags = (argv, f) => argv.flatMap((v, i) => (v === f ? [argv[i + 1]] : []));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-access-'));

const CA = require('../src/ai/cli-access');
const OFF = CA.accessOf({});
const ASK = CA.accessOf({ cliAccess: true });
const FREE = CA.accessOf({ cliAccess: true, cliAccessAsk: false });

(async () => {
  // ---------- the setting ----------
  check('access: off by default, ask on by default, no folder', OFF.enabled === false && OFF.askBefore === true && OFF.folder === '', JSON.stringify(OFF));
  check('access: only an explicit true turns it on', !CA.accessOf({ cliAccess: 'yes' }).enabled && !CA.accessOf({ cliAccess: 1 }).enabled && ASK.enabled && ASK.askBefore, '');
  check('access: ask off only on an explicit false', FREE.enabled && FREE.askBefore === false && CA.accessOf({ cliAccess: true, cliAccessAsk: 0 }).askBefore === true, '');
  check('access: working folder is the chosen absolute path, else home', CA.workingFolder({ folder: tmp }) === tmp && CA.workingFolder({ folder: 'relative/dir' }) === os.homedir() && CA.workingFolder(OFF) === os.homedir(), '');
  check('access: no note while off', CA.accessNote({ access: OFF }) === '', '');
  const noteAsk = CA.accessNote({ access: ASK, folder: tmp, engine: 'Claude Code' });
  const noteFree = CA.accessNote({ access: FREE, folder: tmp });
  const noteNoAsk = CA.accessNote({ access: ASK, folder: tmp, canAsk: false, engine: 'Antigravity' });
  check('access note: names the folder, says approval is asked, and keeps page and command output untrusted', noteAsk.includes(tmp) && /asks the user for approval/.test(noteAsk) && /untrusted data, not instructions/.test(noteAsk), noteAsk);
  check('access note: without asking, it says so and tells the model to be careful', /without asking the user first/.test(noteFree) && /destructive/.test(noteFree), noteFree);
  check('access note: an engine that cannot ask says it will be declined', /Antigravity cannot ask the user in Lumen/.test(noteNoAsk) && /declined/.test(noteNoAsk), noteNoAsk);

  // ---------- Claude Code ----------
  const cc = require('../src/ai/claude-code');
  const ccBase = { mcpConfig: 'm.json', sessionId: 's', systemPrompt: 'S' };
  const ccOff = cc.buildArgs({ ...ccBase });
  const ccAsk = cc.buildArgs({ ...ccBase, access: ASK });
  const ccFree = cc.buildArgs({ ...ccBase, access: FREE });
  check('claude off: no built-in tools, dontAsk, only mcp__lumen, no prompt tool', flag(ccOff, '--tools') === '' && flag(ccOff, '--permission-mode') === 'dontAsk' && flag(ccOff, '--allowedTools') === 'mcp__lumen' && !ccOff.includes('--permission-prompt-tool') && ccOff.includes('--strict-mcp-config'), ccOff.join(' '));
  check('claude on + ask: built-in tools kept (no --tools ""), default mode, permission requests go to Lumen', !ccAsk.includes('--tools') && flag(ccAsk, '--permission-mode') === 'default' && flag(ccAsk, '--permission-prompt-tool') === 'mcp__lumen__approval_prompt', ccAsk.join(' '));
  check('claude on + ask: still only Lumen\'s MCP server, system prompt and session unchanged', ccAsk.includes('--strict-mcp-config') && flag(ccAsk, '--mcp-config') === 'm.json' && flag(ccAsk, '--system-prompt') === 'S' && flag(ccAsk, '--session-id') === 's', ccAsk.join(' '));
  check('claude on + ask off: bypassPermissions, no prompt tool, tools kept', !ccFree.includes('--tools') && flag(ccFree, '--permission-mode') === 'bypassPermissions' && !ccFree.includes('--permission-prompt-tool'), ccFree.join(' '));
  check('claude: a disabled access object is the same as none', JSON.stringify(cc.buildArgs({ ...ccBase, access: OFF })) === JSON.stringify(ccOff), '');
  const keyOf = (access) => cc.procKey({ bin: 'claude', sessionId: 's', systemPrompt: 'S', access });
  check('claude: a kept process is not reused across a change of the setting, ask mode or folder', keyOf(null) !== keyOf(ASK) && keyOf(ASK) !== keyOf(FREE) && keyOf(ASK) !== keyOf({ ...ASK, folder: tmp }) && keyOf(OFF) === keyOf(null), '');

  // ---------- Grok Build ----------
  const gb = require('../src/ai/grok-build');
  const gbBase = { promptFile: 'p.json', sessionId: 's', systemPrompt: 'S', cwd: path.join(tmp, 'sidebar') };
  const gbOff = gb.buildArgs({ ...gbBase });
  const gbAsk = gb.buildArgs({ ...gbBase, access: { ...ASK, folder: tmp } });
  const gbFree = gb.buildArgs({ ...gbBase, access: { ...FREE, folder: tmp } });
  check('grok off: built-ins removed, only lumen__*, search_tool and the gated terminal allowed, dontAsk, Lumen\'s folder', Boolean(flag(gbOff, '--disallowed-tools')) && flag(gbOff, '--cwd') === gbBase.cwd && flags(gbOff, '--allow').join() === 'lumen__*,search_tool,run_terminal_command' && flag(gbOff, '--permission-mode') === 'dontAsk', gbOff.join(' '));
  check('grok on: built-ins are not removed, native tools are allowed, the working folder is the chosen one', !gbAsk.includes('--disallowed-tools') && gb.NATIVE_ALLOW.every((t) => flags(gbAsk, '--allow').includes(t)) && flag(gbAsk, '--cwd') === tmp, gbAsk.join(' '));
  check('grok on: sub-agent and background-process tools stay denied, web search stays off, dontAsk', gb.argsBase(false, ASK).includes('--no-subagents') && ['spawn_subagent', 'kill_command_or_subagent', 'get_command_or_subagent_output'].every((t) => flags(gbAsk, '--deny').includes(t)) && gbAsk.includes('--disable-web-search') && flag(gbAsk, '--permission-mode') === 'dontAsk', gbAsk.join(' '));
  check('grok: ask on and off share one argv (the per-call question is Lumen\'s PreToolUse gate, set per run)', JSON.stringify(gbAsk) === JSON.stringify(gbFree), '');
  check('grok: a background task never gets access, even if asked', JSON.stringify(gb.buildArgs({ ...gbBase, background: true, access: ASK })) === JSON.stringify(gb.buildArgs({ ...gbBase, background: true })), '');
  const cfgOff = gb.grokConfig({ gate: 'g.sh' });
  const cfgOn = gb.grokConfig({ gate: 'g.sh', access: ASK });
  check('grok config off: Bash, Edit and Write denied', /deny = \["Bash", "Edit", "Write", "WebFetch", "WebSearch"\]/.test(cfgOff) && /allow = \["MCPTool\(lumen__\*\)"\]/.test(cfgOff), cfgOff);
  check('grok config on: Bash, Edit, Write and Read allowed, web tools still denied, still only the lumen MCP server and the gate hooks', /allow = \["MCPTool\(lumen__\*\)", "Bash", "Edit", "Write", "Read"\]/.test(cfgOn) && /deny = \["WebFetch", "WebSearch"\]/.test(cfgOn) && (cfgOn.match(/\[mcp_servers\./g) || []).length === 1 && /PreToolUse/.test(cfgOn), cfgOn);
  const envOff = gb.buildEnv({ userData: tmp, base: { PATH: 'p', SECRET_TOKEN: 'x' } });
  const envOn = gb.buildEnv({ userData: tmp, base: { PATH: 'p', SECRET_TOKEN: 'x' }, access: ASK });
  check('grok env: Lumen\'s own GROK_HOME either way, the real home only with access, no other secrets', envOff.GROK_HOME === envOn.GROK_HOME && envOff.HOME !== os.homedir() && envOn.HOME === os.homedir() && !('SECRET_TOKEN' in envOn), JSON.stringify([envOff.HOME, envOn.HOME]));

  // Grok's gate (mcp-http.js): what a PreToolUse is answered for a run opened with and without access.
  const asked = [];
  const gate = await require('../src/automation/mcp-http').startHttp({
    tools: [{ name: 'ping', description: 'p', input_schema: { type: 'object' } }],
    callTool: async () => ({ content: [], isError: false }),
    onTerminalApproval: async (tag, command, tool) => { asked.push(tool); return 'once'; },
  });
  const post = (url, body) => new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b ? JSON.parse(b) : {})); });
    req.end(JSON.stringify(body));
  });
  const verdict = async (run, tool) => (await post(run.hookUrl, { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command: 'ls', path: 'a.txt' } })).hookSpecificOutput?.permissionDecision || 'allow';
  const rOff = gate.open('t-off', 'chat-off');
  check('grok gate, access off: write and terminal tools are denied or asked as before (terminal asks, write is denied)', await verdict(rOff, 'write') === 'deny' && await verdict(rOff, 'run_terminal_command') === 'allow' && asked.join() === 'run_terminal_command', asked.join());
  asked.length = 0;
  const rAsk = gate.open('t-ask', 'chat-ask', ASK);
  check('grok gate, access on + ask: reads and Lumen\'s tools go through unasked', await verdict(rAsk, 'read_file') === 'allow' && await verdict(rAsk, 'list_dir') === 'allow' && await verdict(rAsk, 'lumen__ping') === 'allow' && await verdict(rAsk, 'search_tool') === 'allow' && asked.length === 0, asked.join());
  check('grok gate, access on + ask: a write and a command each ask the user (naming the tool)', await verdict(rAsk, 'write') === 'allow' && await verdict(rAsk, 'run_terminal_command') === 'allow' && asked.join() === 'write,run_terminal_command', asked.join());
  check('grok gate, access on: sub-agent and process-output tools are denied, an unknown Lumen tool is denied', await verdict(rAsk, 'spawn_subagent') === 'deny' && await verdict(rAsk, 'get_command_or_subagent_output') === 'deny' && await verdict(rAsk, 'lumen__nope') === 'deny', '');
  asked.length = 0;
  const rFree = gate.open('t-free', 'chat-free', FREE);
  check('grok gate, access on + ask off: everything allowed is allowed without a question', await verdict(rFree, 'run_terminal_command') === 'allow' && await verdict(rFree, 'write') === 'allow' && await verdict(rFree, 'search_replace') === 'allow' && asked.length === 0 && await verdict(rFree, 'spawn_subagent') === 'deny', asked.join());
  // Antigravity's hooks (hooks.md): { toolCall: { name, args } } in, { decision, reason } out; a payload with no toolCall is the PreInvocation "seen" ping.
  asked.length = 0;
  const agyHook = (run, name, args = { CommandLine: 'rm -rf x' }) => post(run.hookUrl, name === null ? { conversationId: 'c' } : { toolCall: { name, args }, stepIdx: 1 }).then((r) => r.decision || 'none');
  const aOff = gate.open('a-off', 'c-off', null, { agy: true });
  check('agy gate, access off: a shell or file tool is denied with a reason; Lumen\'s tools and plain reads are allowed', await agyHook(aOff, 'run_command') === 'deny' && await agyHook(aOff, 'write_to_file') === 'deny' && await agyHook(aOff, 'mcp_lumen_click', {}) === 'allow' && await agyHook(aOff, 'lumen__read_page', {}) === 'allow' && await agyHook(aOff, 'list_dir', {}) === 'allow' && asked.length === 0, asked.join());
  check('agy gate: the PreInvocation ping marks the run as seen', !gate.armed('a-off') && await agyHook(aOff, null) === 'none' && gate.armed('a-off'), '');
  const aAsk = gate.open('a-ask', 'c-ask', ASK, { agy: true });
  check('agy gate, access on + ask: reads and Lumen\'s tools go through, a command and a file write each ask the user, naming the tool and showing the command', await agyHook(aAsk, 'view_file', {}) === 'allow' && await agyHook(aAsk, 'grep_search', {}) === 'allow' && await agyHook(aAsk, 'lumen_navigate', {}) === 'allow' && asked.length === 0 && await agyHook(aAsk, 'run_command') === 'allow' && await agyHook(aAsk, 'write_to_file') === 'allow' && asked.join() === 'run_command,write_to_file', asked.join());
  const aFree = gate.open('a-free', 'c-free', FREE, { agy: true });
  asked.length = 0;
  check('agy gate, access on + ask off: allowed without a question', await agyHook(aFree, 'run_command') === 'allow' && await agyHook(aFree, 'replace_file_content') === 'allow' && asked.length === 0, asked.join());
  gate.close('a-ask');
  check('agy gate: after the run its hook URL denies in agy\'s format too', await agyHook(aAsk, 'run_command') === 'deny', '');
  const declineGate = await require('../src/automation/mcp-http').startHttp({ tools: [], callTool: async () => ({}), onTerminalApproval: async () => 'deny' });
  const aNo = declineGate.open('a-no', 'c-no', ASK, { agy: true });
  check('agy gate: a Deny on the card is a deny, with a reason', (await post(aNo.hookUrl, { toolCall: { name: 'run_command', args: { CommandLine: 'x' } } })).decision === 'deny', '');
  declineGate.stop();
  gate.stop();

  // Claude Code's permission prompt tool (mcp.js): offered to an engine's session only.
  const { createSession, APPROVAL_TOOL } = require('../src/automation/mcp');
  const listFor = async (engine) => {
    const sent = [];
    const s = createSession({ tools: [{ name: 'ping', description: 'p', input_schema: { type: 'object' } }], callTool: async (name) => ({ content: [{ type: 'text', text: name }], isError: false }), enabled: () => true, onEvent() {}, send: (m) => sent.push(m), engine });
    await s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: APPROVAL_TOOL.name, arguments: { tool_name: 'Bash', input: {} } } });
    return { names: sent[0].result.tools.map((t) => t.name), call: sent[1] };
  };
  const inEngine = await listFor('tag');
  const outside = await listFor(null);
  check('claude approval tool: listed and callable for an engine\'s session', inEngine.names.includes('approval_prompt') && inEngine.call.result?.content?.[0]?.text === 'approval_prompt', JSON.stringify(inEngine));
  check('claude approval tool: not listed and refused for an outside agent', !outside.names.includes('approval_prompt') && outside.call.error?.code === -32602, JSON.stringify(outside));

  // ---------- Antigravity: arguments and files ----------
  const ag = require('../src/ai/antigravity');
  const agOff = ag.buildArgs({ prompt: 'hi', model: 'default', access: null, folder: tmp });
  const agAsk = ag.buildArgs({ prompt: 'hi', conversation: 'c-1', model: 'gemini-3.1-pro-high', access: ASK, folder: tmp });
  const agFree = ag.buildArgs({ prompt: 'hi', access: FREE, folder: tmp });
  check('antigravity: headless stream-json with the prompt, no model flag for the default', flag(agOff, '-p') === 'hi' && flag(agOff, '--output-format') === 'stream-json' && !agOff.includes('--model') && !agOff.includes('--conversation'), agOff.join(' '));
  check('antigravity off: --sandbox, no skip-permissions, no extra folder', agOff.includes('--sandbox') && !agOff.includes('--dangerously-skip-permissions') && !agOff.includes('--add-dir'), agOff.join(' '));
  check('antigravity on + ask: the working folder is added, nothing is skipped, no --sandbox flag, model and conversation passed', flag(agAsk, '--add-dir') === tmp && !agAsk.includes('--dangerously-skip-permissions') && !agAsk.includes('--sandbox') && flag(agAsk, '--model') === 'gemini-3.1-pro-high' && flag(agAsk, '--conversation') === 'c-1', agAsk.join(' '));
  check('antigravity on + ask off: --dangerously-skip-permissions', agFree.includes('--dangerously-skip-permissions') && flag(agFree, '--add-dir') === tmp, agFree.join(' '));
  check('antigravity: a model name that could read as a flag is not passed', !ag.buildArgs({ prompt: 'x', model: '--bad' }).includes('--bad'), '');
  const sOff = ag.settingsFor({ access: null, folder: tmp });
  const sAsk = ag.settingsFor({ access: ASK, folder: tmp, provider: 'gemini' });
  const sFree = ag.settingsFor({ access: FREE, folder: tmp });
  check('antigravity settings off: only mcp(lumen/*) allowed; commands, writes, URLs denied; terminal sandbox on', sOff.permissions.allow.join() === 'mcp(lumen/*)' && ['command(*)', 'write_file(*)', 'read_url(*)', 'unsandboxed(*)'].every((r) => sOff.permissions.deny.includes(r)) && sOff.enableTerminalSandbox === true, JSON.stringify(sOff));
  check('antigravity settings on + ask: reads allowed, commands and writes are "ask" (declined headless), nothing denied', sAsk.permissions.allow.includes('read_file(*)') && sAsk.permissions.ask.includes('command(*)') && sAsk.permissions.ask.includes('write_file(*)') && sAsk.permissions.deny.length === 0 && sAsk.toolPermission === 'request-review', JSON.stringify(sAsk));
  check('antigravity settings on + ask off: commands and writes allowed', sFree.permissions.allow.includes('command(*)') && sFree.permissions.allow.includes('write_file(*)') && sFree.permissions.ask.length === 0, JSON.stringify(sFree));
  check('antigravity settings: the user\'s own modelProvider is carried over, telemetry off, the folder trusted', sAsk.modelProvider === 'gemini' && sOff.modelProvider === undefined && sOff.enableTelemetry === false && sOff.trustedWorkspaces[0] === tmp, '');
  check('antigravity MCP config: exactly one server, lumen, over HTTP with the run token', JSON.stringify(ag.mcpConfig({ mcpUrl: 'http://127.0.0.1:9/mcp', mcpToken: 'tok' })) === '{"mcpServers":{"lumen":{"serverUrl":"http://127.0.0.1:9/mcp","headers":{"Authorization":"Bearer tok"}}}}', '');
  check('antigravity install: the official command per OS, as an argv with no user input', ag.installCommand('linux') === 'curl -fsSL https://antigravity.google/cli/install.sh | bash' && ag.installCommand('darwin') === ag.installCommand('linux') && ag.installCommand('win32') === 'irm https://antigravity.google/cli/install.ps1 | iex' && ag.installArgv('win32').file === 'powershell.exe' && ag.installArgv('linux').args[1] === ag.installCommand('linux'), '');
  const realModels = 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.1-pro-low\tGemini 3.1 Pro (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n'; // agy 1.2.14's own output
  check('antigravity models: agy 1.2.14\'s real listing parses to slugs and display names', ag.parseModels(realModels).join() === 'gemini-3.8-flash-high,gemini-3.1-pro-low,claude-sonnet-4-6,gpt-oss-120b-medium' && ag.modelNames(realModels)['claude-sonnet-4-6'] === 'Claude Sonnet 4.6 (Thinking)', JSON.stringify(ag.modelNames(realModels)));
  const hooks = ag.hooksFor('/h/lumen gate.sh', 'linux');
  const winHooks = ag.hooksFor('C:\\Users\\a b\\lumen-gate.cmd', 'win32');
  check('antigravity hooks.json: Lumen\'s gate before every tool call (any tool) and every model call, the path quoted', hooks['lumen-gate'].PreToolUse[0].matcher === '*' && hooks['lumen-gate'].PreToolUse[0].hooks[0].command === "'/h/lumen gate.sh'" && hooks['lumen-gate'].PreInvocation[0].command === "'/h/lumen gate.sh'" && winHooks['lumen-gate'].PreToolUse[0].hooks[0].command === '"C:\\Users\\a b\\lumen-gate.cmd"', JSON.stringify(hooks));
  check('antigravity MCP, stdio fallback: the bridge, named by this run\'s tag', JSON.stringify(ag.stdioConfig({ command: 'node', args: ['mcp.js'], env: { A: '1' } }, '/ud', 'tag-9')) === '{"mcpServers":{"lumen":{"command":"node","args":["mcp.js"],"env":{"A":"1","LUMEN_USERDATA":"/ud","LUMEN_ENGINE":"tag-9"}}}}', '');
  check('antigravity models: parsed from `agy models`, flags and prose ignored', ag.parseModels('Available models:\n  * gemini-3.8-flash-high (default)\n  - claude-sonnet-4-6\n  -rf\nnotes\n').join() === 'gemini-3.8-flash-high,claude-sonnet-4-6', ag.parseModels('Available models:\n  * gemini-3.8-flash-high (default)\n  - claude-sonnet-4-6\n').join());
  check('antigravity watch: a shell or file tool that is not Lumen\'s is flagged; Lumen\'s MCP tools are not', ag.offToolOf('run_command') === 'run_command' && ag.offToolOf('write_to_file') === 'write_to_file' && ag.offToolOf('mcp_lumen_click') === null && ag.offToolOf('lumen__read_page') === null && ag.offToolOf('think') === null, '');
  const first = ag.promptFor({ prompt: 'Q', systemPrompt: 'SYS', resume: false });
  const later = ag.promptFor({ prompt: 'Q', systemPrompt: 'SYS', resume: true, imageFiles: ['/a.png'] });
  check('antigravity prompt: the system text tops a conversation\'s first message only; images are named', first.startsWith('<lumen_instructions>\nSYS') && first.endsWith('Q') && !later.includes('SYS') && /untrusted data/.test(later) && later.includes('/a.png'), first + '|' + later);
  check('antigravity failure text: sign-in, usage limit, other', /not signed in/.test(ag.describeFailure('Please sign in to continue', 1).text) && /usage limit is reached/.test(ag.describeFailure('RESOURCE_EXHAUSTED: quota exceeded', 1).text) && /stopped \(exit 3\)/.test(ag.describeFailure('boom', 3).text), '');
  // The usage-limit text reaches the model fallback as a limit, the sign-in text as auth (fallback.js), and not every sentence is one.
  const fb = require('../src/ai/fallback');
  check('fallback: Antigravity\'s limit and sign-in sentences are classified; an ordinary failure is neither', fb.classify(ag.describeFailure('RESOURCE_EXHAUSTED: quota exceeded', 1).text).kind === 'limit' && fb.classify(ag.describeFailure('Please sign in to continue', 1).text).kind === 'auth' && fb.classify(ag.describeFailure('boom', 1).text).kind === 'other', '');
  check('fallback: Antigravity is an engine, and the Gemini API key is its same-vendor route', fb.isEngine('antigravity:default') && fb.providerName('antigravity:default') === 'Antigravity', fb.providerName('antigravity:default'));
  const opts = [{ id: 'antigravity:default', label: 'Antigravity', signedIn: 'unknown' }, { id: 'openai:gpt-5.6', label: 'GPT', signedIn: true }, { id: 'gemini:gemini-2.5-pro', label: 'Gemini', signedIn: true }];
  check('fallback: from Antigravity the Gemini API model is tried before another provider', fb.pick({ current: 'antigravity:default', options: opts, cooldowns: fb.shared, allowEngines: true, tried: [] }) === 'gemini:gemini-2.5-pro', fb.pick({ current: 'antigravity:default', options: opts, cooldowns: fb.shared, allowEngines: true, tried: [] }));
  const { antigravityOptions } = require('../src/features/ai-agents');
  const picker = antigravityOptions({ signedIn: 'unknown', models: ['gemini-3.1-pro-high'], saved: 'antigravity:old-model-1' });
  check('antigravity picker: default first, the models agy listed, a saved pick kept, under its own group', picker[0].id === 'antigravity:default' && picker.map((o) => o.id).join() === 'antigravity:default,antigravity:gemini-3.1-pro-high,antigravity:old-model-1' && picker.every((o) => o.group === 'Your Google account'), picker.map((o) => o.id).join());
  check('antigravity picker: signed out shows the sign-in badge and how to sign in', antigravityOptions({ signedIn: false })[0].badges.includes('sign in') && /run agy/.test(antigravityOptions({ signedIn: false })[0].detail), '');

  // ---------- engine notes ----------
  const agent = require('../src/ai/agent');
  const grokOff = agent.withAccess(agent.grokBuildNote('grok-4.7'), OFF, 'Grok Build');
  const grokOn = agent.withAccess(agent.grokBuildNote('grok-4.7'), ASK, 'Grok Build');
  check('notes off: unchanged, "no shell, file or other tools" kept', grokOff === agent.grokBuildNote('grok-4.7') && /no shell, file or other tools/.test(grokOff), '');
  check('grok note on: no longer says it has no shell, says what it has, keeps the untrusted-data rule', !/no shell, file or other tools/.test(grokOn) && /your own shell, file and other tools/.test(grokOn) && /untrusted data/.test(grokOn) && /lumen__/.test(grokOn), grokOn.slice(-500));
  const ccOn = agent.withAccess(agent.claudeCodeNote('opus'), FREE, 'Claude Code');
  check('claude note on: "no shell or file tools" is gone, the no-asking warning is in', !/no shell or file tools/.test(ccOn) && /without asking the user first/.test(ccOn) && /mcp__lumen__/.test(ccOn), ccOn.slice(-400));
  const agyNote = agent.antigravityNote('gemini-3.1-pro-high');
  const agyOn = agent.withAccess(agent.antigravityNote(null), ASK, 'Antigravity', false);
  check('antigravity note: tools by name, the model, the date, no shell claim', /read_page\(/.test(agyNote) && /named lumen|server named lumen/.test(agyNote) && /gemini-3\.1-pro-high/.test(agyNote) && /Today's date is \d{4}-\d\d-\d\d/.test(agyNote) && /no shell, file or other tools/.test(agyNote), agyNote.slice(0, 300));
  check('antigravity note on: the claim goes, "cannot ask" is said', !/no shell, file or other tools/.test(agyOn) && /cannot ask the user in Lumen/.test(agyOn), agyOn.slice(-400));
  check('antigravity: its own identity line in the system prompt', /Antigravity/.test(agent.systemFor({ model: 'antigravity:default' })) && !/You are Claude/.test(agent.systemFor({ model: 'antigravity:default' })), '');
  check('antigravity: cliSystemPrompt knows it', /Google Antigravity/.test(agent.cliSystemPrompt({ model: 'antigravity:default' }, 'antigravity')), '');

  // ---------- one-shot (organize refine) ----------
  const cj = require('../src/ai/cli-json');
  const oneshot = cj.antigravityArgs({ system: 'SYS', user: 'USER', schema: { type: 'object' }, model: 'gemini-3.8-flash-high' });
  check('antigravity one-shot: json output with the schema, sandbox, the model; the system text rides in the prompt', flag(oneshot, '--output-format') === 'json' && flag(oneshot, '--json-schema') === '{"type":"object"}' && oneshot.includes('--sandbox') && flag(oneshot, '--model') === 'gemini-3.8-flash-high' && /SYS/.test(flag(oneshot, '-p')) && /USER/.test(flag(oneshot, '-p')), oneshot.join(' '));
  const big = cj.antigravityArgs({ system: 'S', user: 'x'.repeat(30000), schema: {}, promptFile: '/p.md' });
  check('antigravity one-shot: a message past the command-line limit goes in a file', /Read the file \/p\.md/.test(flag(big, '-p')) && flag(big, '-p').length < 500, '');
  const sOne = cj.antigravitySettings(null, tmp);
  check('antigravity one-shot settings: no tools at all (commands, writes, URLs and every MCP server denied)', ['command(*)', 'write_file(*)', 'read_url(*)', 'mcp(*)'].every((r) => sOne.permissions.deny.includes(r)) && sOne.permissions.allow.length === 0, JSON.stringify(sOne));
  check('antigravity one-shot: the envelope\'s structured_output is the answer; a non-SUCCESS status is an error', JSON.stringify(cj.parseResult(JSON.stringify({ status: 'SUCCESS', response: 'x', structured_output: { groups: [] } }))) === '{"groups":[]}' && (() => { try { cj.parseResult(JSON.stringify({ status: 'ERROR', error: 'RESOURCE_EXHAUSTED' })); return false; } catch (e) { return /RESOURCE_EXHAUSTED/.test(e.output); } })(), '');
  const ran = [];
  const ans = await cj.completeJSON({ engine: 'antigravity', bin: 'agy', model: 'default', system: 'S', user: 'U', schema: { type: 'object' }, userData: tmp, run: async (opts) => { ran.push(opts); return JSON.stringify({ status: 'SUCCESS', structured_output: { ok: 1 } }); } });
  check('antigravity one-shot run: the answer, in Lumen\'s own home with no MCP config and a minimal environment', ans.ok === 1 && ran[0].env.HOME === path.join(tmp, 'antigravity-oneshot') && !fs.existsSync(path.join(tmp, 'antigravity-oneshot', '.gemini', 'config', 'mcp_config.json')) && !('ANTHROPIC_API_KEY' in ran[0].env), JSON.stringify(ran[0].env.HOME));

  // ---------- Antigravity: a run against a fake agy ----------
  const fake = (script, extra = {}) => {
    const spawns = [];
    const kills = [];
    const spawn = (bin, argv, opts) => {
      const child = new EventEmitter();
      Object.assign(child, { pid: 5000 + spawns.length, exitCode: null, killed: false, stdout: new PassThrough(), stderr: new PassThrough() });
      const rec = { bin, argv, opts, child, mcp: null };
      try { rec.mcp = JSON.parse(fs.readFileSync(path.join(opts.env.HOME, '.gemini', 'config', 'mcp_config.json'), 'utf8')); } catch { /* not written */ }
      try { rec.settings = JSON.parse(fs.readFileSync(path.join(opts.env.HOME, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8')); } catch { /* not written */ }
      spawns.push(rec);
      (async () => {
        for (const line of script) {
          if (child.killed) return;
          if (typeof line === 'function') line();
          else if (line.stderr) child.stderr.write(`${line.stderr}\n`);
          else child.stdout.write(`${JSON.stringify(line)}\n`);
          await new Promise((r) => setImmediate(r));
        }
        child.exitCode = extra.code ?? 0;
        child.stdout.end();
        setImmediate(() => child.emit('close', extra.code ?? 0));
      })();
      return child;
    };
    const kill = (child) => { kills.push(child.pid); if (child.killed) return; child.killed = true; child.stdout.end(); setImmediate(() => child.emit('close', null)); };
    return { spawn, kill, spawns, kills };
  };
  async function runAgy(script, { access = null, run = {}, extra = {}, engineExtra = {} } = {}) {
    const data = fs.mkdtempSync(path.join(tmp, 'ud-'));
    const f = fake(script, extra);
    const gate = { opened: [], closed: [], open(tag, session, acc, opts) { this.opened.push({ tag, session, acc, opts }); return { mcpUrl: 'http://127.0.0.1:1/mcp', mcpToken: 'm'.repeat(48), hookUrl: 'http://127.0.0.1:1/hook/x' }; }, close(tag) { this.closed.push(tag); } };
    const engine = new ag.AntigravityEngine({ userData: data, gate: async () => gate, access: access ? () => access : null, spawn: f.spawn, kill: f.kill, ...engineExtra });
    engine.bin = process.execPath; // "found": any file that exists
    const events = [];
    const out = await engine.run({ prompt: 'hello', sessionId: null, systemPrompt: 'SYS', signal: new AbortController().signal, emit: (e) => events.push(e), ...run });
    return { out, events, f, gate, data, engine };
  }
  const init = { event: 'init', conversation_id: 'conv-1', init: { cwd: '/x', tools: ['run_command'], permission_mode: 'request-review', model: 'gemini-3.8-flash-high' } };
  const say = (index, text) => ({ event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: index, state: 'ACTIVE', step_type: 'agent_response', text_delta: text } });
  const done = (response, status = 'SUCCESS', extra = {}) => ({ event: 'result', result: { conversation_id: 'conv-1', status, response, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }, ...extra } });

  const resumed0 = await runAgy([init, done('x')], { run: { sessionId: 'conv-0' } });
  const ok = await runAgy([init, say(1, 'Hel'), say(1, 'lo'), say(2, ' there'), done('Hello there')]);
  check('antigravity run: streams text, joins steps as paragraphs, returns the conversation id, model and usage', ok.out.text === 'Hel' + 'lo' + '\n\n there' && ok.out.sessionId === 'conv-1' && ok.out.model === 'gemini-3.8-flash-high' && ok.out.usage?.total_tokens === 12 && ok.events.filter((e) => e.type === 'text').map((e) => e.text).join('') === 'Hello there', JSON.stringify([ok.out, ok.events]));
  const sp = ok.f.spawns[0];
  check('antigravity run: hooks.json and the gate script are written in Lumen\'s home, and the hook URL is in the child\'s environment only', fs.existsSync(path.join(ok.data, 'antigravity-home', '.gemini', 'config', 'hooks.json')) && fs.existsSync(path.join(ok.data, 'antigravity-home', process.platform === 'win32' ? 'lumen-gate.cmd' : 'lumen-gate.sh')) && sp.opts.env.LUMEN_HOOK_URL === 'http://127.0.0.1:1/hook/x' && !sp.argv.join(' ').includes('hook/x'), JSON.stringify(Object.keys(sp.opts.env)));
  check('antigravity run, access off: Lumen\'s own home, its MCP config and settings written before the spawn, an empty folder, no shell', sp.opts.shell === false && sp.opts.env.HOME === path.join(ok.data, 'antigravity-home') && sp.opts.env.USERPROFILE === sp.opts.env.HOME && sp.opts.cwd === path.join(ok.data, 'antigravity-sidebar') && Object.keys(sp.mcp.mcpServers).join() === 'lumen' && sp.mcp.mcpServers.lumen.serverUrl === 'http://127.0.0.1:1/mcp' && sp.settings.permissions.deny.includes('command(*)') && sp.argv.includes('--sandbox'), JSON.stringify([sp.opts.cwd, sp.mcp, sp.settings]));
  check('antigravity run: the gate run is opened for Antigravity (hooks answer in agy\'s format), with the chat\'s conversation id when there is one', ok.gate.opened[0].opts?.agy === true && resumed0.gate.opened[0].session === 'conv-0', JSON.stringify(ok.gate.opened));
  check('antigravity run: the first message carries the system text; the run\'s MCP token file is gone afterwards', flag(sp.argv, '-p').startsWith('<lumen_instructions>\nSYS') && !fs.existsSync(path.join(ok.data, 'antigravity-home', '.gemini', 'config', 'mcp_config.json')) && ok.gate.closed.length === 1, flag(sp.argv, '-p').slice(0, 80));
  check('antigravity run: the environment is a short list, no API keys of the user\'s shell', !('ANTHROPIC_API_KEY' in sp.opts.env) && sp.opts.env.NO_COLOR === '1', '');

  const resumed = await runAgy([init, say(1, 'ok'), done('ok')], { run: { sessionId: 'conv-1', model: 'gemini-3.1-pro-high' } });
  const rp = resumed.f.spawns[0];
  check('antigravity run: a later message continues the conversation with --conversation and the model, with a reminder not the whole system text', flag(rp.argv, '--conversation') === 'conv-1' && flag(rp.argv, '--model') === 'gemini-3.1-pro-high' && !flag(rp.argv, '-p').includes('SYS') && /lumen_reminder/.test(flag(rp.argv, '-p')), rp.argv.join(' ').slice(0, 300));

  const folder = fs.mkdtempSync(path.join(tmp, 'work-'));
  const full = await runAgy([init, say(1, 'done'), done('done')], { access: { ...ASK, folder } });
  const fp = full.f.spawns[0];
  check('antigravity run, access on: the chosen folder is the working folder and is added, the gate run carries the access, settings ask for commands', fp.opts.cwd === folder && flag(fp.argv, '--add-dir') === folder && full.gate.opened[0].acc?.enabled === true && fp.settings.permissions.ask.includes('command(*)'), JSON.stringify([fp.opts.cwd, fp.argv]));
  const fullFree = await runAgy([init, done('x')], { access: { ...FREE, folder: path.join(tmp, 'no-such-folder') } });
  check('antigravity run, access on + ask off: skip-permissions; a folder that is gone falls back to the home folder', fullFree.f.spawns[0].argv.includes('--dangerously-skip-permissions') && fullFree.f.spawns[0].opts.cwd === os.homedir(), fullFree.f.spawns[0].opts.cwd);
  const longPrompt = await runAgy([init, done('x')], { run: { prompt: 'p'.repeat(ag.PROMPT_ARG_MAX + 100) } });
  check('antigravity run: a message too long for the command line goes in a file that is read from the working folder, and removed after', /Read the file .*lumen-message-/.test(flag(longPrompt.f.spawns[0].argv, '-p')) && flag(longPrompt.f.spawns[0].argv, '-p').length < 600 && fs.readdirSync(path.join(longPrompt.data, 'antigravity-sidebar')).length === 0, flag(longPrompt.f.spawns[0].argv, '-p').slice(0, 120));

  const bad = await runAgy([init, say(1, 'about to'), { event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi > x' } } } }, say(3, 'never shown'), done('never')]);
  check('antigravity run, access off: a shell tool that is not Lumen\'s stops the run, drops the conversation and says so', bad.f.kills.length === 1 && bad.out.failed === true && bad.out.sessionId === null && bad.events.some((e) => e.type === 'error' && /isn't one of Lumen's \(run_command\)/.test(e.text)) && !bad.events.some((e) => e.text === 'never shown'), JSON.stringify(bad.events));
  const allowedTool = await runAgy([init, { event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command' } }, say(2, 'ran it'), done('ran it')], { access: { ...FREE, folder } });
  check('antigravity run, access on: its own tools are expected: the run goes on and a status line names the tool', allowedTool.f.kills.length === 0 && allowedTool.out.text === 'ran it' && allowedTool.events.some((e) => e.type === 'status' && /Running run_command/.test(e.text)), JSON.stringify(allowedTool.events));
  const lumenTool = await runAgy([init, { event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'mcp_lumen_read_page' } }, say(2, 'read'), done('read')]);
  check('antigravity run, access off: a Lumen MCP tool call is fine', lumenTool.f.kills.length === 0 && lumenTool.out.text === 'read', JSON.stringify(lumenTool.events));

  const ctl = new AbortController();
  const stopped = runAgy([init, say(1, 'part'), () => ctl.abort(), say(1, 'x'), done('x')], { run: { signal: ctl.signal } });
  const st = await stopped;
  check('antigravity run: Stop kills the process tree and returns what was said, stopped', st.f.kills.length >= 1 && st.out.stopped === true && st.out.text.startsWith('part'), JSON.stringify(st.out));

  const signedOut = await runAgy([init, done('', 'ERROR', { error: 'Please sign in to continue' })]);
  check('antigravity run: a sign-in failure says how to sign in, and status() then reports signed out', signedOut.events.some((e) => e.type === 'error' && /not signed in/.test(e.text) && /run `agy`/.test(e.text)) && signedOut.out.failed === true && (await signedOut.engine.status(true)).signedIn === false, JSON.stringify(signedOut.events));
  const limited = await runAgy([init, done('', 'ERROR', { error: 'RESOURCE_EXHAUSTED: You have exhausted your capacity. Your quota will reset after 2h 10m.' })]);
  const limitEvent = limited.events.find((e) => e.type === 'error');
  check('antigravity run: a usage-limit failure carries a reset time and classifies as a limit for the model fallback', fb.classify(limitEvent.text).kind === 'limit' && limited.out.planLimit?.resetsAt > Date.now(), JSON.stringify([limitEvent, limited.out.planLimit]));
  const waiting = await runAgy([init, done('', 'WAITING')], { access: ASK });
  check('antigravity run: WAITING (needs an approval it cannot show) is explained, with the setting to change', waiting.events.some((e) => e.type === 'error' && /Ask before running commands/.test(e.text)), JSON.stringify(waiting.events));
  const declined = await runAgy([init, { stderr: 'permission denied: command(rm -rf x) needs approval' }, say(1, 'I could not run it'), done('I could not run it')], { access: ASK });
  check('antigravity run, ask on: a declined approval gets a notice that Antigravity cannot ask in Lumen', declined.events.some((e) => e.type === 'notice' && /didn't ask you in Lumen/.test(e.text)) && declined.out.text === 'I could not run it', JSON.stringify(declined.events));
  const noBin = new ag.AntigravityEngine({ userData: tmp, gate: async () => ({}) });
  noBin.detect = async () => null; // (whatever is installed on this computer)
  noBin.bin = null;
  const missingEvents = [];
  const missing = await noBin.run({ prompt: 'x', systemPrompt: 'S', signal: new AbortController().signal, emit: (e) => missingEvents.push(e) });
  check('antigravity run: not installed says how to install, with the official command', missing.failed === true && missingEvents[0].type === 'error' && missingEvents[0].text.includes(ag.installCommand()), JSON.stringify(missingEvents));

  // install(): runs the constant official command through an injected exec, only when called
  const calls = [];
  const eng = new ag.AntigravityEngine({ userData: tmp, gate: async () => ({}), exec: (file, args, opts, cb) => { calls.push({ file, args }); cb(null, 'installed\n', ''); } });
  check('antigravity install(): nothing runs until it is called; then exactly the official command, no shell string from input', calls.length === 0 && (await eng.install()).ok === true && calls.length === 1 && calls[0].args.includes(ag.installCommand()), JSON.stringify(calls));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
