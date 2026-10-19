// ---------- print options: the pure part of Lumen's print preview (features/print-preview.js) ----------
//
// The preview's settings panel sends one plain object; everything here turns it into what Electron wants:
// `webContents.printToPDF(options)` for the preview and "Save as PDF", `webContents.print(options)` for a
// printer. Nothing from the preview page is trusted as is: normalize() keeps only known keys with known values
// and clamps the numbers, so a compromised page can't smuggle a path or an odd option through.

const PDF = '__pdf__'; // the destination value for "Save as PDF" (a printer is its device name)

// Paper sizes Chromium and Electron both know by name; [width, height] in inches (portrait).
const PAPER = {
  Letter: [8.5, 11],
  Legal: [8.5, 14],
  Tabloid: [11, 17],
  A3: [11.69, 16.54],
  A4: [8.27, 11.69],
  A5: [5.83, 8.27],
};
const PAPER_NAMES = Object.keys(PAPER);
const MARGIN_KINDS = ['default', 'none', 'minimum', 'custom'];
const DUPLEX = ['simplex', 'longEdge', 'shortEdge'];

const DEFAULT_MARGIN_IN = 0.4; // Chromium's default (1 cm)
const MINIMUM_MARGIN_IN = 0.1;
const MAX_MARGIN_IN = 5;

const DEFAULTS = Object.freeze({
  destination: PDF,
  landscape: false,
  color: true,
  copies: 1,
  pages: 'all', // 'all' | 'custom'
  ranges: '',
  paper: 'Letter',
  margins: 'default',
  custom: Object.freeze({ top: DEFAULT_MARGIN_IN, bottom: DEFAULT_MARGIN_IN, left: DEFAULT_MARGIN_IN, right: DEFAULT_MARGIN_IN }),
  scale: 'default', // 'default' | 'custom'
  scalePercent: 100,
  headerFooter: false,
  background: false,
  duplex: 'simplex',
});

const clampNumber = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const oneOf = (value, list, fallback) => (list.includes(value) ? value : fallback);

// Settings from anywhere (the preview page, the saved preferences) -> a complete, safe settings object.
// `printers`, when given, is the list of device names the system has: a destination that is neither PDF nor one of
// them becomes PDF (a printer that was unplugged since the last use).
function normalize(raw, { printers = null } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const custom = r.custom && typeof r.custom === 'object' ? r.custom : {};
  const margin = (key) => Math.round(clampNumber(custom[key], 0, MAX_MARGIN_IN, DEFAULTS.custom[key]) * 100) / 100;
  let destination = typeof r.destination === 'string' && r.destination ? r.destination.slice(0, 300) : PDF;
  if (destination !== PDF && printers && !printers.includes(destination)) destination = PDF;
  return {
    destination,
    landscape: r.landscape === true,
    color: r.color !== false,
    copies: Math.round(clampNumber(r.copies, 1, 999, 1)),
    pages: r.pages === 'custom' ? 'custom' : 'all',
    ranges: typeof r.ranges === 'string' ? r.ranges.slice(0, 200) : '',
    paper: oneOf(r.paper, PAPER_NAMES, DEFAULTS.paper),
    margins: oneOf(r.margins, MARGIN_KINDS, DEFAULTS.margins),
    custom: { top: margin('top'), bottom: margin('bottom'), left: margin('left'), right: margin('right') },
    scale: r.scale === 'custom' ? 'custom' : 'default',
    scalePercent: Math.round(clampNumber(r.scalePercent, 10, 200, 100)),
    headerFooter: r.headerFooter === true,
    background: r.background === true,
    duplex: oneOf(r.duplex, DUPLEX, 'simplex'),
  };
}

// "1-5, 8, 11-13" -> { ok: true, ranges: [{ from: 1, to: 5 }, { from: 8, to: 8 }, ...], text: '1-5, 8, 11-13' }.
// Page numbers start at 1. A reversed range, a zero, a stray character or an empty list is { ok: false }.
// `total` (when known) rejects a page past the end: { ok: false, outOf: total }.
function parseRanges(text, total = null) {
  const source = String(text ?? '');
  if (!source.trim()) return { ok: false };
  const ranges = [];
  for (const part of source.split(',')) {
    const m = /^\s*(\d{1,6})\s*(?:-\s*(\d{1,6})\s*)?$/.exec(part);
    if (!m) return { ok: false };
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from < 1 || to < from) return { ok: false };
    if (Number.isFinite(total) && total > 0 && to > total) return { ok: false, outOf: total };
    ranges.push({ from, to });
  }
  return { ok: true, ranges, text: ranges.map((r) => (r.from === r.to ? String(r.from) : `${r.from}-${r.to}`)).join(', ') };
}

// How many pages a range list selects (overlaps counted once).
function pagesIn(ranges) {
  const seen = new Set();
  for (const { from, to } of ranges) for (let p = from; p <= to && seen.size < 1e6; p++) seen.add(p);
  return seen.size;
}

const marginInches = (s) => {
  if (s.margins === 'none') return { top: 0, bottom: 0, left: 0, right: 0 };
  if (s.margins === 'minimum') return { top: MINIMUM_MARGIN_IN, bottom: MINIMUM_MARGIN_IN, left: MINIMUM_MARGIN_IN, right: MINIMUM_MARGIN_IN };
  if (s.margins === 'custom') return { ...s.custom };
  return { top: DEFAULT_MARGIN_IN, bottom: DEFAULT_MARGIN_IN, left: DEFAULT_MARGIN_IN, right: DEFAULT_MARGIN_IN };
};

// The ranges a settings object selects: [] for "All", the parsed list for a valid custom one, null for an invalid one.
function selectedRanges(s) {
  if (s.pages !== 'custom') return [];
  const parsed = parseRanges(s.ranges);
  return parsed.ok ? parsed.ranges : null;
}

// Options for webContents.printToPDF (inches; page ranges as Chromium's "1-5, 8" text).
function toPrintToPdfOptions(raw) {
  const s = normalize(raw);
  const ranges = selectedRanges(s);
  const out = {
    landscape: s.landscape,
    printBackground: s.background,
    displayHeaderFooter: s.headerFooter,
    pageSize: s.paper,
    margins: marginInches(s),
    scale: s.scale === 'custom' ? s.scalePercent / 100 : 1,
    preferCSSPageSize: false,
    generateTaggedPDF: true,
  };
  if (ranges && ranges.length) out.pageRanges = ranges.map((r) => (r.from === r.to ? String(r.from) : `${r.from}-${r.to}`)).join(', ');
  return out;
}

// Options for webContents.print to the printer `s.destination`. Page ranges here count from 0, and the margins are
// points. `page` is { title, url } for the header and footer.
function toPrintOptions(raw, page = {}) {
  const s = normalize(raw);
  const ranges = selectedRanges(s);
  const inches = marginInches(s);
  const margins = s.margins === 'custom'
    ? { marginType: 'custom', top: Math.round(inches.top * 72), bottom: Math.round(inches.bottom * 72), left: Math.round(inches.left * 72), right: Math.round(inches.right * 72) }
    : { marginType: s.margins === 'none' ? 'none' : s.margins === 'minimum' ? 'printableArea' : 'default' };
  const out = {
    silent: true,
    deviceName: s.destination,
    copies: s.copies,
    landscape: s.landscape,
    color: s.color,
    printBackground: s.background,
    margins,
    pageSize: s.paper,
    duplexMode: s.duplex,
  };
  if (s.scale === 'custom') out.scaleFactor = s.scalePercent;
  if (ranges && ranges.length) out.pageRanges = ranges.map((r) => ({ from: r.from - 1, to: r.to - 1 }));
  if (s.headerFooter) { out.header = String(page.title || '').slice(0, 200); out.footer = String(page.url || '').slice(0, 500); }
  return out;
}

// Pages in a PDF the print engine wrote (page objects are plain, not packed into object streams).
function countPdfPages(buffer) {
  if (!buffer || !buffer.length) return 0;
  const text = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer);
  const hits = text.match(/\/Type\s*\/Page(?![A-Za-z])/g);
  return hits ? hits.length : 0;
}

// "Sheets of paper" for `pages` pages: both sides of a sheet are used when printing two-sided.
function sheetCount(pages, duplex = 'simplex') {
  const n = Math.max(0, Math.floor(Number(pages) || 0));
  return duplex === 'simplex' || duplex == null ? n : Math.ceil(n / 2);
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// A page title -> a file name (without the extension) that is valid on Windows, macOS and Linux.
function sanitizeFileName(title, fallback = 'page') {
  let name = String(title ?? '')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  if (name.length > 100) name = name.slice(0, 100).replace(/[. ]+$/, '');
  if (!name || RESERVED.test(name)) return fallback;
  return name;
}

module.exports = {
  PDF, PAPER, PAPER_NAMES, MARGIN_KINDS, DUPLEX, DEFAULTS, DEFAULT_MARGIN_IN,
  normalize, parseRanges, pagesIn, toPrintToPdfOptions, toPrintOptions, countPdfPages, sheetCount, sanitizeFileName,
};
