// ---------- QR code for the current page (or the selected text) ----------
//
// The code is made here, in the main process, with qrcode-generator (MIT), loaded on first use so
// startup doesn't pay for it. The overlay page (renderer/tool-overlay.js) only draws the module
// grid it is sent onto a canvas, so nothing is fetched and no script comes from anywhere else.
// Copy image and Save as PNG render the same grid to a bitmap here (no canvas needed).
const path = require('path');
const fs = require('fs');

const URL_WARN = 800; // characters: still works, but the code gets dense and hard to scan
const URL_MAX = 2000; // characters: refused
const TEXT_MAX = 500;
const isWebUrl = (url) => /^https?:\/\//i.test(url || '');

let generator = null;
function load() {
  if (!generator) {
    generator = require('qrcode-generator');
    generator.stringToBytes = generator.stringToBytesFuncs['UTF-8']; // the default is Latin-1
  }
  return generator;
}

// What may be encoded. kind 'url': an http(s) address (never altered), warned above 800 characters,
// refused above 2000. kind 'text': a selection, 1..500 characters after trimming.
// -> { ok: true, text, warn: 'long' | null } or { ok: false, error: 'scheme' | 'empty' | 'too-long' }
function checkInput(input, kind = 'url') {
  if (kind === 'text') {
    const text = String(input ?? '').trim();
    if (!text) return { ok: false, error: 'empty' };
    if (text.length > TEXT_MAX) return { ok: false, error: 'too-long' };
    return { ok: true, text, warn: null };
  }
  const url = String(input ?? '');
  if (!isWebUrl(url)) return { ok: false, error: 'scheme' };
  if (url.length > URL_MAX) return { ok: false, error: 'too-long' };
  return { ok: true, text: url, warn: url.length > URL_WARN ? 'long' : null };
}

// The module grid for `text`: { size, rows: ['0101…', …] }. Level M, or L when M can't hold it.
function makeMatrix(text) {
  const qrcode = load();
  let qr = null;
  for (const level of ['M', 'L']) {
    try {
      const attempt = qrcode(0, level);
      attempt.addData(text, 'Byte');
      attempt.make();
      qr = attempt;
      break;
    } catch { /* overflow: try the lower level */ }
  }
  if (!qr) throw new Error('too much data for a QR code');
  const size = qr.getModuleCount();
  const rows = [];
  for (let r = 0; r < size; r++) {
    let row = '';
    for (let c = 0; c < size; c++) row += qr.isDark(r, c) ? '1' : '0';
    rows.push(row);
  }
  return { size, rows };
}

// BGRA pixels for the grid: black on white with a 4-module quiet zone, each module `scale` pixels.
function renderBitmap(matrix, scale = 8, margin = 4) {
  const cells = matrix.size + margin * 2;
  const width = cells * scale;
  const buffer = Buffer.alloc(width * width * 4, 0xff); // opaque white
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (matrix.rows[r][c] !== '1') continue;
      for (let y = 0; y < scale; y++) {
        const start = (((r + margin) * scale + y) * width + (c + margin) * scale) * 4;
        for (let x = 0; x < scale; x++) { const i = start + x * 4; buffer[i] = 0; buffer[i + 1] = 0; buffer[i + 2] = 0; }
      }
    }
  }
  return { width, height: width, buffer };
}

// A file name for the saved code: 'Lumen QR <site> <timestamp>.png'.
function fileNameFor(text, date = new Date()) {
  let site = '';
  try { site = new URL(text).hostname.replace(/^www\./i, ''); } catch {}
  site = site.replace(/[^A-Za-z0-9.-]+/g, ' ').trim().slice(0, 60) || 'text';
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}.${p(date.getMinutes())}.${p(date.getSeconds())}`;
  return `Lumen QR ${site} ${stamp}.png`;
}

// deps: { overlay, copyImage(nativeImage) -> Promise, nativeImage, t, downloadDir(), showSaveDialog(options) }
function createQr(deps) {
  const { t } = deps;

  // ctx: { wc, win, restoreFocus() }. `text` is the address (kind 'url') or the selection (kind 'text').
  async function open(ctx, text, kind = 'url') {
    const { win } = ctx;
    const checked = checkInput(text, kind);
    if (!checked.ok) {
      const key = { scheme: 'qr.notWeb', empty: 'qr.empty', 'too-long': kind === 'text' ? 'qr.textTooLong' : 'qr.urlTooLong' }[checked.error];
      await deps.overlay.show(win, {
        mode: 'toast', restoreFocus: ctx.restoreFocus,
        payload: { title: t(key, { max: kind === 'text' ? TEXT_MAX : URL_MAX }), buttons: [], seconds: 6 },
        onAction: () => {},
      });
      return { ok: false, error: checked.error };
    }
    let matrix;
    try { matrix = makeMatrix(checked.text); } catch {
      await deps.overlay.show(win, { mode: 'toast', restoreFocus: ctx.restoreFocus, payload: { title: t('qr.failed'), buttons: [], seconds: 6 }, onAction: () => {} });
      return { ok: false, error: 'failed' };
    }
    const image = () => {
      const bmp = renderBitmap(matrix);
      return deps.nativeImage.createFromBitmap(bmp.buffer, { width: bmp.width, height: bmp.height });
    };
    const session = await deps.overlay.show(win, {
      mode: 'qr',
      restoreFocus: ctx.restoreFocus,
      payload: {
        title: t(kind === 'text' ? 'qr.titleText' : 'qr.title'),
        sub: t('qr.scan'),
        modules: matrix,
        alt: t('qr.alt', { text: checked.text.length > 120 ? `${checked.text.slice(0, 119)}…` : checked.text }),
        text: checked.text.length > 200 ? `${checked.text.slice(0, 199)}…` : checked.text,
        warn: checked.warn ? t('qr.longWarning', { n: checked.text.length }) : '',
        buttons: [
          { id: 'copy', label: t('qr.copy'), primary: true },
          { id: 'save', label: t('qr.save') },
          { id: 'close', label: t('qr.close') },
        ],
      },
      onAction: async (action, data, sess) => {
        if (action !== 'button') return;
        if (data.id === 'copy') {
          try {
            await deps.copyImage(image());
            deps.overlay.update(win, sess, { status: t('qr.copied') });
          } catch { deps.overlay.update(win, sess, { status: t('qr.failed') }); }
        } else if (data.id === 'save') {
          const { canceled, filePath } = await deps.showSaveDialog({
            title: t('qr.save'),
            defaultPath: path.join(deps.downloadDir(), fileNameFor(checked.text)),
            filters: [{ name: 'PNG', extensions: ['png'] }],
          }, win);
          if (canceled || !filePath) return;
          try {
            fs.writeFileSync(filePath, image().toPNG());
            deps.overlay.update(win, sess, { status: t('qr.saved') });
          } catch {
            deps.overlay.update(win, sess, { status: t('qr.saveFailed') });
          }
        }
      },
    });
    return { ok: true, session, size: matrix.size };
  }

  return { open };
}

module.exports = { createQr, checkInput, makeMatrix, renderBitmap, fileNameFor, URL_WARN, URL_MAX, TEXT_MAX };
