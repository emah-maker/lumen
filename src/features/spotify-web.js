// Spotify's own website (open.spotify.com) as a card on the new-tab page: the "Web player" mode of the
// Spotify widget. There is no API, Client ID or account limit involved: the user signs in on Spotify's
// site like on any other site, in their normal browsing session, and Widevine plays the audio.
//
// Spotify forbids being framed (X-Frame-Options / frame-ancestors), so the embed widget's <iframe>
// can't be used. Instead one WebContentsView per Lumen process is laid over the card's placeholder
// (.sp-web-slot, drawn by renderer/newtab-widgets.js): main asks the new-tab page where that slot is
// (a constant script, no channel from the page), and sets the view's bounds to it. Leaving the new-tab
// page only hides the view, it is never reloaded per new tab, so the music keeps playing.
//
// The pure parts (widget mode, address allow-list, permissions, geometry) come first so the tests can
// exercise them without Electron; createSpotifyWeb() is the Electron part main.js instantiates.
'use strict';

const WEB_URL = 'https://open.spotify.com/';
// Pages the view may show. Anything else (a Google or Apple sign-in, an ad, an external link) opens in
// a normal tab instead, in the same session.
const HOSTS = new Set(['open.spotify.com', 'accounts.spotify.com']);
const MIN_LAYOUT_WIDTH = 400; // CSS px: below this the page is zoomed out so Spotify gets a compact layout, not a cramped one
const MIN_ZOOM = 0.5;
const MIN_SIDE = 60; // px: a card slot smaller than this (or mostly scrolled away) isn't worth a live view
const POLL_MS = 200;

// The widget's mode. An explicit 'web' | 'api' wins. Widgets saved before this mode existed have the
// API card's fields (clientId, art) and stay 'api'; anything new is 'web'.
function cleanMode(c) {
  if (c && typeof c === 'object') {
    if (c.mode === 'web' || c.mode === 'api') return c.mode;
    if ('clientId' in c || 'art' in c) return 'api';
  }
  return 'web';
}

// May the view stay on this address? https on Spotify's player or sign-in host only, the default port,
// no user:password@.
function isAllowedUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  return u.protocol === 'https:' && HOSTS.has(u.hostname) && !u.port && !u.username && !u.password;
}

// Permissions the view is given: only what playing protected audio needs. 'mediaKeySystem' is Electron's
// name for EME/Widevine key-system access ('protectedMediaIdentifier' is the older one). Autoplay is not
// a permission: the view's autoplayPolicy covers it. Camera, microphone, location, notifications,
// clipboard and everything else are refused without asking.
function permissionAllowed(permission) {
  return permission === 'mediaKeySystem' || permission === 'protectedMediaIdentifier';
}

// The page zoom that makes a card `width` px wide lay Spotify out at MIN_LAYOUT_WIDTH CSS px at least.
function layoutZoom(width) {
  if (!(width > 0)) return 1;
  return Math.min(1, Math.max(MIN_ZOOM, Math.round((width / MIN_LAYOUT_WIDTH) * 100) / 100));
}

// The script main runs in the new-tab page to find the card's slot. Constant: nothing from anywhere
// else goes into it. null when there is no Web-player card, or the page is being edited or has a picker open.
const PROBE = `(() => {
  const s = document.querySelector('.w-card.spotify .sp-web-slot');
  if (!s || document.body.classList.contains('w-editing') || document.querySelector('.w-picker, dialog[open]')) return null;
  const r = s.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
})()`;

// What the page reported -> where to put the view, in window coordinates: the slot cut to the page's
// visible area (`bounds`: the page view's { x, y, width, height } in the window), whole pixels. null when
// nothing usable is visible (hide the view).
function viewBounds(probe, bounds) {
  if (!probe || typeof probe !== 'object' || !bounds) return null;
  const n = [probe.x, probe.y, probe.w, probe.h, bounds.x, bounds.y, bounds.width, bounds.height];
  if (!n.every(Number.isFinite)) return null;
  const left = Math.max(0, probe.x);
  const top = Math.max(0, probe.y);
  const right = Math.min(bounds.width, probe.x + probe.w);
  const bottom = Math.min(bounds.height, probe.y + probe.h);
  if (right - left < MIN_SIDE || bottom - top < MIN_SIDE) return null;
  return { x: Math.round(bounds.x + left), y: Math.round(bounds.y + top), width: Math.round(right - left), height: Math.round(bottom - top) };
}

// deps: { WebContentsView, session (the user's normal one), getWindow(), getBounds() (the page view's bounds),
//         activeNewTab() (the visible new-tab page's webContents, or null), hasWidget() (is a Web-player card
//         configured), openTab(url), isWebUrl(url), onSignIn() }
function createSpotifyWeb(deps) {
  let view = null;
  let host = null;
  let timer = null;
  let probing = false;
  let signedIn = null; // null: not known yet
  let cookiesHooked = false;
  const alive = () => view && !view.webContents.isDestroyed();

  function hookCookies() {
    if (cookiesHooked) return;
    cookiesHooked = true;
    const ses = deps.session;
    const set = (v) => { if (signedIn !== v) { signedIn = v; try { deps.onSignIn?.(); } catch { /* the card just keeps its old button */ } } };
    // sp_dc is the cookie Spotify's site keeps while someone is signed in.
    ses.cookies.on('changed', (_e, cookie, _cause, removed) => {
      if (cookie.name === 'sp_dc' && /(^|\.)spotify\.com$/.test(cookie.domain)) set(!removed);
    });
    ses.cookies.get({ url: WEB_URL, name: 'sp_dc' }).then((list) => set(list.length > 0)).catch(() => {});
  }

  function ensure() {
    if (alive()) return view;
    view = new deps.WebContentsView({
      // The user's normal session (no partition), a page like any tab's: sandboxed, isolated, no Node, and no
      // preload of ours. Music must not be throttled or stopped for lack of a gesture or while hidden.
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false },
    });
    const wc = view.webContents;
    const leave = (url) => { if (deps.isWebUrl(url)) deps.openTab(url); };
    wc.on('will-navigate', (event) => { if (!isAllowedUrl(event.url)) { event.preventDefault(); leave(event.url); } });
    wc.on('will-redirect', (event) => { if (!isAllowedUrl(event.url)) { event.preventDefault(); leave(event.url); } });
    wc.setWindowOpenHandler(({ url }) => { leave(url); return { action: 'deny' }; });
    wc.on('render-process-gone', () => destroy());
    wc.loadURL(WEB_URL).catch(() => {});
    return view;
  }

  function destroy() {
    const v = view;
    view = null;
    if (!v) return;
    try { host?.contentView.removeChildView(v); } catch { /* the window is gone */ }
    host = null;
    try { if (!v.webContents.isDestroyed()) v.webContents.close(); } catch { /* already closing */ }
  }

  function hide() {
    if (alive()) view.setVisible(false); // stays loaded and playing
  }

  function place(rect) {
    if (!rect) { hide(); return; }
    const win = deps.getWindow();
    if (!win || win.isDestroyed()) return;
    const v = ensure();
    const moved = host !== win;
    if (moved) {
      try { host?.contentView.removeChildView(v); } catch { /* it was in a window that is gone */ }
      host = win;
      win.once('closed', () => { if (host === win) destroy(); });
    }
    if (moved || !v.getVisible()) win.contentView.addChildView(v); // (re-)adding puts it above the page
    v.setBounds(rect);
    v.setVisible(true);
    const zoom = layoutZoom(rect.width);
    if (v.webContents.getZoomFactor() !== zoom) v.webContents.setZoomFactor(zoom);
  }

  function probe(nt) {
    if (probing) return;
    probing = true;
    nt.executeJavaScript(PROBE).then((r) => {
      probing = false;
      if (deps.activeNewTab() !== nt) return;
      place(viewBounds(r, deps.getBounds()));
    }, () => { probing = false; });
  }

  function stop() { clearInterval(timer); timer = null; }

  // Called whenever the layout changes (a tab switch, the sidebar) and by the poll below.
  function sync() {
    if (!deps.hasWidget()) { stop(); destroy(); return; }
    hookCookies();
    const nt = deps.activeNewTab();
    if (!nt || nt.isDestroyed()) { stop(); hide(); return; }
    if (!timer) timer = setInterval(sync, POLL_MS); // the card moves when the page scrolls or the grid changes
    probe(nt);
  }

  return {
    sync,
    destroy: () => { stop(); destroy(); },
    owns: (wc) => Boolean(wc) && alive() && view.webContents === wc,
    isSignedIn: () => signedIn,
    view: () => (alive() ? view : null), // for the window's overlay stacking (main.js raiseOverlays)
  };
}

module.exports = { WEB_URL, HOSTS, MIN_LAYOUT_WIDTH, cleanMode, isAllowedUrl, permissionAllowed, layoutZoom, viewBounds, PROBE, createSpotifyWeb };
