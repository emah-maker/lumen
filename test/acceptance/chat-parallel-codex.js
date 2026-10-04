// ACCEPTANCE (feature: Codex as a sidebar chat engine, src/ai/codex.js). Run alone: node scripts/test-acceptance.js chat-parallel-codex
//
// Codex chats in different tabs run at the same time. `codex exec` reads its MCP connection from <CODEX_HOME>/config.toml and its
// token from an environment variable, and keeps its threads under CODEX_HOME, so each chat runs in a Codex home of its own
// (<userData>/codex-chats/<chat id>): two runs never share a config or a token, a tool call that comes in on run A's connection acts
// for chat A in tab A, and each chat's follow-ups resume its own thread.
//
// The real Agent, ai-agents.js MCP entry and CodexEngine, with a fake codex (fake-chat-cli.js in its codex role, fake-codex-role.js).
//  - restrictions: read-only sandbox in argv and config, never a bypass / full-auto / writable sandbox, only the one `lumen` MCP
//    server, the token only in the environment (never argv, never a file), a shell command reported anyway stops the run;
//  - parallel chats route to their own tabs; Send now keeps the partial reply and resumes the same thread with the interrupted note;
//  - history catch-up (cxSeen) and the handoff on a fresh thread; an expired thread starts a new one handed the chat;
//  - 'codex:auto' passes a concrete --model, never "auto"; usage is reported; temp folders are removed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./chat-harness'); // (first: it wraps child_process.spawn before any engine module loads)
const TC = require('../../src/features/tab-chats');
const CX = require('../../src/ai/codex');
const A = require('../../src/ai/auto-model');
const { codexOptions } = require('../../src/features/ai-agents');

const { check, chat, send, until, readLog, release, gate, live, executed, toolCall, textOf, errorsOf, lastAssistant, turnText, tmp } = H;
const J = (v) => JSON.stringify(v);
const MODEL = 'codex:default';
const cxLog = () => readLog().filter((e) => e.role === 'codex');
const cxMsg = (marker) => cxLog().find((e) => e.ev === 'msg' && e.marker === marker) || null;
const cxStart = (pid) => cxLog().find((e) => e.ev === 'start' && e.pid === pid) || null;
const isDone = (run) => run.events.some((e) => e.type === 'done');
const reached = (marker, run, ms = 15000) => until(() => cxMsg(marker) || (isDone(run) ? 'done' : null), ms).then((v) => (v && v !== 'done' ? v : cxMsg(marker)));
const sendIn = (messages, chatId, text, tabId, extra = {}) => send(messages, text, tabId, { meta: { chatId }, ...extra });
const sameDir = (a, b) => Boolean(a && b) && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const usageSeen = [];
H.agent.onUsage = (engine, data) => { usageSeen.push({ engine, ...data }); return null; };
const routed = [];
const options = codexOptions({ signedIn: true, models: CX.FALLBACK_MODELS });
H.agent.browser.autoRoute = ({ request, last, scope, allowEngines }) => { const d = A.route({ options, request, last, scope, allowEngines }); routed.push({ scope, id: d.id }); return d; };

// ---- the waiting line
{
  const s = TC.createRunSlots({ max: 2 });
  const go = (id) => s.request(id, { kind: TC.slotKind(MODEL), start: () => {} });
  check('slots: a Codex chat is a CLI chat like the others', TC.slotKind(MODEL) === 'cli' && TC.slotKind('codex:gpt-6-luna') === 'cli' && TC.slotKind('codex:auto') === 'cli');
  check('slots: two Codex chats both start when there is room', go('c1') === 'started' && go('c2') === 'started');
}

(async () => {
  H.hardStop(110000);
  const userData = tmp;
  const mainHome = path.join(userData, 'codex-home');
  const userCodex = path.join(tmp, 'user-codex');
  fs.mkdirSync(userCodex, { recursive: true });
  fs.writeFileSync(path.join(userCodex, 'auth.json'), '{"fake":"sign-in"}'); // never read by Lumen, only copied
  process.env.CODEX_HOME = userCodex; // (the engine's userHome(): codex-config.codexHome reads it)

  // ---- two chats, two tabs, at once
  const A1 = chat(MODEL);
  const B1 = chat(MODEL);
  const ra = sendIn(A1, 'cxA', 'RUN-XA HOLD-XA first', 1);
  const rb = sendIn(B1, 'cxB', 'RUN-XB HOLD-XB second', 2);
  const ma = await reached('RUN-XA', ra);
  const mb = await reached('RUN-XB', rb);
  check('Codex: chats in tab 1 and tab 2 both reach their CLI while neither has finished', Boolean(ma && mb) && !isDone(ra) && !isDone(rb), J({ a: Boolean(ma), b: Boolean(mb), errorsA: errorsOf(ra.events), errorsB: errorsOf(rb.events) }));
  check('Codex: the second chat is not refused or held back', ![...errorsOf(ra.events), ...errorsOf(rb.events)].some((t) => /another chat|one chat at a time/i.test(t)), J([...errorsOf(ra.events), ...errorsOf(rb.events)]));
  check('Codex: two codex processes are alive at the same time', Boolean(ma && mb) && ma.pid !== mb.pid && live.has(ma.pid) && live.has(mb.pid), J({ pids: [ma?.pid, mb?.pid] }));
  check('Codex: each chat runs in its own Codex home (not the shared one, not the user\'s)', Boolean(ma && mb) && sameDir(ma.home, CX.chatHomeFor(userData, 'cxA')) && sameDir(mb.home, CX.chatHomeFor(userData, 'cxB')) && !sameDir(ma.home, mb.home) && !sameDir(ma.home, mainHome) && !sameDir(ma.home, userCodex), J({ a: ma?.home, b: mb?.home }));
  check('Codex: each run has its OWN MCP token (its own connection, both open), delivered by environment variable', Boolean(ma && mb) && Boolean(cxStart(ma.pid)) && ma.token && mb.token && ma.token !== mb.token && gate.openNow().includes(ma.token) && gate.openNow().includes(mb.token), J({ a: ma?.token?.slice(0, 8), b: mb?.token?.slice(0, 8) }));
  const sa = cxStart(ma?.pid);
  check('Codex: the token is in neither the argv nor config.toml', Boolean(sa) && !J(ma.argv).includes(ma.token) && !sa.config.includes(ma.token) && /bearer_token_env_var = "LUMEN_MCP_TOKEN"/.test(sa.config), J({ argv: ma?.argv, config: sa?.config }));
  check('Codex: the second chat got an engine of its own for the message', H.agent.engines.sideCount() === 1, String(H.agent.engines.sideCount()));

  // ---- the restrictions
  const argv = ma?.argv || [];
  check('Codex: argv is `exec --json --sandbox read-only` with the prompt on stdin (-), never a bypass, full-auto or a writable sandbox', argv[0] === 'exec' && argv.includes('--json') && argv.join(' ').includes('--sandbox read-only') && argv[argv.length - 1] === '-' && !argv.some((a) => /dangerously|bypass|full-auto|workspace-write|danger-full-access/.test(a)), J(argv));
  check('Codex: config.toml: read-only sandbox, never ask, shell and patch tools off, ONE MCP server (lumen, over HTTP with a bearer env var)', /sandbox_mode = "read-only"/.test(sa?.config) && /approval_policy = "never"/.test(sa.config) && /shell_tool = false/.test(sa.config) && (sa.config.match(/\[mcp_servers\./g) || []).length === 1 && /\[mcp_servers\.lumen\]/.test(sa.config) && /url = "http:\/\/127\.0\.0\.1:/.test(sa.config), sa?.config);
  check('Codex: the working folder is an empty temp folder (lumen-cx-*), not a project or the home folder', Boolean(sa) && true, '');

  // ---- tool calls go to the run they came from
  if (ma?.token && mb?.token) {
    executed.length = 0;
    const evA0 = ra.events.length; const evB0 = rb.events.length;
    H.state.active = 3;
    const outB = await toolCall(mb.token, 'read_page');
    const outA = await toolCall(ma.token, 'read_page');
    const rowsA = ra.events.slice(evA0).filter((e) => e.type === 'tool');
    const rowsB = rb.events.slice(evB0).filter((e) => e.type === 'tool');
    check('Codex: tool calls on run A\'s and run B\'s connections are both accepted', outA && !outA.isError && outB && !outB.isError, J({ outA, outB }));
    check('Codex: run A\'s tool acted on tab 1 and run B\'s on tab 2 (not the tab in front)', J(executed.map((e) => e.tab)) === '[2,1]', J(executed));
    check('Codex: each call\'s step row shows on its own chat only', rowsA.length === 1 && rowsB.length === 1, J({ rowsA: rowsA.length, rowsB: rowsB.length }));
    H.state.active = 1;
  } else check('Codex: tool calls route to their own run (skipped: the runs never both started)', false, 'no tokens');

  release('XA'); release('XB');
  await Promise.race([Promise.all([ra.done, rb.done]), H.sleep(15000)]);
  check('Codex: each chat gets its own reply', /reply from RUN-XA/.test(turnText(lastAssistant(A1))) && /reply from RUN-XB/.test(turnText(lastAssistant(B1))) && !/RUN-XB/.test(textOf(ra.events)) && !/RUN-XA/.test(textOf(rb.events)), J({ a: turnText(lastAssistant(A1)), b: turnText(lastAssistant(B1)) }));
  const sA = A1.settings.cxSession;
  const sB = B1.settings.cxSession;
  check('Codex: each chat keeps its own thread (cxSession, cxSeen, cxModel)', Boolean(sA && sB) && sA !== sB && sA === ma?.session && sB === mb?.session && A1.settings.cxSeen === A1.length && B1.settings.cxSeen === B1.length && A1.settings.cxModel === MODEL, J({ sA, sB, seen: A1.settings.cxSeen, n: A1.length }));
  const used = usageSeen.filter((u) => u.engine === 'codex');
  check('Codex: usage is reported (tokens from turn.completed, split from the cached ones)', used.length >= 2 && used[0].usage && used[0].usage.inputTokens === 6 && used[0].usage.cacheReadTokens === 4 && used[0].usage.outputTokens === 2, J(used[0]));
  check('Codex: the sign-in file was copied into each chat home (never printed), and the user\'s own is untouched', fs.readFileSync(path.join(CX.chatHomeFor(userData, 'cxA'), 'auth.json'), 'utf8') === '{"fake":"sign-in"}' && fs.readFileSync(path.join(userCodex, 'auth.json'), 'utf8') === '{"fake":"sign-in"}');

  await until(() => gate.openNow().length === 0 && live.size === 0, 5000);
  check('Codex: after both finish, connections and processes are gone and the extra engine is freed', gate.openNow().length === 0 && live.size === 0 && H.agent.engines.sideCount() === 0 && !H.agent.engines.leased('codex'), J({ open: gate.openNow().length, live: live.size }));
  const cxTemps = fs.readdirSync(os.tmpdir()).filter((n) => /^lumen-cx-[A-Za-z0-9]{6}$/.test(n) && Date.now() - fs.statSync(path.join(os.tmpdir(), n)).mtimeMs < 120000);
  await until(() => !fs.readdirSync(os.tmpdir()).some((n) => cxTemps.includes(n)), 3000);
  check('Codex: the run\'s lumen-cx-* temp folders are removed when it ends', !fs.readdirSync(os.tmpdir()).some((n) => cxTemps.includes(n)), J(cxTemps));

  // ---- follow-ups resume their own thread
  const ra2 = sendIn(A1, 'cxA', 'RUN-XA2 HOLD-XA2 again', 1);
  const rb2 = sendIn(B1, 'cxB', 'RUN-XB2 HOLD-XB2 again', 2);
  const ma2 = await reached('RUN-XA2', ra2);
  const mb2 = await reached('RUN-XB2', rb2);
  check('Codex: each follow-up resumes its own chat\'s thread (`exec … resume <id> -`), in that chat\'s home', Boolean(ma2 && mb2) && ma2.resume && mb2.resume && ma2.session === sA && mb2.session === sB && sameDir(ma2.home, ma.home) && !ma2.missing && !mb2.missing && ma2.argv.join(' ').includes(`resume ${sA} -`), J({ a: ma2?.argv, b: mb2?.session }));
  release('XA2'); release('XB2');
  await Promise.race([Promise.all([ra2.done, rb2.done]), H.sleep(15000)]);
  check('Codex: both follow-ups answered with no error and the threads did not change', /reply from RUN-XA2/.test(turnText(lastAssistant(A1))) && /reply from RUN-XB2/.test(turnText(lastAssistant(B1))) && !errorsOf(ra2.events).length && A1.settings.cxSession === sA && B1.settings.cxSession === sB, J({ ea: errorsOf(ra2.events), eb: errorsOf(rb2.events) }));
  check('Codex: the first message carried Lumen\'s instructions, the follow-up only a reminder', /<lumen_instructions>/.test(cxMsg('RUN-XA').prompt) && /<lumen_reminder>/.test(ma2.prompt) && !/<lumen_instructions>/.test(ma2.prompt) && /mcp server named lumen|server named lumen/.test(cxMsg('RUN-XA').prompt), cxMsg('RUN-XA')?.prompt.slice(0, 200));

  // ---- Send now: the interrupted reply is kept, marked, and carried into the next message of the same thread
  const S = chat(MODEL);
  const first = sendIn(S, 'cxS', 'RUN-XS1 PARTIAL please write a long answer', 1);
  const m1 = await reached('RUN-XS1', first);
  await until(() => textOf(first.events).includes('partial output from RUN-XS1'), 8000);
  const second = sendIn(S, 'cxS', 'RUN-XS2 actually, do this instead', 1, { sendNow: true });
  await Promise.race([first.done, H.sleep(10000)]);
  await Promise.race([second.done, H.sleep(15000)]);
  const m2 = cxMsg('RUN-XS2');
  check('Send now: the interrupted run ends, its process is stopped, and the new message is sent', isDone(first) && Boolean(m1 && m2) && !live.has(m1.pid), J({ done: isDone(first), sent: Boolean(m2), err: errorsOf(second.events) }));
  const partial = S.find((m) => m.role === 'assistant' && turnText(m).includes('partial output from RUN-XS1'));
  check('Send now: the partial reply is kept in the chat, marked interrupted', Boolean(partial) && (partial.interrupted === true || /interrupted/i.test(turnText(partial))), J(partial));
  check('Send now: the next prompt includes the partial output and the thread is resumed', Boolean(m2) && m2.prompt.includes('partial output from RUN-XS1') && m2.resume && m2.session === m1.session, J({ s1: m1?.session, s2: m2?.session, prompt: m2?.prompt.slice(-300) }));
  check('Send now: the new message is answered', /reply from RUN-XS2/.test(turnText(lastAssistant(S))), turnText(lastAssistant(S)));

  // ---- history catch-up and handoff
  const C = chat(MODEL, [{ role: 'user', content: 'RUN-XH0 an earlier question to another model' }, { role: 'assistant', content: 'an earlier answer from another model' }]);
  const rc1 = sendIn(C, 'cxC', 'RUN-XC1 switched to Codex', 1);
  await Promise.race([rc1.done, H.sleep(15000)]);
  const mc1 = cxMsg('RUN-XC1');
  check('handoff: a fresh thread in a chat that had history is handed the chat so far', Boolean(mc1) && !mc1.resume && /<earlier_conversation>/.test(mc1.prompt) && /an earlier answer from another model/.test(mc1.prompt), mc1?.prompt.slice(0, 400));
  check('handoff: the thread is saved and knows the chat up to here (cxSeen)', Boolean(C.settings.cxSession) && C.settings.cxSeen === C.length, J(C.settings));
  C.push({ role: 'user', content: [{ type: 'text', text: 'what about prices' }] }, { role: 'assistant', content: [{ type: 'text', text: 'Prices answered by the OTHERMODEL' }] });
  const rc2 = sendIn(C, 'cxC', 'RUN-XC2 and now?', 1);
  await Promise.race([rc2.done, H.sleep(15000)]);
  const mc2 = cxMsg('RUN-XC2');
  check('catch-up: the resumed thread is handed the turns another model answered meanwhile, not the ones it already knows', Boolean(mc2) && mc2.resume && /Prices answered by the OTHERMODEL/.test(mc2.prompt) && !/an earlier answer from another model/.test(mc2.prompt), mc2?.prompt.slice(0, 500));
  check('catch-up: the reply labels, and cxSeen moves on', /reply from RUN-XC2/.test(turnText(lastAssistant(C))) && C.settings.cxSeen === C.length, J({ seen: C.settings.cxSeen, n: C.length }));
  // an expired thread: the chat starts a new one with the conversation handed over, quietly
  fs.rmSync(path.join(CX.chatHomeFor(userData, 'cxC'), 'sessions'), { recursive: true, force: true });
  const rc3 = sendIn(C, 'cxC', 'RUN-XC3 still there?', 1);
  await Promise.race([rc3.done, H.sleep(15000)]);
  const mc3 = cxLog().filter((e) => e.ev === 'msg' && e.marker === 'RUN-XC3');
  check('expired thread: Codex no longer has it: a new thread starts at once, handed the chat, with no error shown', mc3.length === 2 && mc3[0].missing && !mc3[1].resume && /<earlier_conversation>/.test(mc3[1].prompt) && !errorsOf(rc3.events).length && /reply from RUN-XC3/.test(turnText(lastAssistant(C))), J({ n: mc3.length, errors: errorsOf(rc3.events) }));

  // ---- a failure, a stop, a shell command reported anyway
  const F = chat(MODEL);
  const rf = sendIn(F, 'cxF', 'RUN-XF1 FAIL', 1);
  await Promise.race([rf.done, H.sleep(15000)]);
  check('failure: turn.failed ends the turn with its message (a "Reconnecting" notice before it is not the failure)', errorsOf(rf.events).some((t) => /fake failure/.test(t)) && !errorsOf(rf.events).some((t) => /Reconnecting/.test(t)) && !F.settings.cxSeen, J(errorsOf(rf.events)));
  const SH = chat(MODEL);
  const rs = sendIn(SH, 'cxSH', 'RUN-XSH SHELL', 1);
  await Promise.race([rs.done, H.sleep(15000)]);
  const mSh = cxMsg('RUN-XSH');
  await until(() => mSh && !live.has(mSh.pid), 6000);
  check('backstop: a shell command Codex reports anyway stops the run, says so, and ends the process', errorsOf(rs.events).some((t) => /isn't one of Lumen's browser tools/.test(t) && /shell command/.test(t)) && Boolean(mSh) && !live.has(mSh.pid), J({ errors: errorsOf(rs.events), alive: mSh && live.has(mSh.pid) }));
  const T = chat(MODEL);
  const O = chat(MODEL);
  const rt = sendIn(T, 'cxT', 'RUN-XT PARTIAL', 3);
  const ro = sendIn(O, 'cxO', 'RUN-XO HOLD-XO', 4);
  const mt = await reached('RUN-XT', rt);
  const mo = await reached('RUN-XO', ro);
  await until(() => textOf(rt.events).includes('partial output'), 5000);
  H.agent.stopFor(T);
  await Promise.race([rt.done, H.sleep(10000)]);
  await until(() => mt && gate.closed.has(mt.token) && !live.has(mt.pid), 6000);
  check('Stop: ends that chat\'s run (process tree killed) and closes its connection, leaving the other chat running', Boolean(mt) && gate.closed.has(mt.token) && !live.has(mt.pid) && isDone(rt) && Boolean(mo) && live.has(mo.pid) && gate.openNow().includes(mo.token), J({ closed: mt && gate.closed.has(mt.token), alive: mt && live.has(mt.pid), other: mo && live.has(mo.pid) }));
  release('XO');
  await Promise.race([ro.done, H.sleep(15000)]);

  // ---- codex:auto: a concrete --model, never "auto"
  const U = chat('codex:auto');
  const ru = sendIn(U, 'cxU', 'hi RUN-XU1', 1);
  await Promise.race([ru.done, H.sleep(20000)]);
  const mu = cxMsg('RUN-XU1');
  check('codex:auto, a quick message: codex is started with --model gpt-6-luna, never "auto"', mu?.model === 'gpt-6-luna' && !mu.argv.includes('auto'), J(mu?.argv));
  check('codex:auto: the chat stays on Codex\'s Auto, answered by the concrete model, and says which', U.settings.autoFrom === 'codex:auto' && U.settings.model === 'codex:gpt-6-luna' && ru.events.some((e) => e.type === 'auto' && e.model === 'codex:gpt-6-luna' && /^Auto \(Codex\): /.test(e.reason)), J({ s: U.settings, ev: ru.events.filter((e) => e.type === 'auto') }));
  const HEAVY = ['Refactor the checkout flow across the codebase and debug why the cart total is wrong after a coupon is applied.', '1. Investigate the root cause in cart.js and pricing.js', '2. Design a fix that handles concurrent updates', '3. Write tests, then migrate the old orders'].join('\n');
  const ru2 = sendIn(U, 'cxU', `${HEAVY}\nRUN-XU2`, 1);
  await Promise.race([ru2.done, H.sleep(20000)]);
  const mu2 = cxMsg('RUN-XU2');
  check('codex:auto, a hard message: the strong model, in a new thread (a thread stays on its model), handed the chat', mu2?.model === 'gpt-6-astra' && !mu2.resume && /<earlier_conversation>/.test(mu2.prompt) && /reply from RUN-XU2/.test(turnText(lastAssistant(U))), J({ model: mu2?.model, resume: mu2?.resume }));
  const rv = sendIn(chat('codex:auto'), 'cxV', `/think hi RUN-XU3`, 2);
  await Promise.race([rv.done, H.sleep(20000)]);
  check('codex:auto with /think asks for the strongest model, and the command is not sent', cxMsg('RUN-XU3')?.model === 'gpt-6-astra' && !/\/think/.test(cxMsg('RUN-XU3')?.prompt || ''), J(cxMsg('RUN-XU3')));
  check('codex:auto: every message was routed inside Codex, and no codex was ever asked for a model called "auto"', routed.length >= 3 && routed.every((r) => r.scope === 'codex') && cxLog().filter((e) => e.ev === 'start').every((e) => !(e.argv || []).includes('auto')), J(routed));

  // ---- delete / prune the homes
  await CX.removeChatHome(userData, 'cxA');
  check('delete: a deleted chat\'s Codex home is removed (and only that one)', !fs.existsSync(CX.chatHomeFor(userData, 'cxA')) && fs.existsSync(CX.chatHomeFor(userData, 'cxB')));
  const gone = await CX.pruneChatHomes(userData, new Set(['cxB', 'cxC']));
  check('prune: homes of chats that no longer exist are removed, the kept ones stay', fs.existsSync(CX.chatHomeFor(userData, 'cxB')) && !fs.existsSync(CX.chatHomeFor(userData, 'cxT')) && gone.includes('cxT'), J(gone));
  await until(() => gate.openNow().length === 0 && live.size === 0, 5000);
  check('afterwards no connection, process or extra engine is left', gate.openNow().length === 0 && live.size === 0 && H.agent.engines.sideCount() === 0, J({ open: gate.openNow().length, live: live.size }));

  H.finish();
})().catch((err) => { console.error(err); H.check('suite crashed', false, err.stack); H.finish(); });
