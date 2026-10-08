// Idle wakeups of the new-tab page and the music card's web player (features/visible-ticker.js, renderer/newtab-widgets.js, newtab-stacks.js,
// newtab-music.js, newtab-web-slot.js, features/web-player.js), pure Node with fake timers:
//   - a ticker has no timer while the page is hidden (or the resident spare not yet shown) or nothing needs it, starts when something visible does,
//     lands on second (or minute) boundaries, and catches up when the page is shown;
//   - the music card's position is worked out from a timestamp, not counted by a poll;
//   - the web player is placed by what the page pushes (and one probe per layout change), with no interval and no polling executeJavaScript;
//   - a music card is not drawn again just because it was read again (features/widget-card-key.js).
// Runs on its own (npm run test:units picks up test/*-units.js).
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { createTicker } = require('../src/features/visible-ticker');
const WP = require('../src/features/web-player');
const CK = require('../src/features/widget-card-key');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

// ---- fake clock: setTimeout/clearTimeout with a virtual now ----
function clock(start = 1e12 + 250) {
  const c = { t: start, timers: [], id: 0, fired: 0 };
  c.now = () => c.t;
  c.setTimeout = (fn, ms) => { const id = ++c.id; c.timers.push({ id, fn, at: c.t + ms }); return id; };
  c.clearTimeout = (id) => { c.timers = c.timers.filter((x) => x.id !== id); };
  c.advance = (ms) => {
    const end = c.t + ms;
    for (;;) {
      const next = c.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      c.timers = c.timers.filter((x) => x !== next);
      c.t = next.at; c.fired++; next.fn();
    }
    c.t = end;
  };
  return c;
}

// ---- the ticker ----
{
  const c = clock();
  const page = { hidden: true, needs: false, ticks: 0, period: 1000 };
  const tk = createTicker({ run: () => { page.ticks++; }, needed: () => page.needs, period: () => page.period, visible: () => !page.hidden, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout });
  tk.poke();
  check('ticker: no timer when the page is hidden and nothing needs it', c.timers.length === 0 && !tk.active(), c.timers.length);
  page.needs = true; tk.poke();
  check('ticker: hidden (the spare page, a background tab): still no timer even with a card that needs one', c.timers.length === 0, c.timers.length);
  c.advance(60e3);
  check('ticker: a hidden page wakes 0 times in a minute', c.fired === 0 && page.ticks === 0, `${c.fired}/${page.ticks}`);
  page.hidden = false; tk.onVisibility();
  check('ticker: shown with a card that needs it: catches up at once and arms one timer', page.ticks === 1 && c.timers.length === 1, `${page.ticks}/${c.timers.length}`);
  const d = c.timers[0].at % 1000;
  check('ticker: the first tick lands just after a second boundary', d >= 0 && d <= 5, String(d));
  c.advance(10e3);
  check('ticker: one tick per second while shown', page.ticks === 11 && c.timers.length === 1, String(page.ticks));
  page.needs = false; c.advance(1000);
  check('ticker: when nothing needs it any more it stops by itself (no timer left)', c.timers.length === 0 && !tk.active(), c.timers.length);
  const n = page.ticks;
  const fired = c.fired;
  c.advance(30e3);
  check('ticker: …and wakes 0 times after that', page.ticks === n && c.fired === fired, `${page.ticks}/${n}`);
  page.needs = true; page.period = 60e3; tk.poke();
  check('ticker: a minute period lands on the minute boundary', c.timers.length === 1 && c.timers[0].at % 60e3 <= 5, String(c.timers[0]?.at % 60e3));
  page.period = 1000; tk.poke();
  check('ticker: poke() with a shorter period (a clock with seconds appeared) re-arms sooner, never two timers', c.timers.length === 1 && c.timers[0].at - c.t <= 1002, `${c.timers.length}/${c.timers[0]?.at - c.t}`);
  page.hidden = true; tk.onVisibility();
  check('ticker: hiding the page clears the timer', c.timers.length === 0 && !tk.active(), c.timers.length);
}
{
  // Not aligned (the 60 s refresh): a plain period.
  const c = clock(1e12 + 123);
  let ticks = 0;
  const tk = createTicker({ period: 60e3, align: false, run: () => { ticks++; }, visible: () => true, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout });
  tk.poke(); c.advance(180e3);
  check('ticker: align:false is a plain period', ticks === 3, String(ticks));
}

// ---- the page's own timers are all tickers ----
const noInterval = (f) => !/\bsetInterval\s*\(/.test(src(f));
check('new-tab widgets: no setInterval left (clocks, countdowns, timers, the minute refresh go through the visible ticker)', noInterval('renderer/newtab-widgets.js') && /createTicker/.test(src('renderer/newtab-widgets.js')), '');
check('new-tab stacks: no setInterval left (the rotation ticks only while a stack that turns exists and the page is visible)', noInterval('renderer/newtab-stacks.js') && /createTicker/.test(src('renderer/newtab-stacks.js')), '');
check('new-tab music card: no setInterval left, the playhead is computed from the stamp and drawn only by a ticker that runs while playing', noInterval('renderer/newtab-music.js') && /createTicker/.test(src('renderer/newtab-music.js')) && /Date\.now\(\) - p\.at/.test(src('renderer/newtab-music.js')), '');
check('new-tab: the page loads the ticker and the slot reporter', /visible-ticker\.js/.test(src('renderer/newtab.html')) && /newtab-web-slot\.js/.test(src('renderer/newtab.html')), '');
check('web player: no interval or polling constant left', noInterval('features/web-player.js') && !/POLL_MS/.test(src('features/web-player.js')), '');
check('Spotify bridge: no setInterval (observer-driven, a 5 s heartbeat)', noInterval('features/spotify-bridge.js') && /MutationObserver/.test(src('features/spotify-bridge.js')), '');
check('YouTube ad check: the 300 ms interval exists only while an ad is showing', (src('features/adblock-youtube.js').match(/setInterval\(tick, 300\)/g) || []).length === 1 && /MutationObserver/.test(src('features/adblock-youtube.js')), '');

// The music card's position, as newtab-music.js drawProgress() works it out: from where the playhead was and when. A page that was hidden
// for a minute is right the moment it is shown, with no ticks in between.
{
  const pos = (p, now) => Math.min(p.duration, Math.max(0, p.from + (p.playing ? Math.max(0, now - p.at) : 0)));
  const p = { from: 12e3, at: 1e12, duration: 200e3, playing: true };
  check('music progress: position after 90 s hidden is from + elapsed, with no ticker needed', pos(p, 1e12 + 90e3) === 102e3, String(pos(p, 1e12 + 90e3)));
  check('music progress: paused stays put, and never past the end', pos({ ...p, playing: false }, 1e12 + 90e3) === 12e3 && pos(p, 1e12 + 900e3) === 200e3, '');
  const m = src('renderer/newtab-music.js');
  check('music progress: the card\'s drawProgress is that formula', /p\.from \+ \(p\.playing \? Math\.max\(0, Date\.now\(\) - p\.at\) : 0\)/.test(m), '');
  {
    const c0 = clock(1e12 + 100);
    let at = 0;
    const tk0 = createTicker({ run: () => { at = c0.now(); }, offset: () => 1e12 + 640 - 12e3, needed: () => true, visible: () => true, now: c0.now, setTimeout: c0.setTimeout, clearTimeout: c0.clearTimeout });
    tk0.poke(); c0.advance(1500);
    check('music progress ticker: lands on the song own second boundary (the digits never lag the playhead)', ((at - (1e12 + 640 - 12e3)) % 1000 + 1000) % 1000 <= 5, String(at));
  }
  const c = clock();
  const page = { hidden: false, playing: true, ticks: 0 };
  const tk = createTicker({ run: () => { page.ticks++; }, needed: () => page.playing, visible: () => !page.hidden, now: c.now, setTimeout: c.setTimeout, clearTimeout: c.clearTimeout });
  tk.poke(); c.advance(5e3);
  page.playing = false; c.advance(2e3);
  check('music progress ticker: runs while playing (5 ticks in 5 s), stops when paused', page.ticks >= 5 && page.ticks <= 6 && c.timers.length === 0, `${page.ticks}/${c.timers.length}`);
}

// ---- the web player is placed by push ----
function webPlayerChecks() {
  const real = { setInterval: global.setInterval, setTimeout: global.setTimeout };
  const intervals = [];
  const timeouts = [];
  global.setInterval = (...a) => { intervals.push(a); return { unref() {} }; };
  global.setTimeout = (fn, ms) => { timeouts.push({ fn, ms }); return { unref() {} }; };
  try {
    const views = [];
    const bounds = [];
    function WebContentsView() {
      const wc = new EventEmitter();
      wc.isDestroyed = () => false; wc.loadURL = () => Promise.resolve(); wc.setWindowOpenHandler = () => {}; wc.getURL = () => 'https://open.spotify.com/'; wc.close = () => {};
      wc.executeJavaScript = () => Promise.resolve(false); wc.getZoomFactor = () => 1; wc.setZoomFactor = () => {};
      this.webContents = wc; this.vis = false; this.setVisible = (v) => { this.vis = v; }; this.getVisible = () => this.vis; this.setBounds = (b) => { bounds.push(b); };
      views.push(this);
    }
    const win = { isDestroyed: () => false, once() {}, contentView: { addChildView() {}, removeChildView() {} } };
    let probes = 0;
    const nt = new EventEmitter();
    nt.isDestroyed = () => false;
    nt.executeJavaScript = () => { probes++; return Promise.resolve({ x: 20, y: 30, w: 400, h: 300 }); };
    const other = new EventEmitter();
    other.isDestroyed = () => false; other.executeJavaScript = () => Promise.resolve(null);
    let active = nt;
    let has = true;
    const wp = WP.createWebPlayer({ WebContentsView, session: null, getWindow: () => win, getBounds: () => ({ x: 0, y: 80, width: 1200, height: 700 }), activeNewTab: () => active, hasWidget: () => has, keepAlive: () => true, openTab: () => {}, isWebUrl: () => true }, { url: 'https://open.spotify.com/', hosts: new Set(['open.spotify.com']), cardClass: 'spotify' });
    wp.sync();
    check('web player: sync() asks the page once (a layout change), and starts no interval', probes === 1 && intervals.length === 0, `${probes}/${intervals.length}`);
    check('web player: it listens to the page\'s slot messages from then on', nt.listenerCount('console-message') === 1, String(nt.listenerCount('console-message')));
    wp.sync();
    check('web player: and only once per page, however often the layout changes', nt.listenerCount('console-message') === 1, String(nt.listenerCount('console-message')));
    const msg = (o) => WP.SLOT_PREFIX + JSON.stringify(o);
    const before = bounds.length;
    nt.emit('console-message', { message: msg({ spotify: { x: 20, y: 130, w: 400, h: 300 }, applemusic: null }), level: 'debug' });
    check('web player: a pushed slot moves the view (no executeJavaScript, no timer)', bounds.length === before + 1 && bounds[bounds.length - 1].y === 210 && probes === 1 && intervals.length === 0, JSON.stringify([bounds.slice(-1), probes, intervals.length]));
    nt.emit('console-message', {}, 1, msg({ spotify: { x: 20, y: 140, w: 400, h: 300 } }), 1, ''); // the older argument form
    check('web player: …the older Electron event arguments work too', bounds[bounds.length - 1].y === 220, JSON.stringify(bounds.slice(-1)));
    const n = bounds.length;
    nt.emit('console-message', { message: 'hello from the page' });
    nt.emit('console-message', { message: msg({ applemusic: { x: 0, y: 0, w: 400, h: 300 } }) });
    nt.emit('console-message', { message: WP.SLOT_PREFIX + '{not json' });
    check('web player: other console output, another card\'s slot and junk are ignored', bounds.length === n, '');
    active = other;
    nt.emit('console-message', { message: msg({ spotify: { x: 0, y: 0, w: 500, h: 500 } }) });
    check('web player: a page that is not the visible new-tab page is not believed', bounds.length === n, '');
    active = nt;
    nt.emit('console-message', { message: msg({ spotify: null }) });
    check('web player: a null slot (card gone, page being edited) hides the view', views[0].vis === false, String(views[0].vis));
    nt.emit('console-message', { message: msg({ spotify: { x: 20, y: 130, w: 400, h: 300 } }) });
    has = false;
    const m2 = bounds.length;
    nt.emit('console-message', { message: msg({ spotify: { x: 20, y: 150, w: 400, h: 300 } }) });
    check('web player: with no Web-player card configured a push does nothing', bounds.length === m2, '');
    has = true;
    check('web player: parseSlotMessage: rects, null, and undefined for what is not ours', JSON.stringify(WP.parseSlotMessage(msg({ spotify: { x: 1, y: 2, w: 3, h: 4 } }), 'spotify')) === '{"x":1,"y":2,"w":3,"h":4}' && WP.parseSlotMessage(msg({ spotify: null }), 'spotify') === null && WP.parseSlotMessage(msg({ spotify: 5 }), 'spotify') === undefined && WP.parseSlotMessage('x', 'spotify') === undefined && WP.parseSlotMessage(msg([]), 'spotify') === undefined && WP.parseSlotMessage(msg({ applemusic: null }), 'spotify') === undefined, '');
    check('web player: no interval was created in all of that', intervals.length === 0, String(intervals.length));
    // a failed load is retried once after the delay, by one timer that exists only while it is failed
    const wc = views[0].webContents;
    timeouts.length = 0;
    wc.emit('did-fail-load', {}, -106, 'ERR_INTERNET_DISCONNECTED', 'https://open.spotify.com/', true);
    const retry = timeouts.filter((t) => t.ms === 20e3);
    check('web player: a failed load arms one retry timer (20 s), not a poll', retry.length === 1 && intervals.length === 0, JSON.stringify(timeouts.map((t) => t.ms)));
    wp.destroy();
  } finally { global.setInterval = real.setInterval; global.setTimeout = real.setTimeout; }
}
webPlayerChecks();

// ---- the card is not built again because it was read again ----
{
  const w = (at, progressMs) => ({ id: 'a', type: 'spotify', title: 'Spotify', data: { mode: 'status', source: 'engine', title: 'Night Shift', artist: 'Ann', durationMs: 200e3, state: 'playing', at, progressMs, signedIn: true } });
  const a = CK.cardKey(w(1e12, 10e3));
  const b = CK.cardKey(w(1e12 + 5e3, 15e3)); // read again 5 s later: the playhead is where it should be
  check('card key: a read that only moved the stamp is the same card (no rebuild, so no timer re-created either)', CK.sameCard(a, b), JSON.stringify([a.key === b.key, a.head, b.head]));
}

console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
process.exit(failures ? 1 : 0);
