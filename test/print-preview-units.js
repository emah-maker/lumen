// Print preview, pure Node (no window): how the settings panel's choices become printToPDF / print options
// (features/print-options.js), page-range parsing, file-name sanitizing, the PDF page count, and that every
// string the preview shows is in locales/en.json and every Print entry opens the preview.
require('./_tmp-cleanup');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const O = require('../src/features/print-options');

let failures = 0;
const check = (label, fn) => {
  try { fn(); console.log(`PASS  ${label}`); } catch (err) { failures++; console.log(`FAIL  ${label}  -> ${String(err.message).slice(0, 300)}`); }
};
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ---- page ranges
check('ranges: "1-5, 8, 11-13" parses and normalizes', () => {
  const r = O.parseRanges('1-5, 8, 11-13');
  assert.ok(r.ok);
  assert.deepStrictEqual(r.ranges, [{ from: 1, to: 5 }, { from: 8, to: 8 }, { from: 11, to: 13 }]);
  assert.strictEqual(r.text, '1-5, 8, 11-13');
  assert.strictEqual(O.parseRanges(' 2 ,4 - 6 ').text, '2, 4-6');
});
check('ranges: nonsense is refused', () => {
  for (const bad of ['', '  ', 'a', '0', '0-3', '5-2', '1-', '-3', '1,,2', '1;2', '1-2-3', '1.5', '1 2', '-1', '99999999']) assert.strictEqual(O.parseRanges(bad).ok, false, bad);
});
check('ranges: a page past the end is out of range (when the total is known)', () => {
  assert.strictEqual(O.parseRanges('1-5', 5).ok, true);
  const r = O.parseRanges('1-6', 5);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.outOf, 5);
  assert.strictEqual(O.parseRanges('9', null).ok, true);
});
check('ranges: pagesIn counts overlaps once', () => {
  assert.strictEqual(O.pagesIn([{ from: 1, to: 3 }, { from: 2, to: 5 }, { from: 9, to: 9 }]), 6);
});

// ---- settings are cleaned
check('normalize: defaults, junk, clamps', () => {
  assert.deepStrictEqual(O.normalize(undefined), { ...O.DEFAULTS, custom: { ...O.DEFAULTS.custom } });
  const s = O.normalize({ destination: 5, paper: 'Banana', margins: 'huge', copies: 100000, scalePercent: 3, duplex: 'x', landscape: 'yes', custom: { top: -4, bottom: 99, left: 'a' }, ranges: 'x'.repeat(500), path: '/etc/passwd' });
  assert.strictEqual(s.destination, O.PDF);
  assert.strictEqual(s.paper, 'Letter');
  assert.strictEqual(s.margins, 'default');
  assert.strictEqual(s.copies, 999);
  assert.strictEqual(s.scalePercent, 10);
  assert.strictEqual(s.duplex, 'simplex');
  assert.strictEqual(s.landscape, false);
  assert.deepStrictEqual(s.custom, { top: 0, bottom: 5, left: 0.4, right: 0.4 });
  assert.strictEqual(s.ranges.length, 200);
  assert.ok(!('path' in s));
});
check('normalize: a printer that is gone becomes Save as PDF', () => {
  assert.strictEqual(O.normalize({ destination: 'HP LaserJet' }, { printers: ['HP LaserJet', 'Brother'] }).destination, 'HP LaserJet');
  assert.strictEqual(O.normalize({ destination: 'Old Printer' }, { printers: ['HP LaserJet'] }).destination, O.PDF);
  assert.strictEqual(O.normalize({ destination: O.PDF }, { printers: [] }).destination, O.PDF);
});

// ---- printToPDF options
check('printToPDF: the defaults', () => {
  const o = O.toPrintToPdfOptions({});
  assert.deepStrictEqual(o, { landscape: false, printBackground: false, displayHeaderFooter: false, pageSize: 'Letter', margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 }, scale: 1, preferCSSPageSize: false, generateTaggedPDF: true });
});
check('printToPDF: landscape, background, header and footer, paper', () => {
  const o = O.toPrintToPdfOptions({ landscape: true, background: true, headerFooter: true, paper: 'A4' });
  assert.strictEqual(o.landscape, true);
  assert.strictEqual(o.printBackground, true);
  assert.strictEqual(o.displayHeaderFooter, true);
  assert.strictEqual(o.pageSize, 'A4');
});
check('printToPDF: margins none / minimum / custom', () => {
  assert.deepStrictEqual(O.toPrintToPdfOptions({ margins: 'none' }).margins, { top: 0, bottom: 0, left: 0, right: 0 });
  assert.deepStrictEqual(O.toPrintToPdfOptions({ margins: 'minimum' }).margins, { top: 0.1, bottom: 0.1, left: 0.1, right: 0.1 });
  assert.deepStrictEqual(O.toPrintToPdfOptions({ margins: 'custom', custom: { top: 1, bottom: 0.5, left: 2, right: 0 } }).margins, { top: 1, bottom: 0.5, left: 2, right: 0 });
});
check('printToPDF: scale and page ranges', () => {
  assert.strictEqual(O.toPrintToPdfOptions({ scale: 'custom', scalePercent: 150 }).scale, 1.5);
  assert.strictEqual(O.toPrintToPdfOptions({ scale: 'default', scalePercent: 150 }).scale, 1);
  assert.strictEqual(O.toPrintToPdfOptions({ pages: 'custom', ranges: '1-3, 5' }).pageRanges, '1-3, 5');
  assert.ok(!('pageRanges' in O.toPrintToPdfOptions({ pages: 'all', ranges: '1-3' })));
  assert.ok(!('pageRanges' in O.toPrintToPdfOptions({ pages: 'custom', ranges: 'bad' })));
});

// ---- print (printer) options
check('print: the options a printer gets', () => {
  const o = O.toPrintOptions({ destination: 'HP', copies: 3, landscape: true, color: false, background: true, paper: 'Legal', duplex: 'shortEdge', pages: 'custom', ranges: '2-4, 7', scale: 'custom', scalePercent: 80 });
  assert.deepStrictEqual(o, {
    silent: true, deviceName: 'HP', copies: 3, landscape: true, color: false, printBackground: true,
    margins: { marginType: 'default' }, pageSize: 'Legal', duplexMode: 'shortEdge', scaleFactor: 80,
    pageRanges: [{ from: 1, to: 3 }, { from: 6, to: 6 }],
  });
});
check('print: margins and header/footer', () => {
  assert.deepStrictEqual(O.toPrintOptions({ destination: 'HP', margins: 'none' }).margins, { marginType: 'none' });
  assert.deepStrictEqual(O.toPrintOptions({ destination: 'HP', margins: 'minimum' }).margins, { marginType: 'printableArea' });
  assert.deepStrictEqual(O.toPrintOptions({ destination: 'HP', margins: 'custom', custom: { top: 1, bottom: 1, left: 0.5, right: 0.5 } }).margins, { marginType: 'custom', top: 72, bottom: 72, left: 36, right: 36 });
  const o = O.toPrintOptions({ destination: 'HP', headerFooter: true }, { title: 'A page', url: 'https://example.com/' });
  assert.strictEqual(o.header, 'A page');
  assert.strictEqual(o.footer, 'https://example.com/');
  assert.ok(!('header' in O.toPrintOptions({ destination: 'HP' }, { title: 'A page' })));
  assert.ok(!('scaleFactor' in O.toPrintOptions({ destination: 'HP' })));
});

// ---- sheets and pages in a PDF
check('sheets: two-sided uses both sides', () => {
  assert.strictEqual(O.sheetCount(3), 3);
  assert.strictEqual(O.sheetCount(3, 'simplex'), 3);
  assert.strictEqual(O.sheetCount(3, 'longEdge'), 2);
  assert.strictEqual(O.sheetCount(4, 'shortEdge'), 2);
  assert.strictEqual(O.sheetCount(0, 'longEdge'), 0);
});
check('countPdfPages: page objects only, not the page tree', () => {
  const pdf = '%PDF-1.4\n1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n2 0 obj\n<</Type /Pages /Count 2>>\nendobj\n3 0 obj\n<</Type /Page /Parent 2 0 R>>\nendobj\n4 0 obj\n<</Type/Page/Parent 2 0 R>>\nendobj\n';
  assert.strictEqual(O.countPdfPages(Buffer.from(pdf)), 2);
  assert.strictEqual(O.countPdfPages(Buffer.alloc(0)), 0);
  assert.strictEqual(O.countPdfPages(null), 0);
});

// ---- file names
check('sanitizeFileName: a page title becomes a safe file name', () => {
  assert.strictEqual(O.sanitizeFileName('Inbox (3) - Mail'), 'Inbox (3) - Mail');
  assert.strictEqual(O.sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.strictEqual(O.sanitizeFileName('  ..hidden.  '), 'hidden');
  assert.strictEqual(O.sanitizeFileName('report.'), 'report');
  assert.strictEqual(O.sanitizeFileName('tab\there\nnow'), 'tab here now');
  assert.strictEqual(O.sanitizeFileName(''), 'page');
  assert.strictEqual(O.sanitizeFileName('///'), 'page');
  assert.strictEqual(O.sanitizeFileName(null), 'page');
  assert.strictEqual(O.sanitizeFileName('CON'), 'page');
  assert.strictEqual(O.sanitizeFileName('com1'), 'page');
  assert.strictEqual(O.sanitizeFileName('Untitled', 'x'), 'Untitled');
  assert.strictEqual(O.sanitizeFileName('', 'x'), 'x');
  assert.ok(O.sanitizeFileName('x'.repeat(300)).length <= 100);
  assert.ok(!/[\\/:*?"<>|]/.test(O.sanitizeFileName('../../etc/passwd')));
});

// ---- wiring
check('every string the preview uses is in en.json', () => {
  const en = JSON.parse(read('src/locales/en.json'));
  const html = read('src/renderer/print-preview.html');
  const js = read('src/renderer/print-preview.js');
  const keys = new Set([...html.matchAll(/data-i18n(?:-[a-z-]+)?="(print\.[A-Za-z.]+)"/g)].map((m) => m[1]));
  for (const m of js.matchAll(/t\('(print\.[A-Za-z.]+)'/g)) keys.add(m[1]);
  for (const m of read('src/features/print-preview.js').matchAll(/t\('(print\.[A-Za-z.]+)'/g)) keys.add(m[1]);
  assert.ok(keys.size > 40, `found ${keys.size} keys`);
  const missing = [...keys].filter((k) => typeof en[k] !== 'string');
  assert.deepStrictEqual(missing, []);
  assert.ok(en['menu.printSystem'] && en['shortcuts.printSystem']);
});
check('every Print entry opens the preview, the system dialog is Ctrl+Shift+P', () => {
  const main = read('src/main.js');
  assert.ok(!/\.print\(\{\}, \(\) => \{\}\)/.test(main.replace(/const printSystem[^\n]*\n/, '')), 'a plain wc.print({}) is left in main.js');
  assert.ok(/mod && input\.shift && !input\.alt && key === 'p'\) printSystem\(wc\)/.test(main));
  assert.ok(/mod && key === 'p'\) printTab\(wc\)/.test(main));
  const priv = read('src/features/private-window.js');
  assert.ok(/case 'print': if \(deps\.print\)/.test(priv));
  assert.ok(/main\.js/.test('main.js') && /print: \(wc, host\) => printTab\(wc, host\)/.test(main));
});
check('the preview page can only ask for settings and presses, and has a strict CSP', () => {
  const html = read('src/renderer/print-preview.html');
  assert.ok(/default-src 'none'/.test(html) && /script-src 'self'/.test(html));
  const pre = read('src/preload/print-preview-preload.js');
  assert.ok(!/path|file|shell/i.test(pre.replace(/\/\/.*$/gm, '')), 'the preload should not deal in paths');
});

check('the preview fits pages with #zoom=page-width (view=FitH left a horizontal scrollbar)', () => {
  const src = read('src/features/print-preview.js');
  assert.ok(/#toolbar=0&navpanes=0&zoom=page-width/.test(src) && !src.includes('view=FitH`'));
});

if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
