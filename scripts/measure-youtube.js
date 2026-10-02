// Measures how well the built-in blocker handles YouTube, in a real Lumen window on a throwaway profile
// (CLAUDE_BROWSER_TEST + a temp CLAUDE_BROWSER_PROFILE; LUMEN_TEST_BACKGROUND keeps the window off-screen).
// A handful of page loads, no sign-in and no account actions. Prints one row per page.
//   node scripts/measure-youtube.js [--json] [--adblock=off] [--app=<folder>]   (--app: measure another checkout)
// Needs network. Watch pages are sampled while they play: an ad that shows, the "ad blockers violate"
// wall, whether the video starts, and console errors.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const os = require('os');
const fs = require('fs');

const args = process.argv.slice(2);
const AS_JSON = args.includes('--json');
const ADBLOCK_OFF = args.includes('--adblock=off');
const APP = path.resolve(args.find((a) => a.startsWith('--app='))?.slice(6) || path.join(__dirname, '..'));

// Runs in the page: what an ad or the enforcement wall looks like right now.
const AD_SEL = 'ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-display-ad-renderer, ytd-promoted-sparkles-web-renderer, ytd-promoted-video-renderer, ytd-banner-promo-renderer, ytd-statement-banner-renderer, #masthead-ad, ytd-player-legacy-desktop-watch-ads-renderer, ytd-companion-slot-renderer, ytd-action-companion-ad-renderer, ytm-promoted-sparkles-web-renderer, ad-slot-renderer';
const SNAPSHOT = `(() => {
  const AD_SEL = ${JSON.stringify(AD_SEL)};
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 4 && r.height > 4 && cs.display !== 'none' && cs.visibility !== 'hidden'; };
  const count = (sel) => [...document.querySelectorAll(sel)].filter(vis).length;
  const player = document.querySelector('#movie_player');
  const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
  const dialogs = [...document.querySelectorAll('ytd-enforcement-message-view-model, tp-yt-paper-dialog, ytd-popup-container yt-playability-error-supported-renderers')].filter(vis);
  const wall = dialogs.some((d) => /ad blockers? (violate|are not allowed)|video player will be blocked|allow youtube/i.test(d.innerText || ''))
    || [...document.querySelectorAll('ytd-enforcement-message-view-model')].some(vis);
  let pr = null;
  try { pr = player && player.getPlayerResponse && player.getPlayerResponse(); } catch {}
  let status = null; try { status = pr && pr.playabilityStatus && pr.playabilityStatus.status; } catch {}
  return {
    url: location.pathname + location.search.slice(0, 40),
    adShowing: Boolean(player && player.classList.contains('ad-showing')) || count('.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout, .ytp-ad-text, .ytp-ad-preview-container, .ytp-ad-skip-button-modern, .ytp-ad-skip-button') > 0,
    adBadge: count('.ytp-ad-badge, ad-badge-view-model, .ytp-ad-simple-ad-badge') > 0,
    videoAds: count('.video-ads .ytp-ad-module > *'),
    overlayAd: count('.ytp-ad-overlay-container .ytp-ad-overlay-slot > *, .ytp-ce-element.ytp-ce-covering-overlay'),
    adSlots: count(AD_SEL),
    adSlotTags: [...new Set([...document.querySelectorAll(AD_SEL)].filter(vis).map((e) => e.tagName.toLowerCase()))],
    adSlotsDom: document.querySelectorAll('ytd-ad-slot-renderer, ytd-display-ad-renderer, ytd-promoted-sparkles-web-renderer, ytd-in-feed-ad-layout-renderer').length,
    wall,
    playerAdPlacements: pr ? Boolean(pr.adPlacements && pr.adPlacements.length) || Boolean(pr.playerAds && pr.playerAds.length) : null,
    status,
    time: video ? Math.round(video.currentTime * 10) / 10 : null,
    playing: video ? !video.paused && !video.ended && video.readyState >= 3 : null,
    ready: video ? video.readyState : null,
    duration: video ? Math.round(video.duration) || 0 : null,
  };
})()`;

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-yt-measure-'));
  // --adblock=off: the control run (does this network/region see ads at all?), with the setting off in the profile.
  if (ADBLOCK_OFF) fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ adblock: false }));
  const app = await electron.launch({
    args: [APP],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' },
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const log = (...a) => { if (!AS_JSON) console.error(...a); };
  const go = (url) => app.evaluate((_e, u) => global.__agent.execute('navigate', { url: u }), url);
  const js = (code) => app.evaluate((_e, c) => global.__agent.browser.activeTab().webContents.executeJavaScript(c, true), code).catch((e) => ({ error: String(e.message || e).slice(0, 120) }));
  const sleep = (ms) => ui.waitForTimeout(ms);

  if (!ADBLOCK_OFF) {
    const start = Date.now();
    while (!(await app.evaluate(() => global.__adblock.ready())) && Date.now() - start < 90000) await sleep(500);
    log('adblock ready:', await app.evaluate(() => global.__adblock.ready()));
    // The signed-in engine patch is swapped in a few seconds later; give it time so the run is steady state.
    await sleep(8000);
  }

  // Console errors of the active tab, collected in the main process.
  await app.evaluate(() => {
    global.__ytConsole = [];
    const wc = global.__agent.browser.activeTab().webContents;
    wc.on('console-message', (...a) => {
      const d = a.length === 1 ? a[0] : { level: a[1], message: a[2] };
      const level = typeof d.level === 'string' ? d.level : ['verbose', 'info', 'warning', 'error'][d.level] || d.level;
      if (level === 'error' || level === 3) global.__ytConsole.push(String(d.message).slice(0, 160));
    });
  });

  const rows = [];
  async function sample(label, url, { seconds, every = 2, afterLoad, play = true } = {}) {
    await app.evaluate(() => { global.__ytConsole = []; });
    await go(url);
    await sleep(3500);
    if (play) await js(`(() => { const v = document.querySelector('video'); if (v && v.paused) v.play().catch(() => {}); })()`);
    if (afterLoad) await afterLoad();
    const snaps = [];
    for (let t = 0; t < seconds; t += every) {
      await sleep(every * 1000);
      // Autoplay can be held until a gesture; nudge a paused video once or twice.
      if (play && t < 10) await js(`(() => { const v = document.querySelector('video.html5-main-video'); if (v && v.paused && !v.ended && (document.querySelector('#movie_player')||{}).classList) v.play().catch(() => {}); })()`);
      snaps.push(await js(SNAPSHOT));
    }
    const ok = snaps.filter((s) => !s.error);
    const any = (k) => ok.some((s) => s[k]);
    const max = (k) => Math.max(0, ...ok.map((s) => s[k] || 0));
    const last = ok[ok.length - 1] || {};
    const errs = await app.evaluate(() => global.__ytConsole.slice());
    const row = {
      page: label,
      adShowing: any('adShowing') || any('adBadge'),
      videoAds: max('videoAds'),
      overlayAd: max('overlayAd'),
      adSlotsVisible: max('adSlots'),
      adSlotTags: [...new Set(ok.flatMap((x) => x.adSlotTags || []))],
      adSlotsDom: max('adSlotsDom'),
      wall: any('wall'),
      adInPlayerResponse: any('playerAdPlacements'),
      status: last.status ?? null,
      playbackStarted: ok.some((s) => s.playing) || ok.some((s) => (s.time || 0) > 1),
      endTime: last.time ?? null,
      duration: last.duration ?? null,
      consoleErrors: errs.length,
      sampleErrors: [...new Set(errs)].slice(0, 3),
    };
    rows.push(row);
    log(JSON.stringify(row));
    return row;
  }

  const WATCH = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  await sample('watch (popular)', WATCH, { seconds: 24 });

  // A long video: pick from a search for full-length episodes (30+ minutes), then jump near a typical mid-roll point.
  await go('https://www.youtube.com/results?search_query=full+podcast+episode+3+hours');
  await sleep(6000);
  const long = await js(`(() => {
    // Any watch link whose card shows an hours:minutes:seconds length (an hour or more).
    for (const a of document.querySelectorAll('a[href^="/watch?v="]')) {
      const card = a.closest('ytd-video-renderer, yt-lockup-view-model, ytd-rich-item-renderer') || a.parentElement;
      if (/(^|\\s)\\d{1,2}:\\d{2}:\\d{2}(\\s|$)/.test(card?.innerText || '')) return a.href;
    }
    return '';
  })()`);
  log('long video:', long);
  await sample('search results', 'https://www.youtube.com/results?search_query=full+podcast+episode', { seconds: 8, play: false });
  if (long && typeof long === 'string') {
    await sample('long video + mid-roll point', long, {
      seconds: 36,
      afterLoad: async () => {
        // Mid-rolls are scheduled by time: play the first half-minute, then jump to ~8 minutes in.
        await sleep(12000);
        await js(`(() => { const v = document.querySelector('video.html5-main-video'); if (v && v.duration > 600) v.currentTime = 480; })()`);
      },
    });
  } else rows.push({ page: 'long video', skipped: 'no 30+ minute video found in search' });
  await sample('home feed', 'https://www.youtube.com/', { seconds: 14, play: false });
  await sample('shorts', 'https://www.youtube.com/shorts/', { seconds: 12, play: false }).catch(() => {});

  if (AS_JSON) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log('| page | ad shown | video-ads | overlay | ad slots visible (dom) | wall | ads in player response | playback | console errors |');
    console.log('|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) {
      if (r.skipped) { console.log(`| ${r.page} | skipped: ${r.skipped} |`); continue; }
      console.log(`| ${r.page} | ${r.adShowing ? 'YES' : 'no'} | ${r.videoAds} | ${r.overlayAd} | ${r.adSlotsVisible} (${r.adSlotsDom})${r.adSlotTags.length ? ` ${r.adSlotTags.join(',')}` : ''} | ${r.wall ? 'YES' : 'no'} | ${r.adInPlayerResponse === null ? 'n/a' : r.adInPlayerResponse ? 'YES' : 'no'} | ${!r.duration ? 'n/a' : r.playbackStarted ? `yes (t=${r.endTime}s)` : 'NO'} | ${r.consoleErrors} |`);
    }
  }
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
