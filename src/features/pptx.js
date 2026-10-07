// ---------- PowerPoint (.pptx) decks: the slide viewer's model and the AI's slide text ----------
// A small, dependency-free reader (Node zlib only), like pdf-text.js: a .pptx is a zip of XML parts.
// It reads the zip's central directory, inflates only the parts it needs, and walks
// ppt/presentation.xml (slide size and order), each slide with its layout and master (placeholder
// positions, text styles, backgrounds, the master's and layout's own shapes), and the theme (colors
// and fonts). The result is plain JSON: positions in EMU, colors as #rrggbb, text as plain strings,
// pictures as data: URLs of the image types Chromium shows. Nothing in it is HTML, nothing is fetched,
// and linked (external) pictures are left out. renderer/slides.js draws it with DOM calls only.
//
// Limits, so a hostile file can't take the browser down: the file size, the total of everything
// inflated (MAX_UNCOMPRESSED: a zip bomb stops there), the number of zip entries, slides, shapes per
// slide, XML nodes and depth, and the bytes of pictures handed to the page.
// Fidelity is "readable": text boxes, pictures, solid and gradient fills, simple shapes, lines and
// tables in the right places. Charts, SmartArt, equations, EMF/WMF pictures, animations and effects
// are not drawn (a labelled box stands in for charts and diagrams).
const zlib = require('zlib');
const { promisify } = require('util');

const inflateRaw = promisify(zlib.inflateRaw);

const MAX_FILE_BYTES = 300 * 1024 * 1024;
const MAX_UNCOMPRESSED = 200 * 1024 * 1024; // everything inflated from one deck, pictures included
const MAX_ENTRIES = 20000;
const MAX_SLIDES = 1000;
const MAX_SHAPES = 3000; // per slide, layout and master shapes included
const MAX_NODES = 1500000; // per XML part
const MAX_DEPTH = 256;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024; // one picture
const MAX_MEDIA_BYTES = 150 * 1024 * 1024; // all pictures handed to the page
const EMU_PER_PT = 12700;
const DEFAULT_SIZE = { width: 12192000, height: 6858000 }; // 16:9, 13.333 x 7.5 in

class PptxError extends Error {}
const damaged = () => new PptxError('This file is not a PowerPoint presentation, or it is damaged.');
const tooBig = () => new PptxError('This presentation is too large to open here.');

// ---- zip ----
function readCentralDirectory(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw damaged();
  if (buf.length > MAX_FILE_BYTES) throw tooBig();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw damaged();
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new PptxError('This presentation uses a zip format Lumen cannot read (zip64).');
  if (count > MAX_ENTRIES) throw tooBig();
  const entries = new Map();
  let p = cdOffset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw damaged();
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/').replace(/^\/+/, '');
    entries.set(name.toLowerCase(), { name, method, compressed, local, encrypted: Boolean(flags & 1) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Reads parts by name (case-insensitive, as OOXML part names are). Every inflated byte counts against
// one budget: past it the deck is refused, so a small file can't expand into gigabytes.
function createZipReader(buf, { maxBytes = MAX_UNCOMPRESSED } = {}) {
  const entries = readCentralDirectory(buf);
  if (!entries.has('ppt/presentation.xml')) {
    if (entries.has('encryptedpackage') || [...entries.keys()].some((k) => k.includes('encryptedpackage'))) throw new PptxError('This presentation is password-protected.');
    throw damaged();
  }
  let used = 0;
  const texts = new Map();
  async function bytes(name) {
    const e = entries.get(String(name).toLowerCase());
    if (!e) return null;
    if (e.encrypted) throw new PptxError('This presentation is password-protected.');
    const at = e.local;
    if (at + 30 > buf.length || buf.readUInt32LE(at) !== 0x04034b50) throw damaged();
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    if (start + e.compressed > buf.length) throw damaged();
    const raw = buf.subarray(start, start + e.compressed);
    const room = maxBytes - used;
    let out;
    if (e.method === 0) {
      if (raw.length > room) throw tooBig();
      out = raw;
    } else if (e.method === 8) {
      if (room <= 0) throw tooBig();
      try { out = await inflateRaw(raw, { maxOutputLength: room }); } catch (err) {
        if (err && (err.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError)) throw tooBig();
        throw damaged();
      }
    } else {
      throw new PptxError('This presentation uses a compression Lumen cannot read.');
    }
    used += out.length;
    return out;
  }
  async function text(name) {
    const key = String(name).toLowerCase();
    if (texts.has(key)) return texts.get(key);
    const b = await bytes(name);
    const s = b ? b.toString('utf8').replace(/^\uFEFF/, '') : null;
    texts.set(key, s);
    return s;
  }
  return { bytes, text, has: (name) => entries.has(String(name).toLowerCase()), used: () => used };
}

// ---- XML ----
// Elements by local name (the prefix dropped: decks use p:, a:, r:, but not always those letters);
// attributes keep their full names. No DTDs (refused), no external entities, only the five named
// entities and character references.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_m, ref) => {
    if (ref[0] !== '#') return ENTITIES[ref];
    const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\uFFFD';
  });
}
const localName = (name) => { const i = name.indexOf(':'); return i === -1 ? name : name.slice(i + 1); };

function parseXml(src) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let nodes = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt === -1) break;
    if (lt > i && top !== root) top.text += decode(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e === -1 ? n : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt + 9); top.text += src.slice(lt + 9, e === -1 ? n : e); i = e === -1 ? n : e + 3; continue; }
    if (src.startsWith('<?', lt)) { const e = src.indexOf('?>', lt + 2); i = e === -1 ? n : e + 2; continue; }
    if (src[lt + 1] === '!') throw damaged(); // <!DOCTYPE …>: OOXML has none, and entity tricks start there
    if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt);
      const name = localName(src.slice(lt + 2, e === -1 ? n : e).trim());
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break; }
      i = e === -1 ? n : e + 1;
      continue;
    }
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(src[j])) j++;
    const node = { name: localName(src.slice(lt + 1, j)), attrs: {}, children: [], text: '' };
    let selfClose = false;
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (j >= n) break;
      if (src[j] === '>') { j++; break; }
      if (src[j] === '/' && src[j + 1] === '>') { selfClose = true; j += 2; break; }
      const a = j;
      while (j < n && !/[\s=/>]/.test(src[j])) j++;
      const attr = src.slice(a, j);
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] !== '=') { if (j === a) j++; continue; }
      j++;
      while (j < n && /\s/.test(src[j])) j++;
      const q = src[j];
      if (q !== '"' && q !== "'") continue;
      const e = src.indexOf(q, j + 1);
      if (e === -1) { j = n; break; }
      node.attrs[attr] = decode(src.slice(j + 1, e));
      j = e + 1;
    }
    if (++nodes > MAX_NODES) throw tooBig();
    top.children.push(node);
    if (!selfClose) {
      stack.push(node);
      if (stack.length > MAX_DEPTH) throw damaged();
    }
    i = j;
  }
  return root;
}

const kid = (node, name) => (node ? node.children.find((c) => c.name === name) || null : null);
const kids = (node, name) => (node ? node.children.filter((c) => c.name === name) : []);
const at = (node, ...names) => names.reduce((n, name) => kid(n, name), node);
// An attribute in the relationships namespace (r:id, r:embed): any prefix.
const relAttr = (node, local) => {
  if (!node) return null;
  for (const [k, v] of Object.entries(node.attrs)) if (k.includes(':') && localName(k) === local) return v;
  return null;
};
const num = (v, fallback = null) => { const x = Number(v); return v !== undefined && v !== null && v !== '' && Number.isFinite(x) ? x : fallback; };
const bool = (v) => v === '1' || v === 'true';
function* walk(node) {
  for (const c of node.children) { yield c; yield* walk(c); }
}

// ---- parts and relationships ----
const dirOf = (part) => part.slice(0, part.lastIndexOf('/') + 1);
function resolvePart(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const out = dirOf(base).split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return out.join('/');
}
const relsPathOf = (part) => `${dirOf(part)}_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`;
async function loadRels(zip, part) {
  const xml = await zip.text(relsPathOf(part));
  const rels = new Map();
  if (!xml) return rels;
  for (const r of kids(kid(parseXml(xml), 'Relationships'), 'Relationship')) {
    const id = r.attrs.Id;
    const target = r.attrs.Target || '';
    if (!id) continue;
    const external = r.attrs.TargetMode === 'External';
    rels.set(id, { type: String(r.attrs.Type || '').split('/').pop(), target: external ? null : resolvePart(part, decodeURIComponent(target.split('#')[0])), external });
  }
  return rels;
}
const relOfType = (rels, type) => [...rels.values()].find((r) => r.type === type && r.target) || null;

// ---- colors ----
const PRESET = { black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00', gray: '808080', grey: '808080', darkGray: 'a9a9a9', lightGray: 'd3d3d3', orange: 'ffa500', purple: '800080', navy: '000080', teal: '008080', maroon: '800000', silver: 'c0c0c0', cyan: '00ffff', magenta: 'ff00ff' };
const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
function toHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function fromHsl([h, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
const SCHEME_ALIAS = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };
// The color in a fill-like element (one with srgbClr / schemeClr / … as a child): { color: '#rrggbb', alpha } or null.
function colorIn(node, ctx) {
  if (!node) return null;
  for (const c of node.children) {
    let base = null;
    if (c.name === 'srgbClr') base = /^[0-9a-fA-F]{6}$/.test(c.attrs.val || '') ? c.attrs.val : null;
    else if (c.name === 'sysClr') base = /^[0-9a-fA-F]{6}$/.test(c.attrs.lastClr || '') ? c.attrs.lastClr : c.attrs.val === 'window' ? 'ffffff' : '000000';
    else if (c.name === 'prstClr') base = PRESET[c.attrs.val] || '000000';
    else if (c.name === 'scrgbClr') base = [c.attrs.r, c.attrs.g, c.attrs.b].map((v) => hex2((num(v, 0) / 100000) * 255)).join('');
    else if (c.name === 'hslClr') base = fromHsl([num(c.attrs.hue, 0) / 21600000, num(c.attrs.sat, 0) / 100000, num(c.attrs.lum, 0) / 100000]).map(hex2).join('');
    else if (c.name === 'schemeClr') {
      const val = c.attrs.val;
      if (val === 'phClr') base = ctx.phClr ? ctx.phClr.color.slice(1) : null;
      else {
        const mapped = SCHEME_ALIAS[val] ? (ctx.clrMap?.[val] || SCHEME_ALIAS[val]) : val;
        base = ctx.theme?.colors?.[mapped] || null;
      }
    } else continue;
    if (!base) return null;
    let rgb = [0, 2, 4].map((k) => parseInt(base.slice(k, k + 2), 16));
    let alpha = c.name === 'schemeClr' && c.attrs.val === 'phClr' && ctx.phClr ? ctx.phClr.alpha : 1;
    for (const m of c.children) {
      const v = num(m.attrs.val, 0) / 100000;
      if (m.name === 'alpha') alpha = v;
      else if (m.name === 'lumMod' || m.name === 'lumOff') { const hsl = toHsl(rgb); hsl[2] = m.name === 'lumMod' ? hsl[2] * v : hsl[2] + v; hsl[2] = Math.max(0, Math.min(1, hsl[2])); rgb = fromHsl(hsl); }
      else if (m.name === 'satMod') { const hsl = toHsl(rgb); hsl[1] = Math.max(0, Math.min(1, hsl[1] * v)); rgb = fromHsl(hsl); }
      else if (m.name === 'tint') rgb = rgb.map((x) => x + (255 - x) * (1 - v));
      else if (m.name === 'shade') rgb = rgb.map((x) => x * v);
    }
    return { color: `#${rgb.map(hex2).join('')}`, alpha: Math.max(0, Math.min(1, alpha)) };
  }
  return null;
}

// ---- fills ----
// From an spPr / bgPr / tcPr: { type: 'none' } | { type: 'solid', color, alpha } | { type: 'gradient', angle, stops } |
// { type: 'image', image } | null (none given: inherited or from the shape's style).
function fillIn(node, ctx) {
  if (!node) return null;
  for (const c of node.children) {
    if (c.name === 'noFill') return { type: 'none' };
    if (c.name === 'solidFill') { const col = colorIn(c, ctx); return col ? { type: 'solid', ...col } : null; }
    if (c.name === 'gradFill') {
      const stops = kids(kid(c, 'gsLst'), 'gs').map((gs) => ({ pos: Math.max(0, Math.min(100, num(gs.attrs.pos, 0) / 1000)), ...(colorIn(gs, ctx) || { color: '#ffffff', alpha: 1 }) })).sort((a, b) => a.pos - b.pos).slice(0, 10);
      if (!stops.length) return null;
      const lin = kid(c, 'lin');
      return { type: 'gradient', angle: lin ? num(lin.attrs.ang, 0) / 60000 : 90, radial: Boolean(kid(c, 'path')), stops };
    }
    if (c.name === 'pattFill') { const col = colorIn(kid(c, 'fgClr'), ctx); return col ? { type: 'solid', ...col } : null; }
    if (c.name === 'blipFill') { const image = blipImage(c, ctx); return image ? { type: 'image', image } : null; }
  }
  return null;
}
function blipImage(blipFill, ctx) {
  const blip = kid(blipFill, 'blip');
  const rid = relAttr(blip, 'embed');
  const rel = rid ? ctx.rels.get(rid) : null;
  if (!rel || !rel.target) return null;
  ctx.media.add(rel.target);
  return rel.target;
}
function lineIn(spPr, ctx) {
  const ln = kid(spPr, 'ln');
  if (!ln) return null;
  if (kid(ln, 'noFill')) return { type: 'none' };
  const solid = kid(ln, 'solidFill') || kid(ln, 'gradFill');
  const col = solid ? colorIn(solid.name === 'solidFill' ? solid : kid(kid(solid, 'gsLst'), 'gs'), ctx) : null;
  const width = num(ln.attrs.w, null);
  if (!col && width === null) return null;
  const dash = kid(ln, 'prstDash')?.attrs.val;
  return { type: 'line', ...(col || {}), width: width === null ? null : Math.max(0.25, width / EMU_PER_PT), dash: dash && dash !== 'solid' ? 'dashed' : null, head: kid(ln, 'headEnd')?.attrs.type || null, tail: kid(ln, 'tailEnd')?.attrs.type || null };
}
// The fill and line a shape's p:style gives when its spPr says nothing (fillRef / lnRef idx 0 means none).
function styleRefs(styleNode, ctx) {
  const ref = (name) => {
    const r = kid(styleNode, name);
    if (!r) return null;
    const col = colorIn(r, ctx);
    return { idx: num(r.attrs.idx, 0), ...(col || {}) };
  };
  return { fill: ref('fillRef'), line: ref('lnRef'), font: ref('fontRef') };
}

// ---- geometry ----
function xfrmOf(node) {
  const x = node && kid(node, 'xfrm');
  const off = kid(x, 'off'); const ext = kid(x, 'ext');
  if (!off || !ext) return null;
  return {
    x: num(off.attrs.x, 0), y: num(off.attrs.y, 0), w: Math.max(0, num(ext.attrs.cx, 0)), h: Math.max(0, num(ext.attrs.cy, 0)),
    rot: num(x.attrs.rot, 0) / 60000, flipH: bool(x.attrs.flipH), flipV: bool(x.attrs.flipV),
    chOff: kid(x, 'chOff') ? { x: num(kid(x, 'chOff').attrs.x, 0), y: num(kid(x, 'chOff').attrs.y, 0) } : null,
    chExt: kid(x, 'chExt') ? { w: num(kid(x, 'chExt').attrs.cx, 0), h: num(kid(x, 'chExt').attrs.cy, 0) } : null,
  };
}
const applyT = (t, b) => ({ ...b, x: t.ox + b.x * t.sx, y: t.oy + b.y * t.sy, w: b.w * t.sx, h: b.h * t.sy });
const LINE_GEOMS = new Set(['line', 'straightConnector1', 'bentConnector2', 'bentConnector3', 'curvedConnector3']);
// Preset shapes drawn as a clip-path polygon (percent points); the rest are rectangles.
const POLYGONS = {
  triangle: '50% 0,100% 100%,0 100%', rtTriangle: '0 0,100% 100%,0 100%', diamond: '50% 0,100% 50%,50% 100%,0 50%',
  parallelogram: '25% 0,100% 0,75% 100%,0 100%', trapezoid: '25% 0,75% 0,100% 100%,0 100%', pentagon: '50% 0,100% 38%,82% 100%,18% 100%,0 38%',
  hexagon: '25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%', octagon: '29% 0,71% 0,100% 29%,100% 71%,71% 100%,29% 100%,0 71%,0 29%',
  rightArrow: '0 25%,70% 25%,70% 0,100% 50%,70% 100%,70% 75%,0 75%', leftArrow: '100% 25%,30% 25%,30% 0,0 50%,30% 100%,30% 75%,100% 75%',
  upArrow: '25% 100%,25% 30%,0 30%,50% 0,100% 30%,75% 30%,75% 100%', downArrow: '25% 0,75% 0,75% 70%,100% 70%,50% 100%,0 70%,25% 70%',
  chevron: '0 0,75% 0,100% 50%,75% 100%,0 100%,25% 50%', homePlate: '0 0,80% 0,100% 50%,80% 100%,0 100%',
  plus: '33% 0,67% 0,67% 33%,100% 33%,100% 67%,67% 67%,67% 100%,33% 100%,33% 67%,0 67%,0 33%,33% 33%',
  star5: '50% 0,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%',
};
function geometryOf(spPr) {
  const prst = kid(spPr, 'prstGeom')?.attrs.prst || (kid(spPr, 'custGeom') ? 'custom' : 'rect');
  if (prst === 'ellipse' || prst === 'circle' || prst === 'donut' || prst === 'pie' || prst === 'chord') return { geom: 'ellipse' };
  if (prst === 'roundRect' || prst === 'round2SameRect' || prst === 'snipRoundRect' || prst === 'flowChartAlternateProcess') {
    const adj = num(kid(kid(kid(spPr, 'prstGeom'), 'avLst'), 'gd')?.attrs.fmla?.replace(/^val\s+/, ''), 16667);
    return { geom: 'roundRect', radius: Math.max(0, Math.min(50000, adj)) / 100000 };
  }
  if (POLYGONS[prst]) return { geom: 'polygon', points: POLYGONS[prst] };
  if (LINE_GEOMS.has(prst)) return { geom: 'line' };
  return { geom: 'rect' };
}

// ---- text ----
const TITLE_TYPES = new Set(['title', 'ctrTitle']);
const OTHER_TYPES = new Set(['dt', 'ftr', 'sldNum', 'hdr']);
const levelProps = (lstStyle, level) => kid(lstStyle, `lvl${level + 1}pPr`);
const safeFont = (name, theme) => {
  let f = String(name || '');
  if (f === '+mj-lt' || f === '+mj-ea') f = theme?.majorFont || '';
  else if (f === '+mn-lt' || f === '+mn-ea') f = theme?.minorFont || '';
  f = f.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 64);
  return f || null;
};

// The first value `get(pPr)` gives along the chain: the paragraph's own pPr, then each list style's
// level (the shape's, the layout and master placeholders', the master's text style, the deck's default).
function inherit(chain, own, level, get) {
  if (own) { const v = get(own); if (v !== undefined && v !== null) return v; }
  for (const lst of chain) { const p = levelProps(lst, level); if (p) { const v = get(p); if (v !== undefined && v !== null) return v; } }
  return null;
}
const rPrVal = (key) => (pPr) => { const r = kid(pPr, 'defRPr'); return r ? r.attrs[key] : undefined; };
function spacing(node) {
  if (!node) return null;
  const pct = kid(node, 'spcPct'); const pts = kid(node, 'spcPts');
  if (pct) return { pct: num(pct.attrs.val, 100000) / 100000 };
  if (pts) return { pt: num(pts.attrs.val, 0) / 100 };
  return null;
}

// `colorChain`: where a run's color is looked up (a shape style's font color beats the deck's default text style).
function textBody(txBody, { chain, colorChain = chain, ctx, fontColor, scale = 1, lineReduce = 0, category }) {
  const paragraphs = [];
  let autoNum = new Map();
  for (const p of kids(txBody, 'p')) {
    const pPr = kid(p, 'pPr');
    const level = Math.max(0, Math.min(8, num(pPr?.attrs.lvl, 0)));
    const get = (fn) => inherit(chain, pPr, level, fn);
    const runs = [];
    for (const r of p.children) {
      if (r.name !== 'r' && r.name !== 'fld' && r.name !== 'br') continue;
      if (r.name === 'br') { runs.push({ text: '\n' }); continue; }
      const rPr = kid(r, 'rPr');
      const pick = (key) => (rPr && rPr.attrs[key] !== undefined ? rPr.attrs[key] : get(rPrVal(key)));
      const fillOwn = rPr && (kid(rPr, 'solidFill') || kid(rPr, 'gradFill'));
      let col = fillOwn ? colorIn(fillOwn.name === 'solidFill' ? fillOwn : kid(kid(fillOwn, 'gsLst'), 'gs'), ctx) : null;
      if (!col) col = inherit(colorChain, pPr, level, (pp) => { const f = kid(kid(pp, 'defRPr'), 'solidFill'); return f ? colorIn(f, ctx) : undefined; }) || fontColor || null;
      const latin = (rPr && kid(rPr, 'latin')?.attrs.typeface) || get((pp) => kid(kid(pp, 'defRPr'), 'latin')?.attrs.typeface);
      const sz = num(pick('sz'), null);
      const u = pick('u');
      const strike = pick('strike');
      const baseline = num(pick('baseline'), 0);
      runs.push({
        text: String(at(r, 't')?.text ?? ''),
        size: (sz === null ? 18 : sz / 100) * scale,
        bold: bool(pick('b')), italic: bool(pick('i')),
        underline: Boolean(u && u !== 'none'), strike: Boolean(strike && strike !== 'noStrike'),
        caps: pick('cap') === 'all', color: col ? col.color : null, alpha: col ? col.alpha : 1,
        font: safeFont(latin, ctx.theme), baseline: baseline > 0 ? 'super' : baseline < 0 ? 'sub' : null,
      });
    }
    const endSz = num(kid(p, 'endParaRPr')?.attrs.sz, null) ?? num(get(rPrVal('sz')), null);
    const align = get((pp) => pp.attrs.algn);
    const marL = num(get((pp) => pp.attrs.marL), 0);
    const indent = num(get((pp) => pp.attrs.indent), 0);
    const hasText = runs.some((r) => r.text && r.text !== '\n');
    // Bullets: the paragraph's own, else what its list style gives (a body placeholder's • from the master).
    let bullet = null;
    const bu = get((pp) => (kid(pp, 'buNone') ? { none: true } : kid(pp, 'buChar') ? { char: kid(pp, 'buChar').attrs.char } : kid(pp, 'buAutoNum') ? { auto: kid(pp, 'buAutoNum').attrs.type || 'arabicPeriod', start: num(kid(pp, 'buAutoNum').attrs.startAt, 1) } : kid(pp, 'buBlip') ? { char: '•' } : undefined));
    if (bu && !bu.none && hasText && category !== 'title') {
      const buCol = get((pp) => (kid(pp, 'buClr') ? colorIn(kid(pp, 'buClr'), ctx) : undefined));
      if (bu.char) bullet = { text: String(bu.char).slice(0, 2), color: buCol?.color || null };
      else {
        const key = `${level}|${bu.auto}`;
        const n = autoNum.has(key) ? autoNum.get(key) + 1 : bu.start;
        autoNum.set(key, n);
        bullet = { text: autoNumber(bu.auto, n), color: buCol?.color || null };
      }
    }
    if (!bu || bu.none) autoNum = new Map([...autoNum].filter(([k]) => Number(k.split('|')[0]) < level));
    const lnSpc = spacing(get((pp) => kid(pp, 'lnSpc') || undefined));
    paragraphs.push({
      runs, level,
      align: { ctr: 'center', r: 'right', just: 'justify', dist: 'justify' }[align] || 'left',
      marL: marL / EMU_PER_PT, indent: indent / EMU_PER_PT, bullet,
      spaceBefore: spacing(get((pp) => kid(pp, 'spcBef') || undefined)),
      spaceAfter: spacing(get((pp) => kid(pp, 'spcAft') || undefined)),
      lineSpacing: lnSpc && lnSpc.pct ? { pct: Math.max(0.5, lnSpc.pct - lineReduce) } : lnSpc,
      emptySize: (endSz === null ? 18 : endSz / 100) * scale,
    });
  }
  return paragraphs;
}
function autoNumber(type, n) {
  const roman = (v) => { let out = ''; for (const [d, s] of [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]) while (v >= d) { out += s; v -= d; } return out; };
  const alpha = (v) => { let out = ''; while (v > 0) { v--; out = String.fromCharCode(97 + (v % 26)) + out; v = Math.floor(v / 26); } return out; };
  let s = /^roman/i.test(type) ? roman(n) : /^alpha/i.test(type) ? alpha(n) : String(n);
  if (/UcPeriod|Uc/.test(type)) s = s.toUpperCase();
  if (/ParenBoth/.test(type)) return `(${s})`;
  if (/ParenR/.test(type)) return `${s})`;
  if (/Plain$/.test(type)) return s;
  return `${s}.`;
}

// ---- placeholders ----
function phOf(nv) {
  const ph = at(nv, 'nvPr', 'ph');
  if (!ph) return null;
  return { type: ph.attrs.type || 'obj', idx: ph.attrs.idx !== undefined ? String(ph.attrs.idx) : null };
}
const nvOf = (node) => node.children.find((c) => /^nv\w*Pr$/.test(c.name)) || null;
function placeholdersIn(spTree) {
  const out = [];
  if (!spTree) return out;
  for (const node of walk(spTree)) {
    if (node.name !== 'sp' && node.name !== 'pic' && node.name !== 'graphicFrame') continue;
    const ph = phOf(nvOf(node));
    if (ph) out.push({ ph, node });
  }
  return out;
}
const masterType = (type) => (TITLE_TYPES.has(type) ? 'title' : OTHER_TYPES.has(type) ? type : 'body');
// The layout placeholder a slide's placeholder takes its place and styles from: by type for titles, else by idx, else by type.
function matchLayout(list, ph) {
  if (TITLE_TYPES.has(ph.type)) return list.find((x) => TITLE_TYPES.has(x.ph.type)) || null;
  if (ph.idx !== null) { const m = list.find((x) => x.ph.idx === ph.idx); if (m) return m; }
  return list.find((x) => x.ph.type === ph.type) || (ph.type === 'obj' ? list.find((x) => x.ph.type === 'body') : null) || null;
}
const matchMaster = (list, ph) => list.find((x) => x.ph.type === masterType(ph.type)) || list.find((x) => masterType(x.ph.type) === masterType(ph.type)) || null;

// ---- theme ----
function parseTheme(xml) {
  const theme = { colors: {}, majorFont: null, minorFont: null };
  if (!xml) return theme;
  const doc = parseXml(xml);
  const scheme = [...walk(doc)].find((n) => n.name === 'clrScheme');
  for (const c of scheme ? scheme.children : []) {
    const col = colorIn(c, { theme: { colors: {} } });
    if (col) theme.colors[c.name] = col.color.slice(1);
  }
  const fonts = [...walk(doc)].find((n) => n.name === 'fontScheme');
  theme.majorFont = at(fonts, 'majorFont', 'latin')?.attrs.typeface || null;
  theme.minorFont = at(fonts, 'minorFont', 'latin')?.attrs.typeface || null;
  return theme;
}

// ---- one part's shapes (a slide, its layout or its master) ----
// `part`: { kind, doc, rels, phs (its placeholders) }; `owner`: { layout, master } parts, for inheritance.
function drawTree(spTree, ctx, out, t = { ox: 0, oy: 0, sx: 1, sy: 1 }) {
  if (!spTree) return;
  for (const node of spTree.children) {
    if (out.length >= MAX_SHAPES) { ctx.warnings.add('Some shapes were left out: the slide has too many.'); return; }
    let el = node;
    if (el.name === 'AlternateContent') el = (kid(el, 'Fallback')?.children.find((c) => ['sp', 'pic', 'grpSp', 'graphicFrame', 'cxnSp'].includes(c.name))) || (kid(el, 'Choice')?.children.find((c) => ['sp', 'pic', 'grpSp', 'graphicFrame', 'cxnSp'].includes(c.name))) || null;
    if (!el) continue;
    if (el.name === 'grpSp') {
      const g = xfrmOf(kid(el, 'grpSpPr'));
      let inner = t;
      if (g) {
        const gsx = g.chExt && g.chExt.w ? g.w / g.chExt.w : 1;
        const gsy = g.chExt && g.chExt.h ? g.h / g.chExt.h : 1;
        const ch = g.chOff || { x: 0, y: 0 };
        inner = { ox: t.ox + (g.x - ch.x * gsx) * t.sx, oy: t.oy + (g.y - ch.y * gsy) * t.sy, sx: gsx * t.sx, sy: gsy * t.sy };
      }
      drawTree(el, ctx, out, inner);
    } else if (el.name === 'sp' || el.name === 'cxnSp' || el.name === 'pic' || el.name === 'graphicFrame') {
      const shape = drawShape(el, ctx);
      if (shape) out.push(applyT(t, shape));
    }
  }
}

function drawShape(node, ctx) {
  const nv = nvOf(node);
  const ph = phOf(nv);
  if (ph && ctx.kind !== 'slide') return null; // a layout's or master's placeholders are prompts ("Click to add title"), not content
  if (bool(at(nv, 'cNvPr')?.attrs.hidden)) return null;
  const layoutPh = ph && ctx.layout ? matchLayout(ctx.layout.phs, ph) : null;
  const masterPh = ph && ctx.master ? matchMaster(ctx.master.phs, layoutPh ? layoutPh.ph : ph) : null;
  const spPr = kid(node, 'spPr');
  const box = (node.name === 'graphicFrame' ? xfrmOf(node) : xfrmOf(spPr)) || xfrmOf(kid(layoutPh?.node, 'spPr')) || xfrmOf(kid(masterPh?.node, 'spPr')) || (node.name === 'graphicFrame' ? xfrmOf(layoutPh?.node) : null);
  if (!box) return null;
  const base = { x: box.x, y: box.y, w: box.w, h: box.h, rot: box.rot, flipH: box.flipH, flipV: box.flipV };
  const name = at(nv, 'cNvPr')?.attrs.name || '';

  if (node.name === 'pic') {
    const image = blipImage(kid(node, 'blipFill'), ctx);
    const src = at(node, 'blipFill', 'srcRect');
    const crop = src ? ['l', 't', 'r', 'b'].map((k) => Math.max(-1, Math.min(0.99, num(src.attrs[k], 0) / 100000))) : null;
    return { type: 'pic', ...base, image, crop: crop && crop.some(Boolean) ? crop : null, alt: String(at(nv, 'cNvPr')?.attrs.descr || '').slice(0, 300), line: lineIn(spPr, ctx), placeholder: ph?.type || null };
  }

  if (node.name === 'graphicFrame') {
    const data = at(node, 'graphic', 'graphicData');
    const uri = String(data?.attrs.uri || '');
    const tbl = kid(data, 'tbl');
    if (tbl) return { type: 'table', ...base, ...drawTable(tbl, ctx) };
    const pic = data ? [...walk(data)].find((n) => n.name === 'pic') : null;
    if (pic) { const p = drawShape(pic, ctx); if (p) return { ...p, x: base.x, y: base.y, w: base.w, h: base.h }; }
    const label = /chart/i.test(uri) ? 'Chart' : /diagram/i.test(uri) ? 'Diagram' : 'Object';
    return { type: 'placeholder', ...base, label: name ? `${label}: ${name.slice(0, 60)}` : label };
  }

  // sp / cxnSp
  const style = styleRefs(kid(node, 'style'), ctx);
  const geometry = geometryOf(spPr || kid(layoutPh?.node, 'spPr'));
  let fill = fillIn(spPr, ctx);
  if (!fill && style.fill && style.fill.idx > 0 && style.fill.color) fill = { type: 'solid', color: style.fill.color, alpha: style.fill.alpha };
  if (!fill && layoutPh && ctx.layout) fill = fillIn(kid(layoutPh?.node, 'spPr'), { ...ctx, rels: ctx.layout.rels }) || null;
  let line = lineIn(spPr, ctx);
  if ((!line || !line.color) && line?.type !== 'none' && style.line && style.line.idx > 0 && style.line.color) line = { type: 'line', width: 0.75, ...(line || {}), color: style.line.color, alpha: style.line.alpha };
  if (node.name === 'cxnSp' || geometry.geom === 'line') {
    return line && line.type !== 'none' && line.color ? { type: 'line', ...base, color: line.color, alpha: line.alpha ?? 1, width: line.width || 0.75, dash: line.dash, head: line.head, tail: line.tail } : null;
  }

  const shape = { type: 'shape', ...base, ...geometry, fill: fill && fill.type !== 'none' ? fill : null, line: line && line.type !== 'none' && line.color ? line : null, text: null, placeholder: ph?.type || null };
  const txBody = kid(node, 'txBody');
  if (txBody) {
    const category = ph ? (TITLE_TYPES.has(ph.type) ? 'title' : OTHER_TYPES.has(ph.type) ? 'other' : 'body') : 'other';
    const tx = ctx.master?.txStyles;
    const chain = [kid(txBody, 'lstStyle'), kid(kid(layoutPh?.node, 'txBody'), 'lstStyle'), kid(kid(masterPh?.node, 'txBody'), 'lstStyle'), ph ? kid(tx, category === 'title' ? 'titleStyle' : category === 'body' ? 'bodyStyle' : 'otherStyle') : null, ctx.defaultTextStyle].filter(Boolean);
    const bodyAttrs = { ...(kid(kid(masterPh?.node, 'txBody'), 'bodyPr')?.attrs || {}), ...(kid(kid(layoutPh?.node, 'txBody'), 'bodyPr')?.attrs || {}), ...(kid(txBody, 'bodyPr')?.attrs || {}) };
    const autofit = at(txBody, 'bodyPr', 'normAutofit');
    const scale = autofit ? num(autofit.attrs.fontScale, 100000) / 100000 : 1;
    const lineReduce = autofit ? num(autofit.attrs.lnSpcReduction, 0) / 100000 : 0;
    const styled = Boolean(style.font && style.font.color);
    const fontColor = styled ? { color: style.font.color, alpha: style.font.alpha } : colorIn({ children: [{ name: 'schemeClr', attrs: { val: 'tx1' }, children: [] }] }, ctx);
    const colorChain = styled ? chain.filter((x) => x !== ctx.defaultTextStyle) : chain;
    const paragraphs = textBody(txBody, { chain, colorChain, ctx, fontColor, scale, lineReduce, category });
    if (paragraphs.some((p) => p.runs.some((r) => r.text.trim()))) {
      const ins = (k, d) => num(bodyAttrs[k], d) / EMU_PER_PT;
      shape.text = {
        paragraphs,
        anchor: { t: 'top', ctr: 'middle', b: 'bottom', just: 'middle', dist: 'middle' }[bodyAttrs.anchor] || 'top',
        insets: [ins('lIns', 91440), ins('tIns', 45720), ins('rIns', 91440), ins('bIns', 45720)],
        wrap: bodyAttrs.wrap !== 'none',
        vert: bodyAttrs.vert === 'vert' || bodyAttrs.vert === 'eaVert' ? 'vert' : bodyAttrs.vert === 'vert270' ? 'vert270' : null,
        category,
      };
    }
  }
  if (!shape.fill && !shape.line && !shape.text) return null;
  return shape;
}

function drawTable(tbl, ctx) {
  const cols = kids(kid(tbl, 'tblGrid'), 'gridCol').map((c) => Math.max(0, num(c.attrs.w, 0)));
  const rows = [];
  const fontColor = colorIn({ children: [{ name: 'schemeClr', attrs: { val: 'tx1' }, children: [] }] }, ctx);
  for (const tr of kids(tbl, 'tr').slice(0, 500)) {
    const cells = [];
    for (const tc of kids(tr, 'tc').slice(0, 100)) {
      if (bool(tc.attrs.hMerge) || bool(tc.attrs.vMerge)) { cells.push(null); continue; }
      const tcPr = kid(tc, 'tcPr');
      const paragraphs = textBody(kid(tc, 'txBody'), { chain: [ctx.defaultTextStyle].filter(Boolean), ctx, fontColor, category: 'other' });
      const fill = fillIn(tcPr, ctx);
      cells.push({ paragraphs, fill: fill && fill.type !== 'none' && fill.type !== 'image' ? fill : null, colSpan: Math.max(1, num(tc.attrs.gridSpan, 1)), rowSpan: Math.max(1, num(tc.attrs.rowSpan, 1)), anchor: { ctr: 'middle', b: 'bottom' }[tcPr?.attrs.anchor] || 'top' });
    }
    rows.push({ h: Math.max(0, num(tr.attrs.h, 0)), cells });
  }
  return { cols, rows };
}

function backgroundOf(doc, ctx) {
  const bg = at(doc, 'cSld', 'bg');
  if (!bg) return null;
  const pr = kid(bg, 'bgPr');
  if (pr) return fillIn(pr, ctx);
  const ref = kid(bg, 'bgRef');
  const col = ref ? colorIn(ref, ctx) : null;
  return col ? { type: 'solid', ...col } : null;
}

// ---- plain text, for the AI and search ----
const paragraphsText = (paragraphs) => paragraphs.map((p) => `${p.bullet ? `${p.bullet.text} ` : ''}${p.runs.map((r) => r.text).join('')}`.replace(/[ \t]+$/g, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
function slideText(shapes) {
  const own = shapes.filter((s) => s.own);
  const order = [...own].sort((a, b) => (a.text?.category === 'title' ? -1 : 0) - (b.text?.category === 'title' ? -1 : 0) || Math.round(a.y / 50000) - Math.round(b.y / 50000) || a.x - b.x);
  const parts = [];
  for (const s of order) {
    if (s.text) { const t = paragraphsText(s.text.paragraphs); if (t) parts.push(t); }
    else if (s.type === 'table') parts.push(s.rows.map((r) => r.cells.filter(Boolean).map((c) => paragraphsText(c.paragraphs).replace(/\n/g, ' ')).join(' | ')).join('\n'));
    else if (s.type === 'pic' && s.alt) parts.push(`[Picture: ${s.alt}]`);
    else if (s.type === 'placeholder') parts.push(`[${s.label}]`);
  }
  return parts.join('\n\n');
}

// ---- media ----
function sniffImage(b) {
  if (!b || b.length < 4) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  const head = b.toString('utf8', 0, Math.min(b.length, 1024)).replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('<') && /<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null; // EMF, WMF, TIFF, …: Chromium can't show them
}

// ---- the deck ----
// opts.media: false skips reading pictures (the AI's text). Returns
// { width, height, slides: [{ number, hidden, background, shapes, notes, text }], media: { part: dataUrl | null }, warnings, truncated }
async function parsePptx(buf, { media: wantMedia = true, maxBytes = MAX_UNCOMPRESSED, maxSlides = MAX_SLIDES } = {}) {
  const zip = createZipReader(buf, { maxBytes });
  const presPart = 'ppt/presentation.xml';
  const pres = parseXml(await zip.text(presPart));
  const presentation = kid(pres, 'presentation');
  if (!presentation) throw damaged();
  const sz = kid(presentation, 'sldSz');
  const width = num(sz?.attrs.cx, DEFAULT_SIZE.width) || DEFAULT_SIZE.width;
  const height = num(sz?.attrs.cy, DEFAULT_SIZE.height) || DEFAULT_SIZE.height;
  const presRels = await loadRels(zip, presPart);
  const ids = kids(kid(presentation, 'sldIdLst'), 'sldId').map((s) => relAttr(s, 'id')).filter(Boolean);
  const slideParts = ids.map((id) => presRels.get(id)).filter((r) => r && r.target && r.type === 'slide').map((r) => r.target);
  const truncated = slideParts.length > maxSlides;
  const defaultTextStyle = kid(presentation, 'defaultTextStyle');
  const warnings = new Set();
  const mediaParts = new Set();
  const cache = new Map(); // layout / master / theme parts, shared by the slides that use them

  async function loadPart(part, kind) {
    const key = `${kind}:${part}`;
    if (cache.has(key)) return cache.get(key);
    const promise = (async () => {
      const xml = await zip.text(part);
      if (!xml) return null;
      const doc = kid(parseXml(xml), kind === 'master' ? 'sldMaster' : kind === 'layout' ? 'sldLayout' : 'sld');
      if (!doc) return null;
      const rels = await loadRels(zip, part);
      const spTree = at(doc, 'cSld', 'spTree');
      return { part, kind, doc, rels, spTree, phs: placeholdersIn(spTree), showMasterSp: doc.attrs.showMasterSp !== '0' && doc.attrs.showMasterSp !== 'false' };
    })();
    cache.set(key, promise);
    return promise;
  }

  const slides = [];
  for (const [i, part] of slideParts.slice(0, maxSlides).entries()) {
    const slide = await loadPart(part, 'slide');
    if (!slide) { slides.push({ number: i + 1, hidden: false, background: null, shapes: [], notes: '', text: '' }); warnings.add('Some slides could not be read.'); continue; }
    const layoutRel = relOfType(slide.rels, 'slideLayout');
    const layout = layoutRel ? await loadPart(layoutRel.target, 'layout') : null;
    const masterRel = layout ? relOfType(layout.rels, 'slideMaster') : null;
    const master = masterRel ? await loadPart(masterRel.target, 'master') : null;
    if (master && !master.theme) {
      const themeRel = relOfType(master.rels, 'theme');
      master.theme = parseTheme(themeRel ? await zip.text(themeRel.target) : null);
      master.txStyles = kid(master.doc, 'txStyles');
      master.clrMap = kid(master.doc, 'clrMap')?.attrs || {};
    }
    const theme = master?.theme || { colors: {} };
    const common = { theme, clrMap: master?.clrMap || {}, layout, master, defaultTextStyle, warnings, media: mediaParts };
    const shapes = [];
    // Behind the slide's own shapes: the master's, then the layout's (unless either hides them).
    if (master && layout && slide.showMasterSp && layout.showMasterSp) drawTree(master.spTree, { ...common, kind: 'master', rels: master.rels }, shapes);
    if (layout && slide.showMasterSp) drawTree(layout.spTree, { ...common, kind: 'layout', rels: layout.rels }, shapes);
    const from = shapes.length;
    drawTree(slide.spTree, { ...common, kind: 'slide', rels: slide.rels }, shapes);
    for (let k = from; k < shapes.length; k++) shapes[k].own = true;
    const background = backgroundOf(slide.doc, { ...common, rels: slide.rels }) || (layout && backgroundOf(layout.doc, { ...common, rels: layout.rels })) || (master && backgroundOf(master.doc, { ...common, rels: master.rels })) || null;
    if (background?.type === 'image') mediaParts.add(background.image);
    let notes = '';
    const notesRel = relOfType(slide.rels, 'notesSlide');
    if (notesRel) {
      const nxml = await zip.text(notesRel.target);
      const ndoc = nxml ? kid(parseXml(nxml), 'notes') : null;
      const body = ndoc ? placeholdersIn(at(ndoc, 'cSld', 'spTree')).filter((x) => x.ph.type === 'body') : [];
      notes = body.map((x) => paragraphsText(textBody(kid(x.node, 'txBody'), { chain: [], ctx: common, fontColor: null }))).filter(Boolean).join('\n').slice(0, 20000);
    }
    slides.push({ number: i + 1, hidden: slide.doc.attrs.show === '0' || slide.doc.attrs.show === 'false', background, shapes, notes, text: slideText(shapes) });
  }

  const media = {};
  let mediaBytes = 0;
  if (wantMedia) {
    for (const part of mediaParts) {
      let b;
      try { b = zip.has(part) ? await zip.bytes(part) : null; } catch (err) { if (err instanceof PptxError && /too large/.test(err.message)) { warnings.add('Some pictures were left out: the presentation is too large.'); media[part] = null; continue; } throw err; }
      const type = sniffImage(b);
      if (!b || !type) { media[part] = null; if (b) warnings.add('Some pictures are in a format Lumen cannot show (such as EMF or WMF).'); continue; }
      if (b.length > MAX_IMAGE_BYTES || mediaBytes + b.length > MAX_MEDIA_BYTES) { media[part] = null; warnings.add('Some pictures were left out: they are too large.'); continue; }
      mediaBytes += b.length;
      media[part] = `data:${type};base64,${b.toString('base64')}`;
    }
  }
  if (truncated) warnings.add(`Only the first ${maxSlides} of ${slideParts.length} slides are shown.`);
  return { width, height, slides, media, warnings: [...warnings], truncated, slideCount: slideParts.length };
}

// The text of each slide, for read_pdf (one "page" per slide), the speaker notes after it.
async function extractSlideTexts(buf) {
  const deck = await parsePptx(buf, { media: false });
  return deck.slides.map((s) => [s.text || '', s.notes ? `Notes: ${s.notes}` : ''].filter(Boolean).join('\n\n'));
}

const isPptxName = (name) => /\.pptx$/i.test(String(name || '').split(/[?#]/)[0]);

module.exports = {
  parsePptx, extractSlideTexts, createZipReader, parseXml, isPptxName, sniffImage, PptxError,
  MAX_UNCOMPRESSED, MAX_FILE_BYTES, MAX_SLIDES, EMU_PER_PT,
};
