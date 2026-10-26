// The dates and times the calendar connectors (Google Calendar, Microsoft Calendar) take from the AI, checked and shifted. Pure: no Electron, no network.
// A point is { date: 'YYYY-MM-DD' } (all day) or { dateTime: 'YYYY-MM-DDTHH:MM:SS', timeZone } (a local wall-clock time in that zone).
'use strict';
const { ConnectorError } = require('./util');

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const MS = { hour: 3600e3, day: 86400e3 };

const zone = (ctx) => ctx.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function realDate(y, mo, d) {
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
// A date or a local date-time out of what the AI gave. Throws a ConnectorError for the AI.
function point(value, what, tz) {
  const v = String(value).trim();
  let m = DAY.exec(v);
  if (m && realDate(+m[1], +m[2], +m[3])) return { date: v };
  m = DATETIME.exec(v);
  if (m && realDate(+m[1], +m[2], +m[3]) && +m[4] < 24 && +m[5] < 60 && (m[6] === undefined || +m[6] < 60)) return { dateTime: `${v}${m[6] ? '' : ':00'}`, timeZone: tz };
  throw new ConnectorError(`${what} must be a date like 2026-11-03, or a local time like 2026-11-03T14:30. Nothing was changed.`, 'args');
}
// The same kind of point, shifted by `ms` (for a default end: one hour, or one day for an all-day event).
function shifted(p, ms, tz) {
  if (p.date) { const d = new Date(`${p.date}T00:00:00Z`); return { date: new Date(d.getTime() + ms).toISOString().slice(0, 10) }; }
  const d = new Date(`${p.dateTime}Z`);
  return { dateTime: new Date(d.getTime() + ms).toISOString().slice(0, 19), timeZone: tz };
}
const stampMs = (p) => Date.parse(p.date ? `${p.date}T00:00:00Z` : `${p.dateTime}Z`);
// The end a calendar wants for a start and the end the AI gave (or none). A time: that time, or one hour after the start when none. All day: the
// LAST day as the AI says it (so the same day is a one-day event), which the calendars take as the day after (exclusive). Throws when the two
// kinds differ or the end is before the start.
function span(s, e, tz) {
  if (!e) return shifted(s, s.date ? MS.day : MS.hour, tz);
  if (Boolean(s.date) !== Boolean(e.date)) throw new ConnectorError('start and end must both be dates (all day) or both be times. Nothing was changed.', 'args');
  if (stampMs(e) < stampMs(s) || (!s.date && stampMs(e) === stampMs(s))) throw new ConnectorError('The end must be after the start. Nothing was changed.', 'args');
  return s.date ? shifted(e, MS.day, tz) : e;
}

module.exports = { DAY, MS, zone, point, shifted, span, stampMs, realDate };
