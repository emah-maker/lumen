// "New in Lumen": the settings an update brings are shown once, on a short card in the empty chat (the sidebar and the
// lumen://chat page share it: renderer/offer-card.js), so a user who updates doesn't have to find them in Settings.
// Each line says what the setting does and lets the user change it right there: a switch for on/off, a small choice for
// a setting with options (the ad blocker: Lumen's own or uBlock Origin Lite), or "Set up…" for one that needs more (it
// opens the right Settings section; a feature that sends data, like Telegram or voice input to OpenAI or Gemini, still
// goes through its own setup there: the card never turns those on by itself). A change goes through settings-backend,
// so it applies at once. Lines are grouped by release, newest first; a long batch shows the first few and "More in
// Settings". "Not now" puts the card away for this run (what was on screen is not shown again; the rest waits for the
// next launch), and "Don't show again" stops every future card. It never shows over a running task: only an empty chat
// has room for it.
//
// settings.json keeps `featureOffersSeen` (the keys already shown) and `featureCardNever` ("Don't show again").
// A line counts as shown once the card has been on screen with it, so a batch shows once, not on every launch.
// A fresh install (no `lastSeenVersion` yet) records every line as seen and shows nothing: there is nothing to have
// missed. Any other profile is shown every line it has not seen whose setting still has its default. A setting the
// user already changed by hand is recorded as seen without asking. Test mode never shows the card on its own: a test
// opts in with LUMEN_FEATURE_OFFERS_TEST=1.
//
// Adding a setting (a new key in settings-backend's DEFAULTS): give it a line in OFFERS with the release that brings it
// (`since`), its kind, and its strings in locales/en.json (offers.<id>, offers.<id>.desc, and offers.<id>.<value> for
// each choice), or, if it is not worth showing (Lumen records it itself, it is changed from a card, it only matters
// inside another feature), put it in QUIET with the reason. test/units/feature-offers-units.js fails on a key in neither.

// kind: toggle (a switch; `value` is what "on" means for a setting that ships off and is offered to be turned on),
// choice (`choices`: the values, in the order shown; `confirm`: a value that installs or sends something and asks once
// on the card first), setup ("Set up…": opens `section`; nothing is changed here), tip (a new thing to know about, with
// no setting: just the line). `section`: where the setting lives in Settings ("More in Settings" opens it).
const OFFERS = [
  // ---- 0.5.94
  // [secure DNS] browser/secure-dns.js: a DNS-over-HTTPS provider for site addresses (Settings has Off, Google, Quad9 and a custom server too)
  { id: 'secureDns', key: 'secureDns', since: '0.5.94', kind: 'choice', choices: ['auto', 'cloudflare'], section: 'adv-network' },
  // ---- 0.5.90
  // [key switches] Settings → AI → API keys: a saved key can be switched off (kept, never used) and back on
  { id: 'keysOff', key: 'keysOff', since: '0.5.90', kind: 'setup', section: 'ai-keys-page' },
  // ---- 0.5.88
  // [uBlock mode] features/ublock-mode.js: uBlock Origin Lite (installed from the Chrome Web Store) in place of Lumen's blocker
  { id: 'adBlocker', key: 'adBlocker', since: '0.5.88', kind: 'choice', choices: ['lumen', 'ublock'], confirm: 'ublock', section: 'privacy-adblock' },
  // [extensions] Settings → Extensions: an extension's site access can be "On all sites except these" (no setting of its own)
  { id: 'extensionSites', since: '0.5.88', kind: 'setup', section: 'extensions-page' },
  // [account tabs] features/account-tabs.js: a tab signed in to a site with a second account (the tab menu; no setting)
  { id: 'accountTabs', since: '0.5.88', kind: 'tip' },
  // ---- 0.5.85
  // [new topic] renderer/chat-topic.js: a message about something else moves to a new chat by itself
  { id: 'autoNewChat', key: 'autoNewChat', since: '0.5.85', kind: 'toggle', section: 'ai-chat' },
  // ---- 0.5.78
  // [auto-delete chats] features/chat-auto-delete.js (a few of its CHOICES; Settings has them all)
  { id: 'chatAutoDelete', key: 'chatAutoDeleteDays', since: '0.5.78', kind: 'choice', choices: [0, 30, 90, 365], section: 'ai-chat' },
  // ---- 0.5.75
  // [reply suggestions] ai/reply-suggest.js: chips under a finished reply
  { id: 'replySuggestions', key: 'replySuggestions', since: '0.5.75', kind: 'toggle', section: 'ai-chat' },
  // ---- 0.5.66
  // [autocomplete] ai/autocomplete.js: Tab finishes what is being typed in the chat box
  { id: 'chatAutocomplete', key: 'chatAutocomplete', since: '0.5.66', kind: 'toggle', section: 'ai-chat' },
  // ---- 0.5.65
  // [word] src/word/: the AI works with Microsoft Word documents directly
  { id: 'wordControl', key: 'aiWordControl', since: '0.5.65', kind: 'toggle', section: 'ai-computer' },
  // [desktop apps] agent.js filesInApps: a file is opened in its own app, or read from the file
  { id: 'filesInApps', key: 'aiFilesInApps', since: '0.5.65', kind: 'choice', choices: ['app', 'auto', 'file'], section: 'ai-computer' },
  // [ai] agent.js FRACTIONS_STYLE: exact fractions in math answers
  { id: 'fractions', key: 'aiPreferFractions', since: '0.5.65', kind: 'toggle', section: 'ai-answers' },
  // [ai] main.js joinAiGroup: the AI's tabs fold into one "AI tabs" group
  { id: 'groupAiTabs', key: 'groupAiTabs', since: '0.5.65', kind: 'toggle', section: 'ai-tabs' },
  // [ai] main.js 'tab:switch': an AI tab the user clicked stays open
  { id: 'keepViewedAiTabs', key: 'keepViewedAiTabs', since: '0.5.65', kind: 'toggle', section: 'ai-tabs' },
  // [extensions] which extension buttons the toolbar shows
  { id: 'extensionsToolbar', key: 'extensionsToolbar', since: '0.5.65', kind: 'choice', choices: ['pinned', 'all', 'none'], section: 'extensions-page' },
  // ---- 0.5.60
  // [acting helpers] ai/acting-helpers.js: helpers that click and type side by side, each in a background tab
  { id: 'helpers', key: 'actingHelpers', since: '0.5.60', value: true, kind: 'toggle', section: 'ai-helpers' },
  // ---- 0.5.55
  // [memory] ai/memory.js: the sidebar AI keeps short notes about you between chats
  { id: 'memory', key: 'aiMemory', since: '0.5.55', value: true, kind: 'toggle', section: 'memory' },
  // [plan mode] ai/plan-mode.js: the AI writes a plan for you to approve before it acts
  { id: 'plan', key: 'planModeDefault', since: '0.5.55', value: true, kind: 'toggle', section: 'ai-chat' },
  // [skills] features/skill-md.js: the SKILL.md skills already in ~/.claude/skills show up in Lumen
  { id: 'skills', key: 'skillsFromClaudeCode', since: '0.5.55', value: true, kind: 'toggle', section: 'skills' },
  // [telegram] features/telegram.js: requests from the user's own Telegram bot (it needs a token and pairing in Settings)
  { id: 'telegram', key: 'telegramChannel', since: '0.5.55', value: true, kind: 'setup', section: 'telegram' },
  // [dictation] ai/dictation.js: the mic in the chat box (audio goes to the user's own OpenAI or Gemini key, set in Settings)
  { id: 'voice', key: 'dictation', since: '0.5.55', kind: 'setup', section: 'voice-input', ready: 'dictation' },
];

// Settings keys added since the card learned to list settings (0.5.65) that it leaves out on purpose, and why.
const QUIET = {
  secureDnsCustom: 'only matters with a custom secure DNS server, typed in its row',
  newTabHiddenTiles: 'the new-tab page records the tiles removed from it',
  extensionPins: 'pinned from the puzzle menu; Lumen records the order',
  connectorAlways: 'added from an approval card only',
  aiWordAlways: 'added from the Word edit card only',
  telegramFiles: 'only matters with Telegram, whose setup shows it',
  featureOffersSeen: 'this card\'s own record',
  featureCardNever: 'this card\'s own record',
};

const CARD_MAX = 6; // lines on the card at once; the rest wait behind "More in Settings" (and come on a later launch)
const byId = (id) => OFFERS.find((o) => o.id === id);
const newer = (a, b) => { // release order, newest first ('0.5.88' before '0.5.9')
  const pa = String(a.since || '0').split('.').map(Number); const pb = String(b.since || '0').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  return 0;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Is it already taken care of? A feature that ships off is "on"; any other setting has been changed from its default
// (by hand, before the card ever showed it). settings: the file; defaults: settings-backend's DEFAULTS;
// ctx.ready: { name: bool } for the lines that are not one setting.
function isOn(offer, settings = {}, ctx = {}, defaults = {}) {
  if (offer.ready) return Boolean(ctx[offer.ready]);
  if (!offer.key) return false;
  if ('value' in offer) return settings[offer.key] === offer.value;
  return offer.key in settings && offer.key in defaults && !same(settings[offer.key], defaults[offer.key]);
}

// The value the card shows for a switch or a choice: the saved one, else the default.
const current = (offer, settings, defaults) => (offer.key in settings ? settings[offer.key] : 'value' in offer ? !offer.value : defaults[offer.key]);

// What to do at startup: { show: [offer], seen: [key] } (seen: what to record now: everything on a fresh install,
// otherwise only what the user already changed by hand). Lines are newest release first.
const seenKey = (o) => o.key || `offer:${o.id}`; // (a line with no setting is recorded by its id)
function plan({ settings = {}, offers = OFFERS, defaults = {} } = {}) {
  const known = Array.isArray(settings.featureOffersSeen) ? settings.featureOffersSeen.filter((k) => typeof k === 'string') : null;
  const fresh = !settings.lastSeenVersion; // a first run ever (What's new records the version only after this runs)
  const seen = new Set(known || []);
  const show = [];
  for (const offer of [...offers].sort(newer)) {
    if (seen.has(seenKey(offer))) continue;
    if (fresh || (!offer.ready && isOn(offer, settings, {}, defaults))) { seen.add(seenKey(offer)); continue; } // nothing missed / changed by hand
    show.push(offer);
  }
  return { show, seen: [...seen] };
}

// deps: { readSettings, writeSettings, setSetting(key, value) -> Promise, defaults (DEFAULTS), ready() -> { dictation: bool }, test (bool) }
function createFeatureOffers(deps) {
  const defaults = deps.defaults || {};
  let planned = null;
  let decide; const decided = new Promise((resolve) => { decide = resolve; }); // startup's prepare() has run: what is new is known
  const shown = new Set(); // ids that have been on screen this session: they stay (with their live value) until the user decides
  let away = false; // "Not now" this run: no card until the next launch
  const seenKeys = () => { const s = deps.readSettings().featureOffersSeen; return Array.isArray(s) ? s : []; };
  const markSeen = (keys) => {
    const have = seenKeys();
    const add = keys.filter((k) => !have.includes(k));
    if (add.length) deps.writeSettings({ ...deps.readSettings(), featureOffersSeen: [...have, ...add] });
  };

  // Called before What's new records the running version (it tells a fresh install from an update).
  function prepare() {
    if (planned) return planned;
    if (deps.test && !process.env.LUMEN_FEATURE_OFFERS_TEST) { planned = { show: [], seen: [] }; decide(); return planned; }
    planned = plan({ settings: deps.readSettings(), defaults });
    const before = deps.readSettings().featureOffersSeen;
    if (planned.seen.length !== (Array.isArray(before) ? before.length : 0)) deps.writeSettings({ ...deps.readSettings(), featureOffersSeen: planned.seen });
    decide();
    return planned;
  }

  // What the card lists now: { items: [{ id, kind, since, value?, choices?, confirm?, section? }], more: n, moreSection },
  // or null when there is nothing (or the user said "Not now" this run, or "Don't show again").
  // Waits for startup's prepare(): the version is not recorded before it, so a fresh install can't be told from an update.
  async function get() { await decided; return list(); }
  function list() {
    if (!planned || away) return null;
    const { show } = planned;
    const s = deps.readSettings();
    if (s.featureCardNever === true) return null;
    const ctx = deps.ready && show.some((o) => o.ready) ? deps.ready() : {}; // (only when something needs it: it loads the voice module)
    const seen = new Set(seenKeys());
    const all = show.filter((o) => shown.has(o.id) || (!seen.has(seenKey(o)) && !isOn(o, s, ctx, defaults)));
    if (!all.length) return null;
    // The lines already on screen keep their place; new ones fill up to CARD_MAX.
    const onCard = [...all.filter((o) => shown.has(o.id)), ...all.filter((o) => !shown.has(o.id))].slice(0, Math.max(CARD_MAX, all.filter((o) => shown.has(o.id)).length)).sort(newer);
    const rest = all.filter((o) => !onCard.includes(o));
    const items = onCard.map((o) => {
      const item = { id: o.id, kind: o.kind, since: o.since };
      if (o.kind === 'toggle') item.value = current(o, s, defaults) === ('value' in o ? o.value : true);
      if (o.kind === 'choice') Object.assign(item, { value: current(o, s, defaults), choices: o.choices }, o.confirm !== undefined ? { confirm: o.confirm } : {});
      if (o.section) item.section = o.section;
      return item;
    });
    return { items, more: rest.length, moreSection: rest[0]?.section || null };
  }

  // The card is on screen: its lines count as shown (so the next launch does not show them again).
  function onShown(ids) {
    const keys = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const o = byId(id);
      if (!o || shown.has(o.id)) continue;
      shown.add(o.id);
      keys.push(seenKey(o));
    }
    markSeen(keys);
  }

  // A switch or a choice changed on the card: saved through the settings setter (it applies at once). The line stays.
  async function set(id, value) {
    const o = byId(id);
    if (!o || !['toggle', 'choice'].includes(o.kind)) return { ok: false };
    let want = value;
    if (o.kind === 'toggle') {
      if (typeof value !== 'boolean') return { ok: false };
      want = 'value' in o ? (value ? o.value : !o.value) : value;
    } else if (!o.choices.some((c) => c === value)) return { ok: false };
    markSeen([seenKey(o)]);
    try {
      await deps.setSetting(o.key, want);
      return { ok: true, value };
    } catch (err) {
      console.error(`[lumen] could not change ${o.key}:`, err.message);
      return { ok: false };
    }
  }

  // "Set up…" (opens its Settings section; nothing is switched on here; the line leaves the card), or, for a switch,
  // "turn it on" (the same as set(id, true)).
  async function act(id) {
    const o = byId(id);
    if (!o) return { ok: false };
    if (o.kind === 'toggle') return set(id, true);
    if (o.kind !== 'setup') return { ok: false };
    markSeen([seenKey(o)]);
    shown.delete(o.id);
    return { ok: true, section: o.section };
  }

  // "Not now" (what was on the card is not shown again; the card stays away until the next launch) or
  // "Don't show again" (no later batch is either).
  function dismiss({ never = false } = {}) {
    const items = (list()?.items) || [];
    markSeen(items.map((i) => seenKey(byId(i.id))));
    shown.clear();
    away = true;
    if (never) deps.writeSettings({ ...deps.readSettings(), featureCardNever: true });
    return { ok: true };
  }

  return { prepare, get, onShown, set, act, dismiss, list };
}

module.exports = { OFFERS, QUIET, CARD_MAX, plan, isOn, seenKey, createFeatureOffers };
