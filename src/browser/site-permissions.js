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
const SHIMMED = ['geolocation', 'notifications', 'camera', 'microphone', 'clipboard-read'];
// Electron has one 'media' permission; Lumen decides the camera and the microphone separately (keys origin|camera and
// origin|microphone), as Chrome does: allowing one never covers the other.
const MEDIA_DEVICES = ['camera', 'microphone'];
const mediaDevices = (details) => {
  const types = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
  const out = MEDIA_DEVICES.filter((d) => types.includes(d === 'camera' ? 'video' : 'audio'));
  return out.length ? out : [...MEDIA_DEVICES]; // a request that names neither asks for both
};
// A permission check names its one device (details.mediaType); 'unknown' (device enumeration) needs either one.
const checkDevices = (details) => (details?.mediaType === 'video' ? ['camera'] : details?.mediaType === 'audio' ? ['microphone'] : [...MEDIA_DEVICES]);

// The decisions a request is about: { deny, ask }. deny: a device already refused (or blocked by default) refuses the
// whole request; ask: the devices (or the one permission) with no decision yet, which are all a prompt asks about.
function plan(decisions, origin, permission, details, isBlocked = () => false) {
  const names = permission === 'media' ? mediaDevices(details) : [permission];
  const ask = [];
  for (const name of names) {
    const key = `${origin}|${name}`;
    if (decisions.has(key)) { if (!decisions.get(key)) return { deny: true, ask: [] }; continue; }
    if (isBlocked(name)) return { deny: true, ask: [] };
    ask.push(name);
  }
  return { deny: false, ask };
}
// Whether a permission CHECK is answered yes: a decision of true (for media, for the named device, or either when unnamed).
function allowedNow(decisions, origin, permission, details) {
  if (permission !== 'media') return decisions.get(`${origin}|${permission}`) === true;
  return checkDevices(details).some((d) => decisions.get(`${origin}|${d}`) === true);
}
// Decisions saved by older versions were one entry for both devices (origin|media): each becomes a camera and a microphone
// entry with the same answer, so earlier grants and refusals keep working. True when anything changed.
function migrate(decisions) {
  let changed = false;
  for (const [key, value] of [...decisions]) {
    if (!key.endsWith('|media')) continue;
    const origin = key.slice(0, -'|media'.length);
    for (const device of MEDIA_DEVICES) if (!decisions.has(`${origin}|${device}`)) decisions.set(`${origin}|${device}`, value);
    decisions.delete(key);
    changed = true;
  }
  return changed;
}

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

// The wording key for a permission prompt (permission.<name> in locales/en.json). A site asking for only the camera, or only
// the microphone, is asked about only that (details.mediaTypes: the devices still undecided).
function promptKey(permission, details) {
  if (permission !== 'media') return `permission.${permission}`;
  const types = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
  const video = types.includes('video');
  const audio = types.includes('audio');
  return video && !audio ? 'permission.media.video' : audio && !video ? 'permission.media.audio' : 'permission.media';
}

module.exports = { plan, allowedNow, migrate, mediaDevices, MEDIA_DEVICES, promptKey, ALWAYS_ALLOWED, STORAGE_ACCESS, SHIMMED, canonicalOrigin, requestOrigin, checkOrigin, alwaysAllowed, register, statesFor, notify, installIpc };
