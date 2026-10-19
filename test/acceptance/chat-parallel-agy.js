// ACCEPTANCE (feature: parallel Antigravity chats). Run alone: node scripts/test-acceptance.js chat-parallel-agy
//
// Antigravity chats in different tabs run at the same time. agy reads its MCP connection (Lumen's token) from a config file
// under its HOME and keeps its conversations there too, so each chat runs in a home folder of its own
// (<userData>/antigravity-chats/<chat id>, antigravity.js chatHomeFor): two runs never share a token file, a tool call that
// comes in on run A's connection acts for chat A in tab A, and each chat's follow-ups resume its own conversation. A chat
// saved before this change (its conversation in the main home, antigravity-home) still resumes, and a deleted chat's home
// goes with it.
//
// The real Agent, ai-agents.js MCP entry and AntigravityEngine, with a fake agy (fake-chat-cli.js in its agy role,
// fake-agy-role.js) that reads its token a moment after it starts, as a real CLI reads its config. Expected to FAIL before
// this change: the second Antigravity chat waits ("works on one chat at a time") and both used one home.
const fs = require('fs');
const path = require('path');
const H = require('./chat-harness'); // (first: it wraps child_process.spawn before any engine module loads)
const TC = require('../../src/features/tab-chats');
const AG = require('../../src/ai/antigravity');

const { check, chat, send, until, readLog, release, gate, live, executed, toolCall, textOf, errorsOf, lastAssistant, turnText, tmp } = H;
const J = (v) => JSON.stringify(v);
const MODEL = 'antigravity:default';
const agyLog = () => readLog().filter((e) => e.role === 'agy');
const agyMsg = (marker) => agyLog().find((e) => e.ev === 'msg' && e.marker === marker) || null;
const agyStart = (pid) => agyLog().find((e) => e.ev === 'start' && e.pid === pid) || null;
const isDone = (run) => run.events.some((e) => e.type === 'done');
const reached = (marker, run, ms = 15000) => until(() => agyMsg(marker) || (isDone(run) ? 'done' : null), ms).then((v) => (v && v !== 'done' ? v : agyMsg(marker)));
const sendIn = (messages, chatId, text, tabId) => send(messages, text, tabId, { meta: { chatId } });
const sameDir = (a, b) => Boolean(a && b) && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const mcpFileOf = (home) => path.join(home, '.gemini', 'config', 'mcp_config.json');

// ---- the waiting line: Antigravity no longer takes turns
{
  const s = TC.createRunSlots({ max: 3 });
  const go = (id) => s.request(id, { kind: TC.slotKind(MODEL), start: () => {} });
  check('slots: an Antigravity chat is a CLI chat like the others', TC.slotKind(MODEL) === 'cli' && TC.slotKind('antigravity:gemini-3.1-pro-high') === 'cli');
  check('slots: two Antigravity chats both start when there is room', go('ag1') === 'started' && go('ag2') === 'started' && s.size() === 2, J({ reason: s.reason('ag2') }));
  check('slots: past the cap the reason is the cap, never "cli"', go('ag3') === 'started' && go('ag4') === 'queued' && s.reason('ag4') === 'limit', s.reason('ag4'));
}

// ---- the texts no longer say Antigravity works on one chat at a time
{
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'locales', 'en.json'), 'utf8'));
  const settingsJs = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'settings.js'), 'utf8');
  check('settings text: "Chats working at once" no longer says Antigravity works on one chat at a time', !/one chat at a time/i.test(en['settings.ai.maxChatRunsDesc'] || '') && !/Antigravity works on one chat at a time/.test(settingsJs), en['settings.ai.maxChatRunsDesc']);
  check('the "waiting for Antigravity" line is gone', !('agent.waitingCli' in en));
}

(async () => {
  H.hardStop(110000);
  const userData = tmp;
  const mainHome = path.join(userData, 'antigravity-home');

  // ---- two chats, two tabs, at once
  const A = chat(MODEL);
  const B = chat(MODEL);
  const ra = sendIn(A, 'agyA', 'RUN-YA HOLD-YA first', 1);
  const rb = sendIn(B, 'agyB', 'RUN-YB HOLD-YB second', 2);
  const ma = await reached('RUN-YA', ra);
  const mb = await reached('RUN-YB', rb);
  check('Antigravity: chats in tab 1 and tab 2 both reach their CLI while neither has finished', Boolean(ma && mb) && !isDone(ra) && !isDone(rb), J({ a: Boolean(ma), b: Boolean(mb), errorsA: errorsOf(ra.events), errorsB: errorsOf(rb.events) }));
  check('Antigravity: the second chat is not refused or held back ("another chat", "one chat at a time")', ![...errorsOf(ra.events), ...errorsOf(rb.events)].some((t) => /another chat|one chat at a time/i.test(t)), J([...errorsOf(ra.events), ...errorsOf(rb.events)]));
  check('Antigravity: two agy processes are alive at the same time', Boolean(ma && mb) && ma.pid !== mb.pid && live.has(ma.pid) && live.has(mb.pid), J({ pids: [ma?.pid, mb?.pid], live: [...live.keys()] }));
  check('Antigravity: each chat runs in its own home folder (not the shared one)', Boolean(ma && mb) && sameDir(ma.home, AG.chatHomeFor(userData, 'agyA')) && sameDir(mb.home, AG.chatHomeFor(userData, 'agyB')) && !sameDir(ma.home, mb.home) && !sameDir(ma.home, mainHome), J({ a: ma?.home, b: mb?.home }));
  check('Antigravity: each run read its OWN MCP token (its own connection, both open), though both read the config after the other was written', Boolean(ma?.token && mb?.token) && ma.token !== mb.token && gate.openNow().includes(ma.token) && gate.openNow().includes(mb.token), J({ a: ma?.token?.slice(0, 8), b: mb?.token?.slice(0, 8), open: gate.openNow().length }));
  check('Antigravity: the second chat got an engine of its own for the message', H.agent.engines.sideCount() === 1, String(H.agent.engines.sideCount()));

  // ---- tool calls go to the run they came from
  if (ma?.token && mb?.token) {
    executed.length = 0;
    const evA0 = ra.events.length; const evB0 = rb.events.length;
    H.state.active = 3; // the user looks at another tab meanwhile
    const outB = await toolCall(mb.token, 'read_page');
    const outA = await toolCall(ma.token, 'read_page');
    const rowsA = ra.events.slice(evA0).filter((e) => e.type === 'tool');
    const rowsB = rb.events.slice(evB0).filter((e) => e.type === 'tool');
    check('Antigravity: tool calls on run A\'s and run B\'s connections are both accepted', outA && !outA.isError && outB && !outB.isError, J({ outA, outB }));
    check('Antigravity: run A\'s tool acted on tab 1 and run B\'s on tab 2 (not the tab in front, not each other\'s)', J(executed.map((e) => e.tab)) === '[2,1]', J(executed));
    check('Antigravity: each call\'s step row shows on its own chat only', rowsA.length === 1 && rowsB.length === 1, J({ rowsA: rowsA.length, rowsB: rowsB.length }));
    H.state.active = 1;
  } else {
    check('Antigravity: tool calls route to their own run (skipped: the runs never both started)', false, 'no tokens');
  }

  release('YA'); release('YB');
  await Promise.race([Promise.all([ra.done, rb.done]), H.sleep(15000)]);
  check('Antigravity: each chat gets its own reply', /reply from RUN-YA/.test(turnText(lastAssistant(A))) && /reply from RUN-YB/.test(turnText(lastAssistant(B))) && !/RUN-YB/.test(textOf(ra.events)) && !/RUN-YA/.test(textOf(rb.events)), J({ a: turnText(lastAssistant(A)), b: turnText(lastAssistant(B)) }));
  const sA = A.settings.agySession;
  const sB = B.settings.agySession;
  check('Antigravity: each chat keeps its own conversation (agySession, agySeen)', Boolean(sA && sB) && sA !== sB && sA === ma?.session && sB === mb?.session && A.settings.agySeen === A.length && B.settings.agySeen === B.length, J({ sA, sB, a: ma?.session, b: mb?.session, seenA: A.settings.agySeen, nA: A.length }));

  // ---- connections and engines freed
  await until(() => gate.openNow().length === 0 && live.size === 0, 5000);
  check('Antigravity: after both finish, both connections and processes are gone, and the extra engine is freed', gate.openNow().length === 0 && live.size === 0 && H.agent.engines.sideCount() === 0 && !H.agent.engines.leased('antigravity'), J({ open: gate.openNow().length, live: live.size, side: H.agent.engines.sideCount() }));
  check('Antigravity: no run token file is left in either chat\'s home', !fs.existsSync(mcpFileOf(AG.chatHomeFor(userData, 'agyA'))) && !fs.existsSync(mcpFileOf(AG.chatHomeFor(userData, 'agyB'))));

  // ---- follow-ups, at once: each resumes its own conversation in its own home
  const ra2 = sendIn(A, 'agyA', 'RUN-YA2 HOLD-YA2 again', 1);
  const rb2 = sendIn(B, 'agyB', 'RUN-YB2 HOLD-YB2 again', 2);
  const ma2 = await reached('RUN-YA2', ra2);
  const mb2 = await reached('RUN-YB2', rb2);
  check('Antigravity: follow-ups in both chats run at the same time', Boolean(ma2 && mb2) && live.has(ma2.pid) && live.has(mb2.pid), J({ a: Boolean(ma2), b: Boolean(mb2) }));
  check('Antigravity: each follow-up resumes its own chat\'s conversation, in that chat\'s home', Boolean(ma2 && mb2) && ma2.resume && mb2.resume && ma2.session === sA && mb2.session === sB && sameDir(ma2.home, ma.home) && sameDir(mb2.home, mb.home) && !ma2.missing && !mb2.missing, J({ a: [ma2?.session, ma2?.missing], b: [mb2?.session, mb2?.missing] }));
  release('YA2'); release('YB2');
  await Promise.race([Promise.all([ra2.done, rb2.done]), H.sleep(15000)]);
  check('Antigravity: both follow-ups answered, with no error, and the conversations did not change', /reply from RUN-YA2/.test(turnText(lastAssistant(A))) && /reply from RUN-YB2/.test(turnText(lastAssistant(B))) && !errorsOf(ra2.events).length && !errorsOf(rb2.events).length && A.settings.agySession === sA && B.settings.agySession === sB, J({ ea: errorsOf(ra2.events), eb: errorsOf(rb2.events) }));

  // ---- stopping one chat leaves the other running
  const T = chat(MODEL);
  const O = chat(MODEL);
  const rt = sendIn(T, 'agyT', 'RUN-YT PARTIAL', 3);
  const ro = sendIn(O, 'agyO', 'RUN-YO HOLD-YO', 4);
  const mt = await reached('RUN-YT', rt);
  const mo = await reached('RUN-YO', ro);
  await until(() => textOf(rt.events).includes('partial output'), 5000);
  H.agent.stopFor(T);
  await Promise.race([rt.done, H.sleep(10000)]);
  await until(() => mt && gate.closed.has(mt.token) && !live.has(mt.pid), 6000);
  check('Antigravity: stopping one chat ends its run and closes its connection', Boolean(mt) && gate.closed.has(mt.token) && !live.has(mt.pid) && isDone(rt), J({ closed: mt && gate.closed.has(mt.token), alive: mt && live.has(mt.pid) }));
  check('Antigravity: ...and does not touch the other chat\'s run or connection', Boolean(mo) && live.has(mo.pid) && gate.openNow().includes(mo.token) && !isDone(ro), J({ alive: mo && live.has(mo.pid), done: isDone(ro) }));
  release('YO');
  await Promise.race([ro.done, H.sleep(15000)]);

  // ---- a chat saved before this change: its conversation is in the main home, and it still resumes
  const legacy = 'legacyconv1';
  fs.mkdirSync(path.join(mainHome, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(mainHome, '.gemini', 'antigravity-cli', 'conversations', `${legacy}.db`), 'RUN-OLD\n');
  fs.mkdirSync(path.join(mainHome, '.gemini', 'antigravity-cli', 'brain', legacy), { recursive: true });
  fs.writeFileSync(path.join(mainHome, '.gemini', 'antigravity-cli', 'brain', legacy, 'notes.md'), 'old');
  fs.writeFileSync(path.join(mainHome, '.gemini', 'oauth_creds.json'), '{"fake":"sign-in"}');
  const M = chat(MODEL, [{ role: 'user', content: 'RUN-OLD hello' }, { role: 'assistant', content: 'reply from RUN-OLD' }]);
  M.settings.agySession = legacy;
  M.settings.agyModel = MODEL;
  M.settings.agyFull = false;
  M.settings.agySeen = M.length;
  const rm = sendIn(M, 'agyM', 'RUN-YM after the update', 1);
  await Promise.race([rm.done, H.sleep(15000)]);
  const mm = agyMsg('RUN-YM');
  const mHome = AG.chatHomeFor(userData, 'agyM');
  check('migration: an existing chat\'s conversation moves into its own home and resumes there', Boolean(mm) && mm.resume && mm.session === legacy && !mm.missing && sameDir(mm.home, mHome) && fs.existsSync(path.join(mHome, '.gemini', 'antigravity-cli', 'brain', legacy, 'notes.md')), J({ mm, errors: errorsOf(rm.events) }));
  check('migration: the reply comes and the chat keeps its conversation', /reply from RUN-YM/.test(turnText(lastAssistant(M))) && M.settings.agySession === legacy && !errorsOf(rm.events).length, J({ errors: errorsOf(rm.events), s: M.settings.agySession }));
  check('sign-in files of the main home are shared with a chat\'s home', fs.readFileSync(path.join(mHome, '.gemini', 'oauth_creds.json'), 'utf8') === '{"fake":"sign-in"}');
  check('migration: other chats\' conversations and the logs are not copied into a new chat\'s home', !fs.existsSync(path.join(mHome, '.gemini', 'antigravity-cli', 'log')) && fs.readdirSync(path.join(mHome, '.gemini', 'antigravity-cli', 'conversations')).every((n) => n.startsWith(legacy)), J(fs.readdirSync(path.join(mHome, '.gemini', 'antigravity-cli', 'conversations'))));

  // ---- many at once, then nothing left
  const many = Array.from({ length: 4 }, () => chat(MODEL));
  const runs = many.map((m, i) => sendIn(m, `agyN${i}`, `RUN-YN${i} quick`, 1 + (i % 4)));
  await Promise.race([Promise.all(runs.map((r) => r.done)), H.sleep(20000)]);
  const replies = agyLog().filter((e) => e.ev === 'reply' && /^RUN-YN/.test(e.marker)).length;
  const tokens = new Set(agyLog().filter((e) => e.ev === 'start' && runs.length).map((e) => e.token));
  await until(() => gate.openNow().length === 0 && live.size === 0, 5000);
  check('Antigravity: four chats at once all answered, each on its own connection', replies === 4 && many.every((m, i) => new RegExp(`reply from RUN-YN${i}`).test(turnText(lastAssistant(m)))) && tokens.size === agyLog().filter((e) => e.ev === 'start').length, `${replies} of 4`);
  check('Antigravity: afterwards no connection, process or extra engine is left', gate.openNow().length === 0 && live.size === 0 && H.agent.engines.sideCount() === 0, J({ open: gate.openNow().length, live: live.size, side: H.agent.engines.sideCount() }));

  // ---- a deleted chat's home goes; homes of chats that are gone are pruned
  await AG.removeChatHome(userData, 'agyA');
  check('delete: a deleted chat\'s Antigravity home is removed (and only that one)', !fs.existsSync(AG.chatHomeFor(userData, 'agyA')) && fs.existsSync(AG.chatHomeFor(userData, 'agyB')));
  const gone = await AG.pruneChatHomes(userData, new Set(['agyB', 'agyM']));
  check('prune: homes of chats that no longer exist are removed, the kept ones stay', fs.existsSync(AG.chatHomeFor(userData, 'agyB')) && fs.existsSync(AG.chatHomeFor(userData, 'agyM')) && !fs.existsSync(AG.chatHomeFor(userData, 'agyT')) && gone.includes('agyT'), J(gone));

  H.finish();
})().catch((err) => { console.error(err); H.check('suite crashed', false, err.stack); H.finish(); });
