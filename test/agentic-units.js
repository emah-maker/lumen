// Agentic speed paths, plain Node (no Electron, no real CLI): Claude Code's kept process over
// stream-json (turn boundaries, reuse, stop/respawn with --resume, one-shot mode, expired sessions,
// early step rows, HTTP MCP config and the stdio fallback), compact-read dedupe, batch's baseline,
// the registry-only page script, routing pinned per session, transcript exchange resets, the
// DuckDuckGo HTML parser and the after-action settle.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flag = (argv, f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);

// ---- a fake `claude`: one child per spawn, reads stream-json lines, answers through `respond`
function fakeClaude(respond, control = () => {}) { // control: what the CLI does with an interrupt (default: nothing, a hung CLI)
  const spawned = [];
  const spawn = (bin, argv, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.pid = 4000 + spawned.length;
    const rec = { argv, opts, child, lines: [], controls: [], ended: false, killed: false, mcp: JSON.parse(fs.readFileSync(flag(argv, '--mcp-config'), 'utf8')) };
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
          // A control_request (Stop's interrupt) is not a message: recorded apart, answered by `control`.
          if (msg.type === 'control_request') { rec.controls.push(msg); setImmediate(() => control(rec, msg)); continue; }
          rec.lines.push(msg);
          setImmediate(() => respond(rec, msg, rec.lines.length));
        }
        cb();
      },
      final(cb) { rec.ended = true; cb(); },
    });
    spawned.push(rec);
    return child;
  };
  const kill = (child) => { const rec = spawned.find((r) => r.child === child); if (rec) { rec.killed = true; rec.exit(null); } };
  return { spawn, kill, spawned };
}
const say = (rec, text, extra = {}) => {
  rec.out({ type: 'system', subtype: 'init', session_id: rec.session, mcp_servers: [{ name: 'lumen', status: 'connected' }] });
  rec.out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  rec.out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  rec.out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: rec.session, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 }, ...extra });
  if (rec.ended) rec.exit(0); // one-shot: stdin closed, the CLI ends after its result
};
const echo = (rec, msg, n) => say(rec, `reply ${n}: ${msg.message.content[0].text}`);

async function engineRuns() {
  const cc = require('../src/ai/claude-code');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-agentic-'));
  const gateLog = { opened: [], closed: [] };
  let tokens = 0;
  const gate = { open: (tag) => { gateLog.opened.push(tag); return { mcpUrl: 'http://127.0.0.1:5555/mcp', mcpToken: `tok${++tokens}`, hookUrl: 'x' }; }, close: (tag) => gateLog.closed.push(tag) };
  let respond = echo;
  let control = () => {};
  const cli = fakeClaude((...a) => respond(...a), (...a) => control(...a));
  let ensured = 0;
  const make = (extra = {}) => {
    const eng = new cc.ClaudeCodeEngine({ userData: tmp, mcpCommand: () => ({ command: 'lumen-bridge', args: ['mcp.js'], env: { ELECTRON_RUN_AS_NODE: '1' } }), ensureServer: () => { ensured++; }, gate: async () => gate, spawn: cli.spawn, kill: cli.kill, ...extra });
    eng.bin = process.execPath; // exists on disk: ensureBin takes it as found
    return eng;
  };
  const opts = (o = {}) => ({ prompt: 'hello', sessionId: 'sess-1', resume: false, systemPrompt: 'SYS', signal: new AbortController().signal, emit: (e) => events.push(e), ...o });
  let events = [];

  // Warm first (runTask), then the message: one process, started before run().
  const eng = make({ interruptMs: 60 });
  eng.warm({ sessionId: 'sess-1', resume: false, systemPrompt: 'SYS', model: 'default', maxTurns: 0 });
  await sleep(20);
  check('warm: the CLI is started before the message', cli.spawned.length === 1, String(cli.spawned.length));
  const first = cli.spawned[0];
  const r1 = await eng.run(opts());
  check('turn 1: the reply ends at the result event, the process stays up with stdin open', r1.text === 'reply 1: hello' && r1.sessionId === 'sess-1' && !r1.failed && first.child.exitCode === null && !first.ended, JSON.stringify(r1));
  check('argv: --system-prompt replaces the default prompt, --session-id for a new chat', flag(first.argv, '--system-prompt') === 'SYS' && !first.argv.includes('--append-system-prompt') && flag(first.argv, '--session-id') === 'sess-1' && flag(first.argv, '--input-format') === 'stream-json', first.argv.join(' '));
  const lumen = first.mcp.mcpServers.lumen;
  check('mcp config: Lumen\'s HTTP server with this process\'s bearer token, no bridge command', lumen.type === 'http' && lumen.url === 'http://127.0.0.1:5555/mcp' && lumen.headers.Authorization === 'Bearer tok1' && !lumen.command && ensured === 0, JSON.stringify(lumen));
  check('between messages: the kept process owns its tag, no message is active', eng.owns(gateLog.opened[0]) && eng.active === null && !eng.owns('x'.repeat(36)), '');

  const r2 = await eng.run(opts({ prompt: 'again', resume: true }));
  check('turn 2: the same process takes the next line (no new spawn, no new token)', cli.spawned.length === 1 && first.lines.length === 2 && r2.text === 'reply 2: again' && gateLog.opened.length === 1, JSON.stringify({ n: cli.spawned.length, r2 }));

  // A model change: another process, resuming the session; the old one and its token go.
  await eng.run(opts({ prompt: 'harder', resume: true, model: 'opus' }));
  const second = cli.spawned[1];
  check('model change: a new process with --resume and --model, the old one killed and its token revoked', cli.spawned.length === 2 && flag(second.argv, '--resume') === 'sess-1' && flag(second.argv, '--model') === 'opus' && first.killed && gateLog.closed.includes(gateLog.opened[0]), JSON.stringify({ n: cli.spawned.length, killed: first.killed, closed: gateLog.closed }));

  // Stop mid-message: fast, the tree is killed, and the next message respawns with --resume.
  respond = () => {}; // never answers
  const ctl = new AbortController();
  const pending = eng.run(opts({ prompt: 'slow', resume: true, model: 'opus', signal: ctl.signal }));
  await sleep(20);
  const t0 = Date.now();
  ctl.abort();
  const stopped = await pending;
  check('stop: resolves at once as stopped; the CLI is asked to interrupt first', stopped.stopped === true && Date.now() - t0 < 50 && !second.killed && second.controls.length === 1 && second.controls[0].request?.subtype === 'interrupt' && /^lumen-stop-/.test(second.controls[0].request_id), JSON.stringify({ stopped, controls: second.controls }));
  await sleep(120);
  check('stop: a CLI that never answers the interrupt is killed after the wait', second.killed, '');
  respond = echo;
  const r3 = await eng.run(opts({ prompt: 'back', resume: true, model: 'opus' }));
  check('after stop: the next message gets a new process resuming the session', cli.spawned.length === 3 && flag(cli.spawned[2].argv, '--resume') === 'sess-1' && r3.text === 'reply 1: back', JSON.stringify(r3));

  // A kept process that died between messages without a word is started again transparently.
  const third = cli.spawned[2];
  respond = (rec, msg, n) => (rec === third && n === 2 ? rec.exit(1) : echo(rec, msg, n));
  const r4 = await eng.run(opts({ prompt: 'crash?', resume: true, model: 'opus' }));
  check('a kept process dying at the write is retried once on a fresh one', cli.spawned.length === 4 && r4.text === 'reply 1: crash?' && !r4.failed, JSON.stringify(r4));
  respond = echo;

  // release(): the chat switched away; the idle process and its token go.
  const fourth = cli.spawned[3];
  eng.release();
  await sleep(5);
  check('release: the idle kept process is killed', fourth.killed && eng.proc === null, '');

  // Stop that the CLI honours: it interrupts, the rest of the old turn is read off, the process stays.
  const kept = make({ interruptMs: 400 });
  await kept.run(opts({ sessionId: 'sess-int' }));
  const keptRec = cli.spawned[cli.spawned.length - 1];
  respond = () => {};
  control = (rec, msg) => { // stale output of the stopped turn, the ack, then its result
    rec.out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'STALE' } } });
    rec.out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
    rec.out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'interrupted', session_id: rec.session });
  };
  const ctlInt = new AbortController();
  const hung = kept.run(opts({ prompt: 'hang', sessionId: 'sess-int', resume: true, signal: ctlInt.signal }));
  await sleep(20);
  ctlInt.abort();
  const hungOut = await hung;
  respond = echo;
  const afterInt = await kept.run(opts({ prompt: 'next', sessionId: 'sess-int', resume: true }));
  check('stop honoured: the process is kept, the old turn\'s leftover lines are not read as the next reply', hungOut.stopped && !keptRec.killed && cli.spawned[cli.spawned.length - 1] === keptRec && afterInt.text === 'reply 3: next' && !afterInt.failed, JSON.stringify({ hungOut, afterInt, n: cli.spawned.length }));
  control = () => {};
  kept.dispose();

  // Usage: a kept process whose totals are running sums reports each message's own share.
  const cum = [{ c: 0.01, i: 100, o: 10, r: 5 }, { c: 0.03, i: 250, o: 30, r: 10 }, { c: 0.04, i: 300, o: 45, r: 15 }];
  respond = (rec, msg, n) => say(rec, `t${n}`, { total_cost_usd: cum[n - 1].c, usage: { input_tokens: cum[n - 1].i, output_tokens: cum[n - 1].o, cache_read_input_tokens: cum[n - 1].r }, modelUsage: { m: { inputTokens: cum[n - 1].i, contextWindow: 200000 } } });
  const sums = make();
  const u1 = await sums.run(opts({ sessionId: 'sess-sum' }));
  const u2 = await sums.run(opts({ sessionId: 'sess-sum', resume: true }));
  const u3 = await sums.run(opts({ sessionId: 'sess-sum', resume: true }));
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  check('usage: cumulative totals from a kept process become per-message deltas', near(u1.cost, 0.01) && near(u2.cost, 0.02) && near(u3.cost, 0.01) && [u1, u2, u3].map((u) => u.usage.inputTokens).join() === '100,150,50' && [u1, u2, u3].map((u) => u.usage.outputTokens).join() === '10,20,15' && u2.usage.cacheReadTokens === 5 && u2.usage.contextWindow === 200000, JSON.stringify([u1, u2, u3]));
  // Per-turn totals (one goes down) are taken as they are, and stay that way for the process.
  const per = [{ c: 0.05, i: 100 }, { c: 0.02, i: 50 }, { c: 0.06, i: 200 }];
  respond = (rec, msg, n) => say(rec, `p${n}`, { total_cost_usd: per[n - 1].c, usage: { input_tokens: per[n - 1].i, output_tokens: 5 } });
  const pt = make();
  await pt.run(opts({ sessionId: 'sess-per' }));
  const p2 = await pt.run(opts({ sessionId: 'sess-per', resume: true }));
  const p3 = await pt.run(opts({ sessionId: 'sess-per', resume: true }));
  check('usage: per-turn totals are left alone (a decrease latches it; later larger ones are not subtracted)', near(p2.cost, 0.02) && p2.usage.inputTokens === 50 && near(p3.cost, 0.06) && p3.usage.inputTokens === 200, JSON.stringify([p2, p3]));
  sums.dispose();
  pt.dispose();
  respond = echo;

  // Watchdog: a CLI that goes silent is ended with an error; the next message resumes the session.
  const dog = make({ watchdogMs: 60 });
  respond = () => {};
  events = [];
  const d1 = await dog.run(opts({ sessionId: 'sess-dog' }));
  const dogRec = cli.spawned[cli.spawned.length - 1];
  check('watchdog: silence ends the message with an error and the process', d1.failed && dogRec.killed && events.some((e) => e.type === 'error' && /stopped responding/.test(e.text)) && dog.proc === null, JSON.stringify({ d1, events }));
  respond = echo;
  const d2 = await dog.run(opts({ prompt: 'again', sessionId: 'sess-dog', resume: true }));
  check('watchdog: the next message starts a process with --resume', d2.text === 'reply 1: again' && flag(cli.spawned[cli.spawned.length - 1].argv, '--resume') === 'sess-dog', JSON.stringify(d2));
  dog.dispose();
  // ...but a Lumen tool call in flight (an approval card waiting on the user) pauses it.
  const pause = make({ watchdogMs: 60 });
  respond = async (rec) => { pause.callBegin(); await sleep(180); pause.callEnd(); say(rec, 'waited'); };
  const pr = await pause.run(opts({ sessionId: 'sess-pause' }));
  check('watchdog: paused while a tool call is running', pr.text === 'waited' && !pr.failed, JSON.stringify(pr));
  pause.dispose();
  respond = echo;

  // A message that ran a tool is not sent again when the kept process then dies.
  const rt = make();
  await rt.run(opts({ sessionId: 'sess-rt' }));
  const rtRec = cli.spawned[cli.spawned.length - 1];
  const spawnedBefore = cli.spawned.length;
  respond = (rec, msg, n) => { if (rec === rtRec && n === 2) { rt.callBegin(); rt.callEnd(); rec.exit(1); } else echo(rec, msg, n); };
  const acted = await rt.run(opts({ prompt: 'acted', sessionId: 'sess-rt', resume: true }));
  check('no silent re-send after a tool call ran: the failure is reported, no fresh process', acted.failed && cli.spawned.length === spawnedBefore, JSON.stringify({ acted, n: cli.spawned.length - spawnedBefore }));
  respond = echo;
  rt.dispose();

  // release() while warm() is still starting: that process doesn't linger.
  const wr = make();
  wr.warm({ sessionId: 'sess-wr', resume: false, systemPrompt: 'SYS', model: 'default', maxTurns: 0 });
  wr.release();
  await sleep(30);
  const wrRec = cli.spawned[cli.spawned.length - 1];
  check('release during warm: the process it was starting is disposed when it lands', wrRec.session === 'sess-wr' && wrRec.killed && wr.proc === null, String(wrRec.killed));

  // Early step rows: a long-streaming tool call shows a row, and the MCP call reports into it.
  events = [];
  respond = async (rec, msg, n) => {
    rec.out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'mcp__lumen__fill_form', input: {} } } });
    await sleep(cc.EARLY_STEP_MS + 80);
    rec.claimed = eng.claimStep('fill_form');
    eng.updateStep(rec.claimed, 'fill_form', { fields: [1] }, 'Filling in the sign-up form');
    rec.out({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_2', name: 'mcp__lumen__click', input: {} } } });
    await sleep(10);
    rec.fast = eng.claimStep('click');
    say(rec, 'done');
  };
  await eng.run(opts({ prompt: 'form', resume: true }));
  const rec5 = cli.spawned[cli.spawned.length - 1];
  const rows = events.filter((e) => e.type === 'tool');
  check('early row: a tool call still streaming after 300 ms shows a step row, which the MCP call claims', rows.length === 1 && rows[0].id === 'cc-toolu_1' && rows[0].name === 'fill_form' && rows[0].label === 'Filling in a form' && rec5.claimed === 'cc-toolu_1', JSON.stringify({ rows, claimed: rec5.claimed }));
  const upd = events.filter((e) => e.type === 'tool_update');
  check('early row: once the call arrives, a tool_update names the step specifically', upd.length === 1 && upd[0].id === 'cc-toolu_1' && upd[0].label === 'Filling in the sign-up form' && upd[0].input.fields[0] === 1, JSON.stringify(upd));
  check('early row: a quick call gets no early row (its own labelled row instead)', rec5.fast === null && !rows.some((e) => e.name === 'click'), String(rec5.fast));
  respond = echo;

  // Expired session: quiet for the caller that retries, an error for the rest.
  respond = (rec) => { rec.out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'No conversation found with session ID: gone', session_id: 'gone' }); };
  events = [];
  const quiet = await eng.run(opts({ prompt: 'x', sessionId: 'gone', resume: true, quietExpired: true }));
  check('expired (quietExpired): { expired } with no error shown', quiet.expired === true && quiet.sessionId === null && !events.some((e) => e.type === 'error'), JSON.stringify({ quiet, events }));
  const loud = await eng.run(opts({ prompt: 'x', sessionId: 'gone', resume: true }));
  check('expired (plain): the error is shown and the session forgotten', !loud.expired && loud.failed && loud.sessionId === null && events.some((e) => e.type === 'error'), JSON.stringify(loud));
  respond = echo;

  // Idle timeout.
  const idle = make({ idleMs: 40 });
  await idle.run(opts({ sessionId: 'sess-idle' }));
  const idleRec = cli.spawned[cli.spawned.length - 1];
  await sleep(80);
  check('idle: a kept process is stopped after the idle timeout', idleRec.killed && idle.proc === null, '');

  // One-shot (background tasks): stdin closes after the message, nothing is kept.
  const bg = make({ keepAlive: false });
  const rb = await bg.run(opts({ sessionId: 'sess-bg' }));
  const bgRec = cli.spawned[cli.spawned.length - 1];
  await sleep(10);
  check('one-shot: stdin ends after the one message and the process ends by itself', rb.text === 'reply 1: hello' && bgRec.ended && !bgRec.killed && bgRec.child.exitCode === 0, JSON.stringify(rb));
  bg.warm({ sessionId: 'sess-bg2', resume: false, systemPrompt: 'SYS' });
  await sleep(10);
  check('one-shot: warm() starts nothing', cli.spawned[cli.spawned.length - 1] === bgRec, '');

  // A turn cap: one process per message, the next one started ahead (resuming) once this one ends.
  const capped = make();
  const before = cli.spawned.length;
  await capped.run(opts({ sessionId: 'sess-cap', maxTurns: 30 }));
  await sleep(30);
  const capRecs = cli.spawned.slice(before);
  check('turn cap: the message\'s process ends, the next one is pre-started with --resume', capRecs.length === 2 && capRecs[0].ended && flag(capRecs[1].argv, '--resume') === 'sess-cap' && flag(capRecs[1].argv, '--max-turns') === '30' && capRecs[1].lines.length === 0, JSON.stringify(capRecs.map((r) => r.argv.join(' '))));
  await capped.run(opts({ prompt: 'next', sessionId: 'sess-cap', resume: true, maxTurns: 30 }));
  const tookNext = cli.spawned.slice(before).filter((r) => r.lines.some((l) => l.message.content[0].text === 'next'));
  check('turn cap: the pre-started process takes the next message', tookNext.length === 1 && tookNext[0] === capRecs[1], String(cli.spawned.length - before));
  await sleep(30);
  capped.dispose();

  // A capped chat whose next message may want another process (an auto-routed tier that can still go up): none is pre-started.
  const noPre = make();
  const noPreBefore = cli.spawned.length;
  await noPre.run(opts({ sessionId: 'sess-np', maxTurns: 30, prestart: false }));
  await sleep(30);
  check('turn cap: prestart false starts no process for the next message', cli.spawned.length === noPreBefore + 1, String(cli.spawned.length - noPreBefore));
  noPre.dispose();
  // The read cache is reset for a process only when a message takes it, never for one that is merely warm.
  let freshCalls = 0;
  const fr = make({ onFresh: () => { freshCalls++; } });
  fr.warm({ sessionId: 'sess-fr', resume: false, systemPrompt: 'SYS', model: 'default', maxTurns: 0 });
  await sleep(20);
  check('onFresh: a warm process no message has taken has not reset the read cache', cli.spawned.length > 0 && freshCalls === 0, String(freshCalls));
  await fr.run(opts({ sessionId: 'sess-fr' }));
  await fr.run(opts({ sessionId: 'sess-fr', resume: true }));
  check('onFresh: reset once, when the first message takes the process (not again for the kept one)', freshCalls === 1, String(freshCalls));
  fr.dispose();

  // A speculative (composer-focus) warm that no message takes is released after prewarmIdleMs, not the 10-min idle.
  const pw = make({ prewarmIdleMs: 40, idleMs: 5000 });
  pw.warm({ sessionId: 'sess-pw', resume: false, systemPrompt: 'SYS', model: 'haiku', maxTurns: 0 }, { speculative: true });
  await sleep(15);
  const pwRec = cli.spawned[cli.spawned.length - 1];
  check('prewarm idle: a speculative process is up at first', pwRec.session === 'sess-pw' && !pwRec.killed, '');
  await sleep(80);
  check('prewarm idle: an unused speculative process is released after the short timeout', pwRec.killed && pw.proc === null, '');
  const pw2 = make({ prewarmIdleMs: 40, idleMs: 5000 });
  pw2.warm({ sessionId: 'sess-pw2', resume: false, systemPrompt: 'SYS', model: 'haiku', maxTurns: 0 }, { speculative: true });
  await sleep(15);
  const pw2Rec = cli.spawned[cli.spawned.length - 1];
  await pw2.run(opts({ sessionId: 'sess-pw2', model: 'haiku' }));
  await sleep(80);
  check('prewarm idle: a process a message took is on the normal idle timeout', !pw2Rec.killed && pw2.proc !== null, '');
  pw2.dispose();

  // Pre-warm backoff: an unused warm process that dies on its own pauses pre-warming (doubling), a good turn resets it.
  const bo = make({ warmBackoffMs: 300, warmBackoffMaxMs: 600 }); // (generous: a loaded machine delays timers by 100+ ms)
  check('backoff: pre-warming is allowed at first', bo.canPrewarm() === true, '');
  const dieWarm = async (id) => {
    bo.warm({ sessionId: id, resume: false, systemPrompt: 'SYS', model: 'haiku', maxTurns: 0 }, { speculative: true });
    await sleep(15);
    cli.spawned[cli.spawned.length - 1].exit(1);
    await sleep(15);
  };
  await dieWarm('sess-bo1');
  check('backoff: after an unused process dies, pre-warming pauses (the base delay)', bo.canPrewarm() === false && bo.warmBlock.delay === 300, JSON.stringify(bo.warmBlock));
  await sleep(330);
  check('backoff: and resumes once the delay passes', bo.canPrewarm() === true, '');
  await dieWarm('sess-bo2');
  check('backoff: a second failure doubles the delay', bo.warmBlock.delay === 600 && bo.canPrewarm() === false, JSON.stringify(bo.warmBlock));
  await sleep(630);
  await dieWarm('sess-bo3');
  check('backoff: the delay is capped at the max', bo.warmBlock.delay === 600, JSON.stringify(bo.warmBlock));
  await bo.run(opts({ sessionId: 'sess-bo4' }));
  check('backoff: a successful turn resets it', bo.warmBlock.delay === 0 && bo.canPrewarm() === true, JSON.stringify(bo.warmBlock));
  bo.dispose();
  const killedOurs = make({ warmBackoffMs: 60 });
  killedOurs.warm({ sessionId: 'sess-bo5', resume: false, systemPrompt: 'SYS', model: 'haiku', maxTurns: 0 });
  await sleep(15);
  killedOurs.release();
  await sleep(15);
  check('backoff: a process Lumen itself released is not a failure', killedOurs.canPrewarm() === true, JSON.stringify(killedOurs.warmBlock));
  const signedOut = make();
  signedOut.statusCache = { at: Date.now(), value: { signedIn: false, accountType: null, detail: null } };
  check('backoff: no pre-warm when Claude Code says it is signed out (unknown is fine)', signedOut.canPrewarm() === false, '');
  signedOut.statusCache = { at: Date.now(), value: { signedIn: 'unknown' } };
  check('backoff: an unknown sign-in state does not block pre-warming', signedOut.canPrewarm() === true, '');

  // A call reports into its own message's counters, even when another message is active by then.
  const own = make();
  const armed = [0, 0];
  const counters = (i) => ({ tools: 0, inflight: 0, dog: null, arm: () => { armed[i]++; } });
  const a1 = counters(0);
  const a2 = counters(1);
  own.active = a2;
  own.callBegin(a1);
  own.callEnd(a1);
  check('callBegin/callEnd: the call\'s own active object is counted, not the current one', a1.tools === 1 && a1.inflight === 0 && armed[0] === 1 && a2.tools === 0 && a2.inflight === 0 && armed[1] === 0, JSON.stringify({ a1: [a1.tools, a1.inflight], a2: [a2.tools, a2.inflight], armed }));
  own.callBegin(a1);
  own.active = null;
  own.callEnd(a1);
  check('callEnd: a call that outlives its message still ends on its own counters', a1.inflight === 0, String(a1.inflight));

  // Stop, then the next message at once: the wait for the stopped turn is said on screen, and the stopped
  // turn's own usage is reported (once: the next message's share is not counted twice).
  respond = (rec) => say(rec, 'first', { total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 1 } });
  const late = make({ interruptMs: 400 });
  await late.run(opts({ sessionId: 'sess-late' }));
  respond = () => {};
  control = (rec, msg) => setTimeout(() => {
    rec.out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
    rec.out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'interrupted', session_id: rec.session, total_cost_usd: 0.03, usage: { input_tokens: 30, output_tokens: 3 } });
  }, 80);
  const lateSeen = [];
  const ctlLate = new AbortController();
  const stopRun = late.run(opts({ prompt: 'stop me', sessionId: 'sess-late', resume: true, signal: ctlLate.signal, lateUsage: (u) => lateSeen.push(u) }));
  await sleep(20);
  ctlLate.abort();
  await stopRun;
  respond = (rec) => say(rec, 'after', { total_cost_usd: 0.06, usage: { input_tokens: 60, output_tokens: 6 } });
  events = [];
  const afterLate = await late.run(opts({ prompt: 'go on', sessionId: 'sess-late', resume: true }));
  check('stop then send: a status line says the stopped step is being finished', events.some((e) => e.type === 'status' && /Finishing the stopped step/.test(e.text)) && afterLate.text === 'after', JSON.stringify(events));
  check('stop: the interrupted turn\'s usage (its share only) is reported once', lateSeen.length === 1 && near(lateSeen[0].cost, 0.02) && lateSeen[0].usage.inputTokens === 20 && lateSeen[0].usage.outputTokens === 2, JSON.stringify(lateSeen));
  check('stop: the next message\'s usage is still its own delta (nothing double counted)', near(afterLate.cost, 0.03) && afterLate.usage.inputTokens === 30, JSON.stringify(afterLate));
  control = () => {};
  respond = echo;
  late.dispose();

  // No HTTP server: the stdio bridge, named by its tag.
  const stdio = make({ gate: async () => { throw new Error('no port'); } });
  const ensuredBefore = ensured;
  await stdio.run(opts({ sessionId: 'sess-stdio' }));
  const sRec = cli.spawned[cli.spawned.length - 1];
  const bridge = sRec.mcp.mcpServers.lumen;
  check('fallback: the stdio bridge with LUMEN_ENGINE when the HTTP server is not there', bridge.command === 'lumen-bridge' && /^[a-f0-9]{36}$/.test(bridge.env.LUMEN_ENGINE) && bridge.env.ELECTRON_RUN_AS_NODE === '1' && ensured === ensuredBefore + 1 && stdio.owns(bridge.env.LUMEN_ENGINE), JSON.stringify(bridge));
  stdio.dispose();
  idle.dispose();
  eng.dispose();

  // The pure helpers.
  check('procKey: differs by session, model, cap and prompt', new Set([
    cc.procKey({ bin: 'b', sessionId: 's', systemPrompt: 'p' }), cc.procKey({ bin: 'b', sessionId: 't', systemPrompt: 'p' }),
    cc.procKey({ bin: 'b', sessionId: 's', systemPrompt: 'p', model: 'opus' }), cc.procKey({ bin: 'b', sessionId: 's', systemPrompt: 'p', maxTurns: 5 }),
    cc.procKey({ bin: 'b', sessionId: 's', systemPrompt: 'q' }),
  ]).size === 5, '');
  check('procKey: today\'s date is not part of the key (a warm start survives midnight)', cc.procKey({ bin: 'b', sessionId: 's', systemPrompt: "x Today's date is 2026-09-30. y" }) === cc.procKey({ bin: 'b', sessionId: 's', systemPrompt: "x Today's date is 2026-10-01. y" }), '');
  const got = [];
  const feed = cc.lineReader((l) => got.push(l));
  feed('{"a":1}\n{"b"'); feed(':2}\n\n');
  check('lineReader: lines split across chunks come out whole', JSON.stringify(got) === '["{\\"a\\":1}","{\\"b\\":2}"]', JSON.stringify(got));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
}

async function snapshotRuns() {
  const snap = require('../src/ai/snapshot');
  let lines = ['# Shop', '[1] button "Add"'];
  let url = 'https://a.test/';
  const wc = { id: 901, isDestroyed: () => false, getURL: () => url };
  const agent = { requireTab: () => wc, browser: { aiOff: () => false }, allowStep: async () => {}, execute: async () => { lines = ['# Shop', '[1] button "Add"', 'Cart: 1 item']; return 'Clicked element 1.'; } };
  const scriptsSeen = [];
  const h = (dedupe) => ({ scripts: { readPage: () => '' }, dedupe: () => dedupe, runScript: async (_wc, s) => { scriptsSeen.push(s); return { lines: [...lines], totalLines: lines.length, elements: 1, startLine: 0, clipped: false }; } });
  const a = await snap.execute(agent, 'read_page', { mode: 'compact' }, h(true));
  const b = await snap.execute(agent, 'read_page', { mode: 'compact' }, h(true));
  check('compact dedupe: a repeat read soon after is the one "unchanged" line', /button "Add"/.test(a) && /Unchanged since your last read/.test(b) && !/button "Add"/.test(b), b);
  const c = await snap.execute(agent, 'read_page', { mode: 'compact', hrefs: true }, h(true));
  check('compact dedupe: another request shape (hrefs) is a full read', /button "Add"/.test(c), c);
  await snap.execute(agent, 'click', { element_id: 1 }, h(true)); // (not a snapshot tool: returns undefined, but ticks the cache)
  const d = await snap.execute(agent, 'read_page', { mode: 'compact', hrefs: true }, h(true));
  check('compact dedupe: an acting tool in between means a full read', /button "Add"/.test(d), d);
  const wc2 = { id: 902, isDestroyed: () => false, getURL: () => url };
  const agent2 = { ...agent, requireTab: () => wc2 };
  await snap.execute(agent2, 'read_page', { mode: 'compact' }, h(false));
  const e = await snap.execute(agent2, 'read_page', { mode: 'compact' }, h(false));
  check('compact dedupe: off outside the sidebar\'s own chat (MCP clients get the page)', /button "Add"/.test(e), e);

  // batch: the diff is against a baseline taken at its start, not an older read of another page.
  const wc3 = { id: 903, isDestroyed: () => false, getURL: () => url };
  const agent3 = { ...agent, requireTab: () => wc3 };
  url = 'https://elsewhere.test/';
  lines = ['# Elsewhere'];
  await snap.execute(agent3, 'read_page', { mode: 'compact' }, h(false)); // the last read was another page
  url = 'https://a.test/';
  lines = ['# Shop', '[1] button "Add"'];
  const out = await snap.execute(agent3, 'batch', { steps: [{ do: 'click', ref: 1 }] }, h(false));
  check('batch: a same-page batch reports what changed, not "Now on a new page"', /Changes since your last read \(\+1 \/ -0/.test(out) && /Cart: 1 item/.test(out) && !/Now on a new page/.test(out), out);

  // batch: a recent compact read of the same tab and page, with no acting tool since, is its baseline.
  const wc4 = { id: 904, isDestroyed: () => false, getURL: () => url };
  const agent4 = { ...agent, requireTab: () => wc4 };
  lines = ['# Shop', '[1] button "Add"'];
  await snap.execute(agent4, 'read_page', { mode: 'compact' }, h(false));
  const n0 = scriptsSeen.length;
  const out4 = await snap.execute(agent4, 'batch', { steps: [{ do: 'click', ref: 1 }] }, h(false));
  check('batch: a fresh read of the same page is reused as the baseline (no extra read)', scriptsSeen.length - n0 === 2 && /Changes since your last read \(\+1 \/ -0/.test(out4), `${scriptsSeen.length - n0} scripts: ${out4}`);
  await snap.execute(agent4, 'read_page', { mode: 'compact' }, h(false));
  await snap.execute(agent4, 'click', { element_id: 1 }, h(false)); // an acting tool since the read
  const n1 = scriptsSeen.length;
  await snap.execute(agent4, 'batch', { steps: [{ do: 'click', ref: 1 }] }, h(false));
  check('batch: an acting tool since the last read means a new baseline', scriptsSeen.length - n1 === 4, String(scriptsSeen.length - n1));

  // ReadCache: cleared when the model loses its earlier reads, and keyed by session.
  const rc = new snap.ReadCache();
  rc.tick('read_page'); rc.check(1, 'u', 's', 'page');
  rc.tick('read_page');
  const hit = rc.check(1, 'u', 's', 'page');
  rc.clear();
  rc.tick('read_page');
  const afterClear = rc.check(1, 'u', 's', 'page');
  rc.tick('read_page');
  const again = rc.check(1, 'u', 's', 'page');
  rc.reset('sess-2'); // a new CLI session
  rc.tick('read_page');
  const afterReset = rc.check(1, 'u', 's', 'page');
  check('read cache: a repeat is "unchanged", but not after clear() or a new session (reset)', /Unchanged/.test(hit) && afterClear === null && /Unchanged/.test(again) && afterReset === null && rc.session === 'sess-2', JSON.stringify({ hit, afterClear, again, afterReset }));
  rc.tick('read_page'); rc.check(1, 'u', 's', 'page'); rc.tick('read_page');
  rc.session = 'sess-3';
  check('read cache: entries of another session are not matched', rc.check(1, 'u', 's', 'page') === null, '');

  // The registry pass: read_page's own walk and labels, without the page text.
  const scripts = require('../src/ai/page-scripts');
  const reg = snap.registryScript(scripts);
  let parses = true;
  try { new Function(`return ${reg}`); } catch { parses = false; }
  check('registry script: parses, stores window.__claudeEls with labels, skips body.innerText and the element list', parses && reg.includes('window.__claudeEls = registry;') && reg.includes('entry.label = accessibleName') && !reg.includes('document.body.innerText') && !reg.includes('elementRange') && reg.length < scripts.readPage(0, 0).length, reg.slice(-200));
  check('registry script: compact and find use it (no full readPage)', scriptsSeen.every((s) => s !== scripts.readPage(0, 0)), '');
  check('registry script: falls back to the full read if readPage changes shape', snap.registryScript({ readPage: () => '(() => 1)()' }) === '(() => 1)()', '');
}

// Grok Build, without grok: setup written once per content change, status event at spawn, thinking not held.
async function grokRuns() {
  const gb = require('../src/ai/grok-build');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-grok-'));
  const userHome = path.join(tmp, 'user');
  fs.mkdirSync(userHome);
  fs.writeFileSync(path.join(userHome, 'auth.json'), 'tok');
  const oldHome = process.env.GROK_HOME;
  process.env.GROK_HOME = userHome;
  const gate = { open: () => ({ mcpUrl: 'http://127.0.0.1:1/mcp', mcpToken: 't', hookUrl: 'h' }), close() {}, armed: () => true, listed: () => true };
  const spawned = [];
  const spawn = (bin, argv) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    spawned.push(child);
    setImmediate(() => {
      const out = (o) => child.stdout.write(`${JSON.stringify(o)}\n`);
      out({ type: 'system', subtype: 'init', session_id: 's', model: 'grok-x' });
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } } });
      out({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } });
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } } });
      out({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }], model: 'grok-x' } });
      out({ type: 'result', subtype: 'success', is_error: false, result: 'hi', session_id: 's', total_cost_usd: 0.001, usage: { input_tokens: 1, output_tokens: 1 } });
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  };
  let fresh = 0;
  const eng = new gb.GrokBuildEngine({ userData: tmp, gate: async () => gate, spawn, onFresh: () => { fresh++; } });
  eng.bin = process.execPath;
  const events = [];
  const go = () => eng.run({ prompt: 'p', sessionId: 'sess', resume: true, systemPrompt: 'SYS', signal: new AbortController().signal, emit: (e) => events.push(e) });
  const cfg = path.join(eng.home, 'config.toml');
  const r1 = await go();
  const m1 = fs.statSync(cfg).mtimeMs;
  await sleep(30);
  await eng.prepare(); // what runTask does while the page is read
  const r2 = await go();
  check('grok: a reply runs with setup in place; status first, thinking passed through, onFresh per process', r1.text === 'hi' && r2.text === 'hi' && events[0].type === 'status' && /Starting Grok Build/.test(events[0].text) && events.some((e) => e.type === 'thinking') && fresh === 2, JSON.stringify({ r1, events: events.map((e) => e.type), fresh }));
  check('grok: config.toml and the gate script are not rewritten when unchanged', fs.statSync(cfg).mtimeMs === m1 && fs.existsSync(path.join(eng.home, gb.GATE_FILE)), '');
  await gb.writeIfChanged(cfg, 'other', 0o600);
  await eng.prepare().then(() => {}, () => {});
  eng.prep = null;
  await eng.prepare();
  check('grok: an edited config.toml is put back', fs.readFileSync(cfg, 'utf8') === gb.grokConfig({ gate: path.join(eng.home, gb.GATE_FILE) }), fs.readFileSync(cfg, 'utf8').slice(0, 40));
  check('grok: the sign-in is linked in (async)', fs.readFileSync(path.join(eng.home, 'auth.json'), 'utf8') === 'tok', '');
  // A fake grok that says what `script` tells it to; kill() ends it the way a real tree kill does.
  let script = () => {};
  const live = [];
  const spawnLive = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.out = (o) => child.stdout.write(`${JSON.stringify(o)}\n`);
    child.finish = (text) => { child.out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 's' }); setImmediate(() => child.emit('close', 0)); };
    live.push(child);
    setImmediate(() => script(child));
    return child;
  };
  const killLive = (child) => { child.killed = true; setImmediate(() => child.emit('close', null)); };
  const live1 = new gb.GrokBuildEngine({ userData: tmp, gate: async () => gate, spawn: spawnLive, kill: killLive, watchdogMs: 200 }); // (200, not 60: a loaded machine can take longer than 60 ms between two steps of a test)
  live1.bin = process.execPath;
  const evs = [];
  const runLive = (signal = new AbortController().signal) => live1.run({ prompt: 'p', sessionId: 'sess', resume: true, systemPrompt: 'SYS', signal, emit: (e) => evs.push(e) });

  // Stop before the process exists (while setup runs): Grok is never started.
  const preAborted = new AbortController();
  preAborted.abort();
  const s0 = await runLive(preAborted.signal);
  const midStop = new AbortController();
  const midRun = runLive(midStop.signal);
  midStop.abort(); // lands while run() awaits its setup
  const s1 = await midRun;
  check('grok: Stop before the spawn (already stopped, or during setup) starts no process', s0.stopped === true && s1.stopped === true && live.length === 0, JSON.stringify({ s0, s1, n: live.length }));

  // Watchdog: a silent grok is ended with an error; output keeps it alive; a Lumen tool call pauses it.
  script = (child) => child.out({ type: 'system', subtype: 'init', session_id: 's', model: 'grok-x' });
  const hung = await runLive();
  check('grok: a process silent past the watchdog is ended with a clear error', hung.failed === true && live[0].killed === true && evs.some((e) => e.type === 'error' && /stopped responding/.test(e.text)), JSON.stringify({ hung, evs }));
  script = (child) => { let n = 0; const tick = setInterval(() => { child.out({ type: 'system', subtype: 'init', session_id: 's' }); if (++n === 8) { clearInterval(tick); child.finish('chatty'); } }, 30); };
  const chatty = await runLive();
  check('grok: steady output (each line restarts the watchdog) is never cut off', chatty.text === 'chatty' && !chatty.failed, JSON.stringify(chatty));
  script = (child) => child.out({ type: 'system', subtype: 'init', session_id: 's' });
  const waiting = runLive();
  for (let i = 0; i < 100 && !live[2]; i++) await sleep(25); // (the process starts after an async setup that a loaded machine slows)
  await sleep(25);
  live1.callBegin(); // a tool call (or its approval card) is in flight
  await sleep(500);
  const stillUp = !live[2].killed;
  live[2].finish('waited');
  live1.callEnd();
  const waited = await waiting;
  check('grok: the watchdog is paused while a Lumen tool call is running', stillUp && waited.text === 'waited' && !waited.failed, JSON.stringify({ stillUp, waited }));

  // Pre-output phase: a chat's first message may wait for Lumen's tools before Grok prints a line, so the
  // watchdog (60 ms here) gets firstWaitExtraMs on top until the first stdout line; a resumed one doesn't.
  const live2 = new gb.GrokBuildEngine({ userData: tmp, gate: async () => gate, spawn: spawnLive, kill: killLive, watchdogMs: 60, firstWaitExtraMs: 300 });
  live2.bin = process.execPath;
  const runFirst = (resume) => live2.run({ prompt: 'p', sessionId: 'sess', resume, systemPrompt: 'SYS', signal: new AbortController().signal, emit: () => {} });
  const n0 = live.length;
  script = (child) => setTimeout(() => { child.out({ type: 'system', subtype: 'init', session_id: 's' }); child.finish('slow start'); }, 150);
  const slow = await runFirst(false);
  check('grok: a first message slow to print its first line (past the watchdog, within the MCP-wait allowance) is not called hung', slow.text === 'slow start' && !slow.failed, JSON.stringify(slow));
  script = () => {};
  const silent = await runFirst(true);
  check('grok: a resumed message silent from the start still hits the plain watchdog', silent.failed === true && live[live.length - 1].killed === true, JSON.stringify(silent));
  script = () => {};
  const silentFirst = await runFirst(false);
  check('grok: a first message silent past the allowance is still ended', silentFirst.failed === true && live[live.length - 1].killed === true, JSON.stringify(silentFirst));

  if (oldHome === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = oldHome;
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
}

// Grok Build warm-up (features/grok-warmup.js): only when enabled, only after the first tab (afterLook), never a
// model request (no spawn, no exec), and the first message reuses what it prepared.
async function grokWarmupRuns() {
  const gb = require('../src/ai/grok-build');
  const { createGrokWarmup } = require('../src/features/grok-warmup');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-grokwarm-'));
  const userHome = path.join(tmp, 'user');
  fs.mkdirSync(userHome);
  fs.writeFileSync(path.join(userHome, 'auth.json'), 'tok');
  const oldHome = process.env.GROK_HOME;
  process.env.GROK_HOME = userHome;
  let gates = 0;
  const gate = { open: () => ({ mcpUrl: 'http://127.0.0.1:1/mcp', mcpToken: 't', hookUrl: 'h' }), close() {}, armed: () => true, listed: () => true };
  let spawns = 0;
  let execs = 0;
  const spawn = () => {
    spawns++;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'hi', session_id: 's' })}\n`);
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  };
  const eng = new gb.GrokBuildEngine({ userData: tmp, gate: async () => { gates++; return gate; }, spawn, exec: () => { execs++; } });
  eng.bin = process.execPath; // found (no lookup)
  let on = false;
  let found = true;
  const resume = new EventEmitter();
  const w = createGrokWarmup({ enabled: () => on, engine: () => eng, found: () => found, powerMonitor: resume });
  w.watchResume();
  const cfg = path.join(eng.home, 'config.toml');

  check('warm-up: nothing before the first tab has loaded (afterLook not called yet)', await w.warm() === false && gates === 0 && !fs.existsSync(cfg), String(gates));
  check('warm-up: setting off (or Grok Build not in use): afterLook prepares nothing', await w.afterLook() === false && gates === 0 && !fs.existsSync(cfg), String(gates));
  on = true;
  found = false;
  check('warm-up: Grok Build not installed: nothing', await w.warm() === false && gates === 0, String(gates));
  found = true;
  check('warm-up: enabled and loaded: the gate starts and config, gate script and sign-in link are written', await w.warm() === true && gates === 1 && fs.existsSync(cfg) && fs.existsSync(path.join(eng.home, gb.GATE_FILE)) && fs.readFileSync(path.join(eng.home, 'auth.json'), 'utf8') === 'tok', String(gates));
  check('warm-up: never a model request or another grok process (no spawn, no exec)', spawns === 0 && execs === 0, JSON.stringify({ spawns, execs }));
  check('warm-up: pokes within a minute cost nothing', await w.warm() === false && gates === 1, String(gates));
  const m1 = fs.statSync(cfg).mtimeMs;
  await sleep(30);
  const r = await eng.run({ prompt: 'p', sessionId: 'sess', resume: false, systemPrompt: 'SYS', signal: new AbortController().signal, emit: () => {} });
  check('warm-up: the first message reuses the prepared state (gate not started again, files untouched, binary not looked up)', r.text === 'hi' && spawns === 1 && gates === 1 && fs.statSync(cfg).mtimeMs === m1 && eng.bin === process.execPath, JSON.stringify({ spawns, gates }));
  // The prepared state is taken by that message; a later one re-prepares cheaply (cached binary and gate, unchanged files).
  const r2 = await eng.run({ prompt: 'p', sessionId: 'sess', resume: true, systemPrompt: 'SYS', signal: new AbortController().signal, emit: () => {} });
  check('warm-up: a later message re-prepares cheaply (files not rewritten)', r2.text === 'hi' && fs.statSync(cfg).mtimeMs === m1, '');
  // After the machine wakes: prepared again from scratch, but only while enabled.
  const before = w.stats.warmed;
  resume.emit('resume');
  for (let i = 0; i < 100 && w.stats.warmed === before; i++) await sleep(25); // (a loaded machine takes longer than a fixed wait)
  await sleep(50);
  check('warm-up: re-warms after resume while enabled (still no process)', w.stats.warmed === before + 1 && spawns === 2, JSON.stringify(w.stats));
  on = false;
  resume.emit('resume');
  await sleep(30);
  check('warm-up: no re-warm after resume once turned off (takes effect at once)', w.stats.warmed === before + 1, JSON.stringify(w.stats));
  if (oldHome === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = oldHome;
}

function routeRuns() {
  const { route, tierFor } = require('../src/features/model-route');
  const heavy = { tier: 'heavy', turns: 2 };
  const light = 'what time is it in Tokyo and what is the weather there right now, please';
  check('route pin: in a resumed session a light message keeps the heavy model', route({ engine: 'claudecode', prompt: light, previous: heavy, pinned: true }).model === 'opus', '');
  check('route pin: a new session is scored on its own', route({ engine: 'claudecode', prompt: light, previous: heavy, pinned: false }).model === 'haiku', '');
  const brief = 'Refactor the checkout flow across the codebase and debug why the cart total is wrong.\n1. Investigate the root cause\n2. Design a fix\n3. Write tests, then migrate';
  check('route pin: a harder message still moves up', tierFor(brief, { previous: { tier: 'light', turns: 3 }, pinned: true }).tier === 'heavy', '');
  check('route pin: a picked model is never touched', route({ engine: 'claudecode', picked: 'sonnet', prompt: brief, previous: heavy, pinned: true }).model === 'sonnet', '');
}

function transcriptRuns() {
  const { transcriptFor } = require('../src/ai/agent');
  const items = transcriptFor([
    { role: 'user', content: 'book it' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'click', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Not run: stopped by the user.' }, { type: 'text', text: 'never mind, what is 2+2?' }] },
    { role: 'assistant', content: [{ type: 'text', text: '4' }] },
  ]);
  const reply = items.find((i) => i.role === 'assistant');
  check('transcript: an exchange stopped mid-tool does not lend its steps or "acted" to the next', reply && reply.text === '4' && reply.steps === 0 && !reply.acted, JSON.stringify(items));
  const normal = transcriptFor([
    { role: 'user', content: 'click it' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'click', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Clicked.' }] },
  ]).find((i) => i.role === 'assistant');
  check('transcript: steps within one exchange still count (tool results are not a new exchange)', normal.steps === 1 && normal.acted === true, JSON.stringify(normal));
}

function promptRuns() {
  const { cliSystemPrompt } = require('../src/ai/agent');
  const picked = cliSystemPrompt({ model: 'claudecode:opus' }, 'claudecode');
  const plain = cliSystemPrompt({ model: 'claudecode:default' }, 'claudecode', { background: true });
  check('Claude Code prompt: with its own prompt replaced, Lumen\'s names the tools, the date and a picked model', /mcp__lumen__read_page/.test(picked) && /Today's date is \d{4}-\d\d-\d\d\./.test(picked) && /model answering is Claude Opus/.test(picked), picked.slice(-300));
  check('Claude Code prompt: the default pick names no model; a background run is told so', !/model answering/.test(plain) && /background task/.test(plain) && /Today's date is/.test(plain), plain.slice(-300));
}

function searchRuns() {
  const { parseSearchHtml } = require('../src/ai/agent');
  const html = `<div class="serp"><div class="result results_links web-result "><div class="links_main result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=abc">Example <b>Domain</b> &amp; more</a></h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">This is the <b>first</b> snippet&#x27;s text.</a></div></div>
    <div class="result results_links web-result "><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://second.test/page">Second</a></h2>
    <div class="result__snippet">Second snippet</div></div>
    <div class="result"><a class="result__a" href="javascript:alert(1)">Bad</a></div></div>`;
  const rows = parseSearchHtml(html);
  check('search html: title, unwrapped url and snippet per result, non-web links dropped', JSON.stringify(rows) === JSON.stringify([
    { title: 'Example Domain & more', url: 'https://example.com/a?x=1', snippet: "This is the first snippet's text." },
    { title: 'Second', url: 'https://second.test/page', snippet: 'Second snippet' },
  ]), JSON.stringify(rows));
  check('search html: a page that is not a results page is null (the hidden view is tried)', parseSearchHtml('<html><body>Please verify you are human</body></html>') === null, '');
  const none = parseSearchHtml('<div id="links" class="results"><div class="no-results">No  results.<br>Try searching something else.</div></div>');
  check('search html: DuckDuckGo\'s no-results page is [] (an answer: no second fetch in the hidden view)', Array.isArray(none) && none.length === 0, JSON.stringify(none));
  check('search html: a results page whose rows could not be read is still null', parseSearchHtml('<div class="result"><span>odd markup</span></div>') === null, '');
}

async function settleRuns() {
  const { settleAfterAction } = require('../src/ai/agent');
  const fakeWc = ({ quietAfter, navigate }) => {
    const wc = new EventEmitter();
    let loading = false;
    wc.isDestroyed = () => false;
    wc.isLoading = () => loading;
    wc.executeJavaScriptInIsolatedWorld = () => new Promise((resolve) => { if (quietAfter !== null) setTimeout(() => resolve('quiet'), quietAfter); });
    if (navigate) {
      setTimeout(() => { loading = true; wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); }, 30);
      setTimeout(() => { loading = false; wc.emit('did-stop-loading'); }, 300);
    }
    return wc;
  };
  let t = Date.now();
  await settleAfterAction(fakeWc({ quietAfter: 110 }));
  const quick = Date.now() - t;
  check('settle: no navigation returns once the DOM is quiet, without the fixed 550 ms', quick >= 100 && quick < 400, `${quick} ms`);
  t = Date.now();
  await settleAfterAction(fakeWc({ quietAfter: null, navigate: true }));
  const nav = Date.now() - t;
  check('settle: a navigation that starts is waited for until it has loaded', nav >= 300, `${nav} ms`);
  t = Date.now();
  const spa = fakeWc({ quietAfter: 120 });
  setTimeout(() => spa.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true }), 20);
  await settleAfterAction(spa);
  check('settle: a same-document navigation (pushState) is not waited on as a load', Date.now() - t < 400, `${Date.now() - t} ms`);

  // The in-page DOM wait itself (run against a fake MutationObserver): a constantly mutating page resolves at ~650 ms.
  const vm = require('vm');
  const { DOM_QUIET } = require('../src/ai/agent');
  const runQuiet = (mutateEveryMs) => new Promise((resolve) => {
    let fire = null;
    class FakeObserver { constructor(cb) { fire = cb; } observe() { if (mutateEveryMs) this.tick = setInterval(() => fire([]), mutateEveryMs); } disconnect() { clearInterval(this.tick); } }
    const start = Date.now();
    vm.runInNewContext(DOM_QUIET, { document: { documentElement: {} }, MutationObserver: FakeObserver, setTimeout, clearTimeout, setInterval, clearInterval }).then((why) => resolve({ why, ms: Date.now() - start }));
  });
  const still = await runQuiet(0);
  check('settle: a page with no mutations is quiet after ~100 ms', still.why === 'quiet' && still.ms >= 90 && still.ms < 400, JSON.stringify(still));
  const animating = await runQuiet(30);
  check('settle: mutations that never pause for 100 ms stop being waited on at ~650 ms (not 1.5 s)', animating.why === 'busy' && animating.ms >= 600 && animating.ms < 1000, JSON.stringify(animating));
  const bursty = await runQuiet(0).then(() => new Promise((resolve) => {
    let fire = null;
    class Obs { constructor(cb) { fire = cb; } observe() { let n = 0; this.tick = setInterval(() => { if (++n > 4) clearInterval(this.tick); else fire([]); }, 40); } disconnect() { clearInterval(this.tick); } }
    const start = Date.now();
    vm.runInNewContext(DOM_QUIET, { document: { documentElement: {} }, MutationObserver: Obs, setTimeout, clearTimeout, setInterval, clearInterval }).then((why) => resolve({ why, ms: Date.now() - start }));
  }));
  check('settle: a burst of mutations that then pauses still resolves quiet', bursty.why === 'quiet' && bursty.ms < 640, JSON.stringify(bursty));
}

// Lumen's MCP tool entry (features/ai-agents.js mcpCallTool) driven through a sidebar Claude Code run, with fakes.
async function toolCallRuns() {
  const cc = require('../src/ai/claude-code');
  const mcp = require('../src/automation/mcp');
  const { setupAiAgents } = require('../src/features/ai-agents');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-toolcall-'));
  let callTool = null;
  const realStart = mcp.startServer;
  mcp.startServer = (o) => { callTool = o.callTool; return { disconnectAll() {}, close() {} }; };
  const outside = []; // events sent to the renderer for outside (non-sidebar-engine) agents
  const calls = []; // what the fake agent was asked, in order
  let describe = async () => null;
  const fakeAgent = {
    approvedHosts: new Set(),
    browser: { activeTab: () => null },
    engineScope: () => ({ hosts: new Set() }),
    inScope: (_scope, fn) => fn(),
    inTask: (_id, _signal, fn) => fn(),
    describeStep: (name, args) => describe(name, args),
    ensureAllowed: async () => {},
    execute: async (name) => { calls.push(`execute:${name}`); return 'ok'; },
  };
  const handlers = {};
  const settings = { mcpEnabled: true };
  setupAiAgents({
    app: { getPath: () => tmp, on() {} },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, on: (ch, fn) => { handlers[ch] = fn; } },
    agent: fakeAgent,
    tools: [],
    validateToolInput: (name, args) => (args?.bad ? 'bad field' : null),
    readSettings: () => settings,
    writeSettings: () => {},
    ui: () => ({ send: (ch, ev) => { if (ch === 'mcp:event') outside.push(ev); } }), // an outside agent's events (mcpEvent)
  });
  try { await handlers['mcp:set-enabled']({}, true); } finally { mcp.startServer = realStart; }
  const eng = fakeAgent.engines.claudecode; // created here, never run: only its `active` run and early rows matter
  const events = [];
  const controller = new AbortController();
  const tag = 'a'.repeat(36);
  eng.active = { tag, emit: (e) => events.push(e), signal: controller.signal, agent: null, tools: 0, inflight: 0, dog: null, arm: () => {} };
  const session = { engine: tag, clientName: 'claude', controller };
  check('tool call: the sidebar engine\'s MCP entry was reached', typeof callTool === 'function', '');

  // Invalid input: the row Claude Code showed early is closed, in call order (first in, first out).
  const early = (id) => eng.earlyStep({ id, name: 'mcp__lumen__click' }, (e) => events.push(e));
  early('toolu_a');
  early('toolu_b');
  await sleep(cc.EARLY_STEP_MS + 60);
  const bad = await callTool('click', { bad: true }, session);
  const good = await callTool('click', { element_id: 1 }, session);
  const done = events.filter((e) => e.type === 'tool_done');
  check('invalid input: the call is refused and its early row is closed with the error, not left spinning', bad.isError && /Invalid input: bad field/.test(bad.content[0].text) && done[0]?.id === 'cc-toolu_a' && done[0].ok === false && /Invalid input/.test(done[0].error), JSON.stringify(done));
  check('invalid input: the next call still gets the next early row (FIFO order kept) and nothing is left unclaimed', good.isError === false && done[1]?.id === 'cc-toolu_b' && done[1].ok === true && eng.early.length === 0, JSON.stringify({ done, left: eng.early.length }));

  // The row is shown at once; describeStep's label follows as a tool_update and does not delay the call.
  events.length = 0;
  calls.length = 0;
  describe = async () => { await sleep(300); calls.push('described'); return 'Reading the page closely'; };
  const t0 = Date.now();
  const read = await callTool('read_page', {}, session);
  const took = Date.now() - t0;
  const rowAt = events.findIndex((e) => e.type === 'tool');
  check('step label: a read-only tool\'s row shows at once (generic label) and the call runs without waiting for describeStep', read.isError === false && rowAt === 0 && events[0].label == null && calls[0] === 'execute:read_page' && took < 250, JSON.stringify({ took, events, calls }));
  await sleep(350);
  check('step label: a label that arrives after the call finished is dropped (no update on a done row)', !events.some((e) => e.type === 'tool_update') && calls.includes('described'), JSON.stringify(events));
  // Same, with the call still running when the label lands: the specific label replaces the generic one.
  events.length = 0;
  describe = async () => { await sleep(40); return 'Reading the page closely'; };
  fakeAgent.execute = async () => { await sleep(150); return 'ok'; };
  await callTool('read_page', {}, session);
  const upd = events.filter((e) => e.type === 'tool_update');
  check('step label: the specific label is sent as a tool_update after the row', upd.length === 1 && upd[0].label === 'Reading the page closely' && events.findIndex((e) => e.type === 'tool') < events.indexOf(upd[0]), JSON.stringify(events));
  // A click's label is read before it acts, but only for so long.
  events.length = 0;
  describe = async () => { await sleep(2000); return 'late label'; };
  let acted = 0;
  fakeAgent.execute = async () => { acted++; return 'ok'; };
  const t1 = Date.now();
  const click = await callTool('click', { element_id: 2 }, session);
  const clickTook = Date.now() - t1;
  check('step label: a click waits for its label only briefly (about 150 ms), then acts', click.isError === false && acted === 1 && clickTook >= 120 && clickTook < 1000 && events[0].type === 'tool' && events[0].label == null, JSON.stringify({ clickTook, acted, events }));
  events.length = 0;
  describe = async () => 'Clicking "Buy" button';
  await callTool('click', { element_id: 3 }, session);
  check('step label: a click whose label is ready in time shows it on the row itself', events[0].type === 'tool' && events[0].label === 'Clicking "Buy" button' && !events.some((e) => e.type === 'tool_update'), JSON.stringify(events));

  // Item 4: a click's label that lands after the action began is dropped (it would name the post-action page).
  events.length = 0;
  describe = async () => { await sleep(250); return 'Clicking "Next page"'; };
  fakeAgent.execute = async () => { await sleep(400); return 'ok'; };
  await callTool('click', { element_id: 4 }, session);
  check('step label: a click label arriving after the action started is dropped, not applied to the row', events[0].type === 'tool' && events[0].label == null && !events.some((e) => e.type === 'tool_update'), JSON.stringify(events));
  events.length = 0;
  describe = async () => { await sleep(250); return 'Reading'; };
  fakeAgent.execute = async () => { await sleep(400); return 'ok'; };
  await callTool('read_page', {}, session);
  check('step label: a page-independent label (read_page) arriving mid-call still updates the row', events.some((e) => e.type === 'tool_update' && e.label === 'Reading'), JSON.stringify(events));

  // Item 3: an outside agent has no early row, so its first 'tool' event carries the specific label.
  const outsideSession = { clientName: 'Codex', controller: new AbortController(), approvedHosts: new Set() };
  outside.length = 0;
  describe = async () => { await sleep(60); return 'Reading the page "Pricing"'; };
  fakeAgent.execute = async () => 'ok';
  await callTool('read_page', {}, outsideSession);
  check('outside agent: the first tool event has the specific label (no generic row then a late update)', outside[0]?.type === 'tool' && outside[0].label === 'Reading the page "Pricing"' && outside[0].clientName === 'Codex' && !outside.some((e) => e.type === 'tool_update'), JSON.stringify(outside));
  outside.length = 0;
  describe = async () => { await sleep(1700); return 'Very late'; };
  const tOut = Date.now();
  await callTool('read_page', {}, outsideSession);
  check('outside agent: a label that takes longer than the cap does not hold the call up (the row shows generic)', Date.now() - tOut < 1900 && outside[0].type === 'tool' && outside[0].label == null, JSON.stringify({ ms: Date.now() - tOut, outside }));
  fakeAgent.execute = async (name) => { calls.push(`execute:${name}`); return 'ok'; };
  describe = async () => null;

  // [parallel CLI chats] Two chats on Claude Code at once: the second gets an engine of its own, and each MCP call
  // reaches its own run (its own task scope, its own chat's events) by the tag of the connection it came in on.
  {
    eng.active = null;
    const leaseA = fakeAgent.engines.lease('claudecode');
    const leaseB = fakeAgent.engines.lease('claudecode');
    const leaseC = fakeAgent.engines.lease('grokbuild');
    const leaseD = fakeAgent.engines.lease('grokbuild');
    check('parallel: the first chat gets the sidebar\'s engine, the next one an engine of its own', leaseA.engine === eng && leaseA.shared && !leaseB.shared && leaseB.engine !== eng && leaseB.engine.keepAlive === false && fakeAgent.engines.leased('claudecode') && fakeAgent.engines.sideCount() === 2 && leaseC.shared && !leaseD.shared && leaseD.engine.home === leaseC.engine.home, String(fakeAgent.engines.sideCount()));
    const runs = {};
    const scoped = [];
    fakeAgent.inScope = (scope, fn) => { scoped.push(scope.id); return fn(); };
    const ctlA = new AbortController();
    const ctlB = new AbortController();
    for (const [id, lease, ctl, tagChar] of [['A', leaseA, ctlA, 'a'], ['B', leaseB, ctlB, 'b'], ['C', leaseC, new AbortController(), 'c'], ['D', leaseD, new AbortController(), 'd']]) {
      runs[id] = { tag: tagChar.repeat(36), events: [] };
      lease.engine.active = { tag: runs[id].tag, emit: (e) => runs[id].events.push(e), signal: ctl.signal, agent: null, scope: { id, hosts: new Set() }, tools: 0, inflight: 0, dog: null, arm: () => {} };
    }
    calls.length = 0;
    const both = await Promise.all(['A', 'B', 'C', 'D', 'B', 'A'].map((id) => callTool('read_page', {}, { engine: runs[id].tag, clientName: 'claude', controller: new AbortController() })));
    const rows = (id) => runs[id].events.filter((e) => e.type === 'tool_done' && e.ok).length;
    check('parallel: every call runs in its own run\'s scope, and shows in its own chat', both.every((r) => !r.isError) && JSON.stringify([...new Set(scoped)].sort()) === JSON.stringify(['A', 'B', 'C', 'D']) && scoped.filter((s) => s === 'A').length === scoped.filter((s) => s === 'B').length && scoped.filter((s) => s === 'A').length === 2 * scoped.filter((s) => s === 'C').length && rows('A') === 2 && rows('B') === 2 && rows('C') === 1 && rows('D') === 1, JSON.stringify({ scoped, a: rows('A'), b: rows('B') }));
    // Stop in one chat ends only that chat's call.
    fakeAgent.execute = async () => { await sleep(80); return 'ok'; };
    const slowA = callTool('read_page', {}, { engine: runs.A.tag, clientName: 'claude', controller: new AbortController() });
    const slowB = callTool('read_page', {}, { engine: runs.B.tag, clientName: 'claude', controller: new AbortController() });
    ctlA.abort();
    const [outA, outB] = await Promise.all([slowA, slowB]);
    check('parallel: Stop in one chat stops only its own tool call', outA.isError && /Stopped by the user/.test(outA.content[0].text) && !outB.isError, JSON.stringify({ outA, outB }));
    fakeAgent.execute = async (name) => { calls.push(`execute:${name}`); return 'ok'; };
    // The side engine and its connection go when its message ends; the shared one is free for the next chat.
    leaseB.engine.active = null;
    leaseD.engine.active = null;
    leaseB.release(); leaseB.release(); // (twice: harmless)
    leaseD.release();
    check('parallel: a finished message frees its own engine (nothing left to own its tag)', fakeAgent.engines.sideCount() === 0 && !leaseB.engine.owns(runs.B.tag), String(fakeAgent.engines.sideCount()));
    leaseA.release(); leaseC.release();
    eng.active = null;
    const again = fakeAgent.engines.lease('claudecode');
    check('parallel: once given back, the sidebar\'s engine goes to the next chat again', again.shared && again.engine === eng && fakeAgent.engines.sideCount() === 0);
    again.release();
    check('parallel: nothing is left leased', !fakeAgent.engines.leased('claudecode') && !fakeAgent.engines.leased('grokbuild'));
    // Many at once: no fixed cap on CLI connections, and every one is freed.
    const many = Array.from({ length: 12 }, () => fakeAgent.engines.lease('claudecode'));
    check('parallel: twelve Claude Code chats at once each get an engine (one shared, eleven of their own)', new Set(many.map((l) => l.engine)).size === 12 && fakeAgent.engines.sideCount() === 11);
    many.forEach((l) => l.release());
    check('parallel: ...all freed when they end', fakeAgent.engines.sideCount() === 0 && !fakeAgent.engines.leased('claudecode'));
    const agyA = fakeAgent.engines.lease('antigravity');
    const agyB = fakeAgent.engines.lease('antigravity');
    check('parallel: a second Antigravity chat gets an engine of its own (each chat has its own home folder)', agyA.shared && agyB && !agyB.shared && agyB.engine !== agyA.engine && agyB.engine.kind === 'antigravity' && fakeAgent.engines.sideCount() === 1, String(fakeAgent.engines.sideCount()));
    agyB.release(); agyA.release();
    check('parallel: ...and it is freed when its message ends', fakeAgent.engines.sideCount() === 0 && !fakeAgent.engines.leased('antigravity'));
    fakeAgent.inScope = (_scope, fn) => fn();
  }

  // Pre-warm: a no-op unless this chat's engine is Claude Code; cheap when repeated.
  const { Agent } = require('../src/ai/agent');
  let warms = [];
  const plans = [];
  const chat = (model) => Object.assign(Object.create(Agent.prototype), {
    messages: { settings: { model } },
    engines: { claudecode: { warm: (o) => warms.push(o), isWarm: () => warms.length > 0 }, grokbuild: { warm: (o) => warms.push(o) } },
    engineRuns: 0,
    runs: new Set(),
    browser: { autoModel: () => true, maxSteps: () => 0 },
    claudeCodePlan(m, text) { const p = Agent.prototype.claudeCodePlan.call(this, m, text, 0, 0); plans.push(p); return p; },
  });
  check('prewarm: an API model or Grok warms nothing', chat('claude-sonnet-4').prewarm() === false && chat('grokbuild:default').prewarm() === false && warms.length === 0, JSON.stringify(warms));
  const busy = chat('claudecode:default');
  busy.engineRuns = 1;
  check('prewarm: nothing while a Claude Code message is running', busy.prewarm() === false && warms.length === 0, '');
  const c = chat('claudecode:default');
  const started = c.prewarm();
  const again = c.prewarm(); // (isWarm now says a process is being started)
  check('prewarm: Claude Code starts one process; repeated calls start no other', started === true && again === false && warms.length === 1, JSON.stringify({ started, again, n: warms.length }));
  const sent = Agent.prototype.claudeCodePlan.call(c, c.messages, 'hello there', 0, 0);
  check('prewarm: the chat\'s first message keeps the pre-warmed session id (its process is the one used)', sent.spawn.sessionId === warms[0].sessionId && warms[0].resume === false, JSON.stringify({ sent: sent.spawn.sessionId, warm: warms[0].sessionId }));
  const resumed = chat('claudecode:opus');
  resumed.messages.settings.ccSession = 'sess-existing';
  warms = [];
  resumed.prewarm();
  check('prewarm: a chat with a session resumes it (the pinned model, not a new id)', warms.length === 1 && warms[0].sessionId === 'sess-existing' && warms[0].resume === true && warms[0].model === 'opus', JSON.stringify(warms));
  const sameChannel = handlers['agent:prewarm'];
  // The warm process is usable for the common first prompts: the pre-warmed model is what they route to.
  const routeModel = (text) => Agent.prototype.claudeCodePlan.call(chat('claudecode:default'), { settings: { model: 'claudecode:default' } }, text, 0, 0).spawn.model;
  const typical = ['open youtube', 'summarize this page', 'click the login button', 'go to github.com', 'search for cheap flights'];
  warms = [];
  const fresh1 = chat('claudecode:default');
  fresh1.prewarm();
  check('prewarm: an empty composer warms the light tier (haiku), what typical first prompts route to', warms[0].model === 'haiku' && typical.every((p) => routeModel(p) === warms[0].model), JSON.stringify({ warm: warms[0]?.model, routed: typical.map(routeModel) }));
  warms = [];
  chat('claudecode:default').prewarm('fix the race condition in the scheduler and refactor the tests');
  check('prewarm: text already typed is routed as is (a hard prompt warms the heavier model)', warms.length === 1 && warms[0].model !== 'haiku', JSON.stringify(warms));
  warms = [];
  chat('claudecode:sonnet').prewarm('open youtube');
  check('prewarm: a picked model is exactly what is warmed', warms[0]?.model === 'sonnet', JSON.stringify(warms));
  warms = [];
  const held = chat('claudecode:default');
  held.engines.claudecode.canPrewarm = () => false;
  check('prewarm: nothing while the engine says it is backing off or signed out', held.prewarm() === false && warms.length === 0, JSON.stringify(warms));
  const specific = chat('claudecode:default');
  let flagged = null;
  specific.engines.claudecode.warm = (o, f) => { flagged = f; warms.push(o); };
  specific.prewarm();
  check('prewarm: the warm is marked speculative (released after ~3 min unused)', flagged?.speculative === true, JSON.stringify(flagged));
  check('prewarm: the IPC channel is registered and never throws', typeof sameChannel === 'function' && (() => { try { sameChannel({}); return true; } catch { return false; } })(), '');
  eng.active = null;
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
}


// Round 6: the busy-page extension counts only new, visible loading markers; the stale signed-out check; the
// warm model; a re-route asked for while the guess is still starting.
async function warmAndQuietRuns() {
  const { domQuiet, Agent } = require('../src/ai/agent');
  const cc = require('../src/ai/claude-code');
  // A fake page: markers the test adds or removes; mutations never fire (a quiet page).
  const page = (initial) => {
    const els = [...initial];
    global.document = { documentElement: {}, querySelectorAll: () => els };
    global.MutationObserver = class { observe() {} disconnect() {} };
    return els;
  };
  const marker = (visible = true) => ({ getAttribute: () => null, getClientRects: () => (visible ? [1] : []) });
  const timed = async (p) => { const t = Date.now(); const why = await p; return { why, ms: Date.now() - t }; };
  try {
    page([]);
    let r = await timed(domQuiet({ quietMs: 30, capMs: 400 }));
    check('quiet page: settles after the quiet window', r.why === 'quiet' && r.ms < 150, JSON.stringify(r));
    const shownByClick = page([marker()]);
    const p0 = timed(domQuiet({ quietMs: 30, capMs: 400, extendMs: 300 }));
    setTimeout(() => shownByClick.splice(0), 100);
    r = await p0;
    check('a spinner the click already showed: waited for until it goes', r.why === 'quiet' && r.ms >= 90 && r.ms < 280, JSON.stringify(r));
    const furniture = marker();
    page([furniture]);
    r = await timed(domQuiet({ quietMs: 30, capMs: 400, extendMs: 150 }));
    const again = await timed(domQuiet({ quietMs: 30, capMs: 400, extendMs: 150 }));
    check('a spinner that never goes: one capped wait, then ignored on the page', r.why === 'busy' && again.why === 'quiet' && again.ms < 120, JSON.stringify([r, again]));
    delete globalThis.__lumenStaticMarkers;
    const els = page([]);
    const p1 = timed(domQuiet({ quietMs: 30, capMs: 400, extendMs: 300 }));
    els.push(marker(false));
    r = await p1;
    check('a hidden marker: no extra wait', r.why === 'quiet' && r.ms < 150, JSON.stringify(r));
    const els2 = page([]);
    const p2 = timed(domQuiet({ quietMs: 30, capMs: 400, extendMs: 300 }));
    els2.push(marker());
    setTimeout(() => els2.splice(0), 120);
    r = await p2;
    check('a new visible spinner: waited for until it goes (not the whole extension)', r.why === 'quiet' && r.ms >= 100 && r.ms < 280, JSON.stringify(r));
    const els3 = page([]);
    const p3 = timed(domQuiet({ quietMs: 30, capMs: 400, extendMs: 200 }));
    els3.push(marker());
    r = await p3;
    check('a spinner that stays: the extension is capped', r.why === 'busy' && r.ms >= 190 && r.ms < 400, JSON.stringify(r));
  } finally {
    delete globalThis.__lumenStaticMarkers;
    delete global.document;
    delete global.MutationObserver;
  }

  const can = cc.ClaudeCodeEngine.prototype.canPrewarm;
  check('a fresh "signed out" blocks pre-warming', can.call({ warmBlock: { until: 0 }, statusCache: { at: Date.now(), value: { signedIn: false } } }) === false, '');
  check('a "signed out" older than 30 s no longer does', can.call({ warmBlock: { until: 0 }, statusCache: { at: Date.now() - 60000, value: { signedIn: false } } }) === true, '');
  check('backoff still blocks', can.call({ warmBlock: { until: Date.now() + 60000 }, statusCache: null }) === false, '');

  const wm = cc.ClaudeCodeEngine.prototype.warmModel;
  const key = cc.procKey({ bin: 'claude', sessionId: 's', systemPrompt: 'x', model: 'haiku', maxTurns: 0 });
  check('warmModel: the kept process\'s model', wm.call({ proc: { key, exited: false, turn: null }, warming: 0 }) === 'haiku', '');
  check('warmModel: unknown while one is starting', wm.call({ proc: { key, exited: false, turn: null }, warming: 1 }) === null, '');

  // Typed words while the guess is still starting: tried again once it has started, then replaced if they route elsewhere.
  let warmed = null;
  let starting = true;
  const fake = {
    messages: { settings: { model: 'claudecode:default' } },
    engines: { claudecode: { warm: (spawn) => { warmed = spawn.model; }, canPrewarm: () => true, isWarm: () => true, warmModel: () => (starting ? null : 'haiku') } },
    claudeCodePlan: (_m, text) => ({ resume: true, spawn: { model: /analy[sz]e/.test(text) ? 'opus' : 'haiku' } }),
  };
  fake.prewarm = Agent.prototype.prewarm.bind(fake);
  check('re-route while starting: nothing replaced yet', fake.prewarm('please analyze this long report in depth') === false && warmed === null, String(warmed));
  starting = false;
  await new Promise((r) => setTimeout(r, 1600));
  check('re-route while starting: tried again once started, and the other model warmed', warmed === 'opus', String(warmed));
  clearTimeout(fake.prewarmRetry);
  warmed = null;
  check('same model typed: the warm process is kept', fake.prewarm('open youtube please') === false && warmed === null, String(warmed));
}

(async () => {
  await engineRuns();
  await snapshotRuns();
  await grokRuns();
  await grokWarmupRuns();
  routeRuns();
  transcriptRuns();
  promptRuns();
  searchRuns();
  await settleRuns();
  await toolCallRuns();
  await warmAndQuietRuns();
  if (failures) { console.log(`\n${failures} agentic check(s) failed`); process.exit(1); }
  console.log('\nAll agentic checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
