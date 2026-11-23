// Offline benchmark of the Antigravity (agy) engine: chat turns and pictures, with a fake agy. Never runs the real agy and never
// uses the user's Google account.
//
//   node scripts/measure/measure-agy.js            # 5 chat turns, 3 pictures
//   node scripts/measure/measure-agy.js --runs 9   # more runs (medians are reported)
//   node scripts/measure/measure-agy.js --json     # one JSON line, for comparing before and after
//
// Chat is measured twice: "cold", one `agy -p` process per message (the engine with no kept process), and "kept", the chat's own
// long-lived process (features/agy-warm.js, `--input-format stream-json`), which pays the cold start once and then takes each
// message on stdin. Each turn resumes the conversation the turn before returned, as a chat does.
//
// The fake agy (written to a temp folder) replays the timings of a real agy 1.5.1 run, read from its log (2026-11-05), at 1/20 scale:
//   cold start   6.6 s from spawn to the message being sent (sign-in, loadCodeAssist, experiments)  -> COLD_MS
//   picture      ~43 s from the message to the picture written in agy's own artifact folder
//                (<HOME>/.gemini/antigravity-cli/brain/<conversation>/picture_<n>.jpg, NOT the folder it was asked to save in) -> DRAW_MS
//   linger       ~60 s more before the process exits (its reply, subagent shutdown)                  -> LINGER_MS
// What it reports:
//   chat     time to spawn (Lumen's setup before agy starts), time to first token, total turn time
//   prompt   the first message's system prompt (chars, ~tokens) and the MCP tool list agy is served (chars, ~tokens)
//   image    time until Lumen has the picture (or gives up), and whether it got one
// Lumen-side overhead is what changes between builds; the fake's own delays are fixed, so before/after numbers compare.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn: nodeSpawn } = require('child_process');

const SCALE = 1 / 20;
const COLD_MS = Math.round(6600 * SCALE);
const FIRST_TOKEN_MS = 100; // the model's first words after the message is sent
const DRAW_MS = Math.round(43000 * SCALE);
const LINGER_MS = Math.round(60000 * SCALE);

const args = process.argv.slice(2);
const runs = Number(args[args.indexOf('--runs') + 1]) || 5;
const asJson = args.includes('--json');
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const tokens = (chars) => Math.round(chars / 4); // a rough count: ~4 characters per token

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-agy-bench-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });
const STAND_IN = path.join(tmp, process.platform === 'win32' ? 'agy.exe' : 'agy');
fs.writeFileSync(STAND_IN, '');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const FAKE = path.join(tmp, 'fake-agy.js');
fs.writeFileSync(FAKE, `
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
(async () => {
  await sleep(${COLD_MS});
  const given = argv.includes('--conversation') ? argv[argv.indexOf('--conversation') + 1] : null;
  const conv = given || 'c' + Date.now() + Math.random().toString(16).slice(2, 8);
  if (argv.includes('--input-format')) { // a kept process: one turn per {"event":"user"} line on stdin, until stdin closes
    let buf = '';
    let first = true;
    let queue = Promise.resolve();
    const turn = async (msg) => {
      const prompt = String(msg.message.content);
      if (first) { first = false; say({ event: 'init', conversation_id: conv, init: { model: 'gemini-3.8-flash-medium' } }); }
      await sleep(${FIRST_TOKEN_MS});
      for (const w of ['Hello', ' from', ' the', ' fake', ' agy.']) { say({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: w } }); await sleep(10); }
      say({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS', response: 'Hello from the fake agy.', usage: { input_tokens: Math.round(prompt.length / 4), output_tokens: 6 } } });
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg = null; try { msg = JSON.parse(line); } catch { /* not JSON */ }
        if (!msg || msg.event !== 'user' || !msg.message) { process.stderr.write('error: stream input message is missing the "event" field\\n'); process.exit(1); }
        queue = queue.then(() => turn(msg));
      }
    });
    process.stdin.on('end', () => queue.then(() => process.exit(0)));
    return;
  }
  const prompt = argv[argv.indexOf('-p') + 1] || '';
  const json = argv.includes('--output-format');
  if (argv.includes('--mode')) { // a picture run (ai/image-agy.js): agy saves into its own artifact folder, whatever the prompt says
    if (json) say({ event: 'init', conversation_id: conv, init: { model: 'gemini-3.8-flash-medium' } });
    if (json) say({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'invoke_subagent' } });
    await sleep(${DRAW_MS});
    const dir = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'brain', conv);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'picture_' + Date.now() + '.png');
    fs.writeFileSync(file, Buffer.from(${JSON.stringify(PNG.toString('base64'))}, 'base64'));
    const reply = 'The image has been generated: [picture](file:///' + file.split(path.sep).join('/') + ')';
    if (json) say({ event: 'step_update', step_update: { conversation_id: conv, step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: reply } });
    else console.log(reply);
    await sleep(${LINGER_MS});
    if (json) say({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS', response: reply } });
    return;
  }
  say({ event: 'init', conversation_id: conv, init: { model: 'gemini-3.8-flash-medium' } });
  await sleep(${FIRST_TOKEN_MS});
  for (const w of ['Hello', ' from', ' the', ' fake', ' agy.']) { say({ event: 'step_update', step_update: { conversation_id: conv, step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: w } }); await sleep(10); }
  say({ event: 'result', result: { conversation_id: conv, status: 'SUCCESS', response: 'Hello from the fake agy.', usage: { input_tokens: Math.round(prompt.length / 4), output_tokens: 6 } } });
})();
`);
process.env.LUMEN_AGY_BIN = STAND_IN;

const agent = require('../../src/ai/agent');
const ag = require('../../src/ai/antigravity');
const imageAgy = require('../../src/ai/image-agy');

function fakeSpawn(onSpawn) {
  return (bin, argv, opts) => { onSpawn?.(); return nodeSpawn(process.execPath, [FAKE, ...argv], { ...opts, shell: false }); };
}
const gate = { open: () => ({ mcpUrl: 'http://127.0.0.1:1/mcp', mcpToken: 't', hookUrl: 'http://127.0.0.1:1/hook' }), close: () => {} };

async function chatTurn(engine, settings, sessionId = null) {
  const t0 = performance.now();
  let spawnAt = null;
  let firstAt = null;
  engine.spawn = fakeSpawn(() => { spawnAt ??= performance.now(); });
  const emit = (e) => { if (e.type === 'text' && firstAt === null) firstAt = performance.now(); };
  const scope = { chatId: 'bench' };
  const model = 'gemini-3.8-flash-medium';
  engine.prepare({ scope, sessionId, model }).catch(() => {}); // as agent.js does while the page is read (and, kept, starts the chat's process)
  const out = await engine.run({ prompt: 'What is on this page?', sessionId, systemPrompt: agent.cliSystemPrompt(settings, 'antigravity'), model, signal: new AbortController().signal, emit, scope });
  const end = performance.now();
  return { spawn: spawnAt === null ? 0 : spawnAt - t0, firstToken: firstAt - t0, total: end - t0, ok: !out.failed, sessionId: out.sessionId || null };
}

async function picture(userData) {
  const t0 = performance.now();
  try {
    const made = await imageAgy.generate({ bin: STAND_IN, prompt: 'a cat', signal: new AbortController().signal, userData, spawn: fakeSpawn(), timeoutMs: 20000 });
    return { ms: performance.now() - t0, ok: Boolean(made?.images?.length) };
  } catch (err) {
    return { ms: performance.now() - t0, ok: false, why: String(err?.message || err).slice(0, 120) };
  }
}

(async () => {
  const userData = path.join(tmp, 'profile');
  fs.mkdirSync(userData, { recursive: true });
  const settings = { model: 'antigravity:gemini-3.8-flash-medium' };
  const chatRuns = async (engine) => {
    const out = [];
    let sessionId = null;
    for (let i = 0; i < runs; i++) { const r = await chatTurn(engine, settings, sessionId); sessionId = r.sessionId; out.push(r); }
    return out;
  };
  const chat = await chatRuns(new ag.AntigravityEngine({ userData, gate: async () => gate, watchdogMs: 0 }));
  const keptEngine = new ag.AntigravityEngine({ userData, gate: async () => gate, watchdogMs: 0 });
  keptEngine.keepWarm = require('../../src/features/agy-warm').createAgyWarm({ engine: keptEngine });
  const kept = await chatRuns(keptEngine);
  await keptEngine.keepWarm.dropChat('bench');
  const sum = (rs) => ({ runs, spawnMs: Math.round(median(rs.map((r) => r.spawn))), firstTokenMs: Math.round(median(rs.map((r) => r.firstToken))), firstTokenFirstMs: Math.round(rs[0].firstToken), firstTokenLaterMs: Math.round(median(rs.slice(1).map((r) => r.firstToken))), totalMs: Math.round(median(rs.map((r) => r.total))), ok: rs.every((r) => r.ok) });
  const pics = [];
  for (let i = 0; i < Math.max(1, Math.ceil(runs / 2)); i++) pics.push(await picture(userData));

  const system = agent.cliSystemPrompt(settings, 'antigravity');
  const toolsChars = JSON.stringify(agent.EXTERNAL_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }))).length;
  const result = {
    fake: { coldMs: COLD_MS, firstTokenMs: FIRST_TOKEN_MS, drawMs: DRAW_MS, lingerMs: LINGER_MS },
    chat: sum(chat),
    kept: { ...sum(kept), spawned: keptEngine.keepWarm.stats.spawned, reused: keptEngine.keepWarm.stats.reused },
    prompt: { systemChars: system.length, systemTokens: tokens(system.length), toolSchemaChars: toolsChars, toolSchemaTokens: tokens(toolsChars) },
    image: { runs: pics.length, ms: Math.round(median(pics.map((p) => p.ms))), made: pics.filter((p) => p.ok).length, why: pics.find((p) => !p.ok)?.why || null },
  };
  if (asJson) { console.log(JSON.stringify(result)); return; }
  console.log(`fake agy: cold start ${COLD_MS} ms, first token +${FIRST_TOKEN_MS} ms, picture +${DRAW_MS} ms, exits ${LINGER_MS} ms after the picture (1/20 of a real run)`);
  const line = (name, c) => console.log(`${name} first token ${c.firstTokenMs} ms (1st message ${c.firstTokenFirstMs} ms, later ${c.firstTokenLaterMs} ms) · turn ${c.totalMs} ms (median of ${runs})${c.ok ? '' : ' · SOME RUNS FAILED'}`);
  line('chat     cold:', result.chat);
  line('chat     kept:', result.kept);
  console.log(`         kept process: ${result.kept.spawned} spawned, ${result.kept.reused} messages reused it`);
  console.log(`prompt   system ${result.prompt.systemChars} chars (~${result.prompt.systemTokens} tokens) · MCP tool list ${result.prompt.toolSchemaChars} chars (~${result.prompt.toolSchemaTokens} tokens)`);
  console.log(`image    ${result.image.ms} ms · ${result.image.made}/${result.image.runs} pictures picked up${result.image.why ? ` · failed: ${result.image.why}` : ''}`);
})().catch((err) => { console.error(err); process.exit(1); });
