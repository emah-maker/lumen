// "Keep Codex connected" (Settings -> AI and agents, key codexKeepConnected, on by default): each sidebar chat that talks to
// Codex gets its own long-lived `codex app-server` process, which stays up between the chat's messages, so a later message
// skips everything a new `codex exec` does before the model is asked.
//
// WHY (codex-cli 0.160.0, measured 2026-10-04 on Windows; see the commit message for the numbers)
// Without it every message is a new `codex exec --json` (codex.js): spawn, config and sign-in load, thread create or resume,
// Lumen's MCP handshake, a first model request on a new connection; and the message only counts as done when that process
// has flushed and exited, ~1.4 s after the reply's last word. `codex app-server` is the same engine as a JSON-RPC server on
// stdin/stdout (`codex app-server generate-json-schema` prints the protocol): one process takes `thread/start` or
// `thread/resume` once and then one `turn/start` per message, streams the reply as deltas (exec prints a message only when it
// is whole), and `turn/interrupt` ends a turn without ending the process.
//
// ONE PROCESS PER CHAT. A kept process belongs to one Codex thread (the chat's cxSession, agent.js) in the chat's own Codex
// home (codex-chats/<chat id>), so two chats never share one. `prewarm()` (composer focus, Codex chosen, startup) can start
// the chat's process before its message: for a chat that already has a thread it is resumed; for a new chat a thread is
// started, and the chat's first message takes it. Processes end when idle for idleMs (the same choice as Grok Build's; 0:
// never), past MAX_PROCS (the least recently used idle one goes), when the chat's tab closes or the chat is deleted
// (features/ai-agents.js chatGone), when the setting is turned off, and when Lumen quits. Stop and "Send now" interrupt the
// turn and keep the process; only one that doesn't end the turn within CANCEL_WAIT_MS is killed.
//
// ISOLATION: the same layers as a headless run (codex.js's header):
//  - CODEX_HOME (Lumen's per-chat folder), its config.toml (only the `lumen` MCP server, sandbox read-only, approval never,
//    the OFF_FEATURES list: code_mode_host stays on, it is how Codex 0.160 gives the model its MCP tools), buildEnv's short
//    environment and an empty working folder are exactly a headless run's. The file is written right before each spawn.
//    Each process has its own MCP token (gate.open) and is itself the owner of that tag (owner(tag), ai-agents.js
//    engineForSession) for its whole life: its `active` carries the message's own scope during a turn and is null between
//    turns, when a stray tool call is refused.
//  - thread/start, thread/resume and turn/start repeat approvalPolicy "never" and the read-only sandbox.
//  - Codex's own approval requests: Lumen answers them itself and allows only Lumen's tools (approvalAnswer): a command, a
//    file change, a permission, a question or another server's tool is declined.
//  - Lumen's stream check (offItemOf): a shell command, file change, web search, sub-agent, picture tool or another
//    server's tool reported in an item kills the process and fails the message, as it does a headless run.
//  - Never for the stdio bridge (LUMEN_CODEX_MCP=stdio) and never with a bypass, full-auto or writable sandbox.
// Anything that goes wrong before a message is sent (no app-server in this Codex, the MCP server not ready, a thread Codex
// no longer has) makes run() return null, and the message goes through a headless run instead.
//
// FULL ACCESS (codexFullAccess, codex.js): a kept process is for one kind only, "locked" or "full" (modeOf): a message of the other kind
// ends an idle process of this chat and starts the right one, and prewarm() starts the kind the setting asks for. A full-access process
// has config.toml with the sandbox off and Codex's shell, patch, picture-view and web tools on, the user's whole environment, thread and
// turn sandbox danger-full-access, and the longer watchdog; Codex's own approval requests are allowed (only another MCP server's tool
// stays refused). The working folder is still the empty Lumen folder; Lumen's note names the user's home folder.
//
// SIGN-IN: auth.json is copied in before a process starts (when the user's is newer) and back after each turn and when it
// ends (when Codex refreshed it), as for a headless run; a kept process whose user-side sign-in has changed since is
// restarted at the next message, so it never keeps using a token the user has replaced.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { rpcOver } = require('./grok-warm');
const cx = require('../ai/codex');
const codexUsage = require('../ai/codex-usage');
const locate = require('../ai/codex-locate');
const { validModel } = require('../ai/cli-utils');
const { removeDir } = require('../ai/temp-dirs');

const IDLE_MS = 15 * 60 * 1000;
const SPARE_IDLE_MS = 3 * 60 * 1000; // a process started ahead of a message nobody sent yet
const MAX_PROCS = 4; // kept processes (one per chat); the least recently used idle one goes first
const START_TIMEOUT_MS = 30000; // initialize / thread start
const READY_WAIT_MS = 8000; // a new thread's wait for Lumen's MCP server to be connected
const CANCEL_WAIT_MS = 5000; // Stop: how long an interrupted turn may take to end before its process is killed
const QUIT_GRACE_MS = 2000; // stdin closed: time to flush before the process is killed
const EXIT_WAIT_MS = 8000; // a headless run in the same home waits this long at most for an ending process
const modeOf = (fullAccess) => (fullAccess === true ? 'full' : 'locked');
const FAILURES_BEFORE_GIVING_UP = 2; // consecutive start failures: this Codex gets headless runs only until Lumen restarts
// Notifications Lumen never reads (the connection opts out of them: less to parse).
const OPT_OUT = ['remoteControl/status/changed', 'account/rateLimits/updated', 'thread/status/changed', 'account/updated', 'skills/changed', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/commandExecution/outputDelta', 'item/fileChange/outputDelta', 'turn/diff/updated', 'turn/plan/updated'];

// Lumen's answer to a request Codex makes of its client: allow only Lumen's tools. Returns the result object, or null for a
// method this client doesn't know (answered "Method not found"). Pure, so tests feed it recorded requests.
// fullAccess: Codex's own tools are the user's to run (approval policy is never, so these are rare): a command or a change is allowed once.
function approvalAnswer(method, params = {}, { fullAccess = false } = {}) {
  switch (method) {
    case 'item/commandExecution/requestApproval': return { decision: fullAccess ? 'accept' : 'decline' };
    case 'item/fileChange/requestApproval': return { decision: fullAccess ? 'accept' : 'decline' };
    case 'applyPatchApproval': case 'execCommandApproval': return { decision: fullAccess ? 'approved' : 'denied' };
    case 'item/permissions/requestApproval': return fullAccess && params.permissions && typeof params.permissions === 'object' ? { permissions: params.permissions, scope: 'turn' } : { permissions: {}, scope: 'turn' }; // (locked: grants nothing)
    case 'item/tool/requestUserInput': return { answers: {} };
    case 'item/tool/call': return { contentItems: [], success: false }; // Lumen offers no client-side tools
    case 'mcpServer/elicitation/request': return String(params.serverName || '') === 'lumen' ? { action: 'accept', content: null } : { action: 'decline', content: null };
    default: return null;
  }
}

// An item of a thread that is not one of Lumen's tools: the label to stop the run with, else null (codex.js offItemOf, for
// app-server's item names).
function offItemOf(item, { fullAccess = false } = {}) {
  if (!item || typeof item !== 'object') return null;
  const type = String(item.type || '');
  if (!fullAccess) { // [full access] Codex's own shell, patch, web and picture-view tools are expected then
    if (type === 'commandExecution') return 'a shell command';
    if (type === 'fileChange') return 'a file change';
    if (type === 'webSearch') return 'a web search';
    if (type === 'imageView') return 'a picture tool';
  }
  if (type === 'dynamicToolCall') return 'a tool Lumen did not give it';
  if (type === 'collabAgentToolCall' || type === 'subAgentActivity') return 'a sub-agent';
  if (type === 'imageGeneration') return 'a picture tool';
  if (type === 'mcpToolCall' && String(item.server || '') !== 'lumen') return `${String(item.server || 'another server').slice(0, 40)}/${String(item.tool || '').slice(0, 40)}`;
  return null;
}

// A reasoning item's text for the thinking line.
function reasoningText(item) {
  const parts = [...(Array.isArray(item?.summary) ? item.summary : []), ...(!item?.summary?.length && Array.isArray(item?.content) ? item.content : [])];
  return parts.map((s) => (typeof s === 'string' ? s : String(s?.text || ''))).filter(Boolean).join('\n\n').trim();
}

// thread/tokenUsage/updated's `last` (one model call) -> the snake_case shape of exec's usage, summed over a turn's calls.
function addUsage(acc, last) {
  if (!last || typeof last !== 'object') return acc;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    input_tokens: n(acc.input_tokens) + n(last.inputTokens),
    cached_input_tokens: n(acc.cached_input_tokens) + n(last.cachedInputTokens),
    cache_write_input_tokens: n(acc.cache_write_input_tokens) + n(last.cacheWriteInputTokens),
    output_tokens: n(acc.output_tokens) + n(last.outputTokens),
    reasoning_output_tokens: n(acc.reasoning_output_tokens) + n(last.reasoningOutputTokens),
  };
}

const sleep = (ms, { unref = false } = {}) => new Promise((r) => { const t = setTimeout(r, ms); if (unref) t.unref?.(); });

// engine: the sidebar's CodexEngine (prepare, userHome, userData, spawn, kill, tmp, workDirs, watchdogMs, onFresh, afterLast).
// enabled(): the setting (and Codex in use). idleMs(): ms an idle process is kept (0: until the chat goes).
function createCodexWarm({ engine, enabled = () => true, idleMs = () => IDLE_MS, spareIdleMs = SPARE_IDLE_MS, maxProcs = MAX_PROCS, readyWaitMs = READY_WAIT_MS, cancelWaitMs = CANCEL_WAIT_MS, startTimeoutMs = START_TIMEOUT_MS, quitGraceMs = QUIT_GRACE_MS }) {
  const procs = new Set(); // every kept process that has its thread
  const pending = new Set(); // starts in flight: { key, wanted (thread id, null: new), spare, promise, proc, cancelled }
  const stats = { spawned: 0, reused: 0, fallbacks: 0, prewarmed: 0, restarts: 0 };
  let used = 0; // recency clock
  let failures = 0;

  const live = (p) => p && !p.exited && !p.disposed;
  const userAuth = () => path.join(engine.userHome(), 'auth.json');

  // Has the user's auth.json been written since this process's copy was made? (whole milliseconds: a copy keeps its mtime only to the
  // millisecond.) It is then copied in, for the process that replaces this one.
  async function userSignInChanged(p) {
    try {
      const src = await fs.promises.stat(userAuth());
      const dst = await fs.promises.stat(path.join(p.home, 'auth.json')).catch(() => null);
      if (dst && Math.floor(dst.mtimeMs) >= Math.floor(src.mtimeMs)) return false;
      await cx.copyIfNewer(userAuth(), path.join(p.home, 'auth.json'));
      return true;
    } catch { return false; }
  }

  function idleLater(p, ms) {
    clearTimeout(p.idle);
    p.idle = null;
    if (!ms) return; // "never": until the chat goes, MAX_PROCS, the setting or Lumen quitting
    p.idle = setTimeout(() => dispose(p), ms);
    p.idle.unref?.();
  }

  // The process is over (it exited, or it never ran): its folder and its sign-in copy-back.
  function cleanup(p) {
    if (p.cleaned) return;
    p.cleaned = true;
    if (p.dir) { engine.workDirs.delete(p.dir); removeDir(p.dir); }
    cx.returnAuth({ userHome: engine.userHome(), home: p.home }).catch(() => {});
  }

  function dispose(p, { now = false } = {}) {
    if (!p || p.disposed) return;
    p.disposed = true;
    procs.delete(p);
    clearTimeout(p.idle);
    p.rpc?.close();
    try { p.gate?.close(p.tag); } catch { /* closed */ }
    if (!p.child) { cleanup(p); return; }
    if (p.exited) return;
    // A headless run in this home waits for the ending process (its thread files and sign-in copy-back come first).
    const set = cx.exitsOf(p.home);
    const gone = Promise.race([p.exitedP, sleep(EXIT_WAIT_MS, { unref: true })]);
    set.add(gone);
    gone.then(() => set.delete(gone));
    if (now) { engine.kill(p.child); return; }
    try { p.child.stdin?.end(); } catch { /* gone */ }
    const t = setTimeout(() => { if (!p.exited) engine.kill(p.child); }, quitGraceMs);
    t.unref?.();
  }

  // Over MAX_PROCS: the least recently used idle ones go (spares first).
  function trim(keep) {
    const idle = [...procs].filter((p) => p !== keep && !p.busy).sort((a, b) => (a.spare === b.spare ? a.used - b.used : a.spare ? -1 : 1));
    while (procs.size > maxProcs && idle.length) dispose(idle.shift());
  }

  // A new kept process with its thread: resumed (sessionId) or new. Resolves the process, or throws (nothing sent).
  async function start({ chatId, sessionId = null, spare = false, fullAccess = false }, slot = {}) {
    if (process.env.LUMEN_CODEX_MCP === 'stdio') throw new Error('stdio bridge');
    const prepared = await engine.prepare();
    if (!prepared?.spec) throw new Error('not installed');
    const { spec, gate } = prepared;
    const userHome = engine.userHome();
    const home = cx.chatHomeFor(engine.userData, chatId);
    if (!home) throw new Error('no chat');
    await engine.afterLast(home); // a headless run's Codex of this chat may still be exiting
    await fs.promises.mkdir(home, { recursive: true, mode: 0o700 });
    await cx.pullAuth({ userHome, home });
    const tag = crypto.randomBytes(18).toString('hex');
    const p = { tag, gate, key: cx.chatKey(chatId), mode: modeOf(fullAccess), full: fullAccess === true, home, dir: null, threadId: null, effort: '', spare, busy: false, turns: 0, exited: false, disposed: false, cleaned: false, idle: null, used: ++used, stderr: '', mcp: 'starting', mcpError: '', onNote: null, child: null, rpc: null, owner: null, exitedP: null };
    // The owner of this process's MCP tag (features/ai-agents.js engineForSession / onTerminalApproval): its `active` is the
    // turn in progress (with that message's own task scope), null between turns.
    p.owner = {
      kind: 'codex',
      background: false,
      active: null,
      owns: (t) => Boolean(t && !p.disposed && !p.exited && t.length === tag.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(tag))),
      callBegin(a = p.owner.active) { if (!a) return; a.tools++; a.inflight++; clearTimeout(a.dog); },
      callEnd(a = p.owner.active) { if (!a) return; a.inflight = Math.max(0, a.inflight - 1); a.arm?.(); },
    };
    slot.proc = p; // (disposeAll can end a start in flight)
    if (slot.cancelled) throw new Error('cancelled');
    const gateRun = gate.open(tag, sessionId || tag);
    try {
      p.dir = fs.mkdtempSync(path.join(engine.tmp, 'lumen-cx-')); // the working folder: empty
      engine.workDirs.add(p.dir);
      // No `model` line: the model is chosen per turn (turn/start), so a process serves any of the chat's messages.
      await fs.promises.writeFile(path.join(home, 'config.toml'), cx.configFor({ run: gateRun, fullAccess }), { mode: 0o600 });
      const inv = locate.buildInvocation(spec, ['app-server']);
      const env = cx.buildEnv({ home, run: gateRun, extra: inv.options.envExtra || {}, fullAccess });
      p.child = engine.spawn(inv.file, inv.args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env, cwd: p.dir, ...(inv.options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
      stats.spawned++;
      if (p.disposed) throw new Error('cancelled');
      p.child.stderr?.setEncoding?.('utf8');
      p.child.stderr?.on('data', (c) => { p.stderr = (p.stderr + c).slice(-4000); });
      p.exitedP = new Promise((resolve) => {
        p.child.on('error', (err) => { p.stderr += `\n${err.message}`; resolve(err.code === 'ENOENT' ? 'ENOENT' : -1); });
        p.child.on('close', (c) => resolve(c));
      });
      p.exitedP.then((c) => { p.exited = true; p.exitCode = c; p.owner.active = null; p.rpc?.close(); procs.delete(p); clearTimeout(p.idle); try { gate.close(tag); } catch { /* closed */ } cleanup(p); });
      p.rpc = rpcOver(p.child, {
        name: 'Codex',
        onNotify: (method, params) => {
          if (method === 'mcpServer/startupStatus/updated' && params?.name === 'lumen') { p.mcp = params.status === 'ready' ? 'ready' : params.status === 'failed' ? 'failed' : p.mcp; if (params.status === 'failed') p.mcpError = String(params.error || ''); return; }
          p.onNote?.(method, params || {});
        },
        onRequest: (method, params) => {
          const answer = approvalAnswer(method, params, { fullAccess });
          if (answer === null) throw new Error('unsupported');
          return answer;
        },
      });
      const fail = (r, what) => { if (r?.error) throw Object.assign(new Error(`${what}: ${r.error.message || 'failed'}`), { rpc: r.error }); return r.result || {}; };
      fail(await p.rpc.request('initialize', { clientInfo: { name: 'lumen', title: 'Lumen', version: '1' }, capabilities: { experimentalApi: false, optOutNotificationMethods: OPT_OUT } }, startTimeoutMs), 'initialize');
      p.rpc.notify('initialized', undefined);
      const common = { cwd: p.dir, approvalPolicy: 'never', sandbox: fullAccess ? 'danger-full-access' : 'read-only' };
      const created = sessionId
        ? fail(await p.rpc.request('thread/resume', { threadId: sessionId, excludeTurns: true, ...common }, startTimeoutMs), 'thread/resume')
        : fail(await p.rpc.request('thread/start', { ephemeral: false, serviceName: 'lumen', ...common }, startTimeoutMs), 'thread/start');
      p.threadId = created.thread?.id || sessionId || null;
      if (!p.threadId || !cx.SAFE_SESSION.test(p.threadId)) throw new Error('no thread');
      gate.bindChat?.(tag, p.threadId);
      // Lumen's MCP server is connected at once (~10 ms: Lumen serves it itself); a failure here means no browser tools.
      const until = Date.now() + readyWaitMs;
      while (!p.exited && p.mcp === 'starting' && !gate.listed?.(tag) && Date.now() < until) await sleep(15);
      if (p.exited || p.disposed) throw new Error('ended');
      if (p.mcp === 'failed') throw new Error(`Lumen's tools did not connect: ${p.mcpError}`);
      procs.add(p);
      trim(p);
      return p;
    } catch (err) {
      dispose(p, { now: true });
      if (p.child && !p.exited) engine.kill(p.child); // (ended while starting: dispose() came before there was a child)
      throw err;
    }
  }

  // start(), recorded while in flight so a run() can wait for a prewarm()'s start of the same chat.
  function starting(opts) {
    const slot = { key: cx.chatKey(opts.chatId), mode: modeOf(opts.fullAccess), wanted: opts.sessionId || null, spare: opts.spare === true, promise: null, proc: null, cancelled: false };
    slot.promise = start(opts, slot).then((p) => { if (opts.claimed) p.busy = true; failures = 0; return p; }, (err) => { failures++; throw err; }).finally(() => pending.delete(slot));
    pending.add(slot);
    return slot.promise;
  }

  // The kept process for this message (claimed: busy), after waiting for a prewarm() start of it still in flight. A process
  // of this chat for another thread is ended (a new chat, a thread Lumen dropped). null: none.
  async function find({ key, sessionId, resume, mode }) {
    const wait = [...pending].find((s) => s.key === key && s.mode === mode && (resume ? s.wanted === sessionId : s.spare));
    if (wait) { try { await wait.promise; } catch { /* the caller starts its own */ } }
    for (const p of [...procs]) {
      if (p.key !== key || !live(p) || p.busy) continue;
      if (p.mode !== mode || (resume ? p.spare || p.threadId !== sessionId : !p.spare)) { dispose(p); continue; } // (the other kind of process, or another thread)
      p.busy = true;
      return p;
    }
    return null;
  }

  // One message through the chat's kept process. Resolves codex.js run()'s result, or null when this message must go through
  // a headless run instead (nothing was sent to Codex then).
  async function run({ chatId, prompt, images = [], sessionId, systemPrompt, model = 'default', effort = '', fullAccess = false, signal, emit, runAgent = null, scope = null }) {
    fullAccess = fullAccess === true;
    if (!enabled()) { disposeAll(); return null; }
    if (chatId == null || failures >= FAILURES_BEFORE_GIVING_UP) { stats.fallbacks++; return null; }
    const resume = Boolean(sessionId) && cx.SAFE_SESSION.test(sessionId);
    const key = cx.chatKey(chatId);
    let p = await find({ key, sessionId, resume, mode: modeOf(fullAccess) });
    // The user's sign-in changed since this process copied it (a new login, or a token another Codex refreshed): start over.
    if (p && await userSignInChanged(p)) { p.busy = false; dispose(p); stats.restarts++; p = null; }
    // A reasoning effort chosen earlier stays on a thread until another is chosen: back to Codex's own default needs a new process.
    if (p && p.effort && !effort) { p.busy = false; dispose(p); stats.restarts++; p = null; }
    if (p) stats.reused++;
    else {
      emit({ type: 'status', text: 'Starting Codex…' }); // the working line says why it waits (cleared on the first output)
      try { p = await starting({ chatId, sessionId: resume ? sessionId : null, claimed: true, fullAccess }); } catch { stats.fallbacks++; return null; }
    }
    p.spare = false;
    p.used = ++used;
    clearTimeout(p.idle);
    if (signal.aborted) { p.busy = false; idleLater(p, idleMs()); return { text: '', sessionId: p.threadId, stopped: true }; }
    const out = await turn(p, { prompt, resume, systemPrompt, images, model, effort, signal, emit, runAgent, scope });
    p.busy = false;
    if (out.keep && live(p)) idleLater(p, idleMs());
    else dispose(p, { now: true });
    delete out.keep;
    return out;
  }

  // The turn itself (turn/start), mapped to the result a headless run gives. keep: whether the process may stay.
  async function turn(p, { prompt, resume, systemPrompt, images, model, effort, signal, emit, runAgent, scope = null }) {
    const { tag, threadId } = p;
    if (p.turns === 0) { try { engine.onFresh?.({ sessionId: threadId, resume }); } catch { /* optional */ } }
    p.turns++;
    // [parallel CLI chats] The turn is the process's own (p.owner.active), never the shared engine's: its tool calls find it
    // by this process's tag and act with this message's own scope.
    const active = { tag, emit, signal, child: p.child, agent: runAgent, scope, tools: 0, inflight: 0, dog: null, arm: null };
    p.owner.active = active;
    let over = false;
    let stalled = false;
    let text = '';
    let usage = null;
    let sum = {};
    let calls = 0;
    let turnId = null;
    let status = null; // turn/completed's: completed | failed | interrupted
    let failedMsg = null;
    const imagePaths = []; // image files this turn's shell commands named (cx.itemImagePaths)
    let lastError = null;
    let offItem = null;
    let stopAsked = false;
    let started = false; // turn/start was accepted
    let lastId = null;
    const shown = new Map(); // agentMessage id -> how much of its text is on screen
    const shownText = new Map(); // agentMessage id -> its text so far, from the deltas
    const watchdogMs = p.full && engine.watchdogMs ? Math.max(engine.watchdogMs, cx.FULL_WATCHDOG_MS) : engine.watchdogMs; // [full access] a silent shell command is not a hang
    const kill = () => { engine.kill(p.child); };
    let finish;
    const ended = new Promise((resolve) => { finish = resolve; });
    active.arm = () => {
      clearTimeout(active.dog);
      if (!watchdogMs || over || active.inflight > 0) return;
      active.dog = setTimeout(() => { stalled = true; kill(); }, watchdogMs);
    };
    const say = (id, full) => { // an agent message grew to `full`: the new part goes on screen
      const had = shown.get(id) ?? 0;
      if (full.length <= had) return;
      // A new agent message starts a new paragraph in the saved reply too (see claude-code.js).
      if (!shown.has(id) && lastId !== null && text && !/\n\n$/.test(text)) { text += '\n\n'; emit({ type: 'text_block' }); }
      lastId = id;
      const delta = full.slice(had);
      shown.set(id, full.length);
      text += delta;
      emit({ type: 'text', text: delta });
    };
    p.onNote = (method, params) => {
      if (over || offItem) return;
      if (params.threadId !== threadId) return;
      const pid = params.turnId ?? params.turn?.id ?? null;
      if (turnId && pid && pid !== turnId) return; // an earlier turn's late notification
      active.arm();
      if (method === 'item/agentMessage/delta') {
        const id = String(params.itemId || '');
        if (id && typeof params.delta === 'string') { const full = (shownText.get(id) || '') + params.delta; shownText.set(id, full); say(id, full); }
        return;
      }
      if (method === 'item/started' || method === 'item/completed') {
        const item = params.item || {};
        const bad = offItemOf(item, { fullAccess: p.full });
        if (bad) { offItem = bad; kill(); finish('off'); return; }
        if (item.type === 'agentMessage' && method === 'item/completed' && typeof item.text === 'string') { shownText.set(String(item.id), item.text); say(String(item.id), item.text); }
        else if (item.type === 'reasoning' && method === 'item/completed') { const t = reasoningText(item); if (t) emit({ type: 'thinking', text: t }); }
        else if (method === 'item/completed') for (const f of cx.itemImagePaths(item)) if (imagePaths.length < 20 && !imagePaths.includes(f)) imagePaths.push(f);
        return;
      }
      if (method === 'thread/tokenUsage/updated') { sum = addUsage(sum, params.tokenUsage?.last); calls++; return; }
      if (method === 'error') { const m = String(params.error?.message || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 400); if (m) lastError = m; return; }
      if (method === 'turn/completed') {
        status = String(params.turn?.status || 'completed');
        if (status === 'failed') failedMsg = String(params.turn?.error?.message || lastError || 'The turn failed.').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 400);
        finish('done');
      }
    };
    const interrupt = () => { if (turnId) p.rpc.request('turn/interrupt', { threadId, turnId }, 10000); };
    let cancelTimer = null;
    const onAbort = () => {
      stopAsked = true;
      interrupt();
      cancelTimer = setTimeout(kill, cancelWaitMs); // a turn that doesn't end on its interrupt: the process goes
    };
    signal.addEventListener('abort', onAbort, { once: true });
    p.exitedP.then(() => finish('exit'));
    active.arm();

    // Pictures: written to a folder of their own for this turn (the working folder stays empty), read by Codex as local images.
    let imgDir = null;
    const input = [];
    try {
      const files = [];
      for (const [i, img] of images.slice(0, 8).entries()) {
        const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[img.media_type];
        if (!ext) continue;
        imgDir ||= fs.mkdtempSync(path.join(engine.tmp, 'lumen-cx-'));
        engine.workDirs.add(imgDir);
        const f = path.join(imgDir, `image-${i}.${ext}`);
        await fs.promises.writeFile(f, Buffer.from(img.data, 'base64'), { mode: 0o600 });
        files.push(f);
      }
      input.push({ type: 'text', text: cx.promptFor({ prompt, systemPrompt, resume }), text_elements: [] }, ...files.map((f) => ({ type: 'localImage', path: f })));
      const params = { threadId, input, approvalPolicy: 'never', sandboxPolicy: { type: p.full ? 'dangerFullAccess' : 'readOnly' }, ...(model !== 'default' && validModel(model) ? { model } : {}), ...(effort ? { effort } : {}) };
      const res = signal.aborted ? { error: { message: 'stopped' } } : await p.rpc.request('turn/start', params, startTimeoutMs);
      if (res.error) { if (!signal.aborted) failedMsg = res.error.message || 'Codex did not start the turn.'; finish('start'); } else {
        turnId = res.result?.turn?.id || null;
        started = true;
        if (stopAsked) interrupt();
        await ended; // turn/completed, the process ending, or the watchdog
      }
    } finally {
      over = true;
      p.onNote = null;
      clearTimeout(active.dog);
      clearTimeout(cancelTimer);
      signal.removeEventListener('abort', onAbort);
      if (p.owner.active === active) p.owner.active = null;
      if (imgDir) { engine.workDirs.delete(imgDir); removeDir(imgDir); }
    }
    cx.returnAuth({ userHome: engine.userHome(), home: p.home }).catch(() => {}); // a token Codex refreshed during the turn

    if (calls) usage = codexUsage.tokensOf(sum);
    let rateLimit = null;
    try { rateLimit = codexUsage.scanSessions({ home: p.home, days: 1, maxFiles: 2 }).limits || null; } catch { /* no log */ }
    const served = model !== 'default' && validModel(model) ? model : null;
    p.effort = effort || '';

    if (offItem) {
      emit({ type: 'error', text: `Lumen stopped Codex: it used something that isn't one of Lumen's browser tools (${offItem}). Codex should only use Lumen's tools; if this keeps happening, pick another AI in the model picker.` });
      return { text, sessionId: null, failed: true, usage, rateLimit, keep: false };
    }
    if (signal.aborted) return { text, sessionId: threadId, stopped: true, usage, rateLimit, model: served, imagePaths, keep: !p.exited && (status !== null || !started) };
    if (stalled) {
      emit({ type: 'error', text: `Codex stopped responding for ${Math.round(watchdogMs / 1000)} seconds, so Lumen ended it. Send your message again to pick up where it left off.` });
      return { text, sessionId: threadId, failed: true, usage, rateLimit, keep: false };
    }
    if (status === 'completed' && !failedMsg) {
      engine.signedOut = false;
      return { text, sessionId: threadId, usage, rateLimit, model: served, imagePaths, keep: true };
    }
    const failText = failedMsg || lastError || p.stderr || '';
    const failure = cx.describeFailure(failText, p.exited ? p.exitCode : null, { fullAccess: p.full });
    if (/not signed in/.test(failure.text)) { engine.signedOut = true; engine.statusCache = null; }
    emit({ type: 'error', ...failure });
    return { text, sessionId: threadId, failed: true, usage, rateLimit, planLimit: codexUsage.limitMessage(failText), model: served, keep: false };
  }

  // Start the chat's process ahead of its message. spec: { chatId, sessionId (null: a new chat) }.
  // true when a start began; nothing when the chat already has one (kept or starting).
  function prewarm(spec) {
    if (!enabled() || spec?.chatId == null || failures >= FAILURES_BEFORE_GIVING_UP) return false;
    const resume = Boolean(spec.sessionId) && cx.SAFE_SESSION.test(spec.sessionId);
    const key = cx.chatKey(spec.chatId);
    const fullAccess = spec.fullAccess === true;
    const mode = modeOf(fullAccess);
    for (const p of [...procs]) if (p.key === key && p.mode !== mode && !p.busy) dispose(p); // the setting changed: the other kind of process goes
    const mine = (x) => x.key === key && x.mode === mode && (resume ? (x.threadId || x.wanted) === spec.sessionId && !x.spare : x.spare);
    const kept = [...procs].find((p) => live(p) && mine(p));
    if (kept || [...pending].some(mine)) { if (kept && !kept.busy) { kept.used = ++used; idleLater(kept, kept.spare ? spareIdleMs : idleMs()); } return false; }
    stats.prewarmed++;
    starting({ chatId: spec.chatId, sessionId: resume ? spec.sessionId : null, spare: !resume, fullAccess })
      .then((p) => { if (!p.busy) idleLater(p, p.spare ? spareIdleMs : idleMs()); })
      .catch(() => {});
    return true;
  }

  // The chat is gone (tab closed, chat deleted) or a headless run is about to use its Codex home: its idle process ends.
  function dropChat(chatId) {
    if (chatId == null) return;
    const key = cx.chatKey(chatId);
    for (const p of [...procs]) if (p.key === key && !p.busy) dispose(p);
    for (const s of pending) if (s.key === key) { s.cancelled = true; if (s.proc) dispose(s.proc, { now: true }); }
  }

  // The setting went off, or Lumen quits (now: no grace for flushing).
  function disposeAll({ now = false } = {}) {
    for (const p of [...procs]) if (!p.busy || now) dispose(p, { now });
    for (const s of pending) { s.cancelled = true; if (s.proc) dispose(s.proc, { now: true }); }
  }

  const count = () => procs.size + pending.size;
  const settled = () => pending.size === 0; // no start in flight (a prewarm has finished or was cancelled)

  // The owner of an MCP tag among the kept processes, starting ones included (features/ai-agents.js engineForSession).
  const owner = (tag) => {
    if (!tag) return null;
    for (const p of procs) if (p.owner?.owns(tag)) return p.owner;
    for (const s of pending) if (s.proc?.owner?.owns(tag)) return s.proc.owner;
    return null;
  };

  return { run, prewarm, dropChat, disposeAll, count, settled, owner, stats };
}

module.exports = { createCodexWarm, modeOf, approvalAnswer, offItemOf, reasoningText, addUsage, OPT_OUT, IDLE_MS, MAX_PROCS };
