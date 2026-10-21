// ESLint flat config. Run with `npm run lint`.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  // src/preload/preload.bundle.js is generated from preload.js (scripts/build/bundle-preload.js); lint the source.
  { ignores: ['node_modules/**', 'dist/**', 'out/**', '.claude/**', 'src/preload/preload.bundle.js', 'src/renderer/ui.bundle.js', 'src/vendor/**', 'src/renderer/vendor/**', '_site/**'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-useless-assignment': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off', // stripping ANSI escapes from CLI output is deliberate
      'preserve-caught-error': 'off', // some errors are rethrown as a plain message for the user
    },
  },
  // Preloads run with Node's require but inside a page.
  { files: ['**/*preload.js'], languageOptions: { globals: { ...globals.browser } } },
  // The GitHub Pages site (site/, built by scripts/build/build-site.js): plain browser scripts; marked and DOMPurify come from cdnjs.
  { files: ['site/**/*.js'], languageOptions: { sourceType: 'script', globals: { ...globals.browser, marked: 'readonly', DOMPurify: 'readonly' } } },
  // Renderer pages load plain <script> files that share one global scope.
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
    rules: {
      'no-unused-vars': ['warn', { vars: 'local', args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-redeclare': ['error', { builtinGlobals: false }],
    },
  },
  // The PDF viewer page is an ES module (pdf.js is) with top-level await.
  { files: ['src/renderer/pdfviewer.js'], languageOptions: { sourceType: 'module', globals: { ...globals.browser } } },
  // settings-updates.js is loaded after settings.js and uses its helpers, and the other way round.
  { files: ['src/renderer/settings-updates.js'], languageOptions: { globals: { S: 'readonly', h: 'readonly', row: 'readonly', toggle: 'readonly', visibleNow: 'readonly' } } },
  { files: ['src/renderer/settings.js'], languageOptions: { globals: { buildUnloading: 'readonly', buildUpdates: 'readonly', buildMcpServers: 'readonly', buildConnectors: 'readonly', buildExternalApps: 'readonly', buildFocus: 'readonly', buildSkills: 'readonly', buildMacros: 'readonly', buildRoutines: 'readonly', buildProviders: 'readonly', buildSync: 'readonly', providerUsageRows: 'readonly' } } },
  // settings-sync.js is loaded before settings.js and uses its helpers (called later, from its builder).
  { files: ['src/renderer/settings-sync.js'], languageOptions: { globals: { S: 'readonly', h: 'readonly', tr: 'readonly', row: 'readonly', status: 'readonly', flash: 'readonly', armedButton: 'readonly', withKeywords: 'readonly' } } },
  // settings-skills.js is loaded before settings.js and uses its helpers.
  { files: ['src/renderer/settings-skills.js'], languageOptions: { globals: { h: 'readonly', row: 'readonly', flash: 'readonly', tr: 'readonly', toggle: 'readonly' } } },
  // settings-routines.js is loaded before settings.js and uses its helpers (called later, from its builder).
  { files: ['src/renderer/settings-routines.js'], languageOptions: { globals: { h: 'readonly', row: 'readonly', stackRow: 'readonly', armedButton: 'readonly', flash: 'readonly', tr: 'readonly' } } },
  // settings-macros.js is loaded before settings.js and uses its helpers (called later, from its builder).
  { files: ['src/renderer/settings-macros.js'], languageOptions: { globals: { h: 'readonly', row: 'readonly', flash: 'readonly', tr: 'readonly' } } },
  // settings-providers.js is loaded before settings.js and uses its helpers (called later, from its builders).
  { files: ['src/renderer/settings-providers.js'], languageOptions: { globals: { S: 'readonly', h: 'readonly', row: 'readonly', stackRow: 'readonly', toggle: 'readonly', meterRow: 'readonly', flash: 'readonly', tokens: 'readonly', dollars: 'readonly', tr: 'readonly', save: 'readonly', st: 'readonly', usageChip: 'readonly', syncCliAccess: 'readonly', ENGINE_NAMES: 'readonly', grokUsageRows: 'readonly', codexUsageRows: 'readonly' } } },
  // settings-unload.js is loaded before settings.js and uses its helpers (called later, from its builder).
  { files: ['src/renderer/settings-unload.js'], languageOptions: { globals: { S: 'readonly', st: 'readonly', h: 'readonly', tr: 'readonly', save: 'readonly', row: 'readonly', stackRow: 'readonly', toggle: 'readonly', select: 'readonly', flash: 'readonly', withKeywords: 'readonly', applyPageClasses: 'readonly' } } },
  // settings-mcp-servers.js is loaded after settings.js and uses its helpers.
  // settings-focus.js (Settings → General → Focus mode): loaded before settings.js; it also assigns the page's `st` after a change.
  { files: ['src/renderer/settings-focus.js'], languageOptions: { globals: { h: 'readonly', tr: 'readonly', row: 'readonly', stackRow: 'readonly', flash: 'readonly', withKeywords: 'readonly', S: 'readonly', st: 'writable' } } },
  { files: ['src/renderer/settings-external-apps.js'], languageOptions: { globals: { h: 'readonly', tr: 'readonly', row: 'readonly', stackRow: 'readonly', flash: 'readonly', armedButton: 'readonly', $: 'readonly' } } },
  { files: ['src/renderer/settings-mcp-servers.js', 'src/renderer/settings-connectors.js'], languageOptions: { globals: { h: 'readonly', flash: 'readonly', stackRow: 'readonly' } } },
  // newtab-widgets.js draws favicon tiles with newtab.js's tile() (loaded after it, called later).
  { files: ['src/renderer/newtab-widgets.js'], languageOptions: { globals: { tile: 'readonly' } } },
  // i18n.js (window.t) and tab-search.js (the speaker button) run before app.js and are used by it.
  // The chat itself (chat-core.js) is loaded before app.js, which uses it (and sets its chatHost hooks).
  { files: ['src/renderer/app.js'], languageOptions: { globals: { unknownLabel: 'readonly', t: 'readonly', updateTabAudio: 'readonly', $: 'readonly', ask: 'readonly', askInNewChat: 'readonly', askInFreshChat: 'readonly', addFiles: 'readonly', chatHost: 'readonly', startChat: 'readonly', TOOL_LABELS: 'readonly', append: 'readonly', showApproval: 'readonly', approvals: 'readonly', resolveApproval: 'readonly', running: 'readonly' } } },
  { files: ['src/renderer/chat-core.js'], languageOptions: { globals: { t: 'readonly' } } },
  // chat-page.js (the full-page chat) is loaded after chat-core.js and uses its helpers; chat-items.js and chat-extras.js use t.
  { files: ['src/renderer/chat-page.js'], languageOptions: { globals: { t: 'readonly', $: 'readonly', chatHost: 'readonly', clearChatView: 'readonly', showHistory: 'readonly', loadModels: 'readonly', refreshSetup: 'readonly', startChat: 'readonly', askInNewChat: 'readonly', addFiles: 'readonly', beginTurn: 'readonly', resumeLive: 'readonly', turn: 'readonly', runId: 'writable', shownChatId: 'writable', running: 'readonly' } } },
  // chat-page-tools.js (the page's extras) uses the conversation's globals when something happens.
  { files: ['src/renderer/chat-page-tools.js'], languageOptions: { globals: { running: 'readonly', clearChatView: 'readonly', shownChatId: 'writable', loadModels: 'readonly', askAgain: 'readonly', messages: 'readonly', prompt: 'readonly', lastAsk: 'writable', attachments: 'writable', MAX_ATTACH: 'readonly', renderAttachments: 'readonly', autosize: 'readonly', updateSend: 'readonly' } } },
  // chat-commands.js (the chat's "/" commands) opens chat-core.js's model picker.
  { files: ['src/renderer/chat-commands.js'], languageOptions: { globals: { modelPicker: 'readonly' } } },
  // chat-actions.js (message actions, versions, thumbs) is loaded after chat-core.js and uses its helpers when something is clicked.
  { files: ['src/renderer/chat-actions.js'], languageOptions: { globals: { t: 'readonly', messages: 'readonly', running: 'readonly', applySync: 'readonly', askOf: 'readonly', editBubble: 'readonly', TOOL_LABELS: 'readonly' } } },
  // tabs-ask.js ("@" tabs in the composer) is loaded after chat-core.js and uses t and updateSend.
  { files: ['src/renderer/tabs-ask.js'], languageOptions: { globals: { t: 'readonly', updateSend: 'readonly' } } },
  // chats.js is loaded after app.js and uses its helpers.
  { files: ['src/renderer/chats.js'], languageOptions: { globals: { $: 'readonly', clearChatView: 'readonly', showHistory: 'readonly', resumeLive: 'readonly', shownChatId: 'writable' } } },
  // tab-search-match.js and app.js are loaded before tab-search.js and are used by it.
  { files: ['src/renderer/tab-search.js'], languageOptions: { globals: { tabSearchMatch: 'readonly', freezePage: 'readonly', thawPage: 'readonly' } } },
  // side-tabs.js (Tab layout: Side) is loaded after app.js and works on its tab list: the same globals, and it sets two of them.
  { files: ['src/renderer/side-tabs.js'], languageOptions: { globals: { $: 'readonly', t: 'readonly', drag: 'readonly', lastTabState: 'readonly', selectedTabs: 'readonly', hideHoverCard: 'readonly', stripOrder: 'readonly', handOffTabDrag: 'readonly', indexBefore: 'readonly', expectMove: 'readonly', renderTabsNow: 'readonly', setSidebarWidth: 'readonly', sidebarWish: 'readonly', tabsRendered: 'writable', lastLayoutSig: 'writable' } } },
  // files-picker.js is loaded after app.js (the same still picture of the page tab search uses).
  { files: ['src/renderer/files-picker.js'], languageOptions: { globals: { freezePage: 'readonly', thawPage: 'readonly' } } },
  { files: ['src/renderer/command-bar.js'], languageOptions: { globals: { freezePage: 'readonly', thawPage: 'readonly', lastTabState: 'readonly' } } }, // (app.js's, loaded on first use)
  { files: ['test/command-bar.js'], languageOptions: { globals: { lastTabState: 'readonly' } } }, // (read inside ui.evaluate: the browser UI's global)
  // Main-process code that builds page scripts, and tests that pass functions to page.evaluate.
  {
    files: ['src/ai/page-scripts.js', 'src/ai/snapshot.js', 'src/ai/agent.js', 'test/**/*.js', 'scripts/measure/capture-media.js', 'scripts/measure/measure-newtab.js'],
    languageOptions: { globals: { ...globals.browser } },
    rules: { 'require-yield': 'off' },
  },
  // Functions the tests call inside the UI page (defined by renderer/app.js).
  { files: ['test/exfil.js', 'test/mcp.js', 'test/mcpclient.js', 'test/connectors.js', 'test/aicontrols.js'], languageOptions: { globals: { approvals: 'readonly', showApproval: 'readonly', showSidebar: 'readonly', resolveApproval: 'readonly', ask: 'readonly' } } },
  // The model picker the sidebar page creates (renderer/chat-core.js), opened from page.evaluate.
  { files: ['test/models.js', 'test/usage.js'], languageOptions: { globals: { modelPicker: 'readonly' } } },
  { files: ['test/fixtures/**/*.js'], languageOptions: { sourceType: 'script', globals: { ...globals.browser, ...globals.webextensions } } },
];
