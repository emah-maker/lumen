// The Spotify card's Library, like Spotify's: Liked Songs first, then ALL the account's playlists (every page, read as the card scrolls), saved albums and followed
// artists behind filter chips; a playlist, album, artist or Liked Songs opened in the card with its songs read page by page; a row played inside its list (context plus
// offset) so what follows is the list's next songs. Every call is a fixed Web API call (features/spotify-view.js PLAYER) through the card's own `call`; nothing here
// fetches by itself. features/spotify-api-card.js hands in its helpers (ask, pic, keepImages, wakeAndRetry) and exposes this through the card's actions:
//   elib    arg: init | playlists | albums | artists, more=1  -> the first / next page of a list
//   edetail kind (playlist | album | liked | artist), arg id, more=1, force -> the opened list's first / next page of songs
//   eplay   kind, arg id, pos, with, shuffle -> play a list or a row of it
// Card data: libV2 (true), libText (words, locales/en.json spotify.library.*), lib2 { likedTotal, lists: { playlists, albums, artists }, detail }.
'use strict';

const SV = require('./spotify-view');
const { PLAYER } = SV;

const MAX_ROWS = 1000; // songs kept of one opened list (the card says so when a list is longer)
const MAX_LIST_ROWS = 2000; // rows kept of one library list
const DETAIL_TTL_MS = 2 * 60e3; // an opened list is read again only when asked for after this
const MAX_DETAILS = 4;
const LISTS = ['playlists', 'albums', 'artists'];
const KINDS = ['playlist', 'album', 'liked', 'artist'];

// The library's words (locales/en.json: spotify.library.<key>); {title}, {n} and {total} are replaced by the card.
const LIB_STRINGS = {
  filter: 'Filter your library', filterLabel: 'Filter your library', chips: 'Show', chipPlaylists: 'Playlists', chipAlbums: 'Albums', chipArtists: 'Artists',
  liked: 'Liked Songs', likedSub: '{n} songs', songs: '{n} songs', open: 'Open {title}', loading: 'Loading…', loadingMore: 'Loading more…', retry: 'Try again',
  empty: 'Nothing here yet.', noMatch: 'Nothing in your library matches that.', failed: 'Couldn’t read this part of your library.', scope: 'Reconnect Spotify to show your library.', reconnectButton: 'Reconnect Spotify',
  back: 'Back', backLabel: 'Back to your library', play: 'Play', shuffle: 'Shuffle', playLabel: 'Play {title}', shuffleLabel: 'Shuffle {title}', by: 'By {title}',
  trackPlay: 'Play {title} from {list}', trackQueue: 'Add {title} to the queue', queue: 'Queue', albums: 'Albums', topSongs: 'Top songs', noTop: 'Spotify no longer shares an artist’s top songs with apps.',
  truncated: 'Showing the first {n} songs.', header: '#', playsFrom: 'Plays from {title}', artist: 'Artist', album: 'Album', playlist: 'Playlist',
};

function make(h) {
  const { ask, keepImages, wakeAndRetry, bare } = h;
  const flat = (req) => [req[0], req[1], req[2]];
  const failed = (res) => (SV.scopeError(res.status, res.body) ? 'scope' : res.error?.why === 'big' ? 'big' : 'page');

  const lib = (ui) => (ui.lib2 ||= { lists: {}, likedTotal: null, userId: '', details: {}, open: '', at: 0 });
  const listOf = (ui, kind) => (lib(ui).lists[kind] ||= { items: [], next: '', done: false, loading: false, ok: true, why: '', total: null, at: 0 });

  // ---- the lists ----
  const REQ = { playlists: () => PLAYER.libPlaylists(), albums: () => PLAYER.libAlbums(), artists: () => PLAYER.libArtists() };
  const NORM = { playlists: SV.normalizePlaylists, albums: SV.normalizeAlbums, artists: SV.normalizeFollowing };
  const WHAT = { playlists: 'library', albums: 'albums', artists: 'following' };
  // One page of a list: the first, or the next (more). A list is read one page at a time; two asks for the same page share it.
  async function loadList(call, ui, kind, ctx, more = false) {
    const l = listOf(ui, kind);
    if (l.loading) return;
    if (more && (l.done || !l.next)) return;
    if (!more && l.at && !ctx.force && l.ok && ctx.now() - l.at < DETAIL_TTL_MS) return;
    l.loading = true;
    ctx.onPart?.();
    const req = more ? ['GET', l.next] : REQ[kind]();
    const res = await ask(call, ui, req, WHAT[kind]).catch((err) => ({ ok: false, status: 0, body: '', error: err }));
    l.loading = false;
    l.at = ctx.now();
    if (!res.ok) { l.ok = false; l.why = failed(res); if (!more) { l.items = []; l.done = true; } ctx.onPart?.(); return; }
    l.ok = true;
    l.why = '';
    const rows = keepImages(ui, NORM[kind](res.body));
    for (const r of rows) { const t = ui.libThumbs?.get(`${r.kind}:${r.id}`); if (t) r.thumb = t; }
    const have = new Set((more ? l.items : []).map((r) => r.id));
    l.items = (more ? l.items : []).concat(rows.filter((r) => !have.has(r.id))).slice(0, MAX_LIST_ROWS);
    l.next = SV.nextPath(res.body);
    l.done = !l.next || l.items.length >= MAX_LIST_ROWS;
    l.total = SV.totalOf(res.body) ?? l.total;
    ctx.onPart?.();
  }
  // Liked Songs' count (one tiny request): the row pinned first in the list.
  async function loadLikedTotal(call, ui, ctx) {
    const s = lib(ui);
    if (s.likedTotal !== null && !ctx.force) return;
    const res = await ask(call, ui, ['GET', '/me/tracks?limit=1'], 'liked').catch(() => ({ ok: false, status: 0, body: '' }));
    if (res.ok) s.likedTotal = SV.totalOf(res.body) ?? 0;
    else if (SV.scopeError(res.status, res.body)) s.likedScope = true;
    ctx.onPart?.();
  }
  async function init(call, ui, ctx) {
    await Promise.all([loadList(call, ui, 'playlists', ctx), loadLikedTotal(call, ui, ctx)]);
  }

  // ---- an opened list ----
  const keyOf = (kind, id) => `${kind}:${id}`;
  function knownRow(ui, kind, id) {
    const l = lib(ui).lists[kind === 'playlist' ? 'playlists' : kind === 'album' ? 'albums' : 'artists'];
    return l ? l.items.find((r) => r.id === id) || null : null;
  }
  const detailOf = (ui, kind, id) => lib(ui).details[keyOf(kind, id)];
  async function loadDetail(call, ui, kind, id, ctx, more = false) {
    const s = lib(ui);
    const key = keyOf(kind, id);
    s.open = key;
    let d = s.details[key];
    if (!d) {
      const row = knownRow(ui, kind, id);
      d = s.details[key] = { kind, id, title: row?.title || '', sub: row?.sub || '', count: row?.count ?? (kind === 'liked' ? s.likedTotal : null), total: null, items: [], offset: 0, done: false, loading: false, ok: true, why: '', at: 0, sections: null, cover: row ? ui.libImages?.[`${row.kind}:${row.id}`] || [] : [] };
      const keys = Object.keys(s.details);
      if (keys.length > MAX_DETAILS) for (const k of keys.filter((x) => x !== key).sort((a, b) => s.details[a].at - s.details[b].at).slice(0, keys.length - MAX_DETAILS)) delete s.details[k];
    }
    if (d.loading) return;
    if (more) { if (d.done) return; } else if (d.at && d.ok && !ctx.force && ctx.now() - d.at < DETAIL_TTL_MS) { ctx.onPart?.(); return; }
    d.loading = true;
    if (!more) { d.items = []; d.offset = 0; d.done = false; d.sections = null; }
    ctx.onPart?.();
    if (kind === 'artist') await loadArtist(call, ui, d, ctx);
    else {
      const req = kind === 'playlist' ? PLAYER.playlistPage(id, d.offset) : kind === 'album' ? PLAYER.albumPage(id, d.offset) : PLAYER.likedPage(d.offset);
      const res = await ask(call, ui, req, kind === 'liked' ? 'liked' : 'library').catch((err) => ({ ok: false, status: 0, body: '', error: err }));
      d.at = ctx.now();
      if (!res.ok) { d.ok = false; d.why = failed(res); d.done = true; }
      else {
        const page = SV.normalizeTrackPage(kind, res.body, d.offset, d.cover);
        d.ok = true;
        d.why = '';
        d.total = page.total;
        if (kind === 'liked') s.likedTotal = page.total;
        const rows = keepImages(ui, page.items);
        for (const r of rows) { const t = ui.libThumbs?.get(`${r.kind}:${r.id}`); if (t) r.thumb = t; }
        d.items = d.items.concat(rows);
        d.offset += page.raw;
        d.done = page.raw === 0 || d.offset >= page.total || d.items.length >= MAX_ROWS;
        d.truncated = d.items.length >= MAX_ROWS && d.offset < page.total;
      }
    }
    d.loading = false;
    ctx.onPart?.();
  }
  // An artist: the top songs (Spotify removed that endpoint for new apps in February 2026: then there are none and the card says so) and the albums.
  async function loadArtist(call, ui, d, ctx) {
    const [top, albums] = await Promise.all([
      ask(call, ui, PLAYER.artistTop(d.id), 'library').catch((err) => ({ ok: false, status: 0, body: '', error: err })),
      ask(call, ui, PLAYER.artistAlbums(d.id), 'library').catch((err) => ({ ok: false, status: 0, body: '', error: err })),
    ]);
    d.at = ctx.now();
    d.ok = albums.ok || top.ok;
    d.why = d.ok ? '' : failed(albums);
    d.sections = {
      topOk: top.ok,
      top: top.ok ? keepImages(ui, SV.normalizeArtistTop(top.body)) : [],
      albums: albums.ok ? keepImages(ui, SV.normalizeArtistAlbums(albums.body)) : [],
    };
    d.done = true;
  }

  // ---- playing ----
  async function userId(call, ui) {
    const s = lib(ui);
    if (s.userId) return s.userId;
    const res = await ask(call, ui, PLAYER.me(), 'liked').catch(() => ({ ok: false }));
    if (res.ok) s.userId = SV.normalizeMeId(res.body);
    return s.userId;
  }
  // Play a list (from its start, shuffled) or a row of it. -> the API's answer; throws what the user should read through `fail`.
  async function play(call, ui, a, cached, { fail, noDevice, warm }) {
    if (!KINDS.includes(a.kind) || !SV.SAFE_ID.test(a.item || '')) return false;
    const key = keyOf(a.kind, a.item);
    const d = lib(ui).details[key];
    const hasPos = Number.isInteger(a.pos) && a.pos >= 0 && a.pos < 1e5;
    const row = hasPos && d ? d.items.find((r) => r.pos === a.pos) : null;
    if (hasPos && a.kind !== 'artist' && (!row || (a.with && row.id !== a.with))) throw new Error('The list changed. Look again.');
    warm?.();
    if (a.shuffle) {
      const sh = await call(...flat(PLAYER.shuffle(true)));
      if (!sh.ok && !noDevice(sh)) fail(sh, 'shuffle'); else if (sh.ok) cached.shuffle = true;
    }
    let make;
    if (a.kind === 'liked') {
      const uid = await userId(call, ui);
      make = uid ? () => PLAYER.playLiked(uid, hasPos ? a.pos : 0) : null;
    } else if (a.kind === 'artist') make = () => PLAYER.playContext('artist', a.item);
    else make = () => PLAYER.playContext(a.kind, a.item, hasPos ? a.pos : undefined);
    let res = make ? await call(...flat(make())) : { ok: false, status: 400, body: '' };
    if (!res.ok && noDevice(res) && make) {
      res = await wakeAndRetry(call, make);
      // Play as Lumen: the hidden player was only just started and is not yet one of the account's devices: give it a moment, then ask once more.
      if (!res.ok && noDevice(res) && warm) { await new Promise((r) => setTimeout(r, 2500)); res = await wakeAndRetry(call, make); }
    }
    // Liked Songs' collection context is refused (a different uri scheme for this account, or an old app): the songs read so far play as a list, from this one.
    if (!res.ok && a.kind === 'liked' && d && d.items.length && !noDevice(res)) {
      const at = Math.max(0, d.items.findIndex((r) => r.pos === (hasPos ? a.pos : 0)));
      const slice = d.items.slice(at, at + 100);
      res = await call(...flat(PLAYER.playUris(slice.map((r) => r.id), 0)));
    }
    fail(res, 'play');
    return true;
  }

  // ---- what the card is given ----
  function fields(ui, text) {
    const s = ui && ui.lib2;
    if (!ui) return null;
    const out = { libV2: true };
    if (text) out.libText = text;
    if (!s) return out;
    const lists = {};
    for (const k of LISTS) { const l = s.lists[k]; if (l) lists[k] = { items: l.items, done: l.done, loading: l.loading, ok: l.ok, why: l.why, total: l.total }; }
    const d = s.open ? s.details[s.open] : null;
    out.lib2 = {
      likedTotal: s.likedTotal, likedScope: s.likedScope === true, lists,
      detail: d ? { kind: d.kind, id: d.id, title: d.title, sub: d.sub, count: d.count, total: d.total, items: d.items, done: d.done, loading: d.loading, ok: d.ok, why: d.why, truncated: d.truncated === true, sections: d.sections } : null,
    };
    return out;
  }
  // The rows whose pictures can be asked for (the library lists, the opened list's songs and its artist sections).
  function* rows(ui) {
    const s = ui && ui.lib2;
    if (!s) return;
    for (const k of LISTS) if (s.lists[k]) yield* s.lists[k].items;
    const d = s.open ? s.details[s.open] : null;
    if (d) { yield* d.items; if (d.sections) { yield* d.sections.top; yield* d.sections.albums; } }
  }

  // ---- the card's actions ----
  async function act(call, action, ctx) {
    const { ui } = ctx;
    switch (action.do) {
      case 'elib': {
        if (action.arg === 'init') { await init(call, ui, { ...ctx, force: action.force === true }); return { local: true }; }
        if (!LISTS.includes(action.arg)) return false;
        await loadList(call, ui, action.arg, { ...ctx, force: action.force === true }, action.more === true);
        return { local: true };
      }
      case 'edetail': {
        if (!KINDS.includes(action.kind) || !SV.SAFE_ID.test(action.item || '')) return false;
        await loadDetail(call, ui, action.kind, action.item, { ...ctx, force: action.force === true }, action.more === true);
        return { local: true };
      }
      default: return false;
    }
  }
  return { act, play, fields, rows, loadDetail, loadList, init, lib, detailOf, bare };
}

module.exports = { make, LIB_STRINGS, KINDS, LISTS };
