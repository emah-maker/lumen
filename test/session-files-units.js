// File tabs in a saved session (features/session-files.js), plain Node: what a PDF, deck, text or image tab keeps in the session,
// where a missing file goes, and that main.js, the error page and the PDF viewer are wired to it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const sf = require('../src/features/session-files');
const pdfViewer = require('../src/features/pdf-viewer');
const slidesViewer = require('../src/features/slides-viewer');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sessfiles-'));
const file = (name) => { const p = path.join(dir, name); fs.writeFileSync(p, 'x'); return pathToFileURL(p).href; };
const pdf = file('Lecture notes.pdf');
const txt = file('todo list.txt');
const png = file('pic.png');
const pptx = file('deck.pptx');

// ---- savedUrl: what a tab keeps
check('a PDF in Lumen\'s viewer is saved as the PDF\'s own address', sf.savedUrl(pdfViewer.viewerUrl(pdf)) === pdf, sf.savedUrl(pdfViewer.viewerUrl(pdf)));
check('...with the page it was on', sf.savedUrl(pdfViewer.viewerUrl(`${pdf}#page=4`)) === `${pdf}#page=4`);
check('a deck in the slide viewer is saved as the deck\'s file, not the install folder\'s viewer page', sf.savedUrl(slidesViewer.viewerUrl(pptx)) === pptx, sf.savedUrl(slidesViewer.viewerUrl(pptx)));
check('a text file and an image are saved as they are', sf.savedUrl(txt) === txt && sf.savedUrl(png) === png);
check('a PDF on the web in the viewer is saved as its web address', sf.savedUrl(pdfViewer.viewerUrl('https://example.com/a.pdf')) === 'https://example.com/a.pdf');
const own = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'newtab.html')).href;
check('Lumen\'s own pages are not file tabs', sf.savedUrl(own) === '' && sf.savedUrl(`${own}?x=1`) === '');
check('settings, about:blank, nonsense and empty give nothing', sf.savedUrl('about:blank') === '' && sf.savedUrl('') === '' && sf.savedUrl('not a url') === '' && sf.savedUrl(undefined) === '');
check('a viewer address with no file in it gives nothing', sf.savedUrl('lumen-pdf://app/viewer.html') === '' && sf.savedUrl('lumen-pdf://app/viewer.html?u=javascript:1') === '');

// ---- localPath
check('localPath reads a file: address (spaces, #page and ?query aside)', sf.localPath(`${pdf}#page=3`) === path.join(dir, 'Lecture notes.pdf') && sf.localPath(`${txt}?a=1`) === path.join(dir, 'todo list.txt'), sf.localPath(`${pdf}#page=3`));
check('localPath of a web address is empty', sf.localPath('https://a.test/x.pdf') === '' && sf.localPath('') === '');

// ---- loadTarget: a missing file goes to the "moved or deleted" page
const ERR = 'file:///app/renderer/error.html';
check('a file that exists loads as it is', sf.loadTarget(pdf, ERR, fs.existsSync) === pdf && sf.loadTarget(txt, ERR, fs.existsSync) === txt);
const gone = pathToFileURL(path.join(dir, 'gone.pdf')).href;
const page = sf.loadTarget(gone, ERR, fs.existsSync);
check('a file that is gone loads the missing-file page', page.startsWith(`${ERR}?`) && new URL(page).searchParams.get('kind') === 'missingfile' && new URL(page).searchParams.get('url') === gone, page);
check('...also with a page number on it', new URL(sf.loadTarget(`${gone}#page=2`, ERR, fs.existsSync)).searchParams.get('url') === `${gone}#page=2`);
check('web pages and Lumen\'s own pages are never checked', sf.loadTarget('https://a.test/x', ERR, () => false) === 'https://a.test/x' && sf.loadTarget(own, ERR, () => false) === own);
check('missingTarget reads the file back from the page\'s address', sf.missingTarget(page, ERR) === gone);
check('missingTarget answers nothing for another page, another kind or a non-file', sf.missingTarget(`${ERR}?url=${encodeURIComponent(gone)}`, ERR) === '' && sf.missingTarget(`${ERR}?kind=missingfile&url=${encodeURIComponent('https://a.test/')}`, ERR) === '' && sf.missingTarget(`https://evil.test/?kind=missingfile&url=${encodeURIComponent(gone)}`, ERR) === '' && sf.missingTarget('', ERR) === '');
check('...nor for one of Lumen\'s own pages named as the "file"', sf.missingTarget(sf.missingUrl(ERR, own), ERR) === '');

// ---- wiring
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const main = read('src', 'main.js');
check('main.js saves file tabs in the session, with their place, active tab, group and pin', /const savedOf = \(t\)/.test(main) && /const urls = saved\.map\(savedOf\)/.test(main) && /pinned: saved\.map/.test(main) && /groupIds: saved\.map/.test(main));
check('main.js sends a missing file to the missing-file page when a tab loads', /sessionFiles\.loadTarget\(url, ERROR_URL, fs\.existsSync\)/.test(main));
check('Ctrl+Shift+T brings back a closed window as well as a tab', /closedWindows\.push\(/.test(main) && /createWindow\(\{ restore: last\.entry \}\)/.test(main));
check('a file in a viewer can be reopened with Reopen Closed Tab', /sessionFiles\.savedUrl\(url\) : url/.test(main));
check('the missing-file page\'s calls take the file from the page\'s own address', /missingTarget\(event\.senderFrame\?\.url, ERROR_URL\)/.test(main) && !/ipcMain\.on\('missingfile:(folder|choose)', \(event, /.test(main));
const en = JSON.parse(read('src', 'locales', 'en.json'));
check('the missing-file page has its words', ['title', 'message', 'showFolder', 'choose'].every((k) => en[`errorPage.missingFile.${k}`]) && en['dialog.missingFile.choose']);
check('the error page has Show in folder and Choose file for it', /kind'\) === 'missingfile'/.test(read('src', 'renderer', 'error.js')) && /lumenMissingFile/.test(read('src', 'preload', 'error-preload.js')));
check('the PDF viewer writes the page into its address', /history\.replaceState/.test(read('src', 'renderer', 'pdfviewer.js')));

fs.rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
