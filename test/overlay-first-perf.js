// The first overlay costs no more than the second. Time from the request to the second frame the overlay's own page runs once it is on
// screen (so the page is loaded, laid out and drawn), for the address bar's dropdown and the downloads panel, the first time and the next,
// in a hidden window with a throwaway profile. The panel's page used to start only on the first click (about 150 ms against 33 ms for the
// next); the pointer reaching the button now loads it ahead (main.js warmDownloadsPanel), and a window that never gets that far has no panel.
'use strict';
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Measured on this machine, hidden: dropdown first 30-42 ms and next 15-20; panel with the button reached first 31-36 and next 31-36 (cold: 130-150).
const FIRST_CEILING_MS = 60;
const SECOND_CEILING_MS = 50;

let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`); };

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-overlay-first-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), '{}');
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' };
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await sleep(6000); // the window's start-up work is over
    const suggest = async () => {
      const t0 = Date.now();
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.fromId(global.__windows.list()[0].windowId);
        const v = w.contentView.children.find((c) => c.webContents && /suggest\.html/.test(c.webContents.getURL()));
        global.__ovlP = v.webContents.executeJavaScript(`new Promise((res) => { window.__ovlRes = res; if (!window.__ovlInst) { window.__ovlInst = 1; window.suggest.onItems(() => requestAnimationFrame(() => requestAnimationFrame(() => window.__ovlRes(Date.now())))); } })`);
      });
      await ui.evaluate(() => window.browser.showSuggestions({ x: 100, y: 60, width: 600, height: 200 }, { items: [{ kind: 'search', title: 'abc', detail: 'x' }, { kind: 'history', title: 'def', detail: 'y' }], selected: 0, listId: 1 }));
      const t1 = await app.evaluate(() => global.__ovlP);
      await ui.evaluate(() => window.browser.hideSuggestions());
      await sleep(600);
      return t1 - t0;
    };
    const panel = async () => {
      const t0 = Date.now();
      const t1 = await app.evaluate(() => {
        global.__downloads.show({ right: 900, bottom: 80 });
        return global.__downloads.panel().executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(Date.now()))))');
      });
      await app.evaluate(() => global.__downloads.hide());
      await sleep(600);
      return t1 - t0;
    };

    const s1 = await suggest();
    const s2 = await suggest();
    check(`the dropdown's first show takes under ${FIRST_CEILING_MS} ms (${s1} ms; the next ${s2} ms)`, s1 < FIRST_CEILING_MS, `${s1} ms`);
    check(`the dropdown's next show takes under ${SECOND_CEILING_MS} ms`, s2 < SECOND_CEILING_MS, `${s2} ms`);

    check('a window with no downloads button reached has no downloads panel', await app.evaluate(() => !global.__downloads.panel()), '');
    const focusBefore = await ui.evaluate(() => document.activeElement.id);
    await ui.evaluate(() => window.browser.warmDownloads());
    await sleep(1500);
    check('the pointer reaching the button loads the panel ahead of the click', await app.evaluate(() => Boolean(global.__downloads.panel())), '');
    check('loading it does not move the focus out of the address bar', (await ui.evaluate(() => document.activeElement.id)) === focusBefore && (await ui.evaluate(() => document.hasFocus())), focusBefore);
    check('the loaded panel is not on screen', await app.evaluate(() => !global.__downloads.visible()), '');
    const p1 = await panel();
    const p2 = await panel();
    check(`the panel's first show takes under ${FIRST_CEILING_MS} ms (${p1} ms; the next ${p2} ms)`, p1 < FIRST_CEILING_MS, `${p1} ms`);
    check(`the panel's next show takes under ${SECOND_CEILING_MS} ms`, p2 < SECOND_CEILING_MS, `${p2} ms`);
    console.log(`      dropdown ${s1} / ${s2} ms, panel ${p1} / ${p2} ms (first / next)`);
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch { /* the temp profile may linger */ }
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FAIL  ' + e.message); process.exit(1); });
