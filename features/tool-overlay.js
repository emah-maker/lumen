// ---------- tool overlay: one transparent view for the screenshot chooser, area picker, toasts, QR card ----------
//
// Same pattern as features/dialogs.js (a WebContentsView on top of the window showing one local
// page, renderer/tool-overlay.html), but one per window so a private window can have its own, and
// with several modes that size themselves differently: the chooser and QR card cover the window
// (like a dialog), the area picker covers just the page, and a toast is a small corner card that
// leaves the page clickable. Only one session per window; a new one replaces the old.
//
// show(win, { mode, payload, bounds, focus, onAction, onClose, restoreFocus }) -> session.
// The page sends { id, action, data } back; only the overlay's own top frame is answered, and only
// for the session that is currently on screen.
const path = require('path');
const { pathToFileURL } = require('url');

const HTML = path.join(__dirname, '..', 'renderer', 'tool-overlay.html');
const PRELOAD = path.join(__dirname, '..', 'tool-overlay-preload.js');
const TOAST = { width: 380, height: 118, margin: 16 };

// deps: { ipcMain, WebContentsView }
function createToolOverlay(deps) {
  const rec = new Map(); // BrowserWindow -> { view, session, resize }
  let seq = 0;
  const ownUrl = pathToFileURL(HTML).href.toLowerCase();
  const isOwn = (url) => { try { const u = new URL(url); u.search = ''; u.hash = ''; return u.href.toLowerCase() === ownUrl; } catch { return false; } };
  const alive = (win) => win && !win.isDestroyed();

  function ensure(win) {
    let r = rec.get(win);
    if (r && !r.view.webContents.isDestroyed()) return r;
    const view = new deps.WebContentsView({ webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    view.setBackgroundColor('#00000000');
    view.webContents.on('will-navigate', (event) => { if (!isOwn(event.url)) event.preventDefault(); });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.loadFile(HTML).catch(() => {});
    r = { view, session: null, resize: null, ready: new Promise((resolve) => view.webContents.once('did-finish-load', resolve)) };
    rec.set(win, r);
    win.once('closed', () => { rec.delete(win); });
    return r;
  }

  function layout(win, r) {
    if (!alive(win) || !r.session) return;
    const [width, height] = win.getContentSize();
    const b = typeof r.session.bounds === 'function' ? r.session.bounds() : r.session.bounds;
    if (b) r.view.setBounds({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)) });
    else if (r.session.mode === 'toast') r.view.setBounds({ x: Math.max(0, width - TOAST.width - TOAST.margin), y: Math.max(0, height - TOAST.height - TOAST.margin), width: TOAST.width, height: TOAST.height });
    else r.view.setBounds({ x: 0, y: 0, width, height });
  }

  function hide(win, session) {
    const r = rec.get(win);
    if (!r || !r.session || (session && r.session !== session)) return;
    const done = r.session;
    r.session = null;
    if (r.resize && alive(win)) win.removeListener('resize', r.resize);
    r.resize = null;
    try { r.view.setVisible(false); if (alive(win)) win.contentView.removeChildView(r.view); } catch {}
    try { done.onClose?.(); } catch {}
    if (done.focus && done.restoreFocus) { try { done.restoreFocus(); } catch {} }
  }

  async function show(win, opts) {
    if (!alive(win)) return null;
    const r = ensure(win);
    if (r.session) hide(win);
    const session = {
      id: ++seq, mode: opts.mode, bounds: opts.bounds || null, focus: opts.focus !== false && opts.mode !== 'toast',
      onAction: opts.onAction, onClose: opts.onClose, restoreFocus: opts.restoreFocus,
    };
    r.session = session;
    layout(win, r);
    r.resize = () => layout(win, r);
    win.on('resize', r.resize);
    win.contentView.addChildView(r.view); // re-adding raises it above the tabs
    r.view.setVisible(true);
    await r.ready;
    if (r.session !== session || r.view.webContents.isDestroyed()) return session;
    r.view.webContents.send('tool-overlay:show', { id: session.id, mode: opts.mode, payload: opts.payload || {} });
    if (session.focus) r.view.webContents.focus();
    return session;
  }

  deps.ipcMain.on('tool-overlay:action', (event, msg) => {
    for (const [win, r] of rec) {
      if (event.sender !== r.view.webContents || event.senderFrame !== event.sender.mainFrame) continue;
      const session = r.session;
      if (!session || !msg || msg.id !== session.id || typeof msg.action !== 'string') return; // stale
      if (msg.action === 'close') { hide(win, session); return; }
      Promise.resolve(session.onAction?.(msg.action, msg.data && typeof msg.data === 'object' ? msg.data : {}, session)).catch(() => {});
      return;
    }
  });
  // Tells the page to show a short status line ("Copied") in the current session.
  function update(win, session, data) {
    const r = rec.get(win);
    if (!r || r.session !== session || r.view.webContents.isDestroyed()) return;
    r.view.webContents.send('tool-overlay:update', { id: session.id, ...data });
  }

  return {
    show,
    update,
    hide: (win, session) => hide(win, session),
    layout: (win) => { const r = rec.get(win); if (r) layout(win, r); },
    // Test hooks
    viewFor: (win) => rec.get(win)?.view || null,
    currentFor: (win) => rec.get(win)?.session || null,
    isOwnView: (wc) => [...rec.values()].some((r) => r.view.webContents === wc),
  };
}

module.exports = { createToolOverlay, HTML, TOAST };
