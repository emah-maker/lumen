// The Spotify bridge (features/spotify-bridge.js) against pages SAVED from open.spotify.com (test/fixtures/spotify/*.json: the desktop layout,
// signed out, captured 2026-10-07 with Lumen's own browser identity, trimmed, nothing personal): the real data-testid / aria-label / href
// structure of the home page, the search results (all kinds, and the songs-only list), a track, an album and a playlist page. A small DOM
// (below: elements, a selector matcher for the subset the selector table uses, a MutationObserver) runs the real page script in a vm, with a
// fake router that swaps in the saved pages after a delay, the way the web player's own router does.
//
// What is real and what is assumed is marked: the playbar, the search pages and the items' play buttons are as saved. The now-playing
// widget (only signed-in pages have one) is written by hand from public knowledge of the player and marked ASSUMED below, as is the "no
// results" text. Refreshing the fixtures (and the SELECTORS table) after a Spotify change is the way to keep this suite meaningful.
// Runs on its own (npm run test:units picks up test/*-units.js).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const SPB = require('../src/features/spotify-bridge');
const { createEngine } = require('../src/features/spotify-engine');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'spotify', `${name}.json`), 'utf8'));
const TREES = {};
const FIXTURES = { library: fixture('library').tree, queue: fixture('queue').tree, searchRows: fixture('search-rows').tree }; // (pieces of the signed-in page, 2026-10-08; the library's panel as seen again 2026-10-11)
// The library widened by its "Expand Your Library" button (seen 2026-10-11): ul[role=treegrid] > li[role=row] > div[data-encore-id=card], ids card-title-spotify:<kind>:<id> on an <a>.
const wideLibrary = (rows) => ({ t: 'nav', a: { 'aria-label': 'Main' }, c: [
  { t: 'header', c: [{ t: 'div', c: [{ t: 'button', a: { 'aria-label': 'Create' }, c: [] }, { t: 'button', a: { 'aria-label': 'Minimize Your Library' }, c: [] }] }] },
  { t: 'div', a: { 'data-overlayscrollbars-viewport': 'scrollbarHidden' }, c: [{ t: 'ul', a: { role: 'treegrid', 'aria-label': 'Your Library', 'aria-rowcount': '13', 'aria-colcount': '6' }, c: rows.map(([kind, id, title, sub]) => ({ t: 'li', a: { role: 'row', 'aria-level': '1', draggable: 'true' }, c: [{ t: 'div', a: { role: 'gridcell' }, c: [{ t: 'div', a: { 'data-encore-id': 'card', role: 'group', 'aria-labelledby': 'card-title-spotify:' + kind + ':' + id }, c: [{ t: 'img', a: { src: 'https://i.scdn.co/image/' + id, 'data-testid': 'card-image', alt: '' }, c: [] }, { t: 'a', a: { 'data-encore-id': 'cardTitle', id: 'card-title-spotify:' + kind + ':' + id, href: '/' + kind + '/' + id }, c: [{ t: 'span', c: [title] }] }, { t: 'p', a: { 'data-encore-id': 'cardSubtitle', id: 'card-subtitle-spotify:' + kind + ':' + id }, c: [{ t: 'span', c: [sub] }] }] }] }] })) }] },
] });
FIXTURES.libraryWide = wideLibrary([['collection', 'tracks', 'Liked Songs', 'Pinned' + 'Playlist • 2,763 songs'], ['playlist', 'WIDE0000000000000000A', 'Road trip', 'Pinned' + 'Playlist • Sam'], ['album', 'WIDE0000000000000000B', 'Discovery', 'Album • Daft Punk']]);
for (const n of ['home', 'search-all', 'search-tracks', 'track', 'album', 'playlist']) TREES[n] = fixture(n).tree;
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---- a small DOM ----
function splitTop(str, sep) { // split on `sep` outside [..] and quotes
  const out = []; let cur = ''; let depth = 0; let quote = false;
  for (const ch of str) {
    if (ch === '"') quote = !quote;
    if (!quote && ch === '[') depth++;
    if (!quote && ch === ']') depth--;
    if (!quote && depth === 0 && (sep === ' ' ? /\s/.test(ch) : ch === sep)) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function parseCompound(c) {
  const m = /^([a-zA-Z][\w-]*|\*)?((?:\[[^\]]+\])*)$/.exec(c);
  if (!m) throw new Error(`selector outside the supported subset: ${c}`);
  const attrs = [];
  m[2].replace(/\[([\w-]+)(?:([\^$*]?=)"([^"]*)")?\]/g, (_, name, op, val) => { attrs.push({ name, op, val }); return ''; });
  return { tag: m[1] && m[1] !== '*' ? m[1].toLowerCase() : '', attrs };
}
function matchCompound(el, c) {
  if (c.tag && el.localName !== c.tag) return false;
  return c.attrs.every(({ name, op, val }) => {
    const v = el.getAttribute(name);
    if (v === null) return false;
    if (!op) return true;
    if (op === '=') return v === val;
    if (op === '^=') return v.startsWith(val);
    if (op === '$=') return v.endsWith(val);
    return v.includes(val);
  });
}
const parseSelector = (sel) => splitTop(sel, ',').map((one) => splitTop(one, ' ').map(parseCompound));
function matchesParsed(el, parsed) {
  return parsed.some((parts) => {
    if (!matchCompound(el, parts[parts.length - 1])) return false;
    let node = el.parentNode; let i = parts.length - 2;
    while (i >= 0 && node && node.localName) { if (matchCompound(node, parts[i])) i--; node = node.parentNode; }
    return i < 0;
  });
}
function makeEl(spec, parent, log) {
  if (typeof spec === 'string') return { text: spec, nodeType: 3, parentNode: parent };
  const el = {
    nodeType: 1, localName: spec.t, tagName: spec.t.toUpperCase(), attrs: { ...(spec.a || {}) }, parentNode: parent, clicks: 0, disabled: false, events: [],
    getAttribute(n) { return n in el.attrs ? el.attrs[n] : null; },
    get parentElement() { return el.parentNode && el.parentNode.nodeType === 1 ? el.parentNode : null; },
    get src() { return el.attrs.src || ''; }, get alt() { return el.attrs.alt || ''; }, get max() { return el.attrs.max || ''; },
    get textContent() { return el.childNodes.map((c) => (c.nodeType === 3 ? c.text : c.textContent)).join(''); },
    get children() { return el.childNodes.filter((c) => c.nodeType === 1); },
    click() { el.clicks++; log.clicked.push(el); },
    dispatchEvent(ev) { el.events.push(ev.type); if (log.onEvent) log.onEvent(el, ev); return true; },
    matches(sel) { return matchesParsed(el, parseSelector(sel)); },
    closest(sel) { const p = parseSelector(sel); for (let n = el; n && n.localName; n = n.parentNode) if (matchesParsed(n, p)) return n; return null; },
    querySelectorAll(sel) { const p = parseSelector(sel); const out = []; const walk = (n) => { for (const c of n.children) { if (matchesParsed(c, p)) out.push(c); walk(c); } }; walk(el); return out; },
    querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
  };
  el.childNodes = (spec.c || []).map((c) => makeEl(c, el, log));
  if (spec.scroll) { // a list that scrolls (spec.scroll: { h: its content height, ch: its visible height }): setting scrollTop tells log.onScroll, which may swap the rows in
    el.scrollHeight = spec.scroll.h; el.clientHeight = spec.scroll.ch;
    let top = 0;
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => top, set: (v) => { top = v; if (log.onScroll) log.onScroll(el, v); } });
  }
  return el;
}

// ---- a page: the real script in a vm, a fake router ----
// route(path, h): called on pushState; h.after(ms, treeOrFn) swaps the page's content then, h.location is the address.
// typing: ms the page's own router takes to open /search/<term> after the box is typed into (null: typing does nothing, as a box that is not wired).
function page({ tree = TREES.home, route = () => {}, md = null, typing = 80, typeFirst = false } = {}) {
  const log = { clicked: [], pushed: [], out: [], typedTerms: [] };
  let clock = 1e12;
  let tid = 0;
  const timers = [];
  const observers = [];
  let body = makeEl(clone(tree), null, log);
  const listeners = {};
  const location = { pathname: '/' };
  const setTimeout_ = (f, ms) => { timers.push({ id: ++tid, f, at: clock + (ms || 0) }); return tid; };
  const notify = () => observers.forEach((o) => { if (!o.off) setTimeout_(() => { if (!o.off) o.cb([]); }, 0); });
  const swap = (t) => { body = makeEl(clone(typeof t === 'function' ? t() : t), null, log); notify(); };
  class MutationObserver { constructor(cb) { this.cb = cb; this.off = false; observers.push(this); } observe() {} disconnect() { this.off = true; } }
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  class PopStateEvent { constructor(type) { this.type = type; } }
  class Event { constructor(type) { this.type = type; } }
  const HTMLInputElement = function HTMLInputElement() {};
  HTMLInputElement.prototype = {};
  Object.defineProperty(HTMLInputElement.prototype, 'value', { configurable: true, set(v) { this.__v = v; }, get() { return this.__v; } });
  const typed = [];
  const ctx = {
    document: {
      get documentElement() { return body; },
      addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
      dispatchEvent: (e) => { if (e.type === 'lumen-engine-out') log.out.push(JSON.parse(e.detail)); (listeners[e.type] || []).forEach((f) => f(e)); return true; },
      querySelector: (sel) => body.querySelector(sel),
      querySelectorAll: (sel) => (sel === 'audio, video' ? [] : body.querySelectorAll(sel)),
    },
    navigator: { mediaSession: { metadata: md } },
    history: { pushState: (s, t, url) => { log.pushed.push(url); location.pathname = url; } },
    window: { getComputedStyle: (n) => ({ overflowY: n.scrollHeight ? 'auto' : 'visible' }), dispatchEvent: (e) => { if (e.type === 'popstate') route(location.pathname, { after: (ms, t) => setTimeout_(() => swap(t), ms), swap, location }); } },
    location, CustomEvent, PopStateEvent, Event, HTMLInputElement, MutationObserver,
    MouseEvent: class MouseEvent { constructor(type) { this.type = type; } },
    Date: { now: () => clock },
    setTimeout: setTimeout_,
    clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.dead = true; },
    setInterval: (f, ms) => { timers.push({ id: ++tid, f, at: clock + ms, every: ms }); return tid; },
  };
  log.onEvent = (el, ev) => { // the page's router answering the search box (typed into by the script: value set, then an input event)
    if (ev.type !== 'input' || el.getAttribute('data-testid') !== 'search-input') return;
    log.typedTerms.push(el.__v);
    if (typing === null) return;
    const url = `/search/${encodeURIComponent(el.__v)}`;
    setTimeout_(() => { ctx.history.pushState({}, '', url); ctx.window.dispatchEvent(new PopStateEvent('popstate')); }, typing);
  };
  vm.createContext(ctx);
  vm.runInContext(typeFirst ? SPB.BRIDGE_SOURCE.replace('var TYPE_FIRST = false;', 'var TYPE_FIRST = true;') : SPB.BRIDGE_SOURCE, ctx);
  const advance = (ms) => {
    notify(); // (a test changes the stand-in page's elements directly: the real page's MutationObserver would have been told)
    const end = clock + ms;
    for (;;) {
      const due = timers.filter((t) => !t.dead && t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      clock = due.at;
      if (due.every) due.at += due.every; else due.dead = true;
      due.f();
    }
    clock = end;
  };
  const send = (obj) => ctx.document.dispatchEvent(new CustomEvent('lumen-engine-in', { detail: JSON.stringify(obj) }));
  const lists = () => log.out.filter((x) => x.t === 'list');
  const states = () => log.out.filter((x) => x.t === 'state');
  const errors = () => log.out.filter((x) => x.t === 'error');
  const el = (sel) => body.querySelector(sel);
  return { ...log, log, advance, send, swap, swapLater: (ms, t) => setTimeout_(() => swap(t), ms), lists, states, errors, el, all: (sel) => body.querySelectorAll(sel), location, typed, last: () => states().at(-1), now: () => clock };
}

// A saved search page, made to be about another term (new ids), the way a second search shows other results.
function retarget(tree, term) {
  if (term === 'daft punk') return clone(tree); // (the saved page is about that term)
  let s = JSON.stringify(tree);
  s = s.replace(/daft%20punk/g, encodeURIComponent(term)).replace(/daft punk/g, term).replace(/Daft Punk/g, term.replace(/\b\w/g, (c) => c.toUpperCase()));
  s = s.replace(/(\/(?:track|album|artist|playlist)\/)([A-Za-z0-9]{22})/g, (_, a, id) => `${a}Q${id.slice(1)}`);
  return JSON.parse(s);
}
// A saved page as a signed-in user would see it: no Log in / Sign up buttons and no "preview" banner.
function signedIn(tree) {
  const drop = new Set(['login-button', 'signup-button', 'signup-bar']);
  const walk = (n) => (typeof n === 'string' ? n : { ...n, c: (n.c || []).filter((c) => typeof c === 'string' || !drop.has(c.a && c.a['data-testid'])).map(walk) });
  return walk(clone(tree));
}
const searchRoute = (term, { allMs = 600, tracksMs = 500 } = {}) => (p, h) => {
  const enc = encodeURIComponent(term);
  if (p === `/search/${enc}`) h.after(allMs, retarget(TREES['search-all'], term));
  else if (p === `/search/${enc}/tracks`) h.after(tracksMs, retarget(TREES['search-tracks'], term));
};
// The saved results page with only its first `n` song rows (a page that is still rendering).
function firstRows(tree, n) {
  let seen = 0;
  const walk = (node) => {
    if (typeof node === 'string') return node;
    return { ...node, c: (node.c || []).filter((c) => { if (typeof c !== 'string' && c.a && c.a['data-testid'] === 'tracklist-row') return ++seen <= n; return true; }).map(walk) };
  };
  return walk(clone(tree));
}
const titles = (list, kind) => list.items.filter((i) => i.kind === kind).map((i) => i.title);

// ---- the engine's fake page (as in test/music-card-units.js) ----
function fakePlayer() {
  const p = {
    gen: 0, st: { state: 'ready', drm: 'ok' }, wc: null, signed: true, wins: [],
    ensure() { if (!p.wc) { p.wc = { sent: [], executeJavaScript(code) { const m = /detail: (".*") \}\)\)$/.exec(code); if (m) p.wc.sent.push(JSON.parse(JSON.parse(m[1]))); return Promise.resolve(); } }; p.gen++; } return {}; },
    webContents: () => p.wc, status: () => p.st, isSignedIn: () => p.signed, generation: () => p.gen,
    destroy() { p.wc = null; p.gen++; }, showIn(win) { p.wins.push(win); }, release() {}, reload() { p.gen++; },
  };
  return p;
}

module.exports = async function spotifyDomUnits(check) {
  // ================= the selector table against the saved pages =================
  // Names that only a signed-in page (or an unplayed control) shows: written from public knowledge, not seen in the saved pages.
  const ASSUMED = ['nowPlaying', 'title', 'artist', 'artistLinks', 'cover', 'connect', 'chrome', 'like', 'contextLink', 'menuItem', 'queueButton', 'libraryTitleAlt', 'librarySubtitleAlt', 'libraryExpand']; // (shuffle, repeat, volume, lyrics, the three-dots button and the track page's album link are seen)
  const pages = Object.entries(TREES).map(([name, tree]) => [name, makeEl(clone(tree), null, { clicked: [] })]);
  const pieces = [['library', makeEl(clone(FIXTURES.library), null, { clicked: [] })], ['libraryWide', makeEl(clone(FIXTURES.libraryWide), null, { clicked: [] })], ['queue', makeEl(clone(FIXTURES.queue), null, { clicked: [] })], ['searchRows', makeEl(clone(FIXTURES.searchRows), null, { clicked: [] })]];
  const seen = (name) => [...pages, ...pieces].filter(([, root]) => SPB.SELECTORS[name].some((s) => root.querySelector(s) || root.matches(s))).map(([n]) => n);
  const unseen = Object.keys(SPB.SELECTORS).filter((n) => !ASSUMED.includes(n) && seen(n).length === 0);
  check('dom: every selector name in the table (but the marked, signed-in-only ones) matches in at least one saved open.spotify.com page', unseen.length === 0, `not found in any saved page: ${unseen.join(', ')}`);
  check('dom: the primary selector of each playbar control matches the real playbar (play/pause, next, previous, repeat, volume, progress slider, position, duration)', ['playPause', 'next', 'previous', 'repeat', 'volume', 'progressInput', 'position', 'duration', 'nowPlayingBar'].every((n) => pages.every(([, root]) => root.querySelector(SPB.SELECTORS[n][0]))), '');
  check('dom: every selector in the table is class-free (hashed class names change with every build)', Object.values(SPB.SELECTORS).flat().every((s) => !/[.#][A-Za-z]/.test(s.replace(/"[^"]*"/g, ''))), '');
  check('dom: the page script carries exactly that table', SPB.BRIDGE_SOURCE.includes(JSON.stringify(SPB.SELECTORS)), '');

  // ================= signed out / signed in =================
  const home = page({ tree: TREES.home });
  home.advance(1000);
  check('dom: signed out: the page\'s Log in button is not believed on its first look (the page may still be starting)…', home.last().signedOut === null && home.last().player === true, JSON.stringify(home.last()));
  home.advance(3000);
  check('dom: …but is reported as signed out once it is still there a few seconds later, with the player\'s controls present', home.last().signedOut === true && home.last().player === true && home.last().state === 0, JSON.stringify(home.last()));
  const inHome = page({ tree: signedIn(TREES.home) });
  inHome.advance(3000);
  check('dom: signed in (no Log in button, controls present): signedOut is false', inHome.last().signedOut === false && inHome.last().player === true, JSON.stringify(inHome.last()));
  check('dom: what the page sends parses and keeps signedOut (true, false, or null while unknown)', SPB.parseMessage(JSON.stringify(home.last())).signedOut === true && SPB.parseMessage(JSON.stringify(inHome.last())).signedOut === false && SPB.parseMessage(JSON.stringify(home.states()[0])).signedOut === null, '');
  const blank = page({ tree: { t: 'body', c: [{ t: 'main', c: ['Loading'] }] } });
  blank.advance(8000);
  check('dom: a page with no player controls and no Log in button says player: false (the card then says Spotify changed its page)', blank.last().player === false && blank.last().signedOut === null, JSON.stringify(blank.last()));

  // ================= controls =================
  const ctl = page({ tree: signedIn(TREES.home) });
  const idle = ctl.el('[data-testid="control-button-playpause"]');
  check('dom: the saved play/pause button reads "Pause" while the signed-out preview is idle (so nothing is "playing" without a title)', idle && /^(Play|Pause)$/.test(idle.getAttribute('aria-label')) && ctl.last().state === 0, String(idle && idle.getAttribute('aria-label')));
  ctl.send({ cmd: 'next' }); ctl.send({ cmd: 'previous' });
  check('dom: next and previous click the real skip buttons', ctl.el('[data-testid="control-button-skip-forward"]').clicks === 1 && ctl.el('[data-testid="control-button-skip-back"]').clicks === 1, '');
  idle.attrs['aria-label'] = 'Play';
  ctl.send({ cmd: 'play' });
  check('dom: play clicks the real play/pause button when it says Play', idle.clicks === 1, '');
  idle.attrs['aria-label'] = 'Pause';
  ctl.send({ cmd: 'pause' });
  check('dom: pause clicks it when it says Pause', idle.clicks === 2, '');
  ctl.send({ cmd: 'seek', sec: 30 });
  check('dom: a seek with nothing loaded (no length) is not an error and moves nothing', ctl.errors().length === 0, JSON.stringify(ctl.errors()));
  const bare = page({ tree: { t: 'body', c: [{ t: 'main', c: ['Something else'] }] } });
  for (const cmd of [{ cmd: 'play' }, { cmd: 'pause' }, { cmd: 'next' }, { cmd: 'previous' }, { cmd: 'seek', sec: 5 }]) bare.send(cmd);
  const errs = bare.errors();
  check('dom: with no player controls on the page every button answers with the specific message, not silence or a timeout', errs.length === 5 && errs.every((e) => e.message === SPB.NO_PLAYER) && /player controls weren.t found.*signed in/.test(SPB.NO_PLAYER), JSON.stringify(errs));
  check('dom: that message passes the message check', SPB.parseMessage(JSON.stringify(errs[0])).message === SPB.NO_PLAYER, '');

  // ---- the now-playing widget (ASSUMED: only signed-in pages have it) ----
  const widget = (extra) => ({ t: 'div', a: { 'data-testid': 'now-playing-widget', ...(extra || {}) }, c: [
    { t: 'img', a: { 'data-testid': 'cover-art-image', src: 'https://i.scdn.co/image/ab67616d00001e02abc' } },
    { t: 'a', a: { 'data-testid': 'context-item-link', href: '/track/0DiWol3AO6WpXZgp0goxAV' }, c: ['One More Time'] },
    { t: 'span', c: [{ t: 'a', a: { 'data-testid': 'context-item-info-artist', href: '/artist/4tZwfgrHOc3mvqYlEYSvVi' }, c: ['Daft Punk'] }] },
  ] });
  const withWidget = (w) => { const t = signedIn(TREES.home); const bar = JSON.stringify(t).includes('now-playing-bar'); const walk = (n) => (typeof n === 'string' ? n : (n.a && n.a['data-testid'] === 'now-playing-bar' ? { ...n, c: [w, ...(n.c || [])] } : { ...n, c: (n.c || []).map(walk) })); return bar ? walk(t) : t; };
  const np = page({ tree: withWidget(widget()) });
  np.advance(1000);
  check('dom (assumed widget): with no media session it reads title, artist and cover from the widget', np.last().item && np.last().item.title === 'One More Time' && np.last().item.artist === 'Daft Punk' && np.last().item.art.startsWith('https://i.scdn.co/'), JSON.stringify(np.last()));
  const lab = { t: 'div', a: { 'data-testid': 'now-playing-widget', 'aria-label': 'Now playing: One More Time by Daft Punk' } };
  const np2 = page({ tree: withWidget(lab) });
  np2.advance(1000);
  check('dom (assumed widget): when the widget\'s parts are not found its own "Now playing: Song by Artist" label is read', np2.last().item && np2.last().item.title === 'One More Time' && np2.last().item.artist === 'Daft Punk', JSON.stringify(np2.last()));
  const mediaSession = page({ tree: signedIn(TREES.home), md: { title: 'From Session', artist: 'Ann', album: 'Alb', artwork: [] } });
  mediaSession.advance(1000);
  check('dom: the page\'s media session wins over the widget (it is the page\'s official surface)', mediaSession.last().item.title === 'From Session', JSON.stringify(mediaSession.last()));


  // ================= the bigger card: switches, heart, queue, album playing, lyrics, library (music card at its larger sizes) =================
  // Shuffle, repeat and volume are seen on the saved playbar (signed out); the heart, the queue page, the library links and a context menu are
  // ASSUMED (a signed-in page): hand-written below from public knowledge of the player, marked as such.
  const sw = page({ tree: signedIn(TREES.home) });
  sw.advance(1000);
  check('dom: the playbar\'s switches are read: shuffle off ("Enable shuffle"), repeat off (aria-checked false), the volume control found; no heart on a page with no now-playing widget', sw.last().shuffle === false && sw.last().repeat === 'off' && sw.last().has.shuffle === true && sw.last().has.repeat === true && sw.last().has.volume === true && sw.last().has.like === false && sw.last().liked === null, JSON.stringify(sw.last()));
  const shuf = sw.all('button').find((b) => b.getAttribute('aria-label') === 'Enable shuffle');
  sw.send({ cmd: 'shuffle', on: false });
  check('dom: asking for shuffle off when it is off presses nothing', shuf.clicks === 0, String(shuf.clicks));
  sw.send({ cmd: 'shuffle', on: true });
  check('dom: asking for shuffle on presses the real shuffle button once', shuf.clicks === 1, String(shuf.clicks));
  shuf.attrs['aria-label'] = 'Disable shuffle';
  sw.advance(1500);
  check('dom: "Disable shuffle" on the button reads as shuffle on', sw.last().shuffle === true, JSON.stringify(sw.last()));
  const rep = sw.el('[data-testid="control-button-repeat"]');
  sw.send({ cmd: 'repeat', mode: 'off' });
  check('dom: asking for repeat off when it is off presses nothing', rep.clicks === 0, String(rep.clicks));
  sw.send({ cmd: 'repeat', mode: 'one' });
  sw.advance(2000);
  check('dom: a repeat mode the button never reaches is pressed at most three times (never a loop)', rep.clicks === 3, String(rep.clicks));
  rep.attrs['aria-checked'] = 'mixed';
  sw.advance(1500);
  check('dom: repeat reads aria-checked: mixed is "all", true is "one"', sw.last().repeat === 'all' && (rep.attrs['aria-checked'] = 'true', sw.advance(1500), sw.last().repeat === 'one'), JSON.stringify(sw.last()));
  const volInput = sw.el('[data-testid="volume-bar"] input[type="range"]');
  sw.send({ cmd: 'volume', level: 0.4 });
  check('dom: the volume command sets the range input and fires input and change on it (as the page\'s own slider does)', volInput.__v === '0.4' && volInput.events.includes('input') && volInput.events.includes('change'), JSON.stringify([volInput.__v, volInput.events]));
  volInput.attrs.max = '1';
  volInput.__v = '0.25';
  Object.defineProperty(volInput, 'value', { get() { return volInput.__v; } });
  sw.advance(1500);
  check('dom: the volume is read as the input\'s value over its max', sw.last().volume === 0.25, JSON.stringify(sw.last()));

  // the heart (ASSUMED widget button)
  const heartWidget = (label, checked) => ({ ...widget(), c: [...widget().c, { t: 'button', a: { 'aria-label': label, 'aria-checked': checked }, c: [] }] });
  const hp = page({ tree: withWidget(heartWidget('Add to Liked Songs', 'false')) });
  hp.advance(1000);
  check('dom (assumed widget): the heart is found and reads not liked', hp.last().has.like === true && hp.last().liked === false, JSON.stringify(hp.last()));
  hp.send({ cmd: 'like', on: true });
  check('dom (assumed widget): like on presses it once; like off (already off) presses nothing', hp.clicked.length === 1 && (hp.send({ cmd: 'like', on: false }), hp.clicked.length === 1), String(hp.clicked.length));
  const hp2 = page({ tree: withWidget(heartWidget('Remove from Liked Songs', 'true')) });
  hp2.advance(1000);
  check('dom (assumed widget): "Remove from Liked Songs" with aria-checked true reads as liked', hp2.last().liked === true, JSON.stringify(hp2.last()));
  const hp3 = page({ tree: withWidget(heartWidget('Save to Your Library', 'false')) });
  hp3.advance(1000);
  check('dom (assumed widget): the older "Save to Your Library" label is a heart too', hp3.last().has.like === true && hp3.last().liked === false, JSON.stringify(hp3.last()));

  // lyrics: the song's own page, seen signed out (a gate)
  const trackRoute = (p, h) => { if (p.startsWith('/track/')) h.after(400, signedIn(TREES.track)); };
  const lyOut = page({ tree: withWidget(widget()), route: (p, h) => { if (p.startsWith('/track/')) h.after(400, TREES.track); } });
  lyOut.advance(1000);
  lyOut.send({ cmd: 'lyrics', rid: 7 });
  lyOut.advance(3000);
  const lyMsg = lyOut.log.out.find((m) => m.t === 'lyrics');
  check('dom: signed out, the track page\'s lyrics box holds only a "Sign in to see lyrics" gate: lyrics say why "signedOut" (the card says to sign in)', lyMsg && lyMsg.ok === false && lyMsg.why === 'signedOut' && lyMsg.rid === 7 && lyOut.pushed[0] === '/track/0DiWol3AO6WpXZgp0goxAV', JSON.stringify(lyMsg));
  const withLines = (tree) => { const t = clone(tree); const walk = (n) => { if (typeof n === 'string') return n; if (n.a && n.a['data-testid'] === 'lyrics-container') return { ...n, c: [{ t: 'h2', c: ['Lyrics'] }, { t: 'div', c: [{ t: 'span', c: ['We were never gonna stop'] }, { t: 'span', c: ['One more time'] }, { t: 'span', c: ['One more time'] }, { t: 'span', c: ['Celebrate'] }] }] }; return { ...n, c: (n.c || []).map(walk) }; }; return walk(t); };
  const lyIn = page({ tree: withWidget(widget()), route: (p, h) => { if (p.startsWith('/track/')) h.after(400, withLines(signedIn(TREES.track))); } });
  lyIn.advance(1000);
  lyIn.send({ cmd: 'lyrics', rid: 8 });
  lyIn.advance(3000);
  const lyOk = lyIn.log.out.find((m) => m.t === 'lyrics');
  check('dom (assumed signed-in lyrics box): the lines are read, one each, with no title and no immediate repeats', lyOk && lyOk.ok === true && JSON.stringify(lyOk.lines) === JSON.stringify(['We were never gonna stop', 'One more time', 'Celebrate']), JSON.stringify(lyOk));
  check('dom: the lyrics message passes the message check (bounded lines, a known why)', SPB.parseMessage(JSON.stringify(lyOk)).lines.length === 3 && SPB.parseMessage(JSON.stringify(lyMsg)).why === 'signedOut' && SPB.parseMessage(JSON.stringify({ t: 'lyrics', rid: 1, ok: false, why: 'whatever' })).why === 'page' && SPB.parseMessage(JSON.stringify({ t: 'lyrics', rid: 1, ok: true, lines: Array.from({ length: 400 }, () => 'x') })).lines.length === 250, '');
  void trackRoute;

  // the album playing: the song's page, its album link, the album's rows
  const albumRoute = (p, h) => { if (p.startsWith('/track/')) h.after(400, signedIn(TREES.track)); else if (p.startsWith('/album/')) h.after(400, signedIn(TREES.album)); };
  const tk = page({ tree: withWidget(widget()), route: albumRoute });
  tk.advance(1000);
  tk.send({ cmd: 'list', kind: 'tracks', rid: 21 });
  tk.advance(6000);
  const tkMsg = tk.lists().find((l) => l.kind === 'tracks');
  check('dom: the album playing is found through the song\'s page and its album link, and its rows listed with the playing song marked', tkMsg && tkMsg.ok === true && tkMsg.rid === 21 && tkMsg.items.length === 7 && tkMsg.items[0].title === 'One More Time' && tkMsg.current === 0 && tkMsg.title === 'Discovery' && JSON.stringify(tk.pushed) === JSON.stringify(['/track/0DiWol3AO6WpXZgp0goxAV', '/album/2noRn2Aes5aoNVsU6iWThc']), JSON.stringify([tkMsg && { ok: tkMsg.ok, n: tkMsg.items.length, cur: tkMsg.current, title: tkMsg.title }, tk.pushed]));
  tk.send({ cmd: 'playFrom', index: 2, id: tkMsg.items[2].id });
  tk.advance(3000);
  const albumRows = tk.all('[data-testid="tracklist-row"]');
  check('dom: "play from here" presses that row\'s own Play button on the album page', tk.clicked.length === 1 && tk.clicked[0].closest('[data-testid="tracklist-row"]') === albumRows[2] && tk.errors().length === 0, JSON.stringify([tk.clicked.length, tk.errors()]));
  tk.send({ cmd: 'playFrom', index: 3, id: 'ZZZZZZZZZZZZZZZZZZZZZZ' });
  tk.advance(3000);
  check('dom: …but not when the song at that place is not the one the card showed (the list moved on): an error, nothing pressed', tk.clicked.length === 1 && tk.errors().some((e) => /list changed/.test(e.message)), JSON.stringify(tk.errors()));
  const noCtx = page({ tree: signedIn(TREES.home), route: albumRoute });
  noCtx.advance(1000);
  noCtx.send({ cmd: 'list', kind: 'tracks', rid: 22 });
  noCtx.advance(3000);
  check('dom: with no song playing there is no album to list: not ok, why "page" (the card says so)', noCtx.lists().some((l) => l.kind === 'tracks' && l.ok === false), JSON.stringify(noCtx.lists()));

  // the queue: a side panel opened by the playbar's queue button (seen signed in 2026-10-08, test/fixtures/spotify/queue.json): no /queue route,
  // rows with a hashed listrow id instead of a track id, a play button each, after a "Next from: ..." heading
  const withQueueButton = (tree, pressed) => { const t = signedIn(tree); const walk = (n) => (typeof n === 'string' ? n : (n.a && n.a['data-testid'] === 'now-playing-bar' ? { ...n, c: [{ t: 'button', a: { 'data-testid': 'control-button-queue', 'aria-pressed': pressed ? 'true' : 'false' }, c: [] }, ...(n.c || [])] } : { ...n, c: (n.c || []).map(walk) })); return walk(t); };
  const withPanel = (tree, panel) => ({ ...tree, c: [...(tree.c || []), clone(panel)] });
  const queuePage = () => page({ tree: withQueueButton(withWidget(widget()), false) });
  const pressQueueButton = (pg, panel, ms = 300) => { // wires the stand-in page: the queue button's click swaps in the panel
    const btn = pg.el('[data-testid="control-button-queue"]');
    const orig = btn.click;
    btn.click = () => { orig(); btn.attrs['aria-pressed'] = 'true'; pg.swapLater(ms, withPanel(withQueueButton(withWidget(widget()), true), panel)); };
    return btn;
  };
  const qp = queuePage();
  const qBtn = pressQueueButton(qp, FIXTURES.queue);
  qp.advance(1000);
  qp.send({ cmd: 'list', kind: 'queue', rid: 31 });
  qp.advance(5000);
  const qMsg = qp.lists().find((l) => l.kind === 'queue');
  check('dom (signed-in queue panel): the queue button is pressed once and the rows after "Next from" are listed (not the playing song), with the title, artists, picture and the hashed listrow id as id', qMsg && qMsg.ok === true && qMsg.rid === 31 && qBtn.clicks === 1 && qp.pushed.length === 0 && qMsg.items.map((i) => i.title).join('|') === 'Aerodynamic|Digital Love|Harder, Better, Faster, Stronger' && qMsg.items[0].id === 'a1b2c3d4e5f60718293a' && qMsg.items[0].sub === 'Daft Punk' && /^https:\/\/i\.scdn\.co\//.test(qMsg.items[0].art), JSON.stringify(qMsg));
  check('dom: the queue rows pass the message check (the synthetic id is accepted)', SPB.parseMessage(JSON.stringify(qMsg)).items.length === 3, '');
  qp.send({ cmd: 'playQueue', index: 1, id: qMsg.items[1].id });
  qp.advance(3000);
  const qPlay = qp.all('aside[aria-label="Queue"] li[role="row"]')[2].querySelector('button[data-testid="play-button"]');
  check('dom (signed-in queue panel): playing from the queue presses that row\'s own play button, without pressing the queue button again', qPlay.clicks === 1 && qBtn.clicks === 1 && qp.errors().length === 0, JSON.stringify([qPlay.clicks, qBtn.clicks, qp.errors()]));
  qp.send({ cmd: 'playQueue', index: 0, id: 'ffffffffffffffffffff' });
  qp.advance(3000);
  check('dom: …but not when the row there is not the song the card showed: an error, nothing pressed', qp.errors().some((e) => /list changed/.test(e.message)) && qp.clicked.filter((c) => c.getAttribute('data-testid') === 'play-button').length === 1, JSON.stringify(qp.errors()));
  const qOpen = page({ tree: withPanel(withQueueButton(withWidget(widget()), true), FIXTURES.queue) });
  const qOpenBtn = qOpen.el('[data-testid="control-button-queue"]');
  qOpen.advance(1000);
  qOpen.send({ cmd: 'list', kind: 'queue', rid: 34 });
  qOpen.advance(4000);
  check('dom: a queue panel that is already open is read without pressing the button (which would close it)', qOpenBtn.clicks === 0 && (qOpen.lists().find((l) => l.kind === 'queue') || {}).items.length === 3, JSON.stringify(qOpen.lists()));
  const emptyPanel = { t: 'aside', a: { 'aria-label': 'Queue' }, c: [{ t: 'h1', c: ['Queue'] }, { t: 'h2', c: ['Now playing'] }, { t: 'ul', c: [clone(FIXTURES.queue.c[1].c[1].c[0])] }] };
  const qEmpty = queuePage();
  pressQueueButton(qEmpty, emptyPanel);
  qEmpty.advance(1000);
  qEmpty.send({ cmd: 'list', kind: 'queue', rid: 32 });
  qEmpty.advance(8000);
  check('dom: a queue panel with only the playing song is an ok, empty list (not a timeout)', qEmpty.lists().some((l) => l.kind === 'queue' && l.ok === true && l.items.length === 0), JSON.stringify(qEmpty.lists()));
  const qNever = queuePage();
  qNever.advance(1000);
  qNever.send({ cmd: 'list', kind: 'queue', rid: 35 });
  qNever.advance(12000);
  check('dom: a queue panel that never opens is a failed read (not a list that stays loading)', (qNever.lists().find((l) => l.kind === 'queue') || {}).ok === false, JSON.stringify(qNever.lists()));
  const qOut = page({ tree: TREES.home, route: () => {} });
  qOut.advance(4000);
  qOut.send({ cmd: 'list', kind: 'queue', rid: 33 });
  qOut.advance(12000);
  check('dom: signed out, a queue that never shows says why "signedOut" (the card says to sign in)', (qOut.lists().find((l) => l.kind === 'queue') || {}).ok === false && (qOut.lists().find((l) => l.kind === 'queue') || {}).why === 'signedOut', JSON.stringify(qOut.lists()));

  // the library: rows without links (seen signed in 2026-10-08, test/fixtures/spotify/library.json); the uri is in the title's id
  const libTree = (() => { const t = signedIn(TREES.home); const walk = (n) => (typeof n === 'string' ? n : (n.a && n.a['aria-label'] === 'Your Library' ? clone(FIXTURES.library) : { ...n, c: (n.c || []).map(walk) })); return walk(t); })();
  const lb = page({ tree: libTree });
  lb.advance(1000);
  lb.send({ cmd: 'list', kind: 'playlists', rid: 41 });
  lb.send({ cmd: 'list', kind: 'recent', rid: 42 });
  lb.advance(2000);
  const lbMsg = lb.lists().find((l) => l.kind === 'playlists');
  check('dom (signed-in library rows): playlists, albums and artists are listed by the ids in the row titles, with their picture; Liked Songs and a podcast are left out', lbMsg && lbMsg.ok === true && lbMsg.items.map((i) => `${i.kind}:${i.id}:${i.title}`).join('|') === 'playlist:6fkEZmCPjpLtGPnHSVYPbE:Late night drive|album:2noRn2Aes5aoNVsU6iWThc:Discovery|artist:4tZwfgrHOc3mvqYlEYSvVi:Daft Punk|playlist:37i9dQZF1DXcBWIGoYBM5M:Today\'s Top Hits' && lbMsg.items[0].sub === 'Sam' && lbMsg.items[1].sub === 'Daft Punk' && lbMsg.items[2].sub === '' && /^https:\/\/i\.scdn\.co\//.test(lbMsg.items[0].art) && lb.lists().find((l) => l.kind === 'recent').items.length === 0, JSON.stringify(lbMsg));
  check('dom: the library rows pass the message check', SPB.parseMessage(JSON.stringify(lbMsg)).items.length === 4, '');
  const lbNone = page({ tree: signedIn(TREES.home) });
  lbNone.advance(1000);
  lbNone.send({ cmd: 'list', kind: 'playlists', rid: 43 });
  lbNone.advance(9000);
  const lbNoneMsg = lbNone.lists().find((l) => l.kind === 'playlists');
  check('dom: a library the page never draws is a failed read (ok false), not an empty list the card would call "nothing here"', lbNoneMsg && lbNoneMsg.ok === false && lbNoneMsg.rid === 43, JSON.stringify(lbNoneMsg));
  const lbLate = page({ tree: signedIn(TREES.home) });
  lbLate.advance(1000);
  lbLate.send({ cmd: 'list', kind: 'playlists', rid: 44 });
  lbLate.advance(1500);
  lbLate.swap(libTree);
  lbLate.advance(2000);
  check('dom: a library that is drawn a moment later is waited for', (lbLate.lists().find((l) => l.kind === 'playlists') || {}).ok === true, JSON.stringify(lbLate.lists()));
  const lbOut = page({ tree: TREES.home });
  lbOut.advance(4000);
  lbOut.send({ cmd: 'list', kind: 'playlists', rid: 45 });
  lbOut.advance(1000);
  check('dom: signed out, the library is an ok, empty list marked signedOut', (lbOut.lists().find((l) => l.kind === 'playlists') || {}).signedOut === true, JSON.stringify(lbOut.lists()));

  // ---- the library, as the real page makes it hard: a collapsed panel, rows that load while scrolling, an empty library, a renamed panel, lazy pictures ----
  {
  const libRow = (kind, id, title, img) => ({ t: 'div', a: { role: 'row' }, c: [{ t: 'div', a: { 'data-encore-id': 'listRow', role: 'group' }, c: [img || { t: 'img', a: { src: `https://i.scdn.co/image/${id}` } }, { t: 'p', a: { 'data-encore-id': 'listRowTitle', id: `listrow-title-spotify:${kind}:${id}` }, c: [title] }, { t: 'p', a: { 'data-encore-id': 'listRowSubtitle', id: `listrow-subtitle-spotify:${kind}:${id}` }, c: ['Playlist • Sam'] }] }] });
  // The panel as the page makes it (2026-10-11): nav[aria-label="Main"] > header (the buttons) + the scrolling viewport > the grid labelled "Your Library". `header`: its buttons
  // (the open page has Collapse / Create / Expand), `beside`: what else sits in the viewport next to the list (the empty library's words).
  const hdr = (...labels) => ({ t: 'header', c: [{ t: 'div', c: labels.map((l) => ({ t: 'button', a: { 'aria-label': l }, c: [] })) }] });
  const libPanel = (rows, { header = [hdr('Collapse Your Library', 'Create', 'Expand Your Library')], beside = [], attrs = { 'aria-label': 'Your Library' }, scroll = null } = {}) => ({ t: 'nav', a: { 'aria-label': 'Main' }, c: [...header, { t: 'div', a: { 'data-overlayscrollbars-viewport': 'scrollbarHidden' }, ...(scroll ? { scroll } : {}), c: [...beside, { t: 'div', a: { role: 'grid', ...attrs }, c: rows }] }] });
  const panelPage = (panel) => { const t = signedIn(TREES.home); const walk = (n) => (typeof n === 'string' ? n : (n.a && n.a['aria-label'] === 'Your Library' ? clone(panel) : { ...n, c: (n.c || []).map(walk) })); return walk(t); };
  const asked = (pg, rid) => { pg.advance(1000); pg.send({ cmd: 'list', kind: 'playlists', rid }); };
  const answer = (pg) => pg.lists().find((l) => l.kind === 'playlists');
  const openHeader = [hdr('Open Your Library', 'Create')];
  // collapsed to the icon rail: no titles, only the button that opens it; pressed once, the page draws the rows
  const colLib = page({ tree: panelPage(libPanel([], { header: openHeader })) });
  asked(colLib, 51);
  colLib.advance(900);
  const pressed = colLib.clicked.some((e) => e.getAttribute('aria-label') === 'Open Your Library');
  colLib.swap(libTree);
  colLib.advance(2500);
  check('dom (collapsed library): the panel is opened by its own "Open Your Library" button, then its rows are read', pressed && answer(colLib) && answer(colLib).ok === true && answer(colLib).items.length === 4, JSON.stringify([pressed, answer(colLib)]).slice(0, 300));
  // a panel that stays collapsed (the button does nothing) is a failure that says so
  const stuckLib = page({ tree: panelPage(libPanel([], { header: openHeader })) });
  asked(stuckLib, 52);
  stuckLib.advance(10000);
  check('dom (collapsed library): a panel that cannot be opened ends as why "collapsed", not an empty list', answer(stuckLib) && answer(stuckLib).ok === false && answer(stuckLib).why === 'collapsed' && SPB.parseMessage(JSON.stringify(answer(stuckLib))).why === 'collapsed', JSON.stringify(answer(stuckLib)));
  // lazy rows: the list is virtualised, so scrolling it draws the next rows and drops the first ones; all are collected
  const batches = [[['playlist', 'LAZY000000000000000A', 'One'], ['playlist', 'LAZY000000000000000B', 'Two'], ['album', 'LAZY000000000000000C', 'Three']], [['album', 'LAZY000000000000000C', 'Three'], ['artist', 'LAZY000000000000000D', 'Four'], ['playlist', 'LAZY000000000000000E', 'Five']], [['playlist', 'LAZY000000000000000E', 'Five'], ['playlist', 'LAZY000000000000000F', 'Six']]];
  const lazyTree = (n) => panelPage(libPanel(batches[n].map((r) => libRow(...r)), { scroll: { h: 3000, ch: 300 } }));
  const lazyLib = page({ tree: lazyTree(0) });
  let stage = 0;
  lazyLib.log.onScroll = () => { if (stage < batches.length - 1) { stage++; lazyLib.swap(lazyTree(stage)); } };
  asked(lazyLib, 53);
  lazyLib.advance(6000);
  check('dom (lazy library rows): rows the page draws only when the list is scrolled are collected as it is scrolled', answer(lazyLib) && answer(lazyLib).ok === true && answer(lazyLib).items.map((i) => i.title).join() === 'One,Two,Three,Four,Five,Six' && stage === 2, JSON.stringify([stage, answer(lazyLib) && answer(lazyLib).items.map((i) => i.title)]));
  // an empty library says so in its own words: an answer (ok, no rows, not signed out), not a failure
  const emptyLib = page({ tree: panelPage(libPanel([], { beside: [{ t: 'h2', c: ['Create your first playlist'] }, { t: 'p', c: ['It\u2019s easy, we\u2019ll help you'] }] })) });
  asked(emptyLib, 54);
  emptyLib.advance(3000);
  check('dom (empty library): a panel that says "Create your first playlist" is an ok, empty list (not a failure, not signed out)', answer(emptyLib) && answer(emptyLib).ok === true && answer(emptyLib).items.length === 0 && answer(emptyLib).signedOut === false, JSON.stringify(answer(emptyLib)));
  // no panel at all, or rows that never come with the player there: failures with their cause
  const noPane = page({ tree: { t: 'div', c: [{ t: 'footer', c: [{ t: 'button', a: { 'data-testid': 'control-button-playpause', 'aria-label': 'Play' }, c: [] }] }] } });
  asked(noPane, 55);
  noPane.advance(10000);
  check('dom (library gone): a page with its player but no library panel says why "noPanel" (the page changed), with a detail for the log', answer(noPane) && answer(noPane).ok === false && answer(noPane).why === 'noPanel' && /no panel/.test(answer(noPane).detail), JSON.stringify(answer(noPane)));
  // a panel under another label (a translated page): the rows inside the page's own left side are found anyway
  const deLib = page({ tree: panelPage(libPanel([libRow('playlist', 'DE0000000000000000001', 'Mein Mix')], { attrs: { 'aria-label': 'Deine Bibliothek' } })) });
  asked(deLib, 56);
  deLib.advance(3000);
  check('dom (renamed panel): rows under a different panel label are read through the side-bar fallback', answer(deLib) && answer(deLib).ok === true && answer(deLib).items.length === 1 && answer(deLib).items[0].title === 'Mein Mix', JSON.stringify(answer(deLib)));
  // a lazy picture (no src until it scrolls in; srcset on Spotify's newer image host)
  const lazyImg = { t: 'img', a: { src: '', srcset: 'https://image-cdn-ak.spotifycdn.com/image/ab67616d00004851aaaa 64w, https://image-cdn-ak.spotifycdn.com/image/ab67616d00001e02aaaa 300w' }, c: [] };
  const imgLib = page({ tree: panelPage(libPanel([libRow('album', 'IMG0000000000000000001', 'Pictured', lazyImg)])) });
  asked(imgLib, 57);
  imgLib.advance(3000);
  check('dom (lazy pictures): a library row\'s picture is taken from srcset when src is empty, and image-cdn-*.spotifycdn.com is a picture host the message check accepts', answer(imgLib) && answer(imgLib).items[0].art === 'https://image-cdn-ak.spotifycdn.com/image/ab67616d00004851aaaa' && SPB.parseMessage(JSON.stringify(answer(imgLib))).items[0].art === 'https://image-cdn-ak.spotifycdn.com/image/ab67616d00004851aaaa' && SPB.artUrl('https://evil.example/x.jpg') === '' && SPB.artUrl('https://i.scdn.co/image/x') !== '' && SPB.artUrl('https://mosaic.scdn.co/640/x') !== '', JSON.stringify(answer(imgLib)));

  // the real header (2026-10-11): "Expand Your Library" is there while the panel is OPEN and only widens the list into cards, so it is never pressed; the rows are read as they are
  const realLib = page({ tree: panelPage(libPanel(FIXTURES.library.c[2].c[0].c)) });
  asked(realLib, 61);
  realLib.advance(3000);
  check('dom (real library panel): the rows are read from nav > viewport > the grid labelled "Your Library", and no header button is pressed (Expand Your Library would widen the list into cards)', answer(realLib) && answer(realLib).ok === true && answer(realLib).items.length === 4 && realLib.clicked.length === 0, JSON.stringify([answer(realLib) && answer(realLib).items.length, realLib.clicked.map((e) => e.getAttribute('aria-label'))]));
  const noRows = page({ tree: panelPage(libPanel([])) });
  asked(noRows, 62);
  noRows.advance(10000);
  check('dom (real library panel): an open panel whose list never draws a row ends as why "timeout" (not "collapsed"), and Expand Your Library is not pressed', answer(noRows) && answer(noRows).ok === false && answer(noRows).why === 'timeout' && !noRows.clicked.some((e) => /^Expand/.test(e.getAttribute('aria-label') || '')) && /grid/.test(answer(noRows).detail), JSON.stringify([answer(noRows), noRows.clicked.length]));
  const railLib = page({ tree: panelPage(libPanel(FIXTURES.library.c[2].c[0].c, { header: openHeader })) });
  asked(railLib, 63);
  railLib.advance(3000);
  check('dom (library closed to its icon rail): the rows are there, so they are read and the panel is left closed', answer(railLib) && answer(railLib).ok === true && answer(railLib).items.length === 4 && railLib.clicked.length === 0, JSON.stringify([answer(railLib) && answer(railLib).items.length, railLib.clicked.length]));
  const wideLib = page({ tree: panelPage(FIXTURES.libraryWide) });
  asked(wideLib, 64);
  wideLib.advance(3000);
  const wideMsg = answer(wideLib);
  check('dom (library widened into cards): the card ids are read like the list rows (kind, id, title, with "Pinned" and the kind word dropped from the subtitle); Liked Songs is left out', wideMsg && wideMsg.ok === true && wideMsg.items.map((i) => i.kind + ':' + i.id + ':' + i.title + ':' + i.sub).join('|') === 'playlist:WIDE0000000000000000A:Road trip:Sam|album:WIDE0000000000000000B:Discovery:Daft Punk' && /^https:\/\/i\.scdn\.co\//.test(wideMsg.items[0].art), JSON.stringify(wideMsg));

  }

  // add to queue: the item's page, the three-dots button, the menu's "Add to queue"
  const menuTree = (t) => { const walk = (n) => (typeof n === 'string' ? n : (n.a && n.a['data-testid'] === 'now-playing-bar' ? { ...n, c: [...(n.c || []), { t: 'div', a: { role: 'menu' }, c: [{ t: 'button', a: { role: 'menuitem' }, c: ['Add to playlist'] }, { t: 'button', a: { role: 'menuitem' }, c: ['Add to queue'] }] }] } : { ...n, c: (n.c || []).map(walk) })); return walk(signedIn(t)); };
  const aq = page({ tree: signedIn(TREES.home), route: (p, h) => { if (p.startsWith('/track/')) h.after(400, menuTree(TREES.track)); } });
  aq.advance(1000);
  aq.send({ cmd: 'playLater', kind: 'song', id: '0DiWol3AO6WpXZgp0goxAV' });
  aq.advance(4000);
  check('dom (assumed menu): add to queue opens the song\'s page, presses its three-dots button, then the "Add to queue" entry (not "Add to playlist")', aq.pushed[0] === '/track/0DiWol3AO6WpXZgp0goxAV' && aq.clicked.length === 2 && aq.clicked[0].getAttribute('data-testid') === 'more-button' && /Add to queue/.test(aq.clicked[1].textContent) && aq.errors().length === 0, JSON.stringify([aq.clicked.map((c) => c.getAttribute('data-testid') || c.textContent), aq.errors()]));
  const aqNo = page({ tree: signedIn(TREES.home), route: (p, h) => { if (p.startsWith('/track/')) h.after(400, signedIn(TREES.track)); } });
  aqNo.advance(1000);
  aqNo.send({ cmd: 'playLater', kind: 'song', id: '0DiWol3AO6WpXZgp0goxAV' });
  aqNo.advance(8000);
  check('dom: a menu without "Add to queue" ends with a specific message, not silence', aqNo.errors().some((e) => /Add to queue/.test(e.message)), JSON.stringify(aqNo.errors()));
  aq.send({ cmd: 'playLater', kind: 'artist', id: '4tZwfgrHOc3mvqYlEYSvVi' });
  check('dom: an artist can not be added to the queue', SPB.cleanCommand({ cmd: 'playLater', kind: 'artist', id: '4tZwfgrHOc3mvqYlEYSvVi' }) === null, '');

  // a button's effect is reported within ~80 ms (not 400)
  const echo = page({ tree: signedIn(TREES.home) });
  echo.advance(1000);
  const nStates = echo.states().length;
  echo.send({ cmd: 'volume', level: 0.5 });
  echo.advance(90);
  check('dom: a command is followed by a state within 90 ms (the card hears what the page did at once, and again at 400 ms)', echo.states().length === nStates + 1 && (echo.advance(400), echo.states().length === nStates + 2), JSON.stringify([nStates, echo.states().length]));

  // ================= search =================
  const s1 = page({ tree: signedIn(TREES.home), route: searchRoute('daft punk') });
  s1.advance(1000);
  s1.send({ cmd: 'search', term: 'daft punk', rid: 5 });
  s1.advance(500);
  check('dom: search opens the page\'s own search route for the term (in the page, no reload) and says nothing while the page is still loading', s1.pushed[0] === '/search/daft%20punk' && s1.lists().length === 0, JSON.stringify([s1.pushed, s1.lists().length]));
  s1.advance(2500);
  const first = s1.lists()[0];
  check('dom: it answers once the results stand still: ok, the request number, songs from the saved page', first && first.ok === true && first.rid === 5 && titles(first, 'song').length === 4 && titles(first, 'song')[0] === 'One More Time', JSON.stringify(first && titles(first, 'song')));
  const one = first.items.find((i) => i.title === 'One More Time');
  check('dom: a song has its track id, title, artists, length and picture (the album shows once the songs list loads)', one && one.id === '0DiWol3AO6WpXZgp0goxAV' && one.sub === 'Daft Punk' && one.ms === 320000 && one.art.startsWith('https://i.scdn.co/') && SPB.cleanItem(one).id === one.id, JSON.stringify(one));
  check('dom: artists of a song with several are joined', first.items.some((i) => i.title.startsWith('Get Lucky') && i.sub === 'Daft Punk, Pharrell Williams, Nile Rodgers'), '');
  check('dom: albums, artists and playlists come from the results area, by their links (not the side bar\'s library, not the playbar)', titles(first, 'album').length >= 3 && titles(first, 'artist').length >= 1 && titles(first, 'playlist').length >= 1 && first.items.every((i) => i.title), JSON.stringify(first.items.map((i) => `${i.kind}:${i.title}`)));
  s1.advance(4000);
  const lists = s1.lists();
  check('dom: the whole list follows the first rows under the same request, and the songs-only list is NOT opened by itself (one route, not two)', lists.length === 2 && lists[0].partial === true && !lists[1].partial && lists.every((l) => l.rid === 5 && l.ok) && s1.pushed.length === 1 && s1.pushed[0] === '/search/daft%20punk', JSON.stringify([lists.map((l) => [l.partial, l.items.length]), s1.pushed]));
  s1.send({ cmd: 'searchMore', term: 'daft punk', rid: 5 });
  s1.advance(4000);
  const better = s1.lists().at(-1);
  check('dom: searchMore (the user scrolled or asked) opens the songs-only list and sends a longer song list under the same request, keeping the albums, artists and playlists', s1.lists().length === 3 && better.rid === 5 && better.ok === true && better.more === true && titles(better, 'song').length > 4 && titles(better, 'song').length <= 8 && titles(better, 'album').length === titles(first, 'album').length && better.items.find((i) => i.title === 'One More Time').album === 'Discovery' && s1.pushed.at(-1) === '/search/daft%20punk/tracks', JSON.stringify([s1.lists().length, titles(better, 'song'), s1.pushed]));
  check('dom: every item it sends passes the engine\'s check (id, kind, title) and keeps the album of a song', SPB.parseMessage(JSON.stringify(better)).items.length === better.items.length && SPB.parseMessage(JSON.stringify(better)).items[0].album === 'Discovery' && SPB.parseMessage(JSON.stringify(better)).more === true && SPB.parseMessage(JSON.stringify(first)).partial === true, '');
  const stale = page({ tree: signedIn(TREES.home), route: searchRoute('daft punk') });
  stale.advance(1000);
  stale.send({ cmd: 'search', term: 'daft punk', rid: 20 });
  stale.advance(3000);
  stale.send({ cmd: 'searchMore', term: 'daft punk', rid: 19 });
  stale.send({ cmd: 'searchMore', term: 'radiohead', rid: 20 });
  stale.advance(3000);
  check('dom: searchMore for an older request or another term does nothing (no route change, no list)', stale.pushed.length === 1 && stale.lists().length === 2, JSON.stringify([stale.pushed, stale.lists().length]));
  check('dom: searchMore is a fixed command with a bounded term', JSON.parse(SPB.cleanCommand({ cmd: 'searchMore', term: `  ${'a'.repeat(200)} `, rid: 4 })).term.length === 80 && SPB.cleanCommand({ cmd: 'searchMore', term: '  ' }) === null && SPB.cleanCommand({ cmd: 'searchMore', term: 5 }) === null, '');

  // streaming: the first rows are sent as soon as they stand one render pass, well before the whole list is settled
  const stream = page({ tree: signedIn(TREES.home), route: searchRoute('daft punk', { allMs: 400 }) });
  stream.advance(1000);
  stream.send({ cmd: 'search', term: 'daft punk', rid: 30 });
  stream.advance(400 + 250); // the page shows its rows at 400 ms
  check('dom: partial results: the first rows are sent about one render pass (120 ms) after they show, before the page has stood still', stream.lists().length === 1 && stream.lists()[0].partial === true && stream.lists()[0].items.length > 4, JSON.stringify(stream.lists().map((l) => [l.partial, l.items.length])));
  stream.advance(600);
  check('dom: …and the whole list follows half a second after the rows stopped changing (not 0.7 s, and not a second route)', stream.lists().length === 2 && !stream.lists()[1].partial && stream.pushed.length === 1, JSON.stringify(stream.lists().map((l) => [l.partial, l.items.length])));
  // rows that arrive in two batches: the partial list is what showed first, the final one is what it ended as
  const growing = page({ tree: signedIn(TREES.home), route: (p, h) => { if (p === '/search/daft%20punk') { h.after(300, firstRows(retarget(TREES['search-all'], 'daft punk'), 2)); h.after(900, retarget(TREES['search-all'], 'daft punk')); } } });
  growing.advance(1000);
  growing.send({ cmd: 'search', term: 'daft punk', rid: 31 });
  growing.advance(4000);
  const gl = growing.lists();
  check('dom: rows that arrive in two batches: a partial list with the first batch, then the final list with all of them (same request)', gl.length >= 2 && gl[0].partial === true && !gl.at(-1).partial && titles(gl.at(-1), 'song').length > titles(gl[0], 'song').length && gl.every((l) => l.rid === 31), JSON.stringify(gl.map((l) => [l.partial, titles(l, 'song').length])));
  const byRoute = page({ tree: signedIn(TREES['search-all']), route: searchRoute('radiohead', { allMs: 300 }) });
  byRoute.location.pathname = '/search/daft%20punk';
  byRoute.send({ cmd: 'search', term: 'radiohead', rid: 34 });
  byRoute.advance(1500);
  check('dom: by default a search on a search page opens the route (measured faster than typing into the box of the page): nothing is typed', byRoute.typedTerms.length === 0 && byRoute.pushed[0] === '/search/radiohead' && byRoute.lists().length >= 1, JSON.stringify([byRoute.typedTerms, byRoute.pushed]));
  // a box that does not open the route by itself (typing wired to nothing): after a moment the route is opened as before
  const dead = page({ tree: signedIn(TREES['search-all']), route: searchRoute('radiohead', { allMs: 300 }), typing: null, typeFirst: true });
  dead.location.pathname = '/search/daft%20punk';
  dead.send({ cmd: 'search', term: 'radiohead', rid: 32 });
  dead.advance(1000);
  const deadBefore = dead.pushed.length;
  dead.advance(2500);
  check('dom: a typed term that does not move the page is followed by opening the route (after 1.5 s), and the results then come', dead.typedTerms.join() === 'radiohead' && deadBefore === 0 && dead.pushed[0] === '/search/radiohead' && dead.lists().length >= 1 && dead.lists()[0].items.some((i) => i.id.startsWith('Q')), JSON.stringify([dead.typedTerms, deadBefore, dead.pushed, dead.lists().length]));
  // on a songs-only list the box is not typed into (it might keep the filter): the route is opened
  const onTracks = page({ tree: signedIn(TREES['search-tracks']), route: searchRoute('radiohead', { allMs: 300 }), typeFirst: true });
  onTracks.location.pathname = '/search/daft%20punk/tracks';
  onTracks.send({ cmd: 'search', term: 'radiohead', rid: 33 });
  onTracks.advance(2500);
  check('dom: from the songs-only list a new search opens /search/<term> itself (typing there could keep the songs-only filter)', onTracks.typedTerms.length === 0 && onTracks.pushed[0] === '/search/radiohead', JSON.stringify([onTracks.typedTerms, onTracks.pushed]));
  // an older query typed into the box and not yet shown never answers once a newer one started
  const race = page({ tree: signedIn(TREES['search-all']), typeFirst: true, route: (p, h) => { searchRoute('radiohead', { allMs: 900 })(p, h); searchRoute('miles davis', { allMs: 300 })(p, h); } });
  race.location.pathname = '/search/daft%20punk';
  race.send({ cmd: 'search', term: 'radiohead', rid: 40 });
  race.advance(200);
  race.send({ cmd: 'search', term: 'miles davis', rid: 41 });
  race.advance(5000);
  check('dom: an older query in flight is cancelled by a newer one: only the newer request is ever answered, with the newer term\'s rows', race.lists().length >= 1 && race.lists().every((l) => l.rid === 41) && race.typedTerms.join() === 'radiohead,miles davis', JSON.stringify([race.lists().map((l) => l.rid), race.typedTerms]));

  const lib = signedIn(TREES['search-all']);
  const withLib = { ...lib, c: [{ t: 'nav', a: { 'aria-label': 'Main' }, c: [{ t: 'a', a: { href: '/playlist/LIBRARYPLAYLIST1' }, c: ['My own playlist'] }, { t: 'a', a: { href: '/artist/LIBRARYARTIST0001' }, c: ['A library artist'] }] }, { t: 'footer', c: [{ t: 'a', a: { href: '/artist/PLAYBARARTIST0001' }, c: ['Now playing artist'] }] }, ...lib.c] };
  const libPage = page({ tree: withLib, route: () => {} });
  libPage.location.pathname = '/search/daft%20punk';
  libPage.send({ cmd: 'search', term: 'daft punk', rid: 2 });
  libPage.advance(3000);
  check('dom: links in the side bar (the user library) and the playbar are not search results', libPage.lists().length >= 1 && !libPage.lists()[0].items.some((i) => /^(LIBRARY|PLAYBAR)/.test(i.id)), JSON.stringify(libPage.lists()[0] && libPage.lists()[0].items.filter((i) => /^(LIBRARY|PLAYBAR)/.test(i.id))));

  // a second search: the previous term's rows are on the page until the router replaces them
  const s2 = page({ tree: signedIn(TREES['search-all']), route: searchRoute('radiohead', { allMs: 1500, tracksMs: 400 }), typeFirst: true });
  s2.location.pathname = '/search/daft%20punk';
  s2.send({ cmd: 'search', term: 'radiohead', rid: 6 });
  s2.advance(1300);
  check('dom: a second search never answers with the first one\'s rows that are still on the page (partial results included)', s2.lists().length === 0 && s2.pushed[0] === '/search/radiohead', JSON.stringify([s2.lists().length, s2.pushed]));
  check('dom: on a search page the script types the term into the page\'s own search box (the page opens the route itself); it does not open a route of its own', s2.typedTerms.join() === 'radiohead' && s2.pushed.length === 1, JSON.stringify([s2.typedTerms, s2.pushed]));
  s2.advance(3000);
  check('dom: …it waits for the new results, then answers with those', s2.lists().length >= 1 && s2.lists()[0].ok === true && s2.lists()[0].items.some((i) => i.id.startsWith('Q')) && !s2.lists()[0].items.some((i) => i.kind === 'song' && !i.id.startsWith('Q')), JSON.stringify(s2.lists()[0] && s2.lists()[0].items.slice(0, 3).map((i) => i.id)));
  const same = page({ tree: signedIn(TREES['search-all']), route: searchRoute('daft punk', { tracksMs: 400 }) });
  same.location.pathname = '/search/daft%20punk';
  same.send({ cmd: 'search', term: 'daft punk', rid: 9 });
  same.advance(2000);
  check('dom: searching again for the term the page already shows answers at once (nothing to wait for but the page standing still)', same.lists().length >= 1 && same.lists()[0].ok === true && same.pushed.length <= 1, JSON.stringify([same.lists().length, same.pushed]));

  // two searches in a row: only the later one is answered
  const quick = page({ tree: signedIn(TREES.home), route: (p, h) => { searchRoute('daft punk')(p, h); searchRoute('radiohead')(p, h); } });
  quick.advance(1000);
  quick.send({ cmd: 'search', term: 'daft punk', rid: 1 });
  quick.advance(200);
  quick.send({ cmd: 'search', term: 'radiohead', rid: 2 });
  quick.advance(9000);
  check('dom: a search started while another is still waiting replaces it: only the later request is answered', quick.lists().length >= 1 && quick.lists().every((l) => l.rid === 2) && quick.lists()[0].items.every((i) => i.id.length > 0), JSON.stringify(quick.lists().map((l) => l.rid)));

  // the in-page navigation the router does by itself: a route change with a suffix, a trailing slash
  const slash = page({ tree: signedIn(TREES.home), route: (p, h) => h.after(300, retarget(TREES['search-all'], 'daft punk')) });
  slash.advance(1000);
  slash.send({ cmd: 'search', term: 'daft punk', rid: 3 });
  slash.location.pathname = '/search/daft%20punk/';
  slash.advance(3000);
  check('dom: the page being on the route with a trailing slash, or on a sub-route (/tracks), counts as being there (not "the page changed")', slash.lists().length >= 1 && slash.lists()[0].ok === true && slash.errors().length === 0, JSON.stringify(slash.lists().map((l) => l.ok)));

  // no results: ASSUMED text
  const emptyTree = { t: 'body', c: [{ t: 'main', c: [{ t: 'h1', c: ['No results found for “zzzz”'] }, { t: 'p', c: ['Please make sure your words are spelled correctly.'] }] }, { t: 'aside', a: { 'data-testid': 'now-playing-bar' }, c: [{ t: 'button', a: { 'data-testid': 'control-button-playpause', 'aria-label': 'Play' } }] }] };
  const empty = page({ tree: signedIn(TREES.home), route: (p, h) => h.after(300, emptyTree) });
  empty.send({ cmd: 'search', term: 'zzzz', rid: 4 });
  empty.advance(3000);
  check('dom (assumed text): a page saying "No results found" with no rows is an ok, empty answer (not a timeout)', empty.lists().length >= 1 && empty.lists()[0].ok === true && empty.lists()[0].items.length === 0, JSON.stringify(empty.lists()));

  // failures say why
  const slow = page({ tree: signedIn(TREES.home), route: () => {} });
  slow.send({ cmd: 'search', term: 'daft punk', rid: 11 });
  slow.advance(12000);
  const slowL = slow.lists()[0];
  check('dom: a page that never shows results ends as not ok, why "timeout", with what the page showed (its address, the rows, the player)', slowL && slowL.ok === false && slowL.why === 'timeout' && /search\/daft/.test(slowL.detail) && /0 song rows/.test(slowL.detail) && /player/.test(slowL.detail) && slowL.items.length === 0, JSON.stringify(slowL));
  const out0 = page({ tree: TREES.home, route: () => {} });
  out0.advance(4000);
  out0.send({ cmd: 'search', term: 'daft punk', rid: 12 });
  out0.advance(12000);
  check('dom: signed out (the Log in button) and no results: why "signedOut" (the card says Sign in to Spotify in Lumen)', out0.lists()[0].ok === false && out0.lists()[0].why === 'signedOut', JSON.stringify(out0.lists()[0]));
  const noPl = page({ tree: { t: 'body', c: [{ t: 'main', c: ['x'] }] }, route: () => {} });
  noPl.send({ cmd: 'search', term: 'daft punk', rid: 13 });
  noPl.advance(12000);
  check('dom: no player controls and no results: why "noPlayer" (Spotify\'s page changed or is not the web player)', noPl.lists()[0].ok === false && noPl.lists()[0].why === 'noPlayer', JSON.stringify(noPl.lists()[0]));
  check('dom: why and detail pass the message check; an unknown why becomes "page"; an ok answer carries none', SPB.parseMessage(JSON.stringify(slowL)).why === 'timeout' && SPB.parseMessage(JSON.stringify({ ...slowL, why: 'whatever' })).why === 'page' && SPB.parseMessage(JSON.stringify(first)).why === '' && SPB.parseMessage(JSON.stringify({ ...slowL, detail: 'd'.repeat(500) })).detail.length === 120, '');
  const boxPage = page({ tree: signedIn(TREES.home), route: () => {} });
  check('dom: the search box of the saved page is found by the table own selectors (the second way in)', SPB.SELECTORS.searchInput.some((sel) => boxPage.el(sel)), '');

  // the search page as the signed-in page makes it (2026-10-11, test/fixtures/spotify/search-rows.json): every kind is a div[role=row] > div[data-encore-id=listRow] (no
  // data-testid="tracklist-row"), the picture in the media cell, the entity's link in the title cell
  const rowsTree = (() => { const t = signedIn(TREES['search-all']); const walk = (n) => (typeof n === 'string' ? n : (n.t === 'main' ? clone(FIXTURES.searchRows) : { ...n, c: (n.c || []).map(walk) })); return walk(t); })();
  const rs = page({ tree: rowsTree, route: () => {} });
  rs.location.pathname = '/search/Never%20Gonna%20Give%20You%20Up';
  rs.send({ cmd: 'search', term: 'Never Gonna Give You Up', rid: 70 });
  rs.advance(3000);
  const rsList = (rs.lists().find((l) => l.kind === 'search') || {}).items || [];
  const rsDesc = rsList.map((i) => i.kind + ':' + i.id + ':' + i.title + ':' + i.sub);
  check('dom (search rows, 2026-10-11): songs, an album, an artist and a playlist are listed from their rows (in the page order), a song and an album with their artists', rsDesc.join('|') === ['song:4PTG3Z6ehGkBFwjybzWkR8:Never Gonna Give You Up:Rick Astley', 'song:3pepZAOvUCBt3qWi9Ax6Aq:Never, Never Gonna Give Ya Up:Barry White', 'playlist:6HXpFwuNqwiWCLAU55LjHG:Never Gonna Give You Up:', 'album:1fWMQOAKIqdgzQgE311HK8:Never Gonna Give You Up:Mac Beez', 'artist:0gxyHStUsqpMadRV0Di1Qt:Rick Astley:'].join('|'), JSON.stringify(rsDesc));
  check('dom (search rows): every row picture is taken from its media cell (the link is not where the image is), and the message check accepts them', rsList.length === 5 && rsList.every((i) => /^https:[/][/]/.test(i.art)) && SPB.parseMessage(JSON.stringify(rs.lists().find((l) => l.kind === 'search'))).items.every((i) => i.art !== ''), JSON.stringify(rsList.map((i) => i.art)));
  rs.send({ cmd: 'playItem', kind: 'song', id: '3pepZAOvUCBt3qWi9Ax6Aq' });
  const rsBtn = rs.clicked[0];
  check('dom (search rows): a song is played from its own page by its track id (the route is opened), never by a row\'s button on the results page', rs.pushed[0] === '/track/3pepZAOvUCBt3qWi9Ax6Aq' && !rs.clicked.some((c) => c.closest('[role="row"]')), JSON.stringify([rs.pushed, rs.clicked.map((c) => c.getAttribute('aria-label'))]));
  const rsArt = (rs.lists().find((l) => l.kind === 'search') || { items: [] }).items.map((i) => i.kind + ':' + i.art);
  check('dom (search rows): each row\'s art is the address in its own media cell (the fixture\'s entity-image src), song, album, artist and playlist alike', JSON.stringify(rsArt) === JSON.stringify(['song:https://i.scdn.co/image/ab67616d0000e1a315ebbedaacef61af244262a8'].concat(rsArt.slice(1))) && rsArt.length === 5 && rsArt.every((a) => /^[a-z]+:https:\/\/(i\.scdn\.co|image-cdn-[a-z0-9]+\.spotifycdn\.com|mosaic\.scdn\.co)\//.test(a)), JSON.stringify(rsArt));

  // ================= playing an item =================
  const song = page({ tree: signedIn(TREES['search-tracks']), route: () => {} });
  song.location.pathname = '/search/daft%20punk/tracks';
  const row = song.all('[data-testid="tracklist-row"]').find((r) => r.querySelector('a[href^="/track/"]'));
  const rowId = row.querySelector('a[href^="/track/"]').getAttribute('href').split('/')[2];
  song.send({ cmd: 'playItem', kind: 'song', id: rowId });
  check('dom: a song listed on the page is played from its own page by its track id (the route is opened), not by a row button', song.pushed[0] === '/track/' + rowId && !song.clicked.some((c) => c.closest('[data-testid="tracklist-row"]')), JSON.stringify([song.pushed, song.clicked.map((c) => c.getAttribute('aria-label'))]));

  for (const [kind, name, id] of [['album', 'album', '2noRn2Aes5aoNVsU6iWThc'], ['playlist', 'playlist', '37i9dQZF1DX6mvEU1S6INL'], ['song', 'track', '0DiWol3AO6WpXZgp0goxAV']]) {
    const pg = page({ tree: signedIn(TREES.home), route: (p, h) => { if (p === `/${name}/${id}`) h.after(700, signedIn(TREES[name])); } });
    pg.advance(500);
    pg.send({ cmd: 'playItem', kind, id });
    pg.advance(300);
    const early = pg.clicked.length;
    pg.advance(3000);
    const btn = pg.clicked[0];
    check(`dom: a ${kind} is played through its own page: the route, then its big Play button (the action bar's, not a card's or the top bar's)`, pg.pushed[0] === `/${name}/${id}` && early === 0 && pg.clicked.length === 1 && btn.getAttribute('data-testid') === 'play-button' && Boolean(btn.closest('[data-testid="action-bar-row"]')) && pg.errors().length === 0, JSON.stringify([pg.pushed, early, pg.clicked.length, btn && btn.closest('[data-testid="action-bar-row"]') !== null]));
  }
  const noBtn = page({ tree: signedIn(TREES.home), route: (p, h) => h.after(300, signedIn({ t: 'body', c: [{ t: 'aside', a: { 'data-testid': 'now-playing-bar' }, c: [{ t: 'button', a: { 'data-testid': 'control-button-playpause', 'aria-label': 'Play' } }] }, { t: 'main', c: ['Nothing here'] }] })) });
  noBtn.send({ cmd: 'playItem', kind: 'album', id: '2noRn2Aes5aoNVsU6iWThc' });
  noBtn.advance(10000);
  check('dom: an item page with no Play button ends with a specific error (not silence)', noBtn.errors().some((e) => /play button/.test(e.message)) && noBtn.clicked.length === 0, JSON.stringify(noBtn.errors()));
  const noBtn2 = page({ tree: { t: 'body', c: [{ t: 'main', c: ['x'] }] }, route: () => {} });
  noBtn2.send({ cmd: 'playItem', kind: 'album', id: '2noRn2Aes5aoNVsU6iWThc' });
  noBtn2.advance(10000);
  check('dom: …and with no player at all, the player-controls message', noBtn2.errors().some((e) => e.message === SPB.NO_PLAYER), JSON.stringify(noBtn2.errors()));

  // ================= the engine: a new document re-arms the search; no answer; signed out =================
  let t = 1e12;
  const player = fakePlayer();
  const e = createEngine({ player, now: () => t, fetchBytes: async () => null, resizeArt: (b) => b, hasCard: () => true, onChange: () => {}, setInterval: () => ({ unref() {} }), setTimeout: () => ({ unref() {} }), BrowserWindow: function BW() { const w = new EventEmitter(); w.destroyed = false; w.closed = 0; w.isDestroyed = () => w.destroyed; w.focus = () => {}; w.getContentSize = () => [560, 740]; w.removeMenu = () => {}; w.close = () => { w.closed++; w.emit('close'); w.destroyed = true; }; player.wins.push(w); return w; } });
  const sent = () => (player.wc ? player.wc.sent : []);
  const stateMsg = (o = {}) => JSON.stringify({ t: 'state', state: 0, pos: 0, dur: 0, device: '', player: true, item: null, ...o });
  await e.read();
  e.onMessage('{"t":"ready"}');
  e.search('daft punk');
  const asked = sent().filter((c) => c.cmd === 'search');
  check('engine: a search is sent to the ready page', asked.length === 1 && asked[0].term === 'daft punk', JSON.stringify(sent()));
  player.reload(); // a full navigation: a new document, a new bridge
  e.onMessage('{"t":"ready"}');
  const again = sent().filter((c) => c.cmd === 'search');
  check('engine: the page loading a new document while a search waits does not end it as "no answer": the new bridge is asked the same search again', again.length === 2 && again[1].term === 'daft punk' && again[1].rid === asked[0].rid && (await e.read()).searching === true, JSON.stringify(again));
  e.onMessage('{"t":"ready"}'); // (a second ready of the same document: not asked a third time)
  check('engine: …but a second "ready" of the same document does not ask it again', sent().filter((c) => c.cmd === 'search').length === 2, '');
  e.onMessage(JSON.stringify({ t: 'list', kind: 'search', rid: asked[0].rid, ok: true, items: [{ id: 'AAAAAAAAAAAAAAAAAAAAA1', kind: 'song', title: 'One More Time', sub: 'Daft Punk', album: 'Discovery', ms: 320000 }] }));
  const got = await e.read();
  check('engine: the answer reaches the card, not searching any more, ok', got.searching === false && got.searchOk === true && got.searchWhy === '' && got.results.length === 1, JSON.stringify(got.results));
  player.reload();
  e.onMessage('{"t":"ready"}');
  check('engine: an answered search is not asked again of a later document', sent().filter((c) => c.cmd === 'search').length === 2, '');

  e.search('radiohead');
  t += 21e3;
  const lost = await e.read();
  check('engine: a search the page never answers ends after a while as not ok, why "timeout" (the card stops saying Searching…)', lost.searching === false && lost.searchOk === false && lost.searchWhy === 'timeout', JSON.stringify({ s: lost.searching, ok: lost.searchOk, why: lost.searchWhy }));

  e.search('queen');
  const q3 = sent().filter((c) => c.cmd === 'search').at(-1);
  e.onMessage(JSON.stringify({ t: 'list', kind: 'search', rid: q3.rid, ok: false, why: 'signedOut', detail: 'path /, 0 song rows, main, player', items: [] }));
  const so = await e.read();
  check('engine: a failed search hands the card why and what the page showed', so.searchOk === false && so.searchWhy === 'signedOut' && /0 song rows/.test(so.searchDetail), JSON.stringify({ ok: so.searchOk, why: so.searchWhy, d: so.searchDetail }));
  e.search('queen again');
  check('engine: a new search clears the old reason', (await e.read()).searchWhy === '', '');

  // signed out by the page's own Log in button, whatever the cookie says
  const before = await e.read();
  check('engine: the cookie says signed in', before.signedIn === true, String(before.signedIn));
  e.onMessage(stateMsg({ signedOut: true }));
  const out = await e.read();
  check('engine: the page showing its Log in button makes the card signed out (offers Sign in), though the cookie is still there', out.signedIn === false && out.pageChanged === false, JSON.stringify({ s: out.signedIn, p: out.pageChanged }));
  e.signIn();
  check('engine: Sign in opens the window with the page in it', player.wins.length >= 1 && e.signInOpen() === true, '');
  e.onMessage(stateMsg({ signedOut: false }));
  check('engine: when the page shows the player again (signed in in that window) the sign-in window closes by itself', e.signInOpen() === false && (await e.read()).signedIn === true, '');
  e.onMessage(stateMsg({ signedOut: null }));
  check('engine: an unknown (null) says nothing: the cookie decides again', (await e.read()).signedIn === true, '');
  {
  // ================= a playlist's own page, read in full (kind 'page': the card's Library, for a playlist the Web API will not give) =================
  // The page draws only the rows in view, so the list is scrolled and the rows seen are kept. The rows are the saved playlist page's tracklist rows (test/fixtures/spotify/playlist.json),
  // made again for other songs; the scrolling list is a stand-in that draws a window of rows for the scroll position (the real list is virtualised the same way).
  const plRowSrc = (() => { let found = null; const walk = (n) => { if (typeof n === 'string' || found) return; if (n.a && n.a['data-testid'] === 'tracklist-row') { found = n; return; } (n.c || []).forEach(walk); }; walk(TREES.playlist); return found; })();
  const plRow = (n, extra = {}) => {
    let s = JSON.stringify(plRowSrc);
    s = s.replace(/2hxV5yGCr1nIp5bQBxXL13/g, `TRK${String(n).padStart(4, '0')}`).replace(/"Maps"/g, `"Song ${n}"`).replace(/Play Maps by/g, `Play Song ${n} by`).replace(/ab67616d000048515da288bfe0c2611d76bb11b8/g, `art${n}`);
    const row = JSON.parse(s);
    row.a = { ...row.a, 'aria-rowindex': String(n + 2), ...extra };
    return row;
  };
  const PL = 'PLAYLISTTESTID0000001';
  const ROW_H = 56, VIEW_H = 560;
  // total rows, `window`: how many rows the list draws around the scroll position; scroll.h: the content height (set apart to make a list that never ends)
  const plTree = (total, top = 0, { title = 'Best of Fakemink', header = true, window = 14, h = total * ROW_H, words = '' } = {}) => {
    const first = Math.max(0, Math.floor(top / ROW_H) - 2);
    const rows = Array.from({ length: Math.max(0, Math.min(window, total - first)) }, (_, i) => plRow(first + i));
    return { t: 'body', c: [
      { t: 'main', c: [...(header ? [{ t: 'h1', a: { 'data-testid': 'entityTitle' }, c: [title] }] : []), ...(words ? [{ t: 'p', c: [words] }] : []), { t: 'div', a: { 'data-overlayscrollbars-viewport': 'scrollbarHidden' }, scroll: { h, ch: VIEW_H }, c: [{ t: 'div', a: { 'data-testid': 'playlist-tracklist' }, c: rows }] }] },
      { t: 'footer', c: [{ t: 'button', a: { 'data-testid': 'control-button-playpause', 'aria-label': 'Play' }, c: [] }] },
    ] };
  };
  const plPage = (total, o = {}) => {
    const pg = page({ tree: { t: 'body', c: [{ t: 'main', c: ['Home'] }, { t: 'footer', c: [{ t: 'button', a: { 'data-testid': 'control-button-playpause', 'aria-label': 'Play' }, c: [] }] }] }, route: (p, h) => { if (p === `/playlist/${PL}`) h.after(o.arriveMs ?? 400, plTree(total, 0, o)); } });
    pg.log.onScroll = (el, v) => { if (o.draw !== false) pg.swap(plTree(total, v, o)); };
    return pg;
  };
  const pageAnswer = (pg) => pg.lists().find((l) => l.kind === 'page');
  const readIt = (pg, rid = 31, ms = 40000) => { pg.advance(1000); pg.send({ cmd: 'list', kind: 'page', path: `/playlist/${PL}`, rid }); for (let i = 0; i < ms / 500 && !pageAnswer(pg); i++) pg.advance(500); return pageAnswer(pg); };

  const big = plPage(76);
  const bigAns = readIt(big);
  check('dom (playlist page): 76 songs in a list that draws 14 rows at a time are all read, in order, each once, by scrolling it (ids from the rows\' own links)', bigAns && bigAns.ok === true && bigAns.items.length === 76 && bigAns.items.every((it, i) => it.id === `TRK${String(i).padStart(4, '0')}` && it.title === `Song ${i}`) && bigAns.partial === false && bigAns.title === 'Best of Fakemink', JSON.stringify([bigAns && bigAns.ok, bigAns && bigAns.items.length, bigAns && bigAns.items.slice(0, 2), bigAns && bigAns.why, bigAns && bigAns.detail]));
  check('dom (playlist page): the page was opened by its own router (no reload) and only that one route', big.pushed.length === 1 && big.pushed[0] === `/playlist/${PL}` && big.errors().length === 0, JSON.stringify(big.pushed));
  const bigMsg = SPB.parseMessage(JSON.stringify(bigAns));
  check('dom (playlist page): the answer passes the message check with all 76 songs, titles, artists, lengths and pictures', bigMsg && bigMsg.kind === 'page' && bigMsg.ok === true && bigMsg.items.length === 76 && bigMsg.items[5].sub === 'Yeah Yeah Yeahs' && bigMsg.items[5].ms === 219000 && /^https:\/\/i\.scdn\.co\//.test(bigMsg.items[5].art) && bigMsg.title === 'Best of Fakemink', JSON.stringify(bigMsg && bigMsg.items[5]));
  const slowDraw = plPage(76, { arriveMs: 4000 });
  const slowAns = readIt(slowDraw);
  check('dom (playlist page): a page that takes four seconds to show its first rows is waited for (no short timeout)', slowAns && slowAns.ok === true && slowAns.items.length === 76, JSON.stringify([slowAns && slowAns.ok, slowAns && slowAns.items && slowAns.items.length, slowAns && slowAns.why]));
  const endless = plPage(1e6, { h: 1e9, draw: false });
  const endlessAns = readIt(endless, 32, 45000);
  check('dom (playlist page): a list that never draws more rows (the end cannot be scrolled to) is cut at the deadline with the rows read so far, marked partial (an answer, not a failure)', endlessAns && endlessAns.ok === true && endlessAns.partial === true && endlessAns.items.length === 14 && endlessAns.items[0].id === 'TRK0000', JSON.stringify([endlessAns && endlessAns.ok, endlessAns && endlessAns.partial, endlessAns && endlessAns.items && endlessAns.items.length]));
  const huge = plPage(900);
  const hugeAns = readIt(huge, 33, 60000);
  check('dom (playlist page): at most 400 songs are read of a very long list (the whole answer must fit one message), and the answer is marked partial or full of 400', hugeAns && hugeAns.ok === true && hugeAns.items.length === 400 && JSON.stringify(hugeAns).length < SPB.MAX_MESSAGE && SPB.parseMessage(JSON.stringify(hugeAns)).items.length === 400, JSON.stringify([hugeAns && hugeAns.items && hugeAns.items.length, hugeAns && JSON.stringify(hugeAns).length]));
  // duplicates: the same song twice in a playlist stays twice (rows have their own place)
  const dupTree = () => { const t = plTree(3, 0); const rows = t.c[0].c[1].c[0].c; rows[1] = plRow(0, { 'aria-rowindex': '9' }); return t; };
  const dup = page({ tree: { t: 'body', c: [{ t: 'main', c: ['Home'] }, { t: 'footer', c: [{ t: 'button', a: { 'data-testid': 'control-button-playpause', 'aria-label': 'Play' }, c: [] }] }] }, route: (p, h) => { if (p === `/playlist/${PL}`) h.after(300, dupTree()); } });
  const dupAns = readIt(dup, 34);
  check('dom (playlist page): the same song listed twice is read twice (rows are told apart by their own place on the page)', dupAns && dupAns.ok === true && dupAns.items.map((i) => i.id).join() === 'TRK0000,TRK0000,TRK0002', JSON.stringify(dupAns && dupAns.items.map((i) => i.id)));

  // failures, each with its own cause
  const noRows = plPage(0, { header: true });
  const noRowsAns = readIt(noRows, 35);
  check('dom (playlist page): the header there but no rows ever (and no empty-playlist words): why "page" (Spotify changed its page), with what the page showed for the log', noRowsAns && noRowsAns.ok === false && noRowsAns.why === 'page' && /header/.test(noRowsAns.detail) && /0 song rows/.test(noRowsAns.detail) && SPB.parseMessage(JSON.stringify(noRowsAns)).why === 'page', JSON.stringify(noRowsAns));
  const nothing = plPage(0, { header: false });
  const nothingAns = readIt(nothing, 36);
  check('dom (playlist page): nothing shown at all in 30 s: why "timeout" (too slow)', nothingAns && nothingAns.ok === false && nothingAns.why === 'timeout' && /no header/.test(nothingAns.detail), JSON.stringify(nothingAns));
  const emptyList = plPage(0, { header: true, words: 'Let’s find something for your playlist' });
  const emptyAns = readIt(emptyList, 37);
  check('dom (playlist page): a playlist that says "find something for your playlist" is an ok, empty list (not a failure)', emptyAns && emptyAns.ok === true && emptyAns.items.length === 0, JSON.stringify(emptyAns));
  const gone = plPage(0, { header: false, words: 'Couldn’t find that playlist' });
  const goneAns = readIt(gone, 38);
  check('dom (playlist page): "Couldn\'t find that playlist": why "missing"', goneAns && goneAns.ok === false && goneAns.why === 'missing' && SPB.parseMessage(JSON.stringify(goneAns)).why === 'missing', JSON.stringify(goneAns));
  const outPg = page({ tree: TREES.home });
  outPg.advance(3000);
  outPg.send({ cmd: 'list', kind: 'page', path: `/playlist/${PL}`, rid: 39 });
  const outAns = pageAnswer(outPg);
  check('dom (playlist page): signed out (the page shows its Log in button): why "signedOut" at once, told apart from a changed page', outAns && outAns.ok === false && outAns.why === 'signedOut' && outPg.pushed.length === 0, JSON.stringify(outAns));
  const noPl = page({ tree: { t: 'body', c: [{ t: 'main', c: ['Something else'] }] } });
  noPl.advance(1000);
  noPl.send({ cmd: 'list', kind: 'page', path: `/playlist/${PL}`, rid: 40 });
  check('dom (playlist page): a page without the player\'s controls: why "noPlayer" at once (Spotify changed its page), nothing opened', pageAnswer(noPl) && pageAnswer(noPl).why === 'noPlayer' && noPl.pushed.length === 0, JSON.stringify(pageAnswer(noPl)));
  // the commands: only a playlist or album page, with a safe id
  const cc2 = SPB.cleanCommand;
  check('bridge commands: kind "page" takes only /playlist/<id> or /album/<id> (an id of the safe alphabet); anything else is refused', cc2({ cmd: 'list', kind: 'page', path: `/playlist/${PL}`, rid: 5 }) === JSON.stringify({ cmd: 'list', kind: 'page', path: `/playlist/${PL}`, rid: 5 }) && cc2({ cmd: 'list', kind: 'page', path: '/album/AL1', rid: 1 }) !== null && [{ path: '/artist/x' }, { path: '/playlist/' }, { path: '/playlist/a/b' }, { path: '/playlist/a?x=1' }, { path: 'https://evil.example/playlist/a' }, { path: '//evil.example' }, { path: '/playlist/a b' }, { path: 5 }, {}].every((c) => cc2({ cmd: 'list', kind: 'page', rid: 1, ...c }) === null), '');
  check('bridge messages: a page answer keeps up to 400 songs (and no more), its title, partial and why (missing is a cause the card knows)', SPB.parseMessage(JSON.stringify({ t: 'list', kind: 'page', rid: 1, ok: true, title: 'T', partial: true, items: Array.from({ length: 450 }, (_, i) => ({ id: `S${i}`, kind: 'song', title: `s${i}` })) })).items.length === 400 && SPB.parseMessage(JSON.stringify({ t: 'list', kind: 'page', rid: 1, ok: true, title: 'T', partial: true, items: [] })).partial === true && SPB.parseMessage(JSON.stringify({ t: 'list', kind: 'page', rid: 1, ok: false, why: 'missing', items: [] })).why === 'missing' && SPB.parseMessage(JSON.stringify({ t: 'list', kind: 'page', rid: 1, ok: false, why: 'nonsense', items: [] })).why === 'page', '');

  // ---- the engine asks the page and hands the answer to the card's call ----
  {
    const pl = fakePlayer();
    const eng = createEngine({ player: pl, now: () => 1e12, fetchBytes: async () => null, resizeArt: (b) => b, hasCard: () => true, onChange: () => {}, setInterval: () => ({ unref() {} }), setTimeout: (f, ms) => setTimeout(f, Math.min(ms, 60)), itemReadMs: () => 80 });
    await eng.read();
    eng.onMessage('{"t":"ready"}');
    const sentCmds = () => (pl.wc ? pl.wc.sent : []);
    const p1 = eng.readItem('playlist', PL);
    const cmd = sentCmds().find((c) => c.cmd === 'list' && c.kind === 'page');
    check('engine: readItem sends the page the playlist\'s own path, with a request number', cmd && cmd.path === `/playlist/${PL}` && Number.isInteger(cmd.rid), JSON.stringify(sentCmds()));
    eng.onMessage(JSON.stringify({ t: 'list', kind: 'page', rid: cmd.rid + 1, ok: true, items: [{ id: 'OLD', kind: 'song', title: 'Older ask' }] }));
    eng.onMessage(JSON.stringify({ t: 'list', kind: 'page', rid: cmd.rid, ok: true, title: 'Best of', partial: false, items: [{ id: 'S1', kind: 'song', title: 'One', sub: 'A', ms: 1000 }, { id: 'S2', kind: 'song', title: 'Two' }] }));
    const r1 = await p1;
    check('engine: the answer with the asked number resolves it (an answer to another ask is ignored): the songs, the title, nothing partial', r1.ok === true && r1.items.length === 2 && r1.items[0].id === 'S1' && r1.title === 'Best of' && r1.partial === false, JSON.stringify(r1));
    const p2 = eng.readItem('playlist', PL);
    const cmd2 = sentCmds().filter((c) => c.kind === 'page').at(-1);
    eng.onMessage(JSON.stringify({ t: 'list', kind: 'page', rid: cmd2.rid, ok: false, why: 'page', detail: 'path /x, 0 song rows', items: [] }));
    const r2 = await p2;
    check('engine: a failed read hands over the page\'s cause and what it showed', r2.ok === false && r2.why === 'page' && /0 song rows/.test(r2.detail) && r2.items.length === 0, JSON.stringify(r2));
    const p3 = eng.readItem('playlist', PL);
    const r3 = await p3;
    check('engine: a page that never answers ends as "timeout" (never a promise left hanging), and a second ask replaces an unanswered first', r3.ok === false && r3.why === 'timeout', JSON.stringify(r3));
    const p4 = eng.readItem('playlist', PL);
    const p5 = eng.readItem('album', 'ALB1');
    const r4 = await p4;
    check('engine: a newer read replaces an unanswered one (the page does one at a time): the first ends as a failure at once', r4.ok === false && /newer/.test(r4.detail), JSON.stringify(r4));
    check('engine: not a playlist or album, or an unsafe id: refused without touching the page', (await eng.readItem('artist', 'x')).ok === false && (await eng.readItem('playlist', '../x')).ok === false && sentCmds().filter((c) => c.kind === 'page').length === 5, '');
    await p5;
    {
      pl.signed = false;
      const r6 = await eng.readItem('playlist', PL);
      check('engine: signed out (Spotify\'s own cookie says so): why "signedOut" at once, without asking the page', r6.ok === false && r6.why === 'signedOut', JSON.stringify(r6));
      pl.signed = true;
    }
    const slowPl = fakePlayer();
    const slowEng = createEngine({ player: slowPl, now: () => 1e12, fetchBytes: async () => null, resizeArt: (b) => b, hasCard: () => true, onChange: () => {}, setInterval: () => ({ unref() {} }), setTimeout: (f, ms) => setTimeout(f, Math.min(ms, 60)), itemReadMs: () => 150 });
    const r7 = await slowEng.readItem('playlist', PL);
    check('engine: a player page that never started (no ready) ends as "noPlayer" after the wait, not silence', r7.ok === false && r7.why === 'noPlayer', JSON.stringify(r7));
  }
  }
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
