// Usage: the plan's limits (a stand-in `claude` answering `/usage`) and Lumen's share of them
// (and Grok Build's bar: context fill, a budget, the limit-reached state; stubbed turns only)
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

  // ---- Grok Build's bar: no plan numbers exist, so the states are context, budget and limit
  // (stubbed turns: no real Grok runs). The log was just cleared, so it starts with nothing.
  const grokUse = (contextTokens) => ({ inputTokens: 40000, outputTokens: 200, cacheReadTokens: 10000, cacheWriteTokens: 0, costUSD: 0.4, models: ['grok-4.7-build'], contextTokens, contextWindow: 200000, compactPercent: 80 });
  await app.evaluate((_e, use) => {
    global.__grokStub = { mode: 'ok', use, limit: null };
    global.__agent.engines = {
      grokbuild: {
        owns: () => false,
        run: async ({ sessionId }) => {
          const g = global.__grokStub;
          if (g.mode === 'limit') return { text: '', sessionId, failed: true, usage: null, planLimit: g.limit };
          return { text: 'ok', sessionId: 'g1', usage: g.use };
        },
      },
    };
  }, grokUse(50000));
  await app.evaluate(() => { global.__agent.browser.effectiveModel = (model) => model; }); // Grok isn't installed here: the stub is what answers
  const stub = (patch) => app.evaluate((_e, p) => Object.assign(global.__grokStub, p), patch);
  const grokTurn = () => app.evaluate(() => {
    global.__agent.reset();
    global.__agent.messages.settings = { ...global.__agent.getOptions(), model: 'grokbuild:default' };
    const events = [];
    return new Promise((resolve) => global.__agent.run('hello', (e) => { events.push({ type: e.type, text: e.text }); if (e.type === 'done') resolve(events); }));
  });
  const readMeter = () => ui.evaluate(() => {
    const m = document.getElementById('usage-meter');
    const b = m.querySelector('.um-bar');
    return { hidden: m.hidden, text: m.textContent, cls: m.className, kind: m.dataset.kind || '', barHidden: b.hidden, now: b.getAttribute('aria-valuenow'), role: b.getAttribute('role'), label: b.getAttribute('aria-label') };
  });
  const pickGrok = () => ui.evaluate(() => {
    const sel = document.getElementById('model');
    if (![...sel.options].some((o) => o.value === 'grokbuild:default')) sel.append(new Option('Grok Build', 'grokbuild:default'));
    sel.value = 'grokbuild:default';
    sel.dispatchEvent(new Event('change'));
  });
  const until = async (pred, ms = 8000) => {
    let m = null;
    for (let i = 0; i < ms / 250; i++) { await pickGrok(); await sleep(250); m = await readMeter(); if (pred(m)) return m; }
    return m;
  };

  let m = await until((x) => !x.hidden && /Send a message to see Grok usage/.test(x.text));
  check('Grok bar: with no Grok turn yet there is no bar, only the hint', m && !m.hidden && m.barHidden && /Send a message to see Grok usage/.test(m.text), JSON.stringify(m));

  await grokTurn();
  m = await until((x) => /25% of context/.test(x.text));
  check('Grok bar: default is the context fill (25%) with tokens and cost today', /25% of context · 50\.2k tokens · \$0\.40 today/.test(m.text) && m.kind === 'context' && !/high|warn/.test(m.cls), JSON.stringify(m));
  check('Grok bar: a progressbar with the value, label and no plan wording', m.role === 'progressbar' && m.now === '25' && !m.barHidden && /Grok Build usage/.test(m.label) && !/Plan/.test(m.text), JSON.stringify(m));

  await stub({ use: grokUse(150000) });
  await grokTurn();
  m = await until((x) => /75% of context/.test(x.text));
  check('Grok bar: amber near the auto-compaction threshold (75% of an 80% threshold)', /warn/.test(m.cls) && !/high/.test(m.cls), JSON.stringify(m));
  await stub({ use: grokUse(50000) });

  // A budget of $1 a day: 2 turns of $0.40 have been used ($0.80 = 80%).
  await app.evaluate(() => global.__usage.setBudget({ unit: 'usd', daily: 1 }));
  m = await until((x) => x.kind === 'budget');
  check('Grok bar: a budget makes it a progress bar toward it (80%), amber, with the reset time', /Budget 80%/.test(m.text) && /resets/.test(m.text) && m.now === '80' && /warn/.test(m.cls), JSON.stringify(m));
  const t3 = await grokTurn();
  m = await until((x) => /Budget 100%/.test(x.text));
  check('Grok bar: at 100% of the budget it is red and stops at 100', /high/.test(m.cls) && m.now === '100', JSON.stringify(m));
  check('Grok budget: one non-blocking notice when 100% is crossed', t3.some((e) => e.type === 'notice' && /reached your daily Grok budget/.test(e.text)) && t3.some((e) => e.type === 'done'), JSON.stringify(t3));
  const t4 = await grokTurn();
  check('Grok budget: no second notice for the same level', !t4.some((e) => e.type === 'notice' && /budget/.test(e.text)), JSON.stringify(t4));
  await app.evaluate(() => global.__usage.setBudget({ unit: 'usd', daily: 0, weekly: 0 }));
  m = await until((x) => x.kind === 'context');
  check('Grok bar: with the budget removed it is the context fill again', m.kind === 'context', JSON.stringify(m));

  // Limit reached, with the time Grok's message named.
  const limitAt = Date.now() + 2 * 3600e3;
  await stub({ mode: 'limit', limit: { text: 'Usage limit reached. Resets at soon', resetsAt: limitAt } });
  await grokTurn();
  m = await until((x) => x.kind === 'limit');
  check('Grok bar: a limit-reached turn makes it red: "Grok limit reached, resets at <time>"', /Grok limit reached, resets at \d/.test(m.text) && /high/.test(m.cls) && m.now === '100', JSON.stringify(m));
  s = await summary(false);
  check('Grok limit: kept with its reset time in the usage log', s.grok.limit?.resetsAt === limitAt && s.bars.grokbuild.kind === 'limit', JSON.stringify(s.grok.limit));
  await stub({ limit: { text: 'Limit reached', resetsAt: null } });
  await grokTurn();
  m = await until((x) => x.kind === 'limit' && /^Grok limit reached$/.test(x.text));
  check('Grok bar: a limit with no time in the message says only "limit reached"', /^Grok limit reached$/.test(m.text), JSON.stringify(m));
  await stub({ mode: 'ok' });
  await grokTurn();
  m = await until((x) => x.kind === 'context');
  check('Grok bar: the next Grok turn that works clears the limit', m.kind === 'context' && (await summary(false)).grok.limit === null, JSON.stringify(m));
  await stub({ mode: 'limit', limit: { text: 'Limit reached, resets in a moment', resetsAt: Date.now() + 2500 } });
  await grokTurn();
  m = await until((x) => x.kind === 'limit');
  check('Grok limit: shown while its reset time is ahead', m.kind === 'limit', JSON.stringify(m));
  await stub({ mode: 'ok' });
  m = await until((x) => x.kind === 'context', 9000);
  check('Grok limit: the bar leaves the limit state by itself when the reset time passes', m.kind === 'context', JSON.stringify(m));

  // Settings → Usage: the plain line, the rolling use, and the budget the user can set.
  await app.evaluate(() => global.__settings.open('usage'));
  let gp = null;
  for (let i = 0; i < 40 && !(gp && gp.save); i++) {
    await sleep(250);
    gp = await app.evaluate(async () => {
      const t = global.__settings.tabs().find((x) => x.settings);
      const wc = t && global.__settings.contents(t.id);
      return wc ? wc.executeJavaScript("(() => { const sec = document.getElementById('sec-usage'); return sec && !sec.hidden && { save: Boolean(document.getElementById('usage-budget-save')), text: sec.textContent }; })()") : null;
    });
  }
  check('Settings → Usage: says Grok doesn’t share plan limits and this is Lumen’s own use', gp && /Grok doesn’t share your plan’s limits, so this shows Lumen’s own use; set a budget to get a progress bar\./.test(gp.text), JSON.stringify(gp).slice(0, 600));
  check('Settings → Usage: Lumen’s Grok use in the last 5 hours and 7 days, not plan remaining', gp && /Last 5 hours: \d+ turns?/.test(gp.text) && /Last 7 days: \d+ turns?/.test(gp.text) && /not what’s left of your plan/.test(gp.text), gp?.text.slice(0, 400));
  await app.evaluate(async () => {
    const t = global.__settings.tabs().find((x) => x.settings);
    await global.__settings.contents(t.id).executeJavaScript("(() => { document.getElementById('usage-budget-daily').value = '3'; document.getElementById('usage-budget-unit').value = 'tokens'; document.getElementById('usage-budget-save').click(); })()");
  });
  let saved = null;
  for (let i = 0; i < 20 && !(saved && saved.daily === 3); i++) { await sleep(200); saved = await app.evaluate(() => global.__usage.budget()); }
  check('Settings → Usage: the budget saved from the page is applied (3 tokens a day, as typed)', saved && saved.daily === 3 && saved.unit === 'tokens', JSON.stringify(saved));

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
