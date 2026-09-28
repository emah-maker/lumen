const { app, BrowserWindow, WebContentsView, ipcMain, Menu, clipboard, dialog: electronDialog, nativeTheme, net, safeStorage, session, shell, components } = require('electron');
// Test mode (CLAUDE_BROWSER_TEST), honoured only when not packaged: see test-mode.js.
const TEST = require('./test-mode').isTest();

// `Lumen --mcp`: an AI agent (Claude Code, Codex, Gemini CLI…) started us as its MCP server. Run
// only the stdio bridge, before loading anything else (no window, no lock, nothing on stdout).
if (process.argv.includes('--mcp')) {
  if (TEST && process.env.CLAUDE_BROWSER_PROFILE) app.setPath('userData', process.env.CLAUDE_BROWSER_PROFILE);
  require('./mcp').runBridge({ app });
  return;
}
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ElectronChromeExtensions } = require('electron-chrome-extensions');
const { installChromeWebStore, installExtension, uninstallExtension } = require('electron-chrome-web-store');
const { extensionPermissionLines } = require('./extension-permissions');
const { Agent, MODELS, DEFAULT_MODEL, EXTERNAL_TOOLS, PAGE_BLOCK, validateInput: validateToolInput } = require('./agent');
const providers = require('./providers');
const cliJson = require('./cli-json');
const { engineModel } = require('./cli-utils');
const { SEARCH_ENGINES, DEFAULT_ENGINE, engineFor, searchUrlFor, resolveInput: resolveAddressInput } = require('./search');
// Optional features load on first use (startup stays lean).
const lazy = (load) => { let mod; return new Proxy({}, { get: (_t, key) => (mod ||= load())[key] }); };
const importer = lazy(() => require('./importer'));
const cliAuth = lazy(() => require('./cli-auth'));
// The SDK needs `new`, which the plain get-trap `lazy()` proxy above can't forward, so it gets its
// own tiny cached accessor instead. Only the Claude API path (getClient, organizeTabsWithAi's catch)
// touches this; a session that only ever uses Claude Code, Grok, or another provider never loads it.
let anthropicSdk_ = null;
const anthropicSdk = () => (anthropicSdk_ ||= require('@anthropic-ai/sdk'));
const { createTabGroups, siteName } = require('./tab-groups');
const { createAdblock, hostOf } = require('./features/adblock');
const { createDownloads } = require('./features/downloads');
const { createDialogs } = require('./features/dialogs');
const instance = require('./features/instance');

const NEW_TAB_URL = pathToFileURL(path.join(__dirname, 'renderer', 'newtab.html')).href;
const isNewTab = (url) => url.startsWith(NEW_TAB_URL);
const HISTORY_URL = pathToFileURL(path.join(__dirname, 'renderer', 'history.html')).href;
const settingsPage = require('./settings-backend'); // [settings] lumen://settings
const isInternal = (url) => isNewTab(url) || url.startsWith(HISTORY_URL) || settingsPage.isSettingsUrl(url);
const ERROR_URL = pathToFileURL(path.join(__dirname, 'renderer', 'error.html')).href;
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
const UA_PLATFORM = { win32: 'Windows NT 10.0; Win64; x64', darwin: 'Macintosh; Intel Mac OS X 10_15_7' }[process.platform] || 'X11; Linux x86_64';
app.userAgentFallback = `Mozilla/5.0 (${UA_PLATFORM}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`;

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
const PRIVILEGED_IPC = /^(settings|openrouter|cli|import|mcp|automation|claudecode):/;
// Everything preload.js sends or invokes (the browser UI's own bridge): these answer only the UI's
// top-level renderer/index.html document, never a page that somehow got into that window or a frame
// inside it. test/hardening.js checks this list against preload.js.
const UI_ONLY_IPC = new Set([
  'content-bounds', 'view:freeze', 'view:thaw', 'chat:full', 'view:warm',
  'tab:new', 'tab:close', 'tab:switch', 'tab:move', 'tab:context-menu',
  'group:context-menu', 'group:toggle', 'group:rename', 'tabs:organize',
  'bookmark:toggle', 'zoom:reset', 'downloads:menu',
  'nav:go', 'nav:back', 'nav:forward', 'nav:reload', 'find:start', 'find:stop',
  'app-menu', 'suggest:query', 'suggest:show', 'suggest:hide', 'address:touched', 'home:mode',
  'settings-page:open', 'prefs:ui',
  'agent:ask', 'agent:stop', 'agent:reset', 'agent:approve', 'agent:auto-allow',
  'pagecontext:get', 'pagecontext:set',
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
  || (PRIVILEGED_IPC.test(channel) && isSettingsSender(event));
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
  ipcMain[method] = (channel, listener) => register(channel, !gatedChannel(channel) ? listener : (event, ...args) => {
    if (trustedSender(event, channel)) return listener(event, ...args);
    console.error(`[lumen] refused ${channel} from ${event.sender.getURL?.().slice(0, 80)}`);
    if (method === 'handle') throw new Error('Not allowed');
    return undefined;
  });
}
let tabs = []; // { id, view, favicon }
let activeId = null;
let nextTabId = 1;
let contentBounds = { x: 0, y: 0, width: 800, height: 600 };
const closedTabs = []; // URLs, most recent last

// ---------- settings / API key ----------

let settingsCache = null;
const settingsFile = require('./settings-file'); // crash-safe read/write (see settings-file.js)

function readSettings() {
  if (!settingsCache) settingsCache = settingsFile.loadJson(SETTINGS_FILE());
  return { ...settingsCache };
}

function writeSettings(settings) {
  settingsCache = { ...settings };
  settingsFile.writeJsonAtomic(SETTINGS_FILE(), settings);
}

// Favicons out of settings.json and into their own debounced/async store (see favicon-store.js) —
// settings.json is rewritten fully and synchronously, which a new favicon shouldn't have to pay for.
// One-time migration: move any favicons an older build saved inline, then drop the key for good.
const { createFaviconStore } = require('./favicon-store');
const faviconStore = createFaviconStore(app.getPath('userData'), readSettings().favicons);
if (readSettings().favicons) {
  const { favicons, ...rest } = readSettings();
  writeSettings(rest);
}

// Outside AI agents (MCP, CDP automation, Claude Code): features/ai-agents.js. The automation
// switch must be set before ready.
const { setupAiAgents, prepareAutomation } = require('./features/ai-agents');
const automationPlan = prepareAutomation(app, readSettings());
// With automation on, this first process only starts Lumen again through launcher.js (which gives
// Chromium a private pipe instead of a debugging port) and leaves, before it opens anything. A copy
// started while Lumen runs passes its links on and quits, the same as without automation.
if (automationPlan?.relaunch && !process.argv.includes('--install-shortcuts')) {
  if (instance.acquireInstanceLock(app)) {
    app.releaseSingleInstanceLock();
    require('./launcher').relaunch();
  }
  app.exit(0);
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
    providerModels[provider] = await providers.listModels(provider, key, { cacheFile: provider === 'openrouter' ? OPENROUTER_CACHE() : undefined });
  }
  ui()?.send('models-updated');
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
function modelOptions() {
  const groups = [];
  if (anthropicUsable()) groups.push({ label: 'Claude', entries: Object.entries(MODELS).map(([id, { label, detail }]) => ({ id, label, detail })) });
  for (const [provider, info] of Object.entries(providers.PROVIDERS)) {
    if (!providerKey(provider)) continue;
    const list = [...(providerModels[provider] || info.defaults)];
    // OpenRouter: a model picked from "More models…" joins the short list.
    const saved = providers.splitModel(readSettings().model || '');
    if (provider === 'openrouter' && saved.provider === 'openrouter' && !list.includes(saved.model)) list.push(saved.model);
    const entries = list.map((model) => {
      const chatOnly = !providers.canUseTools(provider, model);
      return { id: `${provider}:${model}`, label: chatOnly ? `${model} (chat only)` : model, detail: `${info.label} · ${model}${chatOnly ? ' · chat only: can’t act in your tabs' : ''}` };
    });
    if (provider === 'openrouter') entries.push({ id: 'openrouter:__more', label: 'More models…', detail: 'Search every model on OpenRouter' });
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
    client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  } catch {
    throw new Error('No API key found. Use your Claude account through Claude Code (pick “Claude Code” in the model menu), or add an API key or sign in with OpenRouter in Settings.');
  }
  return client;
}

// ---------- dialogs: one Lumen-styled overlay instead of native message boxes (features/dialogs.js) ----------

const dialogs = createDialogs({
  win: () => win,
  paths: { preload: path.join(__dirname, 'dialog-preload.js'), html: path.join(__dirname, 'renderer', 'dialog.html') },
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

// HTTP Basic/Digest auth: a styled sign-in sheet instead of the native prompt.
app.on('login', (event, webContents, details, authInfo, callback) => {
  event.preventDefault();
  const insecure = !authInfo.isProxy && !/^https:/i.test(details.url) ? ' Your connection to this site is not private.' : '';
  dialogs.ask({
    message: 'Sign in',
    detail: `${authInfo.host}${authInfo.realm ? ` (${authInfo.realm})` : ''} requires a username and password.${insecure}`,
    fields: [{ name: 'username', label: 'Username' }, { name: 'password', label: 'Password', type: 'password' }],
    buttons: ['Cancel', 'Sign In'],
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
  const checkboxLabel = entry.count > 1 ? "Don't let this page show more dialogs" : '';
  const finish = (value, checkboxChecked) => {
    if (checkboxChecked) entry.muted = true;
    event.returnValue = value;
  };
  if (req.kind === 'prompt') {
    dialogs.ask({
      title, message: req.message, fields: [{ name: 'value', value: req.defaultValue || '' }],
      buttons: ['Cancel', 'OK'], defaultId: 1, cancelId: 0, owner: wc, checkboxLabel,
    }).then(({ response, values, checkboxChecked }) => finish(response === 1 && values ? values.value : null, checkboxChecked));
  } else if (req.kind === 'confirm') {
    dialogs.showMessageBox(win, {
      title, message: req.message, buttons: ['Cancel', 'OK'], defaultId: 1, cancelId: 0, owner: wc, checkboxLabel,
    }).then(({ response, checkboxChecked }) => finish(response === 1, checkboxChecked));
  } else {
    dialogs.showMessageBox(win, {
      title, message: req.message, buttons: ['OK'], defaultId: 0, cancelId: 0, owner: wc, checkboxLabel,
    }).then(({ checkboxChecked }) => finish(undefined, checkboxChecked));
  }
});
// Registered once the app (and so session.defaultSession) exists; a separate whenReady hook so it
// doesn't touch the app's main startup sequence.
app.whenReady().then(() => {
  session.defaultSession.registerPreloadScript({ id: 'lumen-page-dialogs', type: 'frame', filePath: path.join(__dirname, 'page-dialogs-preload.js') });
  // Dropdown menus stay readable on dark-styled sites (features/select-contrast-preload.js).
  session.defaultSession.registerPreloadScript({ id: 'lumen-select-contrast', type: 'frame', filePath: path.join(__dirname, 'features', 'select-contrast-preload.js') });
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
      buttons: ["Don't Allow", 'Allow'],
      defaultId: 0,
      cancelId: 0,
      message: `Allow ${new URL(origin).host} to ${reason}?`,
      owner: wc,
    });
    if (cancelled) return callback(false);
    permissionDecisions.set(key, response === 1);
    settingsBackend.savePermissions(permissionDecisions); // [settings]
    callback(response === 1);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) =>
    ALWAYS_ALLOWED.has(permission) || permissionDecisions.get(`${origin}|${permission}`) === true);
  ses.setDisplayMediaRequestHandler(pickScreenToShare);
}

// Links for other apps (mailto:, tel:, zoommtg:, slack:, …) did nothing, because every
// permission not on the list above was refused. Now they ask first, as Chrome does: "Open the app
// for mailto: links?", remembered for the site until Lumen quits. Schemes that reach local files,
// run script, or are known to launch Windows tools with attacker-chosen input are never opened.
const BLOCKED_SCHEMES = new Set(['file', 'javascript', 'vbscript', 'data', 'blob', 'filesystem', 'about', 'chrome', 'chrome-extension', 'devtools', 'view-source', 'jar', 'res', 'hcp', 'shell', 'search', 'search-ms', 'ms-msdt', 'ms-officecmd', 'ms-appinstaller', 'ms-cxh', 'ms-cxh-full', 'ms-settings', 'lumen']);
const externalDecisions = new Map(); // `${origin}|${scheme}` -> true (allowed for this session)
async function askOpenExternal(wc, details) {
  let scheme;
  let origin = '';
  try { scheme = new URL(details.externalURL).protocol.slice(0, -1).toLowerCase(); } catch { return false; }
  try { origin = new URL(details.requestingUrl || wc.getURL()).origin; } catch {}
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme) || BLOCKED_SCHEMES.has(scheme)) return false;
  const key = `${origin}|${scheme}`;
  if (externalDecisions.get(key)) return true;
  let host = '';
  try { host = new URL(origin).host; } catch {}
  const label = { mailto: 'your email app', tel: 'your phone app', sms: 'your messages app' }[scheme] || `the app for ${scheme}: links`;
  const { response, cancelled } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Cancel', 'Open'],
    defaultId: 1,
    cancelId: 0,
    message: `Open ${label}?`,
    detail: host ? `${host} wants to open ${label}.` : `This page wants to open ${label}.`,
    owner: wc,
  });
  if (cancelled || response !== 1) return false;
  externalDecisions.set(key, true);
  return true;
}

// Screen sharing (Meet, Zoom, Teams on the web) failed outright: there was no handler for
// getDisplayMedia. The user picks an entire screen or one window from a menu of thumbnails;
// closing the menu shares nothing.
async function pickScreenToShare(request, callback) {
  let done = false;
  const answer = (streams) => { if (!done) { done = true; callback(streams); } };
  try {
    const { desktopCapturer, nativeImage } = require('electron');
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 96, height: 60 }, fetchWindowIcons: false });
    const lumen = win && !win.isDestroyed() ? win.getMediaSourceId() : '';
    const pickable = sources.filter((s) => s.id !== lumen);
    if (!pickable.length || !win || win.isDestroyed()) return answer({});
    let host = '';
    try { host = new URL(request.securityOrigin || request.frame?.url || '').host; } catch {}
    let picked = null;
    const item = (s, label) => ({ label, icon: s.thumbnail.isEmpty() ? undefined : nativeImage.createFromBuffer(s.thumbnail.toPNG()).resize({ width: 48 }), click: () => { picked = s; } });
    const screens = pickable.filter((s) => s.id.startsWith('screen:'));
    const windows = pickable.filter((s) => s.id.startsWith('window:'));
    Menu.buildFromTemplate([
      { label: host ? `Share with ${host}` : 'Share your screen', enabled: false },
      ...screens.map((s, i) => item(s, screens.length > 1 ? `Entire screen ${i + 1}` : 'Entire screen')),
      ...(windows.length ? [{ type: 'separator' }] : []),
      ...windows.slice(0, 20).map((s) => item(s, s.name.length > 60 ? `${s.name.slice(0, 59)}…` : s.name)),
      { type: 'separator' },
      { label: 'Cancel' },
    ]).popup({
      window: win,
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
const tabGroups = createTabGroups({
  getTabs: () => tabs,
  setTabs: (list) => { tabs = list; },
  urlOf: (t) => (alive(t) ? realUrl(t.view.webContents) : ''),
  titleOf: (t) => (alive(t) ? t.view.webContents.getTitle() : ''),
  textOf: (t) => t.pageText || '', // the page's description / first heading (see readPageText)
  isWeb: (url) => isWebUrl(url),
  mode: () => groupingMode(),
  aiTopics: () => readSettings().topicAi === true,
});
// Automatic grouping: 'off' | 'site' | 'topic'. Before topics it was a switch (autoGroupTabs).
function groupingMode() {
  const { tabGrouping, autoGroupTabs } = readSettings();
  return ['off', 'site', 'topic'].includes(tabGrouping) ? tabGrouping : autoGroupTabs === false ? 'off' : 'site';
}
let autoGroupTimer = null;
// By topic, titles alone are often too short to link one topic across sites (MDN, Stack Overflow
// and GitHub pages about one library). After a page loads, its meta description and first heading
// join its words. Read in an isolated world, so the page can't see or tamper with the read.
const PAGE_TEXT_WORLD = 1001;
function readPageText(tab) {
  const wc = tab.view.webContents;
  if (groupingMode() !== 'topic' || !isWebUrl(realUrl(wc))) return;
  wc.executeJavaScriptInIsolatedWorld(PAGE_TEXT_WORLD, [{ code: `[document.querySelector('meta[name="description"],meta[property="og:description"]')?.content || '', document.querySelector('h1')?.textContent || ''].join(' ').replace(/\\s+/g, ' ').trim().slice(0, 300)` }])
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
  }, 400); // after the title usually arrives
}

let ignoreExtensionSelect = false;
function syncExtensions(fn) {
  ignoreExtensionSelect = true;
  try { fn(); } finally { ignoreExtensionSelect = false; }
}

// ---------- ad blocker (features/adblock.js) ----------

const adblock = createAdblock({
  app, session, readSettings, writeSettings, isWebUrl,
  activeContents: () => activeTab()?.webContents,
  realUrl: (wc) => realUrl(wc),
  onResponseHeaders: (details) => settingsBackend.noteResponseHeaders(details),
});

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
  for (const type of ['frame', 'service-worker']) ses.registerPreloadScript({ id: `lumen-dnr-${type}`, type, filePath: path.join(__dirname, 'extensions-dnr-preload.js') });
  // Keeps the store page off Electron's native webstorePrivate, which crashes Lumen (see the file).
  ses.registerPreloadScript({ id: 'lumen-webstore', type: 'frame', filePath: path.join(__dirname, 'features', 'webstore-preload.js') });
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
  // Lists what it asks for (all sites, history, downloads, …) before anything is installed.
  const extensionAsks = (manifest) => {
    const lines = extensionPermissionLines(manifest);
    return lines.length ? `It can:\n${lines.map((l) => `• ${l}`).join('\n')}` : 'It asks for no special permissions.';
  };
  await installChromeWebStore({
    session: ses,
    beforeInstall: async ({ localizedName, manifest }) => {
      if (isContentBlocker(manifest, localizedName)) {
        await dialog.showMessageBox(win, {
          type: 'info',
          message: `“${localizedName}” can't be added`,
          detail: 'It blocks content with Chrome filter lists (declarativeNetRequest rulesets) that Lumen cannot apply yet. For ad and tracker blocking, use the built-in blocker in ⋯ → Ad Blocker.',
        });
        return { action: 'deny' };
      }
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Cancel', 'Add Extension'],
        defaultId: 1,
        cancelId: 0,
        message: `Add “${localizedName}”?`,
        detail: `${extensionAsks(manifest)}${(manifest.permissions || []).includes('nativeMessaging') ? '\n\nParts that talk to a desktop app (such as unlocking with the 1Password app) may not work in Lumen. Sign in inside the extension instead.' : ''}`,
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
    { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => openTab() },
    { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', enabled: closedTabs.length > 0, click: () => openTab(closedTabs.pop()) },
    { type: 'separator' },
    { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => { ui()?.focus(); ui()?.send('find:open'); } },
    { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => zoomBy(wc, 0.5) },
    { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoomBy(wc, -0.5) },
    { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => zoomBy(wc, 0) },
    { label: 'Print…', accelerator: 'CmdOrCtrl+P', enabled: Boolean(wc), click: () => wc?.print({}, () => {}) },
    ...(process.platform === 'darwin' ? [] : [{ label: 'Full Screen', accelerator: 'F11', click: () => win.setFullScreen(!win.isFullScreen()) }]),
    { type: 'separator' },
    { label: 'Bookmarks', submenu: bookmarksMenu() },
    { label: 'History', submenu: historyMenu() },
    { label: 'Downloads', submenu: downloads.menu() },
    { type: 'separator' },
    { label: 'Tab Groups', submenu: tabGroupsMenu() },
    { label: 'Search Engine', submenu: searchEngineMenu() },
    { label: 'Import Bookmarks and History', submenu: importMenu() },
    { label: 'Ad Blocker', submenu: adblock.menu() },
    { label: 'Extensions', submenu: extensionsMenu() },
    { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => openSettingsPage() }, // [settings]
    ...(isDefaultBrowser() ? [] : [{ label: 'Make Lumen Your Default Browser…', click: makeDefaultBrowser }]),
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

// Made once per window, hidden, as soon as the UI has loaded (see createWindow). Chromium gives a
// new view focus while its first page loads, so a dropdown made on the first keystroke took the
// keys typed right after it away from the address bar. It is only ever clicked (picks go through
// 'suggest:pick'), never typed in, so any focus it gets goes straight back to the UI.
function createSuggestView() {
  if (suggestView && !suggestView.webContents.isDestroyed()) suggestView.webContents.close();
  suggestView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'suggest-preload.js'), sandbox: true, contextIsolation: true },
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
  if (url.startsWith(ERROR_URL) || url.startsWith(settingsPage.HTTPS_ONLY_URL)) return new URL(url).searchParams.get('url') || ''; // [settings] HTTPS-only warning too
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
          page: null,
          error: false,
          zoom: 100,
          zoomDefault: 100,
          bookmarked: isWebUrl(url) && bookmarked.has(url),
          groupId: t.groupId || null,
          pinned: Boolean(t.pinned),
          sleeping: true,
        };
      }
      const wc = t.view.webContents;
      const url = realUrl(wc);
      return {
        id: t.id,
        title: wc.getTitle() || 'New Tab',
        url: settingsPage.isSettingsUrl(url) ? settingsPage.displayUrl(url) : isInternal(url) ? '' : url, // [settings] lumen://settings/<section>
        loading: wc.isLoading(),
        favicon: t.favicon || null,
        page: settingsPage.isSettingsUrl(url) ? 'settings' : url.startsWith(HISTORY_URL) ? 'history' : null, // Lumen's own pages get their own icon
        error: wc.getURL().startsWith(ERROR_URL),
        zoom: Math.round(wc.getZoomFactor() * 100),
        zoomDefault: isWebUrl(url) ? defaultZoomPercent : 100, // [settings] the zoom pill shows only when a page differs from it
        bookmarked: isWebUrl(url) && bookmarked.has(url),
        groupId: t.groupId || null,
        alert: dialogs.pendingFor(wc), // a dialog is waiting for this background tab
        pinned: Boolean(t.pinned),
      };
    }),
    activeId,
    canGoBack: history ? history.canGoBack() : false,
    canGoForward: history ? history.canGoForward() : false,
  };
}

let sessionTimer = null;
function sendTabs() {
  keepPinnedFirst();
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
    const show = visible && !viewFrozen && !(tab.id === chatFullTab && isNewTab(tab.view.webContents.getURL()));
    if (show && uiHadFocus && !tab.view.getVisible()) tab.showGuardUntil = Date.now() + 500;
    tab.view.setVisible(show);
    if (!visible) continue;
    if (tab.fullscreen) {
      const [width, height] = win.getContentSize();
      tab.view.setBounds({ x: 0, y: 0, width, height });
    } else {
      tab.view.setBounds(contentBounds);
    }
  }
}

function openTab(url = newTabUrl(), { background = false, openerId = null, groupId = null, settings = false, historyPage = false } = {}) {
  const view = new WebContentsView({
    // [settings] font sizes and spell check from Settings; only the settings tab gets its preload,
    // and only the History page gets history-preload.js
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, ...settingsBackend.tabWebPreferences(settings),
      ...(historyPage ? { preload: path.join(__dirname, 'history-preload.js') } : {}),
    },
  });
  const id = nextTabId++;
  const tab = { id, view, favicon: null, groupId: null, userRemoved: false, settings, lastActiveAt: Date.now() };
  tabs.push(tab);
  win.contentView.addChildView(view);
  view.setVisible(false);
  const wc = wireView(tab, url);

  if (openerId) tabGroups.joinOpener(tab, tabs.find((t) => t.id === openerId));
  else if (groupId) tabGroups.add(id, groupId);

  if (background) {
    const current = activeTab();
    if (current) syncExtensions(() => extensions?.selectTab(current.webContents));
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
function wireView(tab, url, history = null) {
  const { id, settings } = tab;
  const wc = tab.view.webContents;
  wc.setWindowOpenHandler(({ url: target, disposition }) => {
    if (!(isWebUrl(target) || target === 'about:blank' || target.startsWith('chrome-extension://'))) return { action: 'deny' };
    // An extension's pages open only from that same extension: a web page could otherwise open any
    // extension page it liked (and whatever that page does with its privileges).
    if (target.startsWith('chrome-extension://') && extensionIdOf(target) !== extensionIdOf(wc.getURL())) return { action: 'deny' };
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
  wc.on('will-navigate', (event, url) => { askFromHome(event, event.url || url, tab.id); });
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) tab.favicon = null;
  });
  wc.on('did-fail-load', (_e, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = aborted, e.g. the user navigated away
    if (settingsBackend.onFailLoad(wc, failedUrl)) return; // [settings] HTTPS-only: no secure version
    const params = new URLSearchParams({ url: failedUrl, code: String(code), desc: description });
    wc.loadURL(`${ERROR_URL}?${params}`).catch(() => {});
  });
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) adblock.resetCount(wc.id);
  });
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
      type: 'warning', buttons: ['Wait', 'Close Page'], defaultId: 0, cancelId: 0,
      message: `${host || 'This page'} isn't responding`,
      detail: 'You can wait for it to respond, or close the page.',
      owner: wc,
    }).then(({ response, cancelled }) => {
      if (response === 1 && !cancelled && !wc.isDestroyed()) wc.forcefullyCrashRenderer();
    });
  });
  wc.on('responsive', () => { tab.hungAsked = false; });
  wc.on('did-navigate', (_e, url) => { if (!url.startsWith(ERROR_URL)) tab.lastUrl = url; });
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
    recordVisit(url, wc.getTitle());
  });
  wc.on('did-finish-load', () => readPageText(tab));
  wc.on('page-title-updated', (_e, title) => updateTitle(wc.getURL(), title));
  wc.on('found-in-page', (_e, result) => {
    if (tab.id === activeId) ui()?.send('find:result', result);
  });
  wc.on('context-menu', (_e, params) => showContextMenu(wc, params));
  for (const event of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page']) {
    wc.on(event, sendTabs);
  }
  wc.on('before-input-event', (event, input) => handleShortcut(event, input));
  wc.on('focus', () => { if (tab.showGuardUntil > Date.now()) ui()?.focus(); }); // see layout()
  // A real click in the page is the user choosing it: the guard above must not take focus back.
  wc.on('before-mouse-event', (_e, mouse) => { if (mouse.type === 'mouseDown') tab.showGuardUntil = 0; });
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
      buttons: ['Cancel', 'Leave'],
      defaultId: 0,
      cancelId: 0,
      message: 'Leave site?',
      detail: 'Changes you made may not be saved.',
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

  // If the page closes itself, drop the tab instead of keeping a dead one around. sleepTab() (below)
  // removes this exact listener first, so a deliberate sleep is never mistaken for the page closing.
  tab.onViewDestroyed = () => closeTab(id, { destroyed: true });
  const contentsId = wc.id;
  wc.once('destroyed', () => adblock.forget(contentsId)); // the new-tab "blocked" total counts open tabs only
  wc.once('destroyed', tab.onViewDestroyed);

  if (!settings) { // [settings] no debugger and no extensions on the settings tab
    applyChromeIdentity(wc);
    syncExtensions(() => extensions?.addTab(wc, win));
    // A popup (sign-in, payment) presents itself as Chrome like the tab that opened it: Google
    // sign-in and some payment pages refuse browsers they don't recognise.
    wc.on('did-create-window', (child) => applyChromeIdentity(child.webContents));
  }
  if (history?.entries?.length) {
    wc.navigationHistory.restore({ entries: history.entries, index: history.index }).catch(() => wc.loadURL(url).catch(() => {}));
  } else {
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
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, ...settingsBackend.tabWebPreferences(false) },
  });
  tab.view = view;
  tab.sleeping = false;
  win.contentView.addChildView(view);
  view.setVisible(false);
  const history = tab.sleepHistory;
  tab.sleepHistory = null;
  wireView(tab, tab.sleepUrl || newTabUrl(), history);
}

// A tab from the saved session that hasn't been opened yet: a sleeping tab (above) with no view,
// which switchTab() wakes the first time it's shown. Starting Lumen loads only the active tab
// instead of every tab of the last session at once.
function addRestoredTab(url, title) {
  const tab = {
    id: nextTabId++, view: null, favicon: faviconStore.get(hostOf(url)) || null, groupId: null,
    userRemoved: false, settings: false, lastActiveAt: Date.now(),
    sleeping: true, sleepUrl: url, sleepTitle: title || hostOf(url) || 'New Tab', sleepHistory: null,
  };
  tabs.push(tab);
  return tab;
}

// A page may have text typed into a form; sleeping can't ask "Leave site?" the way a real close does
// (will-prevent-unload, above, is deliberately bypassed for a silent background sleep), so this
// substitutes for it. Any doubt (a throw, a page that blocks the read) counts as "yes, has input".
async function hasUnsavedInput(wc) {
  try {
    return await wc.executeJavaScriptInIsolatedWorld(PAGE_TEXT_WORLD, [{ code: `(() => {
      const dirty = (el) => (el.matches('input,textarea') ? el.value !== (el.defaultValue ?? '') : el.isContentEditable && el.textContent.trim() !== '');
      return [...document.querySelectorAll('input,textarea,[contenteditable=""],[contenteditable=true]')].some(dirty);
    })()` }]);
  } catch {
    return true;
  }
}

// Never the active tab, never a tab an AI task is working in (it keeps its tab when the user switches
// away), never settings/internal pages, never a tab mid-close, mid-navigation, playing audio, or with
// typed form input. On any doubt this returns false and the tab is left alone.
async function canSleep(tab) {
  if (!alive(tab) || tab.sleeping || tab.id === activeId || tab.settings || tab.closing || agent.usingTab(tab.id)) return false;
  const wc = tab.view.webContents;
  if (!isWebUrl(realUrl(wc)) || wc.isLoading() || wc.isCurrentlyAudible()) return false;
  return !(await hasUnsavedInput(wc));
}

async function sweepSleep() {
  if (!win || win.isDestroyed() || readSettings().tabSleep === false) return;
  const pressure = await pressureCheck();
  const cutoff = Date.now() - (pressure ? PRESSURE_SLEEP_AFTER_MS : SLEEP_AFTER_MS);
  for (const tab of [...tabs].sort((a, b) => (a.lastActiveAt || 0) - (b.lastActiveAt || 0))) {
    if (!tab.lastActiveAt || tab.lastActiveAt > cutoff) continue;
    if (!(await canSleep(tab))) continue;
    // hasUnsavedInput (inside canSleep) is an async round trip to the page: re-check the fast,
    // synchronous conditions in case the user switched to (or closed) this exact tab meanwhile.
    if (!alive(tab) || tab.sleeping || tab.id === activeId) continue;
    sleepTab(tab);
    sendTabs();
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
  if (!ui()?.isFocused()) ui()?.focus();
  const wc = activeTab()?.webContents;
  if (wc && isNewTab(wc.getURL())) wc.executeJavaScript('document.activeElement?.blur()').catch(() => {});
});
// The new-tab page's Search | Ask AI choice (kept in the page's own localStorage), so Enter in the
// address bar can follow it while that page is showing.
ipcMain.handle('home:mode', async () => {
  const wc = activeTab()?.webContents;
  if (!wc || !isNewTab(wc.getURL())) return null;
  try {
    return (await wc.executeJavaScript("localStorage.getItem('lumen.home.mode')")) === 'ask' ? 'ask' : 'search';
  } catch {
    return null;
  }
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

function switchTab(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return false;
  if (id !== activeId) {
    const leaving = tabs.find((t) => t.id === activeId);
    if (leaving) leaving.lastActiveAt = Date.now(); // starts its idle clock for tab sleeping (sweepSleep)
    activeTab()?.webContents.stopFindInPage('clearSelection');
  }
  if (tab.sleeping) wakeTab(tab);
  activeId = id;
  const current = activeTab();
  if (current) syncExtensions(() => extensions?.selectTab(current.webContents));
  layout();
  dialogs.refresh(); // a dialog waiting for this tab comes up; the one for the tab left waits
  sendTabs();
  return true;
}

function closeTab(id, { destroyed = false } = {}) {
  const index = tabs.findIndex((t) => t.id === id);
  if (index === -1) return;
  if (chatFullTab === id) chatFullTab = null;
  const [tab] = tabs.splice(index, 1);
  tabGroups.cleanup();
  // `pendingCloseUrl` (set by requestCloseTab) covers the case where this runs from the 'destroyed'
  // event below: the webContents is already gone by then, so its URL can't be read any more. A
  // sleeping tab has no webContents at all; sleepUrl is its last known URL instead.
  const url = tab.pendingCloseUrl ?? (alive(tab) ? realUrl(tab.view.webContents) : tab.sleepUrl || '');
  if (url && !isInternal(url)) closedTabs.push(url);
  if (closedTabs.length > 50) closedTabs.splice(0, closedTabs.length - 50); // Reopen Closed Tab goes back 50
  if (!win || win.isDestroyed()) return; // the app is quitting
  if (tab.view) win.contentView.removeChildView(tab.view); // no view to remove if it was sleeping
  if (!destroyed && alive(tab)) tab.view.webContents.close();
  if (tabs.length === 0) {
    openTab();
    return;
  }
  if (activeId === id) switchTab(tabs[Math.min(index, tabs.length - 1)].id);
  else sendTabs();
}

// The interactive "close this tab" entry points (the tab strip's ✕, Ctrl/Cmd+W, the tab menu) go
// through here instead of calling closeTab directly, so a page with a beforeunload handler gets to
// ask "Leave site?" (will-prevent-unload, wired in openTab) before the tab actually goes away. If
// the page doesn't object — true for the vast majority of tabs — this closes right away: Electron
// only fires will-prevent-unload when the page's own handler tries to block the close.
// closeTab({ destroyed: true }), already wired to every tab's 'destroyed' event, finishes the job.
function requestCloseTab(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!alive(tab)) { closeTab(id); return; }
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
    title: t.sleeping ? (t.sleepTitle || 'New Tab') : t.view.webContents.getTitle(),
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
  // [settings] Reset (Ctrl+0, the zoom pill) goes back to the default zoom from Settings, and the
  // site follows that default again; zooming by hand makes the default leave this site alone.
  if (step === 0) settingsBackend.resetZoom(wc);
  else {
    settingsBackend.noteUserZoom(wc);
    wc.setZoomLevel(Math.min(Math.max(wc.getZoomLevel() + step, -3), 5));
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
const ORGANIZE_PROMPT = 'Group these browser tabs by topic or task. Give each group a short name (1-3 words, Title Case). A tab belongs to at most one group; leave out tabs that fit nowhere. Use only the ids given. Reply with JSON: {"groups":[{"name":"...","tab_ids":[1,2]}]}.';

// Where a grouping request goes. The user's own CLIs ('claudecode:…' / 'grokbuild:…' picks) answer
// it as a one-shot, tool-less run (cli-json.js), so no API key is needed. An API model without a
// key goes to Claude Code instead, when it's installed and not known to be signed out.
const LOCAL_ENGINE = /^(claudecode|grokbuild):/;
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
  if (!bin) throw new Error(engine === 'claudecode' ? 'Claude Code isn’t installed.' : 'Grok Build isn’t installed.');
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
    const detail = err instanceof anthropicSdk().AuthenticationError ? 'Your Anthropic API key was rejected. Check it in Claude settings.' : err.message;
    if (win && !win.isDestroyed()) await dialog.showMessageBox(win, { type: 'warning', message: "Couldn't organize tabs", detail });
  } finally {
    organizing = false;
    ui()?.send('tabs:organizing', false);
  }
}

// ---- topic groups: local clusters (tab-groups.js), or named by the cheapest model of the chat's provider
// when "Use AI to name and group topics" is on. Only ids, titles and hostnames are sent.
function cheapTopicModel() {
  const chosen = agent.messages.settings?.model || readSettings().model || DEFAULT_MODEL;
  if (LOCAL_ENGINE.test(chosen)) return chosen; // proposeGroupsLocal picks the fast model itself
  const { provider } = providers.splitModel(chosen);
  if (provider === 'anthropic') return 'claude-haiku-4-5';
  const list = providerModels[provider] || providers.PROVIDERS[provider].defaults;
  return `${provider}:${list.find((m) => /mini|flash|fast|lite|haiku/i.test(m)) || list[0]}`;
}
const topicList = (entries) => entries.map((e) => ({ id: e.id, title: String(e.title).slice(0, 120), host: hostOf(e.url) }));

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
      if (tabGroups.groupLoose(await proposeGroups(cheapTopicModel(), topicList(pool)))) sendTabs();
    } catch {
      if (tabGroups.groupLoose()) sendTabs(); // no key or no network: the local clusters instead
    } finally {
      aiTopicsBusy = false;
    }
  }, 2500);
}

// "Organize Tabs by Topic" (tab menu, ⋯ → Tab Groups): regroups loose tabs and automatic groups.
async function organizeByTopic() {
  let proposal = null;
  if (readSettings().topicAi === true) {
    proposal = await proposeGroups(cheapTopicModel(), topicList(tabGroups.candidates())).catch(() => null); // falls back to local
  }
  const count = tabGroups.organizeByTopic(proposal);
  sendTabs();
  return count;
}
function undoOrganize() {
  if (tabGroups.undoOrganize()) sendTabs();
}

const colorLabel = (c) => c.charAt(0).toUpperCase() + c.slice(1);

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
  if (on && tab.groupId) tabGroups.remove(id, { byUser: true });
  tab.pinned = on;
  tab.userRemoved = true; // pinned or unpinned by hand: automatic grouping leaves it alone
  // A newly pinned tab goes after the other pinned tabs; an unpinned one becomes the first loose tab.
  tabs.splice(tabs.indexOf(tab), 1);
  tabs.splice(tabs.filter((t) => t.pinned).length, 0, tab);
  tabGroups.cleanup();
  sendTabs();
}

function tabMenu(id, { x, y }) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  if (tab.pinned) {
    Menu.buildFromTemplate([
      { label: 'Unpin Tab', click: () => pinTab(id, false) },
      { type: 'separator' },
      { label: 'Close Tab', click: () => requestCloseTab(id) },
    ]).popup({ window: win, x: Math.round(x), y: Math.round(y) });
    return;
  }
  const others = tabGroups.state().filter((g) => g.id !== tab.groupId);
  const items = [{ label: 'Pin Tab', click: () => pinTab(id, true) }, { type: 'separator' }, {
    label: 'Add to New Group',
    click: () => {
      if (tab.groupId) tabGroups.remove(id, { byUser: true });
      // A sleeping tab has no webContents to read; its sleep snapshot has the same info.
      const url = alive(tab) ? realUrl(tab.view.webContents) : tab.sleepUrl || '';
      const title = alive(tab) ? tab.view.webContents.getTitle() : tab.sleepTitle || '';
      const group = tabGroups.create(isWebUrl(url) ? siteName(url, title) : 'New Group', [id]);
      sendTabs();
      ui()?.send('group:rename-start', group.id);
    },
  }];
  if (others.length) items.push({ label: 'Add to Group', submenu: others.map((g) => ({ label: g.name, click: () => { tabGroups.add(id, g.id); sendTabs(); } })) });
  if (tab.groupId) items.push({ label: 'Remove from Group', click: () => { tabGroups.remove(id, { byUser: true }); sendTabs(); } });
  items.push({ type: 'separator' }, { label: 'Organize Tabs by Topic', click: organizeByTopic });
  if (tabGroups.canUndo()) items.push({ label: 'Undo Organize', click: undoOrganize });
  items.push({ type: 'separator' }, { label: 'Close Tab', click: () => requestCloseTab(id) });
  Menu.buildFromTemplate(items).popup({ window: win, x: Math.round(x), y: Math.round(y) });
}

function groupMenu(groupId, { x, y }) {
  const group = tabGroups.groups.get(groupId);
  if (!group) return;
  Menu.buildFromTemplate([
    { label: 'Rename…', click: () => ui()?.send('group:rename-start', groupId) },
    { label: 'Colour', submenu: tabGroups.GROUP_COLORS.map((c) => ({ label: colorLabel(c), type: 'radio', checked: group.color === c, click: () => { group.color = c; sendTabs(); } })) },
    { label: 'New Tab in Group', click: () => openTab(undefined, { groupId }) },
    { type: 'separator' },
    { label: 'Ungroup', click: () => { tabGroups.ungroupAll(groupId); sendTabs(); } },
    { label: 'Close Group', click: () => tabGroups.members(groupId).map((t) => t.id).forEach((id) => closeTab(id)) },
  ]).popup({ window: win, x: Math.round(x), y: Math.round(y) });
}

function tabGroupsMenu() {
  const mode = groupingMode();
  return [
    { label: 'Organize Tabs by Topic', click: organizeByTopic },
    { label: 'Undo Organize', enabled: tabGroups.canUndo(), click: undoOrganize },
    { label: 'Organize Tabs with AI', enabled: !organizing, click: organizeTabs },
    { type: 'separator' },
    { label: 'Group Automatically', enabled: false },
    ...[['off', 'Off'], ['site', 'By Site'], ['topic', 'By Topic']].map(([value, label]) => ({ label, type: 'radio', checked: mode === value, click: () => setTabGrouping(value) })),
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

// The History page asks for its entries over IPC (history-preload.js). They used to be packed into
// the page's URL, which a long history pushed past Chromium's URL length limit (a blank page).
function openHistoryPage() {
  openTab(HISTORY_URL, { historyPage: true });
}
const fromHistoryPage = (event) => event.senderFrame === event.sender.mainFrame && event.sender.getURL().startsWith(HISTORY_URL);
ipcMain.handle('history:list', (event) => {
  if (!fromHistoryPage(event)) return [];
  return [...history.values()].sort((a, b) => b.last - a.last).slice(0, 5000).map(({ url, title, last }) => ({ url, title, last }));
});
ipcMain.handle('history:remove', (event, url) => {
  if (!fromHistoryPage(event) || typeof url !== 'string' || !history.delete(url)) return false;
  saveHistorySoon();
  return true;
});

function historyMenu() {
  const recent = [...history.values()].sort((a, b) => b.last - a.last).slice(0, 15);
  if (!recent.length) return [{ label: 'No history yet', enabled: false }];
  return [
    { label: 'Show All History', accelerator: process.platform === 'darwin' ? 'Cmd+Y' : 'Ctrl+H', click: openHistoryPage },
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
  const withIcon = (b) => { const icon = faviconStore.get(hostOf(b.url)); return icon ? { ...b, icon } : b; };
  const data = {
    favorites: bookmarks().filter((b) => !b.folder).slice(0, 12).map(withIcon),
    frequent: frequentSites().map(withIcon),
    blocked: adblock.total(), // ads/trackers blocked on open tabs
    search: engineFor(readSettings().searchEngine),
    assistant: homeAssistant(),
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

// When a favorite or frequently visited site shows its favicon, keep a small copy for the new-tab page.
async function cacheFavicon(pageUrl, iconUrl) {
  const host = hostOf(pageUrl);
  if (!host || faviconStore.has(host) || !/^https?:/.test(iconUrl)) return;
  // Only sites the new-tab page shows: favorites and frequently visited ones.
  if (!bookmarks().some((b) => hostOf(b.url) === host) && !frequentSites(12).some((s) => hostOf(s.url) === host)) return;
  try {
    const res = await net.fetch(iconUrl);
    const type = res.headers.get('content-type') || '';
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!res.ok || !type.startsWith('image/') || bytes.length > 40000) return;
    faviconStore.set(host, `data:${type.split(';')[0]};base64,${bytes.toString('base64')}`);
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

// ---------- downloads (features/downloads.js) ----------

const downloads = createDownloads({
  app, session, dialog, shell, ui,
  win: () => win,
  downloadDir: () => settingsBackend.downloadDir(), // [settings] Downloads folder unless changed in Settings
  askWhereToSave: () => settingsBackend.askWhereToSave(),
});

// Electron reports only "Chromium" in UA client hints while the user agent says Chrome; sites
// (Google especially) treat that mismatch as a bot signal. Align both through the DevTools protocol.
const CHROME_MAJOR = process.versions.chrome.split('.')[0];
// Chrome's brand list, built the way Chromium builds it (GenerateBrandVersionList): the made-up
// "Not…A…Brand" entry and the order of the three both follow from the major version, so a
// hard-coded list gives Lumen away as soon as Chromium moves on. Chromium 152 gives
// Chromium, Not?A_Brand/24, Google Chrome; Chrome 154 gives Chromium, Google Chrome, Not A(Brand/99.
function chromeBrands(full) {
  const seed = Number(CHROME_MAJOR);
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const greaseVersion = ['8', '99', '24'][seed % 3];
  const list = [
    { brand: `Not${chars[seed % chars.length]}A${chars[(seed + 1) % chars.length]}Brand`, version: full ? `${greaseVersion}.0.0.0` : greaseVersion },
    { brand: 'Chromium', version: full ? process.versions.chrome : CHROME_MAJOR },
    { brand: 'Google Chrome', version: full ? process.versions.chrome : CHROME_MAJOR },
  ];
  const order = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]][seed % 6];
  const shuffled = [];
  list.forEach((b, i) => { shuffled[order[i]] = b; });
  return shuffled;
}
const UA_METADATA = {
  brands: chromeBrands(false),
  fullVersionList: chromeBrands(true),
  platform: { win32: 'Windows', darwin: 'macOS' }[process.platform] || 'Linux',
  // Chrome on a Mac reports the real macOS version (26.0.0), not an empty string.
  platformVersion: process.platform === 'win32' ? '15.0.0' : process.platform === 'darwin' ? process.getSystemVersion() : '',
  architecture: process.arch === 'arm64' ? 'arm' : 'x86', // Chrome on Apple Silicon says "arm"
  bitness: '64',
  model: '',
  mobile: false,
};
// The same identity for the Sec-CH-UA request headers, which Chrome sends on every request to a
// secure origin. Requests from tabs otherwise go out with none at all (and the browser's own with
// Electron's Chromium-only list): a Chrome user agent without them is what bot checks look for.
const UA_HINT_HEADERS = {
  'Sec-CH-UA': UA_METADATA.brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', '),
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': `"${UA_METADATA.platform}"`,
};
// The override only covers the tab's own frame. Cross-origin iframes and workers are separate
// targets that would still say "Chromium", and Cloudflare's checkbox (an iframe from
// challenges.cloudflare.com) fails a page whose frames disagree. So auto-attach to each one, paused
// at start, give it the same identity, then let it run.
const identified = new WeakSet();
function applyChromeIdentity(wc) {
  if (identified.has(wc)) return;
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  } catch {
    return; // Another debugger (e.g. an extension) is attached; keep Electron's defaults.
  }
  identified.add(wc);
  const override = { userAgent: app.userAgentFallback, userAgentMetadata: UA_METADATA };
  // Workers have no Emulation domain; Network sets the same thing there.
  const identify = (sessionId) => wc.debugger.sendCommand('Emulation.setUserAgentOverride', override, sessionId)
    .catch(() => wc.debugger.sendCommand('Network.setUserAgentOverride', override, sessionId)).catch(() => {});
  const autoAttach = (sessionId) => wc.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch(() => {});
  wc.debugger.on('message', (_e, method, params) => {
    if (method !== 'Target.attachedToTarget') return;
    const { sessionId, targetInfo } = params;
    Promise.all([identify(sessionId), targetInfo.type === 'iframe' ? autoAttach(sessionId) : null])
      .finally(() => wc.debugger.sendCommand('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {}));
  });
  identify();
  autoAttach();
}

// ---------- context menu ----------

function showContextMenu(wc, p) {
  const items = [...settingsBackend.spellingItems(wc, p)]; // [settings] spelling suggestions first
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
  if (mod && input.shift && key === 't') { if (closedTabs.length) openTab(closedTabs.pop()); }
  else if (mod && key === 't') openTab();
  else if (mod && key === 'w') { if (activeId) requestCloseTab(activeId); }
  else if (mod && key === 'l') focusAddress();
  else if (mod && key === 'f' && tabs.find((t) => t.id === activeId)?.settings) { wc.focus(); wc.executeJavaScript("{ const s = document.getElementById('search'); s?.focus(); s?.select(); }").catch(() => {}); } // [settings] Ctrl+F searches settings
  else if (mod && key === 'f') { ui()?.focus(); ui()?.send('find:open'); }
  else if (mod && key === 'j') ui()?.send('toggle-sidebar');
  else if (mod && key === 'r') reloadActive();
  else if (mod && key === 'tab') cycleTab(input.shift ? -1 : 1);
  else if (mod && /^[1-9]$/.test(key)) { const t = key === '9' ? tabs[tabs.length - 1] : tabs[Number(key) - 1]; if (t) switchTab(t.id); }
  else if (mod && (key === '=' || key === '+')) zoomBy(wc, 0.5);
  else if (mod && key === '-') zoomBy(wc, -0.5);
  else if (mod && key === '0') zoomBy(wc, 0);
  else if (mod && key === 'd') toggleBookmark();
  else if (process.platform === 'darwin' && input.meta && key === 'h') app.hide(); // Cmd+H hides the app on macOS; History is Cmd+Y
  else if (mod && key === 'h') openHistoryPage();
  else if (mod && key === 'p') wc?.print({}, () => {});
  else if (mod && key === ',') openSettingsPage(); // [settings]
  else if (process.platform === 'darwin' && input.meta && key === '[') wc?.navigationHistory.goBack();
  else if (process.platform === 'darwin' && input.meta && key === ']') wc?.navigationHistory.goForward();
  else if (process.platform === 'darwin' && input.meta && key === 'y') openHistoryPage();
  else if (input.alt && key === 'arrowleft') wc?.navigationHistory.goBack();
  else if (input.alt && key === 'arrowright') wc?.navigationHistory.goForward();
  else if (key === 'f5') reloadActive();
  else if (key === 'f11' && process.platform !== 'darwin') win?.setFullScreen(!win.isFullScreen());
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

// The conversation is encrypted with the OS keychain; with no keychain (common on Linux) it isn't
// kept at all, rather than as a plain-text file. Tool results (page text, screenshots, script
// output) and the page text attached to each message (page context) are not kept on disk.
// New chat bumps chatGeneration: a run it stopped must not write the old chat back afterwards.
let chatGeneration = 0;
function saveChat(generation = chatGeneration) {
  if (generation !== chatGeneration) return;
  clearTimeout(saveChatTimer);
  try {
    if (!safeStorage.isEncryptionAvailable()) { fs.rmSync(CHAT_FILE(), { force: true }); return; }
    const snapshot = agent.snapshot();
    const keep = (msg, b) => {
      if (b.type === 'tool_result') return { type: 'tool_result', tool_use_id: b.tool_use_id, is_error: b.is_error, content: '(result not saved between sessions)' };
      if (b.type === 'text' && msg.role === 'user') return { ...b, text: b.text.replace(PAGE_BLOCK, '') };
      return b;
    };
    snapshot.messages = snapshot.messages.map((msg) => (Array.isArray(msg.content) ? { ...msg, content: msg.content.map((b) => keep(msg, b)) } : msg));
    const data = { enc: safeStorage.encryptString(JSON.stringify(snapshot)).toString('base64') };
    const tmp = `${CHAT_FILE()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, CHAT_FILE()); // never a half-written chat.json
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
app.on('before-quit', () => saveChat());

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
  // A sleeping tab has no webContents to read a URL from; its sleep snapshot stands in, so closing
  // Lumen while a tab happens to be asleep doesn't silently drop it from the next launch's session.
  const urlOf = (t) => (alive(t) ? realUrl(t.view.webContents) : t.sleeping ? t.sleepUrl || '' : '');
  const saved = tabs.filter((t) => isWebUrl(urlOf(t)));
  const urls = saved.map(urlOf);
  const titleOf = (t) => (alive(t) ? t.view.webContents.getTitle() : t.sleepTitle || '');
  writeSettings({ ...readSettings(), session: {
    urls,
    titles: saved.map(titleOf), // shown on the restored tabs, which don't load until they're opened
    active: Math.max(0, saved.findIndex((t) => t.id === activeId)),
    groupIds: saved.map((t) => t.groupId || null),
    pinned: saved.map((t) => Boolean(t.pinned)),
    groups: tabGroups.snapshot(),
  } });
}

function restoreSession() {
  // [settings] On startup: continue where you left off (default), a new tab, or chosen pages.
  const startup = settingsBackend.startupPlan();
  if (startup.mode === 'newtab') { openTab(); return; }
  if (startup.mode === 'pages') {
    startup.pages.forEach((url, i) => openTab(url, { background: i > 0 }));
    switchTab(tabs[0].id);
    return;
  }
  const { session: saved } = readSettings();
  if (!saved?.urls?.length) {
    openTab();
    return;
  }
  tabGroups.restore(saved.groups);
  const active = Math.min(Math.max(0, saved.active || 0), saved.urls.length - 1);
  let activeTabId = null;
  saved.urls.forEach((url, i) => {
    // Only the tab you were on loads now; the rest load when first opened (addRestoredTab).
    if (i === active) activeTabId = openTab(url, { background: true }).id;
    const tab = i === active ? tabs.find((t) => t.id === activeTabId) : addRestoredTab(url, saved.titles?.[i]);
    const groupId = saved.groupIds?.[i];
    if (groupId && tabGroups.groups.has(groupId)) tab.groupId = groupId;
    else tab.userRemoved = true; // restore the session as it was: don't regroup tabs left loose
    if (saved.pinned?.[i] && !tab.groupId) tab.pinned = true;
  });
  tabGroups.cleanup();
  tabGroups.arrange();
  switchTab(activeTabId ?? tabs[0].id);
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
        { label: 'New Tab', ...shown('Cmd+T'), click: () => openTab() },
        { label: 'Reopen Closed Tab', ...shown('Cmd+Shift+T'), click: () => { if (closedTabs.length) openTab(closedTabs.pop()); } },
        { label: 'Open Location…', ...shown('Cmd+L'), click: focusAddress },
        { type: 'separator' },
        { label: 'Print…', ...shown('Cmd+P'), click: () => wc()?.print({}, () => {}) },
        { type: 'separator' },
        { label: 'Close Tab', ...shown('Cmd+W'), click: () => { if (activeId) requestCloseTab(activeId); } },
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
      preload: path.join(__dirname, 'preload.bundle.js'), // preload.js with the toolbar element inlined (scripts/bundle-preload.js)
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: TEST ? [require('./test-mode').PRELOAD_FLAG] : [], // preload.js's test-only calls
    },
  });
  uiContents.add(win.webContents);
  // The taskbar button's icon: Lumen.exe's own is Electron's (see features/instance.js appIcon).
  if (process.platform === 'win32' && app.isPackaged) {
    win.setAppDetails({ appId: APP_ID, appIconPath: instance.appIcon(), appIconIndex: 0, relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: 'Lumen' });
  }
  Menu.setApplicationMenu(process.platform === 'darwin' ? macMenu() : null);
  win.webContents.on('before-input-event', (event, input) => handleShortcut(event, input));
  hardenOwnView(win.webContents, UI_URL);
  // will-navigate doesn't see loads started from the main process: if anything ever points the UI
  // elsewhere, put the UI straight back (the IPC gate already ignores any other document meanwhile).
  win.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument || isUiUrl(details.url)) return;
    const wc = win?.webContents;
    setImmediate(() => { if (wc && !wc.isDestroyed()) wc.loadFile(UI_HTML).catch(() => {}); });
  });
  win.on('close', saveSession);
  // The window is gone (on macOS the app can keep running): the session was just saved, so end
  // the tab pages too, or a video or call kept playing with no window to stop it.
  win.on('closed', () => { uiReady = false; dropDeadWindowViews(); });
  // The browser UI's own page crashed: reload it and send it the tabs again, instead of leaving a
  // dead window. The tabs themselves live in their own processes and are unaffected.
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || !ui()) return;
    console.error(`[lumen] browser UI process gone (${details.reason}); reloading it`);
    ui().reload();
  });
  let uiHungAsked = false;
  win.webContents.on('unresponsive', () => {
    if (uiHungAsked) return;
    uiHungAsked = true;
    dialogs.showMessageBox(win, {
      type: 'warning', buttons: ['Wait', 'Reload Lumen'], defaultId: 0, cancelId: 0,
      message: "Lumen's window isn't responding",
      detail: 'Your tabs are safe. Reloading redraws the toolbar and sidebar.',
    }).then(({ response }) => { if (response === 1 && ui()) ui().forcefullyCrashRenderer(); });
  });
  win.webContents.on('responsive', () => { uiHungAsked = false; });
  win.webContents.on('did-finish-load', () => {
    if (!uiReady) return; // the first load: set up below
    sendTabs(); // a reload after a crash: bring the fresh UI up to date
    const items = agent.transcript();
    if (items.length) ui()?.send('agent:history', { items });
  });
  win.on('focus', () => ui()?.send('window-focus', true));
  win.on('blur', () => ui()?.send('window-focus', false));
  win.on('resize', () => { hideSuggestions(); dialogs.layout(); if (tabs.some((t) => t.fullscreen)) layout(); });
  win.on('blur', hideSuggestions);
  win.loadFile(UI_HTML);
  win.webContents.once('did-finish-load', () => {
    createSuggestView();
    restoreSession();
    const items = agent.transcript();
    if (items.length) ui()?.send('agent:history', { items });
    uiReady = true;
    openLinksFromOtherApps(pendingLinks.splice(0));
  });
}
let uiReady = false; // the window's UI has loaded and its tabs are open
// The title bar buttons follow the theme (one listener for the app, not one per window reopened).
nativeTheme.on('updated', () => {
  if (process.platform !== 'darwin' && ui()) win.setTitleBarOverlay(titleBarOverlay());
});

// ---------- links from other apps: Lumen as the default browser ----------
// A link clicked in another app arrives as a command-line argument (at launch, or through
// 'second-instance' when Lumen is already running) or, on macOS, as 'open-url'.
const pendingLinks = [];
const linksIn = (argv) => argv.slice(1).filter((arg) => /^https?:\/\//i.test(arg));
function openLinksFromOtherApps(urls) {
  if (!urls.length) return;
  if (!uiReady) { pendingLinks.push(...urls); return; }
  urls.forEach((url, i) => openTab(url, { background: i < urls.length - 1 }));
  focusWindow();
}
pendingLinks.push(...linksIn(process.argv));
app.on('open-url', (event, url) => { event.preventDefault(); openLinksFromOtherApps([url]); });
// Registering is the user's choice (the ⋯ menu), never done silently. Windows then needs its own
// Default apps page to confirm; macOS asks by itself.
function makeDefaultBrowser() {
  // Run from source (`electron .`), the registered command must include the app folder.
  const args = process.defaultApp ? [process.execPath, [path.resolve(process.argv[1] || '.')]] : [];
  for (const scheme of ['http', 'https']) app.setAsDefaultProtocolClient(scheme, ...args);
  if (process.platform === 'win32') shell.openExternal('ms-settings:defaultapps').catch(() => {});
}
const isDefaultBrowser = () => app.isDefaultProtocolClient('https');

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

// [settings] the AI agent (and MCP clients, which use it) never gets the settings tab as its page.
const agentActiveTab = () => { const t = activeTab(); return t && tabs.find((x) => x.id === t.id)?.settings ? null : t; };
// Why there's no page to work on while the settings tab is in front (instead of "No tab is open").
const noTabReason = () => (tabs.find((t) => t.id === activeId)?.settings
  ? 'The active tab is Lumen Settings, which the assistant cannot read or control. Use switch_tab or open_tab to work on a web page.'
  : null);
// A task's pinned tab (agent.js taskScope), looked up by id: never the settings tab; a sleeping one
// is woken, since the agent is about to use it.
const agentTabById = (id) => {
  const t = tabs.find((x) => x.id === id);
  if (t?.sleeping) wakeTab(t);
  return t && alive(t) && !t.settings ? { id: t.id, webContents: t.view.webContents } : null;
};
const agentHasUnsavedInput = (id) => { const t = tabs.find((x) => x.id === id); return alive(t) ? hasUnsavedInput(t.view.webContents) : false; };
// How Claude is reached, so an expired sign-in isn't reported as a bad API key.
const anthropicAuth = () => (storedApiKey() ? 'key' : process.env.ANTHROPIC_API_KEY ? 'env' : cliAuth.profileState().signedIn ? 'cli' : null);
const agent = new Agent({
  activeTab: agentActiveTab, tabById: agentTabById, noTabReason, listTabs, openTab, switchTab, closeTab, requestCloseTab,
  hasUnsavedInput: agentHasUnsavedInput, groupTabs: groupTabsFor, ungroupTabs: ungroupTabsFor, effectiveModel, anthropicAuth,
  autoApprove: () => TEST || readSettings().askBeforeActing === false,
}, getClient, () => ({ adhdMode: readSettings().adhdMode !== false, model: effectiveModel() || DEFAULT_MODEL }), providerKey);
if (TEST) {
  global.__agent = agent;
  global.__fitContext = require('./agent').fitContext;
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
  global.__markDragged = (id) => { const t = tabs.find((x) => x.id === id); if (t) t.userMoved = true; };
  global.__tabsArray = () => tabs.map((t) => ({ id: t.id, groupId: t.groupId || null, userRemoved: Boolean(t.userRemoved), pinned: Boolean(t.pinned), sleeping: Boolean(t.sleeping) }));
  global.__pinTab = pinTab;
  global.__openHistoryPage = openHistoryPage;
  global.__zoomBy = (step) => zoomBy(activeTab()?.webContents, step);
  global.__installExtension = (id) => installExtension(id, { session: session.defaultSession });
  global.__isContentBlocker = isContentBlocker;
  global.__adblock = { ready: adblock.ready, blocked: adblock.blocked };
  global.__downloads = { list: () => downloads.list.map((d) => ({ ...d })), menu: () => downloads.menu() };
  global.__patchSettings = (patch) => writeSettings({ ...readSettings(), ...patch });
}

// ---------- [settings] lumen://settings ----------

const settingsBackend = settingsPage.create({
  chromeHintHeaders: UA_HINT_HEADERS, // [identity] Sec-CH-UA on every secure request, as Chrome sends
  app, session, nativeTheme, dialog, shell, readSettings, writeSettings, ui,
  win: () => win,
  tabContents: () => tabs.filter((t) => alive(t) && !t.settings).map((t) => t.view.webContents),
  tabsInfo: () => tabs.filter(alive).map((t) => ({ id: t.id, title: t.view.webContents.getTitle(), wc: t.view.webContents, settings: Boolean(t.settings) })),
  history: () => history,
  saveHistory: saveHistorySoon,
  downloads: downloads.list,
  sendDownloads: downloads.send,
  permissionDecisions,
  uninstallExtension,
  cliPinnedVersion: () => cliAuth.PINNED_VERSION,
  openTab: (url) => openTab(url),
  isSettingsSender,
  onSearchEngineReset: () => ui()?.send('search-engine', engineFor(DEFAULT_ENGINE)),
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
// Homepage "Ask AI" full-page chat: the UI covers the whole content area, so hide the native view
// instead of resizing it (see chatFullTab above). content-bounds keeps arriving meanwhile — layout()
// just ignores it while this is set, so the two never fight over the view's bounds.
ipcMain.on('chat:full', (_e, on) => {
  chatFullTab = on ? activeId : null;
  layout();
});
ipcMain.on('tab:new', (_e, url) => {
  const internal = url && settingsPage.parseSettingsInput(url); // [settings] lumen://settings
  if (internal) openSettingsPage(internal.section);
  else openTab(url ? resolveInput(url) : undefined);
});
ipcMain.on('tab:close', (_e, id) => requestCloseTab(id));
ipcMain.on('tab:switch', (_e, id) => switchTab(id));
ipcMain.on('tab:move', (_e, id, toIndex) => {
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
    tab.groupId = target;
    tab.userRemoved = !target;
  }
  tab.userMoved = true; // placed by hand: automatic grouping leaves it alone
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
ipcMain.on('downloads:menu', (_e, { x, y }) => Menu.buildFromTemplate(downloads.menu()).popup({ window: win, x: Math.round(x), y: Math.round(y) }));
ipcMain.on('zoom:reset', () => zoomBy(activeTab()?.webContents, 0));
ipcMain.on('nav:go', (_e, text) => {
  const wc = activeTab()?.webContents;
  if (!wc) return;
  // [settings] lumen://settings opens the settings tab (in place of a blank new tab); anything typed
  // into the settings tab opens in a normal tab in its place.
  const current = tabs.find((t) => t.id === activeId);
  const internal = settingsPage.parseSettingsInput(text);
  if (internal) { openSettingsPage(internal.section, { replace: !current?.settings && isNewTab(wc.getURL()) ? activeId : null }); return; }
  if (current?.settings) { replaceTab(activeId, resolveInput(text)); return; }
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

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
ipcMain.on('agent:ask', (event, text, runId, images = []) => {
  const valid = (Array.isArray(images) ? images : [])
    .filter((img) => IMAGE_TYPES.has(img?.media_type) && typeof img.data === 'string' && img.data.length < 7_000_000 && /^[A-Za-z0-9+/]+=*$/.test(img.data))
    .slice(0, 5);
  const generation = chatGeneration;
  agent.run(String(text || ''), (msg) => {
    if (!event.sender.isDestroyed()) event.sender.send('agent:event', { ...msg, runId });
    if (msg.type === 'done') saveChat(generation);
    else if (msg.type === 'tool_done') saveChatSoon(generation);
    else if (msg.type === 'error' && msg.signInExpired) { cliLoginValid = false; client = null; ui()?.send('models-updated'); }
  }, valid);
});
ipcMain.on('agent:stop', () => agent.stop());
ipcMain.on('agent:reset', () => {
  chatGeneration++;
  clearTimeout(saveChatTimer);
  agent.reset();
  fs.rm(CHAT_FILE(), { force: true }, () => {});
});
ipcMain.on('agent:approve', (_e, approvalId, ok) => agent.resolveApproval(approvalId, ok));
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
function effectiveModel(preferred = readSettings().model) {
  const options = modelOptions().filter((o) => o.id !== 'openrouter:__more');
  // Any OpenRouter model counts once there is a key: "More models…" can pick ones not in the short list.
  const openRouterPick = /^openrouter:[\w.-]+\/[\w.:-]+$/.test(String(preferred)) && Boolean(providerKey('openrouter'));
  if (options.some((o) => o.id === preferred) || openRouterPick || aiAgents.engineDetecting(preferred)) return preferred;
  return options[0]?.id || null;
}

ipcMain.handle('settings:get', () => {
  const options = modelOptions();
  const model = effectiveModel();
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
    searchEngine: readSettings().searchEngine || DEFAULT_ENGINE,
    searchEngines: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, label: e.label, url: e.url })),
    model,
    models: options,
    // For the empty sidebar's "get started" card: nothing to answer with unless some model is connected.
    ready: Boolean(model),
    claudeCode: options.some((o) => o.id === 'claudecode:default'),
  };
});
// A key is checked with the provider before it's saved, so a typo shows up here, not as an error on
// the first message. Offline (can't check), it's saved anyway, and the caller is told so.
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
  const { models } = await providers.openRouterCatalog({ cacheFile: OPENROUTER_CACHE() });
  return models.map(({ id, name, tools }) => ({ id, name, tools }));
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
    clearInterval(watch);
    cancelOpenRouterSignIn = null;
    server.close();
    if (authTab && tabs.some((t) => t.id === authTab)) setTimeout(() => { if (tabs.some((t) => t.id === authTab)) closeTab(authTab); }, 1200);
    resolve(result);
  };
  cancelOpenRouterSignIn = () => finish({ ok: false, cancelled: true, message: 'OpenRouter sign-in was cancelled.' });
  // Closing the sign-in tab (or it failing to load, offline, and the user closing it) cancels at
  // once, instead of leaving the button disabled until the 5-minute timeout.
  const watch = setInterval(() => { if (authTab && !tabs.some((t) => t.id === authTab)) cancelOpenRouterSignIn?.(); }, 700);
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
      finish({ ok: false, message: `OpenRouter sign-in failed: ${err.message}` });
    }
  });
  const timer = setTimeout(() => finish({ ok: false, message: 'OpenRouter sign-in timed out. Try again.' }), 5 * 60 * 1000);
  server.on('error', (err) => finish({ ok: false, message: `OpenRouter sign-in couldn't start: ${err.message}` }));
  server.listen(0, '127.0.0.1', () => {
    const callback = `http://127.0.0.1:${server.address().port}/callback`;
    const url = `https://openrouter.ai/auth?${new URLSearchParams({ callback_url: callback, code_challenge: challenge, code_challenge_method: 'S256', key_label: 'Lumen' })}`;
    authTab = openTab(url).id;
  });
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
  writeSettings({ ...readSettings(), model: id });
  // Mid-reply the switch waits for the next message (agent.setModel); the sidebar says so.
  return agent.setModel(id) ? 'next-message' : true;
});
ipcMain.handle('settings:set-auto-group', (_e, on) => setAutoGroup(on));
ipcMain.handle('settings:set-tab-grouping', (_e, mode) => setTabGrouping(mode));
ipcMain.handle('settings:set-topic-ai', (_e, on) => { writeSettings({ ...readSettings(), topicAi: Boolean(on) }); return true; });
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
  userTabs: () => tabs.filter(alive).map((t) => ({ id: t.id, webContents: t.view.webContents })),
});

// ---------- updates from GitHub Releases (features/updates.js) ----------

const updates = require('./features/updates').createUpdates({
  app, ipcMain, session, ui, readSettings, writeSettings, test: TEST,
  prefs: () => settingsBackend.prefs(),
  beforeInstall: () => { saveSession(); saveChat(); }, // the installer may close Lumen before its windows do
});
if (TEST) global.__updates = updates;

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
  instance.fixShortcutIcons(app, shell);
  aiAgents.start(); // MCP server, CDP automation (if on), Claude Code detection
  settingsBackend.start(ipcMain); // [settings] theme, spell check, proxy, request headers, prefs:* IPC
  setupPermissions();
  downloads.setup();
  loadChat();
  loadHistory();
  // Extensions must be ready before tabs exist so every tab is registered with chrome.tabs.
  await setupExtensions().catch((err) => console.error('Extension support failed to start:', err));
  // Filter lists: from the cache they load in a moment, so tabs wait for them (restored tabs would
  // otherwise load unfiltered, and without the document-start scriptlets). The first run's download
  // doesn't hold up the window.
  const blocking = adblock.setup().catch((err) => console.error('Ad blocker failed to start:', err));
  if (fs.existsSync(path.join(app.getPath('userData'), 'adblock-engine.bin'))) await blocking;
  for (const provider of Object.keys(providers.PROVIDERS)) if (providerKey(provider)) refreshModels(provider);
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(__dirname, 'assets', 'icon.png'));
  createWindow();
  updates.start(); // first check after a short delay, then every few hours
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
