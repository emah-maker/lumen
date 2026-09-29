// A small iCalendar (ICS) reader for the calendar widget (features/widgets.js): the events of a
// feed that fall in a window of days, with no dependencies.
//
// It handles line unfolding, TEXT escapes, VEVENT's DTSTART / DTEND / DURATION / SUMMARY / LOCATION /
// URL / STATUS, all-day (DATE) events, UTC, floating and TZID times (IANA names, the common Windows
// names and Mozilla's "/mozilla.org/…/Area/City"; converted with Intl), EXDATE, RECURRENCE-ID
// overrides, and RRULE with FREQ=DAILY / WEEKLY (INTERVAL, COUNT, UNTIL, BYDAY) and plain
// MONTHLY / YEARLY (same day of the month or year). Other rules show their first occurrence only.
// Everything it returns is plain text and numbers; nothing in a feed is ever treated as markup.

const MAX_EVENTS = 5000; // VEVENTs read from one feed
const MAX_STEPS = 20000; // recurrence steps per event
const DAY = 86400e3;

const WINDOWS_ZONES = {
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix', 'Pacific Standard Time': 'America/Los_Angeles', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax', 'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris', 'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw', 'E. Europe Standard Time': 'Europe/Bucharest', 'FLE Standard Time': 'Europe/Kiev',
  'India Standard Time': 'Asia/Kolkata', 'China Standard Time': 'Asia/Shanghai', 'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul', 'Singapore Standard Time': 'Asia/Singapore', 'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland', UTC: 'UTC', 'Coordinated Universal Time': 'UTC',
};

// ---- time zones ----
const formatters = new Map();
function formatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
  }
  return formatters.get(tz);
}
const validZone = (tz) => { try { formatter(tz); return true; } catch { return false; } };
// A TZID parameter -> an IANA zone, or null (floating: the computer's own time zone).
function zoneOf(tzid) {
  if (!tzid) return null;
  const name = String(tzid).replace(/^"|"$/g, '').trim();
  if (WINDOWS_ZONES[name]) return WINDOWS_ZONES[name];
  if (validZone(name)) return name;
  const tail = name.split('/').filter(Boolean).slice(-2).join('/'); // /mozilla.org/20050126_1/America/New_York
  return tail && validZone(tail) ? tail : null;
}
function offsetAt(tz, ms) {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
// Wall-clock time in `tz` ('UTC', an IANA zone, or null for local) -> epoch ms.
function instant({ y, mo, d, h = 0, mi = 0, s = 0 }, tz) {
  if (tz === 'UTC') return Date.UTC(y, mo - 1, d, h, mi, s);
  if (!tz) return new Date(y, mo - 1, d, h, mi, s).getTime();
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let utc = wall - offsetAt(tz, wall);
  const again = wall - offsetAt(tz, utc); // across a DST change the first guess is an hour out
  if (again !== utc) utc = again;
  return utc;
}
// Calendar arithmetic on dates, as day numbers (days since 1970-01-01, no time zone).
const dayNum = (y, mo, d) => Math.floor(Date.UTC(y, mo - 1, d) / DAY);
const dateOf = (n) => { const t = new Date(n * DAY); return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const weekday = (n) => (new Date(n * DAY).getUTCDay() + 6) % 7; // 0 = Monday
const localDay = (ms) => { const t = new Date(ms); return dayNum(t.getFullYear(), t.getMonth() + 1, t.getDate()); };

// ---- lines and properties ----
function unfold(text) {
  return String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}
// "NAME;P1=a;P2="b:c":value" -> { name, params, value }
function property(line) {
  let i = 0;
  let quoted = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) break;
  }
  if (i >= line.length) return null;
  const [name, ...rawParams] = line.slice(0, i).split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const params = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}
const unescapeText = (v) => v.replace(/\\([\\;,nN])/g, (_m, c) => (c === 'n' || c === 'N' ? '\n' : c));
// A colour a feed gives (COLOR, X-APPLE-CALENDAR-COLOR, X-WR-CALCOLOR): #rgb, #rrggbb, #rrggbbaa or a common CSS name -> '#rrggbb', or ''.
const COLOR_NAMES = { red: '#ff0000', orange: '#ffa500', yellow: '#ffd700', green: '#008000', blue: '#0000ff', purple: '#800080', pink: '#ff69b4', brown: '#8b4513', gray: '#808080', grey: '#808080', teal: '#008080', cyan: '#00bcd4', magenta: '#ff00ff', navy: '#000080', olive: '#808000', lime: '#32cd32', maroon: '#800000', indigo: '#4b0082', violet: '#ee82ee', gold: '#ffd700', coral: '#ff7f50', salmon: '#fa8072', turquoise: '#40e0d0' };
function cleanColor(v) {
  const t = String(v || '').trim().toLowerCase();
  if (COLOR_NAMES[t]) return COLOR_NAMES[t];
  let m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(t);
  if (m) return `#${m[1]}`;
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(t);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : '';
}
const cleanText = (v, max = 200) => unescapeText(v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

// A DATE or DATE-TIME value -> { allDay, y, mo, d, h, mi, s, tz }, or null.
function parseDate(value, params = {}) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (!m[4] || params.VALUE === 'DATE') return { allDay: true, y, mo, d };
  return { allDay: false, y, mo, d, h: +m[4], mi: +m[5], s: +(m[6] || 0), tz: m[7] ? 'UTC' : zoneOf(params.TZID) };
}
// P1D, PT1H30M, -PT15M -> ms
function parseDuration(value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(value).trim());
  if (!m) return null;
  const ms = ((+(m[2] || 0) * 7 + +(m[3] || 0)) * 24 * 3600 + +(m[4] || 0) * 3600 + +(m[5] || 0) * 60 + +(m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}
const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
function parseRule(value) {
  const rule = {};
  for (const part of String(value).split(';')) {
    const [k, v = ''] = part.split('=');
    rule[k.toUpperCase()] = v.toUpperCase();
  }
  const freq = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.FREQ) ? rule.FREQ : null;
  if (!freq) return null;
  const byday = rule.BYDAY ? rule.BYDAY.split(',').map((d) => /^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(d)).filter(Boolean) : [];
  return {
    freq,
    interval: Math.min(1000, Math.max(1, parseInt(rule.INTERVAL, 10) || 1)),
    count: rule.COUNT ? Math.min(MAX_STEPS, Math.max(1, parseInt(rule.COUNT, 10) || 1)) : null,
    until: rule.UNTIL ? parseDate(rule.UNTIL) : null,
    byday: byday.map((m) => DAYS.indexOf(m[2])),
    ordinal: byday.some((m) => m[1]), // "2TU": the 2nd Tuesday (not supported)
    // MONTHLY/YEARLY rules with BY* parts other than a plain start date aren't supported.
    complex: Object.keys(rule).some((k) => /^BY(SETPOS|MONTHDAY|MONTH|YEARDAY|WEEKNO|HOUR|MINUTE|SECOND)$/.test(k)),
  };
}

// ---- the feed ----
// Every VEVENT as { uid, summary, location, url, start, end?, duration?, rrule?, exdates, recurrenceId?, cancelled }.
function readEvents(text) {
  const lines = unfold(text);
  if (!lines.some((l) => /^BEGIN:VCALENDAR\s*$/i.test(l))) throw new Error('That isn’t a calendar (ICS) file.');
  const events = [];
  let name = '';
  let color = '';
  let ev = null;
  let depth = 0; // components nested inside the VEVENT (VALARM)
  for (const line of lines) {
    const p = property(line);
    if (!p) continue;
    if (p.name === 'BEGIN') {
      if (ev) depth++;
      else if (p.value.toUpperCase() === 'VEVENT') ev = { exdates: [], summary: '', location: '', url: '' };
      continue;
    }
    if (p.name === 'END') {
      if (ev && depth) depth--;
      else if (ev && p.value.toUpperCase() === 'VEVENT') {
        if (ev.start) events.push(ev);
        ev = null;
        if (events.length >= MAX_EVENTS) break;
      }
      continue;
    }
    if (!ev) {
      if (p.name === 'X-WR-CALNAME' && !name) name = cleanText(p.value, 80);
      if ((p.name === 'X-APPLE-CALENDAR-COLOR' || p.name === 'X-WR-CALCOLOR' || p.name === 'COLOR') && !color) color = cleanColor(p.value);
      continue;
    }
    if (depth) continue;
    switch (p.name) {
      case 'UID': ev.uid = p.value.slice(0, 300); break;
      case 'SUMMARY': ev.summary = cleanText(p.value); break;
      case 'LOCATION': ev.location = cleanText(p.value); break;
      case 'COLOR': ev.color = cleanColor(p.value); break;
      case 'URL': { const u = p.value.trim(); if (/^https:\/\/[^\s"<>]+$/i.test(u) && u.length < 2000) ev.url = u; break; }
      case 'STATUS': ev.cancelled = /^CANCELLED$/i.test(p.value.trim()); break;
      case 'DTSTART': ev.start = parseDate(p.value, p.params); break;
      case 'DTEND': ev.end = parseDate(p.value, p.params); break;
      case 'DURATION': ev.duration = parseDuration(p.value); break;
      case 'RRULE': ev.rrule = parseRule(p.value); break;
      case 'EXDATE': for (const v of p.value.split(',')) { const d = parseDate(v, p.params); if (d) ev.exdates.push(d); } break;
      case 'RECURRENCE-ID': ev.recurrenceId = parseDate(p.value, p.params); break;
      default: break;
    }
  }
  return { name, color, events };
}

// One occurrence's key: a day number for all-day events, an instant for timed ones.
const keyOf = (d, zone) => (d.allDay ? `d${dayNum(d.y, d.mo, d.d)}` : `t${instant(d, d.tz === undefined ? zone : d.tz)}`);

// The dates an event occurs on (as day numbers), from its start, while `keep(dayNumber)` wants more.
function* occurrenceDays(ev, lastDay) {
  const start = dayNum(ev.start.y, ev.start.mo, ev.start.d);
  const rule = ev.rrule;
  if (!rule || ((rule.freq === 'MONTHLY' || rule.freq === 'YEARLY') && (rule.byday.length || rule.complex)) || rule.ordinal) { yield start; return; }
  const untilDay = rule.until ? dayNum(rule.until.y, rule.until.mo, rule.until.d) : Infinity;
  let emitted = 0;
  const emit = (n) => (n >= start && n <= untilDay && n <= lastDay);
  for (let step = 0; step < MAX_STEPS; step++) {
    let batch;
    if (rule.freq === 'DAILY') {
      const n = start + step * rule.interval;
      batch = rule.byday.length && !rule.byday.includes(weekday(n)) ? [] : [n];
      if (n > untilDay || n > lastDay) return;
    } else if (rule.freq === 'WEEKLY') {
      const weekStart = start - weekday(start) + step * 7 * rule.interval;
      if (weekStart > untilDay || weekStart > lastDay) return;
      const days = rule.byday.length ? [...new Set(rule.byday)].sort((a, b) => a - b) : [weekday(start)];
      batch = days.map((wd) => weekStart + wd);
    } else {
      const { y, mo, d } = ev.start;
      const months = rule.freq === 'MONTHLY' ? step * rule.interval : step * rule.interval * 12;
      const ty = y + Math.floor((mo - 1 + months) / 12);
      const tm = ((mo - 1 + months) % 12) + 1;
      const n = dayNum(ty, tm, d);
      if (n > untilDay || n > lastDay) return;
      batch = dateOf(n).d === d ? [n] : []; // the 31st, Feb 29: months without that day are skipped
    }
    for (const n of batch) {
      if (!emit(n)) continue;
      yield n;
      if (rule.count && ++emitted >= rule.count) return;
    }
  }
}

// The occurrences that overlap [from, from + days) in the computer's time zone, soonest first:
// [{ title, location, url, allDay, date ('YYYY-MM-DD', all-day only), start, end (epoch ms) }]
function eventsBetween(text, { from = Date.now(), days = 14, limit = 50 } = {}) {
  const { name, color, events } = readEvents(text);
  const firstDay = localDay(from);
  const lastDay = firstDay + days;
  const windowStart = new Date(from).setHours(0, 0, 0, 0);
  const windowEnd = windowStart + days * DAY + 2 * 3600e3; // DST slack; the day filter below is exact
  const overrides = new Set();
  for (const ev of events) if (ev.recurrenceId && ev.uid) overrides.add(`${ev.uid}|${keyOf(ev.recurrenceId, ev.start.tz)}`);
  const out = [];
  for (const ev of events) {
    const s = ev.start;
    const zone = s.allDay ? null : s.tz;
    const endsAt = (startMs) => {
      if (ev.end && !ev.end.allDay && !s.allDay) return startMs + (instant(ev.end, ev.end.tz) - instant(s, zone));
      if (ev.duration != null) return startMs + Math.max(0, ev.duration);
      return startMs;
    };
    const spanDays = s.allDay
      ? Math.max(1, ev.end?.allDay ? dayNum(ev.end.y, ev.end.mo, ev.end.d) - dayNum(s.y, s.mo, s.d) : ev.duration ? Math.round(ev.duration / DAY) : 1)
      : 0;
    const excluded = new Set(ev.exdates.map((d) => keyOf(d, zone)));
    for (const n of occurrenceDays(ev, lastDay)) {
      if (n + Math.max(spanDays, 1) < firstDay - 1) continue; // long before the window
      const { y, mo, d } = dateOf(n);
      const occ = s.allDay ? { allDay: true, y, mo, d } : { allDay: false, y, mo, d, h: s.h, mi: s.mi, s: s.s, tz: zone };
      const key = keyOf(occ, zone);
      if (excluded.has(key) || ev.cancelled) continue;
      if (!ev.recurrenceId && ev.rrule && ev.uid && overrides.has(`${ev.uid}|${key}`)) continue; // moved or edited: its override shows instead
      if (s.allDay) {
        if (n + spanDays <= firstDay || n >= lastDay) continue;
        out.push({ title: ev.summary, location: ev.location, url: ev.url, color: ev.color || '', allDay: true, date: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, days: spanDays, start: new Date(y, mo - 1, d).getTime(), end: new Date(y, mo - 1, d + spanDays).getTime() });
      } else {
        const start = instant(occ, zone);
        const until = ev.rrule?.until;
        if (until && !until.allDay && start > instant(until, until.tz)) continue; // UNTIL is an instant, not just a day
        const end = endsAt(start);
        if (Math.max(end, start + 1) <= windowStart || start >= windowEnd || localDay(start) >= lastDay) continue;
        out.push({ title: ev.summary, location: ev.location, url: ev.url, color: ev.color || '', allDay: false, start, end });
      }
    }
  }
  out.sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay));
  return { name, color, total: events.length, events: out.slice(0, limit) };
}

module.exports = { eventsBetween, readEvents, parseDate, parseDuration, parseRule, zoneOf, instant, unfold };
