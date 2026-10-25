// ---------- screenshot of the page (the user's own tool; the AI's screenshot tool is separate) ----------
//
// Take screenshot (Ctrl+Shift+S) opens a small chooser: Visible area, Full page, Select area.
//   Visible area  webContents.capturePage().
//   Full page     the DevTools protocol's Page.captureScreenshot with captureBeyondViewport, through
//                 webContents.debugger. An already-attached session (main.js applyChromeIdentity,
//                 an extension) is used as it is and never detached; one attached here is detached
//                 again. Height (and width) is capped at 16000 output pixels, and the toast says so.
//   Select area   a transparent overlay over the page to drag a rectangle (Esc cancels); the visible
//                 capture is cropped to it, scaled from the overlay's DIP to the image's pixels.
// The PNG goes to Pictures/Screenshots (Downloads if that can't be made) as 'Lumen <site> <time>.png'
// and to the clipboard, and a toast offers Open, Show in folder and Ask AI about this. In a private
// window nothing is written to disk on its own: it is copied, and the toast offers Save as….
const fs = require('fs');
const path = require('path');

const MAX_PIXELS = 16000; // longest edge of a full-page capture, in output pixels
const MIN_AREA = 4; // DIP: a smaller drag is a stray click, not a selection
const isWebUrl = (url) => /^https?:\/\//i.test(url || '');

// ---------- pure helpers (unit-tested) ----------

const pad = (n) => String(n).padStart(2, '0');
function timestamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
}

// 'Lumen <site> <timestamp>.png': the site is the host without www., safe on every file system.
function fileNameFor(url, date = new Date()) {
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  const site = host.replace(/^www\./i, '').replace(/[^A-Za-z0-9.-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 60) || 'page';
  return `Lumen ${site} ${timestamp(date)}.png`;
}

// `name` that doesn't exist yet in `dir`: 'x.png', then 'x (2).png', 'x (3).png'…
function uniquePath(dir, name, exists = fs.existsSync) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let n = 2; exists(candidate) && n < 1000; n++) candidate = path.join(dir, `${base} (${n})${ext}`);
  return candidate;
}

// A drag from the overlay -> a whole-number rectangle clamped to the view, or null when too small.
// `r` is { x, y, width, height } (or two corners); `view` is { width, height } in DIP.
function normalizeRect(r, view) {
  if (!r || ![r.x, r.y, r.width, r.height].every((v) => Number.isFinite(v))) return null;
  const x0 = Math.min(Math.max(Math.min(r.x, r.x + r.width), 0), view.width);
  const y0 = Math.min(Math.max(Math.min(r.y, r.y + r.height), 0), view.height);
  const x1 = Math.min(Math.max(Math.max(r.x, r.x + r.width), 0), view.width);
  const y1 = Math.min(Math.max(Math.max(r.y, r.y + r.height), 0), view.height);
  const rect = { x: Math.round(x0), y: Math.round(y0), width: Math.round(x1) - Math.round(x0), height: Math.round(y1) - Math.round(y0) };
  return rect.width < MIN_AREA || rect.height < MIN_AREA ? null : rect;
}

// DIP -> image pixels (`factor` = image width / view width), kept inside an image of `size`.
function scaleRect(rect, factor, size) {
  const x = Math.min(Math.max(Math.round(rect.x * factor), 0), size.width - 1);
  const y = Math.min(Math.max(Math.round(rect.y * factor), 0), size.height - 1);
  const width = Math.max(1, Math.min(Math.round(rect.width * factor), size.width - x));
  const height = Math.max(1, Math.min(Math.round(rect.height * factor), size.height - y));
  return { x, y, width, height };
}

// A full-page capture of `css` CSS pixels at `scale` output pixels per CSS pixel: cut so neither
// edge passes `max` output pixels. -> { width, height (CSS px), cut }
function capSize(css, scale, max = MAX_PIXELS) {
  const limit = Math.max(1, Math.floor(max / scale));
  const width = Math.max(1, Math.min(Math.ceil(css.width), limit));
  const height = Math.max(1, Math.min(Math.ceil(css.height), limit));
  return { width, height, cut: Math.ceil(css.width) > limit || Math.ceil(css.height) > limit };
}

// The scroll offsets (CSS px) of the slices that cover a page `total` px tall through a window `view` px tall, each slice starting where the last one ended;
// the last is pulled up to the page's end (it overlaps the one before). A page no taller than the window is one slice at 0.
function slicePlan(total, view) {
  const t = Math.max(1, Math.ceil(total));
  const v = Math.max(1, Math.floor(view));
  const ys = [0];
  for (let y = v; y < t && ys.length < 400; y += v) ys.push(Math.min(y, t - v));
  return ys;
}

// ---------- the tool ----------

// deps: { overlay, copyImage(nativeImage) -> Promise, nativeImage, shell, screen, app, t, downloadDir(), saveDir() (test override),
//         showSaveDialog(options) }
function createScreenshot(deps) {
  const { t } = deps;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const picturesDir = () => {
    const override = deps.saveDir?.();
    if (override) return override;
    try {
      const dir = path.join(deps.app.getPath('pictures'), 'Screenshots');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch { return deps.downloadDir(); }
  };

  const scaleOf = (ctx) => {
    let dsf = 1;
    try { dsf = deps.screen.getDisplayMatching(ctx.win.getBounds()).scaleFactor || 1; } catch {}
    return dsf * (ctx.wc.getZoomFactor?.() || 1);
  };

  async function captureVisible(ctx) {
    const image = await ctx.wc.capturePage();
    if (image.isEmpty()) throw new Error('blank capture');
    return { image };
  }

  // A full page is taken as the window's own pictures, one scroll step at a time, and sewn together: Page.captureScreenshot with captureBeyondViewport
  // makes Chromium lay the live page out at the full height for the capture (a resize event, ResizeObserver ticks and a visualViewport change on the page
  // the user is looking at, measured by test/e2e/screenshot-no-resize.js), which broke layouts built on vh units and moved the scroll. Sticky and
  // fixed elements are hidden (visibility only, no layout) after the first slice so they are not repeated down the picture; the scroll position and
  // every style set are put back. Pages this cannot do (sideways overflow, a document that does not scroll, a slice that comes back empty) take
  // the old way below.
  const SHOT_HIDE = '__lumenShotHidden';
  function captureFull(ctx) { return require('./tab-capture').oneAtATime(ctx.wc, () => captureFullNow(ctx)); }
  async function captureFullNow(ctx) {
    try {
      const done = await stitchFull(ctx);
      if (done) return done;
    } catch { /* the old way */ }
    return captureBeyond(ctx);
  }
  async function stitchFull(ctx) {
    const wc = ctx.wc;
    const m = await wc.executeJavaScript('(() => { const d = document.documentElement; const b = document.body; return [Math.max(d.scrollHeight, b ? b.scrollHeight : 0), d.scrollWidth, d.clientWidth, innerHeight, scrollX, scrollY]; })()');
    if (!Array.isArray(m)) return null;
    const [totalH, scrollW, clientW, vh, sx, sy] = m;
    if (!(vh > 0) || scrollW > clientW + 2) return null; // sideways overflow: only the old way takes it whole
    if (totalH <= vh + 1) return { ...(await captureVisible(ctx)) }; // nothing below the fold: what is shown is the page
    const first = (await captureVisible(ctx)).image;
    const rowScale = first.getSize().height / vh;
    const size = capSize({ width: clientW, height: totalH }, rowScale);
    const outW = Math.min(first.getSize().width, Math.max(1, Math.round(size.width * rowScale)));
    const outH = Math.max(1, Math.round(size.height * rowScale));
    const out = Buffer.alloc(outW * outH * 4);
    let covered = 0;
    try {
      for (const target of slicePlan(size.height, vh)) {
        const actual = await wc.executeJavaScript(`new Promise((resolve) => { scrollTo({ left: ${sx}, top: ${Math.round(target)}, behavior: 'instant' }); const t = setTimeout(done, 150); function done() { clearTimeout(t); resolve(scrollY); } requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 40))); })`);
        if (target === 0) { /* the first slice keeps fixed and sticky parts */ } else {
          await wc.executeJavaScript(`(() => { if (window.${SHOT_HIDE}) return; const keep = []; const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT); let n = 0; while (w.nextNode() && n++ < 30000) { const e = w.currentNode; const p = getComputedStyle(e).position; if (p === 'fixed' || p === 'sticky') { keep.push([e, e.style.getPropertyValue('visibility'), e.style.getPropertyPriority('visibility')]); e.style.setProperty('visibility', 'hidden', 'important'); } } window.${SHOT_HIDE} = keep; })()`);
        }
        const img = (await captureVisible(ctx)).image;
        const { width: iw, height: ih } = img.getSize();
        if (iw < outW || Math.abs(ih / vh - rowScale) > 0.02) throw new Error('the window changed size');
        const bmp = img.toBitmap();
        const skip = Math.min(ih - 1, Math.max(0, Math.round((covered - actual) * rowScale)));
        const dest = Math.round(covered * rowScale);
        const rows = Math.min(ih - skip, outH - dest);
        for (let r = 0; r < rows; r++) bmp.copy(out, (dest + r) * outW * 4, ((skip + r) * iw) * 4, ((skip + r) * iw + outW) * 4);
        covered = actual + vh;
        if (actual < target - 1 && covered < size.height) throw new Error('the page did not scroll');
      }
    } finally {
      try { await wc.executeJavaScript(`(() => { const k = window.${SHOT_HIDE}; if (k) { for (const [e, v, p] of k) { if (v) e.style.setProperty('visibility', v, p); else e.style.removeProperty('visibility'); } delete window.${SHOT_HIDE}; } scrollTo({ left: ${sx}, top: ${sy}, behavior: 'instant' }); })()`); } catch { /* the page is gone */ }
    }
    return { image: deps.nativeImage.createFromBitmap(out, { width: outW, height: outH }), cut: size.cut };
  }

  // (in the page's capture queue: a clipped capture taken while another is in flight leaves the page at the clip's size, see features/tab-capture.js)
  async function captureBeyond(ctx) {
    const dbg = ctx.wc.debugger;
    let attachedHere = false;
    try {
      if (!dbg.isAttached()) { dbg.attach('1.3'); attachedHere = true; }
    } catch { return { ...(await captureVisible(ctx)), fellBack: true }; } // another debugger owns it
    try {
      const metrics = await dbg.sendCommand('Page.getLayoutMetrics');
      const css = metrics.cssContentSize || metrics.contentSize;
      const scale = scaleOf(ctx);
      const size = capSize(css, scale);
      const shot = await dbg.sendCommand('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: size.width, height: size.height, scale },
      });
      const image = deps.nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
      if (image.isEmpty()) throw new Error('blank capture');
      return { image, cut: size.cut };
    } finally {
      if (attachedHere) { try { dbg.detach(); } catch {} }
    }
  }

  async function captureArea(ctx, rect) {
    const { image } = await captureVisible(ctx);
    const view = ctx.view.getBounds();
    const size = image.getSize();
    const clean = normalizeRect(rect, { width: view.width, height: view.height });
    if (!clean) return null;
    return { image: image.crop(scaleRect(clean, size.width / view.width, size)) };
  }

  function toast(ctx, payload, onAction) {
    return deps.overlay.show(ctx.win, { mode: 'toast', restoreFocus: ctx.restoreFocus, payload: { seconds: 12, ...payload }, onAction });
  }

  async function saveAs(ctx, png, name) {
    const { canceled, filePath } = await deps.showSaveDialog({
      title: t('shot.saveAs'),
      defaultPath: path.join(deps.downloadDir(), name),
      filters: [{ name: 'PNG', extensions: ['png'] }],
    }, ctx.win);
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, png);
    return filePath;
  }

  // Copy to the clipboard, save (unless private), and say so.
  async function deliver(ctx, shot) {
    const png = shot.image.toPNG();
    const size = shot.image.getSize();
    await deps.copyImage(shot.image).catch(() => {});
    const name = fileNameFor(ctx.wc.getURL());
    const note = shot.cut ? t('shot.cut', { px: MAX_PIXELS }) : shot.fellBack ? t('shot.fellBack') : '';
    const dims = t('shot.size', { w: size.width, h: size.height });
    const askAi = ctx.askAi ? [{ id: 'ask', label: t('shot.askAi') }] : [];
    const result = { ok: true, width: size.width, height: size.height, cut: Boolean(shot.cut), path: null, saved: false };

    if (ctx.isPrivate) {
      await toast(ctx, { title: t('shot.copied'), sub: [dims, note, t('shot.privateNote')].filter(Boolean).join(' · '), buttons: [{ id: 'saveas', label: t('shot.saveAs') }] }, async (action, data, sess) => {
        if (action !== 'button' || data.id !== 'saveas') return;
        try {
          const file = await saveAs(ctx, png, name);
          if (file) deps.overlay.update(ctx.win, sess, { title: t('shot.saved'), sub: path.basename(file) });
        } catch { deps.overlay.update(ctx.win, sess, { title: t('shot.saveFailed'), sub: '' }); }
      });
      return result;
    }

    let file = null;
    try {
      const dir = picturesDir();
      file = uniquePath(dir, name);
      fs.writeFileSync(file, png);
    } catch { file = null; }
    result.path = file;
    result.saved = Boolean(file);
    if (!file) {
      await toast(ctx, { title: t('shot.copied'), sub: [dims, t('shot.saveFailed')].join(' · '), buttons: [{ id: 'saveas', label: t('shot.saveAs') }, ...askAi] }, async (action, data) => {
        if (action !== 'button') return;
        if (data.id === 'ask') ctx.askAi(png);
        else if (data.id === 'saveas') { try { await saveAs(ctx, png, name); } catch {} }
      });
      return result;
    }
    await toast(ctx, {
      title: t('shot.saved'),
      sub: [path.basename(file), dims, note].filter(Boolean).join(' · '),
      buttons: [{ id: 'open', label: t('shot.open') }, { id: 'folder', label: t('shot.showInFolder') }, ...askAi],
    }, (action, data, sess) => {
      if (action !== 'button') return;
      if (data.id === 'open') deps.shell.openPath(file).catch?.(() => {});
      else if (data.id === 'folder') deps.shell.showItemInFolder(file);
      else if (data.id === 'ask') { ctx.askAi(png); deps.overlay.hide(ctx.win, sess); }
    });
    return result;
  }

  // ctx: { wc, win, view, isPrivate, askAi(png) | null, restoreFocus() }
  async function capture(ctx, mode, { rect } = {}) {
    if (!ctx.wc || ctx.wc.isDestroyed() || !isWebUrl(ctx.wc.getURL())) {
      await toast(ctx, { title: t('shot.unavailable'), buttons: [], seconds: 5 }, () => {});
      return { ok: false, error: 'unsupported' };
    }
    let shot;
    try {
      if (mode === 'full') shot = await captureFull(ctx);
      else if (mode === 'area') shot = await captureArea(ctx, rect);
      else shot = await captureVisible(ctx);
    } catch {
      await toast(ctx, { title: t('shot.failed'), buttons: [], seconds: 6 }, () => {});
      return { ok: false, error: 'failed' };
    }
    if (!shot) return { ok: false, error: 'too-small' };
    return deliver(ctx, shot);
  }

  // The drag overlay over the page; resolves with the shot's result, or { ok: false, error: 'cancelled' }.
  function selectArea(ctx) {
    return new Promise((resolve) => {
      let settled = false;
      let taken = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      deps.overlay.show(ctx.win, {
        mode: 'select',
        restoreFocus: ctx.restoreFocus,
        bounds: () => ctx.view.getBounds(),
        payload: { hint: t('shot.selectHint') },
        onClose: () => { if (!taken) done({ ok: false, error: 'cancelled' }); },
        onAction: async (action, data, sess) => {
          if (action !== 'rect') return;
          const view = ctx.view.getBounds();
          const clean = normalizeRect(data, { width: view.width, height: view.height });
          if (!clean) return; // a stray click: keep waiting
          taken = true;
          deps.overlay.hide(ctx.win, sess);
          await sleep(60);
          done(await capture(ctx, 'area', { rect: clean }));
        },
      });
    });
  }

  // The chooser. Resolves with the capture's result (or 'cancelled').
  function open(ctx) {
    if (!ctx.wc || ctx.wc.isDestroyed() || !isWebUrl(ctx.wc.getURL())) return capture(ctx, 'visible');
    return new Promise((resolve) => {
      let picked = false;
      deps.overlay.show(ctx.win, {
        mode: 'chooser',
        restoreFocus: ctx.restoreFocus,
        payload: {
          title: t('shot.title'),
          sub: ctx.isPrivate ? t('shot.privateNote') : t('shot.chooseSub'),
          cancel: t('shot.cancel'),
          options: [
            { id: 'visible', label: t('shot.visible'), hint: t('shot.visibleHint') },
            { id: 'full', label: t('shot.full'), hint: t('shot.fullHint') },
            { id: 'area', label: t('shot.area'), hint: t('shot.areaHint') },
          ],
        },
        onClose: () => { if (!picked) resolve({ ok: false, error: 'cancelled' }); },
        onAction: async (action, data, sess) => {
          if (action !== 'choose' || !['visible', 'full', 'area'].includes(data.id)) return;
          picked = true;
          if (data.id === 'area') { resolve(await selectArea(ctx)); return; }
          deps.overlay.hide(ctx.win, sess);
          await sleep(60);
          resolve(await capture(ctx, data.id));
        },
      });
    });
  }

  return { open, capture, selectArea };
}

module.exports = { createScreenshot, fileNameFor, uniquePath, normalizeRect, scaleRect, capSize, slicePlan, timestamp, MAX_PIXELS, MIN_AREA };
