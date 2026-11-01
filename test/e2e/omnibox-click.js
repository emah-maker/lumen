// A click anywhere in the address field (not only on its text) focuses the address bar, and a click on one of its
// buttons does not. When the tab's page takes the keyboard (a site opened from the new-tab page), the address bar lets go,
// so Reload and the other buttons at its end show and work (they stayed faded and unclickable while the field kept :focus).
'use strict';
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (name, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-omni-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await sleep(800);
    const focused = () => ui.evaluate(() => document.activeElement?.id === 'address');
    const blur = async () => { await ui.evaluate(() => document.activeElement?.blur()); await sleep(100); };
    const box = await ui.evaluate(() => { const r = document.getElementById('omnibox').getBoundingClientRect(); const a = document.getElementById('address').getBoundingClientRect(); const end = document.querySelector('#omnibox .omnibox-end').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, ax: a.x, aw: a.width, ex: end.x }; });
    const y = box.y + box.h / 2;
    for (const [label, x] of [['the far left of the field', box.x + 6], ['left of the text', box.x + Math.max(8, (box.ax - box.x) / 2)], ['the far right of the field (left of its buttons: Reload, the star and the rest sit at the right end, as in Chrome)', box.ex - 3], ['the middle of the text area', box.ax + box.aw / 2]]) {
      await blur();
      await ui.mouse.click(x, y);
      await sleep(150);
      check(`a click on ${label} focuses the address bar`, await focused(), `x=${Math.round(x)} box=${JSON.stringify(box)}`);
    }
    // The reload button inside the field still does its own job and does not turn into an address click.
    await blur();
    const reload = await ui.evaluate(() => { const r = document.getElementById('reload').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await ui.mouse.click(reload.x, reload.y);
    await sleep(150);
    check('a click on the reload button inside the field does not focus the address', !(await focused()), 'address took focus');

    // A new tab (the address bar has the keyboard), then a click in its page opens a site, as a click on a tile does.
    const site = path.join(profile, 'site.html');
    fs.writeFileSync(site, '<!doctype html><title>site</title><p>site</p>');
    await ui.keyboard.press('Control+t');
    await sleep(1200);
    await ui.focus('#address'); // (as a new tab leaves it: Ctrl+T from the toolbar above doesn't always land the keyboard there in a hidden window)
    await sleep(150);
    check('the new tab has the address bar focused, its end buttons faded', await ui.evaluate(() => document.getElementById('address').matches(':focus') && getComputedStyle(document.querySelector('#omnibox .omnibox-end')).pointerEvents === 'none'), 'not focused');
    const siteUrl = require('url').pathToFileURL(site).href;
    const opened = await app.evaluate(({ webContents }, url) => {
      const page = webContents.getAllWebContents().filter((w) => w.getType() === 'window' && /newtab/i.test(w.getURL())).sort((a, b) => b.id - a.id)[0];
      if (!page) return false;
      page.focus();
      page.sendInputEvent({ type: 'mouseDown', x: 5, y: 5, button: 'left', clickCount: 1 }); // (a real click: Lumen's own page focus after a load doesn't count)
      page.sendInputEvent({ type: 'mouseUp', x: 5, y: 5, button: 'left', clickCount: 1 });
      page.executeJavaScript(`location.href = ${JSON.stringify(url)}`).catch(() => {});
      return true;
    }, siteUrl);
    check('the new-tab page is found', opened, 'no new-tab page');
    await sleep(2000);
    check('the page taking focus lets go of the address bar', !(await ui.evaluate(() => document.getElementById('address').matches(':focus'))), 'address still :focus');
    const end = await ui.evaluate(() => { const b = document.getElementById('reload'); const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return { x: r.x + r.width / 2, y: r.y + r.height / 2, opacity: getComputedStyle(b.parentElement).opacity, hit: Boolean(top && b.contains(top)) }; });
    check('Reload shows and takes the click', end.opacity === '1' && end.hit, JSON.stringify(end));
    const originOf = () => app.evaluate(async ({ webContents }, url) => { const w = webContents.getAllWebContents().find((x) => x.getURL() === url); return w ? w.executeJavaScript('String(performance.timeOrigin)') : null; }, siteUrl);
    const before = await originOf();
    await ui.mouse.click(end.x, end.y);
    await sleep(1500);
    const after = await originOf();
    check('and a click on it reloads the page', Boolean(before && after && before !== after), `${before} -> ${after}`);
  } finally { await app.close().catch(() => {}); }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
