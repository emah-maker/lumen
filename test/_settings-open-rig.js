// Shared by test/settings-open-perf.js and scripts/measure-settings-open.js: opens lumen://settings in a hidden app on a
// realistic (long-used) profile and measures how long it takes, in milliseconds from the open call:
//   paint   the visible category has its rows on screen (first rAF after they exist)
//   filled  ...and nothing in it is still a "Loading" placeholder
//   input   a Space key on a focused toggle is handled (sent as soon as the first paint is seen)
//   ready   every section has been built (data-ready)
// plus the longest main-process stall (setImmediate gap) and the renderer's long tasks and long animation frames during the open.
// The clock is the epoch (Date.now() in main; performance.timeOrigin + performance.now() in the page), the same on both sides.
// Every Electron launch goes through playwright-core (hidden: LUMEN_TEST_BACKGROUND=1) on a throwaway profile.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { seed } = require('./_chat-seed');

const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = (profile) => ({ ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' });

// A profile that looks used for a long time: many saved chats and a spread of changed settings.
async function seedProfile(profile) {
  await seed(profile, { chats: 40, big: 20, kb: 3 });
  const app = await electron.launch({ args: [root], env: env(profile) });
  try {
    await (await app.firstWindow()).waitForSelector('.tab');
    await app.evaluate(async () => {
      const set = (k, v) => global.__settings.backend.set(k, v);
      for (const [k, v] of Object.entries({ reduceMotion: false, httpsOnly: true, askWhereToSave: true, screenReaderSupport: 'auto', aiSubagents: true, tabSleepKeepTransfers: true, theme: 'dark', accent: 'blue' })) { try { await set(k, v); } catch { /* an unknown key on this build */ } }
    });
    await sleep(500);
  } finally { await app.close().catch(() => {}); }
}

// Runs in the Settings page from dom-ready: records when the visible category first has rows and no placeholder, and long tasks.
const PAGE_PROBE = `(() => {
  if (window.__rig) return;
  const rig = window.__rig = { origin: performance.timeOrigin, paint: 0, filled: 0, ready: 0, input: 0, sent: 0, vis: 0, raf1: 0, ticks: [], vis0: document.visibilityState, longtasks: [], loafs: [] };
  const now = () => performance.timeOrigin + performance.now();
  for (const [type, list] of [['longtask', rig.longtasks], ['long-animation-frame', rig.loafs]]) {
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) list.push({ start: Math.round(performance.timeOrigin + e.startTime), dur: Math.round(e.duration), block: Math.round(e.blockingDuration || 0) }); }).observe({ type, buffered: true }); } catch {}
  }
  const visible = () => [...document.querySelectorAll('.pane')].find((p) => !p.hidden && p.offsetParent !== null);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !rig.vis) rig.vis = now(); });
  const tick = () => {
    if (!rig.raf1) rig.raf1 = now();
    if (rig.ticks.length < 40) rig.ticks.push([Math.round(now()), Boolean(visible()), Boolean(visible()?.querySelector('.row'))]);
    const p = visible();
    if (p && p.querySelector('.row')) {
      if (!rig.paint) rig.paint = now();
      if (!rig.filled && !/Loading|Checking/.test(p.textContent) && (window.__settingsPerf ? window.__settingsPerf.visibleDone : document.body.dataset.ready === '1')) rig.filled = now();
    }
    if (!rig.ready && document.body.dataset.ready === '1') rig.ready = now();
    if (!(rig.filled && rig.ready)) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  addEventListener('change', () => { if (!rig.input) rig.input = now(); }, true);
})()`;

// One open from the given app. Returns the metrics (ms from the call) and the tab id.
// intent (the page the app menu is in): a real pointerdown on the menu button, then the pick of Settings `pickMs` later (a click is about 90 ms after
// the press, and a menu pick is later still); the time is counted from the pointerdown. Without it the open is a function call, counted from the call.
async function openOnce(app, section, { settleMs = 2500, ui = null, pickMs = 90 } = {}) {
  await app.evaluate(({ webContents }, { code }) => {
    global.__gap = { max: 0, over: [], on: true, last: Date.now() };
    const g = global.__gap;
    const tick = () => { const n = Date.now(); const d = n - g.last; g.last = n; if (d > g.max) g.max = d; if (d > 20) g.over.push({ at: n, d }); if (g.on) setImmediate(tick); };
    setImmediate(tick);
    global.__rigCode = code;
    if (!global.__rigHook) {
      global.__rigHook = true;
      app_hook(webContents);
    }
    function app_hook(wcs) {
      const { app } = process.mainModule.require('electron');
      app.on('web-contents-created', (_e, wc) => {
        wc.on('dom-ready', () => { if (/settings\.html/.test(wc.getURL())) wc.executeJavaScript(global.__rigCode, true).catch(() => {}); });
      });
    }
  }, { code: PAGE_PROBE });
  await sleep(100);
  let t0;
  if (ui) {
    t0 = Date.now();
    await ui.evaluate(() => document.getElementById('app-menu').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 })));
    await sleep(Math.max(0, pickMs - (Date.now() - t0)));
  }
  const opened = await app.evaluate((_e, s) => { const at = Date.now(); const id = global.__settings.open(s); return { at, id }; }, section);
  if (!ui) t0 = opened.at;
  const id = opened.id;
  const inPage = (code) => app.evaluate(async (_e, [i, c]) => { try { const wc = global.__settings.contents(i); return wc ? await wc.executeJavaScript(c, true) : null; } catch { return null; } }, [id, code]);
  // as soon as the first paint is seen, focus a toggle and press Space
  const end = Date.now() + 15000;
  let sentAt = 0;
  while (Date.now() < end) {
    const r = await inPage('window.__rig ? [window.__rig.paint, window.__rig.input] : null');
    if (r && r[0] && !sentAt) {
      // (the first toggle on screen: the lists below the first screen come a frame after the first paint, so look again until one is there)
      const found = await inPage(`(() => { const t = [...document.querySelectorAll('.pane:not([hidden]) input[type=checkbox]')].find((i) => i.offsetParent !== null || i.closest('label,.switch')?.offsetParent); if (t) t.focus(); return !!t; })()`);
      if (found) sentAt = await app.evaluate((_e, i) => {
        const wc = global.__settings.contents(i);
        const at = Date.now();
        wc.focus();
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Space' }); wc.sendInputEvent({ type: 'char', keyCode: ' ' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
        return at;
      }, id);
    }
    if (r && r[1]) break;
    await sleep(8);
  }
  await sleep(settleMs);
  const page = await inPage('window.__rig ? JSON.stringify({ ...window.__rig, marks: performance.getEntriesByType("mark").map((m) => [m.name, Math.round(performance.timeOrigin + m.startTime)]) }) : null');
  const rig = page ? JSON.parse(page) : null;
  const gap = await app.evaluate(() => { global.__gap.on = false; return { max: global.__gap.max, over: global.__gap.over }; });
  const placeholders = await inPage(`[...document.querySelectorAll('.pane:not([hidden])')].map((p) => /Loading|Checking/.test(p.textContent)).some(Boolean)`);
  if (!rig) return { id, error: 'no page probe' };
  const rel = (v) => (v ? Math.round(v - t0) : null);
  const after = (list) => list.filter((e) => e.start >= t0 - 50);
  return {
    id,
    paint: rel(rig.paint), filled: rel(rig.filled), input: rel(rig.input), ready: rel(rig.ready),
    inputLatency: rig.input && sentAt ? Math.round(rig.input - sentAt) : null,
    mainMax: gap.max, mainOver: gap.over.filter((o) => o.at >= t0).map((o) => ({ at: o.at - t0, d: o.d })),
    longtasks: after(rig.longtasks).map((e) => ({ at: e.start - t0, dur: e.dur })),
    loafs: after(rig.loafs).map((e) => ({ at: e.start - t0, dur: e.dur, block: e.block })),
    placeholders: Boolean(placeholders),
    ticks: (rig.ticks || []).map((t) => [rel(t[0]), t[1] ? 1 : 0, t[2] ? 1 : 0].join("/")).join(" "), origin: rel(rig.origin), vis: rel(rig.vis), vis0: rig.vis0, raf1: rel(rig.raf1), opened: opened.at - t0, marks: Object.fromEntries((rig.marks || []).map(([n, v]) => [n, rel(v)])),
  };
}

// cold: the first open in a fresh app; warm: close that tab and open again in the same app.
async function measure(profile, section = '', { intent = false } = {}) {
  // (LUMEN_TEST_SPARES: spare renderers are off in tests unless asked, as in test/perf-newtab.js: Settings is measured with its pooled process)
  const app = await electron.launch({ args: [root], env: { ...env(profile), LUMEN_TEST_SPARES: '1' } });
  const pid = app.process().pid;
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await sleep(9000); // let the browser's own startup work finish (ad-block lists, looking for the CLIs): the first open is "cold" for Settings, not for the browser
    const cold = await openOnce(app, section, { ui: intent ? ui : null });
    await app.evaluate((_e, id) => global.__closeTabInteractive(id), cold.id);
    await sleep(1200);
    const warm = await openOnce(app, section, { ui: intent ? ui : null });
    return { cold, warm };
  } finally { await app.close().catch(() => { try { process.kill(pid); } catch {} }); }
}

const tmpProfile = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ss-settingsperf-'));

module.exports = { seedProfile, measure, tmpProfile, openOnce, env, root, sleep };
