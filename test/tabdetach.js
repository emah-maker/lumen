// Tab tear-off between windows (Chrome's behaviour, Safari's look): dragging a tab out of the strip shows a
// card that follows the cursor while the tab stays put; released over a strip (another window's or its own)
// it moves there, released elsewhere it becomes a new window (same WebContents) at the release point; a
// window's only tab drags the window itself; Escape changes nothing; private windows are never involved;
// a lost mouse-up times out. Every normal window comes back after a restart.
// The renderer's drag messages (tab:dragstart / dragend / dragcancel) are sent straight to main.js and the
// cursor is scripted (__windows.setCursor), so nothing moves the real mouse. Windows are invisible
// (LUMEN_TEST_BACKGROUND) apart from the private one.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn().catch(() => null);
      if (v || Date.now() > end) return v;
      await sleep(100);
    }
  };

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    const name = req.url.slice(1) || 'root';
    res.end(`<!doctype html><title>Page ${name}</title><body style="height:3000px"><input id="f" value=""><script>window.marker = 'm-${name}';</script></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-tabdetach-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' };
  const launch = async () => {
    const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    return { app, ui };
  };
  let { app, ui } = await launch();
  const windows = () => app.evaluate(() => global.__windows.list());
  const openTab = (url) => app.evaluate(async (_e, u) => {
    const t = global.__agent.browser.openTab(u);
    await new Promise((r) => (t.webContents.isLoading() ? t.webContents.once('did-finish-load', r) : r()));
    return { id: t.id, contentsId: t.webContents.id };
  }, url);
  // The same, in a given window (new tabs open in the *current* window, and a late focus event can change that mid-test).
  const openTabIn = (windowId, url) => app.evaluate(async ({ webContents }, [w, u]) => {
    const t = global.__windows.open(w, u);
    const wc = webContents.fromId(t.contentsId);
    await new Promise((r) => (wc.isLoading() ? wc.once('did-finish-load', r) : r()));
    return t;
  }, [windowId, url]);
  // What the renderer sends during a drag (tab:dragstart / tab:dragend / tab:dragcancel), from that window's UI.
  const emit = (windowId, channel, ...args) => app.evaluate(({ ipcMain, BrowserWindow }, [id, ch, a]) => {
    const wc = BrowserWindow.fromId(id).webContents;
    ipcMain.emit(ch, { sender: wc, senderFrame: wc.mainFrame }, ...a);
  }, [windowId, channel, args]);
  // The scripted cursor main.js follows (instead of the real one).
  const cursor = (point) => app.evaluate((_e, p) => global.__windows.setCursor(p), point);
  const dragState = () => app.evaluate(() => global.__windows.dragState());
  const winBounds = (id) => app.evaluate(({ BrowserWindow }, w) => BrowserWindow.fromId(w).getBounds(), id);
  const boundsAt = (id, x, y) => waitFor(async () => { const b = await winBounds(id); return Math.abs(b.x - x) <= 2 && Math.abs(b.y - y) <= 2 ? b : null; }, 3000);
  const inTab = (contentsId, js) => app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code), [contentsId, js]);
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));

  try {
    const [first] = await windows();
    const win1 = first.windowId;
    const initialId = first.tabs[0].id;
    const a = await openTab(`${base}/a`);
    const b = await openTab(`${base}/b`);
    // State that a reload would lose.
    await inTab(a.contentsId, "document.getElementById('f').value = 'typed text'; window.scrollTo(0, 400); window.marker = 'kept'; 0");
    await sleep(200);
    const keptState = (contentsId) => inTab(contentsId, "({ marker: window.marker, typed: document.getElementById('f').value, y: Math.round(window.scrollY), title: document.title })");
    const stateOk = (s) => s.marker === 'kept' && s.typed === 'typed text' && s.y === 400 && s.title === 'Page a';
    const winOf = (l, id) => l.find((w) => w.windowId === id);
    const others = (l) => l.filter((w) => w.windowId !== win1);

    // ---- the tab menu: a second entry for a window's tabs only when there is somewhere to go
    const menu1 = await app.evaluate((_e, [w, id]) => global.__windows.tabMenu(w, id), [win1, a.id]);
    check('the tab menu offers Move Tab to New Window', menu1.some((i) => i.label === 'Move Tab to New Window' && i.enabled), JSON.stringify(menu1.map((i) => i.label)));
    check('...and no "to Window" entry while there is one window', !menu1.some((i) => i.label === 'Move Tab to Window'), JSON.stringify(menu1.map((i) => i.label)));

    // ---- the menu's tear-off: a pinned tab stays pinned, the same WebContents, no reload
    await app.evaluate((_e, id) => global.__pinTab(id, true), a.id);
    await app.evaluate((_e, [w, id]) => global.__windows.tearOff(w, id, { x: 300, y: 300 }), [win1, a.id]);
    const two = await waitFor(async () => { const l = await windows(); return l.length === 2 && others(l)[0]?.tabs.length === 1 ? l : null; });
    check('Move Tab to New Window makes a second window', Boolean(two), JSON.stringify(await windows()));
    const menuW2 = others(two)[0];
    const menuMoved = menuW2?.tabs[0];
    check('the new window holds the same WebContents and URL, still pinned, ungrouped', menuMoved?.contentsId === a.contentsId && menuMoved.url === `${base}/a` && menuMoved.pinned && !menuMoved.groupId, JSON.stringify(menuMoved));
    check('the source keeps its other tabs', winOf(two, win1).tabs.some((t) => t.id === b.id) && !winOf(two, win1).tabs.some((t) => t.id === a.id), JSON.stringify(two));
    check('the page was not reloaded: script state, typed text, scroll and title survive', stateOk(await keptState(a.contentsId)), JSON.stringify(await keptState(a.contentsId)));
    const menu2 = await app.evaluate((_e, [w, id]) => global.__windows.tabMenu(w, id), [win1, b.id]);
    const sub = menu2.find((i) => i.label === 'Move Tab to Window');
    check('with two windows the menu lists the other one under Move Tab to Window', sub && sub.sub.length === 1 && /Page a/.test(sub.sub[0]), JSON.stringify(sub));
    await app.evaluate((_e, [from, id, to]) => global.__windows.moveTo(from, id, to), [menuW2.windowId, a.id, win1]);
    const one = await waitFor(async () => { const l = await windows(); return l.length === 1 && l[0].tabs.some((t) => t.id === a.id) ? l : null; });
    check('Move Tab to Window merges it back and closes the emptied window', Boolean(one), JSON.stringify(await windows()));

    // ---- drag out of the strip: a card follows the cursor; the tab stays in its window until the release
    const win1Tabs = () => windows().then((l) => winOf(l, win1).tabs.map((t) => t.id));
    const uiCount = (windowId, selector) => app.evaluate(({ BrowserWindow }, [id, sel]) => BrowserWindow.fromId(id).webContents.executeJavaScript(`document.querySelectorAll(${JSON.stringify(sel)}).length`), [windowId, selector]);
    // The open drop slot in a window's strip: the id of the tab right after it ('end' if none), or null.
    const slotBefore = (windowId) => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.executeJavaScript(`(() => {
      const s = document.querySelector('#tabs .tab-drop-slot.open');
      if (!s) return null;
      let n = s.nextElementSibling;
      while (n && !n.classList.contains('tab')) n = n.nextElementSibling;
      return n ? Number(n.dataset.id) : 'end';
    })()`), windowId);
    const hold = await app.evaluate(() => global.__windows.cardHold());
    const cardAt = (p) => waitFor(async () => { const s = await dragState(); return s?.cardAt && s.cardAt.x === p.x - hold.x && s.cardAt.y === p.y - hold.y ? s : null; }, 3000);
    await emit(win1, 'tab:switch', initialId); // make win1 current
    await app.evaluate((_e, id) => global.__pinTab(id, true), a.id); // ...pinned, to see it stay pinned
    await cursor({ x: 900, y: 500 });
    await emit(win1, 'tab:dragstart', a.id, { x: 300, y: 15, stripX: 150 });
    const dragging = await dragState();
    check('past the threshold a card drag starts in the window the tab is in', dragging?.card === true && dragging.windowId === win1 && dragging.single === false, JSON.stringify(dragging));
    check('...and the tab stays where it is meanwhile: no window follows the mouse', (await windows()).length === 1 && (await win1Tabs()).includes(a.id), JSON.stringify(await windows()));
    for (const p of [{ x: 1000, y: 560 }, { x: 1100, y: 600 }, { x: 800, y: 420 }]) {
      await cursor(p);
      check(`the card follows the cursor to ${p.x},${p.y}, held by the tab's icon`, Boolean(await cardAt(p)), JSON.stringify(await dragState()));
    }
    await cursor({ x: 1100, y: 600 });
    await cardAt({ x: 1100, y: 600 });
    const srcSize = await winBounds(win1);
    await emit(win1, 'tab:dragend');
    const dropped = await waitFor(async () => { const l = await windows(); return l.length === 2 && others(l)[0]?.tabs.length === 1 ? l : null; });
    check('released over no strip: the tab becomes a window of its own', Boolean(dropped) && (await dragState()) === null, JSON.stringify(await windows()));
    const w2id = dropped && others(dropped)[0].windowId;
    const w2 = dropped && winOf(dropped, w2id);
    check('it holds the same WebContents, still pinned, ungrouped; the source keeps its other tabs', w2?.tabs[0].contentsId === a.contentsId && w2.tabs[0].pinned && !w2.tabs[0].groupId && winOf(dropped, win1).tabs.some((t) => t.id === b.id), JSON.stringify(dropped));
    check('the page was not reloaded', stateOk(await keptState(a.contentsId)), JSON.stringify(await keptState(a.contentsId)));
    check('the new window opens with the tab under the release point (grab offset kept)', Boolean(await boundsAt(w2id, 1100 - 150, 600 - 15)), JSON.stringify(await winBounds(w2id)));
    const w2Size = await winBounds(w2id); // (a pixel of slack: Windows rounds a window's size on a display with fractional scaling)
    check('...at the size of the window it came from', Math.abs(w2Size.width - srcSize.width) <= 2 && Math.abs(w2Size.height - srcSize.height) <= 2, JSON.stringify([w2Size, srcSize]));
    await cursor({ x: 200, y: 200 });
    await sleep(150);
    check('and nothing follows the cursor after the release', Boolean(await boundsAt(w2id, 950, 585)), JSON.stringify(await winBounds(w2id)));

    // ---- hover another window's strip: an insertion point, and release joins it there
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).setBounds({ x: 100, y: 100, width: 1000, height: 700 }), win1);
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).setBounds({ x: 1150, y: 150, width: 800, height: 600 }), w2id);
    await emit(win1, 'tab:switch', initialId);
    await app.evaluate((_e, id) => global.__pinTab(id, false), b.id);
    await app.evaluate((_e, [w, id]) => global.__windows.pin(w, id, false), [w2id, a.id]); // it stayed pinned; a loose strip to drop into
    await cursor({ x: 900, y: 500 });
    await emit(win1, 'tab:dragstart', b.id, { x: 300, y: 15, stripX: 150 });
    check('a second tab starts a card drag the same way', (await dragState())?.card === true, JSON.stringify(await dragState()));
    await cursor({ x: 1150 + 3, y: 150 + 15 });
    const hoverStart = await waitFor(async () => { const s = await dragState(); return s?.hover?.windowId === w2id ? s : null; });
    check('over the start of another strip: the insertion point is before its first tab', hoverStart?.hover.beforeId === a.id, JSON.stringify(hoverStart));
    check('that strip opens a slot before its first tab', Boolean(await waitFor(async () => (await slotBefore(w2id)) === a.id)), await slotBefore(w2id));
    await cursor({ x: 1150 + 780, y: 150 + 15 });
    const hoverEnd = await waitFor(async () => { const s = await dragState(); return s?.hover?.windowId === w2id && s.hover.beforeId === null ? s : null; });
    check('past its last tab: the insertion point is the end', Boolean(hoverEnd), JSON.stringify(await dragState()));
    check('...and the slot moves to the end (one open slot only)', Boolean(await waitFor(async () => (await slotBefore(w2id)) === 'end' && (await uiCount(w2id, '.tab-drop-slot.open')) === 1)), await slotBefore(w2id));
    await cursor({ x: 1150 + 300, y: 150 + 400 });
    const hoverNone = await waitFor(async () => { const s = await dragState(); return s && !s.hover ? s : null; });
    check("over that window's page area (not the strip) there is no insertion point", Boolean(hoverNone) && Boolean(await waitFor(async () => (await uiCount(w2id, '.tab-drop-slot')) === 0)), JSON.stringify(await dragState()));
    await cursor({ x: 1150 + 3, y: 150 + 15 });
    await waitFor(async () => (await dragState())?.hover?.windowId === w2id);
    await emit(win1, 'tab:dragend');
    const joined = await waitFor(async () => { const l = await windows(); const w = winOf(l, w2id); return l.length === 2 && w?.tabs.length === 2 ? l : null; });
    check('released over the strip: the tab joins that window, no new window', Boolean(joined) && (await dragState()) === null, JSON.stringify(await windows()));
    check('it lands at the index under the cursor (the start) and is the active tab', winOf(joined, w2id)?.tabs[0].id === b.id && winOf(joined, w2id).activeId === b.id && winOf(joined, w2id).tabs[0].contentsId === b.contentsId, JSON.stringify(joined));
    check('the tab takes the slot: none is left behind', Boolean(await waitFor(async () => (await uiCount(w2id, '.tab-drop-slot')) === 0)));

    // ---- over its own strip: the tab moves along it
    await emit(win1, 'tab:switch', initialId);
    const c = await openTabIn(win1, `${base}/c`);
    await waitFor(async () => (await win1Tabs()).includes(c.id)); // (the new tab shows in its window's list a moment after it loads)
    const beforeOwn = await win1Tabs();
    check('(a second tab in the source window to reorder)', beforeOwn.length === 2 && beforeOwn[1] === c.id, JSON.stringify(beforeOwn));
    await cursor({ x: 900, y: 500 });
    await emit(win1, 'tab:dragstart', c.id, { x: 300, y: 15, stripX: 150 });
    await cursor({ x: 100 + 3, y: 100 + 15 });
    const ownHover = await waitFor(async () => { const s = await dragState(); return s?.hover?.windowId === win1 ? s : null; });
    check('its own strip is a drop target too, before its first tab', ownHover?.hover.beforeId === initialId, JSON.stringify(ownHover));
    await emit(win1, 'tab:dragend');
    check('released there: the tab moves to that place, in the same window', Boolean(await waitFor(async () => JSON.stringify(await win1Tabs()) === JSON.stringify([c.id, initialId]))) && (await windows()).length === 2, JSON.stringify(await windows()));

    // ---- dragging the only tab of a window: the whole window follows, no new window
    await app.evaluate((_e, [from, id, to]) => global.__windows.moveTo(from, id, to), [w2id, a.id, win1]);
    await waitFor(async () => winOf(await windows(), w2id)?.tabs.length === 1);
    const onlyId = w2id;
    await cursor({ x: 700, y: 300 });
    await emit(onlyId, 'tab:dragstart', b.id, { x: 200, y: 15, stripX: 0 });
    const single = await waitFor(async () => { const s = await dragState(); return s?.single ? s : null; });
    check("a window's only tab drags the window itself", Boolean(single) && single.windowId === onlyId && !single.card && (await windows()).length === 2, JSON.stringify(single));
    check('the window is under the cursor with the grab offset', Boolean(await boundsAt(onlyId, 700 - 200, 300 - 15)), JSON.stringify(await winBounds(onlyId)));
    await cursor({ x: 800, y: 350 });
    check('and follows it', Boolean(await boundsAt(onlyId, 600, 335)), JSON.stringify(await winBounds(onlyId)));
    await cursor({ x: 100 + 900, y: 100 + 15 });
    const singleHover = await waitFor(async () => { const s = await dragState(); return s?.hover?.windowId === win1 && s.hover.beforeId === null ? s : null; });
    check('it can hover another strip too', Boolean(singleHover), JSON.stringify(await dragState()));
    await emit(onlyId, 'tab:dragend');
    const merged1 = await waitFor(async () => { const l = await windows(); return l.length === 1 && l[0].tabs.some((t) => t.id === b.id) ? l : null; });
    check('released over a strip: the tab joins it at the end and the window closes', Boolean(merged1) && merged1[0].tabs.at(-1).id === b.id, JSON.stringify(await windows()));
    check('with its page intact', merged1?.[0].tabs.at(-1).contentsId === b.contentsId, JSON.stringify(merged1));

    // ---- only tab, released in place / Escape
    await app.evaluate((_e, [w, id]) => global.__windows.tearOff(w, id, { x: 400, y: 400 }), [win1, a.id]);
    const w4 = await waitFor(async () => { const l = await windows(); return l.length === 2 && others(l)[0].tabs.length === 1 ? others(l)[0] : null; });
    await cursor({ x: 900, y: 500 });
    await emit(w4.windowId, 'tab:dragstart', a.id, { x: 100, y: 10, stripX: 0 });
    await waitFor(async () => (await dragState())?.single);
    await boundsAt(w4.windowId, 800, 490);
    await cursor({ x: 1300, y: 700 });
    await boundsAt(w4.windowId, 1200, 690);
    await emit(w4.windowId, 'tab:dragend');
    check('only tab released over nothing: the window stays where it was dropped', (await dragState()) === null && (await windows()).length === 2 && Boolean(await boundsAt(w4.windowId, 1200, 690)), JSON.stringify(await winBounds(w4.windowId)));
    await cursor({ x: 1300, y: 700 });
    await emit(w4.windowId, 'tab:dragstart', a.id, { x: 100, y: 10, stripX: 0 });
    await cursor({ x: 1500, y: 800 });
    await boundsAt(w4.windowId, 1400, 790);
    await emit(w4.windowId, 'tab:dragcancel');
    check('Escape on an only-tab drag puts the window back', (await dragState()) === null && Boolean(await boundsAt(w4.windowId, 1200, 690)) && (await windows()).length === 2, JSON.stringify(await winBounds(w4.windowId)));
    await app.evaluate((_e, [from, id, to]) => global.__windows.moveTo(from, id, to), [w4.windowId, a.id, win1]);
    await waitFor(async () => (await windows()).length === 1);

    // ---- a tab heading out of the strip readies a window, so a drop outside lands in it at once
    await emit(win1, 'tab:switch', initialId);
    await emit(win1, 'tab:dragprep');
    const spareId = await waitFor(() => app.evaluate(() => global.__windows.spare()));
    check('a tab heading out readies a hidden window, left out of the window list', Boolean(spareId) && (await windows()).length === 1, JSON.stringify([spareId, await windows()]));
    await cursor({ x: 900, y: 500 });
    await emit(win1, 'tab:dragstart', b.id, { x: 300, y: 15, stripX: 150 });
    await emit(win1, 'tab:dragend');
    const intoSpare = await windows();
    check('the drop goes into that window straight away (no wait for a new window to load)', intoSpare.length === 2 && winOf(intoSpare, spareId)?.tabs[0]?.contentsId === b.contentsId, JSON.stringify(intoSpare));
    await app.evaluate((_e, [from, id, to]) => global.__windows.moveTo(from, id, to), [spareId, b.id, win1]);
    await waitFor(async () => (await windows()).length === 1);

    // ---- Escape during a card drag: nothing changes
    await emit(win1, 'tab:switch', b.id);
    await app.evaluate((_e, id) => global.__pinTab(id, true), b.id);
    const before3 = await win1Tabs();
    await cursor({ x: 900, y: 500 });
    await emit(win1, 'tab:dragstart', b.id, { x: 300, y: 15, stripX: 150 });
    await cursor({ x: 1000, y: 600 });
    await sleep(100);
    await emit(win1, 'tab:dragcancel');
    await sleep(300);
    const back = await windows();
    check('Escape ends the drag and opens no window', back.length === 1 && (await dragState()) === null, JSON.stringify(back));
    check('the tab is where it was, still pinned and active', JSON.stringify(await win1Tabs()) === JSON.stringify(before3) && back[0].tabs.find((t) => t.id === b.id).pinned === true && back[0].activeId === b.id, JSON.stringify([before3, back]));
    await app.evaluate((_e, id) => global.__pinTab(id, false), b.id);

    // ---- private windows are never a source or a destination
    await app.evaluate(() => global.__private.open());
    await waitFor(() => app.evaluate(() => global.__private.count() === 1 && global.__private.list()[0].tabs.length === 1));
    const priv = await app.evaluate(() => global.__private.list()[0]);
    const refused = await app.evaluate((_e, [from, id, to]) => global.__windows.moveTo(from, id, to), [win1, a.id, priv.windowId]);
    check('a tab cannot be moved into a private window', refused === false && (await app.evaluate(() => global.__private.list()[0].tabs.length)) === 1);
    const before = JSON.stringify(await windows());
    await emit(priv.windowId, 'tab:dragstart', priv.tabs[0].id, { x: 100, y: 10, stripX: 50 });
    await sleep(500);
    check("a private window's UI cannot start a drag", (await dragState()) === null && JSON.stringify(await windows()) === before && (await app.evaluate(() => global.__private.list()[0].tabs.length)) === 1);
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).setBounds({ x: 1200, y: 100, width: 900, height: 600 }), priv.windowId);
    await cursor({ x: 900, y: 500 });
    await emit(win1, 'tab:dragstart', a.id, { x: 300, y: 15, stripX: 150 });
    await cursor({ x: 1200 + 40, y: 100 + 15 });
    await cardAt({ x: 1240, y: 115 });
    await sleep(600);
    check("hovering a private window's strip gives no insertion point", !(await dragState())?.hover, JSON.stringify(await dragState()));
    await emit(priv.windowId, 'tab:dragend'); // not part of this drag
    check("a private window cannot end someone else's drag", (await dragState()) !== null);
    await emit(win1, 'tab:dragend');
    const torn = await waitFor(async () => { const l = await windows(); return l.length === 2 && l.every((w) => w.tabs.length) ? l : null; });
    check('released over a private window it becomes a normal window; the private one is untouched', Boolean(torn) && (await app.evaluate(() => global.__private.list()[0].tabs.length)) === 1, JSON.stringify(await windows()));
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), priv.windowId);
    await waitFor(() => app.evaluate(() => global.__private.count() === 0));

    // ---- a lost mouse-up never leaves a drag running
    await app.evaluate(() => global.__windows.setDragTimeout(500));
    await emit(win1, 'tab:switch', initialId);
    await cursor({ x: 700, y: 400 });
    const tabsNow = await windows();
    const donor = tabsNow.find((w) => w.tabs.length >= 2);
    if (donor) {
      await emit(donor.windowId, 'tab:dragstart', donor.tabs[0].id, { x: 100, y: 10, stripX: 50 });
      check('a drag whose release never arrives is running', Boolean(await dragState()));
      const ended = await waitFor(async () => (await dragState()) === null, 5000);
      await sleep(400);
      check('it ends by itself after the timeout and moves nothing (no new window on a guess)', Boolean(ended) && (await windows()).length === tabsNow.length, JSON.stringify(await windows()));
    } else {
      check('a window with two tabs to use for the timeout check', false, JSON.stringify(tabsNow));
    }
    await app.evaluate(() => { global.__windows.setDragTimeout(60000); global.__windows.setCursor(null); });

    // ---- a multi-selection travels together: dragged into another window, all of it goes, in order
    {
      const list0 = await windows();
      const home = list0.find((w) => w.windowId === win1) || list0[0];
      const away = list0.find((w) => w.windowId !== home.windowId);
      const m1 = await openTabIn(home.windowId, `${base}/m1`);
      const m2 = await openTabIn(home.windowId, `${base}/m2`);
      await waitFor(async () => { const w = winOf(await windows(), home.windowId); return w?.tabs.some((t) => t.id === m1.id) && w.tabs.some((t) => t.id === m2.id); });
      const homeNow = winOf(await windows(), home.windowId);
      if (away && homeNow && homeNow.tabs.some((t) => t.id === m1.id)) {
        await app.evaluate((_e, [w, ids]) => global.__windows.setSelection(w, ids), [home.windowId, [m1.id, m2.id]]);
        await app.evaluate(({ BrowserWindow }, [a, b]) => { BrowserWindow.fromId(a).setBounds({ x: 100, y: 100, width: 1000, height: 700 }); BrowserWindow.fromId(b).setBounds({ x: 1150, y: 150, width: 800, height: 600 }); }, [home.windowId, away.windowId]);
        await cursor({ x: 700, y: 500 });
        await emit(home.windowId, 'tab:dragstart', m2.id, { x: 300, y: 15, stripX: 150, pressY: 15, ids: [m1.id, m2.id] });
        check('dragging a selected tab takes the whole selection', JSON.stringify((await dragState())?.ids) === JSON.stringify([m1.id, m2.id]), JSON.stringify(await dragState()));
        await cursor({ x: 1150 + 790, y: 150 + 15 });
        await waitFor(async () => (await dragState())?.hover?.windowId === away.windowId);
        check('the strip it is over shows one slot for them', Boolean(await waitFor(async () => (await uiCount(away.windowId, '.tab-drop-slot.open')) === 1)));
        await emit(home.windowId, 'tab:dragend');
        const landed = await waitFor(async () => { const w = winOf(await windows(), away.windowId); const ids = w?.tabs.map((t) => t.id) || []; return ids.includes(m1.id) && ids.includes(m2.id) ? w : null; });
        const order = landed?.tabs.map((t) => t.id) || [];
        check('both tabs land in that window, next to each other, in order, the dragged one shown', Boolean(landed) && order.indexOf(m2.id) === order.indexOf(m1.id) + 1 && landed.activeId === m2.id, JSON.stringify(landed));
        check('no slot is left behind there', Boolean(await waitFor(async () => (await uiCount(away.windowId, '.tab-drop-slot')) === 0)));
      } else {
        check('(two windows for the multi-selection check)', false, JSON.stringify(await windows()));
      }
    }

    // ---- a group dragged by its label back into its own strip, somewhere else, stays one whole group
    {
      const list0 = await windows();
      const home = list0[0];
      const g1 = (await openTabIn(home.windowId, `${base}/g1`)).id;
      const g2 = (await openTabIn(home.windowId, `${base}/g2`)).id;
      await waitFor(async () => { const w = winOf(await windows(), home.windowId); return w?.tabs.some((t) => t.id === g1) && w.tabs.some((t) => t.id === g2); });
      const w = winOf(await windows(), home.windowId);
      const inHome = w && w.tabs.some((t) => t.id === g1) && w.tabs.some((t) => t.id === g2);
      if (inHome && w.tabs.length >= 4) {
        const gid = await app.evaluate((_e, [win, ids]) => global.__windows.group(win, ids, 'Pair'), [home.windowId, [g1, g2]]);
        const first = winOf(await windows(), home.windowId).tabs.find((t) => t.id !== g1 && t.id !== g2 && !t.pinned);
        await cursor({ x: 700, y: 500 });
        await emit(home.windowId, 'tab:dragstart', g1, { x: 300, y: 15, stripX: 150, pressY: 15, ids: [g1, g2], group: gid });
        check('a group label drag carries every tab of the group', JSON.stringify((await dragState())?.ids) === JSON.stringify([g1, g2]), JSON.stringify(await dragState()));
        const hb = await winBounds(home.windowId);
        await cursor({ x: hb.x + 3, y: hb.y + 15 });
        await waitFor(async () => (await dragState())?.hover?.windowId === home.windowId);
        await emit(home.windowId, 'tab:dragend');
        const after = await waitFor(async () => { const l = winOf(await windows(), home.windowId); return l && (await dragState()) === null ? l : null; });
        const t1 = after?.tabs.find((t) => t.id === g1), t2 = after?.tabs.find((t) => t.id === g2);
        const order = after?.tabs.map((t) => t.id) || [];
        check('both tabs are still in one group, side by side', Boolean(t1?.groupId) && t1.groupId === t2?.groupId && order.indexOf(g2) === order.indexOf(g1) + 1, JSON.stringify(after));
        check('...and it moved to the front of the loose tabs', Boolean(first) && order.indexOf(g1) < order.indexOf(first.id), JSON.stringify([first, order]));
      } else {
        check('(a window with room for the group check)', false, JSON.stringify(await windows()));
      }
    }

    // ---- the dragged window closing mid-drag leaves nothing behind in the strip it was over
    {
      const l0 = await windows();
      if (l0.length >= 2) {
        const [a0, b0] = l0;
        const donorTab = await app.evaluate(async (_e, u) => global.__agent.browser.openTab(u).id, `${base}/z`);
        const donorWin = (await windows()).find((w) => w.tabs.some((t) => t.id === donorTab));
        const other = donorWin.windowId === a0.windowId ? b0 : a0;
        await app.evaluate(({ BrowserWindow }, [a, b]) => { BrowserWindow.fromId(a).setBounds({ x: 100, y: 100, width: 1000, height: 700 }); BrowserWindow.fromId(b).setBounds({ x: 1150, y: 150, width: 800, height: 600 }); }, [donorWin.windowId, other.windowId]);
        await cursor({ x: 700, y: 500 });
        await emit(donorWin.windowId, 'tab:dragstart', donorTab, { x: 300, y: 15, stripX: 150, pressY: 15 });
        await cursor({ x: 1150 + 790, y: 150 + 15 });
        await waitFor(async () => (await uiCount(other.windowId, '.tab-drop-slot.open')) === 1);
        await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).destroy(), donorWin.windowId);
        check('the drag ends', Boolean(await waitFor(async () => (await dragState()) === null)));
        check("the other window's slot closes", Boolean(await waitFor(async () => (await uiCount(other.windowId, '.tab-drop-slot')) === 0)));
      }
    }

    // ---- every normal window comes back after a restart
    const before2 = await windows();
    const urlsOf = (l) => l.map((w) => w.tabs.map((t) => t.url).filter((u) => u.startsWith(base)).sort().join(' ')).sort().join(' | ');
    await sleep(300);
    await app.close();
    ({ app, ui } = await launch());
    const restored = await waitFor(async () => { const l = await windows(); return l.length === before2.length && urlsOf(l) === urlsOf(before2) ? l : null; });
    check('every window comes back with its tabs after a restart', Boolean(restored), `${urlsOf(before2)} => ${urlsOf(await windows())}`);
    check('no errors in the browser UI', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
    server.close();
  }

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
