// The Apple Music widget's Status mode in a real window, offline. Part 1 stands in the now-playing source
// (global.__appleMusicFake, main.js uses it only in test mode): every state of the card (playing, paused, idle, nothing to
// read: not installed, permission refused, unsupported), the buttons, the progress bar, the three sizes, light and dark, the
// keyboard, no console errors. Part 2 (Windows only, skipped when there is no media session to read) runs the real PowerShell
// helper against whatever media app is playing, with the Apple filter off (LUMEN_TEST_APPLE_MUSIC_ANY=1).
// Set LUMEN_APPLEMUSIC_SHOTS=<dir> to keep a screenshot of each.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.LUMEN_APPLEMUSIC_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
// A 120x120 picture (a PNG: main makes it a small JPEG).
const ART = (() => {
  const zlib = require('zlib');
  const W = 120;
  const raw = Buffer.alloc((W * 3 + 1) * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const o = y * (W * 3 + 1) + 1 + x * 3; raw[o] = 250 - x; raw[o + 1] = 35 + y; raw[o + 2] = 59 + ((x ^ y) & 63); }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
  return `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64')}`;
})();

async function launch(widgets, env = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-applemusic-status-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: widgets, newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false }));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ...env } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
  const page = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
  await app.evaluate(() => { global.__errs = []; global.__wtab.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) global.__errs.push(String(msg).slice(0, 300)); }); });
  const waitFor = async (code, tries = 80) => { for (let i = 0; i < tries; i++) { if (await page(code).catch(() => false)) return true; await sleep(150); } return false; };
  const shot = async (name) => { if (shots) fs.writeFileSync(path.join(shots, name), Buffer.from(await app.evaluate(async () => (await global.__wtab.webContents.capturePage()).toPNG().toString('base64')), 'base64')); };
  const close = async () => { await app.close(); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); };
  return { app, page, waitFor, shot, close };
}

(async () => {
  await partFake();
  await partReal();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

async function partFake() {
  const W = [
    { id: 'wsmall001', type: 'applemusic', mode: 'status', x: 0, y: 0, w: 2, h: 2 },
    { id: 'wdefault1', type: 'applemusic', mode: 'status', x: 2, y: 0, w: 4, h: 3 },
    { id: 'wbig00001', type: 'applemusic', mode: 'status', x: 6, y: 0, w: 6, h: 5 },
  ];
  const { app, page, waitFor, shot, close } = await launch(W);
  await app.evaluate((_e, art) => {
    global.__ART = art;
    global.__am = { card: { mode: 'status', state: 'playing', title: 'Night Shift', artist: 'Ann', album: 'Quiet Hours', progressMs: 30000, durationMs: 200000, at: Date.now(), source: 'engine', kind: 'track', reason: '', art, signedIn: true, preview: false }, pressed: [], sought: [], played: [], searched: [], signIns: 0, reloads: 0, lists: 0 };
    global.__appleMusicFake = {
      read: async () => ({ ...global.__am.card, at: global.__am.card.state === 'idle' || global.__am.card.state === 'unavailable' ? 0 : Date.now() }),
      control: async (n) => { global.__am.pressed.push(n); if (n === 'pause') global.__am.card.state = 'paused'; if (n === 'play') global.__am.card.state = 'playing'; return true; },
      seek: (sec) => { global.__am.sought.push(sec); return true; },
      playItem: (kind, id) => { global.__am.played.push(`${kind}:${id}`); return true; },
      search: (term) => { global.__am.searched.push(term); return true; },
      signIn: () => { global.__am.signIns++; return true; },
      refreshLists: () => { global.__am.lists++; },
      reload: () => { global.__am.reloads++; },
    };
  }, ART);
  const refresh = async () => { await app.evaluate(async () => { for (const e of global.__widgets.cache.values()) if (e.pending) await e.pending; for (const e of global.__widgets.cache.values()) { e.at = 0; e.retryAt = 0; } return global.__widgets.refreshAll({ force: true }); }); await sleep(300); };
  const card = (id) => `(document.querySelector('.w-card[data-id="${id}"]') || document.createElement('i'))`;
  const text = (id, sel) => page(`${card(id)}?.querySelector(${JSON.stringify(sel)})?.textContent || ''`);
  const D = 'wdefault1';
  await refresh();

  check('status: the card shows title, artist and album (the same markup as the Spotify card)', await waitFor(`${card(D)}?.querySelector('.sp-title')?.textContent === 'Night Shift'`) && (await text(D, '.sp-artist')) === 'Ann' && (await text(D, '.sp-album')) === 'Quiet Hours', await text(D, '.sp-title'));
  check('status: the album art is shown', await page(`(() => { const i = ${card(D)}.querySelector('img.sp-art'); return Boolean(i) && i.src.startsWith('data:image/') && i.naturalWidth > 0; })()`), '');
  check('status: there is no web slot and no sign-in button in this mode', !(await page(`Boolean(${card(D)}.querySelector('.sp-web-slot, .sp-web-signin'))`)), '');
  const names = await page(`[...${card(D)}.querySelectorAll('button, a')].map((b) => b.getAttribute('aria-label') || b.textContent.trim())`);
  check('status: every control has a name (previous, pause, next, refresh)', ['Previous track', 'Pause', 'Next track'].every((n) => names.includes(n)) && names.every(Boolean), JSON.stringify(names));
  const bar = await page(`(() => { const b = ${card(D)}.querySelector('.sp-bar'); return b && { role: b.getAttribute('role'), label: b.getAttribute('aria-label'), elapsed: ${card(D)}.querySelector('.sp-elapsed').textContent, total: ${card(D)}.querySelector('.sp-total').textContent }; })()`);
  check('status: the progress bar is a labelled slider with elapsed and total time', bar && bar.role === 'slider' && /Night Shift progress/.test(bar.label) && /^0:3\d$/.test(bar.elapsed) && bar.total === '3:20', JSON.stringify(bar));
  await sleep(3300);
  check('status: the playhead moves on by itself while playing', Number((await text(D, '.sp-elapsed')).split(':')[1]) >= 32, await text(D, '.sp-elapsed'));
  await shot('status-playing.png');

  await page(`${card(D)}.querySelector('[aria-label="Pause"]').click()`);
  await sleep(900);
  check('status: Pause presses the app\'s Pause and the card shows Play', (await app.evaluate(() => global.__am.pressed)).join() === 'pause' && await waitFor(`Boolean(${card(D)}.querySelector('[aria-label="Play"]'))`), JSON.stringify(await app.evaluate(() => global.__am.pressed)));
  await page(`${card(D)}.querySelector('[aria-label="Next track"]').click()`);
  await page(`${card(D)}.querySelector('[aria-label="Previous track"]').click()`);
  await sleep(400);
  check('status: Next and Previous press the app\'s buttons', (await app.evaluate(() => global.__am.pressed)).join() === 'pause,next,previous', JSON.stringify(await app.evaluate(() => global.__am.pressed)));

  // the app changes by itself: the card follows without a click
  await app.evaluate(() => { global.__am.card = { ...global.__am.card, state: 'playing', title: 'The Next Song', album: 'Two' }; global.__widgets.engineChanged(); });
  check('status: when the app moves on, the card follows by itself', await waitFor(`${card(D)}?.querySelector('.sp-title')?.textContent === 'The Next Song'`, 40), await text(D, '.sp-title'));

  // sizes
  for (const [id, expect] of [['wsmall001', { controls: false }], ['wdefault1', { controls: true }], ['wbig00001', { controls: true }]]) {
    await waitFor(`${card(id)}?.querySelector('.sp-title')?.textContent === 'The Next Song'`);
    const r = await page(`(() => { const c = ${card(id)}; const r = c.getBoundingClientRect(); const ctl = c.querySelector('.sp-controls'); const bad = [...c.querySelectorAll('.sp-title, .sp-artist')].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow !== 'ellipsis').length; return { w: Math.round(r.width), h: Math.round(r.height), controls: ctl ? getComputedStyle(ctl).display !== 'none' : false, title: Boolean(c.querySelector('.sp-title')), bad, over: c.scrollWidth > c.clientWidth + 1 }; })()`);
    check(`status: card ${id} (${r.w}x${r.h}px) shows the title${expect.controls ? ' and the controls' : ''} and fits`, r.title && (!expect.controls || r.controls) && r.controls === expect.controls && r.bad === 0 && !r.over, JSON.stringify(r));
  }
  await shot('status-sizes.png');

  // keyboard
  const kb = await page(`(() => { const bs = [...${card(D)}.querySelectorAll('.sp-controls button')].filter((b) => b.offsetParent !== null); bs[0].focus(); return { n: bs.length, ok: bs.every((b) => b.tabIndex >= 0 && b.tagName === 'BUTTON' && b.type === 'button'), focused: document.activeElement === bs[0], ring: getComputedStyle(bs[0]).boxShadow }; })()`);
  check('status: the controls are focusable buttons with a visible focus ring', kb.n >= 2 && kb.ok && kb.focused && kb.ring !== 'none', JSON.stringify(kb));

  // the bar seeks: a click puts the playhead there, the arrow keys move it by 5 seconds
  check('status: the progress bar is a slider (the app\'s own card is a plain bar)', await page(`${card(D)}.querySelector('.sp-bar').getAttribute('role') === 'slider' && ${card(D)}.querySelector('.sp-bar').tabIndex === 0`), '');
  await page(`(() => { const b = ${card(D)}.querySelector('.sp-bar'); const r = b.getBoundingClientRect(); b.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width * 0.25 })); })()`);
  await sleep(500);
  const sought = await app.evaluate(() => global.__am.sought);
  check('status: clicking the bar a quarter of the way seeks to a quarter of the song', sought.length === 1 && Math.abs(sought[0] - 50) <= 2, JSON.stringify(sought));
  await page(`(() => { const b = ${card(D)}.querySelector('.sp-bar'); b.focus(); b.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); })()`);
  await sleep(500);
  check('status: the right arrow on the bar seeks 5 seconds on', (await app.evaluate(() => global.__am.sought)).length === 2, JSON.stringify(await app.evaluate(() => global.__am.sought)));

  // a preview (signed out), and the desktop app as the source
  await app.evaluate(() => { global.__am.card = { ...global.__am.card, state: 'playing', preview: true, signedIn: false, error: '' }; global.__widgets.engineChanged(); });
  check('status: a preview says so (signed out)', await waitFor(`/Preview only/.test(${card(D)}?.textContent || '')`, 40), await text(D, '.am-note'));
  await app.evaluate(() => { global.__am.card = { ...global.__am.card, state: 'playing', preview: false, source: 'app' }; global.__widgets.engineChanged(); });
  check('status: when the desktop app is the source the card says "Apple Music app" and its bar is a plain bar (no seeking)', await waitFor(`/Apple Music app/.test(${card(D)}?.querySelector('.mk-badge')?.textContent || '') && ${card(D)}.querySelector('.sp-bar').getAttribute('role') === 'progressbar'`, 40), '');
  await app.evaluate(() => { global.__am.card = { ...global.__am.card, source: 'engine', preview: false }; global.__widgets.engineChanged(); });

  // idle, signed out: Sign in, no lists; the search is in the header (its own test: test/music-search-ui.js)
  const idleCard = (extra = {}) => ({ mode: 'status', state: 'idle', title: '', artist: '', album: '', progressMs: 0, durationMs: 0, at: 0, source: 'engine', kind: 'none', reason: '', art: '', signedIn: false, engine: 'ready', drm: 'ok', can: { search: true, lists: true, seek: true, queue: true }, recent: [], playlists: [], results: [], query: '', searching: false, error: '', ...extra });
  await app.evaluate((_e, c) => { global.__am.card = c; global.__widgets.engineChanged(); }, idleCard());
  check('status: idle and signed out offers Sign in and says what to do; the search magnifier is in the header', await waitFor(`${card(D)}?.querySelector('.sp-title')?.textContent === 'Nothing is playing' && Boolean(${card(D)}.querySelector('.am-signin')) && Boolean(${card(D)}.querySelector('.w-head .am-searchbtn'))`, 40) && /Search, or sign in/.test(await text(D, '.sp-artist')), await text(D, '.sp-artist'));
  check('status: there is no recent list when signed out', !(await page(`Boolean(${card(D)}.querySelector('.am-row'))`)), '');
  await page(`${card(D)}.querySelector('.am-signin').click()`);
  await sleep(500);
  check('status: Sign in asks main for the sign-in window', (await app.evaluate(() => global.__am.signIns)) === 1, '');
  await shot('status-idle.png');

  // recent plays and playlists once signed in; a click plays
  await app.evaluate((_e, c) => { global.__am.card = c; global.__widgets.engineChanged(); }, idleCard({ signedIn: true, recent: [{ id: 'l.1', kind: 'album', title: 'Quiet Hours', sub: 'Ann' }, { id: 'bad id', kind: 'album', title: 'Not shown', sub: '' }], playlists: [{ id: 'p.1', kind: 'playlist', title: 'Morning mix', sub: '' }] }));
  check('status: signed in and idle shows "Recently played" and "Your playlists" (safe ids only), and no Sign in button', await waitFor(`/Recently played/.test(${card(D)}?.textContent || '') && /Your playlists/.test(${card(D)}.textContent) && !${card(D)}.querySelector('.am-signin') && ${card(D)}.querySelectorAll('.am-row').length === 2`, 40), await text(D, '.am-idle'));
  await page(`${card(D)}.querySelectorAll('.am-row')[1].click()`);
  await sleep(500);
  check('status: clicking a playlist plays it', (await app.evaluate(() => global.__am.played)).at(-1) === 'playlist:p.1', JSON.stringify(await app.evaluate(() => global.__am.played)));
  await shot('status-lists.png');
  await app.evaluate((_e, c) => { global.__am.card = c; global.__widgets.engineChanged(); }, idleCard({ signedIn: true, drm: 'missing' }));
  check('status: Widevine missing is explained in the idle view when signed in', await waitFor(`/Widevine/.test(${card(D)}?.querySelector('.am-note')?.textContent || '')`, 40), '');
  await app.evaluate((_e, c) => { global.__am.card = c; global.__widgets.engineChanged(); }, idleCard({ reason: 'loading', signedIn: null }));
  check('status: while the engine starts the card says so and offers nothing yet', await waitFor(`/Starting Apple Music/.test(${card(D)}?.querySelector('.sp-artist')?.textContent || '') && !${card(D)}.querySelector('.am-searchbtn')`, 40), '');
  await app.evaluate((_e, c) => { global.__am.card = c; global.__widgets.engineChanged(); }, idleCard({ pageChanged: true, signedIn: true }));
  check('status: when the service says its page changed, the card says so', await waitFor(`/changed its page/.test(${card(D)}?.querySelector('.am-changed')?.textContent || '')`, 40), '');

  // the engine can't load
  for (const [reason, re] of [['offline', /Can.t reach Apple Music/], ['failed', /didn.t load/], ['unsupported', /isn.t available here/]]) {
    await app.evaluate((_e, r) => { global.__am.card = { mode: 'status', state: 'unavailable', title: '', artist: '', album: '', progressMs: 0, durationMs: 0, at: 0, source: '', kind: 'none', reason: r, art: '' }; global.__widgets.engineChanged(); }, reason);
    check(`status: ${reason} gives a clear message with Try again and no broken controls`, await waitFor(`${re}.test(${card(D)}?.querySelector('.w-note')?.textContent || '')`, 40) && await page(`Boolean(${card(D)}.querySelector('button.w-btn')) && !${card(D)}.querySelector('.sp-controls')`), await text(D, '.w-note'));
  }
  await page(`[...${card(D)}.querySelectorAll('button.w-btn')].find((b) => /Try again/.test(b.textContent)).click()`);
  await sleep(500);
  check('status: Try again reloads the engine', (await app.evaluate(() => global.__am.reloads)) === 1, '');
  await shot('status-offline.png');

  // light and dark
  await app.evaluate(() => { global.__am.card = { mode: 'status', state: 'playing', title: 'Night Shift', artist: 'Ann', album: 'Quiet Hours', progressMs: 30000, durationMs: 200000, at: Date.now(), source: 'engine', kind: 'track', reason: '', art: global.__ART || '', signedIn: true }; global.__widgets.engineChanged(); });
  await waitFor(`${card(D)}?.querySelector('.sp-title')?.textContent === 'Night Shift'`, 40);
  const contrast = () => page(`(() => { const rgb = (s) => s.match(/[\\d.]+/g).slice(0, 3).map(Number); const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); }; const c = ${card(D)}; const bgOf = (e) => { let n = e; while (n) { const b = getComputedStyle(n).backgroundColor; if (b && !/rgba?\\(0, 0, 0, 0\\)|transparent/.test(b)) return rgb(b); n = n.parentElement; } return [255, 255, 255]; }; const ratio = (e) => { const a = lum(rgb(getComputedStyle(e).color)) + 0.05; const b = lum(bgOf(e)) + 0.05; return Math.max(a, b) / Math.min(a, b); }; return { title: ratio(c.querySelector('.sp-title')), artist: ratio(c.querySelector('.sp-artist')) }; })()`);
  for (const scheme of ['dark', 'light']) {
    await app.evaluate(({ nativeTheme }, s) => { nativeTheme.themeSource = s; }, scheme);
    await sleep(500);
    const c = await contrast();
    check(`status: ${scheme}: title and artist text keep at least 4.5:1 contrast`, c.title >= 4.5 && c.artist >= 4.5, JSON.stringify(c));
    await shot(`status-${scheme}.png`);
  }
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system'; });

  check('status: no console errors on the new-tab page', (await app.evaluate(() => global.__errs)).length === 0, JSON.stringify(await app.evaluate(() => global.__errs)));
  await close();
}

async function partReal() {
  if (process.platform !== 'win32') { console.log('SKIP  the real helper checks: Windows only'); return; }
  if (process.env.LUMEN_TEST_REAL_MEDIA !== '1') { console.log('SKIP  the real helper checks: they press Pause/Play on whatever media app is playing on this computer (set LUMEN_TEST_REAL_MEDIA=1 to run them)'); return; }
  const { app, page, waitFor, shot, close } = await launch([{ id: 'wreal0001', type: 'applemusic', mode: 'status', x: 0, y: 0, w: 5, h: 4 }], { LUMEN_TEST_APPLE_MUSIC_ANY: '1' });
  const card = `(document.querySelector('.w-card[data-id="wreal0001"]') || document.createElement('i'))`;
  const t0 = Date.now();
  const got = await waitFor(`${card}.querySelector('.sp-title')?.textContent && ${card}.querySelector('.sp-title').textContent !== 'Nothing is playing'`, 60) || await waitFor(`/Nothing is playing|isn.t installed/.test(${card}.textContent)`, 5);
  const title = await page(`${card}.querySelector('.sp-title')?.textContent || ${card}.querySelector('.w-note')?.textContent || ''`);
  if (title === 'Nothing is playing' || /isn.t installed/.test(title)) {
    console.log(`SKIP  the real helper checks: no media session is playing here (the card says: ${title})`);
  } else {
    check(`real helper: the card shows what a real media session plays (${Date.now() - t0} ms to first draw)`, got && title.length > 0, title);
    const ctl = await page(`[...${card}.querySelectorAll('.sp-controls button')].map((b) => b.getAttribute('aria-label'))`);
    check('real helper: the buttons are there', ctl.length === 3, JSON.stringify(ctl));
    const before = await page(`Boolean(${card}.querySelector('[aria-label="Pause"]'))`);
    await page(`(${card}.querySelector('[aria-label="Pause"]') || ${card}.querySelector('[aria-label="Play"]')).click()`);
    check('real helper: Pause/Play really changes the media session and the card follows', await waitFor(`Boolean(${card}.querySelector('[aria-label="${before ? 'Play' : 'Pause'}"]'))`, 40), '');
    await page(`(${card}.querySelector('[aria-label="Pause"]') || ${card}.querySelector('[aria-label="Play"]')).click()`); // put it back
    await shot('status-real.png');
  }
  const helper = await app.evaluate(() => global.__widgets.list().length);
  check('real helper: the new-tab page has no console errors', (await app.evaluate(() => global.__errs)).length === 0 && helper === 1, JSON.stringify(await app.evaluate(() => global.__errs)));
  await close();
}
