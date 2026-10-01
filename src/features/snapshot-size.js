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

module.exports = { snapshotSize, MAX_SIDE, JPEG_QUALITY: 75 };
