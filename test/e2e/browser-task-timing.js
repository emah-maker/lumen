// A whole browser task from the user's seat, timed on every engine path, with budgets that fail on a regression.
// The task (test/helpers/_browser-task.js): open a local shop, search, filter the results in place, open a result, send a quote form and
// read the outcome. Run on the sidebar's API loop (a scripted fake model), a CLI engine's MCP path (Claude Code / Codex / Grok Build:
// a fake engine run calling Lumen's tools as their MCP calls arrive) and an outside agent over the real stdio bridge (mcp.js).
// Checks, per path: the task works (the quote lands, with the right item and quantity); the task's time and each step's overhead
// outside the tool body stay within budget; and the page round trips that make a step cheap stay so (deterministic counts, no timing):
// a click's probe is two scripts (arm, then one wait in the page), fill_form keeps a registry the landing just built, a click that
// changes nothing waits ~60 ms instead of a full quiet spell, and the lean version of the task (batch / fill_form submit) needs 6 model
// requests instead of 8. Hidden (LUMEN_TEST_BACKGROUND=1), own temp profile, no network, no key.
//   node test/e2e/browser-task-timing.js
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const os = require('os');
const fs = require('fs');
const task = require('../helpers/_browser-task');

const RUNS = 3; // counted runs per path (after one warm-up run)
// Budgets (ms), from scripts/measure/measure-browser-task.js on the dev laptop (medians of 3): before the changes this suite came with
// the task took 1858 ms on the API loop, 1820 ms on the engine path and 1698 ms for an outside agent, with ~580 ms of each spent outside
// the tool bodies (a 400 ms download wait after a link click, 100 ms after the others); after them 1069, 1093 and 952 ms, with 14-24 ms
// outside. The task budgets leave ~35% headroom for a busy machine. The step overhead is checked on every step (the worst one), so one
// fixed wait coming back fails it however fast the rest is.
const BUDGET = {
  api: { task: 1450, overhead: 60 },
  engine: { task: 1450, overhead: 60 },
  outside: { task: 1300, overhead: 60 },
};

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const site = await task.startSite();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-browser-task-'));
  const root = path.join(__dirname, '..', '..');
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' };
  const app = await electron.launch({ args: [root], env, colorScheme: null });
  let bridge = null;
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');
    await task.prepare(app, ui);
    const steps = task.taskSteps(site.url);
    const kinds = (step, k) => step.s[k]?.n || 0;
    for (const name of ['api', 'engine', 'outside']) {
      if (name === 'outside') bridge = await task.openBridge(app, ui, root, env);
      const runs = [];
      for (let r = 0; r <= RUNS; r++) {
        const out = name === 'api' ? await task.runApi(app, ui, steps, `Get a quote for a desk lamp ${r}`)
          : name === 'engine' ? await task.runEngine(app, ui, steps, `Get a quote for a desk lamp ${r}`)
            : await task.runOutside(app, bridge, steps);
        if (r === 0) { const p = task.checkOutcome(out.results); check(`${name}: the task works (search, filter in place, open the lamp, quote for 2 × Brass desk lamp)`, !p.length, p.join('; ')); continue; }
        runs.push(out);
      }
      const per = runs.map(task.summarize);
      const ms = task.median(runs.map((x) => x.ms));
      const overhead = task.median(per.map((p) => Math.max(...p.map((s) => s.overhead)))); // the worst step of each run
      console.log(`  ${name}: task ${ms} ms [${runs.map((x) => x.ms).join(', ')}]; per step ${per[0].map((s) => `${s.label} ${s.span}/${s.body}`).join(', ')} (call/body ms)`);
      check(`${name}: the whole task within ${BUDGET[name].task} ms (median of ${RUNS})`, ms <= BUDGET[name].task, `${ms} ms`);
      check(`${name}: no step spends over ${BUDGET[name].overhead} ms outside its tool body (the worst step, median of the runs)`, overhead <= BUDGET[name].overhead, `${overhead} ms; ${JSON.stringify(per[0].map((s) => [s.label, s.span, s.body]))}`);
      if (name === 'api') check('api: one model request per step plus the reply', runs[0].requests === steps.length + 1, String(runs[0].requests));
      // Deterministic: the round trips that make a step cheap. (Run 1's steps; each is the same task.)
      const s = per[0];
      const clicks = s.filter((x) => x.label === 'click');
      // (a mouse click is checked by its probe; the AI's tab behind the front one gets a DevTools or DOM click instead, with no probe)
      check(`${name}: a click's landing check is at most two page scripts (arm, one wait in the page), never a poll`, clicks.length === 2 && clicks.every((x) => kinds(x, 'click probe') <= 2) && (name !== 'outside' || clicks.every((x) => kinds(x, 'click probe') === 2)), JSON.stringify(clicks.map((x) => x.s['click probe'])));
      const quote = s[5];
      check(`${name}: fill_form on the page a click just landed on keeps that registry (no second walk)`, kinds(quote, 'registry (kept)') === 1 && kinds(quote, 'registry') === 0, JSON.stringify(quote.s));
      const filters = s[2];
      check(`${name}: fill_form's checkbox click (nothing on the page changes) ends its wait early ("still"), not after a quiet spell`, kinds(filters, 'settle (DOM quiet): still') === 1 && kinds(filters, 'settle (DOM quiet): quiet') === 0, JSON.stringify(filters.s));
      check(`${name}: no full read_page walk in the task (compact heads, registry-only walks and kept registries)`, s.every((x) => !kinds(x, 'read (full walk)')), JSON.stringify(s.map((x) => Object.keys(x.s))));
    }
    // Fewer steps: the same task with batch-free leaner calls (fill_form submit for the filter, the outcome read from the landed page).
    const lean = await task.runApi(app, ui, task.taskSteps(site.url, { lean: true }), 'Get a quote for a desk lamp, lean');
    const leanProblems = task.checkOutcome(lean.results);
    check('fewer steps: fill_form submit:true runs an in-page filter, and the landed page shows the outcome (6 model requests, not 8)', !leanProblems.length && lean.requests === 6, `${lean.requests} requests; ${leanProblems.join('; ')}`);
    check('no page errors in the window', errors.length === 0, errors.join(' | '));
  } finally {
    bridge?.close();
    await app.close().catch(() => {});
    site.server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
