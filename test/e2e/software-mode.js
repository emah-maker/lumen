// [software mode] Lumen without a GPU (started with --disable-gpu: Chromium draws and composites on the CPU), hidden (LUMEN_TEST_BACKGROUND), a fresh
// profile, the user's new-tab settings (sunset, many large fast white particles, frosted widget cards). STRICT: the numbers are never loosened; if one is
// noisy, fix the measurement (the rig waits for any other electron.exe to finish; take the machine lock first, see scripts/test/test-all.js).
//   - Graphics: Automatic resolves to Light plus the software level (the UI and the new-tab page carry it)
//   - no element of the browser UI or of the new-tab page has a backdrop-filter
//   - the new-tab effect is one still frame: it draws no frame in 3 s
//   - the sidebar uses the still path: no page capture (a CPU readback) over 10 open/close toggles; with Full effects forced, in the same run, it does capture
//   - main never blocks over 20 ms (longest setImmediate gap) during the sidebar toggles and the tab switches
//   - the UI has no long animation frame (over 50 ms) during the sidebar toggles
//   - the new-tab page at rest costs at most CPU_RATIO of the CPU that Full effects costs on the same page in the same run, and at most CPU_ABS_PCT of one core
const S = require('../helpers/_software-measure');
const { spawn } = require('child_process');

const { M, sleep } = S;
let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };

const MAIN_BUDGET_MS = 20;
const LOAF_BUDGET_MS = 50; // a long animation frame is one over 50 ms: none may occur
const CPU_RATIO = 0.5; // software mode's new-tab CPU, at most this share of Full effects' (same page, same run)
const CPU_ABS_PCT = 10; // ...and at most this many percent of one core in all (main + GPU + UI + page)
const SECONDS = 8;

const blurred = `(() => [...document.querySelectorAll('*')].filter((e) => { const s = getComputedStyle(e); return (s.backdropFilter || s.webkitBackdropFilter || 'none') !== 'none'; }).map((e) => e.tagName + '.' + e.className).slice(0, 6))()`;
const countCaptures = (app) => app.evaluate(({ webContents }) => {
  global.__caps = 0;
  for (const wc of webContents.getAllWebContents()) {
    if (wc.__capWrapped) continue;
    const orig = wc.capturePage.bind(wc);
    wc.capturePage = (...a) => { global.__caps++; return orig(...a); };
    wc.__capWrapped = true;
  }
});
// A control process (plain node, spinning the same setImmediate chain) beside the app: a stall of the whole machine (another program, a scan) is
// told from a stall of ours. A violation that overlaps a control gap over CONTROL_NOISE_MS is not the app's: that pass is void and made again (up to
// 3 passes; the last one counts whatever happens). A violation with a quiet control is a failure. The budget itself is never changed.
const CONTROL_NOISE_MS = 8;
const control = () => {
  const child = spawn(process.execPath, ['-e', 'let last=performance.now(),max=0;const spin=()=>{const n=performance.now();max=Math.max(max,n-last);last=n;setImmediate(spin)};spin();process.stdin.on("data",()=>{process.stdout.write(max+";");max=0;last=performance.now()});'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  let buf = ''; let wake = null;
  child.stdout.on('data', (d) => { buf += d; if (buf.includes(';') && wake) { const w = wake; wake = null; w(Number(buf.split(';')[0])); buf = ''; } });
  return {
    reset: () => new Promise((r2) => { wake = r2; child.stdin.write('x'); }),
    read: () => new Promise((r2) => { wake = r2; child.stdin.write('x'); }),
    stop: () => { try { child.kill(); } catch { /* gone */ } },
  };
};
// Runs pass() (returns { main: { max }, ...}) until its main gap is within budget, or the control was noisy (void, again), at most 3 times.
async function quietPass(pass) {
  const ctl = control();
  try {
    await ctl.reset();
    let result; let noisy = 0;
    for (let i = 0; i < 3; i++) {
      await ctl.reset();
      result = await pass();
      const ctlMax = await ctl.read();
      if (result.main.max <= MAIN_BUDGET_MS || ctlMax <= CONTROL_NOISE_MS) break; // within budget, or over it with a quiet machine: the result stands
      noisy++; console.log(`info  main gap ${result.main.max} ms overlapped a stall of the machine (control ${Math.round(ctlMax)} ms): pass ${i + 1} void`);
      if (i === 2) break;
    }
    return result;
  } finally { ctl.stop(); }
}
const captures = (app) => app.evaluate(() => global.__caps);

(async () => {
  const ctx = await M.startServer({});
  const byName = (n) => S.SCENARIOS.find((s) => s.name === n);
  const out = {};
  for (const mode of ['auto', 'full']) {
    const rig = await S.launchSoft(mode);
    try {
      await sleep(2500);
      const info = await rig.app.evaluate(() => global.__graphics.info());
      const uiState = await rig.ui.evaluate(() => ({ soft: document.documentElement.classList.contains('pref-gfx-soft'), flag: window.lumenSoftwareGfx === true }));
      if (mode === 'auto') {
        check('Automatic resolves to Light plus the software level when nothing is drawn by the GPU', info.mode === 'auto' && info.light === true && info.software === true, JSON.stringify(info));
        check('the UI carries the software level', uiState.soft && uiState.flag, JSON.stringify(uiState));
        check('the UI has no backdrop-filter on any element', (await rig.ui.evaluate(blurred)).length === 0, JSON.stringify(await rig.ui.evaluate(blurred)));
      } else {
        check('baseline (Full effects forced) is not the software level', info.mode === 'full' && info.software === false && !uiState.soft, JSON.stringify({ info, uiState }));
      }

      // ---- the new-tab page: effect, blur, and CPU at rest
      await rig.openHome();
      await sleep(3000);
      const f1 = await rig.home('setBackdropEffect.info().stats.frames');
      await sleep(3000);
      const f2 = await rig.home('setBackdropEffect.info().stats.frames');
      const look = await rig.home(`({ soft: document.body.classList.contains('gfx-soft'), still: document.body.classList.contains('still'), particles: setBackdropEffect.info().count, blurred: ${blurred} })`);
      if (mode === 'auto') {
        check(`the new-tab effect is one still frame (no frame drawn in 3 s: ${f1} -> ${f2}; still ${look.still}, ${look.particles} particles)`, look.soft && f2 === f1 && look.still === true, JSON.stringify({ f1, f2, look }));
        check('the new-tab page has no backdrop-filter on any element', look.blurred.length === 0, JSON.stringify(look.blurred));
      } else {
        check(`baseline: Full effects animates the effect (${f1} -> ${f2} frames)`, f2 > f1 + 20, JSON.stringify({ f1, f2 }));
      }
      await rig.home('window.__ping = setInterval(() => dispatchEvent(new Event("wheel")), 1000); 1'); // (the effect counts the page as touched, so Full keeps animating)
      out[mode] = { cpu: await S.cpuPass(rig, SECONDS, async (s) => { await sleep(s * 1000); }) };
      console.log(`info  ${mode}: new tab at rest, CPU % of one core ${JSON.stringify(out[mode].cpu)}`);
      await rig.home('clearInterval(window.__ping); 1');
      await rig.app.evaluate(() => { global.__home.webContents.close(); });
      await sleep(500);

      // ---- the sidebar, 10 open/close toggles on a web page
      await byName('sidebar-x10').setup(rig, ctx);
      await sleep(1500);
      await countCaptures(rig.app);
      const side = await quietPass(() => S.pacePass(rig, 9500, byName('sidebar-x10').action(rig, ctx), byName('sidebar-x10').page(rig, ctx)));
      const caps = await captures(rig.app);
      console.log(`info  ${mode}: sidebar x10: page captures ${caps}, main gap ${side.main.max} ms, UI long frames ${side.ui.loaf} (max ${side.ui.loafMaxMs} ms), UI frame max ${side.ui.maxMs} ms`);
      if (mode === 'auto') {
        check(`the sidebar uses the still path: no page capture over 10 toggles (${caps})`, caps === 0, caps);
        check(`main never blocks over ${MAIN_BUDGET_MS} ms during the sidebar toggles (${side.main.max} ms)`, side.main.max <= MAIN_BUDGET_MS, side.main.max);
        check(`the UI has no long animation frame over ${LOAF_BUDGET_MS} ms during the sidebar toggles (${side.ui.loaf} long, max ${side.ui.loafMaxMs} ms)`, side.ui.loaf === 0 && side.ui.loafMaxMs <= LOAF_BUDGET_MS, JSON.stringify(side.ui));
      } else {
        check(`baseline: with Full effects the sidebar does capture the page (${caps} captures)`, caps > 0, caps);
      }

      // ---- six tabs, switched 30 times
      if (mode === 'auto') {
        const sc = byName('tabs-x30');
        await sc.setup(rig, ctx);
        await sleep(1500);
        const tabs = await quietPass(() => S.pacePass(rig, 9000, sc.action(rig, ctx), null));
        check(`main never blocks over ${MAIN_BUDGET_MS} ms during 30 tab switches (${tabs.main.max} ms)`, tabs.main.max <= MAIN_BUDGET_MS, tabs.main.max);
      }
    } finally { await rig.close(); }
  }
  ctx.server.close();

  const a = out.auto?.cpu; const f = out.full?.cpu;
  if (a && f) {
    check(`CPU on the new-tab page at rest: software mode ${a.total}% of a core vs Full effects ${f.total}%: at most ${CPU_RATIO * 100}% of Full's`, a.total <= f.total * CPU_RATIO, JSON.stringify({ a, f }));
    check(`...and at most ${CPU_ABS_PCT}% of one core in all (${a.total}%)`, a.total <= CPU_ABS_PCT, JSON.stringify(a));
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
