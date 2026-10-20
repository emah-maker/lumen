// The PDF viewer and the slide viewer must not jump while they open (Chrome DevTools' "Live metrics" CLS: good is under 0.1).
// Hidden Electron run (LUMEN_TEST_BACKGROUND=1, a profile of its own): a generated PDF with pages of different sizes, a 30-page PDF with a
// title in its metadata and a generated 12-slide deck open in the viewers; a PerformanceObserver for 'layout-shift' (buffered, so the shifts
// from the first paint on are included) sums the shifts that did not follow user input, as CLS does, and each viewer must stay under 0.1.
// The pages must still be drawn and sized right for "Fit width" (the viewer's opening zoom), and the slides must still be there.
// VW_CLS_DUMP=1 prints every shift with what moved.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const F = require('./_pptx-fixtures');

const MAX_CLS = 0.1;

// A PDF whose page i has the size sizes[i] (points): a black bar and the page number on each.
function makePdf(sizes, title = '') {
  const n = sizes.length;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${sizes.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${n} >>`, title ? `<< /Title (${title}) >>` : '<< >>'];
  sizes.forEach(([w, h], i) => {
    const stream = `0 0 0 rg 36 ${h - 120} ${w - 72} 80 re f BT /F1 24 Tf 36 ${h - 200} Td (Page ${i + 1} of ${n}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

(async () => {
  let failures = 0;
  const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 1500)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 15000, every = 100) => { const end = Date.now() + ms; for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v || Date.now() > end) return v; await sleep(every); } };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-viewer-cls-'));
  const work = path.join(root, 'tmp'); const profile = path.join(root, 'profile'); const docs = path.join(root, 'docs');
  for (const d of [work, profile, docs]) fs.mkdirSync(d);
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: work, TMP: work, ANTHROPIC_API_KEY: 'sk-ant-test' };

  const files = { mixed: path.join(docs, 'mixed-sizes.pdf'), titled: path.join(docs, 'titled.pdf'), deck: path.join(docs, 'twelve.pptx') };
  fs.writeFileSync(files.mixed, makePdf([[612, 792], [612, 792], [595, 842], [842, 595], [300, 400], [612, 792]]));
  fs.writeFileSync(files.titled, makePdf(Array.from({ length: 30 }, () => [612, 792]), 'A Document Title From Metadata'));
  fs.writeFileSync(files.deck, F.deck({ slides: Array.from({ length: 12 }, (_, i) => ({ shapes: F.rect({ box: { x: 100, y: 100, w: 600, h: 200 }, color: i % 2 ? 'FFCC00' : '99CCFF', text: `Title of slide ${i + 1}` }) })) }));

  const app = await electron.launch({ args: [path.join(__dirname, '..')], env, timeout: 60000 });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await sleep(2000);
    const win0 = async () => (await app.evaluate(() => global.__windows.list()))[0];
    const find = (re) => app.evaluate(({ webContents }, src) => { const r = new RegExp(src); const wc = webContents.getAllWebContents().find((x) => r.test(decodeURIComponent(x.getURL()))); return wc ? wc.id : null; }, re.source);
    const run = (id, code) => app.evaluate(({ webContents }, [i, c]) => webContents.fromId(i).executeJavaScript(c), [id, code]);
    const open = async (file, re, hash = '') => { const w = await win0(); await app.evaluate((_, [wid, u]) => { global.__windows.open(wid, u); }, [w.windowId, pathToFileURL(file).href + hash]); return waitFor(() => find(re), 20000); };
    const closeTabs = async () => { const w = await win0(); for (const t of w.tabs.slice(1)) await app.evaluate(({ ipcMain }, id) => ipcMain.emit('tab:close', {}, id), t.id); await sleep(300); };
    // Every layout shift since the page began (buffered), with what moved; the sum leaves out the shifts that followed input, as CLS does.
    const OBSERVE = `(() => {
      window.__ls = [];
      const name = (n) => (n ? (n.id ? '#' + n.id : n.className ? '.' + String(n.className).split(' ')[0] : n.nodeName) : '?');
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__ls.push({ at: Math.round(e.startTime), value: Number(e.value.toFixed(4)), input: e.hadRecentInput,
        nodes: (e.sources || []).map((s) => name(s.node) + ' y ' + Math.round(s.previousRect.y) + '->' + Math.round(s.currentRect.y) + ' h ' + Math.round(s.previousRect.height) + '->' + Math.round(s.currentRect.height) + ' w ' + Math.round(s.previousRect.width) + '->' + Math.round(s.currentRect.width)) }); })
        .observe({ type: 'layout-shift', buffered: true });
      return 0;
    })()`;
    const shifts = async (id) => {
      await run(id, OBSERVE);
      await sleep(2500); // (late text layers, a metadata title and the slide viewer's drawing all finish within this)
      const list = await run(id, 'window.__ls');
      return { cls: list.filter((s) => !s.input).reduce((a, s) => a + s.value, 0), list };
    };
    const report = (label, r) => {
      if (process.env.VW_CLS_DUMP) console.log(JSON.stringify(r.list, null, 1));
      check(`${label}: layout shift ${r.cls.toFixed(4)} is under ${MAX_CLS}`, r.cls < MAX_CLS, JSON.stringify(r.list));
    };

    // ---- the PDF viewer
    for (const [label, key] of [['a 6-page PDF with pages of different sizes', 'mixed'], ['a 30-page PDF with a title in its metadata', 'titled']]) {
      const id = await open(files[key], /lumen-pdf:.*\.pdf/);
      check(`${label}: opens in the viewer`, Boolean(id), id);
      if (!id) continue;
      await waitFor(async () => (await run(id, 'window.lumenPdf ? window.lumenPdf.state().pages : 0')) > 0, 20000, 50);
      report(label, await shifts(id));
      const lay = await run(id, `(() => { const c = document.getElementById('viewerContainer'); const pages = [...document.querySelectorAll('.page')].map((p) => { const b = p.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), drawn: Boolean(p.querySelector('canvas')) }; }); return { cw: c.clientWidth, zoom: document.getElementById('zoom').value, pages }; })()`);
      const p0 = lay.pages[0];
      check(`${label}: page 1 fills the width at Fit width and is drawn`, Boolean(p0) && Math.abs(p0.w - lay.cw) <= 2 && p0.drawn && lay.zoom === 'page-width', JSON.stringify(lay));
      if (key === 'mixed') {
        const [a, , c, d, e] = lay.pages;
        check('pages of different sizes keep their own shapes', Math.abs(c.h / c.w - 842 / 595) < 0.02 && d.w > d.h && Math.abs(d.w / d.h - 842 / 595) < 0.02 && Math.abs(e.h / e.w - 400 / 300) < 0.02 && a.h > a.w, JSON.stringify(lay.pages));
      }
      await closeTabs();
    }

    // ---- the PDF viewer, other ways in: a reload, a tab opened behind another and switched to, and with the sidebar open
    {
      const switchTo = (tabId) => app.evaluate(({ ipcMain }, tabId2) => ipcMain.emit('tab:switch', {}, tabId2), tabId);
      let id = await open(files.titled, /lumen-pdf:.*titled.pdf/);
      await waitFor(async () => (await run(id, 'window.lumenPdf ? window.lumenPdf.state().pages : 0')) > 0, 20000, 50);
      await sleep(500);
      await run(id, 'setTimeout(() => location.reload(), 0); 0');
      await sleep(500);
      await waitFor(async () => (await run(id, 'window.lumenPdf ? window.lumenPdf.state().pages : 0')) > 0, 20000, 50);
      report('a PDF reloaded', await shifts(id));
      await closeTabs();

      const front = (await win0()).activeId;
      await open(files.titled, /lumen-pdf:.*titled.pdf/);
      await switchTo(front);
      await sleep(1500);
      id = await find(/lumen-pdf:.*titled.pdf/);
      await switchTo((await win0()).tabs.find((x) => x.contentsId === id).id);
      await waitFor(async () => (await run(id, 'window.lumenPdf ? window.lumenPdf.state().pages : 0')) > 0, 20000, 50);
      report('a PDF opened behind another tab, then switched to', await shifts(id));
      await closeTabs();

      await ui.click('#toggle-sidebar');
      await sleep(800);
      id = await open(files.titled, /lumen-pdf:.*titled.pdf/);
      await waitFor(async () => (await run(id, 'window.lumenPdf ? window.lumenPdf.state().pages : 0')) > 0, 20000, 50);
      report('a PDF opened with the sidebar open', await shifts(id));
      await closeTabs();
      await ui.click('#toggle-sidebar');
      await sleep(500);
    }

    // ---- a PDF reopened at the page being read (the address keeps #page=N), and at a zoom
    for (const hash of ['#page=20', '#page=12&zoom=150']) {
      const id = await open(files.titled, /lumen-pdf:.*titled.pdf/, hash);
      await waitFor(async () => (await run(id, 'window.lumenPdf ? window.lumenPdf.state().pages : 0')) > 0, 20000, 50);
      const r = await shifts(id);
      report(`a PDF opened at ${hash}`, r);
      const st = await run(id, 'window.lumenPdf.state()');
      check(`a PDF opened at ${hash}: lands on its page`, st.page === Number(/page=(\d+)/.exec(hash)[1]), JSON.stringify(st));
      await closeTabs();
    }

    // ---- the view changing size after it opened (DevTools docking, the sidebar, the window being resized)
    {
      const id = await open(files.titled, /lumen-pdf:.*titled.pdf/);
      await waitFor(async () => (await run(id, 'window.lumenPdf ? window.lumenPdf.state().pages : 0')) > 0, 20000, 50);
      await sleep(1000);
      await run(id, OBSERVE);
      await run(id, "document.body.style.paddingRight = '400px'; 0");
      await sleep(2500);
      const list = await run(id, 'window.__ls');
      report('a PDF while the window is made narrower', { cls: list.filter((x) => !x.input).reduce((a, x) => a + x.value, 0), list });
      await closeTabs();
    }

    // ---- the slide viewer
    {
      const id = await open(files.deck, /slides\.html/);
      check('the deck opens in the slide viewer', Boolean(id), id);
      if (id) {
        await waitFor(async () => (await run(id, 'document.body.dataset.ready')) === 'true', 30000);
        report('a 12-slide deck', await shifts(id));
        const n = await run(id, 'document.querySelectorAll(".frame").length');
        const w = await run(id, '(() => { const s = document.querySelector(".frame .slide").getBoundingClientRect(); return { w: Math.round(s.width), h: Math.round(s.height) }; })()');
        check(`the deck still shows its 12 slides, each 16:9 (${n}, ${w.w}x${w.h})`, n === 12 && w.w > 300 && Math.abs(w.w / w.h - 16 / 9) < 0.03, JSON.stringify(w));
      }
    }
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
