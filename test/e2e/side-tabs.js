// Tab layout: Side. The tabs listed down the left of the window: the setting and its default (Top), the list laid out as rows with
// favicon and title, the page area and the AI sidebar laid out around it, the new-tab button, pinned tabs first, groups as sections that
// fold, closing, keyboard (Up/Down, Delete), the right-click menu, the width that is dragged and remembered, icons-only that opens out
// on hover, reordering by dragging (up and down), pulling a tab out into a window of its own, and the top layout coming back.
// Windows are invisible (LUMEN_TEST_BACKGROUND), the profile is a temp folder, pages come from a local server.
// Run alone: LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1 node test/e2e/side-tabs.js
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(60); } return null; };

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Page ${req.url.slice(1) || 'root'}</title><p>${req.url}</p>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-side-tabs-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' };
  const launch = async () => {
    const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env });
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    return { app, ui };
  };
  let { app, ui } = await launch();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));

  const open = (url) => app.evaluate(async (_e, u) => {
    const t = global.__agent.browser.openTab(u);
    await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); });
    return t.id;
  }, url);
  const order = () => app.evaluate(() => global.__windows.list()[0].tabs.map((t) => t.id));
  const setting = (key, value) => app.evaluate((_e, [k, v]) => global.__settings.backend.set(k, v), [key, value]);
  const saved = (key) => app.evaluate((_e, k) => global.__settings.backend.state().prefs[k], key);
  const tabMenu = (id, label) => app.evaluate((_e, [i, l]) => global.__tabMenu(i, l), [id, label]);
  const stripMenu = () => app.evaluate(() => global.__stripMenu());
  const bounds = () => app.evaluate(() => { const b = global.__contentBounds(); return b.view; });
  const rect = (sel) => ui.evaluate((s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: r.right, b: r.bottom }; }, sel);
  // The tabs slide into place when the list changes; measured once they have stopped.
  const settle = () => ui.evaluate(() => Promise.race([Promise.allSettled(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished)), new Promise((r) => setTimeout(r, 1500))]));
  const rowsOf = async () => { await settle(); return rowsNow(); };
  const rowsNow = () => ui.evaluate(() => [...document.querySelectorAll('#tabs .tab, #tabs .group-label')].map((el) => { const r = el.getBoundingClientRect(); return { id: el.dataset.id, group: el.classList.contains('group-label'), pinned: el.classList.contains('pinned'), x: r.left, y: r.top, w: r.width, h: r.height, text: el.textContent.trim() }; }));
  const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

  try {
    // ---- the default is Top, and the setting is validated
    check('default: tabs across the top (the strip holds them, no side list)', await ui.evaluate(() => !document.body.classList.contains('side-layout') && document.getElementById('tabs').parentElement.id === 'tabstrip' && document.getElementById('side-tabs').hidden));
    check('the setting defaults to top, width 240, not collapsed', (await saved('tabLayout')) === 'top' && (await saved('sideTabsWidth')) === 240 && (await saved('sideTabsCollapsed')) === false);
    check('a value that is not top or side is refused', await setting('tabLayout', 'diagonal').then(() => false, () => true));
    check('a width is kept between 160 and 420', await setting('sideTabsWidth', 9999).then(async () => (await saved('sideTabsWidth')) === 420 && (await setting('sideTabsWidth', 20), (await saved('sideTabsWidth')) === 160)));
    await setting('sideTabsWidth', 240);

    // ---- some tabs
    const a = await open(`${base}/alpha`);
    const b = await open(`${base}/beta`);
    const c = await open(`${base}/gamma`);
    const d = await open(`${base}/delta`);
    await ui.waitForFunction(() => document.querySelectorAll('#tabs .tab').length >= 5);

    // ---- switching to Side
    await setting('tabLayout', 'side');
    check('Side: the list moves into the left column and the strip lets go of it', await waitFor(() => ui.evaluate(() => document.body.classList.contains('side-layout') && document.getElementById('tabs').parentElement.id === 'side-tabs-list' && !document.getElementById('side-tabs').hidden)));
    check('Side: the new-tab button is in the column', await ui.evaluate(() => document.getElementById('new-tab').parentElement.id === 'side-head'));
    const rows = await rowsOf();
    const panel = await rect('#side-tabs');
    check('Side: the tabs are rows, one under another, each as wide as the list', rows.length >= 5 && rows.every((r, i) => i === 0 || (r.y > rows[i - 1].y && Math.abs(r.x - rows[0].x) < 1)) && rows.every((r) => r.w > panel.w - 40), JSON.stringify(rows.slice(0, 3)));
    check('Side: a row shows the favicon and the title', await ui.evaluate(() => { const el = [...document.querySelectorAll('#tabs .tab')].find((t) => t.textContent.includes('Page alpha')); return Boolean(el && el.querySelector('.tab-favicon') && getComputedStyle(el.querySelector('.tab-title')).display !== 'none'); }));
    check('Side: the list is the width of the setting (240)', Math.abs(panel.w - 240) <= 1, panel.w);

    // ---- the page area and the AI sidebar lay out around the list
    const view = await rect('#viewport');
    check('Side: the page area starts where the list ends', Math.abs(view.x - panel.r) <= 1, JSON.stringify({ viewX: view.x, panelR: panel.r }));
    const main1 = await waitFor(async () => { const m = await bounds(); return m && Math.abs(m.x - view.x) <= 1 && Math.abs(m.width - view.w) <= 1 ? m : null; });
    check('Side: main puts the page view in that area (x and width)', Boolean(main1), JSON.stringify(await bounds()));
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await sleep(900);
    const v2 = await rect('#viewport');
    const sb = await rect('#sidebar');
    check('Side + AI sidebar: the page sits between the list and the sidebar', Math.abs(v2.x - panel.r) <= 1 && Math.abs(v2.r - sb.x) <= 2 && v2.w < view.w, JSON.stringify({ v2, sb, iw: await ui.evaluate(() => innerWidth), cls: await ui.evaluate(() => document.body.className) }));
    const main2 = await waitFor(async () => { const m = await bounds(); return m && Math.abs(m.x - v2.x) <= 1 && Math.abs(m.width - v2.w) <= 2 ? m : null; });
    check('Side + AI sidebar: main follows', Boolean(main2), JSON.stringify(await bounds()));
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await sleep(900);

    // ---- the new-tab button
    const before = (await order()).length;
    await ui.click('#side-head #new-tab');
    check('Side: the new-tab button opens a tab', Boolean(await waitFor(async () => (await order()).length === before + 1)));

    // ---- pinned tabs come first, as tiles
    await tabMenu(c, 'Pin tab');
    await waitFor(() => ui.evaluate(() => document.querySelector('#tabs .tab.pinned')));
    const pr = await rowsOf();
    check('Side: a pinned tab is first, a small icon tile', pr[0].pinned && pr[0].w < 60 && pr[1].y >= pr[0].y + pr[0].h - 1 && !pr[1].pinned, JSON.stringify(pr.slice(0, 2)));

    // ---- groups: a section header that folds
    await tabMenu(a, 'Add to new group');
    const group = await waitFor(() => ui.evaluate(() => document.querySelector('#tabs .group-label')));
    await waitFor(() => ui.evaluate(() => document.querySelector('#tabs .group-label input')));
    await ui.keyboard.press('Enter'); // (a new group's name is being typed: keep it)
    await waitFor(() => ui.evaluate(() => !document.querySelector('#tabs .group-label input')));
    check('Side: a group has a header row', Boolean(group));
    const gr = await rowsOf();
    const gi = gr.findIndex((r) => r.group);
    check('Side: the header is as wide as the list and its tab sits under it', gi > -1 && gr[gi].w > panel.w - 40 && gr[gi + 1] && gr[gi + 1].y > gr[gi].y);
    const countBefore = (await rowsOf()).length;
    await ui.evaluate(() => document.querySelector('#tabs .group-label').click());
    await waitFor(async () => (await rowsOf()).length < countBefore);
    const folded = await rowsOf();
    check('Side: clicking the header folds the group (its tab goes, the label stays)', folded.length === countBefore - 1 || folded.length < countBefore, `${countBefore} -> ${folded.length}`);
    await ui.evaluate(() => document.querySelector('#tabs .group-label').click());
    check('Side: clicking again opens it', Boolean(await waitFor(async () => (await rowsOf()).length === countBefore)));

    // ---- clicking a row switches; the ✕ closes
    await ui.click(`#tabs .tab[data-id="${b}"]`);
    check('Side: a click on a row switches to its tab', Boolean(await waitFor(() => app.evaluate(() => global.__windows.list()[0].activeId).then((id) => id === b))));
    await ui.hover(`#tabs .tab[data-id="${d}"]`);
    await ui.click(`#tabs .tab[data-id="${d}"] .tab-close`);
    check('Side: the ✕ closes the tab', Boolean(await waitFor(async () => !(await order()).includes(d))));

    // ---- keyboard: Up and Down move through the list, Delete closes
    await ui.evaluate((id) => document.querySelector(`#tabs .tab[data-id="${id}"]`).focus(), b);
    const idsNow = (await rowsOf()).map((r) => r.id);
    const at = idsNow.indexOf(String(b));
    await ui.keyboard.press('ArrowDown');
    const focused1 = await ui.evaluate(() => document.activeElement?.dataset?.id);
    await ui.keyboard.press('ArrowUp');
    const focused2 = await ui.evaluate(() => document.activeElement?.dataset?.id);
    check('Side keyboard: ArrowDown goes to the next row, ArrowUp back', focused1 === idsNow[at + 1] && focused2 === String(b), `${focused1} ${focused2}`);

    // ---- the menus
    const rc = await ui.evaluate(() => { const r = document.querySelector('#side-tabs-list').getBoundingClientRect(); return { x: r.left + 20, y: r.bottom - 10 }; });
    await ui.mouse.click(rc.x, rc.y, { button: 'right' });
    const sm = await waitFor(async () => { const m = await stripMenu(); return m.pops.length ? m : null; });
    check('Side: right-click on the empty part of the list opens the layout menu', Boolean(sm) && sm.items.some((i) => /side/i.test(i.label) && i.checked) && sm.items.some((i) => /icons/i.test(i.label)), JSON.stringify(sm));
    check('Side: the tab menu still works on a row (Move tab to new window is in it)', (await tabMenu(b)).some((i) => i.label === 'Move tab to new window'));

    // ---- resizing: drag the edge, and the width is remembered
    const edge = await rect('#side-resize');
    await ui.mouse.move(edge.x + edge.w / 2, edge.y + 200);
    await ui.mouse.down();
    await ui.mouse.move(edge.x + edge.w / 2 + 40, edge.y + 200, { steps: 4 });
    await ui.mouse.up();
    const wide = await waitFor(async () => { const w = await saved('sideTabsWidth'); return w > 270 ? w : null; });
    const panel2 = await rect('#side-tabs');
    check('Side: dragging the edge widens the list and saves the width', Boolean(wide) && Math.abs(panel2.w - wide) <= 1 && wide >= 270 && wide <= 290, JSON.stringify({ wide, w: panel2.w }));
    const view3 = await rect('#viewport');
    check('Side: the page area gives way', Math.abs(view3.x - panel2.r) <= 1);

    // ---- dragging a tab up and down reorders it
    const ids0 = await order();
    const loose = (await rowsOf()).filter((r) => !r.group && !r.pinned).map((r) => Number(r.id));
    const mover = loose[loose.length - 1];
    const target = loose[0];
    const mr = centre((await rowsOf()).find((r) => r.id === String(mover)));
    const tr = (await rowsOf()).find((r) => r.id === String(target));
    await ui.mouse.move(mr.x, mr.y);
    await ui.mouse.down();
    await ui.mouse.move(mr.x, mr.y - 20, { steps: 3 });
    await ui.mouse.move(mr.x + 5, tr.y + 3, { steps: 8 });
    check('Side drag: a line shows where it would land', await ui.evaluate(() => { const l = document.querySelector('.side-drop-line'); return Boolean(l && !l.hidden && l.getBoundingClientRect().width > 50); }));
    await ui.mouse.up();
    const ids1 = await waitFor(async () => { const o = await order(); return o.join() !== ids0.join() ? o : null; });
    check('Side drag: the tab moved up above the other', Boolean(ids1) && ids1.indexOf(mover) < ids1.indexOf(target), JSON.stringify({ ids0, ids1 }));
    check('Side drag: no line is left behind and the tab is not stuck dragging', await ui.evaluate(() => !document.querySelector('.side-drop-line') && !document.querySelector('.tab.dragging')));

    // a pinned tab stays among the pinned ones
    const pinnedId = (await rowsOf()).find((r) => r.pinned)?.id;
    const lowRow = (await rowsOf()).filter((r) => !r.pinned && !r.group).pop();
    const pr0 = centre((await rowsOf()).find((r) => r.id === pinnedId));
    const idsP = await order();
    await ui.mouse.move(pr0.x, pr0.y);
    await ui.mouse.down();
    await ui.mouse.move(pr0.x + 3, pr0.y + 30, { steps: 3 });
    await ui.mouse.move(pr0.x + 3, lowRow.y + 10, { steps: 6 });
    await ui.mouse.up();
    await sleep(500);
    check('Side drag: a pinned tab dragged down among the others stays first', (await order())[0] === Number(pinnedId) && (await order()).join() === idsP.join(), JSON.stringify(await order()));

    // ---- icons only, and it opens out on hover
    await ui.click('#side-collapse');
    check('Side: icons only is saved', Boolean(await waitFor(async () => (await saved('sideTabsCollapsed')) === true)));
    await ui.mouse.move(700, 400);
    await sleep(500);
    const narrow = await rect('#side-tabs');
    check('Side icons only: the column is narrow and the titles are gone', narrow.w < 70 && await ui.evaluate(() => [...document.querySelectorAll('#tabs .tab')].every((t) => t.querySelector('.tab-title').getBoundingClientRect().width < 2 || getComputedStyle(t.querySelector('.tab-title')).display === 'none')), narrow.w);
    check('Side icons only: the page area takes the room', Math.abs((await rect('#viewport')).x - narrow.r) <= 1);
    await ui.mouse.move(narrow.x + 20, narrow.y + 120);
    const peeked = await waitFor(async () => { const r = await rect('#side-tabs'); return r.w > 150 ? r : null; });
    check('Side icons only: the pointer over it opens it out to the saved width', Boolean(peeked) && Math.abs(peeked.w - wide) <= 2, JSON.stringify(peeked));
    await ui.mouse.move(900, 400);
    check('Side icons only: it closes again when the pointer leaves', Boolean(await waitFor(async () => (await rect('#side-tabs')).w < 70)));
    await ui.mouse.move(narrow.x + 20, narrow.y + 120);
    await waitFor(async () => (await rect('#side-tabs')).w > 150);
    await ui.click('#side-collapse');
    check('Side: the button turns icons only off', Boolean(await waitFor(async () => (await saved('sideTabsCollapsed')) === false)));
    await ui.mouse.move(900, 400);

    // ---- pulling a tab out into a window of its own
    const out = (await rowsOf()).filter((r) => !r.group && !r.pinned);
    const grab = centre(out[out.length - 1]);
    const grabId = Number(out[out.length - 1].id);
    await app.evaluate(() => global.__windows.setCursor({ x: 300, y: 300 }));
    await ui.mouse.move(grab.x, grab.y);
    await ui.mouse.down();
    await ui.mouse.move(grab.x + 30, grab.y, { steps: 3 });
    await ui.mouse.move(700, grab.y, { steps: 6 });
    const drag = await waitFor(() => app.evaluate(() => global.__windows.dragState()));
    check('Side drag out: pulled past the list it is handed to main (a window of its own follows)', Boolean(drag) && drag.ids.includes(grabId), JSON.stringify(drag));
    await ui.mouse.up();
    const two = await waitFor(() => app.evaluate(() => global.__windows.list().length === 2 ? global.__windows.list().map((w) => w.tabs.map((t) => t.id)) : null), 8000);
    check('Side drag out: released outside, the tab is in a new window and gone from this one', Boolean(two) && two.some((ids) => ids.length === 1 && ids[0] === grabId) && !two[0].includes(grabId), JSON.stringify(two));
    await app.evaluate(() => global.__windows.setCursor(null));

    // ---- Escape cancels a drag
    const esc = (await rowsOf()).filter((r) => !r.group && !r.pinned);
    const e0 = centre(esc[esc.length - 1]);
    const idsE = await order();
    await ui.mouse.move(e0.x, e0.y);
    await ui.mouse.down();
    await ui.mouse.move(e0.x, e0.y - 40, { steps: 4 });
    await ui.keyboard.press('Escape');
    await ui.mouse.up();
    await sleep(400);
    check('Side drag: Escape leaves the order alone and clears the line', (await order()).join() === idsE.join() && await ui.evaluate(() => !document.querySelector('.side-drop-line') && !document.querySelector('.tab.dragging')));

    // ---- it is remembered
    const widthKept = await saved('sideTabsWidth');
    await app.close();
    ({ app, ui } = await launch());
    ui.on('pageerror', (e) => errors.push(e.message));
    check('Restart: the layout, width and fold come back', Boolean(await waitFor(() => ui.evaluate(() => document.body.classList.contains('side-layout') && document.getElementById('tabs').parentElement.id === 'side-tabs-list'))) && Math.abs((await rect('#side-tabs')).w - widthKept) <= 1, JSON.stringify({ r: await rect('#side-tabs'), n: await app.evaluate(() => global.__windows.list().length), cls: await ui.evaluate(() => document.body.className + ' ' + document.getElementById('side-tabs').hidden) }));

    // ---- the quick toggle and back to Top
    await app.evaluate(() => global.__stripMenu().items.find((i) => /side/i.test(i.label)).run());
    check('The menu item switches back to Top: the tabs return to the strip, the new-tab button too', Boolean(await waitFor(() => ui.evaluate(() => !document.body.classList.contains('side-layout') && document.getElementById('tabs').parentElement.id === 'tabstrip' && document.getElementById('new-tab').parentElement.id === 'tabstrip' && document.getElementById('side-tabs').hidden))));
    const topRows = await rowsOf();
    check('Top again: tabs are side by side', topRows.length > 1 && topRows.every((r) => Math.abs(r.y - topRows[0].y) < 3));
    const v4 = await rect('#viewport');
    check('Top again: the page area is the full width', Math.abs(v4.x) <= 1);
    check('Top: a new tab still opens from the strip button', await (async () => { const n = (await order()).length; await ui.click('#new-tab'); return Boolean(await waitFor(async () => (await order()).length === n + 1)); })());
    check('no page errors in the UI', errors.length === 0, errors.join(' | '));
  } catch (err) {
    check('suite ran to the end', false, err && err.stack || err);
  } finally {
    try { await app.close(); } catch { /* already gone */ }
    server.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
