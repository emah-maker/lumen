// The Home tab's suggestion shelves (features/spotify-recs.js, features/spotify-api-card.js) against a fake Web API that either REFUSES the endpoints Spotify closed to newer apps
// (GET /recommendations, /artists/{id}/related-artists, /artists/{id}/top-tracks: 403 / 404) or ALLOWS them (an app with extended access): each is probed once per session; allowed,
// its answer is the shelf; refused, the shelves are built from endpoints that still work (the newest albums and singles of your artists, genre searches, top songs you have not
// saved) and say what they are built from; no item repeats across the suggestion shelves or is one already on the library shelves; the artists and genres taken rotate daily; tiles
// play and queue. Runs on its own (npm run test:units picks up test/*-units.js).
'use strict';
const { createWidgets } = require('../../src/features/widgets');

const CLIENT = '0123456789abcdef0123456789abcdef';
const DAY = 86400e3;
const reply = (status, body) => new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1500, 3)]);
const img = (id, ws = [640, 300, 64]) => ws.map((w) => ({ url: `https://i.scdn.co/image/${id}${w}`, width: w, height: w }));
const track = (n) => ({ id: `T${n}`, type: 'track', name: `Song ${n}`, duration_ms: 1000, artists: [{ name: 'Ann' }], album: { id: `AL${n}`, name: `Album ${n}`, images: img(`t${n}`) } });
const artist = (id, name, genres = []) => ({ id, type: 'artist', name, genres, images: img(`a${id}`, [640, 320, 160]) });
const day = (now, ago) => new Date(now - ago * DAY).toISOString().slice(0, 10);

function fakeApi(world, nowFn) {
  const log = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    if (u.host === 'i.scdn.co') { log.push(`IMG ${u.pathname}`); return new Response(PNG, { status: 200 }); }
    if (u.host === 'accounts.spotify.com') return reply(200, { access_token: 'TOKEN', token_type: 'Bearer', expires_in: 3600 });
    if (u.host !== 'api.spotify.com') return reply(404);
    const p = decodeURIComponent(u.pathname.replace(/^\/v1/, ''));
    log.push(`${method} ${p}${u.search}`);
    const now = nowFn();
    const closed = (name, status) => (world.allowed.has(name) ? null : reply(status, { error: { status, message: 'Forbidden' } }));
    if (p === '/me/top/artists') return reply(200, { items: [artist('A1', 'Top One', ['indie pop', 'dream pop']), artist('A2', 'Top Two', ['indie pop']), artist('A3', 'Top Three', ['shoegaze'])] });
    if (p === '/me/top/tracks') return reply(200, { items: [track(21), track(22)] });
    if (p === '/me/following') return reply(200, { artists: { items: [artist('F1', 'Followed One', ['folk'])], next: null } });
    if (p === '/me/playlists') return reply(200, { items: [{ id: 'PL1', type: 'playlist', name: 'Road trip', owner: { id: 'me', display_name: 'me' }, images: img('pl1') }], next: null });
    if (p === '/me/albums') return reply(200, { items: [{ album: { id: 'ALIB', type: 'album', name: 'Library album', artists: [{ name: 'Ann' }], release_date: day(now, 5), images: img('alib') } }], next: null });
    if (p === '/me/player/recently-played') return reply(200, { items: [{ track: track(31), context: null }] });
    if (p === '/recommendations') return closed('recs', 403) || reply(200, { tracks: [track(21), track(41), track(42), track(43)] }); // (21 is one of your top songs: not shown twice)
    if (/^\/artists\/[A-Za-z0-9]+\/related-artists$/.test(p)) return closed('related', 404) || reply(200, { artists: [artist('F1', 'Followed One'), artist('R1', 'Related One'), artist('R2', 'Related Two')] });
    if (/^\/artists\/[A-Za-z0-9]+\/top-tracks$/.test(p)) { const id = p.split('/')[2]; return closed('toptracks', 403) || reply(200, { tracks: [track(51 + id.length), track(61), track(62)] }); }
    if (/^\/artists\/[A-Za-z0-9]+\/albums$/.test(p)) {
      const id = p.split('/')[2];
      return reply(200, { items: [
        { id: `N${id}`, type: 'album', name: `New from ${id}`, artists: [{ name: id }], release_date: day(now, id === 'A1' ? 10 : id === 'A2' ? 3 : 40), images: img(`n${id}`) },
        { id: `O${id}`, type: 'album', name: `Old from ${id}`, artists: [{ name: id }], release_date: day(now, 900), images: img(`o${id}`) },
        { id: 'ALIB', type: 'album', name: 'Library album', artists: [{ name: id }], release_date: day(now, 5), images: img('alib') },
      ] });
    }
    if (p === '/me/library/contains') { const uris = (u.searchParams.get('uris') || '').split(','); return reply(200, uris.map((x) => /T61$/.test(x))); } // (song 61 is saved)
    if (p === '/search') {
      const q = u.searchParams.get('q') || '';
      world.searches.push(q + '|' + u.searchParams.get('type'));
      if (u.searchParams.get('type') === 'track') return reply(200, { tracks: { items: [track(71), track(72), track(61), track(21)] } });
      return reply(200, { artists: { items: [artist('A1', 'Top One'), artist('G1', 'Genre One'), artist('G2', 'Genre Two')] } });
    }
    if (p === '/me/player/play' || p === '/me/player/queue') { world.calls = (world.calls || []).concat(`${method} ${p}${u.search} ${opts.body || ''}`.trim()); return reply(204); }
    if (p === '/me/player') return reply(204);
    return reply(404);
  };
  return { fetch, log };
}

async function make(allowed, clock) {
  const world = { allowed: new Set(allowed), searches: [] };
  const api = fakeApi(world, () => clock.now);
  const id = 'wrecs00001';
  const w = createWidgets({
    readSettings: () => ({ homeWidgets: [{ id, type: 'spotify', mode: 'api', clientId: CLIENT, art: false, x: 0, y: 0, w: 8, h: 8 }] }), writeSettings: () => {},
    fetch: api.fetch, getSecret: () => 'REFRESH', setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}), now: () => clock.now,
    rateMax: () => 1e6, searchRateMax: () => 1e6, resizeThumb: (b) => (b.length > 3000 ? PNG : null),
  });
  const data = () => w.cache.get(id).data;
  const look = async () => { const e = w.cache.get(id); if (e) e.at = 0; await w.refresh(w.list()[0], { force: true }); return data(); };
  const shelf = async (key, force = false) => { await w.act({ id, do: 'ehome', arg: key, ...(force ? { force: true } : {}) }); return (data().home.shelves || {})[key]; };
  const all = async () => { for (const k of ['quick', 'jump', 'made', 'recommended', 'newfrom', 'recent', 'toptracks', 'topartists', 'moretop', 'related', 'genres', 'genreartists', 'new', 'playlists', 'albums', 'artists']) await shelf(k); return data().home.shelves; };
  return { w, id, api, world, data, look, shelf, all };
}
const keys = (s) => (s ? s.items.map((i) => `${i.kind}:${i.id}`) : []);
const small = (r) => r && typeof r.thumb === 'string' && /^data:image\//.test(r.thumb) && r.thumb.length < 12000;

module.exports = async function spotifyRecsUnits(check) {
  const realWarn = console.warn;
  console.warn = () => {};
  const REC_KEYS = ['recommended', 'related', 'newfrom', 'moretop', 'genres', 'genreartists'];
  {
    // ---- Spotify's own recommendation endpoints refused ----
    const clock = { now: Math.ceil(Date.UTC(2026, 9, 18) / DAY / 3) * 3 * DAY + 12 * 3600e3 }; // (a date whose day number is a multiple of 3: the first genre and artist)
    const t = await make([], clock);
    await t.look();
    const rec = await t.shelf('recommended');
    const rel = await t.shelf('related');
    check('blocked: "Recommended for you" and "Fans also like" are not drawn (Spotify refuses the endpoints: ok false, why blocked), and nothing stands in for them under those names', rec.ok === false && rec.why === 'blocked' && rel.ok === false && rel.why === 'blocked' && rec.items.length === 0, JSON.stringify([rec, rel]));
    const nf = await t.shelf('newfrom');
    check('blocked: "New from artists you love" is built from your artists\' albums and singles: only recent ones (not the 900-day-old), newest first, never one already in your library', nf.ok && nf.items.length >= 3 && nf.items.every((i) => /^N/.test(i.id)), JSON.stringify(nf.items.map((i) => [i.id, i.released])));
    check('blocked: ...in date order, each with its cover, none from the library', nf.items.length >= 2 && nf.items.every((i, k, a) => k === 0 || a[k - 1].released >= i.released) && nf.items.every(small) && !nf.items.some((i) => i.id === 'ALIB'), JSON.stringify(nf.items.map((i) => [i.id, i.released, Boolean(i.thumb)])));
    const mt = await t.shelf('moretop');
    check('blocked: "More from your top artists" (the artist top-songs endpoint is closed to this app too) is not drawn', mt.ok === false && mt.why === 'blocked', JSON.stringify(mt));
    const gs = await t.shelf('genres');
    check('blocked: "Based on your genres" searches the most common genre of your top artists (indie pop), and shows songs you have not saved, none already on your shelves', gs.ok && t.world.searches[0] === 'genre:"indie pop"|track' && gs.items.map((i) => i.id).join() === 'T71,T72' && gs.captionVars.title === 'indie pop' && gs.items.every(small), JSON.stringify([t.world.searches, gs.items.map((i) => i.id)]));
    const ga = await t.shelf('genreartists');
    check('blocked: "Artists to try" shows artists of another of your genres that you do not follow (not your top artist)', ga.ok && ga.items.map((i) => i.id).join() === 'G1,G2' && ga.captionVars.title === 'dream pop', JSON.stringify([ga.items.map((i) => i.id), ga.captionVars]));
    await t.shelf('new');
    const shelves = await t.all();
    const recKeys = REC_KEYS.flatMap((k) => keys(shelves[k]));
    const libKeys = new Set(Object.entries(shelves).filter(([k]) => !REC_KEYS.includes(k)).flatMap(([, s]) => keys(s)));
    check('no item repeats across the suggestion shelves, and none is on the library shelves', new Set(recKeys).size === recKeys.length && !recKeys.some((k) => libKeys.has(k)), JSON.stringify(recKeys));
    check('suggestions are not library items: the song you saved (61) and your top song (21) are not in them', !recKeys.includes('song:T61') && !recKeys.includes('song:T21'), JSON.stringify(recKeys));
    // probed once, cached
    const before = t.api.log.length;
    await t.shelf('recommended');
    await t.shelf('related');
    await t.shelf('moretop');
    check('a refused endpoint is probed once per session: asking again is not another request', t.api.log.length === before && t.api.log.filter((l) => l.startsWith('GET /recommendations')).length === 1, JSON.stringify(t.api.log.slice(before)));
    const before2 = t.api.log.length;
    await t.shelf('newfrom');
    await t.shelf('genres');
    check('a built shelf is cached for half an hour: asked again, nothing is requested', t.api.log.length === before2, JSON.stringify(t.api.log.slice(before2)));
    // the daily seed
    const first = t.api.log.filter((l) => /^GET \/artists\/\w+\/albums/.test(l)).map((l) => l.split('/')[2]);
    clock.now += DAY + 60e3;
    await t.shelf('newfrom', true);
    const second = t.api.log.filter((l) => /^GET \/artists\/\w+\/albums/.test(l)).slice(first.length).map((l) => l.split('/')[2]);
    check('the artists taken rotate with the date (a new day starts from another of your artists)', first.length > 0 && second.length > 0 && first[0] !== second[0], JSON.stringify([first, second]));
    const gsDay2 = await t.shelf('genres', true);
    check('the genre rotates with the date too', gsDay2.captionVars && gsDay2.captionVars.title !== 'indie pop', JSON.stringify(gsDay2.captionVars));
    // playing and queueing a tile
    const g = t.data().home.shelves.genres.items.find((i) => i.kind === 'song') || { id: 'T71' };
    await t.w.act({ id: t.id, do: 'playitem', kind: 'album', item: 'NA1' });
    await t.w.act({ id: t.id, do: 'playlater', kind: 'song', item: g.id });
    check('tiles of the suggestion shelves play (an album: its context) and queue (a song: POST /me/player/queue)', t.world.calls.some((c) => /PUT \/me\/player\/play .*"context_uri":"spotify:album:NA1"/.test(c)) && t.world.calls.some((c) => c.startsWith(`POST /me/player/queue?uri=spotify%3Atrack%3A${g.id}`)), JSON.stringify(t.world.calls));
  }
  {
    // ---- an app with extended access: Spotify's own recommendations ----
    const clock = { now: Math.ceil(Date.UTC(2026, 9, 18) / DAY / 3) * 3 * DAY + 12 * 3600e3 };
    const t = await make(['recs', 'related', 'toptracks'], clock);
    await t.look();
    const rec = await t.shelf('recommended');
    check('allowed: "Recommended for you" is Spotify\'s own answer, seeded from your top songs and artists, without the song already on your top-songs shelf', rec.ok && rec.items.map((i) => i.id).join() === 'T41,T42,T43' && rec.items.every(small) && t.api.log.some((l) => /^GET \/recommendations\?.*seed_artists=\w+,\w+,\w+.*seed_tracks=T21,T22/.test(l)), JSON.stringify([rec.items && rec.items.map((i) => i.id), t.api.log.filter((l) => l.includes('recommendations'))]));
    await t.shelf('toptracks');
    const shelves = await t.all();
    check('allowed: "Recommended for you" shows only what is not on the library shelves (the top song 21 Spotify also recommended is dropped there)', !keys(shelves.recommended).includes('song:T21') && keys(shelves.recommended).length === 3, JSON.stringify(keys(shelves.recommended)));
    const rel = shelves.related;
    check('allowed: "Fans also like" is Spotify\'s related artists of one of your artists, without anyone you already follow, with the caption\'s name', rel.ok && rel.items.map((i) => i.id).join() === 'R1,R2' && Boolean(rel.captionVars && rel.captionVars.title), JSON.stringify([rel.items.map((i) => i.id), rel.captionVars]));
    const mt = shelves.moretop;
    check('allowed: "More from your top artists" shows their top songs you have not saved (the saved song 61 is left out)', mt.ok && mt.items.length > 0 && !keys(mt).includes('song:T61'), JSON.stringify(keys(mt)));
    const recKeys = REC_KEYS.flatMap((k) => keys(shelves[k]));
    check('allowed: still no item twice across the suggestion shelves', new Set(recKeys).size === recKeys.length, JSON.stringify(recKeys));
    check('allowed: the probe is one request each', t.api.log.filter((l) => l.startsWith('GET /recommendations')).length === 1, '');
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
