// Tab tear-off between windows: dragging a tab out of the strip makes a new window around the same
// WebContents, releasing it over another window's strip joins that window, the last tab of a window
// stays put, private windows are never involved, and every normal window comes back after a restart.
// The drag ends in the 'tab:drop' IPC (with the cursor point); the test sends that directly, so
// nothing moves the real cursor. Windows are invisible (LUMEN_TEST_BACKGROUND) apart from the private one.
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
  // The 'tab:drop' a released drag sends, from window `windowId`'s UI, with the cursor at `point`.
  const drop = (windowId, tabId, point) => app.evaluate(({ ipcMain, BrowserWindow }, [id, tab, p]) => {
    const wc = BrowserWindow.fromId(id).webContents;
    ipcMain.emit('tab:drop', { sender: wc, senderFrame: wc.mainFrame }, tab, p);
  }, [windowId, tabId, point]);
  const inTab = (contentsId, js) => app.evaluate(({ webContents }, [id, code]) => webContents.fromId(id).executeJavaScript(code), [contentsId, js]);
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));

  try {
    const [first] = await windows();
    const win1 = first.windowId;
    const a = await openTab(`${base}/a`);
    const b = await openTab(`${base}/b`);
    // State that a reload would lose.
    await inTab(a.contentsId, "document.getElementById('f').value = 'typed text'; window.scrollTo(0, 400); window.marker = 'kept'; 0");
    await sleep(200);

    // ---- the tab menu: a second entry for a window's tabs only when there is somewhere to go
    const menu1 = await app.evaluate((_e, [w, id]) => global.__windows.tabMenu(w, id), [win1, a.id]);
    check('the tab menu offers Move Tab to New Window', menu1.some((i) => i.label === 'Move Tab to New Window' && i.enabled), JSON.stringify(menu1.map((i) => i.label)));
    check('…and no "to Window" entry while there is one window', !menu1.some((i) => i.label === 'Move Tab to Window'), JSON.stringify(menu1.map((i) => i.label)));

    // ---- tear-off: released far from every strip
    await app.evaluate((_e, id) => global.__pinTab(id, true), a.id); // a pinned tab arrives unpinned
    await drop(win1, a.id, { x: 300, y: 300 });
    const two = await waitFor(async () => { const l = await windows(); return l.length === 2 && l.find((w) => w.windowId !== win1)?.tabs.length === 1 ? l : null; });
    check('tearing a tab off makes a second window', Boolean(two), JSON.stringify(await windows()));
    const w2 = two?.find((w) => w.windowId !== win1);
    const moved = w2?.tabs[0];
    check('the new window holds the same WebContents and URL', moved?.contentsId === a.contentsId && moved.url === `${base}/a`, JSON.stringify(moved));
    check('the source window no longer has it (and keeps its other tabs)', two && !two.find((w) => w.windowId === win1).tabs.some((t) => t.id === a.id) && two.find((w) => w.windowId === win1).tabs.some((t) => t.id === b.id), JSON.stringify(two));
    check('a pinned tab arrives unpinned, ungrouped', moved && !moved.pinned && !moved.groupId, JSON.stringify(moved));
    const state = await inTab(a.contentsId, "({ marker: window.marker, typed: document.getElementById('f').value, y: Math.round(window.scrollY), title: document.title })");
    check('the page was not reloaded: script state, typed text, scroll and title survive', state.marker === 'kept' && state.typed === 'typed text' && state.y === 400 && state.title === 'Page a', JSON.stringify(state));
    const shown = await app.evaluate(({ BrowserWindow, webContents }, [id, ws]) => {
      const view = BrowserWindow.fromId(ws).contentView.children.find((v) => v.webContents && v.webContents.id === id);
      return Boolean(view) && view.getVisible();
    }, [a.contentsId, w2.windowId]);
    check('its view is attached to the new window and visible', shown);
    const ui2 = await waitFor(async () => app.windows().find((p) => p !== ui && p.url().includes('index.html')));
    const strip2 = await waitFor(async () => { const n = await ui2.locator('.tab').count(); return n === 1 ? n : 0; });
    check("the new window's own strip shows that one tab", Boolean(strip2), await ui2.locator('.tab').count());

    // ---- the menu now lists the other window
    const menu2 = await app.evaluate((_e, [w, id]) => global.__windows.tabMenu(w, id), [win1, b.id]);
    const sub = menu2.find((i) => i.label === 'Move Tab to Window');
    check('with two windows the menu lists the other one under Move Tab to Window', sub && sub.sub.length === 1 && /Page a/.test(sub.sub[0]), JSON.stringify(sub));

    // ---- refusal: a window's only tab is never torn off
    await drop(w2.windowId, a.id, { x: 3000, y: 3000 });
    await sleep(600); // a refusal has no event to wait for
    const still = await windows();
    check("a window's only tab is not torn off", still.length === 2 && still.find((w) => w.windowId === w2.windowId).tabs.some((t) => t.id === a.id), JSON.stringify(still));

    // ---- released over another window's strip: joins it, the emptied window closes
    const bounds1 = await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).getContentBounds(), win1);
    await drop(w2.windowId, a.id, { x: bounds1.x + 3, y: bounds1.y + 15 });
    const joined = await waitFor(async () => { const l = await windows(); return l.length === 1 && l[0].tabs.some((t) => t.id === a.id) ? l[0] : null; });
    check('dropping on another strip joins that window and closes the emptied one', Boolean(joined), JSON.stringify(await windows()));
    check('it lands at the index under the cursor (the start of the strip)', joined?.tabs[0].id === a.id, JSON.stringify(joined?.tabs));
    check('the same WebContents came along, and is the active tab', joined?.tabs[0].contentsId === a.contentsId && joined.activeId === a.id, JSON.stringify(joined));
    const back = await inTab(a.contentsId, "({ marker: window.marker, typed: document.getElementById('f').value, y: Math.round(window.scrollY) })");
    check('and still has its state', back.marker === 'kept' && back.typed === 'typed text' && back.y === 400, JSON.stringify(back));

    // ---- the menu path: to a new window, then to a named window by id
    await app.evaluate((_e, [w, id]) => global.__windows.tearOff(w, id, { x: 400, y: 400 }), [win1, b.id]);
    const again = await waitFor(async () => { const l = await windows(); return l.length === 2 && l.find((w) => w.windowId !== win1)?.tabs.length === 1 ? l : null; });
    check('Move Tab to New Window makes a window', Boolean(again), JSON.stringify(await windows()));
    const w3 = again?.find((w) => w.windowId !== win1);
    await app.evaluate((_e, [from, id, to]) => global.__windows.moveTo(from, id, to), [w3.windowId, b.id, win1]);
    const merged = await waitFor(async () => { const l = await windows(); return l.length === 1 && l[0].tabs.some((t) => t.id === b.id) ? l : null; });
    check('Move Tab to Window merges it back and closes the empty window', Boolean(merged), JSON.stringify(await windows()));

    // ---- private windows are never a source or a destination
    await app.evaluate(() => global.__private.open());
    await waitFor(() => app.evaluate(() => global.__private.count() === 1 && global.__private.list()[0].tabs.length === 1));
    const priv = await app.evaluate(() => global.__private.list()[0]);
    const refused = await app.evaluate((_e, [from, id, to]) => global.__windows.moveTo(from, id, to), [win1, a.id, priv.windowId]);
    check('a tab cannot be moved into a private window', refused === false && (await app.evaluate(() => global.__private.list()[0].tabs.length)) === 1);
    const before = JSON.stringify(await windows());
    await app.evaluate(({ ipcMain, BrowserWindow }, [id, tab]) => {
      const wc = BrowserWindow.fromId(id).webContents;
      ipcMain.emit('tab:drop', { sender: wc, senderFrame: wc.mainFrame }, tab, { x: 300, y: 300 });
    }, [priv.windowId, priv.tabs[0].id]);
    await sleep(600);
    check("a private window's UI cannot send tab:drop", JSON.stringify(await windows()) === before && (await app.evaluate(() => global.__private.list()[0].tabs.length)) === 1);
    const pb = await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).getContentBounds(), priv.windowId);
    await drop(win1, a.id, { x: pb.x + 40, y: pb.y + 15 });
    const torn = await waitFor(async () => { const l = await windows(); return l.length === 2 && l.every((w) => w.tabs.length) && !l.find((w) => w.tabs.some((t) => t.id === a.id)).tabs.some((t) => t.id === b.id); });
    check('dropping a normal tab over a private window makes a normal window, not a join', Boolean(torn) && (await app.evaluate(() => global.__private.list()[0].tabs.length)) === 1, JSON.stringify(await windows()));
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), priv.windowId);
    await waitFor(() => app.evaluate(() => global.__private.count() === 0));

    // ---- every normal window comes back after a restart
    const before2 = await windows();
    const urlsOf = (l) => l.map((w) => w.tabs.map((t) => t.url).filter((u) => u.startsWith(base)).sort().join(' ')).sort().join(' | ');
    await sleep(300);
    await app.close();
    ({ app, ui } = await launch());
    const restored = await waitFor(async () => { const l = await windows(); return l.length === 2 && urlsOf(l) === urlsOf(before2) ? l : null; });
    check('two windows come back with their tabs after a restart', Boolean(restored), `${urlsOf(before2)} => ${urlsOf(await windows())}`);
    check('no errors in the browser UI', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close().catch(() => {});
    server.close();
  }

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
