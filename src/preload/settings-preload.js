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
    pickProjectsDir: call('prefs:pick-projects-dir'), // [projects] Settings > AI > Projects folder
    pickWallpaper: call('prefs:pick-wallpaper'), // [look]
    removeWallpaper: call('prefs:remove-wallpaper'),
    wallpaperPreview: call('prefs:wallpaper-preview'), // [look] the picture as a small data: URL, for Settings' preview
    switchTiming: { count: call('prefs:switch-timing-count'), export: call('prefs:switch-timing-export'), clear: call('prefs:switch-timing-clear') }, // [diagnostics] Settings > Advanced
    tabSleep: { status: call('prefs:sleep-status'), unloadAll: call('prefs:sleep-unload-all'), currentSite: call('prefs:sleep-site'), reset: call('prefs:sleep-reset') }, // [tabs] Settings > Tabs > Page unloading
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
      gmailSignIn: call('prefs:widget-gmail-signin'),
      gmailAccounts: call('prefs:widget-gmail-accounts'),
      gmailParseClient: call('prefs:widget-gmail-parse-client'),
      onEdit: (cb) => ipcRenderer.on('widgets:edit', () => cb()), // a card's gear on the new-tab page while Settings is open
      onChanged: (cb) => ipcRenderer.on('widgets:changed', () => cb()), // a connection changed elsewhere (the card, Google)
      slackStart: call('prefs:slack-start'),
      slackCreateApp: call('prefs:slack-create-app'),
      slackPaste: call('prefs:slack-paste'),
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
    // [files] Privacy and security → Files (features/files.js)
    files: {
      list: call('settings:files-list'),
      pin: call('settings:files-pin'),
      unpin: call('settings:files-unpin'),
      remove: call('settings:files-remove'),
      clear: call('settings:files-clear'),
      open: call('settings:files-open'),
      show: call('settings:files-show'),
      find: call('settings:files-find'),
      relocate: call('settings:files-relocate'),
      search: call('settings:files-search'),
      attach: call('settings:files-attach'),
      scan: call('settings:files-scan'),
      restore: call('settings:files-restore'),
      onChanged: (cb) => ipcRenderer.on('settings:files-changed', () => cb()),
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
    deviceGrants: call('prefs:device-grants'),
    removeDeviceGrant: call('prefs:remove-device-grant'),
    // Translation → language packs on this device (features/translate-local.js)
    translatePacks: {
      list: call('prefs:translate-packs'),
      download: call('prefs:translate-pack-download'),
      cancel: call('prefs:translate-pack-cancel'),
      remove: call('prefs:translate-pack-delete'),
      removeAll: call('prefs:translate-pack-delete-all'),
      // returns a function that stops listening, so a rebuilt page doesn't pile up listeners
      onProgress: (cb) => { const fn = (_e, info) => cb(info); ipcRenderer.on('translate-packs:progress', fn); return () => ipcRenderer.removeListener('translate-packs:progress', fn); },
    },
    siteData: call('prefs:site-data'), // [site data] the sites with cookies
    clearSite: call('prefs:clear-site'),
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
    setUsageBudget: call('prefs:usage-budget'), // { unit, daily, weekly, engine? }: Grok's budget, or the named provider's
    cliInfo: call('prefs:cli-info'), // Settings → AI → AI providers: each CLI's version, path, sign-in and menu state
    // About → Updates (features/updates.js)
    updates: {
      state: call('settings:updates-state'),
      check: call('settings:updates-check'),
      apply: call('settings:updates-apply'),
    },
    // Skills (features/skills.js)
    routines: { state: call('settings:routines'), act: call('settings:routines-act') }, // [routines] Settings → AI → Routines (features/background-runner.js)
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
      importMdPick: call('skills:import-md-pick'), // a SKILL.md folder (features/skill-md.js)
      exportMd: call('skills:export-md'),
      claudeCode: call('skills:claude-code'),
      takeUpdate: call('skills:take-update'), // "Update the skill with what changed?": the diff to accept
      applyUpdate: call('skills:apply-update'),
      onUpdate: (cb) => ipcRenderer.on('skills:update', (_e, update) => cb(update)),
      onChanged: (cb) => ipcRenderer.on('skills:changed', (_e, list) => cb(list)),
    },
    // Macros (features/macros-runtime.js)
    macros: {
      list: call('macros:list'),
      save: call('macros:save'),
      remove: call('macros:delete'),
      validate: call('macros:validate'),
      checkShortcut: call('macros:shortcut-check'),
      run: call('macros:run'),
      stop: call('macros:stop'),
      resume: call('macros:resume'),
      recordStart: call('macros:record-start'),
      recordStop: call('macros:record-stop'),
      describe: call('macros:describe'),
      exportAll: call('macros:export'),
      importPick: call('macros:import-pick'),
      importText: call('macros:import-text'),
      importCommit: call('macros:import-commit'),
      takeDraft: call('macros:take-draft'),
      onDraft: (cb) => ipcRenderer.on('macros:draft', (_e, draft) => cb(draft)),
      onEdit: (cb) => ipcRenderer.on('macros:edit', (_e, id) => cb(id)),
      onChanged: (cb) => ipcRenderer.on('macros:changed', (_e, list) => cb(list)),
      onProgress: (cb) => ipcRenderer.on('macros:progress', (_e, e) => cb(e)),
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
      desktopApps: call('settings:desktop-apps'), // [desktop apps]
      removeDesktopApp: call('settings:remove-desktop-app'),
      clearDesktopApps: call('settings:clear-desktop-apps'),
      aiGaps: call('settings:ai-gaps'), // [no handoff]
      clearAiGaps: call('settings:clear-ai-gaps'),
      sharedFiles: call('settings:shared-files'), // [screen context]
      removeSharedFile: call('settings:remove-shared-file'),
      clearSharedFiles: call('settings:clear-shared-files'),
      setSearchEngine: call('settings:set-search-engine'),
      cliStatus: call('cli:status'),
      cliLogin: call('cli:login'),
      cliLogout: call('cli:logout'),
      cliCancel: call('cli:cancel'),
      claudeCodeStatus: call('claudecode:status'),
      codexStatus: call('codex:status'), // Settings → AI → Connect: Codex CLI found? signed in? connected?
      codexLocate: call('codex:locate'), // "Locate codex…" (a file picker; true forgets the saved path)
      antigravityStatus: call('antigravity:status'), // Settings → AI → CLI agents: found? the install command
      antigravityInstall: call('antigravity:install'), // runs Google's installer, only from the click that follows seeing it
      useAntigravity: call('settings:use-antigravity'),
      mcpInfo: call('mcp:info'),
      setMcpEnabled: call('mcp:set-enabled'),
      addToAgent: call('mcp:add-to-agent'),
      // Let other apps use Lumen (features/external-apps.js): their tokens, the switch and the setup text
      externalApps: {
        info: call('mcp:external-info'),
        enable: call('mcp:external-enable'),
        setRequireToken: call('mcp:external-require-token'),
        setup: call('mcp:external-setup'),
        add: call('mcp:external-add'),
        revoke: call('mcp:external-revoke'),
        setAsk: call('mcp:external-ask'),
        openConfig: call('mcp:external-open-config'),
      },
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
      // Connectors: services the AI can use once connected (features/connectors/). Tokens go in, never come back.
      connectors: {
        list: call('connectors:list'),
        detect: call('connectors:detect'),
        connect: call('connectors:connect'),
        disconnect: call('connectors:disconnect'),
        signIn: call('connectors:sign-in'),
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
