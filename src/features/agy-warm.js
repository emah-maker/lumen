// [keep connected] Antigravity's kept process: each sidebar chat on Antigravity gets one long-lived `agy` process that stays up
// between the chat's messages, so a later message skips what a new `agy -p` does before the model is asked.
//
// WHY (agy 1.5.1 log, 2026-11-05; see the PR): every message was a new `agy -p` process, and ~6.6 s of it came before the message
// was sent: the keyring sign-in, loadCodeAssist (x3), fetchAvailableModels and the experiments. agy 1.1.15+ has
// `--input-format stream-json` (antigravity.js buildStreamArgs): one process reads one NDJSON message per line from stdin and runs a
// turn for each in a single conversation, printing the same stream-json events as -p; a turn ends at its `result` event and the
// process waits for the next line. The line's shape (antigravity.js streamLine) was checked with one signed-in agy 1.5.15 run.
//
// ONE PROCESS PER CHAT, the way features/codex-warm.js does it for Codex:
//  - the chat's own home (antigravity.js chatHomeFor), so two chats never share one, and never two processes in one home: a start
//    waits for an ending process of the same chat (exits), and a one-message run of the chat first ends its idle process (dropChat);
//  - its own MCP tag for its whole life: gate.open once, mcp_config.json written once (its token) and removed when it ends, and the
//    process is itself the owner of that tag (owner(tag), ai-agents.js engineForSession): its `active` carries the message's own
//    scope during a turn and is null between turns, when a stray tool call is refused;
//  - argv is the process's own for its life (conversation, model, effort, full access, work folder: modeOf): a message that wants
//    another ends the idle process and starts the right one.
// prewarm() (antigravity.js prepare(), while the page is read) starts it before its message: for a chat that already has a
// conversation it is resumed (--conversation); for a new chat the process is a spare its first message takes.
// Processes end when idle for idleMs (the same choice as Grok Build's and Codex's), past MAX_PROCS (the least recently used idle one
// goes), when the chat's tab closes or the chat is deleted (ai-agents.js chatGone), and when Lumen quits. agy's stream input has no
// interrupt ("stream input message event %q is not supported yet"), so Stop and "Send now" end the process; the next message
// starts one again and resumes the conversation.
//
// ISOLATION is a one-message run's (antigravity.js header): the same settings.json, hooks, environment, working folder, stream check
// (offToolOf) and watchdog. Images are files in Lumen's folder named in the message, allowed to agy's view_file for that turn only
// (the gate's reads list is the process's, emptied after each turn).
//
// FALLBACK: anything that goes wrong before a message is answered (the stdio bridge, no chat, a start that fails, a process that
// ends with no output on its first turn, such as an agy without --input-format) makes run() return null, and the message goes
// through a one-message `agy -p` instead. Two such failures in a row: this agy gets one-message runs only until Lumen restarts.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ag = require('../ai/antigravity');
const { helperRows } = require('../ai/agy-tools');

const IDLE_MS = 15 * 60 * 1000;
const SPARE_IDLE_MS = 3 * 60 * 1000; // a process started ahead of a message nobody sent yet
const MAX_PROCS = 4;
const QUIT_GRACE_MS = 2000; // stdin closed: time to flush its conversation before the process is killed
const EXIT_WAIT_MS = 8000; // a start in the same home waits this long at most for an ending process
const FAILURES_BEFORE_GIVING_UP = 2;
const SAFE_SESSION = /^[A-Za-z0-9_.-]{1,128}$/;

// The argv-relevant choices a kept process is for.
const modeOf = ({ fullAccess = false, model = 'default', effort = '', workDir = '' } = {}) => JSON.stringify([fullAccess === true, String(model || 'default'), String(effort || ''), String(workDir || '')]);
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
const bounded = (promise, ms = EXIT_WAIT_MS) => Promise.race([promise, sleep(ms)]);

// engine: the sidebar's AntigravityEngine (prepare, outcome, spawn, kill, home, dir, watch, watchdogMs, onFresh).
// enabled(): the feature (and Antigravity in use). idleMs(): ms an idle process is kept (0: until the chat goes).
function createAgyWarm({ engine, enabled = () => true, idleMs = () => IDLE_MS, spareIdleMs = SPARE_IDLE_MS, maxProcs = MAX_PROCS, quitGraceMs = QUIT_GRACE_MS, exitWaitMs = EXIT_WAIT_MS, toolsMissing = null }) {
  const procs = new Set(); // kept processes
  const pending = new Set(); // starts in flight: { key, mode, wanted, spare, promise, proc, cancelled }
  const exits = new Map(); // chat key -> Set of promises of its processes that are ending
  const stats = { spawned: 0, reused: 0, fallbacks: 0, prewarmed: 0, toolRestarts: 0 };
  let used = 0;
  let failures = 0;

  const live = (p) => p && !p.exited && !p.disposed;
  const mine = (p, { key, mode, sessionId, resume }) => p.key === key && p.mode === mode && (resume ? !p.spare && (p.conversation || p.wanted) === sessionId : p.spare);

  function idleLater(p, ms) {
    clearTimeout(p.idle);
    p.idle = null;
    if (!ms) return;
    p.idle = setTimeout(() => dispose(p), ms);
    p.idle.unref?.();
  }

  // The process is over: its token file (if no newer run of the chat replaced it) and its sign-in copy-back.
  function cleanup(p) {
    if (p.cleaned) return p.cleanedP;
    p.cleaned = true;
    const { mcpFile, mcpText } = p;
    p.cleanedP = (async () => {
      if (mcpFile && mcpText) { try { if (await fs.promises.readFile(mcpFile, 'utf8') === mcpText) await fs.promises.rm(mcpFile, { force: true }); } catch { /* gone */ } }
      await ag.returnAuth({ mainHome: engine.home, home: p.home });
    })().catch(() => {});
    return p.cleanedP;
  }
  // The process has exited and its files are dealt with (at most exitWaitMs).
  const over = (p) => bounded(p.exitedP.then(() => p.cleanedP), exitWaitMs);

  // Ends a process. Resolves when it has exited (at most exitWaitMs).
  function dispose(p, { now = false } = {}) {
    if (!p) return Promise.resolve();
    if (!p.disposed) {
      p.disposed = true;
      procs.delete(p);
      clearTimeout(p.idle);
      if (!p.child) { try { p.gate?.close(p.tag); } catch { /* closed */ } return cleanup(p); }
      if (!p.exited) {
        if (now) engine.kill(p.child);
        else {
          try { p.child.stdin?.end(); } catch { /* gone */ } // agy: "stream input closed after %d turn(s)", then it exits
          const t = setTimeout(() => { if (!p.exited) engine.kill(p.child); }, quitGraceMs);
          t.unref?.();
        }
      }
      const gone = over(p);
      if (!exits.has(p.key)) exits.set(p.key, new Set());
      exits.get(p.key).add(gone);
      gone.then(() => { exits.get(p.key)?.delete(gone); });
    } else if (p.child && !p.exited && now) engine.kill(p.child);
    return p.child ? over(p) : Promise.resolve(p.cleanedP);
  }

  // Over MAX_PROCS: the least recently used idle ones go (spares first).
  function trim(keep) {
    const idle = [...procs].filter((p) => p !== keep && !p.busy).sort((a, b) => (a.spare === b.spare ? a.used - b.used : a.spare ? -1 : 1));
    while (procs.size > maxProcs && idle.length) dispose(idle.shift());
  }

  // A new kept process for the chat. Resolves it, or throws (nothing sent).
  async function start({ chatId, sessionId = null, fullAccess = false, model = 'default', effort = '', workDir = '', spare = false, chat = null }, slot = {}) {
    if (process.env.LUMEN_AGY_MCP === 'stdio') throw new Error('stdio bridge');
    const key = ag.chatKey(chatId);
    const prepared = await engine.prepare({ scope: { chatId }, sessionId, fullAccess, warm: false });
    if (!prepared?.bin) throw new Error('not installed');
    const { bin, gate, home, folder } = prepared;
    if (!home || home === engine.home) throw new Error('no chat home');
    // Never two agy processes in one home: one of this chat that is ending (or still busy with a stopped turn) goes first.
    const waits = [...(exits.get(key) || [])];
    for (const q of procs) if (q.key === key && q.busy && q.child) waits.push(over(q));
    await Promise.all(waits);
    if (workDir) { try { if (!(await fs.promises.stat(workDir)).isDirectory()) workDir = ''; } catch { workDir = ''; } }
    const tag = crypto.randomBytes(18).toString('hex');
    const reads = []; // [engine parity] the files agy may view (agy-tools.js ownFileOk): this turn's images only
    const p = { tag, gate, key, mode: slot.mode || modeOf({ fullAccess, model, effort, workDir }), full: fullAccess === true, home, wanted: sessionId, conversation: sessionId, spare, busy: false, turns: 0, exited: false, exitCode: null, disposed: false, cleaned: false, idle: null, used: ++used, stderr: '', child: null, exitedP: null, cleanedP: null, onMsg: null, onData: null, rows: null, reads, mcpFile: null, mcpText: null, owner: null };
    p.owner = {
      kind: 'antigravity',
      background: false,
      active: null,
      // [tools] The chat this process serves (the message that started or claimed it): its tool list is read when the process
      // connects, before the turn sets `active`, so features/ai-agents.js runTools takes the chat from here then. A process
      // started without one (a prewarm) lists no chat tools, and toolsMissing replaces it when the chat needs them.
      chat: chat || null,
      owns: (t) => Boolean(t && !p.disposed && !p.exited && t.length === tag.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(tag))),
      callBegin(a = p.owner.active) { if (!a) return; a.tools++; a.inflight++; clearTimeout(a.dog); },
      callEnd(a = p.owner.active) { if (!a) return; a.inflight = Math.max(0, a.inflight - 1); a.arm?.(); },
    };
    slot.proc = p;
    if (slot.cancelled) throw new Error('cancelled');
    const gateRun = gate.open(tag, sessionId || tag, { agy: true, fullAccess: p.full, home, onCall: (m) => p.rows?.call(m), reads });
    try {
      p.mcpFile = path.join(home, '.gemini', 'config', 'mcp_config.json');
      p.mcpText = JSON.stringify(ag.mcpConfig(gateRun));
      await fs.promises.writeFile(p.mcpFile, p.mcpText, { mode: 0o600 }); // this process's token, for its whole life
      if (slot.cancelled) throw new Error('cancelled');
      const argv = ag.buildStreamArgs({ conversation: sessionId, model, fullAccess: p.full, effort, workDir });
      p.child = engine.spawn(bin, argv, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: ag.buildEnv({ home, run: gateRun, fullAccess: p.full }), cwd: p.full ? folder : workDir || folder });
      stats.spawned++;
      p.exitedP = new Promise((resolve) => {
        p.child.on('error', (err) => { p.stderr += `\n${err.message}`; resolve(err.code === 'ENOENT' ? 'ENOENT' : -1); });
        p.child.on('close', (c) => resolve(c));
      });
      p.exitedP.then((c) => { p.exited = true; p.exitCode = c; p.owner.active = null; procs.delete(p); clearTimeout(p.idle); try { gate.close(tag); } catch { /* closed */ } cleanup(p); });
      p.child.stdin?.on?.('error', () => { /* EPIPE: it ended; exitedP says so */ });
      p.child.stderr?.setEncoding?.('utf8');
      p.child.stderr?.on('data', (d) => { p.stderr = (p.stderr + d).slice(-4000); });
      ag.readLines(p.child.stdout, (msg) => p.onMsg?.(msg), () => p.onData?.());
      if (p.disposed) throw new Error('cancelled');
      procs.add(p);
      trim(p);
      return p;
    } catch (err) {
      dispose(p, { now: true });
      if (!p.child) { try { gate.close(tag); } catch { /* closed */ } }
      throw err;
    }
  }

  function starting(opts) {
    const slot = { key: ag.chatKey(opts.chatId), mode: modeOf(opts), wanted: opts.sessionId || null, spare: opts.spare === true, promise: null, proc: null, cancelled: false };
    slot.promise = start(opts, slot).then((p) => { if (opts.claimed) p.busy = true; return p; }).finally(() => pending.delete(slot));
    pending.add(slot);
    return slot.promise;
  }

  // The kept process for this message (claimed: busy), after a prewarm() start of it still in flight. Idle processes of this chat
  // for something else end. null: none.
  async function find(want) {
    const wait = [...pending].find((s) => s.key === want.key && s.mode === want.mode && (want.resume ? s.wanted === want.sessionId : s.spare));
    if (wait) { try { await wait.promise; } catch { /* the caller starts its own */ } }
    let hit = null;
    for (const p of [...procs]) {
      if (p.key !== want.key || !live(p) || p.busy) continue;
      if (!hit && mine(p, want)) { hit = p; continue; }
      dispose(p);
    }
    if (hit) hit.busy = true;
    return hit;
  }

  // One message through the chat's kept process: run()'s result (antigravity.js), or null when it must go through a one-message
  // run instead (nothing was answered then).
  async function run({ chatId, prompt, images = [], sessionId = null, systemPrompt, model = 'default', signal, emit, runAgent = null, scope = null, fullAccess = false, effort = '', workDir = '' }) {
    if (!enabled()) { disposeAll(); return null; }
    if (chatId == null || failures >= FAILURES_BEFORE_GIVING_UP || process.env.LUMEN_AGY_MCP === 'stdio') { stats.fallbacks++; return null; }
    fullAccess = fullAccess === true;
    const resume = Boolean(sessionId) && SAFE_SESSION.test(sessionId);
    const want = { key: ag.chatKey(chatId), mode: modeOf({ fullAccess, model, effort, workDir }), sessionId: resume ? sessionId : null, resume };
    let p = await find(want);
    // [tools] A kept process listed Lumen's tools once, when it connected (a prewarm at composer focus, before the chat was about Word): a
    // chat that has since turned to a Word document (or got the desktop, project or connector tool) found the word tool missing ("The Word
    // tool was unavailable"). That process goes and a new one resumes the same thread with the full list, as Claude Code does (#914;
    // features/ai-agents.js toolsMissing).
    if (p && toolsMissing?.(p.tag, scope?.chat)) { p.busy = false; dispose(p); stats.toolRestarts++; p = null; }
    if (p && scope?.chat) p.owner.chat = scope.chat; // [tools] (a reused process: the chat object of this message)
    if (p) stats.reused++;
    else {
      try { p = await starting({ chatId, sessionId: want.sessionId, fullAccess, model, effort, workDir, claimed: true, chat: scope?.chat }); } catch { failures++; stats.fallbacks++; return null; }
    }
    p.spare = false;
    p.used = ++used;
    clearTimeout(p.idle);
    if (signal.aborted) { p.busy = false; idleLater(p, idleMs()); return { text: '', sessionId, stopped: true }; }
    const out = await turn(p, { prompt, images, systemPrompt, resume, sessionId: want.sessionId, signal, emit, runAgent, scope });
    p.busy = false;
    if (out === null) { failures++; stats.fallbacks++; await dispose(p, { now: true }); return null; }
    failures = 0;
    if (out.keep && live(p)) idleLater(p, idleMs());
    else dispose(p, { now: true });
    delete out.keep;
    return out;
  }

  // One turn: the message as a stdin line, its events until the `result` event. keep: whether the process may stay.
  async function turn(p, { prompt, images, systemPrompt, resume, sessionId, signal, emit, runAgent, scope }) {
    const { tag } = p;
    const fresh = p.turns === 0;
    if (fresh) { try { engine.onFresh?.({ sessionId, resume }); } catch { /* optional */ } }
    p.turns++;
    const active = { tag, emit, signal, child: p.child, agent: runAgent, scope, tools: 0, inflight: 0, dog: null, arm: null };
    p.owner.active = active;
    try { p.gate.rearm?.(tag); if (p.conversation) p.gate.bindChat?.(tag, p.conversation); } catch { /* optional */ }
    const rows = p.full ? helperRows(emit) : null; // [helpers] (antigravity.js run)
    rows?.parent(p.conversation);
    p.rows = rows;
    const watchdogMs = p.full && engine.watchdogMs ? Math.max(engine.watchdogMs, ag.FULL_WATCHDOG_MS) : engine.watchdogMs;
    let over = false;
    let stalled = false;
    let sawOutput = false;
    let finish;
    const ended = new Promise((resolve) => { finish = resolve; });
    const kill = () => { try { engine.kill(p.child); } catch { /* gone */ } };
    active.arm = () => {
      clearTimeout(active.dog);
      if (!watchdogMs || over || active.inflight > 0) return;
      active.dog = setTimeout(() => { stalled = true; kill(); }, watchdogMs);
    };
    const reader = ag.turnReader({ emit, sessionId: p.conversation || sessionId, watch: engine.watch !== false && !p.full, home: p.home, reads: p.reads, rows, stop: () => { kill(); finish('off'); } });
    p.onData = () => { sawOutput = true; active.arm(); };
    p.onMsg = (msg) => { if (over) return; reader.handle(msg); if (msg?.event === 'result') finish('result'); };
    const onAbort = () => kill(); // no stream-input interrupt in agy: Stop ends the process
    signal.addEventListener('abort', onAbort, { once: true });
    p.exitedP.then(() => finish('exit'));
    const files = [];
    if (fresh) emit({ type: 'status', text: 'Starting Antigravity…' });
    try {
      const imageFiles = [];
      for (const [i, img] of ag.capImages(images, emit).entries()) {
        const f = path.join(engine.dir, `lumen-image-${tag.slice(0, 8)}-${p.turns}-${i}.${ag.EXT[img.media_type]}`);
        await fs.promises.mkdir(engine.dir, { recursive: true });
        await fs.promises.writeFile(f, Buffer.from(img.data, 'base64'), { mode: 0o600 });
        files.push(f);
        imageFiles.push(f);
        p.reads.push(f);
      }
      // (no PROMPT_ARG_MAX file: stdin has no command-line limit)
      const text = ag.promptFor({ prompt, systemPrompt, resume, imageFiles });
      active.arm();
      if (signal.aborted) onAbort();
      else if (!p.exited) p.child.stdin.write(ag.streamLine(text));
      await ended;
    } finally {
      over = true;
      p.onMsg = null;
      p.onData = null;
      clearTimeout(active.dog);
      signal.removeEventListener('abort', onAbort);
      if (p.owner.active === active) p.owner.active = null;
      rows?.finish();
      p.rows = null;
      for (const f of files) { const i = p.reads.indexOf(f); if (i >= 0) p.reads.splice(i, 1); }
      await Promise.all(files.map((f) => fs.promises.rm(f, { force: true }).catch(() => {})));
    }
    ag.returnAuth({ mainHome: engine.home, home: p.home }).catch(() => {}); // a sign-in agy refreshed during the turn
    // The process ended on its first turn with no output at all (an agy without --input-format, a start that failed): nothing was
    // answered, so the message goes through a one-message run, which says what is wrong.
    if (p.exited && fresh && !sawOutput && !signal.aborted && !stalled) return null;
    const out = engine.outcome({ st: reader.st, code: p.exited ? p.exitCode : null, stderr: p.stderr, signal, stalled, watchdogMs, fullAccess: p.full, emit });
    if (out.sessionId) { p.conversation = out.sessionId; try { p.gate.bindChat?.(tag, out.sessionId); } catch { /* optional */ } }
    out.keep = !p.exited && !signal.aborted && !stalled && !reader.st.offTool && Boolean(reader.st.result) && out.sessionId != null;
    return out;
  }

  // Start the chat's process ahead of its message. spec: { chatId, sessionId (null: a new chat), fullAccess, model, effort, workDir }.
  // true when a start began.
  function prewarm(spec) {
    if (!enabled() || spec?.chatId == null || failures >= FAILURES_BEFORE_GIVING_UP || process.env.LUMEN_AGY_MCP === 'stdio') return false;
    const resume = Boolean(spec.sessionId) && SAFE_SESSION.test(spec.sessionId);
    const want = { key: ag.chatKey(spec.chatId), mode: modeOf(spec), sessionId: resume ? spec.sessionId : null, resume };
    const kept = [...procs].find((p) => live(p) && mine(p, want));
    if (kept || [...pending].some((s) => s.key === want.key && s.mode === want.mode && (resume ? s.wanted === want.sessionId : s.spare))) {
      if (kept && !kept.busy) { kept.used = ++used; idleLater(kept, kept.spare ? spareIdleMs : idleMs()); }
      return false;
    }
    if ([...procs].some((p) => p.key === want.key && p.busy)) return false; // a message of this chat is running: run() decides after it
    for (const p of [...procs]) if (p.key === want.key && !p.busy) dispose(p); // another conversation or other flags: it goes
    stats.prewarmed++;
    starting({ chatId: spec.chatId, sessionId: want.sessionId, fullAccess: spec.fullAccess === true, model: spec.model || 'default', effort: spec.effort || '', workDir: spec.workDir || '', spare: !resume })
      .then((p) => { if (!p.busy) idleLater(p, p.spare ? spareIdleMs : idleMs()); })
      .catch(() => {});
    return true;
  }

  // The chat is gone, or a one-message run is about to use its home: its idle process ends. Resolves when it has exited.
  function dropChat(chatId) {
    if (chatId == null) return Promise.resolve();
    const key = ag.chatKey(chatId);
    const waits = [];
    for (const p of [...procs]) if (p.key === key && !p.busy) waits.push(dispose(p, { now: true }));
    for (const s of pending) if (s.key === key) { s.cancelled = true; if (s.proc) waits.push(dispose(s.proc, { now: true })); }
    return Promise.all(waits).then(() => {});
  }

  // The feature went off, or Lumen quits (now: no grace).
  function disposeAll({ now = false } = {}) {
    for (const p of [...procs]) if (!p.busy || now) dispose(p, { now });
    for (const s of pending) { s.cancelled = true; if (s.proc) dispose(s.proc, { now: true }); }
  }

  const count = () => procs.size + pending.size;
  const settled = () => pending.size === 0;
  // The owner of an MCP tag among the kept processes, starting ones included (ai-agents.js engineForSession).
  const owner = (tag) => {
    if (!tag) return null;
    for (const p of procs) if (p.owner?.owns(tag)) return p.owner;
    for (const s of pending) if (s.proc?.owner?.owns(tag)) return s.proc.owner;
    return null;
  };

  return { run, prewarm, dropChat, disposeAll, count, settled, owner, stats };
}

module.exports = { createAgyWarm, modeOf, IDLE_MS, MAX_PROCS, SPARE_IDLE_MS };
