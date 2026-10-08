// The Spotify engine's bridge: a hidden open.spotify.com view runs Spotify's own web player, and a small fixed script (BRIDGE_SOURCE)
// reads what it shows and presses its own controls. Spotify has no in-page player API like Apple's MusicKit, so the script keeps to the
// page's official surface, in this order: (1) navigator.mediaSession.metadata and the page's media element for what is playing here;
// (2) the web player's own controls and playbar, found by their stable data-testid attributes (also what shows playback on ANOTHER
// device through Spotify Connect, which the card then names, and whose buttons drive that device); (3) navigation inside the page
// (the app's own router, no reload, so playback goes on) for search and for playing a result. It never reads the page's access token
// or calls an internal endpoint: no request of its own at all.
//
// All the selectors live in one table (SELECTORS), each with fallbacks. When a signed-in page shows none of the player's controls, the
// state says so (player: false) and the card tells the user Spotify changed its page, instead of showing nothing. A press of a control the
// page doesn't show is an error message of its own (NO_PLAYER); the page's Log in button is reported as signedOut; and a search says why
// it found nothing (signed out, controls missing, too slow). Search waits for the page's results to stand still with a MutationObserver
// (test/spotify-dom-units.js runs it against pages saved from open.spotify.com).
//
// This file is the pure part: the table, the script, and the checks on both directions (the same wire as features/apple-music-bridge.js:
// JSON text in 'lumen-engine-in' / 'lumen-engine-out' DOM events carried by the preload).
/* global document, window, history, location, PopStateEvent, HTMLInputElement, MutationObserver, MouseEvent */ // (bridgeMain runs in the page)
'use strict';

const MAX_MESSAGE = 200000;
const KINDS = ['song', 'album', 'playlist', 'artist']; // what playItem takes
// What the card may offer from this engine (features/music-card-features.js has the same table by name). `has` in every state message narrows
// like / shuffle / repeat / volume further: only the controls the page really shows are drawn.
const CAPS = { search: true, lists: true, seek: true, queue: true, playNext: false, playLater: true, like: true, shuffle: true, repeat: true, volume: true, tracks: true, lyrics: true, devices: 'browser' };
const LIST_KINDS = ['search', 'queue', 'playlists', 'recent', 'tracks']; // the lists the page can send ('recent': always empty here, Spotify's page has no such list)
const REPEAT_MODES = ['off', 'all', 'one'];
const MAX_TRACKS = 100; // a context's songs, an album or a playlist's first rows
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ART_HOST_RE = /^([a-z0-9-]+\.)*scdn\.co$/;
const MAX_ITEMS = 40;

// Every selector the script uses, by what it is for; the first that matches wins. Change them here when Spotify changes its page.
// Rules: data-testid first, then aria-label / role / href patterns, never class names (they are hashed). Keep each string to the simple
// subset test/spotify-dom-units.js can run against saved pages: tag, [attr], [attr="v"], [attr^=], [attr$=], [attr*=], descendant
// spaces and commas. Checked against open.spotify.com (desktop layout, signed out) on 2026-10-07; "assumed" marks what only a
// signed-in page shows (the now-playing widget) and was not seen.
const SELECTORS = {
  // -- the playbar (the same signed in or out; seen) --
  playPause: ['[data-testid="control-button-playpause"]', 'footer button[aria-label="Play"], footer button[aria-label="Pause"]', '[data-testid="player-controls"] button[aria-label="Play"], [data-testid="player-controls"] button[aria-label="Pause"]'],
  next: ['[data-testid="control-button-skip-forward"]', 'footer button[aria-label="Next"]', '[data-testid="player-controls"] button[aria-label="Next"]'],
  previous: ['[data-testid="control-button-skip-back"]', 'footer button[aria-label="Previous"]', '[data-testid="player-controls"] button[aria-label="Previous"]'],
  // Shuffle: seen signed out as a button with no test id and the label "Enable shuffle" (on: "Disable shuffle"). Repeat: seen, with aria-checked
  // ("false" off, "mixed" repeat all, "true" repeat one when signed in). Volume: seen, a range input in the volume bar, next to a mute button.
  shuffle: ['[data-testid="control-button-shuffle"]', '[data-testid="general-controls"] button[aria-label$="shuffle"]', '[data-testid="player-controls"] button[aria-label$="shuffle"]'],
  repeat: ['[data-testid="control-button-repeat"]', '[data-testid="player-controls"] button[aria-label$="repeat"]'],
  volume: ['[data-testid="volume-bar"] input[type="range"]'],
  // ASSUMED (only a signed-in page has a now-playing widget): its save / like button, checked when the song is saved.
  like: ['[data-testid="now-playing-widget"] button[aria-label="Add to Liked Songs"]', '[data-testid="now-playing-widget"] button[aria-label="Remove from Liked Songs"]', '[data-testid="now-playing-widget"] button[aria-label="Save to Your Library"]', '[data-testid="now-playing-widget"] button[aria-label="Remove from Your Library"]', '[data-testid="now-playing-widget"] [data-testid="add-button"]'],
  progressInput: ['[data-testid="playback-progressbar"] input[type="range"]', '[data-testid="playback-progressbar"] input'],
  position: ['[data-testid="playback-position"]'],
  duration: ['[data-testid="playback-duration"]'],
  nowPlayingBar: ['[data-testid="now-playing-bar"]', 'aside[aria-label="Now playing bar"]'],
  // -- what is playing here or on another device (assumed: the widget only exists while something is loaded) --
  nowPlaying: ['[data-testid="now-playing-widget"]'],
  title: ['[data-testid="context-item-link"]', '[data-testid="now-playing-widget"] a[href*="/track/"]', '[data-testid="now-playing-widget"] a[href*="/episode/"]'],
  artist: ['[data-testid="context-item-info-artist"]', '[data-testid="context-item-info-show"]', '[data-testid="now-playing-widget"] a[href*="/artist/"]'],
  artistLinks: ['[data-testid="now-playing-widget"] a[href*="/artist/"]'],
  cover: ['[data-testid="cover-art-image"]', '[data-testid="now-playing-widget"] img'],
  connect: ['[data-testid="connect-bar"]', '[data-testid="device-picker-icon-button"]'],
  // -- signed in or out (seen: the header's Log in button exists only signed out) --
  loginButton: ['[data-testid="login-button"]'],
  // -- search and results (seen) --
  searchInput: ['[data-testid="search-input"]', 'form[role="search"] input', 'input[type="search"]'],
  main: ['main'],
  trackList: ['[data-testid="track-list"]'],
  trackRow: ['[data-testid="tracklist-row"]'],
  trackLink: ['a[href^="/track/"]'],
  artistHref: ['a[href^="/artist/"]'],
  albumHref: ['a[href^="/album/"]'],
  rowPlay: ['button[aria-label^="Play "]'],
  // Containers whose links are not search results: the song rows' own links, the playbar, the side and top bars.
  chrome: ['[data-testid="tracklist-row"]', 'footer', '[data-testid="now-playing-bar"]', '[data-testid="now-playing-widget"]', 'nav', 'header', '[data-testid="topbar"]'],
  // The big Play button of an item's own page (track, album, artist, playlist): its action bar first, then the sticky top bar's copy. Never
  // a bare play-button of the main area: that is a card of some other item.
  entityPlay: ['[data-testid="action-bar-row"] [data-testid="play-button"]', '[data-testid="topbar-content"] [data-testid="play-button"]'],
  // The item pages (seen, signed out): the title, the action bar's three-dots button, a track page's album link and lyrics box (signed out the
  // box holds only a "Sign in to see lyrics" gate). ASSUMED: the album or playlist the player is playing from, linked in the now-playing widget;
  // a context menu's items and the left library's links (a signed-in page).
  entityTitle: ['[data-testid="entityTitle"]'],
  moreButton: ['[data-testid="action-bar-row"] [data-testid="more-button"]'],
  trackAlbumLink: ['[data-testid="entity-header"] a[href^="/album/"]'],
  lyricsBox: ['[data-testid="lyrics-container"]'],
  lyricsGate: ['[data-testid="static-activation-trigger"]'],
  contextLink: ['[data-testid="context-link"]', '[data-testid="now-playing-widget"] a[href^="/album/"]', '[data-testid="now-playing-widget"] a[href^="/playlist/"]'],
  menuItem: ['[role="menuitem"]', '[role="menu"] button', '[role="menu"] li'],
  libraryLink: ['[aria-label="Your Library"] a[href^="/playlist/"]', '[aria-label="Your Library"] a[href^="/album/"]', '[aria-label="Your Library"] a[href^="/artist/"]', '[data-testid="rootlist"] a[href^="/playlist/"]'],
};
// Words the page shows for states with no element of their own (lower case, matched in the page's main text).
const TEXT = { noResults: ['no results found'], emptyQueue: ['your queue is empty', 'queue is empty'] };
// What the script needs to see to say "the player is there".
const REQUIRED = ['playPause'];
const NO_PLAYER = 'Spotify’s player controls weren’t found. Is the web player signed in?';
const SEARCH_WHY = ['signedOut', 'noPlayer', 'timeout', 'page'];

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
  return { id: i.id, kind, title, sub: clip(i.sub, 120), album: kind === 'song' ? clip(i.album, 120) : '', ms: Math.round(num(i.ms, 0, 48 * 3600e3)), art: artUrl(i.art) };
}

// A page message (the JSON text) -> a checked object of ours, or null. Never throws. The same shapes as Apple's, so one engine serves both:
//   { t:'ready' } | { t:'error', message }
//   { t:'state', auth:false, state (2 playing, 3 paused, 0 nothing), pos, dur, item: { id:'', kind:'song', title, artist, album, art, ms } | null, device, player, signedOut (true | false | null) }
//   { t:'list', kind:'search', rid, ok, partial (the first rows of a search: the whole list follows), more (the songs-only list merged in), why ('signedOut' | 'noPlayer' | 'timeout' | 'page' when not ok), detail, items: [...] }
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
    const has = m.has && typeof m.has === 'object' ? m.has : {};
    return {
      t: 'state', auth: false, state: m.state === 2 ? 2 : m.state === 3 ? 3 : 0,
      pos: num(m.pos, 0, 48 * 3600), dur: num(m.dur, 0, 48 * 3600),
      item: title ? { id: '', kind: 'song', title, artist: clip(i.artist, 120), album: clip(i.album, 120), art: artUrl(i.art), ms: Math.round(num(i.ms, 0, 48 * 3600e3)) } : null,
      device: clip(m.device, 60), player: m.player === true,
      signedOut: m.signedOut === true ? true : m.signedOut === false ? false : null, // the page's own Log in button (null: not known yet)
      shuffle: m.shuffle === true ? true : m.shuffle === false ? false : null, // (null: the page shows no such control)
      repeat: REPEAT_MODES.includes(m.repeat) ? m.repeat : null,
      volume: typeof m.volume === 'number' && Number.isFinite(m.volume) ? Math.round(Math.max(0, Math.min(1, m.volume)) * 100) / 100 : null,
      liked: m.liked === true ? true : m.liked === false ? false : null,
      has: { like: has.like === true, shuffle: has.shuffle === true, repeat: has.repeat === true, volume: has.volume === true },
    };
  }
  if (m.t === 'list') {
    if (!LIST_KINDS.includes(m.kind)) return null;
    const max = m.kind === 'tracks' ? MAX_TRACKS : MAX_ITEMS;
    const ok = m.ok === true;
    return {
      t: 'list', kind: m.kind, rid: Math.round(num(m.rid, 0, 1e9)), ok, partial: m.partial === true, more: m.more === true, signedOut: m.signedOut === true, why: ok ? '' : (SEARCH_WHY.includes(m.why) ? m.why : 'page'), detail: ok ? '' : clip(m.detail, 120),
      title: clip(m.title, 120), current: Number.isInteger(m.current) && m.current >= 0 && m.current < max ? m.current : -1,
      items: (Array.isArray(m.items) ? m.items : []).slice(0, max).map(cleanItem).filter(Boolean),
    };
  }
  if (m.t === 'lyrics') { // the song's words, a line each; `why`: why there are none
    const ok = m.ok === true;
    return { t: 'lyrics', rid: Math.round(num(m.rid, 0, 1e9)), ok, why: ok ? '' : (['signedOut', 'none', 'page'].includes(m.why) ? m.why : 'page'), lines: ok ? (Array.isArray(m.lines) ? m.lines : []).slice(0, 250).map((l) => clip(l, 200)).filter(Boolean) : [] };
  }
  return null;
}

// A command -> the JSON text to send the page, or null when it isn't one of the fixed commands.
function cleanCommand(c) {
  if (!c || typeof c !== 'object') return null;
  const index = (v, max) => (Number.isInteger(v) && v >= 0 && v < max ? v : -1);
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
    case 'playLater': {
      if (!KINDS.includes(c.kind) || c.kind === 'artist' || typeof c.id !== 'string' || !ID_RE.test(c.id)) return null;
      return JSON.stringify({ cmd: 'playLater', kind: c.kind, id: c.id });
    }
    case 'search': {
      const term = clip(c.term, 80);
      if (!term) return null;
      return JSON.stringify({ cmd: 'search', term, rid: Math.round(num(c.rid, 0, 1e9)) });
    }
    case 'searchMore': {
      const term = clip(c.term, 80);
      if (!term) return null;
      return JSON.stringify({ cmd: 'searchMore', term, rid: Math.round(num(c.rid, 0, 1e9)) });
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
    case 'list': {
      if (!['queue', 'playlists', 'recent', 'tracks'].includes(c.kind)) return null;
      return JSON.stringify({ cmd: 'list', kind: c.kind, rid: Math.round(num(c.rid, 0, 1e9)) });
    }
    case 'lyrics': return JSON.stringify({ cmd: 'lyrics', rid: Math.round(num(c.rid, 0, 1e9)) });
    case 'playQueue': case 'playFrom': {
      if (index(c.index, c.cmd === 'playQueue' ? 100 : MAX_TRACKS) < 0) return null;
      if (c.id !== undefined && (typeof c.id !== 'string' || !ID_RE.test(c.id))) return null; // (the song the card showed there: the page checks it is still there)
      return JSON.stringify(c.id === undefined ? { cmd: c.cmd, index: c.index } : { cmd: c.cmd, index: c.index, id: c.id });
    }
    default: return null;
  }
}

// The state message -> what the card is given (null for nothing to say). `art` is a data: URL ('' when it has none yet).
function toCard(m, now, art = '') {
  const kind = playbackKind(m.state);
  const base = { mode: 'status', title: '', artist: '', album: '', progressMs: 0, durationMs: 0, at: now, source: 'engine', kind: 'none', reason: '', art: '', device: m.device || '', liked: m.liked, shuffle: m.shuffle, repeat: m.repeat, volume: m.volume };
  if (!m.item || kind === 'idle') return { ...base, state: 'idle' };
  const durationMs = m.dur > 0 ? Math.round(m.dur * 1000) : m.item.ms;
  const progress = Math.round(m.pos * 1000);
  return {
    ...base, state: kind, title: m.item.title, artist: m.item.artist, album: m.item.album, kind: 'track', art,
    progressMs: durationMs ? Math.min(progress, durationMs) : progress, durationMs, preview: false,
  };
}

// The script that runs in open.spotify.com's own page (the main world), injected by the preload. It is written as a function so it is
// checked like any code, and sent to the page as its source text with the tables as arguments. Nothing in it may refer to this file.
// It runs in the page, so it uses the page's globals; keep comments free of words the safety test looks for in its text.
function bridgeMain(SEL, REQUIRED, TEXT, NO_PLAYER) {
  var OUT = 'lumen-engine-out', IN = 'lumen-engine-in';
  var KIND_PATH = { song: 'track', album: 'album', playlist: 'playlist', artist: 'artist' };
  var ID = /^[A-Za-z0-9._-]{1,64}$/;
  var SEARCH_MS = 10000, STABLE_MS = 700, MORE_MS = 6000, PLAY_MS = 8000;
  var FIRST_MS = 120, SETTLE_MS = 500, TYPE_MS = 1500; // search: the first rows must stand one render pass, the whole list this long, and a typed term this long to move the page
  var last = '', lastSent = 0, loginSince = 0, searchSeq = 0, cancelSearch = null, lastSearch = null;
  function out(o) { try { document.dispatchEvent(new CustomEvent(OUT, { detail: JSON.stringify(o) })); } catch (e) { /* the page is going away */ } }
  function q(name, root) {
    var list = SEL[name] || [];
    for (var i = 0; i < list.length; i++) { try { var el = (root || document).querySelector(list[i]); if (el) return el; } catch (e) { /* a selector this page's engine refuses */ } }
    return null;
  }
  function qa(name, root) {
    var found = [];
    (SEL[name] || []).forEach(function (s) { try { [].forEach.call((root || document).querySelectorAll(s), function (el) { if (found.indexOf(el) < 0) found.push(el); }); } catch (e) { /* a selector this page's engine refuses */ } });
    return found;
  }
  function text(el) { return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
  function secs(s) {
    var m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
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
    var m = /^(?:listening on|playing on|connected to)\s+(.+)$/i.exec(t);
    if (m) return m[1];
    var foot = document.querySelector('footer');
    if (foot) {
      var spans = foot.querySelectorAll('span, p, div');
      for (var i = 0; i < spans.length; i++) { if (spans[i].children.length === 0) { var mm = /^(?:listening on|playing on)\s+(.+)$/i.exec(text(spans[i])); if (mm) return mm[1]; } }
    }
    return '';
  }
  // Signed out is the page's own Log in button, still there a couple of seconds later (not a flash while the page starts): true | false | null (not known yet).
  function signedOutNow() {
    if (q('loginButton')) { loginSince = loginSince || Date.now(); return Date.now() - loginSince >= 2000 ? true : null; }
    loginSince = 0;
    return q('playPause') ? false : null;
  }
  function read() {
    var playPause = q('playPause');
    var md = null;
    try { md = navigator.mediaSession && navigator.mediaSession.metadata; } catch (e) { /* no media session */ }
    var el = mediaEl();
    var title = '', artist = '', album = '', art = '';
    if (md && md.title) { title = md.title; artist = md.artist || ''; album = md.album || ''; art = bestArt(md.artwork); }
    if (!title) {
      title = text(q('title'));
      var artists = qa('artistLinks');
      artist = artists.length ? [].map.call(artists, text).join(', ') : text(q('artist'));
      var cover = q('cover');
      art = cover && cover.src ? cover.src : '';
      if (!title) { // the widget's own label ("Now playing: Song by Artist"), when its parts are not found
        var np = q('nowPlaying');
        var lm = /^now playing:?\s*(.+?)\s+by\s+(.+)$/i.exec(String((np && np.getAttribute('aria-label')) || ''));
        if (lm) { title = lm[1]; artist = artist || lm[2]; }
      }
    }
    var label = playPause ? String(playPause.getAttribute('aria-label') || '') : '';
    var playing = playPause ? /^pause/i.test(label) : Boolean(el && !el.paused);
    var pos = 0, dur = 0;
    if (el && md && md.title) { pos = el.currentTime; dur = el.duration; }
    if (!(dur > 0)) { pos = secs(text(q('position'))); dur = secs(text(q('duration'))); }
    var c = controls();
    return { t: 'state', state: title ? (playing ? 2 : 3) : 0, pos: pos, dur: dur, item: title ? { title: title, artist: artist, album: album, art: art, ms: dur * 1000 } : null, device: connectName(), player: REQUIRED.every(function (n) { return Boolean(q(n)); }), signedOut: signedOutNow(), shuffle: c.shuffle, repeat: c.repeat, volume: c.volume, liked: c.liked, has: c.has };
  }
  // The playbar's switches as the page shows them: shuffle (aria-checked, else "Enable" / "Disable" in the label), repeat (aria-checked: false off, mixed all, true one),
  // volume (the range input's value over its max), liked (aria-checked, else a "Remove" label). null where the page shows no such control.
  function label(el) { return String((el && el.getAttribute('aria-label')) || ''); }
  function checked(el) { var v = el ? el.getAttribute('aria-checked') : null; return v === 'true' ? true : v === 'false' ? false : v === 'mixed' ? 'mixed' : null; }
  function shuffleOn() {
    var b = q('shuffle');
    if (!b) return null;
    var c = checked(b);
    if (c === true || c === false) return c;
    var l = label(b);
    return /^disable/i.test(l) ? true : /^enable/i.test(l) ? false : null;
  }
  function repeatMode() {
    var b = q('repeat');
    if (!b) return null;
    var c = checked(b);
    if (c !== null) return c === 'mixed' ? 'all' : c ? 'one' : 'off';
    var l = label(b).toLowerCase();
    return l.indexOf('repeat one') >= 0 ? 'all' : l.indexOf('disable') === 0 ? 'one' : l.indexOf('enable') === 0 ? 'off' : null;
  }
  function volumeLevel() {
    var input = q('volume');
    if (!input) return null;
    var max = Number(input.max) || 1, v = Number(input.value);
    return isFinite(v) ? Math.max(0, Math.min(1, v / max)) : null;
  }
  function likedNow() {
    var b = q('like');
    if (!b) return null;
    var c = checked(b);
    if (c === true || c === false) return c;
    var l = label(b);
    return /^(remove|saved)/i.test(l) ? true : /^(add|save)/i.test(l) ? false : null;
  }
  function controls() {
    return { shuffle: shuffleOn(), repeat: repeatMode(), volume: volumeLevel(), liked: likedNow(), has: { like: Boolean(q('like')), shuffle: Boolean(q('shuffle')), repeat: Boolean(q('repeat')), volume: Boolean(q('volume')) } };
  }
  function tick(force) {
    var s = read();
    var key = [s.state, s.item && s.item.title, s.item && s.item.artist, s.device, s.player, s.signedOut, Math.round(s.dur), s.shuffle, s.repeat, s.liked, s.volume === null ? '' : Math.round(s.volume * 100), s.has.like, s.has.shuffle, s.has.repeat, s.has.volume].join('|');
    var now = Date.now();
    if (force || key !== last || now - lastSent > 5000) { last = key; lastSent = now; out(s); }
  }
  // A button of the page's own player. Not found is said out loud (the card tells the user), not swallowed.
  function click(name) {
    var b = q(name);
    if (!b) { out({ t: 'error', message: NO_PLAYER }); return false; }
    if (!b.disabled) b.click();
    return true;
  }
  function press(want) {
    var b = q('playPause');
    if (b) { var isPause = /^pause/i.test(String(b.getAttribute('aria-label') || '')); if ((want === 'play' && !isPause) || (want === 'pause' && isPause)) b.click(); return; }
    var el = mediaEl();
    if (el) { try { if (want === 'play') el.play(); else el.pause(); } catch (e) { /* the page refused */ } return; }
    out({ t: 'error', message: NO_PLAYER });
  }
  function seek(sec) {
    var input = q('progressInput');
    var s = read();
    if (input && !(s.dur > 0)) return; // (the page has the slider but nothing is loaded: nothing to seek)
    if (input) {
      var max = Number(input.max) || s.dur;
      var value = Math.max(0, Math.min(max, (sec / s.dur) * max));
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    var el = mediaEl();
    if (el) { try { el.currentTime = sec; } catch (e) { /* the page refused */ } return; }
    out({ t: 'error', message: NO_PLAYER });
  }

  // ---- moving around: the page's own router, no reload (a reload would stop the music) ----
  function pathOf(p) { var s = String(p || ''); try { s = decodeURIComponent(s); } catch (e) { /* keep it as it is */ } return s.replace(/\/+$/, '').toLowerCase(); }
  // On this route, or below it (/search/term/tracks is on /search/term)?
  function onPath(path) { var here = pathOf(location.pathname), want = pathOf(path); return here === want || here.indexOf(want + '/') === 0; }
  function nav(path) {
    if (pathOf(location.pathname) === pathOf(path)) return;
    history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }
  // Runs fn(poke) whenever the page changes (a MutationObserver; a slow timer only as a safety net, and the only trigger where there is
  // no observer) until it returns something, or ms pass (then done(null)). poke(ms) asks for one more run in ms (a page that has to stand
  // still for a while). Returns a function that stops the wait without calling done.
  function watch(fn, ms, done) {
    var finished = false, mo = null, safety = null, deadline = null, pending = null, lastRun = 0;
    function stop() { finished = true; clearTimeout(safety); clearTimeout(deadline); clearTimeout(pending); if (mo) { try { mo.disconnect(); } catch (e) { /* gone */ } } }
    function run() {
      pending = null;
      if (finished) return;
      lastRun = Date.now();
      var v;
      try { v = fn(poke); } catch (e) { v = null; }
      if (v) { stop(); done(v); }
    }
    function poke(wait) { if (finished) return; clearTimeout(pending); pending = setTimeout(run, Math.max(0, wait)); }
    function soon() { if (finished || pending) return; poke(120 - (Date.now() - lastRun)); } // (the playbar changes every second: not a run for each change)
    if (typeof MutationObserver === 'function') {
      mo = new MutationObserver(soon);
      mo.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'href'] });
    }
    (function again() { safety = setTimeout(function () { run(); if (!finished) again(); }, mo ? 1000 : 250); })();
    deadline = setTimeout(function () { if (!finished) { stop(); done(null); } }, ms);
    run();
    return function () { if (!finished) stop(); };
  }
  function idOf(href, prefix) {
    if (typeof href !== 'string' || href.indexOf(prefix) !== 0) return '';
    var id = href.slice(prefix.length).split(/[?#/]/)[0];
    return ID.test(id) ? id : '';
  }
  function rowItem(row) {
    var a = q('trackLink', row);
    if (!a) return null;
    var dur = 0;
    [].forEach.call(row.querySelectorAll('div, span'), function (d) { if (d.children.length === 0 && /^\d+:\d\d$/.test(text(d))) dur = secs(text(d)); });
    var img = row.querySelector('img');
    return { id: idOf(a.getAttribute('href'), '/track/'), kind: 'song', title: text(a), sub: qa('artistHref', row).map(text).join(', '), album: text(q('albumHref', row)), ms: dur * 1000, art: img ? img.src : '' };
  }
  // What the page lists now: song rows (title, artists, album, length, picture, the track's id: spotify:track:<id>), then albums, artists and
  // playlists by their links. Only the results area: the library and the playbar have such links too.
  function extract() {
    var items = [], seen = {};
    function add(it) { if (!it) return; var k = it.kind + ':' + it.id; if (!it.id || !it.title || seen[k]) return; seen[k] = true; items.push(it); }
    var root = q('main') || document;
    var chrome = (SEL.chrome || []).join(', ');
    qa('trackRow', root).slice(0, 8).forEach(function (row) { add(rowItem(row)); });
    [['album', '/album/'], ['artist', '/artist/'], ['playlist', '/playlist/']].forEach(function (kp) {
      var n = 0;
      [].forEach.call(root.querySelectorAll('a[href^="' + kp[1] + '"]'), function (a) {
        if (n >= 8 || (chrome && a.closest(chrome))) return; // (not the song rows' own links, nor the playbar's, nor the side bar's)
        var id = idOf(a.getAttribute('href'), kp[1]);
        var img = a.querySelector('img');
        var title = text(a) || (img && img.alt) || a.getAttribute('aria-label') || '';
        if (id && title) { add({ id: id, kind: kp[0], title: title, sub: '', album: '', ms: 0, art: img ? img.src : '' }); n++; }
      });
    });
    return items;
  }
  function sigOf(items) { return items.map(function (i) { return i.kind + ':' + i.id; }).join(','); }
  function noResults() {
    var m = q('main');
    var t = m ? text(m).toLowerCase() : '';
    return TEXT.noResults.some(function (w) { return t.indexOf(w) >= 0; });
  }
  function diag() {
    return ('path ' + location.pathname + ', ' + qa('trackRow').length + ' song rows, ' + (q('main') ? 'main' : 'no main') + ', ' + (q('playPause') ? 'player' : 'no player')).slice(0, 120);
  }
  // Why a search found nothing: signed out, the player's controls missing (the page changed), or just too slow.
  function whyNot() {
    if (q('loginButton')) return 'signedOut';
    if (!q('playPause')) return 'noPlayer';
    return 'timeout';
  }
  // The search box, as the page's own input is used (typing into it makes the page open the results by itself): a second way in.
  function typeIntoBox(term) {
    var input = q('searchInput');
    if (!input) return false;
    try {
      var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, term);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    } catch (e) { return false; }
  }
  // On a search page of its own (/search or /search/<term>, not the songs-only list below it): the page's search box is there to type into.
  function onSearchRoot() { return /^\/search(\/[^\/]+)?$/.test(pathOf(location.pathname)); }
  // Search: when the page is already on a search page its own box is typed into and the page opens the results by itself (no new route);
  // otherwise /search/<term> is opened. The first rows that show for THIS term are sent at once (partial: more may follow), and the whole list
  // once it stands still. A newer search stops this one at its next look (searchSeq), so an older term's rows are never sent.
  // The songs-only list (more songs) is a second route and is opened only when asked for (searchMore).
  function search(term, rid) {
    var seq = ++searchSeq;
    if (cancelSearch) cancelSearch();
    var target = '/search/' + encodeURIComponent(term);
    var startSig = sigOf(extract());
    var wasThere = onPath(target);
    var t0 = Date.now(), stableSig = '', stableAt = 0, firstSig = '', firstAt = 0, sentSig = '', typed = false, navTried = false, boxTried = false;
    lastSearch = null;
    if (!wasThere) {
      if (onSearchRoot() && typeIntoBox(term)) typed = true; else nav(target);
    }
    cancelSearch = watch(function (poke) {
      if (seq !== searchSeq) return null;
      var age = Date.now() - t0;
      if (!onPath(target)) {
        if (typed && age > TYPE_MS && !navTried) { navTried = true; nav(target); } // (the box did not move the page: the route is opened)
        else if (!typed && age > 2500 && !boxTried) { boxTried = true; typeIntoBox(term); }
        return null;
      }
      var items = extract();
      if (!items.length) return noResults() ? { items: [] } : null;
      var sig = sigOf(items);
      if (sig === startSig && !wasThere) return null; // (what the page showed before: until it shows this search's results, or the wait ends)
      if (!sentSig) { // the first rows: sent once they have stood one render pass
        if (sig !== firstSig) { firstSig = sig; firstAt = Date.now(); poke(FIRST_MS + 10); return null; }
        if (Date.now() - firstAt < FIRST_MS) { poke(FIRST_MS - (Date.now() - firstAt) + 10); return null; }
        sentSig = sig;
        out({ t: 'list', kind: 'search', rid: rid, ok: true, partial: true, items: items });
      }
      if (sig !== stableSig) { stableSig = sig; stableAt = Date.now(); poke(SETTLE_MS + 20); return null; }
      if (Date.now() - stableAt < SETTLE_MS) { poke(SETTLE_MS - (Date.now() - stableAt) + 20); return null; }
      return { items: items };
    }, SEARCH_MS, function (found) {
      if (seq !== searchSeq) return;
      if (!found) { out({ t: 'list', kind: 'search', rid: rid, ok: false, why: whyNot(), detail: diag(), items: [] }); return; }
      lastSearch = { term: term, rid: rid, items: found.items };
      out({ t: 'list', kind: 'search', rid: rid, ok: true, items: found.items });
    });
  }
  // More songs for the search just answered: the songs-only list (/search/<term>/tracks), merged under the same request number.
  function searchMore(term, rid) {
    if (!lastSearch || lastSearch.rid !== rid || lastSearch.term.toLowerCase() !== term.toLowerCase()) return; // (an older search, or one still running)
    var seq = ++searchSeq;
    if (cancelSearch) cancelSearch();
    moreSongs(term, rid, lastSearch.items, seq);
  }
  function moreSongs(term, rid, items, seq) {
    var have = items.filter(function (i) { return i.kind === 'song'; }).length;
    var path = '/search/' + encodeURIComponent(term) + '/tracks';
    var low = term.toLowerCase();
    nav(path);
    cancelSearch = watch(function () {
      if (seq !== searchSeq || !onPath(path)) return null;
      var list = q('trackList');
      var label = list ? String(list.getAttribute('aria-label') || '').toLowerCase() : '';
      if (label.indexOf(low) < 0) return null; // (the previous page's list, until this one's label shows)
      var rows = qa('trackRow', list).slice(0, 8).map(rowItem).filter(function (r) { return r && r.id; });
      return rows.length > have ? rows : null;
    }, MORE_MS, function (rows) {
      if (seq !== searchSeq) return;
      var seen = {}, merged = [];
      (rows || []).concat(items).forEach(function (i) { var k = i.kind + ':' + i.id; if (!seen[k]) { seen[k] = true; merged.push(i); } });
      lastSearch = { term: term, rid: rid, items: merged };
      out({ t: 'list', kind: 'search', rid: rid, ok: true, more: true, items: merged }); // (also when the page had no more: the card stops waiting)
    });
  }
  function pageKey() { var m = q('main'); return m ? text(m).slice(0, 300) : ''; } // (what the page is about: its text differs from one item's page to the next)
  // Play an item: a song listed on this page by its own row's button; anything else by its own page's big Play button.
  function playItem(kind, id) {
    var seg = KIND_PATH[kind];
    if (!seg || !ID.test(id)) return;
    if (kind === 'song') {
      var rows = qa('trackRow', q('main') || document);
      for (var i = 0; i < rows.length; i++) {
        var a = q('trackLink', rows[i]);
        if (a && idOf(a.getAttribute('href'), '/track/') === id) { var rb = q('rowPlay', rows[i]); if (rb && !rb.disabled) { rb.click(); return; } }
      }
    }
    var path = '/' + seg + '/' + id;
    var wasHere = onPath(path), before = pageKey(), seenKey = '', seenAt = 0;
    nav(path);
    // The item's own page: on its route, with its Play button, and not the page that was showing before (until the router replaces it), standing still.
    watch(function (poke) {
      if (!onPath(path)) return null;
      var b = q('entityPlay');
      if (!b || b.disabled) return null;
      var key = pageKey();
      if (!wasHere && before && key === before) return null;
      if (key !== seenKey) { seenKey = key; seenAt = Date.now(); poke(STABLE_MS / 2 + 20); return null; }
      return Date.now() - seenAt >= STABLE_MS / 2 ? b : null;
    }, PLAY_MS, function (b) {
      if (b) b.click();
      else out({ t: 'error', message: q('playPause') ? 'Spotify didn’t show a play button for that item.' : NO_PLAYER });
    });
  }
  // ---- the playbar's switches ----
  function setValue(input, v) {
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, String(v));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function setVolume(level) {
    var input = q('volume');
    if (!input) { out({ t: 'error', message: NO_PLAYER }); return; }
    setValue(input, level * (Number(input.max) || 1));
  }
  function setShuffle(on) {
    var b = q('shuffle');
    if (!b) { out({ t: 'error', message: NO_PLAYER }); return; }
    if (shuffleOn() !== on && !b.disabled) b.click();
  }
  // Repeat goes round off -> all -> one when pressed: press, look again, until it is the wanted mode (never more than three presses).
  function setRepeat(mode) {
    var b = q('repeat');
    if (!b) { out({ t: 'error', message: NO_PLAYER }); return; }
    var presses = 0;
    (function step() {
      var now = repeatMode();
      if (now === mode || now === null || presses >= 3 || b.disabled) { tick(true); return; }
      presses++;
      b.click();
      setTimeout(step, 180);
    })();
  }
  function setLiked(on) {
    var b = q('like');
    if (!b) { out({ t: 'error', message: NO_PLAYER }); return; }
    if (likedNow() !== on && !b.disabled) b.click();
  }

  // ---- reading pages the player's own router can open: the queue, the album or playlist playing, the song's lyrics, the library ----
  var cancelTask = null;
  // One page task at a time (the page can only be on one route): a new one stops the last, and a running search too.
  function startTask(runner) {
    searchSeq++;
    if (cancelSearch) { cancelSearch(); cancelSearch = null; }
    if (cancelTask) { cancelTask(); cancelTask = null; }
    cancelTask = runner();
  }
  function currentTrackId() {
    var a = q('title');
    return a ? idOf(a.getAttribute('href'), '/track/') : '';
  }
  function rowsOf(root) { return qa('trackRow', root || q('main') || document).filter(function (r) { return Boolean(q('trackLink', r)); }); }
  // A page about to be opened: what the page shows now, so that rows still on it (the router replaces the content a moment after the address
  // changes) are never taken for the new page's.
  function arriving(path) { return { sig: '', at: 0, before: pageKey(), here: onPath(path) }; }
  // The rows on a page that stand still (the same rows 300 ms apart), as items; null while the page is still filling in.
  function stableRows(state, poke, path) {
    if (path && !onPath(path)) return null;
    if (state.before !== undefined && !state.here && pageKey() === state.before) return null;
    var items = rowsOf().slice(0, 100).map(rowItem).filter(function (r) { return r && r.id; });
    var sig = sigOf(items);
    if (sig !== state.sig) { state.sig = sig; state.at = Date.now(); poke(320); return null; }
    if (Date.now() - state.at < 300) { poke(320 - (Date.now() - state.at)); return null; }
    return items;
  }
  function failList(kind, rid, why, detail) { out({ t: 'list', kind: kind, rid: rid, ok: false, why: why, detail: detail || diag(), items: [] }); }
  // The queue: the page's queue route lists the playing song first, then what is next.
  function readQueue(rid) {
    if (!q('playPause')) { failList('queue', rid, q('loginButton') ? 'signedOut' : 'noPlayer'); return; }
    var t0 = Date.now(), st = arriving('/queue');
    nav('/queue');
    startTask(function () {
      return watch(function (poke) {
        if (!onPath('/queue')) return null;
        var items = stableRows(st, poke, '/queue');
        if (items && items.length) return { items: items.slice(1, 60) };
        var m = q('main'), t = m ? text(m).toLowerCase() : '';
        if (!rowsOf().length && Date.now() - t0 > 3000 && TEXT.emptyQueue.some(function (w) { return t.indexOf(w) >= 0; })) return { items: [] };
        return null;
      }, MORE_MS + 2000, function (found) {
        if (!found) { failList('queue', rid, whyNot()); return; }
        out({ t: 'list', kind: 'queue', rid: rid, ok: true, items: found.items });
      });
    });
  }
  // The page of what is playing (its album, or the playlist when the widget links one), found without leaving the player: the widget's own
  // link, else the song's page and its album link. cb(path | '').
  function contextPath(cb) {
    var link = q('contextLink');
    var href = link ? String(link.getAttribute('href') || '') : '';
    if (/^\/(album|playlist)\/[A-Za-z0-9._-]{1,64}/.test(href)) { cb(href.split(/[?#]/)[0]); return; }
    var id = currentTrackId();
    if (!id) { cb(''); return; }
    var here = onPath('/track/' + id), before = pageKey();
    nav('/track/' + id);
    startTask(function () {
      return watch(function () {
        if (!onPath('/track/' + id) || (!here && pageKey() === before)) return null;
        var a = q('trackAlbumLink');
        return a ? String(a.getAttribute('href') || '').split(/[?#]/)[0] : null;
      }, MORE_MS, function (path) { cb(path && /^\/album\/[A-Za-z0-9._-]{1,64}$/.test(path) ? path : ''); });
    });
  }
  var lastTracksPath = '';
  function readTracks(rid) {
    if (!q('playPause')) { failList('tracks', rid, q('loginButton') ? 'signedOut' : 'noPlayer'); return; }
    var id = currentTrackId();
    contextPath(function (path) {
      if (!path) { failList('tracks', rid, 'page', 'no album or playlist for this song'); return; }
      lastTracksPath = path;
      var st = arriving(path);
      nav(path);
      startTask(function () {
        return watch(function (poke) { return stableRows(st, poke, path); }, MORE_MS + 2000, function (items) {
          if (!items) { failList('tracks', rid, whyNot()); return; }
          var cur = -1;
          items.forEach(function (it, i) { if (cur < 0 && it.id === id) cur = i; });
          var h = q('entityTitle');
          out({ t: 'list', kind: 'tracks', rid: rid, ok: true, title: text(h), current: cur, items: items });
        });
      });
    });
  }
  // Click the play button of the n-th row of a page (the queue's, an album's): once the page's rows have stood still.
  function playRow(path, n, skipFirst, id) {
    var st = arriving(path), want = n + (skipFirst ? 1 : 0);
    nav(path);
    startTask(function () {
      return watch(function (poke) {
        var items = stableRows(st, poke, path);
        return items && items.length > want ? { n: want } : null;
      }, PLAY_MS, function (found) {
        var row = found ? rowsOf()[found.n] : null;
        var link = row ? q('trackLink', row) : null;
        if (row && id && (!link || idOf(link.getAttribute('href'), '/track/') !== id)) { out({ t: 'error', message: 'The list changed. Look again.' }); return; }
        var b = row ? q('rowPlay', row) : null;
        if (b && !b.disabled) { b.click(); return; }
        if (row) { row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return; }
        out({ t: 'error', message: q('playPause') ? 'Spotify didn’t show that song to play.' : NO_PLAYER });
      });
    });
  }
  // Lyrics: the song's own page has them (signed in); signed out it only says to sign in.
  function readLyrics(rid) {
    var id = currentTrackId();
    if (!id) { out({ t: 'lyrics', rid: rid, ok: false, why: 'none', lines: [] }); return; }
    var wasHere = onPath('/track/' + id), before = pageKey();
    nav('/track/' + id);
    startTask(function () {
      return watch(function (poke) {
        if (!onPath('/track/' + id) || (!wasHere && pageKey() === before)) return null;
        var box = q('lyricsBox');
        if (!box) return null;
        if (q('lyricsGate', box)) return { why: 'signedOut' };
        var lines = [];
        [].forEach.call(box.querySelectorAll('div, span, p, a'), function (n) {
          if (n.children.length > 0) return;
          var t = text(n);
          if (t && t.toLowerCase() !== 'lyrics' && lines[lines.length - 1] !== t) lines.push(t);
        });
        if (!lines.length) { poke(500); return null; }
        return { lines: lines };
      }, MORE_MS, function (found) {
        if (!found) { out({ t: 'lyrics', rid: rid, ok: false, why: 'none', lines: [] }); return; }
        if (found.why) { out({ t: 'lyrics', rid: rid, ok: false, why: found.why, lines: [] }); return; }
        out({ t: 'lyrics', rid: rid, ok: true, lines: found.lines });
      });
    });
  }
  // The library as the left bar lists it (already on the page: nothing to open), in the page's own order (recents first).
  function readLibrary(kind, rid) {
    if (kind === 'recent') { out({ t: 'list', kind: 'recent', rid: rid, ok: true, items: [] }); return; }
    var items = [], seen = {};
    qa('libraryLink').forEach(function (a) {
      var href = String(a.getAttribute('href') || '');
      var m = /^\/(playlist|album|artist)\/([A-Za-z0-9._-]{1,64})/.exec(href);
      if (!m || seen[href] || items.length >= 40) return;
      var img = a.querySelector('img');
      var title = text(a) || (img && img.alt) || a.getAttribute('aria-label') || '';
      if (!title) return;
      seen[href] = true;
      items.push({ id: m[2], kind: m[1], title: title, sub: '', album: '', ms: 0, art: img ? img.src : '' });
    });
    out({ t: 'list', kind: 'playlists', rid: rid, ok: true, signedOut: Boolean(q('loginButton')), items: items });
  }
  // Add to queue: the item's own page, its three-dots menu, the "Add to queue" entry.
  function queueAdd(kind, id) {
    var seg = KIND_PATH[kind];
    if (!seg || kind === 'artist' || !ID.test(id)) return;
    var path = '/' + seg + '/' + id, step = 0, menuAt = 0;
    nav(path);
    startTask(function () {
      return watch(function (poke) {
        if (!onPath(path)) return null;
        if (step === 0) {
          var more = q('moreButton');
          if (!more) return null;
          step = 1; menuAt = Date.now();
          more.click();
        }
        var items = qa('menuItem');
        for (var i = 0; i < items.length; i++) { if (text(items[i]).toLowerCase() === 'add to queue') return items[i]; }
        if (Date.now() - menuAt > 2500 && step === 1) { step = 2; return { none: true }; }
        poke(150);
        return null;
      }, PLAY_MS, function (found) {
        if (found && !found.none) { found.click(); return; }
        out({ t: 'error', message: q('playPause') ? 'Spotify didn’t offer “Add to queue” for that.' : NO_PLAYER });
      });
    });
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
        case 'searchMore': if (typeof c.term === 'string' && c.term) searchMore(c.term.slice(0, 80), Number(c.rid) || 0); break;
        case 'like': if (typeof c.on === 'boolean') setLiked(c.on); break;
        case 'shuffle': if (typeof c.on === 'boolean') setShuffle(c.on); break;
        case 'repeat': if (c.mode === 'off' || c.mode === 'all' || c.mode === 'one') setRepeat(c.mode); break;
        case 'volume': if (typeof c.level === 'number' && c.level >= 0 && c.level <= 1) setVolume(c.level); break;
        case 'list': {
          var rid = Number(c.rid) || 0;
          if (c.kind === 'queue') readQueue(rid); else if (c.kind === 'tracks') readTracks(rid); else if (c.kind === 'playlists' || c.kind === 'recent') readLibrary(c.kind, rid);
          break;
        }
        case 'lyrics': readLyrics(Number(c.rid) || 0); break;
        case 'playQueue': if (typeof c.index === 'number' && c.index >= 0) playRow('/queue', c.index, true, typeof c.id === 'string' ? c.id : ''); break;
        case 'playFrom': if (typeof c.index === 'number' && c.index >= 0 && lastTracksPath) playRow(lastTracksPath, c.index, false, typeof c.id === 'string' ? c.id : ''); break;
        case 'playLater': if (KIND_PATH[c.kind] && typeof c.id === 'string') queueAdd(c.kind, c.id); break;
      }
    } catch (e) { out({ t: 'error', message: String((e && e.message) || e) }); }
    setTimeout(function () { tick(true); }, 400);
  }
  document.addEventListener(IN, function (e) { var c; try { c = JSON.parse(e.detail); } catch (x) { return; } run(c); });
  out({ t: 'ready' });
  setInterval(function () { tick(false); }, 1000);
  tick(true);
}
const BRIDGE_SOURCE = `(${bridgeMain.toString()})(${JSON.stringify(SELECTORS)}, ${JSON.stringify(REQUIRED)}, ${JSON.stringify(TEXT)}, ${JSON.stringify(NO_PLAYER)});`;

module.exports = { MAX_MESSAGE, KINDS, CAPS, LIST_KINDS, REPEAT_MODES, MAX_TRACKS, ID_RE, SELECTORS, TEXT, REQUIRED, NO_PLAYER, SEARCH_WHY, BRIDGE_SOURCE, clip, playbackKind, artUrl, kindOf, cleanItem, parseMessage, cleanCommand, toCard };
