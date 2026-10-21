// The Codex engine's context meter (src/ai/codex-usage.js contextOf / threadStats / turnDelta, codex.js, codex-warm.js, agent.js codexTurn,
// features/chat-usage.js), plain Node: no Codex, no network, no Electron. Every Codex event here is a recorded-shape fixture:
//  - `codex exec --json` prints turn.completed.usage = the THREAD's cumulative total (not one turn's);
//  - the session log (<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl) has token_count events with total_token_usage
//    (cumulative), last_token_usage (the last model call: the context in use) and model_context_window, turn_context lines naming the
//    model, and `compacted` lines when Codex compacts.
// Covers: multi-turn cumulative totals, cached input, resume, compaction, a model switch, a missing usage event, the window, the tooltip's
// model name, the live (during-the-reply) figure, and the Usage log getting a per-turn figure instead of a running sum.
require('../helpers/_tmp-cleanup');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const J = (v) => JSON.stringify(v);

const cu = require('../../src/ai/codex-usage');
const CU = require('../../src/features/chat-usage');
const cx = require('../../src/ai/codex');
const { Agent } = require('../../src/ai/agent');

const TID = '0199aaaa-bbbb-cccc-dddd-eeeeffff0007';
const usage = (input, cached, output, reasoning = 0) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output });
// A token_count event_msg line of a rollout.
const tcLine = (ts, total, last, window = 258400) => J({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: window }, rate_limits: null } });
const ctxLine = (ts, model) => J({ timestamp: ts, type: 'turn_context', payload: { model, cwd: 'C:\\secret\\project', approval_policy: 'never' } });
const compactLine = (ts, summary) => J({ timestamp: ts, type: 'compacted', payload: { message: summary } });
const T0 = '2026-10-19T10:00:00.000Z';
const tsAt = (n) => new Date(Date.parse(T0) + n * 1000).toISOString();

function rolloutIn(home, lines, id = TID) {
  const dir = path.join(home, 'sessions', '2026', '10', '19');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-19T10-00-00-${id}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cxctx-'));

// ---------- pure figures ----------
{
  const t = cu.tokensOf(usage(21000, 20000, 600, 100));
  check('fill: input (fresh + cached) + output - reasoning', cu.contextFill(t) === 21000 + 600 - 100, cu.contextFill(t));
  check('fill: cached input is part of the input, counted once', cu.contextFill(cu.tokensOf(usage(1000, 1000, 0))) === 1000);
  check('fill: bad data (more reasoning than output) never goes below the input', cu.contextFill(cu.tokensOf(usage(500, 0, 10, 99))) === 500);
  check('fill: nothing in, nothing out', cu.contextFill(null) === 0 && cu.contextFill({}) === 0);
  const a = cu.tokensOf(usage(10000, 0, 500, 50));
  const b = cu.tokensOf(usage(31000, 10000, 1100, 120));
  const d = cu.turnDelta(b, a);
  check('delta: a cumulative total minus the last one is the turn', d.inputTokens === (31000 - 10000) - 10000 && d.cacheReadTokens === 10000 && d.outputTokens === 600 && d.reasoningTokens === 70, J(d));
  check('delta: no baseline (a new thread) is the whole total', J(cu.turnDelta(a, null)) === J(a));
  check('delta: a total that went down (a new thread under the same id, a history rewrite) is the whole total', J(cu.turnDelta(a, b)) === J(a));
  check('delta: no total, no figure', cu.turnDelta(null, a) === null);
  const app = cu.fromAppServerUsage({ inputTokens: 900, cachedInputTokens: 400, outputTokens: 50, reasoningOutputTokens: 5 });
  check('app-server: camelCase usage reads like exec\'s (cached split from the input)', app.inputTokens === 500 && app.cacheReadTokens === 400 && app.outputTokens === 50 && app.reasoningTokens === 5, J(app));
}

// ---------- the rollout: last call vs cumulative ----------
{
  const home = tmpHome();
  // Turn 1: two model calls (a tool loop). Turn 2 (resumed): one call, the whole earlier context sent again (mostly cached).
  const file = rolloutIn(home, [
    ctxLine(tsAt(0), 'gpt-6-astra'),
    tcLine(tsAt(1), usage(8000, 0, 300, 100), usage(8000, 0, 300, 100)),
    tcLine(tsAt(2), usage(8000 + 8500, 8000, 300 + 200, 100 + 50), usage(8500, 8000, 200, 50)),
    ctxLine(tsAt(60), 'gpt-6-astra'),
    tcLine(tsAt(61), usage(8000 + 8500 + 9400, 8000 + 8400, 300 + 200 + 450, 150 + 30), usage(9400, 8400, 450, 30)),
  ]);
  check('rollout: found by thread id, however deep the day folders', cu.findRollout(home, TID) === file && cu.findRollout(home, 'nope-nope-nope') === null && cu.findRollout(home, '../x') === null);
  const st = cu.threadStats(file);
  check('rollout: the last call and the cumulative total are told apart', st.last.inputTokens + st.last.cacheReadTokens === 9400 && st.total.inputTokens + st.total.cacheReadTokens === 25900, J(st));
  check('rollout: the window is the model\'s own, as Codex reports it (not 1M, not another provider\'s)', st.window === 258400, st.window);
  check('rollout: the model that answered is the turn_context\'s slug (and no other field of that line is kept)', st.model === 'gpt-6-astra' && !JSON.stringify(st).includes('secret'), J(st));
  const ctx = cu.contextOf(st, { startedAt: Date.parse(tsAt(60)) });
  check('context: the last call\'s input + output - reasoning (9400 + 450 - 30), NOT the cumulative sum (26k+)', ctx.tokens === 9820 && !ctx.estimated && !ctx.compacted, J(ctx));
  check('context: the cumulative total rides along for the usage log', ctx.total.outputTokens === 950, J(ctx.total));
  // The summed total would show 26,350 / 258,400 = 10%; the real fill is 3.8%.
  const view = CU.contextView({ tokens: ctx.tokens, window: ctx.window });
  check('meter: percent is of the reported window', Math.round(view.percent * 10) === 38, view.percent);
  fs.rmSync(home, { recursive: true, force: true });
}

// ---------- compaction, no usage ----------
{
  const home = tmpHome();
  const file = rolloutIn(home, [
    ctxLine(tsAt(0), 'gpt-6-luna'),
    tcLine(tsAt(1), usage(200000, 150000, 4000), usage(200000, 150000, 4000), 258400),
    compactLine(tsAt(5), 'x'.repeat(8000)),
    tcLine(tsAt(6), usage(212000, 150000, 4300), usage(12000, 0, 300), 258400),
  ]);
  let st = cu.threadStats(file);
  let ctx = cu.contextOf(st, { startedAt: Date.parse(tsAt(2)) });
  check('compaction: the next call after it measures the shrunken context (the meter drops)', ctx.tokens === 12300 && ctx.compacted === true && !ctx.estimated && st.afterCall === false, J(ctx));
  ctx = cu.contextOf(st, { startedAt: Date.parse(tsAt(20)) });
  check('compaction: one from before this turn is not announced again', ctx.compacted === false, J(ctx));
  // A compaction with no model call after it (a standalone compact): the figure is an estimate of what replaced the context.
  const file2 = rolloutIn(home, [tcLine(tsAt(1), usage(200000, 0, 4000), usage(200000, 0, 4000)), compactLine(tsAt(5), 'y'.repeat(12000))], 'other-thread-0001');
  st = cu.threadStats(file2);
  ctx = cu.contextOf(st, { startedAt: 0 });
  check('compaction: with no model call since, the meter shows the size of what replaced the context, marked an estimate', st.afterCall === true && ctx.estimated === true && ctx.tokens > 2900 && ctx.tokens < 4000 && ctx.compacted, J(ctx));
  const file3 = rolloutIn(home, [J({ timestamp: tsAt(0), type: 'session_meta', payload: { id: 'x' } }), ctxLine(tsAt(1), 'gpt-6-luna')], 'third-thread-0003');
  check('no usage yet: no figure (the caller estimates), never 0 or NaN', cu.contextOf(cu.threadStats(file3)) === null);
  check('no log at all: no figure', cu.threadStats(path.join(home, 'missing.jsonl')) === null && cu.contextOf(null) === null);
  const cut = path.join(home, 'cut.jsonl');
  fs.writeFileSync(cut, `${'z'.repeat(300 * 1024)}\n${tcLine(tsAt(1), usage(50, 0, 5), usage(50, 0, 5))}\n{"type":"event_msg","payload":{"type":"token_cou`);
  check('log: a long file is read from its tail, a half-written last line is skipped', cu.threadStats(cut)?.last?.inputTokens === 50);
  fs.rmSync(home, { recursive: true, force: true });
}

// ---------- the window and the tooltip ----------
{
  check('window: Codex\'s own figure wins over every table', CU.windowFor('codex:gpt-6-astra', 258400) === 258400 && CU.windowFor('codex:default', 400000) === 400000);
  check('window: with none reported a Codex model is the engine\'s usual 272k, never 1M or another provider\'s', CU.windowFor('codex:gpt-6-astra') === 272000 && CU.windowFor('codex:gpt-6-astra[1m]') === 272000 && CU.windowFor('codex:default') === 272000);
  const s = {};
  CU.setContext(s, { tokens: 76000, window: 258400, model: 'codex:gpt-6-astra', name: 'GPT-6 Astra' });
  const v = CU.contextView(s.context);
  check('view: the model name and "compacts itself" ride along for the tooltip', v.model === 'GPT-6 Astra' && v.auto === true && v.window === 258400 && !v.estimated, J(v));
  const c = {};
  CU.setContext(c, { tokens: 5000, window: 200000, model: 'claudecode:sonnet' });
  check('view: other engines have neither', !('model' in CU.contextView(c.context)) && !('auto' in CU.contextView(c.context)));
}

// ---------- the engine against a fake child: live figures, the thread's figures at the end ----------
function fakeChild(onStart, lines) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 4243;
  child.exitCode = null;
  setImmediate(async () => {
    onStart?.();
    for (const l of lines) { child.stdout.write(`${typeof l === 'string' ? l : J(l)}\n`); await new Promise((r) => setTimeout(r, 5)); }
    setTimeout(() => { child.exitCode = 0; child.emit('close', 0); }, 10);
  });
  return child;
}
const gate = { open: () => ({ mcpUrl: 'http://127.0.0.1:9/mcp', mcpToken: 't' }), close() {} };
const spec = { found: true, command: process.execPath, args: [], path: process.execPath, kind: 'exe', version: '9.9.9' };

(async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cxctx-ud-'));
  const userHome = path.join(userData, 'user-codex');
  const tmp = path.join(userData, 'tmp');
  fs.mkdirSync(userHome, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(userHome, 'auth.json'), '{"fake":1}');

  // Two exec runs of one chat: the second resumes the thread. exec's turn.completed carries the thread's CUMULATIVE total each time.
  const runTurn = async (n, { prompt, resumeId, rollout, events }) => {
    const engine = new cx.CodexEngine({ userData, gate: async () => gate, locate: async () => spec, userHome: () => userHome, tmp, watchdogMs: 0, spawn: (bin, argv, o) => fakeChild(() => rollout(path.resolve(o.env.CODEX_HOME)), events), kill: () => {} });
    const emitted = [];
    const out = await engine.run({ prompt, sessionId: resumeId, systemPrompt: 'SYS', model: 'default', signal: new AbortController().signal, emit: (e) => emitted.push(e), scope: { chatId: 'chat-9' } });
    return { out, emitted };
  };
  const now = Date.now();
  const iso = (ms) => new Date(now + ms).toISOString();
  const ev1 = [{ type: 'thread.started', thread_id: TID }, { type: 'turn.started' }, { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'First.' } }, { type: 'turn.completed', usage: usage(16500, 8000, 500, 150) }];
  const t1 = await runTurn(1, { prompt: 'one', resumeId: null, events: ev1, rollout: (home) => rolloutIn(home, [ctxLine(iso(0), 'gpt-6-astra'), tcLine(iso(10), usage(8000, 0, 300, 100), usage(8000, 0, 300, 100)), tcLine(iso(20), usage(16500, 8000, 500, 150), usage(8500, 8000, 200, 50))]) });
  check('engine: the first turn reports the thread\'s figures (last call, window, model)', t1.out.thread?.tokens === 8500 + 200 - 50 + 0 && t1.out.thread.window === 258400 && t1.out.thread.slug === 'gpt-6-astra' && t1.out.usageIsTotal === true, J(t1.out.thread));
  check('engine: the figure is sent while the reply streams, not only at the end', t1.emitted.some((e) => e.type === 'codex_context' && e.tokens === 8650), J(t1.emitted.filter((e) => e.type === 'codex_context')));
  const ev2 = [{ type: 'thread.started', thread_id: TID }, { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: 'Second.' } }, { type: 'turn.completed', usage: usage(16500 + 9400, 8000 + 8400, 500 + 450, 150 + 30) }];
  const t2 = await runTurn(2, { prompt: 'two', resumeId: TID, events: ev2, rollout: (home) => { const f = cu.findRollout(home, TID); fs.appendFileSync(f, `${tcLine(iso(5000), usage(25900, 16400, 950, 180), usage(9400, 8400, 450, 30))}\n`); } });
  check('engine: the resumed turn\'s figure is its own last call (9,820), not the running sum', t2.out.thread?.tokens === 9820 && t2.out.thread.total.outputTokens === 950, J(t2.out.thread));
  check('engine: exec\'s own usage is cumulative and marked so (the agent takes the difference)', t2.out.usageIsTotal === true && t2.out.usage.outputTokens === 950, J(t2.out.usage));

  // ---------- the chat: agent.js codexTurn with these results ----------
  const mkAgent = (runs) => {
    const reports = [];
    const agent = Object.create(Agent.prototype);
    Object.assign(agent, {
      browser: { codexFullAccess: () => false, effort: () => '' },
      engineFor: () => ({ run: async (o) => { const r = runs.shift(); for (const e of r.live || []) o.emit(e); return typeof r.out === 'function' ? r.out(o) : r.out; } }),
      engineImages: () => [], enginePictures: async () => [], engineFiles: async () => [],
      reportUsage: (engine, data) => { reports.push({ engine, data }); return null; },
    });
    return { agent, reports };
  };
  const chat = (settings = {}) => { const m = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]; m.settings = { model: 'codex:default', ...settings }; return m; };
  const turn = async (agent, messages, text, signal = new AbortController().signal) => {
    messages.push({ role: 'user', content: [{ type: 'text', text }] });
    const events = [];
    await agent.codexTurn(messages, text, [], signal, (e) => events.push(e));
    return events;
  };
  const ctxOf = (events) => events.filter((e) => e.type === 'context').map((e) => e.context);
  const tot = (i, c, o, r) => cu.tokensOf(usage(i, c, o, r));

  {
    const { agent, reports } = mkAgent([
      { live: [{ type: 'codex_context', tokens: 8650, window: 258400, slug: 'gpt-6-astra', estimated: false }], out: { text: 'First.', sessionId: TID, usage: tot(16500, 8000, 500, 150), usageIsTotal: true, thread: { tokens: 8650, window: 258400, slug: 'gpt-6-astra', estimated: false, total: tot(16500, 8000, 500, 150), compacted: false } } },
      { out: { text: 'Second.', sessionId: TID, usage: tot(25900, 16400, 950, 180), usageIsTotal: true, thread: { tokens: 9820, window: 258400, slug: 'gpt-6-astra', estimated: false, total: tot(25900, 16400, 950, 180), compacted: false } } },
    ]);
    const m = chat();
    const e1 = await turn(agent, m, 'first question');
    const c1 = ctxOf(e1);
    check('chat: the meter shows an estimate at once (what is sent), then Codex\'s own figure while it streams, then the final one', c1.length >= 3 && c1[0].estimated === true && c1[1].tokens === 8650 && c1[c1.length - 1].tokens === 8650 && !c1[c1.length - 1].estimated, J(c1));
    check('chat: the window is Codex\'s reported 258,400 and the tooltip names the model that answered', c1[c1.length - 1].window === 258400 && c1[c1.length - 1].model === 'GPT-6 Astra' && c1[c1.length - 1].auto === true, J(c1[c1.length - 1]));
    check('chat: the usage log got the first turn whole, with the context figure (no running sum)', reports[0].data.usage.outputTokens === 500 && reports[0].data.usage.contextTokens === 8650 && reports[0].data.usage.contextWindow === 258400 && reports[0].data.model === 'gpt-6-astra', J(reports[0].data));
    const e2 = await turn(agent, m, 'second question');
    const c2 = ctxOf(e2);
    check('chat: a resumed turn starts from the figure it had, plus what was sent', c2[0].estimated === true && c2[0].tokens > 8650, J(c2[0]));
    check('chat: a resumed turn ends at its last call\'s fill (9,820 of 258,400), not the cumulative sum', c2[c2.length - 1].tokens === 9820 && !c2[c2.length - 1].estimated, J(c2[c2.length - 1]));
    const u2 = reports[1].data.usage;
    check('usage log: the second turn is the growth of the thread\'s total (not 25,900 input again)', u2.outputTokens === 450 && u2.cacheReadTokens === 8400 && u2.inputTokens === (25900 - 16400) - (16500 - 8000), J(u2));
    check('chat: the thread\'s running total is remembered with its id', m.settings.cxTotal?.id === TID && m.settings.context.tokens === 9820);

    // A model switch (agent.js drops cxSession): the new thread starts from nothing.
    delete m.settings.cxSession; delete m.settings.cxModel; m.settings.model = 'codex:gpt-6-luna';
    const { agent: a3, reports: r3 } = mkAgent([{ out: { text: 'On Luna.', sessionId: 'new-thread-0000001', usage: tot(5000, 0, 100, 0), usageIsTotal: true, thread: { tokens: 5100, window: 258400, slug: 'gpt-6-luna', estimated: false, total: tot(5000, 0, 100, 0), compacted: false } } }]);
    const e3 = await turn(a3, m, 'switch');
    const c3 = ctxOf(e3);
    check('model switch: the meter does not keep the old model\'s figure; the new thread\'s estimate is small, then its real one', c3[0].tokens < 3000 && c3[0].estimated && c3[c3.length - 1].tokens === 5100 && c3[c3.length - 1].model === 'GPT-6 Luna', J(c3));
    check('model switch: the old thread\'s total is not subtracted from the new thread\'s', r3[0].data.usage.outputTokens === 100 && r3[0].data.usage.inputTokens === 5000, J(r3[0].data.usage));
  }

  {
    // Compaction by Codex during a turn: the notice, and the meter drops.
    const { agent } = mkAgent([
      { out: { text: 'Big.', sessionId: TID, usage: tot(240000, 200000, 3000, 500), usageIsTotal: true, thread: { tokens: 243000, window: 258400, slug: 'gpt-6-astra', estimated: false, total: tot(240000, 200000, 3000, 500), compacted: false } } },
      { out: { text: 'After.', sessionId: TID, usage: tot(262000, 200000, 3400, 520), usageIsTotal: true, thread: { tokens: 14000, window: 258400, slug: 'gpt-6-astra', estimated: false, total: tot(262000, 200000, 3400, 520), compacted: true } } },
    ]);
    const m = chat();
    const e1 = await turn(agent, m, 'long');
    check('compaction: near full the meter shows it (94%), marked "compacts itself" for the tooltip', Math.round(ctxOf(e1).pop().percent) === 94 && ctxOf(e1).pop().auto === true);
    const e2 = await turn(agent, m, 'more');
    check('compaction: Codex compacting during the turn drops the meter and says so in the chat', ctxOf(e2).pop().tokens === 14000 && e2.some((e) => e.type === 'notice' && /Codex compacted this conversation/.test(e.text)), J(e2.filter((e) => e.type === 'notice')));
  }

  {
    // No usage event at all (the CLI died before turn.completed, or an old build): never 0 or stale, an estimate that grows.
    const { agent, reports } = mkAgent([
      { out: { text: 'x'.repeat(4000), sessionId: TID, usage: null, usageIsTotal: true, thread: null } },
      { out: { text: '', sessionId: null, failed: true, usage: null, thread: null } },
    ]);
    const m = chat();
    const e1 = await turn(agent, m, 'no usage here');
    const last = ctxOf(e1).pop();
    check('missing usage: the meter shows an estimate of what was sent and said (not 0, not nothing)', last.estimated === true && last.tokens >= 1000 && last.window === 272000, J(last));
    check('missing usage: nothing is logged as used', reports[0].data.usage === null || reports[0].data.usage === undefined || !reports[0].data.usage, J(reports[0].data));
    const before = m.settings.context.tokens;
    await turn(agent, m, 'again');
    check('missing usage + a failed turn: the earlier figure stays', m.settings.context.tokens >= before - 1 && Boolean(m.settings.context.window));
  }

  {
    // The app-server path (a kept process) reports per-turn sums as usage: no difference is taken, but the meter is still the last call.
    const { agent, reports } = mkAgent([{ out: { text: 'Warm.', sessionId: TID, usage: tot(9000, 4000, 300, 40), thread: { tokens: 9260, window: 258400, slug: null, estimated: false, total: tot(40000, 20000, 1500, 200), compacted: false } } }]);
    const m = chat({ model: 'codex:gpt-6-astra' });
    const e = await turn(agent, m, 'warm');
    check('kept process: the turn\'s own sum is logged as is, the meter is the last call, the model is the one picked', reports[0].data.usage.outputTokens === 300 && ctxOf(e).pop().tokens === 9260 && ctxOf(e).pop().model === 'GPT-6 Astra', J(ctxOf(e).pop()));
  }

  // ---------- Grok Build and Antigravity: a new session starts the meter over ----------
  {
    const s = { model: 'grokbuild:default', context: { tokens: 150000, window: 256000, at: 1 } };
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ai', 'agent.js'), 'utf8');
    check('grok / agy: a fresh session clears the previous figure before the turn (source guard)', (src.match(/if \(!resume && settings\.context\) \{ delete settings\.context; emit\(\{ type: 'context', context: null \}\); \}/g) || []).length === 2 && s.context);
  }

  fs.rmSync(userData, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
