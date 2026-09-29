// What a World clock widget shows: a few places, each with its time zone, and today's sunrise and
// sunset there. Pure functions, no network and no Electron. features/widgets.js fetches the sun times
// (Open-Meteo, keyless) and sends the page plain data only: a time zone NAME and "HH:MM" strings.
// The page (renderer/newtab-widgets.js, which loads this file too) ticks the clocks itself with Intl,
// so the card never needs a refetch for the time to move. The tests exercise all of this on its own.
(() => {
'use strict';

const CLOCKS = ['auto', '12', '24'];
const MAX_PLACES = 8;

const flat = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);

// ---- time zones ----
// An IANA name ("Asia/Tokyo", "America/Argentina/Buenos_Aires", "UTC") the runtime knows, or null.
// The shape is checked first so nothing odd is ever handed to Intl.
function cleanTz(v) {
  if (typeof v !== 'string' || v.length > 64 || !/^(?:UTC|GMT|[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){1,2})$/.test(v)) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: v }).format(0); return v; } catch { return null; }
}
const formatters = new Map();
function formatter(tz, key, options) {
  const k = `${tz}|${key}`;
  let f = formatters.get(k);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...options }); formatters.set(k, f); if (formatters.size > 200) formatters.delete(formatters.keys().next().value); }
  return f;
}
// The wall clock in a zone at a moment: { date: 'YYYY-MM-DD', hour, minute, second, minutes (since midnight) }.
function zoneParts(ms, tz) {
  const parts = {};
  for (const p of formatter(tz, 'parts', { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ms)) parts[p.type] = p.value;
  const hour = Number(parts.hour) % 24;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour, minute: Number(parts.minute), second: Number(parts.second), minutes: hour * 60 + Number(parts.minute) };
}
// The zone's offset from UTC at a moment, in minutes (Kolkata +330, New York -240 in summer).
function offsetMinutes(ms, tz) {
  const p = zoneParts(ms, tz);
  const [y, m, d] = p.date.split('-').map(Number);
  const asUtc = Date.UTC(y, m - 1, d, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60e3);
}
// How far ahead (+) or behind (-) a zone is from the viewer's, as "+3 h", "-9:30 h" or "same time".
function relativeLabel(diffMinutes) {
  if (!Number.isFinite(diffMinutes) || diffMinutes === 0) return 'same time';
  const abs = Math.abs(diffMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${diffMinutes > 0 ? '+' : '-'}${h}${m ? `:${String(m).padStart(2, '0')}` : ''} h`;
}
// "9:05 PM" / "21:05" (+ seconds) for a moment in a zone. clock: 'auto' (the system's), '12' or '24'.
function timeText(ms, tz, { clock = 'auto', seconds = false } = {}) {
  const options = { hour: clock === '24' ? '2-digit' : 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) };
  if (clock === '12') options.hour12 = true;
  if (clock === '24') options.hourCycle = 'h23';
  return formatter(tz, `time:${clock}:${seconds}`, options).format(ms);
}
// "Tue, Sep 29" in a zone.
const dateText = (ms, tz) => formatter(tz, 'date', { weekday: 'short', month: 'short', day: 'numeric' }).format(ms);

// ---- sun ----
const hhmm = (v) => { const m = /^(\d{2}):(\d{2})$/.exec(typeof v === 'string' ? v : ''); return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null; };
// The day's record for a local date ('YYYY-MM-DD'), or null when the data doesn't cover it.
const dayFor = (days, date) => (Array.isArray(days) ? days.find((d) => d && d.date === date) || null : null);
// Is the sun up? `parts` is zoneParts() of the place; `day` is { sunrise, sunset } as "HH:MM" (either may
// be null: polar day or night, which a missing pair alone can't tell apart, so it answers null = unknown).
function isDaylight(parts, day) {
  const rise = hhmm(day?.sunrise);
  const set = hhmm(day?.sunset);
  if (rise === null || set === null) return null;
  return rise <= set ? parts.minutes >= rise && parts.minutes < set : parts.minutes >= rise || parts.minutes < set;
}

// ---- config ----
// { name, lat, lon, tz?, nick? } or null. tz is looked up when it is missing (see shapeSun).
function cleanPlace(p) {
  if (!p || typeof p !== 'object') return null;
  const lat = num(p.lat, -90, 90);
  const lon = num(p.lon, -180, 180);
  const name = flat(p.name, 80);
  if (lat === null || lon === null || !name) return null;
  const nick = flat(p.nick, 30);
  const tz = cleanTz(p.tz);
  return { name, lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4, ...(tz ? { tz } : {}), ...(nick ? { nick } : {}) };
}
function cleanPlaces(list, max = MAX_PLACES) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const p = cleanPlace(raw);
    if (p && !out.some((o) => Math.abs(o.lat - p.lat) < 0.01 && Math.abs(o.lon - p.lon) < 0.01)) out.push(p);
    if (out.length >= max) break;
  }
  return out;
}
const placeLabel = (p) => p.nick || p.name.split(',')[0].trim();
// The stored config -> a complete, checked one; null when there is no place.
function cleanConfig(wc) {
  const i = wc && typeof wc === 'object' ? wc : {};
  const places = cleanPlaces(i.places);
  if (!places.length) return null;
  const show = i.show && typeof i.show === 'object' ? i.show : {};
  return {
    clock: pick(i.clock, CLOCKS, 'auto'),
    seconds: i.seconds === true,
    show: { date: show.date !== false, offset: show.offset !== false, sun: show.sun !== false },
    places,
  };
}

// ---- the sun service (Open-Meteo forecast, daily sunrise and sunset only) ----
function sunParams(place) {
  return { latitude: String(place.lat), longitude: String(place.lon), timezone: 'auto', forecast_days: '3', daily: 'sunrise,sunset' };
}
// The service's answer -> { tz, days: [{ date, sunrise, sunset }] } (times "HH:MM" in the place's own zone), or null.
function shapeSun(raw, place) {
  const w = raw && typeof raw === 'object' ? raw : {};
  const tz = cleanTz(w.timezone) || cleanTz(place?.tz);
  if (!tz) return null;
  const daily = w.daily && typeof w.daily === 'object' ? w.daily : {};
  const at = (list, i) => (Array.isArray(list) ? list[i] : undefined);
  const clockOf = (t) => { const m = /T(\d{2}:\d{2})/.exec(String(t)); return m ? m[1] : null; };
  const days = [];
  for (let i = 0; i < Math.min(3, Array.isArray(daily.time) ? daily.time.length : 0); i++) {
    const m = /^(\d{4}-\d{2}-\d{2})$/.exec(String(at(daily.time, i)));
    if (m) days.push({ date: m[1], sunrise: clockOf(at(daily.sunrise, i)), sunset: clockOf(at(daily.sunset, i)) });
  }
  return { tz, days };
}

const api = {
  CLOCKS, MAX_PLACES, cleanTz, zoneParts, offsetMinutes, relativeLabel, timeText, dateText, dayFor, isDaylight,
  cleanPlace, cleanPlaces, placeLabel, cleanConfig, sunParams, shapeSun,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.WorldClock = api;
})();
