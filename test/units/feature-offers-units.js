// "New in Lumen: want to turn these on?" (features/feature-offers.js), plain Node: who is offered what (a fresh install
// nothing, an update every feature still off, nothing twice, nothing already on), that a batch counts as offered once it
// has been on screen, that "Turn on" goes through the settings setter while a feature that needs setting up (Telegram,
// voice input) is only pointed at its Settings section, and that "Not now" / "Don't show again" stick.
const FO = require('../../src/features/feature-offers');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = JSON.stringify;
const toggles = [{ id: 'a', key: 'a', value: true, kind: 'toggle' }, { id: 'b', key: 'b', value: true, kind: 'toggle' }];
const ALL = ['memory', 'plan', 'skills', 'telegram', 'voice', 'helpers'];

(async () => {
  // ---- plan
  {
    let p = FO.plan({ settings: {}, offers: toggles });
    check('a fresh install is offered nothing and records every offer as seen', p.show.length === 0 && J(p.seen) === '["a","b"]', J(p));
    p = FO.plan({ settings: { lastSeenVersion: '0.5.19' }, offers: toggles });
    check('an update is offered every feature still off, and records nothing yet', J(p.show.map((o) => o.key)) === '["a","b"]' && p.seen.length === 0, J(p));
    p = FO.plan({ settings: { lastSeenVersion: '0.5.19', featureOffersSeen: ['a'] }, offers: toggles });
    check('a feature already offered is not offered again', J(p.show.map((o) => o.key)) === '["b"]' && J(p.seen) === '["a"]', J(p));
    p = FO.plan({ settings: { lastSeenVersion: '0.5.19', b: true }, offers: toggles });
    check('a setting the user already turned on is not offered (but recorded)', J(p.show.map((o) => o.key)) === '["a"]' && p.seen.includes('b'), J(p));
    p = FO.plan({ settings: { lastSeenVersion: '0.5.19', featureOffersSeen: 'junk' }, offers: toggles });
    check('a broken seen list is treated as empty', p.show.length === 2, J(p));
    check('the real list is the new batch: memory, plan mode, skills, Telegram, voice input, acting helpers', J(FO.OFFERS.map((o) => o.id)) === J(ALL), J(FO.OFFERS.map((o) => o.id)));
    const backend = require('fs').readFileSync(require('path').join(__dirname, '../src/settings/settings-backend.js'), 'utf8');
    check('every real toggle is a boolean setting that defaults to false', FO.OFFERS.filter((o) => o.kind === 'toggle').every((o) => new RegExp(`\\n  ${o.key}: false,`).test(backend)));
    check('every setup offer opens a Settings section that exists', FO.OFFERS.filter((o) => o.kind === 'setup').every((o) => new RegExp(`'${o.section}'`).test(backend)));
    check('Telegram and voice input are setup offers, never turned on by the card', ['telegram', 'voice'].every((id) => FO.OFFERS.find((o) => o.id === id).kind === 'setup'));
    const en = require('../../src/locales/en.json');
    check('every offer and the card have their strings', FO.OFFERS.every((o) => en[`offers.${o.id}`] && en[`offers.${o.id}.desc`]) && ['offers.title', 'offers.turnOn', 'offers.setUp', 'offers.notNow', 'offers.never'].every((k) => en[k]));
    check('every line is short', FO.OFFERS.every((o) => en[`offers.${o.id}.desc`].length < 200));
  }

  // ---- the card
  {
    const make = (settings = { lastSeenVersion: '0.5.19' }, { voiceReady = false } = {}) => {
      let file = { ...settings };
      const writes = []; const sets = [];
      const fo = FO.createFeatureOffers({
        readSettings: () => ({ ...file }), writeSettings: (s) => { writes.push(s); file = { ...s }; },
        setSetting: async (k, v) => { sets.push([k, v]); file = { ...file, [k]: v }; },
        ready: () => ({ dictation: voiceReady }), test: false,
      });
      return { fo, writes, sets, file: () => file };
    };
    const ids = (g) => (g ? g.items.map((i) => i.id) : null);

    let c = make();
    const early = c.fo.get(); // asked before startup has decided: it waits, it doesn't guess
    check('before startup prepares it, the card waits (the version is not recorded yet)', await Promise.race([early.then(() => 'answered'), new Promise((r) => setTimeout(() => r('waiting'), 50))]) === 'waiting' && c.fo.list() === null);
    c.fo.prepare();
    check('and answers as soon as it has: the same call, no retry', J((await early).items.map((i) => i.id)) === J(ALL));
    check('an update lists every new feature, each with its kind', J(c.fo.list().items) === '[{"id":"memory","kind":"toggle"},{"id":"plan","kind":"toggle"},{"id":"skills","kind":"toggle"},{"id":"telegram","kind":"setup"},{"id":"voice","kind":"setup"},{"id":"helpers","kind":"toggle"}]', J(c.fo.list()));
    check('listing it records nothing: it counts as offered only once on screen', c.writes.length === 0, J(c.writes));
    c.fo.onShown(ALL);
    check('once shown, every feature is recorded as offered', J(c.file().featureOffersSeen) === '["aiMemory","planModeDefault","skillsFromClaudeCode","telegramChannel","dictation","actingHelpers"]', J(c.file()));
    check('and stays on the card for the rest of this session (the other surface shows it too)', ids(c.fo.list()).length === 6);
    c.fo.onShown(['memory']);
    check('showing it twice does not write twice', c.writes.length === 1, J(c.writes));

    let next = make(c.file()); next.fo.prepare();
    check('the next launch asks nothing', next.fo.list() === null, J(next.fo.list()));

    c = make(); c.fo.prepare(); c.fo.onShown(ALL);
    let r = await c.fo.act('memory');
    check('"Turn on" sets the setting through the settings setter', r.ok && J(c.sets) === '[["aiMemory",true]]' && c.file().aiMemory === true, J(c.sets));
    check('and the feature leaves the card', !ids(c.fo.list()).includes('memory') && ids(c.fo.list()).length === 5, J(c.fo.list()));
    r = await c.fo.act('telegram');
    check('"Set up" on Telegram only names its Settings section: nothing is switched on', r.ok && r.section === 'telegram' && c.sets.length === 1 && !c.file().telegramChannel, J({ r, sets: c.sets }));
    r = await c.fo.act('voice');
    check('"Set up" on voice input opens its section and sets nothing', r.section === 'voice-input' && c.sets.length === 1, J({ r, sets: c.sets }));
    check('a feature set up leaves the card too', J(ids(c.fo.list())) === '["plan","skills","helpers"]', J(c.fo.list()));
    r = await c.fo.act('nope');
    check('an unknown id does nothing', r.ok === false && c.sets.length === 1);

    c = make(); c.fo.prepare(); c.fo.onShown(ALL);
    c.fo.dismiss();
    check('"Not now" hides the card at once, without turning anything on or stopping later batches', c.fo.list() === null && c.sets.length === 0 && c.file().featureCardNever !== true, J(c.file()));
    next = make(c.file()); next.fo.prepare();
    check('and the next launch does not bring it back', next.fo.list() === null);
    const grown = make({ lastSeenVersion: '0.5.19', featureOffersSeen: ['aiMemory', 'planModeDefault', 'skillsFromClaudeCode', 'telegramChannel'] }); grown.fo.prepare();
    check('a feature added later gets its own card; the ones already offered do not come back', J(ids(grown.fo.list())) === '["voice","helpers"]', J(grown.fo.list()));

    c = make(); c.fo.prepare();
    c.fo.dismiss({ never: true });
    check('"Don\'t show again" is remembered', c.file().featureCardNever === true && c.fo.list() === null, J(c.file()));
    next = make({ ...c.file(), featureOffersSeen: [] }); next.fo.prepare();
    check('and stops later batches too, even for features never offered before', next.fo.list() === null);

    c = make({ lastSeenVersion: '0.5.19', aiMemory: true, planModeDefault: true }); c.fo.prepare();
    check('a feature already on by hand is not listed', J(ids(c.fo.list())) === '["skills","telegram","voice","helpers"]', J(c.fo.list()));
    c = make({ lastSeenVersion: '0.5.19' }, { voiceReady: true }); c.fo.prepare();
    check('voice input is not offered when it already works (a key is set)', !ids(c.fo.list()).includes('voice'), J(c.fo.list()));
    {
      const fo = FO.createFeatureOffers({ readSettings: () => ({ lastSeenVersion: '0.5.19' }), writeSettings: () => {}, setSetting: async () => { throw new Error('nope'); }, test: false });
      fo.prepare();
      const log = console.error; console.error = () => {};
      const res = await fo.act('memory');
      console.error = log;
      check('a toggle that fails is reported (the card keeps the row)', res.ok === false && ids(fo.list()).includes('memory'), J(res));
    }
    c = make({}); c.fo.prepare();
    check('a fresh install shows no card and records the offers as seen', c.fo.list() === null && J(c.file().featureOffersSeen) === J(FO.OFFERS.map((o) => o.key)), J(c.file()));

    const quietFo = FO.createFeatureOffers({ readSettings: () => ({ lastSeenVersion: '0.5.19' }), writeSettings: () => { throw new Error('wrote'); }, setSetting: async () => {}, test: true });
    let quiet = true;
    try { quietFo.prepare(); quietFo.list(); } catch { quiet = false; }
    check('test mode never lists or writes on its own', process.env.LUMEN_FEATURE_OFFERS_TEST ? true : quiet && quietFo.list() === null);
  }

  // ---- the renderer file and the plumbing
  {
    const fs = require('fs'); const path = require('path');
    const rd = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
    check('both chats load the card', /offer-card\.js/.test(rd('src/renderer/index.src.html')) && /offer-card\.js/.test(rd('src/renderer/chat-page.html')));
    check('the chat page and the sidebar may both ask for it', /'offers:get', 'offers:act'/.test(rd('src/features/chat-page.js')) && /'offers:get', 'offers:act'/.test(rd('src/main.js')));
    check('the settings setter refuses the card\'s own records', /featureCardNever'\) throw/.test(rd('src/settings/settings-backend.js')));
    const card = rd('src/renderer/offer-card.js');
    check('the card sits inside the empty chat (never over a conversation) and sets nothing itself', /empty\.querySelector\('\.chips'\)/.test(card) && !/setSetting|settings:set/.test(card));
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
