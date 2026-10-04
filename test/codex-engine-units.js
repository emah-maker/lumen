// The Codex sidebar engine (src/ai/codex.js), plain Node: no Codex, no network, no Electron.
//  - the argv (read-only sandbox, prompt on stdin, model, resume, pictures, never a bypass flag), config.toml (one MCP server, token only by
//    environment variable, shell tools off), the environment the child gets;
//  - `codex exec --json` event parsing (no text deltas, retry notices that are not failures, off-tool detection);
//  - a run against a fake child process: streaming text, per-run MCP token (opened, closed, never in argv/config), thread id for resume,
//    stop kills the tree, usage and plan limit, failure texts, temp folder cleanup, the models list from Codex's cache;
//  - the picker entries (tiers for Auto), the interrupted-reply note on the next message.
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = (v) => JSON.stringify(v);

const cx = require('../src/ai/codex');
const { codexOptions } = require('../src/features/ai-agents');
const auto = require('../src/ai/auto-model');
const fallback = require('../src/ai/fallback');

// ---------- argv ----------
{
  const base = cx.buildArgs({});
  check('argv: exec --json, no git check, read-only sandbox, the prompt from stdin', J(base) === J(['exec', '--json', '--skip-git-repo-check', '--color', 'never', '--sandbox', 'read-only', '-']), J(base));
  const m = cx.buildArgs({ model: 'gpt-6-luna' });
  check('argv: -m <model> for a picked model, none for the default', m.join(' ').includes('-m gpt-6-luna') && !base.includes('-m'), J(m));
  const bad = cx.buildArgs({ model: '--dangerously-bypass-approvals-and-sandbox' });
  check('argv: a model name that could read as a flag is never passed', !bad.some((a) => /dangerously/.test(a)) && !bad.includes('-m'), J(bad));
  const r = cx.buildArgs({ conversation: '0199aaaa-bbbb-cccc-dddd-eeeeffff0000', model: 'gpt-6-astra' });
  check('argv: a thread is resumed as `exec <options> resume <id> -`, options before resume', r.join(' ').endsWith('resume 0199aaaa-bbbb-cccc-dddd-eeeeffff0000 -') && r.indexOf('--sandbox') < r.indexOf('resume') && r.indexOf('-m') < r.indexOf('resume'), J(r));
  check('argv: a thread id that is not an id is not resumed', !cx.buildArgs({ conversation: 'x y;rm -rf' }).includes('resume'));
  const img = cx.buildArgs({ imageFiles: ['/tmp/a b/image-0.png'] });
  check('argv: pictures go as --image=<file> before the prompt', img.includes('--image=/tmp/a b/image-0.png') && img[img.length - 1] === '-', J(img));
  const all = [base, m, r, img].flat().join(' ');
  check('argv: never a bypass, full-auto, writable sandbox or approval flag', !/dangerously|bypass|full-auto|workspace-write|danger-full-access|--ask-for-approval|--yolo/.test(all), all);
  check('argv: no quote, %, & or other cmd.exe syntax (a .cmd shim may run it through cmd.exe)', ![base, m, r].flat().some((a) => /["%^&|<>!]/.test(a)), all);
}

// ---------- config.toml ----------
{
  const run = { mcpUrl: 'http://127.0.0.1:5123/mcp', mcpToken: 'SECRETTOKEN' };
  const t = cx.configFor({ model: 'gpt-6-luna', run });
  check('config: read-only sandbox, never asks, no update check', /sandbox_mode = "read-only"/.test(t) && /approval_policy = "never"/.test(t) && /check_for_update_on_startup = false/.test(t));
  check('config: Codex\'s shell, picture, browser, computer, sub-agent, app and plugin tools and web search are off, with only keys codex-cli 0.160.0 knows', ['shell_tool', 'view_image', 'image_generation', 'browser_use', 'computer_use', 'multi_agent', 'apps', 'plugins'].every((k) => new RegExp(`${k} = false`).test(t)) && /web_search = "disabled"/.test(t) && !/include_apply_patch_tool|view_image_tool|apply_patch_freeform|web_search_request/.test(t), t);
  check('config: the Code Mode host stays on (Codex 0.160 gives the model its MCP tools only through it)', !/code_mode_host = false/.test(t), t);
  check('config: exactly one MCP server, lumen, over HTTP with the bearer token in an environment variable', (t.match(/^\[mcp_servers\./gm) || []).length === 1 && /\[mcp_servers\.lumen\]/.test(t) && /url = "http:\/\/127\.0\.0\.1:5123\/mcp"/.test(t) && /bearer_token_env_var = "LUMEN_MCP_TOKEN"/.test(t), t);
  check('config: the token itself is not in the file', !t.includes('SECRETTOKEN'));
  check('config: long timeouts (an approval card waits for the user) and tool approvals left to Lumen\'s own card', /startup_timeout_sec = 30/.test(t) && /tool_timeout_sec = 600/.test(t) && /default_tools_approval_mode = "approve"/.test(t));
  check('config: the model is set when picked, absent for the default', /model = "gpt-6-luna"/.test(t) && !/^model = /m.test(cx.configFor({ run })));
  const stdio = cx.configFor({ bridge: { command: 'C:\\Lumen\\Lumen.exe', args: ['C:\\Lumen\\mcp.js'], env: { ELECTRON_RUN_AS_NODE: '1' } }, userData: 'C:\\ud', tag: 'TAG1' });
  check('config: the stdio form names the run by LUMEN_ENGINE and still has one server', /command = "C:\\\\Lumen\\\\Lumen.exe"/.test(stdio) && /LUMEN_ENGINE = "TAG1"/.test(stdio) && (stdio.match(/^\[mcp_servers\./gm) || []).length === 1 && !/bearer_token_env_var/.test(stdio), stdio);
}

// ---------- full access (codexFullAccess) ----------
{
  const on = cx.buildArgs({ fullAccess: true, model: 'gpt-6-luna' });
  const off = cx.buildArgs({ model: 'gpt-6-luna' });
  check('full: argv says --sandbox danger-full-access; off is unchanged (read-only); never a bypass, full-auto or approval flag', on[on.indexOf('--sandbox') + 1] === 'danger-full-access' && !on.includes('read-only') && off[off.indexOf('--sandbox') + 1] === 'read-only' && !on.some((a) => /bypass|dangerously|full-auto|ask-for-approval|yolo/.test(a)), on.join(' '));
  const t = cx.configFor({ run: { mcpUrl: 'http://127.0.0.1:5123/mcp' }, fullAccess: true });
  check('full: config.toml has the sandbox off and web search live, approval still never, one MCP server', /sandbox_mode = "danger-full-access"/.test(t) && /approval_policy = "never"/.test(t) && /web_search = "live"/.test(t) && (t.match(/^\[mcp_servers\./gm) || []).length === 1);
  check('full: shell, unified exec and view_image are back on; plugins, apps, hooks, memories, sub-agents, browser and computer use stay off; the Code Mode host stays on', cx.FULL_ON.join() === 'shell_tool,unified_exec,view_image' && cx.FULL_ON.every((k) => !new RegExp('^' + k + ' = false', 'm').test(t)) && ['plugins', 'apps', 'hooks', 'memories', 'multi_agent', 'browser_use', 'computer_use'].every((k) => new RegExp('^' + k + ' = false', 'm').test(t)) && !/code_mode_host = false/.test(t), t);
  const base = { PATH: '/bin', MY_TOKEN: 't', ELECTRON_RUN_AS_NODE: '1' };
  const e = cx.buildEnv({ home: '/h', base, run: { mcpToken: 'TOK' }, fullAccess: true });
  check('full: the user\'s whole environment (not Electron\'s switch) plus Lumen\'s Codex home and token; off is the short list', e.MY_TOKEN === 't' && !('ELECTRON_RUN_AS_NODE' in e) && e.CODEX_HOME === '/h' && e.LUMEN_MCP_TOKEN === 'TOK' && !('MY_TOKEN' in cx.buildEnv({ home: '/h', base })));
  const sh = { type: 'command_execution' };
  check('full: Codex\'s shell, file and web items are not off-tools then; another server\'s tool still is', cx.offItemOf(sh, { fullAccess: true }) === null && cx.offItemOf({ type: 'file_change' }, { fullAccess: true }) === null && cx.offItemOf({ type: 'web_search' }, { fullAccess: true }) === null && cx.offItemOf(sh) && /other\/t/.test(cx.offItemOf({ type: 'mcp_tool_call', server: 'other', tool: 't' }, { fullAccess: true })));
  check('full: a Codex that rejects the options is told plainly, pointing at the setting', /Nothing ran/.test(cx.describeFailure('error: unexpected argument \'--sandbox\' found', 2, { fullAccess: true }).text) && !/Nothing ran/.test(cx.describeFailure('error: unexpected argument', 2).text));
  const { codexNote } = require('../src/ai/agent');
  const note = codexNote(null, new Date(), { fullAccess: true, home: 'C:\\Users\\x' });
  check('full: the system note names the home folder, says relative paths start in an empty scratch folder, keeps Lumen\'s tools and the untrusted-page warning; off says there is no shell', /C:\\Users\\x/.test(note) && /empty scratch folder/.test(note) && /server named lumen/.test(note) && /untrusted/.test(note) && /no shell/.test(codexNote()) && !/scratch/.test(codexNote()));
}

// ---------- the child's environment ----------
{
  const env = cx.buildEnv({ home: '/h', base: { PATH: '/bin', HOME: '/u', OPENAI_API_KEY: 'k', CODEX_API_KEY: 'c', AWS_SECRET_ACCESS_KEY: 'no', GITHUB_TOKEN: 'no', ELECTRON_RUN_AS_NODE: '1', CODEX_HOME: '/user/.codex' }, run: { mcpToken: 'TOK' } });
  check('env: the run\'s token and Codex home, the API-key sign-in and the basics; nothing else of the user\'s environment', env.LUMEN_MCP_TOKEN === 'TOK' && env.CODEX_HOME === '/h' && env.OPENAI_API_KEY === 'k' && env.CODEX_API_KEY === 'c' && env.PATH === '/bin' && !('AWS_SECRET_ACCESS_KEY' in env) && !('GITHUB_TOKEN' in env) && !('ELECTRON_RUN_AS_NODE' in env), J(env));
}

// ---------- events ----------
{
  const p = cx.parseEvent;
  check('events: thread.started gives the thread id', J(p({ type: 'thread.started', thread_id: 'abc' })) === J({ kind: 'thread', id: 'abc' }));
  check('events: an agent_message is whole text (no deltas); other item types are items to check', p({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'hi' } }).text === 'hi' && p({ type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'lumen', tool: 'read_page' } }).kind === 'item');
  check('events: reasoning shows as thinking when completed', p({ type: 'item.completed', item: { type: 'reasoning', text: 'hmm' } }).kind === 'thinking' && p({ type: 'item.started', item: { type: 'reasoning', text: 'hmm' } }) === null);
  const done = p({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7, reasoning_output_tokens: 2 } });
  check('events: turn.completed carries usage, cached tokens split from the input', done.kind === 'done' && done.usage.inputTokens === 60 && done.usage.cacheReadTokens === 40 && done.usage.outputTokens === 7, J(done));
  check('events: turn.failed is a failure, a bare error event is only noted', p({ type: 'turn.failed', error: { message: 'boom' } }).kind === 'failed' && p({ type: 'error', message: 'Reconnecting... 2/5' }).kind === 'error');
  check('events: junk and unknown types are ignored', p(null) === null && p({ type: 'turn.started' }) === null && p('x') === null);
  check('off-tool: a shell command, a file change, a web search and another server\'s tool are named; Lumen\'s own tools and messages are not', cx.offItemOf({ type: 'command_execution' }) && cx.offItemOf({ type: 'file_change' }) && cx.offItemOf({ type: 'web_search' }) && /other\/x/.test(cx.offItemOf({ type: 'mcp_tool_call', server: 'other', tool: 'x' })) && cx.offItemOf({ type: 'mcp_tool_call', server: 'lumen', tool: 'navigate' }) === null && cx.offItemOf({ type: 'todo_list' }) === null);
}

// ---------- the models Codex lists ----------
{
  const cache = J({ models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list', priority: 2 }, { slug: 'gpt-6-luna', visibility: 'list', priority: 3 }, { slug: 'internal-x', visibility: 'hide', priority: 0 }, { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', priority: 1 }, { slug: '--bad', priority: 9 }] });
  const list = cx.modelsFromCache(cache);
  check('models: the cached list, best first, hidden and invalid ids left out, named and tiered', list.map((m) => m.id).join() === 'gpt-6-astra,gpt-6.1-sol,gpt-6-luna' && list[0].name === 'GPT-6 Astra' && list[2].name === 'GPT 6 Luna' || list[2].name === 'GPT-6 Luna', J(list));
  check('models: tiers by the vendor\'s own size words (Luna fast, Sol balanced, Astra strong)', J(list.map((m) => m.tier)) === J(['strong', 'balanced', 'fast']), J(list));
  check('models: an unreadable cache gives none (the documented ids are used then)', cx.modelsFromCache('{nope').length === 0 && cx.FALLBACK_MODELS.length >= 3);
  const options = codexOptions({ signedIn: true, models: cx.FALLBACK_MODELS });
  check('picker: Codex default first (no --model), then each model, in "Your OpenAI account", each with its tier for Auto', options[0].id === 'codex:default' && options.slice(1).every((o) => o.group === 'Your OpenAI account' && o.provider === 'Codex' && ['fast', 'balanced', 'strong'].includes(o.tier)) && options.some((o) => o.id === 'codex:gpt-6-luna' && o.tier === 'fast'), J(options.map((o) => [o.id, o.tier])));
  check('picker: signed out shows "sign in"; a saved pick the list lacks stays offered', codexOptions({ signedIn: false, models: [] })[0].badges.includes('sign in') && codexOptions({ signedIn: true, models: [], saved: 'codex:gpt-9' }).some((o) => o.id === 'codex:gpt-9'));
  check('providers: codex is an engine, related to OpenAI (its same-vendor fallback route)', fallback.isEngine('codex:gpt-6-luna') && fallback.relatedOf('codex').includes('openai') && fallback.relatedOf('openai').includes('codex') && fallback.providerOf('codex:default') === 'codex');
}

// ---------- failure texts ----------
{
  const d = cx.describeFailure;
  check('failure: not signed in names `codex login`', /not signed in/.test(d('Not logged in. Please run `codex login`').text) && /not signed in/.test(d('unexpected status 401 Unauthorized').text));
  check('failure: a usage limit is a limit (the fallback and Auto skip read it)', /usage limit is reached/.test(d('You\'ve hit your usage limit. Try again at 3:40 PM.').text) && fallback.classify(d('You\'ve hit your usage limit. Try again in 3 hours.').text).kind === 'limit');
  check('failure: an unknown config key says to update Codex', /Update Codex/.test(d('Error loading config.toml: unknown field `default_tools_approval_mode`').text));
  check('failure: anything else shows the first lines with the exit code', /Codex stopped \(exit 3\): oops/.test(d('oops', 3).text));
}

// ---------- a run against a fake child ----------
function fakeChild(lines, { close = true, code = 0, stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 4242;
  child.exitCode = null;
  const stdin = [];
  child.stdin.on('data', (d) => stdin.push(String(d)));
  child.input = () => stdin.join('');
  setImmediate(() => {
    for (const l of lines) child.stdout.write(`${typeof l === 'string' ? l : JSON.stringify(l)}\n`);
    if (stderr) child.stderr.write(stderr);
    if (close) setTimeout(() => { child.exitCode = code; child.emit('close', code); }, 10);
  });
  return child;
}
const gateOf = () => { const g = { opened: [], closed: [] }; g.open = (tag, chat) => { g.opened.push({ tag, chat }); return { mcpUrl: 'http://127.0.0.1:9/mcp', mcpToken: `tok-${tag.slice(0, 6)}` }; }; g.close = (tag) => g.closed.push(tag); return g; };
const spec = { found: true, command: process.execPath, args: [], path: process.execPath, kind: 'exe', version: '9.9.9' };

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cx-units-'));
  const userHome = path.join(userData, 'user-codex');
  const tmp = path.join(userData, 'tmp');
  fs.mkdirSync(userHome, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(userHome, 'auth.json'), '{"fake":1}');
  const spawned = [];
  const killed = [];
  const make = (lines, opts) => {
    const gate = gateOf();
    const engine = new cx.CodexEngine({ userData, gate: async () => gate, locate: async () => spec, userHome: () => userHome, tmp, watchdogMs: 0, spawn: (bin, argv, o) => { const c = fakeChild(lines, opts); spawned.push({ bin, argv, o, child: c }); return c; }, kill: (c) => { killed.push(c); setImmediate(() => { c.exitCode = 1; c.emit('close', 1); }); } });
    return { engine, gate };
  };
  const emitted = [];
  const emit = (e) => emitted.push(e);
  const ok = [{ type: 'thread.started', thread_id: '0199aaaa-bbbb-cccc-dddd-eeeeffff0001' }, { type: 'turn.started' }, { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'Looking.' } }, { type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'lumen', tool: 'read_page', status: 'completed' } }, { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'The title is X.' } }, { type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 1 } }];

  {
    const { engine, gate } = make(ok);
    const out = await engine.run({ prompt: 'what is the title? RUN-1', sessionId: null, systemPrompt: 'SYSTEM TEXT', model: 'gpt-6-luna', signal: new AbortController().signal, emit, scope: { chatId: 'chat-1' } });
    const s = spawned[0];
    check('run: the reply is the agent messages in order, as separate paragraphs, streamed as text events', out.text === 'Looking.\n\nThe title is X.' && emitted.filter((e) => e.type === 'text').map((e) => e.text).join('') === 'Looking.The title is X.' && emitted.some((e) => e.type === 'text_block'), J({ out, ev: emitted.slice(0, 6) }));
    check('run: the thread id is returned for the next message; the model served is the picked one', out.sessionId === '0199aaaa-bbbb-cccc-dddd-eeeeffff0001' && out.model === 'gpt-6-luna' && !out.failed, J(out));
    check('run: usage is reported (input split from cached)', out.usage.inputTokens === 40 && out.usage.cacheReadTokens === 10 && out.usage.outputTokens === 5, J(out.usage));
    check('run: spawned with argv (no shell), cwd an empty lumen-cx-* folder, CODEX_HOME the chat\'s own', s.o.shell === false && /lumen-cx-/.test(s.o.cwd) && path.resolve(s.o.env.CODEX_HOME) === path.resolve(cx.chatHomeFor(userData, 'chat-1')) && s.argv.join(' ').includes('--sandbox read-only'), J({ cwd: s.o.cwd, env: s.o.env.CODEX_HOME }));
    check('run: the prompt (with Lumen\'s instructions on a first message) is written to stdin, not argv', /<lumen_instructions>\nSYSTEM TEXT\n<\/lumen_instructions>/.test(s.child.input()) && s.child.input().includes('RUN-1') && !s.argv.join(' ').includes('SYSTEM TEXT'), s.child.input().slice(0, 200));
    const tok = gate.opened[0];
    check('run: its own MCP token: opened for the run, delivered by environment variable, closed at the end, never in argv or config', gate.opened.length === 1 && s.o.env.LUMEN_MCP_TOKEN === `tok-${tok.tag.slice(0, 6)}` && !s.argv.join(' ').includes('tok-') && !fs.readFileSync(path.join(cx.chatHomeFor(userData, 'chat-1'), 'config.toml'), 'utf8').includes('tok-') && gate.closed.includes(tok.tag), J({ opened: gate.opened, closed: gate.closed }));
    check('run: the run\'s temp folder is removed afterwards', await (async () => { for (let i = 0; i < 40; i++) { if (!fs.readdirSync(tmp).some((n) => n.startsWith('lumen-cx-'))) return true; await new Promise((r) => setTimeout(r, 50)); } return false; })(), J(fs.readdirSync(tmp)));
    check('run: the sign-in file was copied into the chat\'s home and the engine remembers no workdirs', fs.readFileSync(path.join(cx.chatHomeFor(userData, 'chat-1'), 'auth.json'), 'utf8') === '{"fake":1}' && engine.workDirs.size === 0);
    check('run: engine.owns(tag) only while the run is live', !engine.owns(tok.tag) && engine.active === null);
  }

  {
    spawned.length = 0;
    const { engine } = make(ok);
    const out = await engine.run({ prompt: 'again', sessionId: '0199aaaa-bbbb-cccc-dddd-eeeeffff0001', systemPrompt: 'SYSTEM TEXT', model: 'default', signal: new AbortController().signal, emit, scope: { chatId: 'chat-1' } });
    const s = spawned[0];
    check('resume: `exec … resume <thread> -`, the first-message instructions replaced by a one-line reminder, no -m for the default model', s.argv.join(' ').includes('resume 0199aaaa-bbbb-cccc-dddd-eeeeffff0001 -') && !s.argv.includes('-m') && /<lumen_reminder>/.test(s.child.input()) && !/SYSTEM TEXT/.test(s.child.input()) && !out.failed, s.argv.join(' '));
  }

  {
    spawned.length = 0;
    const ac = new AbortController();
    const { engine, gate } = make([{ type: 'thread.started', thread_id: '0199aaaa-bbbb-cccc-dddd-eeeeffff0002' }, { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'Partial' } }], { close: false });
    const p = engine.run({ prompt: 'x', systemPrompt: 's', signal: ac.signal, emit, scope: { chatId: 'chat-2' } });
    for (let i = 0; i < 400 && !emitted.some((e) => e.type === 'text' && /Partial/.test(e.text)); i++) await new Promise((r) => setTimeout(r, 10)); // (the partial text is on screen)
    ac.abort();
    const out = await p;
    check('stop: aborting kills the process tree, closes the token, and returns the partial text with the thread (so Send now can resume it)', out.stopped === true && out.text === 'Partial' && out.sessionId === '0199aaaa-bbbb-cccc-dddd-eeeeffff0002' && killed.includes(spawned[0].child) && gate.closed.length >= 1, J({ out, killed: killed.length }));
  }

  {
    spawned.length = 0;
    const { engine } = make([{ type: 'thread.started', thread_id: 't' }, { type: 'item.started', item: { id: 'i9', type: 'command_execution', command: 'cat ~/.ssh/id_rsa' } }], { close: false });
    const ev = [];
    const out = await engine.run({ prompt: 'x', systemPrompt: 's', signal: new AbortController().signal, emit: (e) => ev.push(e), scope: { chatId: 'chat-3' } });
    check('backstop: a reported shell command ends the run with a plain error and drops the thread', out.failed && out.sessionId === null && ev.some((e) => e.type === 'error' && /isn't one of Lumen's browser tools \(a shell command\)/.test(e.text)) && killed.includes(spawned[0].child), J({ out, ev }));
  }

  {
    const { engine } = make([{ type: 'thread.started', thread_id: 't' }, { type: 'error', message: 'Reconnecting... 1/5' }, { type: 'turn.failed', error: { message: 'You\'ve hit your usage limit. Try again at 3:40 PM.' } }], { code: 1 });
    const ev = [];
    const out = await engine.run({ prompt: 'x', systemPrompt: 's', signal: new AbortController().signal, emit: (e) => ev.push(e), scope: { chatId: 'chat-4' } });
    check('limit: a usage-limit failure says so, carries the limit message (planLimit) for the Usage panel and fallback', out.failed && out.planLimit && /usage limit/.test(out.planLimit.text) && ev.some((e) => e.type === 'error' && /usage limit is reached/.test(e.text)) && !ev.some((e) => /Reconnecting/.test(e.text || '')), J({ out, ev }));
  }

  {
    const { engine } = make([{ type: 'turn.started' }], { code: 1, stderr: 'Error: no saved session found with ID 0199aaaa-bbbb-cccc-dddd-eeeeffff0003' });
    const out = await engine.run({ prompt: 'x', sessionId: '0199aaaa-bbbb-cccc-dddd-eeeeffff0003', systemPrompt: 's', quietExpired: true, signal: new AbortController().signal, emit, scope: { chatId: 'chat-5' } });
    check('expired: a thread Codex no longer has comes back { expired } with no error, for a quiet restart with the chat handed over', out.expired === true && out.sessionId === null, J(out));
  }

  {
    const gate = gateOf();
    const engine = new cx.CodexEngine({ userData, gate: async () => gate, locate: async () => ({ found: false }), userHome: () => userHome, tmp });
    const ev = [];
    const out = await engine.run({ prompt: 'x', systemPrompt: 's', signal: new AbortController().signal, emit: (e) => ev.push(e) });
    check('not installed: says how to install it, opens no connection', out.failed && ev.some((e) => e.type === 'error' && /Codex isn't installed/.test(e.text)) && gate.opened.length === 0, J(ev));
  }

  // ---------- the interrupted note rides on the next message ----------
  {
    const { Agent } = require('../src/ai/agent');
    check('agent: the Codex note names Lumen\'s server and tools, and the sandbox: no shell, file, patch or web search', (() => { const n = require('../src/ai/agent').codexNote('gpt-6-luna', new Date('2026-10-04T12:00:00')); return /server named lumen/.test(n) && /read_page\(/.test(n) && /no shell, file, patch or web search/.test(n) && /Today's date is 2026-10-04/.test(n) && /gpt-6-luna \(OpenAI\)/.test(n); })());
    check('agent: Codex replies are labelled "Codex" in handoff text', typeof Agent === 'function' && require('../src/ai/agent').systemFor({ model: 'codex:default' }).includes('running in OpenAI Codex'));
  }

  // ---------- Auto: Codex's own Auto ----------
  {
    const options = codexOptions({ signedIn: true, models: cx.FALLBACK_MODELS });
    const r = (prompt, extra = {}) => auto.route({ options, scope: 'codex', request: { prompt, ...extra } });
    check('auto: codex:auto is a provider Auto, named Codex', auto.isAuto('codex:auto') && auto.scopeOf('codex:auto') === 'codex' && auto.scopeName('codex') === 'Codex');
    const quick = r('hi');
    check('auto: a quick message routes to the fast model (Luna), a concrete id, never "auto"', quick.id === 'codex:gpt-6-luna' && !/auto$/.test(quick.id) && /^Auto \(Codex\): /.test(quick.reason), J(quick));
    const hard = r('Refactor the checkout flow across the codebase and debug why the cart total is wrong.\n1. Investigate\n2. Design a fix\n3. Write tests');
    check('auto: a hard message routes to the strongest (Astra)', hard.id === 'codex:gpt-6-astra', J(hard));
    check('auto: /think asks for the strongest, /fast for the quickest', r('x', { hint: 'think' }).id === 'codex:gpt-6-astra' && r('Refactor and debug the whole codebase carefully\n1. a\n2. b\n3. c', { hint: 'fast' }).id === 'codex:gpt-6-luna');
    const cool = { cooling: (id) => id === 'codex:gpt-6-luna' };
    check('auto: a model cooling down after a limit is skipped', auto.route({ options, scope: 'codex', request: { prompt: 'hi' }, cooldowns: cool }).id !== 'codex:gpt-6-luna');
    check('auto: the default row is used only when Codex lists no models', auto.route({ options: codexOptions({ signedIn: true, models: [] }), scope: 'codex', request: { prompt: 'hi' } }).id === 'codex:default' && !auto.candidatesOf(options, auto.needFor({ prompt: 'hi' }), { scope: 'codex' }).some((o) => o.id === 'codex:default'));
    const picker = auto.withProviderAutos(options, {});
    check('auto: the picker\'s Codex group starts with its own Auto when it has two or more models', picker[0].id === 'codex:auto' && picker[0].auto === true && picker[0].group === 'Your OpenAI account', J(picker[0]));
    const mixed = [{ id: 'openai:gpt-5.6', name: 'GPT-5.6', provider: 'OpenAI', group: 'OpenAI' }, ...options];
    const global = auto.route({ options: mixed, request: { prompt: 'hi' }, exclude: [] });
    check('auto: Codex models are candidates of the global Auto', auto.candidatesOf(mixed, auto.needFor({ prompt: 'hi' })).some((o) => o.id.startsWith('codex:')) && Boolean(global.id));
    check('auto: "Auto may use" turns Codex off for the global Auto, but its own Auto still uses it', !auto.candidatesOf(mixed, auto.needFor({ prompt: 'hi' }), { exclude: ['codex'] }).some((o) => o.id.startsWith('codex:')) && auto.candidatesOf(mixed, auto.needFor({ prompt: 'hi' }), { exclude: ['codex'], scope: 'codex' }).some((o) => o.id.startsWith('codex:')));
    const out = auto.routeOrFallBack({ options: mixed, request: { prompt: 'hi' }, scope: 'codex', cooldowns: { cooling: (id) => id.startsWith('codex:') } }, { fallbackOn: true, related: fallback.relatedOf('codex') });
    check('auto: out of Codex usage, the same vendor\'s other route (the OpenAI API) answers first, and it is said', out.id === 'openai:gpt-5.6' && out.outOfScope && /Codex is unavailable right now, so Auto uses /.test(out.reason), J(out));
    const none = auto.routeOrFallBack({ options, request: { prompt: 'hi' }, scope: 'codex', cooldowns: { cooling: () => true } }, { fallbackOn: false });
    check('auto: with the fallback setting off, no Codex model free fails plainly', !none.id && /no Codex model is available right now/.test(none.reason), J(none));
  }

  try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5 }); } catch { /* temp */ }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
