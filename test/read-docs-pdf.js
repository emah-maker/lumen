// The AI reads a whole Google Doc and a whole PDF, in the real app (hidden: LUMEN_TEST_BACKGROUND=1). Offline fixtures:
//  - a page shaped like Google Docs (the text is drawn on a canvas inside .kix-appview-editor, which is the scroller, and the
//    window cannot scroll) with a same-origin /document/d/<id>/export?format=txt route that needs the page's cookie: read_page
//    returns the full text with the "(from Google Docs export)" note, scroll moves the inner container, and a Sheet gives its CSV;
//  - a six-page PDF (local file and web): read_pdf gets pages 5-6 (pages:"5-", from:5), and scroll reaches page 6.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
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

const DOC_TEXT = ['Introduction', 'Manual Tester', 'Results table', 'Conclusion and references'].map((h, i) => `${h}\nParagraph ${i + 1} of the lab report.`).join('\n\n');
const DOC_PAGE = `<!doctype html><html><head><title>Lab report - Google Docs</title><style>html,body{margin:0;height:100%;overflow:hidden}
.kix-appview-editor{position:absolute;inset:0;overflow-y:scroll}.kix-canvas-tile-content{display:block}</style></head>
<body><div class="kix-appview-editor"><div class="kix-page"><canvas class="kix-canvas-tile-content" width="600" height="5000" style="width:600px;height:5000px;margin:0 auto"></canvas></div></div>
<script>document.cookie = 'SID=fixture; path=/';</script></body></html>`;
const SHEET_PAGE = '<!doctype html><title>Grades - Google Sheets</title><canvas width="300" height="200"></canvas>';
const SHEET_CSV = 'name,score\nAda,91\nGrace,97\n';

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(150); } return v; };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-read-docs-'));
  const pdfPages = [1, 2, 3, 4, 5, 6].map((n) => `Template section ${n} heading`);
  const pdfBytes = makePdf(pdfPages);
  const localPdf = path.join(dir, 'template.pdf');
  fs.writeFileSync(localPdf, pdfBytes);
  const exportHits = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (type, body, status = 200) => { res.writeHead(status, { 'content-type': type }); res.end(body); };
    if (u.pathname === '/document/d/FIXTUREDOC1/edit') return send('text/html; charset=utf-8', DOC_PAGE);
    if (u.pathname === '/document/d/FIXTUREDOC1/export') {
      exportHits.push(`${u.search}|${req.headers.cookie || ''}`);
      if (!/SID=fixture/.test(req.headers.cookie || '') || u.searchParams.get('format') !== 'txt') return send('text/html', '<html>Sign in</html>', 401);
      return send('text/plain; charset=utf-8', `\uFEFF${DOC_TEXT.replace(/\n/g, '\r\n')}`);
    }
    if (u.pathname === '/spreadsheets/d/SHEETFIXT01/edit') return send('text/html; charset=utf-8', SHEET_PAGE);
    if (u.pathname === '/spreadsheets/d/SHEETFIXT01/export') return send('text/csv', u.searchParams.get('gid') === '5' ? SHEET_CSV : 'wrong,sheet\n');
    if (u.pathname === '/template.pdf') return send('application/pdf', pdfBytes);
    send('text/html', '<title>Other</title><p>Other</p>', 404);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-read-docs-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: dir, TMP: dir, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');

  const open = (url) => app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => t.webContents.once('did-stop-loading', r)); return t.id; }, url);
  const run = (name, input) => app.evaluate(async (_e, [n, i]) => {
    try { const r = await global.__agent.execute(n, i); return typeof r === 'string' ? r : JSON.stringify(r); } catch (err) { return `ERROR: ${err.message}`; }
  }, [name, input]);
  // read_pdf the way a chat does it: inside a task, past the once-per-chat card (answered here by noAsk).
  const readPdf = (input) => app.evaluate(async (_e, i) => {
    const agent = global.__agent;
    const signal = new AbortController().signal;
    const chat = []; chat.settings = { model: 'claude-opus-5' };
    const gate = { emit: () => {}, signal, hosts: new Set(), who: 'Claude', external: false, noAsk: true, run: { tainted: false } };
    const tabId = agent.browser.activeTab().id;
    try { return await agent.inTask(tabId, signal, async () => { await agent.ensureAllowed('read_pdf', () => {}, signal, { ...gate, input: i }); return agent.readPdf(i); }, chat); } catch (err) { return `ERROR: ${err.message}`; }
  }, input);
  const inTab = (code) => app.evaluate((_e, c) => global.__agent.browser.activeTab().webContents.executeJavaScript(c), code);

  // ---- a Google Doc
  await open(`${base}/document/d/FIXTUREDOC1/edit`);
  await sleep(500);
  let r = await run('read_page', {});
  check('Docs: read_page returns the full document text from the export', /Introduction/.test(r) && /Manual Tester/.test(r) && /Conclusion and references/.test(r) && /Paragraph 4 of the lab report/.test(r), r);
  check('Docs: the text is labelled "(from Google Docs export)"', /from Google Docs export/.test(r), r);
  check('Docs: the export was fetched with the page\'s own cookie, once as txt', exportHits.length >= 1 && exportHits.every((h) => h.startsWith('?format=txt|') && /SID=fixture/.test(h)), JSON.stringify(exportHits));
  r = await run('read_tabs', { ids: [await app.evaluate(() => global.__agent.browser.activeTab().id)] });
  check('Docs: read_tabs also gets the full text', /Manual Tester/.test(r) && /Conclusion and references/.test(r), r);
  r = await run('scroll', { direction: 'down', screens: 2 });
  const moved = await inTab('document.querySelector(".kix-appview-editor").scrollTop');
  check('Docs: scroll moves the editor\'s scroll container, not the window', /container/.test(r) && moved > 0, `${r} / scrollTop ${moved}`);
  check('Docs: the window itself never moved', (await inTab('scrollY')) === 0);
  r = await run('scroll', { direction: 'up', screens: 5 });
  check('Docs: scroll up goes back to the top', (await inTab('document.querySelector(".kix-appview-editor").scrollTop')) === 0, r);

  // ---- a Google Sheet: the current sheet (gid) as CSV
  await open(`${base}/spreadsheets/d/SHEETFIXT01/edit#gid=5`);
  await sleep(500);
  r = await run('read_page', {});
  check('Sheets: read_page returns the current sheet as CSV', /name,score/.test(r) && /Grace,97/.test(r) && /from Google Sheets export/.test(r) && !/wrong,sheet/.test(r), r);

  // ---- a six-page PDF, local and web
  const viewerReady = async () => waitFor(async () => (await inTab('(window.lumenPdf && window.lumenPdf.state().pages) || 0')) === 6, 20000);
  for (const [label, url] of [['local', pathToFileURL(localPdf).href], ['web', `${base}/template.pdf`]]) {
    await open(url);
    check(`PDF (${label}): opens in Lumen's viewer with six pages`, await viewerReady(), await inTab('location.href'));
    let out = await readPdf({});
    check(`PDF (${label}): read_pdf with no range returns all six pages`, /Template section 1 heading/.test(out) && /Template section 6 heading/.test(out) && /Page 6 of 6/.test(out), out);
    out = await readPdf({ pages: '5-' });
    check(`PDF (${label}): pages:"5-" returns pages 5 and 6 only`, /Template section 5 heading/.test(out) && /Template section 6 heading/.test(out) && !/Template section 4 heading/.test(out), out);
    out = await readPdf({ from: 5 });
    check(`PDF (${label}): from:5 does the same`, /Template section 5 heading/.test(out) && /Template section 6 heading/.test(out) && !/Template section 4 heading/.test(out), out);
    out = await readPdf({ pages: '1-4' });
    check(`PDF (${label}): a range that stops early says where to continue`, /Template section 4 heading/.test(out) && /from:5/.test(out), out);
    // scroll: page by page, to the last page
    await run('scroll', { direction: 'up', screens: 10 });
    let state = null;
    for (let i = 0; i < 30; i++) {
      const res = await run('scroll', { direction: 'down', screens: 1 });
      state = await inTab('window.lumenPdf.state()');
      if (state.page === 6 || /Already at the end/.test(res)) break;
    }
    check(`PDF (${label}): scroll, one screen at a time, reaches page 6`, state && state.page === 6, JSON.stringify(state));
    await run('scroll', { direction: 'up', screens: 30 });
    const jump = await run('scroll', { direction: 'down', page: 5 });
    state = await inTab('window.lumenPdf.state()');
    check(`PDF (${label}): scroll with page:5 goes straight to page 5`, state.page === 5 && /page 5 of 6/.test(jump), `${jump} ${JSON.stringify(state)}`);
  }

  await app.close().catch(() => {});
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
