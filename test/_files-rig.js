// Shared set-up for the Files suites (files-widget.js, files-picker.js, files-perf.js): a throwaway profile whose new-tab page has a Files
// card, a folder of test files under the temp folder, and a hidden Lumen (CLAUDE_BROWSER_TEST, LUMEN_TEST_BACKGROUND: no window is shown or
// takes focus). No network but 127.0.0.1, and nothing outside the temp folders is read or written.
'use strict';
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIDGET_ID = 'wfiles001';

function makeChecker() {
  const state = { failures: 0 };
  const check = (name, ok, detail) => { if (!ok) state.failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  return { state, check };
}
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    v = await Promise.resolve().then(fn).catch(() => false);
    if (v) return v;
    await sleep(100);
  }
  return v;
}

// opts.widget: the Files card's cells ({ w, h }), false for a page without it.
async function start({ widget = { w: 4, h: 7 }, tag = 'files' } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `claude-browser-test-${tag}-`));
  const settings = widget ? { homeWidgets: [{ id: WIDGET_ID, type: 'files', x: 0, y: 0, w: widget.w, h: widget.h }] } : {};
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(settings));
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), `lumen-${tag}-tree-`));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' };
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  const rig = {
    app, ui, tree, profile, errors, WIDGET_ID,
    file: (rel, text = 'x') => { const p = path.join(tree, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; },
    // The new-tab page (a fresh tab, kept as global.__homeTab) and script run inside it.
    async homeTab() {
      await app.evaluate(async () => {
        const t = global.__agent.browser.openTab();
        await new Promise((r) => t.webContents.once('did-finish-load', r));
        global.__homeTab = t;
      });
    },
    inTab: (js) => app.evaluate((_e, code) => global.__homeTab.webContents.executeJavaScript(code), js),
    tabs: () => app.evaluate(() => global.__agent.browser.listTabs()),
    // A file in a tab, as File > Open does: the tab is how a "recent" file gets recorded.
    openFileTab: (p) => app.evaluate(async (_e, p) => {
      const { pathToFileURL } = require('url');
      const t = global.__agent.browser.openTab(pathToFileURL(p).href);
      await new Promise((r) => t.webContents.once('did-finish-load', r));
    }, p),
    // The UI's own bridge (window.lumenFiles, preload.js): what the picker uses.
    files: (call, ...args) => ui.evaluate(([c, a]) => window.lumenFiles[c](...a), [call, args]),
    key: (where, keyCode, modifiers) => app.evaluate(({ BrowserWindow }, [where, keyCode, modifiers]) => {
      const wc = where === 'ui' ? BrowserWindow.fromId(global.__windows.list()[0].windowId).webContents : global.__agent.browser.activeTab().webContents;
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    }, [where, keyCode, modifiers]),
    async stop() {
      await app.close().catch(() => {});
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch { /* the temp profile may linger */ }
      try { fs.rmSync(tree, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch { /* ditto */ }
    },
  };
  return rig;
}
module.exports = { start, sleep, waitFor, makeChecker, WIDGET_ID };
