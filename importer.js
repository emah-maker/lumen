// Imports bookmarks and history from other browsers installed on this computer.
// Chromium browsers (Chrome, Edge, Brave, Vivaldi, Opera) keep bookmarks as JSON and history in
// SQLite; Firefox keeps both in places.sqlite. Databases are copied first (the other browser may
// have them open) and read with Node's built-in SQLite. Passwords and cookies are never touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const home = os.homedir();
const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
const macSupport = path.join(home, 'Library', 'Application Support');
const linuxConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');

// Where each browser keeps its profiles on Windows, macOS and Linux. `roots` are tried in order
// (Linux Firefox also comes as a Snap or Flatpak). `profileDir` names a fixed profile folder;
// '' means the root itself is the profile (Opera on macOS and Linux).
const PLATFORM_BROWSERS = {
  win32: [
    { id: 'chrome', label: 'Google Chrome', kind: 'chromium', roots: [path.join(local, 'Google', 'Chrome', 'User Data')] },
    { id: 'edge', label: 'Microsoft Edge', kind: 'chromium', roots: [path.join(local, 'Microsoft', 'Edge', 'User Data')] },
    { id: 'brave', label: 'Brave', kind: 'chromium', roots: [path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data')] },
    { id: 'vivaldi', label: 'Vivaldi', kind: 'chromium', roots: [path.join(local, 'Vivaldi', 'User Data')] },
    { id: 'opera', label: 'Opera', kind: 'chromium', roots: [path.join(roaming, 'Opera Software')], profileDir: 'Opera Stable' },
    { id: 'firefox', label: 'Firefox', kind: 'firefox', roots: [path.join(roaming, 'Mozilla', 'Firefox')] },
  ],
  darwin: [
    { id: 'chrome', label: 'Google Chrome', kind: 'chromium', roots: [path.join(macSupport, 'Google', 'Chrome')] },
    { id: 'edge', label: 'Microsoft Edge', kind: 'chromium', roots: [path.join(macSupport, 'Microsoft Edge')] },
    { id: 'brave', label: 'Brave', kind: 'chromium', roots: [path.join(macSupport, 'BraveSoftware', 'Brave-Browser')] },
    { id: 'vivaldi', label: 'Vivaldi', kind: 'chromium', roots: [path.join(macSupport, 'Vivaldi')] },
    { id: 'opera', label: 'Opera', kind: 'chromium', roots: [path.join(macSupport, 'com.operasoftware.Opera')], profileDir: '' },
    { id: 'firefox', label: 'Firefox', kind: 'firefox', roots: [path.join(macSupport, 'Firefox')] },
    { id: 'safari', label: 'Safari', kind: 'safari', roots: [path.join(home, 'Library', 'Safari')] },
  ],
  linux: [
    { id: 'chrome', label: 'Google Chrome', kind: 'chromium', roots: [path.join(linuxConfig, 'google-chrome')] },
    { id: 'chromium', label: 'Chromium', kind: 'chromium', roots: [path.join(linuxConfig, 'chromium'), path.join(home, 'snap', 'chromium', 'common', 'chromium')] },
    { id: 'edge', label: 'Microsoft Edge', kind: 'chromium', roots: [path.join(linuxConfig, 'microsoft-edge')] },
    { id: 'brave', label: 'Brave', kind: 'chromium', roots: [path.join(linuxConfig, 'BraveSoftware', 'Brave-Browser')] },
    { id: 'vivaldi', label: 'Vivaldi', kind: 'chromium', roots: [path.join(linuxConfig, 'vivaldi')] },
    { id: 'opera', label: 'Opera', kind: 'chromium', roots: [path.join(linuxConfig, 'opera')], profileDir: '' },
    { id: 'firefox', label: 'Firefox', kind: 'firefox', roots: [path.join(home, '.mozilla', 'firefox'), path.join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox'), path.join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox')] },
  ],
};
// Each browser's root is the first of its candidates that exists (or the first, when none do).
const BROWSERS = (PLATFORM_BROWSERS[process.platform] || PLATFORM_BROWSERS.linux).map(({ roots, ...b }) => ({
  ...b,
  get root() { return roots.find((r) => fs.existsSync(r)) || roots[0]; },
}));
// Every kind, whatever this computer runs: tests read fake profiles of any kind by id.
const KINDS = { chrome: 'chromium', chromium: 'chromium', edge: 'chromium', brave: 'chromium', vivaldi: 'chromium', opera: 'chromium', firefox: 'firefox', safari: 'safari' };
const LABELS = { chrome: 'Google Chrome', chromium: 'Chromium', edge: 'Microsoft Edge', brave: 'Brave', vivaldi: 'Vivaldi', opera: 'Opera', firefox: 'Firefox', safari: 'Safari' };

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
  if (browser.profileDir !== undefined) return path.join(browser.root, browser.profileDir);
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
  // Windows and macOS keep profiles in Profiles/; Linux keeps them in the root itself.
  for (const dir of [profilesDir, browser.root]) {
    try {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.existsSync(path.join(p, 'places.sqlite'))) return p;
      }
    } catch {
      // No profiles here.
    }
  }
  return null;
}

function profileOf(browser) {
  if (browser.kind === 'safari') return browser.root;
  return browser.kind === 'firefox' ? firefoxProfile(browser) : chromiumProfile(browser);
}

// Browsers with a readable profile on this computer. Safari is listed whenever its folder exists:
// macOS may still refuse to let Lumen read it, and the import then explains how to allow that.
function detectBrowsers() {
  return BROWSERS.filter((b) => {
    const p = profileOf(b);
    if (!p) return false;
    if (b.kind === 'safari') return fs.existsSync(p);
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

// ---- Safari (macOS): bookmarks in Bookmarks.plist, history in History.db ----
// Bookmarks.plist is a binary property list; macOS's own `plutil` turns it into XML, which the small
// reader below understands (dict, array, string, integer, real, true/false, date, data).
function parsePlistXml(xml) {
  const tokens = xml.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/g, '').match(/<[^>]+>|[^<]+/g) || [];
  let i = 0;
  const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
  const next = () => { while (i < tokens.length && !tokens[i].startsWith('<')) i++; return tokens[i++]; };
  const text = (tag) => { let out = ''; while (i < tokens.length && tokens[i] !== `</${tag}>`) out += tokens[i++]; i++; return unescape(out); };
  function value(open = next()) {
    if (!open) return undefined;
    const tag = open.replace(/[<>/]/g, '').trim().split(/\s/)[0];
    if (open.endsWith('/>')) return tag === 'true' ? true : tag === 'false' ? false : tag === 'dict' ? {} : tag === 'array' ? [] : '';
    if (tag === 'plist') { const v = value(); next(); return v; }
    if (tag === 'dict') {
      const out = {};
      for (let t = next(); t && t !== '</dict>'; t = next()) { const key = text('key'); out[key] = value(); }
      return out;
    }
    if (tag === 'array') {
      const out = [];
      for (let t = next(); t && t !== '</array>'; t = next()) out.push(value(t));
      return out;
    }
    const raw = text(tag);
    return tag === 'integer' || tag === 'real' ? Number(raw) : raw;
  }
  return value();
}

function readSafariPlist(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 6).toString() !== 'bplist') return parsePlistXml(bytes.toString('utf8'));
  const xml = require('child_process').execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', file], { maxBuffer: 64 * 1024 * 1024 });
  return parsePlistXml(xml.toString('utf8'));
}

function safariBookmarks(root) {
  const out = [];
  const tree = readSafariPlist(path.join(root, 'Bookmarks.plist'));
  const walk = (node, folder) => {
    if (!node || out.length >= MAX_BOOKMARKS) return;
    if (node.WebBookmarkType === 'WebBookmarkTypeLeaf' && isWeb(node.URLString)) {
      out.push({ url: node.URLString, title: node.URIDictionary?.title || '', ...(folder ? { folder } : {}) });
      return;
    }
    // Reading List items are pages to read later, not bookmarks.
    if (node.Title === 'com.apple.ReadingList') return;
    const name = node.Title && !['BookmarksBar', 'BookmarksMenu', 'Favorites'].includes(node.Title) ? node.Title : folder;
    for (const child of node.Children || []) walk(child, node === tree ? folder : name);
  };
  walk(tree, null);
  return out;
}

// Safari stores visit times as seconds since 2001-01-01 (Mac absolute time).
const safariTime = (t) => Math.round((Number(t) + 978307200) * 1000);
function safariHistory(root) {
  return withDatabaseCopy(path.join(root, 'History.db'), (db) => db.prepare(
    `SELECT i.url AS url, v.title AS title, i.visit_count AS visits, MAX(v.visit_time) AS last
     FROM history_items i JOIN history_visits v ON v.history_item = i.id GROUP BY i.id ORDER BY last DESC LIMIT ?`,
  ).all(MAX_HISTORY).filter((r) => isWorthImporting(r.url)).map((r) => ({ url: r.url, title: r.title || '', visits: Number(r.visits) || 1, last: safariTime(r.last) }))) || [];
}

function safariData(root) {
  try {
    return { bookmarks: fs.existsSync(path.join(root, 'Bookmarks.plist')) ? safariBookmarks(root) : [], history: safariHistory(root) };
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      throw new Error('macOS doesn’t let Lumen read Safari’s data yet. In System Settings → Privacy & Security → Full Disk Access, turn on Lumen, then import again.');
    }
    throw err;
  }
}

// Reads a browser's data. profilePath overrides detection (used by tests).
function readBrowser(id, profilePath) {
  const browser = BROWSERS.find((b) => b.id === id) || (profilePath && KINDS[id] ? { id, kind: KINDS[id], label: LABELS[id] } : null);
  if (!browser) throw new Error(`Unknown browser: ${id}`);
  const profile = profilePath || profileOf(browser);
  if (!profile) throw new Error(`No ${browser.label} profile found.`);
  if (browser.kind === 'safari') return { label: browser.label, ...safariData(profile) };
  if (browser.kind === 'firefox') return { label: browser.label, ...firefoxData(profile) };
  return { label: browser.label, bookmarks: chromiumBookmarks(profile), history: chromiumHistory(profile) };
}

module.exports = { BROWSERS, detectBrowsers, readBrowser, chromiumTime, isWorthImporting, parsePlistXml };
