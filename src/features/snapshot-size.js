// The size of the page snapshot shown while the sidebar moves (view:freeze in main.js). The snapshot is
// drawn at CSS size, so capturing it at device size (a 4K or 150% screen) only made the JPEG encode, the
// IPC copy and the decode in the renderer several times bigger than anything on screen. Pure: tests run it.

const MAX_SIDE = 4096;

// `image` is the capture's size in pixels, `css` the area it fills in CSS pixels. Returns the pixel size to
// resize it to: the CSS size, never larger than the capture (no upscaling), the aspect ratio kept, or
// null when the capture is already that size or smaller (nothing to resize).
function snapshotSize(image, css) {
  const iw = Math.round(Number(image?.width)), ih = Math.round(Number(image?.height));
  if (!(iw > 0) || !(ih > 0)) return null;
  let w = Math.round(Number(css?.width));
  if (!(w > 0)) return null; // the renderer sent no usable size: keep the capture as it is
  w = Math.min(w, MAX_SIDE);
  if (w >= iw) return null;
  return { width: w, height: Math.max(1, Math.round((ih * w) / iw)) };
}


// ---- The resize itself, in bands (view:freeze and view:warm in main.js; it lives here so it costs no module at start-up) ----
// Resizes the page snapshot (view:freeze in main.js) in horizontal bands, with a turn for the event loop between them. A 2160 px wide capture
// takes ~9 ms to resize on the main thread in one go (and three times that when the machine is busy), which is a frame or two of input and
// drawing held up every time the picker, the sidebar or tab search freezes the page. Two bands are ~4-5 ms each: the longest task is half.
// Each band is cut with a few source rows of margin on the side that touches the other band, so the resampling filter sees real pixels
// at the seam (no line), and only its own rows are kept. Never used without a nativeImage, so the pure part (the row maths) is the
// only thing the units need.
const MARGIN = 4; // source rows

// The source and target rows of each band: [{ sy0, sy1, th, skip, rows }]. `rows` target rows are kept, starting `skip` rows into the
// resized band.
function plan(iw, ih, w, h, bands = 2) {
  const scale = h / ih;
  const out = [];
  for (let b = 0; b < bands; b++) {
    const a = Math.round((h * b) / bands);
    const e = Math.round((h * (b + 1)) / bands);
    const sy0 = Math.max(0, Math.floor(a / scale) - MARGIN);
    const sy1 = Math.min(ih, Math.ceil(e / scale) + MARGIN);
    const th = Math.max(e - a, Math.round((sy1 - sy0) * scale));
    const skip = Math.max(0, Math.min(th - (e - a), Math.round(a - sy0 * scale)));
    out.push({ sy0, sy1, th, skip, rows: e - a });
  }
  return out;
}

// image: a nativeImage; target: { width, height } (snapshot-size.js); tick: () => Promise (a turn of the event loop); mark: (label, fn) => fn()
// (the hang recorder's). -> a nativeImage of the target size.
let joined = null; // the joined bitmap's buffer, kept between freezes: a fresh 4 MB allocation each time cost page faults (~3 ms) and garbage

async function resizeInBands(image, target, { createFromBitmap, tick, mark = (_l, fn) => fn(), bands = 4 }) {
  const { width: iw, height: ih } = image.getSize();
  const { width: w, height: h } = target;
  if (h < 64 || bands < 2) return mark('freeze:resize', () => image.resize({ width: w, height: h, quality: 'good' }));
  const total = w * h * 4;
  if (!joined || joined.length !== total) joined = Buffer.allocUnsafeSlow(total);
  let at = 0;
  for (const p of plan(iw, ih, w, h, bands)) {
    mark('freeze:resize', () => {
      const band = image.crop({ x: 0, y: p.sy0, width: iw, height: p.sy1 - p.sy0 }).resize({ width: w, height: p.th, quality: 'good' });
      at += band.toBitmap().copy(joined, at, p.skip * w * 4, (p.skip + p.rows) * w * 4);
    });
    await tick();
  }
  return mark('freeze:join', () => createFromBitmap(joined, { width: w, height: h }));
}



module.exports = { snapshotSize, MAX_SIDE, JPEG_QUALITY: 90, plan, resizeInBands, MARGIN };
