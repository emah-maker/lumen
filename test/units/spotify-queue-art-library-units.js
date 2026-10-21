// The Spotify card's queue, pictures and library against a fake Web API shaped like Spotify's real answers (features/widgets.js, features/spotify-api-card.js):
//  - the library: GET /me/albums sends every saved album WITH its track list (50 albums are over 1 MB), which the old 256 KB read cut into invalid JSON and showed as an
//    empty list; a cut answer is now read in full (or, past the cap, a failure the card names, never an empty list);
//  - pictures: the card accepts a row's picture only as a small data: URL, and Spotify's artist (160 px), playlist (300 px) and cover pictures are bigger than that, so every
//    row came out blank; they are made small first (deps.resizeThumb). Library rows ask for their pictures like search rows do (ethumb);
//  - the queue: POST /me/player/queue with the song's uri, a card in "Play as Lumen" mode with the account connected queues through the Web API (and says "Added" only
//    when Spotify did), with no active device a device the account has is woken, with none the message says what to do, and an expired token is refreshed first.
// Runs on its own (npm run test:units picks up test/*-units.js).
'use strict';
const { createWidgets } = require('../../src/features/widgets');

const CLIENT = '0123456789abcdef0123456789abcdef';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reply = (status, body, headers = {}) => new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status, headers });
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const picture = (n) => Buffer.concat([Buffer.from(PNG_SIG), Buffer.alloc(n - 8, 7)]); // (a picture of n bytes)
const SMALL = Buffer.concat([Buffer.from(PNG_SIG), Buffer.alloc(1500, 3)]);
const img = (id, ws) => ws.map((w) => ({ url: `https://i.scdn.co/image/${id}${w}`, width: w, height: w }));
const trackObj = (id, name) => ({ id, type: 'track', name, duration_ms: 200000, artists: [{ name: 'Ann' }], album: { name: 'Quiet Hours', images: img(`al${id}`, [640, 300, 64]) } });

function fakeApi(world) {
  const log = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.host === 'i.scdn.co' || u.host === 'mosaic.scdn.co') { log.push(`IMG ${u.pathname}`); return new Response(picture(25000), { status: 200, headers: { 'content-type': 'image/png' } }); }
    if (u.host === 'accounts.spotify.com') {
      world.tokenCalls = (world.tokenCalls || 0) + 1;
      return reply(200, { access_token: world.expiredToken && world.tokenCalls === 1 ? 'OLD' : 'FRESH', token_type: 'Bearer', expires_in: 3600 });
    }
    if (u.host !== 'api.spotify.com') return reply(404);
    const p = u.pathname.replace(/^\/v1/, '');
    const method = opts.method || 'GET';
    log.push(`${method} ${p}${u.search}`);
    const auth = (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || '';
    if (world.expiredToken && auth === 'Bearer OLD') return reply(401, { error: { status: 401, message: 'The access token expired' } });
    if (p === '/me/playlists') {
      const off = Number(u.searchParams.get('offset') || 0);
      const total = world.playlistPages || 1;
      const items = Array.from({ length: 50 }, (_, i) => ({ id: `PL${off + i}`, type: 'playlist', name: `Playlist ${off + i}`, owner: { display_name: 'You' }, images: i === 0 ? null : [{ url: `https://mosaic.scdn.co/640/pl${off + i}`, width: null, height: null }] }));
      return reply(200, { items, next: off / 50 + 1 < total ? `https://api.spotify.com/v1/me/playlists?offset=${off + 50}&limit=50` : null });
    }
    if (p === '/me/tracks') return reply(200, { items: [{ added_at: 'x', track: trackObj('LK1', 'Saved One') }], next: null });
    if (p === '/me/albums') {
      // the real shape: each saved album carries its whole track list
      const items = Array.from({ length: 50 }, (_, i) => ({ added_at: 'x', album: { id: `SAL${i}`, type: 'album', name: `Saved Album ${i}`, artists: [{ name: 'Ann', id: 'a', href: 'https://api.spotify.com/v1/artists/a', external_urls: { spotify: 'https://open.spotify.com/artist/a' } }], release_date: '2021-03-04', images: img(`sal${i}`, [640, 300, 64]), tracks: { total: 40, items: Array.from({ length: 40 }, (_, k) => ({ id: `T${i}_${k}`, name: `Track ${k} of album ${i} with a realistic name`, duration_ms: 1, track_number: k + 1, artists: [{ name: 'Ann', id: 'a', href: 'https://api.spotify.com/v1/artists/a', uri: 'spotify:artist:a', external_urls: { spotify: 'https://open.spotify.com/artist/a' } }], href: `https://api.spotify.com/v1/tracks/T${i}_${k}`, uri: `spotify:track:T${i}_${k}`, preview_url: null, external_urls: { spotify: 'https://open.spotify.com/track/x' } })) } } }));
      return reply(200, { items, next: null });
    }
    if (p === '/me/following') return reply(200, { artists: { items: [{ id: 'FAR1', type: 'artist', name: 'Followed Artist', images: img('far', [640, 320, 160]) }], next: null, cursors: { after: null } } });
    if (p === '/me/player/recently-played') return reply(200, { items: [{ track: trackObj('R1', 'Afterglow') }] });
    if (p === '/me/player') return reply(204);
    if (p === '/me/player/devices') return reply(200, { devices: world.devices || [] });
    if (p === '/me/player' && method === 'PUT') return reply(204);
    if (p === '/me/player/queue' && method === 'POST') {
      if (world.noDevice && !world.woken) return reply(404, { error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } });
      world.queued = (world.queued || []).concat(u.searchParams.get('uri'));
      return reply(204);
    }
    return reply(404);
  };
  const putMe = fetch;
  return { fetch: async (url, opts = {}) => { const u = new URL(url); if (u.host === 'api.spotify.com' && u.pathname === '/v1/me/player' && opts.method === 'PUT') { world.woken = true; log.push('PUT /me/player'); return reply(204); } return putMe(url, opts); }, log };
}

async function make(world, { mode = 'api', engine = null } = {}) {
  const api = fakeApi(world);
  const secrets = new Map([['spotify', 'REFRESH']]);
  const id = 'wsqal00001';
  const w = createWidgets({
    readSettings: () => ({ homeWidgets: [{ id, type: 'spotify', mode, clientId: CLIENT, art: false, x: 0, y: 0, w: 8, h: 7 }] }), writeSettings: () => {},
    fetch: api.fetch, getSecret: (n) => secrets.get(n) || null, setSecret: (n, v) => { secrets.set(n, v); }, onUpdate: () => {}, endpoints: () => ({}),
    rateMax: () => 1e6, searchRateMax: () => 1e6, spotifyEngine: engine,
    // (main.js's resizer, about 96 px, makes a picture a few KB)
    resizeThumb: (bytes) => (bytes.length > 3000 ? SMALL : null),
  });
  const data = () => w.cache.get(id).data;
  const look = async () => { const e = w.cache.get(id); if (e) e.at = 0; await w.refresh(w.list()[0], { force: true }); return data(); };
  const settled = async (ms = 5000) => { const end = Date.now() + ms; let d = data(); while (Date.now() < end && d.libraryPending === true) { await sleep(25); d = data(); } return d; };
  const notice = () => (w.cache.get(id).notice || {}).text || data().notice || '';
  const act = async (a) => { const e = w.cache.get(id); e.notice = null; if (e.data) delete e.data.notice; return w.act({ id, ...a }); };
  return { w, id, api, data, look, settled, notice, act };
}

module.exports = async function spotifyQueueArtLibraryUnits(check) {
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    // ---- library: saved albums come with their track lists (a big answer) ----
    {
      const world = {};
      const t = await make(world);
      await t.look();
      await t.w.act({ id: t.id, do: 'etab', arg: 'library', force: true });
      const d = await t.settled();
      check('library: 50 saved albums (an answer over 1 MB, each with its tracks) all show', d.albums.length === 50 && d.albums[0].title === 'Saved Album 0', `${d.albums.length} albums, ok=${d.libraryOk}`);
      check('library: the other lists show beside them (recent, Liked Songs, playlists, artists)', d.recent.length === 1 && d.likedSongs.length === 1 && d.playlists.length === 50 && d.artists.length === 1, JSON.stringify([d.recent.length, d.likedSongs.length, d.playlists.length, d.artists.length]));
    }
    // ---- library: the next page is followed (the next address Spotify gives is turned into a path of ours) ----
    {
      const world = { playlistPages: 2 };
      const t = await make(world);
      await t.look();
      await t.w.act({ id: t.id, do: 'etab', arg: 'library', force: true });
      const d = await t.settled();
      check('library: a second page of playlists is read (offset=50) and its rows are shown', t.api.log.some((l) => /\/me\/playlists\?offset=50/.test(l)) && d.playlists.length === 100 && d.playlists[99].id === 'PL99', `${d.playlists.length}`);
    }
    // ---- library: an expired token is refreshed once and the library shows ----
    {
      const world = { expiredToken: true };
      const t = await make(world);
      await t.look();
      await t.w.act({ id: t.id, do: 'etab', arg: 'library', force: true });
      const d = await t.settled();
      check('library: an expired token (401) is refreshed and the library shows', d.playlists.length === 50 && d.albums.length === 50 && world.tokenCalls >= 2 && world.tokenCalls <= 3, `${d.playlists.length}/${d.albums.length} tokens=${world.tokenCalls}`);
    }
    // ---- pictures: the library rows ask for theirs; artists, playlists (no width) and covers all come as small data: URLs ----
    {
      const world = {};
      const t = await make(world);
      await t.look();
      await t.w.act({ id: t.id, do: 'etab', arg: 'library', force: true });
      let d = await t.settled();
      check('library: rows start without a picture (the card asks for the ones on screen)', d.playlists.every((r) => !r.thumb) && !t.api.log.some((l) => l.startsWith('IMG')), '');
      await t.w.act({ id: t.id, do: 'ethumb', ids: ['PL1', 'PL2', 'FAR1', 'SAL0', 'LK1'] });
      d = t.data();
      const ok = (r) => r && typeof r.thumb === 'string' && /^data:image\/(?:png|jpeg|webp);base64,/.test(r.thumb) && r.thumb.length < 12000;
      check('library pictures: a playlist (width unknown, 300 px), a followed artist (160 px), a saved album and a liked song each get a small picture the card draws', ok(d.playlists.find((r) => r.id === 'PL1')) && ok(d.artists[0]) && ok(d.albums[0]) && ok(d.likedSongs[0]), JSON.stringify([d.playlists[1]?.thumb?.length, d.artists[0]?.thumb?.length, d.albums[0]?.thumb?.length, d.likedSongs[0]?.thumb?.length]));
      check('library pictures: a playlist with no pictures at all (images: null) has none, and nothing breaks', d.playlists[0].id === 'PL0' && !d.playlists[0].thumb, '');
      // read again: the rows keep the pictures they had
      await t.w.act({ id: t.id, do: 'etab', arg: 'library', force: true });
      d = await t.settled();
      check('library pictures: reading the library again keeps the pictures', ok(d.playlists.find((r) => r.id === 'PL1')), '');
    }
    // ---- the queue: the request, the notice, no device, an expired token ----
    {
      const world = { devices: [] };
      const t = await make(world);
      await t.look();
      await t.act({ do: 'playlater', kind: 'song', item: 'S9' });
      check('queue: POST /me/player/queue with the song uri, and the card says Added', t.api.log.includes('POST /me/player/queue?uri=spotify%3Atrack%3AS9') && /Added to the queue/.test(t.notice()), JSON.stringify(t.api.log.slice(-2)));
      world.noDevice = true;
      await t.act({ do: 'playlater', kind: 'song', item: 'S10' });
      check('queue, no active device and none to wake: the message says to open Spotify on a device and play something', /No active Spotify device\. Open Spotify on a phone, computer or speaker/.test(t.notice()), t.notice());
      world.devices = [{ id: 'd1abc', name: 'This PC', type: 'Computer', is_active: false, is_restricted: false }];
      await t.act({ do: 'playlater', kind: 'song', item: 'S11' });
      check('queue, no active device but the account has one: it is woken (PUT /me/player) and the song is queued there', world.woken === true && (world.queued || []).includes('spotify:track:S11') && /Added to the queue/.test(t.notice()), JSON.stringify([world.woken, world.queued, t.notice()]));
    }
    // ---- what the page is shown: a failure replaces the last success's note, and survives the next look at the player ----
    {
      const world = { devices: [] };
      const t = await make(world);
      await t.look();
      const pageNote = () => (t.w.forPage().find((c) => c.id === t.id).data || {}).notice || '';
      await t.w.act({ id: t.id, do: 'playlater', kind: 'song', item: 'S30' });
      check('queue, on the page: the card says "Added to the queue."', /Added to the queue/.test(pageNote()), pageNote());
      world.noDevice = true;
      await t.w.act({ id: t.id, do: 'playlater', kind: 'song', item: 'S31' });
      check('queue, on the page: a failed press shows ITS message, not the previous press note', /No active Spotify device/.test(pageNote()) && !/Added/.test(pageNote()), pageNote());
      await t.look(); // (the next look at the player replaces the card's data)
      check('queue, on the page: ...and the message is still there after the next look at the player', /No active Spotify device/.test(pageNote()), pageNote());
    }
    {
      const world = { expiredToken: true };
      const t = await make(world);
      await t.look();
      await t.act({ do: 'playlater', kind: 'song', item: 'S12' });
      check('queue: an expired token (401) is refreshed and the song is queued', (world.queued || []).includes('spotify:track:S12') && world.tokenCalls >= 2, JSON.stringify([world.queued, world.tokenCalls]));
    }
    // ---- the Play-as-Lumen card with the account connected: the Web API queues it; when it can't, the player's page does ----
    {
      const asked = [];
      const engine = {
        read: async () => ({ mode: 'status', state: 'playing', title: 'Night Shift', artist: 'Ann', album: 'Quiet Hours', progressMs: 0, durationMs: 200000, at: Date.now(), source: 'engine', kind: 'track', reason: '', art: '', signedIn: true, results: [], recent: [], playlists: [], queue: { items: [] } }),
        playLater: (kind, id) => { asked.push(`${kind}:${id}`); return true; },
        warm: () => {}, refreshLists: () => {}, command: () => true,
      };
      const world = { devices: [] };
      const t = await make(world, { mode: 'status', engine });
      await t.look();
      await t.act({ do: 'playlater', kind: 'song', item: 'S20' });
      check('Play as Lumen + connected account: Add to queue goes through the Web API (the page is not asked), and says Added', (world.queued || []).includes('spotify:track:S20') && asked.length === 0 && /Added to the queue/.test(t.notice()), JSON.stringify([world.queued, asked]));
      world.noDevice = true;
      await t.act({ do: 'playlater', kind: 'song', item: 'S21' });
      check('Play as Lumen: when the Web API can\'t queue it (no active device), the player\'s own page does', asked.join() === 'song:S21', JSON.stringify(asked));
    }
  } finally {
    console.warn = realWarn;
  }
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
