// A page load must not freeze the main process: loading pages in a tab (first load, navigation, back-to-back loads, a new tab) with a
// setImmediate-chain gap monitor running in the main process, no gap over 50 ms, while the ad blocker builds its engine from the filter
// lists, which is what a first start does (a throwaway profile has no saved engine). That build is parsing that once ran on the main
// thread: a 0.7 s freeze that landed on page loads at random, wherever the downloads happened to finish. The lists come from a stand-in
// server on this machine (LUMEN_TEST_ADBLOCK_CDN: adblock-lists.js), held back until the monitor runs, so the build always falls inside
// the measured window. Hidden window (LUMEN_TEST_BACKGROUND=1), a throwaway profile, no network beyond 127.0.0.1. Run it under the lock:
//   node scripts/test/e2e-lock.js run -- node test/e2e/page-load-stall.js
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };
const J = (v) => JSON.stringify(v);
const LIMIT = Number(process.env.STALL_LIMIT || 50);

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 700)}`}`); };

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    const n = req.url.replace(/\W/g, '');
    res.end(`<!doctype html><title>Page ${n}</title><body style="margin:0;background:#2a2;color:#fff"><h1 style="font-size:90px;margin:40px">Page ${n}</h1><p id="n" style="font-size:60px;margin:40px"></p><script>setInterval(() => { document.getElementById('n').textContent = Date.now(); }, 150);</script></body>`);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // The stand-in lists: every list has a revision and a few thousand rules (enough that parsing them takes a few hundred ms), the
  // optional dated ones do not exist, and the resources are held back until `release`.
  let release; const released = new Promise((r) => { release = r; });
  const lists = http.createServer(async (req, res) => {
    const m = req.url.match(/^\/([^/]+)\/(metadata\.json|[^/]+\/list\.txt)$/);
    if (!m || /^ublock-filters-20(2[5-9]|30)$/.test(m[1])) { res.statusCode = 404; res.end(); return; }
    if (m[2] === 'metadata.json') { res.end(JSON.stringify({ revisions: ['r1'] })); return; }
    if (m[1] === 'ublock-resources-json') { await released; res.end('# no resources in this test'); return; }
    const rules = [];
    for (let i = 0; i < Number(process.env.STALL_RULES || 1500); i++) rules.push(`||ad${i}-${m[1]}.example.com^$third-party`, `example.com##.ad-${i}-${m[1]}`, `/banner-${i}-${m[1]}/*$script`);
    res.end(rules.join(String.fromCharCode(10)));
  }).listen(0, '127.0.0.1');
  await new Promise((r) => lists.once('listening', r));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pls-'));
  const syntax = require('child_process').spawnSync(process.execPath, ['--check', path.join(__dirname, '..', '..', 'src', 'main.js')]);
  if (syntax.status !== 0) { console.error(String(syntax.stderr)); process.exit(1); }
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_ADBLOCK_CDN: `http://127.0.0.1:${lists.address().port}` },
  });
  try {
    const ui = await app.firstWindow({ timeout: 90000 });
    await ui.waitForSelector('.tab');
    await waitFor(() => app.evaluate(() => Boolean(global.__gpuHealth)), 30000); // (start-up work, not a page load's cost)
    await sleep(1000);

    await app.evaluate(({ webContents }) => {
      const probe = global.__plsProbe = { max: 0, n: 0, big: [], events: [] };
      let last = performance.now();
      const tick = () => { const now = performance.now(); if (now - last > 10) probe.big.push([Math.round(now), Math.round(now - last)]); probe.max = Math.max(probe.max, now - last); probe.n++; last = now; setImmediate(tick); };
      setImmediate(tick);
      const t = global.__windows.list()[0].tabs[0];
      const wc = webContents.fromId(t.contentsId);
      for (const ev of ['did-start-loading', 'did-start-navigation', 'dom-ready', 'did-finish-load', 'did-stop-loading']) wc.on(ev, () => probe.events.push([Math.round(performance.now()), ev]));
    });
    const loadIn = (i, url) => app.evaluate(({ webContents }, [idx, u]) => new Promise((resolve) => {
      const t = global.__windows.list()[0].tabs[idx]; const wc = webContents.fromId(t.contentsId);
      wc.once('did-stop-loading', () => setTimeout(resolve, 700)); // (what follows the load: deferred work)
      wc.loadURL(u);
    }), [i, url]);

    release(); // the lists' download finishes now: the engine is built while the pages below load
    for (let i = 0; i < 4; i++) await loadIn(0, `${base}/p${i}`);
    await ui.evaluate(() => document.getElementById('new-tab')?.click());
    await waitFor(() => app.evaluate(() => global.__windows.list()[0].tabs.length >= 2), 8000);
    for (let i = 0; i < 3; i++) await loadIn(1, `${base}/q${i}`);
    await loadIn(0, `${base}/p-again`);

    const built = await waitFor(() => app.evaluate(() => global.__adblock.ready()), 30000); // (the engine is in place: its load is inside the window too)
    await sleep(500);
    const r = await app.evaluate(() => { const p = global.__plsProbe; return { max: Math.round(p.max), n: p.n, big: p.big, events: p.events }; });
    console.log('      main-process gaps over 10 ms [at, ms]:', J(r.big));
    console.log('      load events [at, name]:', J(r.events.filter((e) => e[1] === 'did-finish-load' || e[1] === 'dom-ready')));
    check('the monitor ran and the ad blocker built its engine meanwhile', r.n > 100 && built === true, J({ n: r.n, built }));
    check(`loading pages never stalls the main process more than ${LIMIT} ms (setImmediate gap)`, r.max <= LIMIT, J({ max: r.max, big: r.big.filter((b) => b[1] > 20), events: r.events }));
  } finally {
    await app.close().catch(() => {});
    server.close(); lists.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
