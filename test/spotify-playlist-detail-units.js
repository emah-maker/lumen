// The songs of a playlist opened in the Spotify card's Library (features/spotify-library.js), against a fake Web API and a fake player page. The bug this guards: a playlist the
// account follows but does not own (Spotify answers 403 for its songs since February 2026) opened with its header and no songs, "Couldn't read this part of your library", and
// Try again asked the same refused question. Now: the songs are read from the player's own page of the playlist; a failure says WHICH cause (signed out, Spotify changed its page,
// too slow, not shared, rate limit, offline) and is logged with the [spotify] prefix; Try again really asks again. Also: pages of 50 (76 songs), null/removed entries, episodes,
// local files, a later page failing, a throw while reading. No real network. Runs on its own (npm run test:units picks up test/*-units.js).
'use strict';
const { createWidgets } = require('../src/features/widgets');
const SV = require('../src/features/spotify-view');

const CLIENT = '0123456789abcdef0123456789abcdef';
const reply = (status, body) => new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status });
const img = (id) => [{ url: `https://i.scdn.co/image/${id}`, width: 300, height: 300 }];
const track = (n) => ({ id: `T${n}`, type: 'track', name: `Song ${n}`, duration_ms: 180000 + n, artists: [{ name: `Artist ${n % 7}` }], album: { name: `Album ${n % 5}`, images: img(`t${n}`) } });
const playlist = (id, name, owner, total) => ({ id, type: 'playlist', name, owner: { id: owner, display_name: owner }, images: [{ url: `https://mosaic.scdn.co/640/${id}`, width: null, height: null }], items: { total } });

function fakeApi(world) {
  const log = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    if (u.host === 'i.scdn.co' || u.host === 'mosaic.scdn.co') return new Response(Buffer.alloc(10), { status: 200 });
    if (u.host === 'accounts.spotify.com') return reply(200, { access_token: 'TOKEN', token_type: 'Bearer', expires_in: 3600 });
    if (u.host !== 'api.spotify.com') return reply(404);
    const p = u.pathname.replace(/^\/v1/, '');
    log.push(`${method} ${p}${u.search}`);
    const off = Number(u.searchParams.get('offset') || 0);
    if (p === '/me') return reply(200, { id: 'ME1' });
    if (p === '/me/tracks') return reply(200, { items: [], total: 0 });
    if (p === '/me/player/devices') return reply(200, { devices: [] });
    if (p === '/me/player') return reply(204);
    if (p === '/me/player/play') { world.plays = (world.plays || []).concat(opts.body); return reply(204); }
    if (p === '/me/playlists') {
      const all = [playlist('FOLLOW', 'Best of Fakemink', 'Sumi', 76), playlist('PAGED', 'Seventy-six', 'me', 76), playlist('MIXED', 'Mixed bag', 'me', 60), playlist('LATE', 'Page two fails', 'me', 120), playlist('THROWS', 'Odd answer', 'me', 5), playlist('STATUS', 'Status', 'Sumi', 9)];
      return reply(200, { items: all, total: all.length, next: null });
    }
    const m = /^\/playlists\/(\w+)\/items$/.exec(p);
    if (m) {
      const id = m[1];
      world.itemCalls = (world.itemCalls || 0) + 1;
      if (id === 'FOLLOW') return world.followStatus === 200 ? reply(200, { href: 'x', total: 76 }) : world.followStatus === 'empty' ? reply(200, { items: [], total: 76 }) : reply(world.followStatus || 403, { error: { status: world.followStatus || 403, message: 'Forbidden' } });
      if (id === 'PAGED') { // 76 songs: 50 then 26, a `next` on the first page; entry 7 has no song (removed), 9 is an episode, 11 a local file
        const items = Array.from({ length: Math.max(0, Math.min(50, 76 - off)) }, (_, i) => { const n = off + i; return n === 7 ? { item: null } : n === 9 ? { item: { id: 'EP1', type: 'episode', name: 'An episode' } } : n === 11 ? { item: { id: null, type: 'track', name: 'A local file', is_local: true, artists: [], album: {} } } : { item: track(n) }; });
        return reply(200, { items, total: 76, next: off + 50 < 76 ? `https://api.spotify.com/v1/playlists/PAGED/items?offset=${off + 50}&limit=50` : null });
      }
      if (id === 'MIXED') return reply(200, { items: [{ track: track(0) }, null, { item: undefined }, { item: { ...track(1), id: undefined } }, 'junk', { item: track(2) }], total: 6 }); // (older `track` key; nulls)
      if (id === 'LATE') return off === 0 ? reply(200, { items: Array.from({ length: 50 }, (_, i) => ({ item: track(i) })), total: 120 }) : reply(503, 'busy');
      if (id === 'THROWS') return new Response('<html>not json</html>', { status: 200 });
      if (id === 'STATUS') return world.status === 'offline' ? Promise.reject(new Error('connect ECONNREFUSED')) : reply(world.status || 500, { error: { status: world.status || 500, message: 'x' } });
    }
    return reply(404);
  };
  return { fetch, log };
}

async function make(world, { engine = null, mode = 'status' } = {}) {
  const api = fakeApi(world);
  const id = 'wpld0000001';
  const w = createWidgets({
    readSettings: () => ({ homeWidgets: [{ id, type: 'spotify', mode, clientId: CLIENT, art: false, x: 0, y: 0, w: 8, h: 8 }] }), writeSettings: () => {},
    fetch: api.fetch, getSecret: () => 'REFRESH', setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}),
    rateMax: () => 1e6, searchRateMax: () => 1e6, spotifyEngine: engine, resizeThumb: () => null, t: (k) => k,
  });
  const act = async (a) => { if (!w.cache.get(id)) await w.refresh(w.list()[0], { force: true }); await w.act({ id, ...a }); return w.cache.get(id).data; };
  return { w, id, api, act, data: () => w.cache.get(id).data };
}
const engineOf = (readItem) => ({ read: async () => ({ mode: 'status', state: 'idle', title: '', artist: '', album: '', progressMs: 0, durationMs: 0, at: Date.now(), source: 'engine', kind: 'none', reason: '', art: '', signedIn: true, can: { search: true } }), warm: () => {}, command: () => true, ...(readItem ? { readItem } : {}) });
const pageRows = (n) => Array.from({ length: n }, (_, i) => ({ id: `P${i}`, kind: 'song', title: `Page song ${i}`, sub: `Artist ${i}`, album: 'Alb', ms: 1000 * (i + 1), art: `https://i.scdn.co/image/p${i}` }));

module.exports = async function spotifyPlaylistDetailUnits(check) {
  const realWarn = console.warn;
  let logged = [];
  console.warn = (...a) => { logged.push(a.join(' ')); };
  try {
    // ---- the cause: a followed playlist, 403 ----
    {
      const reads = [];
      const world = {};
      const t = await make(world, { engine: engineOf(async (kind, id) => { reads.push([kind, id]); return { ok: true, why: '', detail: '', title: 'Best of Fakemink', items: pageRows(76), partial: false }; }) });
      await t.act({ do: 'elib', arg: 'init' });
      let d = await t.act({ do: 'edetail', kind: 'playlist', item: 'FOLLOW' });
      let det = d.lib2.detail;
      check('followed playlist (Web API 403 for its songs): the songs are read from the player\'s page of it, all 76, in order, nothing failed', det.ok === true && det.why === '' && det.items.length === 76 && det.items[0].title === 'Page song 0' && det.items[75].pos === 75 && det.done === true && det.truncated === false, JSON.stringify([det.ok, det.why, det.items.length, det.done]));
      check('...the header facts stay what the library said (by Sumi, 76 songs) and the page was asked for that playlist only', det.sub === 'Sumi' && det.count === 76 && det.total === 76 && JSON.stringify(reads) === JSON.stringify([['playlist', 'FOLLOW']]), JSON.stringify([det.sub, det.total, reads]));
      check('...the 403 and the fallback are logged with the [spotify] prefix, with the cause', logged.some((l) => l.startsWith('[spotify] playlist FOLLOW:') && /answered 403/.test(l) && /player's page/.test(l)), logged.join(' | '));
      check('...the rows have pictures to ask for (the page\'s own addresses) and no field the card should not get', det.items.every((r) => !('images' in r)) && det.items[3].album === 'Alb' && det.items[3].ms === 4000, JSON.stringify(det.items[3]));
      const calls = t.api.log.length;
      await t.act({ do: 'edetail', kind: 'playlist', item: 'FOLLOW' });
      check('...opened again within two minutes it is not read again (neither the Web API nor the page)', t.api.log.length === calls && reads.length === 1, '');
      await t.act({ do: 'eplay', kind: 'playlist', item: 'FOLLOW', pos: 3, with: 'P3' });
      check('...Play works, and a song of such a list starts at that song (its uri), since the places on the page may not be Spotify own', Boolean(world.plays) && world.plays.length === 1 && world.plays[0] === '{"context_uri":"spotify:playlist:FOLLOW","offset":{"uri":"spotify:track:P3"}}', JSON.stringify(world.plays));
      check('playContext with a song starts the context at that song\'s uri; with a place at the place; with neither at the start', JSON.stringify(SV.PLAYER.playContext('playlist', 'PL', 3, 'P3')[2]) === '{"context_uri":"spotify:playlist:PL","offset":{"uri":"spotify:track:P3"}}' && JSON.stringify(SV.PLAYER.playContext('playlist', 'PL', 3)[2]) === '{"context_uri":"spotify:playlist:PL","offset":{"position":3}}' && JSON.stringify(SV.PLAYER.playContext('playlist', 'PL')[2]) === '{"context_uri":"spotify:playlist:PL"}' , '');
    }
    // 200 without `items` (Spotify leaving the songs out), or total > 0 and an empty first page: the same fallback
    for (const [label, status] of [['an answer with no `items` list', 200], ['an empty first page for a playlist with songs', 'empty']]) {
      const world = { followStatus: status };
      const t = await make(world, { engine: engineOf(async () => ({ ok: true, items: pageRows(3), partial: false })) });
      await t.act({ do: 'elib', arg: 'init' });
      const det = (await t.act({ do: 'edetail', kind: 'playlist', item: 'FOLLOW' })).lib2.detail;
      check(`followed playlist, Web API sends ${label}: the player's page is used`, det.ok === true && det.items.length === 3, JSON.stringify([det.ok, det.why, det.items.length]));
    }
    {
      const world = { followStatus: 404 };
      const t = await make(world, { engine: engineOf(async () => ({ ok: true, items: pageRows(2), partial: false })) });
      await t.act({ do: 'elib', arg: 'init' });
      const det = (await t.act({ do: 'edetail', kind: 'playlist', item: 'FOLLOW' })).lib2.detail;
      check('a playlist the Web API answers 404 for (Spotify\'s own mixes) is read from the page too', det.ok === true && det.items.length === 2, JSON.stringify([det.ok, det.why]));
    }
    {
      // a partial page read (too slow to finish) shows what it got and says so
      const t = await make({}, { engine: engineOf(async () => ({ ok: true, items: pageRows(40), partial: true })) });
      await t.act({ do: 'elib', arg: 'init' });
      const det = (await t.act({ do: 'edetail', kind: 'playlist', item: 'FOLLOW' })).lib2.detail;
      check('a page read that ran out of time keeps its 40 songs and marks the list as cut (the card says "Showing the first 40 songs")', det.ok === true && det.items.length === 40 && det.truncated === true && det.done === true, JSON.stringify([det.ok, det.items.length, det.truncated]));
    }

    // ---- the cause, said: each failure of the page and of the API ----
    const why = async (readItem, world = {}, item = 'FOLLOW', opts = {}) => {
      logged = [];
      const t = await make(world, readItem === null ? { engine: null, mode: 'api' } : { engine: engineOf(readItem), ...opts });
      await t.act({ do: 'elib', arg: 'init' });
      const det = (await t.act({ do: 'edetail', kind: 'playlist', item })).lib2.detail;
      return { det, t };
    };
    for (const [pageWhy, expect] of [['signedOut', 'signedOut'], ['noPlayer', 'changed'], ['page', 'changed'], ['timeout', 'slow'], ['missing', 'missing'], ['noPanel', 'changed']]) {
      const { det } = await why(async () => ({ ok: false, why: pageWhy, detail: 'path /playlist/FOLLOW, 0 song rows', items: [] }));
      check(`player page says ${pageWhy}: the card says ${expect} (not one general failure), and the log has both the API's and the page's side`, det.ok === false && det.why === expect && det.done === true && logged.some((l) => l.startsWith('[spotify] library playlist FOLLOW:') && l.includes(`${expect} (`) && /answered 403/.test(l) && l.includes(pageWhy)), JSON.stringify([det.ok, det.why, logged.at(-1)]));
    }
    {
      const { det } = await why(async () => { throw new Error('the page went away'); });
      check('a page read that throws is a failure with a cause (changed), never a card stuck loading', det.ok === false && det.why === 'changed' && det.loading === false, JSON.stringify([det.ok, det.why, det.loading]));
    }
    {
      const { det } = await why(null);
      check('a card with no player page to fall back on (Web API only): a followed playlist says forbidden ("Spotify doesn\'t share these songs with apps"), not a general failure', det.ok === false && det.why === 'forbidden', JSON.stringify([det.ok, det.why]));
    }
    for (const [status, expect] of [[429, 'rate'], [500, 'page'], [503, 'page'], ['offline', 'offline'], [401, 'scope']]) {
      const { det } = await why(async () => { throw new Error('the page must not be asked for this'); }, { status }, 'STATUS');
      check(`Web API ${status}: the cause is ${expect}${status === 429 || status === 500 || status === 503 || status === 'offline' ? ' and the player page is not asked (it is a problem of the moment, not of this playlist)' : ''}`, det.ok === false && det.why === expect && !logged.some((l) => /player's page instead/.test(l)), JSON.stringify([det.ok, det.why]));
    }
    check('SV.failureWhy: scope, forbidden, missing, rate, big, offline, page, and nothing for an ok answer', SV.failureWhy({ ok: false, status: 403, body: '{"error":{"status":403,"message":"Insufficient client scope"}}' }) === 'scope' && SV.failureWhy({ ok: false, status: 403, body: '{"error":{"message":"Forbidden"}}' }) === 'forbidden' && SV.failureWhy({ ok: false, status: 404, body: '' }) === 'missing' && SV.failureWhy({ ok: false, status: 429, body: '' }) === 'rate' && SV.failureWhy({ ok: false, status: 200, error: { why: 'big' } }) === 'big' && SV.failureWhy({ ok: false, status: 0 }) === 'offline' && SV.failureWhy({ ok: false, status: 418 }) === 'page' && SV.failureWhy({ ok: true, status: 200 }) === '', '');

    // ---- Try again really asks again ----
    {
      let pageCalls = 0;
      let answer = { ok: false, why: 'timeout', detail: 'slow', items: [] };
      const world = {};
      const t = await make(world, { engine: engineOf(async () => { pageCalls++; return answer; }) });
      await t.act({ do: 'elib', arg: 'init' });
      let det = (await t.act({ do: 'edetail', kind: 'playlist', item: 'FOLLOW' })).lib2.detail;
      check('Try again (setup): the first open failed as slow', det.ok === false && det.why === 'slow' && pageCalls === 1 && world.itemCalls === 1, JSON.stringify([det.why, pageCalls, world.itemCalls]));
      det = (await t.act({ do: 'edetail', kind: 'playlist', item: 'FOLLOW', force: true })).lib2.detail;
      check('Try again asks the Web API and the page again (a failure is never cached, force or not)', det.why === 'slow' && pageCalls === 2 && world.itemCalls === 2, JSON.stringify([pageCalls, world.itemCalls]));
      det = (await t.act({ do: 'edetail', kind: 'playlist', item: 'FOLLOW' })).lib2.detail;
      check('...and opening the playlist again without force asks again too (only a good read is kept)', pageCalls === 3 && world.itemCalls === 3, JSON.stringify([pageCalls, world.itemCalls]));
      answer = { ok: true, items: pageRows(5), partial: false };
      det = (await t.act({ do: 'edetail', kind: 'playlist', item: 'FOLLOW', force: true })).lib2.detail;
      check('...and when the page then answers, the songs replace the failure', det.ok === true && det.why === '' && det.items.length === 5 && det.loading === false, JSON.stringify([det.ok, det.why, det.items.length]));
    }

    // ---- paging, null entries, episodes, local files ----
    {
      const world = {};
      const t = await make(world, { engine: engineOf(async () => { throw new Error('not for a playlist the API can read'); }) });
      await t.act({ do: 'elib', arg: 'init' });
      let det = (await t.act({ do: 'edetail', kind: 'playlist', item: 'PAGED' })).lib2.detail;
      check('76 songs: the first page is 50 entries (47 songs: a removed entry, an episode and a local file are skipped) with more to come', det.ok === true && det.items.length === 47 && det.done === false && det.total === 76, JSON.stringify([det.items.length, det.done, det.total]));
      for (let i = 0; i < 3 && !det.done; i++) det = (await t.act({ do: 'edetail', kind: 'playlist', item: 'PAGED', more: true })).lib2.detail;
      check('...the second page (26 entries) completes it: 73 songs, each once, in order, the entries that are not songs keep their places (song 8 is at place 8, 10 at 10)', det.done === true && det.items.length === 73 && det.items[6].pos === 6 && det.items[7].pos === 8 && det.items[8].pos === 10 && det.items[9].pos === 12 && det.items.at(-1).pos === 75 && new Set(det.items.map((r) => r.pos)).size === 73 && world.itemCalls === 2, JSON.stringify([det.items.length, det.items.slice(6, 10).map((r) => r.pos), world.itemCalls]));
      check('...reading it never asked the player\'s page and logged nothing', !logged.some((l) => /PAGED/.test(l)), logged.join('|'));
      det = (await t.act({ do: 'edetail', kind: 'playlist', item: 'MIXED' })).lib2.detail;
      check('nulls, junk, a song without an id and the older `track` key in one page: the readable songs show (3 of 6 places), nothing throws, nothing fails', det.ok === true && det.items.map((r) => r.id).join() === 'T0,T2' && det.items[1].pos === 5 && det.done === true, JSON.stringify(det.items.map((r) => [r.id, r.pos])));
      det = (await t.act({ do: 'edetail', kind: 'playlist', item: 'LATE' })).lib2.detail;
      check('page one of two read (50 songs of 120)', det.ok === true && det.items.length === 50 && det.done === false, JSON.stringify([det.ok, det.items.length]));
      logged = [];
      det = (await t.act({ do: 'edetail', kind: 'playlist', item: 'LATE', more: true })).lib2.detail;
      check('the second page failing (503) keeps the 50 songs read, marks the list cut, and logs the cause — it does not blank the list with "Couldn\'t read"', det.ok === true && det.items.length === 50 && det.done === true && det.truncated === true && logged.some((l) => l.startsWith('[spotify] library playlist LATE') && /503/.test(l)), JSON.stringify([det.ok, det.items.length, det.truncated, logged]));
      det = (await t.act({ do: 'edetail', kind: 'playlist', item: 'THROWS' })).lib2.detail;
      check('an answer that is not JSON at all is a failure with a cause (not usable, so the player page is tried; here it throws: changed), logged, and the card is not left loading', det.ok === false && det.why === 'changed' && det.loading === false && det.done === true && logged.some((l) => /THROWS/.test(l)), JSON.stringify([det.ok, det.why, det.loading]));
    }
    // ---- a throw while reading never leaves the card loading ----
    {
      const t = await make({}, { engine: engineOf(null) });
      await t.act({ do: 'elib', arg: 'init' });
      const real = SV.normalizeTrackPage;
      SV.normalizeTrackPage = () => { throw new Error('boom'); };
      let det;
      try { det = (await t.act({ do: 'edetail', kind: 'playlist', item: 'PAGED' })).lib2.detail; } finally { SV.normalizeTrackPage = real; }
      check('a throw while reading the songs ends as a failure (not "loading" for ever), logged with [spotify]', det.ok === false && det.loading === false && logged.some((l) => l.startsWith('[spotify] library playlist PAGED') && /boom/.test(l)), JSON.stringify([det.ok, det.loading, logged.at(-1)]));
      det = (await t.act({ do: 'edetail', kind: 'playlist', item: 'PAGED', force: true })).lib2.detail;
      check('...and Try again then works', det.ok === true && det.items.length === 47, JSON.stringify([det.ok, det.items.length]));
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
