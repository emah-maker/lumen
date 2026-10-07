// The AI's scroll, click_at and press_key on a tab showing Chromium's built-in PDF viewer. The document
// is drawn by a plugin inside the viewer's own frame (chrome-extension://…, features/pdf-zoom.js), so
// the page scripts the tools normally run (window.scrollBy in the top frame, a click probe, DOM
// events) see only an <embed>: scroll reported "none", and click_at never saw its click land and
// ended in "Nothing is at that position". Here scrolling goes through the viewer's own viewport (the
// same thing its scrollbar drives, so no focus or visible window is needed) and clicks go in over
// the tab's DevTools session, which routes mouse input to the frame under the point.
const { viewerFrame } = require('./pdf-zoom');

const READ_PDF_HINT = 'This is a PDF in the built-in viewer: use read_pdf for its text.';

// Runs inside the viewer frame. `move` is { screens } (a fraction of the visible height, negative up),
// { lines } (CSS px) or { to: 'top' | 'bottom' }; null just reports the position. Resolves once the
// position has held still, with { y, max, page, pages, moved } or { error }.
function scrollScript(move) {
  return `(() => {
    const move = ${JSON.stringify(move)};
    const deep = (root, tag) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.tagName === tag) return el;
        if (el.shadowRoot) { const hit = deep(el.shadowRoot, tag); if (hit) return hit; }
      }
      return null;
    };
    const viewer = document.querySelector('pdf-viewer') || deep(document, 'PDF-VIEWER');
    const vp = viewer && (viewer.viewport_ || viewer.viewport);
    if (!vp || !vp.position || !vp.size || typeof vp.setPosition !== 'function') return { error: 'viewer' };
    const max = Math.max(0, Math.round(((vp.contentSize && vp.contentSize.height) || 0) - vp.size.height));
    const read = () => Math.round(vp.position.y);
    const state = (start) => ({ y: read(), max, page: (typeof vp.getMostVisiblePage === 'function' ? vp.getMostVisiblePage() : 0) + 1, pages: (vp.pageDimensions_ && vp.pageDimensions_.length) || null, moved: read() !== start });
    const start = read();
    if (!move) return state(start);
    const target = move.to === 'top' ? 0 : move.to === 'bottom' ? max : start + (move.lines !== undefined ? move.lines : Math.round(vp.size.height * 0.85 * move.screens));
    try { vp.setPosition({ x: vp.position.x, y: Math.min(Math.max(target, 0), max || target) }); } catch { return { error: 'viewer' }; }
    return new Promise((resolve) => {
      let last = read();
      const began = Date.now();
      const tick = () => {
        const now = read();
        if (now === last || Date.now() - began >= 400) return resolve(state(start));
        last = now;
        setTimeout(tick, 50);
      };
      setTimeout(tick, 50);
    });
  })()`;
}

// The scroll tool's answer for a PDF tab, or null when this tab is not showing the viewer (the caller
// then scrolls as a web page).
async function scrollPdf(wc, move) {
  const frame = viewerFrame(wc);
  if (!frame) return null;
  let r;
  try { r = await frame.executeJavaScript(scrollScript(move)); } catch { r = { error: 'viewer' }; }
  if (!r || r.error) return { scrolled: 'none', note: `The PDF viewer did not respond. ${READ_PDF_HINT}` };
  const where = `page ${r.page}${r.pages ? ` of ${r.pages}` : ''}`;
  if (!r.moved) {
    const why = r.y >= r.max - 1 ? 'Already at the end of the PDF' : r.y <= 0 ? 'Already at the top of the PDF' : 'The PDF did not move';
    return { scrolled: 'none', y: r.y, where, note: `${why} (${where}). ${READ_PDF_HINT}` };
  }
  return { scrolled: 'pdf', y: r.y, where };
}

// press_key on a PDF tab: the keys that move through a document become a scroll of the viewer
// itself (the viewer takes keys only while its plugin has the focus, which the AI's keys do not
// give it). Returns the move, or null for any other key (sent as usual).
function keyMove(key, modifiers = []) {
  if (modifiers.some((m) => m === 'control' || m === 'meta' || m === 'alt')) return null;
  const shift = modifiers.includes('shift');
  if (key === 'PageDown' || (key === 'Space' || key === ' ') && !shift) return { screens: 1 };
  if (key === 'PageUp' || (key === 'Space' || key === ' ') && shift) return { screens: -1 };
  if (key === 'ArrowDown') return { lines: 40 };
  if (key === 'ArrowUp') return { lines: -40 };
  if (key === 'Home') return { to: 'top' };
  if (key === 'End') return { to: 'bottom' };
  return null;
}

// A left click at (x, y), CSS px of the tab's viewport, over the tab's DevTools session (attached for the
// moment if nobody holds one). Resolves true when the commands were sent, false when they could not be.
// The click cannot be confirmed from the page (the document is not in it), so the caller says "sent".
async function clickPdf(wc, x, y, { around = (fn) => fn() } = {}) {
  if (!viewerFrame(wc)) return null;
  const dbg = wc.debugger;
  let attached = false;
  try {
    if (!dbg.isAttached()) { dbg.attach('1.3'); attached = true; }
    const at = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
    await around(async () => {
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...at });
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at });
    });
    return true;
  } catch { return false; } finally {
    if (attached) { try { dbg.detach(); } catch {} }
  }
}

module.exports = { scrollPdf, scrollScript, keyMove, clickPdf, READ_PDF_HINT };
