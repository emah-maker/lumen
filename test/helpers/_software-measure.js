// [software mode] Measures what Lumen costs with no GPU (the app is started with --disable-gpu: drawing and compositing run on the CPU), hidden
// (LUMEN_TEST_BACKGROUND), a fresh profile per run. For each scenario of test/helpers/_igpu-measure.js (plus a window resize), in two passes so the probes never colour the CPU numbers:
//   pass 1 (CPU)     the CPU time of the main process, the GPU process, the browser UI's renderer and the page renderers, as % of one core (app.getAppMetrics())
//   pass 2 (pacing)  the UI's and the page's requestAnimationFrame intervals and long-animation-frame entries, and the main process's longest setImmediate gap
//                    (a setImmediate chain kept spinning: while it spins a gap IS the longest task that ran between two callbacks)
//   node test/helpers/_software-measure.js [--graphics full,auto] [scenario ...]      LUMEN_SW_SECONDS=8
// Also exports the rig for test/e2e/software-mode.js.
require('./_tmp-cleanup');
const M = require('./_igpu-measure');

const { sleep } = M;

const resize = {
  name: 'resize', label: '10 window resize',
  setup: async (rig, c) => { await rig.load(`${c.base}/plain`); },
  action: (rig) => async (s) => {
    const end = Date.now() + s * 1000; let i = 0;
    while (Date.now() < end) { const w = 1100 + (i++ % 2) * 700; await rig.app.evaluate(({ BrowserWindow }, w2) => BrowserWindow.getAllWindows()[0].setContentSize(w2, 800), w); await sleep(120); }
  },
  page: () => null, seconds: 8,
};
const SCENARIOS = [...M.SCENARIOS.filter((s) => s.name !== 'video'), resize];

// Per process: its role and cumulative CPU seconds.
const roles = (rig) => rig.app.evaluate(({ app, BrowserWindow, webContents }) => {
  const ui = BrowserWindow.getAllWindows()[0].webContents.getOSProcessId();
  const page = new Set();
  try { if (global.__home && !global.__home.webContents.isDestroyed()) page.add(global.__home.webContents.getOSProcessId()); } catch { /* gone */ }
  for (const t of global.__windows.list()[0].tabs) { try { page.add(webContents.fromId(t.contentsId).getOSProcessId()); } catch { /* asleep */ } }
  return app.getAppMetrics().map((m) => ({ pid: m.pid, role: m.type === 'Browser' ? 'main' : m.type === 'GPU' ? 'gpu' : m.pid === ui ? 'ui' : page.has(m.pid) ? 'page' : m.type.toLowerCase(), cpu: m.cpu.cumulativeCPUUsage }));
});

async function cpuPass(rig, seconds, action) {
  const before = await roles(rig);
  const t0 = Date.now();
  await action(seconds);
  const rest = seconds * 1000 - (Date.now() - t0);
  if (rest > 0) await sleep(rest);
  const wall = (Date.now() - t0) / 1000;
  const after = await roles(rig);
  const sum = (list, role) => list.filter((m) => m.role === role).reduce((s, m) => s + m.cpu, 0);
  const out = {};
  for (const role of ['main', 'gpu', 'ui', 'page']) out[role] = +(((sum(after, role) - sum(before, role)) / wall) * 100).toFixed(1);
  out.total = +Object.values(out).reduce((a, b) => a + b, 0).toFixed(1);
  return out;
}

const MAIN_SPIN = (app) => app.evaluate(() => {
  const S = global.__spin = { on: true, max: 0, last: performance.now(), n: 0 };
  const spin = () => { if (!S.on) return; const now = performance.now(); const gap = now - S.last; S.last = now; S.n++; if (gap > S.max) S.max = gap; setImmediate(spin); };
  setImmediate(spin);
});
const MAIN_SPIN_STOP = (app) => app.evaluate(() => { global.__spin.on = false; return { max: +global.__spin.max.toFixed(1), n: global.__spin.n }; });

async function pacePass(rig, ms, action, pageEval) {
  await rig.ui.evaluate(M.PROBE);
  if (pageEval) await pageEval(M.PROBE);
  await MAIN_SPIN(rig.app);
  await action(ms / 1000);
  await sleep(150);
  const ui = await rig.ui.evaluate(M.READ);
  const page = pageEval ? await pageEval(M.READ) : null;
  return { ui, page, main: await MAIN_SPIN_STOP(rig.app) };
}

// One scenario on a rig launched for it: settle, a CPU pass, a pacing pass.
async function runScenario(rig, sc, ctx, seconds) {
  if (sc.home) await rig.openHome(); else if (sc.setup) await sc.setup(rig, ctx);
  await sleep(2500);
  if (sc.home) await sleep(3000);
  const secs = sc.seconds || seconds;
  const act = sc.action(rig, ctx);
  const cpu = await cpuPass(rig, secs, act);
  const pace = await pacePass(rig, secs * 600, act, sc.page ? sc.page(rig, ctx) : null);
  return { cpu, pace };
}

const launchSoft = (graphicsMode, settings = {}) => M.launch({ settings: { graphicsMode, ...settings }, args: ['--disable-gpu'] });

module.exports = { SCENARIOS, roles, cpuPass, pacePass, runScenario, launchSoft, MAIN_SPIN, MAIN_SPIN_STOP, M, sleep };

if (require.main === module) {
  (async () => {
    const seconds = Number(process.env.LUMEN_SW_SECONDS) || 8;
    const argv = process.argv.slice(2);
    const gi = argv.indexOf('--graphics');
    const modes = gi >= 0 ? argv.splice(gi, 2)[1].split(',') : ['full', 'auto'];
    const list = SCENARIOS.filter((s) => !argv.length || argv.includes(s.name));
    const ctx = await M.startServer({});
    const rows = [];
    for (const sc of list) {
      for (const mode of modes) {
        const rig = await launchSoft(mode, sc.settings || {});
        try {
          await sleep(2500);
          const r = await runScenario(rig, sc, ctx, seconds);
          const row = { scenario: sc.label, graphics: mode, cpuMain: r.cpu.main, cpuGpu: r.cpu.gpu, cpuUi: r.cpu.ui, cpuPage: r.cpu.page, cpuTotal: r.cpu.total, mainGapMs: r.pace.main.max, uiMissed: r.pace.ui.missed, uiMaxMs: r.pace.ui.maxMs, uiLoaf: r.pace.ui.loaf, uiLoafMax: r.pace.ui.loafMaxMs, uiMedMs: r.pace.ui.medianMs, pageMissed: r.pace.page?.missed ?? '-', pageLoaf: r.pace.page?.loaf ?? '-' };
          rows.push(row);
          console.log(JSON.stringify(row));
        } catch (e) { console.log(`ERROR ${sc.name} ${mode}: ${e.message}`); } finally { await rig.close(); }
      }
    }
    ctx.server.close();
    console.table(rows);
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
