// Take screenshot and QR code (features/screenshot.js, features/qr.js, features/tool-overlay.js) against
// a local fixture page that is taller than the window. Throwaway profile, windows shown off-screen
// and invisible (LUMEN_TEST_BACKGROUND: a window that is never shown can hand back blank frames), the
// save folder redirected to a temp dir, and no real mouse: the area picker is driven with events
// dispatched in the overlay page itself.
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TALL = `<!doctype html><html><head><meta charset="utf-8"><title>Tall Fixture</title><style>
html, body { margin: 0; }
#top { height: 300px; background: linear-gradient(to right, #0000c8 0, #0000c8 200px, #c80000 200px); }
#mid { height: 2400px; background: #dcdcdc; }
#bottom { height: 300px; background: #00c800; }
</style></head><body><div id="top"></div><div id="mid"></div><div id="bottom"></div></body></html>`;

(async () => {
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 10000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { try { v = await fn(); if (v) return v; } catch {} await sleep(100); } return v; };

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url.startsWith('/tall') ? TALL : '<!doctype html><title>Other</title><p>Other</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-shot-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-shot-out-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1' },
    colorScheme: null,
  });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');

  await app.evaluate((_e, dir) => { global.__screenshotDir = dir; }, out);
  const tabId = await app.evaluate(async (_e, u) => {
    const t = global.__agent.browser.openTab(u);
    await new Promise((r) => t.webContents.once('did-finish-load', r));
    return t.id;
  }, `${base}/tall`);
  await sleep(500);

  // Runs `body` in the main process with { tool, qr, overlay, ctx, win } for the tab (or for a private window).
  const inApp = (body, arg, winId = null) => app.evaluate(async ({ BrowserWindow }, [code, a, id, tab]) => {
    const s = global.__screenshot;
    const ctx = id ? global.__private.screenshotCtx(id) : s.ctx(global.__pageTools.tab(tab).view.webContents);
    // eslint-disable-next-line no-new-func
    return new Function('s', 'ctx', 'arg', 'BrowserWindow', `return (async () => { ${code} })()`)(s, ctx, a, BrowserWindow);
  }, [body, arg, winId, tabId]);
  // Runs `code` in the overlay page of the tab's window (or a private window).
  const inOverlay = (code, winId = null) => inApp('return s.overlay.viewFor(ctx.win).webContents.executeJavaScript(arg)', code, winId);
  const overlayMode = (winId = null) => inApp('return s.overlay.currentFor(ctx.win)?.mode || null', null, winId);
  const overlayReady = async (mode, winId = null) => waitFor(async () => (await overlayMode(winId)) === mode && inOverlay(`document.getElementById('${{ chooser: 'modal', qr: 'modal', toast: 'toast', select: 'select' }[mode]}').hidden === false`, winId));
  const pixelInfo = (file) => app.evaluate(({ nativeImage }, f) => {
    const img = nativeImage.createFromPath(f);
    const { width, height } = img.getSize();
    const bmp = img.toBitmap();
    const at = (x, y) => { const i = (y * width + x) * 4; return [bmp[i + 2], bmp[i + 1], bmp[i]]; }; // RGB from BGRA
    return { width, height, top: at(Math.floor(width * 0.9), 5), left: at(5, 5), bottom: at(Math.floor(width / 2), height - 5), bottomLeft: at(5, height - 5) };
  }, file);
  const near = (rgb, want) => rgb.every((v, i) => Math.abs(v - want[i]) <= 12);
  const files = () => fs.readdirSync(out).filter((f) => f.endsWith('.png'));
  const clipSize = () => app.evaluate(async ({ clipboard, nativeImage }) => {
    const item = (await clipboard.read()).find((i) => i.types.includes('image/png'));
    if (!item) return { width: 0, height: 0 };
    return nativeImage.createFromBuffer(Buffer.from(await (await item.getType('image/png')).arrayBuffer())).getSize();
  });
  const clearClip = () => app.evaluate(({ clipboard }) => clipboard.clear());

  const view = await inApp('return ctx.view.getBounds()');
  check('the fixture page is loaded in a tab', view.width > 100 && view.height > 100, JSON.stringify(view));

  // ---- visible area ----
  await clearClip();
  const vis = await inApp("return s.tool.capture(ctx, 'visible')");
  check('visible capture succeeds and is saved as a PNG', vis.ok && vis.saved && vis.path && fs.existsSync(vis.path) && vis.path.startsWith(out), JSON.stringify(vis));
  check("the file is named 'Lumen <site> <timestamp>.png'", /^Lumen 127\.0\.0\.1 \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.png$/.test(path.basename(vis.path || '')), vis.path);
  const visPix = await pixelInfo(vis.path);
  const factor = visPix.width / view.width;
  check('the visible capture is the size of the page view (scaled by the display factor)', factor >= 1 && Math.abs(visPix.height - view.height * factor) <= 2, `${visPix.width}x${visPix.height} vs ${view.width}x${view.height}`);
  check('the visible capture shows the top of the fixture (blue left, red right)', near(visPix.left, [0, 0, 200]) && near(visPix.top, [200, 0, 0]), JSON.stringify(visPix));
  const clip = await clipSize();
  check('the image is on the clipboard', clip.width === visPix.width && clip.height === visPix.height, JSON.stringify(clip));
  check('a toast says Screenshot saved with Open, Show in folder and Ask AI about this', await overlayReady('toast') && (await inOverlay("[...document.querySelectorAll('#t-buttons button')].map((b) => b.textContent).join('|') + '#' + document.getElementById('t-title').textContent")) === 'Open|Show in folder|Ask AI about this#Screenshot saved', await inOverlay("document.getElementById('t-title').textContent"));

  // ---- Ask AI about this: the image lands in the sidebar composer ----
  await inOverlay("[...document.querySelectorAll('#t-buttons button')].find((b) => b.textContent.startsWith('Ask AI')).click()");
  const attached = await waitFor(() => ui.evaluate(() => document.querySelectorAll('#attachments .attachment img').length));
  check('Ask AI about this adds the image to the sidebar composer', attached === 1, attached);
  check('the toast goes away after Ask AI', (await waitFor(async () => (await overlayMode()) === null)) === true, await overlayMode());

  // ---- full page ----
  const attachedBefore = await inApp('return ctx.wc.debugger.isAttached()');
  const full = await inApp("return s.tool.capture(ctx, 'full')");
  check('full-page capture succeeds and is saved', full.ok && full.saved && !full.cut && fs.existsSync(full.path), JSON.stringify(full));
  check('the full page is much taller than the visible area', full.height > visPix.height * 1.5 && full.height >= Math.floor(3000 * factor) - 2, `${full.height} vs ${visPix.height}`);
  const fullPix = await pixelInfo(full.path);
  check('the bottom of the full page is the fixture\'s green marker, the top still blue/red', near(fullPix.bottom, [0, 200, 0]) && near(fullPix.bottomLeft, [0, 200, 0]) && near(fullPix.left, [0, 0, 200]) && near(fullPix.top, [200, 0, 0]), JSON.stringify(fullPix));
  check('the full-page capture leaves the debugger as it found it', (await inApp('return ctx.wc.debugger.isAttached()')) === attachedBefore, attachedBefore);

  // ---- select area (scripted rectangle through the real overlay) ----
  const before = files().length;
  await inApp('global.__areaPromise = s.tool.selectArea(ctx); return true');
  const ready = await overlayReady('select');
  check('Select area shows the picker over the page', Boolean(ready), await overlayMode());
  const bounds = await inApp('return s.overlay.viewFor(ctx.win).getBounds()');
  const viewNow = await inApp('return ctx.view.getBounds()'); // the sidebar opened above (Ask AI), so the page view is narrower now
  check('the picker covers exactly the page view', JSON.stringify(bounds) === JSON.stringify(viewNow), `${JSON.stringify(bounds)} vs ${JSON.stringify(viewNow)}`);
  await inOverlay(`(() => { const el = document.getElementById('select');
    const fire = (type, x, y) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    fire('mousedown', 250, 20); fire('mousemove', 300, 50); fire('mousemove', 350, 70); fire('mouseup', 350, 70); return true; })()`);
  const area = await inApp('return global.__areaPromise');
  check('the scripted rectangle is cropped to 100x50 DIP in image pixels', area.ok && area.width === Math.round(100 * factor) && area.height === Math.round(50 * factor), JSON.stringify(area));
  const areaPix = area.path ? await pixelInfo(area.path) : null;
  check('the cropped area is the red half of the fixture', areaPix && near(areaPix.left, [200, 0, 0]) && near(areaPix.top, [200, 0, 0]) && near(areaPix.bottomLeft, [200, 0, 0]), JSON.stringify(areaPix));
  check('one more file was saved', files().length === before + 1, files().length);

  // Esc cancels the picker
  await inApp('global.__areaPromise = s.tool.selectArea(ctx); return true');
  await overlayReady('select');
  await inOverlay("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");
  const cancelled = await inApp('return global.__areaPromise');
  check('Esc cancels the area picker without saving', cancelled.error === 'cancelled' && files().length === before + 1, JSON.stringify(cancelled));

  // ---- chooser, shortcut, focus trap ----
  await app.evaluate(() => { global.__saveCalls = 0; global.__pageToolsSaveDialog = () => { global.__saveCalls++; return { canceled: true }; }; });
  await app.evaluate(() => global.__pageTools.handleShortcut({ control: true, shift: true, key: 'S' }));
  check('Ctrl+Shift+S opens the chooser (and is not Save Page As)', Boolean(await overlayReady('chooser')) && (await app.evaluate(() => global.__saveCalls)) === 0, await overlayMode());
  const labels = await inOverlay("[...document.querySelectorAll('#choices button')].map((b) => b.firstChild.textContent).join('|')");
  check('the chooser offers Visible area, Full page, Select area', labels === 'Visible area|Full page|Select area', labels);
  const a11y = await inOverlay("(() => { const c = document.getElementById('card'); return c.getAttribute('role') + c.getAttribute('aria-modal') + Boolean(document.getElementById('m-title').textContent) + document.activeElement.className; })()");
  check('the chooser is a labelled modal dialog with focus on its first choice', a11y === 'dialogtruetruebtn choice', a11y);
  await inOverlay(`(() => { const items = [...document.querySelectorAll('#modal button')]; items[items.length - 1].focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); return true; })()`);
  check('Tab from the last button wraps to the first (focus trap)', (await inOverlay('document.activeElement === document.querySelector("#modal button")')) === true, '');
  await inOverlay("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");
  check('Escape closes the chooser', (await waitFor(async () => (await overlayMode()) === null)) === true, await overlayMode());
  await app.evaluate(() => global.__pageTools.handleShortcut({ control: true, shift: true, key: 'S' }));
  await overlayReady('chooser');
  const filesBefore = files().length;
  await inOverlay("document.querySelector('#choices button').click(); true");
  await waitFor(() => files().length === filesBefore + 1);
  check('choosing Visible area in the chooser takes and saves the shot', files().length === filesBefore + 1, files().length);

  // ---- not for internal pages ----
  const internal = await app.evaluate(async () => {
    const t = global.__agent.browser.openTab('about:blank');
    await new Promise((r) => setTimeout(r, 300));
    return t.id;
  });
  const refused = await app.evaluate(async (_e, id) => { const s = global.__screenshot; return s.tool.capture(s.ctx(global.__pageTools.tab(id).view.webContents), 'visible'); }, internal);
  check('a page that is not http(s) is refused', refused.ok === false && refused.error === 'unsupported', JSON.stringify(refused));

  // ---- private window: copies, never saves on its own ----
  const pw = await app.evaluate(async () => { const rec = global.__private.open(); return rec.win.id; });
  await waitFor(() => app.evaluate((_e, id) => global.__private.list().find((w) => w.windowId === id)?.tabs.length === 1, pw));
  await app.evaluate((_e, [id, url]) => global.__private.openTab(id, url), [pw, `${base}/tall`]);
  await waitFor(() => app.evaluate((_e, [id, url]) => global.__private.list().find((w) => w.windowId === id).tabs.some((t) => t.url === url), [pw, `${base}/tall`]));
  await sleep(800);
  await clearClip();
  const privFiles = files().length;
  const priv = await inApp("return s.tool.capture(ctx, 'visible')", null, pw);
  check('a private window capture copies to the clipboard but saves nothing', priv.ok && priv.saved === false && priv.path === null && files().length === privFiles && (await clipSize()).width > 0, JSON.stringify(priv));
  check('the private toast offers Save as… and no Ask AI', await overlayReady('toast', pw) && (await inOverlay("[...document.querySelectorAll('#t-buttons button')].map((b) => b.textContent).join('|')", pw)) === 'Save as…', await inOverlay("document.getElementById('t-buttons').textContent", pw));
  const chosen = path.join(out, 'private-choice.png');
  await app.evaluate((_e, f) => { global.__pageToolsSaveDialog = () => ({ canceled: false, filePath: f }); }, chosen);
  await inOverlay("document.querySelector('#t-buttons button').click(); true", pw);
  check('Save as… writes the PNG where the user chose', Boolean(await waitFor(() => fs.existsSync(chosen) && fs.statSync(chosen).size > 100)), '');
  await app.evaluate((_e, id) => global.__private.shortcut(id, { control: true, shift: true, key: 's' }), pw);
  check('Ctrl+Shift+S works in a private window too', Boolean(await overlayReady('chooser', pw)), await overlayMode(pw));
  await inOverlay("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true", pw);
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.close(), pw);

  // ---- QR code ----
  const url = `${base}/tall`;
  const q = await inApp('return s.qr.open(ctx, ctx.wc.getURL())');
  check('QR: the dialog opens with a code for the page URL', q.ok && q.size >= 21 && Boolean(await overlayReady('qr')), JSON.stringify(q));
  const qrInfo = await inOverlay(`(() => { const c = document.getElementById('qr'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 60) dark++; return { dark, label: c.getAttribute('aria-label'), title: document.getElementById('m-title').textContent, buttons: [...document.querySelectorAll('#m-buttons button')].map((b) => b.textContent).join('|') }; })()`);
  check('QR: the canvas has dark modules, a screen-reader label naming the URL, and Copy/Save/Close buttons', qrInfo.dark > 500 && qrInfo.label.includes(url) && qrInfo.buttons === 'Copy image|Save as PNG|Close', JSON.stringify(qrInfo));
  await clearClip();
  await inOverlay("document.querySelector('#m-buttons button').click(); true");
  const qrClip = await waitFor(async () => { const s = await clipSize(); return s.width > 0 ? s : null; });
  check('QR: Copy image puts a square image on the clipboard', qrClip && qrClip.width === qrClip.height && qrClip.width % 8 === 0, JSON.stringify(qrClip));
  const qrFile = path.join(out, 'qr.png');
  await app.evaluate((_e, f) => { global.__pageToolsSaveDialog = () => ({ canceled: false, filePath: f }); }, qrFile);
  await inOverlay("document.querySelectorAll('#m-buttons button')[1].click(); true");
  const png = await waitFor(() => fs.existsSync(qrFile) && fs.readFileSync(qrFile));
  check('QR: Save as PNG writes a PNG', png && png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', png && png.subarray(0, 8).toString('hex'));
  check('QR: the status line confirms it for screen readers', (await waitFor(() => inOverlay("document.getElementById('m-status').textContent"))) === 'QR code saved.', await inOverlay("document.getElementById('m-status').textContent"));
  await inOverlay("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");
  check('QR: Escape closes the dialog', (await waitFor(async () => (await overlayMode()) === null)) === true, await overlayMode());

  const refuse = await inApp("return s.qr.open(ctx, 'lumen://chat')");
  check('QR: a lumen:// page is refused', refuse.ok === false && refuse.error === 'scheme', JSON.stringify(refuse));
  const refuseFile = await inApp('return s.qr.open(ctx, ctx.wc.getURL().replace(/^http/, "file"))');
  check('QR: a file:// address is refused', refuseFile.ok === false, JSON.stringify(refuseFile));
  const tooLong = await inApp("return s.qr.open(ctx, 'https://a.example/' + 'x'.repeat(2100))");
  check('QR: an address over 2000 characters is refused', tooLong.ok === false && tooLong.error === 'too-long', JSON.stringify(tooLong));
  const longOk = await inApp("return s.qr.open(ctx, 'https://a.example/' + 'x'.repeat(900))");
  await overlayReady('qr');
  check('QR: an address over 800 characters gets a warning', longOk.ok && (await inOverlay("document.getElementById('m-warn').hidden === false && /918/.test(document.getElementById('m-warn').textContent)")) === true, JSON.stringify(longOk));
  await inOverlay("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");
  const sel = await inApp("return s.qr.open(ctx, 'hello world', 'text')");
  check('QR: selected text makes a code', sel.ok, JSON.stringify(sel));
  await inOverlay("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");
  const selLong = await inApp("return s.qr.open(ctx, 'y'.repeat(501), 'text')");
  check('QR: a selection over 500 characters is refused', selLong.ok === false && selLong.error === 'too-long', JSON.stringify(selLong));

  check('no page errors in the browser UI', errors.length === 0, errors.join(' | '));

  await app.close().catch(() => {});
  server.close();
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  fs.rmSync(out, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
