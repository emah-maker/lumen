// Pure unit test for the tab sleep settings and decision (features/tab-sleep.js decideSleep, normalize, memoryLow, cleanHost).
const TS = require('../src/features/tab-sleep');

let failed = 0;
function check(label, ok, detail = '') {
  if (!ok) { failed++; console.error(`FAIL ${label} ${detail}`); } else console.log(`ok   ${label}`);
}

const MIN = 60e3;
const NOW = 10_000 * MIN;
const GB = 1024 ** 3;
const tab = (id, idleMin, extra = {}) => ({ id, lastActive: NOW - idleMin * MIN, host: `site${id}.com`, ...extra });
const ids = (r) => r.sleep.map((x) => x.id);
const decide = (tabs, settings = {}, memory = null, limits = {}) => TS.decideSleep({ tabs, settings, now: NOW, memory, limits });
const okMem = { totalBytes: 16 * GB, freeBytes: 8 * GB, lumenBytes: 1 * GB };
const lowMem = { totalBytes: 16 * GB, freeBytes: 1 * GB, lumenBytes: 1 * GB };

// ---- defaults equal the old behavior: 20 minutes idle; 2 minutes idle under memory pressure; no cap; pinned not exempt; unload
const d = TS.normalize({});
check('default mode is both', d.mode === 'both');
check('default idle time is 20 minutes', d.minutes === 20);
check('default way is unload', d.how === 'unload');
check('default low-memory threshold is 10% free', d.freePercent === 10);
check('default Lumen memory limit is off', d.lumenGb === 0);
check('default awake cap is none', d.maxAwake === 0);
check('default: pinned tabs are not exempt (as before)', d.keepPinned === false);
check('default: no never-sleep sites', d.never.length === 0);
check('old on/off switch off -> off', TS.normalize({ tabSleep: false }).mode === 'off');
check('old switch off beats a stored mode', TS.normalize({ tabSleep: false, tabSleepMode: 'idle' }).mode === 'off');
check('invalid values fall back to defaults', JSON.stringify(TS.normalize({ tabSleepMode: 'x', tabSleepMinutes: -3, tabSleepHow: 'y', tabSleepFreePercent: 7, tabSleepNever: 5 })) === JSON.stringify(d));

{
  const r = decide([tab(1, 19), tab(2, 21), tab(3, 3)], {}, okMem);
  check('defaults, memory fine: only the tab idle over 20 minutes sleeps', JSON.stringify(ids(r)) === '[2]' && r.sleep[0].why === 'idle', JSON.stringify(r.sleep));
  const l = decide([tab(1, 19), tab(2, 21), tab(3, 3), tab(4, 1)], {}, lowMem);
  check('defaults, memory low: tabs idle 2+ minutes sleep, oldest first', JSON.stringify(ids(l)) === '[2,1,3]', JSON.stringify(l.sleep));
  check('...with their reasons', l.sleep.map((x) => x.why).join() === 'idle,memory,memory');
  check('defaults: how is unload', r.how === 'unload');
}

// ---- modes
{
  const tabs = [tab(1, 30), tab(2, 5)];
  check('off: nothing sleeps', ids(decide(tabs, { tabSleepMode: 'off' }, lowMem)).length === 0);
  check('old switch off: nothing sleeps', ids(decide(tabs, { tabSleep: false }, lowMem)).length === 0);
  check('idle: ignores low memory', JSON.stringify(ids(decide(tabs, { tabSleepMode: 'idle' }, lowMem))) === '[1]');
  check('memory: with memory fine nothing sleeps, however idle', ids(decide([tab(1, 600)], { tabSleepMode: 'memory' }, okMem)).length === 0);
  check('memory: low memory sleeps tabs idle 2+ minutes', JSON.stringify(ids(decide(tabs, { tabSleepMode: 'memory' }, lowMem))) === '[1,2]');
  check('memory: low memory but a tab idle under 2 minutes stays', ids(decide([tab(1, 1)], { tabSleepMode: 'memory' }, lowMem)).length === 0);
  check('both: idle or low memory', JSON.stringify(ids(decide(tabs, { tabSleepMode: 'both' }, okMem))) === '[1]');
}

// ---- idle time
{
  const t = [tab(1, 4), tab(2, 6), tab(3, 16), tab(4, 61)];
  check('5 minutes', JSON.stringify(ids(decide(t, { tabSleepMode: 'idle', tabSleepMinutes: 5 }))) === '[4,3,2]');
  check('15 minutes', JSON.stringify(ids(decide(t, { tabSleepMode: 'idle', tabSleepMinutes: 15 }))) === '[4,3]');
  check('1 hour', JSON.stringify(ids(decide(t, { tabSleepMode: 'idle', tabSleepMinutes: 60 }))) === '[4]');
  check('custom minutes', JSON.stringify(ids(decide(t, { tabSleepMode: 'idle', tabSleepMinutes: 7 }))) === '[4,3]');
  check('exactly at the limit sleeps', JSON.stringify(ids(decide([tab(1, 20)], {}))) === '[1]');
  check('8 hours: nothing idle that long', ids(decide(t, { tabSleepMode: 'idle', tabSleepMinutes: 480 })).length === 0);
  check('Performance mode limit shortens it', JSON.stringify(ids(decide([tab(1, 6)], { tabSleepMode: 'idle' }, null, { sleepAfterMs: 5 * MIN }))) === '[1]');
  check('...but never lengthens it', ids(decide([tab(1, 6)], { tabSleepMode: 'idle', tabSleepMinutes: 5 }, null, { sleepAfterMs: 20 * MIN })).length === 1);
  check('cleanMinutes bounds', TS.cleanMinutes(0) === null && TS.cleanMinutes(10081) === null && TS.cleanMinutes('12.4') === 12 && TS.cleanMinutes(10080) === 10080 && TS.cleanMinutes('x') === null);
}

// ---- memory thresholds
{
  const s = TS.normalize({});
  check('free 9% is low at the 10% threshold', TS.memoryLow(s, { totalBytes: 100, freeBytes: 9 }));
  check('free 10% is not low', !TS.memoryLow(s, { totalBytes: 100, freeBytes: 10 }));
  const s20 = TS.normalize({ tabSleepFreePercent: 20 });
  check('free 15% is low at a 20% threshold', TS.memoryLow(s20, { totalBytes: 100, freeBytes: 15 }));
  check('free 15% is fine at 10%', !TS.memoryLow(s, { totalBytes: 100, freeBytes: 15 }));
  check('Lumen limit off: big use is fine', !TS.memoryLow(s, { ...okMem, lumenBytes: 50 * GB }));
  const g = TS.normalize({ tabSleepLumenGb: 4 });
  check('Lumen over 4 GB is low', TS.memoryLow(g, { ...okMem, lumenBytes: 4.5 * GB }));
  check('Lumen under 4 GB is not', !TS.memoryLow(g, { ...okMem, lumenBytes: 3.5 * GB }));
  check('OS pressure true is low whatever the numbers', TS.memoryLow(s, { pressure: true, totalBytes: 100, freeBytes: 90 }));
  check('OS pressure false stands in for the percentage', !TS.memoryLow(s, { pressure: false, totalBytes: 100, freeBytes: 1 }));
  check('no memory info: not low', !TS.memoryLow(s, null) && !TS.memoryLow(s, {}));
  check('Lumen limit sleeps tabs in memory mode', JSON.stringify(ids(decide([tab(1, 5)], { tabSleepMode: 'memory', tabSleepLumenGb: 2 }, { ...okMem, lumenBytes: 3 * GB }))) === '[1]');
}

// ---- exceptions
{
  const sleeps = (extra, settings = {}) => ids(decide([tab(1, 60, extra)], settings, okMem)).length === 1;
  check('a plain idle tab sleeps', sleeps({}));
  check('active tab never sleeps', !sleeps({ active: true }));
  check('audible tab never sleeps', !sleeps({ audible: true }));
  check('capturing tab never sleeps', !sleeps({ capturing: true }));
  check('AI-busy tab never sleeps', !sleeps({ aiBusy: true }));
  check('agent-used tab never sleeps', !sleeps({ agentUsing: true }));
  check('AI-locked tab never sleeps', !sleeps({ aiLock: true }));
  check('loading tab never sleeps', !sleeps({ loading: true }));
  check('fullscreen tab never sleeps', !sleeps({ fullscreen: true }));
  check('tab with DevTools open never sleeps', !sleeps({ devTools: true }));
  check('tab with open popups never sleeps', !sleeps({ openPopups: 1 }));
  check('closing tab never sleeps', !sleeps({ closing: true }));
  check('settings tab never sleeps', !sleeps({ settings: true }));
  check('internal page never sleeps', !sleeps({ webPage: false }));
  check('already sleeping tab is not chosen again', !sleeps({ sleeping: true }));
  check('dead tab is not chosen', !sleeps({ alive: false }));
  check('tab never active (no lastActive) is left alone', ids(decide([{ id: 1, host: 'a.com' }], {}, okMem)).length === 0);
  check('pinned tab sleeps by default (as before)', sleeps({ pinned: true }));
  check('pinned tab stays with the setting on', !sleeps({ pinned: true }, { tabSleepKeepPinned: true }));
  check('unpinned tab still sleeps with the setting on', sleeps({}, { tabSleepKeepPinned: true }));
  check('listed site stays awake', !sleeps({ host: 'mail.com' }, { tabSleepNever: ['mail.com'] }));
  check('listed site matches www and subdomains', !sleeps({ host: 'www.mail.com' }, { tabSleepNever: ['mail.com'] }) && !sleeps({ host: 'a.b.mail.com' }, { tabSleepNever: ['mail.com'] }));
  check('a look-alike host is not matched', sleeps({ host: 'notmail.com' }, { tabSleepNever: ['mail.com'] }));
  check('listed site is exempt in memory mode too', ids(decide([tab(1, 10, { host: 'mail.com' })], { tabSleepMode: 'memory', tabSleepNever: ['mail.com'] }, lowMem)).length === 0);
  check('exceptions hold under low memory', ids(decide([tab(1, 60, { audible: true }), tab(2, 60, { capturing: true }), tab(3, 60, { aiBusy: true })], {}, lowMem)).length === 0);
}

// ---- how
check('how: freeze comes through', decide([tab(1, 60)], { tabSleepHow: 'freeze' }, okMem).how === 'freeze');

// ---- the awake-tab cap (least recently used first)
{
  const bg = [tab(1, 10), tab(2, 5), tab(3, 8), tab(4, 2), tab(5, 7)];
  const r = decide(bg, { tabSleepMode: 'idle', tabSleepMaxAwake: 2 });
  check('cap 2 of 5 awake: candidates least recently used first, 3 needed', JSON.stringify(ids(r)) === '[1,3,5,2,4]' && r.capExcess === 3 && r.sleep.every((x) => x.why === 'cap'), JSON.stringify(r));
  check('cap not exceeded: none', ids(decide(bg, { tabSleepMaxAwake: 5, tabSleepMode: 'idle' })).length === 0);
  check('the active tab is not counted', ids(decide([...bg, tab(6, 0, { active: true })], { tabSleepMode: 'idle', tabSleepMaxAwake: 5 })).length === 0);
  check('sleeping tabs are not counted', ids(decide([...bg, tab(6, 50, { sleeping: true })], { tabSleepMode: 'idle', tabSleepMaxAwake: 5 })).length === 0);
  const recent = decide([tab(1, 0.5), tab(2, 0.2), tab(3, 0.1)], { tabSleepMode: 'idle', tabSleepMaxAwake: 2 });
  check('nothing used in the last minute is chosen for the cap', ids(recent).length === 0);
  const ex = decide([tab(1, 10, { pinned: true }), tab(2, 9), tab(3, 8)], { tabSleepMode: 'idle', tabSleepMaxAwake: 2, tabSleepKeepPinned: true });
  check('cap skips exempt tabs (but counts them awake)', JSON.stringify(ids(ex)) === '[2,3]' && ex.capExcess === 1, JSON.stringify(ex));
  const mixed = decide([tab(1, 30), tab(2, 5), tab(3, 4), tab(4, 3)], { tabSleepMode: 'idle', tabSleepMaxAwake: 2 });
  check('idle sleepers count toward the cap', JSON.stringify(ids(mixed)) === '[1,2,3,4]' && mixed.sleep[0].why === 'idle' && mixed.capExcess === 1, JSON.stringify(mixed));
  check('Performance mode cap applies when the setting is none', decide(bg, { tabSleepMode: 'idle' }, null, { maxLiveBackgroundTabs: 4 }).capExcess === 1);
  check('the lower of the two caps wins', decide(bg, { tabSleepMode: 'idle', tabSleepMaxAwake: 2 }, null, { maxLiveBackgroundTabs: 4 }).capExcess === 3);
  check('off: no cap either', ids(decide(bg, { tabSleepMode: 'off', tabSleepMaxAwake: 2 })).length === 0);
}

// ---- host lists
check('cleanHost from an address', TS.cleanHost('https://www.Example.com:8080/a?b#c') === 'example.com');
check('cleanHost from a bare host', TS.cleanHost(' Mail.Example.com ') === 'mail.example.com');
check('cleanHost rejects junk', TS.cleanHost('not a host') === '' && TS.cleanHost('') === '' && TS.cleanHost(null) === '');
check('cleanHosts dedupes and drops junk', JSON.stringify(TS.cleanHosts(['a.com', 'https://www.a.com/x', '??', 'b.org'])) === '["a.com","b.org"]');
check('cleanHosts rejects a non-list', TS.cleanHosts('a.com') === null);

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('tab-sleep settings units OK');
