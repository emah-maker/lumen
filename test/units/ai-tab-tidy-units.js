// Lumen tidies the AI's tabs itself (features/ai-tab-tidy.js), plain Node: no Electron.
// A finished run's leftovers close; the tabs its answer links to are kept, sleep, then close after the grace period; a chat keeps
// about 8. Never touched: the user's tabs (clicked, typed, pinned, moved), the tab in front, one playing sound, the tab a chat lives
// in, one a run works in.
const T = require('../../src/features/ai-tab-tidy');
const M = require('../../src/features/ai-manners');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const ids = (list) => list.map((t) => t.id).join(',');
const MIN = 60 * 1000;
const NOW = 100 * 60 * MIN;
const mk = (id, extra = {}, by = { chatId: 'c1', runId: 7 }, at = NOW - 30 * MIN) => M.markOpened({ id, url: `https://example.com/p${id}`, ...extra }, by, at);

// ---- addresses
{
  check('url: #fragment and trailing slash are the same page', T.urlKey('https://a.com/x/#top') === T.urlKey('https://a.com/x'));
  check('url: query strings differ', T.urlKey('https://a.com/x?q=1') !== T.urlKey('https://a.com/x?q=2'));
  check('url: non-web addresses never match', T.urlKey('lumen://settings') === '' && T.urlKey('file:///C:/a.pdf') === '' && T.urlKey('') === '' && T.urlKey(null) === '');
}

// ---- linked results
{
  const tabs = [mk(1), mk(2), mk(3), mk(4, { url: 'https://docs.site.org/guide' })];
  check('linked: a [[tab:ID]] chip names the tab', ids(tabs.filter((t) => T.linkedIds(tabs, 'See [[tab:2]].').includes(t.id))) === '2');
  check('linked: a link to the tab\'s page names it (trailing punctuation ignored)', T.linkedIds(tabs, 'The guide is at https://docs.site.org/guide.').join() === '4');
  check('linked: a markdown link names it', T.linkedIds(tabs, 'Read [the guide](https://docs.site.org/guide/#install)').join() === '4');
  check('linked: a reply naming nothing keeps nothing', T.linkedIds(tabs, 'Done: added 3 tasks.').length === 0 && T.linkedIds(tabs, '').length === 0);
  check('linked: urlOf gives a sleeping tab\'s address', T.linkedIds([{ id: 9, openedBy: {} }], 'https://z.io/a', () => 'https://z.io/a').join() === '9');
}

// ---- the sweep
{
  const live = [mk(1, {}, { chatId: 'c1', runId: 8 })];
  const plan = (tabs, extra = {}) => T.sweepPlan(tabs, { now: NOW, liveRunIds: [8], grace: 60 * MIN, ...extra });
  check('sweep: a live run\'s tabs wait for its own close', ids(plan(live).close) === '' && ids(plan(live).sleep) === '');
  check('sweep: a finished run\'s leftover closes', ids(plan([mk(2)]).close) === '2');
  check('sweep: a leftover from a minute ago waits (a helper\'s late step, a follow-up)', ids(plan([mk(3, {}, undefined, NOW - MIN)]).close) === '');
  check('sweep: a restored tab (no run id) is a leftover too', ids(plan([mk(4, {}, { chatId: 'c1', runId: null })]).close) === '4');
  check('sweep: an automation client\'s tab (no chat, no run) is its session\'s to close', ids(plan([mk(4, {}, { chatId: null, runId: null })]).close) === '');
  const kept = (id, at) => { const t = mk(id, {}, undefined, at); M.keepAfterRun(t); return t; };
  check('sweep: a kept tab used 5 min ago stays awake', ids(plan([kept(5, NOW - 5 * MIN)]).close) === '' && ids(plan([kept(5, NOW - 5 * MIN)]).sleep) === '');
  check('sweep: a kept tab idle 20 min sleeps', ids(plan([kept(6, NOW - 20 * MIN)]).sleep) === '6' && ids(plan([kept(6, NOW - 20 * MIN)]).close) === '');
  check('sweep: one already asleep is not put to sleep again', ids(plan([kept(7, NOW - 20 * MIN)], { asleep: () => true }).sleep) === '');
  check('sweep: a kept tab past the grace period closes', ids(plan([kept(8, NOW - 61 * MIN)]).close) === '8');
  check('sweep: grace 4h keeps it longer', ids(plan([kept(8, NOW - 61 * MIN)], { grace: T.graceMs('4h') }).close) === '');
  const used = kept(9, NOW - 90 * MIN);
  used.openedBy.usedAt = NOW - 2 * MIN;
  check('sweep: a run working in it again restarts its clock', ids(plan([used]).close) === '' && ids(plan([used]).sleep) === '');
  const never = [mk(10, { pinned: true }), mk(11, { userMoved: true }), mk(12, { closing: true }), mk(13), mk(14), mk(15), mk(16), { id: 17 }];
  const facts = { activeId: 13, audibleIds: [14], boundIds: [15], busyIds: [16] };
  check('sweep: never pinned, moved by hand, closing, in front, playing sound, a chat\'s own tab, a working tab, the user\'s own', ids(plan(never, facts).close) === '' && ids(plan(never, facts).sleep) === '', ids(plan(never, facts).close));
  const mine = mk(18);
  M.handOver(mine); // the user clicked or typed in it
  check('sweep: a tab the user took over is theirs', ids(plan([mine]).close) === '');
}

// ---- about 8 per chat
{
  const tabs = Array.from({ length: 8 }, (_, i) => mk(i + 1, {}, { chatId: 'c1', runId: 7 }, NOW - (20 - i) * MIN));
  check('cap: 7 tabs leave room', T.capPlan(tabs.slice(0, 7), { chatId: 'c1' }).length === 0);
  check('cap: the 9th tab closes the oldest one first', ids(T.capPlan(tabs, { chatId: 'c1' })) === '1');
  check('cap: other chats\' tabs do not count', T.capPlan([...tabs.slice(0, 7), mk(20, {}, { chatId: 'c2', runId: 9 })], { chatId: 'c1' }).length === 0);
  check('cap: never the one a run works in or the one in front (the next oldest goes)', ids(T.capPlan(tabs, { chatId: 'c1', busyIds: [1], activeId: 2 })) === '3');
  const withKept = tabs.map((t) => ({ ...t, openedBy: { ...t.openedBy } }));
  M.keepAfterRun(withKept[0]);
  check('cap: a result tab goes after the plain ones', ids(T.capPlan(withKept, { chatId: 'c1' })) === '2');
  check('cap: no chat, no cap', T.capPlan(tabs, { chatId: null }).length === 0);
  check('cap: a smaller cap closes as many as needed', ids(T.capPlan(tabs, { chatId: 'c1', cap: 6 })) === '1,2,3');
}

// ---- the setting
{
  check('grace: 15m / 1h / 4h, anything else is 1h', T.graceMs('15m') === 15 * MIN && T.graceMs('4h') === 240 * MIN && T.graceMs('nope') === 60 * MIN && T.graceMs(undefined) === 60 * MIN);
  check('grace: the choices match settings-backend', T.GRACE_CHOICES.join() === '15m,1h,4h');
  const backend = require('../../src/settings/settings-backend');
  check('setting: on by default, 1h grace', backend.DEFAULTS?.aiTabsTidy === true && backend.DEFAULTS?.aiTabsGrace === '1h', JSON.stringify([backend.DEFAULTS?.aiTabsTidy, backend.DEFAULTS?.aiTabsGrace]));
}

// ---- the prompt asks nothing of the model
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '../../src/ai/agent.js'), 'utf8');
  const def = src.match(/name: 'close_tab',\s*description: '([^']*)'/);
  check('prompt: close_tab stays one short line (Lumen closes the AI\'s tabs; the model is never asked to)', Boolean(def) && def[1].length <= 12, def && def[1]);
  const system = src.match(/const SYSTEM = `([\s\S]*?)`;/);
  check('prompt: the system prompt never tells the model to close tabs', Boolean(system) && !/close[^.\n]{0,30}tabs?/i.test(system[1]));
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
