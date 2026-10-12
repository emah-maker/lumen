// A reply that looks finished must always end, and Stop must always work (the "reply never finishes" bug: the text and a file card were on screen, the
// purple dot and underline stayed, the queued "Sends when this reply finishes" never sent, and Stop did nothing).
// Pure Node with the fake Claude Code CLI (test/acceptance/fake-chat-cli.js): no Electron, no window.
//
// What the screen does (renderer/chat-core.js) is played here by `play`: a queued message is sent when the run says 'reply_complete' (or 'done' if that
// never came), exactly as finishTurn -> sendQueued does. Each case checks the reply was announced done, the run's own 'done' came, and the queued
// message reached the CLI and was answered. Cases:
//   SENDFILE   the CLI's own SendUserFile tool never returns a tool_result, the text ends the turn, then the CLI says nothing (no `result` line)
//   HOOKTURN   a Stop hook adds a second turn after the first end_turn, and the CLI never closes it
//   HANDOFF    a reply that reads as a hand-back is held (agent.js watchEmit) until the turn ends, and the turn never ends by itself
//   STUCKTOOL  a CLI tool that never finishes: not cut off by the quiet net, but Stop ends it (and ends a run that cannot be aborted at all)
process.env.LUMEN_CC_FINAL_IDLE_MS = '700'; // the quiet net after a final text (30 s in the app); read by every engine, the chats' own included
const H = require('./acceptance/chat-harness');

const { check, chat, until, sleep, readLog, turnText, errorsOf } = H;
const J = (v) => JSON.stringify(v);
H.agent.browser.claudeCodeFullAccess = () => true; // (the CLI's own tools run: their steps are tracked)
H.agent.stopGraceMs = 600; // how long a stopped run may take to wind down (8 s in the app)

// agent.run with the time of each event.
function run(messages, text, tabId) {
  const events = [];
  const promise = H.agent.run(text, (e) => events.push({ ...e, at: Date.now() }), [], { tabId, messages });
  return { events, promise };
}
const types = (r) => r.events.map((e) => e.type);
const lastText = (S) => turnText(S[S.length - 1]);

// The screen: when the reply is announced done (or the run ends) the queued message goes.
async function play(S, firstText, queuedText, tabId) {
  const first = run(S, firstText, tabId);
  const t0 = Date.now();
  const announced = await until(() => first.events.find((e) => e.type === 'reply_complete' || e.type === 'done'), 15000);
  let second = null;
  if (announced) second = run(S, queuedText, tabId);
  const done = await until(() => first.events.find((e) => e.type === 'done'), 15000);
  if (second) await Promise.race([second.promise, sleep(15000)]);
  return { first, second, announced, done, t0 };
}

(async () => {
  H.hardStop(100000);

  // ---- 1. SendUserFile: a CLI tool that never reports back, then silence.
  {
    const S = chat('claudecode:default');
    const r = await play(S, 'RUN-F1 SENDFILE make me the solution page', 'RUN-F2 generate an image please', 1);
    const ev = r.first.events;
    check('SendUserFile, no tool result: the reply is announced done (reply_complete) once the text ends', Boolean(r.announced) && r.announced.type === 'reply_complete', J(types(r.first)));
    check('SendUserFile: the step that never got a result is closed (tool_done), not left running', ev.some((e) => e.type === 'tool' && /SendUserFile/.test(e.name || '')) && ev.some((e) => e.type === 'tool_done' && e.ok), J(ev.map((e) => [e.type, e.name || e.id])));
    check('SendUserFile: the run still ends with its own done, without an error, even though the CLI never sent a result', Boolean(r.done) && errorsOf(ev).length === 0, J({ done: Boolean(r.done), err: errorsOf(ev), types: types(r.first) }));
    check('SendUserFile: the run ended within the quiet net, not at the 90 s watchdog', r.done && r.done.at - r.t0 < 8000, r.done && r.done.at - r.t0);
    check('SendUserFile: the text is in the chat, and the file the reply names has its card', /worked solution/.test(turnText(S.find((m) => m.role === 'assistant') || {})) && ev.some((e) => e.type === 'file'), J(types(r.first)));
    check('SendUserFile: the queued message auto-sent, reached the CLI and was answered', Boolean(r.second) && Boolean(readLog().find((e) => e.ev === 'msg' && e.marker === 'RUN-F2')) && /reply from RUN-F2/.test(lastText(S)) && r.second.events.some((e) => e.type === 'done') && errorsOf(r.second.events).length === 0, J({ last: lastText(S), err: r.second && errorsOf(r.second.events) }));
  }

  // ---- 2. A hook adds an extra turn that never closes.
  {
    const S = chat('claudecode:default');
    const r = await play(S, 'RUN-K1 HOOKTURN fix the layout', 'RUN-K2 and now the picture', 2);
    check('Hook turn: the reply is announced done at its first end_turn', Boolean(r.announced) && r.announced.type === 'reply_complete', J(types(r.first)));
    check('Hook turn: the run ends (the extra turn did not keep it open for ever), no error', Boolean(r.done) && errorsOf(r.first.events).length === 0, J({ types: types(r.first), err: errorsOf(r.first.events) }));
    check('Hook turn: the queued message auto-sent and was answered', Boolean(r.second) && /reply from RUN-K2/.test(lastText(S)) && r.second.events.some((e) => e.type === 'done'), J(S.map((m) => [m.role, turnText(m).slice(0, 60)])));
  }

  // ---- 3. The handoff hold: a reply that reads as a hand-back is held until the turn ends, and the turn never ends by itself.
  {
    const S = chat('claudecode:default');
    const r = await play(S, 'RUN-H1 HANDOFFTEXT NORESULT open the report', 'RUN-H2 generate an image please', 3);
    check('Handoff hold: the held reply_complete is released and the reply is announced done', Boolean(r.announced), J(types(r.first)));
    check('Handoff hold: the run ends with a done (the hold did not wait for ever)', Boolean(r.done), J(types(r.first)));
    check('Handoff hold: the queued message auto-sent and was answered', Boolean(r.second) && /reply from RUN-H2/.test(lastText(S)) && r.second.events.some((e) => e.type === 'done'), J(S.map((m) => [m.role, turnText(m).slice(0, 60)])));
    const settled = r.first.events.filter((e) => e.type === 'reply_complete' || e.type === 'done');
    check('Handoff hold: nothing reaches the screen after done (a stray reply_complete would end the next message\'s turn)', settled.length > 0 && settled[settled.length - 1].type === 'done', J(types(r.first)));
  }

  // ---- 4. A tool that is really running is not cut off by the quiet net; Stop ends it.
  {
    const S = chat('claudecode:default');
    const r = run(S, 'RUN-T1 STUCKTOOL run the long job', 4);
    await until(() => r.events.find((e) => e.type === 'tool'), 15000);
    await sleep(700 * 3);
    check('Long tool: still running well past the quiet net (a running tool is never cut off)', !r.events.some((e) => e.type === 'done' || e.type === 'reply_complete' || e.type === 'error'), J(types(r)));
    const stopAt = Date.now();
    H.agent.stop(); // the Stop button (main: agent:stop)
    const done = await until(() => r.events.find((e) => e.type === 'done'), 8000);
    check('Stop on a running tool: the run ends with done, marked stopped', Boolean(done) && r.events.some((e) => e.type === 'notice' && e.stopped), J(types(r)));
    check('Stop on a running tool: it ends within a few seconds', Boolean(done) && done.at - stopAt < 5000, done && done.at - stopAt);
    // The composer is usable again: the next message goes through.
    const next = run(S, 'RUN-T2 hello again', 4);
    await Promise.race([next.promise, sleep(15000)]);
    check('After Stop: the next message is sent and answered', /reply from RUN-T2/.test(lastText(S)) && next.events.some((e) => e.type === 'done'), J(S.map((m) => [m.role, turnText(m).slice(0, 60)])));
  }

  // ---- 5. Stop on a run that cannot be aborted (its engine turn is stuck on something the abort never reaches), and Stop with nothing running.
  {
    const S = chat('claudecode:default');
    const real = H.agent.claudeCodeTurn;
    H.agent.claudeCodeTurn = () => new Promise(() => {}); // never settles, ignores the signal
    const r = run(S, 'RUN-U1 anything', 5);
    await sleep(300);
    const stopAt = Date.now();
    H.agent.stopFor(S);
    const done = await until(() => r.events.find((e) => e.type === 'done'), 8000);
    H.agent.claudeCodeTurn = real;
    check('Stop on an unabortable run: the run still ends with done and a stopped notice', Boolean(done) && r.events.some((e) => e.type === 'notice' && e.stopped), J(types(r)));
    check('Stop on an unabortable run: within the grace time, not never', Boolean(done) && done.at - stopAt < 4000, done && done.at - stopAt);
    let threw = null;
    try { H.agent.stop(); H.agent.stopFor(chat('claudecode:default')); } catch (e) { threw = e; }
    check('Stop with nothing running does nothing and does not throw', !threw, threw && threw.stack);
    const next = run(S, 'RUN-U2 still works', 5);
    await Promise.race([next.promise, sleep(15000)]);
    check('After an unabortable run was stopped, the chat takes the next message', /reply from RUN-U2/.test(lastText(S)), J(S.map((m) => [m.role, turnText(m).slice(0, 60)])));
  }

  H.agent.onEngineReset?.();
  H.finish();
})().catch((err) => { console.error(err); H.check('suite crashed', false, err.stack); H.finish(); });
