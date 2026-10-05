// Spotify's own website (open.spotify.com) as a card on the new-tab page: the "Web player" mode of the
// Spotify widget. There is no API, Client ID or account limit involved: the user signs in on Spotify's
// site like on any other site, in their normal browsing session, and Widevine plays the audio.
//
// The view itself (laid over the card's slot, kept playing when the page is left, the Widevine check, offline
// retry) is features/web-player.js, shared with the Apple Music widget; this file is what is Spotify's: the
// widget's mode, the address allow-list and the cookie that says someone is signed in.
'use strict';

const WP = require('./web-player');

const WEB_URL = 'https://open.spotify.com/';
// Pages the view may show. Anything else (a Google or Apple sign-in, an ad, an external link) opens in
// a normal tab instead, in the same session.
const HOSTS = new Set(['open.spotify.com', 'accounts.spotify.com']);
// sp_dc is the cookie Spotify's site keeps while someone is signed in.
const SPEC = { url: WEB_URL, hosts: HOSTS, cardClass: 'spotify', signIn: { cookie: 'sp_dc', domain: /(^|\.)spotify\.com$/ } };
const PROBE = WP.probeScript(SPEC.cardClass);

// The widget's mode. An explicit 'web' | 'api' wins. Widgets saved before this mode existed have the
// API card's fields (clientId, art) and stay 'api'; anything new is 'web'.
function cleanMode(c) {
  if (c && typeof c === 'object') {
    if (c.mode === 'web' || c.mode === 'api') return c.mode;
    if ('clientId' in c || 'art' in c) return 'api';
  }
  return 'web';
}

const isAllowedUrl = (url, testOrigin = '') => WP.isAllowedUrl(url, HOSTS, testOrigin);
const createSpotifyWeb = (deps) => WP.createWebPlayer(deps, SPEC);

module.exports = {
  WEB_URL, HOSTS, MIN_LAYOUT_WIDTH: WP.MIN_LAYOUT_WIDTH, cleanMode, isAllowedUrl, PROBE, createSpotifyWeb,
  permissionAllowed: WP.permissionAllowed, layoutZoom: WP.layoutZoom, viewBounds: WP.viewBounds, loadFailure: WP.loadFailure, DRM_PROBE: WP.DRM_PROBE,
};
