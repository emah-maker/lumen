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

module.exports = { captureTab, cssClip };
