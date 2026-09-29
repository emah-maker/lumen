// New-tab widget layout: pure functions, no DOM, no Electron. Used by the main process
// (features/widgets.js validates and migrates what is stored), by the new-tab page
// (renderer/newtab-widgets.js drags, resizes and draws) and by the unit tests.
//
// A layout is a list of items { id, type, x, y, w, h, snap? } in grid cells: COLS (12) columns wide,
// rows as tall as you like. The page also has an obstacle: the centre column (greeting, search,
// shortcuts) is a rect { x, y: 0, w, h } that widgets never overlap; they sit beside it or below.
//
//   resolve(items, o)          a valid layout: nothing overlaps, in bounds, out of the obstacle
//   move(items, id, to, o)     put one item somewhere; the rest are pushed out of the way
//   resize(items, id, r, o)    the same for a new size (and edge), clamped to the type's limits
//   snapMove(items, id, t, o)  dock an item to a side, a corner or the top, like Windows Snap
//   compact(items, o)          pull everything up as far as it goes ("Keep widgets packed")
//   stack(items, o)            the narrow-window fallback: one column ordered by (y, x)
// Every function returns new items, in the order it was given them, and never changes its input.
// o = { cols = COLS, obstacle = null, packed = true, rows } (rows: how many rows the window shows,
// for snapping; see pageRows).
//
// Snapping: an item with `snap` ('left' | 'right' full-height docks in the side area beside the
// obstacle, 'tl' 'tr' 'bl' 'br' half-height docks, 'top' a banner above the obstacle) keeps
// hugging that place: resolve() re-derives its rect for the current window. A banner pushes the
// obstacle down by bannerRows(). Moving or resizing an item by hand drops its snap.
(function () {
'use strict';

const COLS = 12;
const ROW = 56; // px, one row of cells
const GAP = 12; // px between cells
const MAX_Y = 200;
// Any size from 2x2 cells up to the whole grid width and 20 rows, for every kind of card: the
// content adapts to the box it is given (container queries in newtab.html), it isn't cut.
const LIMITS = {
  weather: { minW: 2, minH: 2, maxW: 12, maxH: 20 },
  calendar: { minW: 2, minH: 2, maxW: 12, maxH: 20 },
  todoist: { minW: 2, minH: 2, maxW: 12, maxH: 20 },
  embed: { minW: 2, minH: 2, maxW: 12, maxH: 20 },
  muse: { minW: 3, minH: 3, maxW: 12, maxH: 20 },
};
const FALLBACK_LIMITS = { minW: 2, minH: 2, maxW: 12, maxH: 20 };
const DEFAULT_SIZE = { weather: { w: 4, h: 3 }, calendar: { w: 6, h: 5 }, todoist: { w: 6, h: 5 }, muse: { w: 4, h: 4 }, embed: { w: 12, h: 6 } };
// Quick sizes in edit mode.
const PRESETS = { small: { w: 3, h: 2 }, medium: { w: 4, h: 3 }, large: { w: 6, h: 5 }, wide: { w: 8, h: 3 }, tall: { w: 3, h: 7 } };
// What older Lumens stored: a width of 2, 3, 4 or 6 of six columns and, for a web page, a frame height.
const SPANS = [2, 3, 4, 6];
const FRAME_PX = { small: 200, medium: 340, large: 500, tall: 720 };
const LEGACY_ROWS = { weather: 3, calendar: 5, todoist: 5, muse: 4 }; // what auto height came to
const CARD_CHROME = 64; // px of a card around its frame: header, padding
const SNAPS = ['left', 'right', 'top', 'tl', 'tr', 'bl', 'br'];

const limitsOf = (type) => LIMITS[type] || FALLBACK_LIMITS;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const rectOf = (it) => ({ x: it.x, y: it.y, w: it.w, h: it.h });
const same = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const clone = (it) => ({ ...it });
const withoutSnap = (it) => { const { snap, ...rest } = it; return rest; };
const flowSort = (list) => list.map((it, i) => [it, i]).sort((a, b) => a[0].y - b[0].y || a[0].x - b[0].x || a[1] - b[1]).map((p) => p[0]);
// The result of a function, in the caller's order.
const inOrder = (items, out) => { const by = new Map(out.map((it) => [it.id, it])); return items.map((it) => by.get(it.id)); };
const family = (s) => (s === 'left' || s === 'tl' || s === 'bl' ? 'left' : s === 'right' || s === 'tr' || s === 'br' ? 'right' : s === 'top' ? 'top' : null);
const cleanSnap = (v) => (SNAPS.includes(v) ? v : undefined);

// A stored or received rect -> a checked one, or null when it isn't four integers. Numbers out of
// range are clamped, not refused.
function cleanRect(type, r, cols = COLS) {
  if (!r || typeof r !== 'object') return null;
  const { x, y, w, h } = r;
  if (![x, y, w, h].every(Number.isInteger)) return null;
  const L = limitsOf(type);
  const cw = clamp(w, L.minW, Math.min(L.maxW, cols));
  return { x: clamp(x, 0, cols - cw), y: clamp(y, 0, MAX_Y), w: cw, h: clamp(h, L.minH, L.maxH) };
}

// ---- legacy: span and height -> cells ----
const nearest = (list, value, of = (x) => x) => list.reduce((best, x) => (Math.abs(of(x) - value) < Math.abs(of(best) - value) ? x : best));
const frameHeight = (rows) => rows * (ROW + GAP) - GAP - CARD_CHROME; // an embed's frame in px
// { w, h } for what an older Lumen stored (span 2/3/4/6, height small..tall), clamped to the type's limits.
function sizeFromLegacy(type, span, height) {
  const L = limitsOf(type);
  const s = SPANS.includes(span) ? span : type === 'embed' ? 6 : 3;
  const rows = type === 'embed' ? Math.round(((FRAME_PX[height] || FRAME_PX.medium) + CARD_CHROME + GAP) / (ROW + GAP)) : (LEGACY_ROWS[type] ?? 6);
  return { w: clamp(s * 2, L.minW, L.maxW), h: clamp(rows, L.minH, L.maxH) };
}
// What to keep saying to an older Lumen: { span, height? } for a rect.
function mirror(type, r) {
  const out = { span: nearest(SPANS, r.w / 2) };
  if (type === 'embed') out.height = nearest(Object.keys(FRAME_PX), frameHeight(r.h), (k) => FRAME_PX[k]);
  return out;
}
// Flow layout (columns, cards wrapping when the next doesn't fit) -> rects, in the same order.
// sizes: [{ w, h }].
function flowPack(sizes, cols = COLS) {
  const out = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const { w, h } of sizes) {
    if (x + w > cols) { y += rowH; x = 0; rowH = 0; }
    out.push({ x, y, w, h });
    x += w;
    rowH = Math.max(rowH, h);
  }
  return out;
}
// What older Lumens stored (six columns, cards wrapping) -> rects, same order and sizes.
// items: [{ type, span?, height? }].
const fromLegacy = (items, cols = COLS) => flowPack(items.map((it) => sizeFromLegacy(it.type, it.span, it.height)), cols);

// ---- placing ----
// Where a rect goes to get out of `blockers`: below them, or sideways when that is shorter.
function escape(r, blockers, cols) {
  const down = { ...r };
  for (let guard = 0; guard < 1000; guard++) {
    const hit = blockers.find((b) => overlap(down, b));
    if (!hit) break;
    down.y = hit.y + hit.h;
  }
  const downCost = down.y - r.y;
  let best = null;
  for (const b of blockers.filter((o) => overlap(r, o))) {
    for (const x of [b.x - r.w, b.x + b.w]) {
      if (x < 0 || x + r.w > cols) continue;
      const side = { ...r, x };
      if (blockers.some((o) => overlap(side, o))) continue;
      const cost = Math.abs(x - r.x);
      if (!best || cost < best.cost) best = { rect: side, cost };
    }
  }
  return best && best.cost < downCost ? best.rect : down;
}
// Everything in `rest` that collides with something already placed (or the obstacle) is moved out
// of the way, in reading order, so the layout is deterministic.
function settleRest(rest, placed, cols, obstacle) {
  const blockers = [...placed];
  if (obstacle) blockers.push(obstacle);
  const out = [];
  for (const it of flowSort(rest)) {
    let r = { ...it, w: Math.min(it.w, cols) };
    r.x = clamp(r.x, 0, cols - r.w);
    if (blockers.some((b) => overlap(r, b))) r = escape(r, blockers, cols);
    out.push(r);
    blockers.push(r);
  }
  return out;
}
// Move each item up while nothing is in the way. Snapped items stay where they are.
function compact(items, { cols = COLS, obstacle = null } = {}) {
  const fixed = items.filter((it) => it.snap);
  const placed = [...(obstacle ? [obstacle] : []), ...fixed];
  const out = fixed.map(clone);
  for (const it of flowSort(items.filter((o) => !o.snap))) {
    const r = { ...it, w: Math.min(it.w, cols) };
    r.x = clamp(r.x, 0, cols - r.w);
    while (r.y > 0 && !placed.some((b) => overlap({ ...r, y: r.y - 1 }, b))) r.y--;
    placed.push(r);
    out.push(r);
  }
  return inOrder(items, out);
}

// ---- snapping ----
// The window's rows for docks: how many rows of cells fit in a window `height` px tall.
const pageRows = (height, m) => Math.max(2, Math.floor((height - m.top + GAP) / m.pitchY));
// Which snap zone a pointer (viewport px) is in, or null: within `edge` px of the left or right
// edge (a corner when also near the top or bottom), or of the top edge (a corner when near a side).
function detectSnap(p, view, { edge = 24, corner = 88 } = {}) {
  if (!p || !view || ![p.x, p.y, view.width, view.height].every(Number.isFinite)) return null;
  const nearL = p.x <= edge;
  const nearR = p.x >= view.width - edge;
  const nearT = p.y <= edge;
  const nearB = p.y >= view.height - edge;
  const inL = p.x <= corner;
  const inR = p.x >= view.width - corner;
  const inT = p.y <= corner;
  const inB = p.y >= view.height - corner;
  if ((nearL || nearT) && inL && inT) return 'tl';
  if ((nearR || nearT) && inR && inT) return 'tr';
  if ((nearL || nearB) && inL && inB) return 'bl';
  if ((nearR || nearB) && inR && inB) return 'br';
  if (nearL) return 'left';
  if (nearR) return 'right';
  if (nearT) return 'top';
  return null;
}
// The rect for a snap, or null when it doesn't fit (a side area narrower than the type's minimum,
// a one-column window). y0: the row below any banner, where docks start.
function snapRectFor(snap, it, o, y0 = 0) {
  const cols = o.cols ?? COLS;
  const fam = family(snap);
  if (!fam || cols === 1) return null;
  const L = limitsOf(it.type);
  if (fam === 'top') return { x: 0, y: 0, w: Math.min(cols, L.maxW), h: clamp(Math.max(2, L.minH), L.minH, L.maxH) };
  const ob = o.obstacle;
  if (!ob || !(o.rows >= 2)) return null;
  const sideW = fam === 'left' ? ob.x : cols - ob.x - ob.w;
  if (sideW < L.minW) return null;
  const w = Math.min(sideW, L.maxW);
  const avail = Math.max(2, o.rows - y0);
  const half = snap === 'left' || snap === 'right' ? avail : Math.floor(avail / 2);
  const h = clamp(half, L.minH, L.maxH);
  return { x: fam === 'left' ? 0 : cols - w, y: snap === 'bl' || snap === 'br' ? y0 + avail - h : y0, w, h };
}
// Snapped items get the rect their snap means today (banners stacked first, docks below them).
function derive(items, o) {
  const cols = o.cols ?? COLS;
  const out = items.map(clone);
  if (cols === 1 || !out.some((it) => it.snap)) return out;
  let y = 0;
  for (const it of flowSort(out.filter((i) => i.snap === 'top'))) {
    const r = snapRectFor('top', it, o);
    if (r) { Object.assign(it, r, { y }); y += r.h; }
  }
  for (const it of out) {
    if (!it.snap || it.snap === 'top') continue;
    const r = snapRectFor(it.snap, it, o, y);
    if (r) Object.assign(it, r);
  }
  return out;
}
// How many rows of banner sit over the obstacle's columns: the obstacle starts below them.
function bannerRows(items, o = {}) {
  const ob = o.obstacle;
  if (!ob || o.cols === 1) return 0;
  let k = 0;
  for (const it of derive(items, o)) if (it.snap === 'top' && it.x < ob.x + ob.w && it.x + it.w > ob.x) k = Math.max(k, it.y + it.h);
  return k;
}
// Items with a snap hint that no longer sit where it means (something pushed them) lose the hint.
function prune(items, o) {
  const d = derive(items, o);
  return items.map((it, i) => (it.snap && !same(it, d[i]) ? withoutSnap(it) : it));
}
const prep = (items, o) => {
  const list = derive(items, o);
  const k = bannerRows(list, o);
  return { list, ob: o.obstacle ? { ...o.obstacle, y: o.obstacle.y + k } : null };
};
// The last step of every change: `moved` is fixed, snapped items settle around it, the rest around them.
function finish(items, moved, others, cols, ob, packed, o) {
  const a = settleRest(others.filter((i) => i.snap), [moved], cols, ob);
  const b = settleRest(others.filter((i) => !i.snap), [moved, ...a], cols, ob);
  let out = [moved, ...a, ...b];
  if (packed) out = compact(out, { cols, obstacle: ob });
  return inOrder(items, prune(out, o));
}

function resolve(items, o = {}) {
  const { cols = COLS, packed = true } = o;
  if (cols === 1) return stack(items, o);
  const { list, ob } = prep(items, o);
  const a = settleRest(list.filter((i) => i.snap), [], cols, ob);
  const b = settleRest(list.filter((i) => !i.snap), a, cols, ob);
  let out = [...a, ...b];
  if (packed) out = compact(out, { cols, obstacle: ob });
  return inOrder(items, out);
}
// One column, in reading order, below the obstacle. Saved positions are untouched (this is a view).
function stack(items, { obstacle = null } = {}) {
  let y = obstacle ? obstacle.y + obstacle.h : 0;
  const out = [];
  for (const it of flowSort(items)) {
    out.push({ ...it, x: 0, w: 1, y });
    y += it.h;
  }
  return inOrder(items, out);
}
// The nearest place for a rect that is inside the obstacle: below it, or beside it.
function nearestFree(r, obstacle, cols) {
  const options = [{ ...r, y: obstacle.y + obstacle.h }];
  if (obstacle.x - r.w >= 0) options.push({ ...r, x: obstacle.x - r.w });
  if (obstacle.x + obstacle.w + r.w <= cols) options.push({ ...r, x: obstacle.x + obstacle.w });
  return options.reduce((best, o) => (Math.abs(o.x - r.x) + Math.abs(o.y - r.y) < Math.abs(best.x - r.x) + Math.abs(best.y - r.y) ? o : best));
}

function move(items, id, to, o = {}) {
  const { cols = COLS, packed = true } = o;
  if (cols === 1) return items.map(clone);
  const found = items.find((i) => i.id === id);
  if (!found || !Number.isFinite(to?.x) || !Number.isFinite(to?.y)) return items.map(clone);
  const { list, ob } = prep(items.map((i) => (i.id === id ? withoutSnap(i) : i)), o);
  const it = list.find((i) => i.id === id);
  let r = { ...it, w: Math.min(it.w, cols) };
  r.x = clamp(Math.round(to.x), 0, cols - r.w);
  r.y = clamp(Math.round(to.y), 0, MAX_Y);
  if (ob && overlap(r, ob)) r = nearestFree(r, ob, cols);
  return finish(items, r, list.filter((i) => i.id !== id), cols, ob, packed, o);
}

// Fit a wanted rect to the item's limits, keeping the edges that were not dragged where they were.
function fitRect(it, want, cols) {
  const L = limitsOf(it.type);
  let { x, y, w, h } = want;
  const leftMoved = x !== it.x && x + w === it.x + it.w;
  const topMoved = y !== it.y && y + h === it.y + it.h;
  w = clamp(w, L.minW, Math.min(L.maxW, cols));
  h = clamp(h, L.minH, L.maxH);
  if (leftMoved) {
    const right = it.x + it.w;
    x = Math.max(0, right - w);
    w = right - x;
  } else {
    x = it.x;
    w = Math.min(w, cols - x);
  }
  if (topMoved) {
    const bottom = it.y + it.h;
    y = Math.max(0, bottom - h);
    h = bottom - y;
  } else {
    y = it.y;
  }
  return { ...it, x, y, w, h };
}
// A resize that runs into the obstacle stops at it (on the side the card is on).
function stopAtObstacle(r, orig, ob) {
  if (!ob || !overlap(r, ob)) return r;
  const L = limitsOf(r.type);
  const out = { ...r };
  if (orig.x + orig.w <= ob.x) out.w = ob.x - out.x;
  else if (orig.x >= ob.x + ob.w) { const right = out.x + out.w; out.x = ob.x + ob.w; out.w = right - out.x; }
  else if (orig.y >= ob.y + ob.h) { const bottom = out.y + out.h; out.y = ob.y + ob.h; out.h = bottom - out.y; }
  else return orig;
  return out.w < L.minW || out.h < L.minH ? orig : out;
}
// want: { x, y, w, h }, the rect the pointer asks for (a dragged edge or corner changes x/y as well).
function resize(items, id, want, o = {}) {
  const { cols = COLS, packed = true } = o;
  if (cols === 1) return items.map(clone);
  const found = items.find((i) => i.id === id);
  if (!found || ![want?.x, want?.y, want?.w, want?.h].every(Number.isFinite)) return items.map(clone);
  const { list, ob } = prep(items, o);
  const it = withoutSnap(list.find((i) => i.id === id));
  const r = stopAtObstacle(fitRect(it, { x: Math.round(want.x), y: Math.round(want.y), w: Math.round(want.w), h: Math.round(want.h) }, cols), it, ob);
  return finish(items, r, list.filter((i) => i.id !== id), cols, ob, packed, o);
}

// Dock an item: target = { snap, frac? } (frac: where the pointer is down the window, 0..1, which
// decides top or bottom half when a side is already taken). A full-height dock that is taken
// splits into halves; a half that is taken sends its owner to the other half. Nothing overlaps:
// what doesn't fit is pushed like anything else. Returns the layout unchanged if the snap doesn't
// fit this window (see snapRectFor).
function snapMove(items, id, target, o = {}) {
  const { cols = COLS, packed = true } = o;
  const base = items.map(clone);
  const it = base.find((i) => i.id === id);
  if (!it || cols === 1 || !SNAPS.includes(target?.snap)) return base;
  if (!snapRectFor(target.snap, it, { ...o, cols })) return base;
  const fam = family(target.snap);
  let snap = target.snap;
  if (fam === 'top') {
    it.y = -1; // above the banners already there
  } else {
    const full = fam === 'left' ? 'left' : 'right';
    const mates = base.filter((i) => i.id !== id && i.snap && family(i.snap) === fam);
    if (snap === full && mates.length) {
      const upper = (Number.isFinite(target.frac) ? target.frac : 0) < 0.5;
      snap = fam === 'left' ? (upper ? 'tl' : 'bl') : (upper ? 'tr' : 'br');
    }
    const upperSlot = snap === 'tl' || snap === 'tr';
    const otherSlot = fam === 'left' ? (upperSlot ? 'bl' : 'tl') : (upperSlot ? 'br' : 'tr');
    for (const m of mates) {
      if ((m.snap === full || m.snap === snap) && !mates.some((z) => z !== m && z.snap === otherSlot)) m.snap = otherSlot;
    }
  }
  it.snap = snap;
  const { list, ob } = prep(base, o);
  return finish(items, list.find((i) => i.id === id), list.filter((i) => i.id !== id), cols, ob, packed, o);
}
// Ctrl+Alt+arrow: where an item's snap goes next (Windows' Win+arrow), or null for nothing.
function keySnap(dir, current) {
  const fam = family(current);
  if (dir === 'ArrowLeft') return 'left';
  if (dir === 'ArrowRight') return 'right';
  if (dir === 'ArrowUp') return fam === 'left' ? 'tl' : fam === 'right' ? 'tr' : 'top';
  if (dir === 'ArrowDown') return fam === 'left' ? 'bl' : fam === 'right' ? 'br' : null;
  return null;
}

// The first free place for a new item of a size, reading order.
function firstFit(items, { w, h }, cols = COLS, obstacle = null) {
  const blockers = [...items];
  if (obstacle) blockers.push(obstacle);
  for (let y = 0; y <= MAX_Y; y++) {
    for (let x = 0; x + w <= cols; x++) {
      const r = { x, y, w, h };
      if (!blockers.some((b) => overlap(r, b))) return { x, y };
    }
  }
  return { x: 0, y: MAX_Y };
}

const flowOrder = (items) => flowSort(items);

// ---- the page's grid ----
// Cell metrics for a page width: 12 columns from 900 px up, one column below. `top` is where row 0
// starts. Pure, so tests can use the numbers the page does.
function metrics(width) {
  const cols = width >= 900 ? COLS : 1;
  const pad = width >= 1100 ? 32 : 16;
  const cw = (width - pad * 2 - GAP * (cols - 1)) / cols;
  return { cols, pad, top: 16, cw, pitchX: cw + GAP, pitchY: ROW + GAP, width };
}
// The centre column's box (page px: left, right, bottom) -> an obstacle rect in cells.
function obstacleFor(box, m, margin = 12) {
  const rows = Math.max(0, Math.ceil((box.bottom - m.top + GAP) / m.pitchY));
  if (m.cols === 1) return { x: 0, y: 0, w: 1, h: rows };
  let first = -1;
  let last = -1;
  for (let c = 0; c < m.cols; c++) {
    const left = m.pad + c * m.pitchX;
    if (left + m.cw > box.left - margin && left < box.right + margin) { if (first < 0) first = c; last = c; }
  }
  return first < 0 ? null : { x: first, y: 0, w: last - first + 1, h: rows };
}
const cellToPx = (r, m) => ({ left: m.pad + r.x * m.pitchX, top: m.top + r.y * m.pitchY, width: r.w * m.cw + (r.w - 1) * GAP, height: r.h * ROW + (r.h - 1) * GAP });

// ---- talking to the browser process ----
// "wabc:0,0,4,3;wdef:6,0,6,5,tr": the whole layout, in one URL parameter (snap optional).
const encode = (items) => items.map((it) => `${it.id}:${it.x},${it.y},${it.w},${it.h}${it.snap ? `,${it.snap}` : ''}`).join(';');
function decode(text) {
  if (typeof text !== 'string' || text.length > 2000) return null;
  const out = [];
  for (const part of text.split(';')) {
    const m = /^(w[0-9a-z]{4,20}):(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3})(?:,(left|right|top|tl|tr|bl|br))?$/.exec(part);
    if (!m) return null;
    const it = { id: m[1], x: Number(m[2]), y: Number(m[3]), w: Number(m[4]), h: Number(m[5]) };
    if (m[6]) it.snap = m[6];
    out.push(it);
  }
  return out.length && out.length <= 24 ? out : null;
}

const api = {
  COLS, ROW, GAP, MAX_Y, LIMITS, DEFAULT_SIZE, PRESETS, SPANS, SNAPS, FRAME_PX,
  limitsOf, cleanRect, cleanSnap, sizeFromLegacy, mirror, fromLegacy, flowPack, overlap, rectOf, same,
  resolve, move, resize, snapMove, keySnap, detectSnap, snapRectFor, bannerRows, pageRows, compact, stack, firstFit, flowOrder,
  metrics, obstacleFor, cellToPx, encode, decode,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.WidgetLayout = api;
})();
