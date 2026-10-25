// ---------- the Word and Excel viewer: .docx and .xlsx files shown in a tab ----------
// Built like the slide viewer (slides-viewer.js) and the email viewer: one of Lumen's own pages (renderer/office.html) loaded in the tab, with no
// preload and no IPC. Once it has loaded, main reads the file named in its address (?u=<file: URL>), parses it (features/office-doc.js) and hands the
// page plain JSON with executeJavaScript; the page draws that with DOM calls only, under a CSP that allows no scripts but its own and no pictures
// but data: ones, so nothing in a file runs and nothing is fetched. Web pages can't navigate to file:// pages, so they can't open it.
// Read-only: it is a viewer, not an editor (the AI edits a .docx through the Word tools, features/../word).
//
// The tab wiring that every tab needs lives in features/file-tabs.js (the address checks: no parsing, nothing loaded); this module is loaded when the
// first Word or Excel file is shown or previewed, not at startup. Which tabs get here, as for decks: a local file opened in a tab (typed path,
// File > Open, drag and drop, a file: link, "Open with" or the command line: Chromium would download it, and the download is cancelled), the Open
// button of an AI file card, and the Files list.
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const doc = require('./office-doc');
const { PptxError } = require('./pptx');
const fileTabs = require('./file-tabs');

const nameOf = (fileUrl) => { try { return path.basename(fileURLToPath(fileUrl)).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120); } catch { return 'Document'; } };
const kindOf = (name) => (doc.isXlsxName(name) ? 'xlsx' : 'docx');

// What a thumbnail reads: far less than the viewer (the first screenful of a page, the top-left of a sheet).
const THUMB = { docx: { maxBlocks: 70, imageBytes: 3 * 1024 * 1024 }, xlsx: { maxRows: 45, maxCols: 16, maxSheets: 1 } };

// The last files read, for Reload and Back: keyed by path, size, time and whether it is a thumbnail's read.
const CACHE = new Map();
const CACHE_MAX = 3;
// { name, kind, ...model } or { name, kind, error }. An error never carries the path.
async function load(fileUrl, { thumb = false } = {}) {
  const name = nameOf(fileUrl);
  const kind = kindOf(name);
  let file;
  try { file = fileURLToPath(fileUrl); } catch { return { name, kind, error: 'This address is not a file.' }; }
  let stat;
  try { stat = await fs.promises.stat(file); } catch { return { name, kind, error: 'The file could not be found. It may have been moved or deleted.' }; }
  if (!stat.isFile()) return { name, kind, error: 'This is not a file.' };
  if (stat.size > doc.MAX_FILE_BYTES) return { name, kind, error: 'This file is too large to open here.' };
  const key = `${file.toLowerCase()}|${stat.size}|${stat.mtimeMs}|${thumb ? 't' : 'v'}`;
  if (CACHE.has(key)) return CACHE.get(key);
  let result;
  try {
    const buf = await fs.promises.readFile(file);
    result = { name, kind, ...(kind === 'xlsx' ? await doc.parseXlsx(buf, thumb ? THUMB.xlsx : {}) : await doc.parseDocx(buf, thumb ? THUMB.docx : {})) };
  } catch (err) { return { name, kind, error: err instanceof PptxError ? err.message : 'The file could not be read.' }; }
  CACHE.set(key, result);
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  return result;
}

// Fills the viewer page in `wc` (a tab, or the hidden window that draws a thumbnail). `url` is the page's address, which names the file.
async function render(wc, url, { thumb = false } = {}) {
  const fileUrl = fileTabs.officeUrlOf(url);
  const data = fileUrl ? await load(fileUrl, { thumb }) : { name: 'Document', kind: 'docx', error: 'Only Word (.docx) and Excel (.xlsx) files on this computer can be shown here.' };
  if (wc.isDestroyed() || wc.getURL() !== url) return;
  await wc.executeJavaScript(`window.lumenOffice && window.lumenOffice(${JSON.stringify(data)})`).catch(() => {});
}

module.exports = { load, render, nameOf, kindOf, THUMB };
