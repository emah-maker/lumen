// Hidden run: the chat's picture viewer (renderer/chat-image-viewer.js, loaded by renderer/gen-images.js on the first click).
// A stubbed chat message with two pictures, in the sidebar chat (driven with the real mouse and keyboard) and in the full-page
// chat (lumen://chat, driven by script): the viewer code is not loaded before the first click; a click opens it; the wheel changes
// the scale; double-click toggles fit / 100% (and 2x for a small picture); dragging pans; Esc closes and focus goes back to the
// picture; Left / Right step between the two pictures; the toolbar has named buttons; Open in a tab opens the picture.
// Set LUMEN_ZOOM_SHOT=<file.png> to keep a screenshot of the zoomed viewer.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

// Builds, in the page, a stubbed conversation: a user message with a big picture (1600x1200) and a small one (24x24), as a sent message draws them.
const STUB = `(() => {
  const make = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); return c.toDataURL('image/png'); };
  const big = make(1600, 1200, (g, w, h) => { const grad = g.createLinearGradient(0, 0, w, h); grad.addColorStop(0, '#ff6b35'); grad.addColorStop(1, '#2a6fdb'); g.fillStyle = grad; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.font = 'bold 160px sans-serif'; g.fillText('ZOOM ME', 300, 640); g.strokeStyle = '#fff'; g.lineWidth = 6; for (let x = 0; x < w; x += 100) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); } });
  const small = make(24, 24, (g) => { g.fillStyle = '#d33'; g.fillRect(0, 0, 24, 24); });
  const host = document.getElementById('messages');
  document.getElementById('empty')?.setAttribute('hidden', '');
  const bubble = document.createElement('div');
  bubble.className = 'msg user';
  bubble.id = 'zoom-stub';
  const row = document.createElement('div');
  row.className = 'msg-images';
  [big, small].forEach((src, i) => { const im = document.createElement('img'); im.src = src; im.alt = 'Picture ' + (i + 1); window.genImages.zoomable(im); row.append(im); });
  bubble.append(row);
  host.append(bubble);
  return true;
})()`;

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-imgzoom-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  try {
    const ui = await app.firstWindow();
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await ui.waitForSelector('#messages', { state: 'attached' });
    await ui.evaluate(STUB);

    // ---- lazy: nothing of the viewer is loaded yet
    const before = await ui.evaluate(() => ({
      api: typeof window.chatImageViewer,
      script: [...document.scripts].some((s) => /chat-image-viewer/.test(s.src)),
      css: [...document.querySelectorAll('link')].some((l) => /chat-image-viewer/.test(l.href)),
      fetched: performance.getEntriesByType('resource').some((r) => /chat-image-viewer/.test(r.name)),
    }));
    check('the viewer code and styles are not loaded before the first click', before.api === 'undefined' && !before.script && !before.css && !before.fetched, JSON.stringify(before));
    const inline = await ui.evaluate(() => { const im = document.querySelector('#zoom-stub img'); return { cursor: getComputedStyle(im).cursor, title: im.title, role: im.getAttribute('role'), tab: im.tabIndex }; });
    check('pictures in the chat show a zoom-in cursor, a hint and are keyboard-reachable', inline.cursor === 'zoom-in' && inline.title === 'Click to zoom' && inline.role === 'button' && inline.tab === 0, JSON.stringify(inline));

    // ---- a click opens it
    await ui.locator('#zoom-stub img').first().click();
    const dlg = ui.locator('.civ[role=dialog]');
    await dlg.waitFor({ timeout: 8000 });
    await waitFor(async () => (await dlg.getAttribute('data-ready')) === '1');
    check('a click opens the viewer: a labelled, modal dialog', (await dlg.count()) === 1 && (await dlg.getAttribute('aria-modal')) === 'true' && /Picture 1/.test((await dlg.getAttribute('aria-label')) || ''), await dlg.count());
    const after = await ui.evaluate(() => ({ api: typeof window.chatImageViewer, script: [...document.scripts].some((s) => /chat-image-viewer/.test(s.src)), inside: Boolean(document.activeElement?.closest('.civ')) }));
    check('the viewer loaded on that click, and focus moved into it', after.api === 'object' && after.script && after.inside, JSON.stringify(after));
    const scaleOf = async () => Number(await dlg.getAttribute('data-scale'));
    const attr = async (n) => Number(await dlg.getAttribute(`data-${n}`));
    const fit0 = await scaleOf();
    check('it opens fit to the panel (a 1600 px picture shrinks)', fit0 > 0 && fit0 < 1, fit0);
    const names = await ui.evaluate(() => [...document.querySelectorAll('.civ button')].filter((b) => !b.hidden).map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim()));
    check('the toolbar has named buttons: zoom, fit, 100%, save, copy, open in a tab, close, previous / next', ['Zoom out', 'Zoom in', 'Fit', '100%', 'Save', 'Copy image', 'Open in a tab', 'Close', 'Previous picture', 'Next picture'].every((n) => names.includes(n)), names.join('|'));

    // ---- wheel zooms toward the pointer
    const box = await ui.locator('.civ-stage').boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await ui.mouse.move(cx, cy);
    await ui.mouse.wheel(0, -400);
    await waitFor(async () => (await scaleOf()) > fit0 + 0.01);
    const zoomedIn = await scaleOf();
    check('the wheel up zooms in', zoomedIn > fit0, `${fit0} -> ${zoomedIn}`);
    await ui.mouse.wheel(0, 400);
    await waitFor(async () => (await scaleOf()) < zoomedIn - 0.01);
    check('the wheel down zooms out', (await scaleOf()) < zoomedIn, await scaleOf());
    await ui.keyboard.press('0');
    // pointer-anchored: zoom with the pointer at the picture's right edge side and the point under it stays put
    await ui.mouse.move(box.x + box.width - 20, cy);
    const imgBox = () => ui.locator('.civ-img').boundingBox();
    const pb = await imgBox();
    const relX = (box.x + box.width - 20 - pb.x) / pb.width;
    await ui.mouse.wheel(0, -300);
    await waitFor(async () => (await scaleOf()) > fit0 + 0.01);
    const pa = await imgBox();
    const relAfter = (box.x + box.width - 20 - pa.x) / pa.width;
    check('zoom keeps the point under the cursor where it is', Math.abs(relX - relAfter) < 0.02, `${relX} vs ${relAfter}`);
    const lim = await ui.evaluate(async () => { const d = document.querySelector('.civ'); const r = []; d.querySelector('.civ-stage').dispatchEvent(new WheelEvent('wheel', { deltaY: -100000, ctrlKey: true, clientX: 100, clientY: 100, bubbles: true, cancelable: true })); r.push(Number(d.dataset.scale)); d.querySelector('.civ-stage').dispatchEvent(new WheelEvent('wheel', { deltaY: 100000, ctrlKey: true, clientX: 100, clientY: 100, bubbles: true, cancelable: true })); r.push(Number(d.dataset.scale)); return r; });
    check('zoom is clamped to 10x at most and 0.1x at least (Ctrl+wheel, a pinch)', lim[0] === 10 && lim[1] === 0.1, JSON.stringify(lim));
    await ui.keyboard.press('+');
    await ui.keyboard.press('-');
    await ui.keyboard.press('0');
    check('0 returns to fit', Math.abs((await scaleOf()) - fit0) < 0.005, await scaleOf());
    await ui.keyboard.press('+');
    check('+ zooms in', (await scaleOf()) > fit0 * 1.2, await scaleOf());
    await ui.getByRole('button', { name: 'Zoom out' }).click();
    check('the Zoom out button zooms out (to fit again)', Math.abs((await scaleOf()) - fit0) < 0.01, await scaleOf());

    // ---- double-click toggles
    await ui.keyboard.press('0');
    await ui.mouse.dblclick(cx, cy); // (at the panel's centre: Playwright would aim at the middle of the part of a 1600 px picture that is on screen)
    await waitFor(async () => Math.abs((await scaleOf()) - 1) < 0.001);
    check('double-click goes from fit to 100%', Math.abs((await scaleOf()) - 1) < 0.001, await scaleOf());
    check('the toolbar shows the percentage', (await ui.locator('.civ-pct').innerText()) === '100%', await ui.locator('.civ-pct').innerText());
    await ui.mouse.dblclick(cx, cy); // (at the panel's centre: Playwright would aim at the middle of the part of a 1600 px picture that is on screen)
    await waitFor(async () => Math.abs((await scaleOf()) - fit0) < 0.005);
    check('double-click again goes back to fit', Math.abs((await scaleOf()) - fit0) < 0.005, await scaleOf());

    // ---- drag pans (at 100% the picture is bigger than the panel)
    await ui.keyboard.press('1');
    const t0 = [await attr('tx'), await attr('ty')];
    const c = await ui.locator('.civ-stage').boundingBox();
    await ui.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
    await ui.mouse.down();
    await ui.mouse.move(c.x + c.width / 2 + 40, c.y + c.height / 2 + 25, { steps: 5 });
    await ui.mouse.up();
    const t1 = [await attr('tx'), await attr('ty')];
    check('dragging pans the picture', t1[0] - t0[0] === 40 && t1[1] - t0[1] === 25, JSON.stringify({ t0, t1 }));
    check('a drag does not close the viewer', (await dlg.count()) === 1, 'closed');
    await ui.keyboard.press('ArrowLeft');
    const t2 = await attr('tx');
    check('arrow keys pan a zoomed picture (and do not step to another)', t2 !== t1[0] && /Picture 1/.test((await dlg.getAttribute('aria-label')) || ''), `${t1[0]} -> ${t2}`);
    if (process.env.LUMEN_ZOOM_SHOT) {
      await ui.keyboard.press('+');
      await ui.keyboard.press('+');
      await sleep(400);
      await ui.screenshot({ path: process.env.LUMEN_ZOOM_SHOT });
      console.log(`shot: ${process.env.LUMEN_ZOOM_SHOT}`);
    }

    // ---- two pictures: Left / Right step
    await ui.keyboard.press('0');
    await ui.keyboard.press('ArrowRight');
    await waitFor(async () => /Picture 2/.test((await dlg.getAttribute('aria-label')) || ''));
    check('Right steps to the next picture (2 / 2)', /Picture 2/.test((await dlg.getAttribute('aria-label')) || '') && (await ui.locator('.civ-count').innerText()) === '2 / 2', await dlg.getAttribute('aria-label'));
    await waitFor(async () => (await dlg.getAttribute('data-ready')) === '1');
    check('a small picture opens at its own size, not blown up', (await scaleOf()) === 1, await scaleOf());
    await ui.mouse.dblclick(cx, cy); // (at the panel's centre: Playwright would aim at the middle of the part of a 1600 px picture that is on screen)
    await waitFor(async () => (await scaleOf()) === 2);
    check('double-click on a small picture goes to 2x', (await scaleOf()) === 2, await scaleOf());
    await ui.keyboard.press('0');
    await ui.keyboard.press('ArrowLeft');
    await waitFor(async () => /Picture 1/.test((await dlg.getAttribute('aria-label')) || ''));
    check('Left steps back to the first', /Picture 1/.test((await dlg.getAttribute('aria-label')) || ''), await dlg.getAttribute('aria-label'));

    // ---- Open in a tab
    const tabsBefore = await app.evaluate(() => global.__chatPage.tabs().length);
    await ui.getByRole('button', { name: 'Open in a tab' }).click();
    const opened = await waitFor(async () => (await app.evaluate(() => global.__chatPage.tabs().map((t) => String(t.url)))).find((u) => /lumen-pictures\/picture-[0-9a-f]+\.png$/.test(u)), 10000);
    check('Open in a tab opens the picture in a new tab', Boolean(opened) && (await app.evaluate(() => global.__chatPage.tabs().length)) === tabsBefore + 1, JSON.stringify(await app.evaluate(() => global.__chatPage.tabs().map((t) => String(t.url).slice(0, 30)))));
    // (the new tab is in front: go back to the chat's tab, with the sidebar showing, to carry on)
    await ui.locator('.tab').first().click();
    if (!(await ui.locator('#messages').isVisible())) await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await waitFor(async () => (await ui.locator('.civ').count()) === 1 || (await ui.locator('#messages').isVisible()));

    // ---- Esc closes, focus goes back
    await ui.keyboard.press('Escape');
    check('Esc closes the viewer', (await ui.locator('.civ').count()) === 0, await ui.locator('.civ').count());
    check('focus returns to the picture that opened it', await ui.evaluate(() => document.activeElement === document.querySelector('#zoom-stub img')), await ui.evaluate(() => document.activeElement?.outerHTML?.slice(0, 80)));
    // the backdrop and the Close button
    await ui.locator('#zoom-stub img').first().focus();
    await ui.keyboard.press('Enter');
    await dlg.waitFor();
    const s2 = await ui.locator('.civ-stage').boundingBox();
    await ui.mouse.click(s2.x + 4, s2.y + 4);
    check('clicking the backdrop closes it', (await ui.locator('.civ').count()) === 0, await ui.locator('.civ').count());
    await ui.locator('#zoom-stub img').first().click();
    await dlg.waitFor();
    await ui.getByRole('button', { name: 'Close' }).click();
    check('the Close button closes it and focus returns to the picture', (await ui.locator('.civ').count()) === 0 && await ui.evaluate(() => document.activeElement === document.querySelector('#zoom-stub img')), 'open');

    // ---- reduced motion, dark theme, narrow width
    await ui.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await ui.locator('#zoom-stub img').first().click();
    await dlg.waitFor();
    const calm = await ui.evaluate(() => ({ anim: getComputedStyle(document.querySelector('.civ')).animationName, tr: getComputedStyle(document.querySelector('.civ-img')).transitionDuration }));
    check('reduced motion: no fade or zoom animation', calm.anim === 'none' && /^0s/.test(calm.tr), JSON.stringify(calm));
    const narrow = await ui.evaluate(() => { const b = document.querySelector('.civ-bar').getBoundingClientRect(); const d = document.querySelector('.civ').getBoundingClientRect(); return { fits: b.left >= d.left - 1 && b.right <= d.right + 1, scrollW: document.querySelector('.civ').scrollWidth <= document.querySelector('.civ').clientWidth + 1 }; });
    check('the toolbar wraps inside the panel at this width', narrow.fits && narrow.scrollW, JSON.stringify(narrow));
    await ui.keyboard.press('Escape');
    await ui.emulateMedia({ reducedMotion: null, colorScheme: null });

    // ---- the full-page chat (lumen://chat): same code, driven by script in that tab
    await ui.evaluate(() => document.getElementById('open-chat-page').click());
    const chatId = await waitFor(async () => (await app.evaluate(() => global.__chatPage.tabs().find((t) => t.chat && /chat-page\.html$/.test(t.url))?.id)));
    check('lumen://chat opens', Boolean(chatId), chatId);
    if (chatId) {
      const run = (code) => app.evaluate(async (_e, { id, c }) => { try { return await global.__chatPage.contents(id).executeJavaScript(c, true); } catch (err) { return `ERROR ${err?.message || err}`; } }, { id: chatId, c: code });
      await waitFor(async () => (await run("typeof window.genImages === 'object' && Boolean(document.getElementById('messages'))")) === true);
      await run(STUB);
      const p0 = await run("({ api: typeof window.chatImageViewer, script: [...document.scripts].some((s) => /chat-image-viewer/.test(s.src)) })");
      check('page: the viewer is not loaded before the first click', p0.api === 'undefined' && p0.script === false, JSON.stringify(p0));
      await run("document.querySelector('#zoom-stub img').click(), true");
      const opened2 = await waitFor(async () => (await run("document.querySelector('.civ[data-ready=\"1\"]') ? Number(document.querySelector('.civ').dataset.scale) : 0")) > 0);
      check('page: a click opens the viewer', Boolean(opened2), opened2);
      const p1 = await run(`(async () => {
        const d = document.querySelector('.civ'); const s = d.querySelector('.civ-stage'); const num = () => Number(d.dataset.scale);
        const fit = num(); s.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, clientX: 200, clientY: 200, bubbles: true, cancelable: true })); const up = num();
        d.querySelector('.civ-img').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 200, clientY: 200 }));
        const dbl = num();
        const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        key('0'); const before = d.getAttribute('aria-label'); key('ArrowRight'); await new Promise((r) => setTimeout(r, 200)); const stepped = d.getAttribute('aria-label');
        key('Escape');
        return { fit, up, dbl, before, stepped, closed: !document.querySelector('.civ'), focus: document.activeElement === document.querySelector('#zoom-stub img'), vw: window.innerWidth };
      })()`);
      check('page: the wheel zooms, double-click toggles, Right steps, Esc closes and focus returns', p1 && p1.up > p1.fit && p1.dbl !== p1.up && /Picture 1/.test(p1.before) && /Picture 2/.test(p1.stepped) && p1.closed && p1.focus, JSON.stringify(p1));
    }
    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (err) {
    failures++;
    console.log(`FAIL  test crashed -> ${err.stack || err}`);
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} FAILED` : '\nAll chat image zoom checks passed.');
  process.exit(failures ? 1 : 0);
})();
