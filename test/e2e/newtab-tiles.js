// New-tab page: a shortcut tile can be removed (the ⋮ button, right-click, or Delete on a focused tile), the removal survives a reload and a
// new tab, an Undo toast and "Restore all" (under Favorites and in the clock panel) bring tiles back, and a removed frequently-visited site
// is replaced by the next one and does not come back. A favorite stays a bookmark. Offline; a throwaway profile; LUMEN_TEST_BACKGROUND
// keeps the window off-screen. Screenshots go to LUMEN_SHOTS if set.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-nttiles-profile-'));
  const favs = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((n) => ({ url: `https://${n}.test/`, title: n[0].toUpperCase() + n.slice(1) }));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ sidebarNewChat: false, performanceMode: 'off', bookmarks: favs }));
  // Seven frequently visited hosts (the page shows six): removing one brings the seventh in.
  const now = Date.now();
  fs.writeFileSync(path.join(profile, 'history.json'), JSON.stringify(['one', 'two', 'three', 'four', 'five', 'six', 'seven'].map((n, i) => ({ url: `https://${n}.freq.test/`, title: n, visits: 20 - i, last: now - i }))));
  const shots = process.env.LUMEN_SHOTS; if (shots) fs.mkdirSync(shots, { recursive: true });
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const open = async () => {
      await app.evaluate(async () => { const t = global.__agent.browser.openTab(); await new Promise((r) => t.webContents.once('did-finish-load', r)); global.__home = t; });
      for (let i = 0; i < 80 && !(await home('document.querySelectorAll(".grid .cell").length > 0').catch(() => false)); i++) await sleep(100);
    };
    const home = (js) => app.evaluate((_e, c) => global.__home.webContents.executeJavaScript(c), js);
    const names = () => home('[...document.querySelectorAll(".grid .cell > a .name")].map((n) => n.textContent)');
    const freq = () => home('[...document.querySelectorAll(".frequent .cell > a .title")].map((n) => n.textContent)');
    const saved = async () => { await app.evaluate(() => global.__settingsFlush?.()); await sleep(200); return JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')); };
    const shot = async (name) => {
      if (!shots) return;
      const png = await app.evaluate(async () => (await global.__home.webContents.capturePage()).toPNG().toString('base64'));
      fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(png, 'base64'));
    };
    const toast = () => home('document.querySelector(".tiles-toast")?.textContent || ""');
    const bookmarkCount = async () => ((await saved()).bookmarks || []).length;

    await open();
    check('five favorites and six frequent tiles to start', (await names()).length === 5 && (await freq()).length === 6, `${await names()} / ${await freq()}`);
    check('every tile has a ⋮ button', (await home('document.querySelectorAll(".cell .tile-more").length')) === 11);
    check('the ⋮ button is hidden until hover or focus', (await home('getComputedStyle(document.querySelector(".cell .tile-more")).opacity')) === '0');
    await shot('tiles-before');

    // Hover shows the button (a real mouse move over the tile).
    const box = await home('(() => { const r = document.querySelector(".grid .cell").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
    await app.evaluate((_e, b) => { global.__home.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(b.x), y: Math.round(b.y) }); }, box);
    const opacity = () => home('getComputedStyle(document.querySelector(".grid .cell .tile-more")).opacity');
    for (let i = 0; i < 30 && (await opacity()) !== '1'; i++) await sleep(100); // (the fade is 120 ms; an off-screen page can be slow to run it)
    check('hovering a tile shows its ⋮ button', (await opacity()) === '1', await opacity());
    await shot('tiles-hover');

    // ⋮ -> Remove on the second favorite.
    await home('document.querySelectorAll(".grid .cell .tile-more")[1].click()');
    check('the ⋮ button opens a menu with Remove', (await home('[...document.querySelectorAll(".tile-menu [role=menuitem]")].map((b) => b.textContent)')).join() === 'Remove from this page');
    check('the menu\'s first item has focus', await home('document.activeElement === document.querySelector(".tile-menu button")'));
    await home('document.querySelector(".tile-menu button").click()');
    await sleep(300);
    check('Remove hides the favorite', (await names()).join() === 'Alpha,Charlie,Delta,Echo', await names());
    check('an Undo toast shows', /Removed Bravo/.test(await toast()) && (await home('!!document.querySelector(".tiles-toast button")')), await toast());
    const focusedAfter = () => home('document.activeElement === document.querySelectorAll(".grid .cell > a")[1]');
    for (let i = 0; i < 20 && !(await focusedAfter()); i++) await sleep(100); // (the grid redraws after the save round-trip; an off-screen page can be slow)
    check('focus moves to the tile that took its place', await focusedAfter(), await home('document.activeElement?.outerHTML?.slice(0, 120)'));
    check('the bookmark itself is kept', (await bookmarkCount()) === 5);
    check('the removal is saved', JSON.stringify((await saved()).newTabHiddenTiles?.favorites) === '["https://bravo.test/"]', JSON.stringify((await saved()).newTabHiddenTiles));
    check('Restore all shows under Favorites', /1 removed/.test(await home('document.querySelector(".tiles-restore")?.textContent || ""')));
    await shot('tiles-after-remove');

    // Reload the same tab, then a fresh new tab: still gone.
    await app.evaluate(async () => { global.__home.webContents.reload(); await new Promise((r) => global.__home.webContents.once('did-finish-load', r)); });
    await sleep(600);
    check('after a reload the tile is still gone', (await names()).join() === 'Alpha,Charlie,Delta,Echo', await names());
    await open();
    check('and in a new tab', (await names()).join() === 'Alpha,Charlie,Delta,Echo', await names());

    // Undo brings it back (in place): the toast belongs to the tab it was shown in, so remove Charlie here and undo that.
    await home('document.querySelectorAll(".grid .cell .tile-more")[1].click(); document.querySelector(".tile-menu button").click()');
    await sleep(300);
    check('Charlie is removed too', (await names()).join() === 'Alpha,Delta,Echo', await names());
    await home('document.querySelector(".tiles-toast button").click()');
    await sleep(300);
    check('Undo restores the tile where it was', (await names()).join() === 'Alpha,Charlie,Delta,Echo', await names());
    check('Undo is saved', JSON.stringify((await saved()).newTabHiddenTiles?.favorites) === '["https://bravo.test/"]');
    await home('document.querySelector(".tiles-restore-btn").click()');
    await sleep(300);
    check('Restore all clears the list', (await names()).length === 5 && (await saved()).newTabHiddenTiles?.favorites?.length === 0, await names());
    await open();
    check('a new tab shows all five after Restore all', (await names()).length === 5);

    // Right-click -> Remove on a frequently visited tile: the seventh takes its place, and the host stays out.
    await home('document.querySelectorAll(".frequent .cell")[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }))');
    await sleep(150);
    check('right-click opens the same menu', await home('!!document.querySelector(".tile-menu")'));
    await home('document.querySelector(".tile-menu button").click()');
    await sleep(300);
    const f = await freq();
    check('the next frequent site takes the removed one\'s place', f.length === 6 && !f.includes('one') && f.includes('seven'), f);
    check('the blocklist keeps the host', JSON.stringify((await saved()).newTabHiddenTiles?.frequent) === '["one.freq.test"]', JSON.stringify((await saved()).newTabHiddenTiles));
    await open();
    check('a removed frequent site does not come back', !(await freq()).includes('one'), await freq());

    // Escape closes the menu and returns focus to the button.
    await home('document.querySelectorAll(".grid .cell .tile-more")[0].focus(); document.querySelectorAll(".grid .cell .tile-more")[0].click()');
    await home('document.querySelector(".tile-menu").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    check('Escape closes the menu and focus goes back to ⋮', await home('!document.querySelector(".tile-menu") && document.activeElement === document.querySelectorAll(".grid .cell .tile-more")[0]'));

    // Delete on a focused tile.
    await home('document.querySelectorAll(".grid .cell > a")[2].focus()');
    await home('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }))');
    await sleep(300);
    check('Delete removes the focused tile', (await names()).join() === 'Alpha,Bravo,Delta,Echo', await names());
    check('the buttons are keyboard-focusable', await home('document.querySelector(".tile-more").tabIndex === 0'));

    // Restore all (under Favorites): both kinds come back; Undo of that puts them away again.
    check('Restore all counts both lists', /2 removed/.test(await home('document.querySelector(".tiles-restore")?.textContent || ""')), await home('document.querySelector(".tiles-restore")?.textContent'));
    await home('document.querySelector(".tiles-restore-btn").click()');
    await sleep(300);
    check('Restore all brings every tile back', (await names()).length === 5 && (await freq()).includes('one'), `${await names()} / ${await freq()}`);
    check('Restore all is saved', (await saved()).newTabHiddenTiles?.favorites?.length === 0 && (await saved()).newTabHiddenTiles?.frequent?.length === 0);
    await home('document.querySelector(".tiles-toast button").click()');
    await sleep(300);
    check('Undo after Restore all removes them again', (await names()).length === 4 && !(await freq()).includes('one'), `${await names()} / ${await freq()}`);

    // The clock panel's Restore all.
    await home('document.getElementById("hdr-edit").click()');
    await sleep(300);
    check('the clock panel offers Restore all while tiles are removed', await home('!!document.getElementById("ws-restore-tiles")'));
    await shot('tiles-panel');
    await home('document.getElementById("ws-restore-tiles").click()');
    await sleep(300);
    check('the panel\'s Restore all restores', (await names()).length === 5 && (await freq()).includes('one') && !(await home('!!document.querySelector(".tiles-restore")')), `${await names()}`);
    await open();
    check('and it persists', (await names()).length === 5 && (await freq()).includes('one'));
    await shot('tiles-restored');
  } catch (e) {
    check('no exception', false, e.stack || e.message);
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
