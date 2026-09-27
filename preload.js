const { contextBridge, ipcRenderer } = require('electron');
const { injectBrowserAction } = require('electron-chrome-extensions/browser-action');

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
  webAiMode: (mode) => ipcRenderer.invoke('webai:mode', mode),
  webAiBounds: (rect) => ipcRenderer.send('webai:bounds', rect),
  webAiState: () => ipcRenderer.invoke('webai:state'),
  webAiShare: () => ipcRenderer.invoke('webai:share'),
  onWebAiSwitch: on('webai:switch'),
  onAskSelection: on('ask-selection'),
  onWindowFocus: on('window-focus'),
  openAppMenu: (point) => ipcRenderer.send('app-menu', point),
  onOpenSettings: on('open-settings'),
  suggest: (query) => ipcRenderer.invoke('suggest:query', query),
  showSuggestions: (rect, payload) => ipcRenderer.send('suggest:show', rect, payload),
  hideSuggestions: () => ipcRenderer.send('suggest:hide'),
  onSuggestionPicked: on('suggest:picked'),
});

contextBridge.exposeInMainWorld('assistant', {
  ask: (text, runId, images) => ipcRenderer.send('agent:ask', text, runId, images),
  stop: () => ipcRenderer.send('agent:stop'),
  reset: () => ipcRenderer.send('agent:reset'),
  onEvent: on('agent:event'),
  // AI agents over MCP
  onMcpEvent: on('mcp:event'),
  mcpInfo: () => ipcRenderer.invoke('mcp:info'),
  setMcpEnabled: (on) => ipcRenderer.invoke('mcp:set-enabled', on),
  stopMcp: () => ipcRenderer.send('mcp:stop'),
  onHistory: on('agent:history'),
  approve: (approvalId, ok) => ipcRenderer.send('agent:approve', approvalId, ok),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setKey: (key) => ipcRenderer.invoke('settings:set-key', key),
  setAdhdMode: (on) => ipcRenderer.invoke('settings:set-adhd', on),
  setAutoGroup: (on) => ipcRenderer.invoke('settings:set-auto-group', on),
  setModel: (id) => ipcRenderer.invoke('settings:set-model', id),
  setProviderKey: (provider, key) => ipcRenderer.invoke('settings:set-provider-key', provider, key),
  setSearchEngine: (id) => ipcRenderer.invoke('settings:set-search-engine', id),
  cliStatus: () => ipcRenderer.invoke('cli:status'),
  cliLogin: () => ipcRenderer.invoke('cli:login'),
  cliLogout: () => ipcRenderer.invoke('cli:logout'),
  onCliProgress: on('cli:progress'),
  onSearchEngine: on('search-engine'),
  importBrowsers: () => ipcRenderer.invoke('import:browsers'),
  importFrom: (id) => ipcRenderer.invoke('import:run', id),
  onModelsUpdated: on('models-updated'),
});

// ---- [claude code engine] + [page context] + [panel snapshot]
contextBridge.exposeInMainWorld('lumenExtras', {
  addToClaudeCode: () => ipcRenderer.invoke('mcp:add-to-claude'),
  getPageContext: () => ipcRenderer.invoke('pagecontext:get'),
  setPageContext: (on) => ipcRenderer.invoke('pagecontext:set', on),
  webAiSnapshot: () => ipcRenderer.invoke('webai:snapshot'),
});
// ---- [/claude code engine] + [/page context] + [/panel snapshot]
