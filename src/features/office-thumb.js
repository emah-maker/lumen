// ---------- first-page thumbnails of Word, Excel and PowerPoint files ----------
// One small picture per file, for every place that shows a file without opening it: an AI file card, a file chip in the chat box, the Files list, a
// download. The picture is the real viewer's own drawing (office.html for .docx and .xlsx, slides.html for .pptx), so it looks like what Open shows:
// the first page, the top-left cells of the first sheet, the first slide. A hidden window loads the viewer page, main hands it the parsed file
// (features/office-viewer.js, slides-viewer.js: the first slide only, or the first screenful), and the window is captured and shrunk to a PNG.
//
//   create({ BrowserWindow, cacheDir, officeRender, slidesRender, encrypt, decrypt, available })
//     .thumbOf(file) -> Promise<{ dataUrl, w, h } | null>    `file` is an absolute path Lumen already trusts (a card's, an upload's, a Files entry)
//
// The window is as locked down as a tab showing the same page: sandboxed, no preload and no Node, no permissions, no windows, no navigation, no
// network (only the viewer page itself and data: pictures load), a private in-memory session. Files are drawn one at a time (a queue), the window is
// closed after 20 s idle, and a picture is kept by path, size and time: in memory for the session and, encrypted with the system's keychain (the way the
// Files list and the chats are: deps.encrypt), on disk (cacheDir) across runs. A page of a document is content, so with no keychain nothing goes to disk.
// Failures (a damaged file, too big, a window that never painted) are null, never an error: the caller shows its plain icon.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const fileTabs = require('./file-tabs');

const VERSION = 2; // bump when the drawing or sizes change: old pictures on disk are not reused
const SIZES = { docx: { w: 816, h: 1056, out: 408 }, xlsx: { w: 960, h: 600, out: 480 }, pptx: { w: 960, h: 540, out: 480 } }; // the window, and the picture's width
const KIND_OF = { docx: 'docx', xlsx: 'xlsx', pptx: 'pptx' };
const MAX_BYTES = { docx: 100 * 1024 * 1024, xlsx: 100 * 1024 * 1024, pptx: 300 * 1024 * 1024 };
const WORK_MS = 20000; // one picture's whole time
const IDLE_MS = 20000;
const MEMORY_MAX = 60;
const DISK_MAX = 300;

const extOf = (file) => { const m = /\.([A-Za-z0-9]{1,6})$/.exec(String(file)); return m ? m[1].toLowerCase() : ''; };
const isOfficeFile = (file) => Boolean(KIND_OF[extOf(file)]);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits for the viewer page to say it is ready, its pictures to load and two frames to paint; null on timeout.
const READY = `new Promise((resolve) => {
  const t0 = Date.now();
  const settled = () => { const r = document.body && document.body.dataset.ready; const slides = document.querySelector('#slides'); return (r === 'true' || r === 'error') && (!slides || r === 'error' || document.querySelector('.stage')) && [...document.images].every((i) => i.complete); };
  const finish = () => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
  (function tick() { if (settled()) setTimeout(() => (settled() ? finish() : tick()), 250); else if (Date.now() - t0 > 6000) resolve(false); else setTimeout(tick, 40); })();
})`;
// The slide viewer's own chrome and the gaps around the first slide are not part of a thumbnail.
const SLIDE_CSS = 'header, #notes, #thumbs, .caption { display: none !important } html, body { overflow: hidden !important } main { padding: 0 !important; gap: 0 !important; margin: 0 !important } .frame { width: 100% !important } .slide { border-radius: 0 !important; box-shadow: none !important; outline: 0 !important }';

function create({ BrowserWindow, cacheDir, officeRender, slidesRender, encrypt, decrypt, available = () => false }) {
  const memory = new Map(); // key -> { dataUrl, w, h } | null (a failure is remembered too: not tried again for the same file version)
  const pending = new Map(); // key -> Promise
  let chain = Promise.resolve();
  let win = null;
  let idle = null;
  let writes = 0;

  const keyOf = (file, stat) => crypto.createHash('sha1').update(`${VERSION}|${file.toLowerCase()}|${stat.size}|${Math.round(stat.mtimeMs)}`).digest('hex');
  const diskOk = () => Boolean(cacheDir && encrypt && decrypt && available());
  const diskFile = (key) => (diskOk() ? path.join(cacheDir, `${key}.thumb`) : null);

  function remember(key, value) {
    memory.set(key, value);
    while (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value);
  }
  async function readDisk(key) {
    const f = diskFile(key);
    if (!f) return null;
    try {
      const png = Buffer.from(decrypt(await fs.promises.readFile(f, 'utf8')), 'base64');
      if (png.length < 25 || png.readUInt32BE(0) !== 0x89504e47) return null;
      const w = png.readUInt32BE(16);
      const h = png.readUInt32BE(20);
      return w > 0 && h > 0 ? { dataUrl: `data:image/png;base64,${png.toString('base64')}`, w, h } : null;
    } catch { return null; }
  }
  async function writeDisk(key, png) {
    const f = diskFile(key);
    if (!f) return;
    try {
      await fs.promises.mkdir(cacheDir, { recursive: true });
      await fs.promises.writeFile(f, encrypt(png.toString('base64')), { mode: 0o600 });
      if (++writes % 20 === 0) { // (now and then: the oldest pictures go once there are many)
        const names = (await fs.promises.readdir(cacheDir)).filter((n) => n.endsWith('.thumb'));
        if (names.length > DISK_MAX) {
          const stats = await Promise.all(names.map(async (n) => ({ n, t: (await fs.promises.stat(path.join(cacheDir, n)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })));
          for (const { n } of stats.sort((a, b) => a.t - b.t).slice(0, names.length - DISK_MAX)) await fs.promises.rm(path.join(cacheDir, n), { force: true });
        }
      }
    } catch { /* a full or read-only disk: the picture is just not kept */ }
  }

  function closeWindow() { clearTimeout(idle); idle = null; try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* going */ } win = null; }
  function window() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      show: false, width: 960, height: 600, frame: false, skipTaskbar: true, focusable: false, paintWhenInitiallyHidden: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: false, backgroundThrottling: false, partition: 'lumen-office-thumb', javascript: true },
    });
    const wc = win.webContents;
    const ses = wc.session;
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    // Only the viewer pages themselves (file: under renderer/) and data: pictures load; everything else is refused.
    ses.webRequest.onBeforeRequest((details, callback) => {
      let ok;
      try { const u = new URL(details.url); ok = u.protocol === 'data:' || (u.protocol === 'file:' && /\/renderer\//i.test(decodeURIComponent(u.pathname))) || u.protocol === 'devtools:'; } catch { ok = false; }
      callback({ cancel: !ok });
    });
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('will-attach-webview', (e) => e.preventDefault());
    wc.setAudioMuted(true);
    return win;
  }

  async function draw(file, kind) {
    const size = SIZES[kind];
    const w = window();
    const wc = w.webContents;
    w.setContentSize(size.w, size.h);
    const fileUrl = pathToFileURL(file).href;
    const url = kind === 'pptx' ? require('./slides-viewer').viewerUrl(fileUrl) : `${fileTabs.officeViewerUrl(fileUrl)}&thumb=1`;
    await wc.loadURL(url);
    if (kind === 'pptx') { await wc.insertCSS(SLIDE_CSS); await slidesRender(wc, url, { thumb: true }); } else await officeRender(wc, url, { thumb: true });
    if (!(await wc.executeJavaScript(READY))) return null;
    // A sheet with a few cells is cropped to its grid (not a window of white); a page and a slide are the whole window.
    let crop;
    if (kind === 'xlsx') {
      const box = await wc.executeJavaScript('(() => { const r = document.querySelector(".grid")?.getBoundingClientRect(); return r ? { w: Math.ceil(r.width), h: Math.ceil(r.height) } : null; })()').catch(() => null);
      if (box && box.w > 0 && box.h > 0) crop = { x: 0, y: 0, width: Math.min(size.w, Math.max(320, box.w + 2)), height: Math.min(size.h, Math.max(150, box.h + 2)) };
    }
    const image = await (crop ? wc.capturePage(crop) : wc.capturePage());
    if (!image || image.isEmpty()) return null;
    const shot = image.getSize();
    if (shot.width < 10 || shot.height < 10) return null;
    const small = shot.width > size.out ? image.resize({ width: size.out, quality: 'good' }) : image;
    const png = small.toPNG();
    const dim = small.getSize();
    return { png, w: dim.width, h: dim.height };
  }

  async function work(file, kind, key) {
    clearTimeout(idle);
    try {
      const got = await Promise.race([draw(file, kind), wait(WORK_MS).then(() => null)]);
      if (!got) { remember(key, null); return null; }
      await writeDisk(key, got.png); // (before the answer: a restart finds it, and the test sees it)
      const value = { dataUrl: `data:image/png;base64,${got.png.toString('base64')}`, w: got.w, h: got.h };
      remember(key, value);
      return value;
    } catch { remember(key, null); closeWindow(); return null; } finally {
      if (win) { clearTimeout(idle); idle = setTimeout(closeWindow, IDLE_MS); idle.unref?.(); }
    }
  }

  async function thumbOf(file) {
    const kind = KIND_OF[extOf(file)];
    if (!kind || typeof file !== 'string') return null;
    let stat;
    try { stat = await fs.promises.stat(file); } catch { return null; }
    if (!stat.isFile() || stat.size > MAX_BYTES[kind] || stat.size < 100) return null;
    const key = keyOf(file, stat);
    if (memory.has(key)) return memory.get(key);
    if (pending.has(key)) return pending.get(key);
    const job = (async () => {
      const disk = await readDisk(key);
      if (disk) { remember(key, disk); return disk; }
      const run = chain.then(() => work(file, kind, key));
      chain = run.catch(() => null);
      return run;
    })().finally(() => pending.delete(key));
    pending.set(key, job);
    return job;
  }

  return { thumbOf, close: closeWindow, stats: () => ({ memory: memory.size, pending: pending.size, window: Boolean(win && !win.isDestroyed()) }) };
}

module.exports = { create, isOfficeFile, extOf, SIZES };
