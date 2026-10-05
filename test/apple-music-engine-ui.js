// The Apple Music engine's plumbing in a real window, offline: a local https server (a throwaway self-signed certificate) serves a
// page that stands in for music.apple.com with a fake MusicKit. Everything between is real: the hidden view, the preload, the
// bridge script injected into the page, the IPC to main, the engine, the widget connector and the card. Checks: the engine is not
// loaded until a card exists, the card shows what MusicKit reports, the buttons/seek/search/play-an-item reach MusicKit, a
// signed-out card offers Sign in (a window with the engine's page in it, closed by itself on authorization), signed in shows the
// lists, junk or forged messages from the page change nothing, the hidden view is never shown, and music continues when the page
// is left. Needs openssl on PATH (Git for Windows: C:\Program Files\Git\usr\bin).
// Set LUMEN_APPLEMUSIC_SHOTS=<dir> to keep screenshots.
const { _electron: electron } = require('playwright-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.LUMEN_APPLEMUSIC_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });

const PAGE = `<!doctype html><meta charset="utf-8"><title>Stand-in Apple Music</title><body style="margin:0;background:#1c1c1e;color:#fff;font:14px system-ui"><h1>Stand-in Apple Music</h1>
<script>
window.__cmds = [];
const ev = {};
const fire = (n) => (ev[n] || []).forEach((f) => f({}));
const mk = {
  isAuthorized: false, playbackState: 0, currentPlaybackTime: 0, currentPlaybackDuration: 0, storefrontId: 'us', nowPlayingItem: null,
  addEventListener(n, f) { (ev[n] = ev[n] || []).push(f); },
  play() { __cmds.push('play'); mk.playbackState = 2; fire('playbackStateDidChange'); return Promise.resolve(); },
  pause() { __cmds.push('pause'); mk.playbackState = 3; fire('playbackStateDidChange'); },
  skipToNextItem() { __cmds.push('next'); return Promise.resolve(); },
  skipToPreviousItem() { __cmds.push('previous'); return Promise.resolve(); },
  seekToTime(s) { __cmds.push('seek:' + s); mk.currentPlaybackTime = s; fire('playbackProgressDidChange'); return Promise.resolve(); },
  setQueue(q) { __cmds.push('queue:' + JSON.stringify(q)); mk.nowPlayingItem = { id: '1', type: 'songs', title: 'Fixture Song', artistName: 'Fixture Artist', albumName: 'Fixture Album', artworkURL: 'https://is1-ssl.mzstatic.com/nothing/{w}x{h}bb.jpg', playbackDuration: 200000 }; mk.currentPlaybackDuration = 200; mk.currentPlaybackTime = 0; fire('nowPlayingItemDidChange'); return Promise.resolve(); },
  api: { music(path, params) {
    __cmds.push('api:' + path);
    if (path.indexOf('/search') > 0) return Promise.resolve({ data: { results: { songs: { data: [{ id: '1', type: 'songs', attributes: { name: 'Fixture Song', artistName: 'Fixture Artist' } }] } } } });
    if (!mk.isAuthorized) return Promise.reject({ status: 403 });
    return Promise.resolve({ data: { data: [{ id: 'p.1', type: path.indexOf('recent') > 0 ? 'albums' : 'library-playlists', attributes: { name: 'Fixture ' + (path.indexOf('recent') > 0 ? 'Recent' : 'List'), artistName: 'Ann' } }] } });
  } },
};
window.MusicKit = { getInstance: () => mk, version: 'stand-in' };
window.__authorize = () => { mk.isAuthorized = true; fire('authorizationStatusDidChange'); };
</script></body>`;

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-amengine-'));
  const key = path.join(scratch, 'key.pem');
  const cert = path.join(scratch, 'cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  } catch (err) {
    console.log(`SKIP  the Apple Music engine window checks: openssl isn't available (${err.message})`);
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
    return;
  }
  let hits = 0;
  const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => { hits++; res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${srv.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-amengine-profile-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: [], newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false }));
  const app = await electron.launch({ args: [path.join(__dirname, '..'), '--ignore-certificate-errors'], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await app.evaluate((_e, b) => { global.__appleMusicWebUrl = `${b}/web`; global.__appleMusicDrmProbe = async () => true; }, base);
  await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
  const page = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
  await app.evaluate(() => { global.__errs = []; global.__wtab.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) global.__errs.push(String(msg).slice(0, 300)); }); });
  const waitFor = async (code, tries = 80) => { for (let i = 0; i < tries; i++) { if (await page(code).catch(() => false)) return true; await sleep(150); } return false; };
  const waitMain = async (fn, tries = 120) => { for (let i = 0; i < tries; i++) { if (await app.evaluate(fn).catch(() => false)) return true; await sleep(150); } return false; };
  const engine = (code) => app.evaluate((_e, c) => global.__appleMusicWeb.webContents().executeJavaScript(c), code);
  const status = () => app.evaluate(() => global.__appleMusicEngine.status());
  const shot = async (name) => { if (shots) fs.writeFileSync(path.join(shots, name), Buffer.from(await app.evaluate(async () => (await global.__wtab.webContents.capturePage()).toPNG().toString('base64')), 'base64')); };
  const card = `(document.querySelector('.w-card.applemusic') || document.createElement('i'))`;

  check('engine: nothing is loaded while there is no Apple Music card (no page, no request)', (await app.evaluate(() => global.__appleMusicWeb.view())) === null && hits === 0, String(hits));
  await app.evaluate(() => global.__widgets.save({ type: 'applemusic', mode: 'status', app: false }));
  await app.evaluate(() => global.__wtab.webContents.reload());
  check('engine: with a card on the page the hidden page loads and the bridge finds MusicKit', await waitMain(() => global.__appleMusicEngine.status().ready), JSON.stringify(await status()));
  check('engine: the view is never shown for a status card', await app.evaluate(() => { const v = global.__appleMusicWeb.view(); return Boolean(v) && !v.getVisible(); }), '');
  check('engine: signed out comes from MusicKit and the idle card offers Sign in and a search', (await status()).signedIn === false && await waitFor(`Boolean(${card}.querySelector('.am-signin')) && Boolean(${card}.querySelector('.am-search input'))`), JSON.stringify(await status()));
  check('engine: signed out, the lists are not shown (MusicKit refused them) and nothing is wrong', !(await page(`Boolean(${card}.querySelector('.am-row'))`)), '');

  // search -> results -> play
  await page(`(() => { const f = ${card}.querySelector('.am-search'); f.querySelector('input').value = 'fixture'; f.requestSubmit(); })()`);
  check('engine: a search goes through the bridge to MusicKit\'s API at the catalog path and the results come back as rows', await waitFor(`${card}.querySelectorAll('.am-row').length === 1`, 60) && (await engine('__cmds')).includes('api:/v1/catalog/us/search'), JSON.stringify(await engine('__cmds')));
  await page(`${card}.querySelector('.am-row').click()`);
  check('engine: clicking a result sets that queue and plays (the kind and id are exact)', await waitFor(`${card}.querySelector('.sp-title')?.textContent === 'Fixture Song'`, 60) && (await engine('__cmds')).includes('queue:{"song":"1"}'), JSON.stringify(await engine('__cmds')));
  check('engine: the card shows title, artist, album, a seekable bar and the preview note (signed out)', await page(`${card}.querySelector('.sp-artist').textContent === 'Fixture Artist' && ${card}.querySelector('.sp-album').textContent === 'Fixture Album' && ${card}.querySelector('.sp-bar').getAttribute('role') === 'slider' && /Preview only/.test(${card}.textContent)`), await page(`${card}.textContent.slice(0, 200)`));
  await shot('engine-fixture-playing.png');

  // buttons and seek
  await page(`${card}.querySelector('[aria-label="Pause"]').click()`);
  check('engine: Pause reaches MusicKit and the card shows Play', await waitFor(`Boolean(${card}.querySelector('[aria-label="Play"]'))`, 60) && (await engine('__cmds')).includes('pause'), JSON.stringify(await engine('__cmds')));
  await page(`${card}.querySelector('[aria-label="Play"]').click()`);
  await waitFor(`Boolean(${card}.querySelector('[aria-label="Pause"]'))`, 60);
  await page(`${card}.querySelector('[aria-label="Next track"]').click()`);
  await page(`${card}.querySelector('[aria-label="Previous track"]').click()`);
  await sleep(600);
  const cmds = await engine('__cmds');
  check('engine: Play, Next and Previous reach MusicKit', ['play', 'next', 'previous'].every((c) => cmds.includes(c)), JSON.stringify(cmds));
  await page(`(() => { const b = ${card}.querySelector('.sp-bar'); const r = b.getBoundingClientRect(); b.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width * 0.5 })); })()`);
  await sleep(700);
  check('engine: clicking the middle of the bar seeks MusicKit to the middle of the song', (await engine('__cmds')).includes('seek:100'), JSON.stringify(await engine('__cmds')));
  await engine('(() => { MusicKit.getInstance().pause(); })()');
  check('engine: a pause made inside the page itself (a media key, the page) shows on the card by itself', await waitFor(`Boolean(${card}.querySelector('[aria-label="Play"]'))`, 60), '');

  // junk and forged messages from the page change nothing
  const before = JSON.stringify(await status());
  await engine(`(() => { for (const d of ['nope', '{"t":"list","kind":"recent","rid":1,"ok":true,"items":[{"id":"../x","type":"songs","title":"Bad"}]}', '[]', '{"t":"error","message":"' + 'x'.repeat(5000) + '"}']) document.dispatchEvent(new CustomEvent('lumen-am-out', { detail: d })); })()`);
  await sleep(500);
  const afterForged = await app.evaluate(() => ({ s: global.__appleMusicEngine.status() }));
  check('engine: junk messages from the page (not JSON, a list with a path-like id, a 5000-character error) change nothing: still ready, same state, no row with the bad id', afterForged.s.ready === true && JSON.stringify(afterForged.s) === before && !(await page(`/Bad/.test(${card}.textContent)`)), before + ' ' + JSON.stringify(afterForged));
  const errsNow = await app.evaluate(() => global.__errs);
  check('engine: the new-tab page has no console errors from it', errsNow.length === 0, JSON.stringify(errsNow));

  // sign in
  await app.evaluate(() => { global.__appleMusicEngine.signIn(); });
  const winInfo = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => /Sign in to Apple Music/.test(w.getTitle())).map((w) => ({ visible: w.isVisible(), size: w.getContentSize() })));
  const wins = await winInfo();
  check('engine: Sign in opens one window with the engine\'s page in it (shown only now), sized to the window', wins.length === 1 && wins[0].visible && await app.evaluate(() => { const v = global.__appleMusicWeb.view(); return v.getVisible() && v.getBounds().width > 300; }), JSON.stringify(wins));
  await shot('engine-fixture-signin.png');
  await engine('window.__authorize()');
  check('engine: when MusicKit says authorized, the window closes by itself and the page is hidden again', await waitMain(async ({ BrowserWindow }) => !BrowserWindow.getAllWindows().some((w) => /Sign in to Apple Music/.test(w.getTitle()))) && await app.evaluate(() => !global.__appleMusicWeb.view().getVisible()), JSON.stringify(await winInfo()));
  check('engine: signed in is known from MusicKit', (await status()).signedIn === true, JSON.stringify(await status()));
  await engine('(() => { const m = MusicKit.getInstance(); m.nowPlayingItem = null; m.playbackState = 0; })()');
  await engine('(() => { MusicKit.getInstance().pause(); })()');
  await app.evaluate(() => { global.__appleMusicEngine.search(''); global.__appleMusicEngine.refreshLists(); });
  await app.evaluate(() => global.__wtab.webContents.reload());
  check('engine: signed in and idle, the recent plays and the playlists come from MusicKit\'s API at their fixed paths and show as rows', await waitFor(`/Recently played/.test(${card}.textContent) && /Your playlists/.test(${card}.textContent)`, 80) && (await engine('__cmds')).includes('api:/v1/me/recent/played') && (await engine('__cmds')).includes('api:/v1/me/library/playlists'), await page(`${card}.textContent.slice(0, 200)`));
  await shot('engine-fixture-lists.png');
  await page(`[...${card}.querySelectorAll('.am-row')].find((r) => /Fixture List/.test(r.textContent)).click()`);
  await sleep(700);
  check('engine: a playlist row plays that playlist (library ids are accepted)', (await engine('__cmds')).includes('queue:{"playlist":"p.1"}'), JSON.stringify(await engine('__cmds')));

  // leaving the new-tab page
  await engine('(() => { MusicKit.getInstance().play(); })()');
  await app.evaluate(() => { global.__agent.browser.openTab('https://127.0.0.1:1/'); });
  await sleep(1500);
  check('engine: the engine page stays loaded and in its state when the new-tab page is left', (await status()).ready === true && (await engine('MusicKit.getInstance().playbackState')) === 2, JSON.stringify(await status()));

  await app.close();
  srv.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
})().then(() => { console.log(failures ? `\n${failures} failed` : '\nall passed'); process.exit(failures ? 1 : 0); }).catch((e) => { console.error(e); process.exit(1); });
