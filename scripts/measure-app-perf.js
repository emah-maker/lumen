/* global document, window, performance, PerformanceObserver, requestAnimationFrame */
// The whole-app performance report: how heavy Lumen is on a LONG-LIVED profile, not a fresh one. Hidden run (LUMEN_TEST_BACKGROUND), throwaway
// profile, no real network (every host resolves to a local stand-in; the widgets, the music engines and TradingView frames all talk to it).
//
//   node scripts/measure-app-perf.js                 seed (cached), then measure with a 1-minute idle window
//   node scripts/measure-app-perf.js --long          the idle window is 10 minutes (memory at 1 and at 10 minutes)
//   node scripts/measure-app-perf.js --idle 120      idle seconds for the CPU sample (default 60)
//   node scripts/measure-app-perf.js --reseed        rebuild the cached seeded profile
//   node scripts/measure-app-perf.js --json [file]   machine-readable output (to the file when one is named)
//   node scripts/measure-app-perf.js --profile       also write a V8 CPU profile of the main process for the idle window (scripts/cpuprofile-top.js reads it)
//   node scripts/measure-app-perf.js --lite|--off    Performance mode forced on / off (default: Auto)
//
// The seeded profile (built once, kept in the temp folder, copied for every run): 30 tabs (local pages, six of them heavy), 50 chats (the newest
// has 60 exchanges; code, tables, math and a mermaid diagram in every fifth reply), every home widget on with stand-in services, two extensions
// from the test fixtures and Lumen's default page-unloading settings.
//
// Prints: startup (first window, interactive, main.js require time, modules), process count and memory at 1 minute (and 10 with --long), idle
// CPU per process, an inventory of every always-on renderer and helper with what it costs, and the cost of the common actions in the UI renderer
// (long tasks, style recalculation, layout) and the main process (event-loop lag).
const { _electron: electron } = require('playwright-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { seed } = require('../test/_chat-seed');
const { buildCrx } = require('../test/fixtures/extensions/build-crx');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (bytes) => Math.round(bytes / 1048576);
const round1 = (n) => Math.round(n * 10) / 10;
const median = (xs) => { const s = xs.filter((x) => x >= 0).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : -1; };

const TABS = 30;
const STAND_PORT = 47931; // fixed: the seeded profile's tab and widget addresses name it
const SEED_DIR = path.join(os.tmpdir(), `lumen-app-perf-seed-v1`);

// ---- the stand-in world ----
// One https server answers every host name (Chromium is told to map all of them here), so a widget, an engine page or a frame never
// leaves the machine. API paths answer JSON; anything else answers a small page. Heavy pages carry a big DOM and a timer.
function certFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-appperf-cert-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  return { dir, key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}
const pageHtml = (n, heavy) => `<!doctype html><title>Page ${n}</title><body><h1>Page ${n}</h1>${'<p>lorem ipsum dolor sit amet</p>'.repeat(200)}${heavy ? `<div id=big>${'<div class=row><span>row</span><b>cell</b><i>x</i></div>'.repeat(4000)}</div><canvas id=c width=300 height=200></canvas><script>
setInterval(() => { document.getElementById('big').children[(Math.random() * 4000) | 0].firstChild.textContent = String(Math.random()); }, 250);
const g = document.getElementById('c').getContext('2d'); let t = 0; (function f() { t++; g.fillStyle = 'hsl(' + (t % 360) + ',60%,50%)'; g.fillRect(0, 0, 300, 200); requestAnimationFrame(f); })();
</script>` : ''}</body>`;
const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Stand-in', 'BEGIN:VEVENT', 'UID:e1', `DTSTART:${new Date(Date.now() + 864e5).toISOString().replace(/[-:]|\.\d+/g, '')}`, 'SUMMARY:Review', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
function forecast(u) {
  const days = Number(u.searchParams.get('forecast_days') || 7);
  const pad = (n) => String(n).padStart(2, '0');
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const times = []; for (let i = 0; i < days * 24; i++) { const d = new Date(start.getTime() + i * 3600e3); times.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`); }
  const dates = [...Array(days).keys()].map((i) => { const d = new Date(start.getTime() + i * 864e5); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; });
  return {
    current: { time: times[0], temperature_2m: 61, apparent_temperature: 59, weather_code: 2, is_day: 1, wind_speed_10m: 9, wind_direction_10m: 220, relative_humidity_2m: 60 },
    hourly: { time: times, temperature_2m: times.map(() => 60), weather_code: times.map(() => 2), is_day: times.map(() => 1), precipitation_probability: times.map(() => 10), precipitation: times.map(() => 0) },
    daily: { time: dates, weather_code: dates.map(() => 2), temperature_2m_max: dates.map(() => 70), temperature_2m_min: dates.map(() => 50), precipitation_probability_max: dates.map(() => 10), precipitation_sum: dates.map(() => 0), wind_speed_10m_max: dates.map(() => 12), sunrise: dates.map((d) => `${d}T06:40`), sunset: dates.map((d) => `${d}T18:10`), uv_index_max: dates.map(() => 5) },
  };
}
function standIn(tls) {
  const hits = { total: 0 };
  const srv = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    hits.total++;
    const u = new URL(req.url, 'https://127.0.0.1');
    const done = (type, body) => { res.setHeader('Content-Type', type); res.setHeader('Access-Control-Allow-Origin', '*'); res.end(body); };
    const m = /^\/(page|heavy)\/(\d+)/.exec(u.pathname);
    if (m) return done('text/html', pageHtml(m[2], m[1] === 'heavy'));
    if (u.pathname.endsWith('.ics') || u.pathname === '/cal') return done('text/calendar', ICS);
    if (u.pathname.includes('forecast')) return done('application/json', JSON.stringify(forecast(u)));
    if (u.pathname.includes('/tasks') || u.pathname.includes('/projects')) return done('application/json', '[]');
    if (/\.(js|css|png|ico)$/.test(u.pathname)) return done('text/plain', '');
    if (u.pathname.startsWith('/v1/') || u.pathname.startsWith('/api')) return done('application/json', '{}');
    return done('text/html', '<!doctype html><title>Stand-in</title><body><h1>Stand-in</h1><p>no network here</p></body>');
  });
  return { srv, hits };
}

// ---- launching ----
const baseEnv = (profile, extra = {}) => ({ ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_SPARES: '1', ...extra });
const launchArgs = (port) => [root, '--ignore-certificate-errors', `--host-resolver-rules=MAP * 127.0.0.1:${port}, EXCLUDE 127.0.0.1`];
const copyDir = (src) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-appperf-')); fs.cpSync(src, dir, { recursive: true }); return dir; };
const removeDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch { /* left in the temp folder */ } };

// ---- seeding ----
async function seedProfile(stand) {
  removeDir(SEED_DIR);
  fs.mkdirSync(SEED_DIR, { recursive: true });
  console.log('seeding: 50 chats...');
  await seed(SEED_DIR, { chats: 50, big: 60 });

  const fixtureA = buildCrx(path.join(root, 'test', 'fixtures', 'extensions', 'popup-ext'));
  const fixtureB = fs.existsSync(path.join(root, 'test', 'fixtures', 'dnr-ext')) ? buildCrx(path.join(root, 'test', 'fixtures', 'dnr-ext')) : null;
  const crxServer = http.createServer((req, res) => { const id = new URL(req.url, 'http://x').searchParams.get('x') || ''; const pick = fixtureB && id.includes(fixtureB.id) ? fixtureB : fixtureA; res.setHeader('Content-Type', 'application/x-chrome-extension'); res.end(pick.crx); });
  await new Promise((r) => crxServer.listen(0, '127.0.0.1', r));

  console.log(`seeding: ${TABS} tabs, widgets, extensions...`);
  const base = `https://127.0.0.1:${stand.port}`;
  const app = await electron.launch({ args: launchArgs(stand.port), env: baseEnv(SEED_DIR, { LUMEN_TEST_WEBSTORE_ORIGIN: `http://127.0.0.1:${crxServer.address().port}` }) });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await sleep(2000);
    await app.evaluate((_e, b) => { global.__widgetEndpoints = Object.fromEntries(['geocode', 'forecast', 'todoist', 'locate', 'spotify', 'spotifyAccounts', 'github', 'coingecko', 'twelvedata', 'muse'].map((k) => [k, `${b}/${k === 'forecast' ? 'forecast' : k}`])); global.__spotifyWebUrl = `${b}/spotify`; global.__appleMusicWebUrl = `${b}/applemusic`; }, base);
    const save = (w) => app.evaluate((_e, x) => global.__widgets.save(x), w).catch((err) => console.log(`  (widget ${w.type} not added: ${String(err.message).slice(0, 80)})`));
    await save({ type: 'weather', city: '', wx: { places: [{ name: 'Boston, Massachusetts, United States', lat: 42.3584, lon: -71.0598 }], units: 'f', days: 7, hours: 24 } });
    await save({ type: 'todoist', token: 'tok_0123456789abcdef0123456789abcdef', todo: { source: 'all', max: 0 } });
    await save({ type: 'calendar', url: `${base}/cal.ics`, colors: 'match' });
    await save({ type: 'embed', title: 'Board', url: `${base}/page/1`, height: 'small', name: 'Board', frameable: true, reason: '' });
    await save({ type: 'tradingview', tv: { view: 'chart', symbol: 'NASDAQ:AAPL', interval: '60', theme: 'dark' } });
    await save({ type: 'tradingview', tv: { view: 'watchlist', symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT'], theme: 'dark' } });
    await save({ type: 'spotify', mode: 'status' });
    await save({ type: 'applemusic', mode: 'status', app: false });
    await save({ type: 'aistatus' });
    await save({ type: 'notes', note: { text: 'seed note' } });
    await save({ type: 'timer' });
    await save({ type: 'countdown', cd: { date: '2030-01-01', time: '', label: 'Later' } });
    for (const kind of ['worldclock', 'feed', 'crypto']) await save({ type: kind });
    for (const x of [fixtureA, fixtureB].filter(Boolean)) await app.evaluate((_e, id) => global.__installExtension(id).catch((err) => err.message), x.id);

    // 30 tabs, six of them heavy.
    for (let i = 1; i <= TABS; i++) {
      const url = `${base}/${i % 5 === 0 ? 'heavy' : 'page'}/${i}`;
      await ui.click('#new-tab');
      await ui.fill('#address', url);
      await ui.press('#address', 'Enter');
      await ui.waitForFunction((n) => document.querySelector('.tab.active .tab-title')?.textContent.includes(`Page ${n}`), i, { timeout: 20000 }).catch(() => {});
    }
    await sleep(1500);
    await app.evaluate(() => { if (global.__settingsFlush) global.__settingsFlush(); });
  } finally {
    await app.close().catch(() => {});
    crxServer.close();
  }
  fs.writeFileSync(path.join(SEED_DIR, '.seeded'), new Date().toISOString());
}

// ---- measuring ----
// Everything the app runs, from Electron's metrics and the OS: per process type, working set and private MB, CPU, and which page or job each is.
async function inventory(app) {
  const rows = await app.evaluate(({ app: a, webContents }) => {
    const owner = new Map();
    for (const wc of webContents.getAllWebContents()) { try { owner.set(wc.getOSProcessId(), { url: wc.getURL().slice(0, 90), kind: wc.getType() }); } catch { /* gone */ } }
    return a.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name || m.serviceName || '', cpu: m.cpu.percentCPUUsage, ws: m.memory.workingSetSize * 1024, priv: (m.memory.privateBytes || 0) * 1024, page: owner.get(m.pid) || null }));
  });
  return rows;
}
function summarise(rows) {
  const by = {};
  for (const r of rows) { const t = by[r.type] ||= { count: 0, wsMB: 0, privMB: 0 }; t.count++; t.wsMB += mb(r.ws); t.privMB += mb(r.priv); }
  return { count: rows.length, wsMB: rows.reduce((s, r) => s + mb(r.ws), 0), privMB: rows.reduce((s, r) => s + mb(r.priv), 0), by };
}
// Child processes of the app that are not Chromium's own (the warm Claude Code / Codex / Grok CLIs and their MCP bridges).
function helperProcesses(pid) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64e6 });
    const all = [].concat(JSON.parse(out));
    const kids = new Set([pid]);
    for (let grew = true; grew;) { grew = false; for (const p of all) if (kids.has(p.ParentProcessId) && !kids.has(p.ProcessId)) { kids.add(p.ProcessId); grew = true; } }
    return all.filter((p) => kids.has(p.ProcessId) && p.ProcessId !== pid && !/--type=/.test(p.CommandLine || '') && !/^(conhost|crashpad)/i.test(p.Name) && !/ -r /.test(p.CommandLine || '')).map((p) => ({ name: p.Name, wsMB: mb(p.WorkingSetSize), cmd: String(p.CommandLine || '').slice(0, 100) }));
  } catch { return []; }
}
async function cpuWindow(app, seconds) {
  await app.evaluate(({ app: a }) => a.getAppMetrics()); // the first sample starts the window
  await sleep(seconds * 1000);
  return app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, cpu: m.cpu.percentCPUUsage, wakeups: m.cpu.idleWakeupsPerSecond })));
}

// The UI renderer's cost of an action: long tasks (>50 ms), and Chromium's own style / layout / script / task time spent (CDP Performance.getMetrics).
async function cdpMetrics(cdp) { const { metrics } = await cdp.send('Performance.getMetrics'); return Object.fromEntries(metrics.map((m) => [m.name, m.value])); }
async function action(app, ui, cdp, label, run, settleMs = 400) {
  await ui.evaluate(() => { window.__lt = []; if (!window.__ltObs) { window.__ltObs = new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration); }); window.__ltObs.observe({ entryTypes: ['longtask'] }); } });
  await app.evaluate(() => global.__perf.loopDelay(true));
  const before = await cdpMetrics(cdp);
  const cpu0 = await app.evaluate(() => process.cpuUsage());
  const t0 = Date.now();
  await run();
  const wall = Date.now() - t0;
  await sleep(settleMs);
  const after = await cdpMetrics(cdp);
  const cpu1 = await app.evaluate(() => process.cpuUsage());
  const lt = await ui.evaluate(() => window.__lt.slice());
  const loop = await app.evaluate(() => global.__perf.loopDelay(true));
  const ms = (k) => Math.round(((after[k] || 0) - (before[k] || 0)) * 1000);
  return { label, wallMs: wall, longTasks: lt.length, longTaskMs: Math.round(lt.reduce((s, x) => s + x, 0)), worstLongTaskMs: Math.round(Math.max(0, ...lt)), styleMs: ms('RecalcStyleDuration'), layoutMs: ms('LayoutDuration'), scriptMs: ms('ScriptDuration'), taskMs: ms('TaskDuration'), mainCpuMs: Math.round((cpu1.user + cpu1.system - cpu0.user - cpu0.system) / 1000), recalcs: Math.round((after.RecalcStyleCount || 0) - (before.RecalcStyleCount || 0)), layouts: Math.round((after.LayoutCount || 0) - (before.LayoutCount || 0)), mainLoopMaxMs: loop.maxMs, mainLoopP99Ms: loop.p99Ms };
}

async function measure(stand) {
  const profile = copyDir(SEED_DIR);
  if (flag('lite') || flag('off')) { const f = path.join(profile, 'settings.json'); const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}; s.performanceMode = flag('lite') ? 'on' : 'off'; fs.writeFileSync(f, JSON.stringify(s)); }
  const base = `https://127.0.0.1:${stand.port}`;
  const out = { seed: { tabs: TABS, chats: 50 }, startup: {}, idle: {} };
  const crxServer = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  await new Promise((r) => crxServer.listen(0, '127.0.0.1', r));
  const launchedAt = Date.now();
  const profileFlag = flag('profile') ? { LUMEN_CPU_PROFILE: '1' } : {};
  const app = await electron.launch({ args: launchArgs(stand.port), env: baseEnv(profile, { LUMEN_TEST_WEBSTORE_ORIGIN: `http://127.0.0.1:${crxServer.address().port}`, ...profileFlag }) });
  try {
    out.startup.launchCallMs = Date.now() - launchedAt;
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    out.startup.firstWindowMs = Date.now() - launchedAt;
    await ui.waitForFunction(() => document.querySelectorAll('.tab').length >= 1 && document.getElementById('prompt') && !document.getElementById('prompt').disabled, null, { timeout: 30000 }).catch(() => {});
    out.startup.interactiveMs = Date.now() - launchedAt;
    out.startup.marks = await app.evaluate(() => global.__perf.marks());
    out.startup.requireTotalMs = await app.evaluate(() => global.__perf.requireTotalMs());
    out.startup.modules = (await app.evaluate(() => global.__perf.modules())).length;
    out.startup.tabsRestored = await ui.evaluate(() => document.querySelectorAll('#tabs .tab').length);
    out.startup.intervals = await app.evaluate(() => global.__perf.intervals());

    const idleSec = Number(value('idle')) || 60;
    const snapshot = async (label) => {
      await sleep(5e3);
      const cpu = await cpuWindow(app, idleSec);
      const rows = await inventory(app);
      const loop = await app.evaluate(() => global.__perf.loopDelay(true));
      const sum = (type) => round1(cpu.filter((r) => r.type === type).reduce((t, r) => t + r.cpu, 0));
      const snap = {
        cpuTotalPct: round1(cpu.reduce((t, r) => t + r.cpu, 0)), cpuMainPct: sum('Browser'), cpuRendererPct: sum('Tab'), cpuGpuPct: sum('GPU'),
        mainLoop: loop, memory: summarise(rows),
        inventory: rows.map((r) => ({ ...r, cpu: round1(cpu.find((c) => c.pid === r.pid)?.cpu ?? r.cpu), wsMB: mb(r.ws), privMB: mb(r.priv) })),
        helpers: helperProcesses(app.process().pid),
        state: await app.evaluate(() => ({ spareNewTab: Boolean(global.__spareNewTab?.ready?.()), spareChat: Boolean(global.__spareChat?.has?.()), sleeping: global.__tabSleep.state().filter((t) => t.sleeping).length, tabs: global.__tabSleep.state().length })),
        contents: await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => { let pid = 0; try { pid = w.getOSProcessId(); } catch { /* none */ } return { type: w.getType(), url: w.getURL().slice(0, 100), pid }; })),
      };
      out.snapshots[label] = snap;
      return snap;
    };
    out.snapshots = {};
    out.idle.seconds = idleSec;
    if (flag('profile')) await app.evaluate(() => { global.__perf.loopDelay(true); });
    await snapshot('fresh');
    if (flag('profile')) { const f = path.join(os.tmpdir(), `lumen-main-idle-${Date.now()}.cpuprofile`); await app.evaluate((_e, file) => global.__perf.stopProfile(file), f); out.profileFile = f; }

    // ---- a session that has been in use: every tab visited (woken), the home page and a chat tab open ----
    const cdp = await ui.context().newCDPSession(ui);
    await cdp.send('Performance.enable');
    out.actions = [];
    const A = out.actions;
    A.push(await action(app, ui, cdp, `wake and visit all ${TABS} tabs`, async () => {
      for (let i = 0; i < TABS; i++) { await ui.evaluate((idx) => document.querySelectorAll('#tabs .tab')[idx]?.click(), i); await sleep(350); }
    }, 1000));
    await ui.click('#new-tab'); await sleep(2500); // the home page, with its widgets
    await app.evaluate(() => global.__pageTools.handleShortcut({ key: 'L', control: true, shift: true })); await sleep(3000); // a chat tab
    await ui.evaluate(() => document.querySelectorAll('#tabs .tab')[0]?.click()); await sleep(500);
    await snapshot('inuse');

    // ---- the common actions in the UI renderer ----
    await app.evaluate(() => { global.__agent.getClient = () => ({ beta: { messages: { stream: () => {
      const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Reply. '.repeat(40) }], usage: { input_tokens: 1000, output_tokens: 200 } };
      return { async *[Symbol.asyncIterator]() { for (let i = 0; i < 40; i++) yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reply. ' } }; }, finalMessage: async () => message };
    } } } }); });
    A.push(await action(app, ui, cdp, 'open a new tab', async () => { await ui.click('#new-tab'); await ui.waitForFunction(() => document.activeElement === document.getElementById('address'), null, { timeout: 5000 }).catch(() => {}); }));
    A.push(await action(app, ui, cdp, 'type 13 characters in the address bar', async () => { await ui.focus('#address'); await ui.keyboard.type('lumen browser', { delay: 20 }); }));
    await ui.keyboard.press('Escape');
    const open = await ui.evaluate(() => document.body.classList.contains('sidebar-open') || Boolean(document.querySelector('#sidebar:not(.hidden)')));
    A.push(await action(app, ui, cdp, `${open ? 'close' : 'open'} the sidebar`, async () => { await ui.click('#toggle-sidebar'); await sleep(900); }));
    A.push(await action(app, ui, cdp, `${open ? 'open' : 'close'} the sidebar`, async () => { await ui.click('#toggle-sidebar'); await sleep(900); }));
    A.push(await action(app, ui, cdp, 'open Settings', async () => { await app.evaluate(() => global.__settings.open('appearance')); await sleep(1800); }));
    await ui.evaluate(() => { document.querySelector('.tab.active .tab-close')?.click(); });
    await sleep(500);
    A.push(await action(app, ui, cdp, 'send a chat message (stub provider)', async () => {
      await ui.evaluate(() => { const p = document.querySelector('#prompt'); p.value = 'hello'; p.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#send').click(); });
      await ui.waitForFunction(() => { const a = document.querySelector('.msg.assistant:not(.streaming)'); return a && a.textContent.includes('Reply.'); }, null, { timeout: 15000 }).catch(() => {});
    }));
    A.push(await action(app, ui, cdp, 'switch through 8 awake tabs', async () => { for (let i = 3; i < 11; i++) { await ui.evaluate((idx) => document.querySelectorAll('#tabs .tab')[idx]?.click(), i); await sleep(250); } }));
    await cdp.detach().catch(() => {});

    if (flag('long')) { await sleep(Math.max(0, launchedAt + 600e3 - Date.now())); await snapshot('after10min'); }
    out.standInHits = stand.hits.total;
  } finally {
    await app.close().catch(() => {});
    crxServer.close();
    removeDir(profile);
  }
  return out;
}

function print(o) {
  const L = (s = '') => console.log(s);
  L('=== STARTUP ===');
  L(`first window ${o.startup.firstWindowMs} ms, interactive ${o.startup.interactiveMs} ms (from launch); marks ${JSON.stringify(o.startup.marks)}`);
  L(`main.js requires ${o.startup.requireTotalMs} ms, ${o.startup.modules} modules, ${o.startup.tabsRestored} tabs restored, ${o.startup.intervals.length} setInterval timers`);
  for (const [label, v] of Object.entries(o.snapshots)) {
    L(`\n=== ${label.toUpperCase()}: ${v.memory.count} processes, ${v.memory.wsMB} MB working set, ${v.memory.privMB} MB private; idle CPU over ${o.idle.seconds} s: ${v.cpuTotalPct}% of a core (main ${v.cpuMainPct}, renderers ${v.cpuRendererPct}, GPU ${v.cpuGpuPct}); main loop ${JSON.stringify(v.mainLoop)}`);
    L(`  by type: ${JSON.stringify(Object.fromEntries(Object.entries(v.memory.by).map(([t, x]) => [t, `${x.count}x ${x.wsMB}MB`])))}   state: ${JSON.stringify(v.state)}`);
    for (const r of [...v.inventory].sort((a, b) => b.wsMB - a.wsMB)) L(`  ${String(r.wsMB).padStart(5)} MB ws ${String(r.privMB).padStart(5)} MB priv ${String(r.cpu).padStart(5)}% cpu  ${r.type.padEnd(8)} ${r.name.padEnd(12)} ${v.contents.filter((c) => c.pid === r.pid).map((c) => `${c.type}:${c.url.replace(/^file:.*\/(src\/.*)$/, '$1')}`).join(' | ').slice(0, 150)}`);
    for (const h of v.helpers) L(`  ${String(h.wsMB).padStart(5)} MB  child ${h.name} ${h.cmd}`);
  }
  L('\n=== ACTIONS (UI renderer: long tasks, style, layout, script; main loop lag) ===');
  for (const a of o.actions) L(`${a.label.padEnd(40)} wall ${String(a.wallMs).padStart(5)} | long tasks ${a.longTasks} (${a.longTaskMs} ms, worst ${a.worstLongTaskMs}) | style ${a.styleMs} ms/${a.recalcs}x layout ${a.layoutMs} ms/${a.layouts}x script ${a.scriptMs} ms task ${a.taskMs} ms | main CPU ${a.mainCpuMs} ms, loop max ${a.mainLoopMaxMs} p99 ${a.mainLoopP99Ms}`);
  if (o.profileFile) L(`\nmain CPU profile: ${o.profileFile}  (node scripts/cpuprofile-top.js <file>)`);
}


async function main() {
  const tls = certFiles();
  const stand = standIn(tls);
  await new Promise((r) => stand.srv.listen(STAND_PORT, '127.0.0.1', r));
  stand.port = stand.srv.address().port;
  try {
    if (flag('reseed') || !fs.existsSync(path.join(SEED_DIR, '.seeded'))) await seedProfile(stand);
    const result = await measure(stand);
    if (flag('json')) { const text = JSON.stringify(result, null, 2); const f = value('json'); if (f) { fs.writeFileSync(f, text); console.log(`wrote ${f}`); } else console.log(text); } else print(result);
  } finally {
    stand.srv.close();
    removeDir(tls.dir);
  }
}
if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
module.exports = { certFiles, standIn, launchArgs, baseEnv, copyDir, removeDir, SEED_DIR, STAND_PORT, inventory, summarise, helperProcesses, cpuWindow, median };
