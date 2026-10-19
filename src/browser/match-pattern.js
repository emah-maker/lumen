// Extension match patterns ("https://*.example.com/*", "<all_urls>"), and whether an extension's content scripts
// apply to a page. Used when an extension finishes loading after a page did: that page never got its content
// scripts, so a page they match is reloaded once (see main.js, lateExtension).

function escapeRe(s) { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }

function matchesUrl(pattern, url) {
  if (typeof pattern !== 'string' || typeof url !== 'string') return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  const scheme = u.protocol.replace(':', '');
  if (pattern === '<all_urls>') return scheme === 'http' || scheme === 'https' || scheme === 'file' || scheme === 'ftp';
  const m = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!m) return false;
  const [, pScheme, pHost, pPath] = m;
  if (pScheme === '*' ? !(scheme === 'http' || scheme === 'https') : pScheme !== scheme) return false;
  if (pHost !== '*') {
    const host = u.hostname;
    if (pHost.startsWith('*.')) { const base = pHost.slice(2); if (host !== base && !host.endsWith(`.${base}`)) return false; }
    else if (pHost !== host && pHost !== u.host) return false;
  }
  const path = `${u.pathname}${u.search}`;
  return new RegExp(`^${pPath.split('*').map(escapeRe).join('.*')}$`).test(path);
}

// True when one of the manifest's content scripts matches the page (and is not excluded by it).
function contentScriptsApply(manifest, url) {
  for (const cs of manifest?.content_scripts || []) {
    if ((cs.matches || []).some((p) => matchesUrl(p, url)) && !(cs.exclude_matches || []).some((p) => matchesUrl(p, url))) return true;
  }
  return false;
}

// Which already-loaded pages should reload once because a late extension's content scripts match them. `tabs` is
// [{ id, url, active, startedBeforeLoad, busy }]; only the pages of this run's first moments, that the user
// has not started typing in (`busy`), and that were loading or loaded before the extension was ready.
function pagesToReload(manifest, tabs, { withinStartup = true, max = 1 } = {}) {
  if (!withinStartup) return [];
  return tabs.filter((t) => t.active && t.startedBeforeLoad && !t.busy && contentScriptsApply(manifest, t.url)).slice(0, max).map((t) => t.id);
}

module.exports = { matchesUrl, contentScriptsApply, pagesToReload };
