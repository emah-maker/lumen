// PowerPoint decks (features/pptx.js, features/slides-viewer.js), plain Node: no Electron. A tiny .pptx is built here
// (a zip of minimal XML parts) and parsed: slide count and order, placeholder positions inherited from the layout,
// text, bullets and escaping, pictures as data: URLs, notes, tables, the AI's slide text, and the limits (the
// inflated-size cap that stops zip bombs, the slide cap, DTDs refused, linked pictures never fetched).
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const P = require('../src/features/pptx');
const V = require('../src/features/slides-viewer');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const J = (v) => JSON.stringify(v);

// ---- a zip writer (deflate or store), enough for the fixtures
function zip(files, { store = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const comp = store ? data : zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels = (list) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target, ext]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"${ext ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const sp = (body, { ph = '', xfrm = '', fill = '' } = {}) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="S"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${xfrm}${fill}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>`;
const xfrm = (x, y, w, h) => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`;
const para = (text, rPr = '') => `<a:p><a:r><a:rPr lang="en-US"${rPr}/><a:t>${text}</a:t></a:r></a:p>`;

function deck({ extraMedia = {}, slides } = {}) {
  const files = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'ppt/presentation.xml': `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    // file order is slide1, slide2, but the deck shows slide2 first (sldIdLst order)
    'ppt/_rels/presentation.xml.rels': rels([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'slide', 'slides/slide1.xml'], ['rId3', 'slide', 'slides/slide2.xml']]),
    'ppt/theme/theme1.xml': `<a:theme ${NS} name="T"><a:themeElements><a:clrScheme name="C"><a:dk1><a:sysClr val="windowText" lastClr="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="222222"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme><a:fontScheme name="F"><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`,
    'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg2"/></a:solidFill></p:bgPr></p:bg><p:spTree>
      ${sp(para('Master title prompt'), { ph: '<p:ph type="title"/>', xfrm: xfrm(100, 100, 8000000, 1000000) })}
      ${sp(para('Master body prompt'), { ph: '<p:ph type="body" idx="1"/>', xfrm: xfrm(457200, 1600200, 8229600, 4525963) })}
      <p:sp><p:nvSpPr><p:cNvPr id="9" name="Band"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(0, 6400000, 9144000, 458000)}<a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr></p:sp>
      </p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1"/>
      <p:txStyles><p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>
      <p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buChar char="•"/><a:defRPr sz="3200"/></a:lvl1pPr><a:lvl2pPr marL="742950"><a:buChar char="–"/><a:defRPr sz="2800"/></a:lvl2pPr></p:bodyStyle><p:otherStyle/></p:txStyles></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([['rId1', 'theme', '../theme/theme1.xml'], ['rId2', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
    'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout ${NS}><p:cSld><p:spTree>
      ${sp(para('Layout title prompt'), { ph: '<p:ph type="title"/>', xfrm: xfrm(685800, 2130425, 7772400, 1470025) })}
      ${sp(para('Layout body prompt'), { ph: '<p:ph idx="1"/>' })}
      </p:spTree></p:cSld></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    // slide2.xml (shown first): a title from the layout's position, a bulleted body, a picture, a linked picture, notes
    'ppt/slides/slide2.xml': `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree>
      ${sp(para('Q3 &amp; &lt;Results&gt; &#x2014; <![CDATA[x]]>'), { ph: '<p:ph type="title"/>' })}
      ${sp(`${para('Revenue up', ' b="1"')}<a:p><a:pPr lvl="1"/><a:r><a:rPr lang="en-US"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr><a:t>Costs flat</a:t></a:r></a:p>`, { ph: '<p:ph idx="1"/>' })}
      <p:pic><p:nvPicPr><p:cNvPr id="4" name="Logo" descr="Company logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImg"/><a:srcRect l="10000"/></p:blipFill><p:spPr>${xfrm(7000000, 100000, 1000000, 1000000)}</p:spPr></p:pic>
      <p:pic><p:nvPicPr><p:cNvPr id="5" name="Remote"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:link="rIdRemote"/></p:blipFill><p:spPr>${xfrm(0, 0, 10, 10)}</p:spPr></p:pic>
      </p:spTree></p:cSld></p:sld>`,
    'ppt/slides/_rels/slide2.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rIdImg', 'image', '../media/image1.png'], ['rIdRemote', 'image', 'https://tracker.example/pixel.png', true], ['rIdN', 'notesSlide', '../notesSlides/notesSlide1.xml']]),
    'ppt/notesSlides/notesSlide1.xml': `<p:notes ${NS}><p:cSld><p:spTree>${sp(para('Say the number slowly'), { ph: '<p:ph type="body" idx="1"/>' })}</p:spTree></p:cSld></p:notes>`,
    'ppt/media/image1.png': PNG,
    // slide1.xml (shown second): a free text box, a table and a chart
    'ppt/slides/slide1.xml': `<p:sld ${NS} show="0"><p:cSld><p:spTree>
      ${sp(para('Second', ' sz="2000" i="1"'), { xfrm: xfrm(1000, 2000, 3000000, 400000), fill: '<a:solidFill><a:srgbClr val="00FF00"><a:alpha val="50000"/></a:srgbClr></a:solidFill>' })}
      <p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="7" name="Table 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="500000" y="3000000"/><a:ext cx="4000000" cy="800000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid><a:gridCol w="2000000"/><a:gridCol w="2000000"/></a:tblGrid>
        <a:tr h="400000"><a:tc><a:txBody><a:bodyPr/>${para('Name')}</a:txBody><a:tcPr/></a:tc><a:tc><a:txBody><a:bodyPr/>${para('Score')}</a:txBody><a:tcPr><a:solidFill><a:srgbClr val="DDDDDD"/></a:solidFill></a:tcPr></a:tc></a:tr>
        <a:tr h="400000"><a:tc><a:txBody><a:bodyPr/>${para('Ada')}</a:txBody><a:tcPr/></a:tc><a:tc><a:txBody><a:bodyPr/>${para('42')}</a:txBody><a:tcPr/></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>
      <p:sp><p:nvSpPr><p:cNvPr id="10" name="Oval"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(10, 10, 500000, 500000)}<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom></p:spPr><p:style><a:lnRef idx="1"><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:lnRef><a:fillRef idx="3"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style><p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/>${para('Styled')}</p:txBody></p:sp>
      <p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="8" name="Sales"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="5000000" y="3000000"/><a:ext cx="3000000" cy="2000000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></p:graphicFrame>
      </p:spTree></p:cSld></p:sld>`,
    'ppt/slides/_rels/slide1.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
    ...extraMedia,
  };
  if (slides) Object.assign(files, slides);
  return zip(files);
}

async function main() {
  const buf = deck();
  const d = await P.parsePptx(buf);
  check('deck: slide size from presentation.xml (4:3)', d.width === 9144000 && d.height === 6858000, `${d.width}x${d.height}`);
  check('deck: two slides, in sldIdLst order (not file order)', d.slides.length === 2 && d.slideCount === 2 && /Q3/.test(d.slides[0].text) && /Second/.test(d.slides[1].text), J(d.slides.map((s) => s.text)));
  const [s1, s2] = d.slides;
  const title = s1.shapes.find((s) => s.text?.category === 'title');
  check('placeholder: the title takes its position from the layout', title && title.x === 685800 && title.y === 2130425 && title.w === 7772400, J(title && { x: title.x, y: title.y }));
  const body = s1.shapes.find((s) => s.text?.category === 'body');
  check('placeholder: a layout placeholder with no position falls back to the master\'s', body && body.x === 457200 && body.y === 1600200, J(body && { x: body.x, y: body.y }));
  check('text: entities, character references and CDATA decode to plain text', title.text.paragraphs[0].runs[0].text === 'Q3 & <Results> — x', J(title.text.paragraphs[0].runs[0].text));
  const tr = title.text.paragraphs[0];
  check('text: the master title style gives size, alignment, color and the theme\'s heading font', tr.align === 'center' && tr.runs[0].size === 44 && tr.runs[0].color === '#111111' && tr.runs[0].font === 'Georgia', J(tr));
  const [b1, b2] = body.text.paragraphs;
  check('text: body bullets and sizes come from the master body style, by level', b1.bullet?.text === '•' && b1.runs[0].size === 32 && b1.runs[0].bold === true && b2.bullet?.text === '–' && b2.runs[0].size === 28 && b2.level === 1, J({ b1, b2 }));
  check('text: a run\'s own color wins', b2.runs[0].color === '#ff0000', b2.runs[0].color);
  check('master: its own (non-placeholder) shapes are drawn behind, its prompts are not', s1.shapes.some((s) => s.type === 'shape' && !s.own && s.fill?.color === '#4472c4') && !s1.shapes.some((s) => s.text && /prompt/.test(s.text.paragraphs[0].runs[0]?.text)), J(s1.shapes.map((s) => s.type)));
  check('background: inherited from the master, through the color map (bg2 -> lt2)', s1.background?.type === 'solid' && s1.background.color === '#eeeeee', J(s1.background));
  const pic = s1.shapes.find((s) => s.type === 'pic' && s.image);
  check('picture: embedded image resolved through the slide\'s rels, cropped, with its alt text', pic && pic.image === 'ppt/media/image1.png' && pic.crop?.[0] === 0.1 && pic.alt === 'Company logo', J(pic));
  check('picture: handed to the page as a data: URL of the sniffed type', /^data:image\/png;base64,/.test(d.media['ppt/media/image1.png'] || ''), String(d.media['ppt/media/image1.png']).slice(0, 40));
  check('picture: a linked (external) picture is never fetched or listed', !Object.keys(d.media).some((k) => /tracker|http/.test(k)) && !s1.shapes.some((s) => s.type === 'pic' && s.image && /http/.test(s.image)), J(Object.keys(d.media)));
  check('notes: the notes slide\'s body text', s1.notes === 'Say the number slowly', J(s1.notes));
  check('slide 2: hidden flag, an alpha fill, an italic 20pt run', s2.hidden === true && s2.shapes.some((s) => s.fill?.color === '#00ff00' && s.fill.alpha === 0.5 && s.text?.paragraphs[0].runs[0].italic && s.text.paragraphs[0].runs[0].size === 20), J(s2.shapes.filter((s) => s.own)));
  const oval = s2.shapes.find((s) => s.geom === 'ellipse');
  check('style: the p:style of a shape gives its fill, outline and text color (over the deck default)', oval && oval.fill?.color === '#4472c4' && /^#[0-9a-f]{6}$/.test(oval.line?.color || '') && oval.line.color !== '#4472c4' && oval.text.paragraphs[0].runs[0].color === '#ffffff' && oval.text.anchor === 'middle', J(oval));
  const table = s2.shapes.find((s) => s.type === 'table');
  check('table: grid columns, rows and cell text, a cell fill', table && table.cols.length === 2 && table.rows.length === 2 && table.rows[1].cells[0].paragraphs[0].runs[0].text === 'Ada' && table.rows[0].cells[1].fill?.color === '#dddddd', J(table && table.rows));
  check('chart: a labelled box stands in for it', s2.shapes.some((s) => s.type === 'placeholder' && /^Chart/.test(s.label)), J(s2.shapes.map((s) => s.label || s.type)));
  check('ai text: the title first, then the body; tables as rows', /^Q3 & <Results>/.test(s1.text) && /• Revenue up/.test(s1.text) && /Name \| Score\nAda \| 42/.test(s2.text), J([s1.text, s2.text]));
  const texts = await P.extractSlideTexts(buf);
  check('ai text: one page per slide, the notes after the slide text', texts.length === 2 && /Notes: Say the number slowly$/.test(texts[0]) && !/Notes/.test(texts[1]), J(texts));
  const noMedia = await P.parsePptx(buf, { media: false });
  check('ai text: media are not read when only the text is wanted', Object.keys(noMedia.media).length === 0);

  // ---- JSON-safe: the viewer gets it through executeJavaScript
  check('model: plain JSON (no functions, no Buffers)', J(JSON.parse(J(d))) === J(d));

  // ---- limits
  const bomb = deck({ extraMedia: { 'ppt/media/image1.png': Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]) } });
  check('zip bomb: the fixture is small on disk', bomb.length < 200 * 1024, String(bomb.length));
  const capped = await P.parsePptx(bomb, { maxBytes: 2 * 1024 * 1024 }).catch((e) => e);
  check('zip bomb: a picture that inflates past the size cap is left out (inflating stops there), the slides still show', Array.isArray(capped.slides) && capped.media['ppt/media/image1.png'] === null && capped.warnings.some((w) => /too large/.test(w)), String(capped.warnings || capped));
  let err = null;
  const xmlBomb = deck({ slides: { 'ppt/slides/slide1.xml': `<p:sld ${NS}><!--${' '.repeat(8 * 1024 * 1024)}--></p:sld>` } });
  try { await P.parsePptx(xmlBomb, { maxBytes: 2 * 1024 * 1024 }); } catch (e) { err = e; }
  check('zip bomb: a slide part that inflates past the cap stops the deck with a plain error', xmlBomb.length < 200 * 1024 && err instanceof P.PptxError && /too large/.test(err.message), String(err));
  const textOnly = await P.parsePptx(bomb, { media: false, maxBytes: 2 * 1024 * 1024 }).catch((e) => e);
  check('zip bomb: the text still reads when the big picture is not needed', Array.isArray(textOnly.slides) && textOnly.slides.length === 2, String(textOnly));
  check('cap: total uncompressed size is capped at 200 MB by default', P.MAX_UNCOMPRESSED === 200 * 1024 * 1024);
  const few = await P.parsePptx(buf, { maxSlides: 1 });
  check('cap: slides past the cap are left out, with a note', few.slides.length === 1 && few.truncated && few.slideCount === 2 && few.warnings.some((w) => /first 1 of 2/.test(w)), J(few.warnings));
  err = null;
  try { await P.parsePptx(Buffer.from('not a zip at all, just some text that is long enough')); } catch (e) { err = e; }
  check('damaged: not a zip -> a plain error', err instanceof P.PptxError && /not a PowerPoint/.test(err.message), String(err));
  err = null;
  try { await P.parsePptx(zip({ 'word/document.xml': '<w:document/>' })); } catch (e) { err = e; }
  check('damaged: a zip that is not a deck -> a plain error', err instanceof P.PptxError, String(err));
  err = null;
  try { P.parseXml('<!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>'); } catch (e) { err = e; }
  check('xml: a DTD is refused (no entity expansion)', err instanceof P.PptxError, String(err));
  const stored = await P.parsePptx(zip({})).catch((e) => e);
  check('damaged: an empty zip -> a plain error', stored instanceof P.PptxError, String(stored));
  check('sniff: EMF and unknown bytes are not shown; PNG and SVG are', P.sniffImage(Buffer.from([1, 0, 0, 0, 0x6c, 0, 0, 0])) === null && P.sniffImage(PNG) === 'image/png' && P.sniffImage(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')) === 'image/svg+xml');

  // ---- the viewer's addresses (features/slides-viewer.js)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-pptx-'));
  const file = path.join(tmp, 'Q3 deck.pptx');
  fs.writeFileSync(file, buf);
  const deckUrl = pathToFileURL(file).href;
  const viewer = V.viewerUrl(deckUrl);
  check('viewer: a local .pptx gets the viewer page, which knows the deck', V.isViewerUrl(viewer) && V.deckUrlOf(viewer) === deckUrl, viewer);
  check('viewer: the address bar shows the deck\'s own address', V.displayUrl(viewer) === deckUrl);
  check('viewer: only local .pptx files (not web addresses or other files)', V.deckUrlOf(`${V.VIEWER_URL}?u=${encodeURIComponent('https://x.test/a.pptx')}`) === null && V.deckUrlOf(`${V.VIEWER_URL}?u=${encodeURIComponent(pathToFileURL(path.join(tmp, 'a.txt')).href)}`) === null);
  check('viewer: the open-a-download decision: a .pptx file: download is opened in place', V.shouldOpenInPlace({ url: deckUrl, filename: 'Q3 deck.pptx' }) && !V.shouldOpenInPlace({ url: 'https://x.test/a.pptx', filename: 'a.pptx' }) && !V.shouldOpenInPlace({ url: pathToFileURL(path.join(tmp, 'a.zip')).href, filename: 'a.zip' }));
  check('viewer: a finished web download of a .pptx opens, unless it was Save As', V.shouldOpenFinished({ path: file, saveAs: false }) && !V.shouldOpenFinished({ path: file, saveAs: true }) && !V.shouldOpenFinished({ path: path.join(tmp, 'a.pdf'), saveAs: false }));
  const loaded = await V.loadDeck(deckUrl);
  check('viewer: loadDeck reads the file and names it (no folder)', loaded.name === 'Q3 deck.pptx' && loaded.slides.length === 2 && !J(loaded).includes(tmp.replace(/\\/g, '\\\\')), loaded.name);
  const missing = await V.loadDeck(pathToFileURL(path.join(tmp, 'gone.pptx')).href);
  check('viewer: a missing file -> an error message without its path', missing.error && !missing.error.includes(tmp), J(missing));

  // ---- read_pdf reads a deck open in the viewer (ai/agent.js), after the same once-per-chat card as a PDF
  const { Agent } = require('../src/ai/agent');
  const wc = { id: 7, getURL: () => viewer, isDestroyed: () => false, session: {} };
  const tab = { id: 1, webContents: wc };
  const browser = {
    activeTab: () => tab, tabById: (id) => (id === 1 ? tab : null), listTabs: () => [], effectiveModel: (m) => m, aiOff: () => false, noTabReason: () => 'No tab open.', maxSteps: () => 0,
    autoApprove: () => false, bypassPermissions: () => false, handsOff: () => false, isAiTab: () => false, tabOff: () => false, typingText: () => '',
    externalTools: { isExternal: () => false, lookupTool: () => null, isAlwaysAllowed: () => false, setAlwaysAllowed: () => {} },
  };
  const agent = new Agent(browser, () => null, () => ({ model: 'claude-opus-5' }));
  agent.closeSignedInTabs = () => {};
  agent.newActionLog = () => ({});
  agent.undoSummary = () => null;
  const target = await agent.pdfTarget({});
  check('ai: the viewer tab is read as its deck file', target.kind === 'pptx' && target.url === deckUrl, J({ kind: target.kind, url: target.url }));
  const signal = new AbortController().signal;
  const cards = [];
  const emit = (e) => { if (e.type === 'approval') { cards.push(e); setImmediate(() => agent.resolveApproval(e.approvalId, true)); } };
  const chat = () => { const m = []; m.settings = { model: 'claude-opus-5' }; return m; };
  const gate = { emit, signal, hosts: new Set(), who: 'Claude', external: false, noAsk: false, run: { tainted: false } };
  const read = (input) => agent.inTask(1, signal, async () => { await agent.ensureAllowed('read_pdf', emit, signal, { ...gate, input }); return agent.readPdf(input); }, chat());
  const out = await read({});
  check('ai: one card naming the deck file (no folder)', cards.length === 1 && cards[0].action === 'pdf' && /Q3 deck\.pptx/.test(J(cards[0])) && !J(cards[0]).includes(path.basename(tmp)), J(cards));
  check('ai: slide-by-slide text with notes, wrapped as untrusted content', /^<untrusted_page_content>\nPresentation: Q3 deck\.pptx \(2 slides, one page each; showing pages 1-2\)/.test(out) && /--- Page 1 of 2 ---\nQ3 & <Results>/.test(out) && /Notes: Say the number slowly/.test(out) && /--- Page 2 of 2 ---[\s\S]*Ada \| 42/.test(out), out);
  const hit = await read({ query: 'ada' });
  check('ai: query finds the slide', /found on 1 page \(2\)/.test(hit), hit);

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
