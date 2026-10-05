// Usage: the plan's limits (a stand-in `claude` answering `/usage`) and Lumen's share of them
// (and Grok Build's bar: context fill, a budget, the limit-reached state; stubbed turns only)
// (stubbed Claude Code / Grok Build turns reporting tokens and rate_limit_event readings), shown in
// Settings → Usage and the sidebar's meter, and kept across a restart. Offline; no real CLI runs.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parsePlan, fiveHourOf } = require('../src/features/usage');

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

  // ---- the popover a click on the meter opens (not Settings): windows, what Lumen counted, link to Settings → Usage
  const pop = () => ui.evaluate(() => { const p = document.getElementById('usage-popover'); const m = document.getElementById('usage-meter'); return { open: Boolean(p && !p.hidden), expanded: m.getAttribute('aria-expanded'), focusInside: Boolean(p && p.contains(document.activeElement)) || document.activeElement === p, focusOnMeter: document.activeElement === m, text: p ? p.textContent : '', bars: p ? p.querySelectorAll('[role=progressbar]').length : 0, link: Boolean(p && p.querySelector('.up-link')) }; });
  await ui.evaluate(() => { const t = document.getElementById('toggle-sidebar'); if (t.getAttribute('aria-pressed') !== 'true') t.click(); });
  await ui.evaluate(() => { const sel = document.getElementById('model'); if (![...sel.options].some((o) => o.value === 'claudecode:default')) sel.append(new Option('Claude Code', 'claudecode:default')); sel.value = 'claudecode:default'; sel.dispatchEvent(new Event('change')); }); // (the model list was reloaded when the sidebar opened)
  await sleep(600);
  const clickMeter = async () => { await ui.evaluate(() => document.getElementById('usage-meter').click()); await sleep(250); }; // (the strip is still settling after the sidebar opens, so a pointer click is never "stable")
  for (let i = 0; i < 25 && !(await ui.isVisible('#usage-meter')); i++) await sleep(200);
  await clickMeter();
  let popup = await pop();
  check('clicking the plan meter opens a popover with both bars and the Settings link, not a page', popup.open && popup.expanded === 'true' && popup.bars >= 1 && popup.link && /resets/.test(popup.text) && /Today/.test(popup.text) && /Usage settings/.test(popup.text), JSON.stringify(popup));
  check('the popover takes focus', popup.focusInside, JSON.stringify(popup));
  if (process.env.LUMEN_SHOT) await ui.screenshot({ path: process.env.LUMEN_SHOT });
  await ui.keyboard.press('Escape');
  popup = await pop();
  check('Esc closes the popover and focus returns to the meter', !popup.open && popup.expanded === 'false' && popup.focusOnMeter, JSON.stringify(popup));
  await clickMeter();
  await clickMeter();
  popup = await pop();
  check('clicking the meter again closes the popover', !popup.open, JSON.stringify(popup));
  await clickMeter();
  await ui.evaluate(() => document.getElementById('messages').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  popup = await pop();
  check('clicking outside closes the popover', !popup.open, JSON.stringify(popup));

  // ---- Settings → Usage
  await app.evaluate(() => global.__settings.open('usage'));
  let page = null;
  for (let i = 0; i < 40 && !(page && page.meters >= 1); i++) {
    await sleep(250);
    page = await app.evaluate(async () => {
      const t = global.__settings.tabs().find((x) => x.settings);
      const wc = t && global.__settings.contents(t.id);
      return wc ? wc.executeJavaScript("(() => { const sec = document.getElementById('sec-usage'); return sec && !sec.closest('[hidden]') && { meters: sec.querySelectorAll('.meter').length, width: sec.querySelector('.meter i')?.style.width, text: sec.textContent }; })()") : null;
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

  // ---- Codex CLI: its own 5-hour / weekly windows and token totals, read from its session logs (stubbed here: the real ~/.codex is never read)
  const inHours = (h) => Date.now() + h * 3600e3;
  await app.evaluate((_e, t) => {
    global.__usage.clear();
    global.__codexScan = (now) => ({
      sessions: 2, latestAt: now, today: { sessions: 1, tokens: 31200, input: 6000, output: 1200, cached: 24000, reasoning: 300 }, week: { sessions: 2, tokens: 90000, input: 20000, output: 4000, cached: 66000, reasoning: 900 },
      limits: { planType: 'plus', reached: false, at: now, primary: { percent: 41.6, minutes: 300, resetsAt: t.five, expired: false }, secondary: { percent: 12, minutes: 10080, resetsAt: t.week, expired: false } },
    });
  }, { five: inHours(2), week: inHours(90) });
  const cs = await summary(true);
  check('usage summary: Codex\'s 5-hour and weekly windows and its bar', cs.codex && Math.round(cs.codex.fiveHour.percent) === 42 && Math.round(cs.codex.weekly.percent) === 12 && cs.bars.codex.kind === 'plan', JSON.stringify(cs.codex));
  await app.evaluate(() => global.__settings.open('usage'));
  await sleep(800);
  await app.evaluate(async () => { const t = global.__settings.tabs().find((x) => x.settings); await global.__settings.contents(t.id).executeJavaScript("document.getElementById('usage-refresh')?.click()"); }); // (the page was already open: re-read)
  let cp = null;
  for (let i = 0; i < 40 && !(cp && /Codex 5-hour limit/.test(cp.text)); i++) {
    await sleep(250);
    cp = await app.evaluate(async () => {
      const t = global.__settings.tabs().find((x) => x.settings);
      const wc = t && global.__settings.contents(t.id);
      return wc ? wc.executeJavaScript("(() => { const sec = document.getElementById('sec-usage'); return sec && !sec.hidden && { text: sec.textContent }; })()") : null;
    });
  }
  check('Settings → Usage: Codex 5-hour and weekly meters with the plan, and tokens with no price', cp && /Codex 5-hour limit \(Plus plan\)/.test(cp.text) && /Codex weekly limit/.test(cp.text) && /Today: 1 session · 31k tokens/.test(cp.text) && /doesn’t report a price/.test(cp.text), cp && cp.text.slice(-900));
  await app.evaluate((_e, t) => { global.__codexScan = (now) => ({ sessions: 1, latestAt: now, today: { sessions: 1, tokens: 5, input: 5, output: 0, cached: 0, reasoning: 0 }, week: { sessions: 1, tokens: 5, input: 5, output: 0, cached: 0, reasoning: 0 }, limits: { planType: null, reached: true, at: now, primary: { percent: 100, minutes: 300, resetsAt: t, expired: false }, secondary: null } }); global.__usage.clear(); }, inHours(1));
  const hitSum = await summary(true);
  check('Codex limit reached: the summary carries the reset time and the bar is the limit state', hitSum.codex.reached && hitSum.bars.codex.kind === 'limit' && hitSum.bars.codex.resetsAt > Date.now(), JSON.stringify(hitSum.bars.codex));
  await app.evaluate(() => { global.__codexScan = (now) => ({ sessions: 1, latestAt: now, today: { sessions: 1, tokens: 5, input: 5, output: 0, cached: 0, reasoning: 0 }, week: { sessions: 1, tokens: 5, input: 5, output: 0, cached: 0, reasoning: 0 }, limits: null }); global.__usage.clear(); });
  const apiKey = await summary(true);
  check('Codex with no plan data (an API-key sign-in): no bar, and the summary says why', apiKey.codex && !apiKey.codex.hasLimits && apiKey.bars.codex === null && /not reported plan limits/.test(apiKey.codex.note), JSON.stringify(apiKey.codex));

  // ---- the small usage bars (renderer/usage-bars.js): in the model picker's provider headings and rows, from the cached usage numbers
  await app.evaluate(() => { global.__codexScan = () => null; global.__usage.clear(); });
  const reset5 = Math.floor(Date.now() / 1000) + 3 * 3600;
  await app.evaluate((_e, reset) => global.__usage.record('claudecode', { usage: { inputTokens: 10, outputTokens: 5, costUSD: 0.01 }, rateLimit: { status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.86, resetsAt: reset } } } }), reset5);
  const cachedSum = await app.evaluate(() => global.__usage.summary({ cached: true }));
  check('bars: the cached summary carries the 86% reading, the setting and the cooldowns, with no CLI run', Math.round(cachedSum.bars.claudecode?.percent) === 86 && cachedSum.showBars === true && typeof cachedSum.cooling === 'object', JSON.stringify(cachedSum.bars.claudecode));
  await ui.evaluate(() => {
    const sel = document.getElementById('model');
    const group = (label, items) => { const g = document.createElement('optgroup'); g.label = label; for (const [v, name] of items) { const o = new Option(name, v); o.dataset.name = name; g.append(o); } return g; };
    sel.replaceChildren(group('Your Claude account', [['claudecode:sonnet', 'Sonnet'], ['claudecode:opus', 'Opus']]), group('OpenAI', [['openai:gpt-5', 'GPT-5'], ['openai:gpt-5-mini', 'GPT-5 mini']]));
    sel.value = 'claudecode:sonnet';
    sel.pickerSync();
  });
  const openPicker = async () => {
    await ui.evaluate(async () => { await window.usageBars.load(true); });
    await ui.evaluate(() => modelPicker.open());
    await ui.waitForSelector('.picker-menu:not([hidden]) .picker-group', { state: 'attached' });
    const out = await ui.evaluate(() => {
      const bar = (el) => { const b = el && el.querySelector('.ubar'); return b && { role: b.getAttribute('role'), now: b.getAttribute('aria-valuenow'), text: b.textContent, level: b.dataset.level, out: b.dataset.out === '1', valuetext: b.getAttribute('aria-valuetext'), title: b.title, label: b.getAttribute('aria-label') }; };
      const menu = document.querySelector('.picker-menu:not([hidden])');
      const heads = [...menu.querySelectorAll('.picker-group')].map((h) => ({ name: h.firstChild.textContent, bar: bar(h) }));
      const rows = [...menu.querySelectorAll('.picker-item')].map((r) => ({ name: r.querySelector('.picker-name')?.textContent, out: r.classList.contains('picker-out'), bar: bar(r), label: r.getAttribute('aria-label') }));
      return { heads, rows };
    });
    await ui.evaluate(() => modelPicker.close(false));
    return out;
  };
  let pk = await openPicker();
  const claudeHead = pk.heads.find((h) => /Claude/.test(h.name));
  const openaiHead = pk.heads.find((h) => /OpenAI/.test(h.name));
  check('bars: the Claude Code heading in the picker has a progressbar at 86% (amber), with the reset time in its tooltip', claudeHead?.bar && claudeHead.bar.role === 'progressbar' && claudeHead.bar.now === '86' && claudeHead.bar.text === '86%' && claudeHead.bar.level === 'warn' && /resets/.test(claudeHead.bar.title) && /86% used/.test(claudeHead.bar.valuetext), JSON.stringify(claudeHead));
  check('bars: a provider with no usage data (OpenAI by key) gets no bar', openaiHead && !openaiHead.bar && pk.rows.filter((r) => /GPT/.test(r.name)).every((r) => !r.bar && !r.out), JSON.stringify(pk.heads));
  check('bars: rows under a heading carry no repeated bar while nothing is out', pk.rows.every((r) => !r.bar), JSON.stringify(pk.rows));

  // A provider that hit a usage limit (the model fallback's cooldown) is marked on its rows and heading
  await app.evaluate(() => global.__aiFallback.shared.mark('openai:gpt-5', { kind: 'limit', scope: 'provider', resetsAt: Date.now() + 3600e3, exact: true }));
  pk = await openPicker();
  const gpt = pk.rows.find((r) => r.name === 'GPT-5');
  check('bars: a model out of usage is marked: dimmed row, an "out" bar with the reset time, and said to a screen reader', gpt && gpt.out && gpt.bar && gpt.bar.text === 'out' && gpt.bar.level === 'high' && /Out of usage, resets/.test(gpt.bar.title) && /Out of usage/.test(gpt.label), JSON.stringify(gpt));
  check('bars: its provider heading shows "out" too, and the other provider is unchanged', pk.heads.find((h) => /OpenAI/.test(h.name))?.bar?.text === 'out' && pk.heads.find((h) => /Claude/.test(h.name))?.bar?.text === '86%', JSON.stringify(pk.heads));
  await app.evaluate(() => global.__aiFallback.shared.clear());

  // The setting hides every bar
  await app.evaluate(() => global.__patchSettings({ usageBars: false }));
  pk = await openPicker();
  check('bars: with "Show usage bars in pickers" off, no bar and no out mark appears', pk.heads.every((h) => !h.bar) && pk.rows.every((r) => !r.bar && !r.out), JSON.stringify(pk));
  await app.evaluate(() => global.__patchSettings({ usageBars: true }));
  pk = await openPicker();
  check('bars: turned back on they return', pk.heads.some((h) => h.bar && h.bar.now === '86'), JSON.stringify(pk.heads));

  // Settings → Usage has the switch, and it is the setting
  await app.evaluate(() => global.__settings.open('usage'));
  let sw = null;
  for (let i = 0; i < 40 && !(sw && sw.found); i++) {
    await sleep(250);
    sw = await app.evaluate(async () => {
      const t = global.__settings.tabs().find((x) => x.settings);
      const wc = t && global.__settings.contents(t.id);
      return wc ? wc.executeJavaScript("(() => { const i = document.getElementById('pref-usageBars'); return { found: Boolean(i), on: i && i.checked, label: i && i.getAttribute('aria-label') }; })()") : null;
    });
  }
  check('Settings → Usage: a "Show usage bars in pickers" switch, on by default', sw && sw.found && sw.on === true && /Show usage bars in pickers/.test(sw.label), JSON.stringify(sw));
  await app.evaluate(async () => { const t = global.__settings.tabs().find((x) => x.settings); await global.__settings.contents(t.id).executeJavaScript("document.getElementById('pref-usageBars').click()"); });
  let off = null;
  for (let i = 0; i < 20 && !(off && off.showBars === false); i++) { await sleep(200); off = await app.evaluate(() => global.__usage.summary({ cached: true })); }
  check('Settings → Usage: turning it off is the setting the bars follow', off && off.showBars === false, JSON.stringify(off && off.showBars));
  await app.evaluate(() => global.__patchSettings({ usageBars: true }));

  // ---- every other AI has the same sections (provider-usage.js): fake numbers only, no provider is called
  await app.evaluate(() => {
    const u = global.__usage;
    u.clear();
    const hdr = { provider: 'openai', at: Date.now(), buckets: [{ kind: 'requests', limit: 500, remaining: 450, resetsAt: Date.now() + 60e3, percent: 10 }, { kind: 'tokens', limit: 30000, remaining: 3000, resetsAt: Date.now() + 60e3, percent: 90 }] };
    u.record('openai', { usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0.02, models: ['openai:gpt-5.6'] }, model: 'openai:gpt-5.6', rate: hdr });
    u.record('openai', { usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: null, models: ['openai:gpt-9'] }, model: 'openai:gpt-9' });
    u.record('gemini', { usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUSD: 0.001, models: ['gemini:gemini-2.5-flash'] }, model: 'gemini:gemini-2.5-flash' });
    u.record('antigravity', { limit: { text: 'RESOURCE_EXHAUSTED: quota exceeded. Resets in 110h', resetsAt: Date.now() + 110 * 3600e3, model: 'gemini-3.1-pro' }, ok: false });
  });
  await app.evaluate(() => global.__settings.open('usage'));
  await sleep(600);
  await app.evaluate(async () => { const t = global.__settings.tabs().find((x) => x.settings); await global.__settings.contents(t.id).executeJavaScript("document.getElementById('usage-refresh')?.click()"); }); // (the page was built before these numbers)
  let prov = null;
  for (let i = 0; i < 40 && !(prov && /OpenAI/.test(prov.text) && /Antigravity limit reached/.test(prov.text)); i++) {
    await sleep(250);
    prov = await app.evaluate(async () => {
      const t = global.__settings.tabs().find((x) => x.settings);
      const wc = t && global.__settings.contents(t.id);
      return wc ? wc.executeJavaScript("(() => { const sec = document.getElementById('sec-usage'); const q = (s) => sec && sec.querySelector(s); return sec && { text: sec.textContent, heads: [...sec.querySelectorAll('.usage-head')].map((x) => x.dataset.provider), days: q('#usage-days-openai')?.textContent, models: q('#usage-models-openai')?.textContent, rateMeters: [...sec.querySelectorAll('.meter')].map((m) => m.getAttribute('aria-label')), budgetId: Boolean(q('#usage-budget-openai-save')) }; })()") : null;
    });
  }
  check('Settings → Usage: a section per AI in the same order', prov && ['claudecode', 'grokbuild', 'codex', 'antigravity', 'anthropic', 'openai', 'xai', 'gemini', 'openrouter'].join() === prov.heads.join(), JSON.stringify(prov?.heads));
  check('Settings → Usage: OpenAI shows its per-minute rate limits (from reply headers), Lumen’s counts per day and per model, and a budget', prov && /Requests per minute/.test(prov.rateMeters.join()) && /Tokens per minute/.test(prov.rateMeters.join()) && /Last 7 days: 2 turns/.test(prov.text) && /gpt-5\.6/.test(prov.models) && /gpt-9/.test(prov.models) && /some turns have no known price/.test(prov.text) && prov.budgetId && /not a plan balance/.test(prov.text), JSON.stringify([prov?.rateMeters, prov?.models]));
  check('Settings → Usage: a provider with no plan API says so instead of showing a number; Gemini says it sends no headers; Antigravity shows its quota reset', prov && /Plan limits are not available from OpenAI/.test(prov.text) && /sends no rate-limit headers/.test(prov.text) && /Antigravity limit reached/.test(prov.text) && /gemini-3\.1-pro/.test(prov.text) && /Resets/.test(prov.text), prov?.text.slice(-1200));
  // a budget for OpenAI through the page
  await app.evaluate(async () => { const t = global.__settings.tabs().find((x) => x.settings); await global.__settings.contents(t.id).executeJavaScript("(() => { const set = (id, v) => { const i = document.getElementById(id); i.value = v; }; set('usage-budget-openai-unit', 'tokens'); set('usage-budget-openai-daily', '1000'); document.getElementById('usage-budget-openai-save').click(); })()"); });
  let ob = null;
  for (let i = 0; i < 20 && !(ob && ob.budgets.openai.config.daily === 1000); i++) { await sleep(200); ob = await app.evaluate(() => global.__usage.summary({ cached: true })); }
  check('Settings → Usage: an OpenAI budget set on the page is the provider’s budget, and its bar is a budget bar', ob && ob.budgets.openai.config.unit === 'tokens' && ob.bars.openai?.kind === 'budget' && ob.budgets.grokbuild === undefined, JSON.stringify(ob && ob.budgets.openai));

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
