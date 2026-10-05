// The Apple Music engine's own logic (features/apple-music-engine.js), without Electron, the network or Apple: a fake web player
// (the hidden page), a fake desktop-app source, a fake sign-in window and a fake clock. What the card is given in each situation,
// which source the buttons go to, the lists and search, the sign-in window, the unload after idle, and what is ignored.
// Runs on its own (npm run test:units picks up test/*-units.js).
const { EventEmitter } = require('events');
const { createEngine } = require('../src/features/apple-music-engine');

const ART = 'https://is1-ssl.mzstatic.com/image/thumb/x/{w}x{h}bb.jpg';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = (o = {}) => JSON.stringify({ t: 'state', auth: false, state: 2, pos: 12, dur: 90, store: 'us', item: { id: '1', type: 'song', title: 'Shake It Off', artist: 'Taylor Swift', album: '1989', art: ART, ms: 219000 }, ...o });

function fakePlayer() {
  const wcs = [];
  const p = {
    destroyed: 0, ensured: 0, pinned: null, released: 0, reloaded: 0, st: { state: 'ready', drm: 'ok' },
    wc: null,
    ensure() { p.ensured++; if (!p.wc) { p.wc = { sent: [], send: (ch, json) => p.wc.sent.push([ch, JSON.parse(json)]) }; wcs.push(p.wc); } return {}; },
    webContents: () => p.wc,
    status: () => p.st,
    destroy() { p.destroyed++; p.wc = null; },
    showIn(win, rect) { p.pinned = { win, rect }; },
    release() { p.released++; p.pinned = null; },
    reload() { p.reloaded++; },
  };
  return p;
}
function fakeWin() {
  const w = new EventEmitter();
  w.destroyed = false; w.focused = 0; w.closed = 0;
  w.isDestroyed = () => w.destroyed;
  w.focus = () => { w.focused++; };
  w.getContentSize = () => [560, 740];
  w.removeMenu = () => {};
  w.close = () => { w.closed++; w.emit('close'); w.destroyed = true; };
  return w;
}

module.exports = async function appleMusicEngineUnits(check) {
  let t = 1e12;
  const changes = { n: 0 };
  const player = fakePlayer();
  const wins = [];
  let intervalFn = null;
  const native = { card: { mode: 'status', state: 'idle', title: '', artist: '', album: '', progressMs: 0, durationMs: 0, at: 1, source: '', kind: 'none', reason: 'not-running', art: '' }, pressed: [], reads: 0, read: async () => { native.reads++; return native.card; }, control: async (n) => { native.pressed.push(n); return true; } };
  const fetched = [];
  const e = createEngine({
    player, native, now: () => t,
    fetchBytes: async (url) => { fetched.push(url); return PNG; }, resizeArt: (b) => b,
    BrowserWindow: function BrowserWindow(opts) { const w = fakeWin(); w.opts = opts; wins.push(w); return w; },
    getParent: () => null, hasCard: () => true, onChange: () => { changes.n++; },
    setInterval: (f) => { intervalFn = f; return { unref() {} }; },
  });
  const page = () => player.wc;
  const sentCmds = () => (page() ? page().sent.filter((s) => s[0] === 'musicengine:cmd').map((s) => s[1]) : []);

  // ---- not loaded until something asks ----
  check('apple engine: nothing is loaded until a card reads it', player.ensured === 0 && player.wc === null, '');
  const first = await e.read();
  check('apple engine: the first read loads the hidden page and answers "starting" (idle, reason loading, not signed-in-known)', player.ensured === 1 && first.state === 'idle' && first.reason === 'loading' && first.signedIn === null, JSON.stringify(first));
  check('apple engine: commands are refused until the page says it is ready', (await e.control('play')) === false && e.playItem('song', '1') === false && e.search('x') === false && sentCmds().length === 0, JSON.stringify(sentCmds()));

  // ---- ready, signed out ----
  e.onMessage('{"t":"ready"}');
  e.onMessage(state({ state: 0, item: null }));
  await sleep(5);
  check('apple engine: ready, nothing playing -> idle card, signed out known, the lists are asked for', (await e.read()).signedIn === false && sentCmds().filter((c) => c.cmd === 'list').length === 2, JSON.stringify(sentCmds()));
  e.onMessage(JSON.stringify({ t: 'list', kind: 'recent', rid: 1, ok: false, signedOut: true, items: [] }));
  const idle = await e.read();
  check('apple engine: the idle card is stable (no moving time stamp) so the page does not redraw while typing', idle.at === 0 && idle.state === 'idle' && Array.isArray(idle.recent) && idle.recent.length === 0 && idle.query === '', JSON.stringify(idle));

  // ---- search ----
  const c0 = changes.n;
  check('apple engine: search sends a command with a fresh request id and marks the card "searching"', e.search('  shake it off ') === true && sentCmds().at(-1).cmd === 'search' && sentCmds().at(-1).term === 'shake it off' && (await e.read()).searching === true, JSON.stringify(sentCmds().at(-1)));
  const rid1 = sentCmds().at(-1).rid;
  e.onMessage(JSON.stringify({ t: 'list', kind: 'search', rid: rid1 - 1, ok: true, items: [{ id: '9', type: 'songs', title: 'Old' }] }));
  check('apple engine: an answer to an older search is ignored', (await e.read()).results.length === 0 && (await e.read()).searching === true, '');
  e.onMessage(JSON.stringify({ t: 'list', kind: 'search', rid: rid1, ok: true, items: [{ id: '1440933651', type: 'songs', title: 'Shake It Off', sub: 'Taylor Swift' }, { id: 'p.x', type: 'playlists', title: 'Hits' }] }));
  const res = await e.read();
  check('apple engine: the answer shows as results (kind, title, sub), the term is kept, and the card is told', res.results.length === 2 && res.results[0].kind === 'song' && res.results[0].sub === 'Taylor Swift' && res.query === 'shake it off' && res.searching === false && changes.n > c0, JSON.stringify(res.results));
  check('apple engine: an empty search clears the results', e.search('   ') === true && (await e.read()).results.length === 0 && (await e.read()).query === '', '');

  // ---- play something ----
  check('apple engine: playItem sends the fixed command', e.playItem('song', '1440933651') === true && JSON.stringify(sentCmds().at(-1)) === '{"cmd":"playItem","kind":"song","id":"1440933651"}', '');
  check('apple engine: a bad kind or id is not sent', e.playItem('format', '1') === false && e.playItem('song', 'a b') === false && sentCmds().at(-1).cmd === 'playItem' && sentCmds().filter((c) => c.cmd === 'playItem').length === 1, '');
  const n0 = changes.n;
  e.onMessage(state());
  const playing = await e.read();
  check('apple engine: a playing state is the card (engine source, preview while signed out, art fetched from mzstatic only and made a data: URL)', playing.state === 'playing' && playing.title === 'Shake It Off' && playing.source === 'engine' && playing.preview === true && playing.durationMs === 90000 && changes.n > n0 && fetched.length === 1 && fetched[0].endsWith('/160x160bb.jpg') && fetched[0].startsWith('https://is1-ssl.mzstatic.com/'), JSON.stringify([playing.state, fetched]));
  await sleep(20);
  check('apple engine: when the picture arrives the card gets it (and the card is told)', (await e.read()).art.startsWith('data:image/png;base64,'), '');
  const f1 = fetched.length;
  e.onMessage(state({ pos: 14 }));
  await e.read();
  check('apple engine: the same picture is not fetched again', fetched.length === f1, '');
  const n1 = changes.n;
  e.onMessage(state({ pos: 15 }));
  check('apple engine: a playhead that only moved on as expected is not a change', changes.n === n1, `${changes.n} ${n1}`);
  e.onMessage(state({ pos: 60 }));
  check('apple engine: a seek (a jump of the playhead) is a change', changes.n > n1, '');
  e.onMessage(state({ state: 3 }));
  check('apple engine: paused shows paused; seeking in between does not flicker the card', (await e.read()).state === 'paused' && (e.onMessage(state({ state: 6 })), (await e.read()).state === 'paused'), '');
  e.onMessage(state({ state: 8 }));
  check('apple engine: buffering counts as playing', (await e.read()).state === 'playing', '');

  // ---- buttons: engine ----
  await e.control('pause'); await e.control('next'); await e.control('previous');
  check('apple engine: the buttons go to the page as commands', sentCmds().slice(-3).map((c) => c.cmd).join() === 'pause,next,previous' && native.pressed.length === 0, JSON.stringify(sentCmds().slice(-3)));
  check('apple engine: an unknown button is refused, seek goes to the page', (await e.control('format')) === false && e.seek(33) === true && JSON.stringify(sentCmds().at(-1)) === '{"cmd":"seek","sec":33}' && e.seek(-1) === false, '');

  // ---- signing in ----
  check('apple engine: Sign in opens a window of its own with the engine page in it, once', e.signIn() === true && wins.length === 1 && wins[0].opts.title === 'Sign in to Apple Music' && player.pinned && player.pinned.rect.width === 560 && e.signIn() === true && wins.length === 1 && wins[0].focused === 1, JSON.stringify(player.pinned && player.pinned.rect));
  wins[0].emit('resize');
  check('apple engine: the page follows the window when it is resized', player.pinned.rect.height === 740, '');
  const lists0 = sentCmds().filter((c) => c.cmd === 'list').length;
  e.onMessage(state({ auth: true }));
  check('apple engine: when MusicKit says authorized the window closes by itself, the page goes back, and the lists are asked for', wins[0].closed === 1 && player.released === 1 && sentCmds().filter((c) => c.cmd === 'list').length === lists0 + 2 && e.signedIn() === true && !e.signInOpen(), `${wins[0].closed} ${player.released}`);
  const w2 = e.signIn();
  wins[1].emit('close');
  check('apple engine: closing the window by hand puts the page back too', w2 && player.released === 2 && !e.signInOpen(), String(player.released));

  // ---- lists once signed in ----
  e.onMessage(JSON.stringify({ t: 'list', kind: 'recent', rid: 3, ok: true, items: [{ id: 'l.1', type: 'library-albums', title: 'Quiet', sub: 'Ann' }, { id: 'bad id', type: 'songs', title: 'x' }] }));
  e.onMessage(JSON.stringify({ t: 'list', kind: 'playlists', rid: 4, ok: true, items: [{ id: 'p.1', type: 'library-playlists', title: 'Mix' }] }));
  e.onMessage(state({ auth: true, state: 0, item: null }));
  const si = await e.read();
  check('apple engine: signed in and idle, the card has the recent plays and the playlists (safe ids only)', si.signedIn === true && si.state === 'idle' && si.recent.length === 1 && si.recent[0].id === 'l.1' && si.recent[0].kind === 'album' && si.playlists.length === 1 && si.playlists[0].kind === 'playlist', JSON.stringify([si.recent, si.playlists]));
  check('apple engine: the card carries the engine\'s load status and Widevine state', si.engine === 'ready' && si.drm === 'ok', JSON.stringify([si.engine, si.drm]));
  player.st = { state: 'ready', drm: 'missing' };
  check('apple engine: Widevine missing is reported to the card', (await e.read()).drm === 'missing', '');
  player.st = { state: 'ready', drm: 'ok' };

  // ---- the desktop app as a fallback ----
  native.card = { mode: 'status', state: 'playing', title: 'From The App', artist: 'Bo', album: 'Z', progressMs: 1000, durationMs: 90000, at: t, source: 'Apple Music', kind: 'track', reason: '', art: '' };
  const viaApp = await e.read({ app: true });
  check('apple engine: when the engine is idle and the desktop app plays, the card shows the app (labelled as such)', viaApp.state === 'playing' && viaApp.title === 'From The App' && viaApp.source === 'app', JSON.stringify(viaApp).slice(0, 160));
  await e.control('pause');
  check('apple engine: its buttons go to the app, not the page', native.pressed.join() === 'pause' && sentCmds().at(-1).cmd !== 'pause', JSON.stringify(sentCmds().slice(-2)));
  check('apple engine: seek is not available for the app', e.seek(5) === false, '');
  const reads = native.reads;
  const noApp = await e.read({ app: false });
  check('apple engine: with the app option off the app is not even asked', native.reads === reads && noApp.state === 'idle', '');
  e.onMessage(state({ auth: true }));
  const both = await e.read({ app: true });
  check('apple engine: when the engine plays too, the engine wins, and buttons go back to it', both.source === 'engine' && both.title === 'Shake It Off', JSON.stringify(both).slice(0, 120));
  await e.control('pause');
  check('apple engine: …the engine\'s pause was sent to the page', sentCmds().at(-1).cmd === 'pause' && native.pressed.length === 1, '');
  native.card = { ...native.card, state: 'idle', reason: 'denied', title: '' };
  e.onMessage(state({ auth: true, state: 0, item: null }));
  check('apple engine: a refused permission for the app is reported on the idle card (not as an error card)', (await e.read({ app: true })).appDenied === true, '');
  native.card = { ...native.card, reason: 'not-running' };
  native.read = () => new Promise(() => {}); // a desktop source that never answers must not hang the card
  const slow = await Promise.race([e.read({ app: true }), sleep(4000).then(() => 'hung')]);
  check('apple engine: a desktop source that never answers does not hang the card (the engine answers after a short wait)', slow !== 'hung' && slow.state === 'idle', String(slow && slow.state));

  // ---- trouble ----
  e.onMessage(JSON.stringify({ t: 'error', message: 'NOT_ALLOWED' }));
  check('apple engine: a playback error is shown for a few seconds', (await e.read()).error === 'NOT_ALLOWED' && (t += 9000, (await e.read()).error === ''), '');
  const before = changes.n;
  for (const junk of ['', 'nope', '[]', '{"t":"list","kind":"x"}', 'x'.repeat(300000), null, 5]) e.onMessage(junk);
  check('apple engine: junk messages do nothing (no change, no throw)', changes.n === before, '');
  player.st = { state: 'offline', drm: 'unknown' };
  const e2 = createEngine({ player: fakePlayer(), now: () => t, fetchBytes: async () => null, onChange: () => {}, setInterval: () => ({ unref() {} }) });
  e2.onMessage('{"t":"ready"}');
  check('apple engine: before anything came from the page, a page that cannot load is an "offline" card', (await createEngine({ player: { ...fakePlayer(), status: () => ({ state: 'offline', drm: 'unknown' }), ensure() { this.wc = this.wc || { send() {} }; }, webContents() { return this.wc; } }, now: () => t, fetchBytes: async () => null, onChange: () => {}, setInterval: () => ({ unref() {} }) }).read()).reason === 'offline', '');
  player.st = { state: 'ready', drm: 'ok' };

  // ---- the page is made again ----
  const oldWc = player.wc;
  player.wc = null; // the page crashed; the next read makes a new one
  const again = await e.read();
  check('apple engine: a new page starts from nothing (not ready, nothing remembered) and commands wait for it', player.wc && player.wc !== oldWc && again.reason === 'loading' && again.signedIn === null && e.search('x') === false, JSON.stringify(again).slice(0, 120));
  e.onMessage('{"t":"ready"}');
  e.onMessage(state({ auth: false, state: 0, item: null }));

  // ---- unload ----
  check('apple engine: a read starts the idle timer once', typeof intervalFn === 'function', '');
  t += 20 * 60e3;
  e.onMessage(state({ state: 2 }));
  intervalFn();
  check('apple engine: it stays loaded while something plays, even after a long time', player.destroyed === 0, String(player.destroyed));
  e.onMessage(state({ state: 3 }));
  t += 5 * 60e3;
  intervalFn();
  check('apple engine: paused and idle for a few minutes is not yet "a long idle"', player.destroyed === 0, '');
  t += 11 * 60e3;
  intervalFn();
  check('apple engine: paused and off-screen for a long time unloads the hidden page', player.destroyed === 1 && !e.status().ready, String(player.destroyed));
  await e.read();
  check('apple engine: the next read loads it again', player.wc !== null && player.ensured >= 3, String(player.ensured));
  e.destroy();
  check('apple engine: quitting closes the page (its music stops)', player.wc === null && player.destroyed >= 2, String(player.destroyed));
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
