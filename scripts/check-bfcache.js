// Does back/forward within a tab restore from Chromium's back/forward cache (a page frozen in memory: instant, scroll and
// script state intact)? Runs plain Electron with a hidden window, two local pages, and reports whether going Back fires
// `pageshow` with persisted = true, and how long Back takes. With --enable it adds the BackForwardCache feature flag.
//   node scripts/check-bfcache.js [--enable]
// Result on Electron 44: persisted is false with or without the flag: Electron's embedder does not
// support the back/forward cache, so Back/Forward reload the page from the HTTP cache and the history entry instead.
// Hard timeout 60 s; the window is never shown.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const enable = process.argv.includes('--enable');
const hard = setTimeout(() => { console.error('hard timeout'); process.exit(2); }, 60000);
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'no-store'); // (an HTTP-cache hit would hide the difference)
  res.end(`<!doctype html><title>${req.url}</title><body><script>window.marker = Math.random(); addEventListener('pageshow', (e) => { (window.shows ||= []).push(e.persisted); });</script><h1>${req.url}</h1></body>`);
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-browser-test-bfcache-'));
  fs.writeFileSync(path.join(dir, 'main.js'), `
    const { app, BrowserWindow } = require('electron');
    ${enable ? "app.commandLine.appendSwitch('enable-features', 'BackForwardCache');" : ''}
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      const wc = win.webContents;
      global.wc = wc;
      await wc.loadURL('${base}/a');
    });
    app.on('window-all-closed', () => {});
  `);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"bfcache-check","main":"main.js"}');
  const app = await electron.launch({ args: [dir], timeout: 30000 });
  try {
    await new Promise((r) => setTimeout(r, 1500));
    const out = await app.evaluate(async () => {
      const wc = global.wc;
      const marker = () => wc.executeJavaScript('window.marker');
      const a = await marker();
      await wc.loadURL(`${wc.getURL().replace(/\/a$/, '')}/b`);
      await new Promise((r) => setTimeout(r, 800));
      const t0 = Date.now();
      await new Promise((r) => { wc.once('did-stop-loading', r); wc.navigationHistory.goBack(); });
      const ms = Date.now() - t0;
      await new Promise((r) => setTimeout(r, 300));
      const again = await marker();
      return { sameDocument: a === again, backMs: ms, shows: await wc.executeJavaScript('window.shows'), features: process.argv.join(' ') };
    });
    console.log(JSON.stringify({ flagAdded: enable, ...out }));
  } finally {
    await app.close().catch(() => {});
    server.close();
    clearTimeout(hard);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  }
})().catch((e) => { console.error(e); process.exit(1); });
