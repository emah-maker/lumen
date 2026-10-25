// The AI sidebar's slide over a web page, hidden (LUMEN_TEST_BACKGROUND=1), at device pixel ratio 1 and 1.5 (a laptop with display scaling).
// Measures, per open and close: click -> the first frame that moves, every frame time of the slide, click -> the live view back and the still
// image gone. Then compares the still image the UI shows (the window's own capture, view hidden) with the page's own capture, pixel for pixel.
//   - the slide's first frame is within ~2 frame budgets of the click (the capture is not waited for);
//   - no frame over 50 ms during the slide;
//   - the page never goes blank (the live view is hidden only while the image is painted) and the live view is back after the slide;
//   - at DPR 1.5 the still image matches the live page (no resample blur, no shift, no scale): mean difference under a threshold.
// LUMEN_SLIDE_PNG=<dir> saves the live, still and final frames as PNGs. Numbers are printed as `MEASURE ...` lines.
require('../helpers/_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(40); } return v; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };

// A page that looks like one: header, fixed-width left column of fine text and rules (the part the sidebar never covers), cards, a gradient.
const PAGE = `<!doctype html><title>Page</title><body style="margin:0;font:15px/1.5 Segoe UI,Arial,sans-serif;background:#fff;color:#222">
<div style="height:56px;background:#1a3a6e;color:#fff;display:flex;align-items:center;padding:0 24px;font-size:20px">Example News</div>
<div style="display:flex"><div style="width:560px;padding:24px;flex:none">${Array.from({ length: 14 }, (_, i) => `<h3 style="margin:14px 0 4px;font-size:${17 + (i % 3)}px">Headline number ${i + 1}, set in a heading</h3><p style="margin:0;border-bottom:1px solid #ccd">Body copy at fifteen pixels with <a href="#" style="color:#0645ad">a link</a> and <b>bold words</b>, wrapping onto a second line so the text has real glyph edges to compare.</p>`).join('')}</div>
<div style="flex:1;padding:24px;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;align-content:start">${Array.from({ length: 24 }, (_, i) => `<div style="height:120px;background:linear-gradient(135deg,hsl(${i * 15},70%,70%),hsl(${i * 15 + 40},70%,50%));border-radius:8px"></div>`).join('')}</div></div></body>`;

async function run(dpr) {
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-slide-'));
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ sidebarNewChat: false, performanceMode: 'off' }));
  const app = await electron.launch({ args: [`--force-device-scale-factor=${dpr}`, path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  const tag = `dpr${dpr}`;
  const pngDir = process.env.LUMEN_SLIDE_PNG;
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await ui.evaluate(() => window.assistant.setAutoGroup(false));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
    await app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => t.webContents.once('did-finish-load', r)); }, base);
    await sleep(1500);
    const settled = (open) => waitFor(() => ui.evaluate((o) => {
      const b = document.body;
      return document.getElementById('toggle-sidebar').getAttribute('aria-pressed') === String(o) && !b.classList.contains('sidebar-moving') && b.classList.contains('sidebar-hidden') === !o && !document.querySelector('.page-snapshot');
    }, open), 6000);
    if (!(await ui.evaluate(() => document.body.classList.contains('sidebar-hidden')))) { await ui.evaluate(() => document.getElementById('toggle-sidebar').click()); await settled(false); }
    const realDpr = await ui.evaluate(() => window.devicePixelRatio);
    check(`[${tag}] the window runs at the device pixel ratio asked for`, Math.abs(realDpr - dpr) < 0.01, realDpr);

    // main-side helpers: the page view's visibility sampled every 4 ms; a pixel diff of two captures
    await app.evaluate(({ BrowserWindow, nativeImage }) => {
      global.__vw = () => { const w = BrowserWindow.getAllWindows()[0]; const wc = global.__agent.browser.activeTab(); return w.contentView.children.find((c) => c.webContents && c.webContents === wc.webContents); };
      global.__shot = async (which, rect) => { // rect in CSS px
        const w = BrowserWindow.getAllWindows()[0];
        const img = which === 'ui' ? await w.webContents.capturePage(rect) : await global.__agent.browser.activeTab().webContents.capturePage(rect);
        const { width, height } = img.getSize();
        global.__last = global.__last || {};
        global.__last[which] = { buf: img.toBitmap(), width, height, png: img.toPNG() };
        return { width, height };
      };
      global.__diff = (a, b) => {
        const A = global.__last[a], B = global.__last[b];
        if (A.width !== B.width || A.height !== B.height) return { sizeMismatch: [A.width, A.height, B.width, B.height] };
        let sum = 0, bad = 0, lsum = 0, n = A.width * A.height;
        for (let i = 0; i < A.buf.length; i += 4) { const d = (Math.abs(A.buf[i] - B.buf[i]) + Math.abs(A.buf[i + 1] - B.buf[i + 1]) + Math.abs(A.buf[i + 2] - B.buf[i + 2])) / 3; sum += d; if (d > 24) bad++; lsum += Math.abs((0.114 * (A.buf[i] - B.buf[i])) + (0.587 * (A.buf[i + 1] - B.buf[i + 1])) + (0.299 * (A.buf[i + 2] - B.buf[i + 2]))); }
        const shifts = {};
        if (process.env.LUMEN_SLIDE_SHIFT) for (const dy of [-2, -1, 0, 1, 2]) for (const dx of [-2, -1, 0, 1, 2]) { let t = 0, c = 0; for (let y = 4; y < A.height - 4; y++) for (let x = 4; x < A.width - 4; x++) { const i = (y * A.width + x) * 4, j = ((y + dy) * A.width + x + dx) * 4; t += (Math.abs(A.buf[i] - B.buf[j]) + Math.abs(A.buf[i + 1] - B.buf[j + 1]) + Math.abs(A.buf[i + 2] - B.buf[j + 2])) / 3; c++; } shifts[dx + ',' + dy] = +(t / c).toFixed(2); }
        return { mean: sum / n, luma: lsum / n, badFrac: bad / n, width: A.width, height: A.height, shifts };
      };
    });

    const measure = async (open, label, mouse = false) => {
      await app.evaluate(() => { global.__samples = []; global.__sampler = setInterval(() => { const v = global.__vw(); global.__samples.push({ at: Date.now(), visible: Boolean(v?.getVisible()), w: v ? v.getBounds().width : 0 }); }, 4); });
      await ui.evaluate(() => {
        window.__f = []; window.__stop = false; window.__ev = {};
                let last = performance.now();
        const tick = (now) => {
          const e = window.__ev;
          if (e.click != null && e.first == null && document.body.classList.contains('sidebar-moving')) e.first = now;
          if (e.click != null && e.snap == null && document.querySelector('.page-snapshot')) e.snap = now;
          window.__f.push({ wall: Date.now(), t: now, dt: now - last, snap: Boolean(document.querySelector('.page-snapshot')), moving: document.body.classList.contains('sidebar-moving') });
          last = now;
          if (!window.__stop) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await sleep(120);
      // mouse: a real press starts the capture on pointerdown and the click follows ~70 ms later; keyboard (Ctrl+J): the click alone
      const clickWall = await ui.evaluate(async (m) => {
        const b = document.getElementById('toggle-sidebar');
        if (m) { b.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true })); await new Promise((r) => setTimeout(r, 70)); }
        window.__ev.click = performance.now(); const w = Date.now(); b.click(); return w;
      }, mouse);
      // the still image and the live page, captured when the image is up (the view is hidden then)
      let snapDiff = null;
      const sawSnap = await waitFor(() => ui.evaluate(() => Boolean(document.querySelector('.page-snapshot'))), 1500);
      if (sawSnap && open) {
        const body = await ui.evaluate(() => { const b = document.getElementById('viewport').getBoundingClientRect(); return { x: b.left, y: b.top }; });
        const r2 = { x: Math.round(body.x), y: Math.round(body.y) + 90, width: 520, height: 560 };
        await app.evaluate(async () => { await global.__shot('page', { x: 0, y: 90, width: 520, height: 560 }); });
        await app.evaluate(async (_e, r) => { await global.__shot('ui', r); }, r2);
        snapDiff = await app.evaluate(() => global.__diff('page', 'ui'));
        if (pngDir) { fs.mkdirSync(pngDir, { recursive: true }); fs.writeFileSync(path.join(pngDir, `${label}-${tag}-live.png`), await app.evaluate(() => global.__last.page.png)); fs.writeFileSync(path.join(pngDir, `${label}-${tag}-still.png`), await app.evaluate(() => global.__last.ui.png)); }
      }
      await settled(open);
      await sleep(300);
      let finalDiff = null;
      if (sawSnap && open) { // the live page back at its final size, against the live page before the slide: the fixed-width column must not have moved
        await app.evaluate(async () => { await global.__shot('final', { x: 0, y: 90, width: 520, height: 560 }); });
        finalDiff = await app.evaluate(() => global.__diff('page', 'final'));
        if (pngDir) fs.writeFileSync(path.join(pngDir, `${label}-${tag}-final.png`), await app.evaluate(() => global.__last.final.png));
      }
      const back = await app.evaluate(() => { clearInterval(global.__sampler); return global.__samples; });
      const ev = await ui.evaluate(() => { window.__stop = true; return { ev: window.__ev, frames: window.__f }; });
      const frames = ev.frames.filter((f) => f.t >= ev.ev.click);
      const slide = frames.filter((f, i) => f.moving || (i > 0 && frames[i - 1].moving));
      const dts = slide.map((f) => f.dt);
      const firstMs = ev.ev.first != null ? ev.ev.first - ev.ev.click : null;
      // blank: a stretch of samples with the view hidden while no still image is up
      const snapAt = (at) => { let hit = null; for (const f of ev.frames) { if (f.wall <= at + 17) hit = f; else break; } return Boolean(hit?.snap); };
      const hiddenRun = (() => { let best = 0, run = 0; for (const s of back) { run = !s.visible && !snapAt(s.at) ? run + 1 : 0; best = Math.max(best, run); } return best; })();
      const finalView = back[back.length - 1];
      // when the live view came back (first visible sample after the last hidden one)
      let lastHidden = -1; back.forEach((s, i) => { if (!s.visible) lastHidden = i; });
      const liveBack = lastHidden >= 0 && back[lastHidden + 1] ? back[lastHidden + 1].at - clickWall : (lastHidden < 0 ? 0 : null);
      const snapGone = (() => { const last = frames.filter((f) => f.snap).pop(); return last ? last.t - ev.ev.click : null; })();
      const out = { first: firstMs && Math.round(firstMs), snap: ev.ev.snap && Math.round(ev.ev.snap - ev.ev.click), frames: slide.length, maxDt: Math.round(Math.max(0, ...dts)), p95: Math.round(pct(dts, 0.95)), over50: dts.filter((d) => d > 50).length, liveBack, snapGone: snapGone && Math.round(snapGone), hiddenRun, snapDiff, finalDiff };
      console.log(`MEASURE ${tag} ${label} ${JSON.stringify(out)}`);
      return { ...out, finalVisible: finalView?.visible };
    };

    const results = [];
    for (let i = 0; i < 3; i++) {
      const o = await measure(true, `open${i}${i === 2 ? '-key' : ''}`, i !== 2);
      results.push(['open', o, i === 2 ? 'key' : 'mouse']);
      const c = await measure(false, `close${i}${i === 2 ? '-key' : ''}`, i !== 2);
      results.push(['close', c, i === 2 ? 'key' : 'mouse']);
    }
    const opens = results.filter((r) => r[0] === 'open').map((r) => r[1]);
    const all = results.map((r) => r[1]);
    const mouseRuns = all.filter((o, i) => results[i][2] !== 'key'), keyRuns = all.filter((o, i) => results[i][2] === 'key');
    check(`[${tag}] mouse: the slide starts within 2 frames (34 ms) of the click (the capture began on pointerdown)`, mouseRuns.every((o) => o.first != null && o.first <= 34), JSON.stringify(mouseRuns.map((o) => o.first)));
    check(`[${tag}] keyboard: the slide starts within 100 ms of the key (capture, encode and decode, no paint wait)`, keyRuns.every((o) => o.first != null && o.first <= 100), JSON.stringify(keyRuns.map((o) => o.first)));
    check(`[${tag}] no frame over 50 ms during the slide`, all.every((o) => o.maxDt <= 50), JSON.stringify(all.map((o) => o.maxDt)));
    check(`[${tag}] the page is never blank and ends visible`, all.every((o) => o.hiddenRun < 4 && o.finalVisible), JSON.stringify(all.map((o) => [o.hiddenRun, o.finalVisible])));
    const diffs = opens.map((o) => o.snapDiff).filter(Boolean);
    check(`[${tag}] a still image was shown for every open`, diffs.length === opens.length, `${diffs.length}/${opens.length}`);
    const worst = diffs.reduce((m, d) => (d.luma > (m?.luma ?? -1) ? d : m), null);
    check(`[${tag}] the still image is the live page at the same size and place (luma difference under 1.6, colour under 5; JPEG smooths the colour fringes of LCD text)`, diffs.every((d) => !d.sizeMismatch && d.luma < 1.6 && d.mean < 5 && d.badFrac < 0.08), JSON.stringify(worst));
    const finals = opens.map((o) => o.finalDiff).filter(Boolean);
    check(`[${tag}] the live page that comes back is where the page was (no shift or rescale)`, finals.length === opens.length && finals.every((d) => !d.sizeMismatch && d.mean < 0.5), JSON.stringify(finals[0]));
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
}

(async () => {
  const hard = setTimeout(() => { console.error('hard timeout'); process.exit(2); }, 5 * 60 * 1000);
  for (const dpr of [1, 1.5]) await run(dpr);
  clearTimeout(hard);
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
