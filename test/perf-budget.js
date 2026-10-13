// Guardrails for Lumen's startup cost and idle behaviour, on the app built from source: heavy modules
// stay unloaded until used, main-process startup, the preload bundle and the browser UI's scripts stay
// under generous ceilings, few timers run when idle, and Performance mode (features/performance.js)
// behaves. Ceilings sit well above today's numbers (scripts/measure-perf.js prints them) so machine
// noise doesn't fail the run, but a new eager SDK, a polling loop or a big bundle does.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
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
// modules 250 -> 270 and uiKB 700 -> 750 (0.5.x, 2026-10-05): measured 258 modules and a 725 KB UI after the Gmail setup, file uploads, Bypass permissions and Codex/Grok engine work; each is a real feature, none an eager SDK or a stray bundle.
// modules 270 -> 285 and uiKB 750 -> 775 (2026-10-07): main already measured 277 modules and a 759 KB UI before the start-up work (the budget had been failing); the queue, idle-reaper-free helpers and match patterns add three small modules.
// requireMs 2500 -> 1000 (2026-10): main.js requires measure 125-180 ms warm; the suite now warms the disk with a throwaway launch first, so a cold checkout no longer trips it.
// idleIntervals 5 -> 6: the spare new-tab page's 60 s freshness check (newtab-speed, #321) is a sixth, cheap unref'd timer.
// modules 285 -> 335 and uiKB 775 -> 870 (2026-10-10): the 0.5.22 release already measured 312 modules and 823 KB (the budget had been failing since the Codex/Grok, device-access and chrome work); today's UI round adds profile-guard, nav-history, device-permissions/chooser, chat-title, plain-math and remote-pdf (319 modules, 840 KB). Each is a real feature; no SDK or bundle is loaded eagerly (the LAZY check above still passes).
// uiKB 870 -> 950 (0.5.23): the chat round (Markdown blocks and code extras, message versions and actions, the canvas, per-chat
// drafts, the chat library's undo/pin/archive/search) measured 903 KB. Mermaid (3.5 MB) is not in it: it loads on the first diagram.
// uiKB 950 -> 1000 (chat UI polish): main measured about 941 KB (LF) and 956 KB with Windows CRLF line endings, so the 950 ceiling already failed on a CRLF checkout; the polish adds roughly 3 KB of CSS and a label observer, and nothing is loaded eagerly that was not before.
// Idle ceilings (2026-10, fresh profile, one tab): measured ~3 pages, 5 processes, ~2% CPU, ~650-1300 MB (it swings by a quarter with what Windows counts as shared); the ceilings are about twice that, so a new always-on page, a poller or a spare process shows.
const CEILING = { requireMs: 1000, modules: 335, preloadKB: 40, uiKB: 1000, idleIntervals: 6, idleContents: 6, idleProcesses: 9, idleCpuPct: 15, idleMemMB: 2000, longTaskMs: 150 };

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

  // Startup of the real app. A launch right after npm ci or a fresh checkout reads every module from a cold disk (the require time then
  // reads 2-4x what a warm run does), so one throwaway launch warms the files first; the measured launch is the second.
  {
    const warmProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-perfwarm-'));
    const warm = await electron.launch({ args: [root], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: warmProfile, LUMEN_TEST_BACKGROUND: '1' } });
    try { await (await warm.firstWindow()).waitForSelector('.tab'); } catch { /* the measured launch reports it */ }
    await warm.close().catch(() => {});
    try { fs.rmSync(warmProfile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch { /* left in the temp folder */ }
  }
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

    // What runs when nothing is asked of the app (scripts/measure-app-perf.js prints the long-lived-profile version of these): no spare chat
    // page before a chat page has been used, no music engine page without a card for it, a handful of renderers, and little CPU and memory.
    const idleSet = await app.evaluate(({ app: a, webContents }) => ({
      spareChat: Boolean(global.__spareChat?.has?.()),
      spotify: Boolean(global.__spotifyWeb?.view?.()), apple: Boolean(global.__appleMusicWeb?.view?.()),
      contents: webContents.getAllWebContents().filter((w) => !w.isDestroyed()).map((w) => w.getURL().split('/src/').pop().slice(0, 60)),
      processes: a.getAppMetrics().length,
    }));
    check('no spare chat page before a chat page has been used', !idleSet.spareChat, '');
    check('no music engine page without a card for it', !idleSet.spotify && !idleSet.apple, JSON.stringify(idleSet));
    check(`always-on pages at idle with one tab <= ${CEILING.idleContents}`, idleSet.contents.length <= CEILING.idleContents, JSON.stringify(idleSet.contents));
    check(`Electron processes at idle with one tab <= ${CEILING.idleProcesses}`, idleSet.processes <= CEILING.idleProcesses, idleSet.processes);
    await app.evaluate(({ app: a }) => a.getAppMetrics()); // (the first sample starts the window)
    await new Promise((r) => setTimeout(r, 8000));
    const idle = await app.evaluate(({ app: a }) => { const ms = a.getAppMetrics(); return { cpu: ms.reduce((s, m) => s + m.cpu.percentCPUUsage, 0), memMB: ms.reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024 }; });
    check(`idle CPU over 8 s <= ${CEILING.idleCpuPct}% of one core (${idle.cpu.toFixed(1)}%)`, idle.cpu <= CEILING.idleCpuPct, idle.cpu);
    check(`memory at idle with one tab <= ${CEILING.idleMemMB} MB working set (${Math.round(idle.memMB)} MB)`, idle.memMB <= CEILING.idleMemMB, Math.round(idle.memMB));

    // Long tasks (over 50 ms) in the UI renderer during the common actions: opening and closing the sidebar, typing in the address bar.
    await ui.evaluate(() => { window.__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ entryTypes: ['longtask'] }); });
    await ui.click('#toggle-sidebar'); await new Promise((r) => setTimeout(r, 900));
    await ui.click('#toggle-sidebar'); await new Promise((r) => setTimeout(r, 900));
    await ui.focus('#address'); await ui.keyboard.type('lumen browser', { delay: 15 }); await ui.keyboard.press('Escape');
    const worstTask = await ui.evaluate(() => Math.round(Math.max(0, ...window.__lt)));
    check(`worst UI long task while the sidebar opens, closes and the address bar is typed in <= ${CEILING.longTaskMs} ms (${worstTask} ms)`, worstTask <= CEILING.longTaskMs, worstTask);
    // The settings the app reads on nearly every tab event (the strip's state asks for the default zoom) are checked once per settings write,
    // not per call (checking the home widgets alone re-laid-out the whole grid: 212 us a call with 12 widgets, 5 us now), and a caller's change to
    // what it gets back never reaches the next caller.
    const pm = await app.evaluate(() => {
      const b = global.__settings.backend;
      b.prefs();
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 200; i++) b.prefs();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const first = b.prefs(); first.defaultZoom = 99;
      const leaked = b.prefs().defaultZoom === 99;
      b.set('defaultZoom', 1.25);
      const after = b.prefs().defaultZoom;
      b.set('defaultZoom', 1);
      return { ms, leaked, after, back: b.prefs().defaultZoom };
    });
    check(`200 reads of the checked settings take <= ${CEILING.prefsMs} ms (${pm.ms.toFixed(1)} ms)`, pm.ms <= CEILING.prefsMs, pm.ms);
    check('the checked settings follow a write, and a caller changing its copy does not change the next', !pm.leaked && pm.after === 1.25 && pm.back === 1, JSON.stringify(pm));

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
    // (Windows can still hold a file of the closed app's profile: a leftover temp folder is not a budget failure)
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch { /* left in the temp folder */ }
  }
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
