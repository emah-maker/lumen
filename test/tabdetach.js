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

    // ---- the menu's tear-off: a pinned tab arrives unpinned, the same WebContents, no reload
    await app.evaluate((_e, id) => global.__pinTab(id, true), a.id);
    await app.evaluate((_e, [w, id]) => global.__windows.tearOff(w, id, { x: 300, y: 300 }), [win1, a.id]);
    const two = await waitFor(async () => { const l = await windows(); return l.length === 2 && others(l)[0]?.tabs.length === 1 ? l : null; });
    check('Move Tab to New Window makes a second window', Boolean(two), JSON.stringify(await windows()));
    const menuW2 = others(two)[0];
    const menuMoved = menuW2?.tabs[0];
    check('the new window holds the same WebContents and URL, unpinned and ungrouped', menuMoved?.contentsId === a.contentsId && menuMoved.url === `${base}/a` && !menuMoved.pinned && !menuMoved.groupId, JSON.stringify(menuMoved));
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
    const hold = await app.evaluate(() => global.__windows.cardHold());
    const cardAt = (p) => waitFor(async () => { const s = await dragState(); return s?.cardAt && s.cardAt.x === p.x - hold.x && s.cardAt.y === p.y - hold.y ? s : null; }, 3000);
    await emit(win1, 'tab:switch', initialId); // make win1 current
    await app.evaluate((_e, id) => global.__pinTab(id, true), a.id); // ...pinned, to see it arrive unpinned
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
    check('it holds the same WebContents, unpinned and ungrouped; the source keeps its other tabs', w2?.tabs[0].contentsId === a.contentsId && !w2.tabs[0].pinned && !w2.tabs[0].groupId && winOf(dropped, win1).tabs.some((t) => t.id === b.id), JSON.stringify(dropped));
    check('the page was not reloaded', stateOk(await keptState(a.contentsId)), JSON.stringify(await keptState(a.contentsId)));
    check('the new window opens with the tab under the release point (grab offset kept)', Boolean(await boundsAt(w2id, 1100 - 150, 600 - 15)), JSON.stringify(await winBounds(w2id)));
    check('...at the size of the window it came from', (await winBounds(w2id)).width === srcSize.width && (await winBounds(w2id)).height === srcSize.height, JSON.stringify([await winBounds(w2id), srcSize]));
    await cursor({ x: 200, y: 200 });
    await sleep(150);
    check('and nothing follows the cursor after the release', Boolean(await boundsAt(w2id, 950, 585)), JSON.stringify(await winBounds(w2id)));

    // ---- hover another window's strip: an insertion point, and release joins it there
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).setBounds({ x: 100, y: 100, width: 1000, height: 700 }), win1);
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).setBounds({ x: 1150, y: 150, width: 800, height: 600 }), w2id);
    await emit(win1, 'tab:switch', initialId);
    await app.evaluate((_e, id) => global.__pinTab(id, false), b.id);
    await cursor({ x: 900, y: 500 });
    await emit(win1, 'tab:dragstart', b.id, { x: 300, y: 15, stripX: 150 });
    check('a second tab starts a card drag the same way', (await dragState())?.card === true, JSON.stringify(await dragState()));
    await cursor({ x: 1150 + 3, y: 150 + 15 });
    const hoverStart = await waitFor(async () => { const s = await dragState(); return s?.hover?.windowId === w2id ? s : null; });
    check('over the start of another strip: the insertion point is before its first tab', hoverStart?.hover.beforeId === a.id, JSON.stringify(hoverStart));
    check('that strip shows the insertion marker', Boolean(await waitFor(async () => (await uiCount(w2id, '.tab.drop-before')) === 1)));
    await cursor({ x: 1150 + 780, y: 150 + 15 });
    const hoverEnd = await waitFor(async () => { const s = await dragState(); return s?.hover?.windowId === w2id && s.hover.beforeId === null ? s : null; });
    check('past its last tab: the insertion point is the end', Boolean(hoverEnd), JSON.stringify(await dragState()));
    check('...and the marker moves to the end', Boolean(await waitFor(async () => (await uiCount(w2id, '.tab.drop-end')) === 1 && (await uiCount(w2id, '.tab.drop-before')) === 0)));
    await cursor({ x: 1150 + 300, y: 150 + 400 });
    const hoverNone = await waitFor(async () => { const s = await dragState(); return s && !s.hover ? s : null; });
    check("over that window's page area (not the strip) there is no insertion point", Boolean(hoverNone) && (await uiCount(w2id, '.tab.drop-before, .tab.drop-end')) === 0, JSON.stringify(await dragState()));
    await cursor({ x: 1150 + 3, y: 150 + 15 });
    await waitFor(async () => (await dragState())?.hover?.windowId === w2id);
    await emit(win1, 'tab:dragend');
    const joined = await waitFor(async () => { const l = await windows(); const w = winOf(l, w2id); return l.length === 2 && w?.tabs.length === 2 ? l : null; });
    check('released over the strip: the tab joins that window, no new window', Boolean(joined) && (await dragState()) === null, JSON.stringify(await windows()));
    check('it lands at the index under the cursor (the start) and is the active tab', winOf(joined, w2id)?.tabs[0].id === b.id && winOf(joined, w2id).activeId === b.id && winOf(joined, w2id).tabs[0].contentsId === b.contentsId, JSON.stringify(joined));
    check('the marker is cleared', (await uiCount(w2id, '.tab.drop-before, .tab.drop-end')) === 0);

    // ---- over its own strip: the tab moves along it
    await emit(win1, 'tab:switch', initialId);
    const c = await openTab(`${base}/c`);
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
      const after = await waitFor(async () => { const l = await windows(); return l.length === tabsNow.length + 1 ? l : null; });
      check('it ends by itself after the timeout, as a drop where the cursor is', Boolean(ended) && Boolean(after), JSON.stringify(await windows()));
    } else {
      check('a window with two tabs to use for the timeout check', false, JSON.stringify(tabsNow));
    }
    await app.evaluate(() => { global.__windows.setDragTimeout(60000); global.__windows.setCursor(null); });

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
