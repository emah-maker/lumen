// The music card's bigger sizes, without Electron, Spotify, Apple or the network:
//   - size -> features (small / medium / large / extra large), the per-engine capability table and which controls are hidden, and that the page's CSS
//     thresholds are the ones the table says (features/music-card-features.js, renderer/newtab.html);
//   - the card is updated in place on state ticks and data changes, and only built again when its shell changes (features/widget-card-key.js);
//   - Spotify's Web API mode against a fake API: the player's switches, the heart (and the scopes it needs, with a reconnect prompt only when one is
//     missing), the queue, recent plays and playlists, devices and transfer, search, play an item / from a row / from the queue, add to the queue;
//   - the engines' commands (Spotify "Play as Lumen" and Apple Music): like, shuffle, repeat, volume, tabs, rows, with a fake page;
//   - Apple's page script against a mocked MusicKit: shuffleMode, repeatMode, volume, ratings (love), the queue, lyrics (subscribers).
// (The saved open.spotify.com pages are test/spotify-dom-units.js; the real card in a window is test/music-card-ui.js.)
// Runs on its own (npm run test:units picks up test/*-units.js).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const MCF = require('../src/features/music-card-features');
const CK = require('../src/features/widget-card-key');
const SV = require('../src/features/spotify-view');
const SAC = require('../src/features/spotify-api-card');
const SPB = require('../src/features/spotify-bridge');
const AMB = require('../src/features/apple-music-bridge');
const { createWidgets } = require('../src/features/widgets');
const { createEngine: createSpotifyEngine } = require('../src/features/spotify-engine');
const { createEngine: createAppleEngine } = require('../src/features/apple-music-engine');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLIENT = '0123456789abcdef0123456789abcdef';

// ---------------------------------------------------------------------------------------------------------------------------------------------
function featureChecks(check) {
  const bounds = [[0, 0, 'small'], [299, 400, 'small'], [300, 199, 'small'], [300, 200, 'medium'], [379, 299, 'medium'], [380, 299, 'medium'], [380, 300, 'large'], [599, 399, 'large'], [600, 399, 'large'], [600, 400, 'xl'], [900, 500, 'xl'], [NaN, 300, 'small'], [-5, -5, 'small'], [undefined, undefined, 'small']];
  check('features: a card\'s content box maps to small / medium / large / xl at the thresholds (both width and height must hold)', bounds.every(([w, h, t]) => MCF.tierOf(w, h) === t), JSON.stringify(bounds.filter(([w, h, t]) => MCF.tierOf(w, h) !== t)));
  check('features: the default 4x3 card (about 400 x 166 inside its padding) is small; 4x4 medium; 6x5 large; 8x7 extra large', MCF.tierOf(400, 166) === 'small' && MCF.tierOf(400, 238) === 'medium' && MCF.tierOf(626, 310) === 'large' && MCF.tierOf(852, 454) === 'xl', '');
  const at = (t) => MCF.featuresAt(t);
  check('features: small is art, title, play / pause, next and a progress bar', JSON.stringify(at('small')) === JSON.stringify(['art', 'title', 'playPause', 'next', 'progress']), JSON.stringify(at('small')));
  check('features: medium adds previous, a seek bar with times, like, shuffle, repeat and volume', JSON.stringify(at('medium').slice(5)) === JSON.stringify(['prev', 'seek', 'like', 'shuffle', 'repeat', 'volume']), JSON.stringify(at('medium')));
  check('features: large adds the tabs: search, queue, library, devices', JSON.stringify(at('large').slice(11)) === JSON.stringify(['tabs', 'search', 'queue', 'library', 'devices']), JSON.stringify(at('large')));
  check('features: extra large adds the album or playlist (a track list) and lyrics', JSON.stringify(at('xl').slice(16)) === JSON.stringify(['tracks', 'lyrics']) && at('xl').length === 18, JSON.stringify(at('xl')));
  check('features: every size has everything the smaller ones have; an unknown tier is small', ['small', 'medium', 'large'].every((t, i) => at(t).every((f) => at(['medium', 'large', 'xl'][i]).includes(f))) && JSON.stringify(at('huge')) === JSON.stringify(at('small')), '');

  // the per-engine table
  const sh = (tier, engine, can) => MCF.shown(tier, engine, can);
  check('capabilities: the engine of a card: Spotify status = Play as Lumen, api = the Web API, Apple Music status; web modes have none', MCF.engineOf('spotify', 'status') === 'spotify-lumen' && MCF.engineOf('spotify', 'api') === 'spotify-api' && MCF.engineOf('applemusic', 'status') === 'applemusic' && MCF.engineOf('applemusic', 'web') === null && MCF.engineOf('spotify', 'web') === null && MCF.engineOf('weather', 'status') === null, '');
  check('capabilities: Spotify\'s Web API has no lyrics (it offers none) but picks the output device; Play as Lumen only names this browser; Apple Music has no device list', !MCF.caps('spotify-api').lyrics && MCF.caps('spotify-api').devices === 'pick' && MCF.caps('spotify-lumen').devices === 'browser' && MCF.caps('applemusic').devices === false && MCF.caps('spotify-lumen').lyrics === true && MCF.caps('applemusic').lyrics === true, '');
  check('capabilities: at xl the API card draws every feature but lyrics; Apple every feature but devices', JSON.stringify(MCF.featuresAt('xl').filter((f) => !sh('xl', 'spotify-api').includes(f))) === '["lyrics"]' && JSON.stringify(MCF.featuresAt('xl').filter((f) => !sh('xl', 'applemusic').includes(f))) === '["devices"]', JSON.stringify([sh('xl', 'spotify-api'), sh('xl', 'applemusic')]));
  check('capabilities: a live `can` that is exactly false hides a control, however big the card (like, volume, queue)', !sh('xl', 'spotify-lumen', { like: false }).includes('like') && !sh('medium', 'applemusic', { volume: false }).includes('volume') && !sh('large', 'spotify-api', { queue: false }).includes('queue') && sh('large', 'spotify-api', { queue: true }).includes('queue'), '');
  check('capabilities: a small card never shows medium or large controls, whatever the engine can do', JSON.stringify(sh('small', 'applemusic', { like: true, shuffle: true })) === JSON.stringify(MCF.featuresAt('small')), '');
  check('capabilities: an unknown engine shows nothing', JSON.stringify(sh('xl', 'nope')) === '[]' && JSON.stringify(sh('xl', '__proto__')) === '[]' && Object.keys(MCF.caps('constructor')).length === 0, '');
  check('capabilities: the Spotify bridge\'s and the Apple bridge\'s own CAPS agree with the table (queue, tracks, lyrics, like, shuffle, repeat, volume)', ['queue', 'tracks', 'lyrics', 'like', 'shuffle', 'repeat', 'volume'].every((k) => Boolean(SPB.CAPS[k]) === Boolean(MCF.caps('spotify-lumen')[k]) && Boolean(AMB.CAPS[k]) === Boolean(MCF.caps('applemusic')[k])) && SPB.CAPS.devices === 'browser' && AMB.CAPS.devices === false, '');
  check('repeat goes off -> all -> one -> off', MCF.nextRepeat('off') === 'all' && MCF.nextRepeat('all') === 'one' && MCF.nextRepeat('one') === 'off' && MCF.nextRepeat('whatever') === 'off', '');

  // the page's CSS and scripts
  const root = path.join(__dirname, '..', 'src', 'renderer');
  const html = fs.readFileSync(path.join(root, 'newtab.html'), 'utf8');
  const widgetsJs = fs.readFileSync(path.join(root, 'newtab-widgets.js'), 'utf8');
  const musicJs = fs.readFileSync(path.join(root, 'newtab-music.js'), 'utf8');
  for (const t of ['medium', 'large', 'xl']) {
    const { w, h } = MCF.TIER_MIN[t];
    check(`page: the ${t} container query is ${w} x ${h}, the numbers the features table says`, html.includes(`@container card (min-width: ${w}px) and (min-height: ${h}px)`), '');
  }
  check('page: the card sizes are container queries on the card (no JS decides what is drawn at a size)', /container-type: size; container-name: card;/.test(html), '');
  check('page: the features script loads before the music card script, which loads after the widgets script whose helpers it uses', html.indexOf('../features/music-card-features.js') > 0 && html.indexOf('../features/music-card-features.js') < html.indexOf('<script src="newtab-music.js">') && html.indexOf('<script src="newtab-widgets.js">') < html.indexOf('<script src="newtab-music.js">'), '');
  check('page: a music card whose data moved on is updated in place, the card kept (renderWidgets)', /updatesInPlace\(kept\.key, key\)/.test(widgetsJs) && /kept\.el\._music\.update\(/.test(widgetsJs), '');
  check('page: the music card builds its parts once: update() never replaces the card or its header (only the lists inside tabs, notes and the idle section)', !/card\.el\.replaceWith|card\.body\.replaceChildren|card\.head\.replaceChildren|innerHTML = ''/.test(musicJs.replace(/\/\/.*$/gm, '')), '');
  check('page: lists are redrawn only when what they show changed (a signature per list)', /function fill\(box, signature, draw\)/.test(musicJs) && /if \(box\._sig === signature\) return false;/.test(musicJs), '');
  check('page: every control is a button or input with a label (aria-label) and the card names its keys', /aria-keyshortcuts/.test(musicJs) && (musicJs.match(/setAttribute\('aria-label'/g) || []).length >= 10, '');
  check('page: nothing from main is set as markup (textContent and attributes only; the only innerHTML is our own constant icons)', (musicJs.match(/innerHTML = [^\n]*/g) || []).every((m) => /^innerHTML = (ICONS\.\w+;|svg;|state === 'playing' \? ICONS\.pause : ICONS\.play;|rep === 'one' \? ICONS\.repeatOne : ICONS\.repeat;)/.test(m)), (musicJs.match(/innerHTML = [^\n]*/g) || []).join(' | ').slice(0, 300));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
function keyChecks(check) {
  const at = 1e12;
  const card = (over = {}, data = {}) => ({ id: 'w1', type: 'spotify', title: 'Spotify', span: 4, height: 3, layout: { x: 0, y: 0, w: 4, h: 3 }, updated: at, data: { mode: 'status', state: 'playing', title: 'Night Shift', artist: 'Ann', album: 'Quiet Hours', progressMs: 30000, durationMs: 200000, at, source: 'engine', liked: false, shuffle: false, repeat: 'off', volume: 0.5, ...data }, ...over });
  const k = (w) => CK.cardKey(w);
  check('card key: a playing card is in-place; the web player, an unavailable engine, other kinds of cards and a card with no data are not', k(card()).inPlace === true && k(card({}, { mode: 'web' })).inPlace === false && k(card({}, { state: 'unavailable' })).inPlace === false && k({ id: 'w2', type: 'weather', data: { at: 1 } }).inPlace === false && k({ id: 'w3', type: 'spotify', data: null }).inPlace === false && CK.updatesInPlace('', k(card())) === false && CK.updatesInPlace(null, null) === false, '');
  check('card key: a state tick (playhead moved on with the stamp) is the same card', CK.sameCard(k(card()), k(card({ updated: at + 4000 }, { at: at + 4000, progressMs: 34000 }))), '');
  const changes = { song: { title: 'Other' }, like: { liked: true }, shuffle: { shuffle: true }, repeat: { repeat: 'one' }, volume: { volume: 0.9 }, queue: { queue: { items: [{ id: 'a', title: 'A' }] } }, results: { results: [{ id: 'a', title: 'A' }] }, tracks: { tracks: { items: [], current: 2 } }, lyrics: { lyrics: { lines: ['x'] } }, devices: { devices: [{ id: 'd', name: 'D' }] }, pause: { state: 'paused' }, notice: { notice: 'Added to the queue.' } };
  check('card key: every one of those (song, heart, shuffle, repeat, volume, queue, results, track list, lyrics, devices, pause, a notice) is a change to draw, and each is applied to the SAME card in place', Object.entries(changes).every(([, d]) => !CK.sameCard(k(card()), k(card({}, d))) && CK.updatesInPlace(k(card()), k(card({}, d)))), JSON.stringify(Object.entries(changes).filter(([, d]) => CK.sameCard(k(card()), k(card({}, d))) || !CK.updatesInPlace(k(card()), k(card({}, d)))).map(([n]) => n)));
  check('card key: a new size or place is never a reason to build the card again', CK.updatesInPlace(k(card()), k(card({ span: 6, layout: { x: 3, y: 1, w: 6, h: 5 } }))) && CK.sameCard(k(card()), k(card({ span: 6, layout: { x: 3, y: 1, w: 6, h: 5 } }))), '');
  check('card key: a different mode (engine vs web player vs API), widget or title is a different shell: built again', !CK.updatesInPlace(k(card()), k(card({}, { mode: 'web' }))) && !CK.updatesInPlace(k(card()), k(card({}, { mode: undefined }))) && !CK.updatesInPlace(k(card()), k(card({ id: 'w9' }))) && !CK.updatesInPlace(k(card()), k(card({ title: 'Music' }))) && !CK.updatesInPlace(k(card()), k(card({ type: 'applemusic' }))), '');
  check('card key: Spotify\'s API mode (no mode in its data) is in place with itself', CK.updatesInPlace(k(card({}, { mode: undefined })), k(card({}, { mode: undefined, title: 'Other', shuffle: true }))), '');
  const slow = k(card());
  check('card key: a long run of ticks never asks for a new card (30 minutes of one song, every 4 s)', Array.from({ length: 450 }, (_, i) => k(card({ updated: at + i * 4000 }, { at: at + i * 4000, progressMs: 30000 + i * 4000 }))).every((n) => CK.sameCard(slow, n)), '');
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A fake Spotify Web API with a player, a queue, a library and devices; every call is logged.
function fakeSpotify(world) {
  const log = [];
  const reply = (status, body) => new Response(status === 204 ? null : (typeof body === 'string' ? body : JSON.stringify(body ?? {})), { status });
  const track = (id, name, artist = 'Ann') => ({ id, type: 'track', name, duration_ms: 200000, artists: [{ name: artist }], album: { name: 'Quiet Hours', images: [{ url: 'https://i.scdn.co/image/big', width: 640 }, { url: 'https://i.scdn.co/image/small', width: 64 }] } });
  world.track ||= track('TRK1', 'Night Shift');
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const entry = { method: opts.method || 'GET', path: u.pathname + u.search, body: typeof opts.body === 'string' ? opts.body : '' };
    log.push(entry);
    if (u.host === 'accounts.spotify.com') return reply(200, { access_token: 'ACCESS', token_type: 'Bearer', expires_in: 3600 });
    if (u.host !== 'api.spotify.com') return reply(404);
    const p = u.pathname.replace(/^\/v1/, '');
    const m = entry.method;
    if (p === '/me/player' && m === 'GET') return world.idle ? reply(204) : reply(200, { is_playing: true, progress_ms: 30000, shuffle_state: world.shuffle ?? true, repeat_state: world.repeat || 'off', currently_playing_type: 'track', device: { id: 'dev1', name: 'Kitchen', volume_percent: 60, supports_volume: world.noVolume !== true, is_active: true }, context: world.context === undefined ? { uri: 'spotify:album:ALB1' } : world.context, item: world.track });
    if (p === '/me/player' && m === 'PUT') { world.transferred = JSON.parse(entry.body); return reply(204); }
    if (p === '/me/tracks/contains') return world.scope403 ? reply(403, { error: { status: 403, message: 'Insufficient client scope' } }) : reply(200, [world.liked === true]);
    if (p === '/me/tracks' && (m === 'PUT' || m === 'DELETE')) { if (world.scope403) return reply(403, { error: { status: 403, message: 'Insufficient client scope' } }); world.liked = m === 'PUT'; return reply(200); }
    if (p === '/me/player/queue' && m === 'GET') return reply(200, { currently_playing: world.track, queue: [track('Q1', 'Glass Harbor'), track('Q2', 'Paper Moons', 'The Quiet Hours'), track('Q3', 'Slow Burn'), { id: 'bad id!', type: 'track', name: 'Evil' }, { id: 'EP1', type: 'episode', name: 'A podcast' }] });
    if (p === '/me/player/queue' && m === 'POST') return world.noDevice ? reply(404, { error: { status: 404, reason: 'NO_ACTIVE_DEVICE' } }) : reply(204);
    if (p === '/me/playlists') return world.scope403 ? reply(403, { error: { status: 403, message: 'Insufficient client scope' } }) : reply(200, { items: [{ id: 'PL1', type: 'playlist', name: 'Late night drive', owner: { display_name: 'You' }, images: [{ url: 'https://i.scdn.co/image/pl', width: 300 }] }, { id: 'PL2', type: 'playlist', name: 'Focus', owner: { display_name: 'You' }, images: [] }] });
    if (p === '/me/player/recently-played') return world.scope403 ? reply(403, { error: { status: 403, message: 'Insufficient client scope' } }) : reply(200, { items: [{ track: track('R1', 'Afterglow') }, { track: track('R2', 'Low Tide') }, { track: track('R1', 'Afterglow') }] });
    if (p === '/me/player/devices') return reply(200, { devices: [{ id: 'dev1', name: 'Kitchen', type: 'Speaker', is_active: true }, { id: 'dev2', name: 'Work laptop', type: 'Computer', is_active: false }, { id: 'dev3', name: 'TV', type: 'TV', is_restricted: true }] });
    if (p === '/search') return reply(200, { tracks: { items: [track('S1', 'Night Shift'), track('S2', 'Nightcall', 'Kavinsky')] }, albums: { items: [{ id: 'AL1', name: 'Quiet Hours', artists: [{ name: 'Ann' }], release_date: '2024-05-01', images: [{ url: 'https://i.scdn.co/image/al', width: 300 }] }] }, artists: { items: [{ id: 'AR1', name: 'Ann', images: [] }] }, playlists: { items: [{ id: 'PL9', name: 'Night drive', owner: { display_name: 'Spotify' }, images: [] }, null] } });
    if (p === '/albums/ALB1') return reply(200, { name: 'Quiet Hours', images: [{ url: 'https://i.scdn.co/image/al', width: 300 }], tracks: { items: [track('TRK1', 'Night Shift'), track('T2', 'Glass Harbor'), track('T3', 'Paper Moons')] } });
    if (p === '/playlists/PLX1') return reply(200, { name: 'Road trip', items: { items: [{ item: track('P1', 'One') }, { item: track('P2', 'Two') }] } });
    if (p === '/playlists/PLX2') return reply(200, { name: 'Older shape', tracks: { items: [{ track: track('P3', 'Three') }] } });
    if (/^\/me\/player\/(play|pause|next|previous|shuffle|repeat|volume|seek)$/.test(p)) { world.calls = (world.calls || 0) + 1; return reply(204); }
    return reply(404);
  };
  return { fetch, log };
}
const imageFetchOk = (fetch) => async (url, opts) => {
  const u = new URL(url);
  if (u.host === 'i.scdn.co') return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  return fetch(url, opts);
};

async function apiChecks(check) {
  const world = { liked: false };
  const api = fakeSpotify(world);
  const secrets = new Map([['spotify', 'REFRESH']]);
  const id = 'wapi00002';
  const updates = { n: 0 };
  const w = createWidgets({ readSettings: () => ({ homeWidgets: [{ id, type: 'spotify', mode: 'api', clientId: CLIENT, art: false, x: 0, y: 0, w: 4, h: 3 }] }), writeSettings: () => {}, fetch: imageFetchOk(api.fetch), getSecret: (n) => secrets.get(n) || null, setSecret: () => {}, onUpdate: () => { updates.n++; }, endpoints: () => ({}), rateMax: () => 1e6 });
  const data = () => w.cache.get(id).data;
  const since = (n) => api.log.slice(n).map((l) => `${l.method} ${l.path}`);
  const look = async () => { const entry = w.cache.get(id); if (entry) entry.at = 0; await w.refresh(w.list()[0], { force: true }); return data(); }; // (a card is looked at no more than every 4 s: not in a test)
  let d = await look();

  check('api card: a look at the player carries the switches: shuffle, repeat (context is "all"), volume of the active device, what it is playing from', d.shuffle === true && d.repeat === 'off' && d.volume === 0.6 && d.context && d.context.kind === 'album' && d.context.id === 'ALB1' && d.itemId === 'TRK1' && d.deviceId === 'dev1', JSON.stringify({ s: d.shuffle, r: d.repeat, v: d.volume, c: d.context, i: d.itemId }));
  check('api card: …the heart is asked once for the song (contains), and the card says what the API card can do: no lyrics, devices to pick', d.liked === false && since(0).filter((l) => l.includes('/me/tracks/contains')).length === 1 && d.can.like === true && d.can.shuffle && d.can.repeat && d.can.volume && d.can.lyrics === false && d.can.devices === 'pick' && d.can.playLater === true && d.can.playNext === false && d.needsScopes === false, JSON.stringify(d.can));
  await look();
  check('api card: the heart is not asked again while the song is the same', since(0).filter((l) => l.includes('/me/tracks/contains')).length === 1, since(0).join('\n'));
  world.repeat = 'context'; world.shuffle = false;
  d = await look();
  check('api card: repeat_state context reads as "all", track as "one"; shuffle off', d.repeat === 'all' && d.shuffle === false && (world.repeat = 'track', (await look()).repeat === 'one'), '');
  world.repeat = 'off'; world.shuffle = true;
  world.noVolume = true;
  d = await look();
  check('api card: a device that can\'t set its volume hides the volume control (can.volume false)', d.volume === null && d.can.volume === false, JSON.stringify([d.volume, d.can.volume]));
  world.noVolume = false;
  await look();

  let n = api.log.length;
  await w.act({ id, do: 'shuffle' });
  check('api act: shuffle flips it (it was on: state=false)', JSON.stringify(since(n)) === '["PUT /v1/me/player/shuffle?state=false"]' && data().shuffle === false, JSON.stringify(since(n)));
  n = api.log.length;
  await w.act({ id, do: 'shuffle', arg: '1' });
  check('api act: shuffle with an argument sets it (state=true)', JSON.stringify(since(n)) === '["PUT /v1/me/player/shuffle?state=true"]', JSON.stringify(since(n)));
  const repeats = [];
  for (const arg of [undefined, 'one', 'off']) { n = api.log.length; await w.act({ id, do: 'repeat', ...(arg ? { arg } : {}) }); repeats.push(since(n)[0]); }
  check('api act: repeat with no argument goes off -> all (context); "one" is track; "off" is off', JSON.stringify(repeats) === '["PUT /v1/me/player/repeat?state=context","PUT /v1/me/player/repeat?state=track","PUT /v1/me/player/repeat?state=off"]', JSON.stringify(repeats));
  n = api.log.length;
  await w.act({ id, do: 'volume', arg: '35' });
  check('api act: volume sets the percent', JSON.stringify(since(n)) === '["PUT /v1/me/player/volume?volume_percent=35"]' && data().volume === 0.35, JSON.stringify(since(n)));
  n = api.log.length;
  await w.act({ id, do: 'volume', arg: '250' });
  check('api act: a volume over 100 is refused by the address check (and clamped if it ever got here)', w.actionFrom('about:blank?widget=wapi00002&do=volume&arg=250').invalid === true && SV.PLAYER.volume(250)[1].endsWith('=100') && w.actionFrom('about:blank?widget=wapi00002&do=volume&arg=35').arg === '35', JSON.stringify(since(n)));
  n = api.log.length;
  await w.act({ id, do: 'seek', sec: 95 });
  check('api act: seek goes to the position in milliseconds and moves the card\'s playhead', JSON.stringify(since(n)) === '["PUT /v1/me/player/seek?position_ms=95000"]' && data().progressMs === 95000, JSON.stringify(since(n)));

  n = api.log.length;
  await w.act({ id, do: 'like' });
  check('api act: the heart saves the song (PUT /me/tracks) and says so; pressed again it removes it (DELETE)', JSON.stringify(since(n)) === '["PUT /v1/me/tracks?ids=TRK1"]' && data().liked === true && world.liked === true, JSON.stringify(since(n)));
  n = api.log.length;
  await w.act({ id, do: 'like' });
  check('api act: …the second press removes it', JSON.stringify(since(n)) === '["DELETE /v1/me/tracks?ids=TRK1"]' && data().liked === false && world.liked === false, JSON.stringify(since(n)));

  // tabs: asked, kept, merged into the card
  n = api.log.length;
  await w.act({ id, do: 'etab', arg: 'queue' });
  d = await look();
  check('api tabs: Up next asks for the queue once and the card carries it: songs only (an episode, a bad id are dropped), with a small picture', since(n).filter((l) => l.includes('/me/player/queue')).length === 1 && d.queue.items.length === 3 && d.queue.items[0].id === 'Q1' && d.queue.items[0].sub === 'Ann' && d.queue.items.every((i) => i.kind === 'song') && /^data:image\/jpeg/.test(d.queue.items[0].thumb) && d.queue.ok === true, JSON.stringify(d.queue).slice(0, 300));
  check('api tabs: the open tab\'s list is not asked again for a few seconds', (n = api.log.length, await w.act({ id, do: 'etab', arg: 'queue' }), since(n).filter((l) => l.includes('/me/player/queue')).length === 0), '');
  await w.act({ id, do: 'etab', arg: 'library' });
  d = await look();
  check('api tabs: Library carries recent plays (each song once) and the playlists', d.recent.length === 2 && d.recent[0].title === 'Afterglow' && d.playlists.length === 2 && d.playlists[0].title === 'Late night drive' && d.playlists[0].kind === 'playlist' && !('images' in d.recent[0]) && !('thumb' in d.recent[0]), JSON.stringify([d.recent, d.playlists]).slice(0, 300));
  await w.act({ id, do: 'etab', arg: 'devices' });
  d = await look();
  check('api tabs: Devices lists the account\'s devices, the playing one marked, restricted ones left out', JSON.stringify(d.devices.map((x) => [x.id, x.active])) === '[["dev1",true],["dev2",false]]' && d.devicesOk === true, JSON.stringify(d.devices));
  n = api.log.length;
  await w.act({ id, do: 'transfer', arg: 'dev2' });
  check('api act: picking a device moves playback to it, and keeps it playing (the card was playing)', JSON.stringify(world.transferred) === '{"device_ids":["dev2"],"play":true}' && since(n)[0] === 'PUT /v1/me/player', JSON.stringify(world.transferred));
  check('api act: a device id with odd characters is refused before anything is sent', w.actionFrom('about:blank?widget=wapi00002&do=transfer&arg=a%20b').invalid === true && w.actionFrom('about:blank?widget=wapi00002&do=transfer&arg=dev2').arg === 'dev2', '');
  await w.act({ id, do: 'etab', arg: 'tracks' });
  d = await look();
  check('api tabs: the album playing (from the player\'s context) lists its songs with the playing one marked', d.tracks.title === 'Quiet Hours' && d.tracks.items.length === 3 && d.tracks.current === 0 && d.tracks.ok === true, JSON.stringify(d.tracks).slice(0, 300));
  n = api.log.length;
  await w.act({ id, do: 'playfrom', arg: '2', item: 'T3' });
  check('api act: play from a row plays the album from that position (context_uri + offset)', since(n)[0] === 'PUT /v1/me/player/play' && JSON.stringify(JSON.parse(api.log[n].body)) === '{"context_uri":"spotify:album:ALB1","offset":{"position":2}}', JSON.stringify(api.log[n]));
  n = api.log.length;
  const wrong = await w.act({ id, do: 'playfrom', arg: '1', item: 'ZZZ' });
  check('api act: …but not when the song at that place is not the one the card showed', since(n).length === 0 && wrong === false && /list changed/.test(data().notice || ''), JSON.stringify([since(n), data().notice]));
  n = api.log.length;
  await w.act({ id, do: 'playqueue', arg: '1', item: 'Q2' });
  check('api act: play from the queue skips ahead (a Next for each song up to and including it)', since(n).filter((l) => l === 'POST /v1/me/player/next').length === 2, JSON.stringify(since(n)));
  n = api.log.length;
  await w.act({ id, do: 'playqueue', arg: '1', item: 'NOPE' });
  check('api act: …only if the row is still what the card showed', since(n).length === 0, JSON.stringify(since(n)));

  // search and play
  n = api.log.length;
  await w.act({ id, do: 'esearch', text: 'night' });
  d = await look();
  check('api act: search asks the API (songs, albums, artists, playlists) and the card carries grouped results; a null in a list is dropped', /GET \/v1\/search\?q=night&type=track,album,artist,playlist&limit=8/.test(since(n)[0]) && d.query === 'night' && d.results.map((r) => r.kind).join() === 'song,song,album,artist,playlist' && d.searchOk === true && d.results[2].sub === 'Ann · 2024', JSON.stringify(d.results.map((r) => [r.kind, r.title, r.sub])));
  n = api.log.length;
  await w.act({ id, do: 'esearch', text: '' });
  d = await look();
  check('api act: an empty search clears the results (nothing is asked)', since(n).filter((l) => l.includes('/search')).length === 0 && d.results.length === 0 && d.query === '', JSON.stringify(since(n)));
  n = api.log.length;
  await w.act({ id, do: 'playitem', kind: 'song', item: 'S2' });
  await w.act({ id, do: 'playitem', kind: 'album', item: 'AL1' });
  await w.act({ id, do: 'playitem', kind: 'playlist', item: 'PL9' });
  await w.act({ id, do: 'playitem', kind: 'artist', item: 'AR1' });
  const plays = api.log.slice(n).filter((l) => l.method === 'PUT').map((l) => l.body);
  check('api act: playing a song is its uri; an album, playlist or artist is its context_uri', JSON.stringify(plays) === JSON.stringify(['{"uris":["spotify:track:S2"]}', '{"context_uri":"spotify:album:AL1"}', '{"context_uri":"spotify:playlist:PL9"}', '{"context_uri":"spotify:artist:AR1"}']), JSON.stringify(plays));
  n = api.log.length;
  await w.act({ id, do: 'playlater', kind: 'song', item: 'S1' });
  check('api act: add to queue is POST /me/player/queue with the track uri', JSON.stringify(since(n)) === '["POST /v1/me/player/queue?uri=spotify%3Atrack%3AS1"]' && /Added to the queue/.test((w.cache.get(id).notice || {}).text || ''), JSON.stringify(since(n)));
  n = api.log.length;
  await w.act({ id, do: 'playlater', kind: 'album', item: 'AL1' });
  check('api act: an album can not be queued whole (only songs): said so, nothing sent', since(n).length === 0 && /Only songs/.test(data().notice || ''), JSON.stringify([since(n), data().notice]));
  world.noDevice = true;
  await w.act({ id, do: 'playlater', kind: 'song', item: 'S1' });
  check('api act: queueing with no active device says so', /No active Spotify device/.test(data().notice || ''), data().notice);
  world.noDevice = false;

  // the context of a playlist, both answer shapes
  world.context = { uri: 'spotify:playlist:PLX1' };
  await look();
  await w.act({ id, do: 'etab', arg: 'tracks' });
  check('api tabs: a playlist playing lists its songs (the list is `items` of `item`)', data().tracks.items.map((i) => i.id).join() === 'P1,P2' && data().tracks.title === 'Road trip', JSON.stringify(data().tracks));
  world.context = { uri: 'spotify:playlist:PLX2' };
  await w.refresh(w.list()[0], { force: true });
  await sleep(10);
  world.track = { ...world.track, id: 'TRK9', name: 'Another' };
  await look();
  check('api tabs: …and the older shape (`tracks` of `track`); a changed song with a changed context asks the open tab again by itself', data().tracks.items.map((i) => i.id).join() === 'P3' && data().tracks.title === 'Older shape', JSON.stringify(data().tracks));
  world.context = null;
  world.track = { ...world.track, id: 'TRK1', name: 'Night Shift' };

  // scopes: an account connected before the bigger sizes
  world.scope403 = true;
  await sleep(10);
  world.track = { ...world.track, id: 'TRK7', name: 'Seven' };
  d = await look();
  check('api scopes: a 403 "Insufficient client scope" on the heart hides the heart and says to reconnect (the playback buttons keep working)', d.needsScopes === true && d.can.like === false && d.can.shuffle === true && d.title === 'Seven', JSON.stringify([d.needsScopes, d.can]));
  await w.act({ id, do: 'like' });
  check('api scopes: pressing the heart anyway answers with the reconnect message (not a bare 403)', /Reconnect Spotify/.test(data().notice || ''), data().notice);
  await w.act({ id, do: 'etab', arg: 'library', force: true });
  d = await look();
  check('api scopes: the library with no scope is empty and the card offers to reconnect', d.recent.length === 0 && d.playlists.length === 0 && d.needsScopes === true, JSON.stringify([d.recent, d.playlists]));
  check('api scopes: the sign-in asks for the playback scopes and the library ones, and nothing broader (no streaming, no private profile)', SV.SCOPES.split(' ').length === 7 && ['user-read-playback-state', 'user-modify-playback-state', 'playlist-read-private', 'playlist-read-collaborative', 'user-read-recently-played', 'user-library-read', 'user-library-modify'].every((s) => SV.SCOPES.split(' ').includes(s)) && !/streaming|user-read-private|user-read-email|user-top-read/.test(SV.SCOPES), SV.SCOPES);
  check('api scopes: scopeError recognises only a 403 about scope', SV.scopeError(403, JSON.stringify({ error: { status: 403, message: 'Insufficient client scope' } })) && !SV.scopeError(403, JSON.stringify({ error: { reason: 'PREMIUM_REQUIRED', message: 'Player command failed: Premium required' } })) && !SV.scopeError(404, 'scope') && !SV.scopeError(401, 'Insufficient client scope'), '');
  world.scope403 = false;

  // premium and errors are in words
  const idleWorld = { idle: true };
  const api2 = fakeSpotify(idleWorld);
  const w2 = createWidgets({ readSettings: () => ({ homeWidgets: [{ id, type: 'spotify', mode: 'api', clientId: CLIENT, art: false, x: 0, y: 0, w: 4, h: 3 }] }), writeSettings: () => {}, fetch: api2.fetch, getSecret: () => 'REFRESH', setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}), rateMax: () => 1e6 });
  await w2.refresh(w2.list()[0]);
  const idle = w2.cache.get(id).data;
  check('api card: an idle account (nothing playing) still gets the card\'s lists and no heart, no switches to show', idle.state === 'idle' && idle.liked === null && idle.can.like === false && idle.can.shuffle === false && idle.can.search === true && Array.isArray(idle.queue.items), JSON.stringify(idle.can));

  // the pure helpers
  check('api helpers: lists are cut down: ids checked, text bounded, pictures from Spotify\'s own hosts only, the smallest sharp one first', (() => { const it = SV.listItem({ id: 'ABC123', type: 'track', name: `${'x'.repeat(300)}`, artists: [{ name: 'A' }, { name: 'B' }], duration_ms: 1000, album: { images: [{ url: 'https://evil.example/a.jpg', width: 64 }, { url: 'https://i.scdn.co/big', width: 640 }, { url: 'https://i.scdn.co/small', width: 64 }] } }); return it.title.length === 120 && it.sub === 'A, B' && it.ms === 1000 && it.images.join() === 'https://i.scdn.co/small,https://i.scdn.co/big' && SV.listItem({ id: '../x', type: 'track', name: 'n' }) === null && SV.listItem({ id: 'ok', type: 'track', name: '' }) === null && SV.listItem({ id: 'ok', type: 'show', name: 'n' }) === null && SV.listItem(null) === null; })(), '');
  check('api helpers: the context of an artist is its top songs; junk answers are empty, never a throw', SV.normalizeContext('artist', JSON.stringify({ tracks: [{ id: 'A1', type: 'track', name: 'Hit' }] })).items.length === 1 && ['', 'null', '[]', '{"a":', '5'].every((t) => SV.normalizeQueue(t).length === 0 && SV.normalizeDevices(t).length === 0 && SV.normalizeSearch(t).length === 0 && SV.normalizeContext('album', t).items.length === 0 && SV.parseSaved(t) === null), '');
  check('api helpers: every button\'s address is built from fixed paths and checked values (a term is escaped, a percent clamped)', SV.PLAYER.search('a&b=c d')[1] === '/search?q=a%26b%3Dc%20d&type=track,album,artist,playlist&limit=8' && SV.PLAYER.volume(250)[1].endsWith('=100') && SV.PLAYER.volume(-3)[1].endsWith('=0') && SV.PLAYER.repeat('bogus')[1].endsWith('=off') && SV.PLAYER.seek(-5)[1].endsWith('=0'), '');
  void SAC;
  void updates;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
function fakePlayer() {
  const p = {
    gen: 0, st: { state: 'ready', drm: 'ok' }, wc: null,
    ensure() { if (!p.wc) { p.wc = { sent: [], executeJavaScript(code) { const m = /detail: (".*") \}\)\)$/.exec(code); if (m) p.wc.sent.push(JSON.parse(JSON.parse(m[1]))); return Promise.resolve(); } }; p.gen++; } return {}; },
    webContents: () => p.wc, status: () => p.st, isSignedIn: () => true, generation: () => p.gen,
    destroy() { p.wc = null; p.gen++; }, showIn() {}, release() {}, reload() { p.gen++; },
  };
  return p;
}
const ART = 'https://is1-ssl.mzstatic.com/image/thumb/Music/x.jpg/{w}x{h}bb.jpg';
const spState = (o = {}) => JSON.stringify({ t: 'state', state: 3, pos: 12, dur: 200, device: '', player: true, signedOut: false, shuffle: false, repeat: 'off', volume: 0.5, liked: false, has: { like: true, shuffle: true, repeat: true, volume: true }, item: { title: 'Night Shift', artist: 'Ann', album: 'Quiet Hours', art: '', ms: 200000 }, ...o });
const amState = (o = {}) => JSON.stringify({ t: 'state', auth: true, state: 2, pos: 12, dur: 200, store: 'us', shuffle: false, repeat: 'off', volume: 0.5, liked: false, has: { like: true, shuffle: true, repeat: true, volume: true }, item: { id: '1440933651', type: 'song', title: 'Night Shift', artist: 'Ann', album: 'Quiet Hours', art: ART, ms: 200000 }, ...o });

async function engineChecks(check) {
  for (const svc of [{ name: 'spotify', create: createSpotifyEngine, state: spState, bridge: SPB }, { name: 'apple', create: createAppleEngine, state: amState, bridge: AMB }]) {
    let t = 1e12;
    const player = fakePlayer();
    const changes = { n: 0 };
    const e = svc.create({ player, now: () => t, fetchBytes: async () => null, hasCard: () => true, onChange: () => { changes.n++; }, setInterval: () => ({ unref() {} }), setTimeout: (f) => { const h = { f, unref() {} }; (e.timers ||= []).push(h); return h; } });
    const sent = () => (player.wc ? player.wc.sent : []);
    const not = (name) => sent().filter((c) => c.cmd !== 'list' || c.kind === name || name === undefined);
    const lastOf = (cmd) => sent().filter((c) => c.cmd === cmd).at(-1);
    await e.read();
    e.onMessage('{"t":"ready"}');
    e.onMessage(svc.state());
    const d0 = await e.read();
    check(`${svc.name} engine: the card is told what it can do now: the heart, shuffle, repeat and volume the page shows; queue, tracks, search`, d0.can.like && d0.can.shuffle && d0.can.repeat && d0.can.volume && d0.can.queue && d0.can.tracks && d0.can.search && d0.shuffle === false && d0.repeat === 'off' && d0.volume === 0.5 && d0.liked === false, JSON.stringify(d0.can));
    check(`${svc.name} engine: …and Play next only where the service has it (Apple), Add to queue where it has that`, d0.can.playNext === (svc.name === 'apple') && d0.can.playLater === true && d0.can.lyrics === true && d0.can.library === true, JSON.stringify(d0.can));

    // switches: optimistic, then the page's word
    check(`${svc.name} engine: the heart sends like on and the card shows it at once (before the page says so)`, e.command('like') === true && lastOf('like').on === true && (await e.read()).liked === true, JSON.stringify(lastOf('like')));
    e.onMessage(svc.state({ liked: true }));
    check(`${svc.name} engine: pressed again it sends like off`, e.command('like') === true && lastOf('like').on === false && (await e.read()).liked === false, '');
    check(`${svc.name} engine: shuffle flips (on, then off); an explicit value sets it`, e.command('shuffle') === true && lastOf('shuffle').on === true && (await e.read()).shuffle === true && e.command('shuffle', false) === true && lastOf('shuffle').on === false, '');
    const modes = [];
    for (let i = 0; i < 4; i++) { e.command('repeat'); modes.push(lastOf('repeat').mode); }
    check(`${svc.name} engine: repeat goes round off -> all -> one -> off (the card moves at once, so four presses read all, one, off, all)`, JSON.stringify(modes) === '["all","one","off","all"]', JSON.stringify(modes));
    check(`${svc.name} engine: an explicit repeat mode is sent; a bad one goes round instead of being sent as is`, e.command('repeat', 'one') === true && lastOf('repeat').mode === 'one' && e.command('repeat', 'rm -rf') === true && ['off', 'all', 'one'].includes(lastOf('repeat').mode), '');
    check(`${svc.name} engine: volume is 0..100 from the card, 0..1 to the page, clamped; a non-number is refused`, e.command('volume', 35) === true && lastOf('volume').level === 0.35 && e.command('volume', 250) === true && lastOf('volume').level === 1 && e.command('volume', -4) === true && lastOf('volume').level === 0 && e.command('volume', NaN) === false && e.command('volume', 'loud') === false, JSON.stringify(lastOf('volume')));
    check(`${svc.name} engine: an unknown command is refused`, e.command('format-disk') === false && e.command('') === false && e.command(undefined) === false, '');

    // hidden controls: the page does not show them
    e.onMessage(svc.state({ has: { like: false, shuffle: true, repeat: false, volume: false } }));
    const d1 = await e.read();
    check(`${svc.name} engine: a control the page does not show is not offered, and pressing it does nothing (the heart, repeat, volume)`, d1.can.like === false && d1.can.repeat === false && d1.can.volume === false && d1.can.shuffle === true && e.command('like') === false && e.command('repeat') === false && e.command('volume', 50) === false, JSON.stringify(d1.can));
    e.onMessage(svc.state());

    // tabs and rows
    const n0 = sent().length;
    check(`${svc.name} engine: opening the Up next tab asks the page for the queue, and says it is loading`, e.command('tab', 'queue') === true && lastOf('list') && sent().slice(n0).some((c) => c.cmd === 'list' && c.kind === 'queue') && (await e.read()).queue.pending === true, JSON.stringify(sent().slice(n0)));
    const qAsk = sent().slice(n0).find((c) => c.cmd === 'list' && c.kind === 'queue');
    e.onMessage(JSON.stringify({ t: 'list', kind: 'queue', rid: qAsk.rid + 99, ok: true, items: [] }));
    check(`${svc.name} engine: an answer to an older ask is ignored`, (await e.read()).queue.pending === true, '');
    const qItems = [{ id: 'AAAAAAAAAAAAAAAAAAAAA1', kind: 'song', title: 'Glass Harbor', sub: 'Ann', ms: 187000 }, { id: 'AAAAAAAAAAAAAAAAAAAAA2', kind: 'song', title: 'Paper Moons', sub: 'The Quiet Hours', ms: 241000 }];
    e.onMessage(JSON.stringify({ t: 'list', kind: 'queue', rid: qAsk.rid, ok: true, items: qItems.map((i) => ({ ...i, type: 'songs' })) }));
    const dq = await e.read();
    check(`${svc.name} engine: the queue reaches the card: titles, artists, lengths, no longer loading`, dq.queue.pending === false && dq.queue.ok === true && dq.queue.items.length === 2 && dq.queue.items[0].title === 'Glass Harbor' && dq.queue.items[1].ms === 241000, JSON.stringify(dq.queue));
    check(`${svc.name} engine: a row of the queue plays from there (its place and which song it was)`, e.command('playQueue', { index: 1, id: 'AAAAAAAAAAAAAAAAAAAAA2' }) === true && JSON.stringify(lastOf('playQueue')) === JSON.stringify({ cmd: 'playQueue', index: 1, id: 'AAAAAAAAAAAAAAAAAAAAA2' }), JSON.stringify(lastOf('playQueue')));
    check(`${svc.name} engine: a bad row (not a number, a bad id) is refused`, e.command('playQueue', { index: 'x' }) === false && e.command('playQueue', { index: 1.5 }) === false && e.command('playQueue') === false && e.command('playQueue', { index: 1, id: '../x' }) === false && lastOf('playQueue').id === 'AAAAAAAAAAAAAAAAAAAAA2', JSON.stringify(lastOf('playQueue')));
    e.onMessage(JSON.stringify({ t: 'list', kind: 'queue', rid: qAsk.rid, ok: true, items: qItems.map((i) => ({ ...i, type: 'songs' })) }));
    const nAsk = sent().length;
    e.command('tab', 'queue');
    check(`${svc.name} engine: the same tab asked again within seconds is not asked of the page again`, sent().length === nAsk, '');
    t += 10e3;
    e.command('tab', 'queue');
    check(`${svc.name} engine: …but is, later`, sent().length === nAsk + 1, '');

    // a song change refreshes the open tab (a moment later) and the lyrics
    const ask2 = lastOf('list');
    e.onMessage(JSON.stringify({ t: 'list', kind: 'queue', rid: ask2.rid, ok: true, items: [] }));
    const before = sent().length;
    e.onMessage(svc.state({ item: { id: '1440933652', type: 'song', title: 'Glass Harbor', artist: 'Ann', album: 'Quiet Hours', art: ART, ms: 187000 } }));
    check(`${svc.name} engine: the song changing re-asks the open queue after a short wait`, sent().length === before && e.timers.length > 0 && (e.timers.at(-1).f(), sent().length === before + 1 && lastOf('list').kind === 'queue'), JSON.stringify(sent().slice(before)));

    // tracks
    const nT = sent().length;
    e.command('tab', 'tracks');
    const tAsk = sent().slice(nT).find((c) => c.cmd === 'list' && c.kind === 'tracks');
    e.onMessage(JSON.stringify({ t: 'list', kind: 'tracks', rid: tAsk.rid, ok: true, title: 'Quiet Hours', current: 1, items: Array.from({ length: 12 }, (_, i) => ({ id: `T${i}`, type: 'songs', kind: 'song', title: i === 1 ? 'Glass Harbor' : `Song ${i}`, sub: 'Ann', ms: 1000 })) }));
    const dt = await e.read();
    check(`${svc.name} engine: the album or playlist playing reaches the card: its title, its rows, the playing one`, dt.tracks.title === 'Quiet Hours' && dt.tracks.items.length === 12 && dt.tracks.current === 1 && dt.tracks.ok === true, JSON.stringify(dt.tracks).slice(0, 200));
    check(`${svc.name} engine: play from a row sends its place and song`, e.command('playFrom', { index: 4, id: 'T4' }) === true && JSON.stringify(lastOf('playFrom')) === JSON.stringify({ cmd: 'playFrom', index: 4, id: 'T4' }), '');
    e.onMessage(svc.state({ item: { id: '1440933653', type: 'song', title: 'Song 7', artist: 'Ann', album: 'Quiet Hours', art: ART, ms: 187000 } }));
    check(`${svc.name} engine: a song that is in the track list moves the marker with no new ask`, (await e.read()).tracks.current === 7, String((await e.read()).tracks.current));
    // a failed list says so
    const nF = sent().length;
    t += 10e3;
    e.command('tab', 'queue');
    const fAsk = sent().slice(nF).find((c) => c.cmd === 'list' && c.kind === 'queue');
    e.onMessage(JSON.stringify({ t: 'list', kind: 'queue', rid: fAsk.rid, ok: false, why: 'signedOut', items: [] }));
    const df = await e.read();
    check(`${svc.name} engine: a queue the page could not read says why (the card shows the reason, with a way to try again)`, df.queue.ok === false && df.queue.pending === false && (svc.name === 'spotify' ? df.queue.why === 'signedOut' : df.queue.why === 'page'), JSON.stringify(df.queue));

    // lyrics
    const nL = sent().length;
    e.command('tab', 'lyrics');
    const lAsk = sent().slice(nL).find((c) => c.cmd === 'lyrics');
    check(`${svc.name} engine: the Lyrics tab asks the page for the lyrics of this song, and says it is loading`, lAsk && (await e.read()).lyrics.pending === true && (await e.read()).lyrics.forTitle === 'Song 7', JSON.stringify(sent().slice(nL)));
    e.onMessage(JSON.stringify({ t: 'lyrics', rid: lAsk.rid, ok: true, lines: ['one', 'two', '<b>three</b>'] }));
    const dl = await e.read();
    check(`${svc.name} engine: the lyrics reach the card as lines (text, never markup)`, dl.lyrics.ok === true && dl.lyrics.lines.length === 3 && dl.lyrics.lines[2] === '<b>three</b>' && dl.lyrics.pending === false, JSON.stringify(dl.lyrics));
    t += 10e3;
    e.command('tab', 'lyrics');
    const l2 = lastOf('lyrics');
    e.onMessage(JSON.stringify({ t: 'lyrics', rid: l2.rid, ok: false, why: 'signedOut', lines: [] }));
    check(`${svc.name} engine: lyrics that can't be had say why`, (await e.read()).lyrics.ok === false && (await e.read()).lyrics.why === 'signedOut', '');

    // library and devices
    check(`${svc.name} engine: the Library tab asks for the library lists`, (() => { const m = sent().length; e.command('tab', 'library'); return sent().slice(m).filter((c) => c.cmd === 'list').length >= 1; })(), '');
    const dd = await e.read();
    check(`${svc.name} engine: devices: "Play as Lumen" names this browser (nothing to pick), Apple Music has none`, svc.name === 'spotify' ? dd.devices.length === 1 && dd.devices[0].name === 'This browser' && dd.devices[0].active === true && dd.can.devices === 'browser' : dd.devices.length === 0 && dd.can.devices === false, JSON.stringify(dd.devices));
    e.onMessage(svc.state({ device: 'Kitchen speaker' }));
    if (svc.name === 'spotify') check('spotify engine: playing on another device (Spotify Connect) names it as the active one', (await e.read()).devices.some((x) => x.name === 'Kitchen speaker' && x.active) && (await e.read()).devices.some((x) => x.id === 'browser' && !x.active), JSON.stringify((await e.read()).devices));
    check(`${svc.name} engine: an unknown tab is refused`, e.command('tab', 'secrets') === false, '');

    // a tab asked while the page is still loading is asked when it is ready
    player.destroy();
    e.unload?.();
    await e.read();
    check(`${svc.name} engine: a tab opened while the page is loading says loading, and is asked once the page says ready`, e.command('tab', 'queue') === true && (await e.read()).queue.pending === true && (e.onMessage('{"t":"ready"}'), sent().some((c) => c.cmd === 'list' && c.kind === 'queue')), JSON.stringify(sent()));
    void not;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Apple's page script against a mocked MusicKit.
function applePage({ authorized = true } = {}) {
  const listeners = {};
  const out = [];
  const calls = [];
  const kitEvents = {};
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  const document = {
    addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
    dispatchEvent: (e) => { if (e.type === 'lumen-engine-out') out.push(JSON.parse(e.detail)); (listeners[e.type] || []).forEach((f) => f(e)); return true; },
  };
  const q = (n) => Array.from({ length: n }, (_, i) => ({ id: `${100 + i}`, type: i === 3 ? 'musicVideo' : 'song', title: `Song ${i}`, artistName: 'Ann', albumName: 'Quiet Hours', playbackDuration: 180000 + i, artworkURL: ART }));
  const answers = {};
  const kit = {
    isAuthorized: authorized, playbackState: 2, currentPlaybackTime: 5, currentPlaybackDuration: 180, storefrontId: 'us', shuffleMode: 0, repeatMode: 0, volume: 0.7,
    nowPlayingItem: { id: '101', type: 'song', title: 'Song 1', artistName: 'Ann', albumName: 'Quiet Hours', artworkURL: ART, playbackDuration: 180001, attributes: { playParams: { catalogId: '999', id: '101' } } },
    nowPlayingItemIndex: 1, queue: { items: q(8), position: 1 },
    addEventListener: (ev, f) => { (kitEvents[ev] ||= []).push(f); },
    play: () => { calls.push(['play']); return Promise.resolve(); }, pause: () => {}, skipToNextItem: () => Promise.resolve(), skipToPreviousItem: () => Promise.resolve(), seekToTime: () => Promise.resolve(), setQueue: () => Promise.resolve(), playNext: () => Promise.resolve(), playLater: () => Promise.resolve(),
    changeToMediaAtIndex: (i) => { calls.push(['changeToMediaAtIndex', i]); return Promise.resolve(); },
    api: { music: (p, params, opts) => { calls.push(['api', p, opts && opts.fetchOptions && opts.fetchOptions.method, opts && opts.fetchOptions && opts.fetchOptions.body]); const a = Object.entries(answers).find(([k]) => p.startsWith(k)); return a ? (a[1] instanceof Error ? Promise.reject(a[1]) : Promise.resolve(a[1])) : Promise.resolve({ data: { data: [] } }); } },
  };
  const intervals = [];
  const ctx = vm.createContext({ document, CustomEvent, JSON, String, Boolean, Date, Array, isFinite, window: { MusicKit: { getInstance: () => kit } }, setInterval: (f) => { intervals.push(f); return intervals.length; }, clearInterval: () => {} });
  vm.runInContext(AMB.BRIDGE_SOURCE, ctx);
  intervals.forEach((f) => f());
  const send = (obj) => document.dispatchEvent(new CustomEvent('lumen-engine-in', { detail: JSON.stringify(obj) }));
  return { kit, out, calls, send, answers, state: () => out.filter((m) => m.t === 'state').at(-1), lists: () => out.filter((m) => m.t === 'list'), fire: (ev) => (kitEvents[ev] || []).forEach((f) => f({})), kitEvents };
}
const flush = () => new Promise((r) => setImmediate(r));

async function appleChecks(check) {
  let p = applePage();
  await flush();
  const s = AMB.parseMessage(JSON.stringify(p.state()));
  check('apple page: the state carries shuffle (shuffleMode 1), repeat (0 off, 1 one, 2 all), the volume, and says which controls it has', s.shuffle === false && s.repeat === 'off' && s.volume === 0.7 && s.has.shuffle && s.has.repeat && s.has.volume && s.has.like === true, JSON.stringify(s));
  p.kit.shuffleMode = 1; p.kit.repeatMode = 2;
  p.fire('playbackStateDidChange');
  check('apple page: shuffle on and repeat all are reported; its own events (shuffle, repeat, volume) are listened to', p.state().shuffle === true && p.state().repeat === 'all' && ['shuffleModeDidChange', 'repeatModeDidChange', 'volumeDidChange'].every((ev) => (p.kitEvents[ev] || []).length === 1), JSON.stringify(p.state()));
  p.kit.repeatMode = 1; p.fire('playbackStateDidChange');
  check('apple page: repeatMode 1 is repeat one', p.state().repeat === 'one', '');

  p.send({ cmd: 'shuffle', on: true }); p.send({ cmd: 'repeat', mode: 'one' }); p.send({ cmd: 'volume', level: 0.25 });
  check('apple page: shuffle, repeat and volume set MusicKit\'s own properties', p.kit.shuffleMode === 1 && p.kit.repeatMode === 1 && p.kit.volume === 0.25, JSON.stringify([p.kit.shuffleMode, p.kit.repeatMode, p.kit.volume]));
  p.send({ cmd: 'shuffle', on: false }); p.send({ cmd: 'repeat', mode: 'off' }); p.send({ cmd: 'repeat', mode: 'all' });
  check('apple page: …off and all too; a bad mode changes nothing', p.kit.shuffleMode === 0 && p.kit.repeatMode === 2 && (p.send({ cmd: 'repeat', mode: 'rm' }), p.kit.repeatMode === 2) && (p.send({ cmd: 'volume', level: 5 }), p.kit.volume === 0.25), '');

  // the heart: ratings
  p.answers['/v1/me/ratings/songs/'] = { data: { data: [{ attributes: { value: 1 } }] } };
  p.kit.nowPlayingItem = { ...p.kit.nowPlayingItem, id: '102' };
  p.fire('nowPlayingItemDidChange');
  await flush();
  check('apple page: the heart is read from the song\'s rating (value 1 is loved), once per song', p.state().liked === true && p.calls.filter((c) => c[1] === '/v1/me/ratings/songs/102').length === 1, JSON.stringify(p.calls.filter((c) => c[0] === 'api')));
  p.calls.length = 0;
  p.send({ cmd: 'like', on: false });
  await flush();
  check('apple page: unloving is a DELETE of the rating, and the card is told at once', p.calls.some((c) => c[0] === 'api' && c[1] === '/v1/me/ratings/songs/102' && c[2] === 'DELETE') && p.state().liked === false, JSON.stringify(p.calls));
  p.send({ cmd: 'like', on: true });
  await flush();
  const put = p.calls.find((c) => c[2] === 'PUT');
  check('apple page: loving is a PUT of {type: rating, attributes: {value: 1}}', put && put[1] === '/v1/me/ratings/songs/102' && JSON.parse(put[3]).attributes.value === 1 && JSON.parse(put[3]).type === 'rating' && p.state().liked === true, JSON.stringify(put));
  p.kit.nowPlayingItem = { ...p.kit.nowPlayingItem, id: 'i.abc', type: 'library-songs' };
  p.fire('nowPlayingItemDidChange');
  await flush();
  check('apple page: a library song is rated at the library path', p.calls.some((c) => c[1] === '/v1/me/ratings/library-songs/i.abc'), JSON.stringify(p.calls.slice(-2)));
  p.kit.nowPlayingItem = { ...p.kit.nowPlayingItem, id: '103', type: 'musicVideo' };
  p.fire('nowPlayingItemDidChange');
  check('apple page: something that is not a song has no heart (liked null, has.like false)', p.state().liked === null && p.state().has.like === false, JSON.stringify(p.state()));
  const signedOut = applePage({ authorized: false });
  await flush();
  check('apple page: not signed in, no heart', signedOut.state().has.like === false && signedOut.state().liked === null, JSON.stringify(signedOut.state()));
  signedOut.send({ cmd: 'like', on: true });
  check('apple page: …and the like command does nothing', !signedOut.calls.some((c) => c[0] === 'api'), JSON.stringify(signedOut.calls));

  // the queue
  p = applePage();
  await flush();
  p.send({ cmd: 'list', kind: 'queue', rid: 5 });
  const queue = AMB.parseMessage(JSON.stringify(p.lists().find((l) => l.kind === 'queue')));
  check('apple page: the queue is what comes after the playing song (position 1 of 8: six songs, a music video made a song, no id dropped)', queue.ok && queue.rid === 5 && queue.items.length === 6 && queue.items[0].title === 'Song 2' && queue.items[1].id === '103' && queue.items[0].ms === 180002, JSON.stringify(queue.items.map((i) => i.title)));
  p.send({ cmd: 'list', kind: 'tracks', rid: 6 });
  const tracks = AMB.parseMessage(JSON.stringify(p.lists().find((l) => l.kind === 'tracks')));
  check('apple page: the track list is the whole queue with the playing one marked, titled by its album', tracks.ok && tracks.items.length === 8 && tracks.current === 1 && tracks.title === 'Quiet Hours', JSON.stringify([tracks.items.length, tracks.current, tracks.title]));
  p.send({ cmd: 'playQueue', index: 0, id: '102' });
  await flush();
  check('apple page: play from the queue changes to that position and plays (index 0 is position 2, which is song 102)', JSON.stringify(p.calls.filter((c) => c[0] === 'changeToMediaAtIndex')) === '[["changeToMediaAtIndex",2]]' && p.calls.some((c) => c[0] === 'play'), JSON.stringify(p.calls));
  p.calls.length = 0;
  p.send({ cmd: 'playQueue', index: 0, id: '777' });
  await flush();
  check('apple page: …but not when the song there is not the one the card showed: an error, nothing played', p.calls.length === 0 && p.out.some((m) => m.t === 'error' && /queue changed/.test(m.message)), JSON.stringify(p.out.filter((m) => m.t === 'error')));
  p.send({ cmd: 'playFrom', index: 5 });
  await flush();
  check('apple page: play from a track list row changes to that position', p.calls.some((c) => c[0] === 'changeToMediaAtIndex' && c[1] === 5), JSON.stringify(p.calls));
  p.calls.length = 0;
  p.send({ cmd: 'playFrom', index: 50 });
  check('apple page: a position that is not in the queue plays nothing', !p.calls.some((c) => c[0] === 'changeToMediaAtIndex'), '');

  // lyrics (subscribers)
  p.answers['/v1/catalog/us/songs/999/lyrics'] = { data: { data: [{ attributes: { ttml: '<tt><body><div><p begin="0:01" end="0:03">Streetlights hum &amp; sing</p><p begin="0:04"><span>Night</span> <span>shift</span></p><p></p><p>It&apos;s &lt;fine&gt;</p></div></body></tt>' } }] } };
  p.send({ cmd: 'lyrics', rid: 9 });
  await flush();
  const ly = p.out.find((m) => m.t === 'lyrics');
  const lyParsed = AMB.parseMessage(JSON.stringify(ly));
  check('apple page: lyrics are asked of the catalog by the song\'s catalog id and read as plain lines (tags and entities removed, empty lines dropped)', lyParsed.ok === true && JSON.stringify(lyParsed.lines) === JSON.stringify(['Streetlights hum & sing', 'Night shift', "It's <fine>"]) && lyParsed.rid === 9 && p.calls.some((c) => c[1] === '/v1/catalog/us/songs/999/lyrics'), JSON.stringify(ly));
  p.out.length = 0;
  p.answers['/v1/catalog/us/songs/999/lyrics'] = Object.assign(new Error('nope'), { status: 404 });
  p.send({ cmd: 'lyrics', rid: 10 });
  await flush();
  check('apple page: a song with no lyrics (404) says "none"; 401 / 403 says signed out', p.out.find((m) => m.t === 'lyrics').why === 'none' && (p.answers['/v1/catalog/us/songs/999/lyrics'] = Object.assign(new Error('x'), { status: 403 }), p.out.length = 0, p.send({ cmd: 'lyrics', rid: 11 }), await flush(), p.out.find((m) => m.t === 'lyrics').why === 'signedOut'), JSON.stringify(p.out));
  const so = applePage({ authorized: false });
  await flush();
  so.send({ cmd: 'lyrics', rid: 12 });
  check('apple page: not signed in, lyrics say signedOut without asking Apple', so.out.find((m) => m.t === 'lyrics').why === 'signedOut' && !so.calls.some((c) => c[0] === 'api'), '');

  // the commands from main
  const cc = (c) => AMB.cleanCommand(c);
  check('apple bridge: like / shuffle take a boolean; repeat one of off, all, one; volume 0..1; lyrics a request number; rows an index (and optionally the song\'s id)', cc({ cmd: 'like', on: true }) === '{"cmd":"like","on":true}' && cc({ cmd: 'like', on: 'yes' }) === null && cc({ cmd: 'shuffle' }) === null && cc({ cmd: 'repeat', mode: 'one' }) === '{"cmd":"repeat","mode":"one"}' && cc({ cmd: 'repeat', mode: 'x' }) === null && cc({ cmd: 'volume', level: 0.456 }) === '{"cmd":"volume","level":0.46}' && cc({ cmd: 'volume', level: 2 }) === null && cc({ cmd: 'volume', level: NaN }) === null && cc({ cmd: 'lyrics', rid: 4 }) === '{"cmd":"lyrics","rid":4}' && cc({ cmd: 'playQueue', index: 3, id: 'x1' }) === '{"cmd":"playQueue","index":3,"id":"x1"}' && cc({ cmd: 'playQueue', index: -1 }) === null && cc({ cmd: 'playQueue', index: 100 }) === null && cc({ cmd: 'playFrom', index: 99 }) !== null && cc({ cmd: 'playFrom', index: 100 }) === null && cc({ cmd: 'playFrom', index: 1, id: 'a b' }) === null && cc({ cmd: 'list', kind: 'queue', rid: 1 }) !== null && cc({ cmd: 'list', kind: 'tracks', rid: 1 }) !== null && cc({ cmd: 'list', kind: 'secrets' }) === null, '');
  const sc = (c) => SPB.cleanCommand(c);
  check('spotify bridge: the same commands are checked the same way (like, shuffle, repeat, volume, lyrics, list, rows)', sc({ cmd: 'like', on: false }) === '{"cmd":"like","on":false}' && sc({ cmd: 'like', on: 1 }) === null && sc({ cmd: 'repeat', mode: 'all' }) === '{"cmd":"repeat","mode":"all"}' && sc({ cmd: 'repeat', mode: 'context' }) === null && sc({ cmd: 'volume', level: 1 }) === '{"cmd":"volume","level":1}' && sc({ cmd: 'volume', level: -0.1 }) === null && sc({ cmd: 'lyrics', rid: 1 }) === '{"cmd":"lyrics","rid":1}' && sc({ cmd: 'list', kind: 'queue', rid: 2 }) === '{"cmd":"list","kind":"queue","rid":2}' && sc({ cmd: 'list', kind: 'tracks', rid: 2 }) !== null && sc({ cmd: 'playQueue', index: 2, id: 'ab' }) === '{"cmd":"playQueue","index":2,"id":"ab"}' && sc({ cmd: 'playFrom', index: 100 }) === null && sc({ cmd: 'playQueue', index: 'x' }) === null && sc({ cmd: 'playFrom', index: 1, id: '../x' }) === null, '');
  const st = SPB.parseMessage(spState({ shuffle: 'yes', repeat: 'context', volume: 7, liked: 'x', has: { like: 'yes' } }));
  check('spotify bridge: the switches in a state are bounded (junk becomes null, a volume is clamped, `has` only true for true)', st.shuffle === null && st.repeat === null && st.volume === 1 && st.liked === null && st.has.like === false && st.has.shuffle === false && SPB.parseMessage(spState()).has.shuffle === true, JSON.stringify(st));
  const sl = SPB.parseMessage(JSON.stringify({ t: 'lyrics', rid: 3, ok: true, lines: ['a', '', 5, 'b'.repeat(500)] }));
  check('spotify bridge: lyrics lines are bounded text; non-text and empty lines are dropped', sl.lines.length === 2 && sl.lines[1].length === 200, JSON.stringify(sl));
}

module.exports = async function musicCardFeaturesUnits(check) {
  featureChecks(check);
  keyChecks(check);
  await apiChecks(check);
  await engineChecks(check);
  await appleChecks(check);
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } else console.log(`PASS ${name}`); })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
