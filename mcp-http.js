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
// Resolves once listening, with open(tag, chatSessionId) -> { mcpUrl, mcpToken, hookUrl }, close(tag),
// armed(tag), listed(tag), allowed(tag), denied(tag), port and stop().
function startHttp({ tools, callTool, enabled = () => true, onEvent = () => {}, onTerminalApproval = null, holdMs = 8000, terminalHoldMs = 20000 }) {
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

  // One MCP session per run (Grok opens one per grok process), answered request by request.
  function mcpSession(run) {
    if (run.session) return run.session;
    const pending = new Map();
    const s = createSession({ tools, callTool, enabled, onEvent, engine: run.tag, send: (msg) => { const done = pending.get(msg.id); if (done) { pending.delete(msg.id); done(msg); } } });
    run.session = { ...s, pending };
    return run.session;
  }

  // UserPromptSubmit: hold the answer (up to holdMs) until Grok has listed Lumen's tools, so the
  // model call that follows has them.
  async function armed(run) {
    run.armed = true;
    const until = Date.now() + holdMs;
    while (!run.session?.session.listed && Date.now() < until && runs.has(run.tag)) await new Promise((r) => setTimeout(r, 50));
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
      let msg = null;
      try { msg = JSON.parse(body); } catch {}
      if (hookToken) {
        // Always a 200 with a decision: anything but an explicit deny would let the call through.
        const run = byHook(hookToken);
        const event = String(msg?.hook_event_name || msg?.hookEventName || '');
        if (!run) return json(200, DENY('This Grok run has ended.'));
        if (/^user_?prompt_?submit$/i.test(event)) return json(200, await armed(run));
        if (/^pre_?tool_?use$/i.test(event)) {
          const name = msg?.toolName ?? msg?.tool_name;
          const verdict = String(name) === 'run_terminal_command' ? await terminalDecision(run, msg) : gateDecision(name, toolNames());
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
      const answer = new Promise((resolve) => session.pending.set(msg.id, resolve));
      await session.handle(msg);
      const out = await Promise.race([answer, new Promise((r) => setTimeout(() => r(null), 10))]) || (session.pending.delete(msg.id), { jsonrpc: '2.0', id: msg.id, result: {} });
      return json(200, out);
    });
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve({
        port,
        open(tag, chatSessionId = null) {
          const run = { tag, chatSessionId, mcpToken: crypto.randomBytes(24).toString('hex'), hookToken: crypto.randomBytes(24).toString('hex'), armed: false, allowed: [], denied: [], session: null };
          runs.set(tag, run);
          return { mcpUrl: `http://127.0.0.1:${port}/mcp`, mcpToken: run.mcpToken, hookUrl: `http://127.0.0.1:${port}/hook/${run.hookToken}` };
        },
        close(tag) {
          const run = runs.get(tag);
          runs.delete(tag);
          if (run?.session) { run.session.close(); onEvent({ type: 'session', active: false, clientName: run.session.session.clientName, engine: tag }); }
        },
        armed: (tag) => Boolean(runs.get(tag)?.armed),
        listed: (tag) => Boolean(runs.get(tag)?.session?.session.listed),
        allowed: (tag) => [...(runs.get(tag)?.allowed || [])],
        denied: (tag) => [...(runs.get(tag)?.denied || [])],
        sessions: () => [...runs.values()].filter((r) => r.session).map((r) => r.session),
        stop: () => server.close(),
      });
    });
  });
}

module.exports = { startHttp, gateDecision };
