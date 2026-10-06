// Shared set-up for the chat acceptance suites (test/acceptance/chat-*.js): the real Agent (ai/agent.js), the real
// features/ai-agents.js wiring (its MCP tool entry, mcpCallTool) and the real Claude Code / Grok Build engines, with
// the CLIs replaced by test/acceptance/fake-chat-cli.js. Plain Node: no Electron, no network, no login.
//
// How the fakes go in (no hook in src/ is needed):
//  - child_process.spawn is wrapped BEFORE any engine module loads, so every engine instance (the sidebar's, or any
//    per-chat / per-run one a later design makes) that spawns the fake binary runs fake-chat-cli.js under Node.
//  - LUMEN_CLAUDE_BIN / LUMEN_GROK_BIN name the fake script (findClaude / findGrok honour them), GROK_HOME a temp folder.
//    LUMEN_AGY_BIN names a stand-in file (FAKE_AGY) that the spawn hook runs as the same script in its agy role.
//  - Lumen's local HTTP MCP server (automation/mcp-http.js startHttp) is replaced by a recording fake gate: it hands
//    out one token per run (the token IS the run's tag), records open / close, and keeps the `callTool` it was given,
//    which the tests call the way a CLI's MCP request would arrive (session.engine = the run's tag).
require('../_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE = path.join(__dirname, 'fake-chat-cli.js');
const realSpawn = cp.spawn;
const live = new Map(); // pid -> child, for fake CLI processes still running
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-chat-accept-'));
const LOG = path.join(tmp, 'cli-log.jsonl');
fs.writeFileSync(LOG, '');
const FAKE_AGY = path.join(tmp, process.platform === 'win32' ? 'agy-fake.exe' : 'agy-fake'); // (only its path matters)
fs.writeFileSync(FAKE_AGY, '');
const FAKE_CODEX = path.join(tmp, process.platform === 'win32' ? 'codex-fake.exe' : 'codex-fake'); // (only its path matters)
fs.writeFileSync(FAKE_CODEX, '');

cp.spawn = function spawnHook(bin, argv, opts = {}) {
  if (bin !== FAKE && bin !== FAKE_AGY && bin !== FAKE_CODEX) return realSpawn.apply(this, arguments);
  const role = bin === FAKE_AGY ? { FAKE_ROLE: 'agy' } : bin === FAKE_CODEX ? { FAKE_ROLE: 'codex' } : {};
  const child = realSpawn(process.execPath, [FAKE, ...(argv || [])], { ...opts, env: { ...(opts.env || {}), ...role, ELECTRON_RUN_AS_NODE: '1', FAKE_CHAT_LOG: LOG } });
  live.set(child.pid, child);
  child.on('exit', () => live.delete(child.pid));
  return child;
};
process.env.LUMEN_CLAUDE_BIN = FAKE;
process.env.LUMEN_GROK_BIN = FAKE;
process.env.GROK_HOME = path.join(tmp, 'user-grok');
process.env.LUMEN_GROK_SIDEBAR = '1';
process.env.LUMEN_AGY_BIN = FAKE_AGY;
process.env.LUMEN_AGY_SIDEBAR = '1';
process.env.LUMEN_CODEX_SIDEBAR = '1';
process.env.LUMEN_CODEX_WARM = '0'; // (the kept `codex app-server` is covered by test/codex-warm-units.js; these runs are headless `codex exec`)
fs.mkdirSync(process.env.GROK_HOME, { recursive: true });

// ---- the fake HTTP gate (mcp-http.js startHttp's shape: open/close/armed/listed/port/stop)
const gate = { opened: new Map(), closed: new Set(), callTool: null };
gate.openNow = () => [...gate.opened.keys()].filter((t) => !gate.closed.has(t));
const mcpHttp = require('../../src/automation/mcp-http');
mcpHttp.startHttp = ({ callTool }) => {
  gate.callTool = callTool;
  return Promise.resolve({
    port: 1,
    open(tag, chatSessionId = null) { gate.opened.set(tag, { at: Date.now(), chatSessionId }); return { mcpUrl: `http://127.0.0.1:1/mcp/${tag.slice(0, 6)}`, mcpToken: tag, hookUrl: 'http://127.0.0.1:1/hook' }; },
    close(tag) { gate.closed.add(tag); },
    armed: () => true,
    listed: () => true,
    allowed: () => [],
    denied: () => [],
    stop() {},
  });
};
const mcp = require('../../src/automation/mcp');
mcp.startServer = (o) => { gate.callTool ||= o.callTool; gate.mcpOpts = o; return { disconnectAll() {}, close() {} }; }; // (gate.mcpOpts: what the stdio server was given, for suites that open sessions the way it does)

const { Agent, EXTERNAL_TOOLS } = require('../../src/ai/agent');
const { setupAiAgents } = require('../../src/features/ai-agents');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000, step = 40) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step);
  }
}
const readLog = () => fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const msgOf = (marker) => readLog().find((e) => e.ev === 'msg' && e.marker === marker) || null;
const release = (name) => fs.writeFileSync(path.join(tmp, `release-${name}`), '');

// ---- the Agent, with a fake browser of four tabs
const tabOf = (id) => ({ id, webContents: { id: 100 + id, getTitle: () => `t${id}`, getURL: () => `https://t${id}.test/`, isDestroyed: () => false } });
const state = { active: 1, open: new Set([1, 2, 3, 4]) };
const browser = {
  activeTab: () => (state.active == null ? null : tabOf(state.active)),
  tabById: (id) => (state.open.has(id) ? tabOf(id) : null),
  listTabs: () => [...state.open].map((id) => ({ id, title: `t${id}`, url: `https://t${id}.test/`, active: id === state.active })),
  effectiveModel: (m) => m, aiOff: () => false, noTabReason: () => 'No tab open.', maxSteps: () => 0,
  autoModel: () => false, claudeCodeFullAccess: () => false, grokBuildFullAccess: () => false,
};
const agent = new Agent(browser, () => null, () => ({ model: 'claudecode:default', adhdMode: true, pageContext: false }));
agent.closeSignedInTabs = () => {};
agent.newActionLog = () => ({});
agent.undoSummary = () => null;
agent.ensureAllowed = async () => {};
agent.describeStep = async () => null;
const executed = []; // { name, tab } for every tool call Lumen ran, with the tab it acted on
agent.execute = async function execute(name) {
  let tab = null;
  try { tab = this.taskTab()?.id ?? null; } catch (e) { tab = `error: ${e.message}`; }
  executed.push({ name, tab });
  return `ok in tab ${tab}`;
};

// [warm per chat] Knobs a suite may turn: the idle warm cap and idle time (main.js passes Performance mode's cap).
const limits = { maxWarmChats: 4, idleMs: undefined };
const quitHandlers = [];
const quit = () => { for (const fn of quitHandlers.splice(0)) { try { fn(); } catch {} } };
// Settings a suite may turn (mcpEnabled: outside agents may connect). Defaults as before.
const settings = { mcpEnabled: false, grokSidebar: true, grokWarmup: false };
// A recording stand-in for main.js's agent windows (features/agent-windows.js): one window per outside session, made by ensure().
const AGENT_TAB = 900;
const windows = {
  ensured: [], released: [], made: new Map(),
  get: (session) => windows.made.get(session) || null,
  ensure(session, label) {
    windows.ensured.push({ label, at: Date.now() });
    if (!windows.made.has(session)) windows.made.set(session, { agentWindow: true, label });
    return Promise.resolve(windows.made.get(session));
  },
  release: (session) => { windows.released.push(session); return true; },
  releaseAll() {},
};
const aiAgents = setupAiAgents({
  agentWindows: { windows, activeTabId: () => AGENT_TAB },
  app: { getPath: () => tmp, on(ev, fn) { if (ev === 'will-quit') quitHandlers.push(fn); } },
  maxWarmChats: () => limits.maxWarmChats,
  warmIdleMs: () => limits.idleMs,
  ipcMain: { handle() {}, on() {} },
  agent,
  tools: EXTERNAL_TOOLS,
  validateToolInput: () => null,
  readSettings: () => ({ ...settings }),
  writeSettings() {},
  ui: () => null,
  codexLocate: async () => ({ found: true, command: FAKE_CODEX, args: [], path: FAKE_CODEX, kind: 'exe', version: '9.9.9', source: 'test' }), // (the stand-in codex: no `--version` to run)
});
// The sidebar's engines: short stop / watchdog timings so the suites stay quick (properties every instance reads).
const tune = (e) => { if (e) { e.interruptMs = 800; } return e; };
tune(agent.engines.claudecode);
tune(agent.engines.grokbuild);

const chat = (model, history = []) => { const m = [...history]; m.settings = { model, adhdMode: true }; return m; };

// Sends `text` in chat `messages` bound to tab `tabId`; resolves { events, done } once the run says done.
function send(messages, text, tabId, extra = {}) {
  const events = [];
  const promise = agent.run(text, (e) => events.push(e), [], { tabId, messages, ...extra });
  const run = { events, promise, done: promise.then(() => events) };
  return run;
}
const textOf = (events) => events.filter((e) => e.type === 'text').map((e) => e.text).join('');
const errorsOf = (events) => events.filter((e) => e.type === 'error').map((e) => e.text);
const lastAssistant = (messages) => [...messages].reverse().find((m) => m.role === 'assistant') || null;
const turnText = (turn) => (!turn ? '' : typeof turn.content === 'string' ? turn.content : (turn.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));

// Calls one of Lumen's tools as the CLI run with this tag would (over MCP).
const toolCall = (tag, name = 'read_page', args = {}) => gate.callTool(name, args, { engine: tag, clientName: 'fake-cli', controller: new AbortController(), approvedHosts: new Set() });

let failures = 0;
const results = [];
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`);
};

function finish() {
  for (const child of live.values()) { try { child.kill(); } catch {} }
  try { agent.engines.claudecode.dispose?.(); } catch {}
  setTimeout(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch {}
    console.log(failures ? `\n${failures} of ${results.length} failed` : `\nall ${results.length} passed`);
    process.exit(failures ? 1 : 0);
  }, 300);
}
// A suite must never hang CI: a hard stop well inside scripts/test-units.js's 120 s.
const hardStop = (ms = 100000) => setTimeout(() => { console.log(`FAIL  suite timed out after ${ms / 1000}s`); failures++; finish(); }, ms).unref();

module.exports = { FAKE_CODEX, aiAgents, settings, windows, AGENT_TAB, limits, quit, tmp, LOG, gate, live, agent, state, executed, chat, send, until, sleep, readLog, msgOf, release, textOf, errorsOf, lastAssistant, turnText, toolCall, check, finish, hardStop };
