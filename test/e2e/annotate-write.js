// The annotate tool writes and draws precisely in a real window (hidden Electron run: LUMEN_TEST_BACKGROUND=1).
// A worksheet page: answers written into its blanks (screenshot px, and element space: offsets inside a target) land inside
// the blanks with the real fonts measured, follow the page on scroll and page zoom, and a filled polygon and an arrow along
// points draw through their exact points. Lumen's PDF viewer: an answer written on a PDF page stays at the same spot of the
// page when the viewer zooms and scrolls. The drawing never changes the page (its text and DOM stay the same).
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const WORKSHEET = `<!doctype html><html><head><meta charset="utf-8"><title>Worksheet</title><style>
body { font: 16px/1.6 Arial, sans-serif; margin: 40px; }
.blank { display: inline-block; width: 220px; height: 26px; border-bottom: 1px solid #333; vertical-align: bottom; }
.spacer { height: 1600px; }
</style></head><body>
<h1>Geography quiz</h1>
<p>1. The capital of France: <span class="blank" id="b1"></span></p>
<p>2. The longest river in Africa: <span class="blank" id="b2"></span></p>
<p id="sig">Signature:</p>
<div class="spacer"></div>
</body></html>`;

function makePdf() {
  const stream = 'BT /F1 24 Tf 72 700 Td (Name: ______________) Tj ET';
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

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-annotate-write-'));
  const work = path.join(root, 'tmp'); const profile = path.join(root, 'profile');
  for (const d of [work, profile]) fs.mkdirSync(d);
  const pdf = makePdf();
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/form.pdf')) { res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(pdf.length) }); res.end(pdf); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(WORKSHEET);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: work, TMP: work, ANTHROPIC_API_KEY: 'sk-ant-test' };
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env, timeout: 60000 });
  try {
    const ui = await app.firstWindow({ timeout: 60000 });
    await ui.waitForSelector('.tab');
    const run = (name, input) => app.evaluate(async (_e, [n, i]) => {
      try { const r = await global.__agent.execute(n, i); return typeof r === 'string' ? r : JSON.stringify(r).slice(0, 400); } catch (err) { return `ERROR: ${err.message}`; }
    }, [name, input]);
    const page = (code) => app.evaluate((_e, c) => global.__agent.browser.activeTab().webContents.executeJavaScript(c), code);
    // The overlay lives in Claude's isolated world: read it there.
    const overlay = (code) => app.evaluate((_e, c) => global.__agent.annotateRun(global.__agent.browser.activeTab().webContents, c), code);
    const shotCss = () => app.evaluate(() => global.__agent.screenshotScale && global.__agent.screenshotScale.css);
    const toShot = (r, css) => ({ x: r.x / css.x, y: r.y / css.y, w: r.w / css.x, h: r.h / css.y });
    const rectOf = (sel) => page(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    // Every written line: its text and its box on screen (CSS px), measured by the engine.
    const writing = () => overlay(`(() => { const b = window.__lumenDraw; if (!b || !b.alive) return null; return Array.from(b.svg.querySelectorAll('text')).filter((t) => t.querySelector('tspan')).map((t) => { const r = t.getBoundingClientRect(); return { text: Array.from(t.querySelectorAll('tspan')).map((s) => s.textContent).join('|'), x: r.left, y: r.top, w: r.width, h: r.height, size: Number(t.getAttribute('font-size')) }; }); })()`);
    // ANNOTATE_SHOT=<dir>: pictures of the drawing (after its animation) for a human to look at
    const snap = async (name) => { if (!process.env.ANNOTATE_SHOT) return; await sleep(1600); const png = await app.evaluate(async () => (await global.__agent.browser.activeTab().webContents.capturePage()).toPNG().toString('base64')); fs.writeFileSync(path.join(process.env.ANNOTATE_SHOT, `annotate-${name}.png`), Buffer.from(png, 'base64')); };
    const inside = (t, r, slack = 3) => t && t.x >= r.x - slack && t.y >= r.y - slack - 4 && t.x + t.w <= r.x + r.w + slack && t.y + t.h <= r.y + r.h + slack + 4;

    // ---- a worksheet page
    const nav = await run('navigate', { url: `${base}/worksheet` });
    check('the worksheet opens', !/^ERROR/.test(nav), nav);
    const before = await page('document.body.innerHTML');
    const shot = await run('screenshot', {});
    check('a screenshot sets the scale the marks use', !/^ERROR/.test(shot) && Boolean(await shotCss()), shot);
    const css = await shotCss();
    const b1 = await rectOf('#b1');
    const sig = await rectOf('#sig');
    const out = await run('annotate', { marks: [
      { type: 'write', ...toShot(b1, css), text: 'Paris' }, // a box of the screenshot: the text fitted into the blank
      { type: 'write', target: 'text:Signature:', x: 100 / css.x, y: 0, w: 200 / css.x, h: sig.h / css.y, text: 'A. Student', font: 'print' }, // element space
    ] });
    check('annotate writes two answers', /^Drew 2 marks/.test(out), out);
    let w = await waitFor(async () => { const r = await writing(); return r && r.length === 2 ? r : null; });
    check('the answer is written inside the first blank, in handwriting (real font metrics)', w && w[0].text === 'Paris' && inside(w[0], b1), JSON.stringify({ w: w && w[0], b1 }));
    const sigBox = { x: sig.x + 100, y: sig.y, w: 200, h: sig.h };
    check('element space: the second answer sits at its offset inside the "Signature:" line', w && w[1].text === 'A. Student' && inside(w[1], sigBox), JSON.stringify({ w: w && w[1], sigBox }));

    await snap('worksheet');
    await page('window.scrollTo(0, 120)');
    await sleep(400);
    const b1s = await rectOf('#b1');
    w = await writing();
    check('scrolling moves the writing with the blank', w && Math.abs(b1s.y - b1.y + 120) < 1 && inside(w[0], b1s), JSON.stringify({ w: w && w[0], b1s }));
    await app.evaluate(() => global.__agent.browser.activeTab().webContents.setZoomFactor(1.5));
    await sleep(700);
    const b1z = await rectOf('#b1');
    w = await writing();
    check('page zoom keeps the writing inside the blank', w && inside(w[0], b1z), JSON.stringify({ w: w && w[0], b1z }));
    await app.evaluate(() => global.__agent.browser.activeTab().webContents.setZoomFactor(1));
    await page('window.scrollTo(0, 0)');
    await sleep(500);

    // precise shapes: a filled triangle through exact points, an arrow along points
    await run('screenshot', {});
    const css2 = await shotCss();
    const P = (x, y) => [x / css2.x, y / css2.y];
    const drawn = await run('annotate', { clear: true, marks: [
      { type: 'path', points: [P(500, 300), P(700, 300), P(600, 420)], curve: false, fill: 'yellow' },
      { type: 'arrow', points: [P(100, 500), P(200, 450), P(300, 500)], curve: false, color: 'green' },
    ] });
    check('a filled polygon and an arrow along points are drawn', /^Drew 2 marks/.test(drawn), drawn);
    const shapes = await waitFor(() => overlay(`(() => { const b = window.__lumenDraw; if (!b || !b.alive) return null; const ps = Array.from(b.svg.querySelectorAll('path')); return ps.map((p) => ({ d: p.getAttribute('d'), fill: p.getAttribute('fill') })); })()`));
    const tri = shapes && shapes.find((p) => p.fill && p.fill !== 'none');
    const nums = (d) => (d.match(/-?\d+(\.\d+)?/g) || []).map(Number);
    check('the polygon goes straight through its exact points and is filled', tri && /^M[\d. ]+L[\d. ]+L[\d. ]+Z$/.test(tri.d) && nums(tri.d).every((v, i) => Math.abs(v - [500, 300, 700, 300, 600, 420][i]) < 1.5), JSON.stringify(tri));
    check('the arrow has a shaft through its points and a head', shapes && shapes.some((p) => /^M100 500L200 450L300 500$/.test(String(p.d).replace(/\.0\b/g, ''))) && shapes.filter((p) => p.fill === 'none').length >= 4, JSON.stringify(shapes));
    check('drawing never changes the page itself', (await page('document.body.innerHTML')) === before);
    await snap('shapes');

    // ---- Lumen's PDF viewer: page space
    await run('navigate', { url: `${base}/form.pdf` });
    const viewerOk = await waitFor(async () => /^lumen-pdf:/.test(await app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL())) && (await page('window.lumenPdf ? window.lumenPdf.state().pages : 0')) > 0 && (await page("document.querySelector('#viewer .page canvas, #viewer .page .textLayer span') ? 1 : 0")), 25000);
    check('the PDF opens in Lumen\'s viewer', Boolean(viewerOk));
    await run('screenshot', {});
    const css3 = await shotCss();
    const pageRect = () => page(`(() => { const r = document.querySelector('#viewer .page[data-page-number="1"]').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    const p0 = await pageRect();
    // The answer box: right of "Name:", 20% of the page wide, about one line tall
    const spot = { x: p0.x + p0.w * 0.3, y: p0.y + p0.h * 0.1, w: p0.w * 0.4, h: p0.h * 0.04 };
    const pdfOut = await run('annotate', { marks: [{ type: 'write', ...toShot(spot, css3), text: 'Ada Lovelace' }] });
    check('annotate writes on the PDF page', /^Drew 1 mark on the PDF/.test(pdfOut), pdfOut);
    const frac = (t, p) => ({ fx: (t.x - p.x) / p.w, fy: (t.y - p.y) / p.h, fw: t.w / p.w });
    const w0 = await waitFor(async () => { const r = await writing(); return r && r.length ? r[0] : null; });
    check('the PDF answer is inside its box on the page', inside(w0, spot), JSON.stringify({ w0, spot }));
    const f0 = w0 && frac(w0, p0);
    await snap('pdf');
    await page('window.lumenPdf.zoomIn()');
    await waitFor(async () => (await pageRect()).w > p0.w * 1.05, 8000);
    await sleep(500);
    const p1 = await pageRect();
    const w1 = (await writing() || [])[0];
    const f1 = w1 && frac(w1, p1);
    check('a PDF zoom scales the writing with the page and keeps it at the same spot of the page', p1.w > p0.w * 1.05 && f0 && f1 && Math.abs(f1.fx - f0.fx) < 0.01 && Math.abs(f1.fy - f0.fy) < 0.01 && Math.abs(f1.fw - f0.fw) < 0.02 && w1.size > w0.size * 1.05, JSON.stringify({ p0, p1, f0, f1, s0: w0 && w0.size, s1: w1 && w1.size }));
    await page("document.getElementById('viewerContainer').scrollTop += 60");
    await sleep(400);
    const p2 = await pageRect();
    const w2 = (await writing() || [])[0];
    const f2 = w2 && frac(w2, p2);
    check('scrolling the PDF keeps the writing on its page spot', f2 && Math.abs(p2.y - p1.y) > 20 && Math.abs(f2.fy - f1.fy) < 0.01, JSON.stringify({ p1, p2, f1, f2 }));
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
