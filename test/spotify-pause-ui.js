// Pressing Pause / Play on the Spotify card in a real, hidden window, against a stand-in Spotify (an https server with a throwaway certificate) whose GET /me/player keeps
// answering the OLD state for 1.5 s after a press (what Spotify's API really does). The card's button is sampled every 50 ms inside the page: it must change once and stay
// (the old card showed Pause, Play, Pause again); a press Spotify never carries out goes back after about 3 s with a note. Nothing here reaches Spotify or uses an account.
// Needs openssl on PATH (Git for Windows: C:\Program Files\Git\usr\bin).
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

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-spotify-pause-'));
  const key = path.join(scratch, 'key.pem');
  const cert = path.join(scratch, 'cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  } catch (err) {
    console.log(`SKIP  the Spotify pause window checks: openssl isn't available (${err.message})`);
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
    process.exit(0);
  }
  const world = { playing: true, oldPlaying: true, changedAt: 0, lagMs: 1500, ignore: false, calls: [] };
  const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const u = new URL(req.url, 'https://127.0.0.1');
    req.on('data', () => {});
    req.on('end', () => {
      const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.pathname === '/api/token') return json(200, { access_token: 'ACCESS-1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'REFRESH-1' });
      const p = u.pathname.replace(/^\/v1/, '');
      if (p === '/me') return json(200, { display_name: 'Test Listener' });
      if (p === '/me/player/pause' || p === '/me/player/play') {
        world.calls.push(`${req.method} ${p}`);
        if (!world.ignore) { world.oldPlaying = world.playing; world.playing = p.endsWith('/play'); world.changedAt = Date.now(); }
        res.writeHead(204); res.end(); return;
      }
      if (p === '/me/player') {
        const shows = world.changedAt && Date.now() - world.changedAt < world.lagMs ? world.oldPlaying : world.playing;
        return json(200, { is_playing: shows, progress_ms: 30000, currently_playing_type: 'track', device: { name: 'Kitchen speaker', id: 'dev1' }, item: { type: 'track', id: 'T1', name: 'Night Shift', duration_ms: 200000, artists: [{ name: 'Ann' }], album: { name: 'Quiet Hours', images: [] }, external_urls: { spotify: 'https://open.spotify.com/track/T1' } } });
      }
      return json(404, {});
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${srv.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-spotify-pause-profile-'));
  const W = [{ id: 'wpause0001', type: 'spotify', mode: 'api', clientId: CLIENT, art: false, x: 0, y: 0, w: 4, h: 3 }];
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: W, newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false }));
  const app = await electron.launch({ args: [path.join(__dirname, '..'), '--ignore-certificate-errors'], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate((_e, b) => { global.__widgetEndpoints = { spotify: `${b}/v1`, spotifyAccounts: b }; global.__widgetRateMax = 5000; }, base);
    await app.evaluate(async () => { const s = global.__widgets.spotifyStart(''); await s.exchange('GOOD-CODE'); });
    await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
    const page = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
    const waitFor = async (code, tries = 80) => { for (let i = 0; i < tries; i++) { if (await page(code).catch(() => false)) return true; await sleep(150); } return false; };
    const card = '(document.querySelector(\'.w-card[data-id="wpause0001"]\') || document.createElement("i"))';
    const button = `(${card}.querySelector('[aria-label="Pause"]') ? 'P' : ${card}.querySelector('[aria-label="Play"]') ? 'L' : '?')`;
    check('the card shows a Pause button (playing)', await waitFor(`${button} === 'P'`), await page(`${card}.className + ' | ' + ${card}.innerText.slice(0, 300) + ' | ' + [...${card}.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')).join()`));
    // sampled inside the page every 50 ms, so the sampling itself adds no delay
    await page(`window.__s = []; window.__t = setInterval(() => window.__s.push(${button}), 50); 0`);
    const press = async (label, ms) => { await page('window.__s.length = 0; 0'); await page(`${card}.querySelector('[aria-label="${label}"]').click()`); await sleep(ms); return page('window.__s.join("")'); };

    const seen = await press('Pause', 3800);
    const first = seen.indexOf('L');
    check('pause, an API that keeps saying "playing" for 1.5 s: the button turns to Play at once and never goes back to Pause (50 ms samples)', first >= 0 && first <= 6 && !seen.slice(first).includes('P') && !seen.slice(first).includes('?'), seen.replace(/(.)\1+/g, '$1'));
    check('pause: one change only, no flicker', seen.replace(/(.)\1+/g, '$1') === 'PL' || seen.replace(/(.)\1+/g, '$1') === 'L', seen.replace(/(.)\1+/g, '$1'));
    check('pause: Spotify was sent PUT /me/player/pause and the card ends on Play with no error note', world.calls.includes('PUT /me/player/pause') && (await page(`${button}`)) === 'L' && !(await page(`/didn.t pause/.test(${card}.innerText)`)), world.calls.join());

    const seen2 = await press('Play', 3800);
    const first2 = seen2.indexOf('P');
    check('play, the same lag: the button turns to Pause at once and stays', first2 >= 0 && first2 <= 6 && !seen2.slice(first2).includes('L'), seen2.replace(/(.)\1+/g, '$1'));
    check('play: Spotify was sent PUT /me/player/play and the card ends on Pause', world.calls.includes('PUT /me/player/play') && (await page(`${button}`)) === 'P', world.calls.join());

    // a pause Spotify never carries out
    world.ignore = true;
    const seen3 = await press('Pause', 5200);
    const flat3 = seen3.replace(/(.)\1+/g, '$1');
    check('a pause Spotify never carries out: Play for about 3 s, then the button goes back to Pause', flat3 === 'PLP' || flat3 === 'LP', flat3);
    check('...and the card says "It didn\'t pause. Try again."', await page(`/didn.t pause/.test(${card}.innerText)`), await page(`${card}.innerText.slice(0, 300)`));
    await page('clearInterval(window.__t); 0');
  } finally {
    await app.close().catch(() => {});
    srv.close();
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
