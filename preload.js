const { contextBridge, ipcRenderer } = require('electron');
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action');

// Before any page script runs: tells main this view has the UI's preload, so main.js's backstop
// holds it to renderer/index.html (it can only make the view more restricted).
ipcRenderer.sendSync('ui-preload:loaded');

// Defines <browser-action-list>, the row of extension buttons in the toolbar.
injectBrowserAction();

const on = (channel) => (callback) => ipcRenderer.on(channel, (_e, payload) => callback(payload));

// `platform-darwin` / `platform-win32` on <html>: macOS has traffic lights on the left, Windows
// has window controls on the right.
window.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add(`platform-${process.platform}`));

contextBridge.exposeInMainWorld('browser', {
  setContentBounds: (bounds) => ipcRenderer.send('content-bounds', bounds),
  freezeView: () => ipcRenderer.invoke('view:freeze'),
  thawView: () => ipcRenderer.send('view:thaw'),
  setChatFull: (on) => ipcRenderer.send('chat:full', on),
  warmView: () => ipcRenderer.invoke('view:warm'),
  newTab: (url) => ipcRenderer.send('tab:new', url),
  closeTab: (id) => ipcRenderer.send('tab:close', id),
  switchTab: (id) => ipcRenderer.send('tab:switch', id),
  moveTab: (id, toIndex) => ipcRenderer.send('tab:move', id, toIndex),
  tabMenu: (id, point) => ipcRenderer.send('tab:context-menu', id, point),
  groupMenu: (id, point) => ipcRenderer.send('group:context-menu', id, point),
  toggleGroup: (id) => ipcRenderer.send('group:toggle', id),
  renameGroup: (id, name) => ipcRenderer.send('group:rename', id, name),
  onRenameGroup: on('group:rename-start'),
  organizeTabs: () => ipcRenderer.send('tabs:organize'),
  onOrganizing: on('tabs:organizing'),
  toggleBookmark: () => ipcRenderer.send('bookmark:toggle'),
  toggleReader: () => ipcRenderer.send('page:reader'),
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
  onAskSelection: on('ask-selection'),
  onAskFromHome: on('ask-from-home'),
  onWindowFocus: on('window-focus'),
  openAppMenu: (point) => ipcRenderer.send('app-menu', point),
  suggest: (query) => ipcRenderer.invoke('suggest:query', query),
  showSuggestions: (rect, payload) => ipcRenderer.send('suggest:show', rect, payload),
  hideSuggestions: () => ipcRenderer.send('suggest:hide'),
  addressTouched: () => ipcRenderer.send('address:touched'),
  homeMode: () => ipcRenderer.invoke('home:mode'), // 'ask' | 'search' on the new-tab page, else null
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
  ask: (text, runId, images) => ipcRenderer.send('agent:ask', text, runId, images),
  stop: () => ipcRenderer.send('agent:stop'),
  reset: () => ipcRenderer.send('agent:reset'),
  // The chat history list (renderer/chats.js)
  chats: {
    list: () => ipcRenderer.invoke('chats:list'),
    open: (id) => ipcRenderer.invoke('chats:open', id),
    rename: (id, title) => ipcRenderer.invoke('chats:rename', id, title),
    remove: (id) => ipcRenderer.invoke('chats:delete', id),
    exportChat: (id) => ipcRenderer.invoke('chats:export', id),
    onUsage: on('chats:usage'),
  },
  onEvent: on('agent:event'),
  // AI agents over MCP
  onMcpEvent: on('mcp:event'),
  stopMcp: () => ipcRenderer.send('mcp:stop'),
  onHistory: on('agent:history'),
  approve: (approvalId, ok) => ipcRenderer.send('agent:approve', approvalId, ok),
  undoRun: (runId) => ipcRenderer.invoke('agent:undo', runId), // [ai controls]
  autoAllow: (on) => ipcRenderer.invoke('agent:auto-allow', on), // no argument: just read it
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setModel: (id) => ipcRenderer.invoke('settings:set-model', id),
  openRouterModels: () => ipcRenderer.invoke('openrouter:models'),
  openRouterSignIn: () => ipcRenderer.invoke('openrouter:sign-in'),
  cancelOpenRouterSignIn: () => ipcRenderer.invoke('openrouter:cancel'),
  onSearchEngine: on('search-engine'),
  onModelsUpdated: on('models-updated'),
  ...testOnly,
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
});
// ---- [/claude code engine] + [/page context]
