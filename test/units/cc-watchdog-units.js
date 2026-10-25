// Claude Code's silence watchdog and its connect path (plain Node, a mocked spawn, no real CLI, short real timers).
//  - a tool call that runs a long time with the CLI printing nothing (Lumen's own tool, or the CLI's in full access) is activity, not silence
//  - a long wait for the model right after a tool result is allowed AFTER_TOOL_FACTOR times the limit; a real hang is still ended at the limit
//  - the stall error says what was waited for; a sign-in prompt printed as plain text is reported as a sign-in problem
//  - a kept process that hung, or died between messages, is replaced and the message goes again by itself
//  - a binary that moved (a Claude Code update) is looked up again; a failed connection to Lumen's tools starts over once
//  - failures carry a short summary for the notification, which says to press Retry
require('../helpers/_tmp-cleanup');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const cc = require('../../src/ai/claude-code');
const CR = require('../../src/features/chat-runs');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flag = (argv, f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);

// A fake `claude`: one child per spawn; respond(rec, msg, n) answers each stream-json message. failSpawn(bin, n) may return an Error to throw.
function fakeClaude(respond, failSpawn = () => null) {
  const spawned = [];
  let attempts = 0;
  const spawn = (bin, argv) => {
    const err = failSpawn(bin, ++attempts);
    if (err) throw err;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.pid = 7000 + spawned.length;
    const rec = { bin, argv, child, lines: [], killed: false };
    rec.out = (obj) => { if (child.exitCode === null) child.stdout.write(`${JSON.stringify(obj)}\n`); };
    rec.raw = (text) => { if (child.exitCode === null) child.stdout.write(`${text}\n`); };
    rec.exit = (code = 0) => { if (child.exitCode !== null) return; child.exitCode = code; setImmediate(() => child.emit('close', code)); };
    rec.session = flag(argv, '--session-id') || flag(argv, '--resume');
    rec.resume = argv.includes('--resume');
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
    spawned.push(rec);
    return child;
  };
  const kill = (child) => { const rec = spawned.find((r) => r.child === child); if (rec) { rec.killed = true; rec.exit(null); } };
  return { spawn, kill, spawned };
}
const init = (rec, status = 'connected') => rec.out({ type: 'system', subtype: 'init', session_id: rec.session, mcp_servers: [{ name: 'lumen', status }] });
const finish = (rec, text) => {
  rec.out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  rec.out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: rec.session, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } });
};
const say = (rec, text) => { init(rec); finish(rec, text); };
const toolUse = (rec, id, name, input = {}) => rec.out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (rec, id) => rec.out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-wd-'));
  let tokens = 0;
  const gate = { open: () => ({ mcpUrl: 'http://127.0.0.1:5555/mcp', mcpToken: `tok${++tokens}`, hookUrl: 'x' }), close: () => {} };
  const rig = (respond, extra = {}, failSpawn) => {
    const cli = fakeClaude(respond, failSpawn);
    const make = (more = {}) => {
      const eng = new cc.ClaudeCodeEngine({ userData: tmp, mcpCommand: () => ({ command: 'b', args: [], env: {} }), ensureServer: () => {}, gate: async () => gate, spawn: cli.spawn, kill: cli.kill, retryDelayMs: 10, startWait: async () => {}, watchdogMs: 40, startupWatchdogMs: 40, slowStartMs: 0, ...extra, ...more });
      eng.bin = process.execPath;
      return eng;
    };
    return { cli, make };
  };
  const opts = (events, o = {}) => ({ prompt: 'hello', sessionId: 'sess-1', resume: false, systemPrompt: 'SYS', signal: new AbortController().signal, emit: (e) => events.push(e), ...o });
  const errors = (ev) => ev.filter((e) => e.type === 'error');

  // 1) a Lumen tool call that runs 10x the silence limit (generate_image, read_pdf) with no CLI output: not ended.
  {
    let eng;
    const { cli, make } = rig(async (rec) => {
      init(rec);
      toolUse(rec, 'tu1', 'mcp__lumen__generate_image');
      const call = eng.active; // Lumen's MCP handler holds the run's active object while it executes the tool
      eng.callBegin(call);
      await sleep(400); // (a real one: 60-120 s against the 90 s limit)
      eng.callEnd(call);
      toolResult(rec, 'tu1');
      finish(rec, 'here is your picture');
    });
    eng = make();
    const ev = [];
    const r = await eng.run(opts(ev));
    check('long Lumen tool call: 10x the limit with no output is not a hang', r.text === 'here is your picture' && !r.failed && !cli.spawned[0].killed && !errors(ev).length, JSON.stringify({ r, ev }));
    eng.dispose();
  }

  // 1b) the CLI's own tool (full access): a tool_use with no tool_result for 10x the limit is activity too.
  {
    const { cli, make } = rig(async (rec) => {
      init(rec);
      toolUse(rec, 'b1', 'Bash', { command: 'sleep 120' });
      await sleep(400);
      toolResult(rec, 'b1');
      finish(rec, 'shell done');
    });
    const eng = make();
    const ev = [];
    const r = await eng.run(opts(ev, { fullAccess: true }));
    check('long CLI tool call (full access): no tool_result for 10x the limit is not a hang', r.text === 'shell done' && !r.failed && !cli.spawned[0].killed && !errors(ev).length, JSON.stringify({ r, ev }));
    eng.dispose();
  }

  // 2) after a tool result the model may take a while to start answering: 3x the limit is fine, then the watchdog is back.
  {
    const { cli, make } = rig(async (rec) => {
      init(rec);
      toolUse(rec, 'tu2', 'mcp__lumen__read_pdf');
      toolResult(rec, 'tu2');
      await sleep(110); // 2.75x the 40 ms limit
      finish(rec, 'summary of the pdf');
    });
    const eng = make();
    const ev = [];
    const r = await eng.run(opts(ev));
    check('slow model start after a tool result (under AFTER_TOOL_FACTOR x the limit) is allowed', r.text === 'summary of the pdf' && !r.failed && !cli.spawned[0].killed, JSON.stringify({ r, ev }));
    eng.dispose();

    const hung = rig(async (rec) => { init(rec); toolUse(rec, 'tu3', 'mcp__lumen__read_pdf'); toolResult(rec, 'tu3'); });
    const e2 = hung.make();
    const ev2 = [];
    const t0 = Date.now();
    const r2 = await e2.run(opts(ev2));
    const took = Date.now() - t0;
    check('silence after a tool result past AFTER_TOOL_FACTOR x the limit is still ended', r2.failed && hung.cli.spawned[0].killed && /stopped responding/.test(errors(ev2)[0]?.text || '') && took >= 40 * 3 && took < 40 * 12, JSON.stringify({ r2, ev2, took }));
    e2.dispose();
  }

  // 3) a real hang (nothing for the limit, no tool running): ended at the limit, with the plain error naming what it waited for.
  {
    const { cli, make } = rig(async (rec) => { init(rec); toolUse(rec, 'tu4', 'mcp__lumen__read_page'); }); // the call never reaches Lumen
    const eng = make();
    const ev = [];
    const t0 = Date.now();
    const r = await eng.run(opts(ev));
    const err = errors(ev)[0];
    check('real hang: a tool call that never reached Lumen is ended at the limit', r.failed && cli.spawned.length === 1 && cli.spawned[0].killed && Date.now() - t0 < 40 * 6, JSON.stringify({ r, ev }));
    check('real hang: the error names the tool, says to press Retry, carries a summary and noFallback', /stopped responding/.test(err?.text || '') && /while waiting for read_page/.test(err.text) && /Retry/.test(err.text) && err.summary === 'Claude Code stopped responding' && err.noFallback === true, JSON.stringify(err));
    eng.dispose();
  }

  // 4) a sign-in prompt printed as plain text, then silence: the error is the sign-in one, not "stopped responding".
  {
    const { cli, make } = rig((rec) => { rec.raw('Invalid API key · Please run /login'); });
    const eng = make();
    const ev = [];
    const r = await eng.run(opts(ev));
    const err = errors(ev)[0];
    check('plain-text sign-in prompt: reported as not signed in, with a summary', r.failed && cli.spawned[0].killed && /not signed in/.test(err?.text || '') && err.summary === 'Claude Code is not signed in', JSON.stringify(ev));
    eng.dispose();
  }

  // 4b) a start that prints nothing: the error says it was starting.
  {
    const { make } = rig(() => {});
    const eng = make();
    const ev = [];
    await eng.run(opts(ev));
    const err = errors(ev)[0];
    check('silent start: the error says so, offers Retry and keeps noFallback', /stopped responding while starting/.test(err?.text || '') && /Retry/.test(err.text) && err.summary === 'Claude Code did not start' && err.noFallback === true, JSON.stringify(ev));
    eng.dispose();
  }

  // 5) a kept process that hangs on the next message (nothing ran): replaced, the message goes again, no error.
  {
    let n = 0;
    const { cli, make } = rig((rec) => { n++; if (n === 2 && rec === cli.spawned[0]) return; say(rec, `answer ${n}`); }); // (spawn 1's second message is never answered)
    const eng = make();
    const e1 = [];
    const r1 = await eng.run(opts(e1));
    const e2 = [];
    const r2 = await eng.run(opts(e2, { sessionId: 'sess-1', resume: true, prompt: 'second' }));
    check('kept process hung between messages: dropped, started fresh, answered, no error', r1.text === 'answer 1' && r2.text === 'answer 3' && !r2.failed && cli.spawned.length === 2 && cli.spawned[0].killed && !errors(e2).length && e2.some((e) => e.type === 'status' && /reconnecting/.test(e.text)), JSON.stringify({ r1, r2, e2, spawned: cli.spawned.length }));
    check('kept process hung: the new process resumes the chat session', cli.spawned[1].resume === true, JSON.stringify(cli.spawned[1].argv));
    eng.dispose();
  }

  // 6) a warm process that died between messages: the next message starts a fresh one by itself.
  {
    const { cli, make } = rig((rec, msg, n) => say(rec, `ok ${cli.spawned.indexOf(rec) + 1}`));
    const eng = make();
    const r1 = await eng.run(opts([]));
    cli.spawned[0].exit(1); // it dies while idle
    await sleep(20);
    const ev = [];
    const r2 = await eng.run(opts(ev, { sessionId: 'sess-1', resume: true }));
    check('warm process died while idle: the next message starts a fresh process and answers', r1.text === 'ok 1' && r2.text === 'ok 2' && !r2.failed && cli.spawned.length === 2 && !errors(ev).length, JSON.stringify({ r1, r2, ev }));
    eng.dispose();
  }

  // 6b) ... and one that dies on receiving the message (kept, then crashed): sent again once on a fresh process.
  {
    const { cli, make } = rig((rec) => { if (rec === cli.spawned[0] && rec.lines.length > 1) { rec.exit(1); return; } say(rec, `ok ${cli.spawned.indexOf(rec) + 1}`); });
    const eng = make();
    await eng.run(opts([]));
    const ev = [];
    const r2 = await eng.run(opts(ev, { sessionId: 'sess-1', resume: true }));
    check('warm process died on the message: sent again on a fresh process, no error shown', r2.text === 'ok 2' && !r2.failed && cli.spawned.length === 2 && !errors(ev).length, JSON.stringify({ r2, ev }));
    eng.dispose();
  }

  // 7) the binary moved (Claude Code updated itself): looked up again, the message goes on with the new path.
  {
    const oldBin = path.join(tmp, 'claude-old.exe');
    const newBin = path.join(tmp, 'claude-new.exe');
    fs.writeFileSync(oldBin, '');
    fs.writeFileSync(newBin, '');
    const saved = process.env.LUMEN_CLAUDE_BIN;
    const { cli, make } = rig((rec) => say(rec, 'from the new copy'), {}, (bin) => (bin === oldBin ? Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) : null));
    const eng = make();
    eng.bin = oldBin; // found earlier; the file is there when checked and gone when run (an update swapped it)
    process.env.LUMEN_CLAUDE_BIN = newBin;
    const ev = [];
    const r = await eng.run(opts(ev));
    check('binary moved: found again at the new path and the message is answered', r.text === 'from the new copy' && !r.failed && cli.spawned.length === 1 && cli.spawned[0].bin === newBin && eng.bin === newBin && !errors(ev).length && ev.some((e) => e.type === 'status' && /updating/.test(e.text)), JSON.stringify({ r, ev, bin: eng.bin })); // (a file that was there a moment ago is waited for and looked up again: cli-utils startChild)
    eng.dispose();

    // gone for good: one specific error with the install fix, and it is looked for again on the next message
    const gone = rig((rec) => say(rec, 'x'), {}, () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    const e2 = gone.make();
    e2.bin = oldBin;
    process.env.LUMEN_CLAUDE_BIN = path.join(tmp, 'nowhere.exe');
    const ev2 = [];
    const r2 = await e2.run(opts(ev2));
    const err = errors(ev2)[0];
    check('binary gone: names the old path, gives the install fix and a summary', r2.failed && /isn't installed at .*claude-old\.exe/.test(err?.text || '') && /install/i.test(err.text) && err.summary === 'Claude Code was not found' && e2.bin === null, JSON.stringify(ev2));
    if (saved === undefined) delete process.env.LUMEN_CLAUDE_BIN; else process.env.LUMEN_CLAUDE_BIN = saved;
    e2.dispose();
  }

  // 8) the CLI cannot connect to Lumen's tools: dropped and started over once; if that fails too, one specific error.
  {
    const { cli, make } = rig((rec) => { if (rec === cli.spawned[0]) { init(rec, 'failed'); return; } say(rec, 'connected the second time'); });
    const eng = make();
    const ev = [];
    const r = await eng.run(opts(ev));
    check('MCP connection failed: dropped, started again, answered, no error', r.text === 'connected the second time' && !r.failed && cli.spawned.length === 2 && cli.spawned[0].killed && !errors(ev).length, JSON.stringify({ r, ev }));
    eng.dispose();

    const bad = rig((rec) => init(rec, 'failed'));
    const e2 = bad.make();
    const ev2 = [];
    const r2 = await e2.run(opts(ev2));
    const err = errors(ev2)[0];
    check('MCP connection keeps failing: one retry, then one error naming the status and the fix', r2.failed && bad.cli.spawned.length === 2 && errors(ev2).length === 1 && /could not connect to Lumen's tools \(failed\)/.test(err.text) && /Restart Lumen/.test(err.text) && err.summary === 'Claude Code could not connect to Lumen', JSON.stringify(ev2));
    e2.dispose();
  }

  // 9) a session id the CLI still holds from a start that never finished: the chat is continued with --resume.
  {
    const { cli, make } = rig((rec) => { if (!rec.resume) rec.out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `Error: Session ID ${rec.session} is already in use.`, session_id: rec.session }); else say(rec, 'continued'); });
    const eng = make();
    const ev = [];
    const r = await eng.run(opts(ev));
    check('session id already in use: retried once with --resume, answered, no error', r.text === 'continued' && !r.failed && cli.spawned.length === 2 && cli.spawned[1].resume === true && !errors(ev).length, JSON.stringify({ r, ev }));
    eng.dispose();
  }

  // 10) error wording and the notification
  {
    const port = cc.describeFailure('Error: listen EADDRINUSE: address already in use 127.0.0.1:5555', 1);
    const perm = cc.describeFailure('spawn EPERM [lumen-start:unchanged]', -1); // EPERM that stayed after the retries with the file untouched: a real block
    const lost = cc.describeFailure('No conversation found with session ID: abc', 1);
    check('describeFailure: a port in use, a blocked start and a lost session each say what to do', /port .* already in use/.test(port.text) && /Retry/.test(port.text) && /security software/.test(perm.text) && /fresh session/.test(lost.text) && port.summary && perm.summary && lost.summary, JSON.stringify({ port, perm, lost }));
    check('describeFailure: an unknown failure keeps the CLI words', /stopped \(exit 2\): boom/.test(cc.describeFailure('boom', 2).text), '');
    check('transientFailure: a process killed with nothing said is retried; a clean exit is not', cc.transientFailure('', null) && !cc.transientFailure('', 0), '');
    const note = CR.notification('failed', { error: 'Claude Code stopped responding for 90 seconds, so Lumen ended it. Press Retry to pick up where it left off.', summary: 'Claude Code stopped responding', chat: 'generate image to explain this slide' });
    check('notification: the title is the short summary, the body says to press Retry', note.title === 'Lumen stopped: Claude Code stopped responding' && /press Retry/.test(note.body) && /generate image/.test(note.body), JSON.stringify(note));
    check('notification: an error without a summary is as before', CR.notification('failed', { error: 'Rate limited.\nlater' }).title === 'Lumen stopped: Rate limited.', '');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures) { console.log(`\n${failures} check(s) FAILED`); process.exit(1); }
  console.log('\nall Claude Code watchdog checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
