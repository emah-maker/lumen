// [word] Word documents without Word: reading a .docx with its structure (headings, lists, tables, comments, a tracked-changes summary), and a
// small, careful writer for the three things that are safe to do to the XML by hand: new paragraphs (with a heading or list style), a new table, and
// a new empty document. Everything else (find and replace, formatting, pictures, comments) needs Word itself and says so.
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
async function readDocx(buf, { offset = 0, budget = 9000 } = {}) {
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
const IDS = { Normal: '', 'Heading 1': 'Heading1', 'Heading 2': 'Heading2', 'Heading 3': 'Heading3', Title: 'Title', 'List Bullet': 'ListBullet', 'List Number': 'ListNumber', Quote: 'Quote' };
const HEAD_SIZE = { Heading1: 32, Heading2: 26, Heading3: 24, Title: 44 };

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

function paragraphXml(text, style, ctx) {
  const id = IDS[style || 'Normal'] ?? '';
  const hasStyle = id && ctx.styles.has(id);
  const fake = id && !hasStyle; // the style is not defined in this file: look like it with direct formatting
  const bullet = fake && id === 'ListBullet' ? '• ' : '';
  const rpr = { bold: fake && /^(Heading|Title)/.test(id), size: fake ? HEAD_SIZE[id] || 0 : 0, italic: fake && id === 'Quote' };
  let ppr = hasStyle ? `<w:pStyle w:val="${id}"/>` : '';
  if (fake && HEAD_SIZE[id]) ppr += '<w:keepNext/>';
  if (ctx.track) ppr += `<w:rPr><w:ins w:id="${ctx.nextId()}" w:author="${AUTHOR}" w:date="${ctx.date}"/></w:rPr>`;
  const body = runs(bullet + text, rpr);
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
  const stylesXml = zip.has('word/styles.xml') ? await zip.text('word/styles.xml') : '';
  const styles = new Set([...String(stylesXml).matchAll(/<w:style\b[^>]*\bw:styleId="([^"]+)"/g)].map((m) => m[1]));
  return { xml, styles, entries: centralEntries(buf) };
}

function replaceDocument(entries, xml) {
  let found = false;
  const out = entries.map((e) => { if (e.name === 'word/document.xml') { found = true; return { name: e.name, data: Buffer.from(xml, 'utf8') }; } return e; });
  if (!found) throw damaged();
  return buildZip(out);
}

// What the fallback does to an existing document: { insert: { at, heading, text, style } } or { table: { at, heading, rows } }, optionally tracked.
async function editDocx(buf, op, { track = false, now = () => new Date() } = {}) {
  const { xml, styles, entries } = await openForEdit(buf);
  const body = bodyOf(xml);
  const nextId = makeIds(xml);
  const ctx = { styles, track, nextId, date: now().toISOString().replace(/\.\d+Z$/, 'Z') };
  let piece; let summary;
  if (op.insert) {
    const lines = String(op.insert.text).split(/\r\n|\r|\n/);
    while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    piece = lines.map((l) => paragraphXml(l, op.insert.style, ctx)).join('');
    summary = { paragraphs: lines.length };
  } else if (op.table) {
    piece = tableXml(op.table.rows, ctx);
    summary = { rows: op.table.rows.length, columns: op.table.rows[0].length };
  } else throw new WordError('That change needs Microsoft Word.');
  const at = position(xml, body, op.insert || op.table);
  const next = xml.slice(0, at) + piece + xml.slice(at);
  return { buf: replaceDocument(entries, next), ...summary, tracked: track };
}

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
function styleXml(id, name, extra = '') { return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>${extra}</w:style>`; }
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

module.exports = { readDocx, editDocx, newDocx, buildZip, centralEntries, crc32, AUTHOR };
