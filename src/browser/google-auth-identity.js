// Google's sign-in hosts: accounts.google.com and its country forms (accounts.google.co.uk, accounts.google.com.au,
// accounts.google.de), the YouTube sign-in hop, and Google's verification (passkey / 2-step) host.
//
// These hosts used to get a Firefox identity (Firefox's User-Agent, no client hints, no window.chrome), on the
// theory that Google refuses a Chrome-shaped Electron. Measured the other way round: Google now refuses that
// Firefox ("Couldn't sign you in - This browser or app may not be secure" at the first Next), because a Firefox
// User-Agent on a V8 engine with Chrome's TLS fingerprint does not add up; the one consistent Chrome identity
// (browser/chrome-identity.js, the same everywhere, no per-host switching) gets through to "Couldn't find this
// account" / the password step. So these hosts get no special identity any more; they stay listed because the ad
// blocker leaves their pages alone (the risk check reads the logging traffic a blocked entry would remove).
// Pure (no Electron): test/google-auth-identity-units.js.

const HOST_SOURCE = '^(?:accounts\\.google\\.(?:com?\\.)?[a-z]{2,3}|accounts\\.youtube\\.com|gds\\.google\\.com)$'; // (\\. in a string: a literal dot in the RegExp)
const HOST_RE = new RegExp(HOST_SOURCE, 'i');
const isAuthHost = (host) => HOST_RE.test(String(host || ''));
function isAuthUrl(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'wss:') && isAuthHost(u.hostname);
  } catch {
    return false;
  }
}

module.exports = { HOST_SOURCE, isAuthHost, isAuthUrl };
