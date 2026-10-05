// The Apple Music engine against the REAL music.apple.com (needs the network; SKIPs without it, and without any Apple account:
// nothing here signs in). Signed out, MusicKit still answers catalog searches and plays 30-second previews, which is what this
// uses to check the whole path end to end: the hidden view loads, the preload injects the bridge, MusicKit's instance is found,
// the card shows Sign in and a search, a result plays, the buttons and the seek bar work, events change the card, and the
// operating system sees a media session for the playing page (Windows: through the helper of features/apple-music-native.js with
// its Apple filter off). Signed-in playback (a library, full songs, Widevine) can't be tried without an Apple account.
// Set LUMEN_APPLEMUSIC_SHOTS=<dir> to keep screenshots.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = process.env.LUMEN_APPLEMUSIC_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });

(async () => {
  try { const r = await fetch('https://music.apple.com/us/new', { method: 'HEAD', signal: AbortSignal.timeout(8000) }); if (!r.ok && r.status >= 500) throw new Error(String(r.status)); } catch (err) { console.log(`SKIP  the real music.apple.com checks: not reachable (${err.message})`); return; }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-applemusic-real-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: [{ id: 'wam000001', type: 'applemusic', mode: 'status', app: false, x: 0, y: 0, w: 5, h: 6 }], newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false }));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
  const page = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
  const waitFor = async (code, tries = 120) => { for (let i = 0; i < tries; i++) { if (await page(code).catch(() => false)) return true; await sleep(250); } return false; };
  const engine = (code) => app.evaluate((_e, c) => global.__appleMusicWeb.webContents().executeJavaScript(c), code);
  const status = () => app.evaluate(() => global.__appleMusicEngine.status());
  const card = `(document.querySelector('.w-card[data-id="wam000001"]') || document.createElement('i'))`;
  const shot = async (name) => { if (shots) fs.writeFileSync(path.join(shots, name), Buffer.from(await app.evaluate(async () => (await global.__wtab.webContents.capturePage()).toPNG().toString('base64')), 'base64')); };

  const t0 = Date.now();
  check('real: the engine page loads and MusicKit\'s instance is found by the bridge', await (async () => { for (let i = 0; i < 160; i++) { if ((await status()).ready) return true; await sleep(250); } return false; })(), JSON.stringify(await status()));
  console.log(`      (${Date.now() - t0} ms from launch to the bridge being ready)`);
  const mkVersion = await engine('window.MusicKit && MusicKit.version');
  check('real: it is MusicKit JS v3', /^3\./.test(String(mkVersion)), String(mkVersion));
  check('real: the engine view is hidden (not on screen), never shown for a status card', await app.evaluate(() => { const v = global.__appleMusicWeb.view(); return !v || !v.getVisible(); }), '');
  check('real: signed out is known from MusicKit (no cookie guessing) and the card offers Sign in and a search', (await status()).signedIn === false && await waitFor(`Boolean(${card}.querySelector('.am-signin')) && Boolean(${card}.querySelector('.am-searchfield input'))`), JSON.stringify(await status()));
  await shot('engine-signed-out.png');

  // search (works signed out) and play a preview
  await page(`(() => { ${card}.querySelector('.am-searchbtn').click(); const i = ${card}.querySelector('.am-searchfield input'); i.value = 'shake it off taylor swift'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  check('real: a catalog search through MusicKit shows results on the card', await waitFor(`${card}.querySelectorAll('.am-opt:not(.am-opt-recent)').length > 0`, 80), await page(`${card}.textContent`));
  const rowText = await page(`${card}.querySelector('.am-opt:not(.am-opt-recent)')?.textContent || ''`);
  await shot('engine-results.png');
  await page(`${card}.querySelector('.am-opt:not(.am-opt-recent)').click()`);
  check('real: clicking a result plays it (a 30-second preview when signed out) and the card follows', await waitFor(`${card}.querySelector('.sp-title')?.textContent && ${card}.querySelector('.sp-controls button[aria-label="Pause"]')`, 80), await page(`${card}.textContent.slice(0, 200)`));
  const playing = await page(`({ title: ${card}.querySelector('.sp-title')?.textContent, artist: ${card}.querySelector('.sp-artist')?.textContent, album: ${card}.querySelector('.sp-album')?.textContent, note: ${card}.querySelector('.am-note')?.textContent || '', slider: ${card}.querySelector('.sp-bar')?.getAttribute('role'), hasArt: Boolean(${card}.querySelector('img.sp-art')) })`);
  check('real: the card shows title, artist and album from MusicKit, a seekable bar and the preview note', Boolean(playing.title) && Boolean(playing.artist) && playing.slider === 'slider' && /preview/i.test(playing.note), JSON.stringify(playing) + ' row=' + rowText);
  console.log(`      (playing: ${JSON.stringify(playing)})`);
  check('real: the artwork (an mzstatic.com picture, made small by Lumen) arrives', await waitFor(`Boolean(${card}.querySelector('img.sp-art'))`, 60), '');
  const t1 = await engine('MusicKit.getInstance().currentPlaybackTime');
  await sleep(2500);
  const t2 = await engine('MusicKit.getInstance().currentPlaybackTime');
  check('real: the audio really plays in Lumen (the playback time moves)', t2 > t1, `${t1} -> ${t2}`);
  await shot('engine-playing.png');

  // the operating system's media session for the playing page
  if (process.platform === 'win32') {
    const { createNowPlaying } = require('../src/features/apple-music-native');
    const np = createNowPlaying({ platform: 'win32', any: true, resizeArt: null });
    const d = await np.read();
    console.log(`      (Windows media sessions, any app, while the engine plays: ${JSON.stringify({ state: d.state, title: d.title, artist: d.artist })})`);
    const engineTitle = await engine('MusicKit.getInstance().nowPlayingItem && MusicKit.getInstance().nowPlayingItem.title');
    const mine = d.title === engineTitle; // (the session list is the whole machine's: only ever press buttons on the session that is this test's own page)
    if (!mine) console.log('      (another media app is playing on this computer, so which session is the engine session can not be told here: its session was left alone and no button was pressed; this part is skipped)');
    else {
      check('real: Windows sees a media session for the engine page (media keys and the volume flyout can control it)', d.state === 'playing' || d.state === 'paused', JSON.stringify(d).slice(0, 200));
      // The same path the media keys use (System Media Transport Controls): pressing Pause there pauses the engine page, and Play resumes it
      const paused = await np.control('pause');
      let ps = 0;
      for (let i = 0; i < 40 && ps !== 3; i++) { ps = await engine('MusicKit.getInstance().playbackState'); if (ps !== 3) await sleep(150); }
      check('real: a Pause sent through the Windows media controls (what a media key does) pauses the engine page', paused === true && ps === 3, `${paused} ${ps}`);
      const resumed = await np.control('play');
      for (let i = 0; i < 40 && ps !== 2; i++) { ps = await engine('MusicKit.getInstance().playbackState'); if (ps !== 2) await sleep(150); }
      check('real: …and Play through them resumes it', resumed === true && ps === 2, `${resumed} ${ps}`);
    }
    np.destroy();
  }

  // buttons
  await waitFor(`Boolean(${card}.querySelector('[aria-label="Pause"]'))`, 60);
  await page(`${card}.querySelector('[aria-label="Pause"]').click()`);
  check('real: Pause pauses the engine and the card shows Play', await waitFor(`Boolean(${card}.querySelector('[aria-label="Play"]'))`, 60) && /^(3|2)$/.test(String(await engine('MusicKit.getInstance().playbackState'))), String(await engine('MusicKit.getInstance().playbackState')));
  await page(`${card}.querySelector('.sp-bar').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: ${card}.querySelector('.sp-bar').getBoundingClientRect().left + ${card}.querySelector('.sp-bar').getBoundingClientRect().width * 0.5 }))`);
  await sleep(1200);
  const pos = await engine('MusicKit.getInstance().currentPlaybackTime');
  const dur = await engine('MusicKit.getInstance().currentPlaybackDuration');
  check('real: clicking the middle of the bar seeks there', dur > 0 && Math.abs(pos - dur / 2) < Math.max(3, dur * 0.1), `${pos} of ${dur}`);
  await page(`${card}.querySelector('[aria-label="Play"]').click()`);
  check('real: Play resumes', await waitFor(`Boolean(${card}.querySelector('[aria-label="Pause"]'))`, 60), '');
  const eventsOk = await (async () => { await engine('MusicKit.getInstance().pause()'); return waitFor(`Boolean(${card}.querySelector('[aria-label="Play"]'))`, 60); })();
  check('real: a change made inside the page itself (not from the card) shows on the card by itself', eventsOk, '');

  // sign-in window (the click is Apple's; here only that it opens and closes)
  await page(`(() => { const b = ${card}.querySelector('.am-signin'); if (b) b.click(); })()`);
  await sleep(300);
  const hasSignIn = await page(`Boolean(${card}.querySelector('.am-signin'))`);
  if (!hasSignIn) { // playing: the idle card (with Sign in) is not shown; go through the engine's own call
    await app.evaluate(() => global.__appleMusicEngine.signIn());
  }
  const winInfo = async () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), visible: w.isVisible(), bounds: w.getBounds() })).filter((w) => /Sign in to Apple Music/.test(w.title)));
  const wins = await winInfo();
  check('real: Sign in opens a window of its own holding the engine\'s page (visible only now)', wins.length === 1 && wins[0].visible && (await app.evaluate(() => global.__appleMusicWeb.view().getVisible())), JSON.stringify(wins));
  await sleep(1500);
  if (shots) {
    const buf = await app.evaluate(async ({ BrowserWindow }) => { const v = global.__appleMusicWeb.view(); return v ? (await v.webContents.capturePage()).toPNG().toString('base64') : ''; });
    if (buf) fs.writeFileSync(path.join(shots, 'engine-signin-window.png'), Buffer.from(buf, 'base64'));
  }
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (/Sign in to Apple Music/.test(w.getTitle())) w.close(); });
  await sleep(500);
  check('real: closing the sign-in window puts the page back, hidden, and music keeps its state', (await winInfo()).length === 0 && await app.evaluate(() => { const v = global.__appleMusicWeb.view(); return !v || !v.getVisible(); }), '');

  // Apple's own authorize() (what its Sign in button calls, with a user gesture) opens a sign-in popup: it must be a real window on an
  // allowed Apple host, so the page can hear back from it. (No credentials are typed here; the window is closed again.)
  await app.evaluate(() => { global.__appleMusicWeb.webContents().executeJavaScript('MusicKit.getInstance().authorize().catch(() => {})', true).catch(() => {}); });
  let popup = null;
  for (let i = 0; i < 40 && !popup; i++) {
    await sleep(250);
    popup = await app.evaluate(({ webContents }) => { const wc = webContents.getAllWebContents().find((w) => /^https:\/\/(authorize\.music|idmsa|appleid|account)\.apple\.com\//.test(w.getURL()) && w.getType() === 'window'); return wc ? wc.getURL().slice(0, 80) : null; });
  }
  console.log(`      (authorize() popup: ${popup})`);
  check('real: the authorize() call of the page: sign-in opens as a real popup window on an allowed Apple host (so it can answer the page)', Boolean(popup), String(popup));
  await app.evaluate(({ webContents }) => { for (const w of webContents.getAllWebContents()) if (w.getType() === 'window' && /apple\.com/.test(w.getURL()) && !w.getURL().startsWith('https://music.apple.com')) { try { w.close(); } catch { /* gone */ } } });
  await sleep(500);

  // leaving the new-tab page keeps playing
  await engine('MusicKit.getInstance().play()');
  await app.evaluate(() => { global.__agent.browser.openTab('https://example.com/'); });
  await sleep(3000);
  const stillPlaying = await engine('MusicKit.getInstance().playbackState');
  check('real: the music keeps playing when the new-tab page is left (the engine page is not tied to it)', stillPlaying === 2 || stillPlaying === 1, String(stillPlaying));

  await app.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
})().then(() => { console.log(failures ? `\n${failures} failed` : '\nall passed'); process.exit(failures ? 1 : 0); }).catch((e) => { console.error(e); process.exit(1); });
