// The colour a tab's view draws behind its page (WebContentsView.setBackgroundColor, which Chromium uses as the page's base background).
// Lumen's own pages (New Tab, Settings, History...) are drawn on the theme's colour so a dark theme shows no white flash. A web page is drawn on
// white, as in Chrome: many sites (The North Face's product grid was the case) set no background at all and rely on the browser's white
// canvas, and their dark text was drawn on Lumen's near-black #1c1c1e when the tab had started as the New Tab page, been woken from sleep,
// or opened in a private window. A site that declares a dark color-scheme still gets Chromium's dark canvas: the base colour only shows
// where the page draws nothing and has no dark scheme of its own.
const WEB_PAGE = '#ffffff';
const WEB_SCHEMES = /^(https?|file|data|blob):/i;

// The background for `url` once it is committed: the theme's (`theme()`) for one of Lumen's own pages, white for a web page, or null to leave it as it is
// (an error page, an extension page, about:blank: whatever showed before).
function backgroundFor(url, { internal = () => false, theme = () => WEB_PAGE } = {}) {
  const u = String(url || '');
  if (!u) return null;
  if (internal(u)) return theme();
  return WEB_SCHEMES.test(u) ? WEB_PAGE : null;
}

module.exports = { WEB_PAGE, backgroundFor };
