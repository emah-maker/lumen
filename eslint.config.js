// ESLint flat config. Run with `npm run lint`.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  // preload.bundle.js is generated from preload.js (scripts/bundle-preload.js); lint the source.
  { ignores: ['node_modules/**', 'dist/**', 'out/**', '.claude/**', 'preload.bundle.js', 'vendor/**'] },
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
  // Renderer pages load plain <script> files that share one global scope.
  {
    files: ['renderer/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
    rules: {
      'no-unused-vars': ['warn', { vars: 'local', args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-redeclare': ['error', { builtinGlobals: false }],
    },
  },
  // settings-updates.js is loaded after settings.js and uses its helpers, and the other way round.
  { files: ['renderer/settings-updates.js'], languageOptions: { globals: { S: 'readonly', h: 'readonly', row: 'readonly', toggle: 'readonly', visibleNow: 'readonly' } } },
  { files: ['renderer/settings.js'], languageOptions: { globals: { buildUpdates: 'readonly', buildMcpServers: 'readonly', buildSkills: 'readonly' } } },
  // settings-skills.js is loaded before settings.js and uses its helpers.
  { files: ['renderer/settings-skills.js'], languageOptions: { globals: { h: 'readonly', row: 'readonly', flash: 'readonly', tr: 'readonly' } } },
  // settings-mcp-servers.js is loaded after settings.js and uses its helpers.
  { files: ['renderer/settings-mcp-servers.js'], languageOptions: { globals: { h: 'readonly', flash: 'readonly', stackRow: 'readonly' } } },
  // newtab-widgets.js draws favicon tiles with newtab.js's tile() (loaded after it, called later).
  { files: ['renderer/newtab-widgets.js'], languageOptions: { globals: { tile: 'readonly' } } },
  // i18n.js (window.t) and tab-search.js (the speaker button) run before app.js and are used by it.
  // The chat itself (chat-core.js) is loaded before app.js, which uses it (and sets its chatHost hooks).
  { files: ['renderer/app.js'], languageOptions: { globals: { t: 'readonly', updateTabAudio: 'readonly', $: 'readonly', ask: 'readonly', askInNewChat: 'readonly', addImages: 'readonly', chatHost: 'readonly', startChat: 'readonly', TOOL_LABELS: 'readonly', append: 'readonly', showApproval: 'readonly', approvals: 'readonly', resolveApproval: 'readonly', running: 'readonly' } } },
  { files: ['renderer/chat-core.js'], languageOptions: { globals: { t: 'readonly' } } },
  // chat-page.js (the full-page chat) is loaded after chat-core.js and uses its helpers; chat-items.js and chat-extras.js use t.
  { files: ['renderer/chat-page.js'], languageOptions: { globals: { t: 'readonly', $: 'readonly', chatHost: 'readonly', clearChatView: 'readonly', showHistory: 'readonly', loadModels: 'readonly', refreshSetup: 'readonly', startChat: 'readonly', beginTurn: 'readonly', turn: 'readonly', runId: 'writable' } } },
  // tabs-ask.js ("@" tabs in the composer) is loaded after chat-core.js and uses t and updateSend.
  { files: ['renderer/tabs-ask.js'], languageOptions: { globals: { t: 'readonly', updateSend: 'readonly' } } },
  // chats.js is loaded after app.js and uses its helpers.
  { files: ['renderer/chats.js'], languageOptions: { globals: { $: 'readonly', clearChatView: 'readonly', showHistory: 'readonly' } } },
  // tab-search-match.js and app.js are loaded before tab-search.js and are used by it.
  { files: ['renderer/tab-search.js'], languageOptions: { globals: { tabSearchMatch: 'readonly', freezePage: 'readonly', thawPage: 'readonly' } } },
  // Main-process code that builds page scripts, and tests that pass functions to page.evaluate.
  {
    files: ['page-scripts.js', 'snapshot.js', 'agent.js', 'test/**/*.js', 'scripts/capture-media.js'],
    languageOptions: { globals: { ...globals.browser } },
    rules: { 'require-yield': 'off' },
  },
  // Functions the tests call inside the UI page (defined by renderer/app.js).
  { files: ['test/exfil.js', 'test/mcp.js', 'test/mcpclient.js', 'test/aicontrols.js'], languageOptions: { globals: { approvals: 'readonly', showApproval: 'readonly', showSidebar: 'readonly', resolveApproval: 'readonly', ask: 'readonly' } } },
  { files: ['test/fixtures/**/*.js'], languageOptions: { sourceType: 'script', globals: { ...globals.browser, ...globals.webextensions } } },
];
