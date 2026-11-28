// Times a whole browser task from the user's seat on every path: the sidebar's API loop (fake model), a CLI engine's MCP path (Claude Code,
// Codex, Grok Build: a fake engine run calling Lumen's tools as their MCP calls do) and an outside agent over the real stdio bridge.
// The task (test/helpers/_browser-task.js): open a local shop, search, filter (an in-page update), open a result, send a quote form, read
// the outcome. Prints, per path, the task's time, model requests, and per step: the call's time, the tool body (runTool), the overhead
// around it, and the page-script round trips by kind (settle waits, click probe, cursor, focus guard...).
//   node scripts/test/e2e-lock.js run --owner measure -- node scripts/measure/measure-browser-task.js [--runs=5] [--app=<folder>] [--only=api,engine,outside] [--lean] [--detail]
// Hidden (LUMEN_TEST_BACKGROUND=1) on a throwaway profile; no network, no key.
require('../../test/helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const os = require('os');
const fs = require('fs');
const task = require('../../test/helpers/_browser-task');

const args = process.argv.slice(2);
const RUNS = Number(args.find((a) => a.startsWith('--runs='))?.slice(7)) || 5;
const APP = path.resolve(args.find((a) => a.startsWith('--app='))?.slice(6) || path.join(__dirname, '..', '..'));
const ONLY = (args.find((a) => a.startsWith('--only='))?.slice(7) || 'api,engine,outside').split(',').filter((p) => ['api', 'engine', 'outside'].includes(p)); // (--only=none: just --shots)
const LEAN = args.includes('--lean');
const SHOTS = args.includes('--shots'); // also: screenshots of the AI's tab (behind the front tab) on the engine path
const DETAIL = args.includes('--detail');
const { median } = task;

(async () => {
  const site = await task.startSite();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-browser-task-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' };
  const app = await electron.launch({ args: [APP], env, colorScheme: null });
  let bridge = null;
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    await task.prepare(app, ui);
    const steps = task.taskSteps(site.url, { lean: LEAN });
    console.log(`app: ${APP}\ntask: ${steps.length} calls${LEAN ? ' (lean)' : ''}: ${steps.map((s) => s.name).join(', ')}`);
    if (SHOTS) {
      const shotSteps = [{ name: 'navigate', input: { url: `${site.url}/shop/item/brass` } }, ...Array.from({ length: 4 }, () => ({ name: 'screenshot', input: {} })), { name: 'read_page', input: { mode: 'compact' } }];
      const out = await task.runEngine(app, ui, shotSteps, 'Look at the lamp');
      const per = task.summarize(out);
      console.log(`screenshots (engine path, the AI's own tab): ${per.slice(1).map((s) => `${s.label} ${s.span} ms`).join(', ')}`);
      if (DETAIL) for (const [i, s] of per.slice(1).entries()) console.log(`   ${s.label}: ${Object.entries(s.s).map(([k, v]) => `${k} ×${v.n} ${v.ms}ms`).join('; ')}\n     -> ${out.results[i + 1].replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    for (const pathName of ONLY) {
      const runs = [];
      if (pathName === 'outside' && !bridge) bridge = await task.openBridge(app, ui, APP, env);
      for (let r = 0; r <= RUNS; r++) { // run 0 warms up (first window, first page of the site) and is not counted
        const out = pathName === 'api' ? await task.runApi(app, ui, steps, `Get a quote for a desk lamp ${r}`)
          : pathName === 'engine' ? await task.runEngine(app, ui, steps, `Get a quote for a desk lamp ${r}`)
            : await task.runOutside(app, bridge, steps);
        const problems = task.checkOutcome(out.results);
        if (problems.length) console.log(`  ${pathName} run ${r}: ${problems.join('; ')}`);
        if (r > 0) runs.push(out);
      }
      const per = runs.map(task.summarize);
      const stepCount = per[0].length;
      console.log(`\n== ${pathName}: task ${median(runs.map((x) => x.ms))} ms median [${runs.map((x) => x.ms).join(', ')}], ${runs[0].requests} model request${runs[0].requests === 1 ? '' : 's'}${runs[0].chars ? `, ${runs[0].chars} request chars (~${Math.round(runs[0].chars / 4)} tok)` : ''}`);
      console.log(`   page round trips: ${median(per.map((p) => p.reduce((a, s) => a + s.trips, 0)))}`);
      console.log(`   overhead outside the tool body, summed: ${median(per.map((p) => p.reduce((a, s) => a + s.overhead, 0)))} ms; tool bodies: ${median(per.map((p) => p.reduce((a, s) => a + s.body, 0)))} ms`);
      for (let i = 0; i < stepCount; i++) {
        const col = (k) => median(per.map((p) => p[i]?.[k] ?? NaN));
        console.log(`   ${String(i + 1).padStart(2)}. ${per[0][i].label.padEnd(10)} call ${String(col('span')).padStart(5)} ms  body ${String(col('body')).padStart(5)}  overhead ${String(col('overhead')).padStart(4)}  round trips ${col('trips')}`);
        if (!DETAIL) continue;
        const kinds = {};
        for (const p of per) for (const [k, v] of Object.entries(p[i]?.s || {})) (kinds[k] ||= []).push(v);
        const methods = {};
        for (const p of per) for (const [k, v] of Object.entries(p[i]?.m || {})) (methods[k] ||= []).push(v.ms);
        console.log(`       methods: ${Object.entries(methods).map(([k, v]) => `${k} ${median(v)}`).join(', ')}`);
        console.log(`       scripts: ${Object.entries(kinds).sort((a, b) => median(b[1].map((x) => x.ms)) - median(a[1].map((x) => x.ms))).map(([k, v]) => `${k} ×${median(v.map((x) => x.n))} ${median(v.map((x) => x.ms))}ms`).join('; ')}`);
      }
      if (DETAIL) console.log(`   results (run 1):\n${runs[0].results.map((t) => `     ${t.length} chars: ${t.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n')}`);
    }
  } finally {
    bridge?.close();
    await app.close().catch(() => {});
    site.server.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
