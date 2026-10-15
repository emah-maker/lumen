// Pictures in the slide viewer, in the real app (hidden Electron run: LUMEN_TEST_BACKGROUND=1, a profile of its own). Decks are generated here
// (test/_pptx-fixtures.js), opened as tabs, and each case is checked two ways: the boxes in the DOM (EMU -> px at the viewer's scale), and a
// capturePage pixel probe at points that only come out right if the picture is where it belongs, cropped, flipped, rotated, tiled or filtered
// the way PowerPoint does it. Then a 4:3 deck, z-order of text over pictures, and the open-time budgets of a 60 slide deck with 100 pictures:
// no main-process stall over 20 ms (a setImmediate probe) and no renderer long task over 100 ms.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const F = require('./_pptx-fixtures');

const MAIN_GAP_MS = 20;
const LONG_TASK_MS = 100;

(async () => {
  let failures = 0;
  const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 20000, every = 100) => { const end = Date.now() + ms; for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v || Date.now() > end) return v; await sleep(every); } };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-pptx-images-'));
  const work = path.join(root, 'tmp'); const profile = path.join(root, 'profile'); const docs = path.join(root, 'docs');
  for (const d of [work, profile, docs]) fs.mkdirSync(d);
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: work, TMP: work, ANTHROPIC_API_KEY: 'sk-ant-test' };
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env, timeout: 60000 });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await sleep(2000);

    // ---- a JPEG that says "rotate me" (EXIF orientation 6): made by Electron itself, with the EXIF segment added here
    const exifJpeg = await app.evaluate(({ nativeImage }) => {
      const w = 60; const h = 30; const bmp = Buffer.alloc(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; const left = x < w / 2; bmp[o] = left ? 0 : 255; bmp[o + 1] = 0; bmp[o + 2] = left ? 255 : 0; bmp[o + 3] = 255; } // BGRA: left red, right blue
      return nativeImage.createFromBitmap(bmp, { width: w, height: h }).toJPEG(95).toString('base64');
    });
    const jpeg = Buffer.from(exifJpeg, 'base64');
    const exif = Buffer.from([0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
    const rotatedJpeg = Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);

    // ---- the case deck: slide i has the case named in CASES[i]
    const bands = F.png(30, 30, (_x, y) => (y < 10 ? F.RED : y < 20 ? F.GREEN : F.BLUE));
    const big = F.png(4100, 3000, (x, y) => [x % 256, y % 256, 90]);
    const layoutPh = `<p:sp><p:nvSpPr><p:cNvPr id="5" name="Pic ph"/><p:cNvSpPr/><p:nvPr><p:ph type="pic" idx="13"/></p:nvPr></p:nvSpPr><p:spPr>${F.xfrm({ x: 400, y: 100, w: 300, h: 200 })}</p:spPr></p:sp>`;
    const emf = Buffer.concat([Buffer.from([1, 0, 0, 0, 0x6c, 0, 0, 0]), Buffer.alloc(200)]);
    const Q = F.quadrants();
    const I = (id, name) => F.imageRel(id, name);
    const CASES = [
      { name: 'crop', shapes: F.pic({ rid: 'q', box: { x: 100, y: 100, w: 200, h: 200 }, src: 'l="50000" t="50000"' }), rels: [I('q', 'q.png')] },
      { name: 'flips and rotation', shapes: F.pic({ id: 11, rid: 'q', box: { x: 50, y: 100, w: 200, h: 200, flipH: true } }) + F.pic({ id: 12, rid: 'q', box: { x: 300, y: 100, w: 200, h: 200, flipV: true } }) + F.pic({ id: 13, rid: 'q', box: { x: 600, y: 100, w: 200, h: 200, rot: 90 } }), rels: [I('q', 'q.png')] },
      { name: 'group', shapes: F.group({ box: { x: 100, y: 100, w: 400, h: 200 }, chOff: { x: 0, y: 0 }, chExt: { w: 200, h: 100 }, children: F.pic({ rid: 'q', box: { x: 0, y: 0, w: 100, h: 100 } }) }), rels: [I('q', 'q.png')] },
      { name: 'shape fills', shapes: F.picShape({ rid: 'q', box: { x: 50, y: 50, w: 200, h: 200 }, geom: 'ellipse' }) + F.picShape({ id: 21, rid: 'q', box: { x: 400, y: 300, w: 300, h: 150 }, tile: 'sx="100000" sy="100000"' }), rels: [I('q', 'q.png')] },
      { name: 'background picture', shapes: F.rect({ box: { x: 0, y: 0, w: 1, h: 1 } }), bg: F.bgPicture('b'), rels: [I('b', 'bands.png')] },
      { name: 'placeholder from the layout', shapes: F.picturePlaceholder({ rid: 'y' }), rels: [I('y', 'yellow.png')] },
      { name: 'svg with png fallback', shapes: F.pic({ rid: 'r', svg: 's', box: { x: 100, y: 100, w: 200, h: 200 } }), rels: [I('r', 'red.png'), I('s', 'blue.svg')] },
      { name: 'emf', shapes: F.pic({ rid: 'e', box: { x: 100, y: 100, w: 200, h: 200 } }), rels: [I('e', 'x.emf')] },
      { name: 'alpha', shapes: F.rect({ box: { x: 0, y: 0, w: 960, h: 540 } }) + F.pic({ id: 11, rid: 'r', box: { x: 100, y: 100, w: 200, h: 200 }, fx: '<a:alphaModFix amt="50000"/>' }), rels: [I('r', 'red.png')] },
      { name: 'gray and duotone', shapes: F.pic({ id: 11, rid: 'r', box: { x: 100, y: 100, w: 200, h: 200 }, fx: '<a:grayscl/>' }) + F.pic({ id: 12, rid: 'r', box: { x: 400, y: 100, w: 200, h: 200 }, fx: '<a:duotone><a:srgbClr val="0000FF"/><a:srgbClr val="FFFF00"/></a:duotone>' }), rels: [I('r', 'red.png')] },
      { name: 'table cell', shapes: F.table({ box: { x: 100, y: 100, w: 400, h: 150 }, cellFill: '<a:blipFill><a:blip r:embed="g"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>' }), rels: [I('g', 'green.png')] },
      { name: 'hyperlink', shapes: F.pic({ rid: 'r', box: { x: 100, y: 100, w: 200, h: 200 }, link: 'h' }), rels: [I('r', 'red.png'), ['h', 'hyperlink', 'https://example.com/', true]] },
      { name: 'large picture', shapes: F.pic({ rid: 'big', box: { x: 100, y: 100, w: 300, h: 200 } }), rels: [I('big', 'big.png')] },
      { name: 'exif orientation', shapes: F.pic({ rid: 'j', box: { x: 100, y: 100, w: 100, h: 200 } }), rels: [I('j', 'rot.jpg')] },
      { name: 'text over a picture', shapes: F.pic({ rid: 'r', box: { x: 100, y: 100, w: 400, h: 200 } }) + F.rect({ id: 31, box: { x: 150, y: 150, w: 200, h: 60 }, color: 'FFFFFF', text: 'Over' }), rels: [I('r', 'red.png')] },
    ];
    const media = { 'q.png': Q, 'bands.png': bands, 'yellow.png': F.solid(F.YELLOW), 'red.png': F.solid(F.RED), 'blue.svg': F.svgOf('#0000ff'), 'x.emf': emf, 'green.png': F.solid(F.GREEN), 'big.png': big, 'rot.jpg': rotatedJpeg };
    const deckFile = path.join(docs, 'cases.pptx');
    fs.writeFileSync(deckFile, F.deck({ slides: CASES.map((c) => ({ shapes: c.shapes, rels: c.rels, bg: c.bg })), media, layout: { shapes: layoutPh } }));
    const at = (name) => CASES.findIndex((c) => c.name === name);

    // ---- opening a deck as a tab; the viewer's contents
    const win0 = async () => (await app.evaluate(() => global.__windows.list()))[0];
    const viewerOf = (nameHint) => app.evaluate(({ webContents }, hint) => { const wc = webContents.getAllWebContents().find((x) => /slides\.html/.test(x.getURL()) && decodeURIComponent(x.getURL()).includes(hint)); return wc ? wc.id : null; }, nameHint);
    const run = (id, code) => app.evaluate(({ webContents }, [i, c]) => webContents.fromId(i).executeJavaScript(c), [id, code]);
    const closeTabs = async () => { const w = await win0(); for (const t of w.tabs.slice(1)) await app.evaluate(({ ipcMain }, id) => ipcMain.emit('tab:close', {}, id), t.id); await sleep(300); };
    const openDeck = async (file, { observe = false } = {}) => {
      const w = await win0();
      await app.evaluate(({ webContents }, [id, u, obs]) => {
        const t = global.__windows.open(id, u);
        if (obs) {
          const wc = webContents.fromId(t.contentsId);
          wc.on('dom-ready', () => { if (/slides\.html/.test(wc.getURL())) wc.executeJavaScript('window.__long = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: "longtask", buffered: true }); } catch {}').catch(() => {}); });
        }
      }, [w.windowId, pathToFileURL(file).href, observe]);
      const hint = path.basename(file);
      const id = await waitFor(() => viewerOf(hint), 20000);
      if (id) await waitFor(async () => (await run(id, "document.body.dataset.ready")) === 'true', 30000, 100);
      return id;
    };
    const ready = (id) => run(id, 'document.body.dataset.ready');

    const cases = await openDeck(deckFile);
    check('the case deck opens in the viewer', Boolean(cases) && (await ready(cases)) === 'true', cases);

    // Brings slide i to the top, waits for its pictures, and returns where it is on screen.
    const show = (id, i) => run(id, `(async () => {
      const s = document.querySelectorAll('.slide')[${i}];
      window.scrollTo(0, s.getBoundingClientRect().top + scrollY - 70);
      const t0 = Date.now();
      while ((!s.firstChild || [...s.querySelectorAll('img')].some((m) => !m.complete || !m.naturalWidth) || [...s.querySelectorAll('.tiled')].some((l) => !l.style.backgroundImage)) && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 200));
      const r = s.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, iw: innerWidth, stageW: parseFloat(s.firstChild.style.width) };
    })()`);
    // The color at slide points (x, y in points) as the screen shows them.
    const colors = (id, rect, points) => app.evaluate(async ({ webContents }, [i, r, pts]) => {
      const img = await webContents.fromId(i).capturePage();
      const b = img.toBitmap(); const { width } = img.getSize(); const k = width / r.iw;
      return pts.map(([x, y]) => { const px = Math.round((r.left + (x / r.stageW) * r.width) * k); const py = Math.round((r.top + (y / r.stageW) * r.width) * k); const o = (py * width + px) * 4; return [b[o + 2], b[o + 1], b[o]]; });
    }, [id, rect, points]);
    const is = (c, target, tol = 40) => c && c.every((v, k) => Math.abs(v - target[k]) <= tol);
    const named = (c) => `rgb(${c})`;
    // The boxes of a slide's pictures, as fractions of the stage (points / stage width)
    const boxes = (id, i, sel) => run(id, `(() => { const s = document.querySelectorAll('.slide')[${i}]; const r = s.getBoundingClientRect(); const k = ${'960'} / r.width; return [...s.querySelectorAll('${sel}')].map((n) => { const b = n.getBoundingClientRect(); return { x: (b.left - r.left) * k, y: (b.top - r.top) * k, w: b.width * k, h: b.height * k }; }); })()`);
    const boxIs = (b, x, y, w, h, eps = 2) => b && Math.abs(b.x - x) <= eps && Math.abs(b.y - y) <= eps && Math.abs(b.w - w) <= eps && Math.abs(b.h - h) <= eps;

    if (cases) {
      // crop: only the bottom right quadrant (yellow) fills the 200 x 200 box at (100, 100)
      let r = await show(cases, at('crop'));
      let c = await colors(cases, r, [[110, 110], [290, 290], [200, 200]]);
      check('crop (srcRect l=50% t=50%): the box shows only the yellow quadrant', c.every((x) => is(x, F.YELLOW)), c.map(named).join(' '));
      check('crop: the box is at (100, 100) 200 x 200 points', boxIs((await boxes(cases, at('crop'), '.pic'))[0], 100, 100, 200, 200), JSON.stringify(await boxes(cases, at('crop'), '.pic')));

      // flips and rotation
      r = await show(cases, at('flips and rotation'));
      c = await colors(cases, r, [[75, 125], [225, 125], [75, 275], [325, 125], [325, 275], [775, 125], [625, 125], [625, 275]]);
      check('flipH: red and green swap (top left is green, top right red)', is(c[0], F.GREEN) && is(c[1], F.RED), `${named(c[0])} ${named(c[1])}`);
      check('flipH: the bottom left is yellow (blue and yellow swap too)', is(c[2], F.YELLOW), named(c[2]));
      check('flipV: top left is blue, bottom left red (top and bottom swap)', is(c[3], F.BLUE) && is(c[4], F.RED), `${named(c[3])} ${named(c[4])}`);
      check('rot 90 (clockwise): the red top left turns to the top right', is(c[5], F.RED), named(c[5]));
      check('rot 90: blue (bottom left) turns to the top left, yellow to the bottom left', is(c[6], F.BLUE) && is(c[7], F.YELLOW), `${named(c[6])} ${named(c[7])}`);

      // group: the child (0,0,100,100 in a 200 x 100 child space) fills 200 x 200 at (100, 100)
      r = await show(cases, at('group'));
      c = await colors(cases, r, [[120, 120], [280, 120], [120, 280]]);
      check('group: the picture is scaled by the group (red, green, blue corners of a 200 x 200 box)', is(c[0], F.RED) && is(c[1], F.GREEN) && is(c[2], F.BLUE), c.map(named).join(' '));
      check('group: the box in the DOM is (100, 100) 200 x 200', boxIs((await boxes(cases, at('group'), '.pic'))[0], 100, 100, 200, 200), JSON.stringify(await boxes(cases, at('group'), '.pic')));

      // shape fills: an ellipse (the corner of its box is outside it), a tile (60 pt in is still the first tile's right half)
      r = await show(cases, at('shape fills'));
      c = await colors(cases, r, [[120, 100], [55, 55], [460, 310], [495, 310]]);
      check('shape fill: the picture is stretched inside the ellipse (red at its upper left)', is(c[0], F.RED), named(c[0]));
      check('shape fill: the corner of the ellipse\'s box is not the picture (the slide shows)', is(c[1], [255, 255, 255]), named(c[1]));
      check('tile: at 60 points in, the first tile\'s right half (green); a stretched fill would be red there', is(c[2], F.GREEN), named(c[2]));
      check('tile: the pattern repeats (20 points into the second tile is red)', is(c[3], F.RED), named(c[3]));

      // background picture: stretched to the whole slide (bands: red, green, blue thirds), not covered
      r = await show(cases, at('background picture'));
      c = await colors(cases, r, [[480, 60], [480, 270], [480, 480]]);
      check('background picture is stretched to the slide (red, green, blue bands top to bottom)', is(c[0], F.RED) && is(c[1], F.GREEN) && is(c[2], F.BLUE), c.map(named).join(' '));

      // placeholder: the layout says (400, 100) 300 x 200
      r = await show(cases, at('placeholder from the layout'));
      c = await colors(cases, r, [[550, 200], [380, 200]]);
      check('a picture placeholder is drawn where the layout puts it', is(c[0], F.YELLOW) && !is(c[1], F.YELLOW), c.map(named).join(' '));
      check('...as a box of (400, 100) 300 x 200', boxIs((await boxes(cases, at('placeholder from the layout'), '.pic'))[0], 400, 100, 300, 200), JSON.stringify(await boxes(cases, at('placeholder from the layout'), '.pic')));

      // SVG with a PNG fallback: the SVG (blue) is what is drawn, not the red fallback
      r = await show(cases, at('svg with png fallback'));
      c = await colors(cases, r, [[200, 200]]);
      check('svg with a png fallback: the SVG is drawn (blue, not the red fallback)', is(c[0], F.BLUE), named(c[0]));

      // EMF
      r = await show(cases, at('emf'));
      const label = await run(cases, `document.querySelectorAll('.slide')[${at('emf')}].querySelector('.pic.missing')?.textContent || ''`);
      check('an EMF picture is a clean labelled placeholder (no broken image)', /Picture not shown/.test(label) && /EMF/.test(label), label);
      check('...and no <img> was made for it', (await run(cases, `document.querySelectorAll('.slide')[${at('emf')}].querySelectorAll('img').length`)) === 0);

      // alpha 50% red over white
      r = await show(cases, at('alpha'));
      c = await colors(cases, r, [[200, 200], [700, 400]]);
      check('alpha: 50% red over white is pink (not solid red, not white)', c[0][0] > 230 && c[0][1] > 90 && c[0][1] < 170, named(c[0]));

      // gray and duotone
      r = await show(cases, at('gray and duotone'));
      c = await colors(cases, r, [[200, 200], [500, 200]]);
      check('grayscale: red turns gray (r = g = b)', Math.abs(c[0][0] - c[0][1]) < 12 && Math.abs(c[0][1] - c[0][2]) < 12, named(c[0]));
      check('duotone blue to yellow: red\'s dark gray level lands on the blue end', c[1][2] > c[1][0] + 60, named(c[1]));

      // table cell picture
      r = await show(cases, at('table cell'));
      c = await colors(cases, r, [[110, 240], [250, 240], [450, 240]]);
      check('a picture in a table cell fills the cell (green); the next cell has none', is(c[0], F.GREEN) && is(c[1], F.GREEN) && !is(c[2], F.GREEN), c.map(named).join(' '));

      // hyperlink
      await show(cases, at('hyperlink'));
      const link = await run(cases, `(() => { const a = document.querySelectorAll('.slide')[${at('hyperlink')}].querySelector('a.pic'); return a ? [a.getAttribute('href'), a.target, a.rel] : null; })()`);
      check('a linked picture is a link (https only, new tab, noopener)', link && link[0] === 'https://example.com/' && link[1] === '_blank' && /noopener/.test(link[2]), JSON.stringify(link));

      // large picture: shrunk for display
      r = await show(cases, at('large picture'));
      const info = await run(cases, 'window.lumenSlidesInfo()');
      const natural = await run(cases, `(() => { const m = document.querySelectorAll('.slide')[${at('large picture')}].querySelector('img'); return m ? [m.naturalWidth, m.naturalHeight] : null; })()`);
      check('a 4100 x 3000 picture is shrunk for display (long side 2560)', info.shrunk.length === 1 && natural && Math.max(...natural) <= 2560, JSON.stringify([info, natural]));
      c = await colors(cases, r, [[200, 200]]);
      check('...and still drawn there', c[0] && !is(c[0], [255, 255, 255], 10), named(c[0]));

      // EXIF orientation 6: a 60 x 30 picture (left red, right blue) shows as 30 x 60: top red, bottom blue
      r = await show(cases, at('exif orientation'));
      c = await colors(cases, r, [[150, 130], [150, 270]]);
      check('JPEG with EXIF orientation 6 is shown turned (top red, bottom blue)', is(c[0], F.RED, 60) && is(c[1], F.BLUE, 60), c.map(named).join(' '));

      // z-order: the text box (a later shape) is above the picture, and its pixels are the box's, not the picture's
      r = await show(cases, at('text over a picture'));
      c = await colors(cases, r, [[160, 200], [450, 160]]);
      const order = await run(cases, `(() => { const s = document.querySelectorAll('.slide')[${at('text over a picture')}].firstChild.children; return [...s].map((n) => n.className); })()`);
      check('text over a picture: the picture is drawn first, the shape with the text after it', order[0] === 'pic' && order[1] === 'shape', JSON.stringify(order));
      check('...so the white box covers the red picture (white at (160, 200), red at (450, 160))', is(c[0], [255, 255, 255]) && is(c[1], F.RED), c.map(named).join(' '));
    }
    await closeTabs();

    // ---- a 4:3 deck
    const d43 = path.join(docs, 'four-three.pptx');
    fs.writeFileSync(d43, F.deck({ width: 9144000, height: 6858000, slides: [{ shapes: F.pic({ rid: 'q', box: { x: 360, y: 270, w: 360, h: 270 } }), rels: [I('q', 'q.png')] }], media: { 'q.png': Q } }));
    const v43 = await openDeck(d43);
    if (v43) {
      const r = await show(v43, 0);
      check('4:3: the slide frame is 4:3', Math.abs(r.width / r.height - 4 / 3) < 0.01, `${r.width} x ${r.height}`);
      const c = await colors(v43, r, [[400, 300], [700, 300], [400, 500], [700, 500], [100, 100]]);
      check('4:3: a picture in the lower right quarter has its four colors in place and the slide is white elsewhere', is(c[0], F.RED) && is(c[1], F.GREEN) && is(c[2], F.BLUE) && is(c[3], F.YELLOW) && is(c[4], [255, 255, 255]), c.map(named).join(' '));
    } else check('4:3 deck opens', false, 'no viewer');
    await closeTabs();

    // ---- the same picture under three names, used on 12 slides: one blob
    const same = path.join(docs, 'same.pptx');
    fs.writeFileSync(same, F.deck({
      slides: Array.from({ length: 12 }, (_, i) => ({ shapes: F.pic({ rid: 'q', box: { x: 100, y: 100, w: 100, h: 100 } }), rels: [I('q', `q${i % 3}.png`)] })),
      media: { 'q0.png': Q, 'q1.png': Q, 'q2.png': Q },
    }));
    const vs = await openDeck(same);
    if (vs) {
      for (let i = 0; i < 12; i++) await show(vs, i);
      const info = await run(vs, 'window.lumenSlidesInfo()');
      check('duplicate pictures (12 slides, 3 names for the same bytes) make one blob URL', info.blobs === 1 && info.images >= 12, JSON.stringify(info));
    } else check('duplicate deck opens', false, 'no viewer');
    await closeTabs();

    // ---- performance: 60 slides, 100 pictures (each different, noisy so they do not compress away)
    const perfFile = path.join(docs, 'perf.pptx');
    let seed = 12345;
    const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed >> 8; };
    const perfMedia = {};
    for (let i = 0; i < 100; i++) perfMedia[`p${i}.png`] = F.png(200, 150, (x, y) => [noise() % 256, (x * 3 + i) % 256, (y * 5 + noise() % 40) % 256]);
    let n = 0;
    const perfSlides = Array.from({ length: 60 }, (_, s) => {
      const count = s < 40 ? 2 : 3; let shapes = ''; const rels = [];
      for (let k = 0; k < count; k++) { const id = `r${k}`; rels.push(I(id, `p${n % 100}.png`)); shapes += F.pic({ id: 10 + k, rid: id, box: { x: 40 + k * 300, y: 120, w: 280, h: 210 }, src: k === 1 ? 'l="10000" r="10000"' : '' }); n++; }
      shapes += F.rect({ id: 99, box: { x: 40, y: 20, w: 600, h: 60 }, color: 'FFFFFF', text: `Slide ${s + 1}` });
      return { shapes, rels };
    });
    fs.writeFileSync(perfFile, F.deck({ slides: perfSlides, media: perfMedia }));
    const size = fs.statSync(perfFile).size;
    // a setImmediate probe in the main process: the longest gap between two turns of its loop
    await app.evaluate(() => {
      global.__gap = { max: 0, on: true };
      let last = Date.now();
      const turn = () => { const now = Date.now(); if (now - last > global.__gap.max) global.__gap.max = now - last; last = now; if (global.__gap.on) setImmediate(turn); };
      setImmediate(turn);
    });
    await sleep(1500);
    const idle = await app.evaluate(() => { const m = global.__gap.max; global.__gap.max = 0; return m; });
    const t0 = Date.now();
    const vp = await openDeck(perfFile, { observe: true });
    const opened = Date.now() - t0;
    let gap = null; let long = null;
    if (vp) {
      for (let i = 0; i < 60; i += 3) { await run(vp, `document.querySelectorAll('.slide')[${i}].scrollIntoView()`); await sleep(60); } // scrolling through draws every slide
      await sleep(1500);
      long = await run(vp, 'window.__long || []');
    }
    gap = await app.evaluate(() => { global.__gap.on = false; return global.__gap.max; });
    check(`60 slides, 100 pictures (${(size / 1048576).toFixed(1)} MB) open (${opened} ms)`, Boolean(vp) && (await ready(vp)) === 'true', 'no viewer');
    check(`no main-process stall over ${MAIN_GAP_MS} ms while it opens and is scrolled (worst ${gap} ms; idle before ${idle} ms)`, gap <= MAIN_GAP_MS, `${gap} (idle ${idle})`);
    check(`no renderer long task over ${LONG_TASK_MS} ms (worst ${long && long.length ? Math.max(...long) : 0} ms, ${long ? long.length : '?'} over 50 ms)`, long && Math.max(0, ...long) <= LONG_TASK_MS, JSON.stringify(long));
    if (vp) {
      const total = await run(vp, 'window.lumenSlidesInfo()');
      check('every picture shares a blob URL per distinct picture (100 pictures, at most 100 blobs)', total.blobs <= 100 && total.images >= 100, JSON.stringify(total));
      const lazy = await run(vp, "[...document.querySelectorAll('.stage img')].every((m) => m.loading === 'lazy' && m.decoding === 'async')");
      check('pictures are loading=lazy and decoding=async', lazy === true, lazy);
    }
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
