// A playing video still has a picture after its tab was left and came back (hidden: LUMEN_TEST_BACKGROUND, a fresh profile, a private TEMP).
// Report: "the video plays, the clock runs, the captions show, but the picture is black" after switching to another tab and back.
// The test records its own clips in a page (MediaRecorder: VP9 WebM and, where the build has it, H.264 MP4), serves them from 127.0.0.1, and for each
// case (progressive MP4, progressive WebM, MSE, a video in a cross-origin iframe, a live canvas stream) checks, in tab A:
//   - the picture is not black before the switch (drawImage of the video into a canvas, AND a capturePage of the view: the second sees what the
//     compositor drew, the first only what the decoder produced);
//   - after tab B was in front for a few seconds, and tab A is shown again, a capturePage of A is not black within 300 ms, and stays so;
//   - the video's frames keep advancing (requestVideoFrameCallback) and its currentTime moves;
// with the sidebar closed and open, and with the tab in the "kept ready" set (setBackgroundThrottling(false)) and outside it.
// LUMEN_ROOT=<another checkout> runs the same checks against that code (the code before a change).
require('./_tmp-cleanup');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch } = require('./_electron-direct');

const root = process.env.LUMEN_ROOT || path.join(__dirname, '..'); // (LUMEN_ROOT: another checkout, e.g. the code before a change)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The clip generator: moving coloured squares on a bright ground, 2.5 s, recorded in the page and posted back.
const GEN = `<!doctype html><title>gen</title><canvas id=c width=320 height=180></canvas><script>
const c = document.getElementById('c'), x = c.getContext('2d');
let k = 0; (function f() { x.fillStyle = 'hsl(' + ((k * 4) % 360) + ',80%,55%)'; x.fillRect(0, 0, 320, 180); x.fillStyle = '#fff'; x.fillRect((k * 5) % 280, 60, 40, 60); x.fillStyle = '#103'; x.fillRect(10, 10, 60, 30); k++; requestAnimationFrame(f); })();
async function rec(name, mime, ext) {
  if (!MediaRecorder.isTypeSupported(mime)) return name + ':unsupported';
  const r = new MediaRecorder(c.captureStream(30), { mimeType: mime, videoBitsPerSecond: 1500000 }); const parts = [];
  r.ondataavailable = (e) => parts.push(e.data); const done = new Promise((res) => { r.onstop = res; });
  r.start(250); await new Promise((res) => setTimeout(res, 3000)); r.stop(); await done;
  const blob = new Blob(parts, { type: mime.split(';')[0] });
  await fetch('/save/' + name + '.' + ext, { method: 'POST', body: blob });
  return name + ':' + blob.size;
}
window.__done = (async () => [
  await rec('vp9', 'video/webm;codecs=vp9', 'webm'),
  await rec('h264', 'video/mp4;codecs=avc1.42E01E', 'mp4'),
  await rec('h264b', 'video/webm;codecs=h264', 'h264.webm'),
])();
</script>`;

const SAMPLE = `
  window.__sample = () => {
    const v = document.getElementById('v'); const c = document.createElement('canvas'); c.width = 64; c.height = 36;
    const x = c.getContext('2d'); x.drawImage(v, 0, 0, 64, 36); const d = x.getImageData(0, 0, 64, 36).data; let s = 0;
    for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3; return s / (d.length / 4);
  };
  window.__vis = [];
  document.getElementById('v').addEventListener('ended', () => { const v = document.getElementById('v'); v.currentTime = 0; v.play(); }); // (a MediaRecorder clip has no duration: loop does not restart it)
  document.addEventListener('visibilitychange', () => window.__vis.push([document.visibilityState, Math.round(performance.now())]));
  window.__frames = 0; (function cb() { document.getElementById('v').requestVideoFrameCallback(() => { window.__frames++; cb(); }); })();
  window.__ready = () => { const v = document.getElementById('v'); return v.readyState >= 2 && !v.paused && v.currentTime > 0.3; };`;

const mseScript = (url, mime) => `<script>
  const v = document.getElementById('v'); const ms = new MediaSource(); v.src = URL.createObjectURL(ms);
  ms.addEventListener('sourceopen', async () => {
    const sb = ms.addSourceBuffer(${JSON.stringify(mime)}); const buf = await (await fetch(${JSON.stringify(url)})).arrayBuffer();
    // appended in 64 KB pieces, like a segmented stream
    for (let o = 0; o < buf.byteLength; o += 65536) { sb.appendBuffer(buf.slice(o, o + 65536)); await new Promise((r) => sb.addEventListener('updateend', r, { once: true })); }
    try { ms.endOfStream(); } catch (e) {} v.loop = true; v.play();
  });</script>`;

function server(media) {
  const s = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'POST' && u.pathname.startsWith('/save/')) {
      const chunks = []; req.on('data', (d) => chunks.push(d)); req.on('end', () => { media.set(u.pathname.slice(6), Buffer.concat(chunks)); res.end('ok'); }); return;
    }
    if (u.pathname.startsWith('/media/')) {
      const b = media.get(u.pathname.slice(7));
      if (!b) { res.statusCode = 404; return res.end(); }
      res.setHeader('Content-Type', u.pathname.endsWith('.mp4') ? 'video/mp4' : 'video/webm'); res.setHeader('Access-Control-Allow-Origin', '*');
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (m) { const a = +m[1], z = m[2] ? +m[2] : b.length - 1; res.statusCode = 206; res.setHeader('Content-Range', `bytes ${a}-${z}/${b.length}`); res.setHeader('Content-Length', z - a + 1); return res.end(b.subarray(a, z + 1)); }
      res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Length', b.length); return res.end(b);
    }
    res.setHeader('Content-Type', 'text/html');
    const w = '<style>html,body{margin:0;background:#00f}video{display:block;width:320px;height:180px}</style>';
    const src = u.searchParams.get('src');
    if (u.pathname === '/gen') return res.end(GEN);
    if (u.pathname === '/plain') return res.end('<!doctype html><title>Other</title><body style="font:16px sans-serif"><h1>Other tab</h1>');
    if (u.pathname === '/prog') return res.end(`<!doctype html><title>Prog</title>${w}<video id=v src="/media/${src}" muted autoplay loop></video><script>${SAMPLE}</script>`);
    if (u.pathname === '/mse') return res.end(`<!doctype html><title>Mse</title>${w}<video id=v muted autoplay loop></video><script>${SAMPLE}</script>${mseScript('/media/' + src, u.searchParams.get('mime'))}`);
    if (u.pathname === '/live') return res.end(`<!doctype html><title>Live</title>${w}<canvas id=c width=320 height=180 style="display:none"></canvas><video id=v muted autoplay loop></video><script>${SAMPLE}
      const c=document.getElementById('c'),x=c.getContext('2d');let k=0;(function f(){x.fillStyle='hsl('+((k++*4)%360)+',80%,55%)';x.fillRect(0,0,320,180);requestAnimationFrame(f);})();
      const v=document.getElementById('v');v.srcObject=c.captureStream(30);v.play();</script>`);
    if (u.pathname === '/frame') return res.end(`<!doctype html><title>Frame</title><body style="margin:0"><iframe id=f src="${u.searchParams.get('inner')}" style="border:0;width:320px;height:180px"></iframe>
      <script>window.__vis=[];addEventListener('message',(e)=>{if(e.data&&e.data.k==='r'){window.__inner=e.data}});</script>`);
    if (u.pathname === '/inner') return res.end(`<!doctype html><title>Inner</title>${w}<video id=v src="/media/${src}" muted autoplay loop></video><script>${SAMPLE}
      addEventListener('message',(e)=>{ if(e.data==='s') parent.postMessage({k:'r',lum:window.__sample(),frames:window.__frames,vis:window.__vis,ready:window.__ready()},'*'); });</script>`);
    res.statusCode = 404; res.end();
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ s, port: s.address().port })));
}

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const verbose = Boolean(process.env.VF_VERBOSE);
  const hard = setTimeout(() => { console.error('hard timeout'); process.exit(2); }, 12 * 60 * 1000);
  const media = new Map();
  const { s, port } = await server(media);
  const origin = `http://127.0.0.1:${port}`;
  const other = `http://localhost:${port}`; // a second origin: the iframe is cross-origin to its page
  // Not through Playwright: its CDP attachment keeps every page 'visible', so a tab left for another one never became hidden in a test, and the
  // bug (a picture lost across hide and show) could not happen. --disable-backgrounding-occluded-windows: the off-screen test window is not "covered".
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-videoframes-'));
  const profile = path.join(tmp, 'profile'); const childTemp = path.join(tmp, 'tmp');
  fs.mkdirSync(profile); fs.mkdirSync(childTemp);
  const app = await launch({ root, extraArgs: ['--disable-backgrounding-occluded-windows'], env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test', TEMP: childTemp, TMP: childTemp, TMPDIR: childTemp } });
  for (let i = 0; i < 100; i++) { if (await app.evaluate(() => Boolean(global.__aiTabs && global.__agent)).catch(() => false)) break; await sleep(200); }
  await sleep(1500);
  const r = { app, errors: [] };
  const open = (url) => app.evaluate(async (_e, u) => {
    const t = global.__agent.browser.openTab(u);
    await new Promise((res) => { t.webContents.once('did-stop-loading', res); setTimeout(res, 5000); });
    return t.id;
  }, url);
  const show = (id) => app.evaluate((_e, tab) => global.__aiTabs.switchTo(tab), id);
  const inPage = (id, js) => app.evaluate((_e, a) => global.__aiTabs.tab(a.id).view.webContents.executeJavaScript(a.js), { id, js });
  // What the compositor drew over the video's rectangle: mean brightness and spread, from capturePage.
  const shot = (id) => app.evaluate(async (_e, tab) => {
    const wc = global.__aiTabs.tab(tab).view.webContents;
    const img = await Promise.race([wc.capturePage({ x: 20, y: 20, width: 280, height: 140 }).catch(() => null), new Promise((res) => setTimeout(() => res(null), 1500))]); // (a busy GPU can fail one capture: a missing sample, never a black one)
    if (!img || img.isEmpty()) return { lum: -1, ground: 0, missing: true };
    const b = img.toBitmap(); let s = 0, ground = 0; const n = b.length / 4;
    for (let i = 0; i < b.length; i += 4) { s += (b[i] + b[i + 1] + b[i + 2]) / 3; if (b[i] > 247 && b[i + 1] < 8 && b[i + 2] < 8) ground++; } // (BGRA bytes: the page ground is pure blue)
    return { lum: s / n, ground: ground / n };
  }, id);
  const BLACK = 12;
  const good = (sh) => sh.lum > BLACK && sh.ground < 0.5; // a picture: not black, and not the page's own ground showing where the video should be // mean brightness at or under this is a black picture (the clips are bright)

  try {
    // 1. record the clips
    const gen = await open(`${origin}/gen`);
    const made = await inPage(gen, 'window.__done');
    console.log('clips:', made.join(' '));
    await app.evaluate((_e, id) => global.__aiTabs.close([id]), gen).catch(() => {});
    const hasMp4 = media.has('h264.mp4');
    const clips = [['vp9.webm', 'video/webm; codecs="vp9"'], hasMp4 && ['h264.mp4', 'video/mp4; codecs="avc1.42E01E"'], media.has('h264b.h264.webm') && ['h264b.h264.webm', 'video/webm; codecs="h264"']].filter(Boolean);
    check('a VP9 WebM clip was recorded', media.has('vp9.webm') && media.get('vp9.webm').length > 5000, made.join(' '));

    const cases = [];
    for (const [file, mime] of clips) {
      cases.push({ name: `progressive ${file}`, url: `${origin}/prog?src=${file}`, how: 'page' });
      if (!file.startsWith('h264b')) cases.push({ name: `MSE ${file}`, url: `${origin}/mse?src=${file}&mime=${encodeURIComponent(mime)}`, how: 'page' });
    }
    cases.push({ name: 'cross-origin iframe (VP9)', url: `${origin}/frame?inner=${encodeURIComponent(`${other}/inner?src=vp9.webm`)}`, how: 'frame' });
    cases.push({ name: 'live canvas stream', url: `${origin}/live`, how: 'page' });

    const sidebarOf = (id, on) => app.evaluate((_e, a) => { global.__tabChats.setSidebar(a.id, a.on); }, { id, on }).catch(() => {});
    const variants = [
      { label: 'sidebar closed, tab not kept ready', sidebar: false, ready: false },
      { label: 'sidebar open, tab not kept ready', sidebar: true, ready: false },
      ...(process.env.VF_NO_READY ? [] : [{ label: 'sidebar closed, tab kept ready', sidebar: false, ready: true }]), // (VF_NO_READY=1: a checkout from before tabs were kept ready)
    ];
    const other1 = await open(`${origin}/plain`);

    for (const v of variants) {
      await app.evaluate((_e, on) => { if (global.__tabReady) { global.__tabReady.enable(on); global.__tabReady.battery(false); } }, v.ready);
      for (const c of cases) {
        const id = await open(c.url);
        await show(id); await sleep(300);
        if (v.sidebar) { await sidebarOf(id, true); await sleep(300); }
        const probe = (js) => (c.how === 'frame' ? inPage(id, `(async()=>{const f=document.getElementById('f');window.__inner=null;f.contentWindow.postMessage('s','*');for(let i=0;i<30&&!window.__inner;i++)await new Promise(r=>setTimeout(r,20));return window.__inner||{}})()`) : inPage(id, js));
        let playing = false;
        for (let i = 0; i < 40 && !playing; i++) { await sleep(150); const p = await probe('({ready: window.__ready(), lum: window.__sample(), frames: window.__frames, vis: window.__vis})').catch(() => ({})); playing = p.ready; }
        const before = await probe('({lum: window.__sample(), frames: window.__frames})');
        const shotBefore = await shot(id);
        const tag = `${c.name} [${v.label}]`;
        const roundTag = (n) => (v.ready ? ` round ${n}` : '');
        check(`${tag}: plays, picture not black before switching (canvas ${Math.round(before.lum)}, view ${Math.round(shotBefore.lum)})`, playing && before.lum > BLACK && good(shotBefore), JSON.stringify({ playing, before, shotBefore }));
        for (let round = 1; round <= (v.ready ? 2 : 1); round++) {
          // away to B for a few seconds, then back (a tab kept ready: twice, the second time with its boost set again while it was away)
          await show(other1); await sleep(100);
          const hiddenState = await inPage(id, 'document.visibilityState').catch(() => '?');
          const f0 = (await probe('({frames: window.__frames})')).frames;
          await sleep(2500);
          const boosted = await app.evaluate((_e, tab) => !global.__aiTabs.tab(tab).view.webContents.backgroundThrottling, id);
          if (v.ready) check(`${tag}${roundTag(round)}: kept ready while away (background throttling off)`, boosted, `${boosted}`);
          await show(id);
          const t0 = Date.now(); const samples = []; let firstOk = null;
          while (Date.now() - t0 < 2000) {
            const sh = await shot(id); const t = Date.now() - t0; if (sh.missing) { await sleep(40); continue; } samples.push([t, Math.round(sh.lum), good(sh)]);
            if (firstOk == null && good(sh)) firstOk = t;
            await sleep(60);
          }
          const after = await probe('({lum: window.__sample(), frames: window.__frames, t: document.getElementById("v").currentTime, vis: window.__vis})');
          const adv = await (async () => { const a = (await probe('({frames: window.__frames})')).frames; await sleep(1500); return (await probe('({frames: window.__frames})')).frames - a; })();
          if (verbose || firstOk == null || firstOk > 300) console.log(`  ${tag}${roundTag(round)}: hidden state '${hiddenState}', visibility events ${JSON.stringify(after.vis)}, frames ${f0} -> ${after.frames}, samples ${samples.slice(0, 14).map((x) => x.join(':')).join(' ')}`);
          check(`${tag}${roundTag(round)}: the tab really was hidden while away (visibilityState '${hiddenState}')`, hiddenState === 'hidden', hiddenState);
          check(`${tag}${roundTag(round)}: picture is back within 300 ms of switching to the tab (first non-black at ${firstOk} ms)`, firstOk != null && firstOk <= 300, JSON.stringify(samples.slice(0, 10)));
          check(`${tag}${roundTag(round)}: ...and stays (no black sample after it)`, firstOk != null && samples.filter(([t]) => t > firstOk).every(([, , g]) => g), JSON.stringify(samples));
          check(`${tag}${roundTag(round)}: ...and the picture moves (${new Set(samples.map((x) => x[1])).size} different brightness values in 2 s: a frozen frame is one)`, new Set(samples.map((x) => x[1])).size >= 4, JSON.stringify(samples));
          check(`${tag}${roundTag(round)}: ...decoded frames keep coming (${adv} in 1.5 s)`, adv > 6, `${adv}`);
        }
        await app.evaluate((_e, tab) => global.__aiTabs.close([tab]), id).catch(() => {});
        await sleep(300);
      }
      await show(other1); await sleep(200);
    }
  } finally {
    clearTimeout(hard);
    try { await app.close(); } catch { /* gone */ }
    s.close();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nAll passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
