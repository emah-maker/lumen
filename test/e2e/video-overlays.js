// [video overlays] On Windows, Lumen draws videos without the hardware overlay planes (main.js: --disable-direct-composition). An overlay plane
// sits above everything and ignores the page's clipping: with Lumen's stacked views on a hybrid-GPU laptop, Muse's avatar video came out as a
// gray rectangle over the page. In the app, hidden (LUMEN_TEST_BACKGROUND=1):
//   - Chromium's own overlay info says no overlays (supportsOverlays false, every format NONE): the switch reached the GPU process
//   - drawing is still on the GPU (gpu_compositing and rasterization hardware), and a page with a playing video still renders
// Elsewhere it only reports: the switch is Windows-only.
const { _electron: electron } = require('playwright-core');
const path = require('path'); const fs = require('fs'); const os = require('os'); const http = require('http');
require('../helpers/_tmp-cleanup');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000, step = 60) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await Promise.resolve(fn()).catch(() => null); if (v) return v; await sleep(step); } return v; };

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
  // A page with a playing video: a canvas stream, so no media file is needed.
  const page = '<!doctype html><title>Video</title><body style="margin:0;background:#fff"><h1>A video page</h1><video id="v" muted autoplay playsinline width="480" height="270" style="position:absolute;right:0;top:0"></video><script>'
    + 'const c=document.createElement("canvas");c.width=480;c.height=270;const g=c.getContext("2d");let n=0;setInterval(()=>{g.fillStyle=`hsl(${n++%360} 80% 50%)`;g.fillRect(0,0,480,270)},33);'
    + 'const v=document.getElementById("v");v.srcObject=c.captureStream(30);v.play();</script>';
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(page); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;
  const app = await electron.launch({ args: [path.join(__dirname, '..', '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-overlays-')), ANTHROPIC_API_KEY: 'sk-ant-test' } });
  try {
    const ui = await app.firstWindow(); await ui.waitForSelector('.tab');
    const tab = await app.evaluate(async (_e, u) => { const t = global.__agent.browser.openTab(u); await new Promise((r) => t.webContents.once('did-finish-load', r)); return t.id; }, pageUrl);
    await app.evaluate((_e, i) => global.__agent.browser.switchTab(i), tab);
    const playing = await waitFor(() => app.evaluate(() => global.__agent.browser.activeTab().webContents.executeJavaScript('(() => { const v = document.getElementById("v"); return v && !v.paused && v.currentTime > 0.3; })()')), 8000);
    const gpu = await app.evaluate(async ({ app: a }) => ({ on: a.isHardwareAccelerationEnabled(), status: a.getGPUFeatureStatus(), overlay: (await a.getGPUInfo('complete')).auxAttributes?.overlayInfo || null }));
    console.log(`INFO  overlayInfo ${JSON.stringify(gpu.overlay)}; gpu_compositing=${gpu.status.gpu_compositing}, rasterization=${gpu.status.rasterization}`);
    check('a page with a playing video renders', playing === true, playing);
    check('drawing is still on the GPU (compositing and rasterization hardware)', gpu.on && /^enabled/.test(gpu.status.gpu_compositing) && /^enabled/.test(gpu.status.rasterization), JSON.stringify(gpu.status));
    if (process.platform === 'win32') {
      const o = gpu.overlay || {};
      const formats = Object.entries(o).filter(([k]) => /OverlaySupport$/.test(k));
      check('Windows: Chromium reports no overlay planes (supportsOverlays false, no DirectComposition)', o.supportsOverlays === false && o.directComposition === false, JSON.stringify(o));
      check('...and no video format may go to one', formats.length > 0 && formats.every(([, v]) => v === 'NONE'), JSON.stringify(formats));
    } else console.log(`SKIP  overlay planes: Windows only (${process.platform})`);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
