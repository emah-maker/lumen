// "Keep Grok Build connected" (Settings -> AI and agents, key grokKeepConnected, off by default): each sidebar chat that
// talks to Grok Build gets its own long-lived `grok agent stdio` process, which stays up between the chat's messages, so a
// later message skips everything a new grok process does before the model is asked.
//
// WHY (grok 1.0.46, measured 2026-10-03 on Windows; see the commit message for the full numbers)
// Without it every message is a new headless grok (grok-build.js): spawn, config and plugin load, sign-in, session
// create or --resume (reads the transcript), Lumen's MCP handshake, then the model call; and the message only counts as
// done when that process has flushed and exited, ~1 s after the reply's last word. Headless grok is itself an ACP client
// of an in-process agent; `grok agent stdio` is that same agent over JSON-RPC on stdin/stdout (Agent Client Protocol,
// ~/.grok/docs/user-guide/15-agent-mode.md), so a process can be kept and given one `session/prompt` per message.
//
// ONE PROCESS PER CHAT. A kept process belongs to one Grok session (the chat's gbSession, agent.js), so two tab chats never
// share one, and there is no state to carry between chats. `prewarm()` (composer focus, Grok Build chosen, startup) can
// start the chat's process before its message: for a chat that already has a session it is resumed; for a new chat a
// session is created, and the chat's first message takes it. Processes end when idle for idleMs (the setting; 0: never),
// past MAX_PROCS (the least recently used idle one goes), when the chat's tab closes or the chat is deleted
// (features/ai-agents.js grokChatGone), when the setting is turned off, and when Lumen quits.
// Stop and "Send now" cancel the turn (`session/cancel`) and keep the process; only one that doesn't answer the cancel
// within CANCEL_WAIT_MS is killed.
//
// ISOLATION: the same layers as a headless run (grok-build.js's header), adapted to what `grok agent stdio` accepts:
//  - GROK_HOME, config.toml (only the `lumen` MCP server, the [permission] deny rules, Lumen's two gate hooks), the
//    environment (buildEnv's short list) and the empty working folder are exactly a headless run's. prepare() writes the
//    locked-down config.toml (never the full-access one) right before each spawn.
//  - Built-in tools: `grok agent` has no --disallowed-tools / --deny / --allow / --permission-mode flags. An agent profile
//    (PROFILE_FILE, `--agent-profile`, frontmatter `disallowedTools`) removes the same built-ins --disallowed-tools does,
//    plus web search/fetch and memory; GROK_SUBAGENTS / GROK_WORKFLOWS / GROK_WEB_FETCH / GROK_MEMORY=0 turn those
//    features off. Measured: a trivial message's prompt is ~4.8k tokens, as with headless (~5k), against ~13k without.
//  - Lumen's gate (hooks) is unchanged and fail-closed: measured in agent mode, run_terminal_command and `write` were both
//    "Hook denied" and nothing was written. Each message re-arms the gate (mcp-http.js rearm): its UserPromptSubmit must be
//    seen before the model's first output, or the process is killed, as in headless.
//  - Grok's own permission check: instead of dontAsk + --allow, Grok asks Lumen (`session/request_permission`), and Lumen
//    allows only Lumen's tools, search_tool and run_terminal_command (which the gate has already put to the user), and
//    rejects everything else; an unreadable request is rejected.
//  - Lumen's stream check: a tool that isn't Lumen's and is reported running or completed (not merely attempted and
//    refused) kills the process and fails the message, as toolWatch does for a headless run.
//  - Never for full access or background tasks (grok-build.js keeps those headless), and never with --always-approve.
// Not covered, so these messages go through a headless run instead: images (`grok agent` says promptCapabilities.image is
// false), full access.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const IDLE_MS = 15 * 60 * 1000;
const SPARE_IDLE_MS = 3 * 60 * 1000; // a process started ahead of a message nobody sent yet
const MAX_PROCS = 4; // kept processes (one per chat); the least recently used idle one goes first
const START_TIMEOUT_MS = 30000; // initialize / session create
const LISTED_WAIT_MS = 8000; // a new session's wait for Lumen's tools to be listed (the gate holds UserPromptSubmit as long)
const CANCEL_WAIT_MS = 5000; // Stop: how long a cancelled turn may take to end before its process is killed
const QUIT_GRACE_MS = 3000; // stdin closed: time to flush its session before the process is killed
const PROFILE_FILE = 'lumen-sidebar-agent.md';
const EXTRA_ENV = { GROK_SUBAGENTS: '0', GROK_WORKFLOWS: '0', GROK_WEB_FETCH: '0', GROK_MEMORY: '0' };
const USD_TICKS = 1e10; // xAI's cost unit (costUsdTicks)

// The agent profile: Lumen's lockdown as `grok agent` takes it (see ISOLATION). The system prompt itself is Lumen's own,
// sent per process (initialize) and per session (session/new), as headless's --system-prompt-override.
function agentProfile(gb) {
  const off = [...new Set([...gb.BUILTIN_TOOLS.split(',').filter((t) => t !== 'run_terminal_command'), 'web_search', 'web_fetch', 'memory_search', 'memory_get'])];
  return ['---', 'name: lumen-sidebar', 'description: Lumen sidebar assistant (written by Lumen, features/grok-warm.js)', 'disallowedTools:', ...off.map((t) => `  - ${t}`), '---', '', 'You are the assistant built into the Lumen browser.', ''].join('\n');
}

// JSON-RPC 2.0 over the child's stdio, one message per line. request() always resolves, with the response ({ result } or
// { error }); onRequest(method, params) answers the agent's own requests (a throw: "Method not found").
function rpcOver(child, { onNotify, onRequest }) {
  let next = 0;
  let closed = false;
  let buf = '';
  const pending = new Map();
  const write = (msg) => {
    if (closed || !child.stdin || child.stdin.destroyed) return false;
    try { child.stdin.write(`${JSON.stringify(msg)}\n`); return true; } catch { return false; }
  };
  child.stdin?.on?.('error', () => {});
  const dispatch = (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.method === undefined) {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); clearTimeout(p.timer); p.resolve(m); }
      return;
    }
    if (typeof m.method !== 'string') return;
    if (m.id === undefined || m.id === null) { try { onNotify(m.method, m.params || {}); } catch {} return; }
    Promise.resolve().then(() => onRequest(m.method, m.params || {})).then(
      (result) => write({ jsonrpc: '2.0', id: m.id, result: result ?? null }),
      () => write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } }),
    );
  };
  child.stdout.setEncoding?.('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { dispatch(JSON.parse(line)); } catch {}
    }
  });
  return {
    request(method, params, timeoutMs = 0) {
      return new Promise((resolve) => {
        if (closed) { resolve({ error: { code: -32000, message: 'Grok Build has ended.', exited: true } }); return; }
        const id = ++next;
        const p = { resolve, timer: null };
        if (timeoutMs) p.timer = setTimeout(() => { pending.delete(id); resolve({ error: { code: -32001, message: `Grok Build did not answer ${method}.`, timeout: true } }); }, timeoutMs);
        pending.set(id, p);
        if (!write({ jsonrpc: '2.0', id, method, params })) { pending.delete(id); clearTimeout(p.timer); resolve({ error: { code: -32000, message: 'Grok Build has ended.', exited: true } }); }
      });
    },
    notify: (method, params) => write({ jsonrpc: '2.0', method, params }),
    close() {
      closed = true;
      for (const p of pending.values()) { clearTimeout(p.timer); p.resolve({ error: { code: -32000, message: 'Grok Build has ended.', exited: true } }); }
      pending.clear();
    },
  };
}

// A tool call as `grok agent` reports it: the tool's name (x.ai/tool meta, else its title) and its input.
const toolName = (tc) => String(tc?._meta?.['x.ai/tool']?.name || tc?.title || '');
const toolInput = (tc) => (tc?.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : null);

// Lumen's answer to session/request_permission: allow once for Lumen's own tools (gb.isLumenTool: lumen__*, search_tool,
// use_tool naming a lumen__ tool, run_terminal_command, which Lumen's gate has already put to the user), reject anything
// else. `known`: toolCallId -> { name, input } from the turn's tool_call updates, for a request that names only the id.
function permissionAnswer(gb, params, known = new Map()) {
  const tc = params?.toolCall || {};
  const seen = known.get(tc.toolCallId) || {};
  const name = toolName(tc) || seen.name || '';
  const input = toolInput(tc) || seen.input || null;
  const ok = Boolean(name) && gb.isLumenTool(name, input, true);
  const options = Array.isArray(params?.options) ? params.options : [];
  const pick = options.find((o) => (ok ? o?.kind === 'allow_once' : /^reject/.test(String(o?.kind || ''))));
  return { outcome: pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' } };
}

// A prompt response's _meta as the stream-json `result` grok-build.js reads (cli-utils usageOf, grokUsage): Anthropic-style
// usage (input excludes cache reads), modelUsage keyed by model, and the cost. lastCall: the call's own usage when the turn
// was one model call (the context's fill after it); null otherwise (not reported per call).
function resultOf(meta = {}) {
  const u = meta.usage || {};
  const cached = Number(u.cachedReadTokens) || 0;
  const input = Math.max(0, (Number(u.inputTokens) || 0) - cached);
  const usage = { input_tokens: input, output_tokens: Number(u.outputTokens) || 0, cache_read_input_tokens: cached, cache_creation_input_tokens: Number(u.cacheCreationTokens) || 0 };
  const modelUsage = Object.fromEntries(Object.keys(u.modelUsage || (meta.modelId ? { [meta.modelId]: 1 } : {})).map((id) => [id, {}]));
  const ticks = Number(u.costUsdTicks ?? meta.costUsdTicks);
  const result = { usage, modelUsage, ...(Number.isFinite(ticks) ? { total_cost_usd: ticks / USD_TICKS } : {}) };
  const lastCall = Number(u.modelCalls) === 1 ? { input_tokens: input, cache_read_input_tokens: cached } : null;
  return { result, lastCall };
}

// engine: the sidebar's GrokBuildEngine (prepare, spawn, kill, home, dir, userData, watchdogMs, onFresh, active, callBegin).
// enabled(): the setting (and Grok Build in use). idleMs(): ms an idle process is kept (0: until the chat goes).
function createGrokWarm({ engine, enabled = () => true, idleMs = () => IDLE_MS, spareIdleMs = SPARE_IDLE_MS, maxProcs = MAX_PROCS, listedWaitMs = LISTED_WAIT_MS, cancelWaitMs = CANCEL_WAIT_MS, startTimeoutMs = START_TIMEOUT_MS, gb = require('../ai/grok-build') }) {
  const { validModel } = require('../ai/cli-utils');
  const procs = new Set(); // every kept process that has its session
  const pending = new Set(); // starts in flight: { wanted (session id, null: new), spare, key, promise, proc }
  const stats = { spawned: 0, reused: 0, fallbacks: 0, prewarmed: 0 };
  let used = 0; // recency clock

  const live = (p) => p && !p.exited && !p.disposed;

  function idleLater(p, ms) {
    clearTimeout(p.idle);
    p.idle = null;
    if (!ms) return; // "never": until the chat goes, MAX_PROCS, the setting or Lumen quitting
    p.idle = setTimeout(() => dispose(p), ms);
    p.idle.unref?.();
  }

  function dispose(p, { now = false } = {}) {
    if (!p || p.disposed) return;
    p.disposed = true;
    procs.delete(p);
    clearTimeout(p.idle);
    p.rpc?.close();
    try { p.gate?.close(p.tag); } catch {}
    if (p.exited) return;
    // stdin closed: grok flushes its session and exits (~2.5 s measured); killed if it doesn't.
    if (now) { engine.kill(p.child); return; }
    try { p.child.stdin?.end(); } catch {}
    const t = setTimeout(() => { if (!p.exited) engine.kill(p.child); }, QUIT_GRACE_MS);
    t.unref?.();
  }

  // Over MAX_PROCS: the least recently used idle ones go (spares first).
  function trim(keep) {
    const idle = [...procs].filter((p) => p !== keep && !p.busy).sort((a, b) => (a.spare === b.spare ? a.used - b.used : a.spare ? -1 : 1));
    while (procs.size > maxProcs && idle.length) dispose(idle.shift());
  }

  // A new kept process with its session: resumed (sessionId) or new. Resolves the process, or throws (nothing sent).
  async function start({ systemPrompt, sessionId = null, model = 'default', spare = false }, slot = {}) {
    const prepared = await engine.prepare({ fullAccess: false }); // the locked-down config.toml (never the full-access one)
    engine.prep = null;
    if (!prepared?.bin) throw new Error('not installed');
    const { bin, gate, authBefore = null } = prepared;
    const profile = path.join(engine.home, PROFILE_FILE);
    await gb.writeIfChanged(profile, agentProfile(gb), 0o600);
    const tag = crypto.randomBytes(18).toString('hex');
    const p = { tag, gate, key: systemPrompt, sessionId: null, model: null, defaultModel: null, spare, authBefore, busy: false, turns: 0, exited: false, disposed: false, idle: null, used: ++used, stderr: '', onUpdate: null, known: new Map(), child: null, rpc: null };
    slot.proc = p; // (disposeAll can end a start in flight)
    if (slot.cancelled) throw new Error('cancelled');
    const gateRun = gate.open(tag, sessionId);
    try {
      const env = { ...gb.buildEnv({ userData: engine.userData, run: gateRun, home: engine.home, dir: engine.dir }), ...EXTRA_ENV };
      p.child = engine.spawn(bin, ['agent', '--agent-profile', profile, 'stdio'], { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env, cwd: engine.dir });
      stats.spawned++;
      if (p.disposed) throw new Error('cancelled');
      p.child.stderr?.setEncoding?.('utf8');
      p.child.stderr?.on('data', (c) => { p.stderr = (p.stderr + c).slice(-4000); });
      const exited = new Promise((resolve) => {
        p.child.on('error', (err) => { p.stderr += `\n${err.message}`; resolve(); });
        p.child.on('close', () => resolve());
      });
      exited.then(() => { p.exited = true; p.rpc?.close(); procs.delete(p); clearTimeout(p.idle); try { gate.close(tag); } catch {} if (p.turns) engine.settling = settle(p); });
      p.rpc = rpcOver(p.child, {
        onNotify: (method, params) => { if (method === 'session/update' && params?.sessionId === p.sessionId) p.onUpdate?.(params.update || {}); },
        onRequest: (method, params) => {
          if (method === 'session/request_permission') return permissionAnswer(gb, params, p.known);
          throw new Error('unsupported'); // no fs / terminal capability is offered
        },
      });
      const fail = (r, what) => { if (r?.error) throw new Error(`${what}: ${r.error.message || 'failed'}`); return r.result || {}; };
      fail(await p.rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, _meta: { systemPromptOverride: systemPrompt } }, startTimeoutMs), 'initialize');
      const created = sessionId
        ? fail(await p.rpc.request('session/resume', { sessionId, cwd: engine.dir, mcpServers: [] }, startTimeoutMs), 'session/resume')
        : fail(await p.rpc.request('session/new', { cwd: engine.dir, mcpServers: [], _meta: { systemPromptOverride: systemPrompt } }, startTimeoutMs), 'session/new');
      p.sessionId = sessionId || created.sessionId;
      if (!p.sessionId) throw new Error('no session');
      gate.bindChat?.(tag, p.sessionId);
      p.defaultModel = created.models?.currentModelId || null;
      p.model = p.defaultModel;
      await setModel(p, model);
      // Lumen's tools are listed to a new session at once (~10 ms, Lumen serves MCP itself); the gate holds the first
      // UserPromptSubmit until they are anyway.
      const until = Date.now() + listedWaitMs;
      while (!p.exited && !gate.listed(tag) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      if (p.exited || p.disposed) throw new Error('ended');
      procs.add(p);
      trim(p);
      return p;
    } catch (err) {
      dispose(p, { now: true });
      if (p.child && !p.exited) engine.kill(p.child); // (ended while starting: dispose() came before there was a child)
      throw err;
    }
  }

  // The sign-in, as for a headless run (grok-build.js linkAuth / settleAuth): the process was started with the user's
  // auth.json linked into Lumen's GROK_HOME, and is not re-linked while it lives (that could drop a token it refreshed).
  // After each turn and when it ends, a token it refreshed goes back to the user's file, and that copy becomes the
  // baseline for the next check (else a second refresh would read as the user signing in again).
  async function settle(p) {
    try {
      const real = path.join(gb.userGrokHome(), 'auth.json');
      if (await gb.settleAuthAsync(gb.userGrokHome(), engine.home, p.authBefore)) p.authBefore = await fs.promises.stat(real, { bigint: true }).catch(() => p.authBefore);
    } catch {}
  }

  async function setModel(p, model) {
    const want = model && model !== 'default' && validModel(model) ? model : p.defaultModel;
    if (!want || want === p.model) return;
    const r = await p.rpc.request('session/set_model', { sessionId: p.sessionId, modelId: want }, startTimeoutMs);
    if (r.error) throw new Error(`session/set_model: ${r.error.message || 'failed'}`);
    p.model = want;
  }

  // The kept process for this message (claimed: busy), after waiting for a prewarm() start of it still in flight. A process
  // for this chat made with another system prompt is ended (it would answer with the old one). null: none.
  async function find({ sessionId, resume, systemPrompt }) {
    const wait = [...pending].find((s) => (resume ? s.wanted === sessionId : s.spare && s.key === systemPrompt));
    if (wait) { try { await wait.promise; } catch {} }
    for (const p of [...procs]) {
      if (!live(p) || p.busy) continue;
      if (resume ? p.spare || p.sessionId !== sessionId : !p.spare) continue;
      if (p.key !== systemPrompt) { if (resume) dispose(p); continue; }
      p.busy = true;
      return p;
    }
    return null;
  }

  // One message through the chat's kept process. Resolves grok-build.js run()'s result, or null when this message must go
  // through a headless run instead (nothing was sent to Grok then).
  async function run({ prompt, images = [], sessionId, resume, systemPrompt, model = 'default', maxTurns = 0, signal, emit, runAgent = null, shownModel = null }) {
    if (!enabled()) { disposeAll(); return null; }
    if (images.length) { stats.fallbacks++; return null; } // `grok agent` takes no images
    let p = await find({ sessionId, resume, systemPrompt });
    if (p) stats.reused++;
    else {
      emit({ type: 'status', text: 'Starting Grok Build…' }); // the working line says why it waits (cleared on the first output)
      try { p = await starting({ systemPrompt, sessionId: resume ? sessionId : null, model, claimed: true }); } catch { stats.fallbacks++; return null; }
    }
    p.spare = false;
    p.used = ++used;
    clearTimeout(p.idle);
    if (signal.aborted) { p.busy = false; idleLater(p, idleMs()); return { text: '', sessionId: p.sessionId, stopped: true }; }
    try {
      await setModel(p, model);
    } catch {
      p.busy = false;
      dispose(p);
      stats.fallbacks++;
      return null;
    }
    const out = await turn(p, { prompt, sessionId: p.sessionId, resume, model, maxTurns, signal, emit, runAgent, shownModel });
    p.busy = false;
    if (out.keep && live(p)) idleLater(p, idleMs());
    else dispose(p, { now: true });
    delete out.keep;
    return out;
  }

  // start(), recorded while in flight so a run() can wait for a prewarm()'s start of the same chat.
  function starting(opts) {
    const slot = { wanted: opts.sessionId || null, spare: opts.spare === true, key: opts.systemPrompt, promise: null, proc: null, cancelled: false };
    slot.promise = start(opts, slot).then((p) => { if (opts.claimed) p.busy = true; return p; }).finally(() => pending.delete(slot));
    pending.add(slot);
    return slot.promise;
  }

  // The turn itself (session/prompt), mapped to the result a headless run gives. keep: whether the process may stay.
  async function turn(p, { prompt, sessionId, resume, model, maxTurns, signal, emit, runAgent, shownModel }) {
    const { gate, tag } = p;
    gate.rearm(tag); // this message must arm the gate again (its own UserPromptSubmit)
    if (p.turns === 0) { try { engine.onFresh?.({ sessionId, resume }); } catch {} }
    p.turns++;
    p.known = new Map();
    const active = { tag, emit, signal, child: p.child, agent: runAgent, tools: 0, inflight: 0, dog: null, arm: null };
    engine.active = active;
    let over = false;
    let stalled = false;
    let text = '';
    let lastKind = '';
    let offTool = null;
    let unguarded = false;
    let capped = false;
    let toolCalls = 0;
    let shown = false;
    const cap = maxTurns > 0 ? maxTurns : gb.DEFAULT_MAX_TURNS;
    const watchdogMs = engine.watchdogMs;
    const stopTurn = () => p.rpc.notify('session/cancel', { sessionId });
    active.arm = () => {
      clearTimeout(active.dog);
      if (!watchdogMs || over || active.inflight > 0) return;
      active.dog = setTimeout(() => { stalled = true; engine.kill(p.child); }, watchdogMs);
    };
    const kill = () => { engine.kill(p.child); };
    let cancelTimer = null;
    const onAbort = () => {
      stopTurn();
      cancelTimer = setTimeout(kill, cancelWaitMs); // a turn that doesn't end on its cancel: the process goes
    };
    p.onUpdate = (u) => {
      if (over || offTool || unguarded) return;
      active.arm();
      const kind = u.sessionUpdate;
      const output = kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' || kind === 'tool_call';
      if (output && !shown) {
        // Lumen's gate must have seen this message's UserPromptSubmit before the model says anything (grok-build.js).
        if (!gate.armed(tag)) { unguarded = true; kill(); return; }
        shown = true;
        const note = gb.modelNotice({ picked: model, served: gb.servedModel({ init: p.model }), shown: shownModel });
        if (note) emit({ type: 'notice', text: note });
      }
      if (kind === 'agent_message_chunk') {
        const t = u.content?.type === 'text' ? String(u.content.text || '') : '';
        if (!t) return;
        if (lastKind !== 'text') { if (text && !/\n\n$/.test(text)) text += '\n\n'; emit({ type: 'text_block' }); }
        lastKind = 'text';
        text += t;
        emit({ type: 'text', text: t });
      } else if (kind === 'agent_thought_chunk') {
        lastKind = 'thinking';
        const t = u.content?.type === 'text' ? String(u.content.text || '') : '';
        if (t) emit({ type: 'thinking', text: t });
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        lastKind = 'tool';
        const id = u.toolCallId;
        const before = p.known.get(id) || {};
        const name = toolName(u) || before.name || '';
        const input = (kind === 'tool_call' ? toolInput(u) : null) || before.input || toolInput(u);
        p.known.set(id, { name, input });
        if (kind === 'tool_call') {
          toolCalls++;
          if (toolCalls > cap) { capped = true; stopTurn(); return; }
        }
        // A tool that isn't Lumen's and actually ran (not one the gate or Grok refused): stop, as toolWatch would.
        if (/^(in_progress|completed)$/.test(String(u.status || '')) && !gb.isLumenTool(name, input, true)) {
          offTool = name === 'use_tool' ? `use_tool ${String(input?.tool_name || '(unreadable)').slice(0, 80)}` : String(name || 'unnamed tool').slice(0, 80);
          kill();
        }
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    active.arm();
    const blocks = [{ type: 'text', text: prompt }];
    const res = signal.aborted ? { error: { message: 'stopped' } } : await p.rpc.request('session/prompt', { sessionId, prompt: blocks });
    over = true;
    p.onUpdate = null;
    clearTimeout(active.dog);
    clearTimeout(cancelTimer);
    signal.removeEventListener('abort', onAbort);
    if (engine.active === active) engine.active = null;
    engine.settling = settle(p);
    const meta = res.result?._meta || {};
    const served = gb.servedModel({ init: meta.modelId || p.model });
    if (offTool) {
      emit({ type: 'error', text: `Lumen stopped Grok Build: it called a tool that isn't one of Lumen's (${offTool}). Grok reports a tool call as it starts running it, so that tool may already have run. Grok Build should only use Lumen's tools; if this keeps happening, pick another AI in the model picker.` });
      return { text, sessionId: null, failed: true, keep: false };
    }
    if (unguarded) {
      emit({ type: 'error', text: 'Lumen stopped Grok Build before it could act: Lumen couldn\'t confirm its check on Grok\'s tool calls was running. Make sure curl is installed and Grok Build is up to date, or pick another AI in the model picker.' });
      return { text: '', sessionId: null, failed: true, keep: false };
    }
    if (signal.aborted) return { text, sessionId, stopped: true, model: served, keep: !p.exited && !res.error?.exited };
    if (stalled) {
      emit({ type: 'error', text: `Grok Build stopped responding for ${Math.round(watchdogMs / 1000)} seconds, so Lumen ended it. Send your message again to pick up where it left off.` });
      return { text, sessionId, failed: true, keep: false };
    }
    const { result, lastCall } = resultOf(meta);
    const usage = res.result ? gb.grokUsage(result, { lastCall, info: gb.readModelInfo(engine.home, [meta.modelId, ...Object.keys(result.modelUsage)].filter(Boolean)) }) : null;
    const stop = String(res.result?.stopReason || '');
    if (capped || stop === 'max_turn_requests') return { text, sessionId, limit: true, cost: result.total_cost_usd, usage, model: served, keep: true };
    if (res.error || p.exited || stop === 'cancelled') {
      const failText = [res.error?.message, res.error?.data?.detail, p.stderr].filter(Boolean).join('\n');
      emit({ type: 'error', ...gb.describeFailure(failText || 'no output', null) });
      const gone = /no conversation found|session.*not found|unknown session|path not found/i.test(failText);
      return { text, sessionId: gone ? null : sessionId, failed: true, usage, planLimit: require('./grok-limit').limitOf(failText), model: served, keep: false };
    }
    return { text, sessionId, cost: result.total_cost_usd, usage, model: served, keep: true };
  }

  // Start the chat's process ahead of its message. spec: { sessionId (null: a new chat), systemPrompt, model }.
  // true when a start began; nothing when the chat already has one (kept or starting).
  function prewarm(spec) {
    if (!enabled() || !spec?.systemPrompt) return false;
    const resume = Boolean(spec.sessionId);
    const mine = (x) => x.key === spec.systemPrompt && (resume ? (x.sessionId || x.wanted) === spec.sessionId && !x.spare : x.spare);
    const kept = [...procs].find((p) => live(p) && mine(p));
    if (kept || [...pending].some(mine)) { if (kept && !kept.busy) { kept.used = ++used; idleLater(kept, kept.spare ? spareIdleMs : idleMs()); } return false; }
    stats.prewarmed++;
    starting({ systemPrompt: spec.systemPrompt, sessionId: resume ? spec.sessionId : null, model: spec.model || 'default', spare: !resume })
      .then((p) => { if (!p.busy) idleLater(p, p.spare ? spareIdleMs : idleMs()); })
      .catch(() => {});
    return true;
  }

  // The chat is gone (tab closed, chat deleted) or a headless run is about to extend its session: its idle process ends.
  function drop(sessionId) {
    if (!sessionId) return;
    for (const p of [...procs]) if (p.sessionId === sessionId && !p.busy) dispose(p);
    for (const s of pending) if (s.wanted === sessionId) { s.cancelled = true; if (s.proc) dispose(s.proc, { now: true }); }
  }

  // The setting went off, or Lumen quits (now: no grace for flushing).
  function disposeAll({ now = false } = {}) {
    for (const p of [...procs]) if (!p.busy || now) dispose(p, { now });
    for (const s of pending) { s.cancelled = true; if (s.proc) dispose(s.proc, { now: true }); }
  }

  const count = () => procs.size + pending.size;

  return { run, prewarm, drop, disposeAll, count, stats };
}

module.exports = { createGrokWarm, rpcOver, permissionAnswer, resultOf, agentProfile, PROFILE_FILE, EXTRA_ENV, IDLE_MS, MAX_PROCS };
