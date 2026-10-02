// The home page's own widget editor, the parts with no DOM and no Electron (renderer/newtab-setup.js draws
// the forms; features/widgets.js stores what comes of them; test/widget-config-units.js covers this file):
//   - view(w): what the page may see of a Weather, World clock, Calendar or Feed card's settings. Place
//     names, units, clock; never a calendar's address (it is often a private link), only its host.
//   - mergeEdit(prev, cfg): the form's few fields laid over the card's saved settings, as the input
//     Settings' own save (cleanInput -> the connector's resolve) checks. Whatever the form does not show
//     (a weather card's wind unit, forecast days, nicknames) stays as it was.
//   - cleanLook(k, v): one clock-and-greeting choice (do=look) -> { key, value } for the Settings store, or null.
// Every value is checked here again; the page's checks are for the person, these are for safety.
'use strict';

const WS = require('./widget-system');
const CS = require('./clock-styles');
const WX = require('./weather-view');
const WCK = require('./worldclock-view');
const FEED = require('./feed');
const MK = require('./markets-view');
const CAL = require('./calendar-sources');

const KINDS = ['weather', 'worldclock', 'calendar', 'feed', 'crypto']; // the kinds that merge into what is saved (the others are the whole form)
const CLOCKS = ['auto', '12', '24'];
const MAX_CITY = 80;
const MAX_URL = 2000;

const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const flat = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
// An https address (webcal:// counts as https), or null. No credentials, spaces or quotes; http:// is refused.
function secureUrl(value, { allowWebcal = false } = {}) {
  let text = typeof value === 'string' ? value.trim() : '';
  if (allowWebcal) text = text.replace(/^webcals?:\/\//i, 'https://');
  if (!/^https:\/\//i.test(text) || text.length > MAX_URL || /[\s"'<>\\]/.test(text)) return null;
  try {
    const u = new URL(text);
    return u.protocol === 'https:' && u.hostname && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}
// Positions of the places the form dropped: whole numbers, each once, as many as a card has at most.
function cleanDrop(list, count) {
  const out = [];
  for (const i of Array.isArray(list) ? list : []) if (Number.isInteger(i) && i >= 0 && i < count && !out.includes(i)) out.push(i);
  return out;
}
const placeNames = (places, label) => places.map((p) => (p.here ? p.nick || 'My location' : label(p)));

// ---- what the page sees ----
function view(w) {
  if (!w || typeof w !== 'object') return {};
  if (w.type === 'weather') return { units: w.wx.units, clock: w.wx.clock, places: placeNames(w.wx.places, WX.placeLabel) };
  if (w.type === 'worldclock') return { clock: w.wc.clock, seconds: w.wc.seconds, places: placeNames(w.wc.places, WCK.placeLabel) };
  if (w.type === 'calendar') return { host: hostOf(w.url), count: w.count, cals: CAL.sourcesOf(w).map((s) => ({ id: s.id, name: s.name, host: hostOf(s.url), color: s.color, enabled: s.enabled })) };
  if (w.type === 'feed') return { feed: w.preset || '', url: w.preset ? '' : w.url, count: w.count };
  if (w.type === 'crypto') return { coins: (w.mk?.coins || []).map((c) => ({ id: c.id, sym: c.sym })) };
  return {};
}

// ---- what the form sent, over what is saved ----
// A new card (prev null) has only what the form sent. `append` tells a connector's resolve that a typed
// city is added to the places rather than replacing them (Settings' own form never sends it).
function mergeEdit(prev, cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const base = { type: c.type, title: flat(c.title, 60), ...(prev?.colors ? { colors: prev.colors } : {}) }; // an edit keeps the card's colours
  const city = flat(c.city, MAX_CITY);
  if (c.type === 'weather') {
    const have = prev?.wx ? prev.wx.places : [];
    const keep = have.filter((_, i) => !cleanDrop(c.drop, have.length).includes(i));
    return { ...base, city, units: pick(c.units, ['f', 'c'], prev?.wx?.units || 'f'), wx: { ...(prev?.wx || {}), places: keep, units: pick(c.units, ['f', 'c'], prev?.wx?.units || 'f'), clock: pick(c.clock, CLOCKS, prev?.wx?.clock || 'auto'), append: true } };
  }
  if (c.type === 'worldclock') {
    const have = prev?.wc ? prev.wc.places : [];
    const keep = have.filter((_, i) => !cleanDrop(c.drop, have.length).includes(i));
    return { ...base, city, wc: { ...(prev?.wc || {}), places: keep, clock: pick(c.clock, CLOCKS, prev?.wc?.clock || 'auto'), seconds: c.seconds === true, append: true } };
  }
  if (c.type === 'calendar') {
    // The form lists the calendars it wants, in order: { keep (its place in the saved list, or -1 for a new one), name, color, enabled, url }.
    // A saved calendar's address is never sent (the page never saw it): an empty one keeps it. A typed one must be https or webcal.
    if (Array.isArray(c.cals)) {
      const had = prev ? CAL.sourcesOf(prev) : [];
      const cals = c.cals.slice(0, CAL.MAX_SOURCES + 1).filter((r) => r && typeof r === 'object').map((r) => {
        const old = Number.isInteger(r.keep) && r.keep >= 0 ? had[r.keep] : null;
        const typed = typeof r.url === 'string' ? r.url.trim() : '';
        const url = typed ? secureUrl(typed, { allowWebcal: true }) || typed.slice(0, MAX_URL) : old ? old.url : '';
        return { name: flat(r.name, CAL.MAX_NAME), url, color: CAL.cleanColor(r.color), enabled: r.enabled !== false };
      });
      return { ...base, cals, url: cals[0]?.url || '', count: clampCount(c.count, 3, 8, prev?.count || 5) };
    }
    // The older form (one address): over the first calendar, the rest stay.
    const typed = typeof c.url === 'string' ? c.url.trim() : '';
    const url = typed ? secureUrl(typed, { allowWebcal: true }) : prev?.url || '';
    const rest = prev ? CAL.sourcesOf(prev) : [];
    const first = url || typed.slice(0, MAX_URL);
    return { ...base, url: first, ...(rest.length > 1 ? { cals: [{ ...rest[0], url: first }, ...rest.slice(1)] } : {}), count: clampCount(c.count, 3, 8, prev?.count || 5) };
  }
  if (c.type === 'feed') {
    const preset = FEED.presetFor(c.feed);
    return { ...base, feed: preset ? preset.id : '', url: preset ? '' : typeof c.url === 'string' ? c.url.trim().slice(0, MAX_URL) : '', count: clampCount(c.count, 3, 12, prev?.count || 8) };
  }
  if (c.type === 'crypto') {
    const have = prev?.mk ? prev.mk.coins : [];
    const gone = cleanDrop(c.drop, have.length);
    const keep = have.filter((_, i) => !gone.includes(i));
    const added = coinTokens(c.add);
    const coins = MK.cleanCoins([...keep, ...added], MK.MAX_COINS);
    const keptIds = new Set(keep.map((k) => k.id));
    return { ...base, mk: { coins, added: coins.filter((k) => !keptIds.has(k.id)).map((k) => k.id) } };
  }
  return { ...c, ...base };
}
// "bitcoin, solana=SOL" -> ['bitcoin', 'solana=SOL'] (at most 40 pieces: anything past that is not a coin list).
const coinTokens = (v) => (typeof v === 'string' ? v.split(/[\s,;]+/).filter(Boolean).slice(0, 40) : []);
const coinIdOf = (t) => String(t).split('=')[0].toLowerCase();

// What is wrong with the form's input before anything is looked up or saved: a sentence, or '' when it is fine.
// The page checks the same things so the person hears at once (Save disabled); this is the check that counts.
function checkEdit(prev, cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  if (c.type === 'weather' || c.type === 'worldclock') {
    const have = (c.type === 'weather' ? prev?.wx?.places : prev?.wc?.places) || [];
    const left = have.length - cleanDrop(c.drop, have.length).length;
    if (prev && have.length && left === 0 && !flat(c.city, MAX_CITY)) return 'Keep at least one place, or type a city to put in its place.';
  }
  if (c.type === 'calendar' && Array.isArray(c.cals)) {
    const had = prev ? CAL.sourcesOf(prev) : [];
    const rows = c.cals.filter((r) => r && typeof r === 'object');
    if (!rows.length) return 'Add at least one calendar.';
    if (rows.length > CAL.MAX_SOURCES) return `Up to ${CAL.MAX_SOURCES} calendars.`;
    for (const [i, r] of rows.entries()) {
      const label = flat(r.name, CAL.MAX_NAME) || `Calendar ${i + 1}`;
      const typed = typeof r.url === 'string' ? r.url.trim() : '';
      const known = !typed && Number.isInteger(r.keep) && r.keep >= 0 && had[r.keep];
      if (typed ? !secureUrl(typed, { allowWebcal: true }) : !known) return typed ? `${label} needs an https:// or webcal:// address.` : `Paste an address for ${label}.`;
    }
    if (rows.every((r) => r.enabled === false)) return 'Turn on at least one calendar.';
  }
  if (c.type === 'crypto') {
    const have = prev?.mk ? prev.mk.coins : [];
    const gone = cleanDrop(c.drop, have.length);
    const bad = coinTokens(c.add).filter((t) => !MK.COIN_RE.test(coinIdOf(t)));
    if (bad.length) return `“${flat(bad[0].split('=')[0], 40)}” isn’t a CoinGecko id. Use ids like bitcoin, ethereum or solana (the end of the coin page’s address).`;
    const all = MK.cleanCoins([...have.filter((_, i) => !gone.includes(i)), ...coinTokens(c.add)], 100);
    if (!all.length) return 'Keep at least one coin.';
    if (all.length > MK.MAX_COINS) return `Up to ${MK.MAX_COINS} coins.`;
  }
  return '';
}
// A calendar edit that leaves the address alone (empty, or the saved one typed again) changes only what is
// stored here: no reason to fetch the calendar, so it works offline too.
function keepsAddress(prev, cfg) {
  if (!prev || prev.type !== 'calendar' || !cfg || cfg.type !== 'calendar') return false;
  const had = CAL.sourcesOf(prev);
  if (!had.length) return false;
  if (Array.isArray(cfg.cals)) { // every calendar of the form is one the card already has
    const urls = new Set(had.map((s) => s.url));
    return cfg.cals.length > 0 && cfg.cals.every((r) => {
      const t = r && typeof r.url === 'string' ? r.url.trim() : '';
      return t ? urls.has(secureUrl(t, { allowWebcal: true })) : Boolean(r) && Number.isInteger(r.keep) && r.keep >= 0 && r.keep < had.length;
    });
  }
  if (!prev.url) return false;
  const typed = typeof cfg.url === 'string' ? cfg.url.trim() : '';
  return !typed || secureUrl(typed, { allowWebcal: true }) === prev.url;
}
function clampCount(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

// ---- the clock and greeting card (do=look) ----
// k -> { key (the Settings name), clean(v) -> the stored value, or null when the value is not allowed }.
const onOff = (v) => (v === 'on' ? true : v === 'off' ? false : null);
const LOOK = {
  clock: { key: 'newTabClockSize', clean: (v) => WS.cleanClockSize(v) },
  search: { key: 'newTabSearchWidth', clean: (v) => WS.cleanSearchWidth(/^\d{3,4}$/.test(v || '') ? v : null) },
  show: { key: 'newTabClock', clean: onOff },
  hours: { key: 'newTabClockHours', clean: (v) => CS.cleanHours(v) },
  seconds: { key: 'newTabClockSeconds', clean: onOff },
  date: { key: 'newTabClockDate', clean: onOff },
  shadow: { key: 'newTabClockShadow', clean: onOff },
  style: { key: 'newTabClockStyle', clean: (v) => CS.cleanStyle(v) },
  card: { key: 'newTabClockCard', clean: (v) => CS.cleanCard(v) },
  greeting: { key: 'newTabGreetingFont', clean: (v) => CS.cleanGreetingFont(v) },
  name: { key: 'newTabName', clean: (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) : null) }, // empty is allowed: no name
};
// "Reset to defaults" in the clock and greeting panel: the Settings keys it puts back (not the name, size or search width).
const LOOK_DEFAULTS = { newTabClock: true, newTabClockStyle: 'classic', newTabClockHours: 'auto', newTabClockSeconds: false, newTabClockDate: true, newTabClockCard: 'none', newTabClockShadow: false, newTabGreetingFont: 'classic' };
function cleanLook(k, v) {
  if (typeof k !== 'string' || !Object.prototype.hasOwnProperty.call(LOOK, k)) return null;
  const value = LOOK[k].clean(typeof v === 'string' ? v : null);
  return value === null || value === undefined ? null : { key: LOOK[k].key, value };
}

module.exports = { KINDS, LOOK, LOOK_DEFAULTS, view, mergeEdit, checkEdit, keepsAddress, cleanLook, secureUrl };
