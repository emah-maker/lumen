// [word] Word documents without Word: reading a .docx with its structure (headings, lists, tables, comments, a tracked-changes summary), and a
// small, careful writer for what is safe to do to the XML by hand: new paragraphs (in any of its styles, list items in real lists), a new table,
// a new empty document, formatting (styles, paragraphs, the exact text found, pages) and lists. Find and replace, pictures and comments need Word itself.
//
// Safety: the zip is read with the same limits as every other Office file here (features/pptx.js: size, entry count, inflated bytes, no DTDs);
// a write copies every part it does not change byte for byte (still compressed), rewrites only word/document.xml, and goes to a temp file next to the
// original that replaces it in one rename, so a failure leaves the original untouched. No zip64, no encrypted files, no macros are ever written.
// Text goes into the XML escaped (and stripped of characters XML cannot hold); nothing from a document is run or fetched.
'use strict';

const zlib = require('zlib');
const { createZipReader, parseXml, PptxError } = require('../features/pptx');
const { WordError } = require('./spec');

const MAX_DOCX_BYTES = 100 * 1024 * 1024;
const MAX_INFLATED = 60 * 1024 * 1024;
const AUTHOR = 'AI (Lumen)';
const damaged = () => new WordError('This file is not a Word document (.docx), or it is damaged.');

// ---- reading
const kid = (n, name) => (n ? n.children.find((c) => c.name === name) || null : null);
const attr = (n, name) => (n && n.attrs ? n.attrs[`w:${name}`] ?? n.attrs[name] : undefined);

function paragraphText(p) {
  let out = '';
  const visit = (node) => {
    for (const c of node.children) {
      if (c.name === 'del' || c.name === 'delText' || c.name === 'instrText') continue;
      if (c.name === 't') out += c.text;
      else if (c.name === 'tab') out += '\t';
      else if (c.name === 'br' || c.name === 'cr') out += ' ';
      else if (c.name === 'noBreakHyphen') out += '-';
      else visit(c);
    }
  };
  visit(p);
  return out;
}

function lineOf(p) {
  const pPr = kid(p, 'pPr');
  const style = attr(kid(pPr, 'pStyle'), 'val') || '';
  const text = paragraphText(p);
  if (!text.trim() && [...walk(p)].some((n) => n.name === 'drawing' || n.name === 'pict')) return '[picture]';
  const heading = /^Heading([1-6])$/i.exec(style) || (/^Title$/i.test(style) ? [0, '1'] : null);
  if (heading && text.trim()) return `${'#'.repeat(Number(heading[1]))} ${text.trim()}`;
  const num = kid(pPr, 'numPr');
  if (num || /^List/i.test(style)) { const lvl = Number(attr(kid(num, 'ilvl'), 'val')) || 0; return `${'  '.repeat(Math.min(lvl, 6))}- ${text}`; }
  return text;
}

function collect(node, blocks) {
  for (const c of node.children) {
    if (c.name === 'p') blocks.push(lineOf(c));
    else if (c.name === 'tbl') {
      const rows = c.children.filter((k) => k.name === 'tr').map((row) => {
        const cells = row.children.filter((k) => k.name === 'tc').map((tc) => { const inner = []; collect(tc, inner); return inner.join(' ').replace(/\s+/g, ' ').trim(); });
        return `| ${cells.join(' | ')} |`;
      });
      blocks.push(rows.join('\n'));
    } else if (c.name === 'document' || c.name === 'body' || c.name === 'sdt' || c.name === 'sdtContent' || c.name === 'ins') collect(c, blocks);
  }
}

function* walk(node) { for (const c of node.children) { yield c; yield* walk(c); } }

// -> { total, text, next, comments, commentCount, revisions } like Word's own read answer; offset and next count blocks (a table is one block).
async function readDocx(buf, { offset = 0, budget = 6000 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length > MAX_DOCX_BYTES) throw new WordError('This Word file is too large to read here.');
  let zip;
  try { zip = createZipReader(buf, { maxBytes: MAX_INFLATED, root: 'word/document.xml' }); } catch (err) {
    throw err instanceof PptxError && /password/.test(err.message) ? new WordError('This Word file is password-protected.') : damaged();
  }
  let doc;
  try { doc = parseXml(await zip.text('word/document.xml')); } catch (err) { throw err instanceof WordError ? err : damaged(); }
  const blocks = [];
  collect(doc, blocks);
  const out = [];
  let used = 0;
  let i = Math.max(0, offset);
  while (i < blocks.length && used < budget) { out.push(blocks[i]); used += blocks[i].length + 1; i++; }
  const res = { total: blocks.length, offset, text: out.join('\n'), next: i < blocks.length ? i : null };
  if (offset === 0) {
    let ins = 0; let del = 0; const authors = new Set();
    for (const n of walk(doc)) {
      if (n.name === 'ins') ins++; else if (n.name === 'del') del++; else continue;
      const a = attr(n, 'author'); if (a) authors.add(a);
    }
    res.revisions = { total: ins + del, inserted: ins, deleted: del, authors: [...authors].slice(0, 10) };
    res.comments = [];
    res.commentCount = 0;
    try {
      const cx = zip.has('word/comments.xml') ? await zip.text('word/comments.xml') : null;
      if (cx) {
        const root = parseXml(cx);
        const all = [...walk(root)].filter((n) => n.name === 'comment');
        res.commentCount = all.length;
        res.comments = all.slice(0, 30).map((c) => ({ author: attr(c, 'author') || '', on: '', text: [...walk(c)].filter((n) => n.name === 't').map((n) => n.text).join('').slice(0, 400) }));
      }
    } catch { /* comments are a bonus */ }
  }
  return res;
}

// ---- zip writing
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function centralEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22 || buf.length > MAX_DOCX_BYTES) throw damaged();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw damaged();
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || count > 5000) throw new WordError('This file uses a zip format Lumen does not edit.');
  const entries = [];
  let p = cdOffset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw damaged();
    const flags = buf.readUInt16LE(p + 8);
    const e = { flags, method: buf.readUInt16LE(p + 10), time: buf.readUInt16LE(p + 12), date: buf.readUInt16LE(p + 14), crc: buf.readUInt32LE(p + 16), csize: buf.readUInt32LE(p + 20), usize: buf.readUInt32LE(p + 24), local: buf.readUInt32LE(p + 42) };
    const nameLen = buf.readUInt16LE(p + 28); const extraLen = buf.readUInt16LE(p + 30); const commentLen = buf.readUInt16LE(p + 32);
    e.name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (flags & 1) throw new WordError('This Word file is password-protected.');
    if (e.csize === 0xffffffff || e.usize === 0xffffffff || e.local === 0xffffffff) throw new WordError('This file uses a zip format Lumen does not edit.');
    if (e.name.includes('..') || e.name.startsWith('/') || e.name.includes('\\')) throw damaged();
    const at = e.local;
    if (at + 30 > buf.length || buf.readUInt32LE(at) !== 0x04034b50) throw damaged();
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    if (start + e.csize > buf.length) throw damaged();
    e.bytes = buf.subarray(start, start + e.csize);
    entries.push(e);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// entries: [{ name, data: Buffer }] (to be deflated) or an entry from centralEntries (copied as it is).
function buildZip(entries) {
  const locals = []; const centrals = [];
  let offset = 0;
  const dos = (() => { const d = new Date(); return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() }; })();
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    let method; let crc; let csize; let usize; let body; let time; let date;
    if (e.data) {
      const raw = e.data; body = zlib.deflateRawSync(raw, { level: 6 }); method = 8; crc = crc32(raw); csize = body.length; usize = raw.length; time = dos.time; date = dos.date;
    } else { body = e.bytes; method = e.method; crc = e.crc; csize = e.csize; usize = e.usize; time = e.time; date = e.date; }
    const flags = 0x0800; // names are UTF-8; no data descriptor
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8); lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(csize, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10); ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(csize, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body); centrals.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---- writing document.xml
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cleanText = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
const unesc = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function runs(text, { bold = false, italic = false, size = 0 } = {}) {
  const props = `${bold ? '<w:b/>' : ''}${italic ? '<w:i/>' : ''}${size ? `<w:sz w:val="${size}"/>` : ''}`;
  const parts = cleanText(text).split('\t');
  return parts.map((t, i) => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${i ? '<w:tab/>' : ''}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`).join('');
}

function makeIds(xml) {
  let n = 1000;
  for (const m of xml.matchAll(/w:id="(\d+)"/g)) n = Math.max(n, Number(m[1]));
  return () => ++n;
}

// A new paragraph: id is its style's id in styles.xml ('' for Normal); list { numId, level } makes it a list item.
function paragraphXml(text, id, ctx, { list = null, bold = false, italic = false } = {}) {
  let ppr = id && id !== 'Normal' ? `<w:pStyle w:val="${esc(id)}"/>` : '';
  if (list) ppr += `<w:numPr><w:ilvl w:val="${list.level - 1}"/><w:numId w:val="${list.numId}"/></w:numPr>`;
  if (ctx.track) ppr += `<w:rPr><w:ins w:id="${ctx.nextId()}" w:author="${AUTHOR}" w:date="${ctx.date}"/></w:rPr>`;
  const body = runs(text, { bold, italic });
  return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${ctx.track ? `<w:ins w:id="${ctx.nextId()}" w:author="${AUTHOR}" w:date="${ctx.date}">${body}</w:ins>` : body}</w:p>`;
}

const BORDER_SIDES = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'];
const bordersXml = (kind) => `<w:tblBorders>${BORDER_SIDES.map((n) => (kind === 'all' || (kind === 'outside' && !n.startsWith('inside')) ? `<w:${n} w:val="single" w:sz="4" w:space="0" w:color="808080"/>` : `<w:${n} w:val="nil"/>`)).join('')}</w:tblBorders>`;
const shdXml = (fill) => `<w:shd w:val="clear" w:color="auto" w:fill="${esc(fill)}"/>`;
const insMark = (ctx) => `<w:ins w:id="${ctx.nextId()}" w:author="${AUTHOR}" w:date="${ctx.date}"/>`;
// One cell's paragraph: text (tracked as an insertion when ctx.track), with run properties rpr (XML) and paragraph properties ppr (XML, no rPr).
function cellPara(text, ctx, { rpr = '', ppr = '' } = {}) {
  const body = `<w:r>${rpr}${textRuns(String(text))}</w:r>`;
  if (!ctx.track) return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${text === '' ? '' : body}</w:p>`;
  return `<w:p><w:pPr>${ppr}<w:rPr>${insMark(ctx)}</w:rPr></w:pPr>${text === '' ? '' : `<w:ins w:id="${ctx.nextId()}" w:author="${AUTHOR}" w:date="${ctx.date}">${body}</w:ins>`}</w:p>`;
}
// A new table: rows of cell texts, with its look { header (default: more than one row), widths (inches), borders, shading (the header's fill), align }.
function tableXml(rows, ctx, look = {}) {
  const cols = rows[0].length;
  const ws = look.widths ? look.widths.map((x) => Math.round(x * 1440)) : Array(cols).fill(Math.max(900, Math.floor(9000 / cols)));
  const header = look.header ?? rows.length > 1;
  const trs = rows.map((row, ri) => {
    const head = header && ri === 0;
    const tcs = row.map((cell, ci) => `<w:tc><w:tcPr><w:tcW w:w="${ws[ci]}" w:type="dxa"/>${head && look.shading ? shdXml(look.shading) : ''}</w:tcPr>${cellPara(cell, ctx, { rpr: head ? '<w:rPr><w:b/></w:rPr>' : '' })}</w:tc>`).join('');
    const trPr = `${head ? '<w:tblHeader/>' : ''}${ctx.track ? insMark(ctx) : ''}`;
    return `<w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ''}${tcs}</w:tr>`;
  }).join('');
  const tblPr = `<w:tblW w:w="0" w:type="auto"/>${look.align ? `<w:jc w:val="${look.align}"/>` : ''}${bordersXml(look.borders || 'all')}${look.widths ? '<w:tblLayout w:type="fixed"/>' : ''}`;
  return `<w:tbl><w:tblPr>${tblPr}</w:tblPr><w:tblGrid>${ws.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${trs}</w:tbl><w:p/>`;
}

// ---- a table that is there: cells, rows, a column and its look, on the table's own XML (t: the clean fields). -> { xml, done }
const TBL_ORDER = ['w:tblStyle', 'w:tblpPr', 'w:tblOverlap', 'w:bidiVisual', 'w:tblStyleRowBandSize', 'w:tblStyleColBandSize', 'w:tblW', 'w:jc', 'w:tblCellSpacing', 'w:tblInd', 'w:tblBorders', 'w:shd', 'w:tblLayout', 'w:tblCellMar', 'w:tblLook', 'w:tblCaption', 'w:tblDescription', 'w:tblPrChange'];
const TR_ORDER = ['w:cnfStyle', 'w:divId', 'w:gridBefore', 'w:gridAfter', 'w:wBefore', 'w:wAfter', 'w:cantSplit', 'w:trHeight', 'w:tblHeader', 'w:tblCellSpacing', 'w:jc', 'w:hidden', 'w:ins', 'w:del', 'w:trPrChange'];
const TC_ORDER = ['w:cnfStyle', 'w:tcW', 'w:gridSpan', 'w:hMerge', 'w:vMerge', 'w:tcBorders', 'w:shd', 'w:noWrap', 'w:tcMar', 'w:textDirection', 'w:tcFitText', 'w:vAlign', 'w:hideMark', 'w:headers', 'w:cellIns', 'w:cellDel', 'w:cellMerge', 'w:tcPrChange'];
const ROW_KIDS = ['w:tblPrEx', 'w:trPr', 'w:tc'];
const rowsOf = (s) => kidsOf(s, elementAt(s, 0)).filter((k) => k.name === 'w:tr');
const cellsOf = (s, tr) => kidsOf(s, tr).filter((k) => k.name === 'w:tc');
const delRuns = (s, ctx) => s.replace(/<w:r>|<w:r\s[^>]*>/g, (m) => `<w:del w:id="${ctx.nextId()}" w:author="${AUTHOR}" w:date="${ctx.date}">${m}`).replace(/<\/w:r>/g, '</w:r></w:del>')
  .replace(/<w:t(\s[^>]*)?>/g, '<w:delText$1>').replace(/<\/w:t>/g, '</w:delText>');
// The text of a cell, replaced: the old text goes (a tracked deletion when tracking), the new one comes in its first paragraph's look; a line
// break in it is a new paragraph in the cell.
function setCell(s, tc, text, ctx) {
  const ps = kidsOf(s, tc).filter((k) => k.name === 'w:p');
  if (!ps.length) throw new WordError('A cell of this table has an unusual structure Lumen will not edit. Open it in Word instead.');
  const first = s.slice(ps[0].start, ps[0].end);
  const pprEl = kidOf(first, elementAt(first, 0), 'w:pPr');
  const ppr = pprEl ? first.slice(pprEl.start, pprEl.end).replace(/^<w:pPr>|<\/w:pPr>$/g, '').replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, '') : '';
  const run = runsIn(first, elementAt(first, 0))[0];
  const rprEl = run ? kidOf(first, run, 'w:rPr') : null;
  const rpr = rprEl ? first.slice(rprEl.start, rprEl.end).replace(/<w:(ins|del)\b[^>]*\/>/g, '') : '';
  const lines = String(text).split(/\r\n|\r|\n/);
  const fresh = lines.map((l) => cellPara(l, ctx, { rpr, ppr })).join('');
  if (!ctx.track) return splice(s, ps[0].start, ps[ps.length - 1].end, fresh);
  let old = s.slice(ps[0].start, ps[ps.length - 1].end);
  const local = kidsIn(old, 0, old.length).filter((k) => k.name === 'w:p');
  for (const p of local.slice(0, -1).reverse()) old = removePara(old, p, ctx);
  // the last paragraph keeps its mark: its old runs marked deleted, the first new line inserted in it, the other lines as paragraphs after it
  const last = kidsIn(old, 0, old.length).filter((k) => k.name === 'w:p').pop();
  const kept = delRuns(old.slice(last.start, last.end), ctx);
  const line = lines[0] === '' ? '' : `<w:ins w:id="${ctx.nextId()}" w:author="${AUTHOR}" w:date="${ctx.date}"><w:r>${rpr}${textRuns(lines[0])}</w:r></w:ins>`;
  const withLine = kept.endsWith('/>') ? kept.replace(/\s*\/>$/, `>${line}</w:p>`) : kept.replace(/<\/w:p>$/, `${line}</w:p>`);
  old = splice(old, last.start, last.end, withLine);
  return splice(s, ps[0].start, ps[ps.length - 1].end, old + lines.slice(1).map((l) => cellPara(l, ctx, { rpr, ppr })).join(''));
}
// A row's cells on the table's grid: [{ tc, g (first grid column, 0-based), span, vm ('restart' | 'continue' | null) }].
function gridOf(s, tr) {
  let g = 0;
  return cellsOf(s, tr).map((tc) => {
    const pr = kidOf(s, tc, 'w:tcPr');
    const prx = pr ? s.slice(pr.start, pr.end) : '';
    const span = Number((/<w:gridSpan w:val="(\d+)"/.exec(prx) || [])[1] || 1);
    const vmTag = /<w:vMerge\b[^>]*\/?>/.exec(prx)?.[0];
    const vm = vmTag ? (/w:val="restart"/.test(vmTag) ? 'restart' : 'continue') : null;
    const cell = { tc, g, span, vm };
    g += span;
    return cell;
  });
}
const cellText = (s, tc) => unesc([...s.slice(tc.start, tc.end).matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')).replace(/\s+/g, ' ').trim();
// A cell merged down from the row above (vMerge continue) whose row above has no merged cell there any more starts the merge itself.
function mendMerges(s) {
  for (let i = 0; i < rowsOf(s).length; i++) {
    const rows = rowsOf(s);
    const above = i ? new Set(gridOf(s, rows[i - 1]).filter((c) => c.vm).map((c) => c.g)) : new Set();
    for (const c of gridOf(s, rows[i]).reverse()) {
      if (c.vm !== 'continue' || above.has(c.g)) continue;
      const pr = kidOf(s, c.tc, 'w:tcPr');
      const vmEl = kidOf(s, pr, 'w:vMerge');
      s = splice(s, vmEl.start, vmEl.end, '<w:vMerge w:val="restart"/>');
    }
  }
  return s;
}
// What delete_rows / delete_columns would take out of a table (its XML), as lines for the card, after the checks: -> { lines, count }
function deletionOf(s, t) {
  const rows = rowsOf(s);
  if (t.deleteRows) {
    const [a, b] = t.deleteRows;
    if (b > rows.length) throw new WordError(`The table has ${rows.length} row${rows.length === 1 ? '' : 's'}, so there is no row ${b}. Nothing was changed.`);
    if (b - a + 1 >= rows.length) throw new WordError('That is every row of the table, so nothing was deleted. To take the table out, remove the whole table instead (in Word: select it, then Layout > Delete > Delete Table); a table keeps at least one row here.');
    return { count: b - a + 1, lines: rows.slice(a - 1, b).map((tr, i) => `Row ${a + i}: | ${cellsOf(s, tr).map((tc) => cellText(s, tc)).join(' | ')} |`) };
  }
  const grid = kidOf(s, elementAt(s, 0), 'w:tblGrid');
  const cols = grid ? kidsOf(s, grid).filter((k) => k.name === 'w:gridCol').length : Math.max(...rows.map((tr) => gridOf(s, tr).reduce((n, c) => n + c.span, 0)));
  const [a, b] = t.deleteColumns;
  if (b > cols) throw new WordError(`The table has ${cols} column${cols === 1 ? '' : 's'}, so there is no column ${b}. Nothing was changed.`);
  if (b - a + 1 >= cols) throw new WordError('That is every column of the table, so nothing was deleted. To take the table out, remove the whole table instead (in Word: select it, then Layout > Delete > Delete Table); a table keeps at least one column here.');
  if (/<w:gridBefore\b|<w:gridAfter\b|<w:hMerge\b/.test(s)) throw new WordError('This table has rows that start or end off its grid, so its columns are not deleted here. Use Word for it.');
  const lines = [];
  for (let c = a; c <= b; c++) lines.push(`Column ${c}: ${rows.map((tr) => gridOf(s, tr).find((x) => x.g <= c - 1 && c - 1 < x.g + x.span)).filter(Boolean).map((x) => cellText(s, x.tc) || '(empty)').join(' · ')}`);
  return { count: b - a + 1, lines };
}
function deleteRows(s, [a, b]) {
  for (const tr of rowsOf(s).slice(a - 1, b).reverse()) s = splice(s, tr.start, tr.end, '');
  return mendMerges(s);
}
// Grid columns a..b (1-based) out: a cell inside them goes, a merged cell across them gets narrower (gridSpan, and its width), the grid loses them.
function deleteColumns(s, [a, b]) {
  const grid = kidOf(s, elementAt(s, 0), 'w:tblGrid');
  const gridCols = grid ? kidsOf(s, grid).filter((k) => k.name === 'w:gridCol') : [];
  const widths = gridCols.map((k) => Number((/w:w="(\d+)"/.exec(s.slice(k.start, k.end)) || [])[1] || 0));
  const from = a - 1; const to = b;
  for (const tr of [...rowsOf(s)].reverse()) {
    for (const c of gridOf(s, tr).reverse()) {
      const lo = Math.max(c.g, from); const hi = Math.min(c.g + c.span, to);
      const over = Math.max(0, hi - lo);
      if (!over) continue;
      if (over === c.span) { s = splice(s, c.tc.start, c.tc.end, ''); continue; }
      const span = c.span - over;
      const lost = widths.slice(lo, hi).reduce((x, y) => x + y, 0);
      let pr; [s, pr] = upsert(s, c.tc, 'w:tcPr', (had) => had || '<w:tcPr></w:tcPr>', ['w:tcPr']);
      const gs = kidOf(s, pr, 'w:gridSpan');
      if (span === 1 && gs) s = splice(s, gs.start, gs.end, '');
      else if (gs) s = splice(s, gs.start, gs.end, `<w:gridSpan w:val="${span}"/>`);
      const pr2 = kidOf(s, elementAt(s, c.tc.start), 'w:tcPr');
      const w = kidOf(s, pr2, 'w:tcW');
      if (w && lost && /w:type="dxa"/.test(s.slice(w.start, w.end))) { const cur = Number((/w:w="(\d+)"/.exec(s.slice(w.start, w.end)) || [])[1] || 0); s = splice(s, w.start, w.end, `<w:tcW w:w="${Math.max(0, cur - lost)}" w:type="dxa"/>`); }
    }
  }
  const g2 = kidOf(s, elementAt(s, 0), 'w:tblGrid');
  if (g2) for (const k of kidsOf(s, g2).filter((x) => x.name === 'w:gridCol').slice(from, to).reverse()) s = splice(s, k.start, k.end, '');
  return s;
}

function editTable(s, t, ctx) {
  const done = {};
  if (t.deleteRows || t.deleteColumns) {
    const d = deletionOf(s, t);
    if (t.deleteRows) { s = deleteRows(s, t.deleteRows); done.deletedRows = d.count; } else { s = deleteColumns(s, t.deleteColumns); done.deletedColumns = d.count; }
    done.deleted = d.lines;
  }
  const merged = /<w:gridSpan\b|<w:vMerge\b|<w:hMerge\b/.test(s);
  if (merged && (t.addColumn !== undefined || t.widths)) throw new WordError('This table has merged cells, so its columns are not changed here. Open it in Word, or change cells and rows instead.');
  if (t.addRows !== undefined) {
    const rows = rowsOf(s);
    const header = /<w:tblHeader(?:\s+w:val="(?:1|true|on)")?\s*\/>/.test(s.slice(rows[0].start, rows[0].end));
    const tpl = rows[Math.min(rows.length - 1, Math.max(header ? 1 : 0, t.addRows < 0 ? rows.length - 1 : t.addRows - 1))];
    const tcs = cellsOf(s, tpl).map((tc) => { const pr = kidOf(s, tc, 'w:tcPr'); return pr ? s.slice(pr.start, pr.end).replace(/<w:(shd|vMerge|cellIns|cellDel)\b[^>]*\/>/g, '') : ''; });
    if (t.rows.some((r) => r.length > tcs.length)) throw new WordError(`The table has ${tcs.length} columns, so a row of ${Math.max(...t.rows.map((r) => r.length))} cells does not fit. Nothing was changed.`);
    const piece = t.rows.map((row) => `<w:tr>${ctx.track ? `<w:trPr>${insMark(ctx)}</w:trPr>` : ''}${tcs.map((pr, i) => `<w:tc>${pr}${cellPara(row[i] ?? '', ctx)}</w:tc>`).join('')}</w:tr>`).join('');
    const at = t.addRows < 0 || t.addRows >= rows.length ? rows[rows.length - 1].end : t.addRows === 0 ? rows[0].start : rows[t.addRows].start;
    s = splice(s, at, at, piece);
    done.rows = t.rows.length;
  }
  if (t.addColumn !== undefined) {
    const rows = rowsOf(s);
    const n = cellsOf(s, rows[0]).length;
    const idx = t.addColumn < 0 || t.addColumn > n ? n : t.addColumn;
    for (const tr of [...rows].reverse()) {
      const tcs = cellsOf(s, tr);
      const near = tcs[Math.max(0, idx - 1)];
      const pr = kidOf(s, near, 'w:tcPr');
      const piece = `<w:tc>${pr ? s.slice(pr.start, pr.end).replace(/<w:(cellIns|cellDel)\b[^>]*\/>/g, '') : ''}${cellPara('', ctx)}</w:tc>`;
      const at = idx >= tcs.length ? tcs[tcs.length - 1].end : tcs[idx].start;
      s = splice(s, at, at, piece);
    }
    const grid = kidOf(s, elementAt(s, 0), 'w:tblGrid');
    if (grid) {
      const cols = kidsOf(s, grid).filter((k) => k.name === 'w:gridCol');
      const near = cols[Math.max(0, idx - 1)];
      if (near) { const at = idx >= cols.length ? cols[cols.length - 1].end : cols[idx].start; s = splice(s, at, at, s.slice(near.start, near.end)); }
    }
    done.column = idx + 1;
  }
  if (t.cells) {
    for (const [r, c, text] of [...t.cells].sort((a, b) => b[0] - a[0] || b[1] - a[1])) {
      const rows = rowsOf(s);
      if (r > rows.length) throw new WordError(`The table has ${rows.length} row${rows.length === 1 ? '' : 's'}, so there is no row ${r}. Nothing was changed.`);
      const cells = cellsOf(s, rows[r - 1]);
      if (c > cells.length) throw new WordError(`Row ${r} of the table has ${cells.length} cell${cells.length === 1 ? '' : 's'}, so there is no column ${c}. Nothing was changed.`);
      s = setCell(s, cells[c - 1], text, ctx);
    }
    done.cells = t.cells.length;
  }
  const tbl = () => elementAt(s, 0);
  const tblPr = () => upsert(s, tbl(), 'w:tblPr', (had) => had || '<w:tblPr></w:tblPr>', ['w:tblPr']);
  if (t.borders) { let pr; [s, pr] = tblPr(); [s] = upsert(s, pr, 'w:tblBorders', () => bordersXml(t.borders), TBL_ORDER); }
  if (t.align) { let pr; [s, pr] = tblPr(); [s] = upsert(s, pr, 'w:jc', () => `<w:jc w:val="${t.align}"/>`, TBL_ORDER); }
  if (t.widths) {
    const grid = kidOf(s, tbl(), 'w:tblGrid');
    const cols = grid ? kidsOf(s, grid).filter((k) => k.name === 'w:gridCol') : [];
    if (cols.length !== t.widths.length) throw new WordError(`widths has ${t.widths.length} columns but the table has ${cols.length}. Nothing was changed.`);
    const tw = t.widths.map((x) => Math.round(x * 1440));
    for (const [i, c] of [...cols.entries()].reverse()) s = splice(s, c.start, c.end, `<w:gridCol w:w="${tw[i]}"/>`);
    for (const tr of [...rowsOf(s)].reverse()) {
      for (const [i, tc] of [...cellsOf(s, tr).entries()].reverse()) {
        if (i >= tw.length) continue;
        let pr; [s, pr] = upsert(s, tc, 'w:tcPr', (had) => had || '<w:tcPr></w:tcPr>', ['w:tcPr']);
        [s] = upsert(s, pr, 'w:tcW', () => `<w:tcW w:w="${tw[i]}" w:type="dxa"/>`, TC_ORDER);
      }
    }
    let pr; [s, pr] = tblPr(); [s] = upsert(s, pr, 'w:tblLayout', () => '<w:tblLayout w:type="fixed"/>', TBL_ORDER);
  }
  if (t.header !== undefined || t.shading) {
    const tr = rowsOf(s)[0];
    if (t.shading) for (const tc of [...cellsOf(s, tr)].reverse()) { let pr; [s, pr] = upsert(s, tc, 'w:tcPr', (had) => had || '<w:tcPr></w:tcPr>', ['w:tcPr']); [s] = upsert(s, pr, 'w:shd', () => shdXml(t.shading), TC_ORDER); }
    if (t.header !== undefined) {
      const row = rowsOf(s)[0];
      let pr; [s, pr] = upsert(s, row, 'w:trPr', (had) => had || '<w:trPr></w:trPr>', ROW_KIDS);
      [s] = upsert(s, pr, 'w:tblHeader', () => onOff('w:tblHeader', t.header), TR_ORDER);
      for (const tc of [...cellsOf(s, rowsOf(s)[0])].reverse()) for (const p of kidsOf(s, tc).filter((k) => k.name === 'w:p').reverse()) for (const r of runsIn(s, p).reverse()) s = putRun(s, elementAt(s, r.start), { bold: t.header }, ['w:rPr']);
    }
  }
  done.look = ['header', 'widths', 'borders', 'shading', 'align'].filter((k) => t[k] !== undefined);
  return { xml: s, done };
}
const tableText = (xml, b) => [...xml.slice(b.start, b.end).matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => unesc(m[1])).join(' ');
// A table that is there (t.index, or t.find: text in one of its cells), changed -> { buf, done } (done.index: which table).
function pickTable(xml, t) {
  const tables = bodyOf(xml).blocks.filter((b) => b.name === 'tbl');
  if (!tables.length) throw new WordError('This document has no table. Add one with table and rows.');
  let i;
  if (t.index) { i = t.index - 1; if (!tables[i]) throw new WordError(`The document has ${tables.length} table${tables.length === 1 ? '' : 's'}, so there is no table ${t.index}.`); }
  else { const want = String(t.find).toLowerCase(); i = tables.findIndex((b) => tableText(xml, b).toLowerCase().includes(want)); if (i < 0) throw new WordError(`No table has a cell with “${String(t.find).slice(0, 60)}”. Use read to see the tables.`); }
  return { tables, i };
}
// What a delete_rows / delete_columns call would take out (for the card that asks first): -> { lines, count, index }
async function tableDeletion(buf, t) {
  const { xml } = await openForEdit(buf);
  const { tables, i } = pickTable(xml, t);
  return { ...deletionOf(xml.slice(tables[i].start, tables[i].end), t), index: i + 1 };
}
async function tableDocx(buf, t, { track = false, now = () => new Date() } = {}) {
  const { xml, entries } = await openForEdit(buf);
  const { tables, i } = pickTable(xml, t);
  const ctx = { track, nextId: makeIds(xml), date: now().toISOString().replace(/\.\d+Z$/, 'Z') };
  const r = editTable(xml.slice(tables[i].start, tables[i].end), t, ctx);
  return { buf: pack(entries, new Map([['word/document.xml', splice(xml, tables[i].start, tables[i].end, r.xml)]])), done: { ...r.done, index: i + 1, tables: tables.length }, tracked: track };
}

// The body's top-level blocks: [{ start, end, name }] as offsets in the XML, and where new content may go at the end.
function bodyOf(xml) {
  if (/<!(?!--)/.test(xml.replace(/^<\?xml[^>]*\?>/, '')) || /<!DOCTYPE/i.test(xml)) throw new WordError('This document has an unusual structure Lumen will not edit. Open it in Word instead.');
  const open = /<w:body(\s[^>]*)?>/.exec(xml);
  const close = xml.lastIndexOf('</w:body>');
  if (!open || open[0].endsWith('/>') || close < 0) throw new WordError('This document has an unusual structure Lumen will not edit. Open it in Word instead.');
  const from = open.index + open[0].length;
  const re = /<(\/?)w:([A-Za-z0-9]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  re.lastIndex = from;
  const blocks = [];
  let depth = 0; let startAt = -1; let name = '';
  let m;
  while ((m = re.exec(xml)) && m.index < close) {
    const closing = m[1] === '/'; const self = m[4] === '/';
    if (!closing) {
      if (depth === 0) { startAt = m.index; name = m[2]; }
      if (self) { if (depth === 0) blocks.push({ start: startAt, end: m.index + m[0].length, name }); } else depth++;
    } else {
      depth--;
      if (depth === 0) blocks.push({ start: startAt, end: m.index + m[0].length, name });
      if (depth < 0) throw new WordError('This document has an unusual structure Lumen will not edit. Open it in Word instead.');
    }
  }
  if (depth !== 0) throw new WordError('This document has an unusual structure Lumen will not edit. Open it in Word instead.');
  const last = blocks[blocks.length - 1];
  const endPos = last && last.name === 'sectPr' ? last.start : close;
  return { blocks, from, endPos, close };
}

const textOfBlock = (xml, b) => cleanText([...xml.slice(b.start, b.end).matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const levelOfBlock = (xml, b) => { const m = /<w:pStyle w:val="(?:Heading|heading)(\d)"/.exec(xml.slice(b.start, b.end)) || (/<w:pStyle w:val="Title"/.test(xml.slice(b.start, b.end)) ? [0, '1'] : null); return m ? Number(m[1]) : 10; };

function position(xml, body, place) {
  const paras = body.blocks.filter((b) => b.name === 'p' || b.name === 'tbl');
  if (place.at === 'start') return paras.length ? paras[0].start : body.endPos;
  if (!place.at || place.at === 'end') { // (a last paragraph with nothing in it stays last, as Word keeps it)
    const tail = paras[paras.length - 1];
    return tail && tail.name === 'p' && !/<w:t[\s>]|<w:drawing|<w:pict|<w:br/.test(xml.slice(tail.start, tail.end)) && tail.end <= body.endPos ? tail.start : body.endPos;
  }
  const want = String(place.heading || '').trim().toLowerCase();
  const heads = paras.filter((b) => b.name === 'p');
  const text = (b) => textOfBlock(xml, b).trim().toLowerCase();
  const pool = place.at === 'section_end' ? heads.filter((b) => levelOfBlock(xml, b) <= 9) : heads;
  const hit = pool.find((b) => text(b) === want) || pool.find((b) => text(b).startsWith(want)) || pool.find((b) => want && text(b).includes(want));
  if (!hit) throw new WordError(`No heading or paragraph matches "${String(place.heading).slice(0, 60)}". Use read to see the headings.`);
  if (place.at === 'after') return hit.end;
  const level = levelOfBlock(xml, hit);
  const i = paras.indexOf(hit);
  for (let j = i + 1; j < paras.length; j++) if (paras[j].name === 'p' && levelOfBlock(xml, paras[j]) <= level) return paras[j].start;
  return body.endPos;
}

async function openForEdit(buf) {
  if (!Buffer.isBuffer(buf) || buf.length > MAX_DOCX_BYTES) throw new WordError('This Word file is too large to edit here.');
  let zip;
  try { zip = createZipReader(buf, { maxBytes: MAX_INFLATED, root: 'word/document.xml' }); } catch (err) {
    throw err instanceof PptxError && /password/.test(err.message) ? new WordError('This Word file is password-protected.') : damaged();
  }
  const xml = await zip.text('word/document.xml');
  if (!xml) throw damaged();
  return { xml, zip, entries: centralEntries(buf) };
}

// The package again: every entry as it was (still compressed) but the parts in `files` (name -> new text), which replace or join them.
function pack(entries, files) {
  const names = new Set(entries.map((e) => e.name));
  const out = entries.map((e) => (files.has(e.name) ? { name: e.name, data: Buffer.from(files.get(e.name), 'utf8') } : e));
  for (const [name, text] of files) if (!names.has(name)) out.push({ name, data: Buffer.from(text, 'utf8') });
  return buildZip(out);
}

// What the fallback does to an existing document: { insert: { at, heading, text, style, levels, bold, italic } } or { table: { at, heading, rows } },
// optionally tracked. A style is the document's own by name (a built-in one it lacks is added to styles.xml); a list style makes real list items
// (numbering.xml), each line at its level.
async function editDocx(buf, op, { track = false, now = () => new Date() } = {}) {
  const { xml, zip, entries } = await openForEdit(buf);
  const body = bodyOf(xml);
  const nextId = makeIds(xml);
  const ctx = { track, nextId, date: now().toISOString().replace(/\.\d+Z$/, 'Z') };
  const files = new Map();
  let piece; let summary;
  if (op.insert) {
    const lines = String(op.insert.text).split(/\r\n|\r|\n/);
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    const style = op.insert.style || 'Normal';
    let id = '';
    let numId = null;
    if (style !== 'Normal') {
      const sp = await partOf(zip, files, 'styles');
      const r = styleFor(sp.text, style);
      if (r.xml !== sp.text) files.set(sp.name, r.xml);
      id = r.id;
    }
    const kind = LIST_KIND[style];
    if (kind) {
      const np = await partOf(zip, files, 'numbering');
      const r = newList(np.text, kind);
      files.set(np.name, r.xml);
      numId = r.numId;
    }
    const levels = op.insert.levels || [];
    piece = lines.map((l, i) => paragraphXml(l, id, ctx, { list: numId ? { numId, level: levels[i] || 1 } : null, bold: op.insert.bold === true, italic: op.insert.italic === true })).join('');
    summary = { paragraphs: lines.length };
  } else if (op.table) {
    piece = tableXml(op.table.rows, ctx, op.table);
    summary = { rows: op.table.rows.length, columns: op.table.rows[0].length };
    if (op.table.caption !== undefined) {
      // a caption above the table, kept with it: "Table N: ..."
      const at0 = position(xml, body, op.table);
      const sp = await partOf(zip, files, 'styles');
      files.set(sp.name, ensureStyle(sp.text, 'Caption'));
      const n = seqBefore(xml, 'Table', at0) + 1;
      piece = captionXml('Table', n, op.table.caption, ctx, { keepNext: true, align: op.table.align }) + piece;
      summary.caption = n;
    }
  } else throw new WordError('That change needs Microsoft Word.');
  const at = position(xml, body, op.insert || op.table);
  let next = xml.slice(0, at) + piece + xml.slice(at);
  if (summary.caption) next = renumber(next, 'Table');
  files.set('word/document.xml', next);
  return { buf: pack(entries, files), ...summary, tracked: track };
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
function styleXml(id, name, extra = '') { return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>${extra}</w:style>`; }
// The styles a new document has, and the ones format adds to a document that lacks them (a heading for the table of contents to find).
const STYLE_DEFS = {
  Normal: '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>',
  Title: styleXml('Title', 'Title', '<w:pPr><w:keepNext/></w:pPr><w:rPr><w:sz w:val="52"/></w:rPr>'),
  Heading1: styleXml('Heading1', 'heading 1', '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="0"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr>'),
  Heading2: styleXml('Heading2', 'heading 2', '<w:pPr><w:keepNext/><w:spacing w:before="40" w:after="0"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr>'),
  Heading3: styleXml('Heading3', 'heading 3', '<w:pPr><w:keepNext/><w:spacing w:before="40" w:after="0"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr>'),
  Heading4: styleXml('Heading4', 'heading 4', '<w:pPr><w:keepNext/><w:spacing w:before="40" w:after="0"/><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:i/><w:sz w:val="22"/></w:rPr>'),
  Heading5: styleXml('Heading5', 'heading 5', '<w:pPr><w:keepNext/><w:spacing w:before="40" w:after="0"/><w:outlineLvl w:val="4"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr>'),
  Heading6: styleXml('Heading6', 'heading 6', '<w:pPr><w:keepNext/><w:spacing w:before="40" w:after="0"/><w:outlineLvl w:val="5"/></w:pPr><w:rPr><w:i/><w:sz w:val="22"/></w:rPr>'),
  Quote: styleXml('Quote', 'Quote', '<w:pPr><w:ind w:left="720" w:right="720"/></w:pPr><w:rPr><w:i/></w:rPr>'),
  ListBullet: styleXml('ListBullet', 'List Bullet'),
  ListNumber: styleXml('ListNumber', 'List Number'),
  FootnoteText: '<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>',
  EndnoteText: '<w:style w:type="paragraph" w:styleId="EndnoteText"><w:name w:val="endnote text"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>',
  FootnoteReference: '<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>',
  EndnoteReference: '<w:style w:type="character" w:styleId="EndnoteReference"><w:name w:val="endnote reference"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>',
  CommentText: '<w:style w:type="paragraph" w:styleId="CommentText"><w:name w:val="annotation text"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>',
  CommentReference: '<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>',
  Hyperlink: '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>',
  Header: '<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:style>',
  Footer: '<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:style>',
  Caption: '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="35"/><w:unhideWhenUsed/><w:qFormat/><w:pPr><w:spacing w:after="200" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="44546A"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>',
};
const LIST_KIND = { 'List Bullet': 'bullet', 'List Number': 'number' };

// ---- format: fonts and spacing through the styles (styles.xml), margins and orientation through each section (w:sectPr), page breaks,
// heading styles and a real table of contents field (with updateFields in settings.xml, so Word fills it in when the document opens).
// The XML is changed with small, order-aware edits: a child element goes where the schema puts it, so Word opens the file without a repair.
const TAG = /<(\/?)([A-Za-z][\w.-]*(?::[\w.-]+)?)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
// The depth-0 elements between from and to: [{ name, start, end }].
function kidsIn(xml, from, to) {
  const re = new RegExp(TAG.source, 'g');
  re.lastIndex = from;
  const out = [];
  let depth = 0; let s = -1; let name = ''; let m;
  while ((m = re.exec(xml)) && m.index < to) {
    if (m[1] !== '/') {
      if (depth === 0) { s = m.index; name = m[2]; }
      if (m[4] === '/') { if (depth === 0) out.push({ name, start: s, end: m.index + m[0].length }); } else depth++;
    } else {
      depth--;
      if (depth === 0) out.push({ name, start: s, end: m.index + m[0].length });
      if (depth < 0) break;
    }
  }
  return out;
}
const elementAt = (xml, at) => kidsIn(xml, at, xml.length)[0] || null;
// { from, to } of an element's inside (null when it is self-closing).
function innerOf(xml, el) {
  const re = new RegExp(TAG.source, 'g'); re.lastIndex = el.start;
  const m = re.exec(xml);
  if (!m || m[4] === '/') return null;
  return { from: el.start + m[0].length, to: xml.lastIndexOf('</', el.end - 1) };
}
const kidsOf = (xml, el) => { const r = innerOf(xml, el); return r ? kidsIn(xml, r.from, r.to) : []; };
const kidOf = (xml, el, name) => kidsOf(xml, el).find((k) => k.name === name) || null;
const splice = (xml, a, b, piece) => xml.slice(0, a) + piece + xml.slice(b);
// <w:x .../> -> <w:x ...></w:x>, so it can take children. Returns [xml, el].
function opened(xml, el) {
  if (innerOf(xml, el)) return [xml, el];
  const tag = xml.slice(el.start, el.end).replace(/\s*\/>$/, '>');
  const name = /^<([^\s/>]+)/.exec(tag)[1];
  const piece = `${tag}</${name}>`;
  return [splice(xml, el.start, el.end, piece), { name: el.name, start: el.start, end: el.start + piece.length }];
}
// The child `name` of el, made from make(existing XML or null), at its place in `order` (the schema's sequence; a one-name order is a
// paragraph's or run's own properties, which come first). Returns [xml, child].
function upsert(xml, el, name, make, order) {
  [xml, el] = opened(xml, el);
  const kids = kidsOf(xml, el);
  const had = kids.find((k) => k.name === name);
  const piece = make(had ? xml.slice(had.start, had.end) : null);
  if (had) return [splice(xml, had.start, had.end, piece), { name, start: had.start, end: had.start + piece.length }];
  const rank = order.indexOf(name);
  const next = order.length === 1 ? kids[0] : kids.find((k) => order.indexOf(k.name) > rank);
  const at = next ? next.start : innerOf(xml, el).to;
  return [splice(xml, at, at, piece), { name, start: at, end: at + piece.length }];
}
// An element's start tag with attributes set (a value of null removes it).
function withAttrs(elXml, attrs) {
  const m = /^<([^\s/>]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/.exec(elXml);
  let a = m[2];
  for (const [k, v] of Object.entries(attrs)) {
    a = a.replace(new RegExp(`\\s${k.replace(':', '\\:')}="[^"]*"`), '');
    if (v !== null && v !== undefined) a += ` ${k}="${esc(v)}"`;
  }
  return `<${m[1]}${a}${m[3]}>${elXml.slice(m[0].length)}`;
}
const P_ORDER = ['w:pStyle', 'w:keepNext', 'w:keepLines', 'w:pageBreakBefore', 'w:framePr', 'w:widowControl', 'w:numPr', 'w:suppressLineNumbers', 'w:pBdr', 'w:shd', 'w:tabs', 'w:suppressAutoHyphens', 'w:kinsoku', 'w:wordWrap', 'w:overflowPunct', 'w:topLinePunct', 'w:autoSpaceDE', 'w:autoSpaceDN', 'w:bidi', 'w:adjustRightInd', 'w:snapToGrid', 'w:spacing', 'w:ind', 'w:contextualSpacing', 'w:mirrorIndents', 'w:suppressOverlap', 'w:jc', 'w:textDirection', 'w:textAlignment', 'w:textboxTightWrap', 'w:outlineLvl', 'w:divId', 'w:cnfStyle', 'w:rPr', 'w:sectPr', 'w:pPrChange'];
const R_ORDER = ['w:rStyle', 'w:rFonts', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:caps', 'w:smallCaps', 'w:strike', 'w:dstrike', 'w:outline', 'w:shadow', 'w:emboss', 'w:imprint', 'w:noProof', 'w:snapToGrid', 'w:vanish', 'w:webHidden', 'w:color', 'w:spacing', 'w:w', 'w:kern', 'w:position', 'w:sz', 'w:szCs', 'w:highlight', 'w:u', 'w:effect', 'w:bdr', 'w:shd', 'w:fitText', 'w:vertAlign', 'w:rtl', 'w:cs', 'w:em', 'w:lang', 'w:eastAsianLayout', 'w:specVanish', 'w:oMath', 'w:ins', 'w:del', 'w:rPrChange'];
const STYLE_ORDER = ['w:name', 'w:aliases', 'w:basedOn', 'w:next', 'w:link', 'w:autoRedefine', 'w:hidden', 'w:uiPriority', 'w:semiHidden', 'w:unhideWhenUsed', 'w:qFormat', 'w:locked', 'w:personal', 'w:personalCompose', 'w:personalReply', 'w:rsid', 'w:pPr', 'w:rPr', 'w:tblPr', 'w:trPr', 'w:tcPr', 'w:tblStylePr'];
const SECT_ORDER = ['w:headerReference', 'w:footerReference', 'w:footnotePr', 'w:endnotePr', 'w:type', 'w:pgSz', 'w:pgMar', 'w:paperSrc', 'w:pgBorders', 'w:lnNumType', 'w:pgNumType', 'w:cols', 'w:formProt', 'w:vAlign', 'w:noEndnote', 'w:titlePg', 'w:textDirection', 'w:bidi', 'w:rtlGutter', 'w:docGrid', 'w:printerSettings', 'w:sectPrChange'];
const ROOT_STYLES_ORDER = ['w:docDefaults', 'w:latentStyles', 'w:style'];
const DEFAULTS_ORDER = ['w:rPrDefault', 'w:pPrDefault'];
// Where updateFields goes among settings.xml's children: before the first of these that is there.
const SETTINGS_AFTER = ['w:hdrShapeDefaults', 'w:footnotePr', 'w:endnotePr', 'w:compat', 'w:docVars', 'w:rsids', 'm:mathPr', 'w:attachedSchema', 'w:themeFontLang', 'w:clrSchemeMapping', 'w:doNotIncludeSubdocsInStats', 'w:doNotAutoCompressPictures', 'w:forceUpgrade', 'w:captions', 'w:readModeInkLockDown', 'w:smartTagType', 'sl:schemaLibrary', 'w:shapeDefaults', 'w:doNotEmbedSmartTags', 'w:decimalSymbol', 'w:listSeparator'];

const twips = (pt) => String(Math.round(pt * 20));
const rFontsXml = (font) => `<w:rFonts w:ascii="${esc(font)}" w:hAnsi="${esc(font)}" w:eastAsia="${esc(font)}" w:cs="${esc(font)}"/>`;
// The w:spacing attributes for { line, before, after } (line: a multiple of a line up to 5, else exact points).
function spacingAttrs(f) {
  const a = {};
  if (f.line !== undefined) Object.assign(a, f.line <= 5 ? { 'w:line': String(Math.round(f.line * 240)), 'w:lineRule': 'auto' } : { 'w:line': twips(f.line), 'w:lineRule': 'exact' });
  if (f.before !== undefined) Object.assign(a, { 'w:before': twips(f.before), 'w:beforeAutospacing': null });
  if (f.after !== undefined) Object.assign(a, { 'w:after': twips(f.after), 'w:afterAutospacing': null });
  return a;
}
const hasText = (f) => ['font', 'size', 'bold', 'italic', 'strike', 'underline', 'color', 'highlight'].some((k) => f[k] !== undefined);
const hasSpacing = (f) => f.line !== undefined || f.before !== undefined || f.after !== undefined;
const hasPara = (f) => hasSpacing(f) || f.align !== undefined || f.indent !== undefined || f.firstLine !== undefined || f.keepNext !== undefined;
const onOff = (name, v) => (v ? `<${name}/>` : `<${name} w:val="0"/>`);
// The run properties besides font and size: [field, element, its XML].
const RUN_PROPS = [
  ['bold', 'w:b', (v) => onOff('w:b', v)], ['italic', 'w:i', (v) => onOff('w:i', v)], ['strike', 'w:strike', (v) => onOff('w:strike', v)],
  ['color', 'w:color', (v) => `<w:color w:val="${esc(v)}"/>`], ['highlight', 'w:highlight', (v) => `<w:highlight w:val="${esc(v)}"/>`], ['underline', 'w:u', (v) => `<w:u w:val="${esc(v)}"/>`],
];
// Font, size, bold, italic, strike, color, highlight and underline into a rPr holder (a w:style, a run, or w:rPrDefault): [xml].
function putRun(xml, holder, f, order) {
  if (!hasText(f)) return xml;
  let rpr; [xml, rpr] = upsert(xml, holder, 'w:rPr', (had) => had || '<w:rPr></w:rPr>', order);
  const fresh = () => kidOf(xml, elementAt(xml, holder.start), 'w:rPr'); // (the holder grew: found again from where it starts)
  if (f.font !== undefined) [xml] = upsert(xml, rpr, 'w:rFonts', () => rFontsXml(f.font), R_ORDER);
  if (f.size !== undefined) {
    [xml] = upsert(xml, fresh(), 'w:sz', () => `<w:sz w:val="${Math.round(f.size * 2)}"/>`, R_ORDER);
    [xml] = upsert(xml, fresh(), 'w:szCs', () => `<w:szCs w:val="${Math.round(f.size * 2)}"/>`, R_ORDER);
  }
  for (const [k, name, make] of RUN_PROPS) if (f[k] !== undefined) [xml] = upsert(xml, fresh(), name, () => make(f[k]), R_ORDER);
  return xml;
}
const JC = { left: 'left', center: 'center', right: 'right', justify: 'both' };
function indAttrs(f) {
  const a = {};
  if (f.indent !== undefined) Object.assign(a, { 'w:left': String(Math.round(f.indent * 1440)), 'w:start': null });
  if (f.firstLine !== undefined) Object.assign(a, f.firstLine < 0 ? { 'w:hanging': String(Math.round(-f.firstLine * 1440)), 'w:firstLine': null } : { 'w:firstLine': String(Math.round(f.firstLine * 1440)), 'w:hanging': null });
  return a;
}
// Spacing, keep with next, indents and alignment into a pPr holder (a w:style, a paragraph, or w:pPrDefault): [xml].
function putPara(xml, holder, f, order) {
  if (!hasPara(f)) return xml;
  [xml] = upsert(xml, holder, 'w:pPr', (had) => had || '<w:pPr></w:pPr>', order);
  const fresh = () => kidOf(xml, elementAt(xml, holder.start), 'w:pPr');
  if (hasSpacing(f)) [xml] = upsert(xml, fresh(), 'w:spacing', (had) => withAttrs(had || '<w:spacing/>', spacingAttrs(f)), P_ORDER);
  if (f.keepNext !== undefined) [xml] = upsert(xml, fresh(), 'w:keepNext', () => onOff('w:keepNext', f.keepNext), P_ORDER);
  if (f.indent !== undefined || f.firstLine !== undefined) [xml] = upsert(xml, fresh(), 'w:ind', (had) => withAttrs(had || '<w:ind/>', indAttrs(f)), P_ORDER);
  if (f.align !== undefined) [xml] = upsert(xml, fresh(), 'w:jc', () => `<w:jc w:val="${JC[f.align]}"/>`, P_ORDER);
  return xml;
}

const STYLE_IDS = { Caption: 'Caption', Normal: 'Normal', Title: 'Title', 'Heading 1': 'Heading1', 'Heading 2': 'Heading2', 'Heading 3': 'Heading3', 'Heading 4': 'Heading4', 'Heading 5': 'Heading5', 'Heading 6': 'Heading6', Quote: 'Quote', 'List Bullet': 'ListBullet', 'List Number': 'ListNumber' };
const stylesRoot = (xml) => { const r = /<w:styles[\s>]/.exec(xml); if (!r) throw damaged(); return elementAt(xml, r.index); };
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function styleEl(xml, id) {
  const root = stylesRoot(xml);
  return kidsOf(xml, root).find((k) => k.name === 'w:style' && new RegExp(`\\sw:styleId="${reEsc(id)}"`).test(xml.slice(k.start, k.start + 300).split('>')[0])) || null;
}
// A style's id by its name, as Word shows it ("Heading 1" is w:name "heading 1", id Heading1; "Lab Caption" is whatever id the document gave it), or null.
function styleIdOf(xml, name) {
  const want = String(name || '').toLowerCase();
  if (!want) return null;
  for (const k of kidsOf(xml, stylesRoot(xml))) {
    if (k.name !== 'w:style') continue;
    const s = xml.slice(k.start, k.end);
    const id = (/\sw:styleId="([^"]*)"/.exec(s.split('>')[0]) || [])[1];
    const nm = (/<w:name w:val="([^"]*)"/.exec(s) || [])[1];
    if (id && ((nm && unesc(nm).toLowerCase() === want) || id.toLowerCase() === want.replace(/\s+/g, ''))) return id;
  }
  return null;
}
// The style named `name` in styles.xml: { xml, id, created }. A built-in one the document lacks is added; another one is made only with based_on
// (make), as a paragraph style; based_on on a style that is there changes what it is based on.
function styleFor(xml, name, { basedOn = null, make = false } = {}) {
  let baseId = null;
  if (basedOn) ({ xml, id: baseId } = styleFor(xml, basedOn));
  let id = styleIdOf(xml, name);
  let created = false;
  if (!id && STYLE_IDS[name]) { id = STYLE_IDS[name]; xml = ensureStyle(xml, id); }
  if (!id) {
    if (!make || !baseId) throw new WordError(`This document has no style named “${String(name).slice(0, 60)}”, so nothing was changed. To make one, use format with style "${String(name).slice(0, 60)}" and based_on (such as "Normal").`);
    const stem = String(name).replace(/[^A-Za-z0-9]/g, '') || 'Style';
    id = stem; for (let n = 2; styleEl(xml, id); n++) id = `${stem}${n}`;
    const r = innerOf(xml, stylesRoot(xml));
    xml = splice(xml, r.to, r.to, `<w:style w:type="paragraph" w:customStyle="1" w:styleId="${esc(id)}"><w:name w:val="${esc(name)}"/><w:basedOn w:val="${esc(baseId)}"/><w:next w:val="Normal"/><w:qFormat/></w:style>`);
    created = true;
  } else if (baseId && baseId !== id) [xml] = upsert(xml, styleEl(xml, id), 'w:basedOn', () => `<w:basedOn w:val="${esc(baseId)}"/>`, STYLE_ORDER);
  return { xml, id, created };
}
function ensureStyle(xml, id) {
  if (styleEl(xml, id)) return xml;
  const root = stylesRoot(xml);
  const r = innerOf(xml, root);
  return splice(xml, r.to, r.to, STYLE_DEFS[id] || styleXml(id, id));
}
// Font / size / spacing for a style, or (style null) the whole document: the defaults, Normal, and the font of every style that names one.
function formatStyles(xml, f, styleId) {
  if (styleId) {
    xml = ensureStyle(xml, styleId);
    xml = putPara(xml, styleEl(xml, styleId), f, STYLE_ORDER);
    return putRun(xml, styleEl(xml, styleId), f, STYLE_ORDER);
  }
  let root = stylesRoot(xml);
  let defs; [xml, defs] = upsert(xml, root, 'w:docDefaults', (had) => had || '<w:docDefaults></w:docDefaults>', ROOT_STYLES_ORDER);
  if (hasText(f)) {
    let rd; [xml, rd] = upsert(xml, defs, 'w:rPrDefault', (had) => had || '<w:rPrDefault></w:rPrDefault>', DEFAULTS_ORDER);
    xml = putRun(xml, rd, f, ['w:rPr']);
  }
  if (hasSpacing(f)) {
    root = stylesRoot(xml); defs = kidOf(xml, root, 'w:docDefaults');
    let pd; [xml, pd] = upsert(xml, defs, 'w:pPrDefault', (had) => had || '<w:pPrDefault></w:pPrDefault>', DEFAULTS_ORDER);
    xml = putPara(xml, pd, f, ['w:pPr']);
  }
  xml = ensureStyle(xml, 'Normal');
  xml = putPara(xml, styleEl(xml, 'Normal'), f, STYLE_ORDER);
  xml = putRun(xml, styleEl(xml, 'Normal'), f, STYLE_ORDER);
  if (f.font !== undefined) xml = xml.replace(/<w:rFonts\b[^>]*\/>/g, rFontsXml(f.font)); // (headings and other styles take the font too, as "select all" would)
  return xml;
}

const SPACE_LINE = /(<w:spacing\b[^>]*?)\s+w:line="[^"]*"([^>]*>)/g;
// The document's own direct formatting that would hide the style change ("select all and set the font" reaches it too): run fonts, and line
// spacing set on paragraphs, for a whole-document change; font, size and spacing set directly on the paragraphs that contain `find`.
function formatBody(xml, f, find) {
  if (!find) {
    if (f.font !== undefined) xml = xml.replace(/<w:rFonts\b[^>]*\/>/g, '');
    if (f.line !== undefined) xml = xml.replace(SPACE_LINE, '$1$2').replace(/(<w:spacing\b[^>]*?)\s+w:lineRule="[^"]*"([^>]*>)/g, '$1$2');
    return { xml, paragraphs: null };
  }
  const starts = findParas(xml, find);
  return { xml: formatTargets(xml, f, starts), paragraphs: starts.length };
}
// The starts of the body's paragraphs that contain `find` (without case), or a plain error.
function findParas(xml, find) {
  const want = String(find).toLowerCase();
  const starts = bodyOf(xml).blocks.filter((b) => b.name === 'p' && textOfBlock(xml, b).toLowerCase().includes(want)).map((b) => b.start);
  if (!starts.length) throw new WordError(`No paragraph contains “${String(find).slice(0, 60)}”. Use read to see the text.`);
  return starts;
}
// A paragraph's runs that hold its text, in order, through tracked insertions, links and the like (deleted text is left out).
function runsIn(xml, el) {
  const out = [];
  for (const k of kidsOf(xml, el)) {
    if (k.name === 'w:r') out.push(k);
    else if (['w:ins', 'w:hyperlink', 'w:smartTag', 'w:customXml', 'w:fldSimple', 'w:sdt', 'w:sdtContent', 'w:moveTo'].includes(k.name)) out.push(...runsIn(xml, k));
  }
  return out;
}
// Paragraph and run formatting (and list membership: numId, or null to take a paragraph out of a list) on the paragraphs starting at `starts`.
function formatTargets(xml, f, starts, list = undefined) {
  for (const s of [...starts].sort((a, b) => b - a)) {
    if (list !== undefined) xml = setList(xml, s, list, f.level || 1);
    if (hasPara(f)) xml = putPara(xml, elementAt(xml, s), f, ['w:pPr']);
    if (hasText(f)) for (const r of runsIn(xml, elementAt(xml, s)).reverse()) xml = putRun(xml, elementAt(xml, r.start), f, ['w:rPr']);
  }
  return xml;
}

// ---- lists: one abstract list per kind (bullets: • ◦ ▪; numbers: 1. a. i.), nine levels, in numbering.xml; each new list is a w:num of its own,
// so a numbered list starts at 1.
const LIST_NAME = { bullet: 'Lumen Bullet', number: 'Lumen Number' };
function lvlXml(kind, i) {
  const ind = `<w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr>`;
  if (kind === 'bullet') return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${['•', '◦', '▪'][i % 3]}"/><w:lvlJc w:val="left"/>${ind}</w:lvl>`;
  return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${['decimal', 'lowerLetter', 'lowerRoman'][i % 3]}"/><w:lvlText w:val="%${i + 1}."/><w:lvlJc w:val="left"/>${ind}</w:lvl>`;
}
// -> { xml, numId }
function newList(xml, kind) {
  const r = /<w:numbering[\s>]/.exec(xml);
  if (!r) throw damaged();
  const at = r.index;
  const kids = () => kidsOf(xml, elementAt(xml, at));
  const ids = (re) => [...xml.matchAll(re)].map((m) => Number(m[1]));
  let abs = kids().filter((k) => k.name === 'w:abstractNum').map((k) => xml.slice(k.start, k.end)).find((s) => s.includes(`<w:name w:val="${LIST_NAME[kind]}"/>`));
  let absId;
  if (abs) absId = Number(/w:abstractNumId="(\d+)"/.exec(abs)[1]);
  else {
    absId = Math.max(-1, ...ids(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"/g)) + 1;
    abs = `<w:abstractNum w:abstractNumId="${absId}"><w:multiLevelType w:val="hybridMultilevel"/><w:name w:val="${LIST_NAME[kind]}"/>${Array.from({ length: 9 }, (_, i) => lvlXml(kind, i)).join('')}</w:abstractNum>`;
    const next = kids().find((k) => k.name === 'w:num' || k.name === 'w:numIdMacAtCleanup');
    const pos = next ? next.start : innerOf(xml, elementAt(xml, at)).to;
    xml = splice(xml, pos, pos, abs);
  }
  const numId = Math.max(0, ...ids(/<w:num\b[^>]*w:numId="(\d+)"/g)) + 1;
  const num = `<w:num w:numId="${numId}"><w:abstractNumId w:val="${absId}"/>${kind === 'number' ? '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>' : ''}</w:num>`;
  const tail = kids().find((k) => k.name === 'w:numIdMacAtCleanup');
  const pos = tail ? tail.start : innerOf(xml, elementAt(xml, at)).to;
  return { xml: splice(xml, pos, pos, num), numId };
}
// The paragraph at `start` in list numId at level (1-9), or (numId null) out of any list, its list style too.
function setList(xml, start, numId, level) {
  let ppr; [xml, ppr] = upsert(xml, elementAt(xml, start), 'w:pPr', (had) => had || '<w:pPr></w:pPr>', ['w:pPr']);
  if (numId) return upsert(xml, ppr, 'w:numPr', () => `<w:numPr><w:ilvl w:val="${level - 1}"/><w:numId w:val="${numId}"/></w:numPr>`, P_ORDER)[0];
  const np = kidOf(xml, ppr, 'w:numPr');
  if (np) xml = splice(xml, np.start, np.end, '');
  const ps = kidOf(xml, kidOf(xml, elementAt(xml, start), 'w:pPr'), 'w:pStyle');
  if (ps && /w:val="List(Bullet|Number|Paragraph)\d*"/.test(xml.slice(ps.start, ps.end))) xml = splice(xml, ps.start, ps.end, '');
  return xml;
}

// ---- style (the file route of the style action): the exact text found, wherever it is (body, tables), gets character formatting, the runs split at
// its edges so nothing around it changes; a paragraph style goes on the paragraphs that hold it. Formatting is not a tracked change.
const textRuns = (t) => t.split('\t').map((x, i) => `${i ? '<w:tab/>' : ''}${x ? `<w:t xml:space="preserve">${esc(cleanText(x))}</w:t>` : ''}`).join('');
function runInfo(xml, r) {
  let text = ''; let plain = true;
  for (const c of kidsOf(xml, r)) {
    if (c.name === 'w:rPr') continue;
    if (c.name === 'w:t') { const inner = innerOf(xml, c); text += inner ? unesc(xml.slice(inner.from, inner.to)) : ''; } else if (c.name === 'w:tab') text += '\t';
    else plain = false;
  }
  return { text, plain };
}
// One paragraph's XML (s) -> { xml, count }.
function styleInPara(s, find, f, pid) {
  const rs = runsIn(s, elementAt(s, 0)).map((r) => ({ ...r, ...runInfo(s, r) }));
  let pos = 0;
  for (const r of rs) { r.from = pos; pos += r.text.length; r.to = pos; }
  const text = rs.map((r) => r.text).join('');
  const hits = [];
  for (let i = text.indexOf(find); find && i >= 0; i = text.indexOf(find, i + find.length)) hits.push([i, i + find.length]);
  if (!hits.length) return { xml: s, count: 0 };
  if (hasText(f)) {
    for (const r of [...rs].reverse()) {
      const over = hits.filter(([a, b]) => a < r.to && b > r.from);
      if (!over.length) continue;
      if (!r.plain || over.some(([a, b]) => a <= r.from && b >= r.to)) { s = putRun(s, elementAt(s, r.start), f, ['w:rPr']); continue; }
      const cuts = [...new Set([r.from, r.to, ...over.flat().filter((x) => x > r.from && x < r.to)])].sort((a, b) => a - b);
      const tag = /^<w:r(?:\s[^>]*)?>/.exec(s.slice(r.start, r.end))[0];
      const rprEl = kidOf(s, elementAt(s, r.start), 'w:rPr');
      const rpr = rprEl ? s.slice(rprEl.start, rprEl.end) : '';
      let pieces = '';
      for (let k = 0; k < cuts.length - 1; k++) {
        const [a, b] = [cuts[k], cuts[k + 1]];
        let one = `${tag}${rpr}${textRuns(r.text.slice(a - r.from, b - r.from))}</w:r>`;
        if (over.some(([x, y]) => x <= a && y >= b)) one = putRun(one, { name: 'w:r', start: 0, end: one.length }, f, ['w:rPr']);
        pieces += one;
      }
      s = splice(s, r.start, r.end, pieces);
    }
  }
  if (pid) {
    let ppr; [s, ppr] = upsert(s, elementAt(s, 0), 'w:pPr', (had) => had || '<w:pPr></w:pPr>', ['w:pPr']);
    [s] = upsert(s, ppr, 'w:pStyle', () => `<w:pStyle w:val="${esc(pid)}"/>`, P_ORDER);
  }
  return { xml: s, count: hits.length };
}
// Every paragraph in the body, tables included (the outer one of a paragraph inside a text box): [{ start, end }].
function allParas(xml) {
  const body = bodyOf(xml);
  const out = [];
  const re = /<w:p(?=[\s>/])/g; re.lastIndex = body.from;
  let m;
  while ((m = re.exec(xml)) && m.index < body.close) {
    if (out.length && m.index < out[out.length - 1].end) continue;
    out.push(elementAt(xml, m.index));
  }
  return out;
}
// op: { find, style, font, size, bold, italic, underline, color, highlight, strike } -> { buf, formatted }
async function styleDocx(buf, op) {
  const { xml: original, zip, entries } = await openForEdit(buf);
  const files = new Map();
  let pid = null;
  if (op.style) {
    const sp = await partOf(zip, files, 'styles');
    const r = styleFor(sp.text, op.style);
    if (r.xml !== sp.text) files.set(sp.name, r.xml);
    pid = r.id;
  }
  let xml = original;
  let count = 0;
  for (const p of allParas(xml).reverse()) {
    const r = styleInPara(xml.slice(p.start, p.end), String(op.find), op, pid);
    if (r.count) { xml = splice(xml, p.start, p.end, r.xml); count += r.count; }
  }
  if (!count) throw new WordError(`No match for “${String(op.find).slice(0, 60)}” (find is the exact text, with its case, inside one paragraph). Use read to see the text.`);
  const done = {};
  if (op.bookmark) {
    if (new RegExp(`<w:bookmarkStart\\b[^>]*w:name="${op.bookmark}"`, 'i').test(xml)) throw new WordError(`There is already a bookmark named ${op.bookmark}. Use another name.`);
    const id = makeIds(xml)();
    const p = allParas(xml).find((q) => matchesIn(xml.slice(q.start, q.end), String(op.find)).length);
    const one = xml.slice(p.start, p.end);
    const [a, b] = matchesIn(one, String(op.find))[0];
    const r = wrapText(one, a, b, `<w:bookmarkStart w:id="${id}" w:name="${op.bookmark}"/>`, `<w:bookmarkEnd w:id="${id}"/>`);
    xml = splice(xml, p.start, p.end, r);
    done.bookmark = op.bookmark;
  }
  if (op.link) {
    let open;
    if (op.link.startsWith('#')) open = `<w:hyperlink w:anchor="${esc(op.link.slice(1))}" w:history="1">`;
    else {
      const relsName = 'word/_rels/document.xml.rels';
      const rels = files.get(relsName) ?? (zip.has(relsName) ? await zip.text(relsName) : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
      const rid = `rId${Math.max(0, ...[...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]))) + 1}`;
      files.set(relsName, rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(op.link)}" TargetMode="External"/></Relationships>`));
      if (!/<w:document\b[^>]*\sxmlns:r=/.test(xml)) xml = xml.replace(/<w:document\b/, `<w:document xmlns:r="${R_NS}"`);
      open = `<w:hyperlink r:id="${rid}" w:history="1">`;
    }
    const sp = await partOf(zip, files, 'styles');
    files.set(sp.name, ensureStyle(files.get(sp.name) ?? sp.text, 'Hyperlink'));
    let links = 0;
    for (const p of allParas(xml).reverse()) {
      let one = xml.slice(p.start, p.end);
      const hits = matchesIn(one, String(op.find));
      if (!hits.length) continue;
      for (const [a, b] of hits.reverse()) { one = wrapText(one, a, b, open, '</w:hyperlink>', (x) => putRunStyle(x, 'Hyperlink')); links++; }
      xml = splice(xml, p.start, p.end, one);
    }
    done.links = links;
  }
  files.set('word/document.xml', xml);
  return { buf: pack(entries, files), formatted: count, ...done };
}

// ---- in the text: a boundary between runs at a character offset of a paragraph (the run there is split), and what goes there or around a span.
// The offsets are those of the paragraph's text as runsIn reads it.
function runsWithText(s) {
  const rs = runsIn(s, elementAt(s, 0)).map((r) => ({ ...r, ...runInfo(s, r) }));
  let pos = 0;
  for (const r of rs) { r.from = pos; pos += r.text.length; r.to = pos; }
  return rs;
}
// Every [start, end) where find is in paragraph s (with case).
function matchesIn(s, find) {
  const text = runsWithText(s).map((r) => r.text).join('');
  const out = [];
  for (let i = text.indexOf(find); find && i >= 0; i = text.indexOf(find, i + find.length)) out.push([i, i + find.length]);
  return out;
}
// s with a run boundary at offset (a plain run there split in two); a run that is not plain text (a field, a picture) is not split.
function cutAt(s, offset) {
  const r = runsWithText(s).find((x) => x.from < offset && offset < x.to);
  if (!r) return s;
  if (!r.plain) throw new WordError('That text runs through a field or a picture, so it is not changed here. Use Word for it.');
  const tag = /^<w:r(?:\s[^>]*)?>/.exec(s.slice(r.start, r.end))[0];
  const rprEl = kidOf(s, elementAt(s, r.start), 'w:rPr');
  const rpr = rprEl ? s.slice(rprEl.start, rprEl.end) : '';
  const k = offset - r.from;
  return splice(s, r.start, r.end, `${tag}${rpr}${textRuns(r.text.slice(0, k))}</w:r>${tag}${rpr}${textRuns(r.text.slice(k))}</w:r>`);
}
// Where a piece goes at a boundary (after cutAt): the end of the run that ends there, or the start of the first run (or after pPr).
function boundaryAt(s, offset) {
  const rs = runsWithText(s);
  const before = rs.filter((x) => x.to === offset && x.from < offset).pop();
  if (before) return before.end;
  const first = rs.find((x) => x.from >= offset && x.to > x.from);
  if (first) return first.start;
  const ppr = kidOf(s, elementAt(s, 0), 'w:pPr');
  return ppr ? ppr.end : innerOf(s, elementAt(s, 0)).from;
}
// Tags in s[a, b) close what they open (so a wrapper around them is valid XML).
function balanced(s, a, b) {
  const re = new RegExp(TAG.source, 'g'); re.lastIndex = a;
  let depth = 0; let m;
  while ((m = re.exec(s)) && m.index < b) { if (m[1] === '/') { if (--depth < 0) return false; } else if (m[4] !== '/') depth++; }
  return depth === 0;
}
// Paragraph s with open/close around its text [a, b) (each run in it first passed through each(), if given).
function wrapText(s, a, b, open, close, each = null) {
  s = cutAt(cutAt(s, b), a);
  const rs = runsWithText(s);
  const inside = rs.filter((x) => x.from >= a && x.to <= b && x.to > x.from);
  const start = inside[0]?.start ?? boundaryAt(s, a);
  const end = inside.length ? inside[inside.length - 1].end : start;
  if (!balanced(s, start, end)) throw new WordError('That text is partly inside a tracked change or a link, so it is not wrapped here. Use Word for it.');
  let mid = s.slice(start, end);
  if (each) mid = each(mid);
  return s.slice(0, start) + open + mid + close + s.slice(end);
}
// Every run in a piece of a paragraph gets a character style (rStyle, first in its rPr).
function putRunStyle(x, id) {
  const wrapper = `<w:p>${x}</w:p>`;
  let out = wrapper;
  for (const r of runsIn(out, elementAt(out, 0)).reverse()) {
    let rpr; [out, rpr] = upsert(out, elementAt(out, r.start), 'w:rPr', (had) => had || '<w:rPr></w:rPr>', ['w:rPr']);
    [out] = upsert(out, rpr, 'w:rStyle', () => `<w:rStyle w:val="${id}"/>`, R_ORDER);
  }
  return out.slice(5, -6);
}

// ---- review: the tracked changes accepted or rejected (all, one author's, or those in the paragraphs holding some text), as Word's Accept and
// Reject do: an insertion kept or taken out, a deletion taken out or put back, a formatting change kept or undone, a paragraph mark or a row
// inserted or deleted. -> { xml, count }
const PR_KEEP = { 'w:pPr': ['w:rPr', 'w:sectPr'], 'w:rPr': ['w:ins', 'w:del', 'w:moveFrom', 'w:moveTo'], 'w:trPr': ['w:ins', 'w:del'], 'w:tcPr': ['w:cellIns', 'w:cellDel'] };
const restoreText = (x) => x.replace(/<w:delText(\s[^>]*)?>/g, '<w:t$1>').replace(/<\/w:delText>/g, '</w:t>').replace(/<w:delInstrText(\s[^>]*)?>/g, '<w:instrText$1>').replace(/<\/w:delInstrText>/g, '</w:instrText>');
function reviewXml(xml, kind, { author = null, ranges = null } = {}) {
  const who = (tag) => !author || String((/w:author="([^"]*)"/.exec(tag) || [])[1] || '').toLowerCase() === author.toLowerCase();
  const inScope = (at) => !ranges || ranges.some(([a, b]) => at >= a && at < b);
  const accept = kind === 'accept';
  let count = 0;
  const starts = (re) => { const out = []; let m; re.lastIndex = 0; while ((m = re.exec(xml))) if (inScope(m.index)) out.push({ at: m.index, tag: m[0] }); return out.reverse(); };
  // 1. text: insertions and deletions (and moves) around runs
  for (const { at, tag } of starts(/<w:(ins|del|moveFrom|moveTo)\b(?:[^>"']|"[^"]*")*>/g)) {
    if (tag.endsWith('/>') || !who(tag)) continue;
    const el = elementAt(xml, at);
    const name = el.name.slice(2);
    const r = innerOf(xml, el);
    const inner = r ? xml.slice(r.from, r.to) : '';
    const keep = accept ? name === 'ins' || name === 'moveTo' : name === 'del' || name === 'moveFrom';
    xml = splice(xml, el.start, el.end, keep ? (name === 'del' || name === 'moveFrom' ? restoreText(inner) : inner) : '');
    count++;
  }
  xml = xml.replace(/<w:move(?:From|To)Range(?:Start|End)\b[^>]*\/>/g, '');
  // 2. formatting changes: kept (the record goes) or undone (the old properties come back, with what the record does not cover)
  for (const { at, tag } of starts(/<w:(rPr|pPr|sectPr|tblPr|trPr|tcPr|tblPrEx|tblGrid)Change\b(?:[^>"']|"[^"]*")*>/g)) {
    if (!who(tag)) continue;
    const el = elementAt(xml, at);
    if (accept) { xml = splice(xml, el.start, el.end, ''); count++; continue; }
    const base = `w:${el.name.slice(2, -6)}`;
    const pAt = Math.max(...[' ', '>', '/'].map((c) => xml.lastIndexOf(`<${base}${c}`, at)));
    if (pAt < 0) continue;
    const parent = elementAt(xml, pAt);
    const old = kidOf(xml, el, base);
    const oldInner = old && innerOf(xml, old) ? xml.slice(innerOf(xml, old).from, innerOf(xml, old).to) : '';
    const kept = kidsOf(xml, parent).filter((k) => (PR_KEEP[base] || []).includes(k.name)).map((k) => xml.slice(k.start, k.end)).join('');
    const open = /^<[^>]*?(?=\/?>)/.exec(xml.slice(parent.start, parent.end))[0];
    xml = splice(xml, parent.start, parent.end, `${open}>${oldInner}${kept}</${base}>`);
    count++;
  }
  // 3. rows inserted or deleted
  for (const { at } of starts(/<w:tr\b/g)) {
    const tr = elementAt(xml, at);
    const pr = kidOf(xml, tr, 'w:trPr');
    const mark = pr && kidsOf(xml, pr).find((k) => (k.name === 'w:ins' || k.name === 'w:del') && who(xml.slice(k.start, k.end)));
    if (!mark) continue;
    const gone = accept ? mark.name === 'w:del' : mark.name === 'w:ins';
    xml = gone ? splice(xml, tr.start, tr.end, '') : splice(xml, mark.start, mark.end, '');
    count++;
  }
  // 4. paragraph marks inserted or deleted: a mark that goes joins its paragraph to the next one (which keeps its own properties)
  for (const { at } of starts(/<w:p(?=[\s>/])/g)) {
    const p = elementAt(xml, at);
    if (!p || p.name !== 'w:p') continue;
    const ppr = kidOf(xml, p, 'w:pPr');
    const rpr = ppr && kidOf(xml, ppr, 'w:rPr');
    const mark = rpr && kidsOf(xml, rpr).find((k) => (k.name === 'w:ins' || k.name === 'w:del') && who(xml.slice(k.start, k.end)));
    if (!mark) continue;
    count++;
    const join = accept ? mark.name === 'w:del' : mark.name === 'w:ins';
    xml = splice(xml, mark.start, mark.end, '');
    if (!join) continue;
    const P = elementAt(xml, at);
    const N = elementAt(xml, P.end);
    if (!N || N.name !== 'w:p' || N.start !== P.end) continue;
    const pIn = innerOf(xml, P); const pPr = kidOf(xml, P, 'w:pPr');
    const body = pIn ? xml.slice(pPr ? pPr.end : pIn.from, pIn.to) : '';
    const nIn = innerOf(xml, N); const nPr = kidOf(xml, N, 'w:pPr');
    const head = nIn ? xml.slice(N.start, nPr ? nPr.end : nIn.from) : xml.slice(N.start, N.end).replace(/\s*\/>$/, '>');
    const rest = nIn ? xml.slice(nPr ? nPr.end : nIn.from, N.end) : '</w:p>';
    xml = splice(xml, P.start, N.end, head + body + rest);
  }
  return { xml: xml.replace(/<w:rPr><\/w:rPr>/g, '').replace(/<w:pPr><\/w:pPr>/g, ''), count };
}
// op: { review: accept|reject, author, find } -> { buf, count }
async function reviewDocx(buf, op) {
  const { xml: original, entries } = await openForEdit(buf);
  bodyOf(original);
  let ranges = null;
  if (op.find) {
    const want = String(op.find).toLowerCase();
    ranges = allParas(original).filter((p) => [...original.slice(p.start, p.end).matchAll(/<w:(?:t|delText)(?:\s[^>]*)?>([^<]*)<\/w:(?:t|delText)>/g)].map((m) => unesc(m[1])).join('').toLowerCase().includes(want)).map((p) => [p.start, p.end]);
    if (!ranges.length) throw new WordError(`No paragraph contains “${String(op.find).slice(0, 60)}”. Use read to see the text.`);
  }
  const r = reviewXml(original, op.review, { author: op.author, ranges });
  return { buf: r.count ? pack(entries, new Map([['word/document.xml', r.xml]])) : buf, count: r.count };
}

// ---- replace in the file: every match (inside one paragraph) is changed, its look kept (and any look asked for put on the new text); tracked,
// the old text is a deletion and the new one an insertion beside it. -> { buf, replaced }
async function replaceDocx(buf, op, { track = false, now = () => new Date() } = {}) {
  if (/[\r\n]/.test(op.find)) throw new WordError('A find that spans paragraphs needs Microsoft Word.');
  const { xml: original, entries } = await openForEdit(buf);
  bodyOf(original);
  const ctx = { track, nextId: makeIds(original), date: now().toISOString().replace(/\.\d+Z$/, 'Z') };
  const look = Object.fromEntries(['font', 'size', 'bold', 'italic', 'strike', 'underline', 'color', 'highlight'].filter((k) => op[k] !== undefined).map((k) => [k, op[k]]));
  let xml = original;
  let count = 0;
  const word = (c) => /[\p{L}\p{N}_]/u.test(c || '');
  for (const p of allParas(xml).reverse()) {
    let one = xml.slice(p.start, p.end);
    const text = runsWithText(one).map((r) => r.text).join('');
    const hits = matchesIn(one, String(op.find)).filter(([a, b]) => !op.wholeWord || (!word(text[a - 1]) && !word(text[b])));
    if (!hits.length) continue;
    for (const [a, b] of hits.reverse()) {
      one = cutAt(cutAt(one, b), a);
      const inside = runsWithText(one).filter((x) => x.from >= a && x.to <= b && x.to > x.from);
      if (!inside.length) continue;
      const start = inside[0].start; const end = inside[inside.length - 1].end;
      if (!balanced(one, start, end)) throw new WordError(`“${String(op.find).slice(0, 40)}” is partly inside a tracked change or a link here, so the file route does not replace it. Use Word for it.`);
      const rprEl = kidOf(one, elementAt(one, start), 'w:rPr');
      let run = op.replace === '' ? '' : `<w:r>${rprEl ? one.slice(rprEl.start, rprEl.end).replace(/<w:(ins|del)\b[^>]*\/>/g, '') : ''}${textRuns(String(op.replace))}</w:r>`;
      if (run && Object.keys(look).length) run = putRun(run, { name: 'w:r', start: 0, end: run.length }, look, ['w:rPr']);
      const piece = track ? `${delRuns(one.slice(start, end), ctx)}${run ? `<w:ins w:id="${ctx.nextId()}" w:author="${AUTHOR}" w:date="${ctx.date}">${run}</w:ins>` : ''}` : run;
      one = one.slice(0, start) + piece + one.slice(end);
      count++;
    }
    xml = splice(xml, p.start, p.end, one);
  }
  return { buf: count ? pack(entries, new Map([['word/document.xml', xml]])) : buf, replaced: count, tracked: track };
}

// ---- comments in the file: the found text marked (commentRangeStart / End and a reference run), the comment in comments.xml, by the AI.
async function commentDocx(buf, op, { now = () => new Date() } = {}) {
  const { xml: original, zip, entries } = await openForEdit(buf);
  bodyOf(original);
  const files = new Map();
  const find = String(op.find);
  const p = allParas(original).find((q) => matchesIn(original.slice(q.start, q.end), find).length);
  if (!p) throw new WordError(`No match for “${find.slice(0, 60)}” (find is the exact text, with its case, inside one paragraph), so there is nothing to comment on.`);
  const cp = await partOf(zip, files, 'comments');
  const id = Math.max(-1, ...[...cp.text.matchAll(/<w:comment\b[^>]*w:id="(\d+)"/g)].map((m) => Number(m[1]))) + 1;
  const date = now().toISOString().replace(/\.\d+Z$/, 'Z');
  const paras2 = String(op.text).split(/\r\n|\r|\n/).map((l, i) => `<w:p><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>${i ? '' : '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>'}<w:r>${textRuns(l)}</w:r></w:p>`).join('');
  files.set(cp.name, cp.text.replace(/<\/w:comments>\s*$/, `<w:comment w:id="${id}" w:author="${AUTHOR}" w:date="${date}" w:initials="AI">${paras2}</w:comment></w:comments>`));
  const sp = await partOf(zip, files, 'styles');
  files.set(sp.name, ensureStyle(ensureStyle(files.get(sp.name) ?? sp.text, 'CommentText'), 'CommentReference'));
  const one = original.slice(p.start, p.end);
  const [a, b] = matchesIn(one, find)[0];
  const marked = wrapText(one, a, b, `<w:commentRangeStart w:id="${id}"/>`, `<w:commentRangeEnd w:id="${id}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`);
  files.set('word/document.xml', splice(original, p.start, p.end, marked));
  return { buf: pack(entries, files), id };
}

// ---- tracking on or off in the file (w:trackRevisions in settings.xml): Word marks the next edits as revisions.
async function trackDocx(buf, on) {
  const { zip, entries } = await openForEdit(buf);
  const files = new Map();
  const st = await partOf(zip, files, 'settings');
  let x = st.text.replace(/<w:trackRevisions\b[^>]*\/>/g, '');
  if (on) {
    // (after the settings that come before it in the schema, so Word reads the file without a repair)
    const BEFORE = ['w:writeProtection', 'w:view', 'w:zoom', 'w:removePersonalInformation', 'w:removeDateAndTime', 'w:doNotDisplayPageBoundaries', 'w:displayBackgroundShape', 'w:printPostScriptOverText', 'w:printFractionalCharacterWidth', 'w:printFormsData', 'w:embedTrueTypeFonts', 'w:embedSystemFonts', 'w:saveSubsetFonts', 'w:saveFormsData', 'w:mirrorMargins', 'w:alignBordersAndEdges', 'w:bordersDoNotSurroundHeader', 'w:bordersDoNotSurroundFooter', 'w:gutterAtTop', 'w:hideSpellingErrors', 'w:hideGrammaticalErrors', 'w:activeWritingStyle', 'w:proofState', 'w:formsDesign', 'w:attachedTemplate', 'w:linkStyles', 'w:stylePaneFormatFilter', 'w:stylePaneSortMethod', 'w:documentType', 'w:mailMerge', 'w:revisionView'];
    const root = elementAt(x, /<w:settings[\s>]/.exec(x).index);
    const prev = kidsOf(x, root).filter((k) => BEFORE.includes(k.name)).pop();
    const at = prev ? prev.end : innerOf(x, root).from;
    x = splice(x, at, at, '<w:trackRevisions/>');
  }
  files.set(st.name, x);
  return { buf: pack(entries, files), tracking: on };
}

// ---- notes and cross-references (the insert action with find): text, a footnote or endnote (its mark here, its text in footnotes.xml or
// endnotes.xml), or a REF field to a caption ("Figure 2": a _Ref bookmark around the caption's label and number, as Word's Insert
// Cross-reference makes) or to a bookmark.
const NOTE = { footnote: { part: 'footnotes', el: 'w:footnote', ref: 'w:footnoteReference', mark: 'w:footnoteRef', text: 'FootnoteText', style: 'FootnoteReference' }, endnote: { part: 'endnotes', el: 'w:endnote', ref: 'w:endnoteReference', mark: 'w:endnoteRef', text: 'EndnoteText', style: 'EndnoteReference' } };
// The caption paragraph that shows "<label> <n>" (its SEQ field's number): [start, end] in xml, or null.
function captionPara(xml, label, n) {
  for (const p of allParas(xml)) {
    const one = xml.slice(p.start, p.end);
    for (const m of one.matchAll(seqRe(label))) if (Number(m[2] || m[5]) === n) return p;
  }
  return null;
}
// The bookmark Word's cross-references use around a caption's label and number: found, or made (to the end of its SEQ field). -> [xml, name]
function captionBookmark(xml, p, ctx) {
  let one = xml.slice(p.start, p.end);
  const had = /<w:bookmarkStart\b[^>]*w:name="(_Ref[^"]*)"/.exec(one);
  if (had) return [xml, had[1]];
  const name = `_Ref${String(ctx.nextId()).padStart(9, '0')}`;
  const id = ctx.nextId();
  const endField = (() => { const i = one.search(/SEQ /); const e = one.indexOf('<w:fldChar w:fldCharType="end"/></w:r>', i); if (e >= 0) return e + '<w:fldChar w:fldCharType="end"/></w:r>'.length; const f2 = one.indexOf('</w:fldSimple>', i); return f2 >= 0 ? f2 + '</w:fldSimple>'.length : -1; })();
  if (endField < 0) throw new WordError('That caption has no number field Lumen can point at. Use Word for this cross-reference.');
  one = one.slice(0, endField) + `<w:bookmarkEnd w:id="${id}"/>` + one.slice(endField);
  const at = boundaryAt(one, 0);
  one = one.slice(0, at) + `<w:bookmarkStart w:id="${id}" w:name="${name}"/>` + one.slice(at);
  return [splice(xml, p.start, p.end, one), name];
}
// op: { find, text, note, ref } -> { buf, done: { note, ref } }
async function insertDocx(buf, op, { track = false, now = () => new Date() } = {}) {
  const { xml: original, zip, entries } = await openForEdit(buf);
  bodyOf(original);
  const ctx = { track, nextId: makeIds(original), date: now().toISOString().replace(/\.\d+Z$/, 'Z') };
  const files = new Map();
  let xml = original;
  const find = String(op.find);
  if (!allParas(xml).some((q) => matchesIn(xml.slice(q.start, q.end), find).length)) throw new WordError(`No match for “${find.slice(0, 60)}” (find is the exact text, with its case, inside one paragraph). Use read to see the text.`);
  const ins = (x) => (ctx.track ? `<w:ins w:id="${ctx.nextId()}" w:author="${AUTHOR}" w:date="${ctx.date}">${x}</w:ins>` : x);
  const done = {};
  let piece;
  if (op.ref) {
    let name; let shown;
    const cap = /^(figure|table) (\d+)$/i.exec(op.ref);
    if (cap) {
      const label = cap[1][0].toUpperCase() + cap[1].slice(1).toLowerCase();
      const p = captionPara(xml, label, Number(cap[2]));
      if (!p) throw new WordError(`There is no ${label} ${cap[2]} caption to point at. Add one with a caption (image or table), or use read to see the captions.`);
      [xml, name] = captionBookmark(xml, p, ctx);
      shown = `${label} ${cap[2]}`;
    } else {
      const bm = new RegExp(`<w:bookmarkStart\\b[^>]*w:name="${op.ref}"[^>]*/>`, 'i').exec(xml);
      if (!bm) throw new WordError(`There is no bookmark named ${op.ref}. Make one with style (find, bookmark).`);
      name = /w:name="([^"]*)"/.exec(bm[0])[1];
      const id = /w:id="([^"]*)"/.exec(bm[0])[1];
      const end = xml.indexOf(`<w:bookmarkEnd w:id="${id}"/>`, bm.index);
      shown = end > 0 ? unesc([...xml.slice(bm.index, end).matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')).slice(0, 200) || name : name;
    }
    piece = ins(`${op.text ? `<w:r>${textRuns(op.text)}</w:r>` : ''}${fieldRuns(`REF ${name} \\h`, shown)}`);
    done.ref = shown;
  } else if (op.note) {
    const N = NOTE[op.note];
    const np = await partOf(zip, files, N.part);
    const id = Math.max(0, ...[...np.text.matchAll(new RegExp(`<${N.el}\\b[^>]*w:id="(-?\\d+)"`, 'g'))].map((m) => Number(m[1]))) + 1;
    const body = `<${N.el} w:id="${id}"><w:p><w:pPr><w:pStyle w:val="${N.text}"/></w:pPr><w:r><w:rPr><w:rStyle w:val="${N.style}"/></w:rPr><${N.mark}/></w:r><w:r><w:t xml:space="preserve"> ${esc(cleanText(op.text))}</w:t></w:r></w:p></${N.el}>`;
    files.set(np.name, np.text.replace(new RegExp(`</w:${N.part}>\\s*$`), `${body}</w:${N.part}>`));
    const sp = await partOf(zip, files, 'styles');
    files.set(sp.name, ensureStyle(ensureStyle(files.get(sp.name) ?? sp.text, N.text), N.style));
    piece = ins(`<w:r><w:rPr><w:rStyle w:val="${N.style}"/></w:rPr><${N.ref} w:id="${id}"/></w:r>`);
    done.note = { kind: op.note, id };
  } else piece = null;
  // the place: right after the first match, in the paragraph's look there
  const p = allParas(xml).find((q) => matchesIn(xml.slice(q.start, q.end), find).length);
  let one = xml.slice(p.start, p.end);
  const [a, b] = matchesIn(one, find)[0];
  void a;
  one = cutAt(one, b);
  const at = boundaryAt(one, b);
  if (piece === null) {
    const prev = runsWithText(one).filter((x) => x.to === b && x.from < b).pop();
    const rprEl = prev ? kidOf(one, prev, 'w:rPr') : null;
    const rp = rprEl ? one.slice(rprEl.start, rprEl.end) : '';
    piece = ins(String(op.text).split(/(\{date\})/i).filter((t) => t !== '').map((t) => (t.toLowerCase() === '{date}' ? fieldRuns('DATE \\@ "MMMM d, yyyy"', now().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })) : `<w:r>${rp}${textRuns(t)}</w:r>`)).join(''));
    done.text = true;
  } else if (op.ref && !op.text && !/\s$/.test(find)) piece = ins('<w:r><w:t xml:space="preserve"> </w:t></w:r>') + piece;
  one = one.slice(0, at) + piece + one.slice(at);
  files.set('word/document.xml', splice(xml, p.start, p.end, one));
  return { buf: pack(entries, files), done, tracked: track };
}

// The body's paragraphs with their text (a tab counts: a typed contents line is often "Introduction<tab>3") and heading level.
const paraText = (xml, b) => { const s = xml.slice(b.start, b.end).replace(/<w:tab\/>/g, '<w:t>\t</w:t>'); return textOfBlock(s, { start: 0, end: s.length }); };
const paras = (xml) => bodyOf(xml).blocks.filter((b) => b.name === 'p').map((b) => ({ ...b, text: paraText(xml, b).trim(), level: levelOfBlock(xml, b) }));
// The paragraph a format target names: a heading with that text first, then the last paragraph with exactly that text (a typed contents
// list comes before the real heading), then one that starts with it, then one that contains it.
function targetPara(xml, text) {
  const want = String(text).replace(/^#+\s*/, '').trim().toLowerCase();
  const ps = paras(xml);
  const exact = ps.filter((p) => p.text.toLowerCase() === want);
  return exact.find((p) => p.level <= 9) || exact[exact.length - 1] || ps.find((p) => want && p.text.toLowerCase().startsWith(want)) || ps.find((p) => want && p.text.toLowerCase().includes(want)) || null;
}

function setHeading(xml, p, level) {
  let ppr; [xml, ppr] = upsert(xml, elementAt(xml, p.start), 'w:pPr', (had) => had || '<w:pPr></w:pPr>', ['w:pPr']);
  return upsert(xml, ppr, 'w:pStyle', () => `<w:pStyle w:val="Heading${level}"/>`, P_ORDER)[0];
}

const PAGE_BREAK = /<w:br\b[^>]*w:type="page"/;
function breakBefore(xml, p, ctx) {
  const all = bodyOf(xml).blocks;
  const i = all.findIndex((b) => b.start === p.start);
  const prev = all[i - 1];
  const own = xml.slice(p.start, p.end);
  if (i <= 0 || /<w:pageBreakBefore(?:\s+w:val="(?:1|true|on)")?\s*\/>/.test(own) || /^<w:p\b[^>]*>(?:<w:pPr>[\s\S]*?<\/w:pPr>)?(?:<w:ins\b[^>]*>)?<w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:br\b[^>]*w:type="page"/.test(own)) return { xml, added: false };
  if (prev && prev.name === 'p' && PAGE_BREAK.test(xml.slice(prev.start, prev.end)) && !textOfBlock(xml, prev).trim()) return { xml, added: false };
  if (prev && prev.name === 'p' && /<w:br\b[^>]*w:type="page"[^>]*\/>(?:<\/w:r>)?(?:<\/w:ins>)?<\/w:p>$/.test(xml.slice(prev.start, prev.end))) return { xml, added: false };
  const run = '<w:r><w:br w:type="page"/></w:r>';
  const piece = ctx.track ? `<w:p><w:pPr><w:rPr><w:ins w:id="${ctx.nextId()}" w:author="${AUTHOR}" w:date="${ctx.date}"/></w:rPr></w:pPr><w:ins w:id="${ctx.nextId()}" w:author="${AUTHOR}" w:date="${ctx.date}">${run}</w:ins></w:p>` : `<w:p>${run}</w:p>`;
  return { xml: splice(xml, p.start, p.start, piece), added: true };
}

const TOC_TITLE = /^(table of contents|contents)$/i;
const ENTRY_TAIL = /(?:\s*\.{2,}\s*|\t+|\s+)\d+\s*$/;
// A typed contents list: the paragraphs right after a "Table of Contents" title that look like entries (a heading's text, or text ending in a
// page number), with blank lines between them. -> { title, entries } (entries may be empty), or null when there is no such title.
function typedContents(xml) {
  const ps = paras(xml);
  const t = ps.findIndex((p) => TOC_TITLE.test(p.text.replace(/:$/, '')));
  if (t < 0) return null;
  const heads = new Set(ps.filter((p, i) => i !== t && p.level <= 9).map((p) => p.text.toLowerCase()));
  const later = ps.slice(t + 1);
  const known = (text) => { const k = text.replace(ENTRY_TAIL, '').replace(/^[\d.]+\s+/, '').trim().toLowerCase(); return heads.has(k) || later.filter((p) => p.text.toLowerCase() === k).length > 1; };
  const entries = []; let blanks = [];
  for (const p of later) {
    if (p.level <= 9) break;
    if (!p.text) { if (!/<w:br\b[^>]*w:type="page"/.test(xml.slice(p.start, p.end))) { blanks.push(p); continue; } break; }
    if (!(ENTRY_TAIL.test(p.text) || known(p.text))) break;
    entries.push(...blanks, p); blanks = [];
  }
  return { title: ps[t], entries };
}
// A paragraph taken out: as a tracked deletion (its text and paragraph mark marked deleted) or for good.
function removePara(xml, p, ctx) {
  if (!ctx.track) return splice(xml, p.start, p.end, '');
  let s = xml.slice(p.start, p.end);
  const mark = `<w:del w:id="${ctx.nextId()}" w:author="${AUTHOR}" w:date="${ctx.date}"/>`;
  s = s.replace(/<w:r>|<w:r\s[^>]*>/g, (m) => `<w:del w:id="${ctx.nextId()}" w:author="${AUTHOR}" w:date="${ctx.date}">${m}`).replace(/<\/w:r>/g, '</w:r></w:del>')
    .replace(/<w:t(\s[^>]*)?>/g, '<w:delText$1>').replace(/<\/w:t>/g, '</w:delText>').replace(/<w:instrText(\s[^>]*)?>/g, '<w:delInstrText$1>').replace(/<\/w:instrText>/g, '</w:delInstrText>');
  let ppr; [s, ppr] = upsert(s, { name: 'w:p', start: 0, end: s.length }, 'w:pPr', (had) => had || '<w:pPr></w:pPr>', ['w:pPr']);
  [s] = upsert(s, ppr, 'w:rPr', (had) => (had ? upsert(had, { name: 'w:rPr', start: 0, end: had.length }, 'w:del', () => mark, R_ORDER)[0] : `<w:rPr>${mark}</w:rPr>`), P_ORDER);
  return splice(xml, p.start, p.end, s);
}
const TOC_NOTE = 'The table of contents appears here when Word updates fields (it asks when the document opens; or right-click here → Update Field).';
function tocXml(ctx) {
  const runs = `<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t xml:space="preserve">${esc(TOC_NOTE)}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
  return ctx.track ? `<w:p><w:pPr><w:rPr><w:ins w:id="${ctx.nextId()}" w:author="${AUTHOR}" w:date="${ctx.date}"/></w:rPr></w:pPr><w:ins w:id="${ctx.nextId()}" w:author="${AUTHOR}" w:date="${ctx.date}">${runs}</w:ins></w:p>` : `<w:p>${runs}</w:p>`;
}

// Margins (inches) and orientation for every section, or section n (1-based, in document order).
function formatSections(xml, f) {
  let found = [...xml.matchAll(/<w:sectPr\b/g)].map((m) => m.index);
  if (!found.length) {
    const body = bodyOf(xml);
    xml = splice(xml, body.close, body.close, '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>');
    found = [...xml.matchAll(/<w:sectPr\b/g)].map((m) => m.index);
  }
  if (f.section && f.section > found.length) throw new WordError(`The document has ${found.length} section${found.length === 1 ? '' : 's'}, so there is no section ${f.section}.`);
  const picked = f.section ? [found[f.section - 1]] : found;
  for (const at of picked.reverse()) {
    let sect = elementAt(xml, at);
    if (f.orientation) {
      [xml] = upsert(xml, sect, 'w:pgSz', (had) => {
        const cur = had || '<w:pgSz w:w="12240" w:h="15840"/>';
        const w = Number((/w:w="(\d+)"/.exec(cur) || [])[1] || 12240); const h = Number((/w:h="(\d+)"/.exec(cur) || [])[1] || 15840);
        const land = f.orientation === 'landscape';
        return withAttrs(cur, { 'w:w': String(land ? Math.max(w, h) : Math.min(w, h)), 'w:h': String(land ? Math.min(w, h) : Math.max(w, h)), 'w:orient': land ? 'landscape' : null });
      }, SECT_ORDER);
      sect = elementAt(xml, at);
    }
    if (f.margins) {
      const m = f.margins;
      [xml] = upsert(xml, sect, 'w:pgMar', (had) => withAttrs(had || '<w:pgMar w:header="720" w:footer="720" w:gutter="0"/>', { 'w:top': String(Math.round(m.top * 1440)), 'w:right': String(Math.round(m.right * 1440)), 'w:bottom': String(Math.round(m.bottom * 1440)), 'w:left': String(Math.round(m.left * 1440)) }), SECT_ORDER);
    }
    const S = () => elementAt(xml, at);
    if (f.columns !== undefined) [xml] = upsert(xml, S(), 'w:cols', () => (f.columns > 1 ? `<w:cols w:num="${f.columns}" w:space="720"/>` : '<w:cols w:space="720"/>'), SECT_ORDER);
    if (f.pageStart !== undefined) [xml] = upsert(xml, S(), 'w:pgNumType', (had) => withAttrs(had || '<w:pgNumType/>', { 'w:start': String(f.pageStart) }), SECT_ORDER);
    if (f.firstPage !== undefined) [xml] = upsert(xml, S(), 'w:titlePg', () => onOff('w:titlePg', f.firstPage), SECT_ORDER);
    // header and footer references (refs: { header: { default, first }, footer: { ... } } relationship ids): first in w:sectPr, one per kind and type
    for (const [kind, types] of Object.entries(f.refs || {})) {
      for (const [type, rid] of Object.entries(types)) {
        const el = `w:${kind}Reference`;
        let x = xml.slice(S().start, S().end);
        x = x.replace(new RegExp(`<${el}\\b(?=[^>]*w:type="${type}")[^>]*/>`, 'g'), '');
        const open = /^<w:sectPr\b[^>]*>/.exec(x);
        x = open ? x.slice(0, open[0].length) + `<${el} w:type="${type}" r:id="${rid}"/>` + x.slice(open[0].length) : x.replace(/^<w:sectPr\b([^>]*)\/>$/, (m, a) => `<w:sectPr${a}><${el} w:type="${type}" r:id="${rid}"/></w:sectPr>`);
        xml = splice(xml, S().start, S().end, x);
      }
    }
  }
  return { xml, sections: picked.length };
}

// ---- headers and footers: a part of their own (word/headerN.xml, word/footerN.xml) with one paragraph, "left <tab> center <tab> right" on the
// text's center and right tab stops; {page}, {pages} and {date} are PAGE, NUMPAGES and DATE fields.
const HF = { header: { root: 'w:hdr', style: 'Header', rel: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header', ct: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml' }, footer: { root: 'w:ftr', style: 'Footer', rel: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer', ct: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml' } };
const FIELD_OF = { '{page}': ['PAGE', '1'], '{pages}': ['NUMPAGES', '1'] };
function hfRuns(text, now) {
  return String(text || '').split(/(\{page\}|\{pages\}|\{date\})/i).filter((t) => t !== '').map((t) => {
    const k = t.toLowerCase();
    if (FIELD_OF[k]) return fieldRuns(FIELD_OF[k][0], FIELD_OF[k][1]);
    if (k === '{date}') return fieldRuns('DATE \\@ "MMMM d, yyyy"', now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }));
    return `<w:r>${textRuns(t)}</w:r>`;
  }).join('');
}
function hfXml(kind, parts, width, now) {
  const tw = Math.round(width / 635);
  const pieces = parts ? [parts.left || '', parts.center || '', parts.right || ''] : null;
  const body = pieces ? `${hfRuns(pieces[0], now)}${pieces[1] || pieces[2] ? '<w:r><w:tab/></w:r>' : ''}${hfRuns(pieces[1], now)}${pieces[2] ? '<w:r><w:tab/></w:r>' : ''}${hfRuns(pieces[2], now)}` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${HF[kind].root} ${NS}><w:p><w:pPr><w:pStyle w:val="${HF[kind].style}"/><w:tabs><w:tab w:val="center" w:pos="${Math.round(tw / 2)}"/><w:tab w:val="right" w:pos="${tw}"/></w:tabs></w:pPr>${body}</w:p></${HF[kind].root}>`;
}
// A new header or footer part with its relationship and content type: -> its relationship id.
async function addHfPart(zip, files, entries, kind, xml) {
  const relsName = 'word/_rels/document.xml.rels';
  const rels = files.get(relsName) ?? (zip.has(relsName) ? await zip.text(relsName) : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
  const taken = new Set([...entries.map((e) => e.name), ...files.keys()]);
  let n = 1; while (taken.has(`word/${kind}${n}.xml`)) n++;
  const rid = `rId${Math.max(0, ...[...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]))) + 1}`;
  files.set(relsName, rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="${HF[kind].rel}" Target="${kind}${n}.xml"/></Relationships>`));
  const ctName = '[Content_Types].xml';
  const ct = files.get(ctName) ?? (await zip.text(ctName));
  files.set(ctName, ct.replace('</Types>', `<Override PartName="/word/${kind}${n}.xml" ContentType="${HF[kind].ct}"/></Types>`));
  files.set(`word/${kind}${n}.xml`, xml);
  return rid;
}

// ---- section and column breaks before paragraphs. A section ends at the w:sectPr in its last paragraph (the body's own w:sectPr ends the last
// one), and a w:sectPr's w:type says how its section starts: so a break before P copies the w:sectPr that P's section ends with into the paragraph
// before P, and that w:sectPr's w:type becomes the break's kind.
function sectionBreak(xml, p, kind, ctx) {
  const body = bodyOf(xml);
  const i = body.blocks.findIndex((b) => b.start === p.start);
  if (i <= 0) return { xml, added: false };
  const prev = body.blocks[i - 1];
  if (prev.name === 'p' && /<w:sectPr\b/.test(xml.slice(prev.start, prev.end))) return { xml, added: false };
  const after = [...xml.matchAll(/<w:sectPr\b/g)].map((m) => m.index).find((x) => x > p.start);
  if (after === undefined) return { xml, added: false };
  const next = elementAt(xml, after);
  const copy = xml.slice(next.start, next.end);
  [xml] = upsert(xml, next, 'w:type', () => `<w:type w:val="${kind}"/>`, SECT_ORDER); // (P's section now starts with this break)
  if (prev.name === 'p') {
    let ppr; [xml, ppr] = upsert(xml, elementAt(xml, prev.start), 'w:pPr', (had) => had || '<w:pPr></w:pPr>', ['w:pPr']);
    [xml] = upsert(xml, ppr, 'w:sectPr', () => copy, P_ORDER);
  } else xml = splice(xml, p.start, p.start, `<w:p><w:pPr>${copy}${ctx.track ? `<w:rPr>${insMark(ctx)}</w:rPr>` : ''}</w:pPr></w:p>`);
  return { xml, added: true };
}
function columnBreak(xml, p, ctx) {
  const own = xml.slice(p.start, p.end);
  if (/^<w:p\b[^>]*>(?:<w:pPr>[\s\S]*?<\/w:pPr>)?(?:<w:ins\b[^>]*>)?<w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:br w:type="column"\/>/.test(own)) return { xml, added: false };
  const el = elementAt(xml, p.start);
  const ppr = kidOf(xml, el, 'w:pPr');
  const at = ppr ? ppr.end : innerOf(xml, el).from;
  const run = '<w:r><w:br w:type="column"/></w:r>';
  return { xml: splice(xml, at, at, ctx.track ? `<w:ins w:id="${ctx.nextId()}" w:author="${AUTHOR}" w:date="${ctx.date}">${run}</w:ins>` : run), added: true };
}

// A part of the package by its relationship type from document.xml (styles, settings): { name, rels } or null.
const REL = { comments: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments', footnotes: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes', endnotes: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes', styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles', settings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings', numbering: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering' };
const CT = { comments: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml', footnotes: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml', endnotes: 'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml', styles: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml', settings: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml', numbering: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml' };
const NOTE_SEP = (el) => `<${el} w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></${el}><${el} w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></${el}>`;
const EMPTY_PART = { comments: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${NS}></w:comments>`, footnotes: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${NS}>${NOTE_SEP('w:footnote')}</w:footnotes>`, endnotes: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:endnotes ${NS}>${NOTE_SEP('w:endnote')}</w:endnotes>`, styles: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}>${STYLE_DEFS.Normal}</w:styles>`, settings: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings ${NS}></w:settings>`, numbering: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${NS}></w:numbering>` };
async function partOf(zip, files, kind) {
  const relsName = 'word/_rels/document.xml.rels';
  let rels = files.get(relsName) ?? (zip.has(relsName) ? await zip.text(relsName) : null);
  if (rels === null) rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  const m = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((x) => x[0]).find((r) => r.includes(`Type="${REL[kind]}"`));
  if (m) {
    const target = (/Target="([^"]+)"/.exec(m) || [])[1] || '';
    const name = target.startsWith('/') ? target.slice(1) : `word/${target}`.replace(/\/\.\//g, '/');
    const text = files.get(name) ?? (zip.has(name) ? await zip.text(name) : null);
    if (text !== null) return { name, text };
  }
  // missing: make it, with its relationship and content type
  const name = `word/${kind}.xml`;
  const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((x) => Number(x[1]));
  files.set(relsName, rels.replace('</Relationships>', `<Relationship Id="rId${Math.max(0, ...ids) + 1}" Type="${REL[kind]}" Target="${kind}.xml"/></Relationships>`));
  const ctName = '[Content_Types].xml';
  const ct = files.get(ctName) ?? (await zip.text(ctName));
  if (!ct.includes(`PartName="/${name}"`)) files.set(ctName, ct.replace('</Types>', `<Override PartName="/${name}" ContentType="${CT[kind]}"/></Types>`));
  return { name, text: EMPTY_PART[kind] };
}
function setUpdateFields(xml) {
  const r = /<w:settings[\s>]/.exec(xml);
  if (!r) throw damaged();
  const root = elementAt(xml, r.index);
  const order = ['w:updateFields', ...SETTINGS_AFTER];
  return upsert(xml, root, 'w:updateFields', () => '<w:updateFields w:val="true"/>', order)[0];
}

// f: { font, size, line, before, after, style (an id from STYLE_IDS' names), find, margins {top,right,bottom,left}, orientation, section,
// breaks [texts], toc, tocAt, headings [{ text, level }] }. -> { buf, done: { ... } } (what changed, for the AI's answer).
async function formatDocx(buf, f, { track = false, now = () => new Date() } = {}) {
  const { xml: original, entries } = await openForEdit(buf);
  const zip = createZipReader(buf, { maxBytes: MAX_INFLATED, root: 'word/document.xml' });
  bodyOf(original); // (refuses an unusual structure before anything is changed)
  const ctx = { track, nextId: makeIds(original), date: now().toISOString().replace(/\.\d+Z$/, 'Z') };
  const files = new Map();
  let xml = original;
  const done = {};
  // headings first: the table of contents is built from them
  if (f.headings?.length) {
    const styles = await partOf(zip, files, 'styles');
    let st = styles.text;
    const missing = [];
    let styled = 0;
    for (const h of f.headings) {
      const p = targetPara(xml, h.text);
      if (!p) { missing.push(h.text); continue; }
      xml = setHeading(xml, p, h.level);
      st = ensureStyle(st, `Heading${h.level}`);
      styled++;
    }
    if (missing.length) throw new WordError(`No paragraph matches ${missing.map((t) => `“${t.slice(0, 60)}”`).join(', ')}, so nothing was changed. Use read to see the text.`);
    files.set(styles.name, st);
    done.headings = styled;
  }
  if (f.toc) {
    if (/<w:instrText[^>]*>\s*TOC\b/.test(xml)) done.toc = { already: true };
    else {
      const typed = typedContents(xml);
      let at;
      if (typed) {
        for (const p of [...typed.entries].reverse()) xml = removePara(xml, p, ctx);
        at = elementAt(xml, typed.title.start).end;
      } else if (f.tocAt) {
        const p = targetPara(xml, f.tocAt);
        if (!p) throw new WordError(`No paragraph matches “${String(f.tocAt).slice(0, 60)}” to put the table of contents after. Use read to see the text.`);
        at = p.end;
      } else at = position(xml, bodyOf(xml), { at: 'start' });
      xml = splice(xml, at, at, tocXml(ctx));
      done.toc = { replaced: typed ? typed.entries.filter((p) => p.text).length : 0, title: typed ? typed.title.text : '' };
    }
    const settings = await partOf(zip, files, 'settings');
    files.set(settings.name, setUpdateFields(settings.text));
    const styles = await partOf(zip, files, 'styles');
    if (!files.has(styles.name)) files.set(styles.name, styles.text);
  }
  if (f.breaks?.length) {
    const targets = f.breaks.map((t) => ({ t, p: targetPara(xml, t) }));
    const missing = targets.filter((x) => !x.p).map((x) => x.t);
    if (missing.length) throw new WordError(`No paragraph matches ${missing.map((t) => `“${String(t).slice(0, 60)}”`).join(', ')}, so nothing was changed. Use read to see the text.`);
    done.breaks = { added: [], had: [] };
    for (const x of targets.sort((a, b) => b.p.start - a.p.start)) {
      const p = paras(xml).find((q) => q.start === x.p.start) || x.p;
      const r = breakBefore(xml, p, ctx);
      xml = r.xml;
      done.breaks[r.added ? 'added' : 'had'].unshift(x.p.text || x.t);
    }
  }
  if (f.style && (hasText(f) || hasPara(f) || f.basedOn)) {
    // a style: made (with based_on) or changed in styles.xml; the document's paragraphs keep what they have
    const styles = await partOf(zip, files, 'styles');
    const r = styleFor(styles.text, f.style, { basedOn: f.basedOn, make: true });
    files.set(styles.name, formatStyles(r.xml, f, r.id));
    done.text = { style: f.style, created: r.created, basedOn: f.basedOn || null };
  } else if (f.paras || (f.find && f.list)) {
    const starts = f.paras ? f.paras.map((t) => ({ t, p: targetPara(xml, t) })) : findParas(xml, f.find).map((s) => ({ p: { start: s } }));
    const missing = starts.filter((x) => !x.p).map((x) => x.t);
    if (missing.length) throw new WordError(`No paragraph matches ${missing.map((t) => `“${String(t).slice(0, 60)}”`).join(', ')}, so nothing was changed. Use read to see the text.`);
    let list;
    if (f.list === 'none') list = null;
    else if (f.list) {
      const np = await partOf(zip, files, 'numbering');
      const r = newList(np.text, f.list);
      files.set(np.name, r.xml);
      list = r.numId;
    }
    xml = formatTargets(xml, f, [...new Set(starts.map((x) => x.p.start))], list);
    done.text = { paragraphs: new Set(starts.map((x) => x.p.start)).size, find: f.find || null, list: f.list || null };
  } else if (hasText(f) || hasPara(f)) {
    const body = formatBody(xml, f, f.find);
    xml = body.xml;
    if (!f.find) {
      const styles = await partOf(zip, files, 'styles');
      files.set(styles.name, formatStyles(styles.text, f, null));
    }
    done.text = { style: null, find: f.find || null, paragraphs: body.paragraphs };
  }
  // breaks first: a section number given with them counts the sections they make
  for (const [key, fn, word] of [['sectionBreaks', (x, p) => sectionBreak(x, p, f.sectionBreak || 'nextPage', ctx), 'sectionBreaks'], ['columnBreaks', (x, p) => columnBreak(x, p, ctx), 'columnBreaks']]) {
    if (!f[key]?.length) continue;
    const targets = f[key].map((t) => ({ t, p: targetPara(xml, t) }));
    const missing = targets.filter((x) => !x.p).map((x) => x.t);
    if (missing.length) throw new WordError(`No paragraph matches ${missing.map((t) => `“${String(t).slice(0, 60)}”`).join(', ')}, so nothing was changed. Use read to see the text.`);
    done[word] = { added: [], had: [] };
    for (const x of targets.sort((a, b) => b.p.start - a.p.start)) {
      const p = paras(xml).find((q) => q.start === x.p.start) || x.p;
      const r = fn(xml, p);
      xml = r.xml;
      done[word][r.added ? 'added' : 'had'].unshift(x.p.text || x.t);
    }
  }
  if (f.header || f.footer || f.firstPage) {
    // a new part for each header or footer set here (the sections picked point at it), and empty first-page ones for a different first page
    if (!/<w:document\b[^>]*\sxmlns:r=/.test(xml)) xml = xml.replace(/<w:document\b/, `<w:document xmlns:r="${R_NS}"`);
    const st = await partOf(zip, files, 'styles');
    files.set(st.name, ensureStyle(ensureStyle(st.text, 'Header'), 'Footer'));
    const width = textWidth(xml);
    const at = now();
    const refs = {};
    for (const kind of ['header', 'footer']) {
      if (f[kind]) (refs[kind] ||= {}).default = await addHfPart(zip, files, entries, kind, hfXml(kind, f[kind], width, at));
      if (f.firstPage === true) (refs[kind] ||= {}).first = await addHfPart(zip, files, entries, kind, hfXml(kind, null, width, at));
    }
    f = { ...f, refs };
    done.headers = { header: Boolean(f.header), footer: Boolean(f.footer), firstPage: f.firstPage ?? null };
  }
  if (f.margins || f.orientation || f.refs || f.columns !== undefined || f.pageStart !== undefined || f.firstPage !== undefined) {
    const s = formatSections(xml, f);
    xml = s.xml;
    done.sections = s.sections;
  }
  if (f.properties) {
    files.set(...(await coreWith(zip, files, f.properties, now())));
    done.properties = Object.keys(f.properties);
  }
  files.set('word/document.xml', xml);
  return { buf: pack(entries, files), done, tracked: track };
}

// The document's own properties (docProps/core.xml: title, author, subject, keywords), made with its relationship and content type when
// missing. -> [name, xml]
const CORE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties';
const CORE_EL = { title: 'dc:title', author: 'dc:creator', subject: 'dc:subject', keywords: 'cp:keywords' };
async function coreWith(zip, files, props, at) {
  const relsName = '_rels/.rels';
  const rels = files.get(relsName) ?? (zip.has(relsName) ? await zip.text(relsName) : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');
  const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((r) => r.includes(`Type="${CORE_REL}"`));
  let name = rel ? ((/Target="\/?([^"]+)"/.exec(rel) || [])[1] || 'docProps/core.xml') : 'docProps/core.xml';
  let xml = files.get(name) ?? (rel && zip.has(name) ? await zip.text(name) : null);
  if (xml === null) {
    name = 'docProps/core.xml';
    const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
    files.set(relsName, rels.replace('</Relationships>', `<Relationship Id="rId${Math.max(0, ...ids) + 1}" Type="${CORE_REL}" Target="docProps/core.xml"/></Relationships>`));
    const ct = files.get('[Content_Types].xml') ?? (await zip.text('[Content_Types].xml'));
    if (!ct.includes('PartName="/docProps/core.xml"')) files.set('[Content_Types].xml', ct.replace('</Types>', '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>'));
    xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dcterms:created xsi:type="dcterms:W3CDTF">${at.toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`;
  }
  if (!/<cp:coreProperties\b/.test(xml) || !/xmlns:dc=/.test(xml)) throw new WordError('This document keeps its properties in a way Lumen does not edit. Set them in Word (File > Info).');
  for (const [k, v] of Object.entries(props)) {
    const el = CORE_EL[k];
    const piece = v === '' ? '' : `<${el}>${esc(cleanText(v))}</${el}>`;
    const re = new RegExp(`<${el}(?:\\s[^>]*)?(?:/>|>[\\s\\S]*?</${el}>)`);
    xml = re.test(xml) ? xml.replace(re, () => piece) : xml.replace(/<\/cp:coreProperties>\s*$/, `${piece}</cp:coreProperties>`);
  }
  if (!/xmlns:cp=/.test(xml)) throw new WordError('This document keeps its properties in a way Lumen does not edit. Set them in Word (File > Info).');
  return [name, xml];
}
// ---- captions: "Figure 1: ..." under a picture, "Table 1: ..." over a table, in the Caption style, the number a SEQ field (as Word's own
// Insert Caption makes it), so a list of figures and cross-references find it. The numbers already in the document are put in order again.
const fieldRuns = (instr, result) => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${esc(result)}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
const seqRe = (label) => new RegExp(`(<w:instrText[^>]*>\\s*SEQ ${label}\\b[^<]*</w:instrText></w:r>(?:<w:r>(?:<w:rPr>(?:(?!</w:rPr>).)*</w:rPr>)?<w:fldChar w:fldCharType="separate"/></w:r>)<w:r>(?:<w:rPr>(?:(?!</w:rPr>).)*</w:rPr>)?<w:t(?:\\s[^>]*)?>)(\\d*)(</w:t>)|(<w:fldSimple w:instr="\\s*SEQ ${label}\\b[^"]*">(?:<w:r>(?:<w:rPr>(?:(?!</w:rPr>).)*</w:rPr>)?<w:t(?:\\s[^>]*)?>))(\\d*)(</w:t>)`, 'g');
const seqBefore = (xml, label, at) => [...xml.slice(0, at).matchAll(seqRe(label))].length;
function renumber(xml, label) { let n = 0; return xml.replace(seqRe(label), (m, a, _d, c, e, _g, h) => { n++; return a ? `${a}${n}${c}` : `${e}${n}${h}`; }); }
function captionXml(label, n, text, ctx, { keepNext = false, align = '' } = {}) {
  const body = `<w:r><w:t xml:space="preserve">${label} </w:t></w:r>${fieldRuns(`SEQ ${label} \\* ARABIC`, String(n))}${text ? `<w:r><w:t xml:space="preserve">: ${esc(cleanText(text))}</w:t></w:r>` : ''}`;
  const ppr = `<w:pStyle w:val="Caption"/>${keepNext ? '<w:keepNext/>' : ''}${align ? `<w:jc w:val="${JC[align]}"/>` : ''}${ctx.track ? `<w:rPr>${insMark(ctx)}</w:rPr>` : ''}`;
  return `<w:p><w:pPr>${ppr}</w:pPr>${ctx.track ? `<w:ins w:id="${ctx.nextId()}" w:author="${AUTHOR}" w:date="${ctx.date}">${body}</w:ins>` : body}</w:p>`;
}

// ---- pictures: the file goes into word/media (with its relationship and content type), and a drawing into a paragraph of its own: inline in
// the text, or floating with the text wrapped around it (square, tight, top and bottom, behind or in front of the text).
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const DML = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const EMU_IN = 914400;
// The text column's width in EMU (the last section's page width less its margins; 6.5 inches when the document does not say).
function textWidth(xml) {
  const sect = [...xml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].pop()?.[0] || '';
  const w = Number((/<w:pgSz\b[^>]*w:w="(\d+)"/.exec(sect) || [])[1] || 12240);
  const l = Number((/<w:pgMar\b[^>]*w:left="(\d+)"/.exec(sect) || [])[1] || 1440);
  const r = Number((/<w:pgMar\b[^>]*w:right="(\d+)"/.exec(sect) || [])[1] || 1440);
  return Math.max(EMU_IN, (w - l - r) * 635);
}
// [cx, cy] in EMU: the size asked for (one side keeps the shape), else the picture's own at 96 dpi, no wider than the text.
function sizeOf(info, f, max) {
  const pw = info.width || 640; const ph = info.height || 480;
  if (f.width && f.height) return [Math.round(f.width * EMU_IN), Math.round(f.height * EMU_IN)];
  if (f.width) return [Math.round(f.width * EMU_IN), Math.round((f.width * EMU_IN * ph) / pw)];
  if (f.height) return [Math.round((f.height * EMU_IN * pw) / ph), Math.round(f.height * EMU_IN)];
  let cx = pw * 9525; let cy = ph * 9525;
  if (cx > max) { cy = Math.round((cy * max) / cx); cx = max; }
  return [cx, cy];
}
const WRAP_XML = { square: '<wp:wrapSquare wrapText="bothSides"/>', tight: '<wp:wrapTight wrapText="bothSides"><wp:wrapPolygon edited="0"><wp:start x="0" y="0"/><wp:lineTo x="0" y="21600"/><wp:lineTo x="21600" y="21600"/><wp:lineTo x="21600" y="0"/><wp:lineTo x="0" y="0"/></wp:wrapPolygon></wp:wrapTight>', top_bottom: '<wp:wrapTopAndBottom/>', behind: '<wp:wrapNone/>', front: '<wp:wrapNone/>' };
function drawingXml({ rid, cx, cy, id, name, alt, wrap, align }) {
  const docPr = `<wp:docPr id="${id}" name="Picture ${id}"${alt ? ` descr="${esc(cleanText(alt))}"` : ''}/>`;
  const frame = `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${DML}" noChangeAspect="1"/></wp:cNvGraphicFramePr>`;
  const graphic = `<a:graphic xmlns:a="${DML}"><a:graphicData uri="${PIC}"><pic:pic xmlns:pic="${PIC}"><pic:nvPicPr><pic:cNvPr id="0" name="${esc(name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="${R_NS}" r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`;
  const size = `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`;
  if (!wrap || wrap === 'inline') return `<w:drawing><wp:inline xmlns:wp="${WP}" distT="0" distB="0" distL="0" distR="0">${size}${docPr}${frame}${graphic}</wp:inline></w:drawing>`;
  return `<w:drawing><wp:anchor xmlns:wp="${WP}" distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="${251659264 + id}" behindDoc="${wrap === 'behind' ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:align>${align || 'center'}</wp:align></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>${size}${WRAP_XML[wrap]}${docPr}${frame}${graphic}</wp:anchor></w:drawing>`;
}
// op: { at, heading, data (the picture's bytes), info (picture.js pictureInfo), name, width, height, wrap, align, caption, alt } -> { buf, caption }
async function imageDocx(buf, op, { track = false, now = () => new Date() } = {}) {
  const { xml, zip, entries } = await openForEdit(buf);
  const body = bodyOf(xml);
  const ctx = { track, nextId: makeIds(xml), date: now().toISOString().replace(/\.\d+Z$/, 'Z') };
  const files = new Map();
  const names = new Set(entries.map((e) => e.name));
  let k = 1; while ([...names].some((n) => n.startsWith(`word/media/image${k}.`))) k++;
  const media = `word/media/image${k}.${op.info.ext}`;
  const relsName = 'word/_rels/document.xml.rels';
  const rels = zip.has(relsName) ? await zip.text(relsName) : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  const rid = `rId${Math.max(0, ...[...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]))) + 1}`;
  files.set(relsName, rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="${IMAGE_REL}" Target="media/image${k}.${op.info.ext}"/></Relationships>`));
  const ct = await zip.text('[Content_Types].xml');
  if (!new RegExp(`<Default Extension="${op.info.ext}"`, 'i').test(ct)) files.set('[Content_Types].xml', ct.replace('</Types>', `<Default Extension="${op.info.ext}" ContentType="${op.info.mime}"/></Types>`));
  const id = Math.max(0, ...[...xml.matchAll(/<wp:docPr\b[^>]*\sid="(\d+)"/g)].map((m) => Number(m[1]))) + 1;
  const [cx, cy] = sizeOf(op.info, op, textWidth(xml));
  const run = `<w:r>${drawingXml({ rid, cx, cy, id, name: op.name || `image${k}.${op.info.ext}`, alt: op.alt, wrap: op.wrap, align: op.align })}</w:r>`;
  const inline = !op.wrap || op.wrap === 'inline';
  const ppr = `${op.caption !== undefined ? '<w:keepNext/>' : ''}${inline ? `<w:jc w:val="${JC[op.align || 'center']}"/>` : ''}${track ? `<w:rPr>${insMark(ctx)}</w:rPr>` : ''}`;
  let piece = `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${track ? `<w:ins w:id="${ctx.nextId()}" w:author="${AUTHOR}" w:date="${ctx.date}">${run}</w:ins>` : run}</w:p>`;
  const at = position(xml, body, op);
  let n = 0;
  if (op.caption !== undefined) {
    const sp = await partOf(zip, files, 'styles');
    files.set(sp.name, ensureStyle(sp.text, 'Caption'));
    n = seqBefore(xml, 'Figure', at) + 1;
    piece += captionXml('Figure', n, op.caption, ctx, { align: inline ? op.align || 'center' : '' });
  }
  let next = xml.slice(0, at) + piece + xml.slice(at);
  if (n) next = renumber(next, 'Figure');
  files.set('word/document.xml', next);
  const out = [...entries, { name: media, data: op.data }];
  return { buf: pack(out, files), caption: n || null, size: { width: +(cx / EMU_IN).toFixed(2), height: +(cy / EMU_IN).toFixed(2) }, tracked: track };
}

function newDocx() {
  const files = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body><w:p/><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    'word/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${styleXml('Title', 'Title', '<w:pPr><w:keepNext/></w:pPr><w:rPr><w:sz w:val="52"/></w:rPr>')}${styleXml('Heading1', 'heading 1', '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="0"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr>')}${styleXml('Heading2', 'heading 2', '<w:pPr><w:keepNext/><w:spacing w:before="40" w:after="0"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr>')}${styleXml('Heading3', 'heading 3', '<w:pPr><w:keepNext/><w:spacing w:before="40" w:after="0"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr>')}${styleXml('Quote', 'Quote', '<w:pPr><w:ind w:left="720" w:right="720"/></w:pPr><w:rPr><w:i/></w:rPr>')}</w:styles>`,
  };
  return buildZip(Object.entries(files).map(([name, text]) => ({ name, data: Buffer.from(text, 'utf8') })));
}

module.exports = { tableDeletion, readDocx, editDocx, formatDocx, styleDocx, tableDocx, imageDocx, insertDocx, reviewDocx, replaceDocx, commentDocx, trackDocx, newDocx, STYLE_IDS, buildZip, centralEntries, crc32, AUTHOR };
