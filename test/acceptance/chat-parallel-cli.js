// ACCEPTANCE (feature: parallel-cli-chats). Run alone: node scripts/test-acceptance.js chat-parallel-cli
//
// Claude Code / Grok Build chats in different tabs run at the same time. Each CLI run has its own MCP connection to
// Lumen (its own tag/token): a tool call that comes in on run A's connection acts for chat A, in tab A, and shows on
// chat A only. Connections close when a run finishes, fails or is stopped (what happens to a chat whose last tab
// closed), and nothing piles up after many runs.
//
// The real Agent, ai-agents.js MCP entry and engines, with fake CLIs (test/acceptance/chat-harness.js). Expected to
// FAIL on main, where one CLI chat runs at a time (agent.engineRunScope, createRunSlots cliMax 1, engine.active).
const TC = require('../../src/features/tab-chats');
const H = require('./chat-harness');

const { check, chat, send, until, msgOf, release, gate, live, executed, toolCall, readLog, textOf, errorsOf, lastAssistant, turnText } = H;
const J = (v) => JSON.stringify(v);

// ---- the waiting line no longer serializes CLI chats
{
  const s = TC.createRunSlots({ max: 3 });
  const started = [];
  const go = (id) => s.request(id, { kind: 'cli', start: () => started.push(id) });
  check('slots: two Claude Code / Grok Build chats both start when there is room (no CLI-only line)', go('cc1') === 'started' && go('gb1') === 'started' && J(started) === '["cc1","gb1"]', J({ started, reason: s.reason?.('gb1') }));
  check('slots: a third CLI chat starts too, up to the chat cap', go('cc2') === 'started' && s.size() === 3, J(started));
  check('slots: past the cap the reason is the cap, never "cli"', go('cc3') === 'queued' && s.reason('cc3') === 'limit', s.reason?.('cc3'));
}

// ---- the setting's description no longer promises that the CLI engines take turns
{
  const en = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src','locales', 'en.json'), 'utf8'));
  check('settings text: "Chats working at once" no longer says Claude Code and Grok Build take turns', !/take turns/i.test(en['settings.ai.maxChatRunsDesc'] || ''), en['settings.ai.maxChatRunsDesc']);
}

async function engineSuite(engine) {
  const model = engine === 'claudecode' ? 'claudecode:default' : 'grokbuild:default';
  const name = engine === 'claudecode' ? 'Claude Code' : 'Grok Build';
  const P = engine === 'claudecode' ? 'C' : 'G';
  const A = chat(model);
  const B = chat(model);
  const isDone = (run) => run.events.some((e) => e.type === 'done');
  const reached = (marker, run, ms = 15000) => until(() => msgOf(marker) || (isDone(run) ? 'done' : null), ms).then((v) => (v && v !== 'done' ? v : msgOf(marker)));

  // ---- baseline (passes on main too): one run, a tool call on its connection acts on its own tab
  {
    const S = chat(model);
    const rs = send(S, `RUN-${P}S HOLD-${P}S solo`, 2);
    const ms = await reached(`RUN-${P}S`, rs);
    executed.length = 0;
    const out = ms?.token ? await toolCall(ms.token, 'read_page') : null;
    check(`${name} (baseline): a single run's tool call acts on its chat's tab`, out && !out.isError && J(executed.map((e) => e.tab)) === '[2]', J({ out, executed }));
    release(`${P}S`);
    await Promise.race([rs.done, H.sleep(15000)]);
  }

  // ---- two chats, two tabs, at once
  const ra = send(A, `RUN-${P}A HOLD-${P}A first`, 1);
  const rb = send(B, `RUN-${P}B HOLD-${P}B second`, 2);
  const both = (await reached(`RUN-${P}A`, ra)) && (await reached(`RUN-${P}B`, rb)) && msgOf(`RUN-${P}A`) && msgOf(`RUN-${P}B`);
  const ma = msgOf(`RUN-${P}A`);
  const mb = msgOf(`RUN-${P}B`);
  check(`${name}: chats in tab 1 and tab 2 both reach their CLI while neither has finished`, Boolean(both), J({ a: Boolean(ma), b: Boolean(mb), errorsB: errorsOf(rb.events), errorsA: errorsOf(ra.events) }));
  check(`${name}: the second chat is not refused as "still working on a task in another chat"`, !errorsOf(rb.events).some((t) => /another chat/i.test(t)) && !errorsOf(ra.events).some((t) => /another chat/i.test(t)), J(errorsOf(rb.events)));
  check(`${name}: two CLI processes are alive at the same time`, Boolean(both) && ma.pid !== mb.pid && live.has(ma.pid) && live.has(mb.pid), J({ pids: [ma?.pid, mb?.pid], live: [...live.keys()] }));
  check(`${name}: each run has its own MCP connection (its own token)`, Boolean(ma?.token && mb?.token && ma.token !== mb.token && gate.openNow().includes(ma.token) && gate.openNow().includes(mb.token)), J({ a: ma?.token?.slice(0, 8), b: mb?.token?.slice(0, 8), open: gate.openNow().length }));

  // ---- tool calls go to the run they came from
  if (ma?.token && mb?.token) {
    executed.length = 0;
    const evA0 = ra.events.length; const evB0 = rb.events.length;
    H.state.active = 3; // the user looks at another tab meanwhile
    const outB = await toolCall(mb.token, 'read_page');
    const outA = await toolCall(ma.token, 'read_page');
    const rowsA = ra.events.slice(evA0).filter((e) => e.type === 'tool');
    const rowsB = rb.events.slice(evB0).filter((e) => e.type === 'tool');
    check(`${name}: a tool call on run A's connection is accepted (not "no message in progress")`, outA && !outA.isError, J(outA));
    check(`${name}: a tool call on run B's connection is accepted`, outB && !outB.isError, J(outB));
    check(`${name}: run A's tool acted on tab 1 and run B's on tab 2 (not the tab in front, not each other's)`, J(executed.map((e) => e.tab)) === '[2,1]', J(executed));
    check(`${name}: each call's step row shows on its own chat only`, rowsA.length === 1 && rowsB.length === 1, J({ rowsA: rowsA.length, rowsB: rowsB.length }));
    H.state.active = 1;
  } else {
    check(`${name}: tool calls route to their own run (skipped: the runs never both started)`, false, 'no tokens');
  }

  release(`${P}A`); release(`${P}B`);
  await Promise.race([Promise.all([ra.done, rb.done]), H.sleep(15000)]);
  check(`${name}: each chat gets its own reply`, /reply from RUN-\wA/.test(turnText(lastAssistant(A))) && /reply from RUN-\wB/.test(turnText(lastAssistant(B))) && !/RUN-\wB/.test(textOf(ra.events)) && !/RUN-\wA/.test(textOf(rb.events)), J({ a: turnText(lastAssistant(A)), b: turnText(lastAssistant(B)) }));

  // ---- connections after finish
  await H.sleep(300);
  const tokensOfLive = () => new Set(readLog().filter((e) => e.ev === 'start' && live.has(e.pid)).map((e) => e.token));
  const orphans = () => gate.openNow().filter((t) => !tokensOfLive().has(t));
  if (engine === 'grokbuild') check(`${name}: after both finish, both connections are closed`, gate.openNow().length === 0 && live.size === 0, J({ open: gate.openNow().length, live: live.size }));
  else check(`${name}: after both finish, no connection is left without its process, and at most one kept process per chat`, orphans().length === 0 && gate.openNow().length <= 2, J({ open: gate.openNow().length, orphans: orphans().length, live: live.size }));

  // ---- after an error
  const E = chat(model);
  const re = send(E, `RUN-${P}E FAIL`, 3);
  await Promise.race([re.done, H.sleep(20000)]);
  const me = msgOf(`RUN-${P}E`);
  await until(() => me && !live.has(me.pid) && gate.closed.has(me.token), 5000);
  check(`${name}: a run that fails shows the error and closes its connection and process`, errorsOf(re.events).length > 0 && me && gate.closed.has(me.token) && !live.has(me.pid), J({ errors: errorsOf(re.events), closed: me && gate.closed.has(me.token), alive: me && live.has(me.pid) }));

  // ---- stopped (a chat whose tab closed with the window's last tab, or Stop) while another chat keeps running
  const T = chat(model);
  const O = chat(model);
  const rt = send(T, `RUN-${P}T PARTIAL`, 3);
  const ro = send(O, `RUN-${P}O HOLD-${P}O`, 4);
  const mt = await reached(`RUN-${P}T`, rt);
  const mo = await reached(`RUN-${P}O`, ro);
  H.agent.stopFor(T);
  await Promise.race([rt.done, H.sleep(10000)]);
  const tClosed = await until(() => mt && (gate.closed.has(mt.token) || engine === 'claudecode') && !orphans().length, 6000);
  check(`${name}: stopping one chat ends its run; its connection is closed or held only by its own live kept process`, Boolean(tClosed) && rt.events.some((e) => e.type === 'done'), J({ closed: mt && gate.closed.has(mt.token), orphans: orphans().length }));
  check(`${name}: stopping one chat does not touch the other chat's run or connection`, Boolean(mo) && live.has(mo.pid) && gate.openNow().includes(mo.token) && !ro.events.some((e) => e.type === 'done'), J({ mo: Boolean(mo), alive: mo && live.has(mo.pid), done: ro.events.some((e) => e.type === 'done') }));
  release(`${P}O`);
  await Promise.race([ro.done, H.sleep(20000)]);

  // ---- no leak after N runs (pairs at once, several chats)
  const N = 6;
  const chats = [chat(model), chat(model), chat(model)];
  for (let i = 0; i < N; i += 2) {
    const r1 = send(chats[i % 3], `RUN-${P}L${i} quick`, 1);
    const r2 = send(chats[(i + 1) % 3], `RUN-${P}L${i + 1} quick`, 2);
    await Promise.race([Promise.all([r1.done, r2.done]), H.sleep(15000)]);
  }
  await H.sleep(500);
  const replies = readLog().filter((e) => e.ev === 'reply' && new RegExp(`^RUN-${P}L`).test(e.marker)).length;
  check(`${name}: ${N} runs in pairs all answered`, replies === N, `${replies} of ${N}`);
  if (engine === 'grokbuild') check(`${name}: after ${N} runs no connection and no process is left`, gate.openNow().length === 0 && live.size === 0, J({ open: gate.openNow().length, live: live.size }));
  else check(`${name}: after ${N} runs every open connection belongs to a live kept process, at most one per chat`, orphans().length === 0 && gate.openNow().length <= 5 && live.size <= 5, J({ open: gate.openNow().length, orphans: orphans().length, live: live.size }));
  H.agent.onEngineReset?.();
  try { H.agent.engines.claudecode.release?.(); } catch {}
}

(async () => {
  H.hardStop(110000);
  await engineSuite('grokbuild');
  await engineSuite('claudecode');
  H.finish();
})().catch((err) => { console.error(err); H.check('suite crashed', false, err.stack); H.finish(); });
