// Routines' pure part (features/routines.js and the routine bits of features/background-agents.js), no
// Electron: next-run math in local time (daylight saving, weekdays, weekly, every N hours, cron), the
// scheduler's plan (catch-up once, never two copies, offline, one wake time), the concurrency cap, the
// run history cap, the "every weekday at 8am" parser and a routine's life as a stored task.
// Run in New York time so the daylight-saving dates below are real ones (8 March and 1 November 2026).
process.env.TZ = 'America/New_York';
const R = require('../src/features/routines');
const bg = require('../src/features/background-agents');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const show = (ms) => (ms === null ? 'null' : new Date(ms).toString());
const sched = (s) => R.normalizeRoutineSchedule({ type: 'routine', ...s }, at(2026, 1, 1));
const H = 3600000;
const throwsKey = (fn, key) => { try { fn(); return false; } catch (err) { return err.key === `routines.error.${key}`; } };

check('the test runs in New York time', new Date(at(2026, 7, 1)).getTimezoneOffset() === 240 && new Date(at(2026, 1, 1)).getTimezoneOffset() === 300);

// ---- daily, and daylight saving
const daily8 = sched({ repeat: 'daily', time: '8:00' });
check('a daily time is kept as HH:MM, every day of the week', daily8.time === '08:00' && daily8.days.length === 7);
let n = R.nextOccurrence(daily8, at(2026, 3, 7, 9));
check('daily 8:00: the next run after Saturday 9:00 is Sunday 8:00, the day clocks spring forward', n === at(2026, 3, 8, 8) && new Date(n).getHours() === 8, show(n));
check('…which is 23 real hours after Saturday 8:00', n - at(2026, 3, 7, 8) === 23 * H);
n = R.nextOccurrence(daily8, at(2026, 10, 31, 9));
check('daily 8:00 on the day clocks fall back: still 8:00, 25 real hours later', new Date(n).getHours() === 8 && new Date(n).getDate() === 1 && n - at(2026, 10, 31, 8) === 25 * H, show(n));
const gap = sched({ repeat: 'daily', time: '02:30' });
n = R.nextOccurrence(gap, at(2026, 3, 8, 0));
check('2:30 on the spring-forward day (a time that does not exist) runs once, when the clocks reach 3:30', new Date(n).getDate() === 8 && new Date(n).getHours() === 3 && new Date(n).getMinutes() === 30, show(n));
const n2 = R.nextOccurrence(gap, n);
check('…and the next day at 2:30 again', new Date(n2).getDate() === 9 && new Date(n2).getHours() === 2 && new Date(n2).getMinutes() === 30, show(n2));
const twice = sched({ repeat: 'daily', time: '01:30' });
n = R.nextOccurrence(twice, at(2026, 11, 1, 0));
const after = R.nextOccurrence(twice, n);
check('1:30 on the fall-back day (it happens twice) runs once; the next run is the next day', new Date(n).getDate() === 1 && new Date(after).getDate() === 2 && new Date(after).getHours() === 1, `${show(n)} / ${show(after)}`);

// ---- weekdays, weekly
const wd = sched({ repeat: 'weekdays', time: '08:00' });
check('weekdays: Friday 9:00 -> Monday 8:00', R.nextOccurrence(wd, at(2026, 10, 2, 9)) === at(2026, 10, 5, 8), show(R.nextOccurrence(wd, at(2026, 10, 2, 9))));
check('weekdays: Saturday -> Monday', R.nextOccurrence(wd, at(2026, 10, 3, 12)) === at(2026, 10, 5, 8));
check('weekdays: Tuesday 7:59 -> Tuesday 8:00', R.nextOccurrence(wd, at(2026, 10, 6, 7, 59)) === at(2026, 10, 6, 8));
check('weekdays: exactly at 8:00 -> the next day (strictly after)', R.nextOccurrence(wd, at(2026, 10, 6, 8)) === at(2026, 10, 7, 8));
const wk = sched({ repeat: 'weekly', days: [4, 1, 1], time: '09:15' });
check('weekly: days are deduplicated and sorted', JSON.stringify(wk.days) === '[1,4]');
check('weekly Mon+Thu 9:15: Tuesday -> Thursday, Thursday 10:00 -> Monday', R.nextOccurrence(wk, at(2026, 10, 6, 12)) === at(2026, 10, 8, 9, 15) && R.nextOccurrence(wk, at(2026, 10, 8, 10)) === at(2026, 10, 12, 9, 15));
check('weekly with no day is refused', throwsKey(() => sched({ repeat: 'weekly', days: [] }), 'days'));
check('a bad time falls back to 08:00', sched({ repeat: 'daily', time: '25:99' }).time === '08:00');
check('the upcoming list: three weekday runs from Friday evening', JSON.stringify(R.upcoming(wd, at(2026, 10, 2, 20), 3)) === JSON.stringify([at(2026, 10, 5, 8), at(2026, 10, 6, 8), at(2026, 10, 7, 8)]));

// ---- every N hours (real hours: daylight saving doesn't stretch them)
const every3 = R.normalizeRoutineSchedule({ repeat: 'hours', hours: 3 }, at(2026, 3, 7, 22));
check('every 3 hours keeps the time it was saved as its anchor', every3.anchor === at(2026, 3, 7, 22));
check('every 3 hours: the first run is 3 hours after saving, and across the clock change still 3 real hours', R.nextOccurrence(every3, every3.anchor) === every3.anchor + 3 * H && R.nextOccurrence(every3, every3.anchor + 3 * H) === every3.anchor + 6 * H);
check('every 3 hours, after a long gap: the next slot on the grid, not a backlog', R.nextOccurrence(every3, every3.anchor + 10 * H) === every3.anchor + 12 * H);
check('every 0 or 25 hours is refused', throwsKey(() => sched({ repeat: 'hours', hours: 0 }), 'hours') && throwsKey(() => sched({ repeat: 'hours', hours: 25 }), 'hours'));

// ---- cron
const c1 = sched({ repeat: 'cron', cron: '30 9 * * 1-5' });
check('cron "30 9 * * 1-5": Friday 10:00 -> Monday 9:30', R.nextOccurrence(c1, at(2026, 10, 2, 10)) === at(2026, 10, 5, 9, 30));
check('cron "0 */6 * * *": every six hours on the clock', JSON.stringify(R.upcoming(sched({ repeat: 'cron', cron: '0 */6 * * *' }), at(2026, 10, 1, 1), 3)) === JSON.stringify([at(2026, 10, 1, 6), at(2026, 10, 1, 12), at(2026, 10, 1, 18)]));
check('cron "0 9 1 * *": the first of next month', R.nextOccurrence(sched({ repeat: 'cron', cron: '0 9 1 * *' }), at(2026, 10, 1, 10)) === at(2026, 11, 1, 9));
check('cron "0 0 29 2 *": the next 29 February (2028)', R.nextOccurrence(sched({ repeat: 'cron', cron: '0 0 29 2 *' }), at(2026, 10, 1)) === at(2028, 2, 29));
check('cron day-of-month and weekday together match either (classic cron): "0 8 13 * 5"', R.nextOccurrence(sched({ repeat: 'cron', cron: '0 8 13 * 5' }), at(2026, 10, 3)) === at(2026, 10, 9, 8));
check('cron weekday 7 is Sunday', R.nextOccurrence(sched({ repeat: 'cron', cron: '0 8 * * 7' }), at(2026, 10, 1)) === at(2026, 10, 4, 8));
check('a cron with four fields is refused (with its locale key)', throwsKey(() => sched({ repeat: 'cron', cron: '0 8 * *' }), 'cronFields'));
check('a cron value out of range is refused', throwsKey(() => sched({ repeat: 'cron', cron: '61 8 * * *' }), 'cronRange'));
check('a cron word is refused', throwsKey(() => sched({ repeat: 'cron', cron: '0 8 * * MON' }), 'cronValue'));
check('a cron schedule more often than every 5 minutes cannot be saved', throwsKey(() => R.validateNew(sched({ repeat: 'cron', cron: '* * * * *' }), at(2026, 10, 1)), 'often'));
check('…every 5 minutes can', R.validateNew(sched({ repeat: 'cron', cron: '*/5 * * * *' }), at(2026, 10, 1)).cron === '*/5 * * * *');

// ---- once
const once = sched({ repeat: 'once', at: at(2026, 10, 2, 7) });
check('once: runs at its time, then never', R.nextOccurrence(once, at(2026, 10, 1)) === at(2026, 10, 2, 7) && R.nextOccurrence(once, at(2026, 10, 2, 7)) === null);
check('once in the past cannot be saved; in the future it can', throwsKey(() => R.validateNew(once, at(2026, 10, 3)), 'past') && R.validateNew(once, at(2026, 10, 1)) === once);
check('an unknown repeat is refused', throwsKey(() => sched({ repeat: 'sometimes' }), 'repeat'));

// ---- a routine as a task
const t0 = at(2026, 10, 1, 12);
const mk = (s, extra = {}) => bg.makeTask({ prompt: 'ROUTINE brief', model: 'claude-opus-5', schedule: { type: 'routine', ...s }, now: t0, ...extra });
const task = mk({ repeat: 'weekdays', time: '08:00' }, { startUrl: 'news.example.com/today', allowedSites: [] });
check('a new routine waits as "scheduled" (it does not run on creation)', task.status === 'scheduled' && bg.planStarts([task], 2, t0).length === 0, task.status);
check('its first run is the next calendar time, not now', bg.nextRunAt(task) === at(2026, 10, 2, 8), show(bg.nextRunAt(task)));
check('its start page is kept (as https) and its site is allowed', task.routine.startUrl === 'https://news.example.com/today' && task.allowedSites.includes('news.example.com') && task.allowedSites.includes('www.news.example.com'), JSON.stringify([task.routine, task.allowedSites]));
check('the model is told where to start', /Start at: https:\/\/news\.example\.com\/today/.test(bg.taskPrompt(task, 'run')));
check('a start page that is not a web address is refused', (() => { try { mk({ repeat: 'daily' }, { startUrl: 'javascript:alert(1)' }); return false; } catch { return true; } })());
check('a routine counts as repeating: the store never drops it to make room', bg.isRecurring(task.schedule) && bg.capTasks([task], 0).length === 1);
const stored = bg.sanitizeTask(JSON.parse(JSON.stringify(task)));
check('a stored routine comes back whole (schedule, start page, history)', stored && stored.schedule.repeat === 'weekdays' && stored.routine.startUrl === task.routine.startUrl && Array.isArray(stored.routine.history) && stored.status === 'scheduled');
check('a damaged routine schedule makes the task unusable, not a crash', bg.sanitizeTask({ ...JSON.parse(JSON.stringify(task)), schedule: { type: 'routine', repeat: 'weekly', days: [] } }) === null);
check('garbage in the routine state is cleaned', JSON.stringify(R.sanitizeRoutine({ startUrl: 'file:///etc/passwd', lastDue: 'x', history: [{ status: 'evil', result: 5 }] })) === JSON.stringify({ startUrl: '', lastDue: null, trigger: null, scheduledFor: null, history: [{ startedAt: 0, endedAt: 0, scheduledFor: null, trigger: 'schedule', status: 'done', result: '5', error: '' }] }));
const paused = { ...task, enabled: false };
check('a disabled routine is never due', bg.nextRunAt(paused) === null && R.dueAt(paused) === null);
const running = { ...task, status: 'running', lastRun: t0, routine: { ...task.routine, trigger: 'schedule', scheduledFor: t0 } };
const recovered = bg.recoverAfterRestart(running, t0 + 60000);
check('a routine cut off by quitting is interrupted, with a history entry', recovered.status === 'interrupted' && recovered.routine.history.length === 1 && recovered.routine.history[0].status === 'interrupted' && recovered.routine.trigger === null);

// ---- the scheduler's plan
const isActive = (x) => bg.ACTIVE.has(x.status);
const due8 = at(2026, 10, 2, 8);
let p = R.plan([task], due8 - 1000, { isActive });
check('before its time: nothing queued, the timer wakes at 8:00', p.queue.length === 0 && p.wakeAt === due8, JSON.stringify(p));
check('the timer sleeps until then, but never more than an hour', R.sleepFor(p.wakeAt, due8 - 1000) === 1000 && R.sleepFor(due8 + 5 * H, due8) === H && R.sleepFor(null, due8) === null);
p = R.plan([task], due8 + 1000, { isActive });
check('at its time: queued as a scheduled run', p.queue.length === 1 && p.queue[0].trigger === 'schedule' && p.queue[0].dueAt === due8, JSON.stringify(p));
p = R.plan([task], due8 + 3 * 24 * H, { isActive });
check('three days late (Lumen was closed): queued once, as a catch-up', p.queue.length === 1 && p.queue[0].trigger === 'catch-up', JSON.stringify(p));
p = R.plan([{ ...task, status: 'running' }], due8 + 1000, { isActive });
check('still running from before: the time is skipped, not run twice', p.queue.length === 0 && p.skip.length === 1, JSON.stringify(p));
p = R.plan([{ ...task, status: 'queued' }], due8 + 1000, { isActive });
check('queued and waiting for a slot: also skipped (no second copy)', p.queue.length === 0 && p.skip.length === 1);
p = R.plan([task], due8 + 1000, { isActive, online: false });
check('offline: nothing starts, and the scheduler looks again in a minute', p.queue.length === 0 && p.offline.length === 1 && p.wakeAt === due8 + 1000 + R.OFFLINE_RETRY_MS, JSON.stringify(p));
p = R.plan([task], due8 + 1000, { isActive, enabled: false });
check('background tasks turned off: no routine runs and no timer', p.queue.length === 0 && p.wakeAt === null);
const later = mk({ repeat: 'daily', time: '23:00' });
check('one wake time for all routines: the earliest', R.plan([later, task], t0, { isActive }).wakeAt === at(2026, 10, 1, 23));
check('no routines: no timer at all', R.plan([bg.makeTask({ prompt: 'x', model: 'm', schedule: { type: 'every', minutes: 5 }, now: t0 })], t0, { isActive }).wakeAt === null);

// A week of simulated time, driven the way the runner drives it: the scheduler wakes at plan.wakeAt (or
// at the hour cap), a queued run starts at once and takes 10 minutes. Lumen is closed from Monday
// morning to Thursday noon. Every weekday gets one run, the closed days collapse into one catch-up.
{
  const r = mk({ repeat: 'weekdays', time: '08:00' });
  const runs = [];
  let clock = at(2026, 10, 2, 12); // Friday noon, when it is made
  r.createdAt = clock;
  const end = at(2026, 10, 10, 12); // the next Saturday noon
  const closedFrom = at(2026, 10, 5, 7);
  const closedTo = at(2026, 10, 8, 12);
  while (clock < end) {
    if (clock >= closedFrom && clock < closedTo) { clock = closedTo; continue; }
    const pl = R.plan([r], clock, { isActive });
    for (const q of pl.queue) {
      r.routine.lastDue = clock;
      runs.push({ at: clock, trigger: q.trigger });
      r.status = 'running';
      r.status = 'done'; // the 10-minute run is simulated as finished before the next wake
      r.lastRun = clock;
    }
    clock += R.sleepFor(pl.wakeAt, clock) ?? R.MAX_SLEEP_MS;
    if (pl.queue.length) clock = Math.max(clock, runs[runs.length - 1].at + 10 * 60000);
  }
  const days = runs.map((x) => `${new Date(x.at).getDate()}:${x.trigger}`);
  check('a simulated week: one run per weekday, the missed Mon-Thu runs as a single catch-up', JSON.stringify(days) === JSON.stringify(['8:catch-up', '9:schedule']), JSON.stringify(days));
}

// The concurrency cap: three routines due at once, two slots, two start; the third waits queued.
{
  const rs = [1, 2, 3].map(() => mk({ repeat: 'daily', time: '08:00' }));
  const pl = R.plan(rs, due8 + 1000, { isActive });
  for (const q of pl.queue) { const x = rs.find((y) => y.id === q.id); x.status = 'queued'; x.queuedAt = due8 + 1000; }
  check('three due routines are all queued, but only two start with two slots', pl.queue.length === 3 && bg.planStarts(rs, 2, due8 + 1000).length === 2);
}

// ---- history
{
  let h = [];
  for (let i = 0; i < 30; i++) h = R.addHistory(h, { startedAt: i, endedAt: i + 1, status: 'done', result: 'x'.repeat(10000) });
  check(`history keeps the newest ${R.LIMITS.history} runs, each result clipped`, h.length === R.LIMITS.history && h[0].startedAt === 10 && h[h.length - 1].result.length === R.LIMITS.historyResult);
  check('a skipped time is recorded as skipped', R.addHistory([], { status: 'skipped' })[0].status === 'skipped');
}

// ---- "/routine every weekday at 8am: ..."
const parsed = (text) => JSON.stringify(R.parseScheduleText(text));
check('"every weekday at 8am: news brief"', parsed('every weekday at 8am: news brief') === JSON.stringify({ schedule: { repeat: 'weekdays', time: '08:00' }, prompt: 'news brief' }), parsed('every weekday at 8am: news brief'));
check('"daily at 9:30pm check example.com"', parsed('daily at 9:30pm check example.com') === JSON.stringify({ schedule: { repeat: 'daily', time: '21:30' }, prompt: 'check example.com' }), parsed('daily at 9:30pm check example.com'));
check('"every monday and friday 7:15 summarize my week"', parsed('every monday and friday 7:15 summarize my week') === JSON.stringify({ schedule: { repeat: 'weekly', time: '07:15', days: [1, 5] }, prompt: 'summarize my week' }), parsed('every monday and friday 7:15 summarize my week'));
check('"every 4 hours, check the status page"', parsed('every 4 hours, check the status page') === JSON.stringify({ schedule: { repeat: 'hours', hours: 4 }, prompt: 'check the status page' }));
check('"every morning: ..." is daily at 8:00', R.parseScheduleText('every morning: brief me').schedule.time === '08:00');
check('a prompt with no schedule in front gives null', R.parseScheduleText('summarize the news every day') === null && R.parseScheduleText('every monkey at 8') === null);
check('"every day at 13pm" is not a time', R.parseScheduleText('every day at 13pm x') === null);

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
