// Usage: the plan's limits (a stand-in `claude` answering `/usage`) and Lumen's share of them
// (stubbed Claude Code / Grok Build turns reporting tokens and rate_limit_event readings), shown in
// Settings → Usage and the sidebar's meter, and kept across a restart. Offline; no real CLI runs.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parsePlan, fiveHourOf } = require('../features/usage');

const USAGE_TEXT = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 29% used · resets Sep 28 at 8:09pm (America/New_York)',
  'Current week (all models): 41% used · resets Oct 2 at 9am (America/New_York)',
  '',
  "What's contributing to your limits usage?",
  'Last 24h · 644 requests · 7 sessions',
  '  Top MCP servers: playwright 11%, lumen 6%',
  'Last 7d · 4937 requests · 22 sessions',
  '  Top MCP servers: lumen 3%',
].join('\n');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- the /usage text, parsed (plain Node)
  const parsed = parsePlan(USAGE_TEXT);
  check('/usage: session and weekly limits with their reset times', parsed.subscription && parsed.limits.length === 2 && parsed.limits[0].percent === 29 && /8:09pm/.test(parsed.limits[0].resets) && parsed.limits[1].label === 'Current week (all models)' && parsed.limits[1].percent === 41, JSON.stringify(parsed.limits));
  check('/usage: Lumen\'s share as an MCP server, per period', parsed.contributions.map((c) => `${c.period}:${c.lumen}`).join(',') === '24h:6,7d:3', JSON.stringify(parsed.contributions));
  check('/usage: text without limits parses to none', parsePlan('Not signed in').limits.length === 0, 'found some');
  const w = fiveHourOf({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.28, resetsAt: 1790640600 } } });
  check('rate_limit_event: the 5-hour window in percent and ms', Math.round(w.percent) === 28 && w.resetsAt === 1790640600000, JSON.stringify(w));

  // A stand-in claude: answers `-p /usage` like the real CLI (a result message, 0 tokens).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-usage-test-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}\nif (process.argv.includes('/usage')) process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, result: ${JSON.stringify(USAGE_TEXT)} }));\n`, { mode: 0o755 });
  const profile = path.join(dir, 'profile');
  fs.mkdirSync(profile);
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_CLAUDE_BIN: bin };
  const launch = () => electron.launch({ args: [path.join(__dirname, '..')], env });
  let app = await launch();
  let ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const summary = (refresh) => app.evaluate((_e, r) => global.__usage.summary({ refresh: r }), refresh);

  if (process.platform === 'win32') {
    console.log('SKIP  the /usage stand-in (a script with a #! line; not on Windows)');
  } else {
    const s = await summary(true);
    check('Usage reads the plan from `claude /usage`', s.plan.available && s.plan.limits[0]?.percent === 29 && s.plan.limits[1]?.percent === 41, JSON.stringify(s.plan));
  }

  // ---- Claude Code turns: tokens and how far the 5-hour meter moved
  const resetsAt = Math.floor(Date.now() / 1000) + 3 * 3600;
  await app.evaluate((_e, reset) => {
    let n = 0;
    const turns = [0.30, 0.34];
    global.__agent.engines = {
      claudecode: {
        owns: () => false,
        run: async ({ emit }) => {
          const info = { status: 'allowed', rateLimitType: 'five_hour', isUsingOverage: false, overageStatus: 'rejected', unifiedWindows: { five_hour: { utilization: turns[n++], resetsAt: reset } } };
          emit({ type: 'rate_limit', info });
          return { text: 'ok', sessionId: 's1', usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 20000, cacheWriteTokens: 3000, costUSD: 0.05, models: ['claude-opus-5-5'] }, rateLimit: info };
        },
      },
      grokbuild: { owns: () => false, run: async () => ({ text: 'ok', sessionId: 'g1', usage: { inputTokens: 700, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0.01, models: [] } }) },
    };
  }, resetsAt);
  const turn = (model) => app.evaluate((_e, m) => { global.__agent.reset(); global.__agent.messages.settings = { ...global.__agent.getOptions(), model: m }; return new Promise((resolve) => global.__agent.run('hello', (e) => { if (e.type === 'done') resolve(); })); }, model);
  await turn('claudecode:default');
  await turn('claudecode:default');
  // Grok Build only runs when its CLI is found; its run() reports usage the same way (usageOf).
  await app.evaluate(() => global.__agent.reportUsage('grokbuild', { usage: { inputTokens: 700, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0.01, models: [] } }));
  let s = await summary(false);
  const win = s.lumen.window;
  check('Claude Code turns are counted in this 5-hour window, with their tokens', win.turns === 2 && win.tokens === 2 * 24500 && Math.abs(win.costUSD - 0.1) < 1e-9, JSON.stringify(win));
  check('the second turn moved the meter 30% -> 34%: Lumen ≈4 points', win.limitPoints != null && Math.round(win.limitPoints) === 4, JSON.stringify(win));
  check('the latest reading is the plan meter (34%)', Math.round(s.meter?.percent) === 34 && s.meter.resetsAt === resetsAt * 1000, JSON.stringify(s.meter));
  check('Grok Build turns are logged under their own engine', s.lumen.byEngine.grokbuild?.turns === 1 && s.lumen.byEngine.grokbuild.tokens === 1000 && s.lumen.byEngine.claudecode?.turns === 2, JSON.stringify(s.lumen.byEngine));

  // ---- the sidebar meter (Claude Code picked)
  await ui.evaluate(() => { const sel = document.getElementById('model'); if (![...sel.options].some((o) => o.value === 'claudecode:default')) sel.append(new Option('Claude Code', 'claudecode:default')); sel.value = 'claudecode:default'; sel.dispatchEvent(new Event('change')); });
  let meter = null;
  for (let i = 0; i < 30 && !(meter && !meter.hidden && /Plan 34%/.test(meter.text)); i++) { await sleep(200); meter = await ui.evaluate(() => { const m = document.getElementById('usage-meter'); return m && { hidden: m.hidden, text: m.textContent }; }); }
  check('the sidebar shows the plan meter with Lumen\'s share', meter && !meter.hidden && /Plan 34%/.test(meter.text) && /Lumen ≈4/.test(meter.text), JSON.stringify(meter));

  // ---- Settings → Usage
  await app.evaluate(() => global.__settings.open('usage'));
  let page = null;
  for (let i = 0; i < 40 && !(page && page.meters >= 1); i++) {
    await sleep(250);
    page = await app.evaluate(async () => {
      const t = global.__settings.tabs().find((x) => x.settings);
      const wc = t && global.__settings.contents(t.id);
      return wc ? wc.executeJavaScript("(() => { const sec = document.getElementById('sec-usage'); return sec && !sec.hidden && { meters: sec.querySelectorAll('.meter').length, width: sec.querySelector('.meter i')?.style.width, text: sec.textContent }; })()") : null;
    });
  }
  check('lumen://settings/usage opens on Usage and shows the plan\'s bars', page && page.meters >= 1, JSON.stringify(page).slice(0, 300));
  if (process.platform !== 'win32') check('a bar is as long as its percentage (29%)', page?.width === '29%', page?.width);
  check('Settings → Usage shows Lumen\'s share and each engine', page && /Lumen’s sidebar, this 5-hour window/.test(page.text) && /Claude Code/.test(page.text) && /Grok Build/.test(page.text), page?.text.slice(0, 300));

  // ---- the log survives a restart
  await sleep(800); // saved half a second after a change
  await app.close();
  app = await launch();
  ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  s = await summary(false);
  // The meter is back too; a fresh /usage (the stand-in always says 29%) is newer than the last turn.
  check('the usage log survives a restart', s.lumen.week.turns === 3 && [29, 34].includes(Math.round(s.meter?.percent)), JSON.stringify({ week: s.lumen.week, meter: s.meter }));
  await app.evaluate(() => global.__usage.clear());
  s = await summary(false);
  check('Clear empties Lumen\'s log', s.lumen.week.turns === 0, JSON.stringify(s.lumen.week));

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
