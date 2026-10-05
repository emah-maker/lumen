// The usage popover's text (renderer/usage-popover.js): reset-time lines, percentages, counted totals, rate limits and
// what it leaves out when data is missing. Pure node: no window, no network.
const UP = require('../src/renderer/usage-popover');
const usageLib = require('../src/features/usage');

module.exports = async function usagePopoverUnits(check) {
  const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();
  const MIN = 60e3;
  const H = 3600e3;
  const bar = (percent, extra = {}) => ({ engine: 'claudecode', kind: 'plan', percent, resetsAt: NOW + H + 12 * MIN, resetsText: null, weekly: null, ...extra });

  // ---- percentages
  check('popover: percent rounds and clamps', UP.percentText(42.4) === '42%' && UP.percentText(99.5) === '100%' && UP.percentText(180) === '100%' && UP.percentText(-3) === '0%');
  check('popover: a missing percent is empty, never 0%', UP.percentText(null) === '' && UP.percentText(undefined) === '' && UP.percentText(NaN) === '' && UP.percentText('12') === '');

  // ---- relative time
  check('popover: relative time in d / h / m / s', UP.relative(NOW + H + 12 * MIN, NOW) === 'in 1 h 12 m' && UP.relative(NOW + 40 * MIN, NOW) === 'in 40 m' && UP.relative(NOW + 2 * H, NOW) === 'in 2 h' && UP.relative(NOW + 27 * H, NOW) === 'in 1 d 3 h' && UP.relative(NOW + 48 * H, NOW) === 'in 2 d' && UP.relative(NOW + 12e3, NOW) === 'in 12 s');
  check('popover: a past or unknown time has no relative text', UP.relative(NOW - 1, NOW) === '' && UP.relative(NOW, NOW) === '' && UP.relative(null, NOW) === '' && UP.relative(undefined, NOW) === '');

  // ---- reset line: the clock time and how long is left
  const line = UP.resetLine({ resetsAt: NOW + H + 12 * MIN }, NOW);
  check('popover: reset line has the clock time and the time left', /^resets \d{1,2}:\d{2}\s?[AP]M, in 1 h 12 m$/i.test(line) || /^resets \d{1,2}:\d{2}, in 1 h 12 m$/.test(line), line);
  check('popover: another day\'s reset names the weekday', /^resets \w{3}/.test(UP.resetLine({ resetsAt: NOW + 30 * H }, NOW)) && /in 1 d 6 h$/.test(UP.resetLine({ resetsAt: NOW + 30 * H }, NOW)));
  check('popover: the CLI\'s own words are used when it gave no time', UP.resetLine({ resetsText: 'Mon 12:00 AM' }, NOW) === 'resets Mon 12:00 AM');
  check('popover: a reset in the past or no reset at all is empty', UP.resetLine({ resetsAt: NOW - 5 }, NOW) === '' && UP.resetLine({}, NOW) === '' && UP.resetLine(null, NOW) === '');

  // ---- last updated
  check('popover: updated text: just now, minutes, hours, days', UP.updatedText(NOW - 5e3, NOW) === 'Updated just now' && UP.updatedText(NOW - 5 * MIN, NOW) === 'Updated 5 min ago' && UP.updatedText(NOW - 3 * H, NOW) === 'Updated 3 h ago' && UP.updatedText(NOW - 50 * H, NOW) === 'Updated 2 d ago');
  check('popover: unknown update time is empty', UP.updatedText(null, NOW) === '' && UP.updatedText(0, NOW) === '' && UP.updatedText(undefined, NOW) === '');

  // ---- counted totals
  check('popover: counted text has tokens, messages and an estimated cost', UP.countText({ tokens: 12345, turns: 4, costUSD: 0.4 }) === '12k tokens · 4 messages · ≈$0.40', UP.countText({ tokens: 12345, turns: 4, costUSD: 0.4 }));
  check('popover: no cost is shown when none is known', UP.countText({ tokens: 900, turns: 1, costUSD: 0 }) === '900 tokens · 1 messages');
  check('popover: Codex counts sessions, with no price', UP.countText({ tokens: 2500, sessions: 2 }, 'sessions') === '2.5k tokens · 2 sessions');
  check('popover: a tiny cost keeps its digits', UP.countText({ tokens: 10, turns: 1, costUSD: 0.0042 }).endsWith('≈$0.0042'));
  check('popover: nothing counted is empty', UP.countText(null) === '' && UP.countText({ tokens: 0, turns: 0, costUSD: 0 }) === '' && UP.countText(undefined, 'sessions') === '');

  // ---- the whole view: Claude Code, two windows
  const summary = {
    bars: { claudecode: bar(30, { weekly: { percent: 91, resetsText: 'Mon 12:00 AM' } }) },
    plan: { available: true, subscription: true, limits: [] },
    meter: { percent: 30, resetsAt: NOW + H, at: NOW - 5 * MIN },
    providers: { claudecode: { today: { turns: 4, tokens: 12345, costUSD: 0.4 }, week: { turns: 30, tokens: 600000, costUSD: 5.5 } } },
    notes: {},
  };
  const v = UP.view('claudecode', summary, { now: NOW, name: 'Claude Code' });
  check('popover: both limit windows with percent, level and reset text', v.windows.length === 2 && v.windows[0].label === '5-hour limit' && v.windows[0].percentText === '30%' && v.windows[0].level === 'ok' && /^resets .*, in 1 h 12 m$/.test(v.windows[0].text) && v.windows[1].label === 'weekly limit' && v.windows[1].percentText === '91%' && v.windows[1].level === 'warn' && v.windows[1].text === 'resets Mon 12:00 AM', JSON.stringify(v.windows));
  check('popover: the plan, counted usage and the update time', v.plan === 'Claude subscription' && v.counted.length === 2 && v.counted[0].label === 'Today' && v.counted[0].text === '12k tokens · 4 messages · ≈$0.40' && v.counted[1].label === 'Last 7 days' && v.updated === 'Updated 5 min ago', JSON.stringify(v));

  // ---- the weekly window's exact time (Codex keeps it in the bar)
  const cx = usageLib.barFor('codex', { codex: { fiveHour: { percent: 20, resetsAt: NOW + H }, weekly: { percent: 55, resetsAt: NOW + 50 * H } } });
  const vc = UP.view('codex', { bars: { codex: cx }, codex: { available: true, planType: 'plus', readAt: NOW - 2 * H, today: { sessions: 1, tokens: 1000 }, week: { sessions: 3, tokens: 9000 } } }, { now: NOW, name: 'Codex' });
  check('popover: Codex shows both windows with exact reset times, its plan and its sessions', vc.windows.length === 2 && /in 2 d 2 h$/.test(vc.windows[1].text) && vc.plan === 'Plus plan' && vc.counted[0].text === '1k tokens · 1 sessions' && vc.updated === 'Updated 2 h ago', JSON.stringify(vc));

  // ---- missing data: nothing made up
  const bare = UP.view('claudecode', { bars: { claudecode: bar(30) } }, { now: NOW, name: 'Claude Code' });
  check('popover: with no counted data, plan or update time those parts are empty', bare.windows.length === 1 && bare.counted.length === 0 && bare.plan === '' && bare.updated === '' && bare.rates.length === 0, JSON.stringify(bare));
  const reset = UP.view('claudecode', { bars: { claudecode: bar(30, { resetsAt: NOW - 1000 }) } }, { now: NOW });
  check('popover: a window that has already reset shows no number', reset.windows.length === 0, JSON.stringify(reset.windows));
  const noReset = UP.view('claudecode', { bars: { claudecode: bar(30, { resetsAt: null }) } }, { now: NOW });
  check('popover: a window with no known reset keeps its percent and an empty reset line', noReset.windows.length === 1 && noReset.windows[0].percentText === '30%' && noReset.windows[0].text === '', JSON.stringify(noReset.windows));
  check('popover: no key, no state: nothing to show', UP.view('', summary) === null && UP.view('claudecode', null) === null && UP.view('claudecode', undefined) === null);
  const limit = UP.view('grokbuild', { bars: { grokbuild: { engine: 'grokbuild', kind: 'limit', percent: 100, resetsAt: NOW + 3 * H, message: 'Plan limit reached' } } }, { now: NOW, name: 'Grok Build' });
  check('popover: a limit-reached state shows its reset and message', limit.windows.length === 1 && limit.windows[0].key === 'limit' && /in 3 h$/.test(limit.windows[0].text) && limit.message === 'Plan limit reached', JSON.stringify(limit));

  // ---- API key: no plan window, per-minute rate limits and why there is none
  const api = UP.view('openai', {
    bars: { openai: null },
    rate: { openai: { at: NOW - MIN, buckets: [
      { kind: 'requests', label: 'Requests per minute', limit: 500, remaining: 400, percent: 20, resetsAt: NOW + 12e3, expired: false },
      { kind: 'tokens', label: 'Tokens per minute', limit: 30000, remaining: 3000, percent: 90, resetsAt: NOW - 1, expired: true },
    ] } },
    providers: { openai: { today: { turns: 2, tokens: 5000, costUSD: 0.02 }, week: { turns: 9, tokens: 40000, costUSD: 0.2 } } },
    notes: { openai: 'No plan limits for an API key.' },
  }, { now: NOW, name: 'OpenAI' });
  check('popover: an API key shows its live per-minute limits, not an expired one', api.windows.length === 0 && api.rates.length === 1 && api.rates[0].label === 'Requests per minute' && api.rates[0].percentText === '20%' && api.rates[0].text === '400 of 500 left, resets ' + api.rates[0].text.slice(api.rates[0].text.indexOf('resets ') + 7), JSON.stringify(api.rates));
  check('popover: the rate-limit row says how long until it resets', /, in 12 s$/.test(api.rates[0].text) && api.updated === 'Updated 1 min ago' && api.note === '', JSON.stringify(api));
  const none = UP.view('gemini', { bars: {}, notes: { gemini: 'Plan limits are not available from Gemini.' } }, { now: NOW, name: 'Gemini' });
  check('popover: with no windows and no rate limits the reason is the note', none.windows.length === 0 && none.rates.length === 0 && none.note === 'Plan limits are not available from Gemini.' && none.counted.length === 0, JSON.stringify(none));
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
