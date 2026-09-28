// ESLint flat config. Run with `npm run lint`.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'out/**', '.claude/**'] },
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
  { files: ['renderer/settings.js'], languageOptions: { globals: { buildUpdates: 'readonly' } } },
  // Main-process code that builds page scripts, and tests that pass functions to page.evaluate.
  {
    files: ['page-scripts.js', 'snapshot.js', 'agent.js', 'test/**/*.js', 'scripts/capture-media.js'],
    languageOptions: { globals: { ...globals.browser } },
    rules: { 'require-yield': 'off' },
  },
  // Functions the tests call inside the UI page (defined by renderer/app.js).
  { files: ['test/exfil.js', 'test/mcp.js'], languageOptions: { globals: { approvals: 'readonly', showApproval: 'readonly', showSidebar: 'readonly', resolveApproval: 'readonly' } } },
  { files: ['test/fixtures/**/*.js'], languageOptions: { sourceType: 'script', globals: { ...globals.browser, ...globals.webextensions } } },
];
