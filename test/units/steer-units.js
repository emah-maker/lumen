// [mid-run messages] A message typed while a reply runs reaches the model at the run's next step (ai/steer.js), plain Node: no Electron, no
// network, no real CLI. Covers the box (order, once, taken back before it went, the same message handed over again), the frame the model reads
// and the chat shows, which queued messages can go mid-run (renderer/chat-queue.js steerable), the API loop with a fake Claude client (a
// message handed over during a tool round is in the NEXT request, once; one that comes while the final answer streams waits for the next
// message; one taken back never goes; Codex takes nothing mid-run), and Claude Code with a fake `claude` speaking stream-json (the message is
// a stdin line written while its tool call runs, as checked against Claude Code 2.1.314; never while no tool call is out).
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const steer = require('../../src/ai/steer');
const chatQueue = require('../../src/renderer/chat-queue');
const { Agent, transcriptFor } = require('../../src/ai/agent');
const cc = require('../../src/ai/claude-code');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
const J = (v) => JSON.stringify(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the box
{
  const box = steer.createBox();
  check('box: a message waits', box.add({ uid: 'a', text: ' first ' }) === 'waiting' && box.size === 1);
  check('box: nothing to send is refused', box.add({ uid: 'x', text: '  ' }) === null && box.add({ text: 'no id' }) === null && box.size === 1);
  box.add({ uid: 'b', text: 'second' });
  check('box: the same message handed over twice waits once', box.add({ uid: 'b', text: 'second' }) === 'waiting' && box.size === 2);
  const taken = box.take();
  check('box: taken in the order typed, trimmed', J(taken) === J([{ uid: 'a', text: 'first' }, { uid: 'b', text: 'second' }]), J(taken));
  check('box: taken once', box.take().length === 0 && box.size === 0);
  check('box: one that went is "sent" when handed over again (never twice)', box.add({ uid: 'a', text: 'first' }) === 'sent' && box.size === 0 && box.wasSent('a'));
  box.add({ uid: 'c', text: 'third' });
  check('box: taken back before it went', box.remove('c') === true && box.size === 0 && !box.wasSent('c'));
  check('box: one that went cannot be taken back', box.remove('a') === false);
  box.add({ uid: 'd', text: 'fourth' });
  box.giveBack([{ uid: 'b', text: 'second' }]);
  check('box: one given back (it never reached the model) waits again, first', J(box.take().map((e) => e.uid)) === '["b","d"]');
}

// ---- the frame
{
  const w = steer.wrap('is probably in me2340');
  check('wrap: the model is told when it came and what to do with it', w.startsWith(steer.NOTE) && /<sent_while_working>\nis probably in me2340\n<\/sent_while_working>/.test(w), w);
  check('unwrap: the user\'s words back', steer.unwrap(w) === 'is probably in me2340');
  check('unwrap: any other text is not one', steer.unwrap('hello') === null && steer.unwrap(null) === null);
  check('blocksFor: one text block each, in order', J(steer.blocksFor([{ uid: 'a', text: 'x' }, { uid: 'b', text: 'y' }]).map((b) => steer.unwrap(b.text))) === '["x","y"]');
}

// ---- which waiting messages can go mid-run (renderer/chat-queue.js)
{
  const s = chatQueue.steerable;
  check('steerable: words', s({ text: 'is probably in me2340' }));
  check('steerable: pictures, files, @tabs and a screen wait for the next message', !s({ text: 'x', images: [{}] }) && !s({ text: 'x', tabs: { ids: [3] } }) && !s({ text: 'x', tabs: { ids: [], gone: ['a'] } }) && !s({ text: 'x', screen: { id: 1 } }));
  check('steerable: a plan to run, a new chat, or Send now wait too', !s({ text: 'x', opts: { approvedPlan: {} } }) && !s({ text: 'x', fresh: true }) && !s({ text: 'x', now: true }));
  check('steerable: nothing typed is not', !s({ text: '  ' }) && !s(null));
}

// ---- the API loop (agent.js) with a fake Claude client
const fakeBrowser = () => ({ activeTab: () => null, tabById: () => null, listTabs: () => [], effectiveModel: (x) => x, aiOff: () => false, noTabReason: () => 'No tab open.', maxSteps: () => 0, autoApprove: () => true });
const newAgent = (getClient, model = 'claude-opus-5') => {
  const agent = new Agent(fakeBrowser(), getClient, () => ({ model }));
  agent.closeSignedInTabs = () => {};
  agent.newActionLog = () => ({});
  agent.undoSummary = () => null;
  return agent;
};
const runOn = (agent, text) => new Promise((resolve) => { const events = []; agent.run(text, (e) => { events.push(e); if (e.type === 'done') resolve(events); }); });
const sentBlocks = (messages) => messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'text' && steer.unwrap(b.text) !== null).map((b) => steer.unwrap(b.text));
// A model that takes `rounds` tool rounds (list_tabs), then answers. `during(n, params)` runs while request n streams.
const toolModel = (rounds, during = () => {}) => {
  const requests = [];
  const client = { beta: { messages: { stream: (params) => {
    const n = requests.length;
    requests.push(JSON.parse(JSON.stringify(params.messages)));
    const tool = n < rounds;
    const content = tool ? [{ type: 'text', text: `Step ${n}` }, { type: 'tool_use', id: `tu-${n}`, name: 'list_tabs', input: {} }] : [{ type: 'text', text: 'Done.' }];
    const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: tool ? 'tool_use' : 'end_turn', content, usage: { input_tokens: 10, output_tokens: 5 } };
    return {
      async *[Symbol.asyncIterator]() { await during(n, params); yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content[0].text } }; },
      finalMessage: async () => message,
    };
  } } } };
  return { client, requests };
};

(async () => {
  {
    // Handed over while the first tool round runs: in the second request, once; marked sent; the chat shows it.
    let agent;
    let again = null;
    const { client, requests } = toolModel(3, (n) => {
      if (n === 0) check('api: a message is taken while the reply runs', J(agent.steer(agent.messages, { uid: 'u1', text: 'is probably in me2340' })) === J({ ok: true, state: 'waiting' }));
      if (n === 2) again = agent.steer(agent.messages, { uid: 'u1', text: 'is probably in me2340' }); // (a reloaded view hands it over again)
    });
    agent = newAgent(() => client);
    const events = await runOn(agent, 'create a doc for me2340 in canvas');
    const inReq = requests.map((r) => sentBlocks(r));
    check('api: it is not in the request that was already out', inReq[0].length === 0, J(inReq));
    check('api: it reaches the next request, after that round\'s tool results', J(inReq[1]) === '["is probably in me2340"]' && requests[1].at(-1).content[0].type === 'tool_result' && steer.unwrap(requests[1].at(-1).content.at(-1).text) !== null, J(requests[1].at(-1)));
    check('api: sent once, never again', J(inReq.slice(2)) === J(inReq.slice(2).map(() => ['is probably in me2340'])) && sentBlocks(agent.messages).length === 1, J(inReq));
    const said = events.filter((e) => e.type === 'steered');
    check('api: the view is told it went, once', said.length === 1 && J(said[0].uids) === '["u1"]', J(said));
    check('api: told before the reply ends', events.indexOf(said[0]) < events.findIndex((e) => e.type === 'done'));
    check('api: handed over again after it went: "sent", not twice', J(again) === J({ ok: true, state: 'sent' }), J(again));
    const items = transcriptFor(agent.messages);
    const shown = items.filter((it) => it.role === 'user').map((it) => `${it.text}${it.steered ? ' (sent while working)' : ''}`);
    check('transcript: the message shows in the chat, marked, after the step it came in', J(shown) === J(['create a doc for me2340 in canvas', 'is probably in me2340 (sent while working)']), J(shown));
    const last = items.at(-1);
    check('transcript: the reply\'s steps still count together', last.role === 'assistant' && last.text === 'Done.' && last.steps === 3, J(last));
  }
  {
    // Handed over while the final answer streams: no step is left, so it is not sent here (the view sends it as the next message).
    let agent;
    const { client, requests } = toolModel(1, (n) => { if (n === 1) agent.steer(agent.messages, { uid: 'late', text: 'one more thing' }); });
    agent = newAgent(() => client);
    const events = await runOn(agent, 'go');
    check('api: during the final answer it waits for the next message', requests.every((r) => sentBlocks(r).length === 0) && !events.some((e) => e.type === 'steered') && sentBlocks(agent.messages).length === 0, J(events.map((e) => e.type)));
  }
  {
    // Taken back (Edit, ×) before the next step: never sent.
    let agent;
    let back = null;
    const { client, requests } = toolModel(2, (n) => { if (n === 0) { agent.steer(agent.messages, { uid: 'u2', text: 'never mind' }); back = agent.unsteer(agent.messages, 'u2'); } });
    agent = newAgent(() => client);
    const events = await runOn(agent, 'go');
    check('api: taken back before it went: true, and never sent', back === true && requests.every((r) => sentBlocks(r).length === 0) && !events.some((e) => e.type === 'steered'));
  }
  {
    // Several, in order, in one step; and Stop still stops (what waits is not sent).
    let agent;
    const ctl = {};
    const { client, requests } = toolModel(5, async (n) => {
      if (n === 0) { agent.steer(agent.messages, { uid: 'a', text: 'first' }); agent.steer(agent.messages, { uid: 'b', text: 'second' }); }
      if (n === 1) { agent.steer(agent.messages, { uid: 'c', text: 'third' }); ctl.stop(); }
    });
    agent = newAgent(() => client);
    ctl.stop = () => agent.stopFor(agent.messages);
    const events = await runOn(agent, 'go');
    check('api: several go together at one step, in order', J(sentBlocks(requests[1])) === '["first","second"]', J(sentBlocks(requests[1])));
    check('api: Stop still stops; what waited then is not sent', requests.length === 2 && J(events.filter((e) => e.type === 'steered').map((e) => e.uids)) === '[["a","b"]]' && !sentBlocks(agent.messages).includes('third'), J({ n: requests.length, s: events.filter((e) => e.type === 'steered') }));
  }
  {
    // No run, and an engine that takes nothing mid-run.
    const agent = newAgent(() => null);
    check('steer: with no run, the view keeps it', J(agent.steer(agent.messages, { uid: 'x', text: 'hi' })) === J({ ok: false }) && agent.unsteer(agent.messages, 'x') === true);
    const m = [];
    m.settings = { model: 'codex:default' };
    agent.runs.set(m, { controller: new AbortController(), steers: steer.createBox() });
    check('steer: Codex takes nothing mid-run (it waits for the reply to end, and the view says so)', J(agent.steer(m, { uid: 'x', text: 'hi' })) === J({ ok: false, why: 'engine' }));
    m.settings.model = 'claudecode:default';
    agent.runs.get(m).noSteer = true; // (Auto sent this message to Grok Build, Antigravity or Codex)
    check('steer: nor does a run that went to one of them', agent.steer(m, { uid: 'x', text: 'hi' }).why === 'engine');
  }

  // ---- Claude Code (claude-code.js) with a fake `claude`
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-steer-'));
  const gate = { open: () => ({ mcpUrl: 'http://127.0.0.1:5555/mcp', mcpToken: 'tok', hookUrl: 'x' }), close: () => {} };
  // One process; `respond(rec, msg, n)` answers each stdin line (control requests left out).
  const fakeClaude = (respond) => {
    const spawned = [];
    const spawn = (_bin, argv) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.pid = 7000 + spawned.length;
      const flag = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
      const rec = { argv, child, lines: [], session: flag('--session-id') || flag('--resume') };
      rec.out = (obj) => { if (child.exitCode === null) child.stdout.write(`${JSON.stringify(obj)}\n`); };
      rec.exit = (code = 0) => { if (child.exitCode !== null) return; child.exitCode = code; setImmediate(() => child.emit('close', code)); };
      let buf = '';
      child.stdin = new Writable({ write(chunk, _e, cb) { buf += chunk; let i; while ((i = buf.indexOf('\n')) >= 0) { const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (msg.type === 'control_request') continue; rec.lines.push(msg); setImmediate(() => respond(rec, msg, rec.lines.length)); } cb(); } });
      spawned.push(rec);
      return child;
    };
    const kill = (child) => { const rec = spawned.find((r) => r.child === child); if (rec) { rec.killed = true; rec.exit(null); } };
    return { spawn, kill, spawned };
  };
  const make = (cli) => { const eng = new cc.ClaudeCodeEngine({ userData: tmp, mcpCommand: () => ({ command: 'b', args: [], env: {} }), ensureServer: () => {}, gate: async () => gate, spawn: cli.spawn, kill: cli.kill, retryDelayMs: 10, startWait: async () => {}, finalIdleMs: 0 }); eng.bin = process.execPath; return eng; };
  const textIn = (msg) => (msg.message?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const io = (box, delivered) => ({ pump: null, take: () => box.take(), delivered: (entries) => delivered.push(entries.map((e) => e.uid)) });
  {
    // The model calls a tool; while it runs, the message is handed over: one stdin line, read at the CLI's next model call, in the same turn.
    let toolOut = null;
    const box = steer.createBox();
    const delivered = [];
    const steers = io(box, delivered);
    const cli = fakeClaude((rec, msg, n) => {
      if (n === 1) {
        rec.out({ type: 'system', subtype: 'init', session_id: rec.session, mcp_servers: [{ name: 'lumen', status: 'connected' }] });
        rec.out({ type: 'stream_event', event: { type: 'message_start', message: {} } });
        rec.out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 1' } }] } });
        toolOut = () => {
          rec.out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } });
          rec.out({ type: 'stream_event', event: { type: 'message_start', message: {} } });
          rec.out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'In ME2340.' } } });
          rec.out({ type: 'result', subtype: 'success', is_error: false, result: 'In ME2340.', session_id: rec.session, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } });
        };
      }
      if (n === 2) setTimeout(() => toolOut(), 20); // (the tool call ends after the message came)
    });
    const eng = make(cli);
    const events = [];
    const turn = eng.run({ prompt: 'create a doc', sessionId: 'sess-s', resume: false, systemPrompt: 'SYS', signal: new AbortController().signal, emit: (e) => events.push(e), steers });
    for (let i = 0; i < 100 && !toolOut; i++) await sleep(10);
    box.add({ uid: 'm1', text: 'is probably in me2340' });
    steers.pump?.();
    const out = await turn;
    const lines = cli.spawned[0]?.lines || [];
    check('claude code: the message is a stream-json user line on stdin while the tool call runs', lines.length === 2 && lines[1].type === 'user' && steer.unwrap(textIn(lines[1])) === 'is probably in me2340', J(lines.map(textIn)));
    check('claude code: it reached the model (its next call began): marked sent, once', J(delivered) === '[["m1"]]', J(delivered));
    check('claude code: the same turn goes on (one result, its reply)', out.text === 'In ME2340.' && !out.failed, J(out));
    eng.dispose();
  }
  {
    // No tool call out (the reply is only text): nothing is written; the message waits for the next one.
    const box = steer.createBox();
    const delivered = [];
    const steers = io(box, delivered);
    let release = null;
    const cli = fakeClaude((rec, msg, n) => {
      if (n !== 1) return;
      rec.out({ type: 'system', subtype: 'init', session_id: rec.session, mcp_servers: [{ name: 'lumen', status: 'connected' }] });
      rec.out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Thinking it over' } } });
      release = () => rec.out({ type: 'result', subtype: 'success', is_error: false, result: 'Thinking it over', session_id: rec.session, total_cost_usd: 0, usage: {} });
    });
    const eng = make(cli);
    const turn = eng.run({ prompt: 'hi', sessionId: 'sess-t', resume: false, systemPrompt: 'SYS', signal: new AbortController().signal, emit: () => {}, steers });
    for (let i = 0; i < 100 && !release; i++) await sleep(10);
    box.add({ uid: 'm2', text: 'later' });
    steers.pump?.();
    await sleep(30);
    release();
    await turn;
    check('claude code: with no tool call out, nothing is written (it waits for the next message)', cli.spawned[0].lines.length === 1 && box.size === 1 && delivered.length === 0, J({ lines: cli.spawned[0].lines.length, size: box.size }));
    eng.dispose();
  }
  {
    // Stop while a written message has not reached the model: the process goes (it would start a turn of its own), and it was never sent.
    const box = steer.createBox();
    const delivered = [];
    const steers = io(box, delivered);
    let ready = false;
    const cli = fakeClaude((rec, msg, n) => {
      if (n !== 1) return;
      rec.out({ type: 'system', subtype: 'init', session_id: rec.session, mcp_servers: [{ name: 'lumen', status: 'connected' }] });
      rec.out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'sleep 9' } }] } });
      ready = true;
    });
    const eng = make(cli);
    const ctl = new AbortController();
    const turn = eng.run({ prompt: 'go', sessionId: 'sess-u', resume: false, systemPrompt: 'SYS', signal: ctl.signal, emit: () => {}, steers });
    for (let i = 0; i < 100 && !ready; i++) await sleep(10);
    box.add({ uid: 'm3', text: 'stop that' });
    steers.pump?.();
    await sleep(20);
    ctl.abort();
    await turn;
    check('claude code: Stop still stops; a message not yet read is not marked sent, and its process is ended', delivered.length === 0 && cli.spawned[0].killed === true, J({ delivered, killed: cli.spawned[0].killed }));
    eng.dispose();
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
