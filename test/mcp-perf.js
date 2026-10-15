// [mcp perf] What Lumen's MCP server costs while outside agents (Claude Code, Codex, Grok Build, Antigravity) drive the browser, and
// that it stays that way. Hidden app, no real CLI: each agent is a fake MCP client that launches the stdio bridge exactly as
// `claude mcp add lumen -- <Lumen> mcp.js` would, and makes 50 typical calls (navigate to a heavy 127.0.0.1 page, read_page,
// screenshot, find, click). Measured, with 1, 3 and 6 sessions at once:
//   - Lumen's memory: the summed working set of every process Lumen started (the app's process tree) plus the bridges
//   - what the sessions leave behind once they have closed (window grace period included)
//   - processes per session (bridge included)
//   - per-call latency (p50, p95 per tool)
//   - the longest main-process stall during the calls (a 1 ms timer chain in main; gap = how late a tick ran)
//   - payload sizes (read_page text, screenshot base64)
// STRICT: the bounds below are set from the measured values with margin and are never to be loosened. If this is noisy, fix the
// measurement. LUMEN_MCP_PERF_REPORT=<file> writes the measurements as JSON; LUMEN_MCP_PERF_MEASURE=1 only measures (no bounds).
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const { openSettingsTab } = require('./settings-tab');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MEASURE_ONLY = process.env.LUMEN_MCP_PERF_MEASURE === '1';
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The bounds (see the report in the PR for the measured values they come from).
const BOUNDS = require('./mcp-perf-bounds.json');

// A heavy page: ~6000 elements, 400 links and buttons, a long text. Nothing external.
function heavyPage(n) {
  const rows = [];
  for (let i = 0; i < 400; i++) rows.push(`<li><a href="/item/${i}?p=${n}">Item ${i} of page ${n}</a> <button onclick="window.__clicked=${i}">Open ${i}</button> <span>${'lorem ipsum dolor sit amet '.repeat(6)}</span></li>`);
  const paras = [];
  for (let i = 0; i < 600; i++) paras.push(`<p>Paragraph ${i}: ${'The quick brown fox jumps over the lazy dog. '.repeat(8)}</p>`);
  return `<!doctype html><title>Heavy ${n}</title><body><h1>Heavy page ${n}</h1><nav><ul>${rows.join('')}</ul></nav><main>${paras.join('')}</main><div style="height:3000px;background:linear-gradient(#fff,#9cf)">tall</div></body>`;
}

// Every descendant of `roots` (the roots too): { count, wsMb }. One PowerShell/ps call.
function treeStats(roots) {
  let rows;
  if (process.platform === 'win32') {
    let out;
    for (let i = 0; i < 4; i++) { out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true }); if (out.stdout && out.stdout.trim().startsWith('[')) break; }
    rows = JSON.parse(out.stdout).map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, ws: Number(r.WorkingSetSize) || 0 }));
  } else {
    const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' });
    rows = out.stdout.trim().split('\n').map((l) => { const [pid, ppid, rss] = l.trim().split(/\s+/).map(Number); return { pid, ppid, ws: rss * 1024 }; });
  }
  const byParent = new Map();
  for (const r of rows) { if (!byParent.has(r.ppid)) byParent.set(r.ppid, []); byParent.get(r.ppid).push(r); }
  const seen = new Set();
  const stack = roots.filter(Boolean);
  let ws = 0;
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    ws += rows.find((r) => r.pid === pid)?.ws || 0;
    for (const c of byParent.get(pid) || []) stack.push(c.pid);
  }
  return { count: seen.size, wsMb: ws / 1048576 };
}

const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };

// One fake agent: the stdio bridge, speaking MCP as a CLI would.
function startAgent({ env, clientName }) {
  const child = spawn(require('electron'), [path.join(ROOT, 'mcp.js')], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = '';
  const waiting = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg, line.length);
      waiting.delete(msg.id);
    }
  });
  child.stderr.resume();
  let nextId = 1;
  const request = (method, params, timeout = 60000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`timeout: ${method}`)); }, timeout);
    waiting.set(id, (msg, bytes) => { clearTimeout(timer); resolve({ msg, bytes }); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const agent = {
    child,
    pid: child.pid,
    async init() {
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: clientName, version: '1.0' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      await request('tools/list', {});
    },
    // { ms, bytes, error }
    async call(name, args) {
      const t0 = process.hrtime.bigint();
      const w0 = Date.now();
      const { msg, bytes } = await request('tools/call', { name, arguments: args });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const error = msg.error ? JSON.stringify(msg.error) : msg.result?.isError ? (msg.result.content || []).map((c) => c.text).join(' ') : null;
      if (process.env.LUMEN_MCP_PERF_GAPS === '1') (globalThis.__calls ||= []).push([w0, Date.now(), name]);
      return { ms, bytes, error };
    },
    async callText(name, args) { const { msg } = await request('tools/call', { name, arguments: args }); return { text: (msg.result?.content || []).map((c) => c.text || '').join(' '), isError: msg.result?.isError === true }; },
    close() { try { child.stdin.end(); } catch {} },
  };
  return agent;
}

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const server = http.createServer((req, res) => {
    const n = Number(/p=(\d+)/.exec(req.url)?.[1] || 0);
    res.setHeader('Content-Type', 'text/html'); res.end(heavyPage(n));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_AGENT_WINDOW_GRACE_MS: '3000' }; // (the agent window's grace period after its session ends, 20 s in the app, shortened so the run is not all waiting)
  const app = await electron.launch({ args: [ROOT], env });
  const appPid = app.process().pid;
  const agents = [];
  const result = { idle: null, sessions: {}, tools: {}, payload: {}, maxGapMs: 0, engines: null, multiTab: {} };
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await ui.evaluate(() => window.assistant.setMcpEnabled(true));
    await app.evaluate(() => global.__settings.backend.set('agentsNoAsk', true)); // (outside agents act in their own window without cards)
    // The stall probe: a 1 ms timer chain in main; every tick records how late it ran.
    await app.evaluate(() => {
      const p = global.__mcpGap = { max: 0, list: [], last: Date.now(), over: 0, on: false, timer: null };
      const tick = () => { const now = Date.now(); const gap = now - p.last - 1; if (p.on) { if (gap > p.max) p.max = gap; if (gap > 20) { p.over++; p.list.push([now, gap]); } } p.last = now; p.timer = setTimeout(tick, 1); };
      tick();
    });
    const gap = (on) => app.evaluate((_e, flag) => { const p = global.__mcpGap; if (flag === 'read') { const out = { max: p.max, over: p.over, list: p.list }; p.max = 0; p.over = 0; p.list = []; return out; } p.on = flag; p.max = 0; p.over = 0; p.last = Date.now(); return null; }, on);
    await sleep(8000); // (start-up settled)
    const samples = () => { const s = []; for (let i = 0; i < 3; i++) { s.push(treeStats([appPid, ...agents.map((a) => a.pid)])); } return { count: s[0].count, wsMb: s.map((x) => x.wsMb).sort((a, b) => a - b)[1] }; };
    const procs = async (label) => { if (process.env.LUMEN_MCP_PERF_PROCS !== '1') return; const m = await app.evaluate(({ app: a, webContents }) => a.getAppMetrics().map((p) => `${p.pid}:${p.type}:${p.name || ''}:${Math.round(p.memory.workingSetSize / 1024)}`)); console.log(`[procs ${label}] ${m.join(' | ')}`); const wcs = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => `${w.id}:${w.getType()}:${w.getProcessId()}:${(w.getURL() || '').slice(-45)}:${w.hostWebContents?.id || ''}`)); console.log(`[wcs ${label}] ${wcs.join(' | ')}`); };
    await procs('idle');
    // The idle baseline is taken once start-up has settled: one agent session is opened and closed first (its window, the modules and the
    // renderer started on first use are all made and given back), then a garbage collection and readings until three in a row agree to
    // within 40 MB. Without this the baseline was ~300 MB too high and "after close" came out far below it, which hid leaks.
    const gcNow = () => app.evaluate(() => { try { process.getBuiltinModule('v8').setFlagsFromString('--expose-gc'); process.getBuiltinModule('vm').runInNewContext('gc')(); } catch { /* no gc */ } });
    const settle = async () => {
      const warm = startAgent({ env, clientName: 'claude-code' });
      agents.push(warm);
      await warm.init();
      await warm.call('open_tab', { url: `${base}/heavy?p=1` });
      warm.close();
      await sleep(1000);
      agents.splice(0, agents.length);
      await sleep(7000); // (grace period, window closed)
      let last = [];
      for (let i = 0; i < 12; i++) {
        await gcNow();
        await sleep(2000);
        last.push(samples().wsMb);
        last = last.slice(-3);
        if (last.length === 3 && Math.max(...last) - Math.min(...last) <= 40) break;
      }
    };
    await settle();
    result.idle = samples();
    console.log(`idle:${result.idle.count} processes, ${result.idle.wsMb.toFixed(0)} MB`);

    const byTool = {};
    const record = (name, r) => { (byTool[name] ||= []).push(r.ms); if (r.error) throw new Error(`${name}: ${r.error}`); };
    for (const n of (process.env.LUMEN_MCP_PERF_SESSIONS || '1,3,6').split(',').map(Number)) {
      const group = [];
      for (let i = 0; i < n; i++) group.push(startAgent({ env, clientName: 'claude-code' }));
      agents.push(...group);
      await Promise.all(group.map((a) => a.init()));
      const bridgeInit = treeStats(group.map((a) => a.pid)).wsMb / n;
      await gap(true);
      const prof = process.env.LUMEN_MCP_PERF_PROF && n === Number(process.env.LUMEN_MCP_PERF_PROF_N || 1);
      if (prof) await app.evaluate(() => new Promise((res) => { const S = process.getBuiltinModule('inspector').Session; const ses = global.__perfSes = new S(); ses.connect(); ses.post('Profiler.enable', () => ses.post('Profiler.setSamplingInterval', { interval: 100 }, () => ses.post('Profiler.start', res))); }));
      const tr = process.env.LUMEN_MCP_PERF_TRACE && n === Number(process.env.LUMEN_MCP_PERF_PROF_N || 1);
      if (tr) await app.evaluate(({ contentTracing }) => contentTracing.startRecording({ included_categories: ['toplevel', 'browser', 'navigation', 'devtools', 'views'] }));
      const t0 = Date.now();
      await Promise.all(group.map(async (a, s) => {
        for (let round = 0; round < 10; round++) { // 10 rounds x 5 calls = 50 calls
          const url = `${base}/heavy?p=${s * 100 + round}`;
          record('navigate', await a.call('navigate', { url }));
          const read = await a.call('read_page', {});
          record('read_page', read);
          if (s === 0 && round === 0) result.payload.read_page_bytes = read.bytes;
          const shot = await a.call('screenshot', {});
          record('screenshot', shot);
          if (s === 0 && round === 0) result.payload.screenshot_bytes = shot.bytes;
          record('find', await a.call('find', { query: `Item ${round + 7}` }));
          record('click', await a.call('click', { text: `Open ${round + 3}` }));
        }
      }));
      if (tr) await app.evaluate(({ contentTracing }, f) => contentTracing.stopRecording(f), process.env.LUMEN_MCP_PERF_TRACE);
      if (prof) { const p = await app.evaluate(() => new Promise((res) => global.__perfSes.post('Profiler.stop', (e, r) => res(JSON.stringify(r.profile))))); fs.writeFileSync(process.env.LUMEN_MCP_PERF_PROF, p); }
      const g = await gap('read');
      await gap(false);
      if (process.env.LUMEN_MCP_PERF_GAPS === '1') for (const [at, gp] of g.list) console.log(`  gap ${gp} ms at ${at}: during ${(globalThis.__calls || []).filter((c) => c[0] <= at && c[1] >= at - 1).map((c) => c[2]).join(',') || '(no call)'}`);
      result.maxGapMs = Math.max(result.maxGapMs, g.max);
      result.gapOver ||= 0; result.gapOver += g.over;
      await sleep(1500);
      await procs(`open${n}`);
      const open = samples();
      const bridgeMb = treeStats(group.map((a) => a.pid)).wsMb / n;
      const wins = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
      // Close: the bridges end; the agent windows close after their grace period (20 s).
      for (const a of group) a.close();
      await sleep(1000);
      const bridgesGone = group.every((a) => a.child.exitCode !== null || a.child.killed);
      agents.splice(0, agents.length);
      let after = null;
      await sleep(9000); // (the 3 s grace period, the windows closing, memory being given back)
      await gcNow();
      await sleep(1500);
      after = samples();
      await procs(`after${n}`);
      const winsAfter = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
      result.sessions[n] = { bridgeInit, bridgeMb, open, after, ms: Date.now() - t0, windows: wins, windowsAfter: winsAfter, bridgesGone, gapMax: g.max, gapOver: g.over };
      console.log(`  bridge each: ${bridgeInit.toFixed(0)} MB after init, ${bridgeMb.toFixed(0)} MB after the calls`);
      console.log(`${n} sessions: ${open.count} processes, ${open.wsMb.toFixed(0)} MB open; ${after.count} processes, ${after.wsMb.toFixed(0)} MB after close; windows ${wins} -> ${winsAfter}; main gap max ${g.max} ms (${g.over} over 20 ms)`);
    }
    for (const [name, arr] of Object.entries(byTool)) result.tools[name] = { n: arr.length, p50: pct(arr, 0.5), p95: pct(arr, 0.95) };
    console.log(JSON.stringify(result.tools));

    // One session driving 5 tabs of its window (tab_id on every call, calls on different tabs side by side) against 5 sessions with a tab each:
    // the same 250 calls. One window, one bridge, instead of five.
    {
      const roundCalls = async (call, url, round, record) => {
        record('navigate', await call('navigate', url));
        record('read_page', await call('read_page', {}));
        record('screenshot', await call('screenshot', {}));
        record('find', await call('find', { query: `Item ${round + 7}` }));
        record('click', await call('click', { text: `Open ${round + 3}` }));
      };
      const lat = [];
      const rec = (_n, r) => { lat.push(r.ms); if (r.error) throw new Error(r.error); };
      const measure = async (label, group, work) => {
        await Promise.all(group.map((a) => a.init()));
        await gap(true);
        const t0 = Date.now();
        await work();
        const wall = Date.now() - t0;
        const g = await gap('read');
        await gap(false);
        await sleep(1500);
        const open = samples();
        const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
        for (const a of group) a.close();
        await sleep(1000);
        agents.splice(0, agents.length);
        await sleep(9000);
        await gcNow();
        await sleep(1500);
        const after = samples();
        const out = { open, after, wall, windows, p50: pct(lat, 0.5), p95: pct(lat, 0.95), gapMax: g.max, gapOver: g.over, calls: lat.length };
        lat.length = 0;
        result.multiTab[label] = out;
        console.log(`${label}: ${open.count} processes, ${open.wsMb.toFixed(0)} MB open (${open.wsMb - result.idle.wsMb > 0 ? '+' : ''}${(open.wsMb - result.idle.wsMb).toFixed(0)}), ${after.wsMb.toFixed(0)} MB after close; windows ${windows}; ${out.calls} calls in ${wall} ms, p50 ${out.p50.toFixed(0)} ms, p95 ${out.p95.toFixed(0)} ms; main gap ${g.max} ms`);
      };
      result.multiTab = {};
      // (a) five sessions, one tab each
      const five = Array.from({ length: 5 }, () => startAgent({ env, clientName: 'claude-code' }));
      agents.push(...five);
      await measure('five_sessions', five, () => Promise.all(five.map(async (a, s) => { for (let r = 0; r < 10; r++) await roundCalls((n, args) => a.call(n, typeof args === 'string' ? { url: args } : args), `${base}/heavy?p=${s * 100 + r}`, r, rec); })));
      // (b) one session, five tabs
      const solo = startAgent({ env, clientName: 'claude-code' });
      agents.push(solo);
      await measure('one_session_five_tabs', [solo], async () => {
        const ids = [];
        for (let i = 0; i < 5; i++) {
          const r = await solo.callText('open_tab', { url: `${base}/heavy?p=${900 + i}` });
          const id = Number(/Opened tab ([0-9]+)/.exec(r.text)?.[1]);
          if (!Number.isInteger(id)) throw new Error(`open_tab: ${r.text.slice(0, 200)}`);
          ids.push(id);
        }
        // The click lands on the tab it names (a counter in each page), all five at once, and on no other.
        const clicked = await Promise.all(ids.map((tab, s) => solo.callText('click', { tab_id: tab, text: `Open ${s + 11}` })));
        check('five clicks at once, one per tab, all succeed', clicked.every((c) => !c.isError), clicked.map((c) => c.text.slice(0, 80)).join(' | '));
        const counters = await Promise.all(ids.map((tab) => solo.callText('run_script', { tab_id: tab, code: 'String(window.__clicked)' })));
        check('each tab got exactly its own click (page-side counter)', counters.every((c, s) => c.text.includes(String(s + 11)) && !c.isError), counters.map((c) => c.text.slice(0, 60)).join(' | '));
        const named = await solo.callText('read_page', { tab_id: ids[0] });
        check('read_page with tab_id reads that tab (not the front one)', /Heavy 900/.test(named.text) && !named.isError, named.text.slice(0, 200));
        const bad = await solo.callText('read_page', { tab_id: 999999 });
        check('a tab_id that is not a tab of the agent window is refused', bad.isError === true && /No tab with id|not.*tab|list_tabs/i.test(bad.text), bad.text.slice(0, 200));
        const notInt = await solo.callText('click', { tab_id: 'x', text: 'Open 1' });
        check('a tab_id that is not an integer is refused', notInt.isError === true && /integer/.test(notInt.text), notInt.text.slice(0, 200));
        await Promise.all(ids.map(async (tab, s) => { for (let r = 0; r < 10; r++) await roundCalls((n, args) => solo.call(n, { ...(typeof args === 'string' ? { url: args } : args), tab_id: tab }), `${base}/heavy?p=${s * 100 + r}`, r, rec); }));
      });
    }

    // Idle agent tabs are unloaded between calls: a session that opened 5 tabs and works in one keeps one page live, and the others come
    // back (reloaded) on the next call that names them.
    {
      const u = startAgent({ env, clientName: 'claude-code' });
      agents.push(u);
      await u.init();
      const ids = [];
      for (let i = 0; i < 5; i++) {
        const r = await u.callText('open_tab', { url: `${base}/heavy?p=${950 + i}` });
        ids.push(Number(/Opened tab ([0-9]+)/.exec(r.text)?.[1]));
      }
      for (const id of ids) await u.callText('find', { tab_id: id, query: 'Item 1' });
      await sleep(1500);
      const live = samples();
      await app.evaluate(() => global.__agentTabs.setIdleMs(1500));
      await sleep(2500);
      await app.evaluate(() => global.__agentTabs.sweep());
      await sleep(3000);
      await gcNow();
      await sleep(1500);
      const state = (await app.evaluate(() => global.__agentTabs.state()))[0] || [];
      const unloaded = samples();
      const sleeping = state.filter((t) => t.sleeping).length;
      result.unload = { live, unloaded, tabs: state.length, sleeping };
      console.log(`idle unload: ${state.length} agent tabs, ${sleeping} unloaded; ${live.count} -> ${unloaded.count} processes, ${live.wsMb.toFixed(0)} -> ${unloaded.wsMb.toFixed(0)} MB`);
      const sleeper = ids.find((id) => state.find((t) => t.id === id)?.sleeping);
      let woke = null;
      for (let i = 0; i < 40 && !woke; i++) {
        const r = await u.callText('read_page', { tab_id: sleeper });
        if (new RegExp(`Heavy ${950 + ids.indexOf(sleeper)}`).test(r.text)) woke = r.text; else await sleep(250);
      }
      result.unload.wokeReadable = Boolean(woke);
      await app.evaluate(() => global.__agentTabs.setIdleMs(180000));
      u.close();
      await sleep(1000);
      agents.splice(0, agents.length);
    }

    // tab_id may only name a tab of the agent's own window: not one of the user's tabs, not another agent's, not Settings.
    {
      const A = startAgent({ env, clientName: 'claude-code' });
      const B = startAgent({ env, clientName: 'codex-mcp-client' });
      agents.push(A, B);
      await Promise.all([A.init(), B.init()]);
      const opened = async (a, p) => {
        const r = await a.callText('open_tab', { url: `${base}/heavy?p=${p}` });
        const id = Number(/Opened tab ([0-9]+)/.exec(r.text)?.[1]);
        if (!Number.isInteger(id)) throw new Error(`open_tab: ${r.text.slice(0, 200)}`);
        return id;
      };
      const aTab = await opened(A, 700);
      const bTab = await opened(B, 701);
      const userTab = await app.evaluate(() => global.__windows.list()[0].tabs[0]);
      const userUrl = () => app.evaluate(({ webContents }) => webContents.fromId(global.__windows.list()[0].tabs[0].contentsId).getURL());
      const userUrlBefore = await userUrl();
      const inSettings = await openSettingsTab(app);
      const targets = [['one of the user\'s tabs', userTab.id], ['another session\'s tab', bTab], ['the Settings tab', inSettings.id]];
      for (const [what, id] of targets) {
        for (const [tool, args] of [['read_page', {}], ['click', { text: 'Open 1' }], ['navigate', { url: `${base}/heavy?p=666` }], ['run_script', { code: 'window.__clicked = 99' }]]) {
          const r = await A.callText(tool, { ...args, tab_id: id });
          check(`${tool} with tab_id of ${what} is refused`, r.isError === true, r.text.slice(0, 160));
        }
      }
      check('refused calls changed nothing: the user\'s tab keeps its page', (await userUrl()) === userUrlBefore, await userUrl());
      const b = await B.callText('read_page', { tab_id: bTab });
      check('...the other session\'s tab still shows its page', /Heavy 701/.test(b.text), b.text.slice(0, 120));
      const bClicked = await B.callText('run_script', { code: 'String(window.__clicked)' });
      check('...and was not clicked or scripted', /undefined/.test(bClicked.text), bClicked.text.slice(0, 120));
      const own = await A.callText('read_page', { tab_id: aTab });
      check('an agent can still name its own tab', /Heavy 700/.test(own.text) && !own.isError, own.text.slice(0, 120));
      const nul = await A.callText('read_page', { tab_id: null });
      check('tab_id null is refused (not silently the front tab)', nul.isError === true && /integer/.test(nul.text), nul.text.slice(0, 120));
      await app.evaluate((_e, id) => global.__agent.browser.closeTab(id), inSettings.id);
      A.close(); B.close();
      await sleep(1000);
      agents.splice(0, agents.length);
    }

    // Per-session processes: the bridge alone (a Node-mode Lumen: nothing else is started with it).
    const one = startAgent({ env, clientName: 'codex-mcp-client' });
    await one.init();
    const own = treeStats([one.pid]);
    result.bridge = { processes: own.count, wsMb: own.wsMb };
    one.close();
    await sleep(500);
    console.log(`one bridge: ${own.count} process(es), ${own.wsMb.toFixed(0)} MB`);

    // The kept-alive CLI engines (claude-code.js, codex-warm.js, grok-warm.js) are capped separately: their limits are read from the code.
    result.engines = await app.evaluate(() => ({ bgEngines: global.__bgEngineCount?.() ?? null }));

    if (process.env.LUMEN_MCP_PERF_REPORT) fs.writeFileSync(process.env.LUMEN_MCP_PERF_REPORT, JSON.stringify(result, null, 2));

    if (!MEASURE_ONLY) {
      const idle = result.idle.wsMb;
      const three = result.sessions[3];
      const sixth = result.sessions[6];
      check(`3 sessions cost at most ${BOUNDS.threeSessionsOverIdleMb} MB over idle (${(three.open.wsMb - idle).toFixed(0)})`, three.open.wsMb - idle <= BOUNDS.threeSessionsOverIdleMb, (three.open.wsMb - idle).toFixed(0));
      check(`6 sessions cost at most ${BOUNDS.sixSessionsOverIdleMb} MB over idle (${(sixth.open.wsMb - idle).toFixed(0)})`, sixth.open.wsMb - idle <= BOUNDS.sixSessionsOverIdleMb, (sixth.open.wsMb - idle).toFixed(0));
      for (const n of [1, 3, 6]) check(`after ${n} sessions close, memory is within ${BOUNDS.afterCloseOverIdleMb} MB of idle either way (${(result.sessions[n].after.wsMb - idle).toFixed(0)})`, Math.abs(result.sessions[n].after.wsMb - idle) <= BOUNDS.afterCloseOverIdleMb, (result.sessions[n].after.wsMb - idle).toFixed(0));
      for (const n of [1, 3, 6]) check(`after ${n} sessions close, process count is back to idle +${BOUNDS.afterCloseExtraProcesses} (${result.sessions[n].after.count} vs ${result.idle.count})`, result.sessions[n].after.count <= result.idle.count + BOUNDS.afterCloseExtraProcesses, `${result.sessions[n].after.count}`);
      for (const n of [1, 3, 6]) {
        const per = (result.sessions[n].open.count - result.idle.count) / n;
        check(`at most ${BOUNDS.extraProcessesPerSession} extra processes per session with ${n} open (${per.toFixed(1)})`, per <= BOUNDS.extraProcessesPerSession, per);
      }
      check(`the bridge is ${BOUNDS.bridgeProcesses} process at most (${result.bridge.processes})`, result.bridge.processes <= BOUNDS.bridgeProcesses, result.bridge.processes);
      check(`one bridge stays under ${BOUNDS.bridgeMb} MB (${result.bridge.wsMb.toFixed(0)})`, result.bridge.wsMb <= BOUNDS.bridgeMb, result.bridge.wsMb);
      // The main process must never stall for more than 20 ms (the standing rule), in every phase. The count of stalls over 20 ms is ratcheted too,
      // so that growth is caught whatever the maximum does.
      const phases = [...[1, 3, 6].map((n) => [`${n} session${n > 1 ? 's' : ''}`, result.sessions[n].gapMax, result.sessions[n].gapOver, BOUNDS.gapOver[`s${n}`]]), ['five sessions', result.multiTab.five_sessions.gapMax, result.multiTab.five_sessions.gapOver, BOUNDS.gapOver.five], ['one session, five tabs', result.multiTab.one_session_five_tabs.gapMax, result.multiTab.one_session_five_tabs.gapOver, BOUNDS.gapOver.tabs]];
      for (const [label, max, over, ratchet] of phases) {
        check(`main-process gap at most ${BOUNDS.maxGapMs} ms during the calls, ${label} (max ${max})`, max <= BOUNDS.maxGapMs, max);
        check(`...and at most ${ratchet} stalls over 20 ms, ${label} (${over})`, over <= ratchet, over);
      }
      for (const [name, b] of Object.entries(BOUNDS.p95Ms)) check(`${name} p95 under ${b} ms (${(result.tools[name]?.p95 || 0).toFixed(0)})`, result.tools[name] && result.tools[name].p95 <= b, result.tools[name]?.p95);
      const five = result.multiTab.five_sessions;
      const tabs = result.multiTab.one_session_five_tabs;
      check(`one session driving 5 tabs: at most ${BOUNDS.fiveTabsOneSessionOverIdleMb} MB over idle (${(tabs.open.wsMb - idle).toFixed(0)})`, tabs.open.wsMb - idle <= BOUNDS.fiveTabsOneSessionOverIdleMb, (tabs.open.wsMb - idle).toFixed(0));
      check(`...and at least ${BOUNDS.fiveTabsSavingMb} MB less than 5 sessions with a tab each (${(five.open.wsMb - tabs.open.wsMb).toFixed(0)})`, five.open.wsMb - tabs.open.wsMb >= BOUNDS.fiveTabsSavingMb, (five.open.wsMb - tabs.open.wsMb).toFixed(0));
      check(`...in at most ${BOUNDS.fiveTabsOneSessionProcesses} processes (${tabs.open.count}; 5 sessions: ${five.open.count})`, tabs.open.count <= BOUNDS.fiveTabsOneSessionProcesses && tabs.open.count < five.open.count, tabs.open.count);
      check(`...and one window of its own, none per tab (${tabs.windows} windows with the user's)`, tabs.windows <= BOUNDS.fiveTabsOneSessionMaxWindows, tabs.windows);
      check(`...calls p95 under ${BOUNDS.fiveTabsP95Ms} ms (${tabs.p95.toFixed(0)}) and all 250 done in under ${BOUNDS.fiveTabsWallMs} ms (${tabs.wall}): tabs run side by side, not queued`, tabs.p95 <= BOUNDS.fiveTabsP95Ms && tabs.wall <= BOUNDS.fiveTabsWallMs && tabs.calls === 250, `${tabs.p95} ${tabs.wall} ${tabs.calls}`);
      check(`...and nothing left behind after it closes (${tabs.after.count} processes vs ${result.idle.count} at idle)`, tabs.after.count <= result.idle.count + BOUNDS.afterCloseExtraProcesses, tabs.after.count);
      const un = result.unload;
      check(`idle agent tabs are unloaded: ${un.sleeping} of ${un.tabs} (all but the front one)`, un.sleeping >= BOUNDS.unloadedTabs, `${un.sleeping}/${un.tabs}`);
      check(`...which frees at least ${BOUNDS.unloadFreedProcesses} processes (${un.live.count} -> ${un.unloaded.count}) and ${BOUNDS.unloadFreedMb} MB (${(un.live.wsMb - un.unloaded.wsMb).toFixed(0)})`, un.live.count - un.unloaded.count >= BOUNDS.unloadFreedProcesses && un.live.wsMb - un.unloaded.wsMb >= BOUNDS.unloadFreedMb, `${un.live.count - un.unloaded.count} proc ${(un.live.wsMb - un.unloaded.wsMb).toFixed(0)} MB`);
      check('...and an unloaded tab named by tab_id comes back readable', un.wokeReadable, 'still empty after 10 s');
      check(`read_page payload at most ${BOUNDS.readPageBytes} bytes (${result.payload.read_page_bytes})`, result.payload.read_page_bytes <= BOUNDS.readPageBytes, result.payload.read_page_bytes);
      check(`screenshot payload at most ${BOUNDS.screenshotBytes} bytes (${result.payload.screenshot_bytes})`, result.payload.screenshot_bytes <= BOUNDS.screenshotBytes, result.payload.screenshot_bytes);
    }
  } catch (err) {
    failures++;
    console.log(`FAIL  ${err.stack || err}`);
  } finally {
    for (const a of agents) { try { a.child.kill(); } catch {} }
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} failed` : '\nAll mcp perf checks passed.');
  process.exit(failures ? 1 : 0);
})();
