// "Turn this on?" after an update: a feature that ships OFF (because not everyone wants it) is offered once, right
// after the What's new notes, so a user who updates doesn't have to find the switch in Settings. One card per
// feature, in OFFERS order: "Turn on" sets the setting through settings-backend (so it applies at once), "Not now"
// leaves it off. Either way the feature is never offered again; it stays in Settings.
//
// settings.json keeps `featureOffersSeen` (the keys already offered). A fresh install (no `lastSeenVersion` yet)
// records every offer as seen and shows nothing: there is nothing to have missed. Any other profile, including one
// from before this file existed, is shown every offer it has not seen whose setting is still off.
// A setting the user already changed by hand is recorded as seen without asking. Test mode never shows the cards on
// its own: a test opts in with LUMEN_FEATURE_OFFERS_TEST=1.
//
// Adding an offer: a boolean setting that defaults to false, its Settings strings in locales/en.json, and an entry
// below. Keep the list to features the user would be sorry to miss; most new features should just ship on.

const OFFERS = [
  // [device access] features/device-access.js: upload_file paths, list_files, clipboard read
  { key: 'aiDeviceAccess', value: true, title: 'settings.ai.deviceAccess', detail: 'settings.ai.deviceAccessDesc', where: 'Settings > AI' },
];

// What to do at startup: { show: [offer], seen: [key] } (seen: what to record now, before anything is shown, so a
// crash or quit with a card open never asks twice).
function plan({ settings = {}, offers = OFFERS } = {}) {
  const known = Array.isArray(settings.featureOffersSeen) ? settings.featureOffersSeen.filter((k) => typeof k === 'string') : null;
  const fresh = !settings.lastSeenVersion; // a first run ever (What's new records the version only after this runs)
  const seen = new Set(known || []);
  const show = [];
  for (const offer of offers) {
    if (seen.has(offer.key)) continue;
    seen.add(offer.key);
    if (fresh) continue;
    if (settings[offer.key] === offer.value) continue; // already on (by hand)
    show.push(offer);
  }
  return { show, seen: [...seen] };
}

// deps: { readSettings, writeSettings, setSetting(key, value) -> Promise, showMessageBox(opts) -> Promise<{ response }>,
//         t(key, params?), test (bool) }
function createFeatureOffers(deps) {
  let planned = null;

  // Called before What's new records the running version (it tells a fresh install from an update).
  function prepare() {
    if (planned) return planned;
    if (deps.test && !process.env.LUMEN_FEATURE_OFFERS_TEST) return (planned = { show: [], seen: [] });
    planned = plan({ settings: deps.readSettings() });
    const before = deps.readSettings().featureOffersSeen;
    if (!Array.isArray(before) || planned.seen.length !== before.length) deps.writeSettings({ ...deps.readSettings(), featureOffersSeen: planned.seen });
    return planned;
  }

  // After the notes: one card per offer. Resolves to the keys the user turned on.
  async function present() {
    const { show } = prepare();
    const turnedOn = [];
    for (const offer of show) {
      const { response } = await deps.showMessageBox({
        title: deps.t('offers.title'),
        message: deps.t(offer.title),
        detail: `${deps.t(offer.detail)}\n\n${deps.t('offers.later', { where: offer.where })}`,
        buttons: [deps.t('offers.notNow'), deps.t('offers.turnOn')],
        cancelId: 0,
        defaultId: 1,
      });
      if (response !== 1) continue;
      try {
        await deps.setSetting(offer.key, offer.value);
        turnedOn.push(offer.key);
      } catch (err) {
        console.error(`[lumen] could not turn on ${offer.key}:`, err.message);
      }
    }
    return turnedOn;
  }

  return { prepare, present };
}

module.exports = { OFFERS, plan, createFeatureOffers };
