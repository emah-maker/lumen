// [look] The new-tab clock's styles and the greeting's fonts: the choices, their defaults, the checks, and
// the time split into parts. Pure functions, no DOM, no Electron: used by settings-backend.js (validates the
// settings, lists the choices for Settings → Home), renderer/newtab.js (draws the clock) and the unit tests.
// How each style looks (fonts, weight, tracking, layout) is CSS in renderer/newtab.html, with the same
// stacks for the previews in renderer/settings.css. System fonts only: the page loads no fonts.
(function () {
'use strict';

// Each style is a whole look: font, weight, size, tracking, and where the date sits.
const CLOCK_STYLES = [
  { id: 'classic', label: 'Classic', hint: 'Light and quiet. The original.' },
  { id: 'rounded', label: 'Rounded', hint: 'Soft, rounded numerals.' },
  { id: 'thin', label: 'Thin', hint: 'Large and ultralight, date on top, like a lock screen.' },
  { id: 'serif', label: 'Serif', hint: 'A book face for the time and date.' },
  { id: 'mono', label: 'Mono', hint: 'Monospaced, like a terminal.' },
  { id: 'bold', label: 'Stacked', hint: 'Heavy hours over minutes.' },
];
const CLOCK_HOURS = ['auto', '12', '24']; // auto: as the system's language writes it
const CLOCK_CARDS = ['none', 'soft', 'glass']; // what sits behind the clock and date
const GREETING_FONTS = [
  { id: 'classic', label: 'Classic' },
  { id: 'match', label: 'Match clock' },
  { id: 'rounded', label: 'Rounded' },
  { id: 'serif', label: 'Serif' },
  { id: 'thin', label: 'Thin' },
  { id: 'mono', label: 'Mono' },
  { id: 'hand', label: 'Handwritten' },
];
// Every default is what the page looked like before these choices existed.
const DEFAULTS = { style: 'classic', hours: 'auto', seconds: false, date: true, card: 'none', shadow: false, greeting: 'classic' };

const ids = (list) => list.map((s) => s.id);
const oneOf = (allowed) => (v) => (allowed.includes(v) ? v : null);
const cleanStyle = oneOf(ids(CLOCK_STYLES));
const cleanHours = (v) => oneOf(CLOCK_HOURS)(typeof v === 'number' ? String(v) : v);
const cleanCard = oneOf(CLOCK_CARDS);
const cleanGreetingFont = oneOf(ids(GREETING_FONTS));
// "Match clock": the greeting takes the clock's face (Stacked's is already the greeting's bold one).
function greetingFontFor(font, clockStyle) {
  const f = cleanGreetingFont(font) || DEFAULTS.greeting;
  if (f !== 'match') return f;
  const s = cleanStyle(clockStyle) || DEFAULTS.style;
  return s === 'bold' ? 'classic' : s;
}
// Everything the page needs, from whatever the hash carried: anything unknown is the default.
function clean(o) {
  const c = o && typeof o === 'object' ? o : {};
  return {
    style: cleanStyle(c.style) || DEFAULTS.style,
    hours: cleanHours(c.hours) || DEFAULTS.hours,
    seconds: c.seconds === true,
    date: c.date !== false,
    card: cleanCard(c.card) || DEFAULTS.card,
    shadow: c.shadow === true,
    greeting: cleanGreetingFont(c.greeting) || DEFAULTS.greeting,
  };
}

// The time as parts: { h, m, s (or ''), sep (between hours and minutes), ssep (before the seconds), text }. `hours` is auto | 12 | 24. The AM/PM marker is left out
// (the page never showed it), and 24-hour keeps the leading zero ("09:41"), 12-hour never has one ("9:41").
function clockParts(date, { hours = 'auto', seconds = false, locale } = {}) {
  const opts = { hour: 'numeric', minute: '2-digit' };
  if (seconds) opts.second = '2-digit';
  if (hours === '12') opts.hour12 = true;
  if (hours === '24') { opts.hourCycle = 'h23'; opts.hour = '2-digit'; }
  let parts;
  try { parts = new Intl.DateTimeFormat(locale || undefined, opts).formatToParts(date); } catch { parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(date); }
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  const after = (type) => { const i = parts.findIndex((p) => p.type === type); const next = i >= 0 ? parts[i + 1] : null; return next?.type === 'literal' && next.value.trim() ? next.value : ':'; };
  const sep = after('hour');
  let h = get('hour');
  if (hours === '12') h = String(Number(h) || 12);
  const m = get('minute');
  const s = seconds ? get('second') : '';
  return { h, m, s, sep, ssep: s ? after('minute') : '', text: `${h}${sep}${m}${s ? `${after('minute')}${s}` : ''}` };
}

const api = { CLOCK_STYLES, CLOCK_HOURS, CLOCK_CARDS, GREETING_FONTS, DEFAULTS, cleanStyle, cleanHours, cleanCard, cleanGreetingFont, greetingFontFor, clean, clockParts };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.ClockStyles = api;
})();
