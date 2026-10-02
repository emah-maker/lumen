// ---------- Settings → Privacy and security → Site data: every site that keeps cookies, one by one ----------
//
// Chrome's "See all site data" and Safari's "Manage Website Data": the sites with cookies in your
// profile, grouped by site (news.bbc.co.uk and www.bbc.co.uk are bbc.co.uk), most cookies first,
// each with Remove. Remove deletes that site's cookies (every subdomain's) and what it stored on
// this computer (local storage, IndexedDB, service workers, cache storage) for its main addresses.
// Clear browsing data still clears everything at once. Page info (features/page-info.js) clears one
// site from the page itself.
//
// The grouping is pure; settings-backend.js reads the cookies from the default session.

const SITE_STORAGES = ['filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'];

const cookieHost = (c) => String(c?.domain || '').replace(/^\./, '').toLowerCase();
// A cookie belongs to `site` when its domain is the site or one of its subdomains.
const belongsTo = (host, site) => host === site || host.endsWith(`.${site}`);

// cookies -> [{ site, cookies, hosts }] most cookies first, then by name. `siteOf(url)` is
// tab-groups' registrableDomain (or anything turning a URL into a site).
function groupCookies(cookies, siteOf) {
  const sites = new Map();
  for (const c of cookies || []) {
    const host = cookieHost(c);
    if (!host) continue;
    const site = siteOf(`https://${host}/`) || host;
    const entry = sites.get(site) || { site, cookies: 0, hosts: new Set() };
    entry.cookies++;
    entry.hosts.add(host);
    sites.set(site, entry);
  }
  return [...sites.values()]
    .map((e) => ({ site: e.site, cookies: e.cookies, hosts: [...e.hosts].sort() }))
    .sort((a, b) => b.cookies - a.cookies || a.site.localeCompare(b.site));
}

// The origins whose storage Remove clears: the site and its www, over https and http, plus every
// host its cookies came from.
function originsFor(site, hosts = []) {
  const names = new Set([site, `www.${site}`, ...hosts]);
  return [...names].flatMap((h) => [`https://${h}`, `http://${h}`]);
}

// Removes `site`'s cookies and storage from `ses`. Resolves the number of cookies removed.
async function clearSite(ses, site) {
  const clean = String(site || '').toLowerCase();
  if (!clean || /[\s/]/.test(clean)) return 0;
  const all = await ses.cookies.get({});
  const mine = all.filter((c) => belongsTo(cookieHost(c), clean));
  let removed = 0;
  for (const c of mine) {
    const url = `${c.secure ? 'https' : 'http'}://${cookieHost(c)}${c.path || '/'}`;
    await ses.cookies.remove(url, c.name).then(() => { removed++; }, (err) => console.error('[lumen] could not remove a cookie:', err.message));
  }
  for (const origin of originsFor(clean, mine.map(cookieHost))) {
    await ses.clearStorageData({ origin, storages: SITE_STORAGES }).catch((err) => console.error(`[lumen] could not clear ${origin}:`, err.message));
  }
  return removed;
}

module.exports = { groupCookies, originsFor, clearSite, belongsTo };
