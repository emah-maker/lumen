// [background helpers] Claude Code's background helpers (plain Node, a mocked spawn, no real CLI, short real timers).
// The fake CLI prints what the CLI's documentation says it prints for a subagent started with run_in_background
// (Agent SDK message types: system task_started / task_progress / task_notification, parent_tool_use_id on a subagent's own lines,
// `async_launched` in the Agent tool's result, a user message with origin.kind "task-notification" when the CLI goes on by itself):
//  - cc-helpers.js HelperTracker: starts, progress, ends, the live set, foreground tasks, the async_launched fallback
//  - the turn ends at its `result` while a helper works: run() says so, the process is kept (no idle timer, not killed), the helper's own
//    tool calls arrive after the result as steps flagged helper, and its end says done
//  - the CLI's own follow-up turn is handed to onFollowUp and read by a run({ adopt }) that sends nothing; it ends like any message
//  - no follow-up: the process is idle again after the grace; the process dying, the cap, and a turn that ends with a failure end the helpers
//  - a one-shot process (one message, stdin closed) is kept too; a new message on a kept process is its own turn, and the helper goes on
//  - a turn with no helpers is exactly as before
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const cc = require('../../src/ai/claude-code');
const { HelperTracker } = require('../../src/ai/cc-helpers');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(10); } return v; };
const flag = (argv, f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);

// ---- the tracker, line by line
function tracker() {
  const t = new HelperTracker();
  const started = (o = {}) => ({ type: 'system', subtype: 'task_started', task_id: 'T1', tool_use_id: 'ag1', description: 'Review slides', task_type: 'local_agent', is_backgrounded: true, ...o });

  let r = t.feed(started());
  check('tracker: a background subagent starts', r.started.length === 1 && r.started[0].desc === 'Review slides' && t.count() === 1, JSON.stringify(r));
  check('tracker: its own lines are known by parent_tool_use_id (and agent_id)', t.helperOf({ type: 'assistant', parent_tool_use_id: 'ag1' })?.id === 'T1' && t.helperOf({ type: 'assistant', agent_id: 'T1' })?.id === 'T1' && !t.helperOf({ type: 'assistant', parent_tool_use_id: 'other' }) && !t.helperOf({ type: 'assistant' }));
  r = t.feed({ type: 'system', subtype: 'task_progress', task_id: 'T1', description: 'Reading slide 3' });
  check('tracker: progress carries the helper\'s own words', r.progress.length === 1 && r.progress[0].latest === 'Reading slide 3');
  r = t.feed({ type: 'system', subtype: 'task_progress', task_id: 'T1', description: 'Reading slide 3' });
  check('tracker: the same progress twice is said once', r.progress.length === 0);
  r = t.feed({ type: 'system', subtype: 'task_notification', task_id: 'T1', status: 'completed', summary: 'done' });
  check('tracker: a notification ends it', r.ended.length === 1 && r.ended[0].status === 'completed' && t.count() === 0 && !t.helperOf({ type: 'assistant', parent_tool_use_id: 'ag1' }));
  r = t.feed({ type: 'system', subtype: 'task_notification', task_id: 'T1', status: 'completed' });
  check('tracker: a second notification says nothing', r.ended.length === 0);

  t.feed(started({ task_id: 'T2', task_type: 'local_bash', tool_use_id: 'b1', description: 'npm test' }));
  r = t.feed({ type: 'system', subtype: 'task_notification', task_id: 'T2', status: 'failed' });
  check('tracker: a background shell task counts; a failed one says failed', r.ended[0]?.status === 'failed');

  r = t.feed(started({ task_id: 'T3', ambient: true }));
  check('tracker: an ambient task (the CLI\'s own) is not a helper', r.started.length === 0 && t.count() === 0);
  r = t.feed(started({ task_id: 'T4', task_type: 'remote_agent' }));
  check('tracker: other kinds of task are not shown', r.started.length === 0 && t.count() === 0);

  r = t.feed(started({ task_id: 'T5', is_backgrounded: false, tool_use_id: 'ag5' }));
  check('tracker: a foreground subagent is not a background helper', r.started.length === 0 && t.count() === 0 && !t.helperOf({ type: 'assistant', parent_tool_use_id: 'ag5' }));
  r = t.feed({ type: 'system', subtype: 'task_updated', task_id: 'T5', patch: { is_backgrounded: true } });
  check('tracker: ...until it is moved to the background', r.started.length === 1 && t.count() === 1);
  r = t.feed({ type: 'system', subtype: 'task_updated', task_id: 'T5', patch: { status: 'killed' } });
  check('tracker: a killed task ends as stopped', r.ended[0]?.status === 'stopped' && t.count() === 0);

  r = t.feed({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'T6', task_type: 'local_agent', description: 'Check links' }, { task_id: 'A1', task_type: 'local_bash', ambient: true, description: 'watch' }] });
  check('tracker: the live set starts what it names', r.started.length === 1 && r.started[0].id === 'T6' && t.count() === 1);
  r = t.feed({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  check('tracker: a helper that left the live set has ended', r.ended.length === 1 && t.count() === 0);

  r = t.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ag9', content: 'Async agent launched' }] }, tool_use_result: { status: 'async_launched', agentId: 'AG9', description: 'Old CLI helper' } });
  check('tracker: an async_launched result alone starts one (an older CLI)', r.started.length === 1 && r.started[0].id === 'AG9' && t.helperOf({ type: 'assistant', parent_tool_use_id: 'ag9' })?.id === 'AG9');
  r = t.feed(started({ task_id: 'AG9', tool_use_id: 'ag9', description: 'Old CLI helper' }));
  check('tracker: ...and the task_started that follows it is the same helper', r.started.length === 0 && t.count() === 1);
  const old = new HelperTracker();
  old.feed({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'agX', content: 'Async agent launched' }] }, tool_use_result: { status: 'async_launched', agentId: 'AGX', description: 'Old CLI helper' } });
  const fallbackEnded = old.endFallback();
  check('tracker: a helper known only from async_launched ends when the CLI goes on by itself; one with task lines does not', fallbackEnded.length === 1 && old.count() === 0 && t.endFallback().length === 0, JSON.stringify(fallbackEnded));
  const gone = t.endAll('stopped');
  check('tracker: endAll ends what shows as working', gone.length === 1 && gone[0].status === 'stopped' && t.count() === 0);
}

// ---- the engine
function fakeClaude(respond) {
  const spawned = [];
  const spawn = (bin, argv) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.pid = 8000 + spawned.length;
    const rec = { bin, argv, child, lines: [], killed: false, stdinEnded: false };
    rec.out = (obj) => { if (child.exitCode === null) child.stdout.write(`${JSON.stringify(obj)}\n`); };
    rec.exit = (code = 0) => { if (child.exitCode !== null) return; child.exitCode = code; setImmediate(() => child.emit('close', code)); };
    rec.session = flag(argv, '--session-id') || flag(argv, '--resume');
    let buf = '';
    child.stdin = new Writable({
      write(chunk, _enc, cb) {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          if (msg.type === 'control_request') continue;
          rec.lines.push(msg);
          setImmediate(() => respond(rec, msg, rec.lines.length));
        }
        cb();
      },
    });
    child.stdin.on('finish', () => { rec.stdinEnded = true; });
    spawned.push(rec);
    return child;
  };
  const kill = (child) => { const rec = spawned.find((r) => r.child === child); if (rec) { rec.killed = true; rec.exit(null); } };
  return { spawn, kill, spawned };
}
const init = (rec) => rec.out({ type: 'system', subtype: 'init', session_id: rec.session, mcp_servers: [{ name: 'lumen', status: 'connected' }] });
const textOf = (rec, text) => rec.out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const result = (rec, text, extra = {}) => rec.out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: rec.session, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 }, ...extra });
// The first message: the model starts a background subagent, says so, and its turn ends.
const launch = (rec, { id = 'ag1', task = 'T1', desc = 'Review slides', say = 'A reviewer is checking the deck.' } = {}) => {
  init(rec);
  rec.out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { description: desc, run_in_background: true, subagent_type: 'general-purpose', prompt: 'review' } }] } });
  rec.out({ type: 'system', subtype: 'task_started', task_id: task, tool_use_id: id, description: desc, task_type: 'local_agent', is_backgrounded: true });
  rec.out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Async agent launched' }] }, tool_use_result: { status: 'async_launched', agentId: task, description: desc } });
  textOf(rec, say);
  rec.out({ type: 'assistant', message: { content: [{ type: 'text', text: say }], stop_reason: 'end_turn' } });
  result(rec, say);
};
// What the helper itself does afterwards: a tool call of its own (parent_tool_use_id), then its result.
const helperStep = (rec, id, parent = 'ag1') => {
  rec.out({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: 'C:/deck/slide3.txt' } }] } });
  return () => rec.out({ type: 'user', parent_tool_use_id: parent, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'slide text' }] } });
};
const endHelper = (rec, task = 'T1', status = 'completed') => rec.out({ type: 'system', subtype: 'task_notification', task_id: task, status, output_file: 'x', summary: 'ok' });
// The CLI goes on by itself: the helper's result starts a turn.
const followUpTurn = (rec, text) => {
  rec.out({ type: 'user', origin: { kind: 'task-notification' }, message: { content: [{ type: 'text', text: '<task-notification>done</task-notification>' }] } });
  rec.out({ type: 'stream_event', event: { type: 'message_start' } });
  textOf(rec, text);
  rec.out({ type: 'assistant', message: { content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
  result(rec, text, { origin: { kind: 'task-notification' } });
};

async function engine() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-helpers-'));
  let tokens = 0;
  const gate = { open: () => ({ mcpUrl: 'http://127.0.0.1:5555/mcp', mcpToken: `tok${++tokens}`, hookUrl: 'x' }), close: () => {} };
  const rig = (respond, extra = {}) => {
    const cli = fakeClaude(respond);
    const eng = new cc.ClaudeCodeEngine({ userData: tmp, mcpCommand: () => ({ command: 'b', args: [], env: {} }), ensureServer: () => {}, gate: async () => gate, spawn: cli.spawn, kill: cli.kill, retryDelayMs: 5, watchdogMs: 0, followUpGraceMs: 120, interruptMs: 80, ...extra });
    eng.bin = process.execPath;
    return { cli, eng };
  };
  const opts = (events, o = {}) => ({ prompt: 'review the deck', sessionId: 'sess-1', resume: false, systemPrompt: 'SYS', fullAccess: true, signal: new AbortController().signal, emit: (e) => events.push(e), ...o });
  const kinds = (ev, type) => ev.filter((e) => e.type === type);

  // 1) a kept process: the whole story
  for (const mode of ['kept', 'one-shot']) {
    const label = mode === 'kept' ? 'kept process' : 'one-shot process';
    const { cli, eng } = rig((rec) => launch(rec), { keepAlive: mode === 'kept' });
    const first = [];
    const second = [];
    const handed = [];
    let followed = null;
    const onFollowUp = ({ proc }) => { handed.push(proc); return eng.run(opts(second, { adopt: proc, onFollowUp })).then((r) => { followed = r; }); };
    const r = await eng.run(opts(first, { onFollowUp }));
    const rec = cli.spawned[0];
    check(`${label}: the turn ends at its result while a helper works, and says so`, r.text === 'A reviewer is checking the deck.' && !r.failed && r.helpers.length === 1 && r.helpers[0].label === 'Review slides', JSON.stringify(r));
    const working = kinds(first, 'helper').find((e) => e.state === 'working');
    check(`${label}: the helper is said to be working (before the reply ends)`, working && working.id === 'T1' && working.label === 'Review slides' && working.count === 1, JSON.stringify(kinds(first, 'helper')));
    check(`${label}: the process is kept for it: no idle timer, not killed, its tool calls still belong to the message`, eng.helping() && !rec.killed && !eng.proc?.idle && eng.activeOf(eng.proc?.tag || [...eng.watched][0].tag) != null && eng.owns([...eng.watched][0].tag), JSON.stringify({ helping: eng.helping(), killed: rec.killed }));
    if (mode === 'one-shot') check('one-shot process: its stdin was closed after the message (it goes on without more input)', await waitFor(() => rec.stdinEnded), 'stdin still open');

    const done1 = helperStep(rec, 'h1');
    await waitFor(() => kinds(first, 'tool').some((e) => e.id === 'cc-h1'));
    const row = kinds(first, 'tool').find((e) => e.id === 'cc-h1');
    check(`${label}: the helper's own tool call, after the result, is a step of the same message, flagged as the helper's`, row && row.helper === true && /^Helper · Reading slide3\.txt/.test(row.label) && row.name === 'Read', JSON.stringify(row));
    done1();
    await waitFor(() => kinds(first, 'tool_done').some((e) => e.id === 'cc-h1'));
    check(`${label}: ...and its result ends the step`, kinds(first, 'tool_done').find((e) => e.id === 'cc-h1')?.ok === true && kinds(first, 'tool_done').find((e) => e.id === 'cc-h1')?.helper === true);
    rec.out({ type: 'assistant', parent_tool_use_id: 'ag1', message: { content: [{ type: 'tool_use', id: 'h2', name: 'mcp__lumen__list_tabs', input: {} }] } });
    helperStep(rec, 'h3');
    rec.out({ type: 'system', subtype: 'task_progress', task_id: 'T1', description: 'Checking slide 4' });
    await waitFor(() => kinds(first, 'helper').some((e) => e.state === 'progress'));
    check(`${label}: the helper's Lumen tool call is not drawn here (it reaches Lumen over MCP and draws itself); a task_progress is its words`, !kinds(first, 'tool').some((e) => e.id === 'cc-h2') && kinds(first, 'helper').find((e) => e.state === 'progress')?.label === 'Checking slide 4', JSON.stringify(first.filter((e) => e.type === 'tool' || e.type === 'helper')));
    check(`${label}: none of it reached the follow-up's emit or ended the helper`, !second.length && eng.helping() && !handed.length);

    endHelper(rec);
    await waitFor(() => kinds(first, 'helper').some((e) => e.state === 'done'));
    const ended = kinds(first, 'helper').find((e) => e.state === 'done');
    check(`${label}: the helper ending is said (done, none left), and its unfinished step ends with it`, ended && ended.count === 0 && kinds(first, 'tool_done').some((e) => e.id === 'cc-h3' && e.ok === true), JSON.stringify(first.filter((e) => e.type === 'helper' || e.type === 'tool_done')));

    followUpTurn(rec, 'The reviewer rates it 9/10.');
    await waitFor(() => followed);
    check(`${label}: the CLI's own turn is handed to onFollowUp, once, with its process`, handed.length === 1 && handed[0].child === rec.child, String(handed.length));
    check(`${label}: ...and a run({ adopt }) reads it: its words, its result, nothing sent to the CLI`, followed && followed.text === 'The reviewer rates it 9/10.' && !followed.failed && followed.helpers.length === 0 && kinds(second, 'text').map((e) => e.text).join('') === 'The reviewer rates it 9/10.' && rec.lines.length === 1, JSON.stringify({ followed, second, lines: rec.lines.length }));
    check(`${label}: after it nothing is kept for helpers`, !eng.helping() && !eng.proc?.watch && !rec.killed || mode === 'one-shot', JSON.stringify({ helping: eng.helping() }));
    if (mode === 'kept') check('kept process: after the follow-up it waits for the next message again (idle timer set)', Boolean(eng.proc && eng.proc.idle), 'no idle timer');
    eng.dispose();
  }

  // 2) no follow-up: the process is idle again after the grace
  {
    const { cli, eng } = rig((rec) => launch(rec));
    const ev = [];
    let called = 0;
    await eng.run(opts(ev, { onFollowUp: () => { called++; } }));
    const rec = cli.spawned[0];
    endHelper(rec);
    await waitFor(() => kinds(ev, 'helper').some((e) => e.state === 'done'));
    check('no follow-up: still kept right after the helper ended (the CLI may be about to go on)', eng.helping());
    await waitFor(() => !eng.helping(), 1500);
    check('no follow-up: after the grace the process is idle again (kept for the next message, not killed)', !eng.helping() && !rec.killed && Boolean(eng.proc?.idle) && called === 0, JSON.stringify({ helping: eng.helping(), killed: rec.killed, called }));
    eng.dispose();
  }

  // 3) the process dies while its helper works
  {
    const { cli, eng } = rig((rec) => launch(rec));
    const ev = [];
    await eng.run(opts(ev, { onFollowUp: () => {} }));
    const rec = cli.spawned[0];
    helperStep(rec, 'h1');
    await waitFor(() => kinds(ev, 'tool').some((e) => e.id === 'cc-h1'));
    rec.exit(1);
    await waitFor(() => kinds(ev, 'helper').some((e) => e.state === 'stopped'));
    const stopped = kinds(ev, 'helper').find((e) => e.state === 'stopped');
    check('the process ends while a helper works: the helper is stopped (the card must not spin for ever), and so is its step', stopped && stopped.count === 0 && kinds(ev, 'tool_done').some((e) => e.id === 'cc-h1' && e.stopped === true) && !eng.helping() && !eng.active, JSON.stringify({ ev: ev.filter((e) => e.type === 'helper' || e.type === 'tool_done'), helping: eng.helping() }));
    eng.dispose();
  }

  // 4) a helper the CLI never reports as ended is not kept for ever
  {
    const { cli, eng } = rig((rec) => launch(rec), { helperMaxMs: 150 });
    const ev = [];
    await eng.run(opts(ev, { onFollowUp: () => {} }));
    await waitFor(() => kinds(ev, 'helper').some((e) => e.state === 'stopped'), 2000);
    check('the cap: a helper that never ends is stopped and its process ended', kinds(ev, 'helper').some((e) => e.state === 'stopped') && cli.spawned[0].killed && !eng.helping(), JSON.stringify({ ev: kinds(ev, 'helper'), killed: cli.spawned[0].killed }));
    eng.dispose();
  }

  // 5) a helper that ended before the reply did: the CLI's follow-up still comes
  {
    const { cli, eng } = rig((rec) => {
      init(rec);
      rec.out({ type: 'system', subtype: 'task_started', task_id: 'T1', tool_use_id: 'ag1', description: 'Quick check', task_type: 'local_agent', is_backgrounded: true });
      endHelper(rec);
      textOf(rec, 'Checked.');
      result(rec, 'Checked.');
      setTimeout(() => followUpTurn(rec, 'The quick check passed.'), 30);
    });
    const ev = [];
    const second = [];
    let followed = null;
    const onFollowUp = ({ proc }) => eng.run(opts(second, { adopt: proc, onFollowUp })).then((r) => { followed = r; });
    const r = await eng.run(opts(ev, { onFollowUp }));
    await waitFor(() => followed);
    check('a helper that ended during the turn: the turn ends with no helper working, and the CLI\'s follow-up is still read', r.helpers.length === 0 && followed?.text === 'The quick check passed.' && kinds(ev, 'helper').map((e) => e.state).join() === 'working,done', JSON.stringify({ r, followed, h: kinds(ev, 'helper') }));
    void cli;
    eng.dispose();
  }

  // 5b) an older CLI (no task_* lines, only the async_launched result): its own follow-up turn ends the helper
  {
    const { cli, eng } = rig((rec) => {
      init(rec);
      rec.out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'ag1', name: 'Agent', input: { description: 'Old helper', run_in_background: true } }] } });
      rec.out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ag1', content: 'Async agent launched' }] }, tool_use_result: { status: 'async_launched', agentId: 'AG1', description: 'Old helper' } });
      textOf(rec, 'Started.');
      result(rec, 'Started.');
      setTimeout(() => followUpTurn(rec, 'It finished.'), 40);
    });
    const ev = [];
    const second = [];
    let followed = null;
    const onFollowUp = ({ proc }) => eng.run(opts(second, { adopt: proc, onFollowUp })).then((r) => { followed = r; });
    const r = await eng.run(opts(ev, { onFollowUp }));
    await waitFor(() => followed);
    check('an older CLI (only async_launched): the helper shows, and the follow-up turn ends it and is read', r.helpers.length === 1 && followed?.text === 'It finished.' && kinds(ev, 'helper').map((e) => e.state).join() === 'working,done' && followed.helpers.length === 0 && !eng.helping(), JSON.stringify({ r, followed, h: kinds(ev, 'helper'), helping: eng.helping() }));
    void cli;
    eng.dispose();
  }

  // 6) a new message while the helper works: its own turn on the same process, and the helper goes on
  {
    const { cli, eng } = rig((rec, msg, n) => { if (n === 1) launch(rec); else { init(rec); textOf(rec, 'Still waiting for the reviewer.'); result(rec, 'Still waiting for the reviewer.'); } });
    const first = [];
    const next = [];
    const onFollowUp = () => {};
    await eng.run(opts(first, { onFollowUp }));
    const rec = cli.spawned[0];
    const r2 = await eng.run(opts(next, { prompt: 'is it done?', onFollowUp }));
    check('a message while a helper works: answered by the same process, and the helper is still kept', r2.text === 'Still waiting for the reviewer.' && cli.spawned.length === 1 && !rec.killed && eng.helping() && r2.helpers.length === 1, JSON.stringify({ r2, spawned: cli.spawned.length, helping: eng.helping() }));
    helperStep(rec, 'h7');
    await waitFor(() => kinds(first, 'tool').some((e) => e.id === 'cc-h7'));
    check('...and the helper\'s steps still go on the card of the message that started it, not the new one', kinds(first, 'tool').some((e) => e.id === 'cc-h7') && !kinds(next, 'tool').some((e) => e.id === 'cc-h7'), JSON.stringify({ first: kinds(first, 'tool').map((e) => e.id), next: kinds(next, 'tool').map((e) => e.id) }));
    eng.dispose();
    await waitFor(() => rec.killed && !eng.helping());
    check('ending the engine ends a process kept for a helper too', rec.killed && !eng.helping(), JSON.stringify({ killed: rec.killed, helping: eng.helping() }));
  }

  // 7) a failed turn ends its helpers; a turn with no helpers is as before
  {
    const { cli, eng } = rig((rec) => {
      init(rec);
      rec.out({ type: 'system', subtype: 'task_started', task_id: 'T1', tool_use_id: 'ag1', description: 'x', task_type: 'local_agent', is_backgrounded: true });
      rec.out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', session_id: rec.session, usage: {} });
    });
    const ev = [];
    const r = await eng.run(opts(ev, { onFollowUp: () => {} }));
    check('a turn that fails does not keep its process for a helper', r.failed && !eng.helping() && kinds(ev, 'helper').some((e) => e.state === 'stopped'), JSON.stringify({ r, h: kinds(ev, 'helper') }));
    void cli;
    eng.dispose();
  }
  {
    const { cli, eng } = rig((rec) => { init(rec); textOf(rec, 'Hello.'); result(rec, 'Hello.'); });
    const ev = [];
    const r = await eng.run(opts(ev, { onFollowUp: () => { throw new Error('no follow-up expected'); } }));
    check('a turn with no helper is as before: nothing kept, idle timer set, no helper events', r.text === 'Hello.' && r.helpers.length === 0 && !eng.helping() && Boolean(eng.proc?.idle) && !kinds(ev, 'helper').length && !cli.spawned[0].killed, JSON.stringify({ r, helping: eng.helping() }));
    eng.dispose();
  }
}

(async () => {
  tracker();
  await engine();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall cc-helpers checks passed');
  process.exit(failures ? 1 : 0);
})();
