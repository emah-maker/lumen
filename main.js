const { app, BrowserWindow, WebContentsView, ipcMain, Menu, clipboard, dialog, nativeTheme, net, safeStorage, session, shell } = require('electron');

// `Lumen --mcp`: an AI agent (Claude Code, Codex, Gemini CLI…) started us as its MCP server. Run
// only the stdio bridge, before loading anything else (no window, no lock, nothing on stdout).
if (process.argv.includes('--mcp')) {
  if (process.env.CLAUDE_BROWSER_TEST && process.env.CLAUDE_BROWSER_PROFILE) app.setPath('userData', process.env.CLAUDE_BROWSER_PROFILE);
  require('./mcp').runBridge({ app });
  return;
}
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const Anthropic = require('@anthropic-ai/sdk');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { installChromeWebStore, installExtension, uninstallExtension } = require('electron-chrome-web-store');
const { Agent, normalizeUrl, MODELS, DEFAULT_MODEL, EXTERNAL_TOOLS, validateInput: validateToolInput } = require('./agent');
const providers = require('./providers');
const { SEARCH_ENGINES, DEFAULT_ENGINE, engineFor, searchUrlFor } = require('./search');
// Optional features load on first use (startup stays lean).
const lazy = (load) => { let mod; return new Proxy({}, { get: (_t, key) => (mod ||= load())[key] }); };
const importer = lazy(() => require('./importer'));
const cliAuth = lazy(() => require('./cli-auth'));
const { createTabGroups, siteName } = require('./tab-groups');

const NEW_TAB_URL = pathToFileURL(path.join(__dirname, 'renderer', 'newtab.html')).href;
const isNewTab = (url) => url.startsWith(NEW_TAB_URL);
const HISTORY_URL = pathToFileURL(path.join(__dirname, 'renderer', 'history.html')).href;
const isInternal = (url) => isNewTab(url) || url.startsWith(HISTORY_URL);
const ERROR_URL = pathToFileURL(path.join(__dirname, 'renderer', 'error.html')).href;
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const isWebUrl = (url) => /^https?:\/\//i.test(url);

// Look like stock Chrome; sites (notably Google) treat unknown browser tokens as bots.
const UA_PLATFORM = { win32: 'Windows NT 10.0; Win64; x64', darwin: 'Macintosh; Intel Mac OS X 10_15_7' }[process.platform] || 'X11; Linux x86_64';
app.userAgentFallback = `Mozilla/5.0 (${UA_PLATFORM}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`;

// Test runs get a throwaway profile so they never touch the real session or key.
const APP_ID = 'com.lumen.browser';

// Lumen was "Claude Browser": carry the old profile (settings, history, bookmarks, extensions,
// saved chat) over to the new name once, before anything opens it.
if (!process.env.CLAUDE_BROWSER_TEST) {
  const oldProfile = path.join(app.getPath('appData'), 'Claude Browser');
  const newProfile = app.getPath('userData');
  if (!fs.existsSync(newProfile) && fs.existsSync(oldProfile)) {
    try {
      fs.renameSync(oldProfile, newProfile);
    } catch {
      try { fs.cpSync(oldProfile, newProfile, { recursive: true }); } catch {}
    }
  }
}
if (process.platform === 'win32') app.setAppUserModelId(APP_ID); // taskbar grouping, notifications

if (process.env.CLAUDE_BROWSER_TEST) {
  app.setPath('userData', process.env.CLAUDE_BROWSER_PROFILE || fs.mkdtempSync(path.join(require('os').tmpdir(), 'claude-browser-test-')));
}


let win;
const ui = () => (win && !win.isDestroyed() ? win.webContents : null); // null once the window is gone
let tabs = []; // { id, view, favicon }
let activeId = null;
let nextTabId = 1;
let contentBounds = { x: 0, y: 0, width: 800, height: 600 };
const closedTabs = []; // URLs, most recent last

// ---------- settings / API key ----------

let settingsCache = null;

function readSettings() {
  if (!settingsCache) {
    try {
      settingsCache = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
    } catch {
      settingsCache = {};
    }
  }
  return { ...settingsCache };
}

function writeSettings(settings) {
  settingsCache = { ...settings };
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
}

function storedApiKey() {
  const { apiKeyEnc } = readSettings();
  if (!apiKeyEnc || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(apiKeyEnc, 'base64'));
  } catch {
    return null;
  }
}

// Keys for OpenAI, Grok and Gemini: settings.keys[provider], encrypted like the Anthropic key.
const ENV_KEYS = { openai: 'OPENAI_API_KEY', xai: 'XAI_API_KEY', gemini: 'GEMINI_API_KEY' };

function providerKey(provider) {
  const enc = readSettings().keys?.[provider];
  if (enc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      // Unreadable (e.g. copied from another machine): fall through to the environment.
    }
  }
  return process.env[ENV_KEYS[provider]] || null;
}

const providerModels = {}; // provider -> model ids the key can use (filled after a key is saved)

async function refreshModels(provider) {
  const key = providerKey(provider);
  if (!key) {
    delete providerModels[provider];
  } else {
    providerModels[provider] = await providers.listModels(provider, key);
  }
  ui()?.send('models-updated');
}

// The picker: Claude models always; other providers once they have a key.
function modelOptions() {
  const options = Object.entries(MODELS).map(([id, { label, detail }]) => ({ id, label, detail, group: 'Claude' }));
  for (const [provider, info] of Object.entries(providers.PROVIDERS)) {
    if (!providerKey(provider)) continue;
    for (const model of providerModels[provider] || info.defaults) {
      options.push({ id: `${provider}:${model}`, label: model, detail: `${info.label} · ${model}`, group: info.label });
    }
  }
  return options;
}

let client = null;
function getClient() {
  if (client) return client;
  const apiKey = storedApiKey();
  try {
    // With no stored key, the SDK falls back to ANTHROPIC_API_KEY or an `ant auth login` profile.
    client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  } catch {
    throw new Error('No API key found. Add your Anthropic API key, or sign in with your Anthropic account in settings.');
  }
  return client;
}

// ---------- permissions: ask like Safari, remember per origin for the session ----------

const ALWAYS_ALLOWED = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);
const PROMPTABLE = {
  media: 'use your camera and microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  'clipboard-read': 'read your clipboard',
};
const permissionDecisions = new Map(); // `${origin}|${permission}` -> boolean

function setupPermissions() {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    if (ALWAYS_ALLOWED.has(permission)) return callback(true);
    const reason = PROMPTABLE[permission];
    let origin;
    try {
      origin = new URL(details.requestingUrl || wc.getURL()).origin;
    } catch {
      return callback(false);
    }
    if (!reason || !isWebUrl(origin)) return callback(false);
    const key = `${origin}|${permission}`;
    if (permissionDecisions.has(key)) return callback(permissionDecisions.get(key));
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ["Don't Allow", 'Allow'],
      defaultId: 0,
      cancelId: 0,
      message: `Allow ${new URL(origin).host} to ${reason}?`,
    });
    permissionDecisions.set(key, response === 1);
    callback(response === 1);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) =>
    ALWAYS_ALLOWED.has(permission) || permissionDecisions.get(`${origin}|${permission}`) === true);
}

// ---------- Chrome extensions (installed from the Chrome Web Store) ----------

let extensions = null;
// A tab whose page was destroyed (e.g. it called window.close()) has no webContents any more.
const alive = (tab) => Boolean(tab?.view?.webContents) && !tab.view.webContents.isDestroyed();
const tabByContents = (wc) => tabs.find((t) => alive(t) && t.view.webContents === wc);
// The extension library reports every newly added tab as activated; ignore those echoes so
// background tabs stay in the background and our own switches don't loop back.
// Tab groups share the tabs array; grouped tabs are kept contiguous by tabGroups.arrange().
const tabGroups = createTabGroups({
  getTabs: () => tabs,
  setTabs: (list) => { tabs = list; },
  urlOf: (t) => (alive(t) ? realUrl(t.view.webContents) : ''),
  titleOf: (t) => (alive(t) ? t.view.webContents.getTitle() : ''),
  isWeb: (url) => isWebUrl(url),
  isAuto: () => readSettings().autoGroupTabs !== false,
});
let autoGroupTimer = null;
function scheduleAutoGroup() {
  clearTimeout(autoGroupTimer);
  autoGroupTimer = setTimeout(() => { if (tabGroups.autoGroup()) sendTabs(); }, 400); // after the title usually arrives
}

let ignoreExtensionSelect = false;
function syncExtensions(fn) {
  ignoreExtensionSelect = true;
  try { fn(); } finally { ignoreExtensionSelect = false; }
}

// ---------- ad blocker (built into the browser, uBlock Origin-compatible lists) ----------
//
// Runs in the main process, so there is no extension for sites to fingerprint. Cosmetic rules go
// in as user-origin CSS (invisible to document.styleSheets), and uBlock's scriptlets neutralize
// known anti-adblock scripts. Blocked requests are cancelled: Chromium refuses redirects to data:
// stand-ins, so a determined site can still notice a failed ad request.

let blocker = null;
const blockedCount = new Map(); // webContents id -> requests blocked on the current page

const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
};

function adblockSettings() {
  const { adblock = true, adblockAllow = [] } = readSettings();
  return { enabled: adblock, allow: new Set(adblockAllow) };
}

function adblockOn(pageUrl) {
  const { enabled, allow } = adblockSettings();
  return enabled && !allow.has(hostOf(pageUrl));
}

async function setupAdblock() {
  const { ElectronBlocker } = require('@ghostery/adblocker-electron');
  blocker = await ElectronBlocker.fromPrebuiltFull(fetch, {
    path: path.join(app.getPath('userData'), 'adblock-engine.bin'),
    read: fs.promises.readFile,
    write: fs.promises.writeFile,
  });
  const match = blocker.onBeforeRequest;
  blocker.onBeforeRequest = (details, callback) => {
    const page = details.webContents?.getURL() || details.referrer || '';
    if (!adblockOn(page)) return callback({});
    match(details, (result) => {
      if (!result.cancel && !result.redirectURL) return callback(result);
      const id = details.webContents?.id;
      if (id !== undefined) blockedCount.set(id, (blockedCount.get(id) || 0) + 1);
      callback(result);
    });
  };
  const cosmetics = blocker.onInjectCosmeticFilters;
  blocker.onInjectCosmeticFilters = async (event, url, msg) => (adblockOn(url) ? cosmetics(event, url, msg) : undefined);
  const headers = blocker.onHeadersReceived;
  blocker.onHeadersReceived = (details, callback) =>
    (adblockOn(details.webContents?.getURL() || details.url) ? headers(details, callback) : callback({}));
  blocker.enableBlockingInSession(session.defaultSession);
}

function adblockMenu() {
  const wc = activeTab()?.webContents;
  const host = wc ? hostOf(realUrl(wc)) : '';
  const { enabled, allow } = adblockSettings();
  const save = (patch) => {
    writeSettings({ ...readSettings(), ...patch });
    wc?.reload();
  };
  const count = wc ? blockedCount.get(wc.id) || 0 : 0;
  return [
    { label: blocker ? `${count} blocked on this page` : 'Loading filter lists…', enabled: false },
    { type: 'separator' },
    { label: 'Block Ads and Trackers', type: 'checkbox', checked: enabled, click: () => save({ adblock: !enabled }) },
    ...(host && isWebUrl(realUrl(wc))
      ? [{
          label: `Allow Ads on ${host}`,
          type: 'checkbox',
          checked: allow.has(host),
          enabled,
          click: () => {
            if (allow.has(host)) allow.delete(host);
            else allow.add(host);
            save({ adblockAllow: [...allow] });
          },
        }]
      : []),
  ];
}

async function setupExtensions() {
  const ses = session.defaultSession;
  ElectronChromeExtensions.handleCRXProtocol(ses); // extension icons in the toolbar
  extensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: ses,
    createTab: async (details) => {
      const tab = openTab(details.url || undefined, { background: details.active === false });
      return [tab.webContents, win];
    },
    selectTab: (wc) => { if (ignoreExtensionSelect) return; const tab = tabByContents(wc); if (tab) switchTab(tab.id); },
    removeTab: (wc) => { const tab = tabByContents(wc); if (tab) closeTab(tab.id); },
    // Single-window browser: new windows become tabs.
    createWindow: async (details) => {
      [].concat(details.url || []).forEach((url) => openTab(url));
      return win;
    },
    removeWindow: () => {},
  });
  extensions.on('browser-action-popup-created', (popup) => {
    const place = popup.updatePosition.bind(popup);
    popup.updatePosition = () => {
      place();
      const view = popup.browserWindow;
      if (!view || view.isDestroyed() || !win || win.isDestroyed()) return;
      const b = view.getBounds();
      const w = win.getBounds();
      const x = Math.max(w.x + 8, Math.min(b.x, w.x + w.width - b.width - 8));
      if (x !== b.x) view.setBounds({ ...b, x });
    };
    popup.whenReady().then(() => setTimeout(async () => {
      if (popup.isDestroyed() || !popup.hidden || !popup.browserWindow) return;
      const size = await popup.browserWindow.webContents.executeJavaScript(
        '(() => { const d = document.documentElement; return { width: Math.max(d.scrollWidth, document.body ? document.body.scrollWidth : 0), height: Math.max(d.scrollHeight, document.body ? document.body.scrollHeight : 0) }; })()',
      ).catch(() => null);
      if (popup.isDestroyed()) return;
      popup.setSize(size && size.width > 40 && size.height > 40 ? size : { width: 360, height: 480 });
      popup.updatePosition();
      popup.show();
    }, 700));
  });
  await installChromeWebStore({
    session: ses,
    beforeInstall: async ({ localizedName, manifest }) => {
      if ((manifest.permissions || []).some((p) => String(p).startsWith('declarativeNetRequest'))) {
        await dialog.showMessageBox(win, {
          type: 'info',
          message: `“${localizedName}” can't be added`,
          detail: 'It filters pages with a Chrome feature (declarativeNetRequest) that Lumen does not support yet. For ad and tracker blocking, use the built-in blocker in ⋯ → Ad Blocker.',
        });
        return { action: 'deny' };
      }
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Cancel', 'Add Extension'],
        defaultId: 1,
        cancelId: 0,
        message: `Add “${localizedName}”?`,
        detail: 'Extensions can read and change data on the websites you visit.',
      });
      return { action: response === 1 ? 'allow' : 'deny' };
    },
  });
}

function extensionsMenu() {
  const installed = session.defaultSession.extensions.getAllExtensions()
    .filter((ext) => ext.manifest.name && !ext.id.startsWith('chrome-web-store'));
  const items = installed.map((ext) => ({
    label: ext.name,
    submenu: [
      ...(ext.manifest.options_page || ext.manifest.options_ui
        ? [{ label: 'Options', click: () => openTab(`chrome-extension://${ext.id}/${ext.manifest.options_ui?.page || ext.manifest.options_page}`) }]
        : []),
      {
        label: 'Remove',
        click: async () => {
          const { response } = await dialog.showMessageBox(win, {
            type: 'question', buttons: ['Cancel', 'Remove'], defaultId: 1, cancelId: 0, message: `Remove “${ext.name}”?`,
          });
          if (response === 1) await uninstallExtension(ext.id, { session: session.defaultSession }).catch(() => {});
        },
      },
    ],
  }));
  if (items.length) items.push({ type: 'separator' });
  items.push({ label: 'Get Extensions…', click: () => openTab('https://chromewebstore.google.com/') });
  return items;
}

function showAppMenu({ x, y }) {
  const wc = activeTab()?.webContents;
  Menu.buildFromTemplate([
    { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => { openTab(); focusAddress(); } },
    { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', enabled: closedTabs.length > 0, click: () => openTab(closedTabs.pop()) },
    { type: 'separator' },
    { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => { ui()?.focus(); ui()?.send('find:open'); } },
    { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => zoomBy(wc, 0.5) },
    { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoomBy(wc, -0.5) },
    { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => zoomBy(wc, 0) },
    { type: 'separator' },
    { label: 'Bookmarks', submenu: bookmarksMenu() },
    { label: 'History', submenu: historyMenu() },
    { label: 'Downloads', submenu: downloadsMenu() },
    { type: 'separator' },
    { label: 'Tab Groups', submenu: tabGroupsMenu() },
    { label: 'Search Engine', submenu: searchEngineMenu() },
    { label: 'Import Bookmarks and History', submenu: importMenu() },
    { label: 'Ad Blocker', submenu: adblockMenu() },
    { label: 'Extensions', submenu: extensionsMenu() },
    { label: 'Claude Settings…', click: () => ui()?.send('open-settings') },
    { type: 'separator' },
    { label: 'Developer Tools', accelerator: 'F12', click: () => wc?.toggleDevTools() },
  ]).popup({ window: win, x: Math.round(x), y: Math.round(y) });
}

// ---------- history & address bar suggestions ----------

const HISTORY_FILE = () => path.join(app.getPath('userData'), 'history.json');
const SEED_SITES = [
  ['https://www.google.com/', 'Google'], ['https://www.youtube.com/', 'YouTube'], ['https://mail.google.com/', 'Gmail'],
  ['https://www.wikipedia.org/', 'Wikipedia'], ['https://github.com/', 'GitHub'], ['https://www.reddit.com/', 'Reddit'],
  ['https://www.amazon.com/', 'Amazon'], ['https://news.google.com/', 'Google News'],
];
let history = new Map(); // url -> { url, title, visits, last }
let historySaveTimer = null;

function loadHistory() {
  try {
    // Older builds recorded sign-in and token URLs; drop them on load.
    history = new Map(JSON.parse(fs.readFileSync(HISTORY_FILE(), 'utf8')).filter((h) => importer.isWorthImporting(h.url)).map((h) => [h.url, h]));
  } catch {
    history = new Map();
  }
}

function saveHistorySoon() {
  clearTimeout(historySaveTimer);
  historySaveTimer = setTimeout(() => {
    const entries = [...history.values()].sort((a, b) => b.last - a.last).slice(0, 5000);
    fs.writeFile(HISTORY_FILE(), JSON.stringify(entries), () => {});
  }, 2000);
}

const isCaptchaPage = (url) => /^https?:\/\/(www\.)?google\.[a-z.]+\/sorry\//i.test(url);

function recordVisit(url, title) {
  if (!isWebUrl(url) || isCaptchaPage(url) || !importer.isWorthImporting(url)) return; // same filter as imports
  const entry = history.get(url) || { url, title: '', visits: 0, last: 0 };
  entry.visits += 1;
  entry.last = Date.now();
  if (title) entry.title = title;
  history.set(url, entry);
  saveHistorySoon();
}

function updateTitle(url, title) {
  const entry = history.get(url);
  if (entry && title) {
    entry.title = title;
    saveHistorySoon();
  }
}

const bareUrl = (url) => url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');

function suggestions(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const candidates = new Map(SEED_SITES.map(([url, title]) => [url, { url, title, visits: 0, last: 0 }]));
  for (const entry of history.values()) candidates.set(entry.url, entry);
  const scored = [];
  for (const entry of candidates.values()) {
    if (entry.url.length > 300) continue; // long links stay in History but make poor suggestions
    const bare = bareUrl(entry.url).toLowerCase();
    // Match the host and path only: query strings are noise (and can hold tokens).
    const hostPath = bare.split(/[?#]/)[0];
    let rank = 0;
    if (hostPath.startsWith(q)) rank = 3;
    else if (hostPath.includes(q)) rank = 2;
    else if (entry.title.toLowerCase().includes(q)) rank = 1;
    if (rank) scored.push({ entry, score: rank * 1e6 + entry.visits * 1e3 - bare.length + entry.last / 1e13 });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 5).map(({ entry }) => ({ url: entry.url, title: entry.title }));
}

// The dropdown is its own view so it can draw over the page.
let suggestView = null;

function showSuggestions(rect, payload) {
  if (!suggestView) {
    suggestView = new WebContentsView({
      webPreferences: { preload: path.join(__dirname, 'suggest-preload.js'), sandbox: true, contextIsolation: true },
    });
    suggestView.setBackgroundColor('#00000000');
    suggestView.webContents.loadFile(path.join(__dirname, 'renderer', 'suggest.html'));
  }
  win.contentView.addChildView(suggestView); // re-adding moves it to the top
  suggestView.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
  suggestView.setVisible(true);
  const send = () => suggestView.webContents.send('suggest:items', payload);
  if (suggestView.webContents.isLoading()) suggestView.webContents.once('did-finish-load', send);
  else send();
}

function hideSuggestions() {
  if (suggestView) suggestView.setVisible(false);
}

// ---------- tabs ----------

// The URL a tab is "really" on: error pages report the address that failed.
function realUrl(wc) {
  const url = wc.getURL();
  if (url.startsWith(ERROR_URL)) return new URL(url).searchParams.get('url') || '';
  return url;
}

function tabState() {
  const active = activeTab();
  const history = active?.webContents.navigationHistory;
  return {
    groups: tabGroups.state(),
    tabs: tabs.filter(alive).map(({ id, view, favicon, groupId }) => {
      const wc = view.webContents;
      const url = realUrl(wc);
      return {
        id,
        title: wc.getTitle() || 'New Tab',
        url: isInternal(url) ? '' : url,
        loading: wc.isLoading(),
        favicon: favicon || null,
        error: wc.getURL().startsWith(ERROR_URL),
        zoom: Math.round(wc.getZoomFactor() * 100),
        bookmarked: isWebUrl(url) && bookmarks().some((b) => b.url === url),
        groupId: groupId || null,
      };
    }),
    activeId,
    canGoBack: history ? history.canGoBack() : false,
    canGoForward: history ? history.canGoForward() : false,
  };
}

let sessionTimer = null;
function sendTabs() {
  ui()?.send('tabs', tabState());
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => { if (win && !win.isDestroyed()) saveSession(); }, 3000);
}

function activeTab() {
  const tab = tabs.find((t) => t.id === activeId);
  return alive(tab) ? { id: tab.id, webContents: tab.view.webContents } : null;
}

// While the sidebar animates, the page is shown as a snapshot in the UI and the live view is
// hidden (and resized once, out of sight), so the site never reflows during the animation.
let viewFrozen = false;

function layout() {
  layoutWebPanels();
  for (const tab of tabs.filter(alive)) {
    const visible = tab.id === activeId;
    tab.view.setVisible(visible && !viewFrozen);
    if (!visible) continue;
    if (tab.fullscreen) {
      const [width, height] = win.getContentSize();
      tab.view.setBounds({ x: 0, y: 0, width, height });
    } else {
      tab.view.setBounds(contentBounds);
    }
  }
}

function openTab(url = newTabUrl(), { background = false, openerId = null, groupId = null } = {}) {
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const id = nextTabId++;
  const tab = { id, view, favicon: null, groupId: null, userRemoved: false };
  tabs.push(tab);
  win.contentView.addChildView(view);
  view.setVisible(false);

  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url: target, disposition }) => {
    if (!(isWebUrl(target) || target === 'about:blank' || target.startsWith('chrome-extension://'))) return { action: 'deny' };
    if (disposition === 'new-window') {
      // A real popup (sign-in, payment): it keeps window.opener so it can report back to the page.
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
          icon: path.join(__dirname, 'assets', 'icon.png'),
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    openTab(target, { background: disposition === 'background-tab', openerId: id });
    return { action: 'deny' };
  });
  wc.on('enter-html-full-screen', () => { tab.fullscreen = true; layout(); });
  wc.on('leave-html-full-screen', () => { tab.fullscreen = false; layout(); });
  wc.on('zoom-changed', (_e, direction) => {
    zoomBy(wc, direction === 'in' ? 0.5 : -0.5);
  });
  wc.on('page-favicon-updated', (_e, favicons) => {
    tab.favicon = favicons[0];
    sendTabs();
    if (favicons[0]) cacheFavicon(wc.getURL(), favicons[0]);
  });
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) tab.favicon = null;
  });
  wc.on('did-fail-load', (_e, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = aborted, e.g. the user navigated away
    const params = new URLSearchParams({ url: failedUrl, code: String(code), desc: description });
    wc.loadURL(`${ERROR_URL}?${params}`).catch(() => {});
  });
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) blockedCount.set(wc.id, 0);
  });
  wc.on('did-navigate', (_e, url) => {
    // The error page replaces the failed entry, so Back skips past it.
    if (url.startsWith(ERROR_URL)) {
      const history = wc.navigationHistory;
      const failed = history.getActiveIndex() - 1;
      if (failed >= 0 && history.getEntryAtIndex(failed)?.url === realUrl(wc)) history.removeEntryAtIndex(failed);
      sendTabs();
      return;
    }
    recordVisit(url, wc.getTitle());
    scheduleAutoGroup();
  });
  wc.on('page-title-updated', (_e, title) => updateTitle(wc.getURL(), title));
  wc.on('found-in-page', (_e, result) => {
    if (tab.id === activeId) ui()?.send('find:result', result);
  });
  wc.on('context-menu', (_e, params) => showContextMenu(wc, params));
  for (const event of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page']) {
    wc.on(event, sendTabs);
  }
  wc.on('before-input-event', (event, input) => handleShortcut(event, input));

  // If the page closes itself, drop the tab instead of keeping a dead one around.
  wc.once('destroyed', () => closeTab(id, { destroyed: true }));

  if (openerId) tabGroups.joinOpener(tab, tabs.find((t) => t.id === openerId));
  else if (groupId) tabGroups.add(id, groupId);

  applyChromeIdentity(wc);
  syncExtensions(() => extensions?.addTab(wc, win));
  wc.loadURL(url).catch(() => {});
  if (background) {
    const current = activeTab();
    if (current) syncExtensions(() => extensions?.selectTab(current.webContents));
    sendTabs();
  } else {
    switchTab(id);
  }
  return { id, webContents: wc };
}

function switchTab(id) {
  if (!tabs.some((t) => t.id === id)) return false;
  if (id !== activeId) activeTab()?.webContents.stopFindInPage('clearSelection');
  activeId = id;
  const current = activeTab();
  if (current) syncExtensions(() => extensions?.selectTab(current.webContents));
  layout();
  sendTabs();
  return true;
}

function closeTab(id, { destroyed = false } = {}) {
  const index = tabs.findIndex((t) => t.id === id);
  if (index === -1) return;
  const [tab] = tabs.splice(index, 1);
  tabGroups.cleanup();
  if (alive(tab)) {
    const url = realUrl(tab.view.webContents);
    if (url && !isInternal(url)) closedTabs.push(url);
  }
  if (!win || win.isDestroyed()) return; // the app is quitting
  win.contentView.removeChildView(tab.view);
  if (!destroyed && alive(tab)) tab.view.webContents.close();
  if (tabs.length === 0) {
    openTab();
    return;
  }
  if (activeId === id) switchTab(tabs[Math.min(index, tabs.length - 1)].id);
  else sendTabs();
}

function listTabs() {
  return tabs.filter(alive).map(({ id, view }) => ({
    id,
    title: view.webContents.getTitle(),
    url: realUrl(view.webContents),
    active: id === activeId,
    group: tabs.find((t) => t.id === id)?.groupId ? tabGroups.groups.get(tabs.find((t) => t.id === id).groupId)?.name || null : null,
  }));
}

// Omnibox input: URLs load directly, everything else becomes a search.
function resolveInput(text) {
  const value = text.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^about:/i.test(value)) return value;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/|$)/i.test(value)) return normalizeUrl(value);
  if (!/\s/.test(value) && /^[^\s/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(value)) return normalizeUrl(value);
  return searchUrlFor(readSettings().searchEngine, value);
}

function zoomBy(wc, step) {
  if (!wc) return;
  wc.setZoomLevel(step === 0 ? 0 : Math.min(Math.max(wc.getZoomLevel() + step, -3), 5));
  sendTabs();
}

// ---------- tab groups: menus and "Organize Tabs with AI" ----------

const ORGANIZE_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, tab_ids: { type: 'array', items: { type: 'integer' } } },
        required: ['name', 'tab_ids'],
        additionalProperties: false,
      },
    },
  },
  required: ['groups'],
  additionalProperties: false,
};
const ORGANIZE_PROMPT = 'Group these browser tabs by topic or task. Give each group a short name (1-3 words, Title Case). A tab belongs to at most one group; leave out tabs that fit nowhere. Use only the ids given. Reply with JSON: {"groups":[{"name":"...","tab_ids":[1,2]}]}.';

// Asks the chat's current model for groups. Only ids, titles and hostnames are sent.
async function proposeGroups(model, list) {
  const { provider, model: id } = providers.splitModel(model);
  if (provider === 'anthropic') {
    const res = await agent.getClient().messages.create({
      model: id,
      max_tokens: 2000,
      output_config: { format: { type: 'json_schema', schema: ORGANIZE_SCHEMA } },
      messages: [{ role: 'user', content: `${ORGANIZE_PROMPT}\n\nTabs:\n${JSON.stringify(list)}` }],
    });
    if (res.stop_reason === 'refusal') throw new Error('The model declined to organize these tabs.');
    return JSON.parse(res.content.filter((b) => b.type === 'text').map((b) => b.text).join('')).groups;
  }
  const apiKey = providerKey(provider);
  if (!apiKey) throw new Error(`Add your ${providers.PROVIDERS[provider].label} API key in Claude settings first.`);
  return (await providers.completeJSON({ provider, model: id, apiKey, system: ORGANIZE_PROMPT, user: `Tabs:\n${JSON.stringify(list)}` })).groups;
}

let organizing = false;
async function organizeTabs() {
  if (organizing) return;
  organizing = true;
  ui()?.send('tabs:organizing', true);
  try {
    const list = tabs.filter((t) => alive(t) && isWebUrl(realUrl(t.view.webContents)))
      .map((t) => ({ id: t.id, title: t.view.webContents.getTitle().slice(0, 120), host: hostOf(realUrl(t.view.webContents)) }));
    if (list.length < 2) throw new Error('Open a few pages first; there is nothing to organize yet.');
    const model = agent.messages.settings?.model || readSettings().model || DEFAULT_MODEL;
    const count = tabGroups.applyProposal(await proposeGroups(model, list));
    sendTabs();
    if (!count && win && !win.isDestroyed()) {
      await dialog.showMessageBox(win, { type: 'info', message: 'No groups suggested', detail: 'These tabs look unrelated, so they were left as they are.' });
    }
  } catch (err) {
    const detail = err instanceof Anthropic.AuthenticationError ? 'Your Anthropic API key was rejected. Check it in Claude settings.' : err.message;
    if (win && !win.isDestroyed()) await dialog.showMessageBox(win, { type: 'warning', message: "Couldn't organize tabs", detail });
  } finally {
    organizing = false;
    ui()?.send('tabs:organizing', false);
  }
}

const colorLabel = (c) => c.charAt(0).toUpperCase() + c.slice(1);

function tabMenu(id, { x, y }) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  const others = tabGroups.state().filter((g) => g.id !== tab.groupId);
  const items = [{
    label: 'Add to New Group',
    click: () => {
      if (tab.groupId) tabGroups.remove(id, { byUser: true });
      const url = alive(tab) ? realUrl(tab.view.webContents) : '';
      const group = tabGroups.create(isWebUrl(url) ? siteName(url, tab.view.webContents.getTitle()) : 'New Group', [id]);
      sendTabs();
      ui()?.send('group:rename-start', group.id);
    },
  }];
  if (others.length) items.push({ label: 'Add to Group', submenu: others.map((g) => ({ label: g.name, click: () => { tabGroups.add(id, g.id); sendTabs(); } })) });
  if (tab.groupId) items.push({ label: 'Remove from Group', click: () => { tabGroups.remove(id, { byUser: true }); sendTabs(); } });
  items.push({ type: 'separator' }, { label: 'Close Tab', click: () => closeTab(id) });
  Menu.buildFromTemplate(items).popup({ window: win, x: Math.round(x), y: Math.round(y) });
}

function groupMenu(groupId, { x, y }) {
  const group = tabGroups.groups.get(groupId);
  if (!group) return;
  Menu.buildFromTemplate([
    { label: 'Rename…', click: () => ui()?.send('group:rename-start', groupId) },
    { label: 'Colour', submenu: tabGroups.GROUP_COLORS.map((c) => ({ label: colorLabel(c), type: 'radio', checked: group.color === c, click: () => { group.color = c; sendTabs(); } })) },
    { label: 'New Tab in Group', click: () => { openTab(undefined, { groupId }); focusAddress(); } },
    { type: 'separator' },
    { label: 'Ungroup', click: () => { tabGroups.ungroupAll(groupId); sendTabs(); } },
    { label: 'Close Group', click: () => tabGroups.members(groupId).map((t) => t.id).forEach((id) => closeTab(id)) },
  ]).popup({ window: win, x: Math.round(x), y: Math.round(y) });
}

function tabGroupsMenu() {
  return [
    { label: 'Organize Tabs with AI', enabled: !organizing, click: organizeTabs },
    { label: 'Automatic Tab Groups', type: 'checkbox', checked: readSettings().autoGroupTabs !== false, click: (item) => setAutoGroup(item.checked) },
  ];
}

function setAutoGroup(on) {
  writeSettings({ ...readSettings(), autoGroupTabs: Boolean(on) });
  if (on && tabGroups.autoGroup()) sendTabs();
  return true;
}

// ---------- search engine ----------

function setSearchEngine(id) {
  if (!SEARCH_ENGINES[id]) return false;
  writeSettings({ ...readSettings(), searchEngine: id });
  ui()?.send('search-engine', engineFor(id));
  return true;
}

function searchEngineMenu() {
  const current = readSettings().searchEngine || DEFAULT_ENGINE;
  return Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ label: e.label, type: 'radio', checked: id === current, click: () => setSearchEngine(id) }));
}

// ---------- import from other browsers ----------

// Merges another browser's bookmarks and history. Returns counts of what was new.
function importBrowser(id, profilePath) {
  const data = importer.readBrowser(id, profilePath);
  const list = bookmarks();
  const known = new Set(list.map((b) => b.url));
  let addedBookmarks = 0;
  for (const b of data.bookmarks) {
    if (known.has(b.url)) continue;
    known.add(b.url);
    list.push({ url: b.url, title: b.title || hostOf(b.url), ...(b.folder ? { folder: b.folder } : {}) });
    addedBookmarks++;
  }
  writeSettings({ ...readSettings(), bookmarks: list });
  let addedHistory = 0;
  for (const h of data.history) {
    if (isCaptchaPage(h.url)) continue;
    const entry = history.get(h.url);
    if (entry) {
      entry.visits = Math.max(entry.visits, h.visits);
      entry.last = Math.max(entry.last, h.last);
      if (!entry.title && h.title) entry.title = h.title;
    } else {
      history.set(h.url, { url: h.url, title: h.title, visits: h.visits, last: h.last });
      addedHistory++;
    }
  }
  saveHistorySoon();
  sendTabs();
  return { label: data.label, bookmarks: addedBookmarks, history: addedHistory };
}

async function runImport(id) {
  try {
    const result = importBrowser(id);
    await dialog.showMessageBox(win, {
      type: 'info',
      message: `Imported from ${result.label}`,
      detail: `${result.bookmarks} bookmark${result.bookmarks === 1 ? '' : 's'} and ${result.history.toLocaleString()} history entr${result.history === 1 ? 'y' : 'ies'} added. Passwords and cookies are not imported.`,
    });
  } catch (err) {
    await dialog.showMessageBox(win, { type: 'warning', message: 'Import failed', detail: err.message });
  }
}

function importMenu() {
  const found = importer.detectBrowsers();
  if (!found.length) return [{ label: 'No other browsers found', enabled: false }];
  return found.map((b) => ({ label: b.label, click: () => runImport(b.id) }));
}

// ---------- history menu ----------

function openHistoryPage() {
  const entries = [...history.values()].sort((a, b) => b.last - a.last).slice(0, 2000).map(({ url, title, last }) => ({ url, title, last }));
  openTab(`${HISTORY_URL}#${encodeURIComponent(JSON.stringify(entries))}`);
}

function historyMenu() {
  const recent = [...history.values()].sort((a, b) => b.last - a.last).slice(0, 15);
  if (!recent.length) return [{ label: 'No history yet', enabled: false }];
  return [
    { label: 'Show All History', accelerator: 'CmdOrCtrl+H', click: openHistoryPage },
    { type: 'separator' },
    ...recent.map((h) => ({ label: (h.title || bareUrl(h.url)).slice(0, 60), click: () => openTab(h.url) })),
    { type: 'separator' },
    {
      label: 'Clear History…',
      click: async () => {
        const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: ['Cancel', 'Clear'], defaultId: 1, cancelId: 0, message: 'Clear browsing history?', detail: 'Removes visited pages and address bar suggestions. Bookmarks stay.' });
        if (response !== 1) return;
        history.clear();
        fs.rm(HISTORY_FILE(), { force: true }, () => {});
      },
    },
  ];
}

// ---------- bookmarks ----------

function bookmarks() {
  const saved = readSettings().bookmarks;
  return Array.isArray(saved) ? saved : SEED_SITES.map(([url, title]) => ({ url, title }));
}

// Sites visited often (at least 3 times), one per host, skipping favorites and CAPTCHA pages.
function frequentSites(limit = 6) {
  const favoriteHosts = new Set(bookmarks().map((b) => hostOf(b.url)));
  const seen = new Set();
  const out = [];
  for (const h of [...history.values()].filter((e) => e.visits >= 3).sort((a, b) => b.visits - a.visits || b.last - a.last)) {
    const host = hostOf(h.url);
    if (!host || favoriteHosts.has(host) || seen.has(host) || h.url.includes('/sorry/')) continue;
    seen.add(host);
    out.push({ url: h.url, title: h.title || host });
    if (out.length >= limit) break;
  }
  return out;
}

function newTabUrl() {
  const icons = readSettings().favicons || {};
  const withIcon = (b) => ({ ...b, ...(icons[hostOf(b.url)] ? { icon: icons[hostOf(b.url)] } : {}) });
  const data = {
    favorites: bookmarks().filter((b) => !b.folder).slice(0, 12).map(withIcon),
    frequent: frequentSites().map(withIcon),
    blocked: [...blockedCount.values()].reduce((sum, n) => sum + n, 0), // ads/trackers blocked on open tabs
    search: engineFor(readSettings().searchEngine),
  };
  return `${NEW_TAB_URL}#${encodeURIComponent(JSON.stringify(data))}`;
}

// When a favorite or frequently visited site shows its favicon, keep a small copy for the new-tab page.
async function cacheFavicon(pageUrl, iconUrl) {
  const host = hostOf(pageUrl);
  const settings = readSettings();
  if (!host || settings.favicons?.[host] || !/^https?:/.test(iconUrl)) return;
  // Only sites the new-tab page shows: favorites and frequently visited ones.
  if (!bookmarks().some((b) => hostOf(b.url) === host) && !frequentSites(12).some((s) => hostOf(s.url) === host)) return;
  try {
    const res = await net.fetch(iconUrl);
    const type = res.headers.get('content-type') || '';
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!res.ok || !type.startsWith('image/') || bytes.length > 40000) return;
    const latest = readSettings();
    writeSettings({ ...latest, favicons: { ...(latest.favicons || {}), [host]: `data:${type.split(';')[0]};base64,${bytes.toString('base64')}` } });
  } catch {
    // Favicon unavailable; the new-tab page shows a letter instead.
  }
}

function toggleBookmark() {
  const wc = activeTab()?.webContents;
  const url = wc ? realUrl(wc) : '';
  if (!isWebUrl(url)) return;
  const list = bookmarks();
  const index = list.findIndex((b) => b.url === url);
  if (index >= 0) list.splice(index, 1);
  else list.push({ url, title: wc.getTitle() || hostOf(url) });
  writeSettings({ ...readSettings(), bookmarks: list });
  sendTabs();
}

function bookmarksMenu() {
  const list = bookmarks();
  const wc = activeTab()?.webContents;
  const current = wc ? realUrl(wc) : '';
  const marked = list.some((b) => b.url === current);
  return [
    { label: marked ? 'Remove Bookmark' : 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', enabled: isWebUrl(current), click: toggleBookmark },
    { type: 'separator' },
    ...list.filter((b) => !b.folder).map((b) => ({ label: b.title || b.url, click: () => openTab(b.url) })),
    ...[...new Set(list.filter((b) => b.folder).map((b) => b.folder))].map((folder) => ({
      label: folder,
      submenu: list.filter((b) => b.folder === folder).map((b) => ({ label: b.title || b.url, click: () => openTab(b.url) })),
    })),
  ];
}

// ---------- downloads: saved to the Downloads folder, progress on the taskbar ----------

const downloads = []; // { id, name, path, state, received, total }
let downloadSeq = 0;
const RISKY_TYPES = /^\.(exe|msi|msix|bat|cmd|com|scr|ps1|vbs|vbe|js|jse|wsf|hta|jar|dll|lnk|reg|appx)$/i;
const sendDownloads = () => ui()?.send('downloads', downloads.slice(0, 10).map(({ id, name, state, received, total }) => ({ id, name, state, received, total })));

function setupDownloads() {
  const approvedUrls = new Set(); // risky downloads the user said yes to
  session.defaultSession.on('will-download', (event, item, contents) => {
    const dir = app.getPath('downloads');
    const parsed = path.parse(item.getFilename() || 'download');
    const url = item.getURL();
    if (RISKY_TYPES.test(parsed.ext) && !approvedUrls.delete(url)) {
      // Programs and scripts can run code: nothing is saved until the user agrees.
      event.preventDefault();
      if (!win || win.isDestroyed()) return;
      dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Cancel', 'Download'],
        defaultId: 0,
        cancelId: 0,
        message: `Download “${parsed.base}”?`,
        detail: `This type of file can run programs on your computer. Only keep it if you trust ${hostOf(url) || 'the site'}.`,
      }).then(({ response }) => {
        if (response !== 1) return;
        approvedUrls.add(url);
        (contents && !contents.isDestroyed() ? contents : win.webContents).downloadURL(url);
      });
      return;
    }
    let target = path.join(dir, parsed.base);
    for (let n = 1; fs.existsSync(target); n++) target = path.join(dir, `${parsed.name} (${n})${parsed.ext}`);
    item.setSavePath(target); // must be set synchronously, or Electron shows its own save dialog
    const entry = { id: ++downloadSeq, name: path.basename(target), path: target, state: 'progressing', received: 0, total: item.getTotalBytes() };
    downloads.unshift(entry);
    sendDownloads();
    const progress = () => {
      const active = downloads.filter((d) => d.state === 'progressing' && d.total > 0);
      const sum = active.reduce((a, d) => [a[0] + d.received, a[1] + d.total], [0, 0]);
      if (win && !win.isDestroyed()) win.setProgressBar(active.length ? sum[0] / sum[1] : -1);
    };
    item.on('updated', () => {
      entry.received = item.getReceivedBytes();
      entry.total = item.getTotalBytes();
      progress();
      sendDownloads();
    });
    item.once('done', (_ev, state) => {
      entry.state = state; // completed | cancelled | interrupted
      progress();
      sendDownloads();
      if (state === 'completed' && win && !win.isDestroyed()) win.flashFrame(!win.isFocused());
    });
  });
}

function downloadsMenu() {
  if (!downloads.length) return [{ label: 'No downloads yet', enabled: false }];
  const items = downloads.slice(0, 10).map((d) => {
    const status = d.state === 'progressing'
      ? (d.total ? `${Math.round((d.received / d.total) * 100)}%` : 'downloading')
      : d.state === 'completed' ? '' : d.state;
    return {
      label: status ? `${d.name} — ${status}` : d.name,
      enabled: d.state === 'completed',
      click: () => shell.openPath(d.path),
    };
  });
  items.push({ type: 'separator' }, { label: 'Open Downloads Folder', click: () => shell.openPath(app.getPath('downloads')) });
  return items;
}

// Electron reports only "Chromium" in UA client hints while the user agent says Chrome; sites
// (Google especially) treat that mismatch as a bot signal. Align both through the DevTools protocol.
const CHROME_MAJOR = process.versions.chrome.split('.')[0];
const UA_METADATA = {
  brands: [{ brand: 'Chromium', version: CHROME_MAJOR }, { brand: 'Google Chrome', version: CHROME_MAJOR }, { brand: 'Not_A Brand', version: '24' }],
  fullVersionList: [{ brand: 'Chromium', version: process.versions.chrome }, { brand: 'Google Chrome', version: process.versions.chrome }, { brand: 'Not_A Brand', version: '24.0.0.0' }],
  platform: { win32: 'Windows', darwin: 'macOS' }[process.platform] || 'Linux',
  platformVersion: process.platform === 'win32' ? '15.0.0' : '',
  architecture: 'x86',
  bitness: '64',
  model: '',
  mobile: false,
};
// ---------- AI web panels: claude.ai, ChatGPT, Gemini and Grok in the sidebar ----------
//
// The user's own accounts (including school or work SSO) on the providers' real websites. They are
// plain web pages in the default session, like any tab: no preload, no access to Lumen's tools, and
// Lumen never types into or scripts them. One view per service is kept alive so logins and chats
// persist; it is docked in the sidebar's content area and hidden while the sidebar animates.
const WEB_PANELS = {
  claude: 'https://claude.ai/',
  chatgpt: 'https://chatgpt.com/',
  gemini: 'https://gemini.google.com/app',
  grok: 'https://grok.com/',
};
const webPanels = new Map(); // service -> WebContentsView
let webPanelMode = 'agent';
let webPanelBounds = null; // the sidebar content area in window coordinates, or null when closed

function webPanelFor(service) {
  if (webPanels.has(service)) return webPanels.get(service);
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const wc = view.webContents;
  applyChromeIdentity(wc);
  wc.setWindowOpenHandler(({ url: target, disposition }) => {
    if (!(isWebUrl(target) || target === 'about:blank')) return { action: 'deny' };
    // Sign-in popups (Google, Microsoft, school SSO) keep window.opener so they can hand back.
    if (disposition === 'new-window') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
          icon: path.join(__dirname, 'assets', 'icon.png'),
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        },
      };
    }
    openTab(target); // links in a chat open as normal tabs
    return { action: 'deny' };
  });
  wc.on('did-create-window', (child) => applyChromeIdentity(child.webContents));
  wc.on('context-menu', (_e, params) => showContextMenu(wc, params));
  wc.on('before-input-event', (event, input) => handleShortcut(event, input));
  win.contentView.addChildView(view);
  view.setVisible(false);
  wc.loadURL(WEB_PANELS[service]).catch(() => {});
  webPanels.set(service, view);
  return view;
}

function layoutWebPanels() {
  for (const [service, view] of webPanels) {
    const show = service === webPanelMode && Boolean(webPanelBounds) && !viewFrozen;
    view.setVisible(show);
    if (show) view.setBounds(webPanelBounds);
  }
}

ipcMain.handle('webai:mode', (_e, mode) => {
  webPanelMode = WEB_PANELS[mode] ? mode : 'agent';
  if (webPanelMode !== 'agent') webPanelFor(webPanelMode);
  writeSettings({ ...readSettings(), webAiMode: webPanelMode });
  layoutWebPanels();
  return webPanelMode;
});
ipcMain.on('webai:bounds', (_e, rect) => {
  webPanelBounds = rect && rect.width > 20 && rect.height > 20
    ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    : null;
  layoutWebPanels();
});
ipcMain.handle('webai:state', () => ({ mode: readSettings().webAiMode || 'agent' }));
// "Share page": the active tab's title, URL and readable text on the clipboard, for the user to paste.
ipcMain.handle('webai:share', async () => {
  const wc = activeTab()?.webContents;
  if (!wc) return null;
  const title = wc.getTitle();
  const url = realUrl(wc);
  let text = '';
  if (isWebUrl(url)) {
    try {
      const page = await wc.executeJavaScriptInIsolatedWorld(1002, [{ code: require('./page-scripts').readPage(0, 0) }]);
      text = String(page?.text || '').replace(/\n{3,}/g, '\n\n').trim();
    } catch {
      text = '';
    }
  }
  const limit = 8000;
  const body = text.length > limit ? `${text.slice(0, limit)}\n[… ${(text.length - limit).toLocaleString()} more characters]` : text;
  clipboard.writeText([title, url, body].filter(Boolean).join('\n\n'));
  return { title, url, chars: body.length };
});

function applyChromeIdentity(wc) {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    wc.debugger.sendCommand('Emulation.setUserAgentOverride', { userAgent: app.userAgentFallback, userAgentMetadata: UA_METADATA }).catch(() => {});
  } catch {
    // Another debugger (e.g. an extension) is attached; keep Electron's defaults.
  }
}

// ---------- context menu ----------

function showContextMenu(wc, p) {
  const items = [];
  const selection = p.selectionText.trim();
  if (p.linkURL && isWebUrl(p.linkURL)) {
    items.push(
      { label: 'Open Link in New Tab', click: () => openTab(p.linkURL, { background: true, openerId: tabByContents(wc)?.id }) },
      { label: 'Copy Link', click: () => clipboard.writeText(p.linkURL) },
      { type: 'separator' },
    );
  }
  if (p.mediaType === 'image' && p.srcURL) {
    if (isWebUrl(p.srcURL)) items.push({ label: 'Open Image in New Tab', click: () => openTab(p.srcURL, { background: true }) });
    items.push({ label: 'Copy Image', click: () => wc.copyImageAt(p.x, p.y) }, { type: 'separator' });
  }
  if (p.isEditable) {
    items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' });
  } else if (selection) {
    const short = selection.length > 30 ? `${selection.slice(0, 29)}…` : selection;
    items.push(
      { role: 'copy' },
      { label: `Search ${engineFor(readSettings().searchEngine).label} for “${short}”`, click: () => openTab(searchUrlFor(readSettings().searchEngine, selection)) },
      { label: 'Ask Claude About Selection', click: () => ui()?.send('ask-selection', selection) },
      { type: 'separator' },
    );
  }
  if (items.length === 0) {
    items.push(
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
    );
  }
  const extensionItems = extensions ? extensions.getContextMenuItems(wc, p) : [];
  if (extensionItems.length) items.push(...extensionItems, { type: 'separator' });
  items.push({ label: 'Inspect Element', click: () => wc.inspectElement(p.x, p.y) });
  Menu.buildFromTemplate(items).popup({ window: win });
}

// ---------- shortcuts (work whether focus is in the UI or a tab) ----------

function handleShortcut(event, input) {
  if (input.type !== 'keyDown') return;
  const mod = input.control || input.meta;
  const key = input.key.toLowerCase();
  const wc = activeTab()?.webContents;
  let handled = true;
  if (mod && input.shift && /^Digit[1-5]$/.test(input.code || '')) ui()?.send('webai:switch', Number(input.code.slice(5)) - 1);
  else if (mod && input.shift && key === 't') { if (closedTabs.length) openTab(closedTabs.pop()); }
  else if (mod && key === 't') { openTab(); focusAddress(); }
  else if (mod && key === 'w') { if (activeId) closeTab(activeId); }
  else if (mod && key === 'l') focusAddress();
  else if (mod && key === 'f') { ui()?.focus(); ui()?.send('find:open'); }
  else if (mod && key === 'j') ui()?.send('toggle-sidebar');
  else if (mod && key === 'r') reloadActive();
  else if (mod && key === 'tab') cycleTab(input.shift ? -1 : 1);
  else if (mod && /^[1-9]$/.test(key)) { const t = key === '9' ? tabs[tabs.length - 1] : tabs[Number(key) - 1]; if (t) switchTab(t.id); }
  else if (mod && (key === '=' || key === '+')) zoomBy(wc, 0.5);
  else if (mod && key === '-') zoomBy(wc, -0.5);
  else if (mod && key === '0') zoomBy(wc, 0);
  else if (mod && key === 'd') toggleBookmark();
  else if (mod && key === 'h') openHistoryPage();
  else if (process.platform === 'darwin' && input.meta && key === '[') wc?.navigationHistory.goBack();
  else if (process.platform === 'darwin' && input.meta && key === ']') wc?.navigationHistory.goForward();
  else if (process.platform === 'darwin' && input.meta && key === 'y') openHistoryPage();
  else if (input.alt && key === 'arrowleft') wc?.navigationHistory.goBack();
  else if (input.alt && key === 'arrowright') wc?.navigationHistory.goForward();
  else if (key === 'f5') reloadActive();
  else if (key === 'f12') wc?.toggleDevTools();
  else handled = false;
  if (handled) event.preventDefault();
}

function focusAddress() {
  ui()?.focus();
  ui()?.send('focus-address');
}

function cycleTab(direction) {
  const index = tabs.findIndex((t) => t.id === activeId);
  switchTab(tabs[(index + direction + tabs.length) % tabs.length].id);
}

function reloadActive() {
  const wc = activeTab()?.webContents;
  if (!wc) return;
  if (wc.isLoading()) wc.stop();
  else if (wc.getURL().startsWith(ERROR_URL)) wc.loadURL(realUrl(wc)).catch(() => {});
  else wc.reload();
}

// ---------- saved chat (survives restarts) ----------

const CHAT_FILE = () => path.join(app.getPath('userData'), 'chat.json');

// Tool results (page text, screenshots, script output) are not kept on disk; the conversation
// itself is encrypted with the OS keychain when available.
function saveChat() {
  try {
    const snapshot = agent.snapshot();
    snapshot.messages = snapshot.messages.map((msg) => (Array.isArray(msg.content)
      ? { ...msg, content: msg.content.map((b) => (b.type === 'tool_result' ? { type: 'tool_result', tool_use_id: b.tool_use_id, is_error: b.is_error, content: '(result not saved between sessions)' } : b)) }
      : msg));
    const json = JSON.stringify(snapshot);
    const data = safeStorage.isEncryptionAvailable() ? { enc: safeStorage.encryptString(json).toString('base64') } : JSON.parse(json);
    fs.writeFileSync(CHAT_FILE(), JSON.stringify(data));
  } catch (err) {
    console.error('Could not save chat:', err.message);
  }
}

function loadChat() {
  try {
    const data = JSON.parse(fs.readFileSync(CHAT_FILE(), 'utf8'));
    agent.restore(data.enc ? JSON.parse(safeStorage.decryptString(Buffer.from(data.enc, 'base64'))) : data);
  } catch {
    // No saved chat yet (or it can't be decrypted on this machine).
  }
}

// ---------- window & session ----------

function titleBarOverlay() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: '#00000000', symbolColor: dark ? '#f5f5f7' : '#1d1d1f', height: 38 };
}

function saveSession() {
  const saved = tabs.filter((t) => alive(t) && isWebUrl(realUrl(t.view.webContents)));
  const urls = saved.map((t) => realUrl(t.view.webContents));
  writeSettings({ ...readSettings(), session: {
    urls,
    active: Math.max(0, saved.findIndex((t) => t.id === activeId)),
    groupIds: saved.map((t) => t.groupId || null),
    groups: tabGroups.snapshot(),
  } });
}

function restoreSession() {
  const { session: saved } = readSettings();
  if (!saved?.urls?.length) {
    openTab();
    return;
  }
  tabGroups.restore(saved.groups);
  saved.urls.forEach((url, i) => {
    const { id } = openTab(url, { background: true });
    const groupId = saved.groupIds?.[i];
    const tab = tabs.find((t) => t.id === id);
    if (tab && groupId && tabGroups.groups.has(groupId)) tab.groupId = groupId;
    else if (tab) tab.userRemoved = true; // restore the session as it was: don't regroup tabs left loose
  });
  tabGroups.cleanup();
  tabGroups.arrange();
  switchTab(tabs[Math.min(saved.active, tabs.length - 1)].id);
}

// ---------- macOS ----------
// macOS needs an application menu: without one, Cmd+C/V/X/A/Z/Q don't work anywhere. Browser
// shortcuts that handleShortcut() already handles are shown here but not registered twice.
function macMenu() {
  const shown = (accelerator) => ({ accelerator, registerAccelerator: false });
  const wc = () => activeTab()?.webContents;
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', ...shown('Cmd+T'), click: () => { openTab(); focusAddress(); } },
        { label: 'Reopen Closed Tab', ...shown('Cmd+Shift+T'), click: () => { if (closedTabs.length) openTab(closedTabs.pop()); } },
        { label: 'Open Location…', ...shown('Cmd+L'), click: focusAddress },
        { type: 'separator' },
        { label: 'Close Tab', ...shown('Cmd+W'), click: () => { if (activeId) closeTab(activeId); } },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', ...shown('Cmd+R'), click: reloadActive },
        { label: 'Find…', ...shown('Cmd+F'), click: () => { ui()?.focus(); ui()?.send('find:open'); } },
        { type: 'separator' },
        { label: 'Zoom In', ...shown('Cmd+='), click: () => zoomBy(wc(), 0.5) },
        { label: 'Zoom Out', ...shown('Cmd+-'), click: () => zoomBy(wc(), -0.5) },
        { label: 'Actual Size', ...shown('Cmd+0'), click: () => zoomBy(wc(), 0) },
        { type: 'separator' },
        { label: 'Toggle Sidebar', ...shown('Cmd+J'), click: () => ui()?.send('toggle-sidebar') },
        { label: 'Developer Tools', accelerator: 'Alt+Cmd+I', click: () => wc()?.toggleDevTools() },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'History',
      submenu: [
        { label: 'Back', ...shown('Cmd+['), click: () => wc()?.navigationHistory.goBack() },
        { label: 'Forward', ...shown('Cmd+]'), click: () => wc()?.navigationHistory.goForward() },
        { label: 'Show All History', ...shown('Cmd+Y'), click: openHistoryPage },
      ],
    },
    { label: 'Bookmarks', submenu: [{ label: 'Bookmark This Page', ...shown('Cmd+D'), click: toggleBookmark }] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Lumen on GitHub', click: () => shell.openExternal('https://github.com/emah-maker/lumen') }] },
  ]);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 800,
    minHeight: 500,
    title: 'Lumen',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay() }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false, // preload loads electron-chrome-extensions' toolbar element; the page is our own local UI
      nodeIntegration: false,
    },
  });
  Menu.setApplicationMenu(process.platform === 'darwin' ? macMenu() : null);
  nativeTheme.on('updated', () => {
    if (process.platform !== 'darwin' && ui()) win.setTitleBarOverlay(titleBarOverlay());
  });
  win.webContents.on('before-input-event', (event, input) => handleShortcut(event, input));
  win.on('close', saveSession);
  win.on('focus', () => ui()?.send('window-focus', true));
  win.on('blur', () => ui()?.send('window-focus', false));
  win.on('resize', () => { hideSuggestions(); if (tabs.some((t) => t.fullscreen)) layout(); });
  win.on('blur', hideSuggestions);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => {
    restoreSession();
    const items = agent.transcript();
    if (items.length) ui()?.send('agent:history', { items });
  });
}

function groupTabsFor(name, ids) {
  const known = ids.filter((id) => tabs.some((t) => t.id === id));
  if (!known.length) throw new Error('None of those tab ids are open.');
  for (const id of known) if (tabs.find((t) => t.id === id).groupId) tabGroups.remove(id);
  const group = tabGroups.create(name, known);
  sendTabs();
  return { group: group.name, tabs: known };
}
function ungroupTabsFor(ids) {
  let count = 0;
  for (const id of ids) if (tabGroups.remove(id, { byUser: true })) count++;
  sendTabs();
  return count;
}

const agent = new Agent({ activeTab, listTabs, openTab, switchTab, closeTab, groupTabs: groupTabsFor, ungroupTabs: ungroupTabsFor, autoApprove: () => Boolean(process.env.CLAUDE_BROWSER_TEST) || readSettings().askBeforeActing === false }, getClient, () => ({ adhdMode: readSettings().adhdMode !== false, model: readSettings().model || DEFAULT_MODEL }), providerKey);
if (process.env.CLAUDE_BROWSER_TEST) {
  global.__agent = agent;
  global.__webPanels = webPanels;
  global.__mcp = () => mcpServer;
  global.__providers = providers;
  global.__importBrowser = importBrowser;
  global.__tabGroups = tabGroups;
  global.__organizeTabs = organizeTabs;
  global.__tabsArray = () => tabs.map((t) => ({ id: t.id, groupId: t.groupId || null, userRemoved: Boolean(t.userRemoved) }));
  global.__installExtension = (id) => installExtension(id, { session: session.defaultSession });
  global.__adblock = { ready: () => blocker !== null, blocked: (id) => blockedCount.get(id) || 0 };
}

ipcMain.on('content-bounds', (_e, bounds) => {
  contentBounds = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
  layout();
});

ipcMain.handle('view:freeze', async () => {
  const wc = activeTab()?.webContents;
  if (!wc || tabs.find((t) => t.id === activeId)?.fullscreen) return null;
  try {
    const image = await wc.capturePage();
    if (image.isEmpty()) return null;
    viewFrozen = true;
    layout();
    return `data:image/jpeg;base64,${image.toJPEG(88).toString('base64')}`;
  } catch {
    return null;
  }
});
// Capture once at startup so the first real snapshot doesn't pay the pipeline's warm-up cost.
ipcMain.handle('view:warm', async () => {
  const wc = activeTab()?.webContents;
  if (!wc) return false;
  try { await wc.capturePage(); } catch {} // full size: the first full readback is the slow one
  return true;
});
ipcMain.on('view:thaw', () => {
  viewFrozen = false;
  layout();
});
ipcMain.on('tab:new', (_e, url) => openTab(url ? resolveInput(url) : undefined));
ipcMain.on('tab:close', (_e, id) => closeTab(id));
ipcMain.on('tab:switch', (_e, id) => switchTab(id));
ipcMain.on('tab:move', (_e, id, toIndex) => {
  const from = tabs.findIndex((t) => t.id === id);
  if (from === -1) return;
  const [tab] = tabs.splice(from, 1);
  tabs.splice(Math.max(0, Math.min(Number(toIndex) || 0, tabs.length)), 0, tab);
  // Dropped between two tabs of a group: joins it. Dragged out of its own group: leaves it (and
  // stays out of automatic grouping).
  const i = tabs.indexOf(tab);
  const prev = tabs[i - 1];
  const next = tabs[i + 1];
  const before = tab.groupId;
  let target = null;
  if (prev?.groupId && prev.groupId === next?.groupId) target = prev.groupId;
  else if (before && (prev?.groupId === before || next?.groupId === before)) target = before;
  if (target !== before) {
    tab.groupId = target;
    tab.userRemoved = !target;
  }
  tabGroups.cleanup();
  tabGroups.arrange();
  sendTabs();
});
ipcMain.on('bookmark:toggle', toggleBookmark);
ipcMain.on('tab:context-menu', (_e, id, point) => tabMenu(id, point));
ipcMain.on('group:context-menu', (_e, id, point) => groupMenu(id, point));
ipcMain.on('group:toggle', (_e, id) => {
  const group = tabGroups.groups.get(id);
  if (!group) return;
  group.collapsed = !group.collapsed;
  sendTabs();
});
ipcMain.on('group:rename', (_e, id, name) => {
  const group = tabGroups.groups.get(id);
  const clean = String(name || '').trim().slice(0, 40);
  if (group && clean) group.name = clean;
  sendTabs();
});
ipcMain.on('tabs:organize', organizeTabs);
ipcMain.on('downloads:menu', (_e, { x, y }) => Menu.buildFromTemplate(downloadsMenu()).popup({ window: win, x: Math.round(x), y: Math.round(y) }));
ipcMain.on('zoom:reset', () => zoomBy(activeTab()?.webContents, 0));
ipcMain.on('nav:go', (_e, text) => {
  const wc = activeTab()?.webContents;
  if (!wc) return;
  wc.loadURL(resolveInput(text)).catch(() => {});
  wc.focus();
});
ipcMain.on('nav:back', () => activeTab()?.webContents.navigationHistory.goBack());
ipcMain.on('nav:forward', () => activeTab()?.webContents.navigationHistory.goForward());
ipcMain.on('nav:reload', reloadActive);

ipcMain.handle('suggest:query', (_e, query) => suggestions(query));
ipcMain.on('suggest:show', (_e, rect, payload) => showSuggestions(rect, payload));
ipcMain.on('suggest:hide', hideSuggestions);
ipcMain.on('app-menu', (_e, point) => showAppMenu(point));
ipcMain.on('suggest:pick', (_e, index) => ui()?.send('suggest:picked', index));

ipcMain.on('find:start', (_e, text, options = {}) => {
  const wc = activeTab()?.webContents;
  if (!wc) return;
  if (!text) {
    wc.stopFindInPage('clearSelection');
    ui()?.send('find:result', { activeMatchOrdinal: 0, matches: 0 });
    return;
  }
  wc.findInPage(text, { forward: options.forward !== false, findNext: !options.findNext });
});
ipcMain.on('find:stop', () => activeTab()?.webContents.stopFindInPage('clearSelection'));

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
ipcMain.on('agent:ask', (event, text, runId, images = []) => {
  const valid = (Array.isArray(images) ? images : [])
    .filter((img) => IMAGE_TYPES.has(img?.media_type) && typeof img.data === 'string' && img.data.length < 7_000_000 && /^[A-Za-z0-9+/]+=*$/.test(img.data))
    .slice(0, 5);
  agent.run(String(text || ''), (msg) => {
    if (!event.sender.isDestroyed()) event.sender.send('agent:event', { ...msg, runId });
    if (msg.type === 'done') saveChat();
  }, valid);
});
ipcMain.on('agent:stop', () => agent.stop());
ipcMain.on('agent:reset', () => {
  agent.reset();
  fs.rm(CHAT_FILE(), { force: true }, () => {});
});
ipcMain.on('agent:approve', (_e, approvalId, ok) => agent.resolveApproval(approvalId, ok));

ipcMain.handle('settings:get', () => {
  const options = modelOptions();
  const saved = readSettings().model;
  return {
    hasStoredKey: Boolean(storedApiKey()),
    hasEnvKey: Boolean(process.env.ANTHROPIC_API_KEY),
    providerKeys: Object.fromEntries(Object.keys(providers.PROVIDERS).map((p) => [p, {
      label: providers.PROVIDERS[p].label,
      stored: Boolean(readSettings().keys?.[p]),
      env: Boolean(process.env[ENV_KEYS[p]]),
    }])),
    adhdMode: readSettings().adhdMode !== false,
    autoGroupTabs: readSettings().autoGroupTabs !== false,
    searchEngine: readSettings().searchEngine || DEFAULT_ENGINE,
    searchEngines: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, label: e.label, url: e.url })),
    model: options.some((o) => o.id === saved) ? saved : DEFAULT_MODEL,
    models: options,
  };
});
ipcMain.handle('settings:set-provider-key', async (_e, provider, key) => {
  if (!providers.PROVIDERS[provider]) return false;
  const settings = readSettings();
  const keys = { ...(settings.keys || {}) };
  if (key) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error(`OS encryption is unavailable; set ${ENV_KEYS[provider]} instead.`);
    keys[provider] = safeStorage.encryptString(String(key).trim()).toString('base64');
  } else {
    delete keys[provider];
  }
  writeSettings({ ...settings, keys });
  await refreshModels(provider);
  return true;
});
// ---- sign in with the Anthropic CLI (an OAuth profile instead of an API key)
const CLI_BIN = () => path.join(app.getPath('userData'), 'bin');

async function cliStatus() {
  const ant = await cliAuth.findAnt(CLI_BIN());
  const { profile, signedIn: hasFile } = cliAuth.profileState();
  // A credentials file can outlive its tokens: confirm with the CLI when it's available.
  const signedIn = hasFile && (ant ? await cliAuth.verifyLogin(ant) : true);
  return {
    installed: Boolean(ant),
    path: ant || null,
    signedIn,
    profile,
    // A saved or exported API key takes precedence over the CLI profile.
    shadowedBy: storedApiKey() ? 'saved key' : process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : null,
  };
}

ipcMain.handle('cli:status', cliStatus);
ipcMain.handle('cli:login', async (event) => {
  const progress = (text) => { if (!event.sender.isDestroyed()) event.sender.send('cli:progress', text); };
  try {
    let ant = await cliAuth.findAnt(CLI_BIN());
    if (!ant) {
      progress('Installing the Anthropic CLI…');
      ant = await cliAuth.installAnt(CLI_BIN());
    }
    progress('Finish signing in in your web browser…');
    const result = await cliAuth.login(ant);
    client = null; // the next request picks up the new profile
    return { ...(await cliStatus()), ok: result.ok, message: result.ok ? '' : result.message || 'Sign-in did not complete.' };
  } catch (err) {
    return { ...(await cliStatus()), ok: false, message: err.message };
  }
});
ipcMain.handle('cli:logout', async () => {
  const ant = await cliAuth.findAnt(CLI_BIN());
  if (ant) await cliAuth.logout(ant);
  client = null;
  return cliStatus();
});

ipcMain.handle('settings:set-search-engine', (_e, id) => setSearchEngine(id));
ipcMain.handle('import:browsers', () => importer.detectBrowsers());
ipcMain.handle('import:run', (_e, id) => runImport(id));
ipcMain.handle('settings:set-model', (_e, id) => {
  if (!modelOptions().some((o) => o.id === id)) return false;
  writeSettings({ ...readSettings(), model: id });
  agent.setModel(id);
  return true;
});
ipcMain.handle('settings:set-auto-group', (_e, on) => setAutoGroup(on));
ipcMain.handle('settings:set-adhd', (_e, on) => {
  writeSettings({ ...readSettings(), adhdMode: Boolean(on) });
  return true;
});
ipcMain.handle('settings:set-key', (_e, key) => {
  const settings = readSettings();
  if (key) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable; set ANTHROPIC_API_KEY instead.');
    settings.apiKeyEnc = safeStorage.encryptString(key.trim()).toString('base64');
  } else {
    delete settings.apiKeyEnc;
  }
  writeSettings(settings);
  client = null;
  return true;
});

// ---------- AI agents over MCP (Claude Code, Codex CLI, Gemini CLI, Cursor…) ----------

let mcpServer = null;
const mcpEvent = (event) => ui()?.send('mcp:event', event);
const mcpEnabled = () => readSettings().mcpEnabled !== false;

const toMcpContent = (result) => (typeof result === 'string'
  ? [{ type: 'text', text: result }]
  : result.map((b) => (b.type === 'image' ? { type: 'image', data: b.source.data, mimeType: b.source.media_type } : { type: 'text', text: b.text ?? '' })));

// Runs one browser tool for an external agent, with the same per-site approval as the sidebar,
// and shows each call as a step in the sidebar.
async function mcpCallTool(name, args, session) {
  const problem = validateToolInput(name, args);
  if (problem) return { content: [{ type: 'text', text: `Invalid input: ${problem}` }], isError: true };
  session.approvedHosts ||= new Set();
  const stepId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const label = await agent.describeStep(name, args).catch(() => null);
  mcpEvent({ type: 'tool', id: stepId, name, input: args, label, clientName: session.clientName });
  const emit = (event) => mcpEvent({ ...event, clientName: session.clientName });
  try {
    await agent.ensureAllowed(name, emit, session.controller.signal, { hosts: session.approvedHosts, who: session.clientName });
    const result = await agent.execute(name, args);
    mcpEvent({ type: 'tool_done', id: stepId, ok: true });
    return { content: toMcpContent(result), isError: false };
  } catch (err) {
    const message = session.controller.signal.aborted ? 'Stopped by the user.' : String(err?.message || err);
    mcpEvent({ type: 'tool_done', id: stepId, ok: false, error: message.split('\n')[0] });
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

function startMcp() {
  mcpServer = require('./mcp').startServer({
    userData: app.getPath('userData'),
    tools: EXTERNAL_TOOLS,
    callTool: mcpCallTool,
    enabled: mcpEnabled,
    onEvent: mcpEvent,
  });
}

// The command an agent should run: Lumen's own executable in Node mode on mcp.js (clean stdio,
// no window machinery). Works for the installed app and for development alike.
function mcpCommand() {
  return { command: process.execPath, args: [path.join(__dirname, 'mcp.js')], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

ipcMain.handle('mcp:info', () => {
  const { command, args, env } = mcpCommand();
  const quoted = [command, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  const json = JSON.stringify({ mcpServers: { lumen: { command, args, env } } }, null, 2);
  const tomlArgs = args.map((a) => `'${a}'`).join(', ');
  return {
    enabled: mcpEnabled(),
    snippets: [
      { id: 'claude', label: 'Claude Code', hint: 'Run in a terminal', text: `claude mcp add lumen -e ELECTRON_RUN_AS_NODE=1 -- ${quoted}` },
      { id: 'codex', label: 'Codex CLI', hint: 'Add to ~/.codex/config.toml', text: `[mcp_servers.lumen]\ncommand = '${command}'\nargs = [${tomlArgs}]\nenv = { ELECTRON_RUN_AS_NODE = "1" }` },
      { id: 'gemini', label: 'Gemini CLI', hint: 'Add to ~/.gemini/settings.json', text: json },
      { id: 'json', label: 'Other MCP clients', hint: 'Cursor, Claude Desktop, etc.', text: json },
    ],
  };
});
ipcMain.handle('mcp:set-enabled', (_e, on) => {
  writeSettings({ ...readSettings(), mcpEnabled: Boolean(on) });
  if (!on) mcpServer?.disconnectAll();
  return true;
});
ipcMain.on('mcp:stop', () => mcpServer?.disconnectAll());

// `Lumen.exe --install-shortcuts` (run by scripts/install-windows.ps1) writes Desktop and
// Start menu shortcuts carrying the app ID and icon, then exits.
function installShortcuts() {
  const exe = process.execPath;
  const icon = path.join(path.dirname(exe), 'icon.ico');
  const options = { target: exe, cwd: path.dirname(exe), icon: fs.existsSync(icon) ? icon : exe, iconIndex: 0, appUserModelId: APP_ID, description: 'Lumen, the AI browser' };
  const startMenu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  for (const dir of [app.getPath('desktop'), startMenu]) {
    shell.writeShortcutLink(path.join(dir, 'Lumen.lnk'), 'create', options);
    fs.rmSync(path.join(dir, 'Claude Browser.lnk'), { force: true }); // the shortcut from before the rename
  }
}

// If the lock is held but no main process for this app is alive, it belongs to child processes
// of an instance that crashed or was killed. Stop those orphans and try again.
function reclaimProfileLock() {
  if (process.platform !== 'win32') return false;
  const exe = process.execPath.replace(/'/g, "''");
  const script = [
    `$exe = '${exe}'`,
    '$procs = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $exe -and $_.ProcessId -ne ' + process.pid + ' })',
    "$main = @($procs | Where-Object { $_.CommandLine -notmatch '--type=' })",
    'if ($main.Count -gt 0) { exit 3 }',
    "$procs | Where-Object { $_.CommandLine -match '--type=' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    'exit 0',
  ].join('; ');
  try {
    require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000, windowsHide: true });
    return true;
  } catch {
    return false; // a live instance exists (exit 3) or cleanup failed
  }
}

const PIPE = () => (process.platform === 'win32'
  ? `\\\\.\\pipe\\lumen-${require('crypto').createHash('sha1').update(app.getPath('userData')).digest('hex').slice(0, 12)}`
  : path.join(app.getPath('userData'), 'instance.sock'));

// Is a live instance listening on this profile's pipe? (It focuses itself when we connect.)
function pingRunningInstance() {
  if (process.platform !== 'win32') return false;
  const { execFileSync } = require('child_process');
  try {
    // A tiny synchronous probe: exit 0 if the pipe accepts a connection within 250 ms.
    execFileSync(process.execPath, ['-e', `const s=require('net').connect(${JSON.stringify(PIPE())});s.on('connect',()=>{s.end('focus');process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),250)`], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 2000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function listenForSecondInstances() {
  if (process.platform !== 'win32') return;
  require('net').createServer((socket) => {
    socket.on('data', () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.focus();
    });
    socket.on('error', () => {});
  }).on('error', () => {}).listen(PIPE());
}

function acquireInstanceLock() {
  if (app.requestSingleInstanceLock()) return true;
  if (process.env.CLAUDE_BROWSER_TEST && !process.env.CLAUDE_BROWSER_PROFILE) return false;
  if (pingRunningInstance()) return false; // a live instance answered and brought itself forward
  if (!reclaimProfileLock()) return false;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (app.requestSingleInstanceLock()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  }
  return false;
}

const singleInstance = process.argv.includes('--install-shortcuts') || acquireInstanceLock();
if (!singleInstance) app.quit();
app.on('second-instance', () => {
  // Opening the shortcut again focuses the running browser (two copies would overwrite each other's files).
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(async () => {
  if (process.argv.includes('--install-shortcuts')) {
    installShortcuts();
    app.quit();
    return;
  }
  if (!singleInstance) return;
  listenForSecondInstances();
  startMcp();
  setupPermissions();
  setupDownloads();
  loadChat();
  loadHistory();
  // Extensions must be ready before tabs exist so every tab is registered with chrome.tabs.
  await setupExtensions().catch((err) => console.error('Extension support failed to start:', err));
  // Filter lists load from cache (or download on first run) without holding up the window.
  setupAdblock().catch((err) => console.error('Ad blocker failed to start:', err));
  for (const provider of Object.keys(providers.PROVIDERS)) if (providerKey(provider)) refreshModels(provider);
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(__dirname, 'assets', 'icon.png'));
  createWindow();
});
// On macOS the app stays running with no windows, and clicking the Dock icon opens one again.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (app.isReady() && singleInstance && (!win || win.isDestroyed())) createWindow(); });
