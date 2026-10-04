// ACCEPTANCE (feature: chat-history-fix). Run alone: node scripts/test-acceptance.js chat-history-isolation
//
// Each tab's chat resumes its OWN CLI session and hands over its OWN earlier turns, never another tab's: chat A's
// follow-up goes to A's Claude Code / Grok Build session, B's to B's, the saved session ids stay per chat, and a chat
// switched to a CLI engine mid-conversation sends only its own history.
//
// Sequential sections pass on main (they pin today's behaviour so the fix can't break it); the sections where the
// chats are in flight at the same time need parallel CLI chats too and FAIL on main (one CLI chat at a time).
const H = require('./chat-harness');

const { check, chat, send, until, msgOf, release, readLog, lastAssistant, turnText, errorsOf } = H;
const J = (v) => JSON.stringify(v);
const msgs = (re) => readLog().filter((e) => e.ev === 'msg' && re.test(e.marker));
const sessionKey = { claudecode: 'ccSession', grokbuild: 'gbSession' };

async function suite(engine) {
  const model = `${engine}:default`;
  const name = engine === 'claudecode' ? 'Claude Code' : 'Grok Build';
  const P = engine === 'claudecode' ? 'C' : 'G';
  const key = sessionKey[engine];
  const wait = (run) => Promise.race([run.done, H.sleep(15000)]);

  // ---- sequential, interleaved: A1, B1, A2, B2 (passes on main)
  const A = chat(model);
  const B = chat(model);
  await wait(send(A, `RUN-${P}A1 hello from A`, 1));
  await wait(send(B, `RUN-${P}B1 hello from B`, 2));
  await wait(send(A, `RUN-${P}A2 more for A`, 1));
  await wait(send(B, `RUN-${P}B2 more for B`, 2));
  const [a1, a2, b1, b2] = [`A1`, `A2`, `B1`, `B2`].map((m) => msgOf(`RUN-${P}${m}`));
  check(`${name} (sequential): every message reached the CLI`, a1 && a2 && b1 && b2, J([a1, a2, b1, b2].map(Boolean)));
  check(`${name} (sequential): the two chats have different CLI sessions`, a1?.session && b1?.session && a1.session !== b1.session, J([a1?.session, b1?.session]));
  check(`${name} (sequential): A's follow-up goes to A's session and B's to B's`, a2?.session === a1?.session && b2?.session === b1?.session, J({ a1: a1?.session, a2: a2?.session, b1: b1?.session, b2: b2?.session }));
  check(`${name} (sequential): each chat saved its own session id`, A.settings[key] === a1?.session && B.settings[key] === b1?.session, J({ A: A.settings[key], B: B.settings[key] }));
  check(`${name} (sequential): no prompt carries the other chat's words`, !msgs(new RegExp(`^RUN-${P}B`)).some((e) => /from A|for A|RUN-\wA/.test(e.prompt)) && !msgs(new RegExp(`^RUN-${P}A`)).some((e) => /from B|for B|RUN-\wB/.test(e.prompt)), 'cross-chat text in a prompt');

  // ---- at the same time: A3 and B3 in flight together, B finishing first (needs parallel CLI chats)
  const r3a = send(A, `RUN-${P}A3 HOLD-${P}A3 third for A`, 1);
  const r3b = send(B, `RUN-${P}B3 HOLD-${P}B3 third for B`, 2);
  await until(() => (msgOf(`RUN-${P}A3`) || r3a.events.some((e) => e.type === 'done')) && (msgOf(`RUN-${P}B3`) || r3b.events.some((e) => e.type === 'done')), 15000);
  release(`${P}B3`);
  await wait(r3b);
  release(`${P}A3`);
  await wait(r3a);
  const [a3, b3] = [msgOf(`RUN-${P}A3`), msgOf(`RUN-${P}B3`)];
  check(`${name} (at once): both chats' messages reached the CLI`, a3 && b3, J({ a3: Boolean(a3), b3: Boolean(b3), errA: errorsOf(r3a.events), errB: errorsOf(r3b.events) }));
  check(`${name} (at once): each still resumes its own session`, a3?.session === a1?.session && b3?.session === b1?.session, J({ a: [a1?.session, a3?.session], b: [b1?.session, b3?.session] }));
  check(`${name} (at once): B finishing first does not overwrite A's saved session (and vice versa)`, A.settings[key] === a1?.session && B.settings[key] === b1?.session, J({ A: A.settings[key], B: B.settings[key] }));
  check(`${name} (at once): each reply lands in its own chat`, /RUN-\wA3/.test(turnText(lastAssistant(A))) && /RUN-\wB3/.test(turnText(lastAssistant(B))), J({ A: turnText(lastAssistant(A)), B: turnText(lastAssistant(B)) }));

  // ---- switched to the CLI mid-chat: the handover carries only this chat's turns
  const hist = (secret) => [
    { role: 'user', content: [{ type: 'text', text: `my earlier question ${secret}` }] },
    { role: 'assistant', content: [{ type: 'text', text: `earlier answer about ${secret}` }] },
  ];
  const C = chat(model, hist('SECRETC'));
  const D = chat(model, hist('SECRETD'));
  const rc = send(C, `RUN-${P}C1 HOLD-${P}C1 continue`, 3);
  const rd = send(D, `RUN-${P}D1 HOLD-${P}D1 continue`, 4);
  await until(() => (msgOf(`RUN-${P}C1`) || rc.events.some((e) => e.type === 'done')) && (msgOf(`RUN-${P}D1`) || rd.events.some((e) => e.type === 'done')), 15000);
  release(`${P}C1`); release(`${P}D1`);
  await wait(rc); await wait(rd);
  const [c1, d1] = [msgOf(`RUN-${P}C1`), msgOf(`RUN-${P}D1`)];
  check(`${name} (handover, at once): C's first CLI message carries C's earlier turns`, c1 && /SECRETC/.test(c1.prompt), J({ c1: Boolean(c1), err: errorsOf(rc.events) }));
  check(`${name} (handover, at once): D's carries D's`, d1 && /SECRETD/.test(d1.prompt), J({ d1: Boolean(d1), err: errorsOf(rd.events) }));
  check(`${name} (handover, at once): neither carries the other's`, Boolean(c1 && d1) && !/SECRETD/.test(c1.prompt) && !/SECRETC/.test(d1.prompt), 'cross-chat history in a handover');
  check(`${name} (handover, at once): the two handovers start two different sessions`, Boolean(c1 && d1) && c1.session !== d1.session && !c1.resume && !d1.resume, J({ c: c1?.session, d: d1?.session }));

  // ---- the open chat's pre-warmed Claude Code session is never used by another chat's first message
  if (engine === 'claudecode') {
    const W = chat(model);
    const X = chat(model);
    H.agent.messages = W; // the sidebar shows W; its composer is focused
    H.agent.prewarm?.('');
    await H.sleep(200);
    await wait(send(X, `RUN-${P}X1 first in X`, 2)); // X (another tab's chat) sends first
    await wait(send(W, `RUN-${P}W1 first in W`, 1));
    const [x1, w1] = [msgOf(`RUN-${P}X1`), msgOf(`RUN-${P}W1`)];
    check(`${name}: another tab's chat never takes the open chat's pre-warmed session`, x1 && w1 && x1.session !== w1.session && X.settings.ccSession !== W.settings.ccSession, J({ x: x1?.session, w: w1?.session }));
    H.agent.messages = [];
  }
  H.agent.onEngineReset?.();
}

(async () => {
  H.hardStop(110000);
  await suite('grokbuild');
  await suite('claudecode');
  H.finish();
})().catch((err) => { console.error(err); H.check('suite crashed', false, err.stack); H.finish(); });
