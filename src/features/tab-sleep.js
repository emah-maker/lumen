// Tab sleeping's pure decisions (main.js does the Electron parts; test/tab-sleep-units.js runs this).
// Kept here: may this tab be put to sleep, what must the page itself say first, and how does a woken
// tab get its page back (restore the saved back/forward list, or just load the address).
'use strict';

// Why a tab must stay loaded, or null when nothing in `f` says so. `f` is plain facts read by main.js:
// { alive, sleeping, active, settings, closing, unloadAsked, openPopups, agentUsing, aiLock, webPage,
//   loading, audible, fullscreen, devTools, capturing, downloading, grouped, keepAudio, keepTransfers, keepGroups }. Any doubt keeps the tab.
function keepReason(f) {
  if (!f || !f.alive) return 'dead';
  if (f.sleeping) return 'sleeping';
  if (f.active) return 'active';
  if (f.settings) return 'settings';
  if (f.closing || f.unloadAsked) return 'closing';
  if (f.openPopups > 0) return 'popups'; // a sign-in popup talks back to this page
  if (f.agentUsing || f.aiLock) return 'ai';
  if (!f.webPage) return 'internal';
  if (f.loading) return 'loading';
  if (f.audible && f.keepAudio !== false) return 'audio'; // Settings > Tabs > Page unloading: tabs playing sound or video (on by default)
  if (f.downloading && f.keepTransfers !== false) return 'transfer'; // a download still coming in (a chosen upload is the page's own check, below)
  if (f.fullscreen) return 'fullscreen';
  if (f.devTools) return 'devtools';
  if (f.capturing) return 'capturing'; // screen share / camera / recording
  if (f.pinned && f.keepPinned) return 'pinned'; // Settings > Tabs > Memory: pinned tabs never sleep (off by default: they always could)
  if (f.neverSite) return 'site'; // the "Never unload these sites" list
  if (f.grouped && f.keepGroups) return 'group'; // off by default
  return null;
}

// ---- the settings (Settings > Tabs > Memory) and the decision that uses them -------------------------------
// Defaults: unload a tab untouched for 20 minutes (frozen first for 10 of them, so coming back is instant), and any tab
// idle 2 minutes while the computer is short of memory (under 10% free); pinned tabs and the 3 most recently used background
// tabs are kept awake whatever the timer says.
const MODES = ['off', 'idle', 'memory', 'both']; // (the old single choice; the page now has a master switch, a time and a memory level: see normalize)
// Memory-pressure levels: how low free memory may get before tabs unload, and how long a tab must have sat unused for
// that to take it (the least recently used go first). Medium is what Lumen always did (under 10% free, 2 minutes idle).
const PRESSURE_LEVELS = {
  low: { freePercent: 5, idleMs: 5 * 60e3 },
  medium: { freePercent: 10, idleMs: 2 * 60e3 },
  aggressive: { freePercent: 20, idleMs: 60e3 },
};
const PRESSURES = ['off', 'low', 'medium', 'aggressive'];
const ON_RETURN = ['reload', 'placeholder']; // switching to an unloaded tab: load it at once, or show a page with a Reload button
const SOON_MINUTE_CHOICES = [1, 2, 5, 10, 15, 30];
const MAX_AWAKE_LIMIT = 500;
const HOWS = ['unload', 'freeze']; // unload: close the page, reload on return; freeze: keep it in memory, paused
const MINUTE_CHOICES = [5, 15, 20, 30, 60, 120, 240, 480];
const FREE_PERCENT_CHOICES = [5, 10, 15, 20, 25];
const LUMEN_GB_CHOICES = [0, 1, 2, 3, 4, 6, 8]; // 0: no limit on Lumen's own use
const MAX_AWAKE_CHOICES = [0, 2, 3, 4, 5, 6, 8, 10, 15, 20]; // 0: no limit (Performance mode may still set one)
const KEEP_RECENT_CHOICES = [0, 1, 2, 3, 4, 5, 8]; // the most recently used background tabs kept awake whatever the idle timer says; 0: none
const MAX_MINUTES = 7 * 24 * 60;
const MEMORY_IDLE_MS = 2 * 60 * 1000; // under memory pressure a tab idle this long may sleep
const NEW_TAB_IDLE_MS = 10 * 60 * 1000; // a new-tab page left in the background this long unloads (whatever the idle setting says: it holds nothing and is rebuilt in a moment)
const DEFAULTS = {
  tabSleepMode: 'both', tabSleepMinutes: 20, tabSleepHow: 'unload', tabSleepFreePercent: 10, tabSleepLumenGb: 0, tabSleepMaxAwake: 0, tabSleepKeepPinned: true, tabSleepKeepRecent: 3, tabSleepNever: [], tabSleepFreezeFirstMinutes: 10,
  tabSleepPressure: 'medium', tabSleepKeepAudio: true, tabSleepKeepForms: true, tabSleepKeepTransfers: true, tabSleepKeepGroups: false,
  tabSleepSoon: [], tabSleepSoonMinutes: 5, tabSleepDim: true, tabSleepShowFreed: true, tabSleepOnReturn: 'reload',
};
// Every setting of the section (the master switch included), for "Reset to defaults".
const KEYS = ['tabSleep', ...Object.keys(DEFAULTS), 'tabPreload'];

const cleanMinutes = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 1 && n <= MAX_MINUTES ? n : null; };
// "Unload after": a number of minutes, or 0 for Never (no idle timer; memory pressure, the cap and the site list still apply).
const cleanAfter = (v) => (Number(v) === 0 && v !== '' && v !== null ? 0 : cleanMinutes(v));
const cleanMaxAwake = (v) => { const n = Math.round(Number(v)); return v !== '' && v !== null && Number.isFinite(n) && n >= 0 && n <= MAX_AWAKE_LIMIT ? n : null; };
// A site as typed (an address or a bare host) -> its host without "www.", or '' when it isn't one.
function cleanHost(v) {
  let h = String(v ?? '').trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h) && h.length <= 253 ? h : '';
}
// A site pattern: a host as above (it also matches its subdomains), or one with * in it (*.example.com: any subdomain of it;
// mail.*: that name on any domain; *.google.*).
function cleanPattern(v) {
  const h = String(v ?? '').trim().toLowerCase();
  if (!h.includes('*')) return cleanHost(h);
  const p = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
  return /^[a-z0-9*]([a-z0-9.*-]*[a-z0-9*])?$/.test(p) && /[a-z0-9]/.test(p) && p.length <= 253 ? p.replace(/\*{2,}/g, '*') : '';
}
const cleanHosts = (v) => (Array.isArray(v) ? [...new Set(v.map(cleanPattern).filter(Boolean))].slice(0, 200) : null);
// The sleep settings out of a settings object, each invalid or missing one at its default. The old on/off switch
// (tabSleep: false) still turns it all off.
function normalize(raw = {}) {
  const r = raw || {};
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  const num = (v, list, d) => (list.includes(Number(v)) ? Number(v) : d);
  const master = r.tabSleep !== false && r.tabSleepMode !== 'off'; // (the old Off choice still counts)
  const minutes = cleanAfter(r.tabSleepMinutes) ?? DEFAULTS.tabSleepMinutes; // 0: Never
  // The memory level: chosen on the page, or (a profile from before it existed) worked out from the old single choice.
  let pressure = PRESSURES.includes(r.tabSleepPressure) ? r.tabSleepPressure : null;
  let freePercent = num(r.tabSleepFreePercent, FREE_PERCENT_CHOICES, DEFAULTS.tabSleepFreePercent);
  const legacyMode = pick(r.tabSleepMode, MODES, DEFAULTS.tabSleepMode);
  const chosen = Boolean(pressure);
  let useIdle;
  let useMemory;
  if (pressure) {
    freePercent = pressure === 'off' ? DEFAULTS.tabSleepFreePercent : PRESSURE_LEVELS[pressure].freePercent;
    useIdle = minutes > 0;
    useMemory = pressure !== 'off';
  } else {
    useIdle = (legacyMode === 'idle' || legacyMode === 'both') && minutes > 0;
    useMemory = legacyMode === 'memory' || legacyMode === 'both';
    pressure = !useMemory ? 'off' : freePercent <= 5 ? 'low' : freePercent <= 10 ? 'medium' : 'aggressive';
  }
  const mode = !master ? 'off' : useIdle && useMemory ? 'both' : useMemory ? 'memory' : 'idle'; // (idle with nothing to time still lets the cap and the site list work)
  return {
    master,
    explicit: chosen, // the memory level was chosen on the page (not worked out from the old single choice)
    mode,
    useIdle,
    useMemory,
    pressure,
    memoryIdleMs: chosen && PRESSURE_LEVELS[pressure] ? PRESSURE_LEVELS[pressure].idleMs : MEMORY_IDLE_MS,
    minutes,
    how: pick(r.tabSleepHow, HOWS, DEFAULTS.tabSleepHow),
    freePercent,
    lumenGb: num(r.tabSleepLumenGb, LUMEN_GB_CHOICES, DEFAULTS.tabSleepLumenGb),
    maxAwake: cleanMaxAwake(r.tabSleepMaxAwake) ?? DEFAULTS.tabSleepMaxAwake,
    keepPinned: r.tabSleepKeepPinned !== false,
    keepRecent: num(r.tabSleepKeepRecent, KEEP_RECENT_CHOICES, DEFAULTS.tabSleepKeepRecent),
    keepAudio: r.tabSleepKeepAudio !== false,
    keepForms: r.tabSleepKeepForms !== false,
    keepTransfers: r.tabSleepKeepTransfers !== false,
    keepGroups: r.tabSleepKeepGroups === true,
    never: cleanHosts(r.tabSleepNever) || [],
    soon: cleanHosts(r.tabSleepSoon) || [],
    soonMinutes: num(r.tabSleepSoonMinutes, SOON_MINUTE_CHOICES, DEFAULTS.tabSleepSoonMinutes),
    dim: r.tabSleepDim !== false,
    showFreed: r.tabSleepShowFreed !== false,
    onReturn: pick(r.tabSleepOnReturn, ON_RETURN, DEFAULTS.tabSleepOnReturn),
    freezeFirst: require('./tab-wake').cleanFreezeFirst(r.tabSleepFreezeFirstMinutes), // minutes a tab is frozen (instant to wake) before it unloads; 0: unload at once
  };
}

// A profile from before the page had a master switch, a time with Never and a memory level (it had one three-way choice and a free-memory
// percentage): the settings to write so the page shows what it always did, or null when there is nothing to move. Run once at startup.
function migrate(raw) {
  const r = raw || {};
  if (PRESSURES.includes(r.tabSleepPressure) || (r.tabSleepMode === undefined && r.tabSleepFreePercent === undefined && r.tabSleep !== false)) return null;
  const mode = MODES.includes(r.tabSleepMode) ? r.tabSleepMode : DEFAULTS.tabSleepMode;
  const percent = FREE_PERCENT_CHOICES.includes(Number(r.tabSleepFreePercent)) ? Number(r.tabSleepFreePercent) : DEFAULTS.tabSleepFreePercent;
  const level = percent <= 5 ? 'low' : percent <= 10 ? 'medium' : 'aggressive';
  const off = mode === 'off' || r.tabSleep === false;
  return {
    tabSleep: !off,
    tabSleepMode: off ? DEFAULTS.tabSleepMode : mode,
    tabSleepPressure: mode === 'idle' ? 'off' : level,
    ...(mode === 'memory' ? { tabSleepMinutes: 0 } : {}), // memory-only: no idle timer
  };
}

// Does `host` match an entry of the never-sleep list (the site itself or one of its subdomains)?
const globRegex = (p) => new RegExp('^' + p.split('*').map((x) => x.replace(/[.+?^$()|[\]{}\\]/g, '\\$&')).join('.*') + '$');
const hostListed = (host, list) => {
  const h = cleanHost(host);
  return Boolean(h) && (list || []).some((x) => (x.includes('*') ? globRegex(x).test(h) : h === x || h.endsWith('.' + x)));
};

// Is memory low? memory: { totalBytes, freeBytes, lumenBytes, pressure }. `pressure` is the operating system's own
// verdict where it gives one (macOS' pressure level), and then stands in for the free-memory percentage.
function memoryLow(s, memory) {
  const m = memory || {};
  if (m.pressure === true) return true;
  if (typeof m.pressure !== 'boolean' && m.totalBytes > 0 && Number.isFinite(m.freeBytes) && m.freeBytes / m.totalBytes * 100 < s.freePercent) return true;
  return s.lumenGb > 0 && Number.isFinite(m.lumenBytes) && m.lumenBytes > s.lumenGb * 1024 ** 3;
}

// The ids of the `n` most recently used background tabs (not the active one, not asleep, and only tabs the user has
// looked at: `viewedAt` is read when a tab has one). These are the ones the user is likely to go back to next, so the idle
// timer does not take them; memory pressure and the awake cap still can.
function recentTabs(tabs, n) {
  if (!(n > 0)) return new Set();
  return new Set(tabs
    .filter((t) => t.alive !== false && !t.sleeping && !t.active && t.lastActive && (!('viewedAt' in t) || t.viewedAt))
    .sort((a, b) => b.lastActive - a.lastActive)
    .slice(0, n)
    .map((t) => t.id));
}

// Which tabs go to sleep now. tabs: [{ id, lastActive, pinned, audible, host, capturing, aiBusy, active, sleeping, alive?,
// loading?, fullscreen?, devTools?, openPopups?, closing?, settings?, webPage?, ... }] (the facts keepReason reads, too);
// settings: raw Settings values (normalize); now: ms; memory: see memoryLow; limits: { sleepAfterMs, maxLiveBackgroundTabs }
// from Performance mode (a lighter PC sleeps sooner and keeps fewer). -> { sleep: [{ id, why: 'idle' | 'memory' | 'cap' }],
// how, low } least recently used first. The page's own check (typed input, a streaming reply) is still to come, per
// tab, in the caller: `capExcess` says how many of the 'cap' entries are needed (the caller stops at that many).
function decideSleep({ tabs = [], settings = {}, now = Date.now(), memory = null, limits = {} } = {}) {
  const s = normalize(settings);
  const out = { sleep: [], how: s.how, low: false, capExcess: 0 };
  if (s.mode === 'off') return out;
  out.low = s.useMemory && memoryLow(s, memory);
  const perfMs = Number.isFinite(limits.sleepAfterMs) ? limits.sleepAfterMs : Infinity;
  const idleMs = Math.min(s.minutes > 0 ? s.minutes * 60e3 : Infinity, perfMs); // (Never, but Performance mode on: Performance mode's time)
  const newTabMs = Math.min(idleMs, NEW_TAB_IDLE_MS);
  const useIdle = s.useIdle || (s.explicit && s.minutes === 0 && Number.isFinite(perfMs));
  const soonMs = s.soon.length ? Math.min(s.soonMinutes * 60e3, idleMs) : Infinity; // the "unload these sites sooner" timer: shorter than the usual one, never longer
  const facts = (t) => ({
    alive: true, webPage: true, ...t, agentUsing: t.agentUsing || t.aiBusy, keepPinned: s.keepPinned, neverSite: hostListed(t.host, s.never),
    keepAudio: s.keepAudio, keepTransfers: s.keepTransfers, keepGroups: s.keepGroups, grouped: t.grouped ?? Boolean(t.groupId),
  });
  const byAge = [...tabs].sort((a, b) => (a.lastActive || 0) - (b.lastActive || 0));
  const chosen = new Set();
  const recent = recentTabs(tabs, s.keepRecent);
  for (const t of byAge) {
    if (!t.lastActive || keepReason(facts(t))) continue;
    const idle = now - t.lastActive;
    if (t.newTab && idle >= newTabMs) { out.sleep.push({ id: t.id, why: 'idle' }); chosen.add(t.id); } // (a new-tab page: soon, in every mode that sleeps tabs)
    else if (idle >= soonMs && hostListed(t.host, s.soon)) { out.sleep.push({ id: t.id, why: 'site' }); chosen.add(t.id); } // (a listed site: its own shorter timer; the recent-tabs rule does not hold it)
    else if (useIdle && idle >= idleMs && !recent.has(t.id)) { out.sleep.push({ id: t.id, why: 'idle' }); chosen.add(t.id); }
    else if (out.low && idle >= s.memoryIdleMs) { out.sleep.push({ id: t.id, why: 'memory' }); chosen.add(t.id); }
  }
  // Too many background tabs awake: the ones used least recently go first, none used in the last minute.
  const cap = Math.min(s.maxAwake > 0 ? s.maxAwake : Infinity, Number.isFinite(limits.maxLiveBackgroundTabs) ? limits.maxLiveBackgroundTabs : Infinity);
  if (Number.isFinite(cap)) {
    const awake = tabs.filter((t) => t.alive !== false && !t.sleeping && !t.active);
    out.capExcess = Math.max(0, awake.length - chosen.size - cap);
    if (out.capExcess) {
      for (const t of byAge) {
        if (chosen.has(t.id) || !t.lastActive || now - t.lastActive < 60e3 || keepReason(facts(t))) continue;
        out.sleep.push({ id: t.id, why: 'cap' });
      }
    }
  }
  return out;
}

// What the status panel counts (Settings > Tabs > Page unloading): the tabs of one window as facts (sleepFacts, plus `asleep`:
// the page is closed, `frozen`: paused in memory). -> { loaded, unloaded, frozen, exempt, reasons: { audio: 2, ... } }.
// `exempt`: loaded background tabs that would not unload right now (the one in front is not counted), whatever the reason.
function tally(tabs, settings = {}) {
  const s = normalize(settings);
  const out = { loaded: 0, unloaded: 0, frozen: 0, exempt: 0, reasons: {} };
  for (const t of tabs) {
    if (t.closing) continue;
    if (t.asleep) { out.unloaded++; continue; }
    if (t.frozen) { out.frozen++; out.loaded++; continue; }
    out.loaded++;
    if (t.active) continue;
    const why = keepReason({
      alive: true, webPage: true, ...t, sleeping: false, active: false, agentUsing: t.agentUsing || t.aiBusy, keepPinned: s.keepPinned, neverSite: hostListed(t.host, s.never),
      keepAudio: s.keepAudio, keepTransfers: s.keepTransfers, keepGroups: s.keepGroups, grouped: t.grouped ?? Boolean(t.groupId),
    });
    if (why) { out.exempt++; out.reasons[why] = (out.reasons[why] || 0) + 1; }
  }
  return out;
}

// Run in the page (an isolated world, so the page can't see or fake it). Resolves to a reason string
// when this page must not be discarded, else ''. Covers what Chrome's memory saver avoids: typed
// input (a field, a rich-text composer), a reply still streaming in (an AI chat: the page keeps
// changing with no load in progress, or shows a Stop button / busy region), a playing video or audio
// element, a chosen upload. The "still growing" test samples the page's text twice `sampleMs` apart.
function pageBusyScript(sampleMs = 1200) {
  return `(async () => {
    const dirty = (el) => (el.matches('input,textarea') ? !/^(checkbox|radio|button|submit|reset|hidden|file|image|range|color)$/i.test(el.type || '') && el.value !== (el.defaultValue ?? '') : el.isContentEditable && el.textContent.trim() !== '');
    if ([...document.querySelectorAll('input,textarea,[contenteditable=""],[contenteditable=true],[contenteditable=plaintext-only]')].some(dirty)) return 'input';
    if ([...document.querySelectorAll('input[type=file]')].some((el) => el.files && el.files.length)) return 'upload';
    if ([...document.querySelectorAll('video,audio')].some((m) => !m.paused && !m.ended)) return 'media';
    const stop = /^\\s*(stop|stop (generating|streaming|response|responding|answering)|cancel)\\s*$/i;
    const control = [...document.querySelectorAll('button,[role=button]')].find((b) => stop.test(b.getAttribute('aria-label') || '') || stop.test(b.getAttribute('title') || '') || (b.textContent.length < 24 && stop.test(b.textContent)));
    if (control && control.offsetParent !== null) return 'streaming';
    if (document.querySelector('[aria-busy=true]')) return 'busy';
    const size = () => (document.body ? document.body.innerText.length : 0); // growing text = a reply arriving (a ticking clock or rotating ad rarely only grows)
    const before = size();
    await new Promise((r) => setTimeout(r, ${Math.max(0, Math.floor(sampleMs))}));
    return size() > before ? 'changing' : '';
  })()`;
}

// The page's answer (a throw or timeout arrives as undefined) -> keep it awake? Any doubt does.
const pageBusy = (answer) => typeof answer !== 'string' || answer !== '';

const sameAddress = (a, b) => {
  const strip = (u) => String(u || '').split('#')[0].replace(/\/$/, '');
  return strip(a) === strip(b);
};

// How a woken tab gets its page back. `sleepUrl`: the address it slept on (the failed one, when it was
// on an error page); `history`: { entries, index } as navigationHistory gave them; `isError`: is this
// one of Lumen's error/warning pages. Restoring the list brings Back/Forward, scroll and form state,
// but it is only trusted when its current entry really is the page the tab slept on: an entry that is an
// error page, a blank page or another address would bring back the wrong thing (a dead error page, a
// stale in-app route of a single-page site). Otherwise the caller loads `url` (which is also what it
// falls back to when the restore throws).
// -> { restore: null | { entries, index }, url }
function wakePlan({ sleepUrl, history, isError = () => false, fallbackUrl = '' } = {}) {
  const url = sleepUrl || fallbackUrl;
  const entries = Array.isArray(history?.entries) ? history.entries : [];
  const index = Number.isInteger(history?.index) ? history.index : -1;
  const active = entries[index];
  if (!entries.length || !active || typeof active.url !== 'string') return { restore: null, url };
  if (isError(active.url) || /^about:blank/i.test(active.url) || !sameAddress(active.url, url)) return { restore: null, url };
  // Entries that are error pages are dropped (Back would land on a dead page) and the index follows.
  const kept = [];
  let keptIndex = 0;
  entries.forEach((e, i) => {
    if (!e || typeof e.url !== 'string' || !e.url || isError(e.url)) return;
    if (i === index) keptIndex = kept.length;
    kept.push(e);
  });
  return { restore: { entries: kept, index: keptIndex }, url };
}

// Bounds a woken tab's view is given before its page starts loading, so the page lays out at the real
// size on its first frame (a 0x0 view makes a site measure a zero-size viewport and draw tiny or blank
// until the next resize). `full`: the window's content size, for a page in full screen.
function wakeBounds(contentBounds, { fullscreen = false, full = null } = {}) {
  const b = fullscreen && full ? { x: 0, y: 0, ...full } : contentBounds;
  const width = Math.round(Number(b?.width) || 0);
  const height = Math.round(Number(b?.height) || 0);
  return { x: Math.round(Number(b?.x) || 0), y: Math.round(Number(b?.y) || 0), width: width > 1 ? width : 800, height: height > 1 ? height : 600 };
}

module.exports = { migrate, PRESSURE_LEVELS, PRESSURES, ON_RETURN, SOON_MINUTE_CHOICES, MAX_AWAKE_LIMIT, KEYS, cleanAfter, cleanMaxAwake, cleanPattern, tally, MODES, HOWS, MINUTE_CHOICES, FREE_PERCENT_CHOICES, LUMEN_GB_CHOICES, MAX_AWAKE_CHOICES, KEEP_RECENT_CHOICES, MAX_MINUTES, MEMORY_IDLE_MS, NEW_TAB_IDLE_MS, recentTabs, DEFAULTS, normalize, cleanMinutes, cleanHost, cleanHosts, hostListed, memoryLow, decideSleep, keepReason, pageBusyScript, pageBusy, wakePlan, wakeBounds, sameAddress };
