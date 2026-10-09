// What the error page (error.html) says for a network error: a title, a line naming the site, and a
// hint about what to try, as Chrome and Safari do, instead of one "Can't open this page" for all of
// them. Keyed by Chromium's error name (net_error_list.h, without "net::"); anything not listed
// gets the general wording. The wording itself is in locales/en.json (errorPage.kind.<ERROR>.title /
// .message / .hint, with {site}, {Site} and {server} standing for the host, or "the site" without
// one); this file says which errors share a wording and which have no hint. Loaded by error.html and
// required by test/basics-units.js.
(function (root) {
  const KINDS = {
    ERR_NAME_NOT_RESOLVED: {},
    ERR_NAME_RESOLUTION_FAILED: { same: 'ERR_NAME_NOT_RESOLVED' },
    ERR_INTERNET_DISCONNECTED: {},
    ERR_NETWORK_CHANGED: {},
    ERR_CONNECTION_REFUSED: {},
    ERR_CONNECTION_TIMED_OUT: {},
    ERR_TIMED_OUT: { same: 'ERR_CONNECTION_TIMED_OUT' },
    ERR_CONNECTION_RESET: {},
    ERR_CONNECTION_CLOSED: { same: 'ERR_CONNECTION_RESET' },
    ERR_EMPTY_RESPONSE: {},
    ERR_ADDRESS_UNREACHABLE: {},
    ERR_PROXY_CONNECTION_FAILED: {},
    ERR_TOO_MANY_REDIRECTS: {},
    ERR_SSL_PROTOCOL_ERROR: {},
    ERR_SSL_VERSION_OR_CIPHER_MISMATCH: { same: 'ERR_SSL_PROTOCOL_ERROR' },
    ERR_BLOCKED_BY_CLIENT: {},
    ERR_BLOCKED_BY_ADMINISTRATOR: { noHint: true },
    ERR_UNSAFE_PORT: {},
    ERR_FILE_NOT_FOUND: { noHint: true },
    ERR_CONNECTION_FAILED: {},
    ERR_CONNECTION_ABORTED: { same: 'ERR_CONNECTION_RESET' },
    ERR_DNS_TIMED_OUT: {},
    ERR_DNS_SERVER_FAILED: { same: 'ERR_DNS_TIMED_OUT' },
    ERR_TUNNEL_CONNECTION_FAILED: { same: 'ERR_PROXY_CONNECTION_FAILED' },
    ERR_SOCKS_CONNECTION_FAILED: { same: 'ERR_PROXY_CONNECTION_FAILED' },
    ERR_NETWORK_ACCESS_DENIED: {},
    ERR_INVALID_URL: {},
    ERR_UNKNOWN_URL_SCHEME: { noHint: true },
    ERR_INVALID_RESPONSE: {},
    ERR_HTTP2_PROTOCOL_ERROR: { same: 'ERR_INVALID_RESPONSE' },
    ERR_CONTENT_DECODING_FAILED: { same: 'ERR_INVALID_RESPONSE' },
    ERR_INCOMPLETE_CHUNKED_ENCODING: { same: 'ERR_INVALID_RESPONSE' },
    ERR_SSL_CLIENT_AUTH_CERT_NEEDED: {},
    ERR_ACCESS_DENIED: { noHint: true },
  };
  const GENERAL = { noHint: true };

  // The page's own table (renderer/i18n.js: window.t); plain Node (the tests) reads English from locales/.
  function translator() {
    if (typeof root.t === 'function') return root.t;
    if (typeof require !== 'function') return (key) => key; // a page without its table
    const strings = require('../locales/en.json');
    return (key, vars) => String(strings[key] ?? key).replace(/\{(\w+)\}/g, (whole, name) => (vars && name in vars ? String(vars[name]) : whole));
  }

  // `desc` is Chromium's error name, with or without "net::" -> { title, message, hint }
  function describe(desc, host, t = translator()) {
    const name = String(desc || '').replace(/^net::/, '').toUpperCase();
    let id = name;
    let kind = KINDS[id];
    if (kind?.same) { id = kind.same; kind = KINDS[id]; }
    if (!kind) { id = 'general'; kind = GENERAL; }
    const quoted = host ? `“${host}”` : '';
    const vars = { site: quoted || t('errorPage.theSite'), Site: quoted || t('errorPage.theSiteCap'), server: quoted || t('errorPage.theServer') };
    const base = `errorPage.kind.${id}`;
    return {
      title: t(`${base}.title`, vars),
      message: t(!host && id === 'general' ? `${base}.messageNoHost` : `${base}.message`, vars),
      hint: kind.noHint ? '' : t(`${base}.hint`, vars),
    };
  }

  const api = { describe, KINDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.errorKinds = api;
})(typeof window !== 'undefined' ? window : globalThis);
