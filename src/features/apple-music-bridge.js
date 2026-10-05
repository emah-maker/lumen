// The Apple Music engine's bridge: a hidden music.apple.com view in which Apple's own MusicKit JS plays the music, and a small
// fixed script (BRIDGE_SOURCE) that watches MusicKit and reports a compact state to main, and does the few things the card
// asks for. This file is the pure part: that script, and the checks on both directions. Nothing from the page is trusted:
// every message it sends is parsed and bounded here, and every command main sends is picked from a fixed set with validated
// arguments (the script runs no text it is given; it only reads a JSON object and switches on a fixed name).
//
// Wire: main -> page: JSON string {cmd, ...} as the `detail` of a 'lumen-am-in' DOM event (the preload dispatches it);
//       page -> main: JSON string as the `detail` of a 'lumen-am-out' event (the preload forwards it by IPC).
'use strict';

const MAX_MESSAGE = 200000;
const KINDS = ['song', 'album', 'playlist', 'station']; // what setQueue can be given
const LISTS = ['recent', 'playlists'];
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const STOREFRONT_RE = /^[a-z]{2}$/;
const ART_HOST_RE = /^[a-z0-9-]+\.mzstatic\.com$/;
const MAX_ITEMS = 12;

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
  return { id: i.id, kind, title, sub: clip(i.sub, 120) };
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
    return {
      t: 'state', auth: m.auth === true, state: Math.round(num(m.state, 0, 20)),
      pos: num(m.pos, 0, 48 * 3600), dur: num(m.dur, 0, 48 * 3600), item,
      store: typeof m.store === 'string' && STOREFRONT_RE.test(m.store) ? m.store : '',
    };
  }
  if (m.t === 'list') {
    if (!LISTS.includes(m.kind) && m.kind !== 'search') return null;
    return {
      t: 'list', kind: m.kind, rid: Math.round(num(m.rid, 0, 1e9)), ok: m.ok === true, signedOut: m.signedOut === true,
      items: (Array.isArray(m.items) ? m.items : []).slice(0, MAX_ITEMS).map(cleanItem).filter(Boolean),
    };
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
    case 'list': {
      if (!LISTS.includes(c.kind)) return null;
      return JSON.stringify({ cmd: 'list', kind: c.kind, rid: Math.round(num(c.rid, 0, 1e9)) });
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
  const base = { mode: 'status', title: '', artist: '', album: '', progressMs: 0, durationMs: 0, at: now, source: 'engine', kind: 'none', reason: '', art: '' };
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
  var OUT = 'lumen-am-out', IN = 'lumen-am-in';
  var KINDS = ${JSON.stringify(KINDS)}, LISTS = ${JSON.stringify(LISTS)};
  var ID = /^[A-Za-z0-9._-]{1,64}$/, STORE = /^[a-z]{2}$/;
  var mk = null, lastProgress = 0;
  function out(o) { try { document.dispatchEvent(new CustomEvent(OUT, { detail: JSON.stringify(o) })); } catch (e) {} }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : 0; }
  function item() {
    var i = mk && mk.nowPlayingItem;
    if (!i) return null;
    return { id: String(i.id || ''), type: String(i.type || ''), title: String(i.title || ''), artist: String(i.artistName || ''), album: String(i.albumName || ''), art: String(i.artworkURL || (i.artwork && i.artwork.url) || ''), ms: num(i.playbackDuration) };
  }
  function snapshot() {
    if (!mk) return;
    out({ t: 'state', auth: Boolean(mk.isAuthorized), state: num(mk.playbackState), pos: num(mk.currentPlaybackTime), dur: num(mk.currentPlaybackDuration), item: item(), store: String(mk.storefrontId || '') });
  }
  function fail(e) { out({ t: 'error', message: String((e && (e.message || e.errorCode)) || e || 'error') }); }
  function map(data) {
    return (data || []).map(function (d) {
      var a = d.attributes || {};
      return { id: String(d.id || ''), type: String(d.type || ''), title: String(a.name || ''), sub: String(a.artistName || a.curatorName || (a.playParams && a.playParams.kind) || '') };
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
  function search(term, rid) {
    var store = String(mk.storefrontId || 'us');
    if (!STORE.test(store)) store = 'us';
    mk.api.music('/v1/catalog/' + store + '/search', { term: term, types: 'songs,albums,playlists', limit: 4 }).then(function (r) {
      var res = (r && r.data && r.data.results) || {};
      var items = [].concat(map(res.songs && res.songs.data), map(res.albums && res.albums.data), map(res.playlists && res.playlists.data));
      out({ t: 'list', kind: 'search', rid: rid, ok: true, items: items });
    }, function () { out({ t: 'list', kind: 'search', rid: rid, ok: false, items: [] }); });
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
          var q = {}; q[c.kind] = c.id;
          mk.setQueue(q).then(function () { return mk.play(); }).catch(fail);
          break;
        }
        case 'list': if (LISTS.indexOf(c.kind) >= 0) list(c.kind, num(c.rid)); break;
        case 'search': if (typeof c.term === 'string' && c.term) search(c.term.slice(0, 80), num(c.rid)); break;
      }
    } catch (e) { fail(e); }
  }
  function hook(m) {
    mk = m;
    ['nowPlayingItemDidChange', 'playbackStateDidChange', 'playbackDurationDidChange', 'authorizationStatusDidChange', 'storefrontIdDidChange'].forEach(function (ev) { try { m.addEventListener(ev, snapshot); } catch (e) {} });
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

module.exports = { MAX_MESSAGE, KINDS, LISTS, ID_RE, BRIDGE_SOURCE, clip, playbackKind, artUrl, kindOf, cleanItem, parseMessage, cleanCommand, toCard };
