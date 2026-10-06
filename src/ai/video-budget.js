// ---------- video_overview / video_frames: timestamps, image-token estimates and fitting a contact sheet to a budget ----------
// Pure (no Electron, no page), so the maths is testable. features/video-capture.js does the capturing.
//
// Token figures are ESTIMATES from the providers' published sizing rules (checked against their docs as of
// 2026; models change them, so treat the numbers as +-20%):
//   anthropic  an image is resized so its long edge is <= 1568 px and it is <= ~1,600 tokens (about 1.2 MP);
//              tokens ~ width * height / 750. (Some newer models take bigger images; this stays conservative.)
//   openai     tile based ("high" detail): fit in 2048x2048, shrink so the short side is <= 768, then
//              85 + 170 per 512 px tile. (GPT-5 era patch-based models count 32 px patches; close enough.)
//   gemini     <= 384 px on both sides = 258 tokens; bigger images are tiled, 258 per tile, with a tile of
//              floor(short side / 1.5) clamped to 256..768 px. (Gemini 3 has a media-resolution setting; unverified.)

const DEFAULT_FRAMES = 16;
const MIN_FRAMES = 4;
const MAX_FRAMES = 36;
const MAX_AT = 8; // video_frames
const DEFAULT_BUDGET = 6000; // overview image tokens
const SHEET_MAX_WIDTH = 1568; // where Anthropic downscales anyway; the others resize a similar amount
const GAP = 4;
const MIN_CELL_WIDTH = 120;
const SINGLE_LIMIT = 4; // video_frames: up to this many come back as separate images, more as a 2-column sheet

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

// The model family an image is priced by: from the model string (settings.model, e.g. "claude-sonnet-5",
// "openai:gpt-5", "codex:gpt-5", "antigravity:gemini-3-pro"). Unknown: Anthropic.
function familyOf(model) {
  const m = String(model || '').toLowerCase();
  if (/gemini|antigravity|google/.test(m)) return 'gemini';
  if (/gpt|(^|[:/])o\d|openai|codex|grok|xai/.test(m)) return 'openai';
  return 'anthropic';
}

// What a w x h image costs after the family's own resize: { width, height, tokens } (width/height as the model sees it).
function fitImage(family, w, h) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  if (family === 'openai') {
    let rw = w, rh = h;
    const big = Math.max(rw, rh);
    if (big > 2048) { rw = rw * 2048 / big; rh = rh * 2048 / big; }
    const small = Math.min(rw, rh);
    if (small > 768) { rw = rw * 768 / small; rh = rh * 768 / small; }
    rw = Math.max(1, Math.round(rw)); rh = Math.max(1, Math.round(rh));
    return { width: rw, height: rh, tokens: 85 + 170 * Math.ceil(rw / 512) * Math.ceil(rh / 512) };
  }
  if (family === 'gemini') {
    if (w <= 384 && h <= 384) return { width: w, height: h, tokens: 258 };
    const unit = clamp(Math.floor(Math.min(w, h) / 1.5), 256, 768);
    return { width: w, height: h, tokens: 258 * Math.ceil(w / unit) * Math.ceil(h / unit) };
  }
  let s = Math.min(1, 1568 / Math.max(w, h));
  const tokens = (w * s) * (h * s) / 750;
  if (tokens > 1600) s *= Math.sqrt(1600 / tokens) * 0.998;
  const rw = Math.max(1, Math.floor(w * s)), rh = Math.max(1, Math.floor(h * s));
  return { width: rw, height: rh, tokens: Math.ceil(rw * rh / 750) };
}
const imageTokens = (family, w, h) => fitImage(family, w, h).tokens;

// ---------- timestamps ----------

// 83, "83", "83.5", "83s", "1:23", "1:23.5", "1:02:03" -> seconds; anything else -> null.
function parseTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const s = String(value ?? '').trim().toLowerCase();
  let m = /^(\d+(?:\.\d+)?)s?$/.exec(s);
  if (m) return Number(m[1]);
  m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(s);
  if (!m) return null;
  const [h, mi, se] = [Number(m[1] || 0), Number(m[2]), Number(m[3])];
  if (mi > 59 || se >= 60) return null;
  return h * 3600 + mi * 60 + se;
}

// Seconds -> "m:ss" ("h:mm:ss" from an hour); decimals 1 adds tenths (for a short clip, where whole seconds repeat).
function formatTime(seconds, decimals = 0) {
  const total = Math.max(0, Number(seconds) || 0);
  const unit = decimals > 0 ? 10 : 1;
  const ticks = Math.floor(total * unit + 1e-6);
  const whole = Math.floor(ticks / unit);
  const frac = decimals > 0 ? `.${ticks % unit}` : '';
  const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}${frac}` : `${m}:${ss}${frac}`;
}

// n timestamps spread evenly over [start, end]: the middle of n equal slices, so the first frame is not a black
// opening and the last is not past the end.
function spacedTimes(start, end, n) {
  const span = Math.max(0, end - start);
  return Array.from({ length: n }, (_, i) => Math.min(start + (i + 0.5) * span / n, Math.max(start, end - 0.05)));
}
// Whole seconds repeat on a short clip: tenths when the frames are closer than a second.
const decimalsFor = (start, end, n) => ((end - start) / Math.max(1, n) < 1 ? 1 : 0);

// ---------- layout and fitting ----------

// cols x rows for n cells of the video's aspect, keeping the sheet near 16:10 and few empty cells.
function gridFor(n, aspect = 16 / 9) {
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const sheetAspect = cols * aspect / rows;
    const score = (cols * rows - n) * 10 + Math.abs(Math.log(sheetAspect / 1.6)) * 5;
    if (!best || score < best.score) best = { cols, rows, score };
  }
  return { cols: best.cols, rows: best.rows };
}

function sheetSize({ cols, rows, cellW, cellH, gap = GAP }) {
  return { width: cols * cellW + (cols + 1) * gap, height: rows * cellH + (rows + 1) * gap };
}

// The contact sheet for video_overview: how many frames, the grid, the cell size, and the token estimate, fitted to
// tokenBudget. Shrinks the sheet first (down to MIN_CELL_WIDTH cells), then drops frames (down to MIN_FRAMES).
// Never upscales past the video's own size. { frames, cols, rows, cellW, cellH, width, height, tokens, budget, notes }.
function planSheet({ family = 'anthropic', srcW = 1280, srcH = 720, frames, tokenBudget } = {}) {
  const asked = clamp(Math.round(Number(frames) || DEFAULT_FRAMES), MIN_FRAMES, MAX_FRAMES);
  const budget = clamp(Math.round(Number(tokenBudget) || DEFAULT_BUDGET), 200, 100000);
  const aspect = srcW > 0 && srcH > 0 ? srcW / srcH : 16 / 9;
  const notes = [];
  let n = asked, plan = null;
  for (; n >= MIN_FRAMES; n--) {
    const { cols, rows } = gridFor(n, aspect);
    const fullCell = Math.floor((SHEET_MAX_WIDTH - GAP * (cols + 1)) / cols);
    let cellW = Math.min(fullCell, Math.max(MIN_CELL_WIDTH, Math.floor(srcW)));
    for (;;) {
      const cellH = Math.max(1, Math.round(cellW / aspect));
      const size = sheetSize({ cols, rows, cellW, cellH });
      const tokens = imageTokens(family, size.width, size.height);
      plan = { frames: n, cols, rows, cellW, cellH, ...size, tokens };
      if (tokens <= budget) break;
      const next = Math.floor(cellW * 0.88);
      if (next < MIN_CELL_WIDTH) break;
      cellW = next;
    }
    if (plan.tokens <= budget) break;
  }
  if (plan.frames < asked) notes.push(`Fewer frames than asked (${plan.frames} of ${asked}) to fit the ${budget}-token budget.`);
  if (plan.tokens > budget) notes.push(`Over the ${budget}-token budget at the smallest size (about ${plan.tokens}); ask for fewer frames or a bigger token_budget.`);
  else if (plan.cellW < Math.min(srcW, 360) && plan.cellW < Math.floor((SHEET_MAX_WIDTH - GAP * (plan.cols + 1)) / plan.cols)) notes.push('Frames were shrunk to fit the token budget; use video_frames to read detail.');
  return { ...plan, budget, notes };
}

// video_frames: separate images up to SINGLE_LIMIT, otherwise one 2-column sheet. { mode, count, cellW, cellH, cols, rows,
// width, height, tokens (all images together), each }.
function planFrames({ family = 'anthropic', srcW = 1280, srcH = 720, count = 1, maxWidth } = {}) {
  const aspect = srcW > 0 && srcH > 0 ? srcW / srcH : 16 / 9;
  const n = clamp(Math.round(count) || 1, 1, MAX_AT);
  const want = clamp(Math.round(Number(maxWidth) || (n > SINGLE_LIMIT ? 784 : 1024)), 160, 1568);
  if (n <= SINGLE_LIMIT) {
    const cellW = Math.min(want, Math.floor(srcW) || want);
    const cellH = Math.max(1, Math.round(cellW / aspect));
    const one = fitImage(family, cellW, cellH);
    return { mode: 'single', count: n, cellW, cellH, cols: 1, rows: 1, width: cellW, height: cellH, each: one.tokens, tokens: one.tokens * n };
  }
  const cols = 2, rows = Math.ceil(n / 2);
  const cellW = Math.min(want, Math.floor((SHEET_MAX_WIDTH - GAP * 3) / 2), Math.floor(srcW) || want);
  const cellH = Math.max(1, Math.round(cellW / aspect));
  const size = sheetSize({ cols, rows, cellW, cellH });
  const tokens = imageTokens(family, size.width, size.height);
  return { mode: 'sheet', count: n, cellW, cellH, cols, rows, ...size, each: tokens, tokens };
}

// Parses and checks video_frames' `at`: seconds in range, de-duplicated, at most MAX_AT. { times } or { error }.
function parseAt(at, duration) {
  const list = Array.isArray(at) ? at : at === undefined || at === null ? [] : [at];
  if (!list.length) return { error: 'Give at least one timestamp in `at` (seconds or m:ss).' };
  const times = [];
  for (const raw of list) {
    const t = parseTimestamp(raw);
    if (t === null) return { error: `"${String(raw).slice(0, 20)}" is not a timestamp. Use seconds (83) or m:ss (1:23).` };
    if (Number.isFinite(duration) && t > duration + 0.5) return { error: `${formatTime(t)} is past the end of the video (${formatTime(duration)}).` };
    const at1 = Number.isFinite(duration) ? Math.min(t, Math.max(0, duration - 0.05)) : t;
    if (!times.some((x) => Math.abs(x - at1) < 0.05)) times.push(at1);
  }
  const note = times.length > MAX_AT ? `Only the first ${MAX_AT} timestamps were used.` : '';
  return { times: times.slice(0, MAX_AT), note };
}

module.exports = {
  DEFAULT_FRAMES, MIN_FRAMES, MAX_FRAMES, MAX_AT, DEFAULT_BUDGET, SHEET_MAX_WIDTH, GAP, MIN_CELL_WIDTH, SINGLE_LIMIT,
  familyOf, fitImage, imageTokens, parseTimestamp, formatTime, spacedTimes, decimalsFor, gridFor, sheetSize, planSheet, planFrames, parseAt,
};
