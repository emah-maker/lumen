// A music site's own web player as a card on the new-tab page: the shared part of the Spotify widget's
// "Web player" mode (features/spotify-web.js) and the Apple Music widget (features/apple-music-web.js). There is
// no API, Client ID or account limit involved: the user signs in on the site like on any other site, in their
// normal browsing session, and Widevine plays the audio.
//
// These sites forbid being framed (X-Frame-Options / frame-ancestors), so an <iframe> can't be used. Instead one
// WebContentsView per player (so one per Lumen process) is laid over the card's placeholder (.sp-web-slot, drawn
// by renderer/newtab-widgets.js): main asks the new-tab page where that slot is (a constant script, no channel
// from the page), and sets the view's bounds to it. Leaving the new-tab page only hides the view, it is never
// reloaded per new tab, so the music keeps playing.
//
// A player is described by a spec: { url, hosts (a Set: the pages the view may show), cardClass (the card's
// class on the page), signIn?: { cookie, domain (RegExp) } (the cookie the site keeps while someone is signed in; a
// player that learns it another way leaves it out), preload?: the path of a preload script of ours for the view (the Apple
// Music engine's bridge), hiddenViewport?: { width, height } (the size the page is laid out at while the view is not on screen: an
// unattached view is 0 by 0, and a music site's player lays itself out, or starts its player, for a window that has a size), popups?: true (sign-in pages on the allowed hosts open as windows of their own, so they can
// answer the page that opened them) }.
//
// The pure parts (address allow-list, permissions, geometry) come first so the tests can exercise them without
// Electron; createWebPlayer() is the Electron part main.js instantiates.
'use strict';

const MIN_LAYOUT_WIDTH = 400; // CSS px: below this the page is zoomed out so the site gets a compact layout, not a cramped one
const MIN_ZOOM = 0.5;
const MIN_SIDE = 60; // px: a card slot smaller than this (or mostly scrolled away) isn't worth a live view
const RETRY_MS = 20e3; // a load that failed (offline, a site outage) is tried again after this, while the card is on screen
const DRM_RETRY_MS = 5e3; // the Widevine component installs in the background on a first run: ask again until it is there
const DRM_MAX_TRIES = 30;
// Chromium's net error numbers (net/base/net_error_list.h) for "the network isn't there": the card says to
// check the connection. -3 (ABORTED) is only a navigation that was replaced, never a failure.
const OFFLINE_ERRORS = new Set([-7, -21, -100, -101, -102, -105, -106, -109, -118]);

// May the view stay on this address? https on one of the player's hosts only, the default port, no user:password@.
function isAllowedUrl(url, hosts, testOrigin = '') {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (testOrigin && u.origin === testOrigin) return true; // tests serve a stand-in for the site: main.js only passes this in test mode
  return hosts.has(u.hostname) && !u.port;
}

// A failed main-frame load -> what the card says: 'offline' | 'failed', or null when it isn't a failure
// (a navigation that another one replaced, or a sub-frame).
function loadFailure(errorCode, isMainFrame = true) {
  if (!isMainFrame || errorCode === -3 || !Number.isFinite(errorCode)) return null;
  return OFFLINE_ERRORS.has(errorCode) ? 'offline' : 'failed';
}

// The script main runs inside the player's page to learn whether this build of Lumen can play protected audio
// (Widevine). Constant; it only reads a yes or a no.
const DRM_PROBE = `(async () => {
  try {
    await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{ initDataTypes: ['cenc'], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }] }]);
    return true;
  } catch { return false; }
})()`;

// Permissions the view is given: only what playing protected audio needs. 'mediaKeySystem' is Electron's
// name for EME/Widevine key-system access ('protectedMediaIdentifier' is the older one). Autoplay is not
// a permission: the view's autoplayPolicy covers it. Camera, microphone, location, notifications,
// clipboard and everything else are refused without asking.
function permissionAllowed(permission) {
  return permission === 'mediaKeySystem' || permission === 'protectedMediaIdentifier';
}

// The page zoom that makes a card `width` px wide lay the site out at MIN_LAYOUT_WIDTH CSS px at least.
function layoutZoom(width) {
  if (!(width > 0)) return 1;
  return Math.min(1, Math.max(MIN_ZOOM, Math.round((width / MIN_LAYOUT_WIDTH) * 100) / 100));
}

// The script main runs in the new-tab page to find the card's slot. Constant per player: nothing from anywhere
// else goes into it (cardClass is one of our own constants). null when there is no Web-player card, or the page is being edited or has a picker open.
const probeScript = (cardClass) => `(() => {
  const s = document.querySelector('.w-card.${cardClass} .sp-web-slot');
  if (!s || document.body.classList.contains('w-editing') || document.querySelector('.w-picker, dialog[open]')) return null;
  const r = s.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
})()`;

// The new-tab page tells main where the slots are (renderer/newtab-web-slot.js): a console message on the page, which needs no preload or channel
// (a plain web page has none), is only read from the visible new-tab page, and only moves a view over it. The message is the prefix and
// a JSON object { <cardClass>: { x, y, w, h } | null }, sent when a slot moves or changes size (and when the page is edited or a dialog opens).
const SLOT_PREFIX = 'lumen-slot-rect ';
// -> the rect for this card class ({ x, y, w, h } or null for "no usable slot"), or undefined when the message is not one of those.
function parseSlotMessage(message, cardClass) {
  if (typeof message !== 'string' || !message.startsWith(SLOT_PREFIX) || message.length > 2000) return undefined;
  let all;
  try { all = JSON.parse(message.slice(SLOT_PREFIX.length)); } catch { return undefined; }
  if (!all || typeof all !== 'object' || Array.isArray(all) || !(cardClass in all)) return undefined;
  const r = all[cardClass];
  if (r === null) return null;
  return r && typeof r === 'object' ? { x: r.x, y: r.y, w: r.w, h: r.h } : undefined;
}

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
//         activeNewTab() (the visible new-tab page's webContents, or null), hasWidget() (is this player's card
//         configured), openTab(url), isWebUrl(url), onSignIn(), onStatus() (the view's state changed: the card
//         says so), testUrl() (tests only: an https stand-in for the site, on any host), drmProbe(wc)?
//         (tests only: replaces the Widevine check), keepAlive()? (the view is wanted even with no card to show it on: it
//         is made on demand by ensure() and kept, hidden) }
function createWebPlayer(deps, spec) {
  let view = null;
  let host = null;
  let probing = false;
  let retryTimer = null;
  const watched = new WeakSet(); // the new-tab pages whose slot messages are being read
  let signedIn = null; // null: not known yet
  let cookiesHooked = false;
  const PROBE = probeScript(spec.cardClass);
  // What the card says about the view: 'loading' | 'ready' | 'offline' | 'failed', and whether protected audio
  // (Widevine) can play here: 'unknown' | 'ok' | 'missing'.
  let state = 'loading';
  let drm = 'unknown';
  let failedAt = 0;
  let drmTimer = null;
  let drmTries = 0;
  // Counts the main-frame documents the view has started loading (not in-page route changes): an engine's bridge belongs to the document it
  // ran in, so a command sent after a reload (or a sign-in round trip) must wait for the new document's bridge, not go to nobody.
  let generation = 0;
  const alive = () => view && !view.webContents.isDestroyed();
  const baseUrl = () => deps.testUrl?.() || spec.url;
  const testOrigin = () => { try { return deps.testUrl?.() ? new URL(deps.testUrl()).origin : ''; } catch { return ''; } };
  const allowed = (url) => isAllowedUrl(url, spec.hosts, testOrigin());
  const status = () => ({ state, drm });
  // The push channel: onState(cb) -> unsubscribe. cb({ type: 'status', state, drm }) when the view's load state or Widevine answer changes, and
  // cb({ type: 'message', message }) for each state message the page's bridge sends (main forwards them with emitState), at once, never batched.
  const listeners = new Set();
  const emit = (event) => { for (const cb of [...listeners]) { try { cb(event); } catch { /* a listener's error is its own */ } } };
  function setStatus(next, nextDrm = drm) {
    if (next === state && nextDrm === drm) return;
    state = next;
    drm = nextDrm;
    failedAt = next === 'offline' || next === 'failed' ? Date.now() : 0;
    clearTimeout(retryTimer);
    retryTimer = failedAt ? setTimeout(retry, RETRY_MS) : null;
    retryTimer?.unref?.();
    try { deps.onStatus?.(); } catch { /* the card keeps what it shows */ }
    emit({ type: 'status', ...status() });
  }

  // Can this Lumen play protected audio? the player needs Widevine; the component installs in the
  // background on a first run (or never, on a build without it), so ask again for a while.
  function checkDrm() {
    clearTimeout(drmTimer);
    if (!alive() || drm === 'ok') return;
    const wc = view.webContents;
    Promise.resolve(deps.drmProbe ? deps.drmProbe(wc) : wc.executeJavaScript(DRM_PROBE)).then((ok) => {
      if (!alive() || view.webContents !== wc) return;
      if (ok === true) { drmTries = 0; setStatus(state, 'ok'); return; }
      setStatus(state, 'missing');
      if (++drmTries < DRM_MAX_TRIES) drmTimer = setTimeout(checkDrm, DRM_RETRY_MS);
    }, () => { /* the page went away mid-check: the next load asks again */ });
  }

  // A load that failed is tried again after RETRY_MS while the card is on screen (one timer, only while the load is in a failed state).
  function retry() {
    retryTimer = null;
    if (!alive() || (state !== 'offline' && state !== 'failed')) return;
    if (deps.hasWidget() && deps.activeNewTab()) { load(); return; }
    retryTimer = setTimeout(retry, RETRY_MS); // not on screen: look again later
    retryTimer.unref?.();
  }

  // Load (or load again) the site into the view.
  function load() {
    if (!alive()) return;
    setStatus('loading');
    view.webContents.loadURL(baseUrl()).catch(() => {}); // a failure arrives as did-fail-load
  }

  function hookCookies() {
    if (cookiesHooked || !spec.signIn) return;
    cookiesHooked = true;
    const ses = deps.session;
    const set = (v) => {
      if (signedIn === v) return;
      const wasOut = signedIn === false;
      signedIn = v;
      try { deps.onSignIn?.(); } catch { /* the card just keeps its old button */ }
      // Signed in somewhere else (the "Open in a tab to sign in" tab): the player in the card still shows its login page.
      if (v && wasOut && alive() && view.webContents.getURL().startsWith(testOrigin() || spec.url)) load();
    };
    // The cookie the site keeps while someone is signed in (spec.signIn). A cookie that is replaced
    // arrives as a removal (cause 'overwrite') and then the new one: that is not a sign-out.
    ses.cookies.on('changed', (_e, cookie, cause, removed) => {
      if (cookie.name === spec.signIn.cookie && spec.signIn.domain.test(cookie.domain) && !(removed && cause === 'overwrite')) set(!removed);
    });
    ses.cookies.get({ url: spec.url, name: spec.signIn.cookie }).then((list) => set(list.length > 0)).catch(() => {});
  }

  // A view that is not on screen is laid out at spec.hiddenViewport (device emulation: a real window size for the page, whatever the view's
  // own bounds); on screen it has its own size, so the emulation is off then.
  let emulating = false;
  function emulate(on) {
    if (!spec.hiddenViewport || !alive()) return;
    const wc = view.webContents;
    try {
      if (on && !emulating) {
        const { width, height } = spec.hiddenViewport;
        wc.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width, height }, viewPosition: { x: 0, y: 0 }, viewSize: { width, height }, deviceScaleFactor: 1, scale: 1 });
        emulating = true;
      } else if (!on && emulating) { wc.disableDeviceEmulation(); emulating = false; }
    } catch { /* the page is going away */ }
  }
  function ensure() {
    if (alive()) return view;
    view = new deps.WebContentsView({
      // The user's normal session (no partition), a page like any tab's: sandboxed, isolated, no Node, and no
      // preload of ours. Music must not be throttled or stopped for lack of a gesture or while hidden.
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false, ...(spec.preload ? { preload: spec.preload } : {}) },
    });
    const wc = view.webContents;
    const leave = (url) => { if (deps.isWebUrl(url)) deps.openTab(url); };
    wc.on('will-navigate', (event) => { if (!allowed(event.url)) { event.preventDefault(); leave(event.url); } });
    wc.on('will-redirect', (event) => { if (!allowed(event.url)) { event.preventDefault(); leave(event.url); } });
    // A sign-in page the site opens (Apple's) is a real window, so it can tell the page that opened it when you are in; its own
    // navigation stays on the allowed hosts. Everything else opens as a tab, in the same session.
    const guard = (child) => {
      child.on('will-navigate', (event) => { if (!allowed(event.url)) { event.preventDefault(); leave(event.url); } });
      child.on('will-redirect', (event) => { if (!allowed(event.url)) { event.preventDefault(); leave(event.url); } });
      child.setWindowOpenHandler(({ url }) => { leave(url); return { action: 'deny' }; });
    };
    wc.setWindowOpenHandler(({ url }) => {
      if (spec.popups && allowed(url)) return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } } };
      leave(url);
      return { action: 'deny' };
    });
    wc.on('did-create-window', (child) => guard(child.webContents));
    wc.on('render-process-gone', () => destroy());
    // A blank frame says nothing: when the page can't load, the card says why (and tries again).
    let failedLoad = false; // Chromium finishes loading its own error page afterwards: that is not the site being ready
    wc.on('did-start-navigation', (event, url, inPlace, isMainFrame) => {
      const main = event?.isMainFrame ?? isMainFrame;
      if (main && !(event?.isSameDocument ?? inPlace)) generation++;
      if (main && !String(event?.url ?? url).startsWith('chrome-error:')) failedLoad = false;
    });
    wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      const why = loadFailure(code, isMainFrame);
      if (why) { failedLoad = true; setStatus(why); }
    });
    let httpCode = 200;
    wc.on('did-navigate', (_e, _url, code) => { httpCode = Number(code) || 200; if (httpCode >= 500) setStatus('failed'); });
    wc.on('did-finish-load', () => {
      if (failedLoad || wc.getURL().startsWith('chrome-error:') || httpCode >= 500) return;
      setStatus('ready');
      if (drm !== 'ok') { drmTries = 0; checkDrm(); }
    });
    hookCookies(); // (a player kept hidden by an engine, with no card to place, still learns whether the user is signed in)
    // (not before the page exists: asking for the emulation of a view with no page yet takes the process down)
    wc.on('did-start-navigation', () => { if (!host || !view || view.webContents !== wc) emulate(true); });
    load();
    return view;
  }

  function destroy() {
    const v = view;
    view = null;
    generation++;
    emulating = false;
    clearTimeout(drmTimer);
    clearTimeout(retryTimer);
    retryTimer = null;
    state = 'loading';
    drm = 'unknown';
    failedAt = 0;
    if (!v) return;
    try { host?.contentView.removeChildView(v); } catch { /* the window is gone */ }
    host = null;
    try { if (!v.webContents.isDestroyed()) v.webContents.close(); } catch { /* already closing */ }
  }

  function hide() {
    if (!alive()) return;
    view.setVisible(false); // stays loaded and playing
    if (!host) emulate(true); // never placed (or released): it has no size of its own
  }

  // The view in a window of its own (a sign-in window), until release(): the card's placing leaves it alone meanwhile.
  let pinned = false;
  function showIn(win, rect) {
    if (!win || win.isDestroyed()) return null;
    const v = ensure();
    if (host && host !== win) { try { host.contentView.removeChildView(v); } catch { /* that window is gone */ } }
    host = win;
    pinned = true;
    emulate(false);
    win.contentView.addChildView(v);
    v.setBounds(rect);
    v.setVisible(true);
    return v;
  }
  function release() {
    pinned = false;
    if (!alive()) return;
    view.setVisible(false);
    try { host?.contentView.removeChildView(view); } catch { /* the window is gone */ }
    host = null;
    emulate(true);
    // (asked again once the removal has settled: the first ask, made as the view leaves the window, is not kept)
    setTimeout(() => { if (alive() && !host) { emulating = false; emulate(true); } }, 150).unref?.();
  }

  function place(rect) {
    if (pinned) return;
    if (!rect || state === 'offline' || state === 'failed') { hide(); return; } // a failed load: the card's message shows, not an error page
    const win = deps.getWindow();
    if (!win || win.isDestroyed()) return;
    const v = ensure();
    const moved = host !== win;
    if (moved) {
      try { host?.contentView.removeChildView(v); } catch { /* it was in a window that is gone */ }
      host = win;
      win.once('closed', () => { if (host === win) destroy(); });
    }
    emulate(false);
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

  // The page pushed where the slot is. Only the visible new-tab page is believed; anything else is ignored.
  function pushed(nt, rect) {
    if (pinned || !deps.hasWidget() || nt.isDestroyed() || deps.activeNewTab() !== nt) return;
    place(viewBounds(rect, deps.getBounds()));
  }
  function watch(nt) {
    if (watched.has(nt)) return;
    watched.add(nt);
    nt.on('console-message', (event, level, message) => {
      const rect = parseSlotMessage(typeof event?.message === 'string' ? event.message : message, spec.cardClass); // (Electron passes either form)
      if (rect !== undefined) pushed(nt, rect);
    });
  }

  // Called whenever the layout changes (a tab switch, the sidebar, a card was added or removed). Nothing polls: between these the page
  // pushes the slot's place itself (above), and this asks once for it, because a tab that was switched back to has told main nothing new.
  function sync() {
    if (pinned) return;
    if (!deps.hasWidget()) { if (deps.keepAlive?.()) hide(); else destroy(); return; }
    hookCookies();
    const nt = deps.activeNewTab();
    if (!nt || nt.isDestroyed()) { hide(); return; }
    watch(nt);
    if (alive() && (state === 'offline' || state === 'failed') && Date.now() - failedAt > RETRY_MS) load();
    probe(nt);
  }

  return {
    sync,
    status,
    onState(cb) { if (typeof cb !== 'function') return () => {}; listeners.add(cb); return () => listeners.delete(cb); },
    emitState: (message) => emit({ type: 'message', message }),
    reload() { if (alive()) load(); else sync(); },
    destroy: () => { pinned = false; destroy(); },
    owns: (wc) => Boolean(wc) && alive() && view.webContents === wc,
    isSignedIn: () => signedIn,
    ensure, showIn, release,
    generation: () => generation, // (see above: which document the view is on)
    webContents: () => (alive() ? view.webContents : null),
    view: () => (alive() ? view : null), // for the window's overlay stacking (main.js raiseOverlays)
  };
}

module.exports = { MIN_LAYOUT_WIDTH, SLOT_PREFIX, parseSlotMessage, isAllowedUrl, permissionAllowed, layoutZoom, viewBounds, loadFailure, probeScript, DRM_PROBE, createWebPlayer };
