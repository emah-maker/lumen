// What a weather widget shows: its places and options (validated), the units it asks the forecast
// service for, how the answer is cut into "now", an hourly strip and days (with a hi/lo bar on a
// shared scale), and when "My location" may be asked for. Pure functions, no network and no
// Electron: features/widgets.js fetches, the tests exercise all of this on its own.
'use strict';

const UNITS = ['f', 'c'];
const WINDS = ['auto', 'mph', 'kmh', 'ms'];
const CLOCKS = ['auto', '12', '24'];
const VIEWS = ['auto', 'cycle', 'list']; // several places: one at a time with dots, or one row each
const DAYS = [7, 10];
const HOURS = [12, 24];
const SHOW_DEFAULT = { now: true, hourly: true, daily: true, details: true };
const MAX_PLACES = 6; // per widget
const MAX_SAVED = 12; // the saved list in Settings
const LOCATION_TTL = 60 * 60e3; // an IP-derived place is reused for an hour

const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const flat = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const round = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

// ---- places ----
// { name, lat, lon, nick? } or { here: true, name? } ("My location": the name is whatever it resolved
// to last), or null.
function cleanPlace(p) {
  if (!p || typeof p !== 'object') return null;
  const nick = flat(p.nick, 30);
  if (p.here === true) return { here: true, name: flat(p.name, 80) || 'My location', ...(nick ? { nick } : {}) };
  const lat = num(p.lat, -90, 90);
  const lon = num(p.lon, -180, 180);
  const name = flat(p.name, 80);
  if (lat === null || lon === null || !name) return null;
  return { name, lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4, ...(nick ? { nick } : {}) };
}
const samePlace = (a, b) => (a.here || b.here ? Boolean(a.here) === Boolean(b.here) : Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lon - b.lon) < 0.01);
function cleanPlaces(list, max = MAX_PLACES) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const p = cleanPlace(raw);
    if (p && !out.some((o) => samePlace(o, p))) out.push(p);
    if (out.length >= max) break;
  }
  return out;
}
// The list operations Settings uses (each returns a new list).
const addPlace = (list, p, max = MAX_PLACES) => cleanPlaces([...list, p], max);
const removePlace = (list, i) => list.filter((_, j) => j !== i);
function movePlace(list, i, delta) {
  const j = i + (delta < 0 ? -1 : 1);
  if (i < 0 || j < 0 || i >= list.length || j >= list.length) return list.slice();
  const out = list.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
const setNick = (list, i, nick) => list.map((p, j) => (j === i ? cleanPlace({ ...p, nick }) || p : p));
const placeLabel = (p) => p.nick || p.name.split(',')[0].trim();

// The stored weather config -> a complete, checked one. `legacy` is what older Lumens stored
// ({ place, lat, lon, units }): that place becomes the first place. Null when there is no place.
function cleanConfig(wx, legacy = {}) {
  const i = wx && typeof wx === 'object' ? wx : {};
  let places = cleanPlaces(i.places);
  if (!places.length) places = cleanPlaces([{ name: legacy.place, lat: legacy.lat, lon: legacy.lon }]);
  if (!places.length) return null;
  const show = i.show && typeof i.show === 'object' ? i.show : {};
  return {
    units: pick(i.units ?? legacy.units, UNITS, 'f'),
    wind: pick(i.wind, WINDS, 'auto'),
    clock: pick(i.clock, CLOCKS, 'auto'),
    view: pick(i.view, VIEWS, 'auto'),
    days: pick(i.days, DAYS, 7),
    hours: pick(i.hours, HOURS, 12),
    show: Object.fromEntries(Object.keys(SHOW_DEFAULT).map((k) => [k, typeof show[k] === 'boolean' ? show[k] : SHOW_DEFAULT[k]])),
    places,
  };
}
// What an older Lumen reads: the first real place (or the last resolved "My location").
function mirrorPlace(cfg, here) {
  const p = cfg.places.find((x) => !x.here);
  if (p) return { place: p.name, lat: p.lat, lon: p.lon };
  return { place: here?.name || 'My location', lat: here?.lat ?? 0, lon: here?.lon ?? 0 };
}
// The saved-places list in Settings: like a widget's, but longer.
const cleanSaved = (list) => cleanPlaces((Array.isArray(list) ? list : []).filter((p) => p && p.here !== true), MAX_SAVED);

// ---- units ----
const windUnit = (cfg) => (cfg.wind === 'auto' ? (cfg.units === 'f' ? 'mph' : 'kmh') : cfg.wind);
const WIND_LABELS = { mph: 'mph', kmh: 'km/h', ms: 'm/s' };
const precipUnit = (cfg) => (cfg.units === 'f' ? 'in' : 'mm');
// 12h/24h labels for an hour 0..23 (auto: null, the page uses the system locale).
function hourLabel(hour, clock) {
  if (clock === '24') return `${String(hour).padStart(2, '0')}:00`;
  if (clock === '12') return `${hour % 12 || 12} ${hour < 12 ? 'AM' : 'PM'}`;
  return null;
}
// The hi/lo bar: every day's range on one shared scale, in whole percents.
function dayBars(days) {
  const his = days.map((d) => d.hi).filter((v) => v !== null);
  const los = days.map((d) => d.lo).filter((v) => v !== null);
  if (!his.length || !los.length) return days.map(() => ({ from: 0, to: 100 }));
  const min = Math.min(...los, ...his);
  const max = Math.max(...los, ...his);
  const at = (v) => (max === min ? 0 : Math.round(((v - min) / (max - min)) * 100));
  return days.map((d) => (d.hi === null || d.lo === null ? { from: 0, to: 100 } : { from: at(d.lo), to: Math.max(at(d.hi), at(d.lo) + 4) }));
}

// ---- the forecast service (Open-Meteo) ----
function forecastParams(place, cfg) {
  const fixed = cfg.units === 'c';
  return {
    latitude: String(place.lat), longitude: String(place.lon), timezone: 'auto', forecast_days: String(cfg.days),
    current: 'temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,wind_direction_10m,relative_humidity_2m',
    hourly: 'temperature_2m,weather_code,is_day,precipitation_probability,precipitation',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,sunrise,sunset,uv_index_max',
    temperature_unit: fixed ? 'celsius' : 'fahrenheit', wind_speed_unit: windUnit(cfg), precipitation_unit: fixed ? 'mm' : 'inch',
  };
}
// The service's answer -> what a card shows for one place; null temp means an empty forecast.
function shape(raw, cfg) {
  const w = raw && typeof raw === 'object' ? raw : {};
  const cur = w.current || {};
  const hourly = w.hourly || {};
  const daily = w.daily || {};
  const at = (list, i) => (Array.isArray(list) ? list[i] : undefined);
  const code = (v) => (Number.isInteger(v) && v >= 0 && v < 100 ? v : null);
  const hourOf = (t) => { const m = /T(\d{2}):/.exec(String(t)); return m ? Number(m[1]) : null; };
  const dateOf = (t) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(t)); return m ? m[1] : null; };
  const clockOf = (t) => { const m = /T(\d{2}:\d{2})/.exec(String(t)); return m ? m[1] : null; };
  if (round(cur.temperature_2m) === null) return null;
  const times = Array.isArray(hourly.time) ? hourly.time : [];
  const entry = (i) => ({
    date: dateOf(times[i]), hour: hourOf(times[i]), temp: round(at(hourly.temperature_2m, i)), code: code(at(hourly.weather_code, i)),
    day: at(hourly.is_day, i) !== 0, pop: round(at(hourly.precipitation_probability, i)), precip: num(at(hourly.precipitation, i), 0, 1000),
  });
  const now = String(cur.time || '');
  let first = times.findIndex((t) => String(t) > now);
  if (first < 0) first = times.length;
  const next = [];
  for (let i = first; i < times.length && next.length < cfg.hours; i++) {
    const e = entry(i);
    if (e.hour !== null && e.temp !== null) next.push({ hour: e.hour, temp: e.temp, code: e.code, day: e.day, pop: e.pop, precip: e.precip });
  }
  // The hour in progress: chance of rain now.
  const nowIdx = Math.max(0, first - 1);
  const days = [];
  for (let i = 0; i < Math.min(cfg.days, Array.isArray(daily.time) ? daily.time.length : 0); i++) {
    const date = dateOf(at(daily.time, i));
    if (!date) continue;
    const hours = [];
    for (let j = 0; j < times.length; j++) {
      const e = entry(j);
      if (e.date === date && e.hour % 3 === 0 && e.temp !== null) hours.push({ hour: e.hour, temp: e.temp, code: e.code, pop: e.pop });
    }
    days.push({
      date, hi: round(at(daily.temperature_2m_max, i)), lo: round(at(daily.temperature_2m_min, i)), code: code(at(daily.weather_code, i)),
      pop: round(at(daily.precipitation_probability_max, i)), precip: num(at(daily.precipitation_sum, i), 0, 1000), wind: round(at(daily.wind_speed_10m_max, i)),
      sunrise: clockOf(at(daily.sunrise, i)), sunset: clockOf(at(daily.sunset, i)), uv: num(at(daily.uv_index_max, i), 0, 20), hours,
    });
  }
  const bars = dayBars(days);
  days.forEach((d, i) => { d.bar = bars[i]; });
  return {
    temp: round(cur.temperature_2m), feels: round(cur.apparent_temperature), code: code(cur.weather_code), day: cur.is_day !== 0,
    hi: days[0]?.hi ?? null, lo: days[0]?.lo ?? null,
    wind: round(cur.wind_speed_10m), windDir: num(cur.wind_direction_10m, 0, 360), humidity: round(cur.relative_humidity_2m),
    uv: days[0]?.uv ?? null, pop: round(at(hourly.precipitation_probability, nowIdx)), sunrise: days[0]?.sunrise ?? null, sunset: days[0]?.sunset ?? null,
    hourly: next, daily: days,
  };
}

// ---- "My location" ----
// May Lumen look up where this network is? consent: 'unset' | 'granted' | 'denied'. cached:
// { name, lat, lon, at } or null. 'consent': ask first, nothing is sent; 'off': the user said no;
// 'cached': use the last answer; 'query': ask the IP service.
function locationDecision({ consent, cached, now, ttl = LOCATION_TTL }) {
  if (consent === 'denied') return 'off';
  if (consent !== 'granted') return 'consent';
  return cached && Number.isFinite(cached.at) && now - cached.at < ttl && cached.at <= now ? 'cached' : 'query';
}
// The IP service's answer -> { name, lat, lon } (city, region code) or null. Approximate on purpose.
function cleanLocation(body) {
  const b = body && typeof body === 'object' ? body : {};
  const lat = num(Number(b.latitude), -90, 90);
  const lon = num(Number(b.longitude), -180, 180);
  const city = flat(b.city, 60);
  if (lat === null || lon === null || !city || b.error === true) return null;
  const region = flat(b.region_code || b.region, 40);
  return { name: [city, region].filter(Boolean).join(', '), lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}

module.exports = {
  UNITS, WINDS, CLOCKS, VIEWS, DAYS, HOURS, SHOW_DEFAULT, MAX_PLACES, MAX_SAVED, LOCATION_TTL,
  cleanPlace, cleanPlaces, addPlace, removePlace, movePlace, setNick, placeLabel, cleanConfig, mirrorPlace, cleanSaved,
  windUnit, WIND_LABELS, precipUnit, hourLabel, dayBars, forecastParams, shape, locationDecision, cleanLocation,
};
