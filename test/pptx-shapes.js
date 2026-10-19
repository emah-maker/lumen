// Shapes in the slide viewer, in the real app (hidden Electron run: LUMEN_TEST_BACKGROUND=1, a profile of its own). A deck is generated here
// (test/_pptx-fixtures.js: braces, arrows, connectors with arrowheads and dashes, custom geometry, a donut, a 3D cube, a gradient arrow, a
// shape the viewer does not know), opened as a tab, and every case is checked two ways: the DOM (which elements draw the shape) and a
// capturePage pixel probe at points that are only the right color if the geometry is where the formulas put it (a brace's tip, an arrow's
// head, the hole of a donut, the gap between two dashes). The expected geometry is worked out from the ECMA-376 formulas, never from a screenshot.
// Last, a slide of 300 shapes: drawing it must not stall the page.
require('./_tmp-cleanup');
const { _electron: electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const F = require('./_pptx-fixtures');

(async () => {
  let failures = 0;
  const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 20000, every = 100) => { const end = Date.now() + ms; for (;;) { const v = await Promise.resolve().then(fn).catch(() => null); if (v || Date.now() > end) return v; await sleep(every); } };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-pptx-shapes-'));
  const work = path.join(root, 'tmp'); const profile = path.join(root, 'profile'); const docs = path.join(root, 'docs');
  for (const d of [work, profile, docs]) fs.mkdirSync(d);
  const env = { ...process.env, CLAUDE_BROWSER_TEST: '1', LUMEN_TEST_BACKGROUND: '1', CLAUDE_BROWSER_PROFILE: profile, TEMP: work, TMP: work, ANTHROPIC_API_KEY: 'sk-ant-test' };
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env, timeout: 60000 });
  try {
    const ui = await app.firstWindow();
    await ui.waitForSelector('.tab');
    await sleep(2000);

    const RED = [255, 0, 0]; const GREEN = [0, 255, 0]; const BLUE = [0, 0, 255]; const WHITE = [255, 255, 255]; const ORANGE = [255, 165, 0];
    const P = (o) => F.prstShape(o);
    const cust = (box, paths, fill = 'FFA500', line = null) => F.custShape({ box, paths, fill, line });

    // ---- the case deck: slide i has the case named in CASES[i]
    const gradient = P({ prst: 'rightArrow', box: { x: 100, y: 100, w: 400, h: 100 }, fill: '000000' }).replace('<a:solidFill><a:srgbClr val="000000"/></a:solidFill>', '<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst><a:lin ang="0"/></a:gradFill>');
    const CASES = [
      { name: 'brace', shapes: P({ prst: 'rightBrace', box: { x: 100, y: 100, w: 40, h: 200 }, line: { color: 'FF0000', w: 6 } }) + P({ id: 71, prst: 'leftBrace', box: { x: 300, y: 100, w: 40, h: 200 }, line: { color: 'FF0000', w: 6 } }) + P({ id: 72, prst: 'bracketPair', box: { x: 500, y: 100, w: 100, h: 200 }, line: { color: 'FF0000', w: 3 } }) },
      { name: 'arrows', shapes: P({ prst: 'rightArrow', box: { x: 100, y: 100, w: 200, h: 100 }, fill: '00FF00', line: { color: '000000', w: 1 } }) + P({ id: 71, prst: 'upArrow', box: { x: 400, y: 100, w: 100, h: 200 }, fill: '0000FF' }) + P({ id: 72, prst: 'leftRightArrow', box: { x: 100, y: 300, w: 300, h: 100 }, fill: 'FF0000' }) },
      { name: 'connectors', shapes: P({ tag: 'cxnSp', prst: 'straightConnector1', box: { x: 100, y: 100, w: 300, h: 0 }, line: { color: '0000FF', w: 6, head: 'oval', tail: 'triangle' } }) + P({ id: 71, tag: 'cxnSp', prst: 'bentConnector3', box: { x: 100, y: 200, w: 200, h: 100 }, line: { color: '0000FF', w: 3 } }) + P({ id: 72, tag: 'cxnSp', prst: 'bentConnector3', box: { x: 400, y: 200, w: 200, h: 100, flipV: true }, line: { color: '0000FF', w: 3 } }) + P({ id: 73, tag: 'cxnSp', prst: 'line', box: { x: 100, y: 400, w: 300, h: 0 }, line: { color: '0000FF', w: 4, dash: 'dash' } }) },
      { name: 'custom geometry', shapes: cust({ x: 100, y: 100, w: 200, h: 200 }, '<a:path w="100" h="100"><a:moveTo><a:pt x="0" y="100"/></a:moveTo><a:lnTo><a:pt x="50" y="0"/></a:lnTo><a:lnTo><a:pt x="100" y="100"/></a:lnTo><a:close/></a:path>') + cust({ x: 400, y: 100, w: 200, h: 200 }, '<a:path w="100" h="100"><a:moveTo><a:pt x="50" y="50"/></a:moveTo><a:lnTo><a:pt x="100" y="50"/></a:lnTo><a:arcTo wR="50" hR="50" stAng="0" swAng="5400000"/><a:close/></a:path>') },
      { name: 'basic shapes', shapes: P({ prst: 'donut', box: { x: 100, y: 100, w: 200, h: 200 }, fill: 'FF0000' }) + P({ id: 71, prst: 'star5', box: { x: 400, y: 100, w: 200, h: 200 }, fill: 'FF0000' }) + P({ id: 72, prst: 'triangle', box: { x: 100, y: 350, w: 200, h: 150 }, fill: '0000FF' }) },
      { name: '3d cube and gradient', shapes: P({ prst: 'cube', box: { x: 100, y: 300, w: 200, h: 200 }, fill: 'CC6666', line: { color: '000000', w: 1 } }) + gradient },
      { name: 'unknown preset', shapes: P({ prst: 'someBrandNewShape', box: { x: 100, y: 100, w: 200, h: 100 }, fill: '00FF00' }) },
      { name: 'many shapes', shapes: Array.from({ length: 300 }, (_v, i) => P({ id: 100 + i, prst: ['rightArrow', 'star5', 'hexagon', 'rightBrace', 'chevron', 'bracketPair'][i % 6], box: { x: (i % 20) * 46, y: Math.floor(i / 20) * 34, w: 40, h: 30 }, fill: i % 6 === 3 ? null : 'FFA500', line: { color: '000000', w: 1 } })).join('') },
    ];
    const deckFile = path.join(docs, 'shapes.pptx');
    fs.writeFileSync(deckFile, F.deck({ slides: CASES.map((c) => ({ shapes: c.shapes })) }));
    const at = (name) => CASES.findIndex((c) => c.name === name);

    const win0 = async () => (await app.evaluate(() => global.__windows.list()))[0];
    const viewerOf = (hint) => app.evaluate(({ webContents }, h) => { const wc = webContents.getAllWebContents().find((x) => /slides\.html/.test(x.getURL()) && decodeURIComponent(x.getURL()).includes(h)); return wc ? wc.id : null; }, hint);
    const run = (id, code) => app.evaluate(({ webContents }, [i, c]) => webContents.fromId(i).executeJavaScript(c), [id, code]);
    const openDeck = async (file) => {
      const w = await win0();
      await app.evaluate(({ webContents }, [id, u]) => {
        const t = global.__windows.open(id, u);
        const wc = webContents.fromId(t.contentsId);
        wc.on('dom-ready', () => { if (/slides\.html/.test(wc.getURL())) wc.executeJavaScript('window.__long = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: "longtask", buffered: true }); } catch {}'); });
      }, [w.windowId, pathToFileURL(file).href]);
      const id = await waitFor(() => viewerOf(path.basename(file)), 20000);
      if (id) await waitFor(async () => (await run(id, 'document.body.dataset.ready')) === 'true', 30000, 100);
      return id;
    };
    const viewer = await openDeck(deckFile);
    check('the shapes deck opens in the viewer', Boolean(viewer) && (await run(viewer, 'document.body.dataset.ready')) === 'true', viewer);

    // Brings slide i to the top and returns where it is on screen.
    const show = (id, i) => run(id, `(async () => {
      const s = document.querySelectorAll('.slide')[${i}];
      window.scrollTo(0, s.getBoundingClientRect().top + scrollY - 70);
      const t0 = Date.now();
      while (!s.firstChild && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 250));
      const r = s.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, iw: innerWidth, stageW: parseFloat(s.firstChild.style.width) };
    })()`);
    // The color at slide points (x, y in points) as the screen shows them.
    const colors = (id, rect, points) => app.evaluate(async ({ webContents }, [i, r, pts]) => {
      const img = await webContents.fromId(i).capturePage();
      const b = img.toBitmap(); const { width } = img.getSize(); const k = width / r.iw;
      return pts.map(([x, y]) => { const px = Math.round((r.left + (x / r.stageW) * r.width) * k); const py = Math.round((r.top + (y / r.stageW) * r.width) * k); const o = (py * width + px) * 4; return [b[o + 2], b[o + 1], b[o]]; });
    }, [id, rect, points]);
    const is = (c, target, tol = 45) => c && c.every((v, k) => Math.abs(v - target[k]) <= tol);
    const named = (c) => `rgb(${c})`;
    const all = (cs, target) => cs.every((c) => is(c, target));
    const dom = (id, i, code) => run(id, `(() => { const s = document.querySelectorAll('.slide')[${i}]; return (${code})(s); })()`);

    if (viewer) {
      // brace: a red outline, no border box
      let r = await show(viewer, at('brace'));
      let c = await colors(viewer, r, [[138, 200], [120, 150], [100, 200], [128, 290], [302, 200], [320, 150], [340, 200], [500, 200], [600, 200], [550, 200]]);
      check('rightBrace: the tip (138, 200) and the spine (120, 150) are red', is(c[0], RED) && is(c[1], RED), `${named(c[0])} ${named(c[1])}`);
      check('rightBrace: the box edge (100, 200) is not drawn: the brace is open, not a rectangle', is(c[2], WHITE) && is(c[3], WHITE), `${named(c[2])} ${named(c[3])}`);
      check('leftBrace: tip on the left edge (302, 200) and the spine (320, 150); the right edge (340, 200) is empty', is(c[4], RED) && is(c[5], RED) && is(c[6], WHITE), c.slice(4, 7).map(named).join(' '));
      check('bracketPair: both brackets are drawn (left and right side at mid height) with nothing between them', is(c[7], RED) && is(c[8], RED) && is(c[9], WHITE), c.slice(7).map(named).join(' '));
      const parts = await dom(viewer, at('brace'), `(s) => ({ shapes: s.querySelectorAll('.shape').length, overlays: s.querySelectorAll('.shape svg.geo path').length, borders: [...s.querySelectorAll('.shape .bg')].filter((b) => b.style.border).length })`);
      check('the DOM: three shapes, each with an SVG outline over the box and no CSS border', parts.shapes === 3 && parts.overlays >= 3 && parts.borders === 0, JSON.stringify(parts));

      // arrows
      r = await show(viewer, at('arrows'));
      c = await colors(viewer, r, [[200, 150], [205, 110], [280, 150], [255, 110], [295, 105], [450, 250], [410, 250], [450, 120], [105, 350], [250, 350], [395, 350], [110, 310]]);
      check('rightArrow: the shaft and the head are green', is(c[0], GREEN) && is(c[2], GREEN) && is(c[3], GREEN), `${named(c[0])} ${named(c[2])} ${named(c[3])}`);
      check('rightArrow: above the shaft (205, 110) and above the head\'s tip (295, 105 is inside the notch) are empty', is(c[1], WHITE) && is(c[4], WHITE), `${named(c[1])} ${named(c[4])}`);
      check('upArrow: the shaft (450, 250) is blue, beside the shaft (410, 250) is empty, the head (450, 120) is blue', is(c[5], BLUE) && is(c[6], WHITE) && is(c[7], BLUE), `${named(c[5])} ${named(c[6])} ${named(c[7])}`);
      check('leftRightArrow: both heads and the shaft are red; the corners of the box are empty', is(c[8], RED) && is(c[9], RED) && is(c[10], RED) && is(c[11], WHITE), `${named(c[8])} ${named(c[9])} ${named(c[10])} ${named(c[11])}`);

      // connectors
      r = await show(viewer, at('connectors'));
      c = await colors(viewer, r, [[250, 100], [385, 106], [385, 112], [109, 106], [109, 113], [150, 200], [200, 250], [250, 300], [150, 300], [250, 200], [450, 300], [550, 200], [450, 200], [108, 400], [122, 400], [136, 400], [150, 400]]);
      check('a straight connector is drawn blue along its length', is(c[0], BLUE), named(c[0]));
      check('tailEnd triangle: the head is wider than the line (385, 106 is blue, 385, 112 is empty)', is(c[1], BLUE) && is(c[2], WHITE), `${named(c[1])} ${named(c[2])}`);
      check('headEnd oval: a dot wider than the line at the start (109, 106 is blue, 109, 113 is empty)', is(c[3], BLUE) && is(c[4], WHITE), `${named(c[3])} ${named(c[4])}`);
      check('bentConnector3: right, down, right (the elbow, not a diagonal and not a box)', is(c[5], BLUE) && is(c[6], BLUE) && is(c[7], BLUE) && is(c[8], WHITE) && is(c[9], WHITE), c.slice(5, 10).map(named).join(' '));
      check('bentConnector3 with flipV: the elbow is mirrored (right along the bottom, up, right along the top)', is(c[10], BLUE) && is(c[11], BLUE) && is(c[12], WHITE), c.slice(10, 13).map(named).join(' '));
      check('dashed line: dash, gap, dash (16 pt on, 12 pt off for a 4 pt line)', is(c[13], BLUE) && is(c[14], WHITE) && is(c[15], BLUE), c.slice(13, 16).map(named).join(' '));

      // custom geometry
      r = await show(viewer, at('custom geometry'));
      c = await colors(viewer, r, [[200, 250], [200, 115], [110, 120], [290, 120], [550, 250], [450, 250], [550, 150], [590, 290]]);
      check('custGeom triangle: filled inside, empty at the top left and top right corners of its box', is(c[0], ORANGE) && is(c[1], ORANGE) && is(c[2], WHITE) && is(c[3], WHITE), c.slice(0, 4).map(named).join(' '));
      check('custGeom pie (a line, then an arcTo, then close): only the lower right quarter circle is filled', is(c[4], ORANGE) && is(c[5], WHITE) && is(c[6], WHITE) && is(c[7], WHITE), c.slice(4).map(named).join(' '));

      // basic shapes
      r = await show(viewer, at('basic shapes'));
      c = await colors(viewer, r, [[200, 200], [110, 200], [200, 110], [105, 105], [500, 200], [500, 150], [405, 105], [595, 295], [200, 450], [120, 495], [105, 355]]);
      check('donut: red ring, empty hole, empty corner', is(c[1], RED) && is(c[2], RED) && is(c[0], WHITE) && is(c[3], WHITE), c.slice(0, 4).map(named).join(' '));
      check('star5: red in the middle and the upper body; the corners of its box are empty', is(c[4], RED) && is(c[5], RED) && is(c[6], WHITE) && is(c[7], WHITE), c.slice(4, 8).map(named).join(' '));
      check('triangle: blue in the middle of the base, empty at the top corners of its box', is(c[8], BLUE) && is(c[9], BLUE) && is(c[10], WHITE), c.slice(8).map(named).join(' '));

      // 3D cube, gradient
      r = await show(viewer, at('3d cube and gradient'));
      c = await colors(viewer, r, [[150, 450], [200, 320], [275, 400], [150, 350], [120, 150], [400, 150], [260, 105]]);
      const front = c[0]; const top = c[1]; const side = c[2];
      check('cube: the top face is lighter and the side face darker than the front face', front && top && side && top[1] > front[1] + 15 && side[1] < front[1] - 10 && is(front, [204, 102, 102], 25), `front ${named(front)} top ${named(top)} side ${named(side)}`);
      check('a gradient fill follows the arrow\'s shape: red at the left, blue at the right, and the box corner is empty', c[4] && c[5] && c[4][0] > c[4][2] && c[5][2] > c[5][0] && is(c[6], WHITE), `${named(c[4])} ${named(c[5])} ${named(c[6])}`);

      // unknown preset: a box, and the log says which
      r = await show(viewer, at('unknown preset'));
      c = await colors(viewer, r, [[110, 110], [290, 190]]);
      check('an unknown preset is drawn as its box, filled', all(c, GREEN), c.map(named).join(' '));

      // many shapes: a slide of 300 path shapes
      const stall = await run(viewer, `(async () => { window.__long.length = 0; const s = document.querySelectorAll('.slide')[${at('many shapes')}]; const t0 = performance.now(); window.scrollTo(0, s.getBoundingClientRect().top + scrollY - 70); while (!s.firstChild && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 20)); const drawn = performance.now() - t0; await new Promise((r) => setTimeout(r, 400)); return { drawn: Math.round(drawn), shapes: s.querySelectorAll('.shape').length, long: window.__long.slice() }; })()`);
      console.log(`INFO  300 shapes drawn in ${stall.drawn} ms, long tasks: ${JSON.stringify(stall.long)}`);
      check('300 shapes on one slide are all drawn, with no render task over 100 ms', stall.shapes === 300 && stall.long.every((ms) => ms <= 100), JSON.stringify(stall));
    }
  } finally {
    await app.close().catch(() => {});
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
