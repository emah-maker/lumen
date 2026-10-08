// Lumen's PDF viewer (features/pdf-viewer.js): plain Node, no window. Routing decisions, the address helpers, the scheme's
// answers (assets, byte ranges, who may ask), the CSP, the setting, and the AI's scroll retargeted to the viewer's scroller.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');
const pv = require('../src/features/pdf-viewer');
const pdfInput = require('../src/features/pdf-input');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const J = (v) => JSON.stringify(v);
const src = (...p) => fs.readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');

(async () => {
  // ---- addresses
  const doc = 'https://example.com/files/report.pdf?dl=0#page=3';
  const view = pv.viewerUrl(doc);
  check('viewerUrl: on the lumen-pdf scheme, the PDF address in ?u=', view.startsWith('lumen-pdf://app/viewer.html?u=') && pv.isViewerUrl(view), view);
  check('pdfUrlOf: gives the PDF back (with its fragment)', pv.pdfUrlOf(view) === doc, String(pv.pdfUrlOf(view)));
  check('displayUrl: the address bar shows the PDF\'s own address', pv.displayUrl(view) === doc && pv.displayUrl('https://a.test/') === '');
  check('pdfUrlOf: only http(s) and file addresses', pv.pdfUrlOf(pv.viewerUrl('javascript:alert(1)')) === null && pv.pdfUrlOf(pv.viewerUrl('data:application/pdf;base64,AAAA')) === null && pv.pdfUrlOf(pv.viewerUrl('chrome://settings')) === null);
  check('pdfUrlOf: a viewer address of another host or path is not the viewer', !pv.isViewerUrl('lumen-pdf://evil/viewer.html?u=https://a.test/x.pdf') && !pv.isViewerUrl('lumen-pdf://app/data?u=https://a.test/x.pdf') && !pv.isViewerUrl('https://app/viewer.html'));
  check('dataUrl: the data request never carries the fragment', pv.dataUrl(doc) === 'lumen-pdf://app/data?u=https%3A%2F%2Fexample.com%2Ffiles%2Freport.pdf%3Fdl%3D0', pv.dataUrl(doc));
  const file = pathToFileURL(path.join(os.tmpdir(), 'Quarterly Report.pdf')).href;
  check('viewerUrl: a local file round-trips', pv.pdfUrlOf(pv.viewerUrl(file)) === file);

  // ---- routing decisions
  check('route: an address ending .pdf goes to the viewer (web and file)', pv.shouldRoute({ url: 'https://a.test/x.pdf' }) && pv.shouldRoute({ url: 'http://a.test/dir/X.PDF?v=2' }) && pv.shouldRoute({ url: file }));
  check('route: other addresses stay', !pv.shouldRoute({ url: 'https://a.test/x.pdf.html' }) && !pv.shouldRoute({ url: 'https://a.test/pdf' }) && !pv.shouldRoute({ url: 'https://a.test/?file=x.pdf' }) && !pv.shouldRoute({ url: 'about:blank' }) && !pv.shouldRoute({ url: 'ftp://a.test/x.pdf' }));
  check('route: not when the setting is Chrome\'s viewer', !pv.shouldRoute({ url: 'https://a.test/x.pdf', setting: 'chrome' }) && !pv.shouldRouteDocument({ url: 'https://a.test/get?id=1', contentType: 'application/pdf', setting: 'chrome' }));
  check('route: an unknown setting means Lumen\'s viewer (the default)', pv.shouldRoute({ url: 'https://a.test/x.pdf', setting: 'nonsense' }) && pv.cleanSetting(undefined) === 'lumen' && pv.cleanSetting('chrome') === 'chrome' && pv.cleanSetting('lumen') === 'lumen');
  check('route: never the viewer itself (no loop)', !pv.shouldRoute({ url: pv.viewerUrl('https://a.test/x.pdf') }) && !pv.shouldRouteDocument({ url: pv.viewerUrl('https://a.test/x.pdf'), contentType: 'application/pdf' }));
  check('route by content: a page whose document is application/pdf', pv.shouldRouteDocument({ url: 'https://a.test/get?id=1', contentType: 'application/pdf' }) && pv.shouldRouteDocument({ url: file, contentType: 'Application/PDF' }) && !pv.shouldRouteDocument({ url: 'https://a.test/', contentType: 'text/html' }));
  check('route by content: Chrome\'s viewer frame is recognised by its extension address', pv.isChromeViewerFrame(`${pv.CHROME_VIEWER}/index.html`) && !pv.isChromeViewerFrame('https://a.test/'));

  // ---- the files the scheme serves
  const vendor = path.join(__dirname, '..', 'src', 'vendor', 'pdfjs');
  check('assets: only Lumen\'s own viewer files and vendor/pdfjs resolve', pv.resolveAsset('/viewer.html').endsWith(path.join('renderer', 'pdfviewer.html')) && pv.resolveAsset('/viewer.js').endsWith('pdfviewer.js') && pv.resolveAsset('/tokens.css').endsWith('tokens.css') && pv.resolveAsset('/vendor/pdf.min.mjs') === path.join(vendor, 'pdf.min.mjs'));
  check('assets: nothing resolves outside vendor/pdfjs', pv.resolveAsset('/vendor/../../main.js') === null && pv.resolveAsset('/vendor/..%2f..%2fmain.js') === null && pv.resolveAsset('/vendor/%2e%2e/%2e%2e/main.js') === null && pv.resolveAsset('/main.js') === null && pv.resolveAsset('/../package.json') === null && pv.resolveAsset('/vendor/%zz') === null);
  check('assets: pdf.js, its worker, the viewer component, cmaps, fonts and wasm are all there', ['pdf.min.mjs', 'pdf.worker.min.mjs', 'web/pdf_viewer.mjs', 'web/pdf_viewer.css', 'cmaps/78-EUC-H.bcmap', 'standard_fonts/FoxitFixed.pfb', 'wasm/openjpeg.wasm', 'LICENSE'].every((f) => fs.existsSync(path.join(vendor, f))), '');
  check('license: Apache-2.0 text ships with pdf.js and is listed in the notices', /Apache License/.test(fs.readFileSync(path.join(vendor, 'LICENSE'), 'utf8')) && /pdf\.js/i.test(fs.readFileSync(path.join(__dirname, '..', 'THIRD_PARTY_NOTICES.md'), 'utf8')));

  // ---- the handler
  const handler = pv.createHandler({ netFetchFor: () => async (url, init) => new Response(`remote:${url}:${init.headers.range || ''}`, { status: init.headers.range ? 206 : 200, headers: { 'content-length': '3', 'accept-ranges': 'bytes' } }) });
  const ask = (url, headers = {}) => handler(new Request(url, { headers }), {});
  const html = await ask('lumen-pdf://app/viewer.html?u=x');
  const csp = html.headers.get('content-security-policy') || '';
  check('viewer page: served with a strict CSP (no remote script, no inline script, no plugins, no frames)', html.status === 200 && /default-src 'none'/.test(csp) && /script-src 'self' 'wasm-unsafe-eval'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp) && /object-src 'none'/.test(csp) && /frame-src 'none'/.test(csp) && /connect-src 'self' data: blob:/.test(csp), csp);
  check('viewer page: the shipped page and script need nothing the CSP forbids (no inline script, no remote)', !/<script(?![^>]*src=)/.test(src('renderer', 'pdfviewer.html')) && !/https?:\/\//.test(src('renderer', 'pdfviewer.js').replace(/\/\/.*$/gm, '')) && /type="module" src="\/viewer\.js"/.test(src('renderer', 'pdfviewer.html')));
  const js = await ask('lumen-pdf://app/vendor/pdf.min.mjs');
  check('assets: scripts get a JavaScript type, wasm its own', js.status === 200 && /javascript/.test(js.headers.get('content-type')) && (await ask('lumen-pdf://app/vendor/wasm/openjpeg.wasm')).headers.get('content-type') === 'application/wasm');
  check('assets: unknown paths and other hosts are 404', (await ask('lumen-pdf://app/nope.js')).status === 404 && (await ask('lumen-pdf://other/viewer.html')).status === 404 && (await ask('lumen-pdf://app/vendor/nothing-here.js')).status === 404);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfv-'));
  const pdfFile = path.join(tmp, 'My: report?.pdf');
  fs.writeFileSync(pdfFile, Buffer.from('0123456789ABCDEFGHIJ'));
  const dataOf = (target, extra = '') => `lumen-pdf://app/data?u=${encodeURIComponent(target)}${extra}`;
  const whole = await ask(dataOf(pathToFileURL(pdfFile).href), { 'sec-fetch-site': 'same-origin' });
  check('data: a local file is served whole, as application/pdf, saying it takes ranges', whole.status === 200 && (await whole.text()) === '0123456789ABCDEFGHIJ' && whole.headers.get('content-type') === 'application/pdf' && whole.headers.get('accept-ranges') === 'bytes' && whole.headers.get('content-length') === '20');
  const part = await ask(dataOf(pathToFileURL(pdfFile).href), { range: 'bytes=5-9', 'sec-fetch-site': 'same-origin' });
  check('data: a byte range answers 206 with Content-Range', part.status === 206 && (await part.text()) === '56789' && part.headers.get('content-range') === 'bytes 5-9/20');
  const tail = await ask(dataOf(pathToFileURL(pdfFile).href), { range: 'bytes=-4' });
  check('data: a suffix range (the end of the file, where the xref is) works', tail.status === 206 && (await tail.text()) === 'GHIJ' && tail.headers.get('content-range') === 'bytes 16-19/20');
  const bad = await ask(dataOf(pathToFileURL(pdfFile).href), { range: 'bytes=50-60' });
  check('data: a range past the end is 416', bad.status === 416 && bad.headers.get('content-range') === 'bytes */20');
  check('data: a missing file is 404 without its path', (await ask(dataOf(pathToFileURL(path.join(tmp, 'gone.pdf')).href))).status === 404 && !/gone/.test(await (await ask(dataOf(pathToFileURL(path.join(tmp, 'gone.pdf')).href))).text()));
  check('data: only the viewer itself may ask (a page of any other origin gets 403)', (await ask(dataOf(pathToFileURL(pdfFile).href), { 'sec-fetch-site': 'cross-site' })).status === 403 && (await ask(dataOf('https://a.test/x.pdf'), { 'sec-fetch-site': 'same-site' })).status === 403);
  check('data: only http(s) and file addresses', (await ask(dataOf('javascript:1'))).status === 400 && (await ask(dataOf('ftp://a.test/x'))).status === 400 && (await ask('lumen-pdf://app/data')).status === 400);
  const remote = await ask(dataOf('https://a.test/x.pdf'), { range: 'bytes=0-2', 'sec-fetch-site': 'same-origin' });
  check('data: a web address is fetched through the tab\'s session, the Range passed on, the answer kept', remote.status === 206 && (await remote.text()) === 'remote:https://a.test/x.pdf:bytes=0-2' && remote.headers.get('content-type') === 'application/pdf');
  const save = await ask(dataOf(pathToFileURL(pdfFile).href, '&dl=1'), { 'sec-fetch-site': 'same-origin' });
  const disp = save.headers.get('content-disposition') || '';
  check('data: Save a copy names the file after the PDF, with no path or odd characters', /^attachment; filename\*=UTF-8''/.test(disp) && /My_%20report_\.pdf$|My_%20report_\.pdf/.test(disp) && !/[\\/:?]/.test(decodeURIComponent(disp.split("''")[1])), disp);
  check('disposition: a name without .pdf gets one; a bare host gets a default', pv.disposition('https://a.test/get').endsWith('get.pdf') && pv.disposition('https://a.test/').endsWith('document.pdf'));
  fs.rmSync(tmp, { recursive: true, force: true });
  check('parseRange: open end, closed, suffix, none, junk', J(pv.parseRange('bytes=2-', 10)) === J({ start: 2, end: 9 }) && J(pv.parseRange('bytes=2-4', 10)) === J({ start: 2, end: 4 }) && J(pv.parseRange('bytes=-3', 10)) === J({ start: 7, end: 9 }) && pv.parseRange(null, 10) === undefined && pv.parseRange('bytes=a-b', 10) === undefined && pv.parseRange('bytes=9-2', 10) === null && J(pv.parseRange('bytes=5-99', 10)) === J({ start: 5, end: 9 }));

  // ---- wiring (main.js and friends)
  const main = src('main.js');
  check('main: the scheme is registered with the others (Electron keeps only the last list), on every kind of session', /pdfViewer\.SCHEME/.test(src('features', 'adblock.js')) && /pdfViewer\.attachSession\(session\.defaultSession/.test(main) && /pdfViewer\.attachSession\(ses, pdfHandler\)/.test(main) && (main.match(/pdfViewer\.attachSession\(/g) || []).length >= 3);
  check('main: tabs route PDFs, the address bar shows the PDF\'s address, history records it, the AI and print see the PDF\'s address', /pdfRt\.attach\(tab\)/.test(main) && /pdfViewer\.displayUrl\(url\)/.test(main) && /recordVisit\(pdfViewer\.pdfUrlOf\(url\) \|\| url/.test(main) && /pdfViewer\.pdfUrlOf\(realUrl\(t\.view\.webContents\)\)/.test(main) && /isPdfTab: .*pdfViewer\.isViewerUrl/.test(main));
  check('main: Ctrl+F, Ctrl+= / - / 0 and Print reach the viewer', /pdfRt\.command\(wc, 'find'\)/.test(main) && /pdfRt\.command\(wc, step > 0 \? 'zoomIn'/.test(main) && /ipcMain\.on\('pdf:print'/.test(main) && /senderFrame === e\.sender\.mainFrame/.test(main));
  check('preload: only the viewer\'s own origin gets the print bridge, and nothing else', /location\.origin === 'lumen-pdf:\/\/app'/.test(src('preload', 'permissions-preload.js')) && /exposeInMainWorld\('lumenPdfHost'/.test(src('preload', 'permissions-preload.js')));
  const settings = src('settings', 'settings-backend.js');
  check('setting: pdfViewer is lumen | chrome, default lumen, with a Settings > Downloads choice', /pdfViewer: 'lumen'/.test(settings) && /case 'pdfViewer': return pick\(value, \['lumen', 'chrome'\], null\)/.test(settings) && /select\('pdfViewer', 'Open PDFs with'/.test(src('renderer', 'settings.js')));

  // ---- the AI: scroll, read_pdf, list_tabs
  const scroller = { scrollTop: 100, scrollHeight: 5000, clientHeight: 800, scrollTo(o) { this.scrollTop = o.top; } };
  const api = { state: () => ({ page: Math.floor(scroller.scrollTop / 800) + 1, pages: 7, scrollTop: scroller.scrollTop }) };
  const run = (move) => vm.runInNewContext(pdfInput.lumenScrollScript(move), { document: { getElementById: (id) => (id === 'viewerContainer' ? scroller : null) }, window: { lumenPdf: api }, setTimeout: (fn) => fn(), Promise, Math });
  scroller.scrollTop = 100;
  let r = await run({ screens: 1 });
  check('AI scroll: a screen moves the viewer\'s scroller by 85% of its height and reports page, position and end', scroller.scrollTop === 780 && r.moved === true && r.page === 1 && r.pages === 7 && r.max === 4200, J(r));
  r = await run({ to: 'bottom' });
  check('AI scroll: End goes to the end of the document', scroller.scrollTop === 4200 && r.page === 6, J(r));
  await run({ lines: -40 });
  check('AI scroll: arrows move by lines, Home goes to the top and never past it', scroller.scrollTop === 4160 && (await run({ to: 'top' })).y === 0 && (await run({ screens: -3 })).moved === false);
  const tab = (url, scrolled) => ({ getURL: () => url, executeJavaScript: async (code) => { scrolled.push(code); return { y: 300, max: 900, page: 2, pages: 5, moved: true }; } });
  const calls = [];
  const out = await pdfInput.scrollPdf(tab(view, calls), { screens: 1 });
  check('AI scroll: on a viewer tab scrollPdf scrolls its scroller and answers like the Chrome viewer path', out.scrolled === 'pdf' && out.y === 300 && /page 2 of 5/.test(out.where) && /viewerContainer/.test(calls[0]), J(out));
  check('AI scroll: on an ordinary page scrollPdf leaves the scroll to the page tools (null)', (await pdfInput.scrollPdf({ getURL: () => 'https://a.test/', mainFrame: { framesInSubtree: [] } }, { screens: 1 })) === null);
  check('AI click: a viewer tab is an ordinary page (no PDF-only click path)', (await pdfInput.clickPdf({ getURL: () => view, mainFrame: { framesInSubtree: [] } }, 5, 5)) === null);
  const agent = src('ai', 'agent.js');
  check('AI: read_pdf reads the PDF behind the viewer address, list_tabs and the approval card show its address, per-site AI off follows it', /pdfViewer\.pdfUrlOf\(wc\.getURL\(\)\)/.test(agent) && /taskTabUrl\(\) \{ try \{ const u = .*pdfViewer\.pdfUrlOf\(u\) \|\| u/.test(agent) && /const url = pdfViewer\.pdfUrlOf\(raw\) \|\| raw/.test(agent) && /aiOff: \(url\) => aiSites\.isOff\(pdfViewer\.pdfUrlOf\(url\) \|\| url\)/.test(main));

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
