// The Apple Music new-tab widget in a real window, offline: a local https server (a throwaway self-signed
// certificate) stands in for music.apple.com. Nothing here signs in to Apple or needs an account: main.js lets the
// view load a stand-in address only in test mode (global.__appleMusicWebUrl).
//
// Checks: the view over the card, a load that fails (offline, a 500) saying so with Try again, Widevine missing saying
// so, and that it lives next to a Spotify Web player card
// (two views, independent). Needs openssl on PATH (Git for Windows: C:\Program Files\Git\usr\bin).
// Set LUMEN_APPLEMUSIC_SHOTS=<dir> to keep a screenshot of the card.
const { _electron: electron } = require('playwright-core');
const { execFileSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-applemusic-'));
  const key = path.join(scratch, 'key.pem');
  const cert = path.join(scratch, 'cert.pem');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  } catch (err) {
    console.log(`SKIP  the Apple Music window checks: openssl isn't available (${err.message})`);
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
    process.exit(0);
  }
  const world = { hits: 0, web: 'ok' };
  const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    world.hits++;
    if (world.web === '500') { res.writeHead(500, { 'content-type': 'text/html' }); res.end('<title>Oops</title>Apple Music is down'); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><meta charset="utf-8"><title>Stand-in Apple Music</title><body style="margin:0;background:#1c1c1e;color:#fff;font:14px system-ui"><h1>Stand-in Apple Music</h1></body>');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${srv.address().port}`;
  const shots = process.env.LUMEN_APPLEMUSIC_SHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });

  await run(base, shots);

  srv.close();
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);

  async function run(base, shots) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-applemusic-profile-'));
    const widgets = [
      { id: 'wapple001', type: 'applemusic', mode: 'web', x: 0, y: 0, w: 4, h: 5 },
      { id: 'wspotweb1', type: 'spotify', mode: 'web', x: 6, y: 0, w: 4, h: 4 },
    ];
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: widgets, newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false }));
    const app = await electron.launch({ args: [path.join(__dirname, '..'), '--ignore-certificate-errors'], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate((_e, b) => { global.__appleMusicWebUrl = `${b}/web`; global.__appleMusicDrmProbe = async () => false; global.__spotifyWebUrl = `${b}/spotify`; global.__spotifyDrmProbe = async () => true; }, base);
    await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
    const page = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
    await app.evaluate(() => { global.__errs = []; global.__wtab.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) global.__errs.push(String(msg).slice(0, 300)); }); });
    const waitFor = async (code, tries = 80) => { for (let i = 0; i < tries; i++) { if (await page(code).catch(() => false)) return true; await sleep(150); } return false; };
    const waitMain = async (fn, tries = 200) => { for (let i = 0; i < tries; i++) { if (await app.evaluate(fn).catch(() => false)) return true; await sleep(150); } return false; };
    const status = () => app.evaluate(() => global.__appleMusicWeb.status());
    const AM = '.w-card.applemusic';

    check('apple music: the card is drawn with its slot and the Open link', await waitFor(`Boolean(document.querySelector('${AM}.sp-web .sp-web-slot'))`) && await page(`Boolean(document.querySelector('${AM} a[title^="Open in Apple Music"], ${AM} a[aria-label^="Open in Apple Music"]'))`), '');
    check('apple music: the view loads the stand-in page and the card reports it ready', await waitMain(() => global.__appleMusicWeb.view()?.webContents.getURL().endsWith('/web')) && (await waitMain(() => global.__appleMusicWeb.status().state === 'ready')), JSON.stringify(await status()));
    check('apple music: the view sits over the card (visible, inside the window)', await waitMain(() => { const v = global.__appleMusicWeb.view(); return v && v.getVisible() && v.getBounds().width >= 60; }), '');
    const placed = await app.evaluate(({ BrowserWindow }) => { const b = global.__appleMusicWeb.view().getBounds(); const [w, h] = BrowserWindow.getAllWindows()[0].getContentSize(); return { b, w, h }; });
    check('apple music: the view stays inside the window', placed.b.x >= 0 && placed.b.y >= 0 && placed.b.x + placed.b.width <= placed.w && placed.b.y + placed.b.height <= placed.h && placed.b.width > 0 && placed.b.height > 0, JSON.stringify(placed));

    // Two players, two views: Spotify's own card and view are independent of Apple's
    check('apple music: Spotify\'s Web player card next to it has its own view on its own page', await waitMain(() => { const s = global.__spotifyWeb.view(); const a = global.__appleMusicWeb.view(); return s && a && s !== a && s.webContents.getURL().endsWith('/spotify') && a.webContents.getURL().endsWith('/web'); }), '');
    check('apple music: …and the two cards do not overlap', await waitMain(() => { const s = global.__spotifyWeb.view().getBounds(); const a = global.__appleMusicWeb.view().getBounds(); return s.x >= a.x + a.width || a.x >= s.x + s.width || s.y >= a.y + a.height || a.y >= s.y + s.height; }), '');
    check('apple music: Widevine for Spotify (probe says yes) gives no note there', !(await page("Boolean(document.querySelector('.w-card.spotify .sp-drm'))")), '');

    // Widevine missing: the card says so, and it is the Apple Music card that says it
    check('apple music: no Widevine shows a clear note on the card (and the view stays for browsing)', await waitFor(`/Apple Music can.t play sound/.test(document.querySelector('${AM} .sp-drm')?.textContent || '') && /Widevine/.test(document.querySelector('${AM} .sp-drm')?.textContent || '')`) && (await status()).drm === 'missing' && (await app.evaluate(() => global.__appleMusicWeb.view().getVisible())), JSON.stringify(await status()));
    check('apple music: the Widevine note is a live status for screen readers', await page(`document.querySelector('${AM} .sp-drm')?.getAttribute('role') === 'status'`), '');
    if (shots) fs.writeFileSync(path.join(shots, 'applemusic-card.png'), Buffer.from(await app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.capturePage().then((i) => i.toPNG().toString('base64'))), 'base64'));
    await app.evaluate(() => { global.__appleMusicDrmProbe = async () => true; });
    check('apple music: once Widevine is there (it installs in the background) the note goes away by itself', await waitFor(`!document.querySelector('${AM} .sp-drm')`, 120) && (await status()).drm === 'ok', JSON.stringify(await status()));

    // A load that fails: offline, then a 500 -> a message and Try again, never a blank frame
    const closed = await new Promise((r) => { const s = require('net').createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    await app.evaluate((_e, p) => { global.__appleMusicWebUrl = `https://127.0.0.1:${p}/web`; }, closed);
    await app.evaluate(() => global.__appleMusicWeb.reload());
    check('apple music: offline, the card says it can\'t reach Apple Music and offers Try again', await waitFor(`/Can.t reach Apple Music/.test(document.querySelector('${AM} .sp-web-down')?.textContent || '') && /Try again/.test(document.querySelector('${AM} .sp-web-down button')?.textContent || '')`), JSON.stringify(await status()));
    check('apple music: …the error page is hidden (the card\'s message is what shows), and Spotify\'s view is untouched', await waitMain(() => !global.__appleMusicWeb.view() || !global.__appleMusicWeb.view().getVisible()) && await app.evaluate(() => global.__spotifyWeb.status().state === 'ready'), '');
    const hitsBefore = world.hits;
    await app.evaluate((_e, b) => { global.__appleMusicWebUrl = `${b}/web`; }, base);
    await page(`document.querySelector('${AM} .sp-web-down button').click()`);
    check('apple music: Try again loads it again and the card recovers', await waitMain(() => global.__appleMusicWeb.status().state === 'ready') && world.hits > hitsBefore && await waitFor(`!document.querySelector('${AM} .sp-web-down')`) && (await waitMain(() => global.__appleMusicWeb.view()?.getVisible())), JSON.stringify(await status()));
    world.web = '500';
    await app.evaluate(() => global.__appleMusicWeb.reload());
    check('apple music: a server error says Apple Music didn\'t load', await waitFor(`/didn.t load/.test(document.querySelector('${AM} .sp-web-down')?.textContent || '')`), JSON.stringify(await status()));
    world.web = 'ok';
    await page(`document.querySelector('${AM} .sp-web-down button').click()`);
    check('apple music: …and recovers when Apple Music does', await waitMain(() => global.__appleMusicWeb.status().state === 'ready'), JSON.stringify(await status()));

    // Removing the card: its view goes away (the Spotify one stays)
    await app.evaluate(() => { global.__widgets.remove('wapple001'); });
    check('apple music: removing the web card hides its view (the engine keeps the page a while) and leaves the Spotify one', await waitMain(() => { const v = global.__appleMusicWeb.view(); return !v || !v.getVisible(); }) && await app.evaluate(() => global.__spotifyWeb.view() !== null), '');

    const errs = await app.evaluate(() => global.__errs);
    check('apple music: no console errors on the new-tab page', errs.length === 0, JSON.stringify(errs));
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
})().catch((e) => { console.error(e); process.exit(1); });
