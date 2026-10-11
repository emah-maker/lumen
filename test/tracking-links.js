// [tracking] In a real window, through the ad blocker's network hook (features/adblock.js, tracking-params.js): a page
// opened with utm_/fbclid parameters loads at the clean address (the server never sees them), and <a ping> and
// navigator.sendBeacon reports never leave; with both settings off, they do. The page is a made-up host mapped to
// this machine (loopback addresses skip the hook).
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOST = 'shop.lumen-tracking.test';
const PAGE = `<!doctype html><title>Links</title><a id=l href="#done" ping="/ping">go</a>
<script>window.report=()=>{navigator.sendBeacon('/beacon','x');document.getElementById('l').click();};</script>`;

(async () => {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push(req.url); res.setHeader('content-type', 'text/html'); res.end(PAGE); }).listen(0);
  const port = server.address().port;
  const app = await electron.launch({ args: [path.join(__dirname, '..'), `--host-resolver-rules=MAP ${HOST} 127.0.0.1`], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); } return fn(); };
  const run = (name, input) => app.evaluate(async (_e, [n, i]) => { try { return String(await global.__agent.execute(n, i)); } catch (err) { return `ERROR: ${err.message}`; } }, [name, input]);
  const url = () => app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL());
  const inPage = (code) => app.evaluate((_e, c) => global.__agent.browser.activeTab().webContents.executeJavaScript(c, true), code);
  const set = (key, value) => app.evaluate((_e, [k, v]) => global.__settings.backend.set(k, v), [key, value]);

  try {
    const start = Date.now();
    while (!(await app.evaluate(() => global.__adblock.ready())) && Date.now() - start < 60000) await sleep(500);
    check('the ad blocker is ready', await app.evaluate(() => global.__adblock.ready()), 'not ready after 60 s');
    const base = `http://${HOST}:${port}`;

    // on (the default)
    await run('navigate', { url: `${base}/item?id=7&utm_source=news&fbclid=abc#top` });
    await waitFor(async () => /\/item/.test(await url()));
    check('the page loads at the clean address', (await url()) === `${base}/item?id=7#top`, await url());
    check('and the server never saw the tracking parameters', seen.includes('/item?id=7') && !seen.some((u) => /utm_|fbclid/.test(u)), JSON.stringify(seen));
    await inPage('window.report()');
    await sleep(1500);
    check('no ping or beacon reached the server', !seen.some((u) => /ping|beacon/.test(u)), JSON.stringify(seen));

    // off
    await set('stripTrackingParams', false);
    await set('blockTrackingPings', false);
    seen.length = 0;
    await run('navigate', { url: `${base}/other?utm_source=news` });
    await waitFor(async () => /\/other/.test(await url()));
    check('off: the address is left as it was', (await url()) === `${base}/other?utm_source=news`, await url());
    await inPage('window.report()');
    await waitFor(() => seen.some((u) => /beacon/.test(u)), 4000);
    check('off: the beacon goes (so the check above means something)', seen.some((u) => /beacon/.test(u)), JSON.stringify(seen));
  } catch (err) {
    check('ran to the end', false, err.stack);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
