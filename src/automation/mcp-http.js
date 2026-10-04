// Lumen's MCP server and tool gate over local HTTP, for the sidebar's Grok Build engine
// (grok-build.js) and Claude Code engine (claude-code.js, MCP only: a token per CLI process, no hooks).
// Both connect to Lumen directly (no bridge process to start, so Lumen's tools are up before the
// first model call), and Grok asks Lumen about every tool call before running it.
//
//  - POST /mcp: MCP over streamable HTTP, one JSON-RPC message per request, answered as plain JSON
//    (no SSE stream: Lumen's tools answer once). `Authorization: Bearer <run token>`; the token names
//    the run (its tag, as LUMEN_ENGINE does for a bridge), and so the chat whose approvals apply.
//  - POST /hook/<hook token>: Grok's UserPromptSubmit and PreToolUse hooks (a small curl script in
//    Lumen's GROK_HOME forwards them here, see grok-build.js grokConfig). PreToolUse is allowed only
//    for search_tool and lumen__<one of Lumen's tools>; anything else, an unknown token included, is
//    denied. UserPromptSubmit marks the run as guarded ("armed"): grok-build.js stops any run whose
//    model output starts before that, so a Grok that didn't load the hooks never gets to call a tool.
//
// Listens on 127.0.0.1 only. Requests with an Origin header (a web page) or another Host (DNS
// rebinding) are refused, and every token is random per run and dropped when the run ends.
const crypto = require('crypto');
const http = require('http');
const { createSession } = require('./mcp');
const { AGY_LUMEN_PREFIX, agyAllowed } = require('../ai/agy-tools'); // the allowlist antigravity.js (offToolOf) shares

const MAX_BODY = 1024 * 1024;
const same = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const DENY = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason }, decision: 'deny', reason });

// The gate's rule for one PreToolUse event. MCP calls show under their qualified name
// (lumen__navigate), not as use_tool; search_tool only searches the catalog, which holds nothing but
// Lumen's tools (config.toml names one server). run_terminal_command is judged separately (below):
// it's the one built-in the user can approve per call, rather than an automatic deny.
function gateDecision(toolName, toolNames) {
  const n = String(toolName || '');
  if (n === 'search_tool') return null;
  const m = /^lumen__([\w-]+)$/.exec(n);
  if (m && toolNames.includes(m[1])) return null;
  return DENY(`Only Lumen's browser tools are allowed here (${n.slice(0, 60) || 'unnamed tool'} is not one of them).`);
}

// [full access] The same rule for a run the user gave full access (Settings > AI > Give Grok Build full access): the CLI's
// own tools (shell, files, its other tools) are the user's to allow, so they pass without a card. Lumen's own tools do
// not get weaker: a name that claims to be Lumen's (lumen__ + anything) is allowed only when it is one of Lumen's tools,
// so the gate still fails closed for them. Lumen's tools themselves are checked again by the MCP server (callTool).
function fullGateDecision(toolName, toolNames) {
  const n = String(toolName || '');
  if (/^lumen__/i.test(n)) return gateDecision(n, toolNames);
  return null;
}

// Best-effort read of the command Grok wants to run, out of whatever field name its PreToolUse
// event happens to use for a tool's input (unverified against a real payload -- there was no running
// Grok Build session to capture one from live; every plausible key is tried, and the raw input is
// shown as JSON if none match, so the approval card never renders blank).
function terminalCommand(msg) {
  const input = msg?.toolInput ?? msg?.tool_input ?? msg?.input ?? msg?.arguments ?? msg?.tool_call?.rawInput ?? msg?.toolCall?.rawInput ?? null;
  if (input == null) return '(Lumen could not read the command Grok wants to run.)';
  if (typeof input === 'string') return input.slice(0, 4000);
  const cmd = input.command ?? input.cmd ?? input.script ?? input.shellCommand ?? input.shell_command;
  if (typeof cmd === 'string') return cmd.slice(0, 4000);
  try { return JSON.stringify(input, null, 2).slice(0, 4000); } catch { return '(Lumen could not read the command Grok wants to run.)'; }
}

// { tools, callTool, enabled, onEvent, onTerminalApproval }: as mcp.js startServer, plus
// onTerminalApproval(tag, command) -> Promise<'once' | 'always' | 'deny'>, asked the first time a run
// (by its Grok chat session, not this one message) calls run_terminal_command; 'always' is remembered
// only for that chat session (chatSessionsAllowed, cleared when Lumen restarts), never persisted.
// Resolves once listening, with open(tag, chatSessionId, { agy, fullAccess }) -> { mcpUrl, mcpToken, hookUrl }, close(tag),
// armed(tag), rearm(tag), bindChat(tag, chatSessionId), listed(tag), allowed(tag), denied(tag), port and stop().
function startHttp({ tools, callTool, enabled = () => true, onEvent = () => {}, onTerminalApproval = null, holdMs = 8000, terminalHoldMs = 20000, keepAliveMs = 120000 }) {
  const runs = new Map(); // tag -> { mcpToken, hookToken, chatSessionId, armed, allowed: [], sessions: Map(id -> session) }
  const chatSessionsAllowed = new Set(); // chatSessionId -> terminal commands approved for the rest of this chat
  let port = 0;
  const byMcp = (token) => [...runs.values()].find((r) => same(token, r.mcpToken));
  const byHook = (token) => [...runs.values()].find((r) => same(token, r.hookToken));
  const toolNames = () => tools.map((t) => t.name);

  // The PreToolUse verdict for run_terminal_command specifically: an automatic allow once this chat
  // has said "always", otherwise held until onTerminalApproval's card is answered (or times out, a
  // deny -- same fail-closed default as an unreachable gate). No onTerminalApproval wired up (a
  // caller that never expects Grok to reach this far): deny, same as before this existed.
  async function terminalDecision(run, msg) {
    if (run.chatSessionId && chatSessionsAllowed.has(run.chatSessionId)) return null;
    if (!onTerminalApproval) return DENY("Lumen isn't set up to approve terminal commands here.");
    const command = terminalCommand(msg);
    let answer;
    try {
      answer = await Promise.race([
        onTerminalApproval(run.tag, command),
        new Promise((r) => setTimeout(() => r('deny'), terminalHoldMs)),
      ]);
    } catch {
      answer = 'deny';
    }
    if (answer === 'always') { if (run.chatSessionId) chatSessionsAllowed.add(run.chatSessionId); return null; }
    if (answer === 'once' || answer === true) return null;
    return DENY('The user did not approve this terminal command.');
  }

  // Antigravity's hooks (antigravity.js hooksFor, agy's hooks.md): PreToolUse posts { toolCall: { name, args } } and reads
  // { decision: allow | deny, reason }, before agy's own permission layer; PreInvocation posts no toolCall and only marks the run as
  // seen. Fail closed, like gateDecision for Grok: only a qualified Lumen MCP tool (AGY_LUMEN_PREFIX + one of Lumen's tool names)
  // or a read (view_file, list_dir) of Lumen's own tool descriptor folder in this chat's home is allowed (ai/agy-tools.js, the
  // allowlist antigravity.js offToolOf shares); every other name (generate_image, invoke_subagent, anything unknown, a "lumen"
  // that is only part of another server's name) and any read outside that folder is denied.
  // UNVERIFIED: agy's real qualified MCP tool names have not been captured from a signed-in run. Run one signed-in `agy` turn
  // with LUMEN_AGY_DEBUG set; if Lumen's tools are denied, add the real prefix form to AGY_LUMEN_PREFIX in agy-tools.js.
  // [full access] A run the user gave full access (antigravity.js FULL_FLAGS): the CLI's own tools are allowed, but a name
  // in the form of one of Lumen's (AGY_LUMEN_PREFIX) must still be one of Lumen's real tools: the gate stays closed for those.
  function agyDecision(run, msg) {
    if (!msg?.toolCall) { run.armed = true; return {}; }
    const name = String(msg.toolCall.name || '');
    const m = AGY_LUMEN_PREFIX.exec(name);
    if (run.fullAccess && !m && !/^(?:mcp[_-]{1,2})?lumen/i.test(name)) return { decision: 'allow' };
    if (agyAllowed({ name, args: msg.toolCall.args, home: run.home, toolNames: toolNames() })) return { decision: 'allow' };
    return { decision: 'deny', reason: `Only Lumen's browser tools are allowed here (${name.slice(0, 60) || 'unnamed tool'} is not one of them).` };
  }

  // One MCP session per run (Grok opens one per grok process), answered request by request.
  function mcpSession(run) {
    if (run.session) return run.session;
    const pending = new Map();
    const s = createSession({ tools, callTool, enabled, onEvent, engine: run.tag, onListed: () => wake(run), send: (msg) => { const done = pending.get(msg.id); if (done) { pending.delete(msg.id); done(msg); } } });
    run.session = { ...s, pending };
    return run.session;
  }

  // UserPromptSubmit: hold the answer (up to holdMs) until Grok has listed Lumen's tools, so the
  // model call that follows has them.
  // Event-driven: woken when the session lists the tools (onListed) or the run closes, else after holdMs.
  const wake = (run) => { const waiting = run.waiters; run.waiters = new Set(); for (const w of waiting) w(); };
  async function armed(run) {
    run.armed = true;
    if (run.session?.session.listed || !runs.has(run.tag)) return {};
    let timer;
    await new Promise((resolve) => { run.waiters.add(resolve); timer = setTimeout(resolve, holdMs); });
    clearTimeout(timer);
    return {};
  }

  const server = http.createServer((req, res) => {
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${port}`) { req.resume(); return json(403); }
    const hookToken = /^\/hook\/([a-f0-9]{48})$/.exec(req.url || '')?.[1];
    if (req.url !== '/mcp' && !hookToken) { req.resume(); return json(404); }
    if (req.method !== 'POST') { req.resume(); return json(405); }
    let body = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { req.destroy(); return; } body += c; });
    req.on('end', async () => {
      try {
        await handleBody();
      } catch (err) {
        // A rejected handler must not leave the request hanging (or reach the global unhandledRejection logger).
        if (!res.headersSent) json(500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
        else res.end();
        console.error('MCP http:', err?.message || err);
      }
    });
    async function handleBody() {
      let msg = null;
      try { msg = JSON.parse(body); } catch {}
      if (hookToken) {
        // Always a 200 with a decision: anything but an explicit deny would let the call through.
        const run = byHook(hookToken);
        const event = String(msg?.hook_event_name || msg?.hookEventName || '');
        if (!run) return json(200, DENY('This Grok run has ended.'));
        if (run.agy) return json(200, agyDecision(run, msg));
        if (/^user_?prompt_?submit$/i.test(event)) return json(200, await armed(run));
        if (/^pre_?tool_?use$/i.test(event)) {
          const name = msg?.toolName ?? msg?.tool_name;
          const verdict = run.fullAccess ? fullGateDecision(name, toolNames()) : String(name) === 'run_terminal_command' ? await terminalDecision(run, msg) : gateDecision(name, toolNames());
          (verdict ? run.denied : run.allowed).push(String(name));
          return json(200, verdict || undefined);
        }
        return json(200, {});
      }
      const run = byMcp(/^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1]);
      if (!run) return json(401);
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      const session = mcpSession(run);
      const isRequest = msg.id !== undefined && msg.id !== null;
      if (!isRequest) { session.handle(msg); return json(202); }
      // handle() replies (through send) before it returns, so nothing needs to wait for the answer afterwards.
      let answer = null;
      session.pending.set(msg.id, (m) => { answer = m; });
      await session.handle(msg);
      session.pending.delete(msg.id);
      return json(200, answer || { jsonrpc: '2.0', id: msg.id, result: {} });
    }
  });
  // Node's default keep-alive (5 s) closes a socket the CLI reuses after the model has thought for longer: the next tool
  // call hit ECONNRESET. Answers are plain JSON (no SSE), so the per-request limits stay at their defaults.
  server.keepAliveTimeout = keepAliveMs;
  server.headersTimeout = keepAliveMs + 5000; // must exceed keepAliveTimeout
  server.on('clientError', (_err, socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve({
        port,
        open(tag, chatSessionId = null, { agy = false, fullAccess = false, home = null } = {}) {
          const run = { tag, chatSessionId, agy, home, fullAccess: fullAccess === true, mcpToken: crypto.randomBytes(24).toString('hex'), hookToken: crypto.randomBytes(24).toString('hex'), armed: false, waiters: new Set(), allowed: [], denied: [], session: null };
          runs.set(tag, run);
          return { mcpUrl: `http://127.0.0.1:${port}/mcp`, mcpToken: run.mcpToken, hookUrl: `http://127.0.0.1:${port}/hook/${run.hookToken}` };
        },
        close(tag) {
          const run = runs.get(tag);
          runs.delete(tag);
          if (run) wake(run);
          if (run?.session) { run.session.close(); onEvent({ type: 'session', active: false, clientName: run.session.session.clientName, engine: tag }); }
        },
        armed: (tag) => Boolean(runs.get(tag)?.armed),
        // A kept Grok process (features/grok-warm.js) keeps its run for many messages: each message must arm it again
        // (its own UserPromptSubmit), and the chat session it serves is known only once its session exists.
        rearm(tag) { const run = runs.get(tag); if (run) run.armed = false; },
        bindChat(tag, chatSessionId) { const run = runs.get(tag); if (run && chatSessionId) run.chatSessionId = chatSessionId; },
        listed: (tag) => Boolean(runs.get(tag)?.session?.session.listed),
        allowed: (tag) => [...(runs.get(tag)?.allowed || [])],
        denied: (tag) => [...(runs.get(tag)?.denied || [])],
        sessions: () => [...runs.values()].filter((r) => r.session).map((r) => r.session),
        stop: () => server.close(),
      });
    });
  });
}

module.exports = { startHttp, gateDecision, fullGateDecision };
