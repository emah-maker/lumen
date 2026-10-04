// Service workers, shared workers and dedicated workers in a real Lumen: a page's navigator.serviceWorker.register()
// settles and becomes ready (the identity auto-attach once left the paused worker targets unresumed, so it never did),
// and a worker's navigator.userAgent / userAgentData agree with the page's. Throwaway profile; LUMEN_TEST_BACKGROUND=1.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORKER_INFO = 'JSON.stringify({ ua: navigator.userAgent, brands: (navigator.userAgentData ? navigator.userAgentData.brands.map((b) => b.brand).sort() : null) })';

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

  const server = http.createServer((req, res) => {
    if (req.url === '/sw.js') {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end(`self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => e.source.postMessage(${WORKER_INFO}));`);
    }
    if (req.url === '/worker.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(`postMessage(${WORKER_INFO});`); }
    if (req.url === '/shared.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(`onconnect = (e) => e.ports[0].postMessage(${WORKER_INFO});`); }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end('<!doctype html><title>SW</title><p>sw</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-sw-'));
  let app;
  try {
    app = await electron.launch({ args: [root], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' } });
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const id = await app.evaluate(async (_e, u) => {
      const t = global.__agent.browser.openTab(u);
      await new Promise((r) => { if (!t.webContents.isLoading()) r(); else t.webContents.once('did-stop-loading', r); setTimeout(r, 8000); });
      return t.id;
    }, `${base}/`);
    const run = (code) => app.evaluate((_e, [i, c]) => global.__settings.contents(i).executeJavaScript(c), [id, code]);
    const timeout = (p, ms, what) => `Promise.race([${p}, new Promise((r) => setTimeout(() => r('TIMEOUT ${what}'), ${ms}))])`;

    const reg = await run(timeout(`navigator.serviceWorker.register('/sw.js').then((r) => 'registered ' + r.scope)`, 10000, 'register'));
    check('serviceWorker.register() settles', /^registered/.test(reg), reg);
    const ready = await run(timeout(`navigator.serviceWorker.ready.then((r) => r.active ? 'active' : 'no active worker')`, 10000, 'ready'));
    check('serviceWorker.ready resolves with an active worker', ready === 'active', ready);
    const regs = await run(`navigator.serviceWorker.getRegistrations().then((r) => r.length)`);
    check('getRegistrations() lists it', regs === 1, regs);

    const page = JSON.parse(await run(WORKER_INFO));
    check('the page says Google Chrome', page.brands && page.brands.includes('Google Chrome'), JSON.stringify(page));
    const same = (label, w) => check(label, w && w.ua === page.ua && JSON.stringify(w.brands) === JSON.stringify(page.brands), `${JSON.stringify(w)} vs ${JSON.stringify(page)}`);
    const swInfo = await run(timeout(`navigator.serviceWorker.ready.then((r) => new Promise((res) => { navigator.serviceWorker.onmessage = (e) => res(JSON.parse(e.data)); r.active.postMessage('who'); }))`, 10000, 'sw message'));
    same('service worker: same User-Agent and userAgentData as the page', swInfo);
    const dedicated = await run(timeout(`new Promise((res) => { const w = new Worker('/worker.js'); w.onmessage = (e) => res(JSON.parse(e.data)); })`, 10000, 'worker'));
    same('dedicated worker: same User-Agent and userAgentData as the page', dedicated);
    const shared = await run(timeout(`new Promise((res) => { const w = new SharedWorker('/shared.js'); w.port.onmessage = (e) => res(JSON.parse(e.data)); })`, 10000, 'shared worker'));
    check('shared worker starts and runs', Boolean(shared && shared.ua), JSON.stringify(shared));
    // (A tab's debugger is never told about shared workers, so they keep Electron's brands: a known gap, not checked.)

    // A second navigation of the controlled page still works (the worker is not left paused).
    const again = await run(timeout(`fetch('/x').then((r) => r.status)`, 10000, 'fetch'));
    check('a fetch through the page still completes', again === 200, again);
  } catch (err) {
    failures++; console.log(`FAIL  test crashed -> ${err.stack || err}`);
  } finally {
    if (app) await app.close().catch(() => {});
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
