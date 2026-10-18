// The Spotify card (Web API mode) in a real, hidden window against a stand-in Spotify on this machine (an https server with a throwaway certificate; Spotify's
// picture hosts are mapped to it by the test seam global.__widgetFetchMap). Nothing here signs in to Spotify, reads an account or reaches the network.
//   - Home: every shelf draws, each tile with its cover (checked by a pixel probe: albums are red, playlists green, artists blue, songs' covers orange), keeps the order of
//     Spotify's Home; a tile plays when pressed, a song's queue button queues it, a missing scope shows "Reconnect Spotify to show more", a refused shelf is left out;
//   - Queue: the right request, "Added to the queue", and with no active device a message that says what to do;
//   - Pictures: album, artist and playlist covers (real JPEGs of the sizes Spotify sends, 160-300 px) show in the Library and Home;
//   - Library: both pages of the playlists load, saved albums (an answer over 1 MB) load, and an expired token is refreshed.
// Needs openssl on PATH (Git for Windows: C:\Program Files\Git\usr\bin). Run it hidden: LUMEN_TEST_BACKGROUND=1 (set below).
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLIENT = '0123456789abcdef0123456789abcdef';
// What each picture is painted with, by the id prefix in its address (the probe reads the colour back from the page).
const COLORS = { al: [220, 40, 40], pl: [40, 190, 60], ar: [40, 80, 220], tr: [240, 150, 20] };

const img = (prefix, id, ws) => ws.map((w) => ({ url: `https://i.scdn.co/image/${prefix}-${id}-${w}`, width: w, height: w }));
const album = (n) => ({ id: `AL${n}`, type: 'album', name: `Album ${n}`, artists: [{ name: 'Ann' }], release_date: '2024-01-01', images: img('al', n, [640, 300, 64]) });
const track = (n, al = n) => ({ id: `T${n}`, type: 'track', name: `Song ${n}`, duration_ms: 200000, artists: [{ name: 'Ann' }], album: { ...album(al), images: img('tr', n, [640, 300, 64]) } });
const playlist = (id, name, owner = 'someone') => ({ id, type: 'playlist', name, owner: { id: owner, display_name: owner }, images: [{ url: `https://mosaic.scdn.co/640/pl-${id}`, width: null, height: null }] });

function fakeSpotify(opts, world) {
  const log = [];
  const srv = https.createServer(opts, (req, res) => {
    const u = new URL(req.url, 'https://127.0.0.1');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.pathname.startsWith('/img/')) { // (Spotify's picture hosts, mapped here: /img/<prefix>-<id>-<width>)
        log.push({ method: 'GET', path: u.pathname, body: '' });
        const m = /^\/img\/(al|pl|ar|tr)-[^-]*(?:-(\d+))?$/.exec(u.pathname); // (a playlist's picture has no width in its address: its one size is 300)
        const jpeg = m && world.images[`${m[1]}-${m[2] || 300}`];
        if (!jpeg) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end(jpeg);
        return;
      }
      if (u.pathname === '/api/token') {
        const form = new URLSearchParams(body);
        world.tokens++;
        if (form.get('grant_type') === 'authorization_code') return form.get('code') === 'GOOD-CODE' ? json(200, { access_token: 'ACCESS-1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'REFRESH-1' }) : json(400, { error: 'invalid_grant' });
        return json(200, { access_token: `ACCESS-${world.tokens}`, token_type: 'Bearer', expires_in: 3600 });
      }
      if (!u.pathname.startsWith('/v1/')) return json(404, {});
      const p = u.pathname.replace(/^\/v1/, '');
      log.push({ method: req.method, path: p + u.search, body });
      const bearer = String(req.headers.authorization || '');
      if (world.expired && bearer === 'Bearer ACCESS-1') return json(401, { error: { status: 401, message: 'The access token expired' } });
      if (world.deny[p]) return json(world.deny[p], world.deny[p] === 403 ? { error: { status: 403, message: 'Insufficient client scope' } } : {});
      if (p === '/me') return json(200, { display_name: 'Test Listener' });
      if (p === '/me/player') { res.writeHead(204); res.end(); return; }
      if (p === '/me/player/devices') return json(200, { devices: [] });
      if (p === '/me/player/queue' && req.method === 'POST') {
        if (world.noDevice) return json(404, { error: { status: 404, message: 'Player command failed: No active device found', reason: 'NO_ACTIVE_DEVICE' } });
        res.writeHead(204); res.end(); return;
      }
      if (p === '/me/player/play') { res.writeHead(204); res.end(); return; }
      if (p === '/me/player/recently-played') return json(200, { items: Array.from({ length: 8 }, (_, i) => ({ track: track(i + 1, Math.floor(i / 2) + 1), played_at: 'x', context: { type: 'album', uri: `spotify:album:AL${Math.floor(i / 2) + 1}` } })) });
      if (p === '/me/playlists') {
        const off = Number(u.searchParams.get('offset') || 0);
        if (off === 0) { // (page one: 4 made-for-you and your own, then 46 more; page two: 50 more)
          const items = [playlist('MIX1', 'Daily Mix 1', 'spotify'), playlist('MIX2', 'Discover Weekly', 'spotify'), playlist('HITS', 'Today’s Top Hits', 'spotify'), playlist('MINE', 'Road trip', 'me'), ...Array.from({ length: 46 }, (_, i) => playlist(`P${i}`, `Playlist ${i}`, 'me'))];
          return json(200, { items, next: 'https://api.spotify.com/v1/me/playlists?offset=50&limit=50' });
        }
        return json(200, { items: Array.from({ length: 50 }, (_, i) => playlist(`Q${i}`, `Playlist ${50 + i}`, 'me')), next: null });
      }
      if (p === '/me/albums') {
        const items = Array.from({ length: 50 }, (_, i) => ({ added_at: 'x', album: { ...album(100 + i), name: `Saved Album ${i}`, tracks: { total: 40, items: Array.from({ length: 40 }, (_, k) => ({ id: `ST${i}_${k}`, name: `Track ${k} of album ${i} with a realistic length of name`, duration_ms: 1, track_number: k + 1, artists: [{ name: 'Ann', id: 'a', href: 'https://api.spotify.com/v1/artists/a', uri: 'spotify:artist:a', external_urls: { spotify: 'https://open.spotify.com/artist/a' } }], href: `https://api.spotify.com/v1/tracks/ST${i}_${k}`, uri: `spotify:track:ST${i}_${k}`, external_urls: { spotify: 'https://open.spotify.com/track/x' } })) } } }));
        return json(200, { items, next: null });
      }
      if (p === '/me/tracks') return json(200, { items: [{ track: track(50) }], next: null });
      if (p === '/me/following') return json(200, { artists: { items: [{ id: 'AR1', type: 'artist', name: 'Followed Artist', images: img('ar', 1, [640, 320, 160]) }], next: null } });
      if (p === '/me/top/artists') return json(200, { items: [{ id: 'AR2', type: 'artist', name: 'Top Artist', images: img('ar', 2, [640, 320, 160]) }, { id: 'AR3', type: 'artist', name: 'Top Artist Two', images: img('ar', 3, [640, 320, 160]) }] });
      if (p === '/me/top/tracks') return json(200, { items: [track(21), track(22)] });
      if (p === '/browse/new-releases') return json(200, { albums: { items: [album(31), album(32)] } });
      return json(404, {});
    });
  });
  return { srv, log };
}

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-spotify-home-'));
  const key = path.join(scratch, 'key.pem');
  const cert = path.join(scratch, 'cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  } catch (err) {
    console.log(`SKIP  the Spotify Home window checks: openssl isn't available (${err.message})`);
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
    process.exit(0);
  }
  const world = { deny: {}, noDevice: false, expired: false, tokens: 1, images: {} };
  const fake = fakeSpotify({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, world);
  await new Promise((r) => fake.srv.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${fake.srv.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-spotify-home-profile-'));
  const W = [{ id: 'wbig00001', type: 'spotify', mode: 'api', clientId: CLIENT, art: true, x: 0, y: 0, w: 8, h: 8 }];
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: W, newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false }));
  const app = await electron.launch({ args: [path.join(__dirname, '..'), '--ignore-certificate-errors'], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    // Real JPEGs of the sizes Spotify sends, made by the app's own image code: a base colour with noise (so they weigh what real covers weigh).
    const made = await app.evaluate(({ nativeImage }, colors) => {
      const out = {};
      const sizes = { al: [300, 64], pl: [300], ar: [160], tr: [300, 64] };
      for (const [prefix, list] of Object.entries(sizes)) {
        for (const size of list) {
          const buf = Buffer.alloc(size * size * 4);
          const [r, g, b] = colors[prefix];
          let seed = 12345 + size;
          for (let i = 0; i < size * size; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; const n = (seed >> 16) % 25 - 12; buf[i * 4] = Math.max(0, Math.min(255, b + n)); buf[i * 4 + 1] = Math.max(0, Math.min(255, g + n)); buf[i * 4 + 2] = Math.max(0, Math.min(255, r + n)); buf[i * 4 + 3] = 255; }
          out[`${prefix}-${size}`] = nativeImage.createFromBitmap(buf, { width: size, height: size }).toJPEG(90).toString('base64');
        }
      }
      return out;
    }, COLORS);
    for (const [k, v] of Object.entries(made)) world.images[k] = Buffer.from(v, 'base64');
    const sizes = Object.fromEntries(Object.entries(world.images).map(([k, v]) => [k, v.length]));
    console.log(`INFO  picture sizes: ${JSON.stringify(sizes)} (the card takes a data: URL under 12000 characters = 9 KB)`);
    await app.evaluate((_e, b) => {
      global.__widgetEndpoints = { spotify: `${b}/v1`, spotifyAccounts: b };
      global.__widgetRateMax = 5000;
      // Spotify's picture hosts are https on port 443; here they are the local server.
      global.__widgetFetchMap = (url) => { const u = new URL(url); return /(^|\.)scdn\.co$/.test(u.hostname) ? `${b}/img/${u.pathname.split('/').pop()}` : url; };
    }, base);
    const signed = await app.evaluate(async () => { const s = global.__widgets.spotifyStart(''); await s.exchange('GOOD-CODE'); return true; });
    check('sign-in against the stand-in', signed === true, String(signed));

    await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
    const page = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
    await app.evaluate(() => { global.__errs = []; global.__wtab.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) global.__errs.push(String(msg).slice(0, 300)); }); });
    const waitFor = async (code, tries = 80) => { for (let i = 0; i < tries; i++) { if (await page(code).catch(() => false)) return true; await sleep(150); } return false; };
    const soft = async (name, fn) => { try { await fn(); } catch (e) { check(`${name}: the checks ran`, false, String(e.message).split(String.fromCharCode(10))[0]); } }; // (a missing Home tab fails its own checks, the rest still run)
    const card = '(document.querySelector(\'.w-card[data-id="wbig00001"]\') || document.createElement("i"))';
    const logOf = (pred) => fake.log.filter(pred);
    // A probe of a picture: the colour at its centre as the page draws it (decoded by Chromium, not by us).
    const PROBE = `(img) => new Promise((res) => { const go = () => { const c = document.createElement('canvas'); c.width = 8; c.height = 8; const x = c.getContext('2d'); x.drawImage(img, 0, 0, 8, 8); const d = x.getImageData(4, 4, 1, 1).data; res([d[0], d[1], d[2]]); }; if (img.complete && img.naturalWidth) go(); else img.onload = go; })`;
    const near = (got, want) => Array.isArray(got) && got.every((v, i) => Math.abs(v - want[i]) <= 40);
    const colorsOf = (selector) => page(`Promise.all([...${card}.querySelectorAll(${JSON.stringify(selector)})].map((i) => (${PROBE})(i)))`);

    await waitFor(`${card}.dataset.tier === 'xl' || ${card}.dataset.tier === 'large'`);
    const tier = await page(`${card}.dataset.tier`);
    check('the card is a large one (tabs shown)', tier === 'large' || tier === 'xl', tier);
    check('the Home tab exists and is the first tab (nothing is playing)', await waitFor(`Boolean(${card}.querySelector('.mc-tab-home:not([hidden])'))`) && (await page(`${card}.querySelector('.mc-tab[role=tab]:not([hidden])').dataset.tab`)) === 'home', await page(`[...${card}.querySelectorAll('.mc-tab')].map((t) => t.dataset.tab + (t.hidden ? '(hidden)' : '')).join()`));
    await page(`${card}.querySelector('.mc-tab-home')?.click()`);

    // ---- Home: shelves, lazily ----
    await soft('Home shelves', async () => {
      check('Home: the greeting and the quick picks (albums played recently) draw, each with its cover', await waitFor(`${card}.querySelectorAll('.hm-quick img.hm-cover').length === 4`), await page(`${card}.querySelector('.mc-panel-home')?.innerText.slice(0, 300)`));
      check('Home: the greeting says Good morning, afternoon or evening', /^Good (morning|afternoon|evening)$/.test(await page(`${card}.querySelector('.hm-greet')?.textContent || ''`)), await page(`${card}.querySelector('.hm-greet')?.textContent`));
      const quickColors = await colorsOf('.hm-quick img.hm-cover');
      check('Home: the quick picks\' covers really are the pictures of the albums the played songs are on (pixel probe: orange)', quickColors.length === 4 && quickColors.every((c) => near(c, COLORS.tr)), JSON.stringify(quickColors));
      // the shelves further down are asked for when scrolled to
      const shelvesBefore = await page(`[...${card}.querySelectorAll('.hm-sec')].map((s) => s.dataset.shelf).join()`);
      // (scrolled down the way a reader does: a bit at a time, so every shelf passes through the view)
      for (let i = 0; i < 40; i++) { await page(`(() => { const p = ${card}.querySelector('.mc-panel-home'); p.scrollTop += 120; })()`); await sleep(150); }
      await sleep(500);
      const shelves = await page(`[...${card}.querySelectorAll('.hm-sec')].map((s) => s.dataset.shelf)`);
      check('Home: the shelves of Spotify\'s Home are there in its order (quick picks, jump back in, made for you, recently played, top songs, top artists, new releases, your playlists, albums, artists you follow), those with nothing left out', ['quick', 'made', 'recent', 'toptracks', 'topartists', 'new', 'playlists', 'albums', 'artists'].every((k) => shelves.includes(k)) && shelves.indexOf('made') < shelves.indexOf('recent') && shelves.indexOf('recent') < shelves.indexOf('topartists') && shelves.indexOf('topartists') < shelves.indexOf('new') && shelves.indexOf('new') < shelves.indexOf('playlists'), `${shelvesBefore} -> ${shelves.join()}`);
      const covers = (shelf) => colorsOf(`[data-shelf="${shelf}"] .hm-row img.hm-cover`);
      check('Home: made for you shows the Spotify-owned mixes only, as playlist covers (pixel probe: green)', await waitFor(`${card}.querySelectorAll('[data-shelf="made"] .hm-tile').length === 2 && ${card}.querySelectorAll('[data-shelf="made"] img.hm-cover').length === 2`) && (await covers('made')).every((c) => near(c, COLORS.pl)), await page(`${card}.querySelector('[data-shelf=made]')?.innerText`));
      check('Home: top artists (blue, round) and recently played songs (orange) have their covers too', await waitFor(`${card}.querySelectorAll('[data-shelf="topartists"] img.hm-cover').length === 2 && ${card}.querySelectorAll('[data-shelf="recent"] img.hm-cover').length === 8`) && (await covers('topartists')).every((c) => near(c, COLORS.ar)) && (await covers('recent')).every((c) => near(c, COLORS.tr)), JSON.stringify([await covers('topartists'), await covers('recent')]));
      check('Home: new releases and your albums have covers (red)', await waitFor(`${card}.querySelectorAll('[data-shelf="new"] img.hm-cover').length === 2 && ${card}.querySelectorAll('[data-shelf="albums"] img.hm-cover').length >= 1`) && (await covers('new')).every((c) => near(c, COLORS.al)), '');
      const tileInfo = await page(`(() => { const t = ${card}.querySelector('[data-shelf="recent"] .hm-tile'); return { title: t.querySelector('.hm-title').textContent, sub: t.querySelector('.hm-sub').textContent, label: t.querySelector('.hm-main').getAttribute('aria-label'), queue: t.querySelector('.hm-queue')?.getAttribute('aria-label'), play: Boolean(t.querySelector('.hm-play')), tag: t.querySelector('.hm-main').tagName }; })()`);
      check('Home: a tile has its title, subtitle, a play button and (a song) a queue button, all with names for the keyboard and screen readers', tileInfo.title === 'Song 1' && tileInfo.sub === 'Ann' && tileInfo.label === 'Play Song 1' && tileInfo.queue === 'Add Song 1 to the queue' && tileInfo.play && tileInfo.tag === 'BUTTON', JSON.stringify(tileInfo));
      const rowInfo = await page(`(() => { const r = ${card}.querySelector('[data-shelf="recent"] .hm-row'); return { overflowX: getComputedStyle(r).overflowX, scrolls: r.scrollWidth > r.clientWidth, buttons: [...${card}.querySelectorAll('[data-shelf="recent"] .hm-scroll')].map((b) => b.getAttribute('aria-label')) }; })()`);
      check('Home: a shelf scrolls sideways (overflow-x, with left and right buttons)', rowInfo.overflowX === 'auto' && rowInfo.scrolls && rowInfo.buttons.length === 2 && /left/.test(rowInfo.buttons[0]) && /right/.test(rowInfo.buttons[1]), JSON.stringify(rowInfo));
      const lazy = logOf((l) => /\/me\/top\/artists/.test(l.path)).length;
      check('Home: each source was read once (not once per shelf, not again on redraws)', logOf((l) => l.path.startsWith('/me/player/recently-played')).length === 1 && logOf((l) => l.path.startsWith('/me/playlists?limit=50')).length === 1 && lazy === 1, JSON.stringify(fake.log.map((l) => l.path).filter((p) => !p.startsWith('/img'))));
  
    });

    // ---- play and queue from a tile ----
    await soft('Home tiles', async () => {
      await page(`${card}.querySelector('[data-shelf="made"] .hm-main').click()`);
      await sleep(500);
      const plays = logOf((l) => l.path === '/me/player/play');
      check('Home: pressing a playlist tile plays that playlist (PUT /me/player/play with its context_uri)', plays.length >= 1 && JSON.parse(plays[plays.length - 1].body).context_uri === 'spotify:playlist:MIX1', JSON.stringify(plays));
      await page(`${card}.querySelector('[data-shelf="quick"] .hm-main').click()`);
      await sleep(500);
      check('Home: pressing a quick pick plays that album', JSON.parse(logOf((l) => l.path === '/me/player/play').pop().body).context_uri === 'spotify:album:AL1', '');
      await page(`${card}.querySelector('[data-shelf="recent"] .hm-queue').click()`);
      await sleep(600);
      const queues = logOf((l) => l.path.startsWith('/me/player/queue'));
      check('Queue: a song tile\'s queue button sends POST /me/player/queue with the song uri, and the card says it was added', queues.length === 1 && queues[0].method === 'POST' && queues[0].path === '/me/player/queue?uri=spotify%3Atrack%3AT1' && await waitFor(`/Added to the queue/.test(${card}.innerText)`), JSON.stringify(queues));
      world.noDevice = true;
      await page(`${card}.querySelectorAll('[data-shelf="recent"] .hm-queue')[1].click()`);
      check('Queue, no active device: the card says to open Spotify on a device and play something', await waitFor(`/No active Spotify device\\. Open Spotify on a phone, computer or speaker/.test(${card}.innerText)`), await page(`[...${card}.querySelectorAll('.w-note')].map((n) => n.textContent).join('|') + ' // ' + ${card}.innerText.slice(0, 300)`));
    });
    world.noDevice = false;

    // ---- Queue (no Home needed): the request, the note, and a failed press shows its own message instead of the last press's "Added" ----
    const textNow = () => page(`${card}.innerText`);
    await app.evaluate(async () => { await global.__widgets.act({ id: 'wbig00001', do: 'playlater', kind: 'song', item: 'T40' }); });
    check('Queue: POST /me/player/queue?uri=spotify:track:T40 is sent and the card says "Added to the queue."', logOf((l) => l.path === '/me/player/queue?uri=spotify%3Atrack%3AT40' && l.method === 'POST').length === 1 && await waitFor(`/Added to the queue/.test(${card}.innerText)`), await textNow());
    world.noDevice = true;
    await app.evaluate(async () => { await global.__widgets.act({ id: 'wbig00001', do: 'playlater', kind: 'song', item: 'T41' }); });
    await sleep(800); // (the next look at the player comes meanwhile)
    const afterFail = await textNow();
    check('Queue, no active device: the card says what to do (open Spotify on a phone, computer or speaker and play something) and not "Added"', /No active Spotify device. Open Spotify on a phone, computer or speaker/.test(afterFail) && !/Added to the queue/.test(afterFail), afterFail.slice(0, 500));
    world.noDevice = false;


    // ---- Library: pages, big answers, pictures, an expired token ----
    world.expired = true; // (the first token is refused: the card refreshes it and goes on)
    await page(`${card}.querySelector('.mc-tab-library').click()`);
    const lp = `${card}.querySelector('.mc-panel-library')`;
    check('Library: the first rows (Liked Songs, then playlists) show, after the expired token was refreshed', await waitFor(`${lp}.querySelectorAll('.lv-row').length >= 40`, 120), `${await page(`${lp}.querySelectorAll('.lv-row').length`)} rows; tokens=${world.tokens}`);
    for (let i = 0; i < 40 && !(await page(`/Playlist 99/.test(${lp}.innerText)`)); i++) { await page(`${lp}.scrollTop = ${lp}.scrollHeight`); await sleep(200); }
    check('Library: the second page of playlists (Playlist 99) is read as the list scrolls', await page(`/Playlist 99/.test(${lp}.innerText)`), (await page(`${lp}.innerText`)).slice(0, 200));
    await page(`[...${lp}.querySelectorAll('.lv-chip')][1].click()`);
    check('Library: the saved albums (an answer over 1 MB) show under the Albums chip', await waitFor(`/Saved Album 0/.test(${lp}.innerText)`, 120) && (await page(`${lp}.querySelectorAll('.lv-row').length`)) >= 50, (await page(`${lp}.innerText`)).slice(0, 200));
    check('Library: the token was refreshed (a new token was asked for) and the library did not stay empty', world.tokens >= 2, String(world.tokens));
    await page(`[...${lp}.querySelectorAll('.lv-chip')][0].click()`);
    await page(`${lp}.scrollTop = 0`);
    check('Library: the rows have pictures (a playlist: pixel probe green)', await waitFor(`${lp}.querySelectorAll('img.lv-cover').length >= 4`, 120), String(await page(`${lp}.querySelectorAll('img.lv-cover').length`)));
    const libThumbs = await page(`Promise.all([...${lp}.querySelectorAll('.lv-row')].filter((r) => r.querySelector('img.lv-cover')).slice(0, 8).map(async (r) => ({ title: r.querySelector('.lv-title').textContent, color: await (${PROBE})(r.querySelector('img.lv-cover')) })))`);
    const wantFor = (title) => (/^Playlist|Daily|Discover|Road|Today/.test(title) ? COLORS.pl : COLORS.tr);
    check('Library: each row\'s picture is its own kind\'s cover', libThumbs.length >= 4 && libThumbs.every((t) => near(t.color, wantFor(t.title))), JSON.stringify(libThumbs));
    world.expired = false;

    // ---- a missing scope ----
    await soft('Home missing scope', async () => {
      world.deny['/me/top/artists'] = 403;
      await page(`${card}.querySelector('.mc-tab-home')?.click()`);
      // (a new read: the page asks for the top artists again after the minute's cache; force it through the action the Try again path uses)
      await app.evaluate(async () => { const w = global.__widgets; const e = [...w.cache.values()][0]; void e; await w.act({ id: 'wbig00001', do: 'ehome', arg: 'topartists', force: true }); });
      check('Home, missing scope (user-top-read): the card says "Reconnect Spotify to show more" with a button, and the other shelves stay', await waitFor(`Boolean(${card}.querySelector('.hm-banner'))`) && /Reconnect Spotify to show more/.test(await page(`${card}.querySelector('.hm-banner').innerText`)) && (await page(`${card}.querySelector('.hm-banner button').textContent`)) === 'Reconnect Spotify' && (await page(`${card}.querySelectorAll('.hm-sec').length`)) >= 5, await page(`${card}.querySelector('.mc-panel-home').innerText.slice(0, 300)`));
      check('Home: a shelf that failed for its scope is not drawn (no empty or faked rows)', (await page(`${card}.querySelectorAll('[data-shelf="topartists"]').length`)) === 0, '');
    });
    const errs = await app.evaluate(() => global.__errs);
    check('no console errors in the page', errs.length === 0, JSON.stringify(errs));
  } finally {
    await app.close().catch(() => {});
    fake.srv.close();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
