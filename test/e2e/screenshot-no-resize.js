// A screenshot must never make the visible page relayout: no `resize` event, no ResizeObserver tick on the document, no visualViewport change, no
// scroll jump, however many the AI takes per step (features/tab-capture.js captureJpeg, ai/snapshot.js screenshot, the card's thumbnails) and when
// the user takes a visible or full-page one (features/screenshot.js). Chromium resizes the live page for a clipped capture with a scale other than 1
// and for captureBeyondViewport; the page's own log of resizes counts what the user would see as a page that jumps. Real app, hidden
// (LUMEN_TEST_BACKGROUND=1), temp profile, 127.0.0.1 only. SHOW_COUNTS=1 prints the counts of every kind of capture.
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
const N = 5; // captures of each kind

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Jumpy</title><style>html,body{margin:0}#a{height:1500px;background:linear-gradient(#fff,#888)}#b{height:1500px;background:#0a0}#hdr{position:fixed;top:0;left:0;right:0;height:40px;background:#f0f}</style></head><body><div id="hdr"></div><div id="a">top</div><div id="b">bottom</div><script>
window.__log = { resize: 0, ro: 0, vv: 0, sizes: [], scrollYs: [] };
const note = () => { const s = innerWidth + 'x' + innerHeight + '@' + (visualViewport ? Math.round(visualViewport.scale * 100) : 0); if (!__log.sizes.includes(s)) __log.sizes.push(s); };
addEventListener('resize', () => { __log.resize++; note(); });
new ResizeObserver(() => { __log.ro++; note(); }).observe(document.documentElement);
visualViewport.addEventListener('resize', () => { __log.vv++; });
addEventListener('scroll', () => { __log.scrollYs.push(Math.round(scrollY)); });
note();
</script></body></html>`;

(async () => {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-shot-noresize-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-shot-noresize-out-'));
  const app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await app.evaluate((_e, dir) => { global.__screenshotDir = dir; }, out);
    const tabId = await app.evaluate(async (_e, u) => {
      const t = global.__agent.browser.openTab(u);
      await new Promise((r) => t.webContents.once('did-finish-load', r));
      return t.id;
    }, base);
    await sleep(800);

    // Scrolls the page to 700, zeroes its log, runs `body` n times in the main process (wc, cap, snap, ctx, shot in scope), then reads the log back.
    const measure = (body, n = N) => app.evaluate(async ({ webContents }, [tid, code, times, root]) => {
      const wc = webContents.fromId(global.__notifyClick.contentsOf(tid));
      await wc.executeJavaScript('scrollTo(0, 700); new Promise(r => setTimeout(r, 200)).then(() => { __log.resize = 0; __log.ro = 0; __log.vv = 0; __log.sizes = []; __log.scrollYs = []; note(); })');
      const ctx = global.__screenshot.ctx(wc);
      const cap = global.__tabCapture;
      const snap = process.mainModule.require(root + '/src/ai/snapshot');
      const fn = new Function('wc', 'cap', 'snap', 'ctx', 'shot', `return (async () => { ${code} })()`);
      const h = { runScript: (w, src) => w.executeJavaScript(src) };
      const agent = { screenshotWc: null, requireTab: () => wc, browser: { aiOff: () => false }, screenshotScale: null };
      let failed = 0;
      for (let i = 0; i < times; i++) { try { await fn(wc, cap, snap, ctx, { agent, h }); } catch (e) { failed++; } }
      await new Promise((r) => setTimeout(r, 400)); // (a restore after the capture lands too)
      const log = await wc.executeJavaScript('({ resize: __log.resize, ro: __log.ro, vv: __log.vv, sizes: __log.sizes, scrollY: Math.round(scrollY), jumps: __log.scrollYs.filter((y) => y !== 700).length, lastScroll: __log.scrollYs.length ? __log.scrollYs[__log.scrollYs.length - 1] : 700, inner: [innerWidth, innerHeight] })');
      return { ...log, failed };
    }, [tabId, body, n, ROOT.split(path.sep).join('/')]);

    const kinds = {
      'AI screenshot step (720 wide)': "const r = await snap.execute(shot.agent, 'screenshot', {}, shot.h); if (!Array.isArray(r)) throw new Error('no picture');",
      'AI screenshot step (1600 wide, quality 90)': "const r = await snap.execute(shot.agent, 'screenshot', { max_width: 1600, quality: 90 }, shot.h); if (!Array.isArray(r)) throw new Error('no picture');",
      'AI screenshot of a region': "await snap.execute(shot.agent, 'screenshot', { region: { x: 10, y: 10, width: 200, height: 150 } }, shot.h);",
      'captureJpeg 400 wide': "if (!(await cap.captureJpeg(wc, { maxWidth: 400, quality: 60 }))) throw new Error('none');",
      'captureTab': 'await cap.captureTab(wc);',
      'card thumbnail (captureThumb)': 'await cap.captureThumb(wc, {});',
      'user visible-area shot': "await global.__screenshot.tool.capture(ctx, 'visible');",
      'user full-page shot': "const r = await global.__screenshot.tool.capture(ctx, 'full'); if (!r.ok || r.height < 2500) throw new Error('short ' + r.height);",
    };
    for (const [name, body] of Object.entries(kinds)) {
      const r = await measure(body);
      if (process.env.SHOW_COUNTS) console.log(`COUNT ${name}: resize=${r.resize} ro=${r.ro} vv=${r.vv} jumps=${r.jumps} scrollY=${r.scrollY} sizes=${r.sizes.join(',')} failed=${r.failed} inner=${r.inner}`);
      check(`${name} x${N}: the page is never resized or relaid out`, r.resize === 0 && r.ro === 0 && r.vv === 0 && r.sizes.length <= 1, JSON.stringify(r));
      // (a full page is sewn from the window's own pictures, so the page scrolls while it is taken: it must end where it was, and no scroll event may come after)
      const full = /full-page/.test(name);
      check(`${name} x${N}: the scroll position stays put`, r.scrollY === 700 && r.lastScroll === 700 && (full || r.jumps === 0), JSON.stringify(r));
      check(`${name} x${N}: every capture gave a picture`, r.failed === 0, JSON.stringify(r));
    }
    // the sewn picture is the whole page once: the fixed header only at the top, the green end at the bottom, as tall as the page
    const sewn = await app.evaluate(async ({ nativeImage, webContents }, [tid]) => {
      const wc = webContents.fromId(global.__notifyClick.contentsOf(tid));
      const r = await global.__screenshot.tool.capture(global.__screenshot.ctx(wc), 'full');
      const img = nativeImage.createFromPath(r.path);
      const { width, height } = img.getSize();
      const bmp = img.toBitmap();
      let magenta = 0;
      for (let y = 0; y < height; y++) { const o = (y * width + 5) * 4; if (bmp[o + 2] > 200 && bmp[o + 1] < 60 && bmp[o] > 200) magenta++; }
      const o = ((height - 5) * width + 5) * 4;
      return { width, height, magenta, bottom: [bmp[o + 2], bmp[o + 1], bmp[o]] };
    }, [tabId]).catch((e) => ({ error: String(e) }));
    if (process.env.SHOW_COUNTS) console.log('SEWN ' + JSON.stringify(sewn));
    check('the sewn full page is 3000 css px tall, the fixed header drawn once, the green end at the bottom', !sewn.error && Math.abs(sewn.height / 3000 - Math.round(sewn.height / 3000 * 4) / 4) < 0.01 && sewn.height >= 2990 && Math.abs(sewn.magenta - 40 * sewn.height / 3000) <= 3 && sewn.bottom[1] > 150 && sewn.bottom[0] < 60, JSON.stringify(sewn));
    // overlapping captures, as in one AI step with the card's thumbnails running beside it
    const burst = await measure("await Promise.all([snap.execute(shot.agent, 'screenshot', {}, shot.h), snap.execute(shot.agent, 'screenshot', {}, shot.h), cap.captureThumb(wc, {}), cap.captureThumb(wc, { lowRes: true })]);", 3);
    if (process.env.SHOW_COUNTS) console.log(`COUNT burst: ${JSON.stringify(burst)}`);
    check('a burst of overlapping captures does not resize the page either', burst.resize === 0 && burst.ro === 0 && burst.vv === 0 && burst.scrollY === 700, JSON.stringify(burst));
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
