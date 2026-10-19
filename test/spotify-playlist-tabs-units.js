// The Spotify card's playlist tabs (Web API mode), without Electron or the network: a playlist or album opened in the card, pinned as a tab and played
// from a row. Pure view logic (pins, the list answers, the requests), features/spotify-api-card.js against a mocked `call`, and the connector against a
// fake Spotify (pins saved in the widget's settings, the page's actions checked). Runs on its own (npm run test:units picks up test/*-units.js).
const fs = require('fs');
const path = require('path');
const SV = require('../src/features/spotify-view');
const SAC = require('../src/features/spotify-api-card');
const MCF = require('../src/features/music-card-features');
const { createWidgets } = require('../src/features/widgets');

const CLIENT = '0123456789abcdef0123456789abcdef';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const song = (id, name, extra = {}) => ({ type: 'track', id, name, duration_ms: 180000, artists: [{ name: 'Ann' }], album: { images: [{ url: 'https://i.scdn.co/image/a', width: 64 }] }, ...extra });
// Spotify's February 2026 shape: `items`, each entry's song under `item`. An episode, a removed song and a local file are in it too.
const PLAYLIST = JSON.stringify({ items: [{ item: song('s1', 'One') }, { item: { type: 'episode', id: 'e1', name: 'Talk' } }, { item: null }, { item: song('s2', 'Two') }, { track: song('s3', 'Three (old name)') }] });
const ALBUM = JSON.stringify({ name: 'Quiet Hours', images: [{ url: 'https://i.scdn.co/image/c', width: 300 }], tracks: { items: [song('t1', 'First'), song('t2', 'Second')] } });

function fakeSpotify(log) {
  const reply = (status, body = '{}') => new Response(status === 204 ? null : body, { status });
  return async (url, opts = {}) => {
    const u = new URL(url);
    log.push({ method: opts.method || 'GET', path: u.pathname + u.search, body: typeof opts.body === 'string' ? opts.body : '' });
    if (u.host === 'accounts.spotify.com') return reply(200, JSON.stringify({ access_token: 'ACCESS', token_type: 'Bearer', expires_in: 3600 }));
    if (u.pathname === '/v1/me/player' && (opts.method || 'GET') === 'GET') return reply(204);
    if (u.pathname === '/v1/me') return reply(200, JSON.stringify({ display_name: 'Me' }));
    if (u.pathname === '/v1/me/playlists') return reply(200, JSON.stringify({ items: [{ id: 'pl1', type: 'playlist', name: 'Road trip', owner: { display_name: 'Me' }, images: [] }] }));
    if (u.pathname === '/v1/me/player/recently-played' || u.pathname === '/v1/me/tracks') return reply(200, JSON.stringify({ items: [] }));
    if (u.pathname === '/v1/playlists/pl1/items') return reply(200, PLAYLIST);
    if (u.pathname === '/v1/albums/al1') return reply(200, ALBUM);
    if (u.pathname === '/v1/me/player/play' || u.pathname === '/v1/me/player/shuffle') return reply(204);
    return reply(404);
  };
}

module.exports = async function playlistTabsUnits(check) {
  // ---- pins: validated ----
  const good = { kind: 'playlist', id: 'pl1', title: 'Road trip' };
  check('pins: a playlist or album with a safe id and a title is kept; its title is one short line', JSON.stringify(SV.cleanPins([good, { kind: 'album', id: 'al1', title: 'A\nB'.padEnd(90, 'x') }])) === JSON.stringify([good, { kind: 'album', id: 'al1', title: `A B${'x'.repeat(57)}` }]), '');
  check('pins: another kind, an unsafe id, no title, a repeat and anything that is not an object are dropped', SV.cleanPins([{ kind: 'artist', id: 'a', title: 'x' }, { kind: 'playlist', id: '../x', title: 'x' }, { kind: 'playlist', id: 'ok', title: '' }, good, good, null, 'x', 5]).length === 1 && SV.cleanPins('x').length === 0 && SV.cleanPins(null).length === 0, '');
  check('pins: at most four', SV.cleanPins(Array.from({ length: 9 }, (_, i) => ({ kind: 'playlist', id: `p${i}`, title: `P${i}` }))).length === 4 && SV.MAX_PINS === 4, '');
  check('pins: they are part of the stored settings only when there are some', !('pins' in SV.cleanConfig({ mode: 'api', clientId: CLIENT })) && SV.cleanConfig({ mode: 'api', pins: [good] }).pins.length === 1, '');
  const full = SV.cleanPins(Array.from({ length: 4 }, (_, i) => ({ kind: 'playlist', id: `p${i}`, title: `P${i}` })));
  check('pins: pinning adds at the end; a fifth is refused with a reason; pinning twice changes nothing; unpinning removes just that one', SV.applyPin([], 'add', 'playlist', 'pl1', 'Road trip').pins[0].id === 'pl1' && /Up to 4/.test(SV.applyPin(full, 'add', 'playlist', 'zz', 'Z').error) && SV.applyPin([good], 'add', 'playlist', 'pl1', 'Road trip').pins.length === 1 && SV.applyPin(full, 'remove', 'playlist', 'p1').pins.map((p) => p.id).join() === 'p0,p2,p3', '');
  check('pins: a pin needs a name and a pinnable kind and id', SV.applyPin([], 'add', 'playlist', 'pl1', '').error && SV.applyPin([], 'add', 'song', 'pl1', 'x').error && SV.applyPin([], 'add', 'playlist', 'a b', 'x').error, '');

  // ---- the list answers and the requests ----
  const pl = SV.normalizeListing('playlist', PLAYLIST);
  check('playlist items: `item` (and the older `track`) are read; an episode, a removed or a local entry is skipped but still counts for the place', pl.items.map((i) => `${i.id}@${i.pos}`).join() === 's1@0,s2@3,s3@4', JSON.stringify(pl.items.map((i) => [i.id, i.pos])));
  check('playlist items: a page of `items` inside `items` is read too', SV.normalizeListing('playlist', JSON.stringify({ items: { items: [{ item: song('s9', 'Nine') }] } })).items[0].id === 's9', '');
  const al = SV.normalizeListing('album', ALBUM);
  check('album: its name, its songs in order with their place', al.title === 'Quiet Hours' && al.items.map((i) => `${i.id}@${i.pos}`).join() === 't1@0,t2@1', '');
  check('lists: garbage gives an empty list', SV.normalizeListing('playlist', 'nope').items.length === 0 && SV.normalizeListing('album', '[]').items.length === 0, '');
  check('requests: a playlist is read from /playlists/{id}/items (not the removed `tracks`), an album from /albums/{id}', SV.PLAYER.listing('playlist', 'pl1')[1].startsWith('/playlists/pl1/items?') && !/\/tracks/.test(SV.PLAYER.listing('playlist', 'pl1')[1]) && SV.PLAYER.listing('album', 'al1')[1].startsWith('/albums/al1') && SV.PLAYER.listing('artist', 'x') === null, '');
  check('requests: play from a row sends the context and the place; Play alone sends the context', JSON.stringify(SV.PLAYER.playContext('playlist', 'pl1', 3)) === '["PUT","/me/player/play",{"context_uri":"spotify:playlist:pl1","offset":{"position":3}}]' && JSON.stringify(SV.PLAYER.playContext('album', 'al1')[2]) === '{"context_uri":"spotify:album:al1"}', '');

  // ---- the card (a mocked call) ----
  let t = 1e12;
  const calls = [];
  const world = { plays: 204, listing: { ok: true, status: 200, body: PLAYLIST } };
  const call = async (method, p, body) => {
    calls.push([method, p, body]);
    if (p.startsWith('/playlists/')) return world.listing;
    if (p.startsWith('/albums/')) return { ok: true, status: 200, body: ALBUM };
    if (p === '/me/player/play') return world.plays === 204 ? { ok: true, status: 204, body: '' } : { ok: false, status: 404, body: JSON.stringify({ error: { reason: 'NO_ACTIVE_DEVICE' } }) };
    if (p === '/me/player/devices') return { ok: true, status: 200, body: JSON.stringify({ devices: [{ id: 'pc1', type: 'Computer' }] }) };
    if (p === '/me/player') world.plays = 204; // (the transfer wakes the device)
    return { ok: true, status: 204, body: '' };
  };
  const ui = {};
  const cached = { state: 'paused', itemId: 's2', context: { kind: 'playlist', id: 'pl1' } };
  const ctx = () => ({ ui, cached, now: () => t, image: async () => '' });
  check('card: opening a playlist reads its songs once, and not again for two minutes unless forced', await (async () => {
    const a = await SAC.act(call, { do: 'eopen', kind: 'playlist', item: 'pl1' }, ctx());
    const b = await SAC.act(call, { do: 'eopen', kind: 'playlist', item: 'pl1' }, ctx());
    t += 121e3;
    await SAC.act(call, { do: 'eopen', kind: 'playlist', item: 'pl1' }, ctx());
    await SAC.act(call, { do: 'eopen', kind: 'playlist', item: 'pl1', force: true }, ctx());
    return a.local && b.local && calls.filter((c) => c[1].startsWith('/playlists/')).length === 3;
  })(), JSON.stringify(calls.map((c) => c[1])));
  const extra = await SAC.extras(call, ctx(), { itemId: 's2', state: 'paused', context: { kind: 'playlist', id: 'pl1' }, shuffle: false, repeat: 'off', volume: 0.5 });
  check('card: the songs reach the card with the one playing marked, and the playlist tabs are offered', extra.lists['playlist:pl1'].items.length === 3 && extra.lists['playlist:pl1'].current === 1 && extra.can.playlists === true, JSON.stringify(extra.lists));
  check('card: a list is not marked as playing when something else is', (await SAC.extras(call, ctx(), { itemId: 's2', state: 'paused', context: { kind: 'album', id: 'al1' }, shuffle: false, repeat: 'off', volume: 0.5 })).lists['playlist:pl1'].current === -1, '');
  calls.length = 0;
  await SAC.act(call, { do: 'pplay', kind: 'playlist', item: 'pl1', arg: '3', with: 's2' }, ctx());
  check('card: a row plays the playlist from that row (its place as Spotify counts it)', JSON.stringify(calls) === '[["PUT","/me/player/play",{"context_uri":"spotify:playlist:pl1","offset":{"position":3}}]]', JSON.stringify(calls));
  calls.length = 0;
  await SAC.act(call, { do: 'pplay', kind: 'playlist', item: 'pl1', shuffle: true }, ctx());
  check('card: Shuffle turns shuffle on, then starts the playlist', calls.map((c) => c[1]).join() === '/me/player/shuffle?state=true,/me/player/play' && cached.shuffle === true, '');
  check('card: a row that is not the one the card showed (the list moved on) is refused', await SAC.act(call, { do: 'pplay', kind: 'playlist', item: 'pl1', arg: '3', with: 's1' }, ctx()).then(() => false, (e) => /changed/.test(e.message)) && await SAC.act(call, { do: 'pplay', kind: 'playlist', item: 'nolist', arg: '0' }, ctx()).then(() => false, (e) => /changed/.test(e.message)), '');
  calls.length = 0;
  world.plays = 404;
  await SAC.act(call, { do: 'pplay', kind: 'playlist', item: 'pl1' }, ctx());
  check('card: Play with no active device wakes the computer and plays there', calls.map((c) => c[1]).join() === '/me/player/play,/me/player/devices,/me/player,/me/player/play', calls.map((c) => c[1]).join());
  world.plays = 204;
  world.listing = { ok: false, status: 500, body: '' };
  await SAC.act(call, { do: 'eopen', kind: 'playlist', item: 'pl1', force: true }, ctx());
  check('card: a list that failed to load says so (and the card offers Try again), never an empty list', ui.lists['playlist:pl1'].ok === false && ui.lists['playlist:pl1'].why === 'page', '');
  world.listing = { ok: false, status: 403, body: JSON.stringify({ error: { status: 403, message: 'Insufficient client scope' } }) };
  await SAC.act(call, { do: 'eopen', kind: 'playlist', item: 'pl1', force: true }, ctx());
  check('card: a missing permission is named, and the card asks to reconnect', ui.lists['playlist:pl1'].why === 'scope' && (await SAC.extras(call, ctx(), { itemId: '', state: 'idle', context: null, shuffle: null, repeat: null, volume: null })).needsScopes === true, '');
  check('card: an artist or a made-up kind is not ours', (await SAC.act(call, { do: 'eopen', kind: 'artist', item: 'a1' }, ctx())) === false && (await SAC.act(call, { do: 'pplay', kind: 'song', item: 'a1' }, ctx())) === false, '');
  for (let i = 0; i < 9; i++) await SAC.act(call, { do: 'eopen', kind: 'album', item: `al${i}`, force: true }, ctx());
  check('card: only a few lists are kept (the oldest go)', Object.keys(ui.lists).length <= 6, String(Object.keys(ui.lists).length));

  // ---- the tabs: order and sizes ----
  check('tabs: the playlist tabs are a feature of the large size, of the Web API card only', MCF.featuresAt('large').includes('playlists') && !MCF.featuresAt('medium').includes('playlists') && MCF.shown('large', 'spotify-api', { playlists: true }).includes('playlists') && !MCF.shown('large', 'spotify-lumen', { playlists: true }).includes('playlists') && !MCF.shown('large', 'applemusic', { playlists: true }).includes('playlists') && !MCF.shown('small', 'spotify-api', { playlists: true }).includes('playlists') && !MCF.shown('large', 'spotify-api', { playlists: false }).includes('playlists'), '');
  const music = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'newtab-music.js'), 'utf8');
  check('tabs: pinned tabs come after the built-in ones, in pin order, up to four', /return cap\('playlists'\) \? \[\.\.\.built, \.\.\.pinsOf\(\)\.map\(\(_, i\) => PIN_SLOTS\[i\]\)\] : built/.test(music) && /PIN_SLOTS = \['pin0', 'pin1', 'pin2', 'pin3'\]/.test(music) && /\.slice\(0, 4\)/.test(music), '');
  check('tabs: a pinned tab shows a short name with the full name as its tooltip, and the arrow keys and Delete work on it', /b\.title = label/.test(music) && /e\.key === 'Delete' && ui\.tab\.startsWith\('pin'\)/.test(music) && /\.mc-tab-pin \{[^}]*text-overflow: ellipsis/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'newtab.html'), 'utf8')), '');
  check('tabs: a playlist row in the Library opens inside the card, with a Back button, Play and Shuffle', /onClick: \(\) => \{ ui\.openList = /.test(music) && /'‹ Back'/.test(music) && /\['Play', false\], \['Shuffle', true\]/.test(music), '');

  // ---- the connector: the page's actions, pins saved in the widget ----
  const log = [];
  let settings = { homeWidgets: [{ id: 'wapi00001', type: 'spotify', mode: 'api', clientId: CLIENT, art: false, x: 0, y: 0, w: 6, h: 5 }] };
  const secrets = new Map([['spotify', 'REFRESH']]);
  const w = createWidgets({ readSettings: () => settings, writeSettings: (s) => { settings = s; }, fetch: fakeSpotify(log), getSecret: (n) => secrets.get(n) || null, setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}) });
  const af = (q) => w.actionFrom(`chrome://newtab/?widget=wapi00001&${q}`);
  check('actions: a playlist or album (kind and a safe id) can be opened, pinned, unpinned and played; anything else is refused', af('do=pin&kind=playlist&arg=pl1').kind === 'playlist' && af('do=unpin&kind=album&arg=al1').do === 'unpin' && af('do=eopen&kind=playlist&arg=pl1&force=1').force === true && af('do=pin&kind=song&arg=pl1').invalid === true && af('do=pin&kind=playlist&arg=../x').invalid === true && af('do=eopen&kind=playlist').invalid === true, '');
  const pp = af('do=pplay&kind=playlist&arg=pl1&pos=12&with=s2&shuffle=1');
  check('actions: play carries the place (digits only), the song it was and Shuffle', pp.arg === '12' && pp.with === 's2' && pp.shuffle === true && af('do=pplay&kind=playlist&arg=pl1&pos=x').invalid === true && af('do=pplay&kind=playlist&arg=pl1').arg === undefined, JSON.stringify(pp));
  await w.refresh(w.list()[0], { force: true });
  await w.act(af('do=pin&kind=playlist&arg=pl1'));
  check('connector: pinning before the library was read has no name to keep, so nothing is saved', !settings.homeWidgets[0].pins, JSON.stringify(settings.homeWidgets[0].pins));
  await w.act(af('do=elists')); // (the library: the playlists are read, and with them their names)
  await w.act(af('do=etab&arg=library'));
  await w.act(af('do=pin&kind=playlist&arg=pl1'));
  check('connector: a pin is saved in the widget’s settings with the name Spotify gave it (not one the page sent)', JSON.stringify(settings.homeWidgets[0].pins) === '[{"kind":"playlist","id":"pl1","title":"Road trip"}]', JSON.stringify(settings.homeWidgets[0].pins));
  check('connector: the page is handed the pins', JSON.stringify(w.forPage()[0].data.pins) === '[{"kind":"playlist","id":"pl1","title":"Road trip"}]', JSON.stringify(w.forPage()[0].data));
  await sleep(10);
  // an edit in Settings (a form without pins) keeps them
  await w.save({ type: 'spotify', mode: 'api', clientId: CLIENT, art: false }, 'wapi00001');
  check('connector: saving the card in Settings keeps its pins', settings.homeWidgets[0].pins?.length === 1, JSON.stringify(settings.homeWidgets[0]));
  await sleep(50);
  await w.refresh(w.list()[0], { force: true });
  await w.act(af('do=eopen&kind=playlist&arg=pl1&force=1'));
  check('connector: the pinned playlist’s songs are read from /playlists/{id}/items and reach the card', log.some((l) => l.path.startsWith('/v1/playlists/pl1/items')) && w.forPage()[0].data.lists['playlist:pl1'].items.length === 3, '');
  await w.act(af('do=pplay&kind=playlist&arg=pl1&pos=3&with=s2'));
  const play = log.filter((l) => l.method === 'PUT' && l.path === '/v1/me/player/play').pop();
  check('connector: a row plays with PUT /me/player/play, context_uri and offset', play && play.body === '{"context_uri":"spotify:playlist:pl1","offset":{"position":3}}', JSON.stringify(play));
  await w.act(af('do=unpin&kind=playlist&arg=pl1'));
  check('connector: unpinning takes it out of the settings', !settings.homeWidgets[0].pins || settings.homeWidgets[0].pins.length === 0, JSON.stringify(settings.homeWidgets[0].pins));
  settings.homeWidgets[0].pins = full;
  let refused = '';
  await w.act(af('do=pin&kind=playlist&arg=pl1'));
  refused = w.cache.get('wapi00001').error || '';
  check('connector: a fifth pin is refused with a notice, and the four stay', /Up to 4/.test(refused) && settings.homeWidgets[0].pins.length === 4, refused);
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } else console.log(`PASS ${name}`); })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
