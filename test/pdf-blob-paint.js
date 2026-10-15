// A PDF a page makes and opens from a blob: address (what a web app such as Canvas does with a file it builds) is drawn as soon as it
// shows, with no scroll or input. Those PDFs open in Chromium's own viewer (Lumen's viewer takes http(s) and file addresses), so the
// measure is what the user sees: webContents.capturePage() of the tab, counting pure-black pixels right of the thumbnail column (the
// PDF's black bar; the viewer's dark grey is not pure black). Hidden Electron run: LUMEN_TEST_BACKGROUND=1.
// Scenarios: blank window sent to a blob in the foreground, the same behind the front tab and then switched to, the blob address navigated to
// directly, with the sidebar open and closed again, and a tab switched away from, the window resized, and switched back to.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const FIRST_PAINT_MS = 1500;

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

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-pdf-blob-'));
  const work = path.join(root, 'tmp'); const profile = path.join(root, 'profile');
  for (const d of [work, profile]) fs.mkdirSync(d);
  const pdfBase64 = makePdf(6).toString('base64');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Maker</title><p>makes PDFs</p><script>
      window.makeUrl = () => { const b = atob('${pdfBase64}'); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return URL.createObjectURL(new Blob([a], { type: 'application/pdf' })); };
      window.openInTab = () => { const w = window.open('about:blank', '_blank'); w.location.href = window.makeUrl(); };
      window.goThere = () => { location.href = window.makeUrl(); };
    </script>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: work, TMP: work, ANTHROPIC_API_KEY: 'sk-ant-test' };
  let app = null; let ui = null;
  for (let attempt = 1; ; attempt++) {
    try {
      app = await electron.launch({ args: [path.join(__dirname, '..')], env, timeout: 60000 });
      ui = await app.firstWindow({ timeout: 60000 });
      await ui.waitForSelector('.tab');
      await sleep(2000);
      break;
    } catch (e) { try { await app?.close(); } catch {} if (attempt >= 3) throw e; await sleep(3000); }
  }
  const windows = () => app.evaluate(() => global.__windows.list());
  const win0 = async () => (await windows())[0];
  const blobTab = async () => (await win0()).tabs.find((t) => String(t.url || '').startsWith('blob:'));
  const inView = (id, code) => app.evaluate(({ webContents }, [i, c]) => webContents.fromId(i).executeJavaScript(c, true), [id, code]);
  // Pure-black pixels of the tab's page as capturePage shows them, right of the thumbnail column (a quarter of the width).
  const look = (id) => app.evaluate(async ({ webContents }, i) => {
    const img = await webContents.fromId(i).capturePage();
    const { width, height } = img.getSize();
    const b = img.toBitmap();
    const from = Math.round(width * 0.25);
    let dark = 0;
    for (let y = 0; y < height; y++) for (let x = from; x < width; x++) { const k = (y * width + x) * 4; if (b[k] + b[k + 1] + b[k + 2] < 30) dark++; }
    return { dark, width, height, png: process.env.VW_SHOTS ? img.toPNG().toString('base64') : null };
  }, id);
  const expectPaint = async (label, id, { settle = 1500 } = {}) => {
    if (!id) { check(`${label}: the blob PDF opened`, false, 'no tab'); return; }
    await sleep(settle); // the viewer loads the document first (no scroll or input meanwhile)
    const t0 = Date.now(); let seen = null; let last = null;
    while (Date.now() - t0 < 5000) {
      const l = await look(id).catch(() => null);
      last = l;
      if (l && l.png) { fs.writeFileSync(path.join(process.env.VW_SHOTS, `${label.replace(/\W+/g, '_')}-${Date.now()}.png`), Buffer.from(l.png, 'base64')); l.png = null; }
      if (l && l.dark > 8000) { seen = l; break; }
      await sleep(100);
    }
    check(`${label}: the first page is drawn with no scroll or input (${seen ? `${Date.now() - t0} ms, ${seen.dark} dark pixels` : 'never'})`, Boolean(seen) && Date.now() - t0 <= FIRST_PAINT_MS, JSON.stringify({ dark: last && last.dark, w: last && last.width }));
  };
  const closeTabs = async () => { const w = await win0(); for (const t of w.tabs.slice(1)) await app.evaluate(({ ipcMain }, id) => ipcMain.emit('tab:close', {}, id), t.id); await sleep(300); };
  const switchTo = (tabId) => app.evaluate(({ ipcMain }, id) => ipcMain.emit('tab:switch', {}, id), tabId);
  const openMaker = async () => {
    const w = await win0();
    const t = await app.evaluate(async (_e, [id, u]) => global.__windows.open(id, u), [w.windowId, `${base}/maker`]);
    await sleep(1500);
    return t;
  };
  const resizeWindow = (dw, dh) => app.evaluate(({ BrowserWindow }, [a, b]) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('index.html')); const [cw, ch] = w.getSize(); w.setSize(cw + a, ch + b); }, [dw, dh]);

  try {
    // ---- 1: blank window sent to a blob from a page, shown in front
    {
      const maker = await openMaker();
      await inView(maker.contentsId, 'window.openInTab()');
      const t = await waitFor(blobTab, 15000);
      await expectPaint('blank window sent to a blob, in front', t && t.contentsId);
      console.log('title:', t && await app.evaluate(({ webContents }, id) => webContents.fromId(id).getTitle(), t.contentsId));
      await closeTabs();
    }
    // ---- 2: opened behind the front tab, switched to later
    {
      const maker = await openMaker();
      await inView(maker.contentsId, 'window.openInTab()');
      const t = await waitFor(blobTab, 15000);
      const front = (await win0()).tabs.find((x) => x.contentsId === maker.contentsId);
      await switchTo(front.id); // the PDF's tab is in the background while it loads
      await sleep(2500);
      await switchTo(t.id);
      await expectPaint('blank window sent to a blob, behind then switched to', t.contentsId, { settle: 300 });
      await closeTabs();
    }
    // ---- 3: the page navigates itself to the blob
    {
      const maker = await openMaker();
      inView(maker.contentsId, 'window.goThere()').catch(() => {});
      await waitFor(async () => String((await win0()).tabs.find((x) => x.contentsId === maker.contentsId)?.url || '').startsWith('blob:'), 15000);
      await expectPaint('navigated to the blob directly', maker.contentsId);
      await closeTabs();
    }
    // ---- 4: sidebar open
    {
      await ui.click('#toggle-sidebar'); await sleep(800);
      const maker = await openMaker();
      await inView(maker.contentsId, 'window.openInTab()');
      const t = await waitFor(blobTab, 15000);
      await expectPaint('with the sidebar open', t && t.contentsId);
      await ui.click('#toggle-sidebar'); await sleep(800);
      await expectPaint('after the sidebar closes', t && t.contentsId, { settle: 300 });
      await closeTabs();
    }
    // ---- 5: switched away, the window resized while it was away, switched back
    {
      const maker = await openMaker();
      await inView(maker.contentsId, 'window.openInTab()');
      const t = await waitFor(blobTab, 15000);
      await expectPaint('before switching away', t && t.contentsId);
      const front = (await win0()).tabs.find((x) => x.contentsId === maker.contentsId);
      await switchTo(front.id);
      await resizeWindow(-200, -150);
      await sleep(800);
      await switchTo(t.id);
      await expectPaint('switched back after a resize', t.contentsId, { settle: 300 });
      await resizeWindow(200, 150);
      await expectPaint('after the window grows', t.contentsId, { settle: 600 });
      await closeTabs();
    }
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
