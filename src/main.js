const { app, BrowserWindow, WebContentsView, ipcMain, Menu, Notification, clipboard, dialog: electronDialog, nativeTheme, net, safeStorage, screen, session, shell, components, systemPreferences } = require('electron');
// The main process's ~4 MB of modules are compiled once and kept on disk (V8's code cache, keyed by each file's
// contents): later launches skip most of the ~70 ms of parsing and compiling before the window can be made.
try { require('module').enableCompileCache?.(require('path').join(require('os').tmpdir(), 'lumen-compile-cache')); } catch { /* compiled as before */ }
// Test mode (CLAUDE_BROWSER_TEST), honoured only when not packaged: see test-mode.js.
const TEST = require('./test-mode').isTest();
const perf = TEST ? require('./features/perf-hooks').install(__filename) : { mark() {} }; // startup marks and timer counts (test/perf-budget.js)
if (TEST) global.__perf = perf;

// `Lumen --mcp`: an AI agent (Claude Code, Codex, Antigravity…) started us as its MCP server. Run
// only the stdio bridge, before loading anything else (no window, no lock, nothing on stdout).
if (process.argv.includes('--mcp')) {
  if (TEST && process.env.CLAUDE_BROWSER_PROFILE) app.setPath('userData', process.env.CLAUDE_BROWSER_PROFILE);
  require('./automation/mcp').runBridge({ app });
  return;
}
const fs = require('fs');
// Automation on, where Chromium needs a private pipe (launcher.js): this first process only starts Lumen again
// and leaves. Decided here, before ~100 ms of modules a process that exits at once would never use.
let earlyAutomation; // (undefined: not decided here, see prepareAutomation below)
if (!TEST && !process.argv.includes('--install-shortcuts')) {
  const early = require('path').join(app.getPath('userData'), 'settings.json');
  if (fs.existsSync(early)) { // (a profile still to be carried over from the old name decides later, as before)
    let s = {};
    try { s = require('./settings/settings-file').loadJson(early); } catch {}
    earlyAutomation = s.automationEnabled ? require('./features/ai-agents').prepareAutomation(app, s) : null;
    if (earlyAutomation?.relaunch) {
      require('./automation/launcher').handOver(app, () => require('./features/instance').acquireInstanceLock(app));
      return;
    }
  }
}
const path = require('path');
// Every window's icon. Windows gets the .ico (its small sizes are ready to use): decoding the 1024 px PNG held up
// each new window by ~45 ms, the first one included. (macOS ignores it; Linux takes the PNG.)
const WINDOW_ICON = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const { pathToFileURL } = require('url');
const { netFetch } = require('./browser/net-fetch');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { installChromeWebStore, installExtension, uninstallExtension, loadAllExtensions, updateExtensions } = require('electron-chrome-web-store');
const { extensionPermissionLines } = require('./browser/extension-permissions');
const { Agent, MODELS, DEFAULT_MODEL, EXTERNAL_TOOLS, PAGE_BLOCK, validateInput: validateToolInput, transcriptFor } = require('./ai/agent');
const { createChatStore, toMarkdown, cleanTitle, autoTitle } = require('./features/chat-store');
const { describeUsage } = require('./features/chat-usage');
const providers = require('./ai/providers');
if (TEST) global.__providers = providers;
const cliJson = require('./ai/cli-json');
const { engineModel } = require('./ai/cli-utils');
const { SEARCH_ENGINES, DEFAULT_ENGINE, engineFor, searchUrlFor, resolveInput: resolveAddressInput } = require('./browser/search');
// Optional features load on first use (startup stays lean).
const lazy = (load) => { let mod; return new Proxy({}, { get: (_t, key) => (mod ||= load())[key] }); };
const importer = lazy(() => require('./browser/importer'));
const cliAuth = lazy(() => require('./ai/cli-auth'));
// The SDK needs `new`, which the plain get-trap `lazy()` proxy above can't forward, so it gets its
// own tiny cached accessor instead. Only the Claude API path (getClient, organizeTabsWithAi's catch)
// touches this; a session that only ever uses Claude Code, Grok, or another provider never loads it.
let anthropicSdk_ = null;
const anthropicSdk = () => (anthropicSdk_ ||= require('@anthropic-ai/sdk'));
const { createTabGroups, siteName, pathWords, siteHint } = require('./browser/tab-groups');
const organizeAi = require('./features/organize-ai'); // Organize with AI: local first, the model refines
const organizeLearn = require('./features/organize-learn'); // what Organize learns from the user, duplicate tabs, idle rule
const pdfZoom = require('./features/pdf-zoom'); // Ctrl+Plus/Minus/0 and Ctrl+wheel drive the PDF viewer's own zoom
const appMenuLayout = require('./features/app-menu-layout'); // the ⋯ menu folds into submenus to fit short windows
const sidebarOverlay = require('./features/sidebar-overlay'); // the AI sidebar floats over the new-tab page instead of re-flowing it
const { createAdblock, hostOf } = require('./features/adblock');
const { createDownloads } = require('./features/downloads');
const { createManagers, pageOf: managerPageOf } = require('./features/managers'); // Bookmarks and Downloads pages
const { createSiteActivity } = require('./features/site-activity');
const { createUsage } = require('./features/usage');
const { createDialogs } = require('./features/dialogs');
const { createSiteSecurity } = require('./features/site-security');
const { createAiSites, siteOf: aiSiteOf } = require('./features/ai-sites'); // [ai controls] "Turn off AI on this site"
const { createSafeBrowsing } = require('./features/safe-browsing');
const instance = require('./features/instance');
const { createPrivateWindows } = require('./features/private-window');
const { t, i18n } = require('./features/i18n'); // UI strings (locales/)
const chatRunsLib = require('./features/chat-runs'); // [background chats] when to notify, and what it says
const tabChatsLib = require('./features/tab-chats'); // [chat per tab] which chat each tab shows, the cap on chats working at once
const manners = require('./features/ai-manners'); // [ai manners] tabs the AI opened, hands-off mode, the user's focus
const { createWidgets } = require('./features/widgets'); // [widgets] cards on the new-tab page
const { ACCOUNT_URL: TVW_ACCOUNT_URL } = require('./features/tradingview-view'); // [widgets] TradingView watchlist import
const SW = require('./features/spotify-web'); // [widgets] the Spotify widget's Web player: open.spotify.com in a view over the card
const SPOTIFY_REDIRECT_PORT = require('./features/spotify-view').REDIRECT_PORT; // [widgets] Spotify's loopback sign-in

const NEW_TAB_URL = pathToFileURL(path.join(__dirname, 'renderer', 'newtab.html')).href;
const isNewTab = (url) => url.startsWith(NEW_TAB_URL);
const HISTORY_URL = pathToFileURL(path.join(__dirname, 'renderer', 'history.html')).href;
const settingsPage = require('./settings/settings-backend'); // [settings] lumen://settings
const chatPage = require('./features/chat-page'); // lumen://chat: the sidebar's conversation as a full page
let chatPageRt = null; // its runtime (created below, with the agent)
// Save Page As, View Source, Reader mode and Picture in Picture (features/page-tools.js)
const pageTools = require('./features/page-tools').createPageTools({
  t,
  openTab: (...args) => openTab(...args),
  sendTabs: () => sendTabs(),
  downloadDir: () => settingsBackend.downloadDir(),
  showSaveDialog: (options) => (TEST && global.__pageToolsSaveDialog ? global.__pageToolsSaveDialog(options) : dialog.showSaveDialog(win, options)),
});
// Page translation (features/translate.js): user-initiated, with the user's own connected AI.
const translate = require('./features/translate').createTranslate({
  readSettings: () => readSettings(),
  writeSettings: (s) => writeSettings(s),
  t: (...a) => t(...a),
  uiLocale: () => app.getLocale(),
  engine: () => translateEngine(),
  aiAllowed: (url) => !aiSites.isOff(url),
  sendTabs: () => sendTabs(),
  popupMenu: (template) => Menu.buildFromTemplate(template).popup({ window: win }),
  openUrl: (tab, url) => tab.view.webContents.loadURL(url).catch(() => {}),
});
const isInternal = (url) => isNewTab(url) || url.startsWith(HISTORY_URL) || settingsPage.isSettingsUrl(url) || pageTools.isInternal(url) || Boolean(managerPageOf(url));
const ERROR_URL = pathToFileURL(path.join(__dirname, 'renderer', 'error.html')).href;
const CERT_URL = pathToFileURL(path.join(__dirname, 'renderer', 'cert-error.html')).href; // certificate warning (features/site-security.js)
const SAFE_BROWSING_URL = pathToFileURL(path.join(__dirname, 'renderer', 'safe-browsing.html')).href; // features/safe-browsing.js
const isErrorPage = (url) => url.startsWith(ERROR_URL) || url.startsWith(CERT_URL) || url.startsWith(SAFE_BROWSING_URL);
// The browser UI's own document and its privileged preload (see the IPC gate and hardenUiView below).
const UI_HTML = path.join(__dirname, 'renderer', 'index.html');
const UI_URL = pathToFileURL(UI_HTML).href;
const SUGGEST_URL = pathToFileURL(path.join(__dirname, 'renderer', 'suggest.html')).href;
// `url` is the local file `fileUrl` (query and hash aside). Case-insensitive: Windows paths are.
const sameFileUrl = (url, fileUrl) => {
  try { const u = new URL(url); u.search = ''; u.hash = ''; return u.protocol === 'file:' && u.href.toLowerCase() === fileUrl.toLowerCase(); } catch { return false; }
};
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const isWebUrl = (url) => /^https?:\/\//i.test(url);

// Look like stock Chrome; sites (notably Google) treat unknown browser tokens as bots.
app.userAgentFallback = require('./browser/chrome-identity').userAgent(process.platform, process.versions.chrome); // (browser/chrome-identity.js)
// Google's sign-in on other sites (One Tap, "Sign in with Google") uses FedCM when the browser says it is Chrome.
// Electron has no FedCM, so that prompt would never appear; with the API off, Google uses its iframe prompt.
app.commandLine.appendSwitch('disable-features', 'FedCm');

// Test runs get a throwaway profile so they never touch the real session or key.
const APP_ID = 'com.lumen.browser';

// Lumen was "Claude Browser": carry the old profile (settings, history, bookmarks, extensions,
// saved chat) over to the new name once, before anything opens it.
if (!TEST) {
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

if (TEST) {
  app.setPath('userData', process.env.CLAUDE_BROWSER_PROFILE || fs.mkdtempSync(path.join(require('os').tmpdir(), 'claude-browser-test-')));
}


// A stray error in the main process must not take the browser (and every open tab) down, or
// pop Electron's raw error box: log it and keep going.
process.on('uncaughtException', (err) => console.error('[lumen] uncaught exception:', err));
process.on('unhandledRejection', (reason) => console.error('[lumen] unhandled rejection:', reason));

let win;
const ui = () => (win && !win.isDestroyed() ? win.webContents : null); // null once the window is gone

// Only the settings tab's own top-level settings document may use the prefs:* calls.
function isSettingsSender(event) {
  return tabs.some((t) => t.settings && alive(t) && t.view.webContents === event.sender)
    && event.senderFrame === event.sender.mainFrame && settingsPage.isSettingsUrl(event.senderFrame?.url);
}
// Calls that change keys, sign-ins, what outside programs may do (MCP, the automation port) and
// imports answer only Lumen's own UI and its settings page. Today nothing else has a preload that
// could send them; this keeps it that way if a page or extension ever finds a way to.
const PRIVILEGED_IPC = /^(settings|openrouter|spotify|cli|import|mcp|automation|claudecode|antigravity|skills):/;
// Everything preload.js sends or invokes (the browser UI's own bridge): these answer only the UI's
// top-level renderer/index.html document, never a page that somehow got into that window or a frame
// inside it. test/hardening.js checks this list against preload.js.
const UI_ONLY_IPC = new Set([
  'content-bounds', 'view:freeze', 'view:freeze-alive', 'view:thaw', 'chat:full', 'view:warm',
  'tab:new', 'tab:close', 'tab:switch', 'tab:move', 'tab:context-menu',
  'group:context-menu', 'group:toggle', 'group:rename', 'tabs:organize', 'tabs:undo-organize',
  'bookmark:toggle', 'zoom:reset', 'downloads:menu', 'page:reader', 'files:open',
  'nav:go', 'nav:back', 'nav:forward', 'nav:reload', 'find:start', 'find:stop',
  'app-menu', 'page-info:open', 'actions:overflow', 'suggest:query', 'suggest:show', 'suggest:hide', 'address:touched',
  'settings-page:open', 'prefs:ui',
  'agent:ask', 'agent:stop', 'agent:prewarm', 'agent:reset', 'agent:rewind', 'agent:approve', 'agent:auto-allow', 'agent:undo', 'agent:ai-tabs-close', 'agent:ai-tabs-undo', 'agent:show-target', 'tabs:ask-list',
  'chat:sidebar-state',
  'chats:list', 'chats:open', 'chats:show-tab', 'chats:rename', 'chats:delete', 'chats:export', 'chats:close-tabs',
  'chat:open-page', 'chatpage:state', 'chatpage:back', 'chatpage:link',
  'pagecontext:get', 'pagecontext:set', 'ui:strings', 'usage:get',
  'tab:mute', 'tabs:hide-ai', 'tabsearch:closed', 'tabsearch:reopen', 'tab:dragprep', 'tab:dragstart', 'tab:dragmove', 'tab:selection', 'tab:move-block', 'tab:dragend', 'tab:dragcancel', 'translate:act',
  'passwords:act', // [passwords] the save bar and the key button (features/passwords.js)
  ...require('./features/background-runner').CHANNELS, // background tasks
]);
const isUiUrl = (url) => sameFileUrl(url, UI_URL);
const isUiSender = (event) => Boolean(ui()) && event.sender === ui()
  && event.senderFrame === event.sender.mainFrame && isUiUrl(event.senderFrame?.url);
// Tests drive some handlers with ipcMain.emit and a stand-in event (no real renderer behind it);
// a real message from a renderer always carries its live webContents.
const { webContents: webContentsModule } = require('electron');
const syntheticTestEvent = (event) => TEST
  && !(event?.sender && typeof event.sender.id === 'number' && webContentsModule.fromId(event.sender.id) === event.sender);
const trustedSender = (event, channel) => syntheticTestEvent(event) || isUiSender(event)
  || (PRIVILEGED_IPC.test(channel) && isSettingsSender(event))
  || Boolean(chatPageRt?.allows(event, channel)); // the chat page: only the chat calls (features/chat-page.js CHAT_IPC)
const gatedChannel = (channel) => PRIVILEGED_IPC.test(channel) || UI_ONLY_IPC.has(channel);
if (TEST) global.__ipcGate = { uiOnly: UI_ONLY_IPC, gated: gatedChannel, uiUrl: UI_URL };

// Lumen's own views (the UI, the suggestions dropdown, the dialogs overlay) show one local file
// each and nothing else: a link, drop or script can't navigate them, and window.open never makes a
// new window (which would inherit the view's preload). Web links open as ordinary tabs instead.
function hardenOwnView(wc, ownUrl) {
  wc.on('will-navigate', (event) => { if (!sameFileUrl(event.url, ownUrl)) event.preventDefault(); });
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (isWebUrl(url) && win && !win.isDestroyed()) openTab(url, { background: disposition === 'background-tab' });
    return { action: 'deny' };
  });
}

// Backstop for every webContents, including ones made later or by libraries: no <webview>, and
// nothing using the UI's preload may leave renderer/index.html.
const uiContents = new WeakSet();
ipcMain.on('ui-preload:loaded', (event) => { uiContents.add(event.sender); event.returnValue = true; });
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  // The UI window is registered when it's made, and preload.js registers any other view it runs in
  // (ui-preload:loaded). Failing both, a view showing the UI's own page is treated the same.
  const usesUiPreload = () => uiContents.has(contents) || isUiUrl(contents.getURL());
  contents.on('will-navigate', (event) => { if (!isUiUrl(event.url) && usesUiPreload()) event.preventDefault(); });
  contents.on('will-redirect', (event) => { if (!isUiUrl(event.url) && usesUiPreload()) event.preventDefault(); });
});
for (const method of ['handle', 'on']) {
  const register = ipcMain[method].bind(ipcMain);
  // With several browser windows, a message from one window's UI, tab, or overlay makes that window
  // the one the shared handlers below act on (see "browser windows" near createWindow).
  // A window kept ready for a tear-off (prepareDragWindow) is entered for its own message only: it never
  // becomes the window everything else acts on.
  const inSenderWindow = (event, run) => {
    const rec = winRecs.size > 1 ? recOfSender(event?.sender) : null;
    if (isSpare(rec)) return withWindow(rec, run);
    enterWindow(rec);
    return run();
  };
  ipcMain[method] = (channel, listener) => register(channel, !gatedChannel(channel) ? (event, ...args) => inSenderWindow(event, () => listener(event, ...args)) : (event, ...args) => inSenderWindow(event, () => {
    if (trustedSender(event, channel)) return listener(event, ...args);
    console.error(`[lumen] refused ${channel} from ${event.sender.getURL?.().slice(0, 80)}`);
    if (method === 'handle') throw new Error('Not allowed');
    return undefined;
  }));
}
let tabs = []; // { id, view, favicon }
let activeId = null;
let nextTabId = 1;
let contentBounds = { x: 0, y: 0, width: 800, height: 600 };
const closedTabs = []; // URLs, most recent last
const tabTools = require('./features/tab-tools').create({ onChange: () => sendTabs(), isWebUrl }); // tab search, tab audio

// ---------- settings / API key ----------

let settingsCache = null;
const settingsFile = require('./settings/settings-file'); // crash-safe read/write (see settings-file.js)

let settingsFileExisted = null; // (at this launch's first read: a fresh install has none, see features/setup.js)
function readSettings() {
  if (!settingsCache) {
    if (settingsFileExisted === null) settingsFileExisted = fs.existsSync(SETTINGS_FILE());
    settingsCache = settingsFile.loadJson(SETTINGS_FILE());
  }
  return { ...settingsCache };
}

let settingsGen = 0; // bumped by every write: an async write that is no longer the latest doesn't land
// Every change: the cache (what readSettings returns) at once, the file off the main thread (a synchronous write,
// with its fsync, backup and rename, took ~27 ms of input time for a bookmark star or a widget move).
let settingsPending = false; // an async write not yet known to be on disk
// [chat per tab] Set where the run slots exist: a changed cap acts at once (a higher one starts the chats waiting).
let onSettingsWritten = null;
function writeSettings(settings) {
  settingsCache = { ...settings };
  onSettingsWritten?.(settingsCache);
  settingsPending = true;
  const gen = ++settingsGen;
  settingsFile.writeJsonAtomicAsync(SETTINGS_FILE(), settingsCache, () => gen === settingsGen)
    .then(() => { if (gen === settingsGen) settingsPending = false; }); // (on disk: quitting has nothing left to write)
}
const writeSettingsAsync = writeSettings; // (the periodic session save)
// Tests that read settings.json straight off disk call this first: a write is off the main thread, so the file can lag the cache.
if (TEST) global.__settingsFlush = () => { if (settingsPending && settingsCache) writeSettingsNow(settingsCache); };
// Closing a window and quitting: on disk before the process can go away.
function writeSettingsNow(settings) {
  settingsCache = { ...settings };
  onSettingsWritten?.(settingsCache);
  settingsPending = false;
  settingsGen++;
  settingsFile.writeJsonAtomic(SETTINGS_FILE(), settings);
}
const aiSites = createAiSites({ readSettings, writeSettings });

// Performance mode (features/performance.js): the disk cache cap has to be set before the app is
// ready, and the weekly Code Cache check runs before Chromium opens that folder.
const perfMode = require('./features/performance').create({
  app, readSettings, powerMonitor: () => require('electron').powerMonitor,
  onChange: () => { try { settingsBackend.pushUiPrefs(); } catch { /* the UI isn't up yet */ } },
});
perfMode.applyLaunchSwitches();
try { require('./features/performance').trimCodeCache(app.getPath('userData'), perfMode.limits().codeCacheBytes); } catch (err) { console.error('[lumen] cache check failed:', err.message); }
if (TEST) global.__perfMode = perfMode;

// Favicons out of settings.json and into their own debounced/async store (see favicon-store.js) —
// settings.json is rewritten fully and synchronously, which a new favicon shouldn't have to pay for.
// One-time migration: move any favicons an older build saved inline, then drop the key for good.
const { createFaviconStore } = require('./browser/favicon-store');
const faviconStore = createFaviconStore(app.getPath('userData'), readSettings().favicons);
if (readSettings().favicons) {
  const { favicons, ...rest } = readSettings();
  writeSettings(rest);
}

// Outside AI agents (MCP, CDP automation, Claude Code): features/ai-agents.js. The automation
// switch must be set before ready.
const { setupAiAgents, prepareAutomation } = require('./features/ai-agents');
const automationPlan = earlyAutomation !== undefined ? earlyAutomation : prepareAutomation(app, readSettings());
// With automation on, this first process only starts Lumen again through launcher.js (which gives
// Chromium a private pipe instead of a debugging port) and leaves, before it opens anything. A copy
// started while Lumen runs passes its links on and quits, the same as without automation.
if (automationPlan?.relaunch && !process.argv.includes('--install-shortcuts')) {
  require('./automation/launcher').handOver(app, () => instance.acquireInstanceLock(app));
  return;
}

// The picker and every agent step look keys up, and each OS decrypt call costs a system round
// trip, so decrypted keys are remembered by their encrypted text (a new key is new text).
const decrypted = new Map();
function decryptKey(enc) {
  if (!decrypted.has(enc)) decrypted.set(enc, safeStorage.decryptString(Buffer.from(enc, 'base64')));
  return decrypted.get(enc);
}

function storedApiKey() {
  const { apiKeyEnc } = readSettings();
  if (!apiKeyEnc || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return decryptKey(apiKeyEnc);
  } catch {
    return null;
  }
}

// Keys for OpenAI, Grok and Gemini: settings.keys[provider], encrypted like the Anthropic key.
const ENV_KEYS = { openai: 'OPENAI_API_KEY', xai: 'XAI_API_KEY', gemini: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
const OPENROUTER_CACHE = () => path.join(app.getPath('userData'), 'openrouter-models.json');

// The Google Safe Browsing key: settings.keys.safebrowsing, encrypted like the others.
function safeBrowsingKey() {
  const enc = readSettings().keys?.safebrowsing;
  if (enc && safeStorage.isEncryptionAvailable()) {
    try { return decryptKey(enc); } catch {}
  }
  return process.env.GOOGLE_SAFE_BROWSING_API_KEY || null;
}

// [widgets] tokens for new-tab widgets (Todoist): settings.keys[`widget:${name}`], encrypted like
// the others. Only features/widgets.js asks for them, in this process; the page never sees them.
function widgetSecret(name) {
  const enc = readSettings().keys?.[`widget:${name}`];
  if (!enc || !safeStorage.isEncryptionAvailable()) return null;
  try { return decryptKey(enc); } catch { return null; }
}
function setWidgetSecret(name, value) {
  const settings = readSettings();
  const keys = { ...(settings.keys || {}) };
  if (value) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable, so Lumen can’t store the token safely.');
    keys[`widget:${name}`] = safeStorage.encryptString(String(value)).toString('base64');
  } else {
    delete keys[`widget:${name}`];
  }
  writeSettings({ ...settings, keys });
}

function providerKey(provider) {
  const enc = readSettings().keys?.[provider];
  if (enc && safeStorage.isEncryptionAvailable()) {
    try {
      return decryptKey(enc);
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
    providerModels[provider] = await providers.listModels(provider, key, { cacheFile: provider === 'openrouter' ? OPENROUTER_CACHE() : undefined, onRefresh: () => refreshModels(provider) });
  }
  modelsChanged(); // every sidebar, chat page and Settings
}

// Is the Anthropic API itself usable: a saved key, an env key, or an `ant auth login` profile.
// (Separate from Claude Code: that's a whole other CLI, gated by aiAgents' own detection.)
function anthropicUsable() {
  return Boolean(storedApiKey() || process.env.ANTHROPIC_API_KEY || (cliAuth.profileState().signedIn && cliLoginValid !== false));
}
// An `ant` profile's tokens can expire while its credentials file stays. After a request is refused
// for that reason (see the agent's describeError), the Claude models leave the picker until the user
// signs in again (cli:login resets this), instead of failing on every message.
let cliLoginValid = null;

// The picker: a model appears only if its provider is actually connected. No provider is
// privileged — connected API providers sort alphabetically by label, then local agent engines
// (Claude Code) last, so the list reads the same regardless of which one the user set up.
const modelNames = require('./features/model-names');
// [model fallback] ai/fallback.js: a model out of usage or unreachable is left alone for a while and another connected one answers.
const aiFallback = require('./ai/fallback');
const fallbackOn = () => readSettings().autoFallback !== false; // Settings > AI: Switch models automatically when one is unavailable
function modelOptions() {
  const groups = [];
  if (anthropicUsable()) groups.push({ label: 'Claude', entries: Object.entries(MODELS).sort(([a], [b]) => (b === DEFAULT_MODEL) - (a === DEFAULT_MODEL)).map(([id, { label, detail }]) => ({ id, label, name: label, provider: 'Claude', detail })) }); // the default first
  for (const [provider, info] of Object.entries(providers.PROVIDERS)) {
    if (!providerKey(provider)) continue;
    const list = [...(providerModels[provider] || info.defaults)];
    // OpenRouter: models picked from "More models…" (the last few) join the short list.
    const saved = providers.splitModel(readSettings().model || '');
    const recentOR = new Set();
    if (provider === 'openrouter') {
      // The model in use first (never folded away); catalog picks made lately after the curated ones (the picker's
      // own Recent section shows them at the top, so they aren't listed twice up there).
      if (saved.provider === 'openrouter' && typeof saved.model === 'string' && !list.includes(saved.model)) list.unshift(saved.model);
      for (const m of readSettings().recentOpenRouter || []) if (typeof m === 'string' && !list.includes(m)) { list.push(m); recentOR.add(m); }
    }
    const entries = list.map((model) => {
      const chatOnly = !providers.canUseTools(provider, model);
      // name: the readable model name the picker shows; badges: what it can't do or how settled it is. The raw id is the detail.
      // OpenRouter rows are named as OpenRouter names them (as its catalog shows them); the others from their id.
      const name = (provider === 'openrouter' && providers.openRouterName(model)) || modelNames.prettyModel(model) || model;
      const snap = modelNames.snapshotOf(model);
      const isFree = provider === 'openrouter' && (/:free$/.test(model) || providers.openRouterInfo(model)?.free || providers.openRouterInfo(model)?.pricePerM === 0);
      const badges = [...new Set([...(isFree ? ['free'] : []), ...modelNames.badgesFor(model, { chatOnly })])];
      const orInfo = provider === 'openrouter' ? providers.openRouterInfo(model) : null;
      const fmt = require('./renderer/picker-match').format; // the catalog's own rules ($1.25, 128K)
      const orDetail = orInfo ? [orInfo.context ? t('models.context', { n: fmt.size(orInfo.context) }) : '', orInfo.pricePerM < 0 ? t('models.priceVaries') : orInfo.pricePerM > 0 ? (orInfo.pricePerM < 0.01 ? t('models.priceTiny') : t('models.price', { n: fmt.money(orInfo.pricePerM) })) : ''].filter(Boolean).join(' · ') : '';
      return { id: `${provider}:${model}`, label: name, name, provider: info.label, badges, ...(recentOR.has(model) ? { recent: true } : {}), ...(orInfo ? { price: orInfo.pricePerM, context: orInfo.context, ...(typeof orInfo.vision === 'boolean' ? { vision: orInfo.vision } : {}) } : {}), detail: snap ? `Snapshot ${snap}` : orDetail, title: chatOnly ? `${model}\nCan’t act in your tabs` : model };
    });
    if (provider === 'openrouter') entries.push({ id: 'openrouter:__more', label: t('models.more'), name: t('models.more'), provider: info.label, detail: t('models.more.detail'), more: true });
    groups.push({ label: info.label, entries });
  }
  groups.sort((a, b) => a.label.localeCompare(b.label));
  const options = groups.flatMap((g) => g.entries.map((e) => ({ ...e, group: g.label })));
  options.push(...aiAgents.modelOptions()); // local engine(s) last: the user's own Claude Code CLI, when installed
  return options;
}

let client = null;
function getClient() {
  if (client) return client;
  const apiKey = storedApiKey();
  try {
    // With no stored key, the SDK falls back to ANTHROPIC_API_KEY or an `ant auth login` profile.
    const Anthropic = anthropicSdk();
    client = apiKey ? new Anthropic({ apiKey, fetch: netFetch() }) : new Anthropic({ fetch: netFetch() });
  } catch {
    throw new Error('No API key found. Use your Claude account through Claude Code (pick “Claude Code” in the model menu), or add an API key or sign in with OpenRouter in Settings.');
  }
  return client;
}

// ---------- dialogs: one Lumen-styled overlay instead of native message boxes (features/dialogs.js) ----------

const dialogs = createDialogs({
  win: () => win,
  paths: { preload: path.join(__dirname, 'preload', 'dialog-preload.js'), html: path.join(__dirname, 'renderer', 'dialog.html') },
  switchToContents: (wc) => { const tab = tabByContents(wc); if (tab) switchTab(tab.id); },
  isInFront: (wc) => { const tab = tabByContents(wc); return !tab || tab.id === activeId; },
  onPendingChange: () => { if (tabs.length) sendTabs(); }, // a tab's "dialog waiting" badge
  // A popup window's own page: its dialogs are drawn in the popup (null means the browser window).
  windowFor: (wc) => { const w = BrowserWindow.fromWebContents(wc); return w && w !== win && !w.isDestroyed() ? w : null; },
  restoreFocus: () => { const wc = activeTab()?.webContents; if (wc) wc.focus(); else ui()?.focus(); },
  openUrl: (url) => { if (win && !win.isDestroyed()) openTab(url); },
});
// Every existing `dialog.showMessageBox(...)` call (here, in settings-backend.js, features/downloads.js)
// now draws Lumen's own card; the native pickers (showOpenDialog etc., used only by settings-backend.js
// for the download folder) are untouched.
const dialog = { ...electronDialog, showMessageBox: dialogs.showMessageBox };
if (TEST) {
  global.__dialogs = dialogs;
  global.__closeTabInteractive = (id) => requestCloseTab(id);
}
ipcMain.on('dialog:respond', (event, result) => { if (dialogs.isOwnView(event.sender)) dialogs.respond(result); });

// ---------- what's new after an update (features/whats-new.js): once, over the first window ----------
const whatsNew = require('./features/whats-new').createWhatsNew({
  app, readSettings, writeSettings, t, test: TEST,
  showNotes: (opts) => dialogs.showNotes(opts),
});
if (TEST) global.__whatsNew = whatsNew;

// Take screenshot and QR code for the page (features/screenshot.js, features/qr.js), both drawn in one
// overlay per window (features/tool-overlay.js). Loaded on first use.
const toolOverlay = lazy(() => require('./features/tool-overlay').createToolOverlay({ ipcMain, WebContentsView }));
// This Electron's clipboard has no writeImage: images go through the web ClipboardItem API.
const copyImage = (image) => clipboard.write([new (require('electron').ClipboardItem)({ 'image/png': new Blob([image.toPNG()], { type: 'image/png' }) })]);
const screenshotTool = lazy(() => require('./features/screenshot').createScreenshot({
  overlay: toolOverlay, copyImage, nativeImage: require('electron').nativeImage, shell, screen, app, t,
  downloadDir: () => settingsBackend.downloadDir(),
  saveDir: () => (TEST && global.__screenshotDir) || null, // tests: a temp folder instead of Pictures
  showSaveDialog: (options, w) => (TEST && global.__pageToolsSaveDialog ? global.__pageToolsSaveDialog(options) : dialog.showSaveDialog(w || win, options)),
}));
const qrTool = lazy(() => require('./features/qr').createQr({
  overlay: toolOverlay, copyImage, nativeImage: require('electron').nativeImage, t,
  downloadDir: () => settingsBackend.downloadDir(),
  showSaveDialog: (options, w) => (TEST && global.__pageToolsSaveDialog ? global.__pageToolsSaveDialog(options) : dialog.showSaveDialog(w || win, options)),
}));
// What the tools need to know about a tab of this window (null when there is none).
function pageToolCtx(wc = activeTab()?.webContents) {
  const tab = wc && tabByContents(wc);
  if (!tab || !win || win.isDestroyed()) return null;
  return {
    wc, win, view: tab.view, isPrivate: false,
    restoreFocus: () => { if (!wc.isDestroyed()) wc.focus(); },
    askAi: (png) => { ui()?.send('attach-image', png.toString('base64')); }, // into the sidebar's composer
  };
}
const takeScreenshot = (wc) => { const ctx = pageToolCtx(wc); if (ctx) screenshotTool.open(ctx).catch(() => {}); };
const showQrCode = (wc, text, kind) => { const ctx = pageToolCtx(wc); if (ctx) qrTool.open(ctx, text ?? ctx.wc.getURL(), kind).catch(() => {}); };
if (TEST) global.__screenshot = { tool: screenshotTool, qr: qrTool, overlay: toolOverlay, ctx: pageToolCtx };

// Certificate errors and mixed content (features/site-security.js). Going past a bad certificate is
// only ever the user's answer in Lumen's own dialog, never a page's or the AI's.
const siteSecurity = createSiteSecurity({
  dialogs,
  win: () => win,
  isTab: (wc) => Boolean(tabByContents(wc)) || privateWindows.ownsTab(wc), // (a private window's tabs too)
  certUrl: CERT_URL,
  onChange: (wc) => { if (tabs.length) sendTabs(); if (wc) privateWindows.refresh(wc); },
});
app.on('certificate-error', siteSecurity.onCertificateError);
if (TEST) global.__siteSecurity = siteSecurity;

// ---------- browser basics: new window, page info, Save … As, Picture in Picture, shortcuts, crash recovery ----------
// Each lives in its own features/ file; these are the few lines that tie them to the window and tabs.

// File → New Window (Ctrl+N / Cmd+N): a normal window with one new tab (or `url`), cascaded from the one in front.
function openNewWindow(url = null) {
  if (![...winRecs].some(rcAlive)) dropDeadWindowViews(); // macOS: Lumen kept running with no window
  const src = [focusedRec(), curRec].find((r) => r && rcAlive(r) && winRecs.has(r) && !isSpare(r)) || null;
  const opts = { restore: { urls: url ? [url] : [] } };
  if (src) {
    const b = src.win.isMaximized() ? src.win.getNormalBounds() : src.win.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const fit = tabDragMath.fitToDisplay({ width: b.width, height: b.height }, area);
    const at = tabDragMath.placeOnWorkArea({ ...cascadedWindowPoint(src.win), width: fit.width, height: fit.height }, area);
    Object.assign(opts, { size: { width: at.width, height: at.height }, position: { x: at.x, y: at.y }, boundsFrom: src });
  }
  return createWindow(opts);
}
// Ctrl+Shift+W / Cmd+Shift+W: closes the window in front, tabs and all (it is saved for a restart like any closed window).
function closeCurrentWindow() {
  const target = focusedRec() || curRec;
  if (target && rcAlive(target)) target.win.close();
}

// Right-click → Save Link As… / Save Image As…: always asks where, whatever Settings → Downloads says (features/link-menu.js).
const linkMenu = require('./features/link-menu');
const saveAsMarks = linkMenu.createSaveAsMarks();
function saveUrlAs(wc, url) {
  if (!wc || wc.isDestroyed()) return;
  saveAsMarks.mark(url);
  wc.downloadURL(url);
}
const linkMenuDeps = (wc) => ({
  t,
  openInNewWindow: (url) => openNewWindow(url),
  openInPrivateWindow: isolatedOf(wc) ? null : (url) => privateWindows.open(url), // (not from a research tab's own session)
  saveAs: (url) => saveUrlAs(wc, url),
  copy: (text) => clipboard.writeText(text),
});

// Picture in Picture for the page's video (⋯ → This Page, View menu): the one playing or the largest; a note when there is none.
function togglePictureInPicture(wc) {
  if (!wc || wc.isDestroyed() || !isWebUrl(wc.getURL())) return;
  pageTools.togglePictureInPicture(wc.mainFrame, -1, -1)
    .then((r) => { if (r === 'none') organizeNote(t('pip.noVideo')); })
    .catch((err) => { console.error('[lumen] picture in picture:', err.message); organizeNote(t('pip.failed')); });
}

// The lock (or "Not secure") next to the address opens the site's page info (features/page-info.js).
const pageInfo = require('./features/page-info').createPageInfo({
  t,
  decisions: () => permissionDecisions, // (declared further down)
  savePermissions: () => settingsBackend.savePermissions(permissionDecisions),
  permissionDefault: (p) => settingsBackend.permissionDefault(p),
  confirm: async ({ message, detail, buttons }) => (await dialogs.showMessageBox(win, { type: 'question', message, detail, buttons, defaultId: 1, cancelId: 0 })).response === 1,
  openSiteSettings: () => openSettingsPage('site-permissions'),
  zoomOf: (host) => { const level = settingsBackend.siteZoom.levelFor(host); return level === null ? null : require('./features/site-zoom').percentOf(level); },
  resetZoom: () => zoomBy(activeTab()?.webContents, 0),
  popup: (template, point) => {
    if (!win || win.isDestroyed() || (TEST && global.__pageInfoNoPopup)) return;
    Menu.buildFromTemplate(template).popup({ window: win, ...(point && Number.isFinite(point.x) ? { x: Math.round(point.x), y: Math.round(point.y) } : {}) });
  },
});
function openPageInfo(point = null) {
  const wc = activeTab()?.webContents;
  if (!wc || wc.isDestroyed()) return Promise.resolve(null);
  return pageInfo.open({ url: realUrl(wc), ses: wc.session, security: siteSecurity.stateOf(wc), point });
}
ipcMain.on('page-info:open', (_e, point) => openPageInfo(point && typeof point === 'object' ? point : null)); // (UI-only: UI_ONLY_IPC)

// Keyboard Shortcuts (⋯ menu, Help menu, Ctrl+Shift+/): the list in Lumen's own dialog (features/shortcuts-help.js).
const shortcutsHelp = require('./features/shortcuts-help').createShortcutsHelp({ t, showNotes: (opts) => dialogs.showNotes(opts) });

// "Lumen didn't shut down correctly": offers the last run's tabs when the startup setting wouldn't bring them back (features/crash-recovery.js).
const crashRecovery = require('./features/crash-recovery').createCrashRecovery({
  file: () => path.join(app.getPath('userData'), 'running'),
  readSettings: () => readSettings(),
});
async function offerCrashRestore() {
  const kept = crashRecovery.take();
  const rec = curRec;
  if (!kept || !rec) return false;
  const { response } = await dialogs.showMessageBox(win, {
    type: 'question',
    message: t('recovery.title'),
    detail: t(kept.tabs === 1 ? 'recovery.detail.one' : 'recovery.detail', { n: kept.tabs }),
    buttons: [t('recovery.notNow'), t('recovery.restore')], defaultId: 1, cancelId: 0,
  });
  if (response !== 1 || !rcAlive(rec) || !winRecs.has(rec)) return false;
  withWindow(rec, () => {
    const blank = tabs.filter((x) => alive(x) && isNewTab(x.view.webContents.getURL())).map((x) => x.id); // the new tab Lumen started with
    restoreTabsFrom(kept.saved);
    for (const id of blank) if (tabs.length > 1) closeTab(id);
  });
  for (const more of (Array.isArray(kept.saved.more) ? kept.saved.more : []).slice(0, 9)) createWindow({ restore: more });
  return true;
}

// macOS: Lumen → About Lumen shows the version and what it is built on, not Electron's defaults.
function setAboutPanel() {
  if (typeof app.setAboutPanelOptions !== 'function') return;
  app.setAboutPanelOptions({
    applicationName: 'Lumen',
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}`,
    copyright: t('about.copyright'),
    website: 'https://github.com/emah-maker/lumen',
  });
}
if (TEST) global.__basics = { openNewWindow, closeCurrentWindow, saveAsMarks, linkMenu, linkMenuDeps, togglePictureInPicture, pageInfo, openPageInfo, shortcutsHelp, crashRecovery, offerCrashRestore };

// Google Safe Browsing (features/safe-browsing.js): off unless the user turns it on and adds a key.
// Its requests go through a separate in-memory session, so Google never gets the user's cookies.
const safeBrowsing = createSafeBrowsing({
  readSettings,
  apiKey: () => safeBrowsingKey(),
  dir: () => path.join(app.getPath('userData'), 'safe-browsing'),
  fetch: (url) => session.fromPartition('lumen-safe-browsing').fetch(url, { cache: 'no-store' }),
  isTab: (wc) => Boolean(tabByContents(wc)) || privateWindows.ownsTab(wc), // (a private window's tabs too)
  dialogs,
  win: () => win,
  warnUrl: SAFE_BROWSING_URL,
  baseUrl: TEST ? process.env.LUMEN_SAFE_BROWSING_URL || undefined : undefined,
});
if (TEST) global.__safeBrowsing = safeBrowsing;

// HTTP Basic/Digest auth: a styled sign-in sheet instead of the native prompt.
app.on('login', (event, webContents, details, authInfo, callback) => {
  event.preventDefault();
  const insecure = !authInfo.isProxy && !/^https:/i.test(details.url) ? t('dialog.signIn.insecure') : '';
  dialogs.ask({
    message: t('dialog.signIn'),
    detail: `${t(authInfo.realm ? 'dialog.signIn.detailRealm' : 'dialog.signIn.detail', { host: authInfo.host, realm: authInfo.realm })}${insecure}`,
    fields: [{ name: 'username', label: t('dialog.username') }, { name: 'password', label: t('dialog.password'), type: 'password' }],
    buttons: [t('dialog.cancel'), t('dialog.signIn.button')],
    defaultId: 1,
    cancelId: 0,
    owner: webContents,
  }).then(({ response, values }) => {
    if (response === 1 && values) callback(values.username, values.password);
    else callback();
  });
});

// ---------- page dialogs: window.alert/confirm/prompt (page-dialogs-preload.js) ----------

// Per-page-load state: how many dialogs it has shown, and whether the user muted further ones
// (like Chrome, offered from the 2nd dialog on). Cleared on navigation or when the tab closes.
const pageDialogState = new Map(); // webContents id -> { count, muted }
const pageDialogWired = new WeakSet(); // each webContents gets its reset listeners once, not once per page
function pageDialogEntry(wc) {
  let entry = pageDialogState.get(wc.id);
  if (!entry) {
    entry = { count: 0, muted: false };
    pageDialogState.set(wc.id, entry);
    if (!pageDialogWired.has(wc)) {
      pageDialogWired.add(wc);
      const id = wc.id;
      wc.once('destroyed', () => pageDialogState.delete(id));
      wc.on('did-start-navigation', (details) => { if (details.isMainFrame && !details.isSameDocument) pageDialogState.delete(id); });
    }
  }
  return entry;
}
// `sendSync`: the page stays blocked until `event.returnValue` is set, exactly like the real
// alert()/confirm()/prompt(). Only tabs and popups (default session) get this preload at all.
ipcMain.on('page-dialog', (event, req) => {
  const wc = event.sender;
  const silence = () => { event.returnValue = req.kind === 'confirm' ? false : req.kind === 'prompt' ? null : undefined; };
  if (dialogs.isOwnView(wc)) return silence(); // ignore requests from the overlay itself
  const entry = pageDialogEntry(wc);
  if (entry.muted) return silence();
  entry.count += 1;
  // Named after the frame that asked, not the tab: an ad or other embedded frame's alert must not
  // appear to come from the site itself.
  let host;
  try { host = new URL(event.senderFrame?.url || realUrl(wc) || wc.getURL()).host; } catch { host = ''; }
  const embedded = event.senderFrame && event.senderFrame !== wc.mainFrame;
  const title = host ? (embedded ? `An embedded page at ${host} says` : `${host} says`) : '';
  const checkboxLabel = entry.count > 1 ? t('dialog.muteDialogs') : '';
  const finish = (value, checkboxChecked) => {
    if (checkboxChecked) entry.muted = true;
    event.returnValue = value;
  };
  if (req.kind === 'prompt') {
    dialogs.ask({
      title, message: req.message, fields: [{ name: 'value', value: req.defaultValue || '' }],
      buttons: [t('dialog.cancel'), t('dialog.ok')], defaultId: 1, cancelId: 0, owner: wc, checkboxLabel,
    }).then(({ response, values, checkboxChecked }) => finish(response === 1 && values ? values.value : null, checkboxChecked));
  } else if (req.kind === 'confirm') {
    dialogs.showMessageBox(win, {
      title, message: req.message, buttons: [t('dialog.cancel'), t('dialog.ok')], defaultId: 1, cancelId: 0, owner: wc, checkboxLabel,
    }).then(({ response, checkboxChecked }) => finish(response === 1, checkboxChecked));
  } else {
    dialogs.showMessageBox(win, {
      title, message: req.message, buttons: [t('dialog.ok')], defaultId: 0, cancelId: 0, owner: wc, checkboxLabel,
    }).then(({ checkboxChecked }) => finish(undefined, checkboxChecked));
  }
});
// Registered once the app (and so session.defaultSession) exists; a separate whenReady hook so it
// doesn't touch the app's main startup sequence.
app.whenReady().then(() => {
  session.defaultSession.registerPreloadScript({ id: 'lumen-page-dialogs', type: 'frame', filePath: path.join(__dirname, 'preload', 'page-dialogs-preload.js') });
  // Dropdown menus stay readable on dark-styled sites (features/select-contrast-preload.js).
  session.defaultSession.registerPreloadScript({ id: 'lumen-select-contrast', type: 'frame', filePath: path.join(__dirname, 'features', 'select-contrast-preload.js') });
  // Google in a dark theme paints dark from the first frame (features/google-dark-preload.js).
  session.defaultSession.registerPreloadScript({ id: 'lumen-google-dark', type: 'frame', filePath: path.join(__dirname, 'features', 'google-dark-preload.js') });
  // The AI's hidden reader/search views (agent.js, partition 'claude-reader') load pages nobody
  // sees: they get no permissions at all (camera, location, notifications, …) and no downloads.
  const reader = session.fromPartition('claude-reader');
  reader.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  reader.setPermissionCheckHandler(() => false);
  reader.on('will-download', (event, item) => { event.preventDefault(); try { item.cancel(); } catch {} });
});

// ---------- permissions: ask like Safari, remember per origin ----------

const ALWAYS_ALLOWED = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'mediaKeySystem', 'display-capture']); // display-capture: the screen picker (pickScreenToShare) is the consent
const PROMPTABLE = {
  media: 'use your camera and microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  'clipboard-read': 'read your clipboard',
};
const permissionDecisions = new Map(); // `${origin}|${permission}` -> boolean

function setupPermissions() {
  const ses = session.defaultSession;
  settingsBackend.loadPermissions(permissionDecisions); // [settings] decisions persist in settings.json

  ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    if (spotifyWeb.owns(wc)) return callback(SW.permissionAllowed(permission)); // [widgets] Spotify's card: protected media only, never a prompt
    if (ALWAYS_ALLOWED.has(permission)) return callback(true);
    if (permission === 'openExternal') return callback(await askOpenExternal(wc, details));
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
    if (settingsBackend.permissionDefault(permission) === 'block') return callback(false); // [settings] default: Block
    // Tied to the asking tab: it waits while that tab is in the background, and is dropped (not
    // remembered as a "no") if the tab navigates away or closes first.
    const { response, cancelled } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [t('permission.deny'), t('permission.allow')],
      defaultId: 0,
      cancelId: 0,
      message: t('permission.ask', { host: new URL(origin).host, reason: t(`permission.${permission}`) }),
      owner: wc,
    });
    if (cancelled) return callback(false);
    permissionDecisions.set(key, response === 1);
    settingsBackend.savePermissions(permissionDecisions); // [settings]
    callback(response === 1);
  });
  ses.setPermissionCheckHandler((wc, permission, origin) =>
    spotifyWeb.owns(wc) ? SW.permissionAllowed(permission) : ALWAYS_ALLOWED.has(permission) || permissionDecisions.get(`${origin}|${permission}`) === true);
  ses.setDisplayMediaRequestHandler(pickScreenToShare);
}

// Links for other apps (mailto:, tel:, zoommtg:, slack:, …) did nothing, because every
// permission not on the list above was refused. Now they ask first, as Chrome does: "Open the app
// for mailto: links?", remembered for the site until Lumen quits. Schemes that reach local files,
// run script, or are known to launch Windows tools with attacker-chosen input are never opened.
const BLOCKED_SCHEMES = new Set(['file', 'javascript', 'vbscript', 'data', 'blob', 'filesystem', 'about', 'chrome', 'chrome-extension', 'devtools', 'view-source', 'jar', 'res', 'hcp', 'shell', 'search', 'search-ms', 'ms-msdt', 'ms-officecmd', 'ms-appinstaller', 'ms-cxh', 'ms-cxh-full', 'ms-settings', 'lumen']);
const externalDecisions = new Map(); // `${origin}|${scheme}` -> true (allowed for this session)
async function askOpenExternal(wc, details, decisions = externalDecisions) { // decisions: a private window keeps its own
  let scheme;
  let origin = '';
  try { scheme = new URL(details.externalURL).protocol.slice(0, -1).toLowerCase(); } catch { return false; }
  try { origin = new URL(details.requestingUrl || wc.getURL()).origin; } catch {}
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme) || BLOCKED_SCHEMES.has(scheme)) return false;
  const key = `${origin}|${scheme}`;
  if (decisions.get(key)) return true;
  let host = '';
  try { host = new URL(origin).host; } catch {}
  const label = ['mailto', 'tel', 'sms'].includes(scheme) ? t(`external.${scheme}`) : t('external.other', { scheme });
  const { response, cancelled } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: [t('dialog.cancel'), t('external.open')],
    defaultId: 1,
    cancelId: 0,
    message: t('external.ask', { app: label }),
    detail: host ? t('external.detail', { host, app: label }) : t('external.detailPage', { app: label }),
    owner: wc,
  });
  if (cancelled || response !== 1) return false;
  decisions.set(key, true);
  return true;
}

// Screen sharing (Meet, Zoom, Teams on the web) failed outright: there was no handler for
// getDisplayMedia. The user picks an entire screen or one window from a menu of thumbnails;
// closing the menu shares nothing. `owner`: the window asking, when it isn't the current one (a private window).
async function pickScreenToShare(request, callback, owner = null) {
  const shown = owner && !owner.isDestroyed() ? owner : win;
  let done = false;
  const answer = (streams) => { if (!done) { done = true; callback(streams); } };
  try {
    const { desktopCapturer, nativeImage } = require('electron');
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 96, height: 60 }, fetchWindowIcons: false });
    const lumen = shown && !shown.isDestroyed() ? shown.getMediaSourceId() : '';
    const pickable = sources.filter((s) => s.id !== lumen);
    if (!pickable.length || !shown || shown.isDestroyed()) return answer({});
    let host = '';
    try { host = new URL(request.securityOrigin || request.frame?.url || '').host; } catch {}
    let picked = null;
    const item = (s, label) => ({ label, icon: s.thumbnail.isEmpty() ? undefined : nativeImage.createFromBuffer(s.thumbnail.toPNG()).resize({ width: 48 }), click: () => { picked = s; } });
    const screens = pickable.filter((s) => s.id.startsWith('screen:'));
    const windows = pickable.filter((s) => s.id.startsWith('window:'));
    Menu.buildFromTemplate([
      { label: host ? t('menu.shareWith', { host }) : t('menu.shareScreen'), enabled: false },
      ...screens.map((s, i) => item(s, screens.length > 1 ? t('menu.entireScreenN', { n: i + 1 }) : t('menu.entireScreen'))),
      ...(windows.length ? [{ type: 'separator' }] : []),
      ...windows.slice(0, 20).map((s) => item(s, s.name.length > 60 ? `${s.name.slice(0, 59)}…` : s.name)),
      { type: 'separator' },
      { label: t('menu.cancel') },
    ]).popup({
      window: shown,
      // The click runs just after the menu closes; give it a moment before answering.
      callback: () => setTimeout(() => answer(picked ? { video: picked, ...(request.audioRequested && process.platform === 'win32' && picked.id.startsWith('screen:') ? { audio: 'loopback' } : {}) } : {}), 50),
    });
  } catch (err) {
    console.error('[lumen] screen sharing picker failed:', err.message);
    answer({});
  }
}

// ---------- Chrome extensions (installed from the Chrome Web Store) ----------

let extensions = null;
// A tab whose page was destroyed (e.g. it called window.close()) has no webContents any more.
const alive = (tab) => Boolean(tab?.view?.webContents) && !tab.view.webContents.isDestroyed();
const tabByContents = (wc) => tabs.find((t) => alive(t) && t.view.webContents === wc);
// The extension library reports every newly added tab as activated; ignore those echoes so
// background tabs stay in the background and our own switches don't loop back.
// Tab groups share the tabs array; grouped tabs are kept contiguous by tabGroups.arrange().
// What Organize learned from drags and renames (host / topic word -> group name), kept in the profile.
const organizeLearner = organizeLearn.createLearner({
  load: () => readSettings().organizeLearning,
  save: (state) => writeSettings({ ...readSettings(), organizeLearning: state }),
});
const tabGroups = createTabGroups({
  learned: organizeLearner,
  getTabs: () => tabs,
  setTabs: (list) => { tabs = list; },
  // A sleeping / restored-but-unloaded tab has no webContents; its stored URL and title stand in, so it can be grouped.
  urlOf: (t) => (alive(t) ? realUrl(t.view.webContents) : t.sleepUrl || ''),
  titleOf: (t) => (alive(t) ? t.view.webContents.getTitle() : t.sleepTitle || ''),
  textOf: (t) => t.pageText || '', // the page's description / first heading (see readPageText)
  isWeb: (url) => isWebUrl(url),
  mode: () => groupingMode(),
  aiTopics: () => readSettings().topicAi === true,
});
// Automatic grouping: 'off' | 'site' | 'topic'. Before topics it was a switch (autoGroupTabs).
function groupingMode() {
  const { tabGrouping, autoGroupTabs } = readSettings();
  return ['off', 'site', 'topic'].includes(tabGrouping) ? tabGrouping : autoGroupTabs === false ? 'off' : 'topic'; // default: by topic (a site's tabs that share a topic still end up together)
}
let autoGroupTimer = null;
// By topic, titles alone are often too short to link one topic across sites (MDN, Stack Overflow
// and GitHub pages about one library). After a page loads, its meta description and first heading
// join its words. Read in an isolated world, so the page can't see or tamper with the read.
const PAGE_TEXT_WORLD = 1001;
function readPageText(tab) {
  const wc = tab.view.webContents;
  if (groupingMode() !== 'topic' || !isWebUrl(realUrl(wc))) return;
  wc.executeJavaScriptInIsolatedWorld(PAGE_TEXT_WORLD, [{ code: `[document.querySelector('meta[name="description"],meta[property="og:description"]')?.content || '', document.querySelector('meta[name="keywords"]')?.content || '', document.querySelector('meta[property="og:title"]')?.content || '', document.querySelector('h1')?.textContent || ''].join(' ').replace(/\\s+/g, ' ').trim().slice(0, 300)` }])
    .then((text) => {
      if (!alive(tab) || typeof text !== 'string' || text === tab.pageText) return;
      tab.pageText = text;
      scheduleAutoGroup();
    })
    .catch(() => {});
}
function scheduleAutoGroup() {
  clearTimeout(autoGroupTimer);
  autoGroupTimer = setTimeout(() => {
    if (tabGroups.autoGroup()) sendTabs();
    if (groupingMode() === 'topic' && readSettings().topicAi === true) scheduleAiTopics();
    scheduleAutoOrganize();
  }, groupingMode() === 'topic' ? 1500 : 400); // after the title usually arrives; by topic waits a little longer for the page text
}

let ignoreExtensionSelect = false;
function syncExtensions(fn) {
  ignoreExtensionSelect = true;
  try { fn(); } finally { ignoreExtensionSelect = false; }
}

// ---------- ad blocker (features/adblock.js) ----------

const adblock = createAdblock({
  peekSettings: () => settingsCache || readSettings(), // (read on every request: no copy)
  app, session, readSettings, writeSettings, isWebUrl,
  activeContents: () => activeTab()?.webContents,
  realUrl: (wc) => realUrl(wc),
  onResponseHeaders: (details) => settingsBackend.noteResponseHeaders(details),
  mainFrameGate: (details, callback) => safeBrowsing.gate(details, callback), // pages, before they load
});

// ---------- private windows (features/private-window.js) ----------
// Native dialogs there for permissions and downloads; Safe Browsing and certificate warnings use Lumen's
// own (features/dialogs.js draws them in the private window, the tab's own window).
const privateWindows = createPrivateWindows({
  BrowserWindow, WebContentsView, session, ipcMain, dialog: electronDialog, isWebUrl, Menu, clipboard, shell,
  resolveInput: (text) => resolveInput(text), iconPath: WINDOW_ICON,
  t, strings: () => i18n().strings, locale: () => i18n().locale,
  testBackground: TEST && Boolean(process.env.LUMEN_TEST_BACKGROUND), // (TEST_BACKGROUND is declared further down)
  screenshot: (ctx) => screenshotTool.open(ctx), // Ctrl+Shift+S in a private window (copies; Save as… is offered)
  // The protections a normal tab has: Safe Browsing (until the ad blocker takes over onBeforeRequest, which
  // sends pages to the same gate), the ad blocker's filters, readable dropdowns, and the profile's proxy,
  // Do Not Track / Global Privacy Control, languages and Chrome hints.
  prepareSession: (ses) => {
    ses.webRequest.onBeforeRequest((details, callback) => safeBrowsing.gate(details, callback));
    ses.registerPreloadScript({ id: 'lumen-select-contrast', type: 'frame', filePath: path.join(__dirname, 'features', 'select-contrast-preload.js') });
    settingsBackend.mirrorSession(ses);
    adblock.attachSession(ses);
  },
  releaseSession: (ses) => { adblock.detachSession(ses); settingsBackend.unmirrorSession(ses); },
  // Each private tab: HTTPS-only and the default zoom, Safe Browsing's and the certificate warning's way past,
  // mixed-content reports, and the error pages a normal tab shows (offline, unsafe, bad certificate, crashed).
  prepareTab: (wc) => {
    settingsBackend.attachTab(wc);
    safeBrowsing.attachTab(wc);
    siteSecurity.attachTab(wc);
    tabFailPage(wc);
  },
  tabWebPreferences: () => settingsBackend.tabWebPreferences(false), // font sizes, spell check, plugins for protected video
  // Permissions as in a normal window, except that answers are kept for the window only: Settings' "Block" defaults,
  // the screen-sharing picker (over the private window), and "Open the app for mailto: links?".
  permissionDefault: (permission) => settingsBackend.permissionDefault(permission),
  pickScreen: (request, callback, owner) => pickScreenToShare(request, callback, owner),
  askOpenExternal: (wc, details, decisions) => askOpenExternal(wc, details, decisions),
  defaultZoom: () => settingsBackend.prefs().defaultZoom,
  realUrl: (wc) => realUrl(wc),
  securityState: (wc) => siteSecurity.stateOf(wc),
  zoom: (wc, step) => zoomBy(wc, step),
  searchFor: (text) => ({ engine: engineFor(readSettings().searchEngine).label, url: searchUrlFor(readSettings().searchEngine, text) }),
  downloadDir: () => settingsBackend.downloadDir(), // [settings] Downloads folder unless changed in Settings
  askWhereToSave: () => settingsBackend.askWhereToSave(),
  // Settings (Cmd+,) open in a normal window, as Chrome does from Incognito.
  openSettings: () => { const rec = focusedRec(); if (!rec) return; enterWindow(rec); openSettingsPage(); rec.win.show(); rec.win.focus(); },
  onFocusChange: () => refreshWindowMenu(), // the macOS menu bar's commands follow the focused window
  // Private tabs present themselves as Chrome too (the same identity and request headers as normal tabs), or
  // Google sign-in in a private window is refused as an unknown browser.
  chromeIdentity: (wc) => applyChromeIdentity(wc),
  // A getter: UA_HINT_HEADERS is declared further down, so reading it here at load time threw
  // (a ReferenceError before initialization) and Lumen never opened a window.
  get chromeHintHeaders() { return UA_HINT_HEADERS; },
  // Its sign-in popups behave as normal ones: page settings, an error page when a load fails, the "Google refused" note.
  popupWebPreferences: () => settingsBackend.tabWebPreferences(false),
  popupFailPage: (wc) => popupFailPage(wc),
  googleRefusedGuard: (wc, opts) => googleRefusedGuard(wc, opts),
  popupBackground: () => (nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff'),
});
if (TEST) global.__private = privateWindows;

// Refused at install: extensions whose core job is filtering requests with static
// declarativeNetRequest rulesets (Electron can't apply them, so they would silently do nothing).
// Extensions that only use the API for small things (password managers etc.) install, and get the
// in-memory chrome.declarativeNetRequest from extensions-dnr-preload.js.
function isContentBlocker(manifest = {}, name = '') {
  const rulesets = manifest.declarative_net_request?.rule_resources || [];
  if (!rulesets.some((r) => r.enabled)) return false;
  const text = `${name} ${manifest.name || ''} ${manifest.description || ''}`;
  return /ad ?block|\bads\b|\bblock(er|ing|s)?\b|ublock|tracker|\bfilter|privacy badger|ghostery|content block/i.test(text);
}

async function setupExtensions() {
  const ses = session.defaultSession;
  // Before the extension library's own preload, which freezes `chrome` (see the preload's note).
  for (const type of ['frame', 'service-worker']) ses.registerPreloadScript({ id: `lumen-dnr-${type}`, type, filePath: path.join(__dirname, 'preload', 'extensions-dnr-preload.js') });
  // Keeps the store page off Electron's native webstorePrivate, which crashes Lumen (see the file).
  ses.registerPreloadScript({ id: 'lumen-webstore', type: 'frame', filePath: path.join(__dirname, 'features', 'webstore-preload.js') });
  // Keeps the library's extension APIs out of Chromium's own PDF viewer, which they broke (see the file).
  ses.registerPreloadScript({ id: 'lumen-pdf-viewer', type: 'frame', filePath: path.join(__dirname, 'features', 'pdf-viewer-preload.js') });
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
      // A tall popup (up to 600px) on a short screen ran below the taskbar: stop it at the work
      // area's bottom and let the popup's page scroll, as Chrome does.
      const area = screen.getDisplayMatching(b).workArea;
      const height = Math.min(b.height, Math.max(120, area.y + area.height - 8 - b.y));
      if (x !== b.x || height !== b.height) view.setBounds({ ...b, x, height });
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
  // Lists what it asks for (all sites, history, downloads, …) before anything is installed.
  const extensionAsks = (manifest) => {
    const lines = extensionPermissionLines(manifest);
    return lines.length ? `${t('extension.canDo')}\n${lines.map((l) => `• ${l}`).join('\n')}` : t('extension.noPermissions');
  };
  await installChromeWebStore({
    session: ses,
    loadExtensions: false, // (loaded below: registered before the first tabs, their workers started after)
    autoUpdate: false, // (checked below, once they are loaded)
    beforeInstall: async ({ localizedName, manifest }) => {
      if (isContentBlocker(manifest, localizedName)) {
        await dialog.showMessageBox(win, {
          type: 'info',
          message: t('extension.cantAdd', { name: localizedName }),
          detail: t('extension.cantAdd.detail'),
        });
        return { action: 'deny' };
      }
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: [t('dialog.cancel'), t('extension.add.button')],
        defaultId: 1,
        cancelId: 0,
        message: t('extension.add', { name: localizedName }),
        detail: `${extensionAsks(manifest)}${(manifest.permissions || []).includes('nativeMessaging') ? `\n\n${t('extension.nativeMessaging')}` : ''}`,
      });
      return { action: response === 1 ? 'allow' : 'deny' };
    },
  });
  // Installed extensions: registered now (tabs are created with them in chrome.tabs); their background service
  // workers, which took ~100-500 ms each one after another before the first tab, start once the tabs are going.
  const workerScopes = [];
  await loadAllExtensions({ extensions: ses.extensions, serviceWorkers: { startWorkerForScope: (scope) => { workerScopes.push(scope); return Promise.resolve(); } } },
    path.join(app.getPath('userData'), 'Extensions'));
  tabsGate.then(() => setTimeout(() => { for (const scope of workerScopes) ses.serviceWorkers.startWorkerForScope(scope).catch(() => console.error(`Failed to start worker for ${scope}`)); }, 300));
  // Store extensions' updates: looked for once the first tab has loaded, then every 5 hours, as the library did.
  const checkUpdates = () => updateExtensions(ses).catch((err) => console.error('[lumen] extension update check failed:', err?.message || err));
  firstTabLoaded.then(() => setTimeout(checkUpdates, 30000).unref?.());
  setInterval(checkUpdates, 5 * 60 * 60 * 1000).unref?.();
}

function extensionsMenu() {
  const installed = session.defaultSession.extensions.getAllExtensions()
    .filter((ext) => ext.manifest.name && !ext.id.startsWith('chrome-web-store'));
  const items = installed.map((ext) => ({
    label: ext.name,
    submenu: [
      ...(ext.manifest.options_page || ext.manifest.options_ui
        ? [{ label: t('menu.options'), click: () => openTab(`chrome-extension://${ext.id}/${ext.manifest.options_ui?.page || ext.manifest.options_page}`) }]
        : []),
      {
        label: t('menu.remove'),
        click: async () => {
          const { response } = await dialog.showMessageBox(win, {
            type: 'question', buttons: [t('dialog.cancel'), t('extension.remove.button')], defaultId: 1, cancelId: 0, message: t('extension.remove', { name: ext.name }),
          });
          if (response === 1) await uninstallExtension(ext.id, { session: session.defaultSession }).catch(() => {});
        },
      },
    ],
  }));
  if (items.length) items.push({ type: 'separator' });
  items.push({ label: t('menu.getExtensions'), click: () => openTab('https://chromewebstore.google.com/') });
  return items;
}

// The ⋯ menu. Its sections are listed flat, as they show on a tall window; on a short window or
// screen features/app-menu-layout.js folds the marked ones into submenus (More Tools first, then the
// page commands, zoom, the tab extras and the AI entries) until it fits below the button, so it
// doesn't open with scroll arrows or run past the window. { x, y, right } is the button's left,
// bottom and right edge in the UI's window coordinates (`right` is missing from older callers).
function showAppMenu({ x, y, right }) {
  const wc = activeTab()?.webContents;
  const web = isWebUrl(wc?.getURL());
  const chunk = (items, id, label, order) => ({ items, fold: id ? { id, label, order } : null });
  const more = (items) => chunk(items, 'more', t('menu.moreTools'), 1);
  const groups = [
    [
      chunk([
        { label: t('menu.newTab'), accelerator: 'CmdOrCtrl+T', click: () => openTab() },
        { label: t('menu.newWindow'), accelerator: 'CmdOrCtrl+N', click: () => openNewWindow() },
        { label: t('menu.newPrivateWindow'), accelerator: 'CmdOrCtrl+Shift+N', click: () => privateWindows.open() },
      ]),
      chunk([
        { label: t('menu.reopenTab'), accelerator: 'CmdOrCtrl+Shift+T', enabled: closedTabs.length > 0, click: () => openTab(closedTabs.pop()) },
        { label: t('menu.searchTabs'), accelerator: 'CmdOrCtrl+Shift+A', click: openTabSearch },
        { label: t('menu.openFile'), accelerator: 'CmdOrCtrl+O', click: openFileDialog },
        ...mergeWindowItems(curRec),
      ], 'tabs', t('menu.tabsAndFiles'), 4),
      chunk([
        { label: t('menu.newSidebarChat'), accelerator: 'CmdOrCtrl+Shift+K', click: newSidebarChat },
        { label: t('menu.openChatPage'), accelerator: 'CmdOrCtrl+Shift+L', click: toggleChatPage },
        ...bgTasks.menuItems(wc?.getURL()), // Run in the background, Watch this page, Background tasks
      ], 'ai', t('menu.aiAndTasks'), 5),
    ],
    [
      chunk([{ label: t('menu.find'), accelerator: 'CmdOrCtrl+F', click: () => { ui()?.focus(); ui()?.send('find:open'); } }]),
      chunk([
        { label: t('menu.zoomIn'), accelerator: 'CmdOrCtrl+=', click: () => zoomBy(wc, 0.5) },
        { label: t('menu.zoomOut'), accelerator: 'CmdOrCtrl+-', click: () => zoomBy(wc, -0.5) },
        { label: t('menu.actualSize'), accelerator: 'CmdOrCtrl+0', click: () => zoomBy(wc, 0) },
        ...(process.platform === 'darwin' ? [] : [{ label: t('menu.fullScreen'), accelerator: 'F11', click: () => win.setFullScreen(!win.isFullScreen()) }]),
      ], 'zoom', t('menu.zoom'), 3),
      chunk([
        { label: t('menu.print'), accelerator: 'CmdOrCtrl+P', enabled: Boolean(wc), click: () => wc?.print({}, () => {}) },
        { label: t('menu.savePageAs'), accelerator: 'CmdOrCtrl+S', enabled: web, click: () => pageTools.savePage(wc).catch(() => {}) },
        { label: t('menu.viewSource'), accelerator: 'CmdOrCtrl+U', enabled: web, click: () => pageTools.viewSource(wc.getURL(), { session: wc.session, openerId: activeId }) },
        { label: t('menu.screenshot'), accelerator: 'CmdOrCtrl+Shift+S', enabled: web, click: () => takeScreenshot(wc) },
        { label: t('menu.qrCode'), enabled: web, click: () => showQrCode(wc) },
        { label: t('menu.readerMode'), type: 'checkbox', checked: pageTools.page(wc?.getURL()) === 'reader', enabled: Boolean(tabs.find((t) => t.id === activeId)?.readerable) || pageTools.page(wc?.getURL()) === 'reader', click: () => toggleReaderActive() },
        ...translate.pageMenuItem(tabs.find((x) => x.id === activeId && alive(x))),
        { label: t('menu.pictureInPicture'), enabled: web, click: () => togglePictureInPicture(wc) },
        { label: t('menu.siteInfo'), enabled: web, click: () => openPageInfo() },
      ], 'page', t('menu.thisPage'), 2),
    ],
    [
      chunk([
        { label: t('menu.bookmarks'), submenu: bookmarksMenu() },
        { label: t('menu.history'), submenu: historyMenu() },
        { label: t('menu.downloads'), submenu: [{ label: t('menu.showAllDownloads'), accelerator: process.platform === 'darwin' ? 'Alt+Cmd+L' : 'Ctrl+Shift+J', click: () => managers.open('downloads') }, { type: 'separator' }, ...downloads.menu()] },
      ]),
    ],
    [
      more([
        { label: t('menu.tabGroups'), submenu: tabGroupsMenu() },
        { label: t('menu.searchEngine'), submenu: searchEngineMenu() },
        { label: t('menu.import'), submenu: importMenu() },
        { label: t('menu.adBlocker'), submenu: adblock.menu() },
        { label: t('menu.extensions'), submenu: extensionsMenu() },
      ]),
      chunk([{ label: t('menu.settings'), accelerator: 'CmdOrCtrl+,', click: () => openSettingsPage() }]), // [settings]
      more(isDefaultBrowser() ? [] : [{ label: t('menu.makeDefault'), click: makeDefaultBrowser }]),
      more([{ label: t('menu.keyboardShortcuts'), accelerator: 'CmdOrCtrl+Shift+/', click: () => shortcutsHelp.open() }, { label: t('menu.whatsNew'), click: () => whatsNew.open() }]),
    ],
    [more([{ label: t('menu.devTools'), accelerator: 'F12', click: () => wc?.toggleDevTools() }])],
  ];
  // Screen DIPs: the button's bottom edge, and the lower of the window's bottom and the work area's.
  const content = win.getContentBounds();
  const anchor = { x: content.x + Math.round(x), y: content.y + Math.round(y) };
  const { workArea } = screen.getDisplayNearestPoint(anchor);
  const available = appMenuLayout.availableBelow({ anchorY: anchor.y, windowBottom: content.y + content.height, workAreaBottom: workArea.y + workArea.height });
  const { template } = appMenuLayout.fold(groups, available);
  const left = Number.isFinite(right) ? appMenuLayout.anchorX({ left: x, right, contentWidth: content.width, menuWidth: appMenuLayout.estimateWidth(template) }) : x;
  Menu.buildFromTemplate(template).popup({ window: win, x: Math.round(left), y: Math.round(y) });
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

// Read off the startup path (a long history is a sizeable file): visits recorded meanwhile are kept, with the
// file's earlier ones merged under them. Whatever needs the whole list awaits `historyReady`; suggestions just
// work from what is there.
let historyLoaded = false;
let historyReady = Promise.resolve();
function loadHistory() {
  historyReady = (async () => {
    try {
      await new Promise((r) => setImmediate(r));
      // Older builds recorded sign-in and token URLs; drop them on load.
      const saved = JSON.parse(await fs.promises.readFile(HISTORY_FILE(), 'utf8')).filter((h) => importer.isWorthImporting(h.url));
      for (const h of saved) {
        const now = history.get(h.url);
        if (!now) history.set(h.url, h);
        else { now.visits += h.visits || 0; now.last = Math.max(now.last, h.last || 0); now.title = now.title || h.title; }
      }
      historyVersion++;
      if (process.platform === 'darwin' && Menu.getApplicationMenu()) Menu.setApplicationMenu(macMenu()); // its History menu lists the recent pages
    } catch { /* no file yet, or unreadable: start empty */ }
    historyLoaded = true;
  })();
}

let historyDirty = false; // a visit is recorded that the file doesn't have yet
const historyJson = () => JSON.stringify([...history.values()].sort((a, b) => b.last - a.last).slice(0, 5000));
function saveHistorySoon() {
  historyDirty = true;
  clearTimeout(historySaveTimer);
  historySaveTimer = setTimeout(() => {
    if (!historyLoaded) { saveHistorySoon(); return; } // (never overwrite the file with a list that is still missing its past)
    historyDirty = false;
    fs.writeFile(HISTORY_FILE(), historyJson(), () => {});
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
  if (entry.visits >= 3) historyVersion++; // (only pages visited 3+ times are in frequentSites: others don't change it)
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

// Made once per window, hidden, as soon as the UI has loaded (see createWindow). Chromium gives a
// new view focus while its first page loads, so a dropdown made on the first keystroke took the
// keys typed right after it away from the address bar. It is only ever clicked (picks go through
// 'suggest:pick'), never typed in, so any focus it gets goes straight back to the UI.
function createSuggestView() {
  if (suggestView && !suggestView.webContents.isDestroyed()) suggestView.webContents.close();
  suggestView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload', 'suggest-preload.js'), sandbox: true, contextIsolation: true },
  });
  suggestView.setBackgroundColor('#00000000');
  suggestView.setVisible(false);
  win.contentView.addChildView(suggestView);
  hardenOwnView(suggestView.webContents, SUGGEST_URL);
  suggestView.webContents.on('focus', () => ui()?.focus());
  suggestView.webContents.once('did-finish-load', () => {
    if (!ui()?.isFocused() && !activeTab()?.webContents.isFocused()) ui()?.focus();
  });
  suggestView.webContents.loadFile(path.join(__dirname, 'renderer', 'suggest.html'));
}

function showSuggestions(rect, payload) {
  if (!suggestView) createSuggestView();
  win.contentView.addChildView(suggestView); // re-adding moves it to the top
  // Never taller than the window below the address bar: on a short window the list scrolls inside
  // the view (suggest.html) instead of running off the bottom.
  const height = Math.max(0, Math.min(rect.height, win.getContentSize()[1] - rect.y));
  suggestView.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(height) });
  suggestView.setVisible(true);
  raiseOverlays(); // (once visible, so it counts: the tool overlay and a dialog stay above it)
  const send = () => suggestView.webContents.send('suggest:items', payload);
  if (suggestView.webContents.isLoading()) suggestView.webContents.once('did-finish-load', send);
  else send();
}

function hideSuggestions() {
  if (suggestView) suggestView.setVisible(false);
}

// The downloads panel, drawn over the page under the toolbar button (renderer/downloads.html).
// Unlike the suggestions dropdown it takes focus while open (for Escape and the keyboard) and
// closes as soon as it loses it: a click anywhere else, switching apps.
const DOWNLOADS_PANEL_URL = pathToFileURL(path.join(__dirname, 'renderer', 'downloads-panel.html')).href;
const PANEL_WIDTH = 400;
let downloadsView = null;
let downloadsAnchor = null;
function createDownloadsView() {
  downloadsView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload', 'downloads-preload.js'), sandbox: true, contextIsolation: true },
  });
  downloadsView.setBackgroundColor('#00000000');
  downloadsView.setVisible(false);
  win.contentView.addChildView(downloadsView);
  hardenOwnView(downloadsView.webContents, DOWNLOADS_PANEL_URL);
  downloadsView.webContents.on('blur', () => setTimeout(() => { if (!downloadsView?.webContents.isFocused()) hideDownloadsPanel(); }, 0));
  downloadsView.webContents.loadFile(path.join(__dirname, 'renderer', 'downloads-panel.html'));
}
function placeDownloadsPanel(height) {
  if (!downloadsView || !downloadsAnchor || !win || win.isDestroyed()) return;
  const [width] = win.getContentSize();
  const x = Math.max(8, Math.min(downloadsAnchor.right - PANEL_WIDTH + 16, width - PANEL_WIDTH - 8));
  downloadsView.setBounds({ x: Math.round(x), y: Math.round(downloadsAnchor.bottom), width: PANEL_WIDTH, height: Math.round(Math.min(height, win.getContentSize()[1] - downloadsAnchor.bottom - 8)) });
}
function showDownloadsPanel(anchor) {
  if (!win || win.isDestroyed()) return;
  if (!downloadsView || downloadsView.webContents.isDestroyed()) createDownloadsView();
  downloadsAnchor = anchor;
  hideSuggestions();
  win.contentView.addChildView(downloadsView); // re-adding moves it to the top
  placeDownloadsPanel(160);
  const open = () => {
    downloadsView.webContents.send('downloads:list', downloads.panelList());
    downloadsView.webContents.send('downloads:open');
    downloadsView.setVisible(true);
    raiseOverlays(); // (once visible, so it counts: the tool overlay and a dialog stay above it)
    downloadsView.webContents.focus();
  };
  if (downloadsView.webContents.isLoading()) downloadsView.webContents.once('did-finish-load', open);
  else open();
}
let downloadsHiddenAt = 0;
function hideDownloadsPanel() {
  if (!downloadsView || !downloadsView.getVisible()) return;
  downloadsView.setVisible(false);
  downloadsHiddenAt = Date.now();
  const wc = activeTab()?.webContents;
  if (win?.isFocused()) (wc || ui())?.focus();
}
const fromDownloadsPanel = (event) => downloadsView && !downloadsView.webContents.isDestroyed() && event.sender === downloadsView.webContents;
ipcMain.on('downloads:act', (event, action, id) => { if (fromDownloadsPanel(event) && typeof id === 'number') downloads.act(id, String(action)); });
ipcMain.on('downloads:all', (event) => { if (fromDownloadsPanel(event)) { hideDownloadsPanel(); managers.open('downloads'); } }); // the Downloads page
ipcMain.on('downloads:drag', (event, id) => { if (fromDownloadsPanel(event) && typeof id === 'number') downloads.drag(id, event.sender); });
ipcMain.on('downloads:clear', (event) => { if (fromDownloadsPanel(event)) downloads.clearFinished(); });
ipcMain.on('downloads:folder', (event) => { if (fromDownloadsPanel(event)) { downloads.openFolder(); hideDownloadsPanel(); } });
ipcMain.on('downloads:close', (event) => { if (fromDownloadsPanel(event)) hideDownloadsPanel(); });
ipcMain.on('downloads:height', (event, height) => { if (fromDownloadsPanel(event) && Number.isFinite(height)) placeDownloadsPanel(Math.max(120, Math.min(height, 640))); });

// ---------- tabs ----------

// The URL a tab is "really" on: error pages report the address that failed.
function realUrl(wc) {
  if (warmPending.has(wc)) return ''; // (still on the warm view's about:blank: no address yet, as a fresh view has none)
  const url = wc.getURL();
  if (isErrorPage(url) || url.startsWith(settingsPage.HTTPS_ONLY_URL)) return new URL(url).searchParams.get('url') || ''; // [settings] HTTPS-only warning too
  return url;
}

function tabState() {
  const active = activeTab();
  const history = active?.webContents.navigationHistory;
  // Hoisted: bookmarks() re-reads settings.json and rebuilds an array; sendTabs() fires on nearly
  // every tab/nav event, so doing this once here instead of per-tab inside map avoids O(tabs) reloads.
  const bookmarked = new Set(bookmarks().map((b) => b.url));
  const defaultZoomPercent = Math.round((settingsBackend.prefs().defaultZoom || 1) * 100);
  return {
    groups: tabGroups.state(),
    organizable: tabGroups.organizableCount(), // what Organize would regroup (the strip shows its button by this)
    // A sleeping tab has no view/webContents to read from; it still gets a row, built from the
    // snapshot sleepTab() took (title/url/favicon/group), with a 'sleeping' flag for the tab strip.
    // A tab being closed leaves the strip at once, as in Chrome; it comes back only if the page asks
    // "Leave site?" (requestCloseTab, will-prevent-unload).
    tabs: tabs.filter((t) => (alive(t) || t.sleeping) && !(t.closing && !t.unloadAsked)).map((t) => {
      if (t.sleeping) {
        const url = t.sleepUrl || '';
        return {
          id: t.id,
          title: t.sleepTitle || 'New Tab',
          url: isInternal(url) ? '' : url,
          loading: false,
          favicon: t.favicon || null,
          favicons: t.favicons || (t.favicon ? [t.favicon] : []),
          page: null,
          error: false,
          zoom: 100,
          zoomDefault: 100,
          bookmarked: isWebUrl(url) && bookmarked.has(url),
          groupId: t.groupId || null,
          pinned: Boolean(t.pinned),
          sleeping: true,
          chat: tabChatMark(t.id),
          aiOpened: manners.isAiTab(t), // [ai manners] the AI opened this tab
          ...tabTools.state(t, false),
        };
      }
      const wc = t.view.webContents;
      const url = realUrl(wc);
      return {
        id: t.id,
        title: (!warmPending.has(wc) && wc.getTitle()) || 'New Tab',
        url: settingsPage.isSettingsUrl(url) ? settingsPage.displayUrl(url) : chatPage.isChatUrl(url) ? chatPage.displayUrl() : pageTools.isInternal(url) ? pageTools.displayUrl(url) : isInternal(url) ? '' : url, // [settings] lumen://settings/<section>
        loading: wc.isLoading(),
        favicon: t.favicon || null,
        favicons: t.favicons || (t.favicon ? [t.favicon] : []), // every candidate: the strip falls back through them
        page: settingsPage.isSettingsUrl(url) ? 'settings' : url.startsWith(HISTORY_URL) ? 'history' : pageTools.page(url) || managerPageOf(url), // Lumen's own pages get their own icon
        readerable: Boolean(t.readerable), // Reader mode can show this page (features/page-tools.js)
        translate: translate.stateOf(t), // the translate button and infobar (features/translate.js)
        passwords: passwordsRt ? passwordsRt.stateOf(t) : null, // [passwords] the key button and the save bar: sites, usernames and counts only
        error: isErrorPage(wc.getURL()),
        security: siteSecurity.stateOf(wc), // 'broken' | 'mixed' | null: the lock's state beyond the scheme
        zoom: Math.round(wc.getZoomFactor() * 100),
        zoomDefault: isWebUrl(url) ? defaultZoomPercent : 100, // [settings] the zoom pill shows only when a page differs from it
        bookmarked: isWebUrl(url) && bookmarked.has(url),
        groupId: t.groupId || null,
        alert: dialogs.pendingFor(wc), // a dialog is waiting for this background tab
        pinned: Boolean(t.pinned),
        isolated: Boolean(t.isolated), // [research tabs] its own cookie-less session
        aiReading: Boolean(t.aiReading), // [research tabs] the AI is reading this page right now
        chat: tabChatMark(t.id), // [chat per tab] 'running' | 'waiting' | 'approval' | 'done' | null
        aiOpened: manners.isAiTab(t), // [ai manners] the AI opened this tab (a mark in the strip, "Opened by AI" in its card)
        ...tabTools.state(t, true), // audible, muted
      };
    }),
    activeId,
    canGoBack: active ? canGoBack(active.webContents) : false,
    canGoForward: history ? history.canGoForward() : false,
  };
}

let sessionTimer = null;
let sessionDirtySince = 0; // when the first unsaved tab change came
let agentTargetHook = null; // set where the agent exists: tells the sidebar which tab its task works in
// Tab moves made as one (several tabs going to another window) send each window's strip one update at the
// end, instead of one per step, so the strips never show the halfway states.
let tabsBatch = 0;
const tabsBatched = new Set();
function batchTabs(fn) {
  tabsBatch++;
  try { return fn(); } finally {
    if (--tabsBatch === 0) {
      const recs = [...tabsBatched];
      tabsBatched.clear();
      for (const rec of recs) if (winRecs.has(rec) && rcAlive(rec)) withWindow(rec, sendTabs);
    }
  }
}
function sendTabs() {
  if (tabsBatch && curRec) { tabsBatched.add(curRec); return; }
  keepPinnedFirst();
  ui()?.send('tabs', tabState());
  agentTargetHook?.();
  chatPageRt?.pushTarget(); // the chat page's "working on" tab follows tab changes
  // Saved 3 s after the tabs settle, and at least every 15 s while they don't (a page whose title ticks).
  clearTimeout(sessionTimer);
  if (!sessionDirtySince) sessionDirtySince = Date.now();
  sessionTimer = setTimeout(() => { sessionDirtySince = 0; if (win && !win.isDestroyed()) saveSession({ background: true }); }, Math.max(0, Math.min(3000, sessionDirtySince + 15000 - Date.now())));
}

// A page's own busy events (loading, title, favicon, in-page navigations) arrive in bursts: they send the strip
// one state per turn of the event loop, per window. Moves, opens and closes still send at once (sendTabs).
const tabsSoon = new Set();
function sendTabsSoon() {
  const rec = curRec;
  if (!rec) { sendTabs(); return; }
  if (tabsSoon.has(rec)) return;
  tabsSoon.add(rec);
  setTimeout(() => { tabsSoon.delete(rec); if (rcAlive(rec)) withWindow(rec, sendTabs); }, 16); // (one frame: a load's events arrive in separate turns)
}

function activeTab() {
  const tab = tabs.find((t) => t.id === activeId);
  return alive(tab) ? { id: tab.id, webContents: tab.view.webContents } : null;
}

// While the sidebar animates, the page is shown as a snapshot in the UI and the live view is
// hidden (and resized once, out of sight), so the site never reflows during the animation.
let viewFrozen = false;
// True while the active tab's chat fills the whole content area (homepage "Ask AI" full mode):
// the UI covers the viewport itself, so the native view underneath is hidden rather than resized.
// Tied to one tab (its id) and to that tab still showing the new-tab page: switching away shows
// the other tab's page at once, and switching back hides the page again with no flash while the
// UI catches up; navigating the tab anywhere ends it.
let chatFullTab = null;

function layout() {
  // Showing a view (after the sidebar spring, a tab switch) must not take the keyboard from the UI:
  // Chromium can hand focus to a view that becomes visible (a moment later), which ate keys typed in
  // the address bar. While the UI has focus, a view shown here gives focus back for half a second.
  const uiHadFocus = Boolean(ui()?.isFocused());
  for (const tab of tabs.filter(alive)) {
    const visible = tab.id === activeId;
    if (tab.outgoing && !visible) finishLeaving(tab); // (left before its new page drew: no new-tab page behind another tab)
    const show = visible && !viewFrozen && !tab.spareFilling && !curRec?.holdViews && !(tab.id === chatFullTab && isNewTab(tab.view.webContents.getURL()));
    if (show && uiHadFocus && !tab.view.getVisible()) tab.showGuardUntil = Date.now() + 500;
    tab.view.setVisible(show);
    // The new-tab page keeps its full-width layout when the sidebar narrows its view (see
    // features/sidebar-overlay.js). Kept while the view is only hidden for a moment (the sidebar's
    // snapshot), so the page isn't laid out twice; dropped for every other tab and page.
    const overlay = visible && !tab.fullscreen && isNewTab(tab.view.webContents.getURL())
      ? sidebarOverlay.overlayParams({ newTab: true, fullscreen: false, bounds: contentBounds })
      : null;
    setOverlay(tab, overlay);
    if (!visible) continue;
    if (tab.fullscreen) {
      const [width, height] = win.getContentSize();
      tab.view.setBounds({ x: 0, y: 0, width, height });
    } else {
      tab.view.setBounds({ x: contentBounds.x, y: contentBounds.y, width: contentBounds.width, height: contentBounds.height });
    }
  }
  spotifyWeb.sync(); // [widgets] the Spotify card's view follows the new-tab page (or hides, still playing)
  raiseOverlays();
}
const { overlaysToRaise } = require('./features/overlay-order');
// Layering (bottom to top): the UI view, tab views, Spotify card, suggestions, downloads panel, tool overlay, dialogs. A tab view added later
// (a new tab, a woken one) lands above an overlay that is showing and would hide it; put those back on top, in order.
function raiseOverlays() {
  if (!win || win.isDestroyed()) return;
  // Fixed order, bottom to top: spotify, suggestions, downloads, tool overlay (dialogs: dialogs.raise below).
  const order = [spotifyWeb.view(), suggestView, downloadsView, toolOverlay.viewFor(win)].filter((v) => v && !v.webContents.isDestroyed() && v.getVisible());
  // Only when one is under a tab (or they are out of order): then all are re-added in order, so two never swap.
  for (const v of overlaysToRaise(win.contentView.children, tabs.filter((t) => t.view).map((t) => t.view), order)) win.contentView.addChildView(v);
  dialogs.raise();
}
// Turn the tab's full-width layout override on, change it or off (only when it changed).
function setOverlay(tab, params) {
  if (sidebarOverlay.sameParams(tab.overlay || null, params)) return;
  const wc = tab.view.webContents;
  try {
    if (params) wc.enableDeviceEmulation(params);
    else wc.disableDeviceEmulation();
    tab.overlay = params;
  } catch (err) {
    console.error('[lumen] sidebar overlay:', err.message);
    tab.overlay = null;
  }
}

// [research tabs] Tabs the AI opened to show its research live in a separate, memory-only session: none of the
// user's cookies, logins, storage or cache go to those pages, and nothing they set reaches the profile. Only that
// one known partition is accepted (never a "persist:" one), and it is passed on to tabs opened from such a tab.
const RESEARCH_PARTITION = require('./features/research-tabs').RESEARCH_PARTITION;
const isolatedPartition = (p) => (p === RESEARCH_PARTITION ? p : null);
let researchSes = null;
function researchSession() {
  if (researchSes) return researchSes;
  const ses = session.fromPartition(RESEARCH_PARTITION);
  // Nothing to ask the user about in a page the AI opened to read: no permissions, no downloads.
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event, item) => { event.preventDefault(); try { item.cancel(); } catch {} });
  ses.webRequest.onBeforeRequest((details, callback) => safeBrowsing.gate(details, callback)); // Safe Browsing (the ad blocker sends pages to the same gate)
  // Lumen's own alert/confirm dialogs and readable dropdowns, as in normal tabs.
  ses.registerPreloadScript({ id: 'lumen-page-dialogs', type: 'frame', filePath: path.join(__dirname, 'preload', 'page-dialogs-preload.js') });
  ses.registerPreloadScript({ id: 'lumen-select-contrast', type: 'frame', filePath: path.join(__dirname, 'features', 'select-contrast-preload.js') });
  settingsBackend.mirrorSession(ses); // the profile's proxy, Do Not Track / Global Privacy Control, languages
  adblock.attachSession(ses); // the same filters as normal tabs (waits for the engine if it is still loading)
  researchSes = ses;
  return ses;
}
const isolatedOf = (wc) => tabByContents(wc)?.isolated || null;

// `view`: a page that already exists (a window a page opened with window.open), adopted as this tab as it is.
// ---- a new-tab page made ready before it is asked for: Ctrl+T shows one at once, as Chrome's spare renderer does.
// One hidden page, loaded in the background; a new tab takes it and hands it its fresh data (the address's hash,
// as refreshNewTabs does), and another is made a moment later. Thrown away if the page settings changed.
let spareNewTab = null; // { view, prefs, ready, at }
function makeSpareNewTab() {
  if (TEST || spareNewTab || !app.isReady()) return;
  const prefs = settingsBackend.tabWebPreferences(false);
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, ...prefs } });
  try { view.setBounds({ x: 0, y: 0, ...(withWindow(curRec, () => ({ width: contentBounds.width, height: contentBounds.height })) || { width: 1200, height: 800 }) }); } catch {} // laid out at a tab's size, not 0×0
  try { view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff'); } catch {} // (taken while still loading: the theme's color, not white)
  const s = { view, prefs: JSON.stringify(prefs), ready: false, at: Date.now() };
  view.webContents.once('did-finish-load', () => { s.ready = true; });
  view.webContents.loadURL(newTabUrl()).catch(() => {});
  spareNewTab = s;
}
// { view, ready }: one still loading is taken too (its renderer is up and its page part-way: sooner than a new one).
function takeSpareNewTab() {
  const s = spareNewTab;
  if (!s) return null;
  spareNewTab = null;
  const fresh = !s.view.webContents.isDestroyed() && !s.view.webContents.isCrashed() && s.prefs === JSON.stringify(settingsBackend.tabWebPreferences(false)); // (no age limit: its data comes with the tab)
  if (!fresh) { try { s.view.webContents.close(); } catch {} return null; }
  return { view: s.view, ready: s.ready };
}
// The next one is made right away: Ctrl+T pressed again a moment later finds
// it, or one part-way through loading. (It used to wait 700 ms, and a quick second new tab started from nothing.)
const spareSoon = () => setTimeout(makeSpareNewTab, 100).unref?.();

// ---- a renderer kept ready for the next web page: Chrome's spare renderer process, which Electron doesn't keep.
// A web page in a new view (a link opened in a new tab, a restored or sleeping tab woken, an address typed into the
// new-tab page, whose own renderer is locked to Lumen's pages) waited ~70 ms for its renderer process to start. One
// hidden view is kept on about:blank instead: its process is up and belongs to no site yet, so the next such page
// loads in it at once. Another is made a moment later. (It costs a renderer's memory: not on a PC short of memory, nor
// with Performance mode switched on by hand.)
let warmTab = null; // { view, prefs }
const warmPending = new WeakSet(); // a tab's page that hasn't left the warm view's about:blank yet (no address, no history)
let warmForTest = false;
const warmTabsOn = () => (!TEST || warmForTest) && perfMode.mode() !== 'on' && !perfMode.reasons().some((r) => r.key === 'memory');
function makeWarmTab() {
  if (warmTab || !app.isReady() || !warmTabsOn() || quitting) return;
  const prefs = settingsBackend.tabWebPreferences(false);
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, ...prefs } });
  try { view.setBounds({ x: 0, y: 0, ...(withWindow(curRec, () => ({ width: contentBounds.width, height: contentBounds.height })) || { width: 1200, height: 800 }) }); } catch {} // a tab's size, not 0×0
  applyChromeIdentity(view.webContents); // (in place well before its first page: its renderer is already running)
  view.webContents.loadURL('about:blank').catch(() => {});
  warmTab = { view, prefs: JSON.stringify(prefs) };
}
let warmTimer = null;
const warmSoon = (ms = 600) => { clearTimeout(warmTimer); warmTimer = setTimeout(makeWarmTab, ms); warmTimer.unref?.(); }; // (after the page that took the last one has started)
// The warm view, for a web page in the profile's session with no back/forward list to restore; null if there is none
// ready (or its page settings changed since). The page's address comes from wireView's loadURL.
function takeWarmTab() {
  const s = warmTab;
  if (!s) return null;
  warmTab = null;
  warmSoon();
  const wc = s.view.webContents;
  const ready = !wc.isDestroyed() && !wc.isCrashed() && !wc.isLoading() && wc.getURL() === 'about:blank' && s.prefs === JSON.stringify(settingsBackend.tabWebPreferences(false));
  if (!ready) { try { wc.close(); } catch {} return null; }
  warmPending.add(wc);
  // Its about:blank never shows in the tab's back list: gone once the page (or its error page) commits.
  const committed = () => {
    warmPending.delete(wc);
    try { if (wc.navigationHistory.getEntryAtIndex(0)?.url === 'about:blank' && wc.navigationHistory.length() > 1) wc.navigationHistory.clear(); } catch {}
  };
  wc.once('did-navigate', committed);
  return s.view;
}
// The new-tab page's renderer is locked to Lumen's own pages, so a web address typed there (or a tile or search on
// it) waited for a renderer process of its own. The page loads in the warm view instead, which takes the tab's place
// once the page has drawn: the new-tab page stays on screen until then, as Chromium keeps the old page up until the
// new one paints. If nothing commits (a download, a stopped load), the new-tab page simply stays. Back from the page
// returns to a new-tab page (backToNewTab: the warm view's history starts at the page).
function leaveNewTabFor(tab, url) {
  if (!alive(tab) || tab.settings || tab.managerPage || tab.isolated || tab.outgoing || !isWebUrl(url) || !isNewTab(tab.view.webContents.getURL())) return false;
  const view = takeWarmTab();
  if (!view) return false;
  const old = tab.view;
  const oldWc = old.webContents;
  const host = win;
  oldWc.off('destroyed', tab.onViewDestroyed); // replaced, not closed: that handler would close the tab
  tab.outgoing = { view: old, win: host, overlay: tab.overlay || null };
  tab.view = view;
  tab.overlay = null; // (the new-tab page's full-width layout was on the old view)
  tab.backToNewTab = true;
  host.contentView.addChildView(view);
  host.contentView.addChildView(old); // the new-tab page stays on top until the page has drawn
  const wc = wireView(tab, url);
  layout();
  let settled = false;
  const reveal = () => { if (!settled) { settled = true; finishLeaving(tab, true); } };
  const revert = () => { if (!settled) { settled = true; finishLeaving(tab, false); } };
  wc.once('did-navigate', () => {
    setTimeout(reveal, 500).unref?.(); // (a page that never paints still takes its place)
    wc.executeJavaScriptInIsolatedWorld(PAGE_TEXT_WORLD, [{ code: `new Promise((done) => { try { new PerformanceObserver(done).observe({ type: 'paint', buffered: true }); } catch { done(); } })` }])
      .then(() => setTimeout(reveal, 16), reveal);
  });
  wc.on('did-stop-loading', () => { if (warmPending.has(wc)) revert(); }); // nothing committed: back to the new-tab page
  wc.once('destroyed', revert);
  if (tab.id === activeId) syncExtensions(() => extensions?.selectTab(wc));
  sendTabs();
  return true;
}
// The swap above, ended: `keep` puts the page in the tab for good (the new-tab page goes, Back returns to one);
// otherwise the new-tab page is the tab's again. Also called when the tab is closed, put to sleep, moved to another
// window or left for another tab before the page has drawn.
function finishLeaving(tab, keep = true) {
  const out = tab.outgoing;
  if (!out) return;
  tab.outgoing = null;
  const host = out.win && !out.win.isDestroyed() ? out.win : null;
  if (keep || !alive(tab) || !warmPending.has(tab.view.webContents)) {
    try { host?.contentView.removeChildView(out.view); } catch {}
    try { out.view.webContents.close(); } catch {}
    return;
  }
  const failed = tab.view;
  tab.backToNewTab = false;
  failed.webContents.off('destroyed', tab.onViewDestroyed);
  tab.view = out.view;
  tab.overlay = out.overlay;
  tab.onViewDestroyed = () => closeTab(tab.id, { destroyed: true });
  out.view.webContents.once('destroyed', tab.onViewDestroyed);
  try { host?.contentView.removeChildView(failed); } catch {}
  try { failed.webContents.close(); } catch {}
  if (host && rcAlive(tab.rec) && tab.rec.win === host) withWindow(tab.rec, () => { if (tab.id === activeId) syncExtensions(() => extensions?.selectTab(out.view.webContents)); layout(); sendTabs(); });
}
// Back, and whether there is one: past the first page of a tab that left the new-tab page (above), a new-tab page.
function goBack(wc) {
  if (!wc || wc.isDestroyed()) return;
  if (wc.navigationHistory.canGoBack()) { wc.navigationHistory.goBack(); return; }
  const tab = tabByContents(wc);
  if (tab?.backToNewTab) { tab.backToNewTab = false; wc.loadURL(newTabUrl()).catch(() => {}); }
}
const canGoBack = (wc) => Boolean(wc && !wc.isDestroyed() && (wc.navigationHistory.canGoBack() || tabByContents(wc)?.backToNewTab));
if (TEST) global.__warmTabs = { enable: (on = true) => { warmForTest = on; if (on) makeWarmTab(); else if (warmTab) { try { warmTab.view.webContents.close(); } catch {} warmTab = null; } }, ready: () => Boolean(warmTab && !warmTab.view.webContents.isLoading()), contentsId: () => warmTab?.view.webContents.id ?? null, forgetHistory: (id) => { const t = tabs.find((x) => x.id === id); if (t) t.sleepHistory = null; return Boolean(t?.sleeping); } };

function openTab(url = newTabUrl(), { background = false, openerId = null, groupId = null, settings = false, historyPage = false, managerPage = null, history = null, partition = null, view: adopted = null, openedBy = null } = {}) {
  const isolated = settings || historyPage || managerPage ? null : isolatedPartition(partition);
  if (isolated) researchSession();
  const plainNewTab = !adopted && !settings && !historyPage && !managerPage && !history?.entries?.length && !isolated && typeof url === 'string' && url.startsWith(NEW_TAB_URL);
  const spared = plainNewTab ? takeSpareNewTab() : null;
  const spare = spared?.view || null;
  if (plainNewTab) spareSoon();
  const webPage = !adopted && !settings && !historyPage && !managerPage && !history?.entries?.length && !isolated && typeof url === 'string' && isWebUrl(url);
  const warm = webPage ? takeWarmTab() : null; // (its process is already up: see makeWarmTab)
  const view = adopted || spare || warm || new WebContentsView({
    // [settings] font sizes and spell check from Settings; only the settings tab gets its preload,
    // and only the History page gets history-preload.js
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, ...settingsBackend.tabWebPreferences(settings),
      ...(historyPage ? { preload: path.join(__dirname, 'preload', 'history-preload.js') } : {}),
      ...(managerPage ? { preload: managers.preloadFor(managerPage) } : {}), // the Bookmarks, Downloads or chat page
      ...(isolated ? { partition: isolated } : {}),
    },
  });
  // A new-tab page built from scratch (no spare ready): the theme's background until its first paint, not white.
  if ((plainNewTab || settings || historyPage || managerPage) && !spare && !adopted) { // (Lumen's own pages follow the theme; a web page's default is its own)
    try { view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff'); } catch {} }
  const id = nextTabId++;
  const tab = { id, view, rec: curRec, favicon: null, groupId: null, userRemoved: false, settings, lastActiveAt: Date.now(), ...(managerPage ? { managerPage } : {}), ...(isolated ? { isolated } : {}) };
  if (openedBy) manners.markOpened(tab, openedBy); // [ai manners] a tab the AI opened
  tabs.push(tab);
  win.contentView.addChildView(view);
  view.setVisible(false);
  const wc = wireView(tab, url, history, { loaded: Boolean(adopted || spare) }); // `history`: Duplicate's copy of back/forward
  // The spare page gets this tab's data in place (no reload, no extra history entry): hidden until it has drawn it (a
  // frame of the old data would flash otherwise). Usually it already shows the same data (its address says so) and is
  // shown at once: a hidden page's renderer runs at background priority, and even a no-op script there took ~45 ms.
  // A spare still loading finishes first (its page reads the data then).
  if (spare && !(spared.ready && wc.getURL() === url)) {
    tab.spareFilling = true;
    const fill = () => wc.executeJavaScript(`history.replaceState(null, '', ${JSON.stringify(url)}); dispatchEvent(new HashChangeEvent('hashchange')); true`, true)
      .catch(() => { if (!wc.isDestroyed()) wc.loadURL(url).catch(() => {}); });
    const loaded = spared.ready ? Promise.resolve() : new Promise((r) => { wc.once('did-finish-load', r); setTimeout(r, 1500); });
    const filled = loaded.then(() => (wc.isDestroyed() || wc.getURL() === url ? null : fill()));
    // (At most 100 ms past its load: an occluded or minimized window draws no frames, and the tab must not stay blank.)
    Promise.race([filled, loaded.then(() => new Promise((r) => setTimeout(r, 100)))])
      .finally(() => { tab.spareFilling = false; if (tab.id === activeId && alive(tab)) withWindow(tab.rec, () => layout()); });
  }

  if (openerId) tabGroups.joinOpener(tab, tabs.find((t) => t.id === openerId));
  else if (groupId) tabGroups.add(id, groupId);

  if (background) {
    const current = activeTab();
    if (current && !tabByContents(current.webContents)?.isolated) syncExtensions(() => extensions?.selectTab(current.webContents)); // extensions never see research tabs
    sendTabs();
  } else {
    switchTab(id);
    guardFirstLoadFocus(tab, url);
  }
  return { id, webContents: wc };
}

const extensionIdOf = (url) => /^chrome-extension:\/\/([a-p]{32})\//.exec(url || '')?.[1] || null;

// Wires a tab's WebContentsView (navigation, zoom, favicon/title tracking, close-on-destroy,
// extensions, HTTPS-only/zoom defaults) and loads `url`. Split out of openTab() so wakeTab() (tab
// sleeping, below) can rebuild a woken tab's view identically instead of duplicating all of this.
function wireView(tab, url, history = null, { loaded = false } = {}) {
  const { id, settings } = tab;
  const wc = tab.view.webContents;
  wc.once('did-stop-loading', () => setTimeout(markFirstTabLoaded, 200));
  bindContext(wc, () => tab.rec); // this tab's events run in the window that holds it, even a background one
  tabTools.wire(tab); // the tab's speaker icon, and its mute (kept across sleep)
  wc.setWindowOpenHandler(({ url: target, disposition }) => {
    if (tab.aiLock) return { action: 'deny' }; // [signed-in sites] no popups while the AI reads it as the user
    if (!(isWebUrl(target) || target === 'about:blank' || target.startsWith('chrome-extension://'))) return { action: 'deny' };
    // An extension's pages open only from that same extension: a web page could otherwise open any
    // extension page it liked (and whatever that page does with its privileges).
    if (target.startsWith('chrome-extension://') && extensionIdOf(target) !== extensionIdOf(wc.getURL())) return { action: 'deny' };
    if (disposition === 'new-window') {
      // A real popup (sign-in, payment): it keeps window.opener so it can report back to the page. Lumen makes
      // the window itself (createWindow) so it presents itself as Chrome before its first page loads: Google
      // sign-in checks the browser on that very first page ("This browser or app may not be secure").
      return {
        action: 'allow',
        overrideBrowserWindowOptions: popupWindowOptions(),
        outlivesOpener: true,
        // No page yet means a person's Shift+click on a link, not a page's sign-in popup: it opens as a normal tab.
        createWindow: (options) => (options?.webContents ? popupWindow(options, settings, tab.isolated, target, tab) : withWindow(tab.rec, () => openTab(target, { openerId: id, partition: tab.isolated })).webContents),
      };
    }
    // A tab. When a page's script asked for it (window.open), the page gets that new window back and it keeps
    // window.opener, as in Chrome: sign-in code that opens a window and watches or redirects it keeps working.
    // Lumen adopts the new window's page into a tab instead of making a window for it.
    // A tab opened this way outlives the page that opened it (outlivesOpener): closing or sleeping that page never
    // closes it. When there is no page yet (Ctrl+click, a middle-click: Electron hands over only the address), the
    // tab is opened the usual way, loading the address, and its page is what Electron gets back.
    // (about:blank too: a page may open a blank window and set its address after an async step, as payments do.)
    if (WebContentsView && (isWebUrl(target) || target === 'about:blank')) {
      return {
        action: 'allow',
        outlivesOpener: true,
        // The user's page settings (font sizes, spell check, plugins for protected video), as every tab has.
        overrideBrowserWindowOptions: { webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, ...settingsBackend.tabWebPreferences(false) } },
        createWindow: (options) => {
          const background = disposition === 'background-tab';
          if (!options?.webContents) return withWindow(tab.rec, () => openTab(target, { background, openerId: id, partition: tab.isolated })).webContents;
          const view = new WebContentsView({ webContents: options.webContents });
          withWindow(tab.rec, () => openTab(target, { background, openerId: id, view, partition: tab.isolated }));
          return options.webContents;
        },
      };
    }
    withWindow(tab.rec, () => openTab(target, { background: disposition === 'background-tab', openerId: id, partition: tab.isolated })); // a link from a research tab stays in its session
    return { action: 'deny' };
  });
  wc.on('enter-html-full-screen', () => { tab.fullscreen = true; layout(); });
  wc.on('leave-html-full-screen', () => { tab.fullscreen = false; layout(); });
  // A new page may come from a fresh renderer that doesn't carry the full-width layout override:
  // drop it and let layout() put it back if this is still (or now) the new-tab page under the sidebar.
  wc.on('did-navigate', () => {
    if (tab.overlay) {
      try { wc.disableDeviceEmulation(); } catch { /* the page is going away */ }
      tab.overlay = null;
    }
    if (tab.id === activeId) layout();
  });
  wc.on('zoom-changed', (_e, direction) => {
    zoomBy(wc, direction === 'in' ? 0.5 : -0.5);
  });
  // Chromium only reports a page's icons when they differ from the last ones this webContents
  // reported, and never reports "none": a reload, or the next page of the same site with the same
  // icon, gets no event at all. So the icon isn't cleared when a navigation starts (a download or a
  // 204 never commits, and a same-icon page would never get it back); a committed http(s) page keeps
  // the last reported icons until new ones arrive, and any other page (new tab, error, data:) has none.
  // Every candidate is kept, in Electron's (alphabetical) order: the tab strip falls through to the
  // next one when an icon doesn't load. A new webContents (a woken tab) reports its page's icons
  // afresh; until it does, the woken tab keeps showing the ones from before it slept.
  tab.faviconUrls = tab.favicons || [];
  wc.on('page-favicon-updated', (_e, favicons) => {
    const next = favicons.filter((u) => typeof u === 'string' && u);
    if (next.join('\n') === (tab.favicons || []).join('\n')) { if (next.length && !tab.isolated) cacheFavicon(wc.getURL(), next); return; } // the same icons: nothing to redraw (but this host's icon is kept)
    tab.faviconUrls = next;
    tab.favicons = tab.faviconUrls;
    tab.favicon = tab.favicons[0] || null;
    sendTabsSoon();
    if (tab.favicons.length && !tab.isolated) cacheFavicon(wc.getURL(), tab.favicons);
  });
  wc.on('did-navigate', (_e, url) => {
    tab.favicons = isWebUrl(url) ? tab.faviconUrls : [];
    tab.favicon = tab.favicons[0] || null;
  });
  wc.on('will-navigate', (event, url) => {
    if (askFromHome(event, event.url || url, tab.id) || widgetAction(event, event.url || url, wc)) return;
    // A tile or a search on the new-tab page: the page loads in the warm view (leaveNewTabFor), as a typed address does.
    if (event.isMainFrame !== false && alive(tab) && tab.view.webContents === wc && isNewTab(wc.getURL()) && isWebUrl(event.url || url)
      && withWindow(tab.rec, () => leaveNewTabFor(tab, event.url || url))) event.preventDefault();
  });
  tabFailPage(wc);
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) adblock.resetCount(wc.id);
  });
  googleRefusedGuard(wc, { inTab: true, win: () => (rcAlive(tab.rec) ? tab.rec.win : null) });
  // A crashed page (or one out of memory) was left blank with no way back. Show a "This page
  // crashed" page with Reload instead; the crashed page's own entry stays in history behind it.
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || tab.closing || !tabs.includes(tab)) return;
    const failedUrl = tab.lastUrl || '';
    tab.hungAsked = false;
    setImmediate(() => {
      if (wc.isDestroyed() || !tabs.includes(tab)) return;
      const params = new URLSearchParams({ url: failedUrl, kind: 'crashed', desc: details.reason, code: String(details.exitCode ?? '') });
      wc.loadURL(`${ERROR_URL}?${params}`).catch(() => {});
    });
  });
  // A page stuck in a loop: ask once whether to wait or close it (which ends its process and shows
  // the crashed page above, so the tab itself and its history stay).
  wc.on('unresponsive', () => {
    if (tab.hungAsked || tab.closing) return;
    tab.hungAsked = true;
    let host = '';
    try { host = new URL(realUrl(wc)).host; } catch {}
    dialogs.showMessageBox(win, {
      type: 'warning', buttons: [t('hung.wait'), t('hung.close')], defaultId: 0, cancelId: 0,
      message: host ? t('hung.page', { host }) : t('hung.thisPage'),
      detail: t('hung.detail'),
      owner: wc,
    }).then(({ response, cancelled }) => {
      if (response === 1 && !cancelled && !wc.isDestroyed()) wc.forcefullyCrashRenderer();
    });
  });
  wc.on('responsive', () => { tab.hungAsked = false; });
  wc.on('did-navigate', (_e, url) => { if (!isErrorPage(url)) tab.lastUrl = url; });
  wc.on('did-navigate', (_e, url) => {
    // The error page replaces the failed entry, so Back skips past it.
    if (isErrorPage(url)) {
      const history = wc.navigationHistory;
      const failed = history.getActiveIndex() - 1;
      if (failed >= 0 && history.getEntryAtIndex(failed)?.url === realUrl(wc)) history.removeEntryAtIndex(failed);
      sendTabs();
      return;
    }
    if (!tab.isolated) recordVisit(url, wc.getTitle()); // research pages stay out of the user's History
    tab.lastVisitUrl = url;
    tab.pageText = ''; // a new page: its text arrives after it loads
    scheduleAutoGroup();
  });
  // Single-page sites (YouTube, GitHub, Gmail…) change pages without a full load; those pages
  // belong in History and address bar suggestions too. A jump to a #section of the same page
  // isn't a new visit. The title catches up through 'page-title-updated' (updateTitle).
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (!isMainFrame || url.split('#')[0] === (tab.lastVisitUrl || '').split('#')[0]) return;
    tab.lastVisitUrl = url;
    if (!tab.isolated) recordVisit(url, wc.getTitle());
  });
  wc.on('did-finish-load', () => readPageText(tab));
  pageTools.attach(tab);
  translate.attach(tab);
  passwordsRt?.attach(tab); // [passwords] offers to save a sign-in; features/passwords.js decides which tabs
  wc.on('page-title-updated', (_e, title) => updateTitle(wc.getURL(), title));
  wc.on('found-in-page', (_e, result) => {
    if (tab.id === activeId) ui()?.send('find:result', result);
  });
  wc.on('context-menu', (_e, params) => showContextMenu(wc, params));
  for (const event of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page']) {
    wc.on(event, sendTabsSoon);
  }
  wc.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && !manners.isAgentInput(wc)) { manners.userInput.key(wc); userTookOver(tab); } // [ai manners] the user typed here: the tab is theirs, and the AI waits for them
    // Esc while the page itself is still loading stops it, as in Chrome (the reload button shows Stop meanwhile).
    // Only the main frame counts: a loaded page whose iframes are still busy gets its Esc (closing its own dialogs).
    if (input.type === 'keyDown' && input.key === 'Escape' && !input.control && !input.meta && !input.alt && !input.shift && wc.isLoadingMainFrame() && isWebUrl(wc.getURL())) { wc.stop(); event.preventDefault(); return; }
    handleShortcut(event, input);
  });
  wc.on('focus', () => { if (tab.showGuardUntil > Date.now()) ui()?.focus(); }); // see layout()
  // A real click in the page is the user choosing it: the guard above must not take focus back.
  wc.on('before-mouse-event', (_e, mouse) => {
    if (mouse.type !== 'mouseDown') return;
    if (!manners.isAgentInput(wc)) { manners.userInput.click(wc); userTookOver(tab); } // [ai manners] a click of the AI's own tool is not the user's
    tab.showGuardUntil = 0;
  });
  // A page with a beforeunload handler: by default Electron blocks the close/navigation (this event
  // fires and, unless we call event.preventDefault() *now*, the unload stays prevented). We can't
  // await the user's answer inside this handler, so instead: let it stay blocked, ask "Leave site?",
  // and if they choose Leave, redo the close — this time with a flag that lets that retry through.
  // Only a tab close is asked about (the case where work is lost with no way back); a navigation
  // or reload the page tries to block just goes ahead instead of silently doing nothing.
  let allowNextUnload = false;
  wc.on('will-prevent-unload', (event) => {
    if (allowNextUnload || !tab.closing) { allowNextUnload = false; event.preventDefault(); return; }
    tab.unloadAsked = true; // requestCloseTab's frozen-page timeout leaves this close to the user
    sendTabs(); // back in the strip while it asks
    dialogs.showMessageBox(win, {
      type: 'warning',
      buttons: [t('dialog.cancel'), t('leave.button')],
      defaultId: 0,
      cancelId: 0,
      message: t('leave.title'),
      detail: t('leave.detail'),
      owner: wc,
      bringToFront: true, // the user asked to close this tab, so show it with its question
    }).then(({ response }) => {
      tab.unloadAsked = false;
      if (response !== 1) { tab.closing = false; sendTabs(); return; }
      allowNextUnload = true;
      if (tabs.some((t) => t.id === id)) requestCloseTab(id); // the main case: retry the close, this time it goes through
    });
  });
  // [settings] the settings tab is locked to the settings page; other tabs get default zoom and HTTPS-only
  if (settings) settingsBackend.guardSettingsTab(wc, (target) => replaceTab(id, target));
  else settingsBackend.attachTab(wc);
  if (tab.managerPage === 'chat') chatPage.guardTab(wc, (target) => replaceTab(id, target)); // lumen://chat is locked to its page
  else chatPage.guardOthers(wc); // and no other tab can navigate to it

  // If the page closes itself, drop the tab instead of keeping a dead one around. sleepTab() (below)
  // removes this exact listener first, so a deliberate sleep is never mistaken for the page closing.
  tab.onViewDestroyed = () => closeTab(id, { destroyed: true });
  const contentsId = wc.id;
  wc.once('destroyed', () => adblock.forget(contentsId)); // the new-tab "blocked" total counts open tabs only
  wc.once('destroyed', tab.onViewDestroyed);

  if (!settings) { // [settings] no debugger and no extensions on the settings tab
    applyChromeIdentity(wc);
    siteSecurity.attachTab(wc); // mixed content, on the debugger session applyChromeIdentity opened
    safeBrowsing.attachTab(wc); // the warning page's "Visit this site" link
    if (!tab.isolated) syncExtensions(() => extensions?.addTab(wc, win)); // extensions live in the profile's session: they don't see research tabs
    // (A popup it opens is given the same identity in popupWindow, before its first page loads.)
  }
  // The saved back/forward list is used only when its current entry is the page `url` names (tabSleep.wakePlan);
  // otherwise, or if the restore throws or leaves the view blank, the plain address loads.
  const plan = history?.entries?.length ? tabSleep.wakePlan({ sleepUrl: url, history, isError: isErrorPage }) : null;
  if (plan?.restore) {
    wc.navigationHistory.restore(plan.restore).catch(() => { if (!wc.isDestroyed()) wc.loadURL(url).catch(() => {}); });
    setTimeout(() => { // a restore that never committed anything (stuck at about:blank): load the address
      if (wc.isDestroyed() || wc.isLoading()) return;
      const now = wc.getURL();
      if (!now || now === 'about:blank') wc.loadURL(url).catch(() => {});
    }, 10e3).unref?.();
  } else if (!loaded) { // an adopted page is already on its way to its address
    wc.loadURL(url).catch(() => {});
  }
  return wc;
}

// ---------- tab sleeping ----------
// A background tab left untouched for a while has its WebContentsView destroyed — a full renderer
// process, GPU compositor layers, JS heap, the actual memory cost — while the strip keeps showing
// its title/url/favicon/group from the snapshot sleepTab() takes below. switchTab() wakes it back
// up through wireView(), the same path a freshly opened tab takes, reloading the same URL (restoring
// scroll position isn't attempted). See canSleep() for every case this leaves alone.
const tabSleep = require('./features/tab-sleep'); // the pure decisions: may it sleep, how it wakes
const SLEEP_AFTER_MS = 20 * 60 * 1000;
const SLEEP_CHECK_MS = 60 * 1000;
// When the OS is short of memory, background tabs sleep after 2 minutes instead, oldest first. On
// an 8 GB Mac a dozen tabs is enough to start swapping long before the 20 minutes are up.
const PRESSURE_SLEEP_AFTER_MS = 2 * 60 * 1000;

// macOS: the kernel's own pressure level (1 normal, 2 warning, 4 critical), the signal Activity
// Monitor's graph shows; free-page counts are misleading there because of compression. Elsewhere:
// under 10% of RAM available.
function memoryPressure() {
  if (process.platform !== 'darwin') {
    const { total, free } = process.getSystemMemoryInfo();
    return Promise.resolve(total > 0 && free / total < 0.1);
  }
  return new Promise((resolve) => {
    require('child_process').execFile('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], (err, out) => {
      if (err) { console.error('[lumen] memory pressure check failed:', err.message); return resolve(false); }
      resolve(Number(out) >= 2);
    });
  });
}

function sleepTab(tab) {
  finishLeaving(tab); // (a page that just left the new-tab page: the new-tab page goes now)
  const wc = tab.view.webContents;
  tab.sleepUrl = realUrl(wc) || wc.getURL();
  tab.sleepTitle = wc.getTitle() || 'New Tab';
  // Back/forward (and each entry's saved scroll position and form fields) come back on wake.
  try {
    const nav = wc.navigationHistory;
    tab.sleepHistory = { entries: nav.getAllEntries(), index: nav.getActiveIndex() };
  } catch {
    tab.sleepHistory = null;
  }
  tab.sleeping = true;
  wc.off('destroyed', tab.onViewDestroyed); // this is a sleep, not a close: don't let that handler drop the tab
  win.contentView.removeChildView(tab.view);
  wc.close();
  tab.view = null;
}

function wakeTab(tab) {
  if (!tab.sleeping) return;
  // A web page with no back/forward list to bring back (a tab restored from the last session) wakes in the warm view.
  const warm = !tab.managerPage && !tab.isolated && !tab.sleepHistory?.entries?.length && isWebUrl(tab.sleepUrl || '') ? takeWarmTab() : null;
  const view = warm || new WebContentsView({
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, ...settingsBackend.tabWebPreferences(false),
      ...(tab.managerPage ? { preload: managers.preloadFor(tab.managerPage) } : {}),
      ...(tab.isolated ? { partition: tab.isolated } : {}), // a sleeping research tab wakes in the same session
    },
  });
  tab.view = view;
  tab.sleeping = false;
  // Real bounds before the page starts loading: a 0x0 view (the default) makes a heavy single-page site
  // measure a zero-size viewport; switchTab's layout() came only after, and a tab woken while not in
  // front (Reload, the AI, a drag) would stay 0x0 until first shown.
  try { view.setBounds(tabSleep.wakeBounds(contentBounds, { fullscreen: tab.fullscreen, full: tab.fullscreen ? (() => { const [width, height] = win.getContentSize(); return { width, height }; })() : null })); } catch { /* laid out by layout() */ }
  win.contentView.addChildView(view);
  view.setVisible(false);
  raiseOverlays(); // the woken view lands above any floating panel that was showing
  const history = tab.sleepHistory;
  tab.sleepHistory = null;
  wireView(tab, tab.sleepUrl || newTabUrl(), history);
}

// A tab from the saved session that hasn't been opened yet: a sleeping tab (above) with no view,
// which switchTab() wakes the first time it's shown. Starting Lumen loads only the active tab
// instead of every tab of the last session at once.
function addRestoredTab(url, title, favicon = null) {
  // The new-tab page's cached copy (offline-safe, but kept only for favorites and frequent sites),
  // else the icon the tab showed when the session was saved.
  // (As a file in favicon-cache, not a data: address: that would ride along in every tab-strip update and save.)
  const saved = typeof favicon === 'string' ? favicon : '';
  const icon = faviconFile(faviconStore.get(hostOf(url)))
    || (saved.startsWith('data:image/') ? faviconFile(saved) : /^https?:/.test(saved) || FAVICON_FILE_URL.test(saved) ? saved : null);
  const tab = {
    id: nextTabId++, view: null, rec: curRec, favicon: icon, favicons: icon ? [icon] : [], groupId: null,
    userRemoved: false, settings: false, lastActiveAt: Date.now(),
    sleeping: true, sleepUrl: url, sleepTitle: title || hostOf(url) || 'New Tab', sleepHistory: null,
    ...(chatPage.isChatUrl(url) ? { managerPage: 'chat' } : {}), // wakes with the chat preload
  };
  tabs.push(tab);
  return tab;
}

// A page may have text typed into a form; sleeping can't ask "Leave site?" the way a real close does
// (will-prevent-unload, above, is deliberately bypassed for a silent background sleep), so this
// substitutes for it. Any doubt (a throw, a page that blocks the read) counts as "yes, has input".
// Also: a reply still streaming in (an AI chat site: the page keeps changing with no load in progress, or
// shows a Stop button), a playing media element, a chosen upload (tabSleep.pageBusyScript). Bounded to 5 s.
async function hasUnsavedInput(wc) {
  try {
    const answer = await Promise.race([
      wc.executeJavaScriptInIsolatedWorld(PAGE_TEXT_WORLD, [{ code: tabSleep.pageBusyScript(1200) }]),
      new Promise((resolve) => setTimeout(resolve, 5000)), // a page that won't answer: undefined, which counts as busy
    ]);
    return tabSleep.pageBusy(answer);
  } catch {
    return true;
  }
}

// Never the active tab, never a tab an AI task is working in (it keeps its tab when the user switches
// away), never settings/internal pages, never a tab mid-close, mid-navigation, playing audio, or with
// typed form input. On any doubt this returns false and the tab is left alone.
async function canSleep(tab) {
  const wc = alive(tab) ? tab.view.webContents : null;
  if (tabSleep.keepReason({
    alive: Boolean(wc), sleeping: tab?.sleeping, active: tab?.id === activeId, settings: tab?.settings, closing: tab?.closing, unloadAsked: tab?.unloadAsked,
    openPopups: tab?.openPopups, agentUsing: wc ? agent.usingTab(tab.id) : false, aiLock: tab?.aiLock, webPage: wc ? isWebUrl(realUrl(wc)) : false,
    loading: wc?.isLoading(), audible: wc?.isCurrentlyAudible(), fullscreen: tab?.fullscreen, devTools: wc?.isDevToolsOpened(),
  })) return false;
  return !(await hasUnsavedInput(wc));
}

async function sweepSleep() {
  if (!win || win.isDestroyed() || readSettings().tabSleep === false) return;
  const pressure = await pressureCheck();
  const cutoff = Date.now() - (pressure ? PRESSURE_SLEEP_AFTER_MS : Math.min(SLEEP_AFTER_MS, perfMode.limits().sleepAfterMs)); // Performance mode: sooner
  for (const tab of [...tabs].sort((a, b) => (a.lastActiveAt || 0) - (b.lastActiveAt || 0))) {
    if (!tab.lastActiveAt || tab.lastActiveAt > cutoff) continue;
    if (!(await canSleep(tab))) continue;
    // hasUnsavedInput (inside canSleep) is an async round trip to the page (over a second): re-check the fast,
    // synchronous conditions in case the user switched to (or closed) this exact tab, or it started playing, meanwhile.
    if (!alive(tab) || tab.sleeping || tab.id === activeId || tab.view.webContents.isCurrentlyAudible() || tab.view.webContents.isLoading()) continue;
    sleepTab(tab);
    sendTabs();
  }
  // Performance mode also caps how many background tabs stay loaded: the ones unused the longest go
  // first, and nothing used in the last minute.
  const cap = perfMode.limits().maxLiveBackgroundTabs;
  if (Number.isFinite(cap)) {
    const live = () => tabs.filter((t) => alive(t) && !t.sleeping && t.id !== activeId);
    for (const tab of live().sort((a, b) => (a.lastActiveAt || 0) - (b.lastActiveAt || 0))) {
      if (live().length <= cap) break;
      if (!tab.lastActiveAt || tab.lastActiveAt > Date.now() - 60e3 || !(await canSleep(tab))) continue;
      if (!alive(tab) || tab.sleeping || tab.id === activeId) continue;
      sleepTab(tab);
      sendTabs();
    }
  }
}
let pressureCheck = memoryPressure;
setInterval(() => { sweepSleep().catch(() => {}); }, SLEEP_CHECK_MS);
if (TEST) global.__tabSleep = { sleep: (id) => { const t = tabs.find((x) => x.id === id); if (t && alive(t)) sleepTab(t); sendTabs(); }, canSleep: (id) => canSleep(tabs.find((x) => x.id === id)), state: () => tabs.map((t) => ({ id: t.id, sleeping: Boolean(t.sleeping), view: Boolean(t.view) })), sweep: () => sweepSleep(), memoryPressure, fakePressure: (on) => { pressureCheck = () => Promise.resolve(on); }, age: (id, ms) => { const t = tabs.find((x) => x.id === id); if (t) t.lastActiveAt -= ms; } };

// ---- new-tab focus. A blank new tab opens with the cursor in the address bar, as in Chrome.
// Chromium focuses a tab's page by itself when its view is shown and again on its first navigation,
// which took the keyboard away (typed keys went to the page). While a tab first loads, focus goes
// back to the UI unless the user clicked into the page: always for a blank new tab, and for a tab
// opened on a URL when the address bar was used (or anything else in the UI clicked or typed in)
// after the tab opened.
// Events are ordered by a counter, not the clock: a click can land in the same millisecond.
let uiEventSeq = 0;
let addressTouchedAt = 0;
// Sent on every click (and plain key) in the browser UI. The UI takes the keyboard for real here:
// Chromium doesn't always move native focus between sibling views, so after using the page a click
// in the address bar or sidebar could leave keys going to the page, and the new-tab search box
// kept its blinking caret while you typed somewhere else.
ipcMain.on('address:touched', () => {
  addressTouchedAt = ++uiEventSeq;
  // (Typing is coming: ready before the first key's list. Not while the first tab is still loading at start-up: the
  // new-tab page's address-bar focus lands here then, and the dropdown's renderer is made once that tab has loaded.)
  if (!suggestView && firstTabDone && win && !win.isDestroyed()) createSuggestView();
  if (!ui()?.isFocused()) ui()?.focus();
  const wc = activeTab()?.webContents;
  if (wc && isNewTab(wc.getURL())) wc.executeJavaScript('document.activeElement?.blur()').catch(() => {});
});

function guardFirstLoadFocus(tab, url) {
  const openedAt = ++uiEventSeq;
  const wc = tab.view.webContents;
  const blank = isNewTab(url);
  let pageClicked = false;
  const onMouse = (_e, mouse) => { if (mouse.type === 'mouseDown') pageClicked = true; };
  const keepAddress = () => !pageClicked && (blank || addressTouchedAt > openedAt);
  const giveBack = () => { if (keepAddress() && tab.id === activeId) ui()?.focus(); };
  wc.on('focus', giveBack);
  wc.on('before-mouse-event', onMouse);
  if (blank) focusAddress();
  wc.once('did-finish-load', () => {
    if (alive(tab) && tab.id === activeId && keepAddress() && !ui()?.isFocused()) ui()?.focus();
    setTimeout(() => {
      if (wc.isDestroyed()) return;
      wc.off('focus', giveBack);
      wc.off('before-mouse-event', onMouse);
    }, 1000);
  });
}

function switchTab(id, { wake = true } = {}) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return false;
  if (id !== activeId) {
    const leaving = tabs.find((t) => t.id === activeId);
    if (leaving) leaving.lastActiveAt = Date.now(); // starts its idle clock for tab sleeping (sweepSleep)
    activeTab()?.webContents.stopFindInPage('clearSelection');
  }
  // Shown in the strip only. Waking a sleeping tab reloads it, and a drag that is then cancelled
  // (Escape) has no way to put that page back to sleep. It loads later, if it is still in front.
  if (tab.sleeping && !wake) {
    activeId = id;
    layout();
    sendTabs();
    return true;
  }
  if (tab.sleeping) wakeTab(tab);
  activeId = id;
  tab.viewedAt = Date.now(); // which tab the user looked at last (the chat page's AI works in it)
  const current = activeTab();
  if (current && !tabByContents(current.webContents)?.isolated) syncExtensions(() => extensions?.selectTab(current.webContents)); // extensions never see research tabs
  layout();
  dialogs.refresh(); // a dialog waiting for this tab comes up; the one for the tab left waits
  if (!agent.currentScope()) followTabChat(tab); // [chat per tab] the sidebar shows this tab's chat (a tool's own tab change moves the run, not the sidebar)
  sendTabs();
  return true;
}

// `user`: the user closed it (a sleeping tab's ✕, Close group); a tab closed by code (a sign-in tab closing
// itself, an extension) never takes its window with it.
// Calls `fn` once the tab is closed (its page destroyed and the tab gone from the strip: a tab put to sleep
// destroys its page too, and is still there). Returns a function that stops listening.
function onTabGone(id, fn) {
  const wc = tabs.find((t) => t.id === id)?.view?.webContents;
  if (!wc || wc.isDestroyed()) return () => {};
  const gone = () => { if (!tabs.some((t) => t.id === id)) fn(); };
  wc.once('destroyed', gone);
  return () => { if (!wc.isDestroyed()) wc.removeListener('destroyed', gone); };
}

// [ai manners] The user clicked or typed in a tab, or navigated, pinned or moved it: if the AI had opened it, it is theirs now
// and "close the tabs the AI opened" leaves it alone.
function userTookOver(tab) {
  if (!manners.handOver(tab)) return;
  const rec = tab.rec;
  if (rec && winRecs.has(rec) && rcAlive(rec)) withWindow(rec, sendTabs);
}

function closeTab(id, { destroyed = false, user = false } = {}) {
  const index = tabs.findIndex((t) => t.id === id);
  if (index === -1) return;
  if (chatFullTab === id) chatFullTab = null;
  const [tab] = tabs.splice(index, 1);
  chatBind.unbindTab(id); // [chat per tab]
  finishLeaving(tab);
  tabGroups.cleanup();
  // `pendingCloseUrl` (set by requestCloseTab) covers the case where this runs from the 'destroyed'
  // event below: the webContents is already gone by then, so its URL can't be read any more. A
  // sleeping tab has no webContents at all; sleepUrl is its last known URL instead.
  const url = tab.pendingCloseUrl ?? (alive(tab) ? realUrl(tab.view.webContents) : tab.sleepUrl || '');
  if (url && !isInternal(url) && !tab.isolated) { // a research tab would reopen in the user's session with their cookies: not offered
    closedTabs.push(url);
    tabTools.noteClosed(url, alive(tab) ? tab.view.webContents.getTitle() : tab.sleepTitle); // for tab search
  }
  if (closedTabs.length > 50) closedTabs.splice(0, closedTabs.length - 50); // Reopen Closed Tab goes back 50
  if (!win || win.isDestroyed()) return; // the app is quitting
  if (tab.view) win.contentView.removeChildView(tab.view); // no view to remove if it was sleeping
  if (!destroyed && alive(tab)) tab.view.webContents.close();
  if (tabs.length === 0) {
    // Closing a window's last tab (Ctrl+W, its ✕, the tab menu: `closing`, set by requestCloseTab) closes the
    // window, as in Chrome: hidden at once (no frame of an empty strip over the page), then closed. A page that
    // went away on its own, or a tab closed by code, leaves a fresh tab instead: the window is never lost to that.
    if (user || tab.closing) {
      const rec = curRec;
      sendTabs();
      try { rec.win.hide(); } catch {}
      setImmediate(() => { if (rcAlive(rec)) rec.win.close(); });
      return;
    }
    openTab();
    return;
  }
  if (activeId === id) switchTab(tabs[Math.min(index, tabs.length - 1)].id);
  else sendTabs();
  chatTabGone(id); // [chat per tab] a chat still working there goes on in a background tab
}

// The interactive "close this tab" entry points (the tab strip's ✕, Ctrl/Cmd+W, the tab menu) go
// through here instead of calling closeTab directly, so a page with a beforeunload handler gets to
// ask "Leave site?" (will-prevent-unload, wired in openTab) before the tab actually goes away. If
// the page doesn't object — true for the vast majority of tabs — this closes right away: Electron
// only fires will-prevent-unload when the page's own handler tries to block the close.
// closeTab({ destroyed: true }), already wired to every tab's 'destroyed' event, finishes the job.
function requestCloseTab(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!alive(tab)) { closeTab(id, { user: true }); return; }
  tab.pendingCloseUrl = realUrl(tab.view.webContents) || '';
  tab.closing = true;
  // The page answers the beforeunload check before the close finishes, which can take a moment:
  // the strip drops the tab now, and the next tab is shown now if this one was in front.
  if (tab.id === activeId) {
    const index = tabs.indexOf(tab);
    const next = [...tabs.slice(index + 1), ...tabs.slice(0, index).reverse()].find((t) => !t.closing);
    if (next) switchTab(next.id);
  }
  sendTabs();
  tab.view.webContents.close({ waitForBeforeUnload: true });
  // A frozen page never answers the beforeunload check, so the close never finished. If the tab is
  // still here after a moment and isn't asking "Leave site?", close it without waiting.
  setTimeout(() => {
    if (tabs.includes(tab) && tab.closing && !tab.unloadAsked) closeTab(id);
  }, CLOSE_TIMEOUT_MS);
}
const CLOSE_TIMEOUT_MS = 3000;

function listTabs() {
  // Sleeping tabs stay listed (from their sleep snapshot) so the agent can still see and switch to
  // them; switch_tab wakes one up like any other tab click would (see switchTab).
  return tabs.filter((t) => alive(t) || t.sleeping).map((t) => ({
    id: t.id,
    title: t.sleeping ? (t.sleepTitle || 'New Tab') : warmPending.has(t.view.webContents) ? '' : t.view.webContents.getTitle(),
    url: t.sleeping ? (t.sleepUrl || '') : realUrl(t.view.webContents),
    active: t.id === activeId,
    group: t.groupId ? tabGroups.groups.get(t.groupId)?.name || null : null,
  }));
}

// Omnibox input: URLs load directly, everything else becomes a search (search.js).
function resolveInput(text) {
  return resolveAddressInput(text, readSettings().searchEngine);
}

function zoomBy(wc, step) {
  if (!wc) return;
  // A PDF tab: the built-in viewer keeps its own scale and ignores page zoom (features/pdf-zoom.js).
  if (pdfZoom.viewerFrame(wc)) {
    pdfZoom.zoomPdf(wc, step).then((took) => { if (!took) zoomPage(wc, step); });
    return;
  }
  zoomPage(wc, step);
}

function zoomPage(wc, step) {
  // [settings] Reset (Ctrl+0, the zoom pill) goes back to the default zoom from Settings, and the
  // site follows that default again; zooming by hand makes the default leave this site alone.
  if (step === 0) settingsBackend.resetZoom(wc);
  else {
    const level = Math.min(Math.max(wc.getZoomLevel() + step, -3), 5);
    settingsBackend.noteUserZoom(wc, level); // (kept for the site across restarts: features/site-zoom.js)
    wc.setZoomLevel(level);
  }
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
const ORGANIZE_PROMPT = 'Group these browser tabs by topic or task. Each tab has an id, title, host and path words; "group" is the name of the group it is in now; "hint" is what its site is nearly always used for (School for Canvas or Gradescope, Job search for Indeed). Tabs of one host, and tabs with the same hint, usually belong in one group: keep them together unless their titles are clearly different topics (two courses, two projects), and when such a group has no better name, the hint is a good one. Where tabs already belong together in a group, reuse that exact group name for them. The tab marked "active" is what the user is doing right now: keep it with its related tabs. Make 2 to 8 groups of at least 2 tabs each. Name each group specifically in 1-3 words (Title Case), like "Flights to Tokyo" or "React docs", never just a website. A tab belongs to at most one group; leave out tabs that fit nowhere. Use only the ids given. Reply with JSON only: {"groups":[{"name":"...","tab_ids":[1,2]}]}.';

// Where a grouping request goes. The user's own CLIs ('claudecode:…' / 'grokbuild:…' / 'antigravity:…' picks) answer
// it as a one-shot, tool-less run (cli-json.js), so no API key is needed. An API model without a
// key goes to Claude Code instead, when it's installed and not known to be signed out.
const LOCAL_ENGINE = /^(claudecode|grokbuild|antigravity):/;
const ENGINE_NAMES = { claudecode: 'Claude Code', grokbuild: 'Grok Build', antigravity: 'Antigravity' };
// [model fallback] The same rules for the one-shot AI calls outside the chat (topic naming, Organize's refine, a skill's
// proposal, page translation). standInOf: the model to start on while `model` cools down. withFallback: a call that
// fails on a usage limit or a lost connection is asked once more on the next usable model (never on other failures,
// and never with the setting off). `run(model, first)`; engines: false keeps Claude Code and Grok Build out (translation).
function standInOf(model) {
  return fallbackOn() ? aiFallback.resolve({ preferred: String(model), options: modelOptions(), cooldowns: aiFallback.shared }).model : model;
}
async function withFallback(model, run, { engines = true, signal = null } = {}) {
  let current = String(model);
  const tried = new Set();
  for (;;) {
    try {
      return await run(current, tried.size === 0);
    } catch (err) {
      if (!fallbackOn() || signal?.aborted) throw err; // a Stop is never a reason to switch
      const info = aiFallback.classify(err);
      if (info.kind !== 'limit' && info.kind !== 'unreachable') throw err;
      aiFallback.shared.mark(current, info);
      tried.add(current);
      const next = tried.size >= 2 ? null : aiFallback.pick({ current, options: modelOptions(), cooldowns: aiFallback.shared, allowEngines: engines, tried: [...tried] });
      if (!next) throw err;
      console.log(`[model fallback] background task: ${current} ${info.kind === 'limit' ? 'hit a limit' : 'was unreachable'}, retrying on ${next}`);
      current = next;
    }
  }
}
async function groupingRoute(model) {
  if (LOCAL_ENGINE.test(model)) return { engine: model.split(':')[0], model: engineModel(model) };
  const { provider } = providers.splitModel(model);
  if (provider === 'anthropic' ? anthropicUsable() : providerKey(provider)) return { api: model };
  const status = await agent.engines?.claudecode?.status().catch(() => null);
  if (status?.installed && status.signedIn !== false) return { engine: 'claudecode', model: 'haiku' };
  const label = provider === 'anthropic' ? 'Anthropic' : providers.PROVIDERS[provider].label;
  throw new Error(`Add your ${label} API key in Settings, or install Claude Code and sign in: it uses your own Claude account, no key needed.`);
}

// One answer from the user's own CLI. Claude Code runs Haiku for speed; if the plan can't use it,
// the chat's own Claude Code model is tried once.
async function proposeGroupsLocal({ engine, model }, list) {
  const bin = await agent.engines[engine].detect();
  if (!bin) throw new Error(`${ENGINE_NAMES[engine]} isn’t installed.`);
  const ask = (m) => cliJson.completeJSON({ engine, bin, model: m, system: ORGANIZE_PROMPT, user: `Tabs:\n${JSON.stringify(list)}`, schema: ORGANIZE_SCHEMA, userData: app.getPath('userData') });
  const fast = engine === 'claudecode' ? 'haiku' : model;
  try {
    return cliJson.checkGroups(await ask(fast));
  } catch (err) {
    if (fast === model || /not signed in|usage limit/i.test(err.message)) throw err;
    return cliJson.checkGroups(await ask(model));
  }
}

// Asks the chat's current model for groups. Only ids, titles and hostnames are sent.
async function proposeGroups(model, list) {
  list = list.filter((entry) => !aiOffTab(entry.id)); // [ai controls] those tabs' titles aren't sent
  const route = await groupingRoute(String(model));
  if (route.engine) return proposeGroupsLocal(route, list);
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

// [ai controls] Is tab `id` on a site where the user turned AI off?
function aiOffTab(id) {
  const tab = tabs.find((t) => t.id === id);
  return Boolean(tab) && aiSites.isOff(alive(tab) ? realUrl(tab.view.webContents) : tab.sleepUrl || '');
}

// ---- page translation engine: the cheapest fast model of the user's connected API provider.
// CLI engines (Claude Code, Grok Build) aren't used: one agent run per chunk is too slow and costly;
// with only those connected, the menu offers Google Translate instead.
function translateEngine() {
  const chosen = cheapTopicModel();
  const base = LOCAL_ENGINE.test(chosen) ? modelOptions().find((o) => !LOCAL_ENGINE.test(o.id) && !o.id.endsWith(':__more'))?.id : chosen;
  if (!base) return null;
  const { provider } = providers.splitModel(base);
  if (provider === 'anthropic' ? !anthropicUsable() : !providerKey(provider)) return null;
  let model = 'claude-haiku-4-5';
  if (provider !== 'anthropic') {
    const list = providerModels[provider] || providers.PROVIDERS[provider].defaults;
    model = `${provider}:${list.find((m) => /mini|flash|fast|lite|haiku/i.test(m)) || list[0]}`;
  }
  const label = provider === 'anthropic' ? 'Anthropic' : providers.PROVIDERS[provider].label;
  return { id: provider === 'anthropic' ? 'anthropic' : provider, label, run: (system, user) => withFallback(model, (m) => translateComplete(m, system, user), { engines: false }) };
}
const TRANSLATE_SCHEMA = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, text: { type: 'string' } }, required: ['id', 'text'], additionalProperties: false } } }, required: ['items'], additionalProperties: false };
async function translateComplete(model, system, user) {
  const { provider, model: id } = providers.splitModel(model);
  if (provider !== 'anthropic') return providers.completeJSON({ provider, model: id, apiKey: providerKey(provider), system, user });
  const res = await agent.getClient().messages.create({
    model: id,
    max_tokens: 8000,
    system,
    output_config: { format: { type: 'json_schema', schema: TRANSLATE_SCHEMA } },
    messages: [{ role: 'user', content: user }],
  });
  if (res.stop_reason === 'refusal') throw new Error('The model declined to translate this page.');
  return JSON.parse(res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
}

let organizing = false;
let organizeAbort = null;
const refineCache = organizeAi.createRefineCache(); // answers for tabs organized before (until Lumen quits)

// One refinement request (features/organize-ai.js): group summaries and leftover tabs in, names / placements /
// merges out. Small max_tokens, temperature 0 and a strict schema, on the cheapest model of the chat's provider.
async function refineGroups(model, wire, signal, timeoutMs = organizeAi.TIMEOUT_CLI_MS, knownRoute = null) {
  const route = knownRoute || await groupingRoute(String(model)); // organizeTabs worked the route out once for this click
  const user = JSON.stringify(wire);
  if (route.engine) {
    const { engine, model: engineModelId } = route;
    const bin = await agent.engines[engine].detect();
    if (!bin) throw new Error(`${ENGINE_NAMES[engine]} isn’t installed.`);
    // The whole answer has `timeoutMs` (organize-ai's wait, minus a little): a fast model first (Claude Code: Haiku)
    // gets most of it, and the chat's own model is tried only with what is left, never after a timeout.
    const deadline = Date.now() + Math.max(5000, timeoutMs - 2000);
    const ask = (m, ms) => cliJson.completeJSON({ engine, bin, model: m, system: organizeAi.REFINE_PROMPT, user, schema: organizeAi.REFINE_SCHEMA, userData: app.getPath('userData'), timeoutMs: ms, signal }); // an abort stops the process, not just the wait
    const fast = engine === 'claudecode' ? 'haiku' : engineModelId;
    if (fast === engineModelId) return ask(fast, deadline - Date.now());
    try { return await ask(fast, Math.round((deadline - Date.now()) * 0.6)); } catch (err) {
      const left = deadline - Date.now();
      if (err.timedOut || signal?.aborted || left < 8000 || /not signed in|usage limit/i.test(err.message)) throw err;
      return ask(engineModelId, left);
    }
  }
  const { provider, model: id } = providers.splitModel(model);
  if (provider === 'anthropic') {
    const res = await agent.getClient().messages.create({
      model: id,
      max_tokens: organizeAi.REFINE_MAX_TOKENS,
      temperature: 0,
      system: organizeAi.REFINE_PROMPT,
      output_config: { format: { type: 'json_schema', schema: organizeAi.REFINE_SCHEMA } },
      messages: [{ role: 'user', content: user }],
    }, { signal });
    if (res.stop_reason === 'refusal') throw new Error('The model declined to organize these tabs.');
    return JSON.parse(res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  }
  const apiKey = providerKey(provider);
  if (!apiKey) throw new Error(`Add your ${providers.PROVIDERS[provider].label} API key in Claude settings first.`);
  return providers.completeJSON({ provider, model: id, apiKey, system: organizeAi.REFINE_PROMPT, user, maxTokens: organizeAi.REFINE_MAX_TOKENS, temperature: 0, signal });
}

// A short line about what just happened, with an Undo button (the tab strip shows it as a toast).
// `merge`: the note is the merge's own (its Undo wording; it keeps the merge's undo). Any other note that takes the
// Undo button (`undo: true`) is the organize's, so an older merge can no longer be undone from it.
function organizeNote(text, { undo = false, merge = false } = {}) {
  if (undo && !merge) mergeUndo = null;
  ui()?.send('tabs:organize-note', { text, undo, ttl: windowMerge.NOTE_MS, ...(merge && undo ? { undoLabel: t('merge.undo'), undoTitle: t('merge.undoTitle') } : {}) });
}

// "Organize Tabs with AI": the local organizer groups the tabs at once (one step of undo); the model then only
// refines that result in place (names, the few loose tabs it can place, merges), and is skipped when the local
// result is already clear or the same tabs were organized before. A second click while it refines cancels
// it and keeps the local groups. Any failure, timeout or unusable answer keeps the local groups too.
async function organizeTabs() {
  if (organizing) { organizeAbort?.abort(); return 0; }
  let made = 0; // the groups made (what the tab menu's caller reports)
  organizing = true;
  organizeAbort = new AbortController();
  const rec = curRec;
  const back = (fn) => withWindow(rec, fn);
  const inWin = (groups) => Object.fromEntries(['organizeByTopic', 'organizeSeq', 'organizeView', 'applyRefinement', 'layoutSignature'].map((k) => [k, (...a) => back(() => groups[k](...a))]));
  const groupsBefore = back(() => tabGroups.layoutSignature().groups); // groups that exist before this click (automatic grouping may have made some)
  ui()?.send('tabs:organizing', true); // at once: the button shows "Organizing…" before any work
  try {
    await cliJson.whenIdle(); // a CLI still being stopped after a cancel must be gone before the next run starts one
    if (organizeAbort.signal.aborted) return 0;
    if (tabGroups.candidates().length < 2) throw tooFewMessage();
    // How long the model gets depends on the route: a CLI engine needs seconds just to start (organize-ai TIMEOUT_CLI_MS).
    // The model is asked only when "Use AI to name and group topics" is on and a route to one exists (a key, or a signed-in CLI); the
    // route is worked out once per click. Otherwise this stays on this computer: nothing is sent and there is nothing to complain about.
    const aiOn = readSettings().topicAi === true || (TEST && global.__organizeAlwaysAsk === true);
    const route = aiOn ? await groupingRoute(String(cheapTopicModel())).catch(() => null) : null;
    const timeoutMs = organizeAi.timeoutFor(route);
    const stats = await organizeAi.organizeProgressive({
      tabGroups: inWin(tabGroups), // the model's answer arrives later: it must land in THIS window's tabs, not whichever is current by then
      cache: TEST && global.__organizeAlwaysAsk === true ? organizeAi.createRefineCache() : refineCache, // a test asks fresh every time
      signal: organizeAbort.signal,
      skipId: aiOffTab, // [ai controls] those tabs' titles aren't sent
      alwaysAsk: TEST && global.__organizeAlwaysAsk === true,
      maxTabs: MAX_ORGANIZE_TABS * 4,
      timeoutMs,
      ask: organizeAi.askIfEnabled({ enabled: aiOn, route, ask: (wire, { signal, timeoutMs: ms } = {}) => withFallback(cheapTopicModel(), (m, first) => refineGroups(m, wire, signal, ms, first ? route : null), { signal }) }),
      // Sites no hint is known for go along as host names; what the model says they are for is kept in
      // the profile (organizeLearning.aiHints) and used by local grouping too. Never over the fixed table.
      hints: { lookup: (url) => organizeLearner.aiHint(url), learn: (answers) => organizeLearner.learnAiHints(answers) },
      onPhase: (name, info) => {
        if (name === 'local') { if (info?.count) back(() => { sendTabs(); ui()?.send('tabs:organizing', 'refine'); }); } // the groups are there; the model may still refine them
        else if (name === 'asking') back(() => ui()?.send('tabs:organizing', 'refine')); // also when nothing grouped locally: the AI is making the groups, a click cancels
        else if (name === 'refined') back(sendTabs);
      },
    });
    back(sendTabs);
    made = stats.groups;
    const failed = /^kept local/.test(stats.reason) ? stats.failed : '';
    if (!stats.groups && !stats.created) {
      // Nothing was changed (organizeByTopic rolls back), so no Undo. If the AI was asked and failed, say why, not "no groups".
      back(() => organizeNote(failed ? aiFailureNote(failed) : stats.reason === 'cancelled' ? `${t('organize.cancelledNone')}.` : `${t('organize.none')} ${t('organize.none.detail')}`)); // a note that closes itself, not a modal: nothing needs an answer
    } else if (stats.unchanged && stats.reason !== 'cancelled' && !failed) {
      // The groups were already as Organize makes them: nothing changed, so there is nothing to undo.
      back(() => organizeNote(`${t('organize.already')}.`));
    } else if (stats.reason === 'cancelled') {
      // The groups made before the cancel are real and stay: say so, with the Undo that removes them.
      back(() => organizeNote(`${t('organize.cancelled')}.`, { undo: true }));
    } else {
      const how = stats.reason === 'local' ? t('organize.local') : stats.reason === 'refined' ? t('organize.refined') : stats.reason === 'confident' || stats.reason === 'cached' ? t('organize.noAi') : failed ? aiFailureNote(failed, false) : t('organize.localOnly');
      // Groups the automatic grouping had already made are not this click's work: with some before, the note says what THIS click added.
      const added = stats.groups > 0 && groupsBefore > 0 && stats.finalGroups > stats.groups ? stats.groups : 0;
      const what = !Number.isInteger(stats.finalGroups) ? '' : added ? ` ${t(added === 1 ? 'organize.summaryAdded.one' : 'organize.summaryAdded', { added, groups: stats.finalGroups, loose: stats.loose })}` : ` ${organizeSummary(stats.finalGroups, stats.loose)}`;
      back(() => organizeNote(`${how}.${what}`, { undo: true }));
    }
  } catch (err) {
    back(() => organizeNote(err.tooFew ? err.message : `${t('organize.failed')}: ${err.message}`)); // "nothing to organize" isn't a failure
  } finally {
    organizing = false;
    organizeAbort = null;
    back(() => ui()?.send('tabs:organizing', false));
  }
  return made;
}
// "1 group.", "3 groups, 1 tab left loose.": the singular strings are keys of their own (the string table has no plural rules).
const organizeSummary = (groups, loose) => t(organizeAi.summaryKey(groups, loose), { groups, loose });
// The note when the AI step failed: "took too long" only for a real timeout, else the real cause (not signed in, no key...).
function aiFailureNote(failed, standalone = true) {
  if (failed === 'timeout') return standalone ? t('organize.slowNone') : t('organize.slow');
  const cause = String(failed).replace(/\s+/g, ' ').trim().slice(0, 160);
  if (standalone) return `${t('organize.failed')}: ${cause.replace(/[.]$/, '') || t('organize.localOnly')}.`; // nothing was grouped: not "organized on this computer"
  return `${t('organize.localOnly')}${cause ? `: ${cause.replace(/[.]$/, '')}` : ''}`;
}
// Why Organize has nothing to work on: no pages at all, or only pinned tabs / tabs in groups the user made.
function tooFewMessage() {
  const c = tabGroups.organizeCounts();
  const err = new Error(c.web >= 2 ? t(c.pinned ? 'organize.onlyPinnedOrGrouped' : 'organize.onlyGrouped') : t('organize.tooFew'));
  err.tooFew = true;
  return err;
}

// ---- topic groups: local clusters (tab-groups.js), or named by the cheapest model of the chat's provider
// when "Use AI to name and group topics" is on. Only ids, titles and hostnames are sent.
function cheapTopicModel() {
  return standInOf(cheapTopicModelFor());
}
function cheapTopicModelFor() {
  const chosen = agent.messages.settings?.model || readSettings().model || DEFAULT_MODEL;
  if (LOCAL_ENGINE.test(chosen)) return chosen; // proposeGroupsLocal picks the fast model itself
  const { provider } = providers.splitModel(chosen);
  if (provider === 'anthropic') return 'claude-haiku-4-5';
  const list = providerModels[provider] || providers.PROVIDERS[provider].defaults;
  return `${provider}:${list.find((m) => /mini|flash|fast|lite|haiku/i.test(m)) || list[0]}`;
}
// What a model is told about a tab: id, title, host and the words of the address path. Never the page,
// the full address or its query string. The active tab is marked, a tab already in a group carries
// the group's name so the model can keep it there, and a tab of a hinted site (tab-groups siteHint,
// worked out from the host and path alone) carries that hint ("School" for Canvas).
const MAX_ORGANIZE_TABS = 80;
const topicList = (entries) => entries.slice(0, MAX_ORGANIZE_TABS).map((e) => {
  const tab = tabs.find((x) => x.id === e.id);
  const group = tab?.groupId ? tabGroups.groups.get(tab.groupId) : null;
  const path = pathWords(e.url);
  const hint = siteHint(e.url) || e.aiHint; // the fixed table first, then what a model said about the site
  return { id: e.id, title: String(e.title).slice(0, 100), host: hostOf(e.url), ...(path ? { path } : {}), ...(hint ? { hint } : {}), ...(group ? { group: group.name } : {}), ...(e.id === activeId ? { active: true } : {}) };
});

let aiTopicsTimer = null;
let aiTopicsBusy = false;
let aiTopicsLastKey = '';
// Automatic, with AI: debounced, only for 4+ loose tabs, and not again for the same set of tabs.
function scheduleAiTopics() {
  clearTimeout(aiTopicsTimer);
  aiTopicsTimer = setTimeout(async () => {
    const pool = tabGroups.loose();
    const key = pool.map((e) => `${e.id}:${e.title}`).join('|');
    if (aiTopicsBusy || pool.length < 4 || key === aiTopicsLastKey) return;
    aiTopicsBusy = true;
    aiTopicsLastKey = key;
    try {
      if (tabGroups.groupLoose(await withFallback(cheapTopicModel(), (m) => proposeGroups(m, topicList(pool))))) sendTabs();
    } catch {
      if (tabGroups.groupLoose()) sendTabs(); // no key or no network: the local clusters instead
    } finally {
      aiTopicsBusy = false;
    }
  }, 2500);
}

// "Organize Tabs" (tab menu, Tab Groups, and the strip's button) is organizeTabs: the local organizer groups, and with "Use AI to
// name and group topics" on a model only refines that result in place. It never proposes the groups itself.
const organizeByTopic = organizeTabs; // the name the test hook (__organizeByTopic) and scripts/capture-media.js call
// "Merge Similar Groups": groups with alike names (and related tabs) become one. One step of undo.
function mergeGroups() {
  if (tabGroups.mergeGroups()) sendTabs();
}
function undoOrganize() {
  if (tabGroups.undoOrganize()) sendTabs();
}
// "Close Duplicate Tabs" (never automatic): tabs that show exactly the same page, keeping the active one, or a
// pinned one, or the first. Pinned tabs are never closed.
function duplicateTabs() {
  return organizeLearn.findDuplicates(tabs.filter((x) => !x.closing).map((x) => ({ id: x.id, url: tabUrl(x), pinned: Boolean(x.pinned), active: x.id === activeId })));
}
function closeDuplicateTabs() {
  const ids = new Set(duplicateTabs().flatMap((d) => d.close));
  for (const id of ids) requestCloseTab(id);
}

// "Organize tabs automatically" (on by default): a few seconds after the tabs change (Settings, default 5),
// the LOCAL organizer groups the loose tabs (never the AI) and a note offers Undo. A handful of tabs that
// are all one topic is left alone (features/organize-learn.js shouldAutoOrganize).
let idleOrganizeKey = null;
let autoOrganizeTimer = null;
function autoOrganizeNow() {
  const settings = readSettings();
  if (settings.organizeWhenIdle === false) return false;
  try {
    const pool = tabGroups.loose();
    const key = organizeAi.setKey(pool);
    const topics = pool.length >= 2 ? require('./browser/tab-groups').topicClusters(pool).map((c) => c.ids) : [];
    if (!organizeLearn.shouldAutoOrganize({ enabled: true, ungrouped: pool.length, topics, key, lastKey: idleOrganizeKey, busy: organizing, onlyMixed: settings.organizeOnlyMixed !== false })) return false;
    idleOrganizeKey = key;
    if (tabGroups.organizeLoose()) { sendTabs(); organizeNote(t('organize.idleDone'), { undo: true }); return true; }
  } catch {}
  return false;
}
function scheduleAutoOrganize() {
  if (TEST && global.__autoOrganizeInTest !== true) return;
  clearTimeout(autoOrganizeTimer);
  autoOrganizeTimer = setTimeout(autoOrganizeNow, organizeLearn.organizeDelay(readSettings().organizeDelaySeconds) * 1000);
  autoOrganizeTimer.unref?.();
}
if (TEST) global.__autoOrganizeNow = autoOrganizeNow;

const colorLabel = (c) => t(`color.${c}`);

// ---------- pinned tabs ----------
// Pinned tabs sit at the left of the strip, icon only, and are never in a group. Anything that
// puts a pinned tab into a group (the agent's group_tabs, "Organize") unpins it instead.
function keepPinnedFirst() {
  for (const t of tabs) if (t.pinned && t.groupId) t.pinned = false;
  const firstLoose = tabs.findIndex((t) => !t.pinned);
  if (firstLoose === -1 || !tabs.slice(firstLoose).some((t) => t.pinned)) return;
  tabs = [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];
}

function pinTab(id, on) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab || Boolean(tab.pinned) === on) return;
  manners.handOver(tab); // [ai manners] a tab the user pins is theirs
  if (on && tab.groupId) tabGroups.remove(id, { byUser: true });
  tab.pinned = on;
  tab.userRemoved = true; // pinned or unpinned by hand: automatic grouping leaves it alone
  // A newly pinned tab goes after the other pinned tabs; an unpinned one becomes the first loose tab.
  tabs.splice(tabs.indexOf(tab), 1);
  tabs.splice(tabs.filter((t) => t.pinned).length, 0, tab);
  tabGroups.cleanup();
  sendTabs();
}

// ---- [tab audio + tab search] (features/tab-tools.js)
const tabUrl = (tab) => (alive(tab) ? realUrl(tab.view.webContents) : tab.sleepUrl || '');
const tabTitle = (tab) => (alive(tab) ? tab.view.webContents.getTitle() : tab.sleepTitle || '');
function audioMenuItems(tab) {
  const muted = tabTools.state(tab, alive(tab)).muted;
  const host = tabTools.siteOf(tabUrl(tab));
  const items = [{ label: muted ? t('menu.unmuteTab') : t('menu.muteTab'), click: () => tabTools.setMuted(tab, !muted) }];
  if (host) {
    const siteMuted = tabTools.siteMuted(host);
    items.push({ label: siteMuted ? t('menu.unmuteSite') : t('menu.muteSite'), click: () => tabTools.setSiteMuted(host, !siteMuted, tabs, tabUrl) });
  }
  return items;
}
function openTabSearch() {
  ui()?.focus();
  ui()?.send('tabsearch:open');
}
function reopenClosed(index, url) {
  if (!Number.isInteger(index) || closedTabs[index] !== url) return false; // the list changed meanwhile
  closedTabs.splice(index, 1);
  openTab(url);
  return true;
}
// ---- [/tab audio + tab search]

// The tab strip's right-click menu, in Chrome's order. Close Other Tabs / Close Tabs to the Right
// leave pinned tabs alone, as Chrome does.
function tabMenuTemplate(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return null;
  const url = tabUrl(tab);
  const closable = (t) => t.id !== id && !t.pinned && !t.closing;
  const toRight = () => tabs.slice(tabs.indexOf(tab) + 1).filter(closable);
  const marked = isWebUrl(url) && bookmarks().some((b) => b.url === url);
  const items = [{ label: t('menu.newTabRight'), click: () => newTabRightOf(id) }];
  if (!tab.pinned) {
    const others = tabGroups.state().filter((g) => g.id !== tab.groupId);
    items.push({
      label: t('menu.addToNewGroup'),
      click: () => {
        manners.handOver(tab); // [ai manners] a tab the user groups is theirs
        if (tab.groupId) tabGroups.remove(id, { byUser: true });
        // A sleeping tab has no webContents to read; its sleep snapshot has the same info.
        const title = alive(tab) ? tab.view.webContents.getTitle() : tab.sleepTitle || '';
        const group = tabGroups.create(isWebUrl(url) ? siteName(url, title) : 'New Group', [id]);
        sendTabs();
        ui()?.send('group:rename-start', group.id);
      },
    });
    if (others.length) items.push({ label: t('menu.addToGroup'), submenu: others.map((g) => ({ label: g.name, click: () => { manners.handOver(tab); const e = tabGroups.entryFor(id); if (e) organizeLearner.learnPlacement(e, g.name); tabGroups.add(id, g.id); sendTabs(); } })) });
    if (tab.groupId) items.push({ label: t('menu.removeFromGroup'), click: () => { manners.handOver(tab); tabGroups.remove(id, { byUser: true }); sendTabs(); } });
    items.push({ label: t('menu.organizeByTopic'), click: organizeFromMenu });
    const dupCount = duplicateTabs().reduce((n, d) => n + d.close.length, 0);
    if (dupCount) items.push({ label: t('menu.closeDuplicates', { n: dupCount }), click: closeDuplicateTabs });
    if (tabGroups.state().length > 1) items.push({ label: t('menu.mergeGroups'), click: mergeGroups });
    if (tabGroups.canUndo()) items.push({ label: t('menu.undoOrganize'), click: undoOrganize });
  }
  items.push(
    { type: 'separator' },
    { label: t('menu.reload'), click: () => reloadTab(tab) },
    { label: t('menu.duplicate'), enabled: !tab.settings, click: () => duplicateTab(id) }, // [settings] one settings tab
    tab.pinned ? { label: t('menu.unpinTab'), click: () => pinTab(id, false) } : { label: t('menu.pinTab'), click: () => pinTab(id, true) },
    ...audioMenuItems(tab),
    ...moveWindowItems(id),
    { type: 'separator' },
    { label: t('menu.copyLink'), enabled: isWebUrl(url), click: () => clipboard.writeText(url) },
    { label: marked ? t('menu.removeBookmark') : t('menu.bookmarkTab'), enabled: isWebUrl(url), click: () => toggleBookmarkFor(tab) },
    { label: t('menu.bookmarkAllTabs'), enabled: tabs.some((x) => isWebUrl(tabUrl(x))), click: bookmarkAllTabs },
    { type: 'separator' },
    ...aiSiteMenu(tab),
    { label: t('menu.closeTab'), click: () => requestCloseTab(id) },
    { label: t('menu.closeOtherTabs'), enabled: tabs.some(closable), click: () => closeTabs(id, tabs.filter(closable)) },
    { label: t('menu.closeTabsRight'), enabled: toRight().length > 0, click: () => closeTabs(id, toRight()) },
    { label: t('menu.closeAiTabs'), enabled: aiTabSelect({ rec: curRec }).length > 0, click: () => { aiTabsClose({ rec: curRec }).catch(() => {}); } }, // [ai manners]
    { type: 'separator' },
    { label: t('menu.reopenTab'), enabled: closedTabs.length > 0, click: reopenLastClosed },
  );
  return items;
}

// A step down-right of the window the menu was opened on. A maximized window's current bounds fill
// the screen, so the step is taken from the size it will return to, which still fits.
function cascadedWindowPoint(win) {
  const b = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
  return { x: Math.round(b.x + 32), y: Math.round(b.y + 32) };
}
// "Move Tab to New Window" (not for a window's only tab) and "Move Tab to Window", one entry per
// other normal window. Private windows never appear: a tab can't move in or out of one.
function moveWindowItems(id) {
  const src = curRec;
  const items = [];
  if (!src) return items;
  const ids = tabsActedOn(src, id); // the whole multi-selection, when the menu is opened on one of its tabs
  const n = ids.length;
  if (tabs.filter((x) => !x.closing).length - n >= 1) {
    items.push({ label: n > 1 ? t('menu.moveTabsToNewWindow', { n }) : t('menu.moveToNewWindow'), click: () => tearOffTab(src, id, cascadedWindowPoint(src.win), ids) });
  }
  const others = [...winRecs].filter((r) => r !== src && rcAlive(r) && !isSpare(r));
  if (others.length) items.push({ label: n > 1 ? t('menu.moveTabsToWindow', { n }) : t('menu.moveToWindow'), submenu: others.map((r) => ({ label: windowLabel(r), click: () => { if (moveTabsBetween(src, r, ids, undefined, { active: id })) arrivedFromMenu(r, ids); } })) });
  items.push(...mergeWindowItems(src));
  return items;
}

function tabMenu(id, { x, y }) {
  const items = tabMenuTemplate(id);
  if (items) Menu.buildFromTemplate(items).popup({ window: win, x: Math.round(x), y: Math.round(y) });
}

// Close Other Tabs / Close Tabs to the Right: the tab the menu was opened on comes to the front
// first (Chrome does too), then each one goes through requestCloseTab, so "Leave site?" is asked
// and Reopen Closed Tab gets them back.
function closeTabs(keepId, list) {
  if (list.some((t) => t.id === activeId)) switchTab(keepId);
  for (const t of list) requestCloseTab(t.id);
}

function reopenLastClosed() {
  if (closedTabs.length) openTab(closedTabs.pop());
}

// Puts `tab` right after `anchor`, in anchor's group. An unpinned tab next to a pinned one goes
// after the pinned tabs (they stay first).
function placeAfter(tab, anchor) {
  const list = tabs.filter((t) => t !== tab);
  const at = anchor.pinned && !tab.pinned ? list.filter((t) => t.pinned).length : list.indexOf(anchor) + 1;
  list.splice(at, 0, tab);
  tabs = list;
  if (anchor.groupId && !tab.pinned) { tab.groupId = anchor.groupId; tab.userRemoved = false; }
  tabGroups.arrange();
  sendTabs();
}

function newTabRightOf(id) {
  const anchor = tabs.find((t) => t.id === id);
  if (!anchor) return null;
  const { id: newId } = openTab();
  placeAfter(tabs.find((t) => t.id === newId), anchor);
  return newId;
}

// Duplicate: the same page with its back/forward list, right after the original (pinned if it is,
// in its group), and shown, as in Chrome.
function duplicateTab(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab || tab.settings) return null;
  let history = tab.sleepHistory || null;
  if (alive(tab)) {
    try {
      const nav = tab.view.webContents.navigationHistory;
      history = { entries: nav.getAllEntries(), index: nav.getActiveIndex() };
    } catch {
      history = null; // loads the URL instead
    }
  }
  const url = tabUrl(tab) || newTabUrl();
  const { id: newId } = openTab(url, { background: true, history, historyPage: url.startsWith(HISTORY_URL), managerPage: tab.managerPage || null, partition: tab.isolated });
  const copy = tabs.find((t) => t.id === newId);
  copy.pinned = Boolean(tab.pinned);
  placeAfter(copy, tab);
  switchTab(newId);
  return newId;
}

// A tab's Reload (and Cmd+Shift+R for the one in front, bypassing the cache). A sleeping tab is
// woken, which loads it.
function reloadTab(tab, { ignoreCache = false } = {}) {
  if (!tab) return;
  if (tab.sleeping) { wakeTab(tab); layout(); sendTabs(); return; }
  if (!alive(tab)) return;
  const wc = tab.view.webContents;
  if (wc.isLoading() && !ignoreCache) wc.stop();
  else if (isErrorPage(wc.getURL())) wc.loadURL(realUrl(wc)).catch(() => {});
  else if (ignoreCache) wc.reloadIgnoringCache();
  else wc.reload();
}

// [ai controls] "Turn off AI on <site>" for a web tab (features/ai-sites.js).
function aiSiteMenu(tab) {
  const url = alive(tab) ? realUrl(tab.view.webContents) : tab.sleepUrl || '';
  const site = aiSiteOf(url);
  if (!site) return [];
  const off = aiSites.isOff(url);
  return [{ label: off ? t('menu.turnOnAi', { site }) : t('menu.turnOffAi', { site }), click: () => { aiSites.set(site, !off); sendTabs(); } }, { type: 'separator' }];
}

function groupMenu(groupId, { x, y }) {
  const group = tabGroups.groups.get(groupId);
  if (!group) return;
  Menu.buildFromTemplate([
    { label: t('menu.rename'), click: () => ui()?.send('group:rename-start', groupId) },
    { label: t('menu.colour'), submenu: tabGroups.GROUP_COLORS.map((c) => ({ label: colorLabel(c), type: 'radio', checked: group.color === c, click: () => { group.color = c; group.colorLocked = true; sendTabs(); } })) },
    { label: t('menu.newTabInGroup'), click: () => openTab(undefined, { groupId }) },
    ...moveGroupItems(groupId),
    { type: 'separator' },
    { label: t('menu.ungroup'), click: () => { tabGroups.ungroupAll(groupId); sendTabs(); } },
    { label: t('menu.closeGroup'), click: () => tabGroups.members(groupId).map((t) => t.id).forEach((id) => closeTab(id, { user: true })) },
  ]).popup({ window: win, x: Math.round(x), y: Math.round(y) });
}

// "Move Group to New Window" / "Move Group to Window": the whole group goes, and stays a group there.
function moveGroupItems(groupId) {
  const src = curRec;
  const moving = src && groupForMove(src, groupId);
  if (!moving) return [];
  const lead = moving.ids.includes(activeId) ? activeId : moving.ids[0];
  const items = [];
  if (tabs.filter((x) => !x.closing).length - moving.ids.length >= 1) {
    items.push({ label: t('menu.moveGroupToNewWindow'), click: () => tearOffTab(src, lead, cascadedWindowPoint(src.win), moving.ids, moving.group) });
  }
  const others = [...winRecs].filter((r) => r !== src && rcAlive(r) && !isSpare(r));
  if (others.length) items.push({ label: t('menu.moveGroupToWindow'), submenu: others.map((r) => ({ label: windowLabel(r), click: () => { if (moveTabsBetween(src, r, moving.ids, undefined, { active: lead, group: moving.group })) arrivedFromMenu(r, moving.ids); } })) });
  return items;
}

// The one "Organize Tabs" item: the local run, refined by a model when AI is on (choosing it again while it refines cancels it).
const organizeFromMenu = organizeTabs;

function tabGroupsMenu() {
  const mode = groupingMode();
  return [
    { label: t('menu.organizeByTopic'), click: organizeFromMenu },
    { label: t('menu.mergeGroups'), enabled: tabGroups.state().length > 1, click: mergeGroups },
    { label: t('menu.undoOrganize'), enabled: tabGroups.canUndo(), click: undoOrganize },
    { type: 'separator' },
    { label: t('menu.groupAutomatically'), enabled: false },
    ...[['off', t('menu.off')], ['site', t('menu.bySite')], ['topic', t('menu.byTopic')]].map(([value, label]) => ({ label, type: 'radio', checked: mode === value, click: () => setTabGrouping(value) })),
  ];
}

function setTabGrouping(mode) {
  if (!['off', 'site', 'topic'].includes(mode)) return false;
  writeSettings({ ...readSettings(), tabGrouping: mode, autoGroupTabs: mode !== 'off' });
  if (mode !== 'off') scheduleAutoGroup();
  return true;
}
// The older on/off switch: on means by site unless topics were chosen.
const setAutoGroup = (on) => setTabGrouping(on ? (groupingMode() === 'topic' ? 'topic' : 'site') : 'off');

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
  managers.pushBookmarks();
  let addedHistory = 0;
  for (const h of data.history) {
    if (isCaptchaPage(h.url)) continue;
    const entry = history.get(h.url);
    if (entry) {
      entry.visits = Math.max(entry.visits, h.visits);
      entry.last = Math.max(entry.last, h.last);
      if (!entry.title && h.title) entry.title = h.title;
      historyVersion++;
    } else {
      history.set(h.url, { url: h.url, title: h.title, visits: h.visits, last: h.last });
      addedHistory++;
      historyVersion++;
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
      message: t('import.done', { browser: result.label }),
      detail: t('import.detail', {
        bookmarks: t(result.bookmarks === 1 ? 'import.bookmarks.one' : 'import.bookmarks.other', { count: result.bookmarks }),
        history: t(result.history === 1 ? 'import.history.one' : 'import.history.other', { count: result.history.toLocaleString() }),
      }),
    });
  } catch (err) {
    await dialog.showMessageBox(win, { type: 'warning', message: t('import.failed'), detail: err.message });
  }
}

// First run, import without a dialog, and the default browser (features/setup.js).
const setup = require('./features/setup').create({
  app, shell, readSettings, writeSettings, importer, importBrowser: (id) => importBrowser(id), freshInstall: () => settingsFileExisted === false,
});
ipcMain.handle('settings:setup-state', () => setup.state());
ipcMain.handle('settings:setup-done', () => { setup.welcomeDone(); return true; });
ipcMain.handle('settings:default-browser', () => setup.isDefault());
ipcMain.handle('settings:make-default', () => setup.makeDefault());
ipcMain.handle('import:quiet', (_e, id) => setup.importFrom(String(id || '')));

function importMenu() {
  const found = importer.detectBrowsers();
  if (!found.length) return [{ label: t('menu.noBrowsers'), enabled: false }];
  return found.map((b) => ({ label: b.label, click: () => runImport(b.id) }));
}

// ---------- history menu ----------

// The History page asks for its entries over IPC (history-preload.js). They used to be packed into
// the page's URL, which a long history pushed past Chromium's URL length limit (a blank page).
function openHistoryPage() {
  openTab(HISTORY_URL, { historyPage: true });
}
const fromHistoryPage = (event) => event.senderFrame === event.sender.mainFrame && event.sender.getURL().startsWith(HISTORY_URL);
ipcMain.handle('history:list', async (event) => {
  if (!fromHistoryPage(event)) return [];
  await historyReady;
  return [...history.values()].sort((a, b) => b.last - a.last).slice(0, 5000).map(({ url, title, last }) => ({ url, title, last }));
});
ipcMain.handle('history:remove', async (event, url) => {
  await historyReady;
  if (!fromHistoryPage(event) || typeof url !== 'string' || !history.delete(url)) return false;
  saveHistorySoon();
  return true;
});

function historyMenu() {
  const recent = [...history.values()].sort((a, b) => b.last - a.last).slice(0, 15);
  if (!recent.length) return [{ label: t('menu.noHistory'), enabled: false }];
  return [
    { label: t('menu.showAllHistory'), accelerator: process.platform === 'darwin' ? 'Cmd+Y' : 'Ctrl+H', click: openHistoryPage },
    { type: 'separator' },
    ...recent.map((h) => ({ label: (h.title || bareUrl(h.url)).slice(0, 60), click: () => openTab(h.url) })),
    { type: 'separator' },
    {
      label: t('menu.clearHistory'),
      click: async () => {
        const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: [t('dialog.cancel'), t('history.clear.button')], defaultId: 1, cancelId: 0, message: t('history.clear'), detail: t('history.clear.detail') });
        if (response !== 1) return;
        await historyReady;
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
let historyVersion = 0; // bumped on every visit or import: frequentSites is remembered until it changes
let frequentMemo = null;
function frequentSites(limit = 6) {
  // One memo at the largest size asked for (the new-tab page asks for 6, the favicon cache for 12): the two
  // never evict each other.
  const size = Math.max(limit, 12);
  const key = `${historyVersion}|${history.size}|${size}|${bookmarks().map((b) => b.url).join(' ')}`;
  if (frequentMemo?.key !== key) frequentMemo = { key, out: frequentSitesNow(size) };
  return frequentMemo.out.slice(0, limit);
}
function frequentSitesNow(limit) {
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

// A cached favicon (a data: URL) as a file the new-tab page loads (its CSP allows file: images), written once.
const faviconFiles = new Map(); // data URL hash -> file URL
const FAVICON_FILE_URL = /^file:\/\/\/.+\/favicon-cache\/[0-9a-f]{20}\.[a-z0-9]+$/i;
const faviconFileOf = new Map(); // data: address -> its file (no sha1 of 50 KB per lookup)
function faviconFile(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
  if (faviconFileOf.has(dataUrl)) return faviconFileOf.get(dataUrl);
  const out = faviconFileNow(dataUrl);
  if (faviconFileOf.size > 500) faviconFileOf.clear();
  faviconFileOf.set(dataUrl, out);
  return out;
}
function faviconFileNow(dataUrl) {
  const key = require('crypto').createHash('sha1').update(dataUrl).digest('hex').slice(0, 20);
  if (faviconFiles.has(key)) return faviconFiles.get(key);
  const m = dataUrl.match(/^data:image\/([a-z+.-]+);base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) return dataUrl; // (not base64: passed as it is)
  const dir = path.join(app.getPath('userData'), 'favicon-cache');
  const ext = { 'x-icon': 'ico', 'vnd.microsoft.icon': 'ico', 'svg+xml': 'svg', jpeg: 'jpg' }[m[1].toLowerCase()] || m[1].toLowerCase().replace(/[^a-z0-9]/g, '');
  const file = path.join(dir, `${key}.${ext}`);
  try {
    if (!fs.existsSync(file)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, Buffer.from(m[2], 'base64')); }
  } catch { return dataUrl; }
  const url = pathToFileURL(file).href;
  faviconFiles.set(key, url);
  return url;
}
function newTabUrl() {
  const withIcon = (b) => { const icon = faviconFile(faviconStore.get(hostOf(b.url))); return icon ? { ...b, icon } : b; };
  const data = {
    favorites: bookmarks().filter((b) => !b.folder).slice(0, 12).map(withIcon),
    frequent: frequentSites().map(withIcon),
    blocked: adblock.total(), // ads/trackers blocked on open tabs
    search: engineFor(readSettings().searchEngine),
    assistant: homeAssistant(),
    look: settingsBackend.newTabLook(), // [look] background, accent, clock, name, which sections show
    widgets: widgets.forPage(), // [widgets] display data only (cached; stale ones refresh in the background)
  };
  return `${NEW_TAB_URL}#${encodeURIComponent(JSON.stringify(data))}`;
}

// Who "Ask AI" on the new-tab page talks to, and whether the assistant can answer right now.
// Driven by the same connected options as the sidebar's picker, so the two never disagree.
const ASSISTANT_NAMES = { anthropic: 'Claude', openai: 'ChatGPT', xai: 'Grok', gemini: 'Gemini', openrouter: 'OpenRouter' };
function homeAssistant() {
  const options = modelOptions();
  if (!options.length) return { name: 'AI', agentUsable: false }; // nothing connected: no provider to privilege
  const saved = readSettings().model;
  const modelId = options.some((o) => o.id === saved) ? saved : options[0].id;
  if (String(modelId).startsWith('claudecode:')) return { name: 'Claude', agentUsable: true };
  if (String(modelId).startsWith('grokbuild:')) return { name: 'Grok', agentUsable: true };
  if (String(modelId).startsWith('antigravity:')) return { name: 'Antigravity', agentUsable: true };
  const { provider } = providers.splitModel(modelId);
  return { name: ASSISTANT_NAMES[provider] || 'AI', agentUsable: true };
}

// The new-tab page asks by loading itself with ?ask=<prompt>: cancel that and hand the prompt to the
// sidebar, along with the tab id so the UI can put that tab's chat in full-page mode.
function askFromHome(event, url, tabId) {
  if (!isNewTab(url)) return false;
  let text;
  try { text = new URL(url).searchParams.get('ask'); } catch { return false; }
  if (text === null) return false;
  event.preventDefault();
  text = text.trim().slice(0, 20000);
  if (!text) return true;
  ui()?.send('ask-from-home', { text, tabId });
  return true;
}

// [widgets] The new-tab page's widget buttons (a Todoist checkbox, Refresh) load the page itself
// with ?widget=<id>&do=…, the same way Ask AI does: cancel that and do it here.
function widgetAction(event, url, wc = null) {
  if (!isNewTab(url)) return false;
  const action = widgets.actionFrom(url);
  if (!action) return false;
  event.preventDefault();
  if (action.invalid) return true;
  const done = widgets.act(action);
  // The page's own add/edit form (do=setup) hears how it went: saved, or what to fix.
  if (action.do === 'setup') {
    done.then((r) => { if (wc && !wc.isDestroyed() && isNewTab(wc.getURL())) wc.executeJavaScript(`window.widgetSetupResult?.(${JSON.stringify(r)})`).catch(() => {}); });
  }
  done.catch((err) => console.error('[lumen] widget action:', err.message));
  return true;
}

// When a favorite or frequently visited site shows its favicon, keep a small copy for the new-tab page.
// iconUrls: the page's candidates; the first one that downloads as a small image is kept.
async function cacheFavicon(pageUrl, iconUrls) {
  const host = hostOf(pageUrl);
  if (!host || faviconStore.has(host)) return;
  // Only sites the new-tab page shows: favorites and frequently visited ones.
  if (!bookmarks().some((b) => hostOf(b.url) === host) && !frequentSites(12).some((s) => hostOf(s.url) === host)) return;
  for (const iconUrl of iconUrls.filter((u) => /^https?:/.test(u))) {
    try {
      const res = await net.fetch(iconUrl);
      const type = res.headers.get('content-type') || '';
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!res.ok || !type.startsWith('image/') || bytes.length > 40000) continue;
      faviconStore.set(host, `data:${type.split(';')[0]};base64,${bytes.toString('base64')}`);
      return;
    } catch {
      // This candidate is unavailable; try the next (with none, the new-tab page shows a letter).
    }
  }
}

function toggleBookmark() {
  toggleBookmarkFor(tabs.find((t) => t.id === activeId));
}

// The tab menu's Bookmark Tab works on any tab, sleeping ones too (from their sleep snapshot).
function toggleBookmarkFor(tab) {
  const url = tab ? tabUrl(tab) : '';
  if (!isWebUrl(url)) return;
  const list = bookmarks();
  const index = list.findIndex((b) => b.url === url);
  if (index >= 0) list.splice(index, 1);
  else list.push({ url, title: tabTitle(tab) || hostOf(url) });
  writeSettings({ ...readSettings(), bookmarks: list });
  sendTabs();
  managers.pushBookmarks(); // an open Bookmarks page
}

// Bookmark All Tabs (tab menu, Cmd+Shift+D): every web tab, in strip order, into a new folder named
// for the day. Chrome asks for the name in a dialog; this names it, and the Bookmarks page renames.
function bookmarkAllTabs() {
  const pages = [...new Set(tabs.map(tabUrl).filter(isWebUrl))];
  if (!pages.length) return null;
  const list = bookmarks();
  const base = t('bookmark.savedTabs', { date: new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) });
  let folder = base;
  for (let n = 2; list.some((b) => b.folder === folder); n++) folder = `${base} (${n})`;
  for (const url of pages) list.push({ url, title: tabTitle(tabs.find((x) => tabUrl(x) === url)) || hostOf(url), folder });
  writeSettings({ ...readSettings(), bookmarks: list });
  sendTabs();
  managers.pushBookmarks();
  return folder;
}

function bookmarksMenu() {
  const list = bookmarks();
  const wc = activeTab()?.webContents;
  const current = wc ? realUrl(wc) : '';
  const marked = list.some((b) => b.url === current);
  return [
    { label: marked ? t('menu.removeBookmark') : t('menu.bookmarkPage'), accelerator: 'CmdOrCtrl+D', enabled: isWebUrl(current), click: toggleBookmark },
    { label: t('menu.showAllBookmarks'), accelerator: 'CmdOrCtrl+Shift+O', click: () => managers.open('bookmarks') },
    { type: 'separator' },
    ...list.filter((b) => !b.folder).map((b) => ({ label: b.title || b.url, click: () => openTab(b.url) })),
    ...[...new Set(list.filter((b) => b.folder).map((b) => b.folder))].map((folder) => ({
      label: folder,
      submenu: list.filter((b) => b.folder === folder).map((b) => ({ label: b.title || b.url, click: () => openTab(b.url) })),
    })),
  ];
}

// ---------- downloads (features/downloads.js) ----------

const downloads = createDownloads({
  app, session, dialog, shell, ui,
  win: () => win,
  panel: () => (downloadsView && !downloadsView.webContents.isDestroyed() ? downloadsView.webContents : null),
  fallbackIcon: () => require('electron').nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 32 }),
  downloadDir: () => settingsBackend.downloadDir(), // [settings] Downloads folder unless changed in Settings
  askWhereToSave: () => settingsBackend.askWhereToSave(),
  askOnce: (urls) => saveAsMarks.take(urls), // Save Link As… / Save Image As…
  onChange: () => managers?.pushDownloads(),
});

// ---------- Bookmarks and Downloads pages (features/managers.js) ----------

const managers = createManagers({
  ipcMain, dialog, hostOf,
  win: () => win,
  tabs: () => tabs,
  alive,
  openTab: (url, opts) => openTab(url, opts),
  switchTab: (id) => switchTab(id),
  bookmarks: () => bookmarks(),
  saveBookmarks: (list) => writeSettings({ ...readSettings(), bookmarks: list }),
  bookmarksChanged: () => sendTabs(),
  downloads,
  openFolder: () => shell.openPath(settingsBackend.downloadDir()),
});
managers.setup();
// When each site last stored cookies: lets Clear browsing data honour a time range for them.
const siteActivity = createSiteActivity({ userData: app.getPath('userData') });
if (TEST) global.__managers = { managers, siteActivity, history: () => history, downloads };

// Electron reports only "Chromium" in UA client hints while the user agent says Chrome; sites
// (Google especially) treat that mismatch as a bot signal. Align both through the DevTools protocol; the
// brand list, headers and window.chrome all come from browser/chrome-identity.js so they agree.
const CHROME_IDENTITY = require('./browser/chrome-identity');
// Google's sign-in hosts refuse a Chrome-shaped Electron whatever it reports; they get a Firefox identity instead
// (browser/google-auth-identity.js): Firefox's User-Agent, no client hints, Firefox's navigator, no window.chrome.
const GOOGLE_AUTH = require('./browser/google-auth-identity');
const FIREFOX_PROFILE = GOOGLE_AUTH.firefoxProfile(process.platform);
const UA_METADATA = CHROME_IDENTITY.uaMetadata({
  chromeVersion: process.versions.chrome, platform: process.platform, arch: process.arch,
  release: require('os').release(), systemVersion: process.platform === 'darwin' ? process.getSystemVersion() : '',
});
// The same identity for the Sec-CH-UA request headers, which Chrome sends on every request to a
// secure origin. Requests from tabs otherwise go out with none at all (and the browser's own with
// Electron's Chromium-only list): a Chrome user agent without them is what bot checks look for.
const UA_HINT_HEADERS = CHROME_IDENTITY.lowEntropyHeaders(UA_METADATA);
// Sec-CH-UA-Arch, -Platform-Version, -Full-Version-List… for an origin whose response asked for them (settings-backend.js).
const uaHighEntropyHeaders = (hints) => CHROME_IDENTITY.highEntropyHeaders(UA_METADATA, hints);
// The override only covers the tab's own frame. Cross-origin iframes and workers are separate
// targets that would still say "Chromium", and Cloudflare's checkbox (an iframe from
// challenges.cloudflare.com) fails a page whose frames disagree. So auto-attach to each one, paused
// at start, give it the same identity, then let it run.
// A sign-in or payment popup: its own small window that keeps window.opener, presents itself as Chrome from its
// first request, and can itself open a further popup the same way (some sign-ins chain two).
const popupWindowOptions = () => ({
  autoHideMenuBar: true,
  backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
  icon: WINDOW_ICON,
  webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, ...settingsBackend.tabWebPreferences(false) },
});
// Google's "This browser or app may not be secure" page: what to try, instead of a dead end. For tabs a note in the
// strip; for popups and private windows (no strip) a small dialog over the window.
// Automation on: Chromium's remote-debugging pipe (or port) is open, which Google can read as a bot.
const automationIsOn = () => Boolean(readSettings().automationEnabled);
function turnAutomationOff() { // what Settings → Advanced → Automation does when switched off, then a restart
  try { writeSettings({ ...readSettings(), automationEnabled: false }); } catch {}
  try { fs.rmSync(path.join(app.getPath('userData'), 'automation-token'), { force: true }); } catch {} // (a new address when it is turned on again)
  app.relaunch();
  app.quit();
}
const googleRefusedText = (wc, inTab) => (!identified.has(wc)
  ? t('google.refused.debugger') // Lumen couldn't present itself as Chrome here: another debugger holds the page
  : automationIsOn() ? t('google.refused.automation')
  : t(inTab ? 'google.refused.tipsTab' : 'google.refused.tips'));
// win: the window to show the dialog over (a tab's browser window); by default the popup's own.
function googleRefusedGuard(wc, { inTab = false, win: winOf = null } = {}) {
  let shown = 0;
  const check = (_e, navUrl) => {
    if (!/^https:\/\/accounts\.google\.com\/.*signin\/rejected/.test(String(navUrl)) || Date.now() - shown < 10000) return;
    shown = Date.now();
    const win = winOf?.() || BrowserWindow.fromWebContents(wc);
    const offer = identified.has(wc) && automationIsOn(); // one click to the likely fix
    if (win && !win.isDestroyed()) {
      electronDialog.showMessageBox(win, { type: 'info', message: t('google.refused.title'), detail: googleRefusedText(wc, inTab), buttons: offer ? [t('google.refused.turnOff'), 'OK'] : ['OK'], defaultId: 0, cancelId: offer ? 1 : 0 })
        .then(({ response }) => { if (offer && response === 0) turnAutomationOff(); }).catch(() => {});
    }
  };
  wc.on('did-navigate', check);
  wc.on('did-navigate-in-page', check); // Google's sign-in moves between steps without full loads
}
// A tab's page that fails to load: the Safe Browsing warning, the HTTPS-only page, the certificate warning or the
// error page, in that order (normal tabs and private ones).
function tabFailPage(wc) {
  wc.on('did-fail-load', (_e, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = aborted, e.g. the user navigated away
    const unsafe = safeBrowsing.warningUrl(wc, failedUrl, code); // a page Google lists as unsafe
    if (unsafe) { wc.loadURL(unsafe).catch(() => {}); return; }
    if (settingsBackend.onFailLoad(wc, failedUrl)) return; // [settings] HTTPS-only: no secure version
    const certWarning = siteSecurity.warningUrl(failedUrl, code, description);
    if (certWarning) { wc.loadURL(certWarning).catch(() => {}); return; }
    const params = new URLSearchParams({ url: failedUrl, code: String(code), desc: description });
    wc.loadURL(`${ERROR_URL}?${params}`).catch(() => {});
  });
}
// A popup that fails to load (offline, a certificate problem) says so, as a tab does, instead of staying white.
function popupFailPage(wc) {
  wc.on('did-fail-load', (_e, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    const certWarning = siteSecurity.warningUrl(failedUrl, code, description);
    wc.loadURL(certWarning || `${ERROR_URL}?${new URLSearchParams({ url: failedUrl, code: String(code), desc: description })}`).catch(() => {});
  });
}
function popupWindow(options, noIdentity = false, partition = null, url = null, openerTab = null) {
  const child = new BrowserWindow({ ...options, ...popupWindowOptions(), ...(options?.webContents ? { webContents: options.webContents } : {}), webPreferences: { ...options?.webPreferences, ...popupWindowOptions().webPreferences, ...(partition ? { partition } : {}) } });
  const wc = child.webContents;
  popupPartition.set(wc, partition);
  if (!noIdentity) applyChromeIdentity(wc); // before anything loads
  if (!options?.webContents && url) wc.loadURL(url).catch(() => {}); // no page yet: it loads the address itself
  popupFailPage(wc);
  googleRefusedGuard(wc);
  // While a sign-in popup is open, the tab that opened it doesn't go to sleep (it would lose the page it reports back to).
  if (openerTab) { openerTab.openPopups = (openerTab.openPopups || 0) + 1; child.on('closed', () => { openerTab.openPopups = Math.max(0, (openerTab.openPopups || 1) - 1); }); }
  // The title bar says which site this is (a popup has no address bar), with a lock when the connection is secure.
  // (Lumen's own pages, such as an error page, have no host: their title alone.)
  const titleFor = () => { try { const u = new URL(wc.getURL()); if (!u.host) return wc.getTitle() || 'Lumen'; return `${u.protocol === 'https:' ? '🔒 ' : ''}${u.host}${wc.getTitle() ? ` — ${wc.getTitle()}` : ''}`; } catch { return wc.getTitle() || 'Lumen'; } };
  const retitle = () => { if (!child.isDestroyed()) child.setTitle(titleFor()); };
  wc.on('page-title-updated', (e) => { e.preventDefault(); retitle(); });
  wc.on('did-navigate', retitle);
  wc.on('did-navigate-in-page', retitle);
  wc.on('context-menu', (_e, p) => showContextMenu(wc, p)); // paste into a password field, spelling, copy
  wc.on('before-input-event', (e, input) => { // Ctrl+W (Cmd+W) closes it, as it would a tab
    if (input.type === 'keyDown' && (input.control || input.meta) && !input.alt && input.key.toLowerCase() === 'w') { e.preventDefault(); child.close(); }
  });
  if (!partition) syncExtensions(() => { try { extensions?.addTab(wc, child); } catch {} }); // password managers can fill it
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (!isWebUrl(url) && url !== 'about:blank') return { action: 'deny' };
    if (disposition === 'new-window') return { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: popupWindowOptions(), createWindow: (o) => popupWindow(o, noIdentity, partition, url) };
    withWindow(curRec, () => openTab(url, { background: disposition === 'background-tab', partition })); // a research tab's popup keeps to its session
    return { action: 'deny' };
  });
  return wc;
}
const popupPartition = new WeakMap(); // a popup's page -> the research session it belongs to (null: the profile's)
const identified = new WeakSet();
function applyChromeIdentity(wc) {
  if (identified.has(wc)) return;
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  } catch {
    console.warn('[lumen] Chrome identity not applied (another debugger is attached to this page); Google may refuse sign-in here.');
    return; // Another debugger (e.g. an extension) is attached; keep Electron's defaults.
  }
  identified.add(wc);
  const override = { userAgent: app.userAgentFallback, userAgentMetadata: UA_METADATA };
  const firefox = { userAgent: FIREFOX_PROFILE.userAgent, platform: FIREFOX_PROFILE.platform }; // no userAgentMetadata: Firefox has no client hints
  const basic = { userAgent: override.userAgent, userAgentMetadata: (({ wow64, formFactors, ...rest }) => rest)(UA_METADATA) }; // (if this DevTools rejects the newest metadata fields, the brands still apply)
  const send = (method, params, sessionId) => wc.debugger.sendCommand(method, params, sessionId);
  // Workers have no Emulation domain; Network sets the same thing there.
  // asFirefox: the target is a Google sign-in page (see GOOGLE_AUTH): nothing of Chrome's brands may show there.
  const identify = (sessionId, asFirefox = false) => (asFirefox
    ? send('Emulation.setUserAgentOverride', firefox, sessionId).catch(() => send('Network.setUserAgentOverride', firefox, sessionId)).catch(() => {})
    : send('Emulation.setUserAgentOverride', override, sessionId)
      .catch(() => send('Emulation.setUserAgentOverride', basic, sessionId))
      .catch(() => send('Network.setUserAgentOverride', override, sessionId))
      .catch(() => send('Network.setUserAgentOverride', basic, sessionId)).catch(() => {}));
  // window.chrome and navigator.webdriver, at document start in every frame (browser/chrome-identity.js); not in workers.
  // (Both scripts name the hosts they act on: the Chrome one skips Google's sign-in hosts, the Firefox one runs only there.)
  const script = (sessionId) => Promise.all([
    send('Page.addScriptToEvaluateOnNewDocument', { source: CHROME_IDENTITY.IDENTITY_SCRIPT, runImmediately: true }, sessionId).catch(() => {}),
    send('Page.addScriptToEvaluateOnNewDocument', { source: GOOGLE_AUTH.firefoxScript(FIREFOX_PROFILE), runImmediately: true }, sessionId).catch(() => {}),
  ]);
  const autoAttach = (sessionId) => send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch(() => {});
  wc.debugger.on('message', (_e, method, params) => {
    if (method !== 'Target.attachedToTarget') return;
    const { sessionId, targetInfo } = params;
    const frame = targetInfo.type === 'iframe';
    Promise.all([identify(sessionId, frame && GOOGLE_AUTH.isAuthUrl(targetInfo.url)), frame ? script(sessionId) : null, frame ? autoAttach(sessionId) : null])
      .finally(() => send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {}));
  });
  // The page's own target follows its main frame: Firefox's User-Agent while it is on a sign-in host (every hop of a
  // redirect chain counts), Chrome's again once it leaves. (The request headers are rewritten by host in
  // settings-backend.js and the navigator by the script above, so neither waits on this.)
  let asFirefox = false;
  const follow = (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    const want = GOOGLE_AUTH.isAuthUrl(details.url);
    if (want !== asFirefox) { asFirefox = want; identify(undefined, want); }
  };
  wc.on('did-start-navigation', follow);
  wc.on('did-redirect-navigation', follow);
  identify(undefined, GOOGLE_AUTH.isAuthUrl(wc.getURL()) ? (asFirefox = true) : false);
  script();
  autoAttach();
}

// ---------- context menu ----------

// "Run skill ▸" for selected text: the skills that read a selection, run in the sidebar.
function skillMenuItems(selection) {
  const items = skillsFeature.menuTemplate(selection, (id, text) => ui()?.send('skill:run', { id, selection: text }));
  if (!items.length) return [];
  return [{ label: t('menu.runSkill'), submenu: [...items, { type: 'separator' }, { label: t('menu.manageSkills'), click: () => openSettingsPage('skills') }] }];
}

function showContextMenu(wc, p) {
  const items = [...settingsBackend.spellingItems(wc, p)]; // [settings] spelling suggestions first
  const selection = p.selectionText.trim();
  if (p.linkURL && isWebUrl(p.linkURL)) {
    const link = linkMenu.linkItems(p, linkMenuDeps(wc));
    items.push(
      { label: t('menu.openLinkNewTab'), click: () => openTab(p.linkURL, { background: true, openerId: tabByContents(wc)?.id, partition: isolatedOf(wc) ?? popupPartition.get(wc) ?? null }) },
      ...link.open, // Open Link in New Window, … in Private Window
      { type: 'separator' },
      ...link.save, // Save Link As…
      { label: t('menu.copyLink'), click: () => clipboard.writeText(p.linkURL) },
      { type: 'separator' },
    );
  }
  if (p.mediaType === 'image' && p.srcURL) {
    if (isWebUrl(p.srcURL)) items.push({ label: t('menu.openImageNewTab'), click: () => openTab(p.srcURL, { background: true, partition: isolatedOf(wc) ?? popupPartition.get(wc) ?? null }) });
    const image = linkMenu.imageItems(p, linkMenuDeps(wc));
    items.push(...image.save, { label: t('menu.copyImage'), click: () => wc.copyImageAt(p.x, p.y) }, ...image.copy, { type: 'separator' }); // Save Image As…, Copy Image, Copy Image Address
  }
  items.push(...pageTools.videoMenuItems(wc, p, { openTab: (url) => openTab(url, { background: true, partition: isolatedOf(wc) ?? popupPartition.get(wc) ?? null }), copy: (text) => clipboard.writeText(text) }));
  if (p.isEditable) {
    if (passwordsRt) items.push(...passwordsRt.contextMenuItems(tabByContents(wc), p)); // [passwords] Fill <username>, on a site with saved logins
    items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' });
  } else if (selection) {
    const short = selection.length > 30 ? `${selection.slice(0, 29)}…` : selection;
    items.push(
      { role: 'copy' },
      { label: t('menu.searchFor', { engine: engineFor(readSettings().searchEngine).label, text: short }), click: () => openTab(searchUrlFor(readSettings().searchEngine, selection)) },
      { label: t('menu.askAboutSelection'), click: () => ui()?.send('ask-selection', selection) },
      { label: t('menu.qrSelection'), enabled: selection.length <= 500, click: () => showQrCode(wc, selection, 'text') },
      ...skillMenuItems(selection),
      { type: 'separator' },
    );
  }
  if (items.length === 0) {
    items.push(
      { label: t('menu.back'), enabled: canGoBack(wc), click: () => goBack(wc) },
      { label: t('menu.forward'), enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: t('menu.reload'), click: () => wc.reload() },
      { type: 'separator' },
    );
    if (isWebUrl(wc.getURL())) {
      items.push(
        { label: t('menu.savePageAs'), click: () => pageTools.savePage(wc).catch(() => {}) },
        { label: t('menu.print'), click: () => wc.print({}, () => {}) },
        { label: t('menu.viewSource'), click: () => pageTools.viewSource(wc.getURL(), { session: wc.session, openerId: tabByContents(wc)?.id }) },
        { label: t('menu.screenshot'), click: () => takeScreenshot(wc) },
        { label: t('menu.qrCode'), click: () => showQrCode(wc) },
        ...translate.pageMenuItem(tabByContents(wc)),
        { type: 'separator' },
      );
    }
  }
  const extensionItems = extensions ? extensions.getContextMenuItems(wc, p) : [];
  if (extensionItems.length) items.push(...extensionItems, { type: 'separator' });
  items.push({ label: t('menu.inspect'), click: () => wc.inspectElement(p.x, p.y) });
  if (TEST && global.__captureContextMenu) { global.__captureContextMenu(items); return; } // (tests read the menu instead of popping it)
  Menu.buildFromTemplate(items).popup({ window: win });
}

// ---------- shortcuts (work whether focus is in the UI or a tab) ----------

function handleShortcut(event, input) {
  if (input.type !== 'keyDown') return;
  const mod = input.control || input.meta;
  const key = input.key.toLowerCase();
  const wc = activeTab()?.webContents;
  let handled = true;
  if (mod && input.shift && key === 'n') privateWindows.open();
  else if (mod && input.shift && key === 't') { if (closedTabs.length) openTab(closedTabs.pop()); }
  else if (mod && input.shift && key === 'a') openTabSearch();
  else if (mod && input.shift && !input.alt && key === 'm') mergeWindows(focusedRec() || curRec); // Merge All Windows, into the focused window as the menu does (this window takes the others; the toast says why when it can't)
  else if (mod && input.shift && !input.alt && key === 'l') toggleChatPage(); // the sidebar's chat as a full page, and back
  else if (mod && input.shift && !input.alt && key === 'w') closeCurrentWindow();
  else if (mod && input.shift && (key === '/' || key === '?')) shortcutsHelp.open().catch((err) => console.error('[lumen] shortcuts:', err.message)); // Ctrl+? : the Keyboard Shortcuts sheet
  else if (mod && input.shift && (key === 'delete' || key === 'backspace')) openSettingsPage('privacy'); // Clear browsing data, as in Chrome
  else if (mod && !input.shift && !input.alt && key === 'n') openNewWindow();
  else if (mod && key === 't') openTab();
  else if (mod && key === 'o' && !input.shift && !input.alt) openFileDialog();
  else if (mod && key === 'w') { if (activeId) requestCloseTab(activeId); }
  else if (mod && key === 'l') focusAddress();
  else if (mod && key === 'f' && tabs.find((t) => t.id === activeId)?.settings) { wc.focus(); wc.executeJavaScript("{ const s = document.getElementById('search'); s?.focus(); s?.select(); }").catch(() => {}); } // [settings] Ctrl+F searches settings
  else if (mod && key === 'f') { ui()?.focus(); ui()?.send('find:open'); }
  else if (mod && input.shift && key === 'o') managers.open('bookmarks');
  else if (mod && input.shift && key === 'j' && process.platform !== 'darwin') managers.open('downloads'); // Ctrl+J stays the sidebar
  else if (process.platform === 'darwin' && input.meta && input.alt && key === 'l') managers.open('downloads');
  else if (mod && input.shift && !input.alt && key === 'k') newSidebarChat(); // K sits next to J (the sidebar); Ctrl+Shift+J is Downloads on Windows/Linux
  else if (mod && key === 'j') ui()?.send('toggle-sidebar');
  // macOS: Cmd+Option+Right/Left and Cmd+Shift+] / [ select the next / previous tab, as in Chrome
  else if (process.platform === 'darwin' && input.meta && input.alt && (key === 'arrowright' || key === 'arrowleft')) cycleTab(key === 'arrowright' ? 1 : -1);
  else if (process.platform === 'darwin' && input.meta && input.shift && ['[', ']', '{', '}'].includes(key)) cycleTab(key === ']' || key === '}' ? 1 : -1);
  else if (mod && key === 'r') reloadActive({ ignoreCache: input.shift }); // Shift: Force Reload, past the cache
  else if (mod && key === 'tab') cycleTab(input.shift ? -1 : 1);
  else if (mod && input.shift && (key === 'pageup' || key === 'pagedown')) { const i = tabs.findIndex((t) => t.id === activeId); if (i !== -1) moveTab(activeId, i + (key === 'pageup' ? -1 : 1)); }
  else if (mod && (key === 'pageup' || key === 'pagedown')) cycleTab(key === 'pageup' ? -1 : 1);
  else if (mod && /^[1-9]$/.test(key)) { const t = key === '9' ? tabs[tabs.length - 1] : tabs[Number(key) - 1]; if (t) switchTab(t.id); }
  else if (mod && (key === '=' || key === '+')) zoomBy(wc, 0.5);
  else if (mod && key === '-') zoomBy(wc, -0.5);
  else if (mod && key === '0') zoomBy(wc, 0);
  else if (mod && input.shift && key === 'd') bookmarkAllTabs();
  else if (mod && key === 'd') toggleBookmark();
  else if (process.platform === 'darwin' && input.meta && key === 'h') app.hide(); // Cmd+H hides the app on macOS; History is Cmd+Y
  else if (mod && key === 'h') openHistoryPage();
  else if (mod && key === 'p') wc?.print({}, () => {});
  else if (mod && input.shift && !input.alt && key === 's') { if (wc) takeScreenshot(wc); }
  else if (mod && key === 's') { if (wc) pageTools.savePage(wc).catch(() => {}); }
  else if (mod && key === 'u') { if (wc) pageTools.viewSource(wc.getURL(), { session: wc.session, openerId: activeId }); }
  else if (mod && key === ',') openSettingsPage(); // [settings]
  else if (process.platform === 'darwin' && input.meta && key === '[') goBack(wc);
  else if (process.platform === 'darwin' && input.meta && key === ']') wc?.navigationHistory.goForward();
  else if (process.platform === 'darwin' && input.meta && key === 'y') openHistoryPage();
  else if (input.alt && key === 'arrowleft') goBack(wc);
  else if (input.alt && key === 'arrowright') wc?.navigationHistory.goForward();
  else if (key === 'f5') reloadActive({ ignoreCache: input.shift || input.control });
  else if (key === 'f11' && process.platform !== 'darwin') win?.setFullScreen(!win.isFullScreen());
  else if (key === 'f12') wc?.toggleDevTools();
  else handled = false;
  if (handled) event.preventDefault();
}

// Ctrl+Shift+K / the menu: a fresh chat in the sidebar (opens it if closed); the renderer clicks its New chat button.
function newSidebarChat() {
  ui()?.focus();
  ui()?.send('new-sidebar-chat');
}

// Ctrl+Shift+L / the menu: open the chat as a full page, or from the page go back to the sidebar.
function toggleChatPage() {
  if (tabs.find((t) => t.id === activeId)?.managerPage === 'chat') chatPageRt.back();
  else chatPageRt.open();
}

function focusAddress() {
  ui()?.focus();
  if (curRec && !curRec.uiLoaded) curRec.focusAddressPending = true; // (sent again once the UI has loaded: createWindow)
  ui()?.send('focus-address');
}

function cycleTab(direction) {
  const index = tabs.findIndex((t) => t.id === activeId);
  switchTab(tabs[(index + direction + tabs.length) % tabs.length].id);
}

function reloadActive({ ignoreCache = false } = {}) {
  const tab = tabs.find((t) => t.id === activeId);
  userTookOver(tab); // [ai manners] only the user's own reload reaches here (the AI's reload tool calls webContents.reload)
  reloadTab(tab, { ignoreCache });
}

// ---------- saved chats (survive restarts; the sidebar's history list) ----------

const CHAT_FILE = () => path.join(app.getPath('userData'), 'chat.json'); // the single chat kept before the list

// Chats are encrypted with the OS keychain; with no keychain (common on Linux) they aren't kept at
// all, rather than as plain-text files. Tool results (page text, screenshots, script output) and
// the page text attached to each message (page context) are not kept on disk.
// New chat and switching chats bump chatGeneration: a run that was stopped must not write its old
// chat back afterwards.
let chatStore = null;
const chats = () => (chatStore ||= createChatStore({
  dir: path.join(app.getPath('userData'), 'chats'),
  encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
  decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  available: () => safeStorage.isEncryptionAvailable(),
  legacyFile: CHAT_FILE(),
}));
let chatId = null; // the open chat
// Sites approved in each chat stay with that chat while Lumen runs (not saved: a chat restored
// after a restart starts with none, as before).
const approvedByChat = new Map();
let chatGeneration = 0;

// The open chat as it goes on disk (or `messages`: a chat left running, see chatRuns).
function chatSnapshot(messages) {
  const snapshot = agent.snapshot(messages);
  const keep = (msg, b) => {
    if (b.type === 'tool_result') return { type: 'tool_result', tool_use_id: b.tool_use_id, is_error: b.is_error, content: '(result not saved between sessions)' };
    if (b.type === 'text' && msg.role === 'user') return { ...b, text: b.text.replace(PAGE_BLOCK, '') };
    return b;
  };
  snapshot.messages = snapshot.messages.map((msg) => (Array.isArray(msg.content) ? { ...msg, content: msg.content.map((b) => keep(msg, b)) } : msg));
  return snapshot;
}

function saveChat(generation = chatGeneration) {
  if (generation !== chatGeneration) return;
  clearTimeout(saveChatTimer);
  try {
    if (!safeStorage.isEncryptionAvailable()) { chats().clearAll(); fs.rmSync(CHAT_FILE(), { force: true }); return; }
    if (!chatId) chatId = chats().newId();
    const snapshot = chatSnapshot();
    if (!snapshot.messages.length) return;
    chats().save(chatId, snapshot);
    if (chats().current() !== chatId) chats().setCurrent(chatId);
  } catch (err) {
    console.error('Could not save chat:', err.message);
  }
}
// During a long task the chat is saved after each step too, so quitting mid-run keeps what was done.
let saveChatTimer = null;
function saveChatSoon(generation) {
  clearTimeout(saveChatTimer);
  saveChatTimer = setTimeout(() => saveChat(generation), 1000);
}
app.on('before-quit', () => {
  saveChat();
  for (const run of chatRuns.values()) if (!run.deleted && run.messages !== agent.messages) saveChatOf(run.chatId, run.messages); // chats left running
});

function loadChat() {
  try {
    chats().migrate();
    const id = chats().current();
    const snapshot = id && chats().load(id);
    if (snapshot) {
      agent.restore(snapshot);
      chatId = id;
    }
  } catch {
    // No saved chat yet (or it can't be decrypted on this machine).
  }
  if (!chatId) chatId = chats().newId();
}

// Leaves the open chat (it stays in the list) for another one, or for a fresh one (id null).
// A running reply is not stopped: it keeps working in its own tab and chat (chatRuns), and opening
// that chat again shows it live. Returns what the sidebar needs to show the chat.
// `ensure` (a tab's own chat that has no file yet: it is still empty): shown as an empty chat under that id.
function switchChat(id, { ensure = false, quiet = false } = {}) {
  if (id && id === chatId) return chatView();
  const live = id ? chatRuns.get(id) : null; // still running (or waiting for a slot): its live messages, not the file
  const snapshot = id && !live ? chats().load(id) : null;
  if (id && !snapshot && !live && !ensure) return null;
  saveChat();
  chatGeneration++;
  clearTimeout(saveChatTimer);
  if (chatId) approvedByChat.set(chatId, agent.approvedHosts);
  if (agent.running) agent.detach(); // its run goes on with its own messages and approved sites
  else agent.reset();
  if (live) agent.attach(live.messages, approvedByChat.get(id));
  else if (snapshot) agent.restore(snapshot);
  chatId = id || chats().newId();
  if (!live) agent.approvedHosts = approvedByChat.get(chatId) || agent.approvedHosts;
  unreadChats.delete(chatId);
  if (id && (snapshot || live)) chats().setCurrent(id);
  else if (!quiet) chats().setCurrent(null); // (a tab's own empty chat, quiet: the last chat with a history stays the one a restart opens)
  pushAttention();
  lastAgentTarget = ''; // the "Working in" line follows the chat now open
  setImmediate(pushAgentTarget);
  return chatView();
}

// `live`: the chat is still running (it was left mid-reply): the sidebar picks the run up, with any
// approval card it waits on.
function chatView() {
  const run = chatRuns.get(chatId);
  const live = run && run.queued ? { runId: run.runId, approvals: [], queued: { text: run.text, status: waitingText(run) } }
    : run && agent.runningFor(run.messages) ? { runId: run.runId, approvals: [...run.pending.values()], target: agentTargetInfo(), partial: run.reply } : null;
  return { id: chatId, items: agent.transcript(), usage: describeUsage(agent.messages.settings?.usage), ...(live ? { live } : {}) };
}

// ---------- [background chats] the sidebar AI working on its own (features/chat-runs.js)
// Every sidebar run by chat id, while it runs: the open chat's and chats the user left mid-reply.
// { chatId, messages, runId, rec, pending: approvalId -> card event, reply, error, stopped, deleted }
const chatRuns = new Map();
const unreadChats = new Set(); // a reply finished while its chat was not in view
const sidebarShown = new WeakMap(); // a window's UI -> is its sidebar open (chat:sidebar-state)
ipcMain.on('chat:sidebar-state', (event, open) => {
  sidebarShown.set(event.sender, Boolean(open));
  if (open) { unreadChats.delete(chatId); pushAttention(); }
});
// Saves a chat left running into its own file (the open chat goes through saveChat).
function saveChatOf(id, messages) {
  if (id === chatId && messages === agent.messages) { saveChat(); return; }
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    const snapshot = chatSnapshot(messages);
    if (snapshot.messages.length) chats().save(id, snapshot);
  } catch (err) {
    console.error('Could not save chat:', err.message);
  }
}
const detachedSaves = new Map();
function saveChatOfSoon(id, messages) {
  clearTimeout(detachedSaves.get(id));
  detachedSaves.set(id, setTimeout(() => { detachedSaves.delete(id); if (!chatRuns.get(id)?.deleted) saveChatOf(id, messages); }, 1000));
}
// What the user can see of a run right now (features/chat-runs.js plan).
function runView(run) {
  const rec = run.rec && winRecs.has(run.rec) && rcAlive(run.rec) ? run.rec : curRec;
  const w = rec === curRec ? win : rec?.win;
  const uiWc = w && !w.isDestroyed() ? w.webContents : null;
  const runTab = run.tabId ?? null;
  return {
    focused: Boolean(w && !w.isDestroyed() && w.isFocused()),
    sidebarOpen: Boolean((uiWc && sidebarShown.get(uiWc)) || chatPageRt?.chatTabs().some((t) => t.id === activeIdOf(rec || curRec))),
    chatOpen: run.chatId === chatId,
    onRunTab: runTab == null || runTab === activeIdOf(rec || curRec),
  };
}
// The mark on each window's sidebar button, and the chat list's badges.
function pushAttention() {
  const approvals = [...chatRuns.values()].reduce((n, r) => n + r.pending.size, 0);
  const state = chatRunsLib.attention({ approvals, unread: unreadChats.size });
  for (const rec of winRecs) {
    const w = rec === curRec ? win : rec.win;
    if (!w || w.isDestroyed()) continue;
    w.webContents.send('agent:attention', { state, approvals, unread: unreadChats.size });
    w.webContents.send('chats:changed', null); // the list's running / needs-OK / unread marks
  }
  chatPageRt?.broadcast('chats:changed', null, ui()); // and the chat pages' lists
  refreshTabMarks(); // [chat per tab]
}
const chatBadges = () => new Map(chats().list().map((c) => {
  const run = chatRuns.get(c.id);
  return [c.id, chatRunsLib.chatBadge({ running: Boolean(run && !run.queued && agent.runningFor(run.messages)), queued: Boolean(run?.queued), approvals: run?.pending.size || 0, unread: unreadChats.has(c.id) })];
}));
// Tells the user about a run: a system notification (clicking it brings the window and that chat
// back), and the unread mark when the reply isn't in view.
function tellUser(run, kind) {
  const decided = chatRunsLib.plan(kind, { settings: readSettings().bgTasks, ...runView(run) });
  if (decided.unread && kind !== 'approval') unreadChats.add(run.chatId);
  pushAttention();
  if (!decided.os || TEST || !Notification.isSupported()) return;
  const title = chats().list().find((c) => c.id === run.chatId)?.title || '';
  const text = chatRunsLib.notification(kind, { reply: run.reply, error: run.error, chat: title }, t);
  try {
    const n = new Notification({ title: text.title, body: text.body, silent: false });
    n.on('click', () => {
      const rec = run.rec && winRecs.has(run.rec) && rcAlive(run.rec) ? run.rec : curRec;
      const w = rec === curRec ? win : rec?.win;
      if (!w || w.isDestroyed()) return;
      if (w.isMinimized()) w.restore();
      w.focus();
      w.webContents.send('agent:open-chat', { id: run.chatId });
    });
    n.show();
  } catch {}
}
// ---------- [chat per tab] a sidebar chat in each tab, working at the same time (features/tab-chats.js)
// Each tab shows its own chat in the sidebar. Switching tabs switches the sidebar to that tab's chat at once, and a
// chat keeps working in its tab while another is in front; a mark on the tab says so. The agent already runs
// each chat on its own messages and its own task scope pinned to a tab (agent.js); this is the layer that binds
// tabs to chats, decides who may run (the cap, the waiting line) and keeps every window's sidebar on its tab's chat.
//
// The open chat (`chatId`, agent.messages) is the one the last-used window's sidebar shows; each window's
// sidebar remembers what it shows (shownChat) and is brought up to date when its tab or its focus changes,
// and an IPC from a window first brings the open chat in line with that window's tab (syncToSender).
const chatBind = tabChatsLib.createBindings();
const runSlots = tabChatsLib.createRunSlots();
onSettingsWritten = (s) => { if (s.maxChatRuns !== undefined && tabChatsLib.clampRuns(s.maxChatRuns) !== runSlots.limit) runSlots.setMax(s.maxChatRuns); };
const shownChat = new WeakMap(); // a window's UI -> the chat its sidebar shows
const runIsLive = (r) => Boolean(r && !r.deleted && (r.queued || agent.runningFor(r.messages)));
const chatBusy = (id) => runIsLive(chatRuns.get(id));
const waitingText = (run) => t(run.waitReason === 'cli' ? 'agent.waitingCli' : 'agent.waiting');
// The chat of a running task that works in this tab, whichever chat that is.
function pinnedChat(tabId) {
  for (const r of chatRuns.values()) if (!r.deleted && !r.queued && agent.runTabIdFor(r.messages) === tabId) return r.chatId;
  return null;
}
// The mark a tab shows: 'approval' | 'running' | 'waiting' | 'done' | null.
function tabChatMark(tabId) {
  const bound = chatBind.chatOf(tabId);
  const rank = { approval: 4, running: 3, waiting: 2, done: 1 };
  let best = null;
  for (const id of new Set([bound, pinnedChat(tabId)].filter(Boolean))) {
    const run = chatRuns.get(id);
    const live = runIsLive(run) ? (run.queued ? 'queued' : 'running') : null;
    const s = tabChatsLib.tabStatus({ run: live, approvals: run?.pending.size || 0, unread: id === bound && unreadChats.has(id) });
    if (s && (!best || rank[s] > rank[best])) best = s;
  }
  return best;
}
// The strips redraw when a mark changes (a chat started, waited, finished, needs an OK, was viewed).
let tabMarksKey = '';
function refreshTabMarks() {
  const key = [...winRecs].filter(rcAlive).map((rec) => tabsOf(rec).map((x) => `${x.id}:${tabChatMark(x.id) || ''}`).join(',')).join('|');
  if (key === tabMarksKey) return;
  tabMarksKey = key;
  for (const rec of winRecs) if (rcAlive(rec)) withWindow(rec, sendTabsSoon);
}
function pushChatView(wc) {
  if (!wc || wc.isDestroyed()) return;
  shownChat.set(wc, chatId);
  const run = chatRuns.get(chatId);
  if (runIsLive(run)) run.sender = wc; // its events go to the sidebar that shows it now
  const view = chatView();
  wc.send('chat:sync', { view });
  chatPageRt?.broadcast('chat:sync', { view }, wc);
}
// The sidebar of the window just entered shows the chat of its front tab.
// `push`: tell the sidebar (false when the sender already shows it).
function followTabChat(tab, { push = true } = {}) {
  if (!tab || tab.managerPage === 'chat' || tab.isolated || tab.settings) return; // the chat page and Settings keep whatever chat is open
  const own = chatBind.chatOf(tab.id) || pinnedChat(tab.id);
  const plan = own ? { chat: own } : tabChatsLib.followPlan({ tabId: tab.id, chatOf: () => null, claimed: chatBind.claimed, openChatId: chatId, openIdle: !chatBusy(chatId) });
  const sidebarOpen = Boolean(ui() && sidebarShown.get(ui()));
  const unseen = (id) => unreadChats.has(id) && !sidebarOpen; // a finished reply stays "done" on its tab until the sidebar is looked at
  if (plan.chat) {
    chatBind.bind(tab.id, plan.chat);
    const keep = unseen(plan.chat);
    if (plan.chat !== chatId) switchChat(plan.chat, { ensure: true, quiet: true });
    if (keep) unreadChats.add(chatId);
    else if (sidebarOpen) unreadChats.delete(chatId);
  } else if (plan.adopt) {
    chatBind.bind(tab.id, plan.adopt);
  } else {
    switchChat(null, { quiet: true });
    chatBind.bind(tab.id, chatId);
  }
  const wc = ui();
  if (wc && !wc.isDestroyed()) {
    if (push && uiReady && shownChat.get(wc) !== chatId) pushChatView(wc);
    else if (!push) shownChat.set(wc, chatId);
  }
  refreshTabMarks();
}
function followFront(opts) {
  followTabChat(tabs.find((x) => x.id === activeId), opts);
}
// A message from a window's sidebar: the open chat is that window's tab's chat before anything is done with it.
function syncToSender(event) {
  const rec = recOfSender(event?.sender);
  if (rec) withWindow(rec, () => followFront({ push: false }));
}
// Every other window's sidebar follows its own tab again (a chat moved away from a tab it was showing in).
function refreshSidebars() {
  if (winRecs.size < 2) return;
  const home = curRec;
  for (const rec of [...winRecs]) if (rec !== home && rcAlive(rec)) withWindow(rec, () => followFront());
  if (home && winRecs.has(home)) withWindow(home, () => followFront({ push: false }));
}
// The open chat now belongs to the tab in front ("Move chat to this tab", a chat chosen from the list, a new chat).
function bindOpenChatHere(sender) {
  const run = chatRuns.get(chatId);
  chatBind.move(chatId, activeId);
  if (run && !run.deleted) {
    if (run.queued) run.homeTab = activeId;
    else agent.repinRun(run.messages, activeId, { rec: curRec });
    run.rec = curRec;
    if (sender) run.sender = sender;
  }
  if (sender && !sender.isDestroyed()) shownChat.set(sender, chatId);
  pushAttention();
  refreshSidebars();
}
// A tab closed. Its chat stays in the list. A chat still working there keeps going: its work moves to a fresh background
// tab in the same window (no question asked: closing a tab must not silently kill a task, and it can be stopped from its
// chat). When it was the window's last tab the window goes with it and the task ends with "the tab was closed".
function chatTabGone(id) {
  chatBind.unbindTab(id);
  for (const r of chatRuns.values()) {
    if (r.deleted) continue;
    if (r.queued && r.homeTab === id) r.homeTab = null;
    if (r.queued || agent.runTabIdFor(r.messages) !== id || !tabs.length) continue;
    const tab = openTab(undefined, { background: true, openedBy: { chatId: r.chatId, runId: r.runId } }); // [ai manners] opened for the chat: it may work there
    agent.repinRun(r.messages, tab.id, { rec: curRec });
    r.rec = curRec;
    r.homeTab = tab.id;
    chatBind.bind(tab.id, r.chatId);
  }
  pushAttention();
}
// A tab moved to another window (a drag, the tab menu, merging windows): its chat follows it, and a task working in it
// goes on there with that window's tabs.
function chatTabMoved(tabId, dstRec) {
  for (const r of chatRuns.values()) {
    if (r.deleted) continue;
    if (r.queued ? r.homeTab === tabId : agent.runTabIdFor(r.messages) === tabId) {
      if (!r.queued) agent.repinRun(r.messages, tabId, { rec: dstRec });
      r.rec = dstRec;
    }
  }
}
// The tab a chat's run starts in: where it is bound; a tab that closed while it waited gets a fresh background one.
function runHomeTab(run) {
  if (run.homeTab != null && tabAnywhere(run.homeTab)) return run.homeTab;
  const rec = run.rec && winRecs.has(run.rec) && rcAlive(run.rec) ? run.rec : curRec;
  if (!rec) return null;
  const id = withWindow(rec, () => openTab(undefined, { background: true, openedBy: { chatId: run.chatId, runId: run.runId } }).id); // [ai manners] opened for the chat: it may work there
  run.homeTab = id;
  run.rec = rec;
  chatBind.bind(id, run.chatId);
  return id;
}
// The tab the user was watching the run in now shows the tab the run moved to: that tab shows this chat too.
function bindRunChatTo(tabId) {
  const s = agent.currentScope();
  const id = s?.chat ? [...chatRuns.values()].find((r) => r.messages === s.chat)?.chatId : null;
  if (id) chatBind.bind(tabId, id);
}
if (TEST) global.__tabChats = { bindings: chatBind, slots: runSlots, mark: tabChatMark, chatId: () => chatId, shown: () => (ui() ? shownChat.get(ui()) : null), runs: () => [...chatRuns.values()].map((r) => ({ chatId: r.chatId, queued: Boolean(r.queued), tab: r.queued ? r.homeTab : agent.runTabIdFor(r.messages), live: runIsLive(r) })) };

// ---------- [ai manners] close the tabs the AI opened (features/ai-manners.js)
// A tab the AI opened (agentOpenTab, a research tab, a tab Lumen opened for a chat) is marked `openedBy` the run and chat, shown
// in the strip, and can be closed again: under the reply, from a tab's menu, from a chat's row, or by the setting (Off / Ask /
// Always). The user's own tabs never are: a tab they clicked in, typed in, navigated, pinned or moved loses the mark, a pinned
// tab and the tab a chat lives in are skipped, and an automatic close also leaves the tab in front and tabs holding typed text.
const aiCloseUndo = new Map(); // token -> [{ url, partition, rec }]: what a close took, for Undo
let aiCloseSeq = 0;
const chatNotEmpty = (cid) => chatRuns.has(cid) || chats().list().some((c) => c.id === cid);
// The tabs (of every window, or just `rec`'s) the AI opened that may be closed, as [{ rec, tab }]. `runId` / `chatId` narrow it
// to that run's / chat's; neither: all of them.
function aiTabSelect({ runId = null, chatId = null, auto = false, rec = null } = {}) {
  const found = [];
  const own = new Set(chatId != null ? [chatId] : []);
  if (runId != null) for (const r of winRecs) for (const x of rcAlive(r) ? tabsOf(r) : []) if (x.openedBy?.runId === runId && x.openedBy.chatId != null) own.add(x.openedBy.chatId);
  const bound = new Set();
  for (const [tabId, cid] of chatBind.entries()) if (own.size ? own.has(cid) : chatNotEmpty(cid)) bound.add(tabId);
  const busy = agent.runTabIds();
  for (const r of rec ? [rec] : [...winRecs]) {
    if (!rcAlive(r)) continue;
    for (const tab of manners.closeSelection(tabsOf(r), { runId, chatId, boundIds: [...bound], busyIds: busy, activeId: activeIdOf(r), auto })) found.push({ rec: r, tab });
  }
  return found;
}
// Closes them (each goes through requestCloseTab: a page's "Leave site?" is still asked). `auto`: also keeps a tab that holds
// typed text. Returns { closed, token }; the token undoes it (aiTabsReopen).
async function aiTabsClose(selector = {}, { auto = false } = {}) {
  const items = [];
  for (const { rec, tab } of aiTabSelect({ ...selector, auto })) {
    if (auto && alive(tab) && (await hasUnsavedInput(tab.view.webContents).catch(() => false))) continue;
    if (!manners.isAiTab(tab) || tab.closing || !tabAnywhere(tab.id)) continue; // the user took it over, or it closed, while this waited
    items.push({ url: tabUrl(tab), partition: tab.isolated || null, rec });
    withWindow(rec, () => requestCloseTab(tab.id));
  }
  const token = items.length ? ++aiCloseSeq : 0;
  if (token) {
    aiCloseUndo.set(token, items);
    while (aiCloseUndo.size > 20) aiCloseUndo.delete(aiCloseUndo.keys().next().value);
  }
  return { closed: items.length, token };
}
// Undo of a close: the tabs come back in the background, as the user's own tabs (they are theirs to keep now), and leave the
// "Reopen Closed Tab" list again.
function aiTabsReopen(token) {
  const items = aiCloseUndo.get(token) || [];
  aiCloseUndo.delete(token);
  let reopened = 0;
  for (const item of items) {
    if (!isWebUrl(item.url)) continue;
    const at = closedTabs.lastIndexOf(item.url);
    if (at >= 0) closedTabs.splice(at, 1);
    const rec = item.rec && winRecs.has(item.rec) && rcAlive(item.rec) ? item.rec : curRec;
    withWindow(rec, () => openTab(item.url, { background: true, ...(item.partition ? { partition: item.partition } : {}) }));
    reopened++;
  }
  return { reopened };
}
// What a finished run's 'done' event carries about its tabs: { n, mode } (mode: offer | ask | close), or null.
function aiTabsAfterRun(runId) {
  const setting = readSettings().closeAiTabs;
  const mode = manners.closeAfterRun({ setting, n: aiTabSelect({ runId, auto: setting === 'always' }).length });
  if (mode === 'none') return null;
  return { n: aiTabSelect({ runId, auto: mode === 'close' }).length, mode };
}
const cleanSelector = (o) => ({ runId: o?.runId ?? null, chatId: typeof o?.chatId === 'string' ? o.chatId : null });
ipcMain.handle('agent:ai-tabs-close', (_e, o) => aiTabsClose(cleanSelector(o)));
ipcMain.handle('agent:ai-tabs-undo', (_e, token) => aiTabsReopen(Number(token)));
// The sidebar's "hide the tabs the AI opened" toggle: a saved setting (prefs:ui carries it to the strip). It only leaves them out of
// the strip: they stay open and stay the AI's (its tools, the chat's own tab, Close Tabs Opened by AI all still reach them).
ipcMain.handle('tabs:hide-ai', async (_e, on) => {
  if (typeof on === 'boolean') await settingsBackend.set('hideAiTabs', on);
  return readSettings().hideAiTabs === true;
});
ipcMain.handle('chats:close-tabs',(_e, id) => aiTabsClose({ chatId: String(id) }));
if (TEST) global.__manners = manners;
if (TEST) global.__aiTabs = { switchTo: (id) => switchTab(id), select: aiTabSelect, close: aiTabsClose, reopen: aiTabsReopen, tab: (id) => tabAnywhere(id)?.t, handOver: userTookOver, closedTabs: () => closedTabs.slice() };

// Background throttling off for the tabs sidebar runs work in, so timers, animations and painting go
// on in a tab behind another one (a screenshot, wait_for); back on once no run works there.
const unthrottled = new Map(); // tab id -> webContents
function syncRunTabs() {
  const want = new Set(agent.runTabIds());
  for (const [id, wc] of unthrottled) {
    if (want.has(id)) continue;
    unthrottled.delete(id);
    try { if (!wc.isDestroyed()) wc.setBackgroundThrottling(true); } catch {}
  }
  for (const id of want) {
    const t = tabs.find((x) => x.id === id) || [...winRecs].flatMap((r) => tabsOf(r)).find((x) => x.id === id);
    if (!alive(t) || unthrottled.get(id) === t.view.webContents) continue; // a woken tab has a new page
    try { t.view.webContents.setBackgroundThrottling(false); unthrottled.set(id, t.view.webContents); } catch {}
  }
}

// ---------- window & session ----------

function titleBarOverlay() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: '#00000000', symbolColor: dark ? '#f5f5f7' : '#1d1d1f', height: 38 };
}

// One window's part of the saved session (runs with that window current).
function sessionEntry() {
  // A sleeping tab has no webContents to read a URL from; its sleep snapshot stands in, so closing
  // Lumen while a tab happens to be asleep doesn't silently drop it from the next launch's session.
  const urlOf = (t) => (alive(t) ? realUrl(t.view.webContents) : t.sleeping ? t.sleepUrl || '' : '');
  const saved = tabs.filter((t) => !t.isolated && (isWebUrl(urlOf(t)) || chatPage.isChatUrl(urlOf(t)))); // web pages, and lumen://chat (not research tabs: they would come back in the user's session)
  const urls = saved.map(urlOf);
  const titleOf = (t) => (alive(t) ? t.view.webContents.getTitle() : t.sleepTitle || '');
  return {
    urls,
    titles: saved.map(titleOf), // shown on the restored tabs, which don't load until they're opened
    favicons: saved.map((t) => t.favicon || null), // and their icons, so they aren't all globes
    active: Math.max(0, saved.findIndex((t) => t.id === activeId)),
    groupIds: saved.map((t) => t.groupId || null),
    pinned: saved.map((t) => Boolean(t.pinned)),
    chats: chatBind.snapshot(saved.map((t) => t.id)), // [chat per tab] which chat each tab shows (not re-run after a restart)
    groups: tabGroups.snapshot(),
  };
}

// Every normal window is saved: the first one in the session's own fields (as before, so older
// versions still read it), the others under `more`. Private windows are never here.
function saveSession({ excluding = null, background = false } = {}) {
  const recs = [...winRecs].filter((r) => rcAlive(r) && r !== excluding && !isSpare(r) && !r.mergedAway); // (a window merged into another is closing: its tabs are saved there)
  if (!recs.length || recs.some((r) => r.pendingRestore)) return; // nothing to save, or another window's tabs are still coming back
  const [first, ...more] = recs.map((r) => withWindow(r, sessionEntry));
  const next = { ...readSettings(), session: { ...first, ...(more.length ? { more } : {}) } };
  if (background) writeSettingsAsync(next); else writeSettingsNow(next); // (closing and quitting write at once)
}

function restoreSession(entry = null) {
  // [settings] On startup: continue where you left off (default), a new tab, or chosen pages.
  // (Only the first window follows this; a window restored from `more` just gets its own tabs.)
  const startup = entry ? { mode: 'last' } : settingsBackend.startupPlan();
  if (startup.mode === 'newtab') { openTab(); return; }
  if (startup.mode === 'pages') {
    startup.pages.forEach((url, i) => openTab(url, { background: i > 0 }));
    switchTab(tabs[0].id);
    return;
  }
  const saved = entry || readSettings().session;
  restoreTabsFrom(saved);
  if (!entry && Array.isArray(saved?.more)) {
    const first = curRec;
    for (const more of saved.more.slice(0, 9)) createWindow({ restore: more });
    enterWindow(first);
  }
}

function restoreTabsFrom(saved) {
  if (!saved?.urls?.length) {
    openTab();
    return;
  }
  tabGroups.restore(saved.groups);
  const active = Math.min(Math.max(0, saved.active || 0), saved.urls.length - 1);
  let activeTabId = null;
  saved.urls.forEach((url, i) => {
    // Only the tab you were on loads now; the rest load when first opened (addRestoredTab).
    if (i === active) activeTabId = openTab(url, { background: true, managerPage: chatPage.isChatUrl(url) ? 'chat' : null }).id;
    const tab = i === active ? tabs.find((t) => t.id === activeTabId) : addRestoredTab(url, saved.titles?.[i], saved.favicons?.[i]);
    const groupId = saved.groupIds?.[i];
    if (groupId && tabGroups.groups.has(groupId)) tab.groupId = groupId;
    else tab.userRemoved = true; // restore the session as it was: don't regroup tabs left loose
    if (saved.pinned?.[i] && !tab.groupId) tab.pinned = true;
    chatBind.restore([tab.id], [saved.chats?.[i]], (cid) => chats().list().some((c) => c.id === cid)); // [chat per tab]
  });
  tabGroups.cleanup();
  tabGroups.arrange();
  switchTab(activeTabId ?? tabs[0].id);
}

// ---------- macOS ----------
// macOS needs an application menu: without one, Cmd+C/V/X/A/Z/Q don't work anywhere. Browser
// shortcuts that handleShortcut() already handles are shown here but not registered twice.
// "Merge All Windows" in the Window menu: on only with two or more windows that may take part, into the focused one.
function mergeAllItem() {
  const target = focusedRec();
  const a = windowMerge.availability(describeWindows(), target ? target.win.id : null);
  return { label: t(a.enabled ? 'menu.mergeAllWindows' : `menu.mergeAllWindows.${a.reason}`), accelerator: MERGE_ACCELERATOR, registerAccelerator: false, enabled: a.enabled, click: () => { const rec = focusedRec(); if (rec) mergeWindows(rec); } };
}
// The menu bar is built from the windows there are, so it is built again when one opens, closes or takes focus.
let windowMenuTimer = null;
function refreshWindowMenu() {
  if (process.platform !== 'darwin') return;
  clearTimeout(windowMenuTimer);
  windowMenuTimer = setTimeout(() => { if (Menu.getApplicationMenu()) Menu.setApplicationMenu(macMenu()); }, 30);
}
function macMenu() {
  const shown = (accelerator) => ({ accelerator, registerAccelerator: false });
  const wc = () => activeTab()?.webContents;
  // A private window in front: a command it has goes to it (features/private-window.js); one it lacks is
  // greyed out (and does nothing), never sent to the normal window behind it.
  const priv = privateWindows.focused();
  const pv = (name, fn) => () => { if (!privateWindows.command(name)) fn(); };
  const normal = (item) => ({ ...item, enabled: !priv && item.enabled !== false, ...(item.click ? { click: (...args) => { if (!privateWindows.focused()) item.click(...args); } } : {}) });
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: t('menu.file'),
      submenu: [
        { label: t('menu.newTab'), ...shown('Cmd+T'), click: pv('newTab', () => openTab()) },
        { label: t('menu.newWindow'), accelerator: 'Cmd+N', click: () => openNewWindow() }, // (registered: it must work with no window open too)
        { label: t('menu.newPrivateWindow'), ...shown('Cmd+Shift+N'), click: () => privateWindows.open() },
        { label: t('menu.reopenTab'), ...shown('Cmd+Shift+T'), click: pv('reopenTab', reopenLastClosed) },
        normal({ label: t('menu.searchTabs'), ...shown('Cmd+Shift+A'), click: openTabSearch }),
        normal({ label: t('menu.openFile'), ...shown('Cmd+O'), click: openFileDialog }),
        { label: t('menu.openLocation'), ...shown('Cmd+L'), click: pv('focusAddress', focusAddress) },
        { type: 'separator' },
        normal({ label: t('menu.savePageAs'), ...shown('Cmd+S'), click: () => { if (wc()) pageTools.savePage(wc()).catch(() => {}); } }),
        { label: t('menu.screenshot'), ...shown('Cmd+Shift+S'), click: pv('screenshot', () => takeScreenshot(wc())) },
        normal({ label: t('menu.qrCode'), click: () => showQrCode(wc()) }),
        { label: t('menu.print'), ...shown('Cmd+P'), click: pv('print', () => wc()?.print({}, () => {})) },
        { type: 'separator' },
        { label: t('menu.closeTab'), ...shown('Cmd+W'), click: pv('closeTab', () => { if (activeId) requestCloseTab(activeId); }) },
        { label: t('menu.closeWindow'), ...shown('Shift+Cmd+W'), click: pv('closeWindow', closeCurrentWindow) },
      ],
    },
    { role: 'editMenu' },
    {
      label: t('menu.view'),
      submenu: [
        { label: t('menu.reload'), ...shown('Cmd+R'), click: pv('reload', () => reloadActive()) },
        { label: t('menu.forceReload'), ...shown('Shift+Cmd+R'), click: pv('forceReload', () => reloadActive({ ignoreCache: true })) },
        { label: t('menu.find'), ...shown('Cmd+F'), click: pv('find', () => { ui()?.focus(); ui()?.send('find:open'); }) },
        normal({ label: t('menu.readerMode'), click: () => toggleReaderActive() }),
        ...translate.pageMenuItem(tabs.find((x) => x.id === activeId && alive(x))).map(normal),
        { label: t('menu.pictureInPicture'), click: pv('pictureInPicture', () => togglePictureInPicture(wc())) },
        normal({ label: t('menu.siteInfo'), click: () => openPageInfo() }),
        normal({ label: t('menu.viewSource'), ...shown('Cmd+U'), click: () => { if (wc()) pageTools.viewSource(wc().getURL(), { session: wc().session, openerId: activeId }); } }),
        { type: 'separator' },
        { label: t('menu.zoomIn'), ...shown('Cmd+='), click: pv('zoomIn', () => zoomBy(wc(), 0.5)) },
        { label: t('menu.zoomOut'), ...shown('Cmd+-'), click: pv('zoomOut', () => zoomBy(wc(), -0.5)) },
        { label: t('menu.actualSize'), ...shown('Cmd+0'), click: pv('actualSize', () => zoomBy(wc(), 0)) },
        { type: 'separator' },
        normal({ label: t('menu.toggleSidebar'), ...shown('Cmd+J'), click: () => ui()?.send('toggle-sidebar') }),
        normal({ label: t('menu.newSidebarChat'), ...shown('Shift+Cmd+K'), click: newSidebarChat }),
        normal({ label: t('menu.openChatPage'), ...shown('Shift+Cmd+L'), click: toggleChatPage }),
        { label: t('menu.devTools'), accelerator: 'Alt+Cmd+I', click: pv('devTools', () => wc()?.toggleDevTools()) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: t('menu.history'),
      submenu: [
        { label: t('menu.back'), ...shown('Cmd+['), click: pv('back', () => goBack(wc())) },
        { label: t('menu.forward'), ...shown('Cmd+]'), click: pv('forward', () => wc()?.navigationHistory.goForward()) },
        normal({ label: t('menu.showAllHistory'), ...shown('Cmd+Y'), click: openHistoryPage }),
      ],
    },
    { label: t('menu.bookmarks'), submenu: [normal({ label: t('menu.bookmarkPage'), ...shown('Cmd+D'), click: toggleBookmark }), normal({ label: t('menu.bookmarkAllTabs'), ...shown('Shift+Cmd+D'), click: bookmarkAllTabs }), normal({ label: t('menu.showAllBookmarks'), ...shown('Shift+Cmd+O'), click: () => managers.open('bookmarks') })] },
    // Chrome's Tab menu. The menu bar is built once, so Pin and Mute (whose labels change) stay in the tab's own menu.
    {
      label: t('menu.tab'),
      submenu: [
        { label: t('menu.nextTab'), ...shown('Alt+Cmd+Right'), click: pv('nextTab', () => cycleTab(1)) },
        { label: t('menu.previousTab'), ...shown('Alt+Cmd+Left'), click: pv('previousTab', () => cycleTab(-1)) },
        { type: 'separator' },
        normal({ label: t('menu.newTabRight'), click: () => { if (activeId) newTabRightOf(activeId); } }),
        normal({ label: t('menu.duplicateTab'), click: () => { if (activeId) duplicateTab(activeId); } }),
      ],
    },
    { label: t('menu.downloads'), submenu: [normal({ label: t('menu.showAllDownloads'), ...shown('Alt+Cmd+L'), click: () => managers.open('downloads') })] },
    // The standard Window menu, written out (a role's own submenu can't take an extra item); macOS adds the window list to the menu with this role.
    { role: 'window', label: t('menu.window'), submenu: [
      { role: 'minimize' }, { role: 'zoom' },
      { label: t('menu.closeWindow'), click: () => BrowserWindow.getFocusedWindow()?.close() }, // (Cmd+W closes a tab: no accelerator here; File → Close Window shows Shift+Cmd+W)
      { type: 'separator' },
      mergeAllItem(),
      { type: 'separator' },
      { role: 'front' },
    ] },
    { role: 'help', submenu: [{ label: t('menu.keyboardShortcuts'), ...shown('Shift+Cmd+/'), click: () => shortcutsHelp.open() }, { label: t('menu.whatsNew'), click: () => whatsNew.open() }, { label: t('menu.github'), click: () => shell.openExternal('https://github.com/emah-maker/lumen') }] },
  ]);
}

// ---------- browser windows ----------
// A normal window is a record in winRecs: its BrowserWindow plus the state below. main.js was written
// for one window, so the variables above (win, tabs, activeId, ...) stay module globals that always
// hold the CURRENT window's state, and enterWindow() swaps them: the outgoing window's values are
// kept on its record, the incoming window's are loaded. A message from a window's own UI, tab or
// overlay (the IPC wrapper above), one of its events (bindContext) and the window gaining focus all
// make it current; withWindow() borrows a window for one call. With one window nothing swaps at
// all. Private windows are not in here (features/private-window.js keeps their own tabs).
const winRecs = new Set();
let curRec = null;
const rcAlive = (rec) => Boolean(rec?.win && !rec.win.isDestroyed());

function saveInto(rec) {
  Object.assign(rec, { win, tabs, activeId, contentBounds, viewFrozen, chatFullTab, uiReady, suggestView, downloadsView, downloadsAnchor, groups: new Map(tabGroups.groups) });
}
function loadFrom(rec) {
  ({ win, tabs, activeId, contentBounds, viewFrozen, chatFullTab, uiReady, suggestView, downloadsView, downloadsAnchor } = rec);
  tabGroups.groups.clear();
  for (const [id, group] of rec.groups) tabGroups.groups.set(id, group);
}
function enterWindow(rec) {
  if (!rec || rec === curRec || !winRecs.has(rec)) return;
  if (curRec) saveInto(curRec);
  curRec = rec;
  loadFrom(rec);
}
function withWindow(rec, fn) {
  if (!rec || rec === curRec || !winRecs.has(rec)) return fn();
  const previous = curRec;
  enterWindow(rec);
  try { return fn(); } finally { if (curRec === rec && previous && winRecs.has(previous)) enterWindow(previous); }
}
// Runs an emitter's listeners with `getRec()` current, so a background window's tab or page events
// change that window's tabs, not the focused one's.
// Focus is the exception: it is the user arriving in that window, so it stays current afterwards.
function bindContext(emitter, getRec) {
  if (!emitter || emitter.lumenBound) return;
  emitter.lumenBound = true;
  const emit = emitter.emit.bind(emitter);
  emitter.emit = (...args) => {
    if (winRecs.size < 2) return emit(...args);
    const rec = getRec();
    if (!rec || rec === curRec || !winRecs.has(rec)) return emit(...args);
    if (args[0] === 'focus') enterWindow(rec);
    return args[0] === 'focus' ? emit(...args) : withWindow(rec, () => emit(...args));
  };
}
// Which normal window a message came from: its UI, one of its tabs, or its dropdown/panel views.
function recOfSender(sender) {
  if (!sender) return null;
  for (const rec of winRecs) {
    const live = rec === curRec ? { win, tabs, suggestView, downloadsView } : rec;
    if (!live.win || live.win.isDestroyed()) continue;
    if (live.win.webContents === sender || live.suggestView?.webContents === sender || live.downloadsView?.webContents === sender
      || live.tabs.some((t) => t.view?.webContents === sender)) return rec;
  }
  return null;
}
const tabsOf = (rec) => (rec === curRec ? tabs : rec.tabs);
const activeIdOf = (rec) => (rec === curRec ? activeId : rec.activeId);

// ---- moving tabs between windows (tab strip drag, the tab menu)
// The tab's WebContentsView is re-parented, never recreated: the page keeps its state, scroll,
// media and typed input. A pinned tab stays pinned; a tab leaves its group, and joins one in the new
// window if it is dropped between two of its tabs. Runs in the tab's
// current window and leaves the tab alive but held by no window.
function releaseTab(tab, { keepFlags = false } = {}) {
  const index = tabs.indexOf(tab);
  if (index === -1) return false;
  finishLeaving(tab);
  if (chatFullTab === tab.id) chatFullTab = null;
  tabs.splice(index, 1);
  Object.assign(tab, windowMerge.releaseFlags(tab, { keep: keepFlags })); // leaves its group; placed by hand (automatic grouping leaves it alone), unless a merge: the tab keeps the flag it had
  tabGroups.cleanup();
  if (tab.view) win.contentView.removeChildView(tab.view);
  if (tabs.length && activeId === tab.id) switchTab(tabs[Math.min(index, tabs.length - 1)].id);
  else if (tabs.length) sendTabs();
  else activeId = null;
  return true;
}
// Runs in the receiving window: puts the tab at `index` (after any pinned tabs) and shows it (`show`:
// false leaves it in the background, for a batch whose caller picks the tab to show at the end).
function adoptTab(tab, index, show = true) {
  tab.rec = curRec;
  const pinned = tabs.filter((t) => t.pinned).length;
  const want = Number.isInteger(index) ? index : tabs.length;
  // Pinned tabs stay among the pinned ones at the start; the others never go in among them.
  const at = tab.pinned ? Math.max(0, Math.min(want, pinned)) : Math.max(pinned, Math.min(want, tabs.length));
  tabs.splice(at, 0, tab);
  const prev = tabs[at - 1], next = tabs[at + 1];
  if (!tab.pinned && prev?.groupId && prev.groupId === next?.groupId) { tab.groupId = prev.groupId; tab.userRemoved = false; }
  if (tab.view) {
    win.contentView.addChildView(tab.view);
    tab.view.setVisible(false);
    if (!tab.isolated) syncExtensions(() => { try { extensions?.addTab(tab.view.webContents, win); } catch {} });
  }
  if (!show) { sendTabs(); return; }
  switchTab(tab.id);
  tab.view?.webContents.focus();
}
const closableTabCount = (rec) => withWindow(rec, () => tabs.filter((t) => !t.closing).length);
function moveTabBetween(src, dst, tabId, index, { focus = true, keepSrc = false, show = true, keepFlags = false } = {}) {
  if (!src || !dst || src === dst || !winRecs.has(src) || !winRecs.has(dst) || !rcAlive(src) || !rcAlive(dst)) return false;
  const tab = tabsOf(src).find((t) => t.id === tabId && !t.closing);
  if (!tab) return false;
  if (!withWindow(src, () => releaseTab(tab, { keepFlags }))) return false;
  withWindow(dst, () => adoptTab(tab, index, show));
  chatTabMoved(tabId, dst); // [chat per tab] its chat, and a task working in it, go along
  enterWindow(dst);
  if (focus) dst.win.focus(); // a drag in progress keeps the focus where the mouse is captured
  if (!keepSrc && !tabsOf(src).length) src.win.close(); // it just lost its last tab
  return true;
}
// Several tabs at once (a multi-selection, a group), in the order given, from `index` on (the end if none);
// `active` is the one shown afterwards; `group` ({ name, color, userNamed }) makes them a group again in
// `dst`. The source closes if it is left empty.
function moveTabsBetween(src, dst, ids, index, { focus = true, active = ids[0], group = null } = {}) {
  if (ids.length === 1 && !group) return moveTabBetween(src, dst, ids[0], index, { focus });
  if (!src || !dst || src === dst || !rcAlive(src) || !rcAlive(dst)) return false;
  const moved = batchTabs(() => {
    // The source shows a tab that stays, once, rather than stepping through the ones that are leaving.
    withWindow(src, () => {
      if (!ids.includes(activeId)) return;
      const i = tabs.findIndex((t) => t.id === activeId);
      const stay = tabs.slice(i).find((t) => !ids.includes(t.id) && !t.closing) || tabs.slice(0, i).reverse().find((t) => !ids.includes(t.id) && !t.closing);
      if (stay) switchTab(stay.id);
    });
    let at = Number.isInteger(index) ? index : undefined;
    if (group && at !== undefined) at = withWindow(dst, () => outsideGroups(at)); // a group never lands inside another
    const done = [];
    // Pinned tabs go to the end of the pinned run; the others where they were dropped, in order after each other.
    const isPinned = (id) => Boolean(tabsOf(src).find((t) => t.id === id)?.pinned);
    for (const id of ids.filter(isPinned)) {
      const end = tabsOf(dst).filter((t) => t.pinned).length;
      if (!moveTabBetween(src, dst, id, end, { focus: false, keepSrc: true, show: false })) continue;
      done.push(id);
      if (at !== undefined) at++; // one more tab ahead of the drop point
    }
    for (const id of ids.filter((x) => !isPinned(x))) {
      if (!moveTabBetween(src, dst, id, at, { focus: false, keepSrc: true, show: false })) continue;
      done.push(id);
      if (at !== undefined) at = tabsOf(dst).findIndex((t) => t.id === id) + 1;
    }
    if (!done.length) return done;
    if (group) regroup(dst, done, group);
    withWindow(dst, () => {
      const show = tabs.find((t) => t.id === (done.includes(active) ? active : done[0]));
      if (show) { switchTab(show.id); show.view?.webContents.focus(); }
    });
    return done;
  });
  if (!moved.length) return false;
  enterWindow(dst);
  if (focus) dst.win.focus();
  if (rcAlive(src) && !tabsOf(src).length) src.win.close();
  return true;
}
// The first index at or after `at` that isn't between two tabs of one group (in the current window).
function outsideGroups(at) {
  while (at > 0 && at < tabs.length && tabs[at - 1].groupId && tabs[at - 1].groupId === tabs[at].groupId) at++;
  return at;
}
// Several tabs of this window moved as one block, before `beforeId` (the end if null), in the order given:
// a multi-selection or a group dragged along its own strip. `groupId`: they are that group and stay it
// (and never land inside another group); otherwise they join a group only if dropped inside one. One
// update, and nothing is learned for automatic grouping (tabs were moved, not regrouped).
// `join` (from a drag in this strip): the group the drop slot showed them joining, or null for none; left out,
// they join a group only if dropped between two of its tabs (or, all from one group, at its edge).
function moveBlock(ids, beforeId, groupId = null, join = undefined) {
  const keep = groupId != null && tabGroups.groups.has(groupId) ? groupId : null;
  // Pinned tabs move as well, but only inside the pinned run (they stay first). The others move
  // as one block to the drop. Each run keeps the order the selection had in the strip, which is
  // the order the count on the dragged tab was showing.
  const moving = ids.map((id) => tabs.find((t) => t.id === id && !t.closing)).filter(Boolean);
  if (!moving.length) return false;
  const pinnedMoving = moving.filter((t) => t.pinned);
  const looseMoving = moving.filter((t) => !t.pinned);
  const own = looseMoving.length && looseMoving.every((t) => t.groupId && t.groupId === looseMoving[0].groupId) ? looseMoving[0].groupId : null; // dropped at the edge of their own group, they stay in it
  for (const t of moving) tabs.splice(tabs.indexOf(t), 1);
  const pinnedCount = tabs.filter((t) => t.pinned).length;
  let at = beforeId == null ? tabs.length : tabs.findIndex((t) => t.id === beforeId);
  if (at === -1) at = tabs.length;
  // A drop among loose tabs puts the pinned block at the end of the pinned run, the nearest
  // place they can land. A drop on a pinned tab puts them there.
  if (pinnedMoving.length) tabs.splice(Math.min(at, pinnedCount), 0, ...pinnedMoving);
  if (looseMoving.length) {
    const pinnedNow = tabs.filter((t) => t.pinned).length;
    let looseAt = beforeId == null ? tabs.length : tabs.findIndex((t) => t.id === beforeId);
    if (looseAt === -1) looseAt = tabs.length;
    looseAt = Math.max(pinnedNow, looseAt); // loose tabs never go in among the pinned ones
    if (keep) looseAt = outsideGroups(looseAt); // a group never lands inside another
    tabs.splice(looseAt, 0, ...looseMoving);
    const prev = tabs[looseAt - 1], next = tabs[looseAt + looseMoving.length];
    const into = keep || (join !== undefined ? (join != null && tabGroups.groups.has(join) ? join : null)
      : (prev?.groupId && prev.groupId === next?.groupId ? prev.groupId : null) || (own && (prev?.groupId === own || next?.groupId === own) ? own : null));
    for (const t of looseMoving) { t.groupId = into; t.userRemoved = !into; t.userMoved = true; manners.handOver(t); }
  }
  for (const t of pinnedMoving) { t.userMoved = true; manners.handOver(t); }
  tabGroups.cleanup();
  sendTabs();
  return true;
}
ipcMain.on('tab:move-block', (event, ids, beforeId, groupId, join) => {
  const rec = recOfSender(event.sender);
  if (!rec || !Array.isArray(ids)) return;
  const list = ids.filter(Number.isInteger).slice(0, 1000);
  withWindow(rec, () => moveBlock(list, Number.isInteger(beforeId) ? beforeId : null, Number.isInteger(groupId) ? groupId : null, Number.isInteger(join) ? join : join === null ? null : undefined));
  event.sender.send('tab:dragdone'); // after the tabs update: the strip shows the moved tabs in their new places
});
function regroup(rec, ids, group) {
  withWindow(rec, () => {
    const here = ids.filter((id) => tabs.some((t) => t.id === id && !t.pinned));
    if (!here.length) return;
    const g = tabGroups.create(group.name, here, { color: group.color });
    if (group.userNamed) g.userNamed = true;
    if (group.colorLocked) g.colorLocked = true;
    if (group.collapsed) g.collapsed = true;
    sendTabs();
  });
}
// A group's tabs, in strip order, and what it takes to make it again elsewhere.
function groupForMove(rec, groupId) {
  return withWindow(rec, () => {
    const g = tabGroups.groups.get(groupId);
    if (!g) return null;
    const ids = tabs.filter((t) => t.groupId === groupId && !t.closing).map((t) => t.id);
    return ids.length ? { ids, group: { name: g.name, color: g.color, userNamed: Boolean(g.userNamed), colorLocked: Boolean(g.colorLocked), collapsed: Boolean(g.collapsed) } } : null;
  });
}
// Tabs moved into `rec` from the menu (no drag, no slot): its strip says so to screen readers, and a
// multi-selection stays selected there, as in Chrome.
// A multi-selection moved into a new window from the menu stays selected there (the window announces itself).
function keepSelection(rec, ids) {
  if (ids.length > 1 && rcAlive(rec)) rec.win.webContents.send('tab:moved-here', { ids, quiet: true });
}
function arrivedFromMenu(rec, ids) {
  if (!rcAlive(rec)) return;
  const title = withWindow(rec, () => { const t0 = tabs.find((t) => t.id === ids[0]); return t0 ? tabTitle(t0) : ''; });
  rec.win.webContents.send('tab:moved-here', { ids, title });
}
// The tabs a drag or the tab menu acts on: the window's multi-selection (as the strip last reported it,
// 'tab:selection') when `id` is part of it, in strip order; otherwise just `id`.
function tabsActedOn(rec, id, hint = null) {
  const live = tabsOf(rec).filter((t) => !t.closing);
  const chosen = new Set(Array.isArray(hint) && hint.length ? hint : rec.selection || []);
  if (chosen.size < 2 || !chosen.has(id) || !live.some((t) => t.id === id)) return [id];
  return live.filter((t) => chosen.has(t.id)).map((t) => t.id);
}
ipcMain.on('tab:selection', (event, ids) => {
  const rec = recOfSender(event.sender);
  if (rec) rec.selection = Array.isArray(ids) ? ids.filter(Number.isInteger).slice(0, 1000) : [];
});
// A tab can only move into a normal window: a private window's id is not in winRecs.
function moveTabToWindowId(src, tabId, windowId, index) {
  const dst = [...winRecs].find((r) => rcAlive(r) && !isSpare(r) && r.win.id === windowId);
  return dst ? moveTabBetween(src, dst, tabId, index) : false;
}
// ---- merging windows: "Merge All Windows", "Merge Window Into" (the ⋯ menu and the tab menu) and their Undo.
// browser/window-merge.js plans it (the order, pinned tabs, groups, which windows may take part); this carries it
// out with moveTabBetween, so every page keeps running (media included) and a sleeping tab stays asleep. Private
// windows never take part (they are not in winRecs, and their sessions stay apart by design).
const windowMerge = require('./browser/window-merge');
let mergeUndo = null; // { dstId, entries, at }: what the toast's Undo puts back, for as long as that toast is up (windowMerge.undoValid)
let mergePending = false; // a merge waiting for an organize to stop
const MERGE_ACCELERATOR = 'CmdOrCtrl+Shift+M'; // handled in handleShortcut (so it works without a menu bar); the menus only show it

// Each normal window as plain data, for the planner. Tabs whose page is neither running nor asleep (restored but
// not loaded yet) go along when they have an address (windowMerge.describeTab).
function describeWindows() {
  return [...winRecs].filter((r) => rcAlive(r) && !isSpare(r)).map((rec) => withWindow(rec, () => ({
    id: rec.win.id,
    busy: Boolean(rec.pendingRestore), // its saved tabs are still coming back
    activeId,
    tabs: tabs.map((t) => ({ t, kind: windowMerge.describeTab({ closing: t.closing, alive: alive(t), sleeping: t.sleeping, destroyed: Boolean(t.view?.webContents?.isDestroyed()), url: t.sleepUrl || '' }) }))
      .filter((x) => x.kind)
      .map(({ t, kind }) => ({ id: t.id, pinned: Boolean(t.pinned), sleeping: Boolean(t.sleeping), unloaded: kind.unloaded, groupId: t.groupId || null })),
    groups: [...tabGroups.groups.values()].map((g) => ({ id: g.id, name: g.name, color: g.color, userNamed: g.userNamed, colorLocked: g.colorLocked, collapsed: g.collapsed })),
  })));
}
const recByWindowId = (id) => [...winRecs].find((r) => rcAlive(r) && !isSpare(r) && r.win.id === id);
// The normal window that has the keyboard focus; failing that (a private or chat window has it) the one focused last.
function focusedRec() {
  const f = BrowserWindow.getFocusedWindow();
  return [...winRecs].find((r) => rcAlive(r) && !isSpare(r) && r.win === f) || focusOrder.map(recByWindowId).find(Boolean) || null;
}
// A line in `rec`'s tab strip (the toast), if the window is still there.
const noteIn = (rec, text, opts) => { if (rcAlive(rec) && winRecs.has(rec)) withWindow(rec, () => organizeNote(text, opts)); };
// "Merged 3 windows · 14 tabs" (the string table has no plural rules, so the singular forms are keys of their own).
function mergedNote(windows, count) {
  return t(`merge.done${windows === 1 ? '.oneWindow' : ''}${count === 1 ? '.oneTab' : ''}`, { windows, tabs: count });
}
const mergeFailedNote = (n) => t(n === 1 ? 'merge.failed.one' : 'merge.failed', { n });

// A merge asked for while an organize (or its AI refinement) is running: the organize is cancelled, and the merge
// goes ahead once it has stopped (it keeps the groups made so far), with "Organizing…" cleared in every window.
function mergeAfterOrganize(dst, opts) {
  if (mergePending) return;
  mergePending = true;
  organizeAbort?.abort();
  const started = Date.now();
  const tick = () => {
    if (organizing && Date.now() - started < 5000) { setTimeout(tick, 80); return; }
    mergePending = false;
    if (organizing) { noteIn(dst, t('merge.none.organizing')); return; } // it would not stop: say so rather than do nothing
    for (const r of winRecs) if (rcAlive(r) && !isSpare(r)) r.win.webContents.send('tabs:organizing', false);
    if (rcAlive(dst) && winRecs.has(dst)) mergeWindows(dst, opts);
  };
  setTimeout(tick, 0);
}

// Moves every tab of the planned source windows (default: all the other normal windows) into `dst`, then closes
// the emptied windows. `dst` keeps its active tab, unless `activate` is 'source': the (first) source window's active
// tab then comes forward, for "Merge Window Into" (that is the page you were looking at). Returns { windows, tabs } or null;
// when it does nothing the toast says why (not while a tab is being dragged: that is left alone).
function mergeWindows(dst, { sourceIds = null, activate = null } = {}) {
  if (tabDrag) { if (rcAlive(dst)) noteIn(dst, t('merge.none.dragging')); return null; } // a drag is in progress: windows must not change under it
  if (!rcAlive(dst) || !winRecs.has(dst) || isSpare(dst)) return null;
  if (organizing) { mergeAfterOrganize(dst, { sourceIds, activate }); return null; }
  const windows = describeWindows();
  const plan = windowMerge.planMerge(windows, dst.win.id, { sourceIds });
  if (!plan) { noteIn(dst, t(`merge.none.${windowMerge.blocker(windows, dst.win.id, sourceIds) || 'empty'}`)); return null; }
  const entries = []; // what Undo needs, per window actually merged
  const emptied = [];
  let count = 0;
  let failed = 0; // tabs that could not move
  batchTabs(() => {
    for (const s of plan.sources) {
      const src = recByWindowId(s.id);
      if (!src) continue;
      const b = src.win.isMaximized() ? src.win.getNormalBounds() : src.win.getBounds();
      const moved = new Set();
      for (const m of s.moves) {
        if (moveTabBetween(src, dst, m.id, m.index ?? undefined, { focus: false, keepSrc: true, show: false, keepFlags: true })) moved.add(m.id);
        else failed++;
      }
      if (!moved.size) continue;
      const groups = s.groups.map((g) => ({ ids: g.ids.filter((id) => moved.has(id)), group: g.group })).filter((g) => g.ids.length);
      for (const g of groups) regroup(dst, g.ids, g.group); // the group again, with its name, colour and collapsed state
      entries.push({ id: s.id, bounds: { x: b.x, y: b.y, width: b.width, height: b.height }, activeId: s.activeId, tabs: s.tabs.filter((x) => moved.has(x.id)), groups });
      count += moved.size;
      if (!tabsOf(src).length) emptied.push(src);
    }
  });
  if (!entries.length) { noteIn(dst, failed ? mergeFailedNote(failed) : t('merge.none.empty')); return null; }
  for (const src of emptied) src.mergedAway = true; // saveSession leaves it out while it closes
  for (const src of emptied) if (rcAlive(src)) src.win.close();
  // A close that did not happen (vetoed, or it failed) must not leave that window out of the saved session for good.
  setTimeout(() => {
    const stayed = emptied.filter((src) => rcAlive(src) && winRecs.has(src));
    for (const src of stayed) src.mergedAway = false;
    if (stayed.length) saveSession({ background: true });
  }, 3000);
  enterWindow(dst);
  const want = activate === 'source' ? entries[0].activeId : plan.targetActiveId;
  withWindow(dst, () => {
    if (want != null && activeId !== want && tabs.some((x) => x.id === want && !x.closing)) switchTab(want); // (an active tab is never asleep)
    else sendTabs();
  });
  if (dst.win.isMinimized()) dst.win.restore();
  dst.win.show();
  dst.win.focus();
  saveSession({ background: true }); // the merged state is what a restart restores
  const done = mergedNote(entries.length, count);
  noteIn(dst, failed ? `${done} · ${mergeFailedNote(failed)}` : done, { undo: true, merge: true });
  mergeUndo = { dstId: dst.win.id, entries, at: Date.now() }; // after the note, which forgets an older one
  refreshWindowMenu();
  return { windows: entries.length, tabs: count, failed };
}

// Undo: each merged window comes back as a window of its own, where it was, with its tabs (those still open),
// their groups and pinned tabs, and the tab it was showing. Nothing reloads: the pages are moved again.
// Only while the toast that offered it is up, and only from the window that showed it. Says how many came back.
function undoMerge() {
  const m = mergeUndo;
  mergeUndo = null;
  if (!m) return null;
  const dst = recByWindowId(m.dstId);
  if (!dst) return null;
  if (!windowMerge.undoValid(m.at)) { noteIn(dst, t('merge.undone.late')); return null; }
  const live = withWindow(dst, () => tabs.filter((x) => !x.closing).map((x) => x.id));
  const plan = windowMerge.undoPlan(m.entries, live);
  for (const w of plan) {
    const base = w.bounds || { ...cascadedWindowPoint(dst.win), ...dst.win.getBounds() };
    const area = screen.getDisplayMatching(base).workArea;
    const fit = tabDragMath.fitToDisplay({ width: base.width, height: base.height }, area);
    const at = tabDragMath.placeOnWorkArea({ x: base.x, y: base.y, width: fit.width, height: fit.height }, area);
    const rec = createWindow({
      size: { width: at.width, height: at.height }, position: { x: at.x, y: at.y }, hidden: true, boundsFrom: dst,
      adopt: { src: dst, tabId: w.lead, ids: w.ids, focus: false, done: (ok) => {
        if (!ok || !rcAlive(rec)) return;
        for (const g of w.groups) regroup(rec, g.ids, g.group);
        revealNewWindow(rec, w.lead);
      } },
    });
  }
  noteIn(dst, plan.length ? t(plan.length === 1 ? 'merge.undone.one' : 'merge.undone', { windows: plan.length }) : t('merge.undone.none'));
  return plan.length;
}

// "Merge All Windows" and "Merge Window Into ›" for the window `src`. With nothing to merge they stay in the menu,
// greyed out, and say why ("only one window open", "restoring…"): a missing item looks like a missing feature.
function mergeWindowItems(src) {
  if (!src || !rcAlive(src)) return [];
  const windows = describeWindows();
  const a = windowMerge.availability(windows, src.win.id);
  const others = a.enabled ? windowMerge.mergeIntoChoices(windows, src.win.id).map((w) => recByWindowId(w.id)).filter(Boolean) : [];
  return [
    { label: t(a.enabled ? 'menu.mergeAllWindows' : `menu.mergeAllWindows.${a.reason}`), accelerator: MERGE_ACCELERATOR, registerAccelerator: false, enabled: a.enabled, click: () => mergeWindows(src) },
    others.length
      ? { label: t('menu.mergeWindowInto'), submenu: others.map((r) => ({ label: windowLabel(r), click: () => mergeWindows(r, { sourceIds: [src.win.id], activate: 'source' }) })) }
      : { label: t('menu.mergeWindowInto'), enabled: false },
  ];
}
// ---- dragging a tab out of the strip (Chrome's behaviour, Safari's look): main.js drives the drag
// Past the renderer's tear-off threshold a card follows the cursor: the page's snapshot under the tab's
// icon and title, in a small click-through window. The tab itself stays where it is until the button is
// released, so nothing heavy moves with the mouse (moving a whole browser window with a live page every
// frame is what made the old drag stutter and stall). Over a tab strip, this window's included, the card
// becomes a tab and the strip marks where it would land. Released there, the tab joins that strip at that
// place (or moves along its own); released anywhere else it becomes a window of its own, which fades in
// where the card was. Escape puts the card away and changes nothing. A window's only tab drags the window
// itself, like its title bar. Main polls the cursor; the renderer that holds the pointer reports the
// release ('tab:dragend'); a hard timeout ends a drag whose release was lost.
const tabDragMath = require('./features/tab-drag-math');
let tabDragTimeoutMs = 120000; // with the mouse still and no release seen (see tickTabDrag)
const cursorPoint = () => (TEST && global.__testCursor) || screen.getCursorScreenPoint();
let tabDrag = null; // { rec, tabId, single, card, origin, grab, size, hover, strips, timer, ... }
// Windows front first, as far as Lumen can tell: the order they were last focused in (Electron has no
// z-order query). A drop only counts on the strip of the front-most window under the cursor.
const focusOrder = []; // BrowserWindow ids, most recently focused first
app.on('browser-window-focus', (_e, w) => {
  const i = focusOrder.indexOf(w.id);
  if (i !== -1) focusOrder.splice(i, 1);
  focusOrder.unshift(w.id);
  refreshWindowMenu(); // the focused window is the target of "Merge All Windows"
});
const frontRank = (w) => { const i = focusOrder.indexOf(w.id); return i === -1 ? focusOrder.length + w.id : i; };
const DRAG_OVER_STRIP_OPACITY = 0; // all but gone over a strip: the slot and ghost there are what you see (Chrome hides it) // an only-tab window being dragged: see through it to the strip it is over

// Where each window's tabs sit (client coordinates); refreshed while dragging, off the hot path. The
// window being dragged (only-tab drags) is not a target; the window a card came from is.
async function stripGeometry(rec) {
  const info = await rec.win.webContents.executeJavaScript(`(() => {
    const strip = document.getElementById('tabs').getBoundingClientRect();
    // stripDropTargets (app.js): tabs and group labels on show, a label standing for its group's first tab.
    const tabs = typeof stripDropTargets === 'function' ? stripDropTargets()
      : [...document.querySelectorAll('#tabs .tab')].filter((el) => !el.matches('.handed, .held, .gathered')).map((el) => { const r = el.getBoundingClientRect(); return { id: Number(el.dataset.id), mid: r.left + r.width / 2 }; });
    const el = document.getElementById('tabs');
    const slotEl = document.querySelector('#tabs .tab-drop-slot');
    const s = slotEl && slotEl.getBoundingClientRect();
    return { hidden: document.visibilityState === 'hidden', bottom: strip.bottom, left: strip.left, right: strip.right, overflows: el.scrollWidth > el.clientWidth + 1, tabs, slot: s ? { x: s.left, y: s.top, h: s.height } : null };
  })()`).catch(() => null);
  // Chromium marks a window 'hidden' when other windows (any app's) cover it completely: not a target.
  return info && !info.hidden && { rec, bottom: info.bottom, left: info.left, right: info.right, overflows: info.overflows, tabs: info.tabs, slot: info.slot };
}
async function refreshDragStrips(d) {
  if (d.refreshing) return;
  d.refreshing = true;
  try {
    const next = new Map();
    // The window the card came from first: it is the one under the cursor most of the time.
    const recs = [...winRecs].sort((a, b) => (b === d.rec) - (a === d.rec));
    // All at once, not one after another: a quick drop onto another window's strip finds it measured.
    const found = await Promise.all(recs.filter((rec) => !((d.single && rec === d.rec) || !rcAlive(rec) || isSpare(rec) || rec.win.isMinimized())).map((rec) => stripGeometry(rec)));
    for (const g of found) if (g) next.set(g.rec, g);
    if (tabDrag === d) { d.strips = next; d.targets?.invalidate(); } // the targets carry the strips' geometry
  } finally { d.refreshing = false; }
}
// A window is only shown once it has painted what it now holds: its strip with the tab, and the tab's
// page at its place. It goes on screen fully transparent (so both actually paint), then fades in, instead
// of flashing an empty or half-laid-out window before the tab turns up. Capped, so a busy page never
// holds it back for long.
function whenPainted(rec, tab, then) {
  const frames = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))';
  const waits = [rec.win.webContents.executeJavaScript(frames, true).catch(() => {})];
  if (tab && alive(tab)) {
    try { tab.view.webContents.invalidate(); } catch {}
    // In an isolated world: the page's own requestAnimationFrame (which a site may have replaced) isn't used.
    waits.push(tab.view.webContents.executeJavaScriptInIsolatedWorld(1003, [{ code: frames }], true).catch(() => {}));
  }
  let done = false;
  const go = () => { if (!done) { done = true; if (rcAlive(rec)) then(); } };
  Promise.all(waits).then(go);
  setTimeout(go, 160);
}
const tabById = (rec, id) => tabsOf(rec).find((t) => t.id === id);
// Shows a window that has just been given a tab, faded in once it has painted, and focuses it.
// Lumen's own Reduce motion setting, Performance mode, or the system's (Windows: animations off).
const frameClock = require('./features/frame-clock'); // timers for the main process's own short animations
const motionReducedMain = () => Boolean(settingsBackend.prefs().reduceMotion) || Boolean(perfMode.active?.())
  || systemPreferences?.getAnimationSettings?.().shouldRenderRichAnimation === false;
function revealNewWindow(rec, tabId, then = () => {}) {
  const count = tabsOf(rec).filter((t) => !t.closing).length;
  const announce = () => { if (rcAlive(rec)) rec.win.webContents.send('tab:arrived', { count }); }; // for screen readers
  if (TEST_BACKGROUND) { announce(); then(); return; }
  rec.win.setOpacity(0);
  rec.win.showInactive();
  whenPainted(rec, tabById(rec, tabId), () => {
    const w = rec.win;
    announce();
    const focus = () => { if (!tabDrag) w.focus(); }; // a new drag already under way keeps its window focused
    if (motionReducedMain()) { w.setOpacity(1); focus(); then(); return; }
    // Timed against the clock, aimed at frame boundaries (features/frame-clock.js): a setInterval(16) fires on
    // Windows' coarse timer and stutters, and a busy turn slowed every later step. setOpacity is a native call
    // per window, so the fade is a few steps (4 over ~120 ms) rather than one per frame.
    let shown = -1;
    const fade = frameClock.tween({ duration: 120, ease: (t) => frameClock.quantize(t, 4), onFrame: (eased) => {
      if (w.isDestroyed()) { fade?.stop(); return; }
      if (eased !== shown) { shown = eased; w.setOpacity(eased); }
    } });
    focus();
    then();
  });
}

// ---- the drag card: one small transparent window, made once and reused
const CARD_PAD = 36; // room around the card for its shadow (drag-card.html --pad)
const CARD_WIDTH = 300;
const CARD_HEAD = 36;
const CARD_HOLD = { x: CARD_PAD + 26, y: CARD_PAD + 18 }; // the card is held by its icon, as the tab was
let dragCard = null; // { win, loaded, hideTimer }
function dragCardWindow() {
  if (dragCard && !dragCard.win.isDestroyed()) return dragCard;
  const w = new BrowserWindow({
    width: CARD_WIDTH + CARD_PAD * 2, height: 260, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, title: 'Lumen',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  w.setIgnoreMouseEvents(true); // the release goes to the window underneath, never to the card
  w.setAlwaysOnTop(true, 'pop-up-menu');
  const file = path.join(__dirname, 'renderer', 'drag-card.html');
  hardenOwnView(w.webContents, pathToFileURL(file).href);
  const loaded = new Promise((resolve) => w.webContents.once('did-finish-load', resolve));
  w.loadFile(file);
  dragCard = { win: w, loaded, hideTimer: null };
  return dragCard;
}
function closeDragCard() {
  if (dragCard && !dragCard.win.isDestroyed()) dragCard.win.destroy();
  dragCard = null;
}
const cardCall = (fn, ...args) => {
  if (!dragCard || dragCard.win.isDestroyed()) return;
  dragCard.win.webContents.executeJavaScript(`window.lumenCard && window.lumenCard.${fn}(...${JSON.stringify(args)})`).catch(() => {});
};
// Resolves once the page's snapshot has been taken (or couldn't be): the tab's window may show another tab after that.
// The page snapshot for the card, taken when a tab is first pulled towards the edge ('tab:dragprep'), so
// the card shows the page from its first frame instead of an empty panel that fills in a moment later.
let prepShot = null; // { tabId, src, at }
function snapshotFor(tab) {
  if (!alive(tab)) return Promise.resolve(null);
  const scale = Math.max(1, ...screen.getAllDisplays().map((x) => x.scaleFactor || 1)); // sharp on any display it is dragged to
  return tab.view.webContents.capturePage().then((image) => {
    if (image.isEmpty()) return null;
    return `data:image/jpeg;base64,${image.resize({ width: Math.round(CARD_WIDTH * scale), quality: 'good' }).toJPEG(82).toString('base64')}`;
  }).catch(() => null);
}
function showDragCard(d, tab, cursor, { compact = false, count = null } = {}) {
  d.cardAt = { x: cursor.x - CARD_HOLD.x, y: cursor.y - CARD_HOLD.y };
  if (TEST_BACKGROUND) return Promise.resolve();
  const card = dragCardWindow();
  clearTimeout(card.hideTimer);
  card.owner = d;
  const page = withWindow(d.rec, () => ({ ...contentBounds }));
  const shotHeight = Math.round(CARD_WIDTH * Math.min(0.75, Math.max(0.45, (page.height || 600) / (page.width || 800))));
  card.win.setBounds({ ...d.cardAt, width: CARD_WIDTH + CARD_PAD * 2, height: CARD_HEAD + shotHeight + CARD_PAD * 2 });
  card.loaded.then(() => {
    if (tabDrag !== d || !(d.card || d.chip)) return; // put away (the strip left) before the card was ready
    const icons = d.ghost?.favicons?.length ? d.ghost.favicons : tab.favicon ? [tab.favicon] : [];
    const favicon = icons.find((u) => typeof u === 'string' && (u.startsWith('https:') || u.startsWith('data:image/'))) || null;
    // A group dragged by its label is the group on the card too: its name and colour, as the slot shows it.
    const g = d.group || d.chipGroup;
    const group = g ? { name: g.name, color: g.color } : null;
    const accent = settingsBackend.state().accent;
    cardCall('show', { accent: nativeTheme.shouldUseDarkColors ? accent?.dark : accent?.light, title: group ? group.name : tabTitle(tab) || 'New Tab', favicon: group ? null : favicon, group, page: d.ghost?.page || null, dark: nativeTheme.shouldUseDarkColors, shotHeight, count: count || d.ids.length, still: motionReducedMain(), shot: early, compact, bare: !alive(tab) && !early });
    card.win.showInactive();
  });
  const early = prepShot && prepShot.tabId === tab.id && Date.now() - prepShot.at < 4000 ? prepShot.src : null;
  prepShot = null;
  // A fresh snapshot anyway (the page may have changed since the hint); the card swaps it in quietly.
  // (No picture at all, a sleeping tab say: the card folds to its title bar instead of an empty panel.)
  const shot = compact ? Promise.resolve() : snapshotFor(tab).then((src) => { if (tabDrag === d) card.loaded.then(() => { if (tabDrag === d) cardCall(src ? 'shot' : 'bare', src); }); });
  return Promise.race([shot, new Promise((r) => setTimeout(r, early ? 0 : 250))]);
}
// While its tab is out on the card, a window shows the tab beside it (as Chrome does), not a page whose tab
// has left the strip; Escape brings the dragged tab back to the front.
function stepAside(d) {
  if (tabDrag !== d || !rcAlive(d.rec)) return;
  withWindow(d.rec, () => {
    if (!d.ids.includes(activeId)) return;
    const i = tabs.findIndex((t) => t.id === activeId);
    // A neighbour the strip shows: one hidden in a collapsed group would come to the front unseen.
    const ok = (t) => !d.ids.includes(t.id) && !t.closing;
    const shown = (t) => ok(t) && !(t.groupId && tabGroups.groups.get(t.groupId)?.collapsed);
    const near = (test) => tabs.slice(i).find(test) || tabs.slice(0, i).reverse().find(test);
    const stay = near(shown) || near(ok);
    if (!stay) return;
    d.origActive = activeId;
    // A sleeping neighbour is only brought to the front of the strip. Waking it would reload the
    // page, and cancelling the drag would leave it loaded. It wakes after the drop if it is still
    // the tab in front (wakeDeferredAside).
    if (stay.sleeping) { d.asideAsleep = stay.id; switchTab(stay.id, { wake: false }); }
    else switchTab(stay.id);
  });
}
function wakeDeferredAside(d) {
  if (!d?.asideAsleep || !rcAlive(d.rec)) return;
  withWindow(d.rec, () => {
    const front = tabs.find((t) => t.id === activeId);
    if (front?.sleeping && front.id === d.asideAsleep) switchTab(front.id);
  });
}
// Puts away the card of drag `d`: never the card of a newer drag that has taken it over meanwhile (a
// drop's window can take a moment to show, and a quick second drag reuses the one card window).
function hideDragCard(d, kind, landing = null) {
  if (!dragCard || dragCard.win.isDestroyed() || dragCard.owner !== d) return;
  if (kind === 'join' && landing && rcAlive(landing.rec) && !motionReducedMain() && !TEST_BACKGROUND) {
    const rec = landing.rec;
    const ids = JSON.stringify(landing.ids || [d.tabId]);
    // Where it lands, measured now: the tab itself (placed, still invisible) or else the slot kept open for it.
    rec.win.webContents.executeJavaScript(`typeof landingRect === 'function' ? landingRect(${ids}) : null`, true).catch(() => null).then((slot) => {
      if (dragCard?.owner !== d) return;
      if (slot) glideCard(d, rec, slot, landing.ids);
      else { cardCall('hide', 'join'); if (rcAlive(rec)) rec.win.webContents.send('tab:landed'); }
    });
    return;
  }
  cardCall('hide', kind);
  const card = dragCard;
  clearTimeout(card.hideTimer);
  card.hideTimer = setTimeout(() => { if (!card.win.isDestroyed() && card.owner === d) card.win.hide(); }, 220);
}

// A drop into a strip: the card (as the tab chip) slides into the slot over about 120 ms, then fades as the real tab
// takes its place, instead of shrinking away where the cursor let go (as Chrome and Arc land a tab).
function glideCard(d, rec, slot) {
  const card = dragCard;
  const content = rec.win.getContentBounds();
  const to = { x: Math.round(content.x + slot.x - CARD_PAD), y: Math.round(content.y + slot.y - CARD_PAD) };
  const [x0, y0] = card.win.getPosition();
  // Room for a landing wider than the card (two tabs, a group): the window grows to the right, its left edge kept.
  const [cw, ch] = card.win.getSize();
  const need = Math.max(CARD_WIDTH, Math.round(slot.w || 0)) + CARD_PAD * 2;
  if (need > cw) card.win.setSize(need, ch);
  cardCall('compact', true);
  cardCall('land', Math.round(slot.w || 0), Math.round(slot.h || 0)); // and takes the tab's width, height and corners on the way
  card.glide?.stop();
  // Frame-clock timing (features/frame-clock.js): each step's position comes from the elapsed time, and the
  // timers aim at frame boundaries, so a late step skips ahead instead of stuttering.
  card.glide = frameClock.tween({
    duration: 120,
    onFrame: (eased, t) => {
      if (card.win.isDestroyed() || card.owner !== d) { card.glide?.stop(); return; }
      card.win.setPosition(Math.round(x0 + (to.x - x0) * eased), Math.round(y0 + (to.y - y0) * eased));
      if (t < 1) return;
      cardCall('hide', 'land');
      if (rcAlive(rec)) rec.win.webContents.send('tab:landed'); // the real tab shows as the chip fades over it
      clearTimeout(card.hideTimer);
      card.hideTimer = setTimeout(() => { if (!card.win.isDestroyed() && card.owner === d) card.win.hide(); }, 160);
    },
  });
}

// ---- a window made ready for a tear-off before it happens
// Pulling a tab towards the edge of the strip prepares a hidden window (its UI loaded), so a tab dropped
// outside lands in a window straight away instead of waiting for a new window's UI to load. One at a
// time; it is left out of the saved session, the drop targets, the tab menu and the window list, and
// closes after a while unused or with the last window.
let spareRec = null;
let spareIdle = null;
const SPARE_IDLE_MS = 60000; // kept warm a minute: a quick flick-and-drop finds it ready, without holding memory for long
function closeSpare() {
  clearTimeout(spareIdle);
  const rec = spareRec;
  spareRec = null;
  if (rcAlive(rec) && rec.prepared) rec.win.close();
}
function prepareDragWindow(src) {
  if (!rcAlive(src) || !winRecs.has(src) || closableTabCount(src) < 2) return;
  if (!TEST_BACKGROUND) dragCardWindow(); // the card, too, is ready before it is needed
  clearTimeout(spareIdle);
  spareIdle = setTimeout(closeSpare, SPARE_IDLE_MS);
  if (rcAlive(spareRec)) return;
  const size = src.win.isMaximized() ? src.win.getNormalBounds() : src.win.getBounds();
  const previous = curRec;
  spareRec = createWindow({ size: { width: size.width, height: size.height }, hidden: true, prepared: true, boundsFrom: src });
  enterWindow(previous && winRecs.has(previous) ? previous : src); // the user is still where they were
}
// The prepared window, if it has loaded: it stops being a spare and becomes a normal window.
function takeSpare(size) {
  const rec = spareRec;
  if (!rcAlive(rec) || !rec.prepared || !rec.preparedReady) return null;
  spareRec = null;
  clearTimeout(spareIdle);
  rec.prepared = false;
  rec.win.setSize(size.width, size.height);
  const items = agent.transcript(); // what a new window's UI is sent once its tab is in (createWindow)
  if (items.length) rec.win.webContents.send('agent:history', { items });
  return rec;
}
const isSpare = (rec) => Boolean(rec?.prepared);

function setDragHover(d, hit, { cancel = false, chipAs = 'cancel', dropping = false } = {}) {
  const same = d.hover?.rec === hit?.rec && d.hover?.beforeId === hit?.beforeId && Boolean(d.hover?.outside) === Boolean(hit?.outside) && (d.hover?.edge || 0) === (hit?.edge || 0);
  if (same) return;
  if (d.hover?.rec !== hit?.rec && rcAlive(d.hover?.rec)) d.hover.rec.win.webContents.send('tab:dropat', cancel || !dropping ? { cancel: true } : null);
  const wasOver = Boolean(d.hover);
  d.hover0 = d.hover; // (the strip a drop lands in: the chip glides into its slot)
  d.hover = hit;
  // The tab itself is the chip under the cursor, so the slot is only the room it will take (ghost: false), as wide as
  // the tabs that come with it.
  if (hit && rcAlive(hit.rec)) hit.rec.win.webContents.send('tab:dropat', { beforeId: hit.beforeId, outside: Boolean(hit.outside), edge: hit.edge || 0, tab: d.ghost, ghost: false });
  if (d.card) { if (wasOver !== Boolean(hit)) cardCall('compact', Boolean(hit)); return; }
  if (!TEST_BACKGROUND && rcAlive(d.rec)) {
    try { d.rec.win.setOpacity(hit ? DRAG_OVER_STRIP_OPACITY : 1); } catch {}
    // The window is out of sight over a strip, so the tab itself, as a small chip, stays under the cursor (as in Chrome).
    const tab = tabsOf(d.rec).find((t) => t.id === (d.tabId ?? d.ids?.[0]));
    if (hit && !d.chip && tab) { d.chip = true; showDragCard(d, tab, cursorPoint(), { compact: true, count: d.ghost?.count }); }
    else if (!hit && d.chip) { d.chip = false; if (chipAs !== 'join') hideDragCard(d, chipAs); } // a merge lands its chip once the tabs are placed
  }
}
function tickTabDrag() {
  const d = tabDrag;
  if (!d) return;
  dragTicks.mark();
  if (!rcAlive(d.rec)) { endDragQuietly(d); return; } // the window was closed under the drag
  // A release that never came (the mouse-up went somewhere Lumen can't see): nothing is moved on a guess.
  // A card drag is dropped; a dragged window stays where it is, without joining a strip.
  const cursor = cursorPoint();
  const moved = !d.lastCursor || d.lastCursor.x !== cursor.x || d.lastCursor.y !== cursor.y;
  if (moved) { d.lastCursor = cursor; d.movedAt = Date.now(); }
  // Measured from the last time the mouse moved: someone holding still over a strip isn't cut off.
  if (Date.now() - (d.movedAt || d.started) > (!d.hover ? Math.min(tabDragTimeoutMs, 30000) : tabDragTimeoutMs)) {
    d.rec.win.webContents.send('tab:dragabort'); // the strip lets go of its drag, and shows the tab again
    setDragHover(d, null);
    finishTabDrag(d.card ? 'cancel' : 'commit');
    return;
  }
  if (d.card) {
    const at = { x: cursor.x - CARD_HOLD.x, y: cursor.y - CARD_HOLD.y };
    if (at.x !== d.cardAt.x || at.y !== d.cardAt.y) {
      d.cardAt = at;
      if (dragCard && !dragCard.win.isDestroyed()) dragCard.win.setPosition(at.x, at.y);
    }
  } else if (moved || !d.last) { // a still cursor needs no display lookup: the window is already where it goes
    const area = screen.getDisplayNearestPoint(cursor).workArea;
    const b = tabDragMath.clampToDisplay(tabDragMath.windowBoundsFor(cursor, d.grab, d.size), area);
    if (!d.last || d.last.x !== b.x || d.last.y !== b.y) { d.rec.win.setPosition(b.x, b.y); d.last = b; } // position only: no size drift across displays
    if (d.chip && dragCard && !dragCard.win.isDestroyed()) dragCard.win.setPosition(cursor.x - CARD_HOLD.x, cursor.y - CARD_HOLD.y);
  }
  if (Date.now() - d.stripsAt > 120) { d.stripsAt = Date.now(); refreshDragStrips(d); }
  const hit = tabDragMath.stripHit(cursor, dropTargets(d), 6, d.hover?.rec ?? null);
  // A group is shown (and lands) after a group it is over, never inside it.
  const groupsAlong = d.group || (d.single && tabsOf(d.rec).some((t) => t.groupId)); // groups never land inside another group
  const beforeId = hit && groupsAlong ? withWindow(hit.key, () => {
    const rest = tabs.filter((t) => !d.ids.includes(t.id)); // the dragged group's own tabs are not where it lands
    let i = rest.findIndex((t) => t.id === hit.beforeId);
    if (i === -1) return null;
    while (i > 0 && i < rest.length && rest[i - 1].groupId && rest[i - 1].groupId === rest[i].groupId) i++;
    return rest[i]?.id ?? null;
  }) : hit?.beforeId;
  // Near the edge of an overflowing strip it is over, that strip scrolls (as it does for a drag within it).
  let edge = 0;
  const g = hit && d.strips.get(hit.key);
  if (g?.overflows) {
    const x = cursor.x - hit.key.win.getContentBounds().x;
    edge = x < g.left + 28 ? -1 : x > g.right - 28 ? 1 : 0;
  }
  setDragHover(d, hit && { rec: hit.key, beforeId: beforeId ?? null, outside: groupsAlong ? true : Boolean(hit.outside), edge });
  if (edge) d.stripsAt = 0; // the tabs are moving under it: measure again at once
}
// Every window that could be under the cursor, front first: the strips a tab can join, and the windows that
// only get in the way (private windows, a normal window whose strip hasn't been measured yet).
// Built at most every 120 ms (the strip measurement's own rhythm) and after each measurement, not on every
// 4-8 ms tick of the drag: it looks every window up and measures its bounds.
function dropTargets(d) {
  if (!d.targets) d.targets = frameClock.ttlCache(() => buildDropTargets(d), 120);
  return d.targets.get();
}
function buildDropTargets(d) {
  const out = [];
  const recByWin = new Map();
  for (const r of winRecs) recByWin.set(r.win, r);
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || !w.isVisible() || w.isMinimized() || (dragCard && w === dragCard.win)) continue;
    if (d.single && w === d.rec.win) continue; // the window being dragged is under the cursor by definition
    const rec = recByWin.get(w);
    if (rec && isSpare(rec)) continue;
    const g = rec && d.strips.get(rec);
    out.push(g ? { key: rec, win: w, bounds: w.getContentBounds(), bottom: g.bottom, tabs: g.tabs } : { win: w, bounds: w.getBounds(), occluder: true });
  }
  return out.sort((a, b) => frontRank(a.win) - frontRank(b.win));
}
function endDragQuietly(d) {
  clearInterval(d.timer);
  if (tabDrag === d) tabDrag = null;
  setDragHover(d, null); // the strip it was over closes its slot
  if (rcAlive(d.rec)) d.rec.win.webContents.removeListener('before-input-event', d.escape);
  if (d.card || d.chip) hideDragCard(d, 'cancel');
}
function finishTabDrag(reason) {
  const d = tabDrag;
  if (!d) return;
  tabDrag = null;
  clearInterval(d.timer);
  const rec = d.rec;
  const target = d.hover;
  if (rcAlive(rec)) rec.win.webContents.removeListener('before-input-event', d.escape);
  const merging = !d.card && reason === 'commit' && target && rcAlive(target.rec) && rcAlive(rec);
  const hadChip = Boolean(d.chip);
  if (merging) { try { rec.win.hide(); } catch {} } // it goes as it merges (closing takes a moment): no flash back to full opacity
  setDragHover(d, null, { cancel: reason !== 'commit', chipAs: merging ? 'join' : 'cancel', dropping: reason === 'commit' }); // a cancel closes the hovered strip's slot at once
  if (!rcAlive(rec)) { if (d.card || d.chip) hideDragCard(d, 'cancel'); return; }
  if (d.card) { finishCardDrag(d, reason, target); return; }
  // An only-tab window: it stays where it was dropped, joins the strip it is over, or goes back (Escape).
  if (!merging && !TEST_BACKGROUND) { try { rec.win.setOpacity(1); } catch {} }
  rec.win.webContents.send('tab:dragdone'); // its strip shows the tab again, however the drag ended
  if (reason === 'commit') {
    if (merging) {
      // The whole window merges into that strip: every tab it holds, the dragged one shown, and its groups
      // still groups there.
      const at = tabsOf(target.rec).findIndex((t) => t.id === target.beforeId);
      const all = tabsOf(rec).filter((t) => !t.closing).map((t) => t.id);
      const groups = [...new Set(tabsOf(rec).map((t) => t.groupId).filter(Boolean))].map((g) => groupForMove(rec, g)).filter(Boolean);
      const dst = target.rec;
      if (hadChip && !motionReducedMain() && !TEST_BACKGROUND) dst.win.webContents.send('tab:arriving', { ids: [d.tabId, ...all.filter((x) => x !== d.tabId)] });
      d.mergeIds = all;
      let index = at === -1 ? undefined : at;
      if (groups.length && index !== undefined) index = withWindow(dst, () => outsideGroups(index)); // its groups don't split one there
      const merged = batchTabs(() => {
        const ok = moveTabsBetween(rec, dst, all, index, { active: d.tabId });
        if (ok) for (const g of groups) regroup(dst, g.ids, g.group);
        // No groups of its own and dropped right after a group's label: into that group, as the slot showed.
        if (ok && !groups.length && !target.outside && target.beforeId != null) withWindow(dst, () => {
          const g = tabs.find((t) => t.id === target.beforeId)?.groupId;
          if (g && tabGroups.groups.has(g)) { for (const t of tabs) if (all.includes(t.id) && !t.pinned) { t.groupId = g; t.userRemoved = false; } sendTabs(); }
        });
        return ok;
      }); // one update
      if (!merged && rcAlive(rec)) { try { rec.win.setOpacity(1); rec.win.show(); rec.win.focus(); } catch {} } // it didn't happen: the window comes back
      // The chip lands in the tabs' place (they show as it arrives), or goes if the merge didn't happen.
      if (merged) hideDragCard(d, 'join', { rec: dst, ids: [d.tabId, ...all.filter((x) => x !== d.tabId)] });
      else { hideDragCard(d, 'cancel'); if (rcAlive(dst)) dst.win.webContents.send('tab:landed'); }
    } else {
      rec.win.focus();
    }
    return;
  }
  rec.win.setBounds(d.origin.bounds);
  if (d.origin.maximized) rec.win.maximize();
}
// The end of a card drag. The source's strip keeps the dragged tab hidden until 'tab:dragdone', so it
// never flashes back in place before it moves.
function finishCardDrag(d, reason, target) {
  const src = d.rec;
  const settled = () => { if (rcAlive(src)) src.win.webContents.send('tab:dragdone'); };
  const ids = d.ids.filter((id) => tabById(src, id) && !tabById(src, id).closing);
  const putBack = () => { if (d.origActive && tabById(src, d.origActive)) withWindow(src, () => switchTab(d.origActive)); };
  if (reason !== 'commit' || !ids.includes(d.tabId)) { putBack(); hideDragCard(d, 'cancel'); settled(); return; }
  if (target && rcAlive(target.rec)) {
    if (target.rec === src) {
      // Along its own strip, before the tab the slot was opened in front of (the end if none).
      // One strip update with the dragged tab already in front (an update showing the stepped-aside neighbour
      // active would end the multi-selection), and the selection kept.
      batchTabs(() => withWindow(src, () => {
        const before = target.beforeId != null && !ids.includes(target.beforeId) ? target.beforeId : null;
        if (ids.length === 1 && !d.group && tabs.find((t) => t.id === ids[0])?.pinned) {
          const others = tabs.filter((t) => t.id !== ids[0]);
          const at = before == null ? others.length : others.findIndex((t) => t.id === before);
          moveTab(ids[0], at === -1 ? others.length : at);
        } else {
          // One splice, landing exactly where the slot was: a group stays whole, a tab joins a group only
          // if the slot was inside it.
          // The group the slot showed (tinted between two of its tabs), or none: the same rule as a drag within the strip.
          const rest = tabs.filter((t) => !ids.includes(t.id));
          const k = before == null ? rest.length : Math.max(0, rest.findIndex((t) => t.id === before));
          // Right after a group's label (not outside it) joins that group, as between two of its tabs does.
          const join = rest[k - 1]?.groupId && rest[k - 1].groupId === rest[k]?.groupId ? rest[k - 1].groupId : !target.outside && rest[k]?.groupId && rest[k - 1]?.groupId !== rest[k].groupId ? rest[k].groupId : null;
          const would = [...rest.slice(0, k).map((t) => t.id), ...ids, ...rest.slice(k).map((t) => t.id)];
          const home = would.join() === tabs.map((t) => t.id).join() && ids.every((id) => (tabs.find((t) => t.id === id)?.groupId || null) === (d.group ? tabs.find((t) => t.id === id)?.groupId || null : join));
          if (!home) moveBlock(ids, before, d.group ? d.groupId : null, d.group ? undefined : join); // dropped back at its own place: nothing to do
        }
        if (activeId !== d.tabId && tabs.some((t) => t.id === d.tabId)) switchTab(d.tabId);
      }));
      keepSelection(src, ids);
      wakeDeferredAside(d); // the neighbour loads only if the dragged tab did not come back to the front
      if (!motionReducedMain() && !TEST_BACKGROUND && dragCard?.owner === d && rcAlive(src)) src.win.webContents.send('tab:arriving', { ids: [d.tabId, ...ids.filter((x) => x !== d.tabId)] });
    } else {
      const at = tabsOf(target.rec).findIndex((t) => t.id === target.beforeId);
      const gliding = !motionReducedMain() && !TEST_BACKGROUND && dragCard?.owner === d;
      if (gliding) target.rec.win.webContents.send('tab:arriving', { ids: [d.tabId, ...ids.filter((x) => x !== d.tabId)] });
      d.landed = moveTabsBetween(src, target.rec, ids, at === -1 ? undefined : at, { active: d.tabId, group: d.group });
      if (!d.landed && rcAlive(target.rec)) target.rec.win.webContents.send('tab:dropat', { cancel: true });
      if (!d.landed && gliding) target.rec.win.webContents.send('tab:landed');
      if (d.landed) {
        // Dropped right after a group's label in the other window: into that group (the slot showed it inside).
        if (!d.group && !target.outside && target.beforeId != null) withWindow(target.rec, () => {
          const g = tabs.find((t) => t.id === target.beforeId)?.groupId;
          if (g && tabGroups.groups.has(g)) { for (const t of tabs) if (ids.includes(t.id) && !t.pinned) { t.groupId = g; t.userRemoved = false; } sendTabs(); }
        });
        keepSelection(target.rec, ids);
      }
      wakeDeferredAside(d);
    }
    hideDragCard(d, d.landed === false ? 'cancel' : 'join', d.landed === false ? null : { rec: target.rec, ids: [d.tabId, ...ids.filter((x) => x !== d.tabId)] });
    settled();
    return;
  }
  if (closableTabCount(src) - ids.length < 1) { putBack(); hideDragCard(d, 'cancel'); settled(); return; } // its other tabs closed meanwhile
  // A window of its own, placed so the tab sits under the cursor as it will in the new strip, and no
  // bigger than the display it opens on.
  const cursor = cursorPoint();
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  d.size = tabDragMath.fitToDisplay(d.size, area);
  const at = tabDragMath.clampToDisplay(tabDragMath.windowBoundsFor(cursor, d.grab, d.size), area);
  const newWindowFor = () => {
    if (!rcAlive(src) || !tabById(src, d.tabId)) { hideDragCard(d, 'cancel'); settled(); return; }
    if (dragCard?.owner === d) cardCall('wait'); // a window's UI is loading: the card shows it is opening
    const rec = createWindow({
      size: d.size, position: { x: at.x, y: at.y }, hidden: true, boundsFrom: src,
      adopt: { src, tabId: d.tabId, ids, group: d.group, focus: false, done: (ok) => { settled(); if (ok) { wakeDeferredAside(d); revealNewWindow(rec, d.tabId, () => { hideDragCard(d, 'drop'); keepSelection(rec, ids); }); } else hideDragCard(d, 'cancel'); } },
    });
  };
  const landIn = (rec) => {
    rec.win.setBounds({ x: at.x, y: at.y, width: d.size.width, height: d.size.height }); // one call: no size drift on mixed-DPI setups
    if (!moveTabsBetween(src, rec, ids, 0, { focus: false, active: d.tabId, group: d.group })) { rec.win.close(); hideDragCard(d, 'cancel'); settled(); return; }
    wakeDeferredAside(d);
    settled();
    revealNewWindow(rec, d.tabId, () => { hideDragCard(d, 'drop'); keepSelection(rec, ids); });
  };
  const spare = takeSpare(d.size);
  if (spare) { landIn(spare); return; }
  if (rcAlive(spareRec) && spareRec.prepared) {
    // Still loading: the card waits where it was dropped (showing that it is opening), then the window takes its place.
    const waiting = spareRec;
    let done = false;
    cardCall('wait');
    const ready = () => {
      if (done) return;
      done = true;
      clearTimeout(fallback);
      const r = takeSpare(d.size); // a second drop that waited too gets a window of its own
      if (r) landIn(r); else newWindowFor();
    };
    const fallback = setTimeout(() => { if (!done) { done = true; waiting.whenPrepared = (waiting.whenPrepared || []).filter((f) => f !== ready); newWindowFor(); } }, 1500);
    waiting.whenPrepared = [...(waiting.whenPrepared || []), ready];
    return;
  }
  newWindowFor();
}
function beginTabDrag(src, tabId, grab) {
  if (tabDrag) finishTabDrag('cancel');
  const tab = tabsOf(src).find((t) => t.id === tabId && !t.closing);
  if (!tab || !rcAlive(src)) return false;
  const cursor = cursorPoint();
  // A multi-selection travels together, and so does a group dragged by its label; dragging every tab of a
  // window drags the window.
  const moving = Number.isInteger(grab.group) ? groupForMove(src, grab.group) : null;
  const ids = moving?.ids.includes(tabId) ? moving.ids : tabsActedOn(src, tabId, grab.ids);
  const single = closableTabCount(src) - ids.length < 1;
  const d = tabDrag = { started: Date.now(), tabId, ids: single ? [tabId] : ids, single, card: !single, rec: src, strips: new Map(), stripsAt: Date.now(), hover: null, last: null };
  if (moving?.ids.includes(tabId) && !single) { d.group = moving.group; d.groupId = grab.group; }
  if (moving?.ids.includes(tabId) && single) d.chipGroup = moving.group; // the whole window is that group: its chip says so
  // What a strip it hovers shows in the slot it opens: the tab itself (its icon and title), as it will be there.
  const entry = withWindow(src, () => tabState().tabs.find((t) => t.id === tabId));
  const ghostGroup = d.group || d.chipGroup;
  d.ghost = entry && { group: ghostGroup ? { name: ghostGroup.name, color: ghostGroup.color } : null, title: entry.title, favicons: entry.favicons || [], page: entry.page || null, sleeping: Boolean(entry.sleeping), pinned: (single ? tabsOf(src).filter((t) => !t.closing) : tabsOf(src).filter((t) => d.ids.includes(t.id))).every((t) => t.pinned), count: single ? tabsOf(src).filter((t) => !t.closing).length : d.ids.length };
  const w = src.win;
  if (single) {
    if (!TEST_BACKGROUND) dragCardWindow(); // loaded now, so the chip shows the moment a strip is reached
    // The whole window follows the cursor, like its title bar; a maximized one is restored first.
    const before = w.getBounds();
    d.origin = { bounds: before, maximized: w.isMaximized() };
    const size = d.origin.maximized ? w.getNormalBounds() : before;
    if (d.origin.maximized) w.unmaximize();
    d.size = { width: size.width, height: size.height };
    d.grab = { x: (grab.x * size.width) / before.width, y: grab.y };
  } else {
    // The tab stays in its window; the card follows. A new window would open at this size, with the
    // tab under the cursor as it sits in the strip.
    const size = w.isMaximized() ? w.getNormalBounds() : w.getBounds();
    d.size = { width: size.width, height: size.height };
    // layout: where the grabbed point will sit in the new strip (unscrolled, with the tabs that
    // will be to its left). stripX is the same number when the renderer already worked it out,
    // and what tests pass when they don't send a layout.
    const laid = grab.layout ? tabDragMath.grabPoint(grab.layout) : null;
    d.grab = { x: Number.isFinite(laid) ? laid : grab.stripX, y: grab.pressY || grab.y };
    showDragCard(d, tab, cursor).then(() => stepAside(d));
    prepareDragWindow(src); // if the renderer's early hint didn't come
  }
  d.escape = (_e, input) => { if (input.type === 'keyDown' && input.key === 'Escape') finishTabDrag('cancel'); };
  w.webContents.on('before-input-event', d.escape);
  refreshDragStrips(d);
  d.timer = setInterval(() => { if (dragTicks.due(DRAG_TICK_GAP)) tickTabDrag(); }, 8); // a pointer move may have just ticked
  return true;
}
const num = (v) => (Number.isFinite(v) ? v : 0);
ipcMain.on('tab:dragstart', (event, id, grab) => {
  const src = recOfSender(event.sender); // a private window's UI is not in winRecs: refused
  if (!src || isSpare(src) || !Number.isInteger(id)) return;
  const ids = Array.isArray(grab?.ids) ? grab.ids.filter(Number.isInteger).slice(0, 1000) : null;
  beginTabDrag(src, id, { x: num(grab?.x), y: num(grab?.y), stripX: num(grab?.stripX), pressY: num(grab?.pressY), ids, group: Number.isInteger(grab?.group) ? grab.group : null, layout: grab?.layout && typeof grab.layout === 'object' ? grab.layout : null });
});
// The pointer moved (the page holding it reports every move): the card or window follows at once, on the
// mouse's own rhythm, instead of waiting for the next poll.
// At most one tick per 4 ms: a 1 kHz mouse reports a move per millisecond, and each tick looks every window up
// and moves a transparent window (the 8 ms poll below keeps going meanwhile), which backed up the main thread.
// The poll and the pointer reports share one gate (tickTabDrag marks it), so they never tick back to back.
const DRAG_TICK_GAP = 4;
const dragTicks = frameClock.tickGuard();
ipcMain.on('tab:dragmove', (event) => {
  if (tabDrag && dragTicks.due(DRAG_TICK_GAP) && recOfSender(event.sender) === tabDrag.rec) tickTabDrag();
});
// A tab is being pulled towards the edge of the strip: it may come out next, so have a window ready.
ipcMain.on('tab:dragprep', (event, tabId) => {
  const src = recOfSender(event.sender);
  if (!src || isSpare(src) || tabDrag) return;
  prepareDragWindow(src);
  const tab = Number.isInteger(tabId) && !TEST_BACKGROUND ? tabById(src, tabId) : null;
  if (tab) snapshotFor(tab).then((shot) => { if (shot && !tabDrag) prepShot = { tabId, src: shot, at: Date.now() }; });
});
// The release (or Escape) as seen by the window the tab is dragged from (or, for an only-tab drag, the
// window being dragged).
const dragEnder = (reason) => (event) => {
  const from = recOfSender(event.sender);
  if (tabDrag && from && from === tabDrag.rec) finishTabDrag(reason);
};
ipcMain.on('tab:dragend', dragEnder('commit'));
ipcMain.on('tab:dragcancel', dragEnder('cancel'));
function tearOffTab(src, tabId, point, ids = [tabId], group = null) {
  const tab = tabsOf(src).find((t) => t.id === tabId && !t.closing);
  ids = ids.filter((id) => tabsOf(src).some((t) => t.id === id && !t.closing));
  if (!ids.includes(tabId)) ids = [tabId];
  if (!tab || closableTabCount(src) - ids.length < 1) return false; // a window's last tabs stay where they are
  const anchor = point && Number.isFinite(point.x) && Number.isFinite(point.y) ? point : { x: 0, y: 0 };
  const area = screen.getDisplayNearestPoint(anchor).workArea;
  // getSize() on a maximized window is the maximized size, so the new window covered the old one
  // and hung off the work area. The restored size is what the drag path uses, and the window is
  // kept fully on the work area (it is not being dragged, so it should not slide off).
  const normal = src.win.isMaximized() ? src.win.getNormalBounds() : src.win.getBounds();
  const fit = tabDragMath.fitToDisplay({ width: normal.width, height: normal.height }, area);
  const at = tabDragMath.placeOnWorkArea({ x: anchor.x, y: anchor.y, width: fit.width, height: fit.height }, area);
  // Hidden until the tab has arrived and painted, then faded in and focused (revealNewWindow).
  const spare = takeSpare({ width: at.width, height: at.height });
  if (spare) {
    spare.win.setBounds({ x: at.x, y: at.y, width: at.width, height: at.height }); // one call: no size drift on mixed-DPI setups
    if (moveTabsBetween(src, spare, ids, 0, { focus: false, active: tabId, group })) revealNewWindow(spare, tabId, () => keepSelection(spare, ids));
    else spare.win.close();
    return true;
  }
  const rec = createWindow({
    size: { width: at.width, height: at.height }, position: { x: at.x, y: at.y }, hidden: true, boundsFrom: src,
    adopt: { src, tabId, ids, group, focus: false, done: (ok) => { if (ok && rcAlive(rec)) revealNewWindow(rec, tabId, () => keepSelection(rec, ids)); } },
  });
  return true;
}
// The window's own label in "Move tab to window": what it is showing, and how many tabs it has.
const windowLabel = (rec) => withWindow(rec, () => {
  const tab = tabs.find((x) => x.id === activeId);
  return `${(tab && tabTitle(tab)) || 'New Tab'} (${tabs.length})`;
});
if (TEST) {
  global.__windows = {
    list: () => [...winRecs].filter((r) => rcAlive(r) && !isSpare(r)).map((rec) => ({
      windowId: rec.win.id,
      uiContentsId: rec.win.webContents.id,
      tabs: tabsOf(rec).filter((t) => alive(t) || t.sleeping).map((t) => ({ id: t.id, contentsId: alive(t) ? t.view.webContents.id : null, url: alive(t) ? t.view.webContents.getURL() : t.sleepUrl, pinned: Boolean(t.pinned), groupId: t.groupId || null })),
      activeId: activeIdOf(rec),
      current: rec === curRec,
    })),
    moveTo: (srcWindowId, tabId, windowId, index) => moveTabToWindowId([...winRecs].find((r) => rcAlive(r) && r.win.id === srcWindowId), tabId, windowId, index),
    setCursor: (point) => { global.__testCursor = point; }, // null: the real cursor
    setDragTimeout: (ms) => { tabDragTimeoutMs = ms; },
    spare: () => (rcAlive(spareRec) && spareRec.preparedReady ? spareRec.win.id : null), // prepareDragWindow's window, once loaded
    dragState: () => tabDrag && {
      windowId: tabDrag.rec.win.id, ready: true, single: tabDrag.single, card: tabDrag.card, ids: [...tabDrag.ids],
      cardAt: tabDrag.cardAt || null, // where the card's window is (a card drag), shown or not
      hover: tabDrag.hover && { windowId: tabDrag.hover.rec.win.id, beforeId: tabDrag.hover.beforeId },
      bounds: rcAlive(tabDrag.rec) ? tabDrag.rec.win.getBounds() : null,
    },
    cardHold: () => ({ ...CARD_HOLD }),
    tearOff: (srcWindowId, tabId, point, ids) => tearOffTab([...winRecs].find((r) => rcAlive(r) && r.win.id === srcWindowId), tabId, point, ids),
    group: (windowId, ids, name) => withWindow([...winRecs].find((r) => rcAlive(r) && r.win.id === windowId), () => { const g = tabGroups.create(name, ids); sendTabs(); return g.id; }),
    pin: (windowId, tabId, on) => withWindow([...winRecs].find((r) => rcAlive(r) && r.win.id === windowId), () => pinTab(tabId, on)),
    // A new tab in that window, whichever window is current (a late focus event can move "current" under a test).
    open: (windowId, url) => withWindow([...winRecs].find((r) => rcAlive(r) && r.win.id === windowId), () => { const t = global.__agent.browser.openTab(url); return { id: t.id, contentsId: t.webContents.id }; }),
    setSelection: (windowId, ids) => { const rec = [...winRecs].find((r) => rcAlive(r) && r.win.id === windowId); if (rec) rec.selection = ids; },
    tabMenu: (windowId, tabId) => withWindow([...winRecs].find((r) => rcAlive(r) && r.win.id === windowId), () => (tabMenuTemplate(tabId) || []).map((i) => ({ label: i.label, enabled: i.enabled !== false, sub: (i.submenu || []).map((s) => s.label) }))),
  };
}

// LUMEN_TEST_BACKGROUND (tests only): the window opens off-screen without taking focus, and with no
// Dock icon, so test runs don't pull the keyboard away from a Lumen the user is working in.
const TEST_BACKGROUND = TEST && Boolean(process.env.LUMEN_TEST_BACKGROUND);
// `adopt` ({ src, tabId }): a tab torn off `src` becomes this window's only tab. `restore`: a saved
// window from the last session (the session's `more`). Neither: the first window, restoring the session.
// `prepared`: a hidden window for a tear-off that may come (prepareDragWindow): it loads its UI and waits.
// `boundsFrom`: a window of the same size whose page area this one starts with, so the tab's page is at
// its place from the first frame instead of jumping there once this window's UI reports its own.
// The first tab (restored or new) has finished loading, or 8 s have passed: the spare new-tab page, the
// suggestions renderer, the CLI checks and the extension update check start then, not while it loads.
let markFirstTabLoaded = () => {};
const firstTabLoaded = new Promise((resolve) => { markFirstTabLoaded = resolve; });
let firstTabDone = false;
firstTabLoaded.then(() => { firstTabDone = true; });
// Opened once extensions and the ad blocker are ready at start-up: until then windows load, but get no tabs.
let openTabsGate = () => {};
const GUESS_TOOLBAR_HEIGHT = 82; // the tab strip and toolbar: where a first tab's page goes before the UI has said (content-bounds)
const tabsGate = new Promise((resolve) => { openTabsGate = resolve; });
function createWindow({ size = null, position = null, adopt = null, restore = null, hidden = false, prepared = false, boundsFrom = null } = {}) {
  if (TEST_BACKGROUND) app.dock?.hide();
  const firstWindow = winRecs.size === 0;
  const w = new BrowserWindow({
    ...(TEST_BACKGROUND || hidden ? { show: false } : {}), // hidden: the caller shows it (a window being dragged)
    width: size?.width || 1440,
    height: size?.height || 920,
    ...(position || {}),
    minWidth: 800,
    minHeight: 500,
    title: 'Lumen',
    icon: WINDOW_ICON,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay() }),
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'preload.bundle.js'), // preload.js with the toolbar element inlined (scripts/bundle-preload.js)
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: TEST ? [require('./test-mode').PRELOAD_FLAG] : [], // preload.js's test-only calls
    },
  });
  const seedBounds = rcAlive(boundsFrom) && winRecs.has(boundsFrom) ? withWindow(boundsFrom, () => ({ ...contentBounds })) : null;
  const rec = { win: w, prepared, preparedReady: false, tabs: [], activeId: null, contentBounds: seedBounds || { x: 0, y: 0, width: 800, height: 600 }, viewFrozen: false, chatFullTab: null, uiReady: false, suggestView: null, downloadsView: null, downloadsAnchor: null, groups: new Map(), pendingRestore: Boolean(restore) };
  winRecs.add(rec);
  enterWindow(rec); // from here on `win`, `tabs` ... are this window's
  bindContext(w, () => rec);
  bindContext(w.webContents, () => rec);
  uiContents.add(w.webContents);
  // Invisible and click-through, but shown (so it paints and screenshots work); macOS keeps part of
  // any window on screen, so moving it away is not enough.
  if (TEST_BACKGROUND) { w.setOpacity(0); w.setIgnoreMouseEvents(true); w.setPosition(-5000, -5000); w.showInactive(); }
  // The taskbar button's icon: Lumen.exe's own is Electron's (see features/instance.js appIcon).
  if (process.platform === 'win32' && app.isPackaged) {
    // Set again once the UI has loaded: the taskbar can read the window's properties before the first
    // call lands (or after the shell recreates the button), and a repeat is harmless.
    const taskbarDetails = () => {
      if (w.isDestroyed()) return;
      try { w.setAppDetails({ appId: APP_ID, appIconPath: instance.appIcon(), appIconIndex: 0, relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: 'Lumen' }); } catch {}
    };
    taskbarDetails();
    w.webContents.once('did-finish-load', taskbarDetails);
    w.once('show', taskbarDetails);
  }
  if (firstWindow) Menu.setApplicationMenu(process.platform === 'darwin' ? macMenu() : null);
  else refreshWindowMenu(); // a window opened: "Merge All Windows" may now be possible
  w.webContents.on('before-input-event', (event, input) => handleShortcut(event, input));
  hardenOwnView(w.webContents, UI_URL);
  // will-navigate doesn't see loads started from the main process: if anything ever points the UI
  // elsewhere, put the UI straight back (the IPC gate already ignores any other document meanwhile).
  w.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument || isUiUrl(details.url)) return;
    const wc = w.webContents;
    setImmediate(() => { if (!wc.isDestroyed()) wc.loadFile(UI_HTML).catch(() => {}); });
  });
  // Closing one of several windows leaves it out of the saved session (you closed it on purpose);
  // quitting saves them all at once (before-quit) and the windows closing one by one after that don't.
  w.on('close', () => { if (!quitting) saveSession({ excluding: [...winRecs].filter((r) => rcAlive(r) && !isSpare(r)).length > 1 ? rec : null }); });
  // The window is gone (on macOS the app can keep running): the session was just saved, so end
  // the tab pages too, or a video or call kept playing with no window to stop it.
  w.on('closed', () => {
    uiReady = false;
    clearTimeout(freezeTimers.get(rec)); // no freeze timer outlives its window
    freezeTimers.delete(rec);
    dropDeadWindowViews();
    winRecs.delete(rec);
    if (rec === spareRec) spareRec = null;
    if (![...winRecs].some((r) => rcAlive(r) && !isSpare(r))) { closeSpare(); closeDragCard(); } // no windows left to tear a tab off
    const next = [...winRecs].find((r) => rcAlive(r) && !isSpare(r));
    if (next) enterWindow(next);
    refreshWindowMenu(); // a window closed
  });
  // The browser UI's own page crashed: reload it and send it the tabs again, instead of leaving a
  // dead window. The tabs themselves live in their own processes and are unaffected.
  w.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || !ui()) return;
    console.error(`[lumen] browser UI process gone (${details.reason}); reloading it`);
    ui().reload();
  });
  let uiHungAsked = false;
  w.webContents.on('unresponsive', () => {
    if (uiHungAsked) return;
    uiHungAsked = true;
    dialogs.showMessageBox(win, {
      type: 'warning', buttons: [t('hung.wait'), t('uiHung.reload')], defaultId: 0, cancelId: 0,
      message: t('uiHung.title'),
      detail: t('uiHung.detail'),
    }).then(({ response }) => { if (response === 1 && !w.isDestroyed()) w.webContents.forcefullyCrashRenderer(); });
  });
  w.webContents.on('responsive', () => { uiHungAsked = false; });
  w.webContents.on('did-finish-load', () => {
    if (!uiReady) return; // the first load: set up below
    sendTabs(); // a reload after a crash: bring the fresh UI up to date
    followFront({ push: false }); // [chat per tab] this window's tab's chat
    const items = agent.transcript();
    if (ui()) shownChat.set(ui(), chatId);
    if (items.length) ui()?.send('agent:history', { items });
  });
  w.on('focus', () => { ui()?.send('window-focus', true); if (uiReady) followFront(); }); // [chat per tab] the sidebar shows the chat of the tab in front here
  w.on('blur', () => ui()?.send('window-focus', false));
  w.on('resize', () => { hideSuggestions(); hideDownloadsPanel(); dialogs.layout(); if (tabs.some((t) => t.fullscreen)) layout(); });
  w.on('blur', hideSuggestions);
  w.loadFile(UI_HTML);
  // A window's first tabs open as soon as extensions and the filter lists are ready (tabsGate), while its UI is still
  // loading: the first page's renderer starts and its page loads alongside the UI instead of after it (~150 ms sooner
  // on screen). Its view stays hidden until the UI has said where pages go (content-bounds), and the UI is brought up
  // to date once it has loaded (finishSettle).
  // (Not before the UI's page has committed: its renderer is then the window's first, which is what tools driving
  // Lumen, like the test suites' firstWindow(), take as the window.)
  let uiLoaded = false;
  let tabsOpened = false;
  if (!adopt && !prepared) {
    const committed = new Promise((resolve) => { w.webContents.once('did-navigate', resolve); w.webContents.once('did-finish-load', resolve); });
    Promise.all([tabsGate, committed]).then(() => { if (rcAlive(rec)) withWindow(rec, openFirstTabs); });
  }
  w.webContents.once('did-finish-load', () => {
    uiLoaded = true;
    rec.uiLoaded = true;
    firstTabLoaded.then(() => { if (rcAlive(rec) && !rec.win.isDestroyed()) withWindow(rec, () => { if (!suggestView) createSuggestView(); }); });
    if (rec.prepared) {
      // Ready for a tear-off (takeSpare); no tabs until then.
      uiReady = true;
      rec.preparedReady = true;
      const waiting = rec.whenPrepared; // a drop that came while this window was loading (finishCardDrag)
      rec.whenPrepared = null;
      if (waiting) setImmediate(() => waiting.forEach((f) => f()));
      return;
    }
    // A window's first tabs wait for extensions and the filter lists (every tab is registered with chrome.tabs and
    // filtered from its first request); the window and its UI load meanwhile (see tabsGate at start-up).
    if (!adopt) { if (tabsOpened) finishSettle(); return; } // (else openFirstTabs finishes once the gate opens)
    settle();
  });
  function openFirstTabs() {
    if (tabsOpened) return;
    tabsOpened = true;
    if (!uiLoaded && !rec.boundsReported) {
      rec.holdViews = true; // (layout() keeps tab views hidden until the UI reports where they go)
      if (!seedBounds) { // laid out at about the size it will have, so the page isn't laid out twice
        const [width, height] = w.getContentSize();
        contentBounds = { x: 0, y: GUESS_TOOLBAR_HEIGHT, width, height: Math.max(0, height - GUESS_TOOLBAR_HEIGHT) };
      }
    }
    restoreSession(restore);
    rec.pendingRestore = false;
    refreshWindowMenu(); // its tabs are back: it may take part in a merge now
    if (uiLoaded) finishSettle();
  }
  // The UI has loaded and the window's tabs are open: the UI gets their state (anything sent while it was
  // still loading went nowhere), the new-tab page's address bar its focus, then the rest of a window's start.
  function finishSettle() {
    if (rec.holdViews) { rec.holdViews = false; layout(); }
    sendTabs();
    if (rec.focusAddressPending) { rec.focusAddressPending = false; focusAddress(); } // a new tab asked for it while the UI loaded
    afterSettle();
  }
  // A torn-off tab's window (adopt): its tab moves in once its UI has loaded.
  function settle() {
    // The torn-off tab moves in now that this window can show it; if it is gone by now, a blank tab.
    const adopted = moveTabsBetween(adopt.src, rec, adopt.ids || [adopt.tabId], 0, { focus: adopt.focus !== false, active: adopt.tabId, group: adopt.group || null });
    if (!adopted) {
      // The tab is gone (closed, or its window closed) while this window was loading. It isn't wanted then,
      // unless it is the only window left: that one gets a new tab rather than leaving no window at all.
      const others = [...winRecs].some((r) => r !== rec && rcAlive(r) && !isSpare(r));
      adopt.done?.(false);
      if (others) { setImmediate(() => { if (rcAlive(rec)) rec.win.close(); }); return; }
      if (!tabs.length) openTab();
      if (!rec.win.isVisible()) rec.win.show();
    } else {
      adopt.done?.(true);
    }
    rec.pendingRestore = false;
    refreshWindowMenu(); // its tabs are back: it may take part in a merge now
    afterSettle();
  }
  function afterSettle() {
    // [chat per tab] Restoring the tabs (or the tab that moved in) brought the open chat to the front tab's. A chat still working
    // there (a tab that moved here mid-task) shows live, and its events come to this window from now on.
    if (ui() && runIsLive(chatRuns.get(chatId))) pushChatView(ui());
    else {
      const items = agent.transcript();
      if (ui()) shownChat.set(ui(), chatId);
      if (items.length) ui()?.send('agent:history', { items });
    }
    uiReady = true;
    perf.mark('uiReady');
    downloads.send(); // last session's downloads: the toolbar button shows when there are any
    openLinksFromOtherApps(pendingLinks.splice(0));
    // After an update, the release notes come up once, a moment after the restored tabs (only the
    // first normal window asks; whatsNew.check runs once per launch).
    if (firstWindow) setTimeout(() => { if (!w.isDestroyed()) whatsNew.check().catch((err) => console.error('[lumen] what\'s new:', err.message)); }, 1200);
    // A fresh install opens the sidebar on its welcome (connect an AI, bring bookmarks, default browser).
    if (firstWindow && !TEST && setup.welcomePending()) ui()?.send('setup:welcome');
    if (firstWindow && crashRecovery.pending()) setTimeout(() => { offerCrashRestore().catch((err) => console.error('[lumen] crash recovery:', err.message)); }, 600); // the last run crashed and the startup setting wouldn't bring its tabs back
    if (firstWindow) setTimeout(() => setup.isDefault().catch(() => {}), 2000).unref?.(); // (for the app menu's item)
  }
  return rec;
}
let quitting = false; // the app is shutting down: the session was saved by before-quit
app.on('before-quit', () => {
  if ([...winRecs].some(rcAlive)) saveSession();
  crashRecovery.end(); // a normal quit: the next start offers nothing
  if (settingsPending && settingsCache) writeSettingsNow(settingsCache); // (a change still on its way to disk lands now)
  if (historyDirty && historyLoaded) { // (visits from the last two seconds land now, once the past is merged in)
    clearTimeout(historySaveTimer);
    historyDirty = false;
    try { fs.writeFileSync(HISTORY_FILE(), historyJson()); } catch { /* disk full or locked: the older file stays */ }
  }
  quitting = true;
});
let uiReady = false; // the window's UI has loaded and its tabs are open
// The title bar buttons follow the theme (one listener for the app, not one per window reopened).
nativeTheme.on('updated', () => {
  if (process.platform === 'darwin') return;
  for (const rec of winRecs) if (rcAlive(rec)) { try { rec.win.setTitleBarOverlay(titleBarOverlay()); } catch {} }
});

// ---------- links from other apps: Lumen as the default browser ----------
// A link clicked in another app arrives as a command-line argument (at launch, or through
// 'second-instance' when Lumen is already running) or, on macOS, as 'open-url'.
const pendingLinks = [];
// Files too: Finder's Open With and double-clicks arrive as 'open-file' on macOS; Windows "Open
// with" passes the path as an argument. Only existing files and folders are opened.
function fileUrlsFor(paths, { filesOnly = false } = {}) {
  return paths.filter((p) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
    try { const st = fs.statSync(p); return filesOnly ? st.isFile() : st.isFile() || st.isDirectory(); } catch { return false; }
  }).map((p) => pathToFileURL(p).href);
}
// From a command line only files count: run from source, Electron's own arguments include the app
// folder (and flags), which must not open as a tab.
const appDir = path.resolve(app.getAppPath());
const linksIn = (argv) => [
  ...argv.slice(1).filter((arg) => /^https?:\/\//i.test(arg)),
  ...fileUrlsFor(argv.slice(1).filter((arg) => !arg.startsWith('-') && !path.resolve(arg).startsWith(appDir)), { filesOnly: true }),
];
function openLinksFromOtherApps(urls) {
  if (!urls.length) return;
  if (!uiReady) { pendingLinks.push(...urls); return; }
  urls.forEach((url, i) => openTab(url, { background: i < urls.length - 1 }));
  focusWindow();
}
pendingLinks.push(...linksIn(process.argv));
app.on('open-url', (event, url) => { event.preventDefault(); openLinksFromOtherApps([url]); });
app.on('open-file', (event, filePath) => { event.preventDefault(); openLinksFromOtherApps(fileUrlsFor([filePath])); });
// File > Open File… (Cmd/Ctrl+O): pages, PDFs, images, text and media open in tabs, as in Chrome.
const OPENABLE = ['html', 'htm', 'xhtml', 'shtml', 'mhtml', 'svg', 'pdf', 'txt', 'md', 'json', 'xml', 'csv', 'log', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'm4a', 'flac'];
async function openFileDialog() {
  if (!win || win.isDestroyed()) return;
  const { canceled, filePaths } = await electronDialog.showOpenDialog(win, {
    title: t('dialog.openFile.title'),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: t('dialog.openFile.filter'), extensions: OPENABLE }, { name: t('dialog.openFile.all'), extensions: ['*'] }],
  });
  if (!canceled) openLinksFromOtherApps(fileUrlsFor(filePaths));
}
// Registering is the user's choice (the ⋯ menu), never done silently. Windows then needs its own
// Default apps page to confirm; macOS asks by itself.
// (features/setup.js: on Windows Lumen registers as a browser so Default apps can offer it, and the user's real
// choice is read back, not the protocol handler.)
function makeDefaultBrowser() { setup.makeDefault().catch(() => {}); }
const isDefaultBrowser = () => setup.lastDefault() ?? false;

function groupTabsFor(name, ids) {
  const known = ids.filter((id) => tabs.some((t) => t.id === id));
  if (!known.length) throw new Error('None of those tab ids are open.');
  for (const id of known) if (tabs.find((t) => t.id === id).groupId) tabGroups.remove(id);
  const group = tabGroups.create(name, known);
  sendTabs();
  return { group: group.name, tabs: known };
}
// [ai controls] A tab's group (a copy), and putting a tab back into one (Undo of an AI run): the
// group is recreated if it has gone since; null takes the tab out of any group.
function tabGroupOf(id) {
  const tab = tabs.find((t) => t.id === id);
  const group = tab?.groupId ? tabGroups.groups.get(tab.groupId) : null;
  return group ? { ...group } : null;
}
function setTabGroup(id, group) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab || tab.pinned) return;
  if (tab.groupId) tabGroups.remove(id);
  if (group) {
    if (!tabGroups.groups.has(group.id)) tabGroups.restore([group]);
    tabGroups.add(id, group.id);
  }
  tabGroups.cleanup();
  sendTabs();
}
function ungroupTabsFor(ids) {
  let count = 0;
  for (const id of ids) if (tabGroups.remove(id, { byUser: true })) count++;
  sendTabs();
  return count;
}

// [settings] the AI agent (and MCP clients, which use it) never gets the settings tab as its page,
// nor the Bookmarks or Downloads page (their page API can edit bookmarks and open downloaded files).
const agentOffLimits = (t) => Boolean(t && (t.settings || (alive(t) && managerPageOf(t.view.webContents.getURL()))));
// A run started from the chat page works in the tab the user last looked at, not in the chat tab in front.
const agentActiveTab = () => {
  const pinned = chatPageRt?.runTarget();
  if (pinned != null) return agentTabById(pinned);
  const t = activeTab();
  return t && agentOffLimits(tabs.find((x) => x.id === t.id)) ? null : t;
};
// ...and its tabs open and switch out of sight, so the user stays on the chat page.
// [chat per tab] ...and so do a chat's tabs when the user is looking at another tab than the one it works in.
// [ai manners] The tab the AI's tool opens stays behind the user's: it comes to the front only when the tool asked for it
// ({ show: true }) and the user is looking at the run's own tab. Opening one never moves the omnibox caret or a field's focus.
// `ai`: the AI is opening it for its work (marked openedBy the run, so it can be closed again and, in hands-off mode,
// worked in); Undo reopening a tab it closed is not that.
const runOwnTabId = () => { const s = agent.currentScope(); return s?.chat ? (s.tabId ?? activeId) : activeId; };
const runOf = (scope = agent.currentScope()) => ({ chatId: scope?.chatId ?? null, runId: scope?.runId ?? null });
const agentOpenTab = (url, opts = {}) => {
  const { ai = false, show: wantShow = false, ...rest } = opts || {};
  const fromPage = chatPageRt?.runTarget() != null;
  const show = !fromPage && manners.showsTab({ show: wantShow === true, runTabId: runOwnTabId(), activeId });
  const tab = openTab(url, { ...rest, background: !show, ...(ai ? { openedBy: runOf() } : {}) });
  if (fromPage) chatPageRt.retarget(tab.id);
  else if (show) bindRunChatTo(tab.id);
  return tab;
};
const agentSwitchTab = (id, opts = {}) => {
  const fromPage = chatPageRt?.runTarget() != null;
  if (!fromPage && manners.showsTab({ show: opts?.show === true, runTabId: runOwnTabId(), activeId })) {
    const ok = switchTab(id);
    if (ok) bindRunChatTo(id);
    return ok;
  }
  const t = tabs.find((x) => x.id === id);
  if (!t || agentOffLimits(t)) return false;
  if (t.sleeping) wakeTab(t); // (the run is about to use it)
  if (fromPage) chatPageRt.retarget(id);
  return true;
};
// Why there's no page to work on while one of those is in front (instead of "No tab is open").
const noTabReason = () => {
  const t = tabs.find((x) => x.id === activeId);
  if (!agentOffLimits(t)) return null;
  const name = t.settings ? 'Lumen Settings' : `Lumen's ${{ bookmarks: 'Bookmarks', chat: 'chat' }[managerPageOf(t.view.webContents.getURL())] || 'Downloads'} page`;
  return `The active tab is ${name}, which the assistant cannot read or control. Use switch_tab or open_tab to work on a web page.`;
};
// A task's pinned tab (agent.js taskScope), looked up by id: never the settings tab; a sleeping one
// is woken, since the agent is about to use it.
const agentTabById = (id) => {
  // A tab moved to another window while a task works in it is still that task's tab, not a closed one.
  let owner = curRec;
  let t = tabs.find((x) => x.id === id);
  if (!t) {
    for (const rec of winRecs) {
      if (rec === curRec || !rcAlive(rec)) continue;
      t = tabsOf(rec).find((x) => x.id === id);
      if (t) { owner = rec; break; }
    }
  }
  if (t?.sleeping) withWindow(owner, () => wakeTab(t));
  return t && alive(t) && !agentOffLimits(t) ? { id: t.id, webContents: t.view.webContents } : null;
};
// [ask across tabs] This window's tabs as read_tabs and the "@" picker see them (features/tabs-ask.js
// decides which may be read). A private window's tabs are never in here: it keeps its own.
const askTabsList = () => tabs.filter((t) => !t.closing && (alive(t) || t.sleeping)).map((t) => {
  const live = alive(t);
  const url = live ? realUrl(t.view.webContents) : t.sleepUrl || '';
  return { id: t.id, title: tabTitle(t) || hostOf(url) || '', url, sleeping: Boolean(t.sleeping), active: t.id === activeId, offLimits: agentOffLimits(t), favicon: t.favicon || null, webContents: live ? t.view.webContents : null };
});
const agentHasUnsavedInput = (id) => { const t = tabs.find((x) => x.id === id); return alive(t) ? hasUnsavedInput(t.view.webContents) : false; };
// How Claude is reached, so an expired sign-in isn't reported as a bad API key.
const anthropicAuth = () => (storedApiKey() ? 'key' : process.env.ANTHROPIC_API_KEY ? 'env' : cliAuth.profileState().signedIn ? 'cli' : null);
// [mcp client] MCP servers the user added, for the sidebar's AI (features/mcp-client.js)
const mcpClient = require('./features/mcp-client').create({
  userData: app.getPath('userData'),
  version: app.getVersion(),
  secrets: {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
    decrypt: (enc) => safeStorage.decryptString(Buffer.from(enc, 'base64')),
  },
});
require('./features/mcp-client').registerIpc(ipcMain, mcpClient);
app.on('will-quit', () => mcpClient.stopAll());
// With several windows, a run's tab tools keep acting on the window the run started in (its
// tabs, its active tab), whichever window has focus meanwhile. Outside a run they follow the focused window.
// Each sidebar run carries its window on its task scope (agent:ask); outside a tool call, the open chat's run.
const runRecNow = () => {
  const rec = agent.currentScope()?.rec || chatRuns.get(chatId)?.rec || null;
  return rec && winRecs.has(rec) ? rec : null;
};
const inRun = (fn) => (...args) => { const rec = runRecNow(); return rec ? withWindow(rec, () => fn(...args)) : fn(...args); };
// [research tabs] web_search / read_urls show what they look at in background tabs (features/research-tabs.js).
// The tabs open in the run's window, behind the user's current tab, never through agentOpenTab (that
// would move the task onto them). Private windows have no agent, so none of this reaches them.
const researchTabs = require('./features/research-tabs').createResearchTabs({
  enabled: () => readSettings().researchTabs !== false,
  isAiOff: (url) => aiSites.isOff(url),
  searchUrl: (query) => searchUrlFor(readSettings().searchEngine, query),
  openTab: inRun((url, opts) => openTab(url, { background: true, openedBy: runOf(), ...opts }).id), // [ai manners] research tabs are the AI's too
  navigateTab: inRun((id, url) => { const t = tabs.find((x) => x.id === id); if (alive(t)) t.view.webContents.loadURL(url).catch(() => {}); }),
  tabExists: inRun((id) => { const t = tabs.find((x) => x.id === id); return Boolean(t && !t.closing && (alive(t) || t.sleeping)); }),
  createGroup: inRun((name, ids) => { const g = tabGroups.create(name, ids.filter((id) => tabs.some((t) => t.id === id)), { color: require('./features/research-tabs').GROUP_COLOR }); sendTabs(); return g.id; }),
  groupExists: inRun((groupId) => tabGroups.groups.has(groupId)),
  setReading: inRun((id, on) => { const t = tabs.find((x) => x.id === id); if (t && Boolean(t.aiReading) !== on) { t.aiReading = on; sendTabs(); } }),
});
// [signed-in sites] read_urls as_user (features/signed-in-sites.js): with the user's OK per host, the
// sidebar's AI reads a page with the user's own session, in a background tab of the run's window grouped
// "AI: <host> (signed in)". Locked (no popups) while it is read; closed when the run ends unless the user
// switched to it. Only this Agent gets it: background tasks and outside agents (MCP) read signed out.
const signedInSites = require('./features/signed-in-sites').createSignedInSites({ readSettings, writeSettings });
signedInSites.register(ipcMain);
const tabAnywhere = (id) => {
  for (const rec of winRecs) {
    const t = rcAlive(rec) ? tabsOf(rec).find((x) => x.id === id) : null;
    if (t) return { rec, t };
  }
  return null;
};
const signedInReader = {
  hosts: () => signedInSites.hosts(),
  add: (host) => signedInSites.add(host),
  hasLogin: async (url) => require('./features/signed-in-sites').hasLoginCookies(await session.defaultSession.cookies.get({ url })),
  privateWindow: () => { const run = runRecNow(); const rec = run && winRecs.has(run) ? run : curRec; return !rec || !winRecs.has(rec); }, // private windows have no record, so never
  open: inRun((url) => {
    const tab = openTab(url, { background: true }); // the user's default session: no partition
    const t = tabs.find((x) => x.id === tab.id);
    if (t) {
      t.aiSignedIn = { openedAt: Date.now() };
      t.aiLock = true;
      t.aiReading = true;
      try { tabGroups.create(`AI: ${require('./features/signed-in-sites').hostOfUrl(url)} (signed in)`, [t.id], { color: require('./features/research-tabs').GROUP_COLOR }); } catch {}
      sendTabs();
    }
    return tab;
  }),
  unlock: (id) => {
    const found = tabAnywhere(id);
    if (!found) return;
    found.t.aiLock = false;
    found.t.aiReading = false;
    withWindow(found.rec, () => sendTabs());
  },
  close: (id, { force = false } = {}) => {
    const found = tabAnywhere(id);
    if (!found?.t.aiSignedIn) return;
    if (!force && (found.t.viewedAt || 0) >= found.t.aiSignedIn.openedAt) { found.t.aiLock = false; return; } // the user looked at it: it's theirs now
    withWindow(found.rec, () => closeTab(id));
  },
};
if (TEST) global.__signedInSites = signedInSites;

// [passwords] Saved passwords (features/passwords.js), off until the user turns on Settings → Privacy and
// security → Save passwords. Encrypted with safeStorage (the OS keychain) in <profile>/passwords.bin.
// Nothing here goes to the Agent below except filledIn(), a yes/no that makes run_script refuse a
// site in a tab where the user filled a password. The module loads when the feature is on, or when
// Settings first asks about it; until then no tab is watched and nothing is read from disk.
const allTabsEverywhere = () => (winRecs.size ? [...winRecs].flatMap((rec) => (rcAlive(rec) ? tabsOf(rec) : [])) : tabs);
async function passwordReauth(reason) {
  if (TEST) return Boolean(await global.__passwordsReauth?.(reason));
  if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
    try { await systemPreferences.promptTouchID(reason); return true; } catch { return false; }
  }
  // No Touch ID (Windows, Linux, a Mac without it): a confirmation, not real authentication.
  const { response, cancelled } = await dialogs.showMessageBox(win, { type: 'warning', message: t('passwords.reauth.confirm', { action: reason }), detail: t('passwords.reauth.detail'), buttons: [t('dialog.cancel'), t('passwords.reauth.continue')], defaultId: 0, cancelId: 0 });
  return !cancelled && response === 1;
}
let passwordsRt = null;
const passwords = () => {
  if (passwordsRt) return passwordsRt;
  passwordsRt = require('./features/passwords').createPasswords(passwordDeps());
  for (const tab of allTabsEverywhere()) if (alive(tab)) passwordsRt.attach(tab); // tabs opened before it loaded
  return passwordsRt;
};
const passwordDeps = () => ({
  file: path.join(app.getPath('userData'), require('./features/passwords').FILE_NAME),
  cipher: {
    available: () => safeStorage.isEncryptionAvailable(),
    backend: () => (process.platform === 'linux' ? safeStorage.getSelectedStorageBackend?.() : null),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (buf) => safeStorage.decryptString(buf),
  },
  readSettings, writeSettings, t: (...a) => t(...a), sendTabs: () => sendTabs(),
  tabOf: (wc) => allTabsEverywhere().find((x) => alive(x) && x.view.webContents === wc) || null,
  facts: (tab) => {
    const url = tab.view.webContents.getURL();
    return { isolated: Boolean(tab.isolated), settings: Boolean(tab.settings), internal: Boolean(tab.managerPage) || isInternal(url) || isErrorPage(url) || chatPage.isChatUrl(url), aiTab: Boolean(tab.aiSignedIn) };
  },
  allTabs: allTabsEverywhere,
  popupMenu: (template) => Menu.buildFromTemplate(template).popup({ window: win }),
  openSettings: (section) => openSettingsPage(section),
  reauth: passwordReauth,
  confirm: async ({ message, detail, buttons, defaultId }) => {
    if (TEST && global.__passwordsConfirm) return global.__passwordsConfirm({ message, buttons });
    const { response, cancelled } = await dialogs.showMessageBox(win, { type: 'warning', message, detail, buttons, defaultId, cancelId: defaultId });
    return cancelled ? defaultId : response;
  },
  notify: (message, detail) => { dialogs.showMessageBox(win, { type: 'info', message, detail, buttons: [t('dialog.ok')], defaultId: 0, cancelId: 0 }).catch(() => {}); },
  clipboard,
  pickCsv: async () => {
    if (TEST) return global.__passwordsPickCsv?.() || null;
    const { canceled, filePaths } = await electronDialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv'] }] });
    return canceled ? null : filePaths[0] || null;
  },
  outsideDriver: () => Boolean(aiAgents?.automationClients?.()), // a CDP client could read the page: no filling then
  isSettingsSender: (event) => syntheticTestEvent(event) || isSettingsSender(event),
});
// The settings page's calls (features/passwords.js checks each one again and knows the same list).
const PASSWORD_CHANNELS = ['state', 'set-enabled', 'list', 'reveal', 'copy', 'update', 'delete', 'delete-all', 'import', 'never-remove'].map((c) => `settings:passwords-${c}`);
for (const channel of PASSWORD_CHANNELS) ipcMain.handle(channel, (event, ...args) => passwords().invoke(channel, event, ...args));
ipcMain.on('passwords:act', (_e, action) => {
  if (!passwordsRt || !['menu', 'save', 'never', 'not-now'].includes(action)) return;
  passwordsRt.act(tabs.find((x) => x.id === activeId && alive(x)), action);
});
if (readSettings().savePasswords === true) passwords();
if (TEST) Object.defineProperty(global, '__passwords', { get: passwords, configurable: true });
if (TEST) global.__passwordChannels = PASSWORD_CHANNELS;
const agent = new Agent({
  research: researchTabs,
  signedIn: signedInReader, // [signed-in sites]
  passwordFilled: (wc) => Boolean(passwordsRt?.filledIn(wc)), // [passwords] run_script refuses a site in a tab where the user filled a saved password
  externalTools: mcpClient, // [mcp client]
  activeTab: inRun(agentActiveTab), tabById: inRun(agentTabById), noTabReason: inRun(noTabReason), listTabs: inRun(listTabs), openTab: inRun(agentOpenTab), switchTab: inRun(agentSwitchTab), closeTab: inRun(closeTab), requestCloseTab: inRun(requestCloseTab),
  hasUnsavedInput: inRun(agentHasUnsavedInput), askTabs: inRun(askTabsList), groupTabs: inRun(groupTabsFor), ungroupTabs: inRun(ungroupTabsFor), effectiveModel, anthropicAuth,
  aiOff: (url) => aiSites.isOff(url), tabGroupOf: inRun(tabGroupOf), setTabGroup: inRun(setTabGroup), // [ai controls]
  autoApprove: () => TEST || readSettings().askBeforeActing === false,
  handsOff: () => readSettings().aiHandsOff === true, isAiTab: (id) => manners.isAiTab(tabAnywhere(id)?.t), typingText: () => t('agent.waitTyping'), // [ai manners]
  maxSteps: () => readSettings().maxSteps, // Settings > Max steps per task (agent.js: stepLimit)
  takeNotice: (key) => { const s = readSettings(); if (s[key] !== true) return false; writeSettings({ ...s, [key]: false }); return true; }, // one-time notices
  autoModel: () => readSettings().autoModel !== false, // [model route] features/model-route.js
  claudeCodeFullAccess: () => readSettings().claudeCodeFullAccess === true, // [full access] ai/claude-code.js ARGS_FULL
  autoFallback: fallbackOn, fallbackOptions: () => modelOptions(), onFallback: () => modelsChanged(), // [model fallback] the picker shows the stand-in
}, getClient, () => ({ adhdMode: readSettings().adhdMode !== false, handsOff: readSettings().aiHandsOff === true, model: effectiveModel() || DEFAULT_MODEL }), providerKey);
// The sidebar's "Working in: <tab>" line: which tab the running task works in (it stays there when
// the user switches away), pushed on run start/end and whenever tabs change (a title, a switch).
let lastAgentTarget = '';
// The open chat's running task's tab ({ id, title, host, front }), or null. Also in chatView's `live`,
// so a chat opened again mid-run shows its "Working in" line at once.
function agentTargetInfo(rec = runRecNow() || curRec) {
  const id = agent.running ? agent.runTabId() : null;
  if (id == null) return null;
  const list = rec ? tabsOf(rec) : tabs;
  const t = list.find((x) => x.id === id) || [...winRecs].flatMap((r) => tabsOf(r)).find((x) => x.id === id);
  if (!t) return null;
  const url = alive(t) ? realUrl(t.view.webContents) : t.sleepUrl || '';
  return { id, title: tabTitle(t) || hostOf(url) || '', host: hostOf(url) || '', front: id === activeIdOf(rec || curRec) };
}
function pushAgentTarget() {
  syncRunTabs();
  const rec = runRecNow() || curRec;
  const info = agentTargetInfo(rec);
  const key = info ? `${info.id}|${info.title}|${info.front}` : '';
  if (key === lastAgentTarget) return;
  lastAgentTarget = key;
  const wc = rec && rcAlive(rec) ? rec.win.webContents : ui();
  if (wc && !wc.isDestroyed()) wc.send('agent:target', info);
}
agentTargetHook = pushAgentTarget;
// lumen://chat (features/chat-page.js): opens like the Bookmarks page, shares the agent's one chat with the sidebar.
chatPageRt = chatPage.create({
  ipcMain,
  tabs: () => tabs,
  alive,
  ui,
  openTab: (url, opts) => openTab(url, opts),
  switchTab: (id) => switchTab(id),
  requestCloseTab: (id) => requestCloseTab(id),
  managersOpen: () => managers.open('chat'),
  isPrivateSender: (event) => !syntheticTestEvent(event) && !recOfSender(event?.sender), // a private window's UI is in no window record
  chatView: () => chatView(),
  agentOffLimits,
  tabInfo: (t) => {
    const live = alive(t);
    return { id: t.id, title: live ? t.view.webContents.getTitle() : t.sleepTitle || '', url: live ? realUrl(t.view.webContents) : t.sleepUrl || '', favicon: t.favicon || null };
  },
});
chatPageRt.register();
if (TEST) global.__chatPage = { rt: chatPageRt, open: () => chatPageRt.open(), back: () => chatPageRt.back(), pick: () => chatPageRt.pick(), tabs: () => tabs.filter(alive).map((t) => ({ id: t.id, chat: t.managerPage === 'chat', url: t.view.webContents.getURL(), viewedAt: t.viewedAt || 0 })), contents: (id) => tabs.find((t) => t.id === id)?.view?.webContents, ui: () => ui(), activeId: () => activeId };
// [usage] Plan limits and Lumen's share of them (features/usage.js): Settings → You and AI → Usage,
// and the sidebar's meter.
// Tests don't look at the real ~/.claude for other Claude Code sessions (features/usage.js otherClaudeActivity): whoever runs them may be using Claude Code at that moment.
const usage = createUsage({ app, claudeBin: () => require('./ai/claude-code').findClaude(), grokSession: () => agent.messages?.settings?.gbSession || null, ...(TEST ? { otherActivity: async () => false } : {}) });
agent.onUsage = (engine, data) => usage.record(engine, data);
ipcMain.handle('usage:get', (_e, options) => usage.summary({ refresh: Boolean(options?.refresh) }));
// Background tasks: jobs the AI does on its own in hidden tabs, on a schedule or watching a page
// (features/background-runner.js). Kept out of the sidebar chat and the user's tabs.
const bgTasks = require('./features/background-runner').create({
  file: path.join(app.getPath('userData'), 'background-tasks.json'),
  encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
  decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  available: () => safeStorage.isEncryptionAvailable(),
  ui, readSettings, writeSettings, t, test: TEST,
  maxBackgroundTasks: () => perfMode.limits().maxBackgroundTasks, // Performance mode: one at a time
  getClient: (...args) => agent.getClient(...args), getKey: providerKey,
  effectiveModel, modelOptions, currentModel: () => effectiveModel(), anthropicAuth,
  aiOff: (url) => aiSites.isOff(url), externalTools: mcpClient, maxSteps: () => readSettings().maxSteps,
  reportUsage: (engine, data) => agent.onUsage?.(engine, data),
  cliEngine: (kind) => aiAgents.backgroundEngine(kind), cliStatus: () => aiAgents.cliStatus(), // Claude Code / Grok Build runs
  activeUrl: () => { const u = activeTab()?.webContents.getURL(); return isWebUrl(u) ? u : ''; },
  openTab: (url) => openTab(url), focusApp: () => focusWindow(),
});
bgTasks.register(ipcMain);
app.on('will-quit', () => bgTasks.shutdown());
if (TEST) global.__bg = bgTasks;
if (TEST) {
  global.__usage = usage;
  global.__agent = agent;
  global.__fitContext = require('./ai/agent').fitContext;
  global.__mcp = () => aiAgents.mcpServer();
  global.__providers = providers;
  global.__importBrowser = importBrowser;
  global.__tabGroups = tabGroups;
  global.__organizeTabs = organizeTabs;
  global.__cliJson = cliJson;
  global.__groupingRoute = groupingRoute;
  global.__organizeByTopic = organizeByTopic;
  global.__setTabGrouping = setTabGrouping;
  global.__setTopicAi = (on) => writeSettings({ ...readSettings(), topicAi: Boolean(on) });
  global.__undoOrganize = undoOrganize;
  global.__aiSites = aiSites;
  global.__markDragged = (id) => { const t = tabs.find((x) => x.id === id); if (t) t.userMoved = true; };
  global.__tabsArray = () => tabs.map((t) => ({ id: t.id, groupId: t.groupId || null, userRemoved: Boolean(t.userRemoved), pinned: Boolean(t.pinned), sleeping: Boolean(t.sleeping) }));
  global.__pinTab = pinTab;
  global.__openHistoryPage = openHistoryPage;
  global.__zoomBy = (step) => zoomBy(activeTab()?.webContents, step);
  global.__installExtension = (id) => installExtension(id, { session: session.defaultSession });
  global.__isContentBlocker = isContentBlocker;
  global.__adblock = { ready: adblock.ready, blocked: adblock.blocked };
  global.__downloads = { list: () => downloads.list.map((d) => ({ ...d })), menu: () => downloads.menu(), panel: () => downloadsView?.webContents, panelList: () => downloads.panelList(), show: (anchor) => showDownloadsPanel(anchor), hide: hideDownloadsPanel, visible: () => Boolean(downloadsView?.getVisible()) };
  global.__patchSettings = (patch) => writeSettings({ ...readSettings(), ...patch });
  // The tab menu's Mute Tab / Mute Site items (a native menu the tests can't click)
  global.__tabAudioMenu = (id, label) => {
    const tab = tabs.find((t) => t.id === id);
    const items = tab ? audioMenuItems(tab) : [];
    if (label) items.find((i) => i.label === label)?.click();
    return items.map((i) => i.label);
  };
  global.__closedTabs = () => closedTabs.slice();
  // The tab strip's right-click menu (test/tabmenu.js): its items as { label, enabled }, and with
  // `label`, that item clicked.
  global.__tabMenu = (id, label) => {
    const items = (tabMenuTemplate(id) || []).filter((i) => i.label);
    if (label) items.find((i) => i.label === label)?.click();
    return items.map((i) => ({ label: i.label, enabled: i.enabled !== false }));
  };
  global.__macMenuLabels = () => macMenu().items.map((m) => ({ label: m.label, items: m.submenu ? m.submenu.items.map((i) => i.label) : [] }));
  global.__mcpClient = mcpClient;
}

// ---------- skills (features/skills.js): /summarize and friends; managed in Settings → Skills ----------
// Saved prompts run from the composer's "/" menu. A run is an ordinary chat message (the expanded
// prompt), so usage, the approval gate and the taint rules apply unchanged; agent:ask above picks up
// the prepared run's options (tools off, own model, page text counted as read).
const skillPageScripts = require('./ai/page-scripts');
const SKILL_WORLD = 1002; // a JavaScript world of our own, apart from the page's and the agent's
const skillWithin = (promise, ms = 4000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
const skillTabOk = (tab) => alive(tab) && !agentOffLimits(tab) && isWebUrl(realUrl(tab.view.webContents)) && !aiSites.isOff(realUrl(tab.view.webContents));
// The model list or the chosen model changed: every window's sidebar, every chat page and Settings reload theirs.
function modelsChanged() {
  for (const rec of winRecs) if (rcAlive(rec) && !isSpare(rec)) rec.win.webContents.send('models-updated');
  for (const wc of [...chatPageRt.chatTabs().map((t) => t.view.webContents), ...tabs.filter((t) => t.settings && alive(t)).map((t) => t.view.webContents)]) if (wc && !wc.isDestroyed()) wc.send('models-updated');
}
const skillSurfaces = () => [ui(), ...chatPageRt.chatTabs().map((t) => t.view.webContents), ...tabs.filter((t) => t.settings && alive(t)).map((t) => t.view.webContents)].filter((wc) => wc && !wc.isDestroyed());
// One model call outside the chat (the proposal for "Create a skill from this chat"): same routes as tab grouping.
async function completeSkillJson(args) {
  return withFallback(String(cheapTopicModel()), (m) => completeSkillJsonOn(m, args));
}
async function completeSkillJsonOn(model, { system, user, schema }) {
  const route = await groupingRoute(model);
  if (route.engine) {
    const bin = await agent.engines[route.engine].detect();
    if (!bin) throw new Error(route.engine === 'claudecode' ? 'Claude Code isn’t installed.' : 'Grok Build isn’t installed.');
    return cliJson.completeJSON({ engine: route.engine, bin, model: route.model, system, user, schema, userData: app.getPath('userData') });
  }
  const { provider, model: id } = providers.splitModel(model);
  if (provider === 'anthropic') {
    const res = await agent.getClient().messages.create({ model: id, max_tokens: 2000, system, output_config: { format: { type: 'json_schema', schema } }, messages: [{ role: 'user', content: user }] });
    if (res.stop_reason === 'refusal') throw new Error('The model declined.');
    return JSON.parse(res.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
  }
  const apiKey = providerKey(provider);
  if (!apiKey) throw new Error(`Add your ${providers.PROVIDERS[provider].label} API key in Settings first.`);
  return providers.completeJSON({ provider, model: id, apiKey, system, user });
}
const skillsFeature = require('./features/skills').create({
  ipcMain,
  dialog: electronDialog,
  win: () => win,
  file: path.join(app.getPath('userData'), 'skills.json'),
  documentsDir: () => app.getPath('documents'),
  language: () => { try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(app.getLocale().split('-')[0]) || 'English'; } catch { return 'English'; } },
  clipboardText: async () => String(await clipboard.readText()).slice(0, 50000), // (a Promise in this Electron)
  // The tab a sender's skills read: the sidebar's active tab, or the chat page's target tab. Never
  // Settings, the chat page, a non-web page or a site the user turned AI off on.
  tabFor: (event) => {
    const tab = tabs.find((t) => t.id === (chatPageRt.isChatSender(event) ? chatPageRt.pick() : activeId));
    return tab && skillTabOk(tab) ? tab.view.webContents : null;
  },
  readPage: async (wc) => {
    const page = await skillWithin(wc.executeJavaScriptInIsolatedWorld(1001, [{ code: skillPageScripts.readPage(0, 0) }]));
    return { title: page.title, url: page.url, text: page.text };
  },
  readSelection: async (wc) => String(await skillWithin(wc.executeJavaScriptInIsolatedWorld(SKILL_WORLD, [{ code: 'String(getSelection())' }]))),
  tabText: async (id) => {
    const tab = Number.isInteger(id) ? tabs.find((t) => t.id === id) : null;
    if (!tab || !skillTabOk(tab)) return null;
    const page = await skillWithin(tab.view.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: skillPageScripts.readPage(0, 0) }]));
    return { title: page.title, url: page.url, text: page.text };
  },
  broadcast: (channel, payload) => { for (const wc of skillSurfaces()) wc.send(channel, payload); },
  openSettings: (section) => openSettingsPage(section),
  emitDraft: (draft) => { for (const t of tabs) if (t.settings && alive(t)) t.view.webContents.send('skills:draft', draft); },
  transcript: () => agent.transcript(),
  complete: (args) => (TEST && global.__skillsComplete ? global.__skillsComplete(args) : completeSkillJson(args)),
});
skillsFeature.register();
if (TEST) global.__skills = skillsFeature;

// ---------- [settings] lumen://settings ----------

// [look] New-tab pages already open take a new background, accent or layout at once (the page
// reads its design from its hash, so a hash change is enough: no reload, nothing typed is lost).
function refreshNewTabs() {
  const open = tabs.filter((t) => alive(t) && isNewTab(t.view.webContents.getURL()));
  if (!open.length) return;
  const url = newTabUrl();
  for (const t of open) t.view.webContents.executeJavaScript(`history.replaceState(null, '', ${JSON.stringify(url)}); dispatchEvent(new HashChangeEvent('hashchange'))`).catch(() => {});
}
// [widgets] features/widgets.js: fresh data reaches open new-tab pages the same way (batched, as
// several widgets often finish together).
let widgetRefreshTimer = null;
const widgets = createWidgets({
  readSettings, writeSettings,
  fetch: (url, options) => net.fetch(url, options),
  getSecret: widgetSecret,
  setSecret: setWidgetSecret,
  canKeepSecrets: () => safeStorage.isEncryptionAvailable(), // checked before a sign-in starts, not after consent
  // OAuth consent pages (Gmail) open in the user's own browser, never in a Lumen tab; https only.
  openExternal: (url) => { if (!/^https:\/\/accounts\.google\.com\//.test(url)) throw new Error('Refusing to open that address.'); return shell.openExternal(url); },
  spotifyWebSignedIn: () => spotifyWeb.isSignedIn(),
  tradingviewLists: () => (TEST && global.__tvLists ? global.__tvLists() : tradingviewAccountLists()), // tests never reach TradingView
  onUpdate: () => {
    clearTimeout(widgetRefreshTimer);
    widgetRefreshTimer = setTimeout(() => {
      refreshNewTabs();
      for (const t of tabs.filter((x) => x.settings && alive(x))) t.view.webContents.send('widgets:changed'); // Settings shows it too (a sign-in Google ended)
    }, 60);
  },
  t: (key) => t(key),
  focusApp: () => { const w = BrowserWindow.getFocusedWindow() || winRecs.values().next().value?.win; if (w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); app.focus?.({ steal: true }); } },
  // A card's gear (edit mode on the new-tab page): Settings → Appearance opens that widget's editor.
  onConfigure: () => {
    const wc = tabs.find((t) => t.id === openSettingsPage('appearance'))?.view?.webContents;
    if (wc && !wc.isDestroyed() && !wc.isLoading()) wc.reload(); // an open Settings page reads the request when it builds
  },
  // Tests point the connectors at a local server (global.__widgetEndpoints); nothing else can.
  endpoints: () => (TEST && global.__widgetEndpoints) || {},
  rateMax: () => (TEST && global.__widgetRateMax) || 0, // tests that drive many refreshes raise the per-minute cap
});
if (TEST) global.__widgets = widgets;

// [widgets] The user's TradingView watchlists, for the TradingView widget's import and sync: one fixed
// address (features/tradingview-view.js ACCOUNT_URL), GET only, read with the normal session's cookies so
// it answers for the account signed in on tradingview.com in Lumen. No redirects, answer capped at 1 MB.
function tradingviewAccountLists() {
  return new Promise((resolve, reject) => {
    const req = net.request({ url: TVW_ACCOUNT_URL, method: 'GET', session: session.defaultSession, useSessionCookies: true, redirect: 'error', cache: 'no-store' });
    req.setHeader('Accept', 'application/json');
    const timer = setTimeout(() => { req.abort(); reject(new Error('TradingView took too long')); }, 15e3);
    const done = (fn, v) => { clearTimeout(timer); fn(v); };
    req.on('response', (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > 1 << 20) { req.abort(); done(reject, new Error('TradingView sent too much')); } else chunks.push(c); });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) return done(resolve, []); // signed out: no lists
        if (res.statusCode !== 200) return done(reject, new Error(`TradingView answered ${res.statusCode}`));
        try { done(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { done(reject, new Error('TradingView sent something unexpected')); }
      });
      res.on('error', (err) => done(reject, err));
    });
    req.on('error', (err) => done(reject, err));
    req.end();
  });
}
// [widgets] The Spotify widget's Web player (features/spotify-web.js): one persistent view in the normal session.
const spotifyWeb = SW.createSpotifyWeb({
  WebContentsView, get session() { return session.defaultSession; }, isWebUrl, // getter: defaultSession is only usable after app ready
  getWindow: () => win,
  getBounds: () => contentBounds,
  activeNewTab: () => { const t = activeTab(); const tab = tabs.find((x) => x.id === activeId); return t && tab && tab.view.getVisible() && !tab.fullscreen && isNewTab(t.webContents.getURL()) ? t.webContents : null; },
  hasWidget: () => widgets.list().some((w) => w.type === 'spotify' && w.mode === 'web'),
  openTab: (url) => { if (win && !win.isDestroyed()) openTab(url); },
  onSignIn: () => { clearTimeout(widgetRefreshTimer); widgetRefreshTimer = setTimeout(refreshNewTabs, 60); },
});
app.on('before-quit', () => spotifyWeb.destroy());

const settingsBackend = settingsPage.create({
  usage, // [usage] You and AI → Usage
  refreshNewTabs,
  widgets, // [widgets] Settings → Appearance → Widgets
  showWhatsNew: () => whatsNew.open(), // Settings → Updates → What's new
  peekSettings: () => settingsCache || readSettings(), // (the per-request header hook: no copy, no re-validation)
  chromeHintHeaders: UA_HINT_HEADERS, // [identity] Sec-CH-UA on every secure request, as Chrome sends
  chromeHighEntropy: uaHighEntropyHeaders, // [identity] Sec-CH-UA-Arch… for an origin that asked (Accept-CH)
  app, session, nativeTheme, dialog, shell, readSettings, writeSettings, ui,
  win: () => win,
  tabContents: () => tabs.filter((t) => alive(t) && !t.settings).map((t) => t.view.webContents),
  tabsInfo: () => tabs.filter(alive).map((t) => ({ id: t.id, title: t.view.webContents.getTitle(), wc: t.view.webContents, settings: Boolean(t.settings) })),
  history: () => history,
  saveHistory: saveHistorySoon,
  siteActivity,
  downloads: downloads.list,
  sendDownloads: downloads.send,
  permissionDecisions,
  uninstallExtension,
  cliPinnedVersion: () => cliAuth.PINNED_VERSION,
  openTab: (url) => openTab(url),
  isSettingsSender,
  onSearchEngineReset: () => ui()?.send('search-engine', engineFor(DEFAULT_ENGINE)),
  onSafeBrowsingChange: () => { safeBrowsing.refresh().catch(() => {}); },
  performance: perfMode,
});

// One settings tab: reuse it if open. `replace` is a tab (a blank new-tab page) it takes the place of.
function openSettingsPage(section = '', { replace = null } = {}) {
  const url = settingsPage.urlFor(section);
  const existing = tabs.find((t) => t.settings && alive(t));
  if (existing) {
    const wc = existing.view.webContents;
    // A fragment change while the page is still loading crashes its renderer: wait for the load.
    const go = () => { if (!wc.isDestroyed() && wc.getURL() !== url) wc.loadURL(url).catch(() => {}); };
    if (section) { if (wc.isLoading()) wc.once('did-stop-loading', go); else go(); }
    switchTab(existing.id);
    return existing.id;
  }
  const { id } = openTab(url, { settings: true });
  if (replace) takePlace(id, replace);
  return id;
}
// Move tab `id` to where `oldId` is and close `oldId`.
function takePlace(id, oldId) {
  const from = tabs.findIndex((t) => t.id === id);
  const to = tabs.findIndex((t) => t.id === oldId);
  if (from === -1 || to === -1 || id === oldId) return;
  const [tab] = tabs.splice(from, 1);
  tabs.splice(to, 0, tab);
  closeTab(oldId);
}
// The settings tab can't load other pages: an address typed there opens in a normal tab in its place.
function replaceTab(oldId, url) {
  const { id } = openTab(url);
  takePlace(id, oldId);
}
ipcMain.on('settings-page:open', (_e, section) => openSettingsPage(typeof section === 'string' ? section : ''));
if (TEST) {
  global.__settings = { backend: settingsBackend, page: settingsPage, open: openSettingsPage, tabs: () => tabs.filter(alive).map((t) => ({ id: t.id, settings: Boolean(t.settings), url: t.view.webContents.getURL() })), contents: (id) => tabs.find((t) => t.id === id)?.view?.webContents, historyUrls: () => [...history.keys()], permissions: permissionDecisions };
}

ipcMain.on('content-bounds', (_e, bounds) => {
  contentBounds = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
    fullWidth: Math.max(0, Math.round(Number(bounds.fullWidth) || 0)), // the page area's width with the sidebar closed
  };
  if (curRec) { curRec.boundsReported = true; curRec.holdViews = false; } // (a first tab opened while the UI loaded shows now)
  layout();
});

// Each freeze and thaw bumps the window's freeze number. A capture that finishes after a thaw (the
// sidebar settled before the snapshot was ready) must not hide the page: it used to, and nothing thawed
// it again, which left the page area blank (the purple of a running task) until the sidebar moved. The
// flag is also set on the window that asked, not whichever window is current when the capture ends.
// A freeze that is never thawed (a lost message) ends by itself.
const freezeSeq = new WeakMap(); // window rec -> number
let freezeCounter = 0;
// Last resort only: the renderer thaws explicitly at the end of a spring or drag and pings view:freeze-alive while moving.
const FREEZE_MAX_MS = 6000;
const freezeTimers = new WeakMap(); // window rec -> timeout
const snapshotSizer = require('./features/snapshot-size');
function armFreezeTimeout(rec, seq) {
  clearTimeout(freezeTimers.get(rec));
  freezeTimers.set(rec, setTimeout(() => {
    if (freezeSeq.get(rec) !== seq || !rcAlive(rec)) return;
    console.warn(`[lumen] page freeze timed out after ${FREEZE_MAX_MS} ms without a thaw; showing the live page again`);
    freezeSeq.set(rec, ++freezeCounter);
    withWindow(rec, () => { viewFrozen = false; layout(); });
  }, FREEZE_MAX_MS));
}
ipcMain.handle('view:freeze', async (_e, cssSize) => {
  const rec = curRec;
  const wc = activeTab()?.webContents;
  if (!rec || !wc || tabs.find((t) => t.id === activeId)?.fullscreen) return null;
  const seq = ++freezeCounter;
  freezeSeq.set(rec, seq);
  try {
    const image = await wc.capturePage();
    if (image.isEmpty() || freezeSeq.get(rec) !== seq || !rcAlive(rec)) return null; // thawed meanwhile
    withWindow(rec, () => { viewFrozen = true; layout(); });
    armFreezeTimeout(rec, seq);
    // Encoded at the size it is shown (CSS pixels, not device pixels) and sent as bytes: the renderer makes a blob
    // URL from them, so neither side builds or decodes a multi-megabyte base64 string (features/snapshot-size.js).
    const target = snapshotSizer.snapshotSize(image.getSize(), cssSize);
    const shot = target ? image.resize({ width: target.width, height: target.height, quality: 'good' }) : image;
    return shot.toJPEG(snapshotSizer.JPEG_QUALITY);
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
ipcMain.on('view:freeze-alive', () => { // still animating: push the last-resort thaw back
  if (curRec && viewFrozen) armFreezeTimeout(curRec, freezeSeq.get(curRec));
});
ipcMain.on('view:thaw', () => {
  if (curRec) { clearTimeout(freezeTimers.get(curRec)); freezeSeq.set(curRec, ++freezeCounter); } // a capture still in flight won't freeze after this
  viewFrozen = false;
  layout();
});
// Homepage "Ask AI" full-page chat: the UI covers the whole content area, so hide the native view
// instead of resizing it (see chatFullTab above). content-bounds keeps arriving meanwhile — layout()
// just ignores it while this is set, so the two never fight over the view's bounds.
ipcMain.on('chat:full', (_e, on) => {
  chatFullTab = on ? activeId : null;
  layout();
});
// Files dropped on the window (the UI resolves their paths with webUtils; see preload.js).
ipcMain.on('files:open', (_e, paths) => { if (Array.isArray(paths)) openLinksFromOtherApps(fileUrlsFor(paths.slice(0, 20))); });
ipcMain.on('tab:new', (_e, url) => {
  const internal = url && settingsPage.parseSettingsInput(url); // [settings] lumen://settings
  if (internal) openSettingsPage(internal.section);
  else if (chatPage.parseChatInput(url)) chatPageRt.open(); // lumen://chat
  else openTab(url ? resolveInput(url) : undefined);
});
// The UI's and Settings' strings in the system's language (features/i18n.js).
ipcMain.on('ui:strings', (event) => { event.returnValue = { locale: i18n().locale, strings: i18n().strings }; });
ipcMain.handle('settings:strings', () => ({ locale: i18n().locale, strings: i18n().strings }));
if (TEST) global.__i18n = () => i18n(); // test/a11y.js
ipcMain.on('tab:close', (_e, id) => requestCloseTab(id));
ipcMain.on('tab:switch', (_e, id) => switchTab(id));
ipcMain.on('tab:move', (event, id, toIndex, done) => {
  moveTab(id, toIndex);
  // An in-strip drag holds its tab hidden until this: the strip shows it in the slot it landed in.
  if (done) event.sender.send('tab:dragdone');
});
function moveTab(id, toIndex) {
  const from = tabs.findIndex((t) => t.id === id);
  if (from === -1) return;
  const [tab] = tabs.splice(from, 1);
  // Pinned tabs reorder among themselves; a loose tab can't be dropped in among them.
  const pinnedCount = tabs.filter((t) => t.pinned).length;
  const [min, max] = tab.pinned ? [0, pinnedCount] : [pinnedCount, tabs.length];
  tabs.splice(Math.max(min, Math.min(Number(toIndex) || 0, max)), 0, tab);
  if (tab.pinned) { sendTabs(); return; }
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
    const e = tabGroups.entryFor(id);
    if (e && before) organizeLearner.learnRemoval(e, tabGroups.groups.get(before)?.name);
    if (e && target) organizeLearner.learnPlacement(e, tabGroups.groups.get(target)?.name);
    tab.groupId = target;
    tab.userRemoved = !target;
  }
  tab.userMoved = true; // placed by hand: automatic grouping leaves it alone
  manners.handOver(tab); // [ai manners] a tab the user moved is theirs
  tabGroups.cleanup();
  tabGroups.arrange();
  sendTabs();
}
ipcMain.on('bookmark:toggle', toggleBookmark);
ipcMain.on('tab:context-menu', (_e, id, point) => tabMenu(id, point));
ipcMain.on('tab:mute', (_e, id) => { const tab = tabs.find((t) => t.id === id); if (tab) tabTools.setMuted(tab, !tabTools.state(tab, alive(tab)).muted); });
ipcMain.handle('tabsearch:closed', () => tabTools.closedEntries(closedTabs));
ipcMain.handle('tabsearch:reopen', (_e, index, url) => reopenClosed(index, url));
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
  if (group && clean) { organizeLearner.learnRename(group.name, clean, tabGroups.groupEntries(id)); group.name = clean; group.auto = false; group.userNamed = true; } // named by the user: automatic grouping and Organize leave it alone
  sendTabs();
});
ipcMain.on('tabs:organize', organizeTabs);
// The note's one Undo: the merge's, when this window's toast showed it; else the organize's.
ipcMain.on('tabs:undo-organize', (event) => {
  const rec = recOfSender(event.sender);
  if (mergeUndo && (!rec || rec.win.id === mergeUndo.dstId)) undoMerge(); else undoOrganize();
});
// The toolbar button toggles the downloads panel (the ⋯ menu keeps its Downloads submenu).
ipcMain.on('downloads:menu', (_e, anchor) => {
  // A click on the button while the panel is open first blurs (closes) it: that click means close.
  if (downloadsView?.getVisible() || Date.now() - downloadsHiddenAt < 300) { hideDownloadsPanel(); return; }
  const n = (v) => (Number.isFinite(v) ? v : 0);
  showDownloadsPanel({ right: n(anchor?.right ?? anchor?.x), bottom: n(anchor?.bottom ?? anchor?.y) });
});
ipcMain.on('zoom:reset', () => zoomBy(activeTab()?.webContents, 0));
ipcMain.on('nav:go', (_e, text) => {
  const wc = activeTab()?.webContents;
  if (!wc) return;
  userTookOver(tabs.find((t) => t.id === activeId)); // [ai manners] the user navigated this tab
  // [settings] lumen://settings opens the settings tab (in place of a blank new tab); anything typed
  // into the settings tab opens in a normal tab in its place.
  const current = tabs.find((t) => t.id === activeId);
  const internal = settingsPage.parseSettingsInput(text);
  if (internal) { openSettingsPage(internal.section, { replace: !current?.settings && isNewTab(wc.getURL()) ? activeId : null }); return; }
  if (chatPage.parseChatInput(text)) { chatPageRt.open(); return; } // lumen://chat
  if (current?.settings || current?.managerPage === 'chat') { replaceTab(activeId, resolveInput(text)); return; } // the chat page is locked like Settings
  const source = /^\s*view-source:(https?:\/\/\S+)\s*$/i.exec(String(text)); // typed view-source:<url>
  if (source) { pageTools.viewSource(source[1], { wc }); wc.focus(); return; }
  const target = resolveInput(text);
  if (leaveNewTabFor(current, target)) { activeTab()?.webContents.focus(); return; } // (a new-tab page: the page loads in the warm view)
  wc.loadURL(target).catch(() => {});
  wc.focus();
});
function toggleReaderActive() {
  return pageTools.toggleReader(tabs.find((t) => t.id === activeId && alive(t)));
}
ipcMain.on('page:reader', () => { toggleReaderActive(); });
ipcMain.on('translate:act', (_e, action, arg) => translate.act(tabs.find((x) => x.id === activeId && alive(x)), String(action), typeof arg === 'string' ? arg : undefined));
if (TEST) global.__translate = { api: translate, tab: (id) => tabs.find((x) => x.id === id) };
if (TEST) global.__pageTools = { tools: pageTools, toggleReader: toggleReaderActive, tab: (id) => tabs.find((t) => t.id === id), handleShortcut: (input) => handleShortcut({ preventDefault() {} }, { type: 'keyDown', control: false, meta: false, shift: false, alt: false, ...input }), contextMenuItems: (wc, p) => pageTools.videoMenuItems(wc, p, { openTab: () => {}, copy: () => {} }) };
ipcMain.on('nav:back', () => { userTookOver(tabs.find((t) => t.id === activeId)); goBack(activeTab()?.webContents); });
ipcMain.on('nav:forward', () => { userTookOver(tabs.find((t) => t.id === activeId)); activeTab()?.webContents.navigationHistory.goForward(); });
ipcMain.on('nav:reload', reloadActive);

ipcMain.handle('suggest:query', async (_e, query) => { await historyReady; return suggestions(query); }); // (a query in the first moments waits for the past pages)
ipcMain.on('suggest:show', (_e, rect, payload) => showSuggestions(rect, payload));
ipcMain.on('suggest:hide', hideSuggestions);
ipcMain.on('app-menu', (_e, point) => showAppMenu(point));
// The extension icons the toolbar has no room for: listed in a menu under the "..." button; the pick goes back
// to the toolbar, which triggers that extension's action as its icon would.
// A toolbar action with no title of its own is labelled by its extension's manifest name, never the raw id.
const extensionName = (id) => {
  let name = '';
  try { name = String(session.defaultSession.extensions.getExtension(id)?.name || ''); } catch { /* gone */ }
  return name.slice(0, 80) || t('extension.fallbackName');
};
ipcMain.on('actions:overflow', (_e, point, items) => {
  const list = (Array.isArray(items) ? items : []).filter((i) => i && typeof i.id === 'string' && typeof i.title === 'string').slice(0, 60);
  if (!list.length || !win || win.isDestroyed()) return;
  const n = (v) => (Number.isFinite(v) ? Math.round(v) : 0);
  const menu = Menu.buildFromTemplate(list.map((i) => ({ label: i.title.slice(0, 80) || extensionName(i.id), click: () => ui()?.send('actions:overflow-pick', i.id) })));
  menu.popup({ window: win, x: n(point?.x), y: n(point?.y) });
});
ipcMain.on('suggest:pick', (_e, index, listId) => ui()?.send('suggest:picked', { index, listId }));

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

const tabsAsk = require('./features/tabs-ask');
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
ipcMain.on('agent:ask', (event, text, runId, images = [], tabIds = []) => {
  const valid = (Array.isArray(images) ? images : [])
    .filter((img) => IMAGE_TYPES.has(img?.media_type) && typeof img.data === 'string' && img.data.length < 7_000_000 && /^[A-Za-z0-9+/]+=*$/.test(img.data))
    .slice(0, 5);
  syncToSender(event); // [chat per tab] the chat of the tab this was typed in
  // [background chats] The run belongs to the chat it started in, wherever the user goes meanwhile:
  // another tab, another window, a closed sidebar or another chat (switchChat leaves it running).
  const runChat = chatId;
  const messages = agent.messages;
  const hosts = agent.approvedHosts;
  const askText = String(text || '');
  const fromChatPage = chatPageRt.isChatSender(event);
  // [chat per tab] Starting a chat in a tab binds it there: its tools act on this tab, not on whichever is in front later.
  const homeTab = fromChatPage ? null : activeId;
  if (homeTab != null) chatBind.bind(homeTab, runChat);
  const run = { chatId: runChat, messages, runId, rec: curRec, sender: event.sender, pending: new Map(), reply: '', error: null, stopped: false, deleted: false, tabId: null, queued: false, homeTab, text: askText, waitReason: null };
  chatRuns.set(runChat, run);
  unreadChats.delete(runChat);
  const isOpen = () => runChat === chatId && run.messages === agent.messages;
  const to = () => (run.sender && !run.sender.isDestroyed() ? run.sender : event.sender);
  chatPageRt.beginRun(event, { text: askText, runId, images: valid }); // pins a chat-page run to the tab last looked at; the other view mirrors it
  const finishQueued = () => { // a run that never got a slot (stopped, or its chat deleted while it waited)
    runSlots.cancel(runChat);
    if (chatRuns.get(runChat) === run) chatRuns.delete(runChat);
    run.queued = false;
    run.stopped = true;
    if (chatPageRt.runs.get()?.runId === runId) chatPageRt.endRun();
    chatPageRt.emit(to(), 'agent:event', { type: 'notice', text: 'Stopped.', stopped: true, runId });
    chatPageRt.emit(to(), 'agent:event', { type: 'done', runId });
    pushAttention();
  };
  run.cancelQueued = finishQueued;
  const emit = (msg) => {
    let aiTabs = null; // [ai manners] the tabs this run opened that can still be closed (under the reply, or closed by the setting)
    if (msg.type === 'done' && !run.deleted) { aiTabs = aiTabsAfterRun(runId); if (aiTabs) msg = { ...msg, aiTabs }; }
    if (msg.type !== 'text' && msg.type !== 'thinking') setImmediate(pushAgentTarget); // the run's tab pinned, moved or gone
    if (msg.type !== 'text' && msg.type !== 'thinking') run.tabId = agent.runTabIdFor(run.messages) ?? run.tabId; // kept for the end (the scope is gone by 'done')
    if (msg.type === 'text') run.reply += msg.text;
    else if (msg.type === 'tool' || msg.type === 'retry') run.reply = ''; // the reply is what comes after the last step
    else if (msg.type === 'error') run.error = msg.text || 'error';
    else if (msg.type === 'notice' && msg.text === 'Stopped.') run.stopped = true;
    if (msg.type === 'approval') { run.pending.set(msg.approvalId, msg); tellUser(run, 'approval'); }
    else if (msg.type === 'approval_done' && run.pending.delete(msg.approvalId)) pushAttention();
    if (msg.type === 'done') {
      const mine = chatRuns.get(runChat) === run;
      if (mine) chatRuns.delete(runChat);
      if (mine) runSlots.release(runChat); // the next chat in line may start
      if (chatPageRt.runs.get()?.runId === runId) chatPageRt.endRun();
    }
    chatPageRt.emit(to(), 'agent:event', { ...msg, runId }); // whoever asked, and the other view when a chat page is open (a chat left running is ignored there by its run id)
    if (msg.type === 'done') {
      if (!run.deleted) (isOpen() ? saveChat() : saveChatOf(runChat, run.messages));
      tellUser(run, chatRunsLib.outcome(run));
      setImmediate(pushAgentTarget);
      if (aiTabs?.mode === 'close') { // Settings > "Close tabs the AI opened when it finishes": Always
        aiTabsClose({ runId }, { auto: true }).then(({ closed, token }) => chatPageRt.emit(to(), 'agent:event', { type: 'ai_tabs_closed', runId, n: closed, token })).catch(() => {});
      }
    } else if (msg.type === 'tool_done' && !run.deleted) (isOpen() ? saveChatSoon(chatGeneration) : saveChatOfSoon(runChat, run.messages));
    else if (msg.type === 'usage' && isOpen()) { ui()?.send('chats:usage', describeUsage(msg.usage)); chatPageRt.broadcast('chats:usage', describeUsage(msg.usage), ui()); }
    else if (msg.type === 'error' && msg.signInExpired) { cliLoginValid = false; client = null; ui()?.send('models-updated'); }
  };
  const skillRun = skillsFeature.takeRun(askText);
  const tabsPicked = tabsAsk.cleanIds(tabIds);
  const start = () => {
    if (run.deleted) { runSlots.release(runChat); return; }
    const wasQueued = run.queued;
    run.queued = false;
    if (wasQueued) chatPageRt.emit(to(), 'agent:event', { type: 'status', text: '', runId }); // the waiting line goes
    const tabId = fromChatPage ? undefined : runHomeTab(run); // [chat per tab] where this chat is bound, not the tab in front now
    // tabIds: the tabs the user picked with "@" (features/tabs-ask.js); a skill run (features/skills.js) carries its mode and model
    agent.run(askText, emit, valid, { tabs: tabsPicked, tabId, messages, hosts, meta: { rec: run.rec, chatId: runChat, runId } }, skillRun);
    pushAttention(); // the chat list shows it running
  };
  // [chat per tab] How many chats may work at once is a setting; the next waits its turn. Claude Code and Grok Build
  // take turns one chat at a time (their tools reach Lumen through one connection that finds its run through one pin).
  runSlots.setMax(readSettings().maxChatRuns);
  const kind = tabChatsLib.slotKind(messages.settings?.model || effectiveModel());
  if (runSlots.request(runChat, { kind, start }) === 'queued') {
    run.queued = true;
    run.waitReason = runSlots.reason(runChat);
    chatPageRt.emit(to(), 'agent:event', { type: 'status', text: waitingText(run), runId });
    pushAttention(); // the tab and the chat list show it waiting
  }
});
// The tabs the "@" picker offers: this window's readable tabs, never a private window's.
ipcMain.handle('tabs:ask-list', (event) => {
  if (!syntheticTestEvent(event) && !recOfSender(event?.sender)) return []; // a private window's UI is in no window record
  return askTabsList()
    .filter((t) => tabsAsk.ineligible({ ...t, aiOff: aiSites.isOff(t.url) }) === null)
    .map((t) => ({ id: t.id, title: t.title, host: hostOf(t.url) || t.url, favicon: t.favicon, active: t.active, sleeping: t.sleeping }));
});
// Stops a chat's run: one waiting for a slot leaves the line, one working is aborted. `id`: any chat (the chat list's
// "Stop waiting"); none: the open chat (the Stop button).
function stopChat(id) {
  const run = chatRuns.get(id);
  if (!run || run.deleted) return false;
  if (run.queued) run.cancelQueued();
  else agent.stopFor(run.messages);
  return true;
}
ipcMain.on('agent:stop', (event, id) => {
  if (typeof id === 'string' && id) { stopChat(id); return; }
  syncToSender(event);
  const run = chatRuns.get(chatId);
  if (run?.queued) run.cancelQueued(); // it never started: leaves the waiting line
  else agent.stop();
});
// "Working in: …" in the sidebar: jump to the tab the task works in.
ipcMain.on('agent:show-target', (event) => { syncToSender(event); const id = agent.runTabId(); const rec = runRecNow(); if (id != null && agent.running) (rec ? withWindow(rec, () => switchTab(id)) : switchTab(id)); });
// New chat: the open chat stays in the history list.
ipcMain.handle('agent:rewind', (_e, expected) => {
  syncToSender(_e);
  if (agent.runningFor(agent.messages) || chatRuns.get(chatId)?.queued) return false; // never mid-run
  const result = agent.rewindLast(typeof expected === 'string' ? expected : '');
  if (result === 'rewound') { saveChatSoon(chatGeneration); chatPageRt.broadcast('chat:sync', { view: chatView() }, _e.sender); } // the other view drops it too
  return result;
});
ipcMain.on('agent:reset', (event) => {
  syncToSender(event);
  switchChat(null);
  chatBind.bind(activeId, chatId); // [chat per tab] the tab shows its new chat; the old one stays in the list (and keeps working if it is)
  if (event.sender && !event.sender.isDestroyed()) shownChat.set(event.sender, chatId);
  pushAttention();
  chatPageRt.broadcast('chat:sync', { view: chatView() }, event.sender);
});

// ---- the sidebar's chat history list (features/chat-store.js)
// [chat per tab] Where a chat lives: the tab it is bound to (or, while it works, the tab it works in).
// { id, title, here } ('here': it is the tab in front), or null.
function chatPlaceOf(id) {
  const working = chatRuns.get(id);
  const bound = chatBind.tabsOf(id);
  const pinned = working && !working.queued ? agent.runTabIdFor(working.messages) : null;
  const candidates = [...(pinned != null ? [pinned] : []), ...bound.slice().reverse()];
  const tabId = candidates.includes(activeId) ? activeId : candidates.find((tid) => tabAnywhere(tid));
  if (tabId == null) return null;
  const found = tabAnywhere(tabId);
  if (!found) return null;
  return { id: tabId, title: withWindow(found.rec, () => tabTitle(found.t)) || '', here: tabId === activeId && found.rec === curRec, place: tabChatsLib.chatPlace({ tabId, here: tabId === activeId && found.rec === curRec }) };
}
ipcMain.handle('chats:list', (event) => {
  syncToSender(event);
  return {
    current: chatId,
    currentUsage: describeUsage(agent.messages.settings?.usage),
    maxRuns: runSlots.limit,
    chats: (() => {
      const badges = chatBadges();
      return chats().list().map((c) => ({ id: c.id, title: c.title, created: c.created, updated: c.updated, usage: describeUsage(c.usage), badge: badges.get(c.id) || null, tab: chatPlaceOf(c.id), aiTabs: aiTabSelect({ chatId: c.id }).length }));
    })(),
  };
});
// "Move chat to this tab" (and opening a chat that lives in no tab): the chat now belongs to the tab in front.
ipcMain.handle('chats:open', (event, id) => {
  syncToSender(event);
  const view = switchChat(String(id));
  if (view) {
    bindOpenChatHere(event.sender);
    chatPageRt.broadcast('chat:sync', { view }, event.sender); // the other view shows the chat that was opened
  }
  return view;
});
// "Open chat in its tab": show the tab the chat lives in (its window comes to the front).
ipcMain.handle('chats:show-tab', (event, id) => {
  id = String(id);
  const place = (() => {
    const working = chatRuns.get(id);
    const pinned = working && !working.queued ? agent.runTabIdFor(working.messages) : null;
    for (const tid of [...(pinned != null ? [pinned] : []), ...chatBind.tabsOf(id).slice().reverse()]) { const f = tabAnywhere(tid); if (f) return { tid, ...f }; }
    return null;
  })();
  if (!place) return false;
  withWindow(place.rec, () => { switchTab(place.tid); });
  if (rcAlive(place.rec)) { if (place.rec.win.isMinimized()) place.rec.win.restore(); place.rec.win.focus(); }
  return true;
});
ipcMain.handle('chats:rename', (_e, id, title) => chats().rename(String(id), String(title ?? '')));
// Deleting the open chat leaves an empty one in its place.
ipcMain.handle('chats:delete', (event, id) => {
  id = String(id);
  approvedByChat.delete(id);
  unreadChats.delete(id);
  const running = chatRuns.get(id); // deleting a chat that is still running stops it, and it isn't saved again
  if (running) {
    running.deleted = true;
    if (running.queued) { running.cancelQueued?.(); chatRuns.delete(id); } else agent.stopFor(running.messages);
    clearTimeout(detachedSaves.get(id));
  }
  chatBind.unbindChat(id); // [chat per tab]
  if (id === chatId) {
    chatGeneration++;
    clearTimeout(saveChatTimer);
    agent.reset();
    chatId = chats().newId();
    chatBind.bind(activeId, chatId);
    chats().remove(id);
    chatPageRt.broadcast('chat:sync', { view: chatView() }, event.sender);
    return { cleared: true, view: chatView() };
  }
  return { cleared: false, removed: chats().remove(id) };
});
// The chat as Markdown (the open one as it is now, or a saved one), or null if it's empty.
function chatMarkdown(id) {
  const snapshot = id === chatId ? chatSnapshot() : chats().load(id);
  if (!snapshot?.messages?.length) return null;
  const entry = chats().list().find((c) => c.id === id);
  const title = entry?.title || autoTitle(snapshot);
  const markdown = toMarkdown({ title, created: entry?.created, model: snapshot.settings?.model, usageLine: describeUsage(snapshot.settings?.usage) }, transcriptFor(snapshot.messages));
  return { title, markdown };
}
// Export: always the user's own click in the sidebar (a UI-only channel), and always through a
// save dialog, so nothing is written anywhere the user didn't pick.
ipcMain.handle('chats:export', async (_e, id) => {
  const out = chatMarkdown(String(id));
  if (!out) return { ok: false, reason: 'empty' };
  const fileName = `${cleanTitle(out.title).replace(/[\\/:*?"<>|]/g, '').slice(0, 60).trim() || 'Chat'}.md`;
  const { canceled, filePath } = await electronDialog.showSaveDialog(win, {
    title: t('dialog.exportChat.title'),
    defaultPath: path.join(app.getPath('documents'), fileName),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (canceled || !filePath) return { ok: false, reason: 'canceled' };
  await fs.promises.writeFile(filePath, out.markdown, 'utf8');
  return { ok: true, filePath };
});
if (TEST) global.__chats = { store: chats, id: () => chatId, markdown: (id) => chatMarkdown(id)?.markdown ?? null };
ipcMain.on('agent:approve', (_e, approvalId, ok) => agent.resolveApproval(approvalId, ok));
// [ai controls] "Undo" under a reply: takes back what that run changed in the tabs.
ipcMain.handle('agent:undo', (_e, runId) => agent.undoRun(runId));
aiSites.register(ipcMain);
// Auto-allow actions (the sidebar's switch): the sidebar's AI clicks and types on any site without
// the "Allow … to interact" card. Stored as askBeforeActing: false (see autoApprove above).
ipcMain.handle('agent:auto-allow', (_e, on) => {
  if (typeof on === 'boolean') writeSettings({ ...readSettings(), askBeforeActing: !on });
  return readSettings().askBeforeActing === false;
});

// The model the picker shows and the agent uses: one answer, so they can never disagree. A saved
// model that isn't connected anymore (key removed, CLI gone) falls back to the first connected
// option, or none (null) — never a model the user can't use. A saved Claude Code / Grok Build pick
// is kept while Lumen is still looking for that CLI at startup.
// Gemini CLI was replaced by Antigravity (Google's own successor to it): a saved pick of the old CLI moves to Antigravity once, and the
// first Antigravity reply says so (agent.js antigravityTurn, via takeNotice).
function migrateGeminiCli(model) {
  if (!/^(geminicli|gemini-cli|gemini_cli):/.test(String(model))) return model;
  writeSettings({ ...readSettings(), model: 'antigravity:default', antigravitySidebar: true, antigravityNotice: true });
  return 'antigravity:default';
}
function effectiveModel(preferred = readSettings().model) {
  preferred = migrateGeminiCli(preferred);
  const options = modelOptions().filter((o) => o.id !== 'openrouter:__more');
  // Any OpenRouter model counts once there is a key: "More models…" can pick ones not in the short list.
  const openRouterPick = /^openrouter:[\w.-]+\/[\w.:-]+$/.test(String(preferred)) && Boolean(providerKey('openrouter'));
  if (options.some((o) => o.id === preferred) || openRouterPick || aiAgents.engineDetecting(preferred)) return preferred;
  // Nothing picked yet (or it's gone): the default model when it's connected, else the first one.
  return options.find((o) => o.id === DEFAULT_MODEL)?.id || options[0]?.id || null;
}

ipcMain.handle('settings:get', () => {
  const options = modelOptions();
  const model = effectiveModel();
  // [model fallback] While the picked model cools down, the picker shows the model that is really answering, marked as temporary.
  const standIn = fallbackOn() ? aiFallback.resolve({ preferred: model, options, cooldowns: aiFallback.shared }) : { from: null };
  return {
    hasStoredKey: Boolean(storedApiKey()),
    hasEnvKey: Boolean(process.env.ANTHROPIC_API_KEY),
    providerKeys: Object.fromEntries(Object.keys(providers.PROVIDERS).map((p) => [p, {
      label: providers.PROVIDERS[p].label,
      stored: Boolean(readSettings().keys?.[p]),
      env: Boolean(process.env[ENV_KEYS[p]]),
    }])),
    adhdMode: readSettings().adhdMode !== false,
    autoGroupTabs: groupingMode() !== 'off',
    tabGrouping: groupingMode(),
    topicAi: readSettings().topicAi === true,
    organizeWhenIdle: readSettings().organizeWhenIdle !== false,
    organizeDelaySeconds: organizeLearn.organizeDelay(readSettings().organizeDelaySeconds),
    organizeLearned: organizeLearner.size(),
    searchEngine: readSettings().searchEngine || DEFAULT_ENGINE,
    searchEngines: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, label: e.label, url: e.url })),
    model: standIn.from ? standIn.model : model,
    fallback: standIn.from ? { from: aiFallback.nameOf(standIn.from, options), to: aiFallback.nameOf(standIn.model, options), until: standIn.until } : null,
    autoFallback: fallbackOn(),
    models: options,
    // For the empty sidebar's "get started" card: nothing to answer with unless some model is connected.
    ready: Boolean(model),
    claudeCode: options.some((o) => o.id === 'claudecode:default'),
    grokBuild: aiAgents.cliStatus().grokbuild, // { installed, signedIn, enabled }: the setup card offers it once found
    antigravity: aiAgents.cliStatus().antigravity, // same, for Antigravity (which replaces Gemini CLI)
  };
});
ipcMain.handle('settings:use-grok-build', () => aiAgents.useGrokBuild());
ipcMain.handle('settings:use-antigravity', () => aiAgents.useAntigravity());
// A key is checked with the provider before it's saved, so a typo shows up here, not as an error on
// the first message. Offline (can't check), it's saved anyway, and the caller is told so.
// Safe Browsing's status and key, for the settings page's Privacy section. The key is kept
// encrypted like the AI keys, and never logged.
ipcMain.handle('settings:safe-browsing', () => ({ ...safeBrowsing.status(), keyStored: Boolean(readSettings().keys?.safebrowsing), keyEnv: Boolean(process.env.GOOGLE_SAFE_BROWSING_API_KEY) }));
ipcMain.handle('settings:set-safe-browsing-key', async (_e, key) => {
  const settings = readSettings();
  const keys = { ...(settings.keys || {}) };
  const value = typeof key === 'string' ? key.trim() : '';
  if (value) {
    if (!/^[\w-]{10,200}$/.test(value)) throw new Error("That doesn't look like a Google API key.");
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable; set GOOGLE_SAFE_BROWSING_API_KEY instead.');
    keys.safebrowsing = safeStorage.encryptString(value).toString('base64');
  } else {
    delete keys.safebrowsing;
  }
  writeSettings({ ...settings, keys });
  await safeBrowsing.refresh().catch(() => {});
  return { ...safeBrowsing.status(), keyStored: Boolean(keys.safebrowsing), keyEnv: Boolean(process.env.GOOGLE_SAFE_BROWSING_API_KEY) };
});
ipcMain.handle('settings:set-provider-key', async (_e, provider, key) => {
  if (!providers.PROVIDERS[provider]) return false;
  let unverified = false;
  if (key) {
    const check = await providers.checkKey(provider, String(key).trim());
    if (check.ok === false) throw new Error(check.message);
    unverified = check.ok === null;
  }
  saveProviderKey(provider, key);
  await refreshModels(provider);
  return unverified ? { ok: true, unverified: true } : true;
});
// ---- OpenRouter: the full model list for "More models…", and "Sign in with OpenRouter" (OAuth PKCE:
// openrouter.ai asks the user, then redirects to a one-time loopback address with a code that is
// exchanged for a key; the key is stored encrypted like a pasted one).
ipcMain.handle('openrouter:models', async () => {
  const { models } = await providers.openRouterCatalog({ cacheFile: OPENROUTER_CACHE(), onRefresh: () => refreshModels('openrouter') });
  return models.map(({ id, name, tools, context, pricePerM, free }) => ({ id, name, tools, context, pricePerM, free }));
});
function saveProviderKey(provider, key) {
  const settings = readSettings();
  const keys = { ...(settings.keys || {}) };
  if (key) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error(`OS encryption is unavailable; set ${ENV_KEYS[provider]} instead.`);
    keys[provider] = safeStorage.encryptString(String(key).trim()).toString('base64');
  } else {
    delete keys[provider];
  }
  writeSettings({ ...settings, keys });
}
// Ends a sign-in that is waiting, from the Cancel button (or a second click).
let cancelOpenRouterSignIn = null;
ipcMain.handle('openrouter:cancel', () => { cancelOpenRouterSignIn?.(); return true; });
ipcMain.handle('openrouter:sign-in', () => new Promise((resolve) => {
  cancelOpenRouterSignIn?.(); // one sign-in at a time
  const crypto = require('crypto');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  let authTab = null;
  let done = false;
  const finish = (result) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    unwatch();
    cancelOpenRouterSignIn = null;
    server.close();
    if (authTab && tabs.some((t) => t.id === authTab)) setTimeout(() => { if (tabs.some((t) => t.id === authTab)) closeTab(authTab); }, 1200);
    resolve(result);
  };
  cancelOpenRouterSignIn = () => finish({ ok: false, cancelled: true, message: t('openrouter.cancelled') });
  // Closing the sign-in tab (or it failing to load, offline, and the user closing it) cancels at
  // once (onTabGone), instead of leaving the button disabled until the 5-minute timeout.
  let unwatch = () => {}; // set once the tab exists
  const server = require('http').createServer(async (req, res) => {
    const code = new URL(req.url, 'http://127.0.0.1').searchParams.get('code');
    if (!code) { res.writeHead(404).end(); return; }
    try {
      const r = await net.fetch(`${providers.PROVIDERS.openrouter.baseURL}/auth/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...providers.PROVIDERS.openrouter.headers },
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.key) throw new Error(body?.error?.message || `HTTP ${r.status}`);
      saveProviderKey('openrouter', body.key);
      await refreshModels('openrouter');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<title>Signed in</title><body style="font:15px system-ui;padding:40px">Signed in to OpenRouter. You can close this tab.</body>');
      finish({ ok: true });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }).end('<title>Sign-in failed</title><body style="font:15px system-ui;padding:40px">OpenRouter sign-in failed. Close this tab and try again.</body>');
      finish({ ok: false, message: t('openrouter.failed', { error: err.message }) });
    }
  });
  const timer = setTimeout(() => finish({ ok: false, message: t('openrouter.timeout') }), 5 * 60 * 1000);
  server.on('error', (err) => finish({ ok: false, message: t('openrouter.cantStart', { error: err.message }) }));
  server.listen(0, '127.0.0.1', () => {
    const callback = `http://127.0.0.1:${server.address().port}/callback`;
    const url = `https://openrouter.ai/auth?${new URLSearchParams({ callback_url: callback, code_challenge: challenge, code_challenge_method: 'S256', key_label: 'Lumen' })}`;
    authTab = openTab(url).id;
    if (!done) unwatch = onTabGone(authTab, () => cancelOpenRouterSignIn?.());
  });
}));

// ---- Spotify widget sign-in (OAuth Authorization Code + PKCE, no client secret): the user's own Client
// ID, Spotify asks in an ordinary tab, then redirects to the registered loopback address with a code.
// features/widgets.js trades the code for tokens and stores the refresh token encrypted (widgetSecret).
let cancelSpotifySignIn = null;
ipcMain.handle('spotify:cancel', () => { cancelSpotifySignIn?.(); return true; });
ipcMain.handle('spotify:disconnect', () => widgets.spotifyDisconnect());
ipcMain.handle('spotify:sign-in', (_event, clientId) => new Promise((resolve) => {
  cancelSpotifySignIn?.(); // one sign-in at a time
  let session;
  try { session = widgets.spotifyStart(clientId); } catch (err) { resolve({ ok: false, message: err.message }); return; }
  let authTab = null;
  let done = false;
  const finish = (result) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    unwatch();
    cancelSpotifySignIn = null;
    server.close();
    if (authTab && tabs.some((x) => x.id === authTab)) setTimeout(() => { if (tabs.some((x) => x.id === authTab)) closeTab(authTab); }, 1200);
    resolve(result);
  };
  cancelSpotifySignIn = () => finish({ ok: false, cancelled: true, message: t('spotify.cancelled') });
  // Closing the sign-in tab cancels at once, instead of waiting for the 5-minute timeout.
  let unwatch = () => {}; // set once the tab exists
  const page = (title, text) => `<title>${title}</title><body style="font:15px system-ui;padding:40px">${text}</body>`;
  const server = require('http').createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
    if (url.searchParams.get('state') !== session.state) { res.writeHead(400).end(); return; } // not our sign-in: ignore, keep waiting
    if (url.searchParams.get('error')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Not connected', 'Spotify was not connected. You can close this tab.'));
      finish({ ok: false, cancelled: true, message: t('spotify.cancelled') });
      return;
    }
    try {
      await session.exchange(url.searchParams.get('code'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Connected', 'Spotify is connected to Lumen. You can close this tab.'));
      finish({ ok: true, message: t('spotify.connected') });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Sign-in failed', 'Spotify sign-in failed. Close this tab and try again.'));
      finish({ ok: false, message: t('spotify.failed', { error: err.message }) });
    }
  });
  const timer = setTimeout(() => finish({ ok: false, message: t('spotify.timeout') }), 5 * 60 * 1000);
  server.on('error', (err) => finish({ ok: false, message: t(err.code === 'EADDRINUSE' ? 'spotify.portBusy' : 'spotify.cantStart', { error: err.message, port: SPOTIFY_REDIRECT_PORT }) }));
  server.listen(SPOTIFY_REDIRECT_PORT, '127.0.0.1', () => { authTab = openTab(session.url).id; if (!done) unwatch = onTabGone(authTab, () => cancelSpotifySignIn?.()); });
}));

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
    if (result.ok) { cliLoginValid = null; ui()?.send('models-updated'); }
    return { ...(await cliStatus()), ok: result.ok, cancelled: Boolean(result.cancelled), message: result.ok ? '' : result.message || 'Sign-in did not complete.' };
  } catch (err) {
    return { ...(await cliStatus()), ok: false, message: err.message };
  }
});
ipcMain.handle('cli:cancel', () => cliAuth.cancelLogin());
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
  // Any OpenRouter model can be picked from "More models…" once there is a key.
  const pickedFromMore = /^openrouter:[\w.-]+\/[\w.:-]+$/.test(String(id)) && Boolean(providerKey('openrouter'));
  if (id === 'openrouter:__more' || (!pickedFromMore && !modelOptions().some((o) => o.id === id))) return false;
  const s = readSettings();
  // The last few OpenRouter models picked from its catalog stay in the short list, so switching between them is one click.
  const curatedPick = modelOptions().some((o) => o.id === id && !o.recent);
  const recentOpenRouter = pickedFromMore && !curatedPick ? [id.slice('openrouter:'.length), ...(s.recentOpenRouter || []).filter((m) => m !== id.slice('openrouter:'.length))].slice(0, 4) : s.recentOpenRouter;
  writeSettings({ ...s, model: id, ...(recentOpenRouter ? { recentOpenRouter } : {}) });
  aiFallback.shared.clear(id); // [model fallback] picking a model by hand (the original, after a switch) means try it now: no cooldown
  modelsChanged(); // every sidebar, chat page and Settings shows the new pick
  // Mid-reply the switch waits for the next message (agent.setModel); the sidebar says so.
  return agent.setModel(id) ? 'next-message' : true;
});
ipcMain.handle('settings:set-auto-group', (_e, on) => setAutoGroup(on));
ipcMain.handle('settings:set-tab-grouping', (_e, mode) => setTabGrouping(mode));
ipcMain.handle('settings:set-topic-ai', (_e, on) => { writeSettings({ ...readSettings(), topicAi: Boolean(on) }); return true; });
ipcMain.handle('settings:set-organize-idle', (_e, on) => { writeSettings({ ...readSettings(), organizeWhenIdle: Boolean(on) }); return true; });
ipcMain.handle('settings:forget-organize-learning', () => { organizeLearner.reset(); return organizeLearner.size(); });
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
  // Every other provider's key-save calls refreshModels(), which sends this; Anthropic's own key
  // has no such step (no model list to fetch), so it needs its own nudge — otherwise the picker and
  // "Set up an AI" card would stay stuck on the old (dis)connected state until something else refreshed them.
  ui()?.send('models-updated');
  return true;
});

// ---------- AI agents over MCP and CDP, and the Claude Code engine (features/ai-agents.js) ----------

const aiAgents = setupAiAgents({
  app, ipcMain, agent, readSettings, writeSettings, ui, automationPlan, isWebUrl, openTab, closeTab, switchTab,
  tools: EXTERNAL_TOOLS,
  validateToolInput,
  isSettingsSender: (event) => syntheticTestEvent(event) || isSettingsSender(event), // Antigravity's install button answers only the settings page
  // Not the settings tab: its page API manages keys and saved passwords ([passwords]).
  userTabs: () => tabs.filter((t) => alive(t) && !t.settings).map((t) => ({ id: t.id, webContents: t.view.webContents })),
});

// ---------- updates from GitHub Releases (features/updates.js) ----------

const updates = require('./features/updates').createUpdates({
  app, ipcMain, session, ui, readSettings, writeSettings, test: TEST, t,
  prefs: () => settingsBackend.prefs(),
  startupDelayMs: () => perfMode.limits().startupDelayMs,
  beforeInstall: () => { saveSession(); saveChat(); }, // the installer may close Lumen before its windows do
});
if (TEST) global.__updates = updates;
app.on('will-quit', () => updates.applyOnQuit()); // a downloaded update installs when the user just quits

const focusWindow = () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.focus();
};
const singleInstance = process.argv.includes('--install-shortcuts') || instance.acquireInstanceLock(app);
if (!singleInstance) app.quit();
// Opening the shortcut again focuses the running browser (two copies would overwrite each other's
// files); a link opened from another app while Lumen runs comes the same way, and opens in a tab.
app.on('second-instance', (_e, argv) => { focusWindow(); openLinksFromOtherApps(linksIn(argv)); });

app.whenReady().then(async () => {
  perf.mark('ready');
  // The drag card's window, made once things are quiet, so the first tear-off of a session shows it at once.
  setTimeout(() => { if (!TEST_BACKGROUND) dragCardWindow(); }, 8000);
  if (process.argv.includes('--install-shortcuts')) {
    instance.installShortcuts(app, shell, APP_ID);
    app.quit();
    return;
  }
  if (!singleInstance) return;
  // Widevine CDM for DRM video (castlabs ECS build only; `components` is undefined on stock
  // Electron). It installs in the background: the window no longer waits for it (a first run
  // showed nothing for up to 10 s). Pages that need DRM before it's ready can simply be reloaded.
  components?.whenReady()
    .then(() => { if (process.env.LUMEN_DEBUG) console.log('Widevine components status:', components.status()); })
    .catch((err) => console.error('Widevine component install failed (continuing without it):', err));
  instance.listenForSecondInstances(app, focusWindow);
  setTimeout(() => instance.fixShortcutIcons(app, shell), 10000).unref?.(); // (~150 .lnk files read: never before the first window)
  instance.fixAppName(app); // Explorer says Lumen, not Electron
  aiAgents.start({ after: firstTabLoaded }); // MCP server, CDP automation (if on), Claude Code detection (once the first tab has loaded)
  settingsBackend.start(ipcMain); // [settings] theme, spell check, proxy, request headers, prefs:* IPC
  setupPermissions();
  downloads.load(); // the list from last time (downloads.json)
  usage.load(); // [usage] the log from earlier sessions (usage.json)
  bgTasks.init(); // background tasks: restore them and start the scheduler
  downloads.setup();
  siteActivity.watch(session.defaultSession);
  loadChat();
  loadHistory();
  // Until the ad blocker takes over onBeforeRequest (it sends pages to the same gate), or if it
  // fails to start, pages still go through Safe Browsing's check.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => safeBrowsing.gate(details, callback));
  safeBrowsing.refresh().catch(() => {});
  // Filter lists: from the cache they load in a moment, so tabs wait for them (restored tabs would
  // otherwise load unfiltered, and without the document-start scriptlets). The first run's download
  // doesn't hold up the window. They load while the extensions start (the two don't depend on each other).
  // Extensions must be ready before tabs exist so every tab is registered with chrome.tabs; the window itself
  // (its UI, ~0.5 MB of scripts) loads meanwhile, and its tabs come once both are ready (tabsGate).
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(__dirname, 'assets', 'icon.png'));
  crashRecovery.begin({ mode: settingsBackend.startupPlan().mode }); // (before the first window saves a session over the last run's)
  setAboutPanel();
  createWindow(); // (first: the ad blocker's and extensions' code loads while the window's UI does)
  const extending = setupExtensions().catch((err) => console.error('Extension support failed to start:', err));
  const blocking = adblock.setup().catch((err) => console.error('Ad blocker failed to start:', err));
  // (Neither holds the tabs back more than 3 s: a stuck start must not leave a window with no tabs.)
  const atMost = (p) => Promise.race([p, new Promise((r) => setTimeout(r, 3000))]);
  await atMost(Promise.all([extending, fs.existsSync(path.join(app.getPath('userData'), 'adblock-engine.bin')) ? blocking : null]));
  perf.mark('adblockReady');
  openTabsGate();
  perfMode.later(() => { for (const provider of Object.keys(providers.PROVIDERS)) if (providerKey(provider)) refreshModels(provider); }); // model lists: nothing waits for them
  setTimeout(markFirstTabLoaded, 8000).unref?.(); // (a first tab that never finishes doesn't hold these back)
  firstTabLoaded.then(() => { makeSpareNewTab(); warmSoon(400); }); // a new-tab page ready for the first Ctrl+T, and a renderer for the first web page, once the first tab has loaded
  perfMode.start(); // Performance mode: power events, and whether the GPU really draws
  setTimeout(() => perfMode.checkGpu(), 5000).unref?.(); // the GPU process has reported by now
  updates.start(); // first check after a short delay (longer in Performance mode), then every few hours
});
// On macOS the app stays running with no windows, and clicking the Dock icon opens one again.
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || !settingsBackend.prefs().keepRunningInBackground) app.quit(); }); // [settings]
// ---- [mac reopen] Clicking the Dock icon after the window closed builds a new window: the old
// tab and panel views were attached to the dead one, so drop them and restore the saved session.
function dropDeadWindowViews() {
  for (const tab of tabs) if (alive(tab)) tab.view.webContents.close();
  tabs = [];
  activeId = null;
}
app.on('activate', () => {
  if (app.isReady() && singleInstance && (!win || win.isDestroyed())) {
    dropDeadWindowViews();
    createWindow();
  }
});
if (TEST) global.__dropDeadWindowViews = dropDeadWindowViews;
// ---- [/mac reopen]
