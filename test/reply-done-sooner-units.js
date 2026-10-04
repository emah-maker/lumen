// A reply is done when its text is: the engines no longer make the screen wait for the CLI's last line (Claude Code's `result`,
// 0.8-1.1 s after the text) or its exit (Grok Build without "Keep connected", Codex: 0.3-0.5 s). Plain Node, fake CLIs that
// delay `result` / exit on purpose:
//  - Claude Code: 'reply_complete' is emitted at the end_turn, `done`/cost/session id still come with `result`; none while a tool call is
//    in flight or in a subagent; Stop in the gap interrupts and keeps the process; agent.js run() waits for a settling run instead of
//    aborting it, and a message sent in the gap is answered by the same process, once, after the result;
//  - Grok Build: the turn resolves on `result`, the process tree is killed in the background, and the prompt file, the sign-in
//    copy-back and the next message's process all wait for its exit;
//  - Codex: the turn resolves on turn.completed, the temp folder and the sign-in copy-back wait for the process, the next message too.
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => JSON.stringify(v);
const RESULT_DELAY = 300; // the fake CLI's gap between the end of the text and its `result` (real: 800-1100 ms)

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-reply-done-'));
const scratch = path.join(base, 'tmp');
fs.mkdirSync(scratch);
for (const k of ['TEMP', 'TMP', 'TMPDIR']) process.env[k] = scratch;
process.env.GROK_HOME = path.join(base, 'user-grok'); // userGrokHome(): never the user's own

// ---------------------------------------------------------------- Claude Code
const cc = require('../src/ai/claude-code');

// A fake `claude` (stream-json on stdin). Each user line is answered with text, an end_turn, and, RESULT_DELAY later, the result.
// `script(msgText, ctx)` may return { tool: true } for a tool call in the way, { sub: true } for the end_turn of a subagent.
function fakeClaude({ resultDelay = RESULT_DELAY, onMessage = null } = {}) {
  const spawned = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 7000 + spawned.length;
    child.exitCode = null;
    const rec = { child, in: [], interrupts: 0, resultAt: [], textAt: [] };
    const out = (m) => child.stdout.write(`${J(m)}\n`);
    let buf = '';
    child.stdin = new Writable({
      write(chunk, _e, cb) {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.type === 'control_request') {
            rec.interrupts++;
            if (rec.pending) { clearTimeout(rec.pending); rec.pending = null; }
            setTimeout(() => { // (a real CLI takes a moment to answer)
              out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
              out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: 'sess-1', total_cost_usd: 0.002, usage: { input_tokens: 1, output_tokens: 1 } });
            }, 15);
            continue;
          }
          const text = msg.message.content[0].text;
          rec.in.push(text);
          answer(text);
        }
        cb();
      },
    });
    const answer = (text) => {
      const n = rec.in.length;
      out({ type: 'system', subtype: 'init', session_id: 'sess-1', mcp_servers: [{ name: 'lumen', status: 'connected' }] });
      onMessage?.(text, { out, rec });
      out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `reply ${n}` } } });
      out({ type: 'assistant', message: { model: 'haiku', stop_reason: null, content: [{ type: 'text', text: `reply ${n}` }], usage: { input_tokens: 3, output_tokens: 2 } } });
      rec.textAt.push(Date.now());
      if (!/NOEND/.test(text)) out({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } });
      if (/HANG/.test(text)) return; // only an interrupt gets a result
      rec.pending = setTimeout(() => {
        rec.pending = null;
        rec.resultAt.push(Date.now());
        out({ type: 'system', subtype: 'post_turn_summary' });
        out({ type: 'result', subtype: 'success', is_error: false, result: `reply ${n}`, session_id: 'sess-1', total_cost_usd: 0.01 * n, usage: { input_tokens: 3, output_tokens: 2 } });
      }, resultDelay);
    };
    spawned.push(rec);
    return child;
  };
  const kill = (child) => { if (child.done) return; child.done = true; child.exitCode = -1; setImmediate(() => child.emit('close', null)); };
  return { spawn, kill, spawned };
}
const gate = { open: () => ({ mcpUrl: 'http://127.0.0.1:1/mcp', mcpToken: 'tok', hookUrl: 'x' }), close() {} };
const newEngine = (cli, extra = {}) => {
  const e = new cc.ClaudeCodeEngine({ userData: base, mcpCommand: () => ({}), ensureServer: () => {}, gate: async () => gate, spawn: cli.spawn, kill: cli.kill, watchdogMs: 0, interruptMs: 800, ...extra });
  e.bin = process.execPath;
  return e;
};
const runOpts = (emit, extra = {}) => ({ prompt: 'hi', sessionId: 'sess-1', resume: false, systemPrompt: 'SYS', model: 'default', signal: new AbortController().signal, emit, ...extra });

async function claudeTests() {
  // 1. early completion: reply_complete well before the result, the result's data still in the outcome
  {
    const cli = fakeClaude();
    const e = newEngine(cli);
    const ev = [];
    const t0 = Date.now();
    let completeAt = 0;
    const out = await e.run(runOpts((x) => { ev.push(x.type); if (x.type === 'reply_complete') completeAt = Date.now(); }));
    const doneAt = Date.now();
    check('claude: reply_complete is emitted at the end_turn, before the (delayed) result', completeAt > 0 && cli.spawned[0].resultAt[0] - completeAt >= RESULT_DELAY * 0.6, J({ completeAt: completeAt - t0, resultAt: cli.spawned[0].resultAt[0] - t0 }));
    check('claude: run() itself still resolves with the result (done, cost, session id)', doneAt >= cli.spawned[0].resultAt[0] && out.cost === 0.01 && out.sessionId === 'sess-1' && out.text === 'reply 1' && !out.failed && out.usage, J(out));
    check('claude: reply_complete comes once and after the text', ev.filter((t) => t === 'reply_complete').length === 1 && ev.indexOf('reply_complete') > ev.indexOf('text'), J(ev));
    e.dispose();
  }

  // 2. not while a tool call is in flight, in a subagent, or without an end_turn
  {
    const cli = fakeClaude({ onMessage: (text, { out }) => { if (/SUB/.test(text)) out({ type: 'stream_event', parent_tool_use_id: 'toolu_x', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } }); } });
    const e = newEngine(cli);
    const ev = [];
    await e.run(runOpts((x) => ev.push(x.type), { prompt: 'SUB NOEND' }));
    check('claude: no reply_complete for a subagent\'s end_turn or a turn without one', !ev.includes('reply_complete'), J(ev));
    e.dispose();
    // a Lumen tool call still running (callBegin) when the end_turn arrives
    const cli2 = fakeClaude();
    const e2 = newEngine(cli2);
    const ev2 = [];
    let began = false;
    await e2.run(runOpts((x) => { ev2.push(x.type); if (x.type === 'text_block' && !began) { began = true; e2.callBegin(); } })); // (the MCP side: a tool call goes in flight)
    check('claude: no reply_complete while a Lumen tool call is in flight', !ev2.includes('reply_complete'), J(ev2));
    e2.dispose();
  }

  // 3. Stop in the gap: the process is interrupted and kept, the stopped outcome returns at once
  {
    const cli = fakeClaude({ resultDelay: 5000 });
    const e = newEngine(cli);
    const ac = new AbortController();
    const ev = [];
    const late = [];
    const p = e.run(runOpts((x) => { ev.push(x.type); if (x.type === 'reply_complete') setTimeout(() => ac.abort(), 20); }, { signal: ac.signal, lateUsage: (u) => late.push(u) }));
    const out = await p;
    check('claude: Stop in the gap returns stopped at once, without waiting for the delayed result', out.stopped === true && out.text === 'reply 1', J(out));
    await sleep(150);
    check('claude: ...the process was asked to interrupt (not killed), its own usage arrives late, and it is kept for the next message', cli.spawned[0].interrupts === 1 && !cli.spawned[0].child.done && late.length === 1 && late[0].cost === 0.002 && e.proc && !e.proc.exited, J({ interrupts: cli.spawned[0].interrupts, done: cli.spawned[0].child.done, proc: Boolean(e.proc), exited: e.proc?.exited, late: late.length }));
    const again = await e.run(runOpts(() => {}, { prompt: 'second' }));
    check('claude: the next message after that Stop reuses the same process', cli.spawned.length === 1 && cli.spawned[0].in.length === 2 && again.text === 'reply 2', J({ spawned: cli.spawned.length, in: cli.spawned[0].in }));
    e.dispose();
  }

  // 4. agent.js run(): a settling run is waited for, not aborted; a plain run is aborted as before
  {
    const { Agent } = require('../src/ai/agent');
    const stub = () => {
      const s = { runs: new Map(), current: null, messages: [], approvedHosts: new Set(), log: [] };
      s.runOnce = async (text, emit, images, extra, skill, messages, rec) => {
        s.log.push(`start ${text}`);
        if (text === 'first') { await sleep(30); rec.settling = rec.wantSettle; await sleep(150); }
        s.log.push(`end ${text}${rec.controller.signal.aborted ? ' (aborted)' : ''}`);
      };
      return s;
    };
    const s = stub();
    const orig = s.runOnce;
    s.runOnce = async (...a) => { const rec = a[6]; rec.wantSettle = true; return orig(...a); };
    const first = Agent.prototype.run.call(s, 'first', () => {});
    await sleep(60);
    const second = Agent.prototype.run.call(s, 'second', () => {});
    await Promise.all([first, second]);
    check('agent.run: a message sent while the previous run is settling waits for it (no abort), then runs', J(s.log) === J(['start first', 'end first', 'start second', 'end second']), J(s.log));
    const s2 = stub();
    const orig2 = s2.runOnce;
    s2.runOnce = async (...a) => { a[6].wantSettle = false; return orig2(...a); };
    const f2 = Agent.prototype.run.call(s2, 'first', () => {});
    await sleep(60);
    const g2 = Agent.prototype.run.call(s2, 'second', () => {});
    await Promise.all([f2, g2]);
    check('agent.run: a run that is not settling is still aborted by the next message', J(s2.log) === J(['start first', 'end first (aborted)', 'start second', 'end second']), J(s2.log));
  }

  // 5. a message sent in the gap, the way the renderer + agent.run send it: after the first run has returned (the result), on the same
  // process, once; nothing is written to a busy process.
  {
    const cli = fakeClaude();
    const e = newEngine(cli);
    let second = null;
    let secondStartedAt = 0;
    const firstRun = e.run(runOpts((x) => {
      if (x.type === 'reply_complete') {
        // The composer is free: the user's next message goes through agent.run, which waits for this run (settling) first.
        second = firstRun0().then(() => { secondStartedAt = Date.now(); return e.run(runOpts(() => {}, { prompt: 'in the gap', resume: true })); });
      }
    }));
    const firstRun0 = () => firstRun;
    const o1 = await firstRun;
    const o2 = await second;
    const rec = cli.spawned[0];
    check('claude: a message sent in the gap goes to the same process, after the result, exactly once', cli.spawned.length === 1 && rec.in.length === 2 && rec.in[1] === 'in the gap' && secondStartedAt >= rec.resultAt[0] && o1.text === 'reply 1' && o2.text === 'reply 2', J({ spawned: cli.spawned.length, in: rec.in, secondStartedAt, resultAt: rec.resultAt }));
    e.dispose();
  }
}

// ---------------------------------------------------------------- Grok Build
const gb = require('../src/ai/grok-build');

async function grokTests() {
  const data = path.join(base, 'grok-data');
  fs.mkdirSync(data, { recursive: true });
  const userHome = path.join(base, 'user-grok');
  fs.mkdirSync(userHome, { recursive: true });
  fs.writeFileSync(path.join(userHome, 'auth.json'), 'token-1');
  const EXIT_DELAY = 350; // a real grok takes 300-500 ms from `result` to exit
  const spawns = [];
  const kills = [];
  const order = [];
  const spawn = (_bin, argv, opts) => {
    const child = new EventEmitter();
    Object.assign(child, { pid: 5100 + spawns.length, exitCode: null, killed: false, stdout: new PassThrough(), stderr: new PassThrough() });
    const promptFile = argv[argv.indexOf('--prompt-file') + 1];
    const rec = { child, argv, opts, promptFile, startedAt: Date.now(), promptExistedAtSpawn: fs.existsSync(promptFile), n: spawns.length + 1 };
    spawns.push(rec);
    order.push(`spawn ${rec.n}`);
    const out = (m) => child.stdout.write(`${J(m)}\n`);
    setImmediate(() => {
      out({ type: 'system', subtype: 'init', session_id: 'id-1', mcp_servers: [{ name: 'lumen', status: 'pending' }] });
      out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `grok ${rec.n}` } } });
      out({ type: 'result', subtype: 'success', is_error: false, result: `grok ${rec.n}`, session_id: 'id-1', total_cost_usd: 0.01 });
      rec.resultAt = Date.now();
      // The process exits by itself EXIT_DELAY later, or sooner when killed: taskkill ends it at once.
      rec.exitTimer = setTimeout(() => finish(), EXIT_DELAY);
    });
    const finish = () => {
      if (child.closed) return;
      child.closed = true;
      clearTimeout(rec.exitTimer);
      rec.closedAt = Date.now();
      order.push(`close ${rec.n}`);
      child.stdout.end();
      setImmediate(() => child.emit('close', 0));
    };
    rec.finish = finish;
    return child;
  };
  // A kill ends the tree after 120 ms (taskkill is not instant).
  const kill = (child) => { kills.push(child.pid); setTimeout(() => { const r = spawns.find((s) => s.child === child); r?.finish(); }, 120); };
  const gateStub = { opened: [], closed: [], armed: () => true, listed: () => true, open(tag) { this.opened.push(tag); return { mcpUrl: 'http://127.0.0.1:1/mcp', mcpToken: 'm'.repeat(48), hookUrl: 'http://127.0.0.1:1/hook/x' }; }, close(tag) { this.closed.push(tag); } };
  const engine = new gb.GrokBuildEngine({ userData: data, gate: async () => gateStub, spawn, kill, watchdogMs: 0, exec: () => {} });
  engine.detect = async () => 'grok.exe';

  // the sign-in copy-back is observed through settleAuthAsync's effect on the user's file: a refreshed token written by the process as it exits
  const authFile = path.join(engine.home, 'auth.json');
  const t0 = Date.now();
  const emitted = [];
  const out1 = await engine.run({ prompt: 'one', sessionId: 'id-1', resume: false, systemPrompt: 'S', signal: new AbortController().signal, emit: (e) => emitted.push(e) });
  const resolvedAt = Date.now();
  const r1 = spawns[0];
  check('grok: the turn resolves on the result line, not the process exit', out1.text === 'grok 1' && out1.cost === 0.01 && !out1.failed && !r1.child.closed, J({ out1, closed: r1.child.closed }));
  check('grok: ...well before the exit it used to wait for', r1.child.closed !== true && resolvedAt - r1.resultAt < EXIT_DELAY * 0.5, J({ gap: resolvedAt - r1.resultAt }));
  check('grok: the process tree is killed at once, in the background', kills.length === 1 && kills[0] === r1.child.pid, J(kills));
  check('grok: the run\'s gate token is closed as soon as the turn is answered', gateStub.closed.length === 1, J(gateStub.closed));
  check('grok: the prompt file is still there while the process is going down', fs.existsSync(r1.promptFile), r1.promptFile);
  // the process "refreshes the token" as it exits: write it just before it closes; the copy-back must carry it
  fs.writeFileSync(authFile, 'token-2-refreshed');
  // the next message in the same chat, sent in that gap
  const second = engine.run({ prompt: 'two', sessionId: 'id-1', resume: true, systemPrompt: 'S', signal: new AbortController().signal, emit: () => {} });
  await sleep(40);
  check('grok: a next message does not spawn while the last process is still exiting', spawns.length === 1, J({ spawns: spawns.length, order }));
  const out2 = await second;
  const r2 = spawns[1];
  check('grok: ...it spawns once the last process has closed, and answers', spawns.length === 2 && r2.startedAt >= r1.closedAt && out2.text === 'grok 2', J({ order, out2 }));
  await sleep(100); // (the removal is a background step after the exit)
  check('grok: the first prompt file is removed once its process has closed', !fs.existsSync(r1.promptFile), r1.promptFile);
  // the refreshed token is copied back to the user's file, after the exits: wait for the chain
  await sleep(EXIT_DELAY + 400);
  await engine.settling;
  check('grok: the sign-in copy-back ran after the process had exited (the refreshed token reached the user\'s file)', fs.readFileSync(path.join(userHome, 'auth.json'), 'utf8') === 'token-2-refreshed', fs.readFileSync(path.join(userHome, 'auth.json'), 'utf8'));
  check('grok: spawn/close order: no process overlaps the next', J(order.filter((o) => /^(spawn|close) 1$/.test(o))) === J(['spawn 1', 'close 1']) && order.indexOf('close 1') < order.indexOf('spawn 2'), J(order));
  check('grok: nothing is left waiting (exit set empty)', engine.exits.size === 0, String(engine.exits.size));

  // a failing result still waits for the exit (its error text may use the exit code), and a stop is unchanged
  {
    const failSpawn = (_b, argv) => {
      const child = new EventEmitter();
      Object.assign(child, { pid: 6100, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
      setImmediate(() => { child.stdout.write(`${J({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', session_id: 'id-1' })}\n`); setTimeout(() => { child.stdout.end(); child.emit('close', 1); }, 100); });
      return child;
    };
    const e2 = new gb.GrokBuildEngine({ userData: data, gate: async () => gateStub, spawn: failSpawn, kill, watchdogMs: 0, exec: () => {} });
    e2.detect = async () => 'grok.exe';
    const ev = [];
    const started = Date.now();
    const o = await e2.run({ prompt: 'x', sessionId: 'id-1', resume: true, systemPrompt: 'S', signal: new AbortController().signal, emit: (x) => ev.push(x) });
    check('grok: a failed result is unchanged (waits for the exit, reports the error)', o.failed === true && Date.now() - started >= 90 && ev.some((x) => x.type === 'error'), J({ o, ev }));
  }
}

// ---------------------------------------------------------------- Codex
const cx = require('../src/ai/codex');

async function codexTests() {
  const userData = path.join(base, 'cx-data');
  const userHome = path.join(userData, 'user-codex');
  const tmp = path.join(userData, 'tmp');
  fs.mkdirSync(userHome, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(userHome, 'auth.json'), '{"v":1}');
  const EXIT_DELAY = 350;
  const spawns = [];
  const order = [];
  const spawn = (_bin, _argv, o) => {
    const child = new EventEmitter();
    Object.assign(child, { pid: 8100 + spawns.length, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
    const rec = { child, cwd: o.cwd, n: spawns.length + 1, startedAt: Date.now() };
    spawns.push(rec);
    order.push(`spawn ${rec.n}`);
    const home = o.env.CODEX_HOME;
    rec.home = home;
    setImmediate(() => {
      const out = (m) => child.stdout.write(`${J(m)}\n`);
      out({ type: 'thread.started', thread_id: '0199aaaa-bbbb-cccc-dddd-eeeeffff0001' });
      out({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: `codex ${rec.n}` } });
      out({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } });
      rec.completedAt = Date.now();
      rec.exitTimer = setTimeout(() => finish(), EXIT_DELAY); // exits by itself, as the real one does
    });
    const finish = () => {
      if (child.closed) return;
      child.closed = true;
      clearTimeout(rec.exitTimer);
      rec.closedAt = Date.now();
      rec.folderAtClose = fs.existsSync(rec.cwd);
      order.push(`close ${rec.n}`);
      try { fs.writeFileSync(path.join(home, 'auth.json'), '{"v":2}'); } catch { /* the home is gone */ } // a token refreshed as it exits
      child.stdout.end();
      setImmediate(() => child.emit('close', 0));
    };
    rec.finish = finish;
    return child;
  };
  const killed = [];
  const kill = (c) => { killed.push(c.pid); setImmediate(() => spawns.find((s) => s.child === c)?.finish()); };
  const g = { opened: [], closed: [], open(tag) { this.opened.push(tag); return { mcpUrl: 'http://127.0.0.1:9/mcp', mcpToken: 'tok' }; }, close(tag) { this.closed.push(tag); } };
  const spec = { found: true, command: process.execPath, args: [], path: process.execPath, kind: 'exe', version: '9.9.9' };
  const engine = new cx.CodexEngine({ userData, gate: async () => g, locate: async () => spec, userHome: () => userHome, tmp, watchdogMs: 0, spawn, kill });
  const home = cx.chatHomeFor(userData, 'chat-x');
  const out1 = await engine.run({ prompt: 'one', sessionId: null, systemPrompt: 's', signal: new AbortController().signal, emit: () => {}, scope: { chatId: 'chat-x' } });
  const resolvedAt = Date.now();
  const r1 = spawns[0];
  check('codex: the turn resolves on turn.completed, before the process has exited', out1.text === 'codex 1' && out1.sessionId === '0199aaaa-bbbb-cccc-dddd-eeeeffff0001' && out1.usage && !out1.failed && !r1.child.closed && resolvedAt - r1.completedAt < EXIT_DELAY * 0.5, J({ out1, gap: resolvedAt - r1.completedAt }));
  check('codex: the process is not killed (it ends by itself)', killed.length === 0, J(killed));
  check('codex: its temp folder is kept while it runs', fs.existsSync(r1.cwd), r1.cwd);
  const second = engine.run({ prompt: 'two', sessionId: '0199aaaa-bbbb-cccc-dddd-eeeeffff0001', systemPrompt: 's', signal: new AbortController().signal, emit: () => {}, scope: { chatId: 'chat-x' } });
  await sleep(40);
  check('codex: a next message in the same chat waits for the exit', spawns.length === 1, J(order));
  const out2 = await second;
  check('codex: ...then runs, after the first process closed', spawns.length === 2 && spawns[1].startedAt >= r1.closedAt && out2.text === 'codex 2', J({ order, out2 }));
  await sleep(100);
  check('codex: the first run\'s folder was removed only after its process closed, and the sign-in copy-back ran after the exit (refreshed token returned)', r1.folderAtClose === true && !fs.existsSync(r1.cwd) && fs.readFileSync(path.join(userHome, 'auth.json'), 'utf8') === '{"v":2}', J({ atClose: r1.folderAtClose, exists: fs.existsSync(r1.cwd), auth: fs.readFileSync(path.join(userHome, 'auth.json'), 'utf8') }));
  await sleep(EXIT_DELAY + 200);
  check('codex: nothing is left pending', !fs.readdirSync(tmp).some((n) => n.startsWith('lumen-cx-')) && !home.includes('\0'), J(fs.readdirSync(tmp)));
}

(async () => {
  try {
    await claudeTests();
    await grokTests();
    await codexTests();
  } catch (err) {
    failures++;
    console.log(`FAIL  threw ${err.stack}`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
