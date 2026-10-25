// close_tab never asks and never pauses the run (agent.js closeDecisionFor / execute, features/ai-manners.js closeDecision / closeLeft), plain Node: no Electron.
// A tab holding the user's unsaved text, or one whose page asks "Leave site?", is simply left open and the tool says so; an autosaving
// editor (Google Docs...) counts as saved once its indicator says so; the user's own tab under hands-off mode is refused. No approval card, ever.
const M = require('../../src/features/ai-manners');
const { Agent } = require('../../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

// ---- the decision (pure)
{
  const d = M.closeDecision;
  check('decision: nothing typed closes', d({}).act === 'close' && d({ ownTab: true }).act === 'close');
  check('decision: unsaved text is left open (even on the AI\'s own tab)', d({ unsaved: 'yes' }).act === 'leave' && d({ unsaved: 'yes', ownTab: true }).act === 'leave');
  check('decision: a page that could not be checked is left open', d({ unsaved: 'unknown' }).act === 'leave' && d({ unsaved: 'unknown' }).why === 'unknown');
  check('decision: junk counts as nothing typed', d({ unsaved: 'maybe' }).act === 'close');
  check('decision: Docs saved closes even with text in its field', d({ unsaved: 'yes', save: 'saved' }).act === 'close' && d({ unsaved: 'unknown', save: 'saved' }).act === 'close');
  check('decision: Docs still saving waits', d({ save: 'saving' }).act === 'wait');
  check('decision: text the AI typed into a tab it opened is not the user\'s work', d({ unsaved: 'yes', ownTab: true, aiTyped: true }).act === 'close' && d({ unsaved: 'yes', ownTab: false, aiTyped: true }).act === 'leave' && d({ unsaved: 'unknown', ownTab: true, aiTyped: true }).act === 'leave');
  check('decision: the user\'s tab under hands-off mode is refused, not asked', d({ handsOff: true }).act === 'refuse' && d({ handsOff: true, ownTab: true }).act === 'close');
  check('autosave hosts: Docs, Sheets, Notion, Office online yes; a mail site no', ['docs.google.com', 'www.notion.so', 'word-edit.officeapps.live.com', 'onedrive.live.com'].every(M.autosaveHost) && !M.autosaveHost('mail.google.com') && !M.autosaveHost('example.com') && !M.autosaveHost('docs.google.com.example.com'));
  const run = (texts) => new Function('document', `return ${M.autosaveScript()}`)({ querySelectorAll: () => texts.map((t) => ({ innerText: t, getAttribute: () => '' })) });
  check('autosave script: "Saving..." is saving, "Saved to Drive" and no indicator are saved', run(['Saving...']) === 'saving' && run(['Unsaved changes']) === 'saving' && run(['Saved to Drive']) === 'saved' && run([]) === 'saved');
  const left = [M.closeLeft('Untitled document - Google Docs', 'yes'), M.closeLeft('x', 'unknown'), M.closeLeft('x', 'leave'), M.closeLeft('x', 'saving')];
  check('texts: "Left <title> open: it has unsaved text", and it tells the AI to carry on', /^Left "Untitled document - Google Docs" open: it has unsaved text/.test(left[0]) && left.every((t) => /carry on/.test(t) && /open/.test(t)), left[0]);
  check('texts: the hands-off refusal says it is still open and suggests no other route', /still open/.test(M.CLOSE_REFUSAL) && /do not try to close it another way/.test(M.CLOSE_REFUSAL) && M.handsOffRefusal('close_tab') === M.CLOSE_REFUSAL);
}

// ---- in the tool layer
const tabOf = (id, state) => ({ id, webContents: { id: 100 + id, getURL: () => `https://${state.host?.[id] || `t${id}.test`}/`, getTitle: () => state.title?.[id] || `Tab ${id}`, isDestroyed: () => false, on: () => {}, off: () => {}, removeListener: () => {} } });
const makeBrowser = (state) => ({
  activeTab: () => tabOf(state.active, state),
  tabById: (id) => (state.open.has(id) ? tabOf(id, state) : null),
  listTabs: () => [...state.open].map((id) => ({ id, title: state.title?.[id] || `Tab ${id}`, url: `https://t${id}.test/`, active: id === state.active })),
  effectiveModel: (m) => m, aiOff: () => false, noTabReason: () => 'No tab open.', maxSteps: () => 0,
  autoApprove: () => true,
  handsOff: () => state.handsOff === true,
  bypassPermissions: () => state.bypass === true,
  isAiTab: (id) => state.ai.has(id),
  tabOff: () => false,
  unsavedState: async (id) => state.unsaved?.[id] || 'no',
  hasUnsavedInput: async (id) => (state.unsaved?.[id] || 'no') !== 'no',
  saveState: async (id) => { const seq = state.saves?.[id]; if (!seq) return 'unknown'; return seq.length > 1 ? seq.shift() : seq[0]; },
  requestCloseTab: (id) => { if (!state.blocked?.has(id)) state.open.delete(id); }, // (blocked: the page's own "Leave site?" keeps it)
  closeTab: (id) => { state.open.delete(id); state.forced = (state.forced || 0) + 1; },
  typingText: () => 'Waiting...',
});
const newAgent = (state) => {
  const agent = new Agent(makeBrowser(state), () => null, () => ({ model: 'claude-opus-5' }));
  agent.closeSignedInTabs = () => {};
  agent.newActionLog = () => ({});
  agent.undoSummary = () => null;
  return agent;
};

(async () => {
  const signal = new AbortController().signal;
  const setup = (extra = {}) => {
    const state = { active: 1, open: new Set([1, 2, 3, 4, 5]), ai: new Set([4, 5]), handsOff: false, title: { 2: 'Inbox (35) - Gmail', 3: 'Compose - Draft Mail', 4: 'Untitled document - Google Docs', 5: 'Scratch' }, host: { 2: 'mail.google.com', 3: 'mail.example.test', 4: 'docs.google.com', 5: 'scratch.test' }, ...extra };
    const agent = newAgent(state);
    const cards = [];
    const emitted = [];
    const emit = (e) => emitted.push(e);
    const chat = [];
    chat.settings = { model: 'claude-opus-5' };
    const realAsk = agent.askApproval.bind(agent);
    agent.askApproval = (...args) => { cards.push({ ...args[3], host: args[0] }); return realAsk(...args); };
    // the whole path a real call takes: the gate (ensureAllowed), then the tool
    const call = (input, opts = {}) => agent.inTask(1, signal, async () => { await agent.ensureAllowed('close_tab', emit, signal, { input, ...opts }); return agent.execute('close_tab', input); }, chat);
    const type = (id) => agent.inTask(1, signal, async () => { agent.taskTab = () => ({ id }); agent.noteAiTyped(); }, chat);
    return { state, agent, cards, emitted, call, type };
  };
  const noApproval = (s) => s.cards.length === 0 && !s.emitted.some((e) => e.type === 'approval');

  { // unsaved text: left open, no card
    const s = setup({ unsaved: { 3: 'yes' } });
    const out = await s.call({ tab_id: 3 });
    check('unsaved text: the tab stays open and the answer says so', s.state.open.has(3) && /^Left "Compose - Draft Mail" open: it has unsaved text/.test(out), out);
    check('unsaved text: no approval card, nothing waiting', noApproval(s) && !s.state.forced);
  }
  { // unknown
    const s = setup({ unsaved: { 3: 'unknown' } });
    const out = await s.call({ tab_id: 3 });
    check('could not check: left open, says so, no card', s.state.open.has(3) && /could not check/.test(out) && noApproval(s), out);
  }
  { // beforeunload
    const s = setup({ blocked: new Set([3]) });
    const out = await s.call({ tab_id: 3 });
    check('"Leave site?": the page keeps the tab, the answer says so, nothing is forced, no card', s.state.open.has(3) && /Left "Compose - Draft Mail" open: the page asked to keep it/.test(out) && !s.state.forced && noApproval(s), out);
  }
  { // clean tab
    const s = setup();
    const out = await s.call({ tab_id: 2 });
    check('nothing typed: closes, no card', !s.state.open.has(2) && /Closed tab 2/.test(out) && noApproval(s), out);
  }
  { // Docs saved
    const s = setup({ unsaved: { 4: 'yes' }, saves: { 4: ['saved'] } });
    const out = await s.call({ tab_id: 4 });
    check('Docs saved (its field has text): closes normally, no card', !s.state.open.has(4) && /Closed tab 4/.test(out) && noApproval(s), out);
  }
  { // Docs: save state unreadable -> typed-text check
    const s = setup({ unsaved: { 4: 'yes' } });
    const out = await s.call({ tab_id: 4 });
    check('Docs whose save state cannot be read: the typed-text check decides (left open)', s.state.open.has(4) && /Left/.test(out), out);
  }
  { // Docs saving then saved
    const s = setup({ unsaved: { 4: 'yes' }, saves: { 4: ['saving', 'saving', 'saved'] } });
    const t0 = Date.now();
    const out = await s.call({ tab_id: 4 });
    check('Docs mid-save: waits for it to settle, then closes', !s.state.open.has(4) && /Closed tab 4/.test(out) && Date.now() - t0 < 3000, `${out} ${Date.now() - t0}ms`);
  }
  { // Docs stuck saving
    const s = setup({ unsaved: { 4: 'yes' }, saves: { 4: ['saving'] } });
    const t0 = Date.now();
    const out = await s.call({ tab_id: 4 });
    const took = Date.now() - t0;
    check('Docs stuck saving: waits about 3 s at most, then leaves it open and says so', s.state.open.has(4) && /still saving/.test(out) && took >= 2500 && took < 5000 && noApproval(s), `${out} ${took}ms`);
  }
  { // AI typed
    const s = setup({ unsaved: { 5: 'yes' } });
    const first = await s.call({ tab_id: 5 });
    check('text in a tab the AI opened, not typed by it: left open', s.state.open.has(5) && /Left/.test(first), first);
    await s.type(5);
    const out = await s.call({ tab_id: 5 });
    check('text the AI typed itself into its own tab: not the user\'s work, so it closes', !s.state.open.has(5) && /Closed tab 5/.test(out) && noApproval(s), out);
    const t = setup({ unsaved: { 2: 'yes' } });
    await t.type(2);
    check('...but never on a tab the AI did not open', /Left/.test(await t.call({ tab_id: 2 })) && t.state.open.has(2));
  }
  { // user's own tab, hands-off
    const s = setup({ handsOff: true });
    const msg = await refused(() => s.call({ tab_id: 2 }));
    check('hands-off: the user\'s tab is refused in plain words (still open), with no card', s.state.open.has(2) && /still open/.test(msg || '') && noApproval(s), msg);
    const own = await s.call({ tab_id: 5 });
    check('hands-off: a tab the AI opened still closes', !s.state.open.has(5) && /Closed tab 5/.test(own), own);
  }
  { // Bypass / callers that cannot ask behave the same: nothing to ask
    const s = setup({ bypass: true, unsaved: { 3: 'yes' } });
    const a = await s.call({ tab_id: 3 });
    const b = await s.call({ tab_id: 3 }, { external: true, noAsk: true });
    check('same answer for Bypass, outside agents and background tasks: left open, no card', /Left/.test(a) && /Left/.test(b) && s.state.open.has(3) && noApproval(s), `${a} / ${b}`);
  }
  { // a batch of closes: no card, each decided on its own
    const s = setup({ unsaved: { 3: 'yes' } });
    const ra = await s.call({ tab_id: 2 });
    const rb = await s.call({ tab_id: 3 });
    check('two closes in one step: the clean one closes, the one with text stays, no card', !s.state.open.has(2) && s.state.open.has(3) && /Closed/.test(ra) && /Left/.test(rb) && noApproval(s));
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
