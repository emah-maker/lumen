// Chromium's own PDF viewer is a separate (out-of-process) frame. A tab opened behind another, or resized while it was away, can come to
// the front with that frame's main area never redrawn (the toolbar and thumbnails show, the page area stays grey until a scroll).
// So a PDF tab that is shown, resized, or whose window is restored or unoccluded asks its page to draw again: webContents.invalidate()
// on the next frame and once more about 150 ms later. PDF tabs only: nothing else pays for it.
const NEXT_FRAME_MS = 16;
const AGAIN_MS = 150;

function createRepainter({ isPdfTab, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const pending = new WeakMap(); // wc -> [timers]
  function poke(wc) {
    try { if (!wc || wc.isDestroyed() || !isPdfTab(wc)) return false; } catch { return false; }
    for (const t of pending.get(wc) || []) clearTimer(t); // (a burst of shows and resizes is one pair of repaints)
    const draw = () => { try { if (!wc.isDestroyed() && isPdfTab(wc)) wc.invalidate(); } catch { /* going away */ } };
    const timers = [setTimer(draw, NEXT_FRAME_MS), setTimer(draw, AGAIN_MS)];
    for (const t of timers) t?.unref?.();
    pending.set(wc, timers);
    return true;
  }
  return { poke };
}

// window.open('blob:…') is allowed only for a blob the opening page itself made: the blob's origin (blob:https://host/<id>) is the
// opener's. blob:null/… (an opaque origin), another site's blob and anything that is not http(s) are refused.
function isSameOriginBlob(target, openerUrl) {
  try {
    const t = new URL(String(target));
    if (t.protocol !== 'blob:') return false;
    const blobOrigin = new URL(t.pathname).origin; // (blob:https://host/id -> https://host; blob:null/id -> "null")
    const opener = new URL(String(openerUrl));
    return /^https?:$/.test(opener.protocol) && blobOrigin === opener.origin;
  } catch { return false; }
}

module.exports = { createRepainter, isSameOriginBlob, NEXT_FRAME_MS, AGAIN_MS };
