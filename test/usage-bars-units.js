// The small usage bars' shared formatter (renderer/usage-bars.js: percent, level, reset text, missing data -> nothing), the AI status
// card's bar data, the cached usage summary (no CLI run) and Auto's "skipped: out of usage" note. Pure node: no window, no network.
const UB = require('../src/renderer/usage-bars');
const AS = require('../src/features/aistatus-view');
const usageLib = require('../src/features/usage');
const fallback = require('../src/ai/fallback');
const autoModel = require('../src/ai/auto-model');

module.exports = async function usageBarsUnits(check) {
  const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();
  const H = 3600e3;
  const plan = (percent, extra = {}) => ({ engine: 'claudecode', kind: 'plan', percent, resetsAt: NOW + 2 * H, resetsText: null, weekly: null, ...extra });

  // ---- levels (the sidebar meter's: amber from 80, red at 100)
  check('usage bars: levels ok / warn from 80 / high at 100', UB.levelOf(0) === 'ok' && UB.levelOf(79.9) === 'ok' && UB.levelOf(80) === 'warn' && UB.levelOf(99) === 'warn' && UB.levelOf(100) === 'high');

  // ---- percent, level, reset text
  const d = UB.describe(plan(42.4), { now: NOW });
  check('usage bars: a plan window gives its percent, level and a reset time', d && d.text === '42%' && d.level === 'ok' && !d.out && d.percent === 42.4 && /resets \d{1,2}:\d{2}/.test(d.title), JSON.stringify(d));
  const warn = UB.describe(plan(86), { now: NOW });
  check('usage bars: 86% is a warning, still not "out"', warn.level === 'warn' && !warn.out && warn.text === '86%');
  const full = UB.describe(plan(100), { now: NOW });
  check('usage bars: 100% reads as out of usage: "out", high, and the reset time in the title', full.out && full.level === 'high' && full.text === 'out' && /Out of usage, resets/.test(full.title), JSON.stringify(full));
  check('usage bars: the percent is clamped to 0-100', UB.describe(plan(180), { now: NOW }).percent === 100 && UB.describe(plan(-5), { now: NOW }).percent === 0);

  // ---- the tightest window wins, every window is in the tooltip
  const two = UB.describe(plan(30, { weekly: { percent: 91, resetsText: 'Mon 12:00 AM' } }), { now: NOW });
  check('usage bars: the bar shows the tightest of the 5-hour and weekly windows, the title lists both', two.percent === 91 && two.level === 'warn' && two.windows.length === 2 && /5-hour limit: 30% used/.test(two.title) && /weekly limit: 91% used, resets Mon 12:00 AM/.test(two.title), two.title);
  check('usage bars: a progressbar value text says what and how much', /91% used/.test(two.valuetext) && two.valuetext.includes('weekly'));

  // ---- reset text
  check('usage bars: reset text from a time, from the CLI words, and none when unknown', /^resets \d/.test(UB.resetText({ resetsAt: NOW + H }, NOW)) && UB.resetText({ resetsText: 'Mon 12:00 AM' }, NOW) === 'resets Mon 12:00 AM' && UB.resetText({}, NOW) === '' && UB.resetText({ resetsAt: NOW - 1 }, NOW) === '');
  check('usage bars: a reset on another day names the weekday', /^resets [A-Z][a-z]{2}\b/.test(UB.resetText({ resetsAt: NOW + 30 * H }, NOW)), UB.resetText({ resetsAt: NOW + 30 * H }, NOW));

  // ---- missing data: nothing (never a made-up bar)
  check('usage bars: no bar, an empty bar and a context-only bar give nothing', UB.describe(null, { now: NOW }) === null && UB.describe({}, { now: NOW }) === null && UB.describe({ engine: 'grokbuild', kind: 'context', percent: 61 }, { now: NOW }) === null && UB.describe(plan(NaN), { now: NOW }) === null);
  check('usage bars: a window that reset since the reading is stale, so it shows nothing', UB.describe(plan(70, { resetsAt: NOW - 1000 }), { now: NOW }) === null);
  const state = { showBars: true, bars: { claudecode: plan(55), codex: { engine: 'codex', kind: 'plan', percent: 20, resetsAt: NOW + H, weekly: null }, grokbuild: { engine: 'grokbuild', kind: 'context', percent: 40 } }, cooling: {} };
  check('usage bars: a provider with no usage data (an API key, Antigravity, Grok without a budget) has no bar', ['anthropic:claude-opus-5', 'openai:gpt-5', 'antigravity:default', 'grokbuild:default', 'xai:grok-4', 'auto', 'claudecode:__more'].every((id) => UB.forModel(id, state, NOW) === null), '');
  check('usage bars: models of an engine with a plan window get its bar, a provider heading too', UB.forModel('claudecode:sonnet', state, NOW).text === '55%' && UB.forProvider('codex', state, NOW).text === '20%' && UB.forModel('claudecode:auto', state, NOW).text === '55%');
  check('usage bars: the setting off hides every bar', UB.forModel('claudecode:sonnet', { ...state, showBars: false }, NOW) === null && UB.forProvider('claudecode', { ...state, showBars: false }, NOW) === null);
  check('usage bars: no state yet (nothing loaded) is no bar', UB.forModel('claudecode:sonnet', null, NOW) === null);

  // ---- Grok: a budget is a real bar, Grok's own limit message is "out"
  const budget = UB.describe({ engine: 'grokbuild', kind: 'budget', percent: 83, period: 'daily', resetsAt: NOW + H }, { now: NOW });
  check('usage bars: Grok shows only a budget the user set (warn from 80), labelled as a budget', budget.level === 'warn' && /daily budget: 83% used/.test(budget.title), budget && budget.title);
  const lim = UB.describe({ engine: 'grokbuild', kind: 'limit', percent: 100, resetsAt: NOW + 3 * H }, { now: NOW });
  check('usage bars: a limit-reached message is out, with the reset time', lim.out && /Out of usage, resets/.test(lim.title));

  // ---- cooldowns: a model that hit a limit is marked out even with no plan reading
  const cooled = { claudecode: { until: NOW + H, kind: 'limit', scope: 'provider', exact: true } };
  const s2 = { showBars: true, bars: {}, cooling: cooled };
  const o = UB.forModel('claudecode:haiku', s2, NOW);
  check('usage bars: a provider cooling down after a usage limit is out, with its resume time', o && o.out && o.text === 'out' && /resets/.test(o.title), JSON.stringify(o));
  check('usage bars: an outage (unreachable) is not "out of usage"', UB.forModel('claudecode:haiku', { ...s2, cooling: { claudecode: { until: NOW + H, kind: 'unreachable', scope: 'provider' } } }, NOW) === null);
  const opus = { showBars: true, bars: { claudecode: plan(10) }, cooling: { claudecode: { until: NOW + H, kind: 'limit', scope: 'model', model: 'opus' } } };
  check('usage bars: a model-only limit marks that model, not the others', UB.forModel('claudecode:opus', opus, NOW).out && !UB.forModel('claudecode:sonnet', opus, NOW).out);
  check('usage bars: an expired cooldown marks nothing', UB.forModel('claudecode:haiku', { showBars: true, bars: {}, cooling: { claudecode: { until: NOW - 1, kind: 'limit', scope: 'provider' } } }, NOW) === null);

  // ---- native <option> text
  check('usage bars: a native option gets "55% used", "out of usage", or its own text when there is nothing', UB.annotate('Claude Code · Sonnet', 'claudecode:sonnet', state, NOW) === 'Claude Code · Sonnet · 55% used' && /out of usage$/.test(UB.annotate('X', 'claudecode:haiku', s2, NOW)) && UB.annotate('GPT', 'openai:gpt-5', state, NOW) === 'GPT');

  // ---- the cached summary: no `claude /usage` run, no Codex scan; carries the setting and the cooldowns
  let ran = 0;
  const usage = usageLib.createUsage({ app: { getPath: () => require('os').tmpdir(), on() {} }, claudeBin: async () => { ran++; return null; }, now: () => NOW, codexScan: async () => { ran++; return null; }, showBars: () => false, cooling: () => cooled, otherActivity: async () => false });
  const cached = await usage.summary({ cached: true });
  check('usage summary (cached): reads memory only: no CLI run, no Codex scan', ran === 0, String(ran));
  check('usage summary: carries showBars and the cooldowns for the bars', cached.showBars === false && cached.cooling.claudecode.kind === 'limit' && cached.bars && 'claudecode' in cached.bars);
  usage.record('claudecode', { usage: { inputTokens: 1, outputTokens: 1, costUSD: 0.01 }, rateLimit: { unifiedWindows: { five_hour: { utilization: 0.37, resetsAt: Math.floor((NOW + 2 * H) / 1000) } } } });
  const after = await usage.summary({ cached: true });
  check('usage summary (cached): a turn rate_limit reading becomes the claudecode bar', after.bars.claudecode && Math.round(after.bars.claudecode.percent) === 37 && ran === 0, JSON.stringify(after.bars.claudecode));
  usage.shutdown();

  // ---- the AI status card's bar data
  const eng = { claudecode: { installed: true, signedIn: true } };
  const c1 = AS.shape({ engines: eng, meter: { percent: 61.4, resetsAt: NOW + H } }, NOW).ais.find((a) => a.id === 'claudecode');
  check('ai status: a 5-hour reading gives the card a bar (percent, level)', c1.usage && c1.usage.percent === 61 && c1.usage.level === 'ok');
  const c2 = AS.shape({ engines: eng, meter: { percent: 91, resetsAt: NOW + H } }, NOW).ais.find((a) => a.id === 'claudecode');
  check('ai status: the bar turns warn at 80+', c2.usage.level === 'warn');
  const c3 = AS.shape({ engines: eng, cooling: { claudecode: { until: NOW + H, kind: 'limit', exact: true, scope: 'provider' } } }, NOW).ais.find((a) => a.id === 'claudecode');
  check('ai status: a limit reached is a full, high bar', c3.usage && c3.usage.percent === 100 && c3.usage.level === 'high');
  const c4 = AS.shape({ engines: eng }, NOW).ais.find((a) => a.id === 'claudecode');
  check('ai status: no reading, no bar', !('usage' in c4));
  const c5 = AS.shape({ engines: eng, meter: { percent: 50, resetsAt: NOW + H }, showBars: false }, NOW).ais.find((a) => a.id === 'claudecode');
  check('ai status: the setting off drops the bar data', !('usage' in c5));

  // ---- Auto: a provider left out because it hit a usage limit is named in the reason
  const options = [{ id: 'claudecode:sonnet', group: 'Your Claude account', label: 'Sonnet' }, { id: 'openai:gpt-5-mini', group: 'OpenAI', label: 'GPT-5 mini' }];
  const cd = fallback.createCooldowns();
  const none = autoModel.route({ options, request: { kind: 'chat', prompt: 'hello' }, cooldowns: cd, at: NOW });
  check('auto: nothing skipped, no note', none.id && !/skipped/.test(none.reason), none.reason);
  cd.mark('claudecode:sonnet', { kind: 'limit', scope: 'provider', resetsAt: NOW + H, exact: true }, NOW);
  const skip = autoModel.route({ options, request: { kind: 'chat', prompt: 'hello' }, cooldowns: cd, at: NOW + 1000 });
  check('auto: a provider out of usage is named as skipped, and another answers', skip.id === 'openai:gpt-5-mini' && /\(Claude Code skipped: out of usage\)$/.test(skip.reason), skip.reason);
  const cd2 = fallback.createCooldowns();
  cd2.mark('claudecode:sonnet', { kind: 'unreachable', scope: 'provider', resetsAt: NOW + H }, NOW);
  const down = autoModel.route({ options, request: { kind: 'chat', prompt: 'hello' }, cooldowns: cd2, at: NOW + 1000 });
  check('auto: an outage is not called "out of usage"', down.id === 'openai:gpt-5-mini' && !/skipped/.test(down.reason), down.reason);
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
