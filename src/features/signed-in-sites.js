// ---------- signed-in sites: the AI may read a page AS THE USER, per site, with their OK ----------
// read_urls normally loads pages in a hidden, memory-only session with none of the user's cookies or
// logins (agent.js readInBackground, partition 'claude-reader'; the research tabs that show them use
// RESEARCH_PARTITION). That stays the default. With `as_user: true` the sidebar's AI can ask to read a
// page with the user's own signed-in session instead ("check my Canvas grades"): the user gets a card
// "Let <AI> use your signed-in <host> account?" with No (the default), Just this once, or Always for
// <host>. Approved, the page opens as a background tab in the user's normal session, marked as the AI's,
// is read (read only: clicks, typing and forms there still go through the usual per-site approvals),
// and is closed when the run ends unless the user switched to it.
//
// Per HOST, not per registrable domain: canvas.school.edu approved says nothing about mail.school.edu.
// A redirect or page jump to any other host during the read is stopped and that page is read signed out
// instead (hopAllowed). Sensitive hosts (banks, payments, password managers, account-security pages)
// are only ever "Just this once": they are never stored and "Always" isn't offered.
// Never for: outside agents over MCP (they get the signed-out read, see decide), background tasks and
// private windows (no signed-in reader is wired there), non-web addresses (lumen://, file:, settings).
//
// Pure logic plus the settings store; main.js wires the browser side and agent.js asks the user.
// Stored as settings.json aiSignedInSites: [{ host, added }] (settings-backend.js validates it with clean()).

const MAX_SITES = 200;

// Conservative list of hosts where a signed-in read is never remembered. Suffix match on the host:
// 'paypal.com' covers www.paypal.com and anything under it.
const SENSITIVE_SUFFIXES = [
  // password managers
  '1password.com', '1password.eu', '1password.ca', 'lastpass.com', 'bitwarden.com', 'bitwarden.eu', 'dashlane.com',
  'keepersecurity.com', 'nordpass.com', 'roboform.com', 'enpass.io', 'keepass.info', 'pass.proton.me', 'account.proton.me',
  // payments, money transfer, brokers, crypto
  'paypal.com', 'venmo.com', 'cash.app', 'dashboard.stripe.com', 'connect.stripe.com', 'squareup.com', 'wise.com',
  'revolut.com', 'zellepay.com', 'klarna.com', 'affirm.com', 'afterpay.com', 'payoneer.com', 'skrill.com',
  'coinbase.com', 'binance.com', 'kraken.com', 'gemini.com', 'crypto.com', 'robinhood.com', 'etrade.com',
  'schwab.com', 'fidelity.com', 'vanguard.com', 'interactivebrokers.com', 'webull.com',
  // banks and cards (names without "bank" in them; bankLike() catches the rest)
  'chase.com', 'wellsfargo.com', 'citi.com', 'capitalone.com', 'pnc.com', 'ally.com', 'americanexpress.com',
  'discover.com', 'synchrony.com', 'truist.com', 'regions.com', 'citizensbank.com', 'navyfederal.org', 'usaa.com',
  'hsbc.com', 'hsbc.co.uk', 'barclays.co.uk', 'barclays.com', 'natwest.com', 'lloydsbank.com', 'santander.com',
  'monzo.com', 'starlingbank.com', 'n26.com', 'rbc.com', 'rbcroyalbank.com', 'td.com', 'scotiabank.com', 'bmo.com', 'cibc.com',
  'ing.com', 'bnpparibas', 'commbank.com.au', 'westpac.com.au', 'anz.com', 'nab.com.au', 'mint.intuit.com', 'turbotax.intuit.com',
  // account and security pages of the big identity providers
  'accounts.google.com', 'myaccount.google.com', 'passwords.google.com', 'pay.google.com', 'payments.google.com', 'wallet.google.com',
  'account.microsoft.com', 'account.live.com', 'login.live.com', 'login.microsoftonline.com', 'mysignins.microsoft.com',
  'appleid.apple.com', 'account.apple.com', 'iforgot.apple.com', 'id.apple.com',
  'accountscenter.facebook.com', 'accountscenter.instagram.com', 'github.com/settings',
  // government identity / tax
  'irs.gov', 'ssa.gov', 'login.gov', 'id.me', 'gov.uk',
];

// Host as stored and compared: lowercase, no trailing dot, "www." dropped (www.x.com and x.com are one site).
function hostKey(host) {
  return String(host || '').trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

// The host of a web address ('' for anything that isn't http(s): lumen://, file:, about:, chrome:, data:).
function hostOfUrl(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return ''; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  if (parsed.username || parsed.password) return ''; // credentials in the address: never
  return hostKey(parsed.hostname);
}

// A host label that says "bank" (tdbank, bankofamerica, onlinebanking.x, bank-x): treated as a bank.
const bankLike = (host) => host.split('.').some((label) => /bank/.test(label));

function isSensitiveHost(host) {
  const h = hostKey(host);
  if (!h) return false;
  if (bankLike(h)) return true;
  // Path-level entries ('github.com/settings') are isSensitiveUrl's; a dotless entry matches a label.
  return SENSITIVE_SUFFIXES.some((s) => !s.includes('/') && (h === s || h.endsWith(`.${s}`) || (!s.includes('.') && h.split('.').includes(s))));
}
// Path-level sensitive pages on a host that is otherwise fine (github.com/settings).
function isSensitiveUrl(url) {
  const host = hostOfUrl(url);
  if (!host) return false;
  if (isSensitiveHost(host)) return true;
  let path = '';
  try { path = new URL(String(url)).pathname.toLowerCase(); } catch {}
  return SENSITIVE_SUFFIXES.some((s) => {
    if (!s.includes('/')) return false;
    const [h, ...rest] = s.split('/');
    const p = `/${rest.join('/')}`;
    return host === h && (path === p || path.startsWith(`${p}/`));
  });
}

// A valid host name to store: letters, digits, dots and dashes, with at least one dot.
const validHost = (h) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h) && h.length <= 253;

// settings.json aiSignedInSites -> [{ host, added }]: valid hosts only, no sensitive ones, no duplicates,
// newest kept, at most MAX_SITES. Anything else (a damaged file) reads as an empty list.
function clean(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const item of value) {
    const raw = typeof item === 'string' ? { host: item } : item && typeof item === 'object' ? item : null;
    if (!raw) continue;
    const host = hostKey(raw.host);
    if (!validHost(host) || isSensitiveHost(host) || seen.has(host)) continue;
    seen.add(host);
    const added = Number.isFinite(Number(raw.added)) && Number(raw.added) > 0 ? Math.round(Number(raw.added)) : 0;
    out.push({ host, added });
  }
  return out.slice(-MAX_SITES);
}

// Cookies that say nothing about being signed in (analytics, consent banners). Any other cookie on the
// site counts as "may be signed in", which is enough to offer the card.
const NOT_LOGIN = /^(_ga|_gid|_gat|_gcl|__utm|_fbp|_fbc|_hj|_clck|_clsk|_uet|ajs_|amplitude|mp_|optanon|eupubconsent|cookieconsent|cookie_consent|euconsent|__cf_bm|_cfuvid|cf_clearance|nid$|1p_jar|aec$)/i;
function hasLoginCookies(cookies) {
  return Array.isArray(cookies) && cookies.some((c) => c && typeof c.name === 'string' && !NOT_LOGIN.test(c.name));
}

// What to do with one read_urls address. Returns { mode, host, sensitive, offerAlways, reason }:
//   'signed-in'  read it with the user's session now (the host is always-allowed)
//   'ask'        show the card (the AI asked for as_user and the user has cookies there)
//   'signed-out' the usual logged-out read; `reason` says why when the AI asked for as_user
// Inputs: url; asUser (the model asked); external (an outside agent over MCP); privateWindow; supported
// (a signed-in reader is wired for this agent: not in background tasks); always (Set of stored hosts);
// hasLogin (the user's session has non-analytics cookies for the host; only needed for 'ask').
function decide({ url, asUser = false, external = false, privateWindow = false, supported = true, always = new Set(), hasLogin = false }) {
  const host = hostOfUrl(url);
  const sensitive = host ? isSensitiveUrl(url) : false;
  const out = (mode, reason = null) => ({ mode, host, sensitive, offerAlways: !sensitive, reason });
  if (!host) return out('signed-out', 'not-web');
  if (external) return out('signed-out', asUser ? 'outside-agent' : null);
  if (privateWindow) return out('signed-out', asUser ? 'private' : null);
  if (!supported) return out('signed-out', asUser ? 'unsupported' : null);
  if (!sensitive && always.has(host)) return out('signed-in', 'always');
  if (!asUser) return out('signed-out');
  if (!hasLogin) return out('signed-out', 'no-login');
  return out('ask');
}

// The user's answer on the card -> 'always' | 'once' | null. Sensitive hosts never get 'always'.
function grantFrom(answer, { sensitive = false } = {}) {
  if (answer === 'always') return sensitive ? 'once' : 'always';
  if (answer === true || answer === 'once') return 'once';
  return null;
}

// During a signed-in read, may the tab's main frame go to `url`? Only the approved host itself (www or
// not); anything else (another host, a sensitive page on the same host, a non-web address) stops the
// signed-in read, and that page is read signed out instead.
function hopAllowed(grant, url) {
  if (!grant || !grant.host) return false;
  const host = hostOfUrl(url);
  if (!host || host !== grant.host) return false;
  if (isSensitiveUrl(url) && !grant.sensitive) return false; // e.g. github.com -> github.com/settings
  return true;
}

// Why a read asked for as_user was read signed out, for the tool result (the model tells the user).
function reasonText(reason, host, who = 'The AI') {
  switch (reason) {
    case 'outside-agent': return `read signed out: outside agents can't use the user's signed-in accounts in Lumen`;
    case 'private': return 'read signed out: not available in private windows';
    case 'unsupported': return 'read signed out: signed-in reading is not available here (background tasks)';
    case 'no-login': return `read signed out: the user doesn't seem to be signed in to ${host} in Lumen`;
    case 'denied': return `read signed out: the user did not let ${who} use their ${host} account`;
    case 'redirect': return `read signed out: the page went to another site, which wasn't approved for signed-in reading`;
    default: return 'read signed out';
  }
}

function createSignedInSites({ readSettings, writeSettings, now = () => Date.now() }) {
  const list = () => clean(readSettings().aiSignedInSites);
  const hosts = () => new Set(list().map((s) => s.host));
  const isAlways = (url) => {
    const host = hostOfUrl(url);
    return Boolean(host) && !isSensitiveUrl(url) && hosts().has(host);
  };
  const save = (next) => { writeSettings({ ...readSettings(), aiSignedInSites: clean(next) }); return list(); };
  function add(host) {
    const h = hostKey(host);
    if (!validHost(h) || isSensitiveHost(h)) return list();
    return save([...list().filter((s) => s.host !== h), { host: h, added: now() }]);
  }
  const remove = (host) => save(list().filter((s) => s.host !== hostKey(host)));
  const clear = () => save([]);
  // settings:* channels answer the browser UI and the Settings tab only (main.js IPC gate); nothing a
  // page or the AI's tools can reach. There is no "add" channel: a host is added only from the card.
  function register(ipcMain) {
    ipcMain.handle('settings:signed-in-sites', () => list());
    ipcMain.handle('settings:remove-signed-in-site', (_e, host) => remove(String(host ?? '')));
    ipcMain.handle('settings:clear-signed-in-sites', () => clear());
  }
  return { list, hosts, isAlways, add, remove, clear, register };
}

module.exports = {
  createSignedInSites, decide, grantFrom, hopAllowed, clean, hostKey, hostOfUrl, isSensitiveHost, isSensitiveUrl,
  hasLoginCookies, reasonText, MAX_SITES,
};
