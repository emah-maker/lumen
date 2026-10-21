// The animated effects on the new-tab page cost little (Settings → Appearance → Animated effect), measured in the running app, hidden:
//   - Particles at 1280x800 and 1920x1080: CPU of the new-tab renderer and of the GPU process over 10 s (app.getAppMetrics), the time
//     one animation-frame callback takes (the step and the draw, timed around it with performance.now), the particle count, and how many
//     pairs the line-drawing looked at per frame (a grid of cells now; every pair before)
//   - the aurora, blobs and grain effects: the same CPU and frame time
//   - nothing is asked for while idle: no animation frame when the page is hidden (another tab in front), with Performance mode on,
//     or with Reduce motion on, and in each of those the canvas still shows one frame
// Offline; a throwaway profile and TEMP; LUMEN_TEST_BACKGROUND keeps the window off-screen. LUMEN_PARTICLES_JSON=1 prints the numbers as JSON.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Ceilings, from measurements on the machine this was written on (a laptop, hidden window, 10 s): a particle frame takes 0.2 ms of script,
// the renderer and the GPU process together take 1.5 to 2.7% of a core (they took 2.2 to 5% before the grid, the 1x canvas and the timer-led
// loop); the ceilings are more than twice that, so a 60 fps loop or a 2x canvas shows.
const CEILING = { frameMs: 2, cpuPct: 6, softFrameMs: 2.5 };
const MEASURE_MS = 10e3;

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-fxperf-profile-'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-fxperf-tmp-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ sidebarNewChat: false, performanceMode: 'off', newTabBackground: 'dusk', newTabEffect: 'particles', homeWidgets: [] }));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', TEMP: temp, TMP: temp, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  const numbers = {};
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate(async () => { const t = global.__agent.browser.openTab(); await new Promise((r) => t.webContents.once('did-finish-load', r)); global.__home = t; });
    // A test window cannot hide a tab for real (every tab of a test window counts as visible: features/tab-ready.js), so "another tab in front" is
    // what the page is told then: document.hidden turns true and visibilitychange fires. The loop only ever reads that.
    const setHidden = (h) => home(`(() => { if (${h}) Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); else delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); return document.hidden; })()`);
    const home = (js) => app.evaluate((_e, c) => global.__home.webContents.executeJavaScript(c), js);
    const set = (key, value) => app.evaluate((_e, [k, v]) => global.__settings.backend.set(k, v).then(() => 'ok', (err) => `ERROR ${err.message}`), [key, value]);
    for (let i = 0; i < 60 && !(await home('Boolean(window.setBackdropEffect?.info?.())').catch(() => false)); i++) await sleep(100);

    // Time every animation-frame callback of the page that draws (the effect's step and draw are the only work in them). `raf` counts the
    // effect's own callbacks, drawn or not: before the timer-led loop, a frame that came early asked again, three or four callbacks per frame.
    await home(`(() => { if (window.__fx) return; const fx = window.__fx = { n: 0, raf: 0, sum: 0, max: 0, drew: false }; const orig = window.requestAnimationFrame.bind(window);
      const clear = CanvasRenderingContext2D.prototype.clearRect; CanvasRenderingContext2D.prototype.clearRect = function (...a) { fx.drew = true; return clear.apply(this, a); };
      window.requestAnimationFrame = (cb) => { const mine = cb.name === 'frame'; /* (the effect's loop; the page's widgets ask for frames of their own now and then) */ return orig((t) => { const s = performance.now(); fx.drew = false; try { cb(t); } finally { const d = performance.now() - s; if (mine) fx.raf++; if (fx.drew) { fx.n++; fx.sum += d; if (d > fx.max) fx.max = d; } } }); }; return true; })()`);
    // Through the real setting, as a user would (the page also re-reads its settings now and then, which would undo a direct call), then the counters start from zero.
    const restart = async (name) => { await set('newTabEffect', name); await sleep(1500); return home('(() => { window.__fx.n = 0; window.__fx.raf = 0; window.__fx.sum = 0; window.__fx.max = 0; return true; })()'); };
    const resize = (w, h) => app.evaluate(({ BrowserWindow }, [a, b]) => BrowserWindow.getAllWindows()[0].setContentSize(a, b), [w, h]);
    const procs = () => app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, cpu: m.cpu.percentCPUUsage })));
    // CPU over `ms` of the new-tab renderer and the GPU process, as percent of one core (getAppMetrics reports since its last call).
    const cpuOver = async (ms) => {
      const pid = await app.evaluate(() => global.__home.webContents.getOSProcessId());
      await procs(); await sleep(ms);
      const m = await procs();
      const one = (f) => m.filter(f).reduce((s, x) => s + x.cpu, 0);
      return { renderer: one((x) => x.pid === pid), gpu: one((x) => x.type === 'GPU'), all: one(() => true) };
    };
    const rafCount = (ms) => home(`new Promise((res) => { const n0 = window.__fx.raf; setTimeout(() => res(window.__fx.raf - n0), ${ms}); })`);
    const canvasInk = () => home(`(() => { const c = document.getElementById('effect'); if (!c) return -1; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; })()`);

    // ---- cost, per effect and size
    for (const [w, h] of [[1280, 800], [1920, 1080]]) {
      await resize(w, h); await sleep(900);
      for (const name of ['particles', 'aurora', 'blobs', 'grain']) {
        if (!(await home(`window.setBackdropEffect && typeof window.setBackdropEffect.info === 'function'`))) continue;
        await restart(name);
        await sleep(1200);
        const cpu = await cpuOver(MEASURE_MS);
        const fx = await home('({ n: window.__fx.n, raf: window.__fx.raf, sum: window.__fx.sum, max: window.__fx.max })');
        const info = await home('window.setBackdropEffect.info()');
        if (!info || info.name !== name) { console.log(`skip  ${name}: not an effect of this build`); continue; }
        const row = {
          size: `${w}x${h}`, effect: name, viewport: await home('[innerWidth, innerHeight]'), count: info.count, canvas: await home(`(() => { const c = document.getElementById('effect'); return c ? [c.width, c.height] : null; })()`),
          framesPerSec: +(fx.n / (MEASURE_MS / 1000)).toFixed(1), rafCallbacksPerSec: +(fx.raf / (MEASURE_MS / 1000)).toFixed(1), avgFrameMs: +(fx.sum / Math.max(1, fx.n)).toFixed(3), maxFrameMs: +fx.max.toFixed(2),
          // Before the grid every pair was looked at: n(n-1)/2.
          checksPerFrame: info.stats ? Math.round(info.stats.checks / Math.max(1, info.stats.frames)) : (name === 'particles' ? (info.count * (info.count - 1)) / 2 : 0),
          cpuRendererPct: +cpu.renderer.toFixed(2), cpuGpuPct: +cpu.gpu.toFixed(2), cpuAllPct: +cpu.all.toFixed(2),
        };
        numbers[`${row.size} ${name}`] = row;
        console.log(`info  ${JSON.stringify(row)}`);
        const limit = name === 'particles' ? CEILING.frameMs : CEILING.softFrameMs;
        if (w === 1920) {
          check(`${name} at ${w}x${h}: a frame takes at most ${limit} ms on average (${row.avgFrameMs} ms)`, row.avgFrameMs <= limit, row.avgFrameMs);
          check(`${name} at ${w}x${h}: renderer + GPU take at most ${CEILING.cpuPct}% of a core over 10 s (${(row.cpuRendererPct + row.cpuGpuPct).toFixed(1)}%)`, row.cpuRendererPct + row.cpuGpuPct <= CEILING.cpuPct, JSON.stringify(row));
        }
        check(`${name} at ${w}x${h}: about 30 frames a second at most (${row.framesPerSec}; a hidden window's frame clock is not exactly 60 Hz)`, row.framesPerSec <= 34, row.framesPerSec);
        if (name === 'particles') check(`${name} at ${w}x${h}: at most 1.8 animation-frame callbacks per drawn frame (one at 60 Hz; a faster display wakes an early one now and then; it was 2 to 4) (${row.rafCallbacksPerSec} callbacks, ${row.framesPerSec} frames a second)`, row.rafCallbacksPerSec <= row.framesPerSec * 1.8, row.rafCallbacksPerSec);
        if (name === 'particles') check(`${name} at ${w}x${h}: far fewer than every pair is looked at (${row.checksPerFrame} of ${(row.count * (row.count - 1)) / 2})`, row.checksPerFrame * 4 < (row.count * (row.count - 1)) / 2, row.checksPerFrame);
      }
    }
    await resize(1280, 800); await sleep(600);

    // ---- idle: no animation frame is asked for
    await restart('particles'); await sleep(800);
    check('visible and animating: animation frames are asked for', (await rafCount(1000)) >= 20, 'none');
    // another tab in front: this page is hidden
    const hidden = await setHidden(true);
    check('another tab in front: the page is hidden', hidden === true, hidden);
    check('hidden (another tab in front): no animation frame in 2 s', (await rafCount(2000)) === 0, 'frames asked for');
    await setHidden(false); await sleep(300);
    check('back in front: it animates again', (await rafCount(1000)) >= 20, 'none');
    // Performance mode: one still frame
    await set('performanceMode', 'on'); await sleep(1500);
    check('Performance mode: no animation frame in 2 s', (await rafCount(2000)) === 0, 'frames asked for');
    check('Performance mode: the canvas still shows one frame', (await canvasInk()) > 100, await canvasInk());
    await set('performanceMode', 'off'); await sleep(1500);
    check('Performance mode off: it animates again', (await rafCount(1000)) >= 20, 'none');
    // Reduce motion: one still frame
    await set('reduceMotion', true); await sleep(1500);
    check('Reduce motion: no animation frame in 2 s', (await rafCount(2000)) === 0, 'frames asked for');
    check('Reduce motion: the canvas still shows one frame', (await canvasInk()) > 100, await canvasInk());
    await set('reduceMotion', false);
    // the soft effects rest the same way
    for (const name of ['aurora', 'blobs', 'grain']) {
      if (!(await home(`Boolean(window.setBackdropEffect)`))) break;
      await set('newTabEffect', name); await sleep(1500);
      const awake = await rafCount(1500);
      check(`${name}: animating asks for animation frames (${awake} in 1.5 s)`, awake >= 1, awake);
      await setHidden(true); await sleep(500);
      check(`${name}: hidden asks for none`, (await rafCount(1500)) === 0, 'frames asked for');
      await setHidden(false); await sleep(300);
    }
  } finally {
    await app.close().catch(() => {});
  }
  if (process.env.LUMEN_PARTICLES_JSON) console.log(`JSON ${JSON.stringify(numbers)}`);
  console.log(failures ? `\n${failures} check(s) failed` : '\nall effect performance checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
