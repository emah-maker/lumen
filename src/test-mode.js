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

// An extension test sets LUMEN_TEST_WEBSTORE_ORIGIN=http://127.0.0.1:<port>: the extension library's download from Google's update
// address goes to that stand-in server, and the main process refuses every other non-loopback fetch, so the test never reaches the
// real network. Called at startup, before electron-chrome-web-store loads (it keeps the global fetch it finds). Nothing happens
// without the variable, so other tests are untouched.
function standInWebStore() {
  const origin = process.env.LUMEN_TEST_WEBSTORE_ORIGIN;
  if (!origin) return;
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('LUMEN_TEST_WEBSTORE_ORIGIN must be http://127.0.0.1:<port>');
  const realFetch = globalThis.fetch;
  const STORE = 'https://clients2.google.com/service/update2/crx';
  globalThis.fetch = (input, init) => {
    const url = String(input?.url || input);
    if (url.startsWith(STORE)) return realFetch(origin + '/crx' + url.slice(STORE.length), init);
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return Promise.reject(new TypeError(`test mode: no network (${url.slice(0, 60)})`));
    return realFetch(input, init);
  };
}

module.exports = { isTest, isPackaged, PRELOAD_FLAG, standInWebStore };
