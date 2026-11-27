// The bookmarks bar (renderer/bookmarks-bar.js, features/bookmark-bar-main.js): shown on the new-tab page only by default, over the
// top of the page area with only that page's view moved down for it (no other page resized); chips with accessible names, a
// folder chip that opens a menu (nested folders as submenus), » for the chips that don't fit; Ctrl+Shift+B and the setting (always:
// part of the toolbar, remembered); drag to reorder, into a folder, a link dropped from outside, a tab let go over it; the right-click
// menu's Open in new tab, Edit, Delete and New folder; the in-bar edit form; arrow keys between chips; and, shown always from the
// start, the page area's top never moves after the first report (no jump). Native menus are checked as templates (nothing pops up).
// Local server only, a throwaway profile, LUMEN_TEST_BACKGROUND keeps the windows off-screen.
'use strict';
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 800)}`}`); };
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(80); } return false; };
const J = JSON.stringify;
const BAR_H = require('../../src/features/bookmark-bar').BAR_HEIGHT;

const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<title>Page ${req.url}</title><a id="l" href="/linked">linked</a>`); }).listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const seed = () => [
  { url: `${base}/a`, title: 'Alpha' },
  { url: `${base}/b`, title: 'Bravo', folder: 'Work' },
  { url: `${base}/c`, title: 'Charlie', folder: 'Work/Deep' },
  ...Array.from({ length: 30 }, (_, i) => ({ url: `${base}/n${i}`, title: `Bookmark number ${i}` })),
];

async function launch(extra = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-bmbar-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ bookmarks: seed(), newTabPrivacy: false, sidebarNewChat: false, performanceMode: 'off', ...extra }));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' };
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  profileDir = profile;
  return { app, ui, profile };
}

const barState = (ui) => ui.evaluate(() => {
  const bar = document.getElementById('bookmarks-bar');
  const chips = [...bar.querySelectorAll('#bm-items .bm-chip')];
  return {
    hidden: bar.hidden, inViewport: bar.parentElement?.id === 'viewport', inHeader: bar.parentElement?.tagName === 'HEADER',
    role: bar.getAttribute('role'), label: bar.getAttribute('aria-label'),
    chips: chips.map((c) => ({ key: c.dataset.key, name: c.getAttribute('aria-label'), hidden: c.hidden, popup: c.getAttribute('aria-haspopup'), tab: c.tabIndex })),
    more: { hidden: document.getElementById('bm-overflow').hidden, label: document.getElementById('bm-overflow').getAttribute('aria-label') },
    rect: (() => { const r = bar.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })(),
    viewportTop: document.getElementById('viewport').getBoundingClientRect().top,
  };
});
const bounds = (app) => app.evaluate(() => global.__contentBounds());
let profileDir = '';
const saved = async () => { try { return JSON.parse(fs.readFileSync(path.join(profileDir, 'settings.json'), 'utf8')); } catch { return null; } };
const live = (app) => app.evaluate(() => global.__bookmarkBar.rt.state());

(async () => {
  let { app, ui } = await launch();
  try {
    // ---------- the new-tab page (default mode) ----------
    const nt = await waitFor(async () => { const s = await barState(ui); return !s.hidden && s.chips.length > 5 ? s : null; });
    check('shown on the new-tab page by default', nt && !nt.hidden, J(nt));
    check('...over the top of the page area (newtab mode)', nt?.inViewport && Math.abs(nt.rect.y - nt.viewportTop) < 1, J(nt?.rect));
    check('...is a toolbar with a name', nt?.role === 'toolbar' && nt.label === 'Bookmarks bar');
    check('...height is BAR_HEIGHT', Math.round(nt?.rect.h) === BAR_H, nt?.rect.h);
    check('chips in bar order: links, then folders', nt?.chips[0].key === `u:${base}/a` && nt.chips.some((c) => c.key === 'f:Work'), J(nt?.chips.slice(0, 3)));
    check('a chip is named by its title', nt?.chips[0].name === 'Alpha');
    check('a folder chip opens a menu and says it is a folder', (() => { const f = nt?.chips.find((c) => c.key === 'f:Work'); return f && f.popup === 'menu' && /Work/.test(f.name); })());
    check('one tab stop for the whole bar (roving tabindex)', nt?.chips.filter((c) => c.tab === 0).length === 1);
    check('» for the chips that do not fit', nt && !nt.more.hidden && nt.chips.some((c) => c.hidden) && /\d+/.test(nt.more.label), J(nt?.more));
    let b = await bounds(app);
    check('only the new-tab page view moves down for the bar', b.view && b.view.y === b.y + BAR_H && b.view.height === b.height - BAR_H, J(b));

    // folder menus (as templates: nothing pops up)
    const menus = await app.evaluate(({ BrowserWindow }) => {
      const rt = global.__bookmarkBar.rt;
      const e = { sender: BrowserWindow.getAllWindows()[0].webContents };
      const strip = (items) => items.map((i) => (i.type === 'separator' ? '-' : i.submenu ? { label: i.label, submenu: strip(i.submenu) } : i.label));
      const first = rt.state().items.findIndex((c) => c.type === 'folder');
      return { work: strip(rt.folderTemplate(e, 'Work')), overflow: strip(rt.overflowTemplate(e, first)).slice(0, 2), link: strip(rt.contextTemplate(e, { target: { type: 'link', url: rt.state().items[0].url } })), folder: strip(rt.contextTemplate(e, { target: { type: 'folder', path: 'Work' } })), bare: strip(rt.contextTemplate(e, {})) };
    });
    check('a folder opens as a menu, a folder inside it as a submenu', menus.work[0] === 'Bravo' && menus.work[1]?.label === 'Deep' && menus.work[1].submenu[0] === 'Charlie', J(menus.work));
    check('...with Open all for everything in it', menus.work.includes('Open all (2)'), J(menus.work));
    check('» lists the chips from the first one hidden', menus.overflow.length >= 1, J(menus.overflow));
    check('right-click on a link: Open in new tab, Edit, Delete, New folder', ['Open in new tab', 'Edit…', 'Delete', 'New folder…'].every((x) => menus.link.includes(x)), J(menus.link));
    check('right-click on a folder: Open all, Rename, Delete, New folder', ['Open all (2)', 'Rename…', 'Delete', 'New folder…'].every((x) => menus.folder.includes(x)), J(menus.folder));
    check('right-click on the bar: New folder and Show bookmarks bar', menus.bare.includes('New folder…') && menus.bare.includes('Show bookmarks bar'), J(menus.bare));

    // ---------- a web page: hidden, and the page is not resized ----------
    await ui.evaluate((u) => window.browser.go(u), `${base}/page`);
    const web = await waitFor(async () => { const s = await barState(ui); return s.hidden ? s : null; });
    check('hidden on a web page (newtab mode)', Boolean(web));
    b = await bounds(app);
    check('a web page fills the page area (not moved for the bar)', b.view && b.view.y === b.y && b.view.height === b.height, J(b));

    // ---------- Ctrl+Shift+B: always, remembered ----------
    const yBefore = b.y;
    await app.evaluate(() => global.__bookmarkBar.rt.toggle());
    const always = await waitFor(async () => { const s = await barState(ui); return !s.hidden && s.inHeader ? s : null; });
    check('Ctrl+Shift+B shows it always: in the toolbar on a web page', Boolean(always), J(await barState(ui)));
    b = await waitFor(async () => { const x = await bounds(app); return x.y === yBefore + BAR_H && x.view?.y === x.y ? x : null; });
    check('...the page area starts below it', Boolean(b), J(await bounds(app)));
    check('...remembered in settings', (await waitFor(async () => (await saved(app))?.bookmarksBar === 'always')) === true);
    const keyToggle = await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'B', modifiers: ['control', 'shift'] });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'B', modifiers: ['control', 'shift'] });
      return true;
    }).then(() => waitFor(async () => (await saved(app))?.bookmarksBar === 'newtab'));
    check('the Ctrl+Shift+B key itself switches it back to the new-tab page only', keyToggle === true);
    check('...and it leaves the web page', Boolean(await waitFor(async () => (await barState(ui)).hidden)));
    await app.evaluate(() => global.__patchSettings({}));

    // ---------- back on a new tab: drag and drop, edit ----------
    await ui.evaluate(() => window.browser.newTab());
    await waitFor(async () => !(await barState(ui)).hidden);
    await sleep(300);
    // a link dropped from outside, before the first chip
    const dropAt = (sel, frac, data) => ui.evaluate(([s, f, d]) => {
      const bar = document.getElementById('bookmarks-bar');
      const el = document.querySelector(s);
      const r = el.getBoundingClientRect();
      const x = r.left + r.width * f;
      const dt = new DataTransfer();
      for (const [k, v] of Object.entries(d)) dt.setData(k, v);
      const target = document.elementFromPoint(x, r.top + r.height / 2) || bar;
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: r.top + 5, dataTransfer: dt }));
      const caretShown = !document.getElementById('bm-caret').hidden || Boolean(document.querySelector('.bm-chip.drop-into'));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: r.top + 5, dataTransfer: dt }));
      return caretShown;
    }, [sel, frac, data]);
    const caret = await dropAt('#bm-items .bm-chip', 0.1, { 'text/uri-list': `${base}/dropped`, 'text/html': `<a href="${base}/dropped">Dropped link</a>` });
    check('dragging over the bar shows where it lands', caret === true);
    let st = await waitFor(async () => { const s = await live(app); return s.items[0]?.url === `${base}/dropped` ? s : null; });
    check('a link dropped on the bar is bookmarked where it was dropped, with its text as the title', st && st.items[0].title === 'Dropped link', J((await live(app)).items.slice(0, 2)));
    // reorder: the folder dragged to the front
    await ui.evaluate(() => { const c = document.querySelector('.bm-chip[data-key="f:Work"]'); c.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() })); });
    await dropAt('#bm-items .bm-chip', 0.05, { 'application/x-lumen-bookmark': 'f:Work' });
    st = await waitFor(async () => { const s = await live(app); return s.items[0]?.path === 'Work' ? s : null; });
    check('drag to reorder: a folder to the front', Boolean(st), J((await live(app)).items.slice(0, 3).map((c) => c.title || c.name)));
    check('...the order is saved', Boolean(await waitFor(async () => (await saved(app))?.bookmarkLayout?.order?.['']?.[0] === 'f:Work')), J((await saved(app))?.bookmarkLayout));

    // a chip dragged onto a folder chip's middle goes into it (the folder is at the front now, so on show)
    await waitFor(() => ui.evaluate(() => { const c = document.querySelector('.bm-chip[data-key="f:Work"]'); return c && !c.hidden && c.getBoundingClientRect().width > 0; }));
    const chipKey = `u:${base}/a`;
    await ui.evaluate((k) => { const c = document.querySelector(`.bm-chip[data-key="${CSS.escape(k)}"]`); c.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() })); }, chipKey);
    await dropAt('.bm-chip[data-key="f:Work"]', 0.5, { 'application/x-lumen-bookmark': chipKey });
    st = await waitFor(async () => { const s = await live(app); const w = s.items.find((c) => c.path === 'Work'); return w?.children.some((c) => c.url === `${base}/a`) ? s : null; });
    check('a chip dropped on a folder goes into it', Boolean(st), J((await live(app)).items.slice(0, 4)));
    // a tab let go over the bar (main.js: the tab drag hands it to the bar instead of tearing it off)
    const r = (await barState(ui)).rect;
    const under = await app.evaluate(({ BrowserWindow }, rr) => { const cb = BrowserWindow.getAllWindows()[0].getContentBounds(); return [global.__bookmarkBar.under({ x: cb.x + rr.x + 40, y: cb.y + rr.y + 10 }), global.__bookmarkBar.under({ x: cb.x + rr.x + 40, y: cb.y + rr.y + 200 })]; }, r);
    check('a tab released over the bar is caught there, not lower down', Boolean(under[0]) && !under[1], J(under));
    await app.evaluate(({ BrowserWindow }, x) => BrowserWindow.getAllWindows()[0].webContents.send('bookmarks-bar:tab-drop', { url: 'http://tab.test/', title: 'A tab', x }), r.x + r.w - 40);
    st = await waitFor(async () => { const s = await live(app); return s.items.some((c) => c.url === 'http://tab.test/' && c.title === 'A tab') ? s : null; });
    check('a dropped tab is bookmarked on the bar', Boolean(st));

    // ---------- right-click actions ----------
    const clickItem = (opts, labelText) => app.evaluate(({ BrowserWindow }, [o, l]) => {
      const rt = global.__bookmarkBar.rt;
      const e = { sender: BrowserWindow.getAllWindows()[0].webContents };
      const item = rt.contextTemplate(e, o).find((i) => i.label === l);
      if (!item) return false;
      item.click();
      return true;
    }, [opts, labelText]);
    const tabsBefore = await ui.evaluate(() => document.querySelectorAll('.tab').length);
    await clickItem({ target: { type: 'link', url: `${base}/b` } }, 'Open in new tab');
    check('Open in new tab opens one', Boolean(await waitFor(async () => (await ui.evaluate(() => document.querySelectorAll('.tab').length)) === tabsBefore + 1)));
    // Open in new tab put it in front (as Chrome does) only if asked: go back to a new tab for the bar
    await ui.evaluate(() => window.browser.newTab());
    await waitFor(async () => !(await barState(ui)).hidden);
    await clickItem({ target: { type: 'link', url: `${base}/dropped` } }, 'Edit…');
    const formUp = await waitFor(() => ui.evaluate(() => { const f = document.getElementById('bm-edit'); return !f.hidden && document.activeElement === f.elements.title ? f.getAttribute('aria-label') : null; }));
    check('Edit opens a form in the bar, focused on the name', formUp === 'Edit bookmark', formUp);
    await ui.evaluate(() => { const f = document.getElementById('bm-edit'); f.elements.url.value = 'not a url ::'; f.requestSubmit(); });
    check('a bad address is refused with a message', Boolean(await waitFor(() => ui.evaluate(() => /web address/.test(document.querySelector('#bm-edit .bm-error')?.textContent || '')))));
    await ui.evaluate((u) => { const f = document.getElementById('bm-edit'); f.elements.title.value = 'Renamed link'; f.elements.url.value = u; f.elements.folder.value = 'Work/Deep'; f.requestSubmit(); }, `${base}/edited`);
    st = await waitFor(async () => { const s = await live(app); const deep = s.items.find((c) => c.path === 'Work')?.children.find((c) => c.path === 'Work/Deep'); return deep?.children.some((c) => c.url === `${base}/edited` && c.title === 'Renamed link') ? s : null; });
    check('Edit saves the name, address and folder (a nested one)', Boolean(st), J((await live(app)).items[0]));
    check('...and the form closes, focus back on the bar', Boolean(await waitFor(() => ui.evaluate(() => document.getElementById('bm-edit').hidden && document.getElementById('bookmarks-bar').contains(document.activeElement)))));
    await clickItem({ target: { type: 'link', url: `${base}/n0` }, index: 3 }, 'New folder…');
    await waitFor(() => ui.evaluate(() => !document.getElementById('bm-edit').hidden));
    await ui.evaluate(() => { const f = document.getElementById('bm-edit'); f.elements.name.value = 'Reading'; f.requestSubmit(); });
    st = await waitFor(async () => { const s = await live(app); return s.items[3]?.path === 'Reading' ? s : null; });
    check('New folder makes an empty folder where it was asked for', Boolean(st), J((await live(app)).items.slice(0, 5).map((c) => c.name || c.title)));
    await clickItem({ target: { type: 'folder', path: 'Reading' } }, 'Rename…');
    await waitFor(() => ui.evaluate(() => !document.getElementById('bm-edit').hidden));
    await ui.evaluate(() => { const f = document.getElementById('bm-edit'); f.elements.name.value = 'Later'; f.requestSubmit(); });
    st = await waitFor(async () => { const s = await live(app); return s.items[3]?.path === 'Later' ? s : null; });
    check('Rename keeps its place', Boolean(st));
    await clickItem({ target: { type: 'folder', path: 'Later' } }, 'Delete'); // (empty: no question)
    st = await waitFor(async () => { const s = await live(app); return !s.items.some((c) => c.path === 'Later') ? s : null; });
    check('Delete an empty folder', Boolean(st));
    await clickItem({ target: { type: 'link', url: 'http://tab.test/' } }, 'Delete');
    st = await waitFor(async () => { const s = await live(app); return !s.items.some((c) => c.url === 'http://tab.test/') ? s : null; });
    check('Delete a bookmark', Boolean(st));
    check('the star follows: the Bookmarks page list has the edit too', (await app.evaluate(() => global.__managers?.managers.list().some((x) => x.folder === 'Work/Deep' && x.title === 'Renamed link'))) !== false);

    // ---------- keyboard ----------
    const keys = await ui.evaluate(async () => {
      const chips = () => [...document.querySelectorAll('#bm-items .bm-chip:not([hidden])')];
      chips()[0].focus();
      const press = (key) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      press('ArrowRight');
      const second = document.activeElement === chips()[1];
      press('End');
      const last = document.activeElement.id === 'bm-overflow' || document.activeElement === chips().at(-1);
      press('Home');
      const first = document.activeElement === chips()[0];
      const stops = [...document.querySelectorAll('#bookmarks-bar [tabindex="0"]')].length;
      return { second, last, first, stops };
    });
    check('arrow keys, Home and End move between chips; one tab stop', keys.second && keys.last && keys.first && keys.stops === 1, J(keys));

    // ---------- theme ----------
    const look = await ui.evaluate(() => {
      const c = document.querySelector('#bm-items .bm-chip');
      const cs = getComputedStyle(c);
      const root = getComputedStyle(document.documentElement);
      const probe = document.createElement('div'); probe.style.color = root.getPropertyValue('--text'); document.body.append(probe);
      const text = getComputedStyle(probe).color; probe.remove();
      return { color: cs.color, text, bar: getComputedStyle(document.getElementById('bookmarks-bar')).backgroundColor, bg: getComputedStyle(document.body).backgroundColor };
    });
    check('chips use the theme text colour, the bar the window background', look.color === look.text && look.bar === look.bg, J(look));
  } catch (e) {
    check('no exception', false, e.stack);
  } finally {
    await app.close().catch(() => {});
  }

  // ---------- shown always from the start: no jump ----------
  ({ app, ui } = await launch({ bookmarksBar: 'always' }));
  try {
    const s = await waitFor(async () => { const x = await barState(ui); return !x.hidden && x.chips.length ? x : null; });
    check('always: in the toolbar from the start', s && s.inHeader, J(s));
    await sleep(800);
    const log = await app.evaluate(() => global.__bookmarkBar.boundsLog.slice());
    const b = await bounds(app);
    check('always: the page area top never moved after the first report (no jump)', log.length > 0 && log.every((y) => y === log[0]) && b.y === log[0], J({ log, y: b.y }));
    check('always: the page area starts under the bar', Math.abs(b.y - (s.rect.y + s.rect.h)) < 1.5, J({ y: b.y, bar: s.rect }));
  } catch (e) {
    check('no exception (always)', false, e.stack);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
