// The AI reading Google Docs / Sheets / Slides through the editor's export (ai/office-docs.js), the scroll tool's pick of
// a scroll container when the window cannot scroll (ai/page-scripts.js), and read_pdf's paging (features/pdf-text.js).
// Plain Node: no window, no network.
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const office = require('../src/ai/office-docs');
const scripts = require('../src/ai/page-scripts');
const pdfText = require('../src/features/pdf-text');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = (v) => JSON.stringify(v);

(async () => {
  // ---- URL detection and the export address
  const doc = office.exportTarget('https://docs.google.com/document/d/1AbC-dEf_Ghi2/edit?tab=t.0#heading=h.x');
  check('Docs: the editor address gives the txt export of the same document', doc && doc.kind === 'doc' && doc.exportUrl === 'https://docs.google.com/document/d/1AbC-dEf_Ghi2/export?format=txt', J(doc));
  check('Docs: the /u/N account prefix is understood', office.exportTarget('https://docs.google.com/document/u/1/d/1AbC-dEf_Ghi2/edit')?.exportUrl === 'https://docs.google.com/document/d/1AbC-dEf_Ghi2/export?format=txt');
  const sheet = office.exportTarget('https://docs.google.com/spreadsheets/d/SHEETID_123/edit#gid=845');
  check('Sheets: the current sheet\'s gid goes into the csv export', sheet.kind === 'sheet' && sheet.gid === '845' && sheet.exportUrl === 'https://docs.google.com/spreadsheets/d/SHEETID_123/export?format=csv&gid=845', J(sheet));
  check('Sheets: no gid reads the first sheet', office.exportTarget('https://docs.google.com/spreadsheets/d/SHEETID_123/edit').exportUrl === 'https://docs.google.com/spreadsheets/d/SHEETID_123/export?format=csv');
  check('Sheets: gid in the query string also counts', office.exportTarget('https://docs.google.com/spreadsheets/d/SHEETID_123/edit?gid=7').gid === '7');
  const slides = office.exportTarget('https://docs.google.com/presentation/d/SLIDEID_99/edit#slide=id.p');
  check('Slides: txt export', slides.kind === 'slides' && slides.exportUrl === 'https://docs.google.com/presentation/d/SLIDEID_99/export?format=txt', J(slides));
  for (const bad of ['https://example.com/document/d/abc12345/edit', 'http://docs.google.com/document/d/abc12345/edit', 'https://docs.google.com/document/d/e/2PACX-1v/pub', 'https://docs.google.com/document/', 'https://docs.google.com/forms/d/abc12345/edit', 'https://docs.google.com.evil.test/document/d/abc12345/edit', 'not a url', '']) {
    check(`not a document: ${bad || '(empty)'}`, office.exportTarget(bad) === null);
  }
  check('a local test page matches only when the test switch says so', office.exportTarget('http://127.0.0.1:5/document/d/X1234567/edit') === null && office.exportTarget('http://127.0.0.1:5/document/d/X1234567/edit', true)?.exportUrl === 'http://127.0.0.1:5/document/d/X1234567/export?format=txt');
  check('the fetch script uses the tab\'s cookies and the one address', /credentials: 'include'/.test(office.fetchScript(doc.exportUrl)) && office.fetchScript(doc.exportUrl).includes(J(doc.exportUrl)));

  // ---- reading: through the page, then the session, never a sign-in page
  const url = 'https://docs.google.com/document/d/1AbC-dEf_Ghi2/edit';
  const ran = [];
  let r = await office.readExport(url, { run: async (code) => { ran.push(code); return { ok: true, status: 200, type: 'text/plain; charset=utf-8', text: '﻿One\r\n\r\n\r\n\r\nTwo' }; } });
  check('readExport: the page\'s answer, BOM and CRLF cleaned, labelled', r && r.text === 'One\n\nTwo' && /from Google Docs export/.test(office.header(r)) && ran.length === 1, J(r));
  r = await office.readExport(url, { run: async () => ({ ok: true, status: 200, type: 'text/html', text: '<html>Sign in</html>' }) });
  check('readExport: a sign-in (html) page is not the document', r === null);
  r = await office.readExport(url, { run: async () => ({ ok: false, status: 404, type: 'text/plain', text: 'nope' }) });
  check('readExport: an error answer is not the document (a doc the user cannot open fails as for them)', r === null);
  let fetched = null;
  r = await office.readExport(url, { run: async () => { throw new Error('blocked'); }, sessionFetch: async (u) => { fetched = u; return { ok: true, status: 200, headers: { get: () => 'text/plain' }, text: async () => 'From the session' }; } });
  check('readExport: when the page cannot fetch, the tab session asks the same address', r && r.text === 'From the session' && fetched === doc.exportUrl, J({ r, fetched }));
  check('readExport: another site is never fetched', (await office.readExport('https://example.com/document/d/abc12345/edit', { run: async () => { throw new Error('must not run'); } })) === null);
  r = await office.readExport('https://docs.google.com/spreadsheets/d/SHEETID_123/edit#gid=845', { run: async () => ({ ok: true, status: 200, type: 'text/csv', text: 'a,b\n1,2\n' }) });
  check('Sheets: the note names the sheet and how to read another', /sheet gid 845 as CSV/.test(office.header(r)) && /click its tab/.test(office.header(r)), office.header(r));

  // ---- read_page's text slot: the export replaces the canvas's few words, paged by text_offset
  const long = 'x'.repeat(30000);
  const page = { url, title: 'Lab - Google Docs', text: 'Tab 1', totalTextChars: 5, textRange: [0, 5], moreTextAvailable: false };
  const ok = async () => ({ ok: true, status: 200, type: 'text/plain', text: long });
  let o = await office.overlayPage(page, 0, 12000, { run: ok });
  check('overlayPage: first chunk, with the label, the total and "more available"', o.text.startsWith('Document text (from Google Docs export') && o.text.length === 12000 && o.totalTextChars > 30000 && o.moreTextAvailable === true && o.textRange[1] === 12000, J({ n: o.text.length, t: o.totalTextChars }));
  o = await office.overlayPage(page, 24000, 12000, { run: ok });
  check('overlayPage: text_offset pages through the rest', o.textRange[0] === 24000 && o.text.length === o.totalTextChars - 24000 && o.moreTextAvailable === false, J(o.textRange));
  o = await office.overlayPage(page, 0, 12000, { run: async () => ({ ok: false, status: 0, type: '', text: '' }) });
  check('overlayPage: a failed export leaves the page\'s own text', o === page);

  // ---- scroll: the window cannot move, so the scroller around the middle of the view moves
  const makeEl = (name, { w = 0, h = 0, sh = 0, overflow = 'visible', parent = null, className = '' } = {}) => ({
    name, clientWidth: w, clientHeight: h, scrollHeight: sh, scrollTop: 0, overflowY: overflow, parentElement: parent, className, tagName: name.toUpperCase(), getRootNode: () => ({}),
    scrollBy(_x, dy) { this.scrollTop = Math.min(Math.max(this.scrollTop + dy, 0), this.scrollHeight - this.clientHeight); },
  });
  const scrollRun = (els, centre) => vm.runInNewContext(scripts.scroll(1), {
    innerHeight: 800, innerWidth: 1200, scrollY: 0, scrollBy() {}, window: { scrollBy() {} }, Math, Date, setTimeout: (fn) => fn(),
    getComputedStyle: (el) => ({ overflowY: el.overflowY }),
    document: { documentElement: els.html, body: els.body, elementFromPoint: () => centre, querySelectorAll: () => Object.values(els) },
    Promise,
  });
  const html = makeEl('html', { w: 1200, h: 800, sh: 800 });
  const body = makeEl('body', { w: 1200, h: 800, sh: 800, parent: html, overflow: 'hidden' });
  const side = makeEl('div', { w: 300, h: 700, sh: 3000, overflow: 'auto', parent: body, className: 'side-panel' });
  const editor = makeEl('div', { w: 1200, h: 800, sh: 5800, overflow: 'scroll', parent: body, className: 'kix-appview-editor' });
  const canvas = makeEl('canvas', { w: 600, h: 5000, sh: 5000, parent: editor });
  const hit = await scrollRun({ html, body, side, editor, canvas }, canvas);
  check('scroll: the container above the view\'s middle moves, and it is reported', hit.scrolled === 'container' && editor.scrollTop === 680 && side.scrollTop === 0 && hit.y === 680 && hit.max === 5000 && /kix-appview-editor/.test(hit.in), J(hit));
  const other = makeEl('div', { w: 300, h: 700, sh: 3000, overflow: 'auto', parent: body, className: 'a' });
  const centre = makeEl('p', { parent: body });
  const wide = makeEl('div', { w: 1200, h: 800, sh: 900, overflow: 'auto', parent: body });
  const fallback = await scrollRun({ html, body, other, wide }, centre);
  check('scroll: with no scroller around the middle, the largest one anywhere moves', fallback.scrolled === 'container' && other.scrollTop === 0 && wide.scrollTop === 100, J(fallback));
  check('scroll: nothing scrollable says so', (await scrollRun({ html, body }, centre)).scrolled === 'none');

  // ---- read_pdf paging
  check('pagesArg: pages wins, from becomes "N-", a bad from reads from the start', pdfText.pagesArg({ pages: '2-3', from: 5 }) === '2-3' && pdfText.pagesArg({ from: 5 }) === '5-' && pdfText.pagesArg({ from: 'x' }) === undefined && pdfText.pagesArg({ from: 1 }) === undefined && pdfText.pagesArg({}) === undefined);
  const texts = [1, 2, 3, 4, 5, 6].map((n) => `Section ${n}. ${'word '.repeat(2000)}`); // ~10k chars each: two pages fit under the 30k cap with the markers
  let out = pdfText.formatPages(texts, {});
  check('a long PDF is cut at the page that does not fit, with the next page named', out.truncated && out.next === out.pages.length + 1, J({ p: out.pages, next: out.next }));
  const hint = pdfText.continuation(out, { cut: true });
  check('the hint says which pages were shown and from:N', new RegExp(`^Pages 1-${out.pages.length} of 6 shown.*from:${out.next}\\b`).test(hint), hint);
  out = pdfText.formatPages(texts, { pages: pdfText.pagesArg({ from: 5 }) });
  check('from:5 returns pages 5 and 6 and nothing to continue', out.pages.join() === '5,6' && !out.truncated && pdfText.continuation(out) === '', J({ p: out.pages, h: pdfText.continuation(out) }));
  out = pdfText.formatPages(texts, { pages: '1-2' });
  check('a requested range that stops early still names the next page', /from:3/.test(pdfText.continuation(out)), pdfText.continuation(out));
  out = pdfText.formatPages(texts.slice(0, 2).map((t) => t.slice(0, 50)), {});
  check('a short file: no hint', pdfText.continuation(out) === '');
  check('query results carry no paging hint', pdfText.continuation(pdfText.formatPages(texts, { query: 'Section 3' })) === '');
  check('read_pdf offers from', pdfText.READ_PDF_PROPERTIES.from?.type === 'integer');

  // ---- the guidance and wiring
  const src = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');
  check('read_page\'s description says Docs, Sheets and Slides come back whole', /Google Docs\/Sheets\/Slides: full text/.test(src('ai', 'agent.js')));
  check('the scroll tool can go to a PDF page', /page: \{ type: 'integer' \}/.test(src('ai', 'agent.js')));
  check('read_tabs and the page context read the export too (page-text.js)', /officeDocs\.readExport/.test(src('ai', 'page-text.js')));

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
