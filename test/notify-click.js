// Clicking a site's notification brings its tab to the front (preload/page-dialogs-preload.js -> main.js
// 'page-notification:click'), like Chrome; a click the page fakes (dispatchEvent) does not, and the page's Notification API
// is unchanged. Real Lumen, throwaway profile, a local page.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const server = http.createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>notify</title><body>notify</body>'); }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-notify-click-'));
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile };
  delete env.ANTHROPIC_API_KEY;
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(100); } return v; };

    const site = await app.evaluate((_e, u) => global.__notifyClick.open(u), url);
    const other = await app.evaluate(() => global.__notifyClick.open('about:blank'));
    const inSite = (code) => app.evaluate(({ webContents }, [id, c]) => webContents.fromId(global.__notifyClick.contentsOf(id)).executeJavaScript(c, true), [site, code]);
    await waitFor(() => inSite('document.readyState === "complete" && document.title === "notify"').catch(() => false));
    check('the other tab is in front', (await app.evaluate(() => global.__notifyClick.activeId())) === other, '');

    const api = await inSite(`(() => {
      const n = new Notification('hi', { body: 'x' });
      class Sub extends Notification {}
      const s = new Sub('sub');
      let own = 0; n.onclick = () => { own++; };
      n.dispatchEvent(new Event('click'));
      return { instance: n instanceof Notification, sub: s instanceof Notification && s instanceof Sub, statics: typeof Notification.requestPermission === 'function' && typeof Notification.permission === 'string', own, name: Notification.name };
    })()`);
    check("the page's Notification API is unchanged (instanceof, subclass, statics, its own onclick)", api.instance && api.sub && api.statics && api.own === 1 && api.name === 'Notification', JSON.stringify(api));
    await sleep(600);
    check('a click the page fakes does not pull its tab forward', (await app.evaluate(() => global.__notifyClick.activeId())) === other, '');

    await app.evaluate(({ ipcMain, webContents }, id) => ipcMain.emit('page-notification:click', { sender: webContents.fromId(global.__notifyClick.contentsOf(id)) }), site);
    const front = await waitFor(async () => (await app.evaluate(() => global.__notifyClick.activeId())) === site);
    check("a real click on the site's notification brings its tab to the front", front, await app.evaluate(() => global.__notifyClick.activeId()));
  } catch (err) {
    failures++;
    console.log(`FAIL  threw: ${err.stack || err}`);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall notify-click checks passed');
  process.exit(failures ? 1 : 0);
})();
