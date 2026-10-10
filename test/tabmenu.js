// The tab's right-click menu and the tab keyboard shortcuts, as in Chrome: New Tab to the Right,
// Reload, Duplicate (with its back/forward list), Pin, Mute Site, Copy Link, Bookmark Tab, Bookmark
// All Tabs, Close Tab / Other Tabs / Tabs to the Right (pinned tabs stay, "Leave site?" is asked),
// Reopen Closed Tab; Cmd+Option+Arrows, Cmd+Shift+[ ], Ctrl+PageUp/Down, Cmd+1…9, Cmd+Shift+R and
// Cmd+Shift+D; and the macOS menu bar's Tab menu. The menu is a native one, so the tests build its
// template (global.__tabMenu) and click its items rather than popping it up.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(50); } return false; };

  const hits = {}; // requests by path, with the Cache-Control each one was sent with
  const server = http.createServer((req, res) => {
    (hits[req.url] ||= []).push(req.headers['cache-control'] || '');
    res.setHeader('Content-Type', 'text/html');
    // A page that objects to being closed (once it has had a user gesture, as Chromium requires).
    if (req.url === '/leave') return res.end('<title>leave</title><script>onbeforeunload = (e) => { e.preventDefault(); e.returnValue = ""; };</script>');
    res.end(`<title>Page ${req.url}</title><p>${req.url}</p>`);
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const other = `http://localhost:${server.address().port}`; // another site, for Mute Site
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-tabmenu-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile } });
  // Playwright answers a page's own dialogs by itself unless someone listens; the "Leave site?" one
  // below is Lumen's to ask (will-prevent-unload), so every page gets a listener that leaves it be.
  const quiet = (page) => page.on('dialog', () => {});
  app.on('window', quiet);
  const ui = await app.firstWindow();
  app.windows().forEach(quiet);
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  // Copy Link must not touch the real clipboard of whoever runs the tests.
  await app.evaluate(({ clipboard }) => { global.__copied = null; clipboard.writeText = (text) => { global.__copied = text; }; });
  await app.evaluate(() => global.__patchSettings({ bookmarks: [] }));

  const open = (url, background = false) => app.evaluate(async (_e, { url, background }) => {
    const t = global.__agent.browser.openTab(url, { background });
    await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); });
    return t.id;
  }, { url, background });
  const list = () => app.evaluate(() => global.__agent.browser.listTabs());
  const strip = () => app.evaluate(() => global.__tabsArray());
  const ids = async () => (await strip()).map((t) => t.id);
  const activeId = async () => (await list()).find((t) => t.active)?.id;
  const urlOf = async (id) => (await list()).find((t) => t.id === id)?.url ?? null;
  const menu = (id, label) => app.evaluate((_e, { id, label }) => global.__tabMenu(id, label), { id, label });
  const labels = async (id) => (await menu(id)).map((i) => i.label);
  const enabled = async (id, label) => (await menu(id)).find((i) => i.label === label)?.enabled;
  const key = (input) => app.evaluate((_e, input) => global.__pageTools.handleShortcut(input), input);
  const mac = process.platform === 'darwin';
  const cmd = mac ? { meta: true } : { control: true };
  const loaded = (id) => app.evaluate((_e, id) => new Promise((r) => {
    const wc = global.__pageTools.tab(id)?.view?.webContents;
    if (!wc || !wc.isLoading()) return r();
    wc.once('did-stop-loading', r);
    setTimeout(r, 5000);
  }), id);
  const closeAllBut = async (keep) => {
    for (const id of await ids()) if (!keep.includes(id)) await app.evaluate((_e, id) => global.__closeTabInteractive(id), id);
    await waitFor(async () => (await ids()).length === keep.length);
  };

  const first = (await ids())[0];
  const a = await open(`${base}/a`);
  const b = await open(`${base}/b`);
  const c = await open(`${base}/c`);

  // ---- 1. the items, in Chrome's order ----
  const want = ['New tab to the right', 'Add to new group', 'Reload', 'Duplicate', 'Pin tab', 'Mute site', 'Copy link', 'Bookmark tab', 'Bookmark all tabs', 'Close tab', 'Close other tabs', 'Close tabs to the right', 'Reopen closed tab'];
  const got = await labels(a);
  const positions = want.map((l) => got.indexOf(l));
  check("the tab menu has Chrome's items, in Chrome's order", positions.every((p, i) => p !== -1 && (i === 0 || p > positions[i - 1])), JSON.stringify(got));
  check('Close Tabs to the Right is off on the last tab', (await enabled(c, 'Close tabs to the right')) === false && (await enabled(a, 'Close tabs to the right')) === true, 'enabled states');
  check('Copy Link and Bookmark Tab are off on the new-tab page', (await enabled(first, 'Copy link')) === false && (await enabled(first, 'Bookmark tab')) === false, 'enabled on the new-tab page');

  // ---- 2. New Tab to the Right ----
  await menu(a, 'New tab to the right');
  let order = await ids();
  const fresh = order[order.indexOf(a) + 1];
  check('New Tab to the Right opens right after the tab', ![first, a, b, c].includes(fresh) && order.length === 5, JSON.stringify(order));
  check('…and shows it', (await activeId()) === fresh, `active ${await activeId()}`);
  await closeAllBut([first, a, b, c]);

  // In a group, the new tab joins the group.
  const group = await app.evaluate((_e, ids) => { const g = global.__tabGroups.create('G', ids); global.__tabGroups.arrange(); return g.id; }, [a, b]);
  await menu(a, 'New tab to the right');
  let tabs = await strip();
  const inGroup = tabs[tabs.findIndex((t) => t.id === a) + 1];
  check('New Tab to the Right from a grouped tab joins its group', inGroup && ![a, b].includes(inGroup.id) && inGroup.groupId === group, JSON.stringify(tabs));
  await closeAllBut([first, a, b, c]);

  // ---- 3. Duplicate: same page, same back/forward, right after, in the group, shown ----
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), b);
  await app.evaluate(async (_e, url) => { const wc = global.__agent.browser.activeTab().webContents; await wc.loadURL(url); }, `${base}/b2`);
  const bActive = await activeId();
  const bNow = await urlOf(bActive);
  check('(setup) tab b went on to /b2', bActive === b && bNow === `${base}/b2`, `${bActive} ${bNow}`);
  await menu(b, 'Duplicate');
  order = await ids();
  const dup = order[order.indexOf(b) + 1];
  await loaded(dup);
  check('Duplicate opens right after the original', ![first, a, b, c].includes(dup), JSON.stringify(order));
  check('…on the same page', (await urlOf(dup)) === `${base}/b2`, await urlOf(dup));
  check('…and shows it', (await activeId()) === dup, `active ${await activeId()}`);
  const nav = await app.evaluate((_e, id) => { const n = global.__pageTools.tab(id).view.webContents.navigationHistory; return { urls: n.getAllEntries().map((e) => e.url), index: n.getActiveIndex(), back: n.canGoBack() }; }, dup);
  check('…with its back/forward list', nav.back && nav.index === 1 && nav.urls.join() === `${base}/b,${base}/b2`, JSON.stringify(nav));
  check('…in the same group', (await strip()).find((t) => t.id === dup)?.groupId === group, JSON.stringify(await strip()));
  await closeAllBut([first, a, b, c]);
  await app.evaluate((_e, g) => global.__tabGroups.ungroupAll(g), group);

  // A sleeping tab duplicates from its snapshot.
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), c);
  await app.evaluate((_e, id) => global.__tabSleep.sleep(id), b);
  await menu(b, 'Duplicate');
  order = await ids();
  const dupSleep = order[order.indexOf(b) + 1];
  await loaded(dupSleep);
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), b); // wakes it again for the tests below
  await loaded(b);
  check('Duplicate works on a sleeping tab', ![first, a, b, c].includes(dupSleep) && (await urlOf(dupSleep)) === `${base}/b2`, `${JSON.stringify(order)} ${await urlOf(dupSleep)}`);
  await closeAllBut([first, a, b, c]);

  // The settings tab isn't duplicated (there is only ever one).
  const settingsId = await app.evaluate(() => global.__settings.open());
  check('Duplicate is off on the settings tab', (await enabled(settingsId, 'Duplicate')) === false, 'enabled');
  await closeAllBut([first, a, b, c]);

  // ---- 4. Pin, and a pinned tab's menu ----
  await menu(c, 'Pin tab');
  tabs = await strip();
  check('Pin Tab pins it (first in the strip)', tabs[0].id === c && tabs[0].pinned, JSON.stringify(tabs));
  check('a pinned tab offers Unpin Tab and no group items', (await labels(c)).includes('Unpin tab') && !(await labels(c)).includes('Add to new group'), JSON.stringify(await labels(c)));
  await menu(c, 'Duplicate');
  tabs = await strip();
  check('Duplicate of a pinned tab is pinned, right after it', tabs[1]?.pinned && tabs[1].id !== c && tabs[0].id === c, JSON.stringify(tabs));
  await closeAllBut([first, a, b, c]);
  await menu(c, 'New tab to the right');
  tabs = await strip();
  check('New Tab to the Right from a pinned tab goes after the pinned tabs, unpinned', tabs[1] && !tabs[1].pinned && ![first, a, b].includes(tabs[1].id), JSON.stringify(tabs));
  await closeAllBut([first, a, b, c]);

  // ---- 5. Reload, and Force Reload (Cmd+Shift+R) past the cache ----
  let before = (hits['/a'] || []).length;
  await menu(a, 'Reload');
  check('Reload reloads the tab (even one in the background)', await waitFor(() => (hits['/a'] || []).length === before + 1), JSON.stringify(hits['/a']));
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), a);
  await loaded(a);
  before = hits['/a'].length;
  await key({ key: 'r', ...cmd });
  await waitFor(() => hits['/a'].length === before + 1);
  await loaded(a);
  check('Cmd+R reloads normally', hits['/a'].length === before + 1 && hits['/a'].at(-1) !== 'no-cache', JSON.stringify(hits['/a']));
  await key({ key: 'R', shift: true, ...cmd });
  await waitFor(() => hits['/a'].length === before + 2);
  check('Cmd+Shift+R reloads past the cache', hits['/a'].at(-1) === 'no-cache', JSON.stringify(hits['/a']));
  await loaded(a);

  // ---- 6. Mute Site: every tab of the site, now and opened later, until unmuted ----
  const muted = (id) => app.evaluate((_e, id) => global.__pageTools.tab(id).view.webContents.isAudioMuted(), id);
  await menu(a, 'Mute site');
  check('Mute Site mutes the tabs of that site', (await muted(a)) && (await muted(b)), 'not muted');
  const later = await open(`${base}/later`, true);
  const elsewhere = await open(`${other}/x`, true);
  check('…and a tab of that site opened later', await muted(later), 'not muted');
  check('…but not another site', !(await muted(elsewhere)), 'muted');
  check('the menu then offers Unmute Site', (await labels(b)).includes('Unmute site'), JSON.stringify(await labels(b)));
  await menu(b, 'Unmute site');
  check('Unmute Site unmutes them', !(await muted(a)) && !(await muted(later)), 'still muted');
  await closeAllBut([first, a, b, c]);

  // ---- 7. Copy Link, Bookmark Tab, Bookmark All Tabs ----
  await menu(b, 'Copy link');
  check("Copy Link copies the tab's URL", (await app.evaluate(() => global.__copied)) === `${base}/b2`, await app.evaluate(() => global.__copied));
  const saved = () => app.evaluate(() => global.__managers.managers.list());
  await menu(a, 'Bookmark tab');
  check('Bookmark Tab bookmarks that tab (not the one in front)', (await saved()).some((x) => x.url === `${base}/a` && !x.folder), JSON.stringify(await saved()));
  check('…and the menu then offers Remove Bookmark', (await labels(a)).includes('Remove bookmark'), JSON.stringify(await labels(a)));
  await menu(a, 'Remove bookmark');
  check('Remove Bookmark removes it', !(await saved()).some((x) => x.url === `${base}/a`), JSON.stringify(await saved()));
  await menu(a, 'Bookmark all tabs');
  let folders = [...new Set((await saved()).map((x) => x.folder).filter(Boolean))];
  const inFolder = (await saved()).filter((x) => x.folder === folders[0]).map((x) => x.url);
  check('Bookmark All Tabs puts every web tab in a new folder', folders.length === 1 && /^Saved Tabs /.test(folders[0]) && inFolder.join() === [`${base}/c`, `${base}/a`, `${base}/b2`].join(), `${JSON.stringify(folders)} ${JSON.stringify(inFolder)}`);
  await key({ key: 'd', shift: true, ...cmd });
  folders = [...new Set((await saved()).map((x) => x.folder).filter(Boolean))];
  check('Cmd+Shift+D does it again, into a second folder', folders.length === 2 && folders[1] === `${folders[0]} (2)`, JSON.stringify(folders));

  // ---- 8. Close Tabs to the Right / Close Other Tabs (pinned stay), Reopen Closed Tab ----
  // Strip now: c (pinned), first, a, b.
  const r1 = await open(`${base}/r1`, true);
  const r2 = await open(`${base}/r2`);
  await menu(a, 'Close tabs to the right');
  await waitFor(async () => (await ids()).length === 4);
  check('Close Tabs to the Right closes the tabs after it', (await ids()).join() === [c, first, a].join(), JSON.stringify(await ids()));
  check('…and the tab it was opened on comes to the front', (await activeId()) === a, `active ${await activeId()}`);
  const closed = await app.evaluate(() => global.__closedTabs());
  check('…and they can be reopened', [`${base}/b2`, `${base}/r1`, `${base}/r2`].every((u) => closed.includes(u)), JSON.stringify(closed));
  await menu(a, 'Reopen closed tab');
  check('Reopen Closed Tab reopens the last one closed', await waitFor(async () => (await list()).some((t) => t.url === closed.at(-1) && t.active)), JSON.stringify(await list()));
  check('(r1, r2 were distinct tabs)', r1 !== r2, 'same');

  const leave = await open(`${base}/leave`, true);
  await app.evaluate((_e, id) => global.__pageTools.tab(id).view.webContents.executeJavaScript('1', true), leave); // a user gesture
  const keepA = await open(`${base}/keep`, true);
  await menu(keepA, 'Close other tabs');
  check('Close Other Tabs keeps pinned tabs', await waitFor(async () => (await ids()).join() === [c, leave, keepA].join() || (await ids()).join() === [c, keepA].join()), JSON.stringify(await ids()));
  check('…and asks "Leave site?" for a page that objects', await waitFor(async () => (await ids()).includes(leave) && app.evaluate(() => Boolean(global.__dialogs.currentId())), 3000), JSON.stringify(await ids()));
  await app.evaluate(() => { const d = global.__dialogs; d.respond({ id: d.currentId(), response: 1 }); });
  check('…and closes it on Leave', await waitFor(async () => (await ids()).join() === [c, keepA].join(), 4000), JSON.stringify(await ids()));
  check('…and the kept tab is in front', (await activeId()) === keepA, `active ${await activeId()}`);
  check('Close Other Tabs is off when only pinned tabs are left', (await enabled(keepA, 'Close other tabs')) === false, 'enabled');

  // ---- 9. shortcuts ----
  const t1 = await open(`${base}/t1`, true);
  const t2 = await open(`${base}/t2`, true);
  const t3 = await open(`${base}/t3`, true);
  // Strip: c (pinned), keepA, t1, t2, t3.
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), keepA);
  if (mac) {
    await key({ key: 'ArrowRight', meta: true, alt: true });
    check('Cmd+Option+Right selects the next tab', (await activeId()) === t1, `active ${await activeId()}`);
    await key({ key: 'ArrowLeft', meta: true, alt: true });
    check('Cmd+Option+Left selects the previous tab', (await activeId()) === keepA, `active ${await activeId()}`);
    await key({ key: '}', meta: true, shift: true });
    check('Cmd+Shift+] selects the next tab', (await activeId()) === t1, `active ${await activeId()}`);
    await key({ key: '{', meta: true, shift: true });
    check('Cmd+Shift+[ selects the previous tab', (await activeId()) === keepA, `active ${await activeId()}`);
    // The real path: the key pressed in the page itself.
    await app.evaluate((_e, id) => {
      const wc = global.__pageTools.tab(id).view.webContents;
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Right', modifiers: ['meta', 'alt'] });
    }, keepA);
    check('Cmd+Option+Right typed in a page selects the next tab', await waitFor(async () => (await activeId()) === t1), `active ${await activeId()}`);
    await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), keepA);
  }
  await key({ key: 'PageDown', control: true });
  check('Ctrl+PageDown selects the next tab', (await activeId()) === t1, `active ${await activeId()}`);
  await key({ key: 'PageUp', control: true });
  check('Ctrl+PageUp selects the previous tab', (await activeId()) === keepA, `active ${await activeId()}`);
  await key({ key: '9', ...cmd });
  check('Cmd+9 selects the last tab', (await activeId()) === t3, `active ${await activeId()}`);
  await key({ key: '2', ...cmd });
  check('Cmd+2 selects the second tab', (await activeId()) === keepA, `active ${await activeId()}`);
  await key({ key: 'PageDown', shift: true, ...cmd });
  check('Cmd+Shift+PageDown moves the tab right', (await ids()).join() === [c, t1, keepA, t2, t3].join(), JSON.stringify(await ids()));
  await key({ key: 'PageUp', shift: true, ...cmd });
  check('Cmd+Shift+PageUp moves it back left', (await ids()).join() === [c, keepA, t1, t2, t3].join(), JSON.stringify(await ids()));
  await key({ key: 'w', ...cmd });
  await waitFor(async () => !(await ids()).includes(keepA));
  await key({ key: 'T', shift: true, ...cmd });
  check('Cmd+Shift+T reopens the tab just closed', await waitFor(async () => (await list()).some((t) => t.url === `${base}/keep` && t.active)), JSON.stringify(await list()));

  // ---- 10. the macOS menu bar ----
  if (mac) {
    const bar = await app.evaluate(() => global.__macMenuLabels());
    const sub = (label) => bar.find((m) => m.label === label)?.items || [];
    check('the menu bar has a Tab menu with Select Next/Previous Tab and Duplicate Tab', ['Select next tab', 'Select previous tab', 'New tab to the right', 'Duplicate tab'].every((l) => sub('Tab').includes(l)), JSON.stringify(sub('Tab')));
    check('View has Force Reload This Page', sub('View').includes('Force reload this page'), JSON.stringify(sub('View')));
    check('Bookmarks has Bookmark All Tabs', sub('Bookmarks').includes('Bookmark all tabs'), JSON.stringify(sub('Bookmarks')));
  }

  check('no renderer errors', errors.length === 0, errors.join('; '));
  server.close();
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
