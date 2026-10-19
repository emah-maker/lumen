// Waking tabs ahead of the click (main.js does the Electron parts; test/tab-wake-units.js runs this): the hover
// intent that starts loading a placeholder or slept tab before it is clicked, which tabs to bring back in the
// background after startup (and when to stop), and whether a tab that goes to sleep is frozen first. All pure.
'use strict';

const HOVER_MS = 100; // a pointer resting on a tab this long means to open it
const PRELOAD_CHOICES = [0, 1, 2, 3, 5]; // Settings > Tabs > Memory: "Preload tabs after startup"
const PRELOAD_DEFAULT = 1;
const FREEZE_FIRST_CHOICES = [0, 10, 30, 60]; // minutes a tab that goes to sleep stays frozen (instant to wake) before it unloads; 0: unload at once
const FREEZE_FIRST_DEFAULT = 10;
const PRELOAD_IDLE_CPU = 25; // % of one core the whole app may use for the machine to count as idle
const PRELOAD_GAP_MS = 1500; // between one preload finishing and the next starting

const cleanPreload = (v) => (PRELOAD_CHOICES.includes(Number(v)) ? Number(v) : PRELOAD_DEFAULT);
const cleanFreezeFirst = (v) => (v != null && v !== '' && FREEZE_FIRST_CHOICES.includes(Number(v)) ? Number(v) : FREEZE_FIRST_DEFAULT);

// ---- addresses never woken ahead of a click --------------------------------------------------------------------
// Sign-in, payment and account pages (and addresses carrying credentials or a token) are not requested until the user
// asks: no request they did not make. -> a reason string, or null for an ordinary address.
const SENSITIVE_LABEL = /^(login|log-in|signin|sign-in|sso|auth|oauth|accounts?|myaccount|id|idp|secure|pay|payments?|checkout|billing|bank|banking|wallet|netbanking|ebanking)$/;
const SENSITIVE_HOSTS = ['paypal.com', 'venmo.com', 'stripe.com', 'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'capitalone.com', 'americanexpress.com', 'schwab.com', 'fidelity.com', 'vanguard.com', 'coinbase.com', 'binance.com', 'wise.com', 'revolut.com', 'login.microsoftonline.com', 'accounts.google.com'];
const SENSITIVE_PATH = /(^|\/)(log-?in|sign-?(in|on|up)|sso|oauth2?|authori[sz]e|checkout|payments?|billing|password|reset-password|2fa|mfa|verify|wallet|banking|account|my-account)(\/|$|\.|\?)/i;
const SENSITIVE_QUERY = /(^|[?&])(token|access_token|id_token|code|password|passwd|pwd|secret|session|sid|otp|auth|key)=/i;
function sensitiveAddress(url) {
  let u;
  try { u = new URL(String(url)); } catch { return 'address'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'internal';
  if (u.username || u.password) return 'credentials';
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (SENSITIVE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return 'sensitive-host';
  if (host.split('.').slice(0, -2).some((label) => SENSITIVE_LABEL.test(label))) return 'sensitive-host'; // login.example.com, secure.bank.example
  if (SENSITIVE_PATH.test(u.pathname)) return 'sensitive-path';
  if (SENSITIVE_QUERY.test(u.search) || SENSITIVE_QUERY.test(u.hash.replace(/^#/, '?'))) return 'token';
  return null;
}

// ---- hover intent ------------------------------------------------------------------------------------------
// enter(id): the pointer reached a tab; after `delayMs` still there, onIntent(id, 'hover') fires once.
// leave(id): it left first: nothing fires. down(id): the button went down: onIntent(id, 'down') at once (the click
// completes a moment later). Each tab fires at most once per visit (enter..leave). `setTimer`/`clearTimer`/`onPreview`
// are injectable for tests; onPreview(id) fires on enter, at once (cheap work: preconnecting to the tab's site).
function createHoverIntent({ delayMs = HOVER_MS, onIntent, onPreview = null, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let current = null; // { id, timer, fired }
  const stop = () => { if (current?.timer != null) clearTimer(current.timer); };
  function fire(id, why) {
    if (!current || current.id !== id || current.fired) return;
    current.fired = true;
    if (current.timer != null) clearTimer(current.timer);
    current.timer = null;
    onIntent(id, why);
  }
  return {
    enter(id) {
      if (current && current.id === id) return;
      stop();
      current = { id, timer: null, fired: false };
      onPreview?.(id);
      current.timer = setTimer(() => fire(id, 'hover'), delayMs);
      current.timer?.unref?.();
    },
    leave(id) {
      if (!current || (id != null && current.id !== id)) return;
      stop();
      current = null;
    },
    down(id) {
      if (!current || current.id !== id) { stop(); current = { id, timer: null, fired: false }; }
      fire(id, 'down');
    },
    cancel() { stop(); current = null; },
    pending: () => (current && !current.fired ? current.id : null),
  };
}

// ---- which tabs to bring back ---------------------------------------------------------------------------------
// May this tab be brought back ahead of time? t: { id, sleeping (a placeholder or unloaded page), frozen, web (an
// http(s) page), isolated, internal, sensitive (a login/payment address), loading }.
const wakeable = (t) => Boolean(t && t.sleeping && !t.frozen && t.web && !t.isolated && !t.internal);

// The tabs to preload, in order. tabs: strip order, each { id, lastActive (ms; viewed or woken last), ...wakeable's }.
// cap: the Settings number (preloads allowed to be waiting, unvisited, at once); waiting: how many such tabs are awake
// now; room: background tabs the sleep cap still allows awake (Infinity: no cap). Order: the tab next to the front one
// on its right, then its left, then the next two, and so on; then the rest by most recently used.
function pickPreloads({ tabs = [], activeId = null, cap = PRELOAD_DEFAULT, waiting = 0, room = Infinity, max = 1 } = {}) {
  const budget = Math.min(Math.max(0, cap - waiting), Number.isFinite(room) ? Math.max(0, room) : Infinity, Math.max(0, max));
  if (!budget) return [];
  const at = tabs.findIndex((t) => t.id === activeId);
  const picked = [];
  const take = (t) => { if (t && wakeable(t) && !t.sensitive && !picked.includes(t.id)) picked.push(t.id); };
  if (at >= 0) {
    for (let d = 1; d <= 2; d++) { take(tabs[at + d]); take(tabs[at - d]); } // the two nearest on each side
  }
  const rest = [...tabs].filter((t) => wakeable(t) && !t.sensitive).sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  for (const t of rest) take(t);
  return picked.slice(0, budget);
}

// May a background preload start now? s: { cap, waiting, frontLoaded, cpu (% of one core used by the whole app, or
// null when unknown), onBattery, perfMode ('on' = Performance mode), memoryLow, quitting }. -> { go, why }.
function preloadGate(s = {}) {
  if (!(s.cap > 0)) return { go: false, why: 'off' };
  if (s.quitting) return { go: false, why: 'quitting' };
  if (!s.frontLoaded) return { go: false, why: 'front-loading' };
  if (s.memoryLow) return { go: false, why: 'memory' }; // under memory pressure: stop (and tab sleep takes over)
  if (s.perfMode) return { go: false, why: 'performance-mode' };
  const cap = s.onBattery ? Math.min(s.cap, 1) : s.cap; // on battery: one at most (there is no way to read the battery saver itself)
  if ((s.waiting || 0) >= cap) return { go: false, why: 'cap' };
  if (Number.isFinite(s.cpu) && s.cpu > PRELOAD_IDLE_CPU) return { go: false, why: 'busy' };
  return { go: true, why: '' };
}

// May a tab be woken because the pointer is on it? Not when memory is low or the sleep cap is full, not a frozen
// tab (thawing it is instant already), not a login/payment address (no request the user hasn't asked for).
function hoverGate(t, { memoryLow = false, room = Infinity } = {}) {
  if (!wakeable(t) || t.sensitive) return { go: false, why: 'not-wakeable' };
  if (memoryLow) return { go: false, why: 'memory' };
  if (room < 1) return { go: false, why: 'cap' };
  return { go: true, why: '' };
}

// ---- sleeping: freeze first? ---------------------------------------------------------------------------------
// A tab due to sleep. `how` is the user's choice ('unload' | 'freeze'), `why` the sweep's reason ('idle' | 'memory' |
// 'cap'), `freezeFirstMin` Settings' number (0 = off), `low` memory is low. With the choice 'unload' and a freeze-first
// time set, an idle tab is frozen at first (waking is instant) and unloaded once `freezeFirstMin` have passed.
function sleepHow({ how = 'unload', why = 'idle', freezeFirstMin = 0, low = false } = {}) {
  if (how === 'freeze') return 'freeze';
  if (freezeFirstMin > 0 && why === 'idle' && !low) return 'freeze-first';
  return 'unload';
}
// Frozen tabs that have been frozen long enough (or memory got low) go on to unload. frozen: [{ id, frozenAt, first }]
// (`first` = frozen by the freeze-first rule, not because the user chose freeze).
function dueToUnload({ frozen = [], now = Date.now(), freezeFirstMin = 0, low = false } = {}) {
  return frozen.filter((t) => t.first && (low || freezeFirstMin <= 0 || now - (t.frozenAt || 0) >= freezeFirstMin * 60e3)).map((t) => t.id);
}

module.exports = { HOVER_MS, PRELOAD_CHOICES, PRELOAD_DEFAULT, FREEZE_FIRST_CHOICES, FREEZE_FIRST_DEFAULT, sensitiveAddress, PRELOAD_IDLE_CPU, PRELOAD_GAP_MS, cleanPreload, cleanFreezeFirst, createHoverIntent, wakeable, pickPreloads, preloadGate, hoverGate, sleepHow, dueToUnload };
