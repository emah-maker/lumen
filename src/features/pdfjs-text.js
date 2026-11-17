'use strict';
// [pdf text] The second reader for read_pdf (and PDF links, project files): pdf.js, the same library the PDF viewer shows pages with
// (src/vendor/pdfjs). features/pdf-text.js is small and fast, but it can only decode a font through its ToUnicode map; a PDF whose fonts have
// none (Word or LaTeX exports with subset fonts, like a course's homework sheet) came back as "•" or nothing, so the AI decided the file was a
// scan, could not read the problem and drew it from a picture without fonts (boxes for every letter). pdf.js maps glyphs by font encoding and
// glyph names as well. Used only when the small reader found next to nothing (betterPages), and loaded on that first call (perf-budget).
// Runs in main (Node): text only, no canvas, no eval, nothing fetched.
const path = require('path');
const { pathToFileURL } = require('url');

const DIR = path.join(__dirname, '..', 'vendor', 'pdfjs');
const MAX_PAGES = 400; // a huge file is read up to here (the small reader still has the rest, if anything)
const TIMEOUT_MS = 30000;

// The typed-array helpers this build calls (Chromium has them; plain Node, as in the unit tests, may not). Only added when missing.
function polyfill() {
  const U = Uint8Array;
  if (!U.prototype.toHex) U.prototype.toHex = function toHex() { return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString('hex'); };
  if (!U.prototype.toBase64) U.prototype.toBase64 = function toBase64() { return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString('base64'); };
  if (!U.fromBase64) U.fromBase64 = (s) => new U(Buffer.from(String(s), 'base64'));
  if (!U.fromHex) U.fromHex = (s) => new U(Buffer.from(String(s), 'hex'));
}

let lib = null;
function load() {
  lib ||= (async () => {
    polyfill();
    // (Imported in Node, this build logs "Please use the `legacy` build in Node.js environments." once; text extraction works without it.)
    const log = console.log;
    let pdfjs;
    console.log = (...args) => { if (!/legacy.{0,10}build/i.test(String(args[0]))) log(...args); };
    try { pdfjs = await import(pathToFileURL(path.join(DIR, 'pdf.min.mjs')).href); } finally { console.log = log; }
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(DIR, 'pdf.worker.min.mjs')).href;
    return pdfjs;
  })().catch((err) => { lib = null; throw err; });
  return lib;
}

// One page's items as text: a space between runs, a line break where pdf.js saw one.
const textOf = (items) => items.map((i) => `${i.str || ''}${i.hasEOL ? '\n' : ''}`).join(' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();

// buf -> string[] (index 0 = page 1). Throws when pdf.js can't open the file either.
async function pdfjsPages(buf) {
  const pdfjs = await load();
  const data = new Uint8Array(buf.buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf); // (a copy: pdf.js transfers it)
  const task = pdfjs.getDocument({
    data, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0,
    cMapUrl: `${pathToFileURL(path.join(DIR, 'cmaps')).href}/`, cMapPacked: true, standardFontDataUrl: `${pathToFileURL(path.join(DIR, 'standard_fonts')).href}/`,
  });
  let timer;
  try {
    const doc = await Promise.race([task.promise, new Promise((_r, rej) => { timer = setTimeout(() => rej(new Error('pdf.js took too long')), TIMEOUT_MS); })]);
    const out = [];
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      const page = await doc.getPage(n);
      out.push(textOf((await page.getTextContent()).items));
      page.cleanup();
    }
    return out;
  } finally {
    clearTimeout(timer);
    task.destroy().catch?.(() => {});
  }
}

// How much real text pages hold: letters and digits (a page of "•" bullets is none).
const wordsIn = (pages) => (pages || []).reduce((n, p) => n + (String(p).match(/[\p{L}\p{N}]/gu) || []).length, 0);
// The small reader's pages look like a failed read: under 40 letters a page on average (a scan, or fonts it can't decode).
const sparse = (pages) => !pages?.length || wordsIn(pages) < 40 * pages.length;

// The better of the two readers. `first`: the small reader's pages (or null when it threw: `firstError`). pdf.js is asked only when they
// look like a failed read, and wins when it finds more text; a pdf.js failure leaves the first answer as it was (or its error).
async function betterPages(buf, first, firstError = null) {
  if (first && !sparse(first)) return first;
  let second = null;
  try { second = await pdfjsPages(buf); } catch { /* pdf.js could not read it either */ }
  if (second && wordsIn(second) > wordsIn(first)) {
    if (first && first.length > second.length) return second.concat(first.slice(second.length)); // (past MAX_PAGES: what the small reader had)
    return second;
  }
  if (first) return first;
  throw firstError || new Error('This PDF could not be read.');
}

module.exports = { pdfjsPages, betterPages, sparse, wordsIn };
