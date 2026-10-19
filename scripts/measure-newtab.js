// Measures the new-tab path end to end on the app built from source (temp profile, test mode, windows off-screen
// unless VISIBLE=1): Ctrl+T (or the + button) -> the tab strip shows the new tab -> a frame is drawn -> the address
// bar is focused -> a key typed straight after Ctrl+T lands in it; plus the main process's event-loop lag and the
// UI's long tasks over that window.
//
//   node scripts/measure-newtab.js [scenario,scenario,...|all] [N]
//   scenarios: idle, button, rapid, tabs10, tabs30, tabs60, sleepy60, heavy, loading, closeburst, sidebar, windows
//   env: VISIBLE=1 (on-screen windows), PROFILE=1 (a CPU profile of the main process per scenario -> $TMP/newtab-*.cpuprofile),
//        SPARE=0 (no spare new-tab page), JSON=1 (machine-readable summary on the last line)
const { _electron: electron } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = process.argv[2] || 'idle';
const N = Number(process.argv[3] || 15);

const stats = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return { n: 0, med: NaN, p95: NaN, max: NaN };
  const q = (p) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))];
  return { n: v.length, med: Math.round(q(0.5)), p95: Math.round(q(0.95)), max: Math.round(v[v.length - 1]) };
};

function pageServer() {
  const big = '<p>lorem ipsum dolor sit amet consectetur adipiscing elit</p>'.repeat(300);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Content-Type', 'text/html');
    const n = u.pathname.slice(1);
    if (u.pathname.startsWith('/slow')) { // a page still loading: headers, then a trickle
      res.write(`<!doctype html><title>Slow ${n}</title><body>`);
      let i = 0;
      const t = setInterval(() => { res.write(`<p>chunk ${i++}</p>`); if (i > 120) { clearInterval(t); res.end('</body>'); } }, 50);
      res.on('close', () => clearInterval(t));
      return;
    }
    if (u.pathname.startsWith('/heavy')) { // a busy page: 25 ms of script every 60 ms, a canvas redrawn every frame, a <video> playing a canvas capture
      return res.end(`<!doctype html><title>Heavy ${n}</title><body><canvas id=c width=640 height=360></canvas><video id=v muted autoplay width=320></video><script>
        const c = document.getElementById('c'), x = c.getContext('2d'); let k = 0;
        (function f() { x.fillStyle = 'hsl(' + (k++ % 360) + ',70%,50%)'; x.fillRect(0, 0, 640, 360); for (let i = 0; i < 200; i++) x.fillRect(i * 3, (i * k) % 360, 40, 40); requestAnimationFrame(f); })();
        setInterval(() => { const e = performance.now() + 25; while (performance.now() < e); }, 60);
        const v = document.getElementById('v'); v.srcObject = c.captureStream(30); v.play().catch(() => {});
      </script>${big}</body>`);
    }
    res.end(`<!doctype html><title>Page ${n}</title><body style="font:16px sans-serif"><h1>Page ${n}</h1>${big}</body>`);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

async function launch({ settings } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-newtab-'));
  if (settings) fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(settings));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile };
  if (!process.env.VISIBLE) env.LUMEN_TEST_BACKGROUND = '1';
  const app = await electron.launch({ args: [root], env, timeout: 60000 });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await sleep(1500);
  // main process: event-loop lag sampler and the moment each tab view is shown
  await app.evaluate(({ WebContentsView, BrowserWindow }, spare) => {
    const nt = global.__nt = { lag: [], vis: [], on: false, t: Date.now() };
    const orig = WebContentsView.prototype.setVisible;
    WebContentsView.prototype.setVisible = function (v) { if (v && nt.on && !this.getVisible()) nt.vis.push(Date.now()); return orig.apply(this, arguments); };
    let last = process.hrtime.bigint();
    setInterval(() => { const now = process.hrtime.bigint(); const lag = Number(now - last) / 1e6 - 8; last = now; if (nt.on) nt.lag.push(Math.max(0, lag)); }, 8);
    nt.sendKey = (ch, ctrl) => { const wc = BrowserWindow.getAllWindows()[0].webContents; const mods = ctrl ? ['control'] : []; wc.sendInputEvent({ type: 'keyDown', keyCode: ch, modifiers: mods }); if (!ctrl) wc.sendInputEvent({ type: 'char', keyCode: ch, modifiers: mods }); wc.sendInputEvent({ type: 'keyUp', keyCode: ch, modifiers: mods }); };
    if (spare) global.__spareNewTab.enable();
  }, process.env.SPARE !== '0');
  await installUi(ui);
  await sleep(1500);
  return { app, ui, profile };
}

async function installUi(ui) {
  await ui.evaluate(() => {
    const m = window.__m = { ev: [], frames: [], long: [], on: false };
    const add = (e) => { if (m.on) m.ev.push({ e, t: performance.timeOrigin + performance.now() }); };
    addEventListener('focusin', (ev) => { if (ev.target.id === 'address') add('focus'); }, true);
    document.addEventListener('input', (ev) => { if (ev.target.id === 'address') add('input'); }, true);
    let key = '';
    new MutationObserver(() => {
      const tabs = [...document.querySelectorAll('#tabs .tab')];
      const k = tabs.length + '|' + tabs.findIndex((t) => t.classList.contains('active'));
      if (k !== key) { key = k; add('strip'); requestAnimationFrame(() => requestAnimationFrame(() => add('frame'))); }
    }).observe(document.querySelector('#tabs'), { attributes: true, subtree: true, childList: true });
    try { new PerformanceObserver((l) => { if (m.on) for (const e of l.getEntries()) m.long.push({ d: e.duration, t: performance.timeOrigin + e.startTime }); }).observe({ type: 'longtask', buffered: false }); } catch {}
    let prev = performance.now();
    (function raf() { const n = performance.now(); if (m.on) m.frames.push(n - prev); prev = n; requestAnimationFrame(raf); })();
  });
}

async function startProfile(app) {
  if (!process.env.PROFILE) return;
  await app.evaluate(async () => { const { Session } = process.mainModule.require('inspector'); const s = global.__nt.insp = new Session(); s.connect(); const post = (m, p) => new Promise((res, rej) => s.post(m, p, (e, r) => (e ? rej(e) : res(r)))); await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 200 }); await post('Profiler.start'); });
}
async function stopProfile(app, name) {
  if (!process.env.PROFILE) return;
  const prof = await app.evaluate(async () => { const s = global.__nt.insp; const r = await new Promise((res, rej) => s.post('Profiler.stop', (e, x) => (e ? rej(e) : res(x)))); return JSON.stringify(r.profile); });
  fs.writeFileSync(path.join(os.tmpdir(), `newtab-${name}.cpuprofile`), prof);
}

// One new tab. `how`: 'key' (Ctrl+T) or 'button'. Types straight away (a key every 8 ms) so the first one that lands says when typing works.
async function oneNewTab(r, how = 'key', { settle = 700 } = {}) {
  const { app, ui } = r;
  await ui.evaluate(() => { document.activeElement?.blur(); window.__m.ev = []; window.__m.frames = []; window.__m.long = []; window.__m.on = true; });
  await app.evaluate(() => { const n = global.__nt; n.lag = []; n.vis = []; n.on = true; });
  const tabsBefore = await ui.evaluate(() => document.querySelectorAll('#tabs .tab').length);
  const t0 = await app.evaluate(({ BrowserWindow }, how) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    const t = Date.now();
    if (how === 'key') global.__nt.sendKey('t', true); else wc.executeJavaScript(`document.getElementById('new-tab').click()`);
    let i = 0;
    const typing = setInterval(() => { global.__nt.sendKey('a', false); if (++i > 60) clearInterval(typing); }, 8);
    return t;
  }, how);
  await sleep(settle);
  const m = await ui.evaluate(() => { window.__m.on = false; return { ev: window.__m.ev, frames: window.__m.frames, long: window.__m.long }; });
  const n = await app.evaluate(() => { global.__nt.on = false; return { lag: global.__nt.lag, vis: global.__nt.vis }; });
  const first = (e) => { const x = m.ev.find((y) => y.e === e); return x ? x.t - t0 : NaN; };
  // the page itself: when its first contentful paint happened (before the press = a spare that had drawn already), and the widgets' first render
  const pg = await app.evaluate(async () => { const t = global.__agent.browser.activeTab(); if (!t) return null; try { return await t.webContents.executeJavaScript(`({ fcp: (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime + performance.timeOrigin, ready: performance.timeOrigin, marks: performance.getEntriesByType('mark').map(m=>m.name+'@'+Math.round(m.startTime)).join(' '), nav: (()=>{const n=performance.getEntriesByType('navigation')[0]||{};const r=performance.getEntriesByType('resource').filter(e=>e.name.endsWith('.js'));return {resp:n.responseEnd,dcl:n.domContentLoadedEventEnd,load:n.loadEventEnd,fcp:(performance.getEntriesByName('first-contentful-paint')[0]||{}).startTime,js:r.length,jsEnd:Math.max(0,...r.map(e=>e.responseEnd)),jsStart:Math.min(...r.map(e=>e.startTime))}})() })`, true); } catch { return null; } });
  if (process.env.NAV && pg) console.log(JSON.stringify(pg.nav), pg.marks);
  const page = pg && Number.isFinite(pg.fcp) ? Math.max(Math.max(0, pg.fcp - t0), 0) : NaN;
  const tabsAfter = await ui.evaluate(() => document.querySelectorAll('#tabs .tab').length);
  return {
    page, strip: first('strip'), frame: first('frame'), focus: first('focus'), typed: first('input'),
    shown: n.vis.length ? n.vis[0] - t0 : NaN,
    lagMax: Math.max(0, ...n.lag), lagSum: n.lag.filter((x) => x > 16).reduce((a, b) => a + b, 0),
    longMax: Math.max(0, ...m.long.map((x) => x.d)), frameMax: Math.max(0, ...m.frames),
    ok: tabsAfter === tabsBefore + 1,
  };
}

const closeActive = async (r) => {
  await r.app.evaluate(() => { const t = global.__agent.browser.activeTab(); if (t) global.__closeTabInteractive(t.id); });
  await sleep(300);
  await r.ui.evaluate(() => { const a = document.getElementById('address'); if (a) a.value = ''; });
};
const waitSpare = async (r, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await r.app.evaluate(() => global.__spareNewTab?.ready())) return true; await sleep(100); } return false; };

async function openPages(r, base, count, { prefix = 'p', sleepEvery = 0, heavy = 0 } = {}) {
  for (let i = 0; i < count; i++) {
    const url = i < heavy ? `${base}/heavy${i}` : `${base}/${prefix}${i}`;
    await r.app.evaluate(async (_e, url) => { const t = global.__agent.browser.openTab(url); await new Promise((res) => { t.webContents.once('did-stop-loading', res); setTimeout(res, 3000); }); }, url);
    if (i % 10 === 9) await sleep(300);
  }
  if (sleepEvery) {
    const ids = await r.app.evaluate(() => global.__tabSleep.state().map((t) => t.id));
    await r.app.evaluate((_e, [ids, every]) => { const active = global.__agent.browser.activeTab()?.id; ids.forEach((id, i) => { if (i % every === 0 && id !== active) global.__tabSleep.sleep(id); }); }, [ids, sleepEvery]);
  }
  await sleep(1500);
}

const rows = [];
async function scenario(name, fn, opts = {}) {
  console.log(`\n== ${name}`);
  const r = await launch(opts);
  try {
    await startProfile(r.app);
    const res = await fn(r);
    await stopProfile(r.app, name);
    const bad = res.filter((x) => !x.ok).length;
    const cols = ['page', 'strip', 'frame', 'focus', 'typed', 'shown', 'lagMax', 'longMax', 'frameMax'];
    const row = { name, n: res.length, bad };
    for (const c of cols) row[c] = stats(res.map((x) => x[c]));
    rows.push(row);
    console.log(cols.map((c) => `${c} ${row[c].med}/${row[c].p95}/${row[c].max}`).join('  '), bad ? `  (${bad} runs did not add exactly one tab)` : '');
  } finally {
    await Promise.race([r.app.close().catch(() => {}), sleep(4000)]);
    try { fs.rmSync(r.profile, { recursive: true, force: true }); } catch {}
  }
}

(async () => {
  const { server, base } = await pageServer();
  const all = ['idle', 'button', 'rapid', 'tabs10', 'tabs30', 'tabs60', 'sleepy60', 'heavy', 'loading', 'closeburst', 'sidebar', 'windows', 'widgets', 'longidle', 'ram'];
  const wanted = arg === 'all' ? all : arg.split(',');
  const S = {
    idle: (r) => (async () => { const out = []; for (let i = 0; i < N; i++) { await waitSpare(r); out.push(await oneNewTab(r)); await closeActive(r); await sleep(500); } return out; })(),
    button: (r) => (async () => { const out = []; for (let i = 0; i < N; i++) { await waitSpare(r); out.push(await oneNewTab(r, 'button')); await closeActive(r); await sleep(500); } return out; })(),
    rapid: (r) => (async () => { const out = []; for (let i = 0; i < N; i++) { out.push(await oneNewTab(r, 'key', { settle: 150 })); } await sleep(1000); return out; })(), // the spare is used up and refilling between presses
    ...Object.fromEntries([10, 30, 60].map((c) => [`tabs${c}`, (r) => (async () => { await openPages(r, base, c); const out = []; for (let i = 0; i < N; i++) { await waitSpare(r); out.push(await oneNewTab(r)); await closeActive(r); await sleep(400); } return out; })()])),
    sleepy60: (r) => (async () => { await openPages(r, base, 60, { sleepEvery: 2 }); const out = []; for (let i = 0; i < N; i++) { await waitSpare(r); out.push(await oneNewTab(r)); await closeActive(r); await sleep(400); } return out; })(),
    heavy: (r) => (async () => { await openPages(r, base, 12, { heavy: 8 }); const out = []; for (let i = 0; i < N; i++) { await waitSpare(r); out.push(await oneNewTab(r)); await closeActive(r); await sleep(400); } return out; })(),
    loading: (r) => (async () => { const out = []; for (let i = 0; i < N; i++) { await r.app.evaluate((_e, u) => { global.__agent.browser.openTab(u); }, `${base}/slow${i}`); await sleep(400); await waitSpare(r); out.push(await oneNewTab(r)); await closeActive(r); await closeActive(r); await sleep(300); } return out; })(),
    closeburst: (r) => (async () => { await openPages(r, base, 30); const out = []; for (let i = 0; i < N; i++) { await closeActive(r); await closeActive(r); await closeActive(r); out.push(await oneNewTab(r, 'key', { settle: 500 })); } return out; })(), // right after closing tabs, spare maybe refilling
    sidebar: (r) => (async () => { await r.ui.evaluate(() => document.getElementById('ai-toggle')?.click() || document.querySelector('[data-action=sidebar],#sidebar-toggle')?.click()); await sleep(1200); const out = []; for (let i = 0; i < N; i++) { await waitSpare(r); out.push(await oneNewTab(r)); await closeActive(r); await sleep(500); } return out; })(),
    windows: (r) => (async () => { for (let i = 0; i < 3; i++) { await r.app.evaluate(() => global.__basics.openNewWindow()); await sleep(1500); } const out = []; for (let i = 0; i < N; i++) { await waitSpare(r); out.push(await oneNewTab(r)); await closeActive(r); await sleep(500); } return out; })(),
  };
  S.longidle = (r) => (async () => { const out = []; for (let i = 0; i < Math.min(N, 5); i++) { await sleep(30000); await waitSpare(r); out.push(await oneNewTab(r)); await closeActive(r); } return out; })(); // 30 s idle before each press
  // RAM cost of the spare: all processes' working set / private bytes (KB) with no spare, then with one loaded. Run with SPARE=0.
  S.ram = (r) => (async () => {
    const metrics = () => r.app.evaluate(({ app }) => { const m = app.getAppMetrics(); return { procs: m.length, ws: m.reduce((n, x) => n + (x.memory.workingSetSize || 0), 0), priv: m.reduce((n, x) => n + (x.memory.privateBytes || 0), 0) }; });
    await sleep(3000); const before = await metrics();
    await r.app.evaluate(() => global.__spareNewTab.enable()); await waitSpare(r); await sleep(3000); const after = await metrics();
    console.log(`RAM no spare: ${before.procs} procs, working set ${Math.round(before.ws / 1024)} MB, private ${Math.round(before.priv / 1024)} MB`);
    console.log(`RAM spare:    ${after.procs} procs, working set ${Math.round(after.ws / 1024)} MB, private ${Math.round(after.priv / 1024)} MB`);
    console.log(`RAM cost of the spare: +${after.procs - before.procs} proc, +${Math.round((after.ws - before.ws) / 1024)} MB working set, +${Math.round((after.priv - before.priv) / 1024)} MB private`);
    return [{ ok: true }];
  })();
  S.widgets = S.idle;
  const widgets = ['aistatus', 'worldclock', 'weather', 'crypto', 'feed', 'aistatus', 'worldclock', 'weather', 'crypto', 'feed'].map((type, i) => ({ id: `wperf${String(i).padStart(4, '0')}`, type, x: (i % 4) * 3, y: Math.floor(i / 4) * 3, w: 3, h: 3 }));
  for (const name of wanted) { if (S[name]) await scenario(name, S[name], name === 'widgets' ? { settings: { homeWidgets: widgets } } : {}); else console.log('unknown scenario', name); }
  server.close();
  console.log('\nscenario        n   strip(med/p95/max)   frame               focus               typed               shown               lagMax');
  for (const r of rows) console.log(`${r.name.padEnd(14)} ${String(r.n).padStart(3)}   ${['page', 'strip', 'frame', 'focus', 'typed', 'shown', 'lagMax'].map((c) => `${r[c].med}/${r[c].p95}/${r[c].max}`.padEnd(19)).join(' ')}`);
  if (process.env.JSON) console.log(JSON.stringify(rows));
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
