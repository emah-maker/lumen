// ---------- Word (.docx) and Excel (.xlsx) files as plain JSON, for the office viewer and the file previews ----------
// Like the deck reader (features/pptx.js, whose zip and XML code this uses: Node zlib only, no DTDs, no external entities, nothing is
// fetched) a .docx or .xlsx is read part by part and handed on as plain data. Nothing in the result is HTML: the viewer page
// (renderer/office.js) draws it with createElement and textContent, so a file's text can never become markup or script.
//
//   parseDocx(buf, opts)  -> { blocks, truncated }
//       block:  { t: 'p', style: 'p'|'title'|'subtitle'|'h1'..'h6', align?, list?: { marker, level }, runs: [run] }
//               { t: 'table', rows: [[{ blocks, span?, bg? }]] }   { t: 'hr' } (a page break)
//       run:    { text, b?, i?, u?, s?, sup?, sub?, color?, href? }   or   { img: 'data:image/…', w, h, alt }
//   parseXlsx(buf, opts)  -> { sheets: [{ name, rows: [[cell|null]], cols, colW, merges, truncated }], styles }
//       cell:   { v: 'text as Excel shows it', n?: 1 (a number: right-aligned), s?: index into styles }
//       style:  { b?, i?, color?, bg?, align?, wrap? }
//
// Limits, so a hostile file can't take the browser down: the file size, the total inflated (MAX_INFLATED: a zip bomb stops there), the
// entries, XML nodes and depth (pptx.js), and here the blocks, table cells, text, sheets, rows, columns and picture bytes handed on.
// Fidelity is "readable", not Word's or Excel's layout: headings, paragraphs, bold/italic/underline, lists, tables and pictures;
// sheets with their cell text (numbers, dates, percents the way the file formats them), bold, colors and merged cells. No formulas are run
// (the value the program last saved is shown), and macros, comments, tracked deletions, headers and footers are left out.
const { createZipReader, parseXml, sniffImage, imageSize, PptxError } = require('./pptx');

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_INFLATED = 80 * 1024 * 1024; // everything inflated from one file, pictures included
const MAX_BLOCKS = 20000;
const MAX_CELLS = 20000; // table cells in a document
const MAX_CHARS = 2e6;
const MAX_TABLE_DEPTH = 4;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // one picture
const MAX_IMAGES_BYTES = 24 * 1024 * 1024; // all pictures of one document
const MAX_SHEETS = 40;
const MAX_ROWS = 1000;
const MAX_COLS = 60;
const MAX_STYLES = 400;
const SHOWN_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']); // what the page's CSP and Chromium show; EMF, WMF, TIFF, BMP, SVG are not drawn

const isDocxName = (name) => /\.docx$/i.test(String(name || '').split(/[?#]/)[0]);
const isXlsxName = (name) => /\.xlsx$/i.test(String(name || '').split(/[?#]/)[0]);

const damagedDoc = () => new PptxError('This file is not a Word document (.docx), or it is damaged.');
const damagedSheet = () => new PptxError('This file is not an Excel workbook (.xlsx), or it is damaged.');

// ---- small helpers
const kid = (n, name) => (n ? n.children.find((c) => c.name === name) || null : null);
const kids = (n, name) => (n ? n.children.filter((c) => c.name === name) : []);
const attr = (n, name) => (n && n.attrs ? n.attrs[`w:${name}`] ?? n.attrs[name] : undefined);
// An attribute in a relationships namespace (r:embed, r:id): any prefix.
const relAttr = (n, local) => { if (!n) return null; for (const [k, v] of Object.entries(n.attrs)) if (k.includes(':') && k.slice(k.indexOf(':') + 1) === local) return v; return null; };
const on = (n) => { if (!n) return false; const v = attr(n, 'val'); return v === undefined || !(v === '0' || v === 'false' || v === 'off' || v === 'none'); }; // <w:b/> is on, <w:b w:val="0"/> is off
const HEX = /^[0-9a-fA-F]{6}$/;
const colorOf = (v) => (typeof v === 'string' && HEX.test(v) ? `#${v.toLowerCase()}` : null);
function* walk(node) { for (const c of node.children) { yield c; yield* walk(c); } }

function dirOf(part) { return part.slice(0, part.lastIndexOf('/') + 1); }
function resolvePart(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const out = dirOf(base).split('/').filter(Boolean);
  for (const seg of target.split('/')) { if (seg === '..') out.pop(); else if (seg && seg !== '.') out.push(seg); }
  return out.join('/');
}
async function relsOf(zip, part) {
  const xml = await zip.text(`${dirOf(part)}_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`);
  const rels = new Map();
  if (!xml) return rels;
  for (const r of kids(kid(parseXml(xml), 'Relationships'), 'Relationship')) {
    const id = r.attrs.Id;
    if (!id) continue;
    const external = r.attrs.TargetMode === 'External';
    let target = null;
    if (!external) { try { target = resolvePart(part, decodeURIComponent(String(r.attrs.Target || '').split('#')[0])); } catch { target = null; } }
    rels.set(id, { type: String(r.attrs.Type || '').split('/').pop(), target, external, url: external ? String(r.attrs.Target || '').slice(0, 2000) : null });
  }
  return rels;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_m, ref) => {
    if (ref[0] !== '#') return ENT[ref];
    const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}
const clean = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''); // (control characters never reach the page)

// Opens the package; the same messages as the deck reader's, in this file type's words.
function open(buf, root, { maxBytes = MAX_INFLATED, damaged }) {
  if (!Buffer.isBuffer(buf) || buf.length > MAX_FILE_BYTES) throw new PptxError(`This file is too large to open here.`);
  try { return createZipReader(buf, { maxBytes, root }); } catch (err) {
    if (err instanceof PptxError && /password/.test(err.message)) throw new PptxError('This file is password-protected.');
    if (err instanceof PptxError && /too large/.test(err.message)) throw new PptxError('This file is too large to open here.');
    throw damaged();
  }
}
const tooLarge = (err) => (err instanceof PptxError && /too large/.test(err.message) ? new PptxError('This file is too large to open here.') : err);

// ======================================================================= Word
const ORDERED = { decimal: 'decimal', decimalZero: 'decimal', lowerLetter: 'a', upperLetter: 'A', lowerRoman: 'i', upperRoman: 'I' };
function roman(n, upper) {
  const t = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [v, s] of t) while (n >= v) { out += s; n -= v; }
  return upper ? out.toUpperCase() : out;
}
function markerOf(fmt, n, level) {
  if (fmt === 'bullet' || fmt === 'none' || !fmt) return level % 2 ? '◦' : '•';
  const kind = ORDERED[fmt] || 'decimal';
  if (kind === 'a' || kind === 'A') { let s = ''; let k = n; do { s = String.fromCharCode((kind === 'a' ? 97 : 65) + ((k - 1) % 26)) + s; k = Math.floor((k - 1) / 26); } while (k > 0); return `${s}.`; }
  if (kind === 'i' || kind === 'I') return `${roman(n, kind === 'I')}.`;
  return `${n}.`;
}

function readStyles(xml) {
  const styles = new Map();
  if (!xml) return styles;
  for (const s of kids(kid(parseXml(xml), 'styles'), 'style')) {
    const id = attr(s, 'styleId');
    if (!id) continue;
    styles.set(id, { name: String(attr(kid(s, 'name'), 'val') || '').toLowerCase(), basedOn: attr(kid(s, 'basedOn'), 'val') || null });
  }
  return styles;
}
function styleKind(styles, id) {
  for (let hops = 0; id && hops < 6; hops++) {
    const s = styles.get(id);
    const name = (s ? s.name : String(id)).toLowerCase().replace(/\s+/g, '');
    const h = /^heading([1-9])$/.exec(name);
    if (h) return `h${Math.min(6, Number(h[1]))}`;
    if (name === 'title') return 'title';
    if (name === 'subtitle') return 'subtitle';
    id = s ? s.basedOn : null;
  }
  return 'p';
}
function readNumbering(xml) {
  const abstract = new Map(); // abstractNumId -> { ilvl -> numFmt }
  const nums = new Map(); // numId -> abstractNumId
  if (!xml) return { abstract, nums };
  const root = kid(parseXml(xml), 'numbering');
  for (const a of kids(root, 'abstractNum')) {
    const levels = new Map();
    for (const l of kids(a, 'lvl')) levels.set(String(attr(l, 'ilvl') ?? '0'), attr(kid(l, 'numFmt'), 'val') || 'decimal');
    abstract.set(String(attr(a, 'abstractNumId')), levels);
  }
  for (const n of kids(root, 'num')) nums.set(String(attr(n, 'numId')), String(attr(kid(n, 'abstractNumId'), 'val')));
  return { abstract, nums };
}

// The runs of one paragraph. `ctx.pending` collects picture references to resolve once the parts are read.
function runsOf(p, ctx, rels) {
  const out = [];
  const push = (run) => { if (run.text) { const last = out[out.length - 1]; if (last && !last.img && JSON.stringify({ ...last, text: 0 }) === JSON.stringify({ ...run, text: 0 })) { last.text += run.text; return; } } out.push(run); };
  const visit = (node, inherited, href) => {
    for (const c of node.children) {
      if (ctx.chars > MAX_CHARS) return;
      if (c.name === 'del' || c.name === 'pPr' || c.name === 'rPrChange' || c.name === 'commentRangeStart' || c.name === 'proofErr') continue;
      if (c.name === 'hyperlink') {
        const rel = rels.get(relAttr(c, 'id') || '');
        const url = rel && rel.external && /^(https?:|mailto:)/i.test(rel.url || '') ? rel.url : null;
        visit(c, inherited, url || href);
      } else if (c.name === 'r') {
        const rPr = kid(c, 'rPr');
        const fmt = { ...inherited };
        if (rPr) {
          if (kid(rPr, 'b')) fmt.b = on(kid(rPr, 'b')) || undefined;
          if (kid(rPr, 'i')) fmt.i = on(kid(rPr, 'i')) || undefined;
          if (kid(rPr, 'u')) fmt.u = on(kid(rPr, 'u')) || undefined;
          if (kid(rPr, 'strike')) fmt.s = on(kid(rPr, 'strike')) || undefined;
          const va = attr(kid(rPr, 'vertAlign'), 'val');
          if (va === 'superscript') fmt.sup = true; else if (va === 'subscript') fmt.sub = true;
          const col = colorOf(attr(kid(rPr, 'color'), 'val'));
          if (col && col !== '#000000') fmt.color = col;
        }
        if (href) { fmt.href = href; fmt.u = true; }
        let text = '';
        const flush = () => { if (text) { ctx.chars += text.length; push({ text: clean(text), ...compact(fmt) }); text = ''; } };
        for (const k of c.children) {
          if (k.name === 't') text += k.text;
          else if (k.name === 'tab') text += '\t';
          else if (k.name === 'br' || k.name === 'cr') { if (attr(k, 'type') === 'page') { flush(); out.push({ pageBreak: true }); } else text += '\n'; }
          else if (k.name === 'noBreakHyphen') text += '-';
          else if (k.name === 'drawing' || k.name === 'pict') { flush(); const img = imageRef(k, rels, ctx); if (img) out.push(img); }
        }
        flush();
      } else if (c.name === 'ins' || c.name === 'smartTag' || c.name === 'sdt' || c.name === 'sdtContent' || c.name === 'fldSimple' || c.name === 'customXml') visit(c, inherited, href);
    }
  };
  visit(p, {}, null);
  return out;
}
const compact = (fmt) => { const o = {}; for (const [k, v] of Object.entries(fmt)) if (v) o[k] = v; return o; };

// A picture in a run: { img: <pending>, w, h, alt }, resolved to a data: URL later (resolveImages).
function imageRef(node, rels, ctx) {
  let embed = null;
  let extent = null;
  let alt = '';
  for (const n of walk(node)) {
    if (n.name === 'blip' && !embed) embed = relAttr(n, 'embed');
    else if (n.name === 'imagedata' && !embed) embed = relAttr(n, 'id');
    else if (n.name === 'extent' && !extent) extent = n.attrs;
    else if (n.name === 'docPr' && !alt) alt = String(n.attrs.descr || n.attrs.name || '').slice(0, 200);
  }
  const rel = embed ? rels.get(embed) : null;
  if (!rel || rel.external || !rel.target) return null;
  const px = (v) => Math.max(1, Math.min(2000, Math.round((Number(v) || 0) / 9525)));
  const run = { img: null, part: rel.target, w: extent ? px(extent.cx) : 0, h: extent ? px(extent.cy) : 0, alt: clean(alt) };
  ctx.pending.push(run);
  return run;
}

function paragraph(p, ctx, rels) {
  const pPr = kid(p, 'pPr');
  const style = styleKind(ctx.styles, attr(kid(pPr, 'pStyle'), 'val'));
  const blockRuns = runsOf(p, ctx, rels);
  const breaks = blockRuns.some((r) => r.pageBreak);
  const runs = blockRuns.filter((r) => !r.pageBreak);
  const block = { t: 'p', style, runs };
  const jc = attr(kid(pPr, 'jc'), 'val');
  if (jc === 'center' || jc === 'right') block.align = jc; else if (jc === 'both' || jc === 'distribute') block.align = 'justify';
  const numPr = kid(pPr, 'numPr');
  const numId = numPr ? String(attr(kid(numPr, 'numId'), 'val') ?? '') : '';
  if (numPr && numId && numId !== '0') {
    const level = Math.min(8, Math.max(0, Number(attr(kid(numPr, 'ilvl'), 'val')) || 0));
    const fmt = ctx.numbering.abstract.get(ctx.numbering.nums.get(numId))?.get(String(level)) || 'bullet';
    const counters = ctx.counters.get(numId) || [];
    counters[level] = (counters[level] || 0) + 1;
    counters.length = level + 1; // a deeper level starts over
    ctx.counters.set(numId, counters);
    block.list = { marker: markerOf(fmt, counters[level], level), level };
  }
  return { block, breaks };
}

function blocksOf(node, ctx, rels, out, depth) {
  for (const c of node.children) {
    if (out.length >= MAX_BLOCKS || ctx.chars > MAX_CHARS || ctx.stop) { ctx.truncated = true; return; }
    if (c.name === 'p') {
      const { block, breaks } = paragraph(c, ctx, rels);
      if (block.runs.length || block.list) out.push(block); else out.push({ t: 'p', style: 'p', runs: [], empty: true });
      if (breaks) out.push({ t: 'hr' });
      if (ctx.maxBlocks && ctx.count++ >= ctx.maxBlocks) { ctx.stop = true; ctx.truncated = true; return; }
    } else if (c.name === 'tbl') {
      if (depth >= MAX_TABLE_DEPTH) continue;
      const rows = [];
      for (const tr of kids(c, 'tr')) {
        const cells = [];
        for (const tc of kids(tr, 'tc')) {
          if (ctx.cells++ >= MAX_CELLS) { ctx.truncated = true; break; }
          const tcPr = kid(tc, 'tcPr');
          const cell = { blocks: [] };
          const span = Number(attr(kid(tcPr, 'gridSpan'), 'val')) || 1;
          if (span > 1) cell.span = Math.min(span, 30);
          const fill = colorOf(attr(kid(tcPr, 'shd'), 'fill'));
          if (fill) cell.bg = fill;
          blocksOf(tc, ctx, rels, cell.blocks, depth + 1);
          if (!cell.blocks.length) cell.blocks.push({ t: 'p', style: 'p', runs: [], empty: true });
          cells.push(cell);
        }
        if (cells.length) rows.push(cells);
      }
      if (rows.length) out.push({ t: 'table', rows });
    } else if (c.name === 'document' || c.name === 'body' || c.name === 'sdt' || c.name === 'sdtContent' || c.name === 'ins' || c.name === 'customXml') blocksOf(c, ctx, rels, out, depth);
  }
}

// Reads the pictures the blocks point at (once each), into data: URLs inside the byte budget; one that can't be shown stays as its text.
async function resolveImages(zip, ctx, { imageBytes = MAX_IMAGES_BYTES } = {}) {
  const cache = new Map();
  let used = 0;
  for (const run of ctx.pending) {
    let got = cache.get(run.part);
    if (got === undefined) {
      got = null;
      try {
        const bytes = zip.has(run.part) ? await zip.bytes(run.part) : null;
        const type = bytes && bytes.length <= MAX_IMAGE_BYTES ? sniffImage(bytes) : null;
        if (type && SHOWN_IMAGES.has(type) && used + bytes.length <= imageBytes) {
          used += bytes.length;
          got = { url: `data:${type};base64,${bytes.toString('base64')}`, size: imageSize(bytes, type) };
        }
      } catch (err) { if (err instanceof PptxError && /too large/.test(err.message)) throw tooLarge(err); }
      cache.set(run.part, got);
    }
    delete run.part;
    if (got) {
      run.img = got.url;
      if (!run.w && got.size) { run.w = Math.min(got.size.w, 800); run.h = Math.round(got.size.h * (run.w / got.size.w)); }
      if (!run.w) { run.w = 200; run.h = 150; }
    } else { run.img = ''; ctx.skipped++; }
  }
}
const stripPending = (blocks) => {
  const fix = (b) => {
    if (b.t === 'p') b.runs = b.runs.map((r) => (r.img === '' ? { text: r.alt ? `[${r.alt}]` : '[picture]', i: true, color: '#6e6e73' } : r));
    else if (b.t === 'table') for (const row of b.rows) for (const cell of row) cell.blocks.forEach(fix);
  };
  blocks.forEach(fix);
};

// opts.maxBlocks: stop after that many paragraphs (a first-page thumbnail); opts.imageBytes: the picture budget.
async function parseDocx(buf, opts = {}) {
  const zip = open(buf, 'word/document.xml', { damaged: damagedDoc });
  try {
    const xml = await zip.text('word/document.xml');
    if (!xml) throw damagedDoc();
    const rels = await relsOf(zip, 'word/document.xml');
    const ctx = {
      styles: readStyles(await zip.text('word/styles.xml')), numbering: readNumbering(await zip.text('word/numbering.xml')),
      counters: new Map(), pending: [], chars: 0, cells: 0, count: 0, skipped: 0, truncated: false, stop: false, maxBlocks: opts.maxBlocks || 0,
    };
    const blocks = [];
    blocksOf(parseXml(xml), ctx, rels, blocks, 0);
    await resolveImages(zip, ctx, { imageBytes: opts.imageBytes });
    stripPending(blocks);
    return { blocks, truncated: ctx.truncated };
  } catch (err) { throw err instanceof PptxError ? tooLarge(err) : damagedDoc(); }
}

// ======================================================================= Excel
const BUILTIN_FORMATS = { 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 37: '#,##0', 38: '#,##0', 39: '#,##0.00', 40: '#,##0.00', 48: '##0.0E+0' };
const DATE_IDS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const TIME_IDS = new Set([18, 19, 20, 21, 45, 46, 47]);
const unquote = (code) => String(code).replace(/"[^"]*"|\\.|\[[^\]]*\]|_.|\*./g, '');
function dateKind(code) { // 'date' | 'time' | 'datetime' | null for a custom format code
  const c = unquote(String(code).split(';')[0]).toLowerCase();
  const day = /[dy]/.test(c);
  const time = /h|s|am\/pm/.test(c);
  if (!day && !time) return null; // (a bare "m" is a month or a minute: not enough)
  return day && time ? 'datetime' : day ? 'date' : 'time';
}
const pad2 = (n) => String(n).padStart(2, '0');
function formatDate(serial, kind, date1904) {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958465) return String(serial);
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, serial >= 61 ? 30 : 31); // (1900 is a leap year in Excel's calendar, and was not)
  const ms = Math.round(serial * 86400000);
  const d = new Date(base + ms);
  const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}${d.getUTCSeconds() ? `:${pad2(d.getUTCSeconds())}` : ''}`;
  if (kind === 'time') return time;
  return kind === 'datetime' ? `${date} ${time}` : date;
}
function group3(s) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
// A number the way its format code would show it (the common codes: plain, fixed decimals, thousands, percent, scientific, a currency sign).
function formatNumber(v, code) {
  if (!Number.isFinite(v)) return String(v);
  const section = String(code || 'General').split(';')[0];
  if (/^general$/i.test(section.trim()) || !section.trim()) return Number.isInteger(v) ? String(v) : String(parseFloat(v.toPrecision(10)));
  const bare = unquote(section);
  const currency = (/\$/.test(section) && '$') || (/€/.test(section) && '€') || (/£/.test(section) && '£') || (/¥/.test(section) && '¥') || '';
  const percent = bare.includes('%');
  const decimals = (/\.([0#?]+)/.exec(bare) || ['', ''])[1].length;
  if (/e[+-]/i.test(bare)) return v.toExponential(decimals).replace(/e([+-])(\d)$/, 'e$10$2').toUpperCase();
  let n = percent ? v * 100 : v;
  const neg = n < 0;
  n = Math.abs(n);
  let s = n.toFixed(Math.min(decimals, 10));
  if (decimals && /\.[0#?]*#$/.test(bare)) s = s.replace(/\.?0+$/, ''); // optional decimals (0.##)
  if (/#,##|0,0/.test(bare)) { const [i, f] = s.split('.'); s = group3(i) + (f ? `.${f}` : ''); }
  return `${neg ? '-' : ''}${currency}${s}${percent ? '%' : ''}`;
}

function readStyleSheet(xml) {
  const out = { xfs: [], formats: new Map(), fonts: [], fills: [] };
  if (!xml) return out;
  const root = kid(parseXml(xml), 'styleSheet');
  for (const f of kids(kid(root, 'numFmts'), 'numFmt')) out.formats.set(Number(f.attrs.numFmtId), String(f.attrs.formatCode || ''));
  for (const f of kids(kid(root, 'fonts'), 'font')) {
    const color = kid(f, 'color');
    out.fonts.push({ b: on(kid(f, 'b')) || undefined, i: on(kid(f, 'i')) || undefined, color: color && /^[0-9a-fA-F]{8}$/.test(color.attrs.rgb || '') ? `#${color.attrs.rgb.slice(2).toLowerCase()}` : undefined });
  }
  for (const f of kids(kid(root, 'fills'), 'fill')) {
    const p = kid(f, 'patternFill');
    const fg = p && kid(p, 'fgColor');
    out.fills.push(p && p.attrs.patternType === 'solid' && fg && /^[0-9a-fA-F]{8}$/.test(fg.attrs.rgb || '') ? `#${fg.attrs.rgb.slice(2).toLowerCase()}` : undefined);
  }
  for (const x of kids(kid(root, 'cellXfs'), 'xf')) {
    const al = kid(x, 'alignment');
    out.xfs.push({ numFmtId: Number(x.attrs.numFmtId) || 0, fontId: Number(x.attrs.fontId) || 0, fillId: Number(x.attrs.fillId) || 0, align: al && ['left', 'center', 'right'].includes(al.attrs.horizontal) ? al.attrs.horizontal : undefined, wrap: al && (al.attrs.wrapText === '1' || al.attrs.wrapText === 'true') || undefined });
  }
  return out;
}

const colIndex = (letters) => { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
const CELL_REF = /^([A-Z]{1,3})(\d+)$/;

// The shared strings the cells need, read without building a tree (a big workbook has hundreds of thousands).
function sharedStringsAt(xml, wanted) {
  const found = new Map();
  if (!xml || !wanted.size) return found;
  const last = Math.max(...wanted);
  let pos = 0;
  for (let i = 0; i <= last; i++) {
    const s = xml.indexOf('<si', pos);
    if (s < 0) break;
    const isSelf = /^<si\b[^>]*\/>/.test(xml.slice(s, s + 200));
    let e;
    if (isSelf) { e = xml.indexOf('/>', s) + 2; } else { e = xml.indexOf('</si>', s); if (e < 0) break; e += 5; }
    if (wanted.has(i) && !isSelf) {
      const item = xml.slice(s, e).replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').replace(/<phoneticPr\b[^>]*\/>/g, '');
      let text = '';
      for (const m of item.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) text += m[1] ? decode(m[1]) : '';
      found.set(i, clean(text));
    }
    pos = e;
  }
  return found;
}

function readSheet(xml, { maxRows, maxCols, ctx }) {
  const sd = xml.indexOf('<sheetData');
  const sdEnd = xml.indexOf('</sheetData>');
  const rows = [];
  let ncols = 0;
  let truncated = false;
  if (sd >= 0) {
    const end = sdEnd >= 0 ? sdEnd : xml.length;
    let pos = xml.indexOf('>', sd) + 1;
    let seq = 0;
    for (;;) {
      const rs = xml.indexOf('<row', pos);
      if (rs < 0 || rs >= end) break;
      const tagEnd = xml.indexOf('>', rs);
      if (tagEnd < 0) break;
      const self = xml[tagEnd - 1] === '/';
      const re = self ? tagEnd + 1 : xml.indexOf('</row>', tagEnd);
      if (re < 0) break;
      const slice = xml.slice(rs, self ? tagEnd + 1 : re + 6);
      pos = self ? tagEnd + 1 : re + 6;
      if (!/^<row[\s/>]/.test(slice)) continue; // (<rowBreaks …>)
      const row = kid(parseXml(slice), 'row');
      const r = Number(row.attrs.r) || seq + 1;
      seq = r;
      if (r > maxRows) { truncated = true; break; }
      if (!self && row.attrs.hidden !== '1' && row.attrs.hidden !== 'true') {
        const cells = [];
        let cursor = 0;
        for (const c of kids(row, 'c')) {
          const m = CELL_REF.exec(c.attrs.r || '');
          const col = m ? colIndex(m[1]) : cursor;
          cursor = col + 1;
          if (col >= maxCols) { truncated = true; continue; }
          const cell = cellOf(c, ctx);
          if (cell) { cells[col] = cell; ncols = Math.max(ncols, col + 1); }
        }
        while (rows.length < r - 1) rows.push([]);
        rows[r - 1] = cells;
      }
    }
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = []; // (a hidden or empty row)
  return { rows, ncols, truncated };
}

// One <c>: { v, n?, s? } or null when it has nothing to show. Shared strings are { ss: index } until resolved.
function cellOf(c, ctx) {
  const t = c.attrs.t || 'n';
  const vNode = kid(c, 'v');
  const raw = vNode ? vNode.text : '';
  let cell;
  const xf = ctx.sheet.xfs[Number(c.attrs.s) || 0];
  if (t === 's') { if (raw === '') return null; const idx = Number(raw); if (!Number.isInteger(idx) || idx < 0) return null; cell = { ss: idx }; ctx.wanted.add(idx); }
  else if (t === 'inlineStr') { // (the phonetic guide, rPh, is not text)
    const is = kid(c, 'is'); const text = is ? is.children.flatMap((n) => (n.name === 't' ? [n] : n.name === 'r' ? kids(n, 't') : [])).map((n) => n.text).join('') : ''; if (!text) return null; cell = { v: clean(text) }; }
  else if (t === 'str') { if (raw === '') return null; cell = { v: clean(raw) }; }
  else if (t === 'b') cell = { v: raw === '1' ? 'TRUE' : 'FALSE' };
  else if (t === 'e') cell = { v: clean(raw) };
  else if (t === 'd') cell = raw ? { v: clean(raw.replace('T', ' ').replace(/(?:\.\d+)?Z$/, '')) } : null;
  else {
    if (raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) cell = { v: clean(raw) };
    else {
      const id = xf ? xf.numFmtId : 0;
      const code = ctx.sheet.formats.get(id) ?? BUILTIN_FORMATS[id];
      const kind = DATE_IDS.has(id) ? 'date' : TIME_IDS.has(id) ? 'time' : ctx.sheet.formats.has(id) ? dateKind(code) : null;
      cell = kind ? { v: formatDate(n, kind === 'date' && id === 22 ? 'datetime' : kind, ctx.date1904) } : { v: formatNumber(n, code), n: 1 };
    }
  }
  if (!cell) return null;
  if (xf) {
    const font = ctx.sheet.fonts[xf.fontId] || {};
    const style = {};
    if (font.b) style.b = true;
    if (font.i) style.i = true;
    if (font.color && font.color !== '#000000') style.color = font.color;
    const bg = ctx.sheet.fills[xf.fillId];
    if (bg && bg !== '#ffffff') style.bg = bg;
    if (xf.align) style.align = xf.align;
    if (xf.wrap) style.wrap = true;
    const key = JSON.stringify(style);
    if (key !== '{}') {
      let at = ctx.styleIds.get(key);
      if (at === undefined && ctx.styles.length < MAX_STYLES) { at = ctx.styles.length; ctx.styles.push(style); ctx.styleIds.set(key, at); }
      if (at !== undefined) cell.s = at;
    }
  }
  return cell;
}

function colWidths(xml, maxCols) {
  const out = [];
  const cols = /<cols>([\s\S]*?)<\/cols>/.exec(xml);
  if (!cols) return out;
  for (const m of cols[1].matchAll(/<col\b([^>]*)\/?>/g)) {
    const a = {};
    for (const x of m[1].matchAll(/([A-Za-z:]+)="([^"]*)"/g)) a[x[1]] = x[2];
    const min = Number(a.min);
    const max = Math.min(Number(a.max) || min, maxCols);
    const w = Number(a.width);
    if (!(min >= 1) || !(w > 0)) continue;
    const px = Math.max(24, Math.min(600, Math.round(w * 7 + 5)));
    for (let c = min; c <= max; c++) out[c - 1] = px;
  }
  return out;
}
function mergesOf(xml, rowCount, colCount) {
  const out = [];
  for (const m of xml.matchAll(/<mergeCell\b[^>]*\bref="([A-Z]{1,3})(\d+):([A-Z]{1,3})(\d+)"/g)) {
    if (out.length >= 2000) break;
    const r1 = Number(m[2]) - 1; const c1 = colIndex(m[1]); const r2 = Math.min(Number(m[4]) - 1, rowCount - 1); const c2 = Math.min(colIndex(m[3]), colCount - 1);
    if (r1 <= r2 && c1 <= c2 && r1 < rowCount && c1 < colCount && (r2 > r1 || c2 > c1)) out.push([r1, c1, r2, c2]);
  }
  return out;
}

// opts.maxRows / maxCols / maxSheets: the part shown (a thumbnail reads far less than the viewer).
async function parseXlsx(buf, opts = {}) {
  const zip = open(buf, 'xl/workbook.xml', { damaged: damagedSheet });
  const maxRows = opts.maxRows || MAX_ROWS;
  const maxCols = opts.maxCols || MAX_COLS;
  try {
    const wb = kid(parseXml(await zip.text('xl/workbook.xml')), 'workbook');
    if (!wb) throw damagedSheet();
    const rels = await relsOf(zip, 'xl/workbook.xml');
    const ctx = { sheet: readStyleSheet(await zip.text('xl/styles.xml')), styles: [], styleIds: new Map(), wanted: new Set(), date1904: /^(1|true)$/.test(kid(wb, 'workbookPr')?.attrs.date1904 || '') };
    const sheets = [];
    const want = opts.maxSheets || MAX_SHEETS;
    let more = false;
    for (const s of kids(kid(wb, 'sheets'), 'sheet')) {
      if (s.attrs.state === 'hidden' || s.attrs.state === 'veryHidden') continue;
      if (sheets.length >= want) { more = true; break; }
      const rel = rels.get(relAttr(s, 'id') || '');
      const xml = rel && rel.target && zip.has(rel.target) ? await zip.text(rel.target) : null;
      const name = clean(String(s.attrs.name || `Sheet ${sheets.length + 1}`)).slice(0, 60);
      if (!xml) { sheets.push({ name, rows: [], cols: 0, colW: [], merges: [], truncated: false }); continue; }
      const got = readSheet(xml, { maxRows, maxCols, ctx });
      const colCount = Math.max(got.ncols, 1);
      sheets.push({ name, rows: got.rows, cols: got.ncols, colW: colWidths(xml, maxCols).slice(0, colCount), merges: mergesOf(xml, got.rows.length, colCount), truncated: got.truncated });
    }
    if (!sheets.length) throw damagedSheet();
    const strings = sharedStringsAt(ctx.wanted.size ? await zip.text('xl/sharedStrings.xml') : null, ctx.wanted);
    for (const sh of sheets) for (const row of sh.rows) for (let i = 0; i < row.length; i++) { const c = row[i]; if (c && c.ss !== undefined) { c.v = strings.get(c.ss) || ''; delete c.ss; if (!c.v) row[i] = undefined; } }
    // (a row's holes become null so the JSON stays an array of cells)
    for (const sh of sheets) sh.rows = sh.rows.map((row) => { const r = []; for (let i = 0; i < row.length; i++) r.push(row[i] || null); return r; });
    return { sheets, styles: ctx.styles, moreSheets: more };
  } catch (err) { throw err instanceof PptxError ? tooLarge(err) : damagedSheet(); }
}

module.exports = { parseDocx, parseXlsx, isDocxName, isXlsxName, formatNumber, formatDate, MAX_FILE_BYTES, MAX_INFLATED, MAX_ROWS, MAX_COLS, MAX_BLOCKS };
