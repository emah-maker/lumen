// An outside agent (MCP) never touches the user's window, tabs, focus or clipboard. Plain Node, fakes only:
// features/agent-hands-off.js, the tool layer's refusals and private clipboard (ai/agent.js), and source guards that the agent window's
// code path never focuses, raises or activates anything of the user's.
require('./_tmp-cleanup');
const fs = require('fs');
const path = require('path');
const H = require('../src/features/agent-hands-off');
const { Agent } = require('../src/ai/agent');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

(async () => {
  // ---- which window a call runs in
  {
    const user = { name: 'user' };
    const agentWin = { name: 'agent' };
    const live = new Set([user, agentWin]);
    const alive = (r) => live.has(r);
    let r = H.resolveRun({ scope: { mcp: true, rec: agentWin }, chatRec: user, alive });
    check('an outside agent runs in its own window, never the open chat\'s', r.rec === agentWin && !r.gone);
    live.delete(agentWin);
    r = H.resolveRun({ scope: { mcp: true, rec: agentWin }, chatRec: user, alive });
    check('its window closed mid-call: nothing runs, and it does not fall back to the user\'s window', r.rec === null && r.gone === true, JSON.stringify(r));
    r = H.resolveRun({ scope: { mcp: true, rec: null }, chatRec: user, alive });
    check('no window at all is also "gone", not the user\'s', r.gone === true && r.rec === null);
    r = H.resolveRun({ scope: { chat: 'c1' }, chatRec: user, alive });
    check('the sidebar\'s own run still uses its chat\'s window', r.rec === user && !r.gone);
  }

  // ---- focus never moves inside an agent window the user is not in
  {
    const win = (focused) => ({ isDestroyed: () => false, isFocused: () => focused });
    check('agent window, user elsewhere: no focus', H.mayFocus({ agent: { label: 'x' }, win: win(false) }) === false);
    check('agent window the user is in: focus allowed', H.mayFocus({ agent: { label: 'x' }, win: win(true) }) === true);
    check('an ordinary window is unaffected', H.mayFocus({ agent: null, win: win(false) }) === true);
  }

  // ---- foreign tab ids and the refusal text
  {
    const bad = H.foreignTabIds([1, 2, 9, 9, 99], [1, 2], (id) => id === 9);
    check('only ids that exist outside the agent window are foreign (unknown ids stay "no tab")', JSON.stringify(bad) === '[9]', JSON.stringify(bad));
    const text = H.foreignTabText([9, 10]);
    check('the refusal names the tabs and says what to do instead', /Tabs 9, 10 are ones? /.test(text) && /user's own tabs/.test(text) && /open_tab/.test(text), text);
  }

  // ---- the tool layer, as an outside agent (scope.mcp) with a window of its own and the user's tabs elsewhere
  {
    const state = { sys: 'user copied this', calls: [] };
    const systemClipboard = { readText: () => state.sys, writeText: (t) => { state.sys = t; state.calls.push(['sysWrite', t]); } };
    const own = [{ id: 5, title: 'agent', url: 'https://a.test/', active: true }];
    const userTabs = new Set([1, 2]);
    const rec = (n) => { state.calls.push([n]); return true; };
    const wc = { id: 50, isDestroyed: () => false, getTitle: () => 'agent', getURL: () => 'https://a.test/' };
    const browser = {
      activeTab: () => ({ id: 5, webContents: wc }),
      tabById: (id) => (id === 5 ? { id, webContents: wc } : null),
      listTabs: () => own, tabExistsElsewhere: (id) => userTabs.has(id),
      switchTab: () => rec('switchTab'), closeTab: () => rec('closeTab'), requestCloseTab: () => rec('closeTab'),
      groupTabs: () => { rec('groupTabs'); return { group: 'g', tabs: [] }; }, ungroupTabs: () => { rec('ungroupTabs'); return 0; },
      askTabs: () => own.map((t) => ({ ...t, sleeping: false, offLimits: false, webContents: null })),
      effectiveModel: (m) => m, aiOff: () => false, noTabReason: () => 'none', maxSteps: () => 0, autoApprove: () => false, bypassPermissions: () => false,
      handsOff: () => false, isAiTab: () => false, tabOff: () => false, typingText: () => '', deviceAccess: () => true, profileDir: () => '', clipboard: systemClipboard,
    };
    const agent = new Agent(browser, () => null, () => ({ model: 'claude-opus-5' }));
    agent.closeSignedInTabs = () => {};
    agent.taskTabInFront = () => true;
    const signal = new AbortController().signal;
    const priv = H.privateClipboard();
    const asAgent = (name, input, clipboard = priv) => agent.inTask(5, signal, () => agent.execute(name, input), null, null, { mcp: true, rec: {}, clipboard });
    const asUser = (name, input) => agent.inTask(5, signal, () => agent.execute(name, input), null, null, { chatId: 'a1b2c3d4e5f60718', hosts: new Set() });

    for (const [tool, input] of [['switch_tab', { tab_id: 1 }], ['close_tab', { tab_id: 2 }], ['group_tabs', { name: 'x', tab_ids: [1, 5] }], ['ungroup_tabs', { tab_ids: [2] }]]) {
      state.calls.length = 0;
      const msg = await refused(() => asAgent(tool, input));
      check(`${tool} on a user tab is refused with a clear message and nothing happens`, /user's own tabs/.test(msg || '') && state.calls.length === 0, `${msg} ${JSON.stringify(state.calls)}`);
    }
    state.calls.length = 0;
    const gone = await refused(() => asAgent('switch_tab', { tab_id: 77 }));
    check('an id that exists nowhere keeps the plain "No tab" answer', /No tab with id 77/.test(gone || ''), gone);
    const sidebar = await refused(() => asUser('switch_tab', { tab_id: 1 }));
    check('the sidebar\'s own run is not held to the agent rule', !/user's own tabs/.test(sidebar || ''), sidebar);
    state.calls.length = 0;
    const read = await asAgent('read_tabs', { ids: [1] });
    check('read_tabs names a user tab as off limits and reads nothing', /user's tabs/.test(read) && state.calls.length === 0, read);

    // clipboard
    state.calls.length = 0;
    await asAgent('clipboard', { action: 'write', text: 'agent text' });
    check('the agent\'s clipboard write never touches the system clipboard', state.sys === 'user copied this' && state.calls.length === 0, state.sys);
    const back = await asAgent('clipboard', { action: 'read' });
    check('it reads back its own buffer, not the user\'s', /agent text/.test(back) && !/user copied/.test(back), back);
    const empty = await asAgent('clipboard', { action: 'read' }, H.privateClipboard());
    check('with nothing written it does not fall through to the user\'s clipboard (device access on)', !/user copied/.test(empty), empty);
    await asUser('clipboard', { action: 'write', text: 'sidebar' });
    check('the sidebar AI keeps the system clipboard as before', state.sys === 'sidebar');
  }

  // ---- source guards: the agent window's path never focuses, raises or activates
  {
    const main = src('src/main.js').replace(/\r\n/g, '\n');
    const bad = /\.focus\(|\.show\(\)|app\.focus|setAlwaysOnTop/;
    const fnBody = (name) => { const i = main.indexOf(`function ${name}(`); const j = main.indexOf('\n}\n', i); return main.slice(i, j); };
    for (const name of ['openAgentWindow', 'keepAgentWindow']) check(`${name} never focuses or shows the window`, !bad.test(fnBody(name)), fnBody(name).match(bad)?.[0]);
    const showBehind = fnBody('showBehind');
    check('showBehind uses showInactive, no focus(), never always-on-top', /showInactive\(\)/.test(showBehind) && !bad.test(showBehind));
    check('the agent window is created with show:false and shown behind', /\|\| hidden \|\| agentOf \? \{ show: false \}/.test(main) && /else if \(agentOf\) showBehind\(w\)/.test(main));
    check('an outside agent\'s call whose window is gone throws instead of running in the user\'s', /scope\?\.mcp && !\(scope\.rec && winRecs\.has\(scope\.rec\)/.test(main));
    check('keyboard focus helpers skip agent windows the user is not in', (main.match(/handsOff\.mayFocus\(/g) || []).length >= 2);
    check('downloads from an agent window are cancelled', /blocked: \(contents\) => Boolean\(contents && agentContents\.has\(contents\)\)/.test(main) && /deps\.blocked\?\.\(contents\)/.test(src('src/features/downloads.js')));
    const mcp = src('src/features/ai-agents.js');
    check('the agent session carries its private clipboard on its scope', /clipboard: \(session\.clipboard \|\|= /.test(mcp));
    check('the MCP path calls no focus, raise or always-on-top', !/app\.focus|moveTop|setAlwaysOnTop|\.focus\(\)/.test(mcp) && !/focus|moveTop|raise/.test(src('src/features/agent-windows.js').replace(/\/\/.*$/gm, '')));
    check('the MCP path never sets aiLock', !/aiLock/.test(mcp));
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
