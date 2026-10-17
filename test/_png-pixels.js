// A tiny PNG reader for tests: 8-bit gray, RGB or RGBA, any filter. decode(buf) -> { w, h, at(x, y) -> [r, g, b, a] }.
const zlib = require('zlib');
function decode(png) {
  let off = 8; let w = 0; let h = 0; let ct = 0; const idat = [];
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off); const type = png.toString('latin1', off + 4, off + 8); const d = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; if (d[8] !== 8 || d[12]) throw new Error('unsupported PNG'); }
    if (type === 'IDAT') idat.push(d);
    off += 12 + len;
  }
  const bpp = { 0: 1, 2: 3, 6: 4 }[ct];
  if (!bpp) throw new Error(`unsupported PNG color type ${ct}`);
  const raw = zlib.inflateSync(Buffer.concat(idat)); const stride = w * bpp; const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0; const b = y ? out[(y - 1) * stride + x] : 0; const c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      let v = raw[y * (stride + 1) + 1 + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + x] = v & 255;
    }
  }
  const at = (x, y) => { const o = (y * w + x) * bpp; return bpp === 4 ? [out[o], out[o + 1], out[o + 2], out[o + 3]] : bpp === 3 ? [out[o], out[o + 1], out[o + 2], 255] : [out[o], out[o], out[o], 255]; };
  return { w, h, at };
}
module.exports = { decode };
