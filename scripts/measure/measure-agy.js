// Offline benchmark of the Antigravity (agy) engine: chat turns and pictures, with a fake agy. Never runs the real agy and never
// uses the user's Google account.
//
//   node scripts/measure/measure-agy.js            # 5 chat turns, 3 pictures
//   node scripts/measure/measure-agy.js --runs 9   # more runs (medians are reported)
//   node scripts/measure/measure-agy.js --json     # one JSON line, for comparing before and after
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
  const conv = 'c' + Date.now() + Math.random().toString(16).slice(2, 8);
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

async function chatTurn(engine, settings) {
  const t0 = performance.now();
  let spawnAt = null;
  let firstAt = null;
  engine.spawn = fakeSpawn(() => { spawnAt ??= performance.now(); });
  const emit = (e) => { if (e.type === 'text' && firstAt === null) firstAt = performance.now(); };
  const out = await engine.run({ prompt: 'What is on this page?', systemPrompt: agent.cliSystemPrompt(settings, 'antigravity'), model: 'gemini-3.8-flash-medium', signal: new AbortController().signal, emit, scope: { chatId: 'bench' } });
  const end = performance.now();
  return { spawn: spawnAt - t0, firstToken: firstAt - t0, total: end - t0, ok: !out.failed };
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
  const engine = new ag.AntigravityEngine({ userData, gate: async () => gate, watchdogMs: 0 });
  const settings = { model: 'antigravity:gemini-3.8-flash-medium' };
  const chat = [];
  for (let i = 0; i < runs; i++) chat.push(await chatTurn(engine, settings));
  const pics = [];
  for (let i = 0; i < Math.max(1, Math.ceil(runs / 2)); i++) pics.push(await picture(userData));

  const system = agent.cliSystemPrompt(settings, 'antigravity');
  const toolsChars = JSON.stringify(agent.EXTERNAL_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }))).length;
  const result = {
    fake: { coldMs: COLD_MS, firstTokenMs: FIRST_TOKEN_MS, drawMs: DRAW_MS, lingerMs: LINGER_MS },
    chat: { runs, spawnMs: Math.round(median(chat.map((r) => r.spawn))), firstTokenMs: Math.round(median(chat.map((r) => r.firstToken))), totalMs: Math.round(median(chat.map((r) => r.total))), ok: chat.every((r) => r.ok) },
    prompt: { systemChars: system.length, systemTokens: tokens(system.length), toolSchemaChars: toolsChars, toolSchemaTokens: tokens(toolsChars) },
    image: { runs: pics.length, ms: Math.round(median(pics.map((p) => p.ms))), made: pics.filter((p) => p.ok).length, why: pics.find((p) => !p.ok)?.why || null },
  };
  if (asJson) { console.log(JSON.stringify(result)); return; }
  console.log(`fake agy: cold start ${COLD_MS} ms, first token +${FIRST_TOKEN_MS} ms, picture +${DRAW_MS} ms, exits ${LINGER_MS} ms after the picture (1/20 of a real run)`);
  console.log(`chat     spawn ${result.chat.spawnMs} ms · first token ${result.chat.firstTokenMs} ms · turn ${result.chat.totalMs} ms (median of ${runs})${result.chat.ok ? '' : ' · SOME RUNS FAILED'}`);
  console.log(`prompt   system ${result.prompt.systemChars} chars (~${result.prompt.systemTokens} tokens) · MCP tool list ${result.prompt.toolSchemaChars} chars (~${result.prompt.toolSchemaTokens} tokens)`);
  console.log(`image    ${result.image.ms} ms · ${result.image.made}/${result.image.runs} pictures picked up${result.image.why ? ` · failed: ${result.image.why}` : ''}`);
})().catch((err) => { console.error(err); process.exit(1); });
