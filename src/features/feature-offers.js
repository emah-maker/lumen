// "New in Lumen: want to turn these on?": features that ship OFF (or need setting up) are offered once, on a short
// card in the empty chat (the sidebar and the lumen://chat page share it: renderer/offer-card.js). A user who
// updates doesn't have to find the switches in Settings. The card lists what is new with a plain line for each;
// "Turn on" sets the setting through settings-backend (so it applies at once), "Set up" opens the right Settings
// section (a feature that sends data, like Telegram or voice input to OpenAI or Gemini, still goes through its own
// setup there: the card never turns those on by itself), "Not now" leaves everything as it is, and "Don't show again"
// stops every future card. It never shows over a running task: only an empty chat has room for it.
//
// settings.json keeps `featureOffersSeen` (the keys already offered) and `featureCardNever` ("Don't show again").
// A feature counts as offered once its card has been on screen, so a batch shows once per update, not on every
// launch; one the user turned on or set up leaves the card at once. A fresh install (no `lastSeenVersion` yet)
// records every offer as seen and shows nothing: there is nothing to have missed. Any other profile is shown every
// offer it has not seen whose feature is still off. A setting the user already changed by hand is recorded as seen
// without asking. Test mode never shows the card on its own: a test opts in with LUMEN_FEATURE_OFFERS_TEST=1.
//
// Adding an offer: an entry below (id, kind, setting, its card strings in locales/en.json as offers.<id> and
// offers.<id>.desc). Keep the list to features the user would be sorry to miss; most new features should just ship on.

const OFFERS = [
  // [memory] ai/memory.js: the sidebar AI keeps short notes about you between chats
  { id: 'memory', key: 'aiMemory', value: true, kind: 'toggle' },
  // [plan mode] ai/plan-mode.js: the AI writes a plan for you to approve before it acts
  { id: 'plan', key: 'planModeDefault', value: true, kind: 'toggle' },
  // [skills] features/skill-md.js: the SKILL.md skills already in ~/.claude/skills show up in Lumen
  { id: 'skills', key: 'skillsFromClaudeCode', value: true, kind: 'toggle' },
  // [telegram] features/telegram.js: requests from the user's own Telegram bot (it needs a token and pairing in Settings)
  { id: 'telegram', key: 'telegramChannel', value: true, kind: 'setup', section: 'telegram' },
  // [dictation] ai/dictation.js: the mic in the chat box (audio goes to the user's own OpenAI or Gemini key, set in Settings)
  { id: 'voice', key: 'dictation', kind: 'setup', section: 'voice-input', ready: 'dictation' },
];

const byId = (id) => OFFERS.find((o) => o.id === id);

// Is the feature already in use? settings: the file; ctx.ready: { name: bool } for the offers that are not one setting.
function isOn(offer, settings = {}, ctx = {}) {
  if (offer.ready) return Boolean(ctx[offer.ready]);
  return settings[offer.key] === offer.value;
}

// What to do at startup: { show: [offer], seen: [key] } (seen: what to record now: everything on a fresh install,
// otherwise only what the user already switched on by hand).
function plan({ settings = {}, offers = OFFERS } = {}) {
  const known = Array.isArray(settings.featureOffersSeen) ? settings.featureOffersSeen.filter((k) => typeof k === 'string') : null;
  const fresh = !settings.lastSeenVersion; // a first run ever (What's new records the version only after this runs)
  const seen = new Set(known || []);
  const show = [];
  for (const offer of offers) {
    if (seen.has(offer.key)) continue;
    if (fresh || (!offer.ready && isOn(offer, settings))) { seen.add(offer.key); continue; } // nothing missed / already on (by hand)
    show.push(offer);
  }
  return { show, seen: [...seen] };
}

// deps: { readSettings, writeSettings, setSetting(key, value) -> Promise, ready() -> { dictation: bool }, test (bool) }
function createFeatureOffers(deps) {
  let planned = null;
  let decide; const decided = new Promise((resolve) => { decide = resolve; }); // startup's prepare() has run: what is new is known
  const shown = new Set(); // ids that have been on screen this session: they stay until the user decides
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
    planned = plan({ settings: deps.readSettings() });
    const before = deps.readSettings().featureOffersSeen;
    if (planned.seen.length !== (Array.isArray(before) ? before.length : 0)) deps.writeSettings({ ...deps.readSettings(), featureOffersSeen: planned.seen });
    decide();
    return planned;
  }

  // What the card lists now: [{ id, kind }], or null when there is nothing (or the user said "Don't show again").
  // Waits for startup's prepare(): the version is not recorded before it, so a fresh install can't be told from an update.
  async function get() { await decided; return list(); }
  function list() {
    if (!planned) return null;
    const { show } = planned;
    const s = deps.readSettings();
    if (s.featureCardNever === true) return null;
    const ctx = deps.ready && show.some((o) => o.ready) ? deps.ready() : {}; // (only when something needs it: it loads the voice module)
    const seen = new Set(seenKeys());
    const items = show.filter((o) => (shown.has(o.id) || !seen.has(o.key)) && !isOn(o, s, ctx)).map((o) => ({ id: o.id, kind: o.kind }));
    return items.length ? { items } : null;
  }

  // The card is on screen: its features count as offered (so the next launch does not show them again).
  function onShown(ids) {
    const keys = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const o = byId(id);
      if (!o || shown.has(o.id)) continue;
      shown.add(o.id);
      keys.push(o.key);
    }
    markSeen(keys);
  }

  // "Turn on" (a toggle: sets it) or "Set up" (opens its Settings section; nothing is switched on here).
  async function act(id) {
    const o = byId(id);
    if (!o) return { ok: false };
    markSeen([o.key]);
    shown.delete(o.id);
    if (o.kind === 'setup') return { ok: true, section: o.section };
    try {
      await deps.setSetting(o.key, o.value);
      return { ok: true };
    } catch (err) {
      console.error(`[lumen] could not turn on ${o.key}:`, err.message);
      return { ok: false };
    }
  }

  // "Not now" (these are not offered again) or "Don't show again" (no later batch is either).
  function dismiss({ never = false } = {}) {
    const items = (list()?.items) || [];
    markSeen(items.map((i) => byId(i.id).key));
    for (const i of items) shown.delete(i.id);
    if (never) deps.writeSettings({ ...deps.readSettings(), featureCardNever: true });
    return { ok: true };
  }

  return { prepare, get, onShown, act, dismiss, list };
}

module.exports = { OFFERS, plan, isOn, createFeatureOffers };
