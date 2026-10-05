// The Apple Music engine's bridge, without Electron or the network: the checks on every message the page sends and every
// command main sends (features/apple-music-bridge.js), the state mapping, and the page script itself run against a fake
// MusicKit in a bare vm context (what it reports, what it calls for each command, that it ignores anything off the fixed list).
// Runs on its own (npm run test:units picks up test/*-units.js).
const vm = require('vm');
const AMB = require('../src/features/apple-music-bridge');

const ART = 'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/a7/98/d8/x.jpg/{w}x{h}bb.jpg';
const stateMsg = (o = {}) => JSON.stringify({ t: 'state', auth: false, state: 2, pos: 12.5, dur: 90, store: 'us', item: { id: '1440933651', type: 'song', title: 'Shake It Off', artist: 'Taylor Swift', album: '1989', art: ART, ms: 219200 }, ...o });

// The page script in a fake page: a document that keeps listeners, a fake MusicKit, and a log of what the script did.
function pageHarness({ authorized = false, withKit = true } = {}) {
  const listeners = {};
  const out = [];
  const calls = [];
  const kitEvents = {};
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  const document = {
    addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
    dispatchEvent: (e) => { if (e.type === 'lumen-am-out') out.push(JSON.parse(e.detail)); (listeners[e.type] || []).forEach((f) => f(e)); return true; },
  };
  const ok = (...a) => { calls.push(a); return Promise.resolve(); };
  const kit = {
    isAuthorized: authorized, playbackState: 0, currentPlaybackTime: 0, currentPlaybackDuration: 0, storefrontId: 'us', nowPlayingItem: null,
    addEventListener: (ev, f) => { (kitEvents[ev] ||= []).push(f); },
    play: () => ok('play'), pause: () => { calls.push(['pause']); }, skipToNextItem: () => ok('next'), skipToPreviousItem: () => ok('previous'),
    seekToTime: (s) => ok('seek', s), setQueue: (q) => ok('setQueue', q),
    api: { music: (path, params) => { calls.push(['api', path, params]); return kit.apiAnswer(path, params); } },
    apiAnswer: () => Promise.resolve({ data: { data: [] } }),
  };
  const intervals = [];
  const ctx = vm.createContext({ document, CustomEvent, JSON, String, Boolean, Date, Array, isFinite, window: withKit ? { MusicKit: { getInstance: () => kit } } : {}, setInterval: (f) => { intervals.push(f); return intervals.length; }, clearInterval: () => {} });
  vm.runInContext(AMB.BRIDGE_SOURCE, ctx);
  const tick = () => intervals.forEach((f) => f());
  const send = (obj) => document.dispatchEvent(new CustomEvent('lumen-am-in', { detail: typeof obj === 'string' ? obj : JSON.stringify(obj) }));
  const fire = (ev) => (kitEvents[ev] || []).forEach((f) => f({}));
  return { kit, out, calls, tick, send, fire, listeners };
}
const flush = () => new Promise((r) => setImmediate(r));

module.exports = async function appleMusicBridgeUnits(check) {
  // ---- artwork ----
  const A = (u) => AMB.artUrl(u, 160);
  check('apple bridge: an artwork template becomes one https mzstatic.com picture of the asked size', A(ART) === 'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/a7/98/d8/x.jpg/160x160bb.jpg' && A('https://a1.mzstatic.com/us/r1000/x/{w}x{h}{c}.{f}') === 'https://a1.mzstatic.com/us/r1000/x/160x160bb.jpg', A(ART));
  const badArt = ['http://is1-ssl.mzstatic.com/x/{w}x{h}.jpg', 'https://evil.example/x/{w}x{h}.jpg', 'https://mzstatic.com.evil.example/x.jpg', 'https://evil.example/mzstatic.com/x.jpg', 'https://user:pw@is1.mzstatic.com/x.jpg', 'https://is1.mzstatic.com:8443/x.jpg', 'https://is1.mzstatic.com/x y.jpg', 'https://is1.mzstatic.com/x"onerror=1.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '', null, 5, `https://is1.mzstatic.com/${'a'.repeat(700)}`];
  check('apple bridge: artwork from any other host, scheme, port, credentials or with odd characters is refused', badArt.every((u) => A(u) === ''), badArt.filter((u) => A(u) !== '').join(' '));

  // ---- kinds and playback states ----
  check('apple bridge: API types map to what setQueue takes (library ones too); others are null', ['songs', 'albums', 'playlists', 'stations', 'library-playlists', 'library-albums', 'song'].every((t) => AMB.kindOf(t)) && AMB.kindOf('library-playlists') === 'playlist' && AMB.kindOf('songs') === 'song' && ['artists', 'music-videos', '', null, 'constructor', '__proto__'].every((t) => AMB.kindOf(t) === null), '');
  check('apple bridge: playback states map (loading and stalled are about to play; seeking is its own; the rest idle)', [2, 1, 8, 9].every((n) => AMB.playbackKind(n) === 'playing') && AMB.playbackKind(3) === 'paused' && AMB.playbackKind(6) === 'seeking' && [0, 4, 5, 10, 99, -1, NaN].every((n) => AMB.playbackKind(n) === 'idle'), '');

  // ---- messages from the page ----
  const m = AMB.parseMessage(stateMsg());
  check('apple bridge: a state message is parsed and bounded (art made a small picture address)', m.t === 'state' && m.auth === false && m.state === 2 && m.pos === 12.5 && m.dur === 90 && m.store === 'us' && m.item.title === 'Shake It Off' && m.item.kind === 'song' && m.item.art.endsWith('/160x160bb.jpg') && m.item.ms === 219200, JSON.stringify(m));
  check('apple bridge: a state with evil art keeps the item and drops the picture', AMB.parseMessage(stateMsg({ item: { id: '1', type: 'song', title: 'T', art: 'https://evil.example/a.jpg' } })).item.art === '' && AMB.parseMessage(stateMsg({ item: { id: '1', type: 'song', title: 'T', art: 'javascript:1' } })).item.art === '', '');
  check('apple bridge: text is flattened and bounded; a bad id is blanked; no title means no item', AMB.parseMessage(stateMsg({ item: { id: 'a b<', type: 'song', title: ' <b>Hi</b>\u0000\n there ', artist: 'A'.repeat(900) } })).item.title === '<b>Hi</b> there' && AMB.parseMessage(stateMsg({ item: { id: 'a b<', type: 'song', title: 'T' } })).item.id === '' && AMB.parseMessage(stateMsg({ item: { id: '1', type: 'song', title: '' } })).item === null && AMB.parseMessage(stateMsg({ item: { id: 'a b<', type: 'song', title: 'T', artist: 'A'.repeat(900) } })).item.artist.length === 120, '');
  check('apple bridge: numbers are bounded (NaN, negative or huge become 0); a store is two letters or empty', (() => { const x = AMB.parseMessage(stateMsg({ pos: -5, dur: 1e12, state: 'x', store: 'USA' })); return x.pos === 0 && x.dur === 0 && x.state === 0 && x.store === ''; })(), '');
  check('apple bridge: "auth" is true only for true (not "yes" or 1)', AMB.parseMessage(stateMsg({ auth: true })).auth === true && AMB.parseMessage(stateMsg({ auth: 'yes' })).auth === false && AMB.parseMessage(stateMsg({ auth: 1 })).auth === false, '');
  const L = AMB.parseMessage(JSON.stringify({ t: 'list', kind: 'recent', rid: 4, ok: true, items: [{ id: 'l.abc', type: 'library-albums', title: 'Quiet', sub: 'Ann' }, { id: 'bad id', type: 'songs', title: 'x' }, { id: '5', type: 'artists', title: 'x' }, { id: '6', type: 'songs', title: '' }, null, 3] }));
  check('apple bridge: a list keeps only items with a safe id, a playable kind and a title', L.t === 'list' && L.items.length === 1 && L.items[0].id === 'l.abc' && L.items[0].kind === 'album' && L.rid === 4 && L.ok === true, JSON.stringify(L));
  check('apple bridge: a list is cut at 12 items, and only known list kinds are accepted', AMB.parseMessage(JSON.stringify({ t: 'list', kind: 'search', items: Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, type: 'songs', title: 'T' })) })).items.length === 12 && AMB.parseMessage(JSON.stringify({ t: 'list', kind: 'secrets', items: [] })) === null, '');
  check('apple bridge: ready and error messages are parsed; an error text is bounded', AMB.parseMessage('{"t":"ready"}').t === 'ready' && AMB.parseMessage(JSON.stringify({ t: 'error', message: 'x'.repeat(900) })).message.length === 200, '');
  check('apple bridge: junk is dropped (not JSON, arrays, null, unknown kinds, non-strings, oversized)', ['', 'nope', '[]', 'null', '5', '{"t":"nope"}', '{}', '{"t":"state"', null, undefined, 5, {}, 'x'.repeat(AMB.MAX_MESSAGE + 1), JSON.stringify({ t: 'ready', pad: 'x'.repeat(AMB.MAX_MESSAGE) })].every((x) => AMB.parseMessage(x) === null), '');
  check('apple bridge: prototype-pollution looking keys do nothing', (() => { const x = AMB.parseMessage('{"t":"state","__proto__":{"polluted":1},"item":{"__proto__":{"x":1},"title":"T"}}'); return x && ({}).polluted === undefined && x.item.title === 'T' && !('__proto__' in JSON.parse(JSON.stringify(x)) && Object.prototype.hasOwnProperty.call(x, 'polluted')); })(), '');

  // ---- commands to the page ----
  const cc = (c) => AMB.cleanCommand(c);
  check('apple bridge: the four buttons are commands with no arguments', ['play', 'pause', 'next', 'previous'].every((c) => cc({ cmd: c, extra: 'x' }) === JSON.stringify({ cmd: c })), '');
  check('apple bridge: seek takes seconds (rounded) in range only', cc({ cmd: 'seek', sec: 12.6 }) === '{"cmd":"seek","sec":13}' && [{ cmd: 'seek', sec: -1 }, { cmd: 'seek', sec: NaN }, { cmd: 'seek', sec: Infinity }, { cmd: 'seek', sec: '5' }, { cmd: 'seek', sec: 1e9 }, { cmd: 'seek' }].every((c) => cc(c) === null), '');
  check('apple bridge: playItem takes a fixed kind and a safe id', cc({ cmd: 'playItem', kind: 'playlist', id: 'p.AbC-1_2' }) === '{"cmd":"playItem","kind":"playlist","id":"p.AbC-1_2"}' && [{ kind: 'artist', id: '1' }, { kind: 'song', id: '' }, { kind: 'song', id: 'a b' }, { kind: 'song', id: 'a/../b' }, { kind: 'song', id: '1;alert(1)' }, { kind: 'song', id: 'x'.repeat(65) }, { kind: 'song', id: 5 }, { kind: 'song' }, { id: '1' }].every((c) => cc({ cmd: 'playItem', ...c }) === null), '');
  check('apple bridge: list takes recent or playlists; search takes a bounded term', cc({ cmd: 'list', kind: 'recent', rid: 3 }) === '{"cmd":"list","kind":"recent","rid":3}' && cc({ cmd: 'list', kind: 'secrets' }) === null && JSON.parse(cc({ cmd: 'search', term: ` ${'a'.repeat(200)}\u0000 `, rid: 2 })).term.length === 80 && cc({ cmd: 'search', term: '   ' }) === null && cc({ cmd: 'search', term: 5 }) === null, '');
  check('apple bridge: anything else is not a command (eval, unknown names, no object)', [{ cmd: 'eval', code: '1' }, { cmd: 'constructor' }, { cmd: '__proto__' }, { cmd: 'toString' }, { cmd: 'Play' }, {}, null, undefined, 'play', 5, []].every((c) => cc(c) === null), '');

  // ---- the card's data ----
  const NOW = 1e12;
  const play = AMB.toCard(m, NOW, 'data:image/jpeg;base64,AAAA');
  check('apple bridge: playing -> the card (seconds to milliseconds, MusicKit\'s duration wins, art, source engine, preview when signed out)', play.state === 'playing' && play.title === 'Shake It Off' && play.progressMs === 12500 && play.durationMs === 90000 && play.art.startsWith('data:image/jpeg') && play.source === 'engine' && play.preview === true && play.at === NOW, JSON.stringify(play));
  check('apple bridge: signed in is not a preview; with no MusicKit duration the item\'s length is used; the playhead never passes the end', AMB.toCard(AMB.parseMessage(stateMsg({ auth: true })), NOW).preview === false && AMB.toCard(AMB.parseMessage(stateMsg({ dur: 0 })), NOW).durationMs === 219200 && AMB.toCard(AMB.parseMessage(stateMsg({ pos: 500, dur: 90 })), NOW).progressMs === 90000, '');
  check('apple bridge: paused is paused; stopped, ended, none and no item are idle; seeking says "keep what you had" (null)', AMB.toCard(AMB.parseMessage(stateMsg({ state: 3 })), NOW).state === 'paused' && [0, 4, 5, 10].every((n) => AMB.toCard(AMB.parseMessage(stateMsg({ state: n })), NOW).state === 'idle') && AMB.toCard(AMB.parseMessage(stateMsg({ item: null })), NOW).state === 'idle' && AMB.toCard(AMB.parseMessage(stateMsg({ state: 6 })), NOW) === null, '');

  // ---- the page script itself ----
  check('apple bridge: the page script is plain code: no eval, Function, fetch, XHR, innerHTML, document.write, import or WebSocket', !/\b(eval|Function|fetch|XMLHttpRequest|innerHTML|outerHTML|document\.write|import\s*\(|WebSocket|localStorage|sessionStorage|cookie|postMessage)\b/.test(AMB.BRIDGE_SOURCE), '');
  check('apple bridge: the page script names exactly three Apple API paths', (AMB.BRIDGE_SOURCE.match(/'\/v1\/[^']*'/g) || []).sort().join() === "'/v1/catalog/','/v1/me/library/playlists','/v1/me/recent/played'", (AMB.BRIDGE_SOURCE.match(/'\/v1\/[^']*'/g) || []).join());
  check('apple bridge: the page script compiles', (() => { try { new vm.Script(AMB.BRIDGE_SOURCE); return true; } catch { return false; } })(), '');

  const h = pageHarness();
  check('apple bridge (page): nothing is reported until MusicKit\'s instance exists; then "ready" and a first state', h.out.length === 0 && (() => { h.tick(); return h.out.length === 2 && h.out[0].t === 'ready' && h.out[1].t === 'state'; })(), JSON.stringify(h.out));
  const noKit = pageHarness({ withKit: false });
  noKit.tick();
  check('apple bridge (page): with no MusicKit it keeps waiting and reports nothing', noKit.out.length === 0, '');
  h.out.length = 0;
  h.kit.playbackState = 2; h.kit.currentPlaybackTime = 3; h.kit.currentPlaybackDuration = 30; h.kit.nowPlayingItem = { id: '77', type: 'songs', title: 'Song', artistName: 'Ann', albumName: 'Alb', artworkURL: ART, playbackDuration: 30000 };
  h.fire('nowPlayingItemDidChange'); h.fire('playbackStateDidChange');
  const parsed = h.out.map((x) => AMB.parseMessage(JSON.stringify(x)));
  check('apple bridge (page): MusicKit events send the state (and what it sends parses)', parsed.length === 2 && parsed.every((x) => x && x.t === 'state' && x.state === 2 && x.item.title === 'Song' && x.item.kind === 'song' && x.item.art.endsWith('/160x160bb.jpg') && x.pos === 3), JSON.stringify(h.out[0]));
  h.out.length = 0;
  h.fire('playbackProgressDidChange'); h.fire('playbackProgressDidChange');
  check('apple bridge (page): progress events are thinned (one state, then none for a few seconds)', h.out.length === 1, String(h.out.length));
  h.out.length = 0;
  h.kit.isAuthorized = true;
  h.fire('authorizationStatusDidChange');
  check('apple bridge (page): signing in (authorizationStatusDidChange) sends auth: true', h.out.length === 1 && h.out[0].auth === true, JSON.stringify(h.out));

  // commands: each calls the player's own method, nothing more
  for (const [cmd, expect] of [['play', ['play']], ['pause', ['pause']], ['next', ['next']], ['previous', ['previous']]]) {
    h.calls.length = 0;
    h.send({ cmd });
    await flush();
    check(`apple bridge (page): "${cmd}" calls MusicKit's ${cmd} and nothing else`, JSON.stringify(h.calls) === JSON.stringify([expect]), JSON.stringify(h.calls));
  }
  h.calls.length = 0;
  h.send({ cmd: 'seek', sec: 41 });
  h.send({ cmd: 'seek', sec: -3 });
  h.send({ cmd: 'seek', sec: 'x' });
  await flush();
  check('apple bridge (page): seek calls seekToTime with a good number only', JSON.stringify(h.calls) === '[["seek",41]]', JSON.stringify(h.calls));
  h.calls.length = 0;
  h.send({ cmd: 'playItem', kind: 'playlist', id: 'p.abc' });
  h.send({ cmd: 'playItem', kind: 'artist', id: '1' });
  h.send({ cmd: 'playItem', kind: 'song', id: 'a b' });
  h.send({ cmd: 'playItem', kind: 'song', id: '1/../2' });
  await flush();
  check('apple bridge (page): playItem sets that queue and plays; a bad kind or id does nothing', JSON.stringify(h.calls) === '[["setQueue",{"playlist":"p.abc"}],["play"]]', JSON.stringify(h.calls));
  h.calls.length = 0;
  for (const bad of ['{"cmd":"eval","code":"1"}', '{"cmd":"constructor"}', '{"cmd":"__proto__"}', 'not json', '', '{"cmd":"setQueue","q":{"song":"1"}}', '{"cmd":"authorize"}', '{"cmd":"signOut"}', '{"cmd":"unauthorize"}']) h.send(bad);
  h.send({ cmd: 'play', extra: 'x' });
  await flush();
  check('apple bridge (page): anything off the fixed list (authorize, unauthorize, setQueue, eval, junk) does nothing; extra fields are ignored', JSON.stringify(h.calls) === '[["play"]]', JSON.stringify(h.calls));

  // lists and search
  h.out.length = 0; h.calls.length = 0;
  h.kit.apiAnswer = (path) => Promise.resolve({ data: { data: [{ id: 'l.1', type: 'library-playlists', attributes: { name: 'Mix' } }, { id: 'i.2', type: 'albums', attributes: { name: 'Alb', artistName: 'Ann' } }] } });
  h.send({ cmd: 'list', kind: 'recent', rid: 5 });
  h.send({ cmd: 'list', kind: 'playlists', rid: 6 });
  h.send({ cmd: 'list', kind: 'secrets', rid: 7 });
  await flush(); await flush();
  const apiCalls = h.calls.filter((c) => c[0] === 'api');
  check('apple bridge (page): recent and playlists call their two fixed paths with a limit, nothing else', apiCalls.length === 2 && apiCalls[0][1] === '/v1/me/recent/played' && apiCalls[1][1] === '/v1/me/library/playlists' && apiCalls.every((c) => c[2].limit > 0 && Object.keys(c[2]).join() === 'limit'), JSON.stringify(apiCalls));
  const lists = h.out.map((x) => AMB.parseMessage(JSON.stringify(x))).filter((x) => x && x.t === 'list');
  check('apple bridge (page): the answers come back as lists main accepts', lists.length === 2 && lists[0].rid === 5 && lists[0].ok && lists[0].items.length === 2 && lists[0].items[0].kind === 'playlist' && lists[0].items[1].sub === 'Ann', JSON.stringify(h.out).slice(0, 300));
  h.out.length = 0; h.calls.length = 0;
  h.kit.apiAnswer = () => Promise.resolve({ data: { results: { songs: { data: [{ id: '1', type: 'songs', attributes: { name: 'S', artistName: 'A' } }] }, albums: { data: [{ id: '2', type: 'albums', attributes: { name: 'B', artistName: 'C' } }] } } } });
  h.send({ cmd: 'search', term: 'shake it off / ../../v1/me?x=1', rid: 9 });
  await flush(); await flush();
  const sc = h.calls.find((c) => c[0] === 'api');
  check('apple bridge (page): search goes to the catalog path of the storefront with the term as a parameter, never in the path', sc && sc[1] === '/v1/catalog/us/search' && sc[2].term === 'shake it off / ../../v1/me?x=1' && sc[2].types === 'songs,albums,playlists' && sc[2].limit === 4, JSON.stringify(sc));
  check('apple bridge (page): search results come back as one list', (() => { const l = AMB.parseMessage(JSON.stringify(h.out.find((x) => x.t === 'list'))); return l && l.kind === 'search' && l.rid === 9 && l.items.map((i) => i.kind).join() === 'song,album'; })(), JSON.stringify(h.out));
  h.kit.storefrontId = '../../evil';
  h.calls.length = 0;
  h.send({ cmd: 'search', term: 'x', rid: 10 });
  await flush();
  check('apple bridge (page): a storefront that is not two letters falls back to "us" in the path', h.calls.find((c) => c[0] === 'api')[1] === '/v1/catalog/us/search', JSON.stringify(h.calls));
  h.kit.storefrontId = 'us';
  h.out.length = 0;
  h.kit.apiAnswer = () => Promise.reject({ status: 403 });
  h.send({ cmd: 'list', kind: 'recent', rid: 11 });
  await flush(); await flush();
  const denied = AMB.parseMessage(JSON.stringify(h.out[0]));
  check('apple bridge (page): a refused list (signed out) says so, with no items', denied.kind === 'recent' && denied.ok === false && denied.signedOut === true && denied.items.length === 0, JSON.stringify(h.out));
  h.out.length = 0;
  h.kit.play = () => Promise.reject(new Error('NOT_ALLOWED'));
  h.send({ cmd: 'play' });
  await flush(); await flush();
  check('apple bridge (page): a failing player call is reported as an error message', h.out.length === 1 && h.out[0].t === 'error' && /NOT_ALLOWED/.test(h.out[0].message), JSON.stringify(h.out));
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
