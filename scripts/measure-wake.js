/* global document */
// Measures how fast a tab shows up when it is switched to after a restore (a lazy placeholder) or after it was
// unloaded (tab sleep): hidden window, throwaway profile, local pages with artificial latency (plus a few real
// sites with --real). Each wake is timed from the click to
//   visible: the first moment anything of the page is on screen: the snapshot placeholder when the app has one
//            (it reports that through global.__wake.last()), else the page's own first paint
//   fcp:     the real page's first contentful paint
//   node scripts/measure-wake.js [--delay 250] [--kb 400] [--runs 5] [--real] [--json] [--label name] [--quick]
//                                [--with-freeze] [--hover-ms 400] [--cache] [--no-restart] [--preload N]
// Scenarios: restored (click a placeholder), restored+hover (hover first, then click), unloaded (slept, then
// clicked), frozen (--with-freeze). Hard timeout 5 minutes; nothing is shown on screen.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d; };
const DELAY = value('delay', 250);
const KB = value('kb', 400);
const RUNS = value('runs', 5);
const HOVER = value('hover-ms', 400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hardStop = setTimeout(() => { console.error('hard timeout'); process.exit(2); }, 300000);
const median = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : NaN; };

const hits = new Map();
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const n = u.pathname.slice(1);
  hits.set(n, (hits.get(n) || 0) + 1);
  setTimeout(() => {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', flag('cache') ? 'max-age=600' : 'no-cache'); // default: a dynamic page (always fetched); --cache: a cacheable one, which a reload must take from the HTTP cache
    res.end(`<!doctype html><title>Wake ${n}</title><body style="font:16px sans-serif"><h1>Wake ${n}</h1>${'<p>lorem ipsum dolor sit amet consectetur adipiscing elit</p>\n'.repeat(Math.round((KB * 1024) / 58))}</body>`);
  }, DELAY);
});

// The page's first contentful paint as a wall-clock time (ms since the epoch), polled in the main process.
const fcpOf = (app, pattern, timeout = 15000) => app.evaluate(async ({ webContents }, { pattern, timeout }) => {
  const re = new RegExp(pattern);
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const wc = webContents.getAllWebContents().find((w) => re.test(w.getURL()));
    if (wc) {
      const r = await wc.executeJavaScript('(() => { const e = performance.getEntriesByName("first-contentful-paint")[0]; return e ? performance.timeOrigin + e.startTime : 0; })()').catch(() => 0);
      if (r) return r;
    }
    await new Promise((x) => setTimeout(x, 8));
  }
  return 0;
}, { pattern, timeout });

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-wake-'));
  const COUNT = 24;
  const real = flag('real') ? ['https://example.com/', 'https://en.wikipedia.org/wiki/Web_browser', 'https://www.iana.org/domains'] : [];
  const urls = [...Array.from({ length: COUNT }, (_, i) => `${base}/${i}`), ...real];
  const titles = urls.map((u, i) => (i < COUNT ? `Wake ${i}` : `Real ${i - COUNT}`));
  const session = { urls, titles, favicons: urls.map(() => null), active: 0, groupIds: urls.map(() => null), pinned: urls.map(() => false) };
  const settings = { session, ...(flag('freeze-first') ? { tabSleepFreezeFirstMinutes: 10 } : {}), ...(args.includes('--preload') ? { tabPreload: value('preload', 2) } : { tabPreload: 0 }) };
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify(settings));
  const launchApp = () => electron.launch({ args: [path.join(__dirname, '..')], timeout: 60000, env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
  let app = await launchApp();
  const out = { label: flag('label') ? args[args.indexOf('--label') + 1] : '', delay: DELAY, kb: KB, runs: {} };
  const record = (name, v) => { const r = (out.runs[name] ||= { visible: [], fcp: [] }); r.visible.push(v.visible); r.fcp.push(v.fcp); };
  try {
    let ui = await app.firstWindow();
    const boot = async () => {
    await ui.waitForSelector('.tab', { timeout: 60000 });
    await sleep(flag('quick') ? 2500 : 5000); // the front page has loaded
    await app.evaluate(() => { try { global.__warmTabs.enable(true); } catch { /* older build */ } try { global.__wake?.enable(true); } catch { /* older build */ } });
    const wsMB = async () => Math.round((await app.evaluate(({ app: a }) => a.getAppMetrics().reduce((n, m) => n + m.memory.workingSetSize, 0))) / 1024);
    out.wsBeforePreloadMB = await wsMB();
    if (args.includes('--preload')) { await app.evaluate(() => global.__wake.preload()); out.preloaded = await app.evaluate(() => global.__wake.state().filter((t) => t.preloaded).map((t) => t.id)); await sleep(2500); }
    out.wsAfterPreloadMB = await wsMB();
    await sleep(1500);
    };
    await boot();
    const label = (n) => (typeof n === 'number' ? `Wake ${n}` : n);
    const tabEl = (l) => ui.evaluate((l) => { const el = [...document.querySelectorAll('.tab')].find((t) => (t.querySelector('.tab-title')?.textContent || t.textContent).trim() === l); if (!el) return null; el.scrollIntoView({ inline: 'center' }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, label(n => n) && l);
    const click = (n) => ui.evaluate((l) => [...document.querySelectorAll('.tab')].find((t) => (t.querySelector('.tab-title')?.textContent || t.textContent).trim() === l)?.click(), label(n));
    const state = () => app.evaluate(() => (global.__tabSleep ? global.__tabSleep.state() : []));
    const lastMark = () => app.evaluate(() => (global.__wake?.last ? global.__wake.last() : null));
    const urlRe = (n) => (typeof n === 'number' ? `/${n}$` : null);

    // Time the wake of one tab: hover first when asked, then click; the clock starts at the click.
    async function wake(name, n, pattern, { hover = 0 } = {}) {
      if (hover) { const p = await tabEl(label(n)); if (p) { await ui.mouse.move(p.x, p.y); await sleep(hover); } }
      if (flag('verbose') && hover) console.error('before click', JSON.stringify(await app.evaluate((_m, n) => global.__wake?.state().filter((t) => t.url.endsWith('/' + n)).map((t) => ({ ...t, snap: global.__wake.hasSnapshot(t.url) })), n)));
      const clickAt = Date.now();
      if (hover) { await ui.mouse.down(); await ui.mouse.up(); } else await click(n); // after a hover: a real press and release on the tab
      const fcp = await fcpOf(app, pattern);
      const activeTitle = await ui.evaluate(() => (document.querySelector('.tab.active .tab-title')?.textContent || '').trim());
      if (activeTitle !== label(n)) { console.error(`WARNING: ${label(n)} was not activated (active: ${activeTitle})`); out.notActivated = (out.notActivated || 0) + 1; }
      const mark = await lastMark();
      const shown = mark && mark.shownAt >= clickAt - 5 && (!fcp || mark.shownAt <= fcp) ? mark.shownAt : 0;
      if (flag('verbose')) console.error(name, n, JSON.stringify(mark && { c: mark.coverAt - clickAt, s: mark.shownAt - clickAt, p: mark.paintAt - clickAt }), 'visible', (shown || fcp) - clickAt, 'fcp', fcp ? fcp - clickAt : 'none');
      record(name, { visible: (shown || fcp) - clickAt || NaN, fcp: fcp ? fcp - clickAt : NaN });
      await sleep(300);
    }
    const visit = async (n) => { await click(n); await fcpOf(app, urlRe(n)); await sleep(1800); await click(0); await sleep(700); }; // load it, then leave (its snapshot is taken then)
    const sleepTab = async (n, how) => { const st = await state(); const id = st[n]?.id; if (id != null) await app.evaluate((_m, { id, how }) => (how === 'freeze' ? global.__tabSleep.freeze(id) : global.__tabSleep.sleep(id)), { id, how }); await sleep(500); };

    await wake(args.includes('--preload') ? 'neighbour after preload' : 'neighbour (no preload)', 1, urlRe(1)); await click(0); await sleep(500);
    for (let i = 0; i < RUNS; i++) { const n = 2 + i; await wake('restored', n, urlRe(n)); await click(0); await sleep(300); }
    for (let i = 0; i < RUNS; i++) { const n = 8 + i; await wake('restored+hover', n, urlRe(n), { hover: HOVER }); await click(0); await sleep(300); }
    for (let i = 0; i < RUNS; i++) { const n = 14 + i; await visit(n); await sleepTab(n, 'unload'); await wake('unloaded', n, urlRe(n)); await click(0); await sleep(300); }
    if (flag('with-freeze')) for (let i = 0; i < RUNS; i++) { const n = 19 + i; await visit(n); await sleepTab(n, 'freeze'); await wake('frozen', n, urlRe(n)); await click(0); await sleep(300); }
    if (!flag('no-restart')) { // a second launch of the same profile: the pages the first one left come back as placeholders, with their pictures
      if (flag('verbose')) console.error('snapshots before restart', JSON.stringify(await app.evaluate((_m, base) => Array.from({ length: 24 }, (_, i) => [i, global.__wake?.hasSnapshot(`${base}/${i}`)]).filter((x) => x[1]).map((x) => x[0]), base)));
      await app.close(); await sleep(1500);
      app = await launchApp(); ui = await app.firstWindow(); await boot();
      for (let i = 0; i < RUNS; i++) { const n = 2 + i; await wake('restored (picture from last run)', n, urlRe(n)); await click(0); await sleep(300); }
      for (let i = 0; i < RUNS; i++) { const n = 8 + i; await wake('restored (picture) + hover', n, urlRe(n), { hover: HOVER }); await click(0); await sleep(300); }
    }
    for (let i = 0; i < real.length; i++) {
      const name = `Real ${i}`;
      const pattern = new URL(real[i]).host.replace(/\./g, '\\.');
      await wake('real restored', name, pattern); await sleep(1500); await click(0); await sleep(300);
    }

    out.requests = Object.fromEntries(hits);
    out.summary = Object.fromEntries(Object.entries(out.runs).map(([k, v]) => [k, { visibleMedMs: median(v.visible), fcpMedMs: median(v.fcp), n: v.fcp.length }]));
    out.totalWsMB = Math.round((await app.evaluate(({ app: a }) => a.getAppMetrics().reduce((s, m) => s + m.memory.workingSetSize, 0))) / 1024);
    out.procs = await app.evaluate(({ app: a }) => a.getAppMetrics().length);
    out.snapshots = await app.evaluate(() => (global.__wake?.snapshotStats ? global.__wake.snapshotStats() : null));
    console.log(JSON.stringify(flag('json') ? out : { label: out.label, delay: DELAY, kb: KB, summary: out.summary, totalWsMB: out.totalWsMB, procs: out.procs, snapshots: out.snapshots }, null, 1));
  } finally {
    await app.close().catch(() => {});
    server.close();
    clearTimeout(hardStop);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* temp dir */ }
  }
})().catch((e) => { console.error(e); process.exit(1); });
