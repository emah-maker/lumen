// YouTube with the built-in ad blocker, in a real Lumen window (needs the network: skips cleanly, exit 0, when
// YouTube can't be reached or answers with a consent page). A throwaway profile; no sign-in, no account actions.
// A watch page must start playing with no ad overlay and no "ad blockers violate" dialog; the feed and search
// pages must show no ad slots; the engine must carry the current YouTube rules.
const { _electron: electron } = require('playwright-core');
const path = require('path');

const reachable = async () => {
  try {
    const res = await fetch('https://www.youtube.com/generate_204', { signal: AbortSignal.timeout(8000) });
    return res.status === 204 || res.ok;
  } catch { return false; }
};

(async () => {
  if (!(await reachable())) { console.log('SKIP  youtube.com is not reachable (offline?): nothing to check'); process.exit(0); }
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const go = (url) => app.evaluate((_e, u) => global.__agent.execute('navigate', { url: u }), url);
  const js = (code) => app.evaluate((_e, c) => global.__agent.browser.activeTab().webContents.executeJavaScript(c, true), code).catch((e) => ({ error: String(e.message || e) }));
  const finish = async () => { console.log(failures ? `${failures} FAILED` : 'ALL PASSED'); await app.close(); process.exit(failures ? 1 : 0); };

  const start = Date.now();
  while (!(await app.evaluate(() => global.__adblock.ready())) && Date.now() - start < 90000) await ui.waitForTimeout(500);
  check('filter lists load', await app.evaluate(() => global.__adblock.ready()), 'not ready after 90s');
  await ui.waitForTimeout(6000); // the engine with the extra rules is swapped in a few seconds after launch

  // The engine: current YouTube scriptlets (from the current uBlock files) and the extra hiding rules.
  const engine = await app.evaluate(() => {
    const e = global.__adblockEngine;
    const q = (url, hostname) => e.getCosmeticsFilters({ url, hostname, domain: 'youtube.com', getBaseRules: false, getInjectionRules: true, getExtendedRules: true, getRulesFromHostname: true, getRulesFromDOM: false });
    const r = q('https://www.youtube.com/watch?v=x', 'www.youtube.com');
    return { scripts: r.scripts.length, prunesAds: r.scripts.some((s) => /adPlacements/.test(s)), css: r.styles.includes('ytd-ad-slot-renderer'), wall: r.styles.includes('ytd-enforcement-message-view-model') };
  });
  check('engine has YouTube\'s ad-field scriptlets', engine.scripts >= 15 && engine.prunesAds, JSON.stringify(engine));
  check('engine hides ad slots and the enforcement dialog on YouTube', engine.css && engine.wall, JSON.stringify(engine));

  // What the page's preload is handed: the lists' scriptlets plus the ad fallback on YouTube, nothing extra elsewhere.
  const handed = await app.evaluate(({ ipcMain }) => {
    const ask = (url) => { const event = { frameId: 0, processId: 0, returnValue: null }; ipcMain.listeners('lumen-adblock:scriptlets')[0](event, url); return event.returnValue || []; };
    const yt = ask('https://www.youtube.com/watch?v=x');
    return { yt: yt.length, fallback: yt.some((s) => /ad-showing/.test(s)), other: ask('https://example.com/').some((s) => /ad-showing/.test(s)) };
  });
  check('YouTube pages are handed the ad fallback, other sites are not', handed.fallback && !handed.other && handed.yt >= 15, JSON.stringify(handed));

  // A watch page: samples while it plays.
  await go('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await ui.waitForTimeout(3500);
  const url = await js('location.href');
  if (typeof url === 'string' && /consent\./.test(url)) { console.log('SKIP  YouTube asks for consent here (a regional consent page): playback checks need a page that loads'); await finish(); return; }
  const snaps = [];
  for (let i = 0; i < 10; i++) {
    await js(`(() => { const v = document.querySelector('video.html5-main-video'); if (v && v.paused && !v.ended) v.play().catch(() => {}); })()`);
    await ui.waitForTimeout(2000);
    snaps.push(await js(`(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 && getComputedStyle(e).display !== 'none'; };
      const p = document.querySelector('#movie_player'); const v = document.querySelector('video.html5-main-video');
      return {
        ad: Boolean(p && p.classList.contains('ad-showing')) || [...document.querySelectorAll('.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout, .ytp-ad-text, .ytp-ad-skip-button-modern')].some(vis),
        wall: [...document.querySelectorAll('ytd-enforcement-message-view-model, tp-yt-paper-dialog')].some((d) => vis(d) && /ad blockers? (violate|are not allowed)|video player will be blocked/i.test(d.innerText || '')),
        time: v ? v.currentTime : -1, ready: v ? v.readyState : -1,
      };
    })()`));
  }
  const ok = snaps.filter((s) => !s.error);
  check('watch page: no ad is showing in the player', ok.length > 5 && !ok.some((s) => s.ad), JSON.stringify(ok.filter((s) => s.ad).slice(0, 2)));
  check('watch page: no "ad blockers violate" dialog', ok.length > 5 && !ok.some((s) => s.wall), 'dialog seen');
  const last = ok[ok.length - 1] || {};
  check('watch page: playback starts and advances', ok.some((s) => s.time > 3) && last.time > ok[0].time, JSON.stringify([ok[0], last]));

  // The feed and search: no ad slots on screen.
  for (const [label, target] of [['home feed', 'https://www.youtube.com/'], ['search results', 'https://www.youtube.com/results?search_query=music']]) {
    await go(target);
    await ui.waitForTimeout(7000);
    const slots = await js(`[...document.querySelectorAll('ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-display-ad-renderer, ytd-promoted-sparkles-web-renderer, ytd-banner-promo-renderer')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 && getComputedStyle(e).display !== 'none'; }).map((e) => e.tagName.toLowerCase())`);
    check(`${label}: no ad slots on screen`, Array.isArray(slots) && !slots.length, JSON.stringify(slots));
  }

  await finish();
})().catch((e) => { console.error(e); process.exit(1); });
