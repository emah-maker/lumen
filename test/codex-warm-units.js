// "Keep Codex connected" (features/codex-warm.js), plain Node with a fake `codex`: no Electron, no network, no real CLI.
// The fake speaks both of codex's modes: headless (`codex exec --json ... -`, one process per message, JSONL events) and
// `codex app-server` (JSON-RPC over stdio: initialize, thread/start, thread/resume, turn/start, turn/interrupt, streamed
// item notifications). Each mode pays a simulated start cost (STARTUP_MS), so time-to-first-token with and without the
// kept process can be compared.
// Covers: the setting (on by default), one process per chat kept between messages and never shared, pre-warm before the
// first message, streamed deltas, Stop / Send now interrupting the turn and keeping the process (and a process that ignores
// the interrupt being killed), Lumen's checks (config.toml, environment, approval answers, items that aren't Lumen's tools,
// the watchdog), the fallbacks to a headless run (no app-server, a thread Codex doesn't know, MCP not connected), a changed
// sign-in, idle timeout, the process cap, dropChat / disposeAll, images, usage.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await sleep(5); return fn(); };
const J = (v) => JSON.stringify(v);

const cx = require('../src/ai/codex');
const warmLib = require('../src/features/codex-warm');

const STARTUP_MS = 300; // what a new codex process costs before it can answer (simulated; real: see the commit message)
const EXIT_MS = 200; // a headless codex's flush and exit after its last event (simulated)

// ---- the fake codex
function fakeCodex() {
  const spawned = [];
  const threads = new Set(['thread-known-0001']);
  let newIds = 0;
  const script = { turn: null, ignoreInterrupt: false, mcp: 'ready', appServer: true, resumeError: null, request: null };
  const spawn = (bin, argv, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.pid = 9000 + spawned.length;
    const app = argv[0] === 'app-server';
    const rec = { argv, opts, child, app, requests: [], notes: [], answers: [], killed: false, ended: false, prompts: [], inputs: [], born: Date.now(), stdin: [] };
    spawned.push(rec);
    const out = (obj) => { if (child.exitCode === null) child.stdout.write(`${JSON.stringify(obj)}\n`); };
    rec.exit = (code = 0) => { if (child.exitCode !== null) return; child.exitCode = code; setImmediate(() => child.emit('close', code)); };
    child.kill = () => { rec.killed = true; rec.exit(1); };
    if (!app) {
      // headless: one message on stdin, then exit
      rec.thread = argv.includes('resume') ? argv[argv.indexOf('resume') + 1] : 'thread-cold-0001';
      child.stdin = new Writable({ write(c, _e, cb) { rec.stdin.push(String(c)); cb(); }, final(cb) { rec.prompts.push(rec.stdin.join('')); setTimeout(() => { out({ type: 'thread.started', thread_id: rec.thread }); out({ type: 'turn.started' }); out({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'cold reply' } }); out({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } }); setTimeout(() => rec.exit(0), EXIT_MS); }, STARTUP_MS); cb(); } });
      return child;
    }
    if (!script.appServer) { child.stdin = new Writable({ write(_c, _e, cb) { cb(); } }); setImmediate(() => { child.stderr.write('error: unrecognized subcommand app-server'); rec.exit(2); }); return child; }
    let buf = '';
    let ready = false;
    const queue = [];
    setTimeout(() => { ready = true; for (const m of queue.splice(0)) handle(m); }, STARTUP_MS);
    const reply = (id, result) => out({ id, result });
    const fail = (id, message) => out({ id, error: { code: -32603, message } });
    const note = (method, params) => out({ method, params });
    let nextAsk = 1000;
    const asks = new Map();
    rec.ask = (method, params) => new Promise((resolve) => { const id = ++nextAsk; asks.set(id, resolve); out({ id, method, params }); });
    rec.note = note;
    rec.turn = null; // { id, threadId, interrupted }
    let turns = 0;
    function handle(m) {
      if (m.id !== undefined && m.method === undefined) { const done = asks.get(m.id); if (done) { asks.delete(m.id); rec.answers.push(m); done(m); } return; }
      rec.requests.push(m);
      const p = m.params || {};
      switch (m.method) {
        case 'initialize': rec.initParams = p; return reply(m.id, { userAgent: 'fake/0.160.0', codexHome: opts.env.CODEX_HOME });
        case 'initialized': return undefined;
        case 'thread/start': {
          const id = `thread-new-${String(++newIds).padStart(4, '0')}`;
          threads.add(id);
          rec.thread = id;
          rec.startParams = p;
          reply(m.id, { thread: { id } });
          if (script.mcp !== 'silent') setTimeout(() => note('mcpServer/startupStatus/updated', { threadId: id, name: 'lumen', status: script.mcp, error: script.mcp === 'failed' ? 'boom' : null }), 5);
          return undefined;
        }
        case 'thread/resume': {
          if (script.resumeError || !threads.has(p.threadId)) return fail(m.id, script.resumeError || `no rollout found for thread id ${p.threadId}`);
          rec.thread = p.threadId;
          rec.resumeParams = p;
          reply(m.id, { thread: { id: p.threadId } });
          if (script.mcp !== 'silent') setTimeout(() => note('mcpServer/startupStatus/updated', { threadId: p.threadId, name: 'lumen', status: script.mcp, error: script.mcp === 'failed' ? 'boom' : null }), 5);
          return undefined;
        }
        case 'turn/interrupt': rec.notes.push(m); reply(m.id, {}); if (rec.turn && !script.ignoreInterrupt) { const t = rec.turn; t.interrupted = true; rec.turn = null; setImmediate(() => note('turn/completed', { threadId: t.threadId, turn: { id: t.id, status: 'interrupted', error: null } })); } return undefined;
        case 'turn/start': {
          const text = p.input?.[0]?.text;
          rec.prompts.push(text);
          rec.inputs.push(p);
          const id = `turn-${++turns}`;
          rec.turn = { id, threadId: p.threadId, interrupted: false };
          reply(m.id, { turn: { id, items: [], status: 'inProgress' } });
          const tid = p.threadId;
          const say = (itemId, delta) => note('item/agentMessage/delta', { threadId: tid, turnId: id, itemId, delta });
          const item = (method, it) => note(method, { threadId: tid, turnId: id, item: it });
          const done = (extra = {}) => { if (rec.turn?.id === id) { rec.turn = null; note('turn/completed', { threadId: tid, turn: { id, status: 'completed', error: null, ...extra } }); } };
          const usage = (last) => note('thread/tokenUsage/updated', { threadId: tid, turnId: id, tokenUsage: { total: last, last } });
          const ctx = { rec, p, id, tid, say, item, done, usage, note };
          if (script.turn) return script.turn(ctx);
          setImmediate(() => {
            note('turn/started', { threadId: tid, turn: { id, status: 'inProgress' } });
            say('msg-1', 'warm ');
            say('msg-1', `reply ${rec.prompts.length}`);
            item('item/completed', { type: 'agentMessage', id: 'msg-1', text: `warm reply ${rec.prompts.length}`, phase: 'final_answer' });
            usage({ inputTokens: 100, cachedInputTokens: 60, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 1, totalTokens: 105 });
            done();
          });
          return undefined;
        }
        default: if (m.id !== undefined) fail(m.id, 'Method not found');
      }
      return undefined;
    }
    child.stdin = new Writable({
      write(chunk, _enc, cb) {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const m = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          if (ready) handle(m); else queue.push(m);
        }
        cb();
      },
      final(cb) { rec.ended = true; setTimeout(() => rec.exit(0), 5); cb(); },
    });
    return child;
  };
  return { spawn, spawned, threads, script, apps: () => spawned.filter((r) => r.app), headless: () => spawned.filter((r) => !r.app) };
}

// A stand-in for Lumen's HTTP gate (mcp-http.js startHttp's API).
const mkGate = () => ({
  runs: new Map(),
  open(tag, chat) { this.runs.set(tag, { chat }); return { mcpUrl: 'http://127.0.0.1:1/mcp', mcpToken: `m-${tag}` }; },
  close(tag) { this.runs.delete(tag); },
  bindChat(tag, chat) { const r = this.runs.get(tag); if (r) r.chat = chat; },
  listed: () => false,
});
const spec = { found: true, command: process.execPath, args: [], path: process.execPath, kind: 'exe', version: '9.9.9' };

(async () => {
  // ---- pure parts
  {
    const a = warmLib.approvalAnswer;
    check('approvals: a command, a file change and a permission are declined, a question gets no answers, a client tool call fails', a('item/commandExecution/requestApproval', {}).decision === 'decline' && a('item/fileChange/requestApproval', {}).decision === 'decline' && J(a('item/permissions/requestApproval', {}).permissions) === '{}' && J(a('item/tool/requestUserInput', {}).answers) === '{}' && a('item/tool/call', {}).success === false && a('execCommandApproval', {}).decision === 'denied' && a('applyPatchApproval', {}).decision === 'denied');
    check('approvals: only Lumen\'s own MCP server may be allowed; another server is declined; an unknown request has no answer', a('mcpServer/elicitation/request', { serverName: 'lumen' }).action === 'accept' && a('mcpServer/elicitation/request', { serverName: 'other' }).action === 'decline' && a('mcpServer/elicitation/request', {}).action === 'decline' && a('something/new', {}) === null);
    const o = warmLib.offItemOf;
    check('off items: a shell command, file change, web search, sub-agent, picture tool and another server\'s tool are named; Lumen\'s tools and messages are not', o({ type: 'commandExecution' }) === 'a shell command' && o({ type: 'fileChange' }) === 'a file change' && o({ type: 'webSearch' }) === 'a web search' && o({ type: 'collabAgentToolCall' }) === 'a sub-agent' && o({ type: 'imageGeneration' }) && o({ type: 'dynamicToolCall' }) && /^other\/t$/.test(o({ type: 'mcpToolCall', server: 'other', tool: 't' })) && o({ type: 'mcpToolCall', server: 'lumen', tool: 'read_page' }) === null && o({ type: 'agentMessage' }) === null && o({ type: 'reasoning' }) === null && o(null) === null);
    check('reasoning: a summary is shown as thinking, else the content', warmLib.reasoningText({ summary: ['a', 'b'], content: ['c'] }) === 'a\n\nb' && warmLib.reasoningText({ summary: [], content: ['c'] }) === 'c' && warmLib.reasoningText({}) === '');
    const sum = warmLib.addUsage(warmLib.addUsage({}, { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 }), { inputTokens: 20, cachedInputTokens: 10, outputTokens: 3, reasoningOutputTokens: 1 });
    check('usage: a turn\'s calls add up in exec\'s shape', sum.input_tokens === 30 && sum.cached_input_tokens === 14 && sum.output_tokens === 5 && sum.reasoning_output_tokens === 1, J(sum));
    const settings = require('../src/settings/settings-backend');
    const defaults = settings.DEFAULTS || settings.defaults || null;
    if (defaults) check('setting: Keep Codex connected is on by default; its idle time is the Grok Build one', defaults.codexKeepConnected === true && defaults.grokKeepIdleMinutes === 15, J({ k: defaults.codexKeepConnected }));
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cxkeep-'));
  const userHome = path.join(tmp, 'user');
  const tmpDir = path.join(tmp, 'tmp');
  fs.mkdirSync(userHome);
  fs.mkdirSync(tmpDir);
  fs.writeFileSync(path.join(userHome, 'auth.json'), 'tok');
  let n = 0;
  const setup = ({ on = true, idleMs = 60000, maxProcs = 4, cancelWaitMs = 2000, watchdogMs = 0, readyWaitMs = 300 } = {}) => {
    const fake = fakeCodex();
    const userData = path.join(tmp, `ud${++n}`);
    const fakeGate = mkGate();
    const engine = new cx.CodexEngine({ userData, gate: async () => fakeGate, locate: async () => spec, userHome: () => userHome, tmp: tmpDir, spawn: fake.spawn, kill: (c) => c.kill(), exec: () => {}, watchdogMs });
    const state = { on, idleMs };
    engine.keepWarm = warmLib.createCodexWarm({ engine, enabled: () => state.on, idleMs: () => state.idleMs, maxProcs, cancelWaitMs, readyWaitMs, quitGraceMs: 100 });
    return { fake, engine, state, pool: engine.keepWarm, userData, fakeGate };
  };
  const send = async (engine, { prompt = 'hi', sessionId = null, chatId = 'chat-a', systemPrompt = 'SYS', model = 'default', effort = '', fullAccess = false, images = [], signal = new AbortController().signal, quietExpired = false } = {}) => {
    const events = [];
    const t0 = Date.now();
    let ttft = null;
    const out = await engine.run({ prompt, images, sessionId, systemPrompt, model, effort, fullAccess, signal, quietExpired, scope: { chatId }, emit: (e) => { events.push(e); if (ttft === null && e.type === 'text') ttft = Date.now() - t0; } });
    return { out, events, ttft, ms: Date.now() - t0 };
  };

  try {
    // ---- off: exactly today's behaviour
    {
      const { fake, engine, pool } = setup({ on: false });
      const one = await send(engine);
      const two = await send(engine, { sessionId: one.out.sessionId });
      check('off: each message is a headless codex exec, no app-server process', fake.apps().length === 0 && fake.headless().length === 2 && two.out.text === 'cold reply', J(fake.spawned.map((r) => r.argv[0])));
      check('off: prewarm starts nothing', pool.prewarm({ chatId: 'chat-a', sessionId: null }) === false && fake.spawned.length === 2 && pool.count() === 0);
    }

    // ---- on: one kept process per chat, timing against headless
    {
      const { fake, engine, pool, userData } = setup();
      const one = await send(engine, { model: 'gpt-6-luna', effort: 'high' });
      check('on: the first message starts one `codex app-server` and answers through it', one.out.text === 'warm reply 1' && /^thread-new-/.test(one.out.sessionId) && fake.apps().length === 1 && fake.headless().length === 0 && !one.out.failed, J({ out: one.out, argv: fake.spawned.map((r) => r.argv) }));
      const rec = fake.apps()[0];
      check('on: the reply streams as deltas (two text events before the whole message), a new thread is started', one.events.filter((e) => e.type === 'text').map((e) => e.text).join('|') === 'warm |reply 1' && rec.requests.some((m) => m.method === 'thread/start'), J(one.events));
      check('on: argv is only `app-server`; never a bypass, full-auto or writable sandbox', J(rec.argv) === '["app-server"]');
      const home = cx.chatHomeFor(userData, 'chat-a');
      check('on: Lumen\'s per-chat CODEX_HOME, its own token, the short environment and an empty working folder', path.resolve(rec.opts.env.CODEX_HOME) === path.resolve(home) && /^m-/.test(rec.opts.env.LUMEN_MCP_TOKEN) && !('GITHUB_TOKEN' in rec.opts.env) && /lumen-cx-/.test(rec.opts.cwd) && fs.readdirSync(rec.opts.cwd).length === 0 && rec.opts.shell === false);
      const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
      check('config: one MCP server (lumen), read-only sandbox, never asks, tools off with the Code Mode host on, no model line, token not in the file', (config.match(/^\[mcp_servers\./gm) || []).length === 1 && /sandbox_mode = "read-only"/.test(config) && /approval_policy = "never"/.test(config) && /shell_tool = false/.test(config) && !/code_mode_host = false/.test(config) && !/^model = /m.test(config) && !config.includes(rec.opts.env.LUMEN_MCP_TOKEN), config);
      check('init: the client is named, experimental API off', rec.initParams.clientInfo.name === 'lumen' && rec.initParams.capabilities.experimentalApi === false && rec.requests.some((m) => m.method === 'initialized'));
      check('thread: started in the empty folder with approval never and the read-only sandbox', rec.startParams.approvalPolicy === 'never' && rec.startParams.sandbox === 'read-only' && rec.startParams.cwd === rec.opts.cwd && rec.startParams.ephemeral === false, J(rec.startParams));
      const t1 = rec.inputs[0];
      check('turn: sandbox read-only and approval never repeated, the picked model and effort, the first message carries Lumen\'s instructions', t1.approvalPolicy === 'never' && t1.sandboxPolicy.type === 'readOnly' && t1.model === 'gpt-6-luna' && t1.effort === 'high' && /<lumen_instructions>\nSYS\n<\/lumen_instructions>/.test(t1.input[0].text) && t1.input[0].text.includes('hi'), J(t1));
      const two = await send(engine, { sessionId: one.out.sessionId, effort: 'high' });
      const three = await send(engine, { sessionId: two.out.sessionId, effort: 'high' });
      check('on: later messages reuse the same process (no new spawn, no thread/resume), one turn each', fake.spawned.length === 1 && rec.prompts.length === 3 && three.out.text === 'warm reply 3' && pool.stats.reused === 2 && !rec.requests.some((m) => m.method === 'thread/resume'), J({ spawned: fake.spawned.length, reused: pool.stats.reused }));
      check('on: a later message carries the one-line reminder, no model for the default pick', /<lumen_reminder>/.test(rec.prompts[1]) && !('model' in rec.inputs[1]) && rec.inputs[1].effort === 'high', J(rec.inputs[1]));
      check('on: usage is reported in run()\'s shape (calls summed, input split from cached)', two.out.usage?.inputTokens === 40 && two.out.usage?.cacheReadTokens === 60 && two.out.usage?.outputTokens === 5 && two.out.sessionId === one.out.sessionId && !two.out.keep, J(two.out));
      check('on: the sign-in copy and folder are in place; the engine lists the working folder for the quit-time purge', fs.readFileSync(path.join(home, 'auth.json'), 'utf8') === 'tok' && engine.workDirs.has(rec.opts.cwd));

      // the same exchange, headless (the setting off)
      const cold = setup({ on: false });
      const c1 = await send(cold.engine);
      const c2 = await send(cold.engine, { sessionId: c1.out.sessionId });
      console.log(`      time to first token, 2nd message: headless ${c2.ttft} ms (done ${c2.ms} ms), kept ${two.ttft} ms (done ${two.ms} ms); simulated start ${STARTUP_MS} ms + exit ${EXIT_MS} ms`);
      check('timing: a second message skips the start (first token well under the start cost; headless pays it)', two.ttft < STARTUP_MS / 3 && c2.ttft >= STARTUP_MS && two.ms < c2.ms, J({ warm: two.ttft, cold: c2.ttft }));

      // pre-warm: a new chat's first message
      const pre = setup();
      check('prewarm: starts the open chat\'s process before its message, once', pre.pool.prewarm({ chatId: 'chat-a', sessionId: null }) === true && pre.pool.prewarm({ chatId: 'chat-a', sessionId: null }) === false);
      await until(() => pre.fake.apps()[0]?.requests.some((m) => m.method === 'thread/start'), 3000); await sleep(60);
      const p1 = await send(pre.engine);
      console.log(`      time to first token, first message: headless ${c1.ttft} ms, after pre-warm ${p1.ttft} ms`);
      check('prewarm: the first message takes the ready process (no spawn at send, first token well under the start cost)', pre.fake.spawned.length === 1 && p1.out.text === 'warm reply 1' && p1.ttft < STARTUP_MS / 3, J({ spawned: pre.fake.spawned.length, ttft: p1.ttft }));
      const pre2 = setup();
      pre2.pool.prewarm({ chatId: 'chat-a', sessionId: null });
      const early = await send(pre2.engine); // sent while the pre-warm is still starting: it waits for it, no second process
      check('prewarm: a message sent while the pre-warm is starting waits for it (one process)', pre2.fake.spawned.length === 1 && early.out.text === 'warm reply 1', String(pre2.fake.spawned.length));
      const pre3 = setup();
      pre3.fake.threads.add('thread-known-0002');
      pre3.pool.prewarm({ chatId: 'chat-a', sessionId: 'thread-known-0002' });
      await until(() => pre3.fake.apps()[0]?.requests.some((m) => m.method === 'thread/resume'), 3000); await sleep(60);
      const r3 = await send(pre3.engine, { sessionId: 'thread-known-0002' });
      const resumed = pre3.fake.apps()[0].requests.find((m) => m.method === 'thread/resume');
      check('prewarm: an existing chat\'s thread is resumed ahead (thread/resume, same isolation) and then used', pre3.fake.spawned.length === 1 && resumed && resumed.params.approvalPolicy === 'never' && resumed.params.sandbox === 'read-only' && r3.out.sessionId === 'thread-known-0002' && /<lumen_reminder>/.test(pre3.fake.apps()[0].prompts[0]), J(r3.out));
      const pre4 = setup();
      pre4.pool.prewarm({ chatId: 'chat-a', sessionId: null });
      await sleep(STARTUP_MS + 120);
      const wrong = await send(pre4.engine, { sessionId: 'thread-known-0001' }); // the chat's thread is another one than the spare's
      check('prewarm: a spare thread that this message does not continue is ended, the right thread is resumed', pre4.fake.apps().length === 2 && pre4.fake.apps()[0].killed !== undefined && wrong.out.sessionId === 'thread-known-0001', J(wrong.out));
    }

    // ---- two chats never share a process
    {
      const { fake, engine, fakeGate } = setup();
      const a = await send(engine, { chatId: 'chat-a' });
      const b = await send(engine, { chatId: 'chat-b' });
      await send(engine, { chatId: 'chat-a', sessionId: a.out.sessionId, prompt: 'to A' });
      await send(engine, { chatId: 'chat-b', sessionId: b.out.sessionId, prompt: 'to B' });
      const [pa, pb] = fake.apps();
      check('chats: two chats get two processes in two homes, each only ever gets its own chat\'s messages', fake.apps().length === 2 && a.out.sessionId !== b.out.sessionId && /hi$/.test(pa.prompts[0]) && /to A$/.test(pa.prompts[1]) && /to B$/.test(pb.prompts[1]) && pa.opts.env.CODEX_HOME !== pb.opts.env.CODEX_HOME && pa.opts.env.LUMEN_MCP_TOKEN !== pb.opts.env.LUMEN_MCP_TOKEN);
      const tagA = [...fakeGate.runs.keys()];
      check('owner: each process owns its own MCP tag, only while alive; an unknown tag has no owner', tagA.length === 2 && tagA.every((t) => engine.keepWarm.owner(t)?.kind === 'codex') && engine.keepWarm.owner('nope') === null && engine.keepWarm.owner(tagA[0]).active === null);
    }

    // ---- the turn's own scope during a turn
    {
      const { fake, engine, fakeGate } = setup();
      let seen = null;
      fake.script.turn = ({ rec, tid, id, say, item, done, note }) => {
        const tag = [...fakeGate.runs.keys()].pop();
        const o = engine.keepWarm.owner(tag);
        seen = { scope: o.active?.scope, tag: o.active?.tag === tag };
        o.callBegin(); const mid = o.active.inflight; o.callEnd();
        seen.mid = mid; seen.end = o.active.inflight; seen.tools = o.active.tools;
        note('turn/started', { threadId: tid, turn: { id } }); say('m', 'ok'); item('item/completed', { type: 'agentMessage', id: 'm', text: 'ok' }); done();
      };
      const r = await send(engine, { chatId: 'chat-scope' });
      check('owner: during a turn `active` carries that message\'s scope; tool calls count; between turns it is null', seen.scope?.chatId === 'chat-scope' && seen.tag && seen.mid === 1 && seen.end === 0 && seen.tools === 1 && r.out.text === 'ok' && engine.keepWarm.owner([...fakeGate.runs.keys()][0]).active === null, J(seen));
    }

    // ---- Stop / Send now: interrupt the turn, keep the process
    {
      const { fake, engine, pool } = setup();
      const first = await send(engine);
      fake.script.turn = ({ rec, tid, id, say, note }) => {
        const mine = rec.turn;
        note('turn/started', { threadId: tid, turn: { id } });
        const t = setInterval(() => { if (rec.turn !== mine || mine.interrupted) { clearInterval(t); return; } say('m', 'x'); }, 10);
      };
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 70);
      const stopped = await send(engine, { sessionId: first.out.sessionId, signal: ac.signal });
      const rec = fake.apps()[0];
      const intr = rec.notes.find((m) => m.method === 'turn/interrupt');
      check('stop: the turn is interrupted (turn/interrupt with its thread and turn id), the reply so far is kept, the process stays', stopped.out.stopped === true && /x/.test(stopped.out.text) && intr && intr.params.threadId === first.out.sessionId && /^turn-/.test(intr.params.turnId) && !rec.killed && pool.count() === 1, J(stopped.out));
      fake.script.turn = null;
      const after = await send(engine, { sessionId: first.out.sessionId });
      check('stop: the next message reuses the same process', fake.spawned.length === 1 && after.out.text === 'warm reply 3', J(after.out));

      const stuck = setup({ cancelWaitMs: 80 });
      const s1 = await send(stuck.engine);
      stuck.fake.script.turn = ({ tid, id, note }) => note('turn/started', { threadId: tid, turn: { id } }); // never ends
      stuck.fake.script.ignoreInterrupt = true;
      const ac2 = new AbortController();
      setTimeout(() => ac2.abort(), 30);
      const s2 = await send(stuck.engine, { sessionId: s1.out.sessionId, signal: ac2.signal });
      check('stop: a turn that ignores the interrupt gets its process killed after the wait', s2.out.stopped === true && stuck.fake.apps()[0].killed === true && stuck.pool.count() === 0, J({ out: s2.out, killed: stuck.fake.apps()[0].killed }));
      const pre = setup();
      const ac3 = new AbortController();
      ac3.abort();
      const early = await send(pre.engine, { signal: ac3.signal });
      check('stop: aborted before it starts: nothing is sent, stopped result', early.out.stopped === true && early.out.text === '' && pre.fake.apps().every((r) => r.prompts.length === 0));
    }

    // ---- Lumen's checks on what Codex does
    {
      const { fake, engine, pool } = setup();
      await send(engine);
      const answers = {};
      fake.script.turn = async ({ rec, tid, id, say, item, done, note }) => {
        note('turn/started', { threadId: tid, turn: { id } });
        for (const [method, params] of [['item/commandExecution/requestApproval', { threadId: tid, command: 'rm -rf x' }], ['item/fileChange/requestApproval', { threadId: tid }], ['item/permissions/requestApproval', { threadId: tid, permissions: { network: { enabled: true } } }], ['mcpServer/elicitation/request', { threadId: tid, serverName: 'evil', message: 'ok?', mode: 'form', requestedSchema: {} }], ['mcpServer/elicitation/request', { threadId: tid, serverName: 'lumen', message: 'ok?', mode: 'form', requestedSchema: {} }]]) answers[`${method}:${params.serverName || ''}`] = (await rec.ask(method, params)).result;
        say('m', 'done'); item('item/completed', { type: 'agentMessage', id: 'm', text: 'done' }); done();
      };
      const r = await send(engine, { sessionId: [...fake.threads].find((t) => /new/.test(t)) });
      check('approvals: Codex\'s own requests are answered by Lumen: commands, file changes and permissions refused, only Lumen\'s server allowed', answers['item/commandExecution/requestApproval:'].decision === 'decline' && answers['item/fileChange/requestApproval:'].decision === 'decline' && J(answers['item/permissions/requestApproval:'].permissions) === '{}' && answers['mcpServer/elicitation/request:evil'].action === 'decline' && answers['mcpServer/elicitation/request:lumen'].action === 'accept' && r.out.text === 'done', J(answers));
      const sid = r.out.sessionId;
      fake.script.turn = ({ tid, id, say, item, done, note }) => {
        note('turn/started', { threadId: tid, turn: { id } });
        item('item/started', { type: 'mcpToolCall', id: 'c1', server: 'lumen', tool: 'read_page', status: 'inProgress' });
        item('item/completed', { type: 'mcpToolCall', id: 'c1', server: 'lumen', tool: 'read_page', status: 'completed' });
        item('item/completed', { type: 'reasoning', id: 'r1', summary: ['Thinking it over'], content: [] });
        say('m', 'fine'); item('item/completed', { type: 'agentMessage', id: 'm', text: 'fine' }); done();
      };
      const ok = await send(engine, { sessionId: sid });
      check('items: Lumen\'s own tool calls and a reasoning summary pass (shown as thinking)', ok.out.text === 'fine' && !ok.out.failed && ok.events.some((e) => e.type === 'thinking' && e.text === 'Thinking it over'), J(ok));
      fake.script.turn = ({ tid, id, item, note }) => { note('turn/started', { threadId: tid, turn: { id } }); item('item/started', { type: 'commandExecution', id: 'c2', command: 'cat ~/.ssh/id_rsa', status: 'inProgress' }); };
      const bad = await send(engine, { sessionId: sid });
      check('items: a reported shell command ends the message with a plain error, drops the thread and kills the process', bad.out.failed && bad.out.sessionId === null && bad.events.some((e) => e.type === 'error' && /isn't one of Lumen's browser tools \(a shell command\)/.test(e.text)) && fake.apps()[0].killed && pool.count() === 0, J(bad));
      const other = setup();
      await send(other.engine);
      other.fake.script.turn = ({ tid, id, item, note }) => { note('turn/started', { threadId: tid, turn: { id } }); item('item/started', { type: 'mcpToolCall', id: 'c3', server: 'github', tool: 'create_issue', status: 'inProgress' }); };
      const bad2 = await send(other.engine, { sessionId: other.fake.apps()[0].thread });
      check('items: another MCP server\'s tool is stopped too', bad2.out.failed && bad2.events.some((e) => e.type === 'error' && /github\/create_issue/.test(e.text)), J(bad2.events));
    }

    // ---- failures
    {
      const { fake, engine, pool } = setup();
      fake.script.turn = ({ tid, id, note }) => { note('turn/started', { threadId: tid, turn: { id } }); note('error', { threadId: tid, turnId: id, willRetry: true, error: { message: 'Reconnecting... 1/5' } }); note('turn/completed', { threadId: tid, turn: { id, status: 'failed', error: { message: 'You\'ve hit your usage limit. Try again at 3:40 PM.' } } }); };
      const r = await send(engine);
      check('limit: a usage-limit failure says so and carries the limit message (planLimit); the process is not kept', r.out.failed && r.out.planLimit && /usage limit/.test(r.out.planLimit.text) && r.events.some((e) => e.type === 'error' && /usage limit is re/.test(e.text)) && pool.count() === 0, J(r));
      const auth = setup();
      auth.fake.script.turn = ({ tid, id, note }) => { note('turn/started', { threadId: tid, turn: { id } }); note('turn/completed', { threadId: tid, turn: { id, status: 'failed', error: { message: 'unauthorized: please log in again' } } }); };
      const a = await send(auth.engine);
      check('sign-in: a sign-in failure says to run codex login, and the engine remembers it is signed out', a.out.failed && a.events.some((e) => e.type === 'error' && /not signed in/.test(e.text)) && auth.engine.signedOut === true);
      const died = setup();
      died.fake.script.turn = ({ rec }) => { rec.child.stderr.write('panic: boom'); rec.exit(101); };
      const d = await send(died.engine);
      check('crash: a process that dies mid-turn fails the message with its stderr, nothing hangs', d.out.failed && d.events.some((e) => e.type === 'error' && /exit 101/.test(e.text) && /boom/.test(e.text)), J(d.events));
      const dog = setup({ watchdogMs: 120 });
      dog.fake.script.turn = ({ tid, id, note }) => note('turn/started', { threadId: tid, turn: { id } }); // silence
      const w = await send(dog.engine);
      check('watchdog: a silent turn is ended with the plain message and the process goes', w.out.failed && w.events.some((e) => e.type === 'error' && /stopped responding/.test(e.text)) && dog.fake.apps()[0].killed && dog.pool.count() === 0, J(w.events));
    }

    // ---- fallbacks to a headless run (nothing is sent to the kept process)
    {
      const noApp = setup();
      noApp.fake.script.appServer = false;
      const one = await send(noApp.engine);
      check('fallback: a Codex without app-server: the message still answers, through a headless run', one.out.text === 'cold reply' && noApp.fake.headless().length === 1 && !one.out.failed, J(one.out));
      await send(noApp.engine, { sessionId: one.out.sessionId });
      const before = noApp.fake.apps().length;
      await send(noApp.engine, { sessionId: one.out.sessionId });
      check('fallback: after two failed starts no more app-servers are tried (headless only until Lumen restarts)', before === 2 && noApp.fake.apps().length === 2 && noApp.fake.headless().length === 3, J({ before, now: noApp.fake.apps().length }));
      const noMcp = setup();
      noMcp.fake.script.mcp = 'failed';
      const m = await send(noMcp.engine);
      check('fallback: Lumen\'s MCP server not connecting is a failed start (its process is ended), the headless run answers', m.out.text === 'cold reply' && noMcp.fake.apps()[0].killed && noMcp.pool.count() === 0, J(m.out));
      const gone = setup();
      const g = await send(gone.engine, { sessionId: 'thread-gone-0009', quietExpired: true });
      check('fallback: a thread Codex no longer has: thread/resume fails, the headless run decides (here it answers)', g.out.text === 'cold reply' && gone.fake.apps()[0].killed && gone.fake.headless().length === 1, J(g.out));
      const slow = setup({ readyWaitMs: 100 });
      slow.fake.script.mcp = 'silent';
      const t0 = Date.now();
      const s = await send(slow.engine);
      check('fallback: an MCP server that never reports is not waited for longer than the limit (fake gate says not listed)', s.out.text === 'warm reply 1' || s.out.text === 'cold reply', J(s.out));
      void t0;
      const off = setup();
      const o1 = await send(off.engine);
      off.state.on = false;
      const o2 = await send(off.engine, { sessionId: o1.out.sessionId });
      check('setting off while a process is kept: it ends at the next message and that message goes headless', o2.out.text === 'cold reply' && off.fake.apps()[0].ended === true && off.pool.count() === 0, J({ out: o2.out, ended: off.fake.apps()[0].ended }));
      const nochat = setup();
      const nc = await nochat.engine.run({ prompt: 'x', systemPrompt: 's', signal: new AbortController().signal, emit: () => {}, scope: null });
      check('fallback: a message with no chat id (no home of its own to keep) is headless', nc.text === 'cold reply' && nochat.fake.apps().length === 0, J(nc));
    }

    // ---- pictures, sign-in change, effort back to default
    {
      const { fake, engine } = setup();
      const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
      const r = await send(engine, { images: [{ media_type: 'image/png', data: png }, { media_type: 'image/x-bad', data: png }] });
      const rec = fake.apps()[0];
      const inp = rec.inputs[0].input;
      check('images: sent as localImage files of a folder of their own (not the working folder), removed after the turn; unsupported types dropped', r.out.text === 'warm reply 1' && inp.length === 2 && inp[1].type === 'localImage' && /image-0\.png$/.test(inp[1].path) && path.dirname(inp[1].path) !== rec.opts.cwd && await until(() => !fs.existsSync(inp[1].path), 1500), J(inp));
      const first = r.out.sessionId;
      fs.writeFileSync(path.join(userHome, 'auth.json'), 'tok2');
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(path.join(userHome, 'auth.json'), later, later);
      const again = await send(engine, { sessionId: first });
      check('sign-in: a sign-in the user replaced since the process started makes the next message start a new process (which resumes the thread)', fake.apps().length === 2 && fake.apps()[0].ended === true && again.out.sessionId === first && fake.apps()[1].requests.some((m) => m.method === 'thread/resume') && engine.keepWarm.stats.restarts === 1 && fs.readFileSync(path.join(cx.chatHomeFor(engine.userData, 'chat-a'), 'auth.json'), 'utf8') === 'tok2', J({ apps: fake.apps().length, out: again.out }));
      fs.writeFileSync(path.join(userHome, 'auth.json'), 'tok');
      fs.utimesSync(path.join(userHome, 'auth.json'), new Date(Date.now() - 600000), new Date(Date.now() - 600000));
      const e1 = await send(engine, { sessionId: first, effort: 'high' });
      const e2 = await send(engine, { sessionId: first, effort: '' });
      check('effort: choosing one keeps the process, going back to the default restarts it (a chosen effort stays on a thread)', e1.out.text && e2.out.text && fake.apps().length === 3 && await until(() => fake.apps()[1].ended, 500) && fake.apps()[1].inputs[1].effort === 'high' && !('effort' in fake.apps()[2].inputs[0]), J({ n: fake.apps().length, i1: fake.apps()[1].inputs.map((x) => x.effort), i2: fake.apps()[2].inputs.map((x) => x.effort) }));
    }

    // ---- idle timeout, cap, dropChat, disposeAll
    {
      const { fake, engine, pool } = setup({ idleMs: 120 });
      const a = await send(engine);
      check('idle: a process unused for the idle time ends (stdin closed), the next message starts a new one that resumes the thread', pool.count() === 1);
      await until(() => pool.count() === 0, 1500);
      check('idle: ... it ended', pool.count() === 0 && fake.apps()[0].ended === true);
      const b = await send(engine, { sessionId: a.out.sessionId });
      check('idle: ... and the next message resumed the same thread in a new process', fake.apps().length === 2 && fake.apps()[1].requests.some((m) => m.method === 'thread/resume') && b.out.sessionId === a.out.sessionId, J(b.out));

      const capped = setup({ maxProcs: 2 });
      for (const c of ['c1', 'c2', 'c3']) await send(capped.engine, { chatId: c });
      check('cap: past MAX_PROCS the least recently used idle process goes', capped.pool.count() === 2 && capped.fake.apps()[0].ended === true && !capped.fake.apps()[2].ended, J(capped.fake.apps().map((r) => r.ended)));

      const d = setup();
      const x = await send(d.engine, { chatId: 'gone-chat' });
      void x;
      d.pool.dropChat('gone-chat');
      await sleep(40);
      check('dropChat: the chat\'s idle process ends (tab closed, chat deleted)', d.pool.count() === 0 && d.fake.apps()[0].ended === true);
      await send(d.engine, { chatId: 'k1' }); await send(d.engine, { chatId: 'k2' });
      d.pool.disposeAll({ now: true });
      check('disposeAll: every kept process is killed (Lumen quits); the working folders are removed', d.pool.count() === 0 && d.fake.apps().slice(1).every((r) => r.killed) && await until(() => d.engine.workDirs.size === 0, 1000), String(d.engine.workDirs.size));
      const pending = setup();
      pending.pool.prewarm({ chatId: 'pc', sessionId: null });
      pending.pool.dropChat('pc');
      await sleep(STARTUP_MS + 100);
      check('dropChat: a start still in flight is cancelled', pending.pool.count() === 0, String(pending.pool.count()));
    }

    // ---- full access (codexFullAccess): a kind of process of its own
    {
      const { fake, engine, pool, userData } = setup();
      process.env.LUMEN_TEST_SECRET = 'visible-only-with-full-access';
      const lock = await send(engine);
      const full = await send(engine, { sessionId: lock.out.sessionId, fullAccess: true });
      const [pl, pf] = fake.apps();
      check('full: a locked-down process is never reused for full access: the message starts a full-access one (the idle locked one ends)', fake.apps().length === 2 && await until(() => pl.ended, 500) && full.out.text === 'warm reply 1' && pool.stats.reused === 0, J({ n: fake.apps().length }));
      const home = cx.chatHomeFor(userData, 'chat-a');
      const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
      check('full: config.toml has the sandbox off, approval never, web search live, the shell tools back on, the rest off, Code Mode host on, one MCP server', /sandbox_mode = "danger-full-access"/.test(config) && /approval_policy = "never"/.test(config) && /web_search = "live"/.test(config) && !/shell_tool = false/.test(config) && !/unified_exec = false/.test(config) && !/view_image = false/.test(config) && /plugins = false/.test(config) && /apps = false/.test(config) && /multi_agent = false/.test(config) && /memories = false/.test(config) && !/code_mode_host = false/.test(config) && (config.match(/^\[mcp_servers\./gm) || []).length === 1, config);
      check('full: the thread and every turn say danger-full-access, never a bypass flag; argv is only app-server', pf.startParams === undefined && pf.requests.some((m) => m.method === 'thread/resume' && m.params.sandbox === 'danger-full-access' && m.params.approvalPolicy === 'never') && pf.inputs[0].sandboxPolicy.type === 'dangerFullAccess' && pf.inputs[0].approvalPolicy === 'never' && J(pf.argv) === '["app-server"]', J(pf.requests.map((m) => m.method)));
      check('full: the user\'s whole environment (not Electron\'s switch), the same token and Codex home, an empty working folder', pf.opts.env.LUMEN_TEST_SECRET === 'visible-only-with-full-access' && !('ELECTRON_RUN_AS_NODE' in pf.opts.env) && /^m-/.test(pf.opts.env.LUMEN_MCP_TOKEN) && path.resolve(pf.opts.env.CODEX_HOME) === path.resolve(home) && /lumen-cx-/.test(pf.opts.cwd) && fs.readdirSync(pf.opts.cwd).length === 0 && !('LUMEN_TEST_SECRET' in pl.opts.env));
      const again = await send(engine, { sessionId: full.out.sessionId, fullAccess: true });
      check('full: the next full-access message reuses its process', fake.apps().length === 2 && again.out.text === 'warm reply 2' && pool.stats.reused === 1);
      const back = await send(engine, { sessionId: full.out.sessionId, fullAccess: false });
      check('full: turning it off ends the full-access process and the next message starts a locked-down one', fake.apps().length === 3 && await until(() => pf.ended, 500) && fake.apps()[2].inputs[0].sandboxPolicy.type === 'readOnly' && back.out.text === 'warm reply 1', J(fake.apps().length));
      // Codex's own tools are not stopped, another server's still is
      const f2 = setup();
      await send(f2.engine, { fullAccess: true });
      const sid = f2.fake.apps()[0].thread;
      f2.fake.script.turn = ({ tid, id, say, item, done, note }) => {
        note('turn/started', { threadId: tid, turn: { id } });
        item('item/started', { type: 'commandExecution', id: 'c1', command: 'echo hi', status: 'inProgress' });
        item('item/completed', { type: 'commandExecution', id: 'c1', command: 'echo hi', status: 'completed' });
        item('item/completed', { type: 'webSearch', id: 'w1', query: 'x' });
        say('m', 'hi'); item('item/completed', { type: 'agentMessage', id: 'm', text: 'hi' }); done();
      };
      const ok = await send(f2.engine, { sessionId: sid, fullAccess: true });
      check('full: a shell command and a web search are Codex\'s own tools then: nothing stops the message', ok.out.text === 'hi' && !ok.out.failed && !f2.fake.apps()[0].killed, J(ok.out));
      f2.fake.script.turn = ({ tid, id, item, note }) => { note('turn/started', { threadId: tid, turn: { id } }); item('item/started', { type: 'mcpToolCall', id: 'c3', server: 'github', tool: 'create_issue', status: 'inProgress' }); };
      const bad = await send(f2.engine, { sessionId: sid, fullAccess: true });
      check('full: another MCP server\'s tool is still refused', bad.out.failed && bad.events.some((e) => e.type === 'error' && /github\/create_issue/.test(e.text)));
      const ans = warmLib.approvalAnswer;
      check('full: Codex\'s own approval requests are allowed once; locked-down ones stay declined', ans('item/commandExecution/requestApproval', {}, { fullAccess: true }).decision === 'accept' && ans('item/fileChange/requestApproval', {}, { fullAccess: true }).decision === 'accept' && ans('execCommandApproval', {}, { fullAccess: true }).decision === 'approved' && ans('item/commandExecution/requestApproval', {}).decision === 'decline' && ans('mcpServer/elicitation/request', { serverName: 'other' }, { fullAccess: true }).action === 'decline');
      const o = warmLib.offItemOf;
      check('full: offItemOf lets the shell, patch, web and picture-view items through but not sub-agents, picture generation or other servers', o({ type: 'commandExecution' }, { fullAccess: true }) === null && o({ type: 'fileChange' }, { fullAccess: true }) === null && o({ type: 'webSearch' }, { fullAccess: true }) === null && o({ type: 'imageView' }, { fullAccess: true }) === null && o({ type: 'collabAgentToolCall' }, { fullAccess: true }) && o({ type: 'imageGeneration' }, { fullAccess: true }) && o({ type: 'commandExecution' }));
      // prewarm: the right kind, and the other kind goes
      const pre = setup();
      pre.pool.prewarm({ chatId: 'chat-a', sessionId: null, fullAccess: false });
      await sleep(STARTUP_MS + 100);
      pre.pool.prewarm({ chatId: 'chat-a', sessionId: null, fullAccess: true });
      await sleep(STARTUP_MS + 100);
      check('full: prewarm starts the kind the setting asks for; a spare of the other kind ends', pre.fake.apps().length === 2 && pre.fake.apps()[0].ended === true && pre.pool.count() === 1 && pre.fake.apps()[1].startParams.sandbox === 'danger-full-access', J(pre.fake.apps().map((r) => r.ended)));
      const first = await send(pre.engine, { fullAccess: true });
      check('full: the first full-access message takes that prewarmed process', pre.fake.apps().length === 2 && first.out.text === 'warm reply 1' && first.ttft < STARTUP_MS / 3, J({ n: pre.fake.apps().length, ttft: first.ttft }));
      // headless fallback keeps the flag
      const noApp = setup();
      noApp.fake.script.appServer = false;
      await send(noApp.engine, { fullAccess: true });
      const h = noApp.fake.headless()[0];
      check('full: a headless run says --sandbox danger-full-access (never the bypass flag), whole environment, empty folder, config with the sandbox off', h.argv.includes('danger-full-access') && !h.argv.includes('read-only') && !h.argv.some((a) => /bypass|dangerously|full-auto/.test(a)) && h.opts.env.LUMEN_TEST_SECRET === 'visible-only-with-full-access' && /lumen-cx-/.test(h.opts.cwd) && /sandbox_mode = "danger-full-access"/.test(fs.readFileSync(path.join(cx.chatHomeFor(noApp.userData, 'chat-a'), 'config.toml'), 'utf8')), J(h.argv));
      delete process.env.LUMEN_TEST_SECRET;
    }

    // ---- a headless run in the chat's home waits for / replaces a kept process
    {
      const { fake, engine, pool } = setup();
      const a = await send(engine);
      fake.script.appServer = false;
      pool.dropChat('chat-a');
      const b = await send(engine, { sessionId: a.out.sessionId });
      check('mixed: after the kept process is dropped, the chat\'s next message is a normal headless run in the same home', b.out.text === 'cold reply' && fake.headless().length === 1, J(b.out));
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
