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
const CEILING = { requireMs: 2500, modules: 200, preloadKB: 40, uiKB: 500, idleIntervals: 4 };

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
  fs.rmSync(dir, { recursive: true, force: true });

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
    const uiKB = files.reduce((sum, u) => sum + fs.statSync(decodeURIComponent(new URL(u).pathname.replace(/^\//, ''))).size / 1024, 0);
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
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
