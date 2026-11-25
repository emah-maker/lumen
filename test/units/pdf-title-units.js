// The PDF viewer's tab and header name (renderer/pdfviewer.js pdfTitle): the file's name, the PDF's inner title only when the address
// has no real name. The function is taken from the viewer's source (an ES module page that can't be required here).
'use strict';
const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/pdfviewer.js'), 'utf8');
const m = /function pdfTitle\([\s\S]*?\n}\r?\n/.exec(src);
check('the viewer has pdfTitle', Boolean(m));
const pdfTitle = new Function(`${m[0]}; return pdfTitle;`)();
const J = JSON.stringify;

const a = pdfTitle('Chapter 7 final.pdf', 'Chapter 4');
check('a named file keeps its name over a stale inner title, which shows on hover', a.title === 'Chapter 7 final.pdf' && a.tip === 'Chapter 7 final.pdf: Chapter 4', J(a));
check('no inner title: the name, tip the name', J(pdfTitle('Lab 3.pdf', '')) === J({ title: 'Lab 3.pdf', tip: 'Lab 3.pdf' }));
check('an inner title that only repeats the name adds nothing to the tip', pdfTitle('Syllabus.pdf', 'syllabus').tip === 'Syllabus.pdf');
const g = pdfTitle('download', 'ME 2341 Syllabus');
check('a generic address name (download) uses the inner title, the name in the tip', g.title === 'ME 2341 Syllabus' && g.tip === 'ME 2341 Syllabus (download)', J(g));
check('a bare number or "view.pdf" is generic too', pdfTitle('12345.pdf', 'Report').title === 'Report' && pdfTitle('view.pdf', 'Report').title === 'Report');
check('a blob: address id is generic', pdfTitle('3f2a9c1e-7b4d-4e2a-9f10-aa12bc34de56', 'Invoice').title === 'Invoice');
check('nothing at all: "PDF"', pdfTitle('PDF', '').title === 'PDF' && pdfTitle('', '').title === 'PDF');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
