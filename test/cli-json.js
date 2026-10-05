// One-shot JSON answers from the user's own CLIs (cli-json.js), for "Organize Tabs with AI" without
// an API key: the argv gives no tools and no MCP servers, answers are parsed and shape-checked, and
// real child processes (a fake CLI run by Node) are fed stdin, timed out and stopped. Plain Node, no
// Electron, and nothing touches the user's own ~/.claude or ~/.grok.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const cj = require('../src/ai/cli-json');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const after = (argv, flag) => argv[argv.indexOf(flag) + 1];
const SCHEMA = { type: 'object', properties: { groups: { type: 'array' } }, required: ['groups'] };

(async () => {
  // ---- Claude Code argv
  const cc = cj.claudeArgs({ system: 'S', schema: SCHEMA, model: 'haiku' });
  check('claude: one-shot print mode with a single JSON result', cc[0] === '-p' && after(cc, '--output-format') === 'json', cc.join(' '));
  check('claude: no built-in tools', cc.includes('--tools') && after(cc, '--tools') === '', cc.join(' '));
  check('claude: no MCP servers at all (strict config, none given)', cc.includes('--strict-mcp-config') && !cc.includes('--mcp-config') && !cc.includes('--allowedTools'), cc.join(' '));
  check('claude: nothing saved, no prompts, no slash commands', cc.includes('--no-session-persistence') && after(cc, '--permission-mode') === 'dontAsk' && cc.includes('--disable-slash-commands'), cc.join(' '));
  check('claude: the schema is passed as JSON, the system prompt replaced', JSON.parse(after(cc, '--json-schema')).required[0] === 'groups' && after(cc, '--system-prompt') === 'S', cc.join(' '));
  check('claude: --model haiku', after(cc, '--model') === 'haiku', cc.join(' '));
  check('claude: default and flag-like models pass no --model', !cj.claudeArgs({ system: 'S', schema: SCHEMA, model: 'default' }).includes('--model') && !cj.claudeArgs({ system: 'S', schema: SCHEMA, model: '--evil' }).includes('--model'), 'model');

  // ---- Grok Build argv and config
  const gr = cj.grokArgs({ system: 'S', schema: SCHEMA, model: 'grok-4.7', promptFile: 'p.json', cwd: 'dir' });
  const denied = gr.flatMap((v, i) => (v === '--deny' ? [gr[i + 1]] : []));
  check('grok: every built-in the sidebar engine removes is removed here too', /run_terminal_command/.test(after(gr, '--disallowed-tools')) && /write/.test(after(gr, '--disallowed-tools')), after(gr, '--disallowed-tools'));
  check('grok: the terminal and subagents are denied outright', denied.includes('run_terminal_command') && denied.includes('spawn_subagent'), denied.join(','));
  check('grok: no tool is allowed (not even Lumen’s)', !gr.includes('--allow') && !gr.includes('use_tool') && after(gr, '--permission-mode') === 'dontAsk', gr.join(' '));
  check('grok: no web search, subagents or plan mode; prompt from a file', gr.includes('--disable-web-search') && gr.includes('--no-subagents') && gr.includes('--no-plan') && after(gr, '--prompt-file') === 'p.json' && after(gr, '--cwd') === 'dir', gr.join(' '));
  check('grok: schema and model passed', JSON.parse(after(gr, '--json-schema')).required[0] === 'groups' && after(gr, '--model') === 'grok-4.7', gr.join(' '));
  check('grok: its config names no MCP servers', !/mcp_servers/.test(cj.grokConfig()) && /mcps = false/.test(cj.grokConfig()), cj.grokConfig());

  // ---- answers
  const groups = { groups: [{ name: 'A', tab_ids: [1, 2] }] };
  check('parse: Claude Code structured_output', cj.parseResult(JSON.stringify({ is_error: false, result: 'ignored', structured_output: groups })).groups[0].name === 'A', 'cc');
  check('parse: Grok Build structuredOutput', cj.parseResult(JSON.stringify({ text: 'x', structuredOutput: groups })).groups.length === 1, 'grok');
  check('parse: JSON in the reply text, fenced or not', cj.parseResult(JSON.stringify({ result: '```json\n{"groups":[]}\n```' })).groups.length === 0 && cj.parseResult(JSON.stringify({ text: '{"groups":[]}' })).groups.length === 0, 'text');
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  check('parse: not JSON, an error result, or prose is refused', throws(() => cj.parseResult('Sure! Here you go')) && throws(() => cj.parseResult(JSON.stringify({ is_error: true, result: 'Not logged in' }))) && throws(() => cj.parseResult(JSON.stringify({ result: 'I grouped them.' }))), 'refused');
  check('groups: the expected shape passes', cj.checkGroups(groups).length === 1, 'shape');
  check('groups: wrong shapes are refused', throws(() => cj.checkGroups({})) && throws(() => cj.checkGroups({ groups: [{ name: 1, tab_ids: [1] }] })) && throws(() => cj.checkGroups({ groups: [{ name: 'A', tab_ids: ['1'] }] })), 'shape');

  // ---- real processes: a fake CLI run by Node (process.execPath)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-clijson-'));
  const fake = path.join(dir, 'fake-cli.js');
  fs.writeFileSync(fake, `
const mode = process.argv[2];
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (mode === 'echo') process.stdout.write(JSON.stringify({ is_error: false, structured_output: { groups: [{ name: input, tab_ids: [1, 2] }] } }));
  if (mode === 'fail') { process.stderr.write('Not logged in · Please run /login'); process.exit(1); }
});
if (mode === 'hang') setInterval(() => {}, 1000);
`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const echoed = cj.parseResult(await cj.runCli({ bin: process.execPath, argv: [fake, 'echo'], input: 'Tabs: [1,2]', env, cwd: dir }));
  check('run: the prompt reaches the CLI on stdin and its JSON comes back', echoed.groups[0].name === 'Tabs: [1,2]', JSON.stringify(echoed));
  const failed = await cj.runCli({ bin: process.execPath, argv: [fake, 'fail'], input: '', env, cwd: dir }).then(() => null, (e) => e);
  check('run: a failed CLI rejects with its output', failed && failed.code === 1 && /Not logged in/.test(failed.output), failed && failed.message);
  const t0 = Date.now();
  const hung = await cj.runCli({ bin: process.execPath, argv: [fake, 'hang'], input: '', env, cwd: dir, timeoutMs: 1500 }).then(() => null, (e) => e);
  check('run: a CLI that never answers is stopped at the timeout', hung && hung.timedOut && Date.now() - t0 < 8000, hung && hung.message);
  // ---- cancel: an aborted run kills the process, and the next run waits for it
  {
    const { spawn: nodeSpawn } = require('child_process');
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    let child = null;
    let spawned = 0;
    const spy = (...a) => { spawned++; child = nodeSpawn(...a); return child; };
    const ac = new AbortController();
    const started = Date.now();
    const p = cj.runCli({ bin: process.execPath, argv: [fake, 'hang'], input: '', env, cwd: dir, timeoutMs: 20000, signal: ac.signal, spawn: spy }).then(() => null, (e) => e);
    await new Promise((r) => setTimeout(r, 400));
    let idle = false;
    cj.whenIdle().then(() => { idle = true; });
    await new Promise((r) => setTimeout(r, 100));
    check('abort: a second run waits (whenIdle) while the first process still runs', idle === false && child && alive(child.pid), String(idle));
    ac.abort();
    const err = await p;
    check('abort: the run rejects as aborted well before the timeout', err && err.aborted === true && Date.now() - started < 8000, err && err.message);
    check('abort: the process is gone, not left running', child && !alive(child.pid), String(child && child.pid));
    await new Promise((r) => setTimeout(r, 50));
    check('abort: whenIdle resolves once the process has exited', idle === true, String(idle));
    const before = spawned;
    const pre = await cj.runCli({ bin: process.execPath, argv: [fake, 'hang'], input: '', env, cwd: dir, signal: ac.signal, spawn: spy }).then(() => null, (e) => e);
    check('abort: an already-aborted signal never starts a process', pre && pre.aborted === true && spawned === before, String(spawned - before));
  }

  // ---- completeJSON, with the process step faked
  const runs = [];
  const fakeRun = (reply) => async (opts) => { runs.push({ ...opts, dirExisted: fs.existsSync(opts.cwd), files: fs.readdirSync(opts.cwd) }); if (reply instanceof Error) throw reply; return JSON.stringify(reply); };
  process.env.ELECTRON_RUN_AS_NODE = '1';
  const a = await cj.completeJSON({ engine: 'claudecode', bin: 'claude.exe', model: 'haiku', system: 'S', user: 'Tabs:\n[]', schema: SCHEMA, userData: dir, run: fakeRun({ structured_output: groups }) });
  delete process.env.ELECTRON_RUN_AS_NODE;
  const r1 = runs.at(-1);
  check('claude run: answer returned; prompt on stdin, not in argv', a.groups[0].name === 'A' && r1.input === 'Tabs:\n[]' && !r1.argv.includes('Tabs:\n[]'), JSON.stringify(r1.argv));
  check('claude run: an empty working folder, removed afterwards; no RunAsNode leak', r1.dirExisted && r1.files.length === 0 && !fs.existsSync(r1.cwd) && !('ELECTRON_RUN_AS_NODE' in r1.env), JSON.stringify(r1.files));
  const signedOut = await cj.completeJSON({ engine: 'claudecode', bin: 'claude.exe', system: 'S', user: 'x', schema: SCHEMA, userData: dir, run: fakeRun(Object.assign(new Error('exit 1'), { code: 1, output: 'Not logged in · Please run /login' })) }).then(() => null, (e) => e);
  check('claude run: signed out reads as a sign-in hint', signedOut && /not signed in/i.test(signedOut.message), signedOut && signedOut.message);

  const savedGrokHome = process.env.GROK_HOME;
  process.env.GROK_HOME = path.join(dir, 'user-grok'); // stands in for ~/.grok
  fs.mkdirSync(process.env.GROK_HOME);
  fs.writeFileSync(path.join(process.env.GROK_HOME, 'auth.json'), '{"t":1}');
  process.env.XAI_API_KEY = 'xai-sign-in'; // Grok's own sign-in for API-key users: kept
  process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
  const g = await cj.completeJSON({ engine: 'grokbuild', bin: 'grok.exe', model: 'default', system: 'S', user: 'Tabs:\n[]', schema: SCHEMA, userData: dir, run: fakeRun({ text: '', structuredOutput: groups }) });
  delete process.env.XAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const r2 = runs.at(-1);
  const home = path.join(dir, 'grok-oneshot');
  check('grok run: answer returned', g.groups[0].name === 'A', JSON.stringify(g));
  check('grok run: its own GROK_HOME, with the sign-in linked and no MCP servers in config', r2.env.GROK_HOME === home && fs.existsSync(path.join(home, 'auth.json')) && !/mcp_servers/.test(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')), r2.env.GROK_HOME);
  check('grok run: other API keys stay out of its environment; only XAI_API_KEY is kept', r2.env.XAI_API_KEY === 'xai-sign-in' && !Object.keys(r2.env).some((k) => k !== 'XAI_API_KEY' && /API_KEY|TOKEN|SECRET/i.test(k)), Object.keys(r2.env).join(','));
  check('grok run: the prompt went in a file that is gone afterwards', r2.files.some((f) => /^prompt-/.test(f)) && !fs.readdirSync(r2.cwd).some((f) => /^prompt-/.test(f)) && !r2.argv.includes('Tabs:\n[]'), JSON.stringify(r2.files));
  check('grok run: the user’s own auth.json is untouched', fs.readFileSync(path.join(process.env.GROK_HOME, 'auth.json'), 'utf8') === '{"t":1}', 'auth');
  if (savedGrokHome === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = savedGrokHome;

  const unknown = await cj.completeJSON({ engine: 'other', bin: 'x', system: 'S', user: 'x', schema: SCHEMA, userData: dir }).then(() => null, (e) => e);
  check('an unknown engine is refused', unknown && /No one-shot runner/.test(unknown.message), unknown && unknown.message);

  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.log(`FAIL  cli-json: ${err.stack}`); process.exit(1); });
