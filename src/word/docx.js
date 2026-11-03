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

function tableXml(rows, ctx) {
  const cols = rows[0].length;
  const w = Math.max(900, Math.floor(9000 / cols));
  const border = (n) => `<w:${n} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`;
  const ins = () => `<w:ins w:id="${ctx.nextId()}" w:author="${AUTHOR}" w:date="${ctx.date}"/>`;
  const trs = rows.map((row, ri) => {
    const tcs = row.map((cell) => {
      const body = runs(cell, { bold: ri === 0 && rows.length > 1 });
      return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr><w:p>${ctx.track ? `<w:pPr><w:rPr>${ins()}</w:rPr></w:pPr><w:ins w:id="${ctx.nextId()}" w:author="${AUTHOR}" w:date="${ctx.date}">${body}</w:ins>` : body}</w:p></w:tc>`;
    }).join('');
    return `<w:tr>${ctx.track ? `<w:trPr>${ins()}</w:trPr>` : ''}${tcs}</w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders></w:tblPr><w:tblGrid>${'<w:gridCol w:w="' + w + '"/>'.repeat(cols)}</w:tblGrid>${trs}</w:tbl><w:p/>`;
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
    piece = tableXml(op.table.rows, ctx);
    summary = { rows: op.table.rows.length, columns: op.table.rows[0].length };
  } else throw new WordError('That change needs Microsoft Word.');
  const at = position(xml, body, op.insert || op.table);
  files.set('word/document.xml', xml.slice(0, at) + piece + xml.slice(at));
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

const STYLE_IDS = { Normal: 'Normal', Title: 'Title', 'Heading 1': 'Heading1', 'Heading 2': 'Heading2', 'Heading 3': 'Heading3', 'Heading 4': 'Heading4', 'Heading 5': 'Heading5', 'Heading 6': 'Heading6', Quote: 'Quote', 'List Bullet': 'ListBullet', 'List Number': 'ListNumber' };
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
  files.set('word/document.xml', xml);
  return { buf: pack(entries, files), formatted: count };
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
  }
  return { xml, sections: picked.length };
}

// A part of the package by its relationship type from document.xml (styles, settings): { name, rels } or null.
const REL = { styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles', settings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings', numbering: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering' };
const CT = { styles: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml', settings: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml', numbering: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml' };
const EMPTY_PART = { styles: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}>${STYLE_DEFS.Normal}</w:styles>`, settings: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings ${NS}></w:settings>`, numbering: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${NS}></w:numbering>` };
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
  if (f.margins || f.orientation) {
    const s = formatSections(xml, f);
    xml = s.xml;
    done.sections = s.sections;
  }
  files.set('word/document.xml', xml);
  return { buf: pack(entries, files), done, tracked: track };
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

module.exports = { readDocx, editDocx, formatDocx, styleDocx, newDocx, STYLE_IDS, buildZip, centralEntries, crc32, AUTHOR };
