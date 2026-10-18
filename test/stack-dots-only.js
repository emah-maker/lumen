// New-tab stacks change card only through the rail's dots (click, or the arrow keys on a focused dot): the mouse wheel and
// trackpad-style scrolling (deltaX and deltaY) over a stack never switch the card, a card's own scrolling list still
// scrolls, and the shown card is remembered across a reload. Offline; a throwaway profile; the window stays off-screen.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-stackdots-profile-'));
  const sid = 'sdots0001';
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ newTabFavorites: false, newTabFrequent: false, newTabPrivacy: false, homeWidgets: [
    { id: 'wsd000001', type: 'notes', x: 0, y: 0, w: 4, h: 5, stack: sid, top: true },
    { id: 'wsd000002', type: 'timer', x: 0, y: 0, w: 4, h: 5, stack: sid },
    { id: 'wsd000003', type: 'files', x: 0, y: 0, w: 4, h: 5, stack: sid }] }));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  try {
    const page = (code) => app.evaluate((_e, c2) => global.__stab.webContents.executeJavaScript(c2), code);
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate(() => new Promise((res) => { const t = global.__agent.browser.openTab(); global.__stab = t; t.webContents.once('did-finish-load', res); }));
    await app.evaluate(() => { try { global.__stab.webContents.debugger.attach('1.3'); } catch { /* already attached */ } });
    const ready = async () => {
      for (let i = 0; i < 60 && !(await page('document.querySelectorAll(".w-stack-dot").length >= 3').catch(() => false)); i++) await sleep(100);
      await sleep(600);
    };
    const shown = () => page('[...document.querySelectorAll(".w-card.in-stack:not(.w-under)")].map((x) => x.dataset.id).join()');
    const rect = () => page('(() => { const r = document.querySelector(".w-card.in-stack:not(.w-under)").getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()');
    const wheel = (x, y, dx, dy, n = 5) => app.evaluate((_e, [px, py, ddx, ddy, k]) => { for (let i = 0; i < k; i++) global.__stab.webContents.sendInputEvent({ type: 'mouseWheel', x: px, y: py, deltaX: ddx, deltaY: ddy, canScroll: true, hasPreciseScrollingDeltas: ddx !== 0 && ddy !== 0 }); }, [x, y, dx, dy, n]);
    const key = (k) => app.evaluate((_e, kk) => Promise.all(['keyDown', 'keyUp'].map((type) => global.__stab.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type, key: kk, code: kk, windowsVirtualKeyCode: { ArrowDown: 40, ArrowUp: 38 }[kk] }))), k);
    const savedTop = () => (JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')).homeWidgets || []).filter((w) => w.top).map((w) => w.id).join();
    const waitShown = async (id) => { for (let i = 0; i < 40 && (await shown()) !== id; i++) await sleep(100); return shown(); };
    await ready();

    const labels = await page('[...document.querySelectorAll(".w-card:not(.w-under) .w-stack-dot")].map((d) => d.tagName + ":" + d.getAttribute("aria-label")).join("|")');
    check('the stack shows its first card and has three labelled dot buttons', (await shown()) === 'wsd000001' && /^(BUTTON:Show .+, [123] of 3(\||$)){3}$/.test(labels), `${await shown()} ${labels}`);
    const dot = await page('(() => { const r = document.querySelector(".w-card:not(.w-under) .w-stack-dot").getBoundingClientRect(); return [r.width, r.height]; })()');
    check('a dot is at least 24 by 24 px', dot[0] >= 24 && dot[1] >= 24, dot);

    // wheel and trackpad-style deltas over the stack do nothing to the shown card
    const [cx, cy] = await rect();
    await wheel(cx, cy, 0, 120); await sleep(600);
    check('a mouse wheel down over the stack does not change the card', (await shown()) === 'wsd000001', await shown());
    await wheel(cx, cy, 0, -120); await sleep(600);
    check('a mouse wheel up does not either', (await shown()) === 'wsd000001', await shown());
    await wheel(cx, cy, 40, 60, 8); await sleep(600);
    check('trackpad-style deltaX and deltaY together do not either', (await shown()) === 'wsd000001', await shown());
    await wheel(cx, cy, 120, 0, 8); await sleep(600);
    check('a sideways swipe does not either', (await shown()) === 'wsd000001', await shown());
    check('...and nothing was saved as a switch', savedTop() === 'wsd000001', savedTop());

    // a scrollable list inside the card still scrolls, and at its end the stack stays put
    await page(`(() => { const body = document.querySelector('.w-card:not(.w-under)'); const d = document.createElement('div'); d.id = 'sd-list';
      d.style.cssText = 'position:absolute;left:12px;top:40px;width:160px;height:90px;overflow-y:auto;z-index:5;background:#888'; d.innerHTML = '<div style="height:900px">x</div>'; body.appendChild(d); })()`);
    const lr = await page('(() => { const r = document.getElementById("sd-list").getBoundingClientRect(); return [Math.round(r.left + 80), Math.round(r.top + 45)]; })()');
    await wheel(lr[0], lr[1], 0, -120, 3); await sleep(600);
    const st = await page('document.getElementById("sd-list").scrollTop');
    check('a wheel over a list inside the card scrolls that list', st > 0 && (await shown()) === 'wsd000001', st);
    await page('document.getElementById("sd-list").scrollTop = 99999');
    await wheel(lr[0], lr[1], 0, -120, 6); await sleep(600);
    check('at the end of the list the wheel does not switch the stack', (await shown()) === 'wsd000001', await shown());
    await page('document.getElementById("sd-list").remove()');

    // the dots
    await page('document.querySelectorAll(".w-card:not(.w-under) .w-stack-dot")[1].click()');
    check('clicking dot 2 shows card 2', (await waitShown('wsd000002')) === 'wsd000002', await shown());
    await sleep(800);
    check('the dot says which card is shown', (await page('[...document.querySelectorAll(".w-card:not(.w-under) .w-stack-dot")].map((d) => d.getAttribute("aria-current")).join()')) === 'false,true,false', '');
    check('the shown card is remembered by the browser', savedTop() === 'wsd000002', savedTop());

    await page('document.querySelectorAll(".w-card:not(.w-under) .w-stack-dot")[1].focus()');
    await key('ArrowDown');
    check('ArrowDown on a focused dot moves to the next card', (await waitShown('wsd000003')) === 'wsd000003', await shown());
    await sleep(800);
    await page('document.querySelector(".w-card:not(.w-under) .w-stack-dot").focus()');
    await key('ArrowUp');
    check('ArrowUp moves back', (await waitShown('wsd000002')) === 'wsd000002', await shown());
    await sleep(900);

    // it persists across a reload
    await app.evaluate(() => global.__stab.webContents.reload());
    await sleep(1500);
    await ready();
    check('after a reload the same card is shown', (await shown()) === 'wsd000002', await shown());
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nall stack-dot checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
