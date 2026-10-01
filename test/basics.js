// Browser basics in a real Lumen: Ctrl+N opens a normal window (and Ctrl+Shift+W closes it), the
// page's right-click menu has the link and image items (Open Link in New Window opens one), the lock's
// page info reads and changes the site's permissions and clears its cookies, Ctrl+Shift+/ shows the
// Keyboard Shortcuts sheet, Esc stops a page that is still loading, a zoom picked by hand comes back
// after a restart, and after a crash with "Open the new-tab page" at startup Lumen offers the old tabs
// (and a normal quit leaves nothing to offer). Throwaway profiles; run with LUMEN_TEST_BACKGROUND=1.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const waitFor = async (fn, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn().catch(() => null);
      if (v || Date.now() > end) return v;
      await sleep(100);
    }
  };

  const held = [];
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/cookie') {
      res.setHeader('Set-Cookie', ['a=1; Max-Age=3600; Path=/', 'b=2; Max-Age=3600; Path=/']);
      return res.end('<!doctype html><title>Cookie</title><p>cookies</p>');
    }
    if (req.url === '/slow') { res.write('<!doctype html><title>Slow</title><p>still loading'); held.push(res); return undefined; } // never ends
    if (req.url === '/links') return res.end('<!doctype html><title>Links</title><a id="l" href="/target">a link</a><img id="i" src="/pic.svg" width="40" height="40">');
    if (req.url === '/pic.svg') { res.setHeader('Content-Type', 'image/svg+xml'); return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>'); }
    return res.end(`<!doctype html><title>Page ${req.url}</title><p>${req.url}</p>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const profiles = [];
  const makeProfile = (settings, { crashed = false } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-basics-'));
    profiles.push(dir);
    if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
    if (crashed) fs.writeFileSync(path.join(dir, 'running'), '1');
    return dir;
  };
  const settingsOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')); } catch { return {}; } };
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-basics-dl-'));
  profiles.push(downloads);

  async function launch(profile) {
    const app = await electron.launch({ args: [root], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate((_e, dir) => global.__patchSettings({ downloadDir: dir }), downloads); // never the real Downloads folder
    return { app, ui };
  }
  // Real key events (Playwright's synthetic keys skip before-input-event), sent to the main window's UI.
  const press = (app, keyCode, modifiers = []) => app.evaluate(({ BrowserWindow }, [k, mods]) => {
    const wc = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html')).webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods });
    wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods });
  }, [keyCode, modifiers]);
  const mod = process.platform === 'darwin' ? 'meta' : 'control';
  const windows = (app) => app.evaluate(() => global.__windows.list());
  const openIn = (app, url) => app.evaluate(async (_e, u) => {
    const t = global.__agent.browser.openTab(u);
    await new Promise((r) => { if (!t.webContents.isLoading()) r(); else t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); });
    return t.id;
  }, url);

  try {
    // ======== windows, menus, page info, shortcuts, Esc, zoom
    const profile = makeProfile(null);
    let { app } = await launch(profile);
    const known = new Set((await windows(app)).map((w) => w.windowId));
    const before = known.size;
    await press(app, 'N', [mod]);
    const two = await waitFor(async () => { const w = await windows(app); return w.length === before + 1 && w; });
    check('Ctrl+N opens a normal window', Boolean(two), JSON.stringify(await windows(app)));
    const fresh = await waitFor(async () => (await windows(app)).find((w) => !known.has(w.windowId) && w.tabs.some((x) => /newtab/.test(x.url || '')))); // (its tab comes once its UI has loaded)
    check('the new window has one new tab', fresh && fresh.tabs.length === 1 && /newtab/.test(fresh.tabs[0].url || ''), JSON.stringify(fresh));
    check('Ctrl+N does not open a private window', (await app.evaluate(() => global.__private.count())) === 0, '');
    await app.evaluate(() => global.__basics.closeCurrentWindow());
    check('Close Window (Ctrl+Shift+W) closes the window in front', Boolean(await waitFor(async () => (await windows(app)).length === before)), JSON.stringify(await windows(app)));

    // The page's right-click menu on a link and on an image.
    const linksTab = await openIn(app, `${base}/links`);
    await app.evaluate(() => { global.__menu = null; global.__captureContextMenu = (items) => { global.__menu = items; }; });
    const menuFor = (params) => app.evaluate((_e, [id, p]) => {
      const wc = global.__settings.contents(id);
      global.__menu = null;
      wc.emit('context-menu', { preventDefault() {} }, { x: 5, y: 5, selectionText: '', isEditable: false, mediaType: 'none', srcURL: '', linkURL: '', mediaFlags: {}, editFlags: {}, dictionarySuggestions: [], misspelledWord: '', frame: null, ...p });
      return (global.__menu || []).map((i) => i.label || i.role || i.type);
    }, [linksTab, params]);
    const onLink = await menuFor({ linkURL: `${base}/target` });
    check('link menu: Open Link in New Tab, New Window, Private Window, Save Link As, Copy Link',
      ['Open Link in New Tab', 'Open Link in New Window', 'Open Link in Private Window', 'Save Link As…', 'Copy Link'].every((l) => onLink.includes(l)), onLink.join(' | '));
    const onImage = await menuFor({ mediaType: 'image', srcURL: `${base}/pic.svg` });
    check('image menu: Save Image As, Copy Image, Copy Image Address', ['Save Image As…', 'Copy Image', 'Copy Image Address'].every((l) => onImage.includes(l)), onImage.join(' | '));
    const onPage = await menuFor({});
    check('page menu: Save Page As, Print and View Page Source, all localized', ['Save Page As…', 'Print…', 'View Page Source'].every((l) => onPage.includes(l)), onPage.join(' | '));
    await app.evaluate((_e, [id, url]) => {
      const wc = global.__settings.contents(id);
      wc.emit('context-menu', { preventDefault() {} }, { x: 5, y: 5, selectionText: '', isEditable: false, mediaType: 'none', srcURL: '', linkURL: url, mediaFlags: {}, editFlags: {}, dictionarySuggestions: [], misspelledWord: '', frame: null });
      global.__menu.find((i) => i.label === 'Open Link in New Window').click();
    }, [linksTab, `${base}/target`]);
    const withLink = await waitFor(async () => (await windows(app)).find((w) => w.tabs.some((t) => (t.url || '').endsWith('/target'))));
    check('Open Link in New Window opens the link in a new normal window', Boolean(withLink) && withLink.tabs.length === 1, JSON.stringify(await windows(app)));
    if (withLink) await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.close(), withLink.windowId);
    await waitFor(async () => (await windows(app)).length === before);
    await app.evaluate(() => { global.__captureContextMenu = null; });

    // Page info for a page with two cookies.
    const cookieTab = await openIn(app, `${base}/cookie`);
    await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), cookieTab);
    await app.evaluate(() => { global.__pageInfoNoPopup = true; });
    const info = async () => app.evaluate(async () => (await global.__basics.openPageInfo()).map((i) => ({ label: i.label || i.type, sub: (i.submenu || []).map((s) => `${s.checked ? '*' : ''}${s.label}`) })));
    let menu = await info();
    check('page info: the site, its (plain http) connection and its two cookies', menu[0].label === `127.0.0.1:${server.address().port}` && menu[1].label === 'Connection is not secure' && menu.some((i) => i.label === '2 cookies in use'), JSON.stringify(menu));
    check('page info: every permission starts at Ask', menu.filter((i) => /: Ask$|: Block \(default\)$/.test(i.label)).length === 4, menu.map((i) => i.label).join(' | '));
    await app.evaluate(async () => { const tpl = await global.__basics.openPageInfo(); tpl.find((i) => /^Location/.test(i.label || '')).submenu.find((s) => s.label === 'Block').click(); });
    const decided = await app.evaluate((_e, origin) => global.__settings.permissions.get(`${origin}|geolocation`), base);
    check('page info: Block saves a decision for the site', decided === false, String(decided));
    await sleep(400);
    check('page info: the decision is in settings.json, where Site permissions reads it', settingsOf(profile).sitePermissions?.[`${base}|geolocation`] === false, JSON.stringify(settingsOf(profile).sitePermissions));
    menu = await info();
    check('page info: the menu shows it next time', menu.some((i) => i.label === 'Location: Block'), menu.map((i) => i.label).join(' | '));
    const removed = await app.evaluate(({ session }, url) => global.__basics.pageInfo.clearSite(session.defaultSession, url, { ask: false }), `${base}/cookie`).catch((err) => `error ${err.message}`);
    const left = await app.evaluate(async ({ session }, url) => (await session.defaultSession.cookies.get({ url })).length, base);
    check('page info: Clear Cookies and Site Data removes the site\'s cookies', removed === 2 && left === 0, `${removed} removed, ${left} left`);

    // Settings → Privacy and security → Site data lists the site, and Remove clears it.
    await openIn(app, `${base}/cookie`);
    const sid = await app.evaluate(() => global.__settings.open('site-data'));
    const inSettings = (code) => app.evaluate((_e, [id, c]) => global.__settings.contents(id).executeJavaScript(c), [sid, code]);
    const listed = await waitFor(() => inSettings("[...document.querySelectorAll('#site-data .item')].map((i) => i.textContent)").then((l) => l && l.length && l));
    check('site data: the site is listed with its two cookies', Array.isArray(listed) && listed.some((l) => /^127\.0\.0\.1 · 2 cookies/.test(l)), JSON.stringify(listed));
    await inSettings("document.querySelector('#site-data .item[data-site=\"127.0.0.1\"] button').click()");
    const gone = await waitFor(async () => (await app.evaluate(async ({ session }, url) => (await session.defaultSession.cookies.get({ url })).length, base)) === 0);
    const after = await waitFor(() => inSettings("document.querySelector('#site-data')?.textContent || ''").then((t) => !t.includes('127.0.0.1') && (t || 'empty')));
    check('site data: Remove deletes the site\'s cookies and drops it from the list', Boolean(gone) && Boolean(after), String(after));
    await app.evaluate((_e, id) => global.__agent.browser.closeTab?.(id), sid).catch(() => {});

    // Keyboard Shortcuts sheet.
    await press(app, '/', [mod, 'shift']);
    const kind = await waitFor(() => app.evaluate(() => global.__dialogs.currentKind()));
    check('Ctrl+Shift+/ opens the Keyboard Shortcuts sheet', kind === 'notes', String(kind));
    const sheet = await waitFor(() => app.evaluate(async ({ webContents }) => {
      const view = webContents.getAllWebContents().find((w) => w.getURL().endsWith('dialog.html'));
      return view && view.executeJavaScript("({ message: document.getElementById('message').textContent, sections: [...document.querySelectorAll('#notes .release h3')].map((h) => h.textContent), keys: document.querySelectorAll('#notes li code').length, toggle: document.getElementById('checkbox-row').hidden })");
    }));
    check('the sheet lists its sections with the keys drawn as code', sheet && sheet.message === 'Keyboard Shortcuts' && sheet.sections.includes('Tabs and windows') && sheet.keys > 30 && sheet.toggle === true, JSON.stringify(sheet));
    await app.evaluate(() => global.__dialogs.respond({ id: global.__dialogs.currentId(), response: 0 }));
    await waitFor(async () => (await app.evaluate(() => global.__dialogs.currentKind())) === null);

    // Esc stops a page that is still loading.
    const slowTab = await app.evaluate((_e, u) => global.__agent.browser.openTab(u).id, `${base}/slow`);
    const loading = await waitFor(() => app.evaluate((_e, id) => { const wc = global.__settings.contents(id); return wc && wc.isLoading() && wc.getURL().endsWith('/slow'); }, slowTab));
    await app.evaluate((_e, id) => { const wc = global.__settings.contents(id); wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); }, slowTab);
    const stopped = await waitFor(() => app.evaluate((_e, id) => !global.__settings.contents(id).isLoading(), slowTab), 4000);
    check('Esc stops a page that is still loading', Boolean(loading) && Boolean(stopped), `loading ${loading}, stopped ${stopped}`);

    // A zoom picked by hand is remembered for the site.
    const zoomTab = await openIn(app, `${base}/zoomed`);
    await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), zoomTab);
    await app.evaluate(() => global.__pageTools.handleShortcut({ control: process.platform !== 'darwin', meta: process.platform === 'darwin', key: '=' }));
    await sleep(500);
    const host = `127.0.0.1:${server.address().port}`;
    check('zooming in remembers the level for the site', settingsOf(profile).siteZoom?.[host] === 0.5, JSON.stringify(settingsOf(profile).siteZoom));
    menu = await info();
    check('page info shows the remembered zoom', menu.some((i) => /^Zoom: 110%/.test(i.label)), menu.map((i) => i.label).join(' | '));
    await app.close();

    ({ app } = await launch(profile));
    const again = await openIn(app, `${base}/zoomed-again`);
    const level = await waitFor(() => app.evaluate((_e, id) => { const wc = global.__settings.contents(id); return wc && wc.getZoomLevel() === 0.5 ? 0.5 : null; }, again));
    check('after a restart the site opens at that zoom', level === 0.5, String(level));
    await app.evaluate(() => global.__pageTools.handleShortcut({ control: process.platform !== 'darwin', meta: process.platform === 'darwin', key: '0' }));
    await sleep(500);
    check('Actual Size forgets it', !(host in (settingsOf(profile).siteZoom || {})), JSON.stringify(settingsOf(profile).siteZoom));
    await app.close();
    check('a normal quit removes the crash marker', !fs.existsSync(path.join(profile, 'running')), '');

    // ======== crash recovery
    const session = { urls: [`${base}/one`, `${base}/two`], titles: ['One', 'Two'], active: 1 };
    const crashed = makeProfile({ startup: 'newtab', session }, { crashed: true });
    ({ app } = await launch(crashed));
    const offered = await waitFor(() => app.evaluate(() => global.__dialogs.currentKind()));
    const card = offered && await app.evaluate(async ({ webContents }) => {
      const view = webContents.getAllWebContents().find((w) => w.getURL().endsWith('dialog.html'));
      return view.executeJavaScript("({ message: document.getElementById('message').textContent, detail: document.getElementById('detail').textContent, buttons: [...document.querySelectorAll('#buttons button')].map((b) => b.textContent) })");
    });
    check('after a crash, with startup set to a new tab, Lumen offers the old tabs', card && /didn’t shut down correctly/.test(card.message) && /2 tabs/.test(card.detail) && card.buttons.join() === 'Not Now,Restore', JSON.stringify(card));
    await app.evaluate(() => global.__dialogs.respond({ id: global.__dialogs.currentId(), response: 1 }));
    const restored = await waitFor(async () => { const w = await windows(app); const urls = w[0]?.tabs.map((t) => t.url || '') || []; return urls.some((u) => u.endsWith('/one')) && urls.some((u) => u.endsWith('/two')) && w[0]; });
    check('Restore brings them back and drops the blank new tab', restored && restored.tabs.length === 2, JSON.stringify(await windows(app)));
    await app.close();
    ({ app } = await launch(crashed));
    await sleep(1500);
    check('after that clean quit, nothing is offered', (await app.evaluate(() => global.__dialogs.currentKind())) === null, '');
    await app.close();

    const notCrashed = makeProfile({ startup: 'newtab', session });
    ({ app } = await launch(notCrashed));
    await sleep(1500);
    check('without a crash, nothing is offered', (await app.evaluate(() => global.__dialogs.currentKind())) === null, '');
    await app.close();
  } catch (err) {
    failures++;
    console.log(`FAIL  basics suite threw: ${err.stack}`);
  } finally {
    for (const res of held) res.destroy();
    server.close();
    for (const dir of profiles) fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} failed` : '\nall basics passed');
  process.exit(failures ? 1 : 0);
})();
