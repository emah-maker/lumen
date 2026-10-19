// Shared by test/tab-switch-perf.js and scripts/measure-tab-switch.js: a realistic, hidden Lumen to time tab switches in.
// It builds a throwaway profile (50 saved chats, the home widgets on), starts the app off-screen (LUMEN_TEST_BACKGROUND), opens
// about 30 local pages (a plain page, a heavy-DOM page, a page with a playing <video>, a page with timers, a PDF in the built-in
// viewer), pins some, groups a few, and measures switches by clicking the tab (or Ctrl+Tab):
//   shown  main: from the click reaching main to the new tab's view being made visible (ms)
//   sync   main: how long main's own handler of the click ran for (ms; the work that blocks everything else)
//   strip  UI: from the click to the UI's tab strip showing the new tab as active
//   settled UI: from the click until two animation frames after the strip changed (the UI has finished whatever else the switch asked of it)
//   lag    main: the largest event-loop stall during the switch (the same 8-10 ms interval as test/perf-budget.js)
//   long   UI: the longest 'longtask' during the switch
// Everything runs in a private TEMP folder, on a fresh profile, never the user's.
const { _electron: electron } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = process.env.LUMEN_ROOT || path.join(__dirname, '..'); // (LUMEN_ROOT: measure another checkout, e.g. the code before a change)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A private TEMP for this process and everything it starts (Electron inherits it).
const privateTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-tabswitch-'));
const childTemp = path.join(privateTemp, 'tmp');
fs.mkdirSync(childTemp, { recursive: true });
process.env.TEMP = childTemp;
process.env.TMP = childTemp;
process.env.TMPDIR = childTemp;

const stats = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return { n: 0, med: NaN, p95: NaN, max: NaN, mean: NaN };
  const q = (p) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))];
  return { n: v.length, med: Math.round(q(0.5) * 10) / 10, p95: Math.round(q(0.95) * 10) / 10, max: Math.round(v[v.length - 1] * 10) / 10, mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10 };
};

// A minimal two-page PDF (text only), enough for the built-in viewer.
function tinyPdf(n) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 24 Tf 72 700 Td (Document ${n}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// The pages: what a long-lived profile's tabs are like. Each reports its first animation frame after becoming visible (window.__shownAt).
const PROBE = `<script>(function(){function f(){requestAnimationFrame(function(){window.__shownAt=performance.timeOrigin+performance.now();});}document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')f();});f();})();</script>`;
function pageServer() {
  const dom = Array.from({ length: 4000 }, (_, i) => `<div class="r"><span>row ${i}</span><b>${i % 7}</b><i>item</i></div>`).join('');
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const n = u.pathname.replace(/\D+/g, '');
    if (u.pathname.endsWith('.pdf')) { res.setHeader('Content-Type', 'application/pdf'); return res.end(tinyPdf(n)); }
    res.setHeader('Content-Type', 'text/html');
    if (u.pathname.startsWith('/dom')) return res.end(`<!doctype html><title>Dom ${n}</title><body style="font:14px sans-serif">${dom}${PROBE}</body>`);
    if (u.pathname.startsWith('/video')) {
      return res.end(`<!doctype html><title>Video ${n}</title><body><canvas id=c width=320 height=180></canvas><video id=v muted autoplay width=320></video>${PROBE}<script>
        const c=document.getElementById('c'),x=c.getContext('2d');let k=0;(function f(){x.fillStyle='hsl('+(k++%360)+',70%,50%)';x.fillRect(0,0,320,180);requestAnimationFrame(f);})();
        const v=document.getElementById('v');v.srcObject=c.captureStream(30);v.play().catch(()=>{});</script></body>`);
    }
    if (u.pathname.startsWith('/timers')) {
      return res.end(`<!doctype html><title>Timers ${n}</title><body><div id=t>0</div>${PROBE}<script>let i=0;setInterval(()=>{document.getElementById('t').textContent=++i;},100);setInterval(()=>{const e=performance.now()+3;while(performance.now()<e);},250);</script></body>`);
    }
    res.end(`<!doctype html><title>Page ${n}</title><body style="font:16px sans-serif"><h1>Page ${n}</h1>${'<p>lorem ipsum dolor sit amet consectetur</p>'.repeat(150)}${PROBE}</body>`);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

// The ~30 tab URLs: mostly plain, with every heavy kind in it.
function tabUrls(base, count) {
  const kinds = ['plain', 'dom', 'plain', 'timers', 'plain', 'video', 'plain', 'doc.pdf', 'dom', 'plain'];
  return Array.from({ length: count }, (_, i) => {
    const k = kinds[i % kinds.length];
    return k === 'doc.pdf' ? `${base}/f${i}.pdf` : `${base}/${k}${i}`;
  });
}

const median = (xs) => stats(xs).med;

// opts: { tabs = 30, chats = 50, widgets = true, settings = {}, extraEnv = {}, keepProfile = false }
async function launchRig({ tabs = 30, chats = 50, chatKb = 12, chatScale = 1, bindChats = true, sidebar = false, widgets = true, settings = {}, extraEnv = {}, pages = null } = {}) {
  const profile = fs.mkdtempSync(path.join(privateTemp, 'claude-browser-test-tabswitch-'));
  const seeded = chats ? await require('./_chat-seed').seed(profile, { chats, big: 30, kb: chatKb, scale: chatScale }) : { ids: [] };
  const prefs = { ...settings };
  if (widgets) prefs.homeWidgets = [{ id: 'wtsp001', type: 'notes', x: 0, y: 0, w: 4, h: 6 }, { id: 'wtsp002', type: 'timer', x: 8, y: 0, w: 3, h: 3 }];
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8')); } catch { /* none yet */ }
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ ...existing, ...prefs }));
  const { server, base } = await pageServer();
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test', TEMP: childTemp, TMP: childTemp, ...extraEnv };
  const app = await electron.launch({ args: [root], env, timeout: 60000 });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab', { timeout: 60000 });
  await sleep(1500);
  const rig = { app, ui, profile, base, server, ids: [], urls: [], errors: [], chatIds: seeded.ids };
  ui.on('pageerror', (e) => rig.errors.push(e.message));
  // main-side probes: the event-loop lag, when each view is shown, and how long the click handler runs
  await app.evaluate(({ WebContentsView, ipcMain }) => {
    const p = global.__tsp = { lag: [], vis: [], on: false, recv: 0, sync: [] };
    const orig = WebContentsView.prototype.setVisible;
    WebContentsView.prototype.setVisible = function (v) { if (v && p.on && !this.getVisible()) p.vis.push(Date.now()); return orig.apply(this, arguments); };
    let last = process.hrtime.bigint();
    p.timer = setInterval(() => { const now = process.hrtime.bigint(); const lag = Number(now - last) / 1e6 - 8; last = now; if (p.on) p.lag.push(Math.max(0, lag)); }, 8);
    ipcMain.prependListener('tab:switch', () => { if (p.on) { p.recv = Date.now(); p.start = process.hrtime.bigint(); } });
    ipcMain.on('tab:switch', () => { if (p.on && p.start) { p.sync.push(Number(process.hrtime.bigint() - p.start) / 1e6); p.start = 0; } });
  });
  // UI-side probes: long tasks, frames, and the strip showing the new active tab
  await ui.evaluate(() => {
    const m = window.__tsu = { long: [], frames: [], on: false, active: 0, settled: 0, activeId: null, input: [] };
    try { new PerformanceObserver((l) => { if (m.on) for (const e of l.getEntries()) m.long.push({ d: e.duration, t: performance.timeOrigin + e.startTime }); }).observe({ type: 'longtask', buffered: false }); } catch { /* no longtask */ }
    let prev = performance.now();
    (function raf() { const n = performance.now(); if (m.on) m.frames.push(n - prev); prev = n; requestAnimationFrame(raf); })();
    const seen = () => { const a = document.querySelector('#tabs .tab.active'); const id = a?.dataset.id; if (id !== m.activeId) { m.activeId = id; if (m.on) { (m.hist ||= []).push({ id: Number(id), t: performance.timeOrigin + performance.now() }); m.active = performance.timeOrigin + performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => { m.settled = performance.timeOrigin + performance.now(); })); } } };
    new MutationObserver(seen).observe(document.querySelector('#tabs'), { attributes: true, subtree: true, childList: true, attributeFilter: ['class'] });
    document.addEventListener('input', (ev) => { if (m.on && ev.target.id === 'address') m.input.push(performance.timeOrigin + performance.now()); }, true);
  });
  // open the tabs
  const urls = pages || tabUrls(base, tabs);
  for (let i = 0; i < urls.length; i++) {
    const id = await app.evaluate(async (_e, url) => {
      const t = global.__agent.browser.openTab(url);
      await new Promise((res) => { t.webContents.once('did-stop-loading', res); setTimeout(res, 4000); });
      return t.id;
    }, urls[i]);
    rig.ids.push(id);
    rig.urls.push(urls[i]);
    if (i % 8 === 7) await sleep(200);
  }
  // pinned (the first four), two groups
  await app.evaluate((_e, ids) => { for (const id of ids.slice(0, 4)) global.__pinTab(id, true); }, rig.ids);
  if (rig.ids.length >= 14) {
    await app.evaluate((_e, ids) => { global.__tabGroups.create('Work', ids.slice(6, 9)); global.__tabGroups.create('Read', ids.slice(10, 14)); }, rig.ids);
  }
  // every tab has a chat of its own (a long-lived profile: each tab was used with the assistant), already saved by Lumen once; the sidebar open on each when asked
  if (bindChats && rig.chatIds.length) {
    await app.evaluate((_e, { ids, chats: list, sidebar: open }) => { ids.forEach((id, i) => { global.__tabChats.bindings.bind(id, list[i % list.length]); if (open) global.__tabChats.setSidebar(id, true); }); }, { ids: rig.ids, chats: rig.chatIds, sidebar });
    for (const id of rig.ids) { await app.evaluate((_e, tab) => global.__aiTabs.switchTo(tab), id); await sleep(60); }
  }
  await sleep(1500);
  rig.close = async () => {
    await Promise.race([app.close().catch(() => {}), sleep(5000)]);
    try { server.close(); } catch { /* closed */ }
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* left in the private temp */ }
  };
  return rig;
}

// n switches, one after another: `how` 'click' (the tab) or 'key' (Ctrl+Tab). Returns one row per switch.
async function measureSwitches(rig, { n = 20, how = 'click', gap = 450, order = null } = {}) {
  const { app, ui } = rig;
  const rows = [];
  const strip = await ui.evaluate(() => [...document.querySelectorAll('#tabs .tab')].map((el) => Number(el.dataset.id)));
  const targets = order || strip.filter((id) => rig.ids.includes(id));
  await ui.evaluate(() => { window.__tsu.long = []; window.__tsu.frames = []; window.__tsu.on = true; });
  await app.evaluate(() => { global.__tsp.on = true; });
  let from = await app.evaluate(() => global.__agent.browser.activeTab()?.id);
  for (let i = 0; i < n; i++) {
    let to = targets[(i * 7 + 3) % targets.length];
    if (how === 'key') to = null;
    if (to === from) to = targets[(i * 7 + 4) % targets.length];
    await app.evaluate(() => { const p = global.__tsp; p.lag = []; p.vis = []; p.sync = []; p.recv = 0; p.start = 0; });
    await ui.evaluate(() => { window.__tsu.active = 0; window.__tsu.settled = 0; window.__tsu.long = []; });
    const t0 = await app.evaluate(({ BrowserWindow }, { to, how }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      const t = Date.now();
      if (how === 'key') { wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['control'] }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['control'] }); } else { global.__tsp.recv = 0; wc.executeJavaScript(`document.querySelector('#tabs .tab[data-id="${to}"]').click()`); }
      return t;
    }, { to, how });
    await sleep(gap);
    const m = await ui.evaluate(() => ({ active: window.__tsu.active, settled: window.__tsu.settled, long: window.__tsu.long.slice(), activeId: window.__tsu.activeId }));
    const mainSide = await app.evaluate(() => { const p = global.__tsp; return { vis: p.vis.slice(), lag: p.lag.slice(), sync: p.sync.slice(), recv: p.recv, id: global.__agent.browser.activeTab()?.id }; });
    const recv = mainSide.recv || t0;
    rows.push({
      id: mainSide.id,
      shown: mainSide.vis.length ? mainSide.vis[0] - recv : NaN,
      sync: mainSide.sync.length ? mainSide.sync[0] : NaN,
      strip: m.active ? m.active - t0 : NaN,
      settled: m.settled ? m.settled - t0 : NaN,
      lag: Math.max(0, ...mainSide.lag),
      long: Math.max(0, ...m.long.map((x) => x.d)),
      ok: mainSide.id !== from,
    });
    from = mainSide.id;
  }
  const ui2 = await ui.evaluate(() => { window.__tsu.on = false; return { frames: window.__tsu.frames.slice() }; });
  await app.evaluate(() => { global.__tsp.on = false; });
  return { rows, frameMax: Math.max(0, ...ui2.frames), summary: summarize(rows) };
}

function summarize(rows) {
  const out = {};
  for (const k of ['shown', 'sync', 'strip', 'settled', 'lag', 'long']) out[k] = stats(rows.map((r) => r[k]));
  out.bad = rows.filter((r) => !r.ok).length;
  return out;
}

// Puts some tabs to sleep (unloaded) and freezes others, as Settings > Tabs > Page unloading does after its timers, then returns what it did.
async function sleepSome(rig, { sleep: nSleep = 12, freeze: nFreeze = 6, from = 5 } = {}) {
  const { app, ids } = rig;
  const pool = ids.slice(from);
  const sleeping = pool.filter((_, i) => i % 2 === 0).slice(0, nSleep);
  const frozen = pool.filter((_, i) => i % 2 === 1).slice(0, nFreeze);
  await app.evaluate(async (_e, { sleeping: s, frozen: f }) => { for (const id of f) await global.__tabSleep.freeze(id); for (const id of s) global.__tabSleep.sleep(id); }, { sleeping, frozen });
  return { sleeping, frozen };
}

// A burst: n switches `gap` ms apart by clicking the strip, over `targets` (default: the strip's tabs, scattered). Returns, per input, the time
// until the strip showed that tab active, `finalMs` (from the LAST input until that tab was active with its view visible in main), how many
// unloaded tabs were woken and frozen ones thawed, and the worst main event-loop stall. `viewGap`: strip active -> view visible in main (ms).
async function burst(rig, { n = 20, gap = 100, targets = null, end = null } = {}) {
  const { app, ui } = rig;
  const strip = await ui.evaluate(() => [...document.querySelectorAll('#tabs .tab')].map((el) => Number(el.dataset.id)));
  const pool = targets || strip.filter((id) => rig.ids.includes(id));
  const from = await app.evaluate(() => global.__agent.browser.activeTab()?.id);
  const order = [];
  for (let i = 0; i < n; i++) { let to = pool[(i * 7 + 3) % pool.length]; if (to === (order[i - 1] ?? from)) to = pool[(i * 7 + 4) % pool.length]; order.push(to); }
  if (end != null) order[n - 1] = end; // (the burst ends on this tab)
  const before = await app.evaluate(() => global.__tabSleep.state());
  await ui.evaluate(() => { const m = window.__tsu; m.hist = []; m.long = []; m.on = true; });
  await app.evaluate(({ BrowserWindow }) => {
    const p = global.__tsp; p.lag = []; p.samples = []; p.on = true;
    const win = BrowserWindow.getAllWindows()[0];
    let key = '';
    clearInterval(p.sampler);
    p.sampler = setInterval(() => {
      const a = global.__agent.browser.activeTab();
      const id = a?.id;
      const cid = a?.webContents?.id;
      const v = win.contentView.children.find((c) => c.webContents && c.webContents.id === cid);
      const k = `${id}:${v ? v.getVisible() : 'noview'}`;
      if (k !== key) { key = k; p.samples.push({ t: Date.now(), id, visible: Boolean(v && v.getVisible()) }); }
    }, 4);
  });
  const clicks = await ui.evaluate(async ({ order: o, gap: g }) => {
    const out = [];
    for (const id of o) {
      out.push({ id, t: performance.timeOrigin + performance.now() });
      document.querySelector(`#tabs .tab[data-id="${id}"]`)?.click();
      await new Promise((r) => setTimeout(r, g));
    }
    return out;
  }, { order, gap });
  await sleep(1500);
  const main = await app.evaluate(() => { const p = global.__tsp; p.on = false; clearInterval(p.sampler); return { samples: p.samples, lag: p.lag.slice(), state: global.__tabSleep.state(), active: global.__agent.browser.activeTab()?.id }; });
  const hist = await ui.evaluate(() => { window.__tsu.on = false; return window.__tsu.hist.slice(); });
  const last = clicks[clicks.length - 1];
  // (main's Date.now() and the UI's performance clock can differ by a few ms, so a sample just before last.t can still be this click's: any
  // sample of the last tab, visible, after the click before it (a different tab, 'gap' ms earlier) is the last click's)
  const prev = clicks[clicks.length - 2];
  const shown = main.samples.find((s) => s.t > (prev ? prev.t : last.t - 50) && s.id === last.id && s.visible);
  const per = clicks.map((c) => { const h = hist.find((x) => x.id === c.id && x.t >= c.t); return h ? h.t - c.t : NaN; });
  const viewGap = clicks.map((c) => { const h = hist.find((x) => x.id === c.id && x.t >= c.t); const v = h && main.samples.find((x) => x.id === c.id && x.visible && x.t >= c.t); return h && v ? v.t - h.t : NaN; });
  const woke = before.filter((b) => !b.view && main.state.find((x) => x.id === b.id)?.view).length;
  const thawed = before.filter((b) => b.frozen && !main.state.find((x) => x.id === b.id)?.frozen).length;
  return { order, per: stats(per.filter(Number.isFinite)), viewGap: stats(viewGap.filter(Number.isFinite)), finalMs: shown ? Math.max(0, shown.t - last.t) : NaN, finalOk: main.active === last.id, woke, thawed, lagMax: Math.max(0, ...main.lag), perRaw: per };
}

// Typing in the address bar: n keys, each from the keyDown to the field's input event.
async function measureTyping(rig, n = 30) {
  const { app, ui } = rig;
  await ui.evaluate(() => { document.getElementById('address').focus(); window.__tsu.input = []; window.__tsu.on = true; });
  const sent = await app.evaluate(async ({ BrowserWindow }, count) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push(Date.now() + 0);
      const k = String.fromCharCode(97 + (i % 26));
      wc.sendInputEvent({ type: 'keyDown', keyCode: k });
      wc.sendInputEvent({ type: 'char', keyCode: k });
      wc.sendInputEvent({ type: 'keyUp', keyCode: k });
      await new Promise((r) => setTimeout(r, 60));
    }
    return out;
  }, n);
  await sleep(300);
  const got = await ui.evaluate(() => { window.__tsu.on = false; return window.__tsu.input.slice(); });
  await ui.evaluate(() => { const a = document.getElementById('address'); a.value = ''; a.blur(); });
  return stats(sent.map((t, i) => (got[i] != null ? got[i] - t : NaN)));
}

// CPU % by process type over `ms`, with nothing happening (Electron's own sampling).
async function measureIdle(rig, ms = 8000) {
  const { app } = rig;
  await app.evaluate(({ app: a }) => { a.getAppMetrics(); });
  await sleep(ms);
  return app.evaluate(({ app: a }) => {
    const byType = {};
    for (const m of a.getAppMetrics()) { const k = m.type; byType[k] = byType[k] || { n: 0, cpu: 0 }; byType[k].n++; byType[k].cpu += m.cpu.percentCPUUsage; }
    return byType;
  });
}

module.exports = { launchRig, sleepSome, burst, measureSwitches, measureTyping, measureIdle, summarize, stats, median, sleep, privateTemp, root };
