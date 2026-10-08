// The Spotify (and Apple Music) card's search, made fast, without Electron, Spotify or the network:
//   - search-as-you-type: the 200 ms pause, two letters at least, Enter at once, the cache of the last queries (50, ten minutes, a longer earlier
//     query shown for what is typed so far), a newer search outrunning an older one (features/music-search-core.js);
//   - Spotify's Web API as the fast path: one request (GET /v1/search, every kind, market=from_token) whenever the account is connected, also when
//     the music plays in Lumen's own page; the page's two routes only when it is not (or when the API refuses);
//   - a search's own request budget, apart from the polling budget (and the other way round);
//   - pictures only for the rows the card has on screen (asked by id, through the search budget);
//   - the hidden page is started when the box is focused and is not unloaded for idleness while the search is open;
//   - the card's page code uses all of it (lazy pictures, the observer, the cache, the pause) and loads the core before the card.
// The page script against saved open.spotify.com pages (partial results, typing into the page's own box, cancelling) is test/spotify-dom-units.js.
// Runs on its own (npm run test:units picks up test/*-units.js).
const fs = require('fs');
const path = require('path');
const MS = require('../src/features/music-search-core');
const SV = require('../src/features/spotify-view');
const { createWidgets } = require('../src/features/widgets');
const { createEngine } = require('../src/features/spotify-engine');

const CLIENT = '0123456789abcdef0123456789abcdef';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.join(__dirname, '..', 'src');

// ---------------------------------------------------------------------------------------------------------------------------------------------
function coreChecks(check) {
  // fake timers
  let clock = 0;
  const timers = [];
  const st = (f, ms) => { const t = { f, at: clock + ms, dead: false }; timers.push(t); return t; };
  const ct = (t) => { t.dead = true; };
  const advance = (ms) => { const end = clock + ms; for (;;) { const due = timers.filter((t) => !t.dead && t.at <= end).sort((a, b) => a.at - b.at)[0]; if (!due) break; clock = due.at; due.dead = true; due.f(); } clock = end; };
  const sent = [];
  const shown = [];
  const cache = MS.createCache({ now: () => clock });
  const s = MS.createScheduler({ send: (t) => sent.push(t), shown: (t) => shown.push(t), cache, scope: 'c1', setTimeout: st, clearTimeout: ct });

  check('search core: the pause is 200 ms, a term needs two letters, the cache keeps 50 queries for ten minutes', MS.DEBOUNCE_MS === 200 && MS.MIN_CHARS === 2 && MS.MAX_QUERIES === 50 && MS.TTL_MS === 10 * 60e3, JSON.stringify([MS.DEBOUNCE_MS, MS.MIN_CHARS, MS.MAX_QUERIES, MS.TTL_MS]));
  s.type('d');
  advance(1000);
  check('search core: one letter is not searched as you type', sent.length === 0 && s.type('d') === 'short', JSON.stringify(sent));
  s.type('da'); advance(199);
  check('search core: a search is asked 200 ms after the last key, not before', sent.length === 0 && s.pending(), JSON.stringify(sent));
  advance(2);
  check('search core: …and then it is asked once', sent.join() === 'da' && !s.pending(), JSON.stringify(sent));
  sent.length = 0;
  s.type('daf'); advance(100); s.type('daft'); advance(100); s.type('daft '); advance(100); s.type('daft p'); advance(150);
  check('search core: keys faster than the pause restart it: nothing is asked while typing', sent.length === 0, JSON.stringify(sent));
  advance(100);
  check('search core: …one search, for the last text, once the typing stops', sent.join() === 'daft p', JSON.stringify(sent));
  sent.length = 0;
  s.type('daft pu'); advance(50);
  s.enter('daft punk');
  check('search core: Enter asks at once (no pause) and drops the pending pause', sent.join() === 'daft punk' && !s.pending(), JSON.stringify(sent));
  advance(1000);
  check('search core: …the dropped pause asks nothing later', sent.join() === 'daft punk', JSON.stringify(sent));
  sent.length = 0;
  s.enter('x');
  check('search core: Enter searches even one letter (the user asked for it)', sent.join() === 'x', JSON.stringify(sent));
  sent.length = 0;
  s.type('abc'); s.cancel(); advance(1000);
  check('search core: cancel drops a search that is waiting out its pause (closing the box)', sent.length === 0, JSON.stringify(sent));
  s.type('abc'); advance(300); sent.length = 0;
  s.type('abc'); advance(300);
  check('search core: the same words again straight after are not asked twice', sent.length === 0, JSON.stringify(sent));
  s.enter('abc');
  check('search core: …but Enter on them asks again (the user wants a fresh look)', sent.join() === 'abc', JSON.stringify(sent));

  // the cache
  sent.length = 0; shown.length = 0;
  cache.put('c1', 'Daft  Punk', [{ id: 'A', title: 'One More Time' }]);
  s.forget();
  s.type('daft punk'); advance(250);
  check('search core: a term in the cache (case and spacing aside) is shown at once and not asked', shown.join() === 'daft punk' && sent.length === 0, JSON.stringify([shown, sent]));
  s.forget(); s.enter('DAFT PUNK');
  check('search core: Enter on a cached term shows it at once too', shown.length === 2 && sent.length === 0, JSON.stringify([shown, sent]));
  clock += MS.TTL_MS + 1;
  s.forget(); s.enter('daft punk');
  check('search core: after ten minutes the cached rows are stale: the term is asked again', sent.join() === 'daft punk' && cache.get('c1', 'daft punk') === null, JSON.stringify(sent));

  const c2 = MS.createCache({ now: () => clock });
  c2.put('c1', 'beatles', [{ id: 'B' }]);
  c2.put('c1', 'beatles abbey road', [{ id: 'C' }]);
  clock += 1000;
  c2.put('c1', 'bee gees', [{ id: 'D' }]);
  c2.put('c2', 'beat it', [{ id: 'E' }]);
  check('search cache: a typed beginning finds the freshest longer query that starts with it (the same card only), not an exact or unrelated one', c2.prefix('c1', 'bea').term === 'beatles abbey road' || c2.prefix('c1', 'bea').term === 'beatles', c2.prefix('c1', 'bea')?.term);
  check('search cache: …it is the most recently asked of them', (() => { c2.put('c1', 'beatles', [{ id: 'B2' }]); return c2.prefix('c1', 'bea').term === 'beatles'; })(), '');
  check('search cache: another card\'s queries are not offered; a one-letter beginning finds nothing; an exact term is a get, not a prefix', c2.prefix('c1', 'beat it') === null && c2.prefix('c1', 'b') === null && c2.prefix('c1', 'beatles') !== null && c2.prefix('c1', 'beatles').term === 'beatles abbey road' && c2.get('c1', 'beatles').rows[0].id === 'B2', JSON.stringify(c2.prefix('c1', 'beatles')));
  const c3 = MS.createCache({ now: () => clock });
  for (let i = 0; i < 60; i++) c3.put('s', `query ${i}`, [{ id: `i${i}` }]);
  check('search cache: only the last 50 queries are kept (the oldest go first)', c3.size() === 50 && c3.get('s', 'query 0') === null && c3.get('s', 'query 9') === null && c3.get('s', 'query 10') !== null && c3.get('s', 'query 59') !== null, String(c3.size()));
  const c4 = MS.createCache({ now: () => clock, max: 3 });
  c4.put('s', 'a1', []); c4.put('s', 'b1', []); c4.put('s', 'c1', []);
  c4.get('s', 'a1'); // (used again: now the newest)
  c4.put('s', 'd1', []);
  check('search cache: a query used again is kept longer than one that was not (least recently used goes)', c4.get('s', 'a1') !== null && c4.get('s', 'b1') === null, '');
  c4.put('s', 'e1', null); c4.put('s', '   ', []);
  check('search cache: junk is not stored', c4.size() === 3, String(c4.size()));

  // pictures
  const rows = [{ id: 'a', thumb: 'data:x' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, ...Array.from({ length: 20 }, (_, i) => ({ id: `r${i}` }))];
  const asked = new Set(['c']);
  check('search core: pictures are asked for rows that have none and were not asked for, at most twelve at a time', JSON.stringify(MS.thumbsToAsk(rows, asked).slice(0, 3)) === '["b","d","r0"]' && MS.thumbsToAsk(rows, asked).length === 12 && MS.thumbsToAsk([], asked).length === 0 && MS.thumbsToAsk(null, asked).length === 0, JSON.stringify(MS.thumbsToAsk(rows, asked)));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A fake Spotify Web API: every call logged, an answer after `latency` ms, per-path control.
function fakeApi(opts = {}) {
  const log = [];
  const reply = (status, body) => new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status });
  const track = (id, name, artist = 'Daft Punk') => ({ id, type: 'track', name, duration_ms: 200000, artists: [{ name: artist }], album: { name: 'Discovery', images: [{ url: `https://i.scdn.co/image/${id}`, width: 64 }] } });
  const fetch = async (url, o = {}) => {
    const u = new URL(url);
    const entry = { method: o.method || 'GET', host: u.host, path: u.pathname + u.search, at: Date.now() };
    log.push(entry);
    if (u.host === 'accounts.spotify.com') return reply(200, { access_token: 'ACCESS', token_type: 'Bearer', expires_in: 3600 });
    if (u.host === 'i.scdn.co') return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    if (u.host !== 'api.spotify.com') return reply(404);
    const p = u.pathname.replace(/^\/v1/, '');
    if (p === '/search') {
      const q = u.searchParams.get('q');
      const k = q.replace(/[^A-Za-z0-9]/g, '');
      if (opts.latency) await sleep(typeof opts.latency === 'function' ? opts.latency(q) : opts.latency);
      if (opts.searchStatus) return reply(opts.searchStatus, { error: { status: opts.searchStatus } });
      return reply(200, { tracks: { items: [track(`T1${k}`, `${q} one`), track(`T2${k}`, `${q} two`)] }, albums: { items: [{ id: `AL${k}`, name: `${q} album`, artists: [{ name: 'Daft Punk' }], release_date: '2001-03-12', images: [{ url: `https://i.scdn.co/image/AL${k}`, width: 300 }] }] }, artists: { items: [] }, playlists: { items: [null] } });
    }
    if (p === '/me/player') return reply(204);
    if (/^\/me\//.test(p)) return reply(200, { items: [] });
    return reply(404);
  };
  return { fetch, log, searches: () => log.filter((l) => l.path.startsWith('/v1/search')) };
}

async function apiChecks(check) {
  // ---- Play as Lumen card, the account connected to the Web API: the API answers ----
  const calls = { searched: [], warmed: 0, thumbs: [] };
  const engine = {
    read: async () => ({ mode: 'status', state: 'idle', title: '', artist: '', album: '', progressMs: 0, durationMs: 0, at: 0, source: 'engine', kind: 'none', reason: '', art: '', device: '', signedIn: true, results: [{ id: 'PAGE1', kind: 'song', title: 'From the page' }], query: 'page term', searching: false, searchOk: true }),
    control: async () => true, seek: () => true, playItem: () => true, playNext: () => false, playLater: () => false, signIn: () => true, refreshLists: () => {}, reload: () => {},
    search: (q) => { calls.searched.push(q); return true; }, warm: () => { calls.warmed++; return true; }, loadThumbs: (ids) => { calls.thumbs.push(ids); return true; }, searchMore: () => true,
  };
  const api = fakeApi({ latency: 150 });
  let settings = { homeWidgets: [{ id: 'wstat00001', type: 'spotify', mode: 'status', clientId: CLIENT, art: true, x: 0, y: 0, w: 6, h: 5 }] };
  let secret = 'REFRESH';
  const w = createWidgets({ readSettings: () => settings, writeSettings: (s) => { settings = JSON.parse(JSON.stringify(s)); }, fetch: api.fetch, getSecret: () => secret, setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}), spotifyEngine: engine, rateMax: () => 1e6 });
  const id = 'wstat00001';
  const data = () => w.cache.get(id)?.data;
  await w.refresh(w.list()[0], { force: true });
  check('api fast path: the card is the engine\'s (what is playing is the page\'s), with the page\'s own rows until a search is asked', data().query === 'page term' && data().results[0].id === 'PAGE1', JSON.stringify(data()).slice(0, 160));

  const t0 = Date.now();
  await w.act({ id, do: 'esearch', text: 'daft punk' });
  const took = Date.now() - t0;
  check('api fast path: with the account connected, a search in "Play as Lumen" mode is ONE Web API request (every kind, ten each, the account\'s market), not two page routes', api.searches().length === 1 && /^\/v1\/search\?q=daft%20punk&type=track,album,artist,playlist&limit=10&market=from_token$/.test(api.searches()[0].path) && calls.searched.length === 0, JSON.stringify([api.searches().map((l) => l.path), calls.searched]));
  check('api fast path: …the card has the rows at once (about the one request\'s time: 150 ms mocked)', data().query === 'daft punk' && data().results.map((r) => r.kind).join() === 'song,song,album' && data().searchOk === true && data().searching === false && took >= 140 && took < 600, JSON.stringify([took, data().query, data().results.map((r) => r.kind)]));
  check('api fast path: the rows are the card\'s (ids the page plays by, no picture addresses sent to the page)', data().results.every((r) => /^[A-Za-z0-9]+$/.test(r.id) && r.images === undefined) && data().results[0].id === 'T1daftpunk', JSON.stringify(data().results[0]));
  check('api fast path: the engine\'s page is started meanwhile (a click on a row plays in it, no cold start then)', calls.warmed >= 1, String(calls.warmed));
  check('api fast path: no picture is fetched with the answer (the card asks for the rows it shows)', api.log.every((l) => l.host !== 'i.scdn.co'), JSON.stringify(api.log.map((l) => l.host)));

  // lazy pictures
  const dd = w.actionFrom(`file:///newtab.html?widget=${id}&do=ethumb&arg=${encodeURIComponent('T1a,T2b')}`);
  check('pictures: ethumb takes a comma-separated list of safe ids, at most twelve; junk is cut; none left is refused', dd.ids.join() === 'T1a,T2b' && w.actionFrom(`file:///newtab.html?widget=${id}&do=ethumb&arg=${encodeURIComponent(Array.from({ length: 30 }, (_, i) => `i${i}`).join(','))}`).ids.length === 12 && w.actionFrom(`file:///newtab.html?widget=${id}&do=ethumb&arg=${encodeURIComponent('a b,../x,<s>')}`).invalid === true && w.actionFrom(`file:///newtab.html?widget=${id}&do=ethumb`).invalid === true, JSON.stringify(dd));
  const idsAll = data().results.map((r) => r.id);
  await w.act({ id, do: 'ethumb', ids: [idsAll[0], idsAll[2], 'NOT-A-ROW'] });
  const withPics = data().results;
  const fetchedPics = api.log.filter((l) => l.host === 'i.scdn.co').map((l) => l.path);
  check('pictures: only the rows named (that exist) are fetched: two pictures for two rows, nothing for the other row or the id that is not a row', fetchedPics.length === 2 && withPics[0].thumb.startsWith('data:image/') && withPics[1].thumb === '' && withPics[2].thumb.startsWith('data:image/'), JSON.stringify([fetchedPics, withPics.map((r) => r.thumb.slice(0, 11))]));
  await w.act({ id, do: 'ethumb', ids: [idsAll[0], idsAll[2]] });
  check('pictures: asked again, a picture already there (or already asked) is not fetched again', api.log.filter((l) => l.host === 'i.scdn.co').length === 2, String(api.log.filter((l) => l.host === 'i.scdn.co').length));

  // a newer search outruns an older one still in flight
  const slowApi = fakeApi({ latency: (q) => (q === 'slow term' ? 400 : 20) });
  let s2 = { homeWidgets: [{ id: 'wstat00002', type: 'spotify', mode: 'status', clientId: CLIENT, art: true, x: 0, y: 0, w: 6, h: 5 }] };
  const w2 = createWidgets({ readSettings: () => s2, writeSettings: () => {}, fetch: slowApi.fetch, getSecret: () => 'REFRESH', setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}), spotifyEngine: engine, rateMax: () => 1e6 });
  await w2.refresh(w2.list()[0], { force: true });
  const first = w2.act({ id: 'wstat00002', do: 'esearch', text: 'slow term' });
  await sleep(30);
  await w2.act({ id: 'wstat00002', do: 'esearch', text: 'fast term' });
  await first;
  const dd2 = w2.cache.get('wstat00002').data;
  check('cancellation: a search asked while an older one is still in flight wins: the older answer, arriving later, is dropped (never replaces the newer rows)', dd2.query === 'fast term' && dd2.results.every((r) => r.id.endsWith('fastterm')) && slowApi.searches().length === 2, JSON.stringify([dd2.query, dd2.results.map((r) => r.id)]));
  await w2.act({ id: 'wstat00002', do: 'esearch', text: '' });
  check('api fast path: an empty search clears (nothing is asked; the engine clears its own)', slowApi.searches().length === 2, String(slowApi.searches().length));

  // the Web API refuses: the page searches instead
  const failApi = fakeApi({ searchStatus: 403 });
  const fcalls = { searched: [] };
  let s3 = { homeWidgets: [{ id: 'wstat00003', type: 'spotify', mode: 'status', clientId: CLIENT, art: true, x: 0, y: 0, w: 6, h: 5 }] };
  const w3 = createWidgets({ readSettings: () => s3, writeSettings: () => {}, fetch: failApi.fetch, getSecret: () => 'REFRESH', setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}), spotifyEngine: { ...engine, search: (q) => { fcalls.searched.push(q); return true; } }, rateMax: () => 1e6 });
  await w3.refresh(w3.list()[0], { force: true });
  await w3.act({ id: 'wstat00003', do: 'esearch', text: 'daft punk' });
  const d3 = w3.cache.get('wstat00003').data;
  check('api fast path: when the Web API says no (a scope, a limit), the page\'s own search is used and its rows are what the card shows', fcalls.searched.join() === 'daft punk' && d3.query === 'page term' && d3.results[0].id === 'PAGE1', JSON.stringify([fcalls.searched, d3.query]));

  // not connected: the page
  secret = null;
  const before = api.searches().length;
  calls.searched.length = 0;
  await w.act({ id, do: 'esearch', text: 'radiohead' });
  await w.refresh(w.list()[0], { force: true }); // (the engine says it changed: the card is read again)
  const dn = data();
  check('api fast path: with no Web API account the page searches (the engine is asked), no request is made, and the older Web API rows do not stay over its answer', calls.searched.join() === 'radiohead' && api.searches().length === before && dn.query === 'page term', JSON.stringify([calls.searched, dn.query]));
  secret = 'REFRESH';

  // warm-up
  const wBefore = calls.warmed;
  await w.act({ id, do: 'ewarm' });
  check('warm-up: focusing the box (ewarm) starts the hidden page and asks for the access token now', calls.warmed > wBefore, String(calls.warmed));
  const reqs = api.log.length;
  check('api fast path: "more songs" has nothing to load when the Web API answered (its whole list came at once): nothing is asked', (await w.act({ id, do: 'emore' })) === true && api.log.length === reqs && calls.searched.length === 1, String(api.log.length - reqs));

  // ---- the request budgets ----
  const bApi = fakeApi();
  let s4 = { homeWidgets: [{ id: 'wapi000004', type: 'spotify', mode: 'api', clientId: CLIENT, art: false, x: 0, y: 0, w: 6, h: 5 }] };
  const w4 = createWidgets({ readSettings: () => s4, writeSettings: () => {}, fetch: bApi.fetch, getSecret: () => 'REFRESH', setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}), rateMax: () => 2, searchRateMax: () => 3 });
  const poll = async () => { const e = w4.cache.get('wapi000004'); if (e) e.at = 0; await w4.refresh(w4.list()[0], { force: true }); return w4.cache.get('wapi000004'); };
  let e4 = await poll();
  for (let i = 0; i < 4 && !(e4 && e4.error); i++) e4 = await poll();
  check('budget: polling is held to its own limit (here two requests a minute): the card then says "too many requests"', Boolean(e4 && e4.error && /Too many requests/.test(e4.error)), JSON.stringify(e4 && e4.error));
  const s0 = bApi.searches().length;
  await w4.act({ id: 'wapi000004', do: 'esearch', text: 'one' });
  await w4.act({ id: 'wapi000004', do: 'esearch', text: 'two' });
  const okRows = w4.cache.get('wapi000004').data;
  check('budget: …a search the user typed is not held up by it: polling used up its requests and the searches still go out', bApi.searches().length === s0 + 2 && okRows.query === 'two' && okRows.results.length === 3 && okRows.searchOk === true, JSON.stringify([bApi.searches().length - s0, okRows.query, okRows.searchOk]));
  await w4.act({ id: 'wapi000004', do: 'esearch', text: 'three' });
  await w4.act({ id: 'wapi000004', do: 'esearch', text: 'four' });
  const capped = w4.cache.get('wapi000004').data;
  check('budget: searches have a budget of their own too (here three a minute): the fourth is refused ("too many requests") and nothing is sent for it', bApi.searches().length === s0 + 3 && capped.searchOk === false, JSON.stringify([bApi.searches().length - s0, capped.searchOk]));
  const w5 = createWidgets({ readSettings: () => s4, writeSettings: () => {}, fetch: bApi.fetch, getSecret: () => 'REFRESH', setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}), rateMax: () => 40 });
  await w5.refresh(w5.list()[0], { force: true });
  for (let i = 0; i < 30; i++) await w5.act({ id: 'wapi000004', do: 'esearch', text: `bulk ${i}` });
  const eP = w5.cache.get('wapi000004'); if (eP) eP.at = 0;
  await w5.refresh(w5.list()[0], { force: true });
  check('budget: thirty fast searches (more than the 40 polling requests a minute allow) all go out, and the card still polls afterwards', bApi.searches().filter((l) => /bulk/.test(l.path)).length === 30 && !w5.cache.get('wapi000004').error, JSON.stringify(w5.cache.get('wapi000004').error));

  // ---- API mode itself: lazy pictures there too ----
  const pApi = fakeApi();
  let s6 = { homeWidgets: [{ id: 'wapi000006', type: 'spotify', mode: 'api', clientId: CLIENT, art: false, x: 0, y: 0, w: 6, h: 5 }] };
  const w6 = createWidgets({ readSettings: () => s6, writeSettings: () => {}, fetch: pApi.fetch, getSecret: () => 'REFRESH', setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}), rateMax: () => 1e6 });
  await w6.refresh(w6.list()[0], { force: true });
  await w6.act({ id: 'wapi000006', do: 'esearch', text: 'night' });
  const d6 = w6.cache.get('wapi000006').data;
  check('api mode: a search carries every row (no cap of six pictures) and no picture is fetched with it', d6.results.length === 3 && pApi.log.every((l) => l.host !== 'i.scdn.co') && d6.results.every((r) => r.thumb === undefined || r.thumb === ''), JSON.stringify(d6.results.map((r) => r.thumb)));
  await w6.act({ id: 'wapi000006', do: 'ethumb', ids: d6.results.map((r) => r.id) });
  const d6b = w6.cache.get('wapi000006').data;
  check('api mode: the card asks for the pictures of the rows it shows: all three come (not the first six only)', d6b.results.every((r) => r.thumb && r.thumb.startsWith('data:image/')) && pApi.log.filter((l) => l.host === 'i.scdn.co').length === 3, JSON.stringify(d6b.results.map((r) => (r.thumb || '').slice(0, 10))));
  check('api mode: a search term is kept clear of other query parameters and the search is the fixed path', SV.PLAYER.search('a&limit=50')[1] === '/search?q=a%26limit%3D50&type=track,album,artist,playlist&limit=10&market=from_token', SV.PLAYER.search('a&limit=50')[1]);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The hidden page kept for the search: not unloaded for idleness while the search is open, started when the box is focused.
async function warmChecks(check) {
  let t = 1e12;
  const intervals = [];
  const player = {
    destroyed: 0, wc: null,
    ensure() { if (!player.wc) player.wc = { sent: [], executeJavaScript(code) { const m = /detail: (".*") \}\)\)$/.exec(code); if (m) player.wc.sent.push(JSON.parse(JSON.parse(m[1]))); return Promise.resolve(); } }; },
    webContents: () => player.wc, status: () => ({ state: 'ready', drm: 'ok' }), isSignedIn: () => true, generation: () => 1,
    destroy() { player.destroyed++; player.wc = null; }, showIn() {}, release() {}, reload() {},
  };
  const e = createEngine({ player, now: () => t, fetchBytes: async () => null, resizeArt: (b) => b, hasCard: () => true, onChange: () => {}, setInterval: (f) => { intervals.push(f); return { unref() {} }; } });
  const tick = () => intervals.forEach((f) => f());
  e.warm();
  check('warm: focusing the search box starts the hidden page (it is made now, not at the first key)', player.wc !== null && intervals.length === 1, '');
  t += 16 * 60e3; tick();
  check('warm: …and 16 minutes of idleness after the focus does not unload it (the search is open: the 15-minute idle unload waits)', player.destroyed === 0 && player.wc !== null, String(player.destroyed));
  t += 15 * 60e3; tick();
  check('warm: …but once the half hour since the last sign of the search has passed, the idle unload goes ahead as before', player.destroyed === 1, String(player.destroyed));
  e.search('x'); // wake: a new page
  t += 16 * 60e3; tick();
  check('warm: a search asked also keeps the page for the next ones (the user is in the middle of searching)', player.destroyed === 1 && player.wc !== null, String(player.destroyed));
  check('warm: the engine offers warm, loadThumbs and searchMore to the widget', typeof e.warm === 'function' && typeof e.loadThumbs === 'function' && typeof e.searchMore === 'function', '');
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
function pageChecks(check) {
  const musicJs = fs.readFileSync(path.join(root, 'renderer', 'newtab-music.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'renderer', 'newtab.html'), 'utf8');
  const sac = fs.readFileSync(path.join(root, 'features', 'spotify-api-card.js'), 'utf8');
  const engineJs = fs.readFileSync(path.join(root, 'features', 'music-engine.js'), 'utf8');
  check('page: the search core loads before the card, after the widgets script', html.indexOf('../features/music-search-core.js') > 0 && html.indexOf('../features/music-search-core.js') < html.indexOf('<script src="newtab-music.js">'), '');
  check('page: the card pauses 200 ms (the core\'s), searches from two letters, asks at once on Enter, and keeps a cache of recent queries', /MS\.createScheduler\(/.test(musicJs) && !/debounce:/.test(musicJs) && !/SEARCH_DEBOUNCE_MS/.test(musicJs) && /MS\.createCache\(\)/.test(musicJs) && /sched\.enter\(term\)/.test(musicJs) && /sched\.type\(term\)/.test(musicJs) && !/setTimeout\(send,/.test(musicJs), '');
  check('page: rows get lazy pictures: loading="lazy" on the image, an IntersectionObserver asks main (ethumb) for the rows on screen only', /img\.loading = 'lazy'/.test(musicJs) && /new IntersectionObserver\(/.test(musicJs) && /act\('ethumb'/.test(musicJs), '');
  check('page: skeleton rows while a search loads, the dimmed rows of a longer earlier query, the "More songs" button and the scroll to the end', /am-skel/.test(musicJs) && /provisional/.test(musicJs) && /am-more/.test(musicJs) && /nearEnd\(p\)/.test(musicJs) && /@keyframes am-skel-pulse/.test(html) && /prefers-reduced-motion: reduce\) \{ \.am-skel-line/.test(html), '');
  check('page: the box warms the player when focused (ewarm, once a minute at most) and so does showing the Search tab', /act\('ewarm'\)/.test(musicJs) && /view\.warmSearch/.test(musicJs) && /60e3/.test(musicJs), '');
  check('page: the picture cap of six no longer applies to a search (it is for the queue only)', !/THUMBS/.test(sac.slice(sac.indexOf('async function runSearch'), sac.indexOf('async function loadTab'))) && !/fetchThumbs\(m\.items, results\.rid\)/.test(engineJs), '');
}

module.exports = async function spotifySearchSpeedUnits(check) {
  coreChecks(check);
  await apiChecks(check);
  await warmChecks(check);
  pageChecks(check);
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } else console.log(`PASS ${name}`); })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
