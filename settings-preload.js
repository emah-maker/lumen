// Preload for the lumen://settings tab only (see settings-backend.js). main.js gives it to that
// one tab, and every call is checked again in the main process.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:' && /\/renderer\/settings\.html$/.test(location.pathname)) {
  const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
  contextBridge.exposeInMainWorld('lumenSettings', {
    get: call('prefs:get'),
    set: call('prefs:set'),
    clearData: call('prefs:clear-data'),
    downloads: call('prefs:downloads'),
    clearDownloads: call('prefs:clear-downloads'),
    showDownload: call('prefs:open-download'),
    pickDownloadDir: call('prefs:pick-download-dir'),
    sitePermissions: call('prefs:site-permissions'),
    revokePermission: call('prefs:revoke-permission'),
    extensions: call('prefs:extensions'),
    removeExtension: call('prefs:remove-extension'),
    extensionOptions: call('prefs:extension-options'),
    openUrl: call('prefs:open-url'),
    reset: call('prefs:reset'),
    relaunch: call('prefs:relaunch'),
    about: call('prefs:about'),
    taskManager: call('prefs:task-manager'),
    restartTab: call('prefs:restart-tab'),
    internals: call('prefs:internals'),
    // "You and AI" reuses the sidebar's settings calls.
    ai: {
      get: call('settings:get'),
      setKey: call('settings:set-key'),
      setProviderKey: call('settings:set-provider-key'),
      openRouterSignIn: call('openrouter:sign-in'),
      setModel: call('settings:set-model'),
      setAdhdMode: call('settings:set-adhd'),
      setAutoGroup: call('settings:set-auto-group'),
      setTabGrouping: call('settings:set-tab-grouping'),
      setTopicAi: call('settings:set-topic-ai'),
      setSearchEngine: call('settings:set-search-engine'),
      cliStatus: call('cli:status'),
      cliLogin: call('cli:login'),
      cliLogout: call('cli:logout'),
      claudeCodeStatus: call('claudecode:status'),
      mcpInfo: call('mcp:info'),
      setMcpEnabled: call('mcp:set-enabled'),
      addToAgent: call('mcp:add-to-agent'),
      addToClaudeCode: call('mcp:add-to-claude'), // kept as an alias
      automationInfo: call('automation:info'),
      setAutomation: call('automation:set'),
      importBrowsers: call('import:browsers'),
      importFrom: call('import:run'),
      onCliProgress: (cb) => ipcRenderer.on('cli:progress', (_e, text) => cb(text)),
    },
  });
}
