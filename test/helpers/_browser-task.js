// A realistic multi-step browser task on a local shop site, run three ways with no network and no model:
//   api     - the sidebar's own loop (agent.js) with a scripted fake model
//   engine  - a CLI engine's MCP path (Claude Code / Codex / Grok Build: features/ai-agents.js mcpCallTool with a fake engine run)
//   outside - an outside agent over the real stdio bridge (mcp.js -> named pipe -> Lumen), in its own agent window
// The task: open the shop, search, filter the results (an in-page SPA update), open a result, fill and send a quote form, read the outcome.
// Shared by scripts/measure/measure-browser-task.js (numbers) and test/e2e/browser-task-timing.js (a budget that fails on regressions).
// A profiler in the main process splits each step's time: the whole call (mcp / gate / execute), the tool body (runTool), and every
// page-script round trip by kind (settle waits, click probe, cursor, focus guard, registry, labels...).
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const page = (title, body, head = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
const LAMPS = [
  { id: 'brass', name: 'Brass desk lamp', cat: 'Desk', stock: true, price: 89 },
  { id: 'arc', name: 'Arc floor lamp', cat: 'Floor', stock: true, price: 240 },
  { id: 'clip', name: 'Clip desk lamp', cat: 'Desk', stock: false, price: 25 },
  { id: 'paper', name: 'Paper floor lamp', cat: 'Floor', stock: false, price: 60 },
  { id: 'led', name: 'LED desk lamp', cat: 'Desk', stock: true, price: 45 },
];
const nav = '<nav><a href="/shop">Home</a> · <a href="/shop/about">About</a> · <a href="/shop/help">Help</a></nav>';
const filler = '<p>' + 'Lamps for reading, working and evenings at home. '.repeat(10) + '</p>';

// The results page filters in place: Apply shows a busy marker, "fetches" for 120 ms, redraws the list and pushes ?cat=..&stock=1.
const resultsPage = (q) => page(`Results for ${q}`, `${nav}<h1>Results for “${q}”</h1>
<form id="filters"><label>Category <select name="cat"><option>All</option><option>Desk</option><option>Floor</option></select></label>
<label><input type="checkbox" name="stock"> In stock only</label> <button type="submit">Apply filters</button></form>
<p id="count"></p><ul id="list"></ul><div id="busy" role="progressbar" hidden>Loading…</div>${filler}
<script>
const LAMPS = ${JSON.stringify(LAMPS)};
const draw = (cat, stock) => {
  const rows = LAMPS.filter((l) => (cat === 'All' || l.cat === cat) && (!stock || l.stock));
  document.getElementById('list').innerHTML = rows.map((l) => '<li><a href="/shop/item/' + l.id + '">' + l.name + '</a> $' + l.price + (l.stock ? '' : ' (out of stock)') + '</li>').join('');
  document.getElementById('count').textContent = rows.length + ' lamps';
};
draw('All', false);
document.getElementById('filters').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target; const busy = document.getElementById('busy');
  busy.hidden = false; busy.setAttribute('aria-busy', 'true');
  setTimeout(() => { draw(f.cat.value, f.stock.checked); busy.hidden = true; busy.removeAttribute('aria-busy'); history.pushState(null, '', location.pathname + location.search.replace(/&cat=.*$/, '') + '&cat=' + f.cat.value + (f.stock.checked ? '&stock=1' : '')); }, 120);
});
</script>`);

const itemPage = (l) => page(l.name, `${nav}<h1>${l.name}</h1><p>$${l.price} · ${l.cat} lamp · ${l.stock ? 'In stock' : 'Out of stock'}</p>${filler}
<h2>Request a quote</h2><form action="/shop/thanks" method="get"><input type="hidden" name="item" value="${l.id}">
<label>Your name <input name="name" autocomplete="off"></label>
<label>Email <input name="email" type="email" autocomplete="off"></label>
<label>Quantity <select name="qty"><option>1</option><option>2</option><option>3</option><option>5</option><option>10</option></select></label>
<label>Notes <textarea name="notes"></textarea></label>
<button type="submit">Request quote</button></form>`);

function startSite() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const html = (text) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(text); };
      const p = u.pathname;
      if (p === '/shop') return html(page('Lumen Lamps', `${nav}<h1>Lumen Lamps</h1>${filler}<form action="/shop/search"><label>Search <input name="q" autocomplete="off"></label> <button>Search</button></form><h2>Popular</h2><ul>${LAMPS.slice(0, 3).map((l) => `<li><a href="/shop/item/${l.id}">${l.name}</a></li>`).join('')}</ul>`));
      if (p === '/shop/search') return html(resultsPage(u.searchParams.get('q') || ''));
      const item = /^\/shop\/item\/(\w+)$/.exec(p);
      if (item) { const l = LAMPS.find((x) => x.id === item[1]); if (l) return html(itemPage(l)); }
      if (p === '/shop/thanks') {
        const l = LAMPS.find((x) => x.id === u.searchParams.get('item'));
        const name = (u.searchParams.get('name') || '').replace(/[<>&]/g, '');
        return html(page('Quote requested', `${nav}<h1>Thanks, ${name}</h1><p id="outcome">Quote request Q-1042 received: ${u.searchParams.get('qty')} × ${l ? l.name : '?'}. We reply within one day.</p>`));
      }
      if (p.startsWith('/shop/')) return html(page('Lumen Lamps', `${nav}<h1>${p.slice(6)}</h1>${filler}`));
      res.statusCode = 404; res.end('no');
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}

// The task as a model works it with today's tools: one call per model turn. `lean` is the same task with fewer calls (batch with a select by
// text and Enter to submit; the outcome read from the landed page). Text targets only: a scripted model has no ids.
function taskSteps(base, { lean = false } = {}) {
  if (lean) {
    return [
      { name: 'navigate', input: { url: `${base}/shop` } },
      { name: 'fill_form', input: { fields: [{ label: 'Search', value: 'lamp' }], submit: true } },
      { name: 'fill_form', input: { fields: [{ label: 'Category', value: 'Desk' }, { label: 'In stock only', value: 'true' }], submit: true } },
      { name: 'click', input: { text: 'Brass desk lamp' } },
      { name: 'fill_form', input: { fields: [{ label: 'Your name', value: 'Ada Lovelace' }, { label: 'Email', value: 'ada@example.com' }, { label: 'Quantity', value: '2' }, { label: 'Notes', value: 'Two for the study, please.' }], submit: true } },
    ];
  }
  return [
    { name: 'navigate', input: { url: `${base}/shop` } },
    { name: 'fill_form', input: { fields: [{ label: 'Search', value: 'lamp' }], submit: true } },
    { name: 'fill_form', input: { fields: [{ label: 'Category', value: 'Desk' }, { label: 'In stock only', value: 'true' }] } },
    { name: 'click', input: { text: 'Apply filters' } },
    { name: 'click', input: { text: 'Brass desk lamp' } },
    { name: 'fill_form', input: { fields: [{ label: 'Your name', value: 'Ada Lovelace' }, { label: 'Email', value: 'ada@example.com' }, { label: 'Quantity', value: '2' }, { label: 'Notes', value: 'Two for the study, please.' }], submit: true } },
    { name: 'find', input: { query: 'Quote request' } },
  ];
}

// In the main process: the profiler and the fake model. global.__prof.begin(label) starts a step; everything the app does until the next
// begin() is counted to it.
function installProfiler(electron) {
  const { webContents } = electron;
  const prof = global.__prof = { cur: null, steps: [], on: true };
  prof.begin = (label) => { prof.cur = { label, at: Date.now(), m: {}, s: {} }; prof.steps.push(prof.cur); return prof.cur; };
  prof.reset = () => { prof.steps = []; prof.cur = null; };
  const add = (bucket, key, ms) => { const c = prof.cur; if (!c) return; const r = (c[bucket][key] ||= { n: 0, ms: 0 }); r.n++; r.ms += ms; };
  const KINDS = [
    [/quietMs/, 'settle (DOM quiet)'], [/__lumenClickProbe|clickProbe|lumenProbe/, 'click probe'], [/c\.__lumenFade/, 'cursor'],
    [/const covered = /, 'locate'], [/'no-registry'/, 'find target'], [/matchOption/, 'select'],
    [/^\(\(\) => \{\s*const deep = \(doc\)/, 'focus guard'], [/cursorsHidden/, 'cursor hide'],
    [/function compactOutline/, 'read (outline)'], [/function findMatches/, 'find'],
    [/window\.__claudeEls = registry;\s*const listing = /, 'read (full walk)'], // readPage itself: the registry plus the page text and elements
    [/lumen\.registryClean/, 'registry'], [/window\.__claudeEls = registry/, 'registry'], [/innerWidth, h: innerHeight/, 'view size'],
  ];
  const kindOf = (code) => {
    const text = String(code || '');
    for (const [re, k] of KINDS) if (re.test(text)) return k;
    const name = /^\s*\(?\s*(?:async\s*)?function\s*(\w+)/.exec(text)?.[1] || /^\s*\(\s*\(\s*\)\s*=>\s*\{\s*(?:const|let|var)\s+(\w+)/.exec(text)?.[1];
    if (/const bringIntoView = /.test(text)) return 'script (page helpers)'; // page-scripts.js HELPERS: focus, type, toggles, submit...
    return `script ${name || text.replace(/\s+/g, ' ').slice(0, 48)}`;
  };
  const wcs = webContents.getAllWebContents();
  const proto = Object.getPrototypeOf(wcs[0]);
  for (const key of ['executeJavaScriptInIsolatedWorld', 'executeJavaScript']) {
    let owner = proto; while (owner && !Object.prototype.hasOwnProperty.call(owner, key)) owner = Object.getPrototypeOf(owner);
    if (!owner || owner[`__prof_${key}`]) continue;
    const orig = owner[key];
    owner[`__prof_${key}`] = orig;
    owner[key] = function (...a) {
      const code = key === 'executeJavaScript' ? a[0] : a[1]?.[0]?.code;
      const t = Date.now(); const k = kindOf(code);
      const out = orig.apply(this, a);
      // (a registry the page kept, snapshot.js REGISTRY_FRESH, is counted apart from one that was walked)
      Promise.resolve(out).then((v) => add('s', k === 'registry' && v && v.reused ? 'registry (kept)' : k.startsWith('settle') && typeof v === 'string' ? `${k}: ${v}` : k, Date.now() - t), () => add('s', k, Date.now() - t));
      return out;
    };
  }
  const dbgProto = Object.getPrototypeOf(wcs[0].debugger);
  if (!dbgProto.__prof_send) {
    const orig = dbgProto.sendCommand; dbgProto.__prof_send = orig;
    dbgProto.sendCommand = function (method, ...a) { const t = Date.now(); const out = orig.call(this, method, ...a); Promise.resolve(out).then(() => add('s', `cdp ${method}`, Date.now() - t), () => add('s', `cdp ${method}`, Date.now() - t)); return out; };
  }
  const P = Object.getPrototypeOf(global.__agent);
  for (const m of ['describeStep', 'ensureAllowed', 'execute', 'executeRaw', 'withContentGuard', 'executeDebugged', 'executeGuarded', 'runTool', 'keepUserFocus', 'verifiedClick', 'locateElement', 'resolveTarget', 'refreshRegistry', 'landedHead', 'pointAt', 'settleRedirects', 'waitForUserTyping', 'ownNavigationTab']) {
    if (typeof P[m] !== 'function' || P[`__prof_${m}`]) continue;
    const orig = P[m]; P[`__prof_${m}`] = orig;
    const depth = new Map();
    P[m] = function (...a) {
      const d = depth.get(m) || 0; depth.set(m, d + 1);
      const t = Date.now();
      const fin = () => { depth.set(m, (depth.get(m) || 1) - 1); if (d === 0) add('m', m, Date.now() - t); };
      let out;
      try { out = orig.apply(this, a); } catch (err) { fin(); throw err; }
      if (out && typeof out.then === 'function') out.then(fin, fin); else fin();
      return out;
    };
  }
  if (typeof global.__mcpCallTool === 'function' && !global.__prof_mcp) {
    const orig = global.__mcpCallTool; global.__prof_mcp = orig;
    global.__mcpCallTool = async (...a) => { const t = Date.now(); try { return await orig(...a); } finally { add('m', 'mcpCallTool', Date.now() - t); } };
  }
}

// The fake model for the API loop (as in measure-ai-turns.js): each request answers with the next turn's calls, "Done." after the last.
function installFakeModel() {
  const fake = global.__fake = { turns: [], at: 0, done: 0, log: [] };
  global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
    const last = params.messages.at(-1);
    const results = Array.isArray(last?.content) ? last.content.filter((b) => b.type === 'tool_result').map((b) => (typeof b.content === 'string' ? b.content : JSON.stringify(b.content))) : [];
    const rec = { at: Date.now(), chars: JSON.stringify(params).length, results, end: 0 };
    fake.log.push(rec);
    const turn = fake.turns[fake.at++];
    if (global.__prof) global.__prof.begin(turn ? turn.map((c) => c.name).join('+') : 'reply');
    const content = turn ? turn.map((c, i) => ({ type: 'tool_use', id: `t${fake.at}-${i}-${Date.now()}`, name: c.name, input: c.input })) : [{ type: 'text', text: 'Done.' }];
    if (!turn) fake.done++;
    const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: turn ? 'tool_use' : 'end_turn', content, usage: { input_tokens: Math.round(rec.chars / 4), output_tokens: 10 } };
    return { async *[Symbol.asyncIterator]() { yield { type: 'message_start' }; for (const [index, b] of content.entries()) { yield { type: 'content_block_start', index, content_block: b.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: b.id, name: b.name, input: {} } }; if (b.type === 'text') yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }; } }, finalMessage: async () => { rec.end = Date.now(); return message; } };
  } } } });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 30000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(30); } return v; };

// Sets up a launched app for the runs: the profiler, the fake model, the sidebar open, and the AI allowed to act on the local site.
async function prepare(app, ui) {
  await app.evaluate((electron, src) => { (0, eval)(`(${src})`)(electron); }, `function (electron) { (${installProfiler.toString()})(electron); (${installFakeModel.toString()})(); global.__agent.browser.autoApprove = () => true; }`);
  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.waitForSelector('#prompt', { state: 'visible' });
}

// The API loop: a new chat, the steps as one call per model turn. Returns { ms, requests, chars, steps, results }.
async function runApi(app, ui, steps, text) {
  await ui.click('#new-chat').catch(() => {});
  await app.evaluate((_e, t) => { global.__fake.turns = t; global.__fake.at = 0; global.__fake.log = []; global.__prof.reset(); }, steps.map((s) => [s]));
  const before = await app.evaluate(() => global.__fake.done);
  const running = () => ui.evaluate(() => document.getElementById('send').classList.contains('stop'));
  const t0 = Date.now();
  await ui.fill('#prompt', text);
  await ui.press('#prompt', 'Enter');
  await waitFor(async () => (await app.evaluate(() => global.__fake.done)) > before && !(await running()), 90000);
  const ms = Date.now() - t0;
  const out = await app.evaluate(() => ({ log: global.__fake.log, steps: global.__prof.steps }));
  const results = out.log.slice(1).map((r) => r.results.join('\n'));
  // A step's span: from its model response's end to the next request (the tools plus Lumen's work between the calls).
  const spans = out.log.slice(0, -1).map((r, i) => out.log[i + 1].at - r.end);
  return { ms, requests: out.log.length, chars: out.log.reduce((a, x) => a + x.chars, 0), steps: out.steps.slice(0, steps.length).map((s, i) => ({ ...s, span: spans[i] })), results };
}

// A CLI engine's run: claudeCodeTurn stands in for the CLI, calling the tools through mcpCallTool as Claude Code's MCP calls arrive.
async function runEngine(app, ui, steps, text) {
  await ui.click('#new-chat').catch(() => {});
  const t0 = Date.now();
  const out = await app.evaluate(async (_e, { steps, text }) => {
    const agent = global.__agent;
    const saved = agent.claudeCodeTurn;
    const prevModel = agent.messages.settings?.model;
    agent.messages.settings = { ...(agent.messages.settings || {}), model: 'claudecode:default' };
    global.__prof.reset();
    const res = { steps: [], results: [] };
    agent.claudeCodeTurn = async (_m, _t, _i, signal, emit) => {
      global.__fakeEngine = { owns: (t) => t === 'bench-engine', active: { emit, signal, scope: agent.runScope } };
      const own = { engine: 'bench-engine', approvedHosts: new Set(), clientName: 'Claude', controller: new AbortController() };
      for (const s of steps) {
        const rec = global.__prof.begin(s.name);
        const t = Date.now();
        const r = await global.__mcpCallTool(s.name, s.input, own);
        rec.span = Date.now() - t;
        res.results.push((r.isError ? 'ERROR: ' : '') + (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'));
      }
      return { text: 'Done.' };
    };
    try { await new Promise((resolve) => agent.run(text, (ev) => { if (ev.type === 'done') resolve(); })); } finally {
      agent.claudeCodeTurn = saved; global.__fakeEngine = null;
      if (prevModel) agent.messages.settings.model = prevModel;
    }
    res.steps = global.__prof.steps;
    return res;
  }, { steps, text });
  return { ms: Date.now() - t0, requests: 1, steps: out.steps, results: out.results };
}

// An outside agent over the real stdio bridge: spawns mcp.js as `claude mcp add lumen -- electron mcp.js` would, in the app's profile.
async function openBridge(app, ui, root, env) {
  await ui.evaluate(() => window.assistant.setMcpEnabled(true));
  const bridge = spawn(require('electron'), [path.join(root, 'mcp.js')], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const waiting = new Map();
  bridge.stdout.setEncoding('utf8');
  bridge.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
      if (!line) continue;
      try { const msg = JSON.parse(line); waiting.get(msg.id)?.(msg); waiting.delete(msg.id); } catch { /* a log line */ }
    }
  });
  let next = 1;
  const request = (method, params, timeout = 60000) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeout);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench-agent', version: '1' } });
  bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  await request('tools/list', {});
  return { request, close: () => { try { bridge.stdin.end(); } catch {} try { bridge.kill(); } catch {} } };
}

async function runOutside(app, bridge, steps) {
  await app.evaluate(() => global.__prof.reset());
  const t0 = Date.now();
  const results = [];
  const spans = [];
  for (const s of steps) {
    await app.evaluate((_e, n) => global.__prof.begin(n), s.name);
    const t = Date.now();
    const r = await bridge.request('tools/call', { name: s.name, arguments: s.input });
    spans.push(Date.now() - t);
    results.push((r.result?.isError ? 'ERROR: ' : '') + (r.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'));
  }
  const ms = Date.now() - t0;
  const got = await app.evaluate(() => global.__prof.steps);
  return { ms, requests: 1, steps: got.map((x, i) => ({ ...x, span: spans[i] })), results };
}

// Did the task work? The quote landed with the right fields, and the filter showed only in-stock desk lamps.
function checkOutcome(results) {
  const all = results.join('\n');
  const problems = [];
  if (results.some((r) => /^ERROR: /.test(r) || /FAILED/.test(r))) problems.push(`a step failed: ${results.find((r) => /^ERROR: |FAILED/.test(r)).slice(0, 300)}`);
  if (!/Q-1042/.test(all)) problems.push('the quote outcome (Q-1042) never showed in a result');
  if (!/2 × Brass desk lamp/.test(all)) problems.push('the outcome did not name 2 × Brass desk lamp');
  return problems;
}

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);

// Per step: span (the call from the caller's seat), body (runTool), overhead = span - body, and the round trips by kind.
function summarize(run) {
  return run.steps.map((s) => {
    const m = (k) => s.m[k]?.ms || 0;
    const body = m('runTool');
    const trips = Object.values(s.s).reduce((a, r) => a + r.n, 0); // page scripts and DevTools calls the step made
    return { label: s.label, span: s.span, body, overhead: Math.max(0, (s.span || 0) - body), trips, m: s.m, s: s.s };
  });
}

module.exports = { startSite, taskSteps, prepare, runApi, runEngine, openBridge, runOutside, checkOutcome, summarize, median, LAMPS };
