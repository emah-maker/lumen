// "Turn this on?" after an update (features/feature-offers.js), plain Node: who is offered what (a fresh install
// nothing, an update every offer still off, nothing twice, nothing already on), that the seen list is written before
// any card, and that "Turn on" goes through the settings setter while "Not now" changes nothing.
const FO = require('../src/features/feature-offers');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = JSON.stringify;
const offers = [{ key: 'a', value: true, title: 'ta', detail: 'da', where: 'Settings > AI' }, { key: 'b', value: true, title: 'tb', detail: 'db', where: 'Settings > AI' }];

(async () => {
  // ---- plan
  {
    let p = FO.plan({ settings: {}, offers });
    check('a fresh install is offered nothing and records every offer as seen', p.show.length === 0 && J(p.seen) === '["a","b"]', J(p));
    p = FO.plan({ settings: { lastSeenVersion: '0.5.19' }, offers });
    check('an update from before offers existed is offered every one still off', J(p.show.map((o) => o.key)) === '["a","b"]' && J(p.seen) === '["a","b"]', J(p));
    p = FO.plan({ settings: { lastSeenVersion: '0.5.19', featureOffersSeen: ['a'] }, offers });
    check('an offer already made is not made again', J(p.show.map((o) => o.key)) === '["b"]', J(p));
    p = FO.plan({ settings: { lastSeenVersion: '0.5.19', b: true }, offers });
    check('a setting the user already turned on is not offered (but recorded)', J(p.show.map((o) => o.key)) === '["a"]' && p.seen.includes('b'), J(p));
    p = FO.plan({ settings: { lastSeenVersion: '0.5.19', featureOffersSeen: 'junk' }, offers });
    check('a broken seen list is treated as empty', p.show.length === 2, J(p));
    check('the real list offers file access, which ships off', FO.OFFERS.some((o) => o.key === 'aiDeviceAccess' && o.value === true));
    const backend = require('fs').readFileSync(require('path').join(__dirname, '../src/settings/settings-backend.js'), 'utf8');
    check('every real offer is a boolean setting that defaults to false', FO.OFFERS.every((o) => new RegExp(`\\n  ${o.key}: false,`).test(backend)));
    const en = require('../src/locales/en.json');
    check('every real offer and the card have their strings', FO.OFFERS.every((o) => en[o.title] && en[o.detail]) && ['offers.title', 'offers.turnOn', 'offers.notNow', 'offers.later'].every((k) => en[k]));
  }

  // ---- the cards
  {
    const run = async (answers, settings = { lastSeenVersion: '0.5.19' }) => {
      let file = { ...settings };
      const writes = []; const sets = []; const cards = [];
      const real = FO.OFFERS;
      const fo = FO.createFeatureOffers({
        readSettings: () => ({ ...file }), writeSettings: (s) => { writes.push(s); file = { ...s }; },
        setSetting: async (k, v) => { sets.push([k, v]); file = { ...file, [k]: v }; },
        showMessageBox: async (opts) => { cards.push(opts); return { response: answers.shift() ?? 0 }; },
        t: (k, p) => (p ? `${k}:${J(p)}` : k), test: false,
      });
      fo.prepare();
      const wroteBeforeCard = writes.length === 1 && cards.length === 0;
      const on = await fo.present();
      return { on, writes, sets, cards, wroteBeforeCard, file, real };
    };
    let r = await run([1]);
    check('"Turn on" sets the setting through the settings setter', J(r.on) === '["aiDeviceAccess"]' && J(r.sets) === '[["aiDeviceAccess",true]]' && r.file.aiDeviceAccess === true, J(r));
    check('the seen list is written before any card shows', r.wroteBeforeCard && J(r.writes[0].featureOffersSeen) === J(FO.OFFERS.map((o) => o.key)), J(r.writes));
    check('the card names the feature, says where it lives, and defaults to Turn on', r.cards[0].message === 'settings.ai.deviceAccess' && /Settings > AI/.test(r.cards[0].detail) && J(r.cards[0].buttons) === '["offers.notNow","offers.turnOn"]' && r.cards[0].defaultId === 1 && r.cards[0].cancelId === 0, J(r.cards[0]));
    r = await run([0]);
    check('"Not now" changes nothing', r.on.length === 0 && r.sets.length === 0 && !r.file.aiDeviceAccess, J(r));
    r = await run([1], { lastSeenVersion: '0.5.19', featureOffersSeen: FO.OFFERS.map((o) => o.key) });
    check('the next start asks nothing', r.cards.length === 0, J(r.cards));
    r = await run([1], {});
    check('a fresh install shows no card', r.cards.length === 0 && J(r.file.featureOffersSeen) === J(FO.OFFERS.map((o) => o.key)), J(r));
    const fo = FO.createFeatureOffers({ readSettings: () => ({ lastSeenVersion: '0.5.19' }), writeSettings: () => { throw new Error('wrote'); }, setSetting: async () => {}, showMessageBox: async () => { throw new Error('showed'); }, t: (k) => k, test: true });
    let quiet = true;
    try { await fo.present(); } catch { quiet = false; }
    check('test mode never asks or writes on its own', quiet || process.env.LUMEN_FEATURE_OFFERS_TEST);
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
