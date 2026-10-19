// Recommendation shelves for the Spotify card's Home tab. Spotify closed its own recommendation endpoints to apps made after November 2024 (GET /recommendations,
// /artists/{id}/related-artists, /audio-features, the featured and category playlists, and the contents of Spotify-made playlists such as Discover Weekly and Daily Mix),
// and keeps them only for apps with extended access. So each is PROBED once per session (a failed answer is remembered; a network error is not) and used only when Spotify
// answers; where it does not, the shelves are built from endpoints that still work, and each says what it is built from (a caption). Nothing is invented:
//   recommended   "Recommended for you": GET /recommendations seeded from your top songs and artists          (needs the endpoint)
//   related       "Fans also like": GET /artists/{id}/related-artists of one of your top artists                (needs the endpoint)
//   newfrom       "New from artists you love": the newest albums and singles of your top and followed artists (GET /artists/{id}/albums)
//   moretop       "More from your top artists": their top songs you have not saved (GET /artists/{id}/top-tracks, GET /me/library/contains)
//   genres        "Based on your genres": songs tagged with the genres of your top artists (GET /search?q=genre:"...")
//   genreartists  "Artists to try": artists in those genres you do not follow (GET /search?type=artist)
// The artists and genres taken rotate once a day (a seed from the date), so a shelf is not the same all week and costs the same each day. Requests go through the card's own call
// (the user's request budget); a shelf is loaded only when it scrolls into view.
'use strict';

const SV = require('./spotify-view');
const { PLAYER } = SV;

const DAY_MS = 86400e3;
const REC_TTL_MS = 30 * 60e3; // a recommendation shelf is read again after this (the lists it is built from are cached a minute)
const NEW_DAYS = 120; // "new": released within this many days
const MAX = SV.HOME_MAX;

// shelf key -> its words' keys (locales/en.json spotify.home.<key> and <key>Caption)
const KEYS = ['recommended', 'related', 'newfrom', 'moretop', 'genres', 'genreartists'];
const STRINGS = {
  recommended: 'Recommended for you', recommendedCaption: 'From Spotify, based on your top songs and artists.',
  related: 'Fans also like', relatedCaption: 'Artists like {title}, from Spotify.',
  newfrom: 'New from artists you love', newfromCaption: 'New albums and singles from your top and followed artists.',
  moretop: 'More from your top artists', moretopCaption: 'Top songs of artists you listen to, that are not in your saved songs yet.',
  genres: 'Based on your genres', genresCaption: 'Songs tagged “{title}”, a genre of your top artists.',
  genreartists: 'Artists to try', genreartistsCaption: 'Artists tagged “{title}” that you do not follow.',
};

function make(h) {
  const { ask, homeSource, busy } = h;
  const day = (ctx) => Math.floor(ctx.now() / DAY_MS);
  const rotate = (list, n) => (list.length ? list.slice(n % list.length).concat(list.slice(0, n % list.length)) : []);
  const failure = (res) => (SV.scopeError(res.status, res.body) ? 'scope' : busy(res) ? 'busy' : 'page');
  // A probe answer: true (Spotify answered), false (refused: 403, 404, or 401 on a public endpoint), null (not known: a rate limit, the network).
  const blockedStatus = (res) => res.status === 403 || res.status === 404;
  async function probe(call, ui, name, req, ctx) {
    const store = (ui.probes ||= {});
    if (store[name] && store[name].known) return store[name];
    const res = await ask(call, ui, req, 'recs').catch((err) => ({ ok: false, status: 0, body: '', error: err }));
    const out = { known: res.ok || blockedStatus(res), allowed: res.ok, res };
    if (out.known) store[name] = { known: true, allowed: res.ok, at: ctx.now() };
    return out;
  }
  // Your artists, most listened first: the top artists, then the ones you follow (each once).
  async function myArtists(call, ui, ctx) {
    const [top, fol] = await Promise.all([homeSource(call, ui, 'topartists', ctx), homeSource(call, ui, 'following', ctx)]);
    const seen = new Set();
    const out = [];
    for (const list of [top.ok ? top.data : [], fol.ok ? fol.data : []]) for (const a of list) if (!seen.has(a.id)) { seen.add(a.id); out.push(a); }
    return { artists: out, top: top.ok ? top.data : [], scope: !top.ok && top.why === 'scope' };
  }
  // What the Home's own shelves already show (your playlists, saved albums, followed and top artists, top songs, recent plays): a suggestion is never one of these.
  async function ownIds(call, ui, ctx) {
    const got = await Promise.all(['playlists', 'albums', 'following', 'topartists', 'toptracks', 'recent'].map((n) => homeSource(call, ui, n, ctx)));
    const own = new Set();
    const add = (list) => { for (const i of list || []) own.add(`${i.kind}:${i.id}`); };
    add(got[0].ok ? got[0].data : []); add(got[1].ok ? got[1].data : []); add(got[2].ok ? got[2].data : []); add(got[3].ok ? got[3].data : []); add(got[4].ok ? got[4].data : []);
    if (got[5].ok) { add(got[5].data.albums); add(got[5].data.tracks); }
    return own;
  }
  const fresh = (items, own) => { const seen = new Set(); return items.filter((i) => { const k = `${i.kind}:${i.id}`; if (own.has(k) || seen.has(k)) return false; seen.add(k); return true; }); };
  // Which of these songs are in the account's saved songs: a Set of the saved ids (empty when the check is not possible: then nothing is dropped).
  async function savedSet(call, ui, ids) {
    const saved = new Set();
    for (let i = 0; i < ids.length; i += 40) {
      const chunk = ids.slice(i, i + 40);
      const res = await ask(call, ui, PLAYER.savedMany(chunk), 'like').catch(() => ({ ok: false }));
      const flags = res.ok ? SV.parseSavedMany(res.body) : null;
      if (flags) chunk.forEach((id, k) => { if (flags[k]) saved.add(id); });
    }
    return saved;
  }

  // Each loader -> { ok, why, items, captionVars? } (why: 'blocked' = Spotify does not give this app that endpoint; 'none' = nothing to build it from).
  const LOADERS = {
    async recommended(call, ui, ctx) {
      const { artists } = await myArtists(call, ui, ctx);
      const tracks = await homeSource(call, ui, 'toptracks', ctx);
      const seedArtists = rotate(artists.map((a) => a.id), day(ctx)).slice(0, 3);
      const seedTracks = (tracks.ok ? tracks.data : []).map((t) => t.id).slice(0, 2);
      if (!seedArtists.length && !seedTracks.length) return { ok: false, why: 'none', items: [] };
      const p = await probe(call, ui, 'recs', PLAYER.recommendations({ artists: seedArtists, tracks: seedTracks }), ctx);
      if (!p.known) return { ok: false, why: failure(p.res), items: [] };
      if (!p.allowed) return { ok: false, why: 'blocked', items: [] };
      return { ok: true, why: '', items: fresh(SV.normalizeRecTracks(p.res.body), await ownIds(call, ui, ctx)).slice(0, MAX) };
    },
    async related(call, ui, ctx) {
      const { artists } = await myArtists(call, ui, ctx);
      const pick = rotate(artists, day(ctx)).slice(0, 3);
      if (!pick.length) return { ok: false, why: 'none', items: [] };
      const p = await probe(call, ui, 'related', PLAYER.relatedArtists(pick[0].id), ctx);
      if (!p.known) return { ok: false, why: failure(p.res), items: [] };
      if (!p.allowed) return { ok: false, why: 'blocked', items: [] };
      const mine = new Set(artists.map((a) => a.id));
      const own = await ownIds(call, ui, ctx);
      let items = fresh(SV.normalizeRelated(p.res.body).filter((a) => !mine.has(a.id)), own);
      for (const a of pick.slice(1)) { // a second artist's, when the first gave few
        if (items.length >= MAX) break;
        const res = await ask(call, ui, PLAYER.relatedArtists(a.id), 'recs').catch(() => ({ ok: false }));
        if (res.ok) items = fresh(items.concat(SV.normalizeRelated(res.body).filter((x) => !mine.has(x.id))), own);
      }
      return { ok: true, why: '', items: items.slice(0, MAX), captionVars: { title: pick[0].title } };
    },
    async newfrom(call, ui, ctx) {
      const { artists, scope } = await myArtists(call, ui, ctx);
      if (!artists.length) return { ok: false, why: scope ? 'scope' : 'none', items: [] };
      const pick = rotate(artists, day(ctx)).slice(0, 6);
      const since = new Date(ctx.now() - NEW_DAYS * DAY_MS).toISOString().slice(0, 10);
      const results = await Promise.all(pick.map((a) => ask(call, ui, PLAYER.artistReleases(a.id), 'recs').catch(() => ({ ok: false }))));
      const seen = new Set();
      const items = [];
      const own = await ownIds(call, ui, ctx);
      for (const res of results) if (res.ok) for (const al of SV.normalizeArtistReleases(res.body)) if (al.released && al.released >= since && !seen.has(al.id) && !own.has(`album:${al.id}`)) { seen.add(al.id); items.push(al); }
      items.sort((a, b) => (a.released < b.released ? 1 : a.released > b.released ? -1 : 0));
      if (!items.length && results.every((r) => !r.ok)) return { ok: false, why: failure(results[0] || { status: 0 }), items: [] };
      return { ok: true, why: '', items: items.slice(0, MAX) };
    },
    async moretop(call, ui, ctx) {
      const { artists, scope } = await myArtists(call, ui, ctx);
      if (!artists.length) return { ok: false, why: scope ? 'scope' : 'none', items: [] };
      const pick = rotate(artists, day(ctx)).slice(0, 4);
      const p = await probe(call, ui, 'toptracks', PLAYER.artistTopTracks(pick[0].id), ctx);
      if (!p.known) return { ok: false, why: failure(p.res), items: [] };
      if (!p.allowed) return { ok: false, why: 'blocked', items: [] };
      const lists = [SV.normalizeArtistTopTracks(p.res.body)];
      const rest = await Promise.all(pick.slice(1).map((a) => ask(call, ui, PLAYER.artistTopTracks(a.id), 'recs').catch(() => ({ ok: false }))));
      for (const res of rest) if (res.ok) lists.push(SV.normalizeArtistTopTracks(res.body));
      const mixed = []; // (one from each artist in turn)
      for (let i = 0; mixed.length < 40 && lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) mixed.push(l[i]);
      const saved = await savedSet(call, ui, mixed.map((t) => t.id));
      return { ok: true, why: '', items: fresh(mixed.filter((t) => !saved.has(t.id)), await ownIds(call, ui, ctx)).slice(0, MAX) };
    },
    async genres(call, ui, ctx) {
      const g = await genreList(call, ui, ctx);
      if (!g.length) return { ok: false, why: 'none', items: [] };
      const genre = g[0];
      const res = await ask(call, ui, PLAYER.searchGenre(genre, 'track'), 'recs').catch((err) => ({ ok: false, status: 0, body: '', error: err }));
      if (!res.ok) return { ok: false, why: failure(res), items: [] };
      const songs = SV.normalizeSearchSongs(res.body);
      const saved = await savedSet(call, ui, songs.map((t) => t.id));
      return { ok: true, why: '', items: fresh(songs.filter((t) => !saved.has(t.id)), await ownIds(call, ui, ctx)).slice(0, MAX), captionVars: { title: genre } };
    },
    async genreartists(call, ui, ctx) {
      const g = await genreList(call, ui, ctx);
      if (!g.length) return { ok: false, why: 'none', items: [] };
      const genre = g[1] || g[0];
      const res = await ask(call, ui, PLAYER.searchGenre(genre, 'artist'), 'recs').catch((err) => ({ ok: false, status: 0, body: '', error: err }));
      if (!res.ok) return { ok: false, why: failure(res), items: [] };
      const { artists } = await myArtists(call, ui, ctx);
      const mine = new Set(artists.map((a) => a.id));
      return { ok: true, why: '', items: fresh(SV.normalizeSearchArtists(res.body).filter((a) => !mine.has(a.id)), await ownIds(call, ui, ctx)).slice(0, MAX), captionVars: { title: genre } };
    },
  };
  // The genres of your top artists, the most common first, then rotated by the day: [genre, ...]
  async function genreList(call, ui, ctx) {
    const { top } = await myArtists(call, ui, ctx);
    const count = new Map();
    for (const a of top) for (const gen of a.genres || []) count.set(gen, (count.get(gen) || 0) + 1);
    const sorted = [...count.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]).slice(0, 8);
    return rotate(sorted, day(ctx));
  }
  return { LOADERS };
}

module.exports = { make, KEYS, STRINGS, REC_TTL_MS };
