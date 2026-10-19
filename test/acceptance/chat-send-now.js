// ACCEPTANCE (feature: send-now). Run alone: node scripts/test-acceptance.js chat-send-now
//
// "Send now": while a reply is still coming, the user sends the next message at once. The current run is stopped
// (its CLI turn interrupted or its process ended), the partial reply stays in the chat marked as interrupted, and the
// new message goes out with that partial output in it, so the model knows what it had said before it was cut off.
//
// Assumed entry point: agent.run(text, emit, images, { messages, tabId, sendNow: true }) on a chat whose run is in
// progress (a new message in a running chat already replaces its run; sendNow says the user asked for it). The
// marking is accepted as `turn.interrupted === true` on the kept assistant turn, or the word "interrupted" in its text.
// Expected to FAIL on main: a stopped CLI turn is kept unmarked and the next CLI message does not carry it.
const fs = require('fs');
const path = require('path');
const H = require('./chat-harness');

const { check, chat, send, until, msgOf, live, gate, lastAssistant, turnText, errorsOf } = H;
const J = (v) => JSON.stringify(v);

// ---- the button exists (static: a locale string and the renderer wiring)
{
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'locales', 'en.json'), 'utf8'));
  const keys = Object.keys(en).filter((k) => /send.?now/i.test(k) || /send now/i.test(en[k]));
  check('UI: a "Send now" string is in the locale table', keys.length > 0, 'no key or text matching /send.?now/i in en.json');
  const rdir = path.join(__dirname, '..', '..', 'src', 'renderer');
  const wired = fs.readdirSync(rdir).filter((f) => f.endsWith('.js')).some((f) => /send.?now/i.test(fs.readFileSync(path.join(rdir, f), 'utf8')));
  check('UI: the renderer wires a Send now control', wired, 'no /send.?now/i in src/renderer/*.js');
}

async function suite(engine) {
  const model = `${engine}:default`;
  const name = engine === 'claudecode' ? 'Claude Code' : 'Grok Build';
  const P = engine === 'claudecode' ? 'C' : 'G';
  const S = chat(model);
  const first = send(S, `RUN-${P}S1 PARTIAL please write a long answer`, 1);
  const m1 = await until(() => msgOf(`RUN-${P}S1`), 15000);
  const partialShown = await until(() => H.textOf(first.events).includes(`partial output from RUN-${P}S1`), 8000);
  check(`${name}: the first reply has started streaming (baseline)`, Boolean(m1 && partialShown), J({ m1: Boolean(m1), text: H.textOf(first.events) }));

  const second = send(S, `RUN-${P}S2 actually, do this instead`, 1, { sendNow: true });
  await Promise.race([first.done, H.sleep(10000)]);
  await Promise.race([second.done, H.sleep(15000)]);
  const m2 = msgOf(`RUN-${P}S2`);

  check(`${name}: the interrupted run ends (its done event) and the new message is sent`, first.events.some((e) => e.type === 'done') && Boolean(m2), J({ firstDone: first.events.some((e) => e.type === 'done'), sent: Boolean(m2), err: errorsOf(second.events) }));
  const stoppedCli = engine === 'grokbuild'
    ? Boolean(m1) && !live.has(m1.pid) && gate.closed.has(m1.token)
    : Boolean(m1) && (!live.has(m1.pid) || H.readLog().some((e) => e.ev === 'interrupt' && e.marker === `RUN-${P}S1`));
  check(`${name}: the running CLI turn was stopped (process ended / turn interrupted), not left running`, stoppedCli, J({ alive: m1 && live.has(m1.pid), closed: m1 && gate.closed.has(m1.token) }));

  const partialTurn = S.find((m) => m.role === 'assistant' && turnText(m).includes(`partial output from RUN-${P}S1`));
  check(`${name}: the partial reply is kept in the chat`, Boolean(partialTurn), J(S.map((m) => [m.role, turnText(m).slice(0, 60)])));
  check(`${name}: the kept partial reply is marked interrupted`, Boolean(partialTurn) && (partialTurn.interrupted === true || /interrupted/i.test(turnText(partialTurn))), J(partialTurn));
  check(`${name}: the next turn's prompt includes the partial output`, Boolean(m2) && m2.prompt.includes(`partial output from RUN-${P}S1`), m2 ? m2.prompt.slice(-300) : 'not sent');
  check(`${name}: the new message is answered and is the chat's last reply`, /reply from RUN-\wS2/.test(turnText(lastAssistant(S))), turnText(lastAssistant(S)));
  check(`${name}: the next turn stays in the same CLI session`, Boolean(m1 && m2) && m2.session === m1.session, J({ s1: m1?.session, s2: m2?.session }));
  H.agent.onEngineReset?.();
}

(async () => {
  H.hardStop(100000);
  await suite('grokbuild');
  await suite('claudecode');
  H.finish();
})().catch((err) => { console.error(err); H.check('suite crashed', false, err.stack); H.finish(); });
