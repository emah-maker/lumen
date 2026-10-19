// The AI's scroll / click_at / press_key on a PDF tab (features/pdf-input.js), plain Node with mocked
// webContents: the viewer frame is found, scrolling runs through the viewer's viewport, clicks go over
// the DevTools session, and a tab that is not a PDF is left to the ordinary page tools (null).
const vm = require('vm');
const pdfInput = require('../src/features/pdf-input');
const { PDF_VIEWER } = require('../src/features/pdf-zoom');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const J = (v) => JSON.stringify(v);

// A viewer frame that runs the real script against a fake viewport (10 pages of 800px, a 600px window).
function viewerFake({ y = 0, content = 8000, broken = false } = {}) {
  const vp = {
    position: { x: 0, y }, size: { height: 600 }, contentSize: { height: content }, pageDimensions_: new Array(10).fill(0),
    setPosition(p) { this.position = { x: p.x, y: p.y }; },
    getMostVisiblePage() { return Math.floor((this.position.y + 300) / 800); },
  };
  const viewer = { viewport_: vp };
  const sandbox = { document: { querySelector: (s) => (s === 'pdf-viewer' && !broken ? viewer : null), querySelectorAll: () => [] }, setTimeout, Date, Math };
  return { vp, frame: { url: `${PDF_VIEWER}/index.html`, executeJavaScript: (code) => vm.runInNewContext(code, sandbox) } };
}
const tabWith = (frames, extra = {}) => ({ mainFrame: { framesInSubtree: frames }, ...extra });
const pageFrame = { url: 'file:///a.pdf', executeJavaScript: async () => { throw new Error('the top frame must not be scripted'); } };

(async () => {
  // ---- scroll
  {
    const v = viewerFake();
    const wc = tabWith([pageFrame, v.frame]);
    const r = await pdfInput.scrollPdf(wc, { screens: 1 });
    check('scroll: down one screen moves the viewport by 85% of its height and reports the page', v.vp.position.y === 510 && r.scrolled === 'pdf' && r.y === 510 && r.where === 'page 2 of 10', J({ r, y: v.vp.position.y }));
    const r2 = await pdfInput.scrollPdf(wc, { screens: 3 });
    check('scroll: later screens carry on and the page number follows', v.vp.position.y === 2040 && r2.where === 'page 3 of 10', J(r2));
    const r3 = await pdfInput.scrollPdf(wc, { screens: -1 });
    check('scroll: up goes back', v.vp.position.y === 1530 && r3.scrolled === 'pdf', J(r3));
  }
  {
    const v = viewerFake({ y: 7390 });
    const r = await pdfInput.scrollPdf(tabWith([v.frame]), { screens: 2 });
    check('scroll: stops at the end of the document and says so when it cannot move', v.vp.position.y === 7400 && r.scrolled === 'pdf', J(r));
    const again = await pdfInput.scrollPdf(tabWith([v.frame]), { screens: 1 });
    check('scroll: at the end it is honest, and points to read_pdf', again.scrolled === 'none' && /end of the PDF/.test(again.note) && /read_pdf/.test(again.note), J(again));
    const top = viewerFake();
    const up = await pdfInput.scrollPdf(tabWith([top.frame]), { screens: -1 });
    check('scroll: at the top, up says so', up.scrolled === 'none' && /top of the PDF/.test(up.note), J(up));
  }
  {
    const v = viewerFake();
    const r = await pdfInput.scrollPdf(tabWith([v.frame]), { to: 'bottom' });
    check('scroll: to the bottom', v.vp.position.y === 7400 && r.where === 'page 10 of 10', J(r));
    await pdfInput.scrollPdf(tabWith([v.frame]), { to: 'top' });
    check('scroll: to the top', v.vp.position.y === 0);
  }
  {
    const wc = tabWith([pageFrame]);
    check('scroll: a tab with no PDF viewer is left to the page scroll (null)', (await pdfInput.scrollPdf(wc, { screens: 1 })) === null);
    check('scroll: a destroyed or odd tab does not throw', (await pdfInput.scrollPdf({ get mainFrame() { throw new Error('gone'); } }, { screens: 1 })) === null);
    const broken = viewerFake({ broken: true });
    const r = await pdfInput.scrollPdf(tabWith([broken.frame]), { screens: 1 });
    check('scroll: a viewer that does not answer says so instead of claiming a scroll', r.scrolled === 'none' && /read_pdf/.test(r.note), J(r));
    const throws = { url: `${PDF_VIEWER}/index.html`, executeJavaScript: async () => { throw new Error('frame gone'); } };
    const r2 = await pdfInput.scrollPdf(tabWith([throws]), { screens: 1 });
    check('scroll: a frame that throws is reported the same way', r2.scrolled === 'none', J(r2));
  }

  // ---- keys
  {
    const k = pdfInput.keyMove;
    check('keys: PageDown / Space page down, PageUp / Shift+Space page up', J(k('PageDown')) === J({ screens: 1 }) && J(k('Space')) === J({ screens: 1 }) && J(k('PageUp')) === J({ screens: -1 }) && J(k('Space', ['shift'])) === J({ screens: -1 }));
    check('keys: arrows step, Home and End jump', k('ArrowDown').lines > 0 && k('ArrowUp').lines < 0 && k('Home').to === 'top' && k('End').to === 'bottom');
    check('keys: shortcuts and other keys are not scrolls', k('PageDown', ['control']) === null && k('f', []) === null && k('Enter') === null && k('ArrowDown', ['meta']) === null);
  }

  // ---- clicks
  {
    const sent = [];
    const dbg = { on: false, isAttached() { return this.on; }, attach() { this.on = true; sent.push('attach'); }, detach() { this.on = false; sent.push('detach'); }, async sendCommand(m, p) { sent.push(`${m}:${p.type}:${p.x},${p.y}`); } };
    const wc = tabWith([viewerFake().frame], { debugger: dbg });
    const around = [];
    const ok = await pdfInput.clickPdf(wc, 120.4, 80.6, { around: async (fn) => { around.push('in'); await fn(); around.push('out'); } });
    check('click: the three mouse events go over the DevTools session, wrapped as the AI\'s input, and the session is released', ok === true && J(sent) === J(['attach', 'Input.dispatchMouseEvent:mouseMoved:120,81', 'Input.dispatchMouseEvent:mousePressed:120,81', 'Input.dispatchMouseEvent:mouseReleased:120,81', 'detach']) && J(around) === J(['in', 'out']), J({ sent, around }));
    dbg.on = true; sent.length = 0;
    await pdfInput.clickPdf(wc, 1, 2);
    check('click: a session someone else holds is reused and left attached', !sent.includes('attach') && !sent.includes('detach') && dbg.on);
    const failing = { ...dbg, on: false, attach() { throw new Error('another debugger'); } };
    check('click: when no session can be had it reports false, not a landed click', (await pdfInput.clickPdf(tabWith([viewerFake().frame], { debugger: failing }), 1, 2)) === false);
    check('click: a tab with no PDF viewer is left to the normal click (null)', (sent.length = 0, await pdfInput.clickPdf(tabWith([pageFrame], { debugger: dbg }), 1, 2)) === null && sent.length === 0);
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
