// The Spotify card's Library read through the Web API (features/spotify-api-card.js loadTab, features/widgets.js), against a fake API: a big paginated library
// (bounded: two pages a list), the first list on the card quickly with the others filling in, an expired token (one refresh, no loop), a 429 (answers at once, says
// so, no retry storm) and a request that never answers (cut off, the others still show). The engine card with a connected account reads the same way and falls
// back to the page's own library. Runs on its own (npm run test:units picks up test/*-units.js).
'use strict';
const { createWidgets } = require('../src/features/widgets');

const CLIENT = '0123456789abcdef0123456789abcdef';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reply = (status, body, headers = {}) => new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status, headers });
const track = (id, name) => ({ id, type: 'track', name, duration_ms: 200000, artists: [{ name: 'Ann' }], album: { name: 'Quiet Hours', images: [] } });

// world: { pages (playlist pages), delay: { path: ms }, hang: Set of paths that never answer, status429, expiredToken, tokenCalls, hits }
function fakeApi(world) {
  const log = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.host === 'accounts.spotify.com') {
      world.tokenCalls = (world.tokenCalls || 0) + 1;
      return reply(200, { access_token: world.expiredToken && world.tokenCalls === 1 ? 'OLD' : 'FRESH', token_type: 'Bearer', expires_in: 3600 });
    }
    if (u.host !== 'api.spotify.com') return reply(404);
    const p = u.pathname.replace(/^\/v1/, '');
    log.push(p + u.search);
    const auth = (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || '';
    if (world.hang && world.hang.has(p)) return new Promise(() => {}); // (never answers)
    if (world.status429) return reply(429, { error: { status: 429, message: 'rate' } }, { 'retry-after': '30' });
    if (world.expiredToken && auth === 'Bearer OLD') return reply(401, { error: { status: 401, message: 'The access token expired' } });
    if (world.delay && world.delay[p]) await sleep(world.delay[p]);
    if (p === '/me/playlists') {
      const off = Number(u.searchParams.get('offset') || 0);
      const page = off / 50;
      const total = world.pages || 1;
      const items = Array.from({ length: 50 }, (_, i) => ({ id: `PL${off + i}`, type: 'playlist', name: `Playlist ${off + i}`, owner: { display_name: 'You' }, images: [] }));
      return reply(200, { items, next: page + 1 < total ? `https://api.spotify.com/v1/me/playlists?offset=${off + 50}&limit=50` : null });
    }
    if (p === '/me/tracks') return reply(200, { items: [{ added_at: 'x', track: track('LK1', 'Saved One') }], next: null });
    if (p === '/me/albums') return reply(200, { items: [{ added_at: 'x', album: { id: 'SAL1', type: 'album', name: 'Saved Album', artists: [{ name: 'Ann' }], release_date: '2021-03-04', images: [] } }], next: null });
    if (p === '/me/following') return reply(200, { artists: { items: [{ id: 'FAR1', type: 'artist', name: 'Followed Artist', images: [] }], next: null, cursors: { after: null } } });
    if (p === '/me/player/recently-played') return reply(200, { items: [{ track: track('R1', 'Afterglow') }] });
    if (p === '/me/player') return reply(204);
    return reply(404);
  };
  return { fetch, log };
}

async function make(world, { mode = 'api', engine = null, listMs } = {}) {
  const api = fakeApi(world);
  const secrets = new Map([['spotify', 'REFRESH']]);
  const id = 'wlib000001';
  const updates = { n: 0 };
  const w = createWidgets({
    readSettings: () => ({ homeWidgets: [{ id, type: 'spotify', mode, clientId: CLIENT, art: false, x: 0, y: 0, w: 8, h: 7 }] }), writeSettings: () => {},
    fetch: api.fetch, getSecret: (n) => secrets.get(n) || null, setSecret: (n, v) => { secrets.set(n, v); }, onUpdate: () => { updates.n++; }, endpoints: () => ({}),
    rateMax: () => 1e6, searchRateMax: () => 1e6, libraryListMs: () => listMs, spotifyEngine: engine,
  });
  const data = () => w.cache.get(id).data;
  const look = async () => { const e = w.cache.get(id); if (e) e.at = 0; await w.refresh(w.list()[0], { force: true }); return data(); };
  const settled = async (ms = 5000) => { const end = Date.now() + ms; let d = data(); while (Date.now() < end && d.libraryPending === true) { await sleep(25); d = data(); } return d; };
  return { w, id, api, updates, data, look, settled };
}

module.exports = async function spotifyLibraryApiUnits(check) {
  const realWarn = console.warn;
  const warned = [];
  console.warn = (...a) => { warned.push(a.join(' ')); };
  try {
    // ---- a big paginated library: two pages a list at most, rows capped, nothing unbounded ----
    {
      const world = { pages: 12 };
      const t = await make(world);
      await t.look();
      const t0 = Date.now();
      await t.w.act({ id: t.id, do: 'etab', arg: 'library', force: true });
      let d = await t.settled();
      const pageCalls = t.api.log.filter((l) => l.startsWith('/me/playlists')).length;
      check('library API, big library (12 pages of playlists): at most two pages of a list are read, the rows are capped at 100, and it finishes quickly', pageCalls === 2 && d.playlists.length === 100 && d.libraryOk === true && d.libraryPending === false && Date.now() - t0 < 3000, JSON.stringify([pageCalls, d.playlists.length, d.libraryPending]));
      check('library API: the other lists are there too (recent, Liked Songs, albums, artists)', d.recent.length === 1 && d.likedSongs.length === 1 && d.albums.length === 1 && d.artists.length === 1, JSON.stringify([d.recent.length, d.likedSongs.length, d.albums.length, d.artists.length]));
    }
    // ---- the first list is on the card at once; a slow list fills in after (pending until the last answers) ----
    {
      const world = { pages: 1, delay: { '/me/tracks': 400 } };
      const t = await make(world);
      await t.look();
      await t.w.act({ id: t.id, do: 'etab', arg: 'library', force: true });
      let d = t.data();
      check('library API, a slow list: the tab answers with the playlists while Liked Songs is still coming (libraryPending true, no failure shown)', d.playlists.length === 50 && d.libraryPending === true && d.likedSongs.length === 0 && d.libraryOk === true, JSON.stringify([d.playlists.length, d.libraryPending, d.likedSongs.length]));
      const n = t.updates.n;
      d = await t.settled();
      check('library API, a slow list: …then it fills in by itself (the card is told), and the pending flag ends', d.likedSongs.length === 1 && d.libraryPending === false && t.updates.n > n, JSON.stringify([d.likedSongs.length, d.libraryPending, t.updates.n - n]));
    }
    // ---- an expired token: one refresh, the call is asked again, the library shows; the token endpoint is not hammered ----
    {
      const world = { pages: 1, expiredToken: true, tokenCalls: 0 };
      const t = await make(world);
      await t.look();
      await t.w.act({ id: t.id, do: 'etab', arg: 'library', force: true });
      const d = await t.settled();
      check('library API, expired token (401): a new token is fetched and the library shows (no loop, a handful of token requests)', d.playlists.length === 50 && d.libraryOk === true && world.tokenCalls >= 2 && world.tokenCalls <= 3, JSON.stringify([d.playlists.length, d.libraryOk, world.tokenCalls]));
    }
    // ---- a 429: every list fails at once, the card says Spotify asked to slow down (Try again), nothing waits for the Retry-After, no retry storm ----
    {
      const world = { pages: 1 };
      const t = await make(world);
      await t.look();
      world.status429 = true; // (the player answered; the library is what Spotify then limits)
      const t0 = Date.now();
      await t.w.act({ id: t.id, do: 'etab', arg: 'library', force: true });
      const d = await t.settled();
      check('library API, rate limited (429, Retry-After 30 s): it answers at once (does not sit out the wait), says "rate", and asked Spotify only a few times', Date.now() - t0 < 2000 && d.libraryOk === false && d.libraryWhy === 'rate' && t.api.log.length <= 6, JSON.stringify([Date.now() - t0, d.libraryOk, d.libraryWhy, t.api.log.length]));
    }
    // ---- a request that never answers: that list is cut off after its time, the others show ----
    {
      const world = { pages: 1, hang: new Set(['/me/playlists']) };
      const t = await make(world, { listMs: 300 });
      await t.look();
      const t0 = Date.now();
      await t.w.act({ id: t.id, do: 'etab', arg: 'library', force: true });
      const d = await t.settled();
      check('library API, one list never answers: the tab does not hang (answered after that list\'s time), the lists that answered are shown', Date.now() - t0 < 2500 && d.libraryOk === true && d.playlists.length === 0 && d.likedSongs.length === 1 && d.albums.length === 1, JSON.stringify([Date.now() - t0, d.libraryOk, d.likedSongs.length]));
    }
    {
      const world = { pages: 1, hang: new Set(['/me/playlists', '/me/tracks', '/me/albums', '/me/following', '/me/player/recently-played']) };
      const t = await make(world, { listMs: 300 });
      await t.look();
      const t0 = Date.now();
      await t.w.act({ id: t.id, do: 'etab', arg: 'library', force: true });
      const d = await t.settled();
      check('library API, nothing answers: it ends as a failure the card names ("timeout": Try again), within the lists\' time, never "Loading…" for ever', Date.now() - t0 < 2500 && d.libraryOk === false && d.libraryWhy === 'timeout' && d.libraryPending === false, JSON.stringify([Date.now() - t0, d.libraryOk, d.libraryWhy, d.libraryPending]));
      // Try again after the API is back reads it again
      world.hang = new Set();
      await t.w.act({ id: t.id, do: 'etab', arg: 'library', force: true });
      const d2 = await t.settled();
      check('library API: …and Try again, with the API answering again, shows the rows', d2.libraryOk === true && d2.playlists.length === 50, JSON.stringify([d2.libraryOk, d2.playlists.length]));
    }
    // ---- the engine card with a connected account: the API's library; when the API hangs, the page's own library (no waiting on both) ----
    {
      const asked = [];
      const pageRows = [{ id: 'PAGEPLAYLIST', kind: 'playlist', title: 'From the page' }];
      const engine = { read: async () => ({ mode: 'status', state: 'playing', title: 'Night Shift', artist: 'Ann', album: 'Quiet Hours', progressMs: 0, durationMs: 200000, at: Date.now(), source: 'engine', kind: 'track', reason: '', art: '', signedIn: true, recent: [], likedSongs: [], playlists: pageRows, albums: [], artists: [], libraryOk: true, libraryWhy: '', libraryPending: false, libraryEmpty: false }), command: (n, a) => { asked.push(`${n}:${a}`); return true; }, refreshLists: () => {}, control: async () => true };
      const world = { pages: 1, hang: new Set(['/me/playlists']) };
      const t = await make(world, { mode: 'status', engine, listMs: 300 });
      await t.look();
      const t0 = Date.now();
      await t.w.act({ id: t.id, do: 'etab', arg: 'library', force: true });
      const d = await t.look();
      check('engine card + connected account, the API list hangs: the page\'s own library is asked and shown, within the list\'s time', Date.now() - t0 < 2500 && asked.includes('tab:library') && d.playlists.length === 1 && d.playlists[0].id === 'PAGEPLAYLIST', JSON.stringify([Date.now() - t0, asked, d.playlists.map((p) => p.id)]));
    }
  } finally {
    console.warn = realWarn;
  }
  void warned;
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
