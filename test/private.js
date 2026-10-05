// Private windows, end to end (features/private-window.js, renderer/private.*): the UI and the new-tab
// page are in the user's language (locales/); a private tab gets the page settings, HTTPS-only, the error
// page and the ad blocker a normal tab has; favicons load through the private session; find in page, zoom,
// tab switching, moving and reopening work from the keyboard; downloads land in the Downloads folder and
// are listed in that window only, never in Lumen's downloads list; nothing survives the window.
// (test/windows.js covers the session, history, the AI's tools and restore; test/safe-browsing.js the
// Safe Browsing warning in a private tab.)
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = path.join(__dirname, '..');
const EN = JSON.parse(fs.readFileSync(path.join(root, 'src', 'locales', 'en.json'), 'utf8'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

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

  // ---- every private.* key the code and pages use is in en.json (no Electron)
  const missing = [];
  const scan = (file, pattern) => { const src = fs.readFileSync(path.join(root, file), 'utf8'); for (const m of src.matchAll(pattern)) if (!(m[1] in EN)) missing.push(`${file}: ${m[1]}`); };
  scan('src/features/private-window.js', /\bt\('((?:private|permission)\.[^'`]+)'/g);
  scan('src/renderer/private.js', /\btr?\('(private\.[^'`]+)'/g);
  for (const f of ['src/renderer/private.html', 'src/renderer/private-newtab.html']) scan(f, /data-i18n[a-z-]*="([^"]+)"/g);
  check('i18n: every private-window string is in locales/en.json', missing.length === 0, missing.join(', '));
  const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'private-newtab.html'), 'utf8');
  const stale = [...html.matchAll(/data-i18n="([^"]+)">([^<]+)</g)].filter(([, key, text]) => EN[key] !== text.trim()).map(([, key]) => key);
  check("i18n: the new-tab page's English fallbacks match en.json", stale.length === 0, stale.join(', '));

  // ---- the local "web"
  const iconRequests = [];
  const adRequests = [];
  const server = http.createServer((req, res) => {
    const page = (title, body = '', head = '') => `<!doctype html><title>${title}</title>${head}<body>${body}</body>`;
    const host = (req.headers.host || '').split(':')[0];
    if (req.url.startsWith('/pagead/')) { adRequests.push(req.url); res.setHeader('Content-Type', 'text/javascript'); return res.end('window.adLoaded = true;'); }
    if (req.url === '/icon.png') { iconRequests.push(req.headers.cookie || ''); res.setHeader('Content-Type', 'image/png'); return res.end(PNG); }
    if (req.url === '/file.txt') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="private-file.txt"' }); return res.end('a private download'); }
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/icon') {
      res.setHeader('Set-Cookie', 'pv=1; Path=/');
      return res.end(page('Icon page', '<p>needle one</p><p>needle two</p>', '<link rel="icon" href="/icon.png">'));
    }
    if (req.url === '/ads') return res.end(page('Ads', `<script src="http://pagead2.googlesyndication.com:${server.address().port}/pagead/js/adsbygoogle.js"></script>`));
    return res.end(page(`Page ${host}${req.url}`, `<p>${req.url}</p>`));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const deadUrl = `http://127.0.0.1:${closed.address().port}/nothing`;
  await new Promise((r) => closed.close(r)); // nothing listens there any more: the load fails

  // ---- a locale that overrides two private strings (the rest falls back to English)
  const localeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-private-locales-'));
  fs.copyFileSync(path.join(root, 'src', 'locales', 'en.json'), path.join(localeDir, 'en.json'));
  fs.writeFileSync(path.join(localeDir, 'xx.json'), JSON.stringify({ 'private.badge': 'Privé', 'private.newtab.title': 'Navigation privée' }));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-private-test-'));
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-private-dl-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_LOCALE: 'xx', LUMEN_LOCALES_DIR: localeDir };
  const app = await electron.launch({ args: [root, '--host-resolver-rules=MAP *.test 127.0.0.1, MAP pagead2.googlesyndication.com 127.0.0.1'], env });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const errors = [];

  // Helpers: the window's record, a tab's page, and real key presses (synthetic ones skip before-input-event).
  const win = () => app.evaluate(() => global.__private.list()[0] || null);
  const inTab = (index, js) => app.evaluate(({ webContents }, [i, c]) => webContents.fromId(global.__private.list()[0].tabs[i].contentsId).executeJavaScript(c, true), [index, js]);
  const press = (keyCode, modifiers = []) => app.evaluate(({ BrowserWindow }, [k, mods]) => {
    const wc = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('private.html')).webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods });
    wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods });
  }, [keyCode, modifiers]);
  const tabUrls = async () => (await win()).tabs.map((t) => t.url);
  const go = (index, url) => app.evaluate(({ webContents }, [i, u]) => { webContents.fromId(global.__private.list()[0].tabs[i].contentsId).loadURL(u).catch(() => {}); }, [index, url]);

  try {
    await app.evaluate((_e, dir) => global.__patchSettings({ downloadDir: dir, askWhereToSave: false, httpsOnly: true, fontSize: 20 }), dlDir);
    await app.evaluate(() => { global.__private.open(); });
    const pw = await waitFor(async () => app.windows().find((p) => p.url().includes('private.html')));
    pw.on('pageerror', (e) => errors.push(e.message));
    pw.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await pw.waitForSelector('#address');
    await waitFor(async () => (await win())?.tabs.length === 1);
    const { windowId } = await win();

    // ---- the window itself
    if (process.env.LUMEN_TEST_BACKGROUND) {
      const opacity = await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).getOpacity(), windowId);
      check('in background test runs the private window is invisible too', opacity === 0, opacity);
    }
    check('the badge is in the locale (xx)', (await pw.textContent('#badge')).trim() === 'Privé', await pw.textContent('#badge'));
    check('strings the locale lacks fall back to English', (await pw.getAttribute('#address', 'placeholder')) === EN['private.address.placeholder'] && (await pw.getAttribute('#new-tab', 'aria-label')) === EN['private.newTab.button'], await pw.getAttribute('#address', 'placeholder'));
    const h1 = await waitFor(() => inTab(0, "document.querySelector('h1').textContent").then((t) => t === 'Navigation privée' && t));
    check('the private new-tab page is in the locale', h1 === 'Navigation privée', await inTab(0, "document.querySelector('h1').textContent"));
    const listItems = await inTab(0, "[...document.querySelectorAll('li')].map((li) => li.textContent).join('|')");
    check('the new-tab page says what is and is not kept', listItems.includes(EN['private.newtab.history']) && listItems.includes(EN['private.newtab.downloads']), listItems);
    check('the window title says Private', /Private/.test(await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).getTitle(), windowId)));
    check('the tab strip doubles as the title bar (it can drag the window)', (await pw.evaluate(() => getComputedStyle(document.getElementById('strip')).webkitAppRegion || getComputedStyle(document.getElementById('strip')).getPropertyValue('-webkit-app-region'))) === 'drag');
    check('on the new-tab page the address box is empty and has no security badge', (await pw.inputValue('#address')) === '' && !(await pw.isVisible('#security svg')));

    // ---- page settings, the error page, HTTPS-only
    await go(0, deadUrl);
    const errorPage = await waitFor(async () => (await tabUrls())[0].includes('error.html') && (await tabUrls())[0]);
    check('a page that fails to load shows the error page, not a blank tab', Boolean(errorPage), (await tabUrls())[0]);
    await waitFor(async () => (await pw.inputValue('#address')) === deadUrl);
    check('...and the address box shows the address that failed', (await pw.inputValue('#address')) === deadUrl, await pw.inputValue('#address'));
    await go(0, `http://plain.test:${port}/`);
    const upgraded = await waitFor(async () => (await tabUrls())[0].includes('https-only.html') && (await tabUrls())[0], 10000);
    check('HTTPS-only applies in a private tab (no https version: its warning page)', Boolean(upgraded), (await tabUrls())[0]);
    await waitFor(() => inTab(0, "document.readyState === 'complete'"));
    await inTab(0, "document.getElementById('continue').click()");
    const through = await waitFor(async () => (await tabUrls())[0] === `http://plain.test:${port}/` && true, 8000);
    check('"Continue to site" goes through over http in the private tab', Boolean(through), (await tabUrls())[0]);
    await waitFor(() => pw.evaluate(() => document.getElementById('security').classList.contains('insecure')));
    check('an http page is marked Not secure in the address box', await pw.evaluate(() => document.getElementById('security').classList.contains('insecure') && document.getElementById('security').textContent.includes('Not secure')));
    await app.evaluate((_e, u) => { global.__agent.browser.activeTab().webContents.loadURL(u).catch(() => {}); }, `http://plain.test:${port}/normal`);
    const normalWarned = await waitFor(() => app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL()).then((u) => u.includes('https-only.html') && u), 10000);
    check("the private window's \"Continue\" is not remembered for normal tabs", Boolean(normalWarned), await app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL()));

    // ---- favicons come through the private session
    await go(0, `${base}/icon`);
    const favicon = await waitFor(async () => (await win()).tabs[0].favicon);
    check('the tab shows the page icon (as a data: URL the UI never fetches itself)', /^data:image\/png;base64,/.test(favicon || ''), favicon);
    check("the icon was fetched in the private session (with the private window's cookie)", iconRequests.some((c) => /pv=1/.test(c)), JSON.stringify(iconRequests));
    check('a private tab gets the page settings (the font size from Settings)', (await inTab(0, 'getComputedStyle(document.body).fontSize')) === '20px', await inTab(0, 'getComputedStyle(document.body).fontSize'));
    check('the strip draws it', await waitFor(() => pw.evaluate(() => /^data:image\/png/.test(document.querySelector('.tab.active .icon img')?.src || ''))));
    const defaultCookie = await app.evaluate(async ({ session }) => (await session.defaultSession.cookies.get({ name: 'pv' })).length);
    check('nothing reached the normal profile', defaultCookie === 0, defaultCookie);

    // ---- find in page
    await press('F', ['control']);
    await waitFor(() => pw.isVisible('#find'));
    check('Ctrl+F opens the find bar', await pw.isVisible('#find'));
    await pw.fill('#find-text', 'needle');
    const count = await waitFor(() => pw.textContent('#find-count').then((t) => /^1\/2$/.test(t.trim()) && t));
    check('it finds and counts matches on the page', Boolean(count), await pw.textContent('#find-count'));
    await pw.press('#find-text', 'Enter');
    const second = await waitFor(() => pw.textContent('#find-count').then((t) => /^2\/2$/.test(t.trim()) && t));
    check('Enter goes to the next match', Boolean(second), await pw.textContent('#find-count'));
    await pw.fill('#find-text', 'zzznotthere');
    const none = await waitFor(() => pw.textContent('#find-count').then((t) => t.trim() === EN['private.find.none'] && t));
    check('no match says so', Boolean(none), await pw.textContent('#find-count'));
    await pw.press('#find-text', 'Escape');
    check('Escape closes it', !(await pw.isVisible('#find')));

    // ---- zoom
    await press('=', ['control']);
    const zoomed = await waitFor(() => pw.isVisible('#zoom').then((v) => v && pw.textContent('#zoom')));
    check('Ctrl+= zooms the page and the address box shows the zoom', Boolean(zoomed) && /%$/.test(zoomed) && zoomed !== '100%', zoomed);
    await press('0', ['control']);
    check('Ctrl+0 puts it back', await waitFor(() => pw.isHidden('#zoom')));

    // ---- tabs: switch, move, reopen
    for (const p of ['/a', '/b', '/c']) await app.evaluate((_e, [id, u]) => global.__private.openTab(id, u), [windowId, `${base}${p}`]);
    await waitFor(async () => (await win()).tabs.length === 4 && (await tabUrls()).every((u) => u.startsWith('http')));
    await press('1', ['control']);
    check('Ctrl+1 goes to the first tab', await waitFor(async () => { const w = await win(); return w.activeId === w.tabs[0].id; }));
    await press('9', ['control']);
    check('Ctrl+9 goes to the last tab', await waitFor(async () => { const w = await win(); return w.activeId === w.tabs[3].id; }));
    await press('Tab', ['control']);
    check('Ctrl+Tab goes round to the first', await waitFor(async () => { const w = await win(); return w.activeId === w.tabs[0].id; }));
    // Drag the last tab to the front of the strip.
    await waitFor(() => pw.evaluate(() => document.querySelectorAll('.tab').length === 4));
    const boxes = await pw.evaluate(() => [...document.querySelectorAll('.tab')].map((el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left }; }));
    const lastId = (await win()).tabs[3].id;
    await pw.mouse.move(boxes[3].x, boxes[3].y);
    await pw.mouse.down();
    for (let i = 1; i <= 8; i++) await pw.mouse.move(boxes[3].x - ((boxes[3].x - boxes[0].left + 4) * i) / 8, boxes[3].y);
    await pw.mouse.up();
    check('dragging a tab along the strip moves it', await waitFor(async () => (await win()).tabs[0].id === lastId), JSON.stringify((await win()).tabs.map((t) => t.id)));
    check('the strip shows the new order', await waitFor(() => pw.evaluate((id) => document.querySelector('.tab').dataset.id === String(id), lastId)));
    check('...and the tab is the active one', (await win()).activeId === lastId);
    const shownBefore = await tabUrls();
    await press('W', ['control']);
    await waitFor(async () => (await win()).tabs.length === 3);
    check('a closed private tab is kept, in memory, for Ctrl+Shift+T', (await win()).closed.includes(`${base}/c`), JSON.stringify((await win()).closed));
    await press('T', ['control', 'shift']);
    const reopened = await waitFor(async () => (await tabUrls()).length === 4 && (await tabUrls())[0] === `${base}/c`);
    check('Ctrl+Shift+T reopens it where it was', Boolean(reopened), `${shownBefore.join(' ')} -> ${(await tabUrls()).join(' ')}`);
    const normalClosed = await app.evaluate(() => global.__settings.historyUrls());
    check('none of it is in history', !normalClosed.some((u) => u.startsWith(base) || u.includes('.test:')), normalClosed.join(' '));

    // ---- the ad blocker filters private tabs too
    const adReady = await waitFor(() => app.evaluate(() => global.__adblock.ready()), 60000);
    if (!adReady) console.log('SKIP  ad blocker in private tabs (its filter lists did not load: offline?)');
    else {
      adRequests.length = 0;
      await go(0, `${base}/ads`);
      await waitFor(async () => (await tabUrls())[0] === `${base}/ads` && (await inTab(0, "document.readyState === 'complete'")));
      await sleep(500);
      check('the ad blocker blocks ad scripts in a private tab', adRequests.length === 0 && (await inTab(0, 'Boolean(window.adLoaded)')) === false, JSON.stringify(adRequests));
    }

    // ---- downloads: into the Downloads folder, listed in this window only
    await go(0, `${base}/icon`);
    await waitFor(async () => (await tabUrls())[0] === `${base}/icon`);
    await app.evaluate(({ webContents }, u) => webContents.fromId(global.__private.list()[0].tabs[0].contentsId).downloadURL(u), `${base}/file.txt`);
    const done = await waitFor(async () => (await win()).downloads.find((d) => d.state === 'completed'), 10000);
    check('a private download completes', Boolean(done), JSON.stringify((await win()).downloads));
    check('...into the Downloads folder (no dialog)', Boolean(done) && fs.realpathSync(path.dirname(done.path)) === fs.realpathSync(dlDir), done?.path);
    check('...with its content', Boolean(done) && fs.readFileSync(done.path, 'utf8') === 'a private download');
    check('the window shows its downloads button', await waitFor(() => pw.isVisible('#downloads')));
    const menu = await app.evaluate((_e, id) => global.__private.downloadsMenu(id), windowId);
    check("the window's downloads menu lists it", menu.some((l) => String(l).startsWith('private-file.txt')), JSON.stringify(menu));
    const normalList = await app.evaluate(() => global.__downloads.list());
    check("it never enters Lumen's downloads list", !normalList.some((d) => d.name === 'private-file.txt'), JSON.stringify(normalList));

    // ---- macOS: with the private window in front, the menu bar acts on it, never on the normal window behind it
    if (process.platform === 'darwin') {
      const menuState = () => app.evaluate(({ Menu }, labels) => {
        const all = [];
        const walk = (items) => { for (const i of items) { all.push(i); if (i.submenu) walk(i.submenu.items); } };
        walk(Menu.getApplicationMenu().items);
        return Object.fromEntries(labels.map((l) => [l, all.find((i) => i.label === l)?.enabled ?? null]));
      }, [EN['menu.newTab'], EN['menu.showAllHistory'], EN['menu.toggleSidebar']]);
      // Background test windows never take focus: stand in for it (the menu is rebuilt when a window gains focus).
      await app.evaluate(({ BrowserWindow }, id) => {
        global.__realFocused = BrowserWindow.getFocusedWindow;
        BrowserWindow.getFocusedWindow = () => BrowserWindow.fromId(id);
        BrowserWindow.fromId(id).emit('focus');
      }, windowId);
      const greyed = await waitFor(async () => { const m = await menuState(); return m[EN['menu.showAllHistory']] === false && m; });
      check('menu bar: commands a private window lacks (History, the AI sidebar) are greyed out', Boolean(greyed) && greyed[EN['menu.toggleSidebar']] === false && greyed[EN['menu.newTab']] === true, JSON.stringify(await menuState()));
      const before = { priv: (await win()).tabs.length, normal: (await app.evaluate(() => global.__settings.tabs().length)) };
      const clickItem = (label) => app.evaluate(({ Menu }, l) => {
        const find = (items) => { for (const i of items) { if (i.label === l) return i; const sub = i.submenu && find(i.submenu.items); if (sub) return sub; } return null; };
        find(Menu.getApplicationMenu().items).click();
      }, label);
      await clickItem(EN['menu.newTab']);
      await waitFor(async () => (await win()).tabs.length === before.priv + 1);
      const afterNew = { priv: (await win()).tabs.length, normal: (await app.evaluate(() => global.__settings.tabs().length)) };
      check('menu bar: File > New Tab opens a private tab in the private window', afterNew.priv === before.priv + 1 && afterNew.normal === before.normal, JSON.stringify({ before, afterNew }));
      await clickItem(EN['menu.closeTab']);
      await waitFor(async () => (await win()).tabs.length === before.priv);
      const afterClose = { priv: (await win()).tabs.length, normal: (await app.evaluate(() => global.__settings.tabs().length)) };
      check('menu bar: File > Close Tab closes the private tab, not a normal one', afterClose.priv === before.priv && afterClose.normal === before.normal, JSON.stringify({ before, afterClose }));
      await app.evaluate(({ BrowserWindow }, id) => { BrowserWindow.getFocusedWindow = global.__realFocused; BrowserWindow.fromId(id).emit('blur'); }, windowId);
      check('menu bar: with it gone from the front, the normal commands come back', Boolean(await waitFor(async () => (await menuState())[EN['menu.showAllHistory']] === true)), JSON.stringify(await menuState()));
    }

    // ---- closing the window: nothing kept
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), windowId);
    check('the window closes', await waitFor(() => app.evaluate(() => global.__private.count() === 0)));
    await sleep(800); // downloads.json is written half a second after a change
    const saved = fs.existsSync(path.join(profile, 'downloads.json')) ? fs.readFileSync(path.join(profile, 'downloads.json'), 'utf8') : '';
    check('the download is not in downloads.json', !saved.includes('private-file.txt'), saved.slice(0, 200));
    const settingsText = fs.readFileSync(path.join(profile, 'settings.json'), 'utf8');
    check('settings.json mentions none of the private pages', !settingsText.includes(`127.0.0.1:${port}`) && !settingsText.includes(`plain.test:${port}/"`), settingsText.slice(0, 300)); // (plain.test/normal was a normal tab)
    check('the downloaded file itself is kept', fs.existsSync(path.join(dlDir, 'private-file.txt')));
    check('no errors in the private UI', errors.length === 0, errors.join(' | '));
  } finally {
    await app.close();
    server.close();
    for (const dir of [profile, dlDir, localeDir]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
