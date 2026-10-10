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

  // Text that is an address, not a search: a scheme, a host with a dot, localhost, an IP or host:port (no spaces). Typing one of
  // these and pressing Enter goes to exactly that address, whatever the suggestions say.
  function looksLikeAddress(text) {
    const s = String(text || '').trim();
    if (!s || /\s/.test(s)) return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|chrome|lumen|file|data|javascript|view-source|mailto):/i.test(s)) return true;
    return /^(localhost|\[[0-9a-f:]+\]|(\d{1,3}\.){3}\d{1,3}|([a-z0-9-]+\.)+[a-z][a-z0-9-]*|[a-z0-9-]+(?=:\d))(:\d+)?([/?#].*)?$/i.test(s);
  }

  // The row the address bar's Enter goes to before an arrow key moves it (Chrome's default match): the first row when it is a
  // page from history and what was typed is plain words. -1 means what was typed: it is an address, the field already holds an
  // inline completion (Enter goes to that), or the first row is only "search for ...", which Enter does anyway.
  function defaultSuggestion(typed, items, { completed = false } = {}) {
    if (!items || !items.length || completed || looksLikeAddress(typed)) return -1;
    return items[0].kind === 'history' ? 0 : -1;
  }

  const api = { isLoopbackUrl, looksLikeAddress, defaultSuggestion };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.chromeHelpers = api;
})(typeof window !== 'undefined' ? window : globalThis);
