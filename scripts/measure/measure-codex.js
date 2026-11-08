// Offline benchmark of the Codex engine: a chat's messages with a fake `codex` (headless `codex exec --json` and the kept
// `codex app-server` of features/codex-warm.js), and the size of what Codex is given. Never runs the real codex and never
// uses the user's OpenAI account.
//
//   node scripts/measure/measure-codex.js            # 5 messages each way (medians are reported)
//   node scripts/measure/measure-codex.js --runs 9
//   node scripts/measure/measure-codex.js --json     # one JSON line, for comparing before and after
//
// The fake pays STARTUP_MS before a new process can answer (as test/units/codex-warm-units.js does) and EXIT_MS for a headless
// run to flush and exit after its last event. What it reports:
//   headless   time to spawn (Lumen's setup before codex starts), time to first token, total turn time
//   kept       the same through the kept process: the chat's first message (process start included) and a later one
//   prompt     the first message's system prompt (chars, ~tokens), the MCP tool list Codex is served, and what Codex adds to every
//              turn from Lumen's config.toml: its bundled skills (each one listed in a developer message on every turn; 5 listed
//              cost ~2,000 characters in a real Lumen session, 2026-11-05) unless config.toml turns them off.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');

const STARTUP_MS = 300;
const EXIT_MS = 200;
const BUNDLED_SKILLS = ['imagegen', 'openai-docs', 'review-agent', 'skill-creator', 'skill-installer']; // codex-cli 0.160.0 (skills/list)
const SKILLS_BLOCK_CHARS = 2002; // the <skills_instructions> developer message those skills cost, from a real session's rollout

const args = process.argv.slice(2);
const runs = Number(args[args.indexOf('--runs') + 1]) || 5;
const asJson = args.includes('--json');
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const tokens = (chars) => Math.round(chars / 4);

const cx = require('../../src/ai/codex');
const warmLib = require('../../src/features/codex-warm');
const agent = require('../../src/ai/agent');

// ---- the fake codex: headless JSONL, or app-server JSON-RPC (initialize, thread/start|resume, turn/start)
function fakeSpawn() {
  return (bin, argv) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.pid = 4242;
    const out = (o) => { if (child.exitCode === null) child.stdout.write(`${JSON.stringify(o)}\n`); };
    const exit = (code = 0) => { if (child.exitCode !== null) return; child.exitCode = code; setImmediate(() => child.emit('close', code)); };
    child.kill = () => exit(1);
    if (argv[0] !== 'app-server') {
      const thread = argv.includes('resume') ? argv[argv.indexOf('resume') + 1] : `thread-${Date.now()}-0001`;
      child.stdin = new Writable({ write(_c, _e, cb) { cb(); }, final(cb) { setTimeout(() => { out({ type: 'thread.started', thread_id: thread }); out({ type: 'turn.started' }); out({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'Hello from the fake codex.' } }); out({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 6 } }); setTimeout(() => exit(0), EXIT_MS); }, STARTUP_MS); cb(); } });
      return child;
    }
    let buf = '';
    let ready = false;
    const queue = [];
    let turns = 0;
    setTimeout(() => { ready = true; for (const m of queue.splice(0)) handle(m); }, STARTUP_MS);
    const reply = (id, result) => out({ id, result });
    const note = (method, params) => out({ method, params });
    function handle(m) {
      const p = m.params || {};
      if (m.method === 'initialize') return reply(m.id, { userAgent: 'fake/0.160.0' });
      if (m.method === 'thread/start' || m.method === 'thread/resume') {
        const id = p.threadId || `thread-${Date.now()}-0002`;
        reply(m.id, { thread: { id } });
        setTimeout(() => note('mcpServer/startupStatus/updated', { threadId: id, name: 'lumen', status: 'ready', error: null }), 5);
        return undefined;
      }
      if (m.method === 'turn/start') {
        const id = `turn-${++turns}`;
        const tid = p.threadId;
        reply(m.id, { turn: { id, items: [], status: 'inProgress' } });
        setImmediate(() => {
          note('turn/started', { threadId: tid, turn: { id, status: 'inProgress' } });
          for (const w of ['Hello', ' from', ' the', ' fake', ' codex.']) note('item/agentMessage/delta', { threadId: tid, turnId: id, itemId: 'm', delta: w });
          note('item/completed', { threadId: tid, turnId: id, item: { type: 'agentMessage', id: 'm', text: 'Hello from the fake codex.', phase: 'final_answer' } });
          note('turn/completed', { threadId: tid, turn: { id, status: 'completed', error: null } });
        });
        return undefined;
      }
      if (m.id !== undefined && m.method) out({ id: m.id, error: { code: -32601, message: 'Method not found' } });
      return undefined;
    }
    child.stdin = new Writable({
      write(chunk, _e, cb) { buf += chunk; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id === undefined && !m.method) continue; if (ready) handle(m); else queue.push(m); } cb(); },
      final(cb) { setTimeout(() => exit(0), 5); cb(); },
    });
    return child;
  };
}
const mkGate = () => ({ open: (tag) => ({ mcpUrl: 'http://127.0.0.1:1/mcp', mcpToken: `m-${tag}` }), close() {}, bindChat() {}, listed: () => true });
const spec = { found: true, command: process.execPath, args: [], path: process.execPath, kind: 'exe', version: '9.9.9' };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cx-bench-'));
  const userHome = path.join(tmp, 'user');
  fs.mkdirSync(userHome);
  fs.mkdirSync(path.join(tmp, 'tmp'));
  fs.writeFileSync(path.join(userHome, 'auth.json'), 'tok');
  const settings = { model: 'codex:gpt-6.1-sol' };
  const systemPrompt = agent.cliSystemPrompt(settings, 'codex');
  let chats = 0;
  const engineFor = (warm) => {
    const engine = new cx.CodexEngine({ userData: path.join(tmp, `ud${++chats}`), gate: async () => mkGate(), locate: async () => spec, userHome: () => userHome, tmp: path.join(tmp, 'tmp'), spawn: null, kill: (c) => c.kill(), exec: () => {}, watchdogMs: 0 });
    if (warm) engine.keepWarm = warmLib.createCodexWarm({ engine, enabled: () => true, idleMs: () => 60000, readyWaitMs: 300, quitGraceMs: 50 });
    return engine;
  };
  const send = async (engine, { sessionId = null, chatId }) => {
    const t0 = performance.now();
    let spawnAt = null;
    let first = null;
    const spawn = fakeSpawn();
    engine.spawn = (...a) => { spawnAt ??= performance.now(); return spawn(...a); };
    const out = await engine.run({ prompt: 'What is on this page?', systemPrompt, model: 'gpt-6.1-sol', sessionId, signal: new AbortController().signal, scope: { chatId }, emit: (e) => { if (e.type === 'text' && first === null) first = performance.now(); } });
    const end = performance.now();
    return { spawn: spawnAt === null ? 0 : spawnAt - t0, firstToken: first - t0, total: end - t0, ok: !out.failed, sessionId: out.sessionId };
  };

  const headless = [];
  for (let i = 0; i < runs; i++) headless.push(await send(engineFor(false), { chatId: `h${i}` }));
  const keptFirst = [];
  const keptLater = [];
  const pools = [];
  for (let i = 0; i < runs; i++) {
    const engine = engineFor(true);
    pools.push(engine.keepWarm);
    const one = await send(engine, { chatId: `k${i}` });
    keptFirst.push(one);
    keptLater.push(await send(engine, { chatId: `k${i}`, sessionId: one.sessionId }));
  }
  for (const p of pools) { try { await p.disposeAll?.(); } catch { /* bench */ } }

  const config = cx.configFor({ run: { mcpUrl: 'http://127.0.0.1:1/mcp' } });
  const skillsOff = BUNDLED_SKILLS.filter((n) => new RegExp(`\\[\\[skills\\.config\\]\\]\\s*\\nname = "${n}"\\s*\\nenabled = false`).test(config));
  const skillsChars = Math.round(SKILLS_BLOCK_CHARS * (BUNDLED_SKILLS.length - skillsOff.length) / BUNDLED_SKILLS.length);
  const toolsChars = JSON.stringify(agent.EXTERNAL_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }))).length;
  const sum = (xs, k) => Math.round(median(xs.map((r) => r[k])));
  const result = {
    fake: { startupMs: STARTUP_MS, exitMs: EXIT_MS },
    headless: { spawnMs: sum(headless, 'spawn'), firstTokenMs: sum(headless, 'firstToken'), totalMs: sum(headless, 'total'), ok: headless.every((r) => r.ok) },
    keptFirst: { firstTokenMs: sum(keptFirst, 'firstToken'), totalMs: sum(keptFirst, 'total'), ok: keptFirst.every((r) => r.ok) },
    keptLater: { firstTokenMs: sum(keptLater, 'firstToken'), totalMs: sum(keptLater, 'total'), ok: keptLater.every((r) => r.ok) },
    prompt: { systemChars: systemPrompt.length, systemTokens: tokens(systemPrompt.length), toolSchemaChars: toolsChars, bundledSkillsListed: BUNDLED_SKILLS.length - skillsOff.length, skillsBlockChars: skillsChars, perTurnCodexChars: skillsChars },
  };
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ }
  if (asJson) { console.log(JSON.stringify(result)); process.exit(0); }
  console.log(`fake codex: ${STARTUP_MS} ms to start, ${EXIT_MS} ms to exit after a headless turn`);
  console.log(`headless     spawn ${result.headless.spawnMs} ms · first token ${result.headless.firstTokenMs} ms · turn ${result.headless.totalMs} ms${result.headless.ok ? '' : ' · FAILED'}`);
  console.log(`kept, 1st    first token ${result.keptFirst.firstTokenMs} ms · turn ${result.keptFirst.totalMs} ms (process start included)${result.keptFirst.ok ? '' : ' · FAILED'}`);
  console.log(`kept, later  first token ${result.keptLater.firstTokenMs} ms · turn ${result.keptLater.totalMs} ms${result.keptLater.ok ? '' : ' · FAILED'}`);
  console.log(`prompt       system ${result.prompt.systemChars} chars (~${result.prompt.systemTokens} tokens) · MCP tool list ${toolsChars} chars · Codex's bundled skills listed every turn: ${result.prompt.bundledSkillsListed} (~${skillsChars} chars)`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
