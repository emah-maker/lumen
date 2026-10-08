// Draws an SVG (the screenshot path of the annotate tool: a picture of the tab with the marks over it) into a PNG, in a
// hidden offscreen window that is never shown or focused and has scripts off. Hard-limited in time; the window is always destroyed.
async function rasterize(svg, w, h, { timeoutMs = 8000 } = {}) {
  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({
    show: false, width: w, height: h, useContentSize: true, frame: false, skipTaskbar: true, focusable: false, paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, javascript: false, backgroundThrottling: false },
  });
  let timer;
  try {
    const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff"><img width="${w}" height="${h}" style="display:block" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`;
    const work = (async () => {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      await new Promise((r) => setTimeout(r, 200));
      const image = await win.webContents.capturePage();
      if (image.isEmpty()) throw new Error('empty');
      return image.toPNG();
    })();
    return await Promise.race([work, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('drawing timed out')), timeoutMs); })]);
  } finally {
    clearTimeout(timer);
    try { win.destroy(); } catch { /* gone */ }
  }
}
module.exports = { rasterize };
