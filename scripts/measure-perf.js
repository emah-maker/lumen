/* global document, window, requestAnimationFrame, MutationObserver, PerformanceObserver, performance */
// Measures Lumen's startup, memory, idle CPU and interaction cost on this machine and prints a table.
//   node scripts/measure-perf.js                 startup, timers, memory at 1/5/15 tabs, idle CPU
//   node scripts/measure-perf.js --throttle 6    also: sidebar / send / tab switch / Settings with the UI and tabs
//                                                slowed by that CPU factor (CDP Emulation.setCPUThrottlingRate)
//   node scripts/measure-perf.js --gpu-off       launch with --disable-gpu (a machine with no usable GPU)
//   node scripts/measure-perf.js --json          machine-readable output
// Runs the development copy in a throwaway profile with an invisible window (LUMEN_TEST_BACKGROUND). If a
// real profile's adblock-engine.bin exists it is copied in, so startup includes loading a cached filter
// engine like a normal launch does (LUMEN_ADBLOCK_CACHE overrides the path).
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : null; };
const THROTTLE = Number(value('throttle')) || 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (kb) => Math.round(kb / 1024);

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  const n = req.url.slice(1);
  res.end(`<!doctype html><title>Page ${n}</title><body><h1>Page ${n}</h1>${'<p>lorem ipsum dolor sit amet</p>'.repeat(200)}</body>`);
});

// Processes by type, in MB: working set (what Task Manager calls memory) and private bytes when reported.
async function memory(app) {
  const metrics = await app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => ({
    type: m.type, cpu: m.cpu.percentCPUUsage, ws: m.memory.workingSetSize, priv: m.memory.privateBytes ?? 0,
  })));
  const by = {};
  for (const m of metrics) {
    const t = by[m.type] ||= { count: 0, ws: 0, priv: 0, cpu: 0 };
    t.count++; t.ws += m.ws; t.priv += m.priv; t.cpu += m.cpu;
  }
  const total = { count: metrics.length, ws: mb(metrics.reduce((s, m) => s + m.ws, 0)), priv: mb(metrics.reduce((s, m) => s + m.priv, 0)) };
  return { total, by: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { count: v.count, wsMB: mb(v.ws), privMB: mb(v.priv), cpu: Math.round(v.cpu * 10) / 10 }])) };
}

async function idleCpu(app, seconds) {
  await app.evaluate(({ app: a }) => a.getAppMetrics()); // first sample resets the window
  await sleep(seconds * 1000);
  const m = await app.evaluate(({ app: a }) => a.getAppMetrics().map((x) => x.cpu.percentCPUUsage));
  return Math.round(m.reduce((s, x) => s + x, 0) * 10) / 10;
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-perf-'));
  const engine = process.env.LUMEN_ADBLOCK_CACHE || path.join(process.env.APPDATA || os.homedir(), 'Lumen', 'adblock-engine.bin');
  const haveEngine = fs.existsSync(engine);
  if (haveEngine) fs.copyFileSync(engine, path.join(profile, 'adblock-engine.bin'));

  const launchedAt = Date.now();
  const app = await electron.launch({
    args: [path.join(__dirname, '..'), ...(flag('gpu-off') ? ['--disable-gpu'] : [])],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const uiVisibleMs = Date.now() - launchedAt;
  await sleep(2000);

  const out = { engineCached: haveEngine, gpuOff: flag('gpu-off'), uiVisibleFromLaunchMs: uiVisibleMs };
  out.marks = await app.evaluate(() => global.__perf.marks());
  out.requires = await app.evaluate(() => global.__perf.requires().sort((a, b) => b.ms - a.ms).slice(0, 8));
  out.requireTotalMs = await app.evaluate(() => global.__perf.requireTotalMs());
  out.intervals = await app.evaluate(() => global.__perf.intervals());
  out.moduleList = await app.evaluate(() => global.__perf.modules());
  out.modules = out.moduleList.length;
  const uiFiles = await ui.evaluate(() => [...document.scripts].map((s) => s.src).concat([...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href)).filter(Boolean));
  out.uiScripts = uiFiles.map((u) => { const f = decodeURIComponent(new URL(u).pathname.replace(/^\//, '')); return { name: path.basename(f), kb: Math.round(fs.statSync(f).size / 1024) }; });
  out.preloadBundleKB = Math.round(fs.statSync(path.join(__dirname, '..', 'preload.bundle.js')).size / 1024);

  // Memory with 1, 5, 15 tabs (the first is the new-tab page; each other tab loads a local page).
  const openTab = async (n) => {
    await ui.click('#new-tab');
    await ui.fill('#address', `${base}/${n}`);
    await ui.press('#address', 'Enter');
    await ui.waitForFunction((n2) => document.querySelector('.tab.active .tab-title')?.textContent.includes(`Page ${n2}`), n, { timeout: 15000 });
  };
  out.memory = { tabs1: await memory(app) };
  for (let i = 1; i < 5; i++) await openTab(i);
  await sleep(2000);
  out.memory.tabs5 = await memory(app);
  for (let i = 5; i < 15; i++) await openTab(i);
  await sleep(3000);
  out.memory.tabs15 = await memory(app);
  out.idleCpuPct15Tabs = await idleCpu(app, 10);
  out.sleeping = await app.evaluate(() => global.__tabSleep.state().filter((t) => t.sleeping).length);

  if (THROTTLE > 1) {
    // Slow the browser UI's renderer (the sidebar, tab strip, Settings shell) by THROTTLE x, and the tab renderers too.
    const cdp = await ui.context().newCDPSession(ui);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    const inPage = (fn, arg) => ui.evaluate(fn, arg);
    const longTasks = () => inPage(() => { window.__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ entryTypes: ['longtask'] }); });
    await longTasks();
    const worst = () => inPage(() => Math.round(Math.max(0, ...(window.__lt || []))));
    const reset = () => inPage(() => { window.__lt = []; });
    const t = {};
    // Click to the next painted frame.
    const clickToPaint = (sel) => inPage((s) => new Promise((resolve) => {
      const t0 = performance.now();
      document.querySelector(s).click();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round(performance.now() - t0))));
    }), sel);
    await reset();
    t.openSidebarMs = await clickToPaint('#toggle-sidebar');
    await sleep(1200);
    t.sidebarWorstLongTaskMs = await worst();
    // Send a message through a fake provider: click send to the assistant's reply on screen.
    await app.evaluate(() => {
      global.__agent.getClient = () => ({ beta: { messages: { stream: () => {
        const text = 'Reply. '.repeat(40);
        const message = { role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 200 } };
        return { async *[Symbol.asyncIterator]() { for (let i = 0; i < 40; i++) yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reply. ' } }; }, finalMessage: async () => message };
      } } } });
    });
    await reset();
    t.sendMessageMs = await inPage(() => new Promise((resolve) => {
      const prompt = document.querySelector('#prompt');
      prompt.value = 'hello';
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      const t0 = performance.now();
      const seen = new MutationObserver(() => {
        const a = document.querySelector('.msg.assistant:not(.streaming)');
        if (a && a.textContent.includes('Reply.')) { seen.disconnect(); resolve(Math.round(performance.now() - t0)); }
      });
      seen.observe(document.querySelector('#messages'), { childList: true, subtree: true, characterData: true, attributes: true });
      document.querySelector('#send').click();
    }));
    t.sendWorstLongTaskMs = await worst();
    // Switch through 10 tabs; the time is click to the strip showing that tab active.
    await reset();
    const switchTimes = [];
    for (let i = 4; i < 14; i++) {
      switchTimes.push(await inPage((idx) => new Promise((resolve) => {
        const tabs = [...document.querySelectorAll('.tab')];
        const t0 = performance.now();
        const seen = new MutationObserver(() => { if (tabs[idx].classList.contains('active')) { seen.disconnect(); resolve(Math.round(performance.now() - t0)); } });
        seen.observe(document.querySelector('#tabs'), { attributes: true, subtree: true, childList: true });
        tabs[idx].click();
        setTimeout(() => { seen.disconnect(); resolve(-1); }, 5000);
      }), i));
      await sleep(150);
    }
    t.switchTabMsMedian = switchTimes.slice().sort((a, b) => a - b)[Math.floor(switchTimes.length / 2)];
    t.switchTabMsMax = Math.max(...switchTimes);
    t.switchWorstLongTaskMs = await worst();
    // Open Settings: click to the Settings page's own content ready.
    const before = await app.evaluate(() => global.__tabSleep.state().length);
    const t0 = Date.now();
    await ui.click('#open-settings');
    await ui.waitForFunction((n) => document.querySelectorAll('.tab').length > n || document.querySelector('.tab.active .tab-title')?.textContent.match(/settings/i), before, { timeout: 15000 });
    await app.evaluate(async ({ webContents }) => {
      const wc = webContents.getAllWebContents().find((w) => /settings/.test(w.getURL()));
      for (let i = 0; i < 100 && wc; i++) { if (await wc.executeJavaScript('Boolean(document.querySelector("section, .card"))').catch(() => false)) return; await new Promise((r) => setTimeout(r, 25)); }
    });
    t.openSettingsMs = Date.now() - t0;
    out.throttled = { rate: THROTTLE, ...t };
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }

  await app.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });

  if (flag('json')) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`startup (ms since process creation): ${JSON.stringify(out.marks)}  ui visible ${uiVisibleMs} ms after launch()${haveEngine ? '' : ' (no cached adblock engine)'}`);
  console.log(`main.js requires: ${out.requireTotalMs} ms total; slowest ${out.requires.map((r) => `${r.name} ${r.ms}`).join(', ')}`);
  console.log(`project modules loaded at startup: ${out.modules}; preload.bundle.js ${out.preloadBundleKB} KB; UI scripts/styles ${out.uiScripts.reduce((s, r) => s + r.kb, 0)} KB (${out.uiScripts.length} files)`);
  console.log(`active setInterval timers when idle: ${out.intervals.length}${out.intervals.map((i) => `\n  ${i.ms} ms  ${i.at}`).join('')}`);
  for (const k of ['tabs1', 'tabs5', 'tabs15']) console.log(`memory ${k}: ${out.memory[k].total.count} processes, ${out.memory[k].total.ws} MB working set, ${out.memory[k].total.priv} MB private`);
  console.log(`idle CPU (15 tabs, 10 s): ${out.idleCpuPct15Tabs}% of one core; sleeping tabs: ${out.sleeping}`);
  if (out.throttled) console.log(`CPU x${THROTTLE}: ${JSON.stringify(out.throttled)}`);
})().catch((err) => { console.error(err); process.exit(1); });
