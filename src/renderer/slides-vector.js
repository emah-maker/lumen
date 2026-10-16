// EMF and WMF pictures for the slide viewer. Loaded by slides.js only when a deck has one (never part of ui.bundle.js).
// The bytes come from an untrusted file and are parsed here, in the sandboxed slides page (no preload, no IPC, CSP: no network), never in the
// main process: EMFJS and WMFJS (rtf.js, MIT; vendor/emfjs.min.js, vendor/wmfjs.min.js) draw them as SVG, which is rasterised to a PNG.
// Every step is bounded: a size cap, a record cap and a structure check before the library sees a byte, a time limit on the rasterising,
// and every error ends in `null` (the page then shows a placeholder of the picture's size).
(() => {
  'use strict';
  const MAX_BYTES = 8 * 1024 * 1024;
  const MAX_RECORDS = 100000;
  const MAX_DIB_SIDE = 16384; // a bitmap record that claims more than this is refused
  const MAX_DIB_PIXELS = 64e6;
  const MIN_SIDE = 512;
  const MAX_SIDE = 2048;
  const DECODE_MS = 5000;

  const scripts = new Map();
  function loadScript(src) {
    if (!scripts.has(src)) {
      scripts.set(src, new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = () => resolve();
        s.onerror = () => { scripts.delete(src); reject(new Error('script')); };
        document.head.append(s);
      }));
    }
    return scripts.get(src);
  }

  // ---- the structure, checked before the library is let in. Returns { w, h, x, y } (the drawing's own units) or null.
  function scanEmf(dv) {
    const len = dv.byteLength;
    if (len < 88 || dv.getUint32(0, true) !== 1 || dv.getUint32(40, true) !== 0x464d4520) return null;
    let off = 0; let count = 0; let ended = false;
    while (off + 8 <= len) {
      const type = dv.getUint32(off, true);
      const size = dv.getUint32(off + 4, true);
      if (size < 8 || size % 4 || off + size > len || ++count > MAX_RECORDS) return null;
      if (type === 81 && size >= 80) { // EMR_STRETCHDIBITS: the bitmap header says how big it is
        const bmi = dv.getUint32(off + 48, true);
        if (bmi >= 8 && bmi + 12 <= size) {
          const bw = Math.abs(dv.getInt32(off + bmi + 4, true)); const bh = Math.abs(dv.getInt32(off + bmi + 8, true));
          if (bw > MAX_DIB_SIDE || bh > MAX_DIB_SIDE || bw * bh > MAX_DIB_PIXELS) return null;
        }
      }
      off += size;
      if (type === 14) { ended = true; break; }
    }
    if (!ended && off !== len) return null;
    let x = dv.getInt32(8, true); let y = dv.getInt32(12, true);
    let w = dv.getInt32(16, true) - x + 1; let h = dv.getInt32(20, true) - y + 1;
    if (!(w > 0 && h > 0) || w > 1e6 || h > 1e6) { // no usable device bounds: the frame (0.01 mm), at the device's own resolution
      const fw = dv.getInt32(32, true) - dv.getInt32(24, true); const fh = dv.getInt32(36, true) - dv.getInt32(28, true);
      const dx = dv.getInt32(72, true); const mx = dv.getInt32(80, true); const dy = dv.getInt32(76, true); const my = dv.getInt32(84, true);
      if (!(fw > 0 && fh > 0 && dx > 0 && mx > 0 && dy > 0 && my > 0)) return null;
      w = Math.max(1, Math.round((fw / 100) * (dx / mx))); h = Math.max(1, Math.round((fh / 100) * (dy / my))); x = 0; y = 0;
    }
    return { w, h, x, y };
  }
  function scanWmf(dv) {
    const len = dv.byteLength;
    let off = 0; let box = null;
    if (len >= 22 && dv.getUint32(0, true) === 0x9ac6cdd7) {
      const l = dv.getInt16(6, true); const t = dv.getInt16(8, true); const r = dv.getInt16(10, true); const b = dv.getInt16(12, true);
      if (r - l > 0 && b - t > 0) box = { x: l, y: t, w: r - l, h: b - t };
      off = 22;
    }
    if (off + 18 > len) return null;
    const type = dv.getUint16(off, true);
    if ((type !== 1 && type !== 2) || dv.getUint16(off + 2, true) !== 9) return null;
    off += 18;
    let count = 0; let ended = false; let ext = null; let org = { x: 0, y: 0 };
    while (off + 6 <= len) {
      const words = dv.getUint32(off, true);
      const fn = dv.getUint16(off + 4, true);
      if (words < 3 || off + words * 2 > len || ++count > MAX_RECORDS) return null;
      if (fn === 0x020c && words >= 5) ext = { w: dv.getInt16(off + 8, true), h: dv.getInt16(off + 6, true) };
      else if (fn === 0x020b && words >= 5) org = { x: dv.getInt16(off + 8, true), y: dv.getInt16(off + 6, true) };
      off += words * 2;
      if (fn === 0) { ended = true; break; }
    }
    if (!ended && off !== len) return null;
    if (box) return box;
    return ext && ext.w > 0 && ext.h > 0 ? { x: org.x, y: org.y, w: ext.w, h: ext.h } : null;
  }

  const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });

  // The SVG the library drew -> a PNG blob, or null when nothing is on it.
  async function rasterise(svg, box) {
    const scale = Math.min(MAX_SIDE, Math.max(MIN_SIDE, Math.max(box.w, box.h) * 2)) / Math.max(box.w, box.h);
    const w = Math.max(1, Math.round(box.w * scale)); const h = Math.max(1, Math.round(box.h * scale));
    svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      await withTimeout(new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('svg')); img.src = url; }), DECODE_MS);
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const px = ctx.getImageData(0, 0, w, h).data;
      let ink = false;
      for (let i = 3; i < px.length; i += 4) if (px[i]) { ink = true; break; }
      if (!ink) return null; // blank: an EMF+ that holds only GDI+ records, a clipped-away drawing...
      return await canvas.convertToBlob({ type: 'image/png' });
    } finally { URL.revokeObjectURL(url); }
  }

  // kind: 'emf' | 'wmf'; bytes: Uint8Array. Resolves to a PNG Blob, or null (never rejects).
  async function render(kind, bytes) {
    try {
      if (!(bytes instanceof Uint8Array) || bytes.length < 20 || bytes.length > MAX_BYTES) return null;
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      if (kind === 'emf') {
        const box = scanEmf(dv);
        if (!box) return null;
        await loadScript('vendor/emfjs.min.js');
        if (!window.EMFJS) return null;
        try { window.EMFJS.loggingEnabled(false); } catch { /* optional */ }
        const svg = new window.EMFJS.Renderer(buf).render({ width: `${box.w}px`, height: `${box.h}px`, wExt: box.w, hExt: box.h, xExt: box.w, yExt: box.h, mapMode: 8 });
        return await rasterise(svg, box);
      }
      if (kind === 'wmf') {
        const box = scanWmf(dv);
        if (!box) return null;
        await loadScript('vendor/wmfjs.min.js');
        if (!window.WMFJS) return null;
        try { window.WMFJS.loggingEnabled(false); } catch { /* optional */ }
        const svg = new window.WMFJS.Renderer(buf).render({ width: `${box.w}px`, height: `${box.h}px`, xExt: box.w, yExt: box.h, mapMode: 8 });
        return await rasterise(svg, box);
      }
    } catch { /* a damaged or hostile file: no picture */ }
    return null;
  }
  window.lumenVector = { render };
})();
