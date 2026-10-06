// ---------- contact sheet pixels for video_overview / video_frames ----------
// Pure: raw 4-bytes-per-pixel buffers in, one buffer out (nativeImage.toBitmap / createFromBitmap use this layout; the
// colours drawn here are grey, black and white, so the channel order does not matter). Timestamp labels are drawn
// with a tiny built-in 5x7 font (digits, ":" and "."), so no text rendering, canvas or page is involved.

const GLYPHS = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
};
const GLYPH_W = 5, GLYPH_H = 7;

function fillRect(buf, bw, bh, x, y, w, h, [r, g, b]) {
  const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(bw, x + w), y1 = Math.min(bh, y + h);
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const o = (yy * bw + xx) * 4;
      buf[o] = b; buf[o + 1] = g; buf[o + 2] = r; buf[o + 3] = 255;
    }
  }
}

// How big the label is for a cell of this width: 1x up to ~190 px, growing to 4x.
const labelScale = (cellWidth) => Math.min(4, Math.max(1, Math.round(cellWidth / 130)));

// Draws `text` (white on black) at the top-left corner of the w x h bitmap, in place. Returns the box it used.
function drawLabel(buf, bw, bh, text, { x = 0, y = 0, scale = labelScale(bw) } = {}) {
  const chars = [...String(text)].filter((c) => GLYPHS[c]);
  const pad = Math.max(1, scale);
  const boxW = chars.length * (GLYPH_W + 1) * scale - scale + pad * 2;
  const boxH = GLYPH_H * scale + pad * 2;
  fillRect(buf, bw, bh, x, y, boxW, boxH, [0, 0, 0]);
  chars.forEach((c, i) => {
    GLYPHS[c].forEach((row, gy) => {
      for (let gx = 0; gx < GLYPH_W; gx++) if (row[gx] === '1') fillRect(buf, bw, bh, x + pad + (i * (GLYPH_W + 1) + gx) * scale, y + pad + gy * scale, scale, scale, [255, 255, 255]);
    });
  });
  return { x, y, width: boxW, height: boxH };
}

// Copies src (sw x sh) into dst at (dx, dy), clipped.
function blit(dst, dw, dh, src, sw, sh, dx, dy) {
  for (let y = 0; y < sh; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dh) continue;
    const x0 = Math.max(0, -dx), x1 = Math.min(sw, dw - dx);
    if (x1 <= x0) continue;
    src.copy(dst, (ty * dw + dx + x0) * 4, (y * sw + x0) * 4, (y * sw + x1) * 4);
  }
}

// cells: [{ bitmap, width, height, label }] in reading order, each already at (or near) cellW x cellH; a smaller
// one is centred. layout: { cols, rows, cellW, cellH, gap, width, height }. A missing bitmap leaves a dark cell with its label.
function composeSheet(layout, cells) {
  const { cols, rows, cellW, cellH, gap, width, height } = layout;
  const out = Buffer.alloc(width * height * 4);
  fillRect(out, width, height, 0, 0, width, height, [20, 20, 20]);
  cells.slice(0, cols * rows).forEach((cell, i) => {
    const cx = gap + (i % cols) * (cellW + gap), cy = gap + Math.floor(i / cols) * (cellH + gap);
    if (cell.bitmap) {
      const w = Math.min(cell.width, cellW), h = Math.min(cell.height, cellH);
      const src = w === cell.width && h === cell.height ? cell.bitmap : cropBitmap(cell.bitmap, cell.width, w, h);
      blit(out, width, height, src, w, h, cx + Math.floor((cellW - w) / 2), cy + Math.floor((cellH - h) / 2));
    }
    if (cell.label) drawLabel(out, width, height, cell.label, { x: cx, y: cy, scale: labelScale(cellW) });
  });
  return out;
}

function cropBitmap(src, sw, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) src.copy(out, y * w * 4, y * sw * 4, (y * sw + w) * 4);
  return out;
}

// True when a bitmap is (nearly) one flat dark colour: a protected (DRM) video or a frame that never painted.
function looksBlank(bitmap, { stride = 37 } = {}) {
  if (!bitmap || bitmap.length < 4) return true;
  let max = 0, min = 255, n = 0;
  for (let o = 0; o + 2 < bitmap.length; o += 4 * stride) {
    const v = Math.max(bitmap[o], bitmap[o + 1], bitmap[o + 2]);
    if (v > max) max = v;
    if (v < min) min = v;
    n++;
  }
  return n > 0 && max < 24 && max - min < 12;
}

module.exports = { GLYPHS, GLYPH_W, GLYPH_H, labelScale, drawLabel, composeSheet, looksBlank, fillRect };
