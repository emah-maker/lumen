// The Spotify card in "Now playing" (Web API) mode, at the sizes that do more than play and pause: shuffle, repeat, volume and seek, the heart (saved
// songs), search, the queue, the library (recent plays and playlists), the output device, and the album or playlist playing. Every one is a fixed
// Web API call from features/spotify-view.js (PLAYER); this file decides which, runs them and keeps what the tabs show between looks at the player.
// It makes no request itself: `call(method, path, body) -> { ok, status, body }` is the widget's own authorised call (a test passes a mocked one).
//
//   act(call, action, ctx)         -> a card button's effect: false (not ours) | { delay?, local?, notice? }; throws what the user should read
//   extras(call, w, ctx, playback) -> the fields this adds to the card (can, the lists, the heart), after a look at the player
//   ctx = { ui (this card's state, kept by widgets.js), cached (what the card shows now), now(), image(url) -> data: URL, signal? }
//
// A scope the signed-in account never agreed to (a card connected before the bigger sizes) is not an error screen: the control that needs it is left
// out and the card says "Reconnect Spotify" (data.needsScopes).
'use strict';

const SV = require('./spotify-view');
const { PLAYER } = SV;

const TAB_MAX_AGE_MS = 5000;
const THUMBS = 6; // pictures fetched for a list (each distinct picture is a request, and all widgets share 40 a minute: a queue of one album is one)
const NEEDS = { like: 'user-library-modify', library: 'playlist-read-private', recent: 'user-read-recently-played' };
const TABS = ['queue', 'library', 'devices', 'tracks', 'search'];

const failure = (res, what) => {
  const e = new Error(SV.scopeError(res.status, res.body) ? 'Reconnect Spotify in Settings to allow this.' : SV.playerError(res.status, res.body));
  e.scope = SV.scopeError(res.status, res.body);
  e.what = what;
  return e;
};
async function ask(call, ui, req, what) {
  const res = await call(req[0], req[1], req[2]);
  if (!res.ok && SV.scopeError(res.status, res.body)) (ui.missing ||= {})[what] = true;
  return res;
}

// A row's picture: the first of its candidate addresses that comes as a small data: URL (kept an hour by `image`), else ''.
async function pic(images, image) {
  for (const u of images) { const t = await image(u).catch(() => ''); if (t && t.length < 12000) return t; }
  return '';
}
// Pictures for the first few rows of a list (the queue), each a small data: URL; a row without one just has no picture.
async function withThumbs(items, ctx) {
  return Promise.all(items.map((it, i) => { const { images = [], ...row } = it; return (i < THUMBS && images.length ? pic(images, ctx.image) : Promise.resolve('')).then((thumb) => ({ ...row, thumb })); }));
}
const bare = (items) => items.map((it) => { const row = { ...it }; delete row.images; delete row.thumbAsked; return row; });

// ---- search ----
// ONE request (GET /search for songs, albums, artists and playlists together). The rows come back at once without pictures: the card asks for the
// pictures of the rows it has on screen (loadThumbs), so a long list costs no more than the rows that are looked at. A search that was asked before a
// newer one finished is dropped (ui.searchSeq), so an older term never replaces the newer one's rows. `ctx.searchCall` (the user's own search budget,
// not the shared polling one) is used when the widget has it.
async function runSearch(ui, term, ctx, call = ctx.searchCall) {
  const mine = (ui.searchSeq = (ui.searchSeq || 0) + 1);
  const res = await ask(call, ui, PLAYER.search(term), 'search').catch((err) => ({ ok: false, status: 0, body: '', error: err }));
  if (mine !== ui.searchSeq) return { stale: true, ok: false };
  ui.search = { term: term.slice(0, 80), ok: res.ok, items: res.ok ? SV.normalizeSearch(res.body) : [], why: res.ok ? '' : 'page', api: true };
  return { ok: res.ok, stale: false, status: res.status };
}
function clearSearch(ui) { ui.searchSeq = (ui.searchSeq || 0) + 1; ui.search = null; }
async function loadThumbs(ui, ids, ctx) {
  const s = ui.search;
  if (!s || !Array.isArray(s.items)) return;
  const want = new Set(ids || []);
  const todo = s.items.filter((i) => want.has(i.id) && !i.thumb && !i.thumbAsked && i.images && i.images.length).slice(0, 12);
  for (const i of todo) i.thumbAsked = true;
  await Promise.all(todo.map(async (i) => { i.thumb = await pic(i.images, ctx.searchImage || ctx.image); }));
}
// What the search adds to the card's data (the engine's card too, when the Web API answered): null when there is no answered search.
function directResults(ui) {
  const s = ui && ui.search;
  if (!s || !s.api) return null;
  return { results: bare(s.items), searchOk: s.ok !== false, searchWhy: s.ok === false ? 'page' : '', searchDetail: '', query: s.term, searching: false, searchPartial: false, moreSongs: false, moreLoading: false };
}

async function loadTab(call, name, ctx, playback) {
  const { ui } = ctx;
  const at = ctx.now();
  if (name === 'queue') {
    const res = await ask(call, ui, PLAYER.queue(), 'queue');
    if (!res.ok) { ui.queue = { ok: false, why: SV.scopeError(res.status, res.body) ? 'scope' : 'page', at, items: [] }; return; }
    ui.queue = { ok: true, at, items: await withThumbs(SV.normalizeQueue(res.body), ctx) };
    return;
  }
  if (name === 'library') {
    const [recent, playlists] = await Promise.all([ask(call, ui, PLAYER.recent(), 'recent'), ask(call, ui, PLAYER.playlists(), 'library')]);
    ui.library = {
      at, ok: recent.ok || playlists.ok,
      recent: recent.ok ? bare(SV.normalizeRecent(recent.body)).slice(0, 10) : [],
      playlists: playlists.ok ? bare(SV.normalizePlaylists(playlists.body)).slice(0, 25) : [],
    };
    return;
  }
  if (name === 'devices') {
    const res = await ask(call, ui, PLAYER.devices(), 'devices');
    ui.devices = { at, ok: res.ok, items: res.ok ? SV.normalizeDevices(res.body) : [] };
    return;
  }
  if (name === 'tracks') {
    const c = playback?.context || ui.context;
    if (!c) { ui.tracks = { ok: true, at, title: '', current: -1, items: [], none: true }; return; }
    const res = await ask(call, ui, PLAYER.context(c.kind, c.id), 'tracks');
    if (!res.ok) { ui.tracks = { ok: false, at, title: '', current: -1, items: [], why: SV.scopeError(res.status, res.body) ? 'scope' : 'page' }; return; }
    const got = SV.normalizeContext(c.kind, res.body);
    ui.tracksCtx = c;
    ui.tracks = { ok: true, at, title: got.title, current: -1, items: bare(got.items), key: `${c.kind}:${c.id}` };
  }
}
const currentIndex = (items, id) => items.findIndex((i) => i.id === id);

// ---- the card's buttons ----
async function act(call, action, ctx) {
  const { ui, cached } = ctx;
  const need = (res, what) => { if (!res.ok) throw failure(res, what); };
  const noDevice = (res) => res.status === 404 || SV.noActiveDevice(res.status, res.body);
  switch (action.do) {
    case 'shuffle': case 'repeat': case 'volume': {
      const req = action.do === 'shuffle' ? PLAYER.shuffle(action.arg === '1' || (action.arg === undefined && cached.shuffle !== true)) : action.do === 'repeat' ? PLAYER.repeat(['off', 'all', 'one'].includes(action.arg) ? action.arg : ({ off: 'all', all: 'one', one: 'off' }[cached.repeat] || 'all')) : PLAYER.volume(Number(action.arg));
      const res = await ask(call, ui, req, action.do);
      if (!res.ok && noDevice(res)) throw new Error('No active Spotify device. Start playing in a Spotify app, then try again.');
      need(res, action.do);
      if (action.do === 'shuffle') cached.shuffle = req[1].endsWith('true');
      else if (action.do === 'repeat') cached.repeat = req[1].endsWith('context') ? 'all' : req[1].endsWith('track') ? 'one' : 'off';
      else cached.volume = Math.max(0, Math.min(100, Math.round(Number(action.arg)))) / 100;
      return { delay: 900, local: true };
    }
    case 'like': {
      const id = cached.itemId;
      if (!SV.SAFE_ID.test(id || '')) throw new Error('Nothing to save.');
      const on = action.arg === '1' ? true : action.arg === '0' ? false : cached.liked !== true;
      const res = await ask(call, ui, PLAYER.save(id, on), 'like');
      need(res, 'like');
      cached.liked = on;
      ui.liked = { id, value: on };
      return { local: true, notice: on ? 'Saved to your Liked Songs.' : 'Removed from your Liked Songs.' };
    }
    case 'etab': {
      if (!TABS.includes(action.arg)) return false;
      ui.tab = { name: action.arg, at: ctx.now() };
      if (action.arg === 'search') return { local: true };
      const have = ui[action.arg];
      const playingFrom = cached.context ? `${cached.context.kind}:${cached.context.id}` : '';
      if (have && ctx.now() - have.at < TAB_MAX_AGE_MS && !action.force && (action.arg !== 'tracks' || have.key === playingFrom)) return { local: true };
      await loadTab(call, action.arg, ctx, cached);
      return { local: true };
    }
    case 'seek': { // (the progress bar: seconds)
      if (!Number.isFinite(action.sec)) return false;
      const res = await ask(call, ui, PLAYER.seek(action.sec), 'seek');
      if (!res.ok && noDevice(res)) throw new Error('No active Spotify device. Start playing in a Spotify app, then try again.');
      need(res, 'seek');
      cached.progressMs = Math.round(action.sec * 1000);
      cached.at = ctx.now();
      return { local: true };
    }
    case 'elists': { await loadTab(call, 'library', ctx, cached); return { local: true }; }
    case 'esearch': {
      const term = typeof action.text === 'string' ? action.text.trim() : '';
      if (!term) { clearSearch(ui); ui.search = { term: '', items: [], ok: true }; return { local: true }; }
      await runSearch(ui, term, ctx, ctx.searchCall || call);
      return { local: true };
    }
    case 'ethumb': { await loadThumbs(ui, action.ids, ctx); return { local: true }; }
    case 'emore': return { local: true }; // (the whole list came in one request)
    case 'playitem': {
      if (!SV.PLAYABLE_KINDS.includes(action.kind) || !SV.SAFE_ID.test(action.item || '')) return false;
      let res = await call(...flat(PLAYER.playItem(action.kind, action.item)));
      if (!res.ok && noDevice(res)) res = await wakeAndRetry(call, () => PLAYER.playItem(action.kind, action.item));
      need(res, 'play');
      return { delay: 1500 };
    }
    case 'playnext': case 'playlater': {
      if (action.kind !== 'song' || !SV.SAFE_ID.test(action.item || '')) throw new Error('Only songs can be added to the queue here.');
      const res = await call(...flat(PLAYER.queueAdd(action.item)));
      if (!res.ok && noDevice(res)) throw new Error('No active Spotify device. Start playing in a Spotify app, then try again.');
      need(res, 'queue');
      if (ui.queue) ui.queue.at = 0; // (so the next look at the tab asks again)
      return { notice: 'Added to the queue.', local: true };
    }
    case 'playfrom': { // a row of the album or playlist playing: it plays from there, in that context
      const list = ui.tracks;
      const row = list?.items?.[Number(action.arg)];
      if (!row || !ui.tracksCtx || (action.item && row.id !== action.item)) throw new Error('The list changed. Look again.');
      const res = await call(...flat(PLAYER.playFrom(ui.tracksCtx, Number(action.arg))));
      need(res, 'play');
      return { delay: 1200 };
    }
    case 'playqueue': { // a row of the queue: skip ahead to it (the queue keeps its order)
      const index = Number(action.arg);
      const row = ui.queue?.items?.[index];
      if (!row || (action.item && row.id !== action.item)) throw new Error('The queue changed. Look again.');
      if (index > 9) throw new Error('That is too far ahead to skip to. Search for it instead.');
      for (let i = 0; i <= index; i++) { const res = await call('POST', '/me/player/next'); need(res, 'queue'); }
      ui.queue.at = 0;
      return { delay: 900 };
    }
    case 'transfer': {
      if (!SV.DEVICE_ID_RE.test(action.arg || '')) return false;
      const res = await call(...flat(PLAYER.transfer(action.arg, cached.state === 'playing')));
      need(res, 'devices');
      if (ui.devices) ui.devices.items = ui.devices.items.map((d) => ({ ...d, active: d.id === action.arg }));
      return { delay: 1200, local: false };
    }
    default: return false;
  }
}
const flat = (req) => [req[0], req[1], req[2]];
// A play that found no active device: wake one of the account's (this computer first), then press again there.
async function wakeAndRetry(call, again) {
  const devices = await call('GET', '/me/player/devices');
  const id = devices.ok ? SV.pickDevice(devices.body) : '';
  if (!id) return { ok: false, status: 404, body: '' };
  const moved = await call(...flat(PLAYER.transfer(id, false)));
  if (!moved.ok) return moved;
  return call(...flat(again()));
}

// ---- what a look at the player adds to the card ----
// `playback`: the normalised GET /me/player (data), already fetched by widgets.js. Returns the fields to merge.
async function extras(call, ctx, playback) {
  const { ui } = ctx;
  ui.context = playback.context || ui.context || null;
  // The heart: asked again only when the song changed (one small call), and only while a song is shown.
  let liked = null;
  if (playback.itemId && playback.state !== 'idle') {
    if (!ui.liked || ui.liked.id !== playback.itemId) {
      const res = await ask(call, ui, PLAYER.saved(playback.itemId), 'like');
      ui.liked = { id: playback.itemId, value: res.ok ? SV.parseSaved(res.body) : null };
    }
    liked = ui.liked.value;
  }
  const missing = ui.missing || {}; // (after the calls above: a 403 on the heart is known now)
  // The open tab's list goes stale when the song changes (the queue; the album playing when the context changed): one fresh look.
  const song = playback.itemId || '';
  if (ui.song !== song) {
    ui.song = song;
    if (ui.tab?.name === 'queue' || (ui.tab?.name === 'tracks' && ui.tracks?.key !== (playback.context ? `${playback.context.kind}:${playback.context.id}` : ''))) await loadTab(call, ui.tab.name, ctx, playback).catch(() => {});
  }
  const t = ui.tracks;
  const tracks = t ? { ...t, current: currentIndex(t.items, song), pending: false, signedOut: false } : { items: [], title: '', current: -1, ok: true, why: '', pending: false };
  const q = ui.queue || { items: [], ok: true };
  const lib = ui.library;
  const dev = ui.devices;
  return {
    liked,
    can: {
      search: true, lists: true, seek: true, queue: true, playNext: false, playLater: true, like: Boolean(playback.itemId) && !missing.like && liked !== null, shuffle: playback.shuffle !== null, repeat: playback.repeat !== null,
      volume: playback.volume !== null, library: !(missing.library && missing.recent), tracks: Boolean(playback.context || ui.tracks), lyrics: false, devices: 'pick',
    },
    needsScopes: Object.keys(missing).filter((k) => NEEDS[k] && missing[k]).length > 0,
    queue: { items: q.items || [], pending: false, ok: q.ok !== false, why: q.ok === false ? q.why || 'page' : '', title: '', current: -1, signedOut: false },
    tracks,
    recent: lib ? lib.recent : [],
    playlists: lib ? lib.playlists : [],
    devices: dev ? dev.items : [],
    devicesOk: dev ? dev.ok : true,
    results: ui.search ? bare(ui.search.items) : [],
    searchOk: ui.search ? ui.search.ok !== false : true,
    searchWhy: ui.search && ui.search.ok === false ? 'page' : '',
    query: ui.search ? ui.search.term : '',
    searching: false,
    signedIn: true,
    lyrics: { pending: false, ok: true, why: '', lines: [], forTitle: '' },
  };
}

module.exports = { act, extras, loadTab, runSearch, clearSearch, loadThumbs, directResults, TABS, NEEDS };
