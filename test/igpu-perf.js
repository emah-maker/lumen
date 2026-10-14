// [igpu] Graphics: Light (features/graphics.js) really costs the GPU less, hidden (LUMEN_TEST_BACKGROUND), a fresh profile, Windows only.
// On the new-tab page with the user's settings (sunset gradient, many large fast white particles, frosted widget cards, a 2560x1600 panel),
// the GPU 3D utilization of Lumen's own GPU process (Windows performance counters, `GPU Engine(pid_N_*engtype_3D)`, summed over its 3D engines)
// is sampled for 8 s with Graphics on Full effects and on Light, alternating three times in the same run (so thermals and background load
// hit both alike), and the medians are compared. Then:
//   - Light's median is at most 65% of Full's (at least 35% lower; about half is measured on the machine this was written on: Intel Arc 140T)
//   - the UI renderer misses no frame while idle: no requestAnimationFrame interval longer than 1.75 vsyncs and no long animation frame over
//     a 6 s window, with the page animating in Light (a separate pass, with nothing else sampling)
//   - Light still looks like itself: particles are drawn, no element has a backdrop-filter left, the frosted cards keep a visible tint
//   - Automatic picks Light on this machine's GPU if that is an integrated one (the same rule as features/graphics.js), and never follows power
//   - the effect rests after 20 s without input: its GPU cost falls to (almost) nothing, the canvas keeps its last frame, and input wakes it
// Skips (prints SKIP, exits 0) where the counters are not there (not Windows, or no GPU engine counters). Never loosen the numbers: if it is noisy,
// fix the measurement (more samples, a quieter machine: it waits for any other electron.exe to finish before it starts).
require('./_tmp-cleanup');
const M = require('./_igpu-measure');
const G = require('../src/features/graphics');
const { spawnSync } = require('child_process');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const { sleep } = M;

const MAX_RATIO = 0.65; // Light's GPU 3D utilization at most this share of Full's
const PAIRS = 3;
const SECONDS = 8;
const MIN_FULL_PCT = 2; // below this, the counters did not see the effect at all: the comparison would mean nothing

(async () => {
  if (process.platform !== 'win32') { console.log('SKIP  Windows GPU performance counters only'); process.exit(0); }
  const probe = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', "Get-Counter -Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -MaxSamples 1 | Out-Null; 'ok'"], { encoding: 'utf8', windowsHide: true });
  if (!/ok/.test(probe.stdout || '')) { console.log('SKIP  no GPU Engine performance counters on this machine'); process.exit(0); }

  const rig = await M.launch({ settings: {} });
  try {
    await rig.openHome();
    // The page counts as "touched" every second (a wheel event), so the effect keeps animating while it is measured; the rest is checked further down.
    await rig.home('window.__ping = setInterval(() => dispatchEvent(new Event("wheel")), 1000); 1');
    const settle = async (mode) => { await rig.set('graphicsMode', mode); await sleep(3500); };
    const idle = async (s) => { await sleep(s * 1000); };
    const info = await rig.app.evaluate(() => global.__graphics.info());
    const devices = await rig.gpuInfo();
    console.log(`info  GPUs ${JSON.stringify(devices)}; Graphics: ${JSON.stringify(info)}; display scale ${rig.dpr}`);

    // Automatic: the same decision as the unit-tested rule, from the same GPU list.
    const want = G.classify(devices.map((d) => ({ vendorId: d.vendor, deviceString: d.name, active: d.active }))).integrated;
    check(`Automatic follows the GPU in use (integrated: ${want}): Graphics is ${want ? 'Light' : 'Full'} on this machine`, info.mode === 'auto' && info.light === want && info.integrated === want, JSON.stringify(info));

    await settle('full');
    const full = await rig.home(`(() => { const all = [...document.querySelectorAll('*')]; const n = (e) => { const s = getComputedStyle(e); return (s.backdropFilter || s.webkitBackdropFilter || 'none') !== 'none'; }; return { blurred: all.filter(n).length, effect: Boolean(document.getElementById('effect')), glass: document.body.dataset.wglass, cards: document.querySelectorAll('.w-card').length, gfxLight: document.body.classList.contains('gfx-light') }; })()`);
    check(`the page has the user's setup (frosted glass, an effect, widget cards): ${JSON.stringify(full)}`, full.glass === 'frosted' && full.effect && full.cards >= 1 && !full.gfxLight, JSON.stringify(full));

    const fullRuns = []; const lightRuns = [];
    for (let i = 0; i < PAIRS; i++) {
      for (const mode of i % 2 ? ['light', 'full'] : ['full', 'light']) {
        await settle(mode);
        const r = await M.measure(rig, SECONDS, idle);
        (mode === 'full' ? fullRuns : lightRuns).push(r);
        console.log(`info  ${mode}: GPU 3D ${r.gpu3dPct}% (max ${r.gpu3dMax}), GPU process CPU ${r.gpuCpuPct}%, shared GPU memory ${r.sharedMB} MB, ${r.samples} samples`);
      }
    }
    const f = median(fullRuns.map((r) => r.gpu3dPct)); const l = median(lightRuns.map((r) => r.gpu3dPct));
    const fc = median(fullRuns.map((r) => r.gpuCpuPct)); const lc = median(lightRuns.map((r) => r.gpuCpuPct));
    check(`the counters see the effect on Full (median GPU 3D ${f.toFixed(2)}% >= ${MIN_FULL_PCT}%)`, f >= MIN_FULL_PCT, f);
    check(`Light's GPU 3D utilization is at most ${MAX_RATIO * 100}% of Full's: ${l.toFixed(2)}% vs ${f.toFixed(2)}% (${(100 - (l / f) * 100).toFixed(0)}% lower; medians of ${PAIRS} runs of ${SECONDS} s each, in the same app)`, l <= f * MAX_RATIO, `${l} vs ${f}`);
    check(`Light's GPU process CPU is lower too (${lc.toFixed(1)}% vs ${fc.toFixed(1)}% of a core)`, lc < fc, `${lc} vs ${fc}`);

    // ---- Light still looks like itself
    await settle('light');
    const light = await rig.home(`(() => { const all = [...document.querySelectorAll('*')]; const n = (e) => { const s = getComputedStyle(e); return (s.backdropFilter || s.webkitBackdropFilter || 'none') !== 'none'; };
      const card = document.querySelector('.w-card'); const bg = card ? getComputedStyle(card).backgroundColor : ''; const m = /rgba?\\(([^)]*)\\)/.exec(bg); const a = m ? (m[1].split(',')[3] === undefined ? 1 : parseFloat(m[1].split(',')[3])) : 0;
      const c = document.getElementById('effect'); const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let ink = 0; for (let i = 3; i < px.length; i += 16) if (px[i] > 20) ink++;
      return { blurred: all.filter(n).map((e) => e.tagName + '.' + e.className).slice(0, 5), gfxLight: document.body.classList.contains('gfx-light'), cardAlpha: a, ink, glass: document.body.dataset.wglass, particles: setBackdropEffect.info().count, canvas: [c.width, c.height] }; })()`);
    check(`Light: no element is left with a backdrop blur (${JSON.stringify(light.blurred)})`, light.gfxLight && light.blurred.length === 0, JSON.stringify(light));
    check(`Light: the frosted cards keep a visible tint (alpha ${light.cardAlpha})`, light.glass === 'frosted' && light.cardAlpha >= 0.1, JSON.stringify(light));
    check(`Light: particles are still drawn (${light.particles} of them, ${light.ink} inked samples, canvas ${light.canvas.join('x')})`, light.particles >= 30 && light.ink > 50, JSON.stringify(light));
    const uiBlur = await rig.ui.evaluate(() => { const c = document.querySelector('.composer'); return { light: document.documentElement.classList.contains('pref-gfx-light'), filter: c ? (getComputedStyle(c).backdropFilter || 'none') : 'no composer' }; });
    check(`Light: the UI's glass composer has no blur either (${JSON.stringify(uiBlur)})`, uiBlur.light && uiBlur.filter === 'none', JSON.stringify(uiBlur));

    // ---- no missed frame in the UI while idle (the page animating, in Light), nothing else sampling
    await sleep(1000);
    const pace = await M.pacing(rig, 6000, async () => {}, (js) => rig.home(js));
    console.log(`info  UI frames: ${JSON.stringify(pace.ui)}; page frames: ${JSON.stringify(pace.page)}; main-process timer lateness: ${JSON.stringify(pace.main)}`);
    check(`UI idle: zero missed frames over ${pace.ui.n} frames (vsync ${pace.ui.medianMs} ms, longest ${pace.ui.maxMs} ms; a miss is an interval over 1.75 vsyncs)`, pace.ui.n > 150 && pace.ui.missed === 0, JSON.stringify(pace.ui));
    check('UI idle: no long animation frame', pace.ui.loaf === 0, JSON.stringify(pace.ui));

    // ---- Light rests after 20 s without input
    await rig.home('clearInterval(window.__ping); 1');
    await sleep(23000);
    const rest = await M.measure(rig, 6, idle);
    const ink = await rig.home(`(() => { const c = document.getElementById('effect'); const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let k = 0; for (let i = 3; i < px.length; i += 16) if (px[i] > 20) k++; return k; })()`);
    check(`Light: after 20 s without input the effect rests (GPU 3D ${rest.gpu3dPct}%, under a third of Light's ${l.toFixed(2)}%)`, rest.gpu3dPct < l / 3, JSON.stringify(rest.gpu3dPct));
    check(`Light: ...and the canvas keeps its last frame (${ink} inked samples)`, ink > 50, ink);
    await rig.home('dispatchEvent(new Event("pointermove")); 1'); await sleep(1500);
    const woke = await rig.home('(() => { const s = setBackdropEffect.info().stats.frames; return new Promise((r) => setTimeout(() => r(setBackdropEffect.info().stats.frames - s), 1000)); })()');
    check(`Light: input wakes it (${woke} frames in 1 s)`, woke >= 8, woke);

    // ---- the choice never follows power: a power change event changes nothing
    const flap = await rig.app.evaluate(({ powerMonitor }) => { const before = JSON.stringify(global.__graphics.info()); for (const e of ['on-battery', 'on-ac', 'speed-limit-change']) powerMonitor.emit(e, { limit: 40 }); return [before, JSON.stringify(global.__graphics.info())]; });
    check('power events (battery, AC, speed limit) do not change Graphics', flap[0] === flap[1], flap.join(' / '));
  } finally {
    await rig.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall integrated-GPU checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
