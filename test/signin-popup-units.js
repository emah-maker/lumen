// The sign-in pieces of the Spotify web player that need no window: which popups a sign-in page may open ("Continue with Apple / Google / Facebook"),
// the ad blocker's let-through of the human check (Arkose, reCAPTCHA, hCaptcha, Cloudflare) on Spotify's pages, and the pages the fingerprint noise
// leaves alone (a bot check scores the real readings). The windows themselves are test/spotify-engine-ui.js.
const WP = require('../src/features/web-player');
const SW = require('../src/features/spotify-web');
const { challengeFor } = require('../src/features/adblock');
const { SKIP_HOST } = require('../src/preload/activity-preload');

let failed = 0;
let total = 0;
const check = (name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } };

const hosts = SW.HOSTS;
const ok = (url, test = '') => WP.popupAllowed(url, hosts, test);
check('popup: the blank page a script opens first is allowed (it is sent to the identity page next)', ok('') && ok('about:blank'), '');
check('popup: Spotify\u2019s own sign-in and player pages are allowed', ok('https://accounts.spotify.com/en/login') && ok('https://open.spotify.com/'), '');
check('popup: Apple, Google, Facebook and Microsoft identity pages are allowed (https, default port)', ['https://appleid.apple.com/auth/authorize?client_id=x', 'https://idmsa.apple.com/appleauth/auth/authorize/signin', 'https://accounts.google.com/o/oauth2/v2/auth', 'https://www.facebook.com/v12.0/dialog/oauth', 'https://m.facebook.com/login.php', 'https://login.live.com/oauth20_authorize.srf', 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'].every((u) => ok(u)), '');
check('popup: anything else is not a popup (it opens as a tab): other hosts, look-alike hosts, http, a port, user:password@', ['https://evil.example/', 'https://appleid.apple.com.evil.example/', 'http://appleid.apple.com/', 'https://appleid.apple.com:8443/', 'https://user:pw@appleid.apple.com/', 'javascript:alert(1)', 'file:///c:/x', 'data:text/html,hi'].every((u) => !ok(u)), '');
check('popup: a test stand-in origin is allowed only when the test says so', !ok('https://127.0.0.1:9999/popup') && ok('https://127.0.0.1:9999/popup', 'https://127.0.0.1:9999'), '');
check('popup: the identity list has the three providers the sign-in page offers', ['appleid.apple.com', 'accounts.google.com', 'www.facebook.com'].every((h) => WP.OAUTH_HOSTS.includes(h)), '');

const page = 'https://accounts.spotify.com/en/login';
check('ad blocker: the human check\u2019s frames and scripts are let through on Spotify\u2019s pages (Arkose, reCAPTCHA, hCaptcha, Cloudflare)', ['https://client-api.arkoselabs.com/v2/abc/api.js', 'https://spotify-api.arkoselabs.com/fc/gt2/', 'https://www.google.com/recaptcha/api2/anchor?k=x', 'https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js', 'https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html', 'https://challenges.cloudflare.com/turnstile/v0/api.js'].every((u) => challengeFor(page, u) && challengeFor('https://open.spotify.com/', u)), '');
check('ad blocker: …but only there: the same address on another site, or another address on Spotify, is filtered as before', !challengeFor('https://example.com/', 'https://www.google.com/recaptcha/api.js') && !challengeFor(page, 'https://www.google-analytics.com/analytics.js') && !challengeFor(page, 'https://evil.example/arkoselabs.com/') && !challengeFor(page, 'https://arkoselabs.com.evil.example/x') && !challengeFor('https://spotify.com.evil.example/', 'https://www.google.com/recaptcha/api.js'), '');
check('fingerprint noise: Google, Spotify\u2019s sign-in, Apple\u2019s sign-in and the human-check providers\u2019 own frames are read as they are', ['accounts.google.com', 'accounts.spotify.com', 'appleid.apple.com', 'idmsa.apple.com', 'client-api.arkoselabs.com', 'newassets.hcaptcha.com', 'challenges.cloudflare.com', 'www.recaptcha.net'].every((h) => SKIP_HOST.test(h)) && !SKIP_HOST.test('open.spotify.com') && !SKIP_HOST.test('example.com') && !SKIP_HOST.test('accounts.spotify.com.evil.example'), '');

console.log(failed ? `${failed}/${total} FAILED` : `${total}/${total} passed`);
process.exit(failed ? 1 : 0);
