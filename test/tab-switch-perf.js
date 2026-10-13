// Switching tabs stays fast on a long-lived profile (about 30 tabs, each with a chat of its own, the sidebar open, a PDF, a playing video,
// a page with timers, a heavy page, pinned tabs and groups; the home widgets on), hidden (LUMEN_TEST_BACKGROUND, a fresh profile, a private TEMP).
// The ceilings sit well above what this measures (scripts/measure-tab-switch.js prints the detail), so machine noise does not fail the run, but
// a switch that writes the chat and its index to disk, draws a whole long chat at once, or polls something does.
//   - median and p95 switch latency (click and Ctrl+Tab), in main and in the UI;
//   - the main process's event loop is never held up for long during 20 switches (the 8 ms interval method of test/perf-budget.js);
//   - no UI long task over 100 ms;
//   - switching to a tab whose chat is unchanged writes nothing to the chats folder (it used to write the chat and its index, twice, every time);
//   - a long chat is drawn newest first and is whole a moment later, and a chat handed to a closed sidebar is drawn when it opens;
//   - the unloading status poll does nothing while Settings is closed.
require('./_tmp-cleanup');
const rig = require('./_tab-switch-rig');

const CEIL = {
  clickStripMed: 150, clickStripP95: 400, clickSettledP95: 600, // the UI shows the tab / has finished the switch (ms)
  keyStripMed: 150, keyStripP95: 400,
  syncMed: 50, syncP95: 150, // main's own work for one click
  lagMax: 100, longMax: 100,
};

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  const sleep = rig.sleep;
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(80); } return v; };
  const hard = setTimeout(() => { console.error('hard timeout'); process.exit(2); }, 9 * 60 * 1000);
  const fmt = (s) => `${s.med}/${s.p95}/${s.max}`;

  const r = await rig.launchRig({ tabs: 30, chats: 20, chatKb: 8, sidebar: true });
  const { app, ui } = r;
  try {
    check('about 30 tabs are open, with pinned tabs and groups', r.ids.length >= 30 && (await ui.evaluate(() => document.querySelectorAll('#tabs .tab').length)) >= 30 && (await ui.evaluate(() => document.querySelectorAll('#tabs .group-label').length)) >= 2, `${r.ids.length}`);

    // ---- what a switch writes to disk: install the counter, then 20 switches by click
    await app.evaluate(() => {
      const fs = process.mainModule.require('fs');
      const w = (global.__chatWrites = { n: 0, files: [] });
      for (const name of ['writeFileSync', 'renameSync']) {
        const orig = fs[name];
        fs[name] = function (...args) { const f = String(args[name === 'renameSync' ? 1 : 0]); if (/[\\/]chats[\\/]/.test(f)) { w.n++; w.files.push(f.split(/[\\/]/).pop()); } return orig.apply(this, args); };
      }
    });
    const clicks = await rig.measureSwitches(r, { n: 20, how: 'click' });
    const c = clicks.summary;
    console.log(`click: ${['shown', 'sync', 'strip', 'settled', 'lag', 'long'].map((k) => `${k} ${fmt(c[k])}`).join('  ')}  frameMax ${Math.round(clicks.frameMax)}`);
    check('every click changed the tab', c.bad === 0, `${c.bad}`);
    check(`click: the strip shows the new tab within ${CEIL.clickStripMed} ms (median) and ${CEIL.clickStripP95} ms (p95)`, c.strip.med <= CEIL.clickStripMed && c.strip.p95 <= CEIL.clickStripP95, fmt(c.strip));
    check(`click: the UI has finished the switch within ${CEIL.clickSettledP95} ms (p95)`, c.settled.p95 <= CEIL.clickSettledP95, fmt(c.settled));
    check(`click: main's own work is ${CEIL.syncMed} ms (median) and ${CEIL.syncP95} ms (p95) at most`, c.sync.med <= CEIL.syncMed && c.sync.p95 <= CEIL.syncP95, fmt(c.sync));
    check(`click: the main process's event loop is never held up over ${CEIL.lagMax} ms`, c.lag.max <= CEIL.lagMax, fmt(c.lag));
    check(`click: no UI long task over ${CEIL.longMax} ms`, c.long.max <= CEIL.longMax, fmt(c.long));
    const writes = await app.evaluate(() => global.__chatWrites);
    check('20 switches between tabs with unchanged chats write at most two files in the chats folder', writes.n <= 4, `${writes.n}: ${writes.files.join(',')}`);

    const keys = await rig.measureSwitches(r, { n: 20, how: 'key' });
    const k = keys.summary;
    console.log(`key:   ${['shown', 'strip', 'settled', 'lag', 'long'].map((x) => `${x} ${fmt(k[x])}`).join('  ')}  frameMax ${Math.round(keys.frameMax)}`);
    check('Ctrl+Tab changed the tab every time', k.bad === 0, `${k.bad}`);
    check(`Ctrl+Tab: the strip shows the new tab within ${CEIL.keyStripMed} ms (median) and ${CEIL.keyStripP95} ms (p95)`, k.strip.med <= CEIL.keyStripMed && k.strip.p95 <= CEIL.keyStripP95, fmt(k.strip));
    check(`Ctrl+Tab: event loop held up at most ${CEIL.lagMax} ms, no UI long task over ${CEIL.longMax} ms`, k.lag.max <= CEIL.lagMax && k.long.max <= CEIL.longMax, `lag ${fmt(k.lag)} long ${fmt(k.long)}`);

    // ---- a long chat: newest first, whole a moment later
    const bigTab = r.ids[0]; // bound to the chat with 30 exchanges
    await ui.evaluate((id) => document.querySelector(`#tabs .tab[data-id="${id}"]`).click(), bigTab);
    const drawn = () => ui.evaluate(() => document.querySelectorAll('#messages .msg.user').length);
    const first = await waitFor(async () => (await drawn()) > 0 && (await drawn()), 4000);
    check('the long chat shows its newest messages at once', first > 0, `${first}`);
    check('...and the whole chat (30 exchanges) is drawn a moment later', await waitFor(async () => (await drawn()) === 30, 15000), `${await drawn()}`);
    const atEnd = await ui.evaluate(() => { const m = document.getElementById('messages'); return m.scrollHeight - m.scrollTop - m.clientHeight; });
    check('...and the view still shows the end of the chat', atEnd < 100, `${atEnd}`);

    // ---- a chat handed to a closed sidebar is drawn when the sidebar opens
    const other = r.ids[1];
    await ui.evaluate(() => document.getElementById('toggle-sidebar').click()); // close it on this tab
    await waitFor(() => ui.evaluate(() => document.body.classList.contains('sidebar-hidden')), 4000);
    await ui.evaluate((id) => document.querySelector(`#tabs .tab[data-id="${id}"]`).click(), other);
    await sleep(600);
    await app.evaluate((_e, id) => global.__tabChats.setSidebar(id, false), other);
    await waitFor(() => ui.evaluate(() => document.body.classList.contains('sidebar-hidden')), 4000);
    await ui.evaluate(() => window.showSidebarFor()); // (the sidebar button itself starts a new chat: the setting is on)
    check('a chat held back while the sidebar was closed is drawn when it opens', await waitFor(async () => (await drawn()) > 0, 6000), `${await drawn()}`);

    // ---- the unloading status poll
    const polls = await app.evaluate(async () => {
      const { ipcMain } = process.mainModule.require('electron');
      const h = ipcMain._invokeHandlers?.get('prefs:sleep-status');
      if (!h) return { n: -1 };
      let n = 0;
      ipcMain._invokeHandlers.set('prefs:sleep-status', (...a) => { n++; return h(...a); });
      await new Promise((res) => setTimeout(res, 8000)); // more than two of its 3 s periods
      ipcMain._invokeHandlers.set('prefs:sleep-status', h);
      return { n };
    });
    check('the unloading status is not polled while Settings is closed', polls.n === 0, JSON.stringify(polls));

    check('no page errors in the browser UI', r.errors.length === 0, r.errors.join(' | '));
  } finally {
    clearTimeout(hard);
    await r.close();
  }
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
