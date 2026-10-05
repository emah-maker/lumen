// The Spotify engine's bridge: a hidden open.spotify.com view runs Spotify's own web player, and a small fixed script (BRIDGE_SOURCE)
// reads what it shows and presses its own controls. Spotify has no in-page player API like Apple's MusicKit, so the script keeps to the
// page's official surface, in this order: (1) navigator.mediaSession.metadata and the page's media element for what is playing here;
// (2) the web player's own controls and playbar, found by their stable data-testid attributes (also what shows playback on ANOTHER
// device through Spotify Connect, which the card then names, and whose buttons drive that device); (3) navigation inside the page
// (the app's own router, no reload, so playback goes on) for search and for playing a result. It never reads the page's access token
// or calls an internal endpoint: no request of its own at all.
//
// All the selectors live in one table (SELECTORS), each with fallbacks. When a signed-in page shows none of the player's controls, the
// state says so (player: false) and the card tells the user Spotify changed its page, instead of showing nothing.
//
// This file is the pure part: the table, the script, and the checks on both directions (the same wire as features/apple-music-bridge.js:
// JSON text in 'lumen-engine-in' / 'lumen-engine-out' DOM events carried by the preload).
'use strict';

const MAX_MESSAGE = 200000;
const KINDS = ['song', 'album', 'playlist', 'artist']; // what playItem takes
const CAPS = { search: true, lists: false, seek: true, queue: false };
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ART_HOST_RE = /^([a-z0-9-]+\.)*scdn\.co$/;
const MAX_ITEMS = 40;

// Every selector the script uses, by what it is for; the first that matches wins. Change them here when Spotify changes its page.
const SELECTORS = {
  playPause: ['[data-testid="control-button-playpause"]', 'footer button[aria-label="Play"], footer button[aria-label="Pause"]'],
  next: ['[data-testid="control-button-skip-forward"]', 'footer button[aria-label="Next"]'],
  previous: ['[data-testid="control-button-skip-back"]', 'footer button[aria-label="Previous"]'],
  progressInput: ['[data-testid="playback-progressbar"] input[type="range"]', '[data-testid="playback-progressbar"] input'],
  position: ['[data-testid="playback-position"]'],
  duration: ['[data-testid="playback-duration"]'],
  nowPlaying: ['[data-testid="now-playing-widget"]'],
  title: ['[data-testid="context-item-link"]', '[data-testid="now-playing-widget"] a[href*="/track/"]', '[data-testid="now-playing-widget"] a[href*="/episode/"]'],
  artist: ['[data-testid="context-item-info-artist"]', '[data-testid="context-item-info-show"]', '[data-testid="now-playing-widget"] a[href*="/artist/"]'],
  cover: ['[data-testid="cover-art-image"]', '[data-testid="now-playing-widget"] img'],
  connect: ['[data-testid="connect-bar"]', '[data-testid="device-picker-icon-button"]'],
  trackRow: ['[data-testid="tracklist-row"]'],
  playButton: ['[data-testid="play-button"]', 'button[data-encore-id="buttonPrimary"][aria-label="Play"]'],
};
// What the script needs to see to say "the player is there".
const REQUIRED = ['playPause'];

const clip = (v, max = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : 0);

function playbackKind(n) { return n === 2 ? 'playing' : n === 3 ? 'paused' : 'idle'; }

// A picture address from the page -> itself when it is https on Spotify's own picture hosts (i.scdn.co, mosaic.scdn.co, ...), else ''.
function artUrl(url) {
  if (typeof url !== 'string' || url.length > 600 || /[\s"'<>\\]/.test(url)) return '';
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && ART_HOST_RE.test(u.hostname) ? u.href : '';
  } catch { return ''; }
}
function kindOf(k) { return KINDS.includes(k) ? k : null; }

function cleanItem(i) {
  if (!i || typeof i !== 'object' || typeof i.id !== 'string' || !ID_RE.test(i.id)) return null;
  const kind = kindOf(i.kind);
  const title = clip(i.title, 120);
  if (!kind || !title) return null;
  return { id: i.id, kind, title, sub: clip(i.sub, 120), ms: Math.round(num(i.ms, 0, 48 * 3600e3)), art: artUrl(i.art) };
}

// A page message (the JSON text) -> a checked object of ours, or null. Never throws. The same shapes as Apple's, so one engine serves both:
//   { t:'ready' } | { t:'error', message }
//   { t:'state', auth:false, state (2 playing, 3 paused, 0 nothing), pos, dur, item: { id:'', kind:'song', title, artist, album, art, ms } | null, device, player }
//   { t:'list', kind:'search', rid, ok, items: [...] }
function parseMessage(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return null;
  let m;
  try { m = JSON.parse(raw); } catch { return null; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  if (m.t === 'ready') return { t: 'ready' };
  if (m.t === 'error') return { t: 'error', message: clip(m.message, 200) };
  if (m.t === 'state') {
    const i = m.item && typeof m.item === 'object' ? m.item : null;
    const title = i ? clip(i.title, 200) : '';
    return {
      t: 'state', auth: false, state: m.state === 2 ? 2 : m.state === 3 ? 3 : 0,
      pos: num(m.pos, 0, 48 * 3600), dur: num(m.dur, 0, 48 * 3600),
      item: title ? { id: '', kind: 'song', title, artist: clip(i.artist, 120), album: clip(i.album, 120), art: artUrl(i.art), ms: Math.round(num(i.ms, 0, 48 * 3600e3)) } : null,
      device: clip(m.device, 60), player: m.player === true,
    };
  }
  if (m.t === 'list') {
    if (m.kind !== 'search') return null;
    return { t: 'list', kind: 'search', rid: Math.round(num(m.rid, 0, 1e9)), ok: m.ok === true, signedOut: false, items: (Array.isArray(m.items) ? m.items : []).slice(0, MAX_ITEMS).map(cleanItem).filter(Boolean) };
  }
  return null;
}

// A command -> the JSON text to send the page, or null when it isn't one of the fixed commands.
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
    case 'search': {
      const term = clip(c.term, 80);
      if (!term) return null;
      return JSON.stringify({ cmd: 'search', term, rid: Math.round(num(c.rid, 0, 1e9)) });
    }
    default: return null;
  }
}

// The state message -> what the card is given (null for nothing to say). `art` is a data: URL ('' when it has none yet).
function toCard(m, now, art = '') {
  const kind = playbackKind(m.state);
  const base = { mode: 'status', title: '', artist: '', album: '', progressMs: 0, durationMs: 0, at: now, source: 'engine', kind: 'none', reason: '', art: '', device: m.device || '' };
  if (!m.item || kind === 'idle') return { ...base, state: 'idle' };
  const durationMs = m.dur > 0 ? Math.round(m.dur * 1000) : m.item.ms;
  const progress = Math.round(m.pos * 1000);
  return {
    ...base, state: kind, title: m.item.title, artist: m.item.artist, album: m.item.album, kind: 'track', art,
    progressMs: durationMs ? Math.min(progress, durationMs) : progress, durationMs, preview: false,
  };
}

// The script that runs in open.spotify.com's own page (the main world), injected by the preload.
const BRIDGE_SOURCE = `(function () {
  var OUT = 'lumen-engine-out', IN = 'lumen-engine-in';
  var SEL = ${JSON.stringify(SELECTORS)}, REQUIRED = ${JSON.stringify(REQUIRED)};
  var KIND_PATH = { song: 'track', album: 'album', playlist: 'playlist', artist: 'artist' };
  var ID = /^[A-Za-z0-9._-]{1,64}$/;
  var last = '', lastSent = 0;
  function out(o) { try { document.dispatchEvent(new CustomEvent(OUT, { detail: JSON.stringify(o) })); } catch (e) {} }
  function q(name, root) {
    var list = SEL[name] || [];
    for (var i = 0; i < list.length; i++) { try { var el = (root || document).querySelector(list[i]); if (el) return el; } catch (e) {} }
    return null;
  }
  function text(el) { return el ? String(el.textContent || '').replace(/\\s+/g, ' ').trim() : ''; }
  function secs(s) {
    var m = /^(?:(\\d+):)?(\\d{1,2}):(\\d{2})$/.exec(String(s || '').trim());
    return m ? (Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) : 0;
  }
  function mediaEl() {
    var els = document.querySelectorAll('audio, video');
    for (var i = 0; i < els.length; i++) { if ((els[i].currentSrc || els[i].src) && isFinite(els[i].duration) && els[i].duration > 0) return els[i]; }
    return null;
  }
  function bestArt(list) {
    var best = '', bw = 1e9;
    (list || []).forEach(function (a) { var w = parseInt(String(a.sizes || '').split('x')[0], 10) || 300; if (w >= 150 && w < bw) { bw = w; best = a.src; } else if (!best) best = a.src; });
    return best;
  }
  function connectName() {
    var el = q('connect');
    var t = text(el);
    var m = /^(?:listening on|playing on|connected to)\\s+(.+)$/i.exec(t);
    if (m) return m[1];
    var foot = document.querySelector('footer');
    if (foot) {
      var spans = foot.querySelectorAll('span, p, div');
      for (var i = 0; i < spans.length; i++) { if (spans[i].children.length === 0) { var mm = /^(?:listening on|playing on)\\s+(.+)$/i.exec(text(spans[i])); if (mm) return mm[1]; } }
    }
    return '';
  }
  function read() {
    var playPause = q('playPause');
    var md = null;
    try { md = navigator.mediaSession && navigator.mediaSession.metadata; } catch (e) {}
    var el = mediaEl();
    var title = '', artist = '', album = '', art = '';
    if (md && md.title) { title = md.title; artist = md.artist || ''; album = md.album || ''; art = bestArt(md.artwork); }
    if (!title) {
      title = text(q('title'));
      var artists = document.querySelectorAll('[data-testid="now-playing-widget"] a[href*="/artist/"]');
      artist = artists.length ? [].map.call(artists, text).join(', ') : text(q('artist'));
      var cover = q('cover');
      art = cover && cover.src ? cover.src : '';
    }
    var label = playPause ? String(playPause.getAttribute('aria-label') || '') : '';
    var playing = playPause ? /^pause/i.test(label) : Boolean(el && !el.paused);
    var pos = 0, dur = 0;
    if (el && md && md.title) { pos = el.currentTime; dur = el.duration; }
    if (!(dur > 0)) { pos = secs(text(q('position'))); dur = secs(text(q('duration'))); }
    return { t: 'state', state: title ? (playing ? 2 : 3) : 0, pos: pos, dur: dur, item: title ? { title: title, artist: artist, album: album, art: art, ms: dur * 1000 } : null, device: connectName(), player: REQUIRED.every(function (n) { return Boolean(q(n)); }) };
  }
  function tick(force) {
    var s = read();
    var key = [s.state, s.item && s.item.title, s.item && s.item.artist, s.device, s.player, Math.round(s.dur)].join('|');
    var now = Date.now();
    if (force || key !== last || now - lastSent > 5000) { last = key; lastSent = now; out(s); }
  }
  function click(name) { var b = q(name); if (b && !b.disabled) { b.click(); return true; } return false; }
  function press(want) {
    var b = q('playPause');
    if (b) { var isPause = /^pause/i.test(String(b.getAttribute('aria-label') || '')); if ((want === 'play' && !isPause) || (want === 'pause' && isPause)) b.click(); return; }
    var el = mediaEl();
    if (el) { try { if (want === 'play') el.play(); else el.pause(); } catch (e) {} }
  }
  function seek(sec) {
    var input = q('progressInput');
    var s = read();
    if (input && s.dur > 0) {
      var max = Number(input.max) || s.dur;
      var value = Math.max(0, Math.min(max, (sec / s.dur) * max));
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    var el = mediaEl();
    if (el) { try { el.currentTime = sec; } catch (e) {} }
  }
  function nav(path) {
    if (location.pathname === path) return;
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }
  function waitFor(fn, ms, done) {
    var t0 = Date.now();
    (function again() { var v = fn(); if (v) { done(v); return; } if (Date.now() - t0 > ms) { done(null); return; } setTimeout(again, 250); })();
  }
  function idOf(href, prefix) {
    if (typeof href !== 'string' || href.indexOf(prefix) !== 0) return '';
    var id = href.slice(prefix.length).split(/[?#/]/)[0];
    return ID.test(id) ? id : '';
  }
  function extract() {
    var items = [], seen = {};
    function add(it) { var k = it.kind + ':' + it.id; if (!it.id || !it.title || seen[k]) return; seen[k] = true; items.push(it); }
    var rows = [];
    (SEL.trackRow || []).forEach(function (s) { try { [].forEach.call(document.querySelectorAll(s), function (r) { rows.push(r); }); } catch (e) {} });
    rows.slice(0, 8).forEach(function (row) {
      var a = row.querySelector('a[href^="/track/"]');
      if (!a) return;
      var artists = [].map.call(row.querySelectorAll('a[href^="/artist/"]'), text).join(', ');
      var dur = 0;
      [].forEach.call(row.querySelectorAll('div, span'), function (d) { if (d.children.length === 0 && /^\\d+:\\d\\d$/.test(text(d))) dur = secs(text(d)); });
      var img = row.querySelector('img');
      add({ id: idOf(a.getAttribute('href'), '/track/'), kind: 'song', title: text(a), sub: artists, ms: dur * 1000, art: img ? img.src : '' });
    });
    [['album', '/album/'], ['artist', '/artist/'], ['playlist', '/playlist/']].forEach(function (kp) {
      var n = 0;
      [].forEach.call(document.querySelectorAll('a[href^="' + kp[1] + '"]'), function (a) {
        if (n >= 8 || a.closest('[data-testid="tracklist-row"], footer, [data-testid="now-playing-widget"]')) return; // (not the song rows' own links, nor the playbar's)
        var id = idOf(a.getAttribute('href'), kp[1]);
        var img = a.querySelector('img');
        var title = text(a) || (img && img.alt) || a.getAttribute('aria-label') || '';
        if (id && title) { add({ id: id, kind: kp[0], title: title, sub: '', ms: 0, art: img ? img.src : '' }); n++; }
      });
    });
    return items;
  }
  function search(term, rid) {
    nav('/search/' + encodeURIComponent(term));
    waitFor(function () { return q('trackRow'); }, 6000, function (found) {
      out({ t: 'list', kind: 'search', rid: rid, ok: Boolean(found), items: found ? extract() : [] });
    });
  }
  function playItem(kind, id) {
    var seg = KIND_PATH[kind];
    if (!seg || !ID.test(id)) return;
    nav('/' + seg + '/' + id);
    waitFor(function () { var b = q('playButton'); return b && !b.disabled ? b : null; }, 6000, function (b) { if (b) b.click(); else out({ t: 'error', message: 'Spotify did not show a play button' }); });
  }
  function run(c) {
    if (!c) return;
    try {
      switch (c.cmd) {
        case 'play': press('play'); break;
        case 'pause': press('pause'); break;
        case 'next': click('next'); break;
        case 'previous': click('previous'); break;
        case 'seek': if (typeof c.sec === 'number' && c.sec >= 0) seek(c.sec); break;
        case 'playItem': if (KIND_PATH[c.kind] && typeof c.id === 'string') playItem(c.kind, c.id); break;
        case 'search': if (typeof c.term === 'string' && c.term) search(c.term.slice(0, 80), Number(c.rid) || 0); break;
      }
    } catch (e) { out({ t: 'error', message: String((e && e.message) || e) }); }
    setTimeout(function () { tick(true); }, 400);
  }
  document.addEventListener(IN, function (e) { var c; try { c = JSON.parse(e.detail); } catch (x) { return; } run(c); });
  out({ t: 'ready' });
  setInterval(function () { tick(false); }, 1000);
  tick(true);
})();`;

module.exports = { MAX_MESSAGE, KINDS, CAPS, ID_RE, SELECTORS, REQUIRED, BRIDGE_SOURCE, clip, playbackKind, artUrl, kindOf, cleanItem, parseMessage, cleanCommand, toCard };
