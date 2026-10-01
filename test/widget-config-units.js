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
  const fakeFetch = async (url) => {
    asked.push(url);
    const u = new URL(url);
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
  const parse = (q) => W.actionFrom(`lumen://newtab/?${q}`);

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

  // ---- the browser-side checks of the URL the page navigates to ----
  const q = (o) => new URLSearchParams(o).toString();
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
  check('page: the CSP is untouched', html.includes(`content="default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src data: file:; frame-src https:; form-action https:"`), '');
  check('page: the clock’s pencil is a labelled button in the header, shown on hover or focus and hidden while Edit layout is on', /<button class="w-icon-btn hdr-edit" id="hdr-edit" type="button" aria-label="Edit clock and greeting"/.test(html) && /header:focus-within \.hdr-edit/.test(html) && /body\.w-editing \.hdr-edit \{ display: none/.test(html), '');
  check('page: Escape closes the editor and focus goes back (to the pencil, gear or card)', /e\.key === 'Escape'/.test(setupSrc) && /back\?\.focus\?\.\(\)/.test(setupSrc) && /aria-modal/.test(setupSrc), '');
  check('page: the clock card’s gear opens the clock panel in Edit layout', /wsyshead'\) \{ window\.widgetSetup\?\.openLook/.test(read('src/renderer/newtab-widgets-grid.js')), '');
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
