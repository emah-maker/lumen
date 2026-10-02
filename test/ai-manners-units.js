// AI tab manners (features/ai-manners.js and what agent.js / app.js do with it), plain Node: no Electron.
// Covers which tabs "Close the tabs the AI opened" may close, the close setting (Off / Ask / Always), hands-off mode
// ("Don't let the AI act on my pages": enforced in the tool layer for every caller, reading still works), the user's
// focus (nothing the AI sends counts as the user's typing, the AI waits while the user types, the caret is put back),
// and the sidebar toggle that hides the tabs the AI opened from the strip.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../src/features/ai-manners');
const { Agent } = require('../src/ai/agent');
const scripts = require('../src/ai/page-scripts');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (v) => JSON.stringify(v);

// ---- tabs the AI opened
{
  const tab = { id: 1 };
  M.markOpened(tab, { chatId: 'c1', runId: 7 }, 1000);
  check('opened: a tab the AI opens carries its chat, run and time', J(tab.openedBy) === '{"chatId":"c1","runId":7,"at":1000}' && M.isAiTab(tab));
  check('opened: an outside agent / Lumen\'s own tab has null ids but is still marked', M.isAiTab(M.markOpened({ id: 2 })) && M.markOpened({ id: 2 }).openedBy.chatId === null);
  check('hand over: the user taking a tab makes it theirs, once', M.handOver(tab) === true && !M.isAiTab(tab) && M.handOver(tab) === false);
  check('hand over: a tab the AI never opened is not touched', M.handOver({ id: 9 }) === false && M.handOver(null) === false);

  const mk = (id, extra = {}) => M.markOpened({ id, ...extra }, { chatId: 'c1', runId: 7 });
  const tabs = [mk(1), mk(2, { pinned: true }), mk(3, { userMoved: true }), mk(4), { id: 5 }, mk(6, { closing: true }), M.markOpened({ id: 7 }, { chatId: 'c2', runId: 8 })];
  const ids = (sel) => sel.map((t) => t.id).join(',');
  check('close: never a pinned tab, one the user moved, one already closing, or one the AI did not open', ids(M.closeSelection(tabs)) === '1,4,7', ids(M.closeSelection(tabs)));
  check('close: only that run\'s tabs', ids(M.closeSelection(tabs, { runId: 7 })) === '1,4');
  check('close: only that chat\'s tabs', ids(M.closeSelection(tabs, { chatId: 'c2' })) === '7');
  check('close: never the tab a chat lives in', ids(M.closeSelection(tabs, { runId: 7, boundIds: [1] })) === '4');
  check('close: never a tab a run is working in right now', ids(M.closeSelection(tabs, { runId: 7, busyIds: [4] })) === '1');
  check('close: an automatic close leaves the tab the user is looking at', ids(M.closeSelection(tabs, { runId: 7, activeId: 4, auto: true })) === '1' && ids(M.closeSelection(tabs, { runId: 7, activeId: 4 })) === '1,4');
  check('close: the user clicking in a tab (handOver) takes it out of the selection', (() => { const t = mk(8); M.handOver(t); return ids(M.closeSelection([t])) === ''; })());
  check('close: a tab the user pinned after the AI opened it is not closed even if handOver was missed', ids(M.closeSelection([mk(9, { pinned: true })])) === '');
  check('close setting: only off / ask / always, anything else is off', J(['off', 'ask', 'always', 'x', null, 1].map(M.cleanCloseSetting)) === '["off","ask","always","off","off","off"]');
  check('after a run: nothing opened, nothing to offer', M.closeAfterRun({ setting: 'always', n: 0 }) === 'none');
  check('after a run: Off still offers a quiet "Close N tabs"; Ask asks; Always closes', M.closeAfterRun({ setting: 'off', n: 2 }) === 'offer' && M.closeAfterRun({ setting: 'ask', n: 2 }) === 'ask' && M.closeAfterRun({ setting: 'always', n: 2 }) === 'close');
}

// ---- hands-off mode: the pure rule
{
  const actions = ['click', 'click_at', 'type_text', 'fill_form', 'press_key', 'scroll', 'navigate', 'reload', 'go_back', 'go_forward', 'run_script', 'hover', 'close_tab'];
  check('hands-off: every tool that acts is refused on a tab the AI did not open', actions.every((tool) => M.handsOffCheck({ tool, handsOff: true, ownTab: false }) !== null));
  check('hands-off: reading is never refused', ['read_page', 'find', 'screenshot', 'read_tabs', 'list_tabs', 'read_urls', 'web_search', 'wait_for', 'read_pdf', 'open_tab', 'switch_tab'].every((tool) => M.handsOffCheck({ tool, handsOff: true, ownTab: false }) === null));
  check('hands-off: a tab the AI opened is its to work in', actions.every((tool) => M.handsOffCheck({ tool, handsOff: true, ownTab: true }) === null));
  check('hands-off: off by default, nothing is refused', actions.every((tool) => M.handsOffCheck({ tool, handsOff: false, ownTab: false }) === null) && M.handsOffCheck({ tool: 'click' }) === null);
  check('hands-off: the refusal tells the model what to do instead', /open_tab/.test(M.handsOffRefusal('click')) && /Reading/.test(M.handsOffRefusal('click')));
}

// ---- hands-off mode: enforced in the tool layer, for every caller
const tabOf = (id) => ({ id, webContents: { id: 100 + id, getURL: () => `https://t${id}.test/`, isDestroyed: () => false } });
const makeBrowser = (state) => ({
  activeTab: () => tabOf(state.active),
  tabById: (id) => (state.open.has(id) ? tabOf(id) : null),
  listTabs: () => [...state.open].map((id) => ({ id, title: `t${id}`, url: `https://t${id}.test/`, active: id === state.active })),
  effectiveModel: (m) => m, aiOff: () => false, noTabReason: () => 'No tab open.', maxSteps: () => 0,
  autoApprove: () => true,
  handsOff: () => state.handsOff === true,
  isAiTab: (id) => state.ai.has(id),
  typingText: () => 'Waiting while you type…',
});
const newAgent = (state) => {
  const agent = new Agent(makeBrowser(state), () => null, () => ({ model: 'claude-opus-5' }));
  agent.closeSignedInTabs = () => {};
  agent.newActionLog = () => ({});
  agent.undoSummary = () => null;
  return agent;
};
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

(async () => {
  {
    const state = { active: 1, open: new Set([1, 2]), ai: new Set([2]), handsOff: true };
    const agent = newAgent(state);
    const signal = new AbortController().signal;
    const chat = () => { const m = []; m.settings = { model: 'claude-opus-5' }; return m; };
    const inTab = (id, fn) => agent.inTask(id, signal, fn, chat());
    const ask = (name, input = {}) => agent.ensureAllowed(name, () => {}, signal, { input });

    for (const [name, input] of [['click', { element_id: 1 }], ['type_text', { element_id: 1, text: 'x' }], ['press_key', { key: 'Enter' }], ['scroll', { direction: 'down' }], ['navigate', { url: 'https://example.com' }], ['run_script', { code: '1' }], ['go_back', {}], ['reload', {}], ['hover', { element_id: 1 }], ['click_at', { x: 1, y: 1 }], ['fill_form', { fields: [] }]]) {
      const msg = await refused(() => inTab(1, () => ask(name, input)));
      check(`tool layer: ${name} on the user's tab is refused before any card (ensureAllowed)`, /Hands-off mode is on/.test(msg || ''), msg);
    }
    check('tool layer: execute refuses it too (a batch step or a direct call never skips the check)', /Hands-off mode is on/.test(await refused(() => inTab(1, () => agent.execute('click', { element_id: 1 }))) || ''));
    check('tool layer: close_tab of the user\'s tab is refused', /Hands-off mode is on/.test(await refused(() => inTab(1, () => ask('close_tab', { tab_id: 1 }))) || ''));
    check('tool layer: close_tab of a tab the AI opened is not', (await refused(() => inTab(1, () => ask('close_tab', { tab_id: 2 })))) === null);
    check('tool layer: reading the user\'s tab still works', (await refused(() => inTab(1, () => ask('read_page')))) === null && (await refused(() => inTab(1, () => ask('find', { text: 'x' })))) === null);
    check('tool layer: acting in a tab the AI opened is allowed', (await refused(() => inTab(2, () => ask('click', { element_id: 1 })))) === null && (await refused(() => inTab(2, () => ask('type_text', { element_id: 1, text: 'x' })))) === null);
    state.handsOff = false;
    check('tool layer: with the setting off (the default) the user\'s tab is acted on as before', (await refused(() => inTab(1, () => ask('click', { element_id: 1 })))) === null);
    state.handsOff = true;
    state.ai.add(1); // the user's tab was handed to the AI by... no: a tab the AI opened stays the AI's until the user takes it
    check('tool layer: a tab marked as the AI\'s is acted on', (await refused(() => inTab(1, () => ask('click', { element_id: 1 })))) === null);
    state.ai.delete(1); // the user clicked in it: handOver
    check('tool layer: once the user takes the tab, the AI is refused again', /Hands-off mode is on/.test(await refused(() => inTab(1, () => ask('click', { element_id: 1 }))) || ''));
  }

  // The system prompt names the mode, so the model plans around it
  {
    const { systemFor } = require('../src/ai/agent');
    if (typeof systemFor === 'function') {
      check('prompt: hands-off adds a line to the system prompt', /Hands-off mode is on/.test(systemFor({ handsOff: true, model: 'claude-opus-5' })) && !/Hands-off mode is on/.test(systemFor({ model: 'claude-opus-5' })));
    } else {
      const src = fs.readFileSync(path.join(__dirname, '../src/ai/agent.js'), 'utf8');
      check('prompt: hands-off adds a line to the system prompt', /settings\.handsOff \?/.test(src) && /manners\.HANDS_OFF_PROMPT/.test(src));
    }
  }

  // ---- the user's focus
  {
    const wc = {};
    check('input: a key the AI sends is the AI\'s, not the user typing', M.agentInput(wc, () => { M.userInput.key(wc, 5000); return M.isAgentInput(wc); }) === true && M.userInput.typedAt(wc) === 0 && M.userInput.inputAt(wc) === 0);
    check('input: ...and the flag is gone after, even when sending throws', (() => { try { M.agentInput(wc, () => { throw new Error('x'); }); } catch {} return !M.isAgentInput(wc); })());
    M.userInput.key(wc, 5000);
    check('input: a key of the user\'s is remembered (typing and activity)', M.userInput.typedAt(wc) === 5000 && M.userInput.inputAt(wc) === 5000);
    M.userInput.click(wc, 6000);
    check('input: a click is activity but not typing', M.userInput.typedAt(wc) === 5000 && M.userInput.inputAt(wc) === 6000);
    check('typing wait: the AI waits ~1.5 s after the user\'s last key, then not', M.typingWait({ typedAt: 10000, now: 10200 }) === 1300 && M.typingWait({ typedAt: 10000, now: 11500 }) === 0 && M.typingWait({ typedAt: 0, now: 5 }) === 0);
    check('focus guard: when the page has the keyboard, or the user was active in it a moment ago', M.guardsFocus({ pageFocused: true }) && M.guardsFocus({ userInputAt: 1000, now: 5000 }) && !M.guardsFocus({ userInputAt: 1000, now: 1000 + M.FOCUS_RECENT_MS + 1 }) && !M.guardsFocus({}));
    check('show: a new or switched-to tab never comes to the front by itself', !M.showsTab({}) && !M.showsTab({ show: true }) && !M.showsTab({ show: true, runTabId: 3, activeId: 4 }) && M.showsTab({ show: true, runTabId: 3, activeId: 3 }));

    // the agent waits while the user types (and says so once), and does not wait when they are not
    const state = { active: 1, open: new Set([1]), ai: new Set(), handsOff: false };
    const agent = newAgent(state);
    const events = [];
    const w = { isDestroyed: () => false };
    M.userInput.key(w, Date.now() - 1300); // 200 ms left
    const started = Date.now();
    await agent.inTask(null, new AbortController().signal, async () => {
      agent.taskScopeForTest = true;
      await agent.waitForUserTyping(w);
    });
    const waited = Date.now() - started;
    check('agent: typing waits for a pause in the user\'s typing', waited >= 150 && waited < 1200, `${waited} ms`);
    const idle = Date.now();
    await agent.waitForUserTyping({ isDestroyed: () => false });
    check('agent: no wait when the user has not typed there', Date.now() - idle < 100);
    void events;

    // the user's caret is saved before a tool acts in the page and put back after, only when it matters
    const ran = [];
    const page = (focused) => ({ isFocused: () => focused, isDestroyed: () => false, executeJavaScriptInIsolatedWorld: async (_w, [{ code }]) => { ran.push(/__lumenKept = keep/.test(code) ? 'save' : /__lumenKept = null;\s*if \(!keep/.test(code) ? 'restore' : 'other'); return true; } });
    await agent.keepUserFocus(page(true), async () => { ran.push('act'); });
    check('focus: with the user in the page: saved, the tool acts, then restored', J(ran) === '["save","act","restore"]', J(ran));
    ran.length = 0;
    await agent.keepUserFocus(page(false), async () => { ran.push('act'); });
    check('focus: with the user elsewhere (no activity in this page): the page is left alone', J(ran) === '["act"]', J(ran));
    ran.length = 0;
    const active = page(false);
    M.userInput.click(active, Date.now());
    let threw = null;
    try { await agent.keepUserFocus(active, async () => { ran.push('act'); throw new Error('boom'); }); } catch (e) { threw = e.message; }
    check('focus: the caret is restored even when the tool fails, and the failure still shows', J(ran) === '["save","act","restore"]' && threw === 'boom', J(ran));
  }

  // The scripts that keep and restore the caret: shape (they run in the page; test/aimanners.js runs them for real)
  {
    const save = scripts.focusSave();
    const restore = scripts.focusRestore(3);
    check('scripts: the caret script keeps the field, selection and contenteditable range, and nothing when the user is in no field', /selectionStart/.test(save) && /getRangeAt/.test(save) && /__lumenKept = null; return false/.test(save));
    check('scripts: restoring does not move the page\'s focus when it is already there, never scrolls, and leaves the field the tool typed in', /preventScroll: true/.test(restore) && /activeElement !== el/.test(restore) && /target\.el === el/.test(restore));
    check('scripts: a click by position in a background tab sends the page its pointer and mouse events', /elementFromPoint/.test(scripts.domClickAt(5, 6)) && /pointerdown/.test(scripts.domClickAt(5, 6)));
  }

  // ---- the agent path never takes the OS focus
  {
    const src = fs.readFileSync(path.join(__dirname, '../src/ai/agent.js'), 'utf8');
    check('focus: agent.js never focuses a window or a page view', !/\.focus\(\)/.test(src.replace(/\/\/.*$/gm, '').replace(/el\.focus\([^)]*\)/g, '')) && !/win\.focus|BrowserWindow/.test(src));
    const open = /case 'open_tab': \{[\s\S]*?case 'switch_tab'/.exec(src)?.[0] || '';
    check('open_tab: opens the tab as the AI\'s (marked) and in the background unless show:true', /openTab\(webUrl\(input\.url\), \{ ai: true, show: input\.show === true \}\)/.test(open));
    check('switch_tab: stays behind unless show:true', /switchTab\(input\.tab_id, \{ show: input\.show === true \}\)/.test(src));
    const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
    const agentTab = /const agentOpenTab = [\s\S]*?const noTabReason/.exec(main)?.[0] || '';
    check('main: the agent\'s open_tab / switch_tab never call focus()', agentTab.length > 100 && !/\.focus\(\)/.test(agentTab.replace(/\/\/.*$/gm, '')), agentTab.length);
  }

  // ---- the sidebar toggle that hides the tabs the AI opened
  {
    const app = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
    const fn = /function aiHiddenTab\(tab, state\) \{[\s\S]*?\n\}/.exec(app)?.[0];
    check('hide toggle: app.js has the rule', Boolean(fn));
    const ctx = { window: { lumenHideAiTabs: true }, drag: null };
    vm.createContext(ctx);
    vm.runInContext(`${fn}; this.hidden = aiHiddenTab;`, ctx);
    const state = { activeId: 5 };
    check('hide toggle: on: a tab the AI opened is left out', ctx.hidden({ id: 1, aiOpened: true }, state) === true);
    check('hide toggle: on: the user\'s own tabs stay', ctx.hidden({ id: 2, aiOpened: false }, state) === false && ctx.hidden({ id: 2 }, state) === false);
    check('hide toggle: on: the tab in front stays shown, even if the AI opened it', ctx.hidden({ id: 5, aiOpened: true }, state) === false);
    ctx.drag = { id: 1 };
    check('hide toggle: a tab being dragged stays shown', ctx.hidden({ id: 1, aiOpened: true }, state) === false);
    ctx.drag = { id: 9, group: [1, 9] };
    check('hide toggle: a tab in a dragged group stays shown', ctx.hidden({ id: 1, aiOpened: true }, state) === false);
    ctx.drag = null;
    ctx.window.lumenHideAiTabs = false;
    check('hide toggle: off: every tab is shown again (and keeps its AI mark)', ctx.hidden({ id: 1, aiOpened: true }, state) === false);
    check('hide toggle: part of the strip\'s layout signature, so a toggle redraws it', /\$\{aiHiddenTab\(x, state\) \? 1 : 0\}/.test(app));
    check('hide toggle: a group left with no visible tab shows no label', /!aiHiddenTab\(t, state\)/.test(app) && /if \(aiHiddenTab\(tab, state\)\) continue;/.test(app));

    const backend = fs.readFileSync(path.join(__dirname, '../src/settings/settings-backend.js'), 'utf8');
    check('hide toggle: it is a saved setting (off by default) and reaches the strip through prefs:ui', /hideAiTabs: false/.test(backend) && /hideAiTabs: p\.hideAiTabs === true/.test(backend) && /'aiHandsOff', 'hideAiTabs'\]\.includes\(key\)/.test(backend));
    const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.src.html'), 'utf8');
    const button = /<button[^>]*id="hide-ai-tabs"[^>]*>/.exec(html)?.[0] || '';
    check('hide toggle: a real button with aria-pressed and a label, in the sidebar', /aria-pressed="false"/.test(button) && /aria-label=/.test(button) && /type="button"/.test(button) && html.indexOf('id="hide-ai-tabs"') > html.indexOf('id="sidebar"'));
    const en = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/locales/en.json'), 'utf8'));
    check('hide toggle: its labels say the count, singular and plural', ['off', 'on'].every((k) => en[`sidebar.hideAiTabs.${k}.one`]?.includes('{count}') && en[`sidebar.hideAiTabs.${k}.other`]?.includes('{count}')));
    const mainSrc = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
    check('hide toggle: it is separate from the close setting (its own channel and key)', /ipcMain\.handle\('tabs:hide-ai'/.test(mainSrc) && !/hideAiTabs/.test(/function aiTabsAfterRun[\s\S]*?\n\}/.exec(mainSrc)?.[0] || ''));
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
