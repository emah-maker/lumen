// Zoom for Chromium's built-in PDF viewer. The viewer draws the document at its own scale and
// learns about browser zoom only through chrome.tabs.onZoomChange, which Lumen deliberately keeps
// away from it (features/pdf-viewer-preload.js). So wc.setZoomLevel() (what Ctrl+Plus/Minus/0 and
// Ctrl+scroll do for web pages) changed nothing visible on a PDF. For a tab showing the viewer we
// drive the viewer's own zoom instead: its toolbar/viewport zoomIn, zoomOut and setZoom(1).
const PDF_VIEWER = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai';

// step > 0 zoom in, step < 0 zoom out, 0 back to 100%. The script runs inside the viewer frame and
// returns true when it found something to zoom.
function zoomScript(step) {
  const action = step > 0 ? 'in' : step < 0 ? 'out' : 'reset';
  return `(() => {
    const action = ${JSON.stringify(action)};
    const deep = (root, tag) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.tagName === tag) return el;
        if (el.shadowRoot) { const hit = deep(el.shadowRoot, tag); if (hit) return hit; }
      }
      return null;
    };
    const viewer = document.querySelector('pdf-viewer') || deep(document, 'PDF-VIEWER');
    const vp = viewer && (viewer.viewport_ || viewer.viewport);
    const bar = deep(document, 'VIEWER-ZOOM-TOOLBAR');
    try {
      if (action === 'in') { if (bar?.zoomIn) bar.zoomIn(); else if (vp?.zoomIn) vp.zoomIn(); else return false; return true; }
      if (action === 'out') { if (bar?.zoomOut) bar.zoomOut(); else if (vp?.zoomOut) vp.zoomOut(); else return false; return true; }
      if (vp?.setZoom) { vp.setZoom(1); return true; }
      if (bar?.fitToggle) return false;
    } catch { return false; }
    return false;
  })()`;
}

function viewerFrame(wc) {
  try {
    const frames = wc.mainFrame?.framesInSubtree || [];
    return frames.find((f) => String(f.url || '').startsWith(PDF_VIEWER)) || null;
  } catch { return null; }
}

// Resolves true when the PDF viewer took the zoom, false when this tab has no viewer (or it did
// not respond), so the caller falls back to ordinary page zoom.
async function zoomPdf(wc, step) {
  const frame = viewerFrame(wc);
  if (!frame) return false;
  try { return (await frame.executeJavaScript(zoomScript(step))) === true; } catch { return false; }
}

module.exports = { zoomPdf, zoomScript, viewerFrame, PDF_VIEWER };
