// The Apple Music widget's Status mode in a real window, offline. Part 1 stands in the now-playing source
// (global.__appleMusicFake, main.js uses it only in test mode): every state of the card (playing, paused, idle, nothing to
// read: not installed, permission refused, unsupported), the buttons, the progress bar, the three sizes, light and dark, the
// keyboard, no console errors. Part 2 (Windows only, skipped when there is no media session to read) runs the real PowerShell
// helper against whatever media app is playing, with the Apple filter off (LUMEN_TEST_APPLE_MUSIC_ANY=1).
// Set LUMEN_APPLEMUSIC_SHOTS=<dir> to keep a screenshot of each.
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
    global.__am = { card: { mode: 'status', state: 'playing', title: 'Night Shift', artist: 'Ann', album: 'Quiet Hours', progressMs: 30000, durationMs: 200000, at: Date.now(), source: 'Apple Music', kind: 'track', reason: '', art }, pressed: [], opened: 0 };
    global.__appleMusicFake = {
      read: async () => ({ ...global.__am.card, at: Date.now() }),
      control: async (n) => { global.__am.pressed.push(n); if (n === 'pause') global.__am.card.state = 'paused'; if (n === 'play') global.__am.card.state = 'playing'; return true; },
      open: async () => { global.__am.opened++; return 'opened'; },
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
  check('status: the progress bar is a labelled progressbar with elapsed and total time', bar && bar.role === 'progressbar' && /Night Shift progress/.test(bar.label) && /^0:3\d$/.test(bar.elapsed) && bar.total === '3:20', JSON.stringify(bar));
  await sleep(2200);
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
  await app.evaluate(() => { global.__am.card = { ...global.__am.card, state: 'playing', title: 'The Next Song', album: 'Two' }; global.__widgets.appleMusicChanged(); });
  check('status: when the app moves on, the card follows by itself', await waitFor(`${card(D)}?.querySelector('.sp-title')?.textContent === 'The Next Song'`, 40), await text(D, '.sp-title'));

  // sizes
  for (const [id, expect] of [['wsmall001', { controls: false }], ['wdefault1', { controls: true }], ['wbig00001', { controls: true }]]) {
    await waitFor(`${card(id)}?.querySelector('.sp-title')?.textContent === 'The Next Song'`);
    const r = await page(`(() => { const c = ${card(id)}; const r = c.getBoundingClientRect(); const ctl = c.querySelector('.sp-controls'); const bad = [...c.querySelectorAll('.sp-title, .sp-artist')].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow !== 'ellipsis').length; return { w: Math.round(r.width), h: Math.round(r.height), controls: ctl ? getComputedStyle(ctl).display !== 'none' : false, title: Boolean(c.querySelector('.sp-title')), bad, over: c.scrollWidth > c.clientWidth + 1 }; })()`);
    check(`status: card ${id} (${r.w}x${r.h}px) shows the title${expect.controls ? ' and the controls' : ''} and fits`, r.title && (!expect.controls || r.controls) && r.controls === expect.controls && r.bad === 0 && !r.over, JSON.stringify(r));
  }
  await shot('status-sizes.png');

  // keyboard
  const kb = await page(`(() => { const bs = [...${card(D)}.querySelectorAll('.sp-controls button')]; bs[0].focus(); return { n: bs.length, ok: bs.every((b) => b.tabIndex >= 0 && b.tagName === 'BUTTON' && b.type === 'button'), focused: document.activeElement === bs[0], ring: getComputedStyle(bs[0]).boxShadow }; })()`);
  check('status: the controls are focusable buttons with a visible focus ring', kb.n === 3 && kb.ok && kb.focused && kb.ring !== 'none', JSON.stringify(kb));

  // idle: nothing playing, the app is there
  await app.evaluate(() => { global.__am.card = { mode: 'status', state: 'idle', title: '', artist: '', album: '', progressMs: 0, durationMs: 0, at: Date.now(), source: '', kind: 'none', reason: 'not-running', art: '' }; global.__widgets.appleMusicChanged(); });
  check('status: nothing playing says so, offers Play and Open Apple Music', await waitFor(`${card(D)}?.querySelector('.sp-title')?.textContent === 'Nothing is playing'`, 40) && /Open Apple Music and press play/.test(await text(D, '.sp-artist')) && await page(`Boolean(${card(D)}.querySelector('.sp-open'))`), await text(D, '.sp-artist'));
  await page(`${card(D)}.querySelector('.sp-open').click()`);
  await sleep(600);
  check('status: "Open Apple Music" asks main to start the app', (await app.evaluate(() => global.__am.opened)) === 1, '');
  await shot('status-idle.png');

  // nothing to read at all
  for (const [reason, re] of [['not-installed', /isn.t installed/], ['denied', /Automation/], ['unsupported', /Windows and macOS/], ['error', /couldn.t read/i]]) {
    await app.evaluate((_e, r) => { global.__am.card = { mode: 'status', state: 'unavailable', title: '', artist: '', album: '', progressMs: 0, durationMs: 0, at: Date.now(), source: '', kind: 'none', reason: r, art: '' }; global.__widgets.appleMusicChanged(); }, reason);
    check(`status: ${reason} gives a clear message, the web player link, and no broken controls`, await waitFor(`${re}.test(${card(D)}?.querySelector('.w-note')?.textContent || '')`, 40) && await page(`Boolean(${card(D)}.querySelector('a.w-btn[href="https://music.apple.com/"]')) && !${card(D)}.querySelector('.sp-controls')`), await text(D, '.w-note'));
    if (reason === 'denied') await shot('status-denied.png');
  }

  // light and dark
  await app.evaluate(() => { global.__am.card = { mode: 'status', state: 'playing', title: 'Night Shift', artist: 'Ann', album: 'Quiet Hours', progressMs: 30000, durationMs: 200000, at: Date.now(), source: 'Apple Music', kind: 'track', reason: '', art: global.__am.card.art || '' }; global.__widgets.appleMusicChanged(); });
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
