// File tabs survive closing a window (hidden Electron run: LUMEN_TEST_BACKGROUND=1, a fresh profile and TEMP of its own).
//   1. Startup "continue where you left off" (the default): a PDF (page 2), a .txt, a pinned .txt and a web page are open; the LAST window is
//      closed; Lumen starts again on the same profile and every tab is back, in order, with the same tab in front, the pin and the PDF page.
//   2. Quitting with the window open does the same.
//   3. A file deleted meanwhile comes back as the "This file was moved or deleted" page with Show in folder / Choose file, not a dropped tab.
//   4. Closing one of two windows and pressing Ctrl+Shift+T (Reopen Closed Window) brings its file tabs back, whatever the startup setting.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');

function makePdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`];
  pages.forEach((text, i) => {
    const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await Promise.resolve().then(fn).catch(() => null);
      if (v || Date.now() > end) return v;
      await sleep(150);
    }
  };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-files-'));
  const work = path.join(root, 'tmp');
  const docs = path.join(root, 'docs');
  fs.mkdirSync(work); fs.mkdirSync(docs);
  const pdfPath = path.join(docs, 'Lecture notes.pdf');
  const txtPath = path.join(docs, 'todo list.txt');
  const pinnedPath = path.join(docs, 'pinned.txt');
  const gonePath = path.join(docs, 'soon gone.txt');
  fs.writeFileSync(pdfPath, makePdf(['Page one', 'Page two', 'Page three']));
  fs.writeFileSync(txtPath, 'remember the milk');
  fs.writeFileSync(pinnedPath, 'pinned file');
  fs.writeFileSync(gonePath, 'about to vanish');
  const url = (p) => pathToFileURL(p).href;

  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Web page</title><p>hi</p>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const web = `http://127.0.0.1:${server.address().port}/page`;

  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: work, TMP: work };
  // (a start straight after the last one quit can find the profile still locked: one more try)
  const launch = async () => {
    for (let attempt = 1; ; attempt++) {
      let app = null;
      try {
        app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env, timeout: 60000 });
        const ui = await app.firstWindow({ timeout: 60000 });
        await ui.waitForSelector('.tab');
        await sleep(2500); // (the window's own start-up, and a restored session, settle first)
        return app;
      } catch (e) {
        try { await app?.close(); } catch {}
        if (attempt >= 3) throw e;
        await sleep(3000);
      }
    }
  };
  const exited = (app) => new Promise((r) => { const p = app.process(); if (p.exitCode !== null) r(); else { p.once('exit', r); setTimeout(r, 15000); } });
  const windows = (app) => app.evaluate(() => global.__windows.list());
  // The file a tab shows, whichever way it is shown: a viewer's address carries it in ?u=, a sleeping restored tab has the file's own.
  const fileOf = (u) => { try { const x = new URL(u); if (/\/renderer\/error\.html$/.test(x.pathname)) return x.searchParams.get('url'); return x.protocol === 'lumen-pdf:' || /slides\.html$/.test(x.pathname) ? x.searchParams.get('u') : u; } catch { return u; } };
  const isNewTab = (u) => /\/renderer\/newtab\.html/.test(u || '');
  const realTabs = async (app, i = 0) => ((await windows(app))[i]?.tabs || []).filter((t) => !isNewTab(t.url)); // (the new tab Lumen starts with is never saved)
  const urls = async (app, i = 0) => (await realTabs(app, i)).map((t) => fileOf(t.url));
  const openOnce = (app, p) => app.evaluate((_, f) => global.__windows.open(global.__windows.list()[0].windowId, f), pathToFileURL(p).href); // (a tab opened on the file, as File > Open does)
  // Opens a file like Finder does and waits for its tab (asked again if the first try came before the window was ready for it).
  const openFile = async (app, p) => {
    for (let i = 0; i < 4; i++) {
      await openOnce(app, p);
      if (await waitFor(async () => (await urls(app)).some((u) => fileOf(u).split('#')[0] === pathToFileURL(p).href), 5000)) return true;
    }
    return false;
  };
  const settleTabs = async (app, n) => waitFor(async () => { const t = await realTabs(app); return t.length >= n && t; });
  const activeUrl = async (app) => { const w = (await windows(app))[0]; const t = w.tabs.find((x) => x.id === w.activeId); return t ? fileOf(t.url) : null; };
  const pdfPage = (app) => app.evaluate(({ webContents }) => { const wc = webContents.getAllWebContents().find((x) => x.getURL().startsWith('lumen-pdf://')); return wc ? wc.executeJavaScript('window.lumenPdf ? window.lumenPdf.state().page : 0') : 0; });
  // Brings a file's tab to the front (a restored tab that was asleep wakes), and reads a page's own text by a part of its address.
  const showTab = async (app, fileUrl) => { const tab = (await realTabs(app)).find((x) => fileOf(x.url).split('#')[0] === fileUrl); if (tab) await app.evaluate(({ ipcMain }, id) => ipcMain.emit('tab:switch', {}, id), tab.id); return Boolean(tab); };
  const textOf = (app, part, code) => app.evaluate(({ webContents }, [x, c]) => { const wc = webContents.getAllWebContents().find((w) => w.getURL().includes(x)); return wc ? wc.executeJavaScript(c).catch(() => null) : null; }, [part, code]);
  const keys = (app, keyCode, modifiers) => app.evaluate(({ BrowserWindow }, [k, mods]) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('index.html'));
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods });
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods });
  }, [keyCode, modifiers]);

  let app = null;
  try {
    // ---- 1. close the last window, start again
    app = await launch();
    await openFile(app, pinnedPath);
    await openFile(app, txtPath);
    await app.evaluate((_, u) => global.__windows.open(global.__windows.list()[0].windowId, u), web);
    await openFile(app, pdfPath);
    await settleTabs(app, 4);
    await waitFor(async () => (await activeUrl(app)) === url(pdfPath) && await app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL().startsWith('lumen-pdf://')));
    // read to page 2: the viewer writes it into its address
    const inPdf = (code) => app.evaluate(({ webContents }, c) => { const wc = webContents.getAllWebContents().find((x) => x.getURL().startsWith('lumen-pdf://')); return wc ? wc.executeJavaScript(c).catch((e) => 'ERR ' + e.message) : 'no viewer'; }, code);
    check('the viewer loads the PDF', await waitFor(async () => (await inPdf('window.lumenPdf ? window.lumenPdf.state().pages : 0')) === 3), JSON.stringify([fs.existsSync(pdfPath), fs.existsSync(root), await inPdf('window.lumenPdf ? window.lumenPdf.state().pages : 0'), await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => decodeURIComponent(w.getURL()).slice(-90)))]));
    await inPdf("(() => { const b = document.getElementById('pageNumber'); b.value = '2'; b.dispatchEvent(new Event('change')); return true; })()");
    await waitFor(async () => /page=2/.test(decodeURIComponent(await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((x) => x.getURL().startsWith('lumen-pdf://')).getURL()))));
    const w0 = (await windows(app))[0];
    const pinTab = w0.tabs.find((t) => fileOf(t.url) === url(pinnedPath));
    await app.evaluate((_, [id, tab]) => global.__windows.pin(id, tab, true), [w0.windowId, pinTab.id]);
    const before = await urls(app);
    const beforeActive = await activeUrl(app);
    check('the window starts with a pinned file, a text file, a web page and a PDF at page 2', before.length === 4 && /page=2/.test(decodeURIComponent(await app.evaluate(({ webContents }) => webContents.getAllWebContents().find((x) => x.getURL().startsWith('lumen-pdf://')).getURL()))), JSON.stringify(before));
    const expected = before.map((u) => u.split('#')[0]);

    const gone = exited(app);
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('index.html')) w.close(); }); // the last window
    await gone;
    app = await launch();
    const back = await settleTabs(app, 4);
    const after = await urls(app);
    check('closing the last window and starting again: every tab is back, in order', JSON.stringify(after.map((u) => u.split('#')[0])) === JSON.stringify(expected), JSON.stringify({ expected, after }));
    check('the same tab is in front', (await activeUrl(app)).split('#')[0] === beforeActive.split('#')[0], await activeUrl(app));
    const w1 = await realTabs(app);
    check('the pinned file is still pinned and first', Boolean(back) && w1[0].pinned === true && fileOf(w1[0].url) === url(pinnedPath), JSON.stringify(w1.map((t) => [fileOf(t.url), t.pinned])));
    check('the PDF reopens on the same file (in its viewer) at page 2', await waitFor(async () => (await pdfPage(app)) === 2), await pdfPage(app));
    check('the text file loads its text again', await waitFor(async () => { await showTab(app, url(txtPath)); return /remember the milk/.test(await textOf(app, 'todo%20list.txt', 'document.body.innerText')); }), await textOf(app, 'todo%20list.txt', 'document.body.innerText'));

    // ---- 2. quitting with the window open
    const quit = exited(app);
    await app.close().catch(() => {});
    await quit;
    app = await launch();
    await settleTabs(app, 4);
    check('quitting and starting again keeps every file tab', JSON.stringify((await urls(app)).map((u) => u.split('#')[0])) === JSON.stringify(expected), JSON.stringify(await urls(app)));

    // ---- 3. a file deleted while Lumen was closed
    await openFile(app, gonePath);
    await settleTabs(app, 5);
    const quit2 = exited(app);
    await app.close().catch(() => {});
    await quit2;
    fs.rmSync(gonePath, { force: true });
    app = await launch();
    await settleTabs(app, 5);
    const tabsNow = await realTabs(app);
    check('a file that is gone is still a tab (not dropped)', tabsNow.length === 5 && tabsNow.some((t) => fileOf(t.url) === url(gonePath)), JSON.stringify(tabsNow.map((t) => fileOf(t.url))));
    await showTab(app, url(gonePath));
    const text = await waitFor(async () => { const v = await textOf(app, 'kind=missingfile', 'document.querySelector("h1").textContent + "|" + [...document.querySelectorAll("button")].filter((b) => !b.hidden).map((b) => b.textContent).join("|")'); return /moved or deleted/.test(v || '') && v; });
    check('it shows "This file was moved or deleted" with Choose file and Show in folder', /moved or deleted/.test(text || '') && /Choose file/.test(text) && /Show in folder/.test(text), text);
    
    // ---- 4. Reopen Closed Window (startup: a new tab, so only Ctrl+Shift+T can bring it back)
    await app.evaluate(() => global.__basics.openNewWindow());
    await waitFor(async () => (await windows(app)).length === 2);
    const list2 = await windows(app);
    const second = list2.find((w) => w.windowId !== list2[0].windowId);
    await app.evaluate((_, [id, a, b]) => { global.__windows.open(id, a); global.__windows.open(id, b); }, [second.windowId, url(txtPath), url(pdfPath)]);
    await waitFor(async () => { const w = (await windows(app)).find((x) => x.windowId === second.windowId); return w && w.tabs.length >= 3 && w.tabs.every((x) => x.url) && w.tabs.filter((x) => !isNewTab(x.url)).length === 2; }); // (both files have an address)
    const secondTabs = (await windows(app)).find((w) => w.windowId === second.windowId).tabs.filter((t) => !isNewTab(t.url)).map((t) => fileOf(t.url).split('#')[0]);
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id).close(), second.windowId);
    await waitFor(async () => (await windows(app)).length === 1);
    check('closing one of two windows leaves the other', (await windows(app)).length === 1);
    check('the closed window is kept for Reopen Closed Window', (await app.evaluate(() => global.__closedWindows())) === 1);
    await keys(app, 'T', ['control', 'shift']);
    await waitFor(async () => (await windows(app)).length === 2);
    const reopened = await waitFor(async () => { const l = await windows(app); const w = l.length === 2 && l.find((x) => x.windowId !== l[0].windowId); return w && w.tabs.filter((x) => !isNewTab(x.url)).length === 2 && w.tabs.every((x) => x.url) ? w : null; });
    const reopenedTabs = reopened ? (await windows(app)).find((w) => w.windowId === reopened.windowId).tabs.filter((t) => !isNewTab(t.url)).map((t) => fileOf(t.url).split('#')[0]) : [];
    check('Ctrl+Shift+T reopens the window with its file tabs, in order', JSON.stringify(reopenedTabs) === JSON.stringify(secondTabs), JSON.stringify({ secondTabs, reopenedTabs }));
    check('and the list of closed windows is used up', (await app.evaluate(() => global.__closedWindows())) === 0);
  } catch (e) {
    failures++;
    console.log(`FAIL  test crashed -> ${e.stack || e}`);
  } finally {
    try { await app?.close(); } catch {}
    server.close();
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch { /* the temp sweep gets it */ }
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
