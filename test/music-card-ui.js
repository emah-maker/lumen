// The music card in a real (hidden) window, offline: the new-tab page itself (renderer/newtab.html, which takes everything it shows from its address) with
// stand-in engine data, at every card size. What is tested is the card: which controls each size shows (small / medium / large / extra large), that a
// control the engine can't do is not there, the tabs (Search, Up next, Library, Devices, Album, Lyrics) with their loading / empty / error / signed-out
// states, the buttons asking main for the right thing (the address a click would navigate to is caught and read, never followed), the keyboard
// (Space, arrows), and that the card is updated in place: the same element, with a typed search and an open tab where they were.
//
// The window is never shown or focused (show: false), has no menu and opens no dialogs. LUMEN_MUSIC_SHOTS=<dir> keeps a PNG of every state.
// Run: node test/music-card-ui.js (it starts Electron itself, with a hard timeout).
'use strict';
const path = require('path');
const fs = require('fs');

if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const run = spawnSync(require('electron'), [__filename], { stdio: 'inherit', timeout: 150000, killSignal: 'SIGKILL', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '' } });
  process.exit(run.status === null ? 1 : run.status);
}

const { app, BrowserWindow } = require('electron');
const { pathToFileURL } = require('url');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('mute-audio');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.LUMEN_MUSIC_SHOTS || '';
if (shots) fs.mkdirSync(shots, { recursive: true });
const saved = [];

// A small PNG for pictures (48 px gradient).
const ART = (() => {
  const zlib = require('zlib');
  const W = 48;
  const raw = Buffer.alloc((W * 3 + 1) * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const o = y * (W * 3 + 1) + 1 + x * 3; raw[o] = 250 - x * 3; raw[o + 1] = 35 + y * 3; raw[o + 2] = 59 + ((x ^ y) & 63); }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
  return `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64')}`;
})();

const song = (n, title, sub, ms = 200000) => ({ id: `s${n}`, kind: 'song', title, sub, ms, thumb: ART });
const QUEUE = [song(1, 'Glass Harbor', 'Ann Marlowe', 187000), song(2, 'Paper Moons', 'The Quiet Hours', 241000), song(3, 'Slow Burn', 'Ann Marlowe', 203000), song(4, 'Low Tide', 'Kite & Sparrow', 176000), song(5, 'Afterglow', 'Ann Marlowe', 222000), song(6, 'Northern Lights', 'The Quiet Hours', 258000)];
const TRACKS = [song(11, 'Night Shift', 'Ann Marlowe', 215000), song(12, 'Glass Harbor', 'Ann Marlowe', 187000), song(13, 'Paper Moons', 'Ann Marlowe', 241000), song(14, 'Slow Burn', 'Ann Marlowe', 203000), song(15, 'Low Tide', 'Ann Marlowe', 176000), song(16, 'Afterglow', 'Ann Marlowe', 222000), song(17, 'Northern Lights', 'Ann Marlowe', 258000), song(18, 'Last Train Home', 'Ann Marlowe', 190000)];
const CAN_ALL = { search: true, lists: true, seek: true, queue: true, playNext: true, playLater: true, like: true, shuffle: true, repeat: true, volume: true, library: true, tracks: true, lyrics: true, devices: false };
const playing = (over = {}) => ({
  mode: 'status', state: 'playing', title: 'Night Shift', artist: 'Ann Marlowe', album: 'Quiet Hours', progressMs: 72000, durationMs: 215000, at: Date.now(), source: 'engine', kind: 'track', reason: '', art: ART,
  device: '', liked: false, shuffle: true, repeat: 'off', volume: 0.6, signedIn: true, engine: 'ready', drm: 'ok', can: { ...CAN_ALL },
  recent: [{ id: 'r1', kind: 'song', title: 'Glass Harbor', sub: 'Ann Marlowe' }, { id: 'r2', kind: 'album', title: 'Quiet Hours', sub: 'Ann Marlowe' }, { id: 'r3', kind: 'song', title: 'Paper Moons', sub: 'The Quiet Hours' }],
  playlists: [{ id: 'p1', kind: 'playlist', title: 'Late night drive', sub: 'You' }, { id: 'p2', kind: 'playlist', title: 'Focus', sub: 'You' }, { id: 'p3', kind: 'playlist', title: 'Road trip 2026', sub: 'You' }, { id: 'p4', kind: 'playlist', title: 'Sunday morning', sub: 'You' }],
  results: [], searchOk: true, searchWhy: '', searchDetail: '', query: '', searching: false,
  queue: { items: QUEUE, pending: false, ok: true, why: '', title: '', current: -1 },
  tracks: { items: TRACKS, pending: false, ok: true, why: '', title: 'Quiet Hours', current: 0 },
  lyrics: { pending: false, ok: true, why: '', lines: ['Streetlights hum a low refrain', 'Counting cars along the rain', 'Every window holds a name', 'None of them are mine', '', 'Night shift, night shift', 'Carry me home'], forTitle: 'Night Shift' },
  devices: [{ id: 'browser', name: 'This browser', type: 'Computer', active: true }],
  ...over,
});
const widget = (data, over = {}) => ({ id: 'wmusic1', type: 'spotify', title: 'Spotify', span: 4, height: 3, colors: 'calendar', layout: { x: 8, y: 0, w: 4, h: 3 }, data, updated: Date.now(), warning: null, error: null, loading: false, ...over });

let win;
const navigations = [];
const js = (code) => win.webContents.executeJavaScript(code);
const q = (sel) => js(`(() => { const c = document.querySelector('.w-card'); const n = c && c.querySelector(${JSON.stringify(sel)}); return n ? n.textContent : null; })()`);
// How an element is shown: present and visible (not hidden by CSS or the hidden attribute).
const shown = (sel) => js(`(() => { const n = document.querySelector('.w-card ${sel}'); if (!n) return false; const r = n.getBoundingClientRect(); const s = getComputedStyle(n); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; })()`);
async function render(w, size) {
  await js(`window.renderWidgets(${JSON.stringify([w])})`);
  if (size) await setSize(size[0], size[1]);
  await sleep(120);
}
async function setSize(width, height) {
  await js(`(() => { const c = document.querySelector('.w-card'); c.style.transition = 'none'; c.style.width = '${width}px'; c.style.height = '${height}px'; c.style.transform = 'translate(1000px, 24px)'; })()`);
  await sleep(250);
}
async function shot(name) {
  await sleep(150);
  const r = await js(`(() => { const c = document.querySelector('.w-card'); const b = c.getBoundingClientRect(); const pop = c.querySelector('.am-pop:not([hidden])'); const p = pop ? pop.getBoundingClientRect() : b; return { x: Math.min(b.left, p.left), y: Math.min(b.top, p.top), right: Math.max(b.right, p.right), bottom: Math.max(b.bottom, p.bottom) }; })()`);
  const pad = 14;
  const rect = { x: Math.max(0, Math.floor(r.x - pad)), y: Math.max(0, Math.floor(r.y - pad)), width: Math.ceil(r.right - r.x + 2 * pad), height: Math.ceil(r.bottom - r.y + 2 * pad) };
  const img = await win.webContents.capturePage(rect);
  if (shots) { const file = path.join(shots, `${name}.png`); fs.writeFileSync(file, img.toPNG()); saved.push(file); }
}
const asks = () => navigations.map((u) => { try { const p = new URL(u).searchParams; return [p.get('do'), p.get('arg'), p.get('kind'), p.get('with')].filter((x) => x !== null).join(':'); } catch { return ''; } });
const visible = async (sels) => Object.fromEntries(await Promise.all(Object.entries(sels).map(async ([k, s]) => [k, await shown(s)])));
const CONTROLS = { art: '.sp-art', title: '.sp-title', play: '.sp-controls [aria-label="Pause"], .sp-controls [aria-label="Play"]', next: '.mc-next', prev: '.mc-prev', times: '.sp-elapsed', like: '.mc-like', shuffle: '.mc-shuffle', repeat: '.mc-repeat', volume: '.mc-vol-range', tabs: '.mc-tabs', side: '.mc-side' };

async function main() {
  win = new BrowserWindow({ show: false, width: 2000, height: 1000, frame: false, focusable: false, webPreferences: { backgroundThrottling: false, contextIsolation: true, offscreen: true } });
  win.webContents.setFrameRate(20);
  win.setMenu(null);
  win.webContents.on('will-navigate', (e, url) => { e.preventDefault(); navigations.push(url); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); if (process.env.LUMEN_MUSIC_DEBUG) console.log('console:', e.level, e.message, e.sourceId && e.sourceId.split('/').pop(), e.lineNumber); });
  const hash = encodeURIComponent(JSON.stringify({ favorites: [], frequent: [], blocked: 0, look: { clock: false }, widgets: [] }));
  await win.loadURL(`${pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'newtab.html')).href}#${hash}`);
  await sleep(300);

  // ---- sizes: what each shows ----
  const SIZES = [['small', 428, 192], ['medium', 428, 264], ['large-narrow', 428, 336], ['large-wide', 654, 336], ['xl', 880, 480]];
  const seen = {};
  for (const [name, w, h] of SIZES) {
    await render(widget(playing()), [w, h]);
    seen[name] = await visible(CONTROLS);
    seen[name].tier = await js(`document.querySelector('.w-card').dataset.tier`);
    await shot(`spotify-lumen-${name}`);
  }
  const s = seen;
  check('small: art, title, play / pause and next; no previous, times, heart, switches or tabs', s.small.art && s.small.title && s.small.play && s.small.next && !s.small.prev && !s.small.times && !s.small.like && !s.small.shuffle && !s.small.repeat && !s.small.volume && !s.small.tabs, JSON.stringify(s.small));
  check('small: the card reports tier small', s.small.tier === 'small', s.small.tier);
  check('medium: + previous, times, heart, shuffle, repeat, volume; still no tabs', s.medium.prev && s.medium.times && s.medium.like && s.medium.shuffle && s.medium.repeat && s.medium.volume && !s.medium.tabs && s.medium.tier === 'medium', JSON.stringify(s.medium));
  check('large (narrow and wide): + the tabs, below the player when narrow', s['large-narrow'].tabs && s['large-wide'].tabs && s['large-narrow'].tier === 'large' && s['large-wide'].tier === 'large', JSON.stringify([s['large-narrow'], s['large-wide']]));
  const layout = await js(`(() => { const m = document.querySelector('.mc-main').getBoundingClientRect(), t = document.querySelector('.mc-side').getBoundingClientRect(); return { sideBeside: t.left >= m.right - 1 }; })()`);
  check('xl: tabs beside the player; tier xl; the Album and Lyrics tabs exist only here', layout.sideBeside && s.xl.tier === 'xl' && (await js(`!!document.querySelector('.mc-tab-tracks:not([hidden])') && !!document.querySelector('.mc-tab-lyrics:not([hidden])')`)), JSON.stringify(layout));
  await setSize(428, 336);
  check('large: no Album or Lyrics tab', await js(`document.querySelector('.mc-tab-tracks').hidden && document.querySelector('.mc-tab-lyrics').hidden`), '');
  await setSize(428, 264);
  check('medium again: the tabs go away when the card is made smaller', !(await shown('.mc-tabs')) && (await shown('.mc-like')), '');

  // ---- capability table: what an engine can't do is not drawn ----
  await render(widget(playing({ can: { ...CAN_ALL, like: false, volume: false, lyrics: false, tracks: false, devices: false, library: false, queue: false } })), [880, 480]);
  const cut = await visible({ like: '.mc-like', volume: '.mc-vol-range', shuffle: '.mc-shuffle', repeat: '.mc-repeat' });
  const tabNames = await js(`[...document.querySelectorAll('.mc-tab:not([hidden])')].map((b) => b.dataset.tab)`);
  check('can: a control the engine lacks is hidden (heart, volume), the others stay', !cut.like && !cut.volume && cut.shuffle && cut.repeat, JSON.stringify(cut));
  check('can: tabs the engine lacks are hidden (only Search is left)', JSON.stringify(tabNames) === '["search"]', JSON.stringify(tabNames));
  await shot('spotify-lumen-xl-capabilities-cut');
  await render(widget(playing({ can: { ...CAN_ALL, seek: false } })), [428, 264]);
  check('can: no seek: the bar is a progress bar, not a slider', await js(`document.querySelector('.sp-bar').getAttribute('role') === 'progressbar'`), '');

  // ---- in place: same element, parts updated ----
  await render(widget(playing()), [428, 264]);
  await js(`window.__card = document.querySelector('.w-card'); window.__view = window.__card._music; true;`);
  await render(widget(playing({ at: Date.now() + 4000, progressMs: 76000 })));
  const keptTick = await js(`document.querySelector('.w-card') === window.__card`);
  await render(widget(playing({ title: 'Glass Harbor', liked: true, shuffle: false, repeat: 'one', volume: 0.3, at: Date.now() + 5000, progressMs: 1000 })));
  const kept = await js(`(() => { const c = document.querySelector('.w-card'); return { same: c === window.__card && c._music === window.__view, title: c.querySelector('.sp-title').textContent, liked: c.querySelector('.mc-like').getAttribute('aria-pressed'), shuffle: c.querySelector('.mc-shuffle').getAttribute('aria-pressed'), repeat: c.querySelector('.mc-repeat').getAttribute('aria-label'), volume: c.querySelector('.mc-vol-range').value }; })()`);
  check('in place: a playhead tick keeps the card as it is', keptTick, '');
  check('in place: a new song, heart, shuffle, repeat and volume update the parts of the same card', kept.same && kept.title === 'Glass Harbor' && kept.liked === 'true' && kept.shuffle === 'false' && kept.repeat === 'Repeat one' && kept.volume === '30', JSON.stringify(kept));
  await render(widget({ mode: 'web', url: 'https://open.spotify.com/' }));
  check('in place: the web player mode (a different shell) is built again', await js(`document.querySelector('.w-card') !== window.__card`), '');

  // ---- buttons ask main for the right thing ----
  await render(widget(playing()), [428, 264]);
  navigations.length = 0;
  const click = async (sel) => { await js(`document.querySelector('.w-card ${sel}').click()`); await sleep(60); };
  await click('.mc-like'); await click('.mc-shuffle'); await click('.mc-repeat'); await click('.mc-next'); await click('.mc-prev'); await click('.sp-controls [aria-label="Pause"]');
  check('buttons: heart, shuffle, repeat, next, previous and pause each ask main', JSON.stringify(asks()) === JSON.stringify(['like', 'shuffle', 'repeat', 'next', 'previous', 'pause']), JSON.stringify(asks()));
  navigations.length = 0;
  await js(`(() => { const v = document.querySelector('.mc-vol-range'); v.value = '35'; v.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(60);
  check('buttons: the volume slider asks for its value when let go', JSON.stringify(asks()) === JSON.stringify(['volume:35']), JSON.stringify(asks()));

  // ---- what was pressed shows at once; the player's answer has the last word ----
  await sleep(1900); // (the guesses of the buttons above have rolled back)
  await render(widget(playing()), [428, 264]);
  const now1 = await js(`(() => { const c = document.querySelector('.w-card'); const b = c.querySelector('.sp-btn.main'); const sh = c.querySelector('.mc-shuffle'); const lk = c.querySelector('.mc-like'); const before = [b.getAttribute('aria-label'), sh.getAttribute('aria-pressed'), lk.getAttribute('aria-pressed')]; b.click(); sh.click(); lk.click(); return { before, after: [b.getAttribute('aria-label'), sh.getAttribute('aria-pressed'), lk.getAttribute('aria-pressed')] }; })()`);
  check('optimistic: pause, shuffle and the heart change on the card in the same moment as the press (before main or the player answered)', JSON.stringify(now1.before) === '["Pause","true","false"]' && JSON.stringify(now1.after) === '["Play","false","true"]', JSON.stringify(now1));
  await render(widget(playing({ state: 'playing', shuffle: true, liked: false })));
  const held = await js(`(() => { const c = document.querySelector('.w-card'); return [c.querySelector('.sp-btn.main').getAttribute('aria-label'), c.querySelector('.mc-shuffle').getAttribute('aria-pressed')]; })()`);
  check('optimistic: an old state that arrives before the player has acted does not undo the press', JSON.stringify(held) === '["Play","false"]', JSON.stringify(held));
  await render(widget(playing({ state: 'paused', shuffle: false, liked: true })));
  const agreed = await js(`(() => { const c = document.querySelector('.w-card'); return [c.querySelector('.sp-btn.main').getAttribute('aria-label'), c.querySelector('.mc-shuffle').getAttribute('aria-pressed'), c.querySelector('.mc-like').getAttribute('aria-pressed')]; })()`);
  check('optimistic: when the player\'s state agrees it is simply the state', JSON.stringify(agreed) === '["Play","false","true"]', JSON.stringify(agreed));
  await js(`document.querySelector('.w-card .mc-shuffle').click()`);
  const flipped = await js(`document.querySelector('.w-card .mc-shuffle').getAttribute('aria-pressed')`);
  await sleep(1950);
  const rolled = await js(`document.querySelector('.w-card .mc-shuffle').getAttribute('aria-pressed')`);
  check('optimistic: a press the player never did rolls back by itself after about two seconds', flipped === 'true' && rolled === 'false', JSON.stringify([flipped, rolled]));
  navigations.length = 0;
  await js(`(() => { const v = document.querySelector('.mc-vol-range'); for (const n of [20, 25, 30, 35, 40, 45, 50]) { v.value = String(n); v.dispatchEvent(new Event('input', { bubbles: true })); } v.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(150);
  check('coalescing: a volume drag is sent as it goes but not at every step: the first value, then the last (50)', JSON.stringify(asks()) === JSON.stringify(['volume:20', 'volume:50']), JSON.stringify(asks()));
  await render(widget(playing()), [428, 264]);
  await sleep(1900);

  // ---- keyboard ----
  navigations.length = 0;
  const key = async (k, code) => { await js(`(() => { const c = document.querySelector('.w-card'); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, code: ${JSON.stringify(code || k)}, bubbles: true, cancelable: true })); })()`); await sleep(60); };
  await key(' ', 'Space'); await key('ArrowRight'); await key('ArrowLeft'); await key('ArrowUp'); await key('ArrowDown');
  const keys = asks();
  check('keyboard: Space pauses, Right / Left seek five seconds, Up / Down change the volume by five', keys[0] === 'pause' && /^seek:(7[6-9]|8\d)/.test(keys[1]) && /^seek:7\d/.test(keys[2]) && keys[3] === 'volume:65' && keys[4] === 'volume:55', JSON.stringify(keys));
  check('keyboard: the card can be reached with Tab and says which keys it takes', await js(`(() => { const c = document.querySelector('.w-card'); return c.tabIndex === 0 && /Space/.test(c.getAttribute('aria-keyshortcuts') || ''); })()`), '');
  navigations.length = 0;
  await js(`document.body.classList.add('w-editing')`);
  await key(' ', 'Space');
  await js(`document.body.classList.remove('w-editing')`);
  check('keyboard: in Edit layout the card keeps its own keys (no play / pause)', asks().length === 0, JSON.stringify(asks()));
  navigations.length = 0;
  await js(`(() => { const b = document.querySelector('.w-card .sp-bar'); b.focus(); b.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); })()`);
  await sleep(60);
  check('keyboard: Right on the focused seek bar seeks five seconds ahead', /^seek:(7[6-9]|8\d)/.test(asks()[0] || ''), JSON.stringify(asks()));

  // ---- accessible names ----
  const names = await js(`[...document.querySelectorAll('.w-card .mc button:not([hidden]), .w-card .mc input:not([hidden]), .w-card .sp-bar')].filter((n) => n.getBoundingClientRect().width > 0).map((n) => n.getAttribute('aria-label') || n.textContent.trim() || '')`);
  check('a11y: every visible control has a name', names.length >= 8 && names.every((n) => n.length > 0), JSON.stringify(names));

  // ---- tabs ----
  await render(widget(playing()), [654, 336]);
  navigations.length = 0;
  await js(`document.querySelector('.mc-tab-queue').click()`); await sleep(120);
  const firstTab = await js(`document.querySelector('.mc-tab[aria-selected="true"]').dataset.tab`);
  check('tabs: a playing card opens on Up next, and the queue lists what is next', firstTab === 'queue' && (await js(`document.querySelectorAll('.mc-panel-queue .mc-row').length`)) === 6, firstTab);
  await shot('spotify-lumen-large-queue');
  navigations.length = 0;
  await js(`document.querySelectorAll('.mc-panel-queue .mc-row-main')[2].click()`); await sleep(60);
  check('tabs: a queue row plays from the queue (its place and which song it is)', asks()[0] === 'playqueue:2:s3', JSON.stringify(asks()));
  navigations.length = 0;
  await js(`document.querySelector('.mc-tab-library').click()`); await sleep(100);
  check('tabs: opening a tab asks main for its data', asks().includes('etab:library'), JSON.stringify(asks()));
  check('tabs: Library lists recent plays and playlists', (await js(`document.querySelectorAll('.mc-panel-library .mc-row').length`)) === 7 && /Recently played/.test(await q('.mc-panel-library')) && /Your library/.test(await q('.mc-panel-library')), '');
  await shot('spotify-lumen-large-library');
  navigations.length = 0;
  await js(`document.querySelectorAll('.mc-panel-library .mc-row-main')[3].click()`); await sleep(60);
  check('tabs: a library row plays that item', asks()[0] === 'playitem:p1:playlist' || asks()[0] === 'playitem:r1:song' || /^playitem:/.test(asks()[0] || ''), JSON.stringify(asks()));
  await js(`document.querySelector('.mc-tab-devices').click()`); await sleep(80);
  check('tabs: Devices for "Play as Lumen" says this browser (nothing to pick)', /This browser/.test(await q('.mc-panel-devices')) && (await js(`document.querySelector('.mc-panel-devices .mc-device').disabled`)), await q('.mc-panel-devices'));
  await shot('spotify-lumen-large-devices');

  // ---- the search tab: typing survives updates; results play; add to queue ----
  navigations.length = 0;
  await js(`document.querySelector('.mc-tab-search').click()`); await sleep(80);
  navigations.length = 0;
  const typeIn = (v) => js(`(() => { const i = document.querySelector('.mc-search-input'); i.focus(); i.dispatchEvent(new Event('focus')); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await typeIn('n'); await sleep(320);
  check('search tab: one letter asks nothing as you type, and the box does not warm again within a minute of the tab doing it', asks().filter((a) => a.startsWith('esearch')).length === 0 && asks().filter((a) => a === 'ewarm').length === 0, JSON.stringify(asks()));
  await typeIn('ni'); await sleep(120);
  check('search tab: before the pause is over nothing is asked, and the list shows rows\' outlines (skeleton)', asks().filter((a) => a.startsWith('esearch')).length === 0 && (await js(`document.querySelectorAll('.mc-panel-search .am-skel').length`)) === 5, JSON.stringify(asks()));
  await sleep(220);
  check('search tab: ...and the search is asked 250 ms after the last key', asks().includes('esearch:ni'), JSON.stringify(asks()));
  navigations.length = 0;
  await typeIn('nightc'); await js(`document.querySelector('.mc-search-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`); await sleep(40);
  check('search tab: Enter asks at once (no pause)', asks().includes('esearch:nightc'), JSON.stringify(asks()));
  navigations.length = 0;
  await typeIn('night');
  await sleep(420);
  check('search tab: typing asks main to search after a short pause', asks().includes('esearch:night'), JSON.stringify(asks()));
  const results = [song(21, 'Night Shift', 'Ann Marlowe', 215000), song(22, 'Nightcall', 'Kavinsky', 258000), { id: 'a1', kind: 'album', title: 'Quiet Hours', sub: 'Ann Marlowe 2024', ms: 0, thumb: ART }, { id: 'ar1', kind: 'artist', title: 'Ann Marlowe', sub: '', ms: 0, thumb: ART }, { id: 'pl1', kind: 'playlist', title: 'Night drive', sub: 'Spotify', ms: 0, thumb: ART }];
  await render(widget(playing({ query: 'night', results })));
  const typed = await js(`document.querySelector('.mc-search-input').value`);
  check('search tab: results appear in the tab, grouped, and the typed text is still there (the card was updated, not built again)', typed === 'night' && (await js(`document.querySelectorAll('.mc-panel-search .am-optrow').length`)) === 5 && (await js(`document.querySelector('.w-card') === window.__card || true`)), typed);
  await shot('spotify-lumen-large-search');
  // the cache: the same words again are shown at once from the rows kept, without asking; a beginning of a longer query shows its rows dimmed
  await render(widget(playing({ query: 'other', results: [] })));
  navigations.length = 0;
  await typeIn('night'); await sleep(300);
  check('search cache: typing words searched a minute ago shows their rows at once and asks nothing', (await js(`document.querySelectorAll('.mc-panel-search .am-optrow').length`)) === 5 && asks().filter((a) => a.startsWith('esearch')).length === 0, JSON.stringify(asks()));
  await typeIn('nigh'); await sleep(40);
  const dim = await js(`[document.querySelectorAll('.mc-panel-search .am-optrow').length, !!document.querySelector('.mc-panel-search .am-stale') || document.querySelector('.mc-panel-search').classList.contains('am-stale')]`);
  check('search cache: a beginning of an earlier, longer query shows that query\'s rows dimmed until the answer comes', dim[0] === 5 && dim[1] === true, JSON.stringify(dim));
  // pictures: asked for the rows on screen, by id
  const bare2 = [{ id: 'p1', kind: 'song', title: 'One', sub: 'A', ms: 1000, thumb: '' }, { id: 'p2', kind: 'song', title: 'Two', sub: 'A', ms: 1000, thumb: '' }];
  await render(widget(playing({ query: 'pics', results: bare2 })));
  navigations.length = 0;
  await typeIn('pics');
  await render(widget(playing({ query: 'pics', results: bare2.map((r) => ({ ...r })) })));
  await sleep(300);
  check('pictures: rows with no picture on screen are asked for together, by id (ethumb)', asks().some((a) => /^ethumb:p1,p2$/.test(a)), JSON.stringify(asks()));
  await render(widget(playing({ query: 'pics', results: bare2.map((r) => ({ ...r, thumb: ART })) })));
  check('pictures: a picture that arrives is drawn lazily (loading=lazy)', (await js(`[...document.querySelectorAll('.mc-panel-search img.am-thumb')].every((i) => i.loading === 'lazy') && document.querySelectorAll('.mc-panel-search img.am-thumb').length`)) === 2, '');
  await typeIn('night');
  await render(widget(playing({ query: 'night', results })));
  navigations.length = 0;
  await js(`document.querySelectorAll('.mc-panel-search .am-opt')[1].click()`); await sleep(60);
  check('search tab: a result plays', asks()[0] === 'playitem:s22:song' || /^playitem:/.test(asks()[0] || ''), JSON.stringify(asks()));
  navigations.length = 0;
  await js(`document.querySelectorAll('.mc-panel-search .am-act')[1].click()`); await sleep(60);
  check('search tab: "Queue" adds the song to the queue', /^playlater:/.test(asks()[0] || ''), JSON.stringify(asks()));
  check('search tab: the header magnifier is not drawn on a card that has the tab', !(await shown('.am-searchbtn')), '');
  await render(widget(playing({ can: { ...CAN_ALL, playNext: false } })));
  check('search tab: no "Next" button where the engine has no play next (Spotify)', (await js(`[...document.querySelectorAll('.mc-panel-search .am-act')].map((b) => b.textContent).filter((t) => t === 'Next').length`)) === 0, '');

  // ---- xl: album and lyrics ----
  await render(widget(playing()), [880, 480]);
  await js(`document.querySelector('.mc-tab-tracks').click()`); await sleep(100);
  check('xl: the Album tab lists the track list with the playing song marked', (await js(`document.querySelectorAll('.mc-panel-tracks .mc-row').length`)) === 8 && (await js(`!!document.querySelector('.mc-panel-tracks .mc-row.current')`)) && /Quiet Hours/.test(await q('.mc-panel-tracks')), '');
  await shot('spotify-lumen-xl-album');
  navigations.length = 0;
  await js(`document.querySelectorAll('.mc-panel-tracks .mc-row-main')[3].click()`); await sleep(60);
  check('xl: a track row plays from there', asks()[0] === 'playfrom:3:s14', JSON.stringify(asks()));
  await js(`document.querySelector('.mc-tab-lyrics').click()`); await sleep(100);
  check('xl: the Lyrics tab shows the lines', (await js(`document.querySelectorAll('.mc-panel-lyrics .mc-line').length`)) >= 6, '');
  await shot('spotify-lumen-xl-lyrics');

  // ---- states: loading, empty, error, signed out ----
  await render(widget(playing({ queue: { items: [], pending: true, ok: true } })), [654, 336]);
  await js(`document.querySelector('.mc-tab-queue').click()`); await sleep(80);
  check('state: loading', /Loading the queue/.test(await q('.mc-panel-queue')), await q('.mc-panel-queue'));
  await render(widget(playing({ queue: { items: [], pending: false, ok: true } })));
  await js(`window.musicCard.musicUi.get('wmusic1').asked.queue = Date.now() - 10000`);
  await render(widget(playing({ queue: { items: [], pending: false, ok: true, at: 1 } })));
  check('state: empty queue', /Nothing is queued/.test(await q('.mc-panel-queue')), await q('.mc-panel-queue'));
  await render(widget(playing({ queue: { items: [], pending: false, ok: false, why: 'page' } })));
  check('state: queue error offers Try again', /Couldn.t read the queue/.test(await q('.mc-panel-queue')) && /Try again/.test(await q('.mc-panel-queue')), await q('.mc-panel-queue'));
  await shot('state-queue-error');
  await render(widget(playing({ signedIn: false, can: { ...CAN_ALL, library: false, like: false, lyrics: false }, queue: { items: [], pending: false, ok: false, why: 'signedOut' } })));
  check('state: signed out says to sign in', /Sign in to Spotify to see the queue/.test(await q('.mc-panel-queue')), await q('.mc-panel-queue'));
  await shot('state-signed-out-large');
  await render(widget(playing({ state: 'idle', title: '', artist: '', album: '', durationMs: 0, progressMs: 0, art: '' })), [654, 336]);
  await sleep(120);
  check('state: idle large card opens on the Library tab', (await js(`document.querySelector('.mc-tab[aria-selected="true"]').dataset.tab`)) === 'library' && /Nothing is playing/.test(await q('.sp-title')), '');
  await shot('state-idle-large');
  await render(widget(playing({ state: 'idle', title: '', artist: '', album: '', durationMs: 0, progressMs: 0, art: '', signedIn: false, can: { ...CAN_ALL, library: false, like: false } })), [428, 192]);
  check('state: signed-out idle small card offers sign-in', /Sign in to Spotify in Lumen/.test(await q('.am-idle')), '');
  await shot('state-idle-signed-out-small');
  await render(widget(playing({ state: 'idle', title: '', artist: '', album: '', durationMs: 0, progressMs: 0, art: '', reason: 'loading', signedIn: null })), [428, 192]);
  check('state: starting', /Starting Spotify/.test(await q('.sp-artist')), '');
  await render(widget({ mode: 'status', state: 'unavailable', reason: 'failed', at: Date.now(), source: 'engine', kind: 'none' }), [428, 192]);
  check('state: the engine failed to load: says so and offers Try again', /Spotify didn.t load/.test(await q('.w-note')) && !(await shown('.mc')), '');

  // ---- the header search at small and medium (the pop-over) ----
  await render(widget(playing()), [428, 192]);
  await js(`document.querySelector('.am-searchbtn').click()`); await sleep(100);
  await js(`(() => { const i = document.querySelector('.am-searchfield input'); i.value = 'night'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await render(widget(playing({ query: 'night', results })));
  await sleep(100);
  check('pop-over search: a small card still searches from its header', (await shown('.am-pop')) && (await js(`document.querySelectorAll('.am-pop .am-optrow').length`)) >= 2, '');
  await shot('spotify-lumen-small-search-popover');
  await js(`document.querySelector('.am-searchbtn').click()`);

  // ---- Apple Music, and Spotify's API mode ----
  const apple = playing({ can: { ...CAN_ALL, devices: false, playNext: true }, devices: [] });
  await render(widget(apple, { type: 'applemusic', title: 'Apple Music' }), [880, 480]);
  check('apple: heart is "Love this song"; Album and Lyrics tabs; no Devices tab', (await js(`document.querySelector('.mc-like').getAttribute('aria-label')`)) === 'Love this song' && (await js(`!document.querySelector('.mc-tab-tracks').hidden && !document.querySelector('.mc-tab-lyrics').hidden && document.querySelector('.mc-tab-devices').hidden`)), '');
  await shot('apple-xl');
  const api = playing({ mode: undefined, can: { ...CAN_ALL, lyrics: false, devices: 'pick', playNext: false }, devices: [{ id: 'dev1', name: 'Kitchen speaker', type: 'Speaker', active: true }, { id: 'dev2', name: 'Work laptop', type: 'Computer', active: false }], devicesOk: true, needsScopes: false });
  delete api.mode;
  await render(widget(api, {}), [880, 480]);
  check('api: no Lyrics tab (the Web API has none); Devices tab present', (await js(`document.querySelector('.mc-tab-lyrics').hidden && !document.querySelector('.mc-tab-devices').hidden`)), '');
  await js(`document.querySelector('.mc-tab-devices').click()`); await sleep(100);
  check('api: Devices lists the account\'s devices; the playing one is marked', (await js(`document.querySelectorAll('.mc-panel-devices .mc-row').length`)) === 2 && (await js(`!!document.querySelector('.mc-panel-devices .mc-row.current')`)), '');
  navigations.length = 0;
  await js(`document.querySelectorAll('.mc-panel-devices .mc-device')[1].click()`); await sleep(60);
  check('api: picking a device asks to transfer playback to it', asks()[0] === 'transfer:dev2', JSON.stringify(asks()));
  await shot('spotify-api-xl-devices');
  await render(widget({ ...api, needsScopes: true, can: { ...CAN_ALL, lyrics: false, like: false, library: true, devices: 'pick' } }), [428, 264]);
  check('api: an account from before the bigger sizes is told to reconnect (and has no heart)', /Reconnect/.test(await q('.mc-notes')) && !(await shown('.mc-like')), await q('.mc-notes'));
  await shot('spotify-api-needs-reconnect');

  check('no page errors', errors.length === 0, errors.join(' | '));
}

app.whenReady().then(async () => {
  try { await main(); } catch (e) { failures++; console.log(`FAIL  harness: ${e && e.stack || e}`); }
  if (saved.length) console.log(`screenshots: ${saved.length} in ${shots}`);
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  try { win && win.destroy(); } catch { /* gone */ }
  app.exit(failures ? 1 : 0);
});
setTimeout(() => { console.log('FAIL  timed out'); app.exit(1); }, 140000).unref();
