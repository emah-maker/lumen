// [full access] Settings > AI > "Give Claude Code full access to this computer" (claudeCodeFullAccess):
// the sidebar's Claude Code engine runs the CLI as a terminal does. Plain Node, no Electron and no
// real CLI: a fake `claude` (a Node child speaking stream-json) records the argv and working folder,
// runs one silent built-in tool longer than the watchdog, and answers.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const cc = require('../src/ai/claude-code');
const { DEFAULTS } = require('../src/settings/settings-backend');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
// The fake CLI is a Node child; on a machine where Node takes ~0.7 s to start (antivirus scanning), a fixed 400 ms (start-up varies from 0.2 to 3 s there)
// watchdog ended it before it wrote anything. Scale the watchdog to the measured start-up time instead.
const startMs = (() => { const t = Date.now(); require('child_process').spawnSync(process.execPath, ['-e', '0'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }); return Date.now() - t; })();
const WATCHDOG = Math.max(1500, startMs * 4);
const after = (argv, flag) => argv[argv.indexOf(flag) + 1];

const FAKE = `
const fs = require('fs');
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type !== 'user') continue;
    fs.appendFileSync(process.env.FAKE_LOG + '.in', msg.message.content[0].text + '\\n---\\n');
    out({ type: 'system', subtype: 'init', session_id: 'sess-1', mcp_servers: [{ name: 'lumen', status: 'connected' }] });
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_A', name: 'Bash', input: { command: 'make', description: 'Build it' } }] } });
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_B', name: 'mcp__lumen__read_page', input: {} }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_B', content: 'page' }] } });
    // A built-in tool that prints nothing for longer than the watchdog (a long build).
    setTimeout(() => {
      out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: 'built' }] } });
      out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 'sess-1', total_cost_usd: 0, usage: {} });
    }, Number(process.env.FAKE_SILENCE_MS));
  }
});
`;

(async () => {
  check('setting: off by default', DEFAULTS.claudeCodeFullAccess === false, DEFAULTS.claudeCodeFullAccess);

  check('slash command: a leading command goes in as typed', cc.slashCommand('  /goal ship the release ') === '/goal ship the release' && cc.slashCommand('/context') === '/context' && cc.slashCommand('/plugin:skill x') === '/plugin:skill x', cc.slashCommand('/context'));
  check('slash command: anything else is not one', cc.slashCommand('what is /etc/hosts') === null && cc.slashCommand('/') === null && cc.slashCommand('/ hi') === null && cc.slashCommand('//x') === null && cc.slashCommand(undefined) === null, 'matched');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ccfull-'));
  const fake = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(fake, FAKE);
  process.env.LUMEN_CLAUDE_BIN = fake; // findClaude: this file stands in for the CLI
  const runOnce = async ({ fullAccess, silenceMs = 50, watchdogMs = WATCHDOG }) => {
    const log = path.join(dir, `log-${fullAccess ? 'full' : 'base'}-${silenceMs}.json`);
    const fakeSpawn = (bin, argv, opts) => spawn(process.execPath, [bin, ...argv], { ...opts, env: { ...opts.env, ELECTRON_RUN_AS_NODE: '1', FAKE_LOG: log, FAKE_SILENCE_MS: String(silenceMs) } }); // (run as Node under Electron's node, as CI's may be)
    const engine = new cc.ClaudeCodeEngine({ userData: dir, mcpCommand: () => ({ command: process.execPath, args: ['-e', ''], env: {} }), ensureServer: () => {}, keepAlive: false, watchdogMs, spawn: fakeSpawn });
    const events = [];
    const out = await engine.run({ prompt: 'state\n\nhello', sessionId: '00000000-0000-4000-8000-000000000001', resume: false, systemPrompt: 'LUMEN', fullAccess, signal: new AbortController().signal, emit: (e) => events.push(e) });
    engine.dispose?.();
    return { out, events, rec: JSON.parse(fs.readFileSync(log, 'utf8')) };
  };

  const full = await runOnce({ fullAccess: true, silenceMs: WATCHDOG * 3, watchdogMs: WATCHDOG });
  const { argv, cwd } = full.rec;
  check('full access: bypassPermissions, no tool lockdown, Lumen prompt appended', after(argv, '--permission-mode') === 'bypassPermissions' && !argv.includes('--tools') && !argv.includes('--allowedTools') && !argv.includes('--strict-mcp-config') && after(argv, '--append-system-prompt') === 'LUMEN', argv.join(' '));
  check('full access: runs in the home folder, as in a terminal', fs.realpathSync(cwd) === fs.realpathSync(os.homedir()), cwd);
  check('full access: Lumen\'s MCP server is still given', argv.includes('--mcp-config'), argv.join(' '));
  check('full access: a silent built-in tool longer than the watchdog is not treated as hung', full.out.text === 'Done.' && !full.events.some((e) => e.type === 'error'), JSON.stringify(full.events.filter((e) => e.type === 'error')));
  const rows = full.events.filter((e) => e.type === 'tool');
  const dones = full.events.filter((e) => e.type === 'tool_done');
  check('full access: the built-in tool gets a step row, labelled', rows.length === 1 && rows[0].name === 'Bash' && rows[0].label === 'Build it', JSON.stringify(rows));
  check('full access: its row ends when its result comes', dones.length === 1 && dones[0].ok === true && dones[0].id === rows[0].id, JSON.stringify(dones));
  check('full access: Lumen\'s own tools get no extra row from the stream (the MCP side shows them)', !rows.some((r) => /lumen/.test(r.name)), JSON.stringify(rows));

  const base = await runOnce({ fullAccess: false });
  check('off: the lockdown flags and an empty working folder', after(base.rec.argv, '--tools') === '' && after(base.rec.argv, '--permission-mode') === 'dontAsk' && base.rec.argv.includes('--strict-mcp-config') && after(base.rec.argv, '--system-prompt') === 'LUMEN' && fs.realpathSync(base.rec.cwd) !== fs.realpathSync(os.homedir()), base.rec.argv.join(' '));

  const hung = await runOnce({ fullAccess: false, silenceMs: WATCHDOG * 3, watchdogMs: WATCHDOG }).catch((e) => ({ err: e }));
  check('off: the watchdog still ends a CLI that goes quiet', hung.err || hung.out?.failed || hung.events?.some((e) => e.type === 'error') || hung.out?.text !== 'Done.', JSON.stringify(hung.out));

  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
