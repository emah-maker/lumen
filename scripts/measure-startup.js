/* global document */
// Startup and memory measurement for a restored session (hidden window, throwaway profile).
//   node scripts/measure-startup.js [--tabs 25] [--active 3] [--json] [--leak] [--quick] [--no-engine]
// Seeds settings.json with a saved session of N tabs on a local server (artificial size/latency), launches the
// real Lumen main hidden (LUMEN_TEST_BACKGROUND), and prints: UI / active tab load times, main-process
// event-loop delay, memory by process type at steady state, and (--leak) the memory and process count after
// opening and closing 50 tabs. Every run is capped by a hard timeout.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d; };
const TABS = value('tabs', 25);
const ACTIVE = value('active', 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (b) => Math.round(b / 1024);
const hardStop = setTimeout(() => { console.error('hard timeout'); process.exit(2); }, 300000);

const hits = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const n = u.pathname.slice(1);
  hits.push({ n, at: Date.now() });
  const delay = Number(u.searchParams.get('delay') || 60 + ((Number(n) || 0) % 5) * 40); // artificial latency 60-220 ms
  const kb = Number(u.searchParams.get('kb') || 120);
  setTimeout(() => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Page ${n}</title><body><h1>Page ${n}</h1>${'<p>lorem ipsum dolor sit amet consectetur</p>\n'.repeat(Math.round((kb * 1024) / 45))}</body>`);
  }, delay);
});

async function mem(app) {
  const m = await app.evaluate(({ app: a, webContents }) => {
    const urls = new Map(webContents.getAllWebContents().map((w) => [w.getOSProcessId(), (w.getURL() || '').slice(0, 60)]));
    return a.getAppMetrics().map((x) => ({ type: x.type, name: x.name || '', url: urls.get(x.pid) || '', ws: x.memory.workingSetSize, priv: x.memory.privateBytes ?? 0 }));
  });
  const by = {};
  for (const x of m) { const t = by[x.type] ||= { n: 0, wsMB: 0, privMB: 0 }; t.n++; t.wsMB += mb(x.ws); t.privMB += mb(x.priv); }
  return { list: m.map((x) => `${x.type} ${x.name} ${x.url} ws=${mb(x.ws)} priv=${mb(x.priv)}`), procs: m.length, wsMB: mb(m.reduce((s, x) => s + x.ws, 0)), privMB: mb(m.reduce((s, x) => s + x.priv, 0)), by };
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-startup-'));
  const urls = Array.from({ length: TABS }, (_, i) => `${base}/${i}`);
  const session = { urls, titles: urls.map((_, i) => `Page ${i}`), favicons: urls.map(() => null), active: ACTIVE, groupIds: urls.map(() => null), pinned: urls.map(() => false) };
  let settings = {};
  if (flag('real')) {
    // The user's own profile, minus secrets and sessions: extensions, history, favicons, usage log and every setting, so
    // startup does what a normal launch does (AI engine warmups, extension loading, widgets).
    const real = path.join(process.env.APPDATA || os.homedir(), 'Lumen');
    for (const name of [...(flag('no-ext') ? [] : ['Extensions', 'Local Extension Settings']), 'history.json', 'favicons.json', 'usage.json', 'skills.json', 'downloads.json', 'site-activity.json', 'background-tasks.json']) {
      try { fs.cpSync(path.join(real, name), path.join(profile, name), { recursive: true }); } catch { /* not there */ }
    }
    const only = args[args.indexOf('--only-ext') + 1];
    if (flag('only-ext')) for (const d of fs.readdirSync(path.join(profile, 'Extensions'), { withFileTypes: true })) if (!d.name.startsWith(only)) fs.rmSync(path.join(profile, 'Extensions', d.name), { recursive: true, force: true });
    try { settings = JSON.parse(fs.readFileSync(path.join(real, 'settings.json'), 'utf8')); } catch { /* none */ }
    delete settings.keys; delete settings.automationEnabled;
  }
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ ...settings, session }));
  const engine = path.join(process.env.APPDATA || os.homedir(), 'Lumen', 'adblock-engine.bin');
  if (fs.existsSync(engine) && !flag('no-engine')) fs.copyFileSync(engine, path.join(profile, 'adblock-engine.bin'));
  const t0 = Date.now();
  const app = await electron.launch({ args: [path.join(__dirname, '..')], timeout: 60000, env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab', { timeout: 60000 });
    const uiTabMs = Date.now() - t0;
    for (let i = 0; i < 200 && !hits.some((h) => h.n === String(ACTIVE)); i++) await sleep(50);
    await sleep(flag('quick') ? 1500 : 6000);
    // A real run keeps a spare new-tab page and a warm renderer ready once the first tab has loaded; tests leave them off.
    if (!flag('bare')) { await app.evaluate(() => { global.__spareNewTab.enable(true); global.__warmTabs.enable(true); }); await sleep(2500); }
    const out = { tabs: TABS, launchToUiTabMs: uiTabMs };
    out.marks = await app.evaluate(() => global.__perf.marks());
    out.origin = await app.evaluate(() => global.__perf.origin());
    out.loads = (await app.evaluate(() => global.__perf.loads())).filter((l) => /127\.0\.0\.1/.test(l.url));
    out.firstRequestFromProcStartMs = hits.length ? hits[0].at - out.origin : null;
    out.loop = await app.evaluate(() => global.__perf.loopDelay());
    out.activePaint = await app.evaluate(async ({ webContents }, active) => {
      const wc = webContents.getAllWebContents().find((w) => new RegExp(`127\\.0\\.0\\.1:\\d+/${active}$`).test(w.getURL()));
      if (!wc) return null;
      return wc.executeJavaScript('({ origin: performance.timeOrigin, fcp: (performance.getEntriesByName("first-contentful-paint")[0]||{}).startTime })').catch(() => null);
    }, ACTIVE);
    if (out.activePaint?.fcp) out.activeFcpFromProcStartMs = Math.round(out.activePaint.origin + out.activePaint.fcp - out.origin);
    if (process.env.LUMEN_CPU_PROFILE) { await app.evaluate((_m, f) => global.__perf.stopProfile(f), path.join(os.tmpdir(), 'lumen-main.cpuprofile')); console.log('profile written to', path.join(os.tmpdir(), 'lumen-main.cpuprofile')); }
    out.activeRequests = hits.filter((h) => h.n === String(ACTIVE)).length;
    out.memory = await mem(app);
    out.mainMem = await app.evaluate(() => { const m = process.memoryUsage(); const mb = (b) => Math.round(b / 1048576); return { rss: mb(m.rss), heapUsed: mb(m.heapUsed), heapTotal: mb(m.heapTotal), external: mb(m.external), arrayBuffers: mb(m.arrayBuffers) }; });
    out.contents = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => `${w.getType()}:${w.getOSProcessId()}:${(w.getURL() || '').slice(0, 70)}`));
    const navAt = Date.now();
    await ui.click('#new-tab'); await ui.fill('#address', `${base}/900`); await ui.press('#address', 'Enter');
    await ui.waitForFunction(() => document.querySelector('.tab.active .tab-title')?.textContent.includes('Page 900'), null, { timeout: 15000 });
    out.newTabNavMs = Date.now() - navAt;
    const wakeAt = Date.now();
    await ui.evaluate(() => [...document.querySelectorAll('.tab')].find((t) => /Page 10\b/.test(t.textContent))?.click());
    for (let i = 0; i < 200; i++) { const done = await app.evaluate(({ webContents }) => webContents.getAllWebContents().some((w) => /\/10$/.test(w.getURL()) && !w.isLoading())); if (done) break; await sleep(25); }
    out.wakePlaceholderTabMs = Date.now() - wakeAt;
    if (flag('sleep')) {
      // Open 6 more tabs, then put every background tab to sleep: the renderers must go.
      for (let i = 0; i < 6; i++) { await ui.click('#new-tab'); await ui.fill('#address', `${base}/${2000 + i}`); await ui.press('#address', 'Enter'); await sleep(400); }
      await sleep(2500);
      out.awake = await mem(app);
      const slept = await app.evaluate(async () => { const st = global.__tabSleep.state(); let n = 0; for (const t of st) if (t.view && !t.sleeping) { try { await global.__tabSleep.sleepNow(t.id); n++; } catch { /* active tab */ } } return n; });
      await sleep(4000);
      out.asleep = await mem(app);
      out.sleptTabs = slept;
    }
    if (flag('leak')) {
      await sleep(3000);
      out.firstLeakId = Math.max(...(await app.evaluate(() => global.__tabSleep.state().map((t) => t.id)))) + 1;
      out.beforeLeak = await mem(app);
      for (let round = 0; round < 5; round++) {
        for (let i = 0; i < 10; i++) { await ui.click('#new-tab'); await ui.fill('#address', `${base}/${1000 + round * 10 + i}`); await ui.press('#address', 'Enter'); await sleep(120); }
        await sleep(1500);
        const ids = await app.evaluate(() => global.__tabSleep.state().map((t) => t.id));
        const keep = out.keepIds ||= ids.filter((id) => id < out.firstLeakId);
        for (const id of ids.filter((x) => !keep.includes(x))) { await app.evaluate((_m, tid) => global.__closeTabInteractive(tid), id); await sleep(80); }
      }
      await sleep(8000);
      out.afterLeak = await mem(app);
    }
    if (flag('json')) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(`tabs ${TABS}; strip visible ${uiTabMs} ms after launch; marks ${JSON.stringify(out.marks)}`);
      console.log(`first request at ${out.firstRequestFromProcStartMs} ms; active tab FCP ${out.activeFcpFromProcStartMs} ms (both from process start)`);
      console.log('page loads (start/finish ms):', out.loads.map((l) => `${l.url.split('/').pop()}:${l.start}/${l.finish}`).join(' '));
      console.log(`requests for the front page: ${out.activeRequests} (2 = reloaded once for a late extension)`);
      console.log(`event loop (main): ${JSON.stringify(out.loop)}`);
      console.log(`memory: ${out.memory.procs} procs ${out.memory.wsMB} MB ws ${out.memory.privMB} MB private ${JSON.stringify(out.memory.by)}`);
      console.log(`processes:\n  ${out.memory.list.join('\n  ')}`);
      console.log(`main process: ${JSON.stringify(out.mainMem)}`);
      console.log(`web contents:\n  ${out.contents.join('\n  ')}`);
      console.log(`new tab navigation ${out.newTabNavMs} ms; wake restored tab ${out.wakePlaceholderTabMs} ms`);
      if (out.asleep) console.log(`sleep check: ${out.sleptTabs} tabs slept; before ${out.awake.procs} procs ${out.awake.wsMB} MB -> after ${out.asleep.procs} procs ${out.asleep.wsMB} MB`);
      if (out.afterLeak) console.log(`leak check: before ${out.beforeLeak.procs} procs ${out.beforeLeak.wsMB} MB -> after ${out.afterLeak.procs} procs ${out.afterLeak.wsMB} MB`);
    }
  } finally {
    await app.close().catch(() => {});
    server.close();
    clearTimeout(hardStop);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* temp dir */ }
  }
})().catch((e) => { console.error(e); process.exit(1); });
