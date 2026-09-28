// Test mode (CLAUDE_BROWSER_TEST): the tests' switches — AI auto-approve, a throwaway profile
// (CLAUDE_BROWSER_PROFILE), the global.__* hooks, synthetic IPC events. Only a development run
// (`electron .`) honours it; a packaged Lumen ignores the variable, so an inherited or planted
// environment can't turn any of that on for a real user.
const path = require('path');

// Packaged means "not the stock electron binary", the same rule Electron's app.isPackaged uses. The
// main process asks `app` itself; the MCP bridge (Node mode) has no `app` and uses the rule directly.
// (Node mode never requires 'electron': that would resolve through node_modules folders up the tree.)
function isPackaged() {
  if (process.type === 'browser') return require('electron').app.isPackaged;
  const exe = path.basename(process.execPath).toLowerCase();
  return process.platform === 'win32' ? exe !== 'electron.exe' : exe !== 'electron';
}

const isTest = () => !isPackaged() && Boolean(process.env.CLAUDE_BROWSER_TEST);

// The UI preload has no `app`; main passes it this switch (webPreferences.additionalArguments).
const PRELOAD_FLAG = '--lumen-test-mode';

module.exports = { isTest, isPackaged, PRELOAD_FLAG };
