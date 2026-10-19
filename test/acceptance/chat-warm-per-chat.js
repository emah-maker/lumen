// ACCEPTANCE (feature: warm-per-chat). Run alone: node scripts/test-acceptance.js chat-warm-per-chat
//
// Each tab chat on Claude Code gets an engine of its own (features/warm-chats.js), whose CLI process stays warm between
// that chat's messages with its own MCP token, also while another chat runs. It is freed when the chat is deleted or its
// last tab closes (aiAgents.chatGone), after the idle time, past the idle cap (least recently used first) and on quit.
// Concurrent Grok Build runs share one sign-in link in Lumen's GROK_HOME (grok-build.js shareAuth / holdAuth): it is made
// once for overlapping runs, a token Grok refreshed mid-run is not put back by another run's link, and it is copied back
// to the user's file once the last run ends.
//
// The real Agent, ai-agents.js wiring and engines, with fake CLIs (test/acceptance/chat-harness.js).
const fs = require('fs');
const path = require('path');
const H = require('./chat-harness');

const { check, chat, send, until, msgOf, release, gate, live, readLog, lastAssistant, turnText } = H;
const J = (v) => JSON.stringify(v);
const isDone = (run) => run.events.some((e) => e.type === 'done');
const reached = (marker, run, ms = 15000) => until(() => msgOf(marker) || (isDone(run) ? 'done' : null), ms).then(() => msgOf(marker));
const as = (chatId) => ({ meta: { chatId } });
const startsOf = (pid) => readLog().filter((e) => e.ev === 'start' && e.pid === pid).length;
const pool = () => H.agent.engines.warmChats;
const gone = (m) => until(() => m && !live.has(m.pid) && gate.closed.has(m.token), 8000);

async function claudeSuite() {
  const model = 'claudecode:default';
  const A = chat(model);
  const B = chat(model);

  // ---- two chats at once, then a second message in each, again at once
  const a1 = send(A, 'RUN-WA1 HOLD-WA1 first', 1, as('chat-A'));
  const b1 = send(B, 'RUN-WB1 HOLD-WB1 first', 2, as('chat-B'));
  const ma1 = await reached('RUN-WA1', a1);
  const mb1 = await reached('RUN-WB1', b1);
  check('two Claude Code chats reach their CLI at the same time, each in a process of its own', Boolean(ma1 && mb1 && ma1.pid !== mb1.pid), J({ a: ma1?.pid, b: mb1?.pid }));
  check('each chat\'s process has its own MCP token', Boolean(ma1?.token && mb1?.token && ma1.token !== mb1.token), '');
  release('WA1'); release('WB1');
  await Promise.race([Promise.all([a1.done, b1.done]), H.sleep(15000)]);
  await H.sleep(200);
  check('after their first reply both processes are still running (kept warm)', Boolean(ma1 && mb1 && live.has(ma1.pid) && live.has(mb1.pid)), J({ live: [...live.keys()] }));

  const a2 = send(A, 'RUN-WA2 HOLD-WA2 second', 1, as('chat-A'));
  const b2 = send(B, 'RUN-WB2 HOLD-WB2 second', 2, as('chat-B'));
  const ma2 = await reached('RUN-WA2', a2);
  const mb2 = await reached('RUN-WB2', b2);
  check('chat A\'s second message goes to the same warm process (same pid)', Boolean(ma2 && ma1 && ma2.pid === ma1.pid && startsOf(ma1.pid) === 1), J({ first: ma1?.pid, second: ma2?.pid }));
  check('chat B\'s second message goes to the same warm process (same pid), while A is running', Boolean(mb2 && mb1 && mb2.pid === mb1.pid && startsOf(mb1.pid) === 1), J({ first: mb1?.pid, second: mb2?.pid }));
  check('each chat keeps its own MCP token across its messages', Boolean(ma2?.token === ma1?.token && mb2?.token === mb1?.token && gate.openNow().includes(ma1.token) && gate.openNow().includes(mb1.token)), '');
  release('WA2'); release('WB2');
  await Promise.race([Promise.all([a2.done, b2.done]), H.sleep(15000)]);
  check('each chat gets its own replies', /reply from RUN-WA2/.test(turnText(lastAssistant(A))) && /reply from RUN-WB2/.test(turnText(lastAssistant(B))), J({ a: turnText(lastAssistant(A)), b: turnText(lastAssistant(B)) }));

  // ---- chat deleted (or its last tab closed: main.js calls the same chatGone)
  H.aiAgents.chatGone('chat-A');
  check('deleting chat A ends its warm process and closes its MCP connection', Boolean(await gone(ma1)) && !pool().has('chat-A'), J({ alive: live.has(ma1?.pid), closed: gate.closed.has(ma1?.token) }));
  check('chat B\'s warm process is untouched', live.has(mb1.pid) && gate.openNow().includes(mb1.token), '');

  // ---- a chat whose last tab closes while it is still answering: freed when the message ends, not before
  const C = chat(model);
  const c1 = send(C, 'RUN-WC1 HOLD-WC1 working', 3, as('chat-C'));
  const mc1 = await reached('RUN-WC1', c1);
  H.aiAgents.chatGone('chat-C');
  await H.sleep(300);
  check('a chat gone mid-message keeps its process until the message ends', Boolean(mc1 && live.has(mc1.pid) && !isDone(c1)), '');
  release('WC1');
  await Promise.race([c1.done, H.sleep(15000)]);
  check('... and its process and connection end once it has answered', Boolean(await gone(mc1)) && /reply from RUN-WC1/.test(turnText(lastAssistant(C))), J({ alive: live.has(mc1?.pid) }));

  // ---- LRU cap on idle warm chats (active runs are never counted)
  H.limits.maxWarmChats = 2;
  const D = chat(model); const E = chat(model);
  const d1 = send(D, 'RUN-WD1 quick', 1, as('chat-D'));
  await Promise.race([d1.done, H.sleep(15000)]);
  const e1 = send(E, 'RUN-WE1 quick', 2, as('chat-E'));
  await Promise.race([e1.done, H.sleep(15000)]);
  const md1 = msgOf('RUN-WD1'); const me1 = msgOf('RUN-WE1');
  // Now B (oldest), D, E are idle and warm: over the cap of 2, B went.
  check('past the idle cap the least recently used idle chat (B) loses its process', Boolean(await gone(mb1)) && live.has(md1?.pid) && live.has(me1?.pid), J({ b: live.has(mb1.pid), d: live.has(md1?.pid), e: live.has(me1?.pid), stats: pool().stats() }));
  // Two chats running at once while two others are idle and warm: runs are not capped.
  const F = chat(model); const G = chat(model);
  const f1 = send(F, 'RUN-WF1 HOLD-WF1', 3, as('chat-F'));
  const g1 = send(G, 'RUN-WG1 HOLD-WG1', 4, as('chat-G'));
  const mf1 = await reached('RUN-WF1', f1); const mg1 = await reached('RUN-WG1', g1);
  check('active runs are not capped: two more chats run while the cap is full', Boolean(mf1 && mg1 && live.has(mf1.pid) && live.has(mg1.pid) && live.has(md1.pid) && live.has(me1.pid)), J(pool().stats()));
  release('WF1'); release('WG1');
  await Promise.race([Promise.all([f1.done, g1.done]), H.sleep(15000)]);
  await H.sleep(200);
  check('once they finish the idle cap holds again (2 warm, D and E went)', pool().stats().idleWarm === 2 && live.has(mf1.pid) && live.has(mg1.pid) && Boolean(await gone(md1)) && Boolean(await gone(me1)), J(pool().stats()));
  const f2 = send(F, 'RUN-WF2 again', 3, as('chat-F'));
  await Promise.race([f2.done, H.sleep(15000)]);
  check('a chat kept under the cap still reuses its process', msgOf('RUN-WF2')?.pid === mf1.pid, J({ first: mf1.pid, second: msgOf('RUN-WF2')?.pid }));
  H.limits.maxWarmChats = 4;

  // ---- idle timeout
  H.limits.idleMs = 1500;
  const I = chat(model);
  const i1 = send(I, 'RUN-WI1 quick', 1, as('chat-I'));
  await Promise.race([i1.done, H.sleep(15000)]);
  const mi1 = msgOf('RUN-WI1');
  check('an idle chat keeps its process for a while', Boolean(mi1 && live.has(mi1.pid)), '');
  check('... and loses it (and its token) after the idle time', Boolean(await gone(mi1)) && !pool().has('chat-I'), J({ alive: live.has(mi1?.pid), has: pool().has('chat-I') }));
  H.limits.idleMs = undefined;

  // ---- the open chat's process started ahead of its message (composer focus: agent.prewarm) is the one it then uses
  const P = chat(model);
  H.agent.messages = P;
  const startsBefore = readLog().filter((e) => e.ev === 'start').length;
  const warmedNow = H.agent.prewarm('hello');
  const pre = await until(() => readLog().filter((e) => e.ev === 'start').slice(startsBefore)[0], 8000);
  const p1 = send(P, 'RUN-WP1 quick', 1);
  await Promise.race([p1.done, H.sleep(15000)]);
  check('prewarm: the open chat\'s pre-started process takes its first message', warmedNow === true && Boolean(pre) && msgOf('RUN-WP1')?.pid === pre.pid, J({ warmedNow, pre: pre?.pid, used: msgOf('RUN-WP1')?.pid }));

  // ---- quit
  const warmNow = readLog().filter((e) => e.ev === 'start' && e.role === 'claude' && live.has(e.pid));
  check('before quit some chats are warm (F and G)', warmNow.length >= 2, J(warmNow.map((e) => e.pid)));
  H.quit();
  const allGone = await until(() => warmNow.every((e) => !live.has(e.pid) && gate.closed.has(e.token)), 8000);
  check('quitting Lumen ends every chat\'s warm process and connection', Boolean(allGone) && pool().stats().chats === 0, J({ live: [...live.keys()], stats: pool().stats() }));
}

async function grokSuite() {
  const gb = require('../../src/ai/grok-build');
  const home = path.join(H.tmp, 'grok-home');
  const userAuth = path.join(process.env.GROK_HOME, 'auth.json');
  fs.writeFileSync(userAuth, '{"token":"v1"}');
  const before = gb.authStats(home).links;
  const model = 'grokbuild:default';
  const A = chat(model); const B = chat(model); const C = chat(model);
  const ra = send(A, 'RUN-GLA HOLD-GLA', 1, as('g-A'));
  const rb = send(B, 'RUN-GLB HOLD-GLB', 2, as('g-B'));
  const ma = await reached('RUN-GLA', ra); const mb = await reached('RUN-GLB', rb);
  check('Grok Build: two runs at once', Boolean(ma && mb && ma.pid !== mb.pid), '');
  check('Grok Build: overlapping runs share one sign-in link (made once)', gb.authStats(home).links - before === 1 && gb.authStats(home).runs === 2, J(gb.authStats(home)));
  // Grok refreshes the token during run A: it replaces Lumen's auth.json (no longer the user's file).
  const own = path.join(home, 'auth.json');
  fs.rmSync(own); fs.writeFileSync(own, '{"token":"v2-refreshed"}');
  const rc = send(C, 'RUN-GLC HOLD-GLC', 3, as('g-C'));
  const mc = await reached('RUN-GLC', rc);
  check('Grok Build: a third run starting meanwhile does not re-link over the refreshed token', Boolean(mc) && fs.readFileSync(own, 'utf8').includes('v2-refreshed') && gb.authStats(home).links - before === 1, J({ own: fs.readFileSync(own, 'utf8'), stats: gb.authStats(home) }));
  release('GLA'); release('GLB');
  await Promise.race([Promise.all([ra.done, rb.done]), H.sleep(15000)]);
  await H.sleep(300);
  check('Grok Build: nothing is copied back while a run is still going', fs.readFileSync(userAuth, 'utf8').includes('v1'), fs.readFileSync(userAuth, 'utf8'));
  release('GLC');
  await Promise.race([rc.done, H.sleep(15000)]);
  const copied = await until(() => fs.readFileSync(userAuth, 'utf8').includes('v2-refreshed'), 5000);
  check('Grok Build: once the last run ends the refreshed token is copied back to the user\'s file, once', Boolean(copied) && gb.authStats(home).runs === 0, J({ user: fs.readFileSync(userAuth, 'utf8'), stats: gb.authStats(home) }));
  const rd = send(A, 'RUN-GLD quick', 1, as('g-A'));
  await Promise.race([rd.done, H.sleep(15000)]);
  check('Grok Build: the next run on its own links again (fresh)', gb.authStats(home).links - before === 2 && /reply from RUN-GLD/.test(turnText(lastAssistant(A))), J({ stats: gb.authStats(home), before, reply: turnText(lastAssistant(A)), errors: H.errorsOf(rd.events) }));
}

(async () => {
  H.hardStop(110000);
  await claudeSuite();
  await grokSuite();
  H.finish();
})().catch((err) => { console.error(err); H.check('suite crashed', false, err.stack); H.finish(); });
