// ---------- the AI's annotate tool: draw on the page to explain it ----------
// A teacher drawing on the screen: box / circle / arrow / highlight / label / step / spotlight / underline marks,
// pinned to an element (a read_page / find id, or `text:…`) so they follow it on scroll and resize, or to a spot of
// the latest screenshot (viewport px, anchored to the page where it was drawn). With a target, x,y,w,h and points are
// offsets inside it (element space). `write` puts text on the page (an answer in a blank, a note in a margin) in a
// handwriting or print font fitted to its box; `fill` fills a box, circle or path; curve:false draws a shape exact.
//
// Where marks are drawn (agent.js annotateTool picks one):
//   web page, slide viewer   an overlay in the tab, built by overlayMain() in Claude's isolated world: a closed shadow
//                            root, pointer-events:none, one SVG. The page can't read inside it or click through it.
//   PDF tab                  the same overlay inside the Chromium PDF viewer's own frame (it holds the viewer's
//                            viewport), anchored to page number + position on the page so marks follow scroll and zoom.
//   injection fails          the marks are drawn onto a screenshot (staticBoard + annotate-raster.js), shown in the chat.
// Everything the overlay shows is made with createElementNS / textContent / the CSSOM / Web Animations (a page's CSP
// never blocks those); label text is never parsed as markup and colours come from the fixed PALETTE.
//
// overlayMain() is a plain function that is also sent to the page as source text, so it must not use anything outside
// itself. test/units/annotate-units.js runs it against a fake DOM.

const MAX_MARKS = 20; // per call
const MAX_TOTAL = 30; // on the page at once (the oldest go)
const MAX_TEXT = 80;
const MAX_WRITE = 400; // a write mark's text (lines split on \n)
const MAX_LINES = 16;
const MAX_SECONDS = 600;
const TYPES = ['box', 'circle', 'ellipse', 'roundbox', 'arrow', 'line', 'highlight', 'label', 'step', 'spotlight', 'underline', 'strike', 'bracket', 'check', 'cross', 'redact', 'callout', 'path', 'write'];
const MAX_POINTS = 400;
const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'black', 'white'];
const COORD_LIMIT = 20000;

const TOOL = {
  name: 'annotate',
  description: 'Draw on the page to explain it. marks:[{type, target:id|text:…, x,y,w,h, to, points, text, color, fill, font, width/opacity/curve}]. w,h hug the target. line/arrow: x,y to to. A label points at x,y; given to, sits there, points at to. Screenshot/find first; number steps like your answer.',
  input_schema: {
    type: 'object',
    properties: {
      marks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: TYPES },
            target: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
            w: { type: 'number' },
            h: { type: 'number' },
            to: { type: 'object' },
            text: { type: 'string' },
            color: { type: 'string', enum: COLORS },
            width: { type: 'number' },
            opacity: { type: 'number' },
            curve: { type: 'boolean' },
            points: { type: 'array', items: { type: 'array' } },
          },
          required: ['type'],
        },
      },
      clear: { type: 'boolean' },
      duration: { type: 'string' },
    },
  },
};
// Adds the tool to agent.js's TOOLS (before the derived lists are built), like image-router.js's.
function extendTools(TOOLS) { TOOLS.push({ ...TOOL, eager_input_streaming: true }); }

// ---------- arguments ----------
// A model sends target: 12 as often as "12": the schema says string, so numbers are turned into strings first.
function coerce(input) {
  if (!input || typeof input !== 'object') return input;
  const fix = (o) => { if (o && typeof o === 'object' && typeof o.target === 'number') o.target = String(o.target); };
  if (Array.isArray(input.marks)) for (const m of input.marks) { fix(m); if (m && typeof m === 'object') fix(m.to); }
  if (typeof input.duration === 'number') input.duration = String(input.duration);
  return input;
}

// "12" / "[12]" / "#12" -> { ref: 12 }; "text:Buy now" -> { text: 'Buy now' }; anything else is refused.
function parseTarget(raw, where) {
  const s = String(raw ?? '').trim();
  const t = /^text:\s*([\s\S]+)$/i.exec(s);
  if (t) return { text: t[1].trim().replace(/\s+/g, ' ').slice(0, 120) };
  const n = /^\[?#?(\d{1,9})\]?$/.exec(s);
  if (n && Number(n[1]) >= 1) return { ref: Number(n[1]) };
  throw new Error(`${where}: target must be an element id from read_page/find, or "text:…" (got ${JSON.stringify(s.slice(0, 40))}).`);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, v)) : null);

// Screenshot pixels -> page CSS px, the way click_at maps them: ratio is (view width / screenshot width), zoom the tab's zoom.
const shotToCss = (v, { ratio = 1, zoom = 1 } = {}) => (v * ratio) / (zoom || 1);

// The scale of a screenshot, taken when it is taken: CSS px per screenshot px on each axis (innerWidth / image width, so neither
// devicePixelRatio, page zoom nor a downscale can drift it later), and the scroll at that moment (the picture is of that scroll
// position). `ratio` / `zoom` stay for click_at. view: { innerWidth, innerHeight, scrollX, scrollY } of the page, size: the image's px.
function shotScaleOf(view, size, zoom = 1) {
  const iw = Number(view?.innerWidth) || 0, ih = Number(view?.innerHeight) || 0;
  if (!iw || !ih || !size?.width || !size?.height) return { ratio: 1, zoom };
  return { ratio: (iw * zoom) / size.width, zoom, css: { x: iw / size.width, y: ih / size.height }, scroll: { x: Number(view.scrollX) || 0, y: Number(view.scrollY) || 0 } };
}
// A length (w, h) of the screenshot in CSS px.
const shotLen = (v, scale, axis) => (scale && scale.css ? v * scale.css[axis] : shotToCss(v, scale));
// A position of the screenshot in CSS px of the viewport NOW: the page may have scrolled since (scale.now = the scroll at the call).
// An offset inside a target: screenshot px when there is a screenshot, else CSS px (no scroll in it: it moves with the element).
const offLen = (v, scale, axis) => (scale ? shotLen(v, scale, axis) : v);
const shotPos = (v, scale, axis) => shotLen(v, scale, axis) - (scale && scale.css && scale.scroll && scale.now ? scale.now[axis] - scale.scroll[axis] : 0);

// The anchor a mark or an arrow's `to` names: an element / text, or a box in viewport CSS px (w, h may be 0: a point).
// A target with x,y (w,h) is a box inside that element: offsets from its top-left corner (element space).
// -> { ref } | { text } | { ref | text, off: { x, y, w, h } } | { box: { x, y, w, h } } | null
function anchorOf(o, scale, where) {
  if (!o || typeof o !== 'object') return null;
  const x = num(o.x), y = num(o.y);
  if (o.target !== undefined && o.target !== null && o.target !== '') {
    const t = parseTarget(o.target, where);
    if (x === null || y === null) return t;
    const w = num(o.w), h = num(o.h);
    return { ...t, off: { x: offLen(x, scale, 'x'), y: offLen(y, scale, 'y'), w: w && w > 0 ? offLen(w, scale, 'x') : 0, h: h && h > 0 ? offLen(h, scale, 'y') : 0 } };
  }
  if (x === null || y === null) return null;
  if (!scale) throw new Error(`${where}: x,y need a screenshot of this tab first (they are pixels of it), or use target.`);
  const w = num(o.w), h = num(o.h);
  return { box: { x: shotPos(x, scale, 'x'), y: shotPos(y, scale, 'y'), w: w && w > 0 ? shotLen(w, scale, 'x') : 0, h: h && h > 0 ? shotLen(h, scale, 'y') : 0 } };
}

// A write mark given as a point: the box its text takes at 18 CSS px. The overlay fits the text to its box, so the size is
// kept as the box and follows a zoom. The width is a guess the overlay corrects by measuring.
const WRITE_PX = 18;
function writeSize(text) {
  const lines = text.split('\n');
  return { w: Math.max(1, ...lines.map((l) => l.length)) * WRITE_PX * 0.56, h: lines.length * WRITE_PX * 1.25 };
}
// "print" / "typed" / "sans" / "serif" / "mono" / a font name like Arial -> print; anything else (or nothing) -> handwriting.
const fontOf = (v) => (/print|typ|sans|serif|mono|arial|helvetica|times|neat|plain|computer/i.test(String(v || '')) ? 'print' : 'hand');

// Checks and normalises a call. scale: { ratio, zoom } of the latest screenshot (null: none taken).
// -> { clear, marks: [{ type, at, to, text, color }], seconds, dropped, usesRefs, usesText, usesBox }; throws a message for the model.
function normalize(input, scale = null) {
  const out = { clear: input?.clear === true, marks: [], seconds: null, dropped: 0, usesRefs: false, usesText: false, usesBox: false };
  if (input?.duration !== undefined && input.duration !== 'until_dismissed') {
    const s = Number(input.duration);
    if (!Number.isFinite(s) || s <= 0) throw new Error('duration must be "until_dismissed" or a number of seconds.');
    out.seconds = Math.min(MAX_SECONDS, Math.max(1, Math.round(s)));
  }
  const marks = Array.isArray(input?.marks) ? input.marks : [];
  if (!marks.length && !out.clear) throw new Error('Give marks to draw, or clear:true.');
  out.dropped = Math.max(0, marks.length - MAX_MARKS);
  marks.slice(0, MAX_MARKS).forEach((m, i) => {
    const where = `marks[${i}]`;
    if (!m || typeof m !== 'object' || !TYPES.includes(m.type)) throw new Error(`${where}: type must be one of ${TYPES.join(', ')}.`);
    if (m.color !== undefined && !COLORS.includes(m.color)) throw new Error(`${where}: color must be one of ${COLORS.join(', ')}.`);
    if (m.fill !== undefined && m.fill !== null && m.fill !== false && !COLORS.includes(m.fill)) throw new Error(`${where}: fill must be one of ${COLORS.join(', ')}.`);
    let at = anchorOf(m, scale, where);
    let pts = null;
    const along = m.type === 'arrow' && Array.isArray(m.points) && m.points.length >= 2; // an arrow drawn along points (a curve, a detour)
    if (m.type === 'path' || along) { // a freehand stroke: its points are kept as fractions of their bounding box, and the box is the anchor
      const raw = Array.isArray(m.points) ? m.points.slice(0, MAX_POINTS) : [];
      const xy = raw.map((p) => (Array.isArray(p) ? [num(p[0]), num(p[1])] : [null, null])).filter((p) => p[0] !== null && p[1] !== null);
      if (xy.length < 2) throw new Error(`${where}: a path needs points: [[x,y], …] (at least 2, screenshot px).`);
      const inside = at && !at.box ? at : null; // with a target: the points are offsets inside that element
      if (!scale && !inside) throw new Error(`${where}: points need a screenshot of this tab first (they are pixels of it), or a target (then they are px inside it).`);
      const px = xy.map((p) => (inside ? { x: offLen(p[0], scale, 'x'), y: offLen(p[1], scale, 'y') } : { x: shotPos(p[0], scale, 'x'), y: shotPos(p[1], scale, 'y') }));
      const x0 = Math.min(...px.map((p) => p.x)), y0 = Math.min(...px.map((p) => p.y));
      const bw = Math.max(1, Math.max(...px.map((p) => p.x)) - x0), bh = Math.max(1, Math.max(...px.map((p) => p.y)) - y0);
      pts = px.map((p) => [(p.x - x0) / bw, (p.y - y0) / bh]);
      const box = { x: x0, y: y0, w: bw, h: bh };
      at = inside ? { ...(inside.ref ? { ref: inside.ref } : { text: inside.text }), off: box } : { box };
    }
    const to = m.to === undefined || along ? null : anchorOf(m.to, scale, `${where}.to`);
    if (m.to !== undefined && !to && !along) throw new Error(`${where}.to needs a target, or x and y.`);
    if (!at && !(m.type === 'arrow' && to)) throw new Error(`${where}: say where: target (element id or "text:…"), or x and y of the screenshot.`);
    if (m.type === 'line' && !(at && to)) throw new Error(`${where}: a line needs x,y (or target) for one end and to for the other.`);
    if (m.type === 'arrow' && !to && !at) throw new Error(`${where}: an arrow needs a target or x,y, and usually to.`);
    const write = m.type === 'write';
    const text = m.text === undefined || m.text === null ? '' : write
      ? String(m.text).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').split('\n').map((l) => l.replace(/\s+$/, '')).slice(0, MAX_LINES).join('\n').replace(/^\n+|\n+$/g, '').slice(0, MAX_WRITE)
      : String(m.text).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_TEXT);
    if (write && !text.trim()) throw new Error(`${where}: a write mark needs text (\\n for a new line).`);
    const point = (b) => b && !b.w && !b.h;
    const autoSized = write && at && (point(at.box) || point(at.off));
    if (autoSized && at.box) at.box = { ...at.box, ...writeSize(text) }; // a point: the text at 18 px, its top-left there
    if (autoSized && at.off) at.off = { ...at.off, ...writeSize(text) };
    for (const a of [at, to]) { if (a?.ref) out.usesRefs = true; if (a?.text) out.usesText = true; if (a?.box) out.usesBox = true; }
    const mark = { type: m.type, at, to, text, color: m.color || null };
    if (pts) mark.pts = pts;
    if (typeof m.width === 'number' && Number.isFinite(m.width)) mark.width = Math.max(1, Math.min(12, m.width));
    if (typeof m.opacity === 'number' && Number.isFinite(m.opacity)) mark.opacity = Math.max(0.1, Math.min(1, m.opacity));
    if (typeof m.curve === 'boolean') mark.curve = m.curve;
    if (m.fill && COLORS.includes(m.fill)) mark.fill = m.fill;
    if (write) mark.font = fontOf(m.font);
    if (write && autoSized) mark.auto = true; // sized by its height only, never wrapped
    out.marks.push(mark);
  });
  return out;
}

// Which way a call is drawn: 'overlay' (over the page; Lumen's PDF viewer is a page too), or 'screenshot' (marks on a picture of
// the tab: Chrome's own PDF viewer, which no script can reach, or a page the overlay could not be put in). `failed`: the overlay
// was tried and could not be put in the page.
function choosePath({ chromePdf = false, failed = false } = {}) {
  return failed || chromePdf ? 'screenshot' : 'overlay';
}

// ---------- the overlay ----------
// spec: { marks: [{ type, at, to, text, color }], clear, seconds, static?: { w, h } }
// env: { document, window, space? }. A "space" says where a box of the screen is in the page's own coordinates and back
// (the web page's scroll, or a PDF's page + position); marks keep tokens of it. Returns a summary and, for tests and the
// screenshot path, the board.
function overlayMain(spec, env) {
  const doc = env.document;
  const win = env.window;
  const NS = 'http://www.w3.org/2000/svg';
  const live = !spec.static;
  const PALETTE = {
    red: ['#d92d20', '#ff6a5f'], orange: ['#e8590c', '#ff9f43'], yellow: ['#f5c400', '#ffd60a'], green: ['#1a9d4a', '#3ddc84'],
    blue: ['#1a6ef0', '#5aa9ff'], purple: ['#7a3ff2', '#b388ff'], pink: ['#e0399a', '#ff7ac6'], black: ['#111111', '#f2f2f2'], white: ['#ffffff', '#ffffff'],
  };
  const DEFAULT = { box: 'red', circle: 'red', ellipse: 'red', roundbox: 'red', arrow: 'red', line: 'red', underline: 'red', strike: 'red', highlight: 'yellow', label: 'blue', step: 'blue', spotlight: 'white', bracket: 'blue', check: 'green', cross: 'red', redact: 'black', callout: 'blue', path: 'red', write: 'blue' };
  let dark = false;
  try { dark = Boolean(win.matchMedia && win.matchMedia('(prefers-color-scheme: dark)').matches); } catch { dark = false; }
  let still = false;
  try { still = Boolean(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { still = false; }
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  };
  const colorOf = (name, type) => {
    const hex = (PALETTE[name] || PALETTE[DEFAULT[type]] || PALETTE.red)[dark ? 1 : 0];
    const light = lum(hex) > 0.55;
    return { hex, halo: light ? '#000000' : '#ffffff', haloOpacity: light ? 0.7 : 0.9, ink: light ? '#111111' : '#ffffff' };
  };

  // ---- small helpers
  const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const f = (n) => Math.round(n * 10) / 10;
  const makeRng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const el = (tag, attrs, parent) => {
    const e = doc.createElementNS(NS, tag);
    for (const k of Object.keys(attrs || {})) e.setAttribute(k, String(attrs[k]));
    if (parent) parent.appendChild(e);
    return e;
  };
  const setA = (e, attrs) => { for (const k of Object.keys(attrs)) e.setAttribute(k, String(attrs[k])); };
  const play = (e, frames, opts) => { if (!still && live && typeof e.animate === 'function') { try { e.animate(frames, opts); } catch { /* an older engine */ } } };
  const bounds = (rects) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of rects) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };
  // A point (or a speck) becomes a box big enough to draw around.
  const sized = (r, min) => (r.w < 8 && r.h < 8 ? { x: r.x + r.w / 2 - min / 2, y: r.y + r.h / 2 - min / 2, w: min, h: min } : r);
  const isPoint = (rs) => { const b = bounds(rs); return !b.w && !b.h; };
  const wrap = (text, max) => {
    const lines = [];
    let line = '';
    for (const word of String(text).split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (next.length > max && line) { lines.push(line); line = word; } else line = next;
      while (line.length > max + 6) { lines.push(line.slice(0, max)); line = line.slice(max); }
    }
    if (line) lines.push(line);
    return lines.slice(0, 4);
  };
  // A smooth curve through points (Catmull-Rom as cubic Beziers).
  const smooth = (p) => {
    let d = `M${f(p[0].x)} ${f(p[0].y)}`;
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[Math.max(0, i - 1)], b = p[i], c = p[i + 1], e2 = p[Math.min(p.length - 1, i + 2)];
      d += `C${f(b.x + (c.x - a.x) / 6)} ${f(b.y + (c.y - a.y) / 6)} ${f(c.x - (e2.x - b.x) / 6)} ${f(c.y - (e2.y - b.y) / 6)} ${f(c.x)} ${f(c.y)}`;
    }
    return d;
  };
  const rectPath = (r, pad, rnd) => {
    const x = r.x - pad, y = r.y - pad, w = r.w + pad * 2, h = r.h + pad * 2;
    const j = () => (rnd() - 0.5) * 3;
    const c = [{ x: x + j(), y: y + j() }, { x: x + w + j(), y: y + j() }, { x: x + w + j(), y: y + h + j() }, { x: x + j(), y: y + h + j() }];
    let d = `M${f(c[0].x - 5)} ${f(c[0].y + j())}`;
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      d += `Q${f((a.x + b.x) / 2 + j())} ${f((a.y + b.y) / 2 + j())} ${f(b.x)} ${f(b.y)}`;
    }
    return `${d}L${f(c[0].x + 4)} ${f(c[0].y + 2)}`;
  };
  const ellipsePath = (r, rnd) => {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const rx = (r.w / 2) * 1.12 + 8, ry = (r.h / 2) * 1.12 + 8;
    const a0 = -2.2 + rnd() * 0.4;
    const pts = [];
    for (let i = 0; i <= 28; i++) {
      const t = i / 28;
      const a = a0 + t * Math.PI * 2.18;
      const k = 1 + (rnd() - 0.5) * 0.04 + t * 0.05;
      pts.push({ x: cx + Math.cos(a) * rx * k, y: cy + Math.sin(a) * ry * k });
    }
    return smooth(pts);
  };
  // An ellipse round a box, not in it: through its corners (radii x sqrt 2, the tightest one of the box's shape) plus pad.
  const ovalPath = (r, pad) => {
    const rx = (r.w / 2) * Math.SQRT2 + pad, ry = (r.h / 2) * Math.SQRT2 + pad, cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    return `M${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}Z`;
  };
  // The same, hand-drawn: a pen stroke that goes round once and a little past where it began.
  const ellipseRound = (r, rnd) => {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const rx = (r.w / 2) * Math.SQRT2 + 4, ry = (r.h / 2) * Math.SQRT2 + 4;
    const a0 = -2.2 + rnd() * 0.4;
    const pts = [];
    for (let i = 0; i <= 32; i++) {
      const t = i / 32, a = a0 + t * Math.PI * 2.12, k = 1 + (rnd() - 0.5) * 0.02 + t * 0.03;
      pts.push({ x: cx + Math.cos(a) * rx * k, y: cy + Math.sin(a) * ry * k });
    }
    return smooth(pts);
  };
  // A rounded rectangle round a box (grown by pad), its corner radius up to half its height.
  const roundPath = (r, pad) => {
    const x = r.x - pad, y = r.y - pad, w = r.w + pad * 2, h = r.h + pad * 2, k = Math.min(12, h / 2, w / 2);
    return `M${f(x + k)} ${f(y)}H${f(x + w - k)}Q${f(x + w)} ${f(y)} ${f(x + w)} ${f(y + k)}V${f(y + h - k)}Q${f(x + w)} ${f(y + h)} ${f(x + w - k)} ${f(y + h)}H${f(x + k)}Q${f(x)} ${f(y + h)} ${f(x)} ${f(y + h - k)}V${f(y + k)}Q${f(x)} ${f(y)} ${f(x + k)} ${f(y)}Z`;
  };
  // Where the line from `from` toward the box's centre meets the box (grown by pad).
  const edgeToward = (from, r, pad) => {
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const dx = from.x - cx, dy = from.y - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const s = Math.min((r.w / 2 + pad) / Math.abs(dx || 1e-9), (r.h / 2 + pad) / Math.abs(dy || 1e-9), 1);
    return { x: cx + dx * s, y: cy + dy * s };
  };

  // ---- space: the page's own coordinates for a box of the screen
  const webSpace = {
    capture(b) {
      const sx = win.scrollX || 0, sy = win.scrollY || 0;
      const scrollers = [];
      try {
        let n = doc.elementFromPoint && doc.elementFromPoint(b.x + b.w / 2, b.y + b.h / 2);
        for (let i = 0; n && i < 40 && n !== doc.body && n !== doc.documentElement; i++, n = n.parentNode || n.host) {
          if (n.nodeType === 1 && (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1) && !/hidden/.test((win.getComputedStyle && win.getComputedStyle(n).overflow) || '')) scrollers.push(n);
        }
      } catch { /* no hit test */ }
      const tok = { x: b.x + sx, y: b.y + sy, w: b.w, h: b.h };
      for (const s of scrollers) { tok.x += s.scrollLeft; tok.y += s.scrollTop; }
      Object.defineProperty(tok, 'scrollers', { value: scrollers, enumerable: false });
      // Anchor to the page content, not the window: the element under the box (the smallest one that holds all of it) and where
      // the box sits inside it, as fractions of its own box. A resize, a reflow, a zoom or a sidebar then moves the mark with the
      // content. The document coordinates above stay as the fallback (no stable element, or it was removed).
      try {
        let n = doc.elementFromPoint && doc.elementFromPoint(b.x + b.w / 2, b.y + b.h / 2);
        for (let i = 0; n && i < 14; i++, n = n.parentNode) {
          if (n.nodeType !== 1 || n === doc.body || n === doc.documentElement || hostNodeOf(n) || typeof n.getBoundingClientRect !== 'function') break;
          const r = n.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && b.x >= r.left - 2 && b.y >= r.top - 2 && b.x + b.w <= r.right + 2 && b.y + b.h <= r.bottom + 2) {
            Object.defineProperty(tok, 'el', { value: n, enumerable: false });
            Object.defineProperty(tok, 'rel', { value: { fx: (b.x - r.left) / r.width, fy: (b.y - r.top) / r.height, fw: b.w / r.width, fh: b.h / r.height }, enumerable: false });
            break;
          }
        }
      } catch { /* no hit test: the document coordinates are used */ }
      return tok;
    },
    locate(tok) {
      if (tok.el && tok.rel && tok.el.isConnected !== false) {
        const r = tok.el.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) return { x: r.left + tok.rel.fx * r.width, y: r.top + tok.rel.fy * r.height, w: tok.rel.fw * r.width, h: tok.rel.fh * r.height };
      }
      let x = tok.x - (win.scrollX || 0), y = tok.y - (win.scrollY || 0);
      for (const s of tok.scrollers || []) { x -= s.scrollLeft; y -= s.scrollTop; }
      return { x, y, w: tok.w, h: tok.h };
    },
  };
  const space = env.space || webSpace;

  // ---- anchors: where a mark's target is now (viewport CSS px), as an array of line boxes, or null when it is gone
  const hostNodeOf = (n) => n && n.nodeType === 1 && n.tagName && n.tagName.toLowerCase() === 'lumen-annotations';
  const visibleRect = (r) => r && (r.width > 0 || r.height > 0);
  const refRects = (ref) => {
    const entry = win.__claudeEls && win.__claudeEls[ref - 1];
    const e = entry && entry.el;
    if (!e || !e.isConnected) return null;
    const r = e.getBoundingClientRect();
    if (!visibleRect(r)) return null;
    let x = r.left, y = r.top;
    const chain = entry.chain || [];
    for (let i = chain.length - 1; i >= 0; i--) { const fr = chain[i].getBoundingClientRect(); x += fr.left + chain[i].clientLeft; y += fr.top + chain[i].clientTop; }
    return [{ x, y, w: r.width, h: r.height }];
  };
  const normText = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  const findText = (want) => {
    const esc = want.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    if (!esc) return null;
    const re = new RegExp(esc, 'i');
    const root = doc.body || doc.documentElement;
    const vh = win.innerHeight || 0;
    let first = null, inView = null;
    if (doc.createTreeWalker) {
      const walker = doc.createTreeWalker(root, 4);
      for (let n = walker.nextNode(), i = 0; n && i < 30000 && !inView; n = walker.nextNode(), i++) {
        const p = n.parentNode;
        if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|TITLE)$/i.test(p.nodeName || '') || hostNodeOf(p)) continue;
        const m = re.exec(n.data);
        if (!m) continue;
        const range = doc.createRange();
        range.setStart(n, m.index);
        range.setEnd(n, m.index + m[0].length);
        const rects = Array.from(range.getClientRects()).filter(visibleRect);
        if (!rects.length) continue;
        const hit = { range, node: p };
        first = first || hit;
        if (rects.some((r) => r.bottom > 0 && r.top < vh)) inView = hit;
      }
    }
    const hit = inView || first;
    if (hit) return { node: hit.node, rects: () => (hit.range.startContainer.isConnected ? Array.from(hit.range.getClientRects()).filter(visibleRect).map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height })) : null) };
    // Text split across elements ("Hello <b>world</b>"): the deepest element whose text holds it.
    const want2 = normText(want);
    let best = null;
    for (const e of Array.from(doc.querySelectorAll('body *')).slice(0, 8000)) {
      if (hostNodeOf(e) || /^(SCRIPT|STYLE|NOSCRIPT)$/i.test(e.nodeName)) continue;
      if (!normText(e.textContent || '').includes(want2)) continue;
      if (Array.from(e.children).some((c) => normText(c.textContent || '').includes(want2))) continue;
      if (visibleRect(e.getBoundingClientRect())) { best = e; break; }
    }
    if (!best) return null;
    return { node: best, rects: () => { if (!best.isConnected) return null; const r = best.getBoundingClientRect(); return visibleRect(r) ? [{ x: r.left, y: r.top, w: r.width, h: r.height }] : null; } };
  };
  const scrolledTo = [];
  // anchor -> { rects(): [] | null, tok?, frozen: anchor }
  const resolve = (a) => {
    if (!a) return null;
    if ((a.off || a.rel) && (a.ref || a.text)) { // a box inside an element: kept as fractions of the element's box (it scales with a zoom)
      const base = resolve(a.ref ? { ref: a.ref } : { text: a.text });
      const rs0 = base && base.rects();
      if (!rs0 || !rs0.length) return null;
      const b0 = bounds(rs0), o = a.off;
      const rel = a.rel || (b0.w > 0 && b0.h > 0 ? { fx: o.x / b0.w, fy: o.y / b0.h, fw: o.w / b0.w, fh: o.h / b0.h } : { px: o });
      const rects = () => {
        const rs = base.rects();
        if (!rs || !rs.length) return null;
        const b = bounds(rs);
        return [rel.px ? { x: b.x + rel.px.x, y: b.y + rel.px.y, w: rel.px.w, h: rel.px.h } : { x: b.x + rel.fx * b.w, y: b.y + rel.fy * b.h, w: rel.fw * b.w, h: rel.fh * b.h }];
      };
      return { rects, frozen: { ...base.frozen, rel }, scroll: base.scroll };
    }
    if (a.tok) { const t = a.tok; return { rects: () => { const r = space.locate(t); return r ? [r] : null; }, frozen: a, scroll: space.reveal ? () => space.reveal(t) : undefined }; }
    if (a.box) { const tok = space.capture(a.box); if (tok.el && board && board.state && board.state.observer) { try { board.state.observer.observe(tok.el); } catch { /* not observable */ } } return { rects: () => { const r = space.locate(tok); return r ? [r] : null; }, frozen: { tok: { ...tok } } }; }
    if (a.ref) { const rects = () => refRects(a.ref); if (!rects()) return null; return { rects, frozen: a, scroll: () => { const e = win.__claudeEls[a.ref - 1].el; if (e.scrollIntoView) e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } }; }
    if (a.text) { const hit = findText(a.text); if (!hit) return null; return { rects: hit.rects, frozen: a, scroll: () => { if (hit.node.scrollIntoView) hit.node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } }; }
    return null;
  };

  // ---- the board: the host, the SVG, the marks
  let board = live ? win.__lumenDraw : null;
  if (board && !board.alive) board = null;
  if (board && spec.clear) { board.destroy(); board = null; }
  if (!spec.marks.length) return { ok: true, drawn: 0, missing: [], frozen: [], cleared: true };

  const created = !board;
  if (!board) {
    const viewSize = () => ({ w: spec.static ? spec.static.w : (doc.documentElement && doc.documentElement.clientWidth) || win.innerWidth || 0, h: spec.static ? spec.static.h : (doc.documentElement && doc.documentElement.clientHeight) || win.innerHeight || 0 });
    const svg = el('svg', { width: '100%', height: '100%', 'aria-hidden': 'true' });
    const dimLayer = el('g', {}, svg);
    const markLayer = el('g', {}, svg);
    let host = null, pill = null;
    if (live) {
      host = doc.createElement('lumen-annotations');
      host.style.cssText = 'all:initial;position:fixed;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:2147483647;display:block;';
      const shadow = host.attachShadow({ mode: 'closed' });
      svg.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:hidden;';
      shadow.appendChild(svg);
      pill = doc.createElement('button');
      pill.textContent = '×  Clear drawings';
      pill.setAttribute('type', 'button');
      pill.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;pointer-events:auto;cursor:pointer;font:600 13px/1 system-ui,-apple-system,Segoe UI,sans-serif;color:#fff;background:rgba(24,24,27,.92);border:1px solid rgba(255,255,255,.35);border-radius:999px;padding:9px 14px;box-shadow:0 2px 10px rgba(0,0,0,.35);';
      shadow.appendChild(pill);
      (doc.documentElement || doc.body).appendChild(host);
    }
    const state = { alive: true, views: [], steps: 0, timers: [], seed: 7, spotlight: null };
    // The SVG always maps 1 unit to 1 CSS px of the window: the view box follows the window size at once (no stretching while
    // the marks wait for their frame), and every mark is then recomputed from its anchor.
    const fit = () => { const s = viewSize(); setA(svg, { viewBox: `0 0 ${s.w} ${s.h}` }); return s; };
    const layout = () => {
      if (!state.alive) return;
      const s = fit();
      if (live && space.clip) { // the part of the window the page's own content fills (a PDF viewer's toolbar stays clear)
        const c = space.clip();
        host.style.clipPath = c ? `inset(${f(c.y)}px ${f(Math.max(0, s.w - c.x - c.w))}px ${f(Math.max(0, s.h - c.y - c.h))}px ${f(c.x)}px)` : 'none';
      }
      for (const v of state.views) { try { v.update(s); } catch { /* one bad mark never stops the others */ } }
    };
    let queued = false;
    const schedule = () => {
      if (queued || !live) return;
      queued = true;
      const run = () => { queued = false; layout(); };
      if (win.requestAnimationFrame) win.requestAnimationFrame(run); else setTimeout(run, 16);
    };
    const destroy = () => {
      if (!state.alive) return;
      state.alive = false;
      for (const t of state.timers) { clearTimeout(t); clearInterval(t); }
      if (live) {
        for (const [target, type, fn, cap] of state.listeners || []) { try { target.removeEventListener(type, fn, cap); } catch { /* gone */ } }
        try { state.observer && state.observer.disconnect(); } catch { /* gone */ }
        try { host.remove(); } catch { /* gone */ }
        if (win.__lumenDraw === board) win.__lumenDraw = null;
      }
    };
    board = { alive: true, svg, host, dimLayer, markLayer, state, layout, fit, schedule, destroy, viewSize, created: true };
    Object.defineProperty(board, 'alive', { get: () => state.alive, enumerable: true });
    if (live) {
      state.listeners = [];
      const on = (target, type, fn, cap) => { target.addEventListener(type, fn, cap); state.listeners.push([target, type, fn, cap]); };
      on(win, 'scroll', schedule, true);
      on(win, 'resize', () => { fit(); schedule(); }, false);
      if (win.visualViewport) { on(win.visualViewport, 'resize', () => { fit(); schedule(); }, false); on(win.visualViewport, 'scroll', schedule, false); }
      const watchDpr = () => { // moving to another screen, or browser zoom: the pixel ratio changes
        if (!state.alive || !win.matchMedia) return;
        try {
          const mq = win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`);
          if (!mq || typeof mq.addEventListener !== 'function') return;
          const h = () => { try { mq.removeEventListener('change', h); } catch { /* gone */ } fit(); schedule(); watchDpr(); };
          mq.addEventListener('change', h);
          state.listeners.push([mq, 'change', h]);
        } catch { /* no media queries */ }
      };
      watchDpr();
      on(win, 'keydown', (e) => { if (e && e.key === 'Escape') destroy(); }, true); // (the page still gets its Esc)
      pill.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); destroy(); });
      // The drawing stays until Esc / "Clear drawings" / a full navigation (which drops this page world with it). A single-page route
      // change or a script that tidies the DOM must not end it: the host is put back if the page took it out.
      state.timers.push(setInterval(() => { // layout shifts, inner scrollers, a PDF zoom
        if (host && host.isConnected === false) { try { (doc.documentElement || doc.body).appendChild(host); } catch { /* no root yet */ } }
        layout();
      }, spec.fast ? 60 : 250));
      if (typeof win.ResizeObserver === 'function') { try { state.observer = new win.ResizeObserver(() => { fit(); schedule(); }); state.observer.observe(doc.documentElement); if (doc.body) state.observer.observe(doc.body); } catch { state.observer = null; } }
      win.__lumenDraw = board;
    }
  }

  const state = board.state;
  const missing = [];
  const frozen = [];
  let scrollOnce = null;
  spec.marks.forEach((m, i) => {
    const at = resolve(m.at);
    const to = resolve(m.to);
    if ((!at && m.type !== 'arrow') || (m.type === 'arrow' && !at && !to) || (m.to && !to && m.type === 'arrow' && !at)) {
      const a = m.at || m.to;
      missing.push(`marks[${i}] ${m.type}: ${a && a.text ? `no visible text "${a.text}"` : a && a.ref ? `element ${a.ref} is gone or not visible (read_page / find again)` : 'could not be placed'}`);
      return;
    }
    if (m.at && !at) { missing.push(`marks[${i}] ${m.type}: its target was not found`); return; }
    if (m.to && !to) { missing.push(`marks[${i}] ${m.type}: its "to" target was not found`); return; }
    const first = at || to;
    if (live && !scrollOnce && first.scroll) {
      const rs = first.rects();
      const vh = win.innerHeight || 0;
      if (rs && rs.length && (bounds(rs).y + bounds(rs).h < 0 || bounds(rs).y > vh)) scrollOnce = first.scroll;
    }
    const index = state.views.length;
    const view = makeView(m, at, to, index);
    if (!view) { missing.push(`marks[${i}] ${m.type}: nothing to draw`); return; }
    state.views.push(view);
    frozen.push({ type: m.type, at: at ? at.frozen : null, to: to ? to.frozen : null, text: m.text, color: m.color, pts: m.pts, width: m.width, opacity: m.opacity, curve: m.curve, fill: m.fill, font: m.font, auto: m.auto });
  });
  if (scrollOnce) { try { scrollOnce(); } catch { /* no scroll */ } }
  // Over the cap: the oldest marks go.
  while (state.views.length > spec.maxTotal) { const old = state.views.shift(); old.remove(); }
  board.layout();
  if (live && spec.seconds) state.timers.push(setTimeout(board.destroy, spec.seconds * 1000));
  return { ok: true, drawn: state.views.length, missing, frozen, created, board, host: board.host, svg: board.svg };

  // ---- one mark
  function makeView(m, at, to, index) {
    const c = colorOf(m.color || (m.type !== 'write' && m.fill) || null, m.type); // a filled shape is outlined in its fill colour unless told
    const rnd = makeRng(state.seed * 131 + index * 977 + m.type.length);
    state.seed++;
    const delay = Math.min(index, 5) * 110;
    const parts = [];
    const add = (tag, attrs, layer) => { const e = el(tag, attrs, layer || board.markLayer); if (m.opacity) e.setAttribute('opacity', m.opacity); e.setAttribute('data-mark', index); parts.push(e); return e; }; // data-mark: which mark a part belongs to (tests measure them)
    // A hand-drawn stroke: a halo underneath (so it reads on any background) and the colour on top.
    const stroke = (width0, extra) => {
      const width = m.width || width0;
      const common = { fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', pathLength: 1, 'stroke-dasharray': 1, ...(extra || {}) };
      const halo = add('path', { ...common, stroke: c.halo, 'stroke-opacity': c.haloOpacity, 'stroke-width': width + 4 });
      const main = add('path', { ...common, stroke: c.hex, 'stroke-width': width });
      for (const p of [halo, main]) play(p, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 460, delay, fill: 'backwards', easing: 'ease-out' });
      return (d) => { halo.setAttribute('d', d); main.setAttribute('d', d); };
    };
    const popIn = (e) => play(e, [{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay, fill: 'backwards' });
    const rectsOf = (a) => (a ? a.rects() : null);
    const view = { type: m.type, remove: () => parts.forEach((p) => { try { p.remove(); } catch { /* gone */ } }), update: () => {} };

    // A fill under a shape: translucent, or solid with opacity (fill:white, opacity:1 covers what is under it).
    const fillOf = () => {
      if (!m.fill) return null;
      const e = add('path', { fill: colorOf(m.fill, m.type).hex, 'fill-opacity': m.opacity ? 1 : 0.35, stroke: 'none' });
      popIn(e);
      return e;
    };
    if (m.type === 'box' || m.type === 'circle' || m.type === 'ellipse' || m.type === 'roundbox') {
      const exact = Boolean(m.fill) || m.curve === false; // no hand-drawn wobble or padding: the exact box, or the ellipse in it
      const fillEl = fillOf();
      const set = stroke(exact ? 3 : 4);
      view.update = () => {
        const rs = rectsOf(at);
        if (!rs || !rs.length) { parts.forEach((p) => p.setAttribute('visibility', 'hidden')); return; }
        parts.forEach((p) => p.setAttribute('visibility', 'visible'));
        const b = sized(bounds(rs), exact ? 12 : 40);
        const r = makeRng(index * 977 + 13);
        const rx = b.w / 2, ry = b.h / 2, cx = b.x + rx, cy = b.y + ry;
        const d = m.type === 'ellipse' ? (exact ? ovalPath(b, 0) : ellipseRound(b, r))
          : m.type === 'roundbox' ? roundPath(b, exact ? 0 : 4)
          : !exact ? (m.type === 'box' ? rectPath(b, 5, r) : ellipsePath(b, r))
          : m.type === 'box' ? `M${f(b.x)} ${f(b.y)}H${f(b.x + b.w)}V${f(b.y + b.h)}H${f(b.x)}Z`
            : `M${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}Z`;
        set(d);
        if (fillEl) fillEl.setAttribute('d', d);
      };
      if (m.text) addCallout(view, m, at, c, delay, add, popIn, rectsOf);
    } else if (m.type === 'underline' || m.type === 'strike') {
      const lines = [];
      const sets = [];
      const make = () => { sets.push(stroke(3)); };
      view.update = () => {
        const rs = rectsOf(at);
        const use = rs && rs.length ? rs.slice(0, 8) : [];
        while (sets.length < use.length) make();
        sets.forEach((s, k) => { if (!use[k]) s(''); });
        use.forEach((r0, k) => {
          const r = sized(r0, 40);
          const y = m.type === 'strike' ? r.y + r.h / 2 : r.y + r.h + 2;
          const n = Math.max(2, Math.round(r.w / 30));
          const rr = makeRng(index * 977 + k);
          const pts = [];
          for (let i = 0; i <= n; i++) pts.push({ x: r.x - 2 + ((r.w + 4) * i) / n, y: y + (rr() - 0.5) * 3.2 });
          sets[k](smooth(pts));
        });
        lines.length = use.length;
      };
      if (m.text) addCallout(view, m, at, c, delay, add, popIn, rectsOf);
    } else if (m.type === 'highlight') {
      const rectsEls = [];
      view.update = () => {
        const rs = rectsOf(at);
        const use = rs && rs.length ? rs.slice(0, 12) : [];
        while (rectsEls.length < use.length) {
          const e = add('rect', { fill: c.hex, 'fill-opacity': dark ? 0.35 : 0.45, rx: 3 });
          if (!dark) e.setAttribute('style', 'mix-blend-mode:multiply');
          popIn(e);
          rectsEls.push(e);
        }
        rectsEls.forEach((e, k) => {
          const r = use[k] && sized(use[k], 28);
          if (!r) { e.setAttribute('visibility', 'hidden'); return; }
          setA(e, { visibility: 'visible', x: f(r.x - 2), y: f(r.y - 1), width: f(r.w + 4), height: f(r.h + 2) });
        });
      };
      if (m.text) addCallout(view, m, at, c, delay, add, popIn, rectsOf);
    } else if (m.type === 'spotlight') {
      if (state.spotlight) { state.spotlight.remove(); state.views = state.views.filter((v) => v !== state.spotlight); }
      state.spotlight = view;
      const dim = el('path', { 'fill-rule': 'evenodd', fill: '#000000', 'fill-opacity': 0.58 }, board.dimLayer);
      const ring = el('rect', { fill: 'none', stroke: '#ffffff', 'stroke-width': 2.5, 'stroke-opacity': 0.95 }, board.dimLayer);
      parts.push(dim, ring);
      play(dim, [{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay, fill: 'backwards' });
      view.update = (s) => {
        const rs = rectsOf(at);
        if (!rs || !rs.length) { parts.forEach((p) => p.setAttribute('visibility', 'hidden')); return; }
        parts.forEach((p) => p.setAttribute('visibility', 'visible'));
        const b = sized(bounds(rs), 80);
        const x = b.x - 8, y = b.y - 8, w = b.w + 16, h = b.h + 16, r = 10;
        setA(dim, { d: `M0 0H${s.w}V${s.h}H0Z M${f(x + r)} ${f(y)}H${f(x + w - r)}Q${f(x + w)} ${f(y)} ${f(x + w)} ${f(y + r)}V${f(y + h - r)}Q${f(x + w)} ${f(y + h)} ${f(x + w - r)} ${f(y + h)}H${f(x + r)}Q${f(x)} ${f(y + h)} ${f(x)} ${f(y + h - r)}V${f(y + r)}Q${f(x)} ${f(y)} ${f(x + r)} ${f(y)}Z` });
        setA(ring, { x: f(x), y: f(y), width: f(w), height: f(h), rx: r });
      };
      if (m.text) addCallout(view, m, at, c, delay, add, popIn, rectsOf);
    } else if ((m.type === 'arrow' && !m.pts) || m.type === 'line') {
      const line = m.type === 'line'; // a line: point to point, no head, straight unless curve:true
      const body = stroke(line ? 3 : 4);
      const head = line ? null : stroke(4);
      view.update = (s) => {
        const a = at && rectsOf(at);
        const t = to && rectsOf(to);
        if ((at && !(a && a.length)) || (to && !(t && t.length))) { parts.forEach((p) => p.setAttribute('visibility', 'hidden')); return; }
        parts.forEach((p) => p.setAttribute('visibility', 'visible'));
        const ab = a && a.length ? sized(bounds(a), 0) : null;
        const tb = t && t.length ? sized(bounds(t), 0) : null;
        let tail, tip;
        if (ab && tb) {
          tail = edgeToward({ x: tb.x + tb.w / 2, y: tb.y + tb.h / 2 }, ab, 6);
          tip = edgeToward({ x: ab.x + ab.w / 2, y: ab.y + ab.h / 2 }, tb, 6);
          if (!ab.w && !ab.h) tail = { x: ab.x, y: ab.y };
          if (!tb.w && !tb.h) tip = { x: tb.x, y: tb.y };
        } else {
          // One end only: the arrow points at it from the side with room.
          const b0 = ab || tb;
          tip = b0.w || b0.h ? edgeToward({ x: b0.x - 90, y: b0.y - 70 }, b0, 6) : { x: b0.x, y: b0.y };
          const left = tip.x > s.w / 2 ? 1 : -1;
          const up = tip.y > s.h / 2 ? 1 : -1;
          tail = { x: clampN(tip.x - left * 80, 12, s.w - 12), y: clampN(tip.y - up * 62, 12, s.h - 12) };
          if (tb && !ab) { const tmp = tail; tail = tip; tip = tmp; }
        }
        const dx = tip.x - tail.x, dy = tip.y - tail.y;
        const len = Math.max(1, Math.hypot(dx, dy));
        const bow = (m.curve === false || (line && m.curve !== true) ? 0 : len * (m.curve === true ? 0.3 : 0.12)) * (index % 2 ? -1 : 1);
        const ctl = { x: (tail.x + tip.x) / 2 - (dy / len) * bow, y: (tail.y + tip.y) / 2 + (dx / len) * bow };
        body(`M${f(tail.x)} ${f(tail.y)}Q${f(ctl.x)} ${f(ctl.y)} ${f(tip.x)} ${f(tip.y)}`);
        const ang = Math.atan2(tip.y - ctl.y, tip.x - ctl.x);
        const hl = Math.min(18, Math.max(9, len * 0.35));
        const p1 = { x: tip.x - Math.cos(ang - 0.45) * hl, y: tip.y - Math.sin(ang - 0.45) * hl };
        const p2 = { x: tip.x - Math.cos(ang + 0.45) * hl, y: tip.y - Math.sin(ang + 0.45) * hl };
        if (head) head(`M${f(p1.x)} ${f(p1.y)}L${f(tip.x)} ${f(tip.y)}L${f(p2.x)} ${f(p2.y)}`);
      };
      if (m.text) addCallout(view, m, at || to, c, delay, add, popIn, rectsOf, true);
    } else if (m.type === 'path' || m.type === 'arrow') { // (an arrow here is one along points)
      if (!m.pts || m.pts.length < 2) return null;
      const fillEl = fillOf(); // a filled path is closed
      const set = stroke(m.width ? m.width : m.curve === false ? 3 : 4);
      const head = m.type === 'arrow' ? stroke(m.width || 4) : null;
      view.update = () => {
        const rs = rectsOf(at);
        if (!rs || !rs.length) { parts.forEach((p) => p.setAttribute('visibility', 'hidden')); return; }
        parts.forEach((p) => p.setAttribute('visibility', 'visible'));
        const b = bounds(rs); // the stroke scales with the element it was drawn on
        const p = m.pts.map((q) => ({ x: b.x + q[0] * b.w, y: b.y + q[1] * b.h }));
        // curve:false: straight segments through the exact points (a polyline, a polygon); else a smooth curve through them
        const d = (m.curve === false ? p.map((q, i) => `${i ? 'L' : 'M'}${f(q.x)} ${f(q.y)}`).join('') : smooth(p)) + (fillEl ? 'Z' : '');
        set(d);
        if (fillEl) fillEl.setAttribute('d', d);
        if (head) { // the head points along the last segment (a smooth curve leaves its last point that way too)
          const tip = p[p.length - 1];
          let k = p.length - 2;
          while (k > 0 && Math.hypot(tip.x - p[k].x, tip.y - p[k].y) < 2) k--;
          const ang = Math.atan2(tip.y - p[k].y, tip.x - p[k].x);
          const hl = clampN((m.width || 4) * 3.5, 9, 26);
          head(`M${f(tip.x - Math.cos(ang - 0.45) * hl)} ${f(tip.y - Math.sin(ang - 0.45) * hl)}L${f(tip.x)} ${f(tip.y)}L${f(tip.x - Math.cos(ang + 0.45) * hl)} ${f(tip.y - Math.sin(ang + 0.45) * hl)}`);
        }
      };
      if (m.text) addCallout(view, m, { rects: () => { const rs = rectsOf(at); if (!rs || !rs.length) return null; const b = bounds(rs), q = m.pts[0]; return [{ x: b.x + q[0] * b.w, y: b.y + q[1] * b.h, w: 0, h: 0 }]; } }, c, delay, add, popIn, rectsOf, true);
    } else if (m.type === 'write') {
      const hand = m.font !== 'print';
      const family = hand ? "'Segoe Print','Ink Free','Bradley Hand','Comic Sans MS','Chalkboard SE',cursive" : "system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif";
      const back = m.fill ? add('rect', { fill: colorOf(m.fill, 'write').hex, 'fill-opacity': m.opacity ? 1 : 0.92, rx: 2 }) : null; // fill: a card behind the text (white covers what was there)
      const text = add('text', { fill: c.hex, 'font-family': family, 'font-weight': hand ? 400 : 500, 'paint-order': 'stroke', 'stroke-linejoin': 'round', ...(m.fill ? {} : { stroke: c.halo, 'stroke-opacity': c.haloOpacity * 0.8 }) });
      if (back) popIn(back);
      play(text, [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: Math.min(1400, 180 + m.text.length * 22), delay, fill: 'backwards', easing: 'linear' }); // written left to right
      const given = m.text.split('\n');
      // A line's ink at 100 px: its advance width and how far the glyphs reach above and below the baseline. Measured with the
      // real font where the engine can (canvas measureText), so the writing sits inside its box by its ink, not by the font's
      // padded em box; else a per-font estimate (the screenshot path).
      const metrics = new Map();
      let ctx = null;
      if (live) { try { const cv = doc.createElement('canvas'); ctx = cv.getContext ? cv.getContext('2d') : null; if (ctx) ctx.font = `${hand ? 400 : 500} 100px ${family}`; } catch { ctx = null; } }
      const at100 = (s) => {
        if (!metrics.has(s)) {
          let mm = null;
          if (ctx && s) { try { const t = ctx.measureText(s); if (t.width > 0) mm = { w: t.width, asc: t.actualBoundingBoxAscent || 0, desc: t.actualBoundingBoxDescent || 0 }; } catch { mm = null; } }
          metrics.set(s, mm || { w: s.length * (hand ? 58 : 53), asc: hand ? 78 : 72, desc: /[gjpqy,;]/.test(s) ? (hand ? 30 : 22) : 2 });
        }
        return metrics.get(s);
      };
      const wrapTo = (maxW, size) => {
        if (!(maxW > 0) || m.auto) return given;
        const out = [];
        for (const line of given) {
          let cur = '';
          for (const word of line.split(/ +/)) {
            const next = cur ? `${cur} ${word}` : word;
            if (cur && (at100(next).w * size) / 100 > maxW) { out.push(cur); cur = word; } else cur = next;
          }
          out.push(cur);
        }
        return out.slice(0, 16);
      };
      // The ink of lines at a size: from the first line's top to the last line's bottom (lines 1.2 apart).
      const inkOf = (lines, size) => {
        const asc = Math.max(...lines.slice(0, 1).map((l) => at100(l).asc)), desc = at100(lines[lines.length - 1]).desc;
        return { asc: (asc * size) / 100, h: (((lines.length - 1) * 120 + asc + desc) * size) / 100, w: Math.max(...lines.map((l) => (at100(l).w * size) / 100)) };
      };
      // The largest size (up to the cap) at which the text fits the box: wrapped to its width, its ink inside its height.
      let first = null, fitted = null;
      const fit = (b) => {
        const lines0 = given;
        if (m.auto) { const size = b.h / (given.length * 1.25); return { size, lines: lines0, ink: inkOf(lines0, size) }; }
        const cap = 28 * (first ? b.h / first.h : 1); // the cap grows with a zoom, so a zoomed box keeps the same look
        const pad = Math.min(2, b.h * 0.06);
        const one = inkOf(lines0, 100).h / 100; // ink height per px of size
        let size = Math.max(6, Math.min(cap, (b.h - 2 * pad) / Math.max(0.5, one)));
        let lines = wrapTo(b.w, size);
        let ink = inkOf(lines, size);
        for (let i = 0; i < 60 && size > 6; i++) {
          if (ink.h <= b.h - 2 * pad + 0.25 && ink.w <= b.w - Math.min(3, b.w * 0.02) + 0.25) break;
          size *= 0.95;
          lines = wrapTo(b.w, size);
          ink = inkOf(lines, size);
        }
        return { size, lines, ink, pad };
      };
      let spans = [];
      view.update = () => {
        const rs = rectsOf(at);
        if (!rs || !rs.length) { parts.forEach((p) => p.setAttribute('visibility', 'hidden')); return; }
        parts.forEach((p) => p.setAttribute('visibility', 'visible'));
        const b = bounds(rs);
        if (!first) first = { w: b.w, h: b.h };
        const key = `${f(b.w)},${f(b.h)}`;
        if (!fitted || fitted.key !== key) fitted = { key, ...fit(b) };
        const { size, lines, ink, pad = 0 } = fitted;
        // A point: the ink's top-left at it. A box the text fills: on its bottom line (an answer on a blank). A big box: at its top.
        const inkTop = m.auto ? b.y : ink.h >= b.h * 0.6 ? b.y + b.h - pad - ink.h : b.y + pad;
        const base = inkTop + ink.asc;
        const x = b.x + (m.auto ? 0 : Math.min(3, b.w * 0.02));
        setA(text, { x: f(x), y: f(base), 'font-size': f(size), 'stroke-width': f(Math.max(1.5, size * 0.16)) });
        while (spans.length < lines.length) spans.push(el('tspan', {}, text));
        while (spans.length > lines.length) spans.pop().remove();
        spans.forEach((t, i) => { t.textContent = lines[i]; setA(t, { x: f(x), y: f(base + i * size * 1.2) }); });
        if (back) setA(back, { x: f(b.x - 2), y: f(Math.min(b.y, inkTop) - 1), width: f(Math.max(b.w, ink.w + 6) + 4), height: f(Math.max(b.y + b.h, inkTop + ink.h) - Math.min(b.y, inkTop) + 2) });
      };
    } else if (m.type === 'bracket') {
      const set = stroke(3.5);
      view.update = () => {
        const rs = rectsOf(at);
        if (!rs || !rs.length) { parts.forEach((p) => p.setAttribute('visibility', 'hidden')); return; }
        parts.forEach((p) => p.setAttribute('visibility', 'visible'));
        const b = sized(bounds(rs), 24);
        const tall = b.h >= b.w * 0.8; // a tall target gets a brace on its left, a wide one above it
        const fixed = (tall ? b.x : b.y) - 4;
        const u0 = (tall ? b.y : b.x) - 2, u1 = (tall ? b.y + b.h : b.x + b.w) + 2;
        const um = (u0 + u1) / 2, r = Math.min(9, (u1 - u0) / 4);
        const pt = (u, v) => (tall ? `${f(fixed + v)} ${f(u)}` : `${f(u)} ${f(fixed + v)}`);
        set(`M${pt(u0, 0)}Q${pt(u0, -7)} ${pt(u0 + r, -7)}L${pt(um - r, -7)}Q${pt(um, -7)} ${pt(um, -15)}Q${pt(um, -7)} ${pt(um + r, -7)}L${pt(u1 - r, -7)}Q${pt(u1, -7)} ${pt(u1, 0)}`);
      };
      if (m.text) addCallout(view, m, at, c, delay, add, popIn, rectsOf);
    } else if (m.type === 'check' || m.type === 'cross') {
      const set = stroke(5);
      view.update = () => {
        const rs = rectsOf(at);
        if (!rs || !rs.length) { parts.forEach((p) => p.setAttribute('visibility', 'hidden')); return; }
        parts.forEach((p) => p.setAttribute('visibility', 'visible'));
        const b = bounds(rs);
        const S = b.w || b.h ? clampN(Math.min(b.w, b.h) || Math.max(b.w, b.h), 24, 56) : 32;
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        set(m.type === 'check'
          ? `M${f(cx - 0.34 * S)} ${f(cy + 0.02 * S)}L${f(cx - 0.1 * S)} ${f(cy + 0.28 * S)}L${f(cx + 0.38 * S)} ${f(cy - 0.3 * S)}`
          : `M${f(cx - 0.3 * S)} ${f(cy - 0.3 * S)}L${f(cx + 0.3 * S)} ${f(cy + 0.3 * S)}M${f(cx + 0.3 * S)} ${f(cy - 0.3 * S)}L${f(cx - 0.3 * S)} ${f(cy + 0.3 * S)}`);
      };
      if (m.text) addCallout(view, m, at, c, delay, add, popIn, rectsOf);
    } else if (m.type === 'redact') {
      const e = add('rect', { rx: 3, fill: m.color ? c.hex : '#111111', 'fill-opacity': m.opacity ? 1 : 0.94 });
      popIn(e);
      view.update = () => {
        const rs = rectsOf(at);
        if (!rs || !rs.length) { e.setAttribute('visibility', 'hidden'); return; }
        const b = sized(bounds(rs), 28);
        setA(e, { visibility: 'visible', x: f(b.x - 2), y: f(b.y - 1), width: f(b.w + 4), height: f(b.h + 2) });
      };
      if (m.text) addCallout(view, m, at, c, delay, add, popIn, rectsOf);
    } else if (m.type === 'callout') {
      if (!m.text) return null;
      const lines = wrap(m.text, 26);
      const width = Math.max(...lines.map((l) => l.length)) * 7.4 + 20;
      const height = lines.length * 18 + 12;
      const lead = stroke(2.5);
      const box = add('rect', { rx: 8, fill: c.hex, stroke: '#ffffff', 'stroke-width': 2 });
      const text = add('text', { 'font-size': 14, 'font-weight': 600, fill: c.ink, 'font-family': 'system-ui,-apple-system,Segoe UI,sans-serif' });
      const spans = lines.map((line) => { const t = el('tspan', {}, text); t.textContent = line; return t; });
      popIn(box); popIn(text);
      view.update = (s) => {
        const rs = rectsOf(at);
        const tr = to ? rectsOf(to) : null;
        if (!rs || !rs.length || (to && !(tr && tr.length))) { parts.forEach((p) => p.setAttribute('visibility', 'hidden')); return; }
        parts.forEach((p) => p.setAttribute('visibility', 'visible'));
        const b = sized(bounds(rs), 12);
        const gap = 46;
        let bx, by = clampN(b.y + b.h / 2 - height / 2, 8, Math.max(8, s.h - height - 8));
        if (to && isPoint(rs)) bx = clampN(b.x + b.w / 2 - width / 2, 8, Math.max(8, s.w - width - 8)); // a spot for the bubble, `to` what it names
        else if (b.x + b.w + gap + width <= s.w - 8) bx = b.x + b.w + gap; // room on the right
        else if (b.x - gap - width >= 8) bx = b.x - gap - width; // else on the left
        else { bx = clampN(b.x + b.w / 2 - width / 2, 8, Math.max(8, s.w - width - 8)); by = b.y - height - gap >= 8 ? b.y - height - gap : b.y + b.h + gap; }
        setA(box, { x: f(bx), y: f(by), width: f(width), height });
        spans.forEach((t, i) => setA(t, { x: f(bx + 10), y: f(by + 18 + i * 18) }));
        setA(text, { x: f(bx + 10), y: f(by + 18) });
        const bc = { x: bx + width / 2, y: by + height / 2 };
        const tb = to ? sized(bounds(tr), 0) : b;
        const tip = !tb.w && !tb.h ? { x: tb.x, y: tb.y } : edgeToward(bc, tb, 3);
        const from = edgeToward(tip, { x: bx, y: by, w: width, h: height }, 0);
        lead(`M${f(from.x)} ${f(from.y)}L${f(tip.x)} ${f(tip.y)}`);
      };
    } else if (m.type === 'label') {
      if (!m.text) return null;
      // With `to`: the label sits at its own spot (a point x,y: centred there) and a leader with a head runs to what it names.
      addCallout(view, m, at, c, delay, add, popIn, rectsOf, false, to ? { to, lead: stroke(2.5), head: stroke(2.5) } : null);
    } else if (m.type === 'step') {
      state.steps += 1;
      const asNum = /^\d{1,2}$/.test(m.text) ? m.text : String(state.steps);
      const note = /^\d{1,2}$/.test(m.text) ? '' : m.text;
      const disc = add('circle', { r: 13, fill: c.hex, stroke: '#ffffff', 'stroke-width': 2.5 });
      const ring = add('circle', { r: 15.5, fill: 'none', stroke: c.halo, 'stroke-opacity': c.haloOpacity, 'stroke-width': 1.5 });
      const label = add('text', { 'text-anchor': 'middle', 'font-size': 14, 'font-weight': 700, fill: c.ink, 'font-family': 'system-ui,-apple-system,Segoe UI,sans-serif' });
      label.textContent = asNum;
      for (const p of [disc, ring, label]) play(p, [{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay, fill: 'backwards' });
      let noteBox = null, noteText = null;
      if (note) {
        noteBox = add('rect', { rx: 8, fill: c.hex, stroke: '#ffffff', 'stroke-width': 2 });
        noteText = add('text', { 'font-size': 13, 'font-weight': 600, fill: c.ink, 'font-family': 'system-ui,-apple-system,Segoe UI,sans-serif' });
        noteText.textContent = note;
      }
      view.update = (s) => {
        const rs = rectsOf(at);
        if (!rs || !rs.length) { parts.forEach((p) => p.setAttribute('visibility', 'hidden')); return; }
        parts.forEach((p) => p.setAttribute('visibility', 'visible'));
        const b = bounds(rs);
        if (b.y + b.h < -20 || b.y > s.h + 20 || b.x + b.w < -20 || b.x > s.w + 20) { parts.forEach((p) => p.setAttribute('visibility', 'hidden')); return; } // scrolled out of view: not pinned to the edge
        const point = !b.w && !b.h;
        const cx = clampN(point ? b.x : b.x - 4, 16, s.w - 16), cy = clampN(point ? b.y : b.y - 4, 16, s.h - 16);
        setA(disc, { cx: f(cx), cy: f(cy) });
        setA(ring, { cx: f(cx), cy: f(cy) });
        setA(label, { x: f(cx), y: f(cy + 5) });
        if (noteBox) {
          const w = note.length * 7.2 + 16;
          setA(noteBox, { x: f(cx + 19), y: f(cy - 12), width: f(w), height: 24 });
          setA(noteText, { x: f(cx + 27), y: f(cy + 5) });
        }
      };
    }
    return view;
  }

  // A speech-bubble label next to the target (above it, or below when there is no room), pointing at it. With a pointer
  // ({ to, lead, head }: a label given `to`), the bubble is at the target (centred on a point) and a leader runs to `to`.
  function addCallout(view, m, at, c, delay, add, popIn, rectsOf, anchoredToPoint, pointer) {
    if (!m.text) return;
    const lines = wrap(m.text, 26);
    const width = Math.max(...lines.map((l) => l.length)) * 7.4 + 20;
    const height = lines.length * 18 + 12;
    const tail = add('path', { fill: c.hex, stroke: '#ffffff', 'stroke-width': 2, 'stroke-linejoin': 'round' });
    const box = add('rect', { rx: 8, fill: c.hex, stroke: '#ffffff', 'stroke-width': 2 });
    const text = add('text', { 'font-size': 14, 'font-weight': 600, fill: c.ink, 'font-family': 'system-ui,-apple-system,Segoe UI,sans-serif' });
    const spans = lines.map((line) => { const t = el('tspan', {}, text); t.textContent = line; return t; });
    for (const p of [tail, box, text]) popIn(p);
    const toward = (b, s, t) => { // the bubble on its spot, the leader from its edge to the target `to` names
      const bx = clampN(b.x + b.w / 2 - width / 2, 8, Math.max(8, s.w - width - 8));
      const by = clampN(b.y + b.h / 2 - height / 2, 8, Math.max(8, s.h - height - 8));
      setA(box, { x: f(bx), y: f(by), width: f(width), height });
      setA(text, { x: f(bx + 10), y: f(by + 18) });
      spans.forEach((sp, i) => setA(sp, { x: f(bx + 10), y: f(by + 18 + i * 18) }));
      tail.setAttribute('d', '');
      const card = { x: bx, y: by, w: width, h: height };
      const tip = !t.w && !t.h ? { x: t.x, y: t.y } : edgeToward({ x: bx + width / 2, y: by + height / 2 }, t, 4);
      const from = edgeToward(tip, card, 0);
      const len = Math.hypot(tip.x - from.x, tip.y - from.y);
      pointer.lead(len < 2 ? '' : `M${f(from.x)} ${f(from.y)}L${f(tip.x)} ${f(tip.y)}`);
      if (len < 2) { pointer.head(''); return; }
      const ang = Math.atan2(tip.y - from.y, tip.x - from.x), hl = Math.min(12, len * 0.4);
      pointer.head(`M${f(tip.x - Math.cos(ang - 0.45) * hl)} ${f(tip.y - Math.sin(ang - 0.45) * hl)}L${f(tip.x)} ${f(tip.y)}L${f(tip.x - Math.cos(ang + 0.45) * hl)} ${f(tip.y - Math.sin(ang + 0.45) * hl)}`);
    };
    const place = (b, s) => {
      const gap = 16;
      let by = b.y - height - gap;
      let below = false;
      if (by < 8) { by = b.y + b.h + gap; below = true; }
      const bx = clampN(b.x + b.w / 2 - width / 2, 8, Math.max(8, s.w - width - 8));
      setA(box, { x: f(bx), y: f(by), width: f(width), height });
      setA(text, { x: f(bx + 10), y: f(by + 18) });
      spans.forEach((t, i) => setA(t, { x: f(bx + 10), y: f(by + 18 + i * 18) }));
      const tx = clampN(b.x + b.w / 2, bx + 14, bx + width - 14);
      const edge = below ? by : by + height;
      const tipY = below ? by - 11 : by + height + 11;
      setA(tail, { d: `M${f(tx - 7)} ${f(edge)}L${f(tx)} ${f(tipY)}L${f(tx + 7)} ${f(edge)}` });
    };
    const base = view.update;
    view.update = (s) => {
      base(s);
      const rs = rectsOf(at);
      if (!rs || !rs.length) { for (const p of [tail, box, text]) p.setAttribute('visibility', 'hidden'); return; }
      for (const p of [tail, box, text]) p.setAttribute('visibility', 'visible');
      if (pointer) {
        const tr = rectsOf(pointer.to);
        if (!tr || !tr.length) { for (const p of [tail, box, text]) p.setAttribute('visibility', 'hidden'); pointer.lead(''); pointer.head(''); return; }
        const t = sized(bounds(tr), 0);
        if (isPoint(rs)) toward(bounds(rs), s, t);
        else { place(sized(bounds(rs), 12), s); toward({ x: Number(box.getAttribute('x')) + width / 2, y: Number(box.getAttribute('y')) + height / 2, w: 0, h: 0 }, s, t); }
      } else if (!anchoredToPoint) place(isPoint(rs) ? bounds(rs) : sized(bounds(rs), 12), s); // a point: the tail tip at it
      else place({ ...sized(bounds(rs), 0), x: bounds(rs).x, y: bounds(rs).y, w: 0, h: 0 }, s);
    };
  }
}

// ---------- the PDF viewer's space ----------
// Lumen's PDF viewer (features/pdf-viewer.js) is an ordinary page: each PDF page is an element (#viewer .page[data-page-number]),
// so a box of the screen is kept as a page number and fractions of that page's box. A mark then follows scroll and zoom (the
// page element changes size and place; the fractions do not). Text and element targets work as on any page (the text layer).
function viewerSpace(win, doc) {
  const pageEl = (n) => doc.querySelector(`#viewer .page[data-page-number="${Number(n)}"]`);
  return {
    capture(b) {
      const cy = b.y + b.h / 2;
      let best = null, bestGap = Infinity;
      for (const el of doc.querySelectorAll('#viewer .page')) {
        const r = el.getBoundingClientRect();
        const gap = cy < r.top ? r.top - cy : cy > r.bottom ? cy - r.bottom : 0;
        if (gap < bestGap) { bestGap = gap; best = el; }
      }
      if (!best) return { page: 0, fx: 0, fy: 0, fw: 0, fh: 0 };
      const r = best.getBoundingClientRect();
      return { page: Number(best.dataset.pageNumber), fx: (b.x - r.left) / r.width, fy: (b.y - r.top) / r.height, fw: b.w / r.width, fh: b.h / r.height };
    },
    locate(t) {
      const el = pageEl(t.page);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + t.fx * r.width, y: r.top + t.fy * r.height, w: t.fw * r.width, h: t.fh * r.height };
    },
    clip() { const c = doc.getElementById('viewerContainer'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: c.clientWidth, h: c.clientHeight }; },
    reveal(t) { const el = pageEl(t.page); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' }); },
  };
}

// Source text to run in the page (Claude's isolated world). With `viewer` (Lumen's PDF viewer) marks keep to PDF pages. The answer is plain JSON.
function overlayScript(spec, { viewer = false } = {}) {
  const full = { ...spec, maxTotal: MAX_TOTAL, ...(viewer ? { fast: true } : {}) };
  return `(() => {
    const viewerSpace = ${viewerSpace.toString()};
    const r = (${overlayMain.toString()})(${JSON.stringify(full)}, { document, window, space: ${viewer ? 'viewerSpace(window, document)' : 'undefined'} });
    return { ok: r.ok, drawn: r.drawn, missing: r.missing, frozen: r.frozen, cleared: Boolean(r.cleared) };
  })()`;
}
const clearScript = () => `(() => { const b = window.__lumenDraw; if (!b || !b.alive) return false; b.destroy(); return true; })()`;

// Where a ref's element is, for the screenshot path and frames: the viewport box in the main frame's px, or null. Run in the
// element's own frame (add that frame's offset to the result).
const rectScript = (id) => `(() => {
  const entry = (window.__claudeEls || [])[${Number(id)} - 1];
  const e = entry && entry.el;
  if (!e || !e.isConnected) return null;
  const vh = innerHeight, r0 = e.getBoundingClientRect();
  if (r0.bottom < 0 || r0.top > vh) e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = e.getBoundingClientRect();
  if (!(r.width > 0 || r.height > 0)) return null;
  let x = r.left, y = r.top;
  for (let i = (entry.chain || []).length - 1; i >= 0; i--) { const f = entry.chain[i].getBoundingClientRect(); x += f.left + entry.chain[i].clientLeft; y += f.top + entry.chain[i].clientTop; }
  return { x, y, w: r.width, h: r.height };
})()`;

// ---------- a plain-string DOM (the screenshot path, and tests) ----------
function miniDom() {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  class Node {
    constructor(tag) { this.tagName = tag; this.nodeName = tag; this.nodeType = 1; this.attrs = {}; this.children = []; this.style = { cssText: '' }; this.textContent = ''; this.parentNode = null; this.listeners = {}; this.isConnected = true; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this); this.parentNode = null; }
    attachShadow() { this.shadow = new Node('#shadow'); return this.shadow; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener() {}
    toString() {
      const attrs = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
      return `<${this.tagName}${attrs}>${esc(this.textContent)}${this.children.map(String).join('')}</${this.tagName}>`;
    }
  }
  const document = {
    createElementNS: (_ns, tag) => new Node(tag),
    createElement: (tag) => new Node(tag),
    documentElement: new Node('html'),
    body: new Node('body'),
  };
  return { document, Node };
}

// Draws marks (already resolved to boxes of a screenshot, in CSS px) onto a picture. -> SVG source, an <svg> of w x h CSS px
// that holds the picture (a data: URL) and the marks, or { svg: null, missing } when nothing could be placed.
function staticSvg(marks, { w, h, image }) {
  const { document } = miniDom();
  const out = overlayMain({ marks: marks.map((m) => ({ ...m })), clear: false, static: { w, h }, maxTotal: MAX_TOTAL }, {
    document,
    window: { innerWidth: w, innerHeight: h, scrollX: 0, scrollY: 0 },
    space: { capture: (b) => ({ ...b }), locate: (t) => ({ ...t }) },
  });
  if (!out.drawn) return { svg: null, missing: out.missing };
  const inner = out.svg.children.map(String).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><image href="${image}" x="0" y="0" width="${w}" height="${h}"/>${inner}</svg>`;
  return { svg, missing: out.missing, drawn: out.drawn };
}

// An element's box (from rectScript) with the anchor's offsets inside it applied: where a mark in element space goes when it is
// drawn where the element is now (embedded frames, the screenshot path).
function offsetBox(box, a) {
  if (!box || !a || !a.off) return box;
  return { x: box.x + a.off.x, y: box.y + a.off.y, w: a.off.w, h: a.off.h };
}

// What the model is told.
function resultText({ drawn, added, missing, dropped, where, seconds, steps }) {
  const parts = [`Drew ${added} mark${added === 1 ? '' : 's'} on ${where}${drawn > added ? ` (${drawn} on the page now)` : ''}. The user sees them over the page${seconds ? ` for ${seconds} s` : ' until they click "Clear drawings" or press Esc'}.`];
  if (missing.length) parts.push(`Not drawn: ${missing.slice(0, 5).join('; ')}.`);
  if (dropped) parts.push(`${dropped} extra mark${dropped === 1 ? '' : 's'} beyond the ${MAX_MARKS} per call were ignored.`);
  if (steps) parts.push('Number your written steps to match the step marks.');
  return parts.join(' ');
}

module.exports = { MAX_MARKS, MAX_TOTAL, MAX_TEXT, MAX_WRITE, MAX_POINTS, MAX_SECONDS, TYPES, COLORS, TOOL, extendTools, coerce, parseTarget, shotToCss, shotScaleOf, normalize, choosePath, overlayMain, viewerSpace, overlayScript, clearScript, rectScript, miniDom, staticSvg, offsetBox, resultText };
