// Spotify's own website (open.spotify.com) as a card on the new-tab page: the "Web player" mode of the
// Spotify widget. There is no API, Client ID or account limit involved: the user signs in on Spotify's
// site like on any other site, in their normal browsing session, and Widevine plays the audio.
//
// The view itself (laid over the card's slot, kept playing when the page is left, the Widevine check, offline
// retry) is features/web-player.js, shared with the Apple Music widget; this file is what is Spotify's: the
// widget's mode, the address allow-list and the cookie that says someone is signed in.
'use strict';

const path = require('path');
const WP = require('./web-player');

const WEB_URL = 'https://open.spotify.com/';
// Pages the view may show. Anything else (a Google or Apple sign-in, an ad, an external link) opens in
// a normal tab instead, in the same session.
const HOSTS = new Set(['open.spotify.com', 'accounts.spotify.com']);
// sp_dc is the cookie Spotify's site keeps while someone is signed in.
// The preload carries the engine's bridge (features/spotify-bridge.js); popups: sign-in pages on the allowed hosts open as windows of their own.
const SPEC = { url: WEB_URL, hosts: HOSTS, cardClass: 'spotify', popups: true, hiddenViewport: { width: 1280, height: 800 }, preload: path.join(__dirname, '..', 'preload', 'music-engine-preload.js'), signIn: { cookie: 'sp_dc', domain: /(^|\.)spotify\.com$/ } };
const PROBE = WP.probeScript(SPEC.cardClass);

// The widget's mode. An explicit 'status' | 'web' | 'api' wins. Widgets saved before modes existed have the API card's fields
// (clientId, art) and stay 'api'; anything new is 'status': the engine's now-playing card (features/spotify-engine.js).
function cleanMode(c) {
  if (c && typeof c === 'object') {
    if (c.mode === 'status' || c.mode === 'web' || c.mode === 'api') return c.mode;
    if ('clientId' in c || 'art' in c) return 'api';
  }
  return 'status';
}

const isAllowedUrl = (url, testOrigin = '') => WP.isAllowedUrl(url, HOSTS, testOrigin);
// Is this page the one the engine's bridge may run in: open.spotify.com itself (not the sign-in host)? `testOrigin`: a stand-in in tests.
function isEnginePage(url, testOrigin = '') {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && !u.username && !u.password && ((u.hostname === 'open.spotify.com' && !u.port) || Boolean(testOrigin && u.origin === testOrigin));
  } catch { return false; }
}
const createSpotifyWeb = (deps) => WP.createWebPlayer(deps, SPEC);

module.exports = {
  WEB_URL, HOSTS, MIN_LAYOUT_WIDTH: WP.MIN_LAYOUT_WIDTH, cleanMode, isAllowedUrl, isEnginePage, PROBE, createSpotifyWeb,
  permissionAllowed: WP.permissionAllowed, layoutZoom: WP.layoutZoom, viewBounds: WP.viewBounds, loadFailure: WP.loadFailure, DRM_PROBE: WP.DRM_PROBE,
};
