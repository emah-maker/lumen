/* global addFiles */
// Word, Excel and PowerPoint files show a preview wherever Lumen shows a file (hidden Electron run: LUMEN_TEST_BACKGROUND=1 CLAUDE_BROWSER_TEST=1, a
// fresh profile and TEMP of its own, no network). Files are made by test/helpers/_office-fixtures.js.
//   1. A tab: a .docx, an .xlsx and a .pptx opened as file: addresses show their content (a read-only page, a sheet grid with sheet tabs, the slides);
//      nothing in them runs, and the address bar shows the file.
//   2. An AI file card: a file the AI wrote gets the first page as a picture (a click opens the viewer tab); a file a reply only names gets no
//      preview and Open still asks first (#340).
//   3. The chat box: an attached .docx shows its first page beside its name.
//   4. The Files picker shows the first page of the selected Office file; the new-tab Files card shows it on hover.
//   5. The downloads panel row of a finished .xlsx shows its first sheet, with a Preview button that opens the viewer.
//   6. The thumbnail window leaves nothing behind (it closes when idle) and a second ask is served from the cache.
// PNGs of every preview (the thumbnails as drawn, and each tab) are written to LUMEN_SHOTS (default: a temp folder, printed at the end).
// Run: node test/e2e/office-previews.js (a throwaway profile, hidden windows).
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const fx = require('../helpers/_office-fixtures');

(async () => {
  let failures = 0;
  const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 20000, every = 120) => { const end = Date.now() + ms; for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v || Date.now() > end) return v; await sleep(every); } };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-office-'));
  const work = path.join(root, 'tmp'); const profile = path.join(root, 'profile'); const docs = path.join(root, 'docs'); const dl = path.join(root, 'downloads');
  for (const d of [work, profile, docs, dl]) fs.mkdirSync(d);
  const shots = process.env.LUMEN_SHOTS || path.join(root, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const file = { docx: path.join(docs, 'Quarterly Report.docx'), xlsx: path.join(docs, 'Budget 2026.xlsx'), pptx: path.join(docs, 'Launch Plan.pptx'), named: path.join(docs, 'Somebody Elses.docx'), attach: path.join(docs, 'Attached Notes.docx') };
  fs.writeFileSync(file.docx, fx.sampleDocx());
  fs.writeFileSync(file.xlsx, fx.sampleXlsx());
  fs.writeFileSync(file.pptx, fx.samplePptx());
  fs.writeFileSync(file.named, fx.sampleDocx());
  fs.writeFileSync(file.attach, fx.sampleDocx());
  const old = (Date.now() - 3600000) / 1000;
  fs.utimesSync(file.named, old, old); // (older than the run: a file the AI did not write)
  const url = (p) => pathToFileURL(p).href;
  const savePng = (name, dataUrl) => { const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl || ''); if (m) fs.writeFileSync(path.join(shots, name), Buffer.from(m[1], 'base64')); return Boolean(m); };

  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url.startsWith('/Budget.xlsx')) { res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="Web Budget.xlsx"' }); return res.end(fs.readFileSync(file.xlsx)); }
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Elsewhere</title><p>elsewhere</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: [{ id: 'wfiles001', type: 'files', x: 0, y: 0, w: 4, h: 7 }] })); // (the Files card on the new-tab page)
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: work, TMP: work, ANTHROPIC_API_KEY: 'sk-ant-test' };
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env, timeout: 60000 });
  let ui = null;
  try {
    ui = await app.firstWindow({ timeout: 60000 });
    const errors = [];
    ui.on('pageerror', (e) => errors.push(e.message));
    await ui.waitForSelector('.tab');
    await sleep(1500);
    await app.evaluate((_e, dir) => global.__patchSettings({ downloadDir: dir }), dl);
    await app.evaluate(() => global.__settings.backend.set('sidebarNewChat', false));

    const tabsOf = async () => ((await app.evaluate(() => global.__windows.list()))[0]?.tabs || []);
    const inTab = (id, code) => app.evaluate(({ webContents }, [i, c]) => { const wc = webContents.fromId(i); return wc ? wc.executeJavaScript(c).catch((e) => `ERR ${e.message}`) : null; }, [id, code]);
    const viewerOf = (kind, p) => async () => (await tabsOf()).find((t) => (kind === 'pptx' ? /\/renderer\/slides\.html/ : /\/renderer\/office\.html/).test(t.url || '') && (() => { try { return new URL(t.url).searchParams.get('u') === url(p); } catch { return false; } })());
    const openFile = async (kind, p) => { await app.evaluate((_e, f) => global.__windows.open(global.__windows.list()[0].windowId, f), url(p)); return waitFor(viewerOf(kind, p), 15000); };
    const capture = (id) => app.evaluate(async ({ webContents }, i) => { const wc = webContents.fromId(i); const img = await wc.capturePage(); return img.isEmpty() ? '' : `data:image/png;base64,${img.toPNG().toString('base64')}`; }, id);
    const selectTab = async (t) => { await app.evaluate(({ webContents }, id) => { const wc = webContents.fromId(id); wc.focus(); }, t.contentsId).catch(() => {}); };

    // ---------- 1. the tabs ----------
    console.log('--- tabs');
    const docTab = await openFile('docx', file.docx);
    check('a local .docx opens in Lumen\'s Word viewer (not a download, not another program)', Boolean(docTab), JSON.stringify((await tabsOf()).map((t) => t.url.slice(-60))));
    const doc = await waitFor(async () => { const s = await inTab(docTab.contentsId, `(() => document.body.dataset.ready === 'true' ? ({ title: document.title, kind: document.getElementById('kind').textContent, text: document.querySelector('.paper')?.innerText || '', h1: document.querySelector('p.h1')?.textContent, title1: document.querySelector('p.title')?.textContent, bold: !!document.querySelector('span[style*="font-weight: 700"]'), marks: [...document.querySelectorAll('.mark')].map((m) => m.textContent), cells: [...document.querySelectorAll('.paper td')].map((c) => c.textContent), shaded: !!document.querySelector('.paper td[style*="background"]'), img: (() => { const i = document.querySelector('.paper img'); return i ? { w: i.naturalWidth, shown: i.getBoundingClientRect().width } : null; })(), hr: !!document.querySelector('.paper hr'), link: document.querySelector('.paper .link')?.title, csp: document.querySelector('meta[http-equiv]').content, scripts: document.scripts.length }) : null)()`); return s && typeof s === 'object' ? s : null; }, 15000);
    check('the document page shows the title, heading, formatting, lists, table and picture', doc && doc.title1 === 'Quarterly Report' && doc.h1 === 'Summary' && doc.bold && doc.marks.join(' ') === '• • ◦ 1. 2. a.' && doc.cells.includes('North') && doc.shaded && doc.img && doc.img.w === 60 && doc.hr && /Second page text/.test(doc.text), JSON.stringify(doc).slice(0, 400));
    check('it is read-only and says so; a link is shown, not followed', doc && /read-only/.test(doc.kind) && doc.link === 'https://example.com/');
    check('its CSP allows no network and the page has no scripts but its own', doc && /default-src 'none'/.test(doc.csp) && /img-src data:/.test(doc.csp) && doc.scripts === 1, doc && doc.csp);
    const shownTitles = await waitFor(async () => { const x = await ui.$$eval('.tab .tab-title', (els) => els.map((e) => e.textContent)); return x.includes('Quarterly Report.docx') && x; }, 8000);
    check('the tab strip shows the file name as the title', Boolean(shownTitles), JSON.stringify(await ui.$$eval('.tab .tab-title', (els) => els.map((e) => e.textContent))));
    await selectTab(docTab);
    const docShot = await capture(docTab.contentsId);
    check('the document tab paints (a PNG was captured)', savePng('tab-docx.png', docShot) && docShot.length > 5000, docShot.length);

    const xlTab = await openFile('xlsx', file.xlsx);
    check('a local .xlsx opens in the Excel viewer', Boolean(xlTab));
    const xl = await waitFor(async () => { const s = await inTab(xlTab.contentsId, `(() => document.body.dataset.ready === 'true' ? ({ kind: document.getElementById('kind').textContent, tabs: [...document.querySelectorAll('#sheets button')].map((b) => b.textContent), hidden: document.getElementById('sheets').hidden, heads: [...document.querySelectorAll('.grid thead th')].map((h) => h.textContent).join(''), rows: [...document.querySelectorAll('.grid tbody tr')].map((r) => [...r.children].map((c) => c.textContent)), merged: document.querySelector('.grid td[colspan]')?.colSpan, head: (() => { const c = [...document.querySelectorAll('.grid td')].find((x) => x.textContent === 'Item'); return c ? { fw: c.style.fontWeight, bg: c.style.background, color: c.style.color } : null; })(), num: document.querySelector('.grid td.num')?.textContent }) : null)()`); return s && typeof s === 'object' ? s : null; }, 15000);
    check('the sheet shows column letters, row numbers and the cells (strings, numbers, a percent, a date)', xl && xl.heads.includes('ABCD') && xl.rows[2].join('|').includes('Rent|1200.5|60%|2026-01-01'), JSON.stringify(xl).slice(0, 400));
    check('a merged title spans its columns, the header row is bold with its fill', xl && xl.merged === 4 && xl.head && xl.head.fw === '700' && /rgb\(68, 114, 196\)/.test(xl.head.bg), JSON.stringify(xl && xl.head));
    check('sheet tabs list the visible sheets only (a hidden sheet is not offered)', xl && xl.tabs.join() === 'Budget,Notes' && xl.hidden === false, JSON.stringify(xl && xl.tabs));
    await inTab(xlTab.contentsId, `document.querySelectorAll('#sheets button')[1].click()`);
    const second = await waitFor(async () => { const t = await inTab(xlTab.contentsId, `document.querySelector('.grid')?.innerText || ''`); return /Second sheet note/.test(t) ? t : null; }, 5000);
    check('clicking a sheet tab shows that sheet', Boolean(second));
    await inTab(xlTab.contentsId, `document.querySelectorAll('#sheets button')[0].click()`);
    await selectTab(xlTab);
    const xlShot = await capture(xlTab.contentsId);
    check('the sheet tab paints (a PNG was captured)', savePng('tab-xlsx.png', xlShot) && xlShot.length > 5000, xlShot.length);

    const ppTab = await openFile('pptx', file.pptx);
    check('a local .pptx still opens in the slide viewer', Boolean(ppTab));
    const slides = await waitFor(async () => { const s = await inTab(ppTab.contentsId, `document.body.dataset.ready === 'true' ? document.getElementById('slides').innerText : null`); return typeof s === 'string' && /Launch plan/.test(s) ? s : null; }, 15000);
    check('...and shows its slides', /Launch plan/.test(slides || '') && /Second slide/.test(slides || ''), slides);
    await selectTab(ppTab);
    const ppShot = await capture(ppTab.contentsId);
    check('the slide tab paints (a PNG was captured)', savePng('tab-pptx.png', ppShot) && ppShot.length > 5000, ppShot.length);

    // a damaged file says so on the page instead of a blank tab
    const broken = path.join(docs, 'Broken.docx');
    fs.writeFileSync(broken, Buffer.from('this is not a word file'));
    const brokenTab = await openFile('docx', broken);
    const msg = brokenTab && await waitFor(async () => { const s = await inTab(brokenTab.contentsId, `document.body.dataset.ready === 'error' ? document.querySelector('.message')?.innerText : null`); return typeof s === 'string' && s ? s : null; }, 10000);
    check('a damaged .docx shows a plain message (and never the path)', /can.t be shown/.test(msg || '') && /not a Word document/.test(msg || '') && !(msg || '').includes(docs), msg);

    // a .docx from the web is saved as usual (not opened in a tab behind the user's back), and the panel offers Preview
    const before = (await tabsOf()).length;
    await app.evaluate((_e, u) => global.__windows.open(global.__windows.list()[0].windowId, u), `${base}/page`);
    const web = await waitFor(async () => (await tabsOf()).find((t) => t.url === `${base}/page`), 10000);
    await app.evaluate(({ webContents }, [id, u]) => webContents.fromId(id).downloadURL(u), [web.contentsId, `${base}/Budget.xlsx`]);
    const savedWeb = path.join(dl, 'Web Budget.xlsx');
    check('an .xlsx downloaded from a web page is saved to the downloads folder', Boolean(await waitFor(() => fs.existsSync(savedWeb), 10000)));
    await sleep(600);
    check('...and does not open a tab by itself', (await tabsOf()).length === before + 1);

    // ---------- 5. the downloads panel ----------
    console.log('--- downloads panel');
    const row = await waitFor(async () => { const l = await app.evaluate(() => global.__downloads.panelList()); const r = l.find((x) => x.name === 'Web Budget.xlsx' && x.thumb); return r || null; }, 30000);
    check('the panel row of the finished .xlsx carries its first sheet as a picture, and is an Office row', row && row.office === true && /^data:image\/png;base64,/.test(row.thumb), JSON.stringify(row && { ...row, thumb: row.thumb && row.thumb.slice(0, 30) }));
    if (row) savePng('download-row-xlsx.png', row.thumb);
    const dlId = row && row.id;
    const tabsBefore = (await tabsOf()).length;
    await app.evaluate((_e, id) => global.__managers.downloads.act(id, 'preview'), dlId);
    const previewTab = await waitFor(viewerOf('xlsx', savedWeb), 10000);
    check('its Preview button opens the Excel viewer in a tab', Boolean(previewTab) && (await tabsOf()).length === tabsBefore + 1);
    const panelShot = await app.evaluate(async ({ webContents }) => { const wc = global.__downloads.panel(); if (!wc) return ''; global.__downloads.show?.({ x: 100, y: 40 }); await new Promise((r) => setTimeout(r, 600)); const img = await wc.capturePage(); return img.isEmpty() ? '' : `data:image/png;base64,${img.toPNG().toString('base64')}`; }).catch(() => '');
    if (panelShot) { savePng('downloads-panel.png', panelShot); await app.evaluate(() => global.__downloads.hide?.()).catch(() => {}); }

    // ---------- 2. the AI file card ----------
    console.log('--- AI card');
    await app.evaluate((_e, P) => {
      const agent = global.__agent;
      agent.run = async (text, emit) => {
        const engine = { freshRoots: () => [P.docs] };
        const named = /named/.test(text);
        const body = named ? { text: `Their notes are in \`${P.named}\`.`, written: [] } : { text: `Made the files: ${P.docx}, ${P.xlsx} and ${P.pptx}.`, written: [P.docx, P.xlsx, P.pptx] };
        agent.messages.push({ role: 'user', content: text });
        emit({ type: 'turn_start' });
        emit({ type: 'text', text: body.text });
        emit({ type: 'reply_complete' });
        const blocks = await agent.engineFiles(body.text, engine, emit, { since: Date.now() - 60000, written: body.written });
        agent.messages.push({ role: 'assistant', content: [{ type: 'text', text: body.text }, ...blocks] });
        emit({ type: 'done', model: 'claudecode:auto' });
      };
      global.__shellCalls = [];
      global.__aiFileShell = (how, p) => { global.__shellCalls.push([how, p]); return { ok: true }; };
    }, { docs, docx: file.docx, xlsx: file.xlsx, pptx: file.pptx, named: file.named });
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
    await ui.waitForTimeout(400);
    await ui.fill('#prompt', 'make me a report, a budget and a deck');
    await ui.press('#prompt', 'Enter');
    const cards = await waitFor(() => ui.evaluate(() => { const c = [...document.querySelectorAll('.ai-file')]; return c.length >= 3 && c.every((x) => x.querySelector('.ai-file-thumb')) ? c.map((x) => ({ name: x.querySelector('.ai-file-name').textContent, kind: x.className, buttons: [...x.querySelectorAll('.ai-file-btn')].map((b) => b.textContent || b.title), src: x.querySelector('.ai-file-thumb').src, w: x.querySelector('.ai-file-thumb').naturalWidth, skeleton: !!x.querySelector('.ai-file-skeleton') })) : null; }), 60000);
    check('each of the three files gets a card with its first page as a picture', cards && cards.length === 3 && cards.every((c) => /^data:image\/png;base64,/.test(c.src) && c.w > 100 && !c.skeleton), JSON.stringify(cards && cards.map((c) => [c.name, c.w])));
    check('the cards are Word, Excel and PowerPoint cards that open in a tab and in the app', cards && cards.every((c) => c.buttons.includes('Open') && c.buttons.includes('Open in app') && c.buttons.includes('Show in folder')), JSON.stringify(cards && cards.map((c) => c.buttons)));
    if (cards) for (const c of cards) savePng(`card-${/\.(\w+)$/.exec(c.name)[1]}.png`, c.src);
    // the thumbnails really are the pages: a pixel probe of the docx (white paper) and the pptx (the blue title box)
    const probe = await ui.evaluate(async () => {
      const read = async (src) => { const img = new Image(); img.src = src; await img.decode(); const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return { w: c.width, h: c.height, at: (fx, fy) => [...g.getImageData(Math.floor(fx * c.width), Math.floor(fy * c.height), 1, 1).data] }; };
      const urls = [...document.querySelectorAll('.ai-file')].map((x) => [x.querySelector('.ai-file-name').textContent, x.querySelector('.ai-file-thumb').src]);
      const out = {};
      for (const [name, src] of urls) { const p = await read(src); out[name] = { w: p.w, h: p.h, corner: p.at(0.02, 0.02), center: p.at(0.5, 0.5), titleBox: p.at(0.25, 0.18), header: p.at(0.2, 0.06) }; }
      return out;
    });
    const pp = probe['Launch Plan.pptx'];
    const dc = probe['Quarterly Report.docx'];
    const xs = probe['Budget 2026.xlsx'];
    check('the PowerPoint thumbnail is the first slide (its blue title box is where the slide has it)', pp && pp.titleBox[2] > 150 && pp.titleBox[0] < 120, JSON.stringify(pp));
    check('the Word thumbnail is a white page, portrait', dc && dc.h > dc.w && dc.corner.every((v) => v > 240), JSON.stringify(dc));
    check('the Excel thumbnail is the grid with the blue header band near its top', xs && xs.w > xs.h && xs.corner.every((v) => v > 200), JSON.stringify(xs));
    // clicking the picture opens the viewer tab
    const tabsB = (await tabsOf()).length;
    await ui.evaluate(() => document.querySelector('.ai-file .ai-file-thumbbtn').click());
    const opened = await waitFor(async () => (await tabsOf()).length > tabsB, 8000);
    check('clicking a card\'s picture opens the viewer in a tab', Boolean(opened));
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click()); // (the viewer tab has its own sidebar state: open it here)
    await ui.waitForSelector('#prompt', { state: 'visible', timeout: 10000 });
    const cardShot = await ui.locator('.ai-files').first().screenshot().catch(() => null);
    if (cardShot) fs.writeFileSync(path.join(shots, 'chat-ai-cards.png'), cardShot);

    await ui.fill('#prompt', 'where are their notes? named');
    await ui.press('#prompt', 'Enter');
    const named = await waitFor(() => ui.evaluate(() => { const c = [...document.querySelectorAll('.ai-file')].find((x) => x.querySelector('.ai-file-name').textContent === 'Somebody Elses.docx'); return c ? { thumb: !!c.querySelector('.ai-file-thumb, .ai-file-skeleton'), named: c.classList.contains('ai-file-named'), buttons: [...c.querySelectorAll('.ai-file-btn')].map((b) => b.textContent) } : null; }), 30000);
    check('a file a reply only names gets a card with no preview, as before', named && !named.thumb && named.named, JSON.stringify(named));
    await ui.evaluate(() => [...document.querySelectorAll('.ai-file')].find((x) => x.querySelector('.ai-file-name').textContent === 'Somebody Elses.docx').querySelector('.ai-file-btn').click());
    const asked = await waitFor(() => ui.evaluate(() => !!document.querySelector('.ai-file-ask')), 5000);
    check('...and opening it still asks first (#340)', Boolean(asked));

    // ---------- 3. the chat box ----------
    console.log('--- chat box');
    const chip = await ui.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await addFiles([new File([bytes], 'Attached Notes.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })]);
      const end = Date.now() + 40000;
      while (Date.now() < end) { const t = document.querySelector('.attachment .attachment-thumb'); if (t && t.complete && t.naturalWidth) return { src: t.src, w: t.naturalWidth, name: document.querySelector('.attachment .attachment-name').textContent, ext: document.querySelector('.attachment .attachment-ext').textContent }; await new Promise((r) => setTimeout(r, 150)); }
      return null;
    }, fs.readFileSync(file.attach).toString('base64'));
    check('an attached .docx shows its first page beside its name and type', chip && chip.w > 100 && chip.name === 'Attached Notes.docx' && chip.ext === 'DOCX', JSON.stringify(chip && { ...chip, src: chip.src.slice(0, 30) }));
    if (chip) savePng('chip-docx.png', chip.src);
    const chipShot = await ui.locator('#attachments').screenshot().catch(() => null);
    if (chipShot) fs.writeFileSync(path.join(shots, 'chat-box-chip.png'), chipShot);
    await ui.evaluate(() => { document.querySelector('.attachment .attachment-remove')?.click(); });

    // ---------- 4. the Files picker and the new-tab card ----------
    console.log('--- files');
    await app.evaluate((_e, f) => global.__files.note(f, { source: 'tab' }), file.docx);
    await app.evaluate((_e, f) => global.__files.note(f, { source: 'tab' }), file.xlsx);
    const wide = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('index.html')); w.setContentSize(1400, 900); return w.getContentSize(); });
    await sleep(500);
    await ui.evaluate(() => window.filesPicker.open());
    await ui.waitForSelector('#files-picker:not([hidden])');
    await ui.fill('#files-picker-input', 'quarterly');
    const picked = await waitFor(() => ui.evaluate(() => { const i = document.querySelector('.files-picker-preview:not([hidden]) img'); return i && i.complete && i.naturalWidth ? { src: i.src, w: i.naturalWidth, row: document.querySelector('.files-picker-item.selected .files-picker-name')?.textContent } : null; }), 40000);
    check('the picker shows the first page of the selected Word file beside the list', picked && picked.row === 'Quarterly Report.docx' && picked.w > 100, JSON.stringify(picked && { ...picked, src: '' }) + JSON.stringify(wide));
    if (picked) savePng('picker-docx.png', picked.src);
    const pickerShot = await ui.screenshot().catch(() => null);
    if (pickerShot) fs.writeFileSync(path.join(shots, 'picker-window.png'), pickerShot);
    await ui.fill('#files-picker-input', 'zzzz');
    await sleep(500);
    const hiddenAgain = await ui.evaluate(() => document.querySelector('.files-picker-preview').hidden);
    check('the card goes away when the selection is no Office file', hiddenAgain === true);
    await ui.keyboard.press('Escape');

    const ntId = await app.evaluate(async () => { const t = global.__agent.browser.openTab(); await new Promise((r) => t.webContents.once('did-finish-load', r)); return t.webContents.id; });
    const nt = ntId ? { contentsId: ntId } : null;
    if (nt) {
      await sleep(1500);
      await app.evaluate(({ webContents }, id) => webContents.fromId(id).focus(), nt.contentsId).catch(() => {});
      const spot = await waitFor(() => inTab(nt.contentsId, `(() => { const b = [...document.querySelectorAll('.fl-main')].find((x) => /Quarterly Report/.test(x.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + 30), y: Math.round(r.top + r.height / 2) }; })()`), 15000);
      check('the new-tab Files card lists the Word file', Boolean(spot));
      if (spot) {
        await inTab(nt.contentsId, `[...document.querySelectorAll('.fl-main')].find((x) => /Quarterly Report/.test(x.textContent)).dispatchEvent(new PointerEvent('pointerenter'))`); // (a background test tab gets no real pointer: the row's own event is sent)
        const hover = await waitFor(() => inTab(nt.contentsId, `(() => { const i = document.querySelector('.fl-preview img'); return i && i.complete && i.naturalWidth ? { w: i.naturalWidth, src: i.src } : null; })()`), 30000);
        check('hovering the Word file in the new-tab Files card shows its first page', hover && hover.w > 100, JSON.stringify(hover && { ...hover, src: '' }));
        if (hover) savePng('newtab-hover-docx.png', hover.src);
        const ntShot = await capture(nt.contentsId);
        savePng('newtab-files-hover.png', ntShot);
        await inTab(nt.contentsId, `[...document.querySelectorAll('.fl-main')].find((x) => /Quarterly Report/.test(x.textContent)).dispatchEvent(new PointerEvent('pointerleave'))`);
        const gone = await waitFor(() => inTab(nt.contentsId, `!document.querySelector('.fl-preview')`), 5000);
        check('...and it goes when the pointer leaves', Boolean(gone));
      }
    } else check('the new-tab page opens', false);

    // ---------- 6. the thumbnail window ----------
    console.log('--- thumbnail window');
    const cache = path.join(profile, 'office-thumb-cache');
    const keychain = await app.evaluate(({ safeStorage }) => safeStorage.isEncryptionAvailable());
    const cached = fs.existsSync(cache) ? fs.readdirSync(cache).filter((n) => n.endsWith('.thumb')) : [];
    check('the thumbnails are kept on disk, encrypted, by file, size and time (one per file; none without a keychain)', keychain ? cached.length >= 3 && cached.every((n) => !fs.readFileSync(path.join(cache, n)).includes(Buffer.from('iVBOR'))) : cached.length === 0, `${keychain} ${cached.length}`);
    check('nothing from a file reached the network, and no page error was raised', hits.every((u) => u === '/page' || u === '/favicon.ico' || u.startsWith('/Budget.xlsx')) && errors.length === 0, `${hits.join()} ${errors.join()}`);
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible()).length);
    check('no visible window beyond the browser\'s own was left behind', windows <= 1, windows);
    console.log(`PNGs: ${shots}`);
  } finally {
    try { await app.close(); } catch { /* gone */ }
    server.close();
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp */ }
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
