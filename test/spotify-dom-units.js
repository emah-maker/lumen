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
    get src() { return el.attrs.src || ''; }, get alt() { return el.attrs.alt || ''; }, get max() { return el.attrs.max || ''; },
    get textContent() { return el.childNodes.map((c) => (c.nodeType === 3 ? c.text : c.textContent)).join(''); },
    get children() { return el.childNodes.filter((c) => c.nodeType === 1); },
    click() { el.clicks++; log.clicked.push(el); },
    dispatchEvent(ev) { el.events.push(ev.type); return true; },
    matches(sel) { return matchesParsed(el, parseSelector(sel)); },
    closest(sel) { const p = parseSelector(sel); for (let n = el; n && n.localName; n = n.parentNode) if (matchesParsed(n, p)) return n; return null; },
    querySelectorAll(sel) { const p = parseSelector(sel); const out = []; const walk = (n) => { for (const c of n.children) { if (matchesParsed(c, p)) out.push(c); walk(c); } }; walk(el); return out; },
    querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
  };
  el.childNodes = (spec.c || []).map((c) => makeEl(c, el, log));
  return el;
}

// ---- a page: the real script in a vm, a fake router ----
// route(path, h): called on pushState; h.after(ms, treeOrFn) swaps the page's content then, h.location is the address.
function page({ tree = TREES.home, route = () => {}, md = null } = {}) {
  const log = { clicked: [], pushed: [], out: [] };
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
    window: { dispatchEvent: (e) => { if (e.type === 'popstate') route(location.pathname, { after: (ms, t) => setTimeout_(() => swap(t), ms), swap, location }); } },
    location, CustomEvent, PopStateEvent, Event, HTMLInputElement, MutationObserver,
    Date: { now: () => clock },
    setTimeout: setTimeout_,
    clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.dead = true; },
    setInterval: (f, ms) => { timers.push({ id: ++tid, f, at: clock + ms, every: ms }); return tid; },
  };
  vm.createContext(ctx);
  vm.runInContext(SPB.BRIDGE_SOURCE, ctx);
  const advance = (ms) => {
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
  return { ...log, log, advance, send, swap, lists, states, errors, el, all: (sel) => body.querySelectorAll(sel), location, typed, last: () => states().at(-1) };
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
  const ASSUMED = ['nowPlaying', 'title', 'artist', 'artistLinks', 'cover', 'connect', 'shuffle', 'chrome'];
  const pages = Object.entries(TREES).map(([name, tree]) => [name, makeEl(clone(tree), null, { clicked: [] })]);
  const seen = (name) => pages.filter(([, root]) => SPB.SELECTORS[name].some((s) => root.querySelector(s))).map(([n]) => n);
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
  const better = lists.at(-1);
  check('dom: then it opens the songs-only list and sends a longer song list under the same request, keeping the albums, artists and playlists', lists.length === 2 && better.rid === 5 && better.ok === true && titles(better, 'song').length > 4 && titles(better, 'song').length <= 8 && titles(better, 'album').length === titles(first, 'album').length && better.items.find((i) => i.title === 'One More Time').album === 'Discovery' && s1.pushed.at(-1) === '/search/daft%20punk/tracks', JSON.stringify([lists.length, titles(better, 'song'), s1.pushed]));
  check('dom: every item it sends passes the engine\'s check (id, kind, title) and keeps the album of a song', SPB.parseMessage(JSON.stringify(better)).items.length === better.items.length && SPB.parseMessage(JSON.stringify(better)).items[0].album === 'Discovery', '');

  const lib = signedIn(TREES['search-all']);
  const withLib = { ...lib, c: [{ t: 'nav', a: { 'aria-label': 'Main' }, c: [{ t: 'a', a: { href: '/playlist/LIBRARYPLAYLIST1' }, c: ['My own playlist'] }, { t: 'a', a: { href: '/artist/LIBRARYARTIST0001' }, c: ['A library artist'] }] }, { t: 'footer', c: [{ t: 'a', a: { href: '/artist/PLAYBARARTIST0001' }, c: ['Now playing artist'] }] }, ...lib.c] };
  const libPage = page({ tree: withLib, route: () => {} });
  libPage.location.pathname = '/search/daft%20punk';
  libPage.send({ cmd: 'search', term: 'daft punk', rid: 2 });
  libPage.advance(3000);
  check('dom: links in the side bar (the user library) and the playbar are not search results', libPage.lists().length >= 1 && !libPage.lists()[0].items.some((i) => /^(LIBRARY|PLAYBAR)/.test(i.id)), JSON.stringify(libPage.lists()[0] && libPage.lists()[0].items.filter((i) => /^(LIBRARY|PLAYBAR)/.test(i.id))));

  // a second search: the previous term's rows are on the page until the router replaces them
  const s2 = page({ tree: signedIn(TREES['search-all']), route: searchRoute('radiohead', { allMs: 1500, tracksMs: 400 }) });
  s2.location.pathname = '/search/daft%20punk';
  s2.send({ cmd: 'search', term: 'radiohead', rid: 6 });
  s2.advance(1300);
  check('dom: a second search never answers with the first one\'s rows that are still on the page', s2.lists().length === 0 && s2.pushed[0] === '/search/radiohead', JSON.stringify([s2.lists().length, s2.pushed]));
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

  // ================= playing an item =================
  const song = page({ tree: signedIn(TREES['search-tracks']), route: () => {} });
  song.location.pathname = '/search/daft%20punk/tracks';
  const row = song.all('[data-testid="tracklist-row"]').find((r) => r.querySelector('a[href^="/track/"]'));
  const rowId = row.querySelector('a[href^="/track/"]').getAttribute('href').split('/')[2];
  song.send({ cmd: 'playItem', kind: 'song', id: rowId });
  check('dom: a song that is listed on the page is played by its own row\'s Play button (no page change)', song.pushed.length === 0 && song.clicked.length === 1 && /^Play /.test(song.clicked[0].getAttribute('aria-label')), JSON.stringify(song.clicked.map((c) => c.getAttribute('aria-label'))));
  const clickedRow = song.clicked[0].closest('[data-testid="tracklist-row"]');
  check('dom: …and it is the right row\'s button (the title in its label is that row\'s)', clickedRow === row, '');

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
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
