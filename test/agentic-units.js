// Agentic speed paths, plain Node (no Electron, no real CLI): Claude Code's kept process over
// stream-json (turn boundaries, reuse, stop/respawn with --resume, one-shot mode, expired sessions,
// early step rows, HTTP MCP config and the stdio fallback), compact-read dedupe, batch's baseline,
// the registry-only page script, routing pinned per session, transcript exchange resets, the
// DuckDuckGo HTML parser and the after-action settle.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flag = (argv, f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);

// ---- a fake `claude`: one child per spawn, reads stream-json lines, answers through `respond`
function fakeClaude(respond) {
  const spawned = [];
  const spawn = (bin, argv, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.pid = 4000 + spawned.length;
    const rec = { argv, opts, child, lines: [], ended: false, killed: false, mcp: JSON.parse(fs.readFileSync(flag(argv, '--mcp-config'), 'utf8')) };
    rec.out = (obj) => { if (child.exitCode === null) child.stdout.write(`${JSON.stringify(obj)}\n`); };
    rec.exit = (code = 0) => { if (child.exitCode !== null) return; child.exitCode = code; setImmediate(() => child.emit('close', code)); };
    rec.session = flag(argv, '--session-id') || flag(argv, '--resume');
    let buf = '';
    child.stdin = new Writable({
      write(chunk, _enc, cb) {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          rec.lines.push(msg);
          setImmediate(() => respond(rec, msg, rec.lines.length));
        }
        cb();
      },
      final(cb) { rec.ended = true; cb(); },
    });
    spawned.push(rec);
    return child;
  };
  const kill = (child) => { const rec = spawned.find((r) => r.child === child); if (rec) { rec.killed = true; rec.exit(null); } };
  return { spawn, kill, spawned };
}
const say = (rec, text, extra = {}) => {
  rec.out({ type: 'system', subtype: 'init', session_id: rec.session, mcp_servers: [{ name: 'lumen', status: 'connected' }] });
  rec.out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  rec.out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  rec.out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: rec.session, total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 }, ...extra });
  if (rec.ended) rec.exit(0); // one-shot: stdin closed, the CLI ends after its result
};
const echo = (rec, msg, n) => say(rec, `reply ${n}: ${msg.message.content[0].text}`);

async function engineRuns() {
  const cc = require('../claude-code');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-agentic-'));
  const gateLog = { opened: [], closed: [] };
  let tokens = 0;
  const gate = { open: (tag) => { gateLog.opened.push(tag); return { mcpUrl: 'http://127.0.0.1:5555/mcp', mcpToken: `tok${++tokens}`, hookUrl: 'x' }; }, close: (tag) => gateLog.closed.push(tag) };
  let respond = echo;
  const cli = fakeClaude((...a) => respond(...a));
  let ensured = 0;
  const make = (extra = {}) => {
    const eng = new cc.ClaudeCodeEngine({ userData: tmp, mcpCommand: () => ({ command: 'lumen-bridge', args: ['mcp.js'], env: { ELECTRON_RUN_AS_NODE: '1' } }), ensureServer: () => { ensured++; }, gate: async () => gate, spawn: cli.spawn, kill: cli.kill, ...extra });
    eng.bin = process.execPath; // exists on disk: ensureBin takes it as found
    return eng;
  };
  const opts = (o = {}) => ({ prompt: 'hello', sessionId: 'sess-1', resume: false, systemPrompt: 'SYS', signal: new AbortController().signal, emit: (e) => events.push(e), ...o });
  let events = [];

  // Warm first (runTask), then the message: one process, started before run().
  const eng = make();
  eng.warm({ sessionId: 'sess-1', resume: false, systemPrompt: 'SYS', model: 'default', maxTurns: 0 });
  await sleep(20);
  check('warm: the CLI is started before the message', cli.spawned.length === 1, String(cli.spawned.length));
  const first = cli.spawned[0];
  const r1 = await eng.run(opts());
  check('turn 1: the reply ends at the result event, the process stays up with stdin open', r1.text === 'reply 1: hello' && r1.sessionId === 'sess-1' && !r1.failed && first.child.exitCode === null && !first.ended, JSON.stringify(r1));
  check('argv: --system-prompt replaces the default prompt, --session-id for a new chat', flag(first.argv, '--system-prompt') === 'SYS' && !first.argv.includes('--append-system-prompt') && flag(first.argv, '--session-id') === 'sess-1' && flag(first.argv, '--input-format') === 'stream-json', first.argv.join(' '));
  const lumen = first.mcp.mcpServers.lumen;
  check('mcp config: Lumen\'s HTTP server with this process\'s bearer token, no bridge command', lumen.type === 'http' && lumen.url === 'http://127.0.0.1:5555/mcp' && lumen.headers.Authorization === 'Bearer tok1' && !lumen.command && ensured === 0, JSON.stringify(lumen));
  check('between messages: the kept process owns its tag, no message is active', eng.owns(gateLog.opened[0]) && eng.active === null && !eng.owns('x'.repeat(36)), '');

  const r2 = await eng.run(opts({ prompt: 'again', resume: true }));
  check('turn 2: the same process takes the next line (no new spawn, no new token)', cli.spawned.length === 1 && first.lines.length === 2 && r2.text === 'reply 2: again' && gateLog.opened.length === 1, JSON.stringify({ n: cli.spawned.length, r2 }));

  // A model change: another process, resuming the session; the old one and its token go.
  await eng.run(opts({ prompt: 'harder', resume: true, model: 'opus' }));
  const second = cli.spawned[1];
  check('model change: a new process with --resume and --model, the old one killed and its token revoked', cli.spawned.length === 2 && flag(second.argv, '--resume') === 'sess-1' && flag(second.argv, '--model') === 'opus' && first.killed && gateLog.closed.includes(gateLog.opened[0]), JSON.stringify({ n: cli.spawned.length, killed: first.killed, closed: gateLog.closed }));

  // Stop mid-message: fast, the tree is killed, and the next message respawns with --resume.
  respond = () => {}; // never answers
  const ctl = new AbortController();
  const pending = eng.run(opts({ prompt: 'slow', resume: true, model: 'opus', signal: ctl.signal }));
  await sleep(20);
  const t0 = Date.now();
  ctl.abort();
  const stopped = await pending;
  check('stop: resolves at once as stopped and kills the process', stopped.stopped === true && Date.now() - t0 < 100 && second.killed, JSON.stringify(stopped));
  respond = echo;
  const r3 = await eng.run(opts({ prompt: 'back', resume: true, model: 'opus' }));
  check('after stop: the next message gets a new process resuming the session', cli.spawned.length === 3 && flag(cli.spawned[2].argv, '--resume') === 'sess-1' && r3.text === 'reply 1: back', JSON.stringify(r3));

  // A kept process that died between messages without a word is started again transparently.
  const third = cli.spawned[2];
  respond = (rec, msg, n) => (rec === third && n === 2 ? rec.exit(1) : echo(rec, msg, n));
  const r4 = await eng.run(opts({ prompt: 'crash?', resume: true, model: 'opus' }));
  check('a kept process dying at the write is retried once on a fresh one', cli.spawned.length === 4 && r4.text === 'reply 1: crash?' && !r4.failed, JSON.stringify(r4));
  respond = echo;

  // release(): the chat switched away; the idle process and its token go.
  const fourth = cli.spawned[3];
  eng.release();
  await sleep(5);
  check('release: the idle kept process is killed', fourth.killed && eng.proc === null, '');

  // Early step rows: a long-streaming tool call shows a row, and the MCP call reports into it.
  events = [];
  respond = async (rec, msg, n) => {
    rec.out({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'mcp__lumen__fill_form', input: {} } } });
    await sleep(cc.EARLY_STEP_MS + 80);
    rec.claimed = eng.claimStep('fill_form');
    rec.out({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_2', name: 'mcp__lumen__click', input: {} } } });
    await sleep(10);
    rec.fast = eng.claimStep('click');
    say(rec, 'done');
  };
  await eng.run(opts({ prompt: 'form', resume: true }));
  const rec5 = cli.spawned[cli.spawned.length - 1];
  const rows = events.filter((e) => e.type === 'tool');
  check('early row: a tool call still streaming after 300 ms shows a step row, which the MCP call claims', rows.length === 1 && rows[0].id === 'cc-toolu_1' && rows[0].name === 'fill_form' && rows[0].label === 'Filling in a form' && rec5.claimed === 'cc-toolu_1', JSON.stringify({ rows, claimed: rec5.claimed }));
  check('early row: a quick call gets no early row (its own labelled row instead)', rec5.fast === null && !rows.some((e) => e.name === 'click'), String(rec5.fast));
  respond = echo;

  // Expired session: quiet for the caller that retries, an error for the rest.
  respond = (rec) => { rec.out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'No conversation found with session ID: gone', session_id: 'gone' }); };
  events = [];
  const quiet = await eng.run(opts({ prompt: 'x', sessionId: 'gone', resume: true, quietExpired: true }));
  check('expired (quietExpired): { expired } with no error shown', quiet.expired === true && quiet.sessionId === null && !events.some((e) => e.type === 'error'), JSON.stringify({ quiet, events }));
  const loud = await eng.run(opts({ prompt: 'x', sessionId: 'gone', resume: true }));
  check('expired (plain): the error is shown and the session forgotten', !loud.expired && loud.failed && loud.sessionId === null && events.some((e) => e.type === 'error'), JSON.stringify(loud));
  respond = echo;

  // Idle timeout.
  const idle = make({ idleMs: 40 });
  await idle.run(opts({ sessionId: 'sess-idle' }));
  const idleRec = cli.spawned[cli.spawned.length - 1];
  await sleep(80);
  check('idle: a kept process is stopped after the idle timeout', idleRec.killed && idle.proc === null, '');

  // One-shot (background tasks): stdin closes after the message, nothing is kept.
  const bg = make({ keepAlive: false });
  const rb = await bg.run(opts({ sessionId: 'sess-bg' }));
  const bgRec = cli.spawned[cli.spawned.length - 1];
  await sleep(10);
  check('one-shot: stdin ends after the one message and the process ends by itself', rb.text === 'reply 1: hello' && bgRec.ended && !bgRec.killed && bgRec.child.exitCode === 0, JSON.stringify(rb));
  bg.warm({ sessionId: 'sess-bg2', resume: false, systemPrompt: 'SYS' });
  await sleep(10);
  check('one-shot: warm() starts nothing', cli.spawned[cli.spawned.length - 1] === bgRec, '');

  // A turn cap: one process per message, the next one started ahead (resuming) once this one ends.
  const capped = make();
  const before = cli.spawned.length;
  await capped.run(opts({ sessionId: 'sess-cap', maxTurns: 30 }));
  await sleep(30);
  const capRecs = cli.spawned.slice(before);
  check('turn cap: the message\'s process ends, the next one is pre-started with --resume', capRecs.length === 2 && capRecs[0].ended && flag(capRecs[1].argv, '--resume') === 'sess-cap' && flag(capRecs[1].argv, '--max-turns') === '30' && capRecs[1].lines.length === 0, JSON.stringify(capRecs.map((r) => r.argv.join(' '))));
  await capped.run(opts({ prompt: 'next', sessionId: 'sess-cap', resume: true, maxTurns: 30 }));
  const tookNext = cli.spawned.slice(before).filter((r) => r.lines.some((l) => l.message.content[0].text === 'next'));
  check('turn cap: the pre-started process takes the next message', tookNext.length === 1 && tookNext[0] === capRecs[1], String(cli.spawned.length - before));
  await sleep(30);
  capped.dispose();

  // No HTTP server: the stdio bridge, named by its tag.
  const stdio = make({ gate: async () => { throw new Error('no port'); } });
  const ensuredBefore = ensured;
  await stdio.run(opts({ sessionId: 'sess-stdio' }));
  const sRec = cli.spawned[cli.spawned.length - 1];
  const bridge = sRec.mcp.mcpServers.lumen;
  check('fallback: the stdio bridge with LUMEN_ENGINE when the HTTP server is not there', bridge.command === 'lumen-bridge' && /^[a-f0-9]{36}$/.test(bridge.env.LUMEN_ENGINE) && bridge.env.ELECTRON_RUN_AS_NODE === '1' && ensured === ensuredBefore + 1 && stdio.owns(bridge.env.LUMEN_ENGINE), JSON.stringify(bridge));
  stdio.dispose();
  idle.dispose();
  eng.dispose();

  // The pure helpers.
  check('procKey: differs by session, model, cap and prompt', new Set([
    cc.procKey({ bin: 'b', sessionId: 's', systemPrompt: 'p' }), cc.procKey({ bin: 'b', sessionId: 't', systemPrompt: 'p' }),
    cc.procKey({ bin: 'b', sessionId: 's', systemPrompt: 'p', model: 'opus' }), cc.procKey({ bin: 'b', sessionId: 's', systemPrompt: 'p', maxTurns: 5 }),
    cc.procKey({ bin: 'b', sessionId: 's', systemPrompt: 'q' }),
  ]).size === 5, '');
  const got = [];
  const feed = cc.lineReader((l) => got.push(l));
  feed('{"a":1}\n{"b"'); feed(':2}\n\n');
  check('lineReader: lines split across chunks come out whole', JSON.stringify(got) === '["{\\"a\\":1}","{\\"b\\":2}"]', JSON.stringify(got));
  fs.rmSync(tmp, { recursive: true, force: true });
}

async function snapshotRuns() {
  const snap = require('../snapshot');
  let lines = ['# Shop', '[1] button "Add"'];
  let url = 'https://a.test/';
  const wc = { id: 901, isDestroyed: () => false, getURL: () => url };
  const agent = { requireTab: () => wc, browser: { aiOff: () => false }, allowStep: async () => {}, execute: async () => { lines = ['# Shop', '[1] button "Add"', 'Cart: 1 item']; return 'Clicked element 1.'; } };
  const scriptsSeen = [];
  const h = (dedupe) => ({ scripts: { readPage: () => '' }, dedupe: () => dedupe, runScript: async (_wc, s) => { scriptsSeen.push(s); return { lines: [...lines], totalLines: lines.length, elements: 1, startLine: 0, clipped: false }; } });
  const a = await snap.execute(agent, 'read_page', { mode: 'compact' }, h(true));
  const b = await snap.execute(agent, 'read_page', { mode: 'compact' }, h(true));
  check('compact dedupe: a repeat read soon after is the one "unchanged" line', /button "Add"/.test(a) && /Unchanged since your last read/.test(b) && !/button "Add"/.test(b), b);
  const c = await snap.execute(agent, 'read_page', { mode: 'compact', hrefs: true }, h(true));
  check('compact dedupe: another request shape (hrefs) is a full read', /button "Add"/.test(c), c);
  await snap.execute(agent, 'click', { element_id: 1 }, h(true)); // (not a snapshot tool: returns undefined, but ticks the cache)
  const d = await snap.execute(agent, 'read_page', { mode: 'compact', hrefs: true }, h(true));
  check('compact dedupe: an acting tool in between means a full read', /button "Add"/.test(d), d);
  const wc2 = { id: 902, isDestroyed: () => false, getURL: () => url };
  const agent2 = { ...agent, requireTab: () => wc2 };
  await snap.execute(agent2, 'read_page', { mode: 'compact' }, h(false));
  const e = await snap.execute(agent2, 'read_page', { mode: 'compact' }, h(false));
  check('compact dedupe: off outside the sidebar\'s own chat (MCP clients get the page)', /button "Add"/.test(e), e);

  // batch: the diff is against a baseline taken at its start, not an older read of another page.
  const wc3 = { id: 903, isDestroyed: () => false, getURL: () => url };
  const agent3 = { ...agent, requireTab: () => wc3 };
  url = 'https://elsewhere.test/';
  lines = ['# Elsewhere'];
  await snap.execute(agent3, 'read_page', { mode: 'compact' }, h(false)); // the last read was another page
  url = 'https://a.test/';
  lines = ['# Shop', '[1] button "Add"'];
  const out = await snap.execute(agent3, 'batch', { steps: [{ do: 'click', ref: 1 }] }, h(false));
  check('batch: a same-page batch reports what changed, not "Now on a new page"', /Changes since your last read \(\+1 \/ -0/.test(out) && /Cart: 1 item/.test(out) && !/Now on a new page/.test(out), out);

  // The registry pass: read_page's own walk and labels, without the page text.
  const scripts = require('../page-scripts');
  const reg = snap.registryScript(scripts);
  let parses = true;
  try { new Function(`return ${reg}`); } catch { parses = false; }
  check('registry script: parses, stores window.__claudeEls with labels, skips body.innerText and the element list', parses && reg.includes('window.__claudeEls = registry;') && reg.includes('entry.label = accessibleName') && !reg.includes('document.body.innerText') && !reg.includes('elementRange') && reg.length < scripts.readPage(0, 0).length, reg.slice(-200));
  check('registry script: compact and find use it (no full readPage)', scriptsSeen.every((s) => s !== scripts.readPage(0, 0)), '');
  check('registry script: falls back to the full read if readPage changes shape', snap.registryScript({ readPage: () => '(() => 1)()' }) === '(() => 1)()', '');
}

function routeRuns() {
  const { route, tierFor } = require('../features/model-route');
  const heavy = { tier: 'heavy', turns: 2 };
  const light = 'what time is it in Tokyo and what is the weather there right now, please';
  check('route pin: in a resumed session a light message keeps the heavy model', route({ engine: 'claudecode', prompt: light, previous: heavy, pinned: true }).model === 'opus', '');
  check('route pin: a new session is scored on its own', route({ engine: 'claudecode', prompt: light, previous: heavy, pinned: false }).model === 'haiku', '');
  const brief = 'Refactor the checkout flow across the codebase and debug why the cart total is wrong.\n1. Investigate the root cause\n2. Design a fix\n3. Write tests, then migrate';
  check('route pin: a harder message still moves up', tierFor(brief, { previous: { tier: 'light', turns: 3 }, pinned: true }).tier === 'heavy', '');
  check('route pin: a picked model is never touched', route({ engine: 'claudecode', picked: 'sonnet', prompt: brief, previous: heavy, pinned: true }).model === 'sonnet', '');
}

function transcriptRuns() {
  const { transcriptFor } = require('../agent');
  const items = transcriptFor([
    { role: 'user', content: 'book it' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'click', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Not run: stopped by the user.' }, { type: 'text', text: 'never mind, what is 2+2?' }] },
    { role: 'assistant', content: [{ type: 'text', text: '4' }] },
  ]);
  const reply = items.find((i) => i.role === 'assistant');
  check('transcript: an exchange stopped mid-tool does not lend its steps or "acted" to the next', reply && reply.text === '4' && reply.steps === 0 && !reply.acted, JSON.stringify(items));
  const normal = transcriptFor([
    { role: 'user', content: 'click it' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'click', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Clicked.' }] },
  ]).find((i) => i.role === 'assistant');
  check('transcript: steps within one exchange still count (tool results are not a new exchange)', normal.steps === 1 && normal.acted === true, JSON.stringify(normal));
}

function promptRuns() {
  const { cliSystemPrompt } = require('../agent');
  const picked = cliSystemPrompt({ model: 'claudecode:opus' }, 'claudecode');
  const plain = cliSystemPrompt({ model: 'claudecode:default' }, 'claudecode', { background: true });
  check('Claude Code prompt: with its own prompt replaced, Lumen\'s names the tools, the date and a picked model', /mcp__lumen__read_page/.test(picked) && /Today's date is \d{4}-\d\d-\d\d\./.test(picked) && /model answering is Claude Opus/.test(picked), picked.slice(-300));
  check('Claude Code prompt: the default pick names no model; a background run is told so', !/model answering/.test(plain) && /background task/.test(plain) && /Today's date is/.test(plain), plain.slice(-300));
}

function searchRuns() {
  const { parseSearchHtml } = require('../agent');
  const html = `<div class="serp"><div class="result results_links web-result "><div class="links_main result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=abc">Example <b>Domain</b> &amp; more</a></h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">This is the <b>first</b> snippet&#x27;s text.</a></div></div>
    <div class="result results_links web-result "><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://second.test/page">Second</a></h2>
    <div class="result__snippet">Second snippet</div></div>
    <div class="result"><a class="result__a" href="javascript:alert(1)">Bad</a></div></div>`;
  const rows = parseSearchHtml(html);
  check('search html: title, unwrapped url and snippet per result, non-web links dropped', JSON.stringify(rows) === JSON.stringify([
    { title: 'Example Domain & more', url: 'https://example.com/a?x=1', snippet: "This is the first snippet's text." },
    { title: 'Second', url: 'https://second.test/page', snippet: 'Second snippet' },
  ]), JSON.stringify(rows));
  check('search html: a page that is not a results page is null (the hidden view is tried)', parseSearchHtml('<html><body>Please verify you are human</body></html>') === null, '');
}

async function settleRuns() {
  const { settleAfterAction } = require('../agent');
  const fakeWc = ({ quietAfter, navigate }) => {
    const wc = new EventEmitter();
    let loading = false;
    wc.isDestroyed = () => false;
    wc.isLoading = () => loading;
    wc.executeJavaScriptInIsolatedWorld = () => new Promise((resolve) => { if (quietAfter !== null) setTimeout(() => resolve('quiet'), quietAfter); });
    if (navigate) {
      setTimeout(() => { loading = true; wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }); }, 30);
      setTimeout(() => { loading = false; wc.emit('did-stop-loading'); }, 300);
    }
    return wc;
  };
  let t = Date.now();
  await settleAfterAction(fakeWc({ quietAfter: 110 }));
  const quick = Date.now() - t;
  check('settle: no navigation returns once the DOM is quiet, without the fixed 550 ms', quick >= 100 && quick < 400, `${quick} ms`);
  t = Date.now();
  await settleAfterAction(fakeWc({ quietAfter: null, navigate: true }));
  const nav = Date.now() - t;
  check('settle: a navigation that starts is waited for until it has loaded', nav >= 300, `${nav} ms`);
  t = Date.now();
  const spa = fakeWc({ quietAfter: 120 });
  setTimeout(() => spa.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true }), 20);
  await settleAfterAction(spa);
  check('settle: a same-document navigation (pushState) is not waited on as a load', Date.now() - t < 400, `${Date.now() - t} ms`);
}

(async () => {
  await engineRuns();
  await snapshotRuns();
  routeRuns();
  transcriptRuns();
  promptRuns();
  searchRuns();
  await settleRuns();
  if (failures) { console.log(`\n${failures} agentic check(s) failed`); process.exit(1); }
  console.log('\nAll agentic checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
