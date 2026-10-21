// The page of a tab the AI works in must always fill the tab area, during and after the run. A Browser card's thumbnail is taken with the
// DevTools protocol's Page.captureScreenshot and a clip scale; Chromium lays the page out at the picture's size for the moment of the capture and
// puts the old size back after. Two captures in flight at once (the card's thumbnail, the AI's own screenshot, a read) each saved "the
// size before" and the later restore put the first one's picture size back: the page stayed ~515x325 in the tab's corner (user bug, v0.5.37).
// Real app, hidden (LUMEN_TEST_BACKGROUND=1), temp profile, 127.0.0.1 only.
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

// ---- 0. no Electron: the safety net's test, and every screenshot of a page goes through the page's queue
{
  const { layoutMismatch } = require('../../src/features/tab-capture');
  check('view-fill: a page laid out at the view size is fine', !layoutMismatch([1015, 566], { width: 1015, height: 566 }));
  check('view-fill: an 800x500 box in a bigger view is a mismatch', layoutMismatch([800, 500], { width: 1015, height: 566 }));
  check('view-fill: a zoomed page is compared in CSS px', !layoutMismatch([812, 453], { width: 1015, height: 566 }, 1.25) && layoutMismatch([1015, 566], { width: 1015, height: 566 }, 1.25));
  check('view-fill: a view with no size yet is left alone', !layoutMismatch([800, 500], { width: 0, height: 0 }));
  const readSrc = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const cap = readSrc('src/features/tab-capture.js');
  const count = (text, needle) => text.split(needle).length - 1;
  const raw = count(cap, "sendCommand('Page.captureScreenshot'");
  const queued = count(cap, "oneAtATime(wc, () => dbg.sendCommand('Page.captureScreenshot'");
  check("every Page.captureScreenshot in tab-capture.js is in the page queue (the live card's poll directly, the others through viaDevTools / viaProtocol)", raw === 3 && queued === 1 && cap.includes('function viaDevTools(wc, rect) { return oneAtATime') && cap.includes('function viaProtocol(wc, opts) { return oneAtATime'), JSON.stringify({ raw, queued }));
  check("a full-page screenshot and an outside client's screenshot use the same queue", readSrc('src/features/screenshot.js').includes('oneAtATime(ctx.wc') && readSrc('src/automation/cdp-inproc.js').includes('oneAtATime(s.wc, send)'));
}

(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    // a Todoist-like page: a scrolling app whose right and bottom parts are painted (a marker well beyond 520x330)
    res.end(`<!doctype html><title>App ${req.url}</title><body style="margin:0;background:#202020"><div style="position:fixed;right:0;bottom:0;width:300px;height:200px;background:#f0f"></div><div style="height:3000px">todo</div></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-ai-tab-size-'));
  const app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    // In the main process: the page's own viewport against the tab area, and whether the page's bottom-right is painted (the marker).
    const probe = (id) => app.evaluate(async ({ webContents }, tid) => {
      const wc = webContents.fromId(global.__notifyClick.contentsOf(tid));
      const inner = await wc.executeJavaScript('[innerWidth, innerHeight]');
      return { iw: inner[0], ih: inner[1] };
    }, id);
    const marker = (id) => app.evaluate(async ({ webContents }, tid) => {
      const wc = webContents.fromId(global.__notifyClick.contentsOf(tid));
      const img = await wc.capturePage();
      const { width, height } = img.getSize();
      const bmp = img.toBitmap(); // BGRA
      const o = ((height - 20) * width + (width - 60)) * 4; // (60 px in: clear of the scrollbar)
      return { width, height, px: [bmp[o], bmp[o + 1], bmp[o + 2], bmp[o + 3]], magenta: bmp[o] > 200 && bmp[o + 1] < 60 && bmp[o + 2] > 200 };
    }, id);
    const stress = (id) => app.evaluate(async ({ webContents }, [tid, root]) => {
      const wc = webContents.fromId(global.__notifyClick.contentsOf(tid));
      const cap = global.__tabCapture;
      const jobs = [];
      for (let i = 0; i < 6; i++) { jobs.push(cap.captureThumb(wc, {})); jobs.push(cap.captureThumb(wc, { lowRes: true })); jobs.push(cap.captureTab(wc, { x: 0, y: 0, width: 300, height: 200 }).catch(() => null)); }
      await Promise.all(jobs);
    }, [id, ROOT.split(path.sep).join('/')]);
    let area = null; // the tab area's size, read from a tab in front before anything was captured
    const same = (p) => area && p.iw === area.iw && p.ih === area.ih;

    // a window smaller than the 1280x800 a capture assumes (a laptop at 125-150% scaling has about 1100x650 CSS px of tab area)
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed()); w.setContentSize(1000, 640); });
    await sleep(500);
    const base0 = await app.evaluate((_e, u) => global.__notifyClick.open(u), base + '/base');
    await sleep(1500);
    area = await probe(base0);
    check('tab area is a real size (not the corner box)', area.iw > 700 && area.ih > 400, JSON.stringify(area));

    // 1. a background AI tab: captures in flight at once, then the run ends
    // (a tab the AI opens comes to the front in this setup: put the user's tab back in front so it really is behind)
    const behind = async (url, userTab) => {
      const id = await app.evaluate((_e, u) => global.__notifyClick.openAi(u), url);
      await app.evaluate((_e, t) => global.__notifyClick.switchTab(t), userTab);
      await sleep(1500);
      const active = await app.evaluate(() => global.__notifyClick.activeId());
      check('the AI tab is behind the user tab', active === userTab, active + ' vs ' + userTab);
      return id;
    };
    const bg = await behind(base + '/bg', base0);
    let p = await probe(bg);
    check('a tab the AI works in behind the user tab has the size of the tab area', same(p), JSON.stringify([p, area]));
    for (let round = 0; round < 3; round++) { await stress(bg); await sleep(100); }
    await app.evaluate((_e, id) => global.__notifyClick.switchTab(id), bg);
    await sleep(800);
    p = await probe(bg);
    check('after switching to it: viewport fills the tab area', same(p), JSON.stringify(p));
    let m = await marker(bg);
    check('after switching to it: the page shows beyond the top-left 520x330', m.magenta, JSON.stringify([m, p, area]));

    // 2. the same in the front tab
    const front = await app.evaluate((_e, u) => global.__notifyClick.open(u), base + '/front');
    await sleep(1500);
    for (let round = 0; round < 3; round++) { await stress(front); await sleep(100); }
    p = await probe(front);
    check('front tab: viewport fills the view during/after captures', same(p), JSON.stringify(p));
    m = await marker(front);
    check('front tab: the page shows beyond the top-left 520x330', m.magenta, JSON.stringify(m));

    // 3. nothing resizes the live page while the AI works: the Browser card takes a frame every ~350 ms, the AI takes screenshots, and the run's
    // frame comes on at its start and goes at its end. Every animation frame the page innerWidth/innerHeight and its resize events are recorded,
    // and the view's bounds every 8 ms in the main process: none may change.
    await app.evaluate((_e, id) => global.__notifyClick.switchTab(id), front);
    await sleep(600);
    await app.evaluate(({ webContents }, tid) => webContents.fromId(global.__notifyClick.contentsOf(tid)).executeJavaScript(`(() => { window.__sizes = new Set(); window.__resizes = 0; addEventListener('resize', () => window.__resizes++); (function f() { window.__sizes.add(innerWidth + 'x' + innerHeight + '@' + devicePixelRatio); requestAnimationFrame(f); })(); })()`), front);
    await app.evaluate(({ BrowserWindow }, tid) => {
      const wid = global.__notifyClick.contentsOf(tid);
      const view = BrowserWindow.getAllWindows().flatMap((w) => w.contentView.children).find((c) => c.webContents && c.webContents.id === wid);
      global.__boundsSeen = new Set();
      global.__boundsTimer = setInterval(() => { const b = view.getBounds(); global.__boundsSeen.add([b.x, b.y, b.width, b.height].join(',')); }, 8);
    }, front);
    await sleep(300);
    await ui.evaluate(() => { document.body.classList.add('agent-active'); window.dispatchEvent(new Event('resize')); }); // the run starts (the window's resize makes the UI report its page bounds, as the real start does)
    await sleep(400);
    const t0 = Date.now();
    let steps = 0;
    while (steps < 10) { // a 10-step task with the live card: a card frame and a screenshot per step, as the run does
      await app.evaluate(async ({ webContents }, tid) => {
        const wc = webContents.fromId(global.__notifyClick.contentsOf(tid));
        await Promise.all([global.__tabCapture.captureThumb(wc, {}), global.__tabCapture.captureTab(wc), global.__tabCapture.captureThumb(wc, { lowRes: true })]);
      }, front);
      steps++;
      await sleep(350);
    }
    const perStep = (Date.now() - t0) / steps;
    await ui.evaluate(() => { document.body.classList.remove('agent-active'); window.dispatchEvent(new Event('resize')); }); // the run ends
    await sleep(600);
    const seen = await app.evaluate(async ({ webContents }, tid) => {
      const wc = webContents.fromId(global.__notifyClick.contentsOf(tid));
      clearInterval(global.__boundsTimer);
      return { sizes: await wc.executeJavaScript('[...window.__sizes]'), resizes: await wc.executeJavaScript('window.__resizes'), bounds: [...global.__boundsSeen] };
    }, front);
    check('the page innerWidth/innerHeight never changed over a 10-step run with the live card (start and end included)', seen.sizes.length === 1, JSON.stringify(seen));
    check('the page got no resize event over the run', seen.resizes === 0, JSON.stringify(seen));
    check('the page view bounds never changed over the run', seen.bounds.length === 1, JSON.stringify(seen));
    console.log('INFO  ~' + Math.round(perStep) + ' ms per step incl. the 350 ms wait');
    m = await marker(front);
    check('after the run the page shows beyond the top-left 520x330', m.magenta, JSON.stringify(m));

    // 4. an AI task in a tab behind the user's tab, with the live card streaming at 15 fps (a view nobody sees draws no frames, so the card polls it with
    // clipped screenshots) while the AI takes screenshots and reads the page in parallel; then the user switches to that tab. The page's innerWidth and
    // innerHeight are sampled all along and must equal the tab area's, and the page must fill its view (a probe in the bottom-right corner).
    for (let round = 1; round <= 3; round++) {
      const userTab = await app.evaluate((_e, u) => global.__notifyClick.open(u), base + '/user' + round);
      await sleep(1000);
      const work = await behind(base + '/work' + round, userTab);
      const stream = await app.evaluate(async ({ webContents }, tid) => {
        const wc = webContents.fromId(global.__notifyClick.contentsOf(tid));
        global.__streams = global.__streams || {};
        global.__streams[tid] = { frames: 0, handle: await global.__tabCapture.streamThumb(wc, { fps: 15, onFrame: () => { global.__streams[tid].frames++; } }) };
        return true;
      }, work);
      const sizes = new Set();
      const sample = async () => { const q = await probe(work); sizes.add(q.iw + 'x' + q.ih); };
      for (let step = 0; step < 12; step++) {
        await Promise.all([
          app.evaluate(async ({ webContents }, tid) => { const wc = webContents.fromId(global.__notifyClick.contentsOf(tid)); await global.__tabCapture.captureTab(wc).catch(() => null); }, work),
          app.evaluate(async ({ webContents }, tid) => { const wc = webContents.fromId(global.__notifyClick.contentsOf(tid)); await wc.executeJavaScript('document.body.innerText.length'); await global.__tabCapture.captureThumb(wc, {}); }, work),
          sample(),
        ]);
        await sleep(120);
        await sample();
      }
      const frames = await app.evaluate(async (_e, tid) => { const st = global.__streams[tid]; st.handle?.stop(); return st.frames; }, work);
      check('round ' + round + ': the live card got frames while the AI worked behind the user tab', stream && frames > 0, String(frames));
      check('round ' + round + ': the page behind the user tab kept the tab area size at every sample', sizes.size === 1 && sizes.has(area.iw + 'x' + area.ih), JSON.stringify([...sizes]) + ' vs ' + JSON.stringify(area));
      await app.evaluate((_e, id) => global.__notifyClick.switchTab(id), work);
      await sleep(1200);
      p = await probe(work);
      check('round ' + round + ': after switching to it the page is the size of the tab area', same(p), JSON.stringify([p, area]));
      m = await marker(work);
      check('round ' + round + ': after switching to it the page fills its view (bottom-right painted)', m.magenta, JSON.stringify(m));
    }

    // 5. the harshest mix on a tab behind the user's: the live card polling it, the AI's screenshot, an outside client's clipped screenshots taken at
    // the same moment (a clip of 800x500 at scale 1 is what the card's poll takes, and what the user saw left behind), and a tab switch in the middle of it
    for (let round = 1; round <= 3; round++) {
      const userTab = await app.evaluate((_e, u) => global.__notifyClick.open(u), base + '/mix-user' + round);
      await sleep(1000);
      const work = await behind(base + '/mix-work' + round, userTab);
      await app.evaluate(async ({ webContents }, tid) => {
        const wc = webContents.fromId(global.__notifyClick.contentsOf(tid));
        global.__mix = { frames: 0, handle: await global.__tabCapture.streamThumb(wc, { fps: 15, firstMs: 0, onFrame: () => { global.__mix.frames++; } }) };
      }, work);
      const hammer = app.evaluate(async ({ webContents }, [tid, root]) => {
        const wc = webContents.fromId(global.__notifyClick.contentsOf(tid));
        const d = wc.debugger; const had = d.isAttached(); if (!had) d.attach('1.3');
        try {
          for (let i = 0; i < 6; i++) {
            await Promise.all([
              global.__tabCapture.captureTab(wc).catch(() => null),
              global.__tabCapture.captureThumb(wc, {}),
              ...[0, 1, 2].map(() => d.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 50, fromSurface: true, clip: { x: 0, y: 0, width: 800, height: 500, scale: 1 } }).catch(() => null)),
            ]);
          }
        } finally { if (!had) d.detach(); }
      }, [work, ROOT.split(path.sep).join('/')]);
      await sleep(250);
      await app.evaluate((_e, id) => global.__notifyClick.switchTab(id), work); // the user switches to it in the middle
      await hammer;
      await app.evaluate((_e, tid) => { global.__mix.handle?.stop(); }, work);
      await sleep(1800); // (the safety net reads the page a moment after it is shown)
      p = await probe(work);
      check('mix ' + round + ': the page is the size of the tab area', same(p), JSON.stringify([p, area]));
      m = await marker(work);
      check('mix ' + round + ': the page fills its view (bottom-right painted)', m.magenta, JSON.stringify(m));
    }

    // 6. the safety net, with a page left laid out at 800x500 by a device-metrics override nobody cleared (what the user saw): showing the tab puts it right
    {
      const userTab = await app.evaluate((_e, u) => global.__notifyClick.open(u), base + '/net-user');
      await sleep(1000);
      const work = await behind(base + '/net-work', userTab);
      await app.evaluate(async ({ webContents }, tid) => {
        const wc = webContents.fromId(global.__notifyClick.contentsOf(tid));
        const d = wc.debugger; const had = d.isAttached(); if (!had) d.attach('1.3');
        try { await d.sendCommand('Emulation.setDeviceMetricsOverride', { width: 800, height: 500, deviceScaleFactor: 0, mobile: false }); } finally { if (!had) d.detach(); }
      }, work);
      await sleep(300);
      p = await probe(work);
      check('the override is real here (the page is laid out at 800x500)', p.iw === 800 && p.ih === 500, JSON.stringify(p));
      await app.evaluate((_e, id) => global.__notifyClick.switchTab(id), work);
      await sleep(2000);
      p = await probe(work);
      check('showing the tab clears the override: the page is the size of the tab area again', same(p), JSON.stringify([p, area]));
      m = await marker(work);
      check('...and fills its view', m.magenta, JSON.stringify(m));
      const fixes = await app.evaluate(() => global.__pageSizeFixes || []);
      check('...and the fix is in the diagnostics', fixes.length >= 1 && fixes[fixes.length - 1].source === 'show' && fixes[fixes.length - 1].kind === 'layout', JSON.stringify(fixes));
    }
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
