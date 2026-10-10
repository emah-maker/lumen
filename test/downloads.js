// Downloads: pause, resume and cancel from the Downloads menu; a risky file is held until the user
// agrees and is not downloaded twice (a one-time link still works); two files with the same name
// at once get different names; everything goes to the folder chosen in Settings. The toolbar
// button's panel lists them, acts on them, drags finished files out, and the list survives a restart.
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
  let toolRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/slow.bin')) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 40 * 16384, 'Content-Disposition': 'attachment; filename="slow.bin"' });
      let sent = 0;
      const timer = setInterval(() => { res.write(Buffer.alloc(16384, 7)); if (++sent === 40) { clearInterval(timer); res.end(); } }, 100);
      req.on('close', () => clearInterval(timer));
      return;
    }
    if (req.url.startsWith('/tool.exe')) {
      toolRequests += 1;
      if (toolRequests > 1) { res.writeHead(410); return res.end('gone: one-time link'); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="lumen-tool.exe"' });
      return res.end(Buffer.alloc(30000, 1));
    }
    if (req.url.startsWith('/same')) {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="same.txt"' });
      setTimeout(() => res.end(`copy ${req.url}`), 400);
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Downloads fixture</title>');
  }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-dl-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-dl-profile-')); // kept across the restart below
  const launch = () => electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile } });
  let app = await launch();
  let ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await app.evaluate((_e, dir) => global.__patchSettings({ downloadDir: dir }), dlDir);
  await app.evaluate((_e, u) => global.__agent.execute('navigate', { url: u }), `${base}/`);
  const start = (url) => app.evaluate((_e, u) => global.__agent.browser.activeTab().webContents.downloadURL(u), url);
  const list = () => app.evaluate(() => global.__downloads.list());
  const click = (index, label) => app.evaluate((_e, [i, l]) => {
    const item = global.__downloads.menu()[i];
    const action = (item.submenu || []).find((s) => s.label === l);
    if (!action) return `no "${l}" in ${JSON.stringify(item)}`;
    action.click();
    return 'ok';
  }, [index, label]);
  const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };

  // ---- pause, resume, cancel
  await start(`${base}/slow.bin`);
  await waitFor(async () => (await list())[0]?.received > 0);
  check('Pause is offered while downloading', (await click(0, 'Pause')) === 'ok', await click(0, 'Pause'));
  await waitFor(async () => (await list())[0]?.paused);
  const pausedAt = (await list())[0].received;
  await sleep(800);
  const still = (await list())[0];
  check('a paused download stops', still.paused && still.received === pausedAt, JSON.stringify(still));
  check('Resume continues it', (await click(0, 'Resume')) === 'ok', 'no resume');
  check('it finishes', await waitFor(async () => (await list())[0]?.state === 'completed', 15000), JSON.stringify((await list())[0]));
  check('it lands in the folder chosen in Settings', fs.existsSync(path.join(dlDir, 'slow.bin')) && fs.statSync(path.join(dlDir, 'slow.bin')).size === 40 * 16384, fs.readdirSync(dlDir).join(','));
  const count = (await list()).length;
  await start(`${base}/slow.bin?2`);
  await waitFor(async () => (await list()).length > count && (await list())[0].received > 0);
  check('Cancel is offered', (await click(0, 'Cancel')) === 'ok', 'no cancel');
  check('a cancelled download is marked cancelled', await waitFor(async () => (await list())[0]?.state === 'cancelled'), JSON.stringify((await list())[0]));
  // The partial file is removed a moment after the cancel lands, so wait for it rather than look once.
  check('a cancelled download leaves no file', await waitFor(() => !fs.readdirSync(dlDir).some((f) => f.startsWith('slow (1)')), 5000), fs.readdirSync(dlDir).join(','));
  const retry = await app.evaluate(() => global.__downloads.menu()[0].submenu?.[0]?.label);
  check('a cancelled download offers Retry', retry === 'Retry', retry);

  // ---- a risky file waits for the user's OK and is fetched only once
  await start(`${base}/tool.exe`);
  const overlay = () => app.evaluate(() => global.__dialogs.currentId());
  check('a risky file asks first', await waitFor(async () => (await overlay()) !== null, 5000), 'no dialog');
  await sleep(500);
  check('nothing reaches the folder while unanswered', !fs.readdirSync(dlDir).some((f) => f.startsWith('lumen-tool')), fs.readdirSync(dlDir).join(','));
  await app.evaluate(() => global.__dialogs.respond({ id: global.__dialogs.currentId(), response: 1 }));
  check('after Download it is saved', await waitFor(async () => fs.existsSync(path.join(dlDir, 'lumen-tool.exe')) && fs.statSync(path.join(dlDir, 'lumen-tool.exe')).size === 30000), fs.readdirSync(dlDir).join(',') + ' ' + JSON.stringify((await list())[0]));
  check('it was downloaded once (a one-time link still works)', toolRequests === 1, `${toolRequests} requests`);

  // ---- two files with the same name at once
  await start(`${base}/same?a`);
  await start(`${base}/same?b`);
  await waitFor(async () => (await list()).filter((d) => d.name.startsWith('same') && d.state === 'completed').length === 2);
  const same = fs.readdirSync(dlDir).filter((f) => f.startsWith('same')).sort();
  const texts = same.map((f) => fs.readFileSync(path.join(dlDir, f), 'utf8')).sort();
  check('same-named downloads at once get different names', same.length === 2 && same[0] !== same[1] && texts[0] === 'copy /same?a' && texts[1] === 'copy /same?b', `${same.join(',')} ${texts.join('|')}`);

  const open = await app.evaluate(() => global.__downloads.menu().some((m) => m.label === 'Open downloads folder'));
  check('the menu keeps Open Downloads Folder', open, 'missing');

  // ---- the downloads panel (toolbar button)
  const visible = () => app.evaluate(() => global.__downloads.visible());
  const panelJs = (code) => app.evaluate((_e, c) => global.__downloads.panel().executeJavaScript(c), code);
  const rows = () => panelJs("[...document.querySelectorAll('#list li')].map((li) => ({ name: li.querySelector('.name').textContent, status: li.querySelector('.status').textContent, cls: li.className }))");
  await ui.click('#downloads');
  check('the toolbar button opens the downloads panel', await waitFor(visible, 5000), 'not shown');
  await waitFor(async () => (await rows()).length > 0, 5000);
  const shown = await rows();
  const names = (await list()).map((d) => d.name);
  check('the panel lists every download, newest first', JSON.stringify(shown.map((r) => r.name)) === JSON.stringify(names), `${JSON.stringify(shown.map((r) => r.name))} vs ${JSON.stringify(names)}`);
  check('a finished download shows its size and site', /KB|MB|B · 127\.0\.0\.1/.test(shown.find((r) => r.name === 'slow.bin')?.status || ''), JSON.stringify(shown.find((r) => r.name === 'slow.bin')));
  check('a cancelled download says so', /Cancell?ed/.test(shown.find((r) => /cancelled/.test(r.cls))?.status || ''), JSON.stringify(shown));

  // Drag a finished file out: a native file drag of that file.
  await app.evaluate(() => { const wc = global.__downloads.panel(); global.__dragged = null; wc.startDrag = (o) => { global.__dragged = o.file; }; });
  await panelJs("(() => { const li = [...document.querySelectorAll('#list li')].find((l) => l.querySelector('.name').textContent === 'slow.bin'); li.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true })); })()");
  check('dragging a finished file starts a file drag of it', await waitFor(async () => (await app.evaluate(() => global.__dragged)) === path.join(dlDir, 'slow.bin'), 3000), await app.evaluate(() => global.__dragged));

  // Remove from the list, from the panel.
  const cancelledCount = (await list()).filter((d) => d.state === 'cancelled').length;
  await panelJs("[...document.querySelectorAll('#list li.cancelled')][0].querySelector('button[aria-label^=\"Remove\"]').click()");
  check('Remove takes a download off the list', await waitFor(async () => (await list()).filter((d) => d.state === 'cancelled').length === cancelledCount - 1, 3000), JSON.stringify(await list()));

  // Only the panel's own page can act on downloads.
  const before = (await list()).length;
  await app.evaluate(({ ipcMain }) => ipcMain.emit('downloads:clear', { sender: {} }));
  await sleep(200);
  check('panel actions from anywhere else are ignored', (await list()).length === before, `${before} -> ${(await list()).length}`);

  // A file deleted from the folder shows as deleted and can't be dragged.
  fs.rmSync(path.join(dlDir, 'slow.bin'));
  await ui.keyboard.press('Escape');
  await app.evaluate(() => global.__downloads.hide());
  await sleep(400); // a click right after the panel closes counts as closing it (see main.js)
  await ui.click('#downloads');
  await waitFor(visible, 5000);
  await sleep(300);
  const gone = (await rows()).find((r) => r.name === 'slow.bin');
  check('a deleted file shows as deleted', gone && /Deleted/.test(gone.status) && /missing/.test(gone.cls), JSON.stringify(gone));

  // Escape closes the panel; the button toggles it.
  await app.evaluate(() => global.__downloads.panel().focus());
  await app.evaluate(() => global.__downloads.panel().sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }));
  check('Escape closes the panel', await waitFor(async () => !(await visible()), 3000), 'still open');

  // ---- the list survives a restart
  const kept = (await list()).map((d) => d.name);
  await sleep(700); // the list is saved half a second after a change
  await app.close();
  app = await launch();
  ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const again = await list();
  check('the downloads list survives a restart', JSON.stringify(again.map((d) => d.name)) === JSON.stringify(kept), `${JSON.stringify(again.map((d) => d.name))} vs ${JSON.stringify(kept)}`);
  check('the toolbar button shows after a restart', !(await ui.evaluate(() => document.getElementById('downloads').hidden)), 'hidden');

  await app.close();
  server.close();
  fs.rmSync(dlDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
