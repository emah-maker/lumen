// ---------- the AI's annotate tool: draw on the page to explain it ----------
// A teacher drawing on the screen: box / circle / arrow / highlight / label / step / spotlight / underline marks,
// pinned to an element (a read_page / find id, or `text:…`) so they follow it on scroll and resize, or to a spot of
// the latest screenshot (viewport px, anchored to the page where it was drawn).
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
// itself. test/annotate-units.js runs it against a fake DOM.

const MAX_MARKS = 20; // per call
const MAX_TOTAL = 30; // on the page at once (the oldest go)
const MAX_TEXT = 80;
const MAX_SECONDS = 600;
const TYPES = ['box', 'circle', 'arrow', 'highlight', 'label', 'step', 'spotlight', 'underline'];
const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'black', 'white'];
const COORD_LIMIT = 20000;

const TOOL = {
  name: 'annotate',
  description: 'Draw on the page to explain it: marks:[{type:box|circle|arrow|highlight|label|step|spotlight|underline, target: element id or "text:…", x,y,w,h: screenshot px, to:{target|x,y} (arrow tip), text, color}]. Screenshot or find first; number steps like your answer. clear:true removes drawings.',
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
            to: { type: 'object', properties: { target: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } } },
            text: { type: 'string' },
            color: { type: 'string', enum: COLORS },
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

// The anchor a mark or an arrow's `to` names: an element / text, or a box in viewport CSS px (w, h may be 0: a point).
// -> { ref } | { text } | { box: { x, y, w, h } } | null
function anchorOf(o, scale, where) {
  if (!o || typeof o !== 'object') return null;
  if (o.target !== undefined && o.target !== null && o.target !== '') return parseTarget(o.target, where);
  const x = num(o.x), y = num(o.y);
  if (x === null || y === null) return null;
  if (!scale) throw new Error(`${where}: x,y need a screenshot of this tab first (they are pixels of it), or use target.`);
  const w = num(o.w), h = num(o.h);
  return { box: { x: shotToCss(x, scale), y: shotToCss(y, scale), w: w && w > 0 ? shotToCss(w, scale) : 0, h: h && h > 0 ? shotToCss(h, scale) : 0 } };
}

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
    const at = anchorOf(m, scale, where);
    const to = m.to === undefined ? null : anchorOf(m.to, scale, `${where}.to`);
    if (m.to !== undefined && !to) throw new Error(`${where}.to needs a target, or x and y.`);
    if (!at && !(m.type === 'arrow' && to)) throw new Error(`${where}: say where: target (element id or "text:…"), or x and y of the screenshot.`);
    if (m.type === 'arrow' && !to && !at) throw new Error(`${where}: an arrow needs a target or x,y, and usually to.`);
    const text = m.text === undefined || m.text === null ? '' : String(m.text).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_TEXT);
    for (const a of [at, to]) { if (a?.ref) out.usesRefs = true; if (a?.text) out.usesText = true; if (a?.box) out.usesBox = true; }
    out.marks.push({ type: m.type, at, to, text, color: m.color || null });
  });
  return out;
}

// Which way a call is drawn: 'pdf' (the PDF viewer's frame), 'overlay' (the page), or 'screenshot' (marks on a picture of
// the tab). `failed`: the overlay was tried and could not be put in the page.
function choosePath({ pdf = false, failed = false } = {}) {
  if (failed) return 'screenshot';
  return pdf ? 'pdf' : 'overlay';
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
  const DEFAULT = { box: 'red', circle: 'red', arrow: 'red', underline: 'red', highlight: 'yellow', label: 'blue', step: 'blue', spotlight: 'white' };
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
      return tok;
    },
    locate(tok) {
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
    if (a.tok) { const t = a.tok; return { rects: () => { const r = space.locate(t); return r ? [r] : null; }, frozen: a }; }
    if (a.box) { const tok = space.capture(a.box); return { rects: () => { const r = space.locate(tok); return r ? [r] : null; }, frozen: { tok: { ...tok } } }; }
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
    const layout = () => {
      if (!state.alive) return;
      const s = viewSize();
      setA(svg, { viewBox: `0 0 ${s.w} ${s.h}` });
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
    board = { alive: true, svg, host, dimLayer, markLayer, state, layout, schedule, destroy, viewSize, created: true };
    Object.defineProperty(board, 'alive', { get: () => state.alive, enumerable: true });
    if (live) {
      state.listeners = [];
      const on = (target, type, fn, cap) => { target.addEventListener(type, fn, cap); state.listeners.push([target, type, fn, cap]); };
      on(win, 'scroll', schedule, true);
      on(win, 'resize', schedule, false);
      on(win, 'keydown', (e) => { if (e && e.key === 'Escape') destroy(); }, true); // (the page still gets its Esc)
      pill.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); destroy(); });
      const href = win.location && win.location.href;
      state.timers.push(setInterval(() => { // layout shifts, inner scrollers, a PDF zoom; and a page that moved on (single-page navigation)
        if (win.location && win.location.href !== href) { destroy(); return; }
        layout();
      }, spec.fast ? 60 : 250));
      if (typeof win.ResizeObserver === 'function') { try { state.observer = new win.ResizeObserver(schedule); state.observer.observe(doc.documentElement); } catch { state.observer = null; } }
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
    frozen.push({ type: m.type, at: at ? at.frozen : null, to: to ? to.frozen : null, text: m.text, color: m.color });
  });
  if (scrollOnce) { try { scrollOnce(); } catch { /* no scroll */ } }
  // Over the cap: the oldest marks go.
  while (state.views.length > spec.maxTotal) { const old = state.views.shift(); old.remove(); }
  board.layout();
  if (live && spec.seconds) state.timers.push(setTimeout(board.destroy, spec.seconds * 1000));
  return { ok: true, drawn: state.views.length, missing, frozen, created, board, host: board.host, svg: board.svg };

  // ---- one mark
  function makeView(m, at, to, index) {
    const c = colorOf(m.color, m.type);
    const rnd = makeRng(state.seed * 131 + index * 977 + m.type.length);
    state.seed++;
    const delay = Math.min(index, 8) * 140;
    const parts = [];
    const add = (tag, attrs, layer) => { const e = el(tag, attrs, layer || board.markLayer); parts.push(e); return e; };
    // A hand-drawn stroke: a halo underneath (so it reads on any background) and the colour on top.
    const stroke = (width, extra) => {
      const common = { fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', pathLength: 1, 'stroke-dasharray': 1, ...(extra || {}) };
      const halo = add('path', { ...common, stroke: c.halo, 'stroke-opacity': c.haloOpacity, 'stroke-width': width + 4 });
      const main = add('path', { ...common, stroke: c.hex, 'stroke-width': width });
      for (const p of [halo, main]) play(p, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 460, delay, fill: 'backwards', easing: 'ease-out' });
      return (d) => { halo.setAttribute('d', d); main.setAttribute('d', d); };
    };
    const popIn = (e) => play(e, [{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay, fill: 'backwards' });
    const rectsOf = (a) => (a ? a.rects() : null);
    const view = { type: m.type, remove: () => parts.forEach((p) => { try { p.remove(); } catch { /* gone */ } }), update: () => {} };

    if (m.type === 'box' || m.type === 'circle') {
      const set = stroke(4);
      view.update = () => {
        const rs = rectsOf(at);
        if (!rs || !rs.length) { parts.forEach((p) => p.setAttribute('visibility', 'hidden')); return; }
        parts.forEach((p) => p.setAttribute('visibility', 'visible'));
        const b = sized(bounds(rs), 40);
        const r = makeRng(index * 977 + 13);
        set(m.type === 'box' ? rectPath(b, 5, r) : ellipsePath(b, r));
      };
      if (m.text) addCallout(view, m, at, c, delay, add, popIn, rectsOf);
    } else if (m.type === 'underline') {
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
          const y = r.y + r.h + 2;
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
    } else if (m.type === 'arrow') {
      const body = stroke(4);
      const head = stroke(4);
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
        const bow = len * 0.12 * (index % 2 ? -1 : 1);
        const ctl = { x: (tail.x + tip.x) / 2 - (dy / len) * bow, y: (tail.y + tip.y) / 2 + (dx / len) * bow };
        body(`M${f(tail.x)} ${f(tail.y)}Q${f(ctl.x)} ${f(ctl.y)} ${f(tip.x)} ${f(tip.y)}`);
        const ang = Math.atan2(tip.y - ctl.y, tip.x - ctl.x);
        const hl = Math.min(18, Math.max(9, len * 0.35));
        const p1 = { x: tip.x - Math.cos(ang - 0.45) * hl, y: tip.y - Math.sin(ang - 0.45) * hl };
        const p2 = { x: tip.x - Math.cos(ang + 0.45) * hl, y: tip.y - Math.sin(ang + 0.45) * hl };
        head(`M${f(p1.x)} ${f(p1.y)}L${f(tip.x)} ${f(tip.y)}L${f(p2.x)} ${f(p2.y)}`);
      };
      if (m.text) addCallout(view, m, at || to, c, delay, add, popIn, rectsOf, true);
    } else if (m.type === 'label') {
      addCallout(view, m, at, c, delay, add, popIn, rectsOf);
      if (!m.text) return null;
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

  // A speech-bubble label next to the target (above it, or below when there is no room), pointing at it.
  function addCallout(view, m, at, c, delay, add, popIn, rectsOf, anchoredToPoint) {
    if (!m.text) return;
    const lines = wrap(m.text, 26);
    const width = Math.max(...lines.map((l) => l.length)) * 7.4 + 20;
    const height = lines.length * 18 + 12;
    const tail = add('path', { fill: c.hex, stroke: '#ffffff', 'stroke-width': 2, 'stroke-linejoin': 'round' });
    const box = add('rect', { rx: 8, fill: c.hex, stroke: '#ffffff', 'stroke-width': 2 });
    const text = add('text', { 'font-size': 14, 'font-weight': 600, fill: c.ink, 'font-family': 'system-ui,-apple-system,Segoe UI,sans-serif' });
    const spans = lines.map((line) => { const t = el('tspan', {}, text); t.textContent = line; return t; });
    for (const p of [tail, box, text]) popIn(p);
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
      if (!anchoredToPoint) place(sized(bounds(rs), 12), s);
      else place({ ...sized(bounds(rs), 0), x: bounds(rs).x, y: bounds(rs).y, w: 0, h: 0 }, s);
    };
  }
}

// ---------- the PDF viewer's space ----------
// Runs inside the PDF viewer's frame (pdf-zoom.js viewerFrame), where the viewer's viewport is. A box of the screen is kept as
// page number + position on that page (in the page's own units, before zoom), so a mark follows scroll and zoom. null when the
// viewer's viewport is out of reach.
function pdfSpace(win, doc) {
  const deep = (root, tag) => {
    for (const e of root.querySelectorAll('*')) {
      if (e.tagName === tag) return e;
      if (e.shadowRoot) { const hit = deep(e.shadowRoot, tag); if (hit) return hit; }
    }
    return null;
  };
  const viewer = doc.querySelector('pdf-viewer') || deep(doc, 'PDF-VIEWER');
  const vp = viewer && (viewer.viewport_ || viewer.viewport);
  if (!vp || !vp.position || !Array.isArray(vp.pageDimensions_) || !vp.pageDimensions_.length) return null;
  const zoom = () => (typeof vp.getZoom === 'function' ? vp.getZoom() : vp.zoom) || 1;
  return {
    capture(b) {
      const z = zoom(), pos = vp.position, dims = vp.pageDimensions_;
      const cx = (b.x + b.w / 2 + pos.x) / z, cy = (b.y + b.h / 2 + pos.y) / z;
      let page = 0;
      for (let i = 0; i < dims.length; i++) if (dims[i].y <= cy) page = i;
      const d = dims[page];
      return { page, x: (b.x + pos.x) / z - d.x, y: (b.y + pos.y) / z - d.y, w: b.w / z, h: b.h / z };
    },
    locate(tok) {
      const d = vp.pageDimensions_[tok.page];
      if (!d) return null;
      const z = zoom(), pos = vp.position;
      return { x: (d.x + tok.x) * z - pos.x, y: (d.y + tok.y) * z - pos.y, w: tok.w * z, h: tok.h * z };
    },
  };
}

// Source text to run in the page (Claude's isolated world) or, with `pdf`, in the PDF viewer's frame. The answer is plain JSON.
function overlayScript(spec, { pdf = false } = {}) {
  const full = { ...spec, maxTotal: MAX_TOTAL, ...(pdf ? { fast: true } : {}) };
  return `(() => {
    const pdfSpace = ${pdfSpace.toString()};
    const space = ${pdf ? 'pdfSpace(window, document)' : 'null'};
    if (${pdf} && !space) return { ok: false, error: 'viewer' };
    const r = (${overlayMain.toString()})(${JSON.stringify(full)}, { document, window, space: space || undefined });
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

// What the model is told.
function resultText({ drawn, added, missing, dropped, where, seconds, steps }) {
  const parts = [`Drew ${added} mark${added === 1 ? '' : 's'} on ${where}${drawn > added ? ` (${drawn} on the page now)` : ''}. The user sees them over the page${seconds ? ` for ${seconds} s` : ' until they click "Clear drawings" or press Esc'}.`];
  if (missing.length) parts.push(`Not drawn: ${missing.slice(0, 5).join('; ')}.`);
  if (dropped) parts.push(`${dropped} extra mark${dropped === 1 ? '' : 's'} beyond the ${MAX_MARKS} per call were ignored.`);
  if (steps) parts.push('Number your written steps to match the step marks.');
  return parts.join(' ');
}

module.exports = { MAX_MARKS, MAX_TOTAL, MAX_TEXT, MAX_SECONDS, TYPES, COLORS, TOOL, extendTools, coerce, parseTarget, shotToCss, normalize, choosePath, overlayMain, pdfSpace, overlayScript, clearScript, rectScript, miniDom, staticSvg, resultText };
