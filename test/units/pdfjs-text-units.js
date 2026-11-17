// [pdf text] read_pdf's second reader (features/pdfjs-text.js): a PDF whose font has no ToUnicode map (glyph names through /Differences,
// as Word and LaTeX subset fonts often do) read as junk with the small reader, so the AI took a homework sheet for a scan (2026-11-16).
// pdf.js reads it. Plain Node, with the vendored pdf.js. Fixture: test/fixtures/no-tounicode.pdf (made for this test, one line of text).
const fs = require('fs');
const path = require('path');
const pdfText = require('../../src/features/pdf-text');
const pdfjsText = require('../../src/features/pdfjs-text');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
const fixture = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'no-tounicode.pdf'));
const WANT = 'Problem 2: The internal shear force V is 8 kN';

(async () => {
  const small = pdfText.extractPages(fixture);
  check('the small reader cannot decode this font (the case being fixed)', !small.join(' ').includes('Problem'), JSON.stringify(small));
  check('sparse: that read counts as a failed one', pdfjsText.sparse(small));
  const pages = await pdfjsText.pdfjsPages(fixture);
  check('pdf.js reads the text', pages.length === 1 && pages[0] === WANT, JSON.stringify(pages));
  const best = await pdfText.readPages(fixture);
  check('readPages picks pdf.js for it', best[0] === WANT, JSON.stringify(best));
  // A PDF the small reader handles is never sent to pdf.js (same array back, no module work).
  const fine = ['Plenty of ordinary text on this page, well over forty letters and digits in all.'];
  check('betterPages keeps a good first read as it is', (await pdfjsText.betterPages(fixture, fine)) === fine);
  // Junk that is not a PDF: both readers fail, and the small reader's error is the one reported.
  let err = null;
  try { await pdfText.readPages(Buffer.from('not a pdf at all')); } catch (e) { err = e; }
  check('a file neither reader can open still throws', err instanceof Error, String(err));
  check('wordsIn counts letters and digits, not bullets', pdfjsText.wordsIn(['• •', 'ab 12']) === 4);

  console.log(failures ? `\n${failures} failed` : '\nall pdfjs-text checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
