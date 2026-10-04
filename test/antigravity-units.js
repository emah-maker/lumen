// Antigravity (Google's `agy`, which replaces Gemini CLI as a sidebar engine), plain Node (no Electron, no real CLI):
//  - its launch arguments, settings.json, hooks.json and MCP config (Lumen's browser tools only),
//  - Lumen's gate for agy's hooks (mcp-http.js), and that Claude Code and Grok Build are still sandboxed as before,
//  - a run against a fake `agy` process: stream parsing, MCP wiring, cancel, failures, usage-limit text for the model fallback,
//  - the install command (shown, never run unless asked), the picker entries, the one-shot runner for Organize.
// Verified against a real agy 1.2.14 by hand (read-only: --help, models, mcp add/list in a throwaway HOME, no model call): the flag
// names and the `agy models` format used below. The live headless behaviour is from Google's docs: see antigravity.js's header.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const flag = (argv, f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-agy-'));

(async () => {
  // ---------- the other engines are unchanged: Lumen's tools only ----------
  const cc = require('../src/ai/claude-code');
  const ccArgs = cc.buildArgs({ mcpConfig: 'm.json', sessionId: 's', systemPrompt: 'S' });
  check('claude: still no built-in tools, dontAsk, only mcp__lumen', flag(ccArgs, '--tools') === '' && flag(ccArgs, '--permission-mode') === 'dontAsk' && flag(ccArgs, '--allowedTools') === 'mcp__lumen' && ccArgs.includes('--strict-mcp-config'), ccArgs.join(' '));
  const gb = require('../src/ai/grok-build');
  const gbArgs = gb.buildArgs({ promptFile: 'p.json', sessionId: 's', systemPrompt: 'S', cwd: path.join(tmp, 'sidebar') });
  check('grok: still built-ins removed, dontAsk, Lumen\'s folder', Boolean(flag(gbArgs, '--disallowed-tools')) && flag(gbArgs, '--permission-mode') === 'dontAsk' && flag(gbArgs, '--cwd') === path.join(tmp, 'sidebar'), gbArgs.join(' '));

  // ---------- Antigravity: arguments and files ----------
  const ag = require('../src/ai/antigravity');
  const first = ag.buildArgs({ prompt: 'hi' });
  const later = ag.buildArgs({ prompt: 'hi', conversation: 'c-1', model: 'gemini-3.1-pro-high' });
  check('antigravity args: headless stream-json with the prompt, sandboxed, no model or conversation flag on a first default message', flag(first, '-p') === 'hi' && flag(first, '--output-format') === 'stream-json' && first.includes('--sandbox') && !first.includes('--model') && !first.includes('--conversation'), first.join(' '));
  check('antigravity args: never skips permissions or adds a folder, whatever else is passed', !later.includes('--dangerously-skip-permissions') && !later.includes('--add-dir') && later.includes('--sandbox'), later.join(' '));
  check('antigravity args: a later message continues the conversation with the model', flag(later, '--conversation') === 'c-1' && flag(later, '--model') === 'gemini-3.1-pro-high', later.join(' '));
  check('antigravity args: a model name that could read as a flag is not passed', !ag.buildArgs({ prompt: 'x', model: '--bad' }).includes('--bad'), '');
  const settings = ag.settingsFor({ folder: tmp, provider: 'gemini' });
  check('antigravity settings: only mcp(lumen/*) allowed; commands, writes, URLs and unsandboxed denied; terminal sandbox on', settings.permissions.allow.join() === 'mcp(lumen/*)' && ['command(*)', 'write_file(*)', 'read_url(*)', 'unsandboxed(*)', 'execute_url(*)'].every((r) => settings.permissions.deny.includes(r)) && settings.enableTerminalSandbox === true, JSON.stringify(settings));
  check('antigravity settings: the user\'s own modelProvider is carried over, telemetry off, the folder trusted', settings.modelProvider === 'gemini' && ag.settingsFor({ folder: tmp }).modelProvider === undefined && settings.enableTelemetry === false && settings.trustedWorkspaces[0] === tmp, '');
  check('antigravity MCP config: exactly one server, lumen, over HTTP with the run token', JSON.stringify(ag.mcpConfig({ mcpUrl: 'http://127.0.0.1:9/mcp', mcpToken: 'tok' })) === '{"mcpServers":{"lumen":{"serverUrl":"http://127.0.0.1:9/mcp","headers":{"Authorization":"Bearer tok"}}}}', '');
  check('antigravity MCP, stdio fallback (LUMEN_AGY_MCP=stdio): the bridge, named by this run\'s tag', JSON.stringify(ag.stdioConfig({ command: 'node', args: ['mcp.js'], env: { A: '1' } }, '/ud', 'tag-9')) === '{"mcpServers":{"lumen":{"command":"node","args":["mcp.js"],"env":{"A":"1","LUMEN_USERDATA":"/ud","LUMEN_ENGINE":"tag-9"}}}}', '');
  const hooks = ag.hooksFor('/h/lumen gate.sh', 'linux');
  const winHooks = ag.hooksFor('C:\\Users\\a b\\lumen-gate.cmd', 'win32');
  check('antigravity hooks.json: Lumen\'s gate before every tool call (any tool) and every model call, the path quoted', hooks['lumen-gate'].PreToolUse[0].matcher === '*' && hooks['lumen-gate'].PreToolUse[0].hooks[0].command === "'/h/lumen gate.sh'" && hooks['lumen-gate'].PreInvocation[0].command === "'/h/lumen gate.sh'", JSON.stringify(hooks));
  // Windows: agy runs `cmd /c <command>` through an argv that escapes quotes as \", so the command must hold none (live test failure).
  check('antigravity hooks.json (Windows): the command has no quote characters, with or without a space in the path', !/"/.test(winHooks['lumen-gate'].PreToolUse[0].hooks[0].command) && winHooks['lumen-gate'].PreToolUse[0].hooks[0].command === 'C:\\Users\\a b\\lumen-gate.cmd' && ag.hooksFor('"C:\\x\\g.cmd"', 'win32')['lumen-gate'].PreInvocation[0].command === 'C:\\x\\g.cmd', JSON.stringify(winHooks));
  if (process.platform === 'win32') {
    // Prove it: run the generated command the way agy does (cmd /c with the argument escaped by the platform's argv rules), from a
    // folder whose name has a space, once as written and once through the short path run() hands to hooksFor.
    const { spawnSync } = require('child_process');
    const spaced = path.join(tmp, 'gate dir');
    fs.mkdirSync(spaced, { recursive: true });
    const gateFile = path.join(spaced, 'lumen-gate.cmd');
    fs.writeFileSync(gateFile, '@echo off\r\nmore >nul\r\necho {"decision":"allow"}\r\n');
    const viaCmd = (command) => spawnSync('cmd', ['/c', command], { input: '{}', encoding: 'utf8', windowsHide: true });
    const plain = viaCmd(ag.hooksFor(gateFile, 'win32')['lumen-gate'].PreToolUse[0].hooks[0].command);
    const short = ag.shortPath(gateFile);
    const viaShort = viaCmd(ag.hooksFor(short, 'win32')['lumen-gate'].PreToolUse[0].hooks[0].command);
    const oldWay = viaCmd(`"${gateFile}"`);
    check('antigravity hooks.json (Windows): the generated command really runs under cmd /c, spaces in the path or not', plain.status === 0 && /"allow"/.test(plain.stdout) && viaShort.status === 0 && /"allow"/.test(viaShort.stdout), plain.stderr + viaShort.stderr);
    check('antigravity hooks.json (Windows): the old quoted form is what failed', oldWay.status !== 0 && /not recognized/.test(oldWay.stderr), oldWay.stderr + oldWay.stdout);
    check('antigravity shortPath: a path without a space is untouched; a spaced one comes back without one when the volume has short names, else unchanged', ag.shortPath('C:\\a\\b.cmd') === 'C:\\a\\b.cmd' && (!/\s/.test(short) || short === gateFile) && fs.existsSync(short) && ag.shortPath('/a b/c', 'linux') === '/a b/c', short);
  }
  check('antigravity install: the official command per OS, as an argv with no user input', ag.installCommand('linux') === 'curl -fsSL https://antigravity.google/cli/install.sh | bash' && ag.installCommand('darwin') === ag.installCommand('linux') && ag.installCommand('win32') === 'irm https://antigravity.google/cli/install.ps1 | iex' && ag.installArgv('win32').file === 'powershell.exe' && ag.installArgv('linux').args[1] === ag.installCommand('linux'), '');
  const realModels = 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.1-pro-low\tGemini 3.1 Pro (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n'; // agy 1.2.14's own output
  check('antigravity models: agy 1.2.14\'s real listing parses to slugs and display names', ag.parseModels(realModels).join() === 'gemini-3.8-flash-high,gemini-3.1-pro-low,claude-sonnet-4-6,gpt-oss-120b-medium' && ag.modelNames(realModels)['claude-sonnet-4-6'] === 'Claude Sonnet 4.6 (Thinking)', JSON.stringify(ag.modelNames(realModels)));
  check('antigravity models: bullets, marks and prose are tolerated; flags are not models', ag.parseModels('Available models:\n  * gemini-3.8-flash-high (default)\n  - claude-sonnet-4-6\n  -rf\nnotes\n').join() === 'gemini-3.8-flash-high,claude-sonnet-4-6', '');
  check('antigravity watch: a shell or file tool that is not Lumen\'s is flagged; Lumen\'s MCP tools are not', ag.offToolOf('run_command') === 'run_command' && ag.offToolOf('write_to_file') === 'write_to_file' && ag.offToolOf('mcp_lumen_click') === null && ag.offToolOf('lumen__read_page') === null && ag.offToolOf('think') === null, '');
  const firstMsg = ag.promptFor({ prompt: 'Q', systemPrompt: 'SYS', resume: false });
  const laterMsg = ag.promptFor({ prompt: 'Q', systemPrompt: 'SYS', resume: true, imageFiles: ['/a.png'] });
  check('antigravity prompt: the system text tops a conversation\'s first message only; images are named', firstMsg.startsWith('<lumen_instructions>\nSYS') && firstMsg.endsWith('Q') && !laterMsg.includes('SYS') && /untrusted data/.test(laterMsg) && laterMsg.includes('/a.png'), firstMsg + '|' + laterMsg);
  check('antigravity failure text: sign-in, usage limit, other', /not signed in/.test(ag.describeFailure('Please sign in to continue', 1).text) && /usage limit is reached/.test(ag.describeFailure('RESOURCE_EXHAUSTED: quota exceeded', 1).text) && /stopped \(exit 3\)/.test(ag.describeFailure('boom', 3).text), '');

  // ---------- model fallback (fallback.js) ----------
  const fb = require('../src/ai/fallback');
  check('fallback: Antigravity\'s limit and sign-in sentences are classified; an ordinary failure is neither', fb.classify(ag.describeFailure('RESOURCE_EXHAUSTED: quota exceeded', 1).text).kind === 'limit' && fb.classify(ag.describeFailure('Please sign in to continue', 1).text).kind === 'auth' && fb.classify(ag.describeFailure('boom', 1).text).kind === 'other', '');
  check('fallback: Antigravity is an engine with its own name', fb.isEngine('antigravity:default') && fb.providerName('antigravity:default') === 'Antigravity', fb.providerName('antigravity:default'));
  const opts = [{ id: 'antigravity:default', label: 'Antigravity', signedIn: 'unknown' }, { id: 'openai:gpt-5.6', label: 'GPT', signedIn: true }, { id: 'gemini:gemini-2.5-pro', label: 'Gemini', signedIn: true }];
  const next = fb.pick({ current: 'antigravity:default', options: opts, cooldowns: fb.shared, allowEngines: true, tried: [] });
  check('fallback: from Antigravity the Gemini API model is tried before another provider', next === 'gemini:gemini-2.5-pro', next);

  // ---------- the picker ----------
  const { antigravityOptions } = require('../src/features/ai-agents');
  const picker = antigravityOptions({ signedIn: 'unknown', models: ['gemini-3.1-pro-high'], names: { 'gemini-3.1-pro-high': 'Gemini 3.1 Pro (High)' }, saved: 'antigravity:old-model-1' });
  check('antigravity picker: default first, the models agy listed with their names, a saved pick kept, under its own group', picker[0].id === 'antigravity:default' && picker.map((o) => o.id).join() === 'antigravity:default,antigravity:gemini-3.1-pro-high,antigravity:old-model-1' && picker[1].name === 'Gemini 3.1 Pro (High)' && picker.every((o) => o.group === 'Your Google account'), picker.map((o) => o.id).join());
  check('antigravity picker: signed out shows the sign-in badge and how to sign in; the note says Lumen\'s tools only', antigravityOptions({ signedIn: false })[0].badges.includes('sign in') && /run agy/.test(antigravityOptions({ signedIn: false })[0].detail) && /only Lumen’s browser tools/.test(antigravityOptions({ signedIn: 'unknown' })[0].detail), '');

  // ---------- engine note ----------
  const agent = require('../src/ai/agent');
  const note = agent.antigravityNote('gemini-3.1-pro-high');
  check('antigravity note: tools by name, the model, the date, no shell or file tools', /read_page\(/.test(note) && /server named lumen/.test(note) && /gemini-3\.1-pro-high/.test(note) && /Today's date is \d{4}-\d\d-\d\d/.test(note) && /no shell, file or other tools/.test(note), note.slice(0, 300));
  check('antigravity: its own identity line in the system prompt, and cliSystemPrompt knows it', /Antigravity/.test(agent.systemFor({ model: 'antigravity:default' })) && !/You are Claude/.test(agent.systemFor({ model: 'antigravity:default' })) && /Google Antigravity/.test(agent.cliSystemPrompt({ model: 'antigravity:default' }, 'antigravity')), '');

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
  const ans = await cj.completeJSON({ engine: 'antigravity', bin: 'agy', model: 'default', system: 'S', user: 'U', schema: { type: 'object' }, userData: tmp, run: async (o) => { ran.push(o); return JSON.stringify({ status: 'SUCCESS', structured_output: { ok: 1 } }); } });
  check('antigravity one-shot run: the answer, in Lumen\'s own home with no MCP config and a minimal environment', ans.ok === 1 && ran[0].env.HOME === path.join(tmp, 'antigravity-oneshot') && !fs.existsSync(path.join(tmp, 'antigravity-oneshot', '.gemini', 'config', 'mcp_config.json')) && !('ANTHROPIC_API_KEY' in ran[0].env), JSON.stringify(ran[0].env.HOME));

  // ---------- Lumen's gate for agy's hooks (mcp-http.js) ----------
  const gate = await require('../src/automation/mcp-http').startHttp({ tools: ['ping', 'click', 'read_page'].map((name) => ({ name, description: 'p', input_schema: { type: 'object' } })), callTool: async () => ({ content: [], isError: false }) });
  const post = (url, body) => new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b ? JSON.parse(b) : {})); });
    req.end(JSON.stringify(body));
  });
  const hook = (run, name, args = { CommandLine: 'rm -rf x' }) => post(run.hookUrl, name === null ? { conversationId: 'c' } : { toolCall: { name, args }, stepIdx: 1 }).then((r) => r.decision || 'none');
  const agyHome = path.join(tmp, 'chat home');
  const descr = path.join(agyHome, '.gemini', 'antigravity-cli', 'mcp', 'lumen', 'read_page.json');
  const run = gate.open('a-1', 'c-1', { agy: true, home: agyHome });
  check('agy gate: a shell, file or browser tool of agy\'s own is denied with a reason', await hook(run, 'run_command') === 'deny' && await hook(run, 'write_to_file') === 'deny' && await hook(run, 'replace_file_content') === 'deny' && await hook(run, 'read_url_content') === 'deny' && (await post(run.hookUrl, { toolCall: { name: 'run_command', args: {} } })).reason.includes('Only Lumen'), '');
  check('agy gate: Lumen\'s qualified MCP tools and plain reads go through', await hook(run, 'mcp_lumen_click', {}) === 'allow' && await hook(run, 'lumen__read_page', {}) === 'allow' && await hook(run, 'mcp__lumen__ping', {}) === 'allow', '');
  check('agy gate: view_file/list_dir of Lumen\'s own descriptor folder go through; any other path, a pathless read or other reads are denied', await hook(run, 'view_file', { AbsolutePath: descr }) === 'allow' && await hook(run, 'list_dir', { DirectoryPath: path.dirname(descr) }) === 'allow' && await hook(run, 'view_file', { AbsolutePath: path.join(agyHome, 'lumen-gate.cmd') }) === 'deny' && await hook(run, 'view_file', { AbsolutePath: path.join(path.dirname(descr), '..', '..', 'settings.json') }) === 'deny' && await hook(run, 'view_file', { AbsolutePath: path.join(tmp, 'other chat', '.gemini', 'antigravity-cli', 'mcp', 'lumen', 'x.json') }) === 'deny' && await hook(run, 'view_file', {}) === 'deny' && await hook(run, 'list_dir', {}) === 'deny' && await hook(run, 'grep_search', { SearchPath: descr }) === 'deny' && await hook(run, 'view_file', { AbsolutePath: descr, Other: 1 }) === 'allow', '');
  // The stream check and the hook share one allowlist (ai/agy-tools.js): what the hook allows the stream check does not stop.
  const streamOff = (name, args) => ag.offToolOf(name, args, agyHome);
  check('antigravity watch and hook agree: the descriptor read is allowed by both, any other read or write by neither', streamOff('view_file', { AbsolutePath: descr }) === null && streamOff('view_file', { AbsolutePath: path.join(tmp, 'secret.txt') }) === 'view_file' && streamOff('view_file', undefined) === null /* no path in the stream: the hook decides */ && streamOff('write_to_file', { TargetFile: descr }) === 'write_to_file' && streamOff('run_command', {}) === 'run_command' && streamOff('view_file', { AbsolutePath: descr.replace('read_page', '..\\..\\..\\..\\x') }) === 'view_file', '');
  for (const [nm, a] of [['view_file', { AbsolutePath: descr }], ['view_file', { AbsolutePath: path.join(tmp, 'x') }], ['list_dir', { DirectoryPath: path.dirname(descr) }], ['write_to_file', { TargetFile: descr }], ['run_command', { CommandLine: 'x' }], ['view_file_outline', { AbsolutePath: descr }]]) {
    check(`agy allowlist: the hook and the stream check agree on ${nm} ${JSON.stringify(a).slice(0, 40)}`, (await hook(run, nm, a) === 'allow') === (streamOff(nm, a) === null), '');
  }
  check('agy gate fails closed: agy\'s other tools (generate_image, invoke_subagent, unknown names) are denied', await hook(run, 'generate_image', {}) === 'deny' && await hook(run, 'invoke_subagent', {}) === 'deny' && await hook(run, 'some_new_tool', {}) === 'deny' && await hook(run, '', {}) === 'deny', '');
  check('agy gate fails closed: "lumen" inside another server or tool name, or a tool Lumen lacks, is denied', await hook(run, 'mcp_evil_lumen_click', {}) === 'deny' && await hook(run, 'mcp_notlumen_click', {}) === 'deny' && await hook(run, 'lumen_helper', {}) === 'deny' && await hook(run, 'mcp_lumen_delete_everything', {}) === 'deny' && await hook(run, 'lumenclick', {}) === 'deny', '');
  check('agy gate: the PreInvocation ping marks the run as seen', !gate.armed('a-1') && await hook(run, null) === 'none' && gate.armed('a-1'), '');
  gate.close('a-1');
  check('agy gate: after the run its hook URL denies in agy\'s format too', await hook(run, 'run_command') === 'deny', '');
  const grokRun = gate.open('g-1', 'c-g');
  const grokVerdict = (await post(grokRun.hookUrl, { hook_event_name: 'PreToolUse', tool_name: 'write', tool_input: {} })).hookSpecificOutput?.permissionDecision;
  check('grok gate is unchanged: a built-in write is still denied', grokVerdict === 'deny', String(grokVerdict));
  gate.stop();

  // ---------- Antigravity: a run against a fake agy ----------
  const fake = (script, extra = {}) => {
    const spawns = [];
    const kills = [];
    const spawn = (bin, argv, opts) => {
      const child = new EventEmitter();
      Object.assign(child, { pid: 5000 + spawns.length, exitCode: null, killed: false, stdout: new PassThrough(), stderr: new PassThrough() });
      const rec = { bin, argv, opts, child, mcp: null };
      const cfg = (...p) => { try { return JSON.parse(fs.readFileSync(path.join(opts.env.HOME, '.gemini', ...p), 'utf8')); } catch { return null; } };
      rec.mcp = cfg('config', 'mcp_config.json');
      rec.settings = cfg('antigravity-cli', 'settings.json');
      rec.hooks = cfg('config', 'hooks.json');
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
  async function runAgy(script, { run: runOpts = {}, extra = {} } = {}) {
    const data = fs.mkdtempSync(path.join(tmp, 'ud-'));
    const f = fake(script, extra);
    const g = { opened: [], closed: [], open(tag, session, opts) { this.opened.push({ tag, session, opts }); return { mcpUrl: 'http://127.0.0.1:1/mcp', mcpToken: 'm'.repeat(48), hookUrl: 'http://127.0.0.1:1/hook/x' }; }, close(tag) { this.closed.push(tag); } };
    const engine = new ag.AntigravityEngine({ userData: data, gate: async () => g, spawn: f.spawn, kill: f.kill });
    engine.bin = process.execPath; // "found": any file that exists
    const events = [];
    const out = await engine.run({ prompt: 'hello', sessionId: null, systemPrompt: 'SYS', signal: new AbortController().signal, emit: (e) => events.push(e), ...runOpts });
    return { out, events, f, gate: g, data, engine };
  }
  const init = { event: 'init', conversation_id: 'conv-1', init: { cwd: '/x', tools: ['run_command'], permission_mode: 'request-review', model: 'gemini-3.8-flash-high' } };
  const say = (index, text) => ({ event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: index, state: 'ACTIVE', step_type: 'agent_response', text_delta: text } });
  const tool = (index, name) => ({ event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: index, state: 'ACTIVE', step_type: 'tool', tool_name: name } });
  const done = (response, status = 'SUCCESS', extra = {}) => ({ event: 'result', result: { conversation_id: 'conv-1', status, response, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }, ...extra } });

  const ok = await runAgy([init, say(1, 'Hel'), say(1, 'lo'), say(2, ' there'), done('Hello there')]);
  check('antigravity run: streams text, joins steps as paragraphs, returns the conversation id, model and usage', ok.out.text === 'Hello\n\n there' && ok.out.sessionId === 'conv-1' && ok.out.model === 'gemini-3.8-flash-high' && ok.out.usage?.total_tokens === 12 && ok.events.filter((e) => e.type === 'text').map((e) => e.text).join('') === 'Hello there', JSON.stringify([ok.out, ok.events]));
  const sp = ok.f.spawns[0];
  check('antigravity run: Lumen\'s own home, its MCP config, settings and hooks written before the spawn, an empty folder, no shell, --sandbox', sp.opts.shell === false && sp.opts.env.HOME === path.join(ok.data, 'antigravity-home') && sp.opts.env.USERPROFILE === sp.opts.env.HOME && sp.opts.cwd === path.join(ok.data, 'antigravity-sidebar') && Object.keys(sp.mcp.mcpServers).join() === 'lumen' && sp.mcp.mcpServers.lumen.serverUrl === 'http://127.0.0.1:1/mcp' && sp.settings.permissions.deny.includes('command(*)') && sp.hooks['lumen-gate'].PreToolUse.length === 1 && sp.argv.includes('--sandbox'), JSON.stringify([sp.opts.cwd, sp.mcp, sp.settings]));
  check('antigravity run: the gate script is in the home and the hook URL only in the child\'s environment', fs.existsSync(path.join(ok.data, 'antigravity-home', process.platform === 'win32' ? 'lumen-gate.cmd' : 'lumen-gate.sh')) && sp.opts.env.LUMEN_HOOK_URL === 'http://127.0.0.1:1/hook/x' && !sp.argv.join(' ').includes('hook/x'), JSON.stringify(Object.keys(sp.opts.env)));
  check('antigravity run: the gate run is opened for Antigravity (its hooks answer in agy\'s format); the first message carries the system text', ok.gate.opened[0].opts?.agy === true && flag(sp.argv, '-p').startsWith('<lumen_instructions>\nSYS'), JSON.stringify(ok.gate.opened));
  check('antigravity run: the run\'s MCP token file is gone afterwards, the gate run closed', !fs.existsSync(path.join(ok.data, 'antigravity-home', '.gemini', 'config', 'mcp_config.json')) && ok.gate.closed.length === 1, '');
  check('antigravity run: the environment is a short list, no API keys of the user\'s shell', !('ANTHROPIC_API_KEY' in sp.opts.env) && sp.opts.env.NO_COLOR === '1', '');

  // [parallel Antigravity chats] a chat's run uses that chat's own home (its token file and conversations), seeded once
  {
    const data = fs.mkdtempSync(path.join(tmp, 'ud-chat-'));
    const mainGemini = path.join(data, 'antigravity-home', '.gemini');
    fs.mkdirSync(path.join(mainGemini, 'antigravity-cli', 'conversations'), { recursive: true });
    fs.mkdirSync(path.join(mainGemini, 'antigravity-cli', 'log'), { recursive: true });
    fs.writeFileSync(path.join(mainGemini, 'antigravity-cli', 'conversations', 'old-conv.db'), 'old');
    fs.writeFileSync(path.join(mainGemini, 'antigravity-cli', 'conversations', 'other-conv.db'), 'other');
    fs.writeFileSync(path.join(mainGemini, 'antigravity-cli', 'installation_id'), 'inst-1');
    fs.writeFileSync(path.join(mainGemini, 'oauth_creds.json'), 'creds-1');
    const runIn = async (chatId, sessionId = null) => {
      const f = fake([init, done('ok')]);
      const g = { open() { return { mcpUrl: 'http://127.0.0.1:1/mcp', mcpToken: 't'.repeat(48), hookUrl: 'http://127.0.0.1:1/hook/x' }; }, close() {} };
      const engine = new ag.AntigravityEngine({ userData: data, gate: async () => g, spawn: f.spawn, kill: f.kill });
      engine.bin = process.execPath;
      const out = await engine.run({ prompt: 'hi', sessionId, systemPrompt: 'S', signal: new AbortController().signal, emit: () => {}, scope: { chatId } });
      return { out, sp: f.spawns[0] };
    };
    const c1 = await runIn('chat1', 'old-conv');
    const home1 = ag.chatHomeFor(data, 'chat1');
    const g1 = path.join(home1, '.gemini');
    check('antigravity chat home: a chat\'s run has HOME in its own folder, with its MCP token file there (not in the main home)', c1.sp.opts.env.HOME === home1 && c1.sp.mcp?.mcpServers?.lumen && !fs.existsSync(path.join(mainGemini, 'config', 'mcp_config.json')) && !fs.existsSync(path.join(g1, 'config', 'mcp_config.json')), JSON.stringify([c1.sp.opts.env.HOME, home1]));
    check('antigravity chat home: seeded from the main home without logs or other chats\' conversations; the chat\'s saved conversation is migrated; sign-in files shared', fs.readFileSync(path.join(g1, 'antigravity-cli', 'installation_id'), 'utf8') === 'inst-1' && !fs.existsSync(path.join(g1, 'antigravity-cli', 'log')) && fs.readdirSync(path.join(g1, 'antigravity-cli', 'conversations')).join() === 'old-conv.db' && fs.readFileSync(path.join(g1, 'oauth_creds.json'), 'utf8') === 'creds-1', JSON.stringify(fs.readdirSync(path.join(g1, 'antigravity-cli'))));
    fs.writeFileSync(path.join(g1, 'antigravity-cli', 'installation_id'), 'chat-own');
    fs.writeFileSync(path.join(mainGemini, 'antigravity-cli', 'installation_id'), 'inst-2');
    const later = Date.now() / 1000 + 5;
    fs.writeFileSync(path.join(mainGemini, 'oauth_creds.json'), 'creds-2');
    fs.utimesSync(path.join(mainGemini, 'oauth_creds.json'), later, later);
    await runIn('chat1', 'old-conv');
    check('antigravity chat home: seeded once (later runs keep the chat\'s own state), but a newer sign-in in the main home is picked up', fs.readFileSync(path.join(g1, 'antigravity-cli', 'installation_id'), 'utf8') === 'chat-own' && fs.readFileSync(path.join(g1, 'oauth_creds.json'), 'utf8') === 'creds-2');
    const later2 = Date.now() / 1000 + 20;
    fs.writeFileSync(path.join(g1, 'oauth_creds.json'), 'creds-refreshed');
    fs.utimesSync(path.join(g1, 'oauth_creds.json'), later2, later2);
    await runIn('chat1', 'old-conv'); // (agy refreshed its sign-in during this run)
    const c2 = await runIn('chat2');
    check('antigravity chat home: another chat gets another home; a sign-in a chat\'s agy refreshed goes back to the main home and on to new chats', c2.sp.opts.env.HOME === ag.chatHomeFor(data, 'chat2') && c2.sp.opts.env.HOME !== home1 && fs.readFileSync(path.join(mainGemini, 'oauth_creds.json'), 'utf8') === 'creds-refreshed' && fs.readFileSync(path.join(ag.chatHomeFor(data, 'chat2'), '.gemini', 'oauth_creds.json'), 'utf8') === 'creds-refreshed', fs.readFileSync(path.join(mainGemini, 'oauth_creds.json'), 'utf8'));
    check('antigravity chat home: an odd chat id never escapes the chats folder', path.dirname(ag.chatHomeFor(data, '../../etc')) === ag.chatsDirFor(data) && ag.chatHomeFor(data, null) === null);
  }

  // [prepare] The message's setup that needs no message (the chat's home and its settings, gate script and hooks) is done by
  // prepare() while the page is read; run() takes the same work over instead of repeating it, and writes only the token file.
  {
    const data = fs.mkdtempSync(path.join(tmp, 'ud-prep-'));
    const f = fake([init, done('ok')]);
    let gates = 0;
    const g = { open() { return { mcpUrl: 'http://127.0.0.1:1/mcp', mcpToken: 'p'.repeat(48), hookUrl: 'http://127.0.0.1:1/hook/x' }; }, close() {} };
    const engine = new ag.AntigravityEngine({ userData: data, gate: async () => { gates++; return g; }, spawn: f.spawn, kill: f.kill });
    engine.bin = process.execPath;
    const scope = { chatId: 'prep-chat' };
    const home = ag.chatHomeFor(data, 'prep-chat');
    const early = engine.prepare({ scope, sessionId: null, fullAccess: false });
    const prepared = await early;
    const hooksFile = path.join(home, '.gemini', 'config', 'hooks.json');
    const settingsFile = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
    check('antigravity prepare: the chat\'s settings, gate script and hooks are in place before any message, the token file is not', prepared.bin === process.execPath && prepared.home === home && fs.existsSync(hooksFile) && fs.existsSync(settingsFile) && fs.existsSync(path.join(home, process.platform === 'win32' ? 'lumen-gate.cmd' : 'lumen-gate.sh')) && !fs.existsSync(path.join(home, '.gemini', 'config', 'mcp_config.json')), JSON.stringify(Object.keys(prepared)));
    check('antigravity prepare: the same message asks again and gets the same work (one gate lookup)', engine.prepare({ scope, sessionId: null, fullAccess: false }) === early && gates === 1, String(gates));
    const m0 = fs.statSync(settingsFile).mtimeMs;
    const out = await engine.run({ prompt: 'hi', sessionId: null, systemPrompt: 'S', signal: new AbortController().signal, emit: () => {}, scope });
    check('antigravity prepare: run() uses it (no second gate lookup, settings not rewritten) and the spawn sees all four files', out.sessionId === 'conv-1' && gates === 1 && fs.statSync(settingsFile).mtimeMs === m0 && f.spawns[0].mcp && f.spawns[0].settings && f.spawns[0].hooks, String(gates));
    const again = engine.prepare({ scope, sessionId: 'conv-1', fullAccess: false });
    check('antigravity prepare: used up by that run: the next message looks again (and another conversation or access is another key)', again !== early && engine.prepare({ scope, sessionId: 'conv-1', fullAccess: true }) !== again, '');
    await again;
    const none = new ag.AntigravityEngine({ userData: data, gate: async () => g, spawn: f.spawn, kill: f.kill });
    none.bin = null;
    process.env.LUMEN_AGY_BIN = path.join(tmp, 'no-such-agy');
    check('antigravity prepare: no agy installed resolves { bin: null } and writes nothing', (await none.prepare({ scope: { chatId: 'nobin' } })).bin === null && !fs.existsSync(ag.chatHomeFor(data, 'nobin')), '');
    delete process.env.LUMEN_AGY_BIN;
  }

  const resumed = await runAgy([init, say(1, 'ok'), done('ok')], { run: { sessionId: 'conv-1', model: 'gemini-3.1-pro-high' } });
  const rp = resumed.f.spawns[0];
  check('antigravity run: a later message continues the conversation with --conversation and the model, with a reminder, not the whole system text; the gate run carries the conversation id', flag(rp.argv, '--conversation') === 'conv-1' && flag(rp.argv, '--model') === 'gemini-3.1-pro-high' && !flag(rp.argv, '-p').includes('SYS') && /lumen_reminder/.test(flag(rp.argv, '-p')) && resumed.gate.opened[0].session === 'conv-1', rp.argv.join(' ').slice(0, 300));

  const longPrompt = await runAgy([init, done('x')], { run: { prompt: 'p'.repeat(ag.PROMPT_ARG_MAX + 100) } });
  check('antigravity run: a message too long for the command line goes in a file read from the working folder, and removed after', /Read the file .*lumen-message-/.test(flag(longPrompt.f.spawns[0].argv, '-p')) && flag(longPrompt.f.spawns[0].argv, '-p').length < 600 && fs.readdirSync(path.join(longPrompt.data, 'antigravity-sidebar')).length === 0, flag(longPrompt.f.spawns[0].argv, '-p').slice(0, 120));
  const withImage = await runAgy([init, done('x')], { run: { images: [{ media_type: 'image/png', data: Buffer.from('png').toString('base64') }] } });
  check('antigravity run: an image is written to a file the prompt names, and removed after', /lumen-image-.*\.png/.test(flag(withImage.f.spawns[0].argv, '-p')) && fs.readdirSync(path.join(withImage.data, 'antigravity-sidebar')).length === 0, flag(withImage.f.spawns[0].argv, '-p').slice(-200));

  const bad = await runAgy([init, say(1, 'about to'), { event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi > x' } } } }, say(3, 'never shown'), done('never')]);
  check('antigravity run: a shell tool that is not Lumen\'s stops the run, drops the conversation and says so', bad.f.kills.length === 1 && bad.out.failed === true && bad.out.sessionId === null && bad.events.some((e) => e.type === 'error' && /isn't one of Lumen's \(run_command\)/.test(e.text)) && !bad.events.some((e) => e.text === 'never shown'), JSON.stringify(bad.events));
  const lumenTool = await runAgy([init, tool(1, 'mcp_lumen_read_page'), say(2, 'read'), done('read')]);
  check('antigravity run: a Lumen MCP tool call is fine', lumenTool.f.kills.length === 0 && lumenTool.out.text === 'read', JSON.stringify(lumenTool.events));

  const ctl = new AbortController();
  const st = await runAgy([init, say(1, 'part'), () => ctl.abort(), say(1, 'x'), done('x')], { run: { signal: ctl.signal } });
  check('antigravity run: Stop kills the process tree and returns what was said, stopped', st.f.kills.length >= 1 && st.out.stopped === true && st.out.text.startsWith('part'), JSON.stringify(st.out));

  const signedOut = await runAgy([init, done('', 'ERROR', { error: 'Please sign in to continue' })]);
  check('antigravity run: a sign-in failure says how to sign in, and status() then reports signed out', signedOut.events.some((e) => e.type === 'error' && /not signed in/.test(e.text) && /run `agy`/.test(e.text)) && signedOut.out.failed === true && (await signedOut.engine.status(true)).signedIn === false, JSON.stringify(signedOut.events));
  const limited = await runAgy([init, done('', 'ERROR', { error: 'RESOURCE_EXHAUSTED: You have exhausted your capacity. Your quota will reset after 2h 10m.' })]);
  const limitEvent = limited.events.find((e) => e.type === 'error');
  check('antigravity run: a usage-limit failure carries a reset time and classifies as a limit for the model fallback', fb.classify(limitEvent.text).kind === 'limit' && limited.out.planLimit?.resetsAt > Date.now(), JSON.stringify([limitEvent, limited.out.planLimit]));
  const waiting = await runAgy([init, done('', 'WAITING')]);
  check('antigravity run: WAITING (an approval it cannot show) is explained: Lumen\'s browser tools only', waiting.events.some((e) => e.type === 'error' && /browser tools only/.test(e.text)), JSON.stringify(waiting.events));
  const noBin = new ag.AntigravityEngine({ userData: tmp, gate: async () => ({}) });
  noBin.detect = async () => null; // (whatever is installed on this computer)
  noBin.bin = null;
  const missingEvents = [];
  const missing = await noBin.run({ prompt: 'x', systemPrompt: 'S', signal: new AbortController().signal, emit: (e) => missingEvents.push(e) });
  check('antigravity run: not installed says how to install, with the official command', missing.failed === true && missingEvents[0].type === 'error' && missingEvents[0].text.includes(ag.installCommand()), JSON.stringify(missingEvents));

  // install(): runs the constant official command through an injected exec, only when called
  const calls = [];
  const eng = new ag.AntigravityEngine({ userData: tmp, gate: async () => ({}), exec: (file, args, o, cb) => { calls.push({ file, args }); cb(null, 'installed\n', ''); } });
  check('antigravity install(): nothing runs until it is called; then exactly the official command, no shell string from input', calls.length === 0 && (await eng.install()).ok === true && calls.length === 1 && calls[0].args.includes(ag.installCommand()), JSON.stringify(calls));

  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows may still hold the folder for a moment; the OS temp cleanup takes it */ }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
