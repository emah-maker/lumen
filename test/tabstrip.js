// The tab strip under load and the basics around it: clicks that land while tabs are updating,
// scrolling a strip that overflows, pinned tabs, restoring a session lazily (and pinned tabs with
// it), favicons, the History page, zoom reset to the default, F11, and dialogs from a popup window.
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Polls until fn() is truthy (returns true) or the time runs out (returns false).
  const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(50); } return false; };

  const seenHints = {}; // Sec-CH-UA as the server received it, by path
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    // A page whose title changes every 30 ms: every change is a tab-strip update.
    if (req.url === '/busy') return res.end('<title>busy</title><script>let n = 0; setInterval(() => { document.title = `busy ${++n}`; }, 30);</script>');
    // Research tabs (section 12): the page shows the Cookie header it got, and sets a cookie of its own.
    if (req.url.startsWith('/echo') || req.url === '/plain-echo') { if (req.url === '/echo') res.setHeader('Set-Cookie', 'fromresearch=1; Path=/'); return res.end(`<title>Cookie: ${req.headers.cookie || 'none'}</title><p>echo</p>`); }
    if (req.url === '/child') return res.end(`<title>Child ${req.headers.cookie || 'none'}</title>`);
    if (req.url === '/opener') return res.end('<title>opener</title><button id="pop" onclick="window.open(\'/popup\', \'pop\', \'width=420,height=320\')">open</button>');
    if (req.url === '/popup') return res.end('<title>popup</title><script>window.brands = JSON.stringify(navigator.userAgentData?.brands || []); setTimeout(() => { window.answer = alert("from the popup"); window.done = true; }, 400);</script>');
    // A cross-site iframe (localhost vs 127.0.0.1) runs in its own process, as Cloudflare's checkbox does.
    if (req.url === '/xframe' || req.url === '/frame') seenHints[req.url] = req.headers['sec-ch-ua'];
    if (req.url === '/xframe') return res.end(`<title>xframe</title><iframe src="http://localhost:${server.address().port}/frame"></iframe>`);
    if (req.url === '/frame') return res.end('<script>window.brands = JSON.stringify(navigator.userAgentData?.brands || []);</script>');
    // Favicons (section 7c): a good icon, a missing one, one that fails the first time it's asked
    // for, a download and an empty (204) response, neither of which leaves the page.
    if (req.url === '/fav/i.png' || req.url === '/fav/good.png') { res.setHeader('Content-Type', 'image/png'); return res.end(PNG); }
    if (req.url === '/fav/flaky.png') {
      if (!flakyServed++) { res.writeHead(500); return res.end(); }
      res.setHeader('Content-Type', 'image/png');
      return res.end(PNG);
    }
    if (req.url === '/fav/file.bin') { res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Disposition', 'attachment; filename=lumen-test.bin'); return res.end('x'); }
    if (req.url === '/fav/empty') { res.writeHead(204); return res.end(); }
    if (/^\/fav\/.*\.(png|ico)$/.test(req.url)) { res.writeHead(404); return res.end(); }
    if (req.url === '/fav/broken') return res.end('<title>broken icon</title><link rel=icon href=/fav/good.png><link rel=icon href=/fav/a-missing.png>');
    if (req.url === '/fav/flaky') return res.end('<title>flaky icon</title><link rel=icon href=/fav/flaky.png>');
    if (req.url.startsWith('/fav/')) return res.end(`<title>icon ${req.url}</title><link rel=icon href=/fav/i.png><a id=dl href=/fav/file.bin>dl</a><a id=empty href=/fav/empty>204</a><a id=next href=/fav/next>next</a>`);
    res.end(`<title>Page ${req.url}</title><p>${req.url}</p>`);
  }).listen(0);
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  let flakyServed = 0;
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-tabstrip-'));
  const launch = () => electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile } });

  let app = await launch();
  let ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await app.evaluate(({ BrowserWindow }) => [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].setSize(1440, 920));

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
    await sleep(250); // also lets the strip reflow before the next close button is aimed at
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
  await app.evaluate(({ BrowserWindow }) => [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].setSize(900, 700));
  await waitFor(() => ui.evaluate(() => { const s = document.getElementById('tabs'); return s.scrollWidth > s.clientWidth; }));
  const busyId = (await app.evaluate(() => global.__agent.browser.listTabs())).find((t) => /busy/.test(t.title))?.id;
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), busyId);
  await ui.evaluate(() => { document.getElementById('tabs').scrollLeft = 1e6; });
  await waitFor(() => ui.evaluate(() => document.getElementById('tabs').classList.contains('more-left')));
  const over = await ui.evaluate(() => { const s = document.getElementById('tabs'); return { overflow: s.scrollWidth > s.clientWidth, left: s.classList.contains('more-left'), start: s.scrollLeft }; });
  check('many tabs overflow the strip and it shows a fade on the hidden side', over.overflow && over.left, JSON.stringify(over));
  const stripBox = await ui.evaluate(() => { const r = document.getElementById('tabs').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await ui.mouse.move(stripBox.x, stripBox.y);
  await ui.mouse.wheel(0, -400);
  await waitFor(() => ui.evaluate((start) => document.getElementById('tabs').scrollLeft < start - 100, over.start));
  const scrolled = await ui.evaluate(() => document.getElementById('tabs').scrollLeft);
  check('the mouse wheel scrolls the strip sideways', scrolled < over.start - 100, `${over.start} -> ${scrolled}`);
  await sleep(800); // the busy (active) tab keeps updating
  const still = await ui.evaluate(() => document.getElementById('tabs').scrollLeft);
  check('updates to the active tab don\'t scroll the strip back', Math.abs(still - scrolled) < 2, `${scrolled} -> ${still}`);
  await app.evaluate(({ BrowserWindow }) => [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].setSize(1440, 920));

  // ---- 3. pinned tabs ----
  const list = await strip();
  const pinId = list[list.length - 1].id;
  await app.evaluate((_e, id) => global.__pinTab(id, true), pinId);
  await waitFor(async () => (await strip())[0].id === pinId);
  let now = await strip();
  check('a pinned tab moves to the front', now[0].id === pinId && now[0].pinned, JSON.stringify(now.slice(0, 2)));
  await waitFor(() => ui.evaluate(() => document.querySelector('#tabs .tab')?.classList.contains('pinned')), 3000); // (the strip draws a frame after the state changes)
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
  const zoomTab = (await strip()).find((t) => !t.pinned && t.id !== busyId).id;
  await app.evaluate(async (_e, id) => { await global.__settings.backend.set('defaultZoom', 1.25); global.__agent.browser.switchTab(id); }, zoomTab);
  await waitFor(async () => (await app.evaluate(() => global.__agent.browser.activeTab().id)) === zoomTab);
  await app.evaluate(() => { global.__zoomBy(0.5); global.__zoomBy(0.5); });
  const zoomedIn = await waitFor(() => ui.evaluate(() => !document.getElementById('zoom').hidden));
  await app.evaluate(() => global.__zoomBy(0));
  await waitFor(async () => Math.abs((await app.evaluate(() => global.__agent.browser.activeTab().webContents.getZoomFactor())) - 1.25) < 0.01 && (await ui.evaluate(() => document.getElementById('zoom').hidden)));
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
  const inTab = (js) => app.evaluate((_e, code) => global.__agent.browser.activeTab().webContents.executeJavaScript(code), js);
  await waitFor(async () => (await inTab("document.querySelectorAll('.row').length")) >= 5);
  const historyUrl = await app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL());
  const rows = await inTab("document.querySelectorAll('.row').length");
  check('History lists visited pages without packing them into the URL', rows >= 5 && !historyUrl.includes('#'), `${rows} rows, ${historyUrl.slice(-40)}`);
  const firstUrl = await inTab("document.querySelector('.row a').href");
  await inTab("document.querySelector('.row .remove').click()");
  await waitFor(async () => (await inTab("document.querySelectorAll('.row').length")) === rows - 1);
  const listed = await inTab('window.lumenHistory.list().then((l) => l.map((e) => e.url))');
  const rowsAfter = await inTab("document.querySelectorAll('.row').length");
  check('a history entry can be removed', rowsAfter === rows - 1 && !listed.includes(firstUrl), `${rows} -> ${rowsAfter}, still listed: ${listed.includes(firstUrl)}`);
  await open(`${base}/plain`);
  check('web pages don\'t get the History bridge', (await inTab('typeof window.lumenHistory')) === 'undefined', await inTab('typeof window.lumenHistory'));

  // ---- 6. F11 (Windows/Linux) ----
  if (process.platform !== 'darwin') {
    const key = (k) => app.evaluate(({ BrowserWindow }, k) => { const wc = [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].webContents; wc.sendInputEvent({ type: 'keyDown', keyCode: k }); wc.sendInputEvent({ type: 'keyUp', keyCode: k }); }, k);
    const isFull = () => app.evaluate(({ BrowserWindow }) => [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].isFullScreen());
    await key('F11');
    const full = await waitFor(isFull);
    await sleep(300); // let the window settle in full screen before leaving it
    await key('F11');
    const back = !(await waitFor(async () => !(await isFull())));
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

  // ---- 7c. favicons show, and stay, whenever the page has one ----
  // The tab's icon in the strip: an <img> that has loaded, or the globe/page icon standing in.
  const iconOf = (id) => ui.evaluate((id) => {
    const el = document.querySelector(`#tabs .tab[data-id="${id}"] .tab-favicon`);
    return el && { img: el.tagName === 'IMG', src: el.getAttribute('src') || '', ok: el.tagName === 'IMG' && el.complete && el.naturalWidth > 0 };
  }, id);
  const showsIcon = async (id, file, ms = 4000) => (await waitFor(async () => { const i = await iconOf(id); return i?.ok && i.src.endsWith(file); }, ms)) || iconOf(id);
  const inActive = (code) => app.evaluate((_e, code) => global.__agent.browser.activeTab().webContents.executeJavaScript(code), code);
  const favId = await open(`${base}/fav/first`);
  check('a page\'s favicon shows in its tab', (await showsIcon(favId, '/fav/i.png')) === true, JSON.stringify(await iconOf(favId)));
  // Chromium reports icons only when they change: a reload or the next page of a site with the same
  // icon gets no report, and clearing the icon when a navigation started left those tabs a globe.
  await app.evaluate(async () => { const wc = global.__agent.browser.activeTab().webContents; wc.reload(); await new Promise((r) => wc.once('did-stop-loading', r)); });
  await sleep(500);
  check('the favicon is still there after a reload', (await showsIcon(favId, '/fav/i.png', 1000)) === true, JSON.stringify(await iconOf(favId)));
  await inActive("document.getElementById('next').click()");
  await waitFor(() => app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL().endsWith('/fav/next') && !global.__agent.browser.activeTab().webContents.isLoading()));
  await sleep(500);
  check('the next page of the site, with the same icon, still shows it', (await showsIcon(favId, '/fav/i.png', 1000)) === true, JSON.stringify(await iconOf(favId)));
  // A link to a download, or to a 204, starts a navigation that never commits: the page stays.
  await app.evaluate((_e, dir) => global.__settings.backend.set('downloadDir', dir), profile); // not ~/Downloads
  await inActive("document.getElementById('dl').click()");
  await sleep(1200);
  check('a link that downloads a file doesn\'t take the page\'s favicon away', (await showsIcon(favId, '/fav/i.png', 1000)) === true, JSON.stringify(await iconOf(favId)));
  await inActive("document.getElementById('empty').click()");
  await sleep(1200);
  check('a link to an empty (204) response doesn\'t take the favicon away', (await showsIcon(favId, '/fav/i.png', 1000)) === true, JSON.stringify(await iconOf(favId)));
  // A page that isn't a web page has no icon; coming back to the site brings its icon back.
  await app.evaluate(async () => { await global.__agent.browser.activeTab().webContents.loadURL('data:text/html,<title>plain</title>'); });
  await sleep(400);
  const dataIcon = await iconOf(favId);
  await app.evaluate(async (_e, url) => { await global.__agent.browser.activeTab().webContents.loadURL(url); }, `${base}/fav/first`);
  await sleep(500);
  check('a data: page shows no favicon, and going back to the site shows it again', dataIcon && !dataIcon.img && (await showsIcon(favId, '/fav/i.png', 1000)) === true, JSON.stringify({ dataIcon, back: await iconOf(favId) }));
  // Electron lists a page's icons alphabetically, not by preference: the first may be missing.
  const brokenId = await open(`${base}/fav/broken`);
  check('a missing icon listed first falls through to the page\'s good one', (await showsIcon(brokenId, '/fav/good.png')) === true, JSON.stringify(await iconOf(brokenId)));
  // An icon that failed once (a server error) is tried again rather than left a globe for good.
  // (On localhost, a host visited once: the new-tab page's icon cache doesn't fetch it first.)
  const flakyId = await open(`http://localhost:${server.address().port}/fav/flaky`);
  check('an icon that failed to load once is retried', (await showsIcon(flakyId, '/fav/flaky.png', 6000)) === true, JSON.stringify(await iconOf(flakyId)));
  // A page visited once (so the new-tab page's icon cache doesn't keep a copy), left in the
  // background for the restart below (section 8).
  const onceId = await open(`http://localhost:${server.address().port}/fav/once`);
  await showsIcon(onceId, '/fav/i.png');
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), pageTabs[pageTabs.length - 1].id);

  // ---- 8. restart: only the active tab loads; pinned tabs stay pinned ----
  const activeUrl = await app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL());
  await sleep(3500); // session save
  await app.close();
  app = await launch();
  ui = await app.firstWindow();
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await waitFor(async () => (await strip()).length >= 20 && Boolean(await app.evaluate(() => global.__agent.browser.activeTab()?.webContents.getURL())), 5000);
  const restored = await strip();
  const loaded = restored.filter((t) => !t.sleeping);
  check('after a restart only the active tab loads', loaded.length === 1 && restored.length >= 20, `${loaded.length} loaded of ${restored.length}`);
  check('the pinned tab comes back pinned, at the front', restored[0].pinned && restored.filter((t) => t.pinned).length === 1, JSON.stringify(restored.slice(0, 2)));
  const titles = await ui.evaluate(() => [...document.querySelectorAll('#tabs .tab')].slice(0, 6).map((t) => t.getAttribute('aria-label'))); // tabs have no title tooltip: the hover card shows it
  check('restored tabs show their titles before loading', titles.filter((t) => /^Page \//.test(t)).length >= 3, JSON.stringify(titles));
  const activeAgain = await app.evaluate(() => global.__agent.browser.activeTab()?.webContents.getURL());
  check('the tab that was active is active again', loaded[0] && activeAgain === activeUrl, `${activeAgain} vs ${activeUrl}`);
  const sleeper = restored.find((t) => t.sleeping && !t.pinned);
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), sleeper.id);
  await waitFor(async () => /\/(p|q)\d+$/.test((await app.evaluate(() => global.__agent.browser.activeTab()?.webContents.getURL())) || ''), 5000);
  const woke = await app.evaluate(() => global.__agent.browser.activeTab()?.webContents.getURL());
  check('opening a restored tab loads it', /\/(p|q)\d+$/.test(woke || ''), woke);
  // A restored tab that hasn't loaded yet shows the icon it had (from the saved session), not a globe.
  const favTab = (await app.evaluate(() => global.__agent.browser.listTabs())).find((t) => t.url.endsWith('/fav/once'));
  check('a restored, not yet loaded tab shows its favicon', favTab && (await showsIcon(favTab.id, `localhost:${server.address().port}/fav/i.png`)) === true, JSON.stringify(favTab && await iconOf(favTab.id)));

  // ---- 9. a sleeping tab keeps its back/forward history ----
  await open(`${base}/h1`);
  await app.evaluate(async (_e, url) => { const wc = global.__agent.browser.activeTab().webContents; await wc.loadURL(url); }, `${base}/h2`);
  const hid = await app.evaluate(() => global.__agent.browser.activeTab().id);
  await open(`${base}/other`);
  await app.evaluate((_e, id) => global.__tabSleep.sleep(id), hid);
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), hid);
  await waitFor(() => app.evaluate(() => { const wc = global.__agent.browser.activeTab().webContents; return wc.getURL().endsWith('/h2') && wc.navigationHistory.canGoBack(); }), 5000);
  const nav = await app.evaluate(() => { const wc = global.__agent.browser.activeTab().webContents; return { url: wc.getURL(), back: wc.navigationHistory.canGoBack() }; });
  check('a woken tab can still go back', nav.url.endsWith('/h2') && nav.back, JSON.stringify(nav));

  // ---- 10. under memory pressure a background tab sleeps after minutes, not 20 minutes ----
  // Performance mode (auto-on for a throttled laptop) sleeps tabs after 5 minutes and keeps only 4 background tabs live: pin it off so the timing below is the normal mode's.
  await app.evaluate(() => global.__patchSettings({ performanceMode: 'off' }));
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
  await waitFor(() => app.evaluate(() => global.__agent.browser.activeTab().webContents.mainFrame.framesInSubtree.some((f) => f.url.includes('localhost'))));
  const frames = await app.evaluate(async () => {
    const wc = global.__agent.browser.activeTab().webContents;
    return Promise.all(wc.mainFrame.framesInSubtree.map(async (f) => ({ url: f.url, brands: await f.executeJavaScript('JSON.stringify(navigator.userAgentData?.brands.map((b) => b.brand) || [])') })));
  });
  const inner = frames.find((f) => f.url.includes('localhost'));
  check('a cross-site iframe says Google Chrome', inner && inner.brands.includes('Google Chrome'), JSON.stringify(frames));
  // The Sec-CH-UA header says the same thing as the page's JavaScript, on the page and the iframe.
  const jsBrands = await app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript('navigator.userAgentData.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(", ")'));
  check('Sec-CH-UA is sent, and matches the page, on the page and a cross-site iframe', seenHints['/xframe'] === jsBrands && seenHints['/frame'] === jsBrands && /Google Chrome/.test(jsBrands), JSON.stringify({ seenHints, jsBrands }));

  // ---- 12. the AI's research tabs open in their own empty session, not the user's profile ----
  await app.evaluate(({ session }, url) => session.defaultSession.cookies.set({ url, name: 'profile', value: 'secret' }), base);
  const control = await open(`${base}/plain-echo`);
  const controlTitle = await app.evaluate((_e, id) => global.__agent.browser.listTabs().find((t) => t.id === id)?.title, control);
  check('control: a normal tab sends the profile cookie', /profile=secret/.test(controlTitle || ''), controlTitle);
  await app.evaluate((_e, url) => { global.__agent.browser.research.begin('research-check', { urls: [url] })(); }, `${base}/echo`);
  const research = () => app.evaluate(({ webContents, session }, url) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === url);
    return wc ? { title: wc.getTitle(), isDefault: wc.session === session.defaultSession, persistent: wc.session.isPersistent() } : null;
  }, `${base}/echo`);
  await waitFor(async () => /^Cookie:/.test((await research())?.title || ''), 8000);
  const rs = await research();
  check('a research tab is not in the default session, and its session is memory only', rs && rs.isDefault === false && rs.persistent === false, JSON.stringify(rs));
  check('it sent none of the profile\'s cookies', rs && rs.title === 'Cookie: none', JSON.stringify(rs));
  const leaked = await app.evaluate(({ session }) => session.defaultSession.cookies.get({ name: 'fromresearch' }), null);
  check('what it set did not reach the profile', leaked.length === 0, JSON.stringify(leaked));
  // A link opened from a research tab stays in the research session (sharing the research cookie jar, never the profile's).
  await app.evaluate(({ webContents }, [from, to]) => webContents.getAllWebContents().find((w) => w.getURL() === from).executeJavaScript(`window.open(${JSON.stringify(to)}); 1`), [`${base}/echo`, `${base}/child`]);
  const child = () => app.evaluate(({ webContents, session }, url) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === url);
    return wc ? { title: wc.getTitle(), isDefault: wc.session === session.defaultSession } : null;
  }, `${base}/child`);
  await waitFor(async () => (await child())?.title, 8000);
  const cs = await child();
  check('a tab opened from a research tab stays in the research session', cs && cs.isDefault === false && !/profile=/.test(cs.title) && /fromresearch=1/.test(cs.title), JSON.stringify(cs));

  check('no renderer errors', errors.length === 0, errors.join('; '));
  server.close();
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true }); // ~10 MB per run otherwise left in the temp dir
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
