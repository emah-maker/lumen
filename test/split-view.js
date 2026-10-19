// Split view: two tabs side by side in one window. Open from the tab menu (the tab beside the one in front) or by dropping a tab on the page's
// right edge; both pages are shown, each in its own rectangle with a gap for the divider; the divider (drawn by the UI) sets the ratio; the side
// last clicked is the tab in front; the pair shows as joined tabs; closing a tab, the split view, a narrow window, full screen, sleeping, moving
// to another window and the AI's tab tools all leave a sensible window. Windows are invisible (LUMEN_TEST_BACKGROUND); nothing moves the real mouse.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v || Date.now() > end) return v; await sleep(60); } };

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Page ${req.url}</title><body style="margin:0;height:3000px"><p>${req.url}</p></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-split-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  const open = (url, background = true) => app.evaluate(async (_e, { url, background }) => {
    const t = global.__agent.browser.openTab(url, { background });
    await new Promise((r) => { if (!t.webContents.isLoading()) r(); else t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); });
    return t.id;
  }, { url, background });
  const state = () => app.evaluate(() => global.__split.state());
  const list = () => app.evaluate(() => global.__agent.browser.listTabs());
  const switchTo = (id) => app.evaluate((_e, id) => global.__agent.browser.switchTab(id), id);
  const visibleIds = async () => (await state()).views.filter((v) => v.visible).map((v) => v.id).sort((a, b) => a - b);
  const view = async (id) => (await state()).views.find((v) => v.id === id);
  const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
  const settle = async (fn, ms = 3000) => waitFor(fn, ms);

  const a = await open(`${base}/a`);
  const b = await open(`${base}/b`);
  const c = await open(`${base}/c`);
  await open(`${base}/d`);
  await switchTo(a);
  await sleep(200);

  // ---- 1. no pair: one page, no divider, a menu entry to open one ----
  let s = await state();
  check('(setup) no split view at first; one page shown', !s.shown && (await visibleIds()).join() === String(a) && !s.pair, JSON.stringify(s));
  check('the tab menu offers "Open in split view"', (await app.evaluate((_e, id) => global.__split.menu(id), b)).some((i) => i.label === 'Open in split view'), 'menu');

  // ---- 2. open b beside a ----
  await app.evaluate((_e, [x, y]) => global.__split.open(x, y), [b, a]);
  s = await settle(async () => { const x = await state(); return x.shown ? x : null; });
  check('Open in split view shows both pages', Boolean(s) && (await visibleIds()).join() === [a, b].sort((x, y) => x - y).join(), JSON.stringify(s?.views));
  const va = await view(a), vb = await view(b), vc = await view(c);
  const area = s.content;
  check('the left page is the one that was in front, the right the one opened', va.bounds.x === area.x && vb.bounds.x > va.bounds.x, JSON.stringify({ va: va.bounds, vb: vb.bounds }));
  check('the pages and the gap fill the page area exactly', va.bounds.width + (vb.bounds.x - (va.bounds.x + va.bounds.width)) + vb.bounds.width === area.width && vb.bounds.x - (va.bounds.x + va.bounds.width) === 12, JSON.stringify({ va: va.bounds, vb: vb.bounds, area }));
  check('both pages are as tall as the page area; a third tab stays hidden', va.bounds.height === area.height && vb.bounds.height === area.height && vb.bounds.y === area.y && !vc.visible, JSON.stringify({ va: va.bounds, vb: vb.bounds, vc }));
  check('the tab opened is the one in front (the toolbar and the AI follow it)', s.activeId === b && (await list()).find((t) => t.active)?.id === b, `${s.activeId}`);
  check('the tabs are next to each other in the strip', Math.abs(s.order.indexOf(a) - s.order.indexOf(b)) === 1, JSON.stringify(s.order));
  check('the AI\'s tab list says which tab is beside which', (await list()).find((t) => t.id === a)?.splitWith === b && (await list()).find((t) => t.id === b)?.splitWith === a, JSON.stringify(await list()));

  // ---- 3. the strip shows them joined; the divider is drawn ----
  const stripMarks = () => ui.evaluate(() => ({ left: [...document.querySelectorAll('.tab.split-left')].map((e) => Number(e.dataset.id)), right: [...document.querySelectorAll('.tab.split-right')].map((e) => Number(e.dataset.id)) }));
  const marks = await settle(async () => { const m = await stripMarks(); return m.left.length === 1 && m.right.length === 1 ? m : null; });
  check('the strip marks the pair: the left tab and the right tab', Boolean(marks) && marks.left[0] === a && marks.right[0] === b, JSON.stringify(marks));
  const divider = () => ui.evaluate(() => { const e = document.getElementById('split-divider'); if (!e) return null; const r = e.getBoundingClientRect(); const v = document.getElementById('viewport').getBoundingClientRect(); return { hidden: e.hidden, x: r.left - v.left, w: r.width, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
  const dv = await settle(async () => { const x = await divider(); return x && !x.hidden ? x : null; });
  check('the divider is in the gap between the pages', Boolean(dv) && near(dv.x, va.bounds.width) && dv.w === 12, JSON.stringify(dv));

  // ---- 4. drag the divider ----
  await ui.mouse.move(dv.cx, dv.cy - 60);
  await ui.mouse.down();
  await ui.mouse.move(dv.cx + 60, dv.cy - 60, { steps: 6 });
  await ui.mouse.move(dv.cx + 120, dv.cy - 60, { steps: 6 });
  await ui.mouse.up();
  const dragged = await settle(async () => { const x = await view(a); return x && near(x.bounds.width, va.bounds.width + 120, 3) ? x : null; });
  check('dragging the divider right widens the left page by as much', Boolean(dragged), JSON.stringify(await view(a)));
  const vb2 = await view(b);
  check('...and narrows the right page; the gap stays', Boolean(dragged) && vb2.bounds.x === dragged.bounds.x + dragged.bounds.width + 12 && vb2.bounds.x + vb2.bounds.width === area.x + area.width, JSON.stringify({ a: dragged?.bounds, b: vb2.bounds }));
  const dv2 = await divider();
  check('the divider followed', near(dv2.x, dragged.bounds.width), JSON.stringify(dv2));
  await app.evaluate(() => global.__split.ratio(0.001));
  const va3 = await view(a);
  check('a drag past the edge stops at the smallest page width', va3.bounds.width >= 240 && va3.bounds.width < 260, JSON.stringify(va3.bounds));
  // keyboard: the divider is a separator that takes the arrow keys; Home goes back to an even split
  await ui.focus('#split-divider');
  await ui.keyboard.press('Home');
  const even = await settle(async () => { const x = await view(a); const y = await view(b); return x && y && near(x.bounds.width, y.bounds.width, 2) ? x : null; });
  check('Home on the divider gives an even split', Boolean(even), JSON.stringify([await view(a), await view(b)]));
  await ui.keyboard.press('ArrowRight');
  check('the arrow keys move the divider', Boolean(await settle(async () => { const x = await view(a); return x && x.bounds.width > even.bounds.width + 5 ? x : null; })), JSON.stringify(await view(a)));
  await app.evaluate(() => global.__split.ratio(0.5));

  // ---- 5. the side last clicked is the tab in front ----
  await app.evaluate((_e, id) => global.__split.click(id), a);
  s = await state();
  check('clicking the other page makes it the tab in front; both stay shown', s.activeId === a && s.shown && (await visibleIds()).length === 2, JSON.stringify({ active: s.activeId, shown: s.shown }));
  check('...the toolbar and the AI follow: the active tab is the one clicked', (await list()).find((t) => t.active)?.id === a, JSON.stringify(await list()));
  // a real click in the page (the same event path as the mouse)
  const clicked = await app.evaluate(async (_e, id) => {
    const tab = global.__pageTools.tab(id);
    const wc = tab.view.webContents;
    wc.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 300));
    return global.__split.state().activeId;
  }, b);
  check('a click in the page itself does the same', clicked === b, String(clicked));

  // ---- 5b. the AI sidebar open: both sides share it, and the pair fits what is left ----
  const wideNow = (await state()).content.width;
  await app.evaluate((_e, id) => global.__tabChats.setSidebar(id, true), b);
  const withSidebar = await settle(async () => { const x = await state(); return x.shown && x.content.width < wideNow - 100 ? x : null; });
  check('opening the sidebar on one side opens it for the other too', (await app.evaluate((_e, id) => global.__tabChats.sidebar(id), a)) === true, 'sidebar state');
  const sa = await view(a), sb = await view(b);
  check('with the sidebar open both pages still fill the narrower page area', Boolean(withSidebar) && sa.bounds.width + 12 + sb.bounds.width === withSidebar.content.width && sb.bounds.x + sb.bounds.width === withSidebar.content.x + withSidebar.content.width, JSON.stringify({ a: sa.bounds, b: sb.bounds, area: withSidebar?.content }));
  await app.evaluate((_e, id) => global.__split.click(id), a);
  check('clicking the other side does not move the divider or close the sidebar', near((await state()).content.width, withSidebar.content.width, 0) && (await app.evaluate((_e, id) => global.__tabChats.sidebar(id), b)) === true, JSON.stringify((await state()).content));
  await app.evaluate((_e, id) => global.__tabChats.setSidebar(id, false), a);
  await settle(async () => (await state()).content.width >= wideNow - 2);

  // ---- 6. the AI's own tab tools ----
  await switchTo(c);
  await sleep(150);
  s = await state();
  check('the AI switching to a tab outside the pair shows that tab alone', !s.shown && (await visibleIds()).join() === String(c), JSON.stringify(await visibleIds()));
  check('...the pair is kept (still joined in the strip)', (await stripMarks()).left.length === 1, JSON.stringify(await stripMarks()));
  await switchTo(a);
  s = await settle(async () => { const x = await state(); return x.shown ? x : null; });
  check('switching back to either tab shows the pair again', Boolean(s) && (await visibleIds()).length === 2, JSON.stringify(s));
  const opened = await open(`${base}/e`, true);
  s = await state();
  check('a tab the AI opens in the background changes nothing on show', s.shown && s.activeId === a && !(await view(opened)).visible, JSON.stringify(s));
  await app.evaluate((_e, id) => global.__agent.browser.closeTab?.(id), opened);

  // ---- 7. narrow window, full screen ----
  const resized = await app.evaluate(async ({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().includes('index.html')); const [ow, oh] = w.getSize(); global.__oldSize = [ow, oh]; w.setMinimumSize(300, 300); w.setSize(420, oh); await new Promise((r) => setTimeout(r, 500)); return w.getContentSize(); });
  s = await settle(async () => { const x = await state(); return !x.shown ? x : null; });
  check('a window too narrow for two pages shows the tab in front alone', Boolean(s) && (await visibleIds()).length === 1, `${JSON.stringify(resized)} ${JSON.stringify(s?.content)}`);
  await app.evaluate(async ({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().includes('index.html')); w.setSize(...global.__oldSize); });
  s = await settle(async () => { const x = await state(); return x.shown ? x : null; });
  check('...and both again when it is wide enough', Boolean(s) && (await visibleIds()).length === 2, JSON.stringify(s?.content));
  await app.evaluate((_e, id) => { const wc = global.__pageTools.tab(id).view.webContents; wc.emit('enter-html-full-screen'); }, b);
  s = await state();
  check('a page going full screen fills the window and comes to the front', !s.shown && s.activeId === b && (await visibleIds()).join() === String(b), JSON.stringify({ shown: s.shown, active: s.activeId }));
  await app.evaluate((_e, id) => { const wc = global.__pageTools.tab(id).view.webContents; wc.emit('leave-html-full-screen'); }, b);
  s = await state();
  check('...and the pair is back when it leaves full screen', s.shown && (await visibleIds()).length === 2, JSON.stringify({ shown: s.shown }));

  // ---- 8. sleep: the page beside the one in front is in use, and wakes with the pair ----
  const keep = await app.evaluate((_e, id) => global.__tabSleep.canSleep(id), a === s.activeId ? b : a);
  check('the page beside the tab in front is not put to sleep', keep === false, String(keep));
  const other = (await state()).activeId === a ? b : a;
  await app.evaluate((_e, id) => global.__tabSleep.sleep(id), other); // (forced: as a tab menu or a sweep that raced the pairing would)
  s = await state();
  check('a partner put to sleep leaves the front tab alone on show (the pair stays)', !s.shown && (await visibleIds()).length === 1, JSON.stringify(s.views.filter((v) => v.visible)));
  await switchTo(s.activeId);
  s = await settle(async () => { const x = await state(); return x.shown ? x : null; }, 6000);
  check('coming back to the front tab wakes its partner and shows both', Boolean(s) && (await visibleIds()).length === 2, JSON.stringify(s?.views));

  // ---- 9. the tab menu: Close split view, and dropping a tab on the right edge ----
  const front = (await state()).activeId;
  check('the tab menu of a paired tab offers "Close split view"', (await app.evaluate((_e, id) => global.__split.menu(id), front)).some((i) => i.label === 'Close split view'), 'menu');
  await app.evaluate((_e, id) => global.__split.clickMenu(id), front);
  s = await settle(async () => { const x = await state(); return !x.pair ? x : null; });
  check('Close split view keeps both tabs open and shows the one in front', Boolean(s) && (await visibleIds()).join() === String(front) && (await list()).some((t) => t.id === a) && (await list()).some((t) => t.id === b), JSON.stringify(s));
  const m2 = await settle(async () => { const m = await stripMarks(); return !m.left.length && !m.right.length ? m : null; });
  check('...the strip shows them as separate tabs again', Boolean(m2), JSON.stringify(await stripMarks()));
  const gone = await divider();
  check('...and the divider is gone', !gone || gone.hidden, JSON.stringify(gone));

  await switchTo(a);
  const wide = (await state()).content;
  const missed = await app.evaluate((_e, [id, x, y]) => global.__split.drop(id, x, y), [c, wide.x + 80, wide.y + 80]);
  check('a tab dropped away from the right edge does not open a split view', missed === false && !(await state()).pair, String(missed));
  const dropped = await app.evaluate((_e, [id, x, y]) => global.__split.drop(id, x, y), [c, wide.x + wide.width - 12, wide.y + 80]);
  s = await settle(async () => { const x = await state(); return x.shown ? x : null; });
  check('a tab dropped on the right edge of the page opens beside the tab in front', dropped === true && Boolean(s) && s.activeId === c && s.pair.left === a && s.pair.right === c, JSON.stringify({ dropped, pair: s?.pair, active: s?.activeId }));

  // ---- 10. closing a tab of the pair leaves the other one, full size ----
  await app.evaluate((_e, id) => global.__closeTabInteractive(id), c);
  s = await settle(async () => { const x = await state(); return !x.pair && !x.views.some((v) => v.id === c) ? x : null; });
  check('closing one tab of a pair leaves the other in front, alone, filling the page area', Boolean(s) && s.activeId === a && (await visibleIds()).join() === String(a), JSON.stringify(s));
  const full = await view(a);
  check('...at the full page area', Boolean(full) && full.bounds.width === s.content.width && full.bounds.x === s.content.x, JSON.stringify({ full: full?.bounds, area: s.content }));

  // ---- 11. a new tab beside the front tab, from the front tab's own menu ----
  await switchTo(a);
  const before = (await list()).length;
  await app.evaluate((_e, id) => global.__split.open(id), a);
  s = await settle(async () => { const x = await state(); return x.shown ? x : null; });
  check('Open in split view on the tab in front opens a new tab beside it', Boolean(s) && (await list()).length === before + 1 && s.pair.left === a && s.activeId === s.pair.right, JSON.stringify({ pair: s?.pair, n: (await list()).length, before }));
  const fresh = s.pair.right;

  // ---- 12. the close button on the divider ----
  const dv3 = await settle(async () => { const x = await divider(); return x && !x.hidden ? x : null; });
  check('(setup) the divider is up', Boolean(dv3), 'no divider');
  await ui.click('#split-divider .split-close');
  s = await settle(async () => { const x = await state(); return !x.pair ? x : null; });
  check('the close button on the divider closes the split view; both tabs stay', Boolean(s) && (await list()).some((t) => t.id === fresh) && (await visibleIds()).length === 1, JSON.stringify(s));

  // ---- 13. detach: a tab moved to another window leaves the pair ----
  await app.evaluate((_e, [x, y]) => global.__split.open(x, y), [b, a]);
  await settle(async () => (await state()).shown);
  const winId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().includes('index.html')).id);
  await app.evaluate((_e, [w, id]) => global.__windows.tearOff(w, id, { x: 200, y: 200 }), [winId, b]);
  const two = await waitFor(async () => { const l = await app.evaluate(() => global.__windows.list()); return l.length === 2 ? l : null; }, 8000);
  check('(setup) the tab moved to a window of its own', Boolean(two), 'one window');
  const m3 = await settle(async () => { const m = await ui.evaluate(() => document.querySelectorAll('.tab.split-left, .tab.split-right').length); return m === 0 ? true : null; });
  check('the window it left no longer shows a pair, and its other tab fills the page', Boolean(m3), 'marks remain');

  check('no renderer errors', errors.length === 0, errors.join('; '));
  server.close();
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
