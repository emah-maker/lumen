// A PDF that Lumen's viewer cannot open must never leave the tab sitting on "Opening in Chrome's PDF viewer…" (hidden Electron run).
// Each case is a tab opened on a local server's address and judged by what the tab shows within a few seconds: the PDF (the viewer's
// pages), or the viewer's message with its actions (Try again, Open in Chrome's viewer, Download) and a plain reason, or, for a page that
// is not a PDF, that page in the tab. Never the "Opening in Chrome" toast.
//   - good: an ordinary PDF.
//   - one-time link: a .pdf address that redirects to a signed link which allows byte ranges but answers only ONCE (the second request, any
//     request, is a 403 page); the PDF is 300 KB. It must open, from one request (a guard: pdf.js read it from one request even before the
//     viewer kept the bytes, so this is not what failed for the user).
//   - HTML with a .pdf name, and a corrupt PDF: pdf.js refuses them and Chrome's viewer (or the page itself) takes over.
//   - gated download: the first request gets junk, every later one the real PDF as Content-Disposition: attachment. Chrome's load of it turns
//     into a download, so the tab can never leave the viewer: the message must say so, and "Try again" must open the PDF.
//   - slow handoff: the first request gets junk and every later one hangs: after about 3 s the message with its actions replaces the toast.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// A PDF of `n` pages, with `pad` bytes of unused data after them.
function makePdf(n, pad = 0) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: n }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${n} >>`];
  for (let i = 0; i < n; i++) {
    const stream = `0 0 0 rg 72 560 300 120 re f BT /F1 36 Tf 72 500 Td (Page ${i + 1} of ${n}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  if (pad) objects.push(`<< /Length ${pad} >>\nstream\n${'x'.repeat(pad)}\nendstream`);
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

(async () => {
  let failures = 0;
  const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 900)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const within = (promise, ms) => Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error('timed out')), ms))]); // (a page that is mid-navigation may never answer)
  const waitFor = async (fn, ms = 15000, every = 100) => { const end = Date.now() + ms; for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v || Date.now() > end) return v; await sleep(every); } };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-pdf-stuck-'));
  const work = path.join(root, 'tmp'); const profile = path.join(root, 'profile'); const downloads = path.join(root, 'downloads');
  for (const d of [work, profile, downloads]) fs.mkdirSync(d);
  const small = makePdf(2);
  const big = makePdf(3, 300000);
  const hits = {};
  const hit = (k) => { hits[k] = (hits[k] || 0) + 1; return hits[k]; };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p.startsWith('/files/7/download')) { hit('redirect'); res.writeHead(302, { location: `/once/${url.searchParams.get('k') || 'a'}.bin` }); res.end(); return; }
    if (p.startsWith('/once/')) {
      if (hit(p) > 1) { res.writeHead(403, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Expired</title><p>Request has expired</p>'); return; }
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      const base = { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="intro.pdf"', 'accept-ranges': 'bytes' };
      if (m) { const start = Number(m[1] || 0); const end = Math.min(Number(m[2] || big.length - 1), big.length - 1); res.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${big.length}`, 'content-length': end - start + 1 }); res.end(big.subarray(start, end + 1)); return; }
      res.writeHead(200, { ...base, 'content-length': big.length }); res.end(big); return;
    }
    if (p === '/fake/html.pdf') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Sign in</title><p>Please sign in</p>'); return; }
    if (p === '/corrupt/bad.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(Buffer.from('%PDF-1.4\nthis is not really a pdf\n'.repeat(20))); return; }
    if (p === '/good/ok.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(small); return; }
    // The viewer's reads (/data: pdf.js; Sec-Fetch-Dest empty) are told apart from the tab's own page load (document: Chrome's fallback load).
    const doc = req.headers['sec-fetch-dest'] === 'document';
    const n = hit(`${p}${doc ? ' doc' : ' data'}`);
    if (process.env.PDF_LOG) console.log('REQ', req.method, req.url, req.headers['sec-fetch-dest'], req.headers.range || '', n);
    const junk = () => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(Buffer.from('%PDF-1.4\ngate page, not the file\n')); };
    if (p === '/gated/doc.pdf') { // pdf.js's first read gets junk; the real file comes as a download (Chrome's load, and Try again's read)
      if (!doc && n === 1) { junk(); return; }
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="doc.pdf"', 'content-length': small.length }); res.end(small); return;
    }
    if (p === '/slow/doc.pdf') { if (!doc) junk(); return; } // Chrome's load never answers
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: work, TMP: work, ANTHROPIC_API_KEY: 'sk-ant-test' };
  let app = null;
  try {
    app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env, timeout: 60000 });
    const ui = await app.firstWindow({ timeout: 60000 });
    await ui.waitForSelector('.tab');
    await sleep(2000);
    await app.evaluate((_e, dir) => global.__patchSettings({ downloadDir: dir }), downloads); // never the real Downloads folder
    const win0 = async () => (await app.evaluate(() => global.__windows.list()))[0];
    const closeTabs = async () => { const w = await win0(); for (const t of w.tabs.slice(1)) await app.evaluate(({ ipcMain }, id) => ipcMain.emit('tab:close', {}, id), t.id); await sleep(300); };
    // What the tab shows now: the address of the document on screen, and when it is the viewer, its pages, its message and the actions in it.
    // (Read through the debugger: while a load the page started is pending, webContents.executeJavaScript waits for it, and getURL() is the pending address.)
    const READ = `(() => { const m = document.getElementById('message'); const shown = m && !m.hidden; return { url: location.href, pages: window.lumenPdf ? window.lumenPdf.state().pages : 0, message: shown ? m.innerText : '', actions: shown ? [...m.querySelectorAll('button')].map((b) => b.textContent.trim()) : [], pageCount: (document.getElementById('pageCount') || {}).textContent }; })()`;
    const snap = (id) => within(app.evaluate(async ({ webContents }, [i, code]) => {
      const wc = webContents.fromId(i);
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      const r = await wc.debugger.sendCommand('Runtime.evaluate', { expression: code, returnByValue: true });
      const v = r && r.result && r.result.value;
      return v ? { ...v, viewer: v.url.startsWith('lumen-pdf://') } : { url: wc.getURL(), viewer: false };
    }, [id, READ]), 4000);
    const clickIn = (id, label) => app.evaluate(({ webContents }, [i, l]) => webContents.fromId(i).debugger.sendCommand('Runtime.evaluate', { expression: `[...document.querySelectorAll('#message button')].find((b) => b.textContent.trim() === ${JSON.stringify(l)})?.click()` }), [id, label]);
    const withActions = (s) => s && s.viewer && s.actions.includes('Try again') && s.actions.includes('Download') && !/Opening in Chrome/.test(s.message);
    const showsPdf = (s) => s && s.viewer && s.pages > 0;
    // Open `address` in a tab; wait until the tab has settled by `done`; return the tab and the last snapshot.
    const open = async (address, done, ms = 9000) => {
      const w = await win0();
      const t = await app.evaluate((_, [wid, u]) => global.__windows.open(wid, u), [w.windowId, address]);
      const t0 = Date.now();
      let last = null;
      while (Date.now() - t0 < ms) { last = await snap(t.contentsId).catch((e) => ({ error: String(e.message).slice(0, 200) })); if (done(last)) break; await sleep(200); }
      return { t, last, took: Date.now() - t0 };
    };
    const notToast = (label, last) => check(`${label}: not left on the "Opening in Chrome" toast`, Boolean(last) && !/Opening in Chrome/.test(last.message || ''), JSON.stringify(last));

    // ---- good
    { const { last } = await open(`${base}/good/ok.pdf`, showsPdf); check('good: the PDF shows, with its page count', showsPdf(last) && last.pageCount === '/ 2', JSON.stringify(last)); await closeTabs(); }

    // ---- one-time link that offers ranges
    {
      const { last } = await open(`${base}/files/7/download/intro.pdf?k=a`, (s) => showsPdf(s) || withActions(s), 15000);
      check('one-time link: the PDF opens', showsPdf(last) && last.pages === 3, JSON.stringify({ last, hits }));
      check('one-time link: the signed link was asked once', hits['/once/a.bin'] === 1, JSON.stringify(hits));
      await closeTabs();
    }

    // ---- not a PDF at all
    for (const [label, address] of [['HTML with a .pdf name', `${base}/fake/html.pdf`], ['corrupt PDF', `${base}/corrupt/bad.pdf`]]) {
      const { t, last } = await open(address, (s) => s && (!s.viewer || withActions(s)));
      await sleep(5000); // (the 5 s the issue talks about: still not stuck)
      const later = await snap(t.contentsId).catch(() => null);
      notToast(label, later);
      check(`${label}: ends on the page itself or on the message with its actions`, Boolean(later) && (!later.viewer || withActions(later)), JSON.stringify({ last, later }));
      await closeTabs();
    }

    // ---- the site turns Chrome's load into a download
    {
      const { t, last } = await open(`${base}/gated/doc.pdf`, withActions, 12000);
      notToast('gated download', last);
      check('gated download: the message names the download, with Try again, Open in Chrome\'s viewer excluded (it would only download again) and Download', withActions(last) && /download/i.test(last.message) && !last.actions.includes('Open in Chrome’s viewer'), JSON.stringify(last));
      check('gated download: the page count is not "/ 1" with no document', last && last.pageCount !== '/ 1' && last.pages === 0, JSON.stringify(last));
      await clickIn(t.contentsId, 'Try again');
      const after = await waitFor(async () => { const s = await snap(t.contentsId); return showsPdf(s) || withActions(s) ? s : null; }, 12000, 200);
      check('gated download: Try again opens the PDF', showsPdf(after), JSON.stringify(after));
      await closeTabs();
    }

    // ---- Chrome's viewer does not come: say so after about 3 s
    {
      // (While Chrome's load is pending, nothing can be read from the page from outside, so the page's own log says when it showed the message.)
      const w = await win0();
      const t = await app.evaluate((_, [wid, u]) => global.__windows.open(wid, u), [w.windowId, `${base}/slow/doc.pdf`]);
      await app.evaluate(({ webContents }, i) => {
        global.__slow = [];
        webContents.fromId(i).on('console-message', (...a) => { const m = a[0] && typeof a[0].message === 'string' ? a[0].message : a[2]; global.__slow.push([Date.now(), String(m)]); });
      }, t.contentsId);
      const shown = await waitFor(async () => { const log = await app.evaluate(() => global.__slow); return log.find(([, m]) => /showing the message/.test(m)) ? log : null; }, 15000, 200);
      const log = shown || [];
      const failedAt = (log.find(([, m]) => /could not open/.test(m)) || [])[0];
      const shownRow = log.find(([, m]) => /showing the message/.test(m)) || [];
      check('slow handoff: the message with its actions replaces the toast about 3 s after the failure, not never', Boolean(failedAt) && /taking a while/.test(shownRow[1] || '') && shownRow[0] - failedAt >= 2500 && shownRow[0] - failedAt <= 5000, JSON.stringify(log));
      await closeTabs();
    }
  } finally {
    await app?.close().catch(() => {});
    try { server.closeAllConnections(); } catch { /* old node */ }
    server.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
