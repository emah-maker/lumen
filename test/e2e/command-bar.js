// The command bar (Ctrl+K), in a real window (hidden: LUMEN_TEST_BACKGROUND=1; local pages only):
//   open with the key from the page and from the browser UI, a page that handles Ctrl+K itself keeps it, search (tabs, history, bookmarks,
//   Settings sections, commands), arrow keys + Enter, Esc, recent commands when empty, running commands (new tab, pin, mute, theme),
//   and "Ask AI: ..." as the last row, which sends the text to the sidebar chat.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TITLES = { '/alpha': 'Alpha Report', '/beta': 'Beta Notes', '/story': 'Quokka Chronicles' };
// /handles keeps Ctrl+K for itself (a site's own command palette); the others leave it alone.
const PAGE = (url) => `<!doctype html><title>${TITLES[url] || url}</title><p>${url}</p><script>
  window.__k = 0;
  window.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { window.__k++; if (location.pathname === '/handles') e.preventDefault(); } });
</script>`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 6000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn().catch(() => false); if (v) return v; await sleep(100); } return v; };

  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(PAGE(req.url.split('?')[0])); }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-cmdbar-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile } });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 860));
  await ui.evaluate(() => window.assistant.setAutoGroup(false));

  const open = (url, background = true) => app.evaluate(async (_e, { url, background }) => {
    const t = global.__agent.browser.openTab(url, { background });
    await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); });
    return t.id;
  }, { url, background });
  const tabIds = () => app.evaluate(() => global.__agent.browser.listTabs().map((t) => t.id));
  const activeUrl = () => app.evaluate(() => global.__agent.browser.activeTab()?.webContents.getURL());
  const activeId = () => app.evaluate(() => global.__agent.browser.activeTab()?.id);
  const barOpen = () => ui.evaluate(() => { const p = document.getElementById('cmdbar'); return Boolean(p && !p.hidden); });
  const titles = () => ui.evaluate(() => [...document.querySelectorAll('.cmdbar-item .cmdbar-title')].map((e) => e.textContent));
  const headings = () => ui.evaluate(() => [...document.querySelectorAll('.cmdbar-section')].map((e) => e.textContent));
  const selected = () => ui.evaluate(() => document.querySelector('.cmdbar-item.selected .cmdbar-title')?.textContent || null);
  const rowGroups = () => ui.evaluate(() => [...document.querySelectorAll('.cmdbar-item')].map((e) => e.dataset.group));
  const type = async (q) => { await ui.fill('#cmdbar-input', q); await sleep(150); };
  const pressUi = (key) => ui.keyboard.press(key);
  // Ctrl+K as a real key press, into the page (the usual case) or the browser UI.
  const pressK = (where = 'page') => app.evaluate(async ({ BrowserWindow }, where) => {
    const wc = where === 'ui' ? BrowserWindow.fromId(global.__windows.list()[0].windowId).webContents : global.__agent.browser.activeTab().webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'K', modifiers: ['control'] });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'K', modifiers: ['control'] });
    await new Promise((r) => setTimeout(r, 400));
  }, where);
  const closeBar = async () => { if (await barOpen()) await pressUi('Escape'); await waitFor(async () => !(await barOpen()), 3000); };
  const lastState = () => ui.evaluate(() => { const s = lastTabState; const a = s.tabs.find((t) => t.id === s.activeId); return { count: s.tabs.length, pinned: Boolean(a?.pinned), muted: Boolean(a?.muted), title: a?.title }; });

  // ---- open from the page (the keyboard is in a web page: the key reaches the page first, then Lumen)
  const alpha = await open(`${base}/alpha`, false);
  const beta = await open(`${base}/beta`);
  await open(`${base}/story`);
  await pressK('page');
  check('Ctrl+K from a web page opens the command bar', await waitFor(barOpen), '');
  check('the page saw the key first (a site may use it)', (await app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript('window.__k'))) === 1, '');
  check('the box has the keyboard', await ui.evaluate(() => document.activeElement?.id === 'cmdbar-input'), '');

  // ---- nothing typed: the open tabs (no recent commands yet) and the commands, under headings
  const empty = await titles();
  check('empty: headings Open tabs then Commands, no Recent commands yet', (await headings()).join() === 'Open tabs,Commands', (await headings()).join());
  check('empty: the open tabs are listed by title', ['Alpha Report', 'Beta Notes', 'Quokka Chronicles'].every((t) => empty.includes(t)), empty.join('|'));
  check('empty: no Ask AI row until something is typed', !(await rowGroups()).includes('ask'), '');

  // ---- search: a tab, Enter switches to it
  await type('beta');
  check('typing finds the open tab under "Open tabs"', (await titles())[0] === 'Beta Notes' && (await headings())[0] === 'Open tabs', (await titles()).join('|'));
  check('the Ask AI row is last and says what was typed', (await rowGroups()).slice(-1)[0] === 'ask' && (await titles()).slice(-1)[0] === 'Ask AI: beta', (await titles()).join('|'));
  await pressUi('Enter');
  check('Enter switches to the tab and closes the bar', Boolean(await waitFor(async () => (await activeId()) === beta)) && !(await barOpen()), `${await activeId()} vs ${beta}`);

  // ---- arrow keys, wrap-around and Escape
  await pressK('page');
  await waitFor(barOpen);
  await type('tab');
  const first = await selected();
  await pressUi('ArrowDown');
  const second = await selected();
  check('ArrowDown moves the selection', first && second && first !== second, `${first} -> ${second}`);
  await pressUi('ArrowUp');
  await pressUi('ArrowUp');
  check('ArrowUp from the first row wraps to the last (Ask AI)', (await ui.evaluate(() => document.querySelector('.cmdbar-item.selected')?.dataset.group)) === 'ask', await selected());
  await pressUi('Escape');
  check('Escape closes the bar and changes nothing', !(await barOpen()) && (await activeId()) === beta, '');

  // ---- toggling with the key, from the browser UI as well
  await pressK('ui');
  check('Ctrl+K with the keyboard in the browser UI opens it too', await waitFor(barOpen), '');
  await pressK('ui');
  check('Ctrl+K again closes it', await waitFor(async () => !(await barOpen())), '');

  // ---- a page that keeps Ctrl+K for itself
  await open(`${base}/handles`, false);
  await pressK('page');
  await sleep(500);
  check('a page that handles Ctrl+K itself keeps it: the bar stays closed', !(await barOpen()) && (await app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript('window.__k'))) === 1, '');
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), beta);

  // ---- commands: New tab, recent commands first next time
  const before = (await tabIds()).length;
  await pressK('page');
  await waitFor(barOpen);
  await type('new tab');
  check('a command is found by name', (await titles())[0] === 'New tab' && (await headings()).includes('Commands'), (await titles()).join('|'));
  await pressUi('Enter');
  check('Enter runs it: a new tab opens', Boolean(await waitFor(async () => (await tabIds()).length === before + 1)), `${before} -> ${(await tabIds()).length}`);
  await pressK('ui');
  await waitFor(barOpen);
  check('empty again: the command just run is first, under "Recent commands"', (await headings())[0] === 'Recent commands' && (await titles())[0] === 'New tab', `${(await headings()).join()} / ${(await titles())[0]}`);
  await closeBar();

  // ---- pin and mute the front tab
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), beta);
  await sleep(300);
  await pressK('ui');
  await waitFor(barOpen);
  await type('pin tab');
  check('"Pin tab" is offered for an unpinned tab (and not "Unpin")', (await titles())[0] === 'Pin tab' && !(await titles()).includes('Unpin tab'), (await titles()).join('|'));
  await pressUi('Enter');
  check('Pin tab pins the front tab', Boolean(await waitFor(async () => (await lastState()).pinned)), JSON.stringify(await lastState()));
  await pressK('ui');
  await waitFor(barOpen);
  await type('pin tab');
  check('now it offers "Unpin tab"', (await titles())[0] === 'Unpin tab', (await titles()).join('|'));
  await pressUi('Enter');
  check('Unpin tab unpins it', Boolean(await waitFor(async () => !(await lastState()).pinned)), JSON.stringify(await lastState()));
  await pressK('ui');
  await waitFor(barOpen);
  await type('mute');
  await pressUi('Enter');
  check('Mute tab mutes the front tab', Boolean(await waitFor(async () => (await lastState()).muted)), JSON.stringify(await lastState()));

  // ---- theme
  await pressK('ui');
  await waitFor(barOpen);
  await type('dark theme');
  check('"dark theme" finds the theme command first', (await titles())[0] === 'Switch to the dark theme', (await titles()).join('|'));
  await pressUi('Enter');
  check('it switches the theme', Boolean(await waitFor(async () => (await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)) === 'dark')), await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource));
  await pressK('ui');
  await waitFor(barOpen);
  await type('system theme');
  await pressUi('Enter');
  await waitFor(async () => (await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)) === 'system');

  // ---- Settings sections
  await pressK('ui');
  await waitFor(barOpen);
  await type('privacy');
  const settingRow = await ui.evaluate(() => [...document.querySelectorAll('.cmdbar-item[data-group="setting"] .cmdbar-title')].map((e) => e.textContent));
  check('a Settings section is found by its name', settingRow.includes('Privacy and security'), settingRow.join('|'));
  await ui.click('.cmdbar-item[data-id="settings:privacy"]');
  const shownUrl = () => ui.evaluate(() => lastTabState.tabs.find((t) => t.id === lastTabState.activeId)?.url || '');
  check('clicking it opens Settings at that section', Boolean(await waitFor(async () => /settings\/privacy/i.test(await shownUrl()))), await shownUrl());

  // ---- history and bookmarks
  await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), alpha);
  await sleep(300);
  await pressK('ui');
  await waitFor(barOpen);
  await type('quokka');
  await waitFor(async () => (await rowGroups()).includes('history'));
  check('a page from History is found by its title, under "History"', (await headings()).includes('History') || (await headings()).includes('Open tabs'), (await headings()).join());
  const historyRow = await ui.evaluate(() => [...document.querySelectorAll('.cmdbar-item')].filter((e) => e.dataset.group === 'tab' || e.dataset.group === 'history').map((e) => `${e.dataset.group}:${e.querySelector('.cmdbar-title').textContent}`));
  check('the open tab with that title is listed once (History does not repeat an open page)', historyRow.filter((r) => r.endsWith('Quokka Chronicles')).length === 1, historyRow.join('|'));
  await closeBar();
  // A page that is only in History (its tab closed): the row navigates the front tab.
  const storyTab = (await app.evaluate(() => global.__agent.browser.listTabs().find((t) => /\/story$/.test(t.url))?.id));
  if (storyTab) await app.evaluate((_e, id) => global.__agent.browser.closeTab(id), storyTab);
  await sleep(500);
  await pressK('ui');
  await waitFor(barOpen);
  await type('quokka');
  check('after the tab is closed the page is a History row', await waitFor(async () => (await ui.evaluate(() => [...document.querySelectorAll('.cmdbar-item[data-group="history"] .cmdbar-title')].map((e) => e.textContent))).includes('Quokka Chronicles')), (await rowGroups()).join());
  await ui.click('.cmdbar-item[data-group="history"]');
  check('clicking a History row opens it in the front tab', Boolean(await waitFor(async () => /\/story$/.test(await activeUrl()))), await activeUrl());
  await app.evaluate(({ ipcMain }) => ipcMain.emit('bookmark:toggle', {})); // bookmark the page in front
  await sleep(500);
  await pressK('ui');
  await waitFor(barOpen);
  await type('chronicles');
  await waitFor(async () => (await rowGroups()).length > 1);
  check('a bookmarked page shows under "Bookmarks" or as the open tab, never twice', (await titles()).filter((t) => t === 'Quokka Chronicles').length === 1, (await titles()).join('|'));
  await closeBar();

  // ---- Ask AI: the last row sends the text to the sidebar chat
  await pressK('ui');
  await waitFor(barOpen);
  await type('why is the sky blue');
  check('Ask AI is the last row and reads "Ask AI: <text>"', (await titles()).slice(-1)[0] === 'Ask AI: why is the sky blue', (await titles()).join('|'));
  await ui.click('.cmdbar-item[data-group="ask"]');
  const asked = await waitFor(async () => ui.evaluate(() => [...document.querySelectorAll('#messages .msg.user')].some((m) => m.textContent.includes('why is the sky blue'))), 8000);
  check('it opens the sidebar and sends the text to the AI chat', Boolean(asked) && !(await barOpen()), '');
  check('the sidebar is showing', await ui.evaluate(() => !document.body.classList.contains('sidebar-hidden')), '');

  // ---- the page is shown again once the bar is closed (it froze the page for the overlay)
  await pressK('ui');
  await waitFor(barOpen);
  await pressUi('Escape');
  check('closing the bar puts the live page back (no still picture left)', Boolean(await waitFor(async () => ui.evaluate(() => !document.querySelector('.page-snapshot')))), '');

  check('no errors in the browser UI', errors.length === 0, errors.join(' | '));
  await app.close();
  server.close();
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
