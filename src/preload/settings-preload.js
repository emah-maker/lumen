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
      projects: call('prefs:widget-projects'),
      tvLists: call('prefs:widget-tv-lists'),
      gmailConnect: call('prefs:widget-gmail-connect'),
      gmailCancel: call('prefs:widget-gmail-cancel'),
      gmailDisconnect: call('prefs:widget-gmail-disconnect'),
      onChanged: (cb) => ipcRenderer.on('widgets:changed', () => cb()), // a connection changed elsewhere (the card, Google)
      slackStart: call('prefs:slack-start'),
      slackFinish: call('prefs:slack-finish'),
      slackCancel: call('prefs:slack-cancel'),
      slackDisconnect: call('prefs:slack-disconnect'),
      slackChannels: call('prefs:slack-channels'),
      search: call('prefs:widget-search'),
      help: call('prefs:widget-help'), // opens a fixed "where do I get this" page by name
      savedPlaces: call('prefs:widget-saved-places'),
      location: call('prefs:widget-location'),
      resetLayout: call('prefs:widget-reset-layout'),
      spotifySignIn: call('spotify:sign-in'), // OAuth PKCE in a tab (main.js); the Client ID goes in, tokens never come out
      spotifyCancel: call('spotify:cancel'),
      spotifyDisconnect: call('spotify:disconnect'),
    },
    // [passwords] Privacy and security → Passwords (features/passwords.js). No password comes out
    // except through reveal, which asks for Touch ID (or a confirmation) first.
    passwords: {
      state: call('settings:passwords-state'),
      setEnabled: call('settings:passwords-set-enabled'),
      list: call('settings:passwords-list'),
      reveal: call('settings:passwords-reveal'),
      copy: call('settings:passwords-copy'),
      update: call('settings:passwords-update'),
      remove: call('settings:passwords-delete'),
      removeAll: call('settings:passwords-delete-all'),
      importCsv: call('settings:passwords-import'),
      removeNever: call('settings:passwords-never-remove'),
    },
    sitePermissions: call('prefs:site-permissions'),
    revokePermission: call('prefs:revoke-permission'),
    // Translation → language packs on this device (features/translate-local.js)
    translatePacks: {
      list: call('prefs:translate-packs'),
      download: call('prefs:translate-pack-download'),
      cancel: call('prefs:translate-pack-cancel'),
      remove: call('prefs:translate-pack-delete'),
      removeAll: call('prefs:translate-pack-delete-all'),
      onProgress: (cb) => ipcRenderer.on('translate-packs:progress', (_e, info) => cb(info)),
    },
    extensions: call('prefs:extensions'),
    removeExtension: call('prefs:remove-extension'),
    extensionOptions: call('prefs:extension-options'),
    openUrl: call('prefs:open-url'),
    reset: call('prefs:reset'),
    relaunch: call('prefs:relaunch'),
    about: call('prefs:about'),
    whatsNew: call('prefs:whats-new'), // features/whats-new.js: the release notes over the window
    taskManager: call('prefs:task-manager'),
    restartTab: call('prefs:restart-tab'),
    internals: call('prefs:internals'),
    strings: call('settings:strings'), // the page's text in the system's language (features/i18n.js)
    // You and AI → Usage (features/usage.js)
    usage: call('prefs:usage'),
    clearUsage: call('prefs:clear-usage'),
    setUsageBudget: call('prefs:usage-budget'),
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
      onModelsUpdated: (cb) => ipcRenderer.on('models-updated', () => cb()), // the model was changed elsewhere (the sidebar)
      setKey: call('settings:set-key'),
      setProviderKey: call('settings:set-provider-key'),
      safeBrowsing: call('settings:safe-browsing'),
      setSafeBrowsingKey: call('settings:set-safe-browsing-key'),
      openRouterSignIn: call('openrouter:sign-in'),
      cancelOpenRouterSignIn: call('openrouter:cancel'),
      setModel: call('settings:set-model'),
      openRouterModels: call('openrouter:models'), // OpenRouter's whole catalog, for "More models…"
      setAdhdMode: call('settings:set-adhd'),
      setAutoGroup: call('settings:set-auto-group'),
      setTabGrouping: call('settings:set-tab-grouping'),
      setTopicAi: call('settings:set-topic-ai'),
      setOrganizeIdle: call('settings:set-organize-idle'),
      forgetOrganizeLearning: call('settings:forget-organize-learning'),
      aiSites: call('settings:ai-sites'), // [ai controls]
      setAiSite: call('settings:set-ai-site'),
      signedInSites: call('settings:signed-in-sites'), // [signed-in sites]
      removeSignedInSite: call('settings:remove-signed-in-site'),
      clearSignedInSites: call('settings:clear-signed-in-sites'),
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
      importQuiet: call('import:quiet'), // the result back to the page, no dialog
      isDefaultBrowser: call('settings:default-browser'),
      makeDefaultBrowser: call('settings:make-default'),
      onCliProgress: (cb) => ipcRenderer.on('cli:progress', (_e, text) => cb(text)),
    },
  });
}
