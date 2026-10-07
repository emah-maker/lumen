// ---------- the slide viewer: PowerPoint decks (.pptx) shown in a tab ----------
// Like Reader mode and View Source (page-tools.js), the viewer is one of Lumen's own pages
// (renderer/slides.html) loaded in the tab, with no preload and no IPC: once it has loaded, the main
// process reads the deck named in its address (?u=<file: URL of a .pptx>), parses it (features/pptx.js)
// and hands it the result with executeJavaScript. The page draws that plain JSON with DOM calls only,
// under a CSP that allows no scripts but its own and no pictures but data: ones, so nothing in a
// deck runs and nothing is fetched. Web pages can't navigate to file:// pages, so they can't open it.
//
// How a deck gets here (main.js):
//   - a local .pptx opened in a tab (typed or pasted path, File > Open, drag and drop, a file: link,
//     another app or the command line): Chromium would download it; the download is cancelled and
//     the tab shows the viewer instead (shouldOpenInPlace);
//   - a .pptx downloaded from the web: it is saved as usual, then opens in a new tab (shouldOpenFinished),
//     unless it was Save Link As.
// The address bar shows the deck's own file: address. read_pdf (ai/agent.js) reads the deck's text.
const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const pptx = require('./pptx');

const VIEWER_URL = pathToFileURL(path.join(__dirname, '..', 'renderer', 'slides.html')).href;

const bareOf = (url) => String(url || '').split(/[?#]/)[0];
const isViewerUrl = (url) => typeof url === 'string' && bareOf(url).toLowerCase() === VIEWER_URL.toLowerCase();
const isLocalPptx = (url) => { try { const u = new URL(url); return u.protocol === 'file:' && pptx.isPptxName(u.pathname); } catch { return false; } };
// The deck a viewer address shows (a file: URL of a .pptx), or null.
function deckUrlOf(url) {
  if (!isViewerUrl(url)) return null;
  try { const u = new URL(url).searchParams.get('u') || ''; return isLocalPptx(u) ? u : null; } catch { return null; }
}
const viewerUrl = (deckUrl) => `${VIEWER_URL}?${new URLSearchParams({ u: deckUrl })}`;
const displayUrl = (url) => deckUrlOf(url) || '';

// A download Chromium starts for a local .pptx opened in a tab: show it instead.
const shouldOpenInPlace = ({ url, filename } = {}) => isLocalPptx(url) && pptx.isPptxName(filename || url);
// A finished download from the web: open it, unless the user chose Save As for it.
const shouldOpenFinished = ({ path: file, saveAs } = {}) => Boolean(file) && !saveAs && pptx.isPptxName(file);

const nameOf = (deckUrl) => { try { return path.basename(fileURLToPath(deckUrl)).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120); } catch { return 'Presentation'; } };

// The last decks read, for Reload and Back (and read_pdf right after): keyed by path, size and time.
const CACHE = new Map();
const CACHE_MAX = 3;
// { name, width, height, slides, media, warnings } or { name, error }. Errors never carry the path.
async function loadDeck(deckUrl) {
  const name = nameOf(deckUrl);
  let file;
  try { file = fileURLToPath(deckUrl); } catch { return { name, error: 'This address is not a file.' }; }
  let stat;
  try { stat = await fs.promises.stat(file); } catch { return { name, error: 'The file could not be found. It may have been moved or deleted.' }; }
  if (!stat.isFile()) return { name, error: 'This is not a file.' };
  if (stat.size > pptx.MAX_FILE_BYTES) return { name, error: 'This presentation is too large to open here.' };
  const key = `${file.toLowerCase()}|${stat.size}|${stat.mtimeMs}`;
  if (CACHE.has(key)) return CACHE.get(key);
  let result;
  try {
    const deck = await pptx.parsePptx(await fs.promises.readFile(file));
    result = { name, width: deck.width, height: deck.height, slides: deck.slides, media: deck.media, warnings: deck.warnings, slideCount: deck.slideCount };
  } catch (err) {
    return { name, error: err instanceof pptx.PptxError ? err.message : 'The presentation could not be read.' };
  }
  CACHE.set(key, result);
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  return result;
}

// The deck's slide text for read_pdf: [text of slide 1, …] (cached like loadDeck).
async function loadSlideTexts(deckUrl) {
  const deck = await loadDeck(deckUrl);
  if (deck.error) throw new pptx.PptxError(deck.error);
  return deck.slides.map((s) => [s.text || '', s.notes ? `Notes: ${s.notes}` : ''].filter(Boolean).join('\n\n'));
}

function create() {
  async function render(wc, url) {
    const deckUrl = deckUrlOf(url);
    const data = deckUrl ? await loadDeck(deckUrl) : { name: 'Presentation', error: 'Only PowerPoint files (.pptx) on this computer can be shown here.' };
    if (wc.isDestroyed() || wc.getURL() !== url) return;
    wc.executeJavaScript(`window.lumenSlides && window.lumenSlides(${JSON.stringify(data)})`).catch(() => {});
  }
  // Called for every tab's webContents (wireView in main.js).
  function attach(tab) {
    const wc = tab.view.webContents;
    wc.on('did-finish-load', () => { const url = wc.getURL(); if (isViewerUrl(url)) render(wc, url); });
  }
  // A local .pptx in `wc` (a tab): the viewer in its place.
  function openInPlace(wc, deckUrl) {
    if (!wc || wc.isDestroyed() || !isLocalPptx(deckUrl)) return false;
    wc.loadURL(viewerUrl(deckUrl)).catch(() => {});
    return true;
  }
  // F5 in the viewer: present (full screen) instead of reloading. A user gesture, so fullscreen is allowed.
  function present(wc) {
    if (!wc || wc.isDestroyed() || !isViewerUrl(wc.getURL())) return false;
    wc.executeJavaScript('window.lumenPresent && window.lumenPresent()', true).catch(() => {});
    return true;
  }
  return { attach, openInPlace, present };
}

module.exports = { create, VIEWER_URL, isViewerUrl, deckUrlOf, viewerUrl, displayUrl, isLocalPptx, shouldOpenInPlace, shouldOpenFinished, loadDeck, loadSlideTexts, nameOf };
