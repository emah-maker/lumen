// The Apple Music widget's Status mode, without Electron, PowerShell or osascript: the pure part (which media session is
// Apple's, what the helper and osascript print, the card's states, the constant scripts), the process part against a fake
// helper and a fake osascript (features/apple-music-native.js), and the connector (default mode, art off, buttons, "Open").
// Runs on its own (npm run test:units picks up test/*-units.js).
const { EventEmitter } = require('events');
const AMV = require('../src/features/apple-music-view');
const { createNowPlaying } = require('../src/features/apple-music-native');
const { createWidgets } = require('../src/features/widgets');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const AM_ID = 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App';
const IT_ID = 'AppleInc.iTunes_nzyj5cx40ttqa!iTunes';
const sess = (extra = {}) => ({ id: AM_ID, status: 'playing', title: 'Night Shift', artist: 'Ann', album: 'Quiet Hours', posMs: 30000, endMs: 200000, thumb: '', ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake PowerShell helper: lines in, lines out.
function fakeHelper() {
  const h = new EventEmitter();
  h.stdout = new EventEmitter();
  h.stdout.setEncoding = () => {};
  h.written = [];
  h.stdin = Object.assign(new EventEmitter(), { write: (t) => { h.written.push(t); return true; }, end: () => { h.ended = true; } });
  h.killed = false;
  h.kill = () => { h.killed = true; h.emit('exit', 0); };
  h.send = (obj) => h.stdout.emit('data', `${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n`);
  return h;
}

module.exports = async function appleMusicStatusUnits(check) {
  // ---- mode and config ----
  check('apple status: the default mode is status; web is kept; anything else is status', AMV.cleanMode({}) === 'status' && AMV.cleanMode(null) === 'status' && AMV.cleanMode({ mode: 'web' }) === 'web' && AMV.cleanMode({ mode: 'status' }) === 'status' && AMV.cleanMode({ mode: '<x>' }) === 'status', '');
  check('apple status: album art is on unless switched off', AMV.cleanConfig({}).art === true && AMV.cleanConfig({ art: false }).art === false && AMV.cleanConfig({ art: 'no' }).art === true, '');

  // ---- which session is Apple's ----
  const yes = [AM_ID, IT_ID, 'iTunes.exe', 'AppleMusic.exe', 'appleinc.applemusicwin_xyz!App', 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App'];
  const no = ['AppleInc.AppleTVWin_nzyj5cx40ttqa!App', 'MSEdge', 'Spotify.exe', 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify', 'Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic', 'AppleInc.iCloud_nzyj5cx40ttqa!iCloud', 'NotAppleInc.AppleMusicWin_x!App', 'fakeiTunes.exe', '', null, undefined, 5, 'A'.repeat(400)];
  check('apple status: Apple Music and iTunes sessions are recognized', yes.every(AMV.isAppleAumid), yes.filter((x) => !AMV.isAppleAumid(x)).join(' '));
  check('apple status: Apple TV, a browser, Spotify, Groove, iCloud and look-alikes are not', no.every((x) => !AMV.isAppleAumid(x)), no.filter((x) => AMV.isAppleAumid(x)).join(' '));
  check('apple status: the helper script filters with the same pattern', AMV.WINDOWS_HELPER.includes(AMV.AUMID_SOURCE), '');
  check('apple status: only Apple sessions are picked (any: a stand-in app in tests)', AMV.pickSession([{ id: 'MSEdge', status: 'playing' }]) === null && AMV.pickSession([{ id: 'MSEdge', status: 'playing' }], { any: true }).id === 'MSEdge' && AMV.pickSession([]) === null && AMV.pickSession(null) === null, '');
  check('apple status: a playing session wins, then Apple Music before iTunes', AMV.pickSession([sess({ id: IT_ID, status: 'paused' }), sess({ status: 'paused' })]).id === AM_ID && AMV.pickSession([sess({ status: 'paused' }), sess({ id: IT_ID })]).id === IT_ID, '');

  // ---- the card, Windows ----
  const NOW = 1e12;
  const play = AMV.fromWindows({ sessions: [sess()], installed: true }, NOW, { art: 'data:image/jpeg;base64,AAAA' });
  check('apple status: playing -> title, artist, album, progress, length, source and art', play.mode === 'status' && play.state === 'playing' && play.title === 'Night Shift' && play.artist === 'Ann' && play.album === 'Quiet Hours' && play.progressMs === 30000 && play.durationMs === 200000 && play.at === NOW && play.source === 'Apple Music' && play.art === 'data:image/jpeg;base64,AAAA', JSON.stringify(play));
  check('apple status: paused, and iTunes is named', AMV.fromWindows({ sessions: [sess({ status: 'paused' })] }, NOW).state === 'paused' && AMV.fromWindows({ sessions: [sess({ id: IT_ID })] }, NOW).source === 'iTunes', '');
  check('apple status: stopped with a track stays on the card (paused); stopped with nothing is idle', AMV.fromWindows({ sessions: [sess({ status: 'stopped' })] }, NOW).state === 'paused' && AMV.fromWindows({ sessions: [sess({ status: 'stopped', title: '' })] }, NOW).state === 'idle' && AMV.fromWindows({ sessions: [sess({ status: 'other', title: '' })] }, NOW).state === 'idle', '');
  check('apple status: no Apple session and the app installed (or not known yet) is idle, "not-running"', AMV.fromWindows({ sessions: [], installed: true }, NOW).state === 'idle' && AMV.fromWindows({ sessions: [], installed: true }, NOW).reason === 'not-running' && AMV.fromWindows({ sessions: [], installed: null }, NOW).state === 'idle' && AMV.fromWindows({ sessions: [{ id: 'MSEdge', status: 'playing', title: 'x' }], installed: true }, NOW).state === 'idle', '');
  check('apple status: no session and the app not installed says so', AMV.fromWindows({ sessions: [], installed: false }, NOW).state === 'unavailable' && AMV.fromWindows({ sessions: [], installed: false }, NOW).reason === 'not-installed', '');
  check('apple status: the progress never passes the end, and a missing length is 0', AMV.fromWindows({ sessions: [sess({ posMs: 999999 })] }, NOW).progressMs === 200000 && AMV.fromWindows({ sessions: [sess({ endMs: 0 })] }, NOW).durationMs === 0, '');
  const dirty = AMV.fromWindows({ sessions: [sess({ title: ' Song\u0000\n <b>One</b> ', artist: 'A'.repeat(500) })] }, NOW);
  check('apple status: text is flattened and bounded (markup stays text)', dirty.title === 'Song <b>One</b>' && dirty.artist.length === 120, JSON.stringify(dirty.title));

  // ---- the helper's lines ----
  const good = AMV.parseHelperLine(JSON.stringify({ t: 'sessions', list: [{ id: AM_ID, status: 'playing', title: 'T', artist: 'A', album: 'B', posMs: 1.4, endMs: 5000, thumb: 'QUJD' }] }));
  check('apple status: a sessions line is parsed and bounded', good.t === 'sessions' && good.list.length === 1 && good.list[0].thumb === 'QUJD' && good.list[0].posMs === 1, JSON.stringify(good));
  check('apple status: junk lines, unknown kinds, bad thumbnails and bad statuses are dropped or neutral', ['', 'nope', '[]', 'null', '{"t":"x"}', '{"t":"sessions"}'].every((l) => AMV.parseHelperLine(l) === null) && AMV.parseHelperLine(JSON.stringify({ t: 'sessions', list: [{ id: 'x', status: 'weird', thumb: 'a b<script>' }] })).list[0].thumb === '' && AMV.parseHelperLine(JSON.stringify({ t: 'sessions', list: [{ id: 'x', status: 'weird' }] })).list[0].status === 'other' && AMV.parseHelperLine(JSON.stringify({ t: 'sessions', list: [{ status: 'playing' }, null, 5] })).list.length === 0, '');
  check('apple status: hello keeps a well-formed launch id only', AMV.parseHelperLine('{"t":"hello","installed":true,"launchId":"AppleInc.AppleMusicWin_nzyj5cx40ttqa!App"}').launchId === AM_ID && AMV.parseHelperLine('{"t":"hello","installed":true,"launchId":"x; calc.exe"}').launchId === '' && AMV.parseHelperLine('{"t":"hello","installed":false,"launchId":null}').installed === false, '');
  check('apple status: an ack names a known button only', AMV.parseHelperLine('{"t":"ack","cmd":"pause","ok":true}').ok === true && AMV.parseHelperLine('{"t":"ack","cmd":"format","ok":true}').cmd === '', '');
  check('apple status: only 12 sessions are read', AMV.parseHelperLine(JSON.stringify({ t: 'sessions', list: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}` })) })).list.length === 12, '');
  const sig = (d) => AMV.signature(d);
  check('apple status: the signature ignores the moving playhead but sees a new track, a pause and new art', sig(AMV.fromWindows({ sessions: [sess({ posMs: 1000 })] }, 1)) === sig(AMV.fromWindows({ sessions: [sess({ posMs: 90000 })] }, 2)) && sig(AMV.fromWindows({ sessions: [sess()] }, 1)) !== sig(AMV.fromWindows({ sessions: [sess({ title: 'Other' })] }, 1)) && sig(AMV.fromWindows({ sessions: [sess()] }, 1)) !== sig(AMV.fromWindows({ sessions: [sess({ status: 'paused' })] }, 1)) && sig(AMV.fromWindows({ sessions: [sess()] }, 1)) !== sig(AMV.fromWindows({ sessions: [sess()] }, 1, { art: 'data:image/png;base64,AA' })), '');

  // ---- the card, macOS ----
  const mac = (o) => JSON.stringify({ running: true, state: 'playing', position: 31.5, track: { name: 'Night Shift', artist: 'Ann', album: 'Quiet Hours', duration: 200.25 }, ...o });
  const m1 = AMV.fromMac(mac(), NOW, { art: 'data:image/jpeg;base64,AAAA' });
  check('apple status (mac): playing -> seconds become milliseconds, source is Music', m1.state === 'playing' && m1.title === 'Night Shift' && m1.progressMs === 31500 && m1.durationMs === 200250 && m1.source === 'Music' && m1.art.startsWith('data:image/jpeg'), JSON.stringify(m1));
  check('apple status (mac): paused; stopped, no track or not running is idle', AMV.fromMac(mac({ state: 'paused' }), NOW).state === 'paused' && AMV.fromMac(mac({ state: 'stopped' }), NOW).state === 'idle' && AMV.fromMac(mac({ track: null }), NOW).state === 'idle' && AMV.fromMac(JSON.stringify({ running: false }), NOW).reason === 'not-running', '');
  check('apple status (mac): permission refused, a failed run and junk are told apart', AMV.fromMac('', NOW, { denied: true }).reason === 'denied' && AMV.fromMac('', NOW, { failed: true }).reason === 'error' && AMV.fromMac('garbage', NOW, { failed: true }).state === 'unavailable' && AMV.fromMac('garbage', NOW).state === 'idle', '');
  check('apple status (mac): error -1743 and "not authorized" mean denied; other errors do not', AMV.isDenied('execution error: Not authorized to send Apple events to Music. (-1743)') && AMV.isDenied('x -1743 y') && !AMV.isDenied('syntax error') && !AMV.isDenied(''), '');
  check('apple status (mac): the playhead is capped at the length', AMV.fromMac(mac({ position: 9999 }), NOW).progressMs === 200250, '');

  // ---- the scripts are constants ----
  check('apple status: every button has a script of its own, and none takes input', ['play', 'pause', 'next', 'previous'].every((a) => typeof AMV.MAC_CONTROL[a] === 'string' && /running\(\)/.test(AMV.MAC_CONTROL[a])) && Object.keys(AMV.MAC_CONTROL).length === 4 && AMV.ACTIONS.join() === 'play,pause,next,previous', '');
  check('apple status: reading and the buttons never launch Music (they check running() first)', /running\(\)/.test(AMV.MAC_READ) && Object.values(AMV.MAC_CONTROL).every((s) => /!app\.running\(\)\) return 'not-running'; app\.\w+\(\)/.test(s)), '');
  check('apple status: no script has a template hole or reads input (the artwork one only takes its argument)', [AMV.MAC_READ, ...Object.values(AMV.MAC_CONTROL), AMV.WINDOWS_HELPER, AMV.MAC_ARTWORK.join('\n')].every((s) => !s.includes('${')) && !/argv/.test(AMV.WINDOWS_HELPER) && AMV.MAC_ARTWORK.join('\n').includes('item 1 of argv'), '');
  check('apple status: the Windows helper uses the media-session calls and the encoded command round-trips', /TryPlayAsync/.test(AMV.WINDOWS_HELPER) && /TryPauseAsync/.test(AMV.WINDOWS_HELPER) && /TrySkipNextAsync/.test(AMV.WINDOWS_HELPER) && /TrySkipPreviousAsync/.test(AMV.WINDOWS_HELPER) && /GlobalSystemMediaTransportControlsSessionManager/.test(AMV.WINDOWS_HELPER) && Buffer.from(AMV.windowsHelperArgs().at(-1), 'base64').toString('utf16le') === AMV.WINDOWS_HELPER && AMV.windowsHelperArgs().includes('-NoProfile'), '');
  check('apple status: a button name is taken from the fixed list only', AMV.actionOf('pause') === 'pause' && AMV.actionOf('open') === null && AMV.actionOf('__proto__') === null && AMV.actionOf('pause; calc') === null && AMV.actionOf(undefined) === null, '');

  // ---- the process part: Windows, against a fake helper ----
  {
    const helpers = [];
    let changes = 0;
    const killedAll = () => helpers.every((h) => h.killed);
    const np = createNowPlaying({
      platform: 'win32', spawn: (cmd, args) => { const h = fakeHelper(); h.cmd = cmd; h.args = args; helpers.push(h); return h; },
      resizeArt: (b) => b, onChange: () => { changes++; },
    });
    const first = np.read();
    await sleep(5);
    check('apple status (win): the helper is PowerShell with an encoded command, started on the first read', helpers.length === 1 && /powershell/i.test(helpers[0].cmd) && helpers[0].args.includes('-EncodedCommand'), String(helpers[0]?.cmd));
    helpers[0].send({ t: 'sessions', list: [sess({ thumb: PNG.toString('base64') })] });
    helpers[0].send({ t: 'hello', installed: true, launchId: AM_ID });
    const d1 = await first;
    check('apple status (win): the first read answers from the first picture, art made small and as a data: URL', d1.state === 'playing' && d1.title === 'Night Shift' && /^data:image\/png;base64,/.test(d1.art), JSON.stringify(d1).slice(0, 200));
    check('apple status (win): a second read does not start another helper', (await np.read()).state === 'playing' && helpers.length === 1, String(helpers.length));
    const c0 = changes;
    helpers[0].send({ t: 'sessions', list: [sess({ thumb: PNG.toString('base64'), posMs: 99000 })] });
    check('apple status (win): a moved playhead is not a change', changes === c0, `${changes} ${c0}`);
    helpers[0].send({ t: 'sessions', list: [sess({ status: 'paused', thumb: '' })] });
    check('apple status (win): a pause tells the card to look again, once', changes === c0 + 1, `${changes} ${c0}`);
    helpers[0].send({ t: 'sessions', list: [sess({ status: 'paused', title: 'Next One', thumb: '' })] });
    check('apple status (win): a new track tells the card again (and has no art when the helper sent none)', changes === c0 + 2 && (await np.read()).art === '', `${changes}`);

    const pressed = np.control('next');
    await sleep(5);
    const sent = JSON.parse(helpers[0].written.at(-1));
    check('apple status (win): a button writes one JSON line naming a session the helper itself reported', sent.cmd === 'next' && sent.id === AM_ID && helpers[0].written.at(-1).endsWith('\n'), helpers[0].written.at(-1));
    helpers[0].send({ t: 'ack', cmd: 'next', ok: true });
    check('apple status (win): …and resolves true when the helper acknowledges', (await pressed) === true, '');
    const refused = np.control('pause');
    await sleep(5);
    helpers[0].send({ t: 'ack', cmd: 'pause', ok: false });
    check('apple status (win): a refused button resolves false', (await refused) === false, '');
    const before = helpers[0].written.length;
    check('apple status (win): an unknown button writes nothing', (await np.control('delete')) === false && (await np.control('')) === false && helpers[0].written.length === before, '');

    // "Open Apple Music" launches by the app's id, validated; anything else says web
    const spawned = [];
    const np2 = createNowPlaying({ platform: 'win32', spawn: (cmd, args) => { if (/explorer/i.test(cmd)) { spawned.push([cmd, args]); return Object.assign(new EventEmitter(), { unref() {} }); } const h = fakeHelper(); queueMicrotask(() => { h.send({ t: 'sessions', list: [] }); h.send({ t: 'hello', installed: true, launchId: AM_ID }); }); helpers.push(h); return h; } });
    await np2.read();
    check('apple status (win): "Open" starts the app through explorer with its start-menu id', (await np2.open()) === 'opened' && spawned.length === 1 && spawned[0][1][0] === `shell:AppsFolder\\${AM_ID}`, JSON.stringify(spawned));
    np2.destroy();
    const np3 = createNowPlaying({ platform: 'win32', spawn: () => { const h = fakeHelper(); queueMicrotask(() => { h.send({ t: 'sessions', list: [] }); h.send({ t: 'hello', installed: false, launchId: null }); }); helpers.push(h); return h; } });
    const none = await np3.read();
    check('apple status (win): not installed says so, and "Open" answers web (the caller opens music.apple.com)', none.state === 'unavailable' && none.reason === 'not-installed' && (await np3.open()) === 'web', JSON.stringify(none));
    np3.destroy();

    np.destroy();
    check('apple status (win): quitting ends the helper (stdin closed and killed)', helpers[0].ended === true && helpers[0].killed === true && killedAll(), '');
    const after = await np.read();
    check('apple status (win): after destroy nothing is started again', helpers.length === 5 || after.state === 'unavailable', String(helpers.length));
  }
  {
    // a helper that dies at once: reads answer "error" instead of hanging
    const np = createNowPlaying({ platform: 'win32', spawn: () => { const h = fakeHelper(); queueMicrotask(() => h.emit('exit', 1)); return h; } });
    const d = await np.read();
    check('apple status (win): a helper that dies at once gives an error card, not a hang', d.state === 'unavailable' && d.reason === 'error', JSON.stringify(d));
    np.destroy();
  }
  {
    // not Windows or macOS
    const np = createNowPlaying({ platform: 'linux' });
    check('apple status: on another system the card says it is not supported', (await np.read()).reason === 'unsupported' && (await np.control('play')) === false && (await np.open()) === 'web', '');
  }

  // ---- the process part: macOS, against a fake osascript ----
  {
    const calls = [];
    let reply = { ok: true, stdout: mac(), stderr: '' };
    let artReply = 'ok';
    let removed = 0;
    const execFile = (cmd, args, opts, cb) => {
      calls.push([cmd, args]);
      if (cmd === 'open') { cb(null, '', ''); return; }
      const script = args.join('\n');
      if (script.includes('raw data of artwork')) { cb(null, artReply, ''); return; }
      if (reply.ok) cb(null, reply.stdout, ''); else cb(Object.assign(new Error('x'), { code: 1 }), '', reply.stderr);
    };
    const np = createNowPlaying({ platform: 'darwin', execFile, resizeArt: (b) => b, readFile: async () => PNG, rm: async () => { removed++; } });
    const d = await np.read();
    check('apple status (mac): a read runs the fixed JXA script through osascript', calls[0][0] === 'osascript' && calls[0][1].join(' ').includes('JavaScript') && calls[0][1].includes(AMV.MAC_READ) && d.state === 'playing' && d.title === 'Night Shift', JSON.stringify(calls[0]).slice(0, 200));
    check('apple status (mac): the artwork comes through a temp file (path as the script\'s argument), is made small, and the file is removed', /^data:image\/png;base64,/.test(d.art) && removed === 1 && calls.some((c) => c[1].at(-1).includes('lumen-apple-music-art') && c[1].includes('on run argv')), d.art.slice(0, 40));
    const n = calls.length;
    await np.read();
    check('apple status (mac): the same track\'s artwork is not fetched again', calls.slice(n).every((c) => !c[1].join(' ').includes('raw data of artwork')), '');
    reply = { ok: true, stdout: mac({ track: { name: 'Another', artist: 'Bo', album: 'Two', duration: 100 } }), stderr: '' };
    artReply = 'none';
    const d2 = await np.read();
    check('apple status (mac): a track without artwork has none', d2.title === 'Another' && d2.art === '', JSON.stringify(d2).slice(0, 120));
    check('apple status (mac): a button runs its own constant script, and never launches Music', (await (async () => { reply = { ok: true, stdout: 'ok', stderr: '' }; return np.control('pause'); })()) === true && calls.at(-1)[1].includes(AMV.MAC_CONTROL.pause) && (await np.control('rm -rf')) === false, JSON.stringify(calls.at(-1)).slice(0, 120));
    reply = { ok: true, stdout: 'not-running', stderr: '' };
    check('apple status (mac): a button with Music closed does nothing and says so (false)', (await np.control('play')) === false, '');
    reply = { ok: false, stdout: '', stderr: 'execution error: Not authorized to send Apple events to Music. (-1743)' };
    const denied = await np.read();
    check('apple status (mac): permission refused gives the denied card', denied.state === 'unavailable' && denied.reason === 'denied', JSON.stringify(denied).slice(0, 120));
    let msg = '';
    await np.control('play').catch((e) => { msg = e.message; });
    check('apple status (mac): a refused button explains where to allow it', /System Settings/.test(msg) && /Automation/.test(msg), msg);
    check('apple status (mac): "Open" runs open -a Music (a fixed argument list)', (await np.open()) === 'opened' && calls.at(-1)[0] === 'open' && calls.at(-1)[1].join(' ') === '-a Music', JSON.stringify(calls.at(-1)));
    np.destroy();
  }

  // ---- the connector ----
  {
    let settings = {};
    const fake = { state: 'playing', reads: 0, pressed: [], opened: 0, openResult: 'opened', press: true };
    const card = (extra = {}) => ({ mode: 'status', state: fake.state, title: 'Night Shift', artist: 'Ann', album: 'Quiet Hours', progressMs: 30000, durationMs: 200000, at: Date.now(), source: 'Apple Music', kind: 'track', reason: '', art: 'data:image/jpeg;base64,AAAA', ...extra });
    let tabs = [];
    const w = createWidgets({
      readSettings: () => settings, writeSettings: (s) => { settings = JSON.parse(JSON.stringify(s)); },
      fetch: async () => { throw new Error('the Status card must not use the network'); },
      getSecret: () => null, setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}),
      appleMusic: { read: async () => { fake.reads++; return card(); }, control: async (n) => { fake.pressed.push(n); return fake.press; }, open: async () => { fake.opened++; return fake.openResult; } },
      openWebTab: (u) => tabs.push(u),
    });
    const saved = await w.save({ type: 'applemusic' }).catch((e) => ({ error: e.message }));
    const id = w.list()[0]?.id;
    check('apple status: a new card is in status mode with art on, no key, no network', !saved.error && w.list()[0].mode === 'status' && w.list()[0].art === true, saved.error || JSON.stringify(w.list()[0]));
    await w.refresh(w.list()[0]);
    const get = () => w.forPage().find((c) => c.id === id);
    check('apple status: the card data is what the app says (art included)', get().data.state === 'playing' && get().data.title === 'Night Shift' && get().data.art.startsWith('data:image/jpeg') && fake.reads === 1, JSON.stringify(get().data).slice(0, 150));
    check('apple status: the Settings summary says now playing', /now playing/i.test(w.state().widgets.find((x) => x.id === id).summary) && w.state().widgets.find((x) => x.id === id).mode === 'status', '');
    await w.act({ id, do: 'pause' });
    check('apple status: Pause presses the app\'s Pause and shows paused at once', fake.pressed.join() === 'pause' && get().data.state === 'paused', JSON.stringify(fake.pressed));
    await w.act({ id, do: 'next' });
    await w.act({ id, do: 'previous' });
    check('apple status: Next and Previous press the app\'s buttons', fake.pressed.join() === 'pause,next,previous', fake.pressed.join());
    check('apple status: an unknown action does nothing', (await w.act({ id, do: 'format' })) === false && fake.pressed.length === 3, '');
    fake.press = false;
    await w.act({ id, do: 'play' });
    check('apple status: a button the app didn\'t take shows a notice on the card', /didn.t answer/.test(get().data.notice || ''), JSON.stringify(get().data.notice));
    fake.press = true;
    check('apple status: the page action list accepts do=open, play, pause, next and previous', ['open', 'play', 'pause', 'next', 'previous'].every((a) => w.actionFrom(`file:///newtab.html?widget=${id}&do=${a}`)?.do === a), '');
    check('apple status: Open starts the app', (await w.act({ id, do: 'open' })) === true && fake.opened === 1 && tabs.length === 0, '');
    fake.openResult = 'web';
    await w.act({ id, do: 'open' });
    check('apple status: with no app installed, Open opens the web player in a tab and says so', tabs.join() === 'https://music.apple.com/' && /web player/.test(get().data.notice || ''), JSON.stringify([tabs, get().data.notice]));
    check('apple status: "Try again" (do=reload) belongs to the web player only', (await w.act({ id, do: 'reload' })) === false, '');
    await sleep(400);
    const reads = fake.reads;
    w.appleMusicChanged();
    await sleep(20);
    check('apple status: when the app changes, the status card is fetched again at once', fake.reads > reads, `${reads} -> ${fake.reads}`);
    await w.save({ type: 'applemusic', art: false }, id);
    await w.refresh(w.list()[0], { force: true });
    check('apple status: art switched off sends none', get().data.art === '' && w.list()[0].art === false, JSON.stringify(get().data).slice(0, 100));
    await w.save({ type: 'applemusic', mode: 'web' }, id);
    const r2 = fake.reads;
    await w.refresh(w.list()[0], { force: true });
    w.appleMusicChanged();
    check('apple status: in web mode the card is the web player\'s and the app is not read', get().data.mode === 'web' && fake.reads === r2, JSON.stringify(get().data));
  }
  {
    let st = {};
    const w = createWidgets({ readSettings: () => st, writeSettings: (s) => { st = JSON.parse(JSON.stringify(s)); }, fetch: async () => { throw new Error('no'); }, getSecret: () => null, setSecret: () => {}, onUpdate: () => {}, endpoints: () => ({}) });
    await w.save({ type: 'applemusic' });
    await w.refresh(w.list()[0]);
    check('apple status: with no now-playing source (another system) the card says unsupported', w.forPage()[0].data.state === 'unavailable' && w.forPage()[0].data.reason === 'unsupported', JSON.stringify(w.forPage()[0].data));
  }
};

if (require.main === module) {
  let failed = 0;
  let total = 0;
  module.exports((name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } })
    .then(() => { console.log(`${total - failed}/${total} passed`); process.exit(failed ? 1 : 0); })
    .catch((err) => { console.error(err); process.exit(1); });
}
