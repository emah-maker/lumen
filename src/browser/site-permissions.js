// Site permissions, shared by the normal session (main.js) and private windows (features/private-window.js).
//
// Origins: Electron's permission CHECK handler gets the origin with a trailing slash ('http://127.0.0.1:8099/') while
// a decision was stored under new URL().origin ('http://127.0.0.1:8099'), so a granted permission read back as
// denied. Every decision is now read and written under canonicalOrigin().
//
// Page-visible state: Electron's check handler can only answer allowed or not, so before the user decides a page
// reads 'denied' where Chrome says 'prompt'. preload/permissions-preload.js asks 'site-permissions:states' (here) for
// the decided permissions of its frame's origin and shows 'prompt' / 'default' for the rest; notify() tells open
// pages when a decision changes so PermissionStatus 'change' events fire.

// Allowed without asking, as Chrome does. display-capture: the screen picker is the consent. Wake lock, sensors,
// background sync and payment handlers are never prompted for in Chrome.
const ALWAYS_ALLOWED = new Set([
  'fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'mediaKeySystem', 'display-capture',
  'screen-wake-lock', 'system-wake-lock', 'sensors', 'background-sync', 'payment-handler',
]);
// Chrome grants these for a third-party frame without a prompt when the site is related to the page (and prompts
// otherwise); Lumen grants them (embedded players such as Netflix's call requestStorageAccess) unless the user turned
// on "Block third-party cookies", where the answer stays no.
const STORAGE_ACCESS = new Set(['storage-access', 'top-level-storage-access']);
// The permissions Lumen asks about, which a page reads as 'prompt' until the user decides.
const SHIMMED = ['geolocation', 'notifications', 'media', 'clipboard-read'];

// The http(s) origin of the first candidate that has one (a URL or an origin, with or without a trailing slash).
function canonicalOrigin(...candidates) {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'string') continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
    } catch { /* try the next one */ }
  }
  return '';
}
// The origin a permission request is about: the asking frame, else the tab.
const requestOrigin = (wc, details) => canonicalOrigin(details?.requestingUrl, wc?.getURL?.());
// The origin a permission check is about.
const checkOrigin = (requestingOrigin, details) => canonicalOrigin(requestingOrigin, details?.requestingUrl, details?.securityOrigin);

const alwaysAllowed = (permission, { blockThirdPartyCookies = false } = {}) =>
  ALWAYS_ALLOWED.has(permission) || (STORAGE_ACCESS.has(permission) && !blockThirdPartyCookies);

const registry = new WeakMap(); // session -> { decisions, isBlocked }
function register(ses, { decisions, isBlocked }) { registry.set(ses, { decisions, isBlocked: isBlocked || (() => false) }); }

// permission -> 'granted' | 'denied' for what the user (or the Block default) already decided at this origin.
function statesFor(ses, origin) {
  const states = {};
  const entry = registry.get(ses);
  if (!entry || !origin) return states;
  for (const permission of SHIMMED) {
    const key = `${origin}|${permission}`;
    if (entry.decisions.has(key)) states[permission] = entry.decisions.get(key) ? 'granted' : 'denied';
    else if (entry.isBlocked(permission)) states[permission] = 'denied';
  }
  return states;
}

// Tells every frame of every page in `ses` that decisions changed (each frame asks again for its own origin).
function notify(ses) {
  try {
    for (const wc of require('electron').webContents.getAllWebContents()) {
      if (wc.isDestroyed() || wc.session !== ses) continue;
      for (const frame of wc.mainFrame.framesInSubtree) { try { frame.send('site-permissions:changed'); } catch { /* frame gone */ } }
    }
  } catch { /* no windows yet */ }
}

function installIpc(ipcMain) {
  ipcMain.on('site-permissions:states', (event) => {
    try { event.returnValue = statesFor(event.sender.session, canonicalOrigin(event.senderFrame?.url)); } catch { event.returnValue = {}; }
  });
}

module.exports = { ALWAYS_ALLOWED, STORAGE_ACCESS, SHIMMED, canonicalOrigin, requestOrigin, checkOrigin, alwaysAllowed, register, statesFor, notify, installIpc };
