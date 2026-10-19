// Save for later and the Reading list page, in the real app (hidden: LUMEN_TEST_BACKGROUND=1; a throwaway profile; local servers only).
// Ctrl+Shift+Y saves the page in front, the tab's right-click menu saves any tab, the AI's reading_list tool saves and lists, and
// lumen://readinglist lists the pages with Unread / All, opens one in a tab (marking it read), marks all read, removes with Undo.
// The list is kept in <profile>/reading-list.json.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

(async () => {
  let failures = 0;
  const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); } catch { v = false; } if (v) return v; await sleep(100); } return v; };

  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>Article ${req.url.slice(1)}</title><p>${req.url}</p>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-readlist-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await ui.evaluate(() => window.assistant.setAutoGroup(false));
  await sleep(800);

  const tabs = () => app.evaluate(() => global.__agent.browser.listTabs().map((t) => ({ id: t.id, url: t.url, active: t.active })));
  const items = () => app.evaluate(() => global.__readingList.store().list({ filter: 'all' }).map((e) => ({ url: e.url, title: e.title, read: e.read })));
  const open = async (url, { show = true } = {}) => {
    const n = (await tabs()).length;
    await app.evaluate((_e, [u, s]) => global.__agent.browser.openTab(u, s ? {} : { background: true }), [url, show]);
    await waitFor(async () => (await tabs()).length === n + 1);
    await sleep(800);
    return (await tabs()).find((t) => t.url === url)?.id;
  };
  const press = (keyCode, modifiers) => app.evaluate(async (_e, [k, m]) => {
    const wc = global.__agent.browser.activeTab().webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: m });
    wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: m });
    await new Promise((r) => setTimeout(r, 300));
  }, [keyCode, modifiers]);
  const inPage = (js) => app.evaluate(async ({ webContents }, code) => {
    const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().split(/[?#]/)[0].endsWith('/renderer/readinglist.html'));
    if (!wc) return '__nopage';
    return wc.executeJavaScript(code, true);
  }, js);
  const rows = () => inPage("[...document.querySelectorAll('#list .row')].map((r) => r.dataset.url + (r.classList.contains('unread') ? ' unread' : ' read'))");
  const listFile = () => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'reading-list.json'), 'utf8')); } catch { return null; } };
  const run = (name, input) => app.evaluate(async (_e, [n, i]) => { try { const r = await global.__agent.execute(n, i); return typeof r === 'string' ? r : JSON.stringify(r); } catch (err) { return `ERROR: ${err.message}`; } }, [name, input]);

  // ---- Ctrl+Shift+Y
  const a = await open(`${base}/alpha`);
  await press('Y', ['control', 'shift']);
  check('Ctrl+Shift+Y saves the page in front', await waitFor(async () => (await items()).some((e) => e.url === `${base}/alpha` && e.title === 'Article alpha' && !e.read)), JSON.stringify(await items()));
  await press('Y', ['control', 'shift']);
  check('pressing it again does not add a second entry', (await items()).length === 1, JSON.stringify(await items()));
  check('the list is written to the profile, atomically (no temp file)', await waitFor(() => listFile()?.items?.length === 1 && !fs.readdirSync(profile).some((f) => f.endsWith('.tmp'))), JSON.stringify(listFile()));

  // ---- the tab's right-click menu
  const b = await open(`${base}/beta`, { show: false });
  const offered = await app.evaluate((_e, id) => global.__readingList.menu(id, 'Save for later'), b);
  check('the tab menu offers Save for later', offered?.enabled === true, JSON.stringify(offered));
  await app.evaluate((_e, id) => global.__readingList.menu(id, 'Save for later', true), b);
  check('and it saves that tab, not the one in front', await waitFor(async () => (await items()).some((e) => e.url === `${base}/beta` && e.title === 'Article beta')), JSON.stringify(await items()));

  // ---- the AI's tool
  await run('switch_tab', { tab_id: a });
  const saved = await run('reading_list', { action: 'save', url: `${base}/gamma` });
  check('reading_list save with a url', /Saved/.test(saved) && (await items()).some((e) => e.url === `${base}/gamma`), saved);
  const listed = await run('reading_list', { action: 'list' });
  check('reading_list list names the unread pages', /^3 unread/.test(listed) && listed.includes(`${base}/alpha`) && listed.includes('Article beta'), listed);
  const bad = await run('reading_list', { action: 'save', url: 'file:///c:/secret.txt' });
  check('reading_list refuses what is not a web page', /^ERROR/.test(bad) && (await items()).length === 3, bad);
  const wrong = await run('reading_list', { action: 'explode' });
  check('reading_list refuses an unknown action', /^ERROR/.test(wrong), wrong);

  // ---- the page
  await app.evaluate(({ ipcMain }) => ipcMain.emit('nav:go', {}, 'lumen://readinglist'));
  check('lumen://readinglist opens the Reading list page with its API', await waitFor(async () => (await inPage('typeof window.lumenReadingList?.list')) === 'function'), await inPage('location.href'));
  check('the address bar shows lumen://readinglist', await waitFor(async () => (await ui.inputValue('#address')) === 'lumen://readinglist'), await ui.inputValue('#address'));
  check('it lists the three unread pages, newest first', await waitFor(async () => (await rows()).join() === `${base}/gamma unread,${base}/beta unread,${base}/alpha unread`), JSON.stringify(await rows()));
  const betaRow = await inPage("document.querySelectorAll('#list .row')[1].textContent");
  check('a row shows the title and the site', /Article beta/.test(betaRow) && /127\.0\.0\.1/.test(betaRow), betaRow);
  check('every row has a site icon (a letter when there is none)', (await inPage("document.querySelectorAll('#list .row .site-icon').length")) === 3);

  // click: opens in a new tab and marks it read
  const before = (await tabs()).length;
  await inPage(`document.querySelector('#list .row[data-url="${base}/beta"] a').click()`);
  check('clicking a page opens it in a new tab', await waitFor(async () => (await tabs()).length === before + 1 && (await tabs()).some((t) => t.url === `${base}/beta` && t.active)), JSON.stringify(await tabs()));
  check('and marks it read in the list', await waitFor(async () => (await items()).find((e) => e.url === `${base}/beta`)?.read === true), JSON.stringify(await items()));
  await app.evaluate(() => global.__managers.managers.open('readinglist')); // back to the list (it switches to the open tab)
  check('the Unread filter no longer shows it', await waitFor(async () => (await rows()).join() === `${base}/gamma unread,${base}/alpha unread`), JSON.stringify(await rows()));
  await inPage("document.getElementById('show-all').click()");
  check('All shows it, as read', (await rows()).join() === `${base}/gamma unread,${base}/beta read,${base}/alpha unread`, JSON.stringify(await rows()));
  check('the filter buttons say which is on', (await inPage("document.getElementById('show-all').getAttribute('aria-pressed') + document.getElementById('show-unread').getAttribute('aria-pressed')")) === 'truefalse');

  // mark one as unread again, then remove with Undo
  await inPage(`document.querySelector('#list .row[data-url="${base}/beta"] .actions button').click()`);
  check('Mark as unread brings it back to Unread', await waitFor(async () => (await items()).find((e) => e.url === `${base}/beta`)?.read === false), JSON.stringify(await items()));
  await inPage(`document.querySelector('#list .row[data-url="${base}/alpha"] .actions button:last-child').click()`);
  check('Remove takes a page off the list', await waitFor(async () => !(await items()).some((e) => e.url === `${base}/alpha`)), JSON.stringify(await items()));
  check('and offers Undo', await waitFor(async () => (await inPage("document.querySelector('.toast button')?.textContent")) === 'Undo'), '');
  await inPage("document.querySelector('.toast button').click()");
  check('Undo puts it back where it was', await waitFor(async () => (await items()).map((e) => e.url).join() === `${base}/gamma,${base}/beta,${base}/alpha`), JSON.stringify(await items()));

  // search, mark all read
  await inPage("(() => { const q = document.getElementById('q'); q.value = 'gamma'; q.dispatchEvent(new Event('input')); })()");
  check('search narrows the list', (await rows()).length === 1, JSON.stringify(await rows()));
  await inPage("(() => { const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input')); })()");
  await inPage("document.getElementById('mark-all').click()");
  check('Mark all read marks every page', await waitFor(async () => (await items()).every((e) => e.read)), JSON.stringify(await items()));
  check('and says how many', await waitFor(async () => /Marked 3 pages as read/.test(await inPage("document.getElementById('status').textContent"))), await inPage("document.getElementById('status').textContent"));
  await inPage("document.getElementById('show-unread').click()");
  check('Unread is then empty, with a friendly note', await waitFor(async () => /all caught up/i.test(await inPage("document.getElementById('list').textContent"))), await inPage("document.getElementById('list').textContent"));
  check('Mark all read is off when nothing is unread', (await inPage("document.getElementById('mark-all').disabled")) === true);

  // the AI sees the read state
  const all = await run('reading_list', { action: 'list', all: true });
  check('reading_list all:true shows read pages marked', /3 saved/.test(all) && (all.match(/\[read\]/g) || []).length === 3, all);
  check('reading_list list (unread) is empty now', /Nothing unread/.test(await run('reading_list', { action: 'list' })));
  await inPage("document.getElementById('show-all').click()");
  const removed = await run('reading_list', { action: 'remove', url: `${base}/gamma` });
  check('reading_list remove', /Removed/.test(removed) && !(await items()).some((e) => e.url === `${base}/gamma`), removed);
  check('and the open page redraws without it', await waitFor(async () => !(await rows()).some((r) => r.includes('gamma')) && (await rows()).length === 2), JSON.stringify(await rows()));

  // what is on disk
  await app.evaluate(() => global.__readingList.store().flushSync());
  const onDisk = listFile();
  check('the file on disk holds the two left, with read state', onDisk?.items?.length === 2 && onDisk.items.every((e) => e.readAt > 0), JSON.stringify(onDisk));
  const temps = fs.readdirSync(profile).filter((f) => f.endsWith('.tmp'));
  check('no temp files are left in the profile', temps.length === 0, temps.join());

  await app.close().catch(() => {});
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
