// The hovered link's address in a small bottom-left bubble over the page, as Chrome shows it (the page's 'update-target-url').
// One small view per window, made on the first hover (never at startup) and reused: a hover only changes its text and bounds.
// It is a separate view, so the AI's page screenshots (webContents.capturePage) never include it, it never takes focus,
// and when the pointer reaches it the bubble hops to the other bottom corner (a view cannot be click-through).
const path = require('path');
const { pathToFileURL } = require('url');
const { trailingThrottle } = require('../browser/trailing-throttle');

const MAX_CHARS = 72; // longer addresses are cut in the middle (the host and the end stay readable)
const CHAR_PX = 6.3; // the bubble's width is estimated from the text: the view is only as wide as the bubble, so it never covers more page than it shows
const HEIGHT = 24;
const HIDE_MS = 120; // a pointer moving from one link to the next does not make the bubble blink
const THROTTLE_MS = 50;

function shortenMiddle(text, max = MAX_CHARS) {
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.6);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

// deps: { WebContentsView, preloadPath, hardenOwnView(wc, url), raise(win) }
function createLinkStatus(deps) {
  const PAGE = path.join(__dirname, '..', 'renderer', 'link-status.html');
  const states = new Map(); // win -> { view, side, text, bounds, apply (throttled), hideTimer }

  function stateOf(win) {
    let s = states.get(win);
    if (s) return s;
    const view = new deps.WebContentsView({ webPreferences: { preload: deps.preloadPath, sandbox: true, contextIsolation: true } });
    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    win.contentView.addChildView(view);
    deps.hardenOwnView(view.webContents, pathToFileURL(PAGE).href);
    s = { view, side: 'left', text: '', bounds: null, hideTimer: null, ready: false };
    s.apply = trailingThrottle(() => place(win, s), THROTTLE_MS);
    // A new view takes the focus while it loads: it goes straight back to where it was.
    const had = [win.webContents, ...win.contentView.children.map((v) => v.webContents)].find((wc) => wc && !wc.isDestroyed() && wc.isFocused() && wc !== view.webContents);
    view.webContents.on('focus', () => { if (had && !had.isDestroyed()) had.focus(); });
    view.webContents.once('did-finish-load', () => { s.ready = true; setTimeout(() => { if (!view.webContents.isDestroyed()) view.webContents.removeAllListeners('focus'); }, 500); place(win, s); });
    view.webContents.loadFile(PAGE);
    win.once('closed', () => { states.delete(win); try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch { /* gone */ } });
    states.set(win, s);
    return s;
  }

  function place(win, s) {
    if (win.isDestroyed() || s.view.webContents.isDestroyed()) return;
    if (!s.text || !s.bounds || !s.ready) { s.view.setVisible(false); return; }
    const b = s.bounds;
    const width = Math.round(Math.min(Math.max(80, s.text.length * CHAR_PX + 24), b.width - 8));
    const x = s.side === 'left' ? b.x : b.x + b.width - width;
    s.view.setBounds({ x: Math.round(x), y: Math.round(b.y + b.height - HEIGHT), width, height: HEIGHT });
    s.view.webContents.send('linkstatus:text', s.text);
    if (!s.view.getVisible()) { s.view.setVisible(true); win.contentView.addChildView(s.view); deps.raise?.(win); }
  }

  // `url` is what the page reports ('' once the pointer leaves the link); `bounds` the page view's rectangle in the window.
  function update(win, url, bounds) {
    if (!win || win.isDestroyed()) return;
    const text = typeof url === 'string' ? shortenMiddle(url) : '';
    if (!text) {
      const s = states.get(win);
      if (!s || !s.text || s.hideTimer) return;
      s.hideTimer = setTimeout(() => { s.hideTimer = null; s.text = ''; s.apply.cancel(); place(win, s); }, HIDE_MS);
      return;
    }
    const s = stateOf(win);
    clearTimeout(s.hideTimer);
    s.hideTimer = null;
    s.text = text;
    s.bounds = bounds;
    s.apply();
  }

  function hide(win) {
    const s = states.get(win);
    if (!s || !s.text) return;
    clearTimeout(s.hideTimer);
    s.hideTimer = null;
    s.text = '';
    s.apply.cancel();
    place(win, s);
  }

  // The pointer entered the bubble: it moves to the other corner.
  function dodge(sender) {
    for (const [win, s] of states) {
      if (s.view.webContents !== sender) continue;
      s.side = s.side === 'left' ? 'right' : 'left';
      place(win, s);
    }
  }

  return { update, hide, dodge };
}

module.exports = { createLinkStatus, shortenMiddle };
