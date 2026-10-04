const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action');

// Before any page script runs: tells main this view has the UI's preload, so main.js's backstop
// holds it to renderer/index.html (it can only make the view more restricted).
ipcRenderer.sendSync('ui-preload:loaded');

// The UI's strings in the system's language (features/i18n.js; renderer/i18n.js looks them up).
// Asked only from renderer/index.html: the window's first about:blank runs this preload too, and
// main's gate (rightly) refuses it there.
const isUiPage = location.protocol === 'file:' && /\/renderer\/index\.html$/.test(location.pathname);
contextBridge.exposeInMainWorld('lumenI18n', (isUiPage && ipcRenderer.sendSync('ui:strings')) || { locale: 'en', strings: {} });

// Defines <browser-action-list>, the row of extension buttons in the toolbar.
injectBrowserAction();

const on = (channel) => (callback) => ipcRenderer.on(channel, (_e, payload) => callback(payload));

// `platform-darwin` / `platform-win32` on <html>: macOS has traffic lights on the left, Windows
// has window controls on the right.
window.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add(`platform-${process.platform}`));

contextBridge.exposeInMainWorld('browser', {
  setContentBounds: (bounds) => ipcRenderer.send('content-bounds', bounds),
  freezeView: (size) => ipcRenderer.invoke('view:freeze', size),
  thawView: () => ipcRenderer.send('view:thaw'),
  freezeAlive: () => ipcRenderer.send('view:freeze-alive'),
  setChatFull: (on) => ipcRenderer.send('chat:full', on),
  warmView: () => ipcRenderer.invoke('view:warm'),
  newTab: (url) => ipcRenderer.send('tab:new', url),
  // Dropped files: the page can't see paths, so they're resolved here (webUtils) and main.js opens them.
  openFiles: (files) => ipcRenderer.send('files:open', [...files].map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
  closeTab: (id) => ipcRenderer.send('tab:close', id),
  switchTab: (id) => ipcRenderer.send('tab:switch', id),
  moveTab: (id, toIndex, done) => ipcRenderer.send('tab:move', id, toIndex, Boolean(done)), // done: the strip is waiting to show the tab in its slot
  moveTabs: (ids, beforeId, groupId, join) => ipcRenderer.send('tab:move-block', ids, beforeId, groupId, join), // several tabs (a selection, a group) as one block
  // A tab dragged out of the strip: main.js moves it into a window that follows the cursor.
  dragTabPrep: (id) => ipcRenderer.send('tab:dragprep', id), // a tab is heading out of the strip: a tear-off may follow
  onTabDragDone: on('tab:dragdone'), // a dropped tab has been placed: show it again if it stayed here
  dragTabStart: (id, grab) => ipcRenderer.send('tab:dragstart', id, grab),
  dragTabEnd: () => ipcRenderer.send('tab:dragend'), // the button came up
  dragTabCancel: () => ipcRenderer.send('tab:dragcancel'), // Escape
  onTabArriving: on('tab:arriving'), // { ids }: tabs about to land here stay invisible until the chip that carries them arrives
  onTabLanded: on('tab:landed'), // the chip has landed: they show
  onTabDropAt: on('tab:dropat'), // { beforeId } while a dragged window hovers this strip, null when it leaves
  onTabDragAbort: on('tab:dragabort'), // main gave up on a drag whose release never came
  onTabArrived: on('tab:arrived'),
  onTabMovedHere: on('tab:moved-here'), // tabs moved into this window from the tab menu: { ids, title } // this new window was just given dragged tabs ({ count }): announced
  dragTabMove: () => ipcRenderer.send('tab:dragmove'), // the pointer moved during a drag main.js drives
  setTabSelection: (ids) => ipcRenderer.send('tab:selection', ids), // the strip's multi-selection: drags and the tab menu act on all of it
  hideAiTabs: (on) => ipcRenderer.invoke('tabs:hide-ai', on), // [ai manners] no argument: just read it
  tabMenu: (id, point) => ipcRenderer.send('tab:context-menu', id, point),
  groupMenu: (id, point) => ipcRenderer.send('group:context-menu', id, point),
  toggleGroup: (id) => ipcRenderer.send('group:toggle', id),
  renameGroup: (id, name) => ipcRenderer.send('group:rename', id, name),
  onRenameGroup: on('group:rename-start'),
  organizeTabs: () => ipcRenderer.send('tabs:organize'),
  onOrganizing: on('tabs:organizing'),
  onOrganizeNote: on('tabs:organize-note'),
  undoAiClose: (token) => ipcRenderer.invoke('tabs:undo-ai-close', token), // [ai manners]
  undoOrganize:() => ipcRenderer.send('tabs:undo-organize'),
  toggleBookmark: () => ipcRenderer.send('bookmark:toggle'),
  toggleReader: () => ipcRenderer.send('page:reader'),
  translateAct: (action, arg) => ipcRenderer.send('translate:act', action, arg), // the translate infobar and button (features/translate.js)
  passwordsAct: (action) => ipcRenderer.send('passwords:act', action), // [passwords] the save bar and the key button: no password ever passes here
  resetZoom: () => ipcRenderer.send('zoom:reset'),
  onDownloads: on('downloads'),
  openDownloadsMenu: (point) => ipcRenderer.send('downloads:menu', point),
  go: (text) => ipcRenderer.send('nav:go', text),
  back: () => ipcRenderer.send('nav:back'),
  forward: () => ipcRenderer.send('nav:forward'),
  reload: () => ipcRenderer.send('nav:reload'),
  find: (text, options) => ipcRenderer.send('find:start', text, options),
  stopFind: () => ipcRenderer.send('find:stop'),
  onFindResult: on('find:result'),
  onOpenFind: on('find:open'),
  onTabs: on('tabs'),
  onFocusAddress: on('focus-address'),
  onToggleSidebar: on('toggle-sidebar'),
  onNewSidebarChat: on('new-sidebar-chat'),
  onAskSelection: on('ask-selection'),
  onAttachImage: on('attach-image'), // a screenshot for the sidebar composer (features/screenshot.js)
  onAskFromHome: on('ask-from-home'),
  onWindowFocus: on('window-focus'),
  onAgentWindow: on('agent-window'), // this window belongs to an outside agent (or no longer does: null)
  openAppMenu: (point) => ipcRenderer.send('app-menu', point),
  openPageInfo: (point) => ipcRenderer.send('page-info:open', point), // the lock next to the address (features/page-info.js)
  openActionsOverflow: (point, items) => ipcRenderer.send('actions:overflow', point, items), // the extension icons that don't fit the toolbar
  onActionsOverflowPick: on('actions:overflow-pick'),
  suggest: (query) => ipcRenderer.invoke('suggest:query', query),
  showSuggestions: (rect, payload) => ipcRenderer.send('suggest:show', rect, payload),
  hideSuggestions: () => ipcRenderer.send('suggest:hide'),
  addressTouched: () => ipcRenderer.send('address:touched'),
  onSuggestionPicked: on('suggest:picked'),
  // Tab search (Ctrl+Shift+A) and the tab strip's speaker button (features/tab-tools.js)
  toggleMute: (id) => ipcRenderer.send('tab:mute', id),
  closedTabs: () => ipcRenderer.invoke('tabsearch:closed'),
  reopenClosed: (index, url) => ipcRenderer.invoke('tabsearch:reopen', index, url),
  onOpenTabSearch: on('tabsearch:open'),
});

// [settings] lumen://settings: open it, and the UI preferences it controls (compact tabs, …).
contextBridge.exposeInMainWorld('lumenPrefs', {
  openSettingsPage: (section) => ipcRenderer.send('settings-page:open', section),
  get: () => ipcRenderer.invoke('prefs:ui'),
  onChange: on('prefs:ui'),
});

// The toolbar's update prompt (renderer/updates.js, features/updates.js).
contextBridge.exposeInMainWorld('lumenUpdates', {
  state: () => ipcRenderer.invoke('settings:updates-state'),
  apply: () => ipcRenderer.invoke('settings:updates-apply'),
  dismiss: () => ipcRenderer.invoke('settings:updates-dismiss'),
  onState: on('updates:state'),
});

// Only what the browser UI itself uses. Keys, MCP, automation and import are set in lumen://settings
// (settings-preload.js); the tests still reach a few of those calls through here. main.js adds
// this switch only in test mode, which a packaged build never is (test-mode.js).
const testOnly = process.argv.includes('--lumen-test-mode') ? {
  mcpInfo: () => ipcRenderer.invoke('mcp:info'),
  setMcpEnabled: (on) => ipcRenderer.invoke('mcp:set-enabled', on),
  automationInfo: () => ipcRenderer.invoke('automation:info'),
  setAutomation: (options) => ipcRenderer.invoke('automation:set', options),
  setAutoGroup: (on) => ipcRenderer.invoke('settings:set-auto-group', on),
  setProviderKey: (provider, key) => ipcRenderer.invoke('settings:set-provider-key', provider, key),
} : {};
contextBridge.exposeInMainWorld('assistant', {
  ask: (text, runId, images, tabIds) => ipcRenderer.send('agent:ask', text, runId, images, tabIds),
  askTabs: () => ipcRenderer.invoke('tabs:ask-list'), // the "@" picker's tabs (renderer/tabs-ask.js)
  stop: () => ipcRenderer.send('agent:stop'),
  resync: () => ipcRenderer.invoke('chat:resync'), // the chat this window's front tab shows, with its own run state
  prewarm: (text) => ipcRenderer.send('agent:prewarm', typeof text === 'string' ? text.slice(0, 2000) : ''), // the composer was focused / typed in: Claude Code's process starts ahead of the message
  reset: () => ipcRenderer.send('agent:reset'),
  rewind: (expected) => ipcRenderer.invoke('agent:rewind', expected), // Retry / Regenerate: the last exchange taken back
  // The chat history list (renderer/chats.js)
  // Pictures the AI made (renderer/gen-images.js): the picture as a data URL, Save image, Copy image, and a web picture the user clicked.
  images: {
    data: (id) => ipcRenderer.invoke('images:data', id),
    save: (id) => ipcRenderer.invoke('images:save', id),
    copy: (id) => ipcRenderer.invoke('images:copy', id),
    remote: (url) => ipcRenderer.invoke('images:remote', url),
  },
  chats: {
    list: () => ipcRenderer.invoke('chats:list'),
    open: (id) => ipcRenderer.invoke('chats:open', id), // also "Move chat to this tab"
    showTab: (id) => ipcRenderer.invoke('chats:show-tab', id), // "Open chat in its tab"
    share: (id) => ipcRenderer.invoke('chats:share', id), // "Also show in this tab" (the chat stays in the tabs it was in)
    stopChat: (id) => ipcRenderer.invoke('chats:stop', id), // "Stop waiting" (or stop) any chat, not only the open one
    rename: (id, title) => ipcRenderer.invoke('chats:rename', id, title),
    remove: (id) => ipcRenderer.invoke('chats:delete', id),
    exportChat: (id) => ipcRenderer.invoke('chats:export', id),
    closeTabs: (id) => ipcRenderer.invoke('chats:close-tabs', id), // [ai manners] "Close this chat's tabs"
    onUsage: on('chats:usage'),
    onContext: on('chats:context'), // [context] how full the open chat's context window is (features/chat-usage.js contextView)
    onChanged: on('chats:changed'), // a chat started or stopped running, needs an OK, or finished unseen
  },
  // The sidebar working on its own: whether it is open, the mark on its button, a notification clicked
  sidebarState: (open) => ipcRenderer.send('chat:sidebar-state', open),
  setSidebarOpen: (tabId, open) => ipcRenderer.invoke('sidebar:set', tabId ?? null, Boolean(open)), // [sidebar per tab] the sidebar is open or closed on this tab
  onAttention: on('agent:attention'), // { state: 'approval' | 'unread' | null, approvals, unread }
  onOpenChat: on('agent:open-chat'), // { id }: show the sidebar on that chat
  // Background tasks (renderer/tasks.js, features/background-runner.js)
  tasks: {
    state: () => ipcRenderer.invoke('tasks:state'),
    preview: (spec) => ipcRenderer.invoke('tasks:preview', spec),
    create: (spec) => ipcRenderer.invoke('tasks:create', spec),
    get: (id) => ipcRenderer.invoke('tasks:get', id),
    run: (id, opts) => ipcRenderer.invoke('tasks:run', id, opts),
    edit: (id, patch, opts) => ipcRenderer.invoke('tasks:edit', id, patch, opts),
    stop: (id) => ipcRenderer.invoke('tasks:stop', id),
    remove: (id) => ipcRenderer.invoke('tasks:delete', id),
    approve: (id, approvalId, choice) => ipcRenderer.invoke('tasks:approve', id, approvalId, choice),
    schedule: (id, schedule) => ipcRenderer.invoke('tasks:schedule', id, schedule),
    enable: (id, on) => ipcRenderer.invoke('tasks:enable', id, on),
    openPage: (id) => ipcRenderer.invoke('tasks:open-page', id),
    settings: (patch) => ipcRenderer.invoke('tasks:settings', patch),
    saveRoutine: (spec) => ipcRenderer.invoke('routines:save', spec), // routines (renderer/routines.js)
    routinePreview: (spec) => ipcRenderer.invoke('routines:preview', spec),
    onState: on('tasks:state'),
    onToast: on('tasks:toast'),
    onOpen: on('tasks:open'),
    onPropose: on('tasks:propose'),
  },
  onEvent: on('agent:event'),
  // AI agents over MCP
  onMcpEvent: on('mcp:event'),
  stopMcp: () => ipcRenderer.send('mcp:stop'),
  onHistory: on('agent:history'),
  // The chat as a full page (lumen://chat, features/chat-page.js): open it, and hear about the other view
  openFullPage: () => ipcRenderer.send('chat:open-page'),
  onRunStart: on('chat:run-start'), // a turn started in the chat page
  onSync: on('chat:sync'), // the chat page switched chats, started a new one or deleted this one
  onAgentTarget: on('agent:target'), // the tab the running task works in ({ id, title, host, front }), or null
  showAgentTarget: () => ipcRenderer.send('agent:show-target'),
  onSidebar: on('chat:sidebar'), // fold the sidebar away (the page opened) or bring it back (the page closed)
  approve: (approvalId, ok) => ipcRenderer.send('agent:approve', approvalId, ok),
  undoRun: (runId) => ipcRenderer.invoke('agent:undo', runId), // [ai controls]
  closeAiTabs: (opts) => ipcRenderer.invoke('agent:ai-tabs-close', opts), // [ai manners] { runId } | { chatId }: close the tabs the AI opened
  undoCloseAiTabs: (token) => ipcRenderer.invoke('agent:ai-tabs-undo', token),
  autoAllow: (on) => ipcRenderer.invoke('agent:auto-allow', on), // no argument: just read it
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setModel: (id) => ipcRenderer.invoke('settings:set-model', id),
  useGrokBuild: () => ipcRenderer.invoke('settings:use-grok-build'), // the setup card
  useCodex: () => ipcRenderer.invoke('settings:use-codex'), // the setup card (Codex, once found)
  useAntigravity: () => ipcRenderer.invoke('settings:use-antigravity'), // the setup card (Antigravity replaces Gemini CLI)
  openRouterModels: () => ipcRenderer.invoke('openrouter:models'),
  openRouterSignIn: () => ipcRenderer.invoke('openrouter:sign-in'),
  cancelOpenRouterSignIn: () => ipcRenderer.invoke('openrouter:cancel'),
  onSearchEngine: on('search-engine'),
  onModelsUpdated: on('models-updated'),
  // The first-run welcome (features/setup.js): its state, import without a dialog, the default browser.
  setup: {
    state: () => ipcRenderer.invoke('settings:setup-state'),
    done: () => ipcRenderer.invoke('settings:setup-done'),
    importFrom: (id) => ipcRenderer.invoke('import:quiet', id),
    makeDefault: () => ipcRenderer.invoke('settings:make-default'),
    isDefault: () => ipcRenderer.invoke('settings:default-browser'),
    onWelcome: on('setup:welcome'),
  },
  ...testOnly,
});

// Skills (features/skills.js): the composer's "/" menu. Running one is a normal chat message; managing
// them is in lumen://settings (settings-preload.js).
contextBridge.exposeInMainWorld('skillsApi', {
  menu: () => ipcRenderer.invoke('skills:menu'),
  context: (options) => ipcRenderer.invoke('skills:context', options),
  prepare: (request) => ipcRenderer.invoke('skills:prepare', request),
  draftFromChat: () => ipcRenderer.invoke('skills:draft-from-chat'),
  onChanged: on('skills:changed'),
  onRun: on('skill:run'), // "Run skill" on selected text in a page's right-click menu
});

// ---- [claude code engine] + [page context]
contextBridge.exposeInMainWorld('lumenExtras', {
  getPageContext: () => ipcRenderer.invoke('pagecontext:get'),
  setPageContext: (on) => ipcRenderer.invoke('pagecontext:set', on),
  // { installed, signedIn: true|false|'unknown', accountType: 'subscription'|'apiKey'|null, detail }
  claudeCodeStatus: (refresh) => ipcRenderer.invoke('claudecode:status', refresh),
  // [ai controls] sites where the user turned AI off (features/ai-sites.js)
  aiSiteState: (url) => ipcRenderer.invoke('settings:ai-site-state', url), // { site, off }
  setAiSite: (site, off) => ipcRenderer.invoke('settings:set-ai-site', site, off),
  // [usage] the plan's limits and Lumen's share (features/usage.js)
  usage: (refresh, cached) => ipcRenderer.invoke('usage:get', { refresh: Boolean(refresh), cached: Boolean(cached) }),
  openUsage: () => ipcRenderer.send('settings-page:open', 'usage'),
});
// ---- [/claude code engine] + [/page context]
