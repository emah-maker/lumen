// [igpu] Measures what Lumen costs the GPU process on an integrated GPU (Windows only), hidden (LUMEN_TEST_BACKGROUND), a fresh profile.
//   node test/_igpu-measure.js [scenario ...]      (no names: all of them)   LUMEN_IGPU_SECONDS=8   LUMEN_IGPU_GRAPHICS=full|light|auto
// For each scenario: GPU 3D utilization of the app's GPU process(es) (Windows performance counters `GPU Engine(pid_N_*engtype_3D)`, summed
// over the 3D engines, sampled by a PowerShell child), the GPU process's shared memory, its CPU time, and the frame pacing of the UI and of the
// page's renderer (rAF intervals; long-animation-frame entries; main-process setImmediate gaps), measured in a second pass so the probe's own
// frame requests never colour the GPU numbers. Also exports the rig for test/igpu-perf.js.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = process.env.LUMEN_IGPU_ROOT || path.join(__dirname, '..'); // (LUMEN_IGPU_ROOT: another checkout, the code before a change)

// The user's setup: a 2560x1600 panel; the new-tab page with a sunset gradient, many large fast white particles, frosted widget cards.
const USER_SETTINGS = {
  sidebarNewChat: false, performanceMode: 'off', accentColor: 'purple', tabSleepHow: 'freeze',
  newTabBackground: 'sunset', newTabEffect: 'particles', newTabEffectAmount: 'many', newTabEffectSpeed: 'fast', newTabEffectSize: 'large', newTabEffectColor: '#ffffff',
  newTabWidgetGlass: 'frosted',
  homeWidgets: [
    { id: 'wweath01', type: 'weather', title: '', span: 3, place: 'Boston, Massachusetts, United States', lat: 42.3584, lon: -71.0598, units: 'f' },
    { id: 'wcal00001', type: 'calendar', title: '', span: 3, url: 'http://127.0.0.1:9/cal.ics', name: 'Calendar', count: 5 },
    { id: 'wfeed0001', type: 'feed', title: '', span: 3, url: 'http://127.0.0.1:9/feed.xml', name: 'Feed', count: 5 },
    { id: 'wtodo0001', type: 'todoist', title: '', span: 3 },
  ],
};

// ---- GPU counters
const psSampler = (pids, seconds) => {
  const engine = pids.map((p) => `'\\GPU Engine(pid_${p}_*engtype_3D)\\Utilization Percentage'`).join(',');
  const mem = pids.map((p) => `'\\GPU Process Memory(pid_${p}*)\\Shared Usage'`).join(',');
  const script = `$ErrorActionPreference='SilentlyContinue'
Get-Counter -Counter @(${engine},${mem}) -SampleInterval 1 -MaxSamples ${seconds + 1} | ForEach-Object {
  $e = 0.0; $m = 0.0
  foreach ($s in $_.CounterSamples) { if ($s.Path -like '*gpu engine*') { $e += $s.CookedValue } else { $m += $s.CookedValue } }
  Write-Output ('S ' + [math]::Round($e, 3) + ' ' + [math]::Round($m / 1MB, 2))
}`;
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const samples = []; let buf = ''; let onFirst = null;
  const first = new Promise((r) => { onFirst = r; });
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = /^S ([\d.]+) ([\d.]+)/.exec(buf.slice(0, i).trim()); buf = buf.slice(i + 1);
      if (m) { samples.push({ e: +m[1], m: +m[2] }); if (samples.length === 1) onFirst(); }
    }
  });
  const done = new Promise((r) => child.on('exit', r));
  return { child, samples, first, done };
};

// Another agent runs hidden tests in parallel (another worktree's electron.exe): a measurement taken beside them is noise, so wait until none runs.
// (Called only between launches of our own, when none of ours is alive.)
async function waitForQuiet(maxMs = 30 * 60e3) {
  const end = Date.now() + maxMs; let told = false;
  const running = () => new Promise((r) => { const c = spawn('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/NH'], { windowsHide: true }); let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('exit', () => r(/electron.exe/i.test(o))); c.on('error', () => r(false)); });
  while (await running()) { if (!told) { console.log('waiting: another electron.exe is running'); told = true; } if (Date.now() > end) throw new Error('another electron.exe kept running'); await sleep(5000); }
  await sleep(1500); // (and a moment after it went, for the GPU to settle)
}

// ---- the rig: one app per configuration
async function launch({ settings = {}, size = [2560, 1600], quiet = true, args = [] } = {}) {
  if (quiet) await waitForQuiet();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-igpu-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ ...USER_SETTINGS, ...settings }));
  const app = await electron.launch({ args: [ROOT, ...args], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const rig = { app, ui, profile, size };
  rig.dpr = await ui.evaluate(() => devicePixelRatio);
  // Content size in CSS pixels that makes the panel's physical size: 2560x1600 at the display's scale.
  rig.resize = (w = size[0], h = size[1]) => app.evaluate(({ BrowserWindow }, [a, b]) => BrowserWindow.getAllWindows()[0].setContentSize(a, b), [Math.round(w / rig.dpr), Math.round(h / rig.dpr)]);
  await rig.resize();
  await sleep(800);
  rig.set = (key, value) => app.evaluate((_e, [k, v]) => global.__settings.backend.set(k, v).then(() => 'ok', (err) => `ERROR ${err.message}`), [key, value]);
  rig.metrics = () => app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, cpu: m.cpu.cumulativeCPUUsage, mem: m.memory?.workingSetSize || 0 })));
  rig.gpuPids = async () => (await rig.metrics()).filter((m) => m.type === 'GPU').map((m) => m.pid);
  rig.gpuInfo = () => app.evaluate(async ({ app: a }) => { const i = await a.getGPUInfo('complete'); return i.gpuDevice.map((d) => ({ vendor: d.vendorId, name: d.deviceString || '', active: !!d.active })); });
  rig.close = async () => { await app.close().catch(() => {}); try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp */ } };
  // The first tab's web contents (the page tab) and a way to run in it.
  rig.tabEval = (js, i = 0) => app.evaluate(({ webContents }, [c, n]) => { const t = global.__windows.list()[0].tabs[n]; return webContents.fromId(t.contentsId).executeJavaScript(c); }, [js, i]);
  rig.load = async (url, i = 0) => { await app.evaluate(({ webContents }, [u, n]) => { const t = global.__windows.list()[0].tabs[n]; return webContents.fromId(t.contentsId).loadURL(u); }, [url, i]); await sleep(1200); };
  // A new-tab page in a tab of its own, in front; `global.__home` is it.
  rig.openHome = async () => {
    await app.evaluate(async () => { const t = global.__agent.browser.openTab(); await new Promise((r) => t.webContents.once('did-finish-load', r)); global.__home = t; });
    for (let i = 0; i < 80 && !(await rig.home('Boolean(window.setBackdropEffect?.info?.())').catch(() => false)); i++) await sleep(100);
  };
  rig.home = (js) => app.evaluate((_e, c) => global.__home.webContents.executeJavaScript(c), js);
  return rig;
}

// Frame pacing probes. `where`: 'ui' | 'page' (the front tab's own contents; for the new-tab page: global.__home).
const PROBE = `(() => {
  if (window.__pace) { window.__pace.reset(); return true; }
  const p = window.__pace = { iv: [], loaf: [], last: 0, on: false, reset() { this.iv = []; this.loaf = []; this.last = 0; this.on = true; } };
  try { new PerformanceObserver((l) => { if (p.on) for (const e of l.getEntries()) p.loaf.push(Math.round(e.duration)); }).observe({ type: 'long-animation-frame', buffered: false }); } catch (e) { p.noLoaf = true; }
  const f = (t) => { if (p.on) { if (p.last) p.iv.push(t - p.last); p.last = t; } requestAnimationFrame(f); };
  requestAnimationFrame(f); p.on = true; return true; })()`;
const READ = `(() => { const p = window.__pace; p.on = false; const iv = p.iv.slice().sort((a, b) => a - b); const med = iv.length ? iv[iv.length >> 1] : 0;
  return { n: iv.length, medianMs: +med.toFixed(2), maxMs: iv.length ? +iv[iv.length - 1].toFixed(1) : 0, missed: med ? iv.filter((x) => x > med * 1.75).length : 0, loaf: p.loaf.length, loafMaxMs: Math.max(0, ...p.loaf) }; })()`;

// A gap probe in the main process: setImmediate/timer lateness (ms) over the run; stop() returns { max, p99 }.
const mainGapStart = (app) => app.evaluate(() => { const g = global.__gap = { max: 0, list: [], on: true }; let last = Date.now(); (function tick() { if (!g.on) return; const now = Date.now(); const d = now - last - 10; last = now; g.list.push(d); if (d > g.max) g.max = d; setTimeout(tick, 10); })(); return true; });
const mainGapStop = (app) => app.evaluate(() => { const g = global.__gap; g.on = false; const l = g.list.slice().sort((a, b) => a - b); return { max: g.max, p99: l.length ? l[Math.floor(l.length * 0.99)] : 0 }; });

// Runs `action(seconds)` while sampling the GPU process for `seconds`; returns the averages.
async function measure(rig, seconds, action) {
  const pids = await rig.gpuPids();
  const before = await rig.metrics();
  const sampler = psSampler(pids, seconds);
  await Promise.race([sampler.first, sleep(15000)]);
  const t0 = Date.now();
  const mark = sampler.samples.length;
  await action(seconds);
  const rest = seconds * 1000 - (Date.now() - t0);
  if (rest > 0) await sleep(rest);
  const after = await rig.metrics();
  const wall = (Date.now() - t0) / 1000;
  const got = sampler.samples.slice(mark, mark + seconds);
  try { sampler.child.kill(); } catch { /* done */ }
  const cpu = (list, types) => list.filter((m) => types.includes(m.type)).reduce((s, m) => s + m.cpu, 0);
  const avg = (k) => (got.length ? got.reduce((s, x) => s + x[k], 0) / got.length : NaN);
  return {
    samples: got.length, gpu3dPct: +avg('e').toFixed(2), gpu3dMax: +Math.max(0, ...got.map((x) => x.e)).toFixed(2), sharedMB: +avg('m').toFixed(1),
    gpuCpuPct: +(((cpu(after, ['GPU']) - cpu(before, ['GPU'])) / wall) * 100).toFixed(2),
    rendCpuPct: +(((cpu(after, ['Tab']) - cpu(before, ['Tab'])) / wall) * 100).toFixed(2),
    series: got.map((x) => x.e),
  };
}

// Frame pacing of the UI and of `pageEval` (a function running JS in the front page's renderer) over `ms` while `action` runs.
async function pacing(rig, ms, action, pageEval) {
  await rig.ui.evaluate(PROBE);
  if (pageEval) await pageEval(PROBE);
  await mainGapStart(rig.app);
  await action(ms / 1000);
  await sleep(Math.max(0, ms - 0));
  const ui = await rig.ui.evaluate(READ);
  const page = pageEval ? await pageEval(READ) : null;
  return { ui, page, main: await mainGapStop(rig.app) };
}

// ---- scenarios. Each: { name, setup(rig, ctx), action(rig, ctx)(seconds), page(rig, ctx) -> evaluator }
const HEAVY = `<!doctype html><title>Heavy</title><style>
body{margin:0;font:14px system-ui;background:#f4f4f8}.card{margin:12px;padding:20px;border-radius:16px;background:linear-gradient(135deg,#fff,#e8e8ff);box-shadow:0 8px 30px rgba(0,0,0,.18),0 2px 6px rgba(0,0,0,.1)}
.card img,.card .sw{width:100%;height:120px;border-radius:10px;background:linear-gradient(90deg,#f66,#6af,#6f9);filter:saturate(1.3)}.glass{backdrop-filter:blur(12px);background:rgba(255,255,255,.4)}
</style><body>${Array.from({ length: 600 }, (_, i) => `<div class="card ${i % 7 === 0 ? 'glass' : ''}"><div class="sw" style="filter:hue-rotate(${i * 9}deg)"></div><h3>Section ${i}</h3><p>${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(6)}</p></div>`).join('')}</body>`;
const PLAIN = '<!doctype html><title>Plain</title><body style="font:16px system-ui;margin:40px"><h1>A plain page</h1><p>' + 'Some text. '.repeat(200) + '</p></body>';

function startServer(extra = {}) {
  const posted = {};
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/save/')) { const parts = []; req.on('data', (d) => parts.push(d)); req.on('end', () => { posted[req.url.slice(6)] = Buffer.concat(parts); res.end('ok'); }); return; }
    if (req.url.startsWith('/video.webm') && posted['v.webm']) { res.setHeader('Content-Type', 'video/webm'); res.end(posted['v.webm']); return; }
    const pages = { '/plain': PLAIN, '/heavy': HEAVY, ...extra };
    const page = pages[req.url.split('?')[0]];
    if (page) { res.setHeader('Content-Type', 'text/html'); res.end(page); } else { res.statusCode = 404; res.end('no'); }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}`, posted })));
}

const GEN = `<!doctype html><title>gen</title><canvas id=c width=1280 height=720></canvas><script>
const c=document.getElementById('c'),x=c.getContext('2d');let k=0;(function f(){x.fillStyle='hsl('+((k*4)%360)+',80%,55%)';x.fillRect(0,0,1280,720);for(let i=0;i<12;i++){x.fillStyle='hsl('+((k*3+i*30)%360)+',70%,'+(30+i*3)+'%)';x.fillRect((k*7+i*90)%1200,40+i*50,120,60);}k++;requestAnimationFrame(f);})();
window.__done=(async()=>{const r=new MediaRecorder(c.captureStream(30),{mimeType:'video/webm;codecs=vp9',videoBitsPerSecond:3000000});const parts=[];r.ondataavailable=(e)=>parts.push(e.data);const d=new Promise((res)=>{r.onstop=res;});r.start(250);await new Promise((res)=>setTimeout(res,3000));r.stop();await d;await fetch('/save/v.webm',{method:'POST',body:new Blob(parts,{type:'video/webm'})});return 'ok';})();
</script>`;
const VIDEO = '<!doctype html><title>Video</title><body style="margin:0;background:#000"><video id=v src="/video.webm" autoplay loop muted playsinline style="width:100vw;height:100vh"></video><script>const v=document.getElementById("v");v.addEventListener("ended",()=>{v.currentTime=0;v.play();});</script>';

const wheel = (rig, seconds) => rig.app.evaluate(async ({ webContents }, secs) => {
  const t = global.__windows.list()[0].tabs[0]; const wc = webContents.fromId(t.contentsId); const end = Date.now() + secs * 1000; let dir = -1;
  while (Date.now() < end) { for (let i = 0; i < 40 && Date.now() < end; i++) { wc.sendInputEvent({ type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY: dir * 120, canScroll: true }); await new Promise((r) => setTimeout(r, 16)); } dir = -dir; }
}, seconds);

const toggleSidebar = async (rig, n) => {
  for (let i = 0; i < n; i++) { await rig.ui.evaluate(() => document.getElementById('toggle-sidebar').click()); await sleep(450); }
};

// A fake model that streams for a while (cf. test/sidebar-keeps-run.js fakeModel).
const streamingModel = (app) => app.evaluate(() => {
  global.__agent.getClient = () => ({ beta: { messages: { stream: () => {
    const text = Array.from({ length: 200 }, (_, i) => `word${i} `).join('');
    const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 5 } };
    return {
      async *[Symbol.asyncIterator]() { for (let i = 0; i < 200; i++) { yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `word${i} ` } }; await new Promise((r) => setTimeout(r, 40)); } },
      finalMessage: async () => message,
    };
  } } } });
});

const SCENARIOS = [
  { name: 'idle-page', label: '1 idle, plain web page', setup: async (rig, c) => { await rig.load(`${c.base}/plain`); }, action: () => async (s) => { await sleep(s * 1000); }, page: (rig) => (js) => rig.tabEval(js) },
  { name: 'scroll-heavy', label: '2 scrolling a heavy page', setup: async (rig, c) => { await rig.load(`${c.base}/heavy`); }, action: (rig) => (s) => wheel(rig, s), page: (rig) => (js) => rig.tabEval(js) },
  { name: 'newtab-user', label: '3 new tab, user settings', home: true, action: () => async (s) => { await sleep(s * 1000); }, page: (rig) => (js) => rig.home(js) },
  { name: 'newtab-no-particles', label: '4 new tab, particles off', home: true, settings: { newTabEffect: 'none' }, action: () => async (s) => { await sleep(s * 1000); }, page: (rig) => (js) => rig.home(js) },
  { name: 'newtab-no-glass', label: '5 new tab, glass off', home: true, settings: { newTabWidgetGlass: 'solid' }, action: () => async (s) => { await sleep(s * 1000); }, page: (rig) => (js) => rig.home(js) },
  { name: 'sidebar-x10', label: '6 sidebar open/close x10', setup: async (rig, c) => { await rig.load(`${c.base}/plain`); }, action: (rig) => async () => { await toggleSidebar(rig, 20); }, page: (rig) => (js) => rig.tabEval(js), seconds: 10 },
  {
    name: 'tabs-x30', label: '7 switching 6 tabs x30',
    setup: async (rig, c) => {
      await rig.load(`${c.base}/plain`);
      for (let i = 1; i < 6; i++) { await rig.app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => t.webContents.once('did-finish-load', r)); }, i % 2 ? `${c.base}/heavy` : `${c.base}/plain`); }
    },
    action: (rig) => async () => { for (let i = 0; i < 30; i++) { await rig.app.evaluate((_e, n) => { const ids = global.__windows.list()[0].tabs.map((t) => t.id); global.__agent.browser.switchTab(ids[n % ids.length]); }, i); await sleep(280); } },
    page: () => null, seconds: 9,
  },
  {
    name: 'sidebar-stream', label: '8 typing while a reply streams',
    setup: async (rig, c) => { await rig.load(`${c.base}/plain`); await streamingModel(rig.app); await rig.ui.evaluate(() => { if (document.getElementById('toggle-sidebar').getAttribute('aria-pressed') !== 'true') document.getElementById('toggle-sidebar').click(); }); await sleep(900); await rig.ui.fill('#prompt', 'stream please'); await rig.ui.press('#prompt', 'Enter'); await sleep(600); },
    action: (rig) => async (s) => { const end = Date.now() + s * 1000; await rig.ui.click('#prompt').catch(() => {}); while (Date.now() < end) { await rig.ui.keyboard.type('hello there', { delay: 60 }); await rig.ui.keyboard.press('Control+A'); await rig.ui.keyboard.press('Backspace'); } },
    page: () => null,
  },
  {
    name: 'video', label: '9 playing a video',
    setup: async (rig, c) => { await rig.load(`${c.base}/gen`); for (let i = 0; i < 60 && !c.posted['v.webm']; i++) await sleep(250); await rig.load(`${c.base}/video`); await sleep(1500); },
    action: () => async (s) => { await sleep(s * 1000); }, page: (rig) => (js) => rig.tabEval(js),
  },
];

// Runs one scenario on `rig` (settings applied through the real setting, as a user would); returns { gpu, pace }.
async function runScenario(rig, sc, ctx, seconds) {
  if (sc.settings) for (const [k, v] of Object.entries(sc.settings)) await rig.set(k, v);
  if (sc.home) await rig.openHome(); else if (sc.setup) await sc.setup(rig, ctx);
  await sleep(2500); // (settle: the 10 s backdrop drift on the new-tab page is part of what a user sees first, so it is measured after it)
  if (sc.home) await sleep(9000);
  const secs = sc.seconds || seconds;
  const act = sc.action(rig, ctx);
  const gpu = await measure(rig, secs, act);
  const pace = await pacing(rig, secs * 500, act, sc.page ? sc.page(rig, ctx) : null);
  return { gpu, pace };
}

module.exports = { waitForQuiet, launch, measure, pacing, runScenario, SCENARIOS, USER_SETTINGS, startServer, GEN, VIDEO, PROBE, READ, sleep, streamingModel };

if (require.main === module) {
  (async () => {
    const seconds = Number(process.env.LUMEN_IGPU_SECONDS) || 8;
    const graphics = process.env.LUMEN_IGPU_GRAPHICS || null;
    const wanted = process.argv.slice(2);
    const list = SCENARIOS.filter((s) => !wanted.length || wanted.includes(s.name));
    const ctx = await startServer({ '/gen': GEN, '/video': VIDEO });
    const rows = [];
    for (const sc of list) {
      // (a fresh app per scenario: no scenario leaves tabs, effects or caches to the next)
      const rig = await launch({ settings: { ...(sc.settings || {}), ...(graphics ? { graphicsMode: graphics } : {}) } });
      try {
        if (!rows.length) console.log('GPU devices:', JSON.stringify(await rig.gpuInfo()), 'dpr', rig.dpr, 'gpu pids', await rig.gpuPids());
        const r = await runScenario(rig, { ...sc, settings: undefined }, ctx, seconds);
        const row = { scenario: sc.label, ...r.gpu, uiMissed: r.pace.ui.missed, uiMaxMs: r.pace.ui.maxMs, uiLoaf: r.pace.ui.loaf, pageMissed: r.pace.page?.missed ?? '-', pageLoaf: r.pace.page?.loaf ?? '-', mainGapMax: r.pace.main.max };
        delete row.series;
        rows.push(row);
        console.log(JSON.stringify(row));
      } catch (e) { console.log(`ERROR ${sc.name}: ${e.message}`); } finally { await rig.close(); }
    }
    ctx.server.close();
    console.table(rows);
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
