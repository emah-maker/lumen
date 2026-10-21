// The close_tab guard (agent.js closeGuard / askCloses, features/ai-manners.js closeVerdict / closeCard), plain Node: no Electron.
// A tab the user owns (hands-off mode) or one with text typed into it is never closed on the AI's own say-so and never just refused:
// the user is asked on a card (Close / Keep, one card for several tabs), Bypass does not answer it, and the tool's answer says what they chose.
const M = require('../../src/features/ai-manners');
const { Agent } = require('../../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

// ---- the decision (pure)
{
  const v = M.closeVerdict;
  check('verdict: the user\'s tab under hands-off mode asks', v({ handsOff: true, ownTab: false }).ask === true && v({ handsOff: true }).theirs === true);
  check('verdict: a tab the AI opened, nothing typed in it, does not ask', v({ handsOff: true, ownTab: true }).ask === false);
  check('verdict: hands-off off and nothing typed: not guarded (the site card applies as before)', v({}).ask === false);
  check('verdict: typed text asks, even on the AI\'s own tab or with hands-off off', v({ ownTab: true, unsaved: 'yes' }).ask === true && v({ unsaved: 'yes' }).ask === true);
  check('verdict: a page that could not be checked counts as typed text', v({ unsaved: 'unknown' }).ask === true && v({ unsaved: 'unknown' }).unsaved === 'unknown');
  check('verdict: junk is "no"', v({ unsaved: 'maybe' }).unsaved === 'no');
  const one = M.closeCard([{ title: 'Inbox (35) - me@gmail.com - Gmail', host: 'mail.google.com', theirs: true, unsaved: 'no' }]);
  check('card: one tab is named and says it is the user\'s, with Close / Keep', /^Close Inbox \(35\)/.test(one.title) && /your tab/.test(one.detail) && one.allowLabel === 'Close' && one.denyLabel === 'Keep', JSON.stringify(one));
  const two = M.closeCard([{ title: 'Inbox (35)', host: 'a.test', theirs: true, unsaved: 'no' }, { title: 'Inbox (30,719)', host: 'b.test', theirs: true, unsaved: 'yes' }]);
  check('card: several tabs make one card that lists them and flags the one with typed text', two.title === 'Close 2 of your tabs?' && /Inbox \(35\)/.test(two.args) && /Inbox \(30,719\).*unsaved text/.test(two.args) && /text typed/.test(two.detail), JSON.stringify(two));
  const unk = M.closeCard([{ title: 'Mail', host: 'a.test', theirs: false, unsaved: 'unknown' }]);
  check('card: a tab that could not be checked says so, and a tab of the AI\'s is not called yours', /could not check/.test(unk.detail) && !/your tab/.test(unk.detail), unk.detail);
  const words = [M.closeKept('Gmail'), M.handsOffRefusal('close_tab'), M.CLOSE_NO_CHAT].join(' ');
  check('texts: Keep and the no-one-to-ask refusals say it is still open and never suggest another route', /still open|stays open/.test(words) && /do not (?:try to )?close it another way/.test(words) && !/open_tab|your own tab|work there|instead|workaround/i.test(words), words);
  check('typed grant: only a typed "without asking" about closing tabs counts', M.closeGranted(['please close my mail tabs without asking']) && M.closeGranted(['close the extra tabs, no need to ask']) && !M.closeGranted(['close my tabs']) && !M.closeGranted(['can you close my tabs without asking?']) && !M.closeGranted([]));
}

// ---- in the tool layer
const tabOf = (id, state) => ({ id, webContents: { id: 100 + id, getURL: () => `https://${state.host?.[id] || `t${id}.test`}/`, getTitle: () => state.title?.[id] || `Tab ${id}`, isDestroyed: () => false } });
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
  requestCloseTab: (id) => { if (!state.blocked?.has(id)) state.open.delete(id); },
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
    const state = { active: 1, open: new Set([1, 2, 3, 4]), ai: new Set([4]), handsOff: true, title: { 2: 'Inbox (35) - me@gmail.com - Gmail', 3: 'Inbox (30,719) - Kitchenlab Mail' }, host: { 2: 'mail.google.com', 3: 'mail.kitchenlab.test' }, ...extra };
    const agent = newAgent(state);
    const cards = [];
    const emitted = [];
    const emit = (e) => emitted.push(e);
    const chat = [];
    chat.settings = { model: 'claude-opus-5' };
    const answers = [];
    const realAsk = agent.askApproval.bind(agent);
    agent.askApproval = (...args) => { cards.push({ ...args[3], host: args[0] }); const reply = answers.shift(); return reply === undefined ? realAsk(...args) : Promise.resolve(reply); };
    const gate = (name, input, extraOpts = {}) => agent.inTask(1, signal, () => agent.ensureAllowed(name, emit, signal, { input, ...extraOpts }), chat);
    const run = (name, input) => agent.inTask(1, signal, () => agent.execute(name, input), chat);
    return { state, agent, cards, emitted, answers, gate, run, chat };
  };

  { // Close closes
    const s = setup();
    s.answers.push(true);
    const input = { tab_id: 2 };
    check('Close: the gate lets the call through after one card', (await refused(() => s.gate('close_tab', input))) === null && s.cards.length === 1, String(s.cards.length));
    check('Close: the card is the Close / Keep one, never answered by Bypass or Always', s.cards[0].allowLabel === 'Close' && s.cards[0].denyLabel === 'Keep' && s.cards[0].noBypass === true && s.cards[0].noAlways === true && /^Close Inbox \(35\)/.test(s.cards[0].title) && /your tab/.test(s.cards[0].detail), JSON.stringify(s.cards[0]));
    const result = await s.run('close_tab', input);
    check('Close: the tab is closed and the result says the user chose it', !s.state.open.has(2) && /Closed tab 2/.test(result) && /chose Close/.test(result), result);
  }
  { // Keep keeps
    const s = setup();
    s.answers.push(false);
    const input = { tab_id: 2 };
    const msg = await refused(() => s.gate('close_tab', input));
    check('Keep: the call ends with what the user chose and no way round it', /chose to keep/.test(msg || '') && /NOT closed/.test(msg || '') && /do not close it another way/.test(msg || ''), msg);
    const again = await refused(() => s.run('close_tab', input));
    check('Keep: the same call run anyway still does not close it (execute checks too)', s.state.open.has(2) && /Hands-off mode is on/.test(again || ''), again);
  }
  { // batch
    const s = setup();
    s.answers.push(true);
    const a = { tab_id: 2 }, b = { tab_id: 3 };
    await s.gate('close_tab', a, { closeSiblings: [a, b] });
    await s.gate('close_tab', b, { closeSiblings: [a, b] });
    check('batch: two of the user\'s tabs in one step make ONE card listing both', s.cards.length === 1 && s.cards[0].title === 'Close 2 of your tabs?' && /Inbox \(35\)/.test(s.cards[0].args) && /Kitchenlab/.test(s.cards[0].args), JSON.stringify(s.cards));
    await s.run('close_tab', a); await s.run('close_tab', b);
    check('batch: Close closes both', !s.state.open.has(2) && !s.state.open.has(3));
  }
  { // batch keep
    const s = setup();
    s.answers.push(false);
    const a = { tab_id: 2 }, b = { tab_id: 3 };
    const ma = await refused(() => s.gate('close_tab', a, { closeSiblings: [a, b] }));
    const mb = await refused(() => s.gate('close_tab', b, { closeSiblings: [a, b] }));
    check('batch: Keep answers both calls, one card, nothing closed', s.cards.length === 1 && /chose to keep/.test(ma || '') && /chose to keep/.test(mb || '') && s.state.open.has(2) && s.state.open.has(3));
  }
  { // unsaved
    const s = setup({ handsOff: false, unsaved: { 2: 'yes' } });
    s.answers.push(true);
    const input = { tab_id: 2 };
    check('unsaved text: asks even with hands-off off, and the card says so', (await refused(() => s.gate('close_tab', input))) === null && s.cards.length === 1 && /unsaved text/.test(s.cards[0].args) && /text typed/.test(s.cards[0].detail), JSON.stringify(s.cards));
    s.state.blocked = new Set([2]); // the page's own "Leave site?" holds it
    const result = await s.run('close_tab', input);
    check('unsaved text: Close closes it even when the page\'s own check held it', !s.state.open.has(2) && s.state.forced === 1 && /Closed tab 2/.test(result), result);
    const t = setup({ handsOff: false, unsaved: { 2: 'unknown' } });
    t.answers.push(false);
    await refused(() => t.gate('close_tab', { tab_id: 2 }));
    check('unsaved text: a page that could not be checked asks, saying so', t.cards.length === 1 && /could not check/.test(t.cards[0].detail), JSON.stringify(t.cards));
    const u = setup({ handsOff: false });
    await refused(() => u.gate('close_tab', { tab_id: 2 }));
    check('no guard: a tab with nothing typed and hands-off off asks no Close / Keep card', !u.cards.some((c) => c.allowLabel === 'Close'), JSON.stringify(u.cards));
  }
  { // the AI's own tab
    const s = setup();
    await refused(() => s.gate('close_tab', { tab_id: 4 }));
    check('own tab: a tab the AI opened closes without a Close / Keep card', !s.cards.some((c) => c.allowLabel === 'Close'));
  }
  { // Bypass
    const s = setup({ bypass: true });
    const input = { tab_id: 2 };
    const pending = s.gate('close_tab', input);
    await new Promise((r) => setTimeout(r, 30));
    const card = s.emitted.find((e) => e.type === 'approval');
    check('Bypass: the card is still shown (Bypass never answers it)', Boolean(card) && card.noBypass === true && card.allowLabel === 'Close' && !s.emitted.some((e) => e.name === 'auto_allowed'), JSON.stringify(s.emitted));
    s.agent.resolveApproval(card.approvalId, true);
    check('Bypass: only the user\'s Close lets it through', (await refused(() => pending)) === null);
    const t = setup({ bypass: true });
    t.chat.typed = ['close my mail tabs without asking'];
    check('Bypass: unless the user said in this chat to close tabs without asking', (await refused(() => t.gate('close_tab', { tab_id: 2 }))) === null && !t.cards.some((c) => c.allowLabel === 'Close'));
    const u = setup({ bypass: true, unsaved: { 2: 'yes' } });
    u.chat.typed = ['close my mail tabs without asking'];
    u.answers.push(false);
    await refused(() => u.gate('close_tab', { tab_id: 2 }));
    check('Bypass: a tab with unsaved text still asks even then', u.cards.filter((c) => c.allowLabel === 'Close').length === 1);
  }
  { // callers that cannot ask
    const s = setup();
    const msg = await refused(() => s.gate('close_tab', { tab_id: 2 }, { external: true }));
    check('outside agent: refused in plain words, no card, no workaround', !s.cards.some((c) => c.allowLabel === 'Close') && /still open/.test(msg || '') && /another way/.test(msg || '') && !/open_tab/.test(msg || ''), msg);
    const t = setup({ handsOff: false, unsaved: { 2: 'yes' } });
    const m2 = await refused(() => t.gate('close_tab', { tab_id: 2 }, { noAsk: true }));
    check('no one to ask: typed text keeps the tab and says it is still open', !t.cards.some((c) => c.allowLabel === 'Close') && /still open/.test(m2 || ''), m2);
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
