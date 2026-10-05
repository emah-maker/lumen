// The Spotify engine against the REAL open.spotify.com, signed out (needs the network; SKIPs without it; nothing here signs in or needs an
// account). What it shows: the hidden page loads, the preload injects the bridge, the card offers Sign in, the page's own markup that the
// selector table targets (which selectors a signed-out page has), that "no player controls" is NOT mistaken for a changed page when signed
// out, whether anything can be searched or played signed out, and the sign-in window with Spotify's own login page in it. Signed-in
// behaviour (the playbar's testids, mediaSession, Connect) can't be checked without an account: test/spotify-engine-ui.js uses a stand-in.
// Set LUMEN_APPLEMUSIC_SHOTS=<dir> to keep screenshots.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SPB = require('../src/features/spotify-bridge');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.LUMEN_APPLEMUSIC_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });

(async () => {
  try { const r = await fetch('https://open.spotify.com/', { method: 'HEAD', signal: AbortSignal.timeout(8000) }); if (r.status >= 500) throw new Error(String(r.status)); } catch (err) { console.log(`SKIP  the real open.spotify.com checks: not reachable (${err.message})`); return; }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-spotify-real-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: [{ id: 'wsp0000001', type: 'spotify', mode: 'status', x: 0, y: 0, w: 5, h: 5 }], newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false }));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await app.evaluate(() => { global.__playerMissingMs = 4000; });
  await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
  const page = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
  const waitFor = async (code, tries = 120) => { for (let i = 0; i < tries; i++) { if (await page(code).catch(() => false)) return true; await sleep(250); } return false; };
  const engine = (code) => app.evaluate((_e, c) => global.__spotifyWeb.webContents().executeJavaScript(c), code);
  const status = () => app.evaluate(() => global.__spotifyEngine.status());
  const card = `(document.querySelector('.w-card[data-id="wsp0000001"]') || document.createElement('i'))`;
  const shot = async (name) => { if (shots) fs.writeFileSync(path.join(shots, name), Buffer.from(await app.evaluate(async () => (await global.__wtab.webContents.capturePage()).toPNG().toString('base64')), 'base64')); };

  const t0 = Date.now();
  check('real: the engine page loads and the bridge says ready', await (async () => { for (let i = 0; i < 160; i++) { if ((await status()).ready) return true; await sleep(250); } return false; })(), JSON.stringify(await status()));
  console.log(`      (${Date.now() - t0} ms from launch to the bridge being ready)`);
  check('real: the view is hidden (never shown for a status card)', await app.evaluate(() => { const v = global.__spotifyWeb.view(); return Boolean(v) && !v.getVisible(); }), '');
  check('real: signed out (no sp_dc cookie) is known, and the card offers Sign in', (await status()).signedIn === false && await waitFor(`Boolean(${card}.querySelector('.am-signin')) && /Sign in to Spotify/.test(${card}.querySelector('.am-signin').textContent)`), JSON.stringify(await status()));
  await shot('spotify-real-signed-out.png');

  // what the signed-out page has of what the table looks for
  await sleep(6000);
  const found = await engine(`(() => { const sel = ${JSON.stringify(SPB.SELECTORS)}; const out = {}; for (const k of Object.keys(sel)) out[k] = sel[k].filter((s) => { try { return Boolean(document.querySelector(s)); } catch { return false; } }).length; return JSON.stringify({ found: out, mediaSession: Boolean(navigator.mediaSession && navigator.mediaSession.metadata), media: document.querySelectorAll('audio,video').length, footer: Boolean(document.querySelector('footer')), title: document.title }); })()`);
  console.log(`      (signed-out page: ${found})`);
  const f = JSON.parse(found);
  check('real: a signed-out page has a (preview) playbar the table finds, but no mediaSession and no media element: nothing is playing', f.found.playPause >= 1 && !f.mediaSession && f.media === 0, found);
  check('real: …and a signed-out page is never reported as "Spotify changed its page" (waited past the shortened limit)', (await status()).signedIn === false && !(await page(`/changed its page/.test(${card}.textContent)`)), JSON.stringify(await status()));

  // search signed out: the card says to sign in; the bridge's navigation finds no rows and says so
  await page(`${card}.querySelector('.am-searchbtn').click()`);
  await page(`(() => { const i = ${card}.querySelector('.am-searchfield input'); i.value = 'shake it off'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  check('real: signed out, the search panel says playing needs a sign-in', await waitFor(`/Sign in to Spotify to play/.test(${card}.querySelector('.am-pop')?.textContent || '')`, 40), await page(`${card}.querySelector('.am-pop')?.textContent || ''`));
  await sleep(8000);
  const afterSearch = await engine(`JSON.stringify({ path: location.pathname, rows: document.querySelectorAll('[data-testid="tracklist-row"]').length })`);
  console.log(`      (signed-out search page through the page's router: ${afterSearch})`);
  check('real: the search went through the page\'s own router (no reload; it is now on the search route)', /\/search\/shake/.test(JSON.parse(afterSearch).path), afterSearch);
  const results = await app.evaluate(async () => (await global.__spotifyEngine.read()).results);
  console.log(`      (results signed out: ${results.length}; first: ${JSON.stringify(results.slice(0, 3).map((r) => [r.kind, r.title, r.sub, r.ms]))}; kinds: ${[...new Set(results.map((r) => r.kind))].join()})`);
  check('real: searching signed out through the page\'s own search route returns real results (songs first, with artist and length), from the page\'s rows', results.length >= 3 && results[0].kind === 'song' && results[0].title.length > 0 && results.some((r) => r.kind === 'song' && r.ms > 0), JSON.stringify(results.slice(0, 4)));
  await shot('spotify-real-search-signed-out.png');
  await page(`${card}.querySelector('.am-searchfield input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);

  // playing signed out: ask for a track
  await app.evaluate(() => global.__spotifyEngine.playItem('song', '4uLU6hMCjMI75M1A2tKUQC'));
  await sleep(9000);
  const afterPlay = await engine(`JSON.stringify({ path: location.pathname, media: document.querySelectorAll('audio,video').length, md: Boolean(navigator.mediaSession && navigator.mediaSession.metadata), playButton: Boolean(document.querySelector('[data-testid="play-button"]')), modal: Boolean(document.querySelector('[data-testid="login-modal"],[role=dialog]')) })`);
  console.log(`      (asked to play a track signed out: ${afterPlay})`);
  const card2 = await app.evaluate(async () => { const d = await global.__spotifyEngine.read(); return { state: d.state, title: d.title }; });
  check('real: signed out, asking to play does not start anything (and does not break the card)', card2.state === 'idle' && JSON.parse(afterPlay).media === 0, JSON.stringify([card2, afterPlay]));

  // the sign-in window with Spotify's own page in it
  await page(`${card}.querySelector('.am-signin')?.click()`);
  await sleep(500);
  if (!(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => /Sign in to Spotify/.test(w.getTitle()))))) await app.evaluate(() => global.__spotifyEngine.signIn());
  await sleep(2500);
  check('real: Sign in opens a window with Spotify\'s own page in it (shown only now)', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => /Sign in to Spotify/.test(w.getTitle()) && w.isVisible())) && await app.evaluate(() => global.__spotifyWeb.view().getVisible()), '');
  if (shots) {
    const buf = await app.evaluate(async () => { const v = global.__spotifyWeb.view(); return v ? (await v.webContents.capturePage()).toPNG().toString('base64') : ''; });
    if (buf) fs.writeFileSync(path.join(shots, 'spotify-real-signin-window.png'), Buffer.from(buf, 'base64'));
  }
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (/Sign in to Spotify/.test(w.getTitle())) w.close(); });
  await sleep(500);
  check('real: closing it puts the page back, hidden', await app.evaluate(() => !global.__spotifyWeb.view().getVisible()), '');
  const drm = (await status()).drm;
  console.log(`      (Widevine in this Electron: ${drm})`);

  await app.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
})().then(() => { console.log(failures ? `\n${failures} failed` : '\nall passed'); process.exit(failures ? 1 : 0); }).catch((e) => { console.error(e); process.exit(1); });
