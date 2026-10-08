// The Spotify engine (features/spotify-engine.js on features/music-engine.js) and the Spotify widget's new default mode, without Electron,
// Spotify or the network: a fake web player (the hidden page), a fake sign-in window and clock. What differs from Apple Music's: signed in
// comes from Spotify's cookie (not the page), the page-changed self-test, remote playback (Spotify Connect), search without lists or a
// queue; and the widget: new cards default to the engine, saved modes are kept, the card data, the buttons and search through it.
// Runs on its own (npm run test:units picks up test/*-units.js).
const { EventEmitter } = require('events');
const { createEngine } = require('../src/features/spotify-engine');
const { createWidgets, cleanList } = require('../src/features/widgets');
const SW = require('../src/features/spotify-web');

const ART = 'https://i.scdn.co/image/ab67616d00001e02abc';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const CLIENT = '0123456789abcdef0123456789abcdef';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = (o = {}) => JSON.stringify({ t: 'state', state: 2, pos: 12, dur: 200, device: '', player: true, item: { title: 'Night Shift', artist: 'Ann', album: 'Quiet Hours', art: ART, ms: 200000 }, ...o });

function fakePlayer() {
  const p = {
    destroyed: 0, signed: false, pinned: null, released: 0, reloaded: 0, st: { state: 'ready', drm: 'ok' }, wc: null,
    ensure() { if (!p.wc) p.wc = { sent: [], gestures: [], codes: [], executeJavaScript(code, gesture) { const m = /detail: (".*") \}\)\)$/.exec(code); p.wc.codes.push(code); p.wc.gestures.push(gesture); if (m) p.wc.sent.push(['musicengine:cmd', JSON.parse(JSON.parse(m[1]))]); return Promise.resolve(); } }; return {}; },
    webContents: () => p.wc, status: () => p.st, isSignedIn: () => p.signed,
    destroy() { p.destroyed++; p.wc = null; }, showIn(win, rect) { p.pinned = { win, rect }; }, release() { p.released++; p.pinned = null; }, reload() { p.reloaded++; },
  };
  return p;
}
function fakeWin() {
  const w = new EventEmitter();
  w.destroyed = false; w.closed = 0;
  w.isDestroyed = () => w.destroyed; w.focus = () => {}; w.getContentSize = () => [560, 740]; w.removeMenu = () => {};
  w.close = () => { w.closed++; w.emit('close'); w.destroyed = true; };
  return w;
}

module.exports = async function spotifyEngineUnits(check) {
  let t = 1e12;
  const changes = { n: 0 };
  const player = fakePlayer();
  const wins = [];
  const fetched = [];
  const e = createEngine({
    player, now: () => t, fetchBytes: async (url) => { fetched.push(url); return PNG; }, resizeArt: (b) => b,
    BrowserWindow: function BrowserWindow(opts) { const w = fakeWin(); w.opts = opts; wins.push(w); return w; },
    getParent: () => null, hasCard: () => true, onChange: () => { changes.n++; }, setInterval: () => ({ unref() {} }),
  });
  const sent = () => (player.wc ? player.wc.sent.map((s) => s[1]) : []);

  await e.read();
  e.onMessage('{"t":"ready"}');
  // ---- signed out: no player controls on the page, and that is not "changed" ----
  e.onMessage(state({ state: 0, item: null, player: false }));
  const out = await e.read();
  check('spotify engine: signed out is known from Spotify\'s own cookie (the page does not say), the idle card offers Sign in, and says nothing is wrong', out.signedIn === false && out.state === 'idle' && out.pageChanged === false && out.engine === 'ready', JSON.stringify(out).slice(0, 200));
  t += 60e3;
  e.onMessage(state({ state: 0, item: null, player: false }));
  check('spotify engine: a signed-out page without the player controls is never reported as changed, however long', (await e.read()).pageChanged === false, '');
  check('spotify engine: signed out it offers search and seek, but not the heart, the library or lyrics (they need an account)', (() => { const c = out.can; return c.search && c.seek && !c.like && !c.library && !c.lyrics && !c.playNext && !c.playLater; })(), JSON.stringify(out.can));
  check('spotify engine: signed out, play next and add to queue are refused (nothing is sent)', e.playNext('song', '1') === false && e.playLater('song', '1') === false && sent().filter((c) => c.cmd === 'playLater' || c.cmd === 'playNext').length === 0, JSON.stringify(sent()));

  // ---- signing in: the cookie ----
  check('spotify engine: Sign in opens the window with the engine page in it', e.signIn() === true && wins.length === 1 && wins[0].opts.title === 'Sign in to Spotify' && player.pinned.rect.width === 560, '');
  player.signed = true;
  e.authChanged();
  check('spotify engine: when the cookie says signed in, the window closes by itself and the page goes back', wins[0].closed === 1 && player.released === 1 && e.signedIn() === true, `${wins[0].closed} ${player.released}`);

  // ---- the self-test: signed in, but the page shows no player ----
  const n0 = changes.n;
  e.onMessage(state({ state: 0, item: null, player: false }));
  check('spotify engine: signed in with no player controls is not yet "changed" (the page may still be loading)', (await e.read()).pageChanged === false, '');
  t += 30e3;
  e.onMessage(state({ state: 0, item: null, player: false }));
  const broken = await e.read();
  check('spotify engine: …after a while it is: the card is told Spotify changed its page, and the page is redrawn for it', broken.pageChanged === true && changes.n > n0, JSON.stringify([broken.pageChanged, changes.n - n0]));
  e.onMessage(state({ state: 0, item: null, player: true }));
  check('spotify engine: the player controls showing up clears it', (await e.read()).pageChanged === false, '');

  // ---- playing here, then on another device ----
  e.onMessage(state());
  const here = await e.read();
  check('spotify engine: playing here: the card, a picture asked from scdn.co only, no preview, no device', here.state === 'playing' && here.title === 'Night Shift' && here.device === '' && here.preview === false && fetched.length === 1 && fetched[0] === ART, JSON.stringify([here.state, here.device, fetched]));
  await sleep(20);
  check('spotify engine: the picture arrives as a data: URL', (await e.read()).art.startsWith('data:image/png;base64,'), '');
  e.onMessage(state({ device: 'Kitchen speaker', pos: 70 }));
  const remote = await e.read();
  check('spotify engine: playing on another device (Spotify Connect): the card names it and carries the state', remote.state === 'playing' && remote.device === 'Kitchen speaker' && remote.progressMs === 70000, JSON.stringify([remote.device, remote.progressMs]));
  await e.control('pause'); await e.control('next'); await e.control('previous');
  check('spotify engine: the buttons go to the page (which presses the remote session\'s buttons)', sent().slice(-3).map((c) => c.cmd).join() === 'pause,next,previous', JSON.stringify(sent().slice(-3)));
  check('spotify engine: seek goes to the page', e.seek(40) === true && JSON.stringify(sent().at(-1)) === '{"cmd":"seek","sec":40}', '');
  const c1 = changes.n;
  e.onMessage(state({ device: 'Kitchen speaker', pos: 72 }));
  check('spotify engine: a playhead that moved on as expected is not a change; a new device is', changes.n === c1 && (e.onMessage(state({ device: 'Desk', pos: 74 })), changes.n > c1), '');
  e.onMessage(state({ state: 3, device: 'Desk' }));
  check('spotify engine: paused is paused', (await e.read()).state === 'paused', '');

  // ---- search ----
  e.onMessage(state({ state: 0, item: null }));
  check('spotify engine: search sends the fixed command with a fresh request id', e.search(' shake it off ') === true && sent().at(-1).cmd === 'search' && sent().at(-1).term === 'shake it off' && (await e.read()).searching === true, JSON.stringify(sent().at(-1)));
  const rid = sent().at(-1).rid;
  e.onMessage(JSON.stringify({ t: 'list', kind: 'search', rid: rid - 1, ok: true, items: [{ id: 'old', kind: 'song', title: 'Old' }] }));
  check('spotify engine: an older search answer is ignored', (await e.read()).results.length === 0, '');
  const before = fetched.length;
  e.onMessage(JSON.stringify({ t: 'list', kind: 'search', rid, ok: true, items: [{ id: '4uLU6hMCjMI75M1A2tKUQC', kind: 'song', title: 'Shake It Off', sub: 'Taylor Swift', ms: 219000, art: ART }, { id: '2QJmrSgbdM35R67eoGQo4j', kind: 'album', title: '1989', sub: '', ms: 0, art: 'https://mosaic.scdn.co/64/x' }, { id: '06HL4z0CvFAxyc27GXpf02', kind: 'artist', title: 'Taylor Swift' }] }));
  const res = await e.read();
  check('spotify engine: results (song, album, artist) with duration; the card is told', res.results.length === 3 && res.results[0].ms === 219000 && res.results[2].kind === 'artist' && res.query === 'shake it off' && res.searching === false && res.searchOk === true, JSON.stringify(res.results));
  await sleep(30);
  check('spotify engine: no picture is fetched until the card asks for the rows on screen (lazy: the first rows show without waiting for pictures)', fetched.length === before && (await e.read()).results.every((r) => r.thumb === ''), String(fetched.length - before));
  check('spotify engine: loadThumbs names rows by id; an id that is not in the results fetches nothing', e.loadThumbs(['nope']) === false && e.loadThumbs([]) === false && (await sleep(20), fetched.length === before), String(fetched.length - before));
  check('spotify engine: loadThumbs for rows on screen', e.loadThumbs(['4uLU6hMCjMI75M1A2tKUQC', '2QJmrSgbdM35R67eoGQo4j', '06HL4z0CvFAxyc27GXpf02']) === true, '');
  await sleep(30);
  const withThumbs = await e.read();
  check('spotify engine: small pictures for the rows asked for are fetched (scdn.co only) and then shown as data: URLs', fetched.length > before && fetched.slice(before).every((u) => /\.scdn\.co\//.test(u)) && withThumbs.results[0].thumb.startsWith('data:image/') && withThumbs.results[1].thumb.startsWith('data:image/') && withThumbs.results[2].thumb === '', JSON.stringify(withThumbs.results.map((r) => r.thumb.slice(0, 20))));
  e.onMessage(JSON.stringify({ t: 'list', kind: 'search', rid, ok: false, items: [] }));
  check('spotify engine: a search the page could not answer is flagged (the card says Spotify may have changed)', (await e.read()).searchOk === false, '');
  // streaming: the first rows (partial) show at once; the whole list replaces them; a page that then never stands still does not take the rows away
  e.search('daft punk');
  const rid2 = sent().at(-1).rid;
  e.onMessage(JSON.stringify({ t: 'list', kind: 'search', rid: rid2, ok: true, partial: true, items: [{ id: 'T1', kind: 'song', title: 'One More Time', sub: 'Daft Punk' }] }));
  const part = await e.read();
  check('spotify engine: partial results: the first rows are on the card at once, no longer "searching" (and the card may know more follow)', part.results.length === 1 && part.searching === false && part.searchPartial === true && part.searchOk === true, JSON.stringify([part.results.length, part.searching, part.searchPartial]));
  e.onMessage(JSON.stringify({ t: 'list', kind: 'search', rid: rid2, ok: true, items: [{ id: 'T1', kind: 'song', title: 'One More Time', sub: 'Daft Punk' }, { id: 'T2', kind: 'song', title: 'Get Lucky', sub: 'Daft Punk' }] }));
  const whole = await e.read();
  check('spotify engine: the whole list replaces the partial one under the same request', whole.results.length === 2 && whole.searchPartial === false, JSON.stringify(whole.results.length));
  e.search('radiohead');
  const rid3 = sent().at(-1).rid;
  e.onMessage(JSON.stringify({ t: 'list', kind: 'search', rid: rid3, ok: true, partial: true, items: [{ id: 'R1', kind: 'song', title: 'Creep', sub: 'Radiohead' }] }));
  e.onMessage(JSON.stringify({ t: 'list', kind: 'search', rid: rid3, ok: false, why: 'timeout', items: [] }));
  const kept = await e.read();
  check('spotify engine: a failure after the first rows were shown does not take them away (the page never stood still)', kept.results.length === 1 && kept.searchOk === true, JSON.stringify([kept.results.length, kept.searchOk]));
  e.onMessage(JSON.stringify({ t: 'list', kind: 'search', rid: rid2, ok: true, items: [{ id: 'OLD', kind: 'song', title: 'Old' }] }));
  check('spotify engine: a late answer of an older query (cancelled by a newer one) never replaces the rows of the newer one', (await e.read()).results.every((r) => r.id !== 'OLD') && (await e.read()).query === 'radiohead', '');
  // more songs
  e.onMessage(JSON.stringify({ t: 'list', kind: 'search', rid: rid3, ok: true, items: [{ id: 'R1', kind: 'song', title: 'Creep', sub: 'Radiohead' }] }));
  check('spotify engine: with fewer than 8 songs the card may offer more songs; searchMore sends the fixed command for the search shown', (await e.read()).moreSongs === true && e.searchMore() === true && JSON.stringify(sent().at(-1)) === JSON.stringify({ cmd: 'searchMore', term: 'radiohead', rid: rid3 }) && (await e.read()).moreLoading === true, JSON.stringify(sent().at(-1)));
  check('spotify engine: asking again while it loads sends nothing more', e.searchMore() === true && sent().filter((c) => c.cmd === 'searchMore').length === 1, '');
  e.onMessage(JSON.stringify({ t: 'list', kind: 'search', rid: rid3, ok: true, more: true, items: [{ id: 'R1', kind: 'song', title: 'Creep', sub: 'Radiohead' }, { id: 'R2', kind: 'song', title: 'Karma Police', sub: 'Radiohead' }] }));
  const moreRes = await e.read();
  check('spotify engine: the longer list arrives under the same request; no more is offered then', moreRes.results.length === 2 && moreRes.moreSongs === false && moreRes.moreLoading === false && e.searchMore() === false, JSON.stringify([moreRes.results.length, moreRes.moreSongs, moreRes.moreLoading]));
  check('spotify engine: playItem sends kind and id; artist is a kind here too', e.playItem('artist', '06HL4z0CvFAxyc27GXpf02') === true && JSON.stringify(sent().at(-1)) === '{"cmd":"playItem","kind":"artist","id":"06HL4z0CvFAxyc27GXpf02"}' && e.playItem('station', '1') === false, '');

  // ---- user gesture, and the player shown when a button does nothing ----
  check('spotify engine: every command runs in the page with a user gesture (the click on Spotify\'s own button then has activation)', player.wc.gestures.length > 5 && player.wc.gestures.every((g) => g === true), String(player.wc.gestures.length));
  const r = createEngine({ player: fakePlayer(), now: () => t, fetchBytes: async () => null, onChange: () => { changes.n++; }, setInterval: () => ({ unref() {} }), respondMs: () => 60, BrowserWindow: function BrowserWindow(opts) { const w = fakeWin(); w.opts = opts; wins.push(w); return w; }, getParent: () => null });
  await r.read();
  r.onMessage('{"t":"ready"}');
  r.onMessage(state({ state: 3 }));
  await r.control('play');
  await sleep(120);
  check('spotify engine: Play pressed and Spotify did nothing: the card is told it did not respond', (await r.read()).unresponsive === true, '');
  const nWins = wins.length;
  r.showPlayer();
  check('spotify engine: "Open player" shows the engine page in a small window of its own (titled Spotify player) and clears the warning', wins.length === nWins + 1 && wins.at(-1).opts.title === 'Spotify player' && (await r.read()).unresponsive === false, JSON.stringify(wins.at(-1)?.opts?.title));
  r.destroy();

  // ---- the widget ----
  check('spotify widget: a new card is in engine mode (status); a saved mode is kept; a card saved before modes stays the API card', SW.cleanMode({}) === 'status' && SW.cleanMode(null) === 'status' && SW.cleanMode({ mode: 'web' }) === 'web' && SW.cleanMode({ mode: 'api' }) === 'api' && SW.cleanMode({ mode: 'status' }) === 'status' && SW.cleanMode({ clientId: CLIENT, art: true }) === 'api' && SW.cleanMode({ mode: '<x>' }) === 'status', '');
  const list = cleanList([{ id: 'wold1', type: 'spotify', clientId: CLIENT, art: true }, { id: 'wweb1', type: 'spotify', mode: 'web' }, { id: 'wnew1', type: 'spotify' }, { id: 'wst01', type: 'spotify', mode: 'status', art: false }]);
  const by = Object.fromEntries(list.map((x) => [x.id, x]));
  check('spotify widget: cleanList keeps every saved mode', by.wold1.mode === 'api' && by.wweb1.mode === 'web' && by.wnew1.mode === 'status' && by.wst01.mode === 'status' && by.wst01.art === false, JSON.stringify(list.map((x) => x.mode)));

  let settings = {};
  const fake = { reads: 0, pressed: [], sought: [], played: [], searched: [], signIns: 0, reloads: 0, last: undefined };
  const card = () => ({ mode: 'status', state: 'playing', title: 'Night Shift', artist: 'Ann', album: 'Quiet Hours', progressMs: 30000, durationMs: 200000, at: Date.now(), source: 'engine', kind: 'track', reason: '', art: 'data:image/jpeg;base64,AAAA', device: '', signedIn: true });
  let apiCalls = 0;
  const w = createWidgets({
    readSettings: () => settings, writeSettings: (s) => { settings = JSON.parse(JSON.stringify(s)); },
    fetch: async () => { apiCalls++; throw new Error('the engine card must not call Spotify\'s API'); },
    getSecret: () => null, setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}),
    spotifyEngine: {
      read: async () => { fake.reads++; return card(); }, control: async (n) => { fake.pressed.push(n); return true; }, seek: (s) => { fake.sought.push(s); return true; },
      playItem: (k, id) => { fake.played.push(`${k}:${id}`); return true; }, playNext: () => false, playLater: () => false, search: (q) => { fake.searched.push(q); return true; },
      signIn: () => { fake.signIns++; return true; }, refreshLists: () => {}, reload: () => { fake.reloads++; },
    },
  });
  const saved = await w.save({ type: 'spotify' }).catch((er) => ({ error: er.message }));
  const id = w.list()[0]?.id;
  check('spotify widget: saving a new card needs no Client ID, no sign-in and no network, and is in engine mode', !saved.error && w.list()[0].mode === 'status' && w.list()[0].art === true && apiCalls === 0, saved.error || JSON.stringify(w.list()[0]));
  await w.refresh(w.list()[0]);
  const get = () => w.forPage().find((c) => c.id === id);
  check('spotify widget: the card data is the engine\'s (no Spotify API call)', get().data.state === 'playing' && get().data.title === 'Night Shift' && fake.reads === 1 && apiCalls === 0, JSON.stringify(get().data).slice(0, 120));
  check('spotify widget: the Settings summary says it plays in Lumen', /plays inside lumen/i.test(w.state().widgets.find((x) => x.id === id).summary) && w.state().widgets.find((x) => x.id === id).mode === 'status', JSON.stringify(w.state().widgets.find((x) => x.id === id)));
  await w.act({ id, do: 'pause' });
  check('spotify widget: Pause goes to the engine, not the Web API, and shows paused at once', fake.pressed.join() === 'pause' && get().data.state === 'paused' && apiCalls === 0, JSON.stringify(fake.pressed));
  const url = (q) => `file:///newtab.html?widget=${id}&do=${q}`;
  await w.act({ id, do: 'seek', ...w.actionFrom(url('seek&arg=77')) });
  await w.act({ id, do: 'playitem', ...w.actionFrom(url('playitem&kind=song&arg=4uLU6hMCjMI75M1A2tKUQC')) });
  await w.act({ id, do: 'esearch', ...w.actionFrom(url('esearch&arg=shake')) });
  await w.act({ id, do: 'esignin' });
  check('spotify widget: seek, play an item, search and sign-in go to the engine', fake.sought.join() === '77' && fake.played.join() === 'song:4uLU6hMCjMI75M1A2tKUQC' && fake.searched.join() === 'shake' && fake.signIns === 1, JSON.stringify([fake.sought, fake.played, fake.searched, fake.signIns]));
  await w.act({ id, do: 'playnext', ...w.actionFrom(url('playnext&kind=song&arg=1')) });
  check('spotify widget: "play next" where the service has no queue says so on the card', /can.t be queued/.test(get().data.notice || ''), JSON.stringify(get().data.notice));
  check('spotify widget: "Try again" (do=reload) reloads the engine in this mode', (await w.act({ id, do: 'reload' })) === true && fake.reloads === 1, String(fake.reloads));
  await sleep(400);
  const reads = fake.reads;
  w.engineChanged();
  await sleep(30);
  check('spotify widget: when the engine changes, the engine card is fetched again at once', fake.reads > reads, `${reads} -> ${fake.reads}`);
  await w.save({ type: 'spotify', mode: 'web' }, id);
  const r2 = fake.reads;
  await w.refresh(w.list()[0], { force: true });
  w.engineChanged();
  check('spotify widget: in Web player mode the engine is not read, and the card is the web card\'s', get().data.mode === 'web' && fake.reads === r2, JSON.stringify(get().data));
  check('spotify widget: the page action list accepts the engine\'s actions for it', ['esignin', 'eshow', 'elists'].every((a) => w.actionFrom(url(a))?.do === a) && w.actionFrom(url('playlater&kind=playlist&arg=p.1'))?.item === 'p.1', '');
  await w.save({ type: 'spotify', mode: 'api', clientId: CLIENT }).then(() => check('spotify widget: API mode still asks to log in first', false, 'saved'), (er) => check('spotify widget: API mode still asks to log in first', /Log in with Spotify first/.test(er.message), er.message));
  const w2 = createWidgets({ readSettings: () => ({ homeWidgets: [{ id: 'wapi00001', type: 'spotify', mode: 'api', clientId: CLIENT, art: false, x: 0, y: 0, w: 4, h: 3 }] }), writeSettings: () => {}, fetch: async () => { throw new Error('offline'); }, getSecret: () => null, setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}) });
  check('spotify widget: an existing API-mode card keeps its mode and Client ID', w2.list()[0].mode === 'api' && w2.list()[0].clientId === CLIENT && w2.list()[0].art === false, JSON.stringify(w2.list()[0]));
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
