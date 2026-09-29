// The Spotify new-tab widget, without Electron or the network (run from test/units.js): the pure
// view logic (Client ID, PKCE, token answers, now-playing shaping, art checks, error messages) and the
// connector itself against a fake Spotify handed to createWidgets as its fetch: sign-in, refresh on
// expiry and on a 401, a rotated refresh token, no-active-device, 204, 429 backoff, play/pause/next/
// previous, and that no token ever reaches the page's data or settings.json.
const crypto = require('crypto');
const SV = require('../features/spotify-view');
const { createWidgets } = require('../features/widgets');

const CLIENT = '0123456789abcdef0123456789abcdef';
// A 1x1 PNG: enough for the magic-byte check.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const track = (extra = {}) => ({
  is_playing: true, progress_ms: 30000, currently_playing_type: 'track',
  device: { name: 'Kitchen speaker' },
  item: {
    type: 'track', name: 'Song <b>One</b>', duration_ms: 200000,
    artists: [{ name: 'Ann' }, { name: 'Bo' }],
    album: { name: 'Album\nName', images: [{ url: 'https://i.scdn.co/image/big', width: 640 }, { url: 'https://i.scdn.co/image/mid', width: 300 }, { url: 'https://evil.example/x.png', width: 300 }, { url: 'http://i.scdn.co/image/plain', width: 64 }] },
    external_urls: { spotify: 'https://open.spotify.com/track/abc' },
  },
  ...extra,
});

function viewChecks(check) {
  check('spotify config: a Client ID is 32 hex digits (trimmed, lowercased); anything else drops the widget', SV.cleanClientId(` ${CLIENT.toUpperCase()} `) === CLIENT && SV.cleanClientId('nope') === '' && SV.cleanClientId(CLIENT + 'a') === '' && SV.cleanConfig({}) === null && SV.cleanConfig(null) === null && SV.cleanConfig({ clientId: CLIENT }).art === true && SV.cleanConfig({ clientId: CLIENT, art: false }).art === false, '');
  const p = SV.pkce();
  check('spotify PKCE: the verifier is 43 to 128 URL-safe characters and the challenge is its SHA-256 (S256)', /^[A-Za-z0-9_-]{43,128}$/.test(p.verifier) && p.challenge === crypto.createHash('sha256').update(p.verifier).digest('base64url') && SV.pkce().verifier !== p.verifier && /^[0-9a-f]{32}$/.test(p.state), p.verifier);
  const u = new URL(SV.authorizeUrl('https://accounts.spotify.com', { clientId: CLIENT, challenge: p.challenge, state: p.state }));
  check('spotify authorize address: code flow, PKCE, the loopback redirect, only the two playback scopes, no secret', u.origin + u.pathname === 'https://accounts.spotify.com/authorize' && u.searchParams.get('response_type') === 'code' && u.searchParams.get('code_challenge_method') === 'S256' && u.searchParams.get('code_challenge') === p.challenge && u.searchParams.get('redirect_uri') === SV.REDIRECT_URI && /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(SV.REDIRECT_URI) && u.searchParams.get('scope') === 'user-read-playback-state user-modify-playback-state' && !u.search.includes('secret'), u.href);
  const f = new URLSearchParams(SV.tokenForm('code', { clientId: CLIENT, code: 'C', verifier: 'V' }));
  const r = new URLSearchParams(SV.tokenForm('refresh', { clientId: CLIENT, refresh: 'R' }));
  check('spotify token requests: a form with the verifier and no client secret', f.get('grant_type') === 'authorization_code' && f.get('code_verifier') === 'V' && f.get('redirect_uri') === SV.REDIRECT_URI && r.get('grant_type') === 'refresh_token' && r.get('refresh_token') === 'R' && !f.has('client_secret') && !r.has('client_secret'), '');
  const t = SV.parseToken(JSON.stringify({ access_token: 'A', refresh_token: 'R2', expires_in: 3600 }), 1000);
  check('spotify token answer: access, refresh and an expiry a little early; the old refresh token stays when none is sent', t.access === 'A' && t.refresh === 'R2' && t.exp === 1000 + 3570e3 && SV.parseToken(JSON.stringify({ access_token: 'A', expires_in: 10 }), 0, 'OLD').refresh === 'OLD', JSON.stringify(t));
  let bad = 0;
  for (const body of ['', 'null', '{}', '{"access_token":""}', '[]', JSON.stringify({ access_token: 'A' })]) { try { SV.parseToken(body, 0); } catch { bad++; } }
  check('spotify token answer: junk (and no refresh token at all) is refused', bad === 6, String(bad));

  const n = SV.normalizePlayback(track(), 5000);
  check('spotify now playing: title, artists, album, progress and length, flattened text', n.state === 'playing' && n.title === 'Song <b>One</b>' && n.artist === 'Ann, Bo' && n.album === 'Album Name' && n.progressMs === 30000 && n.durationMs === 200000 && n.at === 5000 && n.device === 'Kitchen speaker' && n.kind === 'track' && n.url === 'https://open.spotify.com/track/abc', JSON.stringify(n));
  check('spotify album art: only Spotify\'s own https host, the 300px picture first, then the others', SV.imageUrls(track().item.album.images).join() === 'https://i.scdn.co/image/mid,https://i.scdn.co/image/big' && !SV.isImageUrl('https://evil.example/i.scdn.co') && !SV.isImageUrl('https://i.scdn.co.evil.example/x') && !SV.isImageUrl('javascript:1') && SV.isImageUrl('https://i.scdn.co/image/x'), SV.imageUrls(track().item.album.images).join());
  check('spotify now playing: paused, an unknown link is dropped, progress never passes the end', SV.normalizePlayback(track({ is_playing: false }), 0).state === 'paused' && SV.normalizePlayback(track({ item: { ...track().item, external_urls: { spotify: 'https://evil.example/x' } } }), 0).url === '' && SV.normalizePlayback(track({ progress_ms: 999999 }), 0).progressMs === 200000, '');
  const ep = SV.normalizePlayback({ is_playing: true, progress_ms: 5, currently_playing_type: 'episode', item: { type: 'episode', name: 'Ep 1', duration_ms: 1000, show: { name: 'The Show', publisher: 'Pub', images: [{ url: 'https://i.scdn.co/image/s', width: 300 }] }, images: [] } }, 0);
  check('spotify now playing: a podcast episode shows its show, an ad says so', ep.kind === 'episode' && ep.artist === 'Pub' && ep.album === 'The Show' && ep.images.length === 1 && SV.normalizePlayback({ is_playing: true, currently_playing_type: 'ad', item: null }, 0).title === 'Advertisement', JSON.stringify(ep));
  check('spotify now playing: 204 / nothing / junk is idle, and an idle device is named', SV.normalizePlayback(null, 1).state === 'idle' && SV.normalizePlayback('x', 1).state === 'idle' && SV.normalizePlayback({ device: { name: 'Phone' }, item: null, is_playing: false }, 1).device === 'Phone' && SV.normalizePlayback({ device: { name: 'Phone' }, item: null }, 1).state === 'idle', '');
  const at = SV.normalizePlayback(track(), 10000);
  check('spotify progress: moves on while playing, stands still when paused, stops at the end', SV.progressNow(at, 12000) === 32000 && SV.progressNow({ ...at, state: 'paused' }, 99999) === 30000 && SV.progressNow(at, 10000 + 999999) === 200000 && SV.progressNow(at, 5000) === 30000, '');
  check('spotify art bytes: JPEG, PNG and WebP by their first bytes, nothing else, nothing too big', SV.dataUrl(PNG).startsWith('data:image/png;base64,') && SV.dataUrl(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])).startsWith('data:image/jpeg;base64,') && SV.dataUrl(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])).startsWith('data:image/webp;base64,') && SV.dataUrl(Buffer.from('<svg onload=alert(1)>')) === null && SV.dataUrl(Buffer.alloc(0)) === null && SV.dataUrl(Buffer.concat([PNG, Buffer.alloc(SV.MAX_ART_BYTES)])) === null, '');
  check('spotify buttons: play, pause, next and previous are the only player calls', JSON.stringify(SV.actionRequest('pause')) === '{"method":"PUT","path":"/me/player/pause"}' && SV.actionRequest('next').method === 'POST' && SV.actionRequest('previous').path === '/me/player/previous' && SV.actionRequest('play').path === '/me/player/play' && SV.actionRequest('volume') === null && SV.actionRequest('constructor') === null && SV.actionRequest('__proto__') === null, '');
  const err = (status, body) => SV.playerError(status, JSON.stringify(body));
  check('spotify errors: no active device, Premium needed, slow down, signed out are said in plain words', /No active Spotify device/.test(err(404, { error: { status: 404, reason: 'NO_ACTIVE_DEVICE' } })) && /No active Spotify device/.test(err(404, {})) && /Premium/.test(err(403, { error: { reason: 'PREMIUM_REQUIRED' } })) && /slow down/.test(err(429, {})) && /Connect Spotify again/.test(err(401, {})) && /Client ID/.test(SV.tokenError(400, '{"error":"invalid_client"}')) && /signed Lumen out/.test(SV.tokenError(400, '{"error":"invalid_grant"}')) && /answered 500/.test(err(500, {})), '');
}

// A fake Spotify: records what was asked, answers from `world`.
function fakeSpotify() {
  const log = [];
  const world = { access: 'ACCESS-1', refresh: 'REFRESH-1', tokens: 0, playback: track(), status: null, playerStatus: 200, rotate: false, failNextWith401: false, name: 'Ann' };
  const reply = (status, body, headers = {}) => new Response(status === 204 ? null : body, { status, headers });
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const headers = opts.headers || {};
    const entry = { method: opts.method || 'GET', host: u.host, path: u.pathname + u.search, auth: headers.Authorization || '', body: typeof opts.body === 'string' ? opts.body : '' };
    log.push(entry);
    if (u.host === 'accounts.spotify.com' && u.pathname === '/api/token') {
      const form = new URLSearchParams(entry.body);
      const grant = form.get('grant_type');
      if (grant === 'refresh_token' && form.get('refresh_token') !== world.refresh) return reply(400, JSON.stringify({ error: 'invalid_grant' }));
      if (grant === 'authorization_code' && form.get('code') !== 'GOOD-CODE') return reply(400, JSON.stringify({ error: 'invalid_grant' }));
      world.tokens++;
      world.access = `ACCESS-${world.tokens + 1}`;
      if (world.rotate && grant === 'refresh_token') world.refresh = `REFRESH-${world.tokens + 1}`;
      return reply(200, JSON.stringify({ access_token: world.access, token_type: 'Bearer', expires_in: 3600, refresh_token: grant === 'authorization_code' || world.rotate ? world.refresh : undefined }));
    }
    if (u.host === 'i.scdn.co') return reply(200, PNG, { 'content-type': 'image/png' });
    if (u.host !== 'api.spotify.com') return reply(404, '{}');
    if (world.failNextWith401) { world.failNextWith401 = false; return reply(401, JSON.stringify({ error: { status: 401, message: 'The access token expired' } })); }
    if (entry.auth !== `Bearer ${world.access}`) return reply(401, JSON.stringify({ error: { status: 401 } }));
    if (world.status) return reply(world.status.code, world.status.body || '{}', world.status.headers);
    if (u.pathname === '/v1/me') return reply(200, JSON.stringify({ display_name: world.name }));
    if (u.pathname === '/v1/me/player') return world.playerStatus === 204 ? reply(204) : reply(200, JSON.stringify(world.playback));
    if (/^\/v1\/me\/player\/(play|pause|next|previous)$/.test(u.pathname)) return reply(204);
    return reply(404, '{}');
  };
  return { fetch, log, world };
}

async function connectorChecks(check) {
  const fake = fakeSpotify();
  let clock = Date.parse('2026-09-29T12:00:00Z');
  const secrets = new Map();
  let settings = {};
  const w = createWidgets({
    readSettings: () => settings,
    writeSettings: (s) => { settings = JSON.parse(JSON.stringify(s)); },
    fetch: fake.fetch,
    getSecret: (name) => secrets.get(name) || null,
    setSecret: (name, value) => { if (value) secrets.set(name, value); else secrets.delete(name); },
    onUpdate: () => {},
    endpoints: () => ({}),
    now: () => clock,
  });
  const advance = (ms) => { clock += ms; };
  const plain = (s) => JSON.stringify(s);

  // sign-in
  let threw = '';
  try { w.spotifyStart('nope'); } catch (e) { threw = e.message; }
  check('spotify sign-in: without a valid Client ID it refuses before opening anything', /Client ID/.test(threw), threw);
  const session = w.spotifyStart(CLIENT);
  const auth = new URL(session.url);
  await session.exchange('GOOD-CODE');
  const exchange = fake.log.find((l) => l.path === '/api/token');
  const sent = new URLSearchParams(exchange.body);
  check('spotify sign-in: the code is traded with the PKCE verifier that matches the challenge in the address', auth.searchParams.get('state') === session.state && crypto.createHash('sha256').update(sent.get('code_verifier')).digest('base64url') === auth.searchParams.get('code_challenge') && sent.get('client_id') === CLIENT && !sent.has('client_secret'), exchange.body);
  check('spotify sign-in: the refresh token is stored through setSecret (encrypted by main.js), and never in settings', secrets.get('spotify') === 'REFRESH-1' && !plain(settings).includes('REFRESH-1'), plain([...secrets]));
  let bad = '';
  try { await w.spotifyStart(CLIENT).exchange('WRONG'); } catch (e) { bad = e.message; }
  check('spotify sign-in: a refused code reads as being signed out, and stores nothing new', /signed Lumen out/.test(bad) && secrets.get('spotify') === 'REFRESH-1', bad);
  let junk = '';
  try { await w.spotifyStart(CLIENT).exchange('../etc?x'); } catch (e) { junk = e.message; }
  check('spotify sign-in: a code with odd characters is not even sent', /unexpected/.test(junk) && fake.log.filter((l) => l.path === '/api/token').length === 2, junk);

  // Settings: Check and Save
  const before = fake.log.length;
  const test = await w.test({ type: 'spotify', clientId: CLIENT });
  check('spotify Settings: Check says who is connected (one call, the access token from sign-in)', test.ok && /Connected as Ann/.test(test.message) && fake.log.length === before + 1 && fake.log.at(-1).path === '/v1/me', plain(test));
  const noClient = await w.test({ type: 'spotify', clientId: '' });
  check('spotify Settings: no Client ID is a plain message', !noClient.ok && /Client ID/.test(noClient.message), plain(noClient));
  const saved = await w.save({ type: 'spotify', clientId: CLIENT, art: true, colors: 'match' });
  const id = saved.widget.id;
  const settle = async () => { await w.cache.get(id)?.pending; }; // a save starts a fetch of its own
  await settle();
  check('spotify Settings: saved with the Client ID, art switch and colours; its size is the default', saved.widget.type === 'spotify' && saved.widget.clientId === CLIENT && saved.widget.art === true && saved.widget.colors === 'match' && saved.widget.w === 4 && saved.widget.h === 3 && w.state().widgets[0].label === 'Spotify' && w.state().types.some((t) => t.type === 'spotify') && w.state().secrets.spotify === true, plain(saved.widget));

  // fetching
  await w.refresh(w.list()[0], { force: true });
  let data = w.cache.get(id).data;
  check('spotify card: title, artist, album, state, progress and a data: URL picture (fetched by main)', data.state === 'playing' && data.title === 'Song <b>One</b>' && data.artist === 'Ann, Bo' && data.album === 'Album Name' && data.progressMs === 30000 && data.durationMs === 200000 && /^data:image\/png;base64,/.test(data.art) && fake.log.some((l) => l.host === 'i.scdn.co' && l.path === '/image/mid') && !fake.log.some((l) => l.host === 'evil.example'), plain(data).slice(0, 300));
  check('spotify card: the page gets no picture address and no token', !('images' in data) && !plain(w.forPage()).includes('http://') && !/ACCESS|REFRESH/.test(plain(w.forPage())) && !/ACCESS|REFRESH/.test(plain(settings)), plain(Object.keys(data)));
  const artCalls = fake.log.filter((l) => l.host === 'i.scdn.co').length;
  advance(25e3);
  await w.refresh(w.list()[0]);
  check('spotify card: the same picture is not downloaded again for the same track', fake.log.filter((l) => l.host === 'i.scdn.co').length === artCalls, String(artCalls));
  const noArt = await w.save({ type: 'spotify', clientId: CLIENT, art: false }, id);
  await settle();
  await w.refresh(w.list()[0], { force: true });
  data = w.cache.get(id).data;
  check('spotify card: with album art off, no picture is fetched or sent', noArt.widget.art === false && data.art === '', plain(data).slice(0, 200));
  await w.save({ type: 'spotify', clientId: CLIENT, art: true }, id);
  await settle();

  // token refresh: on expiry, on a 401, and a rotated refresh token
  const tokensBefore = fake.world.tokens;
  advance(3600e3);
  await w.refresh(w.list()[0]);
  check('spotify tokens: an expired access token is renewed from the refresh token before the call', fake.world.tokens === tokensBefore + 1 && w.cache.get(id).data.state === 'playing' && !w.cache.get(id).error, String(w.cache.get(id).error));
  advance(25e3);
  fake.world.failNextWith401 = true;
  const calls401 = fake.log.length;
  await w.refresh(w.list()[0]);
  const after401 = fake.log.slice(calls401).map((l) => `${l.host}${l.path}`);
  check('spotify tokens: a 401 renews the token once and retries the call', !w.cache.get(id).error && fake.world.tokens === tokensBefore + 2 && after401.filter((s) => s.startsWith('api.spotify.com/v1/me/player')).length >= 2 && after401.includes('accounts.spotify.com/api/token'), after401.join());
  fake.world.rotate = true;
  advance(3600e3);
  await w.refresh(w.list()[0]);
  check('spotify tokens: a new refresh token from Spotify replaces the stored one', secrets.get('spotify') === fake.world.refresh && fake.world.refresh !== 'REFRESH-1', `${secrets.get('spotify')} ${fake.world.refresh}`);
  fake.world.rotate = false;

  // 204: no active device / nothing playing
  advance(25e3);
  fake.world.playerStatus = 204;
  await w.refresh(w.list()[0]);
  data = w.cache.get(id).data;
  check('spotify card: a 204 (nothing playing, no active device) is an idle card, not an error', data.state === 'idle' && data.title === '' && !w.cache.get(id).error && w.forPage()[0].error === null, plain(data));
  fake.world.playerStatus = 200;

  // signed out on Spotify's side
  advance(25e3);
  const good = fake.world.refresh;
  fake.world.refresh = 'CHANGED';
  advance(3600e3);
  await w.refresh(w.list()[0]);
  check('spotify tokens: a refresh token Spotify no longer accepts says to connect again, and the last card stays with a warning', /Connect Spotify again/.test(w.cache.get(id).error) && /Connect Spotify again/.test(w.forPage()[0].warning || ''), String(w.cache.get(id).error));
  fake.world.refresh = good;
  advance(3 * 60e3);
  await w.refresh(w.list()[0]);
  check('spotify tokens: …and it recovers by itself once the sign-in works', !w.cache.get(id).error, String(w.cache.get(id).error));

  // page actions
  check('spotify page actions: play, pause, next and previous are accepted, anything else is not', ['play', 'pause', 'next', 'previous'].every((d) => w.actionFrom(`file:///newtab.html?widget=${id}&do=${d}`)?.do === d) && w.actionFrom(`file:///newtab.html?widget=${id}&do=skip`)?.invalid === true && w.actionFrom(`file:///newtab.html?widget=${id}&do=volume`)?.invalid === true, '');
  advance(25e3);
  await w.refresh(w.list()[0]);
  const ok = await w.act({ id, do: 'pause' });
  const put = fake.log.filter((l) => l.path === '/v1/me/player/pause').at(-1);
  data = w.cache.get(id).data;
  check('spotify pause: PUT /me/player/pause with the token; the card is paused at once', ok === true && put.method === 'PUT' && /^Bearer ACCESS-/.test(put.auth) && data.state === 'paused', plain([ok, put, data.state]));
  await w.act({ id, do: 'play' });
  check('spotify play: PUT /me/player/play, playing again', fake.log.filter((l) => l.path === '/v1/me/player/play').at(-1).method === 'PUT' && w.cache.get(id).data.state === 'playing', '');
  await w.act({ id, do: 'next' });
  await w.act({ id, do: 'previous' });
  const nx = fake.log.filter((l) => l.path === '/v1/me/player/next').at(-1);
  const pv = fake.log.filter((l) => l.path === '/v1/me/player/previous').at(-1);
  check('spotify next / previous: POST /me/player/next and /previous', nx.method === 'POST' && pv.method === 'POST', plain([nx, pv]));
  fake.world.status = { code: 404, body: JSON.stringify({ error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } }) };
  const failed = await w.act({ id, do: 'play' });
  check('spotify no active device: the action says so on the card instead of failing silently', failed === false && /No active Spotify device/.test(w.cache.get(id).data.notice) && w.cache.get(id).data.title === 'Song <b>One</b>', String(w.cache.get(id).data?.notice));
  fake.world.status = { code: 403, body: JSON.stringify({ error: { status: 403, reason: 'PREMIUM_REQUIRED' } }) };
  await w.act({ id, do: 'next' });
  check('spotify without Premium: the card says controls need Premium', /Premium/.test(w.cache.get(id).data.notice), String(w.cache.get(id).data?.notice));
  fake.world.status = null;

  // 429 backoff
  await new Promise((r) => setTimeout(r, 800)); // the follow-up refresh after the last successful action
  advance(3 * 60e3);
  fake.world.status = { code: 429, body: '{}', headers: { 'retry-after': '30' } };
  await w.refresh(w.list()[0]);
  const tooMany = w.cache.get(id).error;
  const seen = fake.log.length;
  fake.world.status = null;
  advance(5e3);
  await w.refresh(w.list()[0], { force: true });
  advance(3 * 60e3);
  check('spotify 429: Spotify\'s Retry-After is honoured (no requests until it passes) and the card says to wait', /slow down/.test(tooMany) && fake.log.length === seen, `${tooMany} ${fake.log.length - seen}`);
  await w.refresh(w.list()[0]);
  check('spotify 429: …then it carries on', !w.cache.get(id).error && w.cache.get(id).data.state === 'playing', String(w.cache.get(id).error));

  // removing and disconnecting
  w.spotifyDisconnect();
  check('spotify Disconnect: the stored refresh token goes and the card asks to connect', !secrets.has('spotify') && w.state().secrets.spotify === false, '');
  w.remove(id);
  check('spotify remove: the widget is gone and the token stays gone', w.list().length === 0 && !secrets.has('spotify'), '');
  await w.save({ type: 'spotify', clientId: CLIENT }).then(() => check('spotify Settings: saving without a sign-in is refused', false, 'saved'), (e) => check('spotify Settings: saving without a sign-in is refused', /Connect Spotify first/.test(e.message), e.message));
}

module.exports = async function spotifyUnits(check) {
  viewChecks(check);
  await connectorChecks(check);
};
