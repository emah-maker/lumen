// The music card on the new-tab page (Spotify, in all its modes; Apple Music): one card that does more as it gets bigger.
//
//   small   art, title and artist, play / pause, next, a thin progress bar
//   medium  + previous, a seek bar with times, the heart (like / love), shuffle, repeat, volume
//   large   + tabs inside the card: Search (results with play buttons), Up next (the queue: play from it, add to it from a search), Library (recent plays
//           and playlists: click to play), Devices (Spotify's API mode: pick the output; "Play as Lumen": this browser)
//   xl      + the album or playlist playing (a track list: play from here) and the lyrics, where the service has them
//
// What is shown at a size is CSS (container queries on the card, numbers from features/music-card-features.js: a test compares them), so a card
// that is resized only changes what it shows; what a control may do is the engine's `can` (a control it can't do is `hidden`, never a broken button).
//
// The card is built ONCE and then updated in place (view.update): renderer/newtab-widgets.js calls update() when the data moved on (a new song, a
// switch, a list that arrived) instead of drawing a new card, so a typed search, an open tab, a scrolled list and a volume slider being dragged stay
// where they are. A card is only built again when its shell changes (features/widget-card-key.js). Everything from main is a checked string or number
// set with textContent; the only addresses are data: URLs main made from bytes it sniffed itself.
//
// This file uses the helpers of newtab-widgets.js (el, text, iconButton, refreshButton, openLink, widgetAct, spClock): it loads after it.
/* global el, text, iconButton, refreshButton, openLink, widgetAct, spClock, MusicCardFeatures */
'use strict';

(function () {
const MCF = globalThis.MusicCardFeatures;

const ICONS = {
  prev: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3h1.7v10H3.5zM13 3.4v9.2L6.2 8z"/></svg>',
  next: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.8 3h1.7v10h-1.7zM3 3.4v9.2L9.8 8z"/></svg>',
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3h2.6v10H4zM9.4 3H12v10H9.4z"/></svg>',
  heart: '<svg viewBox="0 0 16 16" aria-hidden="true"><path class="mc-stroke" d="M8 13.6S2.4 10.2 2.4 6.2A2.9 2.9 0 0 1 8 5a2.9 2.9 0 0 1 5.6 1.2c0 4-5.6 7.4-5.6 7.4z"/></svg>',
  shuffle: '<svg viewBox="0 0 16 16" aria-hidden="true"><path class="mc-stroke" d="M2 4.5h2.4c3 0 4 7 7.2 7H14M2 11.5h2.4c1 0 1.8-.9 2.6-2.2M9 6.6C9.6 5.4 10.4 4.5 11.6 4.5H14M12 2.6l2 1.9-2 1.9M12 9.6l2 1.9-2 1.9"/></svg>',
  repeat: '<svg viewBox="0 0 16 16" aria-hidden="true"><path class="mc-stroke" d="M3 7.6V7a2.5 2.5 0 0 1 2.5-2.5H13M11 2.5l2 2-2 2M13 8.4V9a2.5 2.5 0 0 1-2.5 2.5H3M5 9.5l-2 2 2 2"/></svg>',
  repeatOne: '<svg viewBox="0 0 16 16" aria-hidden="true"><path class="mc-stroke" d="M3 7.6V7a2.5 2.5 0 0 1 2.5-2.5H13M11 2.5l2 2-2 2M13 8.4V9a2.5 2.5 0 0 1-2.5 2.5H3M5 9.5l-2 2 2 2"/><path d="M7.2 6.9h1.1v3.3" class="mc-stroke"/></svg>',
  volume: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 6.2h2.3L8 3.4v9.2L4.8 9.8H2.5z"/><path class="mc-stroke" d="M10.4 6a3 3 0 0 1 0 4M12 4.2a5.4 5.4 0 0 1 0 7.6"/></svg>',
  search: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="5" cy="5" r="3.2"/><path d="m7.5 7.5 3 3"/></svg>',
};

const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const thumbOk = (v) => typeof v === 'string' && v.length < 12000 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v);
const artOk = (v) => (typeof v === 'string' && v.length < 200000 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v) ? v : '');
const KINDS = ['song', 'album', 'playlist', 'station', 'artist'];
const SEARCH_GROUPS = [['song', 'Songs', 'am-songs'], ['album', 'Albums', 'am-albums'], ['artist', 'Artists', 'am-artists'], ['playlist', 'Playlists', 'am-playlists']];
const SEARCH_DEBOUNCE_MS = 250;
const RECENT_MAX = 5;
const ASK_AGAIN_MS = 4000; // a tab's data is asked again no sooner than this
const STALE_MS = 5 * 60e3; // ...and, unless the user picks the tab again, only this long after it was asked
const LOADING_MS = 3500; // "Loading…" is shown this long after a tab was asked, when nothing has come yet
const TAB_ORDER = [['search', 'Search', 'search'], ['queue', 'Up next', 'queue'], ['library', 'Library', 'library'], ['devices', 'Devices', 'devices'], ['tracks', 'Album', 'tracks'], ['lyrics', 'Lyrics', 'lyrics']];

// What differs between the services; everything else is one card. (Spotify's "Now playing" API mode has its own entry.)
const ENGINES = {
  applemusic: {
    name: 'Apple Music', site: 'https://music.apple.com/', signIn: 'Sign in to Apple Music', engine: 'applemusic',
    reasons: { offline: 'Can’t reach Apple Music. Check your internet connection.', failed: 'Apple Music didn’t load.', unsupported: 'The Apple Music status card isn’t available here. Use the web player mode instead.' },
    idleHint: (signedIn, loading) => (loading ? 'Starting Apple Music…' : signedIn ? 'Pick something to play' : 'Search, or sign in to play more'),
    preview: 'Preview only. Sign in to Apple Music for full songs.',
    searchNote: (d) => (d.signedIn === false ? 'Not signed in: songs play as short previews.' : ''),
    changed: 'Apple Music changed its page, so Lumen can’t read it. Use the Web player mode for now.',
    like: ['Love this song', 'Remove love'], albumTab: 'Album',
  },
  spotify: {
    name: 'Spotify', site: 'https://open.spotify.com/', signIn: 'Sign in to Spotify in Lumen', engine: 'spotify-lumen',
    reasons: { offline: 'Can’t reach Spotify. Check your internet connection.', failed: 'Spotify didn’t load.', unsupported: 'The Spotify status card isn’t available here. Use the web player mode instead.' },
    idleHint: (signedIn, loading) => (loading ? 'Starting Spotify…' : signedIn ? 'Search, or play on any Spotify device' : 'Sign in to play music here'),
    preview: '',
    searchNote: (d) => (d.signedIn === false ? 'Sign in to Spotify in Lumen to play these.' : ''),
    changed: 'Spotify changed its page, so Lumen can’t read it. Open this card’s settings and choose Web player or Now playing card.',
    like: ['Save to Liked Songs', 'Remove from Liked Songs'], albumTab: 'Album',
  },
  spotifyApi: {
    name: 'Spotify', site: 'https://open.spotify.com/', signIn: '', engine: 'spotify-api', api: true, playLabel: 'Play on Spotify',
    reasons: {},
    openUrl: (x) => (typeof x.url === 'string' && /^https:\/\/open\.spotify\.com\/[\w/?=&.-]{1,200}$/.test(x.url) ? x.url : null),
    idleHint: (signedIn, loading, d) => (text(d.device, 60) ? `${text(d.device, 60)} is ready` : 'Start Spotify on any device'),
    preview: '',
    searchNote: () => '',
    changed: '',
    like: ['Save to Liked Songs', 'Remove from Liked Songs'], albumTab: 'Album',
  },
};
// Why a search found nothing (main says: features/music-engine.js searchWhy), in words; the detail (the page's address and what it showed) is the hover text.
const searchFailText = (o, d) => (d.searchWhy === 'signedOut' ? `Sign in to ${o.name} in Lumen to search and play.` : d.searchWhy === 'noPlayer' ? `${o.name}’s player controls weren’t found. Is the web player signed in?` : d.searchWhy === 'timeout' ? `${o.name} didn’t show search results in time. Try again.` : `${o.name} didn’t answer the search. It may have changed its page; try again.`);

const musicUi = new Map(); // widget id -> { tab, term, open, active, timer, asked: {tab: ms}, scroll: {tab: px} }: what the user did, kept for as long as the page lives
const uiOf = (id) => { let u = musicUi.get(id); if (!u) { u = { tab: '', term: '', open: false, timer: null, active: -1, asked: {}, scroll: {} }; musicUi.set(id, u); } return u; };
const recentSearches = (id) => { try { const v = JSON.parse(localStorage.getItem(`lumen-music-recent:${id}`) || '[]'); return Array.isArray(v) ? v.filter((t) => typeof t === 'string' && t.length > 0 && t.length <= 80).slice(0, RECENT_MAX) : []; } catch { return []; } };
function rememberSearch(id, term) {
  const t = String(term || '').trim().slice(0, 80);
  if (!t) return;
  try { localStorage.setItem(`lumen-music-recent:${id}`, JSON.stringify([t, ...recentSearches(id).filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, RECENT_MAX))); } catch { /* private window: no history */ }
}
const sig = (v) => { try { return JSON.stringify(v); } catch { return String(Math.random()); } };
const setText = (node, v) => { const s = String(v ?? ''); if (node.textContent !== s) node.textContent = s; };
// Replace a container's children only when what they are drawn from changed.
function fill(box, signature, draw) {
  if (box._sig === signature) return false;
  box._sig = signature;
  const top = box.scrollTop;
  box.replaceChildren();
  draw(box);
  box.scrollTop = top; // (the list was redrawn: the reader stays where they were)
  return true;
}
const rowsOf = (items, ok = (i) => i && typeof i.id === 'string' && SAFE_ID.test(i.id) && typeof i.title === 'string') => (Array.isArray(items) ? items : []).filter(ok);

// ---------------------------------------------------------------------------------------------------------------------------------------------
function build(w, card, o) {
  const id = w.id;
  const ui = uiOf(id);
  const base = MCF.caps(o.engine);
  const view = { w, d: w.data, card, o, ui, tier: 'small', root: null, timers: new Set(), prog: null };
  card.el.classList.add('mc-card', 'am-card');
  card.el.dataset.engine = o.engine;
  const act = (name, extra) => widgetAct(id, name, extra || {});
  const cap = (f) => {
    const d = view.d || {};
    const can = d.can && typeof d.can === 'object' ? d.can : null;
    if (!base[f]) return false;
    if (d.source === 'app' && !['art', 'title', 'playPause', 'next', 'prev', 'progress', 'tabs'].includes(f)) return false; // (the desktop app: only its own buttons)
    return !['search', 'seek', 'like', 'shuffle', 'repeat', 'volume', 'queue', 'library', 'devices', 'tracks', 'lyrics'].includes(f) || Boolean(can && can[f]);
  };
  view.cap = cap;

  // ---- the header: refresh, who is playing where, the search ----
  const head = card.head;
  const refresh = refreshButton(w);
  head.append(refresh);
  const badge = el('span', 'mk-badge'); // (in the header only while it has something to say)
  const open = o.openUrl ? o.openUrl(view.d || {}) : null;
  const openEl = open ? openLink(open, `Open in ${o.name}`) : null;
  if (openEl) head.append(openEl);
  const field = el('div', 'am-searchfield');
  const input = el('input');
  const toggle = iconButton(ICONS.search, `Search ${o.name}`, () => { ui.open ? closePop() : openPop(); });
  toggle.classList.add('am-searchbtn');
  toggle.setAttribute('aria-expanded', 'false');
  head.append(toggle, field);
  const pop = el('div', 'am-pop');
  pop.id = `am-pop-${id}`;
  pop.setAttribute('role', 'listbox');
  pop.setAttribute('aria-label', `${o.name} search results`);
  card.el.append(pop);

  // ---- the layout: the player on one side, the tabs on the other (below it when narrow) ----
  const root = el('div', 'mc');
  const main = el('div', 'mc-main');
  const side = el('div', 'mc-side');
  root.append(main, side);
  card.body.append(root);
  view.root = root;

  // The song: picture, title, artist, album, the heart.
  const wrap = el('div', 'sp-wrap');
  const art = document.createElement('img');
  art.className = 'sp-art';
  art.alt = '';
  const info = el('div', 'sp-text');
  const titleEl = el('span', 'sp-title');
  const artistEl = el('span', 'sp-artist');
  const albumEl = el('span', 'sp-album');
  info.append(titleEl, artistEl);
  const like = el('button', 'mc-btn mc-like');
  like.type = 'button';
  like.innerHTML = ICONS.heart;
  like.hidden = true;
  like.addEventListener('click', () => act('like'));
  wrap.append(info, like);

  // The buttons: previous (medium and up), play / pause, next.
  const controls = el('div', 'sp-controls');
  const mkBtn = (cls, svg, label, onclick) => { const b = el('button', cls); b.type = 'button'; b.innerHTML = svg; b.setAttribute('aria-label', label); b.title = label; b.addEventListener('click', onclick); return b; };
  const prev = mkBtn('sp-btn mc-prev', ICONS.prev, 'Previous track', () => act('previous'));
  let playAct = 'play';
  const playBtn = mkBtn('sp-btn main', ICONS.play, 'Play', () => act(playAct));
  const next = mkBtn('sp-btn mc-next', ICONS.next, 'Next track', () => act('next'));
  controls.append(prev, playBtn, next);

  // The progress bar: a seek bar (click or arrow keys) with the times on a medium card.
  const progress = el('div', 'sp-progress');
  const bar = el('div', 'sp-bar');
  const fillEl = document.createElement('i');
  bar.append(fillEl);
  const elapsed = el('span', 'sp-elapsed');
  const total = el('span', 'sp-total');
  progress.append(elapsed, bar, total);
  const seekTo = (ms) => { const p = view.prog; if (p && p.duration) act('seek', { arg: String(Math.round(Math.max(0, Math.min(p.duration, ms)) / 1000)) }); };
  bar.addEventListener('click', (e) => { const r = bar.getBoundingClientRect(); const p = view.prog; if (p && p.seek && r.width > 0) seekTo(((e.clientX - r.left) / r.width) * p.duration); });
  bar.addEventListener('keydown', (e) => {
    if (!view.prog || !view.prog.seek || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    e.stopPropagation();
    seekTo(drawProgress() + (e.key === 'ArrowRight' ? 5000 : -5000));
  });

  // The switches (medium and up): shuffle, repeat, volume.
  const extra = el('div', 'mc-extra');
  const shuffle = mkBtn('mc-btn mc-shuffle', ICONS.shuffle, 'Shuffle', () => act('shuffle'));
  const repeat = mkBtn('mc-btn mc-repeat', ICONS.repeat, 'Repeat', () => act('repeat'));
  const vol = el('div', 'mc-vol');
  const volIcon = el('span', 'mc-vol-icon');
  volIcon.innerHTML = ICONS.volume;
  const volume = el('input', 'mc-vol-range');
  volume.type = 'range';
  volume.min = '0';
  volume.max = '100';
  volume.step = '1';
  volume.setAttribute('aria-label', 'Volume');
  let dragging = false;
  volume.addEventListener('pointerdown', () => { dragging = true; });
  const paintVolume = () => { volume.style.setProperty('--v', `${volume.value}%`); volume.title = `${volume.value}%`; };
  volume.addEventListener('input', paintVolume);
  volume.addEventListener('change', () => { dragging = false; act('volume', { arg: String(Math.round(Number(volume.value))) }); });
  volume.addEventListener('blur', () => { dragging = false; });
  vol.append(volIcon, volume);
  extra.append(shuffle, repeat, vol);

  const notes = el('div', 'mc-notes');
  const idle = el('div', 'am-idle');
  main.append(wrap, controls, progress, extra, notes, idle);

  // ---- the tabs (large and up) ----
  const tabs = el('div', 'mc-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', `${o.name} card`);
  const panels = el('div', 'mc-panels');
  side.append(tabs, panels);
  const tab = {};
  for (const [name, label, feature] of TAB_ORDER) {
    const b = el('button', `mc-tab mc-tab-${name}`, label);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.id = `mc-tab-${id}-${name}`;
    b.dataset.tab = name;
    b.dataset.feature = feature;
    b.setAttribute('aria-controls', `mc-panel-${id}-${name}`);
    b.addEventListener('click', () => selectTab(name, true));
    const p = el('div', `mc-panel mc-panel-${name}`);
    p.id = `mc-panel-${id}-${name}`;
    p.setAttribute('role', 'tabpanel');
    p.setAttribute('aria-labelledby', b.id);
    p.addEventListener('scroll', () => { ui.scroll[name] = p.scrollTop; }, { passive: true });
    tabs.append(b);
    panels.append(p);
    tab[name] = { b, p };
  }
  tabs.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const list = visibleTabs();
    const i = list.indexOf(ui.tab);
    if (!list.length) return;
    e.preventDefault();
    e.stopPropagation();
    const n = list[(i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length];
    selectTab(n, true);
    tab[n].b.focus();
  });

  // ---- what is shown ----
  const stateOf = () => { const d = view.d || {}; return d.state === 'playing' || d.state === 'paused' ? d.state : 'idle'; };
  function visibleTabs() {
    const idle = stateOf() === 'idle';
    return TAB_ORDER.filter(([, , feature]) => cap(feature) && (feature !== 'tracks' && feature !== 'lyrics' ? true : view.tier === 'xl' && !idle)).map(([n]) => n); // (an album and lyrics are of a song)
  }
  function selectTab(name, byUser) {
    if (ui.tab !== name) { ui.tab = name; if (byUser) ui.userTab = true; }
    for (const [n, t] of Object.entries(tab)) {
      const on = n === name;
      t.b.setAttribute('aria-selected', String(on));
      t.b.tabIndex = on ? 0 : -1;
      t.p.hidden = !on;
    }
    askTab(name, byUser === true);
    if (tab[name]) tab[name].p.scrollTop = ui.scroll[name] || 0;
    drawPanels();
  }
  // A tab's data is asked for when the tab is shown (the card is large enough for tabs, and the tab is the open one), not again for a few seconds.
  function askTab(name, byUser) {
    if (!name || name === 'search' || (name === 'devices' && o.engine !== 'spotify-api')) return;
    if (view.tier === 'small' || view.tier === 'medium') return;
    const now = Date.now();
    const age = now - (ui.asked[name] || 0);
    if (age < ASK_AGAIN_MS || (!byUser && ui.asked[name] && age < STALE_MS)) return; // (asked: the engine keeps the list up to date; picked again by the user: asked again)
    ui.asked[name] = now;
    act('etab', { arg: name });
  }
  const loadingFor = (name, list) => { const d = view.d || {}; return Boolean(list && list.pending) || (!rowsOf(list && list.items).length && Date.now() - (ui.asked[name] || 0) < LOADING_MS && (list ? list.ok !== false : d.recent === undefined)); };
  // After the loading window passes with nothing, the panel says "nothing" instead of "Loading…".
  const later = (ms, fn) => { const t = setTimeout(() => { view.timers.delete(t); if (root.isConnected) fn(); }, ms); view.timers.add(t); };

  // ---- panels ----
  function note(box, message, { button, onClick, role = 'status' } = {}) {
    const p = el('p', 'w-note am-note mc-note', message);
    p.setAttribute('role', role);
    box.append(p);
    if (button) { const b = el('button', 'w-btn', button); b.type = 'button'; b.addEventListener('click', onClick); box.append(b); }
  }
  const retry = (name) => () => { ui.asked[name] = 0; act('etab', { arg: name }); };
  function listRow(item, { onClick, label, current = false, index = null, acts = null, withThumbs = true }) {
    const r = el('div', `mc-row${current ? ' current' : ''}`);
    const b = el('button', 'mc-row-main');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    if (current) b.setAttribute('aria-current', 'true');
    if (index !== null) b.append(el('span', 'mc-idx', current ? '▶' : String(index + 1)));
    if (index === null && thumbOk(item.thumb)) { const img = document.createElement('img'); img.className = 'am-thumb'; img.alt = ''; img.src = item.thumb; b.append(img); } else if (index === null && withThumbs) b.append(el('span', 'am-thumb none'));
    const t = el('span', 'am-opt-text');
    t.append(el('span', 'am-title', text(item.title, 120)));
    if (text(item.sub, 120)) t.append(el('span', 'am-sub', text(item.sub, 120)));
    b.append(t);
    if (Number.isFinite(item.ms) && item.ms > 0) b.append(el('span', 'am-dur', spClock(item.ms)));
    b.addEventListener('click', onClick);
    r.append(b);
    if (acts) r.append(acts);
    return r;
  }
  function drawQueue() {
    const d = view.d; const q = d.queue || {};
    const items = rowsOf(q.items);
    const state = q.pending || loadingFor('queue', q) ? 'loading' : q.ok === false ? `err:${q.why}` : items.length ? 'rows' : 'empty';
    fill(tab.queue.p, sig([state, items.map((i) => i.id + (i.thumb ? 1 : 0)), d.can && d.can.playLater]), (box) => {
      if (state === 'loading') { note(box, 'Loading the queue…'); return; }
      if (state.startsWith('err:')) {
        const why = q.why === 'signedOut' ? `Sign in to ${o.name} to see the queue.` : q.why === 'scope' ? 'Reconnect Spotify in Settings to allow this.' : q.why === 'noPlayer' ? `${o.name}’s player controls weren’t found.` : 'Couldn’t read the queue.';
        note(box, why, q.why === 'signedOut' || q.why === 'scope' ? {} : { button: 'Try again', onClick: retry('queue') });
        return;
      }
      if (!items.length) { note(box, 'Nothing is queued after this song.'); return; }
      const pics = items.some((i) => thumbOk(i.thumb));
      items.forEach((it, i) => box.append(listRow(it, { withThumbs: pics, label: `Play ${text(it.title, 60)} from the queue`, onClick: () => act('playqueue', { arg: String(i), with: it.id }) })));
    });
  }
  function drawLibrary() {
    const d = view.d;
    const recent = rowsOf(d.recent); const lists = rowsOf(d.playlists);
    const out = d.signedIn === false;
    const state = out ? 'out' : d.needsScopes === true && !recent.length && !lists.length ? 'scope' : recent.length || lists.length ? 'rows' : (Date.now() - (ui.asked.library || 0) < LOADING_MS ? 'loading' : 'empty');
    fill(tab.library.p, sig([state, recent.map((i) => i.id), lists.map((i) => i.id), d.needsScopes === true]), (box) => {
      if (state === 'out') { note(box, `Sign in to ${o.name} to see your library.`); if (o.signIn) { const b = el('button', 'w-btn primary am-signin', o.signIn); b.type = 'button'; b.addEventListener('click', () => act('esignin')); box.append(b); } return; }
      if (state === 'loading') { note(box, 'Loading your library…'); return; }
      if (state === 'scope') { reconnectNote(box); return; }
      if (state === 'empty') { note(box, 'Nothing here yet.', { button: 'Try again', onClick: retry('library') }); return; }
      const group = (heading, items) => {
        if (!items.length) return;
        const g = el('div', 'am-group');
        g.append(el('div', 'am-heading', heading));
        for (const it of items) if (KINDS.includes(it.kind)) g.append(listRow(it, { withThumbs: false, label: `Play ${text(it.title, 60)}`, onClick: () => act('playitem', { kind: it.kind, arg: it.id }) }));
        box.append(g);
      };
      group('Recently played', recent);
      group(o.engine === 'spotify-lumen' ? 'Your library' : 'Your playlists', lists);
      if (d.needsScopes === true) reconnectNote(box);
    });
    if (state === 'loading') later(LOADING_MS + 50, drawLibrary);
  }
  function reconnectNote(box) {
    note(box, 'Reconnect Spotify to use your library and likes here. Lumen asks for the extra permission once.', { button: 'Reconnect in Settings', onClick: () => act('configure') });
  }
  function drawDevices() {
    const d = view.d; const list = (Array.isArray(d.devices) ? d.devices : []).filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string');
    const pick = d.can && d.can.devices === 'pick';
    fill(tab.devices.p, sig([pick, list.map((x) => [x.id, x.active]), d.devicesOk, Date.now() - (ui.asked.devices || 0) < LOADING_MS]), (box) => {
      if (pick && d.devicesOk === false) { note(box, 'Couldn’t list your devices.', { button: 'Try again', onClick: retry('devices') }); return; }
      if (!list.length) { note(box, pick && Date.now() - (ui.asked.devices || 0) < LOADING_MS ? 'Looking for devices…' : pick ? 'No Spotify devices are open. Start Spotify on one, then try again.' : 'Playing in this browser.', pick ? { button: 'Look again', onClick: retry('devices') } : {}); return; }
      const g = el('div', 'am-group');
      for (const dev of list.slice(0, 12)) {
        const r = el('div', `mc-row${dev.active ? ' current' : ''}`);
        const b = el('button', 'mc-row-main mc-device');
        b.type = 'button';
        b.setAttribute('aria-label', `${pick ? 'Play on' : ''} ${text(dev.name, 60)}${dev.active ? ' (playing here)' : ''}`.trim());
        if (dev.active) b.setAttribute('aria-current', 'true');
        b.disabled = !pick;
        b.append(el('span', 'mc-dot'));
        const t = el('span', 'am-opt-text');
        t.append(el('span', 'am-title', text(dev.name, 60)));
        t.append(el('span', 'am-sub', dev.active ? (pick ? 'Playing here' : 'Playing') : text(dev.type, 20)));
        b.append(t);
        if (pick && SAFE_ID.test(dev.id)) b.addEventListener('click', () => act('transfer', { arg: dev.id }));
        r.append(b);
        g.append(r);
      }
      box.append(g);
    });
    if (pick && !list.length && Date.now() - (ui.asked.devices || 0) < LOADING_MS) later(LOADING_MS + 50, drawDevices);
  }
  function drawTracks() {
    const d = view.d; const t = d.tracks || {};
    const items = rowsOf(t.items);
    const state = t.pending || loadingFor('tracks', t) ? 'loading' : t.ok === false ? 'err' : items.length ? 'rows' : 'empty';
    fill(tab.tracks.p, sig([state, items.map((i) => i.id), t.current, t.title]), (box) => {
      if (state === 'loading') { note(box, 'Loading the track list…'); return; }
      if (state === 'err') { note(box, t.why === 'scope' ? 'Reconnect Spotify in Settings to allow this.' : 'Couldn’t read the track list.', t.why === 'scope' ? {} : { button: 'Try again', onClick: retry('tracks') }); return; }
      if (!items.length) { note(box, 'No album or playlist is playing from.'); return; }
      if (text(t.title, 120)) box.append(el('div', 'am-heading mc-ctx', text(t.title, 120)));
      items.forEach((it, i) => box.append(listRow(it, { index: i, current: i === t.current, label: `Play from ${text(it.title, 60)}`, onClick: () => act('playfrom', { arg: String(i), with: it.id }) })));
    });
    const cur = tab.tracks.p.querySelector('.mc-row.current');
    if (cur && tab.tracks.p._shownFor !== `${t.current}|${t.title}`) { tab.tracks.p._shownFor = `${t.current}|${t.title}`; cur.scrollIntoView({ block: 'nearest' }); }
  }
  function drawLyrics() {
    const d = view.d; const l = d.lyrics || {};
    const mine = l.forTitle === d.title || API_NO_LYRICS;
    const lines = mine ? (Array.isArray(l.lines) ? l.lines : []).filter((x) => typeof x === 'string').slice(0, 250) : [];
    const state = !mine || l.pending ? 'loading' : l.ok === false ? `err:${l.why}` : lines.length ? 'rows' : (Date.now() - (ui.asked.lyrics || 0) < LOADING_MS ? 'loading' : 'empty');
    fill(tab.lyrics.p, sig([state, lines.length, lines[0], d.title]), (box) => {
      if (state === 'loading') { note(box, 'Looking for the lyrics…'); return; }
      if (state.startsWith('err:')) { note(box, l.why === 'signedOut' ? `Sign in to ${o.name} to see lyrics.` : 'Lyrics aren’t available for this song.', l.why === 'page' ? { button: 'Try again', onClick: retry('lyrics') } : {}); return; }
      if (!lines.length) { note(box, 'Lyrics aren’t available for this song.'); return; }
      const pre = el('div', 'mc-lyrics');
      for (const line of lines) pre.append(el('p', 'mc-line', text(line, 200)));
      box.append(pre);
    });
    if (state === 'loading') later(LOADING_MS + 50, drawLyrics);
  }
  const API_NO_LYRICS = false;

  // The search: the same controller serves the header's pop-over (small and medium cards) and the Search tab (large).
  const search = searchController(view, { id, o, act, ui, cap });
  search.attach({ input, field, pop, toggle, closePop: () => closePop(), openPop: () => openPop() });
  function openPop() { ui.open = true; search.draw(); search.focus(pop); }
  function closePop() { search.close(); }
  const inline = search.inline(tab.search.p);

  function drawPanels() {
    if (view.tier === 'small' || view.tier === 'medium') return;
    const name = ui.tab;
    if (name === 'queue') drawQueue(); else if (name === 'library') drawLibrary(); else if (name === 'devices') drawDevices(); else if (name === 'tracks') drawTracks(); else if (name === 'lyrics') drawLyrics(); else if (name === 'search') inline.draw();
  }

  // ---- progress: main sends where the playhead was and when; this page moves it on once a second ----
  function drawProgress() {
    const p = view.prog;
    if (!p || !p.duration) return 0;
    const now = Math.min(p.duration, Math.max(0, p.from + (p.playing ? Math.max(0, Date.now() - p.at) : 0)));
    setText(elapsed, spClock(now));
    fillEl.style.width = `${(now / p.duration) * 100}%`;
    bar.setAttribute('aria-valuenow', String(Math.round((now / p.duration) * 100)));
    bar.setAttribute('aria-valuetext', `${spClock(now)} of ${spClock(p.duration)}`);
    return now;
  }
  // One timer per card, only while a song is playing and the page is visible (features/visible-ticker.js). The position is never counted: drawProgress()
  // works it out from where the playhead was and when, so a page that was hidden is right again the moment it is shown.
  const born = Date.now();
  function progressTick() {
    const p = view.prog;
    if (!p || !p.playing) return;
    if (drawProgress() >= p.duration && p.endedKey !== `${p.from}|${p.at}`) {
      p.endedKey = `${p.from}|${p.at}`;
      // The track is over: the service has moved on to the next one (or stopped). Without this the card sat at the end of the old song until its
      // next scheduled refresh. The later asks cover the service still answering with the old song.
      for (const wait of [1500, 6000, 15000]) setTimeout(() => { if (root.isConnected) widgetAct(id, 'refresh'); }, wait);
    }
  }
  const clock = window.VisibleTicker.createTicker({ period: 1000, offset: () => (view.prog ? view.prog.at - view.prog.from : 0), needed: () => Boolean(view.prog?.playing) && (root.isConnected || Date.now() - born < 10e3), run: progressTick }); // (a card is built before it is put on the page)
  view.clock = clock;
  document.addEventListener('visibilitychange', onShown);
  function onShown() {
    if (!root.isConnected) { document.removeEventListener('visibilitychange', onShown); clock.stop(); return; } // the card was removed (a kept card stays connected)
    clock.onVisibility();
  }

  // ---- update: everything the data can change, each part only when it changed ----
  let adTimer = null;
  function update(nextW) {
    view.w = nextW;
    const d = nextW.data && typeof nextW.data === 'object' ? nextW.data : {};
    view.d = d;
    const state = stateOf();
    const isIdle = state === 'idle';
    const loading = d.reason === 'loading';
    const signedIn = d.signedIn === true;
    card.el.classList.toggle('sp-card-idle', isIdle);
    card.el.dataset.source = d.source === 'app' ? 'app' : 'engine';
    // header badge: the desktop app is the one playing, or another device (Spotify Connect)
    const badgeText = d.source === 'app' ? 'Apple Music app' : (!o.api && typeof d.device === 'string' && d.device) ? `On ${text(d.device, 40)}` : '';
    if (badgeText) { if (!badge.isConnected) refresh.after(badge); setText(badge, badgeText); } else badge.remove();
    // picture and text
    const a = artOk(d.art);
    if (a) { if (art.getAttribute('src') !== a) art.src = a; if (!art.isConnected) wrap.prepend(art); } else art.remove(); // (parts that have nothing to show are not in the card at all)
    if (isIdle) {
      setText(titleEl, 'Nothing is playing');
      setText(artistEl, o.idleHint(signedIn, loading, d));
      setText(albumEl, '');
    } else {
      setText(titleEl, text(d.title, 200));
      setText(artistEl, text(d.artist, 200));
      setText(albumEl, text(d.album, 120));
    }
    if (albumEl.textContent) { if (!albumEl.isConnected) info.append(albumEl); } else albumEl.remove();
    // like
    const liked = d.liked === true;
    like.hidden = isIdle || !cap('like');
    like.classList.toggle('on', liked);
    like.setAttribute('aria-pressed', String(liked));
    like.setAttribute('aria-label', liked ? o.like[1] : o.like[0]);
    like.title = liked ? o.like[1] : o.like[0];
    // buttons
    const ad = d.kind === 'ad';
    controls.hidden = isIdle && !o.playLabel;
    prev.hidden = !cap('prev');
    if (isIdle) { prev.remove(); next.remove(); } else { if (!prev.isConnected) controls.prepend(prev); if (!next.isConnected) controls.append(next); }
    for (const [b, label] of [[prev, 'Previous track'], [next, 'Next track']]) { b.disabled = ad; b.setAttribute('aria-label', ad ? `${label} (not during an ad)` : label); b.title = ad ? 'Not during an ad' : label; }
    playAct = state === 'playing' ? 'pause' : 'play';
    const playLabel = isIdle ? (o.playLabel || 'Play') : state === 'playing' ? 'Pause' : 'Play';
    playBtn.innerHTML = state === 'playing' ? ICONS.pause : ICONS.play;
    playBtn.setAttribute('aria-label', playLabel);
    playBtn.title = playLabel;
    clearTimeout(adTimer);
    if (ad && state === 'playing') adTimer = setTimeout(() => { if (root.isConnected) widgetAct(id, 'refresh'); }, 16000); // an ad has no length: look again when it is likely over
    // switches
    extra.hidden = isIdle;
    shuffle.hidden = !cap('shuffle');
    shuffle.classList.toggle('on', d.shuffle === true);
    shuffle.setAttribute('aria-pressed', String(d.shuffle === true));
    shuffle.setAttribute('aria-label', d.shuffle === true ? 'Shuffle on' : 'Shuffle off');
    shuffle.title = d.shuffle === true ? 'Shuffle: on' : 'Shuffle: off';
    repeat.hidden = !cap('repeat');
    const rep = d.repeat === 'all' || d.repeat === 'one' ? d.repeat : 'off';
    repeat.classList.toggle('on', rep !== 'off');
    repeat.innerHTML = rep === 'one' ? ICONS.repeatOne : ICONS.repeat;
    repeat.setAttribute('aria-pressed', String(rep !== 'off'));
    const repLabel = rep === 'off' ? 'Repeat off' : rep === 'all' ? 'Repeat all' : 'Repeat one';
    repeat.setAttribute('aria-label', repLabel);
    repeat.title = repLabel;
    vol.hidden = !cap('volume') || !Number.isFinite(d.volume);
    if (Number.isFinite(d.volume) && !dragging && document.activeElement !== volume) volume.value = String(Math.round(Math.max(0, Math.min(1, d.volume)) * 100));
    paintVolume();
    volume.setAttribute('aria-valuetext', `${volume.value}%`);
    // progress
    const duration = Number.isFinite(d.durationMs) && d.durationMs > 0 ? d.durationMs : 0;
    progress.hidden = isIdle || !duration;
    const seekable = cap('seek') && d.source !== 'app';
    bar.classList.toggle('sp-seek', seekable);
    bar.setAttribute('role', seekable ? 'slider' : 'progressbar');
    bar.tabIndex = seekable ? 0 : -1;
    bar.setAttribute('aria-label', `${text(d.title, 100)} progress`);
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    view.prog = duration && !isIdle ? { from: Number.isFinite(d.progressMs) ? d.progressMs : 0, at: Number.isFinite(d.at) ? d.at : Date.now(), duration, playing: state === 'playing', seek: seekable, endedKey: view.prog && view.prog.from === d.progressMs && view.prog.at === d.at ? view.prog.endedKey : '' } : null;
    setText(total, duration ? spClock(duration) : '');
    drawProgress();
    clock.poke();
    // the header search
    const canSearch = cap('search');
    toggle.hidden = !canSearch || loading;
    if (!canSearch && ui.open) search.close();
    // notes under the player
    drawNotes(d, state, signedIn, loading);
    drawIdle(d, state, signedIn, loading);
    // tabs
    syncTabs();
    search.draw();
    if (!pop.hidden || ui.open) { /* (the pop-over redraws itself from the new data) */ }
    drawPanels();
  }

  function drawNotes(d, state, signedIn, loading) {
    const unresponsive = d.unresponsive === true;
    const why = d.signedIn === true && d.drm === 'missing' ? 'Full songs need Lumen’s Widevine component, which isn’t available yet.' : '';
    const s = sig([d.notice, d.pageChanged, unresponsive, why, d.error, state !== 'idle' && d.preview === true && d.source !== 'app' && o.preview, o.api && d.needsScopes === true && state !== 'idle']);
    fill(notes, s, (box) => {
      if (typeof d.notice === 'string' && d.notice) { const n = el('p', 'w-note', d.notice.slice(0, 200)); n.setAttribute('role', 'status'); box.append(n); }
      if (d.pageChanged === true && o.changed) box.append(el('p', 'w-note am-note am-changed', o.changed));
      if (unresponsive) { // a button was pressed and nothing happened: say so, and offer the player itself
        const warn = el('div', 'am-warn');
        const msg = el('span', 'w-note', `${o.name} didn’t respond.${why ? ` ${why}` : ''}`);
        msg.setAttribute('role', 'status');
        const show = el('button', 'w-btn', 'Open player');
        show.type = 'button';
        show.addEventListener('click', () => act('eshow'));
        warn.append(msg, show);
        box.append(warn);
      }
      if (typeof d.error === 'string' && d.error) box.append(el('p', 'w-note am-note', text(d.error, 120))); // (a control the page didn't show, a play button that wasn't there: also when nothing is playing)
      if (state !== 'idle' && d.preview === true && d.source !== 'app' && o.preview) box.append(el('p', 'w-note am-note', o.preview));
      if (o.api && d.needsScopes === true && state !== 'idle') { // an account connected before the bigger sizes: the hearts and library need one more permission
        const r = el('div', 'am-warn');
        r.append(el('span', 'w-note', 'Reconnect Spotify to use likes and your library here.'));
        const b = el('button', 'w-btn', 'Reconnect');
        b.type = 'button';
        b.addEventListener('click', () => act('configure'));
        r.append(b);
        box.append(r);
      }
    });
  }

  // When idle: sign in, what was played, the playlists (the large card has the Library tab instead).
  function drawIdle(d, state, signedIn, loading) {
    const show = state === 'idle' && !loading;
    if (!show) { idle.remove(); return; }
    if (!idle.isConnected) main.append(idle);
    const recent = rowsOf(d.recent, (i) => i && typeof i.id === 'string' && SAFE_ID.test(i.id) && KINDS.includes(i.kind) && typeof i.title === 'string').slice(0, 8);
    const lists = rowsOf(d.playlists, (i) => i && typeof i.id === 'string' && SAFE_ID.test(i.id) && KINDS.includes(i.kind) && typeof i.title === 'string').slice(0, 8);
    fill(idle, sig([signedIn, d.signedIn, recent.map((i) => i.id), lists.map((i) => i.id), d.drm, d.appDenied, o.signIn]), (box) => {
      if (!signedIn && d.signedIn === false && o.signIn) {
        const b = el('button', 'w-btn primary am-signin', o.signIn);
        b.type = 'button';
        b.addEventListener('click', () => act('esignin'));
        box.append(b);
      }
      const section = (heading, items) => {
        if (!items.length) return;
        const sec = el('div', 'am-section');
        sec.append(el('div', 'am-heading', heading));
        for (const i of items) {
          const b = el('button', 'am-row');
          b.type = 'button';
          b.append(el('span', 'am-title', text(i.title, 120)));
          if (text(i.sub, 120)) b.append(el('span', 'am-sub', text(i.sub, 120)));
          b.addEventListener('click', () => act('playitem', { kind: i.kind, arg: i.id }));
          sec.append(b);
        }
        box.append(sec);
      };
      if (signedIn) { section('Recently played', recent); section('Your playlists', lists); }
      if (signedIn && d.drm === 'missing') box.append(el('p', 'w-note am-note', 'Full songs need Lumen’s Widevine component, which isn’t available yet. It may still be installed later; if this stays, restart Lumen.'));
      if (d.appDenied === true) box.append(el('p', 'w-note am-note', 'To also show the Apple Music app, allow Lumen in System Settings > Privacy & Security > Automation.'));
    });
  }

  // Which tabs exist (the engine's `can`) and which one is open.
  function syncTabs() {
    const names = new Set(visibleTabs());
    for (const [n, t] of Object.entries(tab)) { t.b.hidden = !names.has(n); }
    side.hidden = !names.size;
    const idleTab = stateOf() === 'idle' && ['queue', 'tracks', 'lyrics'].includes(ui.tab) && !ui.userTab;
    if (!names.has(ui.tab) || idleTab) {
      const first = stateOf() === 'idle' ? (names.has('library') ? 'library' : 'search') : (names.has('queue') ? 'queue' : 'search');
      if (names.has(first)) { ui.tab = first; ui.userTab = false; } else ui.tab = [...names][0] || '';
    }
    if (ui.tab) selectTab(ui.tab, false);
  }

  // ---- the size: container queries draw it; this only needs the tier to know which tab data to ask for ----
  function onSize(width, height) {
    const t = MCF.tierOf(width, height);
    card.el.dataset.tier = t;
    if (t === view.tier) return;
    view.tier = t;
    if ((t === 'large' || t === 'xl') && ui.open) search.close(); // (the Search tab is there: the header's pop-over is not)
    syncTabs();
    drawPanels();
  }
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver((entries) => { const r = entries[entries.length - 1].contentRect; onSize(r.width, r.height); });
    ro.observe(card.el);
    view.ro = ro;
  }

  // ---- keyboard: the focused card plays and pauses with Space, seeks with Left and Right, changes the volume with Up and Down ----
  card.el.setAttribute('aria-keyshortcuts', 'Space ArrowLeft ArrowRight ArrowUp ArrowDown');
  card.el.addEventListener('keydown', (e) => {
    if (e.target !== card.el || e.altKey || e.ctrlKey || e.metaKey || document.body.classList.contains('w-editing')) return; // (only the card itself: a button or a field has its own keys; Edit layout uses the arrows)
    const d = view.d || {};
    const state = stateOf();
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      if (state !== 'idle' || o.playLabel) act(state === 'playing' ? 'pause' : 'play');
      return;
    }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && view.prog && view.prog.seek) {
      e.preventDefault();
      seekTo(drawProgress() + (e.key === 'ArrowRight' ? 5000 : -5000));
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && cap('volume') && Number.isFinite(d.volume)) {
      e.preventDefault();
      act('volume', { arg: String(Math.max(0, Math.min(100, Math.round(d.volume * 100) + (e.key === 'ArrowUp' ? 5 : -5)))) });
    }
  });
  const modeEvent = (e) => { if (!root.isConnected) { document.removeEventListener('w-mode', modeEvent); return; } if (!(e.detail && e.detail.editing)) card.el.tabIndex = 0; };
  document.addEventListener('w-mode', modeEvent);
  view.settleTabIndex = () => { if (!document.body.classList.contains('w-editing')) card.el.tabIndex = 0; };

  view.update = (nextW) => { update(nextW); view.settleTabIndex(); };
  view.destroy = () => { for (const t of view.timers) clearTimeout(t); view.timers.clear(); clearTimeout(adTimer); clock.stop(); document.removeEventListener('visibilitychange', onShown); view.ro?.disconnect(); };
  return view;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The search: a magnifier in the header that opens a field, live results (after a short pause in typing) in a panel laid over the card, and
// the same results inside the Search tab of a large card. Grouped, songs first, with arrow keys, Enter and Escape. `d.results` / `d.query` come from the
// engine; the typing itself stays here (it is in `ui`, so it survives the card being built again).
function searchController(view, { id, o, act, ui, cap }) {
  const panes = [];
  const note = (d) => o.searchNote(d);
  function pane(kind, parts) {
    const p = { kind, ...parts, options: () => [...parts.list.querySelectorAll('.am-opt')] };
    p.setActive = (n) => {
      const list = p.options();
      ui.active = list.length ? Math.max(-1, Math.min(list.length - 1, n)) : -1;
      list.forEach((b, i) => { b.classList.toggle('active', i === ui.active); b.setAttribute('aria-selected', String(i === ui.active)); });
      if (ui.active >= 0) { parts.input.setAttribute('aria-activedescendant', list[ui.active].id); list[ui.active].scrollIntoView({ block: 'nearest' }); } else parts.input.removeAttribute('aria-activedescendant');
    };
    panes.push(p);
    return p;
  }
  function play(kind, itemId) { rememberSearch(id, ui.term); act('playitem', { kind, arg: itemId }); if (ui.open) ctl.close(); }
  function drawPane(p) {
    const d = view.d || {};
    const list = p.list;
    const d0 = list._drawn;
    const term = ui.term.trim();
    const results = rowsOf(d.results);
    const state = sig([p.kind, term, d.searching === true, d.query, d.searchOk, d.searchWhy, results.map((i) => i.kind + i.id + (i.thumb ? 1 : 0)), recentSearches(id), note(d), Boolean(d.can && (d.can.playLater || d.can.playNext)), d.can && d.can.playNext, d.can && d.can.playLater, p.open !== false]);
    if (d0 === state) return;
    list._drawn = state;
    list.replaceChildren();
    let n = 0;
    const optionButton = (item, group) => {
      const row = el('div', 'am-optrow');
      const b = el('button', 'am-opt');
      b.type = 'button';
      b.id = `am-opt-${id}-${p.kind}-${n++}`;
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', 'false');
      b.setAttribute('aria-label', `Play ${text(item.title, 60)}${text(item.sub, 60) ? `, ${text(item.sub, 60)}` : ''}`);
      b.tabIndex = -1;
      if (thumbOk(item.thumb)) { const img = document.createElement('img'); img.className = 'am-thumb'; img.alt = ''; img.src = item.thumb; b.append(img); } else b.append(el('span', 'am-thumb none'));
      const t = el('span', 'am-opt-text');
      t.append(el('span', 'am-title', text(item.title, 120)));
      if (text(item.sub, 120)) t.append(el('span', 'am-sub', text(item.sub, 120)));
      b.append(t);
      if (Number.isFinite(item.ms) && item.ms > 0) b.append(el('span', 'am-dur', spClock(item.ms)));
      b.addEventListener('click', () => play(item.kind, item.id));
      b.addEventListener('mousemove', () => { const i = p.options().indexOf(b); if (i !== ui.active) p.setActive(i); });
      row.append(b);
      // "Play next" and "Add to queue", where the service has them (Spotify: songs only)
      const acts = [['playnext', 'Next', 'Play next', d.can && d.can.playNext], ['playlater', 'Queue', 'Add to queue', d.can && d.can.playLater]].filter((x) => x[3] && ['song', 'album', 'playlist'].includes(item.kind) && !(o.api && item.kind !== 'song') && !(o.engine === 'spotify-lumen' && item.kind === 'artist'));
      if (acts.length) {
        const wrap = el('span', 'am-opt-acts');
        for (const [action, label, aria] of acts) {
          const a = el('button', 'am-act', label);
          a.type = 'button';
          a.setAttribute('aria-label', `${aria}: ${text(item.title, 60)}`);
          a.addEventListener('click', (e) => { e.stopPropagation(); rememberSearch(id, ui.term); act(action, { kind: item.kind, arg: item.id }); });
          wrap.append(a);
        }
        row.append(wrap);
      }
      group.append(row);
    };
    const line = (message, cls = 'w-note am-pop-note') => { const x = el('p', cls, message); x.setAttribute('role', 'status'); list.append(x); return x; };
    if (!term) { // focused and empty: the last searches
      const recent = recentSearches(id);
      if (!recent.length) line(`Type to search ${o.name}.`);
      else {
        const g = el('div', 'am-group am-recent');
        g.append(el('div', 'am-heading', 'Recent searches'));
        for (const t of recent) {
          const b = el('button', 'am-opt am-opt-recent', t);
          b.type = 'button';
          b.id = `am-opt-${id}-${p.kind}-${n++}`;
          b.setAttribute('role', 'option');
          b.setAttribute('aria-selected', 'false');
          b.tabIndex = -1;
          b.addEventListener('click', () => { ui.term = t; syncInputs(); ctl.search(true); p.input.focus(); });
          g.append(b);
        }
        list.append(g);
      }
      if (note(d)) line(note(d));
      return;
    }
    if (d.searching === true || d.query !== term) { line('Searching…'); if (note(d)) line(note(d)); return; }
    if (d.searchOk === false) { const fail = line(searchFailText(o, d)); if (typeof d.searchDetail === 'string' && d.searchDetail) fail.title = text(d.searchDetail, 120); } else if (!results.length) line('No results.');
    for (const [kind, heading, cls] of SEARCH_GROUPS) {
      const items = results.filter((i) => i.kind === kind).slice(0, 8);
      if (!items.length) continue;
      const group = el('div', `am-group ${cls}`);
      group.append(el('div', 'am-heading', heading));
      for (const item of items) optionButton(item, group);
      list.append(group);
    }
    if (note(d)) line(note(d));
  }
  function syncInputs() { for (const p of panes) if (p.input.value !== ui.term) p.input.value = ui.term; }
  const ctl = {
    draw() {
      const popPane = panes.find((p) => p.kind === 'pop');
      const inlinePane = panes.find((p) => p.kind === 'inline');
      if (popPane) {
        popPane.pop.classList.toggle('hidden', !ui.open);
        view.card.el.classList.toggle('am-search-open', ui.open);
        popPane.toggle.setAttribute('aria-expanded', String(ui.open));
        popPane.input.setAttribute('aria-expanded', String(ui.open));
        popPane.pop.hidden = !ui.open;
        if (ui.open) drawPane(popPane);
      }
      if (inlinePane && ui.tab === 'search') drawPane(inlinePane);
      syncInputs();
    },
    search(now) {
      clearTimeout(ui.timer);
      const term = ui.term.trim();
      const send = () => { ui.timer = null; act('esearch', { arg: term.slice(0, 80) }); };
      if (now) send(); else ui.timer = setTimeout(send, SEARCH_DEBOUNCE_MS);
      ctl.draw();
    },
    close() { clearTimeout(ui.timer); ui.timer = null; ui.open = false; ui.active = -1; ctl.draw(); const p = panes.find((x) => x.kind === 'pop'); p?.input.blur(); },
    focus(popEl) { const p = panes.find((x) => x.pop === popEl); requestAnimationFrame(() => { if (p && p.input.isConnected) { p.input.focus(); p.input.setSelectionRange(p.input.value.length, p.input.value.length); } }); },
  };
  function wireInput(p) {
    const input = p.input;
    input.type = 'search';
    input.maxLength = 80;
    input.placeholder = `Search ${o.name}`;
    input.setAttribute('aria-label', `Search ${o.name}`);
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', p.list.id);
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = ui.term;
    input.addEventListener('input', () => { ui.term = input.value.slice(0, 80); ui.active = -1; ctl.search(false); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const list = p.options(); if (!list.length) return; const nextIndex = ui.active < 0 ? (e.key === 'ArrowDown' ? 0 : list.length - 1) : (ui.active + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length; p.setActive(nextIndex); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        const list = p.options();
        const pick = ui.active >= 0 ? list[ui.active] : list.find((b) => !b.classList.contains('am-opt-recent'));
        if (pick) { pick.click(); return; }
        if (ui.term.trim()) { rememberSearch(id, ui.term); ctl.search(true); }
        return;
      }
      if (e.key === 'Escape' && p.kind === 'pop') { e.preventDefault(); e.stopPropagation(); ctl.close(); p.toggle.focus(); }
    });
  }
  ctl.attach = ({ input, field, pop, toggle }) => {
    pop.hidden = true;
    field.append(input);
    const p = pane('pop', { input, list: pop, pop, toggle });
    wireInput(p);
    input.addEventListener('focus', () => { if (!ui.open) { ui.open = true; ctl.draw(); } });
    pop.addEventListener('mousedown', (e) => e.preventDefault()); // clicking a result must not blur the field first
    view.card.el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.open) ctl.close(); });
    ui.close = ctl.close;
  };
  ctl.inline = (panel) => {
    const input = el('input', 'mc-search-input');
    const list = el('div', 'mc-results');
    list.id = `mc-results-${id}`;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', `${o.name} search results`);
    const box = el('div', 'mc-searchbox');
    box.append(input);
    panel.append(box, list);
    const p = pane('inline', { input, list });
    wireInput(p);
    p.input.setAttribute('aria-expanded', 'true');
    return { draw: () => drawPane(p), input };
  };
  return ctl;
}

document.addEventListener('pointerdown', (e) => { // a click outside the card closes its search
  for (const [id, ui] of musicUi) {
    if (!ui.open || !ui.close) continue;
    const c = document.querySelector(`.w-card[data-id="${id}"]`);
    if (c && !c.contains(e.target)) ui.close();
  }
}, true);

// What the page's renderers call (renderer/newtab-widgets.js): the card for an engine mode or for Spotify's API mode, and `update` for a card
// that stays (renderWidgets in newtab-widgets.js keeps the element and hands it the new data).
function unavailable(w, card, o) {
  const d = w.data;
  card.head.append(refreshButton(w));
  card.el.classList.add('sp-card-idle');
  const msg = el('p', 'w-note', o.reasons[d.reason] || `Lumen couldn’t start ${o.name}. Try again.`);
  msg.setAttribute('role', 'status');
  card.body.append(msg);
  const retry = el('button', 'w-btn', 'Try again');
  retry.type = 'button';
  retry.addEventListener('click', () => widgetAct(w.id, 'reload'));
  card.body.append(retry);
}
function engineCard(w, card, o) {
  if (w.data.state === 'unavailable') { unavailable(w, card, o); return; }
  const view = build(w, card, o);
  card.el._music = view;
  view.update(w);
}
const musicCard = { engineCard, ENGINES, build, uiOf, musicUi, TAB_ORDER, ICONS };
globalThis.musicCard = musicCard;
if (typeof module !== 'undefined' && module.exports) module.exports = musicCard;
})();
