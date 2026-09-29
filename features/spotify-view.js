// What a Spotify widget shows and how it signs in: the per-widget settings (validated), the OAuth
// Authorization Code + PKCE pieces (no client secret: the user's own Client ID is enough), and the
// now-playing answer cut down to display data. Pure functions, no network and no Electron:
// features/widgets.js does the fetching, main.js the browser and loopback part of sign-in, and the
// tests exercise all of this on its own.
'use strict';

const crypto = require('crypto');

// Spotify only accepts a redirect address that was registered on the app, exactly. A loopback
// address over http is allowed, so this one is fixed and Settings tells the user to register it.
const REDIRECT_PORT = 43917;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPES = 'user-read-playback-state user-modify-playback-state';
const MAX_ART_BYTES = 96e3; // the picture travels in the new-tab page's address, so it stays small
const ACTIONS = { play: ['PUT', '/me/player/play'], pause: ['PUT', '/me/player/pause'], next: ['POST', '/me/player/next'], previous: ['POST', '/me/player/previous'] };

const flat = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const ms = (v, max = 1e8) => (Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : 0);

// A Spotify app's Client ID: 32 hex digits. '' when it isn't one.
function cleanClientId(v) {
  const id = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return /^[0-9a-f]{32}$/.test(id) ? id : '';
}
// Lumen's own public Spotify app (PKCE needs no secret, so a Client ID can ship in the browser). Its
// redirect, http://127.0.0.1:43917/callback, is registered on it. While the app is in Spotify's development
// mode only accounts added under User Management in the Spotify dashboard can sign in. LUMEN_SPOTIFY_CLIENT_ID
// overrides it for development; a Client ID the user entered under Advanced beats both.
const BUILTIN_SPOTIFY_CLIENT_ID = 'a838d9aea90848a38fd106ae14fcf5d0';
// Which Client ID signs in: the user's own, else the environment's, else the built-in one. '' if none.
function pickClientId({ user, env, builtin = BUILTIN_SPOTIFY_CLIENT_ID } = {}) {
  return cleanClientId(user) || cleanClientId(env) || cleanClientId(builtin);
}
// The same for this process (the environment is read here, in the main process only).
function effectiveClientId(user) {
  return pickClientId({ user, env: typeof process !== 'undefined' ? process.env?.LUMEN_SPOTIFY_CLIENT_ID : '' });
}
// Where the Client ID in use comes from: 'user' | 'env' | 'builtin' | 'none'.
function clientIdSource({ user, env, builtin = BUILTIN_SPOTIFY_CLIENT_ID } = {}) {
  return cleanClientId(user) ? 'user' : cleanClientId(env) ? 'env' : cleanClientId(builtin) ? 'builtin' : 'none';
}
// The stored (or form) config -> a checked one, or null when it isn't an object. The Client ID is the
// user's own and may be empty: the built-in or environment one is used then.
function cleanConfig(c) {
  if (!c || typeof c !== 'object') return null;
  return { clientId: cleanClientId(c.clientId), art: c.art !== false };
}

// ---- sign-in (RFC 7636 PKCE) ----
function pkce() {
  const verifier = crypto.randomBytes(64).toString('base64url'); // 86 characters (43 to 128 allowed)
  return {
    verifier,
    challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    state: crypto.randomBytes(16).toString('hex'),
  };
}
function authorizeUrl(base, { clientId, challenge, state }) {
  return `${base}/authorize?${new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: REDIRECT_URI, scope: SCOPES,
    code_challenge_method: 'S256', code_challenge: challenge, state, show_dialog: 'false',
  })}`;
}
// The token endpoint takes a form body. kind: 'code' (first sign-in) or 'refresh'.
function tokenForm(kind, { clientId, code, verifier, refresh }) {
  return new URLSearchParams(kind === 'refresh'
    ? { grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId }
    : { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier }).toString();
}
// A token answer -> { access, refresh, exp } (exp: when to stop using it, a little early). The
// refresh token is only sometimes sent again; then the old one stays valid.
function parseToken(text, now, previousRefresh = '') {
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!body || typeof body.access_token !== 'string' || !body.access_token || body.access_token.length > 4096) throw new Error('Spotify sent something unexpected.');
  const refresh = typeof body.refresh_token === 'string' && body.refresh_token.length <= 4096 ? body.refresh_token : previousRefresh;
  if (!refresh) throw new Error('Spotify sent something unexpected.');
  const seconds = Number.isFinite(body.expires_in) ? Math.min(3600, Math.max(60, body.expires_in)) : 3600;
  return { access: body.access_token, refresh, exp: now + (seconds - 30) * 1000 };
}
function errorCode(text) {
  try {
    const b = JSON.parse(text);
    return { error: typeof b?.error === 'string' ? b.error : '', reason: flat(b?.error?.reason, 40), message: flat(typeof b?.error === 'object' ? b.error.message : b?.error_description, 160) };
  } catch { return { error: '', reason: '', message: '' }; }
}
// A failed token request -> what the user should read.
function tokenError(status, text) {
  const { error } = errorCode(text);
  if (error === 'invalid_client') return 'Spotify doesn’t know that Client ID. Check it in Settings.';
  if (error === 'invalid_grant' || status === 400 || status === 401) return 'Spotify signed Lumen out. Connect Spotify again in Settings.';
  if (status === 429) return 'Spotify asked Lumen to slow down. It will try again shortly.';
  return `Spotify answered ${status}.`;
}
// A failed player request -> what the user should read.
function playerError(status, text) {
  const { reason, message } = errorCode(text);
  if (reason === 'NO_ACTIVE_DEVICE' || (status === 404 && !reason)) return 'No active Spotify device. Start playing in a Spotify app, then try again.';
  if (reason === 'PREMIUM_REQUIRED') return 'Playback controls need Spotify Premium.';
  if (reason === 'RATE_LIMITED' || status === 429) return 'Spotify asked Lumen to slow down. It will try again shortly.';
  if (status === 401) return 'Spotify refused the sign-in. Connect Spotify again in Settings.';
  if (status === 403) return message || 'Spotify refused that. Connect Spotify again in Settings.';
  return `Spotify answered ${status}.`;
}

// ---- the picture ----
// Only Spotify's own image host, over https.
function isImageUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && !url.username && !url.password && /(^|\.)scdn\.co$/.test(url.hostname);
  } catch { return false; }
}
// Album art candidates: Spotify's own hosts only, the one nearest 300px first, then smaller ones.
function imageUrls(images) {
  const list = (Array.isArray(images) ? images : []).filter((i) => i && typeof i.url === 'string' && isImageUrl(i.url));
  const width = (i) => (Number.isFinite(i.width) ? i.width : 300);
  const near = list.filter((i) => width(i) <= 400).sort((a, b) => width(b) - width(a));
  const rest = list.filter((i) => width(i) > 400).sort((a, b) => width(a) - width(b));
  return [...near, ...rest].map((i) => i.url).slice(0, 3);
}
// Bytes -> a data: URL when they are a JPEG, PNG or WebP small enough (the type comes from the
// bytes, never from what the server claims); null otherwise.
function dataUrl(bytes, max = MAX_ART_BYTES) {
  if (!bytes || !bytes.length || bytes.length > max) return null;
  const b = Buffer.from(bytes);
  const type = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'image/jpeg'
    : b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png'
    : b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' ? 'image/webp' : null;
  return type ? `data:${type};base64,${b.toString('base64')}` : null;
}

// ---- now playing ----
const openUrl = (u) => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && url.hostname === 'open.spotify.com' && !url.username && !/[\s"'<>\\]/.test(u) ? url.href : '';
  } catch { return ''; }
};
// GET /me/player (a 204 gives no body: pass null) -> what the card shows. `images` are candidate
// picture addresses that widgets.js swaps for a data: URL; the page never gets an address.
function normalizePlayback(body, now = Date.now()) {
  const idle = { state: 'idle', title: '', artist: '', album: '', progressMs: 0, durationMs: 0, at: now, device: flat(body?.device?.name, 60), kind: 'none', url: '', images: [] };
  if (!body || typeof body !== 'object') return idle;
  const type = body.currently_playing_type;
  const item = body.item && typeof body.item === 'object' ? body.item : null;
  const state = body.is_playing === true ? 'playing' : 'paused';
  const device = flat(body.device?.name, 60);
  if (type === 'ad') return { ...idle, state, title: 'Advertisement', kind: 'ad', device, progressMs: ms(body.progress_ms) };
  if (!item) return { ...idle, device };
  const episode = item.type === 'episode';
  const artist = episode
    ? flat(item.show?.publisher || item.show?.name, 120)
    : (Array.isArray(item.artists) ? item.artists : []).map((a) => flat(a?.name, 60)).filter(Boolean).slice(0, 4).join(', ');
  const durationMs = ms(item.duration_ms);
  const progress = ms(body.progress_ms);
  return {
    state,
    title: flat(item.name, 200) || 'Untitled',
    artist,
    album: episode ? flat(item.show?.name, 120) : flat(item.album?.name, 120),
    progressMs: durationMs ? Math.min(progress, durationMs) : progress,
    durationMs,
    at: now,
    device,
    kind: episode ? 'episode' : 'track',
    url: openUrl(item.external_urls?.spotify),
    images: imageUrls(episode ? (item.images?.length ? item.images : item.show?.images) : item.album?.images),
  };
}
// Where the playhead is at `now`: it moves on while playing, and never past the end.
function progressNow(data, now = Date.now()) {
  if (!data || !Number.isFinite(data.progressMs)) return 0;
  const moved = data.state === 'playing' && Number.isFinite(data.at) ? Math.max(0, now - data.at) : 0;
  const at = data.progressMs + moved;
  return data.durationMs > 0 ? Math.min(at, data.durationMs) : at;
}
// A card's button -> the player call it makes, or null.
function actionRequest(name) {
  const a = Object.prototype.hasOwnProperty.call(ACTIONS, name) ? ACTIONS[name] : null;
  return a ? { method: a[0], path: a[1] } : null;
}

module.exports = {
  REDIRECT_PORT, REDIRECT_URI, SCOPES, MAX_ART_BYTES, ACTIONS,
  BUILTIN_SPOTIFY_CLIENT_ID, cleanClientId, pickClientId, effectiveClientId, clientIdSource, cleanConfig, pkce, authorizeUrl, tokenForm, parseToken, tokenError, playerError,
  isImageUrl, imageUrls, dataUrl, normalizePlayback, progressNow, actionRequest,
};
