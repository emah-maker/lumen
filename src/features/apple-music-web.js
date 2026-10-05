// Apple Music's own website (music.apple.com) as a card on the new-tab page: the Apple Music widget. There is no
// API, developer token or account limit involved: the user signs in on Apple's site like on any other site, in
// their normal browsing session (Lumen never sees the Apple ID or password), and Widevine plays the audio.
//
// Apple forbids being framed (X-Frame-Options: DENY), so the view is laid over the card's slot instead of an
// <iframe>: see features/web-player.js, shared with the Spotify widget's Web player. This file is what is Apple
// Music's: the address allow-list and what the hidden engine page needs (see features/apple-music-engine.js).
'use strict';

const path = require('path');
const WP = require('./web-player');

const WEB_URL = 'https://music.apple.com/';
// Pages the view may show: the player and Apple's own sign-in pages. (Apple's sign-in form is a frame inside the
// player, which this list doesn't govern; these cover the pages it can also send the whole view to.) Anything
// else (an ad, a Google link, an external site) opens in a normal tab instead, in the same session.
const HOSTS = new Set(['music.apple.com', 'authorize.music.apple.com', 'idmsa.apple.com', 'appleid.apple.com', 'account.apple.com']);
// No sign-in cookie to watch: MusicKit says whether the user is authorized (features/apple-music-engine.js). The page's own
// sign-in windows (popups on the allowed hosts) are real windows so Apple's page can hear back from them. The preload carries the
// engine's bridge (features/apple-music-bridge.js).
const SPEC = { url: WEB_URL, hosts: HOSTS, cardClass: 'applemusic', popups: true, preload: path.join(__dirname, '..', 'preload', 'music-engine-preload.js') };
const PROBE = WP.probeScript(SPEC.cardClass);

const isAllowedUrl = (url, testOrigin = '') => WP.isAllowedUrl(url, HOSTS, testOrigin);
const createAppleMusicWeb = (deps) => WP.createWebPlayer(deps, SPEC);

// Is this page the one the bridge may run in: music.apple.com itself (not the sign-in hosts, which are only pages the user types into)?
// `testOrigin`: a stand-in for it in tests.
function isEnginePage(url, testOrigin = '') {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && !u.username && !u.password && ((u.hostname === 'music.apple.com' && !u.port) || Boolean(testOrigin && u.origin === testOrigin));
  } catch { return false; }
}

module.exports = { WEB_URL, HOSTS, isAllowedUrl, isEnginePage, PROBE, createAppleMusicWeb };
