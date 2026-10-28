// The usage bar for the engines other than Claude Code, with fake readings only: Codex's plan windows of every length (the
// 5-hour and weekly ones, and a free plan's single 30-day window, which used to give no bar at all), the remaining share and the
// reset date, and that Grok Build and Antigravity, which report no plan numbers, get no plan bar (a limit message at most).
// Pure node: no window, no network, no real ~/.codex.
const cu = require('../../src/ai/codex-usage');
const U = require('../../src/features/usage');
const UB = require('../../src/renderer/usage-bars');
const UP = require('../../src/renderer/usage-popover');
const AS = require('../../src/features/aistatus-view');

module.exports = async function engineUsageBarUnits(check) {
  const NOW = new Date(2026, 9, 27, 12, 0, 0).getTime();
  const H = 3600e3;
  const D = 86400e3;
  const at = new Date(NOW - 60e3).toISOString();
  // A rollout token_count line as Codex writes it, with the windows given.
  const line = (primary, secondary = null, plan = 'plus') => ({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary, secondary, credits: { has_credits: false, unlimited: false, balance: null }, plan_type: plan, rate_limit_reached_type: null } } });
  const scanOf = (ev) => ({ sessions: 1, today: null, week: null, latestAt: NOW, limits: { ...ev.limits, at: NOW - 60e3 } });
  const sec = (ms) => Math.floor(ms / 1000);

  // ---- a free plan: one 30-day window (window_minutes 43200), the shape this computer's Codex really reports
  const free = cu.fromRolloutLine(line({ used_percent: 29, window_minutes: 43200, resets_at: sec(NOW + 24 * D) }, null, 'free'));
  const fw = cu.windowsOf(free.limits);
  check('codex windows: a 30-day window is neither 5-hour nor weekly, but is in `all`', fw.fiveHour === null && fw.weekly === null && fw.all.length === 1 && fw.all[0].minutes === 43200, JSON.stringify(fw));
  const freeSum = U.codexSummary(scanOf(free), NOW);
  check('codex summary: carries every window, shortest first', freeSum.windows.length === 1 && freeSum.windows[0].percent === 29 && freeSum.windows[0].expired === false && freeSum.planType === 'free', JSON.stringify(freeSum.windows));
  const freeBar = U.barFor('codex', { codex: freeSum });
  check('codex bar: a free plan\'s 30-day window now gives a plan bar, with its length and reset time', freeBar && freeBar.kind === 'plan' && freeBar.percent === 29 && freeBar.minutes === 43200 && freeBar.resetsAt === sec(NOW + 24 * D) * 1000 && freeBar.weekly === null, JSON.stringify(freeBar));
  const fd = UB.describe(freeBar, { now: NOW });
  check('codex bar: named "30-day limit", with the used and the left share', fd && fd.text === '29%' && /^30-day limit: 29% used, resets .+, 71% left$/.test(fd.title), fd && fd.title);
  check('codex bar: a reset weeks away names its date, not only a weekday', /resets [A-Z][a-z]{2} \d{1,2}/.test(fd.title) && !/resets (Mon|Tue|Wed|Thu|Fri|Sat|Sun) /.test(fd.title), fd.title);
  const pop = UP.view('codex', { bars: { codex: freeBar }, codex: freeSum }, { now: NOW, name: 'Codex' });
  check('codex popover: one "30-day limit" row with the date and the time left, and the plan word', pop.windows.length === 1 && pop.windows[0].label === '30-day limit' && /in 24 d/.test(pop.windows[0].text) && pop.plan === 'Free plan', JSON.stringify(pop));
  const card = AS.shape({ engines: { claudecode: { installed: false }, grokbuild: { installed: false }, antigravity: { installed: false }, codex: { installed: true, signedIn: true } }, codexMeter: { percent: 29, resetsAt: NOW + 24 * D, minutes: 43200 } }, NOW).ais.find((a) => a.id === 'codex');
  check('ai status card: the Codex note names the 30-day window', card && /^29% of the 30-day limit used, resets /.test(card.note), card && card.note);

  // ---- a paid plan: the 5-hour window is the bar, the weekly one the second number
  const plus = cu.fromRolloutLine(line({ used_percent: 41.6, window_minutes: 300, resets_at: sec(NOW + 2 * H) }, { used_percent: 12, window_minutes: 10080, resets_at: sec(NOW + 4 * D) }));
  const plusBar = U.barFor('codex', { codex: U.codexSummary(scanOf(plus), NOW) });
  check('codex bar: a paid plan shows the 5-hour window with the weekly one beside it', plusBar.minutes === 300 && plusBar.weekly.minutes === 10080 && Math.round(plusBar.percent) === 42 && plusBar.weekly.percent === 12, JSON.stringify(plusBar));
  const pd = UB.describe(plusBar, { now: NOW });
  check('codex bar: "5-hour limit" and "weekly limit" lines, each with what is left', /5-hour limit: 42% used, resets .+, 58% left/.test(pd.title) && /weekly limit: 12% used, resets .+, 88% left/.test(pd.title), pd.title);
  // secondary listed first in the file: still sorted by length
  const swapped = cu.fromRolloutLine(line({ used_percent: 12, window_minutes: 10080, resets_at: sec(NOW + 4 * D) }, { used_percent: 41.6, window_minutes: 300, resets_at: sec(NOW + 2 * H) }));
  check('codex bar: the windows are ordered by length, whichever is primary', U.barFor('codex', { codex: U.codexSummary(scanOf(swapped), NOW) }).minutes === 300, '');
  // the 5-hour window reset since the reading: the weekly one is the bar, and it is labelled weekly (not "5-hour")
  const laterBar = U.barFor('codex', { codex: U.codexSummary(scanOf(plus), NOW + 3 * H) });
  const ld = UB.describe(laterBar, { now: NOW + 3 * H });
  check('codex bar: after the 5-hour window resets, the weekly one is the bar and is called weekly', laterBar.minutes === 10080 && laterBar.weekly === null && /^weekly limit: 12% used/.test(ld.title), ld && ld.title);
  check('codex bar: every window reset since the reading gives no bar, not a stale number', U.barFor('codex', { codex: U.codexSummary(scanOf(plus), NOW + 5 * D) }) === null, '');
  check('codex bar: an API-key sign-in (no rate_limits) gives no bar', U.barFor('codex', { codex: U.codexSummary({ sessions: 3, limits: null }, NOW) }) === null, '');
  check('codex bar: a summary from before `windows` existed still works', U.barFor('codex', { codex: { fiveHour: { percent: 20, minutes: 300, resetsAt: NOW + H }, weekly: null } }).percent === 20, '');

  // ---- window names by length
  check('window names: 5-hour, weekly, daily, 30-day, 12-hour; no length is the default it stands for', UB.windowLabel(300) === '5-hour limit' && UB.windowLabel(10080) === 'weekly limit' && UB.windowLabel(1440) === 'daily limit' && UB.windowLabel(43200) === '30-day limit' && UB.windowLabel(720) === '12-hour limit' && UB.windowLabel(null) === '5-hour limit' && UB.windowLabel(null, 'week') === 'weekly limit', '');
  check('window names: the short words for the composer', UB.windowLabel(10080, 'week', { short: true }) === 'week' && UB.windowLabel(43200, 'week', { short: true }) === '30-day', '');
  check('reset clock: today a time, within the week a weekday, further out a date', !/[A-Z][a-z]{2}/.test(UB.clockOf(NOW + H, NOW)) && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(UB.clockOf(NOW + 2 * D, NOW)) && /^[A-Z][a-z]{2} \d{1,2}/.test(UB.clockOf(NOW + 20 * D, NOW)), [UB.clockOf(NOW + H, NOW), UB.clockOf(NOW + 2 * D, NOW), UB.clockOf(NOW + 20 * D, NOW)].join(' | '));

  // ---- Claude Code's bar is unchanged: no length on its windows, so the same names as before
  const cc = UB.describe({ engine: 'claudecode', kind: 'plan', percent: 30, resetsAt: NOW + H, resetsText: null, weekly: { percent: 91, resetsText: 'Mon 12:00 AM' } }, { now: NOW });
  check('claude code bar: still "5-hour limit" and "weekly limit"', /^5-hour limit: 30% used/.test(cc.title) && /weekly limit: 91% used, resets Mon 12:00 AM/.test(cc.title), cc.title);

  // ---- engines with no plan numbers: Grok Build and Antigravity never get a plan percentage
  const agyLimit = U.barFor('antigravity', { limits: { antigravity: { resetsAt: NOW + 5 * H, text: 'Quota exhausted' } } });
  check('antigravity: its quota message is the limit state with the reset time, nothing more', agyLimit.kind === 'limit' && agyLimit.resetsAt === NOW + 5 * H && UB.describe(agyLimit, { now: NOW }).out, JSON.stringify(agyLimit));
  check('antigravity / grok build: no reading gives no bar, never a guess', U.barFor('antigravity', {}) === null && U.barFor('grokbuild', {}) === null && UB.forModel('antigravity:gemini-3.8-flash-high', { bars: { antigravity: null }, cooling: {} }, NOW) === null && UB.forModel('grokbuild:grok-4.6', { bars: {}, cooling: {} }, NOW) === null, '');
  const ctx = U.barFor('grokbuild', { engines: { grokbuild: { today: { turns: 2, tokens: 900, costUSD: 0 }, last: { contextTokens: 9000, contextWindow: 100000 } } } });
  check('grok build: its bar is the chat\'s context fill, which the plan bars ignore (it is not plan usage)', ctx.kind === 'context' && UB.describe(ctx, { now: NOW }) === null, JSON.stringify(ctx));

  // ---- the right engine for the chat's model
  const state = { bars: { claudecode: { engine: 'claudecode', kind: 'plan', percent: 70, resetsAt: NOW + H, weekly: null }, codex: freeBar }, cooling: {} };
  check('picker bars: a Codex model reads Codex\'s numbers, a Claude Code one Claude\'s, Auto none', UB.forModel('codex:default', state, NOW).percent === 29 && UB.forModel('claudecode:sonnet', state, NOW).percent === 70 && UB.forModel('auto', state, NOW) === null && UB.engineOf('codex:auto') === 'codex', '');
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
