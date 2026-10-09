// Plain Node: agents other than the chat the user is typing into stay out of the user's window (features/agents-quiet.js, wired in
// features/ai-agents.js, ai/agent.js, features/background-runner.js). Fakes for windows and tabs; no Electron.
const fs = require('fs');
const os = require('os');
const path = require('path');
const quiet = require('../src/features/agents-quiet');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const J = (v) => JSON.stringify(v);

// ---- routing and the pending counter (pure)
function pure() {
  const hw = { hasWindow: true };
  check('route: an outside agent\'s steps go to its own window', ['tool', 'tool_update', 'tool_done'].every((type) => quiet.routeMcpEvent({ type }, hw) === 'agent'));
  check('route: its "connected" notice goes to its window, never the user\'s', quiet.routeMcpEvent({ type: 'session', active: true, engine: null }, hw) === 'agent');
  check('route: its approval cards go to its window and the passive count', quiet.routeMcpEvent({ type: 'approval' }, hw) === 'pending' && quiet.routeMcpEvent({ type: 'approval_done' }, hw) === 'pending');
  check('route: the sidebar engine\'s own sessions are not routed here', quiet.routeMcpEvent({ type: 'tool', engine: 'abc' }, hw) === 'none');
  check('route: with no agent windows (tests share the user\'s) events stay as before', quiet.routeMcpEvent({ type: 'tool' }, { hasWindow: false }) === 'user');
  const p = quiet.createPendingApprovals();
  const rec = {};
  p.add(1, { key: rec }); p.add(2, { key: rec });
  check('pending: counts waiting cards, and the badge goes to the window that holds them', p.count() === 2 && p.keyOf() === rec);
  p.remove(1);
  check('pending: an answered card leaves the count', p.count() === 1 && J(p.ids()) === '[2]');
  p.dropKey(rec);
  check('pending: a window that went away takes its cards with it', p.count() === 0);
  check('toast: a background task\'s notice never asks for an in-window toast', quiet.taskToastPlan({ toast: true, os: true }).toast === false && quiet.taskToastPlan({ toast: true, os: true }).os === true);
  check('helpers: their live events produce nothing for the chat', quiet.helperUiEvent({ type: 'step' }) === null);
  check('nav: a fresh non-active tab unless the request is about the current page', quiet.navTarget({}) === 'new' && quiet.navTarget({ ownTabAlive: true }) === 'own' && quiet.navTarget({ aboutPage: true }) === 'current' && quiet.navTarget({ onAiTab: true }) === 'current' && quiet.navTarget({ outside: true }) === 'current');
}

// ---- an outside agent over MCP: nothing reaches the user's webContents
async function mcpAgent() {
  const mcp = require('../src/automation/mcp');
  const { setupAiAgents } = require('../src/features/ai-agents');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-quiet-'));
  let callTool = null;
  let onEvent = null;
  const realStart = mcp.startServer;
  mcp.startServer = (o) => { callTool = o.callTool; onEvent = o.onEvent; return { disconnectAll() {}, close() {} }; };
  const userSent = []; // everything sent to the user's window
  const agentSent = [];
  const rec = { win: { webContents: { isDestroyed: () => false, send: (ch, ev) => agentSent.push([ch, ev]) } } };
  const fakeAgent = {
    approvedHosts: new Set(),
    browser: { activeTab: () => null },
    engineScope: () => null,
    inScope: (_s, fn) => fn(),
    inTask: (_id, _signal, fn) => fn(),
    describeStep: async () => 'Opening example.com',
    ensureAllowed: async (_name, emit) => { emit({ type: 'approval', approvalId: 'a1', host: 'example.com' }); emit({ type: 'approval_done', approvalId: 'a1', ok: true }); emit({ type: 'approval', approvalId: 'a2', host: 'x.test' }); },
    execute: async () => 'ok',
  };
  const handlers = {};
  setupAiAgents({
    app: { getPath: () => tmp, on() {} },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, on: (ch, fn) => { handlers[ch] = fn; } },
    agent: fakeAgent,
    tools: [],
    validateToolInput: () => null,
    readSettings: () => ({ mcpEnabled: true }),
    writeSettings: () => {},
    ui: () => ({ send: (ch, ev) => userSent.push([ch, ev]) }),
    agentWindows: { windows: { get: () => rec, ensure: async () => rec, activeTabId: () => 7 }, activeTabId: () => 7 },
  });
  try { await handlers['mcp:set-enabled']({}, true); } finally { mcp.startServer = realStart; }
  const session = { clientName: 'Codex', controller: new AbortController(), approvedHosts: new Set() };
  onEvent({ type: 'session', active: true, clientName: 'Codex', engine: null });
  await callTool('navigate', { url: 'https://example.com' }, session);
  const toUser = userSent.filter(([ch]) => ch === 'mcp:event');
  check('mcp: no mcp:event of any kind (steps, connected notice, approval card) reaches the user\'s window', toUser.length === 0, J(toUser));
  check('mcp: its steps and its approval card went to its own window', agentSent.some(([, e]) => e.type === 'tool') && agentSent.some(([, e]) => e.type === 'approval' && e.approvalId === 'a1'), J(agentSent.map(([, e]) => e.type)));
  const counts = userSent.filter(([ch]) => ch === 'agents:pending').map(([, e]) => e.count);
  check('mcp: the user\'s window only gets the passive pending count (1, 0, 1, then 0 when the call ends)', J(counts) === '[1,0,1,0]', J(counts));
  check('mcp: nothing else is sent to the user\'s window', userSent.every(([ch]) => ch === 'agents:pending'), J(userSent.map(([ch]) => ch)));
}

// ---- a delegate helper: no tabs in the user's window, no rows in the chat
async function helpers() {
  const { Agent } = require('../src/ai/agent');
  const opened = [];
  const tab = { id: 1, webContents: { id: 101, getURL: () => 'https://t.test/', isDestroyed: () => false } };
  const browser = { activeTab: () => tab, tabById: () => tab, listTabs: () => [], effectiveModel: (m) => m, aiOff: () => false, noTabReason: () => '', maxSteps: () => 0, autoApprove: () => false, research: { begin: () => { opened.push('research tab'); return () => {}; }, finish() {} }, openTab: () => { opened.push('open'); return tab; } };
  const agent = new Agent(browser, () => null, () => ({ model: 'claude-opus-5-5' }));
  agent.closeSignedInTabs = () => {};
  const chat = []; chat.settings = { model: 'claude-opus-5-5' };
  agent.helperCall = async (model, { messages }) => (messages.length === 1
    ? { content: [{ type: 'tool_use', id: 'u1', name: 'read_urls', input: { urls: ['https://a.test/x'] } }], stop_reason: 'tool_use', model, usage: { input_tokens: 1, output_tokens: 1 } }
    : { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', model, usage: { input_tokens: 1, output_tokens: 1 } });
  let ended = null;
  agent.execute = async () => { ended = agent.showResearch('x'); return 'page'; };
  const signal = new AbortController().signal;
  const events = [];
  await agent.inTask(1, signal, async () => {
    await agent.ensureAllowed('delegate', (e) => events.push(e), signal, { input: {} });
    return agent.delegate({ tasks: [{ task: 'look it up' }] });
  }, chat);
  check('helpers: a helper\'s read opens no research tab in the user\'s window', opened.length === 0 && typeof ended === 'function', J(opened));
  check('helpers: the chat that started them gets no helper rows or steps', !events.some((e) => e.name === 'helper' || /^helper-/.test(e.id || '')), J(events.map((e) => e.type)));
}

// ---- the sidebar chat: navigate goes to a tab of its own, unless the request is about the current page
async function chatNavigation() {
  const { Agent } = require('../src/ai/agent');
  const mk = () => {
    const tabs = new Map();
    const user = { id: 1, webContents: { id: 101, getURL: () => 'https://mine.test/', isDestroyed: () => false } };
    tabs.set(1, user);
    const loaded = [];
    const aiTabs = new Set();
    let next = 2;
    const browser = {
      activeTab: () => user, tabById: (id) => tabs.get(id) || null, listTabs: () => [], effectiveModel: (m) => m, aiOff: () => false, noTabReason: () => '', maxSteps: () => 0, autoApprove: () => false,
      isAiTab: (id) => aiTabs.has(id),
      openTab: (url, opts) => { const id = next++; const t = { id, webContents: { id: 100 + id, getURL: () => 'about:blank', isDestroyed: () => false } }; tabs.set(id, t); if (opts?.ai) aiTabs.add(id); loaded.push(['open', id, opts]); return t; },
    };
    return { browser, loaded };
  };
  const chatOf = () => { const m = []; m.settings = { model: 'claude-opus-5-5' }; return m; };
  const run = (agent, chat, aboutPage, fn) => agent.inTask(1, new AbortController().signal, fn, chat, null, { aboutPage });
  {
    const { browser, loaded } = mk();
    const agent = new Agent(browser, () => null, () => ({}));
    const chat = chatOf();
    const picked = [];
    await run(agent, chat, false, async () => { await agent.ownNavigationTab(); picked.push(agent.taskTab().id); await agent.ownNavigationTab(); picked.push(agent.taskTab().id); });
    check('chat: a navigate not about the current page opens one fresh non-active AI tab and works there', picked[0] === 2 && picked[1] === 2 && loaded.length === 1 && loaded[0][2].ai === true && loaded[0][2].show === false, J([picked, loaded]));
    const again = [];
    await run(agent, chat, false, async () => { await agent.ownNavigationTab(); again.push(agent.taskTab().id); });
    check('chat: a later message of the same chat reuses that tab', again[0] === 2 && loaded.length === 1, J([again, loaded]));
  }
  {
    const { browser, loaded } = mk();
    const agent = new Agent(browser, () => null, () => ({}));
    const used = [];
    await run(agent, chatOf(), true, async () => { await agent.ownNavigationTab(); used.push(agent.taskTab().id); });
    check('chat: when the request is about the current page the current tab is used and nothing is opened', used[0] === 1 && loaded.length === 0, J([used, loaded]));
    check('chat: "what is this error" and "summarize this page" are about the current page; "find flights to Rome" is not', agent.aboutCurrentPage('what is this error?') === true && agent.aboutCurrentPage('summarize this page') === true && agent.aboutCurrentPage('find flights to Rome') === false);
  }
  {
    const { browser, loaded } = mk();
    const agent = new Agent(browser, () => null, () => ({}));
    const used = [];
    await agent.inTask(1, new AbortController().signal, async () => { await agent.ownNavigationTab(); used.push(agent.taskTab().id); }, null, null, { mcp: true });
    check('outside scopes (no chat) are never moved by the chat rule', used[0] === 1 && loaded.length === 0, J([used, loaded]));
  }
}

// ---- background tasks: nothing but the passive state goes to the user's window
function tasks() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'features', 'background-runner.js'), 'utf8');
  const sent = [...src.matchAll(/ui\(\)\?\.send\('([^']+)'/g)].map((m) => m[1]);
  check('tasks: the runner sends no in-window toast', !sent.includes('tasks:toast'), J(sent));
  check('tasks: what it sends to the user\'s window is the passive state, a notification click\'s open, and the user\'s own proposals', sent.every((c) => ['tasks:state', 'tasks:open', 'tasks:propose'].includes(c)), J(sent));
  check('tasks: its work tab is never attached to a window', /never attached to a window/.test(src));
}

(async () => {
  pure();
  await mcpAgent();
  await helpers();
  await chatNavigation();
  tasks();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
