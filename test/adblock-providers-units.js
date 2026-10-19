// The ad blocker's let-through of captcha and sign-in providers (features/adblock.js isProviderUrl): hCaptcha, reCAPTCHA, Turnstile, Arkose and
// the others, and sign-in hosts, on every site; look-alikes and ordinary trackers are not let through. The window-level flow (a cross-origin
// iframe form behind a captcha, POSTs, cookies) is test/iframe-post.js.
const { isProviderUrl, challengeFor, spotifyOwn } = require('../src/features/adblock');

let failed = 0;
let total = 0;
const check = (name, ok, detail) => { total++; if (!ok) { failed++; console.log(`FAIL ${name}${detail ? ` -- ${detail}` : ''}`); } };

const PASS = [
  'https://newassets.hcaptcha.com/c/hsw.js', 'https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html', 'https://hcaptcha.com/1/api.js', 'https://api2.hcaptcha.com/checksiteconfig?v=1',
  'https://imgs.hcaptcha.com/x', 'https://js.hcaptcha.com/1/api.js',
  'https://www.google.com/recaptcha/api.js', 'https://www.google.com/recaptcha/enterprise.js', 'https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js', 'https://www.recaptcha.net/recaptcha/api.js',
  'https://challenges.cloudflare.com/turnstile/v0/api.js', 'https://client-api.arkoselabs.com/v2/x/api.js', 'https://spotify-api.arkoselabs.com/fc/gt2/', 'https://api.funcaptcha.com/x',
  'https://gt4.geetest.com/load', 'https://geo.captcha-delivery.com/captcha/', 'https://api.friendlycaptcha.com/api/v1/puzzle', 'https://service.mtcaptcha.com/x',
  'https://login.microsoftonline.com/common/oauth2/authorize', 'https://login.live.com/login.srf', 'https://appleid.apple.com/auth/authorize',
  'https://idmsa.apple.com/appleauth/auth', 'https://dev-123.okta.com/oauth2/v1/authorize', 'https://tenant.auth0.com/authorize', 'https://tenant.b2clogin.com/x', 'https://x.onelogin.com/oidc/2/auth',
  'https://api-1234.duosecurity.com/frame/web/v1/auth',
  'https://shop.example/cdn-cgi/challenge-platform/h/b/scripts/jsd/main.js', 'http://newassets.hcaptcha.com:5555/1/hsw.js', 'https://NEWASSETS.hcaptcha.com/x',
];
const FILTERED = [
  'https://ads.tracker-test.org/ad.js', 'https://www.google-analytics.com/analytics.js', 'https://www.googletagmanager.com/gtm.js', 'https://www.google.com/search?q=x', 'https://www.google.com/ads/x',
  'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'https://evil.example/hcaptcha.com/', 'https://hcaptcha.com.evil.example/x', 'https://nothcaptcha.com/x', 'https://google.com.evil.example/recaptcha/api.js',
  'https://sso.garmin.com/sso/embed', 'https://auth.tracker.example/t.js', 'https://accounts.example.org/signin', 'https://notsso.garmin.com/x', 'https://sso/x', 'https://ssonic.example/x', 'https://tracker.example/?u=https://sso.garmin.com/', 'https://garmin.com/', 'ftp://sso.garmin.com/', 'https://cdn.example/challenge-platform/x.js',
];
check('providers: captcha and sign-in addresses are let through', PASS.every((u) => isProviderUrl(u)), PASS.filter((u) => !isProviderUrl(u)).join(' '));
check('providers: trackers, look-alike hosts and other paths are not', FILTERED.every((u) => !isProviderUrl(u)), FILTERED.filter((u) => isProviderUrl(u)).join(' '));
check('providers: challengeFor(page, url) no longer depends on the page', ['https://example.com/', 'https://open.spotify.com/', '', 'about:blank'].every((page) => challengeFor(page, PASS[0]) && !challengeFor(page, FILTERED[0])), '');

// A generic sso. / login. / auth. / accounts. host: a document always, anything else only for the same site as the page.
const G = 'https://sso.garmin.com/sso/embed';
check('providers: a sign-in host is let through as a frame or form POST target, on any page', challengeFor('https://news.example/', G, 'subFrame') && challengeFor('https://news.example/', G, 'mainFrame') && challengeFor('', 'https://auth.tracker.example/x', 'subFrame'), '');
check('providers: ...and for scripts, images, fetches and pings from the same site', ['script', 'image', 'xhr', 'ping'].every((t) => challengeFor('https://connect.garmin.com/profile', G, t)), '');
check('providers: ...but never for those from another site (a tracker served from auth.tracker.example)', ['script', 'image', 'xhr', 'ping', 'other'].every((t) => !challengeFor('https://news.example/', G, t) && !challengeFor('https://news.example/', 'https://auth.tracker.example/t.js', t) && !challengeFor('', 'https://auth.tracker.example/t.js', t)), '');
check('providers: a look-alike page is not the same site', !challengeFor('https://garmin.com.evil.example/', G, 'script') && !challengeFor('https://evilgarmin.com/', G, 'script'), '');

// Spotify's own pictures and API (the Spotify cards' cover art): never turned into the 1x1 stand-in; its ads and logging still are.
const SP_IMG = ['https://i.scdn.co/image/ab67616d00001e02x', 'https://mosaic.scdn.co/640/abc', 'https://image-cdn-ak.spotifycdn.com/image/x', 'https://seeded-session-images.scdn.co/v1/x'];
check('spotify: its picture hosts are let through as images on any page', SP_IMG.every((u) => spotifyOwn(u, 'image', true)), '');
check('spotify: ...and for the cards own requests (no page behind them), with the API', SP_IMG.every((u) => spotifyOwn(u, 'other', false)) && spotifyOwn('https://api.spotify.com/v1/me/player/queue', 'xhr', false) && spotifyOwn('https://accounts.spotify.com/api/token', 'other', false), '');
check('spotify: a page script or fetch to its hosts, its ads, logging and look-alikes are not let through', !spotifyOwn('https://i.scdn.co/x.js', 'script', true) && !spotifyOwn('https://api.spotify.com/v1/x', 'xhr', true) && !spotifyOwn('https://spclient.wg.spotify.com/ads/v1/x', 'other', false) && !spotifyOwn('https://i.scdn.co.evil.example/x', 'image', true) && !spotifyOwn('https://notscdn.co/x', 'image', true) && !spotifyOwn('http://i.scdn.co/x', 'image', true), '');

console.log(failed ? `${failed}/${total} FAILED` : `${total}/${total} passed`);
process.exit(failed ? 1 : 0);
