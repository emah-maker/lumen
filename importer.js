// Imports bookmarks and history from other browsers installed on this computer.
// Chromium browsers (Chrome, Edge, Brave, Vivaldi, Opera) keep bookmarks as JSON and history in
// SQLite; Firefox keeps both in places.sqlite. Databases are copied first (the other browser may
// have them open) and read with Node's built-in SQLite. Passwords and cookies are never touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

const BROWSERS = [
  { id: 'chrome', label: 'Google Chrome', kind: 'chromium', root: path.join(local, 'Google', 'Chrome', 'User Data') },
  { id: 'edge', label: 'Microsoft Edge', kind: 'chromium', root: path.join(local, 'Microsoft', 'Edge', 'User Data') },
  { id: 'brave', label: 'Brave', kind: 'chromium', root: path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
  { id: 'vivaldi', label: 'Vivaldi', kind: 'chromium', root: path.join(local, 'Vivaldi', 'User Data') },
  { id: 'opera', label: 'Opera', kind: 'chromium', root: path.join(roaming, 'Opera Software'), profileDir: 'Opera Stable' },
  { id: 'firefox', label: 'Firefox', kind: 'firefox', root: path.join(roaming, 'Mozilla', 'Firefox') },
];

const MAX_BOOKMARKS = 1000;
const MAX_HISTORY = 5000;
const isWeb = (url) => /^https?:\/\//i.test(url || '');

// Sign-in, OAuth and one-time links are useless as history and can carry tokens: never import them.
const SENSITIVE_PATH = /(^|\/)(signin|sign-in|login|logon|oauth2?|authorize|auth|challenge|sso|saml|verify|reset-password|callback)(\/|$)/i;
const SENSITIVE_PARAM = /[?&#](code|state|token|access_token|id_token|refresh_token|sid|ticket|otp|nonce|password|api_key|apikey|client_secret)=/i;
function isWorthImporting(url) {
  if (!isWeb(url) || url.length > 4000) return false;
  try {
    const u = new URL(url);
    if (/^(accounts|login|auth|signin|sso|id)\./i.test(u.hostname)) return false;
    return !SENSITIVE_PATH.test(u.pathname) && !SENSITIVE_PARAM.test(u.search + u.hash);
  } catch {
    return false;
  }
}

// The profile a Chromium browser last used (Local State), falling back to "Default".
function chromiumProfile(browser) {
  if (browser.profileDir) return path.join(browser.root, browser.profileDir);
  try {
    const state = JSON.parse(fs.readFileSync(path.join(browser.root, 'Local State'), 'utf8'));
    const last = state.profile?.last_used;
    if (last && fs.existsSync(path.join(browser.root, last))) return path.join(browser.root, last);
  } catch {
    // No Local State; use Default.
  }
  return path.join(browser.root, 'Default');
}

// The default Firefox profile (profiles.ini), or the first one that has places.sqlite.
function firefoxProfile(browser) {
  const profilesDir = path.join(browser.root, 'Profiles');
  try {
    const ini = fs.readFileSync(path.join(browser.root, 'profiles.ini'), 'utf8');
    const install = ini.match(/\[Install[^\]]*\][^[]*?Default=([^\r\n]+)/);
    const candidate = install?.[1] || ini.match(/Path=([^\r\n]+)[^[]*?Default=1/)?.[1];
    if (candidate) {
      const p = path.isAbsolute(candidate) ? candidate : path.join(browser.root, candidate);
      if (fs.existsSync(path.join(p, 'places.sqlite'))) return p;
    }
  } catch {
    // No profiles.ini; scan the folder.
  }
  try {
    for (const name of fs.readdirSync(profilesDir)) {
      const p = path.join(profilesDir, name);
      if (fs.existsSync(path.join(p, 'places.sqlite'))) return p;
    }
  } catch {
    // No profiles.
  }
  return null;
}

function profileOf(browser) {
  return browser.kind === 'firefox' ? firefoxProfile(browser) : chromiumProfile(browser);
}

// Browsers with a readable profile on this computer.
function detectBrowsers() {
  return BROWSERS.filter((b) => {
    const p = profileOf(b);
    if (!p) return false;
    return b.kind === 'firefox'
      ? fs.existsSync(path.join(p, 'places.sqlite'))
      : fs.existsSync(path.join(p, 'Bookmarks')) || fs.existsSync(path.join(p, 'History'));
  }).map(({ id, label }) => ({ id, label }));
}

// Copies a SQLite file (and its write-ahead log) to a temp folder, then runs fn(db).
function withDatabaseCopy(file, fn) {
  if (!fs.existsSync(file)) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-import-'));
  const copy = path.join(dir, path.basename(file));
  try {
    fs.copyFileSync(file, copy);
    for (const suffix of ['-wal', '-journal']) if (fs.existsSync(file + suffix)) fs.copyFileSync(file + suffix, copy + suffix);
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function chromiumBookmarks(profile) {
  const out = [];
  try {
    const data = JSON.parse(fs.readFileSync(path.join(profile, 'Bookmarks'), 'utf8'));
    const walk = (node, folder) => {
      if (!node || out.length >= MAX_BOOKMARKS) return;
      if (node.type === 'url' && isWeb(node.url)) out.push({ url: node.url, title: node.name || '', ...(folder ? { folder } : {}) });
      const inner = node.type === 'folder' && node.name && !['Bookmarks bar', 'Bookmarks Bar', 'Other bookmarks', 'Mobile bookmarks', 'Favorites bar', 'Other favorites'].includes(node.name) ? node.name : folder;
      for (const child of node.children || []) walk(child, node.type === 'folder' ? inner : folder);
    };
    for (const root of Object.values(data.roots || {})) walk(root, null);
  } catch {
    // No bookmarks file.
  }
  return out;
}

// Chromium stores times as microseconds since 1601-01-01 (too big for a JS number: read as BigInt).
const chromiumTime = (t) => Number(BigInt(t) / 1000n) - 11644473600000;
const bigRows = (stmt, ...args) => { stmt.setReadBigInts(true); return stmt.all(...args); };

function chromiumHistory(profile) {
  return withDatabaseCopy(path.join(profile, 'History'), (db) => bigRows(db.prepare(
    'SELECT url, title, visit_count AS visits, last_visit_time AS last FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT ?',
  ), MAX_HISTORY).filter((r) => isWorthImporting(r.url)).map((r) => ({ url: r.url, title: r.title || '', visits: Number(r.visits) || 1, last: chromiumTime(r.last) }))) || [];
}

function firefoxData(profile) {
  return withDatabaseCopy(path.join(profile, 'places.sqlite'), (db) => ({
    bookmarks: db.prepare(
      "SELECT p.url AS url, COALESCE(b.title, p.title, '') AS title FROM moz_bookmarks b JOIN moz_places p ON b.fk = p.id WHERE b.type = 1 AND p.url LIKE 'http%' LIMIT ?",
    ).all(MAX_BOOKMARKS).map((r) => ({ url: r.url, title: r.title || '' })),
    history: bigRows(db.prepare(
      "SELECT url, title, visit_count AS visits, last_visit_date AS last FROM moz_places WHERE visit_count > 0 AND url LIKE 'http%' ORDER BY last_visit_date DESC LIMIT ?",
    ), MAX_HISTORY).filter((r) => isWorthImporting(r.url)).map((r) => ({ url: r.url, title: r.title || '', visits: Number(r.visits) || 1, last: Number(BigInt(r.last ?? 0) / 1000n) })),
  })) || { bookmarks: [], history: [] };
}

// Reads a browser's data. profilePath overrides detection (used by tests).
function readBrowser(id, profilePath) {
  const browser = BROWSERS.find((b) => b.id === id);
  if (!browser) throw new Error(`Unknown browser: ${id}`);
  const profile = profilePath || profileOf(browser);
  if (!profile) throw new Error(`No ${browser.label} profile found.`);
  if (browser.kind === 'firefox') return { label: browser.label, ...firefoxData(profile) };
  return { label: browser.label, bookmarks: chromiumBookmarks(profile), history: chromiumHistory(profile) };
}

module.exports = { BROWSERS, detectBrowsers, readBrowser, chromiumTime, isWorthImporting };
