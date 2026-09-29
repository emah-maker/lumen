// Grok Build's "usage limit reached" message: recognising it, and finding when it says the limit
// resets. Grok publishes no plan limits (no command or field carries them), so the only honest
// source of a reset time is the error text itself, when it names one. Pure; no I/O.

// What describeFailure (grok-build.js) has always treated as a plan-limit message.
const LIMIT_RE = /usage limit|limit reached|rate.?limit|out of (extra )?usage|resets? (at|in)|quota/i;
const isLimitText = (text) => LIMIT_RE.test(String(text || ''));

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// Abbreviations people and servers write. Only the unambiguous ones; anything else is local time.
const ZONE_OFFSETS = { UTC: 0, GMT: 0, Z: 0, EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420 };
const UNIT_MS = { d: 864e5, h: 36e5, m: 6e4, s: 1e3 };
const MAX_AHEAD = 45 * 864e5; // a reset further away than this is a misread, not a reset

// The offset (ms) of an IANA zone at an instant, or null for a name Intl doesn't know.
function zoneOffset(zone, at) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(new Date(at)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(at / 1000) * 1000;
  } catch { return null; }
}

// A wall-clock time in a zone -> an instant. zone: { iana } | { offsetMin } | null (local time).
function wallToInstant(y, mo, d, h, mi, s, zone) {
  if (!zone) return new Date(y, mo, d, h, mi, s).getTime();
  const guess = Date.UTC(y, mo, d, h, mi, s);
  if (zone.offsetMin != null) return guess - zone.offsetMin * 6e4;
  let t = guess - (zoneOffset(zone.iana, guess) ?? 0);
  t = guess - (zoneOffset(zone.iana, t) ?? 0); // once more: the offset at the answer can differ across a DST change
  return t;
}

// The time zone a piece of text names, right after a time: "(America/New_York)", "PST", "UTC+2".
function zoneIn(text) {
  const iana = /\b([A-Z][A-Za-z]+(?:\/[A-Za-z_+-]+)+)\b/.exec(text);
  if (iana && zoneOffset(iana[1], Date.now()) !== null) return { iana: iana[1] };
  const off = /\b(?:UTC|GMT)\s*([+-])(\d{1,2})(?::?(\d{2}))?\b/i.exec(text);
  if (off) return { offsetMin: (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3] || 0)) };
  const abbr = /\b(UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT)\b/.exec(text);
  return abbr ? { offsetMin: ZONE_OFFSETS[abbr[1]] } : null;
}

function relative(s) {
  let total = 0;
  let found = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi)) {
    total += Number(m[1]) * UNIT_MS[m[2][0].toLowerCase()];
    found = true;
  }
  const word = /\b(?:an?|one)\s+(day|hour|minute)\b/i.exec(s);
  if (!found && word) { total = UNIT_MS[word[1][0].toLowerCase()]; found = true; }
  return found ? total : null;
}

// When the message says the limit resets, as epoch ms, or null. `now` is injectable for tests.
//   "resets in 2h 10m" · "try again in 45 minutes" · "retry after 3600 seconds" (relative)
//   "resets at 3:40pm" · "resets at 15:40 (America/New_York)" · "resets Oct 2 at 9am PST" (wall clock)
//   "resets 2026-10-01T15:40:00Z" · "... 2026-10-01 15:40 UTC" (ISO)
//   "resets_at": 1790640600 (Unix seconds or ms)
function parseResetTime(text, now = Date.now()) {
  const t = String(text || '');
  const anchor = /\b(resets?(?:_at)?|renews?|try again|retry(?:[- ]after)?|available again|until|refreshes)\b/i.exec(t);
  if (!anchor) return null;
  const s = t.slice(anchor.index, anchor.index + 240);
  const done = (ms) => (Number.isFinite(ms) && ms > now - 6e4 && ms <= now + MAX_AHEAD ? ms : null);

  const epoch = /\b(1\d{9}|1\d{12})\b/.exec(s); // 2001..2033 in seconds, or in ms
  if (epoch) return done(epoch[1].length === 13 ? Number(epoch[1]) : Number(epoch[1]) * 1000);

  const iso = /(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?[ \t]*(Z|[+-]\d{2}:?\d{2})?/.exec(s);
  if (iso) {
    let zone = null;
    if (iso[7]) zone = iso[7] === 'Z' ? { offsetMin: 0 } : { offsetMin: (iso[7][0] === '-' ? -1 : 1) * (Number(iso[7].slice(1, 3)) * 60 + Number(iso[7].slice(-2))) };
    else zone = zoneIn(s.slice(iso.index + iso[0].length, iso.index + iso[0].length + 40));
    return done(wallToInstant(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5], +(iso[6] || 0), zone));
  }

  // A relative phrase ("in 2h 10m") when it comes before any clock time: "resets at 3pm in New York"
  // is a clock time, not "in" something.
  const clock = /(\d{1,2})(?::(\d{2}))?[ \t]*([ap])\.?m\b\.?|\b([01]?\d|2[0-3]):([0-5]\d)\b/i.exec(s);
  const inRel = /\b(?:in|after)\s+(?=\d|an?\b|one\b)/i.exec(s);
  if (inRel && (!clock || inRel.index < clock.index)) {
    const ms = relative(s.slice(inRel.index));
    if (ms != null) return done(now + ms);
  }
  if (!clock) return null;

  let h; let mi;
  if (clock[3]) { h = Number(clock[1]) % 12 + (clock[3].toLowerCase() === 'p' ? 12 : 0); mi = Number(clock[2] || 0); if (Number(clock[1]) > 12 || Number(clock[1]) < 1) return null; }
  else { h = Number(clock[4]); mi = Number(clock[5]); }
  const zone = zoneIn(s.slice(clock.index + clock[0].length, clock.index + clock[0].length + 40));
  const before = s.slice(0, clock.index);
  const monthAt = new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\.?[ \\t]+(\\d{1,2})(?:st|nd|rd|th)?(?:,?[ \\t]+(\\d{4}))?`, 'i').exec(before);
  const numeric = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(before);
  // "today" in the zone the time is written in: compute the wall date there.
  const inZone = (ms) => {
    if (!zone) return new Date(ms);
    const off = zone.offsetMin != null ? zone.offsetMin * 6e4 : zoneOffset(zone.iana, ms) ?? 0;
    return new Date(ms + off); // read with the UTC getters
  };
  const wall = (dt) => (zone ? { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate() } : { y: dt.getFullYear(), m: dt.getMonth(), d: dt.getDate() });
  const today = wall(inZone(now));
  let target;
  if (monthAt || numeric) {
    const month = monthAt ? MONTHS.indexOf(monthAt[1].toLowerCase()) : Number(numeric[1]) - 1;
    const day = Number(monthAt ? monthAt[2] : numeric[2]);
    let year = Number((monthAt ? monthAt[3] : numeric[3]) || 0);
    if (year && year < 100) year += 2000;
    if (year) target = wallToInstant(year, month, day, h, mi, 0, zone);
    else {
      target = wallToInstant(today.y, month, day, h, mi, 0, zone);
      if (target < now - 6e4) target = wallToInstant(today.y + 1, month, day, h, mi, 0, zone);
    }
  } else {
    target = wallToInstant(today.y, today.m, today.d, h, mi, 0, zone);
    if (target < now - 6e4) target = wallToInstant(today.y, today.m, today.d + 1, h, mi, 0, zone);
  }
  return done(target);
}

// The limit a failed run's text describes: { text (first line, trimmed), resetsAt (ms | null) }, or
// null when it isn't a limit message.
function limitOf(text, now = Date.now()) {
  if (!isLimitText(text)) return null;
  return { text: String(text).trim().split('\n')[0].slice(0, 200), resetsAt: parseResetTime(text, now) };
}

module.exports = { LIMIT_RE, isLimitText, parseResetTime, limitOf };
