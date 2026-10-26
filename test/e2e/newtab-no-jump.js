// The new-tab page's cards never move after the page is first shown: opening a new tab (fresh and from the spare page), switching
// away from one and back, and opening one with the AI sidebar open. A recorder runs inside the page from its first moment (a preload
// registered on the session: a requestAnimationFrame loop reading every card's box, plus layout-shift entries), while the main process
// notes when the tab's view becomes visible. A card counts as having moved if its box (position and size, transforms included)
// differs from what it was in the first frame the user could see. Offline; a throwaway profile; LUMEN_TEST_BACKGROUND keeps the
// window off-screen.
'use strict';
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${String(detail).slice(0, 1500)}`}`); };

const RECORDER = `
const { contextBridge } = require('electron');
if (location.protocol === 'file:' && /newtab\\.html$/.test(location.pathname)) {
  const frames = [];
  const shifts = [];
  const grab = () => {
    const o = {};
    const sy = window.scrollY;
    const mainOpacity = Number(getComputedStyle(document.querySelector('main')).opacity);
    const put = (k, n) => { if (!n || !n.getClientRects().length || getComputedStyle(n).visibility === 'hidden' || (mainOpacity === 0 && n.closest('main'))) return; const r = n.getBoundingClientRect(); o[k] = [Math.round(r.left * 10) / 10, Math.round((r.top + sy) * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; };
    document.querySelectorAll('.w-card').forEach((c, i) => put('card:' + (c.dataset.id || i), c));
    const f = document.querySelector('main form'); if (f) put('search', f);
    const cl = document.getElementById('clock'); if (cl) put('clock', cl);
    const dock = document.querySelector('.w-dock'); if (dock) put('dock', dock);
    document.querySelectorAll('#sections > *').forEach((n, i) => put('section:' + i, n));
    return o;
  };
  // Read once the frame's own callbacks (the page's relayout) have run: the boxes as that frame draws them.
  const tick = () => {
    const t = Date.now();
    setTimeout(() => { if (frames.length < 6000) frames.push({ t, w: document.documentElement.clientWidth, vis: document.visibilityState, r: grab() }); }, 0);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) shifts.push({ t: Math.round(performance.timeOrigin + e.startTime), v: e.value, src: (e.sources || []).map((x) => { const n = x.node; const d = n ? (n.nodeName + (n.id ? '#' + n.id : '') + (n.className && n.className.baseVal === undefined ? '.' + String(n.className).split(' ').join('.') : '')) : '?'; const f = (r) => [r.x, r.y, r.width, r.height].map(Math.round).join(','); return d + ' ' + f(x.previousRect) + '->' + f(x.currentRect); }) }); }).observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
  contextBridge.exposeInMainWorld('__rec', { get: () => JSON.stringify({ frames, shifts }), reset: () => { frames.length = 0; shifts.length = 0; } });
}
`;

const widgets = [
  { id: 'wnote0001', type: 'notes', note: { text: 'one' }, x: 0, y: 0, w: 3, h: 3 },
  { id: 'wnote0002', type: 'notes', note: { text: 'two' }, x: 9, y: 0, w: 3, h: 4 },
  { id: 'wtodo0001', type: 'todoist', x: 0, y: 5, w: 4, h: 3 },
  { id: 'wgit00001', type: 'github', x: 8, y: 6, w: 4, h: 4 },
  { id: 'wgmail001', type: 'gmail', x: 4, y: 9, w: 3, h: 3 },
  { id: 'wwx000001', type: 'weather', place: 'Boston, Massachusetts, United States', lat: 42.3584, lon: -71.0598, units: 'f', x: 0, y: 9, w: 3, h: 3 },
  { id: 'wcd000001', type: 'countdown', cd: { label: 'Soon', at: Date.now() + 864e5 * 9 }, x: 9, y: 4, w: 3, h: 2 },
  { id: 'wtm000001', type: 'timer', x: 4, y: 12, w: 3, h: 3 },
  { id: 'wtv000001', type: 'tradingview', tv: { symbol: 'NASDAQ:AAPL', interval: 'D', view: 'chart', theme: 'light' }, x: 0, y: 12, w: 4, h: 3 },
  { id: 'wst000001', type: 'notes', note: { text: 'stacked one' }, x: 8, y: 11, w: 4, h: 4, stack: 'sstack001', top: true },
  { id: 'wst000002', type: 'timer', x: 8, y: 11, w: 4, h: 4, stack: 'sstack001' },
  { id: 'wst000003', type: 'files', x: 8, y: 11, w: 4, h: 4, stack: 'sstack001' },
];

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-newtab-nojump-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ homeWidgets: widgets, newTabPrivacy: false, sidebarNewChat: false, performanceMode: 'off', bookmarks: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'].map((n) => ({ url: `https://${n}.test/`, title: n })) }));
  // The history the page's "Frequently Visited" is built from: a real profile always has both sections under the search box.
  const now = Date.now();
  fs.writeFileSync(path.join(profile, 'history.json'), JSON.stringify(['one', 'two', 'three', 'four', 'five', 'six', 'seven'].map((n, i) => ({ url: `https://${n}.freq.test/`, title: n, visits: 20 - i, last: now - i }))));
  const preload = path.join(profile, 'recorder-preload.js');
  fs.writeFileSync(preload, RECORDER);
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' };
  env.ANTHROPIC_API_KEY = 'sk-ant-test';
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate(({ session }, p) => { session.defaultSession.registerPreloadScript({ type: 'frame', filePath: p }); }, preload);
    await app.evaluate(({ BrowserWindow }) => {
      global.__nt = {};
      // whether a tab's view is showing (it is a child of the window's content view with its visible flag on)
      global.__viewShown = (id) => {
        const t = global.__nt[id];
        const v = t && BrowserWindow.getAllWindows()[0].contentView.children.find((c) => c.webContents === t.webContents);
        return Boolean(v && v.getVisible());
      };
    });

    const page = (id, code) => app.evaluate((_e, [i, c]) => global.__nt[i].webContents.executeJavaScript(c), [id, code]);
    // main: when the tab's view is showing (sampled every 4 ms)
    const watch = (id) => app.evaluate((_e, i) => {
      global.__vis = [];
      let last = null;
      global.__visTimer = setInterval(() => { const s = global.__viewShown(i); if (s !== last) { global.__vis.push({ t: Date.now(), visible: s }); last = s; } }, 4);
    }, id);
    const unwatch = () => app.evaluate(() => { clearInterval(global.__visTimer); return global.__vis; });
    const recGet = async (id) => JSON.parse(await page(id, 'window.__rec ? window.__rec.get() : "{}"'));

    // Which cards moved after the first frame the user could see.
    const analyse = (rec, visSamples, from) => {
      const tVis = (visSamples.find((s) => s.visible && s.t >= from) || {}).t;
      const frames = (rec.frames || []).filter((f) => f.t >= from - 50);
      if (!tVis) return { error: `the tab was never shown (${JSON.stringify(visSamples)}, ${frames.length} frames)` };
      let first = -1;
      // The frame the user first sees: the last one drawn by the time the view showed; a page that was hidden draws none until then, so its first.
      frames.forEach((f, i) => { if (f.t <= tVis + 16 && f.vis === 'visible') first = i; });
      if (first < 0) first = Math.max(0, frames.findIndex((f) => f.vis === 'visible'));
      const base = {};
      const moves = {};
      const late = [];
      const trail = {};
      const steps = {};
      for (let i = first; i < frames.length; i++) {
        const f = frames[i];
        for (const [k, r] of Object.entries(f.r)) {
          if (!base[k]) { base[k] = r; if (i > first) late.push(`${k}@+${f.t - tVis}ms`); continue; }
          const d = Math.max(...r.map((v, j) => Math.abs(v - base[k][j])));
          const prev = (trail[k] = trail[k] || [base[k]]);
          if (prev[prev.length - 1].some((v, j) => Math.abs(v - r[j]) > 0.05)) { prev.push(r); (steps[k] = steps[k] || []).push(`+${f.t - tVis}:${r[1]}/${r[3]}`); }
          if (d > 0.5) { const m = moves[k] || (moves[k] = { max: 0, first: f.t - tVis, last: 0, from: base[k], to: r }); m.max = Math.max(m.max, Math.round(d * 10) / 10); m.last = f.t - tVis; m.to = r; }
        }
      }
      // (Chrome measures the first frames after a page was hidden against the last one drawn before it was hidden, which nobody saw as the
      // page's own: only shifts a moment after the first shown frame count here; the boxes above cover the first frames.)
      const shifts = (rec.shifts || []).filter((s) => s.t > frames[first].t + 150 && s.v > 0);
      return { moves, steps, late, shifts: shifts.map((s) => `${s.v.toFixed(4)}@+${s.t - tVis}ms [${(s.src || []).join('; ')}]`), frames: frames.length - first, cards: Object.keys(base).length, widths: [...new Set(frames.slice(first).map((f) => f.w))] };
    };
    const report = (name, a) => {
      if (a.error) { check(name, false, a.error); return; }
      const keys = Object.keys(a.moves);
      console.log(`  [${name}] ${a.cards} boxes, ${a.frames} frames after first shown, widths ${a.widths.join('/')}`);
      console.log(`     moved: ${keys.length ? keys.map((k) => `${k} by ${a.moves[k].max}px (+${a.moves[k].first}..+${a.moves[k].last}ms ${a.moves[k].from.join(',')} -> ${a.moves[k].to.join(',')})`).join('; ') : 'none'}`);
      for (const k of keys) console.log(`     ${k} y/h steps: ${(a.steps[k] || []).slice(0, 14).join(' ')}${(a.steps[k] || []).length > 14 ? ' ...(' + a.steps[k].length + ')' : ''}`);
      console.log(`     layout-shift: ${a.shifts.join(' ') || 'none'}; appeared late: ${a.late.join(' ') || 'none'}`);
      check(`${name}: no card moves after the page is first shown`, keys.length === 0 && a.shifts.length === 0 && a.cards >= 14, `${keys.join(', ')} ${a.shifts.join(' ')} boxes=${a.cards}`);
    };
    const newTab = async () => {
      const from = Date.now();
      const id = await app.evaluate(() => { const t = global.__agent.browser.openTab(); global.__nt[t.id] = t; return t.id; });
      await watch(id);
      await sleep(1700);
      const vis = await unwatch();
      return { id, a: analyse(await recGet(id), vis, from - 5) };
    };

    // 1. A new tab, no spare page ready.
    report('new tab (no spare page)', (await newTab()).a);

    // 2. A new tab from the spare page.
    await app.evaluate(() => global.__spareNewTab.enable(true));
    for (let i = 0; i < 80 && !(await app.evaluate(() => global.__spareNewTab.ready())); i++) await sleep(100);
    await sleep(500);
    const two = await newTab();
    report('new tab from the spare page', two.a);

    // 3. Switch away from a new tab and back.
    await app.evaluate(() => { const t = global.__agent.browser.openTab('about:blank'); global.__nt[t.id] = t; });
    await sleep(3000);
    await page(two.id, 'window.__rec.reset()');
    const t0 = Date.now();
    await watch(two.id);
    await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), two.id);
    await sleep(1500);
    const vis3 = await unwatch();
    report('switching back to a new tab', analyse(await recGet(two.id), vis3, t0 - 5));

    // 4. A new tab with the AI sidebar open.
    await ui.evaluate(() => { if (document.body.classList.contains('sidebar-hidden')) document.getElementById('toggle-sidebar').click(); });
    await sleep(1200);
    await app.evaluate(async () => { global.__spareNewTab.enable(false); global.__spareNewTab.enable(true); }); // (a spare made with the sidebar already open)
    for (let i = 0; i < 80 && !(await app.evaluate(() => global.__spareNewTab.ready())); i++) await sleep(100);
    await sleep(500);
    report('new tab with the sidebar open', (await newTab()).a);

    // 5. A new tab from a spare page made before the window changed size.
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; global.__size = w.getContentSize(); w.setContentSize(1100, 760); });
    for (let i = 0; i < 80 && !(await app.evaluate(() => global.__spareNewTab.ready())); i++) await sleep(100);
    await sleep(500);
    report('new tab from a spare page after the window was resized', (await newTab()).a);

    // 6. Switching back to a new tab after the window changed size while it was behind another.
    const six = await app.evaluate(() => { const t = global.__agent.browser.openTab(); global.__nt[t.id] = t; return t.id; });
    await sleep(2500);
    await app.evaluate(() => { const t = global.__agent.browser.openTab('about:blank'); global.__nt[t.id] = t; });
    await sleep(500);
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setContentSize(1300, 700); });
    await sleep(1500);
    await page(six, 'window.__rec.reset()');
    const t6 = Date.now();
    await watch(six);
    await app.evaluate((_e, id) => global.__agent.browser.switchTab(id), six);
    await sleep(1500);
    const vis6 = await unwatch();
    report('switching back to a new tab after the window was resized', analyse(await recGet(six), vis6, t6 - 5));
  } finally { await app.close().catch(() => {}); }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
