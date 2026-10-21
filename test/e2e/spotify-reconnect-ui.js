// The Spotify card's Reconnect / Connect button in a real, hidden window against a stand-in Spotify on this machine (an https server with a throwaway certificate that
// also plays Spotify's authorize page). Nothing here reaches Spotify or uses an account.
//   Part 1, a card connected before the Home tab (no user-top-read): the Home tab shows "Reconnect Spotify to show more"; pressing the button starts Spotify's sign-in
//     at once (the authorize address with every scope, user-top-read included, PKCE, the loopback redirect), the stand-in approves, and the card shows Home with the
//     top artists. No Settings page is opened.
//   Part 2, Play as Lumen (the default mode) with no account connected: the Home tab says Spotify has to be connected, its button starts the same sign-in; Lumen's own app
//     lists 25 accounts only, and when Spotify refuses this one the card says so plainly and offers the user's own app (the card's editor); then, allowed, Home shows.
// Needs openssl on PATH (Git for Windows: C:\Program Files\Git\usr\bin). Port 43917 (Spotify's registered loopback address) must be free.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const SV = require('../../src/features/spotify-view');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLIENT = '0123456789abcdef0123456789abcdef';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1200, 5)]);
const img = (id) => [{ url: `https://i.scdn.co/image/${id}`, width: 300, height: 300 }];
const album = (n) => ({ id: `AL${n}`, type: 'album', name: `Album ${n}`, artists: [{ name: 'Ann' }], images: img(`al${n}`) });

function fakeSpotify(opts, world) {
  const srv = https.createServer(opts, (req, res) => {
    const u = new URL(req.url, 'https://127.0.0.1');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.pathname.startsWith('/img/')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return; }
      if (u.pathname === '/authorize') { // Spotify's page: approve at once and go back to the loopback address with a code
        world.authorize.push(Object.fromEntries(u.searchParams));
        world.granted = new Set(String(u.searchParams.get('scope') || '').split(' '));
        res.writeHead(302, { location: `${u.searchParams.get('redirect_uri')}?code=GOOD-CODE&state=${u.searchParams.get('state')}` });
        res.end();
        return;
      }
      if (u.pathname === '/api/token') {
        world.tokenCalls++;
        const form = new URLSearchParams(body);
        if (form.get('grant_type') === 'authorization_code' && form.get('code') !== 'GOOD-CODE') return json(400, { error: 'invalid_grant' });
        if (world.notListed && form.get('grant_type') === 'authorization_code') return json(403, { error: 'access_denied', error_description: 'User not registered in the Developer Dashboard' });
        return json(200, { access_token: `ACCESS-${world.tokenCalls}`, token_type: 'Bearer', expires_in: 3600, refresh_token: 'REFRESH-1' });
      }
      if (!u.pathname.startsWith('/v1/')) return json(404, {});
      const p = u.pathname.replace(/^\/v1/, '');
      if (p === '/me') return json(200, { display_name: 'Test Listener' });
      if (p === '/me/player') { res.writeHead(204); res.end(); return; }
      if (p === '/me/player/recently-played') return json(200, { items: [{ track: { id: 'T1', type: 'track', name: 'Song 1', duration_ms: 1000, artists: [{ name: 'Ann' }], album: album(1) }, context: null }] });
      if (p === '/me/top/artists') {
        if (!world.granted.has('user-top-read')) return json(403, { error: { status: 403, message: 'Insufficient client scope' } });
        return json(200, { items: [{ id: 'AR2', type: 'artist', name: 'Top Artist', images: img('ar2') }] });
      }
      if (p === '/me/playlists') return json(200, { items: [], next: null });
      return json(404, {});
    });
  });
  return srv;
}

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-spotify-reconnect-'));
  const key = path.join(scratch, 'key.pem');
  const cert = path.join(scratch, 'cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  } catch (err) {
    console.log(`SKIP  the Spotify reconnect window checks: openssl isn't available (${err.message})`);
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
    process.exit(0);
  }
  try {
    await part(1, scratch, key, cert);
    await part(2, scratch, key, cert);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

async function part(n, scratch, key, cert) {
  const world = { authorize: [], granted: new Set(), tokenCalls: 0, notListed: false };
  const srv = fakeSpotify({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, world);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${srv.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-spotify-reconnect-profile-'));
  const W = [{ id: 'wrecon0001', type: 'spotify', mode: n === 1 ? 'api' : 'status', clientId: n === 1 ? CLIENT : '', art: true, x: 0, y: 0, w: 8, h: 8 }];
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: W, newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false }));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..'), '--ignore-certificate-errors'], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  const label = n === 1 ? 'connected before Home' : 'Play as Lumen, not connected';
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate((_e, b) => {
      global.__widgetEndpoints = { spotify: `${b}/v1`, spotifyAccounts: b };
      global.__widgetRateMax = 5000;
      global.__widgetFetchMap = (url) => { const u = new URL(url); return /(^|\.)scdn\.co$/.test(u.hostname) ? `${b}/img/${u.pathname.split('/').pop()}` : url; };
      // (Play as Lumen: the player's own page is not needed here; an idle engine that says it can search)
      global.__spotifyEngineFake = {
        read: async () => ({ mode: 'status', state: 'idle', title: '', artist: '', album: '', progressMs: 0, durationMs: 0, at: Date.now(), source: 'engine', kind: 'none', reason: '', art: '', signedIn: true, can: { search: true, library: true } }),
        warm() {}, refreshLists() {}, command: () => true, signIn() {}, showPlayer() {}, search() {}, reload() {},
      };
    }, base);
    if (n === 1) { // connected the way the first release did: without user-top-read
      await app.evaluate(async () => { const s = global.__widgets.spotifyStart(''); await s.exchange('GOOD-CODE'); });
      world.authorize.length = 0;
    }
    await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
    const page = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
    const waitFor = async (code, tries = 100) => { for (let i = 0; i < tries; i++) { if (await page(code).catch(() => false)) return true; await sleep(150); } return false; };
    const card = '(document.querySelector(\'.w-card[data-id="wrecon0001"]\') || document.createElement("i"))';
    const tabsBefore = await app.evaluate(() => 0).catch(() => 0);

    check(`${label}: the card has a Home tab`, await waitFor(`Boolean(${card}.querySelector('.mc-tab-home:not([hidden])'))`), await page(`[...${card}.querySelectorAll('.mc-tab')].map((t) => t.dataset.tab + (t.hidden ? '(hidden)' : '')).join()`));
    await page(`${card}.querySelector('.mc-tab-home')?.click()`);
    if (n === 1) {
      await app.evaluate(async () => { await global.__widgets.act({ id: 'wrecon0001', do: 'ehome', arg: 'topartists' }); });
      check('part 1: the missing permission shows the bar "Reconnect Spotify to show more" with a Reconnect Spotify button', await waitFor(`/Reconnect Spotify to show more/.test(${card}.querySelector('.hm-banner')?.innerText || '')`) && (await page(`${card}.querySelector('.hm-banner button').textContent`)) === 'Reconnect Spotify', await page(`${card}.querySelector('.mc-panel-home')?.innerText.slice(0, 300)`));
    } else {
      check('part 2: with no account connected the Home tab says Spotify has to be connected, with a Connect Spotify button, and draws no shelves', await waitFor(`/has to be connected/.test(${card}.querySelector('.hm-banner')?.innerText || '')`) && (await page(`${card}.querySelector('.hm-banner button').textContent`)) === 'Connect Spotify' && (await page(`${card}.querySelectorAll('.hm-sec').length`)) === 0, await page(`${card}.querySelector('.mc-panel-home')?.innerText.slice(0, 300)`));
      // ---- Spotify refuses this account: Lumen's own app lists 25 people ----
      world.notListed = true;
      await page(`${card}.querySelector('.hm-banner button').click()`);
      check('part 2, an account that is not on Lumen\'s app list: the card says so plainly and offers the user\'s own Spotify app', await waitFor(`/isn.t on the list for Lumen.s own Spotify app/.test(${card}.querySelector('.hm-banner')?.innerText || '') && /25 people/.test(${card}.querySelector('.hm-banner').innerText)`, 120) && (await page(`[...${card}.querySelectorAll('.hm-banner button')].map((b) => b.textContent).join('|')`)).includes('Use my own Spotify app'), await page(`${card}.querySelector('.mc-panel-home')?.innerText.slice(0, 400)`));
      world.notListed = false;
      world.authorize.length = 0;
    }

    // ---- the button starts the sign-in at once ----
    await app.evaluate(() => { global.__widgets.state(); }); // (clears a pending "open this card's editor" request, if any)
    await page(`[...${card}.querySelectorAll('.hm-banner button')].find((b) => /Reconnect Spotify|Connect Spotify/.test(b.textContent)).click()`);
    check(`${label}: pressing it opens Spotify's authorize page (the stand-in) at once`, await waitFor('true') && await (async () => { for (let i = 0; i < 100 && !world.authorize.length; i++) await sleep(150); return world.authorize.length >= 1; })(), JSON.stringify(world.authorize));
    const a = world.authorize[0] || {};
    const want = SV.SCOPES.split(' ');
    check(`${label}: the authorize address has every scope, user-top-read included, PKCE (S256) and the registered loopback redirect`, want.every((s) => String(a.scope || '').split(' ').includes(s)) && String(a.scope).split(' ').includes('user-top-read') && a.code_challenge_method === 'S256' && Boolean(a.code_challenge) && a.redirect_uri === SV.REDIRECT_URI && a.response_type === 'code' && !('client_secret' in a), JSON.stringify(a));
    const editorAsked = await app.evaluate(() => global.__widgets.state().edit || null);
    check(`${label}: no detour through Settings (the card's editor was not asked for)`, editorAsked === null, JSON.stringify(editorAsked));
    check(`${label}: the code is traded for a token (the stand-in's token endpoint was asked)`, await (async () => { for (let i = 0; i < 100 && world.tokenCalls < (n === 1 ? 2 : 2); i++) await sleep(150); return world.tokenCalls >= 2; })(), String(world.tokenCalls));

    // ---- the card shows Home ----
    await page(`${card}.querySelector('.mc-tab-home')?.click()`);
    for (let i = 0; i < 30; i++) { await page(`(() => { const p = ${card}.querySelector('.mc-panel-home'); if (p) p.scrollTop += 100; })()`); await sleep(150); }
    check(`${label}: the bar is gone and Home shows its shelves, the top artists with a cover`, await waitFor(`!${card}.querySelector('.hm-banner') && Boolean(${card}.querySelector('[data-shelf="topartists"] img.hm-cover')) && Boolean(${card}.querySelector('[data-shelf="quick"]'))`, 120), await page(`${card}.querySelector('.mc-panel-home')?.innerText.slice(0, 400)`));
    void tabsBefore;
  } finally {
    await app.close().catch(() => {});
    srv.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
}
