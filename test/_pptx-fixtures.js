// Builds small .pptx decks (a zip of minimal XML parts) and PNG pictures in plain Node, for the picture tests (pptx-images*.js). No network, no files:
// everything is made in memory. A deck is { width, height, slides: [{ shapes, rels, bg }], media: { 'image1.png': Buffer }, layout, master }.
const zlib = require('zlib');

const EMU = 12700; // one point
const pt = (n) => Math.round(n * EMU);

// ---- zip (stored: the reader handles stored and deflated parts)
function zip(files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data); centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  const n = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---- PNG: fn(x, y) -> [r, g, b, a]
function png(w, h, fn) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1);
    for (let x = 0; x < w; x++) { const [r, g, b, a = 255] = fn(x, y); const o = row + 1 + x * 4; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a; }
  }
  const chunk = (type, data) => { const t = Buffer.from(type, 'latin1'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const RED = [255, 0, 0]; const GREEN = [0, 200, 0]; const BLUE = [0, 0, 255]; const YELLOW = [255, 255, 0];
// Four colored quadrants: top left red, top right green, bottom left blue, bottom right yellow.
const quadrants = (w = 100, h = 100) => png(w, h, (x, y) => (y < h / 2 ? (x < w / 2 ? RED : GREEN) : (x < w / 2 ? BLUE : YELLOW)));
const solid = (color, w = 40, h = 40, a = 255) => png(w, h, () => [...color, a]);
const svgOf = (color) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" fill="${color}"/></svg>`);

// ---- XML
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main"';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels = (list) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target, ext]) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"${ext ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
// A box in points: x, y, w, h (+ rot in degrees, flips)
const xfrm = ({ x, y, w, h, rot = 0, flipH = false, flipV = false }, tag = 'a:xfrm') => `<${tag}${rot ? ` rot="${Math.round(rot * 60000)}"` : ''}${flipH ? ' flipH="1"' : ''}${flipV ? ' flipV="1"' : ''}><a:off x="${pt(x)}" y="${pt(y)}"/><a:ext cx="${pt(w)}" cy="${pt(h)}"/></${tag}>`;
const blipOf = (rid, { svg = '', fx = '' } = {}) => `<a:blip r:embed="${rid}">${fx}${svg ? `<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip r:embed="${svg}"/></a:ext></a:extLst>` : ''}</a:blip>`;

// <p:pic>: rid, box, src: 'l=..' srcRect attributes, stretch: fillRect attributes, tile: attributes of a:tile, geom, fx (blip children), svg (rid), link (rid), placeholder (idx)
function pic({ id = 10, name = 'Pic', rid, box, src = '', fillRect = '', tile = '', geom = 'rect', fx = '', svg = '', link = '', ph = '', descr = '' }) {
  const fillTail = tile ? `<a:tile ${tile}/>` : `<a:stretch><a:fillRect${fillRect ? ` ${fillRect}` : ''}/></a:stretch>`;
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${name}"${descr ? ` descr="${descr}"` : ''}>${link ? `<a:hlinkClick r:id="${link}"/>` : ''}</p:cNvPr><p:cNvPicPr/><p:nvPr>${ph}</p:nvPr></p:nvPicPr><p:blipFill>${blipOf(rid, { svg, fx })}${src ? `<a:srcRect ${src}/>` : ''}${fillTail}</p:blipFill><p:spPr>${box ? xfrm(box) : ''}<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}
// <p:sp> filled with a picture
function picShape({ id = 20, rid, box, geom = 'rect', tile = '', fillRect = '', src = '', text = '' }) {
  const tail = tile ? `<a:tile ${tile}/>` : `<a:stretch><a:fillRect${fillRect ? ` ${fillRect}` : ''}/></a:stretch>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(box)}<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom><a:blipFill>${blipOf(rid)}${src ? `<a:srcRect ${src}/>` : ''}${tail}</a:blipFill></p:spPr>${text ? `<p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="2000"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody>` : ''}</p:sp>`;
}
const rect = ({ id = 30, box, color = 'FFFFFF', text = '' }) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Rect"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(box)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></p:spPr>${text ? `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2400"/><a:t>${text}</a:t></a:r></a:p></p:txBody>` : ''}</p:sp>`;
// <p:grpSp> with a child space: group box (points), child offset and extent (points)
const group = ({ id = 40, box, chOff, chExt, children }) => `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr>${xfrm(box, 'a:xfrm').replace('</a:xfrm>', `<a:chOff x="${pt(chOff.x)}" y="${pt(chOff.y)}"/><a:chExt cx="${pt(chExt.w)}" cy="${pt(chExt.h)}"/></a:xfrm>`)}</p:grpSpPr>${children}</p:grpSp>`;
const table = ({ id = 50, box, cellFill }) => `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>${xfrm(box, 'p:xfrm')}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid><a:gridCol w="${pt(box.w / 2)}"/><a:gridCol w="${pt(box.w / 2)}"/></a:tblGrid><a:tr h="${pt(box.h)}"><a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US"/><a:t>Cell</a:t></a:r></a:p></a:txBody><a:tcPr>${cellFill || ''}</a:tcPr></a:tc><a:tc><a:txBody><a:bodyPr/><a:p><a:endParaRPr lang="en-US"/></a:p></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
const bgPicture = (rid, tile = '') => `<p:bg><p:bgPr><a:blipFill>${blipOf(rid)}${tile ? `<a:tile ${tile}/>` : '<a:stretch><a:fillRect/></a:stretch>'}</a:blipFill><a:effectLst/></p:bgPr></p:bg>`;
const picturePlaceholder = ({ id = 60, idx = 13, rid }) => `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture Placeholder"/><p:cNvPicPr/><p:nvPr><p:ph type="pic" idx="${idx}"/></p:nvPr></p:nvPicPr><p:blipFill>${blipOf(rid)}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr/></p:pic>`;

const THEME = `<a:theme ${NS} name="T"><a:themeElements><a:clrScheme name="C"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="222222"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1></a:clrScheme><a:fontScheme name="F"><a:majorFont><a:latin typeface="Calibri"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;

// slides: [{ shapes: '<p:pic>…', rels: [[id, type, target, external?]], bg: '<p:bg>…', hidden }]
// layout: { shapes, bg, rels }, master: { shapes, bg, rels }: the shared parts every slide uses.
function deck({ width = 12192000, height = 6858000, slides, media = {}, layout = {}, master = {} }) {
  const files = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'ppt/presentation.xml': `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdM"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rIdS${i + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${width}" cy="${height}"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([['rIdM', 'slideMaster', 'slideMasters/slideMaster1.xml'], ...slides.map((_, i) => [`rIdS${i + 1}`, 'slide', `slides/slide${i + 1}.xml`])]),
    'ppt/theme/theme1.xml': THEME,
    'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster ${NS}><p:cSld>${master.bg || ''}<p:spTree>${master.shapes || ''}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1"/><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([['rId1', 'theme', '../theme/theme1.xml'], ['rId2', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ...(master.rels || [])]),
    'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout ${NS}><p:cSld>${layout.bg || ''}<p:spTree>${layout.shapes || ''}</p:spTree></p:cSld></p:sldLayout>`,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml'], ...(layout.rels || [])]),
  };
  slides.forEach((s, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = `<?xml version="1.0"?><p:sld ${NS}${s.hidden ? ' show="0"' : ''}><p:cSld>${s.bg || ''}<p:spTree>${s.shapes}</p:spTree></p:cSld></p:sld>`;
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ...(s.rels || [])]);
  });
  for (const [name, data] of Object.entries(media)) files[`ppt/media/${name}`] = data;
  return zip(files);
}
const imageRel = (id, name) => [id, 'image', `../media/${name}`];

module.exports = { zip, png, quadrants, solid, svgOf, deck, pic, picShape, rect, group, table, bgPicture, picturePlaceholder, imageRel, xfrm, pt, rels, NS, RED, GREEN, BLUE, YELLOW };
