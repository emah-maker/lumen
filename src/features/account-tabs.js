// [account tabs] A tab can use a second identity: its own saved session ("persist:lumen-account-<n>"), so its cookies,
// logins and storage are kept apart from the main ones and come back after a restart, as Firefox's containers do.
// The accounts are listed in settings.json (`accountTabs`: [{ id, name, color }]); the main session is not one of them.
// A tab of one carries `account` (its id) and a colored mark, and links, pop-ups and new tabs opened from it stay in it.
//
// The pure parts (names, colors, which pages are sign-in pages, which site started a sign-in) are tested in
// test/units/account-tabs-units.js. createAccountTabs() makes each account's session once, with what the main one has
// (main.js prepares the pages' side: permissions, downloads, the ad blocker, Safe Browsing) and the same extensions.
// Loaded only when an account tab is opened or restored, or a sign-in page shows: nothing here runs at startup otherwise.
const PARTITION_PREFIX = 'persist:lumen-account-';
const MAX_ACCOUNTS = 20;
const NAME_MAX = 40;
// Distinct from each other and from the accent, readable as a 3px mark on a light or dark strip.
const COLORS = ['#e8590c', '#2b8a3e', '#7048e8', '#c2255c', '#1c7ed6', '#e67700', '#0c8599', '#5f3dc4'];

const partitionFor = (id) => `${PARTITION_PREFIX}${id}`;
function idOfPartition(partition) {
  const m = /^persist:lumen-account-(\d{1,3})$/.exec(String(partition || ''));
  const id = m ? Number(m[1]) : 0;
  return id >= 2 && id <= 999 ? id : null;
}

const cleanName = (name) => String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
const cleanColor = (color) => (/^#[0-9a-f]{6}$/i.test(String(color || '')) ? String(color).toLowerCase() : null);

// What settings.json holds, made safe to use: known fields only, ids 2..999 once each, at most MAX_ACCOUNTS.
function normalize(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const id = Number(item?.id);
    if (!Number.isInteger(id) || id < 2 || id > 999 || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: cleanName(item.name) || `Account ${id}`, color: cleanColor(item.color) || COLORS[(id - 2) % COLORS.length] });
    if (out.length >= MAX_ACCOUNTS) break;
  }
  return out.sort((a, b) => a.id - b.id);
}

// A new account: the lowest free number (Account 2, Account 3, ...) and the next color. null when there are MAX_ACCOUNTS.
function create(list, name = '') {
  const accounts = normalize(list);
  if (accounts.length >= MAX_ACCOUNTS) return { list: accounts, account: null };
  let id = 2;
  while (accounts.some((a) => a.id === id)) id++;
  const account = { id, name: cleanName(name) || `Account ${id}`, color: COLORS[(id - 2) % COLORS.length] };
  return { list: normalize([...accounts, account]), account };
}

function rename(list, id, name) {
  const clean = cleanName(name);
  return normalize(list).map((a) => (a.id === id && clean ? { ...a, name: clean } : a));
}

function recolor(list, id, color) {
  const clean = cleanColor(color);
  return normalize(list).map((a) => (a.id === id && clean ? { ...a, color: clean } : a));
}

// "Use another account" from a tab in `currentId` (null: the main session): the first account that is not that one.
// null: there is none yet, and one is made.
function otherThan(list, currentId) {
  return normalize(list).find((a) => a.id !== currentId)?.id ?? null;
}

// ---------- sign-in pages ----------
// Pages where a site sends you to sign in, and where a remembered account is usually picked for you. Hosts, plus a
// path for sites whose sign-in page shares the site's own host.
const SIGN_IN_HOSTS = new Set([
  'login.microsoftonline.com', 'login.microsoft.com', 'login.live.com', 'login.windows.net', 'account.live.com', 'login.microsoftonline.us',
  'accounts.google.com',
  'appleid.apple.com', 'idmsa.apple.com',
  'signin.aws.amazon.com',
  'id.atlassian.com',
  'login.yahoo.com',
  'auth0.openai.com', 'auth.openai.com',
  'login.salesforce.com',
]);
const SIGN_IN_PATHS = [
  [/^(www\.)?github\.com$/, /^\/(login|session)(\/|$)/],
  [/^(www\.)?amazon\.[a-z.]+$/, /^\/ap\/signin/],
  [/^(www\.)?dropbox\.com$/, /^\/login/],
  [/^(www\.)?slack\.com$/, /^\/signin/],
];
function isSignInUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (SIGN_IN_HOSTS.has(host)) return true;
  return SIGN_IN_PATHS.some(([h, p]) => h.test(host) && p.test(u.pathname));
}

// Where a sign-in sends you back to, named in its address (OAuth's redirect_uri, Microsoft's wreply, Google's continue, ...).
const RETURN_PARAMS = ['redirect_uri', 'wreply', 'continue', 'followup', 'ru', 'returnUrl', 'return_url', 'return_to', 'returnTo', 'redirect_url', 'redirect', 'next', 'service', 'destination', 'openid.return_to'];
function returnUrlOf(signInUrl) {
  let u;
  try { u = new URL(signInUrl); } catch { return null; }
  for (const name of RETURN_PARAMS) {
    const value = u.searchParams.get(name);
    if (!value) continue;
    try {
      const back = new URL(value);
      if ((back.protocol === 'https:' || back.protocol === 'http:') && !isSignInUrl(back.href)) return back;
    } catch { /* not an address */ }
  }
  return null;
}

// The site to open in the other account: the address the tab was going to when it was sent to sign in (what the user
// typed, portal.azure.com; `recent`: that page led straight here), else the home of the site the sign-in returns to,
// else the last page before it, else the sign-in page itself (a clean one in the new session asks which account).
function startSiteFor(signInUrl, startedFrom = '', { recent = true } = {}) {
  let from = null;
  try {
    const u = new URL(startedFrom);
    if ((u.protocol === 'https:' || u.protocol === 'http:') && !isSignInUrl(u.href)) from = u.href;
  } catch { /* none */ }
  if (from && recent) return from;
  const back = returnUrlOf(signInUrl);
  if (back) return `${back.origin}/`;
  if (from) return from;
  return isSignInUrl(signInUrl) ? signInUrl : null;
}

// ---------- the sessions ----------
// deps: { session, app, readAccounts(), writeAccounts(list), prepareSession(ses), openTab(url, { account, background }),
//         switchTab(id), closeTab(id), tabByContents(wc), window(), extensionsSource() (the main session, or null), preloads: [{ id, type, filePath }] }
function createAccountTabs(deps) {
  const sessions = new Map(); // id -> session
  const extensionsBySession = new Map(); // session -> ElectronChromeExtensions

  const list = () => normalize(deps.readAccounts());
  const get = (id) => list().find((a) => a.id === id) || null;
  const badge = (id) => { const a = get(id); return a ? { id: a.id, name: a.name, color: a.color } : null; };
  const save = (next) => deps.writeAccounts(normalize(next));

  function add(name = '') {
    const { list: next, account } = create(list(), name);
    if (account) save(next);
    return account;
  }

  // The account's session, ready for pages: made once per run.
  function sessionFor(id) {
    if (sessions.has(id)) return sessions.get(id);
    const ses = deps.session.fromPartition(partitionFor(id));
    sessions.set(id, ses);
    deps.prepareSession(ses, id);
    try { setupExtensions(ses, id); } catch (err) { console.error('[lumen] account extensions:', err?.message || err); }
    return ses;
  }

  // The same extensions as the main session (a password manager signs in again here: its data is this account's).
  // Installs and removals in the main session follow.
  function setupExtensions(ses, id) {
    const source = deps.extensionsSource?.();
    if (!source) return;
    const { ElectronChromeExtensions } = require('electron-chrome-extensions');
    for (const p of deps.extensionPreloads || []) ses.registerPreloadScript(p); // (before the library's own, which freezes `chrome`)
    const ext = new ElectronChromeExtensions({
      license: 'GPL-3.0',
      session: ses,
      createTab: async (details) => {
        const tab = deps.openTab(details.url || undefined, { account: id, background: details.active === false });
        return [tab.webContents, deps.window()];
      },
      selectTab: (wc) => { const tab = deps.tabByContents(wc); if (tab) deps.switchTab(tab.id); },
      removeTab: (wc) => { const tab = deps.tabByContents(wc); if (tab) deps.closeTab(tab.id); },
      createWindow: async (details) => { [].concat(details.url || []).forEach((url) => deps.openTab(url, { account: id })); return deps.window(); },
      removeWindow: () => {},
    });
    extensionsBySession.set(ses, ext);
    const load = async (extension) => {
      if (!extension?.path || !extension.manifest?.name || extension.id.startsWith('chrome-web-store') || ses.extensions.getExtension(extension.id)) return;
      try {
        const loaded = await ses.extensions.loadExtension(extension.path);
        if (loaded?.manifest?.manifest_version === 3 && loaded.manifest.background?.service_worker) ses.serviceWorkers.startWorkerForScope(`chrome-extension://${loaded.id}`).catch(() => {});
      } catch (err) { console.error('[lumen] account extension failed to load:', err?.message || err); }
    };
    for (const extension of source.extensions.getAllExtensions()) load(extension);
    source.extensions.on('extension-loaded', (_e, extension) => load(extension));
    source.extensions.on('extension-unloaded', (_e, extension) => { try { if (ses.extensions.getExtension(extension.id)) ses.extensions.removeExtension(extension.id); } catch { /* gone */ } });
  }

  return {
    list,
    get,
    badge,
    add,
    rename: (id, name) => save(rename(list(), id, name)),
    recolor: (id, color) => save(recolor(list(), id, color)),
    otherThan: (currentId) => otherThan(list(), currentId),
    session: sessionFor,
    extensionsFor: (ses) => extensionsBySession.get(ses) || null,
    owns: (ses) => [...sessions.values()].includes(ses),
  };
}

module.exports = {
  PARTITION_PREFIX, COLORS, MAX_ACCOUNTS,
  partitionFor, idOfPartition, normalize, create, rename, recolor, otherThan,
  isSignInUrl, returnUrlOf, startSiteFor,
  createAccountTabs,
};
