// ACCEPTANCE (chat history on Claude Code Auto). Run alone: node scripts/test-acceptance.js chat-auto-history
//
// "Sometimes the chat history disappears on Claude Auto": a multi-turn chat on 'claudecode:auto', where Auto picks another
// model between messages ("hi" -> a hard question -> "thanks"), must never reach the CLI as a stranger. The fake CLI keeps a
// memory per session id, like a real session on disk (fake-chat-cli.js: every RUN-<id> it was sent, or was handed in an
// <earlier_conversation>), and logs what it knew BEFORE each message. Every message, in every scenario, must reach a CLI
// that knows every earlier message the chat has an answer to, through the same process (set_model), a resumed session or a
// handover, and the chat on screen keeps every turn:
//  - tier switches (haiku -> a strong model -> back), with and without the composer's pre-warm, full access off and on;
//  - the kept process ended between messages (idle, tab closed, app restarted): the session is resumed;
//  - the CLI no longer has the session: the conversation is handed over (never an empty start);
//  - Send now cutting a reply off;
//  - a message that failed before the CLI recorded it (it got no reply) is repeated to the CLI with the next one.
const H = require('./chat-harness');
const A = require('../../src/ai/auto-model');
const { claudeCodeOptions } = require('../../src/features/ai-agents');

const { check, chat, send, readLog, turnText } = H;
const J = (v) => JSON.stringify(v);
const HEAVY = ['Refactor the checkout flow across the codebase and debug why the cart total is wrong after a coupon is applied.', '1. Investigate the root cause in cart.js and pricing.js', '2. Design a fix that handles concurrent updates', '3. Write tests, then migrate the old orders', '4. Also make sure the API docs stay accurate'].join('\n');
const options = claudeCodeOptions({ signedIn: true });
H.agent.browser.autoRoute = ({ request, last, scope, allowEngines }) => A.route({ options, request, last, scope, allowEngines });
let full = false;
H.agent.browser.claudeCodeFullAccess = () => full;

let tag = 0;
const ran = (marker) => readLog().filter((e) => e.ev === 'msg' && e.marker === marker).pop() || null;
const wait = (run) => Promise.race([run.done, H.sleep(20000)]);
const missing = (msg, earlier) => (msg ? earlier.filter((m) => !msg.known.includes(m)) : earlier);
const userTexts = (M) => M.filter((m) => m.role === 'user').map((m) => (Array.isArray(m.content) ? m.content.map((b) => b.text || '').join('') : String(m.content)));
const assistantCount = (M) => M.filter((m) => m.role === 'assistant').length;
const as = (chatId) => ({ meta: { chatId } });

// Sends the usual conversation on a fresh Auto chat, doing `before(i)` ahead of message i; checks each message's CLI knew the earlier ones.
async function conversation(label, { before = null, fullAccess = false, expectResume = null } = {}) {
  full = fullAccess;
  const id = `ah-${++tag}`;
  const M = chat('claudecode:auto');
  const marks = [];
  const texts = ['hi', HEAVY, 'thanks', 'what was my first message?'];
  for (let i = 0; i < texts.length; i++) {
    const marker = `RUN-AH${tag}x${i + 1}`;
    H.agent.messages = M;
    if (before) await before(i, { M, id });
    const r = send(M, `${texts[i]}\nRUN-AH${tag}x${i + 1}`, 1, as(id));
    await wait(r);
    const msg = ran(marker);
    const lost = missing(msg, marks);
    check(`${label}: message ${i + 1} reached the CLI knowing the ${marks.length} earlier ones`, Boolean(msg) && !lost.length && !H.errorsOf(r.events).length, J({ sent: Boolean(msg), lost, errors: H.errorsOf(r.events) }));
    if (expectResume && i > 0 && msg) check(`${label}: message ${i + 1} resumed the chat's session`, msg.resume === true && msg.session === M.settings.ccSession, J({ resume: msg.resume, session: msg.session, saved: M.settings.ccSession }));
    marks.push(marker);
  }
  const models = marks.map((m) => ran(m)?.model);
  check(`${label}: Auto really changed models along the way (the test is about that)`, models[0] === 'haiku' && models.slice(1).some((m) => ['opus', 'fable'].includes(m)), J(models));
  check(`${label}: the chat holds every turn (${texts.length} questions, ${texts.length} replies) and still names the one session`, userTexts(M).length === texts.length && assistantCount(M) === texts.length && Boolean(M.settings.ccSession) && M.settings.ccSeen === M.length, J({ users: userTexts(M).length, replies: assistantCount(M), session: Boolean(M.settings.ccSession), seen: M.settings.ccSeen, length: M.length }));
  check(`${label}: the last reply is the last question's`, new RegExp(`RUN-AH${tag}x4`).test(turnText([...M].reverse().find((m) => m.role === 'assistant'))), turnText([...M].reverse().find((m) => m.role === 'assistant')));
  full = false;
  return { M, id, marks };
}

const endProcess = (id) => { H.agent.engines.claudecode.release?.(); H.aiAgents.chatGone(id); }; // the kept process goes (idle, tab closed)

(async () => {
  H.hardStop(150000);

  await conversation('tier switches');
  await conversation('tier switches, pre-warmed before each message', { before: async () => { H.agent.prewarm(''); await H.sleep(250); } });
  await conversation('tier switches, full access on', { fullAccess: true, before: async () => { H.agent.prewarm(''); await H.sleep(250); } });
  await conversation('process ended before each message (resumed)', { expectResume: true, before: async (i, { id }) => { if (i > 0) endProcess(id); } });

  // The CLI has lost the session (cleared, another machine): the next message starts a new one handed the whole conversation.
  {
    const fs = require('fs');
    const path = require('path');
    const id = `ah-${++tag}`;
    const M = chat('claudecode:auto');
    const markers = [1, 2, 3].map((n) => `RUN-AH${tag}s${n}`);
    await wait(send(M, `hi\n${markers[0]}`, 1, as(id)));
    await wait(send(M, `${HEAVY}\n${markers[1]}`, 1, as(id)));
    endProcess(id);
    for (const f of fs.readdirSync(H.tmp).filter((n) => /^session-.*\.txt$/.test(n))) fs.rmSync(path.join(H.tmp, f), { force: true }); // (every session is gone)
    const r = send(M, `thanks\n${markers[2]}`, 1, as(id));
    await wait(r);
    const msg = ran(markers[2]);
    check('session lost: the next message is handed the whole conversation (a new session, never an empty start)', Boolean(msg) && !missing(msg, markers.slice(0, 2)).length && !H.errorsOf(r.events).length, J({ sent: Boolean(msg), known: msg?.known, errors: H.errorsOf(r.events) }));
    check('session lost: the CLI was asked for the old session first, then a new one was started', readLog().some((e) => e.ev === 'expired') && msg && !msg.resume, J({ expired: readLog().some((e) => e.ev === 'expired'), resume: msg?.resume }));
    check('session lost: the chat on screen still holds all its turns', userTexts(M).length === 3 && assistantCount(M) === 3, J({ users: userTexts(M).length, replies: assistantCount(M) }));
  }

  // Send now: the running reply is cut off, the next message goes at once, and the CLI still knows everything before both.
  {
    const id = `ah-${++tag}`;
    const M = chat('claudecode:auto');
    const [m1, m2, m3] = [1, 2, 3].map((n) => `RUN-AH${tag}n${n}`);
    await wait(send(M, `hi\n${m1}`, 1, as(id)));
    const cut = send(M, `${HEAVY}\n${m2} PARTIAL`, 1, as(id));
    await H.until(() => H.textOf(cut.events).includes('partial output'), 15000);
    const next = send(M, `thanks\n${m3}`, 1, { ...as(id), sendNow: true });
    await Promise.race([cut.done, H.sleep(10000)]); await wait(next);
    const msg = ran(m3);
    check('Send now: the next message reached a CLI that knew the first one and the cut-off one', Boolean(msg) && !missing(msg, [m1, m2]).length, J({ sent: Boolean(msg), known: msg?.known }));
    check('Send now: the chat keeps its first exchange, the cut-off reply and the new one', userTexts(M).length === 3 && assistantCount(M) === 3, J({ users: userTexts(M).length, replies: assistantCount(M) }));
  }

  // A message that failed before the CLI recorded it: the next one repeats it (first message of the chat, and later in a session).
  {
    const id = `ah-${++tag}`;
    const M = chat('claudecode:auto');
    const [f1, f2] = [`RUN-AH${tag}f1`, `RUN-AH${tag}f2`];
    const r1 = send(M, `my first words\n${f1} NOREC FAIL`, 1, as(id));
    await wait(r1);
    const r2 = send(M, `what did I say before?\n${f2}`, 1, as(id));
    await wait(r2);
    const msg = ran(f2);
    check('failed first message: the CLI is told what it was (it never recorded it)', Boolean(msg) && !missing(msg, [f1]).length && /my first words/.test(msg.prompt), J({ sent: Boolean(msg), known: msg?.known }));
    check('failed first message: the follow-up is answered', /reply from/.test(turnText([...M].reverse().find((m) => m.role === 'assistant'))), J(M.map((m) => m.role)));

    const N = chat('claudecode:auto');
    const [g1, g2, g3, g4] = [1, 2, 3, 4].map((n) => `RUN-AH${tag}g${n}`);
    await wait(send(N, `hi\n${g1}`, 1, as(`${id}b`)));
    await wait(send(N, `thanks\n${g2}`, 1, as(`${id}b`)));
    await wait(send(N, `a question that fails\n${g3} NOREC FAIL`, 1, as(`${id}b`)));
    const r4 = send(N, `and the next one\n${g4}`, 1, as(`${id}b`));
    await wait(r4);
    const m4 = ran(g4);
    check('failed message in a session: the next message reaches a CLI that knows it (repeated to it) and the ones before', Boolean(m4) && !missing(m4, [g1, g2, g3]).length && /a question that fails/.test(m4.prompt), J({ sent: Boolean(m4), known: m4?.known }));
  }

  H.agent.messages = [];
  H.finish();
})().catch((err) => { console.error(err); H.check('suite crashed', false, err.stack); H.finish(); });
