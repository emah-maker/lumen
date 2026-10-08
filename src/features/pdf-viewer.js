// ---------- Lumen's PDF viewer: PDFs shown with a bundled pdf.js instead of Chromium's built-in viewer ----------
// Chromium's viewer lives in an extension frame that Lumen's own input paths (the user's wheel and clicks, the AI's
// scroll / click_at) could not reliably reach, and nothing outside it can read or draw on it. This viewer is an ordinary
// page of Lumen's (renderer/pdfviewer.html + pdfviewer.js, with pdf.js from vendor/pdfjs): the text layer is real text, links
// are real links, the scroller is a normal element, the AI reads and draws on it like any page.
//
// How it is wired (main.js):
//   - The page and pdf.js are served by a privileged scheme, lumen-pdf://app/..., from Lumen's own files only (no path
//     leaves them), under a strict CSP: no remote scripts, no inline script, no plugins, connections to itself only.
//   - The PDF's bytes come from lumen-pdf://app/data?u=<address>: Lumen fetches the address with the tab's own session
//     (its cookies, so a PDF behind a sign-in works) or reads the local file, and answers byte ranges, so pdf.js shows the
//     first page of a large file before it has all of it. Only the viewer itself may ask (Sec-Fetch-Site: same-origin).
//   - A tab that goes to a PDF (an address ending .pdf, or a response that turns out to be application/pdf) is sent to
//     lumen-pdf://app/viewer.html?u=<that address>; the address bar keeps showing the PDF's own address (displayUrl).
//   - Settings > Downloads > "Open PDFs with": Lumen's viewer (default) or Chrome's. PDFs embedded in a page (<embed>,
//     <iframe>) and downloads are left alone.
const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

const SCHEME = 'lumen-pdf';
const ORIGIN = `${SCHEME}://app`;
const VIEWER_PATH = '/viewer.html';
// Registered before the app is ready (adblock.js repeats the whole list: Electron keeps only the last call's).
const PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true, stream: true };
const SETTING_VALUES = ['lumen', 'chrome'];
const MAX_FILE = 1024 * 1024 * 1024; // a local PDF larger than this is refused
const CHROME_VIEWER = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai';

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const VENDOR_DIR = path.join(__dirname, '..', 'vendor', 'pdfjs');
// What the scheme serves: name -> file. Everything else under /vendor/ comes from vendor/pdfjs (cmaps, fonts, wasm, images).
const APP_FILES = { '/viewer.html': 'pdfviewer.html', '/viewer.js': 'pdfviewer.js', '/viewer.css': 'pdfviewer.css', '/tokens.css': 'tokens.css' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.icc': 'application/octet-stream', '.json': 'application/json' };

const CSP = [
  "default-src 'none'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data: blob:",
  "connect-src 'self' data: blob:", "worker-src 'self' blob:", "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');

const cleanSetting = (value) => (SETTING_VALUES.includes(value) ? value : 'lumen');

// ---- addresses
const isViewerUrl = (url) => {
  try { const u = new URL(String(url)); return u.protocol === `${SCHEME}:` && u.host === 'app' && u.pathname === VIEWER_PATH; } catch { return false; }
};
const isWebOrFile = (url) => { try { const p = new URL(String(url)).protocol; return p === 'https:' || p === 'http:' || p === 'file:'; } catch { return false; } };
// The PDF an address of the viewer shows (http(s) or file), else null.
function pdfUrlOf(url) {
  if (!isViewerUrl(url)) return null;
  try { const u = new URL(url).searchParams.get('u') || ''; return isWebOrFile(u) ? u : null; } catch { return null; }
}
const viewerUrl = (pdfUrl) => `${ORIGIN}${VIEWER_PATH}?${new URLSearchParams({ u: pdfUrl })}`;
const displayUrl = (url) => pdfUrlOf(url) || '';
// A fragment (#page=3, #zoom=…) is for the viewer to read; the data request never carries it.
const dataUrl = (pdfUrl) => `${ORIGIN}/data?${new URLSearchParams({ u: String(pdfUrl).split('#')[0] })}`;
const looksLikePdfUrl = (url) => { try { const u = new URL(String(url)); return isWebOrFile(url) && /\.pdf$/i.test(u.pathname); } catch { return false; } };

// ---- routing
// Should a main-frame navigation to `url` go to the viewer instead? (the address of a PDF, with the setting on Lumen's.)
const shouldRoute = ({ url, setting = 'lumen' } = {}) => cleanSetting(setting) === 'lumen' && !isViewerUrl(url) && looksLikePdfUrl(url);
// A page that turned out to be a PDF (its document type is application/pdf, shown by Chromium's viewer): the same, by content.
const shouldRouteDocument = ({ url, contentType, setting = 'lumen' } = {}) => cleanSetting(setting) === 'lumen' && !isViewerUrl(url) && isWebOrFile(url) && String(contentType).toLowerCase() === 'application/pdf';
const isChromeViewerFrame = (frameUrl) => String(frameUrl || '').startsWith(CHROME_VIEWER);

// ---- the scheme's answers
function resolveAsset(pathname) {
  if (APP_FILES[pathname]) return path.join(RENDERER_DIR, APP_FILES[pathname]);
  if (!pathname.startsWith('/vendor/')) return null;
  let rel;
  try { rel = decodeURIComponent(pathname.slice('/vendor/'.length)); } catch { return null; }
  const file = path.normalize(path.join(VENDOR_DIR, rel));
  if (!file.startsWith(VENDOR_DIR + path.sep) || /(^|[\\/])\.\.([\\/]|$)/.test(rel)) return null; // never out of vendor/pdfjs
  return file;
}

// Save a copy: the PDF's own file name (never a path), .pdf at the end.
function disposition(target) {
  let name = 'document.pdf';
  try { name = decodeURIComponent(new URL(target).pathname.split('/').pop() || '') || name; } catch { /* keep the default */ }
  name = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_').slice(0, 120) || 'document.pdf';
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  return `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// "bytes=a-b" | "bytes=a-" | "bytes=-n" for a file of `size` bytes -> { start, end } | null (unsatisfiable) | undefined (no range)
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; } else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return start > end || start >= size ? null : { start, end };
}

function createHandler({ netFetchFor }) {
  const { Readable } = require('stream');
  const plain = (status, text) => new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  return async function handle(req, ses) {
    let url;
    try { url = new URL(req.url); } catch { return plain(400, 'Bad address'); }
    if (url.host !== 'app') return plain(404, 'Not found');
    if (url.pathname === '/data') {
      const site = req.headers.get('sec-fetch-site');
      if (site && site !== 'same-origin') return plain(403, 'Only the viewer can read PDFs this way.');
      const target = url.searchParams.get('u') || '';
      if (!isWebOrFile(target)) return plain(400, 'Not a PDF address');
      const attachment = url.searchParams.get('dl') === '1';
      if (target.startsWith('file:')) return serveFile(target, req, attachment);
      const headers = {};
      for (const h of ['range', 'if-range']) if (req.headers.get(h)) headers[h] = req.headers.get(h);
      let res;
      try { res = await netFetchFor(ses)(target, { headers, credentials: 'include', redirect: 'follow' }); } catch { return plain(502, 'The PDF could not be fetched.'); }
      const out = new Headers({ 'content-type': 'application/pdf', 'cache-control': 'no-store', 'accept-ranges': res.headers.get('accept-ranges') || 'none' });
      if (attachment) out.set('content-disposition', disposition(target));
      for (const h of ['content-length', 'content-range', 'etag', 'last-modified']) if (res.headers.get(h)) out.set(h, res.headers.get(h));
      return new Response(res.status === 204 || res.status === 304 ? null : res.body, { status: res.status, headers: out });
    }
    const file = resolveAsset(url.pathname);
    if (!file) return plain(404, 'Not found');
    let data;
    try { data = await fs.promises.readFile(file); } catch { return plain(404, 'Not found'); }
    const headers = { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'max-age=3600' };
    if (url.pathname === VIEWER_PATH) headers['content-security-policy'] = CSP;
    return new Response(data, { status: 200, headers });
  };

  async function serveFile(target, req, attachment) {
    let file;
    try { file = fileURLToPath(target); } catch { return plain(400, 'Not a file address'); }
    let stat;
    try { stat = await fs.promises.stat(file); } catch { return plain(404, 'The file could not be found. It may have been moved or deleted.'); }
    if (!stat.isFile()) return plain(404, 'Not a file');
    if (stat.size > MAX_FILE) return plain(413, 'This PDF is too large to open here.');
    const range = parseRange(req.headers.get('range'), stat.size);
    const base = { 'content-type': 'application/pdf', 'accept-ranges': 'bytes', 'cache-control': 'no-store', ...(attachment ? { 'content-disposition': disposition(target) } : {}) };
    if (range === null) return new Response(null, { status: 416, headers: { ...base, 'content-range': `bytes */${stat.size}` } });
    const { start, end } = range || { start: 0, end: stat.size - 1 };
    if (stat.size === 0) return new Response(new Uint8Array(0), { status: 200, headers: { ...base, 'content-length': '0' } });
    const body = Readable.toWeb(fs.createReadStream(file, { start, end }));
    return new Response(body, { status: range ? 206 : 200, headers: { ...base, 'content-length': String(end - start + 1), ...(range ? { 'content-range': `bytes ${start}-${end}/${stat.size}` } : {}) } });
  }
}

// Registers the scheme on a session (every session a tab can use: the profile's, a private window's, the research one).
function attachSession(ses, handler) {
  try { ses.protocol.handle(SCHEME, (req) => handler(req, ses)); } catch { /* the session is going away, or already handles it */ }
}

// ---- tabs
// getSetting(): 'lumen' | 'chrome'. Called for every tab's webContents (wireView in main.js).
function create({ getSetting = () => 'lumen' } = {}) {
  function attach(tab) {
    const wc = tab.view.webContents;
    const toViewer = (url) => { if (!wc.isDestroyed()) wc.loadURL(viewerUrl(url)).catch(() => {}); };
    // The address of a PDF: swapped before the PDF loads (Chromium's own viewer never starts).
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      if (shouldRoute({ url: details.url, setting: getSetting() })) toViewer(details.url);
    });
    // A response that is a PDF without saying so in its address: the document type tells, once the page has committed.
    // The PDF's own entry is dropped from history, so Back doesn't land on it and go straight to the viewer again.
    wc.on('did-frame-navigate', (_e, url, _code, _text, isMainFrame) => {
      if (isMainFrame || !isChromeViewerFrame(url)) return;
      const page = wc.getURL();
      if (!isWebOrFile(page) || isViewerUrl(page) || getSetting() !== 'lumen') return;
      wc.executeJavaScript('document.contentType', true).then((type) => {
        if (!shouldRouteDocument({ url: page, contentType: type, setting: getSetting() }) || wc.isDestroyed() || wc.getURL() !== page) return;
        const history = wc.navigationHistory;
        const index = history.getActiveIndex();
        wc.loadURL(viewerUrl(page)).then(() => { try { if (index >= 0 && history.getEntryAtIndex(index)?.url === page) history.removeEntryAtIndex(index); } catch { /* history changed */ } }).catch(() => {});
      }).catch(() => {});
    });
  }
  // The viewer's own commands, from main's keyboard handling (the page has no IPC): Ctrl+F opens its find bar.
  function command(wc, name) {
    if (!wc || wc.isDestroyed() || !isViewerUrl(wc.getURL()) || !/^[a-z]+$/.test(name)) return false;
    wc.executeJavaScript(`window.lumenPdf && window.lumenPdf.${name} && window.lumenPdf.${name}()`, true).catch(() => {});
    return true;
  }
  return { attach, command };
}

module.exports = {
  SCHEME, ORIGIN, PRIVILEGES, VIEWER_PATH, SETTING_VALUES, CSP, CHROME_VIEWER, cleanSetting,
  isViewerUrl, pdfUrlOf, viewerUrl, displayUrl, dataUrl, looksLikePdfUrl, shouldRoute, shouldRouteDocument, isChromeViewerFrame,
  resolveAsset, parseRange, disposition, createHandler, attachSession, create, pathToFileURL,
};
