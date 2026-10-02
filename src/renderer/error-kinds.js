// What the error page (error.html) says for a network error: a title, a line naming the site, and a
// hint about what to try, as Chrome and Safari do, instead of one "Can't open this page" for all of
// them. Keyed by Chromium's error name (net_error_list.h, without "net::"); anything not listed
// gets the general wording. Loaded by error.html and required by test/basics-units.js.
(function (root) {
  const q = (host) => (host ? `“${host}”` : 'the site');
  const KINDS = {
    ERR_NAME_NOT_RESOLVED: { title: 'This site can’t be found', message: (h) => `No server answers to ${q(h)}.`, hint: 'Check the address for a typo, or search for the site instead.' },
    ERR_NAME_RESOLUTION_FAILED: { same: 'ERR_NAME_NOT_RESOLVED' },
    ERR_INTERNET_DISCONNECTED: { title: 'You’re offline', message: (h) => `Lumen can’t reach ${q(h)} because this computer isn’t connected to the internet.`, hint: 'Check your Wi-Fi or network cable, then try again.' },
    ERR_NETWORK_CHANGED: { title: 'Your network changed', message: (h) => `The connection changed while ${q(h)} was loading.`, hint: 'Try again in a moment.' },
    ERR_CONNECTION_REFUSED: { title: (h) => `${h ? q(h) : 'The site'} refused to connect`, message: () => 'The server is there, but it didn’t accept the connection.', hint: 'The site may be down, or the address may name the wrong port.' },
    ERR_CONNECTION_TIMED_OUT: { title: (h) => `${h ? q(h) : 'The site'} took too long to respond`, message: () => 'The server didn’t answer in time.', hint: 'The site may be busy or down. If you use a VPN or a proxy (Settings → Advanced → Proxy), check that it is working.' },
    ERR_TIMED_OUT: { same: 'ERR_CONNECTION_TIMED_OUT' },
    ERR_CONNECTION_RESET: { title: 'The connection was reset', message: (h) => `The connection to ${q(h)} was interrupted.`, hint: 'Try again. If it keeps happening, a firewall, VPN or proxy may be in the way.' },
    ERR_CONNECTION_CLOSED: { same: 'ERR_CONNECTION_RESET' },
    ERR_EMPTY_RESPONSE: { title: 'The site sent nothing back', message: (h) => `${h ? q(h) : 'The server'} closed the connection without sending a page.`, hint: 'Try again in a moment.' },
    ERR_ADDRESS_UNREACHABLE: { title: 'This site can’t be reached', message: (h) => `There’s no route to ${q(h)} from this network.`, hint: 'Check your connection. A local address only works on its own network.' },
    ERR_PROXY_CONNECTION_FAILED: { title: 'The proxy isn’t answering', message: (h) => `Lumen is set to reach ${q(h)} through a proxy server that isn’t responding.`, hint: 'Check the proxy in Settings → Advanced.' },
    ERR_TOO_MANY_REDIRECTS: { title: 'This page isn’t redirecting properly', message: (h) => `${h ? q(h) : 'The site'} keeps sending Lumen back and forth between addresses.`, hint: 'Clearing this site’s cookies often fixes it: click the lock next to the address, then Clear Cookies and Site Data.' },
    ERR_SSL_PROTOCOL_ERROR: { title: 'Can’t make a secure connection', message: (h) => `${h ? q(h) : 'The site'} sent a response Lumen can’t use for a secure connection.`, hint: 'The site may be misconfigured. If you’re on a work or school network, it may be blocking the connection.' },
    ERR_SSL_VERSION_OR_CIPHER_MISMATCH: { same: 'ERR_SSL_PROTOCOL_ERROR' },
    ERR_BLOCKED_BY_CLIENT: { title: 'Blocked by the ad blocker', message: (h) => `A filter list blocks ${q(h)}.`, hint: 'If you need this page, allow ads on the site from ⋯ → Ad Blocker.' },
    ERR_BLOCKED_BY_ADMINISTRATOR: { title: 'Blocked by your administrator', message: (h) => `Your organization doesn’t allow ${q(h)}.`, hint: '' },
    ERR_UNSAFE_PORT: { title: 'This address uses a blocked port', message: (h) => `Browsers don’t connect to ${q(h)} because its port is reserved for other kinds of servers.`, hint: 'Check the port number in the address.' },
    ERR_FILE_NOT_FOUND: { title: 'File not found', message: () => 'There’s no file at this address. It may have been moved, renamed or deleted.', hint: '' },
    ERR_ACCESS_DENIED: { title: 'Can’t open this file', message: () => 'Lumen doesn’t have permission to read it.', hint: '' },
  };
  const GENERAL = { title: 'Can’t open this page', message: (h) => (h ? `The browser can’t connect to ${q(h)}.` : 'The browser can’t connect to the server.'), hint: '' };

  // `desc` is Chromium's error name, with or without "net::" -> { title, message, hint }
  function describe(desc, host) {
    const name = String(desc || '').replace(/^net::/, '').toUpperCase();
    let kind = KINDS[name];
    if (kind?.same) kind = KINDS[kind.same];
    kind = kind || GENERAL;
    const text = (v) => (typeof v === 'function' ? v(host) : v);
    return { title: text(kind.title), message: text(kind.message), hint: text(kind.hint) || '' };
  }

  const api = { describe, KINDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.errorKinds = api;
})(typeof window !== 'undefined' ? window : globalThis);
