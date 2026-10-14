// The Files card and the picker never cost a frame, and never hold main up. STRICT, with a full list: 500 entries (the cap) and a pinned
// folder of 5,000 files, checked in a real (hidden) window with a throwaway profile and a temp folder of files.
//
//   main      a setImmediate chain runs through every phase and records the gap between two callbacks (performance.now()). While the loop is
//             kept spinning, a gap IS the longest task that ran between the two: timer granularity (Windows rounds a timer to 15.6 ms, which
//             made a setInterval probe read 16-31 ms with nothing running) does not enter into it. Budget: no gap over 20 ms in any phase.
//             The idle baseline is printed and must itself be small (about 1 ms): a probe that is noisy at rest proves nothing.
//   renderers the new-tab page and the browser UI: requestAnimationFrame intervals, long-animation-frame and longtask entries, and the
//             page's own timings (window.__filesPerf, filled by the picker and the card only when a test has made the array): a frame
//             misses when its interval is over 25 ms (a vsync missed at 60 Hz) or when any long-animation-frame or longtask shows up.
//             Zero misses are allowed, and the picker's own work per keystroke (its draw) must stay under 16 ms.
// A control process (plain node, spinning the same setImmediate chain) runs beside the app. It is how a stall of the whole machine (other programs
// on a shared desktop, a scan of the 5,000 new files) is told from a stall of ours: a violation that overlaps a stall of the control is not
// the app's, the run is void and is made again (up to 3 times, and the last one fails); a violation with a quiet control is a failure.
// Phases: idle, fill (495 pins, the folder, its walk), card (the card redraws on every change), picker-open, picker-type, picker-toggle
// (open and close again and again), open-file (a file opened through the bridge and by a click on the card).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { start, sleep, waitFor, makeChecker } = require('./_files-rig');

const FRAME_BUDGET_MS = 16;
const MISSED_FRAME_MS = 25; // an interval over this missed a vsync at 60 Hz
const MAIN_BUDGET_MS = 20;
const IDLE_BASELINE_MS = 10; // the setImmediate gap at rest (about 1 ms, a GC pause now and then): over this the probe is not trustworthy
const FOLDER_FILES = 5000;
const PINNED_FILES = 495; // + the folder and the files opened = the 500-entry cap
const PHASES = ['idle', 'fill', 'card', 'picker-open', 'picker-type', 'picker-toggle', 'open-file'];

// Runs in a page: the frames, the long frames and long tasks, per phase, until read().
const PROBE = `(() => {
  const P = { phase: 'idle', on: true, by: {}, last: performance.now() };
  const slot = (ph) => (P.by[ph] ||= { gaps: [], long: [], stalls: [] });
  const note = (kind, e) => { if (!document.hidden) { slot(P.phase).long.push(kind + ':' + Math.round(e.duration)); slot(P.phase).stalls.push([performance.timeOrigin + e.startTime + e.duration, e.duration]); } }; // (a page the picker has frozen behind its still picture is hidden: its frames are throttled to 1 Hz and nobody sees it)
  for (const type of ['long-animation-frame', 'longtask']) {
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) note(type === 'longtask' ? 'task' : 'loaf', e); }).observe({ type, buffered: false }); } catch {}
  }
  document.addEventListener('visibilitychange', () => { P.last = performance.now(); });
  const tick = (t) => { if (!document.hidden && !P.hid) { slot(P.phase).gaps.push(t - P.last); if (t - P.last > ${MISSED_FRAME_MS}) slot(P.phase).stalls.push([performance.timeOrigin + t, t - P.last]); } P.hid = document.hidden; P.last = t; if (P.on) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  window.__filesPerf = []; // [name, ms, phase]: the picker and the card record their own work here when this array exists
  window.__probe = {
    phase: (ph) => { P.phase = ph; P.last = performance.now(); },
    read: () => {
      P.on = false;
      const out = {};
      for (const [ph, s] of Object.entries(P.by)) {
        const g = s.gaps.slice(1);
        const sorted = [...g].sort((a, b) => a - b);
        out[ph] = { n: g.length, max: Math.round(sorted[sorted.length - 1] || 0), p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] || 0), missed: g.filter((x) => x > ${MISSED_FRAME_MS}).length, long: s.long, stalls: s.stalls };
      }
      const own = {};
      for (const [name, ms, ph] of window.__filesPerf) { const k = name + '@' + ph; (own[k] ||= []).push(ms); }
      for (const k of Object.keys(own)) { const a = own[k].sort((x, y) => x - y); own[k] = { n: a.length, max: +a[a.length - 1].toFixed(1), p95: +a[Math.floor(a.length * 0.95)].toFixed(1) }; }
      return { phases: out, own };
    },
  };
  const was = window.__filesPerf.push.bind(window.__filesPerf);
  window.__filesPerf.push = (item) => was([item[0], item[1], P.phase]);
  return true;
})()`;

// Runs in main (app.evaluate): the setImmediate chain, with the gap that is the longest task.
const MAIN_PROBE = () => {
  const S = { phase: 'idle', on: true, by: {}, last: performance.now(), worst: [] };
  global.__spin = S;
  const spin = () => {
    if (!S.on) return;
    const now = performance.now();
    const gap = now - S.last;
    S.last = now;
    const b = (S.by[S.phase] ||= { n: 0, max: 0, over: 0, gaps: [] });
    b.n++;
    if (gap > b.max) b.max = gap;
    if (gap > 20) b.over++;
    if (gap > 5) { b.gaps.push(Math.round(gap)); S.worst.push([S.phase, Math.round(gap), Date.now()]); }
    setImmediate(spin);
  };
  setImmediate(spin);
};

// The control process: its gaps over 6 ms, as [wall-clock end, ms].
const CONTROL = `let last = performance.now(); const spin = () => { const n = performance.now(); if (n - last > 6) console.log(Date.now() + ' ' + Math.round(n - last)); last = n; setImmediate(spin); }; spin();`;

async function attempt() {
  const { state, check: rawCheck } = makeChecker();
  let timingFailures = 0;
  const check = (name, ok, detail, timing = false) => { if (!ok && timing) timingFailures++; rawCheck(name, ok, detail); };
  const control = spawn(process.execPath, ['-e', CONTROL], { stdio: ['ignore', 'pipe', 'ignore'] });
  const controlGaps = []; // [end, ms]
  let pending = '';
  control.stdout.on('data', (d) => { pending += d; const lines = pending.split(String.fromCharCode(10)); pending = lines.pop(); for (const l of lines) { const [t, ms] = l.split(' ').map(Number); if (t) controlGaps.push([t, ms]); } });
  const rig = await start({ tag: 'files-perf' });
  const { app, ui, inTab } = rig;
  let page;
  let main;
  let uiRes;
  try {
    const dir = path.join(rig.tree, 'big');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < FOLDER_FILES; i++) fs.writeFileSync(path.join(dir, `file-${String(i).padStart(4, '0')}-${i % 7 === 0 ? 'report' : 'note'}.txt`), 'x');
    const loose = [];
    for (let i = 0; i < PINNED_FILES; i++) loose.push(rig.file(`pins/pin-${String(i).padStart(3, '0')}.txt`, 'p'));
    await rig.homeTab();
    await waitFor(() => inTab("Boolean(document.querySelector('.w-card.files'))"));
    await sleep(2500);
    // The window's own start-up work must be over, or the idle baseline measures it: a few seconds after launch the ad blocker builds its patched
    // engine in a worker and then swaps it in with a ~20 ms deserialize on main (features/adblock.js loadPatched; the profiler named it, and
    // it is not the Files feature). The swap follows the worker's .json file by a moment.
    await waitFor(() => fs.existsSync(path.join(rig.profile, 'adblock-engine-signin.bin.json')), 60000);
    await sleep(2500);

    await app.evaluate(MAIN_PROBE);
    await inTab(PROBE);
    await ui.evaluate(PROBE);
    const phase = async (name) => {
      await app.evaluate((_e, n) => { global.__spin.phase = n; }, name);
      await inTab(`window.__probe.phase(${JSON.stringify(name)})`);
      await ui.evaluate(`window.__probe.phase(${JSON.stringify(name)})`);
    };

    // ---- idle: the probe at rest ----
    await phase('idle');
    await sleep(3000);

    // ---- filling the list: 495 pins, then the folder of 5,000 files (indexed in the worker) ----
    await phase('fill');
    for (const p of loose) await rig.files('pin', { path: p });
    await rig.files('pin', { path: dir });
    const list = await rig.files('list');
    check('the list holds 500 entries or fewer (the cap)', list.pinned.length + list.recent.length <= 500 && list.pinned.length >= 400, `${list.pinned.length}+${list.recent.length}`);
    check('the card draws while the list fills, and shows a bounded number of rows', await waitFor(() => inTab("document.querySelectorAll('.w-card.files .fl-row').length > 0 && document.querySelectorAll('.w-card.files .fl-row').length <= 32")), await inTab("document.querySelectorAll('.w-card.files .fl-row').length"));
    check('the folder of 5,000 files is searchable once the worker has walked it', await waitFor(async () => (await rig.files('search', 'file-4999')).length > 0, 60000), '');

    // ---- the card redraws on every change ----
    await phase('card');
    await sleep(500);
    for (let i = 0; i < 20; i++) { await rig.files('unpin', (await rig.files('list')).pinned.find((e) => e.name === 'pin-000.txt')?.id); await rig.files('pin', { path: loose[0] }); await sleep(30); }
    await sleep(300);

    // ---- the picker: opening it, typing (as fast as a hand, and one key at a time), opening and closing it again ----
    await phase('picker-open');
    await rig.key('ui', 'F', ['control', 'shift']);
    await waitFor(() => ui.evaluate(() => { const p = document.getElementById('files-picker'); return Boolean(p && !p.hidden); }));
    await sleep(600);

    await phase('picker-type');
    const times = [];
    const rowsNow = () => ui.evaluate(() => document.querySelectorAll('#files-picker-results .files-picker-item').length);
    for (const [q, delay] of [['report', 25], ['report 07', 90], ['file 4999', 25], ['pin 49', 90], ['note', 25], ['rep', 90]]) {
      await ui.fill('#files-picker-input', '');
      await sleep(250);
      const t0 = Date.now();
      await ui.locator('#files-picker-input').pressSequentially(q, { delay });
      await waitFor(() => ui.evaluate(() => document.querySelectorAll('#files-picker-results .files-picker-item').length > 0 || /No matching/.test(document.getElementById('files-picker-results').textContent)));
      times.push(Date.now() - t0 - q.length * delay);
      await sleep(250);
    }
    const rows = await rowsNow();
    check('the picker draws at most 30 rows from 5,500 names', rows > 0 && rows <= 30, String(rows));

    await phase('picker-toggle');
    for (let i = 0; i < 10; i++) {
      await ui.keyboard.press('Escape');
      await sleep(120);
      await rig.key('ui', 'F', ['control', 'shift']);
      await waitFor(() => ui.evaluate(() => { const p = document.getElementById('files-picker'); return Boolean(p && !p.hidden); }));
      await sleep(120);
    }
    await ui.keyboard.press('Escape');
    await sleep(300);

    // ---- opening a file: through the bridge, and with a click on the card's row ----
    await phase('open-file');
    for (let i = 1; i <= 3; i++) {
      const e = (await rig.files('list')).pinned.find((x) => x.name === `pin-00${i}.txt`);
      if (e) await rig.files('open', e.id);
      await sleep(400);
    }
    await sleep(600);

    main = await app.evaluate(() => { global.__spin.on = false; return { by: global.__spin.by, worst: global.__spin.worst }; });
    page = await inTab('window.__probe.read()');
    uiRes = await ui.evaluate('window.__probe.read()');

    // ---- the tables ----
    const pad = (s, n) => String(s).padEnd(n);
    console.log('\n      phase           | main: loops  max  >20  | page: frames max p95 missed long      | ui: frames max p95 missed long');
    for (const ph of PHASES) {
      const m = main.by[ph] || { n: 0, max: 0, over: 0 };
      const p = page.phases[ph] || { n: 0, max: 0, p95: 0, missed: 0, long: [] };
      const u = uiRes.phases[ph] || { n: 0, max: 0, p95: 0, missed: 0, long: [] };
      console.log(`      ${pad(ph, 15)} | ${pad(m.n, 11)} ${pad(Math.round(m.max * 10) / 10, 4)} ${pad(m.over, 4)} | ${pad(p.n, 14)} ${pad(p.max, 3)} ${pad(p.p95, 3)} ${pad(p.missed, 6)} ${pad(p.long.join(',') || '-', 8)} | ${pad(u.n, 12)} ${pad(u.max, 3)} ${pad(u.p95, 3)} ${pad(u.missed, 6)} ${u.long.join(',') || '-'}`);
    }
    console.log(`      own work (ms): page ${JSON.stringify(page.own)}  ui ${JSON.stringify(uiRes.own)}`);
    console.log(`      round trip of a search after the last key: ${JSON.stringify(times)} ms; main gaps over 5 ms: ${JSON.stringify(main.worst.slice(-12).map((w) => w.slice(0, 2)))}`);

    // ---- the checks ----
    const idle = main.by.idle || { max: 999, n: 0 };
    check(`the main probe is quiet at rest (idle baseline ${Math.round(idle.max * 10) / 10} ms over ${idle.n} loops)`, idle.n > 100 && idle.max <= IDLE_BASELINE_MS, JSON.stringify(idle), true);
    for (const ph of PHASES) {
      const m = main.by[ph];
      check(`main never blocked more than ${MAIN_BUDGET_MS} ms in "${ph}" (worst ${m ? Math.round(m.max * 10) / 10 : '?'} ms)`, Boolean(m) && m.n > 20 && m.max <= MAIN_BUDGET_MS, JSON.stringify(m), true);
    }
    // (the new-tab page is hidden while the picker is open and while a file's tab is in front: only its visible phases are judged)
    for (const [label, res, phases] of [['new-tab page', page, ['idle', 'fill', 'card']], ['browser UI', uiRes, PHASES]]) {
      for (const ph of phases) {
        const r = res.phases[ph];
        check(`${label} "${ph}": no missed frame, no long frame or task (${r ? `${r.n} frames, worst ${r.max} ms, ${r.missed} missed, long ${r.long.join(',') || 'none'}` : 'no frames'})`, Boolean(r) && r.n >= 10 && r.missed === 0 && r.long.length === 0, JSON.stringify({ ...r, stalls: undefined }), true);
      }
    }
    const draws = Object.entries({ ...uiRes.own, ...page.own });
    check('the picker draws and the card draws take under 16 ms every time', draws.length > 0 && draws.every(([, v]) => v.max < FRAME_BUDGET_MS), JSON.stringify(draws));
    check(`each search came back fast (slowest ${Math.max(...times)} ms after the last key)`, Math.max(...times) < 1000, JSON.stringify(times));
    check('no page errors', rig.errors.length === 0, rig.errors.join(' | '));
    // Which stalls were the app's: the ones the control process did not share (it saw a gap of 6 ms or more that overlaps the violation, with 80 ms to spare).
    const shared = (end, ms) => controlGaps.some(([t, c]) => t >= end - ms - 80 && t - c <= end + 80);
    const violations = [
      ...(main.worst || []).filter(([ph, ms]) => ms > (ph === 'idle' ? IDLE_BASELINE_MS : MAIN_BUDGET_MS)).map(([ph, ms, end]) => ({ what: `main ${ph} ${ms} ms`, end, ms })),
      ...[['page', page, ['idle', 'fill', 'card']], ['ui', uiRes, PHASES]].flatMap(([who, res, phases]) => phases.flatMap((ph) => (res.phases[ph]?.stalls || []).map(([end, ms]) => ({ what: `${who} ${ph} ${Math.round(ms)} ms`, end, ms })))),
    ];
    const ours = violations.filter((v) => !shared(v.end, v.ms));
    if (violations.length) console.log(`      stalls: ${violations.map((v) => `${v.what}${shared(v.end, v.ms) ? ' (the machine: the control stalled too)' : ' (ours)'}`).join('; ')}`);
    if (state.failures && state.failures === timingFailures && violations.length && !ours.length) { console.log('\nvoid: the whole machine stalled in this run; run again'); return 'void'; }
  } finally {
    await app.evaluate(() => { if (global.__spin) global.__spin.on = false; }).catch(() => {});
    await rig.stop();
    control.kill();
  }
  console.log(state.failures ? `\n${state.failures} failed` : '\nall passed');
  return state.failures ? 'fail' : 'pass';
}

(async () => {
  let result = 'void';
  for (let n = 1; n <= 3 && result === 'void'; n++) { if (n > 1) console.log(`\nattempt ${n}`); result = await attempt(); }
  process.exit(result === 'pass' ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
