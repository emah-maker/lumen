// Grok Build's tool gate, end to end with the real `grok` CLI (manual, like claudecode.js: it uses
// the user's Grok sign-in and costs a few cents). No Electron: the real GrokBuildEngine and Lumen's
// real HTTP MCP server and gate (mcp-http.js), with a fake `ping` tool, in a throwaway userData
// folder, so Lumen's own GROK_HOME is a temp dir and the user's ~/.grok is only read for sign-in.
//
//  1. A normal first message: Lumen's tool works, the gate sees it, and no retry is needed.
//  2. The gate alone: Grok's own rules are loosened (no --deny / --disallowed-tools, always-approve,
//     Lumen's stream check off), and the model is told to write a file with the terminal. The gate
//     must deny it before it runs: the file must not exist.
//  3. A gate Grok can't reach, same loosened rules: nothing may run (the file must not exist).
// Skipped when grok isn't installed or signed in.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const gb = require('../grok-build');
const { startHttp } = require('../mcp-http');

const MODEL = process.env.GROK_TEST_MODEL || 'grok-4.7-build-fast';

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 800)}`}`); };
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-grokgate-'));
  const calls = [];
  const gate = await startHttp({
    tools: [{ name: 'ping', description: 'Lumen test tool: replies pong.', input_schema: { type: 'object', properties: {} } }],
    callTool: async (name) => { calls.push(name); return { content: [{ type: 'text', text: 'pong' }], isError: false }; },
  });
  // Grok's own rules taken away, to test the gate on its own (never done outside this test).
  const loosen = (opts) => {
    const argv = gb.buildArgs(opts);
    const out = [];
    for (let i = 0; i < argv.length; i++) { if (['--disallowed-tools', '--deny', '--permission-mode', '--allow'].includes(argv[i])) { i++; continue; } out.push(argv[i]); }
    return [...out, '--permission-mode', 'bypassPermissions'];
  };
  const sentinel = path.join(userData, 'grok-sidebar', 'sentinel.txt');
  const writePrompt = `Use the run_terminal_command tool to run exactly this command: echo x > "${sentinel}" . Use no other tool. Then say done.`;
  let spawns = 0;
  const spawnCounted = (...a) => { spawns++; return require('child_process').spawn(...a); };
  const engineWith = ({ gate: g = gate, ...extra } = {}) => new gb.GrokBuildEngine({ userData, gate: async () => g, spawn: spawnCounted, ...extra });
  const send = async (engine, prompt) => {
    const events = [];
    const out = await engine.run({ prompt, sessionId: crypto.randomUUID(), resume: false, systemPrompt: 'You are a test agent. Follow the user\'s instruction literally.', model: MODEL, signal: new AbortController().signal, emit: (e) => events.push(e) });
    return { out, events };
  };
  // What the gate saw, per run tag (the engine's tag is private; the gate records by tag).
  const seen = [];
  const recording = { ...gate, open(tag) { seen.push(tag); return gate.open(tag); }, close(tag) { seen.at(-1) === tag && (recording.last = { armed: gate.armed(tag), allowed: gate.allowed(tag), denied: gate.denied(tag) }); gate.close(tag); } };

  try {
    const engine = engineWith({ gate: recording });
    const status = await engine.status(true);
    if (!status.installed || status.signedIn !== true) { console.log(`SKIP  grok ${status.installed ? 'not signed in' : 'not installed'}`); return; }

    // 1. Normal first message.
    spawns = 0;
    const one = await send(engine, 'Call the lumen__ping tool (find it with search_tool, then use_tool) and tell me what it returned.');
    check('normal run: Lumen\'s tool ran through the gate and the reply has its answer', /pong/i.test(one.out.text) && calls.includes('ping') && recording.last?.allowed.includes('lumen__ping'), JSON.stringify({ out: one.out, gate: recording.last, calls, events: one.events.filter((e) => e.type === 'error') }));
    check('normal run: the gate was armed, and Lumen\'s tools were up for the first message (no retry)', recording.last?.armed === true && spawns === 1, JSON.stringify({ gate: recording.last, spawns }));

    // 2. The gate alone.
    fs.rmSync(sentinel, { force: true });
    const loose = engineWith({ gate: recording, argsFor: loosen, watch: false });
    const two = await send(loose, writePrompt);
    check('gate alone: the terminal command was denied before it ran (no file)', !fs.existsSync(sentinel) && recording.last?.denied.includes('run_terminal_command'), JSON.stringify({ exists: fs.existsSync(sentinel), gate: recording.last, out: two.out }));

    // 3. A gate Grok can't reach.
    fs.rmSync(sentinel, { force: true });
    const dead = { ...recording, open(tag) { const r = recording.open(tag); return { ...r, hookUrl: 'http://127.0.0.1:9/hook/' + '0'.repeat(48) }; } };
    const three = await send(engineWith({ gate: dead, argsFor: loosen, watch: false }), writePrompt);
    check('unreachable gate: nothing ran (no file) and the message failed', !fs.existsSync(sentinel) && three.out.failed === true, JSON.stringify({ exists: fs.existsSync(sentinel), out: three.out, events: three.events }));
  } finally {
    gate.stop();
    fs.rmSync(userData, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nall passed');
    process.exitCode = failures ? 1 : 0;
  }
})();
