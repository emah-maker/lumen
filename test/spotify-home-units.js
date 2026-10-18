// The Spotify card's Home tab (features/spotify-api-card.js loadShelf, features/spotify-view.js, features/widgets.js) against a fake Web API shaped like Spotify's:
// each shelf (quick picks, jump back in, made for you, recently played, top songs, top artists, new releases, your playlists, albums, followed artists) is read when asked
// for, once per source (shared and cached for a minute), and has covers as small data: URLs; "made for you" is the account's Spotify-owned Daily Mix / Discover Weekly
// style playlists only; a missing scope marks that shelf (and only it); a shelf the API refuses is left out; a tile plays and a song queues through the same calls as
// the rest of the card; the Play-as-Lumen card shows Home only when the account is connected. Runs on its own (npm run test:units picks up test/*-units.js).
'use strict';
const { createWidgets } = require('../src/features/widgets');
const SV = require('../src/features/spotify-view');

const CLIENT = '0123456789abcdef0123456789abcdef';
const reply = (status, body) => new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status });
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const picture = (n) => Buffer.concat([Buffer.from(PNG_SIG), Buffer.alloc(n - 8, 7)]);
const SMALL = Buffer.concat([Buffer.from(PNG_SIG), Buffer.alloc(2500, 3)]);
const img = (id, ws = [640, 300, 64]) => ws.map((w) => ({ url: `https://i.scdn.co/image/${id}${w}`, width: w, height: w }));
const album = (n) => ({ id: `AL${n}`, type: 'album', name: `Album ${n}`, artists: [{ name: 'Ann' }], release_date: '2024-01-01', images: img(`al${n}`) });
const track = (n, al = n) => ({ id: `T${n}`, type: 'track', name: `Song ${n}`, duration_ms: 1000, artists: [{ name: 'Ann' }], album: album(al) });
const playlist = (id, name, owner = 'someone') => ({ id, type: 'playlist', name, owner: { id: owner, display_name: owner }, images: [{ url: `https://mosaic.scdn.co/640/${id}`, width: null, height: null }] });

function fakeApi(world) {
  const log = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    if (u.host === 'i.scdn.co' || u.host === 'mosaic.scdn.co') { log.push(`IMG ${u.pathname}`); return new Response(picture(24000), { status: 200 }); }
    if (u.host === 'accounts.spotify.com') return reply(200, { access_token: 'TOKEN', token_type: 'Bearer', expires_in: 3600 });
    if (u.host !== 'api.spotify.com') return reply(404);
    const p = u.pathname.replace(/^\/v1/, '');
    log.push(`${method} ${p}${u.search}`);
    if (world.deny && world.deny[p]) return reply(world.deny[p], world.deny[p] === 403 ? { error: { status: 403, message: 'Insufficient client scope' } } : {});
    if (p === '/me/player/recently-played') {
      // 8 plays: songs 1..8 from albums 1..4 (two songs each), the first four from playlist PLMIX1 / album context
      const items = Array.from({ length: 8 }, (_, i) => ({ track: track(i + 1, Math.floor(i / 2) + 1), played_at: 'x', context: i < 4 ? { type: 'playlist', uri: 'spotify:playlist:PLMIX1' } : { type: 'album', uri: `spotify:album:AL${Math.floor(i / 2) + 1}` } }));
      items.push({ track: track(1, 1), played_at: 'x', context: { type: 'artist', uri: 'spotify:artist:AR1' } }); // (song 1 again: shown once)
      return reply(200, { items });
    }
    if (p === '/me/playlists') return reply(200, { items: [playlist('PLMIX1', 'Daily Mix 1', 'spotify'), playlist('PLDW', 'Discover Weekly', 'spotify'), playlist('PLHITS', 'Today’s Top Hits', 'spotify'), playlist('PLMINE', 'Road trip', 'me'), playlist('PLFRIEND', 'Daily Mix 2', 'someone')], next: null });
    if (p === '/me/albums') return reply(200, { items: [{ album: album(7) }, { album: album(8) }], next: null });
    if (p === '/me/following') return reply(200, { artists: { items: [{ id: 'AR1', type: 'artist', name: 'Followed', images: img('ar1', [640, 320, 160]) }], next: null } });
    if (p === '/me/top/artists') return reply(200, { items: [{ id: 'AR2', type: 'artist', name: 'Top Artist', images: img('ar2', [640, 320, 160]) }] });
    if (p === '/me/top/tracks') return reply(200, { items: [track(21), track(22)] });
    if (p === '/browse/new-releases') return reply(200, { albums: { items: [album(31), album(32), album(33)] } });
    if (p === '/me/player/devices') return reply(200, { devices: [] });
    if (p === '/me/player') return reply(204);
    if (p === '/me/player/play' || p === '/me/player/queue') { world.calls = (world.calls || []).concat(`${method} ${p}${u.search} ${opts.body || ''}`.trim()); return reply(204); }
    return reply(404);
  };
  return { fetch, log };
}

async function make(world, { mode = 'api', engine = null, secret = 'REFRESH', apiBudget = 1e6 } = {}) {
  const api = fakeApi(world);
  const secrets = new Map(secret ? [['spotify', secret]] : []);
  const id = 'whome00001';
  const w = createWidgets({
    readSettings: () => ({ homeWidgets: [{ id, type: 'spotify', mode, clientId: CLIENT, art: false, x: 0, y: 0, w: 8, h: 7 }] }), writeSettings: () => {},
    fetch: api.fetch, getSecret: (n) => secrets.get(n) || null, setSecret: (n, v) => { secrets.set(n, v); }, onUpdate: () => {}, endpoints: () => ({}),
    rateMax: () => 1e6, searchRateMax: () => apiBudget, spotifyEngine: engine, resizeThumb: (b) => (b.length > 3000 ? SMALL : null),
    t: (key) => (key === 'spotify.home.made' ? 'Made for you (en.json)' : key),
  });
  const data = () => w.cache.get(id).data;
  const look = async () => { const e = w.cache.get(id); if (e) e.at = 0; await w.refresh(w.list()[0], { force: true }); return data(); };
  const shelf = async (key, force = false) => { await w.act({ id, do: 'ehome', arg: key, ...(force ? { force: true } : {}) }); return data().home.shelves[key]; };
  return { w, id, api, data, look, shelf };
}
const small = (r) => r && typeof r.thumb === 'string' && /^data:image\/(?:png|jpeg|webp);base64,/.test(r.thumb) && r.thumb.length < 12000;

module.exports = async function spotifyHomeUnits(check) {
  const realWarn = console.warn;
  console.warn = () => {};
  {
    const world = {};
    const t = await make(world);
    const first = await t.look();
    check('home: the card has the Home tab (can.home) and its words come from locales (spotify.home.*)', first.can.home === true && first.homeText.made === 'Made for you (en.json)' && first.homeText.jump === 'Jump back in', JSON.stringify(first.can));
    check('home: nothing is asked of Spotify until a shelf is (no home field yet)', !first.home && !t.api.log.some((l) => /recently-played\?limit=50|top|browse/.test(l)), '');

    const quick = await t.shelf('quick');
    check('home, quick picks: the albums of what was played recently, each once, six at most, with covers', quick.ok && quick.items.length === 4 && quick.items.map((i) => i.id).join() === 'AL1,AL2,AL3,AL4' && quick.items.every((i) => i.kind === 'album' && small(i)), JSON.stringify(quick.items.map((i) => [i.id, i.kind, Boolean(i.thumb)])));
    const jump = await t.shelf('jump');
    check('home, jump back in: the playlists, albums and artists those plays came from, named from your library', jump.ok && jump.items.map((i) => `${i.kind}:${i.id}`).join() === 'playlist:PLMIX1,artist:AR1' && jump.items.every(small), JSON.stringify(jump.items.map((i) => `${i.kind}:${i.id}`)));
    const recent = await t.shelf('recent');
    check('home, recently played: songs, each once (a song played twice is one tile), with covers', recent.ok && recent.items.length === 8 && new Set(recent.items.map((i) => i.id)).size === 8 && recent.items.every((i) => i.kind === 'song' && small(i)), JSON.stringify(recent.items.map((i) => i.id)));
    check('home: quick picks, jump back in and recently played share ONE recently-played request', t.api.log.filter((l) => l.includes('recently-played?limit=50')).length === 1, JSON.stringify(t.api.log.filter((l) => l.includes('recently-played'))));
    const made = await t.shelf('made');
    check('home, made for you: only Spotify-owned Daily Mix / Discover Weekly style playlists (not a friend\'s "Daily Mix 2", not Today\'s Top Hits, not your own)', made.ok && made.items.map((i) => i.id).join() === 'PLMIX1,PLDW' && made.items.every(small), JSON.stringify(made.items.map((i) => i.id)));
    const pls = await t.shelf('playlists');
    check('home, your playlists: your list without the made-for-you ones', pls.ok && pls.items.map((i) => i.id).join() === 'PLHITS,PLMINE,PLFRIEND', JSON.stringify(pls.items.map((i) => i.id)));
    check('home: made for you and your playlists share ONE playlists request', t.api.log.filter((l) => l.startsWith('GET /me/playlists')).length === 1, JSON.stringify(t.api.log.filter((l) => l.includes('/me/playlists'))));
    const ta = await t.shelf('topartists');
    const tt = await t.shelf('toptracks');
    const nr = await t.shelf('new');
    const al = await t.shelf('albums');
    const ar = await t.shelf('artists');
    check('home: top artists, top songs, new releases, your albums and followed artists each have tiles with covers (an artist\'s 160 px picture too)', ta.items.length === 1 && tt.items.length === 2 && nr.items.length === 3 && al.items.length === 2 && ar.items.length === 1 && [ta, tt, nr, al, ar].every((s) => s.ok && s.items.every(small)), JSON.stringify([ta.items.length, tt.items.length, nr.items.length, al.items.length, ar.items.length]));
    check('home: a tile has an id, a kind, a title and a subtitle', nr.items[0].title === 'Album 31' && nr.items[0].sub.startsWith('Ann') && tt.items[0].sub === 'Ann' && ta.items[0].kind === 'artist', JSON.stringify([nr.items[0], tt.items[0]]));
    // the cache
    const before = t.api.log.length;
    await t.shelf('quick');
    await t.shelf('made');
    check('home: a shelf asked again within a minute is not read again', t.api.log.length === before, JSON.stringify(t.api.log.slice(before)));
    await t.shelf('made', true);
    check('home: Try again (force) reads it again', t.api.log.length > before, '');
    // play and queue from a tile
    await t.w.act({ id: t.id, do: 'playitem', kind: 'album', item: 'AL1' });
    await t.w.act({ id: t.id, do: 'playitem', kind: 'playlist', item: 'PLMIX1' });
    await t.w.act({ id: t.id, do: 'playlater', kind: 'song', item: 'T21' });
    check('home: pressing an album or playlist tile plays its context; a song tile\'s queue button adds it to the queue', world.calls.some((c) => /PUT \/me\/player\/play .*"context_uri":"spotify:album:AL1"/.test(c)) && world.calls.some((c) => /"context_uri":"spotify:playlist:PLMIX1"/.test(c)) && world.calls.some((c) => c.startsWith('POST /me/player/queue?uri=spotify%3Atrack%3AT21')), JSON.stringify(world.calls));
  }
  {
    // a missing scope marks that shelf only; a shelf the API refuses is left out
    const world = { deny: { '/me/top/artists': 403, '/browse/new-releases': 404 } };
    const t = await make(world);
    await t.look();
    const ta = await t.shelf('topartists');
    const nr = await t.shelf('new');
    const ok = await t.shelf('albums');
    check('home, missing scope (user-top-read): that shelf says why = scope (the card shows "Reconnect Spotify to show more"), the others still load', ta.ok === false && ta.why === 'scope' && ok.ok === true && ok.items.length === 2 && t.data().needsScopes === true, JSON.stringify([ta, ok.ok]));
    check('home, new releases refused (404): the shelf is not ok (the card leaves it out), nothing is invented', nr.ok === false && nr.why === 'page' && nr.items.length === 0, JSON.stringify(nr));
  }
  {
    // Play as Lumen: Home only with the account connected
    const engine = { read: async () => ({ mode: 'status', state: 'idle', title: '', artist: '', album: '', progressMs: 0, durationMs: 0, at: Date.now(), source: 'engine', kind: 'none', reason: '', art: '', signedIn: true, can: { search: true, library: true } }), warm: () => {}, command: () => true, refreshLists: () => {} };
    const on = await make({}, { mode: 'status', engine });
    const d1 = await on.look();
    await on.w.act({ id: on.id, do: 'ehome', arg: 'made' });
    const d2 = on.data();
    check('Play as Lumen + connected account: Home is offered (can.home, and the engine\'s own can is kept) and its shelves load', d1.can.home === true && d1.can.search === true && d2.home?.shelves?.made?.items?.length === 2, JSON.stringify([d1.can, d2.home && Object.keys(d2.home.shelves)]));
    const off = await make({}, { mode: 'status', engine, secret: '' });
    const d3 = await off.look();
    check('Play as Lumen without a connected account: the Home tab is offered with a connect prompt and no shelves (nothing to read them with; test/spotify-reconnect-units.js covers the button)', d3.can.home === true && d3.home.connect === true && Object.keys(d3.home.shelves).length === 0, JSON.stringify([d3.can, d3.home]));
  }
  {
    // the covers of a whole Home (about forty here, a hundred for a full one) come from Spotify's picture hosts: they do not spend the API's request budget
    const t = await make({}, { apiBudget: 12 }); // (the API's own budget is tiny: twelve calls a minute)
    await t.look();
    for (const k of ['quick', 'jump', 'made', 'recent', 'toptracks', 'topartists', 'new', 'playlists', 'albums', 'artists']) await t.shelf(k);
    const shelves = t.data().home.shelves;
    const pics = t.api.log.filter((l) => l.startsWith('IMG')).length;
    check('home: every shelf loads with its covers although the API budget is twelve calls (pictures have a budget of their own)', Object.values(shelves).every((s) => s.ok) && pics > 12 && Object.values(shelves).every((s) => s.items.every(small)), JSON.stringify([Object.entries(shelves).filter(([, s]) => !s.ok).map(([k]) => k), pics]));
  }
  check('home: Spotify-owned detection patterns', ['Daily Mix 3', 'Discover Weekly', 'Release Radar', 'On Repeat', 'Repeat Rewind', 'Your Top Songs 2025', 'Time Capsule'].every((n) => SV.MADE_RE.test(n)) && !['Top Hits', 'Chill Mix', 'Today’s Top Hits'].some((n) => SV.MADE_RE.test(n)), '');
  console.warn = realWarn;
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
