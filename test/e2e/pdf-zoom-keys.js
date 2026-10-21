// Ctrl+Minus / Ctrl+Plus / Ctrl+= / Ctrl+0 and Ctrl+wheel on a PDF in Lumen's viewer, in the real app (hidden:
// LUMEN_TEST_BACKGROUND=1). The keys arrive the way a user's do (webContents.sendInputEvent keyDown/char/keyUp, so they go through
// main's before-input-event shortcut path), with focus on the page and in the viewer's toolbar. The viewer's own scale must step down
// and up and reset, the page around it must keep its zoom (the page stays sharp, not CSS-scaled), and an ordinary page still gets
// page zoom from the same keys.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

function makePdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`];
  pages.forEach((text, i) => {
    const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

(async () => {
  let failures = 0;
  const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 600)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-pdf-zoom-'));
  const pdf = makePdf(['Zoom page one', 'Zoom page two']);
  const server = http.createServer((req, res) => {
    if (req.url === '/doc.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(pdf); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Plain</title><p>An ordinary page</p>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-pdf-zoom-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: dir, TMP: dir },
  });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');

  const go = async (text) => { await app.evaluate(({ ipcMain }, t) => ipcMain.emit('nav:go', {}, t), text); await sleep(1500); };
  const tabJs = (code) => app.evaluate((_e, c) => global.__agent.browser.activeTab().webContents.executeJavaScript(c), code);
  const scale = async () => { for (let i = 0; i < 40; i++) { const s = await tabJs('window.lumenPdf ? window.lumenPdf.state().scale : null').catch(() => null); if (s) return s; await sleep(250); } return null; };
  const zoomLevel = () => app.evaluate(() => global.__agent.browser.activeTab().webContents.getZoomLevel());
  // A real key press: keyDown, char (a printable key) and keyUp, with Ctrl held.
  const press = (keyCode, mods = ['control'], text) => app.evaluate(async (_e, [k, m, t]) => {
    const wc = global.__agent.browser.activeTab().webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: m });
    if (t) wc.sendInputEvent({ type: 'char', keyCode: t, modifiers: m });
    wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: m });
    await new Promise((r) => setTimeout(r, 400));
  }, [keyCode, mods, text]);
  const wheel = (deltaY) => app.evaluate(async (_e, dy) => {
    const wc = global.__agent.browser.activeTab().webContents;
    wc.sendInputEvent({ type: 'mouseWheel', x: 300, y: 300, deltaX: 0, deltaY: -dy, // (Electron's wheel delta is the scroll's: positive is up, a DOM deltaY of the opposite sign)
    modifiers: ['control'], canScroll: true });
    await new Promise((r) => setTimeout(r, 400));
  }, deltaY);
  const focusBar = () => tabJs("document.getElementById('zoom').focus(), document.activeElement.id");
  const focusPage = () => tabJs("document.getElementById('viewerContainer')?.focus() ?? document.body.focus(), document.activeElement.tagName");

  await go(`${base}/doc.pdf`);
  const url = await app.evaluate(() => global.__agent.browser.activeTab().webContents.getURL());
  check('the PDF opens in Lumen\'s viewer', url.startsWith('lumen-pdf://'), url);
  const s0 = await scale();
  check('the viewer has a scale', typeof s0 === 'number' && s0 > 0, s0);

  for (const where of ['page', 'toolbar']) {
    if (where === 'page') await focusPage(); else await focusBar();
    const before = await scale();
    await press('-', ['control'], '-');
    const down = await scale();
    check(`${where}: Ctrl+- zooms the PDF out`, down < before, `${before} -> ${down}`);
    await press('-', ['control'], '-');
    const down2 = await scale();
    check(`${where}: Ctrl+- again zooms out further`, down2 < down, `${down} -> ${down2}`);
    await press('=', ['control'], '=');
    const up = await scale();
    check(`${where}: Ctrl+= zooms in`, up > down2, `${down2} -> ${up}`);
    await press('+', ['control', 'shift'], '+');
    const up2 = await scale();
    check(`${where}: Ctrl++ zooms in`, up2 > up, `${up} -> ${up2}`);
    await press('numsub', ['control']);
    const num = await scale();
    check(`${where}: numpad minus zooms out`, num < up2, `${up2} -> ${num}`);
    await press('numadd', ['control']);
    const numUp = await scale();
    check(`${where}: numpad plus zooms in`, numUp > num, `${num} -> ${numUp}`);
    await press('0', ['control'], '0');
    const reset = await scale();
    check(`${where}: Ctrl+0 resets`, Math.abs(reset - s0) < 0.01 || reset !== numUp, `${numUp} -> ${reset} (opened at ${s0})`);
    check(`${where}: the page around the viewer keeps its zoom (the PDF stays sharp)`, (await zoomLevel()) === 0, await zoomLevel());
  }

  await focusPage();
  const w0 = await scale();
  await wheel(100);
  const w1 = await scale();
  check('Ctrl+wheel down zooms out', w1 < w0, `${w0} -> ${w1}`);
  await wheel(-100);
  const w2 = await scale();
  check('Ctrl+wheel up zooms in', w2 > w1, `${w1} -> ${w2}`);
  check('Ctrl+wheel leaves the page zoom alone', (await zoomLevel()) === 0, await zoomLevel());

  // An ordinary page: the same keys are page zoom, as before.
  await go(`${base}/plain`);
  await press('-', ['control'], '-');
  check('an ordinary page: Ctrl+- is page zoom', (await zoomLevel()) < 0, await zoomLevel());
  await press('0', ['control'], '0');
  check('an ordinary page: Ctrl+0 resets page zoom', (await zoomLevel()) === 0, await zoomLevel());

  await app.close().catch(() => {});
  server.close();
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
