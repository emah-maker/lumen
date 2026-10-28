// The usage bar above the chat box follows the chat's engine, drawn from stubbed readings only (the real ~/.codex is never read):
//  - Codex on a free plan (one 30-day window, which used to give no bar): "Plan 29% · resets <date>", the bar at 29%, its tooltip
//    naming the 30-day limit and what is left, and the popover's row;
//  - Codex on a paid plan: the 5-hour window and "week 12%";
//  - Claude Code: its own 5-hour reading, not Codex's;
//  - Antigravity with no reading: no bar; at its quota limit: the limit line with the reset time.
// Hidden window only: run with CLAUDE_BROWSER_TEST=1 LUMEN_TEST_BACKGROUND=1 and a fresh CLAUDE_BROWSER_PROFILE through scripts/test/e2e-lock.js.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-engine-bar-'));
  const profile = process.env.CLAUDE_BROWSER_PROFILE || path.join(dir, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile };
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await ui.evaluate(() => { const t = document.getElementById('toggle-sidebar'); if (t.getAttribute('aria-pressed') !== 'true') t.click(); });
  await sleep(800);

  const H = 3600e3;
  const D = 86400e3;
  const scanWith = (limits) => app.evaluate((_e, l) => {
    global.__usage.clear();
    global.__codexScan = (now) => ({ sessions: 1, latestAt: now, today: { sessions: 1, tokens: 900, input: 600, output: 300, cached: 0, reasoning: 0 }, week: { sessions: 1, tokens: 900, input: 600, output: 300, cached: 0, reasoning: 0 }, limits: l ? { ...l, at: now } : null });
  }, limits);
  // Pick a model in the sidebar. The CLIs are not installed here, so the row is added and no change event is sent (the sidebar would
  // switch an engine it cannot run back to Auto); the meter reads the picker's value when it is refreshed (until() below).
  let current = '';
  const apply = () => ui.evaluate((v) => { const sel = document.getElementById('model'); if (![...sel.options].some((o) => o.value === v)) sel.append(new Option(v, v)); sel.value = v; }, current);
  const pick = (value) => { current = value; return apply(); }; // (a model-list reload may put the picker back to Auto: until() applies it again)
  const read = () => ui.evaluate(() => {
    const m = document.getElementById('usage-meter');
    const bar = m && m.querySelector('.um-bar');
    const fill = bar && bar.querySelector('i');
    return m && { hidden: m.hidden, text: m.querySelector('.um-text')?.textContent || '', title: m.title, kind: m.dataset.kind || '', barHidden: bar ? bar.hidden : true, now: bar?.getAttribute('aria-valuenow'), label: bar?.getAttribute('aria-label'), width: fill?.style.width || '' };
  });
  const until = async (ok) => { let r = null; for (let i = 0; i < 40; i++) { await apply(); await ui.evaluate(() => window.chatUsageMeter?.refresh()); await sleep(200); r = await read(); if (ok(r)) return r; } return r; };

  // ---- Codex, free plan: one 30-day window
  await scanWith({ planType: 'free', reached: false, primary: { percent: 29, minutes: 43200, resetsAt: Date.now() + 24 * D, expired: false }, secondary: null });
  await app.evaluate(() => global.__usage.summary({}));
  await pick('codex:default');
  let m = await until((r) => r && !r.hidden && /Plan 29%/.test(r.text));
  check('Codex free plan: the bar shows "Plan 29%" with a reset date', m && !m.hidden && /^Plan 29% · resets [A-Z][a-z]{2} \d{1,2}/.test(m.text) && m.kind === 'plan', JSON.stringify(m));
  check('Codex free plan: the bar is drawn at 29%, labelled Codex', m && !m.barHidden && m.now === '29' && m.width === '29%' && /Codex/.test(m.label), JSON.stringify(m));
  check('Codex free plan: the tooltip names the 30-day limit and what is left', m && /30-day limit is 29% used \(71% left\)/.test(m.title), m && m.title);
  await apply();
  await ui.evaluate(() => document.getElementById('usage-meter').click());
  await sleep(300);
  const pop = await ui.evaluate(() => { const p = document.getElementById('usage-popover'); return p && { open: !p.hidden, text: p.textContent, bars: p.querySelectorAll('[role=progressbar]').length }; });
  check('Codex free plan: the popover has the 30-day row, its time left and the plan', pop && pop.open && /30-day limit/.test(pop.text) && /29% used/.test(pop.text) && /in 2[34] d/.test(pop.text) && /Free plan/.test(pop.text) && pop.bars >= 1, JSON.stringify(pop));
  await ui.keyboard.press('Escape');

  // ---- Codex, paid plan: 5-hour + weekly
  await scanWith({ planType: 'plus', reached: false, primary: { percent: 41.6, minutes: 300, resetsAt: Date.now() + 2 * H, expired: false }, secondary: { percent: 12, minutes: 10080, resetsAt: Date.now() + 4 * D, expired: false } });
  await app.evaluate(() => global.__usage.summary({}));
  m = await until((r) => r && !r.hidden && /Plan 42%/.test(r.text));
  check('Codex paid plan: "Plan 42% · resets <time> · week 12%"', m && /^Plan 42% · resets .+ · week 12%$/.test(m.text) && /5-hour limit is 42% used \(58% left\)/.test(m.title), JSON.stringify(m));

  // ---- Claude Code: its own reading, not Codex's
  const reset5 = Math.floor(Date.now() / 1000) + 3 * 3600;
  await app.evaluate((_e, reset) => global.__usage.record('claudecode', { usage: { inputTokens: 10, outputTokens: 5, costUSD: 0.01 }, rateLimit: { status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.7, resetsAt: reset } } } }), reset5);
  await pick('claudecode:default');
  m = await until((r) => r && !r.hidden && /Plan 70%/.test(r.text));
  check('Claude Code: the bar switches to Claude\'s 70%, not Codex\'s numbers', m && /Plan 70%/.test(m.text) && !/42%/.test(m.text) && /Claude Code/.test(m.label), JSON.stringify(m));

  // ---- Antigravity: nothing reported -> no bar; its quota limit -> the limit line
  await pick('antigravity:gemini-3.8-flash-high');
  m = await until((r) => r && r.hidden);
  check('Antigravity with no reading: no bar at all (never a guess)', m && m.hidden, JSON.stringify(m));
  await app.evaluate((_e, t) => global.__usage.record('antigravity', { limit: { text: 'Quota exhausted', resetsAt: t } }), Date.now() + 5 * H);
  m = await until((r) => r && !r.hidden && r.kind === 'limit');
  check('Antigravity at its quota limit: the limit line with the reset time', m && !m.hidden && m.kind === 'limit' && /Antigravity/.test(m.text) && /\d{1,2}:\d{2}/.test(m.text), JSON.stringify(m));

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
