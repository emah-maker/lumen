// Not a suite (the underscore keeps it out of npm test): what the music-reactive home screen costs, measured in a hidden window at 1920 x 1080 with a
// test tone playing. For each of: the feature off (the baseline), the full version, the reduced version (Visual effects: Light) and a reacting music card
// alone, it reports over 12 seconds: the page's own frame cost (the time one frame of our code takes), the renderer's long tasks (over 50 ms) and the
// main process's longest stall, and the CPU of Lumen's processes (the browser, the page's renderer, the GPU process) from app.getAppMetrics().
// Run: LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1 node scripts/e2e-lock.js run --owner x -- timeout 600 node test/_music-react-measure.js
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TONE = `<!doctype html><meta charset="utf-8"><title>tone</title><script>
window.startTone = () => { const ctx = new AudioContext(); const m = ctx.createGain(); m.gain.value = 0.001; m.connect(ctx.destination);
  const k = ctx.createOscillator(); k.frequency.value = 80; const g = ctx.createGain(); g.gain.value = 0; k.connect(g); g.connect(m);
  const mid = ctx.createOscillator(); mid.frequency.value = 1000; const mg = ctx.createGain(); mg.gain.value = 0.5; mid.connect(mg); mg.connect(m);
  const t0 = ctx.currentTime + 0.1; for (let i = 0; i < 600; i++) { g.gain.setValueAtTime(0.9, t0 + i * 0.5); g.gain.setValueAtTime(0, t0 + i * 0.5 + 0.12); } k.start(); mid.start(); return ctx.state; };
</script>`;

(async () => {
  if (process.platform !== 'win32') { console.log('Windows only'); process.exit(0); }
  const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(TONE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-mrmeasure-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ newTabPrivacy: false, graphicsMode: 'full' }));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', LUMEN_TEST_ALLOW_AUDIO: '1' } });
  const ui = await app.firstWindow(); await ui.waitForSelector('.tab');
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.fromId(global.__windows.list()[0].windowId); win.setSize(1920, 1080); });
  const set = (k, v) => app.evaluate((_e, [a, b]) => global.__settings.backend.set(a, b).then(() => 'ok'), [k, v]);
  const openTab = (url) => app.evaluate((_e, [u]) => new Promise((res) => { const t = global.__agent.browser.openTab(u); (global.__mt ||= []).push(t); t.webContents.once('did-finish-load', () => res(t.id)); }), [url]);
  const run = (id, c) => app.evaluate((_e, [i, c2]) => global.__mt.find((t) => t.id === i).webContents.executeJavaScript(c2, true), [id, c]);
  const pidOf = (id) => app.evaluate((_e, i) => global.__mt.find((t) => t.id === i).webContents.getOSProcessId(), id);
  await app.evaluate(() => { const w = global.__mrStall = { max: 0, last: Date.now(), on: false }; setInterval(() => { const n = Date.now(); if (w.on) w.max = Math.max(w.max, n - w.last - 4); w.last = n; }, 4).unref(); });
  const tone = await openTab(`http://127.0.0.1:${server.address().port}/`);
  await run(tone, 'startTone()');
  await sleep(1500);
  const home = await openTab(undefined);
  await sleep(2500);
  const win = await run(home, '[innerWidth, innerHeight, devicePixelRatio]');
  console.log(`window ${win[0]} x ${win[1]} at ${win[2]}x`);
  await run(home, `window.__lt = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); } catch {} true`);
  const homePid = await pidOf(home);

  async function measure(label, ready) {
    for (let i = 0; i < 60; i++) { if (await run(home, ready).catch(() => false)) break; await sleep(300); }
    await sleep(1500);
    await run(home, 'window.__lt.length = 0; true');
    const c0 = await run(home, 'window.__mrCost ? { f: window.__mrCost.frames, ms: window.__mrCost.ms, max: window.__mrCost.max } : null');
    await app.evaluate(({ app: a }) => a.getAppMetrics()); // (resets the CPU counters)
    await app.evaluate(() => { global.__mrStall.on = true; global.__mrStall.max = 0; global.__mrStall.last = Date.now(); });
    await sleep(12000);
    const stall = await app.evaluate(() => { global.__mrStall.on = false; return global.__mrStall.max; });
    const metrics = await app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name || '', cpu: m.cpu.percentCPUUsage })));
    const c1 = await run(home, 'window.__mrCost ? { f: window.__mrCost.frames, ms: window.__mrCost.ms, max: window.__mrCost.max } : null');
    const lt = await run(home, 'window.__lt.slice()');
    const cpu = (pred) => metrics.filter(pred).reduce((a, m) => a + m.cpu, 0).toFixed(1);
    const frames = c1 && c0 ? c1.f - c0.f : 0; const ms = c1 && c0 ? c1.ms - c0.ms : 0;
    console.log(`${label}: our frame cost ${frames ? (ms / frames).toFixed(2) : '-'} ms mean over ${frames} frames (${(frames / 12).toFixed(1)}/s, worst ${c1 ? c1.max.toFixed(2) : '-'} ms); renderer long tasks (>50 ms): ${lt.length}${lt.length ? ' ' + lt.join(',') : ''}; main stall max ${stall} ms; CPU: page renderer ${cpu((m) => m.pid === homePid)} %, GPU ${cpu((m) => m.type === 'GPU')} %, browser ${cpu((m) => m.type === 'Browser')} %`);
  }

  await measure('baseline (feature off)', 'true');
  await set('newTabMusicReactive', true);
  await measure('full, 1080p, 180 dots', `document.body.dataset.mr === 'live' && document.body.dataset.mrMode === 'full'`);
  await set('graphicsMode', 'light');
  await measure('Light (40 dots, 15/s)', `document.body.dataset.mr === 'live' && document.body.dataset.mrMode === 'reduced'`);
  await set('graphicsMode', 'full'); await set('newTabMusicReactive', false);
  await sleep(1500);
  const W = (m, ...a) => app.evaluate((_e, [mm, aa]) => global.__widgets[mm](...aa), [m, a]);
  const id = (await W('save', { type: 'spotify', mode: 'status', art: true, react: true })).widget.id;
  await app.evaluate(() => global.__widgets.refreshAll?.()).catch(() => {});
  await measure('a reacting card alone (no canvas)', `document.body.dataset.mr === 'live' && document.body.dataset.mrMode === 'full' && document.body.dataset.mrCards === '1'`);
  await W('remove', id);
  await app.close().catch(() => {});
  server.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
