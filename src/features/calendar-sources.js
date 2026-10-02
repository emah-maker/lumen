// The Calendar widget's sources (features/widgets.js, renderer/newtab-widgets.js), no DOM and no Electron
// (test/calendar-multi-units.js covers this file). A Calendar card shows one or several calendars at once:
//
//   config.cals = [{ name, url, color, enabled }]   up to MAX_SOURCES, in the order the person put them
//
// An older card has only `url` (and `name`, the feed's own title). It is read as one source: nothing
// is migrated, and a card saved by this version still carries `url` and `name` for the first source so
// every older reader keeps working. All of it is checked again here; the forms' checks are for the person.
//   - sourcesOf(c): the cleaned sources of a card or of a form's input (cals, else the old url).
//   - merge(parts, opts): the sources' events as one timeline (sorted, the same event in two calendars once).
//   - summaryOf(c): the line in Settings' widget list ("School + Other · 2 calendars").
'use strict';

const MAX_SOURCES = 8;
const MAX_NAME = 60;
const MAX_URL = 2000;
// Distinct from each other and readable on a light or a dark card; used when neither the person nor the feed picked one.
const PALETTE = ['#4f8ef7', '#e5604d', '#35a974', '#e0a030', '#9b6bd6', '#25a9b8', '#d6609a', '#7d8896'];

const flat = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
// An https address (webcal:// counts as https), or null. No credentials, spaces or quotes; http:// is refused.
function secureUrl(value) {
  const text = (typeof value === 'string' ? value.trim() : '').replace(/^webcals?:\/\//i, 'https://');
  if (!/^https:\/\//i.test(text) || text.length > MAX_URL || /[\s"'<>\\]/.test(text)) return null;
  try {
    const u = new URL(text);
    return u.protocol === 'https:' && u.hostname && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}
// '#rgb' or '#rrggbb' -> '#rrggbb' (lower case), or ''.
function cleanColor(v) {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
  let m = /^#([0-9a-f]{6})$/.exec(t);
  if (m) return `#${m[1]}`;
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(t);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : '';
}
// A short, stable name for a calendar that the page can use as a key without ever seeing its address.
function idOf(url) {
  let h = 2166136261;
  for (let i = 0; i < url.length; i++) { h ^= url.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return `c${h.toString(36)}`;
}

// One source or null. A blank address is not a source.
function cleanSource(s) {
  if (!s || typeof s !== 'object') return null;
  const url = secureUrl(s.url);
  if (!url) return null;
  return { id: idOf(url), name: flat(s.name, MAX_NAME), url, color: cleanColor(s.color), enabled: s.enabled !== false };
}
// Many: invalid ones dropped, the same address once (the first wins), at most MAX_SOURCES.
function cleanSources(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const s = cleanSource(raw);
    if (!s || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}
// A card's (or a form's) sources: `cals` when it has any good ones, otherwise the old single address.
function sourcesOf(c) {
  if (!c || typeof c !== 'object') return [];
  const many = cleanSources(c.cals);
  if (many.length) return many;
  const one = cleanSource({ url: c.url, name: c.name, enabled: true });
  return one ? [one] : [];
}
// What is wrong with a form's list, as a sentence, or '': a name with no address, an address that is not https, too many, none on.
function problem(c) {
  if (!c || !Array.isArray(c.cals)) return '';
  const rows = c.cals.filter((r) => r && typeof r === 'object' && (flat(r.url, MAX_URL) || flat(r.name, MAX_NAME)));
  if (rows.length > MAX_SOURCES) return `Up to ${MAX_SOURCES} calendars.`;
  for (const [i, r] of rows.entries()) {
    const label = flat(r.name, MAX_NAME) || `Calendar ${i + 1}`;
    if (!secureUrl(r.url)) return `${label} needs an https:// or webcal:// address.`;
  }
  const good = rows.map((r) => cleanSource(r));
  if (good.length && !good.some((s) => s && s.enabled)) return 'Turn on at least one calendar.';
  return '';
}

// The name a calendar goes by: what the person typed, else what the feed calls itself, else its host.
const labelOf = (s, feedName, i = 0) => s.name || flat(feedName, MAX_NAME) || hostOf(s.url) || `Calendar ${i + 1}`;
const defaultColor = (i) => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];

// ---- merging ----
const dupKeys = (e) => {
  const keys = [`t|${e.allDay ? 1 : 0}|${e.start}|${e.end}|${String(e.title || '').toLowerCase()}`];
  if (e.uid) keys.push(`u|${e.uid}|${e.start}`);
  return keys;
};
// parts: [{ id, ok, events: [{ title, start, end, allDay, uid?, ... }] }] in the order of the sources.
// -> { events (soonest first; all-day before timed at the same moment; the earlier source first), dropped }
// An event that appears in two calendars (same UID and start, or the same title, start and end) is kept once,
// with the earlier source's copy, and says so in `also` (the other calendars' ids).
function merge(parts, { limit = 30, now = null } = {}) {
  const seen = new Map();
  const all = [];
  let dropped = 0;
  for (const [order, part] of (Array.isArray(parts) ? parts : []).entries()) {
    if (!part || !Array.isArray(part.events)) continue;
    for (const e of part.events) {
      if (!e || !Number.isFinite(e.start)) continue;
      if (now != null && !e.allDay && !(e.end > now)) continue;
      const keys = dupKeys(e);
      const twin = keys.map((k) => seen.get(k)).find(Boolean);
      if (twin) {
        dropped++;
        if (part.id && twin.cal !== part.id && !twin.also.includes(part.id)) twin.also.push(part.id);
        continue;
      }
      const item = { ...e, cal: part.id || '', also: [], order };
      for (const k of keys) seen.set(k, item);
      all.push(item);
    }
  }
  all.sort((a, b) => a.start - b.start || Number(Boolean(b.allDay)) - Number(Boolean(a.allDay)) || a.order - b.order || String(a.title).localeCompare(String(b.title)));
  const events = all.slice(0, limit).map(({ order, also, ...rest }) => (also.length ? { ...rest, also } : rest));
  return { events, dropped };
}

// ---- words ----
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// "School + Other · 2 calendars"; one calendar is its address's host, as it always was.
function summaryOf(c) {
  const sources = sourcesOf(c);
  if (!sources.length) return '';
  if (sources.length === 1) return hostOf(sources[0].url);
  const on = sources.filter((s) => s.enabled);
  const names = (on.length ? on : sources).map((s, i) => s.name || hostOf(s.url) || `Calendar ${i + 1}`);
  const shown = names.length > 3 ? `${names.slice(0, 2).join(' + ')} + ${names.length - 2} more` : names.join(' + ');
  const off = sources.length - on.length;
  return `${shown} · ${plural(sources.length, 'calendar', 'calendars')}${off ? `, ${off} off` : ''}`;
}

module.exports = { MAX_SOURCES, MAX_NAME, PALETTE, secureUrl, cleanColor, cleanSource, cleanSources, sourcesOf, problem, idOf, labelOf, defaultColor, merge, summaryOf, hostOf };
