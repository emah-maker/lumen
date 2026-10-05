// The Spotify engine in a real window, offline: a local https server (a throwaway self-signed certificate) serves a page that stands in for
// open.spotify.com with Spotify's player as the bridge expects to find it (a footer playbar with the data-testid controls, a mediaSession,
// a search route, play buttons), signed in or out as the server says. Everything between is real: the hidden view, the preload, the bridge
// script injected into the page, the IPC to main, the engine, the widget connector and the card. Checks: nothing loads without a card; signed
// out the card offers Sign in (a window with the engine's page in it, closed when the sign-in cookie appears); signed in it shows what the
// page's mediaSession and playbar say with working buttons and seek; playback on ANOTHER device (Connect) is named and driven; search and
// play-a-result go through the page's own router; a page that loses its player controls says "Spotify changed its page"; junk from the page
// changes nothing; the view is never shown for a status card. THIS IS A STAND-IN: that the real, signed-in Spotify page still matches the
// selector table can only be shown with an account. Needs openssl on PATH (Git for Windows: C:\Program Files\Git\usr\bin).
// Set LUMEN_APPLEMUSIC_SHOTS=<dir> to keep screenshots.
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
const shots = process.env.LUMEN_APPLEMUSIC_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });

const world = { signedIn: false, playerBroken: false, hits: 0 };
// The stand-in page. Signed out: a marketing page with no player. Signed in: a footer playbar built from window.__sp (what "Spotify" is playing),
// a mediaSession for playback on this device, a search route and play buttons on item pages (client-side routing, no reload).
const page = () => `<!doctype html><meta charset="utf-8"><title>Stand-in Spotify</title><body style="margin:0;background:#121212;color:#fff;font:14px system-ui">
<main id="main"><h1>Stand-in Spotify</h1><a href="https://accounts.spotify.com/">Log in here</a></main>
${world.signedIn && !world.playerBroken ? `<footer id="foot"></footer>` : ''}
<script>
window.__log = ['width:' + innerWidth];
window.__sp = { signed: ${world.signedIn}, title: 'Night Shift', artist: 'Ann', album: 'Quiet Hours', artists: ['Ann'], playing: true, pos: 31, dur: 200, device: '', local: true, art: 'https://i.scdn.co/image/ab67616d00001e02fixture' };
const sp = window.__sp;
function fmt(s) { return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }
function mediaSession() {
  if (!sp.local) { navigator.mediaSession.metadata = null; return; }
  navigator.mediaSession.metadata = new MediaMetadata({ title: sp.title, artist: sp.artist, album: sp.album, artwork: [{ src: sp.art, sizes: '300x300' }] });
}
function drawFoot() {
  const foot = document.getElementById('foot');
  if (!foot || innerWidth < 400) return; // (a page laid out at no width draws no playbar)
  foot.innerHTML = '<div data-testid="now-playing-widget"><a data-testid="context-item-link" href="/track/x1">' + sp.title + '</a>'
    + sp.artists.map((a) => '<a href="/artist/a1">' + a + '</a>').join('<span>, </span>') + '<img data-testid="cover-art-image" src="' + sp.art + '"></div>'
    + '<button data-testid="control-button-skip-back" aria-label="Previous"></button>'
    + '<button data-testid="control-button-playpause" aria-label="' + (sp.playing ? 'Pause' : 'Play') + '"></button>'
    + '<button data-testid="control-button-skip-forward" aria-label="Next"></button>'
    + '<div data-testid="playback-progressbar"><span data-testid="playback-position">' + fmt(sp.pos) + '</span><input type="range" min="0" max="' + (sp.dur * 1000) + '" value="' + (sp.pos * 1000) + '"><span data-testid="playback-duration">' + fmt(sp.dur) + '</span></div>'
    + (sp.device ? '<div data-testid="connect-bar">Listening on ' + sp.device + '</div>' : '');
  // Spotify's player refuses to start without user activation (what Chromium's autoplay rules ask of a page): a script-made click is not enough.
  foot.querySelector('[data-testid=control-button-playpause]').onclick = () => {
    if (sp.ignore) { __log.push('ignored:playpause'); return; }
    if (!navigator.userActivation.isActive) { __log.push('blocked:playpause'); return; }
    __log.push('playpause'); sp.playing = !sp.playing; drawFoot();
  };
  foot.querySelector('[data-testid=control-button-skip-forward]').onclick = () => { __log.push('next'); };
  foot.querySelector('[data-testid=control-button-skip-back]').onclick = () => { __log.push('previous'); };
  const r = foot.querySelector('input');
  r.addEventListener('change', () => { __log.push('seek:' + Math.round(Number(r.value) / 1000)); sp.pos = Number(r.value) / 1000; });
}
function route() {
  const m = document.getElementById('main');
  const p = location.pathname;
  if (p.indexOf('/search/') === 0) {
    const term = decodeURIComponent(p.slice(8));
    __log.push('route:' + p);
    m.innerHTML = '<div data-testid="search-page"><div data-testid="tracklist-row"><a href="/track/AAAAAAAAAAAAAAAAAAAAA1">' + term + ' one</a><a href="/artist/BBBBBBBBBBBBBBBBBBBBB1">Taylor</a><div>3:30</div></div>'
      + '<div data-testid="tracklist-row"><a href="/track/AAAAAAAAAAAAAAAAAAAAA2">' + term + ' two</a><a href="/artist/BBBBBBBBBBBBBBBBBBBBB1">Taylor</a><div>2:10</div></div>'
      + '<a href="/album/CCCCCCCCCCCCCCCCCCCCC1">The Album</a><a href="/artist/BBBBBBBBBBBBBBBBBBBBB1">Taylor</a></div>';
  } else if (/^\\/(track|album|playlist|artist)\\//.test(p)) {
    __log.push('route:' + p);
    m.innerHTML = '<button data-testid="play-button" aria-label="Play">Play</button>';
    m.querySelector('button').onclick = () => { __log.push('play:' + p); sp.title = 'Played ' + p.split('/')[2]; sp.artist = 'Result'; sp.artists = ['Result']; sp.playing = true; sp.pos = 0; mediaSession(); drawFoot(); };
  }
}
window.addEventListener('popstate', route);
sp.setRemote = (name) => { sp.device = name; sp.local = !name; mediaSession(); drawFoot(); };
mediaSession(); drawFoot();
setInterval(() => { if (sp.playing) { sp.pos = Math.min(sp.dur, sp.pos + 1); drawFoot(); } }, 1000);
</script></body>`;

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-spengine-'));
  const key = path.join(scratch, 'key.pem');
  const cert = path.join(scratch, 'cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  } catch (err) {
    console.log(`SKIP  the Spotify engine window checks: openssl isn't available (${err.message})`);
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
    return;
  }
  const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => { world.hits++; res.writeHead(200, { 'content-type': 'text/html' }); res.end(page()); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${srv.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-spengine-profile-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: [], newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false }));
  const app = await electron.launch({ args: [path.join(__dirname, '..'), '--ignore-certificate-errors'], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await app.evaluate((_e, b) => { global.__spotifyWebUrl = `${b}/web`; global.__spotifyDrmProbe = async () => true; global.__playerMissingMs = 2500; }, base);
  await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
  const pageJs = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
  await app.evaluate(() => { global.__errs = []; global.__wtab.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) global.__errs.push(String(msg).slice(0, 300)); }); });
  const waitFor = async (code, tries = 100) => { for (let i = 0; i < tries; i++) { if (await pageJs(code).catch(() => false)) return true; await sleep(150); } return false; };
  const waitMain = async (fn, tries = 120) => { for (let i = 0; i < tries; i++) { if (await app.evaluate(fn).catch(() => false)) return true; await sleep(150); } return false; };
  const engine = (code) => app.evaluate((_e, c) => global.__spotifyWeb.webContents().executeJavaScript(c), code);
  const status = () => app.evaluate(() => global.__spotifyEngine.status());
  const shot = async (name) => { if (shots) fs.writeFileSync(path.join(shots, name), Buffer.from(await app.evaluate(async () => (await global.__wtab.webContents.capturePage()).toPNG().toString('base64')), 'base64')); };
  const card = `(document.querySelector('.w-card.spotify') || document.createElement('i'))`;
  const reloadNewTab = () => app.evaluate(() => global.__wtab.webContents.reload());

  check('spotify engine: nothing is loaded while there is no Spotify engine card (no page, no request)', (await app.evaluate(() => global.__spotifyWeb.view())) === null && world.hits === 0, String(world.hits));
  await app.evaluate(() => global.__widgets.save({ type: 'spotify', mode: 'status' }));
  await reloadNewTab();
  check('spotify engine: with a card on the page the hidden page loads and the bridge says ready', await waitMain(() => global.__spotifyEngine.status().ready), JSON.stringify(await status()));
  check('spotify engine: the first load already sees the real window size (the own start-up code of the page gets 1280 wide, not 0)', (await engine('window.__log[0]')) === 'width:1280', String(await engine('window.__log[0]')));
  check('spotify engine: the view is never shown for a status card', await app.evaluate(() => { const v = global.__spotifyWeb.view(); return Boolean(v) && !v.getVisible(); }), '');

  // ---- signed out ----
  check('spotify engine: signed out: the card offers Sign in and says nothing is wrong (no player controls on a signed-out page)', await waitFor(`Boolean(${card}.querySelector('.am-signin')) && /Sign in to Spotify/.test(${card}.querySelector('.am-signin').textContent)`) && (await status()).signedIn === false && !(await pageJs(`/changed its page/.test(${card}.textContent)`)), JSON.stringify(await status()));
  await shot('spotify-engine-signed-out.png');
  await pageJs(`${card}.querySelector('.am-signin').click()`);
  const winInfo = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => /Sign in to Spotify/.test(w.getTitle())).map((w) => ({ visible: w.isVisible() })));
  check('spotify engine: Sign in opens one window with the engine\'s page in it (shown only now)', await waitMain(async ({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => /Sign in to Spotify/.test(w.getTitle()) && w.isVisible())) && await app.evaluate(() => global.__spotifyWeb.view().getVisible()), JSON.stringify(await winInfo()));
  await shot('spotify-engine-signin-fixture.png');
  world.signedIn = true; // the user signs in on the page (the server's page now has the player); Spotify's cookie appears
  await app.evaluate(async ({ session }) => { await session.defaultSession.cookies.set({ url: 'https://open.spotify.com/', name: 'sp_dc', value: 'fixture', domain: '.spotify.com', secure: true }); });
  check('spotify engine: when Spotify\'s sign-in cookie appears the window closes by itself and the page goes back, hidden', await waitMain(async ({ BrowserWindow }) => !BrowserWindow.getAllWindows().some((w) => /Sign in to Spotify/.test(w.getTitle()))) && await app.evaluate(() => !global.__spotifyWeb.view().getVisible()), JSON.stringify(await winInfo()));
  check('spotify engine: signed in is known from the cookie (not from the page)', (await status()).signedIn === true, JSON.stringify(await status()));

  // ---- signed in, playing here ----
  check('spotify engine: signed in and playing here: the card shows title, artist and album from the page\'s mediaSession, a seekable bar and no preview note', await waitFor(`${card}.querySelector('.sp-title')?.textContent === 'Night Shift' && ${card}.querySelector('.sp-artist')?.textContent === 'Ann' && ${card}.querySelector('.sp-album')?.textContent === 'Quiet Hours' && ${card}.querySelector('.sp-bar')?.getAttribute('role') === 'slider' && !/Preview/.test(${card}.textContent)`, 120), await pageJs(`${card}.textContent.slice(0, 200)`));
  await shot('spotify-engine-playing.png');
  await pageJs(`${card}.querySelector('[aria-label="Pause"]').click()`);
  check('spotify engine: Pause presses the page\'s own button and the card shows Play', await waitFor(`Boolean(${card}.querySelector('[aria-label="Play"]'))`, 60) && (await engine('__log')).includes('playpause'), JSON.stringify(await engine('__log')));
  await pageJs(`${card}.querySelector('[aria-label="Play"]').click()`);
  await waitFor(`Boolean(${card}.querySelector('[aria-label="Pause"]'))`, 60);
  await pageJs(`${card}.querySelector('[aria-label="Next track"]').click()`);
  await pageJs(`${card}.querySelector('[aria-label="Previous track"]').click()`);
  await sleep(700);
  const log1 = await engine('__log');
  check('spotify engine: Next and Previous press the page\'s own skip buttons', log1.includes('next') && log1.includes('previous'), JSON.stringify(log1));
  await pageJs(`(() => { const b = ${card}.querySelector('.sp-bar'); const r = b.getBoundingClientRect(); b.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width * 0.5 })); })()`);
  await sleep(900);
  check('spotify engine: clicking the middle of the bar seeks the page\'s own range input to the middle', (await engine('__log')).some((l) => /^seek:(9\d|10\d)$/.test(l)), JSON.stringify(await engine('__log')));
  await engine('(() => { const b = document.querySelector("[data-testid=control-button-playpause]"); b.click(); })()');
  check('spotify engine: a change made in the page itself (its own button, a media key) shows on the card by itself', await waitFor(`Boolean(${card}.querySelector('[aria-label="Play"]'))`, 60), '');
  await engine('(() => { document.querySelector("[data-testid=control-button-playpause]").click(); })()');

  // ---- the two causes of "it doesn't play": no window size, no user activation ----
  check('spotify engine: the hidden engine page is laid out at a real window size (1280 wide), not 0 (the stand-in draws no playbar below 400)', (await engine('innerWidth')) === 1280, String(await engine('innerWidth')));
  await sleep(6500); // (user activation lasts a few seconds after the last press)
  await engine('window.__log.length = 0');
  await engine(`document.dispatchEvent(new CustomEvent('lumen-engine-in', { detail: JSON.stringify({ cmd: 'pause' }) }))`);
  await sleep(700);
  check('spotify engine: a command with no user gesture (how it used to be delivered) is refused by an activation-guarded player: nothing happens (the bug)', (await engine('__log')).includes('blocked:playpause') && !(await engine('__log')).includes('playpause'), JSON.stringify(await engine('__log')));
  await engine('window.__log.length = 0');
  await pageJs(`${card}.querySelector('[aria-label="Pause"]').click()`);
  check('spotify engine: the same press from the card goes with a user gesture, so the guarded player does it', await waitFor(`Boolean(${card}.querySelector('[aria-label="Play"]'))`, 60) && (await engine('__log')).includes('playpause') && !(await engine('__log')).includes('blocked:playpause'), JSON.stringify(await engine('__log')));
  await pageJs(`${card}.querySelector('[aria-label="Play"]').click()`);
  await waitFor(`Boolean(${card}.querySelector('[aria-label="Pause"]'))`, 60);
  // a player that ignores the button: the card says so and offers the player itself
  await app.evaluate(() => { global.__respondMs = 1500; });
  await engine('window.__sp.ignore = true');
  await pageJs(`${card}.querySelector('[aria-label="Pause"]').click()`);
  check('spotify engine: a button the player ignores: the card says Spotify did not respond, with an Open player button', await waitFor(`/didn.t respond/.test(${card}.querySelector('.am-warn')?.textContent || '') && Boolean(${card}.querySelector('.am-warn button'))`, 80), await pageJs(`${card}.textContent.slice(0, 200)`));
  await shot('spotify-engine-unresponsive.png');
  await pageJs(`${card}.querySelector('.am-warn button').click()`);
  check('spotify engine: Open player shows the engine page in a small window (titled Spotify player) and the warning goes', await waitMain(async ({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => /Spotify player/.test(w.getTitle()) && w.isVisible())) && await app.evaluate(() => global.__spotifyWeb.view().getVisible()) && await waitFor(`!${card}.querySelector('.am-warn')`, 40), '');
  await shot('spotify-engine-open-player.png');
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (/Spotify player/.test(w.getTitle())) w.close(); });
  await engine('window.__sp.ignore = false');
  check('spotify engine: closing it puts the page back, hidden, at its hidden size again', await waitMain(() => !global.__spotifyWeb.view().getVisible()) && (await engine('innerWidth')) === 1280, String(await engine('innerWidth')));
  await app.evaluate(() => { global.__respondMs = 0; });

  // ---- playback on another device (Spotify Connect) ----
  await engine('window.__sp.setRemote("Kitchen speaker")');
  check('spotify engine: playing on another device: the card names it and shows what the playbar says', await waitFor(`/On Kitchen speaker/.test(${card}.querySelector('.mk-badge')?.textContent || '') && ${card}.querySelector('.sp-title')?.textContent === 'Night Shift'`, 80), await pageJs(`${card}.textContent.slice(0, 160)`));
  await shot('spotify-engine-remote.png');
  await engine('window.__log.length = 0');
  await pageJs(`${card}.querySelector('[aria-label="Pause"]').click()`);
  check('spotify engine: its buttons drive that device (they press the same playbar buttons)', await waitFor(`Boolean(${card}.querySelector('[aria-label="Play"]'))`, 60) && (await engine('__log')).includes('playpause'), JSON.stringify(await engine('__log')));
  await engine('window.__sp.playing = true; window.__sp.setRemote("")');
  await waitFor(`!${card}.querySelector('.mk-badge')`, 60);

  // ---- search and play a result through the page's own router ----
  await pageJs(`${card}.querySelector('.am-searchbtn').click()`);
  await pageJs(`(() => { const i = ${card}.querySelector('.am-searchfield input'); i.value = 'shake'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  check('spotify engine: search goes to the page\'s own search route (no reload) and the results come back: songs with length, then the album and artist', await waitFor(`${card}.querySelectorAll('.am-opt:not(.am-opt-recent)').length === 4`, 80) && (await engine('__log')).includes('route:/search/shake'), await pageJs(`${card}.querySelector('.am-pop')?.textContent || ''`));
  const hits0 = world.hits;
  const groups = await pageJs(`[...${card}.querySelectorAll('.am-pop .am-heading')].map((h) => h.textContent)`);
  check('spotify engine: the results are grouped Songs, Albums, Artists, and there is no Play next or Add to queue (Spotify has none here)', JSON.stringify(groups) === '["Songs","Albums","Artists"]' && (await pageJs(`${card}.querySelectorAll('.am-act').length`)) === 0, JSON.stringify(groups));
  await shot('spotify-engine-search.png');
  await pageJs(`${card}.querySelector('.am-songs .am-opt').click()`);
  check('spotify engine: clicking a song goes to its page and presses its play button, and the card follows', await waitFor(`/Played AAAAAAAAAAAAAAAAAAAAA1/.test(${card}.querySelector('.sp-title')?.textContent || '')`, 80) && (await engine('__log')).some((l) => l.startsWith('play:/track/AAAAAAAAAAAAAAAAAAAAA1')), JSON.stringify(await engine('__log')));
  check('spotify engine: no page was loaded for it (the app\'s router did the navigation, so playback goes on)', world.hits === hits0, `${world.hits} ${hits0}`);

  // ---- junk from the page ----
  const before = JSON.stringify(await status());
  await engine(`(() => { for (const d of ['nope', '{"t":"list","kind":"recent","items":[{"id":"../x","kind":"song","title":"Bad"}]}', '[]', '{"t":"error","message":"' + 'x'.repeat(5000) + '"}', '{"t":"state","state":2,"item":{"title":"Forged","art":"https://evil.example/a.png"},"device":"x","player":true}']) document.dispatchEvent(new CustomEvent('lumen-engine-out', { detail: d })); })()`);
  await sleep(500);
  check('spotify engine: junk and forged messages from the page are only data: still ready, and no picture from a foreign host is ever asked for', (await status()).ready === true && !(await pageJs(`/evil\\.example/.test(${card}.innerHTML)`)), before);

  // ---- Spotify changes its page: the player controls vanish ----
  world.playerBroken = true;
  await app.evaluate(() => global.__spotifyWeb.reload());
  check('spotify engine: signed in, but the page shows no player controls: after a while the card says Spotify changed its page, instead of showing nothing', await waitFor(`/changed its page/.test(${card}.querySelector('.am-changed')?.textContent || '')`, 120), await pageJs(`${card}.textContent.slice(0, 200)`));
  await shot('spotify-engine-changed.png');
  world.playerBroken = false;
  await app.evaluate(() => global.__spotifyWeb.reload());
  check('spotify engine: when the controls are back, so is the card', await waitFor(`!${card}.querySelector('.am-changed') && Boolean(${card}.querySelector('.sp-title'))`, 120), '');

  // ---- leaving the new-tab page; the other modes ----
  await app.evaluate(() => { global.__agent.browser.openTab('https://127.0.0.1:1/'); });
  await sleep(1500);
  check('spotify engine: the engine page stays loaded and ready when the new-tab page is left', (await status()).ready === true, JSON.stringify(await status()));
  const errs = await app.evaluate(() => global.__errs);
  check('spotify engine: the new-tab page has no console errors from it', errs.length === 0, JSON.stringify(errs));

  await app.close();
  srv.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
})().then(() => { console.log(failures ? `\n${failures} failed` : '\nall passed'); process.exit(failures ? 1 : 0); }).catch((e) => { console.error(e); process.exit(1); });
