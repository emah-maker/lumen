// ---------- the network the update download uses (used by features/updates.js) ----------
// The release zip is fetched through its own in-memory session, never the browsing one. The default session carries
// everything that exists for web pages: the ad blocker's and Safe Browsing's onBeforeRequest listeners (they see every
// request the main process makes through `net.fetch` too, and cancel what a filter matches), the request-header hooks,
// Do Not Track / language rewriting. None of that has any business with a download of Lumen itself: a filter-list entry
// that happened to match the release host would stop every update with a bare "net::ERR_BLOCKED_BY_CLIENT". So this
// session is never handed to the ad blocker, Safe Browsing or settings-backend, and nothing registers a webRequest
// listener on it (test/e2e/updater-session.js checks both ends: a request the ad blocker cancels in the default session
// goes through here).
// (electron-updater's release check already uses its own partition, "electron-updater", for the same reason.)
// The one thing it does follow is the profile's proxy setting, so a user behind a proxy can still update.
const PARTITION = 'lumen-updater'; // no "persist:" prefix: in memory, no cookies or cache kept

// The Electron proxy config for the profile's proxy preference ({ mode, rules, pacUrl, bypass }), as settings-backend
// applies it to the browsing session.
function proxyConfig(p = {}) {
  const config = { mode: p.mode || 'system' };
  if (config.mode === 'fixed_servers') Object.assign(config, { proxyRules: p.rules, proxyBypassRules: p.bypass });
  if (config.mode === 'pac_script') config.pacScript = p.pacUrl;
  return config;
}

// deps: { electron, proxy: () => the proxy preference }. get() resolves a `net` for zip-update.stage():
// { fetch(url, init), online }.
function createUpdateNet(deps) {
  let ses = null;
  const session = () => (ses ||= deps.electron.session.fromPartition(PARTITION));
  return {
    session,
    async get() {
      const s = session();
      try { await s.setProxy(proxyConfig(deps.proxy?.())); } catch { /* the system setting stands */ }
      return {
        fetch: (url, init) => s.fetch(url, init),
        get online() { return deps.electron.net.online; },
      };
    },
  };
}

module.exports = { PARTITION, proxyConfig, createUpdateNet };
