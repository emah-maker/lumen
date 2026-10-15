// A PDF in Lumen's viewer is drawn as soon as it opens, without any scroll or input (hidden Electron run: LUMEN_TEST_BACKGROUND=1).
// "Drawn" is measured the way the user sees it: webContents.capturePage() of the tab, counting dark pixels of the first page (a black
// bar and text on white), polled after the document has opened; it must show within about a second (FIRST_PAINT_MS), and the viewer's
// own first page must have its canvas. Scenarios: a one page, a 3 page and a 50 page PDF; a tab opened in the background and then
// switched to; a PDF opened while the sidebar is open; one opened from the Files widget (files:open), from a link in a page and from
// a download of the web (a response that is application/pdf); and a restored session (a sleeping tab that wakes).
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const FIRST_PAINT_MS = 1200;

// A PDF of `n` pages: each has a black bar, and text naming the page.
function makePdf(n) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: n }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${n} >>`];
  for (let i = 0; i < n; i++) {
    const stream = `0 0 0 rg 72 560 300 120 re f BT /F1 36 Tf 72 500 Td (Page ${i + 1} of ${n}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

(async () => {
  let failures = 0;
  const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 15000, every = 100) => { const end = Date.now() + ms; for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v || Date.now() > end) return v; await sleep(every); } };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-pdf-first-'));
  const work = path.join(root, 'tmp'); const docs = path.join(root, 'docs'); const profile = path.join(root, 'profile');
  for (const d of [work, docs, profile]) fs.mkdirSync(d);
  const files = { one: path.join(docs, 'one.pdf'), three: path.join(docs, 'three.pdf'), big: path.join(docs, 'big.pdf'), bg: path.join(docs, 'background.pdf'), side: path.join(docs, 'sidebar.pdf'), widget: path.join(docs, 'widget.pdf'), restored: path.join(docs, 'restored.pdf') };
  fs.writeFileSync(files.one, makePdf(1)); fs.writeFileSync(files.three, makePdf(3)); fs.writeFileSync(files.big, makePdf(50));
  for (const k of ['bg', 'side', 'widget', 'restored']) fs.writeFileSync(files[k], makePdf(4));
  const served = makePdf(5);
  const server = http.createServer((req, res) => {
    if (req.url === '/web.pdf' || req.url === '/download') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(served); return; }
    if (req.url === '/links') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Links</title><a id="pdf" href="/web.pdf">the pdf</a>'); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Plain</title><p>An ordinary page</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: work, TMP: work, ANTHROPIC_API_KEY: 'sk-ant-test' };
  const launch = async () => {
    for (let attempt = 1; ; attempt++) {
      let app = null;
      try {
        app = await electron.launch({ args: [path.join(__dirname, '..')], env, timeout: 60000 });
        const ui = await app.firstWindow({ timeout: 60000 });
        await ui.waitForSelector('.tab');
        await sleep(2000);
        return { app, ui };
      } catch (e) { try { await app?.close(); } catch {} if (attempt >= 3) throw e; await sleep(3000); }
    }
  };

  let { app, ui } = await launch();
  const windows = () => app.evaluate(() => global.__windows.list());
  const win0 = async () => (await windows())[0];
  const viewerContents = (part) => app.evaluate(({ webContents }, p) => { const wc = webContents.getAllWebContents().find((x) => x.getURL().startsWith('lumen-pdf://') && decodeURIComponent(x.getURL()).includes(p)); return wc ? wc.id : null; }, part);
  const inView = (id, code) => app.evaluate(({ webContents }, [i, c]) => webContents.fromId(i).executeJavaScript(c), [id, code]);
  // The dark pixels of the tab's page as capturePage shows them, and the viewer's own account of its first page.
  const look = (id) => app.evaluate(async ({ webContents }, i) => {
    const wc = webContents.fromId(i);
    const img = await wc.capturePage();
    const { width, height } = img.getSize();
    const b = img.toBitmap();
    let dark = 0;
    for (let k = 0; k < b.length; k += 4) if (b[k] + b[k + 1] + b[k + 2] < 30) dark++; // (pure black: the PDF's bar; the dark theme's grey stage is not)
    return { dark, width, height, png: process.env.VW_SHOTS ? img.toPNG().toString("base64") : null };
  }, id);
  const pagesOf = (id) => inView(id, 'window.lumenPdf ? window.lumenPdf.state().pages : 0').catch(() => 0);
  // From the moment the document is open: how long until the first page is on screen, with no input at all?
  const firstPaint = async (id) => {
    await waitFor(async () => (await pagesOf(id)) > 0, 20000, 50);
    const t0 = Date.now();
    let seen = null;
    while (Date.now() - t0 < 4000) {
      const l = await look(id).catch(() => null);
      if (l && l.png) { fs.writeFileSync(path.join(process.env.VW_SHOTS, `shot-${Date.now()}.png`), Buffer.from(l.png, "base64")); l.png = null; }
      if (l && l.dark > 8000) { seen = l; break; }
      await sleep(50);
    }
    const canvas = await inView(id, "(() => { const p = document.querySelector('.page[data-page-number=\"1\"]'); const c = p && p.querySelector('canvas'); return c ? c.width : 0; })()").catch(() => -1);
    return { ms: Date.now() - t0, seen, canvas };
  };
  const expectPaint = async (label, id) => {
    if (!id) { check(`${label}: the tab opened in the viewer`, false, 'no viewer'); return; }
    const r = await firstPaint(id);
    check(`${label}: the first page is drawn with no scroll or input (${r.seen ? `${r.ms} ms, ${r.seen.dark} dark pixels` : 'never'})`, Boolean(r.seen) && r.ms <= FIRST_PAINT_MS && r.canvas > 0, JSON.stringify(r));
  };
  const open = async (file) => { const w = await win0(); const t = await app.evaluate((_, [id, u]) => global.__windows.open(id, u), [w.windowId, pathToFileURL(file).href]); return t; };
  const closeTabs = async () => { const w = await win0(); for (const t of w.tabs.slice(1)) await app.evaluate(({ ipcMain }, id) => ipcMain.emit('tab:close', {}, id), t.id); await sleep(300); };
  const switchTo = (tabId) => app.evaluate(({ ipcMain }, id) => ipcMain.emit('tab:switch', {}, id), tabId);

  try {
    // ---- 1-3: one, three and fifty pages, opened as a foreground tab
    for (const [label, key] of [['one page', 'one'], ['3 pages', 'three'], ['50 pages', 'big']]) {
      const t = await open(files[key]);
      await expectPaint(label, await waitFor(() => viewerContents(path.basename(files[key])), 15000));
      await closeTabs();
    }

    // ---- 4: a tab opened behind the one in front, then switched to
    {
      const w = await win0();
      const front = w.activeId;
      const t = await open(files.bg);
      await switchTo(front); // the PDF's tab is now in the background while it loads
      await sleep(1500);
      const id = await waitFor(() => viewerContents('background.pdf'), 15000);
      await switchTo((await win0()).tabs.find((x) => x.contentsId === id).id);
      await expectPaint('a background tab, once switched to', id);
      await closeTabs();
    }

    // ---- 5: with the sidebar open
    {
      await ui.click('#toggle-sidebar');
      await sleep(800);
      await open(files.side);
      await expectPaint('with the sidebar open', await waitFor(() => viewerContents('sidebar.pdf'), 15000));
      await ui.click('#toggle-sidebar');
      await sleep(500);
      await closeTabs();
    }

    // ---- 6: from the Files widget
    {
      await app.evaluate(({ ipcMain }, p) => ipcMain.emit('files:open', {}, [p]), files.widget);
      await expectPaint('opened from the Files widget', await waitFor(() => viewerContents('widget.pdf'), 15000));
      await closeTabs();
    }

    // ---- 7: from a link in a page, and the address of a PDF typed in
    {
      const t = await app.evaluate(async (_e, [id, u]) => global.__windows.open(id, u), [(await win0()).windowId, `${base}/links`]);
      await sleep(1500);
      await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript("document.getElementById('pdf').click()"), t.contentsId);
      await expectPaint('opened from a link in a page', await waitFor(() => viewerContents('web.pdf'), 15000));
      await closeTabs();
      await app.evaluate(({ ipcMain }, u) => ipcMain.emit('nav:go', {}, u), `${base}/download`);
      await expectPaint('a response that is a PDF without .pdf in its address', await waitFor(() => viewerContents('/download'), 15000));
      await closeTabs();
    }

    // ---- 8: a restored session (the tab is asleep until it is shown)
    {
      await open(files.restored);
      await waitFor(() => viewerContents('restored.pdf'), 15000);
      const gone = new Promise((r) => { const p = app.process(); if (p.exitCode !== null) r(); else { p.once('exit', r); setTimeout(r, 15000); } });
      await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('index.html')) w.close(); });
      await gone;
      ({ app, ui } = await launch());
      const tab = await waitFor(async () => (await win0()).tabs.find((t) => decodeURIComponent(t.url || '').includes('restored.pdf')), 20000);
      if (tab && tab.id !== (await win0()).activeId) await switchTo(tab.id);
      await expectPaint('a restored session', await waitFor(() => viewerContents('restored.pdf'), 20000));
    }
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
