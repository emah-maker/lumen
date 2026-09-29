// PDFs and local files: the built-in PDF viewer renders (electron-chrome-extensions used to leave it
// on "loading" with 0 pages), and local files open from a typed path, Finder ('open-file'), a drop
// on the window and File > Open. Offline: a local server and a temp folder.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

// A valid two-page PDF, built by hand so the test needs no fixture file.
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
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-files-'));
  const pdf = makePdf(['Page one', 'Page two']);
  fs.writeFileSync(path.join(dir, 'doc.pdf'), pdf);
  fs.writeFileSync(path.join(dir, 'My Page.html'), '<!doctype html><title>Local page</title><p>hello</p>');
  fs.writeFileSync(path.join(dir, 'other.html'), '<!doctype html><title>Other page</title>');
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/pdf'); res.end(pdf); }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');

  const active = () => app.evaluate(() => { const wc = global.__agent.browser.activeTab().webContents; return { url: wc.getURL(), title: wc.getTitle() }; });
  // The viewer's own state: page count and whether the document loaded.
  const pdfState = () => app.evaluate(async () => {
    const wc = global.__agent.browser.activeTab().webContents;
    const viewer = wc.mainFrame.framesInSubtree.find((f) => f.url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'));
    if (!viewer) return null;
    return viewer.executeJavaScript("(() => { const v = document.querySelector('pdf-viewer'); return v ? { pages: v.docLength_, state: v.loadState_ } : null; })()");
  });
  const waitPdf = async () => {
    let s = null;
    for (let i = 0; i < 40 && !(s && s.state === 'success'); i++) { await sleep(250); s = await pdfState().catch(() => null); }
    return s;
  };
  const go = async (text) => { await app.evaluate(({ ipcMain }, t) => ipcMain.emit('nav:go', {}, t), text); await sleep(1200); };

  // ---- 1. a PDF from the web renders in the built-in viewer (extensions stay on) ----
  await go(`${base}/doc.pdf`);
  let s = await waitPdf();
  check('a PDF from a site loads in the viewer, with its pages', s && s.state === 'success' && s.pages === 2, JSON.stringify(s));

  // ---- 2. a local PDF renders too ----
  await go(pathToFileURL(path.join(dir, 'doc.pdf')).href);
  s = await waitPdf();
  check('a local PDF loads in the viewer', s && s.state === 'success' && s.pages === 2, JSON.stringify(s));

  // ---- 3. a typed path (with a space) opens the file instead of searching ----
  await go(path.join(dir, 'My Page.html'));
  let a = await active();
  check('a typed path opens the local file', a.url === pathToFileURL(path.join(dir, 'My Page.html')).href && a.title === 'Local page', JSON.stringify(a));

  // ---- 4. Finder's Open With / a double-click ('open-file') opens a tab ----
  await app.evaluate(({ app }, file) => app.emit('open-file', { preventDefault() {} }, file), path.join(dir, 'other.html'));
  await sleep(1200);
  a = await active();
  check('open-file (Finder) opens the file in a tab', a.title === 'Other page', JSON.stringify(a));

  // ---- 5. files dropped on the window open; a path that doesn't exist is ignored ----
  const before = await app.evaluate(({ webContents }) => webContents.getAllWebContents().length);
  await app.evaluate(({ ipcMain }, files) => ipcMain.emit('files:open', {}, files), [path.join(dir, 'doc.pdf'), path.join(dir, 'missing.html'), 'relative.html']);
  await sleep(1500);
  const after = await app.evaluate(({ webContents }) => webContents.getAllWebContents().length);
  a = await active();
  check('a dropped file opens in a new tab', a.url === pathToFileURL(path.join(dir, 'doc.pdf')).href, JSON.stringify(a));
  check('missing and relative paths are ignored', after - before === 1, `${before} -> ${after} web contents`);

  // ---- 6. the AI still can't open local files ----
  const r = await app.evaluate((_, url) => global.__agent.execute('navigate', { url }).catch((e) => `ERROR ${e.message}`), pathToFileURL(path.join(dir, 'other.html')).href);
  check('the AI still cannot open file:// pages', String(r).startsWith('ERROR'), r);

  server.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
