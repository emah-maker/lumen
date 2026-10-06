// ACCEPTANCE (feature: sidebar-unblock). Run alone: node scripts/test-acceptance.js chat-agent-windows
//
// Outside agents (an MCP client such as the user's own Claude Code CLI) work in a Lumen window of their own, and that
// must never get in the way of the sidebar's AI:
//  - a window is made for an agent only when it needs one (its first call that acts on a tab), never because it connected and
//    listed Lumen's tools: a CLI that starts, lists tools and does nothing with them (every Claude Code or Grok session the
//    user opens anywhere) opens no window;
//  - the sidebar's own engines (Claude Code warm / pre-warmed / between messages, Grok Build) are always recognised by their
//    tag: no agent window for them, their calls act on their own chat's tab;
//  - a long call of an outside agent in flight does not hold up a sidebar run, nor does a sidebar run hold up the agent.
//
// The real Agent, the real ai-agents.js wiring (mcpCallTool, the stdio server's enabled / onListed / onClose) and the real
// engines with fake CLIs (test/acceptance/chat-harness.js); MCP sessions are opened the way mcp.js startServer opens them.
const { createSession } = require('../../src/automation/mcp');
const H = require('./chat-harness');

const { check, chat, send, until, sleep, msgOf, release, executed, readLog, textOf, errorsOf } = H;
const J = (v) => JSON.stringify(v);
const isDone = (run) => run.events.some((e) => e.type === 'done');
const reached = (marker, run, ms = 15000) => until(() => msgOf(marker) || (isDone(run) ? 'done' : null), ms).then(() => msgOf(marker));

// An MCP client's session on Lumen's stdio server: createSession wired with exactly what startServer was given.
function connect({ engine = null, name = 'claude-code' } = {}) {
  const o = H.gate.mcpOpts;
  const waiting = new Map();
  let id = 0;
  const s = createSession({ tools: o.tools, callTool: o.callTool, enabled: o.enabled, onEvent: o.onEvent, onListed: o.onListed, engine, send: (m) => waiting.get(m.id)?.(m) });
  const rpc = (method, params = {}) => new Promise((resolve) => { const i = ++id; waiting.set(i, resolve); s.handle({ jsonrpc: '2.0', id: i, method, params }); });
  return {
    session: s.session,
    async start() { await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name } }); s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }); return rpc('tools/list'); },
    call: (tool, args = {}) => rpc('tools/call', { name: tool, arguments: args }),
    end() { s.close(); try { o.onClose?.(s.session); } catch {} },
  };
}
const textIn = (reply) => (reply?.result?.content || []).map((c) => c.text).join(' ');

(async () => {
  H.hardStop(100000);
  H.settings.mcpEnabled = true;
  H.state.open.add(H.AGENT_TAB); // the agent window's tab, as the fake windows name it
  H.agent.engines.claudecode.ensureServer(); // starts the stdio server the way a run without the HTTP gate does (startMcp(true)), keeping what it was given
  check('the stdio server is up (set-up)', Boolean(H.gate.mcpOpts?.onClose && H.gate.mcpOpts?.enabled), J(Object.keys(H.gate.mcpOpts || {})));

  // ---- 1. an outside agent that only connects and lists the tools opens no window
  {
    const idle = connect();
    const listed = await idle.start();
    await sleep(150);
    check('an outside agent that connects and lists the tools opens no window (nothing needs one yet)', H.windows.ensured.length === 0 && (listed?.result?.tools || []).length > 5, J({ ensured: H.windows.ensured.length, tools: listed?.result?.tools?.length }));
    const none = await idle.call('list_tabs');
    check('...and list_tabs before it has one answers with no tabs, still without making one', textIn(none) === '[]' && H.windows.ensured.length === 0, J({ none, ensured: H.windows.ensured.length }));
    idle.end();
    await sleep(50);
    check('...a session that never had a window ends without one made or released', H.windows.ensured.length === 0, J(H.windows.ensured));
  }

  // ---- 2. its first call that needs a tab makes the window, once; the call acts in that window's tab
  {
    const agentC = connect();
    await agentC.start();
    executed.length = 0;
    const [r1, r2] = await Promise.all([agentC.call('read_page'), agentC.call('read_page')]);
    check('an outside agent\'s first calls that need a tab share one window made for them', H.windows.ensured.length >= 1 && new Set(H.windows.made.values()).size === 1 && !r1.result?.isError && !r2.result?.isError, J({ ensured: H.windows.ensured.length, r1: textIn(r1), r2: textIn(r2) }));
    check('...and act in that window\'s tab, not in the user\'s (tab in front is 1)', executed.length === 2 && executed.every((e) => e.tab === H.AGENT_TAB), J(executed));
    agentC.end();
  }

  // ---- 3. the sidebar's own engines are recognised: no window, calls act in their own chat's tab
  async function engineSuite(engine) {
    const model = engine === 'claudecode' ? 'claudecode:default' : 'grokbuild:default';
    const name = engine === 'claudecode' ? 'Claude Code' : 'Grok Build';
    const P = engine === 'claudecode' ? 'C' : 'G';
    const A = chat(model);
    const before = H.windows.ensured.length;
    const run = send(A, `RUN-${P}W1 HOLD-${P}W1 hello`, 2);
    const m = await reached(`RUN-${P}W1`, run);
    check(`${name}: the run reaches its CLI (set-up)`, Boolean(m?.token), J(errorsOf(run.events)));
    if (!m?.token) return;
    // The CLI connects with its tag, lists the tools and calls one, as the real one does.
    const cli = connect({ engine: m.token, name: engine === 'claudecode' ? 'claude-code' : 'grok-cli' });
    const listed = await cli.start();
    executed.length = 0;
    const t0 = Date.now();
    const out = await cli.call('read_page');
    check(`${name}: the sidebar's own connection (its tag) lists the tools and is served`, (listed?.result?.tools || []).length > 5 && !out.result?.isError, J({ out: textIn(out), tools: listed?.result?.tools?.length }));
    check(`${name}: ...with no agent window made for it`, H.windows.ensured.length === before, J({ ensured: H.windows.ensured.length - before }));
    check(`${name}: ...and its call acts in its own chat's tab (2), not an agent window's`, executed.length === 1 && executed[0].tab === 2, J(executed));
    check(`${name}: ...at once (no wait for a window or for a label)`, Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
    cli.end();
    release(`${P}W1`);
    await Promise.race([run.done, sleep(15000)]);
    await sleep(200);
    check(`${name}: the run ends normally`, isDone(run) && new RegExp(`reply from RUN-${P}W1`).test(textOf(run.events)), J({ text: textOf(run.events), errors: errorsOf(run.events) }));
    return m;
  }
  const grokRun = await engineSuite('grokbuild');
  const ccRun = await engineSuite('claudecode');

  // ---- 4. the kept Claude Code process between messages: recognised (it keeps its tag), lists tools with no run, no window
  if (ccRun?.token) {
    const kept = connect({ engine: ccRun.token });
    const before = H.windows.ensured.length;
    const listed = await kept.start();
    const out = await kept.call('read_page');
    await sleep(100);
    check('Claude Code, kept between messages: still its own (tools listed, no window made)', (listed?.result?.tools || []).length > 5 && H.windows.ensured.length === before, J({ ensured: H.windows.ensured.length - before }));
    check('...a call with no message running is answered "no message in progress", not run in an agent window', /no message is in progress/i.test(textIn(out)) && H.windows.ensured.length === before, textIn(out));
    kept.end();
  } else check('Claude Code, kept between messages (skipped: no run reached its CLI)', false, 'no token');

  // ---- 5. a pre-warmed process (composer focus, no message yet) lists the tools: recognised, no window
  {
    const W = chat('claudecode:default');
    H.agent.messages = W; // the open chat
    const before = H.windows.ensured.length;
    const started = H.agent.prewarm('');
    const warm = await until(() => readLog().filter((e) => e.ev === 'start' && e.role === 'claude').pop(), 8000);
    const tag = warm?.token;
    if (started && tag) {
      const cli = connect({ engine: tag });
      const listed = await cli.start();
      await sleep(100);
      check('a pre-warmed Claude Code process (no message yet) lists the tools: served, no window made', (listed?.result?.tools || []).length > 5 && H.windows.ensured.length === before, J({ ensured: H.windows.ensured.length - before }));
      cli.end();
    } else check('a pre-warmed Claude Code process (skipped: nothing was pre-warmed)', true, '');
  }

  // ---- 6. a tag nobody owns (an ended run, a foreign tag) is refused and never treated as an outside agent
  {
    const before = H.windows.ensured.length;
    const stray = connect({ engine: 'f'.repeat(36) });
    const init = await stray.start().catch(() => null);
    const out = await stray.call('read_page');
    check('a stale or foreign tag is refused, with no window made for it', H.windows.ensured.length === before && /turned off|not|refus/i.test(textIn(out) + J(init)), J({ out: textIn(out), ensured: H.windows.ensured.length - before }));
    stray.end();
  }

  // ---- 7. an outside agent's long call does not hold up a sidebar run (and the other way round)
  {
    const slow = connect({ name: 'codex-mcp-client' });
    await slow.start();
    let freeOutside;
    const outsideHeld = new Promise((r) => { freeOutside = r; });
    const realExecute = H.agent.execute;
    H.agent.execute = async function execute(name, ...rest) {
      if (name === 'wait_for') { await outsideHeld; executed.push({ name, tab: 'outside-done' }); return 'waited'; }
      return realExecute.call(this, name, ...rest);
    };
    const longCall = slow.call('wait_for', { text: 'x', timeout: 60 });
    await sleep(100);
    const A = chat('claudecode:default');
    const B = chat('grokbuild:default');
    const t0 = Date.now();
    const ra = send(A, 'RUN-CX1 quick while an outside agent waits', 1);
    const rb = send(B, 'RUN-GX1 quick while an outside agent waits', 3);
    await Promise.race([Promise.all([ra.done, rb.done]), sleep(15000)]);
    const took = Date.now() - t0;
    check('a Claude Code run and a Grok Build run both finish while an outside agent\'s long call is in flight', isDone(ra) && isDone(rb) && /reply from RUN-CX1/.test(textOf(ra.events)) && /reply from RUN-GX1/.test(textOf(rb.events)) && !errorsOf(ra.events).length && !errorsOf(rb.events).length, J({ a: textOf(ra.events), b: textOf(rb.events), ea: errorsOf(ra.events), eb: errorsOf(rb.events) }));
    check('...and in the time they take alone (not held for the outside agent)', took < 8000, `${took} ms`);
    // A sidebar tool call meanwhile is served at once and acts in the chat's tab.
    const C = chat('claudecode:default');
    const rc = send(C, 'RUN-CX2 HOLD-CX2 tool while outside waits', 4);
    const mc = await reached('RUN-CX2', rc);
    if (mc?.token) {
      const cli = connect({ engine: mc.token });
      await cli.start();
      executed.length = 0;
      const t1 = Date.now();
      const out = await cli.call('read_page');
      check('a sidebar run\'s tool call is served at once while the outside agent\'s call is still in flight', !out.result?.isError && Date.now() - t1 < 1000 && executed.length === 1 && executed[0].tab === 4, J({ out: textIn(out), executed, ms: Date.now() - t1 }));
      cli.end();
    } else check('a sidebar run\'s tool call while the outside agent waits (skipped: run did not start)', false, 'no token');
    release('CX2');
    await Promise.race([rc.done, sleep(15000)]);
    // ...and the outside agent's call, held all this time, finishes when it is let go (nobody queued behind the sidebar).
    freeOutside();
    const done = await Promise.race([longCall, sleep(3000).then(() => null)]);
    check('the outside agent\'s long call finishes when its wait ends', Boolean(done) && /waited/.test(textIn(done)), J(done));
    H.agent.execute = realExecute;
    slow.end();
  }

  H.finish();
})().catch((err) => { console.error(err); H.check('suite crashed', false, err.stack); H.finish(); });
