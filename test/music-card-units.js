// The Spotify card's buttons, search and stillness, without Electron, Spotify or the network (a fake view, a fake page and a fake Spotify Web API):
//   - the engine ("play inside Lumen"): a button pressed or a search typed while the hidden page is still starting (after an idle unload, a
//     reload, a sign-in round trip) is kept and sent once that page's bridge is ready, instead of being dropped; a bridge that said ready in
//     an earlier document of the view is not trusted for a new one (features/web-player.js generation());
//   - API mode: a button pressed with no active Spotify device wakes one of the account's devices instead of only failing;
//   - the card on the new-tab page is not drawn again when only its playhead stamp moved (features/widget-card-key.js), and a card that is
//     drawn again starts where the old one was instead of sliding in from the grid's corner (renderer/newtab-widgets.js, the grid).
// Runs on its own (npm run test:units picks up test/*-units.js).
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { createEngine } = require('../src/features/spotify-engine');
const { createWebPlayer } = require('../src/features/web-player');
const { createWidgets } = require('../src/features/widgets');
const SV = require('../src/features/spotify-view');
const CK = require('../src/features/widget-card-key');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLIENT = '0123456789abcdef0123456789abcdef';
const state = (o = {}) => JSON.stringify({ t: 'state', state: 3, pos: 12, dur: 200, device: '', player: true, item: { title: 'Night Shift', artist: 'Ann', album: 'Quiet Hours', art: '', ms: 200000 }, ...o });

// A fake web player (features/web-player.js) whose page document can be replaced (a reload): generation() moves on, as the real one does.
function fakePlayer() {
  const p = {
    gen: 0, st: { state: 'ready', drm: 'ok' }, wc: null, destroyed: 0,
    ensure() { if (!p.wc) { p.wc = { sent: [], executeJavaScript(code) { const m = /detail: (".*") \}\)\)$/.exec(code); if (m) p.wc.sent.push(JSON.parse(JSON.parse(m[1]))); return Promise.resolve(); } }; p.gen++; } return {}; },
    webContents: () => p.wc, status: () => p.st, isSignedIn: () => true, generation: () => p.gen,
    destroy() { p.destroyed++; p.wc = null; p.gen++; }, showIn() {}, release() {}, reload() { p.gen++; },
  };
  return p;
}

async function engineChecks(check) {
  let t = 1e12;
  const player = fakePlayer();
  const e = createEngine({ player, now: () => t, fetchBytes: async () => null, hasCard: () => true, onChange: () => {}, setInterval: () => ({ unref() {} }), setTimeout: () => ({ unref() {} }) });
  const sent = () => (player.wc ? player.wc.sent : []);

  // ---- before the bridge is ready (the page is loading) ----
  await e.read();
  check('engine: a button pressed while the page is still loading is accepted (not "didn\'t answer"), and nothing is sent to a page with no bridge yet', (await e.control('play')) === true && sent().length === 0, JSON.stringify(sent()));
  check('engine: …a search typed meanwhile is accepted too, and the card says "Searching…" for that term at once', e.search('shake it off') === true && sent().length === 0 && await e.read().then((d) => d.searching === true && d.query === 'shake it off'), '');
  e.onMessage('{"t":"ready"}');
  check('engine: once the bridge says ready, the kept search and button are sent, the search first (playing goes last, so it wins)', JSON.stringify(sent().map((c) => c.cmd)) === '["search","play"]' && sent()[0].term === 'shake it off', JSON.stringify(sent()));
  e.onMessage(JSON.stringify({ t: 'list', kind: 'search', rid: sent()[0].rid, ok: true, items: [{ id: 'AAAAAAAAAAAAAAAAAAAAA1', kind: 'song', title: 'Shake It Off', sub: 'Taylor', ms: 219000 }] }));
  const found = await e.read();
  check('engine: …and its answer reaches the card (the results, no longer searching)', found.searching === false && found.results.length === 1 && found.results[0].title === 'Shake It Off', JSON.stringify(found.results));

  // ---- ready: sent at once ----
  const n = sent().length;
  e.onMessage(state());
  check('engine: ready, next / previous / pause / seek go straight to the page', (await e.control('next')) && (await e.control('previous')) && e.seek(40) && sent().length === n + 3 && sent().at(-1).cmd === 'seek' && sent().at(-1).sec === 40, JSON.stringify(sent().slice(n)));

  // ---- a new document in the view (reload, sign-in round trip): the old bridge is gone ----
  player.reload();
  const n2 = sent().length;
  check('engine: after the view loads a new document, a button is kept for the new bridge, not sent into a page that has none', (await e.control('play')) === true && sent().length === n2, JSON.stringify(sent().slice(n2)));
  e.onMessage('{"t":"ready"}');
  check('engine: …and goes once the new document\'s bridge is ready', sent().length === n2 + 1 && sent().at(-1).cmd === 'play', JSON.stringify(sent().slice(n2)));

  // ---- a kept search that never gets a page ----
  player.reload();
  e.search('night shift');
  t += 25e3;
  const stale = await e.read();
  check('engine: a search kept for a page that never became ready stops saying "Searching…" and says it got no answer', stale.searching === false && stale.searchOk === false && stale.query === 'night shift', JSON.stringify([stale.searching, stale.searchOk, stale.query]));
  const n3 = sent().length;
  e.onMessage('{"t":"ready"}');
  check('engine: …and is not sent late when that page does come up', sent().length === n3, JSON.stringify(sent().slice(n3)));

  // ---- unloaded after an idle: the page starts again for a button ----
  e.unload();
  const d0 = player.destroyed;
  check('engine: a button pressed after an idle unload starts the page again and is kept for it', (await e.control('play')) === true && player.wc && sent().length === 0 && d0 === player.destroyed, '');
  e.onMessage('{"t":"ready"}');
  check('engine: …and sent when it is ready', sent().length === 1 && sent()[0].cmd === 'play', JSON.stringify(sent()));
  check('engine: what isn\'t a command is still refused', (await e.control('volume')) === false && e.playItem('song', 'bad id!') === false, '');
  e.destroy();
}

// The real web player's generation(): a fake WebContentsView whose page emits Electron's navigation events.
function webPlayerChecks(check) {
  const views = [];
  function WebContentsView() {
    const wc = new EventEmitter();
    wc.isDestroyed = () => false; wc.loadURL = () => Promise.resolve(); wc.setWindowOpenHandler = () => {}; wc.getURL = () => 'https://open.spotify.com/'; wc.close = () => {};
    wc.executeJavaScript = () => Promise.resolve(false);
    this.webContents = wc; this.setVisible = () => {}; this.getVisible = () => false; this.setBounds = () => {};
    views.push(this);
  }
  const wp = createWebPlayer({ WebContentsView, session: null, getWindow: () => null, getBounds: () => null, activeNewTab: () => null, hasWidget: () => false, keepAlive: () => true, openTab: () => {}, isWebUrl: () => true }, { url: 'https://open.spotify.com/', hosts: new Set(['open.spotify.com']), cardClass: 'spotify' });
  wp.ensure();
  const wc = views[0].webContents;
  const g0 = wp.generation();
  wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: 'https://open.spotify.com/' });
  const g1 = wp.generation();
  wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true, url: 'https://open.spotify.com/search/x' });
  wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false, url: 'https://open.spotify.com/frame' });
  check('web player: a new main-frame document moves generation() on; an in-page route change (the bridge\'s search) or a sub-frame does not', g1 === g0 + 1 && wp.generation() === g1, JSON.stringify([g0, g1, wp.generation()]));
  wc.emit('did-start-navigation', {}, 'https://accounts.spotify.com/', false, true); // (the older argument form)
  check('web player: …the older event arguments count the same', wp.generation() === g1 + 1, String(wp.generation()));
  const g2 = wp.generation();
  wp.destroy();
  check('web player: a view that is closed moves it on too (a new view is a new page)', wp.generation() > g2, '');
}

// API mode against a fake Spotify Web API.
function fakeApi(world) {
  const log = [];
  const reply = (status, body = '{}') => new Response(status === 204 ? null : body, { status });
  const noDevice = () => reply(404, JSON.stringify({ error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } }));
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const entry = { method: opts.method || 'GET', path: u.pathname + u.search, body: typeof opts.body === 'string' ? opts.body : '' };
    log.push(entry);
    if (u.host === 'accounts.spotify.com') return reply(200, JSON.stringify({ access_token: 'ACCESS', token_type: 'Bearer', expires_in: 3600 }));
    if (u.pathname === '/v1/me/player' && entry.method === 'GET') return reply(204);
    if (u.pathname === '/v1/me/player/devices') return reply(200, JSON.stringify({ devices: world.devices }));
    if (u.pathname === '/v1/me/player' && entry.method === 'PUT') { const id = JSON.parse(entry.body).device_ids[0]; world.active = id; return reply(204); }
    if (u.pathname === '/v1/me/player/play' && u.searchParams.get('device_id')) { world.active = u.searchParams.get('device_id'); return reply(204); }
    if (/^\/v1\/me\/player\/(play|pause|next|previous)$/.test(u.pathname)) return world.active ? reply(204) : noDevice();
    return reply(404);
  };
  return { fetch, log };
}

async function apiChecks(check) {
  const world = { devices: [{ id: 'phone1', name: 'Phone', type: 'Smartphone', is_active: false }, { id: 'pc1', name: 'Web Player (Lumen)', type: 'Computer', is_active: false }], active: '' };
  const api = fakeApi(world);
  const secrets = new Map([['spotify', 'REFRESH']]);
  const id = 'wapi00001';
  const w = createWidgets({ readSettings: () => ({ homeWidgets: [{ id, type: 'spotify', mode: 'api', clientId: CLIENT, art: false, x: 0, y: 0, w: 4, h: 3 }] }), writeSettings: () => {}, fetch: api.fetch, getSecret: (n) => secrets.get(n) || null, setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}) });
  await w.refresh(w.list()[0]);
  const since = (n) => api.log.slice(n).map((l) => `${l.method} ${l.path}`);

  let n = api.log.length;
  const played = await w.act({ id, do: 'play' });
  check('api mode: Play with no active device asks for the account\'s devices and plays on this computer\'s (not only "No active Spotify device")', played === true && JSON.stringify(since(n)) === '["PUT /v1/me/player/play","GET /v1/me/player/devices","PUT /v1/me/player/play?device_id=pc1"]' && world.active === 'pc1' && !w.cache.get(id).data.notice, JSON.stringify([since(n), w.cache.get(id).data.notice]));

  world.active = '';
  await sleep(800); // (the follow-up fetch the action scheduled)
  n = api.log.length;
  const skipped = await w.act({ id, do: 'next' });
  const transfer = api.log.find((l, i) => i >= n && l.method === 'PUT' && l.path === '/v1/me/player');
  check('api mode: Next with no active device moves playback to a device (PUT /me/player, play) and presses Next again there', skipped === true && JSON.stringify(since(n)) === '["POST /v1/me/player/next","GET /v1/me/player/devices","PUT /v1/me/player","POST /v1/me/player/next"]' && JSON.stringify(JSON.parse(transfer.body)) === '{"device_ids":["pc1"],"play":true}', JSON.stringify(since(n)));

  world.active = '';
  await sleep(800);
  n = api.log.length;
  await w.act({ id, do: 'pause' });
  check('api mode: Pause with no active device wakes nothing (there is nothing to pause)', JSON.stringify(since(n)) === '["PUT /v1/me/player/pause"]' && /No active Spotify device/.test(w.cache.get(id).data.notice || ''), JSON.stringify(since(n)));

  world.devices = [{ id: 'tv1', name: 'TV', type: 'TV', is_restricted: true }];
  await sleep(800);
  await w.refresh(w.list()[0], { force: true });
  n = api.log.length;
  const none = await w.act({ id, do: 'play' });
  check('api mode: with only restricted devices (or none), the card says no device is active, and nothing else is called', none === false && JSON.stringify(since(n)) === '["PUT /v1/me/player/play","GET /v1/me/player/devices"]' && /No active Spotify device/.test(w.cache.get(id).data.notice || ''), JSON.stringify([since(n), w.cache.get(id).data.notice]));

  check('api helpers: the active device wins, then a computer, then any; restricted and malformed ids are skipped', SV.pickDevice(JSON.stringify({ devices: [{ id: 'a', type: 'Computer' }, { id: 'b', is_active: true }] })) === 'b' && SV.pickDevice(JSON.stringify({ devices: [{ id: 'p', type: 'Smartphone' }, { id: 'c', type: 'Computer' }] })) === 'c' && SV.pickDevice(JSON.stringify({ devices: [{ id: 'x y', type: 'Computer' }, { id: 'r', is_restricted: true }] })) === '' && SV.pickDevice('nope') === '', '');
  check('api helpers: only play, next and previous wake a device, and the id goes into the address escaped', SV.deviceRequest('play', 'pc1').path === '/me/player/play?device_id=pc1' && SV.deviceRequest('next', 'pc1').retry === true && SV.deviceRequest('pause', 'pc1') === null && SV.deviceRequest('play', '../x') === null, '');
  check('api helpers: "no active device" is the NO_ACTIVE_DEVICE reason or a bare 404, never a Premium or other refusal', SV.noActiveDevice(404, '{"error":{"reason":"NO_ACTIVE_DEVICE"}}') && SV.noActiveDevice(404, '') && !SV.noActiveDevice(403, '{"error":{"reason":"PREMIUM_REQUIRED"}}') && !SV.noActiveDevice(500, ''), '');
}

function cardChecks(check) {
  const at = 1e12;
  const card = (o = {}, d = {}) => ({ id: 'wsp000001', type: 'spotify', title: 'Spotify', span: 3, layout: { x: 0, y: 0, w: 4, h: 3 }, updated: at, ...o, data: { mode: 'status', state: 'playing', title: 'Night Shift', artist: 'Ann', progressMs: 31000, durationMs: 200000, at, results: [], ...d } });
  const k = (w) => CK.cardKey(w);
  check('card: a playing card read again 4 s later (a new stamp, the playhead moved on with it) is the same card: not drawn again', CK.sameCard(k(card()), k(card({ updated: at + 4000 }, { at: at + 4000, progressMs: 35000 }))), '');
  check('card: …a second of drift either way is still the same', CK.sameCard(k(card()), k(card({}, { at: at + 4000, progressMs: 36000 }))) && CK.sameCard(k(card()), k(card({}, { at: at + 4000, progressMs: 34000 }))), '');
  check('card: a seek (the playhead jumped), a new song, pause, search results or a notice draw it again', !CK.sameCard(k(card()), k(card({}, { at: at + 4000, progressMs: 90000 }))) && !CK.sameCard(k(card()), k(card({}, { title: 'Other' }))) && !CK.sameCard(k(card()), k(card({}, { state: 'paused' }))) && !CK.sameCard(k(card()), k(card({}, { results: [{ id: 'a', title: 'A' }] }))) && !CK.sameCard(k(card()), k(card({}, { notice: 'No active Spotify device.' }))), '');
  check('card: paused, a new stamp with the playhead where it was is the same card; moved, it is not', CK.sameCard(k(card({}, { state: 'paused' })), k(card({}, { state: 'paused', at: at + 9000 }))) && !CK.sameCard(k(card({}, { state: 'paused' })), k(card({}, { state: 'paused', progressMs: 60000 }))), '');
  check('card: a new place or size is applied to the card as it is (never a reason to draw it again)', CK.sameCard(k(card()), k(card({ span: 6, layout: { x: 4, y: 2, w: 6, h: 4 } }))), '');
  check('card: any other kind of card is drawn again whenever its data differs (its stamp is not special)', !CK.sameCard(k({ id: 'w1', type: 'weather', data: { at: 1 } }), k({ id: 'w1', type: 'weather', data: { at: 2 } })) && CK.sameCard(k({ id: 'w1', type: 'weather', data: { at: 1 } }), k({ id: 'w1', type: 'weather', data: { at: 1 } })), '');
  check('card: a key forced empty by the page (a calendar\'s minute redraw) is never the same', !CK.sameCard('', k(card())) && !CK.sameCard(null, k(card())), '');

  // The page itself (no DOM here: what the source says).
  const root = path.join(__dirname, '..', 'src', 'renderer');
  const html = fs.readFileSync(path.join(root, 'newtab.html'), 'utf8');
  const widgetsJs = fs.readFileSync(path.join(root, 'newtab-widgets.js'), 'utf8');
  const gridJs = fs.readFileSync(path.join(root, 'newtab-widgets-grid.js'), 'utf8');
  check('page: the card key script loads before the widgets script that uses it', html.indexOf('../features/widget-card-key.js') > 0 && html.indexOf('../features/widget-card-key.js') < html.indexOf('<script src="newtab-widgets.js">'), '');
  check('page: a card drawn again takes over the old card\'s place on the grid (transform, size) before it replaces it, so it does not slide in from the corner', /card\.style\.transform = kept\.el\.style\.transform;[\s\S]{0,200}card\._pos = kept\.el\._pos;[\s\S]{0,40}kept\.el\.replaceWith\(card\)/.test(widgetsJs) && /WidgetCardKey\.sameCard\(kept\.key, key\)/.test(widgetsJs), '');
  check('page: a card placed for the first time appears in place (no transition while it gets its first position)', /if \(!card\._pos\) \{[\s\S]{0,200}w-placing/.test(gridJs) && /, \.w-card\.w-placing \{ transition: none; \}/.test(html), '');
}

module.exports = async function musicCardUnits(check) {
  await engineChecks(check);
  webPlayerChecks(check);
  await apiChecks(check);
  cardChecks(check);
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } else console.log(`PASS ${name}`); })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
