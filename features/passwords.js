// ---------- saved passwords: an opt-in password manager, off by default ----------
// Settings → Privacy and security → Save passwords. When it is on, signing in on a web page offers
// "Save password for <site>?" (Save / Never for this site / Not now) in a bar under the toolbar, and a
// key button in the address field fills a saved login into the page when the user clicks it. Nothing is
// filled by itself and nothing is ever submitted.
//
// Where it works: ordinary tabs of the browser window only, on https pages (and http on localhost).
// Never in private windows (they have their own code, features/private-window.js, which doesn't use
// this), the AI's research tabs (RESEARCH_PARTITION) and hidden reader views (partition
// 'claude-reader', not tabs at all), tabs the AI opened to read signed in (aiSignedIn), Lumen's own
// pages (settings, history, new tab, error pages) or popups. See verdict().
//
// Storage: <profile>/passwords.bin holds every login as one JSON document encrypted with Electron's
// safeStorage, whose key the OS keeps (macOS Keychain, Windows DPAPI, the Secret Service on Linux).
// Nothing about the logins goes in settings.json: it keeps only savePasswords (on/off) and
// passwordsNever (sites where the offer stays away). Without OS encryption the feature refuses to turn
// on and says why; there is no plaintext fallback, and a file that can't be decrypted is left untouched.
//
// Kept away from the AI: the vault lives in this main-process module only. agent.js, mcp.js, the MCP
// tools and page capture never get a reference to it; the page scripts run in their own isolated world
// (features/password-page.js) with no IPC; a tab where the user filled a password refuses run_script
// on that site for as long as the tab is open (filledIn, asked by agent.js); the settings calls answer
// only the settings page, which the AI can't drive. Passwords are never logged.
//
// Pure logic (sites, validation, CSV import, the vault over an injected cipher) plus the runtime that
// main.js wires in with createPasswords.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const page = require('./password-page');

const MAX_ENTRIES = 5000;
const MAX_USERNAME = 512;
const MAX_PASSWORD = 1024;
const MAX_NEVER = 500;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const OFFER_MS = 5 * 60 * 1000; // an unanswered "Save password?" goes after five minutes
const CLIPBOARD_MS = 30 * 1000; // a copied password is cleared from the clipboard after this, if still there
const FILE_NAME = 'passwords.bin';

// ---- sites ----

// A local development address: plain http is fine there (nothing crosses the network).
const isLocalHost = (host) => host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';
const validHost = (h) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h) && h.length <= 253;

// The site a login belongs to: the page's host, lowercase, "www." dropped (as features/signed-in-sites.js
// does: www.x.com and x.com are one site), with the port when it isn't the default. Exact host, not the
// registrable domain: a login saved on accounts.example.com is not offered on shop.example.com.
// '' for anything that can't have saved logins: not https (http only on localhost), credentials in the
// address, lumen://, file:, data:, about: and the rest.
function siteOf(url) {
  let u;
  try { u = new URL(String(url)); } catch { return ''; }
  if (u.username || u.password) return '';
  const host = u.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (!host) return '';
  const local = isLocalHost(host);
  if (u.protocol === 'https:' ? !(local || validHost(host)) : !(u.protocol === 'http:' && local)) return '';
  return u.port ? `${host}:${u.port}` : host;
}
// A stored site key as siteOf makes them (settings.json and the vault are validated with this).
const validSite = (site) => typeof site === 'string' && site.length > 0 && site.length <= 260
  && (siteOf(`https://${site}/`) === site || siteOf(`http://${site}/`) === site);

// May this tab offer to save, or fill? { ok, site, reason }. Inputs: the tab's url, whether the feature
// is on, and facts about the tab (a private window's, a research tab's, the settings tab, one of Lumen's
// own pages, a tab the AI opened to read signed in).
function verdict({ url, enabled = false, privateWindow = false, isolated = false, settings = false, internal = false, aiTab = false }) {
  const out = (reason, site = '') => ({ ok: !reason, site, reason });
  if (!enabled) return out('off');
  if (privateWindow) return out('private');
  if (isolated) return out('isolated');
  if (settings || internal) return out('internal');
  if (aiTab) return out('ai');
  const site = siteOf(url);
  if (!site) return out('not-secure');
  return out(null, site);
}

// ---- validation ----

const cleanUsername = (v) => (typeof v === 'string' && v.length <= MAX_USERNAME && !/[\u0000-\u001f\u007f]/.test(v) ? v.trim() : null);
const cleanPassword = (v) => (typeof v === 'string' && v.length > 0 && v.length <= MAX_PASSWORD && !v.includes('\u0000') ? v : null);
const cleanId = (v) => (typeof v === 'string' && /^[a-f0-9-]{8,64}$/.test(v) ? v : null);

// settings.json passwordsNever -> valid, distinct sites, at most MAX_NEVER. A damaged value reads as [].
function cleanNever(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(validSite))].slice(-MAX_NEVER);
}

// The vault's entries as read back from disk: well-formed ones only, one per site and username (the
// newest wins), at most MAX_ENTRIES.
function cleanEntries(value) {
  if (!Array.isArray(value)) return [];
  const byKey = new Map();
  for (const e of value) {
    if (!e || typeof e !== 'object') continue;
    const id = cleanId(e.id);
    const username = cleanUsername(e.username);
    const password = cleanPassword(e.password);
    if (!id || !validSite(e.site) || username === null || password === null) continue;
    const num = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.round(Number(n)) : 0);
    const entry = { id, site: e.site, username, password, created: num(e.created), updated: num(e.updated) };
    const key = `${entry.site}\n${entry.username}`;
    const had = byKey.get(key);
    if (!had || entry.updated >= had.updated) { byKey.delete(key); byKey.set(key, entry); }
  }
  return [...byKey.values()].slice(-MAX_ENTRIES);
}

// ---- CSV import (Chrome, Apple Passwords, Firefox, Bitwarden exports) ----

// RFC 4180: commas, "quoted" fields with "" for a quote, line breaks inside quotes, CRLF or LF, a BOM.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

// A passwords export -> { logins: [{ site, username, password }], skipped } or { error }. The header row
// names the columns: url (or website, login_uri), username (or login, login_username) and password (or
// login_password). A row whose address isn't a web site (an Android app, a plain-http site) is skipped.
function importCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { error: 'empty' };
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const iu = col('url', 'website', 'login_uri', 'login uri');
  const in_ = col('username', 'login', 'login_username', 'user name', 'email');
  const ip = col('password', 'login_password');
  if (iu < 0 || in_ < 0 || ip < 0) return { error: 'columns' };
  const logins = [];
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const raw = String(r[iu] || '').trim();
    const site = siteOf(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    const username = cleanUsername(r[in_] ?? '');
    const password = cleanPassword(r[ip] ?? '');
    if (!site || username === null || password === null) { skipped++; continue; }
    logins.push({ site, username, password });
  }
  return { logins, skipped };
}

// ---- the vault: every login in one file, encrypted as a whole ----
// cipher: { available() -> bool, encrypt(string) -> Buffer, decrypt(Buffer) -> string } (safeStorage in
// main.js; a stand-in in the tests). Decrypted logins stay in this process's memory once read.
function createVault({ file, cipher, now = () => Date.now() }) {
  let entries = null;
  let broken = null; // why the file couldn't be read: nothing is written over it

  function load() {
    if (entries) return entries;
    if (broken) throw new Error(broken);
    let buf;
    try { buf = fs.readFileSync(file); } catch (err) {
      if (err.code === 'ENOENT') { entries = []; return entries; }
      throw err;
    }
    if (!cipher.available()) throw new Error('OS encryption is unavailable');
    try {
      const data = JSON.parse(cipher.decrypt(buf));
      entries = cleanEntries(data?.entries);
    } catch {
      broken = 'Saved passwords could not be decrypted (the OS key may have changed); the file was left as it is';
      throw new Error(broken);
    }
    return entries;
  }

  function persist(next) {
    if (broken) throw new Error(broken);
    if (!cipher.available()) throw new Error('OS encryption is unavailable');
    const buf = cipher.encrypt(JSON.stringify({ version: 1, entries: next }));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    try { fs.renameSync(tmp, file); } catch { fs.writeFileSync(file, buf, { mode: 0o600 }); try { fs.unlinkSync(tmp); } catch {} }
    entries = next;
  }

  const summary = (e) => ({ id: e.id, site: e.site, username: e.username, created: e.created, updated: e.updated });
  const bySite = (a, b) => a.site.localeCompare(b.site) || a.username.localeCompare(b.username);
  return {
    // Without passwords: what the settings page and the key menu show.
    list: () => load().map(summary).sort(bySite),
    forSite: (site) => load().filter((e) => e.site === site).map(summary).sort(bySite),
    count: (site) => (site ? load().filter((e) => e.site === site).length : load().length),
    get: (id) => load().find((e) => e.id === id) || null,
    find: (site, username) => load().find((e) => e.site === site && e.username === username) || null,
    // Adds a login, or changes the password of the one with the same site and username.
    upsert({ site, username, password }) {
      const u = cleanUsername(username);
      const p = cleanPassword(password);
      if (!validSite(site) || u === null || p === null) throw new Error('Invalid login');
      const list = load();
      const had = list.find((e) => e.site === site && e.username === u);
      if (!had && list.length >= MAX_ENTRIES) throw new Error(`At most ${MAX_ENTRIES} saved passwords`);
      const at = now();
      const entry = had ? { ...had, password: p, updated: at } : { id: crypto.randomUUID(), site, username: u, password: p, created: at, updated: at };
      persist([...list.filter((e) => e !== had), entry]);
      return { entry: summary(entry), created: !had };
    },
    // Edit from Settings: a new username and/or password ('' or missing: keep the password).
    update(id, { username, password } = {}) {
      const list = load();
      const had = list.find((e) => e.id === id);
      if (!had) throw new Error('No such login');
      const u = username === undefined ? had.username : cleanUsername(username);
      const p = password === undefined || password === '' ? had.password : cleanPassword(password);
      if (u === null || p === null) throw new Error('Invalid login');
      if (list.some((e) => e !== had && e.site === had.site && e.username === u)) throw new Error('That site already has a login with this username');
      const next = { ...had, username: u, password: p, updated: now() };
      persist(list.map((e) => (e === had ? next : e)));
      return summary(next);
    },
    remove(id) { const list = load(); persist(list.filter((e) => e.id !== id)); },
    // Delete all: the file goes (a broken one too: the user asked for it).
    clear() {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}.tmp`, { force: true });
      entries = [];
      broken = null;
    },
    exists: () => fs.existsSync(file),
    error: () => broken,
  };
}

// ---- the runtime, wired by main.js ----
// deps: { file, cipher, readSettings, writeSettings, t, sendTabs, tabOf(webContents), facts(tab) ->
//   { isolated, settings, internal, aiTab }, allTabs() -> tabs, popupMenu(template), openSettings(section),
//   reauth(reason) -> Promise<bool>, confirm({ message, detail, buttons, defaultId }) -> Promise<index>,
//   notify(message, detail), clipboard, pickCsv() -> Promise<path|null>, outsideDriver() -> bool (a CDP
//   client is connected), isSettingsSender(event), now }
function createPasswords(deps) {
  const now = deps.now || (() => Date.now());
  const vault = createVault({ file: deps.file, cipher: deps.cipher, now });
  const states = new WeakMap(); // tab -> { doc, armed, offer, filled: Set of sites }
  const stateFor = (tab) => { let s = states.get(tab); if (!s) { s = { doc: 0, armed: 0, offer: null, filled: new Set() }; states.set(tab, s); } return s; };
  const live = (tab) => (tab?.view?.webContents && !tab.view.webContents.isDestroyed() ? tab.view.webContents : null);

  // Why OS encryption can't protect saved passwords here, or null when it can. Linux's "basic_text"
  // backend is a fixed key in Chromium's source: no protection at all, so it counts as unavailable.
  function unavailable() {
    if (!deps.cipher.available()) return 'unavailable';
    if (deps.cipher.backend?.() === 'basic_text') return 'basic-text';
    return null;
  }
  const enabled = () => deps.readSettings().savePasswords === true && !unavailable();
  const never = () => cleanNever(deps.readSettings().passwordsNever);
  const safeCount = (site) => { try { return vault.count(site); } catch { return 0; } };
  const verdictFor = (tab) => {
    const wc = live(tab);
    if (!wc) return { ok: false, site: '', reason: 'closed' };
    return verdict({ url: wc.getURL(), enabled: enabled(), ...deps.facts(tab) });
  };

  const run = (tab, code) => {
    const wc = live(tab);
    return wc ? wc.executeJavaScriptInIsolatedWorld(page.PASSWORD_WORLD, [{ code }]) : Promise.resolve(null);
  };

  // Starts watching the page for a sign-in (once per page load, and again after each one on a
  // single-page site). Not on sites the user said Never to.
  function arm(tab) {
    const st = stateFor(tab);
    const v = verdictFor(tab);
    if (!v.ok || never().includes(v.site)) return;
    const doc = st.doc;
    const token = ++st.armed;
    run(tab, page.watch()).then((got) => {
      if (!got) return; // stopped (Save passwords turned off)
      // Offered even when the page has gone meanwhile (flush() answers as the tab starts to leave).
      captured(tab, v.site, got);
      // Still the same page (a single-page site): watch for the next sign-in.
      setTimeout(() => { if (st.doc === doc && st.armed === token && live(tab)) arm(tab); }, 500);
    }).catch(() => {});
  }

  // The user signed in: offer to save (or update) unless it's already saved exactly like this.
  function captured(tab, site, got) {
    if (!enabled() || never().includes(site)) return;
    const username = cleanUsername(got?.username ?? '');
    const password = cleanPassword(got?.password);
    if (username === null || password === null) return;
    let had;
    try { had = vault.find(site, username); } catch { return; } // an unreadable vault: don't offer what can't be saved
    if (had && had.password === password) return;
    stateFor(tab).offer = { site, username, password, update: Boolean(had), at: now() };
    deps.sendTabs();
  }

  function attach(tab) {
    const wc = tab.view.webContents;
    wc.on('dom-ready', () => arm(tab));
    // The page is about to go: a sign-in it noted (a click on "Sign in", say) is reported now, while
    // the old page is still there to answer.
    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument || !stateFor(tab).armed) return;
      run(tab, page.FLUSH).catch(() => {});
    });
    wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => { if (isMainFrame && stateFor(tab).armed) run(tab, page.FLUSH).catch(() => {}); });
    wc.on('did-navigate', () => {
      const st = stateFor(tab);
      st.doc++;
      st.armed = 0;
    });
  }

  // For tabState(): what the bar and the key button show. No password, ever.
  function stateOf(tab) {
    const st = stateFor(tab);
    if (st.offer && now() - st.offer.at > OFFER_MS) st.offer = null;
    const v = verdictFor(tab);
    const saved = v.ok ? safeCount(v.site) : 0;
    const offer = st.offer && enabled() ? { site: st.offer.site, username: st.offer.username, update: st.offer.update } : null;
    if (!offer && !saved) return null;
    return { site: v.site, saved, offer };
  }

  // Did the user fill a saved password into this tab on the site it shows now? agent.js refuses
  // run_script there. Kept for the tab's life, not just the page: Back can bring the filled page back
  // from the back/forward cache with the password still in its field.
  const filledIn = (wc) => {
    const tab = wc && deps.tabOf(wc);
    const site = tab && !wc.isDestroyed() ? siteOf(wc.getURL()) : '';
    return Boolean(site && states.get(tab)?.filled.has(site));
  };

  // Fills one saved login into the tab, from the user's click. The site is checked again now: the tab
  // may have moved on since the menu opened.
  async function fillLogin(tab, id) {
    const v = verdictFor(tab);
    let entry = null;
    try { entry = vault.get(id); } catch {}
    if (!v.ok || !entry || entry.site !== v.site) return 'none';
    if (deps.outsideDriver?.()) {
      deps.notify?.(deps.t('passwords.driven'), deps.t('passwords.driven.detail'));
      return 'refused';
    }
    stateFor(tab).filled.add(v.site); // before the script runs: a run_script racing it is refused too
    try { return await run(tab, page.fill(entry.username, entry.password)); } catch { return 'none'; }
  }

  // The key button's menu: one "Fill" per saved login for this site, then Manage passwords.
  function fillItems(tab) {
    const v = verdictFor(tab);
    let logins = [];
    try { logins = v.ok ? vault.forSite(v.site) : []; } catch {}
    return logins.map((l) => ({
      label: deps.t('passwords.fillAs', { username: l.username || deps.t('passwords.noUsername') }),
      click: () => { fillLogin(tab, l.id); },
    }));
  }
  function menuTemplate(tab) {
    const items = fillItems(tab);
    if (items.length) items.push({ type: 'separator' });
    items.push({ label: deps.t('passwords.manage'), click: () => deps.openSettings('passwords') });
    return items;
  }

  // Right-click in a text field on a site with saved logins: the same Fill items.
  function contextMenuItems(tab, params) {
    if (!tab || !params?.isEditable) return [];
    const items = fillItems(tab);
    return items.length ? [...items, { type: 'separator' }] : [];
  }

  // The bar's buttons and the key button (UI_ONLY_IPC 'passwords:act').
  function act(tab, action) {
    if (!tab || !live(tab)) return;
    const st = stateFor(tab);
    const offer = st.offer;
    if (action === 'menu') { deps.popupMenu(menuTemplate(tab)); return; }
    st.offer = null;
    if (offer && action === 'save' && enabled()) {
      try { vault.upsert(offer); } catch (err) { deps.notify?.(deps.t('passwords.saveFailed'), err.message); }
    } else if (offer && action === 'never') {
      deps.writeSettings({ ...deps.readSettings(), passwordsNever: cleanNever([...never(), offer.site]) });
    }
    deps.sendTabs();
  }

  // Save passwords off: open pages stop watching, offers go.
  function stopAll() {
    for (const tab of deps.allTabs()) {
      const st = states.get(tab);
      if (!st) continue;
      st.offer = null;
      st.armed = 0;
      run(tab, page.STOP).catch(() => {});
    }
  }
  function armAll() { for (const tab of deps.allTabs()) if (live(tab) && !live(tab).isLoading()) arm(tab); }

  // ---- the settings page (settings:passwords-*) ----
  function settingsState() {
    let count = 0;
    let error = null;
    try { count = vault.count(); } catch (err) { error = err.message; }
    return { enabled: enabled(), unavailable: unavailable(), count, error, never: never() };
  }
  const listed = () => { try { return vault.list(); } catch { return []; } };

  async function setEnabled(on) {
    if (on) {
      const why = unavailable();
      if (why) return { ...settingsState(), refused: why };
      deps.writeSettings({ ...deps.readSettings(), savePasswords: true });
      armAll();
      deps.sendTabs();
      return settingsState();
    }
    deps.writeSettings({ ...deps.readSettings(), savePasswords: false });
    stopAll();
    deps.sendTabs();
    if (vault.exists()) {
      // Keep is the default (and what closing the dialog does).
      const answer = await deps.confirm({ message: deps.t('passwords.offDelete'), detail: deps.t('passwords.offDelete.detail'), buttons: [deps.t('passwords.keep'), deps.t('passwords.deleteAll')], defaultId: 0 });
      if (answer === 1) vault.clear();
    }
    return settingsState();
  }

  async function reveal(id) {
    const ok = await deps.reauth(deps.t('passwords.reauth.reveal'));
    if (!ok) return null;
    try { return vault.get(id)?.password ?? null; } catch { return null; }
  }

  async function copy(id) {
    const ok = await deps.reauth(deps.t('passwords.reauth.copy'));
    if (!ok) return false;
    let password = null;
    try { password = vault.get(id)?.password ?? null; } catch {}
    if (!password) return false;
    deps.clipboard.writeText(password);
    setTimeout(() => { try { if (deps.clipboard.readText() === password) deps.clipboard.clear(); } catch {} }, CLIPBOARD_MS).unref?.();
    return true;
  }

  async function deleteAll() {
    const answer = await deps.confirm({ message: deps.t('passwords.deleteAll.confirm'), detail: deps.t('passwords.deleteAll.detail'), buttons: [deps.t('dialog.cancel'), deps.t('passwords.deleteAll')], defaultId: 0 });
    if (answer === 1) vault.clear();
    return settingsState();
  }

  async function importFile() {
    if (unavailable()) return { error: 'unavailable' };
    const file = await deps.pickCsv();
    if (!file) return { cancelled: true };
    let text;
    try {
      if (fs.statSync(file).size > MAX_IMPORT_BYTES) return { error: 'too-big' };
      text = fs.readFileSync(file, 'utf8');
    } catch { return { error: 'unreadable' }; }
    const parsed = importCsv(text);
    if (parsed.error) return { error: parsed.error };
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    try {
      for (const login of parsed.logins) {
        const had = vault.find(login.site, login.username);
        if (had && had.password === login.password) { unchanged++; continue; }
        if (vault.upsert(login).created) added++; else updated++;
      }
    } catch (err) { return { error: 'save', message: err.message, added, updated }; }
    return { added, updated, unchanged, skipped: parsed.skipped };
  }

  // Every channel answers the settings page's own document only (deps.isSettingsSender), on top of
  // main.js's gate for settings:*. Inputs are checked here; ids are the vault's own. main.js registers
  // CHANNELS itself (so this module loads only once it's needed) and passes calls to invoke().
  const handlers = {
    'settings:passwords-state': () => settingsState(),
    'settings:passwords-set-enabled': (on) => setEnabled(on === true),
    'settings:passwords-list': () => listed(),
    'settings:passwords-reveal': (id) => (cleanId(id) ? reveal(id) : null),
    'settings:passwords-copy': (id) => (cleanId(id) ? copy(id) : false),
    'settings:passwords-update': (id, change) => {
      if (!cleanId(id) || !change || typeof change !== 'object') throw new Error('Invalid login');
      const next = {};
      if (change.username !== undefined) next.username = change.username;
      if (change.password !== undefined) next.password = change.password;
      vault.update(id, next);
      return listed();
    },
    'settings:passwords-delete': (id) => { if (cleanId(id)) vault.remove(id); return listed(); },
    'settings:passwords-delete-all': () => deleteAll(),
    'settings:passwords-import': () => importFile(),
    'settings:passwords-never-remove': (site) => {
      if (!validSite(site)) return settingsState();
      deps.writeSettings({ ...deps.readSettings(), passwordsNever: never().filter((s) => s !== site) });
      return settingsState();
    },
  };
  function invoke(channel, event, ...args) {
    if (!Object.hasOwn(handlers, channel) || !deps.isSettingsSender(event)) throw new Error('Not allowed');
    return handlers[channel](...args);
  }
  const register = (ipcMain) => { for (const channel of Object.keys(handlers)) ipcMain.handle(channel, (event, ...args) => invoke(channel, event, ...args)); };

  return { attach, stateOf, act, filledIn, contextMenuItems, fillLogin, register, invoke, channels: () => Object.keys(handlers), setEnabled, settingsState, unavailable, enabled, vault };
}

module.exports = {
  createPasswords, createVault, verdict, siteOf, validSite, cleanNever, cleanEntries, cleanUsername, cleanPassword, parseCsv, importCsv,
  FILE_NAME, MAX_ENTRIES, MAX_PASSWORD, MAX_USERNAME,
};
