// The Spotify card's Library in a real, hidden window against a stand-in Spotify on this machine (an https server with a throwaway certificate; Spotify's picture hosts are
// mapped to it by the test seam global.__widgetFetchMap). Nothing here reaches Spotify or uses an account.
//   - the list: Liked Songs first (with its count), then ALL 130 playlists across three pages (read as the list scrolls), the filter chips and the filter box;
//   - a playlist of 260 places opens in the card: header, Play / Shuffle, its songs paged in as you scroll, each with its picture (pixel probe);
//   - clicking song N plays it inside the playlist (context_uri + offset N); hover actions (play, queue); Liked Songs plays in its collection context;
//   - Back (the button and Esc) returns to the list at the same scroll position.
// Needs openssl on PATH (Git for Windows: C:\Program Files\Git\usr\bin). Run it hidden: LUMEN_TEST_BACKGROUND=1.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLIENT = '0123456789abcdef0123456789abcdef';
const COLORS = { pl: [40, 190, 60], tr: [240, 150, 20] }; // (playlist covers green, song covers orange)

const img = (prefix, id, ws) => ws.map((w) => ({ url: `https://i.scdn.co/image/${prefix}-${id}-${w}`, width: w, height: w }));
const track = (n) => ({ id: `T${n}`, type: 'track', name: `Song ${n}`, duration_ms: 180000 + n * 1000, artists: [{ name: `Artist ${n % 7}` }], album: { name: `Album ${n % 5}`, images: img('tr', n, [640, 300, 64]) } });
const playlist = (id, name, owner = 'me', total = 10) => ({ id, type: 'playlist', name, owner: { id: owner, display_name: owner }, images: [{ url: `https://mosaic.scdn.co/640/pl-${id}`, width: null, height: null }], items: { total } });

function fakeSpotify(opts, world) {
  const srv = https.createServer(opts, (req, res) => {
    const u = new URL(req.url, 'https://127.0.0.1');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.pathname.startsWith('/img/')) {
        const m = /^\/img\/(pl|tr)-[^-]*(?:-(\d+))?$/.exec(u.pathname);
        const jpeg = m && world.images[`${m[1]}-${m[2] || 300}`];
        if (!jpeg) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end(jpeg);
        return;
      }
      if (u.pathname === '/api/token') return json(200, { access_token: 'ACCESS-1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'REFRESH-1' });
      if (!u.pathname.startsWith('/v1/')) return json(404, {});
      const p = u.pathname.replace(/^\/v1/, '');
      world.log.push({ method: req.method, path: p + u.search, body });
      const off = Number(u.searchParams.get('offset') || 0);
      if (p === '/me') return json(200, { id: 'ME1', display_name: 'Test Listener' });
      if (p === '/me/player') { res.writeHead(204); res.end(); return; }
      if (p === '/me/playlists') {
        const all = [...Array.from({ length: 128 }, (_, i) => playlist(`P${i}`, `Playlist ${i}`, i % 10 === 0 ? 'spotify' : 'me')), playlist('BIG', 'The big one', 'me', 260), playlist('EMPTY', 'Empty', 'me', 0)];
        return json(200, { items: all.slice(off, off + 50), total: all.length, next: off + 50 < all.length ? `https://api.spotify.com/v1/me/playlists?offset=${off + 50}&limit=50` : null });
      }
      if (p === '/me/tracks') {
        const limit = Number(u.searchParams.get('limit') || 20);
        return json(200, { items: Array.from({ length: Math.max(0, Math.min(limit, 120 - off)) }, (_, i) => ({ added_at: 'x', track: track(1000 + off + i) })), total: 120, next: null });
      }
      if (p === '/me/albums') return json(200, { items: [{ album: { id: 'AL1', type: 'album', name: 'Saved One', artists: [{ name: 'Ann' }], total_tracks: 3, images: img('tr', 5, [300]) } }], total: 1, next: null });
      if (p === '/me/following') return json(200, { artists: { items: [{ id: 'AR1', type: 'artist', name: 'Followed Artist', images: img('tr', 6, [160]) }], total: 1, next: null } });
      if (p === '/playlists/BIG/items') {
        const total = 260;
        return json(200, { items: Array.from({ length: Math.max(0, Math.min(50, total - off)) }, (_, i) => ({ item: track(off + i) })), total, next: null });
      }
      if (p === '/me/player/devices') return json(200, { devices: [] });
      if (p === '/me/player/play' || p === '/me/player/queue' || p === '/me/player/shuffle') { res.writeHead(204); res.end(); return; }
      return json(404, {});
    });
  });
  return srv;
}

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-spotify-library-'));
  const key = path.join(scratch, 'key.pem');
  const cert = path.join(scratch, 'cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  } catch (err) {
    console.log(`SKIP  the Spotify Library window checks: openssl isn't available (${err.message})`);
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
    process.exit(0);
  }
  const world = { log: [], images: {} };
  const srv = fakeSpotify({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, world);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${srv.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-spotify-library-profile-'));
  const W = [{ id: 'wlibr00001', type: 'spotify', mode: 'api', clientId: CLIENT, art: false, x: 0, y: 0, w: 8, h: 8 }];
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: W, newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false }));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..'), '--ignore-certificate-errors'], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const made = await app.evaluate(({ nativeImage }, colors) => {
      const out = {};
      for (const [prefix, sizes] of Object.entries({ pl: [300], tr: [300, 160, 64] })) {
        for (const size of sizes) {
          const buf = Buffer.alloc(size * size * 4);
          const [r, g, b] = colors[prefix];
          let seed = 99 + size;
          for (let i = 0; i < size * size; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; const n = (seed >> 16) % 25 - 12; buf[i * 4] = Math.max(0, Math.min(255, b + n)); buf[i * 4 + 1] = Math.max(0, Math.min(255, g + n)); buf[i * 4 + 2] = Math.max(0, Math.min(255, r + n)); buf[i * 4 + 3] = 255; }
          out[`${prefix}-${size}`] = nativeImage.createFromBitmap(buf, { width: size, height: size }).toJPEG(90).toString('base64');
        }
      }
      return out;
    }, COLORS);
    for (const [k, v] of Object.entries(made)) world.images[k] = Buffer.from(v, 'base64');
    await app.evaluate((_e, b) => {
      global.__widgetEndpoints = { spotify: `${b}/v1`, spotifyAccounts: b };
      global.__widgetRateMax = 5000;
      global.__widgetFetchMap = (url) => { const u = new URL(url); return /(^|\.)scdn\.co$/.test(u.hostname) ? `${b}/img/${u.pathname.split('/').pop()}` : url; };
    }, base);
    await app.evaluate(async () => { const s = global.__widgets.spotifyStart(''); await s.exchange('GOOD-CODE'); });
    await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
    const page = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
    await app.evaluate(() => { global.__errs = []; global.__wtab.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) global.__errs.push(String(msg).slice(0, 300)); }); });
    const waitFor = async (code, tries = 120) => { for (let i = 0; i < tries; i++) { if (await page(code).catch(() => false)) return true; await sleep(150); } return false; };
    const card = '(document.querySelector(\'.w-card[data-id="wlibr00001"]\') || document.createElement("i"))';
    const panel = `${card}.querySelector('.mc-panel-library')`;
    const logOf = (pred) => world.log.filter(pred);
    const PROBE = '(img) => new Promise((res) => { const go = () => { const c = document.createElement("canvas"); c.width = 8; c.height = 8; const x = c.getContext("2d"); x.drawImage(img, 0, 0, 8, 8); const d = x.getImageData(4, 4, 1, 1).data; res([d[0], d[1], d[2]]); }; if (img.complete && img.naturalWidth) go(); else img.onload = go; })';
    const near = (got, want) => Array.isArray(got) && got.every((v, i) => Math.abs(v - want[i]) <= 40);
    const scrollPanelTo = (y) => page(`(() => { ${panel}.scrollTop = ${y}; return ${panel}.scrollTop; })()`);
    // The list is read as it scrolls: scroll down the way a reader does until it stops growing.
    const scrollToEnd = async (rowSel, want, steps = 60) => { for (let i = 0; i < steps; i++) { await page(`(() => { const p = ${panel}; p.scrollTop = p.scrollHeight; })()`); await sleep(200); if ((await page(`${panel}.querySelectorAll(${JSON.stringify(rowSel)}).length`)) >= want) return true; } return false; };

    check('the card is a large one with a Library tab', await waitFor(`Boolean(${card}.querySelector('.mc-tab-library:not([hidden])'))`), await page(`[...${card}.querySelectorAll('.mc-tab')].map((t) => t.dataset.tab + (t.hidden ? '(hidden)' : '')).join()`));
    await page(`${card}.querySelector('.mc-tab-library').click()`);

    // ---- the list ----
    check('Library: Liked Songs is pinned first, with its count (120 songs), then the playlists', await waitFor(`/Liked Songs/.test(${panel}.querySelector('.lv-row')?.innerText || '') && /120 songs/.test(${panel}.querySelector('.lv-row')?.innerText || '') && ${panel}.querySelectorAll('.lv-row').length >= 40`), await page(`${panel}?.innerText.slice(0, 300)`));
    const first = await page(`[...${panel}.querySelectorAll('.lv-row')].slice(0, 3).map((r) => r.querySelector('.lv-title').textContent)`);
    check('Library: the first rows are Liked Songs, Playlist 0, Playlist 1 (Spotify\'s order)', first[0] === 'Liked Songs' && first[1] === 'Playlist 0' && first[2] === 'Playlist 1', JSON.stringify(first));
    check('Library: reading as it scrolls: every playlist across the three pages (130 + Liked Songs = 131 rows)', await scrollToEnd('.lv-row', 131 + 1 - 1), String(await page(`${panel}.querySelectorAll('.lv-row').length`)));
    const ids = await page(`[...${panel}.querySelectorAll('.lv-row')].map((r) => r.dataset.key)`);
    check('Library: all 130 playlists, each once, and nothing more (the old two-page cap is gone)', ids.length === 131 && new Set(ids).size === 131 && ids.includes('playlist:BIG') && ids.includes('playlist:EMPTY') && logOf((l) => l.path.startsWith('/me/playlists?offset=')).length === 2, `${ids.length} reads=${JSON.stringify(logOf((l) => l.path.startsWith('/me/playlists')).map((l) => l.path))}`);
    const chips = await page(`[...${card}.querySelectorAll('.lv-chip')].map((c) => c.textContent + (c.getAttribute('aria-pressed') === 'true' ? '*' : ''))`);
    check('Library: the filter chips Playlists, Albums, Artists (Playlists pressed)', JSON.stringify(chips) === JSON.stringify(['Playlists*', 'Albums', 'Artists']), JSON.stringify(chips));
    await page(`[...${card}.querySelectorAll('.lv-chip')][1].click()`);
    check('Library: the Albums chip shows the saved albums', await waitFor(`/Saved One/.test(${panel}.querySelector('.lv-body')?.innerText || '')`), await page(`${panel}.innerText.slice(0, 200)`));
    await page(`[...${card}.querySelectorAll('.lv-chip')][2].click()`);
    check('Library: the Artists chip shows the followed artists', await waitFor(`/Followed Artist/.test(${panel}.querySelector('.lv-body')?.innerText || '')`), await page(`${panel}.innerText.slice(0, 200)`));
    await page(`[...${card}.querySelectorAll('.lv-chip')][0].click()`);
    await waitFor(`${panel}.querySelectorAll('.lv-row').length >= 131`);

    // ---- the filter ----
    await page(`(() => { const i = ${panel}.querySelector('.lv-filter'); i.focus(); i.value = 'playlist 12'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const filtered = await waitFor(`[...${panel}.querySelectorAll('.lv-row .lv-title')].map((t) => t.textContent).join('|') === 'Playlist 12|Playlist 120|Playlist 121|Playlist 122|Playlist 123|Playlist 124|Playlist 125|Playlist 126|Playlist 127'`);
    check('Library: the filter box keeps the rows whose name matches ("playlist 12": Playlist 12 and 120 to 127; Liked Songs is not one)', filtered, await page(`[...${panel}.querySelectorAll('.lv-row .lv-title')].map((t) => t.textContent).join('|')`));
    await page(`(() => { const i = ${panel}.querySelector('.lv-filter'); i.value = 'zzz nothing'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    check('Library: a filter nothing matches says so', await waitFor(`/matches that/.test(${panel}.querySelector('.lv-body')?.innerText || '')`), await page(`${panel}.querySelector('.lv-body')?.innerText`));
    await page(`(() => { const i = ${panel}.querySelector('.lv-filter'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await waitFor(`${panel}.querySelectorAll('.lv-row').length >= 131`);

    // ---- pictures in the list ----
    await scrollPanelTo(0);
    check('Library: the rows have their covers (a playlist\'s picture, pixel probe green)', await waitFor(`${panel}.querySelectorAll('img.lv-cover').length >= 4`), String(await page(`${panel}.querySelectorAll('img.lv-cover').length`)));
    const colors = await page(`Promise.all([...${panel}.querySelectorAll('.lv-row img.lv-cover')].slice(0, 6).map((i) => (${PROBE})(i)))`);
    check('Library: ...and they are the pictures of the playlists (green)', colors.length >= 4 && colors.every((c) => near(c, COLORS.pl)), JSON.stringify(colors));

    // ---- back keeps the scroll ----
    const at = await scrollPanelTo(900);
    await sleep(300);
    check('Library: the list can be scrolled down', at >= 700, String(at));
    await page(`[...${panel}.querySelectorAll('.lv-row')].find((r) => r.dataset.key === 'playlist:P41').click()`);
    check('opening an item (Playlist 41) shows its header (name, owner, 10 songs), Play and Shuffle and a Back button', await waitFor(`${panel}.querySelector('.lv-name')?.textContent === 'Playlist 41'`) && /By me/.test(await page(`${panel}.querySelector('.lv-meta')?.innerText || ''`)) && (await page(`[...${panel}.querySelectorAll('.lv-actions button')].map((b) => b.textContent).join()`)) === 'Play,Shuffle' && (await page(`Boolean(${panel}.querySelector('.lv-back'))`)), JSON.stringify(await page(`${panel}.innerText.slice(0, 200)`)) + JSON.stringify(await page(`${panel}.querySelector('.lv-meta')?.innerText`)));
    await page(`${panel}.querySelector('.lv-back').click()`);
    check('Back returns to the list at the same scroll position', await waitFor(`${panel}.querySelectorAll('.lv-row').length >= 131 && Math.abs(${panel}.scrollTop - ${at}) <= 3`), `scrollTop ${await page(`${panel}.scrollTop`)} (was ${at})`);

    // ---- a big playlist: paging, covers, playing a song inside it ----
    await scrollPanelTo(0);
    await page(`[...${panel}.querySelectorAll('.lv-row')].find((r) => r.dataset.key === 'playlist:BIG').click()`);
    check('opening a 260-song playlist: the header and the first songs (numbered, with title, artist, album and length)', await waitFor(`${panel}.querySelector('.lv-name')?.textContent === 'The big one' && ${panel}.querySelectorAll('.lv-track').length >= 40`), await page(`${panel}.innerText.slice(0, 300)`));
    const row0 = await page(`(() => { const r = ${panel}.querySelector('.lv-track'); return { num: r.querySelector('.lv-num').textContent, title: r.querySelector('.lv-title').textContent, sub: r.querySelector('.lv-sub').textContent, dur: r.querySelector('.lv-dur').textContent, label: r.querySelector('.lv-row').getAttribute('aria-label') }; })()`);
    check('a song row: number, title, artist and album, length, and a name for screen readers', row0.num === '1' && row0.title === 'Song 0' && /Artist 0 · Album 0/.test(row0.sub) && /^3:00$/.test(row0.dur) && row0.label === 'Play Song 0 from The big one', JSON.stringify(row0));
    const firstCount = await page(`${panel}.querySelectorAll('.lv-track').length`);
    check('the first page only: 50 songs read, the rest come as you scroll', firstCount <= 55 && logOf((l) => l.path.startsWith('/playlists/BIG/items')).length >= 1, `${firstCount} rows`);
    check('the songs have their covers (pixel probe: orange)', await waitFor(`${panel}.querySelectorAll('.lv-track img.lv-cover').length >= 5`) && (await page(`Promise.all([...${panel}.querySelectorAll('.lv-track img.lv-cover')].slice(0, 5).map((i) => (${PROBE})(i)))`)).every((c) => near(c, COLORS.tr)), String(await page(`${panel}.querySelectorAll('.lv-track img.lv-cover').length`)));
    check('scrolling pages in the rest: all 260 songs', await scrollToEnd('.lv-track', 260), `${await page(`${panel}.querySelectorAll('.lv-track').length`)} rows, reads=${logOf((l) => l.path.startsWith('/playlists/BIG/items')).length}`);
    check('each page was read once (offsets 0, 50, 100, 150, 200, 250)', JSON.stringify(logOf((l) => l.path.startsWith('/playlists/BIG/items')).map((l) => Number(new URL(l.path, 'https://x').searchParams.get('offset')))) === '[0,50,100,150,200,250]', JSON.stringify(logOf((l) => l.path.startsWith('/playlists/BIG/items')).map((l) => l.path)));
    // click song N
    await page(`[...${panel}.querySelectorAll('.lv-track')].find((r) => r.querySelector('.lv-title').textContent === 'Song 120').querySelector('.lv-row').click()`);
    await sleep(600);
    const plays = logOf((l) => l.path === '/me/player/play');
    const lastPlay = plays.length ? JSON.parse(plays[plays.length - 1].body) : null;
    check('clicking song 120 plays it inside the playlist: PUT /me/player/play with context_uri spotify:playlist:BIG and offset 120', lastPlay && lastPlay.context_uri === 'spotify:playlist:BIG' && lastPlay.offset && lastPlay.offset.position === 120, JSON.stringify(plays.map((p) => p.body)));
    // hover actions: the queue button of a row
    await page(`[...${panel}.querySelectorAll('.lv-track')].find((r) => r.querySelector('.lv-title').textContent === 'Song 7').querySelector('.lv-q').click()`);
    await sleep(600);
    check('a row\'s hover action Queue adds that song to the queue (POST /me/player/queue)', logOf((l) => l.path === '/me/player/queue?uri=spotify%3Atrack%3AT7' && l.method === 'POST').length === 1, JSON.stringify(logOf((l) => l.path.startsWith('/me/player/queue'))));
    await page(`[...${panel}.querySelectorAll('.lv-track')].find((r) => r.querySelector('.lv-title').textContent === 'Song 9').querySelector('.lv-play').click()`);
    await sleep(500);
    check('a row\'s hover action Play plays it in the playlist too (offset 9)', JSON.parse(logOf((l) => l.path === '/me/player/play').pop().body).offset.position === 9, '');
    // Play / Shuffle
    await page(`[...${panel}.querySelectorAll('.lv-actions button')][1].click()`);
    await sleep(500);
    check('Shuffle: shuffle is turned on and the playlist plays from its start', logOf((l) => l.path === '/me/player/shuffle?state=true').length === 1 && !('offset' in JSON.parse(logOf((l) => l.path === '/me/player/play').pop().body)), '');
    // back with Escape
    await page(`${panel}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    check('Esc goes back to the library (Backspace does too)', await waitFor(`!${panel}.querySelector('.lv-name') && ${panel}.querySelectorAll('.lv-row').length >= 131`), JSON.stringify(await page(`[${panel}.querySelectorAll('.lv-row').length, Boolean(${panel}.querySelector('.lv-name')), ${panel}.innerText.slice(0, 100)]`)));

    // ---- Liked Songs ----
    await scrollPanelTo(0);
    await page(`${panel}.querySelector('.lv-row[data-key="liked:liked"]').click()`);
    check('Liked Songs opens like a playlist: its name, 120 songs, the first page', await waitFor(`${panel}.querySelector('.lv-name')?.textContent === 'Liked Songs' && ${panel}.querySelectorAll('.lv-track').length >= 40`) && /120 songs/.test(await page(`${panel}.querySelector('.lv-meta')?.innerText || ''`)), await page(`${panel}.innerText.slice(0, 200)`));
    check('Liked Songs: the rest pages in (120)', await scrollToEnd('.lv-track', 120), String(await page(`${panel}.querySelectorAll('.lv-track').length`)));
    await page(`[...${panel}.querySelectorAll('.lv-track')].find((r) => r.querySelector('.lv-title').textContent === 'Song 1007').querySelector('.lv-row').click()`);
    await sleep(600);
    const lp = JSON.parse(logOf((l) => l.path === '/me/player/play').pop().body);
    check('Liked Songs plays in its collection context: spotify:user:ME1:collection with offset 7', lp.context_uri === 'spotify:user:ME1:collection' && lp.offset.position === 7, JSON.stringify(lp));
    await page(`${panel}.querySelector('.lv-back').click()`);
    check('Back from Liked Songs returns to the list', await waitFor(`!${panel}.querySelector('.lv-name') && ${panel}.querySelectorAll('.lv-row').length >= 131`), '');
    const errs = await app.evaluate(() => global.__errs);
    check('no console errors in the page', errs.length === 0, JSON.stringify(errs));
  } finally {
    await app.close().catch(() => {});
    srv.close();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
