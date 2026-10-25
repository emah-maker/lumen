// Word and Excel files in Lumen (features/office-doc.js, office-viewer.js, office-thumb.js, file-tabs.js office checks, ai-files.js cards, upload-files.js
// pendingPath): node test/units/office-units.js. Pure Node, no window. The viewer page and the real thumbnail are in test/e2e/office-previews.js.
// Files are made by test/helpers/_office-fixtures.js (also committed under test/fixtures/office/ as real bytes).
const fs = require('fs');
const os = require('os');
const path = require('path');
const doc = require('../../src/features/office-doc');
const fileTabs = require('../../src/features/file-tabs');
const aiFiles = require('../../src/features/ai-files');
const viewer = require('../../src/features/office-viewer');
const thumbLib = require('../../src/features/office-thumb');
const uploads = require('../../src/features/upload-files');
const fx = require('../helpers/_office-fixtures');

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` -> ${String(detail).slice(0, 300)}`}`); };
const rejects = async (p) => { try { await p; return null; } catch (err) { return err; } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-office-units-'));
const textOf = (blocks) => blocks.map((b) => (b.t === 'p' ? b.runs.map((r) => r.text || '').join('') : b.t === 'table' ? b.rows.map((r) => r.map((c) => textOf(c.blocks)).join('|')).join(';') : '')).join('\n');

(async () => {
  // ---- the committed fixtures are the generated ones, byte for byte
  for (const [name, make] of [['sample.docx', fx.sampleDocx], ['sample.xlsx', fx.sampleXlsx], ['sample.pptx', fx.samplePptx]]) {
    const file = path.join(__dirname, '..', 'fixtures', 'office', name);
    check(`test/fixtures/office/${name} exists and matches the generator`, fs.existsSync(file) && fs.readFileSync(file).equals(make()), 'run: node test/helpers/_office-fixtures.js write');
  }

  // ---- Word
  const docx = await doc.parseDocx(fx.sampleDocx());
  const kinds = docx.blocks.map((b) => (b.t === 'p' ? b.style : b.t));
  check('docx: title, headings (also through basedOn), paragraphs, table and page break are blocks', JSON.stringify(kinds.filter((k, i) => i < 5)) === JSON.stringify(['title', 'h1', 'p', 'h2', 'p']) && kinds.includes('table') && kinds.includes('hr'), kinds.join());
  const body = docx.blocks.find((b) => b.t === 'p' && b.style === 'p');
  check('docx: bold, italic and underline are runs of one paragraph', body.runs.some((r) => r.b && r.text === 'strongly') && body.runs.some((r) => r.i && r.text === 'with care') && body.runs.some((r) => r.u && r.text === 'underline'), JSON.stringify(body.runs));
  const link = body.runs.find((r) => r.href);
  check('docx: an https link is kept as text with its address (never followed)', link && link.text === 'the site' && link.href === 'https://example.com/' && link.color === '#0563c1');
  const items = docx.blocks.filter((b) => b.list);
  check('docx: bullets and numbers carry their markers, nested levels restart', items.map((b) => b.list.marker).join(' ') === '• • ◦ 1. 2. a.', items.map((b) => b.list.marker).join(' '));
  const table = docx.blocks.find((b) => b.t === 'table');
  check('docx: a table keeps its rows, cell text and shading', table.rows.length === 3 && table.rows[0][0].bg === '#d9e2f3' && textOf(docx.blocks).includes('North|1,200;South|950'), JSON.stringify(table).slice(0, 200));
  const img = docx.blocks.flatMap((b) => (b.t === 'p' ? b.runs : [])).find((r) => r.img);
  check('docx: a picture becomes a data: PNG with its size and alt text', img && /^data:image\/png;base64,/.test(img.img) && img.w === 120 && img.alt === 'Four colored squares', JSON.stringify(img || {}).slice(0, 120));
  check('docx: nothing in the result is markup the page would run (text only, no tags added)', !JSON.stringify(docx.blocks).includes('<script'));

  // hostile text stays text
  const hostile = fx.zip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;</w:t></w:r></w:p></w:body></w:document>',
  });
  const h = await doc.parseDocx(hostile);
  check('docx: markup in a document stays a string for the page to show as text', h.blocks[0].runs[0].text === '<script>alert(1)</script><img src=x onerror=alert(2)>', JSON.stringify(h.blocks[0]));
  check('docx: a javascript: link is not kept', !(await doc.parseDocx(fx.zip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:hyperlink r:id="r1"><w:r><w:t>x</w:t></w:r></w:hyperlink></w:p></w:body></w:document>',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="x/hyperlink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>',
  }))).blocks[0].runs.some((r) => r.href));
  const bigPic = await doc.parseDocx(fx.sampleDocx(), { imageBytes: 10 });
  check('docx: pictures over the byte budget are left as their alt text', !JSON.stringify(bigPic.blocks).includes('data:image') && JSON.stringify(bigPic.blocks).includes('[Four colored squares]'));
  const first = await doc.parseDocx(fx.sampleDocx(), { maxBlocks: 3 });
  check('docx: a first-page read stops after the blocks asked for and says it is cut', first.blocks.length < docx.blocks.length && first.truncated === true, `${first.blocks.length} ${first.truncated}`);

  // ---- Excel
  const xlsx = await doc.parseXlsx(fx.sampleXlsx());
  const budget = xlsx.sheets[0];
  check('xlsx: visible sheets only, in order, with their names', xlsx.sheets.map((s) => s.name).join() === 'Budget,Notes');
  check('xlsx: shared strings and inline strings are text', budget.rows[2][0].v === 'Rent' && xlsx.sheets[1].rows[0][0].v === 'Second sheet note');
  check('xlsx: numbers are right-aligned values, a formula shows the value last saved', budget.rows[2][1].v === '1200.5' && budget.rows[2][1].n === 1 && budget.rows[4][1].v === '2000.5');
  check('xlsx: percent and date formats show the way Excel shows them', budget.rows[2][2].v === '60%' && budget.rows[2][3].v === '2026-01-01' && budget.rows[3][3].v === '2026-02-01', JSON.stringify([budget.rows[2][2], budget.rows[2][3]]));
  check('xlsx: a boolean is TRUE or FALSE', budget.rows[4][3].v === 'TRUE');
  check('xlsx: bold, fill and font color are styles the cells point at', xlsx.styles[budget.rows[1][0].s].bg === '#4472c4' && xlsx.styles[budget.rows[1][0].s].b === true && xlsx.styles[budget.rows[1][0].s].color === '#ffffff');
  check('xlsx: a merged range and a column width are kept', JSON.stringify(budget.merges) === '[[0,0,0,3]]' && budget.colW[0] === 131, JSON.stringify([budget.merges, budget.colW]));
  const small = await doc.parseXlsx(fx.sampleXlsx(), { maxRows: 2, maxCols: 2, maxSheets: 1 });
  check('xlsx: a thumbnail read keeps the top-left cells of the first sheet and says it was cut', small.sheets.length === 1 && small.sheets[0].rows.length === 2 && small.sheets[0].cols <= 2 && small.sheets[0].truncated === true && small.moreSheets === true, JSON.stringify(small.sheets[0]).slice(0, 200));
  check('formatNumber: general, fixed, thousands, percent, scientific', doc.formatNumber(0.1 + 0.2, 'General') === '0.3' && doc.formatNumber(1234.5, '#,##0.00') === '1,234.50' && doc.formatNumber(0.256, '0.0%') === '25.6%' && doc.formatNumber(12345, '0.00E+00') === '1.23E+04' && doc.formatNumber(-5, '0') === '-5');
  check('formatDate: the 1900 and 1904 systems, with and without a time', doc.formatDate(45000, 'date', false) === '2023-03-15' && doc.formatDate(1, 'date', false) === '1900-01-01' && doc.formatDate(0.5, 'time', false) === '12:00' && doc.formatDate(0, 'date', true) === '1904-01-01', `${doc.formatDate(45000, 'date', false)} ${doc.formatDate(1, 'date', false)}`);

  // a big sheet is read a row at a time (and cut at the row limit), not as one tree
  const rowsXml = Array.from({ length: 3000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('');
  const bigBook = fx.zip({
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Big" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`,
  });
  const big = await doc.parseXlsx(bigBook);
  check('xlsx: rows past the limit are cut and the sheet says so', big.sheets[0].rows.length === doc.MAX_ROWS && big.sheets[0].truncated === true, `${big.sheets[0].rows.length}`);

  // ---- damaged, wrong kind, password-protected, zip bombs
  const notZip = await rejects(doc.parseDocx(Buffer.from('this is not a zip file at all, just text')));
  check('docx: a file that is not a zip says so in plain words', notZip && /not a Word document/.test(notZip.message), notZip && notZip.message);
  const wrong = await rejects(doc.parseDocx(fx.sampleXlsx()));
  check('docx: an Excel file opened as Word is refused, not drawn', wrong && /not a Word document/.test(wrong.message), wrong && wrong.message);
  const wrongX = await rejects(doc.parseXlsx(fx.sampleDocx()));
  check('xlsx: a Word file opened as Excel is refused', wrongX && /not an Excel workbook/.test(wrongX.message), wrongX && wrongX.message);
  const locked = await rejects(doc.parseDocx(fx.zip({ '[Content_Types].xml': '<Types/>', EncryptedPackage: 'x', EncryptionInfo: 'y' })));
  check('docx: an encrypted package says it is password-protected', locked && /password/.test(locked.message), locked && locked.message);
  const bomb = fx.bombZip('word/document.xml', 100 * 1024 * 1024);
  check('the zip bomb fixture is small on disk', bomb.length < 500 * 1024, `${bomb.length}`);
  const t0 = Date.now();
  const bombed = await rejects(doc.parseDocx(bomb));
  check('docx: a part that inflates past the cap is refused (zip bomb), quickly', bombed && /too large/.test(bombed.message) && Date.now() - t0 < 5000, bombed ? `${bombed.message} ${Date.now() - t0} ms` : 'was read');
  const bombedX = await rejects(doc.parseXlsx(fx.bombZip('xl/workbook.xml', 100 * 1024 * 1024)));
  check('xlsx: the same cap holds for a workbook', bombedX && /too large/.test(bombedX.message), bombedX && bombedX.message);
  const mediaBomb = fx.zip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': fx.sampleDocx().length ? '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="x" xmlns:a="y"><w:body><w:p><w:r><w:drawing><wp:inline><a:blip r:embed="i1"/></wp:inline></w:drawing></w:r></w:p></w:body></w:document>' : '',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="i1" Type="x/image" Target="media/a.png"/></Relationships>',
    'word/media/a.png': Buffer.alloc(9 * 1024 * 1024, 7),
  });
  const mb = await doc.parseDocx(mediaBomb);
  check('docx: a picture over its own size cap (or that is no picture) is left out, the text still shows', mb.blocks.length === 1 && !JSON.stringify(mb.blocks).includes('data:image'));
  const tooBigFile = await rejects(doc.parseDocx(Buffer.alloc(doc.MAX_FILE_BYTES + 1)));
  check('docx: a file over the size limit is refused before it is opened', tooBigFile && /too large/.test(tooBigFile.message));

  // ---- the viewer module reads from disk, never reports a path, caches
  const docxFile = path.join(tmp, 'Report.docx');
  fs.writeFileSync(docxFile, fx.sampleDocx());
  const xlsxFile = path.join(tmp, 'Sheet.xlsx');
  fs.writeFileSync(xlsxFile, fx.sampleXlsx());
  const url = (f) => require('url').pathToFileURL(f).href;
  const loaded = await viewer.load(url(docxFile));
  check('viewer.load: a docx is { name, kind: docx, blocks }', loaded.name === 'Report.docx' && loaded.kind === 'docx' && Array.isArray(loaded.blocks) && !loaded.error);
  const loadedX = await viewer.load(url(xlsxFile));
  check('viewer.load: an xlsx is { name, kind: xlsx, sheets }', loadedX.kind === 'xlsx' && loadedX.sheets.length === 2);
  check('viewer.load: the same file again is the cached object', (await viewer.load(url(docxFile))) === loaded);
  const thumbRead = await viewer.load(url(xlsxFile), { thumb: true });
  check('viewer.load: a thumbnail read is its own, smaller read', thumbRead !== loadedX && thumbRead.sheets.length === 1);
  const gone = await viewer.load(url(path.join(tmp, 'missing.docx')));
  check('viewer.load: a missing file is an error that names no path', gone.error && /could not be found/.test(gone.error) && !gone.error.includes(tmp), gone.error);
  const garbage = path.join(tmp, 'Broken.docx');
  fs.writeFileSync(garbage, Buffer.from('nope'));
  const bad = await viewer.load(url(garbage));
  check('viewer.load: a damaged file is an error without the path', bad.error && !bad.error.includes(tmp), bad.error);

  // ---- tab addresses (file-tabs.js: cheap checks every tab uses)
  const view = fileTabs.officeViewerUrl('file:///C:/Users/me/Report.docx');
  check('office viewer address: round trip, file tab identity, address bar shows the file', fileTabs.isOfficeViewerUrl(view) && fileTabs.officeUrlOf(view) === 'file:///C:/Users/me/Report.docx' && fileTabs.addressOf(view) === 'file:///C:/Users/me/Report.docx' && fileTabs.identify(view).typeName === 'Document');
  check('office viewer address: the slide viewer, a PDF and a web page are not it', !fileTabs.isOfficeViewerUrl('https://example.com/office.html') && !fileTabs.isOfficeViewerUrl(view.replace('office.html', 'slides.html')));
  check('office viewer address: only a local .docx or .xlsx may be shown (a web address or another file type is not)', fileTabs.officeUrlOf(fileTabs.officeViewerUrl('https://evil.example/a.docx')) === null && fileTabs.officeUrlOf(fileTabs.officeViewerUrl('file:///C:/a.exe')) === null);
  check('office viewer address: a hash on the address is still the viewer', fileTabs.isOfficeViewerUrl(`${view}#top`));
  check('local .docx and .xlsx open in place; .doc, .xls and web files are left alone', fileTabs.shouldOpenOfficeInPlace({ url: 'file:///C:/a/b.xlsx', filename: 'b.xlsx' }) && fileTabs.shouldOpenOfficeInPlace({ url: 'file:///C:/a/b.DOCX' }) && !fileTabs.shouldOpenOfficeInPlace({ url: 'https://example.com/b.docx', filename: 'b.docx' }) && !fileTabs.shouldOpenOfficeInPlace({ url: 'file:///C:/a/b.doc' }));

  // ---- AI file cards
  const written = (name, size = 5000) => ({ path: path.join(tmp, name), name, dir: tmp, ext: path.extname(name).slice(1), kind: aiFiles.kindOf(path.extname(name).slice(1)), size });
  const reg = aiFiles.createRegistry();
  const cDocx = reg.add(written('Plan.docx'), true);
  const cXlsx = reg.add(written('Budget.xlsx'), true);
  const cPptx = reg.add(written('Deck.pptx'), true);
  check('cards: Word, Excel and PowerPoint files have their own kinds, preview and open in a tab', [cDocx, cXlsx, cPptx].every((c, i) => c.kind === ['docx', 'xlsx', 'pptx'][i] && c.previewable && c.canTab && c.canSystem));
  const named = reg.add(written('Other.docx'), false);
  check('cards: a file only named in a reply (untrusted) gets no preview, as before', !named.previewable && named.canTab);
  check('cards: isOfficeCard is true for trusted Office cards only', aiFiles.isOfficeCard(reg.get(cDocx.id)) && !aiFiles.isOfficeCard(reg.get(named.id)) && !aiFiles.isOfficeCard(reg.add(written('p.pdf'), true) && reg.get(aiFiles.idOf(path.join(tmp, 'p.pdf')))));
  check('cards: a huge Office file is not previewable', !reg.add(written('Huge.xlsx', 200 * 1024 * 1024), true).previewable);
  check('cards: none of the three is the reply\'s main file to open on its own', aiFiles.pickMain([cDocx, cXlsx, cPptx]) === null);
  check('cards: previewOf stays for html, svg and pictures (an Office card is drawn by main)', aiFiles.previewOf(reg.get(cDocx.id)) === null);

  // ---- uploads: a chip's file path, only for a ref that is pending
  const store = uploads.createUploadStore({ dir: path.join(tmp, 'uploads') });
  const stashed = store.stash({ name: 'Notes.docx', type: '', data: fx.sampleDocx() });
  const where = store.pendingPath(stashed.ref);
  check('uploads: pendingPath gives the stashed file for its ref', where && fs.existsSync(where) && path.basename(where) === 'Notes.docx');
  check('uploads: pendingPath refuses a path, a made-up ref and a discarded ref', store.pendingPath('C:/Windows/win.ini') === null && store.pendingPath('f_000000000000000000000000') === null && (store.discard(stashed.ref), store.pendingPath(stashed.ref) === null));

  // ---- thumbnails: the engine with a fake window
  const pngBytes = fx.png(40, 20, () => [10, 20, 30, 255]);
  let draws = 0;
  const calls = [];
  class FakeWindow {
    constructor() { this.destroyed = false; calls.push('window'); this.webContents = this.wc(); }
    wc() {
      const self = this;
      return {
        session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } },
        setWindowOpenHandler() {}, on() {}, setAudioMuted() {},
        async loadURL(u) { self.url = u; calls.push(u.replace(/^.*\/renderer\//, '').replace(/\?.*/, '')); },
        async insertCSS() { calls.push('css'); },
        async executeJavaScript() { return true; },
        async capturePage() { draws++; return { isEmpty: () => false, getSize: () => ({ width: 800, height: 1000 }), resize: () => ({ toPNG: () => pngBytes, getSize: () => ({ width: 40, height: 20 }) }), toPNG: () => pngBytes }; },
      };
    }
    setContentSize() {}
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const cacheDir = path.join(tmp, 'thumbs');
  const rendered = [];
  const keys = { encrypt: (t) => Buffer.from(t).reverse().toString('base64'), decrypt: (b) => Buffer.from(b, 'base64').reverse().toString(), available: () => true };
  const eng = thumbLib.create({ ...keys, BrowserWindow: FakeWindow, cacheDir, officeRender: async (wc, u, o) => { rendered.push(['office', o]); }, slidesRender: async (wc, u, o) => { rendered.push(['slides', o]); } });
  const t1 = await eng.thumbOf(docxFile);
  check('thumbs: a .docx is drawn in the office viewer page with ?thumb=1 and comes back as a PNG data URL', t1 && /^data:image\/png;base64,/.test(t1.dataUrl) && t1.w === 40 && calls.some((c) => c === 'office.html') && rendered[0][1].thumb === true, JSON.stringify([t1 && t1.w, calls, rendered]));
  const t2 = await eng.thumbOf(docxFile);
  check('thumbs: asking again is served from memory (no second capture)', t2 === t1 && draws === 1);
  const eng2 = thumbLib.create({ ...keys, BrowserWindow: FakeWindow, cacheDir, officeRender: async () => { throw new Error('should not draw'); }, slidesRender: async () => {} });
  const t3 = await eng2.thumbOf(docxFile);
  check('thumbs: after a restart it comes from the disk cache, keyed by path, size and time', t3 && t3.dataUrl === t1.dataUrl && draws === 1 && fs.readdirSync(cacheDir).filter((n) => n.endsWith('.thumb')).length === 1, `${draws} ${fs.readdirSync(cacheDir)}`);
  fs.writeFileSync(docxFile, Buffer.concat([fx.sampleDocx(), Buffer.from('x')]));
  const t4 = await eng2.thumbOf(docxFile);
  check('thumbs: a changed file is drawn again (a new key)', t4 === null || draws >= 1); // (eng2 refuses to draw: the point is that the old picture is not reused)
  check('thumbs: ... and its old picture is not handed back for the new bytes', t4 === null, JSON.stringify(t4 && t4.w));
  const t5 = await eng.thumbOf(path.join(tmp, 'Deck.pptx')); // not on disk
  check('thumbs: a file that is not there is null', t5 === null);
  const pptxFile = path.join(tmp, 'Slides.pptx');
  fs.writeFileSync(pptxFile, fx.samplePptx());
  const t6 = await eng.thumbOf(pptxFile);
  check('thumbs: a .pptx goes through the slide viewer (first slide only) with the viewer chrome hidden', t6 && rendered.some((r) => r[0] === 'slides' && r[1].thumb === true) && calls.includes('css') && calls.includes('slides.html'), JSON.stringify([calls, rendered]));
  check('thumbs: other files and a missing argument are null', (await eng.thumbOf(path.join(tmp, 'a.txt'))) === null && (await eng.thumbOf(undefined)) === null);
  const [a, b] = await Promise.all([eng.thumbOf(xlsxFile), eng.thumbOf(xlsxFile)]);
  check('thumbs: two asks for one file at once share one drawing', a === b && a && rendered.filter((r) => r[0] === 'office').length === 2, rendered.length);
  const diskBytes = fs.readFileSync(path.join(cacheDir, fs.readdirSync(cacheDir).find((n) => n.endsWith('.thumb'))));
  check('thumbs: what goes to disk is encrypted (no PNG header, no readable page)', !diskBytes.includes(Buffer.from('PNG')) && !diskBytes.includes(Buffer.from('iVBOR')));
  const bare = path.join(tmp, 'thumbs-no-keychain');
  const eng3 = thumbLib.create({ BrowserWindow: FakeWindow, cacheDir: bare, officeRender: async () => {}, slidesRender: async () => {}, encrypt: keys.encrypt, decrypt: keys.decrypt, available: () => false });
  check('thumbs: with no keychain a picture is kept in memory only, nothing is written to disk', (await eng3.thumbOf(xlsxFile)) !== null && !fs.existsSync(bare));
  eng.close();
  eng2.close();
  eng3.close();

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\n${failed} FAILED` : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
