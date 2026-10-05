// Apple Music's own website (music.apple.com) as a card on the new-tab page: the Apple Music widget. There is no
// API, developer token or account limit involved: the user signs in on Apple's site like on any other site, in
// their normal browsing session (Lumen never sees the Apple ID or password), and Widevine plays the audio.
//
// Apple forbids being framed (X-Frame-Options: DENY), so the view is laid over the card's slot instead of an
// <iframe>: see features/web-player.js, shared with the Spotify widget's Web player. This file is what is Apple
// Music's: the address allow-list and the cookie that says someone is signed in.
'use strict';

const WP = require('./web-player');

const WEB_URL = 'https://music.apple.com/';
// Pages the view may show: the player and Apple's own sign-in pages. (Apple's sign-in form is a frame inside the
// player, which this list doesn't govern; these cover the pages it can also send the whole view to.) Anything
// else (an ad, a Google link, an external site) opens in a normal tab instead, in the same session.
const HOSTS = new Set(['music.apple.com', 'authorize.music.apple.com', 'idmsa.apple.com', 'appleid.apple.com', 'account.apple.com']);
// media-user-token is the cookie music.apple.com keeps while someone is signed in.
const SPEC = { url: WEB_URL, hosts: HOSTS, cardClass: 'applemusic', signIn: { cookie: 'media-user-token', domain: /(^|\.)apple\.com$/ } };
const PROBE = WP.probeScript(SPEC.cardClass);

const isAllowedUrl = (url, testOrigin = '') => WP.isAllowedUrl(url, HOSTS, testOrigin);
const createAppleMusicWeb = (deps) => WP.createWebPlayer(deps, SPEC);

module.exports = { WEB_URL, HOSTS, isAllowedUrl, PROBE, createAppleMusicWeb };
