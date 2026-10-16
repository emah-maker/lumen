// How pictures in a deck are READ (features/pptx.js), plain Node: crops, stretch and tile fills, rotation and flips, pictures inside groups
// (child offsets and extents, rotated and flipped groups), pictures as shape and table cell fills, slide / layout / master backgrounds,
// placeholders that take their place from the layout, SVG with a PNG fallback, EMF/WMF, effects, links, the same picture used twice.
const P = require('../src/features/pptx');
const F = require('./_pptx-fixtures');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const near = (a, b, eps = 0.5) => Math.abs(a - b) <= eps;
const inPt = (v) => v / 12700;
const box = (s) => ({ x: inPt(s.x), y: inPt(s.y), w: inPt(s.w), h: inPt(s.h), rot: s.rot, flipH: s.flipH });
const J = (v) => JSON.stringify(v);

(async () => {
  const Q = F.quadrants();
  const one = async (shapes, { rels = [], media = { 'image1.png': Q }, layout, master, bg, width, height } = {}) => {
    const buf = F.deck({ width, height, slides: [{ shapes, rels: [F.imageRel('rImg', 'image1.png'), ...rels], bg }], media, layout, master });
    const deck = await P.parsePptx(buf);
    return { deck, shapes: deck.slides[0].shapes.filter((s) => s.own) };
  };

  // ---- crop, flips, rotation
  {
    const { shapes } = await one(F.pic({ rid: 'rImg', box: { x: 100, y: 50, w: 200, h: 100, rot: 30, flipH: true }, src: 'l="25000" t="10000" r="5000" b="0"' }));
    const s = shapes[0];
    check('pic: box in points, rotation and flip', near(inPt(s.x), 100) && near(inPt(s.w), 200) && s.rot === 30 && s.flipH === true && !s.flipV, J(box(s)));
    check('pic: srcRect crop as fractions l t r b', J(s.crop.map((v) => Math.round(v * 1000) / 1000)) === '[0.25,0.1,0.05,0]', J(s.crop));
    check('pic: image is the media part', s.image === 'ppt/media/image1.png', s.image);
  }
  // ---- stretch fill rectangle, effects
  {
    const { shapes } = await one(F.pic({ rid: 'rImg', box: { x: 0, y: 0, w: 100, h: 100 }, fillRect: 'l="10000" t="20000" r="-5000" b="0"', fx: '<a:alphaModFix amt="50000"/><a:grayscl/>' }));
    const s = shapes[0];
    check('pic: fillRect (stretch into part of the box)', J(s.fillRect) === '[0.1,0.2,-0.05,0]', J(s.fillRect));
    check('pic: alphaModFix and grayscl effects', s.fx && s.fx.alpha === 0.5 && s.fx.gray === true, J(s.fx));
  }
  {
    const { shapes } = await one(F.pic({ rid: 'rImg', box: { x: 0, y: 0, w: 100, h: 100 }, fx: '<a:duotone><a:srgbClr val="112233"/><a:srgbClr val="FFEEDD"/></a:duotone><a:lum bright="20000" contrast="-10000"/>' }));
    check('pic: duotone colors and brightness / contrast', J(shapes[0].fx.duotone) === '["#112233","#ffeedd"]' && near(shapes[0].fx.bright, 0.2, 0.001) && near(shapes[0].fx.contrast, -0.1, 0.001), J(shapes[0].fx));
  }
  // ---- picture cropped to a shape, hyperlink
  {
    const { shapes } = await one(F.pic({ rid: 'rImg', box: { x: 0, y: 0, w: 100, h: 100 }, geom: 'ellipse', link: 'rLink' }), { rels: [['rLink', 'hyperlink', 'https://example.com/a%b?x=1', true]] });
    check('pic: an ellipse geometry is kept', shapes[0].geom === 'ellipse', J(shapes[0]));
    check('pic: an external hyperlink is kept (and a malformed %-escape does not break the deck)', shapes[0].link === 'https://example.com/a%b?x=1', shapes[0].link);
    const bad = await one(F.pic({ rid: 'rImg', box: { x: 0, y: 0, w: 10, h: 10 }, link: 'rLink' }), { rels: [['rLink', 'hyperlink', 'javascript:alert(1)', true]] });
    check('pic: a javascript: link is dropped', bad.shapes[0].link === null, bad.shapes[0].link);
  }
  // ---- shape fills: stretch, tile
  {
    const { shapes } = await one(`${F.picShape({ rid: 'rImg', box: { x: 10, y: 10, w: 100, h: 100 }, geom: 'ellipse', src: 'l="50000"' })}${F.picShape({ id: 21, rid: 'rImg', box: { x: 0, y: 0, w: 300, h: 200 }, tile: 'tx="127000" ty="63500" sx="50000" sy="200000" flip="none" algn="tl"' })}`);
    check('shape fill: a picture, cropped by srcRect', shapes[0].fill.type === 'image' && shapes[0].fill.image === 'ppt/media/image1.png' && J(shapes[0].fill.crop) === '[0.5,0,0,0]' && shapes[0].geom === 'ellipse', J(shapes[0].fill));
    check('shape fill: a:tile offset and scale', shapes[1].fill.tile && shapes[1].fill.tile.tx === 127000 && shapes[1].fill.tile.sx === 0.5 && shapes[1].fill.tile.sy === 2, J(shapes[1].fill));
  }
  // ---- groups
  {
    const child = F.pic({ rid: 'rImg', box: { x: 10, y: 10, w: 50, h: 50 } });
    const g1 = await one(F.group({ box: { x: 100, y: 100, w: 200, h: 200 }, chOff: { x: 0, y: 0 }, chExt: { w: 100, h: 100 }, children: child }));
    check('group: child offsets and extents scale (chExt 100 -> 200 doubles)', near(inPt(g1.shapes[0].x), 120) && near(inPt(g1.shapes[0].y), 120) && near(inPt(g1.shapes[0].w), 100), J(box(g1.shapes[0])));
    const g2 = await one(F.group({ box: { x: 300, y: 200, w: 100, h: 100 }, chOff: { x: 1000, y: 1000 }, chExt: { w: 100, h: 100 }, children: F.pic({ rid: 'rImg', box: { x: 1010, y: 1020, w: 20, h: 20 } }) }));
    check('group: a child offset (chOff) is subtracted', near(inPt(g2.shapes[0].x), 310) && near(inPt(g2.shapes[0].y), 220), J(box(g2.shapes[0])));
    const g3 = await one(F.group({ box: { x: 100, y: 100, w: 200, h: 100, rot: 90 }, chOff: { x: 0, y: 0 }, chExt: { w: 200, h: 100 }, children: F.pic({ rid: 'rImg', box: { x: 0, y: 0, w: 200, h: 100 } }) }));
    check('group: a rotated group rotates a child that fills it (same box, rot 90)', near(inPt(g3.shapes[0].x), 100) && near(inPt(g3.shapes[0].w), 200) && near(g3.shapes[0].rot, 90, 0.01), J(box(g3.shapes[0])));
    const g4 = await one(F.group({ box: { x: 100, y: 100, w: 200, h: 100, rot: 90 }, chOff: { x: 0, y: 0 }, chExt: { w: 200, h: 100 }, children: F.pic({ rid: 'rImg', box: { x: 0, y: 0, w: 50, h: 100 } }) }));
    // the child's center (25, 50) is 75 left of the group's center (100, 50): a quarter turn clockwise puts it 75 above the center (200, 150)
    check('group: a rotated group moves a child about its own center', near(inPt(g4.shapes[0].x) + inPt(g4.shapes[0].w) / 2, 200) && near(inPt(g4.shapes[0].y) + inPt(g4.shapes[0].h) / 2, 75), J(box(g4.shapes[0])));
    const g5 = await one(F.group({ box: { x: 100, y: 100, w: 200, h: 100, flipH: true }, chOff: { x: 0, y: 0 }, chExt: { w: 200, h: 100 }, children: F.pic({ rid: 'rImg', box: { x: 0, y: 0, w: 50, h: 100 } }) }));
    check('group: a flipped group mirrors a child to the other side and flips it', near(inPt(g5.shapes[0].x), 250) && g5.shapes[0].flipH === true, J(box(g5.shapes[0])));
    const g6 = await one(F.group({ box: { x: 0, y: 0, w: 400, h: 400 }, chOff: { x: 0, y: 0 }, chExt: { w: 400, h: 400 }, children: F.group({ id: 41, box: { x: 100, y: 100, w: 100, h: 100 }, chOff: { x: 0, y: 0 }, chExt: { w: 50, h: 50 }, children: F.pic({ rid: 'rImg', box: { x: 10, y: 10, w: 20, h: 20 } }) }) }));
    check('group: groups inside groups multiply', near(inPt(g6.shapes[0].x), 120) && near(inPt(g6.shapes[0].w), 40), J(box(g6.shapes[0])));
  }
  // ---- backgrounds and placeholders
  {
    const media = { 'image1.png': Q, 'bgs.png': F.solid(F.BLUE), 'bgl.png': F.solid(F.GREEN), 'bgm.png': F.solid(F.YELLOW) };
    const slide = await one(F.rect({ box: { x: 0, y: 0, w: 10, h: 10 } }), { media, bg: F.bgPicture('rBg'), rels: [F.imageRel('rBg', 'bgs.png')] });
    check('background: a slide picture (stretch)', slide.deck.slides[0].background && slide.deck.slides[0].background.type === 'image' && slide.deck.slides[0].background.image === 'ppt/media/bgs.png' && slide.deck.media['ppt/media/bgs.png'].startsWith('data:image/png'), J(slide.deck.slides[0].background));
    const layout = await one(F.rect({ box: { x: 0, y: 0, w: 10, h: 10 } }), { media, layout: { bg: F.bgPicture('rL', 'sx="100000" sy="100000"'), rels: [F.imageRel('rL', 'bgl.png')] } });
    check('background: a layout picture (tile), when the slide has none', layout.deck.slides[0].background.image === 'ppt/media/bgl.png' && layout.deck.slides[0].background.tile, J(layout.deck.slides[0].background));
    const master = await one(F.rect({ box: { x: 0, y: 0, w: 10, h: 10 } }), { media, master: { bg: F.bgPicture('rM'), rels: [F.imageRel('rM', 'bgm.png')] } });
    check('background: a master picture, when the layout has none', master.deck.slides[0].background.image === 'ppt/media/bgm.png', J(master.deck.slides[0].background));
    const decor = await one(F.rect({ box: { x: 0, y: 0, w: 10, h: 10 } }), { media, layout: { shapes: F.pic({ rid: 'rL', box: { x: 5, y: 6, w: 7, h: 8 } }), rels: [F.imageRel('rL', 'bgl.png')] }, master: { shapes: F.pic({ rid: 'rM', box: { x: 1, y: 2, w: 3, h: 4 } }), rels: [F.imageRel('rM', 'bgm.png')] } });
    const all = decor.deck.slides[0].shapes;
    check('layout and master pictures come first (behind the slide), each with its own relationships', all.length === 3 && all[0].image === 'ppt/media/bgm.png' && all[1].image === 'ppt/media/bgl.png' && !all[2].image, J(all.map((s) => s.image)));
    const layoutPh = '<p:sp><p:nvSpPr><p:cNvPr id="5" name="Pic ph"/><p:cNvSpPr/><p:nvPr><p:ph type="pic" idx="13"/></p:nvPr></p:nvSpPr><p:spPr>' + F.xfrm({ x: 400, y: 100, w: 300, h: 200 }) + '</p:spPr></p:sp>';
    const ph = await one(F.picturePlaceholder({ rid: 'rImg' }), { layout: { shapes: layoutPh } });
    check('a picture placeholder takes its place from the layout', ph.shapes.length === 1 && near(inPt(ph.shapes[0].x), 400) && near(inPt(ph.shapes[0].w), 300) && ph.shapes[0].image === 'ppt/media/image1.png', J(ph.shapes.map(box)));
  }
  // ---- SVG with a PNG fallback, EMF, duplicates, tables
  {
    const svg = F.svgOf('#0000ff');
    const s = await one(F.pic({ rid: 'rImg', svg: 'rSvg', box: { x: 0, y: 0, w: 50, h: 50 } }), { media: { 'image1.png': F.solid(F.RED), 'image2.svg': svg }, rels: [F.imageRel('rSvg', 'image2.svg')] });
    check('svg: the pic keeps both the PNG fallback and the SVG', s.shapes[0].image === 'ppt/media/image1.png' && s.shapes[0].svg === 'ppt/media/image2.svg', J([s.shapes[0].image, s.shapes[0].svg]));
    check('svg: both reach the page as data: URLs', s.deck.media['ppt/media/image2.svg'].startsWith('data:image/svg+xml;base64,') && s.deck.media['ppt/media/image1.png'].startsWith('data:image/png'), '');
    const emf = Buffer.concat([Buffer.from([1, 0, 0, 0, 0x6c, 0, 0, 0]), Buffer.alloc(200)]);
    const e = await one(F.pic({ rid: 'rImg', box: { x: 0, y: 0, w: 50, h: 50 } }), { media: { 'image1.emf': emf }, rels: [F.imageRel('rImg', 'image1.emf')] });
    check('emf: no data URL, and the format is named for the placeholder', e.deck.media['ppt/media/image1.emf'] === null && e.deck.mediaInfo['ppt/media/image1.emf'].missing === 'emf' && e.deck.warnings.some((w) => /EMF/.test(w)), J([e.deck.media, e.deck.mediaInfo]));
    const ve = await one(F.pic({ rid: 'rImg', box: { x: 0, y: 0, w: 50, h: 50 } }), { media: { 'image1.emf': F.emf() }, rels: [F.imageRel('rImg', 'image1.emf')] });
    check('a real EMF is sent to the page as image/x-emf (drawn there), marked as a vector, with no warning', ve.deck.media['ppt/media/image1.emf'].startsWith('data:image/x-emf;base64,') && (ve.deck.media['ppt/media/image1.emf']) && ve.deck.mediaInfo['ppt/media/image1.emf'].vector === 'emf' && ve.deck.warnings.length === 0, J([ve.deck.mediaInfo, ve.deck.warnings]));
    const vw = await one(F.pic({ rid: 'rImg', box: { x: 0, y: 0, w: 50, h: 50 } }), { media: { 'image1.wmf': F.wmf() }, rels: [F.imageRel('rImg', 'image1.wmf')] });
    check('a placeable WMF is sent as image/x-wmf', vw.deck.media['ppt/media/image1.wmf'].startsWith('data:image/x-wmf;base64,') && vw.deck.mediaInfo['ppt/media/image1.wmf'].vector === 'wmf', J(vw.deck.mediaInfo));
    check('sniffVector: EMF, placeable and plain WMF by their headers; PNG, zeros and short input are none', P.sniffVector(F.emf()) === 'emf' && P.sniffVector(F.wmf()) === 'wmf' && P.sniffVector(F.wmf().subarray(22)) === 'wmf' && P.sniffVector(Q) === null && P.sniffVector(Buffer.alloc(100)) === null && P.sniffVector(Buffer.alloc(3)) === null && P.sniffVector(null) === null, '');
    const bigEmf = Buffer.concat([F.emf(), Buffer.alloc(9 * 1024 * 1024)]);
    const vb = await one(F.pic({ rid: 'rImg', box: { x: 0, y: 0, w: 50, h: 50 } }), { media: { 'image1.emf': bigEmf }, rels: [F.imageRel('rImg', 'image1.emf')] });
    check('an EMF over 8 MB is left out (placeholder), with a warning', vb.deck.media['ppt/media/image1.emf'] === null && vb.deck.mediaInfo['ppt/media/image1.emf'].missing === 'emf' && vb.deck.warnings.length === 1, J([vb.deck.mediaInfo, vb.deck.warnings]));
    const d = await one(`${F.pic({ rid: 'rImg', box: { x: 0, y: 0, w: 50, h: 50 } })}${F.pic({ id: 11, rid: 'rCopy', box: { x: 60, y: 0, w: 50, h: 50 } })}`, { media: { 'image1.png': Q, 'image9.png': Q }, rels: [F.imageRel('rCopy', 'image9.png')] });
    check('duplicates: the same bytes under two names are sent once (the second is an alias)', Object.keys(d.deck.media).length === 1 && d.deck.mediaAlias['ppt/media/image9.png'] === 'ppt/media/image1.png', J([Object.keys(d.deck.media), d.deck.mediaAlias]));
    const t = await one(F.table({ box: { x: 0, y: 0, w: 200, h: 80 }, cellFill: '<a:blipFill><a:blip r:embed="rImg"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>' }));
    check('table: a picture in a cell fill is kept', t.shapes[0].rows[0].cells[0].fill && t.shapes[0].rows[0].cells[0].fill.type === 'image' && t.shapes[0].rows[0].cells[0].fill.image === 'ppt/media/image1.png', J(t.shapes[0].rows[0].cells[0].fill));
    const big = await one(F.pic({ rid: 'rImg', box: { x: 0, y: 0, w: 50, h: 50 } }), { media: { 'image1.png': F.png(70, 30, () => [1, 2, 3]) } });
    check('size: pictures come with their pixel size (PNG header)', big.deck.mediaInfo['ppt/media/image1.png'].w === 70 && big.deck.mediaInfo['ppt/media/image1.png'].h === 30, J(big.deck.mediaInfo));
    const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/wAARCAAUAB4DASIAAhEBAxEB/9k=', 'base64'); // SOI, JFIF, SOF0 (30 x 20), EOI
    check('size: a JPEG header gives its size', J(P.imageSize(jpeg, 'image/jpeg')) === '{"h":20,"w":30}', J(P.imageSize(jpeg, 'image/jpeg')));
    const w43 = await one(F.rect({ box: { x: 0, y: 0, w: 10, h: 10 } }), { width: 9144000, height: 6858000 });
    check('4:3 slide size is read', w43.deck.width === 9144000 && w43.deck.height === 6858000, '');
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
