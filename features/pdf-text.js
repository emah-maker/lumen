// ---------- PDF text for the AI's read_pdf tool ----------
// A small, dependency-free text extractor (Node zlib only): it finds the objects in the file (plain
// and inside object streams), walks the page tree, and reads the text-showing operators of each
// page's content streams, decoding strings through the font's ToUnicode map when it has one.
// It covers the ordinary "text PDF"; scanned pages (images), encrypted files and exotic encodings
// come back empty or refused with a plain message. The text is untrusted page content: agent.js
// wraps it and treats it like read_page output. Also here: the page-range parser, the file name
// shown on the approval card, and the per-chat permission gate (pure, so test/units.js covers it).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { fileURLToPath } = require('url');

const MAX_BYTES = 50 * 1024 * 1024; // larger files are refused
const MAX_CHARS = 30000; // text returned per call; the rest is offered as "next pages"
const MAX_PAGES = 5000;

class PdfError extends Error {}

// ---- objects ----
const WS = /\s/;

// The value of `/Key` in a dictionary's text: a balanced << >> or [ ], a "n g R" reference, a name,
// a number or a (string). '' when the key is absent.
function valueOf(dict, key) {
  const re = new RegExp(`/${key}(?![A-Za-z0-9_.#-])`);
  const m = re.exec(dict);
  if (!m) return '';
  let i = m.index + m[0].length;
  while (i < dict.length && WS.test(dict[i])) i++;
  const start = i;
  if (dict.startsWith('<<', i) || dict[i] === '[') {
    let depth = 0;
    for (; i < dict.length; i++) {
      if (dict.startsWith('<<', i) || dict[i] === '[') { depth++; if (dict[i] === '<') i++; }
      else if (dict.startsWith('>>', i) || dict[i] === ']') { depth--; if (dict[i] === '>') i++; if (depth === 0) return dict.slice(start, i + 1); }
    }
    return dict.slice(start);
  }
  const ref = /^(\d+)\s+(\d+)\s+R\b/.exec(dict.slice(i, i + 40));
  if (ref) return ref[0];
  const token = /^(\/[^\s/<>[\]()]*|[^\s/<>[\]()]+|\((?:\\.|[^\\)])*\))/.exec(dict.slice(i, i + 400));
  return token ? token[0] : '';
}
const refsIn = (text) => [...String(text).matchAll(/(\d+)\s+\d+\s+R\b/g)].map((m) => Number(m[1]));

function inflate(data) {
  try { return zlib.inflateSync(data); } catch {}
  try { return zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch {}
  return null;
}

// obj number -> { dict: string, data: Buffer|null (decoded stream) }
function parseObjects(buf) {
  const s = buf.toString('latin1');
  if (!s.includes('%PDF-')) throw new PdfError('This is not a PDF file.');
  const objects = new Map();
  const streams = [];
  const re = /(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const num = Number(m[1]);
    const from = m.index + m[0].length;
    const streamAt = s.indexOf('stream', from);
    const endAt = s.indexOf('endobj', from);
    let dict;
    let data = null;
    if (streamAt !== -1 && (endAt === -1 || streamAt < endAt)) {
      dict = s.slice(from, streamAt);
      let dataStart = streamAt + 6;
      if (s[dataStart] === '\r') dataStart++;
      if (s[dataStart] === '\n') dataStart++;
      let dataEnd = s.indexOf('endstream', dataStart);
      if (dataEnd === -1) dataEnd = s.length;
      const raw = buf.subarray(dataStart, dataEnd);
      const filter = valueOf(dict, 'Filter');
      if (!filter) data = raw;
      else if (/^\[?\s*\/(FlateDecode|Fl)\s*\]?$/.test(filter)) data = inflate(raw);
      re.lastIndex = Math.max(re.lastIndex, dataEnd);
    } else {
      dict = s.slice(from, endAt === -1 ? s.length : endAt);
    }
    objects.set(num, { dict, data });
    if (data && /\/Type\s*\/ObjStm/.test(dict)) streams.push(num);
  }
  for (const num of streams) { // objects packed into object streams
    const { dict, data } = objects.get(num);
    const n = Number(valueOf(dict, 'N'));
    const first = Number(valueOf(dict, 'First'));
    const text = data.toString('latin1');
    const nums = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let k = 0; k < n && k * 2 + 1 < nums.length; k++) {
      const begin = first + nums[k * 2 + 1];
      const end = k + 1 < n ? first + nums[k * 2 + 3] : text.length;
      if (!objects.has(nums[k * 2])) objects.set(nums[k * 2], { dict: text.slice(begin, end), data: null });
    }
  }
  if (/\/Encrypt\b/.test(s.slice(-4096)) || [...objects.values()].some((o) => !o.data && /\/Filter\s*\/Standard/.test(o.dict))) {
    throw new PdfError('This PDF is encrypted, so its text cannot be read.');
  }
  return objects;
}

// ---- pages ----
function pageList(objects) {
  let root = null;
  for (const [num, o] of objects) if (/\/Type\s*\/Catalog\b/.test(o.dict)) root = num;
  const pagesRef = root === null ? null : refsIn(valueOf(objects.get(root).dict, 'Pages'))[0];
  const pages = [];
  const seen = new Set();
  const walk = (num, inherited) => {
    if (seen.has(num) || pages.length >= MAX_PAGES || !objects.has(num)) return;
    seen.add(num);
    const { dict } = objects.get(num);
    const resources = valueOf(dict, 'Resources') || inherited;
    const kids = valueOf(dict, 'Kids');
    if (kids && !/\/Type\s*\/Page\b(?!s)/.test(dict)) for (const kid of refsIn(kids)) walk(kid, resources);
    else pages.push({ num, dict, resources });
  };
  if (pagesRef !== null && pagesRef !== undefined) walk(pagesRef, '');
  else { // damaged file: no catalog; take every page object in file order
    for (const [num, o] of objects) if (/\/Type\s*\/Page\b(?!s)/.test(o.dict)) pages.push({ num, dict: o.dict, resources: valueOf(o.dict, 'Resources') });
  }
  return pages;
}

const resolveDict = (objects, value) => {
  const ref = /^(\d+)\s+\d+\s+R$/.exec(String(value).trim());
  return ref ? objects.get(Number(ref[1]))?.dict || '' : String(value);
};

// ToUnicode CMap -> { map: Map(code -> string), twoByte }
function parseCMap(text) {
  const map = new Map();
  let twoByte = /<0000>\s*<FFFF>/i.test(text);
  const u16 = (hex) => { let out = ''; for (let i = 0; i + 3 < hex.length + 1 && i < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4).padEnd(4, '0'), 16)); return out; };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) { map.set(parseInt(p[1], 16), u16(p[2])); if (p[1].length > 2) twoByte = true; }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(p[1], 16);
      const hi = Math.min(parseInt(p[2], 16), lo + 65535);
      if (p[1].length > 2) twoByte = true;
      if (p[3] !== undefined) {
        const base = u16(p[3]);
        for (let c = lo; c <= hi; c++) map.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo)));
      } else {
        [...p[4].matchAll(/<([0-9a-fA-F]*)>/g)].forEach((q, k) => { if (lo + k <= hi) map.set(lo + k, u16(q[1])); });
      }
    }
  }
  return { map, twoByte };
}

function fontsOf(objects, resources, cache) {
  const fonts = new Map();
  const dict = resolveDict(objects, resources);
  const fontDict = resolveDict(objects, valueOf(dict, 'Font'));
  for (const m of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
    const num = Number(m[2]);
    if (!cache.has(num)) {
      const fdict = objects.get(num)?.dict || '';
      const tu = refsIn(valueOf(fdict, 'ToUnicode'))[0];
      const cmap = tu !== undefined && objects.get(tu)?.data ? parseCMap(objects.get(tu).data.toString('latin1')) : null;
      cache.set(num, cmap || { map: null, twoByte: /\/Subtype\s*\/Type0/.test(fdict) });
    }
    fonts.set(m[1], cache.get(num));
  }
  return fonts;
}

// ---- content streams ----
function unescapeString(raw) {
  const bytes = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { bytes.push(c.charCodeAt(0)); continue; }
    const n = raw[++i];
    if (n === undefined) break;
    if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(raw[i + 1] || '')) oct += raw[++i];
      bytes.push(parseInt(oct, 8) & 255);
    } else if (n === '\r') { if (raw[i + 1] === '\n') i++; }
    else if (n !== '\n') bytes.push({ n: 10, r: 13, t: 9, b: 8, f: 12 }[n] ?? n.charCodeAt(0));
  }
  return bytes;
}

function decodeBytes(bytes, font) {
  if (font?.map?.size || font?.twoByte) {
    const step = font.twoByte ? 2 : 1;
    let out = '';
    for (let i = 0; i + step <= bytes.length; i += step) {
      const code = step === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
      const mapped = font.map?.get(code);
      if (mapped !== undefined) out += mapped;
      else if (!font.map && step === 2 && code >= 32 && code < 0xd800) out += String.fromCharCode(code);
      else if (step === 1 && code >= 32) out += String.fromCharCode(code);
    }
    return out;
  }
  let out = '';
  for (const b of bytes) if (b >= 32 || b === 9) out += String.fromCharCode(b);
  return out;
}

function pageText(content, fonts) {
  const s = content.toString('latin1');
  let out = '';
  let font = null;
  const operands = [];
  let i = 0;
  const newline = () => { if (out && !out.endsWith('\n')) out += '\n'; };
  const show = (bytes) => { out += decodeBytes(bytes, font); };
  while (i < s.length) {
    const c = s[i];
    if (WS.test(c)) { i++; continue; }
    if (c === '(') {
      let depth = 1;
      let j = i + 1;
      for (; j < s.length && depth; j++) {
        if (s[j] === '\\') j++;
        else if (s[j] === '(') depth++;
        else if (s[j] === ')') depth--;
      }
      operands.push({ str: unescapeString(s.slice(i + 1, j - 1)) });
      i = j;
    } else if (c === '<' && s[i + 1] !== '<') {
      const j = s.indexOf('>', i);
      const hex = s.slice(i + 1, j === -1 ? s.length : j).replace(/\s+/g, '');
      const bytes = [];
      for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16));
      operands.push({ str: bytes });
      i = j === -1 ? s.length : j + 1;
    } else if (c === '<' || c === '>') { i += s[i + 1] === c ? 2 : 1; }
    else if (c === '[') { operands.push({ open: true }); i++; }
    else if (c === ']') {
      const at = operands.map((o) => o.open).lastIndexOf(true);
      const items = operands.splice(at < 0 ? 0 : at);
      operands.push({ array: items.slice(1) });
      i++;
    } else if (c === '/') {
      const m = /^\/[^\s/<>[\]()]*/.exec(s.slice(i, i + 200));
      operands.push({ name: m[0].slice(1) });
      i += m[0].length;
    } else if (c === '%') { const j = s.indexOf('\n', i); i = j === -1 ? s.length : j + 1; }
    else {
      const m = /^[^\s/<>[\]()%]+/.exec(s.slice(i, i + 200));
      const tok = m ? m[0] : s[i];
      i += tok.length || 1;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) { operands.push({ num: Number(tok) }); continue; }
      switch (tok) {
        case 'Tf': font = fonts.get(operands[operands.length - 2]?.name) || null; break;
        case 'Tj': if (operands.at(-1)?.str) show(operands.at(-1).str); break;
        case "'": newline(); if (operands.at(-1)?.str) show(operands.at(-1).str); break;
        case '"': newline(); if (operands.at(-1)?.str) show(operands.at(-1).str); break;
        case 'TJ':
          for (const item of operands.at(-1)?.array || []) {
            if (item.str) show(item.str);
            else if (item.num !== undefined && item.num < -200 && out && !/[\s]$/.test(out)) out += ' ';
          }
          break;
        case 'Td': case 'TD': if (operands.at(-1)?.num) newline(); else if (out && !/\s$/.test(out)) out += ' '; break;
        case 'T*': case 'ET': newline(); break;
        case 'Tm': if (out && !/\s$/.test(out)) out += ' '; break;
        default: break;
      }
      operands.length = 0;
    }
    if (operands.length > 512) operands.splice(0, operands.length - 64);
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// "3", "2-5", "4-" (to the end), "1-3,7" -> sorted unique 1-based page numbers within [1, total].
function parsePageRange(spec, total) {
  if (spec === undefined || spec === null || String(spec).trim() === '') return Array.from({ length: total }, (_, k) => k + 1);
  const wanted = new Set();
  for (const part of String(spec).split(',')) {
    const m = /^\s*(\d+)?\s*(-)?\s*(\d+)?\s*$/.exec(part);
    if (!m || (!m[1] && !m[3])) throw new PdfError(`Bad page range "${String(spec).slice(0, 40)}". Use e.g. "1-5", "3" or "4-".`);
    const lo = m[1] ? Number(m[1]) : 1;
    const hi = m[2] ? (m[3] ? Number(m[3]) : total) : lo;
    for (let p = Math.max(1, lo); p <= Math.min(total, hi); p++) wanted.add(p);
  }
  return [...wanted].sort((a, b) => a - b);
}

// -> { numPages, pages: [n…], text, truncated, next } (next: first page not returned, or null)
function extractPdfText(buf, { pages: spec, maxChars = MAX_CHARS } = {}) {
  const objects = parseObjects(buf);
  const list = pageList(objects);
  if (!list.length) throw new PdfError('No pages were found in this PDF.');
  const wanted = parsePageRange(spec, list.length);
  if (!wanted.length) throw new PdfError(`This PDF has ${list.length} page${list.length === 1 ? '' : 's'}; that range has none.`);
  const cache = new Map();
  const parts = [];
  const done = [];
  let used = 0;
  let truncated = false;
  let next = null;
  for (const n of wanted) {
    const page = list[n - 1];
    const contents = refsIn(valueOf(page.dict, 'Contents')).map((num) => objects.get(num)?.data).filter(Boolean);
    const body = contents.length ? pageText(Buffer.concat(contents.flatMap((c) => [c, Buffer.from('\n')])), fontsOf(objects, page.resources, cache)) : '';
    const block = `--- Page ${n} of ${list.length} ---\n${body || '(no text on this page; it may be a scan or an image)'}`;
    if (used + block.length > maxChars) {
      truncated = true;
      if (!done.length) { parts.push(`${block.slice(0, maxChars)}…`); done.push(n); next = wanted.find((p) => p > n) ?? null; }
      else next = n;
      break;
    }
    parts.push(block);
    done.push(n);
    used += block.length + 2;
  }
  return { numPages: list.length, pages: done, text: parts.join('\n\n'), truncated, next };
}

// ---- what the approval card and result say about the file ----
// The file name only, never a folder: "report.pdf". Control characters removed, length capped.
function pdfName(url) {
  let name = '';
  try {
    const u = new URL(url);
    name = u.protocol === 'file:' ? path.basename(fileURLToPath(u)) : decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
  } catch {}
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  return name || 'this PDF';
}
// The key a permission is remembered under: the address without query or fragment.
function pdfKey(url) {
  try { const u = new URL(url); u.hash = ''; u.search = ''; return u.href; } catch { return String(url || ''); }
}

// ---- per-chat permission ----
// `holder` is what lives as long as the chat (agent.js taintHolder: the chat's messages array, else
// the task scope or MCP session); `holder.pdfAllowed` remembers the PDFs the user allowed. `ask` shows
// the card ("Allow the AI to read <name>?") and resolves true or false. A denial is not remembered.
async function requirePdfPermission(holder, url, ask) {
  const key = pdfKey(url);
  const allowed = holder ? (holder.pdfAllowed ||= new Set()) : new Set();
  if (allowed.has(key)) return true;
  if (!(await ask(pdfName(url)))) return false;
  allowed.add(key);
  return true;
}

// The PDF's bytes: a local file read from disk, a web PDF fetched with the tab's session (its
// cookies, as the viewer did). Errors never carry the local path.
async function loadPdfBytes(session, url) {
  if (/^file:/i.test(url)) {
    try {
      const file = fileURLToPath(url);
      if ((await fs.promises.stat(file)).size > MAX_BYTES) throw new PdfError('This PDF is too large to read (over 50 MB).');
      return await fs.promises.readFile(file);
    } catch (err) {
      throw err instanceof PdfError ? err : new PdfError('The PDF file could not be read (it may have been moved or deleted).');
    }
  }
  const res = await session.fetch(url, { credentials: 'include', signal: AbortSignal.timeout(30000) }).catch(() => null);
  if (!res || !res.ok) throw new PdfError('The PDF could not be downloaded.');
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body || []) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new PdfError('This PDF is too large to read (over 50 MB).');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

module.exports = { extractPdfText, loadPdfBytes, parsePageRange, pdfName, pdfKey, requirePdfPermission, PdfError, MAX_BYTES, MAX_CHARS };
