// Print preview in a real Lumen (one throwaway instance, windows invisible): Ctrl+P's sheet opens over a local
// page, renders the pages with printToPDF into the built-in PDF viewer, Landscape and Background graphics change
// the output, a custom page range is checked, Esc closes it, and Save writes a real PDF (through a stubbed save
// dialog, since a native one can't be clicked) whose pages match the count the sheet showed.
// Run with LUMEN_TEST_BACKGROUND=1; LUMEN_SHOT_DIR=<dir> keeps a screenshot of the sheet.
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const SHOT_DIR = process.env.LUMEN_SHOT_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-print-test-'));
  const profile = path.join(dir, 'profile');
  const page = path.join(dir, 'doc.html');
  // A few pages of text, with a colored block (a background graphic that "Background graphics" turns on).
  fs.writeFileSync(page, `<!doctype html><title>Quarterly: report / draft?</title><body style="font:16px sans-serif;background:#fff;color:#111">
    <div style="background:#2a6fdb;color:#fff;padding:20px">Colored block</div>
    ${Array.from({ length: 70 }, (_, i) => `<p>Line ${i + 1}. The quick brown fox jumps over the lazy dog, again and again.</p>`).join('\n')}</body>`);

  const app = await electron.launch({ args: [root], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate(async ({ webContents }, url) => {
      for (let i = 0; i < 100 && !webContents.getAllWebContents().some((w) => w.getURL().includes('newtab.html')); i++) await new Promise((r) => setTimeout(r, 100));
      const tab = webContents.getAllWebContents().find((w) => w.getURL().includes('newtab.html'));
      global.__printTab = tab;
      await new Promise((r) => setTimeout(r, 1200)); // (the new-tab page settles first)
      for (let i = 0; i < 20 && tab.getURL() !== url; i++) { await tab.loadURL(url).catch(() => {}); await new Promise((r) => setTimeout(r, 300)); }
      for (let i = 0; i < 50 && (tab.isLoading() || !(await tab.executeJavaScript("document.body && document.body.textContent.includes('Line 70')").catch(() => false))); i++) await new Promise((r) => setTimeout(r, 100));
    }, pathToFileURL(page).href);

    const savedTo = (name) => path.join(dir, name);
    // Opens the sheet over the tab, with the save dialog answered by `file` (or cancelled when null).
    const open = async (file) => {
      await app.evaluate((_e, file) => {
        const { printPreview, printTab } = global.__printPreview;
        printPreview.pickers.save = async () => (file ? { canceled: false, filePath: file } : { canceled: true });
        global.__printClosed = false;
        printTab(global.__printTab);
      }, file);
      return waitFor(() => app.evaluate(() => Boolean(global.__printPreview.printPreview.isOpen())));
    };
    const sheet = (script) => app.evaluate(async (_e, script) => {
      const wc = global.__printPreview.printPreview.overlayContents();
      if (!wc) return null;
      return wc.executeJavaScript(script);
    }, script);
    const waitFor = async (fn, ms = 15000) => {
      const end = Date.now() + ms;
      for (;;) {
        const v = await fn().catch(() => null);
        if (v || Date.now() > end) return v;
        await sleep(150);
      }
    };
    const count = () => sheet("document.getElementById('count').textContent");
    const waitCount = (re) => waitFor(async () => { const c = await count(); return c && re.test(c) ? c : null; });
    const setSelect = (id, value) => sheet(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const setCheck = (id, on) => sheet(`(() => { const el = document.getElementById(${JSON.stringify(id)}); if (el.checked !== ${on}) el.click(); })()`);
    const pages = (c) => Number(/(\d+) page/.exec(c)[1]);
    const mediaBox = (buf) => { const m = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(buf.toString('latin1')); return m && [Number(m[1]), Number(m[2])]; };
    const countPages = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length;

    // ---- opens as Save as PDF with the pages rendered
    check('Print opens the preview over the tab', await open(savedTo('a.pdf')));
    const first = await waitCount(/\d+ pages?/);
    check('the preview renders the pages (shown as a page count)', first, first);
    check('Save as PDF is the destination, with a Save button', await sheet("document.getElementById('destination').value === '__pdf__' && document.getElementById('go').textContent === 'Save'"));
    check('a printer-only setting (Copies) is hidden for a PDF', await sheet("document.getElementById('row-copies').hidden === true"));
    const viewerUp = await waitFor(() => app.evaluate(() => {
      const wc = global.__printPreview.printPreview.pdfContents();
      return wc && /\/preview-\d+\.pdf/.test(wc.getURL()) && wc.mainFrame.framesInSubtree.some((f) => String(f.url).startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai'));
    }), 20000);
    check('the pages are shown by the built-in PDF viewer', viewerUp);
    const portraitPages = pages(first);
    check('the document runs over more than one page', portraitPages >= 2, first);

    // ---- an invalid then a valid custom range
    await setSelect('pages', 'custom');
    await sheet("(() => { const el = document.getElementById('ranges'); el.value = '5-2'; el.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await sleep(500);
    check('a bad range shows an error and turns Save off', await sheet("!document.getElementById('ranges-error').hidden && document.getElementById('go').disabled"));
    await sheet("(() => { const el = document.getElementById('ranges'); el.value = '1'; el.dispatchEvent(new Event('input', { bubbles: true })); })()");
    check('a custom range "1" previews one page', await waitCount(/^1 page$/));
    await sheet("(() => { const el = document.getElementById('ranges'); el.value = '1-99'; el.dispatchEvent(new Event('input', { bubbles: true })); })()");
    check('a page past the end is out of range', await waitFor(() => sheet("!document.getElementById('ranges-error').hidden && /Out of range/.test(document.getElementById('ranges-error').textContent)")));
    await setSelect('pages', 'all');
    check('All pages again', await waitCount(new RegExp(`^${portraitPages} pages$`)), await sheet("JSON.stringify([document.getElementById('count').textContent, document.getElementById('stage-note').textContent, document.getElementById('stage-note').hidden, document.getElementById('pages').value, document.getElementById('ranges-error').textContent])"));

    // ---- landscape and background graphics
    await setSelect('layout', 'landscape');
    const landscapePages = pages(await waitFor(async () => { const c = await count(); return c && pages(c) !== portraitPages ? c : null; }) || '0 pages');
    check('Landscape changes the pages (more of them, as the sheet is shorter)', landscapePages > portraitPages, `${portraitPages} -> ${landscapePages}`);
    await setCheck('background', true);
    await sleep(2500);
    if (SHOT_DIR) await shot(app, SHOT_DIR);

    // ---- Save writes the PDF the preview shows (with landscape and the background)
    await sheet("document.getElementById('go').click()");
    const wrote = await waitFor(async () => fs.existsSync(savedTo('a.pdf')) && fs.statSync(savedTo('a.pdf')).size > 500);
    check('Save wrote the file the dialog gave', wrote);
    const a = wrote ? fs.readFileSync(savedTo('a.pdf')) : Buffer.alloc(0);
    check('it is a PDF', a.slice(0, 5).toString() === '%PDF-', a.slice(0, 10).toString());
    check('its page count is the one the sheet showed', countPages(a) === landscapePages, `${countPages(a)} vs ${landscapePages}`);
    const boxA = mediaBox(a);
    check('Landscape: the pages are wider than tall', boxA && boxA[0] > boxA[1], JSON.stringify(boxA));
    check('the sheet closes after saving', await waitFor(() => app.evaluate(() => !global.__printPreview.printPreview.isOpen())));

    // ---- it remembers its settings; toggled back, the output changes
    check('it opens again', await open(savedTo('b.pdf')));
    await waitCount(/\d+ pages?/);
    check('it remembers Landscape and Background graphics', await sheet("document.getElementById('layout').value === 'landscape' && document.getElementById('background').checked"));
    await setSelect('layout', 'portrait');
    await setCheck('background', false);
    await waitCount(new RegExp(`^${portraitPages} pages?$`));
    await sleep(500);
    await sheet("document.getElementById('go').click()");
    const wroteB = await waitFor(async () => fs.existsSync(savedTo('b.pdf')) && fs.statSync(savedTo('b.pdf')).size > 500);
    const b = wroteB ? fs.readFileSync(savedTo('b.pdf')) : Buffer.alloc(0);
    const boxB = mediaBox(b);
    check('portrait again, with the page count it had', wroteB && countPages(b) === portraitPages && boxB && boxB[0] < boxB[1], `${countPages(b)} ${JSON.stringify(boxB)}`);
    check('without the background graphic the file differs from the one with it', wroteB && a.length !== b.length, `${a.length} vs ${b.length}`);

    // ---- Esc cancels, a cancelled save dialog keeps the sheet, nothing is left in the temp folder
    check('it opens once more', await open(null));
    await waitCount(/\d+ pages?/);
    await sheet("document.getElementById('go').click()");
    await sleep(700);
    check('a cancelled save dialog leaves the sheet open', await app.evaluate(() => global.__printPreview.printPreview.isOpen()));
    const tmpDirs = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('lumen-print-') && !n.startsWith('lumen-print-test-'));
    await sheet("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    check('Esc closes the sheet', await waitFor(() => app.evaluate(() => !global.__printPreview.printPreview.isOpen())));
    await sleep(300);
    check('the preview left no temp files behind', tmpDirs().length === 0, tmpDirs().join(','));
  } catch (err) {
    failures++;
    console.log(`FAIL  ${err.stack || err.message}`);
  } finally {
    await app.close().catch(() => {});
    try { app.process().kill('SIGKILL'); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); } catch {}
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();

// One image of the sheet: the settings panel and the PDF view are two views, so each is captured and the
// two are put side by side in a hidden window.
async function shot(app, outDir) {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const pp = global.__printPreview.printPreview;
    const o = await pp.overlayContents().capturePage();
    const pdfWc = pp.pdfContents();
    const p = pdfWc ? await pdfWc.capturePage() : null;
    const ow = o.getSize().width;
    const oh = o.getSize().height;
    const pw = p ? (p.getSize().width / ow) * 100 : 0;
    const ph = p ? (p.getSize().height / oh) * 100 : 0;
    const win = new BrowserWindow({ show: false, width: 1400, height: Math.round(1400 * oh / ow), useContentSize: true });
    const html = '<body style="margin:0;background:#888;overflow:hidden"><img src="data:image/png;base64,' + o.toPNG().toString('base64') + '" style="position:absolute;left:0;top:0;width:100%;height:100%">'
      + (p ? '<img src="data:image/png;base64,' + p.toPNG().toString('base64') + '" style="position:absolute;left:0;top:0;width:' + pw + '%;height:' + ph + '%">' : '') + '</body>';
    await win.loadURL('data:text/html,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 500));
    const out = (await win.webContents.capturePage()).toPNG().toString('base64');
    win.destroy();
    return out;
  });
  fs.writeFileSync(path.join(outDir, 'print-preview.png'), Buffer.from(png, 'base64'));
}
