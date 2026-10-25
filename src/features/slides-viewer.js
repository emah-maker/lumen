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

// The viewer keeps the slide being read in its own #fragment (replaceState), which is not a different page.
const sameViewerUrl = (a, b) => String(a || '').split('#')[0] === String(b || '').split('#')[0];
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

const MEDIA_SLICE = 512 * 1024; // characters of a picture's data: URL sent per call
const nameOf = (deckUrl) => { try { return path.basename(fileURLToPath(deckUrl)).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120); } catch { return 'Presentation'; } };

// The last decks read, for Reload and Back (and read_pdf right after): keyed by path, size and time.
const CACHE = new Map();
const CACHE_MAX = 3;
// { name, width, height, slides, media, mediaInfo, mediaAlias, warnings } or { name, error }. Errors never carry the path.
// first: only the first slide (a thumbnail: features/office-thumb.js), cached apart from the whole deck.
async function loadDeck(deckUrl, { first = false } = {}) {
  const name = nameOf(deckUrl);
  let file;
  try { file = fileURLToPath(deckUrl); } catch { return { name, error: 'This address is not a file.' }; }
  let stat;
  try { stat = await fs.promises.stat(file); } catch { return { name, error: 'The file could not be found. It may have been moved or deleted.' }; }
  if (!stat.isFile()) return { name, error: 'This is not a file.' };
  if (stat.size > pptx.MAX_FILE_BYTES) return { name, error: 'This presentation is too large to open here.' };
  const key = `${file.toLowerCase()}|${stat.size}|${stat.mtimeMs}${first ? '|first' : ''}`;
  if (CACHE.has(key)) return CACHE.get(key);
  let result;
  try {
    const deck = await pptx.parsePptx(await fs.promises.readFile(file), first ? { maxSlides: 1 } : {});
    result = { name, width: deck.width, height: deck.height, slides: deck.slides, media: deck.media, mediaInfo: deck.mediaInfo, mediaAlias: deck.mediaAlias, warnings: deck.warnings, slideCount: deck.slideCount };
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

// The points the largest use of each picture part is shown at, from the slides' shapes (the pictures are drawn at twice that).
function pictureSizes(deck) {
  const sizes = new Map();
  const note = (part, w, h) => { if (typeof part === 'string' && part) sizes.set(part, Math.max(sizes.get(part) || 0, (Number(w) || 0) / pptx.EMU_PER_PT, (Number(h) || 0) / pptx.EMU_PER_PT)); };
  for (const slide of deck.slides || []) {
    for (const s of slide.shapes || []) if (s && s.image) note(s.image, s.w, s.h);
    if (slide.background && slide.background.image) note(slide.background.image, deck.width, deck.height);
  }
  return sizes;
}

// { part: data:image/png URL } for the deck's EMF and WMF pictures that Windows could draw (see emf-gdi.js); {} elsewhere or on any failure.
async function metafilePngs(deck, { cacheDir, platform = process.platform, stats } = {}) {
  const out = {};
  if (platform !== 'win32' || !deck || !deck.media) return out;
  const sizes = pictureSizes(deck);
  const alias = deck.mediaAlias || {};
  const pictures = [];
  for (const [part, value] of Object.entries(deck.media)) {
    const m = typeof value === 'string' ? /^data:image\/x-(?:emf|wmf);base64,/.exec(value) : null;
    if (!m) continue;
    let points = sizes.get(part) || 0;
    for (const [from, to] of Object.entries(alias)) if (to === part) points = Math.max(points, sizes.get(from) || 0);
    pictures.push({ id: part, bytes: Buffer.from(value.slice(m[0].length), 'base64'), points });
  }
  if (!pictures.length) return out;
  const pngs = await require('./emf-gdi').convertMetafiles(pictures, { cacheDir, platform, stats });
  for (const [part, png] of pngs) out[part] = 'data:image/png;base64,' + png.toString('base64');
  return out;
}

function create({ cacheDir } = {}) {
  // thumb: the first slide only, and only the pictures it uses (features/office-thumb.js draws it in a hidden window).
  async function render(wc, url, { thumb = false } = {}) {
    const deckUrl = deckUrlOf(url);
    const data = deckUrl ? await loadDeck(deckUrl, { first: thumb }) : { name: 'Presentation', error: 'Only PowerPoint files (.pptx) on this computer can be shown here.' };
    if (wc.isDestroyed() || !sameViewerUrl(wc.getURL(), url)) return;
    // The deck's structure goes first (small), then the pictures one slice at a time, in the order the slides use them, with a turn of the
    // event loop between: 100 pictures are 10+ MB, and one call with all of them held the main process for 20 to 50 ms (stringify and send).
    const { media, ...structure } = data;
    let pictures = media ? Object.entries(media).filter(([, v]) => typeof v === 'string') : [];
    if (thumb && pictures.length) { // (a part is named in the slide's JSON by its key: the rest of a big deck's pictures are not sent for one thumbnail)
      const used = JSON.stringify(structure.slides || []);
      const alias = structure.mediaAlias || {};
      pictures = pictures.filter(([key]) => used.includes(JSON.stringify(key)) || Object.entries(alias).some(([from, to]) => to === key && used.includes(JSON.stringify(from))));
    }
    // EMF and WMF go through Windows' own renderer (GDI+, in a hidden child process) while the slides and the other pictures are sent; each one the
    // page would otherwise draw itself (EMFJS) is sent after the rest, as a PNG when Windows drew it, as it is when not.
    const vector = ([, v]) => /^data:image\/x-(emf|wmf);/.test(v);
    const gdi = pictures.some(vector) ? metafilePngs(thumb ? { ...data, media: Object.fromEntries(pictures) } : data, { cacheDir }).catch(() => ({})) : null;
    if (gdi) pictures = [...pictures.filter((e) => !vector(e)), ...pictures.filter(vector)];
    const alive = () => !wc.isDestroyed() && sameViewerUrl(wc.getURL(), url);
    const call = (code) => wc.executeJavaScript(code).catch(() => {});
    await call(`window.lumenSlides && window.lumenSlides(${JSON.stringify({ ...structure, mediaKeys: pictures.map(([k]) => k) })})`);
    let pngs = null;
    for (let [key, value] of pictures) {
      if (gdi && vector([key, value])) { pngs = pngs || await gdi; if (!alive()) return; if (pngs[key]) value = pngs[key]; }
      for (let at = 0; at < value.length; at += MEDIA_SLICE) {
        if (!alive()) return;
        await call(`window.lumenSlidesMedia && window.lumenSlidesMedia(${JSON.stringify(key)}, ${at}, ${value.length}, ${JSON.stringify(value.slice(at, at + MEDIA_SLICE))})`);
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
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
  return { attach, openInPlace, present, render };
}

module.exports = { create, metafilePngs, pictureSizes, VIEWER_URL, isViewerUrl, deckUrlOf, viewerUrl, displayUrl, isLocalPptx, shouldOpenInPlace, shouldOpenFinished, loadDeck, loadSlideTexts, nameOf };
