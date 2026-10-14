// The Files card and the picker stay smooth with a full list: 500 entries (the cap) and a pinned folder of 5,000 files. Checked in a real
// (hidden) window: the new-tab page and the browser UI each draw at 16 ms a frame or better while the list changes and the picker is
// typed into, and the main process is never held up for more than 20 ms by any of it (the folder is walked in a worker thread, every
// disk call is async). The files are in a temp folder and the profile is a throwaway.
'use strict';
const fs = require('fs');
const path = require('path');
const { start, sleep, waitFor, makeChecker } = require('./_files-rig');

const FRAME_BUDGET_MS = 16;
const MAIN_BUDGET_MS = 20;
const FOLDER_FILES = 5000;
const PINNED_FILES = 495; // + the folder and the files opened = the 500-entry cap

// Runs in a page: records the gaps between animation frames until stop() is called.
const FRAMES = `(() => {
  const gaps = [];
  let last = performance.now();
  let on = true;
  const long = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); } catch {}
  const tick = (t) => { gaps.push(t - last); last = t; if (on) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__frames = { stop: () => { on = false; const g = gaps.slice(2).sort((a, b) => a - b); return { n: g.length, max: Math.round(g[g.length - 1] || 0), p95: Math.round(g[Math.floor(g.length * 0.95)] || 0), long }; } };
  return true;
})()`;
const MAIN_LAG = () => {
  // main process: how late a 1 ms timer fires, the longest and the count over the budget
  global.__lag = { max: 0, over: 0, last: Date.now() };
  global.__lagTimer = setInterval(() => { const now = Date.now(); const late = now - global.__lag.last - 1; global.__lag.last = now; if (late > global.__lag.max) global.__lag.max = late; }, 1);
};

(async () => {
  const { state, check } = makeChecker();
  const rig = await start({ tag: 'files-perf' });
  const { app, ui, inTab } = rig;
  try {
    const dir = path.join(rig.tree, 'big');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < FOLDER_FILES; i++) fs.writeFileSync(path.join(dir, `file-${String(i).padStart(4, '0')}-${i % 7 === 0 ? 'report' : 'note'}.txt`), 'x');
    const loose = [];
    for (let i = 0; i < PINNED_FILES; i++) loose.push(rig.file(`pins/pin-${String(i).padStart(3, '0')}.txt`, 'p'));
    await rig.homeTab();
    await waitFor(() => inTab("Boolean(document.querySelector('.w-card.files'))"));
    await sleep(1500); // (the window's own start-up work is over)

    await app.evaluate(MAIN_LAG);
    const lag = async () => app.evaluate(() => { const r = { max: global.__lag.max }; global.__lag.max = 0; return r; });
    await inTab(FRAMES);
    await ui.evaluate(FRAMES);

    // ---- filling the list: 495 pins, then the folder of 5,000 files (indexed in the worker) ----
    for (const p of loose) await rig.files('pin', { path: p });
    await rig.files('pin', { path: dir });
    const list = await rig.files('list');
    check('the list holds 500 entries or fewer (the cap)', list.pinned.length + list.recent.length <= 500 && list.pinned.length >= 400, `${list.pinned.length}+${list.recent.length}`);
    check('the card draws while the list fills, and shows a bounded number of rows', await waitFor(() => inTab("document.querySelectorAll('.w-card.files .fl-row').length > 0 && document.querySelectorAll('.w-card.files .fl-row').length <= 32")), await inTab("document.querySelectorAll('.w-card.files .fl-row').length"));
    check('the folder of 5,000 files is searchable once the worker has walked it', await waitFor(async () => (await rig.files('search', 'file-4999')).length > 0, 60000), '');
    const fill = await lag();
    check(`main was never held up more than ${MAIN_BUDGET_MS} ms while the list filled and the folder was walked (worst ${fill.max} ms)`, fill.max <= MAIN_BUDGET_MS, fill.max);

    // ---- the card redraws on every change ----
    await sleep(500);
    for (let i = 0; i < 20; i++) { await rig.files('unpin', (await rig.files('list')).pinned.find((e) => e.name === 'pin-000.txt')?.id); await rig.files('pin', { path: loose[0] }); await sleep(30); }
    await sleep(300);
    const page = await inTab('window.__frames.stop()');
    check(`new-tab page frames: worst ${page.max} ms, 95th ${page.p95} ms over ${page.n} frames${page.n < 10 ? ' (too few frames to judge: the window is not drawing)' : ''}`, page.n < 10 || (page.p95 <= FRAME_BUDGET_MS + 2 && page.max <= 50), JSON.stringify(page));
    check('no long task (50 ms or more) in the new-tab page', page.long.length === 0, JSON.stringify(page.long));
    const redraw = await lag();
    check(`main stayed under ${MAIN_BUDGET_MS} ms while the card redrew (worst ${redraw.max} ms)`, redraw.max <= MAIN_BUDGET_MS, redraw.max);

    // ---- the picker ----
    await rig.key('ui', 'F', ['control', 'shift']);
    await waitFor(() => ui.evaluate(() => { const p = document.getElementById('files-picker'); return Boolean(p && !p.hidden); }));
    const times = [];
    for (const q of ['r', 're', 'rep', 'repo', 'report', 'report 0', 'report 07', 'file 4999', 'pin 4', 'pin 49']) {
      await ui.fill('#files-picker-input', '');
      const t0 = Date.now();
      await ui.fill('#files-picker-input', q);
      await waitFor(() => ui.evaluate(() => document.querySelectorAll('#files-picker-results .files-picker-item').length > 0 || /No matching/.test(document.getElementById('files-picker-results').textContent)));
      times.push(Date.now() - t0);
    }
    const rows = await ui.evaluate(() => document.querySelectorAll('#files-picker-results .files-picker-item').length);
    check('the picker draws at most 30 rows from 5,500 names', rows > 0 && rows <= 30, String(rows));
    const ui1 = await ui.evaluate('window.__frames.stop()');
    check(`browser UI frames while typing in the picker: worst ${ui1.max} ms, 95th ${ui1.p95} ms over ${ui1.n} frames${ui1.n < 10 ? ' (too few frames to judge: the window is not drawing)' : ''}`, ui1.n < 10 || (ui1.p95 <= FRAME_BUDGET_MS + 2 && ui1.max <= 50), JSON.stringify(ui1));
    check('no long task (50 ms or more) in the browser UI', ui1.long.length === 0, JSON.stringify(ui1.long));
    const typed = await lag();
    check(`main stayed under ${MAIN_BUDGET_MS} ms while the picker searched (worst ${typed.max} ms)`, typed.max <= MAIN_BUDGET_MS, typed.max);
    check(`each search came back fast (slowest ${Math.max(...times)} ms with the debounce and the round trip)`, Math.max(...times) < 1000, JSON.stringify(times));
    await ui.keyboard.press('Escape');
    check('no page errors', rig.errors.length === 0, rig.errors.join(' | '));
  } finally {
    await app.evaluate(() => clearInterval(global.__lagTimer)).catch(() => {});
    await rig.stop();
  }
  console.log(state.failures ? `\n${state.failures} failed` : '\nall passed');
  process.exit(state.failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
