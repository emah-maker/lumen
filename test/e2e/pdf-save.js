// Save in Lumen's PDF viewer saves the PDF the tab is showing (hidden Electron run: LUMEN_TEST_BACKGROUND=1).
// A course site's file link works once: asking it again answers with an error, so a Save that fetched the address again failed
// as "data.txt, Failed: couldn't connect". The server here answers the PDF's address once and 410 after that. Save is pressed after
// Lumen's own short-lived copy has expired (KEEP_MS in features/pdf-viewer.js), and the download must finish with the PDF's bytes and
// its own name, without the site being asked again.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

function makePdf() {
  const stream = '0 0 0 rg 72 560 300 120 re f BT /F1 36 Tf 72 500 Td (Saved page) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
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

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-pdf-save-'));
  const work = path.join(root, 'tmp'); const profile = path.join(root, 'profile'); const downloads = path.join(root, 'downloads');
  for (const d of [work, profile, downloads]) fs.mkdirSync(d);
  const pdf = makePdf();
  let hits = 0;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/once/lecture-notes.pdf')) {
      hits++;
      if (hits > 1) { res.writeHead(410, { 'content-type': 'text/plain' }); res.end('This link has expired'); return; }
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(pdf.length) }); res.end(pdf); return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Plain</title><p>An ordinary page</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: work, TMP: work, ANTHROPIC_API_KEY: 'sk-ant-test' };
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env, timeout: 60000 });
  try {
    const ui = await app.firstWindow({ timeout: 60000 });
    await ui.waitForSelector('.tab');
    await app.evaluate((_e, dir) => global.__patchSettings({ downloadDir: dir }), downloads); // never the real Downloads folder
    const w = (await app.evaluate(() => global.__windows.list()))[0];
    await app.evaluate((_, [id, u]) => global.__windows.open(id, u), [w.windowId, `${base}/once/lecture-notes.pdf`]);
    const viewer = await waitFor(() => app.evaluate(({ webContents }) => webContents.getAllWebContents().find((x) => x.getURL().startsWith('lumen-pdf://') && decodeURIComponent(x.getURL()).includes('lecture-notes.pdf'))?.id || null), 20000);
    check('the PDF opens in Lumen\'s viewer', Boolean(viewer));
    const inView = (code) => app.evaluate(({ webContents }, [i, c]) => webContents.fromId(i).executeJavaScript(c), [viewer, code]);
    const pages = await waitFor(() => inView('window.lumenPdf ? window.lumenPdf.state().pages : 0'), 20000);
    check('the viewer shows its page', pages > 0, String(pages));

    await sleep(31 * 1000); // past Lumen's own copy of the PDF (KEEP_MS): a Save that asked for the address again would reach the site
    const before = hits;
    await inView("document.getElementById('download').click()");
    const done = await waitFor(async () => (await app.evaluate(() => global.__downloads.list())).find((d) => d.state !== 'progressing'), 20000);
    check('Save finishes the download', done && done.state === 'completed', JSON.stringify(done && { state: done.state, name: done.name, url: String(done.url).slice(0, 80), reason: done.reason }));
    check('the saved file keeps the PDF\'s name', done && done.name === 'lecture-notes.pdf', done && done.name);
    const saved = done && done.path && fs.existsSync(done.path) ? fs.readFileSync(done.path) : null;
    check('the saved file is the PDF the tab shows', Boolean(saved) && saved.equals(pdf), saved ? `${saved.length} bytes` : 'no file');
    check('Save does not ask the site again', hits === before, `${hits - before} more request(s)`);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
