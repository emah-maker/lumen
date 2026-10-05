// The Spotify engine's bridge, without Electron or the network (features/spotify-bridge.js): the selector table, the checks on every
// message the page sends and every command main sends, and the page script itself run against a fake Spotify page in a bare vm
// context: what it reports from the page's mediaSession and its own playbar (also for playback on another device), how it presses
// the page's own controls, how it searches and plays through the page's router, that it uses fallback selectors, says when the
// player's controls are missing ("Spotify changed its page"), and that it never touches a token or makes a request.
// Runs on its own (npm run test:units picks up test/*-units.js). Whether the real signed-in Spotify page still matches the table is
// something only a signed-in run can show; see the report of the Spotify engine.
const vm = require('vm');
const SPB = require('../src/features/spotify-bridge');

const ART = 'https://i.scdn.co/image/ab67616d00001e02abc';

// A fake page. `dom` maps an exact selector string to the element (or list) the page would give for it; elements are small objects.
function el(o = {}) {
  const e = { textContent: '', disabled: false, clicks: 0, attrs: {}, children: [], src: '', alt: '', max: '', closest: () => null, ...o };
  e.getAttribute = (n) => (n in e.attrs ? e.attrs[n] : null);
  e.click = () => { e.clicks++; e.onclick?.(); };
  e.querySelector = (sel) => (e.sub && e.sub[sel]) || null;
  e.querySelectorAll = (sel) => (e.sub && e.sub[sel] ? [].concat(e.sub[sel]) : []);
  e.dispatchEvent = (ev) => { e.events = (e.events || []).concat(ev.type); return true; };
  return e;
}
function harness({ dom = {}, md = null, media = null, path = '/' } = {}) {
  const listeners = {};
  const out = [];
  let clock = 1e12;
  const timers = [];
  const pushed = [];
  const events = [];
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  class PopStateEvent { constructor(type, init) { this.type = type; this.state = init && init.state; } }
  class Event { constructor(type, init) { this.type = type; this.bubbles = Boolean(init && init.bubbles); } }
  const InputProto = { value: '' };
  Object.defineProperty(InputProto, 'value', { configurable: true, set(v) { this.__v = v; }, get() { return this.__v; } });
  const HTMLInputElement = function HTMLInputElement() {};
  HTMLInputElement.prototype = InputProto;
  const location = { pathname: path };
  const ctx = {
    document: {
      addEventListener: (t, f) => { (listeners[t] ||= []).push(f); },
      dispatchEvent: (e) => { if (e.type === 'lumen-engine-out') out.push(JSON.parse(e.detail)); (listeners[e.type] || []).forEach((f) => f(e)); return true; },
      querySelector: (sel) => { const v = dom[sel]; return Array.isArray(v) ? v[0] || null : v || null; },
      querySelectorAll: (sel) => { const v = dom[sel]; return v ? [].concat(v) : []; },
    },
    navigator: { mediaSession: { metadata: md } },
    history: { pushState: (s, t, url) => { pushed.push(url); location.pathname = url; } },
    window: { dispatchEvent: (e) => { events.push(e.type); } },
    location, CustomEvent, PopStateEvent, Event, HTMLInputElement, JSON, String, Number, Math, Object, Array, Boolean, isFinite, encodeURIComponent, RegExp,
    Date: { now: () => clock },
    setTimeout: (f, ms) => { timers.push({ f, at: clock + (ms || 0), once: true }); return timers.length; },
    setInterval: (f, ms) => { timers.push({ f, at: clock + ms, every: ms }); return timers.length; },
    __media: media,
  };
  ctx.document.querySelectorAll = ((orig) => (sel) => (sel === 'audio, video' ? (ctx.__media ? [ctx.__media] : []) : orig(sel)))(ctx.document.querySelectorAll);
  vm.createContext(ctx);
  vm.runInContext(SPB.BRIDGE_SOURCE, ctx);
  const advance = (ms) => {
    const end = clock + ms;
    for (;;) {
      const due = timers.filter((t) => !t.dead && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      clock = due.at;
      if (due.every) due.at += due.every; else due.dead = true;
      due.f();
    }
    clock = end;
  };
  const send = (obj) => ctx.document.dispatchEvent(new CustomEvent('lumen-engine-in', { detail: typeof obj === 'string' ? obj : JSON.stringify(obj) }));
  return { ctx, out, advance, send, pushed, events, dom, last: () => out.filter((x) => x.t === 'state').at(-1), location };
}
const bar = (label, extra = {}) => el({ attrs: { 'aria-label': label }, ...extra });

module.exports = async function spotifyBridgeUnits(check) {
  // ---- the table ----
  const names = Object.keys(SPB.SELECTORS);
  check('spotify bridge: the selector table has fallbacks as lists of strings, and the required names exist in it', names.length >= 10 && names.every((n) => Array.isArray(SPB.SELECTORS[n]) && SPB.SELECTORS[n].length >= 1 && SPB.SELECTORS[n].every((s) => typeof s === 'string' && s.length > 0)) && SPB.REQUIRED.every((n) => names.includes(n)) && SPB.SELECTORS.playPause.length >= 2, names.join());
  check('spotify bridge: the page script carries exactly that table (one place to change when Spotify does)', SPB.BRIDGE_SOURCE.includes(JSON.stringify(SPB.SELECTORS)), '');
  check('spotify bridge: the page script is plain code: no eval, fetch, XHR, storage, cookies, tokens or internal API names', !/\b(eval|fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|cookie|accessToken|access_token|Authorization|Bearer|spclient|api\.spotify|clienttoken|innerHTML|document\.write|import\s*\()/i.test(SPB.BRIDGE_SOURCE) && !/\/v1\//.test(SPB.BRIDGE_SOURCE), '');
  check('spotify bridge: the page script compiles', (() => { try { new vm.Script(SPB.BRIDGE_SOURCE); return true; } catch { return false; } })(), '');
  check('spotify bridge: this service offers search, seek, no lists and no queue', SPB.CAPS.search && SPB.CAPS.seek && !SPB.CAPS.lists && !SPB.CAPS.queue, JSON.stringify(SPB.CAPS));

  // ---- pictures ----
  const goodArt = ['https://i.scdn.co/image/ab67', 'https://mosaic.scdn.co/640/abc', 'https://image-cdn-ak.scdn.co/x', 'https://scdn.co/x'];
  const badArt = ['http://i.scdn.co/image/x', 'https://i.scdn.co.evil.example/x', 'https://evil.example/i.scdn.co/x', 'https://notscdn.co/x', 'https://user:pw@i.scdn.co/x', 'https://i.scdn.co:8443/x', 'https://i.scdn.co/x y', 'https://i.scdn.co/x"y', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '', null, 5, `https://i.scdn.co/${'a'.repeat(700)}`];
  check('spotify bridge: pictures are https on Spotify\'s own picture hosts (scdn.co) only', goodArt.every((u) => SPB.artUrl(u) !== '') && badArt.every((u) => SPB.artUrl(u) === ''), badArt.filter((u) => SPB.artUrl(u) !== '').join(' '));

  // ---- messages from the page ----
  const state = (o = {}) => JSON.stringify({ t: 'state', state: 2, pos: 12.5, dur: 200, device: '', player: true, item: { title: 'Night Shift', artist: 'Ann', album: 'Quiet Hours', art: ART, ms: 200000 }, ...o });
  const m = SPB.parseMessage(state());
  check('spotify bridge: a state message is parsed and bounded in the shape the shared engine reads (no account claim: auth false)', m.t === 'state' && m.auth === false && m.state === 2 && m.pos === 12.5 && m.dur === 200 && m.item.title === 'Night Shift' && m.item.kind === 'song' && m.item.art === ART && m.player === true && m.device === '', JSON.stringify(m));
  check('spotify bridge: evil art is dropped, text flattened and bounded, a state other than 2 or 3 is "nothing"', SPB.parseMessage(state({ item: { title: ' <b>x</b>\u0000\n y ', artist: 'A'.repeat(900), art: 'https://evil.example/a.png' } })).item.art === '' && SPB.parseMessage(state({ item: { title: ' <b>x</b>\u0000\n y ', artist: 'A'.repeat(900) } })).item.title === '<b>x</b> y' && SPB.parseMessage(state({ item: { title: 'T', artist: 'A'.repeat(900) } })).item.artist.length === 120 && SPB.parseMessage(state({ state: 7 })).state === 0 && SPB.parseMessage(state({ item: { title: '' } })).item === null && SPB.parseMessage(state({ item: null })).item === null, '');
  check('spotify bridge: numbers are bounded and "player" is true only for true (the self-test result)', (() => { const x = SPB.parseMessage(state({ pos: -4, dur: 1e12, player: 'yes', device: 'D'.repeat(200) })); return x.pos === 0 && x.dur === 0 && x.player === false && x.device.length === 60; })(), '');
  const L = SPB.parseMessage(JSON.stringify({ t: 'list', kind: 'search', rid: 3, ok: true, items: [{ id: '4uLU6hMCjMI75M1A2tKUQC', kind: 'song', title: 'Shake It Off', sub: 'Taylor Swift', ms: 219000, art: ART }, { id: 'bad id', kind: 'song', title: 'x' }, { id: '5', kind: 'genre', title: 'x' }, { id: '6', kind: 'album', title: '' }, { id: '7', kind: 'album', title: '1989', art: 'https://evil.example/x' }, null, 4] }));
  check('spotify bridge: search results keep only safe ids, playable kinds and titles; evil pictures are dropped', L.t === 'list' && L.kind === 'search' && L.rid === 3 && L.ok === true && L.items.length === 2 && L.items[0].ms === 219000 && L.items[0].art === ART && L.items[1].art === '', JSON.stringify(L));
  check('spotify bridge: only search lists exist (no recent or playlists), and a list is cut at 40', SPB.parseMessage(JSON.stringify({ t: 'list', kind: 'recent', items: [] })) === null && SPB.parseMessage(JSON.stringify({ t: 'list', kind: 'search', items: Array.from({ length: 90 }, (_, i) => ({ id: `s${i}`, kind: 'song', title: 'T' })) })).items.length === 40, '');
  check('spotify bridge: ready and error messages parse; junk is dropped (not JSON, arrays, null, unknown, oversized)', SPB.parseMessage('{"t":"ready"}').t === 'ready' && SPB.parseMessage(JSON.stringify({ t: 'error', message: 'x'.repeat(900) })).message.length === 200 && ['', 'nope', '[]', 'null', '{"t":"nope"}', '{}', '{"t":"state"', null, undefined, 5, 'x'.repeat(SPB.MAX_MESSAGE + 1)].every((x) => SPB.parseMessage(x) === null), '');

  // ---- commands to the page ----
  const cc = (c) => SPB.cleanCommand(c);
  check('spotify bridge: the four buttons, seek, playItem and search are commands; nothing else (no lists, no queue, no eval)', ['play', 'pause', 'next', 'previous'].every((c) => cc({ cmd: c }) === JSON.stringify({ cmd: c })) && cc({ cmd: 'seek', sec: 12.6 }) === '{"cmd":"seek","sec":13}' && cc({ cmd: 'playItem', kind: 'song', id: '4uLU6hMCjMI75M1A2tKUQC' }) === '{"cmd":"playItem","kind":"song","id":"4uLU6hMCjMI75M1A2tKUQC"}' && JSON.parse(cc({ cmd: 'search', term: ` ${'a'.repeat(200)} `, rid: 2 })).term.length === 80 && [{ cmd: 'list', kind: 'recent' }, { cmd: 'playNext', kind: 'song', id: '1' }, { cmd: 'playLater', kind: 'song', id: '1' }, { cmd: 'eval', code: '1' }, { cmd: '__proto__' }, {}, null, 'play'].every((c) => cc(c) === null), '');
  check('spotify bridge: bad seeks, kinds and ids are refused', [{ cmd: 'seek', sec: -1 }, { cmd: 'seek', sec: NaN }, { cmd: 'seek', sec: '5' }, { cmd: 'seek', sec: 1e9 }, { cmd: 'playItem', kind: 'station', id: '1' }, { cmd: 'playItem', kind: 'song', id: 'a b' }, { cmd: 'playItem', kind: 'song', id: 'a/../b' }, { cmd: 'playItem', kind: 'song', id: 'x'.repeat(65) }, { cmd: 'search', term: '  ' }, { cmd: 'search', term: 5 }].every((c) => cc(c) === null), '');

  // ---- the card's data ----
  const NOW = 1e12;
  const card = SPB.toCard(SPB.parseMessage(state({ device: 'Kitchen speaker' })), NOW, 'data:image/jpeg;base64,AAAA');
  check('spotify bridge: a playing state is the card (seconds to ms, the device named, source engine, never a preview)', card.state === 'playing' && card.title === 'Night Shift' && card.progressMs === 12500 && card.durationMs === 200000 && card.device === 'Kitchen speaker' && card.source === 'engine' && card.preview === false && card.art.startsWith('data:'), JSON.stringify(card));
  check('spotify bridge: paused is paused, nothing is idle; with no length the item\'s is used and the playhead stops at the end', SPB.toCard(SPB.parseMessage(state({ state: 3 })), NOW).state === 'paused' && SPB.toCard(SPB.parseMessage(state({ state: 0, item: null })), NOW).state === 'idle' && SPB.toCard(SPB.parseMessage(state({ dur: 0 })), NOW).durationMs === 200000 && SPB.toCard(SPB.parseMessage(state({ pos: 999, dur: 200 })), NOW).progressMs === 200000, '');

  // ---- the page script: signed out ----
  const out0 = harness({});
  check('spotify bridge (page): it says "ready" and reports a first state at once; with no player controls (signed out) the state says so and has no item', out0.out[0].t === 'ready' && out0.last().player === false && out0.last().item === null && out0.last().state === 0, JSON.stringify(out0.out));
  const n0 = out0.out.length;
  out0.advance(3000);
  check('spotify bridge (page): an unchanged page is not re-reported every second (a heartbeat every few seconds only)', out0.out.length - n0 <= 1, String(out0.out.length - n0));
  out0.advance(7000);
  check('spotify bridge (page): …but it does keep a heartbeat (so "the player never showed up" can be told in time)', out0.out.length > n0, '');

  // ---- local playback: mediaSession and the media element ----
  const pp = bar('Pause');
  const h1 = harness({
    dom: { '[data-testid="control-button-playpause"]': pp, '[data-testid="control-button-skip-forward"]': bar('Next'), '[data-testid="control-button-skip-back"]': bar('Previous') },
    md: { title: 'Night Shift', artist: 'Ann', album: 'Quiet Hours', artwork: [{ src: 'https://i.scdn.co/image/small', sizes: '64x64' }, { src: ART, sizes: '300x300' }, { src: 'https://i.scdn.co/image/big', sizes: '640x640' }] },
    media: { currentSrc: 'blob:x', duration: 200, currentTime: 31, paused: false, play() {}, pause() {} },
  });
  const s1 = h1.last();
  check('spotify bridge (page): from mediaSession and the media element: title, artist, album, a mid-size picture, position and length, playing', s1.state === 2 && s1.item.title === 'Night Shift' && s1.item.artist === 'Ann' && s1.item.album === 'Quiet Hours' && s1.item.art === ART && s1.pos === 31 && s1.dur === 200 && s1.player === true && s1.device === '', JSON.stringify(s1));
  check('spotify bridge (page): what it sends parses', SPB.parseMessage(JSON.stringify(s1)) !== null, '');

  // ---- the page's own playbar: playback on ANOTHER device (Spotify Connect) ----
  const remote = harness({
    dom: {
      '[data-testid="control-button-playpause"]': bar('Pause'),
      '[data-testid="context-item-link"]': el({ textContent: 'Remote Song' }),
      '[data-testid="now-playing-widget"] a[href*="/artist/"]': [el({ textContent: 'Bo' }), el({ textContent: 'Cy' })],
      '[data-testid="cover-art-image"]': el({ src: ART }),
      '[data-testid="playback-position"]': el({ textContent: '1:05' }),
      '[data-testid="playback-duration"]': el({ textContent: '3:20' }),
      '[data-testid="connect-bar"]': el({ textContent: 'Listening on Kitchen speaker' }),
    },
  });
  const sr = remote.last();
  check('spotify bridge (page): with no local media it reads the playbar: title, artists, picture, position and length from its text, and names the other device', sr.state === 2 && sr.item.title === 'Remote Song' && sr.item.artist === 'Bo, Cy' && sr.item.art === ART && sr.pos === 65 && sr.dur === 200 && sr.device === 'Kitchen speaker' && sr.player === true, JSON.stringify(sr));
  const remoteFoot = harness({ dom: { '[data-testid="control-button-playpause"]': bar('Play'), '[data-testid="context-item-link"]': el({ textContent: 'T' }), 'footer': el({ sub: { 'span, p, div': [el({ textContent: 'Playing on Desk' })] } }) } });
  check('spotify bridge (page): a paused remote session is paused; the device is also found by the footer text', remoteFoot.last().state === 3 && remoteFoot.last().device === 'Desk', JSON.stringify(remoteFoot.last()));

  // ---- fallback selectors ----
  const fb = harness({ dom: { 'footer button[aria-label="Play"], footer button[aria-label="Pause"]': bar('Pause'), '[data-testid="now-playing-widget"] a[href*="/track/"]': el({ textContent: 'Fallback Song' }) } });
  check('spotify bridge (page): when the first selector of a name is gone the next one is used (the table\'s fallbacks)', fb.last().player === true && fb.last().item.title === 'Fallback Song' && fb.last().state === 2, JSON.stringify(fb.last()));

  // ---- the buttons ----
  const nextBtn = bar('Next');
  const prevBtn = bar('Previous');
  const ppb = bar('Pause');
  const hc = harness({ dom: { '[data-testid="control-button-playpause"]': ppb, '[data-testid="control-button-skip-forward"]': nextBtn, '[data-testid="control-button-skip-back"]': prevBtn, '[data-testid="context-item-link"]': el({ textContent: 'T' }) } });
  hc.send({ cmd: 'pause' });
  check('spotify bridge (page): pause clicks the page\'s own button when it is playing', ppb.clicks === 1, String(ppb.clicks));
  hc.send({ cmd: 'play' });
  check('spotify bridge (page): play does nothing when it already is playing (no toggling by mistake)', ppb.clicks === 1, String(ppb.clicks));
  ppb.attrs['aria-label'] = 'Play';
  hc.send({ cmd: 'play' });
  hc.send({ cmd: 'pause' });
  check('spotify bridge (page): play clicks it when paused; pause then does nothing', ppb.clicks === 2, String(ppb.clicks));
  hc.send({ cmd: 'next' }); hc.send({ cmd: 'previous' });
  check('spotify bridge (page): next and previous click the page\'s own skip buttons', nextBtn.clicks === 1 && prevBtn.clicks === 1, `${nextBtn.clicks} ${prevBtn.clicks}`);
  nextBtn.disabled = true;
  hc.send({ cmd: 'next' });
  check('spotify bridge (page): a disabled button is not clicked', nextBtn.clicks === 1, '');
  const mediaEl = { currentSrc: 'blob:x', duration: 100, currentTime: 0, paused: true, played: 0, play() { this.paused = false; this.played++; }, pause() { this.paused = true; } };
  const hm = harness({ media: mediaEl });
  hm.send({ cmd: 'play' });
  check('spotify bridge (page): with no playbar button it falls back to the media element', mediaEl.played === 1 && mediaEl.paused === false, '');
  hc.out.length = 0;
  hc.send({ cmd: 'eval', code: '1' }); hc.send('not json'); hc.send({ cmd: 'constructor' }); hc.send({ cmd: 'playNext', kind: 'song', id: '1' });
  check('spotify bridge (page): anything off the fixed list does nothing', ppb.clicks === 2 && nextBtn.clicks === 1 && hc.pushed.length === 0, '');

  // ---- seek ----
  const range = el({ max: '200000', __v: '0' });
  const hs = harness({ dom: { '[data-testid="control-button-playpause"]': bar('Pause'), '[data-testid="playback-progressbar"] input[type="range"]': range, '[data-testid="playback-position"]': el({ textContent: '0:10' }), '[data-testid="playback-duration"]': el({ textContent: '3:20' }), '[data-testid="context-item-link"]': el({ textContent: 'T' }) } });
  Object.setPrototypeOf(range, hs.ctx.HTMLInputElement.prototype);
  hs.send({ cmd: 'seek', sec: 100 });
  check('spotify bridge (page): seek sets the page\'s own range input (scaled to its maximum) and tells the page it changed', Number(range.__v) === 100000 && range.events.includes('input') && range.events.includes('change'), JSON.stringify([range.__v, range.events]));
  hs.send({ cmd: 'seek', sec: -3 }); hs.send({ cmd: 'seek', sec: 'x' });
  check('spotify bridge (page): a bad seek does nothing', Number(range.__v) === 100000, '');

  // ---- search and play through the page's router ----
  const row = (id, title, artists, dur) => el({ sub: { 'a[href^="/track/"]': el({ textContent: title, attrs: { href: `/track/${id}` } }), 'a[href^="/artist/"]': artists.map((a) => el({ textContent: a })), 'div, span': [el({ textContent: dur })], img: el({ src: ART }) } });
  const rows = [row('4uLU6hMCjMI75M1A2tKUQC', 'Shake It Off', ['Taylor Swift'], '3:39'), row('abc123', 'Shake It Off (Live)', ['Taylor Swift', 'Guest'], '4:01')];
  const albumLink = el({ textContent: '1989', attrs: { href: '/album/2QJmrSgbdM35R67eoGQo4j?si=x' }, sub: { img: el({ src: ART, alt: '1989' }) } });
  const artistLink = el({ textContent: 'Taylor Swift', attrs: { href: '/artist/06HL4z0CvFAxyc27GXpf02' } });
  const hq = harness({ dom: { '[data-testid="control-button-playpause"]': bar('Play'), '[data-testid="tracklist-row"]': rows, 'a[href^="/album/"]': albumLink, 'a[href^="/artist/"]': artistLink } });
  hq.out.length = 0;
  hq.send({ cmd: 'search', term: 'shake it / off?', rid: 7 });
  hq.advance(1000);
  const list = hq.out.find((x) => x.t === 'list');
  check('spotify bridge (page): search goes to the page\'s own search route (the term encoded, no reload) and reads the song rows, album and artist links', hq.pushed[0] === '/search/shake%20it%20%2F%20off%3F' && hq.events.includes('popstate') && list && list.rid === 7 && list.ok === true, JSON.stringify([hq.pushed, hq.events, hq.out]));
  const parsedList = SPB.parseMessage(JSON.stringify(list));
  check('spotify bridge (page): the results it sends are songs (title, artists, length, picture), then the album and the artist, and parse', parsedList.items.length >= 4 && parsedList.items[0].kind === 'song' && parsedList.items[0].title === 'Shake It Off' && parsedList.items[0].sub === 'Taylor Swift' && parsedList.items[0].ms === 219000 && parsedList.items[1].sub === 'Taylor Swift, Guest' && parsedList.items.some((i) => i.kind === 'album' && i.id === '2QJmrSgbdM35R67eoGQo4j' && i.title === '1989') && parsedList.items.some((i) => i.kind === 'artist' && i.id === '06HL4z0CvFAxyc27GXpf02'), JSON.stringify(parsedList.items));
  const footerArtist = el({ textContent: 'Now Playing Artist', attrs: { href: '/artist/FOOTERFOOTERFOOTER1' }, closest: () => ({}) });
  const hf = harness({ dom: { '[data-testid="control-button-playpause"]': bar('Play'), '[data-testid="tracklist-row"]': rows, 'a[href^="/artist/"]': [footerArtist, artistLink] } });
  hf.out.length = 0;
  hf.send({ cmd: 'search', term: 'x', rid: 1 });
  hf.advance(1000);
  check('spotify bridge (page): links inside the playbar are not search results (the now-playing artist is not an "Artists" hit)', (() => { const l = SPB.parseMessage(JSON.stringify(hf.out.find((x) => x.t === 'list'))); return l.items.some((i) => i.id === '06HL4z0CvFAxyc27GXpf02') && !l.items.some((i) => i.id === 'FOOTERFOOTERFOOTER1'); })(), JSON.stringify(hf.out));
  const none = harness({ dom: { '[data-testid="control-button-playpause"]': bar('Play') } });
  none.out.length = 0;
  none.send({ cmd: 'search', term: 'zzz', rid: 8 });
  none.advance(8000);
  check('spotify bridge (page): a search page that never shows rows (signed out, or a changed page) ends with ok: false and no items, not a hang', (() => { const l = none.out.find((x) => x.t === 'list'); return l && l.ok === false && l.items.length === 0 && l.rid === 8; })(), JSON.stringify(none.out));
  const playBtn = el();
  const hp = harness({ dom: { '[data-testid="control-button-playpause"]': bar('Play'), '[data-testid="play-button"]': playBtn } });
  hp.send({ cmd: 'playItem', kind: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' });
  hp.advance(1000);
  check('spotify bridge (page): playItem goes to that item\'s own page by the router and clicks its play button', hp.pushed[0] === '/playlist/37i9dQZF1DXcBWIGoYBM5M' && playBtn.clicks === 1, JSON.stringify([hp.pushed, playBtn.clicks]));
  hp.send({ cmd: 'playItem', kind: 'song', id: 'a b' }); hp.send({ cmd: 'playItem', kind: 'station', id: '1' }); hp.send({ cmd: 'playItem', kind: 'song', id: '../x' });
  hp.advance(1000);
  check('spotify bridge (page): a bad kind or id navigates nowhere', hp.pushed.length === 1, JSON.stringify(hp.pushed));
  const hno = harness({ dom: { '[data-testid="control-button-playpause"]': bar('Play') } });
  hno.out.length = 0;
  hno.send({ cmd: 'playItem', kind: 'song', id: '4uLU6hMCjMI75M1A2tKUQC' });
  hno.advance(8000);
  check('spotify bridge (page): when the page shows no play button it says so (an error message), instead of nothing', hno.out.some((x) => x.t === 'error' && /play button/.test(x.message)), JSON.stringify(hno.out));

  // ---- it makes no request and reads no token ----
  check('spotify bridge (page): the page script has no way out: it is given no fetch, XHR, storage or cookie access in its test context and still works', Object.keys(h1.ctx).every((k) => !/fetch|XMLHttpRequest|localStorage|cookie/i.test(k)), Object.keys(h1.ctx).join());
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
