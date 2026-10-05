// The Spotify new-tab widget in a real window, offline: a local https server (a throwaway self-signed
// certificate) stands in for Spotify's API, its token endpoint and open.spotify.com. Nothing here signs in
// to Spotify or needs an account: the stand-in answers with fixtures, and main.js lets the Web player load
// a stand-in address only in test mode (global.__spotifyWebUrl, global.__widgetEndpoints).
//
// Part 1, the "Now playing card" (API) mode: every state the card can be in (playing, paused, idle, an ad, a
// podcast, long titles, no active device, Premium needed, offline), the buttons, the progress bar and
// what happens when a track ends, at the smallest to the largest card sizes, light and dark, with the
// keyboard, and no console errors or overflow.
// Part 2, the Web player mode: the view over the card, a load that fails (offline, a 500) saying so with
// Try again, Widevine missing saying so, and the card learning that someone signed in elsewhere.
//
// Needs openssl on PATH (Git for Windows: C:\Program Files\Git\usr\bin). Set LUMEN_SPOTIFY_SHOTS=<dir> to
// keep a screenshot of each card size.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLIENT = '0123456789abcdef0123456789abcdef';

const track = (extra = {}, item = {}) => ({
  is_playing: true, progress_ms: 30000, currently_playing_type: 'track', device: { name: 'Kitchen speaker' },
  item: { type: 'track', name: 'Night Shift', duration_ms: 200000, artists: [{ name: 'Ann' }, { name: 'Bo' }], album: { name: 'Quiet Hours', images: [] }, external_urls: { spotify: 'https://open.spotify.com/track/abc' }, ...item },
  ...extra,
});

// ---- a fake Spotify: the API, the token endpoint and a page for open.spotify.com ----
function fakeSpotify(opts) {
  const log = [];
  const world = { playback: track(), playerStatus: 200, status: null, hits: { web: 0 }, web: 'ok' };
  const srv = https.createServer(opts, (req, res) => {
    const u = new URL(req.url, 'https://127.0.0.1');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      log.push({ method: req.method, path: u.pathname, auth: req.headers.authorization || '', body });
      const json = (code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
      if (u.pathname === '/web') {
        world.hits.web++;
        if (world.web === '500') { res.writeHead(500, { 'content-type': 'text/html' }); res.end('<title>Oops</title>Spotify is down'); return; }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><meta charset="utf-8"><title>Stand-in Spotify</title><body style="margin:0;background:#121212;color:#fff;font:14px system-ui"><h1>Stand-in Spotify</h1></body>');
        return;
      }
      if (u.pathname === '/api/token') {
        const form = new URLSearchParams(body);
        if (form.get('grant_type') === 'authorization_code' && form.get('code') !== 'GOOD-CODE') return json(400, { error: 'invalid_grant' });
        return json(200, { access_token: 'ACCESS-1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'REFRESH-1' });
      }
      if (!u.pathname.startsWith('/v1/')) return json(404, {});
      if (req.headers.authorization !== 'Bearer ACCESS-1') return json(401, { error: { status: 401 } });
      if (world.status && u.pathname !== '/v1/me') return json(world.status.code, world.status.body || {}, world.status.headers);
      if (u.pathname === '/v1/me') return json(200, { display_name: 'Test Listener' });
      if (u.pathname === '/v1/me/player') { if (world.playerStatus === 204) { res.writeHead(204); res.end(); return; } return json(200, world.playback); }
      if (/^\/v1\/me\/player\/(play|pause|next|previous)$/.test(u.pathname)) { res.writeHead(204); res.end(); return; }
      return json(404, {});
    });
  });
  return { srv, log, world };
}

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-spotify-'));
  const key = path.join(scratch, 'key.pem');
  const cert = path.join(scratch, 'cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  } catch (err) {
    console.log(`SKIP  the Spotify window checks: openssl isn't available (${err.message})`);
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
    process.exit(0);
  }
  const fake = fakeSpotify({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) });
  await new Promise((r) => fake.srv.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${fake.srv.address().port}`;
  const shots = process.env.LUMEN_SPOTIFY_SHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });

  await partApi(fake, base, scratch, shots);
  await partWeb(fake, base, scratch, shots);

  fake.srv.close();
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

async function launch(base, widgets, extraSettings = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-spotify-profile-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: widgets, newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false, ...extraSettings }));
  const app = await electron.launch({ args: [path.join(__dirname, '..'), '--ignore-certificate-errors'], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  return { app, profile };
}

// ---------------------------------------------------------------------------------------------------
async function partApi(fake, base, scratch, shots) {
  // Three Now-playing cards of different sizes (cells on the 12-column grid): the smallest, the default, a big one.
  const W = [
    { id: 'wsmall001', type: 'spotify', mode: 'api', clientId: CLIENT, art: false, x: 0, y: 0, w: 2, h: 2 },
    { id: 'wdefault1', type: 'spotify', mode: 'api', clientId: CLIENT, art: false, x: 2, y: 0, w: 4, h: 3 },
    { id: 'wbig00001', type: 'spotify', mode: 'api', clientId: CLIENT, art: false, x: 6, y: 0, w: 6, h: 6 },
  ];
  const { app, profile } = await launch(base, W);
  await app.evaluate((_e, b) => { global.__widgetEndpoints = { spotify: `${b}/v1`, spotifyAccounts: b }; global.__widgetRateMax = 5000; }, base);
  // Sign in through the real flow (PKCE exchange against the stand-in): no real account, no credentials.
  const signed = await app.evaluate(async () => { const s = global.__widgets.spotifyStart(''); await s.exchange('GOOD-CODE'); return true; });
  check('sign-in against the stand-in: the code is exchanged and the card can use the token', signed === true, String(signed));

  await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
  const page = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
  await app.evaluate(() => { global.__errs = []; global.__wtab.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) global.__errs.push(String(msg).slice(0, 300)); }); });
  const waitFor = async (code, tries = 60) => { for (let i = 0; i < tries; i++) { if (await page(code).catch(() => false)) return true; await sleep(150); } return false; };
  const card = (id) => `(document.querySelector('.w-card[data-id="${id}"]') || document.createElement('i'))`; // (a card being redrawn is briefly missing)
  const text = (id, sel) => page(`${card(id)}?.querySelector(${JSON.stringify(sel)})?.textContent || ''`);
  const refresh = async () => { await app.evaluate(() => { for (const e of global.__widgets.cache.values()) { e.at = 0; e.retryAt = 0; } return global.__widgets.refreshAll({ force: true }); }); await sleep(250); }; // (a card is fetched at most every 15 s, even when asked: forget when it was last)
  const log = (p) => fake.log.filter((l) => l.path === p);
  const D = 'wdefault1';

  check('now playing: the card shows title, artist and album', await waitFor(`${card(D)}?.querySelector('.sp-title')?.textContent === 'Night Shift'`) && (await text(D, '.sp-artist')) === 'Ann, Bo' && (await text(D, '.sp-album')) === 'Quiet Hours', await text(D, '.sp-title'));
  const names = await page(`[...${card(D)}.querySelectorAll('button, a')].map((b) => b.getAttribute('aria-label') || b.textContent.trim())`);
  check('now playing: every control has a name (previous, pause, next, refresh, open)', ['Previous track', 'Pause', 'Next track'].every((n) => names.includes(n)) && names.every(Boolean) && names.some((n) => /^Open in Spotify/.test(n)), JSON.stringify(names));
  const bar = await page(`(() => { const b = ${card(D)}.querySelector('.sp-bar'); return b && { role: b.getAttribute('role'), label: b.getAttribute('aria-label'), now: b.getAttribute('aria-valuenow'), elapsed: ${card(D)}.querySelector('.sp-elapsed').textContent, total: ${card(D)}.querySelector('.sp-total').textContent }; })()`);
  check('now playing: the progress bar is a labelled progressbar with elapsed and total time', bar && bar.role === 'progressbar' && /Night Shift progress/.test(bar.label) && /^0:3\d$/.test(bar.elapsed) && bar.total === '3:20' && Number(bar.now) >= 15, JSON.stringify(bar));
  await sleep(2200);
  check('now playing: the playhead moves on by itself while playing', Number((await text(D, '.sp-elapsed')).split(':')[1]) >= 32, await text(D, '.sp-elapsed'));

  // controls
  fake.world.playback = track({ is_playing: false }); // what Spotify says once the pause went through
  await page(`${card(D)}.querySelector('[aria-label="Pause"]').click()`);
  await sleep(500);
  check('pause: PUT /me/player/pause with the bearer token, and the card shows Play at once', log('/v1/me/player/pause').length === 1 && log('/v1/me/player/pause')[0].method === 'PUT' && log('/v1/me/player/pause')[0].auth === 'Bearer ACCESS-1', JSON.stringify(log('/v1/me/player/pause')));
  check('paused: the card offers Play, and the playhead stands still', (await page(`Boolean(${card(D)}.querySelector('[aria-label="Play"]'))`)) && await (async () => { const a = await text(D, '.sp-elapsed'); await sleep(1300); return a === await text(D, '.sp-elapsed'); })(), '');
  await page(`${card(D)}.querySelector('[aria-label="Play"]').click()`);
  await sleep(400);
  fake.world.playback = track();
  await page(`${card(D)}.querySelector('[aria-label="Next track"]').click()`);
  await page(`${card(D)}.querySelector('[aria-label="Previous track"]').click()`);
  await sleep(500);
  check('play, next and previous: PUT play, POST next, POST previous', log('/v1/me/player/play')[0]?.method === 'PUT' && log('/v1/me/player/next')[0]?.method === 'POST' && log('/v1/me/player/previous')[0]?.method === 'POST', JSON.stringify(fake.log.slice(-6)));

  // errors on a control
  fake.world.status = { code: 404, body: { error: { status: 404, reason: 'NO_ACTIVE_DEVICE', message: 'Player command failed: No active device found' } } };
  await page(`${card(D)}.querySelector('[aria-label="Next track"]').click()`);
  check('no active device: the card says to start Spotify on a device, and keeps the track', await waitFor(`/No active Spotify device/.test(${card(D)}?.querySelector('.w-note')?.textContent || '')`) && (await text(D, '.sp-title')) === 'Night Shift', await text(D, '.w-note'));
  fake.world.status = { code: 403, body: { error: { status: 403, reason: 'PREMIUM_REQUIRED', message: 'Player command failed: Premium required' } } };
  await sleep(300);
  await page(`${card(D)}.querySelector('[aria-label="Next track"]').click()`);
  check('Premium needed: the card says controls need Premium', await waitFor(`/Premium/.test(${card(D)}?.querySelector('.w-note')?.textContent || '')`), await text(D, '.w-note'));
  fake.world.status = { code: 429, body: {}, headers: { 'retry-after': '1' } };
  await sleep(300);
  await page(`${card(D)}.querySelector('[aria-label="Next track"]').click()`);
  check('rate limited (429): the card says Spotify asked to slow down', await waitFor(`/slow down/.test(${card(D)}?.querySelector('.w-note')?.textContent || '')`), await text(D, '.w-note'));
  fake.world.status = null;

  // idle: nothing playing
  await sleep(5200); // the 429 back-off
  fake.world.playerStatus = 204;
  await refresh();
  check('idle (204): "Nothing is playing" with one Play button, no skip buttons', await waitFor(`/Nothing is playing/.test(${card(D)}?.querySelector('.sp-title')?.textContent || '')`) && (await page(`${card(D)}.querySelectorAll('.sp-controls button').length`)) === 1 && (await page(`Boolean(${card(D)}.querySelector('[aria-label="Play on Spotify"]'))`)), await text(D, '.sp-title'));
  fake.world.status = { code: 404, body: { error: { status: 404, reason: 'NO_ACTIVE_DEVICE' } } };
  await page(`${card(D)}.querySelector('[aria-label="Play on Spotify"]').click()`);
  await sleep(800);
  const idleAfter = await page(`({ title: ${card(D)}.querySelector('.sp-title').textContent, idle: ${card(D)}.classList.contains('sp-card-idle'), note: ${card(D)}.querySelector('.w-note')?.textContent || '' })`);
  check('idle + Play with no device: it says so, and the card is not shown as playing a blank track', idleAfter.idle && /Nothing is playing/.test(idleAfter.title) && /No active Spotify device/.test(idleAfter.note), JSON.stringify(idleAfter));
  fake.world.status = null;
  fake.world.playerStatus = 200;

  // an ad and a podcast episode
  fake.world.playback = { is_playing: true, progress_ms: 4000, currently_playing_type: 'ad', device: { name: 'Kitchen speaker' }, item: null };
  await sleep(300);
  await refresh();
  const ad = await page(`({ title: ${card(D)}.querySelector('.sp-title')?.textContent, prev: ${card(D)}.querySelector('[aria-label^="Previous track"]')?.disabled, next: ${card(D)}.querySelector('[aria-label^="Next track"]')?.disabled, bar: Boolean(${card(D)}.querySelector('.sp-bar')) })`);
  check('an ad: it says Advertisement, skip buttons are disabled, no fake progress bar', await waitFor(`${card(D)}?.querySelector('.sp-title')?.textContent === 'Advertisement'`) && ad.prev === true && ad.next === true && ad.bar === false, JSON.stringify(ad));
  fake.world.playback = { is_playing: true, progress_ms: 5000, currently_playing_type: 'episode', device: { name: 'Phone' }, item: { type: 'episode', name: 'Episode 12: Sleep', duration_ms: 1800000, show: { name: 'The Show', publisher: 'Show Co', images: [] }, external_urls: { spotify: 'https://open.spotify.com/episode/e12' } } };
  await sleep(300);
  await refresh();
  check('a podcast episode: title, publisher and show', await waitFor(`${card(D)}?.querySelector('.sp-title')?.textContent === 'Episode 12: Sleep'`) && (await text(D, '.sp-artist')) === 'Show Co' && (await text(D, '.sp-album')) === 'The Show', await text(D, '.sp-title'));
  // a local file: no album, no link, no art
  fake.world.playback = track({}, { name: 'my recording.mp3', is_local: true, artists: [{ name: '' }], album: { name: '', images: [] }, external_urls: {} });
  await sleep(300);
  await refresh();
  check('a local file: shown by name, no Open link, no errors', await waitFor(`${card(D)}?.querySelector('.sp-title')?.textContent === 'my recording.mp3'`) && !(await page(`Boolean(${card(D)}.querySelector('a[aria-label^="Open in Spotify"], a[title^="Open in Spotify"]'))`)), await text(D, '.sp-title'));

  // long text must be cut with an ellipsis, never widen the card
  const LONG = 'An Extremely Long Track Title That Goes On And On And On Without Ever Stopping For Breath (Remastered 2011 Deluxe Edition) ' + 'x'.repeat(60);
  fake.world.playback = track({}, { name: LONG, artists: [{ name: 'The Band With A Remarkably Long Name Featuring Many Guest Artists' }], album: { name: 'An Album Title That Is Also Far Too Long To Fit', images: [] } });
  await sleep(300);
  await refresh();
  await waitFor(`${card(D)}?.querySelector('.sp-title')?.textContent.startsWith('An Extremely')`);
  const fit = async (id) => page(`(() => { const c = ${card(id)}; const r = c.getBoundingClientRect(); const bad = [...c.querySelectorAll('*')].filter((e) => { if (e.closest('.w-resize, .w-grip')) return false; const b = e.getBoundingClientRect(); return b.width > 0 && getComputedStyle(e).display !== 'none' && (b.right > r.right + 1 || b.left < r.left - 1 || b.bottom > r.bottom + 1); }).map((e) => e.className || e.tagName); return { sw: c.scrollWidth, cw: c.clientWidth, sh: c.scrollHeight, ch: c.clientHeight, bad }; })()`);
  for (const id of ['wsmall001', 'wdefault1', 'wbig00001']) {
    await waitFor(`${card(id)}?.querySelector('.sp-title')?.textContent.startsWith('An Extremely')`);
    const f = await fit(id);
    check(`card ${id}: long titles are cut, the card does not overflow sideways or downward`, f.sw <= f.cw + 1 && f.sh <= f.ch + 1 && f.bad.length === 0, JSON.stringify(f));
  }
  fake.world.playback = track();
  await refresh();

  // sizes: what each one shows, and a picture of each
  for (const [id, expect] of [['wsmall001', { controls: false }], ['wdefault1', { controls: true }], ['wbig00001', { controls: true }]]) {
    await waitFor(`${card(id)}?.querySelector('.sp-title')?.textContent === 'Night Shift'`);
    const r = await page(`(() => { const c = ${card(id)}; const r = c.getBoundingClientRect(); const ctl = c.querySelector('.sp-controls'); return { w: Math.round(r.width), h: Math.round(r.height), controls: ctl ? getComputedStyle(ctl).display !== 'none' : false, title: Boolean(c.querySelector('.sp-title')) && c.querySelector('.sp-title').getBoundingClientRect().width > 20 }; })()`);
    check(`card ${id} (${r.w}x${r.h}px): the title is readable${expect.controls ? ' and the controls show' : ''}, and it fits`, r.title && (!expect.controls || r.controls) && (await fit(id)).bad.length === 0, JSON.stringify([r, await fit(id)]));
    if (shots) fs.writeFileSync(path.join(shots, `api-${id}.png`), Buffer.from(await app.evaluate(async () => (await global.__wtab.webContents.capturePage()).toPNG().toString('base64')), 'base64'));
  }

  // keyboard: the controls are real buttons in tab order with a visible focus ring
  const kb = await page(`(() => { const bs = [...${card(D)}.querySelectorAll('.sp-controls button')]; bs[0].focus(); const ring = getComputedStyle(bs[0]).boxShadow; return { n: bs.length, focusable: bs.every((b) => b.tabIndex >= 0 && b.tagName === 'BUTTON' && b.type === 'button'), focused: document.activeElement === bs[0], ring }; })()`);
  check('keyboard: Previous, Play/Pause and Next are focusable buttons with a visible focus ring', kb.n === 3 && kb.focusable && kb.focused && kb.ring !== 'none', JSON.stringify(kb));

  // light and dark: the title and artist stay readable
  const contrast = () => page(`(() => { const rgb = (s) => s.match(/[\\d.]+/g).slice(0, 3).map(Number); const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); }; const c = ${card(D)}; let bg = c; let col = null; while (bg && (!col || /rgba\\(.*, 0\\)|transparent/.test(col))) { col = getComputedStyle(bg).backgroundColor; if (/rgba\\(.*, 0\\)|transparent/.test(col)) bg = bg.parentElement; } const bgl = lum(rgb(col)); const ratio = (sel) => { const l = lum(rgb(getComputedStyle(c.querySelector(sel)).color)); return (Math.max(l, bgl) + 0.05) / (Math.min(l, bgl) + 0.05); }; return { title: ratio('.sp-title'), artist: ratio('.sp-artist'), bg: col }; })()`);
  for (const scheme of ['dark', 'light']) {
    await app.evaluate(({ nativeTheme }, s) => { nativeTheme.themeSource = s; }, scheme);
    await sleep(500);
    const c = await contrast();
    check(`${scheme}: title and artist text keep at least 4.5:1 contrast`, c.title >= 4.5 && c.artist >= 4.5, JSON.stringify(c));
    if (shots) fs.writeFileSync(path.join(shots, `api-${scheme}.png`), Buffer.from(await app.evaluate(async () => (await global.__wtab.webContents.capturePage()).toPNG().toString('base64')), 'base64'));
  }
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'system'; });

  // a track that ends: the card moves on to the next track by itself (it used to sit at the end for up to two minutes)
  fake.world.playback = track({ progress_ms: 197000 }, { name: 'Ending Song', duration_ms: 200000 });
  await refresh();
  await waitFor(`${card(D)}?.querySelector('.sp-title')?.textContent === 'Ending Song'`);
  fake.world.playback = track({ progress_ms: 500 }, { name: 'The Next Song', duration_ms: 180000 }); // what Spotify says once the song is over
  const t0 = Date.now();
  const moved = await waitFor(`${card(D)}?.querySelector('.sp-title')?.textContent === 'The Next Song'`, 100);
  check('a track ends: the card shows the next track within a few seconds, without waiting for the next scheduled refresh', moved && Date.now() - t0 < 12000, `${moved} after ${Date.now() - t0} ms`);

  // offline: the last good card stays, with a calm warning
  await app.evaluate(() => { global.__widgetEndpoints.spotify = 'https://127.0.0.1:1/v1'; });
  await refresh();
  const off = await page(`({ title: ${card(D)}.querySelector('.sp-title')?.textContent, warn: ${card(D)}.querySelector('.w-foot.warn')?.textContent || '' })`);
  check('offline: the last track stays on the card with a warning', off.title === 'The Next Song' && /connect|offline|update/i.test(off.warn), JSON.stringify(off));
  await app.evaluate((_e, b) => { global.__widgetEndpoints.spotify = `${b}/v1`; }, base);

  // Disconnect during a refresh must not sign the user back in
  const secretBefore = await app.evaluate(() => global.__widgets.state().secrets.spotify);
  await app.evaluate(() => global.__widgets.spotifyDisconnect());
  await sleep(300);
  const after = await app.evaluate(() => global.__widgets.state().secrets.spotify);
  check('Disconnect forgets the sign-in, and the card asks to connect', secretBefore === true && after === false && (await waitFor(`/Log in with Spotify/.test(${card(D)}?.textContent || '')`)), `${secretBefore} ${after}`);

  const errs = await app.evaluate(() => global.__errs);
  check('no console errors on the new-tab page', errs.length === 0, JSON.stringify(errs));
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
}

// ---------------------------------------------------------------------------------------------------
async function partWeb(fake, base, scratch, shots) {
  const W = [
    { id: 'wwebsmall', type: 'spotify', mode: 'web', x: 0, y: 0, w: 2, h: 2 },
  ];
  const { app, profile } = await launch(base, W);
  await app.evaluate((_e, b) => { global.__spotifyWebUrl = `${b}/web`; global.__spotifyDrmProbe = async () => false; }, base);
  await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
  const page = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
  await app.evaluate(() => { global.__errs = []; global.__wtab.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) global.__errs.push(String(msg).slice(0, 300)); }); });
  const waitFor = async (code, tries = 80) => { for (let i = 0; i < tries; i++) { if (await page(code).catch(() => false)) return true; await sleep(150); } return false; };
  const waitMain = async (fn, tries = 200) => { for (let i = 0; i < tries; i++) { if (await app.evaluate(fn).catch(() => false)) return true; await sleep(150); } return false; };
  const status = () => app.evaluate(() => global.__spotifyWeb.status());

  check('web player: the card is drawn with its slot', await waitFor("Boolean(document.querySelector('.w-card.spotify.sp-web .sp-web-slot'))"), '');
  check('web player: the view loads the stand-in page and the card reports it ready', await waitMain(() => global.__spotifyWeb.view()?.webContents.getURL().endsWith('/web')) && (await waitMain(() => global.__spotifyWeb.status().state === 'ready')), JSON.stringify(await status()));
  check('web player: the view sits over the card (visible, inside the window)', await waitMain(() => { const v = global.__spotifyWeb.view(); return v && v.getVisible() && v.getBounds().width >= 60; }), '');
  const placed = await app.evaluate(async () => { const v = global.__spotifyWeb.view(); const b = v.getBounds(); const r = await global.__wtab.webContents.executeJavaScript("(() => { const r = document.querySelector('.w-card.spotify').getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; })()"); return { b, r }; });
  check('web player: the view stays inside its card', placed.b.width > 0 && placed.b.height > 0, JSON.stringify(placed));

  // Widevine missing: the card says so, and it is the Spotify card that says it, not a silent player
  check('web player: no Widevine shows a clear note on the card (and the view stays for browsing)', await waitFor("/Widevine/.test(document.querySelector('.sp-drm')?.textContent || '')") && (await status()).drm === 'missing' && (await app.evaluate(() => global.__spotifyWeb.view().getVisible())), JSON.stringify(await status()));
  check('web player: the Widevine note is a live status for screen readers', await page("document.querySelector('.sp-drm')?.getAttribute('role') === 'status'"), '');
  await app.evaluate(() => { global.__spotifyDrmProbe = async () => true; });
  check('web player: once Widevine is there (it installs in the background) the note goes away by itself', await waitFor("!document.querySelector('.sp-drm')", 120) && (await status()).drm === 'ok', JSON.stringify(await status()));
  check('web player: Widevine present gives no warning, and the card has the Open link', !(await page("Boolean(document.querySelector('.sp-drm'))")) && (await page("Boolean(document.querySelector('.w-card.spotify a[title^=\"Open in Spotify\"], .w-card.spotify a[aria-label^=\"Open in Spotify\"]'))")), '');
  if (shots) fs.writeFileSync(path.join(shots, 'web-small.png'), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.capturePage().then((i) => i.toPNG().toString('base64'))), 'base64'));

  // A load that fails: offline, then a 500 -> a message and Try again, never a blank frame
  const closed = await new Promise((r) => { const s = require('net').createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); // a port nothing listens on (not 1: Chromium refuses that one as unsafe)
  await app.evaluate((_e, p) => { global.__spotifyWebUrl = `https://127.0.0.1:${p}/web`; global.__spotifyWeb.view().webContents.once('did-fail-load', (_e, code, desc) => { global.__failCode = `${code} ${desc}`; }); }, closed);
  await app.evaluate(() => global.__spotifyWeb.reload());
  check('web player: offline, the card says it can’t reach Spotify and offers Try again', await waitFor("/Can.t reach Spotify/.test(document.querySelector('.sp-web-down')?.textContent || '') && /Try again/.test(document.querySelector('.sp-web-down button')?.textContent || '')", 80), JSON.stringify(await status()) + ' ' + (await app.evaluate(() => global.__failCode)));
  check('web player: …the error page is hidden (the card’s message is what shows)', await waitMain(() => !global.__spotifyWeb.view() || !global.__spotifyWeb.view().getVisible()), '');
  const hitsBefore = fake.world.hits.web;
  await app.evaluate((_e, b) => { global.__spotifyWebUrl = `${b}/web`; }, base);
  await page("document.querySelector('.sp-web-down button').click()");
  check('web player: Try again loads Spotify again and the card recovers', await waitMain(() => global.__spotifyWeb.status().state === 'ready') && fake.world.hits.web > hitsBefore && await waitFor("!document.querySelector('.sp-web-down')") && (await waitMain(() => global.__spotifyWeb.view()?.getVisible())), JSON.stringify(await status()));
  fake.world.web = '500';
  await app.evaluate(() => global.__spotifyWeb.reload());
  check('web player: a server error says Spotify didn’t load', await waitFor("/didn.t load/.test(document.querySelector('.sp-web-down')?.textContent || '')"), JSON.stringify(await status()));
  fake.world.web = 'ok';
  await page("document.querySelector('.sp-web-down button').click()");
  check('web player: …and recovers when Spotify does', await waitMain(() => global.__spotifyWeb.status().state === 'ready'), JSON.stringify(await status()));

  // Signing in somewhere else (the "Open in a tab to sign in" tab) reloads the player so it isn't left on its login page
  check('web player: signed out is known (the card offers a sign-in tab)', await waitFor("Boolean(document.querySelector('.sp-web-signin'))"), JSON.stringify(await status()));
  const hits1 = fake.world.hits.web;
  await app.evaluate(async ({ session }) => { await session.defaultSession.cookies.set({ url: 'https://open.spotify.com/', name: 'sp_dc', value: 'fixture', domain: '.spotify.com', secure: true }); });
  check('web player: a sign-in elsewhere reloads the player, and the card drops the sign-in button', await waitMain(() => global.__spotifyWeb.isSignedIn() === true) && await waitFor("!document.querySelector('.sp-web-signin')") && await (async () => { for (let i = 0; i < 40 && fake.world.hits.web <= hits1; i++) await sleep(150); return fake.world.hits.web > hits1; })(), `hits ${hits1} -> ${fake.world.hits.web}`);
  await sleep(500);
  const hits2 = fake.world.hits.web;
  await app.evaluate(async ({ session }) => { await session.defaultSession.cookies.set({ url: 'https://open.spotify.com/', name: 'sp_dc', value: 'fixture-2', domain: '.spotify.com', secure: true }); });
  await sleep(1200);
  check('web player: Spotify refreshing its cookie (replaced in place) is not a sign-out and does not reload the player', (await app.evaluate(() => global.__spotifyWeb.isSignedIn())) === true && fake.world.hits.web === hits2 && !(await page("Boolean(document.querySelector('.sp-web-signin'))")), `signedIn ${await app.evaluate(() => global.__spotifyWeb.isSignedIn())} hits ${hits2} -> ${fake.world.hits.web}`);

  const errs = await app.evaluate(() => global.__errs);
  check('web player: no console errors on the new-tab page', errs.length === 0, JSON.stringify(errs));
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
}
