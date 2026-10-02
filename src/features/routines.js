// Routines: a saved prompt that runs as a background task on a calendar schedule ("every weekday at
// 8:00: give me a news brief"). The pure part (no Electron, unit-tested in test/routines-units.js): the
// schedule model, next-run math in local time, the scheduler's plan (what is due, what is skipped, when
// to wake next), the run history and a small parser for "every weekday at 8am ..." in the composer.
//
// A routine IS a background task (features/background-agents.js) whose schedule is { type: 'routine' }:
// the same runner, engines, approvals, encrypted store and Tasks panel. Only when it runs differs, and
// that is decided here. Times are wall-clock in the machine's time zone: "8:00" stays 8:00 across a
// daylight-saving change (a time that doesn't exist that day, 2:30 when clocks jump to 3:00, runs at
// the moment the clocks reach it).

const REPEATS = ['once', 'daily', 'weekdays', 'weekly', 'hours', 'cron'];
const WEEKDAYS = [1, 2, 3, 4, 5];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const LIMITS = { history: 20, historyResult: 6000, startUrl: 500, cron: 100, minGapMin: 5 };
const HOUR = 3600000;
const LATE_MS = 2 * 60000; // a run that starts this long after its time counts as a catch-up
const MAX_SLEEP_MS = HOUR; // the timer never sleeps longer: a changed clock or time zone is noticed within the hour
const OFFLINE_RETRY_MS = 60000; // while offline with a routine due, look again this often (no timer otherwise)

// Errors carry a locale key (routines.error.*) for the UI; the message is the English fallback.
const fail = (key, message, params) => Object.assign(new Error(message), { key: `routines.error.${key}`, params });

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const cleanTime = (t, fallback = '08:00') => {
  const m = TIME_RE.exec(String(t ?? '').trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : fallback;
};

// ---- cron (five fields: minute hour day-of-month month day-of-week; *, lists, ranges and steps)

const CRON_FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
function parseCronField(text, [lo, hi]) {
  const out = new Set();
  for (const part of String(text).split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw fail('cronValue', `“${part}” is not a cron value.`, { part });
    let from = lo;
    let to = hi;
    if (m[1] !== '*') { from = Number(m[2]); to = m[3] !== undefined ? Number(m[3]) : (m[4] ? hi : from); }
    const step = m[4] ? Number(m[4]) : 1;
    if (from < lo || to > hi || from > to || step < 1) throw fail('cronRange', `“${part}” is out of range (${lo}-${hi}).`, { part, lo, hi });
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

function parseCron(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) throw fail('cronFields', 'A cron schedule has five fields: minute hour day month weekday.');
  const [minutes, hours, dom, months, dowRaw] = fields.map((f, i) => parseCronField(f, CRON_FIELDS[i]));
  const dow = new Set([...dowRaw].map((d) => d % 7)); // 7 is Sunday too
  return { minutes: [...minutes].sort((a, b) => a - b), hours: [...hours].sort((a, b) => a - b), dom, months, dow, domAny: fields[2] === '*', dowAny: fields[4] === '*' };
}

// Classic cron: when both the day of the month and the weekday are given, either one matches.
function cronDayMatches(c, date) {
  if (!c.months.has(date.getMonth() + 1)) return false;
  const d = c.dom.has(date.getDate());
  const w = c.dow.has(date.getDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return w;
  if (c.dowAny) return d;
  return d || w;
}

// ---- schedules

// A routine's schedule, checked. Throws with a message for the user. Accepts a past 'once' (a saved one
// whose time has gone); validateNew() is the stricter check for a schedule being saved now.
function normalizeRoutineSchedule(raw, now = Date.now()) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const repeat = REPEATS.includes(s.repeat) ? s.repeat : null;
  if (!repeat) throw fail('repeat', 'Pick how often the routine runs.');
  if (repeat === 'once') {
    const at = typeof s.at === 'number' ? s.at : Date.parse(s.at);
    if (!Number.isFinite(at)) throw fail('at', 'Pick a valid date and time.');
    return { type: 'routine', repeat, at: Math.round(at) };
  }
  if (repeat === 'hours') {
    const hours = Math.round(Number(s.hours));
    if (!Number.isFinite(hours) || hours < 1 || hours > 24) throw fail('hours', 'Repeat every 1 to 24 hours.');
    const anchor = Number.isFinite(Number(s.anchor)) && Number(s.anchor) > 0 ? Math.round(Number(s.anchor)) : now;
    return { type: 'routine', repeat, hours, anchor };
  }
  if (repeat === 'cron') {
    const cron = String(s.cron || '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.cron);
    parseCron(cron); // throws when it isn't one
    return { type: 'routine', repeat, cron };
  }
  const time = cleanTime(s.time);
  if (repeat === 'daily') return { type: 'routine', repeat, time, days: ALL_DAYS };
  if (repeat === 'weekdays') return { type: 'routine', repeat, time, days: WEEKDAYS };
  const days = [...new Set((Array.isArray(s.days) ? s.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
  if (!days.length) throw fail('days', 'Pick at least one day.');
  return { type: 'routine', repeat, time, days };
}

// The stricter check for a schedule the user is saving now: a one-off time must be ahead, and a cron
// schedule may not run more often than every 5 minutes (as a repeating task).
function validateNew(schedule, now = Date.now()) {
  if (schedule.repeat === 'once' && schedule.at <= now) throw fail('past', 'Pick a time in the future.');
  if (schedule.repeat === 'cron') {
    const times = upcoming(schedule, now, 60);
    if (!times.length) throw fail('never', 'That cron schedule never runs.');
    for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] < LIMITS.minGapMin * 60000) throw fail('often', 'A routine runs at most every 5 minutes.', { n: LIMITS.minGapMin });
  }
  return schedule;
}

// The first run time strictly after `after` (ms), or null if there is none.
function nextOccurrence(schedule, after) {
  const s = schedule;
  if (!s || s.type !== 'routine') return null;
  if (s.repeat === 'once') return s.at > after ? s.at : null;
  if (s.repeat === 'hours') {
    const step = s.hours * HOUR;
    return s.anchor + (Math.floor((after - s.anchor) / step) + 1) * step; // real hours: daylight saving doesn't bend them
  }
  const base = new Date(after);
  if (s.repeat === 'cron') {
    const c = parseCron(s.cron);
    for (let i = 0; i < 366 * 5; i++) { // five years covers 29 February
      const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, 12);
      if (!cronDayMatches(c, day)) continue;
      for (const h of c.hours) {
        for (const m of c.minutes) {
          const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
          if (at > after) return at;
        }
      }
    }
    return null;
  }
  const [hh, mm] = s.time.split(':').map(Number);
  for (let i = 0; i < 9; i++) {
    // The weekday is read at noon, which every day has; the run time itself goes through the local
    // calendar, so it is 8:00 in summer and in winter.
    const noon = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, 12);
    if (!s.days.includes(noon.getDay())) continue;
    const at = new Date(noon.getFullYear(), noon.getMonth(), noon.getDate(), hh, mm).getTime();
    if (at > after) return at;
  }
  return null;
}

// The next `n` run times after `from` (the editor's "Next runs" line, and validateNew).
function upcoming(schedule, from, n = 3) {
  const out = [];
  let t = from;
  while (out.length < n) {
    const next = nextOccurrence(schedule, t);
    if (next === null) break;
    out.push(next);
    t = next;
  }
  return out;
}

// ---- the routine's own state on the task (task.routine)

const cleanLine = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const webUrl = (raw) => {
  const text = String(raw || '').trim();
  if (!text) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href.slice(0, LIMITS.startUrl) : null;
  } catch { return null; }
};
const HISTORY_STATUSES = ['done', 'failed', 'stopped', 'interrupted', 'skipped'];
const TRIGGERS = ['schedule', 'catch-up', 'manual'];

// lastDue: the scheduled time last handled (run, skipped, or "from now on" after an edit or a resume),
// so missed times before it never run. trigger/scheduledFor: what the queued run is, for its history entry.
function newRoutineState({ startUrl = '' } = {}) {
  return { startUrl: startUrl || '', lastDue: null, trigger: null, scheduledFor: null, history: [] };
}

function sanitizeRoutine(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  return {
    startUrl: webUrl(r.startUrl) || '',
    lastDue: num(r.lastDue),
    trigger: TRIGGERS.includes(r.trigger) ? r.trigger : null,
    scheduledFor: num(r.scheduledFor),
    history: (Array.isArray(r.history) ? r.history : []).slice(-LIMITS.history).map((h) => ({
      startedAt: num(h?.startedAt) || 0,
      endedAt: num(h?.endedAt) || 0,
      scheduledFor: num(h?.scheduledFor),
      trigger: TRIGGERS.includes(h?.trigger) ? h.trigger : 'schedule',
      status: HISTORY_STATUSES.includes(h?.status) ? h.status : 'done',
      result: String(h?.result ?? '').slice(0, LIMITS.historyResult),
      error: cleanLine(h?.error, 300),
    })),
  };
}

// One entry in the run history, newest last, capped.
function addHistory(history, entry) {
  const e = {
    startedAt: entry.startedAt || 0, endedAt: entry.endedAt || 0, scheduledFor: entry.scheduledFor ?? null,
    trigger: TRIGGERS.includes(entry.trigger) ? entry.trigger : 'schedule', status: HISTORY_STATUSES.includes(entry.status) ? entry.status : 'done',
    result: String(entry.result || '').slice(0, LIMITS.historyResult), error: cleanLine(entry.error, 300),
  };
  return [...(history || []), e].slice(-LIMITS.history);
}

// When the routine is next due (ms), or null: the first scheduled time after the last one handled (or
// after it was made). A time already past means it is due now: Lumen was closed or the Mac asleep.
function dueAt(task) {
  if (!task || task.enabled === false || task.schedule?.type !== 'routine') return null;
  const base = task.routine?.lastDue ?? task.createdAt ?? 0;
  return nextOccurrence(task.schedule, base);
}

// The scheduler's decision at `now`. Missed times run once (one catch-up however many were missed); a
// routine whose previous run is still going skips the time (never two copies); offline, nothing starts
// and the scheduler looks again in a minute. wakeAt: when to look next (one timer for all routines).
function plan(tasks, now, { online = true, enabled = true, isActive = () => false } = {}) {
  const out = { queue: [], skip: [], offline: [], wakeAt: null };
  if (!enabled) return out;
  const wake = (t) => { if (t !== null && (out.wakeAt === null || t < out.wakeAt)) out.wakeAt = t; };
  for (const task of tasks) {
    const due = dueAt(task);
    if (due === null) continue;
    if (due > now) { wake(due); continue; }
    if (isActive(task)) { out.skip.push({ id: task.id, dueAt: due }); continue; }
    if (!online) { out.offline.push(task.id); continue; }
    out.queue.push({ id: task.id, dueAt: due, trigger: now - due > LATE_MS ? 'catch-up' : 'schedule' });
  }
  if (out.offline.length) wake(now + OFFLINE_RETRY_MS);
  return out;
}

// How long the single timer sleeps for a plan's wakeAt (null: no timer at all).
const sleepFor = (wakeAt, now) => (wakeAt === null ? null : Math.max(0, Math.min(wakeAt - now, MAX_SLEEP_MS)));

// ---- "every weekday at 8am: ..." typed with /routine

const DAY_WORDS = { sun: 0, sunday: 0, sundays: 0, mon: 1, monday: 1, mondays: 1, tue: 2, tues: 2, tuesday: 2, tuesdays: 2, wed: 3, wednesday: 3, wednesdays: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, thursdays: 4, fri: 5, friday: 5, fridays: 5, sat: 6, saturday: 6, saturdays: 6 };
function parseClock(text) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i.exec(String(text).trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ampm = (m[3] || '').toLowerCase().replace(/\./g, '');
  if (ampm) { if (h < 1 || h > 12) return null; h = (h % 12) + (ampm === 'pm' ? 12 : 0); }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// A schedule at the start of `text`, and the rest as the prompt; null when the text names none.
function parseScheduleText(text) {
  const src = String(text || '').trim();
  const AT = '(?:\\s+(?:at\\s+)?(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)?))?';
  const END = '\\s*[:,\\-–—]?\\s*([\\s\\S]*)$';
  const tries = [
    [new RegExp(`^every\\s+(\\d{1,2})\\s+hours?${END}`, 'i'), (m) => ({ repeat: 'hours', hours: Number(m[1]), rest: m[2] })],
    [new RegExp(`^(?:every\\s+hour|hourly)${END}`, 'i'), (m) => ({ repeat: 'hours', hours: 1, rest: m[1] })],
    [new RegExp(`^(?:every\\s+weekday|weekdays|on\\s+weekdays|every\\s+work\\s*day)${AT}${END}`, 'i'), (m) => ({ repeat: 'weekdays', time: m[1], rest: m[2] })],
    [new RegExp(`^(?:every\\s+day|daily|each\\s+day|every\\s+morning|every\\s+evening)${AT}${END}`, 'i'), (m, all) => ({ repeat: 'daily', time: m[1] || (/evening/i.test(all) ? '18:00' : '08:00'), rest: m[2] })],
    [new RegExp(`^(?:every|on|each)\\s+((?:(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*)(?:\\s*(?:,|and|&)\\s*(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*)*)${AT}${END}`, 'i'), (m) => ({ repeat: 'weekly', days: m[1].toLowerCase().split(/\s*(?:,|and|&)\s*/).map((w) => DAY_WORDS[w]), time: m[2], rest: m[3] })],
    [new RegExp(`^(?:weekly|every\\s+week)${AT}${END}`, 'i'), (m) => ({ repeat: 'weekly', days: [1], time: m[1], rest: m[2] })],
  ];
  for (const [re, make] of tries) {
    const m = re.exec(src);
    if (!m) continue;
    const r = make(m, m[0]);
    if (r.days && r.days.some((d) => d === undefined)) continue;
    const schedule = { repeat: r.repeat };
    if (r.repeat === 'hours') { if (r.hours < 1 || r.hours > 24) continue; schedule.hours = r.hours; } else {
      const time = r.time ? parseClock(r.time) : '08:00';
      if (!time) continue;
      schedule.time = time;
      if (r.days) schedule.days = [...new Set(r.days)].sort((a, b) => a - b);
    }
    return { schedule, prompt: String(r.rest || '').trim() };
  }
  return null;
}

module.exports = {
  REPEATS, WEEKDAYS, ALL_DAYS, LIMITS, LATE_MS, MAX_SLEEP_MS, OFFLINE_RETRY_MS,
  parseCron, normalizeRoutineSchedule, validateNew, nextOccurrence, upcoming,
  webUrl, newRoutineState, sanitizeRoutine, addHistory, dueAt, plan, sleepFor, parseClock, parseScheduleText,
};
