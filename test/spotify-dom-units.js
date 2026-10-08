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
    dispatchEvent(ev) { el.events.push(ev.type); if (log.onEvent) log.onEvent(el, ev); return true; },
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
    window: { dispatchEvent: (e) => { if (e.type === 'popstate') route(location.pathname, { after: (ms, t) => setTimeout_(() => swap(t), ms), swap, location }); } },
    location, CustomEvent, PopStateEvent, Event, HTMLInputElement, MutationObserver,
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
  return { ...log, log, advance, send, swap, lists, states, errors, el, all: (sel) => body.querySelectorAll(sel), location, typed, last: () => states().at(-1), now: () => clock };
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
  const ASSUMED = ['nowPlaying', 'title', 'artist', 'artistLinks', 'cover', 'connect', 'chrome', 'like', 'contextLink', 'menuItem', 'libraryLink']; // (shuffle, repeat, volume, lyrics, the three-dots button and the track page's album link are seen)
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

  // the queue (ASSUMED page: the saved album page's row markup, a playing row first)
  const queueTree = (n) => { const a = signedIn(TREES.album); const rows = []; const find = (x) => { if (typeof x === 'string') return; if (x.a && x.a['data-testid'] === 'tracklist-row') rows.push(x); (x.c || []).forEach(find); }; find(a); const mk = (i) => { const r = clone(rows[i % rows.length]); const s = JSON.stringify(r).replace(/\/track\/[A-Za-z0-9]{22}/g, `/track/Q${String(i).padStart(21, '0')}`); return JSON.parse(s); }; const list = Array.from({ length: n }, (_, i) => mk(i)); const walk = (x) => { if (typeof x === 'string') return x; if (x.a && x.a['data-testid'] === 'track-list') return { ...x, c: [{ t: 'div', c: list }] }; return { ...x, c: (x.c || []).map(walk) }; }; return walk(a); };
  const qp = page({ tree: withWidget(widget()), route: (p, h) => { if (p === '/queue') h.after(400, queueTree(4)); } });
  qp.advance(1000);
  qp.send({ cmd: 'list', kind: 'queue', rid: 31 });
  qp.advance(4000);
  const qMsg = qp.lists().find((l) => l.kind === 'queue');
  check('dom (assumed queue page): the queue route\'s rows are listed without the playing song (the first row)', qMsg && qMsg.ok === true && qMsg.rid === 31 && qMsg.items.length === 3 && qp.pushed[0] === '/queue', JSON.stringify(qMsg));
  qp.send({ cmd: 'playQueue', index: 1, id: qMsg.items[1].id });
  qp.advance(3000);
  check('dom (assumed queue page): playing from the queue presses the Play button of that row (the playing row is skipped)', qp.clicked.length === 1 && qp.clicked[0].closest('[data-testid="tracklist-row"]') === qp.all('[data-testid="tracklist-row"]')[2], JSON.stringify(qp.clicked.length));
  const qEmpty = page({ tree: withWidget(widget()), route: (p, h) => { if (p === '/queue') h.after(300, { t: 'body', c: [{ t: 'main', c: [{ t: 'h1', c: ['Queue'] }, { t: 'p', c: ['Your queue is empty'] }] }, { t: 'aside', a: { 'data-testid': 'now-playing-bar' }, c: [{ t: 'button', a: { 'data-testid': 'control-button-playpause', 'aria-label': 'Pause' } }] }] }); } });
  qEmpty.send({ cmd: 'list', kind: 'queue', rid: 32 });
  qEmpty.advance(6000);
  check('dom (assumed text): an empty queue page is an ok, empty list (not a timeout)', qEmpty.lists().some((l) => l.kind === 'queue' && l.ok === true && l.items.length === 0), JSON.stringify(qEmpty.lists()));
  const qOut = page({ tree: TREES.home, route: () => {} });
  qOut.advance(4000);
  qOut.send({ cmd: 'list', kind: 'queue', rid: 33 });
  qOut.advance(12000);
  check('dom: signed out, a queue that never shows says why "signedOut" (the card says to sign in)', (qOut.lists().find((l) => l.kind === 'queue') || {}).ok === false && (qOut.lists().find((l) => l.kind === 'queue') || {}).why === 'signedOut', JSON.stringify(qOut.lists()));

  // the library (ASSUMED links in the left bar)
  const libTree = (() => { const t = signedIn(TREES.home); const walk = (n) => (typeof n === 'string' ? n : (n.a && n.a['aria-label'] === 'Your Library' ? { ...n, c: [{ t: 'ul', c: [{ t: 'li', c: [{ t: 'a', a: { href: '/playlist/37i9dQZF1DXcBWIGoYBM5M' }, c: ['Today\'s Top Hits'] }] }, { t: 'li', c: [{ t: 'a', a: { href: '/album/2noRn2Aes5aoNVsU6iWThc' }, c: ['Discovery'] }] }, { t: 'li', c: [{ t: 'a', a: { href: '/artist/4tZwfgrHOc3mvqYlEYSvVi' }, c: ['Daft Punk'] }] }, { t: 'li', c: [{ t: 'a', a: { href: '/collection/tracks' }, c: ['Liked Songs'] }] }] }, ...(n.c || [])] } : { ...n, c: (n.c || []).map(walk) })); return walk(t); })();
  const lb = page({ tree: libTree });
  lb.advance(1000);
  lb.send({ cmd: 'list', kind: 'playlists', rid: 41 });
  lb.send({ cmd: 'list', kind: 'recent', rid: 42 });
  const lbMsg = lb.lists().find((l) => l.kind === 'playlists');
  check('dom (assumed library links): the left bar\'s playlists, albums and artists are listed by their links (other links are not)', lbMsg && lbMsg.ok === true && lbMsg.items.map((i) => `${i.kind}:${i.title}`).join('|') === 'playlist:Today\'s Top Hits|album:Discovery|artist:Daft Punk' && lb.lists().find((l) => l.kind === 'recent').items.length === 0, JSON.stringify(lbMsg));

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
