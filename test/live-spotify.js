// A LIVE check of the Spotify card against a real Spotify account. It is NOT part of `npm test` (scripts/test-all.js does not list it) and does nothing
// unless LUMEN_LIVE_SPOTIFY=1 is set: it talks to the real open.spotify.com and plays real music (muted).
//
// It uses its own persistent profile, named by CLAUDE_BROWSER_PROFILE (required; never %APPDATA%\Lumen, which is refused), so the user signs in once and the
// next runs are already signed in. It never types or reads a password: in the sign-in run the user signs in themselves, in the window it opens.
//
//   1. Sign in once (a VISIBLE window on open.spotify.com, whose Log in button goes to accounts.spotify.com; waits until the card reports signed in, or 5 minutes):
//        set LUMEN_LIVE_SPOTIFY=1 and LUMEN_LIVE_SPOTIFY_SIGNIN=1 and CLAUDE_BROWSER_PROFILE=C:\Users\emah\lumen-live-spotify-profile, then: node test/live-spotify.js
//   2. Exercise every card action, HIDDEN (no window is shown):
//        set LUMEN_LIVE_SPOTIFY=1 and CLAUDE_BROWSER_PROFILE=C:\Users\emah\lumen-live-spotify-profile, then: node test/live-spotify.js
//
// The hidden run: signed in? the hidden player is ready; search a common song; the results' cover art loaded (naturalWidth > 0); play the first result;
// pause; next; previous; the Library has rows; Up next answers; Devices lists this browser. It prints PASS or FAIL for each. READ AND PLAYBACK ONLY: it never
// likes or unlikes a song, never edits a playlist, never follows anything (no such call is made anywhere below). The music is paused at the end.
// What main logs with the [spotify] prefix during the run is printed under a FAIL, because that is where the real cause of a failure is written.
'use strict';
if (process.env.LUMEN_LIVE_SPOTIFY !== '1') {
  console.log('SKIP  live Spotify check: set LUMEN_LIVE_SPOTIFY=1 (and CLAUDE_BROWSER_PROFILE=<a dedicated profile folder>) to run it');
  process.exit(0);
}
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const SIGNIN = process.env.LUMEN_LIVE_SPOTIFY_SIGNIN === '1';
const profile = process.env.CLAUDE_BROWSER_PROFILE ? path.resolve(process.env.CLAUDE_BROWSER_PROFILE) : '';
const appData = process.env.APPDATA ? path.resolve(process.env.APPDATA, 'Lumen').toLowerCase() : '';
if (!profile) { console.error('FAIL  set CLAUDE_BROWSER_PROFILE to a dedicated profile folder (for example C:\\Users\\emah\\lumen-live-spotify-profile)'); process.exit(2); }
if (/[\\/]appdata[\\/]roaming[\\/]lumen([\\/]|$)/i.test(profile) || (appData && (profile.toLowerCase() === appData || profile.toLowerCase().startsWith(appData + path.sep)))) { console.error('FAIL  refusing to use the real Lumen profile (%APPDATA%\\Lumen): name a dedicated folder'); process.exit(2); }
fs.mkdirSync(profile, { recursive: true });
const settingsFile = path.join(profile, 'settings.json');
if (!fs.existsSync(settingsFile)) fs.writeFileSync(settingsFile, JSON.stringify({ homeWidgets: [], newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false }));

let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mainLog = []; // what main prints (the [spotify] lines are where a failure's real cause is)
const report = (name, ok, detail) => {
  if (!ok) failures++;
  const spot = mainLog.filter((l) => l.includes('[spotify]')).slice(-4);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -> ${String(detail).slice(0, 400)}`}`);
  if (!ok && spot.length) for (const l of spot) console.log(`        main: ${l.slice(0, 300)}`);
};
const step = async (name, fn) => { try { const r = await fn(); report(name, r === true || (r && r.ok === true), r && r.detail); } catch (err) { report(name, false, err && err.message); } };
const hard = setTimeout(() => { console.error('FAIL  the live check ran longer than 10 minutes and was stopped'); process.exit(1); }, 10 * 60e3);

(async () => {
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_WIDEVINE: '1' }; // (LUMEN_TEST_WIDEVINE: Playwright turns the component updater off, so Widevine would never register)
  if (SIGNIN) delete env.LUMEN_TEST_BACKGROUND; else env.LUMEN_TEST_BACKGROUND = '1'; // (only the sign-in run may show a window)
  const app = await electron.launch({ args: [path.join(__dirname, '..'), ...(SIGNIN ? [] : ['--mute-audio'])], env });
  const proc = app.process();
  for (const stream of [proc.stdout, proc.stderr]) stream?.on('data', (b) => { for (const l of String(b).split(/\r?\n/)) if (l.trim()) { mainLog.push(l); if (mainLog.length > 200) mainLog.shift(); } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const status = () => app.evaluate(() => global.__spotifyEngine.status());
  const read = () => app.evaluate(() => global.__spotifyEngine.read());

  // A Spotify card (the engine card: "Play as Lumen") on the new-tab page of this profile, once.
  await app.evaluate(() => { if (!global.__widgets.list().some((w) => w.type === 'spotify' && w.mode === 'status')) return global.__widgets.save({ type: 'spotify', mode: 'status' }); return null; });

  if (SIGNIN) {
    console.log('A window with open.spotify.com is open. Sign in there yourself (the Log in button); this waits up to 5 minutes and closes when the card reports signed in.');
    // The same flow a person gets: the new-tab page's Spotify card, whose "Sign in to Spotify in Lumen" button opens the sign-in window (not a call made behind the card).
    await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
    const cardPage = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
    let pressed = false;
    for (let i = 0; i < 60 && !pressed; i++) { pressed = await cardPage("(() => { const b = document.querySelector('.w-card.spotify .am-signin'); if (!b) return false; b.click(); return true; })()").catch(() => false); if (!pressed) await sleep(500); }
    if (!pressed) console.log('The card shows no Sign in button (already signed in, or the card did not load): waiting for the signed-in state anyway.');
    const end = Date.now() + 5 * 60e3;
    let ok = false;
    while (Date.now() < end) { if ((await status().catch(() => ({}))).signedIn === true) { ok = true; break; } await sleep(1500); }
    if (ok) await sleep(4000); // (the cookie is written to the profile)
    report('sign in: the card reports signed in to Spotify', ok, 'no sign-in within 5 minutes');
    await app.close().catch(() => {});
    clearTimeout(hard);
    process.exit(failures ? 1 : 0);
  }

  // ---- hidden: every card action against the real account ----
  // The new-tab page with the card FIRST: the engine's hidden Spotify page is only made when a card asks for it (the status call does not wake it), and
  // only a live page knows whether the account is signed in (the cookie hook runs when the view is made).
  await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__wtab = t; t.webContents.once('did-finish-load', res); }));
  await app.evaluate(() => { global.__spotifyEngine.read(); });
  await step('signed in (Spotify\'s own sign-in cookie is in this profile; if not, run the sign-in run first)', async () => {
    const end = Date.now() + 30000;
    let s = await status();
    while (Date.now() < end && s.signedIn === null) { await sleep(500); s = await status(); }
    return { ok: s.signedIn === true, detail: JSON.stringify(s) };
  });
  if (failures) { await app.close().catch(() => {}); clearTimeout(hard); process.exit(1); }

  const page = (code) => app.evaluate((_e, c) => global.__wtab.webContents.executeJavaScript(c), code);
  const waitFor = async (code, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await page(code).catch(() => false)) return true; await sleep(250); } return false; };
  const card = '(document.querySelector(".w-card.spotify") || document.createElement("i"))';

  await step('the hidden Spotify player loads and its bridge finds the controls (engine ready)', async () => {
    const end = Date.now() + 45000;
    let s = await status();
    while (Date.now() < end && !(s.ready && s.state === 'ready')) { await sleep(500); s = await status(); } // (the bridge can answer a moment before the page's load event)
    return { ok: s.ready === true && s.state === 'ready', detail: JSON.stringify(s) };
  });
  await step('Widevine is available (protected audio can play)', async () => {
    const end = Date.now() + 40000; // (asked on the page's load event, and again every 5 s while it is not there yet)
    let s = await status();
    while (Date.now() < end && s.drm !== 'ok') { await sleep(500); s = await status(); }
    return { ok: s.drm === 'ok', detail: `drm ${s.drm}` };
  });

  // search a common song through the card's own search box
  const TERM = 'Never Gonna Give You Up';
  let firstTitle = '';
  await step(`search "${TERM}": the card lists songs`, async () => {
    await waitFor(`Boolean(${card}.querySelector('.am-searchbtn'))`, 30000);
    await page(`${card}.querySelector('.am-searchbtn').click()`);
    await page(`(() => { const i = ${card}.querySelector('.am-searchfield input'); i.value = ${JSON.stringify(TERM)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    const ok = await waitFor(`${card}.querySelectorAll('.am-pop .am-songs .am-opt').length > 0`, 30000);
    firstTitle = ok ? await page(`${card}.querySelector('.am-pop .am-songs .am-opt .am-title').textContent`) : '';
    return { ok, detail: `${(await read()).searchWhy || 'no rows'}` };
  });
  await step('the results\' cover art loaded (a picture with naturalWidth > 0)', async () => {
    // (the card draws a row's picture lazily, which an off-screen window never triggers: loading is forced here, the picture itself is the card's own data: URL)
    const drawn = `(() => { const l = [...${card}.querySelectorAll('.am-pop img.am-thumb')]; l.forEach((i) => { i.loading = 'eager'; }); return l.some((i) => i.naturalWidth > 0); })()`;
    // (the card asks for the pictures of the rows it has on screen with an IntersectionObserver, which a page in an off-screen window may never tell: if none was asked
    // for, the engine is asked for the first rows' pictures the way the card does, so the pictures from Spotify's page are still checked)
    let ok = await waitFor(drawn, 8000);
    if (!ok) { await app.evaluate(async () => { const d = await global.__spotifyEngine.read(); global.__spotifyEngine.loadThumbs(d.results.slice(0, 12).map((r) => r.id)); }); ok = await waitFor(drawn, 17000); }
    const counts = await page(`[${card}.querySelectorAll('.am-pop .am-opt').length, ${card}.querySelectorAll('.am-pop img.am-thumb').length]`);
    const d = await read();
    return { ok, detail: `${counts[0]} rows, ${counts[1]} pictures drawn, none loaded; the engine has a picture for ${(d.results || []).filter((r) => r.thumb).length} of ${(d.results || []).length} results` };
  });
  await step('play the first result: the card shows that song and Pause', async () => {
    await page(`${card}.querySelector('.am-pop .am-songs .am-opt').click()`);
    const want = firstTitle.toLowerCase().slice(0, 12);
    const shown = `Boolean(${card}.querySelector('[aria-label="Pause"]')) && ${JSON.stringify(want)} !== '' && (${card}.querySelector('.sp-title')?.textContent || '').toLowerCase().includes(${JSON.stringify(want)})`;
    let ok = await waitFor(shown, 15000);
    if (!ok) { await page(`${card}.querySelector('.am-pop .am-songs .am-opt')?.click()`); ok = await waitFor(shown, 20000); } // (once more: a press made while the results page was still settling)
    return { ok, detail: `wanted "${firstTitle}", the card shows "${await page(`${card}.querySelector('.sp-title')?.textContent || ''`)}"` };
  });
  await step('the playing song\'s cover art loaded on the card', async () => ({ ok: await waitFor(`(() => { const i = ${card}.querySelector('img.sp-art'); if (i) i.loading = 'eager'; return Boolean(i) && i.naturalWidth > 0; })()`, 15000), detail: 'no picture with naturalWidth > 0 in img.sp-art' }));
  await step('pause: the card shows Play', async () => {
    await page(`${card}.querySelector('[aria-label="Pause"]').click()`);
    return { ok: await waitFor(`Boolean(${card}.querySelector('[aria-label="Play"]'))`, 15000), detail: 'still shows Pause' };
  });
  await step('play again, then next: the song changes', async () => {
    await page(`${card}.querySelector('[aria-label="Play"]').click()`);
    await waitFor(`Boolean(${card}.querySelector('[aria-label="Pause"]'))`, 15000);
    const before = await page(`${card}.querySelector('.sp-title')?.textContent || ''`);
    await page(`${card}.querySelector('[aria-label="Next track"]').click()`);
    const ok = await waitFor(`(${card}.querySelector('.sp-title')?.textContent || '') !== ${JSON.stringify(before)}`, 20000);
    return { ok, detail: `still "${before}"` };
  });
  await step('previous: back to the earlier song, or the start of this one', async () => {
    const was = await page(`${card}.querySelector('.sp-title')?.textContent || ''`);
    await page(`${card}.querySelector('[aria-label="Previous track"]').click()`);
    const ok = await waitFor(`(${card}.querySelector('.sp-title')?.textContent || '') !== ${JSON.stringify(was)} || /^0:0[0-4]$/.test(${card}.querySelector('.sp-elapsed')?.textContent || '')`, 20000);
    return { ok, detail: `still "${was}" and not at the start` };
  });

  // the lists (read from the page's own panels, as the card's tabs do)
  const settled = async (fn, ms = 30000) => { const end = Date.now() + ms; let d = await read(); while (Date.now() < end && fn(d)) { await sleep(400); d = await read(); } return d; };
  await step('Library: it has rows (playlists, albums, artists from Your Library)', async () => {
    await app.evaluate(() => { global.__spotifyEngine.refreshLists(); });
    const d = await settled((x) => x.libraryPending === true);
    return { ok: d.libraryOk === true && d.playlists.length > 0, detail: `ok ${d.libraryOk}, why "${d.libraryWhy}", empty ${d.libraryEmpty}, ${d.playlists.length} rows` };
  });
  await step('Up next: the queue answers', async () => {
    await app.evaluate(() => { global.__spotifyEngine.command('tab', 'queue'); });
    const d = await settled((x) => x.queue.pending === true);
    return { ok: d.queue.ok === true, detail: `why "${d.queue.why}"` };
  });
  await step('Devices: this browser is listed', async () => { const d = await read(); return { ok: Array.isArray(d.devices) && d.devices.some((x) => x.name === 'This browser'), detail: JSON.stringify(d.devices) }; });

  // leave nothing playing
  await page(`(() => { const b = ${card}.querySelector('[aria-label="Pause"]'); if (b) b.click(); })()`).catch(() => {});
  await sleep(1500);
  await app.close().catch(() => {});
  clearTimeout(hard);
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
