// The AI's drawings scale and move with the page (hidden Electron run: LUMEN_TEST_BACKGROUND=1, a temp profile).
// A responsive page (a column in % of the window, a card in % of the column, text that wraps) gets an exact box, an
// exact ellipse round a sentence, a path across the card, an arrow in the card's own space and an answer written in a
// blank. Then browser zoom 100 -> 150 -> 67 -> 100 %, a window resize, a reflow (a banner put in above, the card made
// narrower) and a pinch zoom: after each one every mark must still line up with its target within 2 px, and be the
// target's new size. Lumen's PDF viewer: a box and an answer on a PDF page stay on the same spot of the page, at the
// page's size, through the viewer's zoom levels.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { INK_FN } = require('../helpers/_annotate-ink');

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Responsive</title><style>
body { font: 16px/1.5 Arial, sans-serif; margin: 0; background: #fff; color: #111; }
#col { width: 60%; margin: 24px auto; }
#card { width: 80%; height: 120px; background: #eef; }
.blank { display: inline-block; width: 40%; height: 1.6em; border-bottom: 1px solid #333; vertical-align: bottom; }
.spacer { height: 1200px; }
</style></head><body><div id="col">
<h1>Zoom and resize</h1>
<p id="para">Some words before. <span id="sent">The sentence the AI circles</span> and more words after it so that the paragraph wraps at narrow widths.</p>
<div id="card"></div>
<p>Answer: <span class="blank" id="blank"></span></p>
<div class="spacer"></div>
</div></body></html>`;

function makePdf() {
  const stream = 'BT /F1 24 Tf 72 700 Td (Name: ______________) Tj ET 0.8 0.8 1 rg 72 400 300 150 re f';
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
  const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 900)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 15000, every = 100) => { const end = Date.now() + ms; for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v || Date.now() > end) return v; await sleep(every); } };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-annotate-scale-'));
  const work = path.join(root, 'tmp'); const profile = path.join(root, 'profile');
  for (const d of [work, profile]) fs.mkdirSync(d);
  const pdf = makePdf();
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/doc.pdf')) { res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(pdf.length) }); res.end(pdf); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE);
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
    const overlay = (code) => app.evaluate((_e, c) => global.__agent.annotateRun(global.__agent.browser.activeTab().webContents, c), code);
    const shotCss = () => app.evaluate(() => global.__agent.screenshotScale && global.__agent.screenshotScale.css);
    const toShot = (r, css) => ({ x: r.x / css.x, y: r.y / css.y, w: r.w / css.x, h: r.h / css.y });
    const rect = (sel) => page(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    // Each mark's geometry on screen (CSS px): the union of its paths' boxes (geometry, no stroke), or its text's box.
    const marks = () => overlay(`(() => {
      const b = window.__lumenDraw; if (!b || !b.alive) return null;
      const out = {};
      for (const e of b.svg.querySelectorAll('[data-mark]')) {
        if (e.getAttribute('visibility') === 'hidden' || e.tagName === 'tspan') continue;
        const i = e.getAttribute('data-mark');
        let r = e.getBoundingClientRect();
        if (e.tagName === 'text') r = (${INK_FN})(e); // the ink of its lines, not the font's padded em box
        const kind = e.tagName === 'text' ? 'text' : 'shape';
        const o = out[i] || (out[i] = {});
        const u = o[kind];
        o[kind] = u ? { x: Math.min(u.x, r.left), y: Math.min(u.y, r.top), r: Math.max(u.r, r.right), b: Math.max(u.b, r.bottom) } : { x: r.left, y: r.top, r: r.right, b: r.bottom };
        if (kind === 'text') o.size = Number(e.getAttribute('font-size'));
      }
      for (const o of Object.values(out)) for (const k of ['shape', 'text']) if (o[k]) o[k] = { x: o[k].x, y: o[k].y, w: o[k].r - o[k].x, h: o[k].b - o[k].y };
      return out;
    })()`);
    const near = (a, b, tol = 2) => a && b && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol;
    const inside = (t, r, slack = 2) => t && r && t.x >= r.x - slack && t.y >= r.y - slack && t.x + t.w <= r.x + r.w + slack && t.y + t.h <= r.y + r.h + slack;
    const settle = () => sleep(600); // the overlay re-lays out on resize/scroll events and every 250 ms

    // ---- a responsive web page
    await run('navigate', { url: `${base}/page` });
    await run('screenshot', {});
    const css = await shotCss();
    const card = await rect('#card');
    const blank = await rect('#blank');
    const out = await run('annotate', { marks: [
      { type: 'box', ...toShot(card, css), curve: false }, // 0: exact box round the card, given in screenshot px
      { type: 'circle', target: 'text:The sentence the AI circles', curve: false }, // 1: exact ellipse round a text target
      { type: 'path', points: [[card.x / css.x, card.y / css.y], [(card.x + card.w) / css.x, (card.y + card.h) / css.y]], curve: false }, // 2: a stroke across the card
      { type: 'write', ...toShot(blank, css), text: 'forty-two' }, // 3: an answer in the blank
      { type: 'arrow', target: 'text:Zoom and resize', points: [[0, 0], [40, 10], [80, 0]], curve: false }, // 4: an arrow in the space of the heading's text
    ] });
    check('the five marks are drawn', /^Drew 5 marks/.test(out), out);
    const h1Text = () => page("(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector('h1')); const b = r.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()");
    const h1 = await h1Text();
    const firstMarks = await waitFor(async () => { const m = await marks(); return m && Object.keys(m).length === 5 ? m : null; });
    const arrow0 = firstMarks && firstMarks[4].shape;
    // The arrow's box as fractions of the heading's box (its element space), to check later states against.
    const arrowRel = arrow0 && { fx: (arrow0.x - h1.x) / h1.w, fy: (arrow0.y - h1.y) / h1.h, fw: arrow0.w / h1.w, fh: arrow0.h / h1.h };
    const textSize0 = firstMarks && firstMarks[3].size;
    const blank0 = blank;

    const sentRect = () => page(`(() => { const s = document.getElementById('sent'); const rs = Array.from(s.getClientRects()); const x = Math.min(...rs.map((r) => r.left)), y = Math.min(...rs.map((r) => r.top)), r = Math.max(...rs.map((q) => q.right)), b = Math.max(...rs.map((q) => q.bottom)); return { x, y, w: r - x, h: b - y }; })()`);
    const verify = async (when) => {
      await settle();
      const m = await marks();
      const [c, s, b, hh] = [await rect('#card'), await sentRect(), await rect('#blank'), await h1Text()];
      check(`${when}: the box still fits the card exactly`, m && near(m[0].shape, c), JSON.stringify({ mark: m && m[0].shape, card: c }));
      check(`${when}: the ellipse still fits the sentence`, m && near(m[1].shape, s), JSON.stringify({ mark: m && m[1].shape, sent: s }));
      check(`${when}: the stroke still runs corner to corner across the card`, m && near(m[2].shape, c), JSON.stringify({ mark: m && m[2].shape, card: c }));
      const t = m && m[3].text;
      check(`${when}: the answer is still inside the blank`, inside(t, b, 3), JSON.stringify({ text: t, blank: b }));
      check(`${when}: the answer's size follows the blank's`, m && Math.abs(m[3].size / textSize0 - b.h / blank0.h) < 0.06, JSON.stringify({ size: m && m[3].size, size0: textSize0, blankH: b.h, blankH0: blank0.h }));
      const a = m && m[4].shape;
      const want = arrowRel && { x: hh.x + arrowRel.fx * hh.w, y: hh.y + arrowRel.fy * hh.h, w: arrowRel.fw * hh.w, h: arrowRel.fh * hh.h };
      check(`${when}: the arrow keeps its place and size in the heading text's space`, near(a, want), JSON.stringify({ arrow: a, want }));
    };
    await verify('at 100 %');
    const zoom = async (z) => { await app.evaluate((_e, f) => global.__agent.browser.activeTab().webContents.setZoomFactor(f), z); };
    await zoom(1.5); await verify('browser zoom 150 %');
    await zoom(0.67); await verify('browser zoom 67 %');
    await zoom(1); await verify('back at 100 %');

    const winSize = await app.evaluate(({ BrowserWindow }) => [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].getSize());
    await app.evaluate(({ BrowserWindow }) => [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].setSize(900, 700));
    const narrower = await waitFor(async () => (await rect('#card')).w < card.w - 20, 8000);
    check('the window resize reflows the page (the card is narrower)', Boolean(narrower));
    await verify('window resized');
    await app.evaluate(({ BrowserWindow }, s) => [...BrowserWindow.getAllWindows()].sort((a, b) => a.id - b.id)[0].setSize(s[0], s[1]), winSize);

    await page(`(() => { const d = document.createElement('div'); d.style.height = '150px'; d.textContent = 'A banner'; document.getElementById('col').prepend(d); document.getElementById('card').style.width = '55%'; document.getElementById('card').style.height = '90px'; document.querySelector('.blank').style.width = '30%'; })()`);
    await verify('page reflowed (banner above, card resized)');

    // Pinch zoom (the page scale a pinch sets, through CDP: a synthetic touch pinch does nothing in a hidden window): the visual
    // viewport magnifies the layout viewport, overlay and all
    const pinched = await app.evaluate(async () => {
      const wc = global.__agent.browser.activeTab().webContents;
      try {
        wc.setVisualZoomLevelLimits(1, 3);
        const mine = !wc.debugger.isAttached(); // Lumen keeps its own CDP session on the tab
        if (mine) wc.debugger.attach('1.3');
        await wc.debugger.sendCommand('Emulation.setPageScaleFactor', { pageScaleFactor: 1.6 }); // what a pinch sets: the visual viewport's scale
        await new Promise((r) => setTimeout(r, 300));
        if (mine) wc.debugger.detach();
        return await wc.executeJavaScript('visualViewport.scale');
      } catch (err) { return `ERROR ${err.message}`; }
    });
    check('a pinch zoom magnifies the page', typeof pinched === 'number' && pinched > 1.2, String(pinched));
    if (typeof pinched === 'number' && pinched > 1.2) {
      await verify('pinch zoom');
      // Rects agree in layout px either way; on screen, the box's red stroke must be where the magnified card's top edge is.
      const c = await rect('#card');
      const seen = await app.evaluate(async (_e, cr) => {
        const wc = global.__agent.browser.activeTab().webContents;
        const vv = await wc.executeJavaScript('({ s: visualViewport.scale, x: visualViewport.offsetLeft, y: visualViewport.offsetTop, iw: innerWidth })');
        const img = await wc.capturePage();
        const { width, height } = img.getSize();
        const bmp = img.toBitmap(); // BGRA
        const k = width / vv.iw; // device px per CSS px of the layout viewport
        const hits = [];
        for (const fx of [0.25, 0.5, 0.75]) {
          const sx = Math.round((cr.x + cr.w * fx - vv.x) * vv.s * k), sy = Math.round((cr.y - vv.y) * vv.s * k);
          let red = false;
          for (let dy = -6; dy <= 6 && !red; dy++) {
            const y = sy + dy;
            if (sx < 0 || sx >= width || y < 0 || y >= height) continue;
            const i = (y * width + sx) * 4;
            red = bmp[i + 2] > 170 && bmp[i + 1] < 130 && bmp[i] < 130;
          }
          hits.push(red);
        }
        return { hits, vv };
      }, c);
      check('pinch zoom: on screen, the box\'s stroke runs along the magnified card\'s top edge', seen.hits.every(Boolean), JSON.stringify(seen));
    }

    // ---- Lumen's PDF viewer: page space at every zoom level
    await run('navigate', { url: `${base}/doc.pdf` });
    const ready = await waitFor(async () => /^lumen-pdf:/.test(await app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL())) && (await page('window.lumenPdf ? window.lumenPdf.state().pages : 0')) > 0 && (await page("document.querySelector('#viewer .page canvas, #viewer .page .textLayer span') ? 1 : 0")), 25000);
    check('the PDF opens in Lumen\'s viewer', Boolean(ready));
    await run('screenshot', {});
    const css2 = await shotCss();
    const pageRect = () => rect('#viewer .page[data-page-number="1"]');
    const p0 = await pageRect();
    // The PDF's blue rectangle: 72,400 300x150 pt on a 612x792 pt page (y from the bottom)
    const fr = { fx: 72 / 612, fy: (792 - 550) / 792, fw: 300 / 612, fh: 150 / 792 };
    const at = (p, f) => ({ x: p.x + f.fx * p.w, y: p.y + f.fy * p.h, w: f.fw * p.w, h: f.fh * p.h });
    const spot = { fx: 0.3, fy: 0.08, fw: 0.4, fh: 0.04 };
    const pdfOut = await run('annotate', { marks: [{ type: 'box', ...toShot(at(p0, fr), css2), curve: false }, { type: 'write', ...toShot(at(p0, spot), css2), text: 'Ada' }] });
    check('a box and an answer are drawn on the PDF page', /^Drew 2 marks on the PDF/.test(pdfOut), pdfOut);
    const pm0 = await waitFor(async () => { const m = await marks(); return m && m[0] && m[1] ? m : null; });
    const pdfSize0 = pm0 && pm0[1].size;
    const pdfVerify = async (when) => {
      await settle();
      const p = await pageRect();
      const m = await marks();
      check(`PDF ${when}: the box stays on the PDF's rectangle at the page's size`, m && near(m[0].shape, at(p, fr)), JSON.stringify({ mark: m && m[0].shape, want: at(p, fr), page: p }));
      check(`PDF ${when}: the answer stays in its spot and scales with the page`, m && inside(m[1].text, at(p, spot), 3) && Math.abs(m[1].size / pdfSize0 - p.w / p0.w) < 0.06, JSON.stringify({ text: m && m[1].text, want: at(p, spot), size: m && m[1].size, size0: pdfSize0, pw: p.w, pw0: p0.w }));
    };
    await pdfVerify('as opened');
    const scaleOf = () => page('window.lumenPdf.state().scale');
    for (const [step, label] of [['zoomIn', 'zoomed in'], ['zoomIn', 'zoomed in twice'], ['zoomOut', 'zoomed out'], ['zoomOut', 'zoomed out twice'], ['zoomOut', 'zoomed out three times']]) {
      const before = await scaleOf();
      await page(`window.lumenPdf.${step}()`);
      await waitFor(async () => (await scaleOf()) !== before, 8000);
      await waitFor(async () => { const a = await pageRect(); await sleep(150); const b = await pageRect(); return a.w === b.w; }, 8000);
      await pdfVerify(`${label} (scale ${await scaleOf()})`);
    }
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
