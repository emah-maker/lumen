// [gpu health] Lumen lives through graphics-driver resets (features/gpu-health.js). In the app, hidden (LUMEN_TEST_BACKGROUND=1):
//   - a power source that flips every 2 s (speed-limit-change events) for 60 s changes nothing: no calm window, the new-tab page is not
//     re-rendered more than once, and the main process never stops for 20 ms
//   - the GPU process is crashed (chrome://gpucrash): it is logged to diagnostics/gpu-events.jsonl, Lumen recovers (the UI answers, a new tab
//     renders) and the main process never blocks for 200 ms
//   - during the calm window the new-tab effects are told to pause (and start again after) and the sidebar changes without a page snapshot
//   - drawing in software after a reset (a test override of the feature status): one notice with a Restart button; Restart asks main to relaunch
const { _electron: electron } = require('playwright-core');
const path = require('path'); const fs = require('fs'); const os = require('os'); const http = require('http');
require('./_tmp-cleanup');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000, step = 60) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(step); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Page</title><body><h1>A web page</h1><p>' + 'text '.repeat(200) + '</p>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;
  const launch = (extraArgs = [], extraEnv = {}) => electron.launch({ args: [path.join(__dirname, '..'), ...extraArgs], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-gpuhealth-')), ANTHROPIC_API_KEY: 'sk-ant-test', ...extraEnv } });
  const spinProbe = (app) => app.evaluate(() => { // main's setImmediate gaps (see the probe in the first scenario)
    const p = global.__gap = { max: 0, last: performance.now() };
    const spin = () => { const n = performance.now(); p.max = Math.max(p.max, n - p.last); p.last = n; setImmediate(spin); };
    setImmediate(spin);
  });
  const hwStatus = (app) => app.evaluate(({ app: a }) => ({ on: a.isHardwareAccelerationEnabled(), ...a.getGPUFeatureStatus() }));

  // Five GPU crashes, three seconds apart (Chromium's limit is about three): drawing stays on the GPU, and after each one the UI answers, a tab
  // renders, a snapshot of the page is not blank, and main never stops for 200 ms. KEEP_LIMIT=1 runs it without the switch (what a user had before).
  async function crashLimitScenario(keepLimit) {
    const label = keepLimit ? 'without the crash-limit switch' : 'with the crash-limit switch';
    const app = await launch([], keepLimit ? { LUMEN_TEST_KEEP_GPU_CRASH_LIMIT: '1' } : {});
    try {
      const ui = await app.firstWindow(); await ui.waitForSelector('.tab');
      await sleep(6000); // (gpu-health loads a few seconds after the window)
      const tab = await app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => t.webContents.once('did-finish-load', r)); return t.id; }, pageUrl);
      const spare = await app.evaluate(async () => { const t = global.__agent.browser.openTab(); await new Promise((r) => t.webContents.once('did-finish-load', r)); return t.webContents.id; });
      await app.evaluate((_e, i) => global.__agent.browser.switchTab(i), tab);
      await waitFor(() => ui.evaluate((i) => document.querySelector('#tabs .tab.active')?.dataset.id === String(i), tab));
      await spinProbe(app);
      const losses = () => app.evaluate(() => global.__gpuHealth.stats().gpuLosses);
      let answered = 0; let rendered = 0; let notBlank = 0;
      for (let k = 1; k <= 5; k++) {
        const before = await losses();
        await app.evaluate(({ webContents }, id) => { webContents.fromId(id).loadURL('chrome://gpucrash').catch(() => {}); }, spare);
        await waitFor(async () => (await losses()) > before, 15000, 100);
        await sleep(3000);
        const pressed = await ui.evaluate(() => document.getElementById('toggle-sidebar').getAttribute('aria-pressed'));
        await ui.click('#toggle-sidebar'); await sleep(500);
        if ((await ui.evaluate(() => document.getElementById('toggle-sidebar').getAttribute('aria-pressed'))) !== pressed) answered++;
        if (await waitFor(() => app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript('document.body.innerText.includes("A web page")')), 4000)) rendered++;
        const shot = await app.evaluate(async () => { const img = await global.__agent.browser.activeTab().webContents.capturePage(); const b = img.toBitmap(); let lit = 0; for (let i = 0; i < b.length; i += 4000) if (b[i] || b[i + 1] || b[i + 2]) lit++; return { empty: img.isEmpty(), lit }; });
        if (!shot.empty && shot.lit > 0) notBlank++;
      }
      const gap = Math.round(await app.evaluate(() => global.__gap.max) * 10) / 10;
      const st = await hwStatus(app);
      const total = await losses();
      console.log(`INFO  ${label}: ${total} GPU losses, gpu_compositing=${st.gpu_compositing}, rasterization=${st.rasterization}, acceleration=${st.on}, worst main gap ${gap} ms`);
      if (keepLimit) return; // (only reported: what happens without the switch)
      check('five GPU crashes: drawing stays on the GPU (compositing and rasterization hardware)', /^enabled/.test(st.gpu_compositing) && /^enabled/.test(st.rasterization) && st.on, JSON.stringify(st));
      check('...the UI answered after every crash (the sidebar toggled)', answered === 5, answered);
      check('...a tab still rendered after every crash', rendered === 5, rendered);
      check('...and a snapshot of the page was never blank', notBlank === 5, notBlank);
      check(`...and main never blocked for 200 ms through them (worst gap ${gap} ms)`, gap <= 200, gap);
      // The safety net: six losses within two minutes offer safe drawing mode (a plain notice, never automatic).
      while ((await losses()) < 6) await app.evaluate(() => global.__gpuHealth.gpuGone({ reason: 'crashed', exitCode: 0 })); // (a crash that spawned only one loss: top up to six)
      check('six GPU losses in two minutes offer safe drawing mode', await waitFor(async () => (await ui.locator('.gpu-note[data-kind="unstable"]').count()) === 1, 4000), await ui.locator('.gpu-note').count());
      check('...it is only an offer: nothing restarted', (await app.evaluate(() => global.__gpuRestarts || 0)) === 0, '');
      await ui.locator('.gpu-note[data-kind="unstable"] button').first().click();
      check('...its button asks for the safe-mode relaunch (this session only)', await waitFor(() => app.evaluate(() => global.__gpuRestarts === 1 && global.__gpuRestartSafe === true), 3000), '');
    } finally { await app.close().catch(() => {}); }
  }
  // --lumen-safe-gpu: this run draws in software; a normal start is hardware again (the setting is untouched).
  async function safeModeScenario() {
    const safe = await launch(['--lumen-safe-gpu']);
    let a;
    try { await (await safe.firstWindow()).waitForSelector('.tab'); a = await hwStatus(safe); } finally { await safe.close().catch(() => {}); }
    const normal = await launch();
    let b;
    try { await (await normal.firstWindow()).waitForSelector('.tab'); b = await hwStatus(normal); } finally { await normal.close().catch(() => {}); }
    check('launched with --lumen-safe-gpu, hardware acceleration is off', a.on === false, JSON.stringify(a));
    check('a normal launch has it on', b.on === true, JSON.stringify(b));
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-gpuhealth-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const set = (key, value) => app.evaluate((_e, [k, v]) => global.__settings.backend.set(k, v).then(() => 'ok', (err) => `ERROR ${err.message}`), [key, value]);
    // The main-process probe: a setImmediate chain that never lets the loop rest; the gap between two callbacks is the longest task that ran
    // in between (a timer probe reads Windows' 15.6 ms timer tick instead). probe(true) returns the worst gap since the last reset and resets.
    await app.evaluate(() => {
      const p = global.__gap = { max: 0, last: performance.now(), over: [] };
      const spin = () => { const n = performance.now(); const g = n - p.last; p.last = n; if (g > p.max) p.max = g; if (g > 20) p.over.push([Date.now(), Math.round(g)]); setImmediate(spin); };
      setImmediate(spin);
    });
    const probe = (reset) => app.evaluate((_e, r) => { const m = Math.round(global.__gap.max * 10) / 10; if (r) { global.__gap.max = 0; global.__gap.over = []; global.__gap.last = performance.now(); } return m; }, Boolean(reset));
    const gh = () => app.evaluate(() => ({ ...global.__gpuHealth.stats(), calm: global.__gpuHealth.calmActive(), noticeShown: global.__gpuHealth.noticeShown() }));

    // A hardware-drawing status, so the real feature status can never raise the notice by itself in this run.
    await app.evaluate(() => { global.__gpuStatusOverride = { gpu_compositing: 'enabled', rasterization: 'enabled', webgl: 'enabled' }; });

    // Tabs: T1 the new-tab page with an animated effect, T3 the one that will crash the GPU, T2 a web page (in front).
    await set('newTabEffect', 'particles');
    const open = (url) => app.evaluate(async (_e, u) => {
      const t = global.__agent.browser.openTab();
      if (u) { t.webContents.loadURL(u); await new Promise((r) => t.webContents.once('did-finish-load', r)); } else await new Promise((r) => t.webContents.once('did-finish-load', r));
      return { wc: t.webContents.id, tab: t.id };
    }, url || '');
    const T1 = await open(''); const T3 = await open(''); const T2 = await open(pageUrl);
    const t1 = T1.wc; const t3 = T3.wc;
    await app.evaluate((_e, i) => global.__agent.browser.switchTab(i), T2.tab); // the web page in front
    await waitFor(() => ui.evaluate((i) => document.querySelector('#tabs .tab.active')?.dataset.id === String(i), T2.tab));
    const inTab = (id, code) => app.evaluate(({ webContents }, [i, c]) => webContents.fromId(i).executeJavaScript(c), [id, code]);
    const fx = () => inTab(t1, 'window.setBackdropEffect?.info?.() || null');
    check('the new-tab page runs an effect', await waitFor(async () => (await fx())?.name === 'particles', 10000), JSON.stringify(await fx()));
    await inTab(t1, 'window.__renders = 0; const o = window.setBackdropEffect; window.setBackdropEffect = (...a) => { window.__renders++; return o(...a); }; window.setBackdropEffect.info = o.info; 1');
    await ui.evaluate(() => {
      window.__lite = 0; window.__moved = 0;
      new MutationObserver(() => { window.__lite++; }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      new MutationObserver(() => { if (document.body.classList.contains('sidebar-moving')) window.__moved++; }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    });
    const sidebar = async () => { // toggle the sidebar and return how many times it moved by slide
      const before = await ui.evaluate(() => window.__moved);
      await ui.click('#toggle-sidebar'); await sleep(1300);
      return (await ui.evaluate(() => window.__moved)) - before;
    };

    // ---- 1. a power source that flips every 2 s for 60 s (after the new tabs have settled: opening them refreshes the new-tab page by itself)
    await sleep(5000);
    // What the main process does on its own (Chromium's timers are coarse on Windows and Lumen has its own background work): a quiet 20 s first.
    await probe(true);
    await sleep(20000);
    const quietGap = await probe(true);
    await inTab(t1, 'window.__renders = 0; 1');
    const lite0 = await ui.evaluate(() => window.__lite);
    let emitCost = 0; // the time main spends inside one event (its handlers run synchronously)
    for (let i = 0; i < 30; i++) {
      emitCost = Math.max(emitCost, await app.evaluate((_e, limit) => { const a = performance.now(); global.__fakePower.emit('speed-limit-change', { limit }); return performance.now() - a; }, i % 2 ? 100 : 50));
      await sleep(2000);
    }
    const flapGap = await probe(true);
    const renders = await inTab(t1, 'window.__renders');
    const liteChanges = (await ui.evaluate(() => window.__lite)) - lite0;
    check(`power flapping for 60 s: the new-tab page is re-rendered at most once (${renders}) and the UI prefs class changes at most once (${liteChanges})`, renders <= 1 && liteChanges <= 1, `${renders} ${liteChanges}`);
    check(`...main spends at most 20 ms inside any one event (worst ${emitCost.toFixed(2)} ms)`, emitCost <= 20, emitCost);
    console.log(`INFO  main's worst setImmediate gap: ${flapGap} ms over the 60 s of flapping, ${quietGap} ms over 20 quiet seconds`);
    check(`...and main never blocks for more than 20 ms in the 60 s (worst gap ${flapGap} ms)`, flapGap <= 20, flapGap);
    check('...and the mode did not flip', (await app.evaluate(() => global.__perfMode.active())) === false, 'on');
    const afterFlap = await gh();
    check('...and power events start no calm window', afterFlap.calmStarts === 0 && !afterFlap.calm && afterFlap.gpuLosses === 0, JSON.stringify(afterFlap));

    // ---- 2. control: on a web page the sidebar slides (snapshot path) when there is no calm
    const slid = await sidebar();
    check('without calm, the sidebar slides over a page snapshot (the probe sees the slide)', slid > 0, slid);
    await sidebar(); // closed again

    // ---- 3. the GPU process is crashed
    await probe(true);
    const loaded = await app.evaluate(({ webContents }, id) => { webContents.fromId(id).loadURL('chrome://gpucrash').catch(() => {}); return 'started'; }, t3).catch((e) => `threw ${e.message}`); // (not awaited: the load may never finish)
    console.log(`INFO  loadURL('chrome://gpucrash'): ${String(loaded).slice(0, 120)}`);
    let st = await waitFor(async () => { const s = await gh(); return s.gpuLosses >= 1 && s; }, 20000, 100);
    if (!st) { // chrome://gpucrash was not honored: end the GPU process the way a driver reset would
      console.log('INFO  gpucrash did not take effect; killing the GPU process by pid (launched by this test)');
      await app.evaluate(({ app: a }) => { const g = a.getAppMetrics().find((m) => m.type === 'GPU'); if (g) process.kill(g.pid); });
      st = await waitFor(async () => { const s = await gh(); return s.gpuLosses >= 1 && s; }, 20000, 100);
    }
    check('the GPU process loss is seen by main', Boolean(st) && st.gpuLosses >= 1, JSON.stringify(st));
    check('...and starts one calm window', st?.calm === true && st.calmStarts === 1, JSON.stringify(st));
    const calmAttr = await waitFor(() => ui.evaluate(() => document.documentElement.hasAttribute('data-gpu-calm')), 3000);
    check('the UI is told about the calm', calmAttr, calmAttr);
    check('the new-tab effect is told to pause', await waitFor(async () => (await fx())?.calm === true, 3000), JSON.stringify(await fx()));
    const calmSlides = await sidebar();
    check('during calm the sidebar changes without a snapshot slide', calmSlides === 0, calmSlides);
    await sidebar();

    // Recovery: the UI answers, a new tab renders.
    const tabsBefore = await ui.locator('.tab').count();
    await ui.click('#new-tab');
    check('the UI answers a click after the reset (a new tab appears)', await waitFor(async () => (await ui.locator('.tab').count()) === tabsBefore + 1, 6000), await ui.locator('.tab').count());
    const rendered = await waitFor(() => app.evaluate(({ webContents }) => { const wc = global.__agent.browser.activeTab().webContents; return wc.executeJavaScript('document.readyState === "complete" && document.body.children.length > 0'); }), 8000);
    check('the new tab renders', rendered, rendered);
    // The calm ends by itself and everything resumes.
    check('the calm ends within about 10 s', await waitFor(async () => !(await gh()).calm && !(await ui.evaluate(() => document.documentElement.hasAttribute('data-gpu-calm'))), 15000, 200), JSON.stringify(await gh()));
    check('the new-tab effect starts again', await waitFor(async () => (await fx())?.calm === false, 4000), JSON.stringify(await fx()));
    await app.evaluate((_e, i) => global.__agent.browser.switchTab(i), T2.tab); // the web page again (the new tab opened above is a new-tab page: it never slides)
    await waitFor(() => ui.evaluate((i) => document.querySelector('#tabs .tab.active')?.dataset.id === String(i), T2.tab));
    const dbg = await app.evaluate(async ({ webContents }, id) => { const a = Date.now(); const img = await webContents.fromId(id).capturePage(); return { empty: img.isEmpty(), ms: Date.now() - a, size: img.getSize() }; }, T2.wc);
    check('a page snapshot can be taken again after the reset', dbg.empty === false, JSON.stringify(dbg));
    const after = await sidebar();
    check('after calm the sidebar slides again', after > 0, after);
    await sidebar();
    await sleep(8000); // the feature-status checks after a loss run at 1.5, 5 and 12 s
    const recoveryGap = await probe(true);
    check(`the main process never blocked for 200 ms during recovery (worst gap ${recoveryGap} ms)`, recoveryGap <= 200, recoveryGap);

    // The event is logged: reasons, codes and times, nothing else.
    const logFile = path.join(profile, 'diagnostics', 'gpu-events.jsonl');
    const lines = await waitFor(() => { const l = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)); return l.length && l; }, 5000);
    const gone = (lines || []).find((l) => l.e === 'gpu-gone');
    check('the GPU loss is logged in diagnostics/gpu-events.jsonl', Boolean(gone) && typeof gone.t === 'string' && 'reason' in gone && 'code' in gone, JSON.stringify(lines));
    check('...with no URL, path or title in it', !/https?:|[A-Za-z]:\\|\/Users\//.test(JSON.stringify(lines)), JSON.stringify(lines));

    // ---- 4. software drawing after a reset: one notice with Restart
    await sleep(6000); // (the last status check of the loss has run; the override says hardware)
    check('no notice while drawing is on the GPU', (await ui.locator('.gpu-note').count()) === 0 && !(await gh()).noticeShown, await ui.locator('.gpu-note').count());
    await app.evaluate(() => { global.__gpuStatusOverride = { gpu_compositing: 'disabled_software', rasterization: 'disabled_software', webgl: 'disabled_software' }; global.__gpuHealth.checkNow(); });
    check('drawing in software after a reset shows the notice', await waitFor(async () => (await ui.locator('.gpu-note').count()) === 1, 4000), await ui.locator('.gpu-note').count());
    const words = await ui.locator('.gpu-note').first().innerText().catch(() => '');
    check('...saying what happened and what to do', /graphics driver/i.test(words) && /software/i.test(words) && /restart/i.test(words), words);
    const btn = ui.locator('.gpu-note button', { hasText: 'Restart' });
    check('...with a Restart button', (await btn.count()) === 1, await btn.count());
    await app.evaluate(() => { global.__gpuHealth.checkNow(); global.__gpuHealth.checkNow(); });
    await sleep(500);
    check('...shown once: more checks add no second notice', (await ui.locator('.gpu-note').count()) === 1 && (await gh()).notices === 1, JSON.stringify(await gh()));
    check('nothing restarted by itself', (await app.evaluate(() => global.__gpuRestarts || 0)) === 0, '');
    await btn.click();
    check('Restart asks main to relaunch (the same save-and-relaunch as other restarts)', await waitFor(() => app.evaluate(() => global.__gpuRestarts === 1), 3000), '');
  } finally {
    await app.close().catch(() => {});
  }
  await crashLimitScenario(false);
  await safeModeScenario();
  if (process.env.GPU_COMPARE) await crashLimitScenario(true);
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
