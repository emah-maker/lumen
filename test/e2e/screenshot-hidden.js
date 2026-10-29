// The AI's screenshot of a tab that is not being drawn answers quickly instead of hanging (features/tab-capture.js inTime, NOT_DRAWN).
// A page whose window was hidden after it had been shown, or whose view was taken out of its window, answers no capture at all: the
// screenshot tool hung until the MCP client gave up after 60 s, and every later capture of that tab waited behind it (user report).
// Real app, hidden (LUMEN_TEST_BACKGROUND=1): the window is only ever shown off-screen, fully transparent and off the taskbar. Temp profile, 127.0.0.1 only.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };

(async () => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><title>Page ${req.url}</title><body>${'<p>Some text on the page.</p>'.repeat(40)}</body>`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-shot-hidden-'));
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    const open = (u) => app.evaluate((_e, url) => global.__notifyClick.open(url), u);
    const back = await open(`${base}/back`);
    await sleep(1200);
    await open(`${base}/front`);
    await sleep(1200);
    // The screenshot tool as a run calls it, timed, with a 20 s limit of its own (the hang this guards against never ended).
    const shoot = (id) => app.evaluate(async (_e, tid) => {
      const t0 = performance.now();
      const out = await Promise.race([
        global.__agent.execute('screenshot', { tab_id: tid }).then((r) => ({ image: Array.isArray(r) && r.some((b) => b.type === 'image') }), (e) => ({ error: String(e.message) })),
        new Promise((r) => setTimeout(r, 20000, { hung: true })),
      ]);
      return { ...out, ms: Math.round(performance.now() - t0) };
    }, id);
    const { NOT_DRAWN, CAPTURE_MS } = require('../../src/features/tab-capture');

    // 1. a tab behind another one in a window that draws: a picture, quickly
    let r = await shoot(back);
    check('a tab behind another one: a screenshot, in under a second', r.image && r.ms < 1000, JSON.stringify(r));

    // 2. the window was on screen and is now hidden: the tool says so at once (no wait for a frame)
    await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.getTitle() !== 'DevTools');
      w.setSkipTaskbar(true); w.setOpacity(0); w.setPosition(-32000, -32000); w.showInactive();
      await new Promise((res) => setTimeout(res, 500));
      w.hide();
      await new Promise((res) => setTimeout(res, 500));
    });
    r = await shoot(back);
    check('a tab in a window hidden after it was shown: an error that says why, in under a second (it hung for a minute)', r.error === NOT_DRAWN && r.ms < 1000, JSON.stringify(r));
    r = await shoot(back);
    check('...and again: nothing waits behind the first', r.error === NOT_DRAWN && r.ms < 1000, JSON.stringify(r));

    // 3. the window is on screen but the tab's view is not in it: no frame ever comes, so the capture gives up after CAPTURE_MS
    const detached = await app.evaluate(async ({ BrowserWindow, webContents }, tid) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.getTitle() !== 'DevTools');
      w.showInactive();
      global.__notifyClick.switchTab(tid);
      await new Promise((res) => setTimeout(res, 600));
      const wc = webContents.fromId(global.__notifyClick.contentsOf(tid));
      const view = w.contentView.children.find((v) => v.webContents === wc);
      if (!view) return false;
      w.contentView.removeChildView(view);
      global.__detachedView = view;
      await new Promise((res) => setTimeout(res, 600));
      return true;
    }, back);
    check('(set up) the tab in front is taken out of its window', detached);
    r = await shoot(back);
    check(`a tab not drawn in a window on screen: the error after about ${CAPTURE_MS} ms, not a minute`, r.error === NOT_DRAWN && r.ms < CAPTURE_MS + 1500, JSON.stringify(r));
    r = await shoot(back);
    check('...and the next one is not stuck behind it either', r.error === NOT_DRAWN && r.ms < CAPTURE_MS + 1500, JSON.stringify(r));

    // 4. the view goes back: screenshots work again (the captures that never answered no longer hold the tab's queue)
    await app.evaluate(async ({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.getTitle() !== 'DevTools');
      w.contentView.addChildView(global.__detachedView);
      await new Promise((res) => setTimeout(res, 800));
    });
    r = await shoot(back);
    check('back in its window: a screenshot again, in under a second', r.image && r.ms < 1000, JSON.stringify(r));
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} failed` : '\nall screenshot-hidden checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
