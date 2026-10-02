// ---------- page info: what the lock in the address field opens ----------
//
// Clicking the lock (or "not secure") next to the address, or ⋯ → This Page → Site Information,
// opens a small menu about the site in front, as Chrome's and Safari's page info do:
//   - the site and its connection: secure, not secure (plain http), parts not secure (mixed
//     content), or reached past a certificate warning;
//   - its permissions (location, camera and microphone, notifications, clipboard), each with
//     Ask / Allow / Block, the same decisions Settings → Privacy → Site permissions lists. Ask
//     forgets the decision, so the site asks again (or is blocked, when the default says so);
//   - the zoom level remembered for it (features/site-zoom.js), with Reset Zoom for This Site;
//   - how many cookies it has, and Clear Cookies and Site Data… (asks first): the cookies sent to
//     this site, and its storage (local storage, IndexedDB, service workers, cache storage);
//   - Site Settings…, which opens Settings at Site permissions.
// It is a native menu, drawn by the OS outside the page, so the page can neither read nor click it.
//
// deps: { t, decisions: Map(`${origin}|${permission}` -> bool) or a function returning it, savePermissions(), permissionDefault(p),
//         confirm({ message, detail, buttons }) -> Promise<bool>, openSiteSettings(), popup(template, point),
//         zoomOf(host) -> remembered percentage or null, resetZoom() (the tab in front) }

const PERMISSIONS = ['geolocation', 'media', 'notifications', 'clipboard-read'];
const SITE_STORAGES = ['filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'];

// 'https://a.example:8443/x' -> { origin, host, scheme } for http(s) pages; null for anything else.
function siteOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return { origin: u.origin, host: u.host, scheme: u.protocol.slice(0, -1) };
  } catch {
    return null;
  }
}

// The connection line: 'secure' | 'insecure' (http) | 'mixed' | 'broken' (past a certificate warning).
function connectionOf(scheme, security) {
  if (scheme === 'http') return 'insecure';
  if (security === 'broken') return 'broken';
  if (security === 'mixed') return 'mixed';
  return 'secure';
}

// 'allow' | 'block' | 'ask' for one permission of one origin.
function decisionOf(decisions, origin, permission) {
  const key = `${origin}|${permission}`;
  if (!decisions.has(key)) return 'ask';
  return decisions.get(key) ? 'allow' : 'block';
}

// Sets (true/false) or forgets (null) one decision. Returns whether anything changed.
function setDecision(decisions, origin, permission, value) {
  const key = `${origin}|${permission}`;
  if (value === null) return decisions.delete(key);
  const was = decisions.get(key);
  decisions.set(key, Boolean(value));
  return was !== Boolean(value);
}

// The menu for { url, security, cookies (count or null), zoom (the remembered percentage or null) }.
// `act` gets the actions: { set(permission, true|false|null), resetZoom(), clear(), settings() }.
// Pure, so the tests read it as is.
function buildTemplate({ url, security = null, cookies = null, zoom = null }, { t, decisions: given, permissionDefault }, act) {
  const decisions = typeof given === 'function' ? given() : given;
  const site = siteOf(url);
  if (!site) return [{ label: t('pageInfo.notAWebPage'), enabled: false }];
  const connection = connectionOf(site.scheme, security);
  const template = [
    { label: site.host, enabled: false },
    { label: t(`pageInfo.connection.${connection}`), enabled: false },
    { type: 'separator' },
    { label: t('pageInfo.permissions'), enabled: false },
  ];
  for (const permission of PERMISSIONS) {
    const now = decisionOf(decisions, site.origin, permission);
    const askLabel = permissionDefault(permission) === 'block' ? t('pageInfo.blockDefault') : t('pageInfo.ask');
    template.push({
      label: t('pageInfo.permissionState', { permission: t(`pageInfo.permission.${permission}`), state: now === 'ask' ? askLabel : t(`pageInfo.${now}`) }),
      submenu: [
        { label: askLabel, type: 'radio', checked: now === 'ask', click: () => act.set(permission, null) },
        { label: t('pageInfo.allow'), type: 'radio', checked: now === 'allow', click: () => act.set(permission, true) },
        { label: t('pageInfo.block'), type: 'radio', checked: now === 'block', click: () => act.set(permission, false) },
      ],
    });
  }
  if (Number.isFinite(zoom)) {
    template.push(
      { type: 'separator' },
      { label: t('pageInfo.zoom', { percent: zoom }), enabled: false },
      { label: t('pageInfo.zoomReset'), click: () => act.resetZoom() },
    );
  }
  template.push(
    { type: 'separator' },
    { label: Number.isInteger(cookies) ? t(cookies === 1 ? 'pageInfo.cookies.one' : 'pageInfo.cookies', { n: cookies }) : t('pageInfo.cookies.unknown'), enabled: false },
    { label: t('pageInfo.clearData'), click: () => act.clear() },
    { type: 'separator' },
    { label: t('pageInfo.siteSettings'), click: () => act.settings() },
  );
  return template;
}

function createPageInfo(deps) {
  const decisions = () => (typeof deps.decisions === 'function' ? deps.decisions() : deps.decisions);
  // `ses` is the tab's session; `security` siteSecurity.stateOf(wc).
  async function open({ url, ses, security, point }) {
    const site = siteOf(url);
    let cookies = null;
    if (site && ses) cookies = await ses.cookies.get({ url: site.origin }).then((list) => list.length, () => null);
    const act = {
      set: (permission, value) => { if (site && setDecision(decisions(), site.origin, permission, value)) deps.savePermissions(); },
      clear: () => clearSite(ses, url),
      settings: () => deps.openSiteSettings(),
      resetZoom: () => deps.resetZoom?.(),
    };
    const zoom = site && deps.zoomOf ? deps.zoomOf(site.host) : null;
    const template = buildTemplate({ url, security, cookies, zoom }, deps, act);
    deps.popup(template, point);
    return template;
  }

  // Asks, then removes the cookies sent to this site and its storage. Resolves the number of cookies removed, or null (not asked / refused).
  async function clearSite(ses, url, { ask = true } = {}) {
    const site = siteOf(url);
    if (!site || !ses) return null;
    if (ask) {
      const ok = await deps.confirm({
        message: deps.t('pageInfo.clearData.confirm', { host: site.host }),
        detail: deps.t('pageInfo.clearData.detail'),
        buttons: [deps.t('dialog.cancel'), deps.t('pageInfo.clearData.button')],
      });
      if (!ok) return null;
    }
    let removed = 0;
    for (const c of await ses.cookies.get({ url: site.origin }).catch(() => [])) {
      const domain = String(c.domain || '').replace(/^\./, '');
      const cookieUrl = `${c.secure ? 'https' : 'http'}://${domain}${c.path || '/'}`;
      await ses.cookies.remove(cookieUrl, c.name).then(() => { removed++; }, (err) => console.error('[lumen] could not remove a cookie:', err.message));
    }
    await ses.clearStorageData({ origin: site.origin, storages: SITE_STORAGES }).catch((err) => console.error('[lumen] could not clear site storage:', err.message));
    return removed;
  }

  return { open, clearSite };
}

module.exports = { createPageInfo, buildTemplate, siteOf, connectionOf, decisionOf, setDecision, PERMISSIONS };
