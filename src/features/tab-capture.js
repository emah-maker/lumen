// Screenshots of a tab for the AI's screenshot tool (agent.js, snapshot.js), including a tab that is
// not on screen: the AI keeps working in the tab its task started in while the user looks at another
// tab or window, and a hidden view can come back from capturePage() empty. Then the DevTools
// protocol's Page.captureScreenshot draws it instead (the page is painted for the capture, and main.js
// turns background throttling off for the tab while a run works in it).
//
// captureTab(wc, rect?) -> a non-empty NativeImage, or throws. rect is in view pixels, as capturePage takes it.

let nativeImage_ = null;
const nativeImage = () => (nativeImage_ ||= require('electron').nativeImage);

// Page.captureScreenshot's clip is in CSS pixels; a crop in view pixels maps back through the zoom.
function cssClip(rect, zoom) {
  const z = zoom > 0 ? zoom : 1;
  return { x: rect.x / z, y: rect.y / z, width: Math.max(1, rect.width / z), height: Math.max(1, rect.height / z), scale: 1 };
}

async function viaDevTools(wc, rect) {
  const dbg = wc.debugger;
  let attachedHere = false;
  if (!dbg.isAttached()) { dbg.attach('1.3'); attachedHere = true; } // attached already (automation): share it
  try {
    const params = { format: 'png', fromSurface: true };
    if (rect) params.clip = cssClip(rect, wc.getZoomFactor?.() || 1);
    const shot = await dbg.sendCommand('Page.captureScreenshot', params);
    return nativeImage().createFromBuffer(Buffer.from(shot.data, 'base64'));
  } finally {
    if (attachedHere) { try { dbg.detach(); } catch {} }
  }
}

async function captureTab(wc, rect = null) {
  let image = null;
  try { image = rect ? await wc.capturePage(rect) : await wc.capturePage(); } catch {}
  if (image && !image.isEmpty()) return image;
  let fallback = null;
  try { fallback = await viaDevTools(wc, rect); } catch {}
  if (fallback && !fallback.isEmpty()) return fallback;
  throw new Error('Could not take a screenshot of this tab right now. Use read_page or find instead.');
}

// [activity cards] A small JPEG of the tab for the chat's Browser card: the page is scaled and encoded by the browser engine (the DevTools
// protocol's Page.captureScreenshot with a clip scale), so the main process only handles a ~40 KB base64 string, never a full-size bitmap.
// Falls back to captureTab + resize when the protocol call fails. Answers base64 or null; at most about 60 KB.
// Sharp by default: the picture is the card's displayed size (SHOW_CSS px, see step-ui.js CAP) times the display's scale, so a screen at 200% gets
// 680 px, at 150% 510 px, JPEG quality 80. `lowRes` (Graphics on Light, no hardware drawing) keeps the old small picture: `width` px, quality 55.
const SHOW_CSS = 340;
// A frame that is one colour (a hidden view that was not painted, a canvas the protocol could not read, a viewer whose top is a plain bar) is not a
// picture of the page: it is never shown. A JPEG of a plain colour is tiny, so only a small one is decoded and sampled (a grid of pixels).
function isBlankFrame(base64) {
  try {
    if (typeof base64 !== 'string' || base64.length * 0.75 > 9000) return false;
    const image = nativeImage().createFromBuffer(Buffer.from(base64, 'base64'));
    const { width, height } = image.getSize();
    if (!width || !height) return true;
    const bmp = image.toBitmap();
    const lo = [255, 255, 255];
    const hi = [0, 0, 0];
    for (let gy = 0; gy < 12; gy++) for (let gx = 0; gx < 20; gx++) {
      const o = ((Math.min(height - 1, Math.floor((gy + 0.5) * height / 12))) * width + Math.min(width - 1, Math.floor((gx + 0.5) * width / 20))) * 4;
      for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], bmp[o + c]); hi[c] = Math.max(hi[c], bmp[o + c]); }
    }
    return Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) <= 10;
  } catch { return false; }
}
const lastRedraw = new WeakMap(); // wc -> when a blank frame was last drawn again (not more than once in 5 s)
// Answers base64, or null; `state.blank` is set when the tab only gave blank frames (even after drawing it again): the card shows its name instead.
async function captureThumb(wc, opts = {}) {
  const state = opts.state || {};
  const first = await viaProtocol(wc, opts);
  if (first && !isBlankFrame(first)) return first;
  const now = Date.now();
  if (now - (lastRedraw.get(wc) || 0) > 5000) { // a hidden view can hand back a black frame: ask it to paint, then take it the other way (the screenshot path)
    lastRedraw.set(wc, now);
    try { wc.invalidate?.(); } catch { /* going away */ }
    await new Promise((r) => { const h = setTimeout(r, 80); h.unref?.(); });
    const second = await viaScreenshot(wc, opts);
    if (second && !isBlankFrame(second)) return second;
    if (second || first) state.blank = true;
    return null;
  }
  if (first) state.blank = true;
  return null;
}
async function viaProtocol(wc, { lowRes = false, width = 420, quality = 55, maxBytes = 45000 } = {}) {
  const size = wc.getContentSize?.() || [0, 0];
  const w = Math.max(1, size[0] || 1280);
  const h = Math.max(1, size[1] || 800);
  const dbg = wc.debugger;
  let attachedHere = false;
  try {
    if (!dbg.isAttached()) { dbg.attach('1.3'); attachedHere = true; }
    const zoom = wc.getZoomFactor?.() || 1;
    let dpr = 1; // (the picture is `width` device pixels wide, whatever the display's scale)
    try { dpr = Math.max(1, Number((await dbg.sendCommand('Runtime.evaluate', { expression: 'window.devicePixelRatio', returnByValue: true }))?.result?.value) || 1); } catch { /* 1 */ }
    const scale = Math.max(1, dpr / zoom); // (the display's own scale: the page's devicePixelRatio includes the page zoom)
    if (!lowRes) { width = Math.round(SHOW_CSS * scale); quality = 80; maxBytes = 220000; }
    const cssW = w / zoom;
    const cssH = Math.min(h / zoom, cssW * 0.625); // the card shows a 16:10 window onto the top of the page
    for (const [q, k] of lowRes ? [[quality, 1], [38, 1], [32, 0.75]] : [[80, 1], [68, 1], [56, 0.85], [44, 0.7]]) {
      const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: q, fromSurface: true, clip: { x: 0, y: 0, width: cssW, height: cssH, scale: Math.min(1, (width * k) / (cssW * dpr)) } });
      if (shot && typeof shot.data === 'string' && shot.data.length * 0.75 <= maxBytes) return shot.data;
    }
  } catch { /* try the screenshot path */ } finally {
    if (attachedHere) { try { dbg.detach(); } catch { /* gone */ } }
  }
  return null;
}
async function viaScreenshot(wc, { lowRes = false, width = 420, quality = 55, maxBytes = 45000 } = {}) {
  if (!lowRes) maxBytes = 220000;
  try {
    const image = await captureTab(wc);
    const imgW = image.getSize().width;
    const sized = image.resize({ width: lowRes ? width : Math.min(imgW, Math.round(SHOW_CSS * imgW / Math.max(1, (wc.getContentSize?.() || [imgW])[0]))), quality: 'good' });
    for (const q of lowRes ? [quality, 38, 30] : [80, 66, 50]) { const jpeg = sized.toJPEG(q); if (jpeg.length <= maxBytes) return jpeg.toString('base64'); }
  } catch { /* no picture right now */ }
  return null;
}

// A saved chat keeps one small final frame (≤ 45 KB): a sharp live frame is scaled down once, when the run is stamped.
function shrinkThumb(base64, { width = 420, maxBytes = 45000 } = {}) {
  try {
    if (typeof base64 !== 'string') return null;
    const image = nativeImage().createFromBuffer(Buffer.from(base64, 'base64'));
    if (image.getSize().width <= width && base64.length * 0.75 <= maxBytes) return base64; // (already small)
    const small = image.getSize().width > width ? image.resize({ width, quality: 'good' }) : image;
    for (const q of [55, 40, 30]) { const jpeg = small.toJPEG(q); if (jpeg.length <= maxBytes) return jpeg.toString('base64'); }
  } catch { /* no saved frame */ }
  return null;
}

module.exports = { captureTab, cssClip, captureThumb, shrinkThumb, isBlankFrame };
