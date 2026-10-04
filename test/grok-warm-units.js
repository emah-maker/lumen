// "Keep Grok Build connected" (features/grok-warm.js), plain Node with a fake `grok`: no Electron, no network, no real CLI.
// The fake speaks both of grok's modes: headless (`grok --prompt-file ...`, one process per message, stream-json) and
// agent mode (`grok agent --agent-profile <file> stdio`, ACP JSON-RPC on stdin/stdout). Each mode pays a simulated start
// cost (STARTUP_MS) before it can answer, so time-to-first-token with and without the kept process can be compared.
// Covers: off by default (today's behaviour, no agent process, no pre-warm), one process per chat kept between messages
// and never shared, pre-warm before the first message, Stop / Send now cancelling the turn and keeping the process (and a
// process that ignores the cancel being killed), Lumen's checks (gate re-armed each message, permission answers, a tool
// that isn't Lumen's running, the turn cap, the watchdog), full access and a chosen effort served by a kept process of their
// own kind (never shared with the locked-down one), the fallbacks to a headless run (images, a session
// Grok doesn't know), idle timeout, the process cap, drop / disposeAll, the agent profile and environment.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await sleep(5); return fn(); };

const gb = require('../src/ai/grok-build');
const warmLib = require('../src/features/grok-warm');
const { startHttp } = require('../src/automation/mcp-http');

const STARTUP_MS = 300; // what a new grok process costs before it can answer (simulated; real: see the commit message)
const EXIT_MS = 200; // a headless grok's flush and exit after its result (simulated)

// ---- the fake grok
function fakeGrok() {
  const spawned = [];
  const sessions = new Set(['known-session']);
  let newIds = 0;
  const script = { prompt: null, ignoreCancel: false }; // prompt(rec, params, reply, update): a test's own turn
  const spawn = (bin, argv, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.pid = 7000 + spawned.length;
    const agent = argv[0] === 'agent';
    const rec = { argv, opts, child, agent, requests: [], notes: [], answers: [], killed: false, ended: false, prompts: [], born: Date.now() };
    spawned.push(rec);
    const out = (obj) => { if (child.exitCode === null) child.stdout.write(`${JSON.stringify(obj)}\n`); };
    rec.exit = (code = 0) => { if (child.exitCode !== null) return; child.exitCode = code; setImmediate(() => child.emit('close', code)); };
    child.kill = () => { rec.killed = true; rec.exit(1); };
    if (!agent) {
      // headless: one message from --prompt-file, then exit
      const blocks = JSON.parse(fs.readFileSync(argv[argv.indexOf('--prompt-file') + 1], 'utf8'));
      const session = argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : argv[argv.indexOf('--session-id') + 1];
      rec.prompts.push(blocks[0].text);
      child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
      setTimeout(() => {
        fakeGate.armNow(rec); // its UserPromptSubmit hook
        out({ type: 'system', subtype: 'init', session_id: session, model: 'grok-4.7' });
        out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
        out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'cold reply' } } });
        out({ type: 'result', subtype: 'success', is_error: false, result: 'cold reply', session_id: session, usage: { input_tokens: 10, output_tokens: 2 } });
        setTimeout(() => rec.exit(0), EXIT_MS);
      }, STARTUP_MS);
      return child;
    }
    // agent mode: ACP over stdio
    let buf = '';
    let ready = false;
    const queue = [];
    setTimeout(() => { ready = true; for (const m of queue.splice(0)) handle(m); }, STARTUP_MS);
    const reply = (id, result) => out({ jsonrpc: '2.0', id, result });
    const fail = (id, message) => out({ jsonrpc: '2.0', id, error: { code: -32603, message } });
    const update = (sessionId, u) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
    let nextAsk = 1000;
    const asks = new Map();
    rec.ask = (method, params) => new Promise((resolve) => { const id = ++nextAsk; asks.set(id, resolve); out({ jsonrpc: '2.0', id, method, params }); });
    rec.turn = null; // { id, sessionId, cancelled }
    function handle(m) {
      if (m.id !== undefined && m.method === undefined) { const done = asks.get(m.id); if (done) { asks.delete(m.id); rec.answers.push(m); done(m); } return; }
      rec.requests.push(m);
      const p = m.params || {};
      switch (m.method) {
        case 'initialize': rec.initMeta = p._meta; return reply(m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false } } });
        case 'session/new': { const id = `s-new-${++newIds}`; sessions.add(id); rec.session = id; rec.newMeta = p._meta; return reply(m.id, { sessionId: id, models: { currentModelId: 'grok-4.7' } }); }
        case 'session/resume': if (!sessions.has(p.sessionId)) return fail(m.id, 'Path not found.'); rec.session = p.sessionId; return reply(m.id, { models: { currentModelId: 'grok-4.7' } });
        case 'session/set_model': rec.model = p.modelId; return reply(m.id, { _meta: { model: { Ok: p.modelId } } });
        case 'session/cancel': rec.notes.push(m); if (rec.turn && !script.ignoreCancel) { rec.turn.cancelled = true; const t = rec.turn; rec.turn = null; reply(t.id, { stopReason: 'cancelled' }); } return undefined;
        case 'session/prompt': {
          const text = p.prompt?.[0]?.text;
          rec.prompts.push(text);
          // Lumen's gate hook (UserPromptSubmit) runs before the model's first output
          if (!script.noArm) fakeGate.armNow?.(rec);
          rec.turn = { id: m.id, sessionId: p.sessionId, cancelled: false };
          const end = (result) => { if (rec.turn?.id === m.id) { rec.turn = null; reply(m.id, result); } };
          if (script.prompt) return script.prompt(rec, p, end, (u) => update(p.sessionId, u));
          update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `warm reply ${rec.prompts.length}` } });
          return setImmediate(() => end({ stopReason: 'end_turn', _meta: { modelId: rec.model || 'grok-4.7', usage: { inputTokens: 100, cachedReadTokens: 60, outputTokens: 5, modelCalls: 1, costUsdTicks: 2e7 } } }));
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
  return { spawn, spawned, sessions, script, agents: () => spawned.filter((r) => r.agent), headless: () => spawned.filter((r) => !r.agent) };
}

// A stand-in for Lumen's HTTP gate (mcp-http.js startHttp's API): armed per run, re-armed per message.
const fakeGate = {
  runs: new Map(),
  open(tag, chat, opts = {}) { this.runs.set(tag, { armed: false, chat, opts }); this.lastOpen = { tag, chat, opts }; return { mcpUrl: 'http://127.0.0.1:1/mcp', mcpToken: `m-${tag}`, hookUrl: `http://127.0.0.1:1/hook/${tag}` }; },
  close(tag) { this.runs.delete(tag); },
  armed(tag) { return Boolean(this.runs.get(tag)?.armed); },
  rearm(tag) { const r = this.runs.get(tag); if (r) r.armed = false; },
  bindChat(tag, chat) { const r = this.runs.get(tag); if (r) r.chat = chat; },
  listed: () => true,
  // the fake CLI's hook: arm the run whose token this process got
  armNow(rec) { const tag = String(rec.opts.env.LUMEN_MCP_TOKEN || '').replace(/^m-/, ''); const r = this.runs.get(tag); if (r) r.armed = true; },
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-grokkeep-'));
  const userHome = path.join(tmp, 'user');
  fs.mkdirSync(userHome);
  fs.writeFileSync(path.join(userHome, 'auth.json'), 'tok');
  const oldHome = process.env.GROK_HOME;
  process.env.GROK_HOME = userHome;
  let n = 0;
  const setup = ({ on = true, idleMs = 60000, maxProcs = 4, cancelWaitMs = 2000, watchdogMs = 0 } = {}) => {
    const fake = fakeGrok();
    const userData = path.join(tmp, `ud${++n}`);
    const engine = new gb.GrokBuildEngine({ userData, gate: async () => fakeGate, spawn: fake.spawn, kill: (c) => c.kill(), exec: () => {}, watchdogMs });
    engine.bin = process.execPath; // found (no lookup)
    const state = { on };
    engine.keepWarm = warmLib.createGrokWarm({ engine, enabled: () => state.on, idleMs: () => idleMs, maxProcs, cancelWaitMs, listedWaitMs: 50 });
    return { fake, engine, state, pool: engine.keepWarm };
  };
  const send = async (engine, { prompt = 'hi', sessionId = 'new-chat', resume = false, systemPrompt = 'SYS', model = 'default', images = [], fullAccess = false, effort = '', maxTurns = 0, signal = new AbortController().signal } = {}) => {
    const events = [];
    const t0 = Date.now();
    let ttft = null;
    const out = await engine.run({ prompt, images, sessionId, resume, systemPrompt, model, maxTurns, fullAccess, effort, signal, emit: (e) => { events.push(e); if (ttft === null && e.type === 'text') ttft = Date.now() - t0; } });
    return { out, events, ttft, ms: Date.now() - t0 };
  };

  try {
    // ---- off by default: exactly today's behaviour
    {
      const settings = require('../src/settings/settings-backend');
      const defaults = settings.DEFAULTS || settings.defaults || null;
      if (defaults) check('setting: Keep Grok Build connected is off by default', defaults.grokKeepConnected === false && defaults.grokKeepIdleMinutes === 15, JSON.stringify({ k: defaults.grokKeepConnected, i: defaults.grokKeepIdleMinutes }));
      const { fake, engine, pool } = setup({ on: false });
      const one = await send(engine);
      const two = await send(engine, { sessionId: one.out.sessionId, resume: true });
      check('off: each message is a headless grok, no agent process', fake.agents().length === 0 && fake.headless().length === 2 && two.out.text === 'cold reply', JSON.stringify(fake.spawned.map((r) => r.argv[0])));
      check('off: prewarm starts nothing', pool.prewarm({ sessionId: null, systemPrompt: 'SYS' }) === false && fake.spawned.length === 2 && pool.count() === 0);
    }

    // ---- on: one kept process per chat, timing against headless
    {
      const { fake, engine, pool } = setup();
      const one = await send(engine);
      check('on: the first message starts one `grok agent stdio` and answers through it', one.out.text === 'warm reply 1' && one.out.sessionId === 's-new-1' && fake.agents().length === 1 && fake.headless().length === 0, JSON.stringify(one.out));
      const rec = fake.agents()[0];
      check('on: argv is agent mode with Lumen\'s profile, never always-approve', rec.argv[0] === 'agent' && rec.argv[1] === '--agent-profile' && rec.argv.at(-1) === 'stdio' && !rec.argv.some((a) => /always-approve|bypass|dangerously/i.test(a)), JSON.stringify(rec.argv));
      check('on: the system prompt goes to initialize and session/new (as --system-prompt-override)', rec.initMeta?.systemPromptOverride === 'SYS' && rec.newMeta?.systemPromptOverride === 'SYS');
      check('on: Lumen\'s GROK_HOME, gate env and the feature switches are in the child\'s environment', rec.opts.env.GROK_HOME === engine.home && rec.opts.env.GROK_SUBAGENTS === '0' && rec.opts.env.GROK_MEMORY === '0' && /^m-/.test(rec.opts.env.LUMEN_MCP_TOKEN) && rec.opts.cwd === engine.dir && rec.opts.shell === false, JSON.stringify({ home: rec.opts.env.GROK_HOME, sub: rec.opts.env.GROK_SUBAGENTS }));
      const profile = fs.readFileSync(rec.argv[2], 'utf8');
      check('on: the agent profile removes Grok\'s built-ins (as --disallowed-tools) but not run_terminal_command', /disallowedTools:/.test(profile) && /- write\n/.test(profile) && /- spawn_subagent\n/.test(profile) && /- web_search\n/.test(profile) && !/run_terminal_command/.test(profile), profile);
      const two = await send(engine, { sessionId: one.out.sessionId, resume: true });
      const three = await send(engine, { sessionId: two.out.sessionId, resume: true });
      check('on: later messages reuse the same process (no new spawn), one session/prompt each', fake.spawned.length === 1 && rec.prompts.length === 3 && three.out.text === 'warm reply 3' && pool.stats.reused === 2, JSON.stringify(pool.stats));
      check('on: usage and cost come back in run()\'s shape', two.out.usage?.inputTokens === 40 && two.out.usage?.cacheReadTokens === 60 && Math.abs(two.out.cost - 0.002) < 1e-9 && two.out.usage?.contextTokens === 100, JSON.stringify(two.out.usage));

      // the same exchange, headless (the setting off)
      const cold = setup({ on: false });
      const c1 = await send(cold.engine);
      const c2 = await send(cold.engine, { sessionId: c1.out.sessionId, resume: true });
      console.log(`      time to first token, 2nd message: headless ${c2.ttft} ms (done ${c2.ms} ms), kept ${two.ttft} ms (done ${two.ms} ms); simulated start ${STARTUP_MS} ms + exit ${EXIT_MS} ms`);
      check('timing: a second message skips the start (first token well under the start cost; headless pays it)', two.ttft < STARTUP_MS / 3 && c2.ttft >= STARTUP_MS && two.ms < c2.ms, JSON.stringify({ warm: two.ttft, cold: c2.ttft }));

      // pre-warm: a new chat's first message
      const pre = setup();
      check('prewarm: starts the open chat\'s process before its message', pre.pool.prewarm({ sessionId: null, systemPrompt: 'SYS' }) === true && pre.pool.prewarm({ sessionId: null, systemPrompt: 'SYS' }) === false);
      await until(() => pre.fake.agents()[0]?.requests.some((m) => m.method === 'session/new'), 3000); await sleep(50);
      const p1 = await send(pre.engine);
      console.log(`      time to first token, first message: headless ${c1.ttft} ms, after pre-warm ${p1.ttft} ms`);
      check('prewarm: the first message takes the ready process (no spawn at send, first token well under the start cost)', pre.fake.spawned.length === 1 && p1.out.text === 'warm reply 1' && p1.ttft < STARTUP_MS / 3, JSON.stringify({ ttft: p1.ttft, spawned: pre.fake.spawned.length }));
      const pre2 = setup();
      pre2.pool.prewarm({ sessionId: null, systemPrompt: 'SYS' });
      const early = await send(pre2.engine); // sent while the pre-warm is still starting: it waits for it, no second process
      check('prewarm: a message sent while the pre-warm is starting waits for it (one process)', pre2.fake.spawned.length === 1 && early.out.text === 'warm reply 1', String(pre2.fake.spawned.length));
      const pre3 = setup();
      pre3.pool.prewarm({ sessionId: 'known-session', systemPrompt: 'SYS' });
      await until(() => pre3.fake.agents()[0]?.requests.some((m) => m.method === 'session/resume'), 3000); await sleep(50);
      const r3 = await send(pre3.engine, { sessionId: 'known-session', resume: true });
      check('prewarm: an existing chat\'s session is resumed ahead (session/resume) and then used', pre3.fake.spawned.length === 1 && pre3.fake.agents()[0].requests.some((m) => m.method === 'session/resume') && r3.out.sessionId === 'known-session' && r3.ttft < STARTUP_MS / 3, JSON.stringify(r3.out));
    }

    // ---- Grok Build's own Auto (docs/auto-model.md): the model changes from one message to the next. A kept process serves a chat's
    // session only for the model that session runs; the model asked for is always the one the process is set to before the turn.
    {
      const { fake, engine } = setup();
      const a = await send(engine, { model: 'grok-4.7-build-fast' });
      const rec = fake.agents()[0];
      check('auto: a first message on the fast model sets the kept process to it (set_model, never "auto")', rec.model === 'grok-4.7-build-fast' && a.out.text === 'warm reply 1', String(rec.model));
      const b = await send(engine, { sessionId: a.out.sessionId, resume: true, model: 'grok-4.7' });
      check('auto: the next message on another model: the same chat\'s process is set to that model before the turn', fake.spawned.length === 1 && rec.model === 'grok-4.7' && rec.requests.filter((m) => m.method === 'session/set_model').length === 2 && b.out.text === 'warm reply 2', JSON.stringify({ model: rec.model, spawned: fake.spawned.length }));
      // The agent starts a new session when the model changes (a Grok session stays on its model): that is a new chat's process, never the old session's.
      const c = await send(engine, { sessionId: 'auto-new-session', resume: false, model: 'grok-4.7-build-fast' });
      const recs = fake.agents();
      check('auto: a new session for the model Auto chose is not served by the process of the old one', recs.length === 2 && recs[1].model === 'grok-4.7-build-fast' && recs[1].session !== rec.session && recs[0].prompts.length === 2 && c.out.sessionId === recs[1].session, JSON.stringify({ n: recs.length, models: recs.map((r) => r.model) }));
      check('auto: no request ever named a model "auto"', fake.agents().every((r) => r.requests.every((m) => !(m.method === 'session/set_model' && m.params?.modelId === 'auto'))));
    }

    // ---- two chats never share a process
    {
      const { fake, engine } = setup();
      const a = await send(engine);
      const b = await send(engine);
      await send(engine, { sessionId: a.out.sessionId, resume: true, prompt: 'to A' });
      await send(engine, { sessionId: b.out.sessionId, resume: true, prompt: 'to B' });
      const [pa, pb] = fake.agents();
      check('chats: two chats get two processes, each only ever gets its own chat\'s messages', fake.agents().length === 2 && a.out.sessionId !== b.out.sessionId && pa.prompts.join() === 'hi,to A' && pb.prompts.join() === 'hi,to B', JSON.stringify([pa?.prompts, pb?.prompts]));
    }

    // ---- Stop / Send now: cancel the turn, keep the process
    {
      const { fake, engine, pool } = setup();
      const first = await send(engine);
      fake.script.prompt = (rec, p, end, update) => {
        const mine = rec.turn;
        const t = setInterval(() => { if (rec.turn !== mine || mine.cancelled) { clearInterval(t); return; } update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } }); }, 10);
      };
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 60);
      const stopped = await send(engine, { sessionId: first.out.sessionId, resume: true, signal: ac.signal });
      const rec = fake.agents()[0];
      check('stop: the turn is cancelled (session/cancel), the reply so far is kept, the process stays', stopped.out.stopped === true && /x/.test(stopped.out.text) && rec.notes.some((m) => m.method === 'session/cancel') && !rec.killed && pool.count() === 1, JSON.stringify({ out: stopped.out, killed: rec.killed }));
      fake.script.prompt = null;
      const after = await send(engine, { sessionId: first.out.sessionId, resume: true });
      check('stop: the next message reuses the same process', fake.spawned.length === 1 && after.out.text === 'warm reply 3', JSON.stringify(after.out));

      const stuck = setup({ cancelWaitMs: 80 });
      const s1 = await send(stuck.engine);
      stuck.fake.script.prompt = () => {}; // never answers
      stuck.fake.script.ignoreCancel = true;
      const ac2 = new AbortController();
      setTimeout(() => ac2.abort(), 30);
      const s2 = await send(stuck.engine, { sessionId: s1.out.sessionId, resume: true, signal: ac2.signal });
      check('stop: a process that ignores the cancel is killed after the wait', s2.out.stopped === true && stuck.fake.agents()[0].killed === true && stuck.pool.count() === 0, JSON.stringify(s2.out));
      stuck.fake.script.prompt = null;
      stuck.fake.script.ignoreCancel = false;
      const s3 = await send(stuck.engine, { sessionId: s1.out.sessionId, resume: true });
      check('stop: ...and the chat\'s next message starts a new one on the same session', stuck.fake.agents().length === 2 && s3.out.sessionId === s1.out.sessionId && s3.out.text === 'warm reply 1', JSON.stringify(s3.out));
    }

    // ---- Lumen's checks
    {
      const { fake, engine } = setup();
      const first = await send(engine);
      const rec = fake.agents()[0];
      // a tool the gate refused (reported, then failed): the turn goes on
      fake.script.prompt = (r, p, end, update) => {
        update({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'write', rawInput: { file_path: 'x' }, _meta: { 'x.ai/tool': { name: 'write' } } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed' });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'could not' } });
        setImmediate(() => end({ stopReason: 'end_turn', _meta: {} }));
      };
      const denied = await send(engine, { sessionId: first.out.sessionId, resume: true });
      check('checks: a refused non-Lumen tool (failed) doesn\'t end the message or the process', denied.out.text === 'could not' && !denied.out.failed && !rec.killed, JSON.stringify(denied.out));
      // permission requests: Lumen's tools allowed once, anything else rejected
      fake.script.prompt = async (r, p, end) => {
        const opts = [{ optionId: 'a1', kind: 'allow_once' }, { optionId: 'a2', kind: 'allow_always' }, { optionId: 'r1', kind: 'reject_once' }];
        const w = await r.ask('session/request_permission', { sessionId: p.sessionId, toolCall: { toolCallId: 'w', title: 'write', _meta: { 'x.ai/tool': { name: 'write' } } }, options: opts });
        const u = await r.ask('session/request_permission', { sessionId: p.sessionId, toolCall: { toolCallId: 'u', title: 'use_tool', rawInput: { tool_name: 'lumen__read_page', tool_input: {} }, _meta: { 'x.ai/tool': { name: 'use_tool' } } }, options: opts });
        const o = await r.ask('session/request_permission', { sessionId: p.sessionId, toolCall: { toolCallId: 'o', title: 'use_tool', rawInput: { tool_name: 'other__ping' }, _meta: { 'x.ai/tool': { name: 'use_tool' } } }, options: opts });
        const t = await r.ask('session/request_permission', { sessionId: p.sessionId, toolCall: { toolCallId: 't', title: 'run_terminal_command', _meta: { 'x.ai/tool': { name: 'run_terminal_command' } } }, options: opts });
        const x = await r.ask('session/request_permission', { sessionId: p.sessionId, toolCall: { toolCallId: 'x' }, options: opts });
        r.permission = [w, u, o, t, x].map((m) => m.result?.outcome?.optionId || m.result?.outcome?.outcome);
        end({ stopReason: 'end_turn', _meta: {} });
      };
      await send(engine, { sessionId: first.out.sessionId, resume: true });
      check('checks: permission requests: write rejected, lumen__ via use_tool allowed once, another server rejected, terminal allowed once (the gate asked), unknown rejected', JSON.stringify(rec.permission) === JSON.stringify(['r1', 'a1', 'r1', 'a1', 'r1']), JSON.stringify(rec.permission));
      // the gate is re-armed every message
      const armedBefore = [];
      fake.script.prompt = (r, p, end, update) => { armedBefore.push(true); update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }); setImmediate(() => end({ stopReason: 'end_turn', _meta: {} })); };
      fake.script.noArm = true;
      const unguarded = await send(engine, { sessionId: first.out.sessionId, resume: true });
      check('checks: a message whose UserPromptSubmit the gate never saw is stopped before its output (process killed)', unguarded.out.failed === true && unguarded.out.sessionId === null && rec.killed === true && !unguarded.events.some((e) => e.type === 'text'), JSON.stringify(unguarded.out));
      fake.script.noArm = false;
      // a non-Lumen tool that ran: killed
      const two = setup();
      const t1 = await send(two.engine);
      two.fake.script.prompt = (r, p, end, update) => {
        update({ sessionUpdate: 'tool_call', toolCallId: 'c9', title: 'run', rawInput: {}, _meta: { 'x.ai/tool': { name: 'image_gen' } } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'c9', status: 'completed' });
      };
      const ran = await send(two.engine, { sessionId: t1.out.sessionId, resume: true });
      check('checks: a tool that isn\'t Lumen\'s reported completed ends the message and kills the process; the session is dropped', ran.out.failed === true && ran.out.sessionId === null && two.fake.agents()[0].killed === true && ran.events.some((e) => e.type === 'error' && /image_gen/.test(e.text)), JSON.stringify(ran.out));
      // the turn cap
      const three = setup();
      const c1 = await send(three.engine);
      three.fake.script.prompt = (r, p, end, update) => { for (let i = 0; i < 3; i++) update({ sessionUpdate: 'tool_call', toolCallId: `t${i}`, title: 'search_tool', rawInput: {}, _meta: { 'x.ai/tool': { name: 'search_tool' } } }); };
      const capped = await send(three.engine, { sessionId: c1.out.sessionId, resume: true, maxTurns: 2 });
      check('checks: past Max steps the turn is cancelled and ends in the "continue" notice (limit), the process stays', capped.out.limit === true && three.fake.agents()[0].notes.some((m) => m.method === 'session/cancel') && three.pool.count() === 1, JSON.stringify(capped.out));
      // the watchdog
      const four = setup({ watchdogMs: 80 });
      const w1 = await send(four.engine);
      four.fake.script.prompt = () => {};
      const hung = await send(four.engine, { sessionId: w1.out.sessionId, resume: true });
      check('checks: a turn silent past the watchdog is ended (process killed)', hung.out.failed === true && four.fake.agents()[0].killed === true && hung.events.some((e) => e.type === 'error' && /stopped responding/.test(e.text)), JSON.stringify(hung.out));
    }

    // ---- headless fallbacks
    {
      const { fake, engine } = setup();
      const first = await send(engine);
      const img = await send(engine, { sessionId: first.out.sessionId, resume: true, images: [{ data: 'aGk=', media_type: 'image/png' }] });
      check('fallback: a message with images goes headless, and the kept process (stale after it) is ended', img.out.text === 'cold reply' && fake.headless().length === 1 && await until(() => fake.agents()[0].ended || fake.agents()[0].killed), JSON.stringify(img.out));
      const unknown = await send(engine, { sessionId: 'gone-session', resume: true });
      check('fallback: a session Grok doesn\'t know (resume fails before anything is sent) goes headless', unknown.out.text === 'cold reply' && fake.headless().length === 2, JSON.stringify(unknown.out));
      const prompt2 = setup();
      const q1 = await send(prompt2.engine, { systemPrompt: 'A' });
      await send(prompt2.engine, { sessionId: q1.out.sessionId, resume: true, systemPrompt: 'B' });
      check('fallback: a changed system prompt ends the chat\'s process and resumes the session in a new one', prompt2.fake.agents().length === 2 && prompt2.fake.agents()[1].initMeta?.systemPromptOverride === 'B' && prompt2.fake.agents()[1].requests.some((m) => m.method === 'session/resume' && m.params.sessionId === q1.out.sessionId), JSON.stringify(prompt2.fake.agents().map((r) => r.initMeta)));
    }

    // ---- full access and effort: a kept process of their own kind
    {
      const { fake, engine, pool } = setup();
      const a1 = await send(engine, { fullAccess: true, systemPrompt: 'SYS-FULL' });
      const a2 = await send(engine, { sessionId: a1.out.sessionId, resume: true, fullAccess: true, systemPrompt: 'SYS-FULL' });
      const rec = fake.agents()[0];
      check('full access: answered by a kept process (no headless run), the second message reuses it', a1.out.text === 'warm reply 1' && a2.out.text === 'warm reply 2' && fake.agents().length === 1 && fake.headless().length === 0, JSON.stringify(fake.spawned.map((r) => r.argv)));
      check('full access: argv has --always-approve and no agent profile; its gate run is a full-access one', rec.argv.includes('--always-approve') && !rec.argv.includes('--agent-profile') && rec.argv.at(-1) === 'stdio' && fakeGate.lastOpen.opts.fullAccess === true, JSON.stringify(rec.argv));
      check('full access: Lumen\'s empty folder (not the home folder) is the working folder (spawn and session), the whole environment is passed', rec.opts.cwd === engine.dir && rec.requests.find((m) => m.method === 'session/new').params.cwd === engine.dir && rec.opts.env.HOME === os.homedir() && 'PATH' in rec.opts.env, JSON.stringify({ cwd: rec.opts.cwd, home: rec.opts.env.HOME }));
      check('full access: config.toml (written for it) has no deny rules', !/^deny = /m.test(fs.readFileSync(path.join(engine.home, 'config.toml'), 'utf8')));
      // toggling off: the full-access process is never reused for a locked-down message
      const l1 = await send(engine, { sessionId: a1.out.sessionId, resume: true, systemPrompt: 'SYS-FULL' });
      const lock = fake.agents()[1];
      check('toggle: turning full access off ends the full-access process and resumes the session in a locked-down one', l1.out.text === 'warm reply 1' && fake.agents().length === 2 && await until(() => rec.ended || rec.killed) && lock.argv.includes('--agent-profile') && !lock.argv.includes('--always-approve') && lock.opts.cwd === engine.dir && lock.requests.some((m) => m.method === 'session/resume' && m.params.sessionId === a1.out.sessionId) && fakeGate.lastOpen.opts.fullAccess !== true, JSON.stringify(fake.agents().map((r) => r.argv)));
      check('toggle: the locked-down config.toml is back', /^deny = /m.test(fs.readFileSync(path.join(engine.home, 'config.toml'), 'utf8')));
      const f2 = await send(engine, { sessionId: a1.out.sessionId, resume: true, fullAccess: true, systemPrompt: 'SYS-FULL' });
      check('toggle: turning it back on replaces the locked-down process with a full-access one', f2.out.text === 'warm reply 1' && fake.agents().length === 3 && fake.agents()[2].argv.includes('--always-approve') && await until(() => lock.ended || lock.killed) && pool.count() === 1);
      // tools: Grok's own tools run with full access (no stream check), a locked-down process is still stopped by it
      const tools = setup();
      const t1 = await send(tools.engine, { fullAccess: true });
      tools.fake.script.prompt = (rec2, p, end, update) => {
        update({ sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'run_terminal_command', status: 'in_progress', rawInput: { command: 'ls' } });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'listed' } });
        setImmediate(() => end({ stopReason: 'end_turn', _meta: {} }));
      };
      const t2 = await send(tools.engine, { sessionId: t1.out.sessionId, resume: true, fullAccess: true });
      const ask = await tools.fake.agents()[0].ask('session/request_permission', { toolCall: { toolCallId: 'x', title: 'write', rawInput: {} }, options: [{ optionId: 'ok', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] });
      check('full access: Grok\'s own tools may run and are allowed, no stream-check stop', t2.out.text === 'listed' && !t2.out.failed && !tools.fake.agents()[0].killed && ask.result?.outcome?.optionId === 'ok', JSON.stringify({ out: t2.out, ask }));
      const locked = setup();
      const k1 = await send(locked.engine);
      const kask = await locked.fake.agents()[0].ask('session/request_permission', { toolCall: { toolCallId: 'x', title: 'write', rawInput: {} }, options: [{ optionId: 'ok', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] });
      check('locked down: the same request is still rejected', k1.out.text === 'warm reply 1' && kask.result?.outcome?.optionId === 'no', JSON.stringify(kask));
      // effort: a flag of the process, its own kind
      const eff = setup();
      const e1 = await send(eff.engine, { effort: 'high' });
      const e2 = await send(eff.engine, { sessionId: e1.out.sessionId, resume: true, effort: 'high' });
      const er = eff.fake.agents()[0];
      check('effort: a chosen effort is passed to the kept process (--reasoning-effort) and the process is reused', e2.out.text === 'warm reply 2' && eff.fake.agents().length === 1 && eff.fake.headless().length === 0 && er.argv.join(' ') === `agent --agent-profile ${er.argv[2]} --reasoning-effort high stdio`, JSON.stringify(er.argv));
      const e3 = await send(eff.engine, { sessionId: e1.out.sessionId, resume: true, effort: 'low' });
      check('effort: a changed effort replaces the process (resumed session), as does going back to the default', e3.out.text === 'warm reply 1' && eff.fake.agents().length === 2 && eff.fake.agents()[1].argv.includes('low') && await until(() => er.ended || er.killed));
      const e4 = await send(eff.engine, { sessionId: e1.out.sessionId, resume: true });
      check('effort: none chosen means no flag', eff.fake.agents().length === 3 && !eff.fake.agents()[2].argv.includes('--reasoning-effort') && e4.out.text === 'warm reply 1');
      // prewarm of each kind, and a spare of the wrong kind is not taken
      const pre = setup();
      check('prewarm: a full-access spare starts as one', pre.pool.prewarm({ sessionId: null, systemPrompt: 'SYS-FULL', fullAccess: true }) === true && await until(() => pre.fake.agents().length === 1 && pre.pool.count() === 1 && pre.fake.agents()[0].session) && pre.fake.agents()[0].argv.includes('--always-approve'));
      check('prewarm: a locked-down spare is a separate one (not satisfied by the full-access spare)', pre.pool.prewarm({ sessionId: null, systemPrompt: 'SYS-FULL' }) === true && await until(() => pre.fake.agents().length === 2));
      const p1 = await send(pre.engine, { fullAccess: true, systemPrompt: 'SYS-FULL' });
      check('prewarm: the first full-access message takes the full-access spare (no new process, first token before a cold start)', p1.out.text === 'warm reply 1' && pre.fake.agents().length === 2 && pre.fake.headless().length === 0 && p1.ttft < STARTUP_MS, JSON.stringify({ ttft: p1.ttft, n: pre.fake.agents().length }));
      check('prewarm: the same spec again starts nothing', pre.pool.prewarm({ sessionId: null, systemPrompt: 'SYS-FULL' }) === false);
    }

    // ---- lifetime: idle timeout, cap, drop, setting off
    {
      const idle = setup({ idleMs: 60 });
      await send(idle.engine);
      check('lifetime: an idle process ends after the idle time (stdin closed: it flushes and exits)', await until(() => idle.fake.agents()[0].ended, 1500) && idle.pool.count() === 0);
      const never = setup({ idleMs: 0 });
      await send(never.engine);
      await sleep(120);
      check('lifetime: idle time "never" keeps it', never.pool.count() === 1 && !never.fake.agents()[0].ended);
      const cap = setup({ maxProcs: 2 });
      const a = await send(cap.engine);
      await send(cap.engine);
      await send(cap.engine);
      check('lifetime: past the cap the least recently used idle process ends', cap.pool.count() === 2 && await until(() => cap.fake.agents()[0].ended) && !cap.fake.agents()[2].ended, JSON.stringify(cap.fake.agents().map((r) => r.ended)));
      const again = await send(cap.engine, { sessionId: a.out.sessionId, resume: true });
      check('lifetime: ...and that chat\'s next message resumes its session in a new process', again.out.sessionId === a.out.sessionId && cap.fake.agents().length === 4);
      const d = setup();
      const d1 = await send(d.engine);
      d.pool.drop(d1.out.sessionId);
      check('lifetime: drop(session) (tab closed, chat deleted) ends that chat\'s process', d.pool.count() === 0 && await until(() => d.fake.agents()[0].ended));
      const off = setup();
      const o1 = await send(off.engine);
      off.state.on = false;
      const o2 = await send(off.engine, { sessionId: o1.out.sessionId, resume: true });
      check('lifetime: turning the setting off ends kept processes; the message goes headless', o2.out.text === 'cold reply' && off.pool.count() === 0 && await until(() => off.fake.agents()[0].ended), JSON.stringify(o2.out));
      const quit = setup();
      await send(quit.engine);
      quit.pool.prewarm({ sessionId: null, systemPrompt: 'SYS' });
      await sleep(10);
      quit.pool.disposeAll({ now: true });
      check('lifetime: quitting kills every kept process and any start in flight', await until(() => quit.fake.agents().every((r) => r.killed) && quit.pool.count() === 0), JSON.stringify(quit.fake.agents().map((r) => r.killed)));
    }

    // ---- parallel CLI chats: per-process MCP tag ownership and per-run scope, the sign-in lock, chat-history retry
    {
      const { fake, engine, pool } = setup();
      const tagOf = (rec) => String(rec.opts.env.LUMEN_MCP_TOKEN || '').replace(/^m-/, '');
      // a message's own engine (ai-agents.js leaseEngine) shares the pool
      const side = new gb.GrokBuildEngine({ userData: engine.userData, gate: engine.gate, spawn: fake.spawn, kill: (c) => c.kill(), exec: () => {}, watchdogMs: 0 });
      side.bin = engine.bin;
      side.keepWarm = pool;
      const a1 = await send(engine);
      const b1 = await send(side);
      const [pa, pb] = fake.agents();
      check('parallel: each kept process has its own MCP tag, owned by the pool between turns with no turn in progress', pool.owner(tagOf(pa)) && pool.owner(tagOf(pb)) && pool.owner(tagOf(pa)) !== pool.owner(tagOf(pb)) && pool.owner(tagOf(pa)).active === null && pool.owner('x'.repeat(36)) === null && !engine.owns(tagOf(pa)), JSON.stringify([tagOf(pa), tagOf(pb)]));
      check('sign-in lock: each kept process holds the sign-in while it lives', gb.authStats(engine.home).runs === 2, JSON.stringify(gb.authStats(engine.home)));
      // two chats' turns at once: each process's active turn carries its own message's scope
      const seen = {};
      fake.script.prompt = (rec, p, end, update) => {
        const o = pool.owner(tagOf(rec));
        seen[rec.session] = o?.active?.scope?.chatId;
        setTimeout(() => { update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }); end({ stopReason: 'end_turn', _meta: {} }); }, 40);
      };
      const go = (eng, sessionId, chatId) => eng.run({ prompt: 'p', images: [], sessionId, resume: true, systemPrompt: 'SYS', model: 'default', maxTurns: 0, signal: new AbortController().signal, emit: () => {}, scope: { chatId } });
      const [ra, rb] = await Promise.all([go(engine, a1.out.sessionId, 'chat-A'), go(side, b1.out.sessionId, 'chat-B')]);
      check('parallel: two chats\' turns run at once, each tool-call owner carrying its own chat\'s scope', ra.text === 'ok' && rb.text === 'ok' && seen[a1.out.sessionId] === 'chat-A' && seen[b1.out.sessionId] === 'chat-B' && fake.agents().length === 2, JSON.stringify(seen));
      check('parallel: the turn is cleared from the owner after it ends', pool.owner(tagOf(pa)).active === null && pool.owner(tagOf(pb)).active === null);
      // chat history: a resumed session Grok lost mid-life comes back { expired } quietly (agent.js retries with a handoff)
      fake.script.prompt = (rec, p, end) => { rec.turn = null; rec.exit(1); };
      pa.child.stderr.write('Error: Path not found.\n');
      const events = [];
      const gone = await engine.run({ prompt: 'p', images: [], sessionId: a1.out.sessionId, resume: true, quietExpired: true, systemPrompt: 'SYS', model: 'default', maxTurns: 0, signal: new AbortController().signal, emit: (e) => events.push(e) });
      check('chat history: quietExpired: a resumed session Grok no longer has comes back expired, no error shown', gone.expired === true && gone.sessionId === null && !events.some((e) => e.type === 'error'), JSON.stringify({ gone, events }));
      fake.script.prompt = null;
      pool.disposeAll({ now: true });
      check('sign-in lock: released when the kept processes end', await until(() => gb.authStats(engine.home).runs === 0), JSON.stringify(gb.authStats(engine.home)));
    }

    // ---- pure helpers
    {
      const r = warmLib.resultOf({ modelId: 'grok-4.7', usage: { inputTokens: 1000, cachedReadTokens: 800, outputTokens: 7, modelCalls: 2, costUsdTicks: 1e8 } });
      check('resultOf: Anthropic-style usage (input excludes cache reads), cost from ticks, no last call for a multi-call turn', r.result.usage.input_tokens === 200 && r.result.usage.cache_read_input_tokens === 800 && r.result.total_cost_usd === 0.01 && r.lastCall === null && Object.keys(r.result.modelUsage).join() === 'grok-4.7', JSON.stringify(r));
      const ans = warmLib.permissionAnswer(gb, { toolCall: { toolCallId: 'k' }, options: [{ optionId: 'a', kind: 'allow_once' }] }, new Map([['k', { name: 'lumen__click', input: {} }]]));
      check('permissionAnswer: a request naming only the id uses the turn\'s earlier tool_call; no reject option: cancelled', ans.outcome.optionId === 'a' && warmLib.permissionAnswer(gb, { toolCall: { title: 'write' }, options: [{ optionId: 'a', kind: 'allow_once' }] }).outcome.outcome === 'cancelled');
    }

    // ---- mcp-http: per-message re-arm and the chat a kept run serves
    {
      const gate = await startHttp({ tools: [{ name: 'ping', description: 'p', input_schema: { type: 'object', properties: {} } }], callTool: async () => ({ content: [], isError: false }) });
      const run = gate.open('t'.repeat(36), null);
      const hook = (event) => fetch(run.hookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hook_event_name: event }) });
      gate.rearm('t'.repeat(36));
      const before = gate.armed('t'.repeat(36));
      await (await hook('UserPromptSubmit')).text().catch(() => {});
      const after = gate.armed('t'.repeat(36));
      gate.rearm('t'.repeat(36));
      check('mcp-http: rearm() clears the run\'s armed flag until its next UserPromptSubmit', before === false && after === true && gate.armed('t'.repeat(36)) === false);
      gate.close('t'.repeat(36));
      gate.stop();
    }
  } finally {
    if (oldHome === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = oldHome;
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
    console.log(failures ? `\n${failures} FAILED` : '\nall passed');
    process.exitCode = failures ? 1 : 0;
    setTimeout(() => process.exit(process.exitCode), 50).unref();
  }
})();
