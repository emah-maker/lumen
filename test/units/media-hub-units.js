// Pure unit test for media controls (features/media-hub.js): a page's report is parsed and capped (it comes from the page), frames merge,
// commands reach the right frame, the list puts the last-played tab first, and the media keys are held only while something can play,
// always for the last-played page. Fake webContents and frames stand in for Electron's.
const { EventEmitter } = require('events');
const MH = require('../../src/features/media-hub');

let failed = 0;
const check = (label, ok, detail = '') => { if (!ok) { failed++; console.error(`FAIL ${label} ${detail}`); } else console.log(`ok   ${label}`); };

// ---- parseReport
{
  const r = MH.parseReport(JSON.stringify({ playing: true, resumable: 'yes', meta: { title: 'x'.repeat(900), artist: ' A ', artwork: 'javascript:alert(1)' }, actions: ['nexttrack', 'seekto', 'play'] }));
  check('report: playing kept, a non-boolean resumable is false', r.playing === true && r.resumable === false);
  check('report: title capped at 300 characters, artist trimmed', r.title.length === 300 && r.artist === 'A');
  check('report: artwork only http(s) or data:image', r.artwork === '' && MH.parseReport('{"meta":{"artwork":"https://a.example/x.png"}}').artwork === 'https://a.example/x.png');
  check('report: only known actions', r.actions.join() === 'play,nexttrack');
  check('report: junk is refused', MH.parseReport('nope') === null && MH.parseReport(42) === null && MH.parseReport('x'.repeat(20000)) === null);
}

// ---- a fake world
let clock = 1000;
const sent = [];
const frame = (pid, rid) => ({ processId: pid, routingId: rid, send: (ch, a) => sent.push(`${pid}:${rid}:${a}`), isDestroyed: () => false });
const page = (id) => { const wc = new EventEmitter(); wc.isDestroyed = () => false; wc.mainFrame = frame(id, 1); wc.tabId = id; return wc; };
const tabsById = new Map();
const muted = new Set();
const shown = [];
const held = new Set();
let pushed = null;
const hub = MH.create({
  tabOf: (wc) => (wc.tabId ? tabsById.get(wc.tabId) || null : null),
  tabFields: (t) => ({ id: t.id, title: t.title, favicon: '', muted: muted.has(t.id) }),
  setMuted: (t, m) => (m ? muted.add(t.id) : muted.delete(t.id)),
  show: (t) => shown.push(t.id),
  onList: (l) => { pushed = l; },
  keys: { register: (n) => held.add(n), unregister: (n) => held.delete(n) },
  now: () => clock,
});
const rep = (wc, f, s) => hub.report({ sender: wc, senderFrame: f }, JSON.stringify(s));
const flush = () => new Promise((r) => setTimeout(r, 90));

(async () => {
  const A = page(1); tabsById.set(1, { id: 1, title: 'Tab A' });
  const B = page(2); tabsById.set(2, { id: 2, title: 'Tab B' });
  const S = page(0); // not a tab: the Spotify card's hidden player
  const embed = frame(1, 7);
  rep(A, A.mainFrame, { playing: false, meta: { title: 'Song' }, actions: ['nexttrack'] });
  rep(A, embed, { playing: true, meta: {}, actions: [] });
  await flush();
  check('list: a tab whose embed plays is listed, with the top frame\'s title and its next-track', hub.list().length === 1 && hub.list()[0].title === 'Song' && hub.list()[0].canNext && hub.list()[0].playing, JSON.stringify(hub.list()));
  check('list: pushed to the windows', pushed && pushed.length === 1);
  check('keys: held while something plays', held.size === 4, [...held].join());

  clock = 2000;
  rep(B, B.mainFrame, { playing: true, meta: {}, actions: [] });
  await flush();
  check('list: the last to start playing comes first, under its tab title', hub.list()[0].id === 2 && hub.list()[0].title === 'Tab B', JSON.stringify(hub.list()));

  sent.length = 0;
  hub.act(1, 'nexttrack');
  check('act: next goes to the frame whose page set it', sent.join() === '1:1:nexttrack', sent.join());
  sent.length = 0;
  hub.act(1, 'pause');
  check('act: pause goes to every playing frame', sent.join() === '1:7:pause', sent.join());
  hub.act(1, 'mute');
  check('act: mute toggles the tab\'s own mute', muted.has(1));
  hub.act(2, 'show');
  check('act: show goes to the tab', shown.join() === '2');
  check('act: an unknown action is refused', hub.act(1, 'eval') === false);

  sent.length = 0;
  hub.mediaKey('MediaPlayPause');
  check('keys: play/pause goes to the last-played page (B): pause, as it plays', sent.join() === '2:1:pause', sent.join());
  rep(B, B.mainFrame, { playing: false, resumable: true, meta: {}, actions: [] });
  sent.length = 0;
  hub.mediaKey('MediaPlayPause');
  check('keys: pressed again it plays the paused page', sent.join() === '2:1:play', sent.join());

  clock = 3000;
  rep(S, S.mainFrame, { playing: true, meta: { title: 'Card' }, actions: ['nexttrack'] });
  await flush();
  check('list: a page that is not a tab is not listed', !hub.list().some((x) => x.title === 'Card'));
  sent.length = 0;
  hub.mediaKey('MediaNextTrack');
  check('keys: ...but the media keys reach it when it played last', sent.join() === '0:1:nexttrack', sent.join());

  B.emit('did-navigate');
  A.emit('did-frame-navigate', {}, 'u', 200, 'OK', false, 1, 7);
  S.emit('destroyed');
  await flush();
  check('navigation drops a page\'s report, a navigated embed drops its own', !hub.list().some((x) => x.id === 2) && !hub.list().some((x) => x.id === 1), JSON.stringify(hub.list()));
  check('keys: let go once nothing can play', held.size === 0, [...held].join());
  check('keys: an unknown key does nothing', hub.mediaKey('VolumeUp') === false);

  console.log(failed ? `\n${failed} failed` : '\nmedia-hub units: all passed');
  process.exit(failed ? 1 : 0);
})();
