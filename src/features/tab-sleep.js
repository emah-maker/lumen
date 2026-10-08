// Tab sleeping's pure decisions (main.js does the Electron parts; test/tab-sleep-units.js runs this).
// Kept here: may this tab be put to sleep, what must the page itself say first, and how does a woken
// tab get its page back (restore the saved back/forward list, or just load the address).
'use strict';

// Why a tab must stay loaded, or null when nothing in `f` says so. `f` is plain facts read by main.js:
// { alive, sleeping, active, settings, closing, unloadAsked, openPopups, agentUsing, aiLock, webPage,
//   loading, audible, fullscreen, devTools, capturing }. Any doubt keeps the tab.
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
  if (f.audible) return 'audio';
  if (f.fullscreen) return 'fullscreen';
  if (f.devTools) return 'devtools';
  if (f.capturing) return 'capturing'; // screen share / camera / recording
  if (f.pinned && f.keepPinned) return 'pinned'; // Settings > Tabs > Memory: pinned tabs never sleep (off by default: they always could)
  if (f.neverSite) return 'site'; // the "Never sleep these sites" list
  return null;
}

// ---- the settings (Settings > Tabs > Memory) and the decision that uses them -------------------------------
// Defaults are what Lumen did before these were adjustable: unload a tab untouched for 20 minutes, and any tab
// idle 2 minutes while the computer is short of memory (under 10% free), whatever the pinned state.
const MODES = ['off', 'idle', 'memory', 'both'];
const HOWS = ['unload', 'freeze']; // unload: close the page, reload on return; freeze: keep it in memory, paused
const MINUTE_CHOICES = [5, 15, 20, 30, 60, 120, 240, 480];
const FREE_PERCENT_CHOICES = [5, 10, 15, 20, 25];
const LUMEN_GB_CHOICES = [0, 1, 2, 3, 4, 6, 8]; // 0: no limit on Lumen's own use
const MAX_AWAKE_CHOICES = [0, 2, 3, 4, 5, 6, 8, 10, 15, 20]; // 0: no limit (Performance mode may still set one)
const MAX_MINUTES = 7 * 24 * 60;
const MEMORY_IDLE_MS = 2 * 60 * 1000; // under memory pressure a tab idle this long may sleep
const DEFAULTS = { tabSleepMode: 'both', tabSleepMinutes: 20, tabSleepHow: 'unload', tabSleepFreePercent: 10, tabSleepLumenGb: 0, tabSleepMaxAwake: 0, tabSleepKeepPinned: false, tabSleepNever: [], tabSleepFreezeFirstMinutes: 0 };

const cleanMinutes = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 1 && n <= MAX_MINUTES ? n : null; };
// A site as typed (an address or a bare host) -> its host without "www.", or '' when it isn't one.
function cleanHost(v) {
  let h = String(v ?? '').trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h) && h.length <= 253 ? h : '';
}
const cleanHosts = (v) => (Array.isArray(v) ? [...new Set(v.map(cleanHost).filter(Boolean))].slice(0, 200) : null);
// The sleep settings out of a settings object, each invalid or missing one at its default. The old on/off switch
// (tabSleep: false) still turns it all off.
function normalize(raw = {}) {
  const r = raw || {};
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  const num = (v, list, d) => (list.includes(Number(v)) ? Number(v) : d);
  return {
    mode: r.tabSleep === false ? 'off' : pick(r.tabSleepMode, MODES, DEFAULTS.tabSleepMode),
    minutes: cleanMinutes(r.tabSleepMinutes) ?? DEFAULTS.tabSleepMinutes,
    how: pick(r.tabSleepHow, HOWS, DEFAULTS.tabSleepHow),
    freePercent: num(r.tabSleepFreePercent, FREE_PERCENT_CHOICES, DEFAULTS.tabSleepFreePercent),
    lumenGb: num(r.tabSleepLumenGb, LUMEN_GB_CHOICES, DEFAULTS.tabSleepLumenGb),
    maxAwake: num(r.tabSleepMaxAwake, MAX_AWAKE_CHOICES, DEFAULTS.tabSleepMaxAwake),
    keepPinned: r.tabSleepKeepPinned === true,
    never: cleanHosts(r.tabSleepNever) || [],
    freezeFirst: require('./tab-wake').cleanFreezeFirst(r.tabSleepFreezeFirstMinutes), // minutes a tab is frozen (instant to wake) before it unloads; 0: unload at once
  };
}

// Does `host` match an entry of the never-sleep list (the site itself or one of its subdomains)?
const hostListed = (host, list) => {
  const h = cleanHost(host);
  return Boolean(h) && (list || []).some((x) => h === x || h.endsWith(`.${x}`));
};

// Is memory low? memory: { totalBytes, freeBytes, lumenBytes, pressure }. `pressure` is the operating system's own
// verdict where it gives one (macOS' pressure level), and then stands in for the free-memory percentage.
function memoryLow(s, memory) {
  const m = memory || {};
  if (m.pressure === true) return true;
  if (typeof m.pressure !== 'boolean' && m.totalBytes > 0 && Number.isFinite(m.freeBytes) && m.freeBytes / m.totalBytes * 100 < s.freePercent) return true;
  return s.lumenGb > 0 && Number.isFinite(m.lumenBytes) && m.lumenBytes > s.lumenGb * 1024 ** 3;
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
  out.low = (s.mode === 'memory' || s.mode === 'both') && memoryLow(s, memory);
  const idleMs = Math.min(s.minutes * 60e3, Number.isFinite(limits.sleepAfterMs) ? limits.sleepAfterMs : Infinity);
  const useIdle = s.mode === 'idle' || s.mode === 'both';
  const facts = (t) => ({ alive: true, webPage: true, ...t, agentUsing: t.agentUsing || t.aiBusy, keepPinned: s.keepPinned, neverSite: hostListed(t.host, s.never) });
  const byAge = [...tabs].sort((a, b) => (a.lastActive || 0) - (b.lastActive || 0));
  const chosen = new Set();
  for (const t of byAge) {
    if (!t.lastActive || keepReason(facts(t))) continue;
    const idle = now - t.lastActive;
    if (useIdle && idle >= idleMs) { out.sleep.push({ id: t.id, why: 'idle' }); chosen.add(t.id); }
    else if (out.low && idle >= MEMORY_IDLE_MS) { out.sleep.push({ id: t.id, why: 'memory' }); chosen.add(t.id); }
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

module.exports = { MODES, HOWS, MINUTE_CHOICES, FREE_PERCENT_CHOICES, LUMEN_GB_CHOICES, MAX_AWAKE_CHOICES, MAX_MINUTES, MEMORY_IDLE_MS, DEFAULTS, normalize, cleanMinutes, cleanHost, cleanHosts, hostListed, memoryLow, decideSleep, keepReason, pageBusyScript, pageBusy, wakePlan, wakeBounds, sameAddress };
