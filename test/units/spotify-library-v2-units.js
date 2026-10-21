// The Spotify card's Library, like Spotify's (features/spotify-library.js, features/spotify-api-card.js, features/widgets.js) against a fake Web API:
// every playlist across pages (no two-page cap), Liked Songs with its count, albums and followed artists; a playlist of 260 songs read page by page with each song's place
// (a skipped local file still counts); a row played inside its list (context_uri with an offset); Liked Songs played in its collection context (and as a list when Spotify
// refuses that); an album and an artist opened; pictures asked for lazily; the same from a Play as Lumen card. Runs on its own (npm run test:units picks up test/*-units.js).
'use strict';
const { createWidgets } = require('../../src/features/widgets');

const CLIENT = '0123456789abcdef0123456789abcdef';
const reply = (status, body) => new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1500, 3)]);
const img = (id, ws = [640, 300, 64]) => ws.map((w) => ({ url: `https://i.scdn.co/image/${id}${w}`, width: w, height: w }));
const track = (n) => ({ id: `T${n}`, type: 'track', name: `Song ${n}`, duration_ms: 180000 + n, artists: [{ name: `Artist ${n % 7}` }], album: { name: `Album ${n % 5}`, images: img(`t${n}`) } });
const playlist = (id, name, owner = 'me', total = 10) => ({ id, type: 'playlist', name, owner: { id: owner, display_name: owner }, images: [{ url: `https://mosaic.scdn.co/640/${id}`, width: null, height: null }], items: { total } });

function fakeApi(world) {
  const log = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    if (u.host === 'i.scdn.co' || u.host === 'mosaic.scdn.co') { log.push(`IMG ${u.pathname}`); return new Response(PNG, { status: 200 }); }
    if (u.host === 'accounts.spotify.com') return reply(200, { access_token: 'TOKEN', token_type: 'Bearer', expires_in: 3600 });
    if (u.host !== 'api.spotify.com') return reply(404);
    const p = u.pathname.replace(/^\/v1/, '');
    log.push(`${method} ${p}${u.search}`);
    const off = Number(u.searchParams.get('offset') || 0);
    if (p === '/me') return reply(200, { id: 'ME1', display_name: 'Me' });
    if (p === '/me/playlists') {
      const all = [...Array.from({ length: 128 }, (_, i) => playlist(`P${i}`, `Playlist ${i}`, i % 10 === 0 ? 'spotify' : 'me')), playlist('BIG', 'The big one', 'me', 260), playlist('EMPTY', 'Empty', 'me', 0)];
      const items = all.slice(off, off + 50);
      return reply(200, { items, total: all.length, next: off + 50 < all.length ? `https://api.spotify.com/v1/me/playlists?offset=${off + 50}&limit=50` : null });
    }
    if (p === '/me/albums') return reply(200, { items: [{ album: { id: 'AL1', type: 'album', name: 'Saved One', artists: [{ name: 'Ann' }], release_date: '2020-01-01', total_tracks: 3, images: img('al1') } }], total: 1, next: null });
    if (p === '/me/following') return reply(200, { artists: { items: [{ id: 'AR1', type: 'artist', name: 'Followed', images: img('ar1', [640, 320, 160]) }], total: 1, next: null } });
    if (p === '/me/tracks') {
      const limit = Number(u.searchParams.get('limit') || 20);
      return reply(200, { items: Array.from({ length: Math.max(0, Math.min(limit, 120 - off)) }, (_, i) => ({ added_at: 'x', track: track(1000 + off + i) })), total: 120, next: null });
    }
    if (p === '/playlists/BIG/items') {
      const total = 260;
      const items = Array.from({ length: Math.max(0, Math.min(50, total - off)) }, (_, i) => { const n = off + i; return n === 3 ? { item: { id: null, type: 'track', name: 'A local file', is_local: true, artists: [], album: {} } } : n === 5 ? { item: { id: 'EP1', type: 'episode', name: 'An episode' } } : { item: track(n) }; });
      return reply(200, { items, total, next: null });
    }
    if (p === '/playlists/EMPTY/items') return reply(200, { items: [], total: 0 });
    if (p === '/albums/AL1/tracks') return reply(200, { items: [1, 2, 3].map((n) => ({ id: `AT${n}`, type: 'track', name: `Album song ${n}`, duration_ms: 1000, artists: [{ name: 'Ann' }] })), total: 3, next: null });
    if (p === '/artists/AR1/albums') return reply(200, { items: [{ id: 'AL9', type: 'album', name: 'Newest', artists: [{ name: 'Followed' }], release_date: '2025-05-05', total_tracks: 9, images: img('al9') }] });
    if (p === '/artists/AR1/top-tracks') return world.topBlocked ? reply(403, { error: { status: 403, message: 'Forbidden' } }) : reply(200, { tracks: [track(77)] });
    if (p === '/me/player/devices') return reply(200, { devices: world.devices || [] });
    if (p === '/me/player' && method === 'PUT') { world.woken = true; return reply(204); }
    if (p === '/me/player/shuffle') return reply(204);
    if (p === '/me/player/play') {
      const body = JSON.parse(opts.body || '{}');
      if (world.noDevice && !world.woken) return reply(404, { error: { status: 404, reason: 'NO_ACTIVE_DEVICE', message: 'No active device' } });
      if (world.noCollection && /:collection$/.test(body.context_uri || '')) return reply(400, { error: { status: 400, message: 'Invalid context uri' } });
      world.plays = (world.plays || []).concat(JSON.stringify(body));
      return reply(204);
    }
    if (p === '/me/player/queue') { world.queued = (world.queued || []).concat(u.searchParams.get('uri')); return reply(204); }
    if (p === '/me/player') return reply(204);
    return reply(404);
  };
  return { fetch, log };
}

async function make(world, { mode = 'api', engine = null } = {}) {
  const api = fakeApi(world);
  const id = 'wlib2000001';
  const w = createWidgets({
    readSettings: () => ({ homeWidgets: [{ id, type: 'spotify', mode, clientId: CLIENT, art: false, x: 0, y: 0, w: 8, h: 8 }] }), writeSettings: () => {},
    fetch: api.fetch, getSecret: () => 'REFRESH', setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}),
    rateMax: () => 1e6, searchRateMax: () => 1e6, spotifyEngine: engine, resizeThumb: (b) => (b.length > 3000 ? PNG : null),
    t: (key) => (key === 'spotify.library.liked' ? 'Liked Songs (en.json)' : key),
  });
  const data = () => w.cache.get(id).data;
  const look = async () => { const e = w.cache.get(id); if (e) e.at = 0; await w.refresh(w.list()[0], { force: true }); return data(); };
  const act = async (a) => { await w.act({ id, ...a }); return data(); };
  return { w, id, api, data, look, act };
}
const small = (r) => r && typeof r.thumb === 'string' && /^data:image\//.test(r.thumb) && r.thumb.length < 12000;

module.exports = async function spotifyLibraryV2Units(check) {
  const realWarn = console.warn;
  console.warn = () => {};
  {
    const world = {};
    const t = await make(world);
    const d0 = await t.look();
    check('library v2: the card says it has the new Library (libV2) and its words come from locales (spotify.library.*)', d0.libV2 === true && d0.libText.liked === 'Liked Songs (en.json)' && d0.libText.chipPlaylists === 'Playlists', JSON.stringify([d0.libV2, d0.libText && d0.libText.liked]));
    check('library v2: nothing is read until the Library is asked for', !t.api.log.some((l) => /\/me\/playlists/.test(l)) && !d0.lib2, JSON.stringify(t.api.log));
    let d = await t.act({ do: 'elib', arg: 'init' });
    check('library v2: the first page of playlists (50) and Liked Songs\' count (120) come first', d.lib2.lists.playlists.items.length === 50 && d.lib2.lists.playlists.done === false && d.lib2.likedTotal === 120, JSON.stringify([d.lib2.lists.playlists.items.length, d.lib2.likedTotal]));
    for (let i = 0; i < 6 && !d.lib2.lists.playlists.done; i++) d = await t.act({ do: 'elib', arg: 'playlists', more: true });
    const pl = d.lib2.lists.playlists;
    check('library v2: ALL the playlists load across pages (130, no two-page cap), each once, owned and followed alike', pl.items.length === 130 && pl.done === true && new Set(pl.items.map((r) => r.id)).size === 130 && pl.items.some((r) => r.ownerId === 'spotify'), `${pl.items.length} done=${pl.done}`);
    check('library v2: a playlist row has its name, owner and song count', pl.items.find((r) => r.id === 'BIG').sub === 'me' && pl.items.find((r) => r.id === 'BIG').count === 260 && pl.items.find((r) => r.id === 'EMPTY').count === 0, JSON.stringify(pl.items.find((r) => r.id === 'BIG')));
    const pageReads = t.api.log.filter((l) => l.startsWith('GET /me/playlists')).length;
    await t.act({ do: 'elib', arg: 'playlists', more: true });
    check('library v2: a finished list is not read again', t.api.log.filter((l) => l.startsWith('GET /me/playlists')).length === pageReads && pageReads === 3, String(pageReads));
    await t.act({ do: 'elib', arg: 'albums' });
    d = await t.act({ do: 'elib', arg: 'artists' });
    check('library v2: saved albums and followed artists are their own lists (the chips)', d.lib2.lists.albums.items[0].id === 'AL1' && d.lib2.lists.albums.items[0].count === 3 && d.lib2.lists.artists.items[0].id === 'AR1', JSON.stringify([d.lib2.lists.albums.items.length, d.lib2.lists.artists.items.length]));

    // pictures: asked for lazily, small
    check('library v2: no picture is fetched until the card asks for the rows on screen', !t.api.log.some((l) => l.startsWith('IMG')), '');
    d = await t.act({ do: 'ethumb', ids: ['P1', 'P2', 'AL1', 'AR1'] });
    check('library v2: the rows asked for get a small picture (a playlist, an album, an artist)', [d.lib2.lists.playlists.items.find((r) => r.id === 'P1'), d.lib2.lists.albums.items[0], d.lib2.lists.artists.items[0]].every(small) && t.api.log.filter((l) => l.startsWith('IMG')).length === 4, t.api.log.filter((l) => l.startsWith('IMG')).join());

    { const dd = await t.look(); check('library v2: the Library state survives the next look at the player (the poll after a press)', Boolean(dd.lib2) && dd.lib2.lists.playlists.items.length === 130, JSON.stringify(Object.keys(dd))); }
    // a big playlist, a page at a time
    d = await t.act({ do: 'edetail', kind: 'playlist', item: 'BIG' });
    let det = d.lib2.detail;
    check('opened playlist: the first page of songs (50) with the header facts, more to come', det.kind === 'playlist' && det.id === 'BIG' && det.title === 'The big one' && det.sub === 'me' && det.count === 260 && det.total === 260 && det.items.length === 48 && det.done === false, JSON.stringify([det.title, det.total, det.items.length, det.done]));
    check('opened playlist: a local file and an episode are skipped but still count: song 4 sits at place 4 and the song after the episode at place 6', det.items[2].title === 'Song 2' && det.items[3].pos === 4 && det.items[3].title === 'Song 4' && det.items[4].pos === 6, JSON.stringify(det.items.slice(0, 6).map((r) => [r.pos, r.title])));
    for (let i = 0; i < 8 && !det.done; i++) { d = await t.act({ do: 'edetail', kind: 'playlist', item: 'BIG', more: true }); det = d.lib2.detail; }
    check('opened playlist: scrolling pages in the rest (260 places, 258 playable songs), each once, in order', det.done === true && det.items.length === 258 && det.items[det.items.length - 1].pos === 259 && new Set(det.items.map((r) => r.pos)).size === 258 && t.api.log.filter((l) => l.startsWith('GET /playlists/BIG/items')).length === 6, `${det.items.length} reads=${t.api.log.filter((l) => l.startsWith('GET /playlists/BIG/items')).length}`);
    const reads = t.api.log.length;
    await t.act({ do: 'edetail', kind: 'playlist', item: 'BIG' });
    check('opened playlist: opened again within two minutes it is not read again (the back button costs nothing)', t.api.log.length === reads, '');
    d = await t.act({ do: 'ethumb', ids: ['T10', 'T11'] });
    check('opened playlist: the songs on screen get their small pictures', d.lib2.detail.items.filter(small).length === 2, String(d.lib2.detail.items.filter(small).length));

    // playing inside the list
    await t.act({ do: 'eplay', kind: 'playlist', item: 'BIG', pos: 120, with: 'T120' });
    check('clicking song N plays it inside its playlist: PUT /me/player/play with context_uri and offset N, so the next songs continue from it', JSON.parse(world.plays[world.plays.length - 1]).context_uri === 'spotify:playlist:BIG' && JSON.parse(world.plays[world.plays.length - 1]).offset.position === 120, world.plays.join());
    await t.act({ do: 'eplay', kind: 'playlist', item: 'BIG', pos: 4, with: 'T4' });
    check('...the place is the entry\'s own (a skipped local file counts): song 4 plays at offset 4', JSON.parse(world.plays[world.plays.length - 1]).offset.position === 4, world.plays.join());
    const before = world.plays.length;
    await t.w.act({ id: t.id, do: 'eplay', kind: 'playlist', item: 'BIG', pos: 120, with: 'T999' });
    check('...a row that is not the one the card showed is not played ("The list changed")', world.plays.length === before && /list changed/.test(t.data().notice || ''), JSON.stringify([world.plays.length, before, t.data().notice]));
    await t.act({ do: 'eplay', kind: 'playlist', item: 'BIG', shuffle: true });
    check('Play / Shuffle of the whole playlist: shuffle on, then the playlist from its start', t.api.log.includes('PUT /me/player/shuffle?state=true') && JSON.parse(world.plays[world.plays.length - 1]).context_uri === 'spotify:playlist:BIG' && !('offset' in JSON.parse(world.plays[world.plays.length - 1])), world.plays.join());
    await t.act({ do: 'playlater', kind: 'song', item: 'T10' });
    check('a song of an opened list can be added to the queue', (world.queued || []).includes('spotify:track:T10'), JSON.stringify(world.queued));

    // Liked Songs
    d = await t.act({ do: 'edetail', kind: 'liked', item: 'liked' });
    det = d.lib2.detail;
    check('Liked Songs opens like a playlist: its 120 songs (the card names it from its words), the first page of 50', det.kind === 'liked' && det.title === '' && det.total === 120 && det.items.length === 50 && det.done === false && det.items[0].title === 'Song 1000', JSON.stringify([det.title, det.total, det.items.length]));
    for (let i = 0; i < 4 && !det.done; i++) { d = await t.act({ do: 'edetail', kind: 'liked', item: 'liked', more: true }); det = d.lib2.detail; }
    check('Liked Songs: the rest pages in (120)', det.items.length === 120 && det.done === true, String(det.items.length));
    await t.act({ do: 'eplay', kind: 'liked', item: 'liked', pos: 7, with: 'T1007' });
    check('Liked Songs plays in its collection context: context_uri spotify:user:<id>:collection with offset 7', JSON.parse(world.plays[world.plays.length - 1]).context_uri === 'spotify:user:ME1:collection' && JSON.parse(world.plays[world.plays.length - 1]).offset.position === 7, world.plays.join());
    world.noCollection = true;
    await t.act({ do: 'eplay', kind: 'liked', item: 'liked', pos: 7, with: 'T1007' });
    const last = JSON.parse(world.plays[world.plays.length - 1]);
    check('...and when Spotify refuses that context, the songs read so far play as a list from song 7', Array.isArray(last.uris) && last.uris[0] === 'spotify:track:T1007' && last.uris.length === 100 && last.offset.position === 0, JSON.stringify(last).slice(0, 160));
    world.noCollection = false;

    // album and artist
    d = await t.act({ do: 'edetail', kind: 'album', item: 'AL1' });
    check('an album opens with its songs (their own pictures are the album\'s) and plays inside it', d.lib2.detail.items.length === 3 && d.lib2.detail.items[1].title === 'Album song 2' && d.lib2.detail.title === 'Saved One', JSON.stringify(d.lib2.detail.items.map((r) => r.title)));
    await t.act({ do: 'eplay', kind: 'album', item: 'AL1', pos: 1, with: 'AT2' });
    check('...album song 2 plays at offset 1 of the album', JSON.parse(world.plays[world.plays.length - 1]).context_uri === 'spotify:album:AL1' && JSON.parse(world.plays[world.plays.length - 1]).offset.position === 1, world.plays.join());
    d = await t.act({ do: 'edetail', kind: 'artist', item: 'AR1' });
    check('an artist opens with its top songs and its albums', d.lib2.detail.sections.topOk === true && d.lib2.detail.sections.top[0].title === 'Song 77' && d.lib2.detail.sections.albums[0].id === 'AL9', JSON.stringify(d.lib2.detail.sections));
    world.topBlocked = true;
    d = await t.act({ do: 'edetail', kind: 'artist', item: 'AR1', force: true });
    check('an artist whose top songs Spotify does not give an app: the albums still show, and the card can say so (topOk false), nothing invented', d.lib2.detail.sections.topOk === false && d.lib2.detail.sections.top.length === 0 && d.lib2.detail.sections.albums.length === 1, JSON.stringify(d.lib2.detail.sections));
    await t.act({ do: 'eplay', kind: 'artist', item: 'AR1' });
    check('an artist plays by its context', JSON.parse(world.plays[world.plays.length - 1]).context_uri === 'spotify:artist:AR1', world.plays.join());
  }
  {
    // no active device: a device the account has is woken; Play as Lumen waits for its own player
    const world = { noDevice: true, devices: [{ id: 'dev1', name: 'Web Player', type: 'Computer', is_active: false, is_restricted: false }] };
    let warmed = 0;
    const engine = { read: async () => ({ mode: 'status', state: 'idle', title: '', artist: '', album: '', progressMs: 0, durationMs: 0, at: Date.now(), source: 'engine', kind: 'none', reason: '', art: '', signedIn: true, can: { search: true } }), warm: () => { warmed++; }, command: () => true };
    const t = await make(world, { mode: 'status', engine });
    const d0 = await t.look();
    check('Play as Lumen + connected account: the card has the new Library (libV2) too', d0.libV2 === true, JSON.stringify(Object.keys(d0)));
    await t.act({ do: 'elib', arg: 'init' });
    await t.act({ do: 'edetail', kind: 'playlist', item: 'BIG' });
    await t.act({ do: 'eplay', kind: 'playlist', item: 'BIG', pos: 9, with: 'T9' });
    check('Play as Lumen: a song plays in its playlist on Lumen\'s own player (started, a device woken, context and offset sent)', warmed >= 1 && world.woken === true && JSON.parse(world.plays[world.plays.length - 1]).offset.position === 9, JSON.stringify([warmed, world.woken, world.plays]));
  }
  console.warn = realWarn;
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
