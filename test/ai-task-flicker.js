// While the AI works a realistic task (opens two tabs, switches between them, some behind the user's, navigates, types, clicks, scrolls, takes a screenshot,
// reads the page, with the sidebar open) nothing on screen may flicker. A scripted provider (no network, no key) drives it against a local 127.0.0.1 page.
// Every ~25 ms the window is sampled:
//  - the share of the page area that no visible page view (or the sidebar's snapshot) covers, so the window's own colour shows: a "flash frame" is one where that
//    is over 20%, and a flash is such a run that comes back within 150 ms;
//  - in the UI page: the toolbar's "AI is using this tab" pill, the sidebar's working-in line, the strip's AI marks and the page frame's opacity.
// And in main, every setVisible / setBounds / addChildView / removeChildView on a view is logged, so a view that is hidden and shown again, or re-layered, per
// step is seen: a tab switch may show one view and hide another, nothing else may change for the view in front. Run with the setting "Hide AI tabs" both off and on.
// FLICKER_DEBUG=1 prints the event log.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

// The task: two tabs opened behind (ids 3 and 4; 1 is the new-tab page, 2 the user's page), worked in behind, then fronted one after the other and the user's tab fronted again.
const ACTIONS = [
  { name: 'click', input: { text: 'Mark' } }, // on the user's page, an element in view but not centred: the page must stay put
  { name: 'type_text', input: { element_id: 1, text: 'hello' } },
  { name: 'open_tab', input: { url: '__BASE__/p1' } },
  { name: 'open_tab', input: { url: '__BASE__/p2' } },
  { name: 'switch_tab', input: { tab_id: 4 } }, // (behind the user's tab)
  { name: 'read_page', input: {} },
  { name: 'switch_tab', input: { tab_id: 3 } },
  { name: 'read_page', input: {} },
  { name: 'scroll', input: { direction: 'down' } },
  { name: 'switch_tab', input: { tab_id: 4, show: true } },
  { name: 'navigate', input: { url: '__BASE__/p3' } },
  { name: 'switch_tab', input: { tab_id: 2, show: true } },
  { name: 'read_page', input: {} },
];

const stubProvider = (app, base, actions) => app.evaluate((_e, { actions, base }) => {
  global.__agent.getClient = () => ({ beta: { messages: { stream: (params) => {
    const usage = { input_tokens: 100, output_tokens: 20 };
    const done = params.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')).length;
    const next = actions[done];
    try { (global.__scrolls ||= {})[done] = global.__chatPage.contents(2)?.executeJavaScript('scrollY + ":" + innerWidth + "x" + innerHeight'); } catch { /* no tab yet */ }
    if (process.env.FLICKER_DEBUG) console.log('[STEP]', done, next ? next.name : 'end', Date.now());
    global.__vlog?.push({ t: Date.now() - (global.__flash?.t0 || 0), op: 'STEP', id: done, arg: next ? next.name : 'end' });
    const gap = () => new Promise((r) => setTimeout(r, 350));
    if (next) {
      const input = JSON.parse(JSON.stringify(next.input).replace('__BASE__', base));
      return {
        async *[Symbol.asyncIterator]() { await gap(); yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working.' } }; },
        finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Working.' }, { type: 'tool_use', id: `tu-${done}`, name: next.name, input }], usage }),
      };
    }
    return {
      async *[Symbol.asyncIterator]() { await gap(); yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'All done.' } }; },
      finalMessage: async () => ({ role: 'assistant', model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'All done.' }], usage }),
    };
  } } } });
}, { actions, base });

// In main: log what is done to the views, and sample the window.
const startMain = (app) => app.evaluate(async ({ BrowserWindow, View, WebContentsView }) => {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('index'));
  const ui = win.webContents;
  const log = [];
  global.__vlog = log;
  const t0 = Date.now();
  const idOf = (v) => { try { return v.webContents ? v.webContents.id : 'view'; } catch { return '?'; } };
  const wrap = (proto, name, fmt) => { const orig = proto[name]; proto[name] = function (...a) { log.push({ t: Date.now() - t0, op: name, id: idOf(this), arg: fmt(a) }); return orig.apply(this, a); }; };
  wrap(WebContentsView.prototype, 'setVisible', (a) => a[0]);
  wrap(WebContentsView.prototype, 'setBounds', (a) => `${a[0].x},${a[0].y},${a[0].width}x${a[0].height}`);
  wrap(View.prototype, 'addChildView', (a) => idOf(a[0]));
  wrap(View.prototype, 'removeChildView', (a) => idOf(a[0]));
  global.__flash = { frames: [], stop: false, busy: true, t0 };
  (async () => {
    while (!global.__flash.stop) {
      try {
        const r = await ui.executeJavaScript('(() => { const v = document.querySelector(".viewport").getBoundingClientRect(); return { x: Math.round(v.left), y: Math.round(v.top), w: Math.round(v.width), h: Math.round(v.height), snap: Boolean(document.querySelector(".viewport .page-snapshot")) }; })()');
        const rects = win.contentView.children.filter((c) => c.getVisible?.() !== false).map((c) => c.getBounds());
        // share of the viewport covered by the visible views (a grid of points)
        let hit = 0; let n = 0;
        for (let gy = 0; gy < 20; gy++) for (let gx = 0; gx < 20; gx++) {
          const px = r.x + (gx + 0.5) * r.w / 20; const py = r.y + (gy + 0.5) * r.h / 20; n++;
          if (rects.some((b) => px >= b.x && px < b.x + b.width && py >= b.y && py < b.y + b.height)) hit++;
        }
        global.__flash.frames.push({ t: Date.now() - t0, open: 1 - hit / n, snap: r.snap, views: rects.length });
      } catch { /* mid-navigation */ }
      await new Promise((res) => setTimeout(res, 15));
    }
    global.__flash.busy = false;
  })();
});

// In the UI page: the state of every indicator, per animation frame, recording changes only.
const startUi = (ui) => ui.evaluate(() => {
  window.__ui = []; window.__uiStop = false;
  const t0 = performance.now();
  const vp = document.querySelector('.viewport');
  const state = () => {
    const disp = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).display !== 'none' && !e.hidden : false; };
    return {
      pill: disp('#agent-pill'), workingIn: disp('#working-in'), active: document.body.classList.contains('agent-active'), away: document.body.classList.contains('agent-away'),
      ring: Number(getComputedStyle(vp, '::after').opacity), marks: document.querySelectorAll('.tab.ai-opened').length, reading: document.querySelectorAll('.tab.ai-reading').length,
      tabs: document.querySelectorAll('.tab').length, snap: Boolean(vp.querySelector('.page-snapshot')),
    };
  };
  let last = '';
  const tick = () => {
    if (window.__uiStop) return;
    const s = state(); const k = JSON.stringify(s);
    if (k !== last) { window.__ui.push({ t: Math.round(performance.now() - t0), ...s }); last = k; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return Date.now();
});

// Flash runs: stretches where more than `limit` of the page area is uncovered, that end within `within` ms (it came back).
function flashRuns(frames, { limit = 0.2, within = 150 } = {}) {
  const runs = [];
  let start = null;
  for (let i = 0; i < frames.length; i++) {
    const bad = frames[i].open > limit && !frames[i].snap;
    if (bad && start === null) start = i;
    if (!bad && start !== null) { const dur = frames[i].t - frames[start].t; if (dur <= within) runs.push({ at: frames[start].t, ms: dur, open: Math.max(...frames.slice(start, i).map((f) => f.open)) }); start = null; }
  }
  return runs;
}

const runOnce = async ({ hideAiTabs, base, check, label }) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-flicker-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test', LUMEN_TEST_BACKGROUND: '1' },
  });
  try {
    if (process.env.FLICKER_DEBUG) app.process().stdout.on('data', (d) => { for (const l of String(d).split('\n')) if (l.includes('[STEP]')) console.log(l); });
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    await app.evaluate((_e, hide) => { global.__settings.backend.set('sidebarNewChat', false); global.__settings.backend.set('accent', 'purple'); global.__settings.backend.set('hideAiTabs', hide); }, hideAiTabs);
    await stubProvider(app, base, ACTIONS);
    await app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => { t.webContents.once('did-stop-loading', r); setTimeout(r, 5000); }); }, `${base}/a`);
    await sleep(1000);
    await startMain(app);
    await startUi(ui);
    await sleep(400);
    await ui.evaluate(() => { const p = document.getElementById('prompt'); p.value = 'Do the whole task'; p.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); });
    check(`${label}: the run starts`, await waitFor(() => ui.evaluate(() => document.body.classList.contains('agent-active')), 10000), 'no agent-active');
    const finished = await waitFor(() => ui.evaluate(() => !document.body.classList.contains('agent-active')), 60000);
    check(`${label}: the run ends`, Boolean(finished), 'still running');
    await sleep(1200); // the end: the frame fades, the pill goes
    await ui.evaluate(() => { window.__uiStop = true; });
    await app.evaluate(() => { global.__flash.stop = true; });
    await waitFor(() => app.evaluate(() => !global.__flash.busy), 5000);
    const frames = await app.evaluate(() => global.__flash.frames);
    const vlog = await app.evaluate(() => global.__vlog);
    const uiLog = await ui.evaluate(() => window.__ui);
    const scrolls = await app.evaluate(async () => { const o = {}; for (const [k, v] of Object.entries(global.__scrolls || {})) o[k] = await v; return o; });
    const tabsNow = await app.evaluate(() => global.__chatPage.tabs().map((t) => [t.id, t.url.slice(0, 30)]));
    if (process.env.FLICKER_DEBUG) {
      console.log(`--- ${label}: view log`);
      for (const e of vlog) console.log(e.t, e.op, e.id, e.arg);
      console.log(`--- ${label}: ui log`);
      for (const e of uiLog) console.log(JSON.stringify(e));
      console.log('tabs', JSON.stringify(tabsNow), 'scrolls', JSON.stringify(scrolls));
    }
    return { frames, vlog, uiLog, tabsNow, scrolls };
  } finally {
    await app.close().catch(() => {});
  }
};

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Fixture ${req.url}</title><body style="margin:0;background:#fff"><p>fixture ${req.url}</p><div style="height:560px"></div><input aria-label="Name"><button onclick="this.textContent='Marked'">Mark</button><a href="/c">Next</a><div style="height:3000px">tall</div></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const hideAiTabs of [false, true]) {
      const label = `Hide AI tabs ${hideAiTabs ? 'on' : 'off'}`;
      const { frames, uiLog, scrolls, vlog } = await runOnce({ hideAiTabs, base, check, label });
      check(`${label}: frames were sampled`, frames.length >= 30, frames.length);
      const runs = flashRuns(frames);
      check(`${label}: no flash frames (over 20% of the page area uncovered and back within 150 ms)`, runs.length === 0, JSON.stringify(runs));
      const worst = frames.reduce((m, f) => Math.max(m, f.snap ? 0 : f.open), 0);
      check(`${label}: the page area is never more than 20% uncovered during the task`, worst <= 0.2, `${(worst * 100).toFixed(0)}%`);
      // A click or typing on an element that is already in view leaves the page where it is (no recentring jump): before the 'scroll' step (index 8) the user's tab stays at 0.
      const y = (k) => Number(String(scrolls[k] ?? 'x').split(':')[0]);
      check(`${label}: a click and typing on a visible element do not scroll the page`, y(1) === 0 && y(2) === 0 && y(3) === 0, JSON.stringify(scrolls));
      // The indicators: each turns on once and off once.
      const flips = (key, pick = (s) => Boolean(s[key])) => { let n = 0; let prev = null; for (const s of uiLog) { const v = pick(s); if (prev !== null && v !== prev) n++; prev = v; } return n; };
      // The page is never resized while the task works (a resize reflows it in front of the user): no setBounds between the first step and the last,
      // and the user's page keeps one size (this would also catch an emulation or zoom left on it by a capture).
      const steps = vlog.filter((e) => e.op === 'STEP');
      const inside = vlog.filter((e) => e.op === 'setBounds' && steps.length && e.t > steps[0].t && e.t < steps[steps.length - 1].t);
      check(`${label}: no view is resized between the first and the last step`, inside.length === 0, JSON.stringify(inside));
      const sizes = new Set(Object.values(scrolls).map((v) => String(v).split(':')[1]));
      check(`${label}: the user's page keeps one size through the task`, sizes.size === 1, [...sizes].join(' '));
      const awayFlips = flips('away');
      check(`${label}: the toolbar pill changes only when the tab in front changes (not per step)`, flips('pill') <= awayFlips + 2, `${flips('pill')} vs ${awayFlips}`);
      check(`${label}: the page frame changes only when the tab in front changes (not per step)`, flips('ring', (s) => s.ring >= 0.5) <= awayFlips + 2, `${flips('ring', (s) => s.ring >= 0.5)} vs ${awayFlips}`);
      check(`${label}: the working-in line does not toggle per step`, flips('workingIn') <= 2, flips('workingIn'));
    }
  } finally {
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
