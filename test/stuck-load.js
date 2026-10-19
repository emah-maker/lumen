// A Lumen page (the new-tab page) whose load never commits is loaded again instead of leaving a white page with a
// spinner (features/stuck-load.js). Reproduced here by holding the page's own file request, which is what such a tab looks
// like from the inside: isLoading() and isWaitingForResponse() true, no address, nothing in the console. Also checks the
// guard leaves alone a web page that is merely slow, and a new-tab page that loads normally.
// One hidden window, a throwaway profile, a short grace period (LUMEN_STUCK_LOAD_GRACE_MS, test mode only).
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch { /* not yet */ } await sleep(100); } return v; };

let app;
(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };

  let slowHits = 0;
  const server = http.createServer((_req, res) => { slowHits++; setTimeout(() => { res.setHeader('Content-Type', 'text/html'); res.end('<title>slow</title>slow page'); }, 4000); }).listen(0);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-stuckload-'));
  app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', LUMEN_STUCK_LOAD_GRACE_MS: '1500' },
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  await sleep(1500);

  // ---- a new-tab page that loads normally is not touched
  const normal = await app.evaluate(async ({ session }) => {
    global.__newtabRequests = 0;
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['file:///*/newtab.html*'] }, (_d, cb) => { global.__newtabRequests++; cb({}); });
    const t = global.__agent.browser.openTab();
    await new Promise((r) => t.webContents.once('did-finish-load', r));
    await new Promise((r) => setTimeout(r, 2500)); // past the grace period
    return { requests: global.__newtabRequests, newtab: /newtab.html/.test(t.webContents.getURL()), loading: t.webContents.isLoading() };
  });
  check('a new-tab page that loads normally is requested once and left alone', normal.requests === 1 && !normal.loading && normal.newtab, JSON.stringify(normal));

  // ---- a load that never commits is started again
  const stuck = await app.evaluate(async ({ session }) => {
    const holds = [];
    let seen = 0;
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['file:///*/newtab.html*'] }, (_d, cb) => { seen++; if (seen === 1) holds.push(cb); else cb({}); });
    const t = global.__agent.browser.openTab();
    global.__stuckTab = t;
    global.__stuckSeen = () => seen;
    global.__stuckHolds = holds;
    await new Promise((r) => setTimeout(r, 600));
    const wc = t.webContents;
    return { loading: wc.isLoading(), waiting: wc.isWaitingForResponse(), url: wc.getURL(), seen };
  });
  check('the held page is stuck: loading, waiting for its first response, no address', stuck.loading && stuck.waiting && stuck.url === '' && stuck.seen === 1, JSON.stringify(stuck));
  const recovered = await waitFor(() => app.evaluate(() => {
    const wc = global.__stuckTab.webContents;
    return !wc.isLoading() && /newtab\.html/.test(wc.getURL()) ? { seen: global.__stuckSeen() } : null;
  }), 8000);
  check('a stuck new-tab load is started again and the page comes up', Boolean(recovered) && recovered.seen >= 2, JSON.stringify(recovered));
  await app.evaluate(() => { global.__stuckHolds.splice(0).forEach((cb) => cb({})); }); // let the first, abandoned request go

  // ---- the page rendered (the guard did not just stop the spinner)
  const drawn = await app.evaluate(() => global.__stuckTab.webContents.executeJavaScript("Boolean(document.getElementById('q')) && document.readyState === 'complete'", true).catch((e) => String(e)));
  check('the recovered page is the real new-tab page (search box present)', drawn === true, drawn);

  // ---- a web page that is only slow is not reloaded, and neither is the new-tab page it was opened from
  const slow = await app.evaluate(async (_e, url) => {
    const wc = global.__stuckTab.webContents;
    const before = global.__stuckSeen();
    wc.loadURL(url).catch(() => {});
    await new Promise((r) => setTimeout(r, 3200)); // past the grace period while the server still waits
    const during = { loading: wc.isLoading(), seen: global.__stuckSeen() - before };
    await new Promise((r) => wc.once('did-finish-load', r));
    return { ...during, url: wc.getURL() };
  }, `http://127.0.0.1:${server.address().port}/`);
  check('a slow web page is left to finish: no second request for it, the new-tab page is not loaded again', slow.loading && slow.seen === 0 && slowHits === 1 && /127\.0\.0\.1/.test(slow.url), JSON.stringify({ ...slow, slowHits }));

  await app.close();
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch(async (err) => { console.error(err); try { await app?.close(); } catch { /* gone */ } process.exit(1); });
