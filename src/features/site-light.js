// Sites whose dark mode is only half built: in a dark theme Lumen tells them the system is light (prefers-color-scheme: light),
// so they draw one whole light page instead of dark new sections over light old cards. Glassdoor switches its left column and
// newer panels to dark and leaves its review and job cards white, with light text on some of them. Chrome shows the same
// half-dark page; Lumen just fixes it for these hosts. Every other site keeps following the theme.
// Applied over the tab's own debugger session (main.js applyChromeIdentity), which every ordinary tab already has.

const LIGHT_SITES = ['glassdoor.com', 'glassdoor.co.uk', 'glassdoor.ca', 'glassdoor.com.au', 'glassdoor.co.in', 'glassdoor.de', 'glassdoor.fr'];

// The host is one of the sites or a subdomain of one (www.glassdoor.com, not notglassdoor.com).
function isLightSite(url, sites = LIGHT_SITES) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return sites.some((s) => host === s || host.endsWith(`.${s}`));
}

// What the page should be told for `url` in the current theme: 'light' to override, '' for the page's own (the theme's).
function schemeFor(url, dark, sites = LIGHT_SITES) {
  return dark && isLightSite(url, sites) ? 'light' : '';
}

// Keeps one tab's override in step with its address and the theme. `send` is the debugger's sendCommand; `dark()` the theme.
// Returns update(url): call it when a main-frame navigation starts (and when the theme changes, with the tab's address).
function watcher(send, dark, sites = LIGHT_SITES) {
  let current = '';
  return (url) => {
    const want = schemeFor(url, dark(), sites);
    if (want === current) return Promise.resolve(false);
    current = want;
    return send('Emulation.setEmulatedMedia', { features: want ? [{ name: 'prefers-color-scheme', value: want }] : [] }).then(() => true, () => false);
  };
}

module.exports = { LIGHT_SITES, isLightSite, schemeFor, watcher };
