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
    pickWallpaper: call('prefs:pick-wallpaper'), // [look]
    removeWallpaper: call('prefs:remove-wallpaper'),
    // [widgets] Appearance → Widgets
    widgets: {
      state: call('prefs:widgets'),
      test: call('prefs:widget-test'),
      save: call('prefs:widget-save'),
      remove: call('prefs:widget-remove'),
      move: call('prefs:widget-move'),
    },
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
    strings: call('settings:strings'), // the page's text in the system's language (features/i18n.js)
    // You and AI → Usage (features/usage.js)
    usage: call('prefs:usage'),
    clearUsage: call('prefs:clear-usage'),
    // About → Updates (features/updates.js)
    updates: {
      state: call('settings:updates-state'),
      check: call('settings:updates-check'),
      apply: call('settings:updates-apply'),
    },
    // Skills (features/skills.js)
    skills: {
      list: call('skills:list'),
      save: call('skills:save'),
      remove: call('skills:delete'),
      reset: call('skills:reset'), // one built-in (id) or all of them
      preview: call('skills:preview'),
      exportAll: call('skills:export'),
      importPick: call('skills:import-pick'),
      importText: call('skills:import-text'),
      importCommit: call('skills:import-commit'),
      takeDraft: call('skills:take-draft'),
      onDraft: (cb) => ipcRenderer.on('skills:draft', (_e, draft) => cb(draft)),
      onChanged: (cb) => ipcRenderer.on('skills:changed', (_e, list) => cb(list)),
    },
    // "You and AI" reuses the sidebar's settings calls.
    ai: {
      get: call('settings:get'),
      setKey: call('settings:set-key'),
      setProviderKey: call('settings:set-provider-key'),
      safeBrowsing: call('settings:safe-browsing'),
      setSafeBrowsingKey: call('settings:set-safe-browsing-key'),
      openRouterSignIn: call('openrouter:sign-in'),
      cancelOpenRouterSignIn: call('openrouter:cancel'),
      setModel: call('settings:set-model'),
      setAdhdMode: call('settings:set-adhd'),
      setAutoGroup: call('settings:set-auto-group'),
      setTabGrouping: call('settings:set-tab-grouping'),
      setTopicAi: call('settings:set-topic-ai'),
      aiSites: call('settings:ai-sites'), // [ai controls]
      setAiSite: call('settings:set-ai-site'),
      setSearchEngine: call('settings:set-search-engine'),
      cliStatus: call('cli:status'),
      cliLogin: call('cli:login'),
      cliLogout: call('cli:logout'),
      cliCancel: call('cli:cancel'),
      claudeCodeStatus: call('claudecode:status'),
      mcpInfo: call('mcp:info'),
      setMcpEnabled: call('mcp:set-enabled'),
      addToAgent: call('mcp:add-to-agent'),
      automationInfo: call('automation:info'),
      // Tools from MCP servers the user adds (features/mcp-client.js)
      mcpServers: {
        list: call('mcp:servers'),
        save: call('mcp:server-save'),
        remove: call('mcp:server-remove'),
        setEnabled: call('mcp:server-enable'),
        refresh: call('mcp:server-refresh'),
        setAlwaysAllow: call('mcp:tool-always'),
      },
      setAutomation: call('automation:set'),
      importBrowsers: call('import:browsers'),
      importFrom: call('import:run'),
      onCliProgress: (cb) => ipcRenderer.on('cli:progress', (_e, text) => cb(text)),
    },
  });
}
