// The Bookmarks and Downloads pages (features/managers.js) and time-ranged Clear browsing data:
// bookmarks add / edit / search / remove / export / import round trip, a local download driven
// from the Downloads page, and a "last hour" clear that removes only recent history, cookies,
// site data and downloads. Local servers only; a throwaway profile.
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return true; } catch { /* not yet */ } await sleep(100); } return false; };

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/slow.bin')) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 40 * 16384, 'Content-Disposition': 'attachment; filename="slow.bin"' });
      let sent = 0;
      const timer = setInterval(() => { res.write(Buffer.alloc(16384, 7)); if (++sent === 40) { clearInterval(timer); res.end(); } }, 100);
      req.on('close', () => clearInterval(timer));
      return;
    }
    if (req.url.startsWith('/set')) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'lumen_test=1; Path=/; Max-Age=86400' });
      return res.end('<title>Sets data</title><script>localStorage.setItem("lumen_test", "1")</script>');
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>Page ${req.url}</title>`);
  }).listen(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const other = `http://localhost:${port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-managers-'));
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-managers-dl-'));
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await app.evaluate((_e, dir) => global.__patchSettings({ downloadDir: dir, bookmarks: [] }), dlDir);

  // Runs `js` (with a user gesture) in the tab showing renderer/<page>.html.
  const inPage = (page, js) => app.evaluate(async ({ webContents }, [p, code]) => {
    const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.getURL().split(/[?#]/)[0].endsWith(`/renderer/${p}.html`));
    if (!wc) return '__nopage';
    return wc.executeJavaScript(code, true);
  }, [page, js]);
  const saved = () => app.evaluate(() => global.__managers.managers.list());
  const rowsText = () => inPage('bookmarks', "[...document.querySelectorAll('#list .row')].map((r) => r.textContent).join(' | ')");
  const fillForm = (values) => inPage('bookmarks', `(() => {
    const f = document.querySelector('form.edit');
    if (!f) return 'no form';
    for (const [k, v] of Object.entries(${JSON.stringify(values)})) f.elements[k].value = v;
    f.requestSubmit();
    return 'ok';
  })()`);
  const formError = () => inPage('bookmarks', "document.querySelector('form.edit .error')?.textContent || ''");

  // ================= Bookmarks =================
  await app.evaluate(() => global.__managers.managers.open('bookmarks'));
  check('the Bookmarks page opens with its API', await waitFor(async () => (await inPage('bookmarks', 'typeof window.lumenBookmarks?.list')) === 'function'), await inPage('bookmarks', 'location.href'));
  const again = await app.evaluate(() => { const a = global.__managers.managers.open('bookmarks'); const b = global.__managers.managers.open('bookmarks'); return a === b; });
  check('opening it again reuses the same tab', again, again);
  check('an empty list says so', await waitFor(async () => /No bookmarks yet/.test(await inPage('bookmarks', "document.getElementById('list').textContent"))), await rowsText());

  // add
  await inPage('bookmarks', "document.getElementById('add').click()");
  check('Add shows a form', (await fillForm({ url: `${base}/alpha`, title: 'Alpha page', folder: 'Work' })) === 'ok', 'no form');
  check('an added bookmark is saved', await waitFor(async () => (await saved()).some((b) => b.url === `${base}/alpha` && b.title === 'Alpha page' && b.folder === 'Work')), JSON.stringify(await saved()));
  check('it shows in its folder', await waitFor(async () => (await inPage('bookmarks', "[...document.querySelectorAll('section')].map((s) => s.querySelector('h2').textContent + ':' + s.querySelectorAll('.row').length).join(',')")) === 'Work:1'), await rowsText());
  await inPage('bookmarks', "document.getElementById('add').click()");
  await fillForm({ url: `${base}/beta`, title: 'Beta page', folder: '' });
  await waitFor(async () => (await saved()).length === 2);
  await inPage('bookmarks', "document.getElementById('add').click()");
  await fillForm({ url: `${base}/beta`, title: 'Duplicate', folder: '' });
  check('a duplicate address is refused', await waitFor(async () => /already bookmarked/.test(await formError())), await formError());
  await fillForm({ url: 'javascript:alert(1)', title: 'Bad', folder: '' });
  check('a non-web address is refused', await waitFor(async () => /web address/.test(await formError())), await formError());
  await inPage('bookmarks', "document.querySelector('form.edit button[type=button]').click()");
  check('only the two good bookmarks were saved', (await saved()).length === 2, JSON.stringify(await saved()));

  // edit
  await inPage('bookmarks', `[...document.querySelectorAll('#list .row')].find((r) => r.dataset.url === ${JSON.stringify(`${base}/alpha`)}).querySelector('.edit-button').click()`);
  check('Edit turns the row into a form', await waitFor(async () => (await inPage('bookmarks', "document.querySelector('#list form.edit input[name=title]')?.value")) === 'Alpha page'), 'no edit form');
  await fillForm({ title: 'Alpha renamed', url: `${base}/alpha2`, folder: 'Reading' });
  check('an edit changes title, address and folder', await waitFor(async () => (await saved()).some((b) => b.url === `${base}/alpha2` && b.title === 'Alpha renamed' && b.folder === 'Reading') && !(await saved()).some((b) => b.url === `${base}/alpha`)), JSON.stringify(await saved()));

  // search
  await inPage('bookmarks', "(() => { const q = document.getElementById('q'); q.value = 'renamed'; q.dispatchEvent(new Event('input')); })()");
  const found = await inPage('bookmarks', "document.querySelectorAll('#list .row').length");
  check('search narrows the list', found === 1 && /Alpha renamed/.test(await rowsText()), `${found}: ${await rowsText()}`);
  await inPage('bookmarks', "(() => { const q = document.getElementById('q'); q.value = 'zzz-nothing'; q.dispatchEvent(new Event('input')); })()");
  check('a search with no hits says so', /No matches/.test(await inPage('bookmarks', "document.getElementById('list').textContent")), await rowsText());
  await inPage('bookmarks', "(() => { const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input')); })()");

  // open in a new tab
  await inPage('bookmarks', `[...document.querySelectorAll('#list .row')].find((r) => r.dataset.url === ${JSON.stringify(`${base}/beta`)}).querySelector('a').click()`);
  check('clicking a bookmark opens it in a new tab', await waitFor(() => app.evaluate(({ webContents }, u) => webContents.getAllWebContents().some((w) => w.getURL() === u), `${base}/beta`)), 'no tab');
  check('the Bookmarks page stays open', (await inPage('bookmarks', 'location.pathname')).endsWith('/renderer/bookmarks.html'), 'navigated away');

  // export
  const exportFile = path.join(profile, 'exported-bookmarks.html');
  await app.evaluate((_e, file) => { global.__managers.managers.pickers.save = async () => ({ canceled: false, filePath: file }); }, exportFile);
  await inPage('bookmarks', "document.getElementById('export').click()");
  check('Export writes a Netscape bookmark file', await waitFor(() => fs.existsSync(exportFile) && /NETSCAPE-Bookmark-file-1/.test(fs.readFileSync(exportFile, 'utf8'))), fs.existsSync(exportFile));
  const html = fs.existsSync(exportFile) ? fs.readFileSync(exportFile, 'utf8') : '';
  check('the file has both bookmarks and the folder', html.includes(`${base}/alpha2`) && html.includes(`${base}/beta`) && /<H3>Reading<\/H3>/.test(html), html);
  check('Export reports the count', await waitFor(async () => /Exported 2 bookmarks/.test(await inPage('bookmarks', "document.getElementById('status').textContent"))), await inPage('bookmarks', "document.getElementById('status').textContent"));

  // remove
  await inPage('bookmarks', `[...document.querySelectorAll('#list .row')].find((r) => r.dataset.url === ${JSON.stringify(`${base}/alpha2`)}).querySelector('.actions button:last-child').click()`);
  check('Remove deletes a bookmark', await waitFor(async () => !(await saved()).some((b) => b.url === `${base}/alpha2`)), JSON.stringify(await saved()));
  check('the removed bookmark leaves the page', await waitFor(async () => !/Alpha renamed/.test(await rowsText())), await rowsText());

  // import (round trip): brings back the removed one, skips the one still there
  await app.evaluate((_e, file) => { global.__managers.managers.pickers.open = async () => ({ canceled: false, filePaths: [file] }); }, exportFile);
  await inPage('bookmarks', "document.getElementById('import').click()");
  check('Import adds only what is missing', await waitFor(async () => /Imported 1 new bookmark\b/.test(await inPage('bookmarks', "document.getElementById('status').textContent"))), await inPage('bookmarks', "document.getElementById('status').textContent"));
  const afterImport = await saved();
  check('the round trip restores title, address and folder', afterImport.length === 2 && afterImport.some((b) => b.url === `${base}/alpha2` && b.title === 'Alpha renamed' && b.folder === 'Reading'), JSON.stringify(afterImport));

  // Ctrl+D elsewhere updates the open page
  await app.evaluate((_e, u) => global.__agent.execute('navigate', { url: u }), `${base}/gamma`);
  await app.evaluate(({ ipcMain }) => ipcMain.emit('bookmark:toggle', {}));
  check('a bookmark added with Ctrl+D shows up on the open page', await waitFor(async () => /gamma/.test(await rowsText())), `${await rowsText()} / saved ${JSON.stringify(await saved())} / active ${await app.evaluate(() => global.__agent.browser.activeTab()?.webContents.getURL())}`);

  // the page is Lumen's own: web pages get no API, the agent doesn't see it
  const webApi = await app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript('typeof window.lumenBookmarks + typeof window.lumenDownloads'));
  check('a web page has no bookmarks or downloads API', webApi === 'undefinedundefined', webApi);
  const agentTabs = JSON.stringify(await app.evaluate(() => global.__agent.execute('list_tabs', {})));
  check("the agent's tab list leaves the Bookmarks page out", !/bookmarks\.html/.test(agentTabs), agentTabs);
  const tabState = await ui.evaluate(() => [...document.querySelectorAll('.tab')].map((t) => t.textContent).join(' | '));
  check('the tab is titled Bookmarks', /Bookmarks/.test(tabState), tabState);

  // ================= Downloads =================
  await app.evaluate(() => global.__managers.managers.open('downloads'));
  check('the Downloads page opens with its API', await waitFor(async () => (await inPage('downloads', 'typeof window.lumenDownloads?.list')) === 'function'), 'no api');
  check('it starts empty', await waitFor(async () => /No downloads yet/.test(await inPage('downloads', "document.getElementById('list').textContent"))), 'not empty');
  const webTab = `${base}/gamma`;
  const start = (url) => app.evaluate(({ webContents }, [u, from]) => webContents.getAllWebContents().find((w) => w.getURL() === from).downloadURL(u), [url, webTab]);
  const rowState = (id) => inPage('downloads', `document.querySelector('.row[data-id="${id}"]')?.dataset.state || ''`);
  const press = (id, action) => inPage('downloads', `(() => { const b = document.querySelector('.row[data-id="${id}"] [data-action="${action}"]'); if (!b) return 'none'; b.click(); return 'ok'; })()`);
  const dl = () => app.evaluate(() => global.__managers.downloads.summary());

  await start(`${base}/slow.bin`);
  check('a new download appears on the page', await waitFor(async () => (await rowState(1)) === 'progressing'), await inPage('downloads', "document.getElementById('list').textContent"));
  await waitFor(async () => (await dl())[0]?.received > 0);
  check('Pause is offered and works', (await press(1, 'pause')) === 'ok' && await waitFor(async () => (await dl())[0]?.paused), JSON.stringify((await dl())[0]));
  check('Resume is offered and works', await waitFor(async () => (await press(1, 'resume')) === 'ok') && await waitFor(async () => !(await dl())[0]?.paused), JSON.stringify((await dl())[0]));
  check('the download completes', await waitFor(async () => (await rowState(1)) === 'completed', 20000), JSON.stringify((await dl())[0]));
  const shellCalls = await app.evaluate(({ shell }) => {
    global.__shellCalls = [];
    try {
      shell.showItemInFolder = (p) => { global.__shellCalls.push(['show', p]); };
      shell.openPath = async (p) => { global.__shellCalls.push(['open', p]); return ''; };
      return 'patched';
    } catch (err) { return String(err); }
  });
  if (shellCalls === 'patched') {
    await press(1, 'show');
    await press(1, 'open');
    const calls = await app.evaluate(() => global.__shellCalls);
    const file = path.join(dlDir, 'slow.bin');
    check('Show in folder and Open use the downloaded file', calls.length === 2 && calls.every(([, p]) => p === file), JSON.stringify(calls));
  } else {
    console.log(`SKIP  shell calls (${shellCalls})`);
  }
  await start(`${base}/slow.bin?second`);
  check('a second download appears first', await waitFor(async () => (await dl())[0]?.id === 2 && (await rowState(2)) === 'progressing'), JSON.stringify(await dl()));
  check('Cancel works', (await press(2, 'cancel')) === 'ok' && await waitFor(async () => (await rowState(2)) === 'cancelled'), await rowState(2));
  check('a cancelled download offers Retry, which starts it again', (await press(2, 'retry')) === 'ok' && await waitFor(async () => (await dl())[0]?.id === 3), JSON.stringify(await dl()));
  await press(3, 'cancel');
  await waitFor(async () => (await rowState(3)) === 'cancelled');
  check('Remove takes a finished download off the list', (await press(1, 'remove')) === 'ok' && await waitFor(async () => (await rowState(1)) === '' && !(await dl()).some((d) => d.id === 1)), JSON.stringify(await dl()));
  check('the downloaded file itself is kept', fs.existsSync(path.join(dlDir, 'slow.bin')), fs.readdirSync(dlDir).join(','));
  const denied = await app.evaluate(({ webContents }, from) => webContents.getAllWebContents().find((w) => w.getURL() === from).executeJavaScript('typeof window.lumenDownloads'), webTab);
  check('a web tab cannot reach the downloads API', denied === 'undefined', denied);
  const refused = await app.evaluate(() => global.__agent.execute('read_page', {}).then(() => 'read it', (err) => err.message));
  check('the agent cannot work on the Downloads page', /Downloads page, which the assistant cannot read or control/.test(refused), refused);

  // ================= Clear browsing data, last hour =================
  // An "old" site (127.0.0.1: visited, cookie and localStorage 3 days ago) and a "new" one (localhost).
  await app.evaluate((_e, u) => global.__agent.execute('open_tab', { url: u }).catch((err) => err.message), `${base}/start`);
  await app.evaluate((_e, u) => global.__agent.execute('navigate', { url: u }), `${base}/set`);
  await app.evaluate((_e, u) => global.__agent.execute('navigate', { url: u }), `${other}/set`);
  const cookieHosts = () => app.evaluate(async ({ session }) => (await session.defaultSession.cookies.get({ name: 'lumen_test' })).map((c) => c.domain).sort());
  check('both sites stored a cookie', await waitFor(async () => (await cookieHosts()).length === 2), JSON.stringify(await cookieHosts()));
  const old = Date.now() - 3 * 86400e3;
  await app.evaluate((_e, [baseUrl, t]) => {
    const { siteActivity, history, downloads } = global.__managers;
    siteActivity.forget(['127.0.0.1']);
    siteActivity.record('127.0.0.1', t);
    for (const [url, entry] of history()) if (url.startsWith(baseUrl)) entry.last = t;
    const first = downloads.list.find((d) => d.state === 'cancelled');
    if (first) first.started = t;
  }, [base, old]);
  const historyUrls = () => app.evaluate(() => [...global.__managers.history().keys()]);
  const beforeDownloads = (await dl()).length;
  const done = await app.evaluate(() => global.__settings.backend.clearData({ range: 'hour', history: true, cookies: true, downloads: true }));
  check('clear reports the sites it cleared', done.cookies === true && done.sites >= 1, JSON.stringify(done));
  const hist = await historyUrls();
  check('last-hour clear keeps older history', hist.some((u) => u.startsWith(base)), JSON.stringify(hist));
  check('last-hour clear removes recent history', !hist.some((u) => u.startsWith(other)), JSON.stringify(hist));
  const left = await cookieHosts();
  check("last-hour clear keeps the old site's cookie and removes the new one's", left.length === 1 && left[0] === '127.0.0.1', JSON.stringify(left));
  const storage = async (url) => {
    await app.evaluate((_e, u) => global.__agent.execute('navigate', { url: u }), url);
    return app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript('localStorage.getItem("lumen_test")'));
  };
  check("the new site's local storage is gone", (await storage(`${other}/page`)) === null, 'still there');
  check("the old site's local storage stays", (await storage(`${base}/page`)) === '1', 'gone');
  const afterDownloads = await dl();
  check('last-hour clear keeps the older download in the list', afterDownloads.length === 1 && afterDownloads.length < beforeDownloads, JSON.stringify(afterDownloads.map((d) => [d.id, d.state])));
  await app.evaluate(() => global.__settings.backend.clearData({ range: 'all', cookies: true }));
  check('all-time clear removes every cookie', (await cookieHosts()).length === 0, JSON.stringify(await cookieHosts()));

  await app.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  fs.rmSync(dlDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
