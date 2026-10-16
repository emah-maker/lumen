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
async function captureThumb(wc, { width = 420, quality = 55, maxBytes = 45000 } = {}) {
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
    const cssW = w / zoom;
    const cssH = Math.min(h / zoom, cssW * 0.625); // the card shows a 16:10 window onto the top of the page
    for (const [q, k] of [[quality, 1], [38, 1], [32, 0.75]]) {
      const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: q, fromSurface: true, clip: { x: 0, y: 0, width: cssW, height: cssH, scale: Math.min(1, (width * k) / (cssW * dpr)) } });
      if (shot && typeof shot.data === 'string' && shot.data.length * 0.75 <= maxBytes) return shot.data;
    }
  } catch { /* try the screenshot path */ } finally {
    if (attachedHere) { try { dbg.detach(); } catch { /* gone */ } }
  }
  try {
    const image = await captureTab(wc);
    const sized = image.resize({ width, quality: 'good' });
    for (const q of [quality, 38, 30]) { const jpeg = sized.toJPEG(q); if (jpeg.length <= maxBytes) return jpeg.toString('base64'); }
  } catch { /* no picture right now */ }
  return null;
}

// The tab's visible area as a JPEG already scaled to maxWidth, drawn and encoded by the browser's own processes: { data (base64), width,
// height }, or null (no debugger, a tab that will not paint: the caller falls back to captureTab). capturePage() hands the main process
// the full-size bitmap (2160 px wide on a high-DPI screen); nativeImage.resize() of it then ran 14 to 45 ms on the main thread per
// screenshot (a CPU profile of 6 agents at once: 800 ms of resize in 5 s), toJPEG 4 to 13 ms more. Here the main process receives only
// the finished JPEG.
// One at a time, with the main process's event loop let through in between: several agents' screenshots no longer stack their readback
// and encode work (8 to 30 ms each, in Chromium, on the main thread) into one stall of 100 ms and more.
let captureChain = Promise.resolve();
function captureJpeg(wc, opts) {
  const run = captureChain.then(() => captureJpegNow(wc, opts));
  captureChain = run.then(() => {}, () => {}).then(() => new Promise((resolve) => setImmediate(resolve)));
  return run;
}
async function captureJpegNow(wc, { maxWidth, quality }) {
  const dbg = wc.debugger;
  let attachedHere = false;
  try {
    if (!dbg.isAttached()) { dbg.attach('1.3'); attachedHere = true; } // attached already (automation): share it
    const m = await dbg.sendCommand('Page.getLayoutMetrics');
    const v = m.cssVisualViewport;
    if (!(v?.clientWidth > 0 && v?.clientHeight > 0)) return null;
    const scale = Math.min(maxWidth / v.clientWidth, 2); // (never magnified past 2x: a narrow view is not blown up to the full width)
    const width = Math.max(1, Math.round(v.clientWidth * scale));
    const height = Math.max(1, Math.round(v.clientHeight * scale));
    const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality, fromSurface: true, optimizeForSpeed: true, clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale } });
    return shot?.data ? { data: shot.data, width, height } : null;
  } catch {
    return null;
  } finally {
    if (attachedHere) { try { dbg.detach(); } catch {} }
  }
}

module.exports = { captureTab, captureJpeg, cssClip, captureThumb };
