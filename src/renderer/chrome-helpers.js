// Small pure helpers for the browser chrome (app.js), kept apart so test/chrome-ux-units.js can load them with require().
(function (root) {
  // An address on this computer itself (localhost, 127.x.x.x, [::1], name.localhost). Browsers treat it as safe to talk to
  // without encryption: nothing crosses a network, so "Not secure" would be a false alarm on a developer's own server.
  function isLoopbackUrl(url) {
    let host;
    try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return false; }
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === '[::1]' || host === '::1') return true;
    const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    return Boolean(m) && [m[1], m[2], m[3]].every((n) => Number(n) <= 255);
  }

  const api = { isLoopbackUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.chromeHelpers = api;
})(typeof window !== 'undefined' ? window : globalThis);
