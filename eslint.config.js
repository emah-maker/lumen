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
  { files: ['renderer/settings-updates.js'], languageOptions: { globals: { S: 'readonly', h: 'readonly', row: 'readonly', toggle: 'readonly', current: 'readonly' } } },
  { files: ['renderer/settings.js'], languageOptions: { globals: { buildUpdates: 'readonly', buildMcpServers: 'readonly' } } },
  // settings-mcp-servers.js is loaded after settings.js and uses its helpers.
  { files: ['renderer/settings-mcp-servers.js'], languageOptions: { globals: { h: 'readonly', flash: 'readonly', stackRow: 'readonly' } } },
  // i18n.js (window.t) and tab-search.js (the speaker button) run before app.js and are used by it.
  { files: ['renderer/app.js'], languageOptions: { globals: { t: 'readonly', updateTabAudio: 'readonly' } } },
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
