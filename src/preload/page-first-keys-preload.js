// Tells the main process whether a page handled a keyboard shortcut (features/page-first-keys.js has the whole story).
// Registered session-wide as a 'frame' preload, which runs in a tab's main frame only. It listens on the window in the CAPTURE phase, so
// it sees every key press before any page handler (even one that stops propagation), and looks at `defaultPrevented` once the event has
// finished dispatching, which is the same thing Chrome checks before it runs Save page, Print or Find. Only Ctrl / Cmd chords and F3 are
// reported, and only genuine key presses (synthetic events from page script are not trusted).
//
// A key typed into a frame never reaches the main window, and Google Docs types into a same-origin iframe, so the listener is also put
// on every same-origin frame, now and as frames come and go (a cross-origin frame cannot be reached from here: main.js keeps Lumen's keys
// there, see isReady). Hooking a frame twice does nothing (the same listener on the same window is added once).
const { ipcRenderer } = require('electron');

if (/^https?:$/.test(location.protocol)) {
  try { ipcRenderer.send('page-first-keys:ready'); } catch { /* not reachable: the key stays Lumen's */ }

  const onKey = (e) => {
    if (!e.isTrusted || e.repeat) return;
    const key = typeof e.key === 'string' ? e.key : '';
    if (!(e.ctrlKey || e.metaKey || key === 'F3')) return;
    const report = { key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey };
    setTimeout(() => { try { ipcRenderer.send('page-first-keys:done', { ...report, prevented: e.defaultPrevented }); } catch { /* the page is going away */ } }, 0);
  };
  window.addEventListener('keydown', onKey, true);

  // Same-origin frames (and theirs). Reading the window of a cross-origin frame throws.
  const hookFrame = (frame) => {
    try {
      const inner = frame.contentWindow;
      if (!inner || !inner.document) return;
      inner.addEventListener('keydown', onKey, true);
      hookFrames(inner.document);
    } catch { /* cross-origin */ }
  };
  const hookFrames = (root) => { try { for (const frame of root.querySelectorAll('iframe, frame')) hookFrame(frame); } catch { /* not a document yet */ } };
  const isFrame = (n) => n && (n.tagName === 'IFRAME' || n.tagName === 'FRAME');
  window.addEventListener('load', (e) => { if (isFrame(e.target)) hookFrame(e.target); }, true); // a frame finished loading (load does not bubble: captured)
  window.addEventListener('focus', () => hookFrames(document), true); // focus moves into a frame: it is hooked by then
  try {
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) { if (isFrame(n)) hookFrame(n); else if (n.nodeType === 1 && n.querySelector) hookFrames(n); }
    }).observe(document, { childList: true, subtree: true });
  } catch { /* no document yet: the events above cover it */ }
  document.addEventListener('DOMContentLoaded', () => hookFrames(document));
  hookFrames(document);
}
