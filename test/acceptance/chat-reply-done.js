// ACCEPTANCE (feature: reply-done-sooner). Run alone: node scripts/test-acceptance.js chat-reply-done
//
// A Claude Code reply is shown as complete as soon as its text is (the model call's end_turn): the sidebar gets a
// 'reply_complete' event, long before the CLI's `result` line (the fake CLI delays it 700 ms; the real one 0.8-1.1 s).
// The run's own 'done' still comes with the result. A message sent in that gap neither cuts the first run short nor
// reaches a busy process: it waits for the result and goes to the same kept process.
process.env.FAKE_RESULT_GAP_MS = '700';
const H = require('./chat-harness');

const { check, chat, until, readLog, lastAssistant, turnText, errorsOf } = H;
const J = (v) => JSON.stringify(v);

// agent.run with the time of each event.
function run(messages, text, tabId) {
  const events = [];
  const promise = H.agent.run(text, (e) => events.push({ ...e, at: Date.now() }), [], { tabId, messages });
  return { events, promise };
}

(async () => {
  H.hardStop(90000);
  const S = chat('claudecode:default');
  const first = run(S, 'RUN-R1 say something', 1);
  const complete = await until(() => first.events.find((e) => e.type === 'reply_complete'), 20000);
  const sentAt = Date.now();
  check('Claude Code: the reply is announced complete (reply_complete) while the run is still going', Boolean(complete) && !first.events.some((e) => e.type === 'done'), J(first.events.map((e) => e.type)));
  // The user's next message, the moment the composer is free (what the renderer's sendQueued does).
  const second = run(S, 'RUN-R2 and again', 1);
  await first.promise;
  const done1 = first.events.find((e) => e.type === 'done');
  check('Claude Code: the first run still ends with its own done, after the CLI result (the gap), and was not stopped', Boolean(done1) && done1.at - complete.at >= 400 && !first.events.some((e) => e.type === 'notice' && e.stopped) && errorsOf(first.events).length === 0, J({ gap: done1 && done1.at - complete.at, types: first.events.map((e) => e.type) }));
  check('Claude Code: its text was streamed before reply_complete, and the reply is in the chat', first.events.findIndex((e) => e.type === 'text') < first.events.findIndex((e) => e.type === 'reply_complete') && /reply from RUN-R1/.test(turnText(S.find((m) => m.role === 'assistant') || {})), J(S.map((m) => [m.role, turnText(m).slice(0, 40)])));
  await second.promise;
  const msgs = readLog().filter((e) => e.ev === 'msg' && /^RUN-R[12]$/.test(e.marker));
  const replies = readLog().filter((e) => e.ev === 'reply' && /^RUN-R[12]$/.test(e.marker));
  check('Claude Code: the message sent in the gap went to the same kept process, once, after the first result', msgs.length === 2 && msgs[0].pid === msgs[1].pid && msgs[1].t >= replies[0].t, J({ msgs: msgs.map((m) => [m.marker, m.pid, m.t]), replies: replies.map((m) => [m.marker, m.t]) }));
  check('Claude Code: the message sent in the gap is answered, and is the chat\'s last reply', /reply from RUN-R2/.test(turnText(lastAssistant(S))) && errorsOf(second.events).length === 0 && second.events.some((e) => e.type === 'done'), J({ last: turnText(lastAssistant(S)), err: errorsOf(second.events) }));
  check('Claude Code: no other process was started for it', new Set(readLog().filter((e) => e.ev === 'start').map((e) => e.pid)).size === 1, J(readLog().filter((e) => e.ev === 'start').map((e) => e.pid)));
  console.log(`(reply_complete came ${sentAt - complete.at} ms before the message was sent; done ${done1 ? done1.at - complete.at : '?'} ms after reply_complete)`);
  H.agent.onEngineReset?.();
  H.finish();
})().catch((err) => { console.error(err); H.check('suite crashed', false, err.stack); H.finish(); });
