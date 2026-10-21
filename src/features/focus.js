// Focus mode: for a homework session, the sites that pull you away are blocked until the timer ends.
//
// Off until the user starts it (the toolbar button, "focus for 90 minutes" in the chat, or a schedule in Settings). While it is on, a
// page of a listed site (Settings → General → Focus mode; the default list is video, social and streaming sites) is stopped before it
// loads and the tab shows renderer/focus-block.html instead: the time left, "I need this for school" (that site, ten minutes, written to
// the focus log) and "End focus" (held down for ten seconds, so it takes a decision rather than a click).
//
// Blocking uses the same place Safe Browsing does: main.js's main-frame gate (session.webRequest.onBeforeRequest, for pages only) asks
// gate() first. gate() cancels the load; the tab's did-fail-load then asks blockPage() for the block page's address (the Safe Browsing
// warning's way). Nothing here loads at start-up unless a focus session or a schedule exists (main.js startFocus); the pure helpers
// (matching, schedules, phrases) are exported for test/units/focus-units.js.
//
// Schedules ("weekdays 7-9 pm") reuse routines.js's calendar math: a schedule's start is the routine rule { weekly, days, time }, and it
// stays on for its length. Everything time-, disk- and Electron-related is injected into create().
const fs = require('fs');
const path = require('path');

const DEFAULT_SITES = ['youtube.com', 'youtu.be', 'reddit.com', 'tiktok.com', 'instagram.com', 'x.com', 'twitter.com', 'facebook.com', 'twitch.tv', 'netflix.com'];
const MINUTE = 60000;
const ALLOW_MS = 10 * MINUTE; // "I need this for school": one site, this long
const HOLD_MS = 10000; // End focus: held this long
const HOLD_SLACK_MS = 250; // (the page's timer and the clock here are read a moment apart)
const MIN_MINUTES = 1;
const MAX_MINUTES = 12 * 60;
const MAX_SLEEP_MS = 60 * MINUTE; // never sleeps longer: a changed clock or time zone is noticed within the hour
const BLOCK_AGE_MS = 60000; // a cancelled load is turned into the block page within this
const LIMITS = { sites: 200, schedules: 20, log: 200 };
const LOG_TYPES = ['start', 'end', 'allow'];

const routines = () => require('./routines'); // (calendar math; loaded when a schedule is first looked at)

// ---- sites

// A host name the user typed or pasted ("https://www.YouTube.com/watch?v=1" -> "youtube.com"); '' when it is not one.
function cleanSite(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
  return s.length <= 253 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(s) ? s : '';
}
// null when it is not a list (the setting keeps what it had).
function cleanSites(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.map(cleanSite).filter(Boolean))].slice(0, LIMITS.sites);
}
// The listed entry a host belongs to (the site and every subdomain of it), or null. "x.com" never matches "dropbox.com".
function matchSite(host, sites) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || !sites?.length) return null;
  for (const site of sites) if (h === site || h.endsWith(`.${site}`)) return site;
  return null;
}
// The host of an http(s) address, else ''.
function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase().replace(/\.$/, '') : '';
  } catch { return ''; }
}

// ---- schedules: { id, days: [0-6, 0 = Sunday], from: 'HH:MM', to: 'HH:MM', on }. A window may cross midnight ("22:00" to "01:00").

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
function cleanTime(value) {
  const m = TIME_RE.exec(String(value ?? '').trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}
const minutesOf = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const lengthOf = (s) => ((minutesOf(s.to) - minutesOf(s.from) + 1440) % 1440) * MINUTE;

function cleanSchedule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const days = [...new Set((Array.isArray(raw.days) ? raw.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
  const from = cleanTime(raw.from);
  const to = cleanTime(raw.to);
  if (!days.length || !from || !to || from === to) return null;
  const id = /^[A-Za-z0-9_-]{1,40}$/.test(String(raw.id ?? '')) ? String(raw.id) : `s${Math.random().toString(36).slice(2, 10)}`;
  return { id, days, from, to, on: raw.on !== false };
}
function cleanSchedules(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const s = cleanSchedule(raw);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
    if (out.length >= LIMITS.schedules) break;
  }
  return out;
}
const ruleOf = (s) => ({ type: 'routine', repeat: 'weekly', days: s.days, time: s.from });

// The schedule window that contains `now` ({ start, end, id }; the one that ends last when several do), or null.
function windowAt(schedules, now) {
  let best = null;
  for (const s of schedules || []) {
    if (s.on === false) continue;
    const length = lengthOf(s);
    const start = routines().nextOccurrence(ruleOf(s), now - length); // the first start after (now - length): it is on now when that is already past
    if (start !== null && start <= now && (!best || start + length > best.end)) best = { start, end: start + length, id: s.id };
  }
  return best;
}
// When the next schedule window starts after `now`, or null.
function nextStart(schedules, now) {
  let best = null;
  for (const s of schedules || []) {
    if (s.on === false) continue;
    const at = routines().nextOccurrence(ruleOf(s), now);
    if (at !== null && (best === null || at < best)) best = at;
  }
  return best;
}

// "weekdays 7-9 pm", "mon, wed and fri 4:30 to 6", "daily 19:00-21:00": { days, from, to } or null. A missing am/pm is taken from the other
// end ("7-9 pm" is 19:00 to 21:00, "11-1 pm" is 11:00 to 13:00); with neither, the clock is 24-hour.
const DAY_WORDS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }; // (by the first three letters)
const DAY_RE = '(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*';
const PHRASE_RE = new RegExp(`^(?:every\\s+)?(weekdays?|week\\s*days?|work\\s*days?|weekends?|daily|every\\s*day|each\\s*day|${DAY_RE}(?:\\s*(?:,|and|&)\\s*${DAY_RE})*)\\s+(?:from\\s+|between\\s+|at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?\\s*(?:-|to|until|till|and)\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?$`, 'i');
function parseSchedulePhrase(text) {
  const m = PHRASE_RE.exec(String(text || '').trim().replace(/[–—]/g, '-'));
  if (!m) return null;
  const word = m[1].toLowerCase().replace(/\s+/g, '');
  let days;
  if (/^(week|work)days?$/.test(word)) days = [1, 2, 3, 4, 5];
  else if (/^weekends?$/.test(word)) days = [0, 6];
  else if (/^(daily|everyday|eachday)$/.test(word)) days = [0, 1, 2, 3, 4, 5, 6];
  else {
    days = [...new Set(m[1].toLowerCase().split(/\s*(?:,|and|&)\s*/).map((w) => DAY_WORDS[w.slice(0, 3)]))].sort((a, b) => a - b);
  }
  const mer = (x) => (x ? x.toLowerCase().replace(/\./g, '') : '');
  const clock = (h, min, ap) => {
    h = Number(h);
    min = Number(min || 0);
    if (min > 59) return null;
    if (ap) { if (h < 1 || h > 12) return null; h = (h % 12) + (ap === 'pm' ? 12 : 0); }
    return h > 23 ? null : h * 60 + min;
  };
  const a = mer(m[4]);
  const b = mer(m[7]);
  const opposite = (x) => (x === 'am' ? 'pm' : 'am');
  let from;
  let to;
  if (a && b) { from = clock(m[2], m[3], a); to = clock(m[5], m[6], b); }
  else if (!a && !b) { from = clock(m[2], m[3], ''); to = clock(m[5], m[6], ''); }
  else if (b) { // "7-9 pm"
    to = clock(m[5], m[6], b);
    from = clock(m[2], m[3], b);
    if (from !== null && to !== null && from >= to) from = clock(m[2], m[3], opposite(b)); // "11-1 pm"
  } else { // "9 am-12"
    from = clock(m[2], m[3], a);
    to = clock(m[5], m[6], a);
    if (from !== null && to !== null && from >= to) to = clock(m[5], m[6], opposite(a));
  }
  if (from === null || to === null || from === to) return null;
  const hhmm = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  return { days, from: hhmm(from), to: hhmm(to) };
}

// ---- the controller

function create(deps) {
  const now = deps.now || Date.now;
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  const holdMs = deps.holdMs ?? HOLD_MS;
  const sessionFile = path.join(deps.dir, 'focus-session.json'); // exists only while a started session is on
  const logFile = path.join(deps.dir, 'focus-log.json');

  let manual = null; // { start, end }: started by the user
  let skipUntil = 0; // a schedule window the user ended early stays off until its end
  const allows = new Map(); // listed site -> the time its ten minutes end
  const blocked = new Map(); // web contents id -> { url, site, at }: a load gate() cancelled
  let holdAt = 0; // End focus: when the hold began (0: none)
  let current = { active: false, source: null, start: 0, end: 0, window: null }; // what is on now
  let timer = null;
  let stopped = false;

  try {
    const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    if (Number.isFinite(saved?.end) && saved.end > now()) manual = { start: Number(saved.start) || now(), end: Number(saved.end) };
    else fs.rmSync(sessionFile, { force: true });
  } catch { /* none, or unreadable: no session */ }

  const sites = () => {
    const stored = deps.readSettings().focusSites;
    return stored === undefined ? DEFAULT_SITES : cleanSites(stored) || DEFAULT_SITES;
  };
  const schedules = () => cleanSchedules(deps.readSettings().focusSchedules) || [];

  // ---- the log: what started, what ended and why, and every "I need this for school" (the host, never the address)
  function log(type, fields) {
    if (!LOG_TYPES.includes(type)) return;
    try {
      let list = [];
      try { list = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch { /* none yet */ }
      if (!Array.isArray(list)) list = [];
      list.push({ at: now(), type, ...fields });
      fs.mkdirSync(deps.dir, { recursive: true });
      fs.writeFileSync(logFile, JSON.stringify(list.slice(-LIMITS.log)));
    } catch { /* a note that can't be kept is not a reason to stop */ }
  }
  function readLog() {
    try { const list = JSON.parse(fs.readFileSync(logFile, 'utf8')); return Array.isArray(list) ? list : []; } catch { return []; }
  }

  // ---- what is on now
  function compute() {
    const t = now();
    if (manual && manual.end <= t) { manual = null; try { fs.rmSync(sessionFile, { force: true }); } catch { /* gone */ } }
    for (const [site, until] of allows) if (until <= t) allows.delete(site);
    if (manual) return { active: true, source: 'manual', start: manual.start, end: manual.end, window: null };
    const w = windowAt(schedules(), t);
    if (w && w.end > skipUntil) return { active: true, source: 'schedule', start: w.start, end: w.end, window: w };
    return { active: false, source: null, start: 0, end: 0, window: null };
  }
  const keyOf = (c) => (c.active ? `${c.source}:${c.start}` : '');

  function refresh({ quiet = false } = {}) {
    if (stopped) return current;
    const before = current;
    current = compute();
    if (keyOf(before) !== keyOf(current)) {
      if (before.active) log('end', { source: before.source, minutes: Math.round((Math.min(now(), before.end) - before.start) / MINUTE), how: now() >= before.end ? 'finished' : 'changed' });
      if (current.active) { log('start', { source: current.source, minutes: Math.round((current.end - now()) / MINUTE) }); enforce(); }
    }
    arm();
    if (!quiet) broadcast();
    return current;
  }

  function arm() {
    clearTimer(timer);
    timer = null;
    if (stopped) return;
    const t = now();
    const wake = [t + MAX_SLEEP_MS];
    if (current.active) wake.push(current.end);
    for (const until of allows.values()) wake.push(until);
    if (schedules().length) { const next = nextStart(schedules(), t); if (next !== null) wake.push(next); }
    const at = Math.min(...wake);
    timer = setTimer(() => { timer = null; refresh(); }, Math.max(250, at - t + 50));
    timer?.unref?.();
  }

  function state() {
    const c = current.active && now() >= current.end ? refresh({ quiet: true }) : current;
    const t = now();
    return {
      active: c.active, source: c.source, start: c.start, until: c.end, remainingMs: c.active ? Math.max(0, c.end - t) : 0,
      holdMs, allowMs: ALLOW_MS,
      allows: [...allows].filter(([, until]) => until > t).map(([site, until]) => ({ site, until })),
      next: c.active ? null : nextStart(schedules(), t),
    };
  }
  const broadcast = () => { try { deps.broadcast?.(state()); } catch { /* no window to tell */ } };

  // ---- the gate
  const allowed = (site) => (allows.get(site) || 0) > now();

  // session.webRequest.onBeforeRequest for pages (main.js calls it first). Returns true when it answered the request.
  function gate(details, callback) {
    if (stopped || !current.active) return false;
    if (now() >= current.end) { refresh(); if (!current.active) return false; }
    const site = matchSite(hostOf(details.url), sites());
    if (!site || allowed(site)) return false;
    const wc = details.webContents;
    if (!wc || wc.isDestroyed() || !deps.isTab(wc)) return false; // (the AI's hidden reader tabs are not the user's distraction)
    blocked.set(wc.id, { url: details.url, site, at: now() });
    callback({ cancel: true });
    return true;
  }
  const pageFor = (url, site) => `${deps.pageUrl}?${new URLSearchParams({ url, site })}`;
  // did-fail-load of a tab: the block page's address when gate() cancelled the load.
  function blockPage(wc, failedUrl, code) {
    const b = blocked.get(wc.id);
    if (!b || code !== -20 /* ERR_BLOCKED_BY_CLIENT */ || now() - b.at > BLOCK_AGE_MS) return null;
    blocked.delete(wc.id);
    return pageFor(b.url, b.site);
  }
  // Tabs already on a listed site when focus starts (or a ten minutes end) go to the block page too.
  function enforce() {
    if (!current.active) return;
    const list = sites();
    for (const wc of deps.tabContents?.() || []) {
      try {
        if (wc.isDestroyed()) continue;
        const url = wc.getURL();
        const site = matchSite(hostOf(url), list);
        if (site && !allowed(site)) wc.loadURL(pageFor(url, site)).catch(() => {});
      } catch { /* the tab went away */ }
    }
  }

  // ---- what the user does
  function start(minutes) {
    const n = Math.round(Number(minutes));
    if (!Number.isFinite(n) || n < MIN_MINUTES || n > MAX_MINUTES) throw new Error(`Pick between ${MIN_MINUTES} minute and ${MAX_MINUTES / 60} hours.`);
    const t = now();
    manual = { start: t, end: t + n * MINUTE };
    skipUntil = 0;
    allows.clear();
    holdAt = 0;
    try { fs.mkdirSync(deps.dir, { recursive: true }); fs.writeFileSync(sessionFile, JSON.stringify(manual)); } catch { /* the session still runs; it just won't survive a restart */ }
    current = { active: false, source: null, start: 0, end: 0, window: null }; // (so refresh() sees a new session and logs it)
    refresh();
    return state();
  }
  // More time on a started session.
  function extend(minutes) {
    const n = Math.round(Number(minutes));
    if (!manual || !Number.isFinite(n) || n < 1 || n > MAX_MINUTES) return state();
    manual.end = Math.min(manual.end + n * MINUTE, now() + MAX_MINUTES * MINUTE);
    try { fs.writeFileSync(sessionFile, JSON.stringify(manual)); } catch { /* as above */ }
    refresh();
    return state();
  }
  // "I need this for school": that listed site opens for ten minutes. `url` is the blocked page's address.
  function allow(url) {
    if (!current.active) return { ok: false };
    const site = matchSite(hostOf(url), sites());
    if (!site) return { ok: false };
    const until = now() + ALLOW_MS;
    allows.set(site, until);
    log('allow', { site, minutes: ALLOW_MS / MINUTE });
    arm();
    broadcast();
    return { ok: true, site, until };
  }
  // End focus is a hold: begin when the press starts, confirm when ten seconds later the page says it is still held.
  function endBegin() { if (current.active) holdAt = now(); return { holdMs }; }
  function endCancel() { holdAt = 0; }
  function endConfirm() {
    if (!current.active || !holdAt || now() - holdAt < holdMs - HOLD_SLACK_MS) { holdAt = 0; return { ok: false, state: state() }; }
    holdAt = 0;
    const was = current;
    if (manual) { manual = null; try { fs.rmSync(sessionFile, { force: true }); } catch { /* gone */ } }
    const window = was.window || windowAt(schedules(), now()); // (a schedule window that is on stays off until its end)
    if (window) skipUntil = Math.max(skipUntil, window.end);
    allows.clear();
    log('end', { source: was.source, minutes: Math.round((now() - was.start) / MINUTE), how: 'early' });
    current = { active: false, source: null, start: 0, end: 0, window: null }; // (the end is logged above)
    refresh();
    return { ok: true, state: state() };
  }

  // The toolbar button's menu (a native menu: main.js pops it up). `t` is the string lookup.
  function menuTemplate({ t, openStatus, openSettings }) {
    const s = state();
    const label = (m) => (m % 60 === 0 ? t(m === 60 ? 'focus.dur.hour' : 'focus.dur.hours', { n: m / 60 }) : t('focus.dur.minutes', { n: m }));
    if (s.active) {
      return [
        { label: t('focus.menu.on', { left: durationText(s.remainingMs, t) }), enabled: false },
        ...(s.source === 'manual' ? [{ label: t('focus.menu.add', { n: 15 }), click: () => extend(15) }] : []),
        { label: t('focus.menu.end'), click: openStatus },
        { type: 'separator' },
        { label: t('focus.menu.settings'), click: openSettings },
      ];
    }
    return [
      { label: t('focus.menu.start'), enabled: false },
      ...[25, 45, 60, 90, 120, 180].map((m) => ({ label: label(m), click: () => start(m) })),
      { type: 'separator' },
      { label: t('focus.menu.settings'), click: openSettings },
    ];
  }

  function stop() { stopped = true; clearTimer(timer); timer = null; }
  current = compute();
  arm();

  return {
    gate, blockPage, enforce, start, extend, allow, endBegin, endCancel, endConfirm, state, refresh, menuTemplate, log: readLog,
    sites, schedules, settingsChanged: () => { refresh(); enforce(); }, pageFor, stop,
    statusUrl: () => `${deps.pageUrl}?status=1`,
  };
}

// "1 h 12 min", "25 min", "40 s" for a menu.
function durationText(ms, t) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h) return t('focus.left.hm', { h, m });
  if (m) return t('focus.left.m', { m: total % 60 >= 30 ? m + 1 : m });
  return t('focus.left.s', { s: total });
}

module.exports = {
  DEFAULT_SITES, ALLOW_MS, HOLD_MS, MIN_MINUTES, MAX_MINUTES, LIMITS,
  cleanSite, cleanSites, matchSite, hostOf, cleanTime, cleanSchedule, cleanSchedules, windowAt, nextStart, parseSchedulePhrase, durationText, create,
};
