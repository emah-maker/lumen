// Editing a widget on the home page (run from test/units.js, or on its own with `node test/widget-config-units.js`):
// features/widget-config.js (what the page may see of a card's settings, the form laid over what is saved, the
// clock card's choices) and the do=setup / do=look actions end to end through createWidgets() against a fake
// fetch, plus the page files' rules. No Electron, no network, no window.
const fs = require('fs');
const path = require('path');
const C = require('../src/features/widget-config');
const FEED = require('../src/features/feed');
const { createWidgets, INLINE } = require('../src/features/widgets');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

module.exports = async function widgetConfigUnits(check) {
  // ---- cleanLook: the clock card's choices ----
  check('look: clock hours, style and card are one of the known values', JSON.stringify([C.cleanLook('hours', '24'), C.cleanLook('style', 'serif'), C.cleanLook('card', 'glass')]) === JSON.stringify([{ key: 'newTabClockHours', value: '24' }, { key: 'newTabClockStyle', value: 'serif' }, { key: 'newTabClockCard', value: 'glass' }]), '');
  check('look: an unknown value or key is refused', C.cleanLook('hours', '13') === null && C.cleanLook('style', 'comic') === null && C.cleanLook('__proto__', 'on') === null && C.cleanLook('constructor', 'on') === null && C.cleanLook('theme', 'dark') === null && C.cleanLook(undefined, 'on') === null, '');
  check('look: switches take on or off, nothing else', C.cleanLook('seconds', 'on').value === true && C.cleanLook('date', 'off').value === false && C.cleanLook('show', 'true') === null && C.cleanLook('seconds', '1') === null && C.cleanLook('seconds', null) === null, '');
  check('look: the name loses markup characters and is cut at 40; empty is allowed', C.cleanLook('name', ' <b>Ada</b> ').value === 'bAda/b' && C.cleanLook('name', 'x'.repeat(90)).value.length === 40 && C.cleanLook('name', '').value === '', JSON.stringify(C.cleanLook('name', ' <b>Ada</b> ')));
  check('look: the clock size and search width keep their old rules', C.cleanLook('clock', 'xl').value === 'xl' && C.cleanLook('clock', 'huge') === null && C.cleanLook('search', '640').value === 640 && C.cleanLook('search', '99999') === null && C.cleanLook('search', '1e3') === null, '');

  // ---- view: what the page sees ----
  const wx = { id: 'wwx000001', type: 'weather', wx: { units: 'c', clock: '24', places: [{ name: 'Boston, Massachusetts, United States', lat: 42.36, lon: -71.06 }, { here: true, name: 'My location' }] }, colors: 'calendar' };
  const v = C.view(wx);
  check('view: weather shows units, clock and place names only', v.units === 'c' && v.clock === '24' && v.places.join('|') === 'Boston|My location' && !JSON.stringify(v).includes('42.36'), JSON.stringify(v));
  const cal = C.view({ type: 'calendar', url: 'https://calendar.example.com/private/abc123secret/basic.ics', count: 6 });
  check('view: a calendar shows its host, never its address', cal.host === 'calendar.example.com' && cal.count === 6 && !JSON.stringify(cal).includes('abc123secret'), JSON.stringify(cal));
  check('view: a preset feed shows its id, a custom one its address', C.view({ type: 'feed', preset: 'hn', url: 'https://news.ycombinator.com/rss', count: 8 }).feed === 'hn' && C.view({ type: 'feed', preset: '', url: 'https://a.example/rss', count: 4 }).url === 'https://a.example/rss', '');
  check('view: every inline kind the page can edit answers (and an unknown one gives nothing)', typeof INLINE.weather === 'function' && typeof INLINE.worldclock === 'function' && typeof INLINE.calendar === 'function' && typeof INLINE.feed === 'function' && JSON.stringify(C.view(null)) === '{}' && JSON.stringify(C.view({ type: 'notes' })) === '{}', '');

  // ---- mergeEdit: the form over what is saved ----
  const m = C.mergeEdit(wx, { type: 'weather', title: ' Home ', city: '', units: 'f', clock: '12', drop: [1, 1, 7, -1, 'x'] });
  check('merge weather: units and clock change, a dropped place goes, the rest of the config stays', m.units === 'f' && m.wx.units === 'f' && m.wx.clock === '12' && m.wx.places.length === 1 && m.wx.places[0].name.startsWith('Boston') && m.title === 'Home' && m.colors === 'calendar' && m.wx.append === true, JSON.stringify(m));
  check('merge weather: junk values fall back to what is saved', C.mergeEdit(wx, { type: 'weather', units: 'k', clock: 'noon' }).wx.units === 'c' && C.mergeEdit(wx, { type: 'weather', units: 'k', clock: 'noon' }).wx.clock === '24', '');
  check('merge weather: a city is cut at 80 and stripped of control characters', C.mergeEdit(null, { type: 'weather', city: `Bos\u0000ton${'x'.repeat(200)}` }).city.length === 80, '');
  const wc = { type: 'worldclock', wc: { clock: 'auto', seconds: false, places: [{ name: 'Tokyo, Japan', lat: 35.7, lon: 139.7, tz: 'Asia/Tokyo' }, { name: 'Paris, France', lat: 48.85, lon: 2.35, tz: 'Europe/Paris' }] } };
  const mc = C.mergeEdit(wc, { type: 'worldclock', clock: '24', seconds: true, drop: [0], city: 'Lima' });
  check('merge world clock: seconds, clock, a dropped place and a typed city', mc.wc.seconds === true && mc.wc.clock === '24' && mc.wc.places.length === 1 && mc.wc.places[0].name.startsWith('Paris') && mc.city === 'Lima', JSON.stringify(mc));
  check('merge world clock: seconds is on only for true', C.mergeEdit(wc, { type: 'worldclock', seconds: 'true' }).wc.seconds === false, '');
  const calSaved = { type: 'calendar', url: 'https://calendar.example.com/private/abc/basic.ics', count: 5 };
  check('merge calendar: an empty address keeps the saved one', C.mergeEdit(calSaved, { type: 'calendar', url: '', count: 7 }).url === calSaved.url && C.mergeEdit(calSaved, { type: 'calendar', url: '  ', count: 7 }).count === 7, '');
  check('merge calendar: a typed https or webcal address is used', C.mergeEdit(calSaved, { type: 'calendar', url: 'webcal://other.example.com/x.ics' }).url === 'https://other.example.com/x.ics', '');
  check('merge calendar: http, javascript and spaces are not turned into addresses', ['http://a.example/x.ics', 'javascript:alert(1)', 'https://a.example/a b.ics', 'file:///etc/passwd', 'https://user:pw@a.example/x'].every((u) => !C.secureUrl(u, { allowWebcal: true })), '');
  check('merge calendar: the count is clamped to 3-8', C.mergeEdit(calSaved, { type: 'calendar', count: 99 }).count === 8 && C.mergeEdit(calSaved, { type: 'calendar', count: 0 }).count === 3 && C.mergeEdit(calSaved, { type: 'calendar', count: 'many' }).count === 5, '');
  const mf = C.mergeEdit(null, { type: 'feed', feed: 'npr', url: 'https://ignored.example/', count: 50 });
  check('merge feed: a preset wins over an address, the count is clamped to 3-12', mf.feed === 'npr' && mf.url === '' && mf.count === 12 && C.mergeEdit(null, { type: 'feed', feed: 'nope', url: 'https://a.example/rss' }).url === 'https://a.example/rss', JSON.stringify(mf));

  // ---- do=setup and do=look through createWidgets ----
  const store = { settings: {} };
  const asked = [];
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  let offline = false; // calendar and coin lookups fail while this is on
  const COINS = { bitcoin: 60000, ethereum: 3000, solana: 150 };
  const fakeFetch = async (url) => {
    asked.push(url);
    const u = new URL(url);
    if (offline && (u.hostname === 'calendar.example.com' || u.hostname === 'other.example.com')) throw new Error('offline');
    if (u.hostname === 'api.coingecko.com') {
      const body = {};
      for (const id of (u.searchParams.get('ids') || '').split(',')) if (Object.prototype.hasOwnProperty.call(COINS, id)) body[id] = { usd: COINS[id], usd_24h_change: 1.5, last_updated_at: Math.floor(Date.now() / 1000) };
      return json(body);
    }
    if (u.hostname === 'geocoding-api.open-meteo.com') {
      const name = u.searchParams.get('name');
      if (name === 'Nowhere') return json({});
      return json({ results: [{ name, admin1: 'Region', country: 'Land', latitude: 10 + name.length, longitude: 20 + name.length, timezone: 'Asia/Tokyo' }] });
    }
    if (u.hostname === 'api.open-meteo.com') return json({ timezone: 'Asia/Tokyo', daily: { time: ['2026-01-01'], sunrise: ['2026-01-01T06:00'], sunset: ['2026-01-01T18:00'] } });
    if (u.hostname === 'calendar.example.com' || u.hostname === 'other.example.com') return new Response('BEGIN:VCALENDAR\r\nX-WR-CALNAME:Team\r\nEND:VCALENDAR\r\n', { status: 200, headers: { 'content-type': 'text/calendar' } });
    if (u.hostname === 'news.ycombinator.com' || u.hostname === 'feed.example.com') return new Response('<rss><channel><title>Site</title><item><title>Headline</title><link>https://a.example/1</link></item></channel></rss>', { status: 200, headers: { 'content-type': 'application/rss+xml' } });
    return new Response('', { status: 404 });
  };
  const make = () => createWidgets({ readSettings: () => store.settings, writeSettings: (s) => { store.settings = JSON.parse(JSON.stringify(s)); }, fetch: fakeFetch, getSecret: () => null, setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}), rateMax: () => 1000 });
  const W = make();
  const act = (id, cfg) => W.act({ id, do: 'setup', cfg, create: id === 'wcreate' });
  const parse = (qs) => W.actionFrom(`lumen://newtab/?${qs}`);
  const q = (o) => new URLSearchParams(o).toString();

  let r = await act('wcreate', { type: 'weather', title: '', city: 'Boston', units: 'c', clock: '24', drop: [] });
  check('setup: a Weather card is added from a city (units and clock kept)', r.ok === true && W.list().length === 1 && W.list()[0].wx.units === 'c' && W.list()[0].wx.clock === '24' && W.list()[0].wx.places[0].name.startsWith('Boston'), JSON.stringify(r));
  const wid = r.id;
  r = await act(wid, { type: 'weather', title: 'Where I live', city: 'Cairo', units: 'f', clock: 'auto', drop: [] });
  check('setup: a typed city is added to the places, units change, the title is kept', r.ok && W.list()[0].wx.places.length === 2 && W.list()[0].wx.units === 'f' && W.list()[0].title === 'Where I live', JSON.stringify(W.list()[0].wx));
  r = await act(wid, { type: 'weather', title: 'Where I live', city: '', units: 'f', clock: 'auto', drop: [0] });
  check('setup: a place can be removed again', r.ok && W.list()[0].wx.places.length === 1 && W.list()[0].wx.places[0].name.startsWith('Cairo'), JSON.stringify(W.list()[0].wx.places));
  r = await act(wid, { type: 'weather', title: '', city: '', units: 'f', clock: 'auto', drop: [0] });
  check('setup: removing the last place with no new city is refused and changes nothing', r.ok === false && /city/i.test(r.message) && W.list()[0].wx.places.length === 1, JSON.stringify(r));
  r = await act(wid, { type: 'weather', city: 'Nowhere', units: 'f', clock: 'auto', drop: [] });
  check('setup: a city that is not found says so and changes nothing', r.ok === false && /No place called/.test(r.message) && W.list()[0].wx.places.length === 1, JSON.stringify(r));
  check('setup: the page sees the weather card’s editable settings', W.forPage().find((x) => x.id === wid).setup.places.join() === 'Cairo' && W.forPage().find((x) => x.id === wid).setup.units === 'f', '');

  r = await act('wcreate', { type: 'worldclock', city: 'Lima', clock: '12', seconds: true, drop: [] });
  check('setup: a World clock is added with seconds on', r.ok && W.list().find((x) => x.id === r.id).wc.seconds === true && W.list().find((x) => x.id === r.id).wc.clock === '12', JSON.stringify(r));
  const cid = r.id;
  r = await act(cid, { type: 'worldclock', city: 'Oslo City', clock: '12', seconds: true, drop: [] });
  check('setup: a World clock gains a place', r.ok && W.list().find((x) => x.id === cid).wc.places.length === 2, JSON.stringify(r));

  r = await act('wcreate', { type: 'calendar', url: 'https://calendar.example.com/private/abc123/basic.ics', count: 4 });
  check('setup: a Calendar is added from an https address (count kept)', r.ok && W.list().find((x) => x.id === r.id).count === 4, JSON.stringify(r));
  const calId = r.id;
  const before = W.list().find((x) => x.id === calId).url;
  r = await act(calId, { type: 'calendar', url: '', count: 6 });
  check('setup: editing a Calendar with the address left empty keeps the address', r.ok && W.list().find((x) => x.id === calId).url === before && W.list().find((x) => x.id === calId).count === 6, JSON.stringify(r));
  check('setup: the page is never sent the calendar address', !JSON.stringify(W.forPage()).includes('abc123'), '');
  const callsBefore = asked.length;
  r = await act(calId, { type: 'calendar', url: 'http://calendar.example.com/x.ics', count: 6 });
  check('setup: an http address is refused before anything is fetched', r.ok === false && asked.length === callsBefore && W.list().find((x) => x.id === calId).url === before, JSON.stringify(r));
  r = await act('wcreate', { type: 'calendar', url: '', count: 5 });
  check('setup: a new Calendar needs an address', r.ok === false, JSON.stringify(r));

  r = await act('wcreate', { type: 'feed', feed: 'hn', url: '', count: 5 });
  check('setup: a Feed is added from a preset', r.ok && W.list().find((x) => x.id === r.id).preset === 'hn' && W.list().find((x) => x.id === r.id).count === 5, JSON.stringify(r));
  const fid = r.id;
  r = await act(fid, { type: 'feed', feed: '', url: 'https://feed.example.com/rss', count: 3 });
  check('setup: a Feed is changed to an address of its own', r.ok && W.list().find((x) => x.id === fid).url === 'https://feed.example.com/rss' && W.list().find((x) => x.id === fid).preset === '', JSON.stringify(r));
  r = await act(fid, { type: 'feed', feed: '', url: 'http://feed.example.com/rss', count: 3 });
  check('setup: an http feed address is refused', r.ok === false, JSON.stringify(r));
  r = await act(wid, { type: 'feed', feed: 'hn', count: 3 });
  check('setup: a form for the wrong kind of card is refused', r.ok === false, JSON.stringify(r));

  // ---- a calendar edit that leaves the address alone needs no network ----
  const calNow = W.list().find((x) => x.id === calId);
  check('skip-fetch rule: an empty address, or the saved one typed again, keeps the address (webcal:// counts as https)', C.keepsAddress(calNow, { type: 'calendar', url: '', count: 4 }) && C.keepsAddress(calNow, { type: 'calendar', url: calNow.url }) && C.keepsAddress(calNow, { type: 'calendar', url: calNow.url.replace('https://', 'webcal://') }), '');
  check('skip-fetch rule: a new address, a new card, another kind or a card with no address fetches', !C.keepsAddress(calNow, { type: 'calendar', url: 'https://other.example.com/x.ics' }) && !C.keepsAddress(null, { type: 'calendar', url: '' }) && !C.keepsAddress(calNow, { type: 'feed', url: '' }) && !C.keepsAddress({ type: 'calendar', url: '' }, { type: 'calendar', url: '' }), '');
  offline = true;
  r = await act(calId, { type: 'calendar', url: '', count: 3 });
  check('setup: changing only a Calendar’s count saves while offline, and keeps the address', r.ok === true && W.list().find((x) => x.id === calId).count === 3 && W.list().find((x) => x.id === calId).url === before, JSON.stringify(r));
  r = await act(calId, { type: 'calendar', url: 'https://other.example.com/x.ics', count: 3 });
  check('setup: a different Calendar address still has to be fetched (and fails offline, changing nothing)', r.ok === false && W.list().find((x) => x.id === calId).url === before, JSON.stringify(r));
  offline = false;

  // ---- keep at least one place ----
  const two = { type: 'weather', wx: { units: 'f', clock: 'auto', places: [{ name: 'Boston', lat: 1, lon: 2 }, { name: 'Cairo', lat: 3, lon: 4 }] } };
  check('keep one place: dropping every place with no city typed is refused, with the reason', /at least one place/i.test(C.checkEdit(two, { type: 'weather', city: '', drop: [0, 1] })) && /at least one place/i.test(C.checkEdit({ type: 'worldclock', wc: { places: [{ name: 'Tokyo' }] } }, { type: 'worldclock', drop: [0] })), '');
  check('keep one place: dropping some, or all with a city typed, or none, is fine', C.checkEdit(two, { type: 'weather', drop: [0] }) === '' && C.checkEdit(two, { type: 'weather', city: 'Lima', drop: [0, 1] }) === '' && C.checkEdit(two, { type: 'weather', city: '  ', drop: [] }) === '' && C.checkEdit(null, { type: 'weather', city: 'Lima' }) === '', '');
  r = await act(wid, { type: 'weather', city: '', units: 'f', clock: 'auto', drop: [0] });
  check('keep one place: main says "keep at least one place", not "type a city"', r.ok === false && /Keep at least one place/.test(r.message), JSON.stringify(r));

  // ---- Undo after a form save ----
  const undoBefore = { count: W.list().find((x) => x.id === calId).count, title: W.list().find((x) => x.id === calId).title };
  r = await act(calId, { type: 'calendar', title: 'Team', url: '', count: 8 });
  check('undo: a form save on an existing card says it can be undone; a new card does not', r.ok && r.undo === true && W.list().find((x) => x.id === calId).count === 8 && (await act('wcreate', { type: 'feed', feed: 'hn', url: '', count: 4 })).undo === false, JSON.stringify([r, W.list().find((x) => x.id === calId).count]));
  const placeNow = JSON.stringify([W.list().find((x) => x.id === calId).x, W.list().find((x) => x.id === calId).y]);
  check('undo: do=restore puts the card’s earlier settings back (count and title), where the card now is', (await W.act({ id: calId, do: 'restore' })) === true && W.list().find((x) => x.id === calId).count === undoBefore.count && (W.list().find((x) => x.id === calId).title || '') === (undoBefore.title || '') && W.list().find((x) => x.id === calId).url === before && JSON.stringify([W.list().find((x) => x.id === calId).x, W.list().find((x) => x.id === calId).y]) === placeNow, JSON.stringify(W.list().find((x) => x.id === calId)));
  check('undo: it works once; a second restore of a card that is there does nothing', (await W.act({ id: calId, do: 'restore' })) === false, '');
  const feedNow = W.list().find((x) => x.id === fid);
  await act(fid, { type: 'feed', feed: 'hn', url: '', count: 5 });
  await W.act({ id: fid, do: 'restore' });
  check('undo: a feed goes back to the address it had', W.list().find((x) => x.id === fid).url === feedNow.url && W.list().find((x) => x.id === fid).preset === feedNow.preset, JSON.stringify(W.list().find((x) => x.id === fid)));

  // ---- the clock panel's Reset to defaults ----
  await W.act(parse(q({ widget: 'wlook', do: 'look', k: 'style', v: 'serif' })));
  await W.act(parse(q({ widget: 'wlook', do: 'look', k: 'seconds', v: 'on' })));
  await W.act(parse(q({ widget: 'wlook', do: 'look', k: 'name', v: 'Ada' })));
  const reset = parse(q({ widget: 'wlook', do: 'look', k: 'defaults', v: 'all' }));
  check('actionFrom: look k=defaults is a reset (and is not a Settings key)', reset.defaults === true && !reset.invalid, JSON.stringify(reset));
  await W.act(reset);
  check('look: Reset to defaults puts the look back, and keeps the name', store.settings.newTabClockStyle === 'classic' && store.settings.newTabClockSeconds === false && store.settings.newTabClockDate === true && store.settings.newTabClockCard === 'none' && store.settings.newTabClockHours === 'auto' && store.settings.newTabGreetingFont === 'classic' && store.settings.newTabName === 'Ada', JSON.stringify(store.settings));
  check('look: every default is a Settings key the panel can already set', Object.keys(C.LOOK_DEFAULTS).every((key) => Object.values(C.LOOK).some((l) => l.key === key)), '');

  // ---- Crypto: the coin list ----
  r = await act('wcreate', { type: 'crypto', add: 'bitcoin, ethereum' });
  const cry = r.id;
  check('crypto: a card is made from coin ids', r.ok && W.list().find((x) => x.id === cry).mk.coins.map((c) => c.id).join() === 'bitcoin,ethereum', JSON.stringify(r));
  check('crypto: the page sees ids and tickers, nothing else', JSON.stringify(W.forPage().find((x) => x.id === cry).setup.coins) === JSON.stringify([{ id: 'bitcoin', sym: 'BTC' }, { id: 'ethereum', sym: 'ETH' }]), '');
  const cNow = W.list().find((x) => x.id === cry);
  check('crypto validation: not an id, nothing left, or too many', /isn.t a CoinGecko id/.test(C.checkEdit(cNow, { type: 'crypto', add: 'bit coin!' })) && /isn.t a CoinGecko id/.test(C.checkEdit(cNow, { type: 'crypto', add: '../x' })) && /at least one coin/.test(C.checkEdit(cNow, { type: 'crypto', drop: [0, 1] })) && /Up to 12/.test(C.checkEdit(cNow, { type: 'crypto', add: 'a1 a2 a3 a4 a5 a6 a7 a8 a9 a10 a11' })), '');
  const merged = C.mergeEdit(cNow, { type: 'crypto', drop: [0], add: 'Solana, solana, dogecoin=DOGE' });
  check('crypto validation: remove one, add one, add "id=SYM"; ids are lower-cased and repeats ignored', C.checkEdit(cNow, { type: 'crypto', drop: [0], add: 'Solana, solana, dogecoin=DOGE' }) === '' && merged.mk.coins.map((c) => `${c.id}:${c.sym}`).join() === 'ethereum:ETH,solana:SOL,dogecoin:DOGE' && merged.mk.added.join() === 'solana,dogecoin', JSON.stringify(merged));
  r = await act(cry, { type: 'crypto', drop: [], add: 'notacoin' });
  check('crypto: an id CoinGecko has no price for is refused and changes nothing', r.ok === false && /no price for/.test(r.message) && W.list().find((x) => x.id === cry).mk.coins.length === 2, JSON.stringify(r));
  r = await act(cry, { type: 'crypto', drop: [0], add: 'solana' });
  check('crypto: a coin is added and one removed in one save', r.ok && r.undo && W.list().find((x) => x.id === cry).mk.coins.map((c) => c.id).join() === 'ethereum,solana', JSON.stringify(r));
  await W.act({ id: cry, do: 'restore' });
  check('crypto: Undo brings the earlier coins back', W.list().find((x) => x.id === cry).mk.coins.map((c) => c.id).join() === 'bitcoin,ethereum', '');
  r = await act(cry, { type: 'crypto', drop: [0, 1], add: '' });
  check('crypto: removing every coin is refused', r.ok === false && /at least one coin/.test(r.message) && W.list().find((x) => x.id === cry).mk.coins.length === 2, JSON.stringify(r));
  check('crypto: the paper portfolio is kept through a coin edit', Boolean(W.list().find((x) => x.id === cry).pf), '');

  // ---- the browser-side checks of the URL the page navigates to ----
  check('actionFrom: setup is accepted for the new kinds and refused for kinds that need a key', parse(q({ widget: 'wcreate', do: 'setup', cfg: JSON.stringify({ type: 'feed' }) })).cfg.type === 'feed' && parse(q({ widget: 'wcreate', do: 'setup', cfg: JSON.stringify({ type: 'github' }) })).invalid === true && parse(q({ widget: 'wcreate', do: 'setup', cfg: JSON.stringify({ type: 'todoist' }) })).invalid === true, '');
  check('actionFrom: setup refuses a form that is too long', parse(q({ widget: 'wcreate', do: 'setup', cfg: JSON.stringify({ type: 'feed', url: 'x'.repeat(13000) }) })).invalid === true, '');
  const look = parse(q({ widget: 'wlook', do: 'look', k: 'hours', v: '24' }));
  check('actionFrom: look carries the Settings key and checked value', look.key === 'newTabClockHours' && look.value === '24', JSON.stringify(look));
  check('actionFrom: look refuses what is not allowed', parse(q({ widget: 'wlook', do: 'look', k: 'hours', v: '25' })).invalid === true && parse(q({ widget: 'wlook', do: 'look', k: 'theme', v: 'dark' })).invalid === true && parse(q({ widget: 'wlook', do: 'look', k: 'seconds', v: 'maybe' })).invalid === true, '');
  const off = parse(q({ widget: 'wlook', do: 'look', k: 'date', v: 'off' }));
  check('actionFrom: look can switch something off (false is a value)', off.key === 'newTabClockDate' && off.value === false, JSON.stringify(off));
  await W.act(off);
  check('look: the choice is written to the settings the Settings page reads', store.settings.newTabClockDate === false, JSON.stringify(store.settings));
  await W.act(parse(q({ widget: 'wlook', do: 'look', k: 'name', v: '' })));
  check('look: an empty name clears it', store.settings.newTabName === '', JSON.stringify(store.settings));

  // ---- the page files ----
  const setupSrc = read('src/renderer/newtab-setup.js');
  const presetIds = FEED.PRESETS.map((p) => p.id);
  check('page: the editor’s feed list is the browser’s preset list (same ids, same names)', FEED.PRESETS.every((p) => setupSrc.includes(`['${p.id}', '${p.name}']`)) && (setupSrc.match(/\['[a-z-]+', '[^']+'\]/g) || []).filter((s) => presetIds.some((id) => s.startsWith(`['${id}'`))).length === presetIds.length, '');
  check('page: newtab-setup.js builds everything with DOM calls and textContent (no markup strings, no eval, no network)', !/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|fetch\(|XMLHttpRequest|WebSocket/.test(setupSrc), '');
  const html = read('src/renderer/newtab.html');
  const widgetsSrc = read('src/renderer/newtab-widgets.js');
  check('page: the CSP is untouched', html.includes(`content="default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src data: file:; frame-src https:; form-action https:"`), '');
  check('page: the clock’s pencil is a labelled button in the header, shown on hover or focus and hidden while Edit layout is on', /<button class="w-icon-btn hdr-edit" id="hdr-edit" type="button" aria-label="Edit clock and greeting"/.test(html) && /header:focus-within \.hdr-edit/.test(html) && /body\.w-editing \.hdr-edit \{ display: none/.test(html), '');
  check('page: Escape closes the editor and focus goes back (to the pencil, gear or card)', /e\.key === 'Escape'/.test(setupSrc) && /back\?\.focus\?\.\(\)/.test(setupSrc) && /aria-modal/.test(setupSrc), '');
  check('page: a card that failed to load gets the pencil too (from w.setup), and an Edit settings button beside Try again', /function editPencil/.test(widgetsSrc) && /w\.setup && window\.widgetSetup\?\.can\(w\.type\)/.test(widgetsSrc) && /Edit settings/.test(widgetsSrc) && (widgetsSrc.match(/editPencil\(w, title, card\)/g) || []).length === 3, '');
  check('page: the name is saved as it is typed (400 ms), on change, and when the panel closes', /setTimeout\(sendName, 400\)/.test(setupSrc) && /if \(flushName\)/.test(setupSrc), '');
  check('page: an answer that arrives after the panel closed is toasted (and an error says why)', /const here = panel === back/.test(setupSrc) && /didn’t save: \$\{why\}/.test(setupSrc) && /error \? 'alert'/.test(setupSrc), '');
  check('page: while a panel is open the page behind it is inert, the panel takes focus, and Escape does not reach Edit layout', /setAttribute\('inert', ''\)/.test(setupSrc) && /removeAttribute\('inert'\)/.test(setupSrc) && /box\.tabIndex = -1/.test(setupSrc) && /stopImmediatePropagation/.test(setupSrc) && /widgetSetup\?\.isOpen\?\.\(\)\) return/.test(read('src/renderer/newtab-widgets-grid.js')), '');
  check('page: the clock panel uses segmented controls (aria-pressed buttons, arrow keys) and has Reset to defaults', /function segmented/.test(setupSrc) && /aria-pressed/.test(setupSrc) && /ArrowRight/.test(setupSrc) && /Reset to defaults/.test(setupSrc) && /k: 'defaults'/.test(setupSrc) && !/bind\('hours', select/.test(setupSrc), '');
  check('page: Save waits (and says "Keep at least one place") while every place is marked for removal', /Keep at least one place/.test(setupSrc) && /ok\.disabled = Boolean\(g\)/.test(setupSrc), '');
  check('page: pencils are faint (about .35) until hover or focus, and the clock’s pencil sits after the greeting, not at the edge', /\.w-icon-btn \{[^}]*opacity: 0\.35/.test(html) && /\.w-card:hover \.w-icon-btn[^{]*\{ opacity: 1/.test(html) && /<div class="greet">\s*<h1 id="greeting">[^<]*<\/h1>\s*<button class="w-icon-btn hdr-edit"/.test(html) && !/\.hdr-edit \{ position: absolute/.test(html), '');
  check('page: a form save offers the Undo toast through Edit layout’s own undo stack', /configChanged/.test(setupSrc) && /kind: 'config'/.test(read('src/renderer/newtab-edit.js')), '');
  check('page: the clock card’s gear opens the clock panel in Edit layout', /wsyshead'\) \{ window\.widgetSetup\?\.openLook/.test(read('src/renderer/newtab-widgets-grid.js')), '');
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
