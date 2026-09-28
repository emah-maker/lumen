// The tab strip under load and the basics around it: clicks that land while tabs are updating,
// scrolling a strip that overflows, pinned tabs, restoring a session lazily (and pinned tabs with
// it), the History page, zoom reset to the default, F11, and dialogs from a popup window.
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const seenHints = {}; // Sec-CH-UA as the server received it, by path
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    // A page whose title changes every 30 ms: every change is a tab-strip update.
    if (req.url === '/busy') return res.end('<title>busy</title><script>let n = 0; setInterval(() => { document.title = `busy ${++n}`; }, 30);</script>');
    if (req.url === '/opener') return res.end('<title>opener</title><button id="pop" onclick="window.open(\'/popup\', \'pop\', \'width=420,height=320\')">open</button>');
    if (req.url === '/popup') return res.end('<title>popup</title><script>window.brands = JSON.stringify(navigator.userAgentData?.brands || []); setTimeout(() => { window.answer = alert("from the popup"); window.done = true; }, 400);</script>');
    // A cross-site iframe (localhost vs 127.0.0.1) runs in its own process, as Cloudflare's checkbox does.
    if (req.url === '/xframe' || req.url === '/frame') seenHints[req.url] = req.headers['sec-ch-ua'];
    if (req.url === '/xframe') return res.end(`<title>xframe</title><iframe src="http://localhost:${server.address().port}/frame"></iframe>`);
    if (req.url === '/frame') return res.end('<script>window.brands = JSON.stringify(navigator.userAgentData?.brands || []);</script>');
    res.end(`<title>Page ${req.url}</title><p>${req.url}</p>`);
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-tabstrip-'));
  const launch = () => electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile } });

  let app = await launch();
  let ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));

  const open = (url, background = false) => app.evaluate(async (_e, { url, background }) => {
    const t = global.__agent.browser.openTab(url, { background });
    await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); });
    return t.id;
  }, { url, background });
  const tabCount = () => ui.evaluate(() => document.querySelectorAll('#tabs .tab').length);
  const strip = () => app.evaluate(() => global.__tabsArray());

  // ---- 1. clicks land while the strip is updating ----
  for (let i = 0; i < 10; i++) await open(`${base}/p${i}`, true);
  await open(`${base}/busy`);
  await sleep(300);
  let closed = 0;
  for (let i = 0; i < 6; i++) {
    const before = await tabCount();
    const box = await ui.evaluate(() => {
      const tab = [...document.querySelectorAll('#tabs .tab:not(.active)')].pop();
      const r = tab.querySelector('.tab-close').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await ui.mouse.move(box.x, box.y);
    await ui.mouse.down();
    await sleep(90); // a slow press: several updates arrive while the button is held
    await ui.mouse.up();
    await sleep(250);
    if ((await tabCount()) === before - 1) closed++;
  }
  check(`the ✕ closes a tab while its title updates (${closed}/6)`, closed === 6, closed);
  let middle = 0;
  for (let i = 0; i < 2; i++) {
    const before = await tabCount();
    const box = await ui.evaluate(() => { const r = [...document.querySelectorAll('#tabs .tab:not(.active)')].pop().getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; });
    await ui.mouse.click(box.x, box.y, { button: 'middle', delay: 90 });
    await sleep(250);
    if ((await tabCount()) === before - 1) middle++;
  }
  check(`middle-click closes a tab while the strip updates (${middle}/2)`, middle === 2, middle);
  let switched = 0;
  for (let i = 0; i < 3; i++) {
    const target = await ui.evaluate((n) => { const el = document.querySelectorAll('#tabs .tab')[n]; const r = el.getBoundingClientRect(); return { id: Number(el.dataset.id), x: r.left + 30, y: r.top + r.height / 2 }; }, i);
    await ui.mouse.click(target.x, target.y, { delay: 90 });
    await sleep(250);
    if ((await app.evaluate(() => global.__agent.browser.activeTab().id)) === target.id) switched++;
  }
  check(`clicking a tab switches to it while the strip updates (${switched}/3)`, switched === 3, switched);
  const sameElement = await ui.evaluate(async () => {
    const el = document.querySelector('#tabs .tab');
    await new Promise((r) => setTimeout(r, 300));
    return el.isConnected && el === document.querySelector('#tabs .tab');
  });
  check('tab elements are updated in place, not rebuilt', sameElement, sameElement);

  // ---- 2. an overflowing strip scrolls with the wheel and stays put during updates ----
  for (let i = 0; i < 26; i++) await open(`${base}/q${i}`, true);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 700));
  await sleep(400);
  const busyId = (await app.evaluate(() => global.__agent.browser.listTabs())).find((t) => /busy/.test(t.title))?.id;
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), busyId);
  await ui.evaluate(() => { document.getElementById('tabs').scrollLeft = 1e6; });
  await sleep(300);
  const over = await ui.evaluate(() => { const s = document.getElementById('tabs'); return { overflow: s.scrollWidth > s.clientWidth, left: s.classList.contains('more-left'), start: s.scrollLeft }; });
  check('many tabs overflow the strip and it shows a fade on the hidden side', over.overflow && over.left, JSON.stringify(over));
  const stripBox = await ui.evaluate(() => { const r = document.getElementById('tabs').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await ui.mouse.move(stripBox.x, stripBox.y);
  await ui.mouse.wheel(0, -400);
  await sleep(200);
  const scrolled = await ui.evaluate(() => document.getElementById('tabs').scrollLeft);
  check('the mouse wheel scrolls the strip sideways', scrolled < over.start - 100, `${over.start} -> ${scrolled}`);
  await sleep(800); // the busy (active) tab keeps updating
  const still = await ui.evaluate(() => document.getElementById('tabs').scrollLeft);
  check('updates to the active tab don\'t scroll the strip back', Math.abs(still - scrolled) < 2, `${scrolled} -> ${still}`);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));

  // ---- 3. pinned tabs ----
  const list = await strip();
  const pinId = list[list.length - 1].id;
  await app.evaluate((_e, id) => global.__pinTab(id, true), pinId);
  await sleep(200);
  let now = await strip();
  check('a pinned tab moves to the front', now[0].id === pinId && now[0].pinned, JSON.stringify(now.slice(0, 2)));
  const pinnedEl = await ui.evaluate(() => { const el = document.querySelector('#tabs .tab'); return { pinned: el.classList.contains('pinned'), width: el.getBoundingClientRect().width, title: getComputedStyle(el.querySelector('.tab-title')).display }; });
  check('it shows as a compact icon-only tab', pinnedEl.pinned && pinnedEl.width <= 41 && pinnedEl.title === 'none', JSON.stringify(pinnedEl));
  await app.evaluate(({ ipcMain }, id) => ipcMain.emit('tab:move', {}, id, 20), pinId);
  now = await strip();
  check('a pinned tab can\'t be dragged in among the others', now[0].id === pinId, now.findIndex((t) => t.id === pinId));
  const second = now[3].id;
  await app.evaluate((_e, id) => global.__pinTab(id, true), second);
  await app.evaluate(({ ipcMain }, id) => ipcMain.emit('tab:move', {}, id, 0), now[5].id);
  now = await strip();
  check('a loose tab can\'t be dropped in among pinned tabs', now[0].pinned && now[1].pinned && now[2].id === now.find((t) => !t.pinned).id && !now[2].pinned, JSON.stringify(now.slice(0, 3)));
  await app.evaluate((_e, id) => global.__pinTab(id, false), second);
  now = await strip();
  check('unpinning makes it the first loose tab', !now[1].pinned && now[1].id === second, JSON.stringify(now.slice(0, 3)));

  // ---- 4. zoom reset goes to the default zoom from Settings ----
  await app.evaluate(async (_e, id) => { await global.__settings.backend.set('defaultZoom', 1.25); global.__agent.browser.switchTab(id); }, (await strip()).find((t) => !t.pinned && t.id !== busyId).id);
  await sleep(300);
  await app.evaluate(() => { global.__zoomBy(0.5); global.__zoomBy(0.5); });
  await sleep(200);
  const zoomedIn = await ui.evaluate(() => !document.getElementById('zoom').hidden);
  await app.evaluate(() => global.__zoomBy(0));
  await sleep(200);
  const factor = await app.evaluate(() => global.__agent.browser.activeTab().webContents.getZoomFactor());
  const pill = await ui.evaluate(() => document.getElementById('zoom').hidden);
  check('Actual Size returns to the default zoom (125%), and the zoom pill hides', zoomedIn && Math.abs(factor - 1.25) < 0.01 && pill, JSON.stringify({ zoomedIn, factor, pill }));
  await app.evaluate(() => global.__settings.backend.set('defaultZoom', 1));

  // ---- 5. the History page ----
  await app.evaluate(async () => {
    global.__openHistoryPage();
    const wc = global.__agent.browser.activeTab().webContents;
    await new Promise((r) => { if (!wc.isLoading()) r(); else wc.once('did-finish-load', r); });
  });
  await sleep(500);
  const inTab = (js) => app.evaluate((_e, code) => global.__agent.browser.activeTab().webContents.executeJavaScript(code), js);
  const historyUrl = await app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL());
  const rows = await inTab("document.querySelectorAll('.row').length");
  check('History lists visited pages without packing them into the URL', rows >= 5 && !historyUrl.includes('#'), `${rows} rows, ${historyUrl.slice(-40)}`);
  const firstUrl = await inTab("document.querySelector('.row a').href");
  await inTab("document.querySelector('.row .remove').click()");
  await sleep(300);
  const listed = await inTab('window.lumenHistory.list().then((l) => l.map((e) => e.url))');
  const rowsAfter = await inTab("document.querySelectorAll('.row').length");
  check('a history entry can be removed', rowsAfter === rows - 1 && !listed.includes(firstUrl), `${rows} -> ${rowsAfter}, still listed: ${listed.includes(firstUrl)}`);
  await open(`${base}/plain`);
  check('web pages don\'t get the History bridge', (await inTab('typeof window.lumenHistory')) === 'undefined', await inTab('typeof window.lumenHistory'));

  // ---- 6. F11 (Windows/Linux) ----
  if (process.platform !== 'darwin') {
    const key = (k) => app.evaluate(({ BrowserWindow }, k) => { const wc = BrowserWindow.getAllWindows()[0].webContents; wc.sendInputEvent({ type: 'keyDown', keyCode: k }); wc.sendInputEvent({ type: 'keyUp', keyCode: k }); }, k);
    await key('F11');
    await sleep(700);
    const full = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen());
    await key('F11');
    await sleep(700);
    const back = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen());
    check('F11 toggles full screen', full && !back, JSON.stringify({ full, back }));
  }

  // ---- 7. a popup's alert() is drawn in the popup, and the popup presents itself as Chrome ----
  await open(`${base}/opener`);
  const tabBrands = await inTab('JSON.stringify(navigator.userAgentData?.brands || [])');
  await inTab("document.getElementById('pop').click()");
  let popupInfo = null;
  for (let i = 0; i < 30 && !popupInfo?.overlay; i++) {
    await sleep(200);
    popupInfo = await app.evaluate(({ BrowserWindow }) => {
      const popup = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/popup'));
      if (!popup) return null;
      const overlay = popup.contentView.children.find((v) => v.webContents?.getURL().includes('dialog.html') && v.getVisible());
      const browserWin = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/renderer/index.html'));
      const main = browserWin.contentView.children.some((v) => v.webContents?.getURL().includes('dialog.html') && v.getVisible());
      return { overlay: Boolean(overlay), main };
    });
  }
  check('a popup\'s alert shows in the popup, not the main window', popupInfo?.overlay && !popupInfo.main, JSON.stringify(popupInfo));
  const answered = await app.evaluate(async ({ BrowserWindow }) => {
    const popup = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/popup'));
    const overlay = popup.contentView.children.find((v) => v.webContents?.getURL().includes('dialog.html'));
    await overlay.webContents.executeJavaScript("document.querySelector('#buttons button').click()");
    await new Promise((r) => setTimeout(r, 300));
    return { done: await popup.webContents.executeJavaScript('window.done === true'), brands: await popup.webContents.executeJavaScript('window.brands') };
  });
  check('dismissing it lets the popup continue', answered.done, JSON.stringify(answered));
  check('the popup presents the same browser brands as a tab', answered.brands === tabBrands && /Chrome/.test(answered.brands), `${answered.brands} vs ${tabBrands}`);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/popup'))?.close());

  // ---- 7b. a click in the page right after switching tabs keeps focus in the page ----
  const pageTabs = (await app.evaluate(() => global.__agent.browser.listTabs())).filter((t) => /\/(p|q)\d+$/.test(t.url));
  await ui.evaluate(() => document.getElementById('address').focus());
  const clickFocus = await app.evaluate(async (_e, id) => {
    global.__agent.browser.switchTab(id);
    await new Promise((r) => setTimeout(r, 60)); // inside the 500 ms window that guards the address bar
    const wc = global.__agent.browser.activeTab().webContents;
    wc.sendInputEvent({ type: 'mouseDown', x: 60, y: 60, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: 60, y: 60, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 30));
    wc.focus(); // what a real click does natively; a synthetic one doesn't move focus by itself
    await new Promise((r) => setTimeout(r, 600));
    return wc.isFocused();
  }, pageTabs[pageTabs.length - 1].id);
  check('clicking the page right after a tab switch keeps focus in the page', clickFocus, clickFocus);

  // ---- 8. restart: only the active tab loads; pinned tabs stay pinned ----
  const activeUrl = await app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL());
  await sleep(3500); // session save
  await app.close();
  app = await launch();
  ui = await app.firstWindow();
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await sleep(1500);
  const restored = await strip();
  const loaded = restored.filter((t) => !t.sleeping);
  check('after a restart only the active tab loads', loaded.length === 1 && restored.length >= 20, `${loaded.length} loaded of ${restored.length}`);
  check('the pinned tab comes back pinned, at the front', restored[0].pinned && restored.filter((t) => t.pinned).length === 1, JSON.stringify(restored.slice(0, 2)));
  const titles = await ui.evaluate(() => [...document.querySelectorAll('#tabs .tab')].slice(0, 6).map((t) => t.title));
  check('restored tabs show their titles before loading', titles.filter((t) => /^Page \//.test(t)).length >= 3, JSON.stringify(titles));
  const activeAgain = await app.evaluate(() => global.__agent.browser.activeTab()?.webContents.getURL());
  check('the tab that was active is active again', loaded[0] && activeAgain === activeUrl, `${activeAgain} vs ${activeUrl}`);
  const sleeper = restored.find((t) => t.sleeping && !t.pinned);
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), sleeper.id);
  await sleep(1500);
  const woke = await app.evaluate(() => global.__agent.browser.activeTab()?.webContents.getURL());
  check('opening a restored tab loads it', /\/(p|q)\d+$/.test(woke || ''), woke);

  // ---- 9. a sleeping tab keeps its back/forward history ----
  await open(`${base}/h1`);
  await app.evaluate(async (_e, url) => { const wc = global.__agent.browser.activeTab().webContents; await wc.loadURL(url); }, `${base}/h2`);
  const hid = await app.evaluate(() => global.__agent.browser.activeTab().id);
  await open(`${base}/other`);
  await app.evaluate((_e, id) => global.__tabSleep.sleep(id), hid);
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), hid);
  await sleep(1500);
  const nav = await app.evaluate(() => { const wc = global.__agent.browser.activeTab().webContents; return { url: wc.getURL(), back: wc.navigationHistory.canGoBack() }; });
  check('a woken tab can still go back', nav.url.endsWith('/h2') && nav.back, JSON.stringify(nav));

  // ---- 10. under memory pressure a background tab sleeps after minutes, not 20 minutes ----
  await open(`${base}/pressure`);
  const pid = await app.evaluate(() => global.__agent.browser.activeTab().id);
  await open(`${base}/front`);
  await app.evaluate((_e, id) => global.__tabSleep.age(id, 3 * 60 * 1000), pid);
  const asleep = async () => (await app.evaluate(() => global.__tabSleep.state())).find((t) => t.id === pid).sleeping;
  await app.evaluate(() => { global.__tabSleep.fakePressure(false); return global.__tabSleep.sweep(); });
  check('no pressure: a tab idle 3 minutes stays awake', !(await asleep()));
  await app.evaluate(() => { global.__tabSleep.fakePressure(true); return global.__tabSleep.sweep(); });
  check('memory pressure: a tab idle 3 minutes sleeps', await asleep());
  const level = await app.evaluate(() => global.__tabSleep.memoryPressure());
  check('the real pressure check answers', typeof level === 'boolean', level);

  // ---- 11. a cross-site iframe presents itself as Chrome like its page (Cloudflare checks this) ----
  await open(`${base}/xframe`);
  await sleep(500);
  const frames = await app.evaluate(async () => {
    const wc = global.__agent.browser.activeTab().webContents;
    return Promise.all(wc.mainFrame.framesInSubtree.map(async (f) => ({ url: f.url, brands: await f.executeJavaScript('JSON.stringify(navigator.userAgentData?.brands.map((b) => b.brand) || [])') })));
  });
  const inner = frames.find((f) => f.url.includes('localhost'));
  check('a cross-site iframe says Google Chrome', inner && inner.brands.includes('Google Chrome'), JSON.stringify(frames));
  // The Sec-CH-UA header says the same thing as the page's JavaScript, on the page and the iframe.
  const jsBrands = await app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript('navigator.userAgentData.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(", ")'));
  check('Sec-CH-UA is sent, and matches the page, on the page and a cross-site iframe', seenHints['/xframe'] === jsBrands && seenHints['/frame'] === jsBrands && /Google Chrome/.test(jsBrands), JSON.stringify({ seenHints, jsBrands }));

  check('no renderer errors', errors.length === 0, errors.join('; '));
  server.close();
  await app.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
