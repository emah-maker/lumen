// The Apple Music engine's bridge: a hidden music.apple.com view in which Apple's own MusicKit JS plays the music, and a small
// fixed script (BRIDGE_SOURCE) that watches MusicKit and reports a compact state to main, and does the few things the card
// asks for. This file is the pure part: that script, and the checks on both directions. Nothing from the page is trusted:
// every message it sends is parsed and bounded here, and every command main sends is picked from a fixed set with validated
// arguments (the script runs no text it is given; it only reads a JSON object and switches on a fixed name).
//
// Wire: main -> page: JSON string {cmd, ...} as the `detail` of a 'lumen-engine-in' DOM event (the preload dispatches it);
//       page -> main: JSON string as the `detail` of a 'lumen-engine-out' event (the preload forwards it by IPC).
'use strict';

const MAX_MESSAGE = 200000;
const KINDS = ['song', 'album', 'playlist', 'station', 'artist']; // what playItem takes (an artist plays its top songs)
const QUEUE_KINDS = ['song', 'album', 'playlist']; // what playNext and playLater take
// What this service's card can offer (features/music-card-features.js has the same table by name). Lyrics are Apple's own API, for subscribers only.
const CAPS = { search: true, lists: true, seek: true, queue: true, playNext: true, playLater: true, like: true, shuffle: true, repeat: true, volume: true, tracks: true, lyrics: true, devices: false };
const LISTS = ['recent', 'playlists']; // the library lists, asked on a schedule
const PAGE_LISTS = ['queue', 'tracks']; // asked when the card's tab is open: what is next, and the whole queue (the album or playlist playing)
const REPEAT_MODES = ['off', 'all', 'one'];
const MAX_TRACKS = 100;
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const STOREFRONT_RE = /^[a-z]{2}$/;
const ART_HOST_RE = /^[a-z0-9-]+\.mzstatic\.com$/;
const MAX_ITEMS = 40;

const clip = (v, max = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : 0);

// MusicKit's playback states: 0 none, 1 loading, 2 playing, 3 paused, 4 stopped, 5 ended, 6 seeking, 7 waiting?, 8 waiting, 9 stalled, 10 completed.
function playbackKind(n) {
  if (n === 2 || n === 1 || n === 8 || n === 9) return 'playing'; // loading, waiting and stalled are "about to play": the card shows playing
  if (n === 3) return 'paused';
  if (n === 6) return 'seeking';
  return 'idle';
}

// An artwork address template from MusicKit ("https://is1-ssl.mzstatic.com/.../{w}x{h}bb.jpg") -> a picture address of one size, or ''.
// Only https on mzstatic.com, the default port, no credentials, nothing that could break out of an address.
function artUrl(template, size = 160) {
  if (typeof template !== 'string' || template.length > 600) return '';
  const url = template.replace(/\{w\}/g, String(size)).replace(/\{h\}/g, String(size)).replace(/\{c\}/g, 'bb').replace(/\{f\}/g, 'jpg');
  if (/[\s"'<>\\{}]/.test(url)) return '';
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && ART_HOST_RE.test(u.hostname) ? u.href : '';
  } catch { return ''; }
}

// An item's type as the API names it ('songs', 'library-playlists', 'albums', 'stations') -> what setQueue wants, or null.
function kindOf(type) {
  const t = String(type || '').replace(/^library-/, '').replace(/s$/, '');
  return KINDS.includes(t) ? t : null;
}

function cleanItem(i) {
  if (!i || typeof i !== 'object' || typeof i.id !== 'string' || !ID_RE.test(i.id)) return null;
  const kind = kindOf(i.type);
  const title = clip(i.title, 120);
  if (!kind || !title) return null;
  return { id: i.id, kind, title, sub: clip(i.sub, 120), ms: Math.round(num(i.ms, 0, 48 * 3600e3)), art: artUrl(i.art, 64) };
}

// A page message (the JSON text) -> a checked object of ours, or null. Never throws.
//   { t:'ready' }
//   { t:'state', auth, state, pos, dur, item: { id, kind, title, artist, album, art, ms } | null, store }
//   { t:'list', kind, rid, ok, signedOut, items: [{ id, kind, title, sub }] }
//   { t:'error', message }
function parseMessage(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return null;
  let m;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  if (m.t === 'ready') return { t: 'ready' };
  if (m.t === 'error') return { t: 'error', message: clip(m.message, 200) };
  if (m.t === 'state') {
    const i = m.item && typeof m.item === 'object' ? m.item : null;
    const item = i && typeof i.title === 'string' && clip(i.title, 200) ? {
      id: typeof i.id === 'string' && ID_RE.test(i.id) ? i.id : '',
      kind: kindOf(i.type) || 'song',
      title: clip(i.title, 200), artist: clip(i.artist, 120), album: clip(i.album, 120),
      art: artUrl(i.art, 160), ms: Math.round(num(i.ms, 0, 48 * 3600e3)),
    } : null;
    const has = m.has && typeof m.has === 'object' ? m.has : {};
    return {
      t: 'state', auth: m.auth === true, state: Math.round(num(m.state, 0, 20)),
      pos: num(m.pos, 0, 48 * 3600), dur: num(m.dur, 0, 48 * 3600), item,
      store: typeof m.store === 'string' && STOREFRONT_RE.test(m.store) ? m.store : '',
      shuffle: m.shuffle === true ? true : m.shuffle === false ? false : null,
      repeat: REPEAT_MODES.includes(m.repeat) ? m.repeat : null,
      volume: typeof m.volume === 'number' && Number.isFinite(m.volume) ? Math.round(Math.max(0, Math.min(1, m.volume)) * 100) / 100 : null,
      liked: m.liked === true ? true : m.liked === false ? false : null, // (null: not known, or not a song that can be rated)
      has: { like: has.like === true, shuffle: has.shuffle !== false, repeat: has.repeat !== false, volume: has.volume !== false },
    };
  }
  if (m.t === 'list') {
    if (!LISTS.includes(m.kind) && !PAGE_LISTS.includes(m.kind) && m.kind !== 'search') return null;
    const max = m.kind === 'tracks' ? MAX_TRACKS : MAX_ITEMS;
    return {
      t: 'list', kind: m.kind, rid: Math.round(num(m.rid, 0, 1e9)), ok: m.ok === true, signedOut: m.signedOut === true,
      why: m.ok === true ? '' : 'page', detail: '', title: clip(m.title, 120), current: Number.isInteger(m.current) && m.current >= 0 && m.current < max ? m.current : -1,
      items: (Array.isArray(m.items) ? m.items : []).slice(0, max).map(cleanItem).filter(Boolean),
    };
  }
  if (m.t === 'lyrics') { // the song's words, a line each; `why`: why there are none
    const ok = m.ok === true;
    return { t: 'lyrics', rid: Math.round(num(m.rid, 0, 1e9)), ok, why: ok ? '' : (['signedOut', 'none', 'page'].includes(m.why) ? m.why : 'page'), lines: ok ? (Array.isArray(m.lines) ? m.lines : []).slice(0, 250).map((l) => clip(l, 200)).filter(Boolean) : [] };
  }
  return null;
}

// A command from the card/main -> the JSON text to send the page, or null when it isn't one of the fixed commands.
function cleanCommand(c) {
  if (!c || typeof c !== 'object') return null;
  switch (c.cmd) {
    case 'play': case 'pause': case 'next': case 'previous': return JSON.stringify({ cmd: c.cmd });
    case 'seek': {
      if (typeof c.sec !== 'number' || !Number.isFinite(c.sec) || c.sec < 0 || c.sec > 48 * 3600) return null;
      return JSON.stringify({ cmd: 'seek', sec: Math.round(c.sec) });
    }
    case 'playItem': {
      if (!KINDS.includes(c.kind) || typeof c.id !== 'string' || !ID_RE.test(c.id)) return null;
      return JSON.stringify({ cmd: 'playItem', kind: c.kind, id: c.id });
    }
    case 'playNext': case 'playLater': {
      if (!QUEUE_KINDS.includes(c.kind) || typeof c.id !== 'string' || !ID_RE.test(c.id)) return null;
      return JSON.stringify({ cmd: c.cmd, kind: c.kind, id: c.id });
    }
    case 'list': {
      if (!LISTS.includes(c.kind) && !PAGE_LISTS.includes(c.kind)) return null;
      return JSON.stringify({ cmd: 'list', kind: c.kind, rid: Math.round(num(c.rid, 0, 1e9)) });
    }
    case 'like': case 'shuffle': {
      if (typeof c.on !== 'boolean') return null;
      return JSON.stringify({ cmd: c.cmd, on: c.on });
    }
    case 'repeat': return REPEAT_MODES.includes(c.mode) ? JSON.stringify({ cmd: 'repeat', mode: c.mode }) : null;
    case 'volume': {
      if (typeof c.level !== 'number' || !Number.isFinite(c.level) || c.level < 0 || c.level > 1) return null;
      return JSON.stringify({ cmd: 'volume', level: Math.round(c.level * 100) / 100 });
    }
    case 'lyrics': return JSON.stringify({ cmd: 'lyrics', rid: Math.round(num(c.rid, 0, 1e9)) });
    case 'playQueue': case 'playFrom': {
      if (!Number.isInteger(c.index) || c.index < 0 || c.index >= (c.cmd === 'playQueue' ? 100 : MAX_TRACKS)) return null;
      if (c.id !== undefined && (typeof c.id !== 'string' || !ID_RE.test(c.id))) return null; // (the song the card showed there: the page checks it is still there)
      return JSON.stringify(c.id === undefined ? { cmd: c.cmd, index: c.index } : { cmd: c.cmd, index: c.index, id: c.id });
    }
    case 'search': {
      const term = clip(c.term, 80);
      if (!term) return null;
      return JSON.stringify({ cmd: 'search', term, rid: Math.round(num(c.rid, 0, 1e9)) });
    }
    default: return null;
  }
}

// The state message -> what the card is given. `art` is a data: URL ('' when it has none yet); `now` stamps the playhead.
// Returns null for a state that is only a seek in progress (the caller keeps what it had).
function toCard(m, now, art = '') {
  const kind = playbackKind(m.state);
  if (kind === 'seeking') return null;
  const base = { mode: 'status', title: '', artist: '', album: '', progressMs: 0, durationMs: 0, at: now, source: 'engine', kind: 'none', reason: '', art: '', liked: m.liked, shuffle: m.shuffle, repeat: m.repeat, volume: m.volume };
  if (!m.item || kind === 'idle') return { ...base, state: 'idle' };
  const durationMs = m.dur > 0 ? Math.round(m.dur * 1000) : m.item.ms;
  const progress = Math.round(m.pos * 1000);
  return {
    ...base, state: kind, title: m.item.title, artist: m.item.artist, album: m.item.album, kind: 'track', art,
    progressMs: durationMs ? Math.min(progress, durationMs) : progress, durationMs, preview: m.auth !== true,
  };
}

// The script that runs in music.apple.com's own page (the main world, where MusicKit lives), injected by the preload.
// It only reads MusicKit and calls the player's own methods; it makes no request of its own except Apple's API through MusicKit,
// at three fixed paths (the storefront is checked to be two letters; the search term travels as a parameter, not in the path).
const BRIDGE_SOURCE = `(function () {
  var OUT = 'lumen-engine-out', IN = 'lumen-engine-in';
  var KINDS = ${JSON.stringify(KINDS)}, QUEUE = ${JSON.stringify(QUEUE_KINDS)}, LISTS = ${JSON.stringify(LISTS)}, PAGE_LISTS = ${JSON.stringify(PAGE_LISTS)};
  var ID = /^[A-Za-z0-9._-]{1,64}$/, STORE = /^[a-z]{2}$/;
  var mk = null, lastProgress = 0;
  function out(o) { try { document.dispatchEvent(new CustomEvent(OUT, { detail: JSON.stringify(o) })); } catch (e) {} }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
  function item() {
    var i = mk && mk.nowPlayingItem;
    if (!i) return null;
    return { id: String(i.id || ''), type: String(i.type || ''), title: String(i.title || ''), artist: String(i.artistName || ''), album: String(i.albumName || ''), art: String(i.artworkURL || (i.artwork && i.artwork.url) || ''), ms: num(i.playbackDuration) };
  }
  // Songs can be loved (a rating of 1): the catalog's or the library's. liked.id is the song the answer belongs to, liked.value: true | false | null (not known yet).
  var liked = { id: '', value: null };
  function songType(i) {
    var t = String((i && i.type) || '');
    return t === 'song' || t === 'songs' ? 'songs' : t === 'library-songs' ? 'library-songs' : '';
  }
  function ratable() { var i = mk && mk.nowPlayingItem; return Boolean(i && mk.isAuthorized && songType(i) && ID.test(String(i.id || ''))); }
  function refreshLiked() {
    if (!ratable()) { liked = { id: '', value: null }; return; }
    var i = mk.nowPlayingItem, id = String(i.id);
    if (liked.id === id) return;
    liked = { id: id, value: null };
    mk.api.music('/v1/me/ratings/' + songType(i) + '/' + id).then(function (r) {
      var d = r && r.data && r.data.data && r.data.data[0];
      if (liked.id === id) { liked.value = Boolean(d && d.attributes && d.attributes.value === 1); snapshot(); }
    }, function () { if (liked.id === id) { liked.value = false; snapshot(); } }); // (no rating yet answers 404: not loved)
  }
  function snapshot() {
    if (!mk) return;
    refreshLiked();
    out({ t: 'state', auth: Boolean(mk.isAuthorized), state: num(mk.playbackState), pos: num(mk.currentPlaybackTime), dur: num(mk.currentPlaybackDuration), item: item(), store: String(mk.storefrontId || ''),
      shuffle: mk.shuffleMode === 1, repeat: mk.repeatMode === 1 ? 'one' : mk.repeatMode === 2 ? 'all' : 'off', volume: typeof mk.volume === 'number' ? mk.volume : null,
      liked: ratable() ? liked.value : null, has: { like: ratable(), shuffle: true, repeat: true, volume: typeof mk.volume === 'number' } });
  }
  function setLike(on) {
    if (!ratable()) return;
    var i = mk.nowPlayingItem, id = String(i.id), path = '/v1/me/ratings/' + songType(i) + '/' + id;
    var call = on ? mk.api.music(path, {}, { fetchOptions: { method: 'PUT', body: JSON.stringify({ type: 'rating', attributes: { value: 1 } }) } }) : mk.api.music(path, {}, { fetchOptions: { method: 'DELETE' } });
    liked = { id: id, value: on };
    snapshot();
    call.catch(function (e) { liked = { id: '', value: null }; fail(e); refreshLiked(); });
  }
  function fail(e) { out({ t: 'error', message: String((e && (e.message || e.errorCode)) || e || 'error') }); }
  function map(data) {
    return (data || []).map(function (d) {
      var a = d.attributes || {};
      return { id: String(d.id || ''), type: String(d.type || ''), title: String(a.name || ''), sub: String(a.artistName || a.curatorName || ''), ms: num(a.durationInMillis), art: String((a.artwork && a.artwork.url) || '') };
    });
  }
  function list(kind, rid) {
    var path = kind === 'recent' ? '/v1/me/recent/played' : '/v1/me/library/playlists';
    mk.api.music(path, { limit: kind === 'recent' ? 10 : 25 }).then(function (r) {
      out({ t: 'list', kind: kind, rid: rid, ok: true, items: map(r && r.data && r.data.data) });
    }, function (e) {
      out({ t: 'list', kind: kind, rid: rid, ok: false, signedOut: !mk.isAuthorized || (e && (e.status === 403 || e.status === 401)), items: [] });
    });
  }
  // The player's queue: [{ id, type, title, sub, ms, art }] from a position; an id the card cannot use becomes q + the position so that none is dropped.
  function queueItems(from) {
    var all = (mk.queue && mk.queue.items) || [], res = [];
    for (var n = from; n < all.length && res.length < ${MAX_TRACKS}; n++) {
      var m = all[n] || {}, id = String(m.id || '');
      res.push({ id: ID.test(id) ? id : 'q' + n, type: 'songs', title: String(m.title || 'Untitled'), sub: String(m.artistName || ''), ms: num(m.playbackDuration), art: String(m.artworkURL || (m.artwork && m.artwork.url) || '') });
    }
    return res;
  }
  function position() { return typeof mk.nowPlayingItemIndex === 'number' && mk.nowPlayingItemIndex >= 0 ? mk.nowPlayingItemIndex : -1; }
  function pageList(kind, rid) {
    var pos = position();
    if (kind === 'queue') { out({ t: 'list', kind: 'queue', rid: rid, ok: true, items: queueItems(pos + 1) }); return; }
    var items = queueItems(0), album = items.length && mk.nowPlayingItem ? String(mk.nowPlayingItem.albumName || '') : '';
    out({ t: 'list', kind: 'tracks', rid: rid, ok: true, title: album, current: pos < items.length ? pos : -1, items: items });
  }
  // A queue position the card pointed at (index in what it listed, the song's id): only when that song is still there.
  function playAt(abs, id) {
    var all = (mk.queue && mk.queue.items) || [], m = all[abs];
    if (!m || (id && String(m.id || '') !== id && 'q' + abs !== id)) { fail(new Error('The queue changed. Look again.')); return; }
    mk.changeToMediaAtIndex(abs).then(function () { return mk.play(); }).catch(fail);
  }
  // Lyrics (Apple's API, subscribers): TTML text, one line per <p>. Plain text out; tags and entities removed without a pattern.
  function ttmlLines(ttml) {
    var lines = [], at = 0, text = String(ttml || '');
    while (lines.length < 250) {
      var open = text.indexOf('<p', at);
      if (open < 0) break;
      var tagEnd = text.indexOf('>', open), close = text.indexOf('</p>', tagEnd);
      if (tagEnd < 0 || close < 0) break;
      var raw = text.slice(tagEnd + 1, close), plain = '', inTag = false;
      for (var k = 0; k < raw.length; k++) { var ch = raw.charAt(k); if (ch === '<') inTag = true; else if (ch === '>') inTag = false; else if (!inTag) plain += ch; }
      plain = plain.split('&amp;').join('&').split('&lt;').join('<').split('&gt;').join('>').split('&quot;').join('"').split('&apos;').join(String.fromCharCode(39)).split('&#39;').join(String.fromCharCode(39));
      if (plain.trim()) lines.push(plain.trim());
      at = close + 4;
    }
    return lines;
  }
  function lyrics(rid) {
    var i = mk.nowPlayingItem;
    if (!i) { out({ t: 'lyrics', rid: rid, ok: false, why: 'none', lines: [] }); return; }
    if (!mk.isAuthorized) { out({ t: 'lyrics', rid: rid, ok: false, why: 'signedOut', lines: [] }); return; }
    var pp = (i.attributes && i.attributes.playParams) || {}, id = String(pp.catalogId || pp.id || i.id || '');
    var store = String(mk.storefrontId || 'us');
    if (!STORE.test(store)) store = 'us';
    if (!ID.test(id)) { out({ t: 'lyrics', rid: rid, ok: false, why: 'none', lines: [] }); return; }
    mk.api.music('/v1/catalog/' + store + '/songs/' + id + '/lyrics').then(function (r) {
      var d = r && r.data && r.data.data && r.data.data[0], lines = ttmlLines(d && d.attributes && d.attributes.ttml);
      out({ t: 'lyrics', rid: rid, ok: lines.length > 0, why: lines.length ? '' : 'none', lines: lines });
    }, function (e) { out({ t: 'lyrics', rid: rid, ok: false, why: e && (e.status === 401 || e.status === 403) ? 'signedOut' : 'none', lines: [] }); });
  }
  function playArtist(id) {
    var store = String(mk.storefrontId || 'us');
    if (!STORE.test(store)) store = 'us';
    mk.api.music('/v1/catalog/' + store + '/artists/' + id + '/view/top-songs', { limit: 15 }).then(function (r) {
      var ids = ((r && r.data && r.data.data) || []).map(function (d) { return String(d.id || ''); }).filter(function (x) { return ID.test(x); });
      if (!ids.length) throw new Error('No songs for that artist');
      return mk.setQueue({ songs: ids }).then(function () { return mk.play(); });
    }).catch(fail);
  }
  var searchSeq = 0;
  // One call for songs, albums, artists and playlists together. A newer search makes the answer of an older one in flight be dropped.
  function search(term, rid) {
    var store = String(mk.storefrontId || 'us');
    if (!STORE.test(store)) store = 'us';
    var seq = ++searchSeq;
    mk.api.music('/v1/catalog/' + store + '/search', { term: term, types: 'songs,albums,artists,playlists', limit: 8 }).then(function (r) {
      if (seq !== searchSeq) return;
      var res = (r && r.data && r.data.results) || {};
      var items = [].concat(map(res.songs && res.songs.data), map(res.albums && res.albums.data), map(res.artists && res.artists.data), map(res.playlists && res.playlists.data));
      out({ t: 'list', kind: 'search', rid: rid, ok: true, items: items });
    }, function () { if (seq === searchSeq) out({ t: 'list', kind: 'search', rid: rid, ok: false, items: [] }); });
  }
  function run(c) {
    if (!mk || !c) return;
    try {
      switch (c.cmd) {
        case 'play': mk.play().catch(fail); break;
        case 'pause': mk.pause(); break;
        case 'next': mk.skipToNextItem().catch(fail); break;
        case 'previous': mk.skipToPreviousItem().catch(fail); break;
        case 'seek': if (typeof c.sec === 'number' && c.sec >= 0) mk.seekToTime(c.sec).catch(fail); break;
        case 'playItem': {
          if (KINDS.indexOf(c.kind) < 0 || typeof c.id !== 'string' || !ID.test(c.id)) break;
          if (c.kind === 'artist') { playArtist(c.id); break; }
          var q = {}; q[c.kind] = c.id;
          mk.setQueue(q).then(function () { return mk.play(); }).catch(fail);
          break;
        }
        case 'playNext': case 'playLater': {
          if (QUEUE.indexOf(c.kind) < 0 || typeof c.id !== 'string' || !ID.test(c.id)) break;
          var qq = {}; qq[c.kind] = c.id;
          (c.cmd === 'playNext' ? mk.playNext(qq) : mk.playLater(qq)).catch(fail);
          break;
        }
        case 'list': if (LISTS.indexOf(c.kind) >= 0) list(c.kind, num(c.rid)); else if (PAGE_LISTS.indexOf(c.kind) >= 0) pageList(c.kind, num(c.rid)); break;
        case 'like': if (typeof c.on === 'boolean') setLike(c.on); break;
        case 'shuffle': if (typeof c.on === 'boolean') { mk.shuffleMode = c.on ? 1 : 0; snapshot(); } break;
        case 'repeat': if (c.mode === 'off' || c.mode === 'all' || c.mode === 'one') { mk.repeatMode = c.mode === 'one' ? 1 : c.mode === 'all' ? 2 : 0; snapshot(); } break;
        case 'volume': if (typeof c.level === 'number' && c.level >= 0 && c.level <= 1) { mk.volume = c.level; snapshot(); } break;
        case 'lyrics': lyrics(num(c.rid)); break;
        case 'playQueue': if (typeof c.index === 'number' && c.index >= 0) playAt(position() + 1 + c.index, typeof c.id === 'string' ? c.id : ''); break;
        case 'playFrom': if (typeof c.index === 'number' && c.index >= 0) playAt(c.index, typeof c.id === 'string' ? c.id : ''); break;
        case 'search': if (typeof c.term === 'string' && c.term) search(c.term.slice(0, 80), num(c.rid)); break;
      }
    } catch (e) { fail(e); }
  }
  function hook(m) {
    mk = m;
    ['nowPlayingItemDidChange', 'playbackStateDidChange', 'playbackDurationDidChange', 'authorizationStatusDidChange', 'storefrontIdDidChange', 'shuffleModeDidChange', 'repeatModeDidChange', 'volumeDidChange'].forEach(function (ev) { try { m.addEventListener(ev, snapshot); } catch (e) {} });
    try { m.addEventListener('playbackProgressDidChange', function () { var t = Date.now(); if (t - lastProgress > 4000) { lastProgress = t; snapshot(); } }); } catch (e) {}
    try { m.addEventListener('mediaPlaybackError', fail); } catch (e) {}
    out({ t: 'ready' });
    snapshot();
  }
  document.addEventListener(IN, function (e) { var c; try { c = JSON.parse(e.detail); } catch (x) { return; } run(c); });
  var tries = 0;
  var poll = setInterval(function () {
    try {
      var m = window.MusicKit && window.MusicKit.getInstance && window.MusicKit.getInstance();
      if (m) { clearInterval(poll); hook(m); return; }
    } catch (e) {}
    if (++tries > 240) clearInterval(poll);
  }, 500);
})();`;

module.exports = { MAX_MESSAGE, KINDS, QUEUE_KINDS, CAPS, LISTS, PAGE_LISTS, REPEAT_MODES, MAX_TRACKS, ID_RE, BRIDGE_SOURCE, clip, playbackKind, artUrl, kindOf, cleanItem, parseMessage, cleanCommand, toCard };
