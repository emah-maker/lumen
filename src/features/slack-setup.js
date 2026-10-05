// The window the guided Slack setup happens in, and the clipboard watch that spares the user a paste.
// Electron comes in through `deps` (BrowserWindow, clipboard), so tests drive this with fakes.
//
// The window is Lumen's own (no tabs, no extensions, no saved logins: an in-memory session that is gone
// when it closes). It only ever shows https pages on slack.com: every other address is refused, new
// windows are refused, permission requests are refused, and nothing it loads can reach Lumen's own
// APIs (sandboxed, no preload). When Slack sends the browser back to the app's redirect address, the
// navigation is stopped before any request is made, and the address (with the code and state) is handed to
// the caller, which checks the state. Nothing here logs an address, a code or a token.
'use strict';

const SL = require('./slack-view');

const PARTITION = 'slack-setup'; // no "persist:" prefix: in memory only

function create(deps) {
  const { BrowserWindow, clipboard } = deps;
  let win = null;
  let watch = null;

  // Open (or reuse) the setup window at `url`. opts.redirectUri: the address that means "approved";
  // opts.onRedirect(address): called once when Slack sends the window there; opts.onClosed().
  function open(url, opts = {}) {
    if (SL.guardNavigation(url, opts.redirectUri) !== 'allow') throw new Error('Not allowed');
    close();
    const w = new BrowserWindow({
      width: 980, height: 800, minWidth: 560, minHeight: 520, autoHideMenuBar: true, title: 'Connect Slack',
      ...(deps.icon ? { icon: deps.icon } : {}),
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, partition: PARTITION },
    });
    win = w;
    const wc = w.webContents;
    let done = false;
    let opened = ''; // the app whose OAuth page was already opened for the user (once each)
    const guard = (event, target) => {
      const verdict = SL.guardNavigation(target, opts.redirectUri);
      if (verdict === 'allow') return;
      event.preventDefault();
      if (verdict === 'redirect' && !done) {
        done = true;
        try { opts.onRedirect?.(String(target)); } finally { if (win === w) close(); }
      }
    };
    wc.on('will-navigate', (e, target) => guard(e, target));
    wc.on('will-redirect', (e, target) => guard(e, target));
    wc.setWindowOpenHandler((d) => {
      // A link that wants a new window: slack.com pages load here instead.
      if (SL.guardNavigation(d.url, opts.redirectUri) === 'allow') setImmediate(() => { if (!wc.isDestroyed()) wc.loadURL(d.url).catch(() => {}); });
      return { action: 'deny' };
    });
    wc.session?.setPermissionRequestHandler?.((_wc, _permission, cb) => cb(false));
    // After "Create", Slack shows the new app's Basic Information; the token page is one step on.
    if (opts.followToTokenPage) {
      wc.on('did-navigate', (_e, target) => {
        const next = SL.oauthPageFor(target);
        if (next && next !== opened) { opened = next; wc.loadURL(next).catch(() => {}); }
      });
    }
    w.on('closed', () => { if (win === w) win = null; opts.onClosed?.(); });
    w.loadURL(url).catch(() => {});
    return true;
  }
  function close() {
    const w = win;
    win = null;
    if (w && !w.isDestroyed()) w.destroy();
  }
  const isOpen = () => Boolean(win && !win.isDestroyed());

  // Watch the clipboard for a Slack user token (xoxp-…): the user presses Copy on Slack's page and
  // Lumen connects. Only a value that is exactly a token is taken; nothing else on the clipboard is kept,
  // and the watch ends after `ms` (default 15 minutes), when stopped, or after the first token.
  function watchClipboard(onToken, ms = 15 * 60e3, every = 700) {
    stopWatch();
    let last = '';
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - t0 > ms) { stopWatch(); return; }
      let text = '';
      try { text = clipboard.readText(); } catch { return; }
      if (!text || text === last || text.length > 400) return;
      last = text;
      const token = SL.cleanUserToken(text);
      if (!token) return;
      stopWatch();
      onToken(token);
    }, every);
    timer.unref?.();
    watch = timer;
    return true;
  }
  function stopWatch() { if (watch) { clearInterval(watch); watch = null; } }
  const watching = () => Boolean(watch);

  return { open, close, isOpen, watchClipboard, stopWatch, watching };
}

module.exports = { create, PARTITION };
