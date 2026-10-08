// The AI opening a local PDF (ai/local-pdf.js): plain Node, real temp files. Paths and file:// addresses are normalised;
// anything that is not an existing regular .pdf file is refused.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const localPdf = require('../src/ai/local-pdf');
const pv = require('../src/features/pdf-viewer');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const BS = String.fromCharCode(92);
const refused = (raw) => { try { localPdf.resolve(raw); return null; } catch (e) { return e.message; } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-local-pdf-'));
const dir = path.join(root, 'OneDrive - Some University', 'Fall 2026', 'Notes 2.6');
fs.mkdirSync(dir, { recursive: true });
const pdf = path.join(dir, 'Notes 2.6 slides.pdf');
fs.writeFileSync(pdf, '%PDF-1.4\n');
const upper = path.join(dir, 'SCAN.PDF');
fs.writeFileSync(upper, '%PDF-1.4\n');
const txt = path.join(dir, 'notes.txt');
fs.writeFileSync(txt, 'hi');
const folder = path.join(dir, 'folder.pdf'); // a directory named like a PDF
fs.mkdirSync(folder);
const real = fs.realpathSync.native(pdf);
const want = pathToFileURL(real).href;

check('a path with spaces and folders', localPdf.resolve(pdf)?.fileUrl === want, String(localPdf.resolve(pdf)?.fileUrl));
check('the file name is returned, not the folder', localPdf.resolve(pdf).name === 'Notes 2.6 slides.pdf');
check('a quoted path', localPdf.resolve(`"${pdf}"`)?.fileUrl === want && localPdf.resolve(`'${pdf}'`)?.fileUrl === want);
check('surrounding whitespace', localPdf.resolve(`  ${pdf}\n`)?.fileUrl === want);
check('a file:// address with %20', localPdf.resolve(pathToFileURL(pdf).href)?.fileUrl === want);
check('a file:// address with an upper-case scheme', localPdf.resolve(pathToFileURL(pdf).href.replace(/^file/, 'FILE'))?.fileUrl === want);
check('file://localhost/ is the same machine', localPdf.resolve(pathToFileURL(pdf).href.replace('file:///', 'file://localhost/'))?.fileUrl === want);
check('.PDF in capitals', /SCAN\.PDF$/.test(localPdf.resolve(upper)?.fileUrl || ''));
check('.. is resolved first', localPdf.resolve(path.join(dir, '..', 'Notes 2.6', 'Notes 2.6 slides.pdf'))?.fileUrl === want);
check('forward slashes work too', localPdf.resolve(pdf.split(BS).join('/'))?.fileUrl === want);
check('the viewer address round-trips to the file', pv.pdfUrlOf(pv.viewerUrl(localPdf.resolve(pdf).fileUrl)) === want);

check('web addresses are not local references', localPdf.resolve('https://example.com/a.pdf') === null && localPdf.resolve('example.com') === null && localPdf.resolve('http://localhost:3000/x.pdf') === null);
check('a different extension is refused', /Only \.pdf/.test(refused(txt) || ''), String(refused(txt)));
check('a file:// address to a non-PDF is refused', Boolean(refused(pathToFileURL(txt).href)));
check('a directory is refused, even named .pdf', Boolean(refused(folder)));
check('a plain directory is refused', Boolean(refused(dir)));
check('a missing file is a clear not-found error', /could not be found/.test(refused(path.join(dir, 'nope.pdf')) || ''));
check('.pdf only as a middle part is refused', Boolean(refused(`${pdf}.exe`)) && Boolean(refused(`${pdf}x`)));
check('a UNC path is refused', Boolean(refused(BS + BS + 'server' + BS + 'share' + BS + 'a.pdf')) && Boolean(refused('//server/share/a.pdf')));
check('a UNC file:// address is refused', Boolean(refused('file://server/share/a.pdf')) && Boolean(refused('file:////server/share/a.pdf')));
check('device paths are refused', Boolean(refused(BS + BS + '.' + BS + 'C:' + BS + 'a.pdf')) && Boolean(refused(BS + BS + '?' + BS + 'C:' + BS + 'a.pdf')) && Boolean(refused(BS + BS + '.' + BS + 'pipe' + BS + 'x.pdf')));
check('an NUL byte is refused', Boolean(refused(`${pdf}\0.txt`)) && Boolean(refused(`${pdf.replace('.pdf', '')}\0.pdf`)));
check('another file:// address is refused', Boolean(refused('file:///etc/passwd')) && Boolean(refused('file:///C:/Windows/win.ini')));
check('a .pdf in the query of a file address does not count', Boolean(refused(`${pathToFileURL(txt).href}?x=a.pdf`)));
if (process.platform === 'win32') {
  check('an alternate data stream is refused', Boolean(refused(`${pdf}:evil.pdf`)) && Boolean(refused(`${txt}:x.pdf`)));
  check('a reserved device name is refused', Boolean(refused('C:' + BS + 'CON.pdf')) && Boolean(refused('C:' + BS + 'temp' + BS + 'NUL.pdf')));
  check('a path without a drive is refused', Boolean(refused(BS + 'Users' + BS + 'me' + BS + 'a.pdf')) || localPdf.resolve(BS + 'Users' + BS + 'me' + BS + 'a.pdf') === null);
}
// a symlink is resolved and the target checked again
try {
  const toTxt = path.join(dir, 'link.pdf');
  fs.symlinkSync(txt, toTxt);
  check('a symlink named .pdf that points at a non-PDF is refused', Boolean(refused(toTxt)));
  const toPdf = path.join(dir, 'link2.pdf');
  fs.symlinkSync(pdf, toPdf);
  check('a symlink to a PDF opens the real file', localPdf.resolve(toPdf)?.fileUrl === want);
} catch (e) { console.log(`SKIP  symlinks (${e.code})`); }

// wiring (agent.js): only navigate / open_tab take a local PDF, after the per-file card; read_urls and web_search stay web-only
const agent = fs.readFileSync(path.join(__dirname, '..', 'src', 'ai', 'agent.js'), 'utf8');
check('navigate and open_tab go through navUrl', /const url = navUrl\(input\.url\)/.test(agent) && /openTab\(navUrl\(input\.url\)/.test(agent));
check('read_urls still takes web addresses only', /input\.urls\.slice\(0, 6\)\.map\(\(u\) => webUrl\(u\)\)/.test(agent));
check('opening a local PDF asks once per file (the read_pdf permission)', /localPdf\.isLocalRef\(input\?\.url\)[\s\S]{0,400}requirePdfPermission/.test(agent));
check('the tool descriptions say local PDFs work', /URL or local \.pdf path in the active tab/.test(agent) && /URL or local \.pdf path in a background tab/.test(agent));

fs.rmSync(root, { recursive: true, force: true });
if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
console.log('All local-pdf checks passed');
