// Guardrails for Lumen's startup cost and idle behaviour, on the app built from source: heavy modules
// stay unloaded until used, main-process startup, the preload bundle and the browser UI's scripts stay
// under generous ceilings, few timers run when idle, and Performance mode (features/performance.js)
// behaves. Ceilings sit well above today's numbers (scripts/measure-perf.js prints them) so machine
// noise doesn't fail the run, but a new eager SDK, a polling loop or a big bundle does.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
// Loaded on first use; a startup that pulls one in has made every launch slower.
const LAZY = ['node_modules/openai/', 'node_modules/@anthropic-ai/', 'node_modules/qrcode-generator/', 'src/features/qr.js', 'src/features/screenshot.js', 'src/features/tool-overlay.js'];
// modules 200 -> 250 and uiKB 500 -> 600: the home-page widgets, merge, fallback and animation work grew the app (217 modules, 547 KB at the last measure); a runaway eager SDK or bundle still trips them.
// uiKB 600 -> 650 (0.5.1): Routines, the context meter and frame-aware chat UI took the bundle to 601 KB.
// uiKB 650 -> 700, idleIntervals 4 -> 5 (0.5.5): the UI bundle measures 675 KB; a fifth, cheap unref'd timer (the 15 s background-task tick, next to the run-slot sweep, the AI status refresh, the sleep sweep and the extension update check) idles at 0.2% CPU with 15 tabs.
const CEILING = { requireMs: 2500, modules: 250, preloadKB: 40, uiKB: 700, idleIntervals: 5 };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

  // Performance mode's decisions (no Electron needed).
  const perf = require('../src/features/performance');
  check('4 GB and 4 cores count as slow', perf.hardwareReasons({ totalMem: 4 * 1024 ** 3, cpus: 4 }).map((r) => r.key).join() === 'memory,cpu', '');
  check('16 GB and 8 cores are fine', perf.hardwareReasons({ totalMem: 16 * 1024 ** 3, cpus: 8 }).length === 0, '');
  const mk = (settings, hw) => perf.create({ app: { commandLine: { appendSwitch() {} } }, readSettings: () => settings, ...hw });
  check('Auto is on for a slow PC, off for a fast one', mk({}, { totalMem: 4 * 1024 ** 3, cpus: 8 }).active() && !mk({}, { totalMem: 16 * 1024 ** 3, cpus: 8 }).active(), '');
  check('Always on / Off override the hardware', mk({ performanceMode: 'on' }, { totalMem: 16 * 1024 ** 3, cpus: 8 }).active() && !mk({ performanceMode: 'off' }, { totalMem: 2 * 1024 ** 3, cpus: 2 }).active(), '');
  const lite = mk({ performanceMode: 'on' }, { totalMem: 16 * 1024 ** 3, cpus: 8 }).limits();
  check('Performance mode sleeps tabs sooner, caps live tabs and runs one background task', lite.sleepAfterMs < perf.LIMITS.normal.sleepAfterMs && Number.isFinite(lite.maxLiveBackgroundTabs) && lite.maxBackgroundTasks === 1, JSON.stringify(lite));
  // The weekly Code Cache check: over the cap it goes, under it stays, and a recent check is not repeated.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cachecap-'));
  fs.mkdirSync(path.join(dir, 'Code Cache', 'js'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Code Cache', 'js', 'a'), Buffer.alloc(3000));
  check('Code Cache under its cap is kept', perf.trimCodeCache(dir, 10000, { every: 0 }) === 'kept' && fs.existsSync(path.join(dir, 'Code Cache')), '');
  check('Code Cache over its cap is removed', perf.trimCodeCache(dir, 1000, { every: 0 }) === 'trimmed' && !fs.existsSync(path.join(dir, 'Code Cache')), '');
  check('a check made this week is not repeated', perf.trimCodeCache(dir, 1000) === 'skipped', '');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });

  // Startup of the real app.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-perfbudget-'));
  const app = await electron.launch({ args: [root], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await new Promise((r) => setTimeout(r, 1500));
    const modules = await app.evaluate(() => global.__perf.modules());
    const loaded = LAZY.filter((m) => modules.some((f) => f.includes(m)));
    check('heavy modules are not loaded at startup', loaded.length === 0, `loaded: ${loaded.join(', ')}`);
    check(`project and dependency modules loaded at startup <= ${CEILING.modules}`, modules.length <= CEILING.modules, modules.length);
    const requireMs = await app.evaluate(() => global.__perf.requireTotalMs());
    check(`main.js requires take <= ${CEILING.requireMs} ms`, requireMs <= CEILING.requireMs, `${requireMs} ms`);
    const preloadKB = fs.statSync(path.join(root, 'src', 'preload', 'preload.bundle.js')).size / 1024;
    check(`preload.bundle.js <= ${CEILING.preloadKB} KB`, preloadKB <= CEILING.preloadKB, `${Math.round(preloadKB)} KB`);
    const files = await ui.evaluate(() => [...document.scripts].map((s) => s.src).concat([...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href)).filter(Boolean));
    const uiKB = files.reduce((sum, u) => sum + fs.statSync(require('url').fileURLToPath(u)).size / 1024, 0);
    check(`browser UI scripts and styles <= ${CEILING.uiKB} KB`, uiKB <= CEILING.uiKB, `${Math.round(uiKB)} KB`);
    const intervals = await app.evaluate(() => global.__perf.intervals());
    check(`setInterval timers running when idle <= ${CEILING.idleIntervals}`, intervals.length <= CEILING.idleIntervals, JSON.stringify(intervals));
    const marks = await app.evaluate(() => global.__perf.marks());
    check('startup reached the UI', Number.isFinite(marks.uiReady), JSON.stringify(marks));

    // Performance mode reaches the page: the class that removes blur and motion.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('prefs:ui', { lite: true }));
    await ui.waitForFunction(() => document.documentElement.classList.contains('pref-lite') && document.documentElement.classList.contains('pref-reduce-motion'), null, { timeout: 3000 })
      .then(() => check('Performance mode turns off blur and motion in the UI', true), (err) => check('Performance mode turns off blur and motion in the UI', false, err.message));
    const blur = await ui.evaluate(() => getComputedStyle(document.querySelector('.composer')).backdropFilter);
    check('composer blur is off in Performance mode', blur === 'none', blur);

    // A new tab (the + button, with the spare new-tab page ready) shows in the strip and takes the address bar's focus within
    // a loose bound, and the main process's event loop isn't blocked for long meanwhile (scripts/measure-newtab.js measures it in detail: ~10-30 ms).
    await app.evaluate(() => global.__spareNewTab.enable());
    await new Promise((r) => setTimeout(r, 2500));
    await app.evaluate(() => { const lags = global.__ntLag = []; let last = Date.now(); global.__ntLagTimer = setInterval(() => { const n = Date.now(); lags.push(n - last - 10); last = n; }, 10); });
    const ms = await ui.evaluate(() => new Promise((done) => {
      document.activeElement?.blur();
      const t0 = performance.now();
      const before = document.querySelectorAll('#tabs .tab').length;
      const poll = () => (document.querySelectorAll('#tabs .tab').length > before && document.activeElement === document.getElementById('address') ? done(performance.now() - t0) : setTimeout(poll, 4));
      document.getElementById('new-tab').click();
      poll();
      setTimeout(() => done(99999), 5000);
    }));
    const lagMax = await app.evaluate(() => { clearInterval(global.__ntLagTimer); return Math.max(0, ...global.__ntLag); });
    check('a new tab shows and takes the address bar within 1000 ms', ms <= 1000, `${Math.round(ms)} ms`);
    check('the main process is not blocked for over 500 ms while a new tab opens', lagMax <= 500, `${Math.round(lagMax)} ms`);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
