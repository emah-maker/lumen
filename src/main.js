const { app, BrowserWindow, WebContentsView, ipcMain, Menu, Notification, clipboard, dialog: electronDialog, nativeTheme, net, safeStorage, screen, session, shell, components, systemPreferences } = require('electron');
// The main process's ~4 MB of modules are compiled once and kept on disk (V8's code cache, keyed by each file's
// contents): later launches skip most of the ~70 ms of parsing and compiling before the window can be made.
try { require('module').enableCompileCache?.(require('path').join(require('os').tmpdir(), 'lumen-compile-cache')); } catch { /* compiled as before */ }
// Test mode (CLAUDE_BROWSER_TEST), honoured only when not packaged: see test-mode.js.
const TEST = require('./test-mode').isTest();
// Never run from the install folder (the Start-menu shortcut starts us there): a program we start would inherit it and Windows would keep the next update from renaming the folder for as long as it runs (ai/cli-utils.js).
try { require('./ai/cli-utils').leaveInstallDir(); } catch { /* stays where it is */ }
if (TEST) require('./test-mode').standInWebStore(); // (an extension test's download server: before the extension library loads and keeps its fetch)
const perf = TEST ? require('./features/perf-hooks').install(__filename) : { mark() {} }; // startup marks and timer counts (test/e2e/perf-budget.js)
if (TEST) global.__perf = perf;
// A test run or a development run never opens the installed Lumen's profile (features/profile-guard.js): its userData is a
// throwaway folder. First, before anything reads userData ("--mcp" is only the stdio bridge and sets its own below).
if (!process.argv.includes('--mcp')) require('./features/profile-guard').apply(app, { test: TEST });

// `Lumen --mcp`: an AI agent (Claude Code, Codex, Antigravity…) started us as its MCP server. Run
// only the stdio bridge, before loading anything else (no window, no lock, nothing on stdout).
if (process.argv.includes('--mcp')) {
  if (TEST && process.env.CLAUDE_BROWSER_PROFILE) app.setPath('userData', process.env.CLAUDE_BROWSER_PROFILE);
  require('./automation/mcp').runBridge({ app });
  return;
}
// [hang recorder] Names what the main process was doing when "Lumen is not responding" (features/hang-recorder.js): breadcrumbs around every
// ipcMain handler and window event (wrapped here, before any module registers one) and around layout() and sendTabs() below, watched by a
// worker thread that writes <userData>/diagnostics/hangs.jsonl. hang.mark(label, fn, a, b) records fn(a, b).
const hang = require('./features/hang-recorder').install({ app, ipcMain, BrowserWindow });
if (TEST) global.__hangRecorder = hang;
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
// One running copy per profile, taken as early as the profile is known (profile-guard above has set userData, which the lock is keyed on):
// a second copy used to load the rest of this file's ~100 ms of modules first and took over 2 s to hand its links to the running one and leave.
const singleInstance = process.argv.includes('--install-shortcuts') || require('./features/instance').acquireInstanceLock(app);
if (!singleInstance) { app.quit(); return; } // (the running copy got our arguments through 'second-instance')
// An update swap that Windows cut short (logoff, shutdown) leaves a journal next to the install: finish it, or put the old version back.
if (process.platform === 'win32' && !TEST) { try { const p = require('path'); const dir = p.dirname(process.execPath); const j = p.join(p.dirname(dir), p.basename(dir) + '.swap.journal'); if (fs.existsSync(j)) require('./features/swap-helper').recover(j); } catch { /* the install is left as it is */ } }
const path = require('path');
// Every window's icon. Windows gets the .ico (its small sizes are ready to use): decoding the 1024 px PNG held up
// each new window by ~45 ms, the first one included. (macOS ignores it; Linux takes the PNG.)
const WINDOW_ICON = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const { pathToFileURL } = require('url');
const { netFetch } = require('./browser/net-fetch');
const matchPattern = require('./browser/match-pattern'); // which pages an extension's content scripts apply to
const { shortcutMod, shortcutKey, extraShortcut, appCommandAction } = require('./browser/shortcut-mod'); // Cmd on macOS, Ctrl elsewhere; F6, F3, Ctrl+F4; the mouse's back / forward buttons
const { reloadAction } = require('./browser/reload-action');
const editMenu = require('./browser/edit-menu'); // Cut / Copy / Paste (and Paste and Go) for the browser's own text fields
// The extension libraries (electron-chrome-extensions, electron-chrome-web-store with its zip reader) load in setupExtensions,
// after the first window is created, so their ~25 modules are not read before it; these two are used later, on a click or a test.
const installExtension = (...args) => require('electron-chrome-web-store').installExtension(...args);
const uninstallExtension = (...args) => require('electron-chrome-web-store').uninstallExtension(...args);
const { replyOnThrow } = require('./ai/page-debug');
const { Agent, pageDebugShared, MODELS, DEFAULT_MODEL, EXTERNAL_TOOLS, PAGE_BLOCK, validateInput: validateToolInput, transcriptFor } = require('./ai/agent');
const { createChatStore, toMarkdown, cleanTitle, autoTitle } = require('./features/chat-store');
const { describeUsage, contextView } = require('./features/chat-usage');
const { createBurstLimit } = require('./features/popup-guard'); // caps windows/tabs one page opens in a burst
const hideActivity = require('./features/hide-activity'); // [hide activity] leaving the tab, split screen
const activityScripts = hideActivity.createFrameScripts(() => settingsBackend.prefs());
const providers = require('./ai/providers');
const aiFrames = require('./ai/frames'); // the AI reads and acts in embedded frames through this debugger session
if (TEST) global.__providers = providers;
const cliJson = require('./ai/cli-json');
cliJson.configure({ userSettings: () => readSettings().ccUserSettings === true }); // [cc settings] one-shot Claude Code runs follow Settings > AI too
const { engineModel } = require('./ai/cli-utils');
const { SEARCH_ENGINES, DEFAULT_ENGINE, engineFor, searchUrlFor, resolveInput: resolveAddressInput, internalPage: internalPageOf } = require('./browser/search');
// Optional features load on first use (startup stays lean).
const lazy = (load) => { let mod; return new Proxy({}, { get: (_t, key) => (mod ||= load())[key] }); };
const importer = lazy(() => require('./browser/importer'));
// [diagnostics] Settings > Advanced > Record tab-switch timings (features/switch-timing.js). Off by default: the module is not even loaded until the setting is on.
const switchTiming = lazy(() => require('./features/switch-timing').create({
  metrics: () => app.getAppMetrics(), gpuStatus: () => app.getGPUFeatureStatus(),
  versions: { lumen: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, arch: process.arch },
  extra: () => { // what could explain a slow switch besides the switch itself: the settings that decide whether a tab is loaded and kept ready, the OS, the launch switches (no site, no address)
    const st = readSettings();
    const s = tabSleep.normalize(st);
    const os = require('os');
    return {
      settings: { tabSleep: st.tabSleep !== false, unloadAfterMinutes: s.minutes, how: s.how, freezeFirstMinutes: s.freezeFirst, keepRecent: s.keepRecent, pressure: st.tabSleepPressure ?? null, onReturn: s.onReturn, tabReadyRecent: tabReady.cleanRecent(st.tabReadyRecent), tabPreload: st.tabPreload ?? null, performanceMode: perfMode.mode() },
      os: { release: os.release(), cpus: os.cpus().length, totalMemoryMB: Math.round(os.totalmem() / 1048576), freeMemoryMB: Math.round(os.freemem() / 1048576), onBattery: onBatteryNow() },
      launchSwitches: process.argv.slice(1).filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]),
      keptReadyNow: readyState().map((r) => r.why),
      mainErrors: mainErrorTail(), // the last lines of diagnostics/main-errors.log (no addresses, home folder removed)
    };
  },
}));
let switchTimingOn = false;
let switchTimingLoaded = false;
let switchInput = null; // { source, at }: the input now calling switchTab (set by the user's own click or Ctrl+Tab, and only then)
let switchHandle = null; // { h, id }: the switch being recorded
const cliAuth = lazy(() => require('./ai/cli-auth'));
const spotifyRedirectPort = () => require('./features/spotify-view').REDIRECT_PORT; // [widgets] Spotify's loopback sign-in
// The SDK needs `new`, which the plain get-trap `lazy()` proxy above can't forward, so it gets its
// own tiny cached accessor instead. Only the Claude API path (getClient, organizeTabsWithAi's catch)
// touches this; a session that only ever uses Claude Code, Grok, or another provider never loads it.
let anthropicSdk_ = null;
const anthropicSdk = () => (anthropicSdk_ ||= require('@anthropic-ai/sdk'));
const { createTabGroups, siteName, pathWords, siteHint } = require('./browser/tab-groups');
const taskbarTasks = require('./features/taskbar-tasks'); // the taskbar's "Close tabs the AI opened" (Jump List task / Dock menu)
const organizeAi = require('./features/organize-ai'); // Organize with AI: local first, the model refines
const fileTabs = require('./features/file-tabs'); // tabs that show a file (a PDF, a deck, a file from disk): what Organize and the strip's icons know of them
const organizeLearn = require('./features/organize-learn'); // what Organize learns from the user, duplicate tabs, idle rule
const zoomSteps = require('./features/zoom-steps'); // Ctrl+Plus/Minus walk Chrome's zoom stops
const { zoomKeyStep } = zoomSteps;
const findSelection = require('./features/find-selection'); // Ctrl+F starts from the page's selection
const pdfZoom = require('./features/pdf-zoom'); // Ctrl+Plus/Minus/0 and Ctrl+wheel drive the PDF viewer's own zoom
const { menuLabel } = require('./browser/menu-label'); // page titles and file names as menu labels (a literal & is written &&)
const navHistory = require('./browser/nav-history'); // Back / Forward's right-click list
const appMenuLayout = require('./features/app-menu-layout'); // the ⋯ menu folds into submenus to fit short windows
const sidebarTabsLib = require('./features/sidebar-tabs'); // [sidebar per tab] whether the AI sidebar is open, tab by tab
const sidebarOverlay = require('./features/sidebar-overlay'); // the AI sidebar floats over the new-tab page instead of re-flowing it
const { createAdblock, hostOf } = require('./features/adblock');
const { createDownloads } = require('./features/downloads');
const { createManagers, pageOf: managerPageOf } = require('./features/managers'); // Bookmarks and Downloads pages
const { createSiteActivity } = require('./features/site-activity');
const { createUsage } = require('./features/usage');
const { createDialogs } = require('./features/dialogs');
const { createSiteSecurity } = require('./features/site-security');
const { createAiSites, siteOf: aiSiteOf } = require('./features/ai-sites'); // [ai controls] "Turn off AI on this site"
const { createSafeBrowsing, GATE_FILTER } = require('./features/safe-browsing');
const instance = require('./features/instance');
const { createPrivateWindows } = require('./features/private-window');
const { t, i18n } = require('./features/i18n'); // UI strings (locales/)
const { createCoalescer } = require('./features/event-coalesce'); // streamed text sent in ~16 ms batches, not per token
const chatRunsLib = require('./features/chat-runs'); // [background chats] when to notify, and what it says
const notifyTarget = require('./features/notify-target'); // which tab a clicked chat notification opens, and keeping it alive until then
const tabChatsLib = require('./features/tab-chats'); // [chat per tab] which chat each tab shows, the cap on chats working at once
const manners = require('./features/ai-manners'); // [ai manners] tabs the AI opened, hands-off mode, the user's focus
const { createWidgets } = require('./features/widgets'); // [widgets] cards on the new-tab page
const SW = require('./features/spotify-web'); // [widgets] the Spotify widget's Web player: open.spotify.com in a view over the card
const AMW = require('./features/apple-music-web'); // [widgets] the Apple Music widget: music.apple.com in a view over the card (same view code, features/web-player.js)

const NEW_TAB_URL = pathToFileURL(path.join(__dirname, 'renderer', 'newtab.html')).href;
const isNewTab = (url) => url.startsWith(NEW_TAB_URL);
const HISTORY_URL = pathToFileURL(path.join(__dirname, 'renderer', 'history.html')).href;
const settingsPage = require('./settings/settings-backend'); // [settings] lumen://settings
const permissionModes = require('./features/permission-mode'); // [bypass permissions] ask | auto | bypass
const planModeLib = { approvedKeys: (plan) => require('./ai/plan-mode').approvedKeys(plan) }; // [plan mode] an approved plan's sites (loaded with the first approved plan)
const chatPage = require('./features/chat-page'); // lumen://chat: the sidebar's conversation as a full page
let chatPageRt = null; // its runtime (created below, with the agent)
const slidesViewer = require('./features/slides-viewer'); // PowerPoint decks (.pptx) shown in a tab (renderer/slides.html)
const slidesRt = slidesViewer.create({ cacheDir: path.join(app.getPath('userData'), 'slides-picture-cache') });
const emlViewer = require('./features/eml-viewer'); // saved emails (.eml) shown in a tab (renderer/eml.html)
const emlRt = emlViewer.create();
const sessionFiles = require('./features/session-files'); // file tabs in the saved session, and the "moved or deleted" page
const pdfViewer = require('./features/pdf-viewer'); // PDFs shown with a bundled pdf.js (renderer/pdfviewer.html), unless Settings says Chrome's viewer
const pdfRt = pdfViewer.create({ getSetting: () => pdfViewer.cleanSetting(settingsBackend.prefs().pdfViewer) });
const pdfHandler = pdfViewer.createHandler({ netFetchFor: (ses) => (url, init) => ses.fetch(url, init) });
// Save Page As, View Source, Reader mode and Picture in Picture (features/page-tools.js)
const pageTools = require('./features/page-tools').createPageTools({
  t,
  openTab: (...args) => openTab(...args),
  sendTabs: () => sendTabs(),
  downloadDir: () => settingsBackend.downloadDir(),
  showSaveDialog: (options) => (TEST && global.__pageToolsSaveDialog ? global.__pageToolsSaveDialog(options) : dialog.showSaveDialog(win, options)),
});
// On-device translation (features/translate-local.js): Mozilla's Bergamot in its own process, with language
// packs downloaded from Mozilla into <userData>/translation-models. Built on first use; the process starts
// on the first translation and stops after a few idle minutes, so nothing here costs anything at startup.
let translateLocalInstance = null;
function translateLocal() {
  if (!translateLocalInstance) {
    const local = require('./features/translate-local');
    const store = require('./features/translate-models').createModelStore({
      dir: path.join(app.getPath('userData'), 'translation-models'),
      fetch: (url, options) => (TEST && global.__translateNetHook ? global.__translateNetHook(url, options) : net.fetch(url, { ...options, headers: { ...options?.headers, 'user-agent': `Lumen/${app.getVersion()}` } })), // (Mozilla's CDN answers 406 to a browser user agent)
    });
    translateLocalInstance = local.createLocal({ store, fork: local.electronFork(require('electron').utilityProcess) });
    app.once('before-quit', () => translateLocalInstance.stop());
  }
  return translateLocalInstance;
}
// Page translation (features/translate.js): user-initiated; on this device by default, else the user's own connected AI.
const translate = require('./features/translate').createTranslate({
  get local() { return translateLocal(); },
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
const isInternal = (url) => isNewTab(url) || url.startsWith(HISTORY_URL) || settingsPage.isSettingsUrl(url) || pageTools.isInternal(url) || slidesViewer.isViewerUrl(url) || emlViewer.isViewerUrl(url) || pdfViewer.isViewerUrl(url) || Boolean(managerPageOf(url));
const ERROR_URL = pathToFileURL(path.join(__dirname, 'renderer', 'error.html')).href;
const UNLOADED_URL = pathToFileURL(path.join(__dirname, 'renderer', 'unloaded.html')).href; // [tabs] "Reload" page of an unloaded tab (Settings > Tabs > Page unloading: When you return to one)
const CERT_URL = pathToFileURL(path.join(__dirname, 'renderer', 'cert-error.html')).href; // certificate warning (features/site-security.js)
const SAFE_BROWSING_URL = pathToFileURL(path.join(__dirname, 'renderer', 'safe-browsing.html')).href; // features/safe-browsing.js
const FOCUS_URL = pathToFileURL(path.join(__dirname, 'renderer', 'focus-block.html')).href; // the page a blocked site shows (features/focus.js)
const isErrorPage = (url) => url.startsWith(ERROR_URL) || url.startsWith(CERT_URL) || url.startsWith(SAFE_BROWSING_URL) || url.startsWith(FOCUS_URL);
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
// Test runs are silent: no sound from pages (a YouTube test, a video on a test page) while someone works nearby.
if (TEST && !process.env.LUMEN_TEST_ALLOW_AUDIO) app.commandLine.appendSwitch('mute-audio'); // (LUMEN_TEST_ALLOW_AUDIO=1: a test that needs Chromium to report a tab as playing sound, e.g. NTUI_AUDIO=1 test/e2e/tabui.js)

// Playwright's electron.launch adds Chromium switches that turn the component updater off (--disable-component-update, --disable-background-networking), so
// Widevine never installs or registers in a test run: a music site then reports "no protected audio". A live run that needs real playback (test/e2e/live-spotify.js)
// asks for them back with LUMEN_TEST_WIDEVINE=1. Tests only; a normal launch never has those switches.
if (TEST && process.env.LUMEN_TEST_WIDEVINE === '1') for (const sw of ['disable-component-update', 'disable-background-networking']) app.commandLine.removeSwitch(sw);

// Test runs get a throwaway profile so they never touch the real session or key.
const APP_ID = 'com.lumen.browser';

// Lumen was "Claude Browser": carry the old profile (settings, history, bookmarks, extensions,
// saved chat) over to the new name once, before anything opens it.
if (!TEST && (app.isPackaged || process.env.LUMEN_DEV_REAL_PROFILE === '1')) {
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
// (A test run, electron.exe from a checkout, takes an ID of its own: it must not share the installed Lumen's taskbar
// group or the name Windows shows on its notifications.)
// (The stock electron binary made to look packaged, test/e2e/hardening.js, is a test too: its own ID, and no relaunch, which
// would start electron.exe on a temp entry script the test has already deleted: "Error launching app" on the user's screen.)
if (app.isPackaged && !instance.isInstalledExe()) app.relaunch = () => {};
if (process.platform === 'win32') app.setAppUserModelId(TEST || !instance.isInstalledExe() ? `${APP_ID}.test` : APP_ID); // taskbar grouping, notifications

// (A test run's userData was set by the profile guard at the top: CLAUDE_BROWSER_PROFILE, else a temp folder, never the real profile.)


// A stray error in the main process must not take the browser (and every open tab) down, or
// pop Electron's raw error box: log it and keep going.
function mainErrorTail() { try { return require('./features/error-log').create({ dir: () => path.join(app.getPath('userData'), 'diagnostics') }).tail(50); } catch { return []; } }
// They are also appended to <userData>/diagnostics/main-errors.log (features/error-log.js, loaded on the first error), since a packaged build has no stderr.
let mainErrorLog = null;
function logMainError(kind, value) {
  try {
    mainErrorLog ||= require('./features/error-log').create({ dir: () => path.join(app.getPath('userData'), 'diagnostics') });
    mainErrorLog.log(kind, value);
  } catch { /* the log is best effort and must never throw out of an error handler */ }
}
if (TEST) global.__logMainError = logMainError;
process.on('uncaughtException', (err) => { console.error('[lumen] uncaught exception:', err); logMainError('uncaughtException', err); });
process.on('unhandledRejection', (reason) => { console.error('[lumen] unhandled rejection:', reason); logMainError('unhandledRejection', reason); });

let win;
const ui = () => (win && !win.isDestroyed() ? win.webContents : null); // null once the window is gone

// Only the settings tab's own top-level settings document may use the prefs:* calls.
let spareSettings = null; // [settings intent] { view, timer }: the Settings page loading in a view of its own, before it is a tab (see prepareSettings)
function isSettingsSender(event) {
  return (tabs.some((t) => t.settings && alive(t) && t.view.webContents === event.sender) || (spareSettings && spareSettings.view.webContents === event.sender))
    && event.senderFrame === event.sender.mainFrame && settingsPage.isSettingsUrl(event.senderFrame?.url);
}
// Calls that change keys, sign-ins, what outside programs may do (MCP, the automation port) and
// imports answer only Lumen's own UI and its settings page. Today nothing else has a preload that
// could send them; this keeps it that way if a page or extension ever finds a way to.
const PRIVILEGED_IPC = /^(settings|openrouter|spotify|cli|import|mcp|automation|claudecode|antigravity|codex|skills|macros|connectors):/;
// Everything preload.js sends or invokes (the browser UI's own bridge): these answer only the UI's
// top-level renderer/index.html document, never a page that somehow got into that window or a frame
// inside it. test/e2e/hardening.js checks this list against preload.js.
const UI_ONLY_IPC = new Set([
  'content-bounds', 'content-bounds:ack', 'view:freeze', 'view:frozen', 'view:freeze-alive', 'view:thaw', 'chat:full', 'view:warm', 'gpu:restart',
  'tab:new', 'tab:close', 'tab:switch', 'tab:move', 'tab:context-menu',
  'group:context-menu', 'group:toggle', 'group:rename', 'tabs:organize', 'tabs:undo-organize',
  'bookmark:toggle', 'zoom:reset', 'downloads:menu', 'downloads:warm', 'page:reader', 'files:open',
  'nav:go', 'nav:back', 'nav:forward', 'nav:history-menu', 'nav:reload', 'find:start', 'find:stop', 'address:menu',
  'app-menu', 'prepare-settings', 'page-info:open', 'actions:overflow', 'ext:pins-sync', 'ext:pins-order', 'suggest:query', 'suggest:show', 'suggest:hide', 'address:touched',
  'settings-page:open', 'prefs:ui',
  'focus:state', 'focus:start', 'focus:menu', // [focus] the toolbar's focus button (features/focus.js)
  'agent:thumbs-visible', 'agent:open-preview', 'chips:info', 'chips:watch', 'chips:open', 'agent:ask', 'agent:stop', 'agent:prewarm', 'agent:reset', 'agent:rewind', 'agent:rewind-user', 'agent:version', 'agent:feedback', 'agent:screen-drop', 'agent:btw', 'agent:btw-cancel', 'agent:autocomplete', 'agent:autocomplete-cancel', 'agent:approve', 'agent:send-undo', 'agent:send-stop', 'agents:focus-pending', 'agent:auto-allow', 'agent:permission-mode', 'agent:undo', 'agent:undo-edits', 'agent:annotate', 'agent:ai-tabs-close', 'agent:ai-tabs-undo', 'agent:show-target', 'tabs:ask-list',
  'uploads:stash', 'uploads:discard', 'agent:upload-choose', // files attached to a message, and the "Choose file…" card (features/upload-files.js)
  'chat:sidebar-state', 'sidebar:set', 'chat:resync', 'chat:sidebar-target', // the sidebar asking which chat its window's front tab shows
  'memory:list', 'memory:undo', 'memory:forget', // [memory] the chat's "Remembered" row and /memory (ai/memory.js)
  'chats:list', 'chats:open', 'chats:share', 'chats:show-tab', 'chats:stop', 'chats:rename', 'chats:delete', 'chats:undo-delete', 'chats:pin', 'chats:archive', 'chats:search', 'chats:export', 'chats:markdown', 'chats:temporary', 'chats:project-save', 'chats:project-delete', 'chats:project-set', 'chats:project-move', 'chats:project-restore', 'chats:new-in-project', 'chats:project-pick-folder', 'chats:project-folder', 'chats:work-folder', 'chats:run-now', 'chats:close-tabs', 'chats:project-get', 'chats:project-files-add', 'chats:project-file-remove', 'chats:project-search', 'chats:project-link', 'chats:project-add-tab', 'chats:project-memory-forget', 'chats:project-defaults', 'chats:project-undo',
  'images:data', 'images:save', 'images:copy', 'images:remote', 'images:open-tab', // pictures the AI made (features/gen-images.js)
  'aifiles:preview', 'aifiles:open', // files the AI made: the file card's preview and Open / Show in folder (features/ai-files.js)
  'chat:open-page', 'chatpage:state', 'chatpage:back', 'chatpage:link',
  'pagecontext:get', 'pagecontext:set', 'ui:strings', 'usage:get',
  'tab:mute', 'tab:ai-off', 'tabs:hide-ai', 'tabs:hide-ai-menu', 'tabs:undo-ai-close', 'chat:open-note', 'phone:note-action', 'phone:wifi-open', 'tabsearch:closed', 'tabsearch:reopen', 'cmdbar:data', 'cmdbar:run', 'tab:dragprep', 'tab:dragstart', 'tab:dragmove', 'tab:selection', 'tab:move-block', 'tab:dragend', 'tab:dragcancel', 'translate:act',
  'tabs:strip-menu', 'tabs:side', // [side tabs] the layout menu, and the side list's saved width and fold
  'split:ratio', 'split:close', // [split view] the divider dragged, and its close button
  'tab:hover', 'tab:down', // the pointer resting on / pressing a tab: wakes a sleeping one ahead of the click
  'tab:switch-strip', // the strip drew a tab active: the switch-timing recorder's mark (id and time are checked in the handler)
  'notes:act', // [notes] the Notes panel and the "Add to notes" buttons (features/notes-hub.js; the chat page has it too: CHAT_IPC)
  'research:get', 'research:add-page', 'research:update', 'research:remove', 'research:pin', 'research:pin-selection', 'research:unpin', 'research:cite', 'research:open', // the research board
  'agent:helpers', // [subagents] on/off (the chat page has it too: CHAT_IPC)
  'agent:prefer-fractions', // [prefer fractions] /fractions on|off (the chat page has it too: CHAT_IPC)
  'agent:helper-stop', // the Stop button on a helper card in the chat (the chat page has it too: CHAT_IPC)
  'desktop:open', 'desktop:control', // [desktop apps] the Computer card's Open, Resume and Stop (the chat page has them too: CHAT_IPC)
  'passwords:act', // [passwords] the save bar and the key button (features/passwords.js)
  'files:list', 'files:pin', 'files:unpin', 'files:remove', 'files:clear', 'files:open-entry', 'files:show', 'files:find', 'files:relocate', 'files:search', 'files:attach', 'files:scan', 'files:restore', // [files] pinned and recent files, the picker (features/files.js; files:open is the dropped files above)
  ...require('./features/background-runner').CHANNELS, // background tasks
  'mission:open', // lumen://tasks from the Tasks panel and the More menu (the page itself is checked in its handlers)
  'dictation:status', 'dictation:transcribe', // [dictation] voice input in the chat box (the chat page has them too: CHAT_IPC)
  'offers:get', 'offers:act', // the "New in Lumen" card in the empty chat (the chat page has them too: CHAT_IPC)
  'meeting:state', 'meeting:context-get', 'meeting:context-save', 'meeting:prompt', 'meeting:live-start', 'meeting:live-stop', 'meeting:transcript-chunk', 'meeting:stealth', 'meeting:summarize', 'meeting:save-chat', // meeting helper (features/meeting.js CHANNELS; it loads on first use)
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
// [look] The accent colour's sheet for Lumen's own pages (made once the settings backend exists, below).
let accentCss = null;
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('dom-ready', () => accentCss?.apply(contents)); // [look] Lumen's own pages take the accent colour (features/accent-css.js)
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
    // [agent window] A page of an agent's window (or its UI settling) speaking is not the user arriving there: it must not become
    // the window that links from other apps, the taskbar and the shortcuts act on. Once the user has the window focused, it is theirs.
    if (rec?.agent && !rec.win.isFocused()) return withWindow(rec, run);
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
const closedChipTabs = new Map(); // [tab chips] id -> { t, u }: the last title and address of a tab that closed (a chip for it still reads)
const closedTabs = []; // URLs, most recent last
const closedInfo = []; // what each closedTabs entry was besides its address: pinned, group, place, back/forward (features/closed-tabs.js)
const closedTabsKept = require('./features/closed-tabs');
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

// [sync] Sync through a folder (features/sync-folder.js, loaded only while it is on): the stores tell it when they changed.
let syncSvc = null;
const syncTouch = (...kinds) => { if (syncSvc) for (const k of kinds) syncSvc.touch(k); };
const syncTouchSettings = (prev, next) => { if (syncSvc) syncSvc.touchSettings(prev, next); }; // (bookmarks, widgets and preferences live in settings.json: only a change to one of those counts)
let settingsGen = 0; // bumped by every write: an async write that is no longer the latest doesn't land
// Every change: the cache (what readSettings returns) at once, the file off the main thread (a synchronous write,
// with its fsync, backup and rename, took ~27 ms of input time for a bookmark star or a widget move).
let settingsPending = false; // an async write not yet known to be on disk
// [chat per tab] Set where the run slots exist: a changed cap acts at once (a higher one starts the chats waiting).
let onSettingsWritten = null;
// shownPick (below) is what every model picker shows; it is declared later, so this may run before it exists (start-up writes).
function dropShownPick() { try { shownPick = null; } catch { /* not declared yet */ } }
function writeSettings(settings) {
  if (settings?.model !== settingsCache?.model) dropShownPick(); // (the saved model changed by any path: the pickers follow it again; settings:set-model sets its own pick after)
  const before = settingsCache;
  settingsCache = { ...settings };
  onSettingsWritten?.(settingsCache);
  syncTouchSettings(before, settingsCache);
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
  if (settings?.model !== settingsCache?.model) dropShownPick(); // (the saved model changed by any path: the pickers follow it again; settings:set-model sets its own pick after)
  const before = settingsCache;
  settingsCache = { ...settings };
  onSettingsWritten?.(settingsCache);
  syncTouchSettings(before, settingsCache);
  settingsPending = false;
  settingsGen++;
  settingsFile.writeJsonAtomic(SETTINGS_FILE(), settings);
}
const aiSites = createAiSites({ readSettings, writeSettings });

// Performance mode (features/performance.js): the disk cache cap has to be set before the app is
// ready, and the weekly Code Cache check runs before Chromium opens that folder.
const perfMode = require('./features/performance').create({
  app, readSettings, powerMonitor: () => (TEST ? (global.__fakePower ||= new (require('events'))()) : require('electron').powerMonitor), // (a test emits speed-limit and thermal events on a fake: a real laptop sends its own)
  onChange: () => { try { settingsBackend.pushUiPrefs(); } catch { /* the UI isn't up yet */ } },
});
perfMode.applyLaunchSwitches();
// [gpu health] Chromium blocks WebGL for a site after a few GPU resets; with this off, maps and canvases keep working after one.
app.disableDomainBlockingFor3DAPIs();
try { require('./features/performance').trimCodeCache(app.getPath('userData'), perfMode.limits().codeCacheBytes); } catch (err) { console.error('[lumen] cache check failed:', err.message); }
if (TEST) global.__perfMode = perfMode;
// Graphics: Automatic / Full effects / Light (settings/settings-backend.js (the [igpu] block)). Decided once from the GPU in use, never from power events.
const graphicsMode = settingsPage.graphics.create({
  app, readSettings,
  launchSoftware: readSettings().hardwareAcceleration === false || process.argv.includes('--lumen-safe-gpu') || app.commandLine.hasSwitch('disable-gpu'), // [software mode] no GPU drawing from the first frame: Automatic is the software level
  onChange: () => { try { settingsBackend.pushUiPrefs(); refreshNewTabs(); } catch { /* the UI isn't up yet */ } },
});
if (TEST) global.__graphics = graphicsMode;
app.whenReady().then(() => graphicsMode.detect()); // which GPU draws: asked once, as soon as the GPU process is up

// Favicons out of settings.json and into their own debounced/async store (see favicon-store.js) —
// settings.json is rewritten fully and synchronously, which a new favicon shouldn't have to pay for.
// One-time migration: move any favicons an older build saved inline, then drop the key for good.
const { createFaviconStore } = require('./browser/favicon-store');
const faviconStore = createFaviconStore(app.getPath('userData'), readSettings().favicons);
if (readSettings().favicons) {
  const { favicons, ...rest } = readSettings();
  writeSettings(rest);
}
// One-time cleanup: tab wake pictures (an older build kept one per page on disk) are gone, and so is their setting.
fs.promises.rm(path.join(app.getPath('userData'), 'tab-snapshots'), { recursive: true, force: true }).catch(() => {});
if ('tabSnapshots' in readSettings()) {
  const { tabSnapshots, ...rest } = readSettings();
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
  require('./automation/launcher').handOver(app, () => singleInstance);
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
// [local AI] Ollama / LM Studio on this computer (settings.localAI; ai/local-models.js, loaded on first use). No key: "connected" means switched on.
providers.setLocalSource({
  get: () => readSettings().localAI,
  chatOnly: (model) => { // the server refused tools for this model: the picker marks it "chat only" from now on
    const cfg = require('./ai/local-models').clean(readSettings().localAI);
    const models = cfg.models.some((m) => m.id === model) ? cfg.models.map((m) => (m.id === model ? { ...m, tools: false } : m)) : [...cfg.models, { id: model, tools: false }];
    writeSettings({ ...readSettings(), localAI: { ...cfg, models } });
    modelsChanged();
  },
});
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
  if (provider === 'local') return readSettings().localAI?.enabled === true ? 'local' : null; // no key; just switched on
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
// [auto model] The picker's "Auto" (ai/auto-model.js, docs/auto-model.md): which connected model answers a request. The router
// is pure; this is its settings: the models turned off for Auto (autoExclude), the provider the user was on before choosing Auto
// (autoHome), the models this account was refused (in memory) and the cooldowns fallback.js keeps. Nothing leaves this computer.
const autoModel = require('./ai/auto-model');
const autoDenied = autoModel.createDenied();
const autoExcluded = () => (Array.isArray(readSettings().autoExclude) ? readSettings().autoExclude : []);
// scope: a provider's own Auto ('grokbuild:auto' -> 'grokbuild'): only that provider's models. When none of them can answer (all out of
// usage or unavailable) and "Switch models automatically" is on, it behaves like a picked model that ran out: the same vendor's other
// route first, then any connected model (decision.outOfScope, said in the chat).
function autoRoute({ request, last = null, allowEngines = true, apiOnly = false, scope = null, strict = false } = {}) {
  const options = modelOptions().filter((o) => (!apiOnly || !aiFallback.isEngine(o.id)) && !o.id.startsWith('local:')); // (Auto never picks a local model: its names say nothing about what it can do)
  const args = { options, request, last, prefer: autoModel.preferFrom({ lastId: last, home: readSettings().autoHome }), exclude: autoExcluded(), denied: autoDenied.set(), cooldowns: aiFallback.shared, allowEngines };
  return autoModel.routeOrFallBack({ ...args, scope }, { fallbackOn: fallbackOn(), strict, related: scope ? aiFallback.relatedOf(scope) : [] });
}
function autoEscalate({ current, failure, request, tried = [], allowEngines = true, scope = null }) {
  return autoModel.escalate({ options: modelOptions(), current, failure, request, tried, prefer: autoModel.preferFrom({ lastId: current, home: readSettings().autoHome }), exclude: autoExcluded(), denied: autoDenied.set(), cooldowns: aiFallback.shared, allowEngines, scope });
}
// A model for a one-shot job outside the chat (topic naming, Organize, translation, a skill's proposal): the open chat's
// pick when it is a model, else Auto's cheapest fit for `kind`. apiOnly: no CLI engine (translation runs one request per chunk).
function autoConcrete(id, kind = 'quick', { apiOnly = false } = {}) {
  if (!autoModel.isAuto(id)) return id;
  const d = autoRoute({ request: { kind, prompt: '' }, last: agent.messages?.settings?.autoLast?.id || null, apiOnly, scope: autoModel.scopeOf(id) });
  return d.id || null;
}
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
      const name = (provider === 'openrouter' && providers.openRouterName(model)) || (provider === 'local' && model.replace(/:latest$/, '')) || modelNames.prettyModel(model) || model;
      const snap = modelNames.snapshotOf(model);
      const isFree = provider === 'openrouter' && (/:free$/.test(model) || providers.openRouterInfo(model)?.free || providers.openRouterInfo(model)?.pricePerM === 0);
      const badges = [...new Set([...(isFree ? ['free'] : []), ...modelNames.badgesFor(model, { chatOnly })])];
      const orInfo = provider === 'openrouter' ? providers.openRouterInfo(model) : null;
      const fmt = require('./renderer/picker-match').format; // the catalog's own rules ($1.25, 128K)
      const orDetail = orInfo ? [orInfo.context ? t('models.context', { n: fmt.size(orInfo.context) }) : '', orInfo.pricePerM < 0 ? t('models.priceVaries') : orInfo.pricePerM > 0 ? (orInfo.pricePerM < 0.01 ? t('models.priceTiny') : t('models.price', { n: fmt.money(orInfo.pricePerM) })) : ''].filter(Boolean).join(' · ') : '';
      return { id: `${provider}:${model}`, label: name, name, provider: info.label, badges, ...(recentOR.has(model) ? { recent: true } : {}), ...(provider === 'local' ? { context: 32768 } : {}), ...(orInfo ? { price: orInfo.pricePerM, context: orInfo.context, ...(typeof orInfo.vision === 'boolean' ? { vision: orInfo.vision } : {}) } : {}), detail: snap ? `Snapshot ${snap}` : provider === 'local' ? require('./ai/local-models').LABELS[readSettings().localAI?.flavor] || 'On this computer' : orDetail, title: chatOnly ? `${model}\nCan’t act in your tabs` : model };
    });
    if (provider === 'openrouter') entries.push({ id: 'openrouter:__more', label: t('models.more'), name: t('models.more'), provider: info.label, detail: t('models.more.detail'), more: true });
    groups.push({ label: info.label, entries });
  }
  groups.sort((a, b) => a.label.localeCompare(b.label));
  const options = groups.flatMap((g) => g.entries.map((e) => ({ ...e, group: g.label })));
  options.push(...aiAgents.modelOptions()); // local engine(s) last: the user's own Claude Code CLI, when installed
  return options;
}

// Settings > AI > "Auto may use": one row per connected provider or CLI engine, on unless the user turned it off for Auto.
function autoProviderList(options = modelOptions()) {
  const seen = new Map();
  for (const o of options) {
    if (o.more || String(o.id).endsWith(':__more') || autoModel.isAuto(o.id) || String(o.id).startsWith('local:')) continue;
    const key = aiFallback.providerOf(o.id);
    if (!seen.has(key)) seen.set(key, { key, label: aiFallback.providerName(o.id, options), on: !autoExcluded().includes(key) });
  }
  return [...seen.values()];
}
// What every picker lists: Auto first (no heading), then the connected models, each provider's group led by its own Auto (when it has
// two or more models to choose between, or the open chat is on it). modelOptions() stays the real models only: the fallback and the
// router must never see an Auto as one. The rows say what Auto chose last in the open chat ("Auto · Haiku").
function pickerOptions(options = modelOptions()) {
  if (!options.some((o) => !o.more)) return options;
  const s = agent.messages?.settings;
  // "last used" only while that model is still connected (a removed key or a signed-out engine would make it a stale name)
  const lastRaw = s?.autoLast || null;
  const last = lastRaw && options.some((o) => o.id === lastRaw.id && o.signedIn !== false && !(o.badges || []).includes('sign in')) ? lastRaw : null;
  const pick = chatModelPick() ?? readSettings().model ?? null;
  const withOwn = autoModel.withProviderAutos(options, { pick, last, exclude: autoExcluded(), dedupe: true, describe: (scope) => t('models.auto.providerDetail', { name: autoModel.scopeName(scope) }) });
  // The levels each model takes, for the effort row of the model menu (ai/effort.js): none for Auto, local models and the rest.
  const effortLib = require('./ai/effort');
  const withEfforts = (o) => (o.more || autoModel.isAuto(o.id) ? o : { ...o, efforts: effortLib.offered(o.id, { anthropicHasEffort: Boolean(MODELS[o.id]?.effort) }) });
  return [autoModel.pickerEntry({ last: last && !last.scope ? last : null, describe: t('models.auto.detail') }), ...withOwn].map(withEfforts);
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

// ---------- print preview: Ctrl+P and every Print entry (features/print-preview.js) ----------
const printPreview = lazy(() => require('./features/print-preview').createPrintPreview({
  t, strings: () => i18n().strings, readSettings, writeSettings, win: () => win,
  paths: { preload: path.join(__dirname, 'preload', 'print-preview-preload.js'), html: path.join(__dirname, 'renderer', 'print-preview.html') },
  restoreFocus: (wc) => { if (wc && !wc.isDestroyed()) wc.focus(); },
  downloadsDir: () => app.getPath('downloads'),
  isPdfTab: (wc) => Boolean(pdfZoom.viewerFrame(wc)) || pdfViewer.isViewerUrl(wc.getURL()), // a PDF tab is previewed and printed as the document it is
  pdfUrlOf: (url) => pdfViewer.pdfUrlOf(url), // (Lumen's own viewer: the PDF behind its address)
}));
// Print…: the preview sheet over the window of the tab `wc` (a private window passes its own).
let printSheetOpen = false;
function printTab(wc, host) {
  if (!wc || wc.isDestroyed()) return;
  printSheetOpen = true;
  printPreview.open({ wc, host, title: wc.getTitle() }).catch((err) => console.error('[lumen] print preview:', err.message)).finally(() => { printSheetOpen = printPreview.isOpen(); });
}
// Print Using System Dialog… (Ctrl+Shift+P): the OS's own dialog, no preview.
const printSystem = (wc) => printPreview.printWithSystemDialog(wc);
if (TEST) global.__printPreview = { printPreview, printTab, printSystem };

// ---------- what's new after an update (features/whats-new.js): once, over the first window ----------
const whatsNew = lazy(() => require('./features/whats-new').createWhatsNew({
  app, readSettings, writeSettings, t, test: TEST,
  showNotes: (opts) => dialogs.showNotes(opts),
}));
if (TEST) global.__whatsNew = whatsNew;
// "New in Lumen: want to turn these on?" card in the empty chat, for features that ship off (features/feature-offers.js).
const featureOffers = lazy(() => require('./features/feature-offers').createFeatureOffers({
  readSettings, writeSettings, t, test: TEST,
  setSetting: (key, value) => settingsBackend.set(key, value),
  ready: () => ({ dictation: Boolean(dictationState().provider) }), // voice input already works (a key is set): nothing to offer
}));
// The card asks, and answers one click at a time; 'turn-on' of a "set up" feature only opens its Settings section.
ipcMain.handle('offers:get', () => featureOffers.get());
ipcMain.handle('offers:act', async (_e, action, arg) => {
  const offers = featureOffers;
  if (action === 'shown') { offers.onShown(Array.isArray(arg) ? arg.filter((x) => typeof x === 'string').slice(0, 20) : []); return { ok: true }; }
  if (action === 'dismiss') return offers.dismiss({ never: arg === 'never' });
  if (action === 'act' && typeof arg === 'string') return offers.act(arg);
  return { ok: false };
});
if (TEST) global.__featureOffers = featureOffers;

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
const pageInfo = lazy(() => require('./features/page-info').createPageInfo({
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
}));
function openPageInfo(point = null) {
  const wc = activeTab()?.webContents;
  if (!wc || wc.isDestroyed()) return Promise.resolve(null);
  return pageInfo.open({ url: realUrl(wc), ses: wc.session, security: siteSecurity.stateOf(wc), point });
}
ipcMain.on('page-info:open', (_e, point) => openPageInfo(point && typeof point === 'object' ? point : null)); // (UI-only: UI_ONLY_IPC)

// Keyboard Shortcuts (⋯ menu, Help menu, Ctrl+Shift+/): the list in Lumen's own dialog (features/shortcuts-help.js).
const shortcutsHelp = lazy(() => require('./features/shortcuts-help').createShortcutsHelp({ t, showNotes: (opts) => dialogs.showNotes(opts) }));

// "Lumen didn't shut down correctly": offers the last run's tabs when the startup setting wouldn't bring them back (features/crash-recovery.js).
const crashBurst = (...args) => require('./features/crash-cap').crashBurst(...args); // (loaded with the first crash)
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

// Focus mode (features/focus.js): sites on the user's list are blocked while a session is on. The main-frame gate asks it first, then Safe
// Browsing. The module loads only once focus is used (a started session, a schedule, the toolbar button's menu): nothing at start-up.
let focusCtl = null;
function focusFeature() {
  return focusCtl ||= require('./features/focus').create({
    dir: app.getPath('userData'),
    readSettings,
    pageUrl: FOCUS_URL,
    isTab: (wc) => Boolean(tabByContents(wc)) || privateWindows.ownsTab(wc), // (a private window's tabs too)
    tabContents: () => tabs.filter((tab) => alive(tab) && !tab.settings).map((tab) => tab.view.webContents),
    broadcast: (state) => { for (const wc of new Set([ui(), ...[...winRecs].filter(rcAlive).map((r) => r.win.webContents)])) if (wc && !wc.isDestroyed()) wc.send('focus:changed', state); },
  });
}
const FOCUS_IDLE = { active: false, source: null, start: 0, until: 0, remainingMs: 0, allows: [], next: null };
const focusIsOn = () => Boolean(focusCtl) && focusCtl.state().active;
// Start-up: a started session that is still running, or a schedule, needs the gate from the first page on.
function startFocus() {
  try {
    const s = readSettings();
    if ((Array.isArray(s.focusSchedules) && s.focusSchedules.some((x) => x && x.on !== false)) || fs.existsSync(path.join(app.getPath('userData'), 'focus-session.json'))) focusFeature();
  } catch { /* focus mode is not worth a failed start */ }
}
// Settings: a schedule or the site list changed.
function onFocusSettings() {
  const s = readSettings();
  if (focusCtl || (Array.isArray(s.focusSchedules) && s.focusSchedules.some((x) => x && x.on !== false))) focusFeature().settingsChanged();
}
// session.webRequest.onBeforeRequest for pages: Focus mode first, then Safe Browsing.
function mainFrameGate(details, callback) {
  if (focusCtl && focusCtl.gate(details, callback)) return;
  safeBrowsing.gate(details, callback);
}
// The toolbar button's menu (renderer/focus.js): durations to start, or the time left and how to end it.
ipcMain.handle('focus:state', () => (focusCtl ? focusCtl.state() : FOCUS_IDLE));
ipcMain.handle('focus:start', (_e, minutes) => focusFeature().start(minutes));
ipcMain.on('focus:menu', (_e, point) => {
  const ctl = focusFeature();
  const at = { x: Math.round(Number(point?.x) || 0), y: Math.round(Number(point?.y) || 0) };
  Menu.buildFromTemplate(ctl.menuTemplate({ t, openStatus: () => openTab(ctl.statusUrl()), openSettings: () => openSettingsPage('focus') })).popup({ window: win, ...at });
});
// The block page (renderer/focus-block.html; its bridge is preload/error-preload.js): only a tab's own top frame showing that page may ask,
// and the site is the one in the page's own address.
const focusPageOf = (event) => (event.senderFrame === event.sender.mainFrame && String(event.senderFrame?.url).startsWith(FOCUS_URL)
  && (Boolean(tabByContents(event.sender)) || privateWindows.ownsTab(event.sender)) ? event.senderFrame.url : '');
ipcMain.handle('focus-page:state', (event) => (focusPageOf(event) ? (focusCtl ? focusCtl.state() : FOCUS_IDLE) : null));
ipcMain.handle('focus-page:allow', (event) => {
  const page = focusPageOf(event);
  if (!page || !focusCtl) return { ok: false };
  let target = '';
  try { target = new URL(page).searchParams.get('url') || ''; } catch { /* no address */ }
  return focusCtl.allow(target);
});
ipcMain.handle('focus-page:hold', (event, on) => {
  if (!focusPageOf(event) || !focusCtl) return null;
  if (on) return focusCtl.endBegin();
  focusCtl.endCancel();
  return null;
});
ipcMain.handle('focus-page:end', (event) => (focusPageOf(event) && focusCtl ? focusCtl.endConfirm() : { ok: false }));
ipcMain.on('focus-page:settings', (event) => { if (focusPageOf(event)) openSettingsPage('focus'); });
// Settings → General → Focus mode.
ipcMain.handle('settings:focus', () => {
  const ctl = focusFeature();
  return { state: ctl.state(), log: ctl.log().slice(-30).reverse() };
});
ipcMain.handle('settings:focus-start', (_e, minutes) => focusFeature().start(minutes));
ipcMain.handle('settings:focus-phrase', (_e, text) => require('./features/focus').parseSchedulePhrase(text));
if (TEST) global.__focus = { ctl: () => focusFeature(), idle: () => !focusCtl };

// HTTP Basic/Digest auth: a styled sign-in sheet instead of the native prompt.
app.on('login', (event, webContents, details, authInfo, callback) => {
  event.preventDefault();
  if (agentContents.has(webContents)) { callback(); return; } // [agent window] no sign-in sheet for a page nobody is watching
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

// ---------- page-first keys: Ctrl+S, Ctrl+P, Ctrl+F... reach the page before Lumen's own action (features/page-first-keys.js) ----------
// The preload (preload/page-first-keys-preload.js) says it runs in a frame, then reports each Ctrl / Cmd chord once the page has had it.
// Frames are named by process and routing id (a WebFrameMain object is not a stable key).
const pageFirstReady = new Set();
const frameKey = (f) => `${f.processId}:${f.routingId}`;
// A frame is covered when the preload ran in it, or in the main frame above it and every frame between is the same origin (the preload
// hooks those; a cross-origin frame is out of its reach, so a key typed there stays Lumen's at once, as before).
function pageFirstCovered(frame) {
  for (let f = frame; f; f = f.parent) {
    if (pageFirstReady.has(frameKey(f))) return true;
    const up = f.parent;
    if (!up || (f.origin !== up.origin && !/^(about:|data:)/.test(f.url))) return false;
  }
  return false;
}
const pageFirstKeys = lazy(() => require('./features/page-first-keys').create({ isReady: pageFirstCovered }));
ipcMain.on('page-first-keys:ready', (event) => { if (event.senderFrame) { if (pageFirstReady.size > 4000) pageFirstReady.clear(); pageFirstReady.add(frameKey(event.senderFrame)); } });
ipcMain.on('page-first-keys:done', (event, report) => pageFirstKeys.done(event.sender, report));
const PAGE_FIRST_PRELOAD = path.join(__dirname, 'preload', 'page-first-keys-preload.js');
if (TEST) global.__pageFirst = { ready: () => [...pageFirstReady], keys: pageFirstKeys, frameKey };

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
const pageDialogCancelled = (req) => (req?.kind === 'confirm' ? false : req?.kind === 'prompt' ? null : undefined);
ipcMain.on('page-dialog', replyOnThrow((event, req) => {
  const wc = event.sender;
  const silence = () => { event.returnValue = pageDialogCancelled(req); };
  if (dialogs.isOwnView(wc)) return silence(); // ignore requests from the overlay itself
  // [page debug] The AI is working in this tab: its alert is accepted and noted, a confirm/prompt waits for handle_dialog (ai/page-debug.js).
  // If the run that holds it ends or is stopped first, the user gets it through showToUser (page-debug.js releaseHeldFor).
  const respond = (accept, text) => { event.returnValue = req.kind === 'confirm' ? accept === true : req.kind === 'prompt' ? (accept === true ? String(text ?? req.defaultValue ?? '') : null) : undefined; };
  if (pageDebugShared.pageDialog(wc, req, respond, () => showToUser(event, req))) return;
  if (agentContents.has(wc)) return silence(); // [agent window] alert is dismissed, confirm says no, prompt cancels: nothing waits for a person who is not there
  showToUser(event, req);
}, pageDialogCancelled, (err) => console.error('[lumen] page-dialog:', err)));
// The user's overlay for a page's alert/confirm/prompt; the page's blocked call returns with the answer. Any failure answers it "cancel".
function showToUser(event, req) {
  const wc = event.sender;
  const silence = () => { event.returnValue = pageDialogCancelled(req); };
  const failed = (err) => { console.error('[lumen] page-dialog:', err); silence(); };
  try {
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
    }).then(({ response, values, checkboxChecked }) => finish(response === 1 && values ? values.value : null, checkboxChecked), failed);
  } else if (req.kind === 'confirm') {
    dialogs.showMessageBox(win, {
      title, message: req.message, buttons: [t('dialog.cancel'), t('dialog.ok')], defaultId: 1, cancelId: 0, owner: wc, checkboxLabel,
    }).then(({ response, checkboxChecked }) => finish(response === 1, checkboxChecked), failed);
  } else {
    dialogs.showMessageBox(win, {
      title, message: req.message, buttons: [t('dialog.ok')], defaultId: 0, cancelId: 0, owner: wc, checkboxLabel,
    }).then(({ checkboxChecked }) => finish(undefined, checkboxChecked), failed);
  }
  } catch (err) { failed(err); }
}
// A site's notification clicked (page-dialogs-preload.js): its tab comes to the front, in whichever window holds it, like Chrome.
ipcMain.on('page-notification:click', (event) => {
  const wc = event.sender;
  for (const rec of winRecs) {
    const t = rcAlive(rec) ? tabsOf(rec).find((x) => !x.closing && x.view?.webContents === wc) : null;
    if (t) { showTab(rec, t.id); return; }
  }
});
if (TEST) global.__notifyClick = { // chat notifications: tell(spec, kind) makes one for a fake run (no OS toast), click(item) is its click, activate() an activation without a click
  fakeRun: (spec) => { const messages = []; if (spec.aiNavTabId != null) messages.aiNavTabId = spec.aiNavTabId; if (spec.bind != null) chatBind.bind(spec.bind, spec.chatId); return { chatId: spec.chatId, messages, runId: 0, rec: curRec, pending: new Map(), reply: spec.reply || '', error: null, tabId: spec.tabId ?? null, homeTab: spec.homeTab ?? null }; },
  note: (spec, kind) => { noteChatInApp(global.__notifyClick.fakeRun(spec), kind); return global.__chatNotes.at(-1); }, // the strip's toast instead (Lumen in front, another tab)
  tell: (spec, kind) => { const run = global.__notifyClick.fakeRun(spec); const item = showNotification(run, kind); (global.__notifyClick.items ||= []).push(new WeakRef(item.n)); return global.__notifyClick.items.length - 1; },
  click: (i) => global.__notifyClick.items[i].deref().emit('click'), // (a collected notification would be undefined here: that is what the keeper prevents)
  activate: () => activateNotified(),
  kept: () => notifyKeeper.size(), isKept: (i) => { const n = global.__notifyClick.items[i].deref(); return Boolean(n) && notifyKeeper.has(n); }, collect: () => { global.gc?.(); return typeof global.gc === 'function'; },
  chatOf: (id) => chatBind.chatOf(id), openAi: (url) => openTab(url, { ai: true, show: false }).id, closeTab: (id) => closeTab(id),
  pick: (spec, kind) => notifyTarget.pickTab({ kind, ...spec }, (id) => Boolean(tabAnywhere(id))),
  open: (url) => openTab(url).id, switchTab: (id) => switchTab(id), activeId: () => activeId, contentsOf: (id) => tabs.find((t) => t.id === id)?.view?.webContents.id ?? null };
// Registered once the app (and so session.defaultSession) exists; a separate whenReady hook so it
// doesn't touch the app's main startup sequence.
app.whenReady().then(() => {
  pdfViewer.attachSession(session.defaultSession, pdfHandler);
  session.defaultSession.registerPreloadScript({ id: 'lumen-page-dialogs', type: 'frame', filePath: path.join(__dirname, 'preload', 'page-dialogs-preload.js') });
  // Dropdown menus stay readable on dark-styled sites (features/select-contrast-preload.js).
  session.defaultSession.registerPreloadScript({ id: 'lumen-select-contrast', type: 'frame', filePath: path.join(__dirname, 'features', 'select-contrast-preload.js') });
  session.defaultSession.registerPreloadScript({ id: 'lumen-page-first-keys', type: 'frame', filePath: PAGE_FIRST_PRELOAD });
  session.defaultSession.registerPreloadScript({ id: 'lumen-error-page', type: 'frame', filePath: path.join(__dirname, 'preload', 'error-preload.js') }); // the error page's strings (preload/error-preload.js)
  session.defaultSession.registerPreloadScript({ id: 'lumen-files-newtab', type: 'frame', filePath: path.join(__dirname, 'preload', 'files-newtab-preload.js') }); // [files] the new-tab page's Files widget (features/files.js)
  session.defaultSession.registerPreloadScript({ id: 'lumen-newtab-ai', type: 'frame', filePath: path.join(__dirname, 'preload', 'newtab-preload.js') }); // [newtab-images] the new-tab page's Ask AI hand-off (window.lumenNewtab)
  session.defaultSession.registerPreloadScript({ id: 'lumen-permissions', type: 'frame', filePath: path.join(__dirname, 'preload', 'permissions-preload.js') }); // pages read 'prompt' before a decision, as in Chrome (browser/site-permissions.js)
  // [hide activity] Settings → Privacy: pages can't see you leave the tab, or the window's real size (features/hide-activity.js).
  hideActivity.installIpc(ipcMain, () => settingsBackend.prefs());
  session.defaultSession.registerPreloadScript({ id: 'lumen-hide-activity', type: 'frame', filePath: hideActivity.PRELOAD });
  session.defaultSession.registerPreloadScript({ id: 'lumen-webauthn-gate', type: 'frame', filePath: path.join(__dirname, 'preload', 'webauthn-preload.js') }); // passkeys through Windows' WebAuthn, or the API hidden (features/passkeys.js decides per frame)
  // Google in a dark theme paints dark from the first frame (features/google-dark-preload.js).
  session.defaultSession.registerPreloadScript({ id: 'lumen-google-dark', type: 'frame', filePath: path.join(__dirname, 'features', 'google-dark-preload.js') });
  // The AI's hidden reader/search views (agent.js, partition 'claude-reader') load pages nobody
  // sees: they get no permissions at all (camera, location, notifications, …) and no downloads.
  const reader = session.fromPartition('claude-reader');
  reader.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  reader.setPermissionCheckHandler(() => false);
  reader.on('will-download', (event, item) => { event.preventDefault(); try { item.cancel(); } catch {} });
  require('./ai/read-speed').installReaderFilter(reader, 'claude-reader'); // reading needs text, not images, media or fonts: cancelled in this session only
});

// ---------- permissions: ask like Safari, remember per origin ----------

const SITE_PERMISSIONS = require('./browser/site-permissions'); // canonical origins, what pages read, the always-allowed list
const thirdPartyBlocked = () => ({ blockThirdPartyCookies: Boolean(settingsBackend.prefs().blockThirdPartyCookies) });
const PROMPTABLE = {
  media: 'use your camera and microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  'clipboard-read': 'read your clipboard',
};
const permissionDecisions = new Map(); // `${origin}|${permission}` -> boolean

// [devices] WebHID, WebUSB and Web Serial: the chooser, and the devices the user picked per site (features/device-chooser.js).
// A tab the AI opened, an agent's window and the music cards never get the permission; Lumen's own pages are not http(s).
const DEVICE_PERMISSIONS = require('./browser/device-permissions');
const deviceGrants = DEVICE_PERMISSIONS.createGrantStore({ onChange: (store) => settingsBackend.saveDeviceGrants(store.toJSON()) });
const deviceChooser = require('./features/device-chooser').createDeviceChooser({
  dialogs,
  t,
  webContentsFromFrame: (frame) => webContentsModule.fromFrame(frame),
  ordinary: (wc) => !(spotifyWeb.owns(wc) || appleMusicWeb.owns(wc) || agentContents.has(wc) || dialogs.isOwnView(wc) || manners.isAiTab(tabByContents(wc))),
});

// [dictation] The sidebar's window and the chat page may record audio for voice input (ai/dictation.js ownPageMic).
function ownPageMic(wc, permission, details) {
  if (permission !== 'media') return false;
  const own = (url) => isUiUrl(url) || chatPage.isChatUrl(url);
  const isOwnView = uiContents.has(wc) ? isUiUrl(wc.getURL()) : Boolean(chatPageRt?.everyChatTab().some((t) => t.view.webContents === wc));
  if (!isOwnView || details?.isMainFrame !== true) return false; // (the rule's own first checks: web pages and frames never load the dictation module)
  return require('./ai/dictation').ownPageMic({ permission, mediaTypes: details?.mediaTypes, requestingUrl: details?.requestingUrl, pageUrl: wc.getURL(), isMainFrame: details?.isMainFrame, isOwnView, isOwnPage: own });
}

function setupPermissions() {
  const ses = session.defaultSession;
  settingsBackend.loadPermissions(permissionDecisions); // [settings] decisions persist in settings.json
  deviceGrants.load(settingsBackend.loadDeviceGrants());
  deviceChooser.install(ses, { store: deviceGrants });

  ses.setPermissionRequestHandler(async (wc, permission, callbackAsked, details) => {
    // A page given the camera, the microphone or the screen is capturing: its tab is not put to sleep (tabSleep, canSleep)
    if (screenRec?.allowsPermission(wc, permission, details)) return callbackAsked(true); // [screen recording] the recorder window while a recording starts (the microphone only if switched on)
    if (musicReact.allowsDisplay(wc, permission, details)) return callbackAsked(true); // [look] the new-tab page's analyser may listen to the PC's sound (loopback), nothing else
    if (ownPageMic(wc, permission, details)) return callbackAsked(true); // [dictation] the chat box's voice input in Lumen's own sidebar and chat page; web pages still ask
    const callback = (ok) => { if (ok && (permission === 'media' || permission === 'display-capture')) mediaPages.add(wc); callbackAsked(ok); };
    if (spotifyWeb.owns(wc) || appleMusicWeb.owns(wc)) return callback(SW.permissionAllowed(permission)); // [widgets] the music cards: protected media only, never a prompt
    // [agent window] its pages are asked nothing and may not take the screen, the pointer or another app
    if (agentContents.has(wc) && (permission === 'openExternal' || permission === 'fullscreen' || permission === 'pointerLock' || permission === 'display-capture' || PROMPTABLE[permission])) return callback(false);
    if (SITE_PERMISSIONS.alwaysAllowed(permission, thirdPartyBlocked())) return callback(true);
    if (permission === 'openExternal') return callback(await askOpenExternal(wc, details));
    const reason = PROMPTABLE[permission];
    const origin = SITE_PERMISSIONS.requestOrigin(wc, details); // '' unless http(s)
    if (!reason || !origin) return callback(false);
    // What is still undecided (the camera and the microphone are decided separately): a device already refused refuses the request,
    // and the prompt asks only about the ones with no answer yet.
    const { deny, ask } = SITE_PERMISSIONS.plan(permissionDecisions, origin, permission, details, (p) => settingsBackend.permissionDefault(p) === 'block'); // [settings] default: Block
    if (deny) return callback(false);
    if (!ask.length) return callback(true);
    // Tied to the asking tab: it waits while that tab is in the background, and is dropped (not
    // remembered as a "no") if the tab navigates away or closes first.
    const { response, cancelled, checkboxChecked } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [t('permission.deny'), t('permission.allow')],
      defaultId: 0,
      cancelId: -1, // Esc answers "no" for this request only: nothing is saved (only a button click is, and only with "Remember my choice" ticked)
      checkboxLabel: t('permission.remember'), checkboxChecked: true,
      message: t('permission.ask', { host: new URL(origin).host, reason: t(SITE_PERMISSIONS.promptKey(permission, { mediaTypes: ask.map((d) => (d === 'camera' ? 'video' : 'audio')) })) }),
      owner: wc,
    });
    if (cancelled || (response !== 0 && response !== 1)) return callback(false);
    if (!checkboxChecked) return callback(response === 1); // "Remember my choice" unticked: allow or deny just this once
    for (const name of ask) permissionDecisions.set(`${origin}|${name}`, response === 1);
    settingsBackend.savePermissions(permissionDecisions); // [settings]
    callback(response === 1);
    SITE_PERMISSIONS.notify(ses); // open pages: PermissionStatus 'change'
  });
  // The check handler gets the origin with a trailing slash: read under the same canonical key the decision is stored under.
  ses.setPermissionCheckHandler((wc, permission, origin, details) =>
    screenRec?.allowsPermission(wc, permission, details) ? true : // [screen recording]
    musicReact.allowsDisplay(wc, permission, details) ? true : // [look] Music-reactive home screen (the new-tab page, the PC's sound only)
    wc && ownPageMic(wc, permission, { mediaTypes: [details?.mediaType], requestingUrl: details?.requestingUrl, isMainFrame: details?.isMainFrame }) ? true : // [dictation] Lumen's own chat boxes (audio only)
    DEVICE_PERMISSIONS.TYPES.includes(permission) ? deviceChooser.check(wc, permission, origin, details) : // [devices] hid, usb, serial
    spotifyWeb.owns(wc) || appleMusicWeb.owns(wc) ? SW.permissionAllowed(permission) : SITE_PERMISSIONS.alwaysAllowed(permission, thirdPartyBlocked()) || SITE_PERMISSIONS.allowedNow(permissionDecisions, SITE_PERMISSIONS.checkOrigin(origin, details), permission, details));
  SITE_PERMISSIONS.register(ses, { decisions: permissionDecisions, isBlocked: (permission) => settingsBackend.permissionDefault(permission) === 'block' });
  SITE_PERMISSIONS.installIpc(ipcMain);
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

// [screen recording] Record this tab / Record a screen or window to a .webm in Downloads (features/screen-recorder.js). Loaded on the first recording.
let screenRec = null;
const screenRecorder = () => (screenRec ||= require('./features/screen-recorder').createScreenRecorder({
  electron: require('electron'),
  preload: path.join(__dirname, 'preload', 'recorder-preload.js'),
  page: path.join(__dirname, 'renderer', 'recorder.html'),
  downloadDir: () => settingsBackend.downloadDir(),
  addDownload: (file) => downloads.addFile(file),
  anchor: () => win,
  t, toast,
  hidden: TEST && Boolean(process.env.LUMEN_TEST_BACKGROUND),
}));
app.on('before-quit', () => { try { screenRec?.shutdown(); } catch { /* nothing recording */ } }); // (what was recorded so far is kept)
const recordOptions = { mic: false, sound: true, mp4: false }; // the menu's two switches (the microphone is off until the person turns it on)
async function startRecording(kind, wc) {
  const r = await screenRecorder().start({ kind, wc, mic: recordOptions.mic, sound: recordOptions.sound, format: recordOptions.mp4 && recordMp4 === true ? 'mp4' : 'webm' });
  if (r.ok || r.error === 'cancelled' || r.error === 'busy' || r.error === 'closed') return;
  toast(t(r.error === 'mic' ? 'record.micFailed' : r.error === 'no-folder' ? 'record.noFolder' : 'record.failed'));
}
// Whether this Chromium's MediaRecorder can write MP4, asked once of the UI page (its answer is the same for every page). Until it is known, or if no, only WebM is offered.
let recordMp4 = null;
function probeRecordMp4() { ui()?.executeJavaScript("MediaRecorder.isTypeSupported('video/mp4;codecs=avc1')").then((ok) => { recordMp4 = ok === true; }, () => { recordMp4 = false; }); }
// The "Record" submenu (the ⋯ menu, File on macOS). While recording it holds Pause and Stop instead.
function recordMenu(wc) {
  const rec = screenRec;
  if (rec?.active()) {
    return [
      { label: t(rec.state().phase === 'paused' ? 'record.resume' : 'record.pause'), enabled: rec.state().phase !== 'starting', click: () => { rec.state().phase === 'paused' ? rec.resume() : rec.pause(); } },
      { label: t('record.stopItem'), click: () => { rec.stop(); } },
    ];
  }
  return [
    { label: t('record.tab'), enabled: Boolean(wc) && !wc.isDestroyed(), click: () => { startRecording('tab', wc); } },
    { label: t('record.screenItem'), click: () => { startRecording('screen'); } },
    { type: 'separator' },
    { label: t('record.sound'), type: 'checkbox', checked: recordOptions.sound, click: (item) => { recordOptions.sound = item.checked; } },
    { label: t('record.mic'), type: 'checkbox', checked: recordOptions.mic, click: (item) => { recordOptions.mic = item.checked; } },
    ...(recordMp4 === true ? [{ label: t('record.mp4'), type: 'checkbox', checked: recordOptions.mp4, click: (item) => { recordOptions.mp4 = item.checked; } }] : []),
  ];
}

// Screen sharing (Meet, Zoom, Teams on the web) failed outright: there was no handler for
// getDisplayMedia. The user picks an entire screen or one window from a menu of thumbnails;
// closing the menu shares nothing. `owner`: the window asking, when it isn't the current one (a private window).
async function pickScreenToShare(request, callback, owner = null) {
  { // [look] the music-reactive home screen listens to the PC's sound (loopback, a copy: nothing is muted); the video Chromium insists on is the page's to stop
    let wc = null; try { wc = require('electron').webContents.fromFrame(request.frame); } catch { /* gone */ }
    if (wc && musicReact.takeDisplay(wc, request.frame === wc.mainFrame)) return callback({ audio: 'loopback', video: request.frame });
  }
  let recordingScreen = false; // [screen recording] the recorder window asking for a screen or window: the same menu, titled for recording
  if (screenRec) {
    let wc = null; try { wc = require('electron').webContents.fromFrame(request.frame); } catch { /* gone */ }
    if (wc && screenRec.owns(wc)) { const streams = screenRec.takeDisplay(request, wc); if (streams) return callback(streams); recordingScreen = true; }
  }
  const shown = owner && !owner.isDestroyed() ? owner : win;
  let done = false;
  const answer = (streams) => {
    if (done) return;
    done = true;
    if (streams?.video) { try { mediaPages.add(require('electron').webContents.fromFrame(request.frame)); } catch { /* the page is gone */ } } // sharing the screen: its tab stays awake
    callback(streams);
  };
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
      { label: recordingScreen ? t('record.pickTitle') : host ? t('menu.shareWith', { host }) : t('menu.shareScreen'), enabled: false },
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
const mediaPages = new WeakSet(); // pages given the camera, microphone or screen since their last navigation
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
  // May a short snippet of a file's own text be described to a model (Organize with AI)? Not when AI is off for it (Turn off AI here: a site, or local files), and
  // not for a file on this computer while the AI is kept hands-off. Its name and folder still group it here.
  fileTextOk: (t) => { const url = alive(t) ? realUrl(t.view.webContents) : t.sleepUrl || ''; return !aiSites.isOff(url) && !(fileTabs.addressOf(url).startsWith('file:') && readSettings().aiHandsOff === true); },
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
// A tab that shows a file gets the first words of its text too, so a lecture's PDF joins the course's other tabs: a PDF in Lumen's viewer reads its
// first page (the viewer exposes it), a deck its first slide, a text or code file its first lines. Kept in memory with the tab, like a page's description.
function readFileText(tab) {
  const wc = tab.view.webContents;
  const url = realUrl(wc);
  const address = fileTabs.addressOf(url);
  if (!address) return;
  const apply = (text) => {
    if (!alive(tab) || realUrl(tab.view.webContents) !== url) return;
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (clean === (tab.pageText || '')) return;
    tab.pageText = clean;
    scheduleAutoGroup();
  };
  let read = Promise.resolve('');
  if (pdfViewer.isViewerUrl(url)) read = wc.executeJavaScript('new Promise((done) => { let n = 0; const timer = setInterval(() => { if (window.lumenPdf && window.lumenPdf.firstPageText) { clearInterval(timer); done(window.lumenPdf.firstPageText()); } else if (++n > 100) { clearInterval(timer); done(""); } }, 100); })', true); // (the viewer's module may still be loading)
  else if (slidesViewer.isViewerUrl(url)) { const deck = slidesViewer.deckUrlOf(url); if (deck) read = slidesViewer.loadSlideTexts(deck).then((slides) => slides[0] || ''); } else if (!emlViewer.isViewerUrl(url)) read = fileTabs.readTextHead(address); // (an email's words are not read for grouping: its subject is the tab's title)
  read.then(apply).catch(() => apply(''));
}
function readPageText(tab) {
  const wc = tab.view.webContents;
  if (groupingMode() !== 'topic') return;
  if (!isWebUrl(realUrl(wc))) { readFileText(tab); return; }
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
  mainFrameGate: (details, callback) => mainFrameGate(details, callback), // pages, before they load (Focus mode, then Safe Browsing)
});

// ---------- private windows (features/private-window.js) ----------
// Native dialogs there for permissions and downloads; Safe Browsing and certificate warnings use Lumen's
// own (features/dialogs.js draws them in the private window, the tab's own window).
const privateWindows = createPrivateWindows({
  BrowserWindow, WebContentsView, session, ipcMain, dialog: electronDialog, isWebUrl, Menu, clipboard, shell,
  resolveInput: (text) => resolveInput(text), iconPath: WINDOW_ICON,
  deviceChooser: () => deviceChooser, // [devices] WebHID, WebUSB, Web Serial: the chooser over the private window, grants kept in memory
  t, strings: () => i18n().strings, locale: () => i18n().locale,
  print: (wc, host) => printTab(wc, host), // Print… in a private window: the same preview, over that window
  testBackground: TEST && Boolean(process.env.LUMEN_TEST_BACKGROUND), // (TEST_BACKGROUND is declared further down)
  pageFirstKeys, // page-first keys in a private tab (features/page-first-keys.js)
  openNormalWindow: () => openNewWindow(), // Ctrl+N in a private window opens a normal one, as in Chrome
  screenshot: (ctx) => screenshotTool.open(ctx), // Ctrl+Shift+S in a private window (copies; Save as… is offered)
  // The protections a normal tab has: Safe Browsing (until the ad blocker takes over onBeforeRequest, which
  // sends pages to the same gate), the ad blocker's filters, readable dropdowns, and the profile's proxy,
  // Do Not Track / Global Privacy Control, languages and Chrome hints.
  prepareSession: (ses) => {
    ses.webRequest.onBeforeRequest(GATE_FILTER, (details, callback) => mainFrameGate(details, callback));
    pdfViewer.attachSession(ses, pdfHandler);
    ses.registerPreloadScript({ id: 'lumen-select-contrast', type: 'frame', filePath: path.join(__dirname, 'features', 'select-contrast-preload.js') });
    ses.registerPreloadScript({ id: 'lumen-error-page', type: 'frame', filePath: path.join(__dirname, 'preload', 'error-preload.js') });
    ses.registerPreloadScript({ id: 'lumen-permissions', type: 'frame', filePath: path.join(__dirname, 'preload', 'permissions-preload.js') });
    ses.registerPreloadScript({ id: 'lumen-page-first-keys', type: 'frame', filePath: PAGE_FIRST_PRELOAD }); // (private-window.js holds the keys)
    ses.registerPreloadScript({ id: 'lumen-hide-activity', type: 'frame', filePath: hideActivity.PRELOAD }); // [hide activity]
    ses.registerPreloadScript({ id: 'lumen-webauthn-gate', type: 'frame', filePath: path.join(__dirname, 'preload', 'webauthn-preload.js') }); // passkeys (private: Windows is told so; Lumen keeps nothing), or hidden (features/passkeys.js)
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
  thirdPartyCookiesBlocked: () => Boolean(settingsBackend.prefs().blockThirdPartyCookies),
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

// An extension that finished loading after the first tabs opened: pages loaded before it have none of its content
// scripts. In the first moments of a run, the page in front of each window reloads once when they match it (and
// nothing was typed in it). Never later: a reload then would lose the user's place.
const STARTED_AT = Date.now();
const EXTENSIONS_WAIT_MS = 250; // how long the first tabs wait for extensions
async function lateExtension(ext) {
  if (Date.now() - STARTED_AT > 20000) return;
  for (const rec of [...winRecs]) {
    if (!rcAlive(rec) || isSpare(rec) || rec.agent) continue;
    const front = tabsOf(rec).find((t) => t.id === activeIdOf(rec));
    if (!alive(front) || front.isolated || front.settings || front.lateReloaded || !isWebUrl(front.view.webContents.getURL())) continue; // (once per page: a second late extension doesn't reload it again)
    const wc = front.view.webContents;
    const busy = (await unsavedInputState(wc)) !== 'no';
    const [id] = matchPattern.pagesToReload(ext.manifest, [{ id: front.id, url: wc.getURL(), active: true, startedBeforeLoad: true, busy }]);
    if (id !== undefined && alive(front)) { front.lateReloaded = true; wc.reload(); }
  }
}

async function setupExtensions() {
  const ses = session.defaultSession;
  const { ElectronChromeExtensions } = require('electron-chrome-extensions');
  const { installChromeWebStore, loadAllExtensions, updateExtensions } = require('electron-chrome-web-store');
  const { extensionPermissionLines } = require('./browser/extension-permissions');
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
    const sizeIt = popup.setSize.bind(popup);
    let wanted = null; // the size the page asked for, in DIPs
    popup.setSize = (rect) => { sizeIt(rect); const v = popup.browserWindow; wanted = v && !v.isDestroyed() ? { width: v.getBounds().width, height: v.getBounds().height } : null; };
    popup.updatePosition = () => {
      place();
      const view = popup.browserWindow;
      if (!view || view.isDestroyed() || !win || win.isDestroyed()) return;
      // Moving the popup to a screen with another scale (Lumen on a 150% monitor, the popup first made on a 100% one) keeps its pixels, not its DIPs: it came out 2/3 size and clipped. Ask for its size again, now that it is on the right screen.
      const now = view.getBounds();
      if (wanted && (now.width !== wanted.width || now.height !== wanted.height)) view.setBounds({ ...now, ...wanted });
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
  perf.mark('extStoreReady');
  // One folder per extension, loaded side by side (the library loads them one after another, and one with a big rule
  // set takes seconds). Their background workers start after the first tabs, 300 ms apart from the tabs' own start.
  // An extension that finishes after the first tabs opened missed those pages' content scripts: lateExtension()
  // reloads the front page once if its scripts match it.
  const extensionsRoot = path.join(app.getPath('userData'), 'Extensions');
  const startWorker = (scope) => tabsGate.then(() => setTimeout(() => ses.serviceWorkers.startWorkerForScope(scope).catch(() => console.error(`Failed to start worker for ${scope}`)), 300));
  const loadTarget = { extensions: ses.extensions, serviceWorkers: { startWorkerForScope: (scope) => { startWorker(scope); return Promise.resolve(); } } };
  const folders = await fs.promises.readdir(extensionsRoot, { withFileTypes: true }).then((list) => list.filter((d) => d.isDirectory()).map((d) => path.join(extensionsRoot, d.name)), () => []);
  const seen = new Set();
  await Promise.all(folders.map((dir) => loadAllExtensions(loadTarget, dir).then(() => {
    perf.mark(`ext:${path.basename(dir).slice(0, 6)}`);
    for (const ext of ses.extensions.getAllExtensions()) {
      if (seen.has(ext.id)) continue;
      seen.add(ext.id);
      if (tabsGateOpen) lateExtension(ext).catch(() => {});
    }
  })));
  perf.mark('extLoaded');
  settingsBackend.extensionsLoaded().catch(() => {}); // [extensions] the ones installed before pins existed start pinned
  // Store extensions' updates: looked for once the first tab has loaded, then every 5 hours, as the library did.
  const checkUpdates = () => updateExtensions(ses).catch((err) => console.error('[lumen] extension update check failed:', err?.message || err));
  firstTabLoaded.then(() => setTimeout(checkUpdates, 30000).unref?.());
  setInterval(checkUpdates, 5 * 60 * 60 * 1000).unref?.();
}

// Help > Report an issue: the new-issue page with the version and OS filled in (nothing is sent until the user submits it on GitHub)
function reportIssueUrl() {
  const body = `**What happened**

**What you expected**

**Steps to reproduce**
1.

**Environment**
- Lumen: ${app.getVersion()}
- OS: ${process.platform} ${require('os').release()} (${process.arch})
`;
  return `https://github.com/emah-maker/lumen/issues/new?labels=bug&body=${encodeURIComponent(body)}`;
}

function extensionsMenu() {
  const installed = session.defaultSession.extensions.getAllExtensions()
    .filter((ext) => ext.manifest.name && !ext.id.startsWith('chrome-web-store'));
  const buttons = new Map(settingsBackend.listExtensions().map((e) => [e.id, e]));
  const items = installed.map((ext) => ({
    label: ext.name,
    submenu: [
      ...(buttons.get(ext.id)?.button
        ? [{ label: t('extension.showInToolbar'), type: 'checkbox', checked: buttons.get(ext.id).pinned, enabled: settingsBackend.prefs().extensionsToolbar === 'pinned', click: (item) => { settingsBackend.pinExtension(ext.id, item.checked); } }]
        : []),
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
if (TEST) global.__extensionsAppMenu = () => extensionsMenu().filter((i) => i.submenu).map((i) => ({ label: i.label, pin: i.submenu.find((s) => s.label === t('extension.showInToolbar')) ? { label: t('extension.showInToolbar'), enabled: i.submenu.find((s) => s.label === t('extension.showInToolbar')).enabled, checked: i.submenu.find((s) => s.label === t('extension.showInToolbar')).checked } : null }));

// The ⋯ menu. Its sections are listed flat, as they show on a tall window; on a short window or
// screen features/app-menu-layout.js folds the marked ones into submenus (More Tools first, then the
// page commands, zoom, the tab extras and the AI entries) until it fits below the button, so it
// doesn't open with scroll arrows or run past the window. { x, y, right } is the button's left,
// bottom and right edge in the UI's window coordinates (`right` is missing from older callers).
function showAppMenu({ x, y, right }) {
  prepareSettings(); // [settings intent] (the menu holds Settings: it is most often what the user is after)
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
        { label: t('menu.reopenTab'), accelerator: 'CmdOrCtrl+Shift+T', enabled: closedTabs.length > 0, click: reopenLastClosed },
        { label: t('menu.searchTabs'), accelerator: 'CmdOrCtrl+Shift+A', click: openTabSearch },
        { label: t('menu.commandBar'), accelerator: 'CmdOrCtrl+K', click: openCommandBar },
        { label: t('menu.openFile'), accelerator: 'CmdOrCtrl+O', click: openFileDialog },
        { label: t('menu.findFiles'), accelerator: 'CmdOrCtrl+Shift+F', click: openFilesPicker },
        { label: t('menu.receiveFromPhone'), click: () => { openWifiUpload().catch(() => {}); } }, // [phone wifi]
        ...mergeWindowItems(curRec),
      ], 'tabs', t('menu.tabsAndFiles'), 4),
      chunk([
        { label: t('menu.newSidebarChat'), accelerator: 'CmdOrCtrl+Shift+K', click: newSidebarChat },
        { label: t('menu.toggleSidebar'), accelerator: 'CmdOrCtrl+J', click: toggleSidebarFromKeys }, // (a page that uses Ctrl+J gets it first: the menu still shows it)
        { label: t('menu.openChatPage'), accelerator: 'CmdOrCtrl+Shift+L', click: toggleChatPage },
        ...bgTasks.menuItems(wc?.getURL()), // Run in the background, Watch this page, Background tasks
        { label: t('menu.missionControl'), accelerator: 'CmdOrCtrl+Shift+X', click: () => managers.open('tasks') }, // [mission control] lumen://tasks
        { label: t('menu.macros'), submenu: macrosFeature.menuTemplate({ t }) }, // run, record and manage macros
      ], 'ai', t('menu.aiAndTasks'), 5),
    ],
    [
      chunk([{ label: t('menu.find'), accelerator: 'CmdOrCtrl+F', click: openFindBar }]),
      chunk([
        { label: t('menu.zoomIn'), accelerator: 'CmdOrCtrl+=', click: () => zoomBy(wc, 0.5) },
        { label: t('menu.zoomOut'), accelerator: 'CmdOrCtrl+-', click: () => zoomBy(wc, -0.5) },
        { label: t('menu.actualSize'), accelerator: 'CmdOrCtrl+0', click: () => zoomBy(wc, 0) },
        ...(process.platform === 'darwin' ? [] : [{ label: t('menu.fullScreen'), accelerator: 'F11', click: () => win.setFullScreen(!win.isFullScreen()) }]),
      ], 'zoom', t('menu.zoom'), 3),
      chunk([
        { label: t('menu.print'), accelerator: 'CmdOrCtrl+P', enabled: Boolean(wc), click: () => printTab(wc) },
        { label: t('menu.printSystem'), accelerator: 'CmdOrCtrl+Shift+P', enabled: Boolean(wc), click: () => printSystem(wc) },
        { label: t('menu.savePageAs'), accelerator: 'CmdOrCtrl+S', enabled: web, click: () => pageTools.savePage(wc).catch(() => {}) },
        { label: t('menu.viewSource'), accelerator: 'CmdOrCtrl+U', enabled: web, click: () => pageTools.viewSource(wc.getURL(), { session: wc.session, openerId: activeId }) },
        { label: t('menu.screenshot'), accelerator: 'CmdOrCtrl+Shift+S', enabled: web, click: () => takeScreenshot(wc) },
        { label: t('menu.record'), submenu: recordMenu(wc) }, // [screen recording]
        { label: t('menu.qrCode'), enabled: web, click: () => showQrCode(wc) },
        ...(web && phoneReady() ? [{ label: t('phone.send.menu'), click: () => sendPageToPhone(wc) }] : []), // [phone files]
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
        { label: t('menu.closeAiTabs'), enabled: aiTabSelect({}).length > 0, click: () => { closeAiTabsEverywhere().catch(() => {}); } }, // [ai manners]
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
      // (loadJsonAsync restores the .bak, or sets an unparseable file aside as .corrupt-<time>: a bad file is never overwritten)
      const loaded = await settingsFile.loadJsonAsync(HISTORY_FILE());
      const saved = (Array.isArray(loaded) ? loaded : []).filter((h) => importer.isWorthImporting(h?.url));
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
const historyList = () => [...history.values()].sort((a, b) => b.last - a.last).slice(0, 5000);
let historyGen = 0; // bumped by every write: an async write that is no longer the latest (the quit-time sync one is newer) doesn't land
function saveHistorySoon() {
  historyDirty = true;
  if (syncSvc) syncSvc.touch('history');
  clearTimeout(historySaveTimer);
  historySaveTimer = setTimeout(() => {
    if (!historyLoaded) { saveHistorySoon(); return; } // (never overwrite the file with a list that is still missing its past)
    historyDirty = false;
    const gen = ++historyGen;
    settingsFile.writeJsonAtomicAsync(HISTORY_FILE(), historyList(), () => gen === historyGen, 0).catch(() => {}); // (tmp + rename + .bak, queued behind any write in flight)
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
  return scored.sort((a, b) => b.score - a.score).slice(0, 5).map(({ entry }) => ({ url: entry.url, title: entry.title, ...(history.has(entry.url) ? {} : { seed: true }) })); // (seed: a built-in suggestion never visited: the dropdown shows a globe, not the "recent" clock)
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

// The hovered link's address bubble: its module (and its view, made on the first hover) is not loaded until a link is hovered.
let linkStatusRt = null;
function linkHover(tab, url) {
  const rec = recOfSender(tab.view?.webContents);
  if (!rec || tab.id !== activeIdOf(rec) || !rec.win || rec.win.isDestroyed()) { if (!url && rec) linkStatusRt?.hide(rec.win); return; }
  if (!url && !linkStatusRt) return;
  linkStatusRt ||= require('./features/link-status').createLinkStatus({ WebContentsView, preloadPath: path.join(__dirname, 'preload', 'link-status-preload.js'), hardenOwnView, raise: (w) => { if (w === win) raiseOverlays(); } });
  linkStatusRt.update(rec.win, url, tab.view.getBounds());
}
ipcMain.on('linkstatus:dodge', (e) => linkStatusRt?.dodge(e.sender));

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
  downloadsView.webContents.on('before-input-event', (event, input) => handleShortcut(event, input)); // the panel takes the keyboard when opened: Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+T, Ctrl+W work from it too
  downloadsView.webContents.on('blur', () => setTimeout(() => { if (!downloadsView?.webContents.isFocused()) hideDownloadsPanel(); }, 0));
  downloadsView.webContents.loadFile(path.join(__dirname, 'renderer', 'downloads-panel.html'));
}
function placeDownloadsPanel(height) {
  if (!downloadsView || !downloadsAnchor || !win || win.isDestroyed()) return;
  const [width] = win.getContentSize();
  const x = Math.max(8, Math.min(downloadsAnchor.right - PANEL_WIDTH + 16, width - PANEL_WIDTH - 8));
  downloadsView.setBounds({ x: Math.round(x), y: Math.round(downloadsAnchor.bottom), width: PANEL_WIDTH, height: Math.round(Math.min(height, win.getContentSize()[1] - downloadsAnchor.bottom - 8)) });
}
// The panel's page made ahead (hidden), so the first click on the button does not wait for a renderer to start and load (about 100 ms). Asked for when the
// pointer or the keyboard reaches the button (a click follows) and shortly after a download starts, and only then: a window that never downloads never has one.
// A new view takes the focus while its first page loads (see createSuggestView), so a view that is not on screen gives the focus back to where it was.
function warmDownloadsPanel() {
  if (!win || win.isDestroyed() || (downloadsView && !downloadsView.webContents.isDestroyed())) return;
  const had = [ui(), activeTab()?.webContents].find((wc) => wc && !wc.isDestroyed() && wc.isFocused());
  createDownloadsView();
  const view = downloadsView;
  const giveBack = () => { if (!view.getVisible() && had && !had.isDestroyed()) had.focus(); };
  view.webContents.on('focus', giveBack);
  view.webContents.once('did-finish-load', () => { giveBack(); setTimeout(() => { if (!view.webContents.isDestroyed()) view.webContents.removeListener('focus', giveBack); }, 500); });
}
let downloadWarmTimer = null;
function warmDownloadsPanelSoon() {
  if (downloadWarmTimer || (downloadsView && !downloadsView.webContents.isDestroyed())) return;
  downloadWarmTimer = setTimeout(() => { downloadWarmTimer = null; warmDownloadsPanel(); }, 1500);
  downloadWarmTimer.unref?.();
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
// Right-click on a row of the panel: Open, Show in folder and Pin to Files for a finished download (features/downloads.js act). [files]
ipcMain.on('downloads:row-menu', (event, id) => {
  const d = fromDownloadsPanel(event) && typeof id === 'number' ? downloads.list.find((x) => x.id === id) : null;
  if (!d || d.state !== 'completed') return;
  Menu.buildFromTemplate([
    { label: t('dlpage.action.open'), click: () => downloads.act(id, 'open') },
    { label: t('dlpage.action.show'), click: () => downloads.act(id, 'show') },
    { type: 'separator' },
    { label: t('menu.pinToFiles'), click: () => downloads.act(id, 'pin') },
    ...(phoneReady() ? [{ label: t('phone.send.menu'), click: () => sendFileToPhone(d.path) }] : []), // [phone files]
  ]).popup({ window: BrowserWindow.fromWebContents(event.sender) || win });
});
ipcMain.on('downloads:height', (event, height) => { if (fromDownloadsPanel(event) && Number.isFinite(height)) placeDownloadsPanel(Math.max(120, Math.min(height, 640))); });

// ---------- tabs ----------

// The URL a tab is "really" on: error pages report the address that failed.
function realUrl(wc) {
  if (warmPending.has(wc)) return ''; // (still on the warm view's about:blank: no address yet, as a fresh view has none)
  const url = wc.getURL();
  if (isErrorPage(url) || url.startsWith(settingsPage.HTTPS_ONLY_URL) || url.startsWith(UNLOADED_URL)) return new URL(url).searchParams.get('url') || ''; // [settings] HTTPS-only warning too
  return url;
}

const saveGates = require('./features/save-gates');
// (every bookmark change is a settings write, which bumps settingsGen)
const bookmarkUrlSetMemo = saveGates.memoByGeneration(() => settingsGen, () => new Set(bookmarks().map((b) => b.url)));
function bookmarkUrlSet() { readSettings(); return bookmarkUrlSetMemo(); } // (readSettings loads the cache first)
// [split view] what the strip needs to draw a pair as joined tabs: which side this tab is, and its partner.
function splitMark(t) {
  const mate = t.split ? splitPartner(t) : null;
  return mate ? { split: t.split.left === t.id ? 'left' : 'right', splitWith: mate.id } : {};
}
function tabState() {
  const active = activeTab();
  const history = active?.webContents.navigationHistory;
  // Hoisted (and remembered until a settings write): sendTabs() fires on nearly every tab/nav event.
  const bookmarked = bookmarkUrlSet();
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
          freedMb: sleepShowFreed() ? t.freedMb || 0 : 0, // [tabs] the hover card's "about N MB freed"
          fileKind: fileTabs.iconKind(url), // the strip's icon for a file (a PDF, a deck ...) when the page has none
          error: false,
          zoom: 100,
          zoomDefault: 100,
          bookmarked: isWebUrl(url) && bookmarked.has(url),
          groupId: t.groupId || null,
          pinned: Boolean(t.pinned),
          sleeping: true,
          chat: tabChatMark(t.id),
          aiOpened: manners.isAiTab(t), // [ai manners] the AI opened this tab
          openedByApp: t.rec?.agent?.label || null, // [external apps] a tab in an outside app's own window: the strip says whose
          aiKeepOff: manners.isKeptOff(t), // [ai off-tab]
          ...splitMark(t),
          ...tabTools.state(t, false),
        };
      }
      const wc = t.view.webContents;
      const url = realUrl(wc);
      return {
        id: t.id,
        title: (!warmPending.has(wc) && wc.getTitle()) || 'New Tab',
        url: settingsPage.isSettingsUrl(url) ? settingsPage.displayUrl(url) : chatPage.isChatUrl(url) ? chatPage.displayUrl() : pageTools.isInternal(url) ? pageTools.displayUrl(url) : url.startsWith(HISTORY_URL) ? 'lumen://history' : managerPageOf(url) ? `lumen://${managerPageOf(url)}` : slidesViewer.isViewerUrl(url) ? slidesViewer.displayUrl(url) : emlViewer.isViewerUrl(url) ? emlViewer.displayUrl(url) : pdfViewer.isViewerUrl(url) ? pdfViewer.displayUrl(url) : isInternal(url) ? '' : url, // [settings] lumen://settings/<section>; a deck in the slide viewer shows its file
        loading: wc.isLoading(),
        favicon: t.favicon || null,
        favicons: t.favicons || (t.favicon ? [t.favicon] : []), // every candidate: the strip falls back through them
        page: settingsPage.isSettingsUrl(url) ? 'settings' : url.startsWith(HISTORY_URL) ? 'history' : pageTools.page(url) || managerPageOf(url), // Lumen's own pages get their own icon
        readerable: Boolean(t.readerable), // Reader mode can show this page (features/page-tools.js)
        translate: translate.stateOf(t), // the translate button and infobar (features/translate.js)
        passwords: passwordsRt ? passwordsRt.stateOf(t) : null, // [passwords] the key button and the save bar: sites, usernames and counts only
        fileKind: fileTabs.iconKind(url),
        error: isErrorPage(wc.getURL()),
        security: siteSecurity.stateOf(wc), // 'broken' | 'mixed' | null: the lock's state beyond the scheme
        zoom: Math.round(wc.getZoomFactor() * 100),
        zoomDefault: isWebUrl(url) ? defaultZoomPercent : 100, // [settings] the zoom pill shows only when a page differs from it
        bookmarked: isWebUrl(url) && bookmarked.has(url),
        groupId: t.groupId || null,
        alert: dialogs.pendingFor(wc), // a dialog is waiting for this background tab
        pinned: Boolean(t.pinned),
        sleeping: Boolean(t.frozen || t.placeholder), // asleep in freeze mode: paused, still loaded (tabSleep); or an unloaded tab showing its Reload page
        freedMb: sleepShowFreed() && t.placeholder ? t.freedMb || 0 : 0,
        isolated: Boolean(t.isolated), // [research tabs] its own cookie-less session
        aiReading: Boolean(t.aiReading), // [research tabs] the AI is reading this page right now
        chat: tabChatMark(t.id), // [chat per tab] 'running' | 'waiting' | 'approval' | 'done' | null
        aiOpened: manners.isAiTab(t), // [ai manners] the AI opened this tab (a mark in the strip, "Opened by the AI" in its card)
        openedByApp: t.rec?.agent?.label || null, // [external apps] a tab in an outside app's own window ("Opened by Claude Desktop")
        aiKeepOff: manners.isKeptOff(t), // [ai off-tab] the user keeps the AI from acting on this tab (the address bar's button, a mark in the strip)
        ...splitMark(t), // [split view]
        ...tabTools.state(t, true), // audible, muted
      };
    }),
    activeId,
    sidebar: tabSidebarOpen(tabs.find((t) => t.id === activeId)), // [sidebar per tab] whether the sidebar is open on the tab in front
    canGoBack: active ? canGoBack(active.webContents) : false,
    canGoForward: history ? history.canGoForward() : false,
  };
}

let sessionTimer = null;
const sessionGate = saveGates.sessionWriteGate(); // an identical session is not written again
let sessionDirtySince = 0; // when the first unsaved tab change came
let tabsQuiet = false; // set while sendTabs runs for events that change nothing the session keeps (a background tab's title, loading flags)
let tabChipsRt = null; // [tab chips] features/tab-chips.js, made when a chat first shows a chip
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
const tabStripGate = saveGates.tabsSendGate();
// `coalesced`: a burst of a page's own events (sendTabsSoon). Nothing is sent, run or saved when the strip would show what it already does.
function sendTabs(coalesced = false) { return hang.mark('sendTabs', sendTabsBody, coalesced); } // [hang recorder]
function sendTabsBody(coalesced) {
  if (tabsBatch && curRec) { tabsBatched.add(curRec); return; }
  keepPinnedFirst();
  const state = tabState();
  if (!tabStripGate.shouldSend(curRec || tabStripGate, state, coalesced !== true)) return;
  if (!tabStripGate.repeated(curRec || tabStripGate)) ui()?.send('tabs', state);
  agentTargetHook?.();
  tabChipsRt?.changed(); // [tab chips] a chip's title or icon follows the tab
  chatPageRt?.pushTarget(); // the chat page's "working on" tab follows tab changes
  // Saved 3 s after the tabs settle, and at least every 15 s while they don't (a page whose navigation keeps changing).
  // A background tab's title tick or a loading flag changes nothing worth a write (quitting saves the latest titles).
  if (tabsQuiet) return;
  clearTimeout(sessionTimer);
  if (!sessionDirtySince) sessionDirtySince = Date.now();
  sessionTimer = setTimeout(() => { sessionDirtySince = 0; if (win && !win.isDestroyed()) saveSession({ background: true }); }, Math.max(0, Math.min(3000, sessionDirtySince + 15000 - Date.now())));
}

// A page's own busy events (loading, title, favicon, in-page navigations) arrive in bursts: they send the strip
// one state per turn of the event loop, per window. Moves, opens and closes still send at once (sendTabs).
// `quiet`: the event changes nothing the saved session holds, so the burst doesn't arm a session save (unless a
// non-quiet event joins the same burst).
const tabsSoon = saveGates.quietBursts(16, (rec, quiet) => { // (16 ms: one frame, a load's events arrive in separate turns)
  if (!rcAlive(rec)) return;
  tabsQuiet = quiet;
  try { withWindow(rec, () => sendTabs(true)); } finally { tabsQuiet = false; }
});
function sendTabsSoon(quiet = false) {
  const rec = curRec;
  if (!rec) { sendTabs(); return; }
  tabsSoon(rec, quiet);
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

// What a Lumen page (the new-tab page above all) is painted on before, and wherever, its renderer has not drawn: the page's own background in
// the current theme, never the default black. Set on the tab views, the window and its content view (the UI's colour), kept up with the theme.
const pageBackground = () => (nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff');
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7');
function paintBackgrounds(rec) {
  try { rec.win.setBackgroundColor(windowBackground()); } catch { /* gone */ }
  try { rec.win.contentView.setBackgroundColor(windowBackground()); } catch { /* an older shell */ }
  for (const t of rec.tabs) { try { const u = t.view?.webContents.getURL(); if (t.view && (!u || isNewTab(u))) t.view.setBackgroundColor(pageBackground()); } catch { /* gone */ } }
  for (const s of [spareNewTab, spareChat]) { try { s?.view.setBackgroundColor(pageBackground()); } catch { /* gone */ } }
}
// A page kept out of Chromium's background state (setBackgroundThrottling(false): a tab kept ready, features/tab-ready.js, or one a run works in, syncRunTabs)
// must not be SHOWN in that state: its video layers stay on the last frame they presented (a playing video froze or went black, with the page's clock,
// captions and controls working; test/e2e/video-frames.js). So the page goes back to the normal state just before its view is shown, and is kept out of it
// again when the view is hidden. (A tab kept ready is boosted again by the next tab-ready sync, as it already is after any switch.)
function releaseKeptPage(tab) {
  try { const wc = tab.view.webContents; if (!wc.isDestroyed() && !wc.backgroundThrottling) wc.setBackgroundThrottling(true); } catch { /* gone */ }
}
function keptPageHidden(tab) {
  try { const wc = tab.view.webContents; if (!wc.isDestroyed() && unthrottled.get(tab.id) === wc) wc.setBackgroundThrottling(false); } catch { /* gone */ }
}
// Chromium's PDF viewer frame can miss a redraw when its tab is shown or resized (features/pdf-repaint.js): PDF tabs only.
let pdfRepainter = null;
function pokePdf(tab) {
  try { const wc = tab?.view?.webContents; if (!wc || !pdfZoom.viewerFrame(wc)) return; /* (not a PDF: the module is not even loaded) */ if (!pdfRepainter) pdfRepainter = require('./features/pdf-repaint').createRepainter({ isPdfTab: (wc) => Boolean(pdfZoom.viewerFrame(wc)) }); pdfRepainter.poke(tab?.view?.webContents); } catch { /* the tab is going away */ }
}
// Safety net (features/tab-capture.js): the tab in front must be laid out and drawn at the size of the tab area. Read when a tab is brought to the front
// and after a burst of captures or card frames in the tab in front; a page that is off is put right and the event is written to diagnostics/page-size.jsonl.
function pageSizeLog(entry) {
  if (TEST) (global.__pageSizeFixes ||= []).push(entry);
  try {
    const dir = path.join(app.getPath('userData'), 'diagnostics');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'page-size.jsonl');
    try { if (fs.statSync(file).size > 200000) fs.truncateSync(file, 0); } catch { /* none yet */ }
    fs.appendFile(file, JSON.stringify(entry) + String.fromCharCode(10), () => {});
  } catch { /* diagnostics are best effort */ }
}
function fillCheck(tabId, source, delay = 0) {
  const timer = setTimeout(() => {
    const tab = tabs.find((x) => x.id === tabId);
    if (!tab || !alive(tab) || tab.id !== activeId || !win || win.isDestroyed() || win.isMinimized()) return;
    require('./features/tab-capture').checkPageSize(tab.view, { source, shown: () => tab.id === activeId && alive(tab) && tab.view.getVisible() && !tab.fullscreen, skip: () => Boolean(tab.overlay), relayout: layout, log: pageSizeLog });
  }, delay);
  timer.unref?.();
}
let viewVisibleCalls = 0; // setVisible calls layout() made (the switch-timing recorder reads the difference over one switch)
function layout() { return hang.mark('layout', layoutBody); } // [hang recorder]
// [split view] Two tabs side by side (browser/split-layout.js, the "[split view]" section below). The module is loaded on first use.
const splitLayout = lazy(() => require('./browser/split-layout'));
// The other tab of `tab`'s pair, or null (no pair, the other half gone or closing).
function splitPartner(tab) {
  if (!tab?.split) return null;
  const other = splitLayout.partnerOf(tabs, tab);
  return other && !other.closing ? other : null;
}
// The pair on show now: the tab in front and its partner, with the two page rectangles; null when one page cannot be shown beside the other
// (no pair, a page asleep or in full screen, the new-tab page's full chat, a page area too narrow for two).
function splitView() {
  const front = tabs.find((t) => t.id === activeId);
  const partner = splitPartner(front);
  if (!partner || front.closing || !alive(front) || !alive(partner) || front.fullscreen || partner.fullscreen || chatFullTab === front.id || chatFullTab === partner.id) return null;
  const rects = splitLayout.compute(contentBounds, front.split.ratio);
  return rects ? { front, partner, rects } : null;
}
// The divider is drawn by the UI in the gap between the pages; it is told where (only when that changed).
function sendSplitLayout(sp) {
  const holder = curRec || sendSplitLayout;
  const msg = sp ? { left: sp.front.split.left, right: sp.front.split.right, active: activeId, x: sp.rects.divider.x - contentBounds.x, width: sp.rects.divider.width, ratio: Math.round(sp.rects.ratio * 1000) / 1000 } : null;
  const key = msg ? JSON.stringify(msg) : '';
  if (holder.splitKey === key) return;
  holder.splitKey = key;
  ui()?.send('split:layout', msg);
}
function layoutBody() {
  // Showing a view (after the sidebar spring, a tab switch) must not take the keyboard from the UI:
  // Chromium can hand focus to a view that becomes visible (a moment later), which ate keys typed in
  // the address bar. While the UI has focus, a view shown here gives focus back for half a second.
  const uiHadFocus = Boolean(ui()?.isFocused());
  // The tab coming to the front is shown first, then the others are hidden: no frame with nothing to show, and the show is not queued behind other tabs' work.
  const live = tabs.filter(alive);
  const front = live.findIndex((t) => t.id === activeId);
  if (front > 0) live.unshift(...live.splice(front, 1));
  const sp = splitView(); // [split view] the pair shown side by side, or null
  for (const tab of live) {
    const visible = tab.id === activeId || tab === sp?.partner;
    if (tab.outgoing && !visible) finishLeaving(tab); // (left before its new page drew: no new-tab page behind another tab)
    const show = visible && !viewFrozen && !tab.spareFilling && !curRec?.holdViews && !(tab.id === chatFullTab && isNewTab(tab.view.webContents.getURL()));
    if (show && uiHadFocus && !tab.view.getVisible()) tab.showGuardUntil = Date.now() + 500;
    if (tab.view.getVisible() !== show) {
      // Only a tab switch touches the page's background state. The tab in front hidden for a moment (the sidebar's snapshot while it
      // slides, a full-page chat) is left as it is: setBackgroundThrottling on a hidden view tells its page it is shown (Electron's
      // WasShown), and the view shown again then drew nothing new: the page froze or went blank when the sidebar opened or closed.
      if (show && tab.awayBySwitch !== false) releaseKeptPage(tab); // (before it is shown: see keptPageHidden)
      tab.view.setVisible(show); viewVisibleCalls++; // (only a change: a switch is one show and one hide, not one call per tab, and each call can cost a GPU frame)
      if (show) pokePdf(tab); // (a PDF tab coming to the front: Chromium's PDF frame may not have drawn)
      if (!show) { tab.awayBySwitch = !visible; if (!visible) keptPageHidden(tab); }
    } else if (!visible && tab.awayBySwitch === false) { tab.awayBySwitch = true; keptPageHidden(tab); } // (hidden for a moment, then switched away from)
    // The new-tab page keeps its full-width layout when the sidebar narrows its view (see
    // features/sidebar-overlay.js). Kept while the view is only hidden for a moment (the sidebar's
    // snapshot), so the page isn't laid out twice; dropped for every other tab and page.
    const overlay = visible && !sp && !tab.fullscreen && isNewTab(tab.view.webContents.getURL())
      ? sidebarOverlay.overlayParams({ newTab: true, fullscreen: false, bounds: contentBounds })
      : null;
    // The full-width layout goes on BEFORE the view narrows and comes off AFTER it has widened again: the other way round, the page
    // was laid out once at the narrow width (a resize event, the cards reflowing, widgets re-rendering) every time the sidebar closed.
    if (overlay) setOverlay(tab, overlay);
    if (visible) {
      if (tab.fillDue) { tab.fillDue = false; fillCheck(tab.id, 'show', 350); } // (just brought to the front: is its page the size of the tab area?)
      const at = sp ? (tab.split.left === tab.id ? sp.rects.left : sp.rects.right) : contentBounds; // [split view] a side of the pair
      if (tab.fullscreen) {
        const [width, height] = win.getContentSize();
        tab.view.setBounds({ x: 0, y: 0, width, height });
      } else {
        tab.view.setBounds({ x: at.x, y: at.y, width: at.width, height: at.height });
      }
      const boundsKey = `${at.x},${at.y},${at.width},${at.height},${tab.fullscreen ? 1 : 0}`;
      if (tab.pdfBoundsKey !== boundsKey) { if (tab.pdfBoundsKey !== undefined) pokePdf(tab); tab.pdfBoundsKey = boundsKey; } // (resized while a PDF is open: draw again)
    }
    if (!overlay) setOverlay(tab, null);
  }
  sendSplitLayout(sp);
  spotifyWeb.clip(contentBounds); // [widgets] a music card's view never reaches over the sidebar, even for the moment before the page says where its card is now
  appleMusicWeb.clip(contentBounds);
  spotifyWeb.sync(); // [widgets] the Spotify card's view follows the new-tab page (or hides, still playing)
  appleMusicWeb.sync(); // [widgets] and so does the Apple Music card's
  raiseOverlays();
}
const { overlaysToRaise } = require('./features/overlay-order');
// Layering (bottom to top): the UI view, tab views, Spotify and Apple Music cards, suggestions, downloads panel, tool overlay, dialogs. A tab view added later
// (a new tab, a woken one) lands above an overlay that is showing and would hide it; put those back on top, in order.
function raiseOverlays() {
  if (!win || win.isDestroyed()) return;
  // Fixed order, bottom to top: spotify, apple music, suggestions, downloads, tool overlay (dialogs: dialogs.raise below).
  // (a music player's view shown in a window of its own, the sign-in window, is not this window's: re-adding it here would pull it out of that window and
  // lay it over the browser's toolbar)
  const here = (v) => !v || win.contentView.children.includes(v);
  const order = [here(spotifyWeb.view()) ? spotifyWeb.view() : null, here(appleMusicWeb.view()) ? appleMusicWeb.view() : null, suggestView, downloadsView, toolOverlay.viewFor(win)].filter((v) => v && !v.webContents.isDestroyed() && v.getVisible());
  // Only when one is under a tab (or they are out of order): then all are re-added in order, so two never swap.
  for (const v of overlaysToRaise(win.contentView.children, tabs.filter((t) => t.view).map((t) => t.view), order)) win.contentView.addChildView(v);
  dialogs.raise();
  if (printSheetOpen) printPreview.raise(); // (a tab added while the print preview is up)
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
  pdfViewer.attachSession(ses, pdfHandler);
  ses.webRequest.onBeforeRequest(GATE_FILTER, (details, callback) => mainFrameGate(details, callback)); // Focus mode and Safe Browsing (the ad blocker sends pages to the same gate)
  // Lumen's own alert/confirm dialogs and readable dropdowns, as in normal tabs.
  ses.registerPreloadScript({ id: 'lumen-page-dialogs', type: 'frame', filePath: path.join(__dirname, 'preload', 'page-dialogs-preload.js') });
  ses.registerPreloadScript({ id: 'lumen-select-contrast', type: 'frame', filePath: path.join(__dirname, 'features', 'select-contrast-preload.js') });
  ses.registerPreloadScript({ id: 'lumen-error-page', type: 'frame', filePath: path.join(__dirname, 'preload', 'error-preload.js') });
  ses.registerPreloadScript({ id: 'lumen-webauthn-gate', type: 'frame', filePath: path.join(__dirname, 'preload', 'webauthn-preload.js') }); // pages the AI opened: always the hidden API (features/passkeys.js candidate)
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
let newTabUsedAt = Date.now(); // when a new tab last took (or asked for) the spare: an unused one is dropped after spare-policy IDLE_MS
let spareForTest = Boolean(TEST && process.env.LUMEN_TEST_SPARES); // tests: off unless asked (test/perf-newtab.js, scripts/measure/measure-newtab.js measure it); LUMEN_TEST_SPARES=1 lets the real policy decide (scripts/measure/measure-app-perf.js)
const sparePolicy = require('./features/spare-policy'); // one spare only, after start-up has settled, dropped when memory is tight
let spareForced = false; // tests: make one regardless of start-up state
// One scheduler for the always-on housekeeping timers and one shared memory sample (features/scheduler.js). While every
// window is hidden or minimised, the screen is locked, or the system is idle, jobs run at their slower `whenHidden` period.
const scheduler = require('./features/scheduler').createScheduler({
  idleState: (s) => require('electron').powerMonitor.getSystemIdleState(s),
  readMemory: () => memoryInfo(),
});
if (TEST) { scheduler.setQuietOverride(false); global.__scheduler = scheduler; } // (test windows are hidden by design: they keep the normal cadence unless a test forces quiet)
const spareMemory = () => scheduler.lastMemory() || (() => { // the last shared sample, else the cheap facts (system free memory)
  try { const m = process.getSystemMemoryInfo(); return { totalBytes: m.total * 1024, freeBytes: m.free * 1024 }; } catch { return {}; }
})();
function closeSpareNewTab() {
  const s = spareNewTab;
  spareNewTab = null;
  if (s && !s.view.webContents.isDestroyed()) { try { s.view.webContents.close(); } catch {} }
}
function makeSpareNewTab() {
  if ((TEST && !spareForTest) || spareNewTab || !app.isReady()) return;
  if (!spareForced && sparePolicy.spareAction({ hasSpare: false, firstTabDone, memory: spareMemory(), idle: sparePolicy.isIdle(newTabUsedAt) }) !== 'make') return; // (still starting up, short of memory, or no new tab for a long while: the check below makes it later)
  const prefs = settingsBackend.tabWebPreferences(false);
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, ...prefs } });
  try { view.setBounds({ x: 0, y: 0, ...(withWindow(curRec, () => ({ width: contentBounds.width, height: contentBounds.height })) || { width: 1200, height: 800 }) }); } catch {} // laid out at a tab's size, not 0×0
  try { view.setBackgroundColor(pageBackground()); } catch {} // (taken while still loading: the theme's color, not white)
  const s = { view, prefs: JSON.stringify(prefs), ready: false, at: Date.now() };
  view.webContents.once('did-finish-load', () => { s.ready = true; });
  // A spare whose renderer died (out of memory, killed) is replaced shortly, not found dead at the next Ctrl+T.
  view.webContents.once('render-process-gone', () => { if (spareNewTab === s) { closeSpareNewTab(); setTimeout(makeSpareNewTab, 2000).unref?.(); } });
  view.webContents.loadURL(newTabUrl()).catch(() => {});
  spareNewTab = s;
}
// Every minute: the spare is dropped while memory is tight, and made again (once start-up is over) when it is not.
scheduler.every('spare-policy', 60 * 1000, async () => {
  if (TEST && !spareForTest && !spareChatForTest) return;
  const memory = await scheduler.memorySample(); // (shared with the tab-sleep sweep)
  const facts = Object.keys(memory).length ? memory : spareMemory();
  if (!TEST || spareForTest) {
    const action = sparePolicy.spareAction({ hasSpare: Boolean(spareNewTab), firstTabDone, memory: facts, idle: sparePolicy.isIdle(newTabUsedAt) });
    if (action === 'drop') closeSpareNewTab();
    else if (action === 'make') makeSpareNewTab();
  }
  // the warm renderer (about:blank, for the next web page): likewise freed when memory is tight or no page has taken one for a while
  if (warmTab && (sparePolicy.isIdle(warmUsedAt) || sparePolicy.memoryTight(facts))) { const w = warmTab; warmTab = null; try { w.view.webContents.close(); } catch { /* gone */ } }
  else if (!warmTab && !sparePolicy.memoryTight(facts)) makeWarmTab();
  // the spare chat page: dropped with the new-tab one when memory is tight, and when no chat page has been used for half an hour
  if (spareChat && (Date.now() - chatPageUsedAt > SPARE_CHAT_IDLE_MS || sparePolicy.spareAction({ hasSpare: true, firstTabDone, memory: facts }) === 'drop')) closeSpareChat();
  else if (!spareChat && chatPageUsedAt) makeSpareChat();
}, { whenHidden: 2 * 60 * 1000 });
// { view, ready }: one still loading is taken too (its renderer is up and its page part-way: sooner than a new one).
function takeSpareNewTab() {
  newTabUsedAt = Date.now();
  const s = spareNewTab;
  if (!s) return null;
  spareNewTab = null;
  const fresh = !s.view.webContents.isDestroyed() && !s.view.webContents.isCrashed() && s.prefs === JSON.stringify(settingsBackend.tabWebPreferences(false)); // (no age limit: its data comes with the tab)
  if (!fresh) { try { s.view.webContents.close(); } catch {} return null; }
  return { view: s.view, ready: s.ready };
}
// The next one is made right away: Ctrl+T pressed again a moment later finds
// it, or one part-way through loading. (It used to wait 700 ms, and a quick second new tab started from nothing.)
if (TEST) global.__spareNewTab = { enable: (on = true) => { spareForTest = on; spareForced = on; if (on) makeSpareNewTab(); else closeSpareNewTab(); }, ready: () => Boolean(spareNewTab?.ready) };
const spareSoon = () => setTimeout(makeSpareNewTab, 100).unref?.();
// ---- a chat page made ready before it is asked for, as the spare new-tab page is: opening the full-page chat (the Chat button,
// Ctrl+Shift+L, a restored chat tab waking) used to wait for a new renderer process and ~30 scripts (about 250 ms). The spare loads
// hidden, its calls held back (chat-preload.js) until a chat tab takes it ('chat:adopt'); then it starts as a fresh page does. Made only
// for someone who uses the chat page (one opened or restored in the last half hour), one at a time, and dropped while memory is tight.
let spareChat = null; // { view, prefs, locale, committed, at }
let chatPageUsedAt = 0; // when a chat page was last opened (or found in the restored session)
let spareChatForTest = false; // tests: off unless asked (test/e2e/chat-tab-speed.js)
const SPARE_CHAT_IDLE_MS = 30 * 60 * 1000;
function closeSpareChat() {
  const s = spareChat;
  spareChat = null;
  if (s && !s.view.webContents.isDestroyed()) { try { s.view.webContents.close(); } catch {} }
}
function makeSpareChat() {
  if ((TEST && !spareChatForTest) || spareChat || !chatPageUsedAt || Date.now() - chatPageUsedAt > SPARE_CHAT_IDLE_MS || !app.isReady()) return;
  if (!spareChatForTest && sparePolicy.spareAction({ hasSpare: false, firstTabDone, memory: spareMemory() }) !== 'make') return; // (still starting up, or short of memory: the policy job makes it later)
  const prefs = settingsBackend.tabWebPreferences(false);
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, ...prefs, preload: managers.preloadFor('chat'), additionalArguments: [chatPage.SPARE_FLAG] } });
  try { view.setBounds({ x: 0, y: 0, ...(withWindow(curRec, () => ({ width: contentBounds.width, height: contentBounds.height })) || { width: 1200, height: 800 }) }); } catch {}
  try { view.setBackgroundColor(pageBackground()); } catch {}
  const s = { view, prefs: JSON.stringify(prefs), locale: i18n().locale, committed: false, at: Date.now() };
  view.webContents.once('dom-ready', () => { s.committed = true; }); // (its preload is in by then: it can be handed to a tab)
  view.webContents.once('render-process-gone', () => { if (spareChat === s) { closeSpareChat(); setTimeout(makeSpareChat, 2000).unref?.(); } });
  view.webContents.loadURL(chatPage.CHAT_URL).catch(() => {});
  spareChat = s;
}
let spareChatTimer = null;
const spareChatSoon = () => { clearTimeout(spareChatTimer); spareChatTimer = setTimeout(makeSpareChat, 1500); spareChatTimer.unref?.(); }; // (a moment after a page took the last one: not while that page starts)
// A chat page was opened, or is in the session just restored: the next one is made ready.
function noteChatPage() { chatPageUsedAt = Date.now(); spareChatSoon(); }
// The spare's view for a chat tab (null: none, still loading, or made for other settings or another language).
function takeSpareChat() {
  const s = spareChat;
  if (!s || !s.committed) return null;
  spareChat = null;
  const wc = s.view.webContents;
  const fresh = !wc.isDestroyed() && !wc.isCrashed() && s.prefs === JSON.stringify(settingsBackend.tabWebPreferences(false)) && s.locale === i18n().locale;
  if (!fresh) { try { wc.close(); } catch {} return null; }
  return s.view;
}
const adoptSpareChat = (view) => { if (!view.webContents.isDestroyed()) view.webContents.send('chat:adopt'); };
if (TEST) global.__spareChat = { enable: (on = true) => { spareChatForTest = on; if (on) { chatPageUsedAt = Date.now(); makeSpareChat(); } else closeSpareChat(); }, ready: () => Boolean(spareChat?.committed), has: () => Boolean(spareChat), contents: () => spareChat?.view.webContents || null };

// ---- a renderer kept ready for the next web page: Chrome's spare renderer process, which Electron doesn't keep.
// A web page in a new view (a link opened in a new tab, a restored or sleeping tab woken, an address typed into the
// new-tab page, whose own renderer is locked to Lumen's pages) waited ~70 ms for its renderer process to start. One
// hidden view is kept on about:blank instead: its process is up and belongs to no site yet, so the next such page
// loads in it at once. Another is made a moment later. (It costs a renderer's memory: not on a PC short of memory, nor
// with Performance mode switched on by hand.)
let warmTab = null; // { view, prefs }
let warmUsedAt = Date.now(); // when a page last took (or asked for) the warm renderer: an unused one is dropped after spare-policy IDLE_MS
const warmPending = new WeakSet(); // a tab's page that hasn't left the warm view's about:blank yet (no address, no history)
let warmForTest = Boolean(TEST && process.env.LUMEN_TEST_SPARES); // (same switch as the spare new-tab page)
const warmTabsOn = () => (!TEST || warmForTest) && perfMode.mode() !== 'on' && !perfMode.reasons().some((r) => r.key === 'memory');
function makeWarmTab() {
  if (warmTab || !app.isReady() || !warmTabsOn() || quitting || sparePolicy.isIdle(warmUsedAt)) return;
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
  warmUsedAt = Date.now();
  const s = warmTab;
  if (!s) { warmSoon(); return null; } // (none, as after an idle drop: one is made for the page after this)
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
  const tab = tabByContents(wc);
  if (tab?.managerPage === 'chat') { chatPageRt?.back(); return; } // the full-page chat is locked to its page (no history of its own): back to where it was opened from, else the new-tab page
  if (wc.navigationHistory.canGoBack()) { wc.navigationHistory.goBack(); return; }
  if (tab?.backToNewTab) { tab.backToNewTab = false; wc.loadURL(newTabUrl()).catch(() => {}); }
}
const canGoBack = (wc) => Boolean(wc && !wc.isDestroyed() && (wc.navigationHistory.canGoBack() || tabByContents(wc)?.backToNewTab || tabByContents(wc)?.managerPage === 'chat'));
if (TEST) global.__warmTabs = { enable: (on = true) => { warmForTest = on; if (on) makeWarmTab(); else if (warmTab) { try { warmTab.view.webContents.close(); } catch {} warmTab = null; } }, ready: () => Boolean(warmTab && !warmTab.view.webContents.isLoading()), contentsId: () => warmTab?.view.webContents.id ?? null, forgetHistory: (id) => { const t = tabs.find((x) => x.id === id); if (t) t.sleepHistory = null; return Boolean(t?.sleeping); } };

// [agent window] The pages of an outside agent's own window (below, features/agent-windows.js). Nothing they do may reach the
// user: no sound, no dialog, no prompt, no popup window, no fullscreen, and they keep painting (and so keep
// screenshotting) while the window is behind another or minimized.
const agentContents = new WeakSet();
function prepareAgentTab(wc) {
  agentContents.add(wc);
  try { wc.setBackgroundThrottling(false); } catch {}
  try { wc.setAudioMuted(true); } catch {}
}
function openTab(url = newTabUrl(), { background = false, openerId = null, groupId = null, settings = false, historyPage = false, managerPage = null, history = null, partition = null, view: adopted = null, openedBy = null } = {}) {
  const isolated = settings || historyPage || managerPage ? null : isolatedPartition(partition);
  if (isolated) researchSession();
  const plainNewTab = !adopted && !settings && !historyPage && !managerPage && !history?.entries?.length && !isolated && typeof url === 'string' && url.startsWith(NEW_TAB_URL);
  const spared = plainNewTab ? takeSpareNewTab() : null;
  const spare = spared?.view || null;
  if (plainNewTab) spareSoon();
  const webPage = !adopted && !settings && !historyPage && !managerPage && !history?.entries?.length && !isolated && typeof url === 'string' && isWebUrl(url);
  const warm = webPage ? takeWarmTab() : null; // (its process is already up: see makeWarmTab)
  if (managerPage === 'chat') noteChatPage();
  const chatSpare = managerPage === 'chat' && !adopted && !history?.entries?.length && chatPage.isChatUrl(url) ? takeSpareChat() : null; // (a chat page that has already loaded)
  const view = adopted || spare || chatSpare || warm || new WebContentsView({
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
  if ((plainNewTab || settings || historyPage || managerPage) && !spare && !chatSpare && !adopted) { // (Lumen's own pages follow the theme; a web page's default is its own)
    try { view.setBackgroundColor(pageBackground()); } catch {} }
  if (plainNewTab) { try { view.setBackgroundColor(pageBackground()); } catch { /* gone */ } } // (a spare or adopted one too: made before the theme may have changed)
  const id = nextTabId++;
  const tab = { id, view, rec: curRec, favicon: null, groupId: null, userRemoved: false, settings, lastActiveAt: Date.now(), ...(managerPage ? { managerPage } : {}), ...(isolated ? { isolated } : {}) };
  if (openedBy && !curRec?.agent) manners.markOpened(tab, openedBy); // [ai manners] a tab the AI opened (an agent's own window is not marked: nothing there is the user's, so nothing is hidden or closed for them)
  if (curRec?.agent) tab.muted = true; // [agent window] no sound from the agent's window unless the user unmutes a tab
  tabs.push(tab);
  win.contentView.addChildView(view);
  view.setVisible(false);
  const wc = wireView(tab, url, history, { loaded: Boolean(adopted || spare || chatSpare) }); // `history`: Duplicate's copy of back/forward
  if (chatSpare) adoptSpareChat(chatSpare); // its held calls go out: it starts as this tab's chat page
  if (curRec?.agent) prepareAgentTab(wc); // [agent window]
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
      // (activeId read inside the tab's own window: with another window current, the check failed and the page stayed hidden.)
      .finally(() => { tab.spareFilling = false; if (alive(tab)) withWindow(tab.rec, () => { if (tab.id === activeId) layout(); }); });
  }

  if (openerId) tabGroups.joinOpener(tab, tabs.find((t) => t.id === openerId));
  else if (groupId) tabGroups.add(id, groupId);
  if (!groupId) joinAiGroup(tab); // [ai tabs] the folded "AI tabs" group (a tab given a group of its own, a research tab, keeps that one)

  if (background) {
    // Adding or first loading the view may hand it the keyboard without an event we can see: look again as it settles.
    for (const ms of [0, 60, 300, 1000, 2500]) setTimeout(() => { if (tab.id !== activeId && alive(tab) && tab.view.webContents.isFocused()) tab.keepKeyboard?.(); }, ms).unref?.();
    const current = activeTab();
    if (current && !tabByContents(current.webContents)?.isolated) syncExtensions(() => extensions?.selectTab(current.webContents)); // extensions never see research tabs
    sendTabs();
  } else {
    switchTab(id);
    if (!curRec?.agent) guardFirstLoadFocus(tab, url); // (an agent window never takes the keyboard)
  }
  return { id, webContents: wc };
}

const extensionIdOf = (url) => /^chrome-extension:\/\/([a-p]{32})\//.exec(url || '')?.[1] || null;

// Wires a tab's WebContentsView (navigation, zoom, favicon/title tracking, close-on-destroy,
// extensions, HTTPS-only/zoom defaults) and loads `url`. Split out of openTab() so wakeTab() (tab
// sleeping, below) can rebuild a woken tab's view identically instead of duplicating all of this.
const stuckLoad = require('./features/stuck-load');
function wireView(tab, url, history = null, { loaded = false } = {}) {
  const { id, settings } = tab;
  const wc = tab.view.webContents;
  wc.setMaxListeners(40); // each feature that watches a tab adds its own did-navigate/did-start-navigation/destroyed listener (11+ today): Node's default of 10 printed a "possible memory leak" warning for every tab, though the count is fixed per tab
  wc.once('did-stop-loading', () => setTimeout(markFirstTabLoaded, 200));
  bindContext(wc, () => tab.rec); // this tab's events run in the window that holds it, even a background one
  tabTools.wire(tab); // the tab's speaker icon, and its mute (kept across sleep)
  // [ai manners] a page the AI opened that opens another (target=_blank, window.open) opens it behind and as the AI's own: it can be closed again and, in hands-off mode, worked in
  const fromAiTab = () => (manners.isAiTab(tab) ? { openedBy: { chatId: tab.openedBy.chatId, runId: tab.openedBy.runId } } : {});
  const popupLimit = createBurstLimit(); // a page opening windows or tabs in a loop (features/popup-guard.js)
  wc.setWindowOpenHandler(({ url: target, disposition }) => {
    if (!popupLimit.allow()) return { action: 'deny' };
    if (tab.aiLock) return { action: 'deny' }; // [signed-in sites] no popups while the AI reads it as the user
    if (agentContents.has(wc) && disposition === 'new-window') return { action: 'deny' }; // [agent window] a popup window would come up in front of the user
    const ownBlob = target.startsWith('blob:') && require('./features/pdf-repaint').isSameOriginBlob(target, wc.getURL()); // a blob the page itself made (a PDF it builds and opens), never another site's or blob:null
    if (!(isWebUrl(target) || ownBlob || target === 'about:blank' || target.startsWith('chrome-extension://'))) return { action: 'deny' };
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
        createWindow: (options) => (options?.webContents ? popupWindow(options, settings, tab.isolated, target, tab) : withWindow(tab.rec, () => openTab(target, { background: manners.isAiTab(tab), openerId: id, partition: tab.isolated, ...fromAiTab() })).webContents),
      };
    }
    // A tab. When a page's script asked for it (window.open), the page gets that new window back and it keeps
    // window.opener, as in Chrome: sign-in code that opens a window and watches or redirects it keeps working.
    // Lumen adopts the new window's page into a tab instead of making a window for it.
    // A tab opened this way outlives the page that opened it (outlivesOpener): closing or sleeping that page never
    // closes it. When there is no page yet (Ctrl+click, a middle-click: Electron hands over only the address), the
    // tab is opened the usual way, loading the address, and its page is what Electron gets back.
    // (about:blank too: a page may open a blank window and set its address after an async step, as payments do.)
    if (WebContentsView && (isWebUrl(target) || ownBlob || target === 'about:blank')) {
      return {
        action: 'allow',
        outlivesOpener: true,
        // The user's page settings (font sizes, spell check, plugins for protected video), as every tab has.
        overrideBrowserWindowOptions: { webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, ...settingsBackend.tabWebPreferences(false) } },
        createWindow: (options) => {
          const background = disposition === 'background-tab' || manners.isAiTab(tab);
          if (!options?.webContents) return withWindow(tab.rec, () => openTab(target, { background, openerId: id, partition: tab.isolated, ...fromAiTab() })).webContents;
          const view = new WebContentsView({ webContents: options.webContents });
          withWindow(tab.rec, () => openTab(target, { background, openerId: id, view, partition: tab.isolated, ...fromAiTab() }));
          return options.webContents;
        },
      };
    }
    withWindow(tab.rec, () => openTab(target, { background: disposition === 'background-tab' || manners.isAiTab(tab), openerId: id, partition: tab.isolated, ...fromAiTab() })); // a link from a research tab stays in its session
    return { action: 'deny' };
  });
  wc.on('enter-html-full-screen', () => { const side = Boolean(tab.split) && tab.id !== activeId && splitView()?.partner === tab; tab.fullscreen = true; if (side) switchTab(tab.id); else layout(); }); // ([split view] the other side of a pair going full screen comes to the front: it fills the window)
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
    if (url.startsWith(UNLOADED_URL)) return; // (the placeholder of an unloaded tab keeps the tab's icon)
    tab.favicons = isWebUrl(url) ? tab.faviconUrls : [];
    tab.favicon = tab.favicons[0] || null;
  });
  wc.on('will-navigate', (event, url) => {
    // The placeholder's Reload button: the page asks for its own address, and the tab wakes the way a click on a sleeping tab does (history, scroll and form state come back).
    if (tab.placeholder && event.isMainFrame !== false && tabSleep.sameAddress(event.url || url, tab.placeholder.url)) { event.preventDefault(); leavePlaceholder(tab); layout(); sendTabs(); return; }
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
    // A full-page chat that crashed comes back as itself (the box keeps its text: it is saved with every keystroke), not as the "crashed" page: a chat tab is
    // locked to its own page, so that page would have replaced the tab with an ordinary one that Reload could not turn back into the chat. Three crashes in a
    // minute (a chat that crashes as it opens) fall through to the crashed page.
    if (tab.managerPage === 'chat') {
      console.error(`[lumen] chat page process gone (${details.reason}, exit ${details.exitCode ?? '?'}); reloading it`);
      logMainError('chat-page-process-gone', `${details.reason}, exit ${details.exitCode ?? '?'}`);
      const now = Date.now();
      const burst = crashBurst(tab.chatCrashes, now);
      tab.chatCrashes = burst.times;
      if (burst.reload) { setImmediate(() => { if (!wc.isDestroyed() && tabs.includes(tab)) wc.reload(); }); return; }
    }
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
  wc.on('did-navigate', () => { mediaPages.delete(wc); });
  wc.on('did-start-navigation', (e) => { if (tab.frozen && e.isMainFrame && !e.isSameDocument) { tab.frozen = false; tab.lastActiveAt = Date.now(); sendTabs(); } }); // a new document is not frozen // a new page starts without the camera or microphone
  wc.on('did-navigate', (_e, url) => {
    // The error page replaces the failed entry, so Back skips past it.
    if (isErrorPage(url)) {
      const history = wc.navigationHistory;
      const failed = history.getActiveIndex() - 1;
      if (failed >= 0 && history.getEntryAtIndex(failed)?.url === realUrl(wc)) history.removeEntryAtIndex(failed);
      sendTabs();
      return;
    }
    if (!tab.isolated) recordVisit(pdfViewer.pdfUrlOf(url) || url, wc.getTitle()); // research pages stay out of the user's History (a PDF in Lumen's viewer: its own address)
    if (!tab.isolated) noteFileTab(tab, url); // [files] a local file opened in a tab goes on the Files list
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
  emlRt.attach(tab); // a saved email gets its content once loaded (features/eml-viewer.js)
  slidesRt.attach(tab); // the slide viewer gets its deck once loaded (features/slides-viewer.js)
  pdfRt.attach(tab); // a PDF's address goes to Lumen's PDF viewer (features/pdf-viewer.js)
  translate.attach(tab);
  passwordsRt?.attach(tab); // [passwords] offers to save a sign-in; features/passwords.js decides which tabs
  wc.on('page-title-updated', (_e, title) => updateTitle(wc.getURL(), title));
  wc.on('found-in-page', (_e, result) => {
    if (tab.id === activeId) ui()?.send('find:result', result);
  });
  wc.on('update-target-url', (_e, url) => linkHover(tab, url)); // the hovered link's address, bottom-left over the page (features/link-status.js)
  wc.on('did-start-navigation', (_e, _u, inPlace, isMain) => { if (isMain && !inPlace) linkHover(tab, ''); });
  wc.on('context-menu', (_e, params) => showContextMenu(wc, params));
  for (const event of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page']) {
    // (loading flags and a background tab's title are not in the saved session: no save is armed for them)
    wc.on(event, () => sendTabsSoon(event === 'did-start-loading' || event === 'did-stop-loading' || (event === 'page-title-updated' && tab.id !== activeId)));
  }
  wc.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && !manners.isAgentInput(wc)) { manners.userInput.key(wc); if (!(input.control || input.meta || input.alt)) userTookOver(tab); } // (a shortcut such as Ctrl+Tab, Ctrl+W or Ctrl+L is not typing in the page) // [ai manners] the user typed here: the tab is theirs, and the AI waits for them
    // The AI's own key (press_key) is for the page, never for the browser: Ctrl+F, Ctrl+H and Ctrl+Alt+1-6 are Google Docs' Find, Find and replace
    // and heading styles, and here they would open Lumen's find bar, History, or switch to tab 3.
    if (input.type === 'keyDown' && manners.isAgentInput(wc)) return;
    // Esc while the page itself is still loading stops it, as in Chrome (the reload button shows Stop meanwhile).
    // Only the main frame counts: a loaded page whose iframes are still busy gets its Esc (closing its own dialogs).
    if (input.type === 'keyDown' && input.key === 'Escape' && !input.control && !input.meta && !input.alt && !input.shift && wc.isLoadingMainFrame() && isWebUrl(wc.getURL())) { wc.stop(); event.preventDefault(); return; }
    // Ctrl/Cmd+Enter is never a browser shortcut: it is the page's (send in Gmail, Slack and chat sites, submit in forms) and Lumen's own boxes' ("send now").
    // Page-first keys (Ctrl+S, Ctrl+P, Ctrl+F...; features/page-first-keys.js) go to the page, and Lumen's action runs only if the page did not handle them.
    if (input.type === 'keyDown' && pageFirstKeys.hold(wc, input, () => { if (!wc.isDestroyed() && activeTab()?.webContents === wc) handleShortcut({ preventDefault() {} }, input); })) return;
    handleShortcut(event, input);
  });
  wc.on('focus', () => { if (tab.showGuardUntil > Date.now() && handsOff.mayFocus(tab.rec)) ui()?.focus(); }); // see layout()
  tab.keepKeyboard = keepKeyboardFromBackgroundTab(tab);
  // A real click in the page is the user choosing it: the guard above must not take focus back.
  wc.on('before-mouse-event', (_e, mouse) => {
    if (mouse.type !== 'mouseDown') return;
    if (!manners.isAgentInput(wc)) { manners.userInput.click(wc); userTookOver(tab); if (tab.split) activateSplitSide(tab); } // [ai manners] a click of the AI's own tool is not the user's // [split view] the side clicked is the one the toolbar, the AI and the shortcuts follow
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
    if (tab.aiClosing) { // [ai manners] closing a tab the AI opened never asks "Leave site?" (that would pull the tab to the front): the page keeps it, the tab stays open
      tab.aiCloseKept = true;
      tab.closing = false;
      event.preventDefault();
      sendTabs();
      return;
    }
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
  tab.askedUrl = typeof url === 'string' ? url : ''; // (what a first load was asked for: the saved session's address for it until it commits)
  // One of Lumen's own pages whose load never commits (white page, spinner, empty console) is loaded again (features/stuck-load.js).
  stuckLoad.guard(wc, {
    url,
    graceMs: TEST ? Number(process.env.LUMEN_STUCK_LOAD_GRACE_MS) || undefined : undefined,
    fresh: (u) => (isNewTab(u) ? newTabUrl() : u), // (the new-tab page's data may have moved on)
    alive: () => alive(tab) && tab.view.webContents === wc,
    log: (msg) => console.warn(msg),
  });
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
    // A PDF or a local deck goes straight to its viewer: loading the file first and swapping once that navigation starts left a cancelled load
    // (and now and then a renderer that failed to start: "binding.startupData is null") behind.
    const absent = sessionFiles.loadTarget(url, ERROR_URL, fs.existsSync); // a file that is not there (moved, deleted): the page that says so, not a blank viewer
    const first = absent !== url ? absent : pdfViewer.shouldRoute({ url, setting: pdfViewer.cleanSetting(settingsBackend.prefs().pdfViewer) }) ? pdfViewer.viewerUrl(url) : slidesViewer.isLocalPptx(url) ? slidesViewer.viewerUrl(url) : emlViewer.isLocalEml(url) ? emlViewer.viewerUrl(url) : url;
    if (tab.rec?.agent && first === 'about:blank') {
      // [agent window] The blank first tab loads in a turn of its own (~4 ms of the main process, stacked on the tab's other work it was a 10 ms stall); unless the agent has already sent it somewhere.
      let moved = false;
      wc.once('did-start-navigation', () => { moved = true; });
      agentStep(() => { if (!moved) wc.loadURL(first).catch(() => {}); }, wc);
    } else wc.loadURL(first).catch(() => {});
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
const sleepShowFreed = () => readSettings().tabSleepShowFreed !== false; // [tabs] the hover card says about how much memory an unloaded tab freed
const SLEEP_CHECK_MS = 30 * 1000;
// Settings > Tabs > Memory (the sleep settings, with their defaults = what this always did): features/tab-sleep.js decides
// which tabs sleep (decideSleep); this file reads the facts, runs the page's own busy check, and does the sleeping.

// The numbers decideSleep's memory test reads. macOS: the kernel's own pressure level (1 normal, 2 warning, 4
// critical), the signal Activity Monitor's graph shows, because free-page counts are misleading there (compression);
// it stands in for the free-memory percentage. Elsewhere: free system memory against the chosen percentage.
// getSystemMemoryInfo is in kilobytes, an app metric's workingSetSize too.
function memoryInfo() {
  let lumenBytes = 0;
  try { lumenBytes = app.getAppMetrics().reduce((n, m) => n + (m.memory?.workingSetSize || 0), 0) * 1024; } catch { /* unknown: no limit on Lumen's own use applies */ }
  let total = 0;
  let free = 0;
  try { const m = process.getSystemMemoryInfo(); total = m.total * 1024; free = m.free * 1024; } catch { /* unknown */ }
  const info = { totalBytes: total, freeBytes: free, lumenBytes };
  if (process.platform !== 'darwin') return Promise.resolve(info);
  return new Promise((resolve) => {
    require('./ai/cli-utils').execFile('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeout: 5000 }, (err, out) => {
      if (err) { console.error('[lumen] memory pressure check failed:', err.message); return resolve(info); }
      resolve({ ...info, pressure: Number(out) >= 2 });
    });
  });
}
async function memoryPressure() { // (the test hook too) is memory low by the current settings?
  return tabSleep.memoryLow(tabSleep.normalize(readSettings()), await scheduler.memorySample({ ttlMs: 0 }));
}

// About how much memory a tab's page uses, in MB: its renderer process's working set (a process shared with another tab of the
// same site counts in full for each, so this is an estimate, and the status panel says "about").
function tabMemoryMb(wc, metrics) {
  try {
    const pid = wc.getOSProcessId();
    const m = (metrics || app.getAppMetrics()).find((x) => x.pid === pid);
    return m ? Math.round((m.memory?.workingSetSize || 0) / 1024) : 0;
  } catch { return 0; }
}
function sleepTab(tab) {
  finishLeaving(tab); // (a page that just left the new-tab page: the new-tab page goes now)
  const wc = tab.view.webContents;
  const placeholder = tab.placeholder; // an unloaded tab showing its Reload page goes back to sleep as the page it stands for
  tab.placeholder = null;
  tab.sleepUrl = placeholder ? placeholder.url : realUrl(wc) || wc.getURL();
  tab.sleepTitle = placeholder ? placeholder.title : wc.getTitle() || 'New Tab';
  tab.freedMb = placeholder ? tab.freedMb || 0 : tabMemoryMb(wc);
  // Back/forward (and each entry's saved scroll position and form fields) come back on wake.
  try {
    const nav = wc.navigationHistory;
    tab.sleepHistory = placeholder ? placeholder.history : { entries: nav.getAllEntries(), index: nav.getActiveIndex() };
  } catch {
    tab.sleepHistory = null;
  }
  tab.sleeping = true;
  tab.preloaded = false;
  tab.preloadMuted = false;
  wc.off('destroyed', tab.onViewDestroyed); // this is a sleep, not a close: don't let that handler drop the tab
  win.contentView.removeChildView(tab.view);
  wc.close();
  tab.view = null;
}

// "Sleep" in freeze mode: the page stays loaded (scroll, forms, scripts' state) but paused (Chromium's frozen lifecycle state,
// which stops its timers and scripts and lets it be paged out), so waking it is instant. Resolves false when it can't be frozen.
async function freezeTab(tab) {
  try {
    const wc = tab.view.webContents;
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    wc.setBackgroundThrottling(true);
    await wc.debugger.sendCommand('Page.setWebLifecycleState', { state: 'frozen' });
    if (!alive(tab) || tab.id === activeId) { await thawTab(tab, { quiet: true }); return false; } // the user came to it meanwhile
    tab.frozen = true;
    return true;
  } catch {
    return false;
  }
}
function thawTab(tab, { quiet = false } = {}) {
  const wasFrozen = tab.frozen;
  tab.frozen = false;
  tab.frozenFirst = false;
  tab.lastActiveAt = Date.now(); // its idle clock starts again
  if (!alive(tab)) return Promise.resolve();
  const wc = tab.view.webContents;
  return wc.debugger.isAttached() ? wc.debugger.sendCommand('Page.setWebLifecycleState', { state: 'active' }).catch(() => {}).then(() => { if (wasFrozen && !quiet) sendTabs(); }) : Promise.resolve();
}

// `placeholder`: wake into the Reload page instead of the page itself (Settings > Tabs > Page unloading); the page loads when its button is pressed (leavePlaceholder).
function wakeTab(tab, { placeholder = false } = {}) {
  if (tab.placeholder) { leavePlaceholder(tab); return; }
  if (tab.frozen) { thawTab(tab); return; }
  if (!tab.sleeping) return;
  tab.lastActiveAt = Date.now(); // woken (even in the background): its idle clock starts again, so the next sweep doesn't put it straight back
  // A web page with no back/forward list to bring back (a tab restored from the last session) wakes in the warm view.
  const warm = !placeholder && !tab.managerPage && !tab.isolated && !tab.sleepHistory?.entries?.length && isWebUrl(tab.sleepUrl || '') ? takeWarmTab() : null;
  if (tab.managerPage === 'chat') noteChatPage();
  const chatSpare = !placeholder && tab.managerPage === 'chat' && !tab.sleepHistory?.entries?.length && chatPage.isChatUrl(tab.sleepUrl || '') ? takeSpareChat() : null; // (a chat page that has already loaded)
  const view = warm || chatSpare || new WebContentsView({
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
  if (!warm && !chatSpare) { try { view.setBackgroundColor(pageBackground()); } catch { /* gone */ } } // (until the page paints: the theme's color, not a white flash in dark mode)
  if (placeholder) tab.placeholder = { url: tab.sleepUrl, title: tab.sleepTitle || '', history }; // (the page and its history wait in the tab until Reload)
  wireView(tab, tab.sleepUrl || newTabUrl(), placeholder ? null : history, { loaded: Boolean(chatSpare) || placeholder });
  if (placeholder) view.webContents.loadURL(`${UNLOADED_URL}?${new URLSearchParams({ url: tab.sleepUrl, title: tab.sleepTitle || '', mb: String(tab.freedMb || 0) })}`).catch(() => {});
  if (chatSpare) adoptSpareChat(chatSpare);
}
// The placeholder's Reload (or any use of the tab: Reload, the AI): the placeholder view closes and the tab wakes as it always did.
function leavePlaceholder(tab) {
  const p = tab.placeholder;
  if (!p) return;
  tab.placeholder = null;
  if (tab.view) {
    const wc = tab.view.webContents;
    wc.off('destroyed', tab.onViewDestroyed);
    try { win.contentView.removeChildView(tab.view); } catch { /* already out */ }
    try { wc.close(); } catch { /* gone */ }
    tab.view = null;
  }
  tab.sleeping = true;
  tab.sleepUrl = p.url;
  tab.sleepTitle = p.title;
  tab.sleepHistory = p.history;
  wakeTab(tab);
}
// Switching to an unloaded tab shows the Reload page (not the site) when the setting asks for it and the tab is an ordinary web page.
const placeholderMode = () => tabSleep.normalize(readSettings()).onReturn === 'placeholder';
const placeholderWanted = (tab) => placeholderMode() && Boolean(tab.sleeping) && !tab.isolated && !tab.managerPage && isWebUrl(tab.sleepUrl || '');
const isAsleep = (tab) => Boolean(tab && (tab.sleeping || tab.frozen || tab.placeholder));

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
const NO_ANSWER = Symbol('no answer');
// 'yes' | 'no' | 'unknown': the page's own answer, or none (it hung, crashed or threw). Closing an AI tab tells these apart: a hung
// page is not "holding text the user typed".
// '' (nothing holds it), a reason from tabSleep.pageBusyScript ('input' | 'upload' | 'media' | 'streaming' | 'busy' | 'changing'), or 'unknown'
async function pageHold(wc) {
  try {
    const answer = await Promise.race([
      wc.executeJavaScriptInIsolatedWorld(PAGE_TEXT_WORLD, [{ code: tabSleep.pageBusyScript(1200) }]),
      new Promise((resolve) => setTimeout(() => resolve(NO_ANSWER), 5000)),
    ]);
    if (answer === NO_ANSWER) return 'unknown';
    return typeof answer === 'string' ? answer : 'busy';
  } catch {
    return 'unknown';
  }
}
async function unsavedInputState(wc) {
  const hold = await pageHold(wc);
  return hold === 'unknown' ? 'unknown' : hold ? 'yes' : 'no';
}
// Does the page listen for "beforeunload" (it asks "Leave site?")? Read from the page's own event listeners over the debugger (the session
// every tab already has; one is opened only when it is missing). Any failure answers false: the typed-input check above is the one that guards work.
async function hasBeforeUnloadHandler(wc) {
  const dbg = wc.debugger;
  let own = false;
  let objectId = null;
  try {
    if (!dbg.isAttached()) { dbg.attach('1.3'); own = true; }
    const { result } = await dbg.sendCommand('Runtime.evaluate', { expression: 'window' });
    objectId = result.objectId;
    const { listeners } = await dbg.sendCommand('DOMDebugger.getEventListeners', { objectId });
    return listeners.some((l) => l.type === 'beforeunload');
  } catch {
    return false;
  } finally {
    if (objectId) dbg.sendCommand('Runtime.releaseObject', { objectId }).catch(() => {});
    if (own) { try { dbg.detach(); } catch { /* gone */ } }
  }
}
async function hasUnsavedInput(wc) {
  return (await unsavedInputState(wc)) !== 'no'; // any doubt counts as "yes, has input"
}

// What the sleep decision reads about a tab (features/tab-sleep.js decideSleep and keepReason).
function sleepFacts(tab) {
  const wc = alive(tab) ? tab.view.webContents : null;
  const url = wc ? realUrl(wc) : tab.sleepUrl || '';
  return {
    id: tab.id, alive: Boolean(wc), sleeping: Boolean(tab.sleeping || tab.frozen || tab.placeholder), asleep: Boolean(tab.sleeping || tab.placeholder), frozen: Boolean(tab.frozen), active: tab.id === activeId || (Boolean(tab.split) && splitView()?.partner === tab), // ([split view] the other side of the pair on show is in use too) settings: tab.settings, closing: tab.closing, unloadAsked: tab.unloadAsked,
    openPopups: tab.openPopups, agentUsing: wc ? agent.usingTab(tab.id) || Boolean(tab.rec?.agent) : false, aiLock: tab.aiLock, webPage: wc ? isWebUrl(url) || isNewTab(url) : false, newTab: wc ? isNewTab(url) : false, // (a new-tab page sleeps too, and soon: tab-sleep.js)
   
    loading: wc?.isLoading(), audible: wc?.isCurrentlyAudible(), fullscreen: tab.fullscreen, devTools: wc?.isDevToolsOpened(),
    capturing: wc ? (wc.isBeingCaptured() && !TEST) || mediaPages.has(wc) : false, // a camera, microphone or screen share (or the page being recorded). (Not in tests: the Playwright connection that drives them counts as a capturer on every page.)
    downloading: wc ? downloads.list.some((d) => d.state === 'progressing' && d.contents === wc) : false, grouped: Boolean(tab.groupId),
    pinned: Boolean(tab.pinned), host: hostOf(url), lastActive: tab.lastActiveAt, viewedAt: tab.viewedAt || 0,
  };
}

// Never the active tab, never a tab an AI task is working in (it keeps its tab when the user switches
// away), never settings/internal pages, never a tab mid-close, mid-navigation, playing audio, capturing, one the settings
// exempt (pinned, a listed site), or with typed form input. On any doubt this returns false and the tab is left alone.
// (An agent's own window keeps its tabs loaded: agentUsing covers them.)
async function canSleep(tab, s = tabSleep.normalize(readSettings())) {
  const facts = tab ? withWindow(tab.rec, () => sleepFacts(tab)) : null;
  if (!facts || tabSleep.keepReason({ ...facts, keepPinned: s.keepPinned, neverSite: tabSleep.hostListed(facts.host, s.never), keepAudio: s.keepAudio, keepTransfers: s.keepTransfers, keepGroups: s.keepGroups })) return false;
  const wc = tab.view.webContents;
  const hold = await pageHold(wc);
  // Each thing the page may be holding has its own switch (typed text, a chosen upload, playing media); a reply streaming in, a busy page or any doubt always keeps the tab.
  if (hold === 'input' ? s.keepForms : hold === 'upload' ? s.keepTransfers : hold === 'media' ? s.keepAudio : hold !== '') return false;
  return !(s.keepForms && (await hasBeforeUnloadHandler(wc)));
}

// Put a tab to sleep the chosen way: 'unload' closes the page (it reloads on return, keeping its place), 'freeze' pauses it in memory.
async function putToSleep(tab, how) {
  if (how === 'freeze') return freezeTab(tab); // couldn't be frozen (another debugger, a page going away): left awake, never unloaded unasked
  sleepTab(tab);
  return true;
}

let sweeping = false;
async function sweepSleep() {
  if (!win || win.isDestroyed() || sweeping) return;
  const settings = readSettings();
  const s = tabSleep.normalize(settings);
  if (s.mode === 'off') return;
  sweeping = true;
  try {
    const memory = s.useMemory ? await pressureCheck() : null;
    const { sleep, capExcess, low } = tabSleep.decideSleep({ tabs: tabs.map(sleepFacts), settings, now: Date.now(), memory, limits: perfMode.active() ? perfMode.limits() : {} }); // Performance mode: sooner, and fewer kept (its normal limits must not cap the user's own time at 20 minutes)
    let capLeft = capExcess;
    for (const { id, why } of sleep) {
      if (why === 'cap' && capLeft <= 0) continue; // (the cap is reached: the rest of the list is for the other reasons)
      const tab = tabs.find((t) => t.id === id);
      if (!tab || !(await canSleep(tab, s))) continue;
      // The page check (inside canSleep) is an async round trip (over a second): re-check the fast,
      // synchronous conditions in case the user switched to (or closed) this exact tab, or it started playing, meanwhile.
      if (!alive(tab) || tab.sleeping || tab.frozen || tab.id === activeId || tab.view.webContents.isCurrentlyAudible() || tab.view.webContents.isLoading()) continue;
      // Freeze first (Settings > Tabs > Memory, off by default): an idle tab that would unload is frozen instead for a while, so
      // coming back to it is instant; it unloads once that time has passed (below) or memory runs low.
      const how = sleepFacts(tab).newTab ? 'unload' : tabWake.sleepHow({ how: s.how, why, freezeFirstMin: s.freezeFirst, low }); // (a new-tab page is cheap to build again: always unloaded)
      if (how === 'freeze-first') {
        if (await freezeTab(tab)) { tab.frozenFirst = true; tab.frozenAt = Date.now(); sendTabs(); continue; }
      }
      if (await putToSleep(tab, how === 'freeze' ? 'freeze' : 'unload')) { sendTabs(); if (why === 'cap') capLeft--; }
    }
    const due = tabWake.dueToUnload({ frozen: tabs.filter((t) => t.frozen && t.frozenFirst).map((t) => ({ id: t.id, frozenAt: t.frozenAt, first: true })), now: Date.now(), freezeFirstMin: s.freezeFirst, low });
    for (const id of due) {
      const tab = tabs.find((t) => t.id === id);
      if (!tab || !alive(tab) || !tab.frozen || tab.id === activeId || tab.view.webContents.isCurrentlyAudible()) continue;
      await thawTab(tab, { quiet: true });
      if (alive(tab) && tab.id !== activeId && !tab.sleeping) { sleepTab(tab); sendTabs(); }
    }
  } finally {
    sweeping = false;
  }
}

// A tab's menu: "Unload tab" (or "Put tab to sleep" when tabs are frozen instead), "Unload other tabs", and "Never unload this site". Unloading now
// ignores the idle clock and the page's own checks (you asked), but not what would lose work or break a task (the tab in front, an AI task, popups, a tab closing).
const canSleepNow = (tab) => !tabSleep.keepReason({ ...sleepFacts(tab), loading: false, audible: false, fullscreen: false, devTools: false, capturing: false });
function sleepMenuItems(tab) {
  const asleep = isAsleep(tab);
  const s = tabSleep.normalize(readSettings());
  const host = tabSleep.cleanHost(hostOf(tabUrl(tab)));
  const never = readSettings().tabSleepNever || [];
  const listed = Boolean(host) && never.includes(host);
  const others = tabs.some((x) => x.id !== tab.id && x.id !== activeId && alive(x) && !x.settings && !x.sleeping && !x.frozen && !x.placeholder);
  return [
    asleep
      ? { label: t('menu.wakeTab'), click: () => { wakeTab(tab); layout(); sendTabs(); } }
      : { label: t(s.how === 'freeze' ? 'menu.sleepTabNow' : 'menu.unloadTab'), enabled: canSleepNow(tab), click: () => { putToSleep(tab, s.how).then(() => sendTabs()).catch(() => {}); } },
    { label: t('menu.unloadOtherTabs'), enabled: others, click: () => { unloadBackgroundTabs(tab.id).then(() => sendTabs()).catch(() => {}); } },
    ...(host && isWebUrl(tabUrl(tab)) ? [{
      label: t(listed ? 'menu.allowSiteSleep' : 'menu.neverSleepSite', { host }),
      click: () => { writeSettings({ ...readSettings(), tabSleepNever: listed ? never.filter((x) => x !== host) : [...never, host] }); try { settingsBackend.pushUiPrefs(); } catch { /* the UI isn't up yet */ } },
    }] : []),
  ];
}
// "Unload all background tabs now" (Settings > Tabs > Page unloading) and "Unload other tabs" (a tab's menu): every background tab in every
// window that the exceptions allow (the tab in front, audio, pinned, typed text, calls, the AI, downloads ... stay), put to sleep the chosen way at once.
// Resolves to how many were unloaded.
async function unloadBackgroundTabs(exceptId = null) {
  const s = tabSleep.normalize(readSettings());
  let n = 0;
  for (const rec of [...winRecs]) {
    if (!rcAlive(rec) || rec.agent) continue;
    for (const tab of [...tabsOf(rec)]) {
      if (tab.id === exceptId || !tab.view || tab.sleeping || tab.frozen || tab.placeholder) continue;
      if (!(await canSleep(tab, s))) continue;
      const stillBackground = withWindow(rec, () => tab.id !== activeId && alive(tab) && !tab.sleeping && !tab.view.webContents.isCurrentlyAudible());
      if (!stillBackground) continue;
      if (await withWindow(rec, () => putToSleep(tab, s.how))) { n++; withWindow(rec, () => sendTabs()); }
    }
  }
  return n;
}
// The status panel (Settings > Tabs > Page unloading): what is loaded, unloaded and exempt, in every window, and about how much memory that is.
// One getAppMetrics call; the page asks only while the section is on screen.
function sleepStatus() {
  const settings = readSettings();
  const s = tabSleep.normalize(settings);
  const facts = [];
  let freedMb = 0;
  for (const rec of [...winRecs]) {
    if (!rcAlive(rec) || rec.agent) continue;
    withWindow(rec, () => { for (const tab of tabsOf(rec)) { if (tab.closing) continue; facts.push(sleepFacts(tab)); if (tab.sleeping || tab.placeholder) freedMb += tab.freedMb || 0; } });
  }
  let usedMb = 0;
  let totalMb = 0;
  try {
    for (const m of app.getAppMetrics()) { const mb = (m.memory?.workingSetSize || 0) / 1024; totalMb += mb; if (m.type === 'Tab') usedMb += mb; }
  } catch { /* unknown */ }
  let freePercent = null;
  try { const m = process.getSystemMemoryInfo(); if (m.total > 0) freePercent = Math.round(m.free / m.total * 100); } catch { /* unknown */ }
  const limit = perfMode.active() ? perfMode.limits().sleepAfterMs : Infinity;
  return {
    ...tabSleep.tally(facts, settings),
    lists: { tabSleepNever: s.never, tabSleepSoon: s.soon }, // (the page follows a change made elsewhere, such as the tab menu's "Never unload this site")
    usedMb: Math.round(usedMb), totalMb: Math.round(totalMb), freedMb: Math.round(freedMb), freePercent,
    performance: perfMode.active() ? { afterMinutes: Number.isFinite(limit) ? Math.round(limit / 60e3) : null, cap: Number.isFinite(perfMode.limits().maxLiveBackgroundTabs) ? perfMode.limits().maxLiveBackgroundTabs : null } : null,
    effectiveMinutes: s.minutes > 0 ? Math.min(s.minutes, Number.isFinite(limit) ? Math.round(limit / 60e3) : Infinity) : Number.isFinite(limit) && s.explicit ? Math.round(limit / 60e3) : 0,
  };
}
// The host of the page the user was last on in a normal tab (Settings' "Add current site").
function currentSleepSite() {
  let best = null;
  for (const rec of [...winRecs]) {
    if (!rcAlive(rec)) continue;
    for (const tab of tabsOf(rec)) {
      const url = tab.sleeping ? tab.sleepUrl || '' : alive(tab) ? realUrl(tab.view.webContents) : '';
      if (tab.settings || !isWebUrl(url)) continue;
      const at = (tab.viewedAt || 0) || tab.lastActiveAt || 0;
      if (!best || at > best.at) best = { at, url };
    }
  }
  return best ? tabSleep.cleanHost(hostOf(best.url)) : '';
}
// A sleep setting changed (Settings > Tabs > Page unloading): applies at once. Switched off, frozen tabs wake; otherwise a sweep runs now
// (and the strip and hover cards are sent again: the dimmed icon and the freed-memory line are settings too).
let sleepSweepSoon = null;
function tabSleepSettingChanged() {
  sendTabs();
  if (tabSleep.normalize(readSettings()).mode === 'off') {
    for (const tab of tabs) if (tab.frozen) thawTab(tab).catch(() => {});
    return;
  }
  clearTimeout(sleepSweepSoon); // (a reset changes a dozen settings in a row: one sweep)
  sleepSweepSoon = setTimeout(() => { sweepSleep().catch(() => {}); }, 300);
  sleepSweepSoon.unref?.();
}let pressureCheck = () => scheduler.memorySample(); // (one sample shared with the spare-tab policy)
scheduler.every('tab-sleep-sweep', SLEEP_CHECK_MS, () => sweepSleep().catch(() => {}), { whenHidden: 2 * 60 * 1000 }); // (still swept while minimised: that is when memory is wanted)
if (TEST) global.__tabSleep = { sleep: (id) => { const t = tabs.find((x) => x.id === id); if (t && alive(t)) sleepTab(t); sendTabs(); }, canSleep: (id) => canSleep(tabs.find((x) => x.id === id)), state: () => tabs.map((t) => ({ id: t.id, sleeping: Boolean(t.sleeping), frozen: Boolean(t.frozen), view: Boolean(t.view), placeholder: Boolean(t.placeholder), freedMb: t.freedMb || 0 })), sweep: () => sweepSleep(), status: () => sleepStatus(), unloadAll: () => unloadBackgroundTabs(null), currentSite: () => currentSleepSite(), memoryPressure, fakePressure: (on) => { pressureCheck = () => Promise.resolve({ pressure: on }); }, frozen: (id) => Boolean(tabs.find((x) => x.id === id)?.frozen), freeze: (id) => freezeTab(tabs.find((x) => x.id === id)), thaw: (id) => thawTab(tabs.find((x) => x.id === id)), sleepNow: (id) => putToSleep(tabs.find((x) => x.id === id), tabSleep.normalize(readSettings()).how), menuItems: (id) => sleepMenuItems(tabs.find((x) => x.id === id)).map((i) => ({ label: i.label, enabled: i.enabled !== false })), changed: tabSleepSettingChanged, age: (id, ms) => { const t = tabs.find((x) => x.id === id); if (t) t.lastActiveAt -= ms; } };

// ---------- waking tabs faster: wake ahead, background preload (features/tab-wake.js) ----------
// A placeholder (restored, lazy) or unloaded tab has no page until it is woken. A tab is woken when the pointer rests on it
// (100 ms), on mousedown, or is the next one a keyboard switch would reach; once the front tab has loaded and the machine is
// idle, a few likely next tabs are woken one at a time (Settings > Tabs > Memory). There is no picture of the page while it
// loads: the view shows the theme's background (wakeTab) until the page paints.
const tabWake = require('./features/tab-wake');
let wakeForTest = false; // tests leave all of this off (it changes what a switch shows) unless one turns it on
const wakeOn = () => !TEST || wakeForTest;

// Is memory low by the sleep settings (the test hook __tabSleep.fakePressure stands in for the system's answer)?
const memoryIsLow = async () => { try { return tabSleep.memoryLow(tabSleep.normalize(readSettings()), await pressureCheck()); } catch { return false; } };

// ---- wake ahead ----
const sensitiveUrl = (url) => Boolean(tabWake.sensitiveAddress(url));
function wakeFacts(tab) {
  const url = tab.sleepUrl || '';
  return { id: tab.id, sleeping: Boolean(tab.sleeping), frozen: Boolean(tab.frozen), web: isWebUrl(url), isolated: Boolean(tab.isolated), internal: Boolean(tab.settings || tab.managerPage), sensitive: sensitiveUrl(url), lastActive: tab.viewedAt || tab.lastActiveAt || 0 };
}
// How many more background tabs the sleep cap (Settings, Performance mode) lets stay awake; Infinity: no cap.
function awakeRoom() {
  const s = tabSleep.normalize(readSettings());
  const limit = perfMode.limits().maxLiveBackgroundTabs;
  const cap = Math.min(s.maxAwake > 0 ? s.maxAwake : Infinity, Number.isFinite(limit) ? limit : Infinity);
  if (!Number.isFinite(cap)) return Infinity;
  return cap - tabs.filter((t) => alive(t) && !t.sleeping && !t.frozen && t.id !== activeId).length;
}
function wakeAhead(tab, why) {
  if (!tab || !tab.sleeping || tab.frozen || placeholderMode()) return false; // (with the Reload page, nothing wakes an unloaded tab but the user's own click)
  wakeTab(tab);
  tab.wokeAhead = why;
  sendTabs();
  return true;
}
function preconnectTo(tab) {
  const url = tab?.sleepUrl || '';
  if (!tab?.sleeping || !isWebUrl(url) || tab.isolated) return;
  try { session.defaultSession.preconnect({ url: new URL(url).origin, numSockets: 1 }); } catch { /* an address that is not one */ }
}
const hoverIntents = new WeakMap(); // window record -> hover intent
function hoverIntentFor(rec) {
  let h = hoverIntents.get(rec);
  if (h) return h;
  const find = (id) => withWindow(rec, () => tabs.find((t) => t.id === id));
  h = tabWake.createHoverIntent({
    onPreview: (id) => withWindow(rec, () => preconnectTo(find(id))),
    onIntent: async (id, why) => {
      if (!rcAlive(rec) || !find(id)) return;
      // A press is a click on its way: the wake costs nothing a click would not. A hover also checks memory and the sleep cap.
      const low = why === 'hover' ? await memoryIsLow() : false;
      if (!rcAlive(rec)) return;
      withWindow(rec, () => {
        const t = find(id);
        if (why === 'press' && rapidSwitching()) return; // (switching in a burst: the click's own switch wakes the tab it ends on)
        if (!t || !tabWake.hoverGate(wakeFacts(t), { memoryLow: low, room: why === 'hover' ? awakeRoom() : Infinity }).go) return;
        wakeAhead(t, why);
      });
    },
  });
  hoverIntents.set(rec, h);
  return h;
}
const wakeSender = (event) => { const rec = recOfSender(event.sender); return wakeOn() && rec && winRecs.has(rec) && rcAlive(rec) ? rec : null; };
ipcMain.on('tab:hover', (event, id, on) => {
  if (!Number.isInteger(id)) return;
  readyPointer(event, id, on ? 'enter' : 'leave');
  const rec = wakeSender(event);
  if (!rec) return;
  const h = hoverIntentFor(rec);
  if (on) h.enter(id); else h.leave(id);
});
ipcMain.on('tab:down', (event, id) => {
  if (!Number.isInteger(id)) return;
  readyPointer(event, id, 'down');
  const rec = wakeSender(event);
  if (rec) hoverIntentFor(rec).down(id);
});

// ---- tabs kept ready: the renderer of the tab you are about to switch to is not parked (features/tab-ready.js) ----
// Chromium parks a hidden tab's renderer at background priority (and, on Windows 11, in efficiency mode), so the first frame after a pause is slow.
// The tab under the pointer, and the latest few background tabs, are kept out of that state (setBackgroundThrottling(false)), within limits: see tab-ready.js.
const tabReady = lazy(() => require('./features/tab-ready'));
let readyForTest = false; // tests leave it off unless one turns it on (test/e2e/tab-ready.js)
const readyOn = () => !TEST || readyForTest;
const readies = new Map(); // window record -> { ctl, hoverId, intent, timer }
function readyFor(rec) {
  let r = readies.get(rec);
  if (r) return r;
  r = { ctl: null, hoverId: null, intent: null, timer: null };
  r.ctl = tabReady.create({
    apply: (id, on, token) => withWindow(rec, () => {
      const t = tabs.find((x) => x.id === id);
      if (!alive(t)) return null;
      const wc = t.view.webContents;
      if ((token && token !== wc) || agentContents.has(wc) || unthrottled.has(id)) return null; // (a woken page, or one a run or an agent window keeps unthrottled itself)
      wc.setBackgroundThrottling(!on);
      return on ? wc : null;
    }),
  });
  r.intent = tabWake.createHoverIntent({ delayMs: tabReady.HOVER_MS, onIntent: (id) => { r.hoverId = id; syncReady(rec); } });
  readies.set(rec, r);
  if (rec.win && !rec.win.isDestroyed()) {
    for (const ev of ['minimize', 'restore', 'show', 'hide']) rec.win.on(ev, () => scheduleReadySync(rec));
    rec.win.once('closed', () => { clearTimeout(r.timer); for (const id of r.ctl.ids()) r.ctl.forget(id); readies.delete(rec); });
  }
  return r;
}
const readyFact = (t) => ({
  id: t.id, active: t.id === activeId, lastActive: Math.max(t.viewedAt || 0, t.lastActiveAt || 0),
  ready: alive(t) && !t.frozen && !t.sleeping && !t.placeholder && !t.closing,
  token: alive(t) ? t.view.webContents : null,
});
const onBatteryNow = () => { if (TEST && global.__tabReadyBattery != null) return global.__tabReadyBattery; try { return require('electron').powerMonitor.isOnBatteryPower(); } catch { return false; } };
function readyState(rec = curRec) { // what is kept ready now, and why: the diagnostics export and the tests read it
  const r = readies.get(rec);
  return r ? r.ctl.ids().map((id) => ({ id, why: r.ctl.why(id) })) : [];
}
function syncReady(rec = curRec) {
  if (!readyOn() || !rcAlive(rec)) return;
  const r = readyFor(rec);
  withWindow(rec, () => {
    const settings = readSettings();
    const sleepS = tabSleep.normalize(settings);
    const facts = tabs.map(readyFact);
    let memoryLow = false;
    try { memoryLow = sleepS.useMemory && Boolean(scheduler.lastMemory()) && tabSleep.memoryLow(sleepS, scheduler.lastMemory()); } catch { /* unknown: not low */ }
    const want = tabReady.wanted(facts, {
      activeId, hoverId: r.hoverId, recent: settings.tabReadyRecent, onBattery: onBatteryNow(), memoryLow,
      perfMode: perfMode.mode() === 'on', windowActive: !win.isMinimized() && win.isVisible(),
    });
    r.ctl.sync(want, facts);
  });
}
function scheduleReadySync(rec) {
  if (!readyOn() || !rcAlive(rec)) return;
  const r = readyFor(rec);
  if (r.timer) return;
  r.timer = setTimeout(() => { r.timer = null; syncReady(rec); }, tabReady.SYNC_MS);
  r.timer.unref?.();
}
// The pointer on a tab in the strip: 'enter' (60 ms rest), 'leave', 'down' (the click is on its way).
function readyPointer(event, id, kind) {
  if (!readyOn()) return;
  const rec = recOfSender(event.sender);
  if (!rec || !winRecs.has(rec) || !rcAlive(rec)) return;
  const r = readyFor(rec);
  if (kind === 'enter') r.intent.enter(id);
  else if (kind === 'down') r.intent.down(id);
  else { r.intent.leave(id); if (r.hoverId === id) { r.hoverId = null; syncReady(rec); } }
}
if (TEST) global.__tabReady = { enable: (on = true) => { readyForTest = on; }, battery: (on) => { global.__tabReadyBattery = on; }, sync: () => syncReady(), state: () => readyState(), hover: (id) => { const r = readyFor(curRec); r.hoverId = id; syncReady(); }, throttling: (id) => { const t = tabs.find((x) => x.id === id); return alive(t) ? { pid: t.view.webContents.getOSProcessId(), priority: osPriority(t.view.webContents.getOSProcessId()) } : null; }, visibleCalls: () => viewVisibleCalls };
const osPriority = (pid) => { try { return require('os').getPriority(pid); } catch { return null; } }; // Windows: 19 idle (background), 10 below normal, 0 normal, -7 above normal
// A keyboard switch (Ctrl+Tab, Alt+Cmd+Arrow) goes at once; the tab it would reach next wakes behind it, so a second press is instant too.
// Held or repeated Ctrl+Tab cycles through the strip without waking each tab it would reach next: only once the cycling pauses does the tab after the one it stopped on wake.
let keyboardAheadTimer = null;
function wakeAfterKeyboard(direction) {
  if (!wakeOn()) return;
  clearTimeout(keyboardAheadTimer);
  const rec = curRec;
  keyboardAheadTimer = setTimeout(() => { if (rcAlive(rec)) withWindow(rec, () => wakeNextAhead(direction)); }, KEYBOARD_AHEAD_MS);
  keyboardAheadTimer.unref?.();
}
const KEYBOARD_AHEAD_MS = 250;
function wakeNextAhead(direction) {
  const list = tabs.filter((t) => !aiTabHidden(t));
  const at = list.findIndex((t) => t.id === activeId);
  const next = list.length > 1 && at >= 0 ? list[(at + direction + list.length) % list.length] : null;
  const rec = curRec;
  if (!next) return;
  memoryIsLow().then((low) => {
    if (!rcAlive(rec)) return;
    withWindow(rec, () => { const t = tabs.find((x) => x.id === next.id); if (t && tabWake.hoverGate(wakeFacts(t), { memoryLow: low, room: awakeRoom() }).go) wakeAhead(t, 'keyboard'); });
  });
}

// ---- background preload after startup ----
const preloading = new WeakSet(); // window records with a preload loop running
const sleepMs = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); });
async function cpuPercent() { // the whole app's CPU use over one second, % of one core
  try { app.getAppMetrics(); await sleepMs(1000); return app.getAppMetrics().reduce((n, m) => n + (m.cpu?.percentCPUUsage || 0), 0); } catch { return null; }
}
async function preloadLoop(rec) {
  if (!wakeOn() || preloading.has(rec)) return;
  preloading.add(rec);
  try {
    let busyTries = 0;
    while (rcAlive(rec) && !quitting) {
      const cap = placeholderMode() ? 0 : tabWake.cleanPreload(readSettings().tabPreload);
      const front = withWindow(rec, () => { const t = tabs.find((x) => x.id === activeId); return alive(t) && !t.view.webContents.isLoading() && !rec.pendingRestore; });
      const waiting = withWindow(rec, () => tabs.filter((t) => t.preloaded && alive(t) && !t.sleeping && t.id !== activeId).length);
      const perf = perfMode.mode() === 'on' || perfMode.reasons().some((r) => r.key === 'memory');
      let onBattery = false;
      try { onBattery = require('electron').powerMonitor.isOnBatteryPower(); } catch { /* unknown: not on battery */ }
      const memoryLow = cap > 0 ? await memoryIsLow() : false;
      const cpu = cap > 0 && front ? await cpuPercent() : null;
      const gate = tabWake.preloadGate({ cap, waiting, frontLoaded: front, cpu, onBattery, perfMode: perf, memoryLow, quitting });
      if (!gate.go) {
        if ((gate.why === 'busy' || gate.why === 'front-loading') && ++busyTries <= 6) { await sleepMs(3000); continue; } // wait for idle, a while
        break;
      }
      const tab = withWindow(rec, () => {
        const [id] = tabWake.pickPreloads({ tabs: tabs.map(wakeFacts), activeId, cap, waiting, room: awakeRoom(), max: 1 });
        const t = tabs.find((x) => x.id === id);
        if (!t) return null;
        wakeAhead(t, 'preload');
        t.preloaded = true;
        const wc = t.view.webContents;
        try { wc.setBackgroundThrottling(true); if (!t.muted && !wc.isAudioMuted()) { wc.setAudioMuted(true); t.preloadMuted = true; } } catch { /* gone */ }
        return t;
      });
      if (!tab) break;
      await new Promise((resolve) => {
        const wc = tab.view?.webContents;
        if (!wc || wc.isDestroyed()) return resolve();
        const timer = setTimeout(resolve, 20000);
        timer.unref?.();
        wc.once('did-stop-loading', () => { clearTimeout(timer); resolve(); });
        wc.once('destroyed', () => { clearTimeout(timer); resolve(); });
      });
      await sleepMs(tabWake.PRELOAD_GAP_MS);
    }
  } finally {
    preloading.delete(rec);
  }
}
let preloadTimer = null;
function schedulePreload(ms = 4000) {
  if (!wakeOn()) return;
  const rec = curRec;
  clearTimeout(preloadTimer);
  preloadTimer = setTimeout(() => { if (rcAlive(rec)) preloadLoop(rec).catch((err) => console.error('[lumen] preload:', err.message)); }, ms);
  preloadTimer.unref?.();
}
// A tab the user opens gets what a preload muted back; and it is theirs now (no longer waiting to be used).
function adoptPreloaded(tab) {
  tab.preloaded = false;
  if (!tab.preloadMuted) return;
  tab.preloadMuted = false;
  try { if (alive(tab) && !tab.muted && !tab.siteMuted) tab.view.webContents.setAudioMuted(false); } catch { /* gone */ }
}

if (TEST) {
  global.__wake = {
    enable: (on = true) => { wakeForTest = on; },
    state: () => tabs.map((t) => ({ id: t.id, url: t.sleepUrl || (alive(t) ? realUrl(t.view.webContents) : ''), sleeping: Boolean(t.sleeping), frozen: Boolean(t.frozen), frozenFirst: Boolean(t.frozenFirst), preloaded: Boolean(t.preloaded), wokeAhead: t.wokeAhead || null })),
    preload: () => preloadLoop(curRec),
    hover: (id, on) => { const h = hoverIntentFor(curRec); if (on) h.enter(id); else h.leave(id); },
    down: (id) => hoverIntentFor(curRec).down(id),
    keyboard: (d) => wakeAfterKeyboard(d),
    keepReason: (id) => { const t = tabs.find((x) => x.id === id); if (!t) return null; const st = tabSleep.normalize(readSettings()); return tabSleep.keepReason({ ...sleepFacts(t), keepPinned: st.keepPinned, neverSite: tabSleep.hostListed(sleepFacts(t).host, st.never) }); },
    markFrozenFirst: (id) => { const t = tabs.find((x) => x.id === id); if (t?.frozen) { t.frozenFirst = true; t.frozenAt = Date.now(); } return Boolean(t?.frozen); },
    ageFrozen: (id, ms) => { const t = tabs.find((x) => x.id === id); if (t) t.frozenAt -= ms; },
  };
}

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
ipcMain.on('address:touched', (event) => {
  const touched = recOfSender(event?.sender);
  if (touched?.agent) touched.agent.used = true; // [agent window] the user is using the agent's window: it is theirs to keep
  addressTouchedAt = ++uiEventSeq;
  // (Typing is coming: ready before the first key's list. Not while the first tab is still loading at start-up: the
  // new-tab page's address-bar focus lands here then, and the dropdown's renderer is made once that tab has loaded.)
  if (!suggestView && firstTabDone && win && !win.isDestroyed()) createSuggestView();
  if (!ui()?.isFocused()) ui()?.focus();
  const wc = activeTab()?.webContents;
  if (wc && isNewTab(wc.getURL())) wc.executeJavaScript('document.activeElement?.blur()').catch(() => {});
});

// A tab behind the one in front must never hold the keyboard. Chromium hands a new view focus when it is added or
// first loads (even hidden), so typing in the address bar or a page went to a tab nobody could see: a link opened in a
// new tab, an AI tab. Whoever had the keyboard in this window (the UI or the tab in front, as last seen) gets it back.
// A tab comes to the front first, then takes focus, so this never fights the user's own tab switch.
function keepKeyboardFromBackgroundTab(tab) {
  const wc = tab.view.webContents;
  const take = () => {
    const rec = tab.rec;
    if (!rec || !rec.win || rec.win.isDestroyed() || wc.isDestroyed()) return;
    if (tab.id === activeId) { rec.keyboardOwner = wc; return; }
    if (tab.view?.webContents !== wc) return; // (the view was swapped: leaveNewTabFor; or unloaded: no view)
    const ui = rec.win.webContents;
    const back = rec.keyboardOwner;
    // (the owner counts only while it is the UI or the tab in front: a tab left behind is not where the keyboard is)
    const target = back && !back.isDestroyed() && back !== wc && (back === ui || tabByContents(back)?.id === activeId) ? back : ui;
    if (handsOff.mayFocus(rec)) target.focus(); // [agent window] never moves the keyboard in a window the user is not in
  };
  wc.on('focus', take);
  // A page loading behind (autofocus, a script's focus()) can take it silently as it finishes.
  const check = () => { if (!wc.isDestroyed() && tab.id !== activeId && wc.isFocused()) take(); };
  wc.on('did-stop-loading', () => { check(); setTimeout(check, 200).unref?.(); });
  return take;
}

function guardFirstLoadFocus(tab, url) {
  const openedAt = ++uiEventSeq;
  const wc = tab.view.webContents;
  const blank = isNewTab(url);
  let pageClicked = false;
  let ended = false;
  const onMouse = (_e, mouse) => { if (mouse.type === 'mouseDown') { pageClicked = true; end(); } };
  const keepAddress = () => !ended && !pageClicked && (blank || addressTouchedAt > openedAt);
  const mine = () => !wc.isDestroyed() && alive(tab) && tab.id === activeId && keepAddress();
  const giveBack = () => {
    if (!mine()) return;
    ui()?.focus();
    // Chromium can finish handing the page the keyboard just after its focus event: look again a moment later.
    setTimeout(() => { if (mine() && wc.isFocused()) ui()?.focus(); }, 60).unref?.();
  };
  const onNavigate = (_e, to) => { if (!isNewTab(to || '')) end(); }; // the page was left for a real page: Chromium's own focus rules apply
  function end() {
    if (ended) return;
    ended = true;
    tab.endFocusGuard = null;
    if (wc.isDestroyed()) return;
    wc.off('focus', giveBack);
    wc.off('before-mouse-event', onMouse);
    wc.off('did-navigate', onNavigate);
  }
  wc.on('focus', giveBack);
  wc.on('before-mouse-event', onMouse);
  tab.endFocusGuard = end;
  if (blank) {
    // A new-tab page keeps the cursor in the address bar for as long as it is in front and has not been clicked: its
    // widgets load later (a framed calendar focuses itself as it loads, seconds after the page), and the page being
    // loaded says nothing about whether the user has chosen to use it. Leaving the tab or the page ends it.
    wc.on('did-navigate', onNavigate);
    wc.once('destroyed', end);
    focusAddress();
    return;
  }
  wc.once('did-finish-load', () => {
    if (alive(tab) && tab.id === activeId && keepAddress() && !ui()?.isFocused()) ui()?.focus();
    setTimeout(end, 1000).unref?.();
  });
}

// True only while a run's own tab tool (open_tab / switch_tab) is switching, synchronously: set by asAiSwitch. Not derived from the
// ambient task scope, so a switch by the user, the window or the test hooks while a reply runs is never taken for the AI's.
let aiToolSwitch = false;
function asAiSwitch(fn) {
  const before = aiToolSwitch;
  aiToolSwitch = true;
  try { return fn(); } finally { aiToolSwitch = before; }
}
// Switching in quick succession (a burst of clicks, Ctrl+Tab held): the latest switch wins. The tab you land on is shown at once; an
// unloaded or frozen tab you only pass through is not woken (a reload per tab passed piled up behind the one you wanted). A tab you
// stop on wakes SWITCH_SETTLE_MS later; a lone switch wakes it at once.
const RAPID_SWITCH_MS = 400;
const SWITCH_SETTLE_MS = 150;
let lastSwitchAt = 0;
const rapidSwitching = () => Date.now() - lastSwitchAt < RAPID_SWITCH_MS;
const SWITCH_WORLD = 1005; // the isolated world of the recorder's probes (never the page's own)
function beginSwitchTiming(tab, input, rapid = false) {
  const wc = tab.view?.webContents;
  const live = Boolean(wc) && !wc.isDestroyed();
  const url = live ? realUrl(wc) : tab.sleepUrl || '';
  const h = switchTiming.begin({
    source: input?.source, inputAt: input?.at, tab: tab.id, page: isWebUrl(url) ? 'web' : 'lumen',
    state: tab.sleeping ? (placeholderWanted(tab) ? 'placeholder' : 'unloaded') : tab.frozen ? 'frozen' : 'live',
    pid: live ? wc.getOSProcessId() : null, throttled: live && !unthrottled.has(tab.id) && !agentContents.has(wc),
    rapid, ready: readies.get(curRec)?.ctl.why(tab.id) || null, // 'hover' | 'recent' | null: was it kept ready (tab-ready.js) when the switch began
    idleMs: tab.lastActiveAt ? Date.now() - tab.lastActiveAt : null, // how long since the tab was last in front
    priority: live ? osPriority(wc.getOSProcessId()) : null, onBattery: onBatteryNow(), visibleCallsAtStart: viewVisibleCalls,
  });
  switchHandle = h ? { h, id: tab.id } : null;
  if (h && live) probeSwitch(tab, h, false); // (what the page's visibility was as the switch began: still hidden, normally)
  return h;
}
// One rAF in the tab, in an isolated world (it never runs the page's own code): the first frame the tab's renderer makes once it is visible.
function probeSwitch(tab, h, paint) {
  const wc = tab.view?.webContents;
  if (!wc || wc.isDestroyed()) return;
  const code = paint ? 'new Promise((r) => requestAnimationFrame(() => r([performance.timeOrigin + performance.now(), document.visibilityState])))' : 'document.visibilityState';
  wc.executeJavaScriptInIsolatedWorld(SWITCH_WORLD, [{ code }]).then((v) => {
    if (!paint) h.visibilityBefore(v);
    else if (activeId !== tab.id || switchHandle?.h !== h) h.superseded();
    else { h.paint(v[0], v[1]); h.after({ priority: osPriority(wc.getOSProcessId()), visibleCalls: viewVisibleCalls }); }
  }).catch(() => {});
}
function syncSwitchTiming() {
  const on = readSettings().recordSwitchTimings === true;
  if (on === switchTimingOn) return;
  switchTimingOn = on;
  if (on || switchTimingLoaded) { switchTimingLoaded = true; switchTiming.setEnabled(on); }
  if (!on) { switchHandle = null; switchInput = null; }
}
app.whenReady().then(syncSwitchTiming);
ipcMain.on('tab:switch-strip', (_e, id, at) => { if (switchTimingOn && switchHandle && switchHandle.id === id && Number.isFinite(at)) switchHandle.h.strip(at); });
async function exportSwitchTimings() {
  if (!switchTimingLoaded || !switchTiming.count()) return { ok: false, reason: 'empty' };
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const options = { title: 'Export tab-switch timings', defaultPath: path.join(app.getPath('documents'), `lumen-tab-switch-timings-${stamp}.json`), filters: [{ name: 'JSON', extensions: ['json'] }] };
  const { canceled, filePath } = await (TEST && global.__switchTimingSaveDialog ? global.__switchTimingSaveDialog(options) : electronDialog.showSaveDialog(win, options));
  if (canceled || !filePath) return { ok: false, reason: 'canceled' };
  await fs.promises.writeFile(filePath, switchTiming.exportJson(), 'utf8');
  return { ok: true, filePath, count: switchTiming.count() };
}
if (TEST) global.__switchTiming = { on: () => switchTimingOn, loaded: () => switchTimingLoaded, sync: syncSwitchTiming, data: () => (switchTimingLoaded ? switchTiming.exportData() : null), exportNow: exportSwitchTimings };

function switchTab(id, { wake = true } = {}) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return false;
  const input = switchInput; // set only by the user's own click or Ctrl+Tab: the agent, the tests and the app's own switches always load the tab at once
  switchInput = null;
  const rapid = Boolean(input) && rapidSwitching();
  const timing = switchTimingOn ? beginSwitchTiming(tab, input, rapid) : null;
  if (input) lastSwitchAt = Date.now();
  if (id !== activeId) {
    linkStatusRt?.hide(win); // (the old page's hovered link)
    tab.fillDue = true;
    const leaving = tabs.find((t) => t.id === activeId);
    if (leaving) leaving.lastActiveAt = Date.now(); // starts its idle clock for tab sleeping (sweepSleep)
    activeTab()?.webContents.stopFindInPage('clearSelection');
    leaving?.endFocusGuard?.(); // a new tab left before it was used no longer holds the cursor in the address bar
  }
  // Shown in the strip only. Waking a sleeping tab reloads it, and a drag that is then cancelled
  // (Escape) has no way to put that page back to sleep. It loads later, if it is still in front.
  if (tab.sleeping && !wake) {
    activeId = id;
    layout();
    sendTabs();
    return true;
  }
  // What waking a tab is: the resume (a frozen page) or the reload (an unloaded one). Started before the view is shown, never awaited.
  const wakeNow = () => {
    const was = tab.sleeping;
    if (tab.sleeping && !tab.frozen && placeholderWanted(tab)) wakeTab(tab, { placeholder: true }); // [tabs] "When you return to an unloaded tab: Show a Reload button"
    else if (tab.sleeping || tab.frozen) wakeTab(tab);
    const mate = splitPartner(tab); // [split view] its partner is shown beside it: awake too
    if (mate && (mate.sleeping || mate.frozen)) wakeTab(mate);
    if (was && timing) timing.reloaded();
  };
  const mateAsleep = () => { const mate = splitPartner(tab); return Boolean(mate && (mate.sleeping || mate.frozen)); };
  const needsWake = tab.sleeping || tab.frozen || mateAsleep();
  const deferWake = needsWake && rapid;
  if (needsWake && !deferWake) wakeNow();
  activeId = id;
  if (rapid) frameLayout(tab, timing); // (a burst: the tab you land on is shown within a frame, the ones passed through are never composited)
  else {
    layout(); // the new tab is shown first: before extensions, dialogs, chat, the strip's state
    if (timing) { timing.shown(); if (tab.view) probeSwitch(tab, timing, true); }
  }
  if (deferWake) {
    // Passing through: nothing is loaded for this tab unless the user stays on it.
    const settle = setTimeout(() => {
      if (activeId !== id || !tabs.includes(tab) || !(tab.sleeping || tab.frozen || mateAsleep())) return;
      wakeNow();
      layout();
      if (timing && tab.view) probeSwitch(tab, timing, true);
      sendTabs();
    }, SWITCH_SETTLE_MS);
    settle.unref?.();
  }
  adoptPreloaded(tab);
  tab.viewedAt = Date.now(); // which tab the user looked at last (the chat page's AI works in it)
  const current = activeTab();
  if (current && !tabByContents(current.webContents)?.isolated) syncExtensions(() => extensions?.selectTab(current.webContents)); // extensions never see research tabs
  dialogs.refresh(); // a dialog waiting for this tab comes up; the one for the tab left waits
  openForApproval(tab); // [sidebar per tab] a tab whose chat waits for an OK shows its sidebar
  if (!aiToolSwitch) { followTabChat(tab); shownPick = ownPickOfOpenChat(); announceModelIfChanged(); } // (the user went to this tab: the pickers show its chat's model; a window's refresh or focus does not change it)
  // [chat per tab] the sidebar shows this tab's chat. Only a run's own tool call (aiToolSwitch: agentOpenTab / agentSwitchTab) moves the run instead; any other switch is the user's, whatever async scope it happens to run in
  if (rapid) sendTabsSoon(); else sendTabs(); // (a burst of switches sends the strip one state per frame)
  schedulePreload(4000); // (the neighbours of the tab now in front, once things are quiet)
  scheduleReadySync(curRec); // (which tabs to keep ready now: after the switch has settled, once per burst)
  return true;
}
// A burst of switches (Ctrl+Tab held, clicks in a row): the view swap waits one frame and goes to the latest tab only, so a tab passed through is
// not shown and hidden again (each a GPU frame). The strip is not held back: it answers at once (sendTabs, above).
const FRAME_MS = 16;
const frameLayouts = new Map(); // window record -> { timer, tab, timing }
function frameLayout(tab, timing) {
  const rec = curRec;
  const p = frameLayouts.get(rec);
  if (p) { p.timing?.superseded(); p.tab = tab; p.timing = timing; return; } // (the timer is already running: it lays out the latest tab)
  const next = { tab, timing, timer: null };
  frameLayouts.set(rec, next);
  next.timer = setTimeout(() => {
    frameLayouts.delete(rec);
    if (!rcAlive(rec)) return;
    withWindow(rec, () => {
      layout();
      if (next.timing) { next.timing.shown(); if (next.tab.view && activeId === next.tab.id) probeSwitch(next.tab, next.timing, true); }
    });
  }, FRAME_MS);
  next.timer.unref?.();
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
// and "close the tabs the AI opened" leaves it alone. It also leaves the folded "AI tabs" group, back among the user's tabs.
function userTookOver(tab) {
  if (tab?.rec?.agent) tab.rec.agent.used = true; // [agent window] the user clicked or typed in the agent's window: it is theirs to keep
  if (!manners.handOver(tab)) return;
  const rec = tab.rec;
  if (rec && winRecs.has(rec) && rcAlive(rec)) withWindow(rec, () => { leaveAiGroup(tab); sendTabs(); });
}
// [ai tabs] Settings → AI tabs → "Group tabs the AI opens" (groupAiTabs, on): every tab the AI opens in a window joins one
// gray "AI tabs" group there, folded when it is made, so a run that opens dozens of tabs adds one label to the strip. The
// tab in front shows even in a folded group (app.js), and the user's own unfolding is kept. The group holds no other tabs
// (one the user takes over leaves it), so when the AI's tabs close it goes too. Runs in the tab's window (tabGroups is that window's).
const aiGroupName = () => t('tabs.aiGroup');
function aiGroup() {
  for (const g of tabGroups.groups.values()) {
    if (g.aiTabs) return g;
    if (g.name === aiGroupName() && !g.userNamed && tabs.some((x) => x.groupId === g.id) && tabs.every((x) => x.groupId !== g.id || manners.isAiTab(x))) { g.aiTabs = true; return g; } // (restored after a restart: the mark itself is not saved)
  }
  return null;
}
function joinAiGroup(tab) {
  if (!manners.isAiTab(tab) || tab.pinned || curRec?.agent || readSettings().groupAiTabs === false) return;
  const group = aiGroup();
  if (group) { if (tab.groupId !== group.id) { if (tab.groupId) tabGroups.remove(tab.id); tabGroups.add(tab.id, group.id); } return; }
  if (tab.groupId) tabGroups.remove(tab.id);
  const made = tabGroups.create(aiGroupName(), [tab.id], { color: 'gray' });
  made.aiTabs = true;
  made.collapsed = true;
}
function leaveAiGroup(tab) {
  const group = tab?.groupId ? tabGroups.groups.get(tab.groupId) : null;
  if (group?.aiTabs) tabGroups.remove(tab.id, { byUser: true });
}

function closeTab(id, { destroyed = false, user = false, ai = false } = {}) {
  const index = tabs.findIndex((t) => t.id === id);
  if (index === -1) return;
  if (chatFullTab === id) chatFullTab = null;
  const mate = tabs[index].split ? splitPartner(tabs[index]) : null; // [split view] the other side of its pair stays, and takes the page area
  if (tabs[index].split) splitLayout.unlink(tabs, id);
  const [tab] = tabs.splice(index, 1);
  chatBind.unbindTab(id); // [chat per tab]
  finishLeaving(tab);
  tabGroups.cleanup();
  // `pendingCloseUrl` (set by requestCloseTab) covers the case where this runs from the 'destroyed'
  // event below: the webContents is already gone by then, so its URL can't be read any more. A
  // sleeping tab has no webContents at all; sleepUrl is its last known URL instead.
  const url = tab.pendingCloseUrl ?? (alive(tab) ? realUrl(tab.view.webContents) : tab.sleepUrl || '');
  { // [tab chips]
    const chipUrl = tab.isolated || isInternal(url) ? '' : url;
    closedChipTabs.delete(id);
    closedChipTabs.set(id, { t: String((alive(tab) ? tab.view.webContents.getTitle() : tab.pendingCloseTitle || tab.sleepTitle) || '').slice(0, 300), u: chipUrl.slice(0, 2000), f: typeof tab.favicon === 'string' && tab.favicon.length <= 2000 ? tab.favicon : '' }); // (f: its icon, kept so a closed chip still shows it)
    if (closedChipTabs.size > 300) closedChipTabs.delete(closedChipTabs.keys().next().value);
    tabChipsRt?.changed();
  }
  const reopenUrl = isInternal(url) ? sessionFiles.savedUrl(url) : url; // (a file in its viewer reopens from the file's own address)
  if (reopenUrl && !tab.isolated) { // a research tab would reopen in the user's session with their cookies: not offered
    closedTabs.push(reopenUrl);
    closedInfo.push(closedTabsKept.snapshot({ pinned: tab.pinned, groupId: tab.groupId, index, history: tab.pendingCloseHistory ?? navSnapshot(tab) }));
    tabTools.noteClosed(reopenUrl, alive(tab) ? tab.view.webContents.getTitle() : tab.sleepTitle); // for tab search
  }
  if (closedTabs.length > 50) { closedTabs.splice(0, closedTabs.length - 50); closedInfo.splice(0, closedInfo.length - 50); } // Reopen Closed Tab goes back 50
  if (!win || win.isDestroyed()) return; // the app is quitting
  if (tab.view) win.contentView.removeChildView(tab.view); // no view to remove if it was sleeping
  if (!destroyed && alive(tab)) tab.view.webContents.close();
  if (tabs.length === 0) {
    // Closing a window's last tab (Ctrl+W, its ✕, the tab menu: `closing`, set by requestCloseTab) closes the
    // window, as in Chrome: hidden at once (no frame of an empty strip over the page), then closed. A page that
    // went away on its own, or a tab closed by code, leaves a fresh tab instead: the window is never lost to that.
    // Nor to "Close them" / Close tabs the AI opened (tab.aiClosing): those close the AI's tabs, not the user's window,
    // even when they were all the window had. (An agent's own window still goes with its last tab.)
    if ((user || tab.closing) && !(tab.aiClosing && !user && !curRec?.agent)) {
      const rec = curRec;
      sendTabs();
      try { rec.win.hide(); } catch {}
      setImmediate(() => { if (rcAlive(rec)) rec.win.close(); });
      return;
    }
    openTab();
    return;
  }
  if (activeId === id) {
    const working = !user && (ai || tab.aiClosing) ? aiWorkingTabAfterClose(tab) : null; // [ai close focus] the AI closed the tab in front: to a tab it is still working in first, then the normal rule
    switchTab(working && tabs.includes(working) ? working.id : mate && tabs.includes(mate) && !mate.closing ? mate.id : tabs[Math.min(index, tabs.length - 1)].id);
  }
  else { if (mate) layout(); sendTabs(); }
  chatTabGone(id, tab.rec); // [chat per tab] a chat still working there goes on in a background tab
}

// [ai close focus] The tab an AI run is still working in, to show when the AI closes the tab in front: the closing chat's own run first,
// then the working tab looked at last (features/ai-manners.js focusAfterAiClose). null: none, the normal rule picks.
function aiWorkingTabAfterClose(tab) {
  const working = agent.runTabIds();
  if (!working.length) return null;
  let preferId = null;
  const scope = agent.currentScope();
  if (scope?.chat) preferId = agent.runTabIdFor(scope.chat);
  if (preferId == null) {
    const cid = tab.openedBy?.chatId ?? chatBind.chatOf(tab.id);
    const run = cid != null ? chatRuns.get(cid) : null;
    if (run && !run.deleted && !run.queued) preferId = agent.runTabIdFor(run.messages);
  }
  return manners.focusAfterAiClose({ tabs, closing: tab, workingIds: working, preferId });
}

// The interactive "close this tab" entry points (the tab strip's ✕, Ctrl/Cmd+W, the tab menu) go
// through here instead of calling closeTab directly, so a page with a beforeunload handler gets to
// ask "Leave site?" (will-prevent-unload, wired in openTab) before the tab actually goes away. If
// the page doesn't object — true for the vast majority of tabs — this closes right away: Electron
// only fires will-prevent-unload when the page's own handler tries to block the close.
// closeTab({ destroyed: true }), already wired to every tab's 'destroyed' event, finishes the job.
function requestCloseTab(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!alive(tab)) { closeTab(id, { user: !tab?.aiClosing }); return; } // (a sleeping tab closed for the AI is not the user closing their window's last tab)
  tab.pendingCloseUrl = realUrl(tab.view.webContents) || '';
  tab.pendingCloseTitle = tab.view.webContents.getTitle() || ''; // [tab chips] (the page is gone by the time closeTab runs)
  tab.pendingCloseHistory = navSnapshot(tab); // (the page is gone by the time closeTab runs)
  tab.closing = true;
  // The page answers the beforeunload check before the close finishes, which can take a moment:
  // the strip drops the tab now, and the next tab is shown now if this one was in front.
  if (tab.id === activeId && !tab.aiClosing) { // ([ai manners] a tab being closed for the AI stays in front until it is really gone: its page may keep it)
    const index = tabs.indexOf(tab);
    const mate = splitPartner(tab); // [split view] closing one side leaves the other
    const next = mate || [...tabs.slice(index + 1), ...tabs.slice(0, index).reverse()].find((t) => !t.closing);
    if (next) switchTab(next.id);
  } else if (tab.split) layout(); // ([split view] the other side is shown alone at once)
  sendTabs();
  tab.view.webContents.close({ waitForBeforeUnload: true });
  // A frozen page never answers the beforeunload check, so the close never finished. If the tab is
  // still here after a moment and isn't asking "Leave site?", close it without waiting.
  setTimeout(() => {
    if (tabs.includes(tab) && tab.closing && !tab.unloadAsked) closeTab(id);
  }, CLOSE_TIMEOUT_MS);
}
const CLOSE_TIMEOUT_MS = 3000;
// [ai manners] The AI's close_tab: a page that asks "Leave site?" is not asked about (the question would bring the tab to the front
// over what the user is doing): the tab simply stays open and the tool tells the AI the page blocked it.
function agentRequestCloseTab(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!alive(tab)) { requestCloseTab(id); return; }
  tab.aiClosing = true;
  requestCloseTab(id);
  const done = setTimeout(() => { tab.aiClosing = false; }, CLOSE_TIMEOUT_MS + 1500);
  done.unref?.();
}

// ---------- [split view] two tabs side by side ----------
// A pair is one object shared by two tabs (tab.split = { left, right, ratio }, browser/split-layout.js). While the tab in front is in a pair whose
// other tab is awake and the page area is wide enough, layout() shows both, each in its own rectangle with a gap between them for the divider
// (drawn by the UI, renderer/split.js). The side last clicked is the tab in front: the toolbar, the sidebar's chat and the shortcuts follow it.
// A pair that cannot be shown (the other tab asleep, in full screen, a narrow window) keeps its tabs paired and shows the one in front alone.
// Not saved with the session: a restart brings the tabs back unpaired.
const SPLIT_MIN_TABS = 2;
// The user clicked in the other side of the pair on show: it becomes the tab in front.
function activateSplitSide(tab) {
  withWindow(tab.rec, () => {
    if (tab.id === activeId || splitView()?.partner !== tab) return;
    switchTab(tab.id);
  });
}
// Pairs `id` with `withId` (default: the tab in front), `id` on the right, and brings it to the front. When `id` is the tab in front itself,
// a new tab opens on its right. Returns the pair, or null when it cannot be made.
function openSplit(id, { withId = null } = {}) {
  if (tabs.filter((t) => !t.closing).length < 1) return null;
  let right = tabs.find((t) => t.id === id && !t.closing);
  let left = tabs.find((t) => t.id === (withId ?? activeId) && !t.closing);
  if (!right || !left) return null;
  let fresh = false;
  if (left === right) {
    const { id: newId } = openTab(newTabUrl(), { background: true });
    right = tabs.find((t) => t.id === newId);
    if (!right) return null;
    fresh = true;
  }
  const a = tabs.indexOf(left), b = tabs.indexOf(right);
  if (b !== a + 1 && Boolean(left.pinned) === Boolean(right.pinned) && (left.groupId || null) === (right.groupId || null)) moveTab(right.id, b > a ? a + 1 : a); // joined in the strip
  const pair = splitLayout.link(tabs, left.id, right.id, 0.5);
  if (!pair) return null;
  switchTab(right.id);
  layout();
  sendTabs();
  if (!fresh && alive(right)) { try { right.view.webContents.focus(); } catch { /* gone */ } }
  return pair;
}
// Takes the pair of tab `id` apart; both tabs stay open, the one in front now fills the page area.
function closeSplit(id) {
  if (splitLayout.unlink(tabs, id) === null) return false;
  layout();
  sendTabs();
  return true;
}
// The divider dragged: the UI sends the left side's share of the page area (0..1).
ipcMain.on('split:ratio', (_e, ratio) => {
  const front = tabs.find((t) => t.id === activeId);
  if (!front?.split || !Number.isFinite(ratio)) return;
  front.split.ratio = splitLayout.clampRatio(ratio, contentBounds.width);
  layout();
});
ipcMain.on('split:close', () => { if (activeId != null) closeSplit(activeId); });
// A tab dropped on the right edge of the page area (a drag out of the strip, finishCardDrag) opens beside the tab in front.
function dropIntoSplit(src, tabId, cursor, wasFront = null) {
  if (!rcAlive(src)) return false;
  const w = src.win;
  const bounds = withWindow(src, () => ({ ...contentBounds }));
  const origin = w.getContentBounds();
  const point = { x: cursor.x - origin.x, y: cursor.y - origin.y };
  if (!splitLayout.inDropZone(point, bounds)) return false;
  return withWindow(src, () => {
    const dragged = tabs.find((t) => t.id === tabId && !t.closing);
    if (!dragged || tabs.filter((t) => !t.closing).length < SPLIT_MIN_TABS) return false;
    // Beside the tab that was in front when the drag began; when that was the dragged tab itself, beside the one the drag stepped aside to.
    const keep = tabs.find((t) => t.id === wasFront && t !== dragged && !t.closing) || tabs.find((t) => t.id === activeId && t !== dragged && !t.closing) || tabs.find((t) => t !== dragged && !t.closing);
    return Boolean(keep && openSplit(tabId, { withId: keep.id }));
  });
}
function splitMenuItems(tab) {
  const items = [];
  const paired = Boolean(tab.split && splitPartner(tab));
  if (paired) items.push({ label: t('menu.closeSplitView'), click: () => withWindow(tab.rec, () => closeSplit(tab.id)) });
  else if (!tab.closing) items.push({ label: t('menu.openSplitView'), click: () => withWindow(tab.rec, () => openSplit(tab.id)) });
  return items;
}
if (TEST) {
  global.__split = {
    open: (id, withId) => Boolean(openSplit(id, { withId: withId ?? null })),
    close: (id) => closeSplit(id ?? activeId),
    ratio: (r) => { const front = tabs.find((t) => t.id === activeId); if (front?.split) { front.split.ratio = splitLayout.clampRatio(r, contentBounds.width); layout(); } },
    menu: (id) => splitMenuItems(tabs.find((t) => t.id === id)).map((i) => ({ label: i.label })),
    clickMenu: (id) => { splitMenuItems(tabs.find((t) => t.id === id))[0]?.click(); },
    click: (id) => { const tab = tabs.find((t) => t.id === id); if (tab) activateSplitSide(tab); },
    drop: (id, x, y) => { const o = win.getContentBounds(); return dropIntoSplit(curRec, id, { x: o.x + x, y: o.y + y }); },
    state: () => {
      const sp = splitView();
      return {
        activeId, shown: Boolean(sp), pair: tabs.find((t) => t.id === activeId)?.split ? { ...tabs.find((t) => t.id === activeId).split } : null,
        content: { ...contentBounds },
        views: tabs.filter(alive).map((t) => ({ id: t.id, visible: t.view.getVisible(), bounds: t.view.getBounds(), paired: Boolean(t.split) })),
        order: tabs.map((t) => t.id), sent: curRec?.splitKey ?? '',
      };
    },
  };
}

function listTabs() {
  // Sleeping tabs stay listed (from their sleep snapshot) so the agent can still see and switch to
  // them; switch_tab wakes one up like any other tab click would (see switchTab).
  return tabs.filter((t) => alive(t) || t.sleeping).map((t) => ({
    id: t.id,
    title: t.sleeping ? (t.sleepTitle || 'New Tab') : warmPending.has(t.view.webContents) ? '' : t.view.webContents.getTitle(),
    url: t.sleeping ? (t.sleepUrl || '') : (pdfViewer.pdfUrlOf(realUrl(t.view.webContents)) || realUrl(t.view.webContents)), // (a PDF in Lumen's viewer: the PDF's own address)
    active: t.id === activeId,
    group: t.groupId ? tabGroups.groups.get(t.groupId)?.name || null : null,
    ...(t.split && splitPartner(t) ? { splitWith: splitPartner(t).id } : {}), // [split view] shown beside that tab
  }));
}

// Omnibox input: URLs load directly, everything else becomes a search (search.js).
function resolveInput(text) {
  return resolveAddressInput(text, readSettings().searchEngine);
}

function zoomBy(wc, step) {
  if (!wc) return;
  // Lumen's PDF viewer: its own zoom (features/pdf-viewer.js); the page around it keeps its size.
  if (pdfViewer.isViewerUrl(wc.getURL())) { pdfRt.command(wc, step > 0 ? 'zoomIn' : step < 0 ? 'zoomOut' : 'zoomReset'); return; }
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
    const level = zoomSteps.nextLevel(wc.getZoomLevel(), step); // Chrome's stops, 25% to 500% (features/zoom-steps.js)
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
  let model = 'claude-haiku-5-5';
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
// A plain one-line confirmation in the strip's toast ("Link copied"): no Undo.
const toast = (text) => organizeNote(text, { ttl: 2600 });
let fullScreenHinted = false; // (the "Press F11 to exit full screen" toast shows once per run)
// A shortcut shown beside a menu item without being registered a second time (handleShortcut owns the keys).
const shortcutHint = (accelerator) => ({ accelerator, registerAccelerator: false });
function organizeNote(text, { undo = false, merge = false, ttl = windowMerge.NOTE_MS } = {}) {
  if (undo && !merge) mergeUndo = null;
  ui()?.send('tabs:organize-note', { text, undo, ttl, ...(merge && undo ? { undoLabel: t('merge.undo'), undoTitle: t('merge.undoTitle') } : {}) });
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
    if (tabGroups.candidates().length < 2) throw tooFewMessage();
    // How long the model gets depends on the route: a CLI engine needs seconds just to start (organize-ai TIMEOUT_CLI_MS).
    // The model is asked only when "Use AI to name and group topics" is on and a route to one exists (a key, or a signed-in CLI); the
    // route is worked out once per click. Otherwise this stays on this computer: nothing is sent and there is nothing to complain about.
    const aiOn = readSettings().topicAi === true || (TEST && global.__organizeAlwaysAsk === true);
    // Worked out AFTER the local groups are on screen (organizeProgressive's `prepare`): a CLI engine's sign-in check and the wait for a
    // stopped CLI to be gone used to hold up the first change by a second or more.
    const prepare = aiOn ? async () => {
      await cliJson.whenIdle(); // a CLI still being stopped after a cancel must be gone before the next run starts one
      const route = await groupingRoute(String(cheapTopicModel())).catch(() => null);
      return { ask: organizeAi.askIfEnabled({ enabled: true, route, ask: (wire, { signal, timeoutMs: ms } = {}) => withFallback(cheapTopicModel(), (m, first) => refineGroups(m, wire, signal, ms, first ? route : null), { signal }) }), timeoutMs: organizeAi.timeoutFor(route) };
    } : null;
    const stats = await organizeAi.organizeProgressive({
      tabGroups: inWin(tabGroups), // the model's answer arrives later: it must land in THIS window's tabs, not whichever is current by then
      cache: TEST && global.__organizeAlwaysAsk === true ? organizeAi.createRefineCache() : refineCache, // a test asks fresh every time
      signal: organizeAbort.signal,
      skipId: aiOffTab, // [ai controls] those tabs' titles aren't sent
      alwaysAsk: TEST && global.__organizeAlwaysAsk === true,
      maxTabs: MAX_ORGANIZE_TABS * 4,
      prepare,
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
  let chosen = agent.messages.settings?.model || readSettings().model || DEFAULT_MODEL;
  if (autoModel.isAuto(chosen)) chosen = agent.messages.settings?.autoFrom ? agent.messages.settings.model : (autoConcrete(chosen, 'classification') || DEFAULT_MODEL); // [auto model] the cheapest fit
  // Codex answers chats only (its runs need Lumen's MCP session and take turns): a one-shot job goes to another connected model.
  if (/^codex:/.test(chosen)) chosen = modelOptions().find((o) => !/^codex:/.test(o.id) && !o.id.endsWith(':__more') && o.signedIn !== false && !autoModel.isAuto(o.id))?.id || DEFAULT_MODEL;
  if (LOCAL_ENGINE.test(chosen)) return chosen; // proposeGroupsLocal picks the fast model itself
  const { provider } = providers.splitModel(chosen);
  if (provider === 'anthropic') return 'claude-haiku-5-5';
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
const organizeByTopic = organizeTabs; // the name the test hook (__organizeByTopic) and scripts/measure/capture-media.js call
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
// The command bar (Ctrl+K, renderer/command-bar.js): one box for tabs, history, bookmarks, Settings sections and commands, and Ask AI.
function openCommandBar() {
  ui()?.focus();
  ui()?.send('cmdbar:open');
}
// [files] The quick file picker (renderer/files-picker.js): pinned and recent files, and what is in pinned folders.
function openFilesPicker() {
  ui()?.focus();
  ui()?.send('files:picker');
}
function reopenClosed(index, url) {
  if (!Number.isInteger(index) || closedTabs[index] !== url) return false; // the list changed meanwhile
  closedTabs.splice(index, 1);
  reopenClosedTab(url, closedInfo.splice(index, 1)[0]);
  return true;
}
// ---- [/tab audio + tab search]

// The tab strip's right-click menu, in Chrome's order. Close Other Tabs / Close Tabs to the Right
// leave pinned tabs alone, as Chrome does.
// [files] "Pin to Files" on a tab that shows a local file (a PDF, deck, email or file: page): its path goes on the new-tab page's Files widget.
function pinToFilesItem(url) {
  const address = fileTabs.addressOf(url);
  if (!address.startsWith('file:')) return [];
  let file;
  try { file = require('url').fileURLToPath(address); } catch { return []; }
  return [{ label: t('menu.pinToFiles'), click: () => { filesApi().pinPath(file).then((e) => { if (e) toast(t('files.pinned', { name: e.name })); }).catch(() => {}); } }];
}
// Menu rows in sections: a separator between sections, none at the ends or doubled, and empty sections vanish.
// Every row of a menu template, submenus opened (each row followed by its children, tagged with its depth): for the tests, which look items up by label wherever they sit.
const flatMenu = (items, depth = 0) => (items || []).flatMap((i) => [{ item: i, depth }, ...flatMenu(i.submenu, depth + 1)]);
const sections = (...groups) => groups.map((g) => g.filter(Boolean)).filter((g) => g.length).flatMap((g, i) => (i ? [{ type: 'separator' }, ...g] : g));
function tabMenuTemplate(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return null;
  const url = tabUrl(tab);
  const closable = (t) => t.id !== id && !t.pinned && !t.closing;
  const toRight = () => tabs.slice(tabs.indexOf(tab) + 1).filter(closable);
  const marked = isWebUrl(url) && bookmarks().some((b) => b.url === url);
  const groupAdd = [];
  const groupTools = [];
  if (!tab.pinned) {
    const others = tabGroups.state().filter((g) => g.id !== tab.groupId);
    groupAdd.push({
      label: t('menu.addToNewGroup'),
      click: () => {
        manners.handOver(tab); // [ai manners] a tab the user groups is theirs
        if (tab.groupId) tabGroups.remove(id, { byUser: true });
        // A sleeping tab has no webContents to read; its sleep snapshot has the same info.
        const title = alive(tab) ? tab.view.webContents.getTitle() : tab.sleepTitle || '';
        const group = tabGroups.create(isWebUrl(url) ? siteName(url, title) : fileTabs.nameFor(url, title) || 'New Group', [id]);
        sendTabs();
        ui()?.send('group:rename-start', group.id);
      },
    });
    // The other groups sit right in the submenu (one click each), not a second submenu inside it.
    for (const g of others) groupAdd.push({ label: menuLabel(g.name, 80), click: () => { manners.handOver(tab); const e = tabGroups.entryFor(id); if (e) organizeLearner.learnPlacement(e, g.name); tabGroups.add(id, g.id); sendTabs(); } });
    if (tab.groupId) groupAdd.push({ type: 'separator' }, { label: t('menu.removeFromGroup'), click: () => { manners.handOver(tab); tabGroups.remove(id, { byUser: true }); sendTabs(); } });
    groupTools.push({ label: t('menu.organizeByTopic'), click: organizeFromMenu });
    const dupCount = duplicateTabs().reduce((n, d) => n + d.close.length, 0);
    if (dupCount) groupTools.push({ label: t('menu.closeDuplicates', { n: dupCount }), click: closeDuplicateTabs });
    if (tabGroups.state().length > 1) groupTools.push({ label: t('menu.mergeGroups'), click: mergeGroups });
    if (tabGroups.canUndo()) groupTools.push({ label: t('menu.undoOrganize'), click: undoOrganize });
  }
  const [muteTab, ...muteSite] = audioMenuItems(tab); // Mute site stays on top level (Chrome's); Mute tab goes under More
  const aiItems = [...offTabMenu(tab), ...aiSiteMenu(tab).filter((i) => i.type !== 'separator'), { label: t('menu.closeAiTabs'), enabled: aiTabSelect({ rec: curRec }).length > 0, click: () => { const rec = curRec; aiClosingNote(rec); aiTabsClose({ rec }).then((r) => aiCloseNote(rec, r)).catch(() => {}); } }]; // [ai manners]
  const moveItems = moveWindowItems(id);
  // About a dozen rows: what is used most stays on top, the rest is grouped under Add to group / Move tab / AI / More. Nothing was dropped.
  const items = sections(
    [
      { label: t('menu.newTabRight'), click: () => newTabRightOf(id) },
      { label: t('menu.reload'), ...shortcutHint('CmdOrCtrl+R'), click: () => reloadTab(tab, { always: true }) },
      { label: t('menu.duplicate'), enabled: !tab.settings, click: () => duplicateTab(id) }, // [settings] one settings tab
      tab.pinned ? { label: t('menu.unpinTab'), click: () => pinTab(id, false) } : { label: t('menu.pinTab'), click: () => pinTab(id, true) },
      ...muteSite,
    ],
    [
      ...(groupAdd.length ? [{ label: t('menu.addToGroup'), submenu: sections(groupAdd, groupTools) }] : []),
      ...(moveItems.length ? [{ label: t('menu.moveTab'), submenu: moveItems }] : []),
      ...(aiItems.length ? [{ label: t('menu.tabAi'), submenu: aiItems }] : []),
      {
        label: t('menu.tabMore'),
        submenu: sections(
          [muteTab],
          tab.settings ? [] : sleepMenuItems(tab),
          splitMenuItems(tab), // [split view]
          [
            { label: t('menu.copyLink'), enabled: isWebUrl(url), click: () => { clipboard.writeText(url); toast(t('menu.linkCopied')); } },
            ...pinToFilesItem(url), // [files] a file tab: Pin to Files
            { label: marked ? t('menu.removeBookmark') : t('menu.bookmarkTab'), ...shortcutHint('CmdOrCtrl+D'), enabled: isWebUrl(url), click: () => toggleBookmarkFor(tab) },
            { label: t('menu.bookmarkAllTabs'), ...shortcutHint('CmdOrCtrl+Shift+D'), enabled: tabs.some((x) => isWebUrl(tabUrl(x))), click: bookmarkAllTabs },
            { label: t('menu.saveForLater'), ...shortcutHint('CmdOrCtrl+Shift+Y'), enabled: isWebUrl(url) && !tab.isolated, click: () => saveForLater(tab) },
            ...projectMenuItems(tab), // [project workspace] Add to project
          ],
        ),
      },
    ],
    [
      { label: t('menu.closeTab'), ...shortcutHint('CmdOrCtrl+W'), click: () => requestCloseTab(id) },
      { label: t('menu.closeOtherTabs'), enabled: tabs.some(closable), click: () => closeTabs(id, tabs.filter(closable)) },
      { label: t('menu.closeTabsRight'), enabled: toRight().length > 0, click: () => closeTabs(id, toRight()) },
    ],
    [{ label: t('menu.reopenTab'), ...shortcutHint('CmdOrCtrl+Shift+T'), enabled: closedTabs.length > 0, click: reopenLastClosed }],
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
  items.push(...mergeWindowItems(src, { hideDisabled: true }));
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

// Ctrl+Shift+T brings back whichever was closed last, a tab or a whole window (as Chrome does): a window closed while others stayed open,
// with its tabs, their order, groups, pins and the file tabs among them. `after` is how many closed tabs there were when it closed.
const closedWindows = [];
function reopenLastClosed() {
  const last = closedWindows[closedWindows.length - 1];
  if (last && closedTabs.length <= last.after) { closedWindows.pop(); createWindow({ restore: last.entry }); return; }
  if (closedTabs.length) reopenClosedTab(closedTabs.pop(), closedInfo.pop());
}

// A tab's back/forward list as { entries, index }, or null (a sleeping tab keeps its own; a page that is gone has none).
function navSnapshot(tab) {
  if (!alive(tab)) return tab?.sleepHistory || null;
  try {
    const nav = tab.view.webContents.navigationHistory;
    return { entries: nav.getAllEntries(), index: nav.getActiveIndex() };
  } catch {
    return null;
  }
}

// Reopen Closed Tab: the page with its back/forward list, pinned if it was, in its group when that still exists,
// and where it was in the strip (features/closed-tabs.js).
function reopenClosedTab(url, info) {
  const plan = closedTabsKept.placement(info, { count: tabs.length, pinned: tabs.filter((t) => t.pinned).length, hasGroup: (gid) => tabGroups.groups.has(gid) });
  const { id } = openTab(url, { ...(info?.history ? { history: info.history } : {}), ...(plan.groupId ? { groupId: plan.groupId } : {}) });
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  if (plan.pinned) tab.pinned = true;
  tab.userRemoved = true; // put back by hand: automatic grouping leaves it alone
  const list = tabs.filter((t) => t !== tab);
  list.splice(Math.min(plan.at, list.length), 0, tab);
  tabs = list;
  keepPinnedFirst();
  tabGroups.arrange();
  sendTabs();
  return tab;
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
  const history = navSnapshot(tab); // (null loads the URL instead)
  const url = tabUrl(tab) || newTabUrl();
  const { id: newId } = openTab(url, { background: true, history, historyPage: url.startsWith(HISTORY_URL), managerPage: tab.managerPage || null, partition: tab.isolated });
  const copy = tabs.find((t) => t.id === newId);
  copy.pinned = Boolean(tab.pinned);
  manners.keepOff(copy, manners.isKeptOff(tab)); // [ai off-tab] a copy of a tab kept off is kept off too
  placeAfter(copy, tab);
  switchTab(newId);
  return newId;
}

// A tab's Reload (and Cmd+Shift+R for the one in front, bypassing the cache). A sleeping tab is
// woken, which loads it.
// `always`: F5 / Ctrl+R and the tab menu reload even while the page is loading (the toolbar button is Stop then; reload-action.js).
function reloadTab(tab, { ignoreCache = false, always = false } = {}) {
  if (!tab) return;
  if (isAsleep(tab)) { wakeTab(tab); layout(); sendTabs(); return; }
  if (!alive(tab)) return;
  const wc = tab.view.webContents;
  const action = reloadAction({ loading: wc.isLoading(), ignoreCache, errorPage: isErrorPage(wc.getURL()), always });
  if (action === 'stop') wc.stop();
  else if (action === 'reload-failed') wc.loadURL(realUrl(wc)).catch(() => {});
  else if (action === 'reload-hard') wc.reloadIgnoringCache();
  else wc.reload();
}

// [ai controls] "Turn off AI on <site>" for a web tab (features/ai-sites.js).
// [ai off-tab] "Keep the AI from acting on this tab" / "Let the AI act on this tab" (the same switch as the address bar's button).
function setKeepOff(tab, on) {
  if (!tab || tab.settings || manners.isKeptOff(tab) === on) return;
  manners.keepOff(tab, on);
  sendTabs(); // (also schedules the session save)
}
const offTabMenu = (tab) => (tab.settings ? [] : [{ label: manners.isKeptOff(tab) ? t('menu.allowAiTab') : t('menu.keepAiOffTab'), click: () => setKeepOff(tab, !manners.isKeptOff(tab)) }]);

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
    { type: 'separator' },
    { label: t('menu.closeGroup'), click: () => tabGroups.members(groupId).map((t) => t.id).forEach((id) => requestCloseTab(id)) }, // (each tab through requestCloseTab, as every other close item: a page's "Leave site?" still runs)
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
ipcMain.handle('settings:default-browser', (_e, o) => setup.isDefault(o?.cached ? { maxAgeMs: 60000 } : {})); // (cached: Settings opening shows the last answer at once)
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
  // One History tab, like Bookmarks and Downloads: Ctrl+H again goes back to it (reloaded, so it lists what you visited since).
  const existing = tabs.find((t) => alive(t) && t.view.webContents.getURL().startsWith(HISTORY_URL));
  if (existing) { switchTab(existing.id); existing.view.webContents.reload(); return; }
  openTab(HISTORY_URL, { historyPage: true });
}
const fromHistoryPage = (event) => event.senderFrame === event.sender.mainFrame && event.sender.getURL().startsWith(HISTORY_URL);
ipcMain.handle('history:list', async (event) => {
  if (!fromHistoryPage(event)) return [];
  await historyReady;
  return [...history.values()].sort((a, b) => b.last - a.last).slice(0, 5000).map(({ url, title, last }) => ({ url, title, last }));
});
ipcMain.handle('history:manage', (event) => { if (fromHistoryPage(event)) openSettingsPage('privacy'); });
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
    ...recent.map((h) => ({ label: menuLabel(h.title || bareUrl(h.url)), click: () => openTab(h.url) })),
    { type: 'separator' },
    {
      label: t('menu.clearHistory'),
      click: async () => {
        const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: [t('dialog.cancel'), t('history.clear.button')], defaultId: 1, cancelId: 0, message: t('history.clear'), detail: t('history.clear.detail') });
        if (response !== 1) return;
        await historyReady;
        history.clear();
        historyGen++; // (a write in flight must not bring the cleared list back)
        clearTimeout(historySaveTimer);
        historyDirty = false;
        for (const f of [HISTORY_FILE(), `${HISTORY_FILE()}.bak`]) fs.rm(f, { force: true }, () => {}); // (the .bak too, or the next start would restore it)
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

// A cached favicon (a data: URL) as a file the new-tab page loads (its CSP allows file: images); written in the background and pruned when idle (browser/favicon-store.js).
const faviconFiles = require('./browser/favicon-store').createFaviconFiles({ dir: path.join(app.getPath('userData'), 'favicon-cache') });
const FAVICON_FILE_URL = /^file:\/\/\/.+\/favicon-cache\/[0-9a-f]{20}\.[a-z0-9]+$/i;
const faviconFile = (dataUrl) => faviconFiles.fileFor(dataUrl);
setTimeout(() => faviconFiles.prune().catch(() => {}), 90 * 1000).unref?.(); // once the start-up work is over
function newTabUrl() {
  const withIcon = (b) => { const icon = faviconFile(faviconStore.get(hostOf(b.url))); return icon ? { ...b, icon } : b; };
  const data = {
    favorites: bookmarks().filter((b) => !b.folder).slice(0, 12).map(withIcon),
    frequent: frequentSites(12).map(withIcon), // (12: the page drops the ones the user removed, then shows 6)
    hidden: settingsPage.cleanHiddenTiles(readSettings().newTabHiddenTiles) || { favorites: [], frequent: [] }, // [newtab tiles]
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
const ASSISTANT_NAMES = { anthropic: 'Claude', openai: 'ChatGPT', xai: 'Grok', gemini: 'Gemini', openrouter: 'OpenRouter', local: 'Local AI' };
function homeAssistant() {
  const options = modelOptions();
  if (!options.length) return { name: 'AI', agentUsable: false, model: null }; // nothing connected: no provider to privilege
  const modelId = shownModel(options, { forChat: false }).model; // what the sidebar's picker shows right now (a stand-in during a usage limit included)
  const label = autoModel.isAuto(modelId) ? 'Auto' : options.find((o) => o.id === modelId)?.name || String(modelId);
  const named = (name) => ({ name, agentUsable: true, model: modelId, label });
  if (autoModel.scopeOf(modelId) === null) return named('AI'); // [auto model] the model is chosen per message
  // (a provider's own Auto answers as that provider: 'grokbuild:auto' -> Grok)
  if (String(modelId).startsWith('claudecode:')) return named('Claude');
  if (String(modelId).startsWith('grokbuild:')) return named('Grok');
  if (String(modelId).startsWith('antigravity:')) return named('Antigravity');
  if (String(modelId).startsWith('codex:')) return named('Codex');
  const { provider } = providers.splitModel(modelId);
  return named(ASSISTANT_NAMES[provider] || 'AI');
}

// The new-tab page asks by loading itself with ?ask=<prompt>: cancel that and hand the prompt to the
// sidebar, along with the tab id so the UI can put that tab's chat in full-page mode.
function askFromHome(event, url, tabId) {
  if (!isNewTab(url)) return false;
  let text;
  let params;
  try { params = new URL(url).searchParams; text = params.get('ask'); } catch { return false; }
  if (text === null && params.has('connect-ai')) { event.preventDefault(); openSettingsPage('ai-keys'); return true; } // Ask AI with nothing connected: its setup prompt
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
  if (action.do === 'reconnect') { widgets.spotifyReconnect(action.id, spotifySignIn).catch((err) => console.error('[lumen] spotify reconnect:', err.message)); return true; } // (the Spotify card's Reconnect / Connect button: the sign-in starts here, in Spotify's own tab)
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
  // Only sites the new-tab page shows (favorites and frequently visited ones) and the sites on the reading list.
  if (!bookmarks().some((b) => hostOf(b.url) === host) && !frequentSites(12).some((s) => hostOf(s.url) === host) && !readingListStore?.list().some((e) => hostOf(e.url) === host)) return;
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
  toast(t(index >= 0 ? 'bookmark.removedNote' : 'bookmark.addedNote')); // the star shows it for the tab in front; a background tab (tab menu) and Ctrl+D showed nothing else
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

// ---------- Reading list: Save for later (features/reading-list.js; the page is lumen://readinglist) ----------
// The list is read from <userData>/reading-list.json the first time a page is saved or the list is opened, so a profile that never uses it pays nothing.
let readingListStore = null;
function readingList() {
  if (!readingListStore) {
    readingListStore = require('./features/reading-list').create({ file: path.join(app.getPath('userData'), 'reading-list.json') });
    readingListStore.onChange(() => managers.pushReadingList()); // an open Reading list page redraws
  }
  return readingListStore;
}
app.on('before-quit', () => { try { readingListStore?.flushSync(); } catch { /* nothing pending */ } });
const readingIcon = (host) => (host ? faviconStore.get(host) || '' : ''); // a data: URL (the page's CSP allows only those), kept for hosts the new-tab page or the list shows
function saveForLaterUrl(url, title, icons) {
  const r = isWebUrl(url) ? readingList().add({ url, title }) : { ok: false };
  toast(t(!r.ok ? 'readingList.cantSave' : r.added ? 'readingList.saved' : 'readingList.savedAgain'));
  if (r.ok && icons?.length) cacheFavicon(url, icons); // (the list shows a site's icon the way the new-tab page does)
  return r.ok;
}
// Ctrl+Shift+Y, the tab menu, the Bookmarks menu: the page in that tab. (A research tab's own session is not the user's browsing.)
function saveForLater(tab) {
  if (!tab || tab.isolated) { toast(t('readingList.cantSave')); return false; }
  return saveForLaterUrl(tabUrl(tab), tabTitle(tab), tab.favicons);
}

function bookmarksMenu() {
  const list = bookmarks();
  const wc = activeTab()?.webContents;
  const current = wc ? realUrl(wc) : '';
  const marked = list.some((b) => b.url === current);
  return [
    { label: marked ? t('menu.removeBookmark') : t('menu.bookmarkPage'), accelerator: 'CmdOrCtrl+D', enabled: isWebUrl(current), click: toggleBookmark },
    { label: t('menu.bookmarkAllTabs'), accelerator: 'CmdOrCtrl+Shift+D', enabled: tabs.some((x) => isWebUrl(tabUrl(x))), click: bookmarkAllTabs },
    { label: t('menu.showAllBookmarks'), accelerator: 'CmdOrCtrl+Shift+O', click: () => managers.open('bookmarks') },
    { label: t('menu.saveForLater'), accelerator: 'CmdOrCtrl+Shift+Y', enabled: isWebUrl(current), click: () => saveForLater(tabs.find((x) => x.id === activeId)) },
    { label: t('menu.showReadingList'), click: () => managers.open('readinglist') },
    { type: 'separator' },
    ...list.filter((b) => !b.folder).map((b) => ({ label: menuLabel(b.title || b.url), click: () => openTab(b.url) })),
    ...[...new Set(list.filter((b) => b.folder).map((b) => b.folder))].map((folder) => ({
      label: menuLabel(folder, 80),
      submenu: list.filter((b) => b.folder === folder).map((b) => ({ label: menuLabel(b.title || b.url), click: () => openTab(b.url) })),
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
  toast: (text) => toast(text), // "Downloading report.pdf", "Download failed: report.pdf"
  blocked: (contents) => Boolean(contents && agentContents.has(contents)), // [agent window] an agent's page saves nothing to the user's disk and opens no save dialog
  onChange: () => { managers?.pushDownloads(); if (downloads.list.length) warmDownloadsPanelSoon(); }, // (a download exists: the button is showing)
  onOpened: (file) => { filesApi().note(file, { source: 'download' }).catch(() => {}); }, // [files] a download the user opened goes on the Recent list
  onPin: (file) => { filesApi().pinPath(file).then((e) => { if (e) toast(t('files.pinned', { name: e.name })); }).catch(() => {}); }, // [files] "Pin to Files" on a download
  // A local .pptx opened in a tab (typed path, File > Open, drag and drop, a file: link) shows in the slide viewer instead of downloading;
  // a .pptx downloaded from the web is saved as usual, then opens in a new tab beside the one it came from (not after Save Link As).
  openInstead: (item, contents) => {
    const mail = emlViewer.shouldOpenInPlace({ url: item.getURL(), filename: item.getFilename() });
    if (!mail && !slidesViewer.shouldOpenInPlace({ url: item.getURL(), filename: item.getFilename() })) return false;
    const tab = contents && tabByContents(contents);
    if (tab) return mail ? emlRt.openInPlace(contents, item.getURL()) : slidesRt.openInPlace(contents, item.getURL());
    openTab(mail ? emlViewer.viewerUrl(item.getURL()) : slidesViewer.viewerUrl(item.getURL()));
    return true;
  },
  onCompleted: (entry) => {
    const mail = emlViewer.shouldOpenFinished(entry) && !String(entry.url).startsWith('blob:'); // (an attachment saved from the viewer is saved, not opened)
    if (!mail && !slidesViewer.shouldOpenFinished(entry)) return;
    const from = entry.contents && !entry.contents.isDestroyed?.() ? tabByContents(entry.contents) : null;
    if (entry.contents && !from) return; // a private window's, a research tab's or a background download: not opened here
    openTab((mail ? emlViewer : slidesViewer).viewerUrl(pathToFileURL(entry.path).href), { openerId: from?.id ?? null });
  },
  // A click on a finished .eml in the downloads panel (or the downloads menu) opens it in a Lumen tab, not in whatever program the system has for it.
  openLocal: (file) => {
    if (!emlViewer.shouldOpenFinished({ path: file })) return false;
    openTab(emlViewer.viewerUrl(pathToFileURL(file).href));
    return true;
  },
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
  readingList: () => readingList(),
  readingIcon: (host) => readingIcon(host),
  downloads,
  openFolder: () => shell.openPath(settingsBackend.downloadDir()),
});
managers.setup();
// When each site last stored cookies: lets Clear browsing data honour a time range for them.
const siteActivity = createSiteActivity({ userData: app.getPath('userData') });
if (TEST) global.__managers = { managers, siteActivity, history: () => history, downloads };
if (TEST) global.__readingList = { store: () => readingList(), menu: (id, label, click) => { const item = flatMenu(tabMenuTemplate(id)).find((r) => r.item.label === label)?.item; if (item && click) item.click(); return item ? { enabled: item.enabled !== false } : null; } }; // test/e2e/reading-list.js

// Electron reports only "Chromium" in UA client hints while the user agent says Chrome; sites
// (Google especially) treat that mismatch as a bot signal. Align both through the DevTools protocol; the
// brand list, headers and window.chrome all come from browser/chrome-identity.js so they agree.
const CHROME_IDENTITY = require('./browser/chrome-identity');
const UA_METADATA = CHROME_IDENTITY.uaMetadata({
  chromeVersion: process.versions.chrome, platform: process.platform, arch: process.arch,
  release: require('os').release(), systemVersion: process.platform === 'darwin' ? process.getSystemVersion() : '',
});
// The same identity for the Sec-CH-UA request headers, which Chrome sends on every request to a
// secure origin. Requests from tabs otherwise go out with none at all (and the browser's own with
// Electron's Chromium-only list): a Chrome user agent without them is what bot checks look for.
const UA_HINT_HEADERS = CHROME_IDENTITY.lowEntropyHeaders(UA_METADATA);
// The languages a Chrome on this machine reports: Settings → Languages if set, else the system's (Electron's own
// default gave navigator.languages ["en-US","en-001"] and an Accept-Language of just "en-US"). One list feeds the
// Accept-Language header (settings-backend.js) and navigator.languages (applyChromeIdentity), so they cannot disagree.
const chromeLanguages = {
  list: () => CHROME_IDENTITY.languageList((settingsCache || readSettings()).languages?.length ? (settingsCache || readSettings()).languages : app.getPreferredSystemLanguages()),
  header: () => CHROME_IDENTITY.acceptLanguageHeader(chromeLanguages.list()),
};
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
    if (failedUrl.startsWith(ERROR_URL)) return; // the error page itself failed: an error page for it would fail the same way, over and over
    const focusBlock = focusCtl?.blockPage(wc, failedUrl, code); // [focus] a site on the focus list
    if (focusBlock) { wc.loadURL(focusBlock).catch(() => {}); return; }
    const unsafe = safeBrowsing.warningUrl(wc, failedUrl, code); // a page Google lists as unsafe
    if (unsafe) { wc.loadURL(unsafe).catch(() => {}); return; }
    if (settingsBackend.onFailLoad(wc, failedUrl)) return; // [settings] HTTPS-only: no secure version
    const certWarning = siteSecurity.warningUrl(failedUrl, code, description);
    if (certWarning) { wc.loadURL(certWarning).catch(() => {}); return; }
    const params = new URLSearchParams({ url: failedUrl, code: String(code), desc: description });
    // A name that doesn't resolve may be a search typed without spaces: the page offers to search for it (error.js).
    if (/^ERR_NAME_(NOT_RESOLVED|RESOLUTION_FAILED)$/.test(String(description).replace(/^net::/, ''))) {
      try { const host = new URL(failedUrl).hostname; if (host) params.set('search', searchUrlFor(readSettings().searchEngine, host)); } catch {}
    }
    wc.loadURL(`${ERROR_URL}?${params}`).catch(() => {});
  });
}
// A popup that fails to load (offline, a certificate problem) says so, as a tab does, instead of staying white.
function popupFailPage(wc) {
  wc.on('did-fail-load', (_e, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 || failedUrl.startsWith(ERROR_URL)) return;
    const certWarning = siteSecurity.warningUrl(failedUrl, code, description);
    wc.loadURL(certWarning || `${ERROR_URL}?${new URLSearchParams({ url: failedUrl, code: String(code), desc: description })}`).catch(() => {});
  });
}
// [ai manners] popup windows an AI tab's page opened (window.open with a size, a sign-in popup): window -> { chatId, runId, touched }.
// They are not tabs, but they are the AI's too: aiTabsClose closes them with the run's tabs, unless the user focused one or typed in it.
const aiPopups = new Map();
const passkeyPopups = new WeakMap(); // a popup's page -> its window, for popups the user's own tabs opened (never the AI's, never a research session's)
function popupWindow(options, noIdentity = false, partition = null, url = null, openerTab = null, behind = false, aiBy = null) {
  behind = behind || manners.isAiTab(openerTab); // [ai manners] a window an AI tab's page opened comes up behind the user's window, never over it
  const child = new BrowserWindow({ ...windowOrder.independent(options), ...popupWindowOptions(), ...(behind ? { show: false } : {}), ...(options?.webContents ? { webContents: options.webContents } : {}), webPreferences: { ...options?.webPreferences, ...popupWindowOptions().webPreferences, ...(partition ? { partition } : {}) } });
  const wc = child.webContents;
  if (behind) showBehind(child);
  const by = aiBy || (manners.isAiTab(openerTab) ? openerTab.openedBy : null);
  if (by) {
    const mark = { chatId: by.chatId ?? null, runId: by.runId ?? null, touched: false };
    aiPopups.set(child, mark);
    const settle = Date.now() + 1500; // (showing it behind may focus it for a moment)
    child.on('focus', () => { if (Date.now() > settle) mark.touched = true; });
    wc.on('before-input-event', (_e, input) => { if (input.type === 'keyDown' && !manners.isAgentInput(wc)) mark.touched = true; });
    child.once('closed', () => aiPopups.delete(child));
  } else if (!partition) passkeyPopups.set(wc, child); // the user's own sign-in popup may use a passkey (passkeyContext)
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
    if (input.type === 'keyDown' && shortcutMod(input) && !input.alt && shortcutKey(input) === 'w') { e.preventDefault(); child.close(); }
  });
  if (!partition) syncExtensions(() => { try { extensions?.addTab(wc, child); } catch {} }); // password managers can fill it
  const popupLimit = createBurstLimit();
  wc.setWindowOpenHandler(({ url, disposition }) => {
    if (!popupLimit.allow()) return { action: 'deny' };
    if (!isWebUrl(url) && url !== 'about:blank') return { action: 'deny' };
    if (disposition === 'new-window') return { action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: popupWindowOptions(), createWindow: (o) => popupWindow(o, noIdentity, partition, url, null, behind, aiPopups.get(child) || null) };
    const byAi = manners.isAiTab(openerTab); // [ai manners] a link from a window an AI tab's page opened is the AI's too: behind the user's tab, and kept out of the strip when hiding is on
    withWindow(curRec, () => openTab(url, { background: disposition === 'background-tab' || byAi, partition, ...(byAi ? { openedBy: { chatId: openerTab.openedBy.chatId, runId: openerTab.openedBy.runId } } : {}) })); // a research tab's popup keeps to its session
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
  aiFrames.track(wc); // before the auto-attach below: every out-of-process frame's session is recorded
  const lang = () => chromeLanguages.list().join(','); // navigator.languages (DevTools takes the plain list, no q-weights); the request header is the same list, q-weighted
  const override = () => ({ userAgent: app.userAgentFallback, userAgentMetadata: UA_METADATA, acceptLanguage: lang() });
  const basic = () => ({ ...override(), userAgentMetadata: (({ wow64, formFactors, ...rest }) => rest)(UA_METADATA) }); // (if this DevTools rejects the newest metadata fields, the brands still apply)
  const send = (method, params, sessionId) => wc.debugger.sendCommand(method, params, sessionId);
  // Workers have no Emulation domain; Network sets the same thing there.
  const identify = (sessionId) => send('Emulation.setUserAgentOverride', override(), sessionId)
    .catch(() => send('Emulation.setUserAgentOverride', basic(), sessionId))
    .catch(() => send('Network.setUserAgentOverride', override(), sessionId))
    .catch(() => send('Network.setUserAgentOverride', basic(), sessionId)).catch(() => {});
  // window.chrome and navigator.webdriver, at document start in every frame (browser/chrome-identity.js); not in workers.
  // (Google's sign-in hosts get the same identity as every other page: Google refuses a Firefox one, google-auth-identity.js.)
  // The Page domain is switched on first: with Chromium's debugging port open (automation, test drivers) a script added
  // to a session that never enabled Page is not run at document start, and window.chrome stayed Electron's empty {}.
  const script = (sessionId) => send('Page.enable', {}, sessionId).catch(() => {}).then(() => Promise.all([
    send('Page.addScriptToEvaluateOnNewDocument', { source: CHROME_IDENTITY.IDENTITY_SCRIPT, runImmediately: true }, sessionId).catch(() => {}),
    activityScripts.add(wc, send, sessionId), // [hide activity] other sites' frames too (features/hide-activity.js)
  ]));
  const autoAttach = (sessionId) => send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch(() => {});
  wc.debugger.on('message', (_e, method, params) => {
    if (method !== 'Target.attachedToTarget') return;
    const { sessionId, targetInfo } = params;
    const frame = targetInfo.type === 'iframe';
    const resume = () => send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    // A worker target (service, shared, dedicated) answers nothing until it runs: its Network/Emulation commands queue behind
    // the pause, so waiting for them before resuming deadlocked it (navigator.serviceWorker.register() never settled).
    // The identity command is sent first and the worker is resumed at once; the worker applies it before it runs a script.
    if (!frame) { identify(sessionId).catch(() => {}); resume(); return; }
    Promise.all([identify(sessionId), script(sessionId), autoAttach(sessionId)]).finally(resume);
  });
  let languages = lang(); // navigator.languages follows the Languages setting: re-applied at the next navigation after it changes
  const follow = (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    const now = lang();
    if (now !== languages) { languages = now; identify(); }
  };
  wc.on('did-start-navigation', follow);
  wc.on('did-redirect-navigation', follow);
  identify();
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
      ...(isolatedOf(wc) ? [] : [{ label: t('menu.saveLinkForLater'), click: () => saveForLaterUrl(p.linkURL, p.linkText) }]),
      { label: t('menu.copyLink'), click: () => { clipboard.writeText(p.linkURL); toast(t('menu.linkCopied')); } },
      { type: 'separator' },
    );
  } else if (/^(mailto|tel):/i.test(p.linkURL || '')) { // an email or phone link: copy just the address or number (no scheme, no ?subject=)
    const mail = /^mailto:/i.test(p.linkURL);
    let value = p.linkURL.replace(/^(mailto|tel):/i, '').split('?')[0];
    try { value = decodeURIComponent(value); } catch {}
    value = value.trim();
    if (value) items.push({ label: t(mail ? 'menu.copyEmail' : 'menu.copyPhone'), click: () => { clipboard.writeText(value); toast(t(mail ? 'menu.emailCopied' : 'menu.phoneCopied')); } }, { type: 'separator' });
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
      { label: t('menu.addToNotes'), click: () => addSelectionToNotes(wc, selection) },
      { label: t('menu.qrSelection'), enabled: selection.length <= 500, click: () => showQrCode(wc, selection, 'text') },
      ...skillMenuItems(selection),
      { type: 'separator' },
    );
  }
  if (items.length === 0) {
    items.push(
      { label: t('menu.back'), ...shortcutHint(process.platform === 'darwin' ? 'Cmd+[' : 'Alt+Left'), enabled: canGoBack(wc), click: () => goBack(wc) },
      { label: t('menu.forward'), ...shortcutHint(process.platform === 'darwin' ? 'Cmd+]' : 'Alt+Right'), enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: t('menu.reload'), ...shortcutHint('CmdOrCtrl+R'), click: () => wc.reload() },
      { type: 'separator' },
    );
    if (isWebUrl(wc.getURL())) {
      items.push(
        { label: t('menu.savePageAs'), ...shortcutHint('CmdOrCtrl+S'), click: () => pageTools.savePage(wc).catch(() => {}) },
        ...(isolatedOf(wc) ? [] : [{ label: t('menu.saveForLater'), ...shortcutHint('CmdOrCtrl+Shift+Y'), click: () => saveForLater(tabByContents(wc)) }]),
        { label: t('menu.print'), ...shortcutHint('CmdOrCtrl+P'), click: () => printTab(wc) },
        { label: t('menu.viewSource'), ...shortcutHint('CmdOrCtrl+U'), click: () => pageTools.viewSource(wc.getURL(), { session: wc.session, openerId: tabByContents(wc)?.id }) },
        { label: t('menu.screenshot'), ...shortcutHint('CmdOrCtrl+Shift+S'), click: () => takeScreenshot(wc) },
        { label: t('menu.qrCode'), click: () => showQrCode(wc) },
        ...(phoneReady() ? [{ label: t('phone.send.menu'), click: () => sendPageToPhone(wc) }] : []), // [phone files]
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
  const key = shortcutKey(input); // (the physical key with Ctrl / Cmd / Alt held, so Ctrl+W works on a Russian or Greek layout too)
  const mod = shortcutMod(input); // macOS: Cmd, never Control (the text-editing key there; browser/shortcut-mod.js)
  const wc = activeTab()?.webContents;
  let handled = true;
  if (macrosFeature.handleKey(input)) { event.preventDefault(); return; } // a macro's own shortcut (Settings → Macros; never one Lumen uses)
  const extra = extraShortcut(input);
  if (extra && runExtraShortcut(extra, wc)) { event.preventDefault(); return; }
  // The full-page chat's own keys (renderer/chat-page.js listens): Ctrl+Shift+S folds or opens the chat list, Ctrl+Shift+O starts a new chat.
  if (mod && input.shift && !input.alt && (key === 's' || key === 'o') && wc && activeTabIsChatPage()) { wc.executeJavaScript(`document.dispatchEvent(new CustomEvent('cp:shortcut', { detail: '${key === 's' ? 'rail' : 'new'}' }))`).catch(() => {}); event.preventDefault(); return; }
  if (mod && input.shift && key === 'n') privateWindows.open();
  else if (mod && input.shift && key === 't') reopenLastClosed();
  else if (mod && input.shift && key === 'a') openTabSearch();
  else if (mod && input.shift && !input.alt && key === 'f') openFilesPicker(); // (before Find: Ctrl+F is Find in page, Ctrl+Shift+F is the file picker)
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
  else if (mod && !input.shift && !input.alt && key === 'k') openCommandBar(); // the command bar (a page that uses Ctrl+K itself keeps it: page-first-keys.js)
  else if (mod && !input.shift && !input.alt && key === 'e') focusAddress(); // Chrome's "search from the address bar"
  else if (mod && key === 'f' && pdfViewer.isViewerUrl(wc?.getURL())) pdfRt.command(wc, 'find'); // the PDF viewer's own find bar searches every page
  else if (mod && key === 'f' && tabs.find((t) => t.id === activeId)?.settings) { wc.focus(); wc.executeJavaScript("{ const s = document.getElementById('search'); s?.focus(); s?.select(); }").catch(() => {}); } // [settings] Ctrl+F searches settings
  else if (mod && key === 'f') openFindBar();
  else if (mod && input.shift && key === 'o') managers.open('bookmarks');
  else if (mod && input.shift && !input.alt && key === 'y') saveForLater(tabs.find((x) => x.id === activeId)); // Save for later (the reading list: lumen://readinglist)
  else if (mod && input.shift && key === 'j' && process.platform !== 'darwin') managers.open('downloads'); // Ctrl+J stays the sidebar
  else if (process.platform === 'darwin' && input.meta && input.alt && key === 'l') managers.open('downloads');
  else if (mod && input.shift && !input.alt && key === 'k') newSidebarChat(); // K sits next to J (the sidebar); Ctrl+Shift+J is Downloads on Windows/Linux
  else if (mod && key === 'j') toggleSidebarFromKeys();
  else if (mod && input.shift && !input.alt && key === 'e') toggleMeetingHelper(); // Ctrl+Shift+E: Meeting helper (Ctrl+Enter is "send now" in the box you type in)
  // macOS: Cmd+Option+Right/Left and Cmd+Shift+] / [ select the next / previous tab, as in Chrome
  else if (process.platform === 'darwin' && input.meta && input.alt && (key === 'arrowright' || key === 'arrowleft')) cycleTab(key === 'arrowright' ? 1 : -1);
  else if (process.platform === 'darwin' && input.meta && input.shift && ['[', ']', '{', '}'].includes(key)) cycleTab(key === ']' || key === '}' ? 1 : -1);
  else if (mod && key === 'r') reloadActive({ ignoreCache: input.shift, always: true }); // Shift: Force Reload, past the cache
  else if (mod && key === 'tab') cycleTab(input.shift ? -1 : 1);
  else if (mod && input.shift && (key === 'pageup' || key === 'pagedown')) { const i = tabs.findIndex((t) => t.id === activeId); if (i !== -1) moveTab(activeId, i + (key === 'pageup' ? -1 : 1)); }
  else if (mod && (key === 'pageup' || key === 'pagedown')) cycleTab(key === 'pageup' ? -1 : 1);
  else if (mod && /^[1-9]$/.test(key)) { const shown = tabs.filter((x) => !aiTabHidden(x)); const t = key === '9' ? shown[shown.length - 1] : shown[Number(key) - 1]; if (t) switchTab(t.id); } // (Ctrl+N counts the tabs the strip shows)
  else if (mod && zoomKeyStep(input) !== null) zoomBy(wc, zoomKeyStep(input)); // Ctrl + = - 0, the numpad's too (features/zoom-steps.js)
  else if (mod && input.shift && key === 'd') bookmarkAllTabs();
  else if (mod && key === 'd') toggleBookmark();
  else if (process.platform === 'darwin' && input.meta && key === 'h') app.hide(); // Cmd+H hides the app on macOS; History is Cmd+Y
  else if (mod && key === 'h') openHistoryPage();
  else if (mod && input.shift && !input.alt && key === 'p') printSystem(wc); // Print using the system dialog, as in Chrome
  else if (mod && key === 'p') printTab(wc);
  else if (mod && input.shift && !input.alt && key === 's') { if (wc) takeScreenshot(wc); }
  else if (mod && key === 's') { if (wc) pageTools.savePage(wc).catch(() => {}); }
  else if (mod && key === 'u') { if (wc) pageTools.viewSource(wc.getURL(), { session: wc.session, openerId: activeId }); }
  else if (mod && key === ',') openSettingsPage(); // [settings]
  else if (process.platform === 'darwin' && input.meta && key === '[') goBack(wc);
  else if (process.platform === 'darwin' && input.meta && key === ']') wc?.navigationHistory.goForward();
  else if (mod && input.shift && !input.alt && key === 'x') managers.open('tasks'); // [mission control] lumen://tasks: everything the AI is doing
  else if (process.platform === 'darwin' && input.meta && key === 'y') openHistoryPage();
  else if (input.alt && key === 'arrowleft') goBack(wc);
  else if (input.alt && !mod && key === 'home' && activeTabIsChatPage()) chatPageRt.home(activeId); // Chrome's Home shortcut, on the full-page chat
  else if (input.alt && key === 'arrowright') wc?.navigationHistory.goForward();
  else if (key === 'f5' && !input.shift && !input.control && slidesViewer.isViewerUrl(wc?.getURL())) slidesRt.present(wc); // F5 presents a deck, as in PowerPoint
  else if (key === 'f5') reloadActive({ ignoreCache: input.shift || input.control, always: true });
  else if (key === 'f11' && process.platform !== 'darwin') win?.setFullScreen(!win.isFullScreen());
  else if (key === 'f12') wc?.toggleDevTools();
  else if (process.platform !== 'darwin' && mod && input.shift && !input.alt && key === 'i') wc?.toggleDevTools(); // Ctrl+Shift+I, as in Chrome (macOS has Cmd+Option+I in the View menu)
  else handled = false;
  if (handled) event.preventDefault();
}

// Ctrl+F / Edit > Find: the find bar opens (focus moves to it now) holding the text selected on the page, as in Chrome
// (features/find-selection.js); with nothing selected it opens as it was, on the last search.
function openFindBar() {
  ui()?.focus();
  findSelection.pageSelection(activeTab()?.webContents).then((text) => ui()?.send('find:open', text ? { text } : undefined));
}

// F6 / Alt+D, F3 / Ctrl+G, Ctrl+F4 (browser/shortcut-mod.js extraShortcut). False: not ours here, the key goes on to the page.
function runExtraShortcut(action, wc) {
  if (action === 'focus-address') { focusAddress(); return true; }
  if (action === 'close-tab') { if (activeId) requestCloseTab(activeId); return true; }
  // Find next / previous: opens the find bar when it is closed. The PDF viewer and Settings have their own find.
  if (pdfViewer.isViewerUrl(wc?.getURL()) || tabs.find((t) => t.id === activeId)?.settings) return false;
  ui()?.focus();
  ui()?.send('find:open', { step: action === 'find-prev' ? -1 : 1 });
  return true;
}

// Ctrl+J / the menu: the sidebar opens or closes. Opening it from a page that has the keyboard moves the keyboard into its message box (the
// UI's document focused its box, but the window's native focus stayed in the page, so typing went to the page); closing leaves it where it was.
function toggleSidebarFromKeys() {
  if (!tabSidebarOpen(tabs.find((t) => t.id === activeId))) ui()?.focus();
  ui()?.send('toggle-sidebar');
}
// Ctrl+Shift+K / the menu: a fresh chat in the sidebar (opens it if closed); the renderer clicks its New chat button.
function newSidebarChat() {
  ui()?.focus();
  ui()?.send('new-sidebar-chat');
}

// Ctrl+Shift+L / the menu: open the chat as a full page, or from the page go back to the sidebar.
const activeTabIsChatPage = () => tabs.find((t) => t.id === activeId)?.managerPage === 'chat';
function toggleChatPage() {
  if (tabs.find((t) => t.id === activeId)?.managerPage === 'chat') chatPageRt.back();
  else chatPageRt.open();
}

// Ctrl+Shift+E: toggle the Meeting Helper panel (opens the sidebar if closed, focuses the prompt).
function toggleMeetingHelper() {
  ui()?.focus();
  ui()?.send('meeting:toggle');
}

function focusAddress() {
  ui()?.focus();
  if (curRec && !curRec.uiLoaded) curRec.focusAddressPending = true; // (sent again once the UI has loaded: createWindow)
  ui()?.send('focus-address');
}

// [ai manners] with "hide tabs the AI opened" on, the tabs it leaves out of the strip are skipped (the one in front, and one playing sound, stay)
const aiTabHidden = (t) => readSettings().hideAiTabs === true && manners.isAiTab(t) && t.id !== activeId && !(alive(t) && t.view.webContents.isCurrentlyAudible?.());
function cycleTab(direction) {
  const list = tabs.filter((t) => !aiTabHidden(t));
  const index = list.findIndex((t) => t.id === activeId);
  if (list.length) { switchInput = { source: 'key', at: switchTimingOn ? performance.timeOrigin + performance.now() : null }; switchTab(list[(index + direction + list.length) % list.length].id); switchInput = null; wakeAfterKeyboard(direction); }
}

function reloadActive({ ignoreCache = false, always = false } = {}) {
  const tab = tabs.find((t) => t.id === activeId);
  userTookOver(tab); // [ai manners] only the user's own reload reaches here (the AI's reload tool calls webContents.reload)
  reloadTab(tab, { ignoreCache, always });
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
  onError: (err) => chatSaveFailed(err),
  onChange: () => { if (syncSvc) syncSvc.touch('chats'); }, // [sync]
}));
// A save that failed (a full disk, a locked file, the keychain): said once per session, in the tab strip's toast, with the reason. The chat stays
// in memory and the next save tries again.
let chatSaveWarned = false;
function chatSaveFailed(err) {
  console.error('Could not save chat:', err?.message);
  if (chatSaveWarned) return;
  chatSaveWarned = true;
  try { toast(`Couldn't save this chat: ${String(err?.code || err?.message || 'unknown error').slice(0, 80)}`); } catch { /* no window to say it in */ }
}
let chatId = null; // the open chat
// [temporary chat] Chats started with "Temporary chat" on the chat page: never written to disk, never listed (they live only in
// memory until the user leaves them). Ids are random, so the set simply stays for the session.
const temporaryChats = new Set();
// [projects] A chat's project (features/chat-store.js) puts its instructions in the chat's system prompt (ai/project-instructions.js).
const pendingProject = new Map(); // chat id -> project id: a new chat started inside a project, recorded when it is first saved
const projectForChat = (id) => { try { const pid = pendingProject.get(id); return pid ? chats().projects().find((p) => p.id === pid) || null : chats().projectOf(id); } catch { return null; } };
// [project workspace] What goes to the AI for a project's chat, in the context block (never the fixed system prompt, which has no room): the
// instructions (4,000 characters at most) and the index of the project's files and pinned pages (2,500 at most: ai/project-context.js);
// the AI reads the rest with the project_files tool.
const projectAllows = (messages, what) => { const d = projectForChat(chatIdOfMessages(messages))?.defaults; return what === 'connectors' ? d?.connectors !== false : what === 'mcp' ? d?.mcp !== false : true; };
const projectBlockFor = (id) => {
  try {
    const project = projectForChat(id);
    if (!project) return '';
    const files = projectFiles().list(project.id);
    const index = files.length || project.links?.length ? require('./ai/project-context').block({ files, links: project.links || [] }) : '';
    return [require('./ai/project-instructions').block(project), index].filter(Boolean).join('\n\n');
  } catch { return ''; }
};
// The chat's project as its settings carry it: the context block, the id (memory saved in the chat belongs to the project), whether the
// project_files tool is offered (the project has files or pinned pages), and the folder the chat works in.
function projectSettingsFor(id) {
  const out = {};
  try {
    const project = projectForChat(id);
    const block = projectBlockFor(id);
    if (block) out.projectInstructions = block;
    if (project) { out.projectId = project.id; if (project.links?.length || projectFiles().list(project.id).length) out.projectTools = true; }
    const work = projectWorkFolderFor(id); // [work folder] the project's folder the chat works in (a folder picked for the chat itself wins, agent.js)
    if (work) out.projectWorkFolder = work;
  } catch { /* no project settings: the chat goes on as any other */ }
  return out;
}
const PROJECT_SETTING_KEYS = ['projectInstructions', 'projectId', 'projectTools', 'projectWorkFolder'];
// The open chat's settings follow its project (a chat opened, moved into a project, or its project edited).
function syncProjectInstructions() {
  const settings = agent.messages.settings;
  if (!settings) return;
  for (const key of PROJECT_SETTING_KEYS) delete settings[key];
  Object.assign(settings, projectSettingsFor(chatId));
}
function keepPendingProject(id) {
  const pid = pendingProject.get(id);
  if (pid && chats().has(id)) { chats().setProject(id, pid); pendingProject.delete(id); }
}
// ---------- [project folders] (features/project-folders.js)
// A project can have a real folder; its chats are mirrored there as Markdown files (plain text, NOT encrypted: the project's settings say
// so), and a folder can be where the AI works (a chat's own pick, else its project's). All file work is async and never on the saving path:
// a change schedules a write ~2 s after the last one, and the writes run one after another with the main thread free between them.
// Loaded on first use (a project's folder, a chat's work folder, a mirror write), not at startup (test/e2e/perf-budget.js counts startup modules).
let projectFoldersMod = null;
const projectFolders = new Proxy({}, { get: (_t, key) => (projectFoldersMod ||= require('./features/project-folders'))[key] });
let documentsOverride = null; // TEST only (global.__projectFolders.setDocuments): the Documents folder of a test is never the user's own
const documentsDir = () => documentsOverride || (TEST ? path.join(app.getPath('userData'), 'test-documents') : app.getPath('documents'));
const projectsParent = () => { const d = String(readSettings().projectsDir || ''); return d && path.isAbsolute(d) ? d : path.join(documentsDir(), 'Lumen Projects'); };
const projectById = (id) => chats().projects().find((p) => p.id === id) || null;
const projectIdOf = (id) => (chats().projectOf(id)?.id) || pendingProject.get(id) || null;
// Where a chat's Markdown file belongs: its project's folder while the project has one and the toggle is on (force: whatever the toggle).
const mirrorFolderOf = (id, force = false) => { if (temporaryChats.has(id)) return ''; const p = chats().projectOf(id); return p?.folder && (force || p.mirror !== false) ? p.folder : ''; };
let mirrorChain = Promise.resolve();
const serial = (fn) => { const run = mirrorChain.then(fn, fn); mirrorChain = run.catch(() => {}); return run; };
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
let chatMirror = null;
const mirror = () => (chatMirror ||= projectFolders.createMirror({
  render: async (id) => { await nextTurn(); const out = chatMarkdown(id); return out ? { id, title: out.title, created: out.created, updated: out.updated, model: out.model, markdown: out.markdown } : null; },
  folderOf: mirrorFolderOf,
  onError: (err) => console.error('Project folder:', err?.message || err),
}));
let mirrorDebounceObj = null; // (made on first use, with the module above)
const mirrorDebounce = new Proxy({}, { get: (_t, key) => { const d = (mirrorDebounceObj ||= projectFolders.createDebouncer((id) => serial(() => mirror().write(id)), 2000)); const v = d[key]; return typeof v === 'function' ? v.bind(d) : v; } });
function mirrorChatSoon(id) { try { if (id && mirrorFolderOf(id)) mirrorDebounce.schedule(id); } catch { /* the chat is saved either way */ } }
// Chats moved between projects ([[chat id, the project it was in]], read before the move): the file leaves the old folder (to Chats/Removed)
// and is written in the new one.
function mirrorAfterMove(before) {
  const work = [];
  for (const [id, from] of before) {
    if ((projectIdOf(id) || null) === (from || null)) continue;
    work.push({ id, from: from ? projectById(from)?.folder || '' : '' });
  }
  if (!work.length) return;
  serial(async () => { for (const w of work) { mirrorDebounce.cancel(w.id); await mirror().write(w.id, { from: w.from }); await nextTurn(); } }).catch(() => {});
}
const deletedFrom = new Map(); // chat id -> the project folder its file was in when the chat was deleted (the file moves to Chats/Deleted once the undo time is over)
// A project whose folder is gone shows "Folder missing" (Locate / Recreate). Looked at in the background (never in the list call) and at most every 3 s.
const folderState = new Map(); // project id -> { folder, ok }
let folderLook = 0;
function lookAtProjectFolders() {
  if (Date.now() - folderLook < 3000) return;
  folderLook = Date.now();
  for (const p of chats().projects()) {
    if (!p.folder) continue;
    fs.promises.stat(p.folder).then((s) => s.isDirectory(), () => false).then((ok) => {
      const was = folderState.get(p.id);
      folderState.set(p.id, { folder: p.folder, ok });
      if (was ? (was.folder !== p.folder || was.ok !== ok) : !ok) pushAttention();
    });
  }
}
const withFolderState = (p) => { const st = folderState.get(p.id); return p.folder && st && st.folder === p.folder && !st.ok ? { ...p, folderMissing: true } : p; };
// What a project's chats work in: its working folder, else its own folder.
const projectWorkFolderFor = (id) => { try { const pid = pendingProject.get(id); const p = pid ? projectById(pid) : chats().projectOf(id); return p ? (p.workFolder || p.folder || '') : ''; } catch { return ''; } };
// The open chat's working folder as the composer shows it: { path, shown, source: 'chat' | 'project' } or null.
function workFolderInfo(settings = agent.messages.settings) {
  const own = typeof settings?.workFolder === 'string' ? settings.workFolder : '';
  const dir = own || (typeof settings?.projectWorkFolder === 'string' ? settings.projectWorkFolder : projectWorkFolderFor(chatId)); // (a new chat has no settings yet: its project decides)
  return dir ? { path: dir, shown: projectFolders.shortPath(dir, { home: require('os').homedir() }), source: own ? 'chat' : 'project' } : null;
}
const emptyChatSettings = new Map(); // chat id -> settings (the model picked) of an empty chat left open elsewhere; see switchChat
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
  const slim = (list) => list.map((msg) => (Array.isArray(msg.content) ? { ...msg, content: msg.content.map((b) => keep(msg, b)) } : msg));
  snapshot.messages = slim(snapshot.messages);
  // [versions] the other versions of an exchange (regenerate, edit) are kept the same way, tool results and page text left out
  const slimForks = (forks) => (forks || []).map((f) => ({ ...f, tails: f.tails.map((t) => (t ? { messages: slim(t.messages), forks: slimForks(t.forks) } : null)) }));
  if (snapshot.forks) snapshot.forks = slimForks(snapshot.forks);
  return snapshot;
}

function saveChat(generation = chatGeneration) {
  if (generation !== chatGeneration) return;
  if (chatId && temporaryChats.has(chatId)) return; // [temporary chat] not kept
  clearTimeout(saveChatTimer);
  try {
    // No keychain (or not yet: Electron says so until the app is ready, which is where a copy of Lumen that quits because another
    // one is running ends up): nothing is saved, and nothing already on disk is deleted.
    if (!app.isReady() || !safeStorage.isEncryptionAvailable()) return;
    if (!chatId) chatId = chats().newId();
    const snapshot = chatSnapshot();
    if (!snapshot.messages.length) return;
    chats().saveAsync(chatId, snapshot); // (written in the background: no stall of the main thread; features/chat-store.js. Quitting writes what is pending at once)
    keepPendingProject(chatId);
    mirrorChatSoon(chatId); // [project folders]
    if (chats().current() !== chatId) chats().setCurrent(chatId, { defer: true });
  } catch (err) {
    chatSaveFailed(err);
  }
}
// During a long task the chat is saved after each step too, so quitting mid-run keeps what was done.
let saveChatTimer = null;
function saveChatSoon(generation) {
  clearTimeout(saveChatTimer);
  saveChatTimer = setTimeout(() => saveChat(generation), 1000);
}
// Everything not on disk yet is written now, on this thread: the app is closing, or Windows is logging off or shutting down (no time for more).
function flushChatsNow() {
  saveChat();
  try { if (mirrorDebounceObj) mirrorDebounce.flush().catch(() => {}); } catch { /* [project folders] best effort: a write still waiting starts now (none if nothing was ever mirrored) */ }
  for (const run of chatRuns.values()) if (!run.deleted && run.messages !== agent.messages) saveChatOf(run.chatId, run.messages); // chats left running
  try { chats().flush(); } catch { /* nothing pending */ }
}
app.on('before-quit', flushChatsNow);
app.on('will-quit', flushChatsNow); // (again: whatever a quit handler saved after the first)
app.on('session-end', flushChatsNow); // (Windows logoff / shutdown, where the app event exists)
app.on('browser-window-created', (_e, w) => { try { w.on('session-end', flushChatsNow); } catch { /* not a window that gets it */ } }); // (...and where only the window gets it)
app.whenReady().then(() => { try { require('electron').powerMonitor.on('shutdown', flushChatsNow); } catch { /* the event is not on this platform */ } }).catch(() => {});

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
// `loaded`: the chat's saved snapshot, already read (chats:open reads it without stopping the main thread).
function switchChat(id, { ensure = false, quiet = false, loaded = null } = {}) {
  if (id && id === chatId) return chatView();
  const live = id ? chatRuns.get(id) : null; // still running (or waiting for a slot): its live messages, not the file
  const snapshot = id && !live ? (loaded || chats().load(id)) : null;
  // A listed chat whose file is gone or unreadable is not opened as an empty chat under its id (that blanked a conversation already on
  // screen, and the next message would have replaced the saved chat): `ensure` is for a tab's own chat that has no file yet.
  if (id && !snapshot && !live && (!ensure || chats().has(id))) return null;
  saveChat();
  chatGeneration++;
  clearTimeout(saveChatTimer);
  if (chatId) approvedByChat.set(chatId, agent.approvedHosts);
  // An empty chat is never saved, so a model picked in it is kept here until the chat is opened again (or gets a message).
  if (chatId && !agent.messages.length && agent.messages.settings) emptyChatSettings.set(chatId, agent.messages.settings);
  if (agent.running) agent.detach(); // its run goes on with its own messages and approved sites
  else agent.reset();
  if (live) agent.attach(live.messages, approvedByChat.get(id));
  else if (snapshot) agent.restore(snapshot);
  else if (id && emptyChatSettings.has(id)) agent.messages.settings = emptyChatSettings.get(id);
  if (id) emptyChatSettings.delete(id);
  chatId = id || chats().newId();
  if (!live) agent.approvedHosts = approvedByChat.get(chatId) || agent.approvedHosts;
  const wasUnread = unreadChats.delete(chatId);
  if (id && (snapshot || live)) chats().setCurrent(id, { defer: true }); // (the pointer only a restart reads: written a moment later, not inside the tab switch)
  else if (!quiet) chats().setCurrent(null, { defer: true }); // (a tab's own empty chat, quiet: the last chat with a history stays the one a restart opens)
  // A quiet switch (a window's sidebar following its front tab's chat, from a call it made: syncToSender) changes no run's mark unless it
  // read an unread chat. Telling every window anyway made each one's Research panel (it refreshes on "chats:changed" with research:get,
  // which follows that window's tab) switch the chat back: two windows on different chats flooded each other with thousands of updates a second.
  if (!quiet || wasUnread) pushAttention();
  if (!quiet) shownPick = ownPickOfOpenChat(); // (a chat the user opened or began: the pickers show its model)
  announceModelIfChanged(); // each chat keeps its own model: the picker and the placeholders follow the chat now open
  lastAgentTarget = ''; // the "Working in" line follows the chat now open
  setImmediate(pushAgentTarget);
  syncProjectInstructions();
  return chatView();
}

// `live`: the chat is still running (it was left mid-reply): the sidebar picks the run up, with any
// approval card it waits on.
// [project workspace] The chat header's chip (the project's name), and the project's plan default for an empty chat.
function projectChipFor(id) {
  const p = projectForChat(id);
  return p ? { project: { id: p.id, name: p.name, ...(p.defaults?.plan ? { plan: true } : {}) } } : {};
}
function chatView() {
  const run = chatRuns.get(chatId);
  const live = run && run.queued ? { runId: run.runId, approvals: [], queued: { text: run.text, status: waitingText(run), runNow: true } }
    : run && agent.runningFor(run.messages) ? { runId: run.runId, approvals: [...run.pending.values()], target: agentTargetInfo(), partial: run.reply } : null;
  return { id: chatId, ...(temporaryChats.has(chatId) ? { temporary: true } : {}), items: agent.transcript(), usage: describeUsage(agent.messages.settings?.usage), context: contextView(agent.messages.settings?.context), workFolder: workFolderInfo(), effort: agent.openEffort(), ...projectChipFor(chatId), ...(live ? { live } : {}) };
}

// ---------- [background chats] the sidebar AI working on its own (features/chat-runs.js)
// Every sidebar run by chat id, while it runs: the open chat's and chats the user left mid-reply.
// { chatId, messages, runId, rec, pending: approvalId -> card event, reply, error, stopped, deleted }
const chatRuns = new Map();
const unreadChats = new Set(); // a reply finished while its chat was not in view
const chatWorkTab = new Map(); // [chat per tab] chat id -> the tab its last run worked in (where its check mark shows once it has finished)
const sidebarShown = new WeakMap(); // a window's UI -> is its sidebar open (chat:sidebar-state)
ipcMain.on('chat:sidebar-state', (event, open) => {
  sidebarShown.set(event.sender, Boolean(open));
  if (open) { unreadChats.delete(chatId); pushAttention(); try { agent.prewarm(''); } catch { /* not set up yet */ } } // (Claude Code starts while the user reaches for the box; a no-op for other engines)
});
// Saves a chat left running into its own file (the open chat goes through saveChat).
function saveChatOf(id, messages) {
  if (temporaryChats.has(id)) return; // [temporary chat] not kept
  if (id === chatId && messages === agent.messages) { saveChat(); return; }
  try {
    if (!safeStorage.isEncryptionAvailable()) return;
    const snapshot = chatSnapshot(messages);
    if (snapshot.messages.length) { chats().saveAsync(id, snapshot); keepPendingProject(id); mirrorChatSoon(id); }
  } catch (err) {
    chatSaveFailed(err);
  }
}
// A chat in use (a message sent, a reply started) goes to the top of the history lists: its activity time is stamped in the index at
// once (one small write, nothing per streamed token) and every open list redraws. Viewing, renaming and pinning never call this.
function bumpChat(id) {
  try { if (id && !temporaryChats.has(id) && chats().touch(id)) pushAttention(); } catch { /* the list keeps its order */ }
}
const detachedSaves = new Map();
function saveChatOfSoon(id, messages) {
  clearTimeout(detachedSaves.get(id));
  detachedSaves.set(id, setTimeout(() => { detachedSaves.delete(id); if (!chatRuns.get(id)?.deleted) saveChatOf(id, messages); }, 1000));
}
// What the user can see of a run right now (features/chat-runs.js plan).
function runView(run, recWanted = null) {
  const rec = recWanted || (run.rec && winRecs.has(run.rec) && rcAlive(run.rec) ? run.rec : curRec);
  const w = rec === curRec ? win : rec?.win;
  const uiWc = w && !w.isDestroyed() ? w.webContents : null;
  const runTab = run.tabId ?? null;
  return {
    focused: Boolean(w && !w.isDestroyed() && w.isFocused()),
    sidebarOpen: Boolean((uiWc && sidebarShown.get(uiWc)) || chatPageRt?.chatTabs().some((t) => t.id === activeIdOf(rec || curRec))),
    chatOpen: run.chatId === chatId,
    onAiTab: runTab != null && runTab === activeIdOf(rec || curRec), // the user is on the tab the AI works in
    chatHere: chatBind.chatOf(activeIdOf(rec || curRec)) === run.chatId, // [chat per tab] the user is on the chat's own tab (the AI may be working in another)
  };
}
// The same for every window: the chat may be open in a tab of another window than the one the run started in, and a user looking at
// it there must not get a notification (features/chat-runs.js plan, `views`). The run's own window comes first.
function runViews(run) {
  const first = run.rec && winRecs.has(run.rec) && rcAlive(run.rec) ? run.rec : curRec;
  return [first, ...[...winRecs].filter((r) => r !== first && rcAlive(r))].map((r) => runView(run, r));
}
// [widgets] The AI status card (features/aistatus-view.js) looks again when chats start, wait or end; set once the widgets exist.
let aiStatusSoon = () => {};
// [mission control] An open lumen://tasks page looks again; set once the page's wiring exists (below, after the agents).
let missionSoon = () => {};
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
  aiStatusSoon();
  missionSoon();
}
const chatBadges = () => new Map([...chats().list().map((c) => c.id), ...chatRuns.keys()].map((id) => {
  const run = chatRuns.get(id);
  return [id, chatRunsLib.chatBadge({ running: Boolean(run && !run.queued && agent.runningFor(run.messages)), queued: Boolean(run?.queued), approvals: run?.pending.size || 0, unread: unreadChats.has(id) })];
}));
// Tells the user about a run: a system notification (clicking it brings the window and that chat
// back), and the unread mark when the reply isn't in view.
function tellUser(run, kind) {
  if (run.deleted) { unreadChats.delete(run.chatId); pushAttention(); return; } // a chat deleted while it worked leaves no unread mark or notification behind
  const views = runViews(run);
  const decided = chatRunsLib.plan(kind, { settings: readSettings().bgTasks, views });
  if (decided.unread && kind !== 'approval') unreadChats.add(run.chatId);
  pushAttention();
  if (!decided.os) return;
  if (views.some((v) => v.focused)) { noteChatInApp(run, kind); return; } // Lumen is in front on another tab: macOS shows no banner for the front app, so the strip's toast says it
  if (TEST || !Notification.isSupported()) return;
  showNotification(run, kind);
}
// The tab strip's toast for a chat that finished or needs an OK while the user is in Lumen on another tab. "Open chat" goes where a
// click on the system notification would (openNotified). The newest few are kept for that button.
const chatNotes = new Map();
let chatNoteSeq = 0;
function noteChatInApp(run, kind) {
  const title = chats().list().find((c) => c.id === run.chatId)?.title || '';
  const text = chatRunsLib.notification(kind, { reply: run.reply, error: run.error, summary: run.errorSummary, chat: title, tabs: replyTabs(run) }, t);
  const token = ++chatNoteSeq;
  chatNotes.set(token, { run, kind, approvalTab: kind === 'approval' ? run.tabId ?? null : null });
  for (const old of chatNotes.keys()) { if (chatNotes.size <= 10) break; chatNotes.delete(old); }
  const rec = focusedRec() || curRec;
  if (!rcAlive(rec) || !winRecs.has(rec)) return;
  withWindow(rec, () => ui()?.send('tabs:organize-note', { text: text.title, undo: true, ttl: kind === 'approval' ? 20000 : 12000, chatNote: token, undoLabel: t('agent.notify.open'), undoTitle: [text.title, text.body].filter(Boolean).join('\n') }));
  if (TEST) (global.__chatNotes ||= []).push({ token, kind, text: text.title });
}
ipcMain.handle('chat:open-note', (_e, token) => { const entry = chatNotes.get(Number(token)); return entry ? openNotified(entry) : false; });
// Electron drops a Notification's click handler when the object is garbage collected, so the keeper holds each one until it is
// clicked (or old). A toast clicked after it went to the Action Center arrives as an activation instead (activateNotified).
const notifyKeeper = notifyTarget.createKeeper();
function showNotification(run, kind) {
  const title = chats().list().find((c) => c.id === run.chatId)?.title || '';
  const text = chatRunsLib.notification(kind, { reply: run.reply, error: run.error, summary: run.errorSummary, chat: title, tabs: replyTabs(run) }, t);
  try {
    const entry = { run, kind, approvalTab: kind === 'approval' ? run.tabId ?? null : null }; // (the tab an approval is about is the one the run was in when it asked)
    const n = TEST ? new (require('events'))() : new Notification({ title: text.title, body: text.body, silent: false });
    if (TEST) n.show = () => {};
    const item = notifyKeeper.keep(n, entry);
    n.on('click', () => { notifyKeeper.clicked(item); openNotified(entry); });
    n.show();
    return item;
  } catch { return null; }
}
// Brings the user to what a chat notification is about: that tab (in whichever window holds it now), the window raised, the sidebar on
// the chat. The tab is where the AI last worked (its own tab when it navigated), see features/notify-target.js; if that tab is gone, the
// tab the chat started in, else the run's window.
function openNotified({ run, kind, approvalTab }) {
  const found = notifyTarget.pickTab({ kind, approvalTab, runTab: run.tabId, aiNavTab: run.messages?.aiNavTabId, homeTab: run.homeTab, bound: chatBind.tabsHomeFirst(run.chatId) }, (id) => Boolean(tabAnywhere(id)));
  const home = found != null ? tabAnywhere(found) : null;
  const rec = home?.rec || (run.rec && winRecs.has(run.rec) && rcAlive(run.rec) ? run.rec : curRec);
  const w = rec === curRec ? win : rec?.win;
  if (!w || w.isDestroyed()) return false;
  if (home) { showTab(home.rec, home.t.id); showChatInTab(home, run.chatId); }
  else raiseWindow(w);
  w.webContents.send('agent:open-chat', { id: run.chatId });
  return true;
}
// A tab the AI worked in has no chat of its own (it carried the open one): it shows the chat the notification is about, opened.
function showChatInTab({ rec, t: tab }, chatIdWanted) {
  try {
    if (chatBind.chatOf(tab.id) !== chatIdWanted) { chatBind.bind(tab.id, chatIdWanted, { share: true }); withWindow(rec, () => followTabChat(tab)); }
    setTabSidebar(tab.id, true);
  } catch { /* the sidebar's own open-chat still follows */ }
}
// An activation with no click of its own (the app was closed or its window minimised, the toast was in the Action Center): the newest
// fresh notification is the one meant.
function activateNotified() {
  const entry = notifyKeeper.takeActivation();
  return entry ? openNotified(entry) : false;
}
// The window to the front even when Windows will not give the foreground to a background app (focus() alone only flashes the taskbar).
function raiseWindow(w) {
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.show();
  if (TEST && process.env.LUMEN_TEST_BACKGROUND) return; // (a test run never takes the foreground)
  if (process.platform === 'win32') { try { w.setAlwaysOnTop(true); w.focus(); w.setAlwaysOnTop(false); } catch { w.focus(); } try { app.focus({ steal: true }); } catch {} }
  else { w.focus(); try { app.focus({ steal: true }); } catch {} }
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
// A start that throws, or a slot whose run vanished without a "done" (an engine process that exited), is finished with an
// error and a done event so the chat never stays "running"; the slot goes to the next in line.
const runSlots = tabChatsLib.createRunSlots({
  onError: (id, err) => chatRuns.get(id)?.fail?.(err),
  onStale: (id) => chatRuns.get(id)?.fail?.(new Error(t('agent.engineStopped'))),
});
scheduler.every('run-slots', 5000, () => { try { runSlots.sweep(); } catch { /* the sweep never breaks anything */ } }, { whenHidden: 15000 });
const lastSidebar = {}; // [ai] which engines the model menu offers (Settings → AI → AI providers): the menu is rebuilt when one moves
const SIDEBAR_KEYS = ['codexSidebar', 'claudeCodeSidebar', 'grokSidebar', 'antigravitySidebar'];
onSettingsWritten = (s) => { adblock.sync(); const moved = SIDEBAR_KEYS.some((k) => { const first = !(k in lastSidebar); const was = lastSidebar[k]; lastSidebar[k] = s[k]; return !first && was !== s[k]; }); if (moved) { try { modelsChanged(); } catch { /* not set up yet */ } } if (s.maxChatRuns !== undefined && tabChatsLib.clampRuns(s.maxChatRuns) !== runSlots.limit) runSlots.setMax(s.maxChatRuns); aiStatusSoon(); };
const shownChat = new WeakMap(); // a window's UI -> the chat its sidebar shows
// ---------- [sidebar per tab] the sidebar is open or closed tab by tab (features/sidebar-tabs.js)
// Each tab keeps its own answer, whatever chat it shows or shares: opening or closing the sidebar in one tab never opens or
// closes it in another (tabs showing the same chat used to share it, so a toggle in one flipped the others). The renderer asks
// for it (sidebar:set, from the toolbar button, Ctrl+J, or an agent feature opening the sidebar for the tab in front) and
// applies the front tab's answer from every tabs state.
const sidebarTabs = sidebarTabsLib.create();
const sidebarSharers = (tabId) => {
  const tab = tabs.find((t) => t.id === tabId);
  const mate = tab?.split ? splitPartner(tab) : null; // [split view] the two sides of a pair open and close the sidebar together (the page area must not jump when the other side is clicked)
  return mate ? [mate.id] : [];
};
const tabSidebarOpen = (tab) => Boolean(tab) && sidebarTabs.isOpen(tab.id, sidebarSharers(tab.id));
function setTabSidebar(tabId, open) {
  const hit = tabAnywhere(tabId);
  if (!hit) return false;
  const written = sidebarTabs.set(tabId, open, sidebarSharers(tabId));
  for (const rec of winRecs) { // the strips' state carries it: every window with one of these tabs
    if (rcAlive(rec) && tabsOf(rec).some((t) => written.includes(t.id))) withWindow(rec, sendTabs);
  }
  return true;
}
// A tab whose chat waits for the user's OK shows its sidebar when it comes to the front (the card is there to answer).
function openForApproval(tab) {
  const cid = tab && chatBind.chatOf(tab.id);
  if (cid && chatRuns.get(cid)?.pending.size && !tabSidebarOpen(tab)) sidebarTabs.set(tab.id, true, sidebarSharers(tab.id));
}
ipcMain.handle('sidebar:set', (_event, tabId, open) => setTabSidebar(tabId ?? activeId, Boolean(open))); // (no tab named: the one in front in the asking window)
const runIsLive = (r) => Boolean(r && !r.deleted && (r.queued || agent.runningFor(r.messages)));
const chatBusy = (id) => runIsLive(chatRuns.get(id));
const waitingText = () => t('agent.waiting', { n: runSlots.size() }); // (only the "Chats working at once" cap makes a chat wait)
// The chat of a running task that works in this tab, whichever chat that is.
function pinnedChat(tabId) {
  for (const r of chatRuns.values()) if (!r.deleted && !r.queued && agent.runTabIdFor(r.messages) === tabId) return r.chatId;
  return null;
}
// The mark a tab shows: 'approval' | 'running' | 'waiting' | 'done' | null.
// The tab a chat's mark belongs to: the one it works (or worked) in while that tab still shows the chat, else the chat's home tab (a new chat was started in the tab it works in).
const markTabOf = (id, work) => (work != null && chatBind.chatOf(work) === id ? work : chatBind.tabOf(id) ?? null);
function tabChatMark(tabId) {
  const bound = chatBind.chatOf(tabId);
  const rank = { approval: 4, running: 3, waiting: 2, done: 1 };
  let best = null;
  const pinned = pinnedChat(tabId);
  const chatPage = tabAnywhere(tabId)?.t.managerPage === 'chat';
  for (const id of new Set([bound, pinned].filter(Boolean))) {
    const run = chatRuns.get(id);
    // [working-on chip] A reply typed on the chat page has no home tab: a web tab that merely shows the same chat is not "running" for it
    // (only the tab its tools work in, and the chat page itself, are). A reply started in a tab's own sidebar does mark that tab.
    const elsewhere = run && !run.deleted && run.homeTab == null && id !== pinned && !chatPage;
    const at = tabAnywhere(tabId);
    if (!tabChatsLib.markHere({ tabId, workTab: markTabOf(id, run && !run.deleted ? (run.tabId ?? run.homeTab ?? null) : chatWorkTab.get(id) ?? null), open: Boolean(at && activeIdOf(at.rec) === tabId), own: chatPage || id === pinned })) continue; // only the tab it works in and the tab you have open, not every tab that once used this chat
    const live = runIsLive(run) && !elsewhere ? (run.queued ? 'queued' : 'running') : null;
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
  for (const rec of winRecs) if (rcAlive(rec)) withWindow(rec, () => sendTabsSoon());
}
// A chat shown in tabs of two windows: the other window's sidebar hears the run too (its turn, then its events).
// `except`: the views that already got it.
function mirrorToViews(id, except, channel, payload) {
  const skip = new Set(except);
  for (const rec of winRecs) {
    if (!rcAlive(rec)) continue;
    const wc = rec.win.webContents;
    if (wc && !wc.isDestroyed() && !skip.has(wc) && shownChat.get(wc) === id) wc.send(channel, payload);
  }
}
function pushChatView(wc) {
  if (!wc || wc.isDestroyed()) return;
  shownChat.set(wc, chatId);
  const run = chatRuns.get(chatId);
  if (runIsLive(run)) run.sender = wc; // its events go to the sidebar that shows it now
  const view = chatView();
  wc.send('chat:sync', { view });
  // A chat page already on this chat is not told: the sidebar showing it too changes nothing there, and drawing the chat again scrolled it to the
  // bottom (and, before the composer was left alone on a sync, wiped what was being typed).
  const same = (chatPageRt?.everyChatTab() || []).filter((t) => chatBind.chatOf(t.id) === chatId).map((t) => t.view.webContents);
  chatPageRt?.broadcast('chat:sync', { view }, [wc, ...same]);
}
// The sidebar of the window just entered shows the chat of its front tab.
// `push`: tell the sidebar (false when the sender already shows it).
function followTabChat(tab, { push = true } = {}) {
  if (!tab || tab.isolated || tab.settings || tab.rec?.agent) return; // Settings keeps whatever chat is open. [agent window] An outside agent's tabs have no chat, and opening one never changes the user's
  if (tab.managerPage === 'chat' && !chatBind.chatOf(tab.id)) { chatBind.bind(tab.id, chatId, { share: true }); } // the chat page keeps the chat it was left on, like any tab; one with none yet takes the open chat and keeps it from then on
  const own = chatBind.chatOf(tab.id) || (tab.managerPage === 'chat' ? null : pinnedChat(tab.id));
  const plan = own ? { chat: own } : tabChatsLib.followPlan({ tabId: tab.id, chatOf: () => null, claimed: chatBind.claimed, openChatId: chatId, openIdle: !chatBusy(chatId), carry: readSettings().oneChatPerTab !== true });
  const sidebarOpen = Boolean(ui() && sidebarShown.get(ui()));
  const unseen = (id) => unreadChats.has(id) && !sidebarOpen; // a finished reply stays "done" on its tab until the sidebar is looked at
  if (plan.chat) {
    if (chatBind.chatOf(tab.id) !== plan.chat) chatBind.bind(tab.id, plan.chat); // (a tab already showing it stays as it is: coming to the front must not make it the home)
    const keep = unseen(plan.chat);
    if (plan.chat !== chatId && !switchChat(plan.chat, { ensure: true, quiet: true })) { // its saved file can't be read (gone, or locked): the tab lets go of it and starts over, never an empty chat under its id
      chatBind.unbindTab(tab.id);
      followTabChat(tab, { push });
      const page = tab.managerPage === 'chat' ? tab.view?.webContents : null;
      if (page && !page.isDestroyed()) page.send('chat:sync', { view: chatView() }); // a chat page shows the chat it has now, not the one that is gone
      return;
    }
    if (keep) unreadChats.add(chatId);
    else if (sidebarOpen) unreadChats.delete(chatId);
  } else if (plan.carry) {
    chatBind.bind(tab.id, plan.carry, { share: true }); // the chat carries on in this tab; its home moves here when a message is sent from it (agent:ask)
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
// The pickers everywhere show one model: the open chat's. A window or chat page whose own chat was left on another model (a pick made in
// another window or page changed the open chat only) would show that model yet send with its own. So a message takes the shown model.
function adoptShownModel(shown) {
  const st = agent.messages?.settings;
  if (!shown || (st && (st.autoFrom || st.fallbackFrom || st.model) === shown)) return;
  agent.setModel(shown);
}
function followFront(opts) {
  followTabChat(tabs.find((x) => x.id === activeId), opts);
}
// A message from a window's sidebar: the open chat is that window's tab's chat before anything is done with it.
function syncToSender(event) {
  const rec = recOfSender(event?.sender);
  if (rec) withWindow(rec, () => followFront({ push: false }));
  else followChatPage(event?.sender); // a chat page's own call: the open chat is the page's tab's chat
}
// A read-only call (the chat list, the research board) that needs the sender's chat to answer, but must not take the open chat from
// whichever window the user is really using: with two windows or a chat page on different chats, each one's refresh used to flip the
// open chat to its own and leave it there, so a model picked, or a chat opened, in one place was undone by the next refresh of another
// (the pickers then showed, and the next message used, a different chat's model). The open chat is put back once the answer is read.
function readForSender(event, read) {
  const before = chatId;
  syncToSender(event);
  try { return read(); } finally { if (chatId !== before) switchChat(before, { ensure: true, quiet: true }); }
}
// A chat page (in a tab, any window) asked for something: the open chat becomes the chat its tab was left on, so what it sends or
// resets is that chat's, whichever chat the sidebar or another tab has open now.
// The tab a chat call acts for: a chat page's own tab (it keeps its chat there), else the tab in front.
const pageTabOf = (wc) => (wc && chatPageRt?.everyChatTab().find((t) => t.view.webContents === wc)) || null;
function followChatPage(wc) {
  const page = wc && chatPageRt?.everyChatTab().find((t) => t.view.webContents === wc);
  if (page) withWindow(page.rec, () => followTabChat(page, { push: false }));
}
// The sidebar asks which chat it should be showing: a tab switch that skipped the sidebar (a tool was acting at that moment, see
// switchTab) leaves it on the chat it had, with that chat's running state. The answer is the authoritative view of the chat of
// this window's front tab; the sidebar applies it when it differs from what it shows.
ipcMain.handle('chat:resync', (event) => {
  const wc = event.sender;
  if (!wc || wc.isDestroyed() || chatPageRt.isChatSender(event)) return null;
  // (a window's refresh answers for its own chat but must not take the open chat from the window in use: see readForSender)
  return readForSender(event, () => {
    shownChat.set(wc, chatId);
    const run = chatRuns.get(chatId);
    if (runIsLive(run)) run.sender = wc;
    return { view: chatView() };
  });
});
// [sidebar keeps the run] The sidebar button is about to open the sidebar on the front tab: is a chat there working, waiting for an OK,
// or finished unread while the sidebar was closed? Then that chat is the one to show, whatever "Sidebar button starts a new chat"
// says. The chat is the tab's own, or the one whose run works in this tab (a tab the AI opened). Answers { id, reason, view } with the
// chat taken as the open one, or null when nothing is there to keep.
ipcMain.handle('chat:sidebar-target', (event, opts) => {
  const wc = event.sender;
  if (!wc || wc.isDestroyed() || chatPageRt.isChatSender(event)) return null;
  syncToSender(event);
  const rec = recOfSender(wc) || curRec;
  const front = rec ? activeIdOf(rec) : null;
  if (front == null) return null;
  const reasonOf = (id) => {
    const run = chatRuns.get(id);
    if (run && !run.deleted && run.pending.size) return 'approval';
    if (opts?.approvalOnly === true) return null; // [ask ai new chat] the AI button starts a new chat even over a running one; only a question waiting for an OK keeps its chat
    if (chatBusy(id)) return 'running';
    return unreadChats.has(id) ? 'unread' : null;
  };
  const ownsFront = [...chatRuns.values()].filter((r) => runIsLive(r) && !r.queued && agent.runTabIdFor(r.messages) === front).map((r) => r.chatId);
  const hits = [chatBind.chatOf(front), ...ownsFront].filter(Boolean).map((id) => ({ id, reason: reasonOf(id) })).filter((h) => h.reason);
  const hit = hits.find((h) => h.reason === 'approval') || hits.find((h) => h.reason === 'running') || hits[0];
  if (!hit) return null;
  if (hit.id !== chatId && !switchChat(hit.id, { ensure: true, quiet: true })) return null;
  if (chatBind.chatOf(front) == null) chatBind.bind(front, hit.id);
  shownChat.set(wc, chatId);
  const run = chatRuns.get(chatId);
  if (runIsLive(run)) run.sender = wc;
  return { id: chatId, reason: hit.reason, view: chatView() };
});
// Every other window's sidebar follows its own tab again (a chat moved away from a tab it was showing in).
function refreshSidebars() {
  if (winRecs.size < 2) return;
  const home = curRec;
  for (const rec of [...winRecs]) if (rec !== home && rcAlive(rec)) withWindow(rec, () => followFront());
  if (home && winRecs.has(home)) withWindow(home, () => followFront({ push: false }));
}
// The open chat now belongs to the tab in front ("Move chat to this tab", a chat chosen from the list, a new chat).
function bindOpenChatHere(sender) {
  const page = pageTabOf(sender);
  if (page) { // a chat page opened it: that page shows it from now on (no tab loses it, no run moves onto the page's tab)
    chatBind.bind(page.id, chatId, { share: true });
    shownChat.set(sender, chatId);
    pushAttention();
    refreshSidebars();
    return;
  }
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
// [keep connected] A chat's tab closed: once no tab shows the chat (a few seconds later: another tab may adopt it) and it
// isn't working, its kept Grok Build process ends (features/grok-warm.js). Nothing is read unless a process is kept.
function grokChatLeft(chat, { now = false } = {}) {
  if (!chat) return;
  const sessionOf = () => (chatRuns.get(chat)?.messages || (chat === chatId ? agent.messages : chats().load(chat)))?.settings?.gbSession || null;
  if (now) { aiAgents.grokChatGone(sessionOf); return; }
  const t = setTimeout(() => { if (!chatBind.claimed(chat) && !chatRuns.has(chat)) aiAgents.grokChatGone(sessionOf); }, 5000);
  t.unref?.();
}
// A tab closed. Its chat stays in the list. A chat still working there keeps going: its work moves to a fresh background
// tab in the same window (no question asked: closing a tab must not silently kill a task, and it can be stopped from its
// chat). When it was the window's last tab the window goes with it and the task ends with "the tab was closed".
// [warm per chat] A chat left Lumen's tabs or was deleted: its own warm Claude Code process ends (features/warm-chats.js).
// After a tab close, only once no tab shows the chat a few seconds later (another tab may adopt it).
function warmChatLeft(chat, { now = false } = {}) {
  if (!chat) return;
  const gone = () => { try { aiAgents.chatGone(chat); } catch { /* not set up yet */ } };
  if (now) { gone(); return; }
  const t = setTimeout(() => { if (!chatBind.claimed(chat)) gone(); }, 5000); // (a chat still working is freed when its message ends)
  t.unref?.();
}
function chatTabGone(id, goneRec = null) {
  const rec = goneRec && winRecs.has(goneRec) && rcAlive(goneRec) ? goneRec : curRec; // the closed tab's own window, not whichever is in front
  warmChatLeft(chatBind.chatOf(id)); // [warm per chat]
  grokChatLeft(chatBind.chatOf(id)); // [keep connected]
  chatBind.unbindTab(id);
  sidebarTabs.forget(id); // [sidebar per tab]
  for (const r of chatRuns.values()) {
    if (r.deleted) continue;
    if (r.queued && r.homeTab === id) r.homeTab = null;
    if (r.queued || agent.runTabIdFor(r.messages) !== id || !tabs.length) continue;
    const tab = withWindow(rec, () => openTab(undefined, { background: true, openedBy: { chatId: r.chatId, runId: r.runId } })); // [ai manners] opened for the chat: it may work there
    agent.repinRun(r.messages, tab.id, { rec });
    r.rec = rec;
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
// Never takes a tab that shows another chat which has content (another run's, or one with history): the run still works in the tab
// it switched to (its task scope pins it), the tab just keeps its own chat.
function bindRunChatTo(tabId) {
  const s = agent.currentScope();
  const id = s?.chat ? [...chatRuns.values()].find((r) => r.messages === s.chat)?.chatId : null;
  if (!id) return;
  const other = chatBind.chatOf(tabId);
  if (other && other !== id && chatNotEmpty(other)) return;
  chatBind.bind(tabId, id);
}
if (TEST) global.__tabChats = { setSidebar: (id, open) => setTabSidebar(id, open), sidebar: (id) => { const hit = tabAnywhere(id); return hit ? tabSidebarOpen(hit.t) : null; }, viewBounds: (id) => tabAnywhere(id)?.t.view?.getBounds?.() || null, bindings: chatBind, slots: runSlots, mark: tabChatMark, chatId: () => chatId, shown: () => (ui() ? shownChat.get(ui()) : null), runs: () => [...chatRuns.values()].map((r) => ({ chatId: r.chatId, queued: Boolean(r.queued), tab: r.queued ? r.homeTab : agent.runTabIdFor(r.messages), live: runIsLive(r) })) };

// ---------- [ai manners] close the tabs the AI opened (features/ai-manners.js)
// A tab the AI opened (agentOpenTab, a research tab, a tab Lumen opened for a chat) is marked `openedBy` the run and chat, shown
// in the strip, and can be closed again: under the reply, from a tab's menu, from a chat's row, or by the setting (Off / Ask /
// Always, the default). The user's own tabs never are: a tab they clicked in, typed in, navigated, pinned or moved loses the mark, a pinned
// tab and the tab a chat lives in are skipped, and an automatic close also leaves the tab in front, tabs holding typed text, a tab
// playing sound, and a tab the AI said the user needs (open_tab / switch_tab keep:true: manners.keepAfterRun).
const aiCloseUndo = new Map(); // token -> [{ url, partition, rec }]: what a close took, for Undo
let aiCloseSeq = 0;
const chatNotEmpty = (cid) => chatRuns.has(cid) || chats().list().some((c) => c.id === cid);
// The tabs (of every window, or just `rec`'s) the AI opened that may be closed, as [{ rec, tab }]. `runId` / `chatId` narrow it
// to that run's / chat's; neither: all of them. `busy: true` answers the other question: the ones a run is working in right now,
// which a close keeps (and says so).
function aiTabSelect({ runId = null, chatId = null, auto = false, rec = null, busy: wantBusy = false } = {}) {
  const found = [];
  const own = new Set(chatId != null ? [chatId] : []);
  if (runId != null) for (const r of winRecs) for (const x of rcAlive(r) ? tabsOf(r) : []) if (x.openedBy?.runId === runId && x.openedBy.chatId != null) own.add(x.openedBy.chatId);
  const bound = new Set();
  for (const [tabId, cid] of chatBind.entries()) if (own.size ? own.has(cid) : chatNotEmpty(cid)) bound.add(tabId);
  const busy = agent.runTabIds();
  for (const r of rec ? [rec] : [...winRecs]) {
    if (!rcAlive(r)) continue;
    const audibleIds = auto ? tabsOf(r).filter((x) => x.openedBy && alive(x) && x.view.webContents.isCurrentlyAudible()).map((x) => x.id) : []; // [ai manners] a tab playing sound stays open after the run
    const opts = { runId, chatId, boundIds: [...bound], busyIds: busy, audibleIds, activeId: activeIdOf(r), auto };
    for (const tab of wantBusy ? manners.busyKept(tabsOf(r), opts) : manners.closeSelection(tabsOf(r), opts)) found.push({ rec: r, tab });
  }
  return found;
}
// Closes them (each goes through requestCloseTab: a page's "Leave site?" is still asked). `auto`: also keeps a tab that holds
// typed text. Returns { closed, token }; the token undoes it (aiTabsReopen).
// A tab holding text typed into a form is never closed (by any path: the button, a menu, the chat row or the setting): the text
// would be lost, and Undo only brings the address back. A page that asks "Leave site?" is kept open too, without the question being
// shown (it would bring the tab to the front). Only tabs that really closed are recorded for Undo.
// Returns { closed, kept, token }: `kept` tabs stayed open for one of those reasons.
function closeAiTab(rec, tab) {
  return new Promise((resolve) => {
    tab.aiClosing = true;
    tab.aiCloseKept = false;
    withWindow(rec, () => requestCloseTab(tab.id));
    const began = Date.now();
    const poll = setInterval(() => {
      const gone = !tabAnywhere(tab.id);
      if (!gone && !tab.aiCloseKept && Date.now() - began < CLOSE_TIMEOUT_MS + 1500) return;
      clearInterval(poll);
      tab.aiClosing = false;
      resolve(gone);
    }, 50);
  });
}
// The page check before a close can take a second: the strip says so at once, and aiCloseNote's toast replaces it.
function aiClosingNote(rec) {
  if (rcAlive(rec) && winRecs.has(rec)) withWindow(rec, () => ui()?.send('tabs:organize-note', { text: t('chat.aiTabs.closing'), undo: false, ttl: 6000 }));
}
// The tab strip's toast after a close from the tab menu or a chat's row: what closed, what stayed (and why), with Undo.
function aiCloseNote(rec, { closed = 0, kept = 0, busy = 0, token = 0 } = {}) {
  if (!rcAlive(rec) || !winRecs.has(rec)) rec = focusedRec(); // the window the tabs were in is gone: the toast (and its Undo) goes to the one the user is in
  const plural = (base, n) => t(`${base}.${n === 1 ? 'one' : 'other'}`, { count: n });
  const text = [closed ? plural('chat.aiTabs.closed', closed) : kept || busy ? '' : t('chat.aiTabs.none'), kept ? plural('chat.aiTabs.kept', kept) : '', busy ? plural('chat.aiTabs.busy', busy) : ''].filter(Boolean).join(' ');
  if (!rcAlive(rec) || !winRecs.has(rec)) return;
  withWindow(rec, () => ui()?.send('tabs:organize-note', { text, undo: Boolean(closed && token), ttl: 9000, aiUndo: closed ? token : 0, undoLabel: t('chat.aiTabs.undo'), undoTitle: t('chat.aiTabs.undo') }));
}
// A tab that held back a close (typed text, or a page that asks before leaving) is the user's from now on: it shows in the strip
// even with the "hide tabs the AI opened" toggle on, loses its mark, and is not offered for closing again.
function keepTab(rec, tab) {
  manners.handOver(tab);
  withWindow(rec, () => sendTabs());
  return { kept: true };
}
// The popup windows the AI's pages opened for this run / chat (all of them with neither): not one the user focused or typed in, nor one holding
// typed text or a download. Closed outright (a window has no Undo).
async function aiPopupsClose({ runId = null, chatId = null } = {}) {
  for (const [child, mark] of [...aiPopups]) {
    if (child.isDestroyed()) { aiPopups.delete(child); continue; }
    if ((runId != null && mark.runId !== runId) || (chatId != null && mark.chatId !== chatId) || mark.touched) continue;
    const wc = child.webContents;
    if (downloads.list.some((d) => d.state === 'progressing' && d.contents === wc)) continue;
    if ((await unsavedInputState(wc)) === 'yes') continue;
    if (child.isDestroyed() || mark.touched) continue;
    aiPopups.delete(child);
    try { child.close(); } catch { /* gone */ }
  }
}
async function aiTabsClose(selector = {}, { auto = false } = {}) {
  const picked = aiTabSelect({ ...selector, auto });
  const popups = aiPopupsClose(selector).catch(() => {});
  const busyBefore = aiTabSelect({ ...selector, auto, busy: true }).length; // [ai manners] tabs a run is still working in: kept, and the toast says "Kept 1 tab the AI is still using"
  const results = await Promise.all(picked.map(async ({ rec, tab }) => {
    if (alive(tab) && downloads.list.some((d) => d.state === 'progressing' && d.contents === tab.view.webContents)) return keepTab(rec, tab); // (a download in progress is the user's: closing the tab could cancel it)
    if (alive(tab) && (await unsavedInputState(tab.view.webContents)) === 'yes') return keepTab(rec, tab); // (no answer from a hung or crashed page is not "holds text": it closes by the normal path, which force-closes a frozen page)
    // The page answered after a round trip: the user may have taken the tab, a run may have moved in, a chat may have bound it.
    if (!manners.isAiTab(tab) || tab.closing || !tabAnywhere(tab.id) || !aiTabSelect({ ...selector, auto, rec }).some((x) => x.tab === tab)) return { kept: false, skipped: true };
    const item = { url: tabUrl(tab), partition: tab.isolated || null, rec, groupId: tab.groupId || null };
    return (await closeAiTab(rec, tab)) ? { item } : keepTab(rec, tab);
  }));
  await popups;
  const items = results.filter((r) => r.item).map((r) => r.item);
  const token = items.length ? ++aiCloseSeq : 0;
  if (token) {
    aiCloseUndo.set(token, items);
    while (aiCloseUndo.size > 20) aiCloseUndo.delete(aiCloseUndo.keys().next().value);
  }
  const result = { closed: items.length, kept: results.filter((r) => r.kept).length, busy: busyBefore, token };
  Object.defineProperty(result, 'rec', { value: items[0]?.rec || picked[0]?.rec || null }); // (not sent over IPC) the window holding the tabs: where a toast belongs
  return result;
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
    if (at >= 0) { closedTabs.splice(at, 1); closedInfo.splice(at, 1); }
    const rec = item.rec && winRecs.has(item.rec) && rcAlive(item.rec) ? item.rec : curRec;
    withWindow(rec, () => openTab(item.url, { background: true, ...(item.partition ? { partition: item.partition } : {}), ...(item.groupId && tabGroups.groups.has(item.groupId) ? { groupId: item.groupId } : {}) })); // (back in its group, when the group is still there)
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
// A close always names the run or the chat whose tabs it means: a call with neither closes nothing (it must never mean "every AI tab").
const cleanSelector = (o) => ({ runId: Number.isFinite(Number(o?.runId)) && o?.runId !== null && o?.runId !== undefined ? Number(o.runId) : null, chatId: typeof o?.chatId === 'string' && o.chatId ? o.chatId : null });
const aiTabsCloseFor = (o) => { const s = cleanSelector(o); return s.runId === null && s.chatId === null ? { closed: 0, kept: 0, token: 0 } : aiTabsClose(s); };
ipcMain.handle('agent:ai-tabs-close', (_e, o) => aiTabsCloseFor(o));
ipcMain.handle('agent:ai-tabs-undo', (_e, token) => aiTabsReopen(Number(token)));
// The sidebar's "hide the tabs the AI opened" toggle: a saved setting (prefs:ui carries it to the strip). It only leaves them out of
// the strip: they stay open and stay the AI's (its tools, the chat's own tab, Close tabs the AI opened all still reach them).
ipcMain.handle('tabs:hide-ai', async (_e, on) => {
  if (typeof on === 'boolean') await settingsBackend.set('hideAiTabs', on);
  return readSettings().hideAiTabs === true;
});
// Right-click on that toggle: the same switch, and closing the AI's tabs outright (every window, with Undo, as the menus'
// "Close tabs the AI opened" does), so tabs the user no longer wants need not just be hidden.
function hideAiMenuTemplate() {
  const count = aiTabSelect({}).length;
  return [
    { label: t('sidebar.hideAiTabs.menu.hide'), type: 'checkbox', checked: readSettings().hideAiTabs === true, click: (item) => { settingsBackend.set('hideAiTabs', item.checked); } },
    { type: 'separator' },
    { label: count ? t('sidebar.hideAiTabs.menu.close', { count }) : t('sidebar.hideAiTabs.menu.closeNone'), enabled: count > 0, click: () => { closeAiTabsEverywhere().catch(() => {}); } },
  ];
}
const hideAiMenuPops = []; // (tests: where each request to open the menu came from; the test build opens no native menu)
ipcMain.on('tabs:hide-ai-menu', (event, at) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner.isDestroyed()) return;
  // From the keyboard (Menu key, Shift+F10) the strip says where: under the button
  const pos = Number.isFinite(at?.x) && Number.isFinite(at?.y) ? { x: Math.round(at.x), y: Math.round(at.y) } : {};
  if (TEST) { hideAiMenuPops.push(pos); return; }
  Menu.buildFromTemplate(hideAiMenuTemplate()).popup({ window: owner, ...pos });
});
if (TEST) global.__hideAiMenuPops = () => hideAiMenuPops.slice();
// [side tabs] Tab layout: Top (tabs across the window) or Side (a list down its left). Right-click on the empty part of the strip, or on the
// side list, switches it and turns icons-only on or off; the list's own width and fold are saved from the list (tabs:side). The setting
// reaches every window through prefs:ui (renderer/side-tabs.js lays the list out; the page area simply follows where the list ends).
function stripMenuTemplate() {
  const p = readSettings();
  const side = p.tabLayout === 'side';
  const set = (key, value) => { settingsBackend.set(key, value).catch(() => {}); };
  return [
    { label: t('tabs.layout.menu.side'), type: 'checkbox', checked: side, click: (item) => set('tabLayout', item.checked ? 'side' : 'top') },
    ...(side ? [{ label: t('tabs.layout.menu.icons'), type: 'checkbox', checked: p.sideTabsCollapsed === true, click: (item) => set('sideTabsCollapsed', item.checked) }] : []),
  ];
}
const stripMenuPops = []; // (tests: the menu is not opened natively in the test build)
ipcMain.on('tabs:strip-menu', (event, at) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner || owner.isDestroyed()) return;
  const pos = Number.isFinite(at?.x) && Number.isFinite(at?.y) ? { x: Math.round(at.x), y: Math.round(at.y) } : {};
  if (TEST) { stripMenuPops.push(pos); return; }
  Menu.buildFromTemplate(stripMenuTemplate()).popup({ window: owner, ...pos });
});
ipcMain.handle('tabs:side', async (_e, o) => {
  if (Number.isFinite(o?.width)) await settingsBackend.set('sideTabsWidth', o.width);
  if (typeof o?.collapsed === 'boolean') await settingsBackend.set('sideTabsCollapsed', o.collapsed);
  const p = readSettings();
  return { width: p.sideTabsWidth, collapsed: p.sideTabsCollapsed === true };
});
if (TEST) global.__contentBounds = () => ({ ...contentBounds, view: tabs.find((x) => x.id === activeId && alive(x))?.view.getBounds() || null }); // (test/e2e/side-tabs.js: where the page area is, and where the front tab's view really is)
if (TEST) global.__stripMenu = () => ({ pops: stripMenuPops.slice(), items: stripMenuTemplate().map((i) => ({ label: i.label || '', checked: Boolean(i.checked), run: () => i.click?.({ checked: !i.checked }) })) });
if (TEST) global.__hideAiMenu = () => hideAiMenuTemplate().map((i) => ({ label: i.label || '', type: i.type || 'normal', enabled: i.enabled !== false, checked: Boolean(i.checked), run: () => i.click?.({ checked: !i.checked }) }));
ipcMain.handle('chats:close-tabs', async (_e, id) => { aiClosingNote(curRec); const r =await aiTabsClose({ chatId: String(id) }); aiCloseNote(r.rec || curRec, r); return r; });
ipcMain.handle('tabs:undo-ai-close', (_e, token) => aiTabsReopen(Number(token)));
// The taskbar's command (Jump List task, Dock menu) and the menus' "Close tabs the AI opened": every normal window's AI tabs, each
// window's toast (counts, Undo) in the window that held them. It never raises or focuses a window (the click was on the taskbar).
// A private window has no AI tabs of this kind (it is in no window record). With none to close, a brief line shows in the
// window in front, and only if one is visible.
let closingAiEverywhere = false;
async function closeAiTabsEverywhere() {
  if (closingAiEverywhere || !uiReady) return { windows: 0, closed: 0, kept: 0 }; // (a second click while one runs, or Lumen still starting: nothing)
  closingAiEverywhere = true;
  try {
    const recs = [...new Set(aiTabSelect({}).map((x) => x.rec))];
    if (!recs.length) {
      const rec = focusedRec();
      if (rec && rcAlive(rec) && rec.win.isVisible() && !rec.win.isMinimized()) withWindow(rec, () => ui()?.send('tabs:organize-note', { text: t('taskbar.noAiTabs'), undo: false, ttl: 4000 }));
      return { windows: 0, closed: 0, kept: 0 };
    }
    let closed = 0;
    let kept = 0;
    for (const rec of recs) {
      aiClosingNote(rec);
      const r = await aiTabsClose({ rec }).catch(() => null);
      if (!r) continue;
      closed += r.closed;
      kept += r.kept;
      aiCloseNote(rec, r);
    }
    return { windows: recs.length, closed, kept };
  } finally {
    closingAiEverywhere = false;
  }
}
if (TEST) global.__manners = manners;
if (TEST) global.__taskbar = { closeAiTabs: closeAiTabsEverywhere, wants: taskbarTasks.wantsCloseAiTabs, secondInstance: (argv) => app.emit('second-instance', {}, argv) };
if (TEST) global.__aiTabs = { cycle: (d) => cycleTab(d), switchTo: (id) => switchTab(id), select: aiTabSelect, close: aiTabsClose, reopen: aiTabsReopen, tab: (id) => tabAnywhere(id)?.t, handOver: userTookOver, closedTabs: () => closedTabs.slice() };

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
  // (A page still on its first load has no address yet, wc.getURL() is empty until it commits: the address it was asked for stands in, or closing
  // Lumen while the front page loads dropped that tab, and the next start came up without it, or on another tab.)
  const urlOf = (t) => (alive(t) ? realUrl(t.view.webContents) || (t.view.webContents.isLoading() ? t.askedUrl || '' : '') : t.sleeping ? t.sleepUrl || '' : '');
  // What a tab keeps in the session: web pages, lumen://chat, and the file a file tab shows (a PDF or deck in its viewer is saved as the file's own
  // address: the viewer's moves with an update). Not research tabs: they would come back in the user's session.
  const savedOf = (t) => { const u = urlOf(t); return isWebUrl(u) || chatPage.isChatUrl(u) ? u : sessionFiles.savedUrl(u); };
  const saved = tabs.filter((t) => !t.isolated && savedOf(t));
  const urls = saved.map(savedOf);
  const titleOf = (t) => (alive(t) ? t.view.webContents.getTitle() : t.sleepTitle || '');
  return {
    urls,
    titles: saved.map(titleOf), // shown on the restored tabs, which don't load until they're opened
    favicons: saved.map((t) => t.favicon || null), // and their icons, so they aren't all globes
    active: Math.max(0, saved.findIndex((t) => t.id === activeId)),
    groupIds: saved.map((t) => t.groupId || null),
    pinned: saved.map((t) => Boolean(t.pinned)),
    aiKeepOff: saved.map((t) => manners.isKeptOff(t)), // [ai off-tab] stays with the tab across a restart
    aiOpened: saved.map((t) => manners.savedMark(t)), // [ai manners] a tab the AI opened and the user has not taken over stays the AI's across a restart ({ chatId, at })
    chats: chatBind.snapshot(saved.map((t) => t.id)), // [chat per tab] which chat each tab shows (not re-run after a restart); a chat shown in several tabs is in each
    chatHomes: chatBind.snapshotHomes(saved.map((t) => t.id)), // which of those tabs is the chat's home
    sidebars: sidebarTabs.snapshot(saved.map((t) => t.id), sidebarSharers), // [sidebar per tab] where the sidebar is open
    groups: tabGroups.snapshot(),
  };
}

// Every normal window is saved: the first one in the session's own fields (as before, so older
// versions still read it), the others under `more`. Private windows are never here.
function saveSession({ excluding = null, background = false } = {}) {
  const recs = [...winRecs].filter((r) => rcAlive(r) && r !== excluding && !isSpare(r) && !r.mergedAway && !r.agent); // [agent window] an agent's window is never restored. (a window merged into another is closing: its tabs are saved there)
  if (!recs.length || recs.some((r) => r.pendingRestore)) return; // nothing to save, or another window's tabs are still coming back
  const [first, ...more] = recs.map((r) => withWindow(r, sessionEntry));
  const session = { ...first, ...(more.length ? { more } : {}) };
  const current = readSettings();
  if (!sessionGate.shouldWrite(current.session, session, background)) return; // unchanged since the last write (background saves only)
  const next = { ...current, session };
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
  // [ai manners] After a crash or power cut (not a normal quit: those tabs stay marked, as tested) a run that was cut short left its tabs marked in the saved session: with Close they go now, the way they would have
  // when the run ended (not the tab in front, one marked keep, one a chat lives in).
  if (!entry && crashRecovery.crashed() && readSettings().closeAiTabs === 'always') setTimeout(() => { aiTabsClose({}, { auto: true }).catch(() => {}); }, 3000);
}

function restoreTabsFrom(saved) {
  if (!saved?.urls?.length) {
    openTab();
    return;
  }
  tabGroups.restore(saved.groups);
  if (saved.urls.some((u) => chatPage.isChatUrl(u))) chatPageUsedAt = Date.now(); // (the spare is made once start-up is over: firstTabLoaded)
  const active = Math.min(Math.max(0, saved.active || 0), saved.urls.length - 1);
  const live = require('./features/session-restore').liveIndices(saved.urls.length, active);
  let activeTabId = null;
  saved.urls.forEach((url, i) => {
    // Only the tab you were on loads now; the rest load when first opened (addRestoredTab).
    let tab;
    if (live.has(i)) {
      const opened = openTab(url, { background: true, managerPage: chatPage.isChatUrl(url) ? 'chat' : null });
      if (i === active) activeTabId = opened.id;
      tab = tabs.find((t) => t.id === opened.id);
    } else tab = addRestoredTab(url, saved.titles?.[i], saved.favicons?.[i]);
    const groupId = saved.groupIds?.[i];
    if (groupId && tabGroups.groups.has(groupId)) tab.groupId = groupId;
    else tab.userRemoved = true; // restore the session as it was: don't regroup tabs left loose
    if (saved.pinned?.[i] && !tab.groupId) tab.pinned = true;
    if (saved.aiKeepOff?.[i] === true) manners.keepOff(tab); // [ai off-tab]
    if (saved.aiOpened?.[i]) manners.restoreMark(tab, saved.aiOpened[i]); // [ai manners] (after pinned: a pinned tab is the user's)
    chatBind.restore([tab.id], [saved.chats?.[i]], (cid) => chats().list().some((c) => c.id === cid), [saved.chatHomes?.[i] === true]); // [chat per tab] (a chat saved in several tabs comes back in each)
    sidebarTabs.restore([tab.id], [saved.sidebars?.[i]]); // [sidebar per tab]
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
        normal({ label: t('menu.commandBar'), ...shown('Cmd+K'), click: openCommandBar }),
        normal({ label: t('menu.openFile'), ...shown('Cmd+O'), click: openFileDialog }),
        normal({ label: t('menu.findFiles'), ...shown('Cmd+Shift+F'), click: openFilesPicker }),
        normal({ label: t('menu.receiveFromPhone'), click: () => { openWifiUpload().catch(() => {}); } }), // [phone wifi]
        { label: t('menu.openLocation'), ...shown('Cmd+L'), click: pv('focusAddress', focusAddress) },
        { type: 'separator' },
        normal({ label: t('menu.savePageAs'), ...shown('Cmd+S'), click: () => { if (wc()) pageTools.savePage(wc()).catch(() => {}); } }),
        { label: t('menu.screenshot'), ...shown('Cmd+Shift+S'), click: pv('screenshot', () => takeScreenshot(wc())) },
        normal({ label: t('menu.record'), submenu: recordMenu(wc()) }), // [screen recording]
        normal({ label: t('menu.qrCode'), click: () => showQrCode(wc()) }),
        ...(phoneReady() ? [normal({ label: t('phone.send.menu'), click: () => sendPageToPhone(wc()) })] : []), // [phone files]
        { label: t('menu.print'), ...shown('Cmd+P'), click: pv('print', () => printTab(wc())) },
        { label: t('menu.printSystem'), ...shown('Shift+Cmd+P'), click: pv('printSystem', () => printSystem(wc())) },
        { type: 'separator' },
        { label: t('menu.closeTab'), ...shown('Cmd+W'), click: pv('closeTab', () => { if (activeId) requestCloseTab(activeId); }) },
        { label: t('menu.closeWindow'), ...shown('Shift+Cmd+W'), click: pv('closeWindow', closeCurrentWindow) },
      ],
    },
    { role: 'editMenu' },
    {
      label: t('menu.view'),
      submenu: [
        { label: t('menu.reload'), ...shown('Cmd+R'), click: pv('reload', () => reloadActive({ always: true })) },
        { label: t('menu.forceReload'), ...shown('Shift+Cmd+R'), click: pv('forceReload', () => reloadActive({ ignoreCache: true, always: true })) },
        { label: t('menu.find'), ...shown('Cmd+F'), click: pv('find', openFindBar) },
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
        normal({ label: t('menu.toggleSidebar'), ...shown('Cmd+J'), click: toggleSidebarFromKeys }),
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
    { label: t('menu.bookmarks'), submenu: [normal({ label: t('menu.bookmarkPage'), ...shown('Cmd+D'), click: toggleBookmark }), normal({ label: t('menu.bookmarkAllTabs'), ...shown('Shift+Cmd+D'), click: bookmarkAllTabs }), normal({ label: t('menu.showAllBookmarks'), ...shown('Shift+Cmd+O'), click: () => managers.open('bookmarks') }), normal({ label: t('menu.saveForLater'), ...shown('Shift+Cmd+Y'), click: () => saveForLater(tabs.find((x) => x.id === activeId)) }), normal({ label: t('menu.showReadingList'), click: () => managers.open('readinglist') })] },
    // Chrome's Tab menu. The menu bar is built once, so Pin and Mute (whose labels change) stay in the tab's own menu.
    {
      label: t('menu.tab'),
      submenu: [
        { label: t('menu.nextTab'), ...shown('Alt+Cmd+Right'), click: pv('nextTab', () => cycleTab(1)) },
        { label: t('menu.previousTab'), ...shown('Alt+Cmd+Left'), click: pv('previousTab', () => cycleTab(-1)) },
        { type: 'separator' },
        normal({ label: t('menu.newTabRight'), click: () => { if (activeId) newTabRightOf(activeId); } }),
        normal({ label: t('menu.duplicateTab'), click: () => { if (activeId) duplicateTab(activeId); } }),
        { type: 'separator' },
        normal({ label: t('menu.closeAiTabs'), click: () => { closeAiTabsEverywhere().catch(() => {}); } }),
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
    { role: 'help', submenu: [{ label: t('menu.keyboardShortcuts'), ...shown('Shift+Cmd+/'), click: () => shortcutsHelp.open() }, { label: t('menu.whatsNew'), click: () => whatsNew.open() }, { label: t('menu.reportIssue'), click: () => shell.openExternal(reportIssueUrl()) }, { label: t('menu.github'), click: () => shell.openExternal('https://github.com/emah-maker/lumen') }] },
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
    // (A page's own focus in an agent window is not the user arriving there: only the window's, a real OS focus, is.)
    // (Nor is the OS activating a window Lumen itself just made: on Windows showInactive / minimize can still hand it focus for a moment,
    // and the sidebar's next message, the shortcuts and "the active tab" would then be the agent window's.)
    const justMade = rec.agent && Date.now() - (rec.agent.madeAt || 0) < 4000;
    if (args[0] === 'focus' && !(rec.agent && emitter !== rec.win) && !justMade) enterWindow(rec);
    return args[0] === 'focus' && curRec === rec ? emit(...args) : withWindow(rec, () => emit(...args));
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
// A clicked notification: that tab's window forward, and the tab in front.
function showTab(rec, id) {
  const w = rec === curRec ? win : rec.win;
  if (!w || w.isDestroyed()) return false;
  raiseWindow(w);
  withWindow(rec, () => switchTab(id));
  return true;
}

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
  if (tab.split) splitLayout.unlink(tabs, tab.id); // [split view] a tab moved to another window leaves its pair
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
  if (!keepFlags) manners.handOver(tab); // [ai manners] a tab the user moved to another window is theirs (merging all windows is no choice about this one tab, so a merge keeps the mark)
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
const windowMerge = lazy(() => require('./browser/window-merge'));
let mergeUndo = null; // { dstId, entries, at }: what the toast's Undo puts back, for as long as that toast is up (windowMerge.undoValid)
let mergePending = false; // a merge waiting for an organize to stop
const MERGE_ACCELERATOR = 'CmdOrCtrl+Shift+M'; // handled in handleShortcut (so it works without a menu bar); the menus only show it

// Each normal window as plain data, for the planner. Tabs whose page is neither running nor asleep (restored but
// not loaded yet) go along when they have an address (windowMerge.describeTab).
function describeWindows() {
  return [...winRecs].filter((r) => rcAlive(r) && !isSpare(r) && !r.agent).map((rec) => withWindow(rec, () => ({ // (an agent's window never takes part in a merge)
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
// With hideDisabled (the tab's right-click menu) both rows are left out instead: two dead rows there are noise, and the ⋯ menu keeps the explanation.
function mergeWindowItems(src, { hideDisabled = false } = {}) {
  if (!src || !rcAlive(src)) return [];
  const windows = describeWindows();
  const a = windowMerge.availability(windows, src.win.id);
  if (hideDisabled && !a.enabled) return [];
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
const tabDragMath = lazy(() => require('./features/tab-drag-math'));
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
    return { hidden: document.visibilityState === 'hidden' || document.body.classList.contains('side-layout'), bottom: strip.bottom, left: strip.left, right: strip.right, overflows: el.scrollWidth > el.clientWidth + 1, tabs, slot: s ? { x: s.left, y: s.top, h: s.height } : null };
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
  dragCardReaper.touch();
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
  dragCardReaper.cancel();
  if (dragCard && !dragCard.win.isDestroyed()) dragCard.win.destroy();
  dragCard = null;
}
// The card's window is a renderer of its own (~50 MB): made when a tab drag first needs it, closed again once no drag
// has used it for two minutes (the next drag makes it again, ahead of the card being shown).
const dragCardReaper = require('./features/idle-reaper').createIdleReaper({ ms: 2 * 60e3, busy: () => Boolean(tabDrag), onIdle: () => closeDragCard() });
const cardCall = (fn, ...args) => {
  if (!dragCard || dragCard.win.isDestroyed()) return;
  dragCard.win.webContents.executeJavaScript(`window.lumenCard && window.lumenCard.${fn}(...${JSON.stringify(args)})`).catch(() => {});
};
// Resolves once the page's snapshot has been taken (or couldn't be): the tab's window may show another tab after that.
// The page snapshot for the card, taken when a tab is first pulled towards the edge ('tab:dragprep'), so
// the card shows the page from its first frame instead of an empty panel that fills in a moment later.
let prepShot = null; // { tabId, src, at }
function snapshotFor(tab) {
  if (!alive(tab) || gpuHealth?.calmActive() || graphicsMode.software()) return Promise.resolve(null); // ([gpu health] no capture while the GPU recovers; [software mode] a capture is a CPU readback)
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
// The scheduler runs its jobs slowly while no window can be seen (all hidden or minimised), the screen is locked, or the machine sleeps.
function refreshSchedulerVisibility() {
  if (TEST) return;
  const seen = [...winRecs].some((r) => rcAlive(r) && !isSpare(r) && r.win.isVisible() && !r.win.isMinimized());
  if (seen) scheduler.resume('hidden'); else scheduler.pause('hidden');
}
function wireSchedulerPower() {
  const pm = require('electron').powerMonitor;
  pm.on('lock-screen', () => scheduler.pause('locked'));
  pm.on('unlock-screen', () => scheduler.resume('locked'));
  pm.on('suspend', () => scheduler.pause('suspended'));
  pm.on('resume', () => { scheduler.resume('suspended'); scheduler.resume('locked'); });
  // Waking from sleep: the network takes a few seconds to come back, then every card that failed meanwhile asks again.
  const widgetsBack = () => setTimeout(() => {
    resetNetwork().then(() => widgets.retryNow()).catch(() => {});
  }, 4000).unref?.();
  pm.on('resume', widgetsBack);
  pm.on('unlock-screen', widgetsBack);
}

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
  if (ids.length === 1 && !d.group && dropIntoSplit(src, d.tabId, cursorPoint(), d.origActive)) { wakeDeferredAside(d); hideDragCard(d, 'drop'); settled(); return; } // [split view] dropped on the page's right edge: it opens beside the tab in front
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
    setBoundsSettled(rec.win, { x: at.x, y: at.y, width: d.size.width, height: d.size.height }); // one call, checked: no size drift on mixed-DPI setups
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
// setBounds with the size checked. Windows converts a size with the scale of the display the window is on now, not the one it moves to,
// so a window that crosses to a display with another scale (a spare made on one screen, torn off onto the next) comes out the wrong
// size (a 1000x700 window as 667x467, then lifted to its minimum). Once it sits on the target display, the same call is exact.
function setBoundsSettled(win, b) {
  for (let i = 0; i < 3 && !win.isDestroyed(); i++) {
    win.setBounds(b);
    const got = win.getBounds();
    if (Math.abs(got.width - b.width) <= 2 && Math.abs(got.height - b.height) <= 2) return;
  }
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
      agent: rec.agent ? rec.agent.label : null,
      focused: rec.win.isFocused(),
      title: rec.win.getTitle(),
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
    tabMenu: (windowId, tabId) => withWindow([...winRecs].find((r) => rcAlive(r) && r.win.id === windowId), () => flatMenu(tabMenuTemplate(tabId)).filter((r) => r.item.label).map(({ item: i, depth }) => ({ label: i.label, depth, enabled: i.enabled !== false, sub: (i.submenu || []).map((s) => s.label) }))),
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
firstTabLoaded.then(() => { firstTabDone = true; if (chatPageUsedAt) spareChatSoon(); }); // (a session with a chat page in it: its next one is made now start-up is over)
firstTabLoaded.then(() => probeRecordMp4()); // [screen recording] is MP4 offered?
firstTabLoaded.then(() => schedulePreload(2500)); // background preload of likely next tabs (waking tabs faster, above)
// Opened once extensions and the ad blocker are ready at start-up: until then windows load, but get no tabs.
let openTabsGate = () => {};
let tabsGateOpen = false; // (read by lateExtension)
const GUESS_TOOLBAR_HEIGHT = 82; // the tab strip and toolbar: where a first tab's page goes before the UI has said (content-bounds)
const tabsGate = new Promise((resolve) => { openTabsGate = () => { tabsGateOpen = true; resolve(); }; });
// `agent` ({ label }): the window of an outside agent's session (openAgentWindow below): shown without taking focus, one blank tab,
// never saved with the session.
// [agent window] The steps of making an agent's window (5-6 ms of the main process each) run one to a turn of their own, and not while a screenshot is being
// taken (its result lands as a ~9 ms task: the two stacked into 15 ms stalls that other sessions' calls waited behind, test/mcp-perf.js).
const agentQuiet = () => require('./features/tab-capture').whenCaptureIdle().then(() => new Promise((resolve) => setImmediate(resolve)));
const agentStep = (fn, owner) => { agentQuiet().then(() => { if (!owner.isDestroyed()) fn(); }).catch(() => {}); };
function createWindow({ size = null, position = null, adopt = null, restore = null, hidden = false, prepared = false, boundsFrom = null, agent: agentOf = null } = {}) {
  if (TEST_BACKGROUND) app.dock?.hide();
  const firstWindow = winRecs.size === 0;
  const w = new BrowserWindow({
    ...(TEST_BACKGROUND || hidden || agentOf ? { show: false } : {}), // hidden: the caller shows it (a window being dragged)
    width: size?.width || 1440,
    height: size?.height || 920,
    ...(position || {}),
    minWidth: 800,
    minHeight: 500,
    title: agentOf ? agentWindowTitle(agentOf.label) : 'Lumen',
    ...(agentOf ? {} : { icon: WINDOW_ICON }), // (an agent's window: no icon to decode, ~50 ms of the main process; the taskbar shows the app's own)
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f5f5f7',
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay() }),
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'preload.bundle.js'), // preload.js with the toolbar element inlined (scripts/build/bundle-preload.js)
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: TEST ? [require('./test-mode').PRELOAD_FLAG] : [], // preload.js's test-only calls
    },
  });
  const seedBounds = rcAlive(boundsFrom) && winRecs.has(boundsFrom) ? withWindow(boundsFrom, () => ({ ...contentBounds })) : null;
  const rec = { win: w, prepared, preparedReady: false, tabs: [], activeId: null, contentBounds: seedBounds || { x: 0, y: 0, width: 800, height: 600 }, viewFrozen: false, chatFullTab: null, uiReady: false, suggestView: null, downloadsView: null, downloadsAnchor: null, groups: new Map(), pendingRestore: Boolean(restore), agent: agentOf ? { label: agentOf.label, used: false, madeAt: Date.now() } : null };
  winRecs.add(rec);
  try { w.contentView.setBackgroundColor(windowBackground()); } catch { /* an older shell */ } // (what shows where no view has drawn yet: the UI's colour, not black)
  enterWindow(rec); // from here on `win`, `tabs` ... are this window's
  bindContext(w, () => rec);
  bindContext(w.webContents, () => rec);
  uiContents.add(w.webContents);
  // Invisible and click-through, but shown (so it paints and screenshots work); macOS keeps part of
  // any window on screen, so moving it away is not enough.
  const showWindow = () => {
    if (TEST_BACKGROUND) { w.setOpacity(0); w.setIgnoreMouseEvents(true); w.setPosition(-5000, -5000); w.showInactive(); }
    else if (agentOf) showBehind(w); // [agent window] on screen (so it paints) but never in front of what the user is doing
  };
  if (!agentOf) showWindow(); // (an agent's window is shown, and its UI loaded, in turns of their own: see the end)
  if (agentOf) w.on('page-title-updated', (e) => e.preventDefault()); // (its title says whose window it is)
  // The taskbar button's icon: Lumen.exe's own is Electron's (see features/instance.js appIcon).
  if (process.platform === 'win32' && app.isPackaged && instance.isInstalledExe()) {
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
  // The mouse's back / forward buttons and a keyboard's browser keys (Windows, Linux: 'app-command'), and macOS's
  // two-finger swipe, move through the page's history, as in Chrome. Only for the window the event came from.
  const navigateFrom = (action) => {
    if (action !== 'back' && action !== 'forward' && action !== 'reload' && action !== 'stop') return;
    if (curRec?.win !== w) return;
    const wc = activeTab()?.webContents;
    if (!wc || wc.isDestroyed()) return;
    userTookOver(tabs.find((x) => x.id === activeId)); // [ai manners] the user navigated this tab
    if (action === 'back') goBack(wc);
    else if (action === 'forward') wc.navigationHistory.goForward();
    else if (action === 'reload') reloadActive({ always: true });
    else wc.stop();
  };
  w.on('app-command', (event, command) => { const action = appCommandAction(command); if (action) { event.preventDefault(); navigateFrom(action); } });
  // Right-click in one of the UI's own text fields (Find, the sidebar's message box; the address bar has its own, 'address:menu'):
  // Cut / Copy / Paste / Select All. Without this the window popped nothing.
  w.webContents.on('context-menu', (_e, p) => {
    if (!p.isEditable || w.isDestroyed()) return;
    const flags = p.editFlags || {};
    Menu.buildFromTemplate(editMenu.editMenuTemplate({ cut: flags.canCut, copy: flags.canCopy, paste: flags.canPaste })).popup({ window: w });
  });
  w.on('swipe', (_e, direction) => { if (direction === 'left') navigateFrom('back'); else if (direction === 'right') navigateFrom('forward'); });
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
  for (const ev of ['minimize', 'restore', 'show', 'hide']) w.on(ev, refreshSchedulerVisibility);
  for (const ev of ['restore', 'show']) w.on(ev, () => withWindow(rec, () => pokePdf(tabs.find((t) => t.id === activeId)))); // (a restored window: the PDF in front draws again)
  w.on('close', () => {
    if (quitting) return;
    const several = [...winRecs].filter((r) => rcAlive(r) && !isSpare(r) && !r.agent).length > 1;
    if (several && !rec.agent && !isSpare(rec) && !rec.mergedAway && !rec.pendingRestore) { // kept for Reopen Closed Window (Ctrl+Shift+T)
      const entry = withWindow(rec, sessionEntry);
      if (entry.urls.length) { closedWindows.push({ entry, rec, after: closedTabs.length }); if (closedWindows.length > 10) closedWindows.shift(); }
    }
    saveSession({ excluding: several ? rec : null });
  });
  // The window is gone (on macOS the app can keep running): the session was just saved, so end
  // the tab pages too, or a video or call kept playing with no window to stop it.
  w.on('closed', () => {
    uiReady = false;
    clearTimeout(freezeTimers.get(rec)); // no freeze timer outlives its window
    freezeTimers.delete(rec);
    // The window's own dropdown and downloads views: closing a window leaves their pages (a renderer process each) running.
    for (const v of [rec === curRec ? suggestView : rec.suggestView, rec === curRec ? downloadsView : rec.downloadsView]) { try { if (v && !v.webContents.isDestroyed()) v.webContents.close(); } catch { /* gone */ } }
    if (rec === curRec) { suggestView = null; downloadsView = null; }
    rec.suggestView = null; rec.downloadsView = null; // (closedWindows keeps rec for Reopen Closed Window: not the dead views)
    dropDeadWindowViews();
    winRecs.delete(rec);
    const kept = closedWindows.find((c) => c.rec === rec);
    if (kept) kept.after = closedTabs.length; // (its own tabs closing with it are not "closed after" it)
    if (rec === spareRec) spareRec = null;
    if (![...winRecs].some((r) => rcAlive(r) && !isSpare(r))) { closeSpare(); closeDragCard(); } // no windows left to tear a tab off
    const next = [...winRecs].find((r) => rcAlive(r) && !isSpare(r) && !r.agent) || [...winRecs].find((r) => rcAlive(r) && !isSpare(r));
    if (next) enterWindow(next);
    // [agent window] The user's last window closed: an agent's window does not keep Lumen running on its own.
    if (![...winRecs].some((r) => rcAlive(r) && !isSpare(r) && !r.agent)) for (const r of [...winRecs]) if (r.agent && rcAlive(r)) r.win.close();
    refreshWindowMenu(); // a window closed
  });
  // The browser UI's own page crashed: reload it and send it the tabs again, instead of leaving a
  // dead window. The tabs themselves live in their own processes and are unaffected. Capped like the chat page.
  let uiCrashes = [];
  let uiCrashAsked = false;
  w.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || !ui()) return;
    const burst = crashBurst(uiCrashes, Date.now());
    uiCrashes = burst.times;
    if (burst.reload) {
      console.error(`[lumen] browser UI process gone (${details.reason}); reloading it`);
      logMainError('browser-ui-process-gone', `${details.reason}, exit ${details.exitCode ?? '?'}; reloading it`);
      ui().reload();
      return;
    }
    // Three crashes in a minute: it crashes as it loads, so reloading again would only loop. Stop and offer a restart instead.
    console.error(`[lumen] browser UI process gone (${details.reason}) ${burst.times.length} times in a minute; not reloading it again`);
    logMainError('browser-ui-process-gone', `${details.reason}, exit ${details.exitCode ?? '?'}; ${burst.times.length} times in a minute, not reloading it again`);
    if (uiCrashAsked) return;
    uiCrashAsked = true;
    dialogs.showMessageBox(win, {
      type: 'error', buttons: [t('uiCrash.restart'), t('uiCrash.safe'), t('uiCrash.later')], defaultId: 0, cancelId: 2,
      message: t('uiCrash.title'),
      detail: t('uiCrash.detail'),
    }).then(({ response, cancelled }) => {
      uiCrashAsked = false;
      if (cancelled || response > 1) return;
      if (TEST) { global.__uiCrashRestarts = (global.__uiCrashRestarts || 0) + 1; global.__uiCrashRestartSafe = response === 1; return; }
      relaunchLumen(response === 1);
    }).catch(() => { uiCrashAsked = false; });
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
    if (rec.agent) w.webContents.send('agent-window', { label: rec.agent.label });
    rec.splitKey = ''; // ([split view] the fresh page has no divider)
    tabStripGate.forget(rec); // (the fresh page has no strip: the next send goes out even if the state is what the old page had)
    sendTabs(); // a reload after a crash: bring the fresh UI up to date
    followFront({ push: false }); // [chat per tab] this window's tab's chat
    const items = agent.transcript();
    if (ui()) shownChat.set(ui(), chatId);
    if (items.length) ui()?.send('agent:history', { items });
  });
  w.webContents.on('focus', () => { rec.keyboardOwner = w.webContents; }); // (see keepKeyboardFromBackgroundTab)
  w.on('focus', () => { ui()?.send('window-focus', true); if (uiReady) hang.mark('focus:followFront', followFront); hang.mark('focus:a11y', () => a11yMode?.onFocus()); }); // [chat per tab] the sidebar shows the chat of the tab in front here
  w.on('blur', () => ui()?.send('window-focus', false));
  // Full screen (F11 / the View menu) has no window controls to clear: the strip drops its caption reserve (renderer: body.window-fullscreen). The first time, the toast says how to leave.
  w.on('enter-full-screen', () => { ui()?.send('window-fullscreen', true); if (process.platform !== 'darwin' && !fullScreenHinted) { fullScreenHinted = true; toast(t('fullscreen.exitHint')); } });
  w.on('leave-full-screen', () => ui()?.send('window-fullscreen', false));
  w.on('resize', () => { hideSuggestions(); hideDownloadsPanel(); dialogs.layout(); if (tabs.some((t) => t.fullscreen)) layout(); });
  w.on('blur', hideSuggestions);
  // [agent window] Making the window (~5 ms), showing it (~2-5 ms) and starting its UI's load (~3 ms) are each a turn of their own: in one they
  // were a 12 ms stall of the main process, which other sessions' calls were then waiting behind (test/mcp-perf.js).
  if (agentOf) agentStep(() => { showWindow(); agentStep(() => { w.loadFile(UI_HTML).catch(() => {}); }, w); }, w);
  else w.loadFile(UI_HTML);
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
    Promise.all([tabsGate, committed]).then(() => { if (!rec.agent) { if (rcAlive(rec)) withWindow(rec, openFirstTabs); } else agentStep(() => { if (rcAlive(rec)) withWindow(rec, openFirstTabs); }, w); });
  }
  w.webContents.once('did-finish-load', () => {
    uiLoaded = true;
    rec.uiLoaded = true;
    rec.splitKey = ''; // ([split view] the fresh page has no divider)
    tabStripGate.forget(rec); // (tabs restored while this page was still loading were sent to nowhere: the strip must still get its first state, even if it is the one the gate last recorded)
    if (rec.agent) w.webContents.send('agent-window', { label: rec.agent.label }); // the badge that says whose window this is
    firstTabLoaded.then(() => { if (rcAlive(rec) && !rec.win.isDestroyed() && !rec.agent) withWindow(rec, () => { if (!suggestView) createSuggestView(); }); }); // (an agent's window never has an address bar typed in: its dropdown's renderer, ~110 MB, is made only if the user takes the window: address:touched)
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
    if (rec.agent) openTab('about:blank'); else restoreSession(restore); // [agent window] one blank tab; the agent opens the rest
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
      // (with the chat's id: the sidebar must know which chat it shows, or its draft and what it keeps per chat go under no chat)
      if (items.length) ui()?.send('agent:history', { items, chatId });
      else if (ui()) pushChatView(ui());
    }
    uiReady = true;
    perf.mark('uiReady');
    downloads.send(); // last session's downloads: the toolbar button shows when there are any
    openLinksFromOtherApps(pendingLinks.splice(0));
    // After an update, the release notes come up once, a moment after the restored tabs (only the
    // first normal window asks; whatsNew.check runs once per launch).
    if (firstWindow) setTimeout(() => {
      if (w.isDestroyed()) return;
      featureOffers.prepare(); // before the notes record the version: it tells an update from a fresh install
      whatsNew.check().catch((err) => console.error('[lumen] what\'s new:', err.message))
        .catch((err) => console.error('[lumen] feature offers:', err.message));
    }, 1200);
    // A fresh install opens the sidebar on its welcome (connect an AI, bring bookmarks, default browser).
    if (firstWindow && !TEST && setup.welcomePending()) ui()?.send('setup:welcome');
    if (firstWindow && !TEST) seedFirstRunWidgets(); // a new profile's new-tab page starts with the Files card (an existing profile's page is left as it is)
    if (firstWindow && crashRecovery.pending()) setTimeout(() => { offerCrashRestore().catch((err) => console.error('[lumen] crash recovery:', err.message)); }, 600); // the last run crashed and the startup setting wouldn't bring its tabs back
    if (firstWindow) setTimeout(() => setup.isDefault().catch(() => {}), 2000).unref?.(); // (for the app menu's item)
  }
  return rec;
}
// ---------- agent windows: an outside agent (MCP) gets a window of its own (features/agent-windows.js) ----------
// Made on a session's first call that needs a tab, shown without taking focus or coming in front of the window the user is in,
// and the only place that session's tools act: they never see the user's tabs or the tabs the sidebar's AI works in. It is
// never saved with the session, never merged, and its tabs are not "AI tabs" (nothing in it is the user's to hide or close).
// It closes a little after the session ends, unless the user used it or pinned a tab in it: then it is theirs, an ordinary window.
const { createAgentWindows } = require('./features/agent-windows');
const handsOff = require('./features/agent-hands-off');
const windowOrder = require('./features/window-order');
const agentWindowTitle = (label) => `${label} · Lumen`;
function showBehind(w) {
  const front = BrowserWindow.getFocusedWindow();
  w.showInactive();
  try {
    // The user is in a Lumen window: it goes back on top of this one (stacking only, focus is untouched). Otherwise they are in
    // another app, and this window waits in the taskbar instead of covering it. (moveTop, not moveAbove: on Windows moveAbove
    // is SetWindowPos with the other window as the one to insert after, which put the user's window *below* the new one, and a
    // new window the size of theirs covered it whole, with nothing left to click.) A beat later it is done again: a window shown
    // while another is being activated can land back on top once its first paint arrives.
    const toFront = () => { if (!front.isDestroyed() && !w.isDestroyed() && windowOrder.behindPlan({ front, self: w }) === 'raise-front' && front.isFocused()) front.moveTop(); };
    if (windowOrder.behindPlan({ front, self: w }) === 'raise-front') { front.moveTop(); setTimeout(toFront, 250).unref?.(); }
    else w.minimize();
  } catch {}
}
const agentRecReady = (rec) => rcAlive(rec) && rec.uiLoaded && !rec.holdViews && tabsOf(rec).some((x) => alive(x) || x.sleeping);
async function openAgentWindow(label) {
  const previous = curRec;
  const src = [focusedRec(), previous].find((r) => r && rcAlive(r) && winRecs.has(r) && !isSpare(r) && !r.agent) || null;
  const opts = { agent: { label } };
  if (src) {
    const b = src.win.isMaximized() ? src.win.getNormalBounds() : src.win.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const fit = tabDragMath.fitToDisplay({ width: b.width, height: b.height }, area);
    const at = tabDragMath.placeOnWorkArea({ ...cascadedWindowPoint(src.win), width: fit.width, height: fit.height }, area);
    Object.assign(opts, { size: { width: at.width, height: at.height }, position: { x: at.x, y: at.y }, boundsFrom: src });
  }
  await agentQuiet();
  const rec = createWindow(opts);
  if (previous && previous !== rec && winRecs.has(previous)) enterWindow(previous); // creating a window makes it current: the user's stays
  const until = Date.now() + 20000;
  while (!agentRecReady(rec)) {
    if (!rcAlive(rec) || Date.now() > until) { try { rec.win.close(); } catch {} throw new Error('Lumen could not open a window for this agent.'); }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return rec;
}
// The user kept an agent's window (they used it, or pinned a tab in it): from now on it is an ordinary window.
function keepAgentWindow(rec) {
  if (!rec.agent) return;
  rec.agent = null;
  if (!rcAlive(rec)) return;
  rec.win.setTitle('Lumen');
  rec.win.webContents.send('agent-window', null);
  for (const x of tabsOf(rec)) if (alive(x)) agentContents.delete(x.view.webContents); // its pages may ask the user things now
}
const agentWindows = createAgentWindows({
  open: (label) => openAgentWindow(label),
  alive: (rec) => rcAlive(rec) && winRecs.has(rec),
  close: (rec) => { if (rcAlive(rec)) rec.win.close(); },
  keep: keepAgentWindow,
  userUsed: (rec) => Boolean(rec.agent?.used),
  hasPinned: (rec) => tabsOf(rec).some((x) => x.pinned),
  ...(TEST && Number(process.env.LUMEN_AGENT_WINDOW_GRACE_MS) > 0 ? { graceMs: Number(process.env.LUMEN_AGENT_WINDOW_GRACE_MS) } : {}),
});
if (TEST) global.__agentWindows = { windows: agentWindows, recOf: (id) => [...winRecs].find((r) => r.win.id === id), count: () => [...winRecs].filter((r) => r.agent && rcAlive(r)).length };
// [agent window] A tab an agent opened and has not used for a while is unloaded (its page closes; agentTabById wakes it, reloading it, on the
// agent's next call that names it). One session working in several tabs (tab_id) otherwise kept every page it ever opened live, a renderer
// process each (~225 MB for a heavy page). Never the window's front tab, a tab a call is working in, one that is loading or playing audio,
// or a window the user has used.
let AGENT_TAB_IDLE_MS = TEST && Number(process.env.LUMEN_AGENT_TAB_IDLE_MS) > 0 ? Number(process.env.LUMEN_AGENT_TAB_IDLE_MS) : 3 * 60 * 1000;
function sweepAgentTabs() {
  const now = Date.now();
  for (const rec of [...winRecs]) {
    if (!rec.agent || rec.agent.used || !rcAlive(rec)) continue;
    withWindow(rec, () => {
      let freed = false;
      for (const tab of tabs) {
        if (!alive(tab) || tab.sleeping || tab.frozen || tab.placeholder || tab.pinned || tab.id === activeId) continue;
        tab.agentUsedAt ||= now;
        if (now - tab.agentUsedAt < AGENT_TAB_IDLE_MS || agent.usingTab(tab.id)) continue;
        const wc = tab.view.webContents;
        if (wc.isLoading() || wc.isCurrentlyAudible() || agentOffLimits(tab)) continue;
        sleepTab(tab);
        freed = true;
      }
      if (freed) sendTabs();
    });
  }
}
scheduler.every('agent-tabs', TEST && process.env.LUMEN_AGENT_TAB_IDLE_MS ? 1000 : 30 * 1000, () => { if ([...winRecs].some((r) => r.agent)) sweepAgentTabs(); });
if (TEST) global.__agentTabs = { sweep: sweepAgentTabs, setIdleMs: (ms) => { AGENT_TAB_IDLE_MS = ms; }, state: () => [...winRecs].filter((r) => r.agent && rcAlive(r)).map((r) => tabsOf(r).map((t) => ({ id: t.id, sleeping: Boolean(t.sleeping), active: t.id === r.activeId }))) };
let quitting = false; // the app is shutting down: the session was saved by before-quit
app.on('before-quit', () => {
  if ([...winRecs].some(rcAlive)) saveSession();
  crashRecovery.end(); // a normal quit: the next start offers nothing
  if (settingsPending && settingsCache) writeSettingsNow(settingsCache); // (a change still on its way to disk lands now)
  if (historyDirty && historyLoaded) { // (visits from the last two seconds land now, once the past is merged in)
    clearTimeout(historySaveTimer);
    historyDirty = false;
    historyGen++; // (an async write still queued or in flight now skips its rename)
    try { settingsFile.writeJsonAtomic(HISTORY_FILE(), historyList(), 0); } catch { /* disk full or locked: the older file stays */ }
  }
  downloads.flush(); // (the lists that save a moment after a change land now)
  usage.flush();
  quitting = true;
  emlViewer.cleanTemp(); // (the copies of email attachments opened in tabs)
});
const quitGuard = lazy(() => require('./features/quit-guard').createQuitGuard({ exit: (code) => app.exit(code) })); // (loaded when quitting starts)
let uiReady = false; // the window's UI has loaded and its tabs are open
// The title bar buttons follow the theme (one listener for the app, not one per window reopened).
nativeTheme.on('updated', () => {
  for (const rec of winRecs) if (rcAlive(rec)) withWindow(rec, () => paintBackgrounds(rec)); // (the not-yet-painted area matches the page in the new theme)
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
const OPENABLE = ['html', 'htm', 'xhtml', 'shtml', 'mhtml', 'svg', 'pdf', 'pptx', 'eml', 'txt', 'md', 'json', 'xml', 'csv', 'log', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'mp4', 'webm', 'mov', 'mp3', 'wav', 'ogg', 'm4a', 'flac'];
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
// [agent window] An outside agent's calls (agent.inTask meta `mcp`) run in that agent's own window (ai-agents.js mcpCallTool): a chat page's
// run, the sidebar's chat and the user's tabs are none of their business.
const mcpCall = () => Boolean(agent.currentScope()?.mcp);
// [working-on chip] A chat-page run has no tab until its tools actually need one: then it takes the tab the user last looked at
// (chatPageRt.pick) and keeps it for the rest of the reply. Asking for the active tab outside a task (the first look at the
// request, the /btw card) names that tab without taking it, so nothing is marked "working on" or shows the AI's dot for it.
// [parallel chats] Is the calling run the chat page's own? Only then do its tab choices go to the page's "working on" tab: another
// chat's run (a sidebar chat working at the same time) keeps its own tabs. Outside a task (the page's first look) it is the page's.
function pageRunHere() {
  if (!chatPageRt?.runFromPage()) return false;
  const scope = agent.currentScope();
  if (!scope) return true;
  const page = chatPageRt.runs.get();
  return Boolean(scope.chat) && chatRuns.get(page?.chatId)?.messages === scope.chat;
}
const agentActiveTab = () => {
  const fromPage = !mcpCall() && pageRunHere();
  const pinned = fromPage ? chatPageRt.runTarget() : null;
  if (pinned != null) return agentTabById(pinned);
  if (fromPage) {
    const cand = chatPageRt.pick();
    const t = cand == null ? null : agentTabById(cand);
    if (t && agent.currentScope()) { agent.pinTab(t.id); chatPageRt.retarget(t.id); refreshTabMarks(); }
    return t;
  }
  const t = activeTab();
  return t && agentOffLimits(tabs.find((x) => x.id === t.id)) ? null : t;
};
// ...and its tabs open and switch out of sight, so the user stays on the chat page.
// [chat per tab] ...and so do a chat's tabs when the user is looking at another tab than the one it works in.
// [ai manners] The tab the AI's tool opens stays behind the user's: it comes to the front only when the tool asked for it
// ({ show: true }) and the user is looking at the run's own tab. Opening one never moves the omnibox caret or a field's focus.
// `ai`: the AI is opening it for its work (marked openedBy the run, so it can be closed again and, in hands-off mode,
// worked in); Undo reopening a tab it closed is not that.
// [ai manners] Settings → AI → "Never switch away from my tab": open_tab / switch_tab with show:true still work, behind the user's tab.
const stayOnUsersTab = () => readSettings().aiStayOnMyTab === true;
// [ai manners] the run's latest user message asked to see or go to a tab (manners.showsTab): only then may its open_tab / switch_tab come to the front
const userAskedToSee = () => { try { const m = agent.currentScope()?.chat; for (let i = (m?.length || 0) - 1; i >= 0; i--) { const x = m[i]; if (x?.role !== 'user') continue; const text = typeof x.content === 'string' ? x.content : Array.isArray(x.content) ? x.content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ') : ''; if (!text.trim()) continue; return manners.userAskedToSee(text); } } catch { /* no run */ } return false; };
const runOwnTabId = () => { const s = agent.currentScope(); return s?.chat ? (s.tabId ?? activeId) : activeId; };
const runOf = (scope = agent.currentScope()) => ({ chatId: scope?.chatId ?? null, runId: scope?.runId ?? null });
const agentOpenTab = (url, opts = {}) => {
  const { ai = false, show: wantShow = false, keep = false, ...rest } = opts || {};
  const mcp = mcpCall();
  const fromPage = !mcp && !agent.currentScope()?.helper && chatPageRt?.runTarget() != null && pageRunHere(); // ([acting helpers] a helper's tab never becomes the chat page's target; [parallel chats] nor another chat's)
  // Only the AI's own tool call (`ai`, or an explicit `show`) is held to the manners; any other caller (a window
  // opening a tab, the test hooks) gets a plain openTab: in front unless it asked for the background.
  const governed = ai || (opts && 'show' in opts);
  // (An outside agent's tab opens in front of ITS OWN window, which is nobody else's.)
  const show = mcp || (!fromPage && (governed ? manners.showsTab({ show: wantShow === true && !stayOnUsersTab(), asked: userAskedToSee(), runTabId: runOwnTabId(), activeId }) : !rest.background));
  const open = () => openTab(url, { ...rest, background: !show, ...(ai && !mcp ? { openedBy: { ...runOf(), keep: keep === true } } : {}) }); // (keep: left open when the run ends)
  const tab = governed && !mcp && agent.currentScope() ? asAiSwitch(open) : open(); // (the AI's tool call: its own switch, below)
  if (fromPage) chatPageRt.retarget(tab.id);
  else if (show && !mcp) bindRunChatTo(tab.id);
  return tab;
};
const agentSwitchTab = (id, opts = {}) => {
  if (mcpCall()) { const t = tabs.find((x) => x.id === id); return Boolean(t && !agentOffLimits(t) && switchTab(id)); } // (its own window's tab: really in front there)
  const fromPage = chatPageRt?.runTarget() != null && pageRunHere(); // ([parallel chats] the page's own run only)
  if (!fromPage && (opts && 'show' in opts ? manners.showsTab({ show: opts.show === true && !stayOnUsersTab(), asked: userAskedToSee(), runTabId: runOwnTabId(), activeId }) : true)) { // (no `show`: a plain switch, not the AI's tool)
    const aiCall = Boolean(opts && 'show' in opts && agent.currentScope()); // only a run's switch_tab passes `show`
    const ok = aiCall ? asAiSwitch(() => switchTab(id)) : switchTab(id);
    if (ok && aiCall) bindRunChatTo(id);
    return ok;
  }
  const t = tabs.find((x) => x.id === id);
  if (!t || agentOffLimits(t)) return false;
  if (isAsleep(t)) wakeTab(t); // (the run is about to use it)
  if (fromPage) chatPageRt.retarget(id);
  return true;
};
// Is this tab the front tab of ITS window (which may not be the focused one), and that window not minimized?
const agentTabInFront = (id) => {
  for (const rec of winRecs) {
    if (!rcAlive(rec) || !tabsOf(rec).some((x) => x.id === id)) continue;
    return manners.tabInFront({ activeId: activeIdOf(rec), tabId: id, minimized: rec.win.isMinimized() });
  }
  return false;
};
// Why there's no page to work on while one of those is in front (instead of "No tab is open").
const noTabReason = () => {
  const t = tabs.find((x) => x.id === activeId);
  if (!agentOffLimits(t)) return null;
  const name = t.settings ? 'Lumen Settings' : `Lumen's ${{ bookmarks: 'Bookmarks', readinglist: 'Reading list', chat: 'chat', tasks: 'AI activity' }[managerPageOf(t.view.webContents.getURL())] || 'Downloads'} page`;
  return `The active tab is ${name}, which the assistant cannot read or control. Use switch_tab or open_tab to work on a web page.`;
};
// A task's pinned tab (agent.js taskScope), looked up by id: never the settings tab; a sleeping one
// is woken, since the agent is about to use it.
const agentTabById = (id) => {
  // A tab moved to another window while a task works in it is still that task's tab, not a closed one.
  // [agent window] ...but never across the line around an outside agent's window: its calls reach only its own tabs, and nothing
  // else's reach into it (the sidebar's AI, another agent), whatever tab id they name.
  let owner = curRec;
  let t = tabs.find((x) => x.id === id);
  if (!t && !mcpCall()) {
    for (const rec of winRecs) {
      if (rec === curRec || !rcAlive(rec) || rec.agent) continue;
      t = tabsOf(rec).find((x) => x.id === id);
      if (t) { owner = rec; break; }
    }
  }
  if (isAsleep(t)) withWindow(owner, () => wakeTab(t));
  if (t) t.agentUsedAt = Date.now(); // (the agent window's idle sweep: sweepAgentTabs)
  return t && alive(t) && !agentOffLimits(t) ? { id: t.id, webContents: t.view.webContents } : null;
};
// [ask across tabs] This window's tabs as read_tabs and the "@" picker see them (features/tabs-ask.js
// decides which may be read). A private window's tabs are never in here: it keeps its own.
const askTabsList = () => tabs.filter((t) => !t.closing && (alive(t) || t.sleeping)).map((t) => {
  const live = alive(t) && !t.frozen; // (a frozen page can't be read: by its address only, like a sleeping one)
  const url = alive(t) ? realUrl(t.view.webContents) : t.sleepUrl || '';
  return { id: t.id, title: tabTitle(t) || hostOf(url) || '', url, sleeping: Boolean(t.sleeping || t.frozen), active: t.id === activeId, offLimits: agentOffLimits(t), favicon: t.favicon || null, webContents: live ? t.view.webContents : null };
});
const agentUnsavedState = (id) => { const t = tabs.find((x) => x.id === id); return alive(t) ? unsavedInputState(t.view.webContents) : Promise.resolve('no'); }; // [close guard] 'no' | 'yes' | 'unknown'
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
// [connectors] Services the user connected for the AI (Settings → You and AI → Connectors; features/connectors/). Nothing of it loads at
// startup: the first thing that needs it (a chat turn while something is connected, the Connectors page, a connect) makes the service.
// Until then "is anything connected" is answered from the small file itself. A request goes only to that service, and tests point each
// at 127.0.0.1 (global.__connectorEndpoints), with plain http allowed for that address in test mode only.
const connectorsOpen = (url) => { if (String(url).startsWith('https://')) openTab(url); };
// Gmail reuses the widget's Google paths: its own sign-in for the API, the Google sign-in in Lumen for the unread feed.
// (A test stands in for Google with global.__connectorsGoogle, looked up at each call.)
const connectorsGoogleReal = {
  status: async () => {
    const GA = require('./features/gmail-atom');
    const auth = widgets.gmailAuthState();
    let signedIn = false;
    let email = auth.email;
    if (!auth.oauth) {
      try {
        const res = await googleMailFeed(GA.feedUrl(0));
        const parsed = res.status === 200 ? GA.parseFeed(res.body) : null;
        signedIn = Boolean(parsed?.ok);
        email = parsed?.email || '';
      } catch { /* not reachable: not signed in */ }
    }
    return { oauth: auth.oauth, oneClick: auth.oneClick, session: signedIn, email };
  },
  api: (p) => widgets.gmailApi(p),
  drafts: () => widgets.gmailAuthState().compose, // the shared Google sign-in has gmail.compose (the user pressed Allow drafts)
  allowDrafts: () => widgets.gmailAllowDrafts(), // Settings' Allow drafts button only
  compose: (body) => widgets.gmailCompose(body), // POST /users/me/drafts and nothing else (never send)
  send: (body) => widgets.gmailSend(body), // the one send request, only after the Allow sending switch, then a card or typed permission (connectors/service.js)
  feed: () => googleMailFeed(require('./features/gmail-atom').feedUrl(0)),
  connect: () => widgets.gmailConnect({}),
  disconnect: () => widgets.gmailDisconnect(),
};
const connectorsGoogle = Object.fromEntries(Object.keys(connectorsGoogleReal).map((k) => [k, (...args) => ((TEST && global.__connectorsGoogle) || connectorsGoogleReal)[k](...args)]));
let connectorsLive = null;
const connectorsSvc = () => (connectorsLive ||= require('./features/connectors/service').create({
  userData: app.getPath('userData'),
  secrets: {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
    decrypt: (enc) => safeStorage.decryptString(Buffer.from(enc, 'base64')),
  },
  fetch: (url, options) => net.fetch(url, { ...options, credentials: 'omit' }), // a token goes in the header; no cookies
  sessionFetch: (url, options) => session.defaultSession.fetch(url, { ...options, credentials: 'include' }), // the user's signed-in Lumen session (Canvas)
  endpoints: () => (TEST && global.__connectorEndpoints) || {},
  testLoopback: TEST,
  // Hosts that may be a school's Canvas: the Canvas session cookie's own domain first, then history and the sites the AI may read as the user.
  detectHosts: async () => {
    const hosts = new Set();
    try { for (const c of await session.defaultSession.cookies.get({ name: 'canvas_session' })) hosts.add(String(c.domain || '').replace(/^\./, '')); } catch { /* none */ }
    for (const h of signedInSites.hosts()) hosts.add(h);
    for (const e of history.values()) { try { hosts.add(new URL(e.url).hostname); } catch { /* not an address */ } }
    return [...hosts].filter(Boolean);
  },
  google: connectorsGoogle,
  // Google Drive and Sheets: one Google sign-in in the user's own browser (features/connectors/google-auth.js). Lumen's built-in Google
  // client, unless the user typed their own for the Gmail widget (that one wins, as it does there). Tests point it at 127.0.0.1.
  workspace: {
    builtin: () => require('./features/google-client').builtinClient(),
    own: () => require('./features/oauth').decodeCreds(widgetSecret('gmail')),
    openExternal: (url) => { if (!/^https:\/\/accounts\.google\.com\//.test(url) && !(TEST && /^http:\/\/127\.0\.0\.1[:/]/.test(url))) throw new Error('Refusing to open that address.'); return shell.openExternal(url); },
    canKeepSecrets: () => safeStorage.isEncryptionAvailable(),
    focusApp: () => focusWindow(),
  },
  mcp: mcpClient,
  openSignIn: connectorsOpen,
  // GitHub signed in once (the card's sign-in, features/github-auth.js) is one token for the card and this connector: it is read from the
  // card's encrypted secret each time, never copied into connectors.json. Disconnecting the connector signs the card out too.
  shared: {
    github: {
      info: () => { const a = require('./features/github-auth').unpack(widgetSecret('github')); return a ? { token: a.token, account: a.login } : null; },
      signOut: () => widgets.githubSignOut(),
    },
  },
}));
let connectedOnDisk = null; // before the service exists: whether the file lists anything (read once)
const anyConnected = () => {
  if (connectorsLive) return connectorsLive.hasAny();
  if (connectedOnDisk === null) {
    try { connectedOnDisk = Object.keys(JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'connectors.json'), 'utf8')).connected || {}).length > 0; } catch { connectedOnDisk = false; }
  }
  return connectedOnDisk;
};
const connectorsFacade = {
  hasAny: () => anyConnected(),
  defs: (opts) => (anyConnected() ? connectorsSvc().defs(opts) : []), // opts.readOnly: a background task or routine (no writes)
  isWrite: (input) => connectorsSvc().isWrite(input),
  describeWrite: (input, opts) => connectorsSvc().describeWrite(input, opts),
  call: (input, opts) => connectorsSvc().call(input, opts),
  list: () => connectorsSvc().list(),
};
ipcMain.handle('connectors:list', () => connectorsSvc().list());
ipcMain.handle('connectors:detect', (_e, id) => connectorsSvc().detect(String(id)));
ipcMain.handle('connectors:connect', (_e, id, input) => connectorsSvc().connect(String(id), input && typeof input === 'object' ? input : {}));
ipcMain.handle('connectors:disconnect', (_e, id) => connectorsSvc().disconnect(String(id)));
ipcMain.handle('connectors:allow-drafts', (_e, id) => connectorsSvc().allowDrafts(String(id))); // Gmail: ask Google for gmail.compose (an explicit click in Settings)
ipcMain.handle('connectors:set-sending', (_e, id, on) => connectorsSvc().setSending(String(id), on === true)); // Gmail: the Allow sending switch (Settings only; the AI can't turn it on)
ipcMain.handle('connectors:send-log', () => connectorsSvc().sendLog()); // Settings' list of what the AI sent: time, to, subject
ipcMain.handle('connectors:sign-in', (_e, id) => {
  const url = connectorsSvc().signInUrl(String(id));
  if (url) connectorsOpen(url);
  return Boolean(url);
});
// The connector tool is not in the shared MCP tool list: an outside agent (Claude Code started in a terminal and the like) never sees the user's
// connected accounts. Only a run Lumen itself started gets it, by its own per-run tag (features/ai-agents.js runTools).
// With several windows, a run's tab tools keep acting on the window the run started in (its
// tabs, its active tab), whichever window has focus meanwhile. Outside a run they follow the focused window.
// Each sidebar run carries its window on its task scope (agent:ask); outside a tool call, the open chat's run.
const runRecNow = () => {
  const scope = agent.currentScope();
  const rec = scope?.mcp ? scope.rec || null : scope?.rec || chatRuns.get(chatId)?.rec || null; // [agent window] an outside agent's calls are in its own window, never the open chat's
  return rec && winRecs.has(rec) ? rec : null;
};
// [agent window] An outside agent's call whose window is gone (the user closed it mid-call) is refused: it must never fall through to
// the user's current window (features/agent-hands-off.js resolveRun).
const inRun = (fn) => (...args) => {
  const scope = agent.currentScope();
  if (scope?.mcp && !(scope.rec && winRecs.has(scope.rec) && rcAlive(scope.rec))) throw new Error(handsOff.AGENT_WINDOW_GONE);
  const rec = runRecNow();
  return rec ? withWindow(rec, () => fn(...args)) : fn(...args);
};
// [research tabs] web_search / read_urls show what they look at in background tabs (features/research-tabs.js).
// The tabs open in the run's window, behind the user's current tab, never through agentOpenTab (that
// would move the task onto them). Private windows have no agent, so none of this reaches them.
const researchTabs = require('./features/research-tabs').createResearchTabs({
  enabled: () => readSettings().researchTabs !== false,
  isAiOff: (url) => aiSites.isOff(url),
  searchUrl: (query) => searchUrlFor(readSettings().searchEngine, query),
  openTab: inRun((url, opts) => openTab(url, { background: true, ...(mcpCall() ? {} : { openedBy: runOf() }), ...opts }).id), // [ai manners] research tabs are the AI's too
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
// [desktop apps] src/desktop/ is loaded on first use: the AI's desktop tool, or a click on the Computer card. The Settings list needs only its small settings module.
let desktopWired = null;
const desktopLazy = () => (desktopWired ||= require('./desktop/wire').wire({ electron: require('electron'), readSettings, writeSettings, stopRun: () => agent.stop(), hidden: TEST && Boolean(process.env.LUMEN_TEST_BACKGROUND),
  live: { visible: () => thumbsVisible(), light: () => (TEST && typeof global.__desktopLight === 'boolean' ? global.__desktopLight : graphicsMode.light() || app.isHardwareAccelerationEnabled?.() === false) } })); // (tests choose the mode) the Computer card's live picture: only while a card is on screen (the shared 'agent:thumbs-visible'), slower in Light graphics
const desktopSettings = () => require('./desktop/settings').createDesktopSettings({ readSettings, writeSettings });
ipcMain.handle('settings:desktop-apps', () => desktopSettings().allowed());
ipcMain.handle('settings:remove-desktop-app', (_e, appKey) => desktopSettings().remove(String(appKey ?? '')));
ipcMain.handle('settings:clear-desktop-apps', () => desktopSettings().clear());
ipcMain.handle('desktop:open', (_e, id) => (typeof id === 'string' && id.startsWith('word-') ? (wordCtl ? wordCtl.openCard(id) : false) : typeof id === 'string' && desktopWired ? desktopWired.controller.openCard(id) : false)); // (the Word card's "Show in Word" rides the same channel: its ids start with word-)
ipcMain.on('desktop:control', (_e, what) => { if (!desktopWired) return; if (what === 'resume') desktopWired.controller.resume(); else if (what === 'stop') desktopWired.controller.stop('card'); });
// [word] src/word/ is loaded on first use of the word tool (agent.js wordTool), and its Word helper process starts only with the first call; Settings > AI > "Let the AI use Microsoft Word" (aiWordControl, on by default).
let wordCtl = null;
const wordLazy = () => (wordCtl ||= require('./word').createWord({
  settings: { enabled: () => readSettings().aiWordControl !== false, filesInApps: () => readSettings().aiFilesInApps }, // (aiFilesInApps: app | auto | file)
  checkFile: (p) => require('./features/device-access').checkedPath(p, 'file', { profile: app.getPath('userData'), home: TEST ? global.__homeDir : undefined }), // the AI's file rules: no credentials folders, no Lumen profile
  checkTarget: (p) => { const why = require('./features/device-access').blockedReason(p, { profile: app.getPath('userData'), home: TEST ? global.__homeDir : undefined }); if (why) throw new Error(why); },
  live: { visible: () => thumbsVisible(), light: () => (TEST && typeof global.__desktopLight === 'boolean' ? global.__desktopLight : graphicsMode.light() || app.isHardwareAccelerationEnabled?.() === false), dpr: () => { try { return require('electron').screen?.getPrimaryDisplay?.().scaleFactor || 1; } catch { return 1; } } }, // the card's live picture of Word's window (word/card.js), the desktop card's own pacing
  ...(TEST && process.env.LUMEN_WORD_HIDDEN === '1' ? { hostTest: { hidden: true, fresh: true } } : {}),
}));
if (TEST) global.__word = { ctl: () => wordLazy() };
app.on('before-quit', () => { try { wordCtl?.destroy(); } catch { /* nothing started */ } }); // [word] the helper ends with Lumen (a Word it started is quit only when no document is open)
app.on('before-quit', () => { try { desktopWired?.controller.destroy(); } catch { /* nothing started */ } }); // [desktop apps] the helper and the banner end with Lumen
if (TEST) global.__desktop = { wired: () => desktopLazy(), settings: desktopSettings };
const signedInSites = require('./features/signed-in-sites').createSignedInSites({ readSettings, writeSettings });
signedInSites.register(ipcMain);
// [screen context] "Allow always for this file": the local files the user let the AI see (features/shared-files.js); asked from the sidebar's own card only.
const sharedFiles = require('./features/shared-files').createSharedFiles({ readSettings, writeSettings });
sharedFiles.register(ipcMain);
// [no handoff] What the AI still couldn't do after its second try: a private local list in <profile>/diagnostics (ai/capability-gaps.js).
let gapLogRt = null; // (loaded with the first gap recorded, or Settings asking for the list)
const gapLog = () => (gapLogRt ||= require('./ai/capability-gaps').createGapLog({ dir: () => app.getPath('userData'), enabled: () => readSettings().aiGapLog !== false }));
ipcMain.handle('settings:ai-gaps', () => ({ entries: gapLog().list(), report: gapLog().report() }));
ipcMain.handle('settings:clear-ai-gaps', () => { gapLog().clear(); return { entries: [], report: '' }; });
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
    const tab = openTab(url, { background: true, openedBy: runOf() }); // the user's default session: no partition. [ai manners] the AI's tab, so "hide tabs the AI opened" covers it
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
  onChange: () => syncTouch('passwords'), // [sync]
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
  connectors: connectorsFacade, // [connectors] the one `connector` tool
  activeTab: inRun(agentActiveTab), tabInFront: inRun(agentTabInFront), tabById: inRun(agentTabById), noTabReason: inRun(noTabReason), listTabs: inRun(listTabs), openTab: inRun(agentOpenTab), switchTab: inRun(agentSwitchTab), keepAiTab: inRun((id) => manners.keepAfterRun(tabAnywhere(id)?.t)), closeTab: inRun((id) => closeTab(id, { ai: true })), requestCloseTab: inRun(agentRequestCloseTab), // keepAiTab: [ai manners] switch_tab keep:true, a tab of the AI's that the user needs after the run
  hasUnsavedInput: inRun(agentHasUnsavedInput), unsavedState: inRun(agentUnsavedState), askTabs: inRun(askTabsList), groupTabs: inRun(groupTabsFor), ungroupTabs: inRun(ungroupTabsFor), effectiveModel, anthropicAuth,
  tabExistsElsewhere: (id) => Boolean(tabAnywhere(id)), // [agent window] lets an outside agent's call be refused by name when it names a tab outside its own window
  recordGap: (info) => gapLog().record(info), // [no handoff]
  downloadList: () => downloads.list, // [ai downloads] Lumen's own download list: the AI is told each file's path and size (features/ai-downloads.js)
  fileShared: (url) => sharedFiles.has(url), shareFile: (url) => { sharedFiles.add(url); }, // [screen context] a local file the user allowed "always"
  aiOff: (url) => aiSites.isOff(pdfViewer.pdfUrlOf(url) || url), tabOff: (id) => manners.isKeptOff(tabAnywhere(id)?.t), tabGroupOf: inRun(tabGroupOf), setTabGroup: inRun(setTabGroup), // [ai controls]
  autoApprove: () => TEST || readSettings().askBeforeActing === false,
  bypassPermissions: () => readSettings().bypassPermissions === true, // [bypass permissions] agent.js askApproval (never under TEST by itself: tests set it)
  handsOff: () => readSettings().aiHandsOff === true, isAiTab: (id) => { const found = tabAnywhere(id); return Boolean(found && (found.rec.agent || manners.isAiTab(found.t))); }, typingText: () => t('agent.waitTyping'), // [ai manners]
  maxSteps: () => readSettings().maxSteps, // Settings > Max steps per task (agent.js: stepLimit)
  subagents: () => readSettings().aiSubagents, subagentModel: () => readSettings().aiSubagentModel, // [subagents] Settings > AI > helpers: the delegate tool is offered; which model they use (agent.js delegate)
  actingHelpers: () => readSettings().actingHelpers === true, // [acting helpers] Settings > AI > "Let helpers act in tabs": the parallel_tasks tool is offered (agent.js parallelTasks)
  openChatId: () => chatId, // [warm per chat] the open chat's engines are kept under its id (agent.js chatKey)
  takeNotice: (key) => { const s = readSettings(); if (s[key] !== true) return false; writeSettings({ ...s, [key]: false }); return true; }, // one-time notices
  autoModel: () => readSettings().autoModel !== false, // [model route] features/model-route.js
  autoCompact: () => readSettings().autoCompact !== false, // [context] Settings > AI: compact long API chats (agent.js autoCompact)
  effort: (key) => readSettings().aiEffort?.[key] || '', // Settings → AI → AI providers: reasoning effort per AI (ai/effort.js)
  claudeCodeFullAccess: () => readSettings().claudeCodeFullAccess === true, // [full access] ai/claude-code.js ARGS_FULL
  word: () => wordLazy(), desktopAccess: () => readSettings().aiDesktopControl === true, filesInApps: () => readSettings().aiFilesInApps, desktop: () => desktopLazy().controller, // [desktop apps] src/desktop/: the AI operating other programs on this computer (loaded on first use)
  deviceAccess: () => readSettings().aiDeviceAccess === true, profileDir: () => app.getPath('userData'), // [device access] features/device-access.js: upload_file paths, list_files, clipboard read
  knownFolder: require('./features/device-access').makeKnown({ getPath: (n) => app.getPath(n), downloadDir: () => settingsBackend.downloadDir() }), // [device access] "desktop", "documents", "downloads"... where the system (OneDrive folder redirection) or Settings put them
  homeDir: () => (TEST ? global.__homeDir : undefined), // tests: a throwaway home folder for the AI's file lookups (test/e2e/files-ai.js)
  findFile: (query, opts) => filesApi().findFile(query, opts), noteFile: (file, source) => { filesApi().note(file, { source }).catch(() => {}); }, // [files] list_files find: (pinned and recent files first, then a bounded search) and the AI's reads and files made on the Recent list (features/files.js)
  ccUserSettings: () => readSettings().ccUserSettings === true, // [cc settings] ai/claude-code.js buildArgs
  imageGen: () => readSettings().imageGen, autoExcluded: () => autoExcluded(), // [image routing] ai/image-router.js: Settings > AI > Image generation, and the providers turned off for Auto
  grokBuildFullAccess: () => readSettings().grokBuildFullAccess === true, // [full access] ai/grok-build.js ARGS_FULL
  antigravityFullAccess: () => readSettings().antigravityFullAccess === true, // [full access] ai/antigravity.js FULL_FLAGS
  codexFullAccess: () => readSettings().codexFullAccess === true, // [full access] ai/codex.js FULL_ON
  autoFallback: fallbackOn, fallbackOptions: () => modelOptions(), onFallback: () => modelsChanged(), // [model fallback] the picker shows the stand-in
  autoRoute, autoEscalate, autoDeny: (id) => autoDenied.add(id), onAuto: () => modelsChanged(), // [auto model] ai/auto-model.js
  chatAutocomplete: () => readSettings().chatAutocomplete !== false, // [autocomplete] Settings > AI > Tab to finish what I'm typing (agent.js autocomplete)
  boardChanged: (chat) => researchChanged(chat), // [research] the AI added to the chat's research board (ai/research-tools.js): the panel redraws, the chat is saved
  memory: { // [memory] Settings → AI and agents → Memory (ai/memory.js): the memory tool's store, and which chat a run belongs to
    on: memoryOn, store: memory, chatSearch: () => readSettings().aiMemoryChatSearch !== false,
    chatIdOf: chatIdOfMessages, isTemporary: (messages) => temporaryChats.has(chatIdOfMessages(messages)),
    searchChats: (query, exclude) => memorySearchChats(query, exclude),
  },
  notes: { store: () => notesStore(), changed: () => pushNotes() }, // [notes] the notes tool (ai/notes.js)
  projects: { // [project workspace] the project_files tool's data for a chat, and which tools its project allows
    files: async (messages) => {
      const project = projectForChat(chatIdOfMessages(messages));
      if (!project) return null;
      const store = projectFiles();
      return { files: store.list(project.id), links: project.links || [], readText: (f) => store.readText(project.id, f.id), readImage: (f) => store.readImage(project.id, f.id) };
    },
    allows: projectAllows,
  },
}, getClient, () => ({ adhdMode: readSettings().adhdMode !== false, handsOff: readSettings().aiHandsOff === true, preferFractions: readSettings().aiPreferFractions === true, customInstructions: require('./ai/custom-instructions').block(readSettings()), skillsList: skillsListNow(), ...projectSettingsFor(chatId), model: effectiveModel() || DEFAULT_MODEL, ...(temporaryChats.has(chatId) ? { noMemory: true } : {}) }), providerKey); // ([memory] a temporary chat never reads or writes memory)
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
  runLive: (runId) => [...chatRuns.values()].some((r) => r.runId === runId && !r.deleted), // [working-on chip] is that run still on the books (done, failed and cancelled ones leave chatRuns)
  allTabs: () => allTabsEverywhere(),
  alive,
  ui,
  openTab: (url, opts) => openTab(url, opts),
  switchTab: (id) => switchTab(id),
  requestCloseTab: (id) => requestCloseTab(id),
  goHome: (id) => replaceTab(id, newTabUrl()), // the chat tab becomes the new-tab page, in its place
  goChat: (id) => { const { id: page } = openTab(chatPage.CHAT_URL, { managerPage: 'chat' }); takePlace(page, id); return page; }, // and the way back: the new-tab page becomes the chat page
  managersOpen: () => managers.open('chat'),
  routines: () => bgTasks, // "Schedule this" on the page (features/chat-page.js registerRoutines); bgTasks is made below, so it is looked up when asked
  spareContents: () => spareChat?.view.webContents || null, // (the spare chat page, before a tab takes it: the strings it asks for at load)
  isPrivateSender: (event) => !syntheticTestEvent(event) && !recOfSender(event?.sender), // a private window's UI is in no window record
  chatView: () => chatView(),
  chatOf: (tabId) => chatBind.chatOf(tabId), // [chat per tab] the chat a chat page tab was left on
  followPage: (event) => followChatPage(event?.sender), // a page asking for its chat first brings the open chat in line with its tab
  // The sidebar of a window shows its front tab's chat. A chat page's sync or run start about any other chat is not for it (it would
  // redraw the sidebar as that chat while main still has it on its own); one about the chat it shows is, and so is any once the chat
  // it showed is gone (deleted in the page) and no tab or run holds it.
  sidebarWants: (wc, payload) => {
    const about = payload?.view?.id ?? payload?.chatId;
    const shows = shownChat.get(wc);
    return !about || !shows || shows === about || (!chatBind.claimed(shows) && !chatRuns.has(shows) && shows !== chatId);
  },
  agentOffLimits,
  tabInfo: (t) => {
    const live = alive(t);
    return { id: t.id, title: live ? t.view.webContents.getTitle() : t.sleepTitle || '', url: live ? realUrl(t.view.webContents) : t.sleepUrl || '', favicon: t.favicon || null };
  },
});
chatPageRt.register();
if (TEST) global.__chatPage = { rt: chatPageRt, open: () => chatPageRt.open(), back: () => chatPageRt.back(), home: (id) => chatPageRt.home(id), fromHome: (id, o) => chatPageRt.fromHome(id, o), pick: () => chatPageRt.pick(), tabs: () => tabs.filter(alive).map((t) => ({ id: t.id, chat: t.managerPage === 'chat', url: t.view.webContents.getURL(), viewedAt: t.viewedAt || 0 })), contents: (id) => tabs.find((t) => t.id === id)?.view?.webContents, ui: () => ui(), activeId: () => activeId, switchTab: (id) => switchTab(id) };
// [usage] Plan limits and Lumen's share of them (features/usage.js): Settings → You and AI → Usage,
// and the sidebar's meter.
// Tests don't look at the real ~/.claude for other Claude Code sessions (features/usage.js otherClaudeActivity): whoever runs them may be using Claude Code at that moment.
// Tests never run the real `claude -p /usage` either (it starts the user's own MCP servers): only a stand-in (LUMEN_CLAUDE_BIN, test/e2e/usage.js).
const usage = createUsage({ app, showBars: () => readSettings().usageBars !== false, cooling: (now) => aiFallback.shared.snapshot(now), claudeBin: () => (TEST && !process.env.LUMEN_CLAUDE_BIN ? null : require('./ai/claude-code').findClaude()), grokSession: () => agent.messages?.settings?.gbSession || null,
  // [usage] Codex's own session logs (numbers only: ai/codex-usage.js); tests never read the real ~/.codex.
  codexScan: async (now) => (TEST ? global.__codexScan?.(now) ?? null : require('./ai/codex-usage').scanSessions({ home: require('./ai/codex-config').codexHome(), now })),
  codexInstalled: () => { try { return aiAgents.cliStatus().codex.installed; } catch { return null; } },
  ...(TEST ? { otherActivity: async () => false } : {}) });
agent.onUsage = (engine, data) => usage.record(engine, data);
ipcMain.handle('usage:get', (_e, options) => usage.summary({ refresh: Boolean(options?.refresh), cached: Boolean(options?.cached) }));
// Background tasks: jobs the AI does on its own in hidden tabs, on a schedule or watching a page
// (features/background-runner.js). Kept out of the sidebar chat and the user's tabs.
let routinesSoon = () => {}; // [widgets] the home page's Routines card looks again when a routine changes; set once the widgets exist
const bgTasks = require('./features/background-runner').create({
  file: path.join(app.getPath('userData'), 'background-tasks.json'),
  now: TEST ? () => Date.now() + (global.__clockOffset || 0) : undefined, // (tests move the clock forward: global.__clockOffset, ms)
  connectors: connectorsFacade, connectedIds: () => (anyConnected() ? connectorsSvc().connectedIds() : []), // routines read the connected services (Gmail, Canvas…)
  routinesChanged: () => { routinesSoon(); missionSoon(); }, // (and an open lumen://tasks page)
  encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
  decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  available: () => safeStorage.isEncryptionAvailable(),
  ui, readSettings, writeSettings, t, test: TEST,
  maxBackgroundTasks: () => perfMode.limits().maxBackgroundTasks, // Performance mode: one at a time
  getClient: (...args) => agent.getClient(...args), getKey: providerKey,
  effectiveModel, modelOptions, currentModel: () => effectiveModel(), anthropicAuth,
  autoRoute: (a) => { const cli = Boolean(a.scope) && aiFallback.isEngine(`${a.scope}:x`); return autoRoute({ ...a, apiOnly: !cli, allowEngines: cli, strict: cli }); }, autoEscalate: (a) => autoEscalate({ ...a, allowEngines: false }), autoDeny: (id) => autoDenied.add(id), // [auto model] a task on Auto is routed to an API model at each run (a task on a CLI's own Auto, 'claudecode:auto': to that CLI's models: runCli)
  aiOff: (url) => aiSites.isOff(url), externalTools: mcpClient, maxSteps: () => readSettings().maxSteps,
  reportUsage: (engine, data) => agent.onUsage?.(engine, data),
  cliEngine: (kind) => aiAgents.backgroundEngine(kind), cliStatus: () => aiAgents.cliStatus(), // Claude Code / Grok Build runs
  activeUrl: () => { const u = activeTab()?.webContents.getURL(); return isWebUrl(u) ? u : ''; },
  openTab: (url) => openTab(url), focusApp: () => focusWindow(),
  every: (...a) => scheduler.every(...a), // (the 15 s task check shares the scheduler's one timer)
  isOnline: () => net.isOnline(), powerMonitor: () => require('electron').powerMonitor, // routines: skip while offline, catch up after sleep
});
bgTasks.register(ipcMain);
app.on('will-quit', () => bgTasks.shutdown());
if (TEST) global.__bg = bgTasks;
// [telegram] Phone (Telegram): requests from the user's own Telegram bot run as background tasks (features/telegram.js).
// Off by default (telegramChannel); the bot token is encrypted like the API keys (keys.telegram) and never leaves this
// process except to api.telegram.org. Tests never reach Telegram: only a stand-in (global.__telegramFetch).
// Loaded only once it is needed (Phone on, or its Settings section asked): most starts never touch it (perf-budget's module count).
let telegramRt = null;
const telegramHandlers = {};
const telegramNow = () => {
  if (telegramRt) return telegramRt;
  telegramRt = require('./features/telegram').create(telegramDeps());
  telegramRt.register({ handle: (channel, fn) => { telegramHandlers[channel] = fn; } });
  if (TEST) global.__telegram = telegramRt;
  return telegramRt;
};
const missionFromPhone = new Set(); // [mission control] tasks Telegram started since Lumen started (lumen://tasks says so)
const telegramDeps = () => ({
  fetch: (url, options) => (TEST ? (global.__telegramFetch ? global.__telegramFetch(url, options) : Promise.reject(new Error('No network in tests.'))) : net.fetch(url, { ...options, credentials: 'omit' })),
  readSettings, writeSettings, t,
  getToken: () => { const enc = readSettings().keys?.telegram; if (!enc || !safeStorage.isEncryptionAvailable()) return null; try { return decryptKey(enc); } catch { return null; } },
  setToken: (token) => {
    const settings = readSettings();
    const keys = { ...(settings.keys || {}) };
    if (token) keys.telegram = safeStorage.encryptString(String(token)).toString('base64');
    else delete keys.telegram;
    writeSettings({ ...settings, keys });
  },
  canEncrypt: () => safeStorage.isEncryptionAvailable(),
  isOnline: () => net.isOnline(),
  inbox: phoneInbox(), onFile: (saved, caption) => notePhoneFile(saved, caption), openUrl: (url) => openFromPhone(url), // [phone files]
  tasks: { create: (spec) => { const task = bgTasks.create(spec); missionFromPhone.add(task.id); return task; }, stop: (id) => bgTasks.stop(id), approve: (id, approvalId, choice) => bgTasks.approve(id, approvalId, choice), find: (id) => bgTasks.find(id), subscribe: (fn) => bgTasks.subscribe(fn), approvalWaitMin: () => bgTasks.state().settings.approvalWaitMin },
});
ipcMain.handle('settings:telegram-show-inbox', () => { const dir = phoneInbox().dir; fs.mkdirSync(dir, { recursive: true }); filesShell('open', dir); return true; }); // [phone files]
for (const channel of ['settings:telegram', 'settings:telegram-token', 'settings:telegram-pair', 'settings:telegram-pair-cancel', 'settings:telegram-unpair', 'settings:telegram-remove']) {
  ipcMain.handle(channel, (...args) => { telegramNow(); return telegramHandlers[channel](...args); });
}
const telegram = { refresh: () => { if (telegramRt || readSettings().telegramChannel === true) telegramNow().refresh(); } };
app.on('will-quit', () => telegramRt?.shutdown());
// [phone files] Photos and files sent to the bot land in Downloads/From phone (features/phone-inbox.js). The strip's toast offers
// Attach to chat (the bytes go to the composer like a dropped file, the caption into the empty composer, never sent); a program or
// script only gets Show in Finder. Several in a row (an album) share one toast. Outside Lumen, a system notification says so.
let phoneInboxRt = null;
function phoneInbox() {
  if (phoneInboxRt) return phoneInboxRt;
  const dir = path.join(TEST && global.__phoneInboxDir ? global.__phoneInboxDir : app.getPath('downloads'), require('./features/phone-inbox').FOLDER);
  const setXattr = (file, name, value) => require('./ai/cli-utils').execFile('/usr/bin/xattr', ['-w', name, value, file], { timeout: 5000 }, (err) => { if (err) console.error('[lumen] phone inbox: xattr:', err.message); });
  phoneInboxRt = require('./features/phone-inbox').createPhoneInbox({ dir, setXattr });
  return phoneInboxRt;
}
const phoneNotes = new Map(); // toast token -> { files: [saved], caption }
let phoneNoteSeq = 0;
let phoneBatch = null; // { token, at }: the toast files arriving close together join
// `batch`: files of one Wi-Fi session share a toast however far apart they came (openWifiUpload).
function notePhoneFile(saved, caption, { batch = null } = {}) {
  const joins = phoneBatch && phoneNotes.has(phoneBatch.token) && (batch ? phoneBatch.key === batch : !phoneBatch.key && Date.now() - phoneBatch.at < 8000);
  const token = joins ? phoneBatch.token : ++phoneNoteSeq;
  const entry = joins ? phoneNotes.get(token) : { files: [], caption: '' };
  entry.files.push(saved);
  if (caption && !entry.caption) entry.caption = String(caption).slice(0, 4000);
  phoneNotes.set(token, entry);
  phoneBatch = { token, at: Date.now(), key: batch };
  for (const old of phoneNotes.keys()) { if (phoneNotes.size <= 10) break; phoneNotes.delete(old); }
  const text = entry.files.length === 1 ? t('phone.toast.one', { name: saved.name }) : t('phone.toast.many', { count: entry.files.length });
  const showOnly = entry.files.every((f) => f.risky);
  const rec = focusedRec() || curRec;
  if (TEST) (global.__phoneNotes ||= []).push({ token, text, showOnly });
  if ((TEST || BrowserWindow.getFocusedWindow()) && rcAlive(rec) && winRecs.has(rec)) { // (test windows stay in the background: the toast is what they check)
    withWindow(rec, () => ui()?.send('tabs:organize-note', { text, undo: true, ttl: 15000, phoneNote: token, undoLabel: t(showOnly ? 'phone.toast.show' : 'phone.toast.attach'), undoTitle: entry.caption || text }));
    return;
  }
  if (TEST) return;
  try {
    const n = new Notification({ title: t('phone.notify.title'), body: text, silent: false });
    n.on('click', () => { focusWindow(); phoneNoteAction(token); });
    n.show();
    phoneNotifs.add(n); // (held: Electron drops the click handler of a collected Notification)
    if (phoneNotifs.size > 10) phoneNotifs.delete(phoneNotifs.values().next().value);
  } catch (err) { console.error('[lumen] phone files: notification:', err?.message || err); }
}
const phoneNotifs = new Set();
// The toast's button: the files into the composer (the caption too, when the composer is empty), or Finder for programs.
async function phoneNoteAction(token) {
  const entry = phoneNotes.get(Number(token));
  if (!entry) return false;
  if (phoneBatch?.token === Number(token)) phoneBatch = null; // (a used toast takes no more files: the next one gets its own)
  const safe = entry.files.filter((f) => !f.risky);
  if (!safe.length) { filesShell('show', entry.files[0].path); return true; }
  let first = true;
  for (const f of safe.slice(0, 10)) {
    let data;
    try { data = await fs.promises.readFile(f.path); } catch { continue; } // moved or deleted since
    ui()?.send('files:attach-file', { name: f.name, type: f.mime || '', data, ...(first && entry.caption ? { text: entry.caption } : {}) });
    first = false;
  }
  return true;
}
ipcMain.handle('phone:note-action', (_e, token) => phoneNoteAction(token));
// A link sent from the phone: a new tab in the window in front, behind the current one (nothing the user is doing is taken over).
function openFromPhone(url) {
  const rec = focusedRec() || curRec;
  if (!rec) throw new Error('No Lumen window is open.');
  withWindow(rec, () => { openTab(url, { background: true }); toast(t('phone.toast.opened')); });
}
// Send to phone (page menus, a finished download's menu): only ever the user's own click. Shown while a chat is paired.
const phoneReady = () => readSettings().telegramChannel === true && telegramNow().paired();
async function sendToPhone(what) {
  const rec = focusedRec() || curRec;
  try {
    await telegramNow().sendToChat(what);
    noteIn(rec, t('phone.send.sent'), { ttl: 2600 });
  } catch (err) {
    noteIn(rec, t('phone.send.failed', { error: String(err?.message || err).slice(0, 200) }), { ttl: 6000 });
  }
}
const sendPageToPhone = (wc) => { if (wc && !wc.isDestroyed() && isWebUrl(wc.getURL())) sendToPhone({ text: [wc.getTitle(), wc.getURL()].filter(Boolean).join('\n') }); };
async function sendFileToPhone(file) {
  let data;
  try { data = await fs.promises.readFile(file); } catch (err) { noteIn(focusedRec() || curRec, t('phone.send.failed', { error: err.message }), { ttl: 6000 }); return; }
  return sendToPhone({ file: { name: path.basename(file), data, mime: require('./features/upload-files').mimeOf(file) } });
}
// [phone wifi] Receive from phone (Wi-Fi) (features/wifi-upload.js): a QR sheet for a one-time address on this computer's
// Wi-Fi; the phone's page sends files into the phone inbox. The server runs only while the sheet is open. What came is handed
// over when it closes: opened from the composer's + menu, straight into the composer; from a menu, the strip's toast.
let wifiRt = null;
let wifiSheet = null; // { win, session, attach, received: [{ saved, caption }], id }
let wifiSeq = 0;
function wifiUpload() {
  if (wifiRt) return wifiRt;
  const words = Object.fromEntries(['title', 'intro', 'pick', 'note', 'waiting', 'sent', 'failed', 'tooBig', 'ended', 'taken', 'sessionFull', 'diskFull', 'noNetwork'].map((k) => [k, t(`wifi.page.${k}`)]));
  wifiRt = require('./features/wifi-upload').createWifiUpload({
    http: require('http'), interfaces: () => require('os').networkInterfaces(), inbox: phoneInbox(), words,
    allowLoopback: TEST && global.__wifiLoopback === true,
    onFile: (saved, caption) => { wifiSheet?.received.push({ saved, caption }); },
    onEvent: onWifiEvent,
  });
  return wifiRt;
}
function onWifiEvent(e) {
  const sheet = wifiSheet;
  if (TEST) (global.__wifiEvents ||= []).push(e);
  if (!sheet) return;
  if (e.type === 'claimed') toolOverlay.update(sheet.win, sheet.session, { status: t('wifi.connected') });
  else if (e.type === 'file') toolOverlay.update(sheet.win, sheet.session, { status: t('wifi.received', { count: sheet.received.length || 1 }) });
  else if (e.type === 'stopped') {
    wifiSheet = null;
    if (e.reason !== 'closed') toolOverlay.hide(sheet.win, sheet.session);
    if (e.reason === 'idle' || e.reason === 'expired') toast(t('wifi.endedIdle'));
    else if (e.reason === 'bad-keys') toast(t('wifi.endedBadKeys'));
    deliverWifi(sheet);
  }
}
function deliverWifi(sheet) {
  if (!sheet.received.length) return;
  if (sheet.attach) {
    const token = ++phoneNoteSeq;
    phoneNotes.set(token, { files: sheet.received.map((r) => r.saved), caption: sheet.received.find((r) => r.caption)?.caption || '' });
    phoneNoteAction(token).catch((err) => console.error('[lumen] wifi upload: could not attach:', err?.message || err));
    return;
  }
  for (const r of sheet.received) notePhoneFile(r.saved, r.caption, { batch: `wifi-${sheet.id}` });
}
async function openWifiUpload({ attach = false } = {}) {
  if (wifiSheet) wifiUpload().stop('replaced'); // (one at a time: what came so far is handed over)
  const rec = focusedRec() || curRec;
  if (!rec) return null;
  return withWindow(rec, async () => {
    const w = win; // (taken before the await: another window may be in front by then)
    const wc = activeTab()?.webContents;
    let info;
    try { info = await wifiUpload().start(); } catch (err) {
      noteIn(rec, err?.code === 'no-network' ? t('wifi.noNetwork') : t('wifi.failed', { error: String(err?.message || err).slice(0, 200) }), { ttl: 6000 });
      return null;
    }
    const sheet = { win: w, session: null, attach, received: [], id: ++wifiSeq };
    wifiSheet = sheet;
    sheet.session = await toolOverlay.show(w, {
      mode: 'qr',
      restoreFocus: () => { if (wc && !wc.isDestroyed()) wc.focus(); },
      payload: {
        title: t('wifi.title'), sub: t('wifi.scan'), modules: require('./features/qr').makeMatrix(info.url), alt: t('wifi.alt'),
        text: t('wifi.address', { address: `${info.ip}:${info.port}` }), warn: t('wifi.trusted'), // (the address without its key: only the QR carries that)
        buttons: [{ id: 'close', label: t('wifi.done'), primary: true }],
      },
      onAction: () => {},
      onClose: () => { if (wifiSheet === sheet) wifiUpload().stop('closed'); },
    });
    if (TEST) global.__wifiUrl = info.url;
    return info;
  });
}
ipcMain.on('phone:wifi-open', () => { openWifiUpload({ attach: true }).catch((err) => console.error('[lumen] wifi upload:', err?.message || err)); }); // the composer's + menu
app.on('will-quit', () => wifiRt?.stop('quit'));
if (TEST) global.__phone = { inbox: phoneInbox, note: notePhoneFile, open: openFromPhone, notes: phoneNotes, action: phoneNoteAction, sendPage: sendPageToPhone, sendFile: sendFileToPhone, ready: () => phoneReady(), wifi: openWifiUpload, wifiStatus: () => wifiRt?.status() || { running: false }, wifiClose: () => { const s = wifiSheet; if (s) toolOverlay.hide(s.win, s.session); } };
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
  global.__uninstallExtension = (id) => uninstallExtension(id, { session: session.defaultSession });
  global.__isContentBlocker = isContentBlocker;
  global.__adblock = { ready: adblock.ready, blocked: adblock.blocked, probe: adblock.probe };
  global.__downloads = { list: () => downloads.list.map((d) => ({ ...d })), menu: () => downloads.menu(), panel: () => downloadsView?.webContents, panelList: () => downloads.panelList(), show: (anchor) => showDownloadsPanel(anchor), hide: hideDownloadsPanel, visible: () => Boolean(downloadsView?.getVisible()) };
  global.__recorder = { mp4: () => recordMp4, get: () => screenRecorder(), options: recordOptions, menu: () => recordMenu(activeTab()?.webContents), startTab: (opts) => screenRecorder().start({ kind: 'tab', wc: activeTab()?.webContents, ...opts }) }; // [screen recording]
  global.__patchSettings = (patch) => writeSettings({ ...readSettings(), ...patch });
  // The tab menu's Mute Tab / Mute Site items (a native menu the tests can't click)
  global.__tabAudioMenu = (id, label) => {
    const tab = tabs.find((t) => t.id === id);
    const items = tab ? audioMenuItems(tab) : [];
    if (label) items.find((i) => i.label === label)?.click();
    return items.map((i) => i.label);
  };
  global.__closedTabs = () => closedTabs.slice();
  global.__closedWindows = () => closedWindows.length;
  global.__reopenLastClosed = reopenLastClosed;
  // The tab strip's right-click menu (test/e2e/tabmenu.js): its items as { label, enabled }, and with
  // `label`, that item clicked.
  global.__tabMenu = (id, label) => {
    const items = flatMenu(tabMenuTemplate(id)).filter((r) => r.item.label); // submenus opened: { label, enabled, depth }, depth 0 being the menu's own rows
    if (label) items.find((r) => r.item.label === label)?.item.click();
    return items.map(({ item: i, depth }) => ({ label: i.label, enabled: i.enabled !== false, depth }));
  };
  global.__tabMenuFull = (id) => flatMenu(tabMenuTemplate(id)).map(({ item: i, depth }) => ({ label: i.type === 'separator' ? '---' : i.label, depth, accelerator: i.accelerator, registerAccelerator: i.registerAccelerator })); // (test/e2e/chrome-ux.js: separators and shortcut hints too)
  global.__macMenuLabels = () => macMenu().items.map((m) => ({ label: m.label, items: m.submenu ? m.submenu.items.map((i) => i.label) : [] }));
  global.__mcpClient = mcpClient;
  global.__connectors = connectorsFacade;
  global.__mcpTools = EXTERNAL_TOOLS;
}

// ---------- skills (features/skills.js): /summarize and friends; managed in Settings → Skills ----------
// Saved prompts run from the composer's "/" menu. A run is an ordinary chat message (the expanded
// prompt), so usage, the approval gate and the taint rules apply unchanged; agent:ask above picks up
// the prepared run's options (tools off, own model, page text counted as read).
const skillPageScripts = require('./ai/page-scripts');
const SKILL_WORLD = 1002; // a JavaScript world of our own, apart from the page's and the agent's
const skillWithin = (promise, ms = 4000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
const skillTabOk = (tab) => alive(tab) && !agentOffLimits(tab) && isWebUrl(realUrl(tab.view.webContents)) && !aiSites.isOff(realUrl(tab.view.webContents));
// Told whenever the model shown for the open chat may have changed without a pick (another chat opened, a new one begun).
let lastShownModel = null;
function announceModelIfChanged() {
  let now;
  try { now = shownModel().model; } catch { return; }
  if (now === lastShownModel) return;
  lastShownModel = now;
  modelsChanged();
}
// The model list or the chosen model changed: every window's sidebar, every chat page and Settings reload theirs.
function modelsChanged() {
  try { lastShownModel = shownModel().model; } catch { /* not set up yet */ }
  try { refreshNewTabs(); } catch { /* not set up yet (startup) */ } // the new-tab pages' Ask AI box says who it asks: it follows the pick at once, in every window
  aiStatusSoon(); // the AI status widget's rows follow the same change
  for (const rec of winRecs) if (rcAlive(rec) && !isSpare(rec)) rec.win.webContents.send('models-updated');
  for (const wc of [...chatPageRt.everyChatTab().map((t) => t.view.webContents), ...allTabsEverywhere().filter((t) => t.settings && alive(t)).map((t) => t.view.webContents)]) if (wc && !wc.isDestroyed()) wc.send('models-updated');
}
if (TEST) { global.__modelsChanged = modelsChanged; global.__aiFallback = aiFallback; }
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
// [skills] The skills the AI may use on its own, as the system prompt lists them (fixed when a chat starts). '' before
// skillsFeature exists (a chat begun during start-up) or when there are none.
function skillsListNow() { try { return skillsFeature.promptBlock(); } catch { return ''; } }
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
  emitUpdate: (update) => { for (const t of tabs) if (t.settings && alive(t)) t.view.webContents.send('skills:update', update); },
  settings: () => readSettings(),
  homeDir: () => app.getPath('home'),
  transcript: () => agent.transcript(),
  complete: (args) => (TEST && global.__skillsComplete ? global.__skillsComplete(args) : completeSkillJson(args)),
});
skillsFeature.register();
agent.browser.skills = skillsFeature; // the use_skill tool (ai/agent.js)
if (TEST) global.__skills = skillsFeature;

// ---------- meeting helper (features/meeting.js): live prompting, agenda/resume, stealth, listener ----------
const meetingHelper = lazy(() => require('./features/meeting').createMeetingHelper({
  userDataDir: app.getPath('userData'),
  getActiveTab: () => activeTab(),
  readPageContext: async (tab) => {
    try { return await agent.pageContextFor(tab, { fresh: true, screen: true }); } catch { return ''; }
  },
  complete: (args) => (TEST && global.__meetingComplete ? global.__meetingComplete(args) : completeSkillJson(args)),
  getChatStore: () => chats(),
  getWindow: () => win,
  broadcast: (ch, p) => ui()?.send(ch, p),
}));
if (TEST) global.__meetingHelper = meetingHelper;

// [dictation] Voice input in the chat box (ai/dictation.js, renderer/dictation.js). The recording arrives once, goes to the
// provider chosen in Settings with the user's key (the page never sees the key), and the buffer is cleared afterwards;
// nothing is written to disk. The sidebar and the chat page may ask (UI_ONLY_IPC, chat-page.js CHAT_IPC).
const dictationLib = () => require('./ai/dictation'); // (loaded with the first use of the mic)
function dictationState() {
  const s = readSettings();
  const choice = dictationLib().choose(s.dictationProvider, (p) => Boolean(providerKey(p)));
  if (!choice.provider) { const m = dictationLib().unavailableMessage(choice); return { provider: null, reason: choice.reason, message: t(m.key, m.params) }; }
  return { provider: choice.provider, label: dictationLib().LABELS[choice.provider], format: dictationLib().FORMATS[choice.provider], maxSeconds: dictationLib().MAX_SECONDS, maxBytes: dictationLib().MAX_BYTES, autoSend: s.dictationAutoSend === true };
}
ipcMain.handle('dictation:status', () => dictationState());
ipcMain.handle('dictation:transcribe', async (_e, bytes, format) => {
  const state = dictationState();
  if (!state.provider) return { error: state.message, settings: true };
  if (!(bytes instanceof Uint8Array)) return { error: t('dictation.error.empty') };
  if (format !== state.format) return { error: t('dictation.error.changed') }; // the setting changed while recording
  const audio = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    const res = await dictationLib().transcribe({ provider: state.provider, key: providerKey(state.provider), audio, format, models: providerModels[state.provider], fetchImpl: netFetch() });
    return res.error ? { error: t(res.error.key, res.error.params), settings: res.error.key === 'dictation.error.key' } : { text: res.text, autoSend: state.autoSend };
  } finally {
    audio.fill(0); // (the only copy in this process)
  }
});

ipcMain.handle('meeting:state', () => meetingHelper.getState());
ipcMain.handle('meeting:context-get', () => meetingHelper.loadContext());
ipcMain.handle('meeting:context-save', (_e, patch) => meetingHelper.saveContext(patch));
ipcMain.handle('meeting:prompt', (_e, q, opts) => meetingHelper.prompt(q, opts));
ipcMain.handle('meeting:live-start', () => meetingHelper.setLive(true));
ipcMain.handle('meeting:live-stop', () => meetingHelper.setLive(false));
ipcMain.handle('meeting:transcript-chunk', (_e, text, speaker) => meetingHelper.addTranscriptChunk(text, speaker));
ipcMain.handle('meeting:stealth', (_e, on) => meetingHelper.setStealth(on));
ipcMain.handle('meeting:summarize', (_e, text) => meetingHelper.summarize(text));
ipcMain.handle('meeting:save-chat', (_e, payload) => meetingHelper.saveToChat(payload));

// ---------- macros (features/macros-runtime.js): named step sequences; managed in Settings → Macros ----------
// A run is the AI's own tools (click, type_text, navigate, wait_for, ...) driven from the saved steps. The user's runs (⋯ menu,
// shortcut, /macro in the sidebar, Settings test run) work in the front web tab; the AI's (run_macro) go through its approval gate.
const macroTab = (t) => (t && alive(t) ? { id: t.id, webContents: t.view.webContents } : null);
const macroTargetTab = () => { // the front tab if it is a web page; else the one used last (Settings and the chat page are not pages to run on)
  const usable = (t) => t && alive(t) && !t.settings && !t.managerPage && !t.isolated;
  const front = tabs.find((t) => t.id === activeId);
  if (usable(front)) return macroTab(front);
  return macroTab(tabs.filter(usable).sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))[0]);
};
const macroTabOf = (tab) => tabs.find((t) => t.id === (tab?.id ?? activeId));
const macroActions = {
  reader: (_a, tab) => { pageTools.toggleReader(macroTabOf(tab)); return 'Toggled reader mode.'; },
  mute: (_a, tab) => { const x = macroTabOf(tab); if (x) tabTools.setMuted(x, !tabTools.state(x, alive(x)).muted); return 'Toggled mute.'; },
  pin: (_a, tab) => { const x = macroTabOf(tab); if (x) pinTab(x.id, !x.pinned); return 'Toggled pin.'; },
  group_tab: ({ name }, tab) => { const x = macroTabOf(tab); if (x) groupTabsFor(name || 'Macro', [x.id]); return 'Grouped the tab.'; },
  open_sidebar: ({ text }) => { ui()?.send('macros:sidebar', { text: text || '', send: false }); return 'Opened the sidebar.'; },
  new_chat: () => { newSidebarChat(); return 'Started a new chat.'; },
  bookmark: (_a, tab) => { toggleBookmarkFor(macroTabOf(tab)); return 'Toggled the bookmark.'; },
  zoom_in: (_a, tab) => { zoomBy(tab?.webContents, 0.5); return 'Zoomed in.'; },
  zoom_out: (_a, tab) => { zoomBy(tab?.webContents, -0.5); return 'Zoomed out.'; },
  zoom_reset: (_a, tab) => { zoomBy(tab?.webContents, 0); return 'Reset the zoom.'; },
  reload: (_a, tab) => { tab?.webContents.reload(); return 'Reloaded.'; },
  back: (_a, tab) => { goBack(tab?.webContents); return 'Went back.'; },
  forward: (_a, tab) => { tab?.webContents.navigationHistory.goForward(); return 'Went forward.'; },
  new_tab: () => ({ text: 'Opened a new tab.', pinTab: openTab().id }),
};
const macrosFeature = require('./features/macros-runtime').create({
  ipcMain,
  dialog: electronDialog,
  win: () => win,
  file: path.join(app.getPath('userData'), 'macros.json'),
  documentsDir: () => app.getPath('documents'),
  agent,
  send: (channel, payload) => ui()?.send(channel, payload),
  broadcast: (channel, payload) => { for (const wc of skillSurfaces()) wc.send(channel, payload); },
  emitTo: (channel, payload) => { for (const t of tabs) if (t.settings && alive(t)) t.view.webContents.send(channel, payload); },
  target: macroTargetTab,
  tabById: (id) => macroTab(tabs.find((t) => t.id === id)),
  tabList: () => tabs.filter((t) => alive(t) && !t.settings && !t.managerPage && !t.isolated).map((t) => ({ id: t.id, url: realUrl(t.view.webContents), title: t.view.webContents.getTitle(), active: t.id === activeId })),
  openTab: (url) => openTab(url),
  switchTab: (id) => switchTab(id),
  tabLoaded: (tab) => new Promise((resolve) => {
    const wc = tab.webContents;
    if (wc.isDestroyed() || !wc.isLoading()) { resolve(); return; }
    const done = () => { clearTimeout(timer); wc.removeListener('did-stop-loading', done); resolve(); };
    const timer = setTimeout(done, 15000);
    wc.once('did-stop-loading', done);
  }),
  actions: macroActions,
  clipboardText: async () => String(await clipboard.readText()).slice(0, 50000),
  readSelection: async (wc) => String(await skillWithin(wc.executeJavaScriptInIsolatedWorld(SKILL_WORLD, [{ code: 'String(getSelection())' }]))),
  openSettings: (section) => openSettingsPage(section),
  complete: (args) => (TEST && global.__macrosComplete ? global.__macrosComplete(args) : completeSkillJson(args)),
  sidebar: (text, opts) => ui()?.send('macros:sidebar', { text, ...opts }),
});
macrosFeature.register();
agent.browser.macros = macrosFeature; // the run_macro tool (ai/agent.js)
agent.browser.readingList = (input, tab, hidden) => require('./features/reading-list').toolText(input, { store: readingList(), tab, hidden }); // the reading_list tool (ai/agent.js)
if (TEST) global.__macros = macrosFeature;

// ---------- [settings] lumen://settings ----------

// [look] New-tab pages already open take a new background, accent or layout at once (the page
// reads its design from its hash, so a hash change is enough: no reload, nothing typed is lost).
function refreshNewTabs() {
  const open = allTabsEverywhere().filter((t) => alive(t) && isNewTab(t.view.webContents.getURL())); // every window's, not just the one in front
  if (!open.length) return;
  const url = newTabUrl();
  for (const t of open) t.view.webContents.executeJavaScript(`history.replaceState(null, '', ${JSON.stringify(url)}); dispatchEvent(new HashChangeEvent('hashchange'))`).catch(() => {});
}
// [widgets] What the AI status card is built from (features/aistatus-view.js shapes it): which providers have a key and which CLIs are
// installed and signed in, the model in use, the models being left alone after a limit, the usage Lumen counted, the chats running, the
// tabs the AI opened. Names, states and counts only: no key, token or address leaves this function.
const AI_FULL_ACCESS = { claudecode: 'claudeCodeFullAccess', grokbuild: 'grokBuildFullAccess', antigravity: 'antigravityFullAccess', codex: 'codexFullAccess' }; // read generically: a setting that doesn't exist is simply not shown
function aiStatusFacts() {
  const s = readSettings();
  const now = Date.now();
  const apis = [];
  if (anthropicUsable()) apis.push('anthropic');
  for (const p of Object.keys(providers.PROVIDERS)) if (providerKey(p)) apis.push(p);
  const cli = aiAgents.cliStatus();
  let model = effectiveModel();
  if (autoModel.isAuto(model)) model = agent.messages?.settings?.autoLast?.id || null; // [auto model] the status card names the model that last answered; before any, no row is marked
  const provider = model ? aiFallback.providerOf(model) : null;
  const bare = model ? String(model).replace(/^[a-z][a-z0-9]*:/, '') : '';
  const cooling = {};
  for (const [id, entry] of Object.entries(aiFallback.shared.snapshot(now))) cooling[id] = { ...entry, ...(entry.model ? { model: (MODELS[entry.model] && MODELS[entry.model].label) || modelNames.prettyModel(entry.model) || entry.model } : {}) };
  const glance = usage.glance(now);
  return {
    apis,
    engines: cli,
    current: model ? { provider, label: (MODELS[bare] && MODELS[bare].label) || modelNames.prettyModel(bare) || bare } : null,
    cooling,
    meter: glance.meter,
    grokLimit: glance.grokLimit,
    codexLimit: glance.codexLimit,
    codexMeter: glance.codexMeter,
    agyLimit: glance.agyLimit, // [usage] Antigravity's quota message (its reset time)
    rate: glance.rate, // [usage] each API provider's tightest rate-limit reading (from reply headers)
    effort: s.aiEffort || {}, // [ai] the reasoning effort the user chose per AI
    today: glance.today,
    fullAccess: Object.fromEntries(Object.entries(AI_FULL_ACCESS).map(([id, key]) => [id, s[key] === true ? true : s[key] === false ? false : undefined])),
    runs: { working: runSlots.size(), waiting: runSlots.waitingIds().length, max: runSlots.limit },
    aiTabs: [...winRecs].filter(rcAlive).reduce((n, rec) => n + tabsOf(rec).filter((tab) => manners.isAiTab(tab)).length, 0),
    handsOff: s.aiHandsOff === true,
    showBars: s.usageBars !== false, // [usage bars] Settings → Usage
  };
}
// [widgets] features/widgets.js: fresh data reaches open new-tab pages the same way (batched, as
// several widgets often finish together).
let widgetRefreshTimer = null;
// The widgets' view of an engine (features/music-engine.js): its calls, with a test fake able to stand in for any of them.
// A music card's read starts the engine's hidden page (a whole web player: ~300 MB). A page nobody can see (the spare
// new-tab page waiting for Ctrl+T, a new-tab page in a background tab) must not start it: no new-tab page in front of
// any window means a read only looks at what is already known. The page asks again when it is shown (it refreshes when it becomes visible).
const newTabInFront = () => [...winRecs].some((rec) => rcAlive(rec) && !isSpare(rec) && !rec.agent && !rec.win.isMinimized() && tabsOf(rec).some((t) => t.id === activeIdOf(rec) && alive(t) && isNewTab(t.view.webContents.getURL())));
const engineFacade = (engine, fake) => Object.fromEntries(['read', 'control', 'seek', 'playItem', 'playNext', 'playLater', 'command', 'search', 'searchMore', 'readItem', 'loadThumbs', 'warm', 'signIn', 'showPlayer', 'refreshLists', 'reload'].map((name) => [name, (...args) => (TEST && fake()?.[name] ? fake()[name](...args) : name === 'read' && !newTabInFront() ? engine().read({ ...args[0], wake: false }) : engine()[name](...args))]));
// After sleep or a network change Chromium may hold dead sockets and a stale DNS cache; drop both so the next request makes fresh ones.
function resetNetwork() {
  const ses = session.defaultSession;
  return Promise.all([ses.closeAllConnections?.(), ses.clearHostResolverCache?.()]).catch(() => {});
}
// The cards' own session for when the browser's is stuck (widgets.js request()): in memory, no cookies kept, the profile's
// proxy and privacy headers mirrored. `renew`: it failed too, so a new one.
let cardNet = null;
function cardFetch(url, options, { renew = false } = {}) {
  if (!cardNet || renew) {
    cardNet = session.fromPartition(`lumen-cards-${Date.now()}`);
    try { settingsBackend.mirrorSession(cardNet); } catch { /* the defaults are fine */ }
  }
  return cardNet.fetch(url, options);
}
const widgets = createWidgets({
  readSettings, writeSettings,
  fetch: (url, options) => net.fetch(TEST && global.__widgetFetchMap ? global.__widgetFetchMap(url) : url, options), // (tests map Spotify's picture hosts, which cannot be reached on https without a port, to a local server)
  resizeThumb: (bytes) => resizeArt(bytes, 128, 75), // a row's or tile's picture in a card: 128 px (rows draw 28, Home tiles 112), about 4 KB
  freshFetch: cardFetch, // a request the browser's session fails at once (net::ERR_FAILED) is sent again through this
  resetNetwork, // a card that got no answer from the network drops these before it asks again (Try again, its retries)
  getSecret: widgetSecret,
  setSecret: setWidgetSecret,
  canKeepSecrets: () => safeStorage.isEncryptionAvailable(), // checked before a sign-in starts, not after consent
  // OAuth consent pages (Gmail) open in the user's own browser, never in a Lumen tab; https only.
  openExternal: (url) => { if (!/^https:\/\/accounts\.google\.com\//.test(url)) throw new Error('Refusing to open that address.'); return shell.openExternal(url); },
  // GitHub sign-in (features/github-auth.js): the device-flow page opens in a Lumen tab, https://github.com/login/device only (a test only
  // records it); the shared token's other user is the GitHub connector, which is set up or taken down to match whenever the sign-in changes.
  openGithubSignIn: (url) => {
    if (/^https:\/\/github\.com\/login\/device(?:[?#]|$)/.test(String(url))) return openTab(url);
    if (TEST) { (global.__githubOpened ||= []).push(String(url)); return undefined; }
    throw new Error('Refusing to open that address.');
  },
  githubClientId: () => (TEST && global.__githubClientId) || '', // (the constant in features/github-auth.js, or LUMEN_GITHUB_CLIENT_ID, unless a test stands one in)
  githubPollScale: () => (TEST && global.__githubPollScale) || 1, // (a test shrinks the device flow's waits)
  onGithubChange: () => { try { connectorsSvc().syncShared('github'); } catch { setTimeout(() => { try { connectorsSvc().syncShared('github'); } catch { /* the connector looks again at the next sign-in change */ } }, 1500).unref?.(); } }, // (once more if the file was busy)
  githubInUse: () => { try { return connectorsSvc().usesShared('github'); } catch { return false; } },
  spotifyWebSignedIn: () => spotifyWeb.isSignedIn(),
  // The Gmail widget's default mode: read the inbox's Atom feed with the Google sign-in already in Lumen's normal session.
  googleMail: {
    fetch: (url) => (TEST && global.__googleMailFake ? global.__googleMailFake(url) : googleMailFeed(url)),
    openSignIn: (url) => { if (!/^https:\/\/accounts\.google\.com\//.test(url)) throw new Error('Refusing to open that address.'); openTab(url); },
  },
  spotifyWebStatus: () => spotifyWeb.status(),
  spotifyWebReload: () => spotifyWeb.reload(),
  // The Status mode: the Apple Music engine (features/apple-music-engine.js). Tests may stand in a fake for any of its calls.
  appleMusic: engineFacade(() => appleMusicEngine, () => global.__appleMusicFake),
  spotifyEngine: engineFacade(() => spotifyEngine, () => global.__spotifyEngineFake),
  spotifyEngineSignedIn: () => spotifyEngine.signedIn(),
  appleMusicWebSignedIn: () => appleMusicEngine.signedIn(),
  appleMusicWebStatus: () => appleMusicWeb.status(),
  appleMusicWebReload: () => appleMusicWeb.reload(),
  routines: () => bgTasks.routineView(), // the Routines card (features/routines-card.js shapes it)
  routineAct: (req) => bgTasks.routineAct(req), // its New routine and result buttons: open the sidebar's editor / the routine's result page
  aiStatus: () => (TEST && global.__aiStatusFacts ? global.__aiStatusFacts() : aiStatusFacts()), // (tests may stand in the facts) // the AI status card: facts Lumen already holds, no secrets (features/aistatus-view.js)
  tradingviewLists: () => (TEST && global.__tvLists ? global.__tvLists() : tradingviewAccountLists()), // tests never reach TradingView
  onUpdate: () => {
    clearTimeout(widgetRefreshTimer);
    widgetRefreshTimer = setTimeout(() => {
      refreshNewTabs();
      spotifyWeb.sync(); appleMusicWeb.sync(); // a web card added, removed or switched to another mode: its view is placed, hidden or dropped now (the page only pushes a slot while it has one)
      for (const t of tabs.filter((x) => x.settings && alive(x))) t.view.webContents.send('widgets:changed'); // Settings shows it too (a sign-in Google ended)
    }, 60);
  },
  t: (key) => t(key),
  focusApp: () => { const w = BrowserWindow.getFocusedWindow() || winRecs.values().next().value?.win; if (w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); app.focus?.({ steal: true }); } },
  // A card's gear (edit mode on the new-tab page): Settings > Home > Widgets opens that widget's editor. An open Settings tab
  // is reused (not reloaded, not duplicated) and told to read the request; a new or still-loading one reads it as it builds.
  onConfigure: () => {
    const tab = tabs.find((t) => t.id === openSettingsPage('widgets'));
    const wc = tab?.view?.webContents;
    const tell = () => { if (wc && !wc.isDestroyed()) wc.send('widgets:edit'); };
    if (wc && !wc.isDestroyed()) { if (wc.isLoading()) wc.once('did-stop-loading', tell); else tell(); } // (did-stop-loading, not did-finish-load: pointing an open Settings tab at another section is an in-page navigation, which never finishes a load)
  },
  // Tests point the connectors at a local server (global.__widgetEndpoints); nothing else can.
  endpoints: () => (TEST && global.__widgetEndpoints) || {},
  rateMax: () => (TEST && global.__widgetRateMax) || 0, // tests that drive many refreshes raise the per-minute cap
});
aiStatusSoon = widgets.aiStatusSoon;
routinesSoon = widgets.routinesSoon;
scheduler.every('ai-status', 15e3, () => { try { widgets.aiStatusChanged(); } catch { /* the card only looks again */ } }, { whenHidden: 60e3 }); // (runs at once when a window is back) // a limit that ended, a tab the AI opened or closed: nothing else announces them
if (TEST) global.__widgets = widgets;
// A profile that had no settings file when Lumen started (a fresh install) and has no cards yet gets the Files card: the new-tab page is not empty
// the first time, and Files has a place to start from. Only the first launch (the settings file exists from then on); tests do not call it
// unless they ask (global.__seedFirstRunWidgets), so the default layout they assume stays empty.
function seedFirstRunWidgets({ force = false } = {}) {
  if (!force && settingsFileExisted !== false) return Promise.resolve(false);
  if ((readSettings().homeWidgets || []).length) return Promise.resolve(false);
  return widgets.save({ type: 'files', title: t('newtab.edit.type.files') }).then(() => true).catch(() => false);
}
if (TEST) global.__seedFirstRunWidgets = seedFirstRunWidgets;

// [widgets] Gmail through the Google sign-in in Lumen (features/gmail-atom.js): one GET of an account's inbox Atom feed,
// read with the normal session's cookies. Only https://mail.google.com/mail/u/N/feed/atom (checked again here), no
// redirect is followed (a sign-in redirect reads as signed out), answer capped at 1 MB. Nothing is logged.
function googleMailFeed(url) {
  return new Promise((resolve, reject) => {
    if (!require('./features/gmail-atom').isFeedUrl(url)) return reject(new Error('Not a Gmail feed address.'));
    const req = net.request({ url, method: 'GET', session: session.defaultSession, useSessionCookies: true, redirect: 'manual', cache: 'no-store' });
    req.setHeader('Accept', 'application/atom+xml, application/xml;q=0.9, */*;q=0.1');
    const timer = setTimeout(() => { req.abort(); reject(new Error('Gmail took too long')); }, 15e3);
    const done = (fn, v) => { clearTimeout(timer); fn(v); };
    req.on('redirect', (status) => { req.abort(); done(resolve, { status, body: '' }); });
    req.on('response', (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > 1 << 20) { req.abort(); done(reject, new Error('Gmail sent too much')); } else chunks.push(c); });
      res.on('end', () => done(resolve, { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => done(reject, e));
    });
    req.on('error', (e) => done(reject, e));
    req.end();
  });
}
// A Google sign-in appearing or ending in Lumen's session (its main session cookies, not the rotating timestamp ones)
// makes Gmail cards that read through it look again.
const GOOGLE_SIGNIN_COOKIES = new Set(['SID', '__Secure-1PSID', '__Secure-3PSID']);
app.whenReady().then(() => {
  session.defaultSession.cookies.on('changed', (_e, cookie) => {
    if (GOOGLE_SIGNIN_COOKIES.has(cookie?.name) && /(^|\.)google\.[a-z.]+$/.test(String(cookie.domain))) widgets.googleSessionChanged();
  });
});

// [widgets] The user's TradingView watchlists, for the TradingView widget's import and sync: one fixed
// address (features/tradingview-view.js ACCOUNT_URL), GET only, read with the normal session's cookies so
// it answers for the account signed in on tradingview.com in Lumen. No redirects, answer capped at 1 MB.
function tradingviewAccountLists() {
  return new Promise((resolve, reject) => {
    const req = net.request({ url: require('./features/tradingview-view').ACCOUNT_URL, method: 'GET', session: session.defaultSession, useSessionCookies: true, redirect: 'error', cache: 'no-store' });
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
// [widgets] The music cards' Web players (features/web-player.js): the Spotify widget's (features/spotify-web.js) and the
// Apple Music widget's (features/apple-music-web.js), one persistent view each, in the normal session.
const musicWebDeps = (hasWidget, testUrl, drmProbe, keepAlive, onAuth) => ({
  WebContentsView, get session() { return session.defaultSession; }, isWebUrl, // getter: defaultSession is only usable after app ready
  getWindow: () => win,
  getBounds: () => contentBounds,
  userAgent: () => app.userAgentFallback, // (browser/chrome-identity.js: a sign-in page, Apple's above all, refuses "Electron" in it)
  hideWindow: (w) => { if (TEST_BACKGROUND && w && !w.isDestroyed()) { w.setOpacity(0); w.setIgnoreMouseEvents(true); w.setPosition(-5000, -5000); w.showInactive(); } }, // (tests only: a sign-in popup never shows or takes focus)
  activeNewTab: () => { const t = activeTab(); const tab = tabs.find((x) => x.id === activeId); return t && tab && tab.view.getVisible() && !tab.fullscreen && isNewTab(t.webContents.getURL()) ? t.webContents : null; },
  hasWidget,
  keepAlive,
  openTab: (url) => { if (win && !win.isDestroyed()) openTab(url); },
  onSignIn: () => { try { onAuth?.(); } catch { /* the engine is not up yet */ } clearTimeout(widgetRefreshTimer); widgetRefreshTimer = setTimeout(refreshNewTabs, 60); },
  onStatus: () => { clearTimeout(widgetRefreshTimer); widgetRefreshTimer = setTimeout(refreshNewTabs, 60); }, // loading, offline, no Widevine: the card says which
  testUrl: () => (TEST && testUrl()) || '', // tests serve a stand-in for the site; nothing else can
  drmProbe: (wc) => (TEST && drmProbe() ? drmProbe()(wc) : wc.executeJavaScript(SW.DRM_PROBE)),
});
const spotifyWeb = SW.createSpotifyWeb(musicWebDeps(() => widgets.list().some((w) => w.type === 'spotify' && w.mode === 'web'), () => global.__spotifyWebUrl, () => global.__spotifyDrmProbe, () => true, () => spotifyEngine.authChanged())); // (the engine keeps the page, hidden, with no web card)
const appleMusicWeb = AMW.createAppleMusicWeb(musicWebDeps(() => widgets.list().some((w) => w.type === 'applemusic' && w.mode === 'web'), () => global.__appleMusicWebUrl, () => global.__appleMusicDrmProbe, () => true)); // (the engine keeps the page, hidden, with no web card)
if (TEST) { global.__spotifyWeb = spotifyWeb; global.__appleMusicWeb = appleMusicWeb; }
// [look] Music-reactive home screen: which Lumen window is playing sound, as a one-tab capture id for the new-tab page (features/music-react-source.js)
let musicReactSrc = null; // (loaded the first time the setting is on and the page asks: nothing of it at startup)
const musicCardsOn = () => { try { return widgets.list().some((w) => (w.type === 'spotify' || w.type === 'applemusic') && w.react === true); } catch { return false; } }; // (a music card with "React to music" on)
const musicReactOn = () => readSettings().newTabMusicReactive === true || musicCardsOn();
const musicReact = {
  get src() { return (musicReactSrc ||= require('./features/music-react-source').create({ isNewTab, enabled: musicReactOn })); },
  start: (wc) => (musicReactOn() ? musicReact.src.start(wc) : { ok: false, why: 'off' }),
  allowsDisplay: (wc, permission, details) => (permission === 'display-capture' || permission === 'media') && musicReactOn() && Boolean(musicReactSrc) && musicReactSrc.allowsDisplay(wc, permission, details),
  takeDisplay: (wc, top) => musicReactOn() && Boolean(musicReactSrc) && musicReactSrc.takeDisplay(wc, top),
};
// [widgets] The Apple Music engine (features/apple-music-engine.js): MusicKit in the hidden music.apple.com view above, plus the desktop
// Apple Music app as a fallback source (features/apple-music-native.js: a PowerShell helper on Windows, osascript on macOS; both only
// while a card is being read, and ended at quit). Album pictures are made small here (they travel in the new-tab page's address).
const resizeArt = (bytes, height = 160, quality = 82) => {
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (img.isEmpty()) return null;
  return (img.getSize().height > height ? img.resize({ height, quality: 'good' }) : img).toJPEG(quality);
};
const appleMusicNative = require('./features/apple-music-native').createNowPlaying({
  any: TEST && process.env.LUMEN_TEST_APPLE_MUSIC_ANY === '1', // tests only: any media app instead of Apple's
  resizeArt,
  onChange: () => widgets.engineChanged(),
});
// The engines' sign-in / player windows. LUMEN_TEST_BACKGROUND (tests only): off screen, see-through, never focused, like every other test window.
function engineWindow(opts) {
  if (!TEST_BACKGROUND) return new BrowserWindow(opts);
  const w = new BrowserWindow({ ...opts, show: false });
  w.setOpacity(0); w.setIgnoreMouseEvents(true); w.setPosition(-5000, -5000); w.showInactive();
  return w;
}
const appleMusicEngine = require('./features/apple-music-engine').createEngine({
  player: appleMusicWeb,
  native: appleMusicNative,
  resizeArt,
  fetchBytes: async (url) => { const res = await net.fetch(url, { headers: { Accept: 'image/*' } }); return res.ok ? Buffer.from(await res.arrayBuffer()) : null; }, // (the engine only asks for https addresses on mzstatic.com)
  BrowserWindow: engineWindow,
  hasCard: () => widgets.list().some((w) => w.type === 'applemusic'),
  respondMs: () => (TEST && global.__respondMs) || 0,
  onChange: () => widgets.engineChanged(),
});
if (TEST) global.__appleMusicEngine = appleMusicEngine;
// [widgets] The Spotify engine (features/spotify-engine.js): Spotify's own web player in the hidden open.spotify.com view above.
const spotifyEngine = require('./features/spotify-engine').createEngine({
  player: spotifyWeb,
  resizeArt,
  // Spotify's picture host answers WebP whatever is asked for, which nativeImage cannot read: the engine's own page (a Chromium that can) draws it small and gives back a JPEG.
  decodeArt: async (bytes) => {
    const wc = spotifyWeb.webContents();
    if (!wc || bytes.length > 400e3) return '';
    try {
      const out = await wc.executeJavaScript(`(async (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); const bmp = await createImageBitmap(new Blob([u], { type: 'image/webp' })); const h = Math.min(120, bmp.height); const w = Math.max(1, Math.round(bmp.width * h / bmp.height)); const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(bmp, 0, 0, w, h); return c.toDataURL('image/jpeg', 0.8); })(${JSON.stringify(Buffer.from(bytes).toString('base64'))})`);
      return typeof out === 'string' && out.length < 60000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(out) ? out : '';
    } catch { return ''; }
  },
  fetchBytes: async (url) => { const res = await net.fetch(url, { headers: { Accept: 'image/jpeg, image/png;q=0.9' } }); return res.ok ? Buffer.from(await res.arrayBuffer()) : null; }, // (JPEG or PNG: Spotify's picture host otherwise sometimes answers WebP, which the picture resizer cannot read, so the picture was dropped; the engine only asks for https addresses on scdn.co)
  BrowserWindow: engineWindow,
  hasCard: () => widgets.list().some((w) => w.type === 'spotify' && w.mode === 'status'),
  playerMissingMs: () => (TEST && global.__playerMissingMs) || 0,
  respondMs: () => (TEST && global.__respondMs) || 0,
  onChange: () => widgets.engineChanged(),
});
if (TEST) global.__spotifyEngine = spotifyEngine;
// The engines' bridges: only a hidden view's own page (the service's real address, or in tests a stand-in) may fetch its script or send state.
const engineSender = (event) => {
  for (const [web, engine, bridge, isPage, stand] of [[appleMusicWeb, appleMusicEngine, require('./features/apple-music-bridge'), AMW.isEnginePage, () => global.__appleMusicWebUrl], [spotifyWeb, spotifyEngine, require('./features/spotify-bridge'), SW.isEnginePage, () => global.__spotifyWebUrl]]) {
    const wc = web.webContents();
    if (!wc || event.sender !== wc || event.senderFrame !== wc.mainFrame) continue;
    let origin = '';
    try { origin = TEST && stand() ? new URL(stand()).origin : ''; } catch { /* no stand-in */ }
    return isPage(event.senderFrame.url, origin) ? { engine, bridge, web } : null;
  }
  return null;
};
ipcMain.on('musicengine:bridge-source', (event) => { event.returnValue = engineSender(event)?.bridge.BRIDGE_SOURCE || ''; });
ipcMain.on('musicengine:msg', (event, raw) => { const from = engineSender(event); if (!from) return; from.engine.onMessage(raw); from.web.emitState(raw); }); // (the engine first; then anyone listening on the player's onState)
app.on('before-quit', () => { spotifyEngine.destroy(); spotifyWeb.destroy(); appleMusicEngine.destroy(); appleMusicWeb.destroy(); appleMusicNative.destroy(); }); // (closing the engine's page stops its music)

// ---------- passkeys (features/passkeys.js): WebAuthn through Windows' own API, checked here per request ----------
// Which pages may ask, and to which window Windows Security belongs: the tab in front of a focused, visible window,
// never one the AI is working in or opened (agent windows, research tabs, a tab a run is using, an AI-opened tab,
// a signed-in-site tab the AI reads), so no AI tool can start or finish a ceremony.
function passkeyContext(wc) {
  if (!wc || wc.isDestroyed() || agentContents.has(wc)) return { ok: false, reason: 'ai' };
  const front = (w, active) => Boolean(active && w && !w.isDestroyed() && w.isFocused() && w.isVisible() && !w.isMinimized());
  for (const rec of winRecs) {
    if (!rcAlive(rec) || isSpare(rec)) continue;
    const t = tabsOf(rec).find((x) => alive(x) && x.view.webContents === wc);
    if (!t) continue;
    if (rec.agent || t.isolated || t.aiLock || manners.isAiTab(t) || agent.usingTab(t.id)) return { ok: false, reason: 'ai' };
    const w = rec === curRec ? win : rec.win;
    return front(w, activeIdOf(rec) === t.id) ? { ok: true, win: w, inPrivate: false } : { ok: false, reason: 'not-front' };
  }
  const p = privateWindows.tabWindow(wc);
  if (p) return front(p.win, p.active) ? { ok: true, win: p.win, inPrivate: true } : { ok: false, reason: 'not-front' };
  // A sign-in popup (window.open: "Sign in with Microsoft / Google", an SSO provider) is where many passkey prompts
  // come from; it was refused as "not a tab". The user's own popup, focused, may ask; Windows Security belongs to it.
  const popup = passkeyPopups.get(wc);
  if (popup && !popup.isDestroyed() && !aiPopups.has(popup)) return front(popup, true) ? { ok: true, win: popup, inPrivate: false } : { ok: false, reason: 'not-front' };
  return { ok: false, reason: 'not-a-tab' };
}
const passkeys = require('./features/passkeys').createPasskeys({
  ipcMain,
  enabled: () => readSettings().passkeys !== false,
  context: passkeyContext,
  // The API at all: hidden (as before) in the AI's own pages; a page Lumen can't place yet keeps it, and the
  // request itself is checked against passkeyContext.
  candidate: (wc) => {
    if (agentContents.has(wc) || (researchSes && wc.session === researchSes)) return false;
    for (const rec of winRecs) {
      const t = rcAlive(rec) ? tabsOf(rec).find((x) => alive(x) && x.view.webContents === wc) : null;
      if (t) return !(rec.agent || t.isolated || manners.isAiTab(t));
    }
    return true;
  },
});
passkeys.attach();
if (process.platform === 'win32') app.whenReady().then(() => setTimeout(() => passkeys.warm(), 1500));
if (TEST) global.__passkeys = { info: () => passkeys.info(), busy: () => passkeys.busy(), context: (id) => { const wc = require('electron').webContents.fromId(id); return wc ? passkeyContext(wc) : null; }, openBackground: (url) => openTab(url, { background: true })?.webContents?.id ?? null };

// [a11y mode] Accessibility another program switched on (a password manager's desktop app, Phone Link) is cut down to Lumen's own controls unless a
// screen reader runs: with the full set, big pages stalled the main process for seconds on every focus change (features/a11y-mode.js).
let a11yMode = null;
app.whenReady().then(() => {
  a11yMode = require('./features/a11y-mode').create({ app, mode: () => readSettings().screenReaderSupport || 'auto', log: (m) => console.warn(m), ...(TEST ? { probe: () => Promise.resolve(global.__a11yScreenReader ?? false) } : {}) });
  a11yMode.sync();
  if (TEST) global.__a11yMode = a11yMode;
});
// [gpu health] Survives graphics-driver resets (features/gpu-health.js): logs them, leaves the GPU alone for a few seconds after one (the new-tab
// effects pause, the sidebar moves without a snapshot) and, if drawing fell to software, offers a Restart (the same relaunch that saves the session).
let gpuHealth = null;
const sendAllUis = (channel, payload) => { for (const rec of winRecs) if (rcAlive(rec) && !rec.win.webContents.isDestroyed()) rec.win.webContents.send(channel, payload); };
const earlyGpuLoss = []; // a GPU loss before the module is loaded is replayed to it
app.on('child-process-gone', (_e, details) => { if (!gpuHealth && details?.type === 'GPU') earlyGpuLoss.push(details); });
// Loaded a few seconds after the window is up, not at startup (the startup module budget, test/e2e/perf-budget.js).
app.whenReady().then(() => setTimeout(() => {
  gpuHealth = require('./features/gpu-health').install({
    app, screen, version: app.getVersion(), log: (m) => console.warn(m),
    hwOn: () => readSettings().hardwareAcceleration !== false,
    onSoftware: () => graphicsMode.markSoftware(), // [software mode] drawing fell to software: the renderers lighten at once, not at the next start
    onLoss: () => { // a slide's snapshot or frozen view must not outlive the GPU that drew it
      for (const rec of winRecs) if (rcAlive(rec)) { clearTimeout(freezeTimers.get(rec)); freezeSeq.set(rec, ++freezeCounter); }
      if (viewFrozen) { viewFrozen = false; layout(); }
    },
    send: (channel, payload) => {
      sendAllUis(channel, payload);
      if (channel === 'gpu:calm') { // the new-tab pages (their own web contents) pause their animated effect
        for (const t of allTabsEverywhere()) if (alive(t) && isNewTab(t.view.webContents.getURL())) t.view.webContents.executeJavaScript(`window.setBackdropCalm?.(${payload ? 'true' : 'false'})`).catch(() => {});
      }
    },
    dir: () => path.join(app.getPath('userData'), 'diagnostics'),
    ...(TEST ? { readStatus: () => global.__gpuStatusOverride || app.getGPUFeatureStatus() } : {}),
  });
  if (TEST) global.__gpuHealth = gpuHealth;
  for (const d of earlyGpuLoss.splice(0)) gpuHealth.gpuGone(d);
}, 4000).unref());
ipcMain.on('gpu:restart', (_e, safe) => {
  if (TEST) { global.__gpuRestarts = (global.__gpuRestarts || 0) + 1; global.__gpuRestartSafe = safe === true; return; } // tests check the click, not a relaunch
  // safe: this run only, hardware acceleration off (--lumen-safe-gpu, settings-backend.js applyAtLaunch); the next normal start is hardware again
  relaunchLumen(safe === true);
});
function relaunchLumen(safe) {
  const args = process.argv.slice(1).filter((a) => a !== '--lumen-safe-gpu');
  app.relaunch({ args: safe === true ? [...args, '--lumen-safe-gpu'] : args }); // before-quit saves the session, as for every other restart
  app.quit();
}
const settingsBackend = settingsPage.create({
  refreshAccent: () => accentCss?.refreshAll(), // [look] the accent changed: every page of Lumen's own swaps its sheet
  passkeys, // [passkeys] Settings → Privacy
  usage, // [usage] You and AI → Usage
  cliInfo: () => aiAgents.cliInfo(), // [ai] Settings → AI → AI providers: each CLI's version, path and sign-in
  refreshNewTabs,
  widgets, // [widgets] Settings → Appearance → Widgets
  showWhatsNew: () => whatsNew.open(), // Settings → Updates → What's new
  peekSettings: () => settingsCache || readSettings(), // (the per-request header hook: no copy, no re-validation)
  chromeHintHeaders: UA_HINT_HEADERS, // [identity] Sec-CH-UA on every secure request, as Chrome sends
  chromeHighEntropy: uaHighEntropyHeaders, // [identity] Sec-CH-UA-Arch… for an origin that asked (Accept-CH)
  systemLanguages: () => chromeLanguages.list(), // [identity] Accept-Language when Settings → Languages is empty: the system's, as Chrome sends
  app, session, nativeTheme, dialog, shell, readSettings, writeSettings, ui,
  BrowserWindow, clipboard, // [widgets] the Slack setup window and clipboard watch (features/slack-setup.js)
  broadcastUi: (channel, payload) => { // [ai manners] every window's browser UI and the chat page, not just the one in front
    const to = new Set([ui(), ...[...winRecs].filter(rcAlive).map((r) => r.win.webContents), ...(chatPageRt?.surfaces() || [])]);
    for (const wc of to) if (wc && !wc.isDestroyed()) wc.send(channel, payload);
  },
  win: () => win,
  tabContents: () => tabs.filter((t) => alive(t) && !t.settings).map((t) => t.view.webContents),
  tabsInfo: () => tabs.filter(alive).map((t) => ({ id: t.id, title: t.view.webContents.getTitle(), wc: t.view.webContents, settings: Boolean(t.settings) })),
  history: () => history,
  saveHistory: saveHistorySoon,
  siteActivity,
  downloads: downloads.list,
  sendDownloads: downloads.send,
  permissionDecisions,
  deviceGrants, // [devices] declared with the permissions below (a getter would be needed if it were read before then)
  uninstallExtension,
  cliPinnedVersion: () => cliAuth.PINNED_VERSION,
  openTab: (url) => openTab(url),
  isSettingsSender,
  onSearchEngineReset: () => ui()?.send('search-engine', engineFor(DEFAULT_ENGINE)),
  onSafeBrowsingChange: () => { safeBrowsing.refresh().catch(() => {}); },
  onFocusChange: () => onFocusSettings(), // [focus] a schedule or the site list changed
  focusLocked: () => focusIsOn(), // [focus] ...and while a session is on they can't be edited
  onTelegramChange: () => telegram.refresh(), // [telegram] start or stop listening to the bot
  onTabSleepChange: () => tabSleepSettingChanged(),
  onScreenReaderChange: () => a11yMode?.settingChanged(), // [a11y mode]
  onRoutineWebhooksChange: () => bgTasks.syncWebhooks(), // [routines] Settings → Routines → web links: the 127.0.0.1 listener follows the switch and the port
  tabSleep: { status: () => sleepStatus(), unloadAll: () => unloadBackgroundTabs(null), currentSite: () => currentSleepSite() }, // [tabs] Settings > Tabs > Page unloading
  onTabPreloadChange: () => schedulePreload(1500),
  onTabReadyChange: () => { for (const rec of [...winRecs]) scheduleReadySync(rec); },
  onSwitchTimingChange: () => syncSwitchTiming(),
  switchTiming: { count: () => (switchTimingLoaded ? switchTiming.count() : 0), export: exportSwitchTimings, clear: () => { if (switchTimingLoaded) switchTiming.clear(); } }, // [diagnostics] Settings > Advanced > Record tab-switch timings
  onHideActivityChange: () => activityScripts.refresh(), // [hide activity] the frames' DevTools scripts follow the settings
  performance: perfMode,
  graphics: graphicsMode,
  translateLocal: () => translateLocal(), // [translate] Settings → Translation → language packs
});
accentCss = require('./features/accent-css').create({ rendererDir: path.join(__dirname, 'renderer'), accent: () => settingsBackend.uiPrefs().accent, all: () => require('electron').webContents.getAllWebContents() }); // [look]
for (const c of require('electron').webContents.getAllWebContents()) accentCss.apply(c); // (pages already open)

// One settings tab: reuse it if open. `replace` is a tab (a blank new-tab page) it takes the place of.
// [settings intent] The user is about to open Settings (pressed the menu button, or is typing lumen://settings): the page starts loading
// in a view of its own now, and the tab takes it over when the open follows. Nothing is kept: with no open within SPARE_SETTINGS_MS it is closed.
const SPARE_SETTINGS_MS = 5000;
function dropSpareSettings() {
  const s = spareSettings;
  if (!s) return;
  spareSettings = null;
  clearTimeout(s.timer);
  try { withWindow(s.rec, () => win.contentView.removeChildView(s.view)); } catch { /* gone */ }
  try { if (!s.view.webContents.isDestroyed()) s.view.webContents.close(); } catch { /* gone */ }
}
function prepareSettings() {
  if (spareSettings || quitting || !app.isReady() || tabs.some((t) => t.settings && alive(t))) { if (spareSettings) { clearTimeout(spareSettings.timer); spareSettings.timer = setTimeout(dropSpareSettings, SPARE_SETTINGS_MS); spareSettings.timer.unref?.(); } return; }
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, ...settingsBackend.tabWebPreferences(true) } });
  try { view.setBounds({ x: 0, y: 0, ...(withWindow(curRec, () => ({ width: contentBounds.width, height: contentBounds.height })) || { width: 1200, height: 800 }) }); } catch { /* sized when it becomes a tab */ }
  try { view.setBackgroundColor(pageBackground()); } catch { /* gone */ }
  const s = { view, rec: curRec, timer: setTimeout(dropSpareSettings, SPARE_SETTINGS_MS) };
  // A page in a view that is not in the window runs at background priority (it loaded in about 330 ms instead of 200): it is in the window,
  // shown but out of sight, far to the left of it, until it becomes the tab (which puts it in place).
  try { const b = view.getBounds(); view.setBounds({ ...b, x: -30000 }); win.contentView.addChildView(view); view.setVisible(true); } catch { /* it loads without */ }
  s.timer.unref?.();
  view.webContents.once('render-process-gone', () => { if (spareSettings === s) dropSpareSettings(); });
  spareSettings = s;
  view.webContents.loadURL(settingsPage.urlFor('')).catch(() => {});
}
function takeSpareSettings() {
  const s = spareSettings;
  if (!s) return null;
  spareSettings = null;
  clearTimeout(s.timer);
  const wc = s.view.webContents;
  if (wc.isDestroyed() || wc.isCrashed()) { try { withWindow(s.rec, () => win.contentView.removeChildView(s.view)); } catch { /* gone */ } try { wc.close(); } catch { /* gone */ } return null; }
  try { s.view.setVisible(false); } catch { /* the tab shows it */ }
  return s.view;
}
ipcMain.on('prepare-settings', () => prepareSettings());
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
  const spare = takeSpareSettings(); // (already loading: the tab takes it over)
  const { id } = openTab(url, { settings: true, view: spare });
  if (spare) {
    const wc = spare.webContents;
    const go = () => { if (!wc.isDestroyed() && wc.getURL() !== url) wc.loadURL(url).catch(() => {}); };
    if (section) { if (wc.isLoading()) wc.once('did-stop-loading', go); else go(); }
  }
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
  global.__settings = { backend: settingsBackend, page: settingsPage, open: openSettingsPage, prepare: prepareSettings, hasSpare: () => Boolean(spareSettings), tabs: () => tabs.filter(alive).map((t) => ({ id: t.id, settings: Boolean(t.settings), url: t.view.webContents.getURL() })), contents: (id) => tabs.find((t) => t.id === id)?.view?.webContents, historyUrls: () => [...history.keys()], permissions: permissionDecisions };
}

function applyContentBounds(bounds) {
  contentBounds = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
    fullWidth: Math.max(0, Math.round(Number(bounds.fullWidth) || 0)), // the page area's width with the sidebar closed
  };
  if (curRec) { curRec.boundsReported = true; curRec.holdViews = false; } // (a first tab opened while the UI loaded shows now)
  layout();
}
ipcMain.on('content-bounds', (_e, bounds) => applyContentBounds(bounds));
// The same, answered once the page view has its new size: a sidebar closing without a slide waits for it before it leaves, so the
// view has already widened over it and no frame shows an empty strip.
ipcMain.handle('content-bounds:ack', (_e, bounds) => { applyContentBounds(bounds); return true; });

// Each freeze and thaw bumps the window's freeze number. A capture that finishes after a thaw (the
// sidebar settled before the snapshot was ready) must not hide the page: it used to, and nothing thawed
// it again, which left the page area blank (the purple of a running task) until the sidebar moved. The
// flag is also set on the window that asked, not whichever window is current when the capture ends.
// A freeze that is never thawed (a lost message) ends by itself.
const freezeSeq = new WeakMap(); // window rec -> number
const freezeReady = new WeakMap(); // window rec -> the freeze number whose snapshot was captured and sent (view:frozen hides the live view once it is on screen)
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
  if (gpuHealth?.calmActive() || splitView()) return null; // [split view] a snapshot shows one page: with two on show the sidebar changes without one. // [gpu health] the GPU is recovering: no capture (the UI changes the sidebar without a snapshot). [software mode] the UI does not ask for one for the sidebar (app.js lumenSoftwareGfx); the tab search popup still does, it needs the still image to sit over
  const rec = curRec;
  const wc = activeTab()?.webContents;
  if (!rec || !wc || tabs.find((t) => t.id === activeId)?.fullscreen) return null;
  const seq = ++freezeCounter;
  freezeSeq.set(rec, seq);
  try {
    const image = await wc.capturePage();
    await new Promise((r) => setImmediate(r)); // (the capture's own hand-over to main is a task of its own; the work on it starts in the next one)
    if (image.isEmpty() || freezeSeq.get(rec) !== seq || !rcAlive(rec)) return null; // thawed meanwhile
    // The live view stays where it is until the UI has the snapshot on screen (view:frozen below). Hiding it here, before the image
    // had been decoded and painted, left the page area blank for a few frames at the start of every sidebar open and close.
    freezeReady.set(rec, seq);
    armFreezeTimeout(rec, seq);
    // Encoded at the size it is shown (CSS pixels, not device pixels) and sent as bytes: the renderer makes a blob
    // URL from them, so neither side builds or decodes a multi-megabyte base64 string (features/snapshot-size.js).
    const target = snapshotSizer.snapshotSize(image.getSize(), cssSize);
    // [hang recorder] In two bands, a turn of the event loop between them (features/snapshot-size.js): the whole resize is ~9 ms of main.
    const shot = target ? await snapshotSizer.resizeInBands(image, target, { createFromBitmap: require('electron').nativeImage.createFromBitmap, tick: () => new Promise((r) => setImmediate(r)), mark: hang.mark }) : image;
    await new Promise((r) => setImmediate(r)); // (the resize and the JPEG encode are each ~5 ms of main: as two tasks, input and frames get a turn between them)
    if (freezeSeq.get(rec) !== seq || !rcAlive(rec)) return null; // (thawed in that turn)
    return hang.mark('freeze:encode', () => shot.toJPEG(snapshotSizer.JPEG_QUALITY));
  } catch {
    return null;
  }
});
// Capture once at startup so the first real snapshot doesn't pay the pipeline's warm-up cost.
ipcMain.handle('view:warm', async (e) => {
  if (recOfSender(e.sender)?.agent) return false; // [agent window] its UI asks too, but nobody opens its sidebar from a warm capture: a full-size capture, resize and JPEG encode (~15 ms of main) per window, on the user's main process while other sessions' calls wait
  if (graphicsMode.software()) return false; // [software mode] no capture to warm up
  const wc = activeTab()?.webContents;
  if (!wc) return false;
  try {
    const image = await wc.capturePage(); // full size: the first full readback is the slow one
    // The first resize, bitmap copy and JPEG encode of a capture this size are cold (about twice a warm one): done now, a task each, so the first
    // freeze a user sees (the Ctrl+Shift+F picker, the sidebar) is as short as the rest.
    const { width, height } = image.getSize();
    const target = { width: Math.max(64, Math.round(width * 0.66)), height: Math.max(64, Math.round(height * 0.66)) };
    const tick = () => new Promise((r) => setImmediate(r));
    const small = await snapshotSizer.resizeInBands(image, target, { createFromBitmap: require('electron').nativeImage.createFromBitmap, tick });
    await tick();
    small.toJPEG(snapshotSizer.JPEG_QUALITY);
  } catch {}
  return true;
});
ipcMain.on('view:frozen', () => { // the snapshot is painted in the UI under the live view: now the view can go
  const rec = curRec;
  if (!rec || !rcAlive(rec) || freezeReady.get(rec) !== freezeSeq.get(rec) || viewFrozen) return; // thawed (or frozen again) meanwhile
  armFreezeTimeout(rec, freezeSeq.get(rec));
  viewFrozen = true;
  layout();
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
// ---------- [files] pinned and recent files (features/files.js; loaded on first use) ----------
// The browser UI (files:*, gated by UI_ONLY_IPC), Settings (settings:files-*, gated by PRIVILEGED_IPC) and the new-tab page's own preload
// (newtab-files:*, checked here: it must be a tab's top frame showing renderer/newtab.html) call the same functions.
let filesRt = null;
const insidePath = (dir, p) => { const rel = path.relative(dir, p); return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel)); };
// A local file's address in a tab: a PDF, email or deck in Lumen's own viewer, anything else as the file itself (as File > Open does).
function fileTabUrl(file) {
  const href = pathToFileURL(file).href;
  if (/\.pdf$/i.test(file)) return pdfViewer.viewerUrl(href);
  if (emlViewer.shouldOpenInPlace({ url: href, filename: file })) return emlViewer.viewerUrl(href);
  if (slidesViewer.shouldOpenInPlace({ url: href, filename: file })) return slidesViewer.viewerUrl(href);
  return href;
}
const filesShell = (name, p) => (TEST && global.__filesShell ? global.__filesShell(name, p) : name === 'show' ? shell.showItemInFolder(p) : shell.openPath(p)); // tests do not start the OS's programs
function filesBroadcast() { // the list changed: the UI, every new-tab page and Settings look again
  for (const rec of winRecs) {
    const live = rec === curRec ? { win, tabs } : rec;
    if (!live.win || live.win.isDestroyed()) continue;
    try { live.win.webContents.send('files:changed'); } catch { /* closing */ }
    for (const t of live.tabs) {
      const wc = t.view?.webContents;
      if (!wc || wc.isDestroyed()) continue;
      const url = wc.getURL();
      if (isNewTab(url)) wc.send('newtab-files:changed');
      else if (t.settings) wc.send('settings:files-changed');
    }
  }
}
const filesApi = () => (filesRt ||= require('./features/files').create({
  file: path.join(app.getPath('userData'), 'files.json'),
  encrypt: (text) => safeStorage.encryptString(text).toString('base64'), // encrypted like the chats (the OS keychain)
  decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  available: () => safeStorage.isEncryptionAvailable(),
  remember: () => readSettings().filesRemember !== false, // Settings > General > Files > Remember files I open
  ignore: (p) => insidePath(app.getPath('userData'), p) || insidePath(__dirname, p), // Lumen's own profile and pages are never "files the user opened"
  openFile: (p) => { openTab(fileTabUrl(p)); focusWindow(); },
  openPath: (p) => filesShell('open', p),
  showItem: (p) => filesShell('show', p),
  pick: async (kind) => {
    if (TEST && global.__filesPick) return global.__filesPick(kind); // tests answer for the OS dialog
    const owner = win && !win.isDestroyed() ? win : undefined;
    const picked = await electronDialog.showOpenDialog(owner, { title: t(kind === 'folder' ? 'files.pickFolder' : 'files.pickFile'), properties: [kind === 'folder' ? 'openDirectory' : 'openFile'] });
    return picked.canceled ? null : picked.filePaths[0];
  },
  send: (channel, payload) => { ui()?.send(channel, payload); },
  broadcast: filesBroadcast,
  // The picker's "Search Documents, Desktop and Downloads" (a click by the user, so no AI-access setting): these folders when they exist,
  // minus what the AI's file access keeps out of reach too (credentials folders, Lumen's own profile).
  scanRoots: () => {
    const home = TEST && global.__homeDir ? global.__homeDir : null; // (tests give a throwaway home, as for the AI's folder lookups)
    const opts = { profile: app.getPath('userData'), ...(home ? { home } : {}) };
    const deviceAccessMod = require('./features/device-access');
    const roots = [];
    for (const name of ['documents', 'desktop', 'downloads']) {
      if (home) { roots.push(path.join(home, name[0].toUpperCase() + name.slice(1))); continue; }
      try { roots.push(app.getPath(name)); } catch { /* this system has no such folder */ }
    }
    return { roots, blocked: (p) => Boolean(deviceAccessMod.blockedReason(p, opts)) };
  },
}));
if (TEST) Object.defineProperty(global, '__files', { get: filesApi, configurable: true });
// A file tab, viewer or download opened a local file: remembered (Settings > General > Files > Remember files I open turns this off). Loads the
// feature only for a file: address, so ordinary browsing never touches it.
function noteFileTab(tab, url) {
  if (typeof url !== 'string' || !(url.startsWith('file:') || url.startsWith('lumen-pdf:'))) return;
  const address = fileTabs.addressOf(url);
  if (!address.startsWith('file:')) return;
  let file;
  try { file = require('url').fileURLToPath(address); } catch { return; }
  filesApi().note(file, { source: manners.isAiTab(tab) ? 'ai' : 'tab' }).catch(() => {});
}
// Start-up: with a list on disk, the pinned folders are indexed a little after the window is up (never during start-up itself).
setTimeout(() => { fs.promises.access(path.join(app.getPath('userData'), 'files.json')).then(() => filesApi().load()).catch(() => {}); }, 12000).unref?.();
app.on('before-quit', () => { try { filesRt?.store.flushSync(); } catch { /* nothing pending */ } });
{
  // (the same names as files.js OPS / channelFor, spelled here so this file need not load it at start-up)
  const OPS = ['list', 'pin', 'unpin', 'remove', 'clear', 'open', 'show', 'find', 'relocate', 'search', 'attach', 'scan', 'restore'];
  const CHANNELS = { ui: (op) => (op === 'open' ? 'files:open-entry' : `files:${op}`), newtab: (op) => `newtab-files:${op}`, settings: (op) => `settings:files-${op}` };
  const newTabSender = (event) => event.senderFrame === event.sender.mainFrame && isNewTab(event.senderFrame?.url || '') && Boolean(recOfSender(event.sender));
  for (const [kind, name] of Object.entries(CHANNELS)) {
    for (const op of OPS) {
      ipcMain.handle(name(op), (event, ...args) => {
        if (kind === 'newtab' && !newTabSender(event) && !syntheticTestEvent(event)) return null;
        if (kind === 'newtab' && op === 'pin' && args[0]?.path) args[0] = { pick: args[0].pick }; // (the new-tab page names no path: it only opens the picker)
        return filesApi()[op](...args);
      });
    }
  }
  // The Files card's own strings (locales/en.json files.card.*, widgets.files.*), for the new-tab page, which has no string table of its own.
  ipcMain.on('newtab-files:strings', (event) => {
    const mine = (event.senderFrame === event.sender.mainFrame && isNewTab(event.senderFrame?.url || '') && Boolean(recOfSender(event.sender))) || syntheticTestEvent(event);
    const all = i18n().strings;
    event.returnValue = mine ? Object.fromEntries(Object.keys(all).filter((k) => k.startsWith('files.card.') || k.startsWith('routines.card.')).map((k) => [k, all[k]])) : {};
  });
  // The card's "Turn on" (when Remember files I open is off): this one setting, and nothing else, can be switched on from the new-tab page.
  ipcMain.handle('newtab-files:remember', (event) => {
    if (!newTabSender(event) && !syntheticTestEvent(event)) return false;
    if (readSettings().filesRemember === false) { writeSettings({ ...readSettings(), filesRemember: true }); filesBroadcast(); }
    return true;
  });
}
// Files dropped on the window (the UI resolves their paths with webUtils; see preload.js).
// ---------- [newtab-images] the new-tab page's Ask AI: text and pictures reach the full-page chat through these calls, never the page's URL ----------
// Only a tab's top frame showing renderer/newtab.html may call them (the page's own preload, preload/newtab-preload.js, exposes them).
{
  const newtabImages = { get lib() { return require('./features/newtab-images'); } }; // (loaded on first use)
  const newTabTab = (event) => (event.senderFrame === event.sender.mainFrame && isNewTab(event.senderFrame?.url || '') ? tabByContents(event.sender) : null);
  ipcMain.handle('newtab-ai:ask', (event, o) => {
    const tab = newTabTab(event);
    if (!tab || !o || typeof o !== 'object') return false;
    const images = newtabImages.lib.clean(o.images);
    const text = typeof o.text === 'string' ? o.text.trim().slice(0, 20000) : '';
    chatPageRt?.fromHome(tab.id, { draft: text, images, inNewTab: o.inNewTab === true, send: Boolean(text || images.length) }); // (nothing typed: it only opens the chat)
    return true;
  });
  // [look] Music-reactive home screen: what is playing -> { key, id } (one tab's capture id; features/music-react-source.js says what it is and is not)
  ipcMain.handle('newtab-music:source', (event) => {
    if (!newTabTab(event)) return { ok: false, why: 'off' };
    const r = musicReact.start(event.sender);
    if (r.ok) event.sender.executeJavaScript('0', true).catch(() => {}); // (getDisplayMedia needs a touch on the page: this one was asked to listen by its own user, in Settings, so the page counts as touched)
    return r;
  });
  // [newtab tiles] The page's Remove / Undo / Restore all: the whole hidden list comes back, is checked, and is saved (a favorite stays a bookmark; it is only left off this page).
  ipcMain.handle('newtab-tiles:set', (event, hidden) => {
    if (!newTabTab(event)) return false;
    const clean = settingsPage.cleanHiddenTiles(hidden);
    if (!clean) return false;
    writeSettings({ ...readSettings(), newTabHiddenTiles: clean });
    return true;
  });
  ipcMain.handle('newtab-ai:pick', async (event) => {
    if (!newTabTab(event)) return null;
    let paths;
    if (TEST && global.__newtabPick) paths = await global.__newtabPick(); // tests answer for the OS picker
    else {
      const owner = BrowserWindow.fromWebContents(event.sender) || win;
      const picked = await electronDialog.showOpenDialog(owner && !owner.isDestroyed() ? owner : undefined, { title: t('newtab.images.pick'), properties: ['openFile', 'multiSelections'], filters: [{ name: t('newtab.images.pickFilter'), extensions: newtabImages.lib.EXTENSIONS }] });
      paths = picked.canceled ? [] : picked.filePaths;
    }
    const images = [];
    const problems = [];
    for (const p of (Array.isArray(paths) ? paths : []).slice(0, newtabImages.lib.MAX_IMAGES)) {
      const name = path.basename(String(p));
      try {
        const type = newtabImages.lib.typeOf({ name });
        const size = (await fs.promises.stat(p)).size;
        if (!type) problems.push({ code: 'notImage', name });
        else if (!size) problems.push({ code: 'empty', name });
        else if (size > newtabImages.lib.MAX_BYTES) problems.push({ code: 'big', name });
        else images.push({ name, type, data: await fs.promises.readFile(p) });
      } catch { problems.push({ code: 'unreadable', name }); }
    }
    return { images, problems };
  });
}
ipcMain.on('files:open', (_e, paths) => { if (Array.isArray(paths)) openLinksFromOtherApps(fileUrlsFor(paths.slice(0, 20))); });
ipcMain.on('tab:new', (_e, url) => {
  const internal = url && settingsPage.parseSettingsInput(url); // [settings] lumen://settings
  if (internal) openSettingsPage(internal.section);
  else if (chatPage.parseChatInput(url)) chatPageRt.open(); // lumen://chat
  else openTab(url ? resolveInput(url) : undefined);
});
// The UI's and Settings' strings in the system's language (features/i18n.js).
ipcMain.on('ui:strings', (event) => { event.returnValue = { locale: i18n().locale, strings: i18n().strings }; });
// The same table for Lumen's own pages that have a preload of their own (the error, History, Bookmarks and Downloads pages and
// the downloads panel): nothing in it is private, but it goes only to a page of Lumen's renderer/ folder.
const RENDERER_PAGES = (pathToFileURL(path.join(__dirname, 'renderer')).href + '/').toLowerCase();
ipcMain.on('pages:strings', (event) => {
  event.returnValue = event.senderFrame?.url?.toLowerCase().startsWith(RENDERER_PAGES) ? { locale: i18n().locale, strings: i18n().strings } : { locale: 'en', strings: {} };
});
ipcMain.handle('settings:strings',() => ({ locale: i18n().locale, strings: i18n().strings }));
if (TEST) global.__i18n = () => i18n(); // test/e2e/a11y.js
// "This file was moved or deleted" (features/session-files.js): the page is a tab's own, and the file is the one its address names.
const missingFileOf = (event) => (event.senderFrame === event.sender.mainFrame ? sessionFiles.missingTarget(event.senderFrame?.url, ERROR_URL) : '');
ipcMain.on('missingfile:folder', (event) => {
  const target = missingFileOf(event);
  let dir = sessionFiles.localPath(target);
  while (dir && !fs.existsSync(dir)) { const up = path.dirname(dir); if (up === dir) { dir = ''; break; } dir = up; } // the nearest folder that is still there
  if (dir) shell.openPath(dir).catch?.(() => {});
});
ipcMain.on('missingfile:choose', async (event) => {
  const target = missingFileOf(event);
  const wc = event.sender;
  if (!target || wc.isDestroyed()) return;
  const owner = BrowserWindow.fromWebContents(wc) || win;
  const wanted = sessionFiles.localPath(target);
  const { canceled, filePaths } = await electronDialog.showOpenDialog(owner, { title: t('dialog.missingFile.choose'), defaultPath: path.dirname(wanted), properties: ['openFile'] });
  if (canceled || !filePaths[0] || wc.isDestroyed()) return;
  wc.loadURL(pathToFileURL(filePaths[0]).href).catch(() => {}); // opens in its viewer, as File > Open does
});
// The crashed page's Reload for a page that is not on the web (a new tab, settings, a file): the tab reloads the address it crashed on (the page's own address names it; main takes only the sender's tab).
ipcMain.on('crashed:reload', (event) => {
  if (event.senderFrame !== event.sender.mainFrame || !event.senderFrame.url.startsWith(ERROR_URL) || new URL(event.senderFrame.url).searchParams.get('kind') !== 'crashed') return;
  reloadTab(tabByContents(event.sender), { always: true });
});
ipcMain.on('tab:close', (_e, id) => requestCloseTab(id));
ipcMain.on('tab:switch', (_e, id, at, byUser) => { switchInput = { source: 'click', at: switchTimingOn && Number.isFinite(at) ? at : null }; const shown = switchTab(id); switchInput = null; if (byUser === true && shown && readSettings().keepViewedAiTabs !== false) userTookOver(tabs.find((t) => t.id === id)); }); // [ai manners] byUser: only a press in the tab strip or side list sets it (the chip, the AI and the app's own switches do not), and a tab the user chose to look at is theirs to keep
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
// Right-click in the address bar: Cut / Copy / Paste, and Paste and Go (the clipboard opened or searched at once).
ipcMain.on('address:menu', (e, point, hasSelection) => {
  const w = BrowserWindow.fromWebContents(e.sender) || win; // the window whose address bar was right-clicked
  if (!w || w.isDestroyed()) return;
  const text = editMenu.oneLine(clipboard.readText());
  const items = editMenu.editMenuTemplate(
    { cut: Boolean(hasSelection), copy: Boolean(hasSelection), paste: Boolean(text) },
    { text, isSearch: resolveInput(text).startsWith(searchUrlFor(readSettings().searchEngine, '')), t, go: goFromAddress },
  );
  const n = (v) => (Number.isFinite(v) ? Math.round(v) : 0);
  Menu.buildFromTemplate(items).popup({ window: w, x: n(point?.x), y: n(point?.y) });
});
ipcMain.on('tab:ai-off', (_e, id) => { const tab = tabs.find((x) => x.id === id); if (tab) setKeepOff(tab, !manners.isKeptOff(tab)); }); // [ai off-tab] only the UI can send this: no AI tool reaches it
ipcMain.on('tab:mute', (_e, id) => { const tab = tabs.find((t) => t.id === id); if (tab) tabTools.setMuted(tab, !tabTools.state(tab, alive(tab)).muted); });
ipcMain.handle('tabsearch:closed', () => tabTools.closedEntries(closedTabs));
ipcMain.handle('tabsearch:reopen', (_e, index, url) => reopenClosed(index, url));
// The command bar (Ctrl+K; features/command-bar.js, renderer/command-bar.js): its pages and the commands that need the browser. Loaded on first use.
const frontTab = () => tabs.find((x) => x.id === activeId);
const commandBar = lazy(() => require('./features/command-bar').create({
  history: () => history,
  bookmarks: () => bookmarks(),
  isWebUrl,
  act: {
    newTab: () => openTab(),
    newWindow: () => openNewWindow(),
    newPrivateWindow: () => privateWindows.open(),
    closeTab: () => { if (activeId) requestCloseTab(activeId); },
    reopenTab: () => reopenLastClosed(),
    toggleSidebar: () => toggleSidebarFromKeys(),
    newChat: () => newSidebarChat(),
    chatPage: () => toggleChatPage(),
    pinTab: () => { if (activeId) pinTab(activeId, true); },
    unpinTab: () => { if (activeId) pinTab(activeId, false); },
    muteTab: () => { const tab = frontTab(); if (tab) tabTools.setMuted(tab, true); },
    unmuteTab: () => { const tab = frontTab(); if (tab) tabTools.setMuted(tab, false); },
    bookmarkTab: () => { const tab = frontTab(); if (tab && !bookmarks().some((b) => b.url === tabUrl(tab))) toggleBookmarkFor(tab); },
    unbookmarkTab: () => { const tab = frontTab(); if (tab && bookmarks().some((b) => b.url === tabUrl(tab))) toggleBookmarkFor(tab); },
    find: () => openFindBar(),
    reload: () => reloadActive({ always: true }),
    history: () => openHistoryPage(),
    bookmarks: () => managers.open('bookmarks'),
    downloads: () => managers.open('downloads'),
    clearData: () => openSettingsPage('privacy'), // the page where Clear browsing data asks what to clear: the bar never clears anything itself
    themeLight: () => settingsBackend.set('theme', 'light'),
    themeDark: () => settingsBackend.set('theme', 'dark'),
    themeSystem: () => settingsBackend.set('theme', 'system'),
    settings: (section) => openSettingsPage(section || ''),
    shortcuts: () => shortcutsHelp.open(),
    recordTab: () => { const wc = activeTab()?.webContents; if (wc) startRecording('tab', wc); }, // [screen recording]
    recordScreen: () => { startRecording('screen'); },
    stopRecording: () => { screenRec?.stop(); },
  },
}));
ipcMain.handle('cmdbar:data', async () => { await historyReady; return commandBar.data(); });
ipcMain.handle('cmdbar:run', (_e, id) => commandBar.run(id));
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
ipcMain.on('downloads:warm', warmDownloadsPanel);
ipcMain.on('zoom:reset', () => zoomBy(activeTab()?.webContents, 0));
function goFromAddress(text) {
  const wc = activeTab()?.webContents;
  if (!wc) return;
  userTookOver(tabs.find((t) => t.id === activeId)); // [ai manners] the user navigated this tab
  // [settings] lumen://settings opens the settings tab (in place of a blank new tab); anything typed
  // into the settings tab opens in a normal tab in its place.
  const current = tabs.find((t) => t.id === activeId);
  const internal = settingsPage.parseSettingsInput(text);
  if (internal) { openSettingsPage(internal.section, { replace: !current?.settings && isNewTab(wc.getURL()) ? activeId : null }); return; }
  if (chatPage.parseChatInput(text)) { chatPageRt.open(); return; } // lumen://chat
  const own = internalPageOf(text); // lumen://history, bookmarks, downloads, about
  if (own) { if (own === 'history') openHistoryPage(); else if (own === 'updates') openSettingsPage('updates', { replace: !current?.settings && isNewTab(wc.getURL()) ? activeId : null }); else managers.open(own); return; }
  if (current?.settings || current?.managerPage === 'chat') { replaceTab(activeId, resolveInput(text)); return; } // the chat page is locked like Settings
  const source = /^\s*view-source:(https?:\/\/\S+)\s*$/i.exec(String(text)); // typed view-source:<url>
  if (source) { pageTools.viewSource(source[1], { wc }); wc.focus(); return; }
  const target = resolveInput(text);
  if (leaveNewTabFor(current, target)) { activeTab()?.webContents.focus(); return; } // (a new-tab page: the page loads in the warm view)
  wc.loadURL(target).catch(() => {});
  wc.focus();
}
ipcMain.on('nav:go', (_e, text) => goFromAddress(text));
function toggleReaderActive() {
  return pageTools.toggleReader(tabs.find((t) => t.id === activeId && alive(t)));
}
ipcMain.on('page:reader', () => { toggleReaderActive(); });
ipcMain.on('translate:act', (_e, action, arg) => translate.act(tabs.find((x) => x.id === activeId && alive(x)), String(action), typeof arg === 'string' ? arg : undefined));
if (TEST) global.__translateLocal = () => translateLocal();
if (TEST) global.__translate = { api: translate, tab: (id) => tabs.find((x) => x.id === id) };
if (TEST) global.__pageTools = { tools: pageTools, toggleReader: toggleReaderActive, tab: (id) => tabs.find((t) => t.id === id), handleShortcut: (input) => handleShortcut({ preventDefault() {} }, { type: 'keyDown', control: false, meta: false, shift: false, alt: false, ...input }), contextMenuItems: (wc, p) => pageTools.videoMenuItems(wc, p, { openTab: () => {}, copy: () => {} }) };
ipcMain.on('nav:back', () => { userTookOver(tabs.find((t) => t.id === activeId)); goBack(activeTab()?.webContents); });
ipcMain.on('nav:forward', () => { userTookOver(tabs.find((t) => t.id === activeId)); activeTab()?.webContents.navigationHistory.goForward(); });
// Right-click on Back / Forward: the pages behind / ahead, nearest first (browser/nav-history.js), then Show All History.
function navHistoryTemplate(direction) {
  const tab = tabs.find((x) => x.id === activeId && alive(x));
  const wc = tab?.view.webContents;
  if (!wc || wc.isDestroyed() || (direction !== 'back' && direction !== 'forward')) return [];
  const nav = wc.navigationHistory;
  const entries = navHistory.items(nav.getAllEntries(), nav.getActiveIndex(), direction);
  const items = entries.map((e) => ({ label: menuLabel(e.label), click: () => { userTookOver(tab); nav.goToIndex(e.index); } }));
  if (direction === 'back' && !items.length && tab.backToNewTab) items.push({ label: t('menu.newTabPage'), click: () => { userTookOver(tab); goBack(wc); } }); // (the one step Back still has)
  if (items.length) items.push({ type: 'separator' }, { label: t('menu.showAllHistory'), ...shortcutHint(process.platform === 'darwin' ? 'Cmd+Y' : 'Ctrl+H'), click: openHistoryPage });
  return items;
}
ipcMain.on('nav:history-menu', (e, direction, point) => {
  const w = BrowserWindow.fromWebContents(e.sender) || win;
  const items = navHistoryTemplate(direction);
  if (!w || w.isDestroyed() || !items.length) return;
  const n = (v) => (Number.isFinite(v) ? Math.round(v) : 0);
  Menu.buildFromTemplate(items).popup({ window: w, x: n(point?.x), y: n(point?.y) });
});
if (TEST) global.__navHistoryMenu = (direction) => navHistoryTemplate(direction).map((i) => ({ label: i.label || '---', click: i.click }));
ipcMain.on('nav:reload', reloadActive);

ipcMain.handle('suggest:query', async (_e, query) => { if (/^\s*(lumen:\/\/)?settings\b/i.test(String(query))) prepareSettings(); /* [settings intent] */ await historyReady; return suggestions(query); }); // (a query in the first moments waits for the past pages)
ipcMain.on('suggest:show', (_e, rect, payload) => showSuggestions(rect, payload));
ipcMain.on('suggest:hide', hideSuggestions);
ipcMain.on('app-menu', (_e, point) => showAppMenu(point));
// The puzzle button's menu: every extension that has a toolbar button, in the toolbar's order (the pinned ones, then the rest). A pick goes back
// to the toolbar, which triggers that extension's action as its icon would (its popup opens under the puzzle button). "Pin to toolbar" holds a
// checkbox for each; Settings → Extensions has the same switches (settings-backend.js pinExtension).
// A toolbar action with no title of its own is labelled by its extension's manifest name, never the raw id.
const extensionName = (id) => {
  let name = '';
  try { name = String(session.defaultSession.extensions.getExtension(id)?.name || ''); } catch { /* gone */ }
  return name.slice(0, 80) || t('extension.fallbackName');
};
function extensionsPuzzleMenu(list) {
  const { extensionsToolbar: mode, extensionPins } = settingsBackend.prefs();
  const name = (i) => menuLabel(i.title.slice(0, 80) || extensionName(i.id));
  return [
    ...list.map((i) => ({ label: name(i), click: () => ui()?.send('actions:overflow-pick', i.id) })),
    { type: 'separator' },
    { label: t('extension.pinToToolbar'), submenu: list.map((i) => ({ label: name(i), type: 'checkbox', checked: extensionPins.order.includes(i.id), enabled: mode === 'pinned', click: (item) => { settingsBackend.pinExtension(i.id, item.checked); } })) },
    { label: t('extension.manage'), click: () => openSettingsPage('extensions') },
  ];
}
ipcMain.on('actions:overflow', (_e, point, items) => {
  const list = (Array.isArray(items) ? items : []).filter((i) => i && typeof i.id === 'string' && typeof i.title === 'string').slice(0, 60);
  if (!list.length || !win || win.isDestroyed()) return;
  const template = extensionsPuzzleMenu(list);
  if (TEST) { global.__extensionsMenu = template; return; } // (a popup menu blocks until it is picked: the test reads the items and clicks one itself)
  const n = (v) => (Number.isFinite(v) ? Math.round(v) : 0);
  Menu.buildFromTemplate(template).popup({ window: win, x: n(point?.x), y: n(point?.y) });
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
ipcMain.on('find:stop', (_e, close) => { // closing the bar keeps the match selected and hands the keyboard back to the page; an emptied field clears it
  const wc = activeTab()?.webContents;
  if (!wc || wc.isDestroyed()) return;
  wc.stopFindInPage(close ? 'keepSelection' : 'clearSelection');
  if (close) wc.focus();
});

const tabsAsk = require('./features/tabs-ask');
const chatImages = require('./features/chat-images');
const screenContext = require('./ai/screen-context'); // [screen context] the chip's x (agent:screen-drop)
// [versions] What a run did, kept with its reply (agent.stampMessages): the thinking, the steps, the model Auto chose, and when.
const tabMarker = new Proxy({}, { get: (_t, k) => require('./renderer/tab-marker')[k] }); // [tab chips] [[tab:ID]] (tiny; loaded on first use, not at start-up: the module budget)
const stepLabelsLib = new Proxy({}, { get: (_t, k) => require('./renderer/step-labels')[k] }); // [step labels] bounds what a step keeps of its input in the saved chat (loaded on the first run, not at start-up)
function trackRunDetails(run, msg) {
  const d = run.details;
  const touch = (id) => { if (Number.isInteger(id) && id >= 0 && !d.touched.includes(id) && d.touched.length < 24) d.touched.push(id); }; // [activity cards] the card's Tabs list: every tab the turn used, first touched first
  if (msg.type === 'tool') { try { for (const id of tabMarker.stepTabs(msg.name, msg.input)) touch(id); } catch { /* none */ } } else if (msg.type === 'thumb' || msg.type === 'tool_done') touch(msg.tabId);
  if (msg.type === 'card_files') { for (const f of Array.isArray(msg.files) ? msg.files : []) if (f && typeof f.path === 'string' && d.written.length < 12 && !d.written.includes(f.path)) d.written.push(f.path); return; } // [activity cards] the files the run wrote: kept with the reply, so a reopened chat has the links
  if (msg.type === 'thinking') {
    if (!d.thinkingSince) d.thinkingSince = Date.now();
    if (d.thinking.length < 20000) d.thinking += msg.text || '';
    return;
  }
  if (d.thinkingSince && ['text', 'text_block', 'tool', 'turn_start', 'done'].includes(msg.type)) { d.thinkingMs += Date.now() - d.thinkingSince; d.thinkingSince = 0; }
  if (msg.type === 'retry') { d.thinking = ''; d.thinkingMs = 0; }
  else if (msg.type === 'tool') {
    if (d.tools.length < 60) d.tools.push({ id: msg.id, label: msg.label || '', name: msg.name, input: stepLabelsLib.compactInput(msg.name, msg.input) || msg.input, ok: true });
    try { const ids = tabMarker.stepTabs(msg.name, msg.input); if (ids.length) noteRunTabs(run, ids); } catch { /* none */ } // [tab chips] a step that names a tab: how it looks before the step (a close) changes it
  } else if (msg.type === 'thumb') {
    if (Number.isInteger(msg.tabId) && (msg.data || msg.kind === 'pending' || msg.kind === 'blank')) { // the tab the card names (no picture is kept: the card shows the tab's name, step-ui.js setTabRow)
      const same = d.thumb?.tabId === msg.tabId;
      d.thumb = { url: msg.url || (same ? d.thumb.url : '') || '', title: msg.title || (same ? d.thumb.title : '') || '', tabId: msg.tabId, s: require('./features/tab-chips').BOOT };
      noteRunTabs(run, [msg.tabId]);
    }
  } else if (msg.type === 'tool_update') {
    const t = d.tools.find((x) => x.id && x.id === msg.id);
    if (t) { if (msg.label) t.label = msg.label; if (msg.input) t.input = stepLabelsLib.compactInput(t.name, msg.input) || msg.input; }
  } else if (msg.type === 'tool_done') {
    const t = d.tools.find((x) => x.id && x.id === msg.id);
    if (t) t.ok = Boolean(msg.ok);
    if (t && Number.isInteger(msg.tabId)) { t.tab = msg.tabId; noteRunTabs(run, [msg.tabId]); } // [tab chips] the tab open_tab made
  } else if (msg.type === 'auto') d.auto = { label: msg.label, reason: msg.reason };
}
// [activity cards] The Browser card's live thumbnail of the tab a run works in (features/step-thumbs.js). The chat reports whether any card
// is on screen ('agent:thumbs-visible'); while none is, nothing is captured. Light graphics (or no hardware drawing) refreshes on navigation only.
const stepThumbs = { createThumbs: (opts) => require('./features/step-thumbs').createThumbs(opts), isNavigation: (name) => require('./features/step-thumbs').isNavigation(name) }; // (loaded on the first browser step)
const thumbVisibleBy = new Map(); // webContents id -> a card is on screen there
const thumbsVisible = () => {
  let known = false;
  let any = false;
  for (const [id, v] of thumbVisibleBy) {
    const wc = webContentsModule.fromId(id);
    if (!wc || wc.isDestroyed()) { thumbVisibleBy.delete(id); continue; }
    known = true;
    if (v) any = true;
  }
  return known ? any : true;
};
if (TEST) {
  global.__tabCapture = require('./features/tab-capture'); // (a test takes captures of any tab, as the AI's tools do)
  global.__thumbsState = { visible: () => thumbsVisible(), by: () => [...thumbVisibleBy] };
  // n captures of the tab in front, each sent to the UI as the chat gets it, one after another (a test measures the main process meanwhile)
  global.__thumbsState.burst = async (n) => { let bytes = 0; for (let i = 0; i < n; i++) { const wc = activeTab()?.webContents; const data = wc ? await require('./features/tab-capture').captureThumb(wc) : null; if (data) { bytes += data.length; ui()?.send('thumb:probe', { type: 'thumb', data, url: wc.getURL(), tabId: activeId, aiTabs: 0 }); } await new Promise((r) => setTimeout(r, 30)); } return bytes; };
}
// The tab (or site) a run's latest browser step works on. A tool that names a tab (tab_id, switch_tab, read_tabs) acts there; the others act in
// the tab the run is pinned to (which is not the one the user looks at); a step that reads addresses without a tab (read_urls) has none: a site.
function thumbTargetOf(run, name, input) {
  const bare = String(name || '').replace(/^mcp__lumen__/, '');
  const inp = input && typeof input === 'object' ? input : {};
  if (bare === 'read_urls') {
    const first = (Array.isArray(inp.urls) ? inp.urls : [inp.url]).find((u) => /^https?:\/\//i.test(String(u || '')));
    if (first) { let host = ''; try { host = new URL(String(first)).host.replace(/^www\./, ''); } catch { /* none */ } return { kind: 'site', url: String(first).slice(0, 500), host }; }
  }
  const named = bare === 'read_tabs' ? (Array.isArray(inp.ids) ? inp.ids : []).find(Number.isInteger) : Number.isInteger(inp.tab_id) ? inp.tab_id : null;
  if (bare === 'close_tab' && run.thumbTarget) return run.thumbTarget; // closing a tab changes nothing about what the card shows: it keeps the tab it had and its last picture
  if (Number.isInteger(named)) return { kind: 'tab', tabId: named };
  const pinned = agent.runTabIdFor(run.messages) ?? run.tabId;
  return pinned != null ? { kind: 'tab', tabId: pinned } : run.thumbTarget || null;
}
const thumbKey = (t) => (!t ? '' : t.kind === 'site' ? 'site:' + t.url : 'tab:' + t.tabId);
function thumbTabOf(run) {
  const t = run.thumbTarget;
  const id = t?.kind === 'tab' ? t.tabId : t?.kind === 'site' ? null : (agent.runTabIdFor(run.messages) ?? run.tabId);
  if (id != null && run.thumbHold === id) return null; // (a step is closing this tab: nothing is asked of a page on its way out)
  const hit = id != null ? tabAnywhere(id) : null;
  return hit && alive(hit.t) ? { id, wc: hit.t.view.webContents, favicon: hit.t.favicon || null } : null;
}
// What the card shows right away when the target changes (before the new picture): the tab's name for the chip, or "Reading <site>".
function thumbTargetEvent(run) {
  const t = run.thumbTarget;
  if (!t) return null;
  if (t.kind === 'site') {
    let icon = null;
    try { icon = faviconFile(faviconStore.get(hostOf(t.url))) || null; } catch { /* none */ }
    return { type: 'thumb', kind: 'site', data: '', url: t.url, title: t.host, tabId: null, favicon: icon };
  }
  const tab = thumbTabOf(run);
  if (!tab) return { type: 'thumb', kind: 'pending', data: '', url: '', title: '', tabId: t.tabId };
  return { type: 'thumb', kind: 'pending', data: '', url: tab.wc.getURL(), title: tab.wc.getTitle?.() || '', tabId: tab.id };
}
async function captureRunThumb(run, { saved = false } = {}) {
  const tab = thumbTabOf(run);
  if (!tab) return null;
  const wc = tab.wc;
  const url = wc.getURL();
  if (aiSites.isOff(url)) return null; // a page the AI may not read is not drawn in the chat either
  const named = { url, title: wc.getTitle?.() || '', tabId: tab.id, favicon: typeof tab.favicon === 'string' ? tab.favicon : null };
  if (!/^(https?|file|lumen-pdf):/i.test(url)) return { blank: true, ...named }; // (one of Lumen's own pages: no picture of it, its name)
  const lowRes = saved || graphicsMode.light() || app.isHardwareAccelerationEnabled?.() === false; // (saved: the run's last frame is the one the chat keeps, small: scaling a sharp one down on the main process costs 15-45 ms) // (Light graphics or software drawing: the small picture)
  const state = {};
  const data = await require('./features/tab-capture').captureThumb(wc, { lowRes, state });
  if (data) return { data, ...named, ...(state.small ? { small: true } : {}) };
  return state.blank ? { blank: true, ...named } : null;
}
// A tiny signature of the page the card shows (address, scroll, size, how much is on it): a frame is taken when it moves (features/step-thumbs.js).
const THUMB_PROBE = '(()=>{try{const d=document,e=d.scrollingElement||d.documentElement;return location.href+"|"+d.readyState+"|"+Math.round(e.scrollTop)+"|"+Math.round(e.scrollLeft)+"|"+e.scrollHeight+"|"+innerWidth+"x"+innerHeight+"|"+d.getElementsByTagName("*").length+"|"+d.title}catch(_){return ""}})()';
async function probeRunThumb(run) {
  const tab = thumbTabOf(run);
  if (!tab || tab.wc.isLoading?.()) return tab ? 'loading' : null; // (a page still loading changes by the moment: a frame while it does)
  const url = tab.wc.getURL();
  if (!/^(https?|file|lumen-pdf):/i.test(url) || aiSites.isOff(url)) return null;
  const sig = await tab.wc.executeJavaScript(THUMB_PROBE, false);
  return typeof sig === 'string' ? tab.id + '|' + sig : null;
}
async function timedCapture(run, opts) {
  const t0 = performance.now();
  try { return await captureRunThumb(run, opts); } finally { try { const t = thumbTabOf(run); if (t) fillCheck(t.id, 'capture', 250); } catch { /* the run's tab is gone */ } if (TEST) { (global.__thumbsState.windows ||= []).push([t0, performance.now()]); global.__thumbsState.captures = (global.__thumbsState.captures || 0) + 1; } } // (a test checks the main process stayed free while these ran)
}
// The live stream behind the card (features/step-thumbs.js): the engine's screencast of the tab at the card's size, at most THUMB_FPS frames a second,
// each passed on as the base64 JPEG it is (nothing decoded here). Answers { stop() }, or null for a page that is drawn by the capture path instead.
const THUMB_FPS = Math.min(30, Math.max(1, Number(process.env.LUMEN_THUMB_FPS) || 15));
async function streamRunThumb(run, onFrame, onEnd) {
  const tab = thumbTabOf(run);
  if (!tab) return null;
  const wc = tab.wc;
  const url0 = wc.getURL();
  if (aiSites.isOff(url0) || !/^https?:/i.test(url0)) return null; // (Lumen's own pages, files and viewers: the capture path knows their blank frames)
  const named = { tabId: tab.id, favicon: typeof tab.favicon === 'string' ? tab.favicon : null };
  return require('./features/tab-capture').streamThumb(wc, {
    fps: THUMB_FPS,
    onEnd,
    onFrame: (data) => {
      const t0 = TEST ? performance.now() : 0;
      const url = wc.getURL();
      if (!/^https?:/i.test(url) || aiSites.isOff(url)) return; // (the page moved on to one the card does not draw)
      onFrame({ data, url, title: wc.getTitle?.() || '', ...named });
      fillCheck(tab.id, 'stream', 400); // (read at most every 1.5 s, see checkPageSize in tab-capture.js)
      if (TEST) { const st = global.__thumbsState; const ms = performance.now() - t0; st.frameMs = (st.frameMs || 0) + ms; st.frames = (st.frames || 0) + 1; st.frameBytes = (st.frameBytes || 0) + data.length; st.frameMax = Math.max(st.frameMax || 0, ms); } // (a test reports what a frame costs the main process)
    },
  });
}
// The one last frame of a run: the tab it ended on, once that page has finished loading and drawing (it can have navigated after the last frame).
// `last`: the address and age of the last frame shown; none is taken when one came a moment ago and the page has not moved on.
const THUMB_SETTLE = '(()=>new Promise((res)=>{const go=()=>requestAnimationFrame(()=>requestAnimationFrame(()=>res(1)));const im=[...document.images].filter((i)=>!i.complete);if(!im.length)return go();let n=im.length;const one=()=>{if(--n<=0)go()};im.forEach((i)=>{i.addEventListener("load",one,{once:true});i.addEventListener("error",one,{once:true})});setTimeout(go,1200)}))()';
async function finalRunThumb(run, last = {}) {
  const sleep = (ms) => new Promise((r) => { const h = setTimeout(r, ms); h.unref?.(); });
  const until = Date.now() + 3000;
  let tab = thumbTabOf(run);
  const wasLoading = Boolean(tab?.wc.isLoading?.());
  while (tab && tab.wc.isLoading?.() && Date.now() < until) { await sleep(80); tab = thumbTabOf(run); }
  if (!tab) return null;
  if (last.ageMs < 500 && !wasLoading && tab.wc.getURL() === last.url) return null; // (the stream was still drawing it a moment ago, and the page is where it was)
  try { await Promise.race([tab.wc.executeJavaScript(THUMB_SETTLE, false), sleep(1500)]); } catch { /* the page is busy: the frame as it is */ }
  return timedCapture(run, { saved: true });
}
// Called for every event of a run (emit): starts, nudges and ends the run's thumbnailer.
function noteThumbs(run, msg, push) {
  const thumbAiTabs = (run.thumbAiTabs ||= { n: 0, at: 0 });
  if (msg.type === 'tool' || msg.type === 'tool_done' || msg.type === 'done') thumbAiTabs.at = 0; // (a step may have opened or closed a tab: the next frame asks again)
  if (msg.type === 'tool') {
    const name = String(msg.name || '');
    if (msg.id && stepLabelsLib.surfaceOf(name) === 'browser') {
      (run.toolNames ||= new Map()).set(msg.id, name);
      (run.toolInputs ||= new Map()).set(msg.id, msg.input);
      if (/(^|__)close_tab$/.test(name) && Number.isInteger(msg.input?.tab_id)) run.thumbHold = msg.input.tab_id; // (held until the step is done)
      const fresh = !run.thumbs;
      const thumbs = (run.thumbs ||= stepThumbs.createThumbs({
        capture: () => timedCapture(run), probe: () => probeRunThumb(run), stream: ({ onFrame, onEnd }) => streamRunThumb(run, onFrame, onEnd), final: (last) => finalRunThumb(run, last),
        send: (ev) => { const t = Date.now(); if (t - (thumbAiTabs.at || 0) > 1000) { try { thumbAiTabs.n = aiTabSelect({ runId: run.runId }).length; } catch { thumbAiTabs.n = 0; } thumbAiTabs.at = t; } push({ ...ev, aiTabs: thumbAiTabs.n }); }, // (the card's "Hide tabs the AI opened (N)", asked once a second, not per frame)
        light: () => graphicsMode.light() || app.isHardwareAccelerationEnabled?.() === false, visible: thumbsVisible,
        intervalMs: Number(process.env.LUMEN_THUMB_MS) || (graphicsMode.light() ? 1500 : 350), // the clock of the supervisor (the probe) and of the capture fallback, about 3 a second; a card on screen streams at THUMB_FPS instead (below), none while the page stands still
      }));
      const next = thumbTargetOf(run, name, msg.input);
      const changed = thumbKey(next) !== thumbKey(run.thumbTarget);
      if (next) run.thumbTarget = next;
      thumbs.activity();
      if (changed && !fresh) { // the exact tab this step acts on: the chip and the picture switch with it
        const ev = thumbTargetEvent(run);
        if (ev) push(ev);
        thumbs.retarget();
      } else if (fresh) { const ev = thumbTargetEvent(run); if (ev) push(ev); }
    }
  } else if (msg.type === 'tool_done') {
    const name = run.toolNames?.get(msg.id);
    if (name && /(^|__)close_tab$/.test(name)) run.thumbHold = null;
    if (name && /(^|__)open_tab$/.test(name) && msg.ok !== false && Number.isInteger(msg.tabId) && run.thumbTarget?.tabId !== msg.tabId) { // the tab it made is the one shown now
      run.thumbTarget = { kind: 'tab', tabId: msg.tabId };
      const ev = thumbTargetEvent(run);
      if (ev) push(ev);
      run.thumbs?.retarget();
    }
    if (name && !Number.isInteger(run.toolInputs?.get(msg.id)?.tab_id) && !/(^|__)(open_tab|close_tab|read_urls)$/.test(name)) { // a step that names no tab acts in the tab the run is pinned to, and a navigation can move the run to a tab of its own: the card follows
      const pinned = agent.runTabIdFor(run.messages);
      if (pinned != null && run.thumbTarget?.kind === 'tab' && run.thumbTarget.tabId !== pinned && !(run.thumbHold != null)) {
        run.thumbTarget = { kind: 'tab', tabId: pinned };
        const ev = thumbTargetEvent(run);
        if (ev) push(ev);
        run.thumbs?.retarget();
      }
    }
    run.toolInputs?.delete(msg.id);
    if (name) run.thumbs?.settled(stepThumbs.isNavigation(name));
  } else if (msg.type === 'done') run.thumbs?.stop();
}
ipcMain.on('agent:thumbs-visible', (event, visible) => { thumbVisibleBy.set(event.sender.id, visible === true); });
// "Open preview" on a Browser card: the tab it shows, or its page again in a new tab when that tab is gone.
ipcMain.handle('agent:open-preview', (event, target) => {
  syncToSender(event);
  const id = Number.isInteger(target?.tabId) ? target.tabId : null;
  const hit = id != null ? tabAnywhere(id) : null;
  if (hit && alive(hit.t)) { withWindow(hit.rec, () => switchTab(id)); return { ok: true, tabId: id, reopened: false }; }
  const url = typeof target?.url === 'string' ? target.url : '';
  if (!/^https?:\/\//i.test(url) || url.length > 4000) return { ok: false, reason: 'gone' };
  const rec = recOfSender(event.sender);
  const tab = rec ? withWindow(rec, () => openTab(url)) : openTab(url);
  return { ok: Boolean(tab), tabId: tab?.id ?? null, reopened: true };
});
// [tab chips] A tab the chat names, as a chip: its title and icon live, "closed" once it is gone (features/tab-chips.js).
function tabChips() {
  return tabChipsRt ||= require('./features/tab-chips').create({
    closed: closedChipTabs,
    lookup: (id) => {
      const hit = tabAnywhere(id);
      if (!hit) return null;
      const t = hit.t;
      const url = tabUrl(t);
      return { title: (alive(t) ? (!warmPending.has(t.view.webContents) && t.view.webContents.getTitle()) : t.sleepTitle) || '', url: isInternal(url) ? '' : url, favicon: t.favicon || null, sleeping: !alive(t) };
    },
    raise: (id, senderWc) => {
      const hit = tabAnywhere(id);
      if (!hit) return false;
      withWindow(hit.rec, () => switchTab(id)); // an AI tab hidden from the strip shows again while it is the one in front, as with Open preview
      const from = senderWc ? recOfSender(senderWc) : null;
      if (hit.rec !== from && rcAlive(hit.rec) && !(TEST && process.env.LUMEN_TEST_BACKGROUND)) raiseWindow(hit.rec.win); // another window comes to the front
      return true;
    },
    openUrl: (url, wc) => { // a closed tab's chip: the tab comes back as Reopen Closed Tab brings it (its place, group and history), and leaves that list
      const go = () => { const at = closedTabs.lastIndexOf(url); return at >= 0 ? reopenClosedTab(url, (closedTabs.splice(at, 1), closedInfo.splice(at, 1)[0])) : openTab(url); };
      const rec = recOfSender(wc);
      return rec ? withWindow(rec, go) : go();
    },
    isInternal: (url) => isInternal(url),
    aliveSender: (wc) => Boolean(wc) && !wc.isDestroyed(),
  });
}
const chipSenders = new Set();
function chipsFor(event) {
  const rt = tabChips();
  if (!chipSenders.has(event.sender.id)) { const id = event.sender.id; chipSenders.add(id); event.sender.once('destroyed', () => { chipSenders.delete(id); rt.forget(id); }); }
  return rt;
}
ipcMain.handle('chips:info', (event, keys, snaps) => tabChips().infos(keys, snaps && typeof snaps === 'object' ? snaps : {}));
ipcMain.handle('chips:watch', (event, keys) => chipsFor(event).watch(event.sender, keys));
ipcMain.handle('chips:open', (event, request) => { syncToSender(event); return chipsFor(event).open(event.sender, request); });
if (TEST) global.__tabChips = { rt: () => tabChips(), boot: () => require('./features/tab-chips').BOOT, closed: () => [...closedChipTabs] };
function replyTabs(run) { // [tab chips] the tabs the reply names, for a notification's words (chat-runs.js tabWords)
  try { const ids = tabMarker.idsIn(run.reply || ''); if (ids.length) noteRunTabs(run, ids); } catch { /* none */ }
  return run.tabSnaps || null;
}
function noteRunTabs(run, ids) { // the tabs a run names, as they look now (or as they last looked): kept with the reply
  const rt = tabChips();
  const snaps = (run.tabSnaps ||= {});
  for (const id of ids) { const snap = rt.snapshot(String(id)); if (snap) snaps[id] = snap; }
}
// The saved reply keeps one small frame (the live ones are sharp and bigger): scaled down once, here, not per frame.
function savedThumb(t) { return t && Number.isInteger(t.tabId) ? { tabId: t.tabId, s: t.s, url: t.url || '', title: t.title || '' } : undefined; } // (the tab, never its picture)
function stampRun(run, done = null) {
  try {
    const d = run.details;
    const info = { at: Date.now() };
    try { // [tab chips] the tabs the replies name
      for (const m of run.messages.slice(run.startLen)) if (m.role === 'assistant') for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === 'text') { const ids = tabMarker.idsIn(b.text); if (ids.length) noteRunTabs(run, ids); }
      if (done && d.touched?.length) noteRunTabs(run, d.touched.filter(Number.isInteger)); // (the card's Tabs list: each tab as it last looked, so a closed one still reads after a restart)
      if (run.tabSnaps) info.tabs = run.tabSnaps;
    } catch { /* none */ }
    if (done) Object.assign(info, { thinking: d.thinking, thinkingMs: d.thinkingMs, tools: d.tools.map(({ id, ...t }) => t), cards: true, task: stepLabelsLib.defaults.taskName(run.text) || undefined, thumb: savedThumb(d.thumb), touched: d.touched.length ? d.touched : undefined, written: d.written.length ? d.written : undefined, auto: done.auto || d.auto });
    agent.stampMessages(run.messages, run.startLen, info);
  } catch (err) { console.error('Could not stamp chat messages:', err.message); }
}
ipcMain.on('agent:ask', (event, text, runId, images = [], tabIds = [], fileRefs = [], screenMode = null, askOpts = null) => {
  const { valid, rejected } = chatImages.cleanImages(images); // anything left out is said in the chat, not dropped silently
  let shownPick = null; // what every picker shows right now (the open chat's model, or the saved pick while it has none), before the sender's own chat is brought up
  try { shownPick = shownModel().pick || null; } catch { /* not set up yet */ }
  syncToSender(event); // [chat per tab] the chat of the tab this was typed in
  adoptShownModel(shownPick); // the message goes to the model the picker showed, even when this window's or page's chat was left on another
  // [background chats] The run belongs to the chat it started in, wherever the user goes meanwhile:
  // another tab, another window, a closed sidebar or another chat (switchChat leaves it running).
  const runChat = chatId;
  const messages = agent.messages;
  const hosts = agent.approvedHosts;
  const askText = String(text || '');
  let attachedFiles = []; // [uploads] files attached in the composer move into this chat's store; the AI is told their names and refs
  try { attachedFiles = uploads().adopt(runChat, fileRefs); } catch { /* none kept */ }
  const fromChatPage = chatPageRt.isChatSender(event);
  // [chat per tab] Starting a chat in a tab binds it there: its tools act on this tab, not on whichever is in front later.
  // A chat shown in several tabs has one live run on one home tab: a message typed in another tab while the run is going
  // does not pull its tools there. With no run going, it starts in the tab it was typed in, and that tab is the home.
  const going = chatRuns.get(runChat);
  const goingTab = going && !going.deleted ? (going.queued ? going.homeTab : agent.runTabIdFor(going.messages)) : null;
  const goingAt = !fromChatPage && goingTab != null && goingTab !== activeId && chatBind.chatOf(activeId) === runChat && chatBind.chatOf(goingTab) === runChat ? tabAnywhere(goingTab) : null;
  const homeTab = fromChatPage ? null : goingAt ? goingTab : activeId;
  if (homeTab != null) chatBind.bind(homeTab, runChat);
  const run = { chatId: runChat, messages, runId, startedAt: Date.now(), rec: goingAt ? goingAt.rec : curRec, sender: event.sender, pending: new Map(), reply: '', error: null, stopped: false, deleted: false, tabId: null, queued: false, homeTab, text: askText, waitReason: null, startLen: messages.length, details: { thinking: '', thinkingMs: 0, thinkingSince: 0, tools: [], auto: null, touched: [], written: [] } };
  chatRuns.set(runChat, run);
  unreadChats.delete(runChat);
  bumpChat(runChat); // sending is activity: the chat moves to the top of every list now
  const isOpen = () => runChat === chatId && run.messages === agent.messages;
  const to = () => (run.sender && !run.sender.isDestroyed() ? run.sender : event.sender);
  chatPageRt.beginRun(event, { text: askText, runId, chatId: runChat, images: valid, files: attachedFiles }); // pins a chat-page run to the tab last looked at; the other view mirrors it
  mirrorToViews(runChat, [event.sender, ...chatPageRt.surfaces()], 'chat:run-start', { text: askText, runId, chatId: runChat, images: valid.map((i) => ({ media_type: i.media_type, data: i.data })), files: attachedFiles }); // another window's sidebar showing this chat shows the turn too
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
  // The run could not start, or is gone without a done: tell the chat, and leave the line.
  run.fail = (err) => {
    if (chatRuns.get(runChat) !== run) return;
    run.queued = false;
    const raw = String(err?.message || err);
    const stale = raw === t('agent.engineStopped'); // (already plain words)
    emit({ type: 'error', text: stale ? raw : t('agent.startFailed'), details: stale ? undefined : raw.slice(0, 600) });
    emit({ type: 'done' });
  };
  // Streamed text/thinking chunks are joined (event-coalesce.js); every other event goes out at once, after any held text.
  const sendOut = (msg) => {
    chatPageRt.emit(to(), 'agent:event', { ...msg, runId, chatId: runChat }); // (the chat id lets a view that has moved on to another chat ignore it) whoever asked, and the other view when a chat page is open (a chat left running is ignored there by its run id)
    mirrorToViews(runChat, [to(), ...chatPageRt.surfaces()], 'agent:event', { ...msg, runId, chatId: runChat }); // and another window's sidebar that shows this chat too
  };
  const out = createCoalescer(sendOut);
  const emit = (msg) => {
    let aiTabs = null; // [ai manners] the tabs this run opened that can still be closed (under the reply, or closed by the setting)
    if (msg.type === 'done' && !run.deleted) { aiTabs = aiTabsAfterRun(runId); if (aiTabs) msg = { ...msg, aiTabs }; try { msg = { ...msg, aiTabCount: aiTabSelect({ runId }).length }; } catch { /* none */ } } // (aiTabCount: the activity card's "Hide tabs the AI opened (N)")
    if (msg.type !== 'text' && msg.type !== 'thinking' && !msg.frame) setImmediate(pushAgentTarget); // the run's tab pinned, moved or gone (a live picture of an app window changes neither)
    if (msg.type !== 'text' && msg.type !== 'thinking' && !msg.frame) run.tabId = agent.runTabIdFor(run.messages) ?? run.tabId; // kept for the end (the scope is gone by 'done')
    if (msg.type === 'tool_done' && msg.ok && run.tabId != null) { // [tab chips] the tab an open_tab made is the one the run now works in
      const tool = run.details.tools.find((x) => x.id && x.id === msg.id);
      if (tool && /^(mcp__lumen__)?open_tab$/.test(String(tool.name))) msg = { ...msg, tabId: run.tabId };
    }
    trackRunDetails(run, msg);
    if (msg.type === 'card_files' && run.doneMsg && !run.deleted) { stampRun(run, run.doneMsg); if (isOpen()) saveChatSoon(chatGeneration); else saveChatOfSoon(runChat, run.messages); } // (files listed after the run ended: kept too)
    const afterMsg = []; // (the card's tab / site, said right after the step that named it: the chat has drawn the step's card by then)
    const pushThumb = (ev) => {
      if (run.deleted) return;
      trackRunDetails(run, ev);
      out.push(ev);
      // The last frame can land just after 'done' (a capture under way when the run ended, see features/step-thumbs.js stop()): the card shows it
      // (chat-core.js) and the saved reply keeps it too, so "Open preview" and a reopened chat both name the tab the run ended in.
      if (run.doneMsg && ev.type === 'thumb') { stampRun(run, run.doneMsg); if (isOpen()) saveChatSoon(chatGeneration); else saveChatOfSoon(runChat, run.messages); }
    };
    try { noteThumbs(run, msg, (ev) => { if (ev.kind === 'pending' || ev.kind === 'site') afterMsg.push(ev); else pushThumb(ev); }); } catch (err) { if (TEST) (global.__thumbsState.errors ||= []).push(String(err && err.stack || err)); else console.error('[thumbs]', err && err.message); } // (a picture of the page must never cost the chat a step)
    if (msg.type === 'text') run.reply += msg.text;
    else if (msg.type === 'tool' || msg.type === 'retry') run.reply = ''; // the reply is what comes after the last step
    else if (msg.type === 'error') { run.error = msg.text || 'error'; run.errorSummary = msg.summary || ''; }
    else if (msg.type === 'notice' && msg.text === 'Stopped.') run.stopped = true;
    if (msg.type === 'approval') { run.pending.set(msg.approvalId, msg); tellUser(run, 'approval'); }
    else if (msg.type === 'approval_done' && run.pending.delete(msg.approvalId)) pushAttention();
    if (msg.type === 'done') {
      run.doneMsg = msg;
      if (!run.deleted) stampRun(run, msg);
      const mine = chatRuns.get(runChat) === run;
      if (mine) { const wt = run.tabId ?? run.homeTab; if (wt != null) chatWorkTab.set(runChat, wt); else chatWorkTab.delete(runChat); if (chatWorkTab.size > 500) chatWorkTab.delete(chatWorkTab.keys().next().value); }
      if (mine) chatRuns.delete(runChat);
      if (mine) runSlots.release(runChat); // the next chat in line may start
      if (chatPageRt.runs.get()?.runId === runId) chatPageRt.endRun();
    }
    out.push(msg);
    for (const ev of afterMsg) pushThumb(ev);
    if (msg.type === 'tool' && msg.name === 'use_skill') { // [skills] the AI loaded a skill: a correction after this run can offer to update it
      const used = skillsFeature.autoSkills().find((x) => x.name === String(msg.input?.name || '').trim().toLowerCase());
      if (used) skillsFeature.learning.used(runChat, { id: used.id, name: used.name });
    }
    if (msg.type === 'done' && !run.deleted) { // [skills] Settings → Skills → "Offer to save and improve skills": a card under the reply, never a save
      const offer = skillsFeature.learning.done(runChat, { enabled: readSettings().skillsSuggest === true, ok: !run.error && !run.stopped, toolNames: run.details.tools.filter((x) => x.id).map((x) => x.name), skillInfo: (id) => skillsFeature.findAny(id) });
      if (offer) sendOut({ type: 'skill_offer', ...offer });
    }
    if (msg.type === 'done') {
      if (!run.deleted) (isOpen() ? saveChat() : saveChatOf(runChat, run.messages));
      if (!run.deleted && !temporaryChats.has(runChat)) missionFinished(run); // [mission control] the page's Recent list
      tellUser(run, chatRunsLib.outcome(run));
      setImmediate(pushAgentTarget);
      if (aiTabs?.mode === 'close') { // Settings > "Close tabs the AI opened when it finishes": Always
        aiTabsClose({ runId }, { auto: true }).then((r) => { chatPageRt.emit(to(), 'agent:event', { type: 'ai_tabs_closed', runId, n: r.closed, kept: r.kept, busy: r.busy, token: r.token }); if (r.closed) aiCloseNote(r.rec || curRec, r); }).catch(() => {}); // (the toast has Undo too, for when the row under the reply is gone)
      }
    } else if (msg.type === 'tool_done' && !run.deleted) (stampRun(run), isOpen() ? saveChatSoon(chatGeneration) : saveChatOfSoon(runChat, run.messages));
    else if (msg.type === 'usage' && isOpen()) { ui()?.send('chats:usage', describeUsage(msg.usage)); chatPageRt.broadcast('chats:usage', describeUsage(msg.usage), ui()); }
    else if (msg.type === 'context' && isOpen()) { ui()?.send('chats:context', msg.context); chatPageRt.broadcast('chats:context', msg.context, ui()); } // [context] the meter under the composer
    else if (msg.type === 'error' && msg.signInExpired) { cliLoginValid = false; client = null; modelsChanged(); }
  };
  const skillRun = skillsFeature.takeRun(askText);
  skillsFeature.learning.ask(runChat, askText, skillRun ? { id: skillRun.id, name: skillRun.name } : null); // [skills] a "/" run, or a follow-up that may correct one
  const tabsPicked = tabsAsk.cleanIds(tabIds);
  const start = () => {
    if (run.deleted) { runSlots.release(runChat); return; }
    const wasQueued = run.queued;
    run.queued = false;
    if (wasQueued) chatPageRt.emit(to(), 'agent:event', { type: 'status', text: '', runId }); // the waiting line goes
    const tabId = fromChatPage ? undefined : runHomeTab(run); // [chat per tab] where this chat is bound, not the tab in front now
    const leftOut = chatImages.rejectionNotice(rejected);
    if (leftOut) emit({ type: 'notice', text: leftOut });
    // tabIds: the tabs the user picked with "@" (features/tabs-ask.js); a skill run (features/skills.js) carries its mode and model
    const askExtra = { tabs: tabsPicked, tabId, messages, hosts, files: attachedFiles, screen: !fromChatPage && (screenMode === 'on' || screenMode === 'off') ? screenMode : undefined, fullPage: fromChatPage, fromPage: fromChatPage, meta: { rec: run.rec, chatId: runChat, runId } };
    // [plan mode] askOpts.plan: this message only reads and proposes a plan (agent.js planCheck). askOpts.approvedPlan: the user pressed
    // Run plan, so the plan's sites join this chat's approved sites for clicking and typing only ("interact:<host>", ai/plan-mode.js
    // approvedKeys): opening or sending to one after reading a page, and scripts there, still ask.
    const planOpts = askOpts && typeof askOpts === 'object' ? askOpts : {};
    if (planOpts.approvedPlan) for (const key of planModeLib.approvedKeys(planOpts.approvedPlan)) hosts.add(key);
    else if (planOpts.plan === true) askExtra.plan = true;
    // [working-on chip] A chat-page run takes a tab at once only when the request is about the page the user is looking at; any other
    // request (a downloaded file, a search) takes one when its tools first need it (agentActiveTab).
    if (fromChatPage && agent.aboutCurrentPage(askText, askExtra)) { const cand = chatPageRt.pick(); if (cand != null) chatPageRt.retarget(cand); }
    agent.run(askText, emit, valid, askExtra, skillRun);
    bumpChat(runChat); // (a run that waited for a slot is in use again now)
    pushAttention(); // the chat list shows it running
  };
  // [chat per tab] How many chats may work at once is a setting (0 / "unlimited": no cap); the next waits its turn.
  // Claude Code and Grok Build chats run side by side like any other: each run has its own MCP connection, found by
  // its own tag (features/ai-agents.js leaseEngine). Every CLI chat runs on a slot of kind 'cli' (tab-chats.js slotKind).
  runSlots.setMax(readSettings().maxChatRuns);
  const kind = tabChatsLib.slotKind(autoModel.scopeOf(messages.settings?.autoFrom) ? messages.settings.autoFrom : messages.settings?.model || effectiveModel()); // ('auto' counts as an API chat; a provider's own Auto, 'grokbuild:auto', as that provider)
  if (runSlots.request(runChat, { kind, start, alive: () => run.queued || agent.runningFor(messages) || chatRuns.get(runChat) !== run }) === 'queued') {
    run.queued = true;
    run.waitReason = runSlots.reason(runChat);
    chatPageRt.emit(to(), 'agent:event', { type: 'status', text: waitingText(run), runNow: true, runId });
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
// "Run now" on a chat that waits for a slot (the cap on chats working at once): it starts beside the others. The sender's open chat.
ipcMain.handle('chats:run-now', (event) => { syncToSender(event); const run = chatRuns.get(chatId); return Boolean(run?.queued && runSlots.runNow(chatId)); });
// The chat list's "Stop waiting": answers whether a run was there to stop (the list shows a failure when not).
ipcMain.handle('chats:stop', (_e, id) => (typeof id === 'string' && id ? stopChat(id) : false));
ipcMain.on('agent:stop', (event, id) => {
  if (typeof id === 'string' && id) { stopChat(id); return; }
  syncToSender(event);
  const run = chatRuns.get(chatId);
  if (run?.queued) run.cancelQueued(); // it never started: leaves the waiting line
  else if (run?.messages) agent.stopFor(run.messages); // [stop always works] the chat's own run, even when the agent's open conversation is another
  else agent.stopOpen(); // (no run of its own: only the open conversation's, never another chat's that happens to be the only one going)
});
// "Working in: …" in the sidebar: jump to the tab the task works in.
ipcMain.on('agent:show-target', (event) => { syncToSender(event); const id = agent.runTabId(); const rec = runRecNow(); if (id != null && agent.running) (rec ? withWindow(rec, () => switchTab(id)) : switchTab(id)); });
// New chat: the open chat stays in the history list.
// [screen context] The chip's x: the screenshot of one earlier message is taken out of the chat (never mid-run), so later turns don't carry it.
ipcMain.handle('agent:screen-drop', (_e, id) => {
  syncToSender(_e);
  if (typeof id !== 'string' || !/^[\w-]{1,40}$/.test(id) || agent.runningFor(agent.messages)) return false;
  const n = screenContext.dropFrom(agent.messages, id);
  if (n) { saveChatSoon(chatGeneration); chatPageRt.broadcast('chat:sync', { view: chatView() }, _e.sender); }
  return n > 0;
});
// [versions] Regenerate / Edit of any user message (ordinal: its place among the sidebar's user messages): it and what followed are
// taken back and kept as a version. Answers { result, versions }.
ipcMain.handle('agent:rewind-user', (_e, ordinal, expected) => {
  syncToSender(_e);
  if (!Number.isInteger(ordinal) || ordinal < 0) return { result: 'absent' };
  if (agent.runningFor(agent.messages) || chatRuns.get(chatId)?.queued) return { result: false }; // never mid-run
  const out = agent.rewindUser(ordinal, typeof expected === 'string' ? expected : '');
  if (out.result === 'rewound') { saveChatSoon(chatGeneration); chatPageRt.broadcast('chat:sync', { view: chatView() }, _e.sender); }
  return out;
});
// [versions] The version switch: another version of an exchange becomes the chat. Answers the chat's new view (or null).
ipcMain.handle('agent:version', (_e, at, target) => {
  syncToSender(_e);
  if (!Number.isInteger(at) || !Number.isInteger(target)) return null;
  if (agent.runningFor(agent.messages) || chatRuns.get(chatId)?.queued) return null;
  if (!agent.switchVersion(at, target)) return null;
  saveChat();
  const view = chatView();
  chatPageRt.broadcast('chat:sync', { view }, _e.sender);
  return view;
});
// [versions] The thumb under a reply, kept with the chat on this computer.
ipcMain.handle('agent:feedback', (_e, ordinal, value) => {
  syncToSender(_e);
  if (!Number.isInteger(ordinal) || ordinal < 0 || !(value === null || value === 'up' || value === 'down')) return false;
  const ok = agent.setFeedback(ordinal, value);
  if (ok) saveChatSoon(chatGeneration);
  return ok;
});
ipcMain.handle('agent:rewind', (_e, expected) => {
  syncToSender(_e);
  if (agent.runningFor(agent.messages) || chatRuns.get(chatId)?.queued) return false; // never mid-run
  const result = agent.rewindLast(typeof expected === 'string' ? expected : '');
  if (result === 'rewound') { saveChatSoon(chatGeneration); chatPageRt.broadcast('chat:sync', { view: chatView() }, _e.sender); } // the other view drops it too
  return result;
});
// [btw] /btw <question>: answered at once from a snapshot of the open chat, by one tool-less model call (agent.js btw), beside whatever the
// chat is doing: it never touches the run, its history or its steps. The answer streams to the asking view ('agent:btw-event'); the tokens
// join the chat's usage. `id` names the card in the sidebar; Esc / the card's × cancels it (agent:btw-cancel).
const btwRuns = new Map(); // `${sender id}:${card id}` -> AbortController
ipcMain.handle('agent:btw', async (event, id, text) => {
  if (typeof id !== 'string' || !/^[\w-]{1,40}$/.test(id) || btwRuns.size >= 12) return { ok: false, error: 'busy' };
  syncToSender(event);
  const runChat = chatId;
  const messages = agent.messages;
  const at = agentActiveTab();
  const url = at?.webContents && !at.webContents.isDestroyed?.() ? at.webContents.getURL() : '';
  const tab = at && !aiSites.isOff(url) ? { title: at.webContents.getTitle(), url } : null; // (a site the user keeps the AI off is not told)
  const key = `${event.sender.id}:${id}`;
  const ctrl = new AbortController();
  btwRuns.set(key, ctrl);
  const send = (payload) => { if (!event.sender.isDestroyed()) event.sender.send('agent:btw-event', { id, ...payload }); };
  const emit = (msg) => {
    if (msg.type !== 'usage') return;
    if (runChat === chatId && messages === agent.messages) { ui()?.send('chats:usage', describeUsage(msg.usage)); chatPageRt.broadcast('chats:usage', describeUsage(msg.usage), ui()); saveChatSoon(chatGeneration); }
    else saveChatOfSoon(runChat, messages);
  };
  try {
    const r = await agent.btw({ messages, tab, question: String(text || ''), signal: ctrl.signal, emit, onText: (chunk) => send({ type: 'text', text: chunk }) });
    return { ok: r.ok, text: r.text, error: r.error, model: r.model, name: r.name, engine: r.engine || null, engineName: r.engineName || null, viaDefault: Boolean(r.viaDefault) };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 300) };
  } finally {
    btwRuns.delete(key);
  }
});
ipcMain.on('agent:btw-cancel', (event, id) => { btwRuns.get(`${event.sender.id}:${id}`)?.abort(); });
// [autocomplete] Tab to finish the message being typed: a guess at the rest of `prefix` from the open chat (agent.js autocomplete). One guess per
// view at a time: a newer one (or agent:autocomplete-cancel) stops the one before. Off in Settings > AI, with the AI off, or on a site the AI is kept off.
const autocompleteRuns = new Map(); // sender id -> AbortController
ipcMain.handle('agent:autocomplete', async (event, prefix) => {
  if (typeof prefix !== 'string' || readSettings().chatAutocomplete === false) return { ok: false, error: 'off', text: '' };
  autocompleteRuns.get(event.sender.id)?.abort();
  const ctrl = new AbortController();
  autocompleteRuns.set(event.sender.id, ctrl);
  // (read-only: the sender's chat and tab are read without taking the open chat from another window)
  const { messages, tab } = readForSender(event, () => {
    const at = agentActiveTab();
    const url = at?.webContents && !at.webContents.isDestroyed?.() ? at.webContents.getURL() : '';
    return { messages: agent.messages, tab: at && url && !aiSites.isOff(url) ? { title: at.webContents.getTitle() } : null };
  });
  try {
    const r = await agent.autocomplete({ messages, tab, prefix, signal: ctrl.signal });
    return { ok: r.ok, text: r.text || '', error: r.error };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 200), text: '' };
  } finally {
    if (autocompleteRuns.get(event.sender.id) === ctrl) autocompleteRuns.delete(event.sender.id);
  }
});
ipcMain.on('agent:autocomplete-cancel', (event) => { autocompleteRuns.get(event.sender.id)?.abort(); });
// New chat; `temporary`: one that is never saved (chats:temporary).
function startNewChat(event, { temporary = false } = {}) {
  syncToSender(event);
  switchChat(null);
  if (temporary) temporaryChats.add(chatId);
  const forTab = pageTabOf(event.sender)?.id ?? activeId; // (a chat page's New chat is its own tab's)
  chatBind.bind(forTab, chatId); // [chat per tab] the tab shows its new chat; the old one stays in the list (and keeps working if it is)
  if (event.sender && !event.sender.isDestroyed()) shownChat.set(event.sender, chatId);
  pushAttention();
  chatPageRt.broadcast('chat:sync', { view: chatView() }, event.sender);
}
ipcMain.on('agent:reset', (event) => startNewChat(event));
// [temporary chat] A new chat that is not saved or listed; gone once the user leaves it. Returns the view.
ipcMain.handle('chats:temporary', (event) => { startNewChat(event, { temporary: true }); return chatView(); });

// ---- the sidebar's chat history list (features/chat-store.js)
// [chat per tab] Where a chat lives: the tab it is bound to (or, while it works, the tab it works in).
// { id, title, here } ('here': it is the tab in front), or null.
// `tabs`: every tab it shows in, its home first ([{ id, title, home, here }]; a chat in several tabs is shared).
// The tabs a chat shows in, its home first: the tab its run works in while it runs, else the tab it was last started or
// moved in; then the others, newest first. (A run's tab counts even if that tab now shows another chat: the work is there.)
function chatTabOrder(id) {
  const working = chatRuns.get(id);
  const pinned = working && !working.deleted && !working.queued ? agent.runTabIdFor(working.messages) : null;
  const home = pinned ?? chatBind.homeOf(id);
  const order = [...(home != null ? [home] : []), ...chatBind.tabsHomeFirst(id).filter((t) => t !== home)];
  return order.filter((tid) => tabAnywhere(tid));
}
function chatPlaceOf(id) {
  const candidates = chatTabOrder(id);
  const tabId = candidates.includes(activeId) ? activeId : candidates[0];
  if (tabId == null) return null;
  const found = tabAnywhere(tabId);
  if (!found) return null;
  const isHere = (tid, rec) => tid === activeId && rec === curRec;
  const tabsShown = candidates.map((tid, i) => { const f = tabAnywhere(tid); return { id: tid, title: withWindow(f.rec, () => tabTitle(f.t)) || '', home: i === 0, here: isHere(tid, f.rec) }; });
  return { id: tabId, title: withWindow(found.rec, () => tabTitle(found.t)) || '', here: isHere(tabId, found.rec), place: tabChatsLib.chatPlace({ tabId, here: isHere(tabId, found.rec) }), tabs: tabsShown };
}
// ---------- [notes] Quick notes (ai/notes.js; features/notes-hub.js; docs/notes.md) ----------
// A small notepad kept in <userData>/notes.json: the sidebar's Notes panel, "Add to notes" on a reply or a page selection, and the AI's `notes`
// tool (agent.js notesTool: read and add only). Nothing leaves the computer unless the user asks the AI about a note.
let notesStoreRef = null;
const notesStore = () => (notesStoreRef ||= require('./ai/notes').createNotesStore({ file: path.join(app.getPath('userData'), 'notes.json') }));
function pushNotes() {
  for (const rec of winRecs) {
    const w = rec === curRec ? win : rec.win;
    if (w && !w.isDestroyed()) w.webContents.send('notes:changed', null);
  }
}
const notesHub = lazy(() => require('./features/notes-hub').create({
  store: notesStore(),
  push: pushNotes,
  imageBytes: (id) => { const r = imageStore().read(id); return r ? { buffer: r.buffer, mime: r.mime } : null; },
}));
ipcMain.handle('notes:act', (_e, op, arg) => notesHub.act(String(op ?? ''), arg));
function addSelectionToNotes(wc, text) {
  const r = notesHub.act('add-selection', { text, title: wc.getTitle(), url: pdfViewer.pdfUrlOf(wc.getURL()) || wc.getURL() });
  toast(r.ok ? t('notes.added') : t('notes.addFailed'));
}
if (TEST) global.__notesStore = notesStore;
// ---------- [research] the Research board panel (ai/research-board.js; the AI's research_board tool edits the same board) ----------
// The board is the open chat's settings.research: saved, restored and deleted with the chat. Every handler first follows the sender's
// chat (syncToSender) and only touches that board; nothing here reads a page except "Add this page" / "Pin selection", which the user
// clicks, and which only read (meta tags, JSON-LD, the selected text). A URL opened from the board must be one the board holds.
const researchLib = { board: require('./ai/research-board'), citations: require('./ai/citations'), meta: require('./ai/page-meta') };
function pushResearch() {
  for (const rec of winRecs) {
    const w = rec === curRec ? win : rec.win;
    if (w && !w.isDestroyed()) w.webContents.send('research:changed', null);
  }
  chatPageRt?.broadcast('research:changed', null, ui());
}
function researchChanged(chat) {
  if (chat === agent.messages) { pushResearch(); saveChatSoon(); }
}
function researchState() {
  const b = agent.researchBoard(agent.messages) || researchLib.board.emptyBoard();
  return { chat: chatId, ...researchLib.board.view(b), styles: researchLib.citations.STYLES.concat(researchLib.citations.EXPORTS).map((id) => ({ id, name: researchLib.citations.STYLE_NAMES[id] })) };
}
const researchBoardForWrite = () => agent.researchBoard(agent.messages, true);
const researchSource = (n) => researchLib.board.byNumber(researchBoardForWrite(), n);
function researchFrontTab() {
  const tab = tabs.find((x) => x.id === activeId && alive(x));
  const wc = tab?.view?.webContents;
  return wc && !wc.isDestroyed() ? wc : null;
}
ipcMain.handle('research:get', (event) => readForSender(event, researchState));
ipcMain.handle('research:add-page', async (event) => {
  syncToSender(event);
  const wc = researchFrontTab();
  if (!wc) return { ok: false, reason: 'no-tab' };
  const url = wc.getURL();
  const pdf = pdfViewer.pdfUrlOf(url);
  let raw;
  try {
    if (pdf) raw = { url: pdf, title: require('./features/pdf-text').pdfName(pdf), metas: [], jsonld: [], body: '' };
    else if (/^https?:/i.test(url)) raw = JSON.parse(await Promise.race([wc.executeJavaScript(researchLib.meta.PAGE_SCRIPT), new Promise((_r, reject) => setTimeout(() => reject(new Error('timeout')), 6000))]));
    else return { ok: false, reason: 'not-web' };
  } catch { return { ok: false, reason: 'unreadable' }; }
  const meta = researchLib.meta.fromRaw(raw);
  try {
    const { source, added } = researchLib.board.addSource(researchBoardForWrite(), meta, { by: 'user' });
    saveChatSoon();
    pushResearch();
    return { ok: true, n: source.n, added, doi: Boolean(source.doi), metaFound: meta.metaFound };
  } catch (err) { return { ok: false, reason: 'error', message: err.message }; }
});
ipcMain.handle('research:update', (event, n, patch) => {
  syncToSender(event);
  const p = patch && typeof patch === 'object' ? patch : {};
  const ok = Boolean(researchLib.board.updateSource(researchBoardForWrite(), n, { starred: p.starred, note: p.note, title: p.title }, { by: 'user' }));
  if (ok) { saveChatSoon(); pushResearch(); }
  return ok;
});
ipcMain.handle('research:remove', (event, n) => {
  syncToSender(event);
  const ok = researchLib.board.removeSource(researchBoardForWrite(), n, { by: 'user' });
  if (ok) { saveChatSoon(); pushResearch(); }
  return ok;
});
ipcMain.handle('research:pin', (event, n, text, page) => {
  syncToSender(event);
  const s = researchSource(n);
  if (!s) return { ok: false };
  try {
    const link = researchLib.board.fragmentUrl(s.url, text, { page: Number(page) || null });
    researchLib.board.addQuote(researchBoardForWrite(), n, { text, page: Number(page) || null, url: link, verified: null }, { by: 'user' });
  } catch (err) { return { ok: false, message: err.message }; }
  saveChatSoon(); pushResearch();
  return { ok: true };
});
// The text selected in the tab in front, pinned to source n; when that tab is the source's own page the quote is verified by the user's own selection.
ipcMain.handle('research:pin-selection', async (event, n) => {
  syncToSender(event);
  const s = researchSource(n);
  const wc = researchFrontTab();
  if (!s || !wc) return { ok: false, reason: 'no-tab' };
  let text = '';
  try { text = String(await wc.executeJavaScript('String(getSelection() || "")')).replace(/\s+/g, ' ').trim(); } catch { /* a page that will not answer */ }
  if (!text) return { ok: false, reason: 'no-selection' };
  const here = researchLib.board.keysOf({ url: researchLib.meta.cleanUrl(pdfViewer.pdfUrlOf(wc.getURL()) || wc.getURL()), title: '' });
  const own = researchLib.board.keysOf(s).some((k) => k.startsWith('u:') && here.includes(k));
  try {
    researchLib.board.addQuote(researchBoardForWrite(), n, { text, url: researchLib.board.fragmentUrl(s.url, text), verified: own ? true : null }, { by: 'user' });
  } catch (err) { return { ok: false, reason: 'error', message: err.message }; }
  saveChatSoon(); pushResearch();
  return { ok: true, verified: own };
});
ipcMain.handle('research:unpin', (event, n, q) => {
  syncToSender(event);
  const ok = researchLib.board.removeQuote(researchBoardForWrite(), n, String(q));
  if (ok) { saveChatSoon(); pushResearch(); }
  return ok;
});
// "Copy citation" (n) / "Copy bibliography" (null): the clipboard gets rich text (italics) and plain text.
ipcMain.handle('research:cite', (event, n, style) => {
  syncToSender(event);
  const b = researchBoardForWrite();
  const whole = n === null || n === undefined;
  const chosen = whole ? b.sources : [researchLib.board.byNumber(b, n)].filter(Boolean);
  const st = researchLib.citations.STYLES.concat(researchLib.citations.EXPORTS).includes(style) ? style : 'apa';
  if (!chosen.length) return { ok: false, reason: 'empty' };
  try {
    const out = whole ? researchLib.citations.bibliography(chosen, st) : { ...researchLib.citations.format(chosen[0], st), count: 1 };
    if (st === 'bibtex' || st === 'ris') clipboard.writeText(out.text);
    else clipboard.write({ text: out.text, html: out.html });
    return { ok: true, count: out.count, style: st };
  } catch (err) { return { ok: false, reason: 'error', message: err.message }; }
});
ipcMain.handle('research:open', (event, url) => {
  syncToSender(event);
  const b = agent.researchBoard(agent.messages);
  const wanted = String(url || '');
  const known = b?.sources.some((s) => s.url === wanted || s.pdfUrl === wanted || s.oaUrl === wanted || s.quotes.some((q) => q.url === wanted));
  if (!known || !/^https?:\/\//i.test(wanted)) return false;
  openTab(wanted);
  return true;
});

ipcMain.handle('chats:list', (event) => readForSender(event, () => {
  sweepTrash();
  return {
    current: chatId,
    currentUsage: describeUsage(agent.messages.settings?.usage),
    currentContext: contextView(agent.messages.settings?.context), // [context]
    maxRuns: runSlots.limit,
    projects: (() => { lookAtProjectFolders(); return chats().projects().map(withFolderState); })(), // [projects] (+ [project folders] whether the folder is there)
    chats: (() => {
      const badges = chatBadges();
      const saved = chats().list().filter((c) => !c.missing); // (a chat whose file is gone is not shown: it would open empty)
      // A chat that is working or waiting for a slot and has no file yet (its first reply is still coming) is listed too.
      const unsaved = [...chatRuns.values()].filter((r) => runIsLive(r) && !saved.some((c) => c.id === r.chatId))
        .map((r) => ({ id: r.chatId, title: String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, 60), created: Date.now(), updated: Date.now() }));
      return [...unsaved, ...saved].map((c) => { const place = chatPlaceOf(c.id); return { id: c.id, title: c.title, created: c.created, updated: c.updated, usage: describeUsage(c.usage), pinned: Boolean(c.pinned), archived: Boolean(c.archived), ...((c.project || pendingProject.get(c.id)) ? { project: c.project || pendingProject.get(c.id) } : {}), badge: badges.get(c.id) || null, tab: place, tabs: place?.tabs || [], aiTabs: aiTabSelect({ chatId: c.id }).length }; });
    })(),
  };
}));
// "Move chat to this tab" (and opening a chat that lives in no tab): the chat now belongs to the tab in front.
// Chats opened one after another: the read of an earlier one is dropped (it answers with whatever is open by then), so the last click is the chat shown.
let openSeq = 0;
async function readForOpen(id) {
  const mine = ++openSeq;
  const loaded = chatRuns.has(id) || id === chatId ? null : await chats().loadAsync(id); // (read in the background; the switch itself is then quick)
  return { loaded, stale: mine !== openSeq };
}
ipcMain.handle('chats:open', async (event, id) => {
  const { loaded, stale } = await readForOpen(String(id));
  if (stale) return chatView();
  syncToSender(event); // (with the switch, as one step: nothing else runs between them)
  const view = switchChat(String(id), { loaded });
  if (view) {
    bindOpenChatHere(event.sender);
    chatPageRt.broadcast('chat:sync', { view }, event.sender); // the other view shows the chat that was opened
  }
  return view;
});
// "Also show in this tab": the chat shows in the tab in front as well, and stays in the tabs it was in. Nothing else
// changes: its home tab stays, a run keeps working there, and this tab's earlier chat only loses this tab.
ipcMain.handle('chats:share', async (event, id) => {
  const { loaded, stale } = await readForOpen(String(id));
  if (stale) return chatView();
  syncToSender(event);
  const view = switchChat(String(id), { loaded });
  if (view) {
    const forTab = pageTabOf(event.sender)?.id ?? activeId;
    chatBind.bind(forTab, chatId, { share: true });
    if (event.sender && !event.sender.isDestroyed()) shownChat.set(event.sender, chatId);
    pushAttention();
    refreshSidebars();
    chatPageRt.broadcast('chat:sync', { view }, event.sender);
  }
  return view;
});
// "Open chat in its tab": show the tab the chat lives in (its window comes to the front).
ipcMain.handle('chats:show-tab', (event, id) => {
  id = String(id);
  // The home tab; for a chat shown in several tabs, the tab you are not on (the home, or another when you are on the home).
  const place = (() => {
    const order = chatTabOrder(id);
    const tid = order.length > 1 && order[0] === activeId ? order[1] : order[0];
    const f = tid != null ? tabAnywhere(tid) : null;
    return f ? { tid, ...f } : null;
  })();
  if (!place) return false;
  withWindow(place.rec, () => { switchTab(place.tid); });
  if (rcAlive(place.rec)) { if (place.rec.win.isMinimized()) place.rec.win.restore(); place.rec.win.focus(); }
  return true;
});
// [projects] The list, and every change: a new one, an edit, delete (its chats stay, out of any project), a chat moved in or out,
// and a new chat that starts inside a project.
const projectFields = (p) => ({ id: p?.id ? String(p.id) : undefined, name: String(p?.name ?? '').slice(0, 200), instructions: p?.instructions === undefined ? undefined : String(p.instructions).slice(0, 20000) });
const dialogParent = (event) => { try { return BrowserWindow.fromWebContents(event.sender) || win; } catch { return win; } };
async function pickFolder(event, title, defaultPath) {
  const picked = await electronDialog.showOpenDialog(dialogParent(event), { title, ...(defaultPath ? { defaultPath } : {}), properties: ['openDirectory', 'createDirectory'] });
  return picked.canceled || !picked.filePaths[0] ? null : picked.filePaths[0];
}
// [project folders] Creating a project makes <Documents>\Lumen Projects\<name> (folderMode 'existing' with `folder` uses a folder the user picked;
// 'none' makes none). Answers the project, { error } for a folder that cannot be used ('root' and 'home' want `confirmed: true`), or null.
ipcMain.handle('chats:project-save', async (_e, project) => {
  const fields = projectFields(project);
  let made = '';
  try {
    const use = async (dir, confirmed) => { const chk = await projectFolders.checkWorkFolder(String(dir || ''), { confirmed: confirmed === true }); if (!chk.ok) throw Object.assign(new Error(chk.reason), { reason: chk.reason }); return chk.real; };
    if (!fields.id) {
      if (project?.folderMode === 'existing') { fields.folder = await use(project.folder, project.confirmed); fields.folderCreated = false; }
      else if (project?.folderMode !== 'none' && fields.name.trim()) { made = await projectFolders.createProjectFolder({ parent: projectsParent(), name: fields.name }); fields.folder = made; fields.folderCreated = true; }
    } else if (project?.folderMode === 'new') { // a project from before folders gets one now
      if (!projectById(fields.id)?.folder) { made = await projectFolders.createProjectFolder({ parent: projectsParent(), name: fields.name }); fields.folder = made; fields.folderCreated = true; }
    } else if (project?.folder !== undefined) {
      if (project.folder) { fields.folder = await use(project.folder, project.confirmed); fields.folderCreated = false; } else fields.folder = '';
    }
    if (typeof project?.mirror === 'boolean') fields.mirror = project.mirror;
    if (project?.workFolder !== undefined) fields.workFolder = project.workFolder ? await use(project.workFolder, project.confirmedWork) : '';
  } catch (err) {
    if (made) fs.promises.rmdir(made).catch(() => {});
    return { error: err.reason || 'folder', message: String(err.message).slice(0, 200) };
  }
  const out = chats().saveProject(fields);
  if (!out) { if (made) fs.promises.rmdir(made).catch(() => {}); return null; }
  syncProjectInstructions();
  pushAttention();
  return withFolderState(out);
});
// [project workspace] Deleting a project can be undone for a while (the page's toast): the project, its chats' membership, its memory and its
// files all wait; once the time is over the files go. (A project's folder on disk, and what is in it, is never touched.)
const PROJECT_UNDO_MS = 12000;
const pendingProjectDeletes = new Map(); // project id -> { snapshot, memory, timer }
function finishProjectDelete(id) {
  const held = pendingProjectDeletes.get(id);
  if (!held) return;
  clearTimeout(held.timer);
  pendingProjectDeletes.delete(id);
  projectFiles().removeProject(id).catch(() => {});
}
ipcMain.handle('chats:project-delete', (_e, id) => {
  id = String(id);
  const snapshot = chats().projectSnapshot(id);
  const ok = chats().removeProject(id);
  if (!ok) return false;
  for (const [chat, pid] of pendingProject) if (pid === id) pendingProject.delete(chat);
  let gone = [];
  try { gone = memory().dropProject(id); memoryEdited(); } catch { /* memory off or unreadable: nothing to drop */ }
  finishProjectDelete(id); // (a second delete of a restored one: the first timer is over)
  pendingProjectDeletes.set(id, { snapshot, memory: gone, timer: setTimeout(() => finishProjectDelete(id), PROJECT_UNDO_MS) });
  syncProjectInstructions();
  pushAttention();
  return ok;
});
ipcMain.handle('chats:project-undo', (_e, id) => {
  id = String(id);
  const held = pendingProjectDeletes.get(id);
  if (!held) return null;
  if (!chats().restoreProject(held.snapshot)) return null;
  clearTimeout(held.timer);
  pendingProjectDeletes.delete(id);
  try { memory().restoreEntries(held.memory); memoryEdited(); } catch { /* the memory could not be put back */ }
  syncProjectInstructions();
  pushAttention();
  return projectById(id);
});
ipcMain.handle('chats:project-set', (_e, id, projectId) => {
  const before = [[String(id), projectIdOf(String(id))]];
  const ok = chats().setProject(String(id), projectId ? String(projectId) : null);
  if (ok) { syncProjectInstructions(); mirrorAfterMove(before); }
  return ok;
});
// Drag and drop, and the row menu's "Move to project": one or several chats in one write, then every list redraws (pushAttention).
// Answers { moves: [{ id, from }] } (what actually moved: the toast's Undo hands it back to chats:project-restore) or null. Moving is not
// activity (the recency order stays) and does not touch a running chat. A chat still working on its first reply has no saved entry yet:
// its project waits in pendingProject, as for a chat started inside a project.
const chatIdList = (ids) => (Array.isArray(ids) ? [...new Set(ids.map(String))].slice(0, 200) : []);
ipcMain.handle('chats:project-move', (_e, ids, projectId) => {
  const list = chatIdList(ids);
  const target = projectId ? String(projectId) : null;
  if (target && !chats().projects().some((p) => p.id === target)) return null;
  const before = list.map((id) => [id, projectIdOf(id)]);
  const moves = chats().moveToProject(list, target);
  if (!moves) return null;
  for (const id of list) {
    if (moves.some((m) => m.id === id) || chats().has(id) || !chatRuns.has(id) || !runIsLive(chatRuns.get(id))) continue;
    const from = pendingProject.get(id) || null;
    if (from === target) continue;
    if (target) pendingProject.set(id, target); else pendingProject.delete(id);
    moves.push({ id, from });
  }
  if (moves.length) { syncProjectInstructions(); pushAttention(); mirrorAfterMove(before); }
  return { moves };
});
ipcMain.handle('chats:project-restore', (_e, moves) => {
  const list = (Array.isArray(moves) ? moves : []).slice(0, 200).filter((m) => m && typeof m.id === 'string').map((m) => ({ id: m.id, from: m.from ? String(m.from) : null }));
  const before = list.map((m) => [m.id, projectIdOf(m.id)]);
  let n = chats().restoreProjects(list);
  for (const m of list) {
    if (chats().has(m.id) || !chatRuns.has(m.id)) continue;
    if (m.from && chats().projects().some((p) => p.id === m.from)) pendingProject.set(m.id, m.from); else pendingProject.delete(m.id);
    n++;
  }
  if (n) { syncProjectInstructions(); pushAttention(); mirrorAfterMove(before); }
  return n;
});
ipcMain.handle('chats:new-in-project', (event, projectId) => {
  if (!chats().projects().some((p) => p.id === String(projectId))) return null;
  startNewChat(event);
  pendingProject.set(chatId, String(projectId));
  // [project workspace] The project's default model starts this chat (only this chat: the saved pick of every other chat is not changed).
  const want = projectById(String(projectId))?.defaults?.model;
  if (want) { try { if (effectiveModel(want) === want) { agent.setModel(want); shownPick = want; announceModelIfChanged(); } } catch { /* the saved pick stays */ } }
  syncProjectInstructions();
  chatPageRt.broadcast('chat:sync', { view: chatView() }, event.sender); // (the other views now know the chat's project)
  return chatView();
});
// [project folders] The folder picker of the project editor ("Use an existing folder…").
ipcMain.handle('chats:project-pick-folder', (event) => pickFolder(event, 'Choose a folder for this project', documentsDir()));
// A project's folder: open it, Locate… (a folder missing, or moved), Recreate (make it again where it was), rename it to the project's name
// (only a folder Lumen made, and only when nothing is in the way), choose its working folder, and "Write all now". Always { ok, ... }.
ipcMain.handle('chats:project-folder', async (event, id, action, arg) => {
  const p = projectById(String(id));
  if (!p) return { ok: false, reason: 'unknown' };
  const normal = (s) => (process.platform === 'win32' ? String(s).toLowerCase() : String(s));
  try {
    switch (action) {
      case 'open': { if (!p.folder) return { ok: false, reason: 'none' }; return { ok: !(await shell.openPath(p.folder)) }; }
      case 'locate': {
        const dir = await pickFolder(event, 'Locate the project folder', p.folder ? path.dirname(p.folder) : documentsDir());
        if (!dir) return { ok: false, reason: 'canceled' };
        const chk = await projectFolders.checkWorkFolder(dir, { confirmed: arg === true });
        if (!chk.ok) return { ok: false, reason: chk.reason, path: dir };
        mirror().forgetFolder(p.folder || '');
        const out = chats().saveProject({ id: p.id, name: p.name, folder: chk.real, folderCreated: false });
        folderState.delete(p.id); syncProjectInstructions(); pushAttention();
        return { ok: Boolean(out), project: out && withFolderState(out) };
      }
      case 'recreate': {
        if (!p.folder || !path.isAbsolute(p.folder)) return { ok: false, reason: 'none' };
        await fs.promises.mkdir(p.folder, { recursive: true });
        folderState.set(p.id, { folder: p.folder, ok: true }); pushAttention();
        return { ok: true };
      }
      case 'rename': {
        if (!p.folder || !p.folderCreated) return { ok: false, reason: 'not-lumen' };
        const want = projectFolders.safeFolderName(p.name);
        if (normal(path.basename(p.folder)) === normal(want)) return { ok: false, reason: 'same' };
        const target = path.join(path.dirname(p.folder), want);
        if (await fs.promises.lstat(target).then(() => true, () => false)) return { ok: false, reason: 'exists' };
        mirrorDebounce.flush().catch(() => {});
        await mirrorChain; // (what is being written there lands first)
        try { await fs.promises.rename(p.folder, target); } catch { return { ok: false, reason: 'busy' }; }
        mirror().forgetFolder(p.folder);
        const old = p.folder;
        const rel = p.workFolder ? path.relative(old, p.workFolder) : null;
        const out = chats().saveProject({ id: p.id, name: p.name, folder: target, folderCreated: true, ...(rel !== null && !rel.startsWith('..') && !path.isAbsolute(rel) ? { workFolder: path.join(target, rel) } : {}) });
        folderState.delete(p.id); syncProjectInstructions(); pushAttention();
        return { ok: Boolean(out), folder: target, project: out && withFolderState(out) };
      }
      case 'work': {
        const dir = await pickFolder(event, 'Choose where the AI works in this project', p.workFolder || p.folder || documentsDir());
        if (!dir) return { ok: false, reason: 'canceled' };
        const chk = await projectFolders.checkWorkFolder(dir, { confirmed: arg === true });
        if (!chk.ok) return { ok: false, reason: chk.reason, path: dir };
        const out = chats().saveProject({ id: p.id, name: p.name, workFolder: chk.real });
        syncProjectInstructions(); pushAttention();
        return { ok: Boolean(out), project: out && withFolderState(out) };
      }
      case 'work-clear': {
        const out = chats().saveProject({ id: p.id, name: p.name, workFolder: '' });
        syncProjectInstructions(); pushAttention();
        return { ok: Boolean(out), project: out && withFolderState(out) };
      }
      case 'write-all': {
        if (!p.folder) return { ok: false, reason: 'none' };
        const ids = chats().list().filter((c) => c.project === p.id && !c.missing).map((c) => c.id);
        const count = await serial(() => mirror().writeAll(ids, { force: true }));
        return { ok: true, count, total: ids.length };
      }
      default: return { ok: false, reason: 'unknown' };
    }
  } catch (err) { return { ok: false, reason: 'error', message: String(err?.message || err).slice(0, 200) }; }
});
// ---------- [project workspace] files, pinned pages, memory and settings of a project (ai/project-context.js, features/project-files.js)
let projectFilesStore = null;
function projectFiles() {
  if (projectFilesStore) return projectFilesStore;
  projectFilesStore = require('./features/project-files').createProjectFilesStore({
    dir: path.join(app.getPath('userData'), 'project-files'),
    encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
    decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
    available: () => safeStorage.isEncryptionAvailable(),
  });
  // Folders of projects that are gone (Lumen quit inside a delete's Undo time) are removed, a while after the first use.
  // (Not when the project list may be incomplete: an unreadable or rebuilt chat index would otherwise cost every project its files.)
  setTimeout(() => { try { if (chats().trusted()) projectFilesStore.purgeOrphans(new Set([...chats().projects().map((p) => p.id), ...pendingProjectDeletes.keys()])).catch(() => {}); } catch { /* next time */ } }, 8000).unref?.();
  return projectFilesStore;
}
const projectLimits = () => { const f = require('./features/project-files'); return { files: f.MAX_FILES, images: f.MAX_IMAGES, fileChars: f.MAX_TEXT_CHARS, totalChars: f.MAX_TOTAL_CHARS, instructions: 4000, index: require('./ai/project-context').INDEX_CHARS, kinds: f.SUPPORTED_TEXT }; };
const projectChanged = () => { syncProjectInstructions(); pushAttention(); syncTouch('chats'); };
// Everything the project page shows about one project.
ipcMain.handle('chats:project-get', async (_e, id) => {
  const p = projectById(String(id));
  if (!p) return null;
  const store = projectFiles();
  let memoryEntries = [];
  try { memoryEntries = memory().list().filter((e) => e.project === p.id).sort((a, b) => b.updated - a.updated); } catch { /* memory unreadable */ }
  return { project: withFolderState(p), files: store.list(p.id), totals: store.totals(p.id), memory: memoryEntries, memoryOn: memoryOn(), limits: projectLimits(), keychain: safeStorage.isEncryptionAvailable() };
});
// Files chosen in the page (its file picker or a drop): [{ name, bytes }]. Each is read with Lumen's own readers (PDF, Word, PowerPoint, email,
// text, pictures) and kept as text in the profile. Answers { results: [{ ok, name, file | error }], files }.
ipcMain.handle('chats:project-files-add', async (_e, id, list) => {
  const p = projectById(String(id));
  if (!p || !Array.isArray(list)) return null;
  const store = projectFiles();
  const results = [];
  let total = 0;
  for (const item of list.slice(0, 20)) {
    const bytes = item?.bytes ? Buffer.from(item.bytes) : null;
    total += bytes ? bytes.length : 0;
    if (!bytes || total > 200 * 1024 * 1024) { results.push({ ok: false, name: String(item?.name || 'file').slice(0, 120), error: 'This file could not be read.' }); continue; }
    results.push(await store.add(p.id, { name: String(item.name || 'file'), bytes }));
    await new Promise((resolve) => setImmediate(resolve)); // (a PDF is read on this thread: the window gets a turn between files)
  }
  projectChanged();
  return { results, files: store.list(p.id), totals: store.totals(p.id) };
});
ipcMain.handle('chats:project-file-remove', async (_e, id, fileId) => {
  const p = projectById(String(id));
  if (!p) return null;
  try { await projectFiles().remove(p.id, String(fileId)); } catch { return null; }
  projectChanged();
  return { files: projectFiles().list(p.id), totals: projectFiles().totals(p.id) };
});
// Search inside one project: its files' text (and its pinned pages' titles). The chats are searched by chats:search.
ipcMain.handle('chats:project-search', async (_e, id, query) => {
  const p = projectById(String(id));
  const q = String(query ?? '').trim().slice(0, 200);
  if (!p || !q) return [];
  const ctx = require('./ai/project-context');
  return ctx.search(await projectFiles().texts(p.id), q, { max: 12 });
});
// A pinned page: { add: { url, title } } or { remove: url }. http and https addresses only. Answers the project, or null.
ipcMain.handle('chats:project-link', (_e, id, change) => {
  const p = projectById(String(id));
  if (!p || !change || typeof change !== 'object') return null;
  let links = (p.links || []).map((l) => ({ ...l }));
  if (change.remove) links = links.filter((l) => l.url !== String(change.remove));
  else if (change.add) {
    if (links.length >= 25) return { error: 'full' };
    links.push({ url: String(change.add.url || '').slice(0, 2000), title: String(change.add.title || '').slice(0, 200) });
  }
  const out = chats().saveProject({ id: p.id, name: p.name, links });
  if (out && change.add && !out.links?.some((l) => l.url.startsWith(String(change.add.url).split('#')[0]))) return { error: 'invalid' };
  if (out) projectChanged();
  return out && withFolderState(out);
});
// "Add this tab to the project": from the chat's + menu (the open chat's project, else the one named) and from a tab's menu. The tab is the one the sender
// looks at (the chat page: the tab it works with). Answers { ok, project, title } or { ok: false, reason }.
function addTabToProject(tab, projectId) {
  const p = projectById(String(projectId || ''));
  if (!p) return { ok: false, reason: 'no-project' };
  const url = tab ? tabUrl(tab) : '';
  if (!isWebUrl(url) || tab.isolated) return { ok: false, reason: 'not-web' };
  const title = (alive(tab) ? tab.view.webContents.getTitle() : tab.sleepTitle || '') || '';
  if ((p.links || []).some((l) => l.url === String(new URL(url).href.replace(/#.*$/, '')))) return { ok: true, project: p, title, already: true };
  if ((p.links || []).length >= 25) return { ok: false, reason: 'full' };
  const out = chats().saveProject({ id: p.id, name: p.name, links: [...(p.links || []), { url, title }] });
  if (!out) return { ok: false, reason: 'failed' };
  projectChanged();
  return { ok: true, project: out, title };
}
ipcMain.handle('chats:project-add-tab', (event, projectId) => {
  const tab = tabs.find((t) => t.id === (chatPageRt.isChatSender(event) ? chatPageRt.pick() : activeId));
  return addTabToProject(tab, projectId || projectIdOf(chatId));
});
// A project's own memory (Settings → AI and agents → Memory lists everything; this is the project's part).
ipcMain.handle('chats:project-memory-forget', (_e, id, entryId) => {
  try { const e = memory().list().find((x) => x.id === String(entryId) && x.project === String(id)); if (!e) return false; memory().forget(e.id); memoryEdited(); return true; } catch { return false; }
});
// A project's settings (its defaults): the model a new chat starts with, plan first, and the user's connectors and MCP tools in its chats.
ipcMain.handle('chats:project-defaults', (_e, id, defaults) => {
  const p = projectById(String(id));
  if (!p) return null;
  const d = defaults && typeof defaults === 'object' ? defaults : {};
  const out = chats().saveProject({ id: p.id, name: p.name, defaults: { model: String(d.model || '').slice(0, 120), plan: d.plan === true, connectors: d.connectors !== false, mcp: d.mcp !== false } });
  if (out) projectChanged();
  return out && withFolderState(out);
});
// Tab menu → Add to project: one entry per project (the 20 most recent).
const projectMenuItems = (tab) => {
  try {
    const list = chats().projects().slice().sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0)).slice(0, 20);
    if (!list.length) return [];
    const url = tabUrl(tab);
    return [{ label: t('menu.addToProject'), enabled: isWebUrl(url) && !tab.isolated, submenu: list.map((p) => ({ label: menuLabel(p.name, 60), click: () => { const r = addTabToProject(tab, p.id); toast(r.ok ? t(r.already ? 'menu.projectAlready' : 'menu.projectAdded', { name: menuLabel(p.name, 40) }) : t('menu.projectAddFailed')); } })) }];
  } catch { return []; }
};
if (TEST) global.__projectWorkspace = { info: (id) => { const t = allTabsEverywhere().find((x) => x.id === id); return t ? { url: tabUrl(t), alive: alive(t), iso: !!t.isolated } : null; }, files: () => projectFiles(), blockFor: (id) => projectBlockFor(id), settingsFor: (id) => projectSettingsFor(id), addTab: (tabId, pid) => addTabToProject(allTabsEverywhere().find((x) => x.id === tabId), pid), menuItems: (tabId) => projectMenuItems(allTabsEverywhere().find((x) => x.id === tabId)).map((i) => ({ label: i.label, enabled: i.enabled !== false, items: (i.submenu || []).map((s) => s.label) })), pendingDeletes: () => [...pendingProjectDeletes.keys()], memoryEntries: () => memory().list(), tools: (id) => (agent.messages.settings?.projectTools === true), chatSettings: () => ({ projectId: agent.messages.settings?.projectId || null, projectTools: agent.messages.settings?.projectTools === true }) };
// [work folder] The open chat's own working folder (chats outside a project, or a project chat that works elsewhere): get / pick / set / clear / open.
// Answers { ok, info: { path, shown, source, missing } | null }. A drive root or the home folder needs `confirmed` (reason 'root' | 'home').
ipcMain.handle('chats:work-folder', async (event, action, arg, confirmed) => {
  const id = chatId;
  const answer = async (extra = {}) => {
    const info = workFolderInfo();
    if (info) info.missing = !(await fs.promises.stat(info.path).then((s) => s.isDirectory(), () => false));
    return { ok: true, info, ...extra };
  };
  const settle = async (dir) => {
    const chk = await projectFolders.checkWorkFolder(dir, { confirmed: confirmed === true });
    if (!chk.ok) return { ok: false, reason: chk.reason, path: dir, info: workFolderInfo() };
    if (id !== chatId) return { ok: false, reason: 'chat-changed' };
    agent.setWorkFolder(chk.real, effectiveModel() || DEFAULT_MODEL);
    if (agent.messages.length) saveChatSoon(chatGeneration);
    return answer();
  };
  try {
    switch (action) {
      case 'pick': { const dir = await pickFolder(event, 'Choose a folder for the AI to work in', workFolderInfo()?.path); return dir ? settle(dir) : { ok: false, reason: 'canceled' }; }
      case 'set': return settle(String(arg || ''));
      case 'clear': agent.setWorkFolder('', effectiveModel() || DEFAULT_MODEL); if (agent.messages.length) saveChatSoon(chatGeneration); return answer();
      case 'open': { const info = workFolderInfo(); return { ok: Boolean(info) && !(await shell.openPath(info.path)) }; }
      default: return answer();
    }
  } catch (err) { return { ok: false, reason: 'error', message: String(err?.message || err).slice(0, 200) }; }
});
ipcMain.handle('chats:rename', (_e, id, title) => { const ok = chats().rename(String(id), String(title ?? '')); if (ok) mirrorChatSoon(String(id)); return ok; }); // ([project folders] the Markdown file follows the title)
// Deleting the open chat leaves an empty one in its place. A saved chat is only hidden for UNDO_MS (the Undo toast); then it is
// erased with its pictures, uploads and engine homes. If Lumen quits inside that time the chat stays hidden and is erased
// on the next start (or by the store after a day), after the index on disk is read again; no delete ever runs before the app is ready.
const UNDO_MS = 8000;
const pendingDeletes = new Map(); // chat id -> timer
function finishDelete(id) {
  clearTimeout(pendingDeletes.get(id));
  pendingDeletes.delete(id);
  const waiting = chats().trashed().some((t) => t.id === id);
  if (!waiting) return; // undone meanwhile
  const folder = deletedFrom.get(id) || chats().projectOf(id)?.folder || ''; // [project folders] where its Markdown file is
  deletedFrom.delete(id);
  if (!chats().remove(id)) return; // (the index can't be read right now: it stays hidden and is tried again later)
  imageStore().removeChat(id); // its pictures go with it
  uploads().removeChat(id); // [uploads] and the files attached to it
  if (folder) serial(() => mirror().trash(folder, id)).catch(() => {}); // [project folders] its Markdown file moves to Chats/Deleted (never erased)
  require('./ai/antigravity').removeChatHome(app.getPath('userData'), id).catch(() => {}); // its Antigravity home (conversation) goes too
  require('./ai/codex').removeChatHome(app.getPath('userData'), id).catch(() => {}); // and its Codex home (thread)
}
let trashSwept = false;
function sweepTrash() { // chats hidden by a Lumen that quit inside the undo time
  if (trashSwept || !app.isReady()) return;
  trashSwept = true;
  for (const t of chats().trashed()) if (!pendingDeletes.has(t.id) && Date.now() - t.at > UNDO_MS) finishDelete(t.id);
}
ipcMain.handle('chats:delete', (event, id) => {
  id = String(id);
  warmChatLeft(id, { now: true }); // [warm per chat] (a message still running frees it when it ends)
  grokChatLeft(id, { now: true }); // [keep connected] (read before the chat is removed)
  approvedByChat.delete(id);
  unreadChats.delete(id);
  const running = chatRuns.get(id); // deleting a chat that is still running stops it, and it isn't saved again
  if (running) {
    running.deleted = true;
    if (running.queued) { running.cancelQueued?.(); chatRuns.delete(id); } else agent.stopFor(running.messages);
    clearTimeout(detachedSaves.get(id));
  }
  chatBind.unbindChat(id); // [chat per tab]
  const projectFolder = chats().projectOf(id)?.folder || ''; // [project folders]
  mirrorDebounce.cancel(id);
  const undoable = chats().trash(id); // false: nothing saved to bring back (a first reply still coming)
  if (undoable && projectFolder) deletedFrom.set(id, projectFolder);
  if (undoable) { clearTimeout(pendingDeletes.get(id)); const t = setTimeout(() => finishDelete(id), UNDO_MS); t.unref?.(); pendingDeletes.set(id, t); }
  const eraseNow = () => {
    if (undoable) return;
    chats().remove(id);
    imageStore().removeChat(id);
    uploads().removeChat(id);
    require('./ai/antigravity').removeChatHome(app.getPath('userData'), id).catch(() => {});
    require('./ai/codex').removeChatHome(app.getPath('userData'), id).catch(() => {});
  };
  if (id === chatId) {
    chatGeneration++;
    clearTimeout(saveChatTimer);
    agent.reset();
    chatId = chats().newId();
    chatBind.bind(pageTabOf(event.sender)?.id ?? activeId, chatId);
    eraseNow();
    announceModelIfChanged();
    pushAttention(); // the Chats button, the list and the tab marks drop what this chat had (an unread mark, a binding)
    chatPageRt.broadcast('chat:sync', { view: chatView() }, event.sender);
    return { cleared: true, view: chatView(), undo: undoable, undoMs: UNDO_MS };
  }
  eraseNow();
  pushAttention();
  return { cleared: false, removed: undoable || !chats().has(id), undo: undoable, undoMs: UNDO_MS };
});
ipcMain.handle('chats:undo-delete', (_e, id) => {
  id = String(id);
  if (!pendingDeletes.has(id)) return false; // the time is up (or it was never hidden)
  const ok = chats().restore(id);
  if (ok) { clearTimeout(pendingDeletes.get(id)); pendingDeletes.delete(id); deletedFrom.delete(id); mirrorChatSoon(id); pushAttention(); }
  return ok;
});
ipcMain.handle('chats:pin', (_e, id, on) => { const ok = chats().setPinned(String(id), Boolean(on)); if (ok) pushAttention(); return ok; });
ipcMain.handle('chats:archive', (_e, id, on) => { const ok = chats().setArchived(String(id), Boolean(on)); if (ok) pushAttention(); return ok; });
// Chats whose title or messages contain the words typed: [{ id, snippet }] (the list shows them in its own order).
ipcMain.handle('chats:search', (_e, query) => chats().search(String(query ?? '').slice(0, 200)));

// ---- [memory] Saved memory across chats (ai/memory.js; docs/memory.md). Off by default (aiMemory). One encrypted file in the profile;
// with no keychain nothing is kept. The chat's "Remembered: …" row (Undo / Forget), the /memory command and Settings → AI and agents → Memory.
let memoryStore = null;
function memory() {
  return (memoryStore ||= require('./ai/memory').createMemoryStore({
    file: path.join(app.getPath('userData'), 'memory.json'),
    encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
    decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
    available: () => safeStorage.isEncryptionAvailable(),
  }));
}
function memoryOn() { return readSettings().aiMemory === true; }
// The chat id a run's messages array belongs to (the open chat, or one running in the background). null: none (a background task).
function chatIdOfMessages(messages) {
  if (!messages) return null;
  if (messages === agent.messages) return chatId;
  for (const [id, run] of chatRuns) if (run.messages === messages) return id;
  return null;
}
// search_chats: saved chats (never temporary ones: they are not saved) whose title or text has every word; the running chat left out.
function memorySearchChats(query, exclude) {
  const titles = new Map(chats().list().map((c) => [c.id, c]));
  return chats().search(query, { max: 6 }).filter((h) => h.id !== exclude).slice(0, 5).map((h) => {
    const c = titles.get(h.id);
    return { id: h.id, title: c?.title || '', date: c?.updated ? new Date(c.updated).toISOString().slice(0, 10) : '', snippet: h.snippet };
  });
}
require('./ai/agent').setMemorySource({ on: memoryOn, text: (project) => memory().block({ project: project || null }) }); // ([project workspace] a project's chats also see what was saved for it)
const memoryView = () => ({ on: memoryOn(), chatSearch: readSettings().aiMemoryChatSearch !== false, readOnly: memory().readOnly, entries: memory().list().sort((a, b) => b.updated - a.updated).map((e) => (e.project ? { ...e, projectName: projectById(e.project)?.name || '' } : e)) });
const memoryEdited = () => require('./ai/agent').memoryEdited(); // the user changed it: open chats' prompts follow at their next request
// The chat's row and /memory (the sidebar and the chat page).
ipcMain.handle('memory:list', () => memoryView());
ipcMain.handle('memory:undo', (_e, token) => { const ok = memory().undo(String(token ?? '').slice(0, 20)); if (ok) memoryEdited(); return ok; });
ipcMain.handle('memory:forget', (_e, id) => { try { memory().forget(String(id ?? '').slice(0, 20)); memoryEdited(); return true; } catch { return false; } });
// Settings → AI and agents → Memory.
ipcMain.handle('settings:memory-list', () => memoryView());
ipcMain.handle('settings:memory-update', (_e, id, text) => { memory().update(String(id ?? '').slice(0, 20), { text: String(text ?? '') }); memoryEdited(); return memoryView(); });
ipcMain.handle('settings:memory-delete', (_e, id) => { memory().forget(String(id ?? '').slice(0, 20)); memoryEdited(); return memoryView(); });
ipcMain.handle('settings:memory-delete-all', () => { memory().clear(); memoryEdited(); return memoryView(); });
ipcMain.handle('settings:memory-start-over', () => { memory().reset({ discard: true }); memoryEdited(); return memoryView(); }); // the file can't be read: set aside as memory.json.bad, start empty
// ---- [sync] Sync through a folder (features/sync-folder.js; docs/sync.md). Settings → General → Sync. Off by default; the module is loaded
// only when the setting is on (after the window is up) or when the person turns it on. The passphrase is kept on this computer only,
// encrypted with the keychain; the folder gets only files encrypted with a key made from it.
function syncService() {
  if (syncSvc) return syncSvc;
  const lib = require('./features/sync-folder');
  const P = lib.providers;
  const pushSettingsPages = () => { for (const t of tabs.filter((x) => x.settings && alive(x))) t.view.webContents.send('settings:sync-changed'); };
  syncSvc = lib.createSyncService({
    userData: app.getPath('userData'),
    readSettings, writeSettings,
    cipher: { available: () => safeStorage.isEncryptionAvailable(), encrypt: (text) => safeStorage.encryptString(text), decrypt: (buf) => safeStorage.decryptString(buf) },
    appVersion: app.getVersion(),
    deviceName: TEST ? 'This computer' : undefined,
    timing: TEST && process.env.LUMEN_SYNC_TEST_MS ? { local: 200, history: 400, watch: 200, poll: 300, first: 100, periodic: 60000 } : undefined,
    makeProvider: (kind) => ({
      bookmarks: () => P.bookmarks({ read: () => readSettings().bookmarks, write: (list) => writeSettings({ ...readSettings(), bookmarks: list }) }),
      settings: () => P.settings({ read: readSettings, set: (k, v) => settingsBackend.set(k, v), writeDirect: (patch) => writeSettings({ ...readSettings(), ...patch }) }),
      widgets: () => P.widgets({ read: readSettings, write: (patch) => writeSettings({ ...readSettings(), ...patch }), refresh: () => { try { refreshNewTabs(); } catch { /* not set up yet */ } } }),
      history: () => P.history({ map: () => history, ready: async () => { await historyReady; return historyLoaded; }, save: saveHistorySoon, bump: () => { historyVersion++; }, isWorthImporting: (u) => importer.isWorthImporting(u) }),
      chats: () => P.chats({ store: chats(), busy: (id) => id === chatId || chatRuns.has(id) }),
      projects: () => P.projects({ store: chats(), removed: (id) => { projectFiles().removeProject(id).catch(() => {}); } }), // [project workspace] the text and settings of projects
      'project-files': () => P.projectFiles({ store: projectFiles(), projectIds: () => chats().projects().map((p) => p.id) }), // their files' text, up to a size
      passwords: () => P.passwords({ vault: passwords().vault, unavailable: () => passwords().unavailable() || (readSettings().savePasswords === true ? null : 'off') }),
    }[kind]?.()),
    onApplied: (kinds) => {
      try {
        if (kinds.includes('bookmarks')) { sendTabs(); managers.pushBookmarks(); }
        if (kinds.includes('history')) historyVersion++;
        if (kinds.includes('chats')) { pushAttention(); syncProjectInstructions(); } // ([project workspace] a project's text or files came in)
        if (kinds.includes('settings')) { settingsBackend.pushUiPrefs(); refreshNewTabs(); }
        if (kinds.includes('widgets')) { refreshNewTabs(); for (const t of tabs.filter((x) => x.settings && alive(x))) t.view.webContents.send('widgets:changed'); }
      } catch { /* a window is closing */ }
    },
    onStatus: pushSettingsPages,
  });
  if (TEST) global.__sync = syncSvc;
  return syncSvc;
}
const syncOffState = () => ({ on: false, running: false, path: '', folderName: '', kinds: { bookmarks: true, history: true, chats: true, widgets: true, settings: true }, passwords: false, keychain: safeStorage.isEncryptionAvailable(), hasPassphrase: false, lastSynced: 0, error: null, devices: [], deviceName: require('os').hostname(), damaged: 0, newer: 0, skipped: [], problems: 0 });
const syncState = () => ({ ...(readSettings().syncFolder?.on ? syncService().status() : syncOffState()), passwordsOn: readSettings().savePasswords === true });
const syncFail = (err) => ({ ok: false, code: String(err?.code || 'error').slice(0, 40), message: String(err?.message || err).slice(0, 300) });
ipcMain.handle('settings:sync-state', () => syncState());
ipcMain.handle('settings:sync-pick', async () => {
  if (TEST && global.__syncPick !== undefined) return global.__syncPick;
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: t('settings.sync.pickTitle'), properties: ['openDirectory', 'createDirectory'] });
  return canceled || !filePaths[0] ? null : filePaths[0];
});
ipcMain.handle('settings:sync-enable', async (_e, opts) => {
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (o.passwords === true && readSettings().savePasswords !== true) return { ok: false, code: 'passwords-off', message: 'Saved passwords are off on this computer' };
    const r = await syncService().enable({ folder: String(o.folder ?? '').slice(0, 1000), passphrase: String(o.passphrase ?? '').slice(0, 1024), kinds: o.kinds && typeof o.kinds === 'object' ? o.kinds : undefined, passwords: o.passwords === true });
    return { ok: true, created: r.created, state: syncState() };
  } catch (err) { return syncFail(err); }
});
ipcMain.handle('settings:sync-set', async (_e, opts) => {
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (o.passwords === true && readSettings().savePasswords !== true) return { ok: false, code: 'passwords-off', message: 'Saved passwords are off on this computer' };
    await syncService().configure({ kinds: o.kinds && typeof o.kinds === 'object' ? o.kinds : undefined, passwords: typeof o.passwords === 'boolean' ? o.passwords : undefined });
    return { ok: true, state: syncState() };
  } catch (err) { return syncFail(err); }
});
ipcMain.handle('settings:sync-now', async () => { try { await syncService().syncNow(); return { ok: true, state: syncState() }; } catch (err) { return syncFail(err); } });
ipcMain.handle('settings:sync-off', async () => { try { await syncService().disable(); return { ok: true, state: syncState() }; } catch (err) { return syncFail(err); } });

// The chat as Markdown (the open one as it is now, or a saved one), or null if it's empty.
// `folder`: the name of the folder next to the file that holds its pictures (see chats:export); null: they are only named.
function chatMarkdown(id, folder = null) {
  const snapshot = id === chatId ? chatSnapshot() : chats().load(id);
  if (!snapshot?.messages?.length) return null;
  const entry = chats().list().find((c) => c.id === id);
  const title = entry?.title || autoTitle(snapshot);
  const pictures = [];
  const pictureFile = folder ? (p) => {
    const found = imageStore().read(p.id);
    if (!found) return null;
    const name = `picture-${pictures.length + 1}.${found.mime === 'image/jpeg' ? 'jpg' : found.mime.slice(6)}`;
    pictures.push({ name, buffer: found.buffer });
    return `${encodeURIComponent(folder)}/${name}`;
  } : null;
  const markdown = toMarkdown({ title, created: entry?.created, model: snapshot.settings?.model, usageLine: describeUsage(snapshot.settings?.usage) }, transcriptFor(snapshot.messages, snapshot.settings), { pictureFile });
  return { id, title, markdown, pictures, created: entry?.created, updated: entry?.updated, model: snapshot.settings?.model || null };
}
// Export: always the user's own click in the sidebar (a UI-only channel), and always through a
// save dialog, so nothing is written anywhere the user didn't pick.
// "Copy as Markdown" (the chat page's menu): the text goes to the page, which puts it on the clipboard.
ipcMain.handle('chats:markdown', (_e, id) => {
  const out = chatMarkdown(String(id));
  return out ? { ok: true, markdown: out.markdown } : { ok: false, reason: 'empty' };
});
// The chat as a PDF: its Markdown drawn by the same renderer the chat uses, in a window nobody sees (no scripts, no network), then printed.
async function chatPdf(out) {
  const body = require('./renderer/markdown.js').render(out.markdown);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const css = 'body{font:11pt/1.5 system-ui,Segoe UI,sans-serif;color:#111;margin:0}h1{font-size:20pt}h2{font-size:12pt;margin:1.4em 0 .3em;color:#555;text-transform:uppercase;letter-spacing:.04em}pre{background:#f4f4f4;padding:8px;border-radius:6px;white-space:pre-wrap;word-break:break-word}code{font-family:Consolas,monospace;font-size:10pt}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:3px 8px}blockquote{margin:0;padding-left:12px;border-left:3px solid #ccc;color:#555}';
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${esc(out.title)}</title><style>${css}</style><body>${body}</body>`;
  const view = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } });
  try {
    await view.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return await view.webContents.printToPDF({ printBackground: true });
  } finally { view.destroy(); }
}
ipcMain.handle('chats:export', async (_e, id, format) => {
  const pdf = format === 'pdf';
  const out = chatMarkdown(String(id));
  if (!out) return { ok: false, reason: 'empty' };
  const fileName = `${cleanTitle(out.title).replace(/[\\/:*?"<>|]/g, '').slice(0, 60).trim() || 'Chat'}.${pdf ? 'pdf' : 'md'}`;
  const { canceled, filePath } = await electronDialog.showSaveDialog(win, {
    title: t('dialog.exportChat.title'),
    defaultPath: path.join(app.getPath('documents'), fileName),
    filters: [pdf ? { name: 'PDF', extensions: ['pdf'] } : { name: 'Markdown', extensions: ['md'] }],
  });
  if (canceled || !filePath) return { ok: false, reason: 'canceled' };
  if (pdf) {
    await fs.promises.writeFile(filePath, await chatPdf(out));
    return { ok: true, filePath };
  }
  // Pictures the AI made go in a folder beside the file, named in it (the Markdown links them).
  const folder = `${path.basename(filePath, path.extname(filePath))} pictures`;
  const withPictures = chatMarkdown(String(id), folder) || out;
  await fs.promises.writeFile(filePath, withPictures.markdown, 'utf8');
  if (withPictures.pictures?.length) {
    const dir = path.join(path.dirname(filePath), folder);
    await fs.promises.mkdir(dir, { recursive: true });
    for (const picture of withPictures.pictures) await fs.promises.writeFile(path.join(dir, picture.name), picture.buffer);
  }
  return { ok: true, filePath };
});
if (TEST) global.__chatFiles = () => fs.readdirSync(path.join(app.getPath('userData'), 'chats')).length;
if (TEST) global.__chatPdf = (id) => { const out = chatMarkdown(String(id)); return out ? chatPdf(out) : null; };
if (TEST) global.__projectFolders = { setDocuments: (dir) => { documentsOverride = dir || null; }, documents: () => documentsDir(), idle: async () => { await mirrorDebounce.flush(); await mirrorChain; }, pending: () => mirrorDebounce.pending(), mirrorFolderOf, mirrorSoon: mirrorChatSoon, workFolderInfo };
if (TEST) global.__chats = { store: chats, id: () => chatId, markdown: (id) => chatMarkdown(id)?.markdown ?? null };

// ---------- pictures the AI made (features/gen-images.js) ----------
// Saved one file each under <userData>/generated-images/<chat>/, encrypted with the keychain like the chat itself (no
// keychain: kept in memory only, as chats are). They go when their chat is deleted; a folder whose chat is gone is pruned.
const genImages = require('./features/gen-images');
let imageStoreRef = null;
const imageStore = () => (imageStoreRef ||= genImages.createImageStore({
  dir: path.join(app.getPath('userData'), 'generated-images'),
  encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
  decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  available: () => safeStorage.isEncryptionAvailable(),
}));
Object.defineProperty(agent, 'imageStore', { get: imageStore, set() {}, configurable: true });
if (TEST) global.__imageStore = imageStore;

// ---------- files the AI uploads for the user (features/upload-files.js, docs/uploading-files.md) ----------
// Files attached in the composer wait in <userData>/uploads/pending until the message is sent (agent:ask moves them into the
// chat's folder); the model only ever names them by ref. A file the user did not attach is chosen with the OS picker, from the
// approval card's button (agent:upload-choose): the path comes from that dialog, never from the model or the page.
const uploadFilesLib = require('./features/upload-files');
let uploadStoreRef = null;
const uploads = () => (uploadStoreRef ||= uploadFilesLib.createUploadStore({ dir: path.join(app.getPath('userData'), 'uploads') }));
Object.defineProperty(agent, 'uploads', { get: uploads, set() {}, configurable: true });
if (TEST) global.__uploads = uploads;
ipcMain.handle('uploads:stash', (_e, file) => {
  try {
    const data = file?.data;
    const bytes = data instanceof ArrayBuffer ? Buffer.from(data) : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : null;
    if (!bytes) return { ok: false, error: 'No data.' };
    return { ok: true, ...uploads().stash({ name: String(file.name || ''), type: String(file.type || ''), data: bytes }) };
  } catch (err) { return { ok: false, error: String(err?.message || err) }; }
});
ipcMain.on('uploads:discard', (_e, ref) => { try { uploads().discard(String(ref)); } catch { /* gone */ } }); // the chip was removed before sending
ipcMain.handle('agent:upload-choose', async (event, approvalId) => {
  const id = Number(approvalId);
  const spec = agent.uploadSpec(id);
  if (!spec) return { ok: false, error: t('upload.choose.gone') };
  let paths;
  if (TEST && global.__uploadPick) paths = await global.__uploadPick(spec); // tests answer for the OS picker
  else {
    const parent = BrowserWindow.fromWebContents(event.sender) || win;
    const picked = await electronDialog.showOpenDialog(parent && !parent.isDestroyed() ? parent : undefined, {
      title: t('upload.choose.title', { host: spec.host }),
      properties: spec.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: uploadFilesLib.dialogFilters(spec.accept, t('upload.choose.all')),
    });
    paths = picked.canceled ? [] : picked.filePaths;
  }
  if (!paths?.length) return { ok: false, cancelled: true }; // closed the picker: the card stays for another try or Cancel
  return agent.pickUpload(id, paths);
});
setTimeout(() => {
  // Never when the chat list may be incomplete (empty, unreadable or rebuilt): that would delete every chat's pictures and uploads.
  const listTrusted = () => { try { return chats().trusted() && chats().list().length > 0; } catch { return false; } };
  if (listTrusted()) try { imageStore().prune(new Set([chatId, ...chats().list().map((c) => c.id), ...chatRuns.keys()].filter(Boolean))); } catch { /* nothing to prune */ }
  if (listTrusted()) try { uploads().sweep(new Set([chatId, ...chats().list().map((c) => c.id), ...chatRuns.keys()].filter(Boolean))); } catch { /* nothing to sweep */ } // [uploads] old pending files, files of chats that are gone
  // Antigravity homes of chats that are gone (pruned past the history limit, or cleared): antigravity.js chatHomeFor. (Never with an
  // empty list: a history that could not be read must not cost every chat its conversation.)
  try {
    if (listTrusted()) {
      const keep = new Set([chatId, ...chats().list().map((c) => c.id), ...chatRuns.keys(), ...chatBind.entries().map(([, c]) => c)].filter(Boolean));
      require('./ai/antigravity').pruneChatHomes(app.getPath('userData'), keep).catch(() => {});
      require('./ai/codex').pruneChatHomes(app.getPath('userData'), keep).catch(() => {}); // Codex homes (threads) likewise
    }
  } catch { /* nothing to prune */ }
}, 30000).unref?.();
// The picture as a data URL for the chat to draw (null: gone). Ids are checked against a strict pattern in the store.
ipcMain.handle('images:data', (_e, id) => imageStore().dataUrl(String(id)));
// Save image: always through a save dialog.
ipcMain.handle('images:save', async (_e, id) => {
  const found = imageStore().read(String(id));
  if (!found) return { ok: false, reason: 'gone' };
  const ext = found.mime === 'image/jpeg' ? 'jpg' : found.mime.slice(6);
  const { canceled, filePath } = await electronDialog.showSaveDialog(win, {
    title: t('dialog.saveImage.title'),
    defaultPath: path.join(app.getPath('pictures'), `lumen-picture.${ext}`),
    filters: [{ name: 'Image', extensions: [ext] }],
  });
  if (canceled || !filePath) return { ok: false, reason: 'canceled' };
  await fs.promises.writeFile(filePath, found.buffer);
  return { ok: true, filePath };
});
ipcMain.handle('images:copy', (_e, id) => {
  const found = imageStore().read(String(id));
  const image = found && require('electron').nativeImage.createFromBuffer(found.buffer);
  if (!image || image.isEmpty()) return false;
  copyImage(image);
  return true;
});
// "Open in a tab" in the chat's picture viewer (renderer/chat-image-viewer.js): a picture's data URL is too long to be a tab's address (Chromium
// refuses one over 2 MB), so it is written to a file in the temp folder and that opens. PNG, JPEG, GIF and WebP only; files a day old are cleared.
ipcMain.handle('images:open-tab', (_e, dataUrl) => {
  const m = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(dataUrl || ''));
  if (!m || m[2].length > 40e6) return false;
  try {
    const dir = path.join(require('os').tmpdir(), 'lumen-pictures');
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(dir)) { try { const old = path.join(dir, name); if (Date.now() - fs.statSync(old).mtimeMs > 86400000) fs.unlinkSync(old); } catch { /* in use or gone */ } }
    const buffer = Buffer.from(m[2], 'base64');
    const file = path.join(dir, `picture-${require('crypto').createHash('sha256').update(buffer).digest('hex').slice(0, 16)}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
    fs.writeFileSync(file, buffer);
    openTab(pathToFileURL(file).href);
    return true;
  } catch { return false; }
});
// A web picture in a reply ("![](https://…)") loads only when the user asks (a click): https, no cookies, no private
// addresses, a real image of a known type. It is then kept with the open chat like a made one.
ipcMain.handle('images:remote', async (_e, url) => {
  const got = await genImages.fetchRemoteImage(String(url || ''), { fetchImpl: (u, init) => net.fetch(u, init) });
  const ref = got && imageStore().save(chatId, got.buffer, { alt: '' });
  return ref ? { id: ref.id, mime: ref.mime } : null;
});
// ---------- files the AI made (features/ai-files.js, renderer/ai-files.js) ----------
// The chat only ever names a file by the id of a card main sent (aiFiles.shared): a path from a page or the renderer opens nothing.
// A trusted card (a file the AI wrote in this chat) may preview and open; any other file a reply named asks first (confirmed: true).
const aiFilesLib = require('./features/ai-files');
ipcMain.handle('aifiles:preview', (_e, id) => aiFilesLib.previewOf(aiFilesLib.shared.get(String(id))));
const aiFileAutoOpened = new Map(); // id -> when: the sidebar and the chat page both show a reply, and both ask to open its main file: one tab
ipcMain.handle('aifiles:open', async (event, id, how, opts) => {
  const entry = aiFilesLib.shared.get(String(id));
  try { if (!entry || !fs.statSync(entry.path).isFile()) return { ok: false, reason: 'gone' }; } catch { return { ok: false, reason: 'gone' }; }
  if (!['tab', 'background', 'system', 'reveal'].includes(how)) return { ok: false, reason: 'bad' };
  if (!entry.trusted && how !== 'reveal' && opts?.confirmed !== true) return { ok: false, reason: 'confirm' };
  if (TEST && global.__aiFileShell && (how === 'reveal' || how === 'system')) return global.__aiFileShell(how, entry.path); // tests do not start the OS's programs
  if (how === 'reveal') { shell.showItemInFolder(entry.path); return { ok: true }; }
  if (how === 'system') {
    if (!aiFilesLib.canOpenInSystem(entry.ext)) return { ok: false, reason: 'blocked' }; // a program or script: shown in its folder, never run from here
    return (await shell.openPath(entry.path)) ? { ok: false, reason: 'failed' } : { ok: true };
  }
  if (!aiFilesLib.canOpenInTab(entry.ext)) return { ok: false, reason: 'no-tab' };
  if (opts?.auto === true) {
    if (Date.now() - (aiFileAutoOpened.get(entry.path) || 0) < 30000) return { ok: true, tabId: null };
    aiFileAutoOpened.set(entry.path, Date.now());
    if (aiFileAutoOpened.size > 200) aiFileAutoOpened.delete(aiFileAutoOpened.keys().next().value);
  }
  const href = aiFilesLib.fileUrlOf(entry.path);
  const url = entry.kind === 'pdf' ? pdfViewer.viewerUrl(href) : emlViewer.shouldOpenInPlace({ url: href, filename: entry.path }) ? emlViewer.viewerUrl(href) : slidesViewer.shouldOpenInPlace({ url: href, filename: entry.path }) ? slidesViewer.viewerUrl(href) : href;
  const rec = recOfSender(event.sender);
  const tab = rec ? withWindow(rec, () => openTab(url, { background: how === 'background' })) : openTab(url, { background: how === 'background' });
  return { ok: true, tabId: tab?.id ?? null };
});
ipcMain.on('agent:approve', (_e, approvalId, ok) => agent.resolveApproval(approvalId, ok));
ipcMain.on('agent:send-undo', (_e, id) => agent.undoSend(Number(id))); // [connectors] "Undo" on a "Sending to … in 10 s" row
ipcMain.on('agent:send-stop', () => agent.stopSendGrant()); // [connectors] "Stop" on "Sending without asking in this chat"
// [ai controls] "Undo" under a reply: takes back what that run changed in the tabs.
ipcMain.handle('agent:undo', (_e, runId) => agent.undoRun(runId));
// [content guard] "Undo the AI's edits on this page": the editors and fields that run changed go back to how they started.
ipcMain.handle('agent:undo-edits', (_e, runId) => agent.undoEdits(runId));
// [annotate] "Show again" / "Clear" on a drawing step in the sidebar (ai/annotate.js).
ipcMain.handle('agent:annotate', (_e, action) => (action === 'show' || action === 'clear' ? agent.annotateAgain(action) : false));
// The PDF viewer's Print button (its page has no IPC but this one, from permissions-preload.js): the same preview as Ctrl+P.
// The email viewer's Save and Open buttons (its page has no IPC but these, from permissions-preload.js): the sender must be the viewer itself, and
// the attachment is found in the file the viewer's own address names. Nothing is run: Open takes a few safe types (a PDF, a picture, text, another
// email) to a new tab from a private temp copy.
const emlSenderFile = (e) => (e.senderFrame === e.sender.mainFrame ? emlViewer.emlUrlOf(e.senderFrame?.url) : null);
ipcMain.handle('eml:bytes', async (e, index) => {
  const file = emlSenderFile(e);
  const parsed = file && Number.isInteger(index) ? await emlViewer.load(file) : null;
  return parsed && parsed.parts && parsed.parts[index] ? Uint8Array.from(parsed.parts[index]) : null;
});
ipcMain.handle('eml:open', async (e, index) => {
  const file = emlSenderFile(e);
  if (!file || !Number.isInteger(index)) return false;
  const copy = await emlViewer.tempCopy(file, index, app.getPath('temp'));
  if (!copy) return false;
  const tab = tabByContents(e.sender);
  const href = pathToFileURL(copy).href;
  openTab(href, { openerId: tab?.id ?? null });
  return true;
});
ipcMain.on('pdf:print', (e) => { if (e.senderFrame === e.sender.mainFrame && pdfViewer.isViewerUrl(e.senderFrame?.url)) printTab(e.sender); });
ipcMain.on('pdf:fallback', (e, why) => { // the viewer could not open its PDF: Chrome's viewer shows it instead (features/pdf-viewer.js fallback)
  if (e.senderFrame !== e.sender.mainFrame || !pdfViewer.isViewerUrl(e.senderFrame?.url)) return;
  if (pdfRt.fallback(e.sender)) console.warn(`[pdf] Lumen's viewer could not open a PDF (${String(why || 'unknown').slice(0, 300)}); showing it in Chrome's viewer`);
});
aiSites.register(ipcMain);
// Auto-allow actions (the sidebar's switch): the sidebar's AI clicks and types on any site without
// the "Allow … to interact" card. Stored as askBeforeActing: false (see autoApprove above).
ipcMain.handle('agent:auto-allow', (_e, on) => {
  if (typeof on === 'boolean') {
    const was = permissionModes.modeOf(readSettings());
    if (!(on === false && was === 'bypass')) writeSettings({ ...readSettings(), ...permissionModes.patchOf(on ? 'auto' : 'ask') }); // (a card's "Allow on all sites" never lowers Bypass)
    try { settingsBackend.pushUiPrefs(); } catch { /* the UI isn't up yet */ }
  }
  return readSettings().askBeforeActing === false;
});
// [bypass permissions] The bolt menu in the sidebar head (and Settings → AI): 'ask' | 'auto' | 'bypass'. No argument: just read it.
// Both views follow through prefs:ui. Bypass answers every approval card allow (agent.js askApproval); see features/permission-mode.js.
ipcMain.handle('agent:permission-mode', (_e, mode) => {
  const patch = permissionModes.patchOf(mode);
  if (patch) {
    writeSettings({ ...readSettings(), ...patch });
    try { settingsBackend.pushUiPrefs(); } catch { /* the UI isn't up yet */ }
  }
  return permissionModes.modeOf(readSettings());
});

// [subagents] The sidebar's Helpers row (and Settings → AI): 'off' | 'auto' | 'on' (true / false still mean on / off). No argument: just read it. Same setting as Settings (aiSubagents); takes effect on the next message (agent.js helpersOffered).
ipcMain.handle('agent:helpers', (_e, mode) => {
  const next = mode === true ? 'on' : mode === false ? 'off' : ['off', 'auto', 'on'].includes(mode) ? mode : null;
  if (next) {
    writeSettings({ ...readSettings(), aiSubagents: next });
    try { settingsBackend.pushUiPrefs(); } catch { /* the UI isn't up yet */ }
  }
  // The sidebar reads this at startup, so it doesn't load ai/helpers-auto.js (perf-budget counts startup modules); same rule as its modeOf.
  const v = readSettings().aiSubagents;
  return v === true || v === 'on' ? 'on' : v === false || v === 'off' ? 'off' : 'auto';
});

// [prefer fractions] /fractions on|off in the chat: the Settings → AI switch (aiPreferFractions). No argument: just read it. New chats pick it up.
ipcMain.handle('agent:prefer-fractions', (_e, on) => {
  if (typeof on === 'boolean') {
    writeSettings({ ...readSettings(), aiPreferFractions: on });
    try { settingsBackend.pushUiPrefs(); } catch { /* the UI isn't up yet */ }
  }
  return readSettings().aiPreferFractions === true;
});

// [acting helpers] A helper card's Stop button: stops that helper only (agent.js stopHelper; Stop in the chat stops them all).
ipcMain.handle('agent:helper-stop', (_e, key) => agent.stopHelper(String(key ?? '')));

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
  // [auto model] Auto, picked: it stays the pick (settings.json keeps 'auto'); the model that answers is chosen per message.
  if (preferred === autoModel.AUTO && options.length) return autoModel.AUTO;
  // A provider's own Auto ('grokbuild:auto'): kept while any of that provider's models is listed (or its CLI is still being looked for).
  if (autoModel.isAuto(preferred) && (options.some((o) => aiFallback.providerOf(o.id) === autoModel.scopeOf(preferred)) || aiAgents.engineDetecting(preferred))) return preferred;
  // Any OpenRouter model counts once there is a key: "More models…" can pick ones not in the short list.
  const openRouterPick = /^openrouter:[\w.-]+\/[\w.:-]+$/.test(String(preferred)) && Boolean(providerKey('openrouter'));
  if (options.some((o) => o.id === preferred) || openRouterPick || aiAgents.engineDetecting(preferred)) return preferred;
  // [auto model] Nothing picked yet (a fresh install, or a profile that never chose): Auto, once there is more than one model to
  // choose from. A saved pick is never replaced: not by Auto, and when it is gone (its key was removed) it falls back as before.
  if ((preferred == null || preferred === '') && options.filter((o) => o.signedIn !== false && !(o.badges || []).includes('sign in')).length > 1) return autoModel.AUTO;
  // A pick its provider no longer lists while that provider is still connected (Gemini 2.5 Flash after Google limited the 2.5
  // models): the same provider's model of the same kind, not another provider's first (ai/fallback.js sameKindModel).
  const sameKind = preferred ? aiFallback.sameKindModel(preferred, options) : null;
  if (sameKind) return sameKind;
  // Nothing picked yet (or it's gone): the default model when it's connected, else the first one.
  return options.find((o) => o.id === DEFAULT_MODEL)?.id || options[0]?.id || null;
}

// The one answer to "which model is the user on right now": the pick (or what replaces one that is gone),
// and, while it cools down after a usage limit, the stand-in that is really answering. The sidebar, the chat
// page, Settings and the new-tab page's Ask AI box all show this.
// The sidebar and the chat page show the OPEN chat's model (each chat keeps its own; a pick made mid-reply is the
// next message's), so what the picker says is what the next message there uses. A new chat, and so the new-tab
// page's Ask AI, starts on the saved default (forChat: false).
// What the pickers show is one value (shownPick), set when the user does something: picks a model, opens a chat, starts one, or
// switches tab. A window's or page's background refresh (it brings the open chat to its own chat for a moment: syncToSender) must not
// change it, or two windows on different chats flipped what every picker showed, and what the next message used, back and forth.
let shownPick = null;
function ownPickOfOpenChat() {
  const s = agent.messages?.settings;
  let pick = s ? s.autoFrom || s.fallbackFrom || s.model : null;
  if (!pick) { try { pick = effectiveModel(undefined); } catch { pick = null; } } // (a chat with no message yet: the saved default)
  return pick || null;
}
function chatModelPick() {
  const s = agent.messages?.settings;
  return shownPick || agent.nextModel || (s ? s.autoFrom || s.fallbackFrom || s.model : null) || undefined; // (autoFrom: the chat's pick is Auto, whichever model answered last)
}
function shownModel(options = modelOptions(), { forChat = true } = {}) {
  const model = effectiveModel(forChat ? chatModelPick() : undefined);
  const standIn = fallbackOn() && !autoModel.isAuto(model) ? aiFallback.resolve({ preferred: model, options, cooldowns: aiFallback.shared }) : { from: null };
  return { pick: model, model: standIn.from ? standIn.model : model, standIn };
}
ipcMain.handle('settings:get', () => {
  const options = modelOptions();
  const { pick: model, standIn } = shownModel(options);
  return {
    hasStoredKey: Boolean(storedApiKey()),
    hasEnvKey: Boolean(process.env.ANTHROPIC_API_KEY),
    providerKeys: Object.fromEntries(Object.keys(providers.PROVIDERS).filter((p) => p !== 'local').map((p) => [p, {
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
    effort: agent.openEffort(), // the open chat's own reasoning effort ('' = Auto), see settings:set-effort
    fallback: standIn.from ? { from: aiFallback.nameOf(standIn.from, options), to: aiFallback.nameOf(standIn.model, options), until: standIn.until } : null,
    autoFallback: fallbackOn(),
    models: pickerOptions(options),
    autoProviders: autoProviderList(options), // Settings > AI: which providers Auto may use
    // For the empty sidebar's "get started" card: nothing to answer with unless some model is connected.
    ready: Boolean(model),
    claudeCode: options.some((o) => o.id === 'claudecode:default'),
    grokBuild: aiAgents.cliStatus().grokbuild, // { installed, signedIn, enabled }: the setup card offers it once found
    antigravity: aiAgents.cliStatus().antigravity, // same, for Antigravity (which replaces Gemini CLI)
    codex: aiAgents.cliStatus().codex, // same, for Codex (offered once found and signed in)
  };
});
ipcMain.handle('settings:use-grok-build', () => aiAgents.useGrokBuild());
ipcMain.handle('settings:use-antigravity', () => aiAgents.useAntigravity());
ipcMain.handle('settings:use-codex', () => aiAgents.useCodex());
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
// ---- [local AI] Settings → AI → Local. The address, the toggle and Detect. Only this computer's addresses unless the user confirms one.
const localState = () => {
  const lm = require('./ai/local-models');
  const c = lm.clean(readSettings().localAI);
  return { enabled: c.enabled, flavor: c.flavor, url: c.url, confirmedHost: c.confirmedHost, models: c.models, defaults: lm.DEFAULT_URLS, names: lm.LABELS };
};
// What the user entered -> { ok, cfg } (the address checked) or { ok: false, error, needsConfirm?, host? }.
function localCheck(input) {
  const lm = require('./ai/local-models');
  const cur = lm.clean(readSettings().localAI);
  const flavor = lm.FLAVORS.includes(input?.flavor) ? input.flavor : cur.flavor;
  const n = lm.normalizeUrl(flavor, input?.url);
  if (!n.ok) return { ok: false, error: n.error };
  let confirmedHost = '';
  if (!n.local) {
    if (cur.confirmedHost !== n.host && input?.confirmRemote !== true) return { ok: false, needsConfirm: true, host: n.host, error: n.host + ' isn’t on this computer. Messages and the page text you share would be sent there. Use it only if you run that server yourself.' };
    confirmedHost = n.host;
  }
  const same = cur.flavor === flavor && cur.url === n.url;
  return { ok: true, cfg: { ...cur, flavor, url: n.url, confirmedHost, models: same ? cur.models : [] } };
}
ipcMain.handle('settings:local-get', () => localState());
ipcMain.handle('settings:local-save', async (_e, input) => {
  const r = localCheck(input);
  if (!r.ok) return r;
  writeSettings({ ...readSettings(), localAI: { ...r.cfg, enabled: input?.enabled === true } });
  await refreshModels('local');
  return { ok: true, ...localState() };
});
ipcMain.handle('settings:local-detect', async (_e, input) => {
  const r = localCheck(input);
  if (!r.ok) return r;
  const found = await require('./ai/local-models').detect(r.cfg, { fetchImpl: require('./browser/net-fetch').netFetch() });
  if (!found.ok) return found;
  writeSettings({ ...readSettings(), localAI: { ...r.cfg, enabled: input?.enabled === true, models: found.models } });
  await refreshModels('local');
  return { ...found, ...localState() };
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
// One sign-in at a time; resolves { ok, message, cancelled?, allowlist? }. Used by Settings (spotify:sign-in) and by the Spotify card's Reconnect / Connect buttons (do=reconnect).
const spotifySignIn = (clientId) => new Promise((resolve) => {
  cancelSpotifySignIn?.();
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
      finish({ ok: false, allowlist: err.allowlist === true, message: err.allowlist === true ? err.message : t('spotify.failed', { error: err.message }) });
    }
  });
  // (Lumen's own Spotify app, in Spotify's development mode, only lets 25 listed accounts in: for anyone else Spotify's own page says so and never comes back here)
  const timer = setTimeout(() => finish(session.builtin ? { ok: false, allowlist: true, message: t('spotify.timeoutBuiltin') } : { ok: false, message: t('spotify.timeout') }), 5 * 60 * 1000);
  server.on('error', (err) => finish({ ok: false, message: t(err.code === 'EADDRINUSE' ? 'spotify.portBusy' : 'spotify.cantStart', { error: err.message, port: spotifyRedirectPort() }) }));
  server.listen(spotifyRedirectPort(), '127.0.0.1', () => { authTab = openTab(session.url).id; if (!done) unwatch = onTabGone(authTab, () => cancelSpotifySignIn?.()); });
});
ipcMain.handle('spotify:sign-in', (_event, clientId) => spotifySignIn(clientId));

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
    if (result.ok) { cliLoginValid = null; modelsChanged(); }
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
ipcMain.handle('settings:search-engines', () => ({ searchEngine: readSettings().searchEngine || DEFAULT_ENGINE, searchEngines: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, label: e.label, url: e.url })) })); // (the Search engine row of General: not the whole of settings:get, which also lists the models and looks for the AI command-line tools)
ipcMain.handle('import:browsers', () => importer.detectBrowsers());
ipcMain.handle('import:run', (_e, id) => runImport(id));
ipcMain.handle('settings:set-model', (_e, id) => {
  // Any OpenRouter model can be picked from "More models…" once there is a key.
  const pickedFromMore = /^openrouter:[\w.-]+\/[\w.:-]+$/.test(String(id)) && Boolean(providerKey('openrouter'));
  const validAuto = autoModel.isAuto(id) && (autoModel.scopeOf(id) === null ? modelOptions().length > 0 : modelOptions().some((o) => aiFallback.providerOf(o.id) === autoModel.scopeOf(id) && !o.more)); // (a provider's own Auto: that provider is connected)
  if (id === 'openrouter:__more' || (!pickedFromMore && !validAuto && !modelOptions().some((o) => o.id === id))) return false;
  const s = readSettings();
  // The last few OpenRouter models picked from its catalog stay in the short list, so switching between them is one click.
  const curatedPick = modelOptions().some((o) => o.id === id && !o.recent);
  const recentOpenRouter = pickedFromMore && !curatedPick ? [id.slice('openrouter:'.length), ...(s.recentOpenRouter || []).filter((m) => m !== id.slice('openrouter:'.length))].slice(0, 4) : s.recentOpenRouter;
  // [auto model] The provider the user was on before choosing Auto is the one Auto prefers when two would do.
  const autoHome = autoModel.isAuto(id) && s.model && !autoModel.isAuto(s.model) ? s.model : s.autoHome;
  writeSettings({ ...s, model: id, ...(autoHome ? { autoHome } : {}), ...(recentOpenRouter ? { recentOpenRouter } : {}) });
  shownPick = id; // (every picker shows it, and the next message, wherever it is sent from, uses it)
  aiFallback.shared.clear(id); // [model fallback] picking a model by hand (the original, after a switch) means try it now: no cooldown
  modelsChanged(); // every sidebar, chat page and Settings shows the new pick
  try { setTimeout(() => { try { agent.prewarm(''); } catch { /* not set up yet */ } }, 0); } catch { /* quitting */ } // (the new pick's process starts now, not at the first message)
  // Mid-reply the switch waits for the next message (agent.setModel); the sidebar says so.
  return agent.setModel(id) ? 'next-message' : true;
});
// The open chat's own reasoning effort (the model menu's Effort row; '' = Auto). It belongs to the chat and is saved with it.
ipcMain.handle('settings:set-effort', (_e, level) => {
  const next = require('./ai/effort').cleanChat(level);
  if (level && !next) return false;
  const waits = agent.setEffort(next, ownPickOfOpenChat() || undefined);
  modelsChanged(); // every sidebar and chat page showing this chat follows
  return waits ? 'next-message' : true;
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
ipcMain.handle('settings:set-key', async (_e, key) => {
  let unverified = false;
  if (key) { // same check as the other providers: a rejected key is not saved; offline saves it, noted as unchecked
    const check = await providers.checkKey('anthropic', String(key).trim());
    if (check.ok === false) throw new Error(check.message);
    unverified = check.ok === null;
  }
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
  modelsChanged();
  return unverified ? { ok: true, unverified: true } : true;
});

// ---------- AI agents over MCP and CDP, and the Claude Code engine (features/ai-agents.js) ----------

const aiAgents = setupAiAgents({
  app, ipcMain, agent, readSettings, writeSettings, ui, automationPlan, isWebUrl, openTab, closeTab, switchTab, isAiTab: (id) => manners.isAiTab(tabAnywhere(id)?.t), tabOff: (id) => manners.isKeptOff(tabAnywhere(id)?.t), // [ai off-tab]
  tools: EXTERNAL_TOOLS,
  connectorTools: (chat) => (!chat || projectAllows(chat, 'connectors') ? connectorsFacade.defs() : []), // [connectors] offered only to runs Lumen owns (features/ai-agents.js runTools); [project workspace] a project can turn them off
  projectTools: (chat) => (chat?.settings?.projectTools === true ? [require('./ai/agent').PROJECT_TOOL_DEF] : []), // [project workspace] project_files, to a run in a project chat that has files or pinned pages
  wordTools: (chat) => agent.cliWordToolDefs(chat), // [word] the word tool, to a run whose chat is about a Word document (agent.js cliWordNote)
  helperTools: (kind, engine) => agent.cliHelperToolDefs(kind, engine), // [cli helpers] delegate for Claude Code / Codex / Antigravity chats (agent.js)
  validateToolInput,
  isSettingsSender: (event) => syntheticTestEvent(event) || isSettingsSender(event), // Antigravity's install button answers only the settings page
  maxWarmChats: () => perfMode.limits().maxWarmChats, // [warm per chat] idle warm Claude Code processes kept (Performance mode: fewer)
  // [warm per chat] how long a chat's idle Claude Code process is kept: the same setting as a kept Grok Build's
  // (grokKeepIdleMinutes; 0: never, Infinity), read when the chat's engine is made.
  warmIdleMs: () => { const m = Number(readSettings().grokKeepIdleMinutes); return Number.isFinite(m) && m >= 0 ? (m === 0 ? Infinity : m * 60000) : null; },
  // Not the settings tab: its page API manages keys and saved passwords ([passwords]).
  modelsChanged: () => modelsChanged(),
  userTabs: () => tabs.filter((t) => alive(t) && !t.settings).map((t) => ({ id: t.id, webContents: t.view.webContents })),
  // [agent window] each outside MCP session's own window (features/agent-windows.js); its steps and approval cards go to the user's window.
  agentWindows: { windows: agentWindows, activeTabId: (rec) => activeIdOf(rec) },
  showAgentWindow: (rec) => { if (rec && rcAlive(rec) && rec.agent) { if (rec.win.isMinimized()) rec.win.restore(); rec.win.focus(); } }, // the toolbar badge, clicked by the user
  approvalsChanged: () => missionSoon(), // [mission control] an outside agent's card came or went
  userUi: () => {
    const user = [focusedRec(), curRec].find((r) => r && rcAlive(r) && winRecs.has(r) && !isSpare(r) && !r.agent) || [...winRecs].find((r) => rcAlive(r) && !isSpare(r) && !r.agent) || null;
    return user ? user.win.webContents : ui();
  },
});

// ---------- [mission control] lumen://tasks: everything the AI is doing (features/mission-control.js, renderer/mission.html) ----------
// The page reads what is going on and its buttons go through the actions that already exist: the sidebar's approve
// (agent.resolveApproval), the Tasks panel's (bgTasks.approve), Stop (stopChat, bgTasks.stop, an outside agent's session Stop),
// Go to, and a routine's on / off (bgTasks.setEnabled). Only cards that are waiting now can be answered.
const missionLib = () => require('./features/mission-control'); // (loaded on first use, not at startup)
let missionChatsDone = []; // sidebar runs finished since Lumen started, newest first (tasks keep their own history)
const agentSince = new WeakMap(); // an outside agent's window -> when it was first seen working
const chatTitleOf = (id, text) => { try { return chats().list().find((c) => c.id === id)?.title || chatRunsLib.firstLine(text, 80) || ''; } catch { return chatRunsLib.firstLine(text, 80) || ''; } };
function missionFinished(run) {
  missionChatsDone = missionLib().noteFinished(missionChatsDone, { chatId: run.chatId, title: chatTitleOf(run.chatId, run.text), startedAt: run.startedAt, endedAt: Date.now(), status: chatRunsLib.outcome(run), preview: run.error ? run.errorSummary || run.error : chatRunsLib.firstLine(run.reply, 200) });
  missionGoto.set(run.chatId, { chatId: run.chatId, tabId: run.tabId, homeTab: run.homeTab, rec: run.rec });
  if (missionGoto.size > missionLib().RECENT_MAX) missionGoto.delete(missionGoto.keys().next().value);
}
const missionGoto = new Map(); // a finished chat -> where it ran (Go to on the Recent list)
// Outside agents working in a window of their own: the window, its session (the MCP connection) and its id for the page.
function missionAgents() {
  return agentWindows.windows().map((rec) => {
    const session = agentWindows.keyOf(rec);
    if (!agentSince.has(rec)) agentSince.set(rec, Date.now());
    return { rec, session, id: String(rec.win.id), clientName: session?.clientName || rec.agent?.label || 'Agent', since: agentSince.get(rec), canStop: typeof session?.disconnect === 'function' };
  });
}
function missionState() {
  const agents = missionAgents();
  const idOfRec = (rec) => agents.find((a) => a.rec === rec)?.id ?? null;
  return missionLib().aggregate({
    // A temporary chat is shown as one, without its words (mission-control.js hides them too). Private windows have no sidebar, so no chat of theirs is here.
    chats: [...chatRuns.values()].filter((r) => !r.deleted).map((r) => (temporaryChats.has(r.chatId)
      ? { chatId: r.chatId, temporary: true, running: !r.queued && agent.runningFor(r.messages), queued: Boolean(r.queued), startedAt: r.startedAt, approvals: [...r.pending.values()].map((a) => ({ approvalId: a.approvalId, action: a.action })) }
      : {
        chatId: r.chatId, title: chatTitleOf(r.chatId, r.text), running: !r.queued && agent.runningFor(r.messages), queued: Boolean(r.queued), startedAt: r.startedAt,
        step: r.details?.tools[r.details.tools.length - 1]?.label || '', approvals: [...r.pending.values()],
      })),
    tasks: bgTasks.overview().map((x) => (missionFromPhone.has(x.id) ? { ...x, via: 'telegram' } : x)),
    agents: agents.map(({ rec, session, ...a }) => a),
    agentCards: aiAgents.agentCards().map((c) => ({ ...c, agentId: idOfRec(c.key) })),
    chatsDone: missionChatsDone,
  });
}
function missionAct(raw) {
  const req = missionLib().cleanRequest(raw);
  if (!req) return { ok: false };
  if (req.op === 'answer') {
    // The card as it waits now, and the answers the page offered for it (mission-control.js choicesFor): a card that needs its own
    // (a file to choose, an app, a content-loss check, a connector's write, a memory note, details too long to show, a temporary chat) has none.
    const card = req.kind === 'task' ? bgTasks.pendingCard(req.id, req.approvalId) : req.kind === 'chat' ? chatRuns.get(req.id)?.pending.get(req.approvalId) : aiAgents.agentCards().find((c) => c.approvalId === req.approvalId);
    const temporary = req.kind === 'chat' && temporaryChats.has(req.id);
    if (!card || !missionLib().choicesFor(req.kind, missionLib().cardText(card), { temporary }).includes(req.choice)) return { ok: false };
    if (req.kind === 'task') return { ok: bgTasks.approve(req.id, req.approvalId, req.choice) }; // the Tasks panel's own path ('tasks:approve')
    agent.resolveApproval(req.approvalId, req.choice === 'allow'); // the sidebar's own path ('agent:approve')
    return { ok: true };
  }
  if (req.op === 'toggle') return { ok: Boolean(bgTasks.setEnabled(req.id, req.on)) };
  const agentRec = req.kind === 'agent' ? missionAgents().find((a) => a.id === req.id) : null;
  if (req.op === 'stop') {
    if (req.kind === 'chat') return { ok: stopChat(req.id) };
    if (req.kind === 'task') return { ok: bgTasks.stop(req.id) };
    if (!agentRec?.canStop) return { ok: false };
    agentRec.session.disconnect(); // the same as Stop for an outside app (features/external-apps.js): its connection ends
    return { ok: true };
  }
  // Go to: the chat in its tab with the sidebar open, the task in the Tasks panel, the agent's own window.
  if (req.kind === 'chat') {
    const run = chatRuns.get(req.id) || missionGoto.get(req.id) || { chatId: req.id };
    return { ok: openNotified({ run, kind: run.pending?.size ? 'approval' : 'done' }) };
  }
  if (req.kind === 'task') { ui()?.send('tasks:open', { id: req.id }); return { ok: true }; }
  if (!agentRec) return { ok: false };
  agentRec.rec.win.isMinimized() && agentRec.rec.win.restore();
  agentRec.rec.win.focus();
  return { ok: true };
}
ipcMain.handle('mission:state', (event) => (managers.fromPage(event, 'tasks') ? missionState() : null));
ipcMain.handle('mission:act', (event, req) => (managers.fromPage(event, 'tasks') ? missionAct(req) : { ok: false }));
ipcMain.on('mission:open', () => managers.open('tasks')); // (UI_ONLY_IPC: the browser UI only)
let missionTimer = null;
missionSoon = () => {
  if (missionTimer) return;
  missionTimer = setTimeout(() => {
    missionTimer = null;
    for (const x of allTabsEverywhere()) if (x.managerPage === 'tasks' && alive(x)) x.view.webContents.send('mission:changed');
  }, 150);
};
if (TEST) global.__mission = { state: () => missionState(), act: (req) => missionAct(req) };

// ---------- updates from GitHub Releases (features/updates.js) ----------

const updates = require('./features/updates').createUpdates({
  app, ipcMain, session, ui, readSettings, writeSettings, test: TEST, t,
  prefs: () => settingsBackend.prefs(),
  startupDelayMs: () => perfMode.limits().startupDelayMs,
  beforeInstall: () => { saveSession(); saveChat(); try { chats().flush(); } catch { /* nothing pending */ } }, // the installer may close Lumen before its windows do
});
if (TEST) global.__updates = updates;
app.on('will-quit', () => updates.applyOnQuit()); // a downloaded update installs when the user just quits

// A second launch (or a link from another app) brings a window forward, whatever state the last one is in: minimized, hidden, or
// closed (macOS keeps running with no window; an instance whose window is gone gets a new one rather than a silent no-op).
const focusWindow = () => {
  if (!win || win.isDestroyed()) {
    const other = [...winRecs].find(rcAlive);
    if (other) raiseWindow(other.win);
    else if (app.isReady() && !quitting) { dropDeadWindowViews(); createWindow(); }
    return;
  }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
};
// Opening the shortcut again focuses the running browser (two copies would overwrite each other's
// files); a link opened from another app while Lumen runs comes the same way, and opens in a tab.
// The taskbar's "Close tabs the AI opened" arrives the same way, with no link: it does its work in the background and does not
// bring a window forward.
app.on('second-instance', (_e, argv) => {
  const closeAi = taskbarTasks.wantsCloseAiTabs(argv);
  if (closeAi) closeAiTabsEverywhere().catch(() => {});
  const links = linksIn(argv);
  if (!closeAi || links.length) { if (links.length || !activateNotified()) focusWindow(); openLinksFromOtherApps(links); } // (a toast clicked from the Action Center arrives here with no link: it goes where the click would have)
});
// The taskbar entry: a Jump List task on Windows (an installed Lumen only: from source or in a test the program would be the
// wrong one, and the Jump List belongs to the installed app's identity), the Dock menu on macOS.
function setupTaskbar() {
  if (TEST) return;
  if (process.platform === 'win32' && app.isPackaged) {
    try { app.setUserTasks(taskbarTasks.jumpListTasks({ execPath: process.execPath, iconPath: instance.appIcon(), label: t('taskbar.closeAiTabs'), description: t('taskbar.closeAiTabsDesc') })); } catch {}
  } else if (process.platform === 'darwin') {
    try { app.dock?.setMenu(Menu.buildFromTemplate(taskbarTasks.dockMenuItems({ label: t('taskbar.closeAiTabs'), click: () => { closeAiTabsEverywhere().catch(() => {}); } }))); } catch {}
  }
}

app.whenReady().then(async () => {
  perf.mark('ready');
  // (The drag card's window is no longer made here: a tab drag makes it when it starts, see dragCardReaper.)
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
  instance.listenForSecondInstances(app, () => { if (!activateNotified()) focusWindow(); }, { isQuitting: () => quitting });
  setupTaskbar();
  instance.ensureStartMenuShortcut(app, shell, APP_ID); // the shortcut a notification is named from (carries the app ID)
  setTimeout(() => instance.fixShortcutIcons(app, shell, undefined, APP_ID), 10000).unref?.(); // (~150 .lnk files read: never before the first window)
  instance.fixAppName(app, APP_ID); // Explorer and notifications say Lumen, not Electron
  instance.fixAssociationIconsAtStartup(app); // PDF, HTML and SVG files show Lumen's icon, not Electron's (the exe's own)
  setTimeout(() => setup.repairRegistration().catch(() => {}), 8000).unref?.(); // the default-browser registration names this Lumen.exe (links, SSO sign-ins)
  aiAgents.start({ after: firstTabLoaded }); // MCP server, CDP automation (if on), Claude Code detection (once the first tab has loaded)
  settingsBackend.start(ipcMain); // [settings] theme, spell check, proxy, request headers, prefs:* IPC
  setupPermissions();
  downloads.load(); // the list from last time (downloads.json)
  usage.load(); // [usage] the log from earlier sessions (usage.json)
  bgTasks.init(); // background tasks: restore them and start the scheduler
  telegram.refresh(); // [telegram] listen to the user's bot, when Phone (Telegram) is on and a token is saved
  downloads.setup();
  siteActivity.watch(session.defaultSession);
  loadChat();
  loadHistory();
  // Until the ad blocker takes over onBeforeRequest (it sends pages to the same gate), or if it
  // fails to start, pages still go through Safe Browsing's check.
  session.defaultSession.webRequest.onBeforeRequest(GATE_FILTER, (details, callback) => mainFrameGate(details, callback));
  safeBrowsing.refresh().catch(() => {});
  startFocus(); // [focus] a session still running, or a schedule: the gate is up before the first page loads
  // Filter lists: from the cache they load in a moment, so tabs wait for them (restored tabs would
  // otherwise load unfiltered, and without the document-start scriptlets). The first run's download
  // doesn't hold up the window. They load while the extensions start (the two don't depend on each other).
  // Extensions must be ready before tabs exist so every tab is registered with chrome.tabs; the window itself
  // (its UI, ~0.5 MB of scripts) loads meanwhile, and its tabs come once both are ready (tabsGate).
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(__dirname, 'assets', 'icon.png'));
  crashRecovery.begin({ mode: settingsBackend.startupPlan().mode }); // (before the first window saves a session over the last run's)
  setAboutPanel();
  wireSchedulerPower();
  createWindow(); // (first: the ad blocker's and extensions' code loads while the window's UI does)
  const extending = setupExtensions().catch((err) => console.error('Extension support failed to start:', err));
  const blocking = adblock.setup().then(() => perf.mark('adblockSetup')).catch((err) => console.error('Ad blocker failed to start:', err));
  // (Neither holds the tabs back more than 3 s: a stuck start must not leave a window with no tabs.)
  const atMost = (p, ms = 3000) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);
  // Extensions: registered by now if they load quickly; one with a big rule set takes seconds, and the pages must not wait
  // for it (a restored session sat on a blank tab 3 s). It finishes meanwhile; see lateExtension().
  await Promise.all([atMost(extending, EXTENSIONS_WAIT_MS), atMost(fs.existsSync(path.join(app.getPath('userData'), 'adblock-engine.bin')) ? blocking : null)]);
  perf.mark('adblockReady');
  openTabsGate();
  setTimeout(markFirstTabLoaded, 8000).unref?.(); // (a first tab that never finishes doesn't hold these back)
  // Everything below waits for the first tab to have loaded, then runs one task at a time, a gap apart (features/startup-queue.js).
  const startup = require('./features/startup-queue').createStartupQueue();
  startup.add('spare new-tab page and warm renderer', () => { makeSpareNewTab(); warmSoon(400); }, { priority: 1 }); // a new-tab page ready for the first Ctrl+T, and a renderer for the first web page
  startup.add('performance mode', () => perfMode.start(), { priority: 2 }); // power events, and whether the GPU really draws
  startup.add('model lists', () => perfMode.later(() => { for (const provider of Object.keys(providers.PROVIDERS)) if (providerKey(provider)) refreshModels(provider); }), { priority: 3 }); // nothing waits for them
  startup.add('folder sync', () => { if (readSettings().syncFolder?.on) syncService().start(); }, { priority: 6 }); // [sync] off by default: nothing is loaded unless the person turned it on
  startup.add('update check', () => updates.start(), { priority: 4 }); // first check after a short delay (longer in Performance mode), then every few hours
  startup.add('GPU check', () => { setTimeout(() => perfMode.checkGpu(), 5000).unref?.(); }, { priority: 2 }); // the GPU process has reported by then
  firstTabLoaded.then(() => startup.release());
});
// On macOS the app stays running with no windows, and clicking the Dock icon opens one again.
// Registered after every other before-quit handler, so the deadline starts only once all of them have run: their writes are
// synchronous (temp file and rename) and are never cut short by it.
app.on('before-quit', () => quitGuard.arm());
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
