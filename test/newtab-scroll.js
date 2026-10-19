// New tab page scrolling: the page scrolls only when its content really runs past the window (no spacer under cards or
// the centre column that fits), a wheel over a card does not move a page with nothing to scroll, a card's own scrolling
// area that is at its end does not hand the wheel to the page, and a tall page still scrolls under the pointer.
// Offline; a throwaway profile; LUMEN_TEST_BACKGROUND keeps the window off-screen.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-ntscroll-profile-'));
  // No sections, two cards in the top row; the notes card is 8 rows tall (its bottom is ~576px down the page).
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false,
    homeWidgets: [{ id: 'wscroll001', type: 'notes', x: 0, y: 0, w: 3, h: 8 }, { id: 'wscroll002', type: 'timer', x: 9, y: 0, w: 3, h: 3 }] }));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__stab = t; t.webContents.once('did-finish-load', res); }));
    const page = (code) => app.evaluate((_e, c2) => global.__stab.webContents.executeJavaScript(c2), code);
    await app.evaluate(() => { try { global.__stab.webContents.debugger.attach('1.3'); } catch { /* already attached */ } });
    const resize = async (height) => { // the page's window, 1280 wide and `height` tall
      await app.evaluate((_e, h) => global.__stab.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1280, height: h, deviceScaleFactor: 1, mobile: false }), height);
      await sleep(900);
    };
    const wheel = async (x, y, dy, ticks = 4) => {
      await app.evaluate((_e, [px, py, d, n]) => { for (let i = 0; i < n; i++) global.__stab.webContents.sendInputEvent({ type: 'mouseWheel', x: px, y: py, deltaX: 0, deltaY: d, canScroll: true }); }, [x, y, dy, ticks]);
      await sleep(500);
      return page('scrollY');
    };
    const sizes = () => page('({ inner: innerHeight, scroll: document.documentElement.scrollHeight, cardsBottom: Math.max(...[...document.querySelectorAll(".w-card")].map((c) => c.getBoundingClientRect().bottom + scrollY)), main: document.querySelector("main").offsetHeight })');
    const centre = () => page('(() => { const r = document.querySelector(".w-card").getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()');
    for (let i = 0; i < 60 && !(await page('document.querySelectorAll(".w-card").length >= 2').catch(() => false)); i++) await sleep(100);
    await sleep(800);

    // 1. everything fits: the cards end at ~576px, the window is 590px: nothing to scroll, whatever the room under the cards.
    await resize(590);
    let z = await sizes();
    check(`cards that fit (bottom ${Math.round(z.cardsBottom)}px in a ${z.inner}px window): the page does not scroll`, z.scroll <= z.inner, JSON.stringify(z));
    let [cx, cy] = await centre();
    check('a wheel over a card on a page that fits leaves it at the top', (await wheel(cx, cy, -120)) === 0, '');
    check('a wheel over the empty page too', (await wheel(640, 600, -120)) === 0, '');

    // 2. the centre column fits but its bottom padding alone would not: still nothing to scroll.
    await resize(370);
    await page('document.querySelectorAll(".w-card").forEach((c) => { c.style.display = "none"; }), (document.getElementById("widgets").style.height = "0px")');
    z = await sizes();
    check(`a centre column that fits (${z.main}px tall, 370px window): the page does not scroll`, z.scroll <= z.inner, JSON.stringify(z));
    await page('document.querySelectorAll(".w-card").forEach((c) => { c.style.display = ""; }), window.widgetGrid.relayout()');
    await sleep(500);

    // 3. cards that run past the window: the page scrolls, with the room under the last card, and the wheel works over a card.
    z = await sizes();
    check('cards that run past the window: the page scrolls to them plus their room', z.scroll > z.inner && z.scroll >= z.cardsBottom + 31, JSON.stringify(z));
    [cx, cy] = await centre();
    check('a wheel over a card scrolls a page that is tall', (await wheel(cx, cy, -120)) > 100, '');
    await page('scrollTo(0, 0)');

    // 4. a scrolling area that is at its end does not hand the wheel to the page; one with room scrolls itself; one that
    //    does not scroll (or is overflow: hidden) lets the wheel reach a page that really is tall.
    const mk = (cls, style, h) => page(`(() => { document.querySelectorAll('[id^=ex-]').forEach((e) => e.remove()); scrollTo(0, 0);
      const d = document.createElement('div'); d.id = 'ex-a'; d.className = ${JSON.stringify(cls)}; d.style.cssText = 'position:fixed;left:40px;top:60px;width:200px;height:120px;z-index:99;overflow-y:auto;' + ${JSON.stringify(style)};
      d.innerHTML = '<div style="height:${h}px">x</div>'; document.body.appendChild(d); return true; })()`);
    await mk('td-scroll', '', 600); await page('document.getElementById("ex-a").scrollTop = 99999');
    check('a list at its end: the wheel does not scroll the page', (await wheel(140, 120, -120)) === 0, '');
    await mk('td-scroll', '', 600);
    const top = await wheel(140, 120, -120);
    check('a list with room scrolls itself, not the page', top === 0 && (await page('document.getElementById("ex-a").scrollTop')) > 0, top);
    await mk('td-scroll', '', 20);
    check('an area that does not scroll lets the wheel reach a tall page', (await wheel(140, 120, -120)) > 100, '');
    await mk('w-body', 'overflow:hidden', 600);
    check('an overflow-hidden body lets the wheel reach a tall page', (await wheel(140, 120, -120)) > 100, '');
    await page('document.querySelectorAll("[id^=ex-]").forEach((e) => e.remove()); scrollTo(0, 0)');
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall new-tab scroll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
